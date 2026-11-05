#!/usr/bin/env node
/**
 * turn-plan-readout.js — the LIVE readout of the dynamic-roster turn plan
 * (docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md §5–§6). READ-ONLY; aggregates only —
 * never a message, never a user id.
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh turn-plan-readout.js [days=7]
 *
 * Reads human answer rows carrying metadata.depth.turnPlan (written since phase 2,
 * 2026-10-03) and the turn_plan decision / outcome rows:
 *   - lane mix, would-Quick (the reason line says "quick eligible"), acted, canary-acted;
 *   - first token + completion p50 / p90 per lane and for the Quick lane actually run
 *     (metadata.depth.plan.lane === 'quick') vs the preset the same lanes ran before;
 *   - Dig-deeper taps on acted Quick answers (the miss signal) and seat fallbacks on the
 *     Quick seat;
 *   - turn_plan decision latency / backend, and the outcome labels written so far
 *     (label × signal, and how often the lane held).
 * The flip decision (owner, tier 2) reads: acted taps / acted answers, fallback rate,
 * Quick TTFT vs today's Level 1 — see the plan doc §6.
 */
'use strict';

function pct(xs, q) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))];
}

async function main() {
  const days = Math.max(1, Math.min(60, parseInt(process.argv[2] || '7', 10) || 7));
  let prisma;
  try { prisma = require('/app/dist/config/database').default; } catch (err) {
    console.log(JSON.stringify({ error: `runtime modules unavailable (${err && err.message})` }));
    process.exit(3);
  }
  const rows = await prisma.$queryRawUnsafe(`
    SELECT m.metadata::jsonb AS md
    FROM crossmodel_messages m
    JOIN crossmodel_chats c ON c.id = m."chatId"
    WHERE m.role = 'assistant'
      AND m."createdAt" > now() - ($1::int * interval '1 day')
      AND c."isSupervisor" = false AND c."isProjectSupervisor" = false
      AND (m.metadata::jsonb) -> 'depth' ? 'turnPlan'
      AND NOT ((m.metadata::jsonb) ? 'origin')`, days);
  const out = { days, answers: rows.length, laneMix: {}, wouldQuick: 0, acted: 0, actedCanary: 0, ranQuick: 0, ttftByLane: {}, ranQuickTtft: null, ranQuickDone: null, tappedRanQuick: 0, guardBlocks: {} };
  const ttft = {}; const done = {}; const quickTtft = []; const quickDone = [];
  for (const r of rows) {
    const md = r.md || {};
    const tp = (md.depth && md.depth.turnPlan) || {};
    const lane = String(tp.lane || 'none');
    out.laneMix[lane] = (out.laneMix[lane] || 0) + 1;
    const reason = String(tp.reason || '');
    if (/quick eligible/.test(reason)) out.wouldQuick += 1;
    const blocked = reason.match(/quick no \(([^)]*)\)/);
    if (blocked && lane === 'quick') {
      const key = blocked[1].replace(/[\d.]+/g, '').trim() || 'other';
      out.guardBlocks[key] = (out.guardBlocks[key] || 0) + 1;
    }
    if (tp.act) { out.acted += 1; if (tp.canary) out.actedCanary += 1; }
    const t = md.ux ? Number(md.ux.ttftMs) : NaN; const d = md.ux ? Number(md.ux.completionMs) : NaN;
    (ttft[lane] = ttft[lane] || []).push(t); (done[lane] = done[lane] || []).push(d);
    const ranQuick = md.depth && md.depth.plan && md.depth.plan.lane === 'quick';
    if (ranQuick) {
      out.ranQuick += 1; quickTtft.push(t); quickDone.push(d);
      if (Array.isArray(md.depth.escalations) && md.depth.escalations.length) out.tappedRanQuick += 1;
    }
  }
  for (const l of Object.keys(ttft)) out.ttftByLane[l] = { n: ttft[l].length, ttftP50: pct(ttft[l], 0.5), ttftP90: pct(ttft[l], 0.9), doneP50: pct(done[l], 0.5) };
  out.ranQuickTtft = { p50: pct(quickTtft, 0.5), p90: pct(quickTtft, 0.9) };
  out.ranQuickDone = { p50: pct(quickDone, 0.5), p90: pct(quickDone, 0.9) };
  const dec = await prisma.$queryRawUnsafe(`
    SELECT coalesce(meta->>'backend','-') AS backend, meta->>'mode' AS mode, coalesce(meta->>'ok','-') AS ok, count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95
    FROM loop_metrics
    WHERE kind = 'decision_gate' AND meta->>'phase' = 'decision' AND meta->>'purpose' = 'turn_plan'
      AND coalesce(meta->>'challenger','false') = 'false'
      AND "createdAt" > now() - ($1::int * interval '1 day')
      AND coalesce("sessionId", '') NOT LIKE 'replay:%'
    GROUP BY 1, 2, 3 ORDER BY 4 DESC`, days);
  out.decisions = dec.map((r) => ({ backend: r.backend, mode: r.mode, ok: r.ok, n: r.n, p50: r.p50 === null ? null : Math.round(Number(r.p50)), p95: r.p95 === null ? null : Math.round(Number(r.p95)) }));
  const lab = await prisma.$queryRawUnsafe(`
    SELECT coalesce(meta->>'label','-') AS label, coalesce(meta->>'signal','-') AS signal, coalesce(meta->>'acted','false') AS acted,
           count(*)::int AS n, count(*) FILTER (WHERE meta->>'actual' = meta->>'predictedLane')::int AS held
    FROM loop_metrics
    WHERE kind = 'decision_gate' AND meta->>'phase' = 'outcome' AND meta->>'purpose' = 'turn_plan'
      AND "createdAt" > now() - ($1::int * interval '1 day')
    GROUP BY 1, 2, 3 ORDER BY 4 DESC`, days);
  out.labels = lab;
  const fb = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE meta->>'recovered' = 'true')::int AS recovered
    FROM loop_metrics WHERE kind = 'seat_fallback' AND meta->>'lane' = 'quick' AND "createdAt" > now() - ($1::int * interval '1 day')`, days);
  out.quickSeatFallbacks = fb[0] || null;
  console.log(JSON.stringify(out));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
}

if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String(err && err.message || err).slice(0, 300) })); process.exit(1); });
}

module.exports = { pct };

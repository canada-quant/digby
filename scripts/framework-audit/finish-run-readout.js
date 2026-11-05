#!/usr/bin/env node
/**
 * finish-run-readout.js — the LIVE readout of the typed finish_run SHADOW stage
 * (build 2026-10-08 F; backend/src/modules/crossmodel/coding/finish-run.ts).
 * READ-ONLY; aggregates + a blind rejection sample — never message text, never a user id.
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh finish-run-readout.js [days=14] [sample=50]
 *
 * Reads loop_metrics `finish_run` (one row per eligible machine run: coding lanes + supervisors) and
 * `finish_run_agreement` (the finish verdict vs the old prose detector on the SAME final) and prints:
 *   - bar: per SEAT MODEL — share of runs that ended with a VALID finish_run within one nudge
 *     (source model|nudged AND valid) with a Wilson 95 % interval; the stage-2 bar is ≥ 0.95 on every seat;
 *     plus the source mix, nudge outcomes / latency, error kinds and rejection reasons, and (build 2026-10-09 FR)
 *     the TYPE REPAIRS (a wrong_type claim whose ref IS a real receipt of another type is valid, recorded as
 *     meta.repairs {from, to, ref}) tallied "from->to" — the doctrine's tuning list;
 *   - agreement: per detector, the cell counts (both_clean / both_flagged / finish_only / detector_only /
 *     no_finish_*) and detector-only convictions per 200 VALID finishes (the stage-4 overlap proxy — the
 *     owner adjudicates those rows before any deletion);
 *   - sample: a deterministic BLIND sample of rejected claims (type, ref, reason, the nearest receipts of
 *     its class, the chat/run ids to look them up) — label each "rejection correct?" by hand; the stage-2
 *     bar is ≥ 90 % precise on 50. Detector verdicts are deliberately NOT shown next to the sample.
 */
'use strict';

const crypto = require('crypto');

function pct(xs, q) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))];
}

/** Wilson score interval (95 %). */
function wilson(k, n) {
  if (!n) return { k, n, p: null, lo: null, hi: null };
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { k, n, p: Math.round(p * 10000) / 10000, lo: Math.max(0, Math.round(((c - m) / d) * 10000) / 10000), hi: Math.min(1, Math.round(((c + m) / d) * 10000) / 10000) };
}

const inc = (o, k, by = 1) => { o[k] = (o[k] || 0) + by; };
const seatOf = (meta) => String((meta && (meta.seat || meta.model)) || 'unknown');

/** finish_run rows ({meta, createdAt?}) → per-seat bar + mixes. Pure. */
function aggregate(rows, bar = 0.95) {
  const bySeat = {};
  const byProfile = {};
  for (const r of rows) {
    const m = r.meta || {};
    const seat = seatOf(m);
    const s = bySeat[seat] || (bySeat[seat] = { runs: 0, validWithinNudge: 0, source: {}, nudge: {}, nudgeMs: [], stepsAfterCall: [], callToEndMs: [], errors: {}, rejectReasons: {}, typeRepairs: {}, claims: 0, verified: 0, unverified: 0, repaired: 0, unverifiable: 0, scopeMismatch: 0, undeclared: 0, offered: 0 });
    s.runs += 1;
    if (m.offered) s.offered += 1;
    const src = String(m.source || 'unknown');
    inc(s.source, src);
    if ((src === 'model' || src === 'nudged') && m.valid === true) s.validWithinNudge += 1;
    if (m.nudge && m.nudge.outcome) inc(s.nudge, String(m.nudge.outcome));
    if (m.nudge && Number.isFinite(m.nudge.ms)) s.nudgeMs.push(m.nudge.ms);
    if (Number.isFinite(m.stepsAfterCall)) s.stepsAfterCall.push(m.stepsAfterCall);
    if (Number.isFinite(m.callToEndMs)) s.callToEndMs.push(m.callToEndMs);
    for (const e of Array.isArray(m.errors) ? m.errors : []) inc(s.errors, String((e && e.kind) || 'unknown'));
    for (const rj of Array.isArray(m.rejected) ? m.rejected : []) inc(s.rejectReasons, String((rj && rj.reason) || 'unknown'));
    for (const rp of Array.isArray(m.repairs) ? m.repairs : []) if (rp && typeof rp === 'object' && rp.from && rp.to) inc(s.typeRepairs, `${rp.from}->${rp.to}`);
    s.claims += Number(m.claims) || 0;
    s.verified += Number(m.verified) || 0;
    s.unverified += Number(m.unverified) || 0;
    s.repaired += Number(m.repaired) || 0;
    s.unverifiable += Number(m.unverifiable) || 0;
    s.scopeMismatch += Number(m.scopeMismatch) || 0;
    if ((Number(m.undeclared) || 0) > 0) s.undeclared += 1;
    const prof = m.supervisor ? 'supervisor' : String(m.profileKind || 'unknown');
    const p = byProfile[prof] || (byProfile[prof] = { runs: 0, validWithinNudge: 0 });
    p.runs += 1;
    if ((src === 'model' || src === 'nudged') && m.valid === true) p.validWithinNudge += 1;
  }
  const seats = {};
  for (const [seat, s] of Object.entries(bySeat)) {
    const w = wilson(s.validWithinNudge, s.runs);
    seats[seat] = {
      runs: s.runs, offeredShare: s.runs ? Math.round((s.offered / s.runs) * 1000) / 1000 : null,
      validWithinOneNudge: w, meetsBar: w.p !== null && w.p >= bar, meetsBarAtLowerBound: w.lo !== null && w.lo >= bar,
      source: s.source, nudge: s.nudge, nudgeMsP50: pct(s.nudgeMs, 0.5), nudgeMsP90: pct(s.nudgeMs, 0.9),
      // the added-cost proxy for an in-loop call (the stage-2 bar: p50 ≤ 1 extra model turn)
      stepsAfterCallP50: pct(s.stepsAfterCall, 0.5), callToEndMsP50: pct(s.callToEndMs, 0.5),
      errors: s.errors, rejectReasons: s.rejectReasons, typeRepairs: s.typeRepairs,
      claims: s.claims, verified: s.verified, unverified: s.unverified, repaired: s.repaired, unverifiable: s.unverifiable, scopeMismatch: s.scopeMismatch,
      runsWithUndeclaredIds: s.undeclared,
    };
  }
  const profiles = {};
  for (const [k, p] of Object.entries(byProfile)) profiles[k] = { runs: p.runs, validWithinOneNudge: wilson(p.validWithinNudge, p.runs) };
  return { bar, runs: rows.length, seats, profiles, allSeatsMeetBar: Object.keys(seats).length > 0 && Object.values(seats).every((s) => s.meetsBar) };
}

/** finish_run_agreement rows → per-detector cells + detector-only per 200 valid finishes. Pure. */
function agreement(rows) {
  const out = {};
  for (const r of rows) {
    const m = r.meta || {};
    const d = String(m.detector || 'unknown');
    const a = out[d] || (out[d] = { rows: 0, cells: {}, detectorKinds: {}, finishOnlyTypes: {} });
    a.rows += 1;
    inc(a.cells, String(m.cell || 'unknown'));
    if (m.cell === 'detector_only') for (const k of Array.isArray(m.detectorKinds) ? m.detectorKinds : []) inc(a.detectorKinds, String(k));
    if (m.cell === 'finish_only') for (const t of Array.isArray(m.finishRejectedTypes) ? m.finishRejectedTypes : []) inc(a.finishOnlyTypes, String(t));
  }
  for (const a of Object.values(out)) {
    const validFinishes = (a.cells.both_clean || 0) + (a.cells.detector_only || 0);
    a.validFinishes = validFinishes;
    a.detectorOnlyPer200ValidFinishes = validFinishes ? Math.round(((a.cells.detector_only || 0) / validFinishes) * 200 * 100) / 100 : null;
  }
  return out;
}

/** Deterministic keep-or-drop by (salt, id) — stable across re-runs. */
function rank(salt, id) {
  return parseInt(crypto.createHash('sha1').update(`${salt}:${id}`).digest('hex').slice(0, 8), 16);
}

/** One entry per rejected claim, a deterministic sample of `n`, BLIND (no detector verdict). Pure. */
function blindSample(rows, n = 50, salt = 'finish-run-precision') {
  const all = [];
  for (const r of rows) {
    const m = r.meta || {};
    (Array.isArray(m.rejected) ? m.rejected : []).forEach((rj, i) => {
      all.push({
        key: `${r.id || r.runId || r.sessionId || ''}#${i}`,
        at: r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 16) : null,
        chat: String(r.sessionId || '').slice(0, 8), run: String(r.runId || '').slice(0, 8), seat: seatOf(m),
        source: m.source || null, type: rj.type, ref: rj.ref, reason: rj.reason,
        ...(rj.suggestType ? { suggestType: rj.suggestType } : {}),
        ...(rj.originCheckable ? { originCheckable: true } : {}),
        nearest: Array.isArray(rj.nearest) ? rj.nearest : [],
        label: null, // fill by hand: true = the rejection is correct (the claim is NOT backed by a real action)
      });
    });
  }
  all.sort((a, b) => rank(salt, a.key) - rank(salt, b.key));
  return { rejectedClaims: all.length, sample: all.slice(0, n).map(({ key, ...rest }) => rest) };
}

async function main() {
  const days = Math.max(1, Math.min(60, parseInt(process.argv[2] || '14', 10) || 14));
  const n = Math.max(1, Math.min(200, parseInt(process.argv[3] || '50', 10) || 50));
  let prisma;
  try { prisma = require('/app/dist/config/database').default; } catch (err) {
    console.log(JSON.stringify({ error: `runtime modules unavailable (${err && err.message})` }));
    process.exit(3);
  }
  const finish = await prisma.$queryRawUnsafe(`
    SELECT id::text AS id, "sessionId", "runId", "createdAt", meta
    FROM loop_metrics
    WHERE kind = 'finish_run' AND "createdAt" > now() - ($1::int * interval '1 day')
    ORDER BY "createdAt" ASC LIMIT 20000`, days);
  const agree = await prisma.$queryRawUnsafe(`
    SELECT meta FROM loop_metrics
    WHERE kind = 'finish_run_agreement' AND "createdAt" > now() - ($1::int * interval '1 day')
    LIMIT 20000`, days);
  const out = { days, bar: aggregate(finish), agreement: agreement(agree), ...blindSample(finish, n) };
  console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 1));
  process.exit(0);
}

module.exports = { pct, wilson, aggregate, agreement, blindSample };

if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String((err && err.message) || err) })); process.exit(1); });
}

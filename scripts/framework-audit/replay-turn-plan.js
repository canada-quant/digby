#!/usr/bin/env node
/**
 * replay-turn-plan.js — dynamic roster OFFLINE REPLAY (docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md §5;
 * owner 2026-10-03: the router learns from taps / re-asks / thumbs and offline replays — never
 * live exploration). v2 (2026-10-03 hardening) — the run that set the Quick-lane guards.
 * v3 (2026-10-20, the lookup-conditioned stakes ceiling — platform/quick-lane-guards.ts
 * stakesCeilingFor): the grid gains a LOOKUP-CEILING dimension and the per-row tuples carry
 * the live-web / multi-step reads the lookup predicate needs; the ask is segment 'replay'
 * (never pooled with human rows by the readiness ruler) with challengers off.
 *
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh replay-turn-plan.js [days=30] [limit=120] [concurrency=4]
 *
 * For each recent HUMAN question on a plain chat (the user row whose next row is a human answer):
 *   - asks the production turn_plan question set through decide() (the decision seat chain);
 *   - asks a REASONING judge — the Double Checker seat, resolved live, called directly with
 *     reasoning on — which lane the message needs (a rubric about what a fast model + web
 *     search would miss);
 *   - scores the production Quick-lane rule (platform/turn-plan.ts quickLaneEligibility —
 *     the same function the run uses, code intent + preset guards included) over a GRID of
 *     cutoffs: τ(quick) × stakes ceiling × contested ceiling × lookup stakes ceiling ('off' =
 *     a guards object without one — the pre-2026-10-20 rule; an active value only where it is
 *     above the base ceiling) → would-Quick count, judge-quick precision (Wilson 95%),
 *     judge-unsafe (checked / research) count, and how many of those the lookup relaxation
 *     admitted (`relaxed` / `relaxedUnsafe`).
 * Output: ONE JSON object — aggregates plus per-row NUMERIC tuples for Jev-quick / judge-quick
 * rows (no content, no ids, no timestamps). READ-ONLY on the DB; telemetry STUBBED; egress =
 * one decide() + one judge call per row. Exit 0 ok; 1 failure.
 */
'use strict';
const crypto = require('crypto');
const DIST = '/app/dist';
const LANES = ['quick', 'standard', 'checked', 'research'];
// The grid's cutoffs. LOOKUP_CEILINGS: 0.6 = the base ceiling (the relaxation is OFF at the default base); every
// (τ, stakes, contested) cell also gets an explicit 'off' row (no lookupStakesCeiling on the guards object).
const TAUS = [0.6, 0.7, 0.75, 0.8, 0.85, 0.9];
const STAKES_CEILINGS = [0.5, 0.6, 0.7, 0.8, 1];
const CONTESTED_CEILINGS = [0.5, 0.7, 1];
const LOOKUP_CEILINGS = [0.6, 0.65, 0.7, 0.75, 0.8];

function stubTelemetry(lm) {
  const counter = { rows: 0 };
  const one = () => { counter.rows += 1; };
  const many = (arr) => { counter.rows += Array.isArray(arr) ? arr.length : 0; };
  try { lm.recordLoopMetric = one; lm.recordLoopMetrics = many; } catch { /* checked below */ }
  if (lm.recordLoopMetric !== one || lm.recordLoopMetrics !== many) throw new Error('telemetry stub did not take');
  return counter;
}
function wilson(k, n, z = 1.96) {
  if (!(n > 0)) return null;
  const p = k / n; const z2 = z * z; const d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d; const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [+p.toFixed(3), +Math.max(0, c - h).toFixed(3), +Math.min(1, c + h).toFixed(3)];
}

/**
 * The guard grid (pure over the replayed rows + the production eligibility function — injected so the
 * test harness runs it without /app/dist). Each row: { cls, chars, preset, code, judge }. A lookup cell is
 * emitted only where its ceiling is ABOVE the cell's base stakes ceiling (anything else is the 'off' row).
 */
function guardGrid(rows, eligibility) {
  const grid = [];
  for (const tau of TAUS) {
    for (const sCeil of STAKES_CEILINGS) {
      for (const cCeil of CONTESTED_CEILINGS) {
        for (const lCeil of ['off', ...LOOKUP_CEILINGS.filter((l) => l > sCeil)]) {
          const guards = { threshold: tau, stakesCeiling: sCeil, contestedCeiling: cCeil, ...(lCeil === 'off' ? {} : { lookupStakesCeiling: lCeil }) };
          const verdicts = rows.map((f) => ({ f, v: eligibility(f.cls, { messageChars: f.chars, images: 0, documents: 0, mode: f.preset === 'deep_research' ? 'deep_research' : 'thinking', escalation: false, supervisor: false, machine: false, codeIntent: f.code }, guards) }));
          const sel = verdicts.filter((x) => x.v && x.v.ok);
          const judged = sel.filter((x) => x.f.judge);
          const hit = judged.filter((x) => x.f.judge === 'quick').length;
          const unsafeOf = (xs) => xs.filter((x) => x.f.judge === 'checked' || x.f.judge === 'research').length;
          const relaxed = sel.filter((x) => x.v.lookupStakes === true);
          grid.push({ tau, sCeil, cCeil, lCeil, n: sel.length, judged: judged.length, precision: wilson(hit, judged.length), unsafe: unsafeOf(judged), relaxed: relaxed.length, relaxedUnsafe: unsafeOf(relaxed.filter((x) => x.f.judge)) });
        }
      }
    }
  }
  return grid;
}
const r2 = (v) => (v == null ? null : +v.toFixed(2));
const JUDGE = [
  'You decide how much compute a chat message deserves. Lanes, cheapest first:',
  'quick — one FAST model with one or two web searches answers it as well as a top model would: weather, time, a score, a price, a definition, a conversion, a simple factual or how-to question. Choose quick only when a stronger model would NOT meaningfully improve the answer.',
  'standard — one strong model answering alone: explanations, writing, summaries, brainstorming, simple code, conversation, follow-ups that need the context of the chat.',
  'checked — a second independent model should check the answer: contested / political / historically disputed points, health / legal / financial advice, tricky multi-step reasoning or numbers, facts that are easy to get wrong.',
  'research — depth across many sources: a report, a history or analysis of a broad topic with several perspectives, a comparison across many options, an explicit research request.',
  'Think briefly, then end your reply with exactly one line: LANE: quick | standard | checked | research',
].join('\n');
function parseLane(text) {
  const m = String(text || '').toLowerCase().match(/lane:\s*(quick|standard|checked|research)/g);
  if (m && m.length) return m[m.length - 1].replace(/lane:\s*/, '');
  const any = String(text || '').toLowerCase().match(/\b(quick|standard|checked|research)\b/g);
  return any ? any[any.length - 1] : null;
}
const SQL_PAGE = `
SELECT m.id, m."chatId", m."createdAt", m.content, a.metadata AS ameta
FROM crossmodel_messages m
JOIN crossmodel_chats c ON c.id = m."chatId"
JOIN users u ON u.id = c."userId"
JOIN LATERAL (
  SELECT x.metadata FROM crossmodel_messages x
  WHERE x."chatId" = m."chatId" AND x."createdAt" > m."createdAt"
  ORDER BY x."createdAt", x.id LIMIT 1
) a ON TRUE
WHERE m.role = 'user'
  AND m."createdAt" > now() - ($1::int * interval '1 day')
  AND c."isSupervisor" = false AND c."isProjectSupervisor" = false
  AND u."isChild" = false
  AND (a.metadata::jsonb) ? 'depth'
  AND NOT ((a.metadata::jsonb) ? 'origin')
  AND NOT ((m.metadata::jsonb) ? 'origin')
ORDER BY m."createdAt" DESC
LIMIT $2::int`;
const SQL_PRIOR = `SELECT content FROM crossmodel_messages WHERE "chatId" = $1 AND role = 'user' AND "createdAt" < $2 ORDER BY "createdAt" DESC LIMIT 2`;

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k).catch(() => null); } }));
  return out;
}

async function main() {
  const days = Math.max(1, Math.min(90, parseInt(process.argv[2] || '30', 10) || 30));
  const limit = Math.max(1, Math.min(500, parseInt(process.argv[3] || '120', 10) || 120));
  const conc = Math.max(1, Math.min(8, parseInt(process.argv[4] || '4', 10) || 4));
  const prisma = require(`${DIST}/config/database`).default;
  const lm = require(`${DIST}/modules/crossmodel/platform/loop-metrics.service`);
  const dg = require(`${DIST}/modules/crossmodel/platform/decision-gate`);
  const tp = require(`${DIST}/modules/crossmodel/platform/turn-plan`);
  const cm = require(`${DIST}/modules/crossmodel/coding/coding-model`);
  let ar = null; try { ar = require(`${DIST}/modules/crossmodel/platform/auto-router`); } catch { ar = null; }
  // The probe runs from /tmp inside the container — resolve the backend's own axios from /app.
  const axiosMod = require(require.resolve('axios', { paths: ['/app'] }));
  const axios = axiosMod.default || axiosMod;
  const telemetry = stubTelemetry(lm);
  const runId = crypto.randomBytes(4).toString('hex');
  const judgeSpec = await cm.resolveRoleModelForRun('double_checker', 'deepseek-flash');
  const judgeProvider = await cm.resolveProviderForRun(judgeSpec);
  const rows = await prisma.$queryRawUnsafe(SQL_PAGE, days, limit);
  const feats = await pool(rows, conc, async (r) => {
    const message = String(r.content || '');
    const prior = await prisma.$queryRawUnsafe(SQL_PRIOR, r.chatId, r.createdAt).catch(() => []);
    const priorUserTurns = prior.map((p) => String(p.content || '')).reverse();
    const ameta = r.ameta || {};
    const preset = ameta && ameta.depth && ameta.depth.plan ? ameta.depth.plan.preset : 'unknown';
    const t0 = Date.now();
    const res = await dg.decide(tp.turnPlanState({ message, priorUserTurns, images: 0, documents: 0, turnIndex: priorUserTurns.length }), tp.turnPlanQuestions(priorUserTurns.length > 0), { purpose: 'turn_plan', timeoutMs: 4000, sessionId: `replay:${runId}`, memo: false, segment: 'replay', challengers: false }).catch(() => null);
    const ms = Date.now() - t0;
    const cls = res ? tp.classFromAnswers(res.answers) : null;
    let judge = null; let judgeMs = null;
    try {
      const j0 = Date.now();
      const extra = { ...(judgeProvider.extra || {}) };
      delete extra.max_tokens; delete extra.max_completion_tokens;
      const payload = { ...extra, model: judgeProvider.model, messages: [{ role: 'system', content: JUDGE }, ...(priorUserTurns.length ? [{ role: 'user', content: `Earlier messages in this chat (context only):\n${priorUserTurns.map((t) => `- ${t.slice(0, 300)}`).join('\n')}` }] : []), { role: 'user', content: `Message to route:\n${message.slice(0, 4000)}` }], max_tokens: 6000 };
      if ('reasoning_effort' in payload) payload.reasoning_effort = 'high';
      const resp = await axios.post(judgeProvider.url, payload, { headers: { ...(judgeProvider.apiKey ? { Authorization: `Bearer ${judgeProvider.apiKey}` } : {}), 'Content-Type': 'application/json' }, timeout: 120000 });
      const msg = resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message || {};
      judge = parseLane(typeof msg.content === 'string' ? msg.content : '');
      judgeMs = Date.now() - j0;
    } catch { judge = null; }
    const ttft = ameta && ameta.ux ? Number(ameta.ux.ttftMs) : null;
    const escalated = !!(ameta && ameta.depth && Array.isArray(ameta.depth.escalations) && ameta.depth.escalations.length);
    return cls ? {
      cls, code: !!(ar && ar.detectCodeIntent(message)),
      lane: cls.lane, p: +cls.laneProbs.quick.toFixed(3), conf: +cls.laneConfidence.toFixed(3),
      stakes: cls.stakes, contested: cls.contested, multi: cls.multiStep, web: cls.needsLiveWeb, breadth: cls.breadth,
      chars: message.length, judge, preset, ttft: Number.isFinite(ttft) ? ttft : null, escalated, ms, judgeMs,
    } : { lane: null, judge, preset, chars: message.length, ms };
  });
  const ok = feats.filter((f) => f && f.lane);
  const grid = guardGrid(ok, tp.quickLaneEligibility);
  const judgeQuick = ok.filter((f) => f.judge === 'quick').length;
  const confusion = {};
  for (const a of LANES) { confusion[a] = {}; for (const b of [...LANES, 'none']) confusion[a][b] = 0; }
  for (const f of ok) confusion[f.lane][f.judge || 'none'] += 1;
  const lat = ok.map((f) => f.ms).sort((x, y) => x - y);
  const jl = ok.map((f) => f.judgeMs).filter(Number.isFinite).sort((x, y) => x - y);
  console.log(JSON.stringify({
    runId, days, rows: rows.length, answered: ok.length, judge: `${judgeSpec}`, judgeAnswered: ok.filter((f) => f.judge).length, judgeQuick,
    jevLatency: { p50: lat[Math.floor(lat.length / 2)] ?? null, p95: lat[Math.floor(lat.length * 0.95)] ?? null },
    judgeLatency: { p50: jl[Math.floor(jl.length / 2)] ?? null },
    confusion,
    grid: grid.filter((g) => g.n > 0),
    quickRows: ok.filter((f) => f.lane === 'quick' || f.judge === 'quick').map((f) => [f.lane, f.p, r2(f.stakes), r2(f.contested), r2(f.web), r2(f.multi), f.chars, f.judge, f.preset, f.ttft == null ? null : Math.round(f.ttft / 1000), f.escalated ? 1 : 0, f.code ? 1 : 0]),
    quickRowsLegend: ['jevLane', 'pQuick', 'stakes', 'contested', 'web', 'multi', 'chars', 'judgeLane', 'ranAs', 'ttftS', 'escalated', 'codeIntent'],
    telemetryRowsSuppressed: telemetry.rows,
  }));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
}
if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String(err && err.message || err).slice(0, 300) })); process.exit(1); });
}

module.exports = { wilson, parseLane, stubTelemetry, JUDGE, guardGrid, LOOKUP_CEILINGS };

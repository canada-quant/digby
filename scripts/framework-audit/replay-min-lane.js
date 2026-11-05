#!/usr/bin/env node
/**
 * replay-min-lane.js — the MINIMUM-SUFFICIENT-LANE replay (roster 2026-10-06 A-1; owner: "drop the presets, fully
 * agentic"; docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md §4 B6 "labels with propensities").
 *
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh replay-min-lane.js [days=14] [limit=200] [concurrency=4] [judge=200]
 *
 * WHY: the live turn_plan labels are not counterfactual — a window-close label records the PREDICTED lane as "held"
 * even when the user saw a different run (readiness report 2026-10-06 §3b-5), so Standard vs Checked had no valid label
 * and the A-2 / A-3 guards (platform/lane-depth.ts) had nothing to be fitted on. This replay produces two labels that
 * ARE valid whatever lane ran:
 *   1. the minimum sufficient lane — the nightly live-chat audit's own judge (platform/live-chat-audit.ts
 *      defaultJudgeLane: the Utility seat with thinking on, "the CHEAPEST lane a stronger lane would not meaningfully
 *      improve"), asked over the user's MESSAGE only (+ the two prior user turns), so the label never sees what ran;
 *   2. the checker-material label on every turn where the Double Checker actually ran (lane-depth.ts
 *      checkerMaterialLabel): 'material' when the reconcile CONTRADICTED the delivered answer (the T6-2 direction-aware
 *      verdict — a removed / replaced claim or a flipped polarity), 'nothing_material' when it changed wording or only
 *      added detail. Older rows without the verdict field are re-read from the kept previous answer
 *      (metadata.revision.previousContent) with compute-policy-gate revisionContradictsPrevious.
 * It then scores the PRODUCTION rules (lane-depth.ts laneCheckerDecision / researchLaneDecision — the same functions the
 * run and the controller use) over a GRID of cutoffs and recommends the strictest-safe guards.
 *
 * Rows: real plain human turns — the user row + the next assistant row carrying metadata.depth on a non-supervisor,
 * non-kid chat, no machine origin, not the bench / suite account (claudebot@…), not a synthetic turn plan, not a side
 * row (deeper findings, addenda, continuation / hand-off results). The turn's RECORDED classification is used
 * (metadata.depth.turnPlan laneProbs + traits); a row without one is re-asked through decide() with segment 'replay'
 * (memo off, no challengers, telemetry stubbed — never a human READY sample).
 *
 * Output: ONE JSON object of AGGREGATES — counts, confusion tables, the grids, the recommendation. No message text,
 * no ids, no timestamps. READ-ONLY on the DB; egress = one judge call per row (≤ judge) + a decide() per unclassified
 * row. Exit 0 ok; 1 failure.
 *
 * Reading it (the readiness bars the store flags should wait for — lane-depth.ts header):
 *   - laneChecker → act: the recommended checker cell has judged ≥ 30, precision Wilson LB ≥ 0.75, unsafe ≤ 1, and
 *     materialContradicted / materialLabelled on its drops ≤ the rate on checked-lane turns (the checker found no more
 *     on would-drop turns than it finds anywhere), AND the owner canary ran ≥ 20 lane turns with no Dig-deeper tap /
 *     re-ask ≤ 5 min on a dropped-checker answer (loop_metrics lane_depth applied='checker').
 *   - laneResearch → act: research cell routed ≥ 5 judged with precision LB ≥ 0.6, and keyword-L3 retirements judged
 *     research ≤ 1 (lane_research rows route 'keyword_retired' joined to this replay).
 *   - laneFailOpen → act: turn_plan decision failure < 1 % over 7 d (decision_gate rows) and laneChecker already act.
 */
'use strict';
const crypto = require('crypto');
const DIST = '/app/dist';
const LANES = ['quick', 'standard', 'checked', 'research'];
const LANE_RANK = { quick: 0, standard: 1, checked: 2, research: 3 };

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

/** metadata.depth.turnPlan → a TurnClass-shaped object (laneProbs normalized; traits as persisted), or null. Pure. */
function clsFromRecord(tp) {
  if (!tp || typeof tp !== 'object' || !tp.laneProbs || typeof tp.laneProbs !== 'object') return null;
  const probs = {}; let sum = 0;
  for (const l of LANES) { const p = Number(tp.laneProbs[l]); probs[l] = Number.isFinite(p) && p > 0 ? p : 0; sum += probs[l]; }
  if (sum <= 0) return null;
  for (const l of LANES) probs[l] = probs[l] / sum;
  const lane = LANES.reduce((best, l) => (probs[l] > probs[best] ? l : best), LANES[0]);
  const t = tp.traits && typeof tp.traits === 'object' ? tp.traits : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    lane, laneProbs: probs, laneConfidence: probs[lane], laneAveraged: true,
    needsLiveWeb: num(t.needsLiveWeb), stakes: num(t.stakes), contested: num(t.contested), multiStep: num(t.multiStep),
    breadth: num(t.breadth), followUp: num(t.followUp),
  };
}

const rankOf = (l) => (l && Object.prototype.hasOwnProperty.call(LANE_RANK, l) ? LANE_RANK[l] : null);

/** The checker grid (pure over the rows + the production decision function). */
function checkerGrid(rows, laneCheckerDecision) {
  const out = [];
  for (const lower of [0.6, 0.7, 0.8, 0.9]) {
    for (const stakes of [0.5, 0.6, 0.7, 1]) {
      for (const contested of [0.5, 0.7, 1]) {
        const g = { lowerLaneThreshold: lower, stakesCeiling: stakes, contestedCeiling: contested };
        const drops = rows.filter((r) => r.cls && laneCheckerDecision(r.cls, g) && laneCheckerDecision(r.cls, g).spawnChecker === false);
        const judged = drops.filter((r) => r.judge);
        const ok = judged.filter((r) => rankOf(r.judge) <= 1).length;
        const unsafe = judged.filter((r) => rankOf(r.judge) >= 2).length;
        const labelled = drops.filter((r) => r.material);
        out.push({
          lower, stakes, contested, n: drops.length, judged: judged.length, precision: wilson(ok, judged.length), unsafe,
          materialLabelled: labelled.length, materialContradicted: labelled.filter((r) => r.material === 'material').length,
        });
      }
    }
  }
  return out;
}

/** The research grid (pure). explicitFloor 1.01 = the explicit-request assist off. */
function researchGrid(rows, researchLaneDecision) {
  const out = [];
  const judgedResearch = rows.filter((r) => r.judge === 'research');
  for (const threshold of [0.3, 0.4, 0.5, 0.6]) {
    for (const explicitFloor of [0.15, 0.2, 0.3, 1.01]) {
      const guards = { threshold, explicitFloor };
      const routed = rows.filter((r) => r.cls && researchLaneDecision(r.cls, { keywordReasonKey: r.keywordReasonKey, guards }).route === 'research');
      const judged = routed.filter((r) => r.judge);
      const hit = judged.filter((r) => r.judge === 'research').length;
      const missed = judgedResearch.filter((r) => !routed.includes(r)).length;
      out.push({ threshold, explicitFloor, n: routed.length, judged: judged.length, precision: wilson(hit, judged.length), missedJudgedResearch: missed });
    }
  }
  return out;
}

/** The strictest-safe recommendation over a checker grid (pure): the most drops with precision LB ≥ 0.75 and unsafe ≤ 1 and
 *  a contradiction rate on the drops no worse than `baselineRate` (checked-lane turns) + 0.05; ties → the stricter cell. */
function recommendChecker(grid, baselineRate) {
  const eligible = grid.filter((g) => g.precision && g.precision[1] >= 0.75 && g.unsafe <= 1
    && (g.materialLabelled < 3 || baselineRate === null || g.materialContradicted / g.materialLabelled <= baselineRate + 0.05));
  if (!eligible.length) return null;
  eligible.sort((a, b) => b.n - a.n || b.lower - a.lower || a.stakes - b.stakes || a.contested - b.contested);
  return eligible[0];
}

/** The research recommendation (pure): the most routed with precision LB ≥ 0.6; ties → the higher threshold. */
function recommendResearch(grid) {
  const eligible = grid.filter((g) => g.precision && g.precision[1] >= 0.6);
  if (!eligible.length) return null;
  eligible.sort((a, b) => b.n - a.n || b.threshold - a.threshold || b.explicitFloor - a.explicitFloor);
  return eligible[0];
}

/** Lane × lane count table (pure). */
function table(rows, a, b) {
  const t = {};
  for (const x of [...LANES, 'none']) { t[x] = {}; for (const y of [...LANES, 'none']) t[x][y] = 0; }
  for (const r of rows) t[r[a] || 'none'][r[b] || 'none'] += 1;
  return t;
}

const SQL_PAGE = `
SELECT m."chatId", m."createdAt", m.content, a.content AS acontent, a.metadata AS ameta
FROM crossmodel_messages m
JOIN crossmodel_chats c ON c.id = m."chatId"
JOIN users u ON u.id = c."userId"
JOIN LATERAL (
  SELECT x.content, x.metadata FROM crossmodel_messages x
  WHERE x."chatId" = m."chatId" AND x."createdAt" > m."createdAt" AND x.role = 'assistant'
  ORDER BY x."createdAt", x.id LIMIT 1
) a ON TRUE
WHERE m.role = 'user'
  AND m."createdAt" > now() - ($1::int * interval '1 day')
  AND c."isSupervisor" = false AND c."isProjectSupervisor" = false
  AND u."isChild" = false
  AND u.email NOT ILIKE 'claudebot%'
  AND (a.metadata::jsonb) ? 'depth'
  AND NOT ((a.metadata::jsonb) ? 'origin')
  AND NOT ((m.metadata::jsonb) ? 'origin')
  AND COALESCE((a.metadata::jsonb)->>'kind', '') NOT IN ('deeper_findings', 'continuation_result', 'deliverable_handoff', 'check_addendum', 'council_addendum', 'control_note')
  AND COALESCE((a.metadata::jsonb)->'depth'->'turnPlan'->>'synthetic', '') <> 'true'
ORDER BY m."createdAt" DESC
LIMIT $2::int`;
const SQL_PRIOR = `SELECT content FROM crossmodel_messages WHERE "chatId" = $1 AND role = 'user' AND "createdAt" < $2 ORDER BY "createdAt" DESC LIMIT 2`;

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k).catch(() => null); } }));
  return out;
}

async function main() {
  const days = Math.max(1, Math.min(90, parseInt(process.argv[2] || '14', 10) || 14));
  const limit = Math.max(1, Math.min(500, parseInt(process.argv[3] || '200', 10) || 200));
  const conc = Math.max(1, Math.min(8, parseInt(process.argv[4] || '4', 10) || 4));
  const judgeN = Math.max(0, Math.min(500, parseInt(process.argv[5] || String(limit), 10)));
  const prisma = require(`${DIST}/config/database`).default;
  const lm = require(`${DIST}/modules/crossmodel/platform/loop-metrics.service`);
  const dg = require(`${DIST}/modules/crossmodel/platform/decision-gate`);
  const tp = require(`${DIST}/modules/crossmodel/platform/turn-plan`);
  const ld = require(`${DIST}/modules/crossmodel/platform/lane-depth`);
  const cpg = require(`${DIST}/modules/crossmodel/platform/compute-policy-gate`);
  const audit = require(`${DIST}/modules/crossmodel/platform/live-chat-audit`);
  const telemetry = stubTelemetry(lm);
  const runId = crypto.randomBytes(4).toString('hex');
  const rows = await prisma.$queryRawUnsafe(SQL_PAGE, days, limit);
  let reasked = 0;
  const feats = await pool(rows, conc, async (r, idx) => {
    const message = String(r.content || '');
    const prior = await prisma.$queryRawUnsafe(SQL_PRIOR, r.chatId, r.createdAt).catch(() => []);
    const priorUserTurns = prior.map((p) => String(p.content || '')).reverse();
    const ameta = r.ameta || {};
    const depth = ameta.depth || {};
    let cls = clsFromRecord(depth.turnPlan);
    if (!cls) {
      reasked += 1;
      const res = await dg.decide(
        tp.turnPlanState({ message, priorUserTurns, images: 0, documents: 0, turnIndex: priorUserTurns.length }),
        tp.turnPlanQuestions(priorUserTurns.length > 0),
        { purpose: 'turn_plan', timeoutMs: 4000, sessionId: `replay:min-lane:${runId}`, memo: false, segment: 'replay', challengers: false },
      ).catch(() => null);
      cls = res ? tp.classFromAnswers(res.answers) : null;
    }
    let judge = null; let judgeMs = null;
    if (idx < judgeN) {
      const j0 = Date.now();
      judge = await audit.defaultJudgeLane(message, priorUserTurns).catch(() => null);
      judgeMs = Date.now() - j0;
    }
    const plan = depth.plan || {};
    return {
      cls, recorded: cls ? cls.lane : null, judge, judgeMs,
      ran: ld.ranLaneOf({ preset: plan.preset || String(ameta.mode || 'single_thinking'), spawnChecker: plan.spawnChecker === true || (!depth.plan && ameta.mode === 'thinking'), lane: plan.lane }),
      material: ld.checkerMaterialLabel(ameta, typeof r.acontent === 'string' ? r.acontent : null, cpg.revisionContradictsPrevious),
      keywordReasonKey: ameta.routing && typeof ameta.routing.reasonKey === 'string' ? ameta.routing.reasonKey : null,
      escalated: Array.isArray(depth.escalations) && depth.escalations.length > 0,
    };
  });
  const ok = feats.filter(Boolean);
  const judged = ok.filter((f) => f.judge);
  const materialBy = (key) => {
    const out = {};
    for (const l of [...LANES, 'none']) out[l] = { labelled: 0, material: 0, nothing: 0 };
    for (const f of ok) { if (!f.material) continue; const k = f[key] || 'none'; out[k].labelled += 1; out[k][f.material === 'material' ? 'material' : 'nothing'] += 1; }
    return out;
  };
  const byRecorded = materialBy('recorded');
  const checkedBase = byRecorded.checked.labelled >= 3 ? byRecorded.checked.material / byRecorded.checked.labelled : null;
  const cGrid = checkerGrid(ok, ld.laneCheckerDecision);
  const rGrid = researchGrid(ok, ld.researchLaneDecision);
  const prov = { over: 0, under: 0, exact: 0 };
  for (const f of judged) { const d = rankOf(f.ran) - rankOf(f.judge); if (d > 0) prov.over += 1; else if (d < 0) prov.under += 1; else prov.exact += 1; }
  const jl = judged.map((f) => f.judgeMs).filter(Number.isFinite).sort((x, y) => x - y);
  console.log(JSON.stringify({
    runId, days, rows: rows.length, classified: ok.filter((f) => f.cls).length, reasked, judged: judged.length,
    judgeLatencyP50: jl[Math.floor(jl.length / 2)] ?? null,
    recordedVsJudge: table(ok, 'recorded', 'judge'),
    ranVsJudge: table(ok, 'ran', 'judge'),
    provisioning: prov,
    checkerMaterial: { byRecordedLane: byRecorded, byJudgeLane: materialBy('judge'), byRanLane: materialBy('ran'), checkedLaneContradictionRate: checkedBase === null ? null : +checkedBase.toFixed(3) },
    escalatedByJudge: LANES.reduce((o, l) => ({ ...o, [l]: ok.filter((f) => f.judge === l && f.escalated).length }), {}),
    checkerGrid: cGrid.filter((g) => g.n > 0),
    researchGrid: rGrid.filter((g) => g.n > 0),
    recommended: {
      checker: recommendChecker(cGrid, checkedBase),
      research: recommendResearch(rGrid),
      current: { checker: ld.LANE_CHECKER_DEFAULT_GUARDS, research: ld.LANE_RESEARCH_DEFAULT_GUARDS },
    },
    telemetryRowsSuppressed: telemetry.rows,
  }));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
}
if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String(err && err.message || err).slice(0, 300) })); process.exit(1); });
}

module.exports = { wilson, clsFromRecord, checkerGrid, researchGrid, recommendChecker, recommendResearch, table, stubTelemetry, LANES };

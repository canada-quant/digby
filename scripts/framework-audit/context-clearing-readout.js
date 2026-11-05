#!/usr/bin/env node
/**
 * context-clearing-readout.js — the LIVE readout of tier-1 context clearing's stage-3 A/B
 * (build 2026-10-11 T1; backend/src/modules/crossmodel/coding/context-gauge.ts; design: context.md §4 stage 3).
 * READ-ONLY; numbers from loop_metrics meta only — never message text, never a user id.
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh context-clearing-readout.js [days=7] [minPerArm=30]
 *
 * Reads loop_metrics `context_edit` rows (meta.event run_summary | tier1_act | tier1_shadow) and prints:
 *   - bar: per ARM (treatment = tier 1 edits the prompt; control = today's behaviour, the randomized
 *     CONTEXT_CLEARING_ENABLED control share) over ELIGIBLE runs only — a provider-reported prompt crossed
 *     T (160k tokens); that crossing happens before any edit, so the filter is the same in both arms:
 *       $ per outcome  = Σ cache-aware list-priced costUsd / Σ (commits + PRs + green verifies)
 *       guardrails     = duplicate-call share, reads per distinct file, search_memory per run, verify pass
 *                        rate, completion (endState ok), treated cache hit
 *     verdict 'act' iff ≥ minPerArm runs per arm AND $/outcome ≥ 15 % lower AND no guardrail worse by > 10 %
 *     relative (verify pass: > 3 points) AND treated cache hit ≥ 0.85; 'hold' when a bar fails;
 *     'insufficient_data' below minPerArm (context.md §1 summary item 12);
 *   - barByProfile: the same bar per run profile — coding lanes (the shape the bar was designed for) vs chat /
 *     supervisor runs (the 2026-10-09..11 shadow projected −0.3 % on chat runs vs +6.6 % on coding lanes);
 *   - byModel: the same per (arm, seat model) — runs, $/outcome, cache hit;
 *   - events: the treated runs' tier1_act rows — events per eligible run, freed tokens, predicted vs observed
 *     cached tokens on the first request after the edit (median |error| %), predicted vs observed cache-break $,
 *     unplanned misses (the prefix before the edit point was not served from cache), steer-blocked turns,
 *     re-reads of cleared results; and the control arm's would-clear (tier1_shadow) rows for comparison.
 */
'use strict';

const BAR = { dollarDrop: 0.15, guardrailRel: 0.1, verifyPassPts: 0.03, cacheHitMin: 0.85 };

const sum = (xs) => xs.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r4 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);
function pct(xs, q) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))];
}

/** run_summary metas of ONE arm → the stage-3 measures. Pure. */
function armStats(metas) {
  const runs = metas.length;
  const cost = sum(metas.map((m) => num(m.costUsd)));
  const outcomes = sum(metas.map((m) => num(m.outcomes)));
  const toolCalls = sum(metas.map((m) => num(m.toolCalls)));
  const readFileCalls = sum(metas.map((m) => num(m.readFileCalls)));
  const readFilePaths = sum(metas.map((m) => num(m.readFilePaths)));
  const verifyRuns = sum(metas.map((m) => num(m.verifyRuns)));
  const cacheRows = metas.filter((m) => Number.isFinite(Number(m.sumCachedTokens)));
  const promptTokens = sum(cacheRows.map((m) => num(m.sumPromptTokens)));
  return {
    runs,
    costUsd: r4(cost),
    outcomes,
    costPerOutcome: outcomes ? r4(cost / outcomes) : null,
    costPerRunP50: r4(pct(metas.map((m) => num(m.costUsd)), 0.5)),
    commits: sum(metas.map((m) => num(m.commits))), prs: sum(metas.map((m) => num(m.prs))), verifyPassed: sum(metas.map((m) => num(m.verifyPassed))),
    dupShare: toolCalls ? r4(sum(metas.map((m) => num(m.dupCalls))) / toolCalls) : null,
    readsPerFile: readFilePaths ? r4(readFileCalls / readFilePaths) : null,
    searchMemoryPerRun: runs ? r4(sum(metas.map((m) => num(m.searchMemoryCalls))) / runs) : null,
    verifyPassRate: verifyRuns ? r4(sum(metas.map((m) => num(m.verifyPassed))) / verifyRuns) : null,
    completion: runs ? r4(metas.filter((m) => (m.endState || 'ok') === 'ok').length / runs) : null,
    cacheHit: promptTokens ? r4(sum(cacheRows.map((m) => num(m.sumCachedTokens))) / promptTokens) : null,
    peakPromptP50: pct(metas.map((m) => num(m.peakPromptTokens)), 0.5),
    t1EventsPerRun: runs ? r4(sum(metas.map((m) => num(m.t1Events))) / runs) : null,
    steerBlockedTurns: sum(metas.map((m) => num(m.t1SteerBlockedTurns))),
    reReads: sum(metas.map((m) => num(m.t1ReReads))),
    compactions: sum(metas.map((m) => num(m.compactions))),
  };
}

/** A guardrail comparison: higher-is-worse (or lower-is-worse) with a relative tolerance. Pure. */
function guard(name, t, c, dir, tol) {
  if (t === null || c === null) return { name, treatment: t, control: c, relDelta: null, worse: false, note: 'no data' };
  if (c === 0) return { name, treatment: t, control: c, relDelta: null, worse: dir === 'higher' ? t > 0 : false };
  const rel = (t - c) / c;
  return { name, treatment: t, control: c, relDelta: r4(rel), worse: dir === 'higher' ? rel > tol : rel < -tol };
}

/** The stage-3 bar over two arms' stats. Pure. */
function stageThreeBar(t, c, minPerArm = 30, bar = BAR) {
  const checks = [
    guard('dupShare', t.dupShare, c.dupShare, 'higher', bar.guardrailRel),
    guard('readsPerFile', t.readsPerFile, c.readsPerFile, 'higher', bar.guardrailRel),
    guard('searchMemoryPerRun', t.searchMemoryPerRun, c.searchMemoryPerRun, 'higher', bar.guardrailRel),
    guard('completion', t.completion, c.completion, 'lower', bar.guardrailRel),
  ];
  const vp = t.verifyPassRate !== null && c.verifyPassRate !== null
    ? { name: 'verifyPassRate', treatment: t.verifyPassRate, control: c.verifyPassRate, deltaPts: r4(t.verifyPassRate - c.verifyPassRate), worse: t.verifyPassRate < c.verifyPassRate - bar.verifyPassPts }
    : { name: 'verifyPassRate', treatment: t.verifyPassRate, control: c.verifyPassRate, deltaPts: null, worse: false, note: 'no data' };
  checks.push(vp);
  const dollarDelta = t.costPerOutcome !== null && c.costPerOutcome !== null && c.costPerOutcome > 0 ? r4((t.costPerOutcome - c.costPerOutcome) / c.costPerOutcome) : null;
  const enough = t.runs >= minPerArm && c.runs >= minPerArm;
  const dollarOk = dollarDelta !== null && dollarDelta <= -bar.dollarDrop;
  const guardrailsOk = checks.every((x) => !x.worse);
  const cacheOk = t.cacheHit !== null && t.cacheHit >= bar.cacheHitMin;
  const verdict = !enough ? 'insufficient_data' : dollarOk && guardrailsOk && cacheOk ? 'act' : 'hold';
  const why = [];
  if (!enough) why.push(`need ≥ ${minPerArm} eligible runs per arm (treatment ${t.runs}, control ${c.runs})`);
  if (dollarDelta === null) why.push('$ per outcome undefined (no outcomes in an arm)');
  else if (!dollarOk) why.push(`$ per outcome ${(dollarDelta * 100).toFixed(1)} % (bar ≤ −${bar.dollarDrop * 100} %)`);
  for (const x of checks) if (x.worse) why.push(`guardrail ${x.name} worse (treatment ${x.treatment} vs control ${x.control})`);
  if (!cacheOk) why.push(`treated cache hit ${t.cacheHit} (bar ≥ ${bar.cacheHitMin})`);
  return { verdict, dollarDelta, minPerArm, guardrails: checks, treatedCacheHit: t.cacheHit, why };
}

/** tier1_act metas (treated runs) → event-level numbers. Pure. */
function eventStats(acts) {
  const observed = acts.filter((m) => Number.isFinite(Number(m.observedCachedTokens)) && num(m.predictedCachedTokens) > 0);
  const errs = observed.map((m) => Math.abs(num(m.observedCachedTokens) - num(m.predictedCachedTokens)) / num(m.predictedCachedTokens));
  return {
    events: acts.length,
    freedTokensP50: pct(acts.map((m) => num(m.freedTokens)), 0.5),
    clearedResultsP50: pct(acts.map((m) => num(m.clearedResults)), 0.5),
    withObservation: observed.length,
    cachedPredictionAbsErrP50: r4(pct(errs, 0.5)),
    cachedPredictionAbsErrP90: r4(pct(errs, 0.9)),
    unplannedMisses: acts.filter((m) => m.unplannedMiss === true).length,
    breakUsdPredicted: r4(sum(acts.map((m) => num(m.breakUsdPredicted)))),
    breakUsdObserved: r4(sum(observed.map((m) => num(m.breakUsdObserved)))),
    turnsSinceAnchorMin: acts.length ? Math.min(...acts.map((m) => (m.turnsSinceAnchor === null || m.turnsSinceAnchor === undefined ? Infinity : num(m.turnsSinceAnchor)))) : null,
  };
}

/** All context_edit rows ({meta}) → the readout. Pure. */
function aggregate(rows, minPerArm = 30) {
  const summaries = rows.map((r) => r.meta || {}).filter((m) => m.event === 'run_summary');
  const armOf = (m) => String(m.arm || 'legacy');
  const runsByArm = {};
  for (const m of summaries) runsByArm[armOf(m)] = (runsByArm[armOf(m)] || 0) + 1;
  const eligible = summaries.filter((m) => m.t1Eligible === true || (m.t1Eligible === undefined && num(m.peakPromptTokens) > num(m.t1Trigger || 160000)));
  const treat = eligible.filter((m) => armOf(m) === 'treatment');
  const ctrl = eligible.filter((m) => armOf(m) === 'control');
  const t = armStats(treat);
  const c = armStats(ctrl);
  const byModel = {};
  for (const m of [...treat, ...ctrl]) {
    const key = `${armOf(m)} · ${String(m.model || 'unknown')}`;
    (byModel[key] = byModel[key] || []).push(m);
  }
  const models = {};
  for (const [k, ms] of Object.entries(byModel)) {
    const s = armStats(ms);
    models[k] = { runs: s.runs, costPerOutcome: s.costPerOutcome, outcomes: s.outcomes, cacheHit: s.cacheHit, t1EventsPerRun: s.t1EventsPerRun };
  }
  // the bar per run profile: coding lanes (what context.md's bar was designed for) vs chat / supervisor runs
  const barByProfile = {};
  for (const prof of [...new Set([...treat, ...ctrl].map((m) => String(m.profile || 'unknown')))].sort()) {
    const pt = armStats(treat.filter((m) => String(m.profile || 'unknown') === prof));
    const pc = armStats(ctrl.filter((m) => String(m.profile || 'unknown') === prof));
    barByProfile[prof] = { eligibleRuns: { treatment: pt.runs, control: pc.runs }, costPerOutcome: { treatment: pt.costPerOutcome, control: pc.costPerOutcome }, ...stageThreeBar(pt, pc, minPerArm) };
  }
  const metas = rows.map((r) => r.meta || {});
  const acts = metas.filter((m) => m.event === 'tier1_act');
  const controlShadows = metas.filter((m) => m.event === 'tier1_shadow' && m.arm === 'control');
  return {
    runsByArm,
    eligibleRuns: { treatment: treat.length, control: ctrl.length },
    arms: { treatment: t, control: c },
    bar: stageThreeBar(t, c, minPerArm),
    barByProfile,
    byModel: models,
    events: { treatment: eventStats(acts), controlWouldClear: controlShadows.length },
  };
}

async function main() {
  const days = Math.max(1, Math.min(60, parseInt(process.argv[2] || '7', 10) || 7));
  const minPerArm = Math.max(1, Math.min(1000, parseInt(process.argv[3] || '30', 10) || 30));
  let prisma;
  try { prisma = require('/app/dist/config/database').default; } catch (err) {
    console.log(JSON.stringify({ error: `runtime modules unavailable (${err && err.message})` }));
    process.exit(3);
  }
  const rows = await prisma.$queryRawUnsafe(`
    SELECT meta FROM loop_metrics
    WHERE kind = 'context_edit' AND "createdAt" > now() - ($1::int * interval '1 day')
      AND meta->>'event' IN ('run_summary', 'tier1_act', 'tier1_shadow')
    LIMIT 200000`, days);
  const out = { days, ...aggregate(rows, minPerArm) };
  console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 1));
  process.exit(0);
}

module.exports = { BAR, armStats, guard, stageThreeBar, eventStats, aggregate };

if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String((err && err.message) || err) })); process.exit(1); });
}

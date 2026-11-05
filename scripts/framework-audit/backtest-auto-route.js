#!/usr/bin/env node
/**
 * backtest-auto-route.js — patience plan §4.5: the IN-PLACE REPLAY of the Auto router
 * over historical human chat turns (docs/PATIENCE_AUTO_ONLY_DEPRECATION_PLAN_2026-09-25.md
 * §4.2 labels + biases, §4.3 sample rules, §4.5 mechanism, §4.6 acceptance table).
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs it from
 * /app), so `/app/dist/...` is the compiled backend:
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh /tmp/backtest-auto-route.js <days> <spec> [batch] [cursor-file]
 *
 * READ-ONLY on the database. The ONLY side effect is egress: one decision-gate call per
 * scored message to the backend named by <spec> ('deepseek-flash' until owner Q1 approves
 * TypeSafe egress for non-Auto sends; 'jev' after). Telemetry is STUBBED: recordLoopMetric /
 * recordLoopMetrics are overwritten on the loop-metrics.service CJS namespace BEFORE the
 * first decide() (recordDecisionRow and maybeRecordDecisionState both write through that
 * namespace — verified 2026-09-26), and every ask is tagged sessionId `backtest:<runId>` as
 * belt-and-braces (readouts exclude the prefix). A row that somehow reached the DB would
 * show up as loop_metrics."sessionId" LIKE 'backtest:%' — the aux query counts them (expect 0).
 *
 * Selection (§4.5): chats isSupervisor=false, isProjectSupervisor=false, parentChatId IS NULL,
 * updatedAt in the window (no createdAt-only index on messages), owner not a child; user rows
 * whose NEXT row is an assistant row with metadata.engine='agent' and no metadata.origin
 * (machine wakes carry origin); cursor by (chatId, createdAt). Anonymous (guest) turns have
 * no crossmodel_messages rows at all (Redis 24 h sessions) — the guest segment is reported
 * from live decision_gate rows only (legacy predicate "sessionId" IS NULL).
 *
 * Labels per row: H = the heuristic re-run on the message (always) and, on Auto-routed rows,
 * the persisted metadata.routing.level; U = metadata.mode on rows WITHOUT routing (weak:
 * restore-contaminated unless metadata.routingSource='user_picked'). Gate = decide() with the
 * SAME state + question builders production uses (auto-router-gate autoRouteState /
 * autoRouteQuestions) and the SAME per-option thresholds (autoRouteThreshold: 0.7, 0.85 for
 * deep_research) — "gate@τ" is what act would have routed (confident → the choice, else the
 * heuristic's level), "gateRaw" is the choice regardless of confidence.
 *
 * Output: each invocation scores ≤ <batch> messages (default 300), serially, ≥ 200 ms apart,
 * appends ONE JSON line of mergeable aggregates to $AR_BACKTEST_DIR/<runId>.jsonl (default
 * /var/tmp/ar-backtest — INSIDE the container: docker cp it out before a deploy flips the
 * colour) and advances the cursor file; `--merge [runId|path]` folds the lines into the final
 * report. Aggregates only — never a message, never a user id (user ids are salted-hashed
 * for distinct counts; the salt lives in the cursor file). `--dry-run` proves the arithmetic
 * and the batch/cursor/merge plumbing locally on synthetic rows with a stubbed Prisma client
 * and a stubbed decide() — no /app/dist, no network.
 *
 * Exit codes: 0 ok; 2 usage; 3 runtime modules unavailable; 1 unexpected failure.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ── Constants ────────────────────────────────────────────────────────────────

const LEVELS = ['single_thinking', 'thinking', 'deep_research'];
const DEFAULT_DAYS = 30;
const DEFAULT_SPEC = 'deepseek-flash';
const DEFAULT_BATCH = 300;
const CALL_FLOOR_MS = 200;
/** Off the request path (the label window's bound) — the latency is measured, not capped at 1.5 s. */
const DECIDE_TIMEOUT_MS = 4000;
/** The request-path budget the plan counts "over budget" against (§4.6). */
const ACT_BUDGET_MS = 1500;
const P95_BAR_MS = 1200;
const DEFAULT_THRESHOLDS = { single_thinking: 0.7, thinking: 0.7, deep_research: 0.85 };
/** run_spend / chat_search_usage rows are stamped at settle time, AFTER the assistant row. */
const SPEND_JOIN_BEFORE_MS = 60_000;
const SPEND_JOIN_AFTER_MS = 30 * 60_000;
const ECE_BIN_FROM = 1 / 3;
const ECE_BINS = 6;
const BOOTSTRAP_REPS = 1000;
const DEFAULT_OUT_DIR = process.env.AR_BACKTEST_DIR || '/var/tmp/ar-backtest';

const DIST = '/app/dist';
const MOD = {
  database: `${DIST}/config/database`,
  autoRouter: `${DIST}/modules/crossmodel/platform/auto-router`,
  autoRouterGate: `${DIST}/modules/crossmodel/platform/auto-router-gate`,
  decisionGate: `${DIST}/modules/crossmodel/platform/decision-gate`,
  decisionGateModes: `${DIST}/modules/crossmodel/platform/decision-gate-modes`,
  loopMetrics: `${DIST}/modules/crossmodel/platform/loop-metrics.service`,
  folderInheritance: `${DIST}/modules/crossmodel/platform/folder-inheritance`,
  types: `${DIST}/modules/crossmodel/types`,
};

/**
 * Shift-metric regexes (§4.1 "Distribution shift"): the probe prefers the COMPILED
 * auto-router's exports (RESEARCH_INTENT_PATTERNS / SIMPLE_OPENER_PATTERN, exported
 * 2026-09-26) and falls back to this dated copy when the box's dist predates the export.
 * Copied verbatim from backend/src/modules/crossmodel/platform/auto-router.ts @ 2026-09-26.
 */
const SHIFT_FALLBACK = {
  researchIntent: [
    /\bdeep[\s-]?dive\b/i,
    /\bcompare and contrast\b/i,
    /\bliterature( review)?\b/i,
    /\blatest (news|developments|updates|research)\b/i,
    /\bcomprehensive (analysis|report|guide|overview|review|breakdown)\b/i,
    /\bin[\s-]?depth (analysis|look|review|report|breakdown)\b/i,
    /\bwhite\s?paper\b/i,
    /\bmarket (analysis|research|sizing|landscape)\b/i,
    /\b(research|researched|researching)\b/i,
    /\b(cite|citation|citations|sources?)\b/i,
    /\b(write|produce|draft)\s+(a\s+)?(full|detailed|comprehensive)\s+(report|analysis|brief)\b/i,
  ],
  simpleOpener: /^(what|who|whom|whose|when|where|which|define|meaning of|how much|how many|how old)\b/i,
};

// ── Pure metric functions (exported for the jest suite) ──────────────────────

/** Wilson score interval for k successes in n trials (z = 1.96 → 95%). */
function wilson(k, n, z = 1.96) {
  k = Number(k) || 0; n = Number(n) || 0;
  if (!(n > 0)) return { k, n, p: null, lo: null, hi: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Confusion matrix for paired labels. `pairs` = [[a, b], …]; a null side is counted
 * under 'none'. Returns counts[a][b], n (pairs with both sides), agree, agreeRate.
 */
function confusionMatrix(pairs, labels = LEVELS) {
  const keys = [...labels, 'none'];
  const counts = {};
  for (const a of keys) { counts[a] = {}; for (const b of keys) counts[a][b] = 0; }
  let n = 0, agree = 0;
  for (const [a0, b0] of pairs) {
    const a = keys.includes(a0) ? a0 : 'none';
    const b = keys.includes(b0) ? b0 : 'none';
    counts[a][b] += 1;
    if (a !== 'none' && b !== 'none') { n += 1; if (a === b) agree += 1; }
  }
  return { labels: keys, counts, n, agree, agreeRate: n ? agree / n : null };
}

/** Merge two confusion matrices produced by confusionMatrix (same label set). */
function mergeConfusion(x, y) {
  if (!x) return y; if (!y) return x;
  const out = { labels: x.labels, counts: {}, n: x.n + y.n, agree: x.agree + y.agree, agreeRate: null };
  for (const a of x.labels) { out.counts[a] = {}; for (const b of x.labels) out.counts[a][b] = (x.counts[a]?.[b] || 0) + (y.counts[a]?.[b] || 0); }
  out.agreeRate = out.n ? out.agree / out.n : null;
  return out;
}

/** Top-label reliability bins over [from, 1] (width_bucket semantics; conf outside clamps to the edge bins). */
function eceBinIndex(conf, from = ECE_BIN_FROM, bins = ECE_BINS) {
  if (!Number.isFinite(conf)) return null;
  const w = (1 - from) / bins;
  const i = Math.floor((conf - from) / w);
  return Math.min(bins - 1, Math.max(0, i));
}
function newEceBins(from = ECE_BIN_FROM, bins = ECE_BINS) {
  const w = (1 - from) / bins;
  return Array.from({ length: bins }, (_, i) => ({ lo: from + i * w, hi: from + (i + 1) * w, n: 0, sumConf: 0, sumAgree: 0 }));
}
function addEceSample(bins, conf, agree) {
  const i = eceBinIndex(conf, bins[0].lo, bins.length);
  if (i === null) return;
  bins[i].n += 1; bins[i].sumConf += conf; bins[i].sumAgree += agree ? 1 : 0;
}
function mergeEceBins(x, y) {
  return x.map((b, i) => ({ lo: b.lo, hi: b.hi, n: b.n + (y[i]?.n || 0), sumConf: b.sumConf + (y[i]?.sumConf || 0), sumAgree: b.sumAgree + (y[i]?.sumAgree || 0) }));
}
/** ECE = Σ_b (n_b/N)·|mean_conf_b − empirical_agree_b|; also the per-bin table and the top-bucket agreement. */
function eceFromBins(bins) {
  const N = bins.reduce((s, b) => s + b.n, 0);
  if (!N) return { ece: null, n: 0, bins: bins.map(b => ({ lo: b.lo, hi: b.hi, n: 0, meanConf: null, empAgree: null })), topBucket: { n: 0, empAgree: null }, secondBucket: { n: 0, empAgree: null } };
  let ece = 0;
  const table = bins.map(b => {
    const meanConf = b.n ? b.sumConf / b.n : null;
    const empAgree = b.n ? b.sumAgree / b.n : null;
    if (b.n) ece += (b.n / N) * Math.abs(meanConf - empAgree);
    return { lo: b.lo, hi: b.hi, n: b.n, meanConf, empAgree };
  });
  const top = table[table.length - 1], second = table[table.length - 2];
  return { ece, n: N, bins: table, topBucket: { n: top.n, empAgree: top.empAgree }, secondBucket: { n: second.n, empAgree: second.empAgree } };
}
/** Convenience for tests: samples [{conf, agree}] → eceFromBins. */
function eceTopLabel(samples, from = ECE_BIN_FROM, bins = ECE_BINS) {
  const b = newEceBins(from, bins);
  for (const s of samples) addEceSample(b, s.conf, s.agree);
  return eceFromBins(b);
}

/** Brier sums: per option Σ(p_k − 1[k=actual])² and the multi-class Σ over options; mergeable. */
function newBrier() { const perOption = {}; for (const k of LEVELS) perOption[k] = { sumSq: 0, n: 0 }; return { perOption, multi: { sumSq: 0, n: 0 } }; }
function addBrierSample(acc, probs, actual) {
  if (!probs || !LEVELS.includes(actual)) return;
  let multi = 0;
  for (const k of LEVELS) {
    const p = Number(probs[k]); if (!Number.isFinite(p)) return; // a partial vector is not scorable
    const d = p - (k === actual ? 1 : 0);
    acc.perOption[k].sumSq += d * d; acc.perOption[k].n += 1; multi += d * d;
  }
  acc.multi.sumSq += multi; acc.multi.n += 1;
}
function mergeBrier(x, y) {
  const out = newBrier();
  for (const k of LEVELS) { out.perOption[k].sumSq = x.perOption[k].sumSq + y.perOption[k].sumSq; out.perOption[k].n = x.perOption[k].n + y.perOption[k].n; }
  out.multi.sumSq = x.multi.sumSq + y.multi.sumSq; out.multi.n = x.multi.n + y.multi.n;
  return out;
}
function brierFromSums(acc) {
  const perOption = {};
  for (const k of LEVELS) perOption[k] = acc.perOption[k].n ? acc.perOption[k].sumSq / acc.perOption[k].n : null;
  return { perOption, multiclass: acc.multi.n ? acc.multi.sumSq / acc.multi.n : null, n: acc.multi.n };
}

/**
 * McNemar-style paired difference in agreement (gate − heuristic) with the user label:
 * b = gate right & heuristic wrong, c = heuristic right & gate wrong, n = paired rows.
 * diff = (b − c)/n; SE = sqrt(b + c − (b − c)²/n)/n (the standard paired-proportion Wald SE).
 * Returns the 95% bounds in proportions (×100 = pp).
 */
function pairedDiffCI(b, c, n, z = 1.96) {
  b = Number(b) || 0; c = Number(c) || 0; n = Number(n) || 0;
  if (!(n > 0)) return { b, c, n, diff: null, lo: null, hi: null, discordance: null };
  const diff = (b - c) / n;
  const varNum = (b + c) - ((b - c) * (b - c)) / n;
  const se = Math.sqrt(Math.max(0, varNum)) / n;
  return { b, c, n, diff, lo: diff - z * se, hi: diff + z * se, discordance: (b + c) / n };
}

/** Linear-interpolation quantile on an unsorted numeric array. */
function quantile(values, q) {
  const a = values.filter(v => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/** Deterministic PRNG (mulberry32) for the bootstrap and the dry-run corpus. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cluster bootstrap (§4.3 "clustered by userId"): resample users with replacement, pool
 * their tallies, evaluate `stat(pooledTally)`; returns the point estimate on the real pool
 * and the percentile 95% interval. `users` = { hash: tally }, tallies are additive numbers.
 */
function clusterBootstrap(users, stat, reps = BOOTSTRAP_REPS, seed = 1) {
  const list = Object.values(users || {});
  const pool = (arr) => arr.reduce((acc, t) => { for (const k of Object.keys(t)) acc[k] = (acc[k] || 0) + (Number(t[k]) || 0); return acc; }, {});
  const point = list.length ? stat(pool(list)) : null;
  if (list.length < 2 || point === null || !Number.isFinite(point)) return { point, lo: null, hi: null, users: list.length, reps: 0 };
  const rnd = mulberry32(seed);
  const vals = [];
  for (let r = 0; r < reps; r++) {
    const sample = [];
    for (let i = 0; i < list.length; i++) sample.push(list[Math.floor(rnd() * list.length)]);
    const v = stat(pool(sample));
    if (v !== null && Number.isFinite(v)) vals.push(v);
  }
  return { point, lo: quantile(vals, 0.025), hi: quantile(vals, 0.975), users: list.length, reps: vals.length };
}

/** Alias legacy patience ids to the three routable levels; anything else → null. */
function normalizeLevel(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s === 'single' || s === 'fast' || s === 'single_thinking') return 'single_thinking';
  if (s === 'thinking') return 'thinking';
  if (s === 'deep_research' || s === 'deep_research_all') return 'deep_research';
  return null;
}

/** Label one assistant row's metadata (§4.2 historical rule). */
function labelOf(ameta) {
  const m = ameta && typeof ameta === 'object' ? ameta : {};
  const routing = m.routing && typeof m.routing === 'object' ? m.routing : null;
  const routingSource = typeof m.routingSource === 'string' ? m.routingSource : null;
  if (routing && typeof routing.level === 'string') {
    return {
      kind: 'H', U: null, hStored: normalizeLevel(routing.level), routingSource,
      liveSource: routing.source === 'decision' ? 'decision' : 'heuristic',
      liveConfidence: Number.isFinite(Number(routing.confidence)) ? Number(routing.confidence) : null,
      liveClamped: !!routing.clamped,
    };
  }
  const U = normalizeLevel(m.mode);
  if (!U) return { kind: 'none', U: null, hStored: null, routingSource, liveSource: null, liveConfidence: null, liveClamped: false };
  // Historical U is the chat's stored mode at send time — a picker action, a default or a
  // restored value are indistinguishable unless the 1a routingSource stamp says 'user_picked'.
  const picked = routingSource === 'user_picked';
  return { kind: 'U', U, hStored: null, routingSource, contaminated: !picked, liveSource: null, liveConfidence: null, liveClamped: false };
}

/** T (§4.2): the Digby card's time, else the persisted synthesisTime — both ms on persisted rows. */
function tValueMs(ameta) {
  const m = ameta && typeof ameta === 'object' ? ameta : {};
  const card = m.models && typeof m.models === 'object' ? m.models.digby : null;
  const t = card && Number.isFinite(Number(card.time)) ? Number(card.time) : Number(m.synthesisTime);
  return Number.isFinite(t) && t >= 0 ? t : null;
}

function hashUser(salt, userId) {
  if (!userId) return null;
  return crypto.createHash('sha256').update(`${salt}|${userId}`).digest('hex').slice(0, 12);
}

// ── Batch aggregate (mergeable sufficient statistics) ───────────────────────

function zeroLevels(extra = []) { const o = {}; for (const k of [...LEVELS, ...extra]) o[k] = 0; return o; }
function perLevelSamples() { const o = {}; for (const k of LEVELS) o[k] = []; return o; }

function newAgg(meta = {}) {
  return {
    v: 1,
    probe: 'backtest-auto-route',
    runId: meta.runId || null, spec: meta.spec || null, batchIndex: meta.batchIndex ?? 0,
    window: meta.window || null,
    thresholds: meta.thresholds || DEFAULT_THRESHOLDS,
    decisionMode: meta.decisionMode || null,
    gateUnavailable: null,
    shiftSource: meta.shiftSource || null,
    rowsScanned: 0, rowsScored: 0,
    skipped: {},
    createdAt: { min: null, max: null },
    segments: { user: 0, guest: 0 },
    labels: {
      U: { n: 0, contaminated: 0, picked: 0, default: 0, explicit: 0, byLevel: zeroLevels() },
      H: { n: 0, byLevel: zeroLevels(), liveDecision: 0, liveClamped: 0, storedVsRerunAgree: 0, storedVsReplayGateAtAgree: 0 },
      none: 0,
    },
    heuristic: { byLevel: zeroLevels(), byReasonKey: {} },
    gate: {
      calls: 0, ok: 0, nullResults: 0, errors: 0, cached: 0, calibrated: 0,
      byBackend: {}, byMode: {}, latencies: [], overBudget: 0,
      raw: zeroLevels(['none']), atThreshold: zeroLevels(),
      coverage: { n: 0, covered: 0, byOption: { single_thinking: { n: 0, covered: 0 }, thinking: { n: 0, covered: 0 }, deep_research: { n: 0, covered: 0 } } },
    },
    confusion: { U_x_H: null, U_x_gateAt: null, H_x_gateAt: null, U_x_gateRaw: null, H_x_gateRaw: null, Hrerun_x_gateAt: null, Hstored_x_Hrerun: null },
    calibration: { eceBinsU: newEceBins(), eceBinsH: newEceBins(), brierU: newBrier(), brierH: newBrier() },
    escalation: { uL1: 0, uL1gL3: 0, uL3: 0, uL3gL1: 0, uL3gL3: 0, uL3noDown: 0, uL3noDownGL3: 0 },
    nonInf: { n: 0, gateAgree: 0, heurAgree: 0, b: 0, c: 0 },
    tMs: { byU: perLevelSamples(), byGateAt: perLevelSamples(), byH: perLevelSamples(), formerL1: [] },
    spend: { assistantRows: 0, joined: 0, estimated: 0, byU: { single_thinking: [], thinking: [], deep_research: [] }, byH: { single_thinking: [], thinking: [], deep_research: [] } },
    feedback: { byU: {}, byH: {}, windowJoin: null, rowsWithDown: 0 },
    search: { byU: { single_thinking: { n: 0, zero: 0 }, thinking: { n: 0, zero: 0 }, deep_research: { n: 0, zero: 0 } }, byGateAt: { single_thinking: { n: 0, zero: 0 }, thinking: { n: 0, zero: 0 }, deep_research: { n: 0, zero: 0 } }, joined: 0 },
    shift: { n: 0, researchIntent: 0, simpleOpener: 0, byU: { single_thinking: { n: 0, ri: 0, so: 0 }, thinking: { n: 0, ri: 0, so: 0 }, deep_research: { n: 0, ri: 0, so: 0 } } },
    users: { all: [], U_single_thinking: [], U_thinking: [], U_deep_research: [], H: [] },
    perUser: {},
    aux: null,
    cursor: null,
  };
}

function bump(obj, key, by = 1) { obj[key] = (obj[key] || 0) + by; }
function uniq(arr) { return [...new Set(arr)]; }
/** Distinct-user lists stay deduplicated at accumulation time (mergeAgg dedupes too — the two must agree). */
function pushUniq(arr, v) { if (v && !arr.includes(v)) arr.push(v); }

/** Fold one scored row into the aggregate. `row` is the scorer's output (no text, no ids). */
function addRow(agg, row) {
  agg.rowsScored += 1;
  const ts = row.createdAtIso;
  if (ts) { if (!agg.createdAt.min || ts < agg.createdAt.min) agg.createdAt.min = ts; if (!agg.createdAt.max || ts > agg.createdAt.max) agg.createdAt.max = ts; }
  bump(agg.segments, row.segment || 'user');
  const L = row.label;
  const hRerun = row.heuristic;
  bump(agg.heuristic.byLevel, hRerun);
  bump(agg.heuristic.byReasonKey, row.heuristicReasonKey || 'unknown');
  // labels
  if (L.kind === 'U') {
    agg.labels.U.n += 1; bump(agg.labels.U.byLevel, L.U);
    if (L.contaminated) agg.labels.U.contaminated += 1;
    if (L.routingSource === 'user_picked') agg.labels.U.picked += 1;
    else if (L.routingSource === 'user_default') agg.labels.U.default += 1;
    else agg.labels.U.explicit += 1;
    pushUniq(agg.users[`U_${L.U}`], row.userHash);
  } else if (L.kind === 'H') {
    agg.labels.H.n += 1; if (L.hStored) bump(agg.labels.H.byLevel, L.hStored);
    if (L.liveSource === 'decision') agg.labels.H.liveDecision += 1;
    if (L.liveClamped) agg.labels.H.liveClamped += 1;
    if (L.hStored && L.hStored === hRerun) agg.labels.H.storedVsRerunAgree += 1;
    pushUniq(agg.users.H, row.userHash);
  } else agg.labels.none += 1;
  pushUniq(agg.users.all, row.userHash);
  // gate
  const g = row.gate;
  if (g) {
    agg.gate.calls += 1;
    if (g.error) agg.gate.errors += 1;
    else if (g.nullResult) agg.gate.nullResults += 1;
    else if (g.ok) {
      agg.gate.ok += 1;
      if (g.cached) agg.gate.cached += 1;
      if (g.calibrated) agg.gate.calibrated += 1;
      bump(agg.gate.byBackend, g.backend || 'unknown');
      bump(agg.gate.byMode, g.mode || 'unknown');
    }
    if (Number.isFinite(g.ms)) { agg.gate.latencies.push(g.ms); if (g.ms > ACT_BUDGET_MS) agg.gate.overBudget += 1; }
  }
  const gateRaw = g && g.ok ? g.choice : null;
  const gateAt = g && g.ok ? g.atThreshold : null;
  if (g && g.ok) {
    bump(agg.gate.raw, LEVELS.includes(gateRaw) ? gateRaw : 'none');
    if (gateAt) bump(agg.gate.atThreshold, gateAt);
    if (LEVELS.includes(gateRaw)) {
      agg.gate.coverage.n += 1; agg.gate.coverage.byOption[gateRaw].n += 1;
      if (g.covered) { agg.gate.coverage.covered += 1; agg.gate.coverage.byOption[gateRaw].covered += 1; }
    }
    if (L.kind === 'H' && L.hStored && L.hStored === gateAt) agg.labels.H.storedVsReplayGateAtAgree += 1;
  }
  // confusion pairs
  const push = (key, a, b) => { agg.confusion[key] = mergeConfusion(agg.confusion[key], confusionMatrix([[a, b]])); };
  if (L.kind === 'U') {
    push('U_x_H', L.U, hRerun);
    if (g && g.ok) { push('U_x_gateAt', L.U, gateAt); push('U_x_gateRaw', L.U, gateRaw); }
  }
  if (L.kind === 'H') {
    push('Hstored_x_Hrerun', L.hStored, hRerun);
    if (g && g.ok) { push('H_x_gateAt', L.hStored, gateAt); push('H_x_gateRaw', L.hStored, gateRaw); }
  }
  if (g && g.ok) push('Hrerun_x_gateAt', hRerun, gateAt);
  // calibration (top-label conf vs agreement with the label; Brier from the probability vector)
  if (g && g.ok && Number.isFinite(g.confidence) && LEVELS.includes(gateRaw)) {
    if (L.kind === 'U') { addEceSample(agg.calibration.eceBinsU, g.confidence, gateRaw === L.U); addBrierSample(agg.calibration.brierU, g.probabilities, L.U); }
    if (L.kind === 'H' && L.hStored) { addEceSample(agg.calibration.eceBinsH, g.confidence, gateRaw === L.hStored); addBrierSample(agg.calibration.brierH, g.probabilities, L.hStored); }
  }
  // escalation + non-inferiority (U rows with a gate answer)
  const tally = row.userHash ? (agg.perUser[row.userHash] = agg.perUser[row.userHash] || { n: 0, uN: 0, gA: 0, hA: 0, b: 0, c: 0, uL1: 0, uL1gL3: 0, uL3: 0, uL3gL1: 0, uL3gL3: 0, uL3nd: 0, uL3ndG3: 0 }) : null;
  if (tally) tally.n += 1;
  if (L.kind === 'U' && g && g.ok && gateAt) {
    const gA = gateAt === L.U, hA = hRerun === L.U;
    agg.nonInf.n += 1; if (gA) agg.nonInf.gateAgree += 1; if (hA) agg.nonInf.heurAgree += 1;
    if (gA && !hA) agg.nonInf.b += 1; if (hA && !gA) agg.nonInf.c += 1;
    if (tally) { tally.uN += 1; if (gA) tally.gA += 1; if (hA) tally.hA += 1; if (gA && !hA) tally.b += 1; if (hA && !gA) tally.c += 1; }
    if (L.U === 'single_thinking') { agg.escalation.uL1 += 1; if (tally) tally.uL1 += 1; if (gateAt === 'deep_research') { agg.escalation.uL1gL3 += 1; if (tally) tally.uL1gL3 += 1; } }
    if (L.U === 'deep_research') {
      agg.escalation.uL3 += 1; if (tally) tally.uL3 += 1;
      if (gateAt === 'single_thinking') { agg.escalation.uL3gL1 += 1; if (tally) tally.uL3gL1 += 1; }
      if (gateAt === 'deep_research') { agg.escalation.uL3gL3 += 1; if (tally) tally.uL3gL3 += 1; }
      if (!row.thumbsDown) { agg.escalation.uL3noDown += 1; if (tally) tally.uL3nd += 1; if (gateAt === 'deep_research') { agg.escalation.uL3noDownGL3 += 1; if (tally) tally.uL3ndG3 += 1; } }
    }
  }
  // T
  if (Number.isFinite(row.tMs)) {
    if (L.kind === 'U') { agg.tMs.byU[L.U].push(row.tMs); if (L.U === 'single_thinking' && gateAt) agg.tMs.formerL1.push([gateAt, row.tMs]); }
    if (L.kind === 'H' && L.hStored) agg.tMs.byH[L.hStored].push(row.tMs);
    if (gateAt) agg.tMs.byGateAt[gateAt].push(row.tMs);
  }
  // $
  agg.spend.assistantRows += 1;
  if (row.spend) {
    agg.spend.joined += 1; if (row.spend.estimated) agg.spend.estimated += 1;
    if (L.kind === 'U') agg.spend.byU[L.U].push(row.spend.usd);
    if (L.kind === 'H' && L.hStored) agg.spend.byH[L.hStored].push(row.spend.usd);
  }
  // F
  if (row.feedback) {
    const target = L.kind === 'U' ? agg.feedback.byU : L.kind === 'H' ? agg.feedback.byH : null;
    const lvl = L.kind === 'U' ? L.U : L.hStored;
    if (target && lvl) { target[lvl] = target[lvl] || { rows: 0, thumbs_down: 0, thumbs_up: 0, report: 0 }; target[lvl].rows += 1; for (const k of Object.keys(row.feedback)) bump(target[lvl], k, row.feedback[k]); }
    if (row.thumbsDown) agg.feedback.rowsWithDown += 1;
  }
  // W
  if (row.search && Number.isFinite(row.search.webToolCalls)) {
    agg.search.joined += 1;
    if (L.kind === 'U') { agg.search.byU[L.U].n += 1; if (row.search.webToolCalls === 0) agg.search.byU[L.U].zero += 1; }
    if (gateAt) { agg.search.byGateAt[gateAt].n += 1; if (row.search.webToolCalls === 0) agg.search.byGateAt[gateAt].zero += 1; }
  }
  // shift
  agg.shift.n += 1; if (row.shift.researchIntent) agg.shift.researchIntent += 1; if (row.shift.simpleOpener) agg.shift.simpleOpener += 1;
  if (L.kind === 'U') { const s = agg.shift.byU[L.U]; s.n += 1; if (row.shift.researchIntent) s.ri += 1; if (row.shift.simpleOpener) s.so += 1; }
}

function mergeLevelCounts(x, y) { const o = { ...x }; for (const k of Object.keys(y || {})) o[k] = (o[k] || 0) + y[k]; return o; }
function mergeSamples(x, y) { const o = {}; for (const k of uniq([...Object.keys(x || {}), ...Object.keys(y || {})])) o[k] = [...(x?.[k] || []), ...(y?.[k] || [])]; return o; }
function mergeNZ(x, y) { const o = {}; for (const k of uniq([...Object.keys(x || {}), ...Object.keys(y || {})])) o[k] = { n: (x?.[k]?.n || 0) + (y?.[k]?.n || 0), zero: (x?.[k]?.zero || 0) + (y?.[k]?.zero || 0) }; return o; }
function mergeFeedbackMap(x, y) {
  const o = {};
  for (const k of uniq([...Object.keys(x || {}), ...Object.keys(y || {})])) { o[k] = { ...(x?.[k] || {}) }; for (const f of Object.keys(y?.[k] || {})) o[k][f] = (o[k][f] || 0) + y[k][f]; }
  return o;
}

/** Fold aggregate `y` into `x` (both from newAgg/addRow); returns a new object. */
function mergeAgg(x, y) {
  if (!x) return y; if (!y) return x;
  const out = newAgg({ runId: x.runId || y.runId, spec: x.spec || y.spec, window: x.window || y.window, thresholds: x.thresholds || y.thresholds, decisionMode: x.decisionMode || y.decisionMode, shiftSource: x.shiftSource || y.shiftSource });
  out.batchIndex = Math.max(x.batchIndex ?? 0, y.batchIndex ?? 0);
  out.batches = (x.batches || 1) + (y.batches || 1);
  out.gateUnavailable = x.gateUnavailable || y.gateUnavailable || null;
  out.rowsScanned = x.rowsScanned + y.rowsScanned; out.rowsScored = x.rowsScored + y.rowsScored;
  out.skipped = mergeLevelCounts(x.skipped, y.skipped);
  out.createdAt = { min: [x.createdAt.min, y.createdAt.min].filter(Boolean).sort()[0] || null, max: [x.createdAt.max, y.createdAt.max].filter(Boolean).sort().pop() || null };
  out.segments = mergeLevelCounts(x.segments, y.segments);
  out.labels = {
    U: { n: x.labels.U.n + y.labels.U.n, contaminated: x.labels.U.contaminated + y.labels.U.contaminated, picked: x.labels.U.picked + y.labels.U.picked, default: x.labels.U.default + y.labels.U.default, explicit: x.labels.U.explicit + y.labels.U.explicit, byLevel: mergeLevelCounts(x.labels.U.byLevel, y.labels.U.byLevel) },
    H: { n: x.labels.H.n + y.labels.H.n, byLevel: mergeLevelCounts(x.labels.H.byLevel, y.labels.H.byLevel), liveDecision: x.labels.H.liveDecision + y.labels.H.liveDecision, liveClamped: x.labels.H.liveClamped + y.labels.H.liveClamped, storedVsRerunAgree: x.labels.H.storedVsRerunAgree + y.labels.H.storedVsRerunAgree, storedVsReplayGateAtAgree: x.labels.H.storedVsReplayGateAtAgree + y.labels.H.storedVsReplayGateAtAgree },
    none: x.labels.none + y.labels.none,
  };
  out.heuristic = { byLevel: mergeLevelCounts(x.heuristic.byLevel, y.heuristic.byLevel), byReasonKey: mergeLevelCounts(x.heuristic.byReasonKey, y.heuristic.byReasonKey) };
  out.gate = {
    calls: x.gate.calls + y.gate.calls, ok: x.gate.ok + y.gate.ok, nullResults: x.gate.nullResults + y.gate.nullResults, errors: x.gate.errors + y.gate.errors, cached: x.gate.cached + y.gate.cached, calibrated: x.gate.calibrated + y.gate.calibrated,
    byBackend: mergeLevelCounts(x.gate.byBackend, y.gate.byBackend), byMode: mergeLevelCounts(x.gate.byMode, y.gate.byMode),
    latencies: [...x.gate.latencies, ...y.gate.latencies], overBudget: x.gate.overBudget + y.gate.overBudget,
    raw: mergeLevelCounts(x.gate.raw, y.gate.raw), atThreshold: mergeLevelCounts(x.gate.atThreshold, y.gate.atThreshold),
    coverage: { n: x.gate.coverage.n + y.gate.coverage.n, covered: x.gate.coverage.covered + y.gate.coverage.covered, byOption: {} },
  };
  for (const k of LEVELS) out.gate.coverage.byOption[k] = { n: x.gate.coverage.byOption[k].n + y.gate.coverage.byOption[k].n, covered: x.gate.coverage.byOption[k].covered + y.gate.coverage.byOption[k].covered };
  for (const k of Object.keys(out.confusion)) out.confusion[k] = mergeConfusion(x.confusion[k], y.confusion[k]);
  out.calibration = { eceBinsU: mergeEceBins(x.calibration.eceBinsU, y.calibration.eceBinsU), eceBinsH: mergeEceBins(x.calibration.eceBinsH, y.calibration.eceBinsH), brierU: mergeBrier(x.calibration.brierU, y.calibration.brierU), brierH: mergeBrier(x.calibration.brierH, y.calibration.brierH) };
  out.escalation = mergeLevelCounts(x.escalation, y.escalation);
  out.nonInf = mergeLevelCounts(x.nonInf, y.nonInf);
  out.tMs = { byU: mergeSamples(x.tMs.byU, y.tMs.byU), byGateAt: mergeSamples(x.tMs.byGateAt, y.tMs.byGateAt), byH: mergeSamples(x.tMs.byH, y.tMs.byH), formerL1: [...x.tMs.formerL1, ...y.tMs.formerL1] };
  out.spend = { assistantRows: x.spend.assistantRows + y.spend.assistantRows, joined: x.spend.joined + y.spend.joined, estimated: x.spend.estimated + y.spend.estimated, byU: mergeSamples(x.spend.byU, y.spend.byU), byH: mergeSamples(x.spend.byH, y.spend.byH) };
  out.feedback = { byU: mergeFeedbackMap(x.feedback.byU, y.feedback.byU), byH: mergeFeedbackMap(x.feedback.byH, y.feedback.byH), windowJoin: x.feedback.windowJoin || y.feedback.windowJoin, rowsWithDown: x.feedback.rowsWithDown + y.feedback.rowsWithDown };
  out.search = { byU: mergeNZ(x.search.byU, y.search.byU), byGateAt: mergeNZ(x.search.byGateAt, y.search.byGateAt), joined: x.search.joined + y.search.joined };
  out.shift = { n: x.shift.n + y.shift.n, researchIntent: x.shift.researchIntent + y.shift.researchIntent, simpleOpener: x.shift.simpleOpener + y.shift.simpleOpener, byU: {} };
  for (const k of LEVELS) out.shift.byU[k] = { n: x.shift.byU[k].n + y.shift.byU[k].n, ri: x.shift.byU[k].ri + y.shift.byU[k].ri, so: x.shift.byU[k].so + y.shift.byU[k].so };
  out.users = {}; for (const k of Object.keys(x.users)) out.users[k] = uniq([...(x.users[k] || []), ...(y.users[k] || [])]);
  out.perUser = { ...x.perUser };
  for (const [h, t] of Object.entries(y.perUser || {})) { const cur = out.perUser[h] || {}; const m = { ...cur }; for (const k of Object.keys(t)) m[k] = (cur[k] || 0) + t[k]; out.perUser[h] = m; }
  out.aux = x.aux || y.aux;
  out.cursor = y.cursor || x.cursor;
  out.telemetryStubbedRows = (Number(x.telemetryStubbedRows) || 0) + (Number(y.telemetryStubbedRows) || 0);
  return out;
}

// ── Report ───────────────────────────────────────────────────────────────────

const r4 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const pct = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 10);
const stats = (arr) => ({ n: arr.length, p50: r4(quantile(arr, 0.5)), p95: r4(quantile(arr, 0.95)), mean: arr.length ? r4(arr.reduce((s, v) => s + v, 0) / arr.length) : null });
const secs = (arr) => stats(arr.map(v => v / 1000));
const ratio = (num, den) => (den ? num / den : null);

/** The final report from a merged aggregate — aggregates only. */
function buildReport(agg) {
  const gateOk = agg.gate.ok;
  const lat = agg.gate.latencies;
  const cov = agg.gate.coverage;
  const eceU = eceFromBins(agg.calibration.eceBinsU), eceH = eceFromBins(agg.calibration.eceBinsH);
  const brierU = brierFromSums(agg.calibration.brierU), brierH = brierFromSums(agg.calibration.brierH);
  const over = wilson(agg.escalation.uL1gL3, agg.escalation.uL1);
  const under = wilson(agg.escalation.uL3gL1, agg.escalation.uL3);
  const recall = wilson(agg.escalation.uL3gL3, agg.escalation.uL3);
  const recallNoDown = wilson(agg.escalation.uL3noDownGL3, agg.escalation.uL3noDown);
  const nonInf = pairedDiffCI(agg.nonInf.b, agg.nonInf.c, agg.nonInf.n);
  const boot = {
    nonInfDiff: clusterBootstrap(agg.perUser, t => (t.uN ? (t.b - t.c) / t.uN : null), BOOTSTRAP_REPS, 11),
    l3Recall: clusterBootstrap(agg.perUser, t => (t.uL3 ? t.uL3gL3 / t.uL3 : null), BOOTSTRAP_REPS, 12),
    overEscalation: clusterBootstrap(agg.perUser, t => (t.uL1 ? t.uL1gL3 / t.uL1 : null), BOOTSTRAP_REPS, 13),
    underEscalation: clusterBootstrap(agg.perUser, t => (t.uL3 ? t.uL3gL1 / t.uL3 : null), BOOTSTRAP_REPS, 14),
  };
  const scored = agg.rowsScored;
  const heurL3 = ratio(agg.heuristic.byLevel.deep_research, scored);
  const gateAtN = LEVELS.reduce((s, k) => s + (agg.gate.atThreshold[k] || 0), 0);
  const gateAtL3 = ratio(agg.gate.atThreshold.deep_research, gateAtN);
  const gateRawN = LEVELS.reduce((s, k) => s + (agg.gate.raw[k] || 0), 0);
  const gateRawL3 = ratio(agg.gate.raw.deep_research, gateRawN);
  const uL3 = ratio(agg.labels.U.byLevel.deep_research, agg.labels.U.n);
  // T per label
  const tByU = {}, tByH = {}, tByGate = {};
  for (const k of LEVELS) { tByU[k] = secs(agg.tMs.byU[k]); tByH[k] = secs(agg.tMs.byH[k]); tByGate[k] = secs(agg.tMs.byGateAt[k]); }
  // former-L1 cohort: projected completion = median T of the routed level (U-labelled rows), own T when routed L1
  const medU = {}; for (const k of LEVELS) medU[k] = quantile(agg.tMs.byU[k], 0.5);
  const formerL1 = agg.tMs.formerL1;
  const formerL1Pre = quantile(formerL1.map(([, t]) => t), 0.5);
  const formerL1Proj = quantile(formerL1.map(([lvl, t]) => (lvl === 'single_thinking' ? t : (Number.isFinite(medU[lvl]) ? medU[lvl] : t))), 0.5);
  // $ per label + projected mix
  const usdByU = {}, usdByH = {}; for (const k of LEVELS) { usdByU[k] = stats(agg.spend.byU[k]); usdByH[k] = stats(agg.spend.byH[k]); }
  const meanUsd = {}; let spendLevelsOk = true;
  for (const k of LEVELS) { const a = agg.spend.byU[k]; meanUsd[k] = a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; if (a.length < 200) spendLevelsOk = false; }
  const mixOf = (counts, n) => { const o = {}; for (const k of LEVELS) o[k] = n ? (counts[k] || 0) / n : 0; return o; };
  const heurMix = mixOf(agg.heuristic.byLevel, scored), gateMix = mixOf(agg.gate.atThreshold, gateAtN);
  const projUsd = (mix) => (LEVELS.every(k => Number.isFinite(meanUsd[k])) ? LEVELS.reduce((s, k) => s + mix[k] * meanUsd[k], 0) : null);
  const heurUsd = projUsd(heurMix), gateUsd = projUsd(gateMix);
  const usdDelta = heurUsd && gateUsd !== null ? gateUsd / heurUsd - 1 : null;
  // F per label
  const fb = (m) => { const o = {}; for (const k of LEVELS) { const v = m[k] || { rows: 0, thumbs_down: 0, thumbs_up: 0, report: 0 }; o[k] = { rowsWithFeedback: v.rows, thumbs_down: v.thumbs_down || 0, thumbs_up: v.thumbs_up || 0, report: v.report || 0 }; } return o; };
  const fbU = fb(agg.feedback.byU);
  for (const k of LEVELS) fbU[k].thumbsDownRate = pct(ratio(fbU[k].thumbs_down, agg.labels.U.byLevel[k]));
  // W
  const w = (m) => { const o = {}; for (const k of LEVELS) o[k] = { n: m[k]?.n || 0, zeroSearchShare: pct(ratio(m[k]?.zero || 0, m[k]?.n || 0)) }; return o; };
  // users
  const usersPerClass = {}; for (const k of Object.keys(agg.users)) usersPerClass[k] = agg.users[k].length;
  const below20 = LEVELS.filter(k => usersPerClass[`U_${k}`] < 20).map(k => `U_${k}`);

  const report = {
    probe: 'backtest-auto-route', runId: agg.runId, spec: agg.spec, decisionMode: agg.decisionMode, gateUnavailable: agg.gateUnavailable,
    window: agg.window, batches: agg.batches || 1, thresholds: agg.thresholds,
    telemetry: { stubbedRows: Number(agg.telemetryStubbedRows) || 0, note: 'decision_gate / decision_gate_state writes intercepted by the recordLoopMetric stub (live runs: ≥ 1 per decide call); aux.telemetryGuestDecisions.backtestLeakRows must read 0' },
    rows: { scanned: agg.rowsScanned, scored: scored, skipped: agg.skipped, createdAt: agg.createdAt },
    segments: {
      user: agg.segments.user || 0,
      guest: { rows: agg.segments.guest || 0, note: 'guest turns are never persisted as crossmodel_messages rows (Redis 24 h sessions) — see aux.telemetryGuestDecisions (legacy predicate "sessionId" IS NULL)' },
    },
    labels: {
      U: { ...agg.labels.U, share: pct(ratio(agg.labels.U.n, scored)), l3Rate: pct(uL3), caveat: 'U = metadata.mode on rows without routing: the chat\'s stored level at send time (restore-contaminated unless routingSource=user_picked); not the label window\'s user_picked' },
      H: { ...agg.labels.H, share: pct(ratio(agg.labels.H.n, scored)), storedVsRerunAgreeRate: pct(ratio(agg.labels.H.storedVsRerunAgree, agg.labels.H.n)), storedVsReplayGateAtAgreeRate: pct(ratio(agg.labels.H.storedVsReplayGateAtAgree, agg.labels.H.n)) },
      unlabelled: agg.labels.none,
    },
    users: { distinctAll: usersPerClass.all, perClass: usersPerClass, classesBelow20Users: below20 },
    heuristic: { byLevel: agg.heuristic.byLevel, byReasonKey: agg.heuristic.byReasonKey, l3Rate: pct(heurL3) },
    gate: {
      backends: agg.gate.byBackend, modes: agg.gate.byMode, calibratedAnswers: agg.gate.calibrated, cachedAnswers: agg.gate.cached,
      raw: { byLevel: agg.gate.raw, l3Rate: pct(gateRawL3) },
      atThreshold: { byLevel: agg.gate.atThreshold, l3Rate: pct(gateAtL3), l3VsHeuristicRatio: r4(heurL3 ? gateAtL3 / heurL3 : null) },
      coverage: { n: cov.n, covered: cov.covered, rate: pct(ratio(cov.covered, cov.n)), byOption: Object.fromEntries(LEVELS.map(k => [k, { n: cov.byOption[k].n, covered: cov.byOption[k].covered, rate: pct(ratio(cov.byOption[k].covered, cov.byOption[k].n)) }])) },
    },
    confusion: Object.fromEntries(Object.entries(agg.confusion).map(([k, v]) => [k, v ? { n: v.n, agreeRate: pct(v.agreeRate), counts: v.counts } : null])),
    calibration: {
      vsU: { eceTopLabel: r4(eceU.ece), n: eceU.n, bins: eceU.bins.map(b => ({ lo: r4(b.lo), hi: r4(b.hi), n: b.n, meanConf: r4(b.meanConf), empAgree: r4(b.empAgree) })), topBucket: { n: eceU.topBucket.n, empAgree: r4(eceU.topBucket.empAgree) }, secondBucket: { n: eceU.secondBucket.n, empAgree: r4(eceU.secondBucket.empAgree) }, brier: { perOption: Object.fromEntries(LEVELS.map(k => [k, r4(brierU.perOption[k])])), multiclass: r4(brierU.multiclass), n: brierU.n }, note: 'ECE vs U is an UPPER bound (U is noisy)' },
      vsH: { eceTopLabel: r4(eceH.ece), n: eceH.n, brier: { multiclass: r4(brierH.multiclass), n: brierH.n }, note: 'diagnostic — H is the heuristic, not a human label' },
    },
    escalation: {
      overEscalation: { definition: 'gate@τ = L3 where U = L1', k: over.k, n: over.n, rate: pct(over.p), wilson95: [pct(over.lo), pct(over.hi)], clusteredBootstrap95: [pct(boot.overEscalation.lo), pct(boot.overEscalation.hi)] },
      underEscalation: { definition: 'gate@τ = L1 where U = L3', k: under.k, n: under.n, rate: pct(under.p), wilson95: [pct(under.lo), pct(under.hi)], clusteredBootstrap95: [pct(boot.underEscalation.lo), pct(boot.underEscalation.hi)] },
      l3Recall: { definition: 'gate@τ = L3 where U = L3', k: recall.k, n: recall.n, rate: pct(recall.p), wilson95: [pct(recall.lo), pct(recall.hi)], clusteredBootstrap95: [pct(boot.l3Recall.lo), pct(boot.l3Recall.hi)] },
      l3RecallNoThumbsDown: { k: recallNoDown.k, n: recallNoDown.n, rate: pct(recallNoDown.p), wilson95: [pct(recallNoDown.lo), pct(recallNoDown.hi)] },
      l3Rates: { U: pct(uL3), heuristic: pct(heurL3), gateRaw: pct(gateRawL3), gateAtThreshold: pct(gateAtL3) },
    },
    nonInferiority: {
      definition: 'paired (gate@τ − heuristic) agreement with U; Wald paired-difference CI + user-clustered bootstrap',
      n: nonInf.n, gateAgreeRate: pct(ratio(agg.nonInf.gateAgree, agg.nonInf.n)), heuristicAgreeRate: pct(ratio(agg.nonInf.heurAgree, agg.nonInf.n)),
      b_gateRightHeurWrong: nonInf.b, c_heurRightGateWrong: nonInf.c, discordance: pct(nonInf.discordance),
      diffPp: pct(nonInf.diff), lower95Pp: pct(nonInf.lo), upper95Pp: pct(nonInf.hi),
      clusteredBootstrap95Pp: [pct(boot.nonInfDiff.lo), pct(boot.nonInfDiff.hi)], clusteredUsers: boot.nonInfDiff.users,
    },
    latencyT: { unit: 'seconds (metadata.models.digby.time ?? synthesisTime)', byU: tByU, byH: tByH, byGateAtThreshold: tByGate, formerL1Cohort: { n: formerL1.length, preflipP50s: r4(formerL1Pre / 1000), projectedP50s: r4(formerL1Proj / 1000), ratio: r4(formerL1Pre ? formerL1Proj / formerL1Pre : null), note: 'projection: routed L1 keeps its own T; routed L2/L3 takes the median T of U-labelled rows at that level' } },
    spend: {
      join: { assistantRows: agg.spend.assistantRows, joined: agg.spend.joined, rate: pct(ratio(agg.spend.joined, agg.spend.assistantRows)), estimatedFlagged: agg.spend.estimated, rule: 'run_spend (profile chat, triggerKind user/unset) on the same chat within [assistant.createdAt − 60 s, + 30 min], earliest unconsumed; assistant rows carry no runId' },
      usdByU: usdByU, usdByH: usdByH,
      projected: { heuristicMix: Object.fromEntries(LEVELS.map(k => [k, pct(heurMix[k])])), gateMix: Object.fromEntries(LEVELS.map(k => [k, pct(gateMix[k])])), usdPerTurnHeuristic: r4(heurUsd), usdPerTurnGate: r4(gateUsd), deltaPct: pct(usdDelta), spendRowsPerLevelOk: spendLevelsOk },
    },
    feedback: { windowJoin: agg.feedback.windowJoin, byU: fbU, byH: fb(agg.feedback.byH), scoredRowsWithThumbsDown: agg.feedback.rowsWithDown },
    search: { joined: agg.search.joined, byU: w(agg.search.byU), byGateAtThreshold: w(agg.search.byGateAt), note: 'W = chat_search_usage.webToolCalls joined like run_spend; whether the model searched, not whether it needed to' },
    decision: {
      calls: agg.gate.calls, ok: gateOk, nullResults: agg.gate.nullResults, errors: agg.gate.errors,
      errorRate: pct(ratio(agg.gate.errors + agg.gate.nullResults, agg.gate.calls)),
      latencyMs: { n: lat.length, p50: r4(quantile(lat, 0.5)), p95: r4(quantile(lat, 0.95)), overBudget1500: agg.gate.overBudget, overBudgetRate: pct(ratio(agg.gate.overBudget, lat.length)) },
    },
    shift: { source: agg.shiftSource, n: agg.shift.n, researchIntentShare: pct(ratio(agg.shift.researchIntent, agg.shift.n)), simpleOpenerShare: pct(ratio(agg.shift.simpleOpener, agg.shift.n)), byU: Object.fromEntries(LEVELS.map(k => [k, { n: agg.shift.byU[k].n, researchIntentShare: pct(ratio(agg.shift.byU[k].ri, agg.shift.byU[k].n)), simpleOpenerShare: pct(ratio(agg.shift.byU[k].so, agg.shift.byU[k].n)) }])) },
    aux: agg.aux,
  };
  report.verdicts = verdictTable(report, { over, under, recall, recallNoDown, nonInf, eceU, brierU, cov, lat, scored, gateAtN, heurL3, gateAtL3, usdDelta, spendLevelsOk, formerL1, formerL1Pre, formerL1Proj, gateOk, errorsAndNulls: agg.gate.errors + agg.gate.nullResults, calls: agg.gate.calls, overBudget: agg.gate.overBudget, uL1: agg.escalation.uL1, uL3: agg.escalation.uL3, agg });
  report.caveats = [
    'U is the historical chat mode (restore-contaminated) — every U-based verdict is a weak-label estimate, not the §4.6 user_picked bar',
    'gate@τ simulates act: a confident answer routes, an unconfident one falls back to the heuristic (auto-router-gate routeMessageAuto)',
    'the replay scores the SAME state + question builders production uses, with spec pinned — a seat-chain answer in production may come from a different leg',
    'rows older than the window start are never read; run_spend / decision_gate rows are reaped after 30 days (§4.3 retention)',
  ];
  return report;
}

/** The "verdict vs §4.6" table: pass / fail / n/a with the reason and the sample rule. */
function verdictTable(rep, s) {
  const V = [];
  const row = (metric, threshold, observed, n, verdict, reason) => V.push({ metric, threshold, observed, n, verdict, reason });
  const gateOff = !s.gateOk;
  const gateReason = rep.gateUnavailable ? `gate unavailable (${rep.gateUnavailable})` : 'no gate answers';
  row('Telemetry coverage', 'decision rows ÷ routed sends ≥ 95%; decision↔outcome join ≥ 90%', null, null, 'n/a', 'needs live decision_gate rows vs routed sends (AR0926 query 1); a replay writes no rows');
  if (gateOff) row('Decision error rate', '≤ 2% on ≥ 2,000 decision rows', null, s.calls, 'n/a', gateReason);
  else row('Decision error rate', '≤ 2% on ≥ 2,000 decision rows', pct(ratio(s.errorsAndNulls, s.calls)), s.calls, s.calls >= 2000 ? (s.errorsAndNulls / s.calls <= 0.02 ? 'pass' : 'fail') : 'n/a', s.calls >= 2000 ? 'replay decision calls (errors + null results)' : `needs ≥ 2,000 decision rows (have ${s.calls})`);
  if (gateOff) row('Decision latency p95', `≤ ${P95_BAR_MS} ms; over ${ACT_BUDGET_MS} ms ≤ 2%`, null, s.lat.length, 'n/a', gateReason);
  else {
    const p95 = quantile(s.lat, 0.95), overRate = ratio(s.overBudget, s.lat.length);
    row('Decision latency p95', `≤ ${P95_BAR_MS} ms; over ${ACT_BUDGET_MS} ms ≤ 2%`, { p95Ms: r4(p95), overBudgetPct: pct(overRate) }, s.lat.length, s.lat.length >= 2000 ? (p95 <= P95_BAR_MS && overRate <= 0.02 ? 'pass' : 'fail') : 'n/a', s.lat.length >= 2000 ? `measured with a ${DECIDE_TIMEOUT_MS} ms bound, spec pinned` : `needs ≥ 2,000 decision rows (have ${s.lat.length})`);
  }
  if (gateOff) row('Coverage at threshold', '≥ 60% on ≥ 2,000 outcome rows', null, s.cov.n, 'n/a', gateReason);
  else row('Coverage at threshold', '≥ 60% on ≥ 2,000 outcome rows', pct(ratio(s.cov.covered, s.cov.n)), s.cov.n, s.cov.n >= 2000 ? (s.cov.covered / s.cov.n >= 0.6 ? 'pass' : 'fail') : 'n/a', s.cov.n >= 2000 ? 'gate answers with confidence ≥ τ (0.7 / 0.85 deep_research)' : `needs ≥ 2,000 rows (have ${s.cov.n})`);
  row('Agreement with heuristic', 'diagnostic only — 3×3 H × gate matrix', rep.confusion.Hrerun_x_gateAt ? { n: rep.confusion.Hrerun_x_gateAt.n, agreeRate: rep.confusion.Hrerun_x_gateAt.agreeRate } : null, rep.confusion.Hrerun_x_gateAt?.n ?? 0, 'diagnostic', 'no floor by design (see confusion.Hrerun_x_gateAt)');
  {
    const n = s.nonInf.n, lo = s.nonInf.lo;
    const weak = ' (U = historical chat mode, not user_picked — weak label)';
    if (gateOff || !n) row('Non-inferiority vs heuristic on U', '95% LB > −2 pp on ≥ 3,000 paired rows (−5 pp on ≥ 1,000)', null, n, 'n/a', gateOff ? gateReason : 'no paired U rows');
    else if (n >= 3000) row('Non-inferiority vs heuristic on U', '95% LB > −2 pp on ≥ 3,000 paired rows', { diffPp: pct(s.nonInf.diff), lower95Pp: pct(lo) }, n, lo > -0.02 ? 'pass' : 'fail', 'Wald paired CI' + weak);
    else if (n >= 1000) row('Non-inferiority vs heuristic on U', '95% LB > −5 pp on ≥ 1,000 paired rows (widened margin)', { diffPp: pct(s.nonInf.diff), lower95Pp: pct(lo) }, n, lo > -0.05 ? 'pass' : 'fail', 'widened margin — state why in memory-bank' + weak);
    else row('Non-inferiority vs heuristic on U', '95% LB > −2 pp on ≥ 3,000 paired rows (−5 pp on ≥ 1,000)', { diffPp: pct(s.nonInf.diff), lower95Pp: pct(lo) }, n, 'n/a', `needs ≥ 1,000 paired U rows (have ${n})` + weak);
  }
  const wilsonRow = (metric, threshold, w, minN, cmp, label) => {
    if (gateOff) return row(metric, threshold, null, w.n, 'n/a', gateReason);
    if (w.n < minN) return row(metric, threshold, { rate: pct(w.p), lo: pct(w.lo), hi: pct(w.hi) }, w.n, 'n/a', `needs ≥ ${minN} ${label} (have ${w.n}); weak U`);
    row(metric, threshold, { rate: pct(w.p), lo: pct(w.lo), hi: pct(w.hi) }, w.n, cmp(w) ? 'pass' : 'fail', 'Wilson 95% on weak U (historical chat mode)');
  };
  wilsonRow('L3 recall', 'Wilson LB ≥ 0.70 on ≥ 300 picked-L3 rows (no thumbs-down)', s.recallNoDown, 300, w => w.lo >= 0.7, 'U=L3 rows without thumbs-down');
  wilsonRow('Over-escalation (gate L3 where U = L1)', 'Wilson UB ≤ 5% on ≥ 300 picked-L1 rows', s.over, 300, w => w.hi <= 0.05, 'U=L1 rows');
  wilsonRow('Under-escalation (gate L1 where U = L3)', 'Wilson UB ≤ 15% on ≥ 300 picked-L3 rows', s.under, 300, w => w.hi <= 0.15, 'U=L3 rows');
  {
    const e = s.eceU, b = s.brierU;
    const enough = e.topBucket.n >= 100 && e.secondBucket.n >= 100;
    if (gateOff) row('Calibration', 'top-label ECE ≤ 0.10 (bins from 1/3); Brier ≤ 0.20; top bucket agreement ≥ 0.90', null, e.n, 'n/a', gateReason);
    else if (!enough) row('Calibration', 'top-label ECE ≤ 0.10; Brier ≤ 0.20; top bucket ≥ 0.90', { eceTopLabel: r4(e.ece), brierMulticlass: r4(b.multiclass), topBucketAgree: r4(e.topBucket.empAgree) }, e.n, 'n/a', `needs ≥ 100 rows in each of the two top buckets (have ${e.topBucket.n} / ${e.secondBucket.n}); ECE vs U is an upper bound`);
    else row('Calibration', 'top-label ECE ≤ 0.10; Brier ≤ 0.20; top bucket ≥ 0.90', { eceTopLabel: r4(e.ece), brierMulticlass: r4(b.multiclass), topBucketAgree: r4(e.topBucket.empAgree) }, e.n, (e.ece <= 0.1 && (b.multiclass === null || b.multiclass <= 0.2) && e.topBucket.empAgree >= 0.9) ? 'pass' : 'fail', 'vs U (upper bound); the owner_rated set decides');
  }
  if (gateOff) row('L3 promotion under act', '≤ 1.5× heuristic L3 rate on the same rows and ≤ 8% absolute (≥ 2,000 rows)', null, s.gateAtN, 'n/a', gateReason);
  else row('L3 promotion under act', '≤ 1.5× heuristic L3 rate on the same rows and ≤ 8% absolute (≥ 2,000 rows)', { heuristicL3Pct: pct(s.heurL3), gateAtL3Pct: pct(s.gateAtL3), ratio: r4(s.heurL3 ? s.gateAtL3 / s.heurL3 : null) }, s.gateAtN, s.gateAtN >= 2000 ? ((s.heurL3 === 0 ? s.gateAtL3 === 0 : s.gateAtL3 <= 1.5 * s.heurL3) && s.gateAtL3 <= 0.08 ? 'pass' : 'fail') : 'n/a', s.gateAtN >= 2000 ? 'simulated from covered rows' : `needs ≥ 2,000 rows (have ${s.gateAtN})`);
  if (gateOff) row('Cost (measured)', 'projected USD/turn delta ≤ +15% vs heuristic mix (≥ 200 run_spend rows per level)', null, rep.spend.join.joined, 'n/a', gateReason);
  else if (s.usdDelta === null || !s.spendLevelsOk) row('Cost (measured)', 'projected USD/turn delta ≤ +15% vs heuristic mix (≥ 200 run_spend rows per level)', { deltaPct: pct(s.usdDelta) }, rep.spend.join.joined, 'n/a', `needs ≥ 200 joined run_spend rows per level (have ${LEVELS.map(k => `${k}:${rep.spend.usdByU[k].n}`).join(', ')})`);
  else row('Cost (measured)', 'projected USD/turn delta ≤ +15% vs heuristic mix', { deltaPct: pct(s.usdDelta) }, rep.spend.join.joined, s.usdDelta <= 0.15 ? 'pass' : 'fail', 'mean $ per U level × predicted mix; council/checker per-day ratios need the post-flip daily counts (n/a here)');
  {
    const n = s.formerL1.length;
    if (gateOff) row('Former-L1 cohort latency', 'routed p50 ≤ 1.5× pre-flip L1 p50 (≥ 300 rows)', null, n, 'n/a', gateReason);
    else if (n < 300 || !s.formerL1Pre) row('Former-L1 cohort latency', 'routed p50 ≤ 1.5× pre-flip L1 p50 (≥ 300 rows)', { preflipP50s: r4(s.formerL1Pre / 1000), projectedP50s: r4(s.formerL1Proj / 1000) }, n, 'n/a', `needs ≥ 300 U=L1 rows with T (have ${n})`);
    else row('Former-L1 cohort latency', 'routed p50 ≤ 1.5× pre-flip L1 p50', { preflipP50s: r4(s.formerL1Pre / 1000), projectedP50s: r4(s.formerL1Proj / 1000), ratio: r4(s.formerL1Proj / s.formerL1Pre) }, n, s.formerL1Proj <= 1.5 * s.formerL1Pre ? 'pass' : 'fail', 'projection from per-level median T of U-labelled rows');
  }
  row('Outcome proxy R (checker revised rate)', 'revised rate on gate-L2 picks the heuristic called L1 ≤ 15% (≥ 200 rows)', null, null, 'n/a', 'needs crosscheck_reconcile / crosscheck_late_reconcile outcome rows joined per turn — not joined by this replay');
  {
    const w3 = rep.search.byGateAtThreshold.deep_research;
    if (gateOff) row('Outcome proxy W (zero-search share on L3 picks)', 'reported (≥ 200 rows)', null, w3.n, 'n/a', gateReason);
    else row('Outcome proxy W (zero-search share on L3 picks)', 'reported (≥ 200 rows)', { zeroSearchSharePct: w3.zeroSearchShare }, w3.n, w3.n >= 200 ? 'reported' : 'n/a', w3.n >= 200 ? 'no threshold — reported' : `needs ≥ 200 gate-L3 rows with a chat_search_usage join (have ${w3.n})`);
  }
  row('Guest segment', 'L3 promotion ≤ 2× signed-in (≥ 300 guest rows)', rep.aux?.telemetryGuestDecisions ?? null, 0, 'n/a', 'guest turns are not persisted as message rows; legacy guest decision rows counted in aux only (meta.segment lands with 1a)');
  row('Post-1b re-check', 'same bounds on owner_rated ≥ 300 or escalation-labelled rows; shift metric reported', { shift: { researchIntentShare: rep.shift.researchIntentShare, simpleOpenerShare: rep.shift.simpleOpenerShare } }, rep.shift.n, 'n/a', 'needs owner_rated / user_escalation rows (post-1b); the shift metric is reported as the pre-1b baseline');
  return V;
}

// ── Runtime wiring (live: /app/dist; dry-run: stubs) ─────────────────────────

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

/** Stub telemetry on the loop-metrics namespace BEFORE the first decide(); abort if the overwrite did not take. */
function stubTelemetry(lm) {
  const counter = { rows: 0 };
  const one = () => { counter.rows += 1; };
  const many = (arr) => { counter.rows += Array.isArray(arr) ? arr.length : 0; };
  // 'use strict' turns an assignment to a non-writable export into a TypeError — catch it and
  // fail with the same message either way (a getter-style re-export would fail the check below).
  try { lm.recordLoopMetric = one; lm.recordLoopMetrics = many; } catch { /* reported below */ }
  if (lm.recordLoopMetric !== one || lm.recordLoopMetrics !== many) throw new Error('telemetry stub did not take (non-writable export) — refusing to run: decide() would write decision_gate rows');
  return counter;
}

function loadLiveRuntime() {
  let prisma, autoRouter, gate, dg, modes, lm, folders;
  try {
    prisma = require(MOD.database).default;
    lm = require(MOD.loopMetrics);
    autoRouter = require(MOD.autoRouter);
    gate = require(MOD.autoRouterGate);
    dg = require(MOD.decisionGate);
    modes = require(MOD.decisionGateModes);
    folders = require(MOD.folderInheritance);
  } catch (err) {
    const e = new Error(`runtime modules unavailable (${err && err.message}) — run inside the backend container via prodq.sh`);
    e.exitCode = 3; throw e;
  }
  if (typeof autoRouter.routeMessageHeuristic !== 'function') throw Object.assign(new Error('auto-router: routeMessageHeuristic not exported'), { exitCode: 3 });
  if (typeof gate.autoRouteState !== 'function' || typeof gate.autoRouteQuestions !== 'function') throw Object.assign(new Error('auto-router-gate: autoRouteState/autoRouteQuestions not exported — cannot reproduce the production question shape'), { exitCode: 3 });
  if (typeof dg.decide !== 'function') throw Object.assign(new Error('decision-gate: decide not exported'), { exitCode: 3 });
  const telemetry = stubTelemetry(lm);
  const shift = shiftPatterns(autoRouter);
  const thresholds = {};
  for (const k of LEVELS) { let t = DEFAULT_THRESHOLDS[k]; try { if (typeof gate.autoRouteThreshold === 'function') t = gate.autoRouteThreshold(k); } catch { /* fallback */ } thresholds[k] = t; }
  const workspaceCache = new Map();
  const hasWorkspace = async (projectId) => {
    if (!projectId) return false;
    if (workspaceCache.has(projectId)) return workspaceCache.get(projectId);
    let v = false;
    try { v = !!(await folders.getNearestWorkspaceFolder(projectId)); } catch { v = false; }
    workspaceCache.set(projectId, v);
    return v;
  };
  return {
    kind: 'live', prisma, telemetry, thresholds, shift, hasWorkspace,
    heuristic: (content, hw) => autoRouter.routeMessageHeuristic({ content, hasWorkspace: hw }),
    decide: (content, hw, spec, sessionId) => dg.decide(gate.autoRouteState({ content, hasWorkspace: hw }), gate.autoRouteQuestions(), { purpose: 'auto_route', timeoutMs: DECIDE_TIMEOUT_MS, sessionId, spec, memo: false }),
    decisionMode: async () => {
      try { if (typeof modes.refreshDecisionModes === 'function') await modes.refreshDecisionModes(); } catch { /* env fallback */ }
      try { return typeof dg.decisionModeWithSource === 'function' ? dg.decisionModeWithSource('auto_route') : { mode: dg.decisionMode('auto_route'), source: 'unknown' }; } catch { return { mode: 'unknown', source: 'unknown' }; }
    },
    disconnect: async () => { try { await prisma.$disconnect(); } catch { /* ignore */ } },
  };
}

/** Prefer the compiled auto-router's exported patterns; fall back to the dated copy. */
function shiftPatterns(autoRouter) {
  const ri = autoRouter && Array.isArray(autoRouter.RESEARCH_INTENT_PATTERNS) ? autoRouter.RESEARCH_INTENT_PATTERNS.map(p => (p && p.re instanceof RegExp ? p.re : p)).filter(p => p instanceof RegExp) : null;
  const so = autoRouter && autoRouter.SIMPLE_OPENER_PATTERN instanceof RegExp ? autoRouter.SIMPLE_OPENER_PATTERN : null;
  if (ri && ri.length && so) return { source: 'compiled', researchIntent: ri, simpleOpener: so };
  return { source: 'probe-copy-2026-09-26', researchIntent: SHIFT_FALLBACK.researchIntent, simpleOpener: SHIFT_FALLBACK.simpleOpener };
}
function shiftHits(shift, content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  return { researchIntent: shift.researchIntent.some(re => re.test(text)), simpleOpener: shift.simpleOpener.test(text) };
}

// ── Data access (tagged SQL so the dry-run stub can dispatch) ────────────────

const SQL = {
  page: `/* q:page */
SELECT m.id, m."chatId", m."createdAt", m.content, m.metadata AS umeta, c."userId", c."projectId",
       a.id AS aid, a.role AS arole, a."createdAt" AS acreated, a.metadata AS ameta
FROM crossmodel_messages m
JOIN crossmodel_chats c ON c.id = m."chatId"
JOIN users u ON u.id = c."userId"
LEFT JOIN LATERAL (
  SELECT x.id, x.role, x."createdAt", x.metadata FROM crossmodel_messages x
  WHERE x."chatId" = m."chatId" AND (x."createdAt", x.id) > (m."createdAt", m.id)
  ORDER BY x."createdAt", x.id LIMIT 1
) a ON true
WHERE m.role = 'user'
  AND c."isSupervisor" = false AND c."isProjectSupervisor" = false AND c."parentChatId" IS NULL
  AND c."updatedAt" >= $1::timestamp AND coalesce(u."isChild", false) = false
  AND m."createdAt" >= $1::timestamp AND m."createdAt" <= $2::timestamp
  AND (m."chatId", m."createdAt") > ($3::text, $4::timestamp)
ORDER BY m."chatId", m."createdAt", m.id
LIMIT $5::int`,
  metrics: `/* q:metrics */
SELECT "sessionId", kind, value, meta->>'mode' AS mode, meta->>'profile' AS profile, meta->>'triggerKind' AS trigger,
       meta->>'estimated' AS estimated, meta->>'webToolCalls' AS web, meta->>'machine' AS machine, "createdAt"
FROM loop_metrics
WHERE kind IN ('run_spend', 'chat_search_usage') AND "sessionId" = ANY($1::text[])
  AND "createdAt" >= $2::timestamp AND "createdAt" <= $3::timestamp
ORDER BY "sessionId", "createdAt"`,
  feedback: `/* q:feedback */
SELECT f."messageId", f."chatId", f.type, f."createdAt",
  CASE WHEN f."messageId" IS NULL THEN (
    SELECT x.id FROM crossmodel_messages x
    WHERE x."chatId" = f."chatId" AND x.role = 'assistant' AND x."createdAt" <= f."createdAt"
    ORDER BY x."createdAt" DESC LIMIT 1) ELSE NULL END AS fallback_id
FROM message_feedback f
WHERE f."chatId" = ANY($1::text[]) AND f."createdAt" >= $2::timestamp`,
  auxFeedback: `/* q:auxFeedback */
SELECT COUNT(*)::int AS n, COUNT("messageId")::int AS with_message_id,
       COUNT(*) FILTER (WHERE type = 'thumbs_down')::int AS thumbs_down
FROM message_feedback WHERE "createdAt" >= $1::timestamp AND "createdAt" <= $2::timestamp`,
  auxGuest: `/* q:auxGuest */
SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE "sessionId" IS NULL)::int AS guest_legacy,
       COUNT(*) FILTER (WHERE meta->>'segment' = 'guest')::int AS guest_segment,
       COUNT(*) FILTER (WHERE "sessionId" LIKE 'backtest:%')::int AS backtest_leak
FROM loop_metrics
WHERE kind = 'decision_gate' AND meta->>'purpose' = 'auto_route' AND meta->>'phase' = 'decision'
  AND "createdAt" >= $1::timestamp AND "createdAt" <= $2::timestamp`,
};

const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const ms = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/** Join run_spend / chat_search_usage rows to assistant rows by chat + time window (§4.2 $ rule, adapted: no runId on assistant rows). */
function joinMetrics(rows, metricRows) {
  const byChat = new Map();
  for (const r of metricRows) {
    const list = byChat.get(r.sessionId) || []; list.push({ ...r, t: ms(r.createdAt), used: false }); byChat.set(r.sessionId, list);
  }
  const out = new Map(); // aid → { spend, search }
  const ordered = [...rows].filter(r => r.aid).sort((a, b) => (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : ms(a.acreated) - ms(b.acreated)));
  for (const r of ordered) {
    const list = byChat.get(r.chatId) || [];
    const t0 = ms(r.acreated);
    const modeOfRow = normalizeLevel(r.ameta && r.ameta.mode);
    const pick = (kind) => {
      for (const m of list) {
        if (m.used || m.kind !== kind) continue;
        if (m.t < t0 - SPEND_JOIN_BEFORE_MS || m.t > t0 + SPEND_JOIN_AFTER_MS) continue;
        if (kind === 'run_spend' && m.profile && m.profile !== 'chat') continue;
        if (kind === 'run_spend' && m.trigger && m.trigger !== 'user') continue;
        if (kind === 'chat_search_usage' && String(m.machine) === 'true') continue;
        const mm = normalizeLevel(m.mode);
        if (mm && modeOfRow && mm !== modeOfRow) continue; // a stamped level that disagrees is another turn
        m.used = true; return m;
      }
      return null;
    };
    const sp = pick('run_spend'), se = pick('chat_search_usage');
    out.set(r.aid, {
      spend: sp && Number.isFinite(Number(sp.value)) ? { usd: Number(sp.value), estimated: String(sp.estimated) === 'true' } : null,
      search: se ? { webToolCalls: Number.isFinite(Number(se.web)) ? Number(se.web) : null } : null,
    });
  }
  return out;
}

/** Map assistant ids → feedback tallies (messageId join, else the plan's latest-assistant-before fallback). */
function joinFeedback(rows, feedbackRows) {
  const aids = new Set(rows.filter(r => r.aid).map(r => r.aid));
  const out = new Map();
  for (const f of feedbackRows) {
    const id = f.messageId || f.fallback_id;
    if (!id || !aids.has(id)) continue;
    const t = out.get(id) || {}; bump(t, f.type || 'unknown'); out.set(id, t);
  }
  return out;
}

// ── One batch ────────────────────────────────────────────────────────────────

async function runBatch(rt, cfg, cursorState) {
  const { runId, spec, batch, salt, window } = cursorState;
  const agg = newAgg({ runId, spec, batchIndex: cursorState.batchIndex, window, thresholds: rt.thresholds, decisionMode: cursorState.decisionMode, shiftSource: rt.shift.source });
  const q = (sql, ...params) => rt.prisma.$queryRawUnsafe(sql, ...params);
  let cursor = cursorState.cursor || { chatId: '', createdAt: '1970-01-01T00:00:00.000Z' };
  let scored = 0;
  let gateDead = 0;
  let done = false;
  if (cursorState.batchIndex === 0) {
    agg.aux = {};
    try { const fb = await q(SQL.auxFeedback, window.from, window.to); const r = fb && fb[0]; if (r) agg.aux.feedbackWindow = { n: Number(r.n), withMessageId: Number(r.with_message_id), thumbsDown: Number(r.thumbs_down), messageIdJoinRate: pct(ratio(Number(r.with_message_id), Number(r.n))) }; } catch (e) { agg.aux.feedbackWindow = { error: String(e.message || e).slice(0, 120) }; }
    try { const g = await q(SQL.auxGuest, window.from, window.to); const r = g && g[0]; if (r) agg.aux.telemetryGuestDecisions = { n: Number(r.n), guestLegacy_sessionIdNull: Number(r.guest_legacy), guestSegment: Number(r.guest_segment), backtestLeakRows: Number(r.backtest_leak) }; } catch (e) { agg.aux.telemetryGuestDecisions = { error: String(e.message || e).slice(0, 120) }; }
    agg.feedback.windowJoin = agg.aux.feedbackWindow || null;
  }
  while (scored < batch && !done) {
    const want = Math.min(batch - scored, batch);
    const rows = await q(SQL.page, window.from, window.to, cursor.chatId, cursor.createdAt, want);
    if (!rows || !rows.length) { done = true; break; }
    agg.rowsScanned += rows.length;
    const last = rows[rows.length - 1];
    cursor = { chatId: String(last.chatId), createdAt: iso(last.createdAt) };
    // eligibility filter first (no egress for skipped rows)
    const eligible = [];
    for (const r of rows) {
      if (!r.aid) { bump(agg.skipped, 'no_next_row'); continue; }
      if (r.arole !== 'assistant') { bump(agg.skipped, 'next_row_not_assistant'); continue; }
      const am = r.ameta && typeof r.ameta === 'object' ? r.ameta : null;
      if (!am || am.engine !== 'agent') { bump(agg.skipped, 'assistant_engine_not_agent'); continue; }
      if (am.origin) { bump(agg.skipped, 'assistant_machine_origin'); continue; }
      const um = r.umeta && typeof r.umeta === 'object' ? r.umeta : null;
      if (um && um.origin) { bump(agg.skipped, 'user_row_machine_origin'); continue; }
      const content = typeof r.content === 'string' ? r.content : '';
      if (!content.trim()) { bump(agg.skipped, 'empty_content'); continue; }
      eligible.push(r);
    }
    if (!eligible.length) { if (rows.length < want) done = true; continue; }
    // side joins for this page (cheap, indexed)
    const chatIds = uniq(eligible.map(r => String(r.chatId)));
    const aTimes = eligible.map(r => ms(r.acreated));
    let metricsMap = new Map(), feedbackMap = new Map();
    try { const mrows = await q(SQL.metrics, chatIds, iso(Math.min(...aTimes) - 2 * SPEND_JOIN_BEFORE_MS), iso(Math.max(...aTimes) + SPEND_JOIN_AFTER_MS + 60_000)); metricsMap = joinMetrics(eligible, mrows || []); } catch (e) { bump(agg.skipped, 'metrics_join_error'); }
    try { const frows = await q(SQL.feedback, chatIds, window.from); feedbackMap = joinFeedback(eligible, frows || []); } catch (e) { bump(agg.skipped, 'feedback_join_error'); }
    for (const r of eligible) {
      if (scored >= batch) break;
      const content = String(r.content);
      const hw = await rt.hasWorkspace(r.projectId || null);
      const h = rt.heuristic(content, hw);
      const label = labelOf(r.ameta);
      const gateOff = cursorState.decisionMode && cursorState.decisionMode.mode === 'off';
      let gate = null;
      if (!gateOff && !agg.gateUnavailable) {
        const t0 = Date.now();
        gate = { ok: false };
        try {
          const res = await rt.decide(content, hw, spec, `backtest:${runId}`);
          const wall = Date.now() - t0;
          if (!res) { gate.nullResult = true; gate.ms = wall; gateDead += 1; }
          else {
            const a = res.answers && res.answers.level;
            gate.ms = Number.isFinite(res.ms) ? res.ms : wall;
            gate.backend = res.backendSpec || res.backend || null; gate.mode = res.mode || null; gate.calibrated = !!res.calibrated; gate.cached = !!res.cached;
            if (a && a.type === 'choice' && typeof a.choice === 'string') {
              gate.ok = true; gateDead = 0;
              gate.choice = a.choice; gate.confidence = Number(a.confidence); gate.probabilities = a.probabilities || null;
              const thr = rt.thresholds[LEVELS.includes(a.choice) ? a.choice : 'thinking'];
              gate.threshold = thr;
              gate.covered = LEVELS.includes(a.choice) && Number.isFinite(gate.confidence) && gate.confidence >= thr;
              gate.atThreshold = gate.covered ? a.choice : h.level;
            } else { gate.error = 'no choice answer'; }
          }
        } catch (err) { gate.error = String(err && err.message || err).slice(0, 80); gate.ms = Date.now() - t0; }
        if (gateDead >= 3) agg.gateUnavailable = 'decide() returned null 3× in a row (purpose off or no servable backend for the spec)';
        const elapsed = Date.now() - t0;
        if (cfg.floorMs > 0 && elapsed < cfg.floorMs) await sleep(cfg.floorMs - elapsed);
      }
      const joined = r.aid ? metricsMap.get(r.aid) : null;
      const fb = r.aid ? feedbackMap.get(r.aid) : null;
      addRow(agg, {
        createdAtIso: iso(r.createdAt), segment: r.userId ? 'user' : 'guest', userHash: hashUser(salt, r.userId),
        label, heuristic: h.level, heuristicReasonKey: h.reasonKey, gate,
        tMs: tValueMs(r.ameta), spend: joined ? joined.spend : null, search: joined ? joined.search : null,
        feedback: fb || null, thumbsDown: !!(fb && fb.thumbs_down), shift: shiftHits(rt.shift, content),
      });
      scored += 1;
    }
    if (rows.length < want) done = true;
  }
  agg.cursor = cursor;
  agg.done = done;
  agg.telemetryStubbedRows = rt.telemetry ? rt.telemetry.rows : null;
  return agg;
}

// ── Cursor / output files ────────────────────────────────────────────────────

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 1)); }

function defaultRunId(spec, days) {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `ar-${d}-${String(spec).replace(/[^a-z0-9._-]/gi, '_')}-${days}d`;
}

function parseArgs(argv) {
  const flags = { dryRun: false, merge: null, runId: null, outDir: null, help: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--merge') { flags.merge = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else if (a === '--run-id') flags.runId = argv[++i];
    else if (a === '--out-dir') flags.outDir = argv[++i];
    else if (a.startsWith('--')) { throw Object.assign(new Error(`unknown flag ${a}`), { exitCode: 2 }); }
    else pos.push(a);
  }
  const days = pos[0] !== undefined ? Number(pos[0]) : DEFAULT_DAYS;
  const spec = pos[1] || DEFAULT_SPEC;
  const batch = pos[2] !== undefined ? Number(pos[2]) : DEFAULT_BATCH;
  const cursorFile = pos[3] || null;
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw Object.assign(new Error('days must be 1..365'), { exitCode: 2 });
  if (!Number.isFinite(batch) || batch <= 0 || batch > 5000) throw Object.assign(new Error('batch must be 1..5000'), { exitCode: 2 });
  return { ...flags, days, spec, batch, cursorFile };
}

const USAGE = `usage: backtest-auto-route.js <days=30> <spec=deepseek-flash> [batch=300] [cursor-file] [--run-id X] [--out-dir D]
       backtest-auto-route.js --merge [runId|path.jsonl] [--out-dir D]
       backtest-auto-route.js --dry-run
Each invocation scores one batch and appends one aggregate line to <out-dir>/<runId>.jsonl; re-run until it prints done:true, then --merge.`;

function mergeLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  let merged = null; let lines = 0;
  for (const line of text.split('\n')) {
    const t = line.trim(); if (!t) continue;
    const obj = JSON.parse(t);
    if (obj.probe !== 'backtest-auto-route') continue;
    merged = mergeAgg(merged, obj); lines += 1;
  }
  if (!merged) throw Object.assign(new Error(`no aggregate lines in ${file}`), { exitCode: 2 });
  merged.batches = lines;
  return merged;
}

/** One invocation on a live runtime (or the dry-run stub): load/extend the cursor, score a batch, append the line. */
async function runOnce(rt, args, opts = {}) {
  const outDir = args.outDir || DEFAULT_OUT_DIR;
  const preliminary = args.cursorFile ? readJson(args.cursorFile) : null;
  const runId = (preliminary && preliminary.runId) || args.runId || process.env.AR_BACKTEST_RUN_ID || defaultRunId(args.spec, args.days);
  const cursorFile = args.cursorFile || path.join(outDir, `${runId}.cursor.json`);
  let state = readJson(cursorFile);
  if (!state) {
    const to = new Date(opts.now || Date.now());
    const from = new Date(to.getTime() - args.days * 86400e3);
    state = { runId, spec: args.spec, days: args.days, batch: args.batch, salt: crypto.randomBytes(16).toString('hex'), window: { from: from.toISOString(), to: to.toISOString(), days: args.days }, batchIndex: 0, cursor: null, done: false, decisionMode: null, startedAt: new Date().toISOString() };
  }
  if (state.done) {
    return { done: true, runId: state.runId, message: `run ${state.runId} is complete — use --merge ${state.runId}` };
  }
  if (!state.decisionMode) state.decisionMode = await rt.decisionMode();
  state.batch = args.batch; // the batch size may change between invocations; the window never does
  const agg = await runBatch(rt, { floorMs: opts.floorMs ?? CALL_FLOOR_MS }, state);
  const jsonl = path.join(outDir, `${state.runId}.jsonl`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(jsonl, JSON.stringify(agg) + '\n');
  state.batchIndex += 1; state.cursor = agg.cursor; state.done = !!agg.done; state.lastBatchAt = new Date().toISOString();
  writeJson(cursorFile, state);
  return {
    done: state.done, runId: state.runId, batchIndex: state.batchIndex, spec: state.spec, decisionMode: state.decisionMode, window: state.window,
    rowsScanned: agg.rowsScanned, rowsScored: agg.rowsScored, skipped: agg.skipped, gateOk: agg.gate.ok, gateErrors: agg.gate.errors + agg.gate.nullResults, gateUnavailable: agg.gateUnavailable,
    telemetryStubbedRows: agg.telemetryStubbedRows, jsonl, cursorFile,
  };
}

// ── Dry run: synthetic corpus + stubbed Prisma + stubbed decide ─────────────

function buildDryRuntime(seed = 7) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const users = Array.from({ length: 14 }, (_, i) => `user-${i}-SYNTHETIC-PRIVATE-MARKER`);
  const chats = Array.from({ length: 40 }, (_, i) => ({ id: `chat-${String(i).padStart(3, '0')}`, userId: users[i % users.length], projectId: i % 5 === 0 ? `proj-${i}` : null }));
  const templates = {
    single_thinking: ['What is the capital of {x}? SYNTHETIC-PRIVATE-MARKER', 'Who wrote {x}? SYNTHETIC-PRIVATE-MARKER', 'How many {x} are there? SYNTHETIC-PRIVATE-MARKER'],
    thinking: ['Explain how {x} works and also why it matters. SYNTHETIC-PRIVATE-MARKER', 'Help me plan {x} for next week, with tradeoffs. SYNTHETIC-PRIVATE-MARKER', 'Draft a reply to {x} in a friendly tone. SYNTHETIC-PRIVATE-MARKER'],
    deep_research: ['Write a comprehensive analysis of {x} with cited sources. SYNTHETIC-PRIVATE-MARKER', 'Do a deep dive on the latest research about {x}. SYNTHETIC-PRIVATE-MARKER', 'Market analysis of {x}: compare and contrast the leaders. SYNTHETIC-PRIVATE-MARKER'],
  };
  const base = Date.parse('2026-09-01T00:00:00.000Z');
  const rows = []; const metrics = []; const feedback = [];
  let n = 0;
  for (const c of chats) {
    let t = base + Math.floor(rnd() * 20) * 86400e3;
    const turns = 4 + Math.floor(rnd() * 6);
    for (let i = 0; i < turns; i++) {
      t += 60e3 + Math.floor(rnd() * 3600e3);
      const intended = rnd() < 0.25 ? 'single_thinking' : rnd() < 0.9 ? 'thinking' : 'deep_research';
      const content = pick(templates[intended]).replace('{x}', `topic-${n}`);
      const stored = rnd() < 0.85 ? intended : pick(LEVELS); // the chat's stored mode, with restore noise
      const routed = rnd() < 0.3; // Auto-routed rows carry routing
      const tMs = (stored === 'single_thinking' ? 60e3 : stored === 'thinking' ? 240e3 : 900e3) * (0.6 + rnd());
      const aCreated = t + tMs;
      const machine = rnd() < 0.08;
      const uid = `u-${n}`, aid = `a-${n}`;
      const ameta = { engine: 'agent', mode: stored, synthesisTime: tMs, models: { digby: { time: tMs } }, ...(routed ? { routing: { level: stored, source: rnd() < 0.5 ? 'decision' : 'heuristic', reason: 'x' }, routingSource: 'auto_heuristic' } : {}), ...(machine ? { origin: 'schedule' } : {}), ...(rnd() < 0.1 ? { routingSource: 'user_picked' } : {}) };
      rows.push({ id: uid, chatId: c.id, createdAt: new Date(t), content, umeta: machine ? { origin: 'schedule' } : null, userId: c.userId, projectId: c.projectId, aid, arole: 'assistant', acreated: new Date(aCreated), ameta });
      if (rnd() < 0.7) metrics.push({ sessionId: c.id, kind: 'run_spend', value: (stored === 'single_thinking' ? 0.08 : stored === 'thinking' ? 0.18 : 0.5) * (0.5 + rnd()), mode: stored, profile: 'chat', trigger: 'user', estimated: rnd() < 0.2 ? 'true' : 'false', web: null, machine: null, createdAt: new Date(aCreated + 5e3) });
      if (rnd() < 0.6) metrics.push({ sessionId: c.id, kind: 'chat_search_usage', value: null, mode: stored, profile: 'chat', trigger: 'user', estimated: null, web: String(rnd() < 0.4 ? 0 : 2), machine: 'false', createdAt: new Date(aCreated + 1e3) });
      if (rnd() < 0.08) feedback.push({ messageId: rnd() < 0.7 ? aid : null, chatId: c.id, type: rnd() < 0.7 ? 'thumbs_down' : 'thumbs_up', createdAt: new Date(aCreated + 30e3), fallback_id: aid });
      n += 1;
    }
  }
  rows.sort((a, b) => (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : a.createdAt - b.createdAt));
  const prisma = {
    async $queryRawUnsafe(sql, ...p) {
      if (sql.startsWith('/* q:page */')) {
        const [from, to, curChat, curTs, limit] = p;
        return rows.filter(r => r.createdAt >= new Date(from) && r.createdAt <= new Date(to) && (r.chatId > curChat || (r.chatId === curChat && r.createdAt > new Date(curTs)))).slice(0, limit);
      }
      if (sql.startsWith('/* q:metrics */')) { const [ids, from, to] = p; return metrics.filter(m => ids.includes(m.sessionId) && m.createdAt >= new Date(from) && m.createdAt <= new Date(to)); }
      if (sql.startsWith('/* q:feedback */')) { const [ids] = p; return feedback.filter(f => ids.includes(f.chatId)); }
      if (sql.startsWith('/* q:auxFeedback */')) return [{ n: feedback.length, with_message_id: feedback.filter(f => f.messageId).length, thumbs_down: feedback.filter(f => f.type === 'thumbs_down').length }];
      if (sql.startsWith('/* q:auxGuest */')) return [{ n: 120, guest_legacy: 9, guest_segment: 0, backtest_leak: 0 }];
      throw new Error('dry-run stub: unknown query');
    },
    async $disconnect() { /* stub */ },
  };
  const heuristic = (content) => {
    const text = String(content).replace(/\s+/g, ' ').trim();
    if (SHIFT_FALLBACK.researchIntent.some(re => re.test(text))) return { level: 'deep_research', reasonKey: 'research_requested' };
    if (text.length <= 160 && SHIFT_FALLBACK.simpleOpener.test(text) && !/\b(and also|as well as|compare)\b/i.test(text) && (text.match(/\?/g) || []).length <= 1) return { level: 'single_thinking', reasonKey: 'simple_lookup' };
    return { level: 'thinking', reasonKey: 'default_ensemble' };
  };
  const decideRnd = mulberry32(seed + 1);
  const decide = async (content) => {
    const h = heuristic(content).level;
    const choice = decideRnd() < 0.82 ? h : LEVELS[Math.floor(decideRnd() * 3)];
    const conf = 0.45 + decideRnd() * 0.55;
    const rest = (1 - conf) / 2;
    const probabilities = {}; for (const k of LEVELS) probabilities[k] = k === choice ? conf : rest;
    if (decideRnd() < 0.01) return null;
    return { id: 'dry', answers: { level: { type: 'choice', choice, probabilities, confidence: conf } }, backend: 'dry-run stub', backendSpec: 'stub', ms: Math.round(80 + decideRnd() * 400), mode: 'act', calibrated: true };
  };
  const telemetry = { rows: 0 };
  return {
    kind: 'dry', prisma, telemetry, thresholds: DEFAULT_THRESHOLDS, shift: { source: 'probe-copy-2026-09-26', researchIntent: SHIFT_FALLBACK.researchIntent, simpleOpener: SHIFT_FALLBACK.simpleOpener },
    hasWorkspace: async (projectId) => !!projectId, heuristic, decide,
    decisionMode: async () => ({ mode: 'act', source: 'dry-run' }), disconnect: async () => {},
    corpusSize: rows.length, now: base + 25 * 86400e3,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const print = (obj) => console.log(JSON.stringify(obj, BIG, 1));

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (args.dryRun) {
    const rt = buildDryRuntime();
    const outDir = args.outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ar-backtest-dry-'));
    const dryArgs = { ...args, outDir, days: 30, batch: Math.min(args.batch, 100), runId: 'dry-run', cursorFile: null };
    const batches = [];
    for (let i = 0; i < 50; i++) {
      const r = await runOnce(rt, dryArgs, { floorMs: 0, now: rt.now });
      batches.push({ batchIndex: r.batchIndex, rowsScanned: r.rowsScanned, rowsScored: r.rowsScored, done: r.done });
      if (r.done) break;
    }
    const merged = mergeLines(path.join(outDir, 'dry-run.jsonl'));
    const report = buildReport(merged);
    report.dryRun = { corpusRows: rt.corpusSize, batches, outDir };
    print(report);
    if (!args.outDir) fs.rmSync(outDir, { recursive: true, force: true });
    return 0;
  }
  if (args.merge) {
    const outDir = args.outDir || DEFAULT_OUT_DIR;
    let file;
    if (args.merge === true) file = path.join(outDir, `${args.runId || process.env.AR_BACKTEST_RUN_ID || defaultRunId(args.spec, args.days)}.jsonl`);
    else if (String(args.merge).endsWith('.jsonl') || String(args.merge).includes('/')) file = String(args.merge);
    else file = path.join(outDir, `${args.merge}.jsonl`);
    const merged = mergeLines(file);
    const report = buildReport(merged);
    report.source = { file, batches: merged.batches };
    print(report);
    return 0;
  }
  const rt = loadLiveRuntime();
  try {
    const r = await runOnce(rt, args);
    print(r);
  } finally {
    await rt.disconnect();
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(err => { console.error('PROBE_FAIL', String(err && err.message || err).slice(0, 300)); process.exit(err && err.exitCode ? err.exitCode : 1); });
}

module.exports = {
  LEVELS, DEFAULT_THRESHOLDS, ACT_BUDGET_MS, P95_BAR_MS, ECE_BIN_FROM, ECE_BINS,
  wilson, confusionMatrix, mergeConfusion, eceBinIndex, newEceBins, addEceSample, mergeEceBins, eceFromBins, eceTopLabel,
  newBrier, addBrierSample, mergeBrier, brierFromSums, pairedDiffCI, quantile, mulberry32, clusterBootstrap,
  normalizeLevel, labelOf, tValueMs, hashUser, newAgg, addRow, mergeAgg, buildReport, verdictTable,
  joinMetrics, joinFeedback, shiftPatterns, shiftHits, stubTelemetry, parseArgs, buildDryRuntime, runOnce, mergeLines, SQL,
};

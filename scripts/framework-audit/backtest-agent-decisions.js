#!/usr/bin/env node
/**
 * backtest-agent-decisions.js — the AGENT-DECISIONS replay (one-shot `AD0927-REPLAY`):
 * re-scores the last <days> of HISTORICAL decision points for two candidate
 * decision-gate purposes through decide() with a pinned spec, and reports whether
 * a calibrated decision model would have found the act band the candidates claim.
 *
 *   supervisor_turn_noop  — at fireScheduleTarget for the schedule-sweep and agent-
 *                           drain origins (hook wakes stay under wake_triage): will
 *                           this supervisor turn take a recorded ACTION or close as a
 *                           WAKE|SWEEP no-op? Label = classifySupervisorNote on the
 *                           turn's final (the supervisor_noop / supervisor_action /
 *                           supervisor_note loop_metrics rows the attention watchdog
 *                           writes — actual = kind !== 'supervisor_noop').
 *   audit_round_skip      — at the agent.ts self-audit site: per completed plan step,
 *                           does this run's receipt ledger evidence it, and would a
 *                           fresh audit reopen anything? Label = the plan after the
 *                           audit round vs the completed set at the grant
 *                           (selfAuditReopened semantics), rebuilt from agent_events.
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs it from
 * /app), so `/app/dist/...` is the compiled backend:
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh /tmp/backtest-agent-decisions.js <days> <spec> [batch] [--cap N] [--candidate K]
 *
 * READ-ONLY on the database. The ONLY side effect is egress: one decision-gate call
 * per scored row to the backend named by <spec> ('jev' | 'deepseek-flash' | a registry
 * spec). Neither candidate is a registered DecisionPurpose, so every ask goes out
 * under purpose 'probe' (always act, never memoised, never a challenger, never a
 * state sample, never an alert — decisionModeWithSource / stateSampleRate /
 * raiseBackendDownAlert all special-case 'probe'; verified 2026-09-27) with the
 * candidate's OWN typed questions and `meta.probeCandidate` naming it. Telemetry is
 * STUBBED exactly like backtest-auto-route.js: recordLoopMetric / recordLoopMetrics
 * are overwritten on the loop-metrics.service CJS namespace BEFORE the first decide()
 * and every ask is tagged sessionId `backtest:<runId>`. A row that reached the DB
 * would show as loop_metrics."sessionId" LIKE 'backtest:%' — the aux query counts
 * them (expect 0).
 *
 * State is rebuilt from the rows the feasibility miner named — never from the
 * lane-authored prose of the turn itself:
 *   turn_noop  hook_events.payload (pending inputs ≤ 8, ages bucketed), agent_runs
 *              lane facts as of the turn start, supervisor_noop/action/note rows for
 *              the per-target 7-day features, the previous 3 machine notes' heads,
 *              board counts over the target's scope (owner / project) in the window
 *              since the previous turn; for the drain origin the queued agent bodies
 *              come from the coalesced user row (pending_chat_messages rows are gone).
 *   audit      agent_events for the run: plan_update before / after the grant marker
 *              ('Auto-audit:' progress event), tool_call + tool_result pairs → the
 *              compiled extractReceipt + receiptHeads (the in-memory receipt shape
 *              the gate sees — run_tool_receipts keeps sha256 only), the text deltas
 *              before the grant as the final under review, the last verify_result,
 *              the self_audit_run row's turns / cost stamps; the shed $ joins the run's finalize run_spend row by
 *              loop_metrics.runId OR meta.selfAuditDecisionId (prod 2026-09-27: the coding-run spend row carries the E5
 *              stamp in meta, its runId column did not match — the first live run joined 0 rows until this was widened).
 *
 * Output: each invocation scores ≤ <batch> rows PER CANDIDATE (default 200, at most
 * --cap rows per candidate over the whole run, default 400), serially, ≥ 200 ms apart,
 * appends ONE JSON line of mergeable aggregates per candidate to
 * $AD_BACKTEST_DIR/<runId>.jsonl (default /var/tmp/ad-backtest — INSIDE the container:
 * docker cp it out before a deploy flips the colour) and advances the cursor file;
 * `--merge [runId|path]` folds the lines into the final report. The per-row tuples the
 * lines carry are NUMERIC (label, probabilities, flags, $, minutes) — never a message,
 * never a user id, never a chat id (chat ids are salted-hashed to 8 hex; the salt lives
 * in the cursor file). `--dry-run` proves the arithmetic and the batch / cursor / merge
 * plumbing locally on synthetic rows with a stubbed Prisma client and a stubbed
 * decide() — no /app/dist, no network.
 *
 * Exit codes: 0 ok; 2 usage; 3 runtime modules unavailable; 1 unexpected failure.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ── Constants ────────────────────────────────────────────────────────────────

const CANDIDATES = ['supervisor_turn_noop', 'audit_round_skip'];
const DEFAULT_DAYS = 14;
const DEFAULT_SPEC = 'jev';
const DEFAULT_BATCH = 200;
const DEFAULT_CAP = 400;
const CALL_FLOOR_MS = 200;
const DECIDE_TIMEOUT_MS = 8000;
const DEFAULT_OUT_DIR = process.env.AD_BACKTEST_DIR || '/var/tmp/ad-backtest';
const LATEST_POINTER = 'agent-decisions.latest';

/** supervisor_turn_noop act rule: will_act ≤ 1 − τ (τ 0.85 — DECISION_GATE_THRESHOLD_SUPERVISOR_TURN_NOOP), no new input, no alarm. */
const TURN_NOOP_TAU = 0.85;
/** audit_round_skip act rule: any_reopen ≤ REOPEN_BAR AND min_k(step_k_receipted) ≥ STEP_TAU. */
const AUDIT_REOPEN_BAR = 0.10;
const AUDIT_STEP_TAU = 0.85;
const AUDIT_STEP_CAP = 12;
/** Deterministic has_new_input: share of the pending inputs' trigrams absent from the last 3 notes. */
const NEW_INPUT_SHARE_MIN = 0.5;
const PENDING_ROWS_MAX = 8;
const PENDING_SUMMARY_CHARS = 300;
const NOTE_HEAD_CHARS = 160;
const PREV_NOTES = 3;
const WINDOW_CAP_MS = 24 * 60 * 60 * 1000;
const TARGET_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
const SPEND_JOIN_BEFORE_MS = 60_000;
const SPEND_JOIN_AFTER_MS = 30 * 60_000;
/** The average $ of a supervisor machine turn when the run_spend join misses (prod 14 d, run_spend triggerKind=machine profile=chat, n=8,977: mean 0.2363). */
const FALLBACK_TURN_USD = 0.2363;
const RELIABILITY_BINS = 5;

const DIST = '/app/dist';
const MOD = {
  database: `${DIST}/config/database`,
  decisionGate: `${DIST}/modules/crossmodel/platform/decision-gate`,
  decisionGateModes: `${DIST}/modules/crossmodel/platform/decision-gate-modes`,
  loopMetrics: `${DIST}/modules/crossmodel/platform/loop-metrics.service`,
  wakeTriageRequest: `${DIST}/modules/crossmodel/platform/wake-triage-request`,
  supervisor: `${DIST}/modules/crossmodel/platform/supervisor.service`,
  math: `${DIST}/modules/crossmodel/platform/decision-gate-math`,
  runReceipts: `${DIST}/modules/crossmodel/coding/run-receipts`,
  evidenceTools: `${DIST}/modules/crossmodel/coding/evidence-tools`,
};

// ── Pure helpers (exported for the jest suite) ───────────────────────────────

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

/** Linear-interpolation quantile on an unsorted numeric array. */
function quantile(values, q) {
  const a = values.filter(v => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

/** Deterministic PRNG (mulberry32) for the dry-run corpus. */
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

function hash8(salt, id) {
  if (!id) return null;
  return crypto.createHash('sha256').update(`${salt}|${id}`).digest('hex').slice(0, 8);
}

/** Deterministic per-row sampling: keep when the salted hash of the id falls under `rate`. Pure. */
function sampleKeep(salt, id, rate) {
  if (!(rate < 1)) return true;
  if (!(rate > 0)) return false;
  const h = parseInt(crypto.createHash('sha256').update(`${salt}|sample|${id}`).digest('hex').slice(0, 8), 16);
  return (h % 100000) / 100000 < rate;
}

/** Age bucket (the E3b memo vocabulary — decision-gate-math bucketMinutes); a dated copy for the dry run. */
function bucketMinutesFallback(min) {
  if (!Number.isFinite(min)) return 'unknown';
  if (min < 5) return '0-5m';
  if (min < 15) return '5-15m';
  if (min < 60) return '15-60m';
  return '60m+';
}
/** Coarser hour buckets for "last action ago". */
function bucketHours(h) {
  if (!Number.isFinite(h)) return 'never';
  if (h < 1) return '<1h';
  if (h < 6) return '1-6h';
  if (h < 24) return '6-24h';
  if (h < 72) return '1-3d';
  return '3-7d';
}
/** Rates quantised to 0.05 (memo-stable). */
function quantiseRate(r) { return Number.isFinite(r) ? Math.round(r * 20) / 20 : null; }

/**
 * classifySupervisorNote — dated copy of supervisor.service.ts (2026-09-27): the
 * no-op marker wins; the ACTIONS TAKEN receipt marker beats length; ≤ 200 chars
 * with no marker is a no-op. The live runtime prefers the compiled export.
 */
const SUPERVISOR_NOOP_NOTE_RE = /\b(?:SWEEP|WAKE):\s*no-op\b/i;
const SUPERVISOR_ACTION_NOTE_RE = /\bACTIONS?\s+TAKEN\b|\bActions\s*\(\s*\d+/i;
function classifySupervisorNoteFallback(content) {
  const text = typeof content === 'string' ? content.trim() : String(content ?? '').trim();
  if (!text) return 'supervisor_noop';
  if (SUPERVISOR_NOOP_NOTE_RE.test(text)) return 'supervisor_noop';
  if (SUPERVISOR_ACTION_NOTE_RE.test(text)) return 'supervisor_action';
  if (text.length <= 200) return 'supervisor_noop';
  return 'supervisor_note';
}

/** Alarm-class hook event types (hooks.service ALARM_EVENT_TYPES @ 2026-09-27; schedule_disabled with a successorId is routine). */
const ALARM_EVENT_TYPES = new Set(['attention_needed', 'run_failed', 'goal_blocked', 'schedule_disabled', 'todo_wake']);
function isAlarmInput(row) {
  const t = String(row?.eventType ?? '');
  if (!ALARM_EVENT_TYPES.has(t)) return false;
  if (t === 'schedule_disabled' && row?.payload && row.payload.successorId) return false;
  return true;
}
const OWNER_CARD_RE = /\[INFRA ALERT\]|\b(?:owner(?:'s)?[- ](?:decision|approval|card|question|input)|flag_owner_question|needs? the owner|ask(?:ing)? the owner|human (?:decision|approval))\b/i;
const CHILD_RESULT_RE = /\b(?:child|sub-?session|delegat(?:e|ed|ion))\b.*\b(?:result|finished|completed|returned)\b/i;

/** Normalised character trigrams of a text (lower-cased, whitespace-collapsed, punctuation stripped). */
function trigrams(text) {
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const out = new Set();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}
/**
 * has_new_input — the code-labelled feature (never a Jev question in the act rule):
 * the share of the pending inputs' trigrams that none of the last notes contain.
 * ≥ NEW_INPUT_SHARE_MIN ⇒ new input. No pending text ⇒ {share: 0, hasNewInput: false};
 * pending text with no notes ⇒ everything is new.
 */
function newInputShare(pendingTexts, noteTexts) {
  const pend = trigrams((pendingTexts || []).join(' \n '));
  if (!pend.size) return { share: 0, hasNewInput: false, pendingTrigrams: 0 };
  const known = trigrams((noteTexts || []).join(' \n '));
  let novel = 0;
  for (const g of pend) if (!known.has(g)) novel += 1;
  const share = novel / pend.size;
  return { share: Math.round(share * 100) / 100, hasNewInput: share >= NEW_INPUT_SHARE_MIN, pendingTrigrams: pend.size };
}

/** Per-target 7-day features from supervisor_* rows (newest first or any order). Pure. */
function targetHistory(rows, nowMs) {
  const list = (rows || []).map(r => ({ kind: r.kind, t: typeof r.t === 'number' ? r.t : new Date(r.t || r.createdAt).getTime() })).filter(r => Number.isFinite(r.t) && r.t < nowMs && r.t >= nowMs - TARGET_HISTORY_MS).sort((a, b) => b.t - a.t);
  const turns = list.length;
  const noops = list.filter(r => r.kind === 'supervisor_noop').length;
  const actions = list.filter(r => r.kind === 'supervisor_action').length;
  let consecutive = 0;
  for (const r of list) { if (r.kind === 'supervisor_noop') consecutive += 1; else break; }
  const lastAction = list.find(r => r.kind === 'supervisor_action');
  return {
    turns_7d: turns,
    noop_rate_7d: turns ? quantiseRate(noops / turns) : null,
    action_rate_7d: turns ? quantiseRate(actions / turns) : null,
    consecutive_noops: consecutive,
    last_action_ago: lastAction ? bucketHours((nowMs - lastAction.t) / 3600e3) : 'never',
  };
}

/** Split a coalesced drain user row into the queued agent bodies (chat-agent.service drainChatQueue shapes). Pure. */
const AGENT_HDR_RE = /^\[AGENT-SENT MESSAGE — from chat "([^"]*)" \(([0-9a-f]{8})\)[^\]]*\]\s*/i;
const QUEUED_HDR_RE = /^\[queued agent message from chat ([0-9a-f]{8})[^\]]*\]\s*/i;
const SUPERSEDED_RE = /^\[[^\]]*superseded[^\]]*\]\s*/i;
function splitDrainBodies(content) {
  let text = String(content || '');
  const m = text.match(/^\[(\d+) agent messages arrived while this chat was busy[^\]]*\]\s*/);
  if (m) text = text.slice(m[0].length);
  const parts = text.split(/\n\n— — —\n\n/).map(s => s.trim()).filter(Boolean);
  return parts.map(p => {
    let body = p.replace(SUPERSEDED_RE, '');
    let source = null; let title = null;
    const a = body.match(AGENT_HDR_RE);
    if (a) { title = a[1]; source = a[2]; body = body.slice(a[0].length); }
    else { const q = body.match(QUEUED_HDR_RE); if (q) { source = q[1]; body = body.slice(q[0].length); } }
    return { source, title, body: body.trim() };
  });
}

/** The pending-input rows the state carries (≤ PENDING_ROWS_MAX, summaries capped). Pure. */
function pendingInputRows(rows, salt, nowMs, bucketFn = bucketMinutesFallback) {
  const list = (rows || []).slice(0, PENDING_ROWS_MAX);
  return list.map(r => {
    const t = r.createdAt ? new Date(r.createdAt).getTime() : NaN;
    return {
      event_type: String(r.eventType || 'agent_message'),
      source_lane: r.sourceChatId ? hash8(salt, r.sourceChatId) : null,
      summary: String(r.summary || '').replace(/\s+/g, ' ').trim().slice(0, PENDING_SUMMARY_CHARS),
      depth: Number.isFinite(Number(r.depth)) ? Number(r.depth) : 0,
      age_bucket: Number.isFinite(t) ? bucketFn(Math.max(0, (nowMs - t) / 60000)) : 'unknown',
    };
  });
}

/** Alarm / owner-card / child-result pin over the pending rows (the act rule never skips on these). Pure. */
function pendingPins(rows) {
  let alarm = false, owner = false, child = false;
  for (const r of rows || []) {
    if (isAlarmInput(r)) alarm = true;
    const s = String(r.summary || '');
    if (OWNER_CARD_RE.test(s)) owner = true;
    if (String(r.eventType || '') === 'child_result' || CHILD_RESULT_RE.test(s)) child = true;
  }
  return { any_alarm: alarm, any_owner_card: owner, any_child_result: child, pinned: alarm || owner || child };
}

/** Board counts over the scope's agent_runs as of t0 in (since, t0]. Pure. */
function boardCounts(runs, since, t0) {
  const out = { lanes_running_now: 0, runs_started_since: 0, runs_finished_since: 0, runs_failed_since: 0, runs_cancelled_since: 0 };
  const running = new Set();
  for (const r of runs || []) {
    const st = r.startedAt ? new Date(r.startedAt).getTime() : NaN;
    const fi = r.finishedAt ? new Date(r.finishedAt).getTime() : NaN;
    if (Number.isFinite(st) && st <= t0 && (!Number.isFinite(fi) || fi > t0)) running.add(r.sessionId);
    if (Number.isFinite(st) && st > since && st <= t0) out.runs_started_since += 1;
    if (Number.isFinite(fi) && fi > since && fi <= t0) {
      if (r.status === 'completed') out.runs_finished_since += 1;
      else if (r.status === 'failed') out.runs_failed_since += 1;
      else if (r.status === 'cancelled' || r.status === 'interrupted') out.runs_cancelled_since += 1;
    }
  }
  out.lanes_running_now = running.size;
  return out;
}

/** The newest run of a source lane as of t0 (lane facts). Pure. */
function laneFacts(runs, t0, bucketFn = bucketMinutesFallback) {
  let best = null;
  for (const r of runs || []) {
    const st = r.startedAt ? new Date(r.startedAt).getTime() : (r.createdAt ? new Date(r.createdAt).getTime() : NaN);
    if (!Number.isFinite(st) || st > t0) continue;
    if (!best || st > best.st) best = { st, r };
  }
  if (!best) return null;
  const fi = best.r.finishedAt ? new Date(best.r.finishedAt).getTime() : NaN;
  const status = Number.isFinite(fi) && fi <= t0 ? String(best.r.status) : 'running';
  return { status, ended_ago: Number.isFinite(fi) && fi <= t0 ? bucketFn((t0 - fi) / 60000) : null, error_head: best.r.error ? String(best.r.error).replace(/\s+/g, ' ').slice(0, 160) : null };
}

/** supervisor_turn_noop act band (the consumer contract). Pure. */
function turnNoopBand(input, tau = TURN_NOOP_TAU) {
  const p = Number(input.willAct);
  const quiet = Number.isFinite(p) && p <= 1 - tau + 1e-9;
  const jevOnly = quiet;
  const act = quiet && !input.hasNewInput && !input.pinned;
  return { quiet, jevOnly, act };
}

/** audit_round_skip act band (the consumer contract): reopen ≤ bar AND every step ≥ τ. Pure. */
function auditSkipBand(answers, reopenBar = AUDIT_REOPEN_BAR, stepTau = AUDIT_STEP_TAU) {
  const reopen = Number(answers?.any_reopen);
  const steps = Object.keys(answers || {}).filter(k => /^step_\d+_receipted$/.test(k)).map(k => Number(answers[k]));
  const minStep = steps.length ? Math.min(...steps) : null;
  const reopenOk = Number.isFinite(reopen) && reopen <= reopenBar + 1e-9;
  const stepsOk = minStep === null ? false : minStep >= stepTau - 1e-9;
  return { reopenOk, stepsOk, minStep, act: reopenOk && stepsOk };
}

// ── audit: plan / receipt helpers ────────────────────────────────────────────

const normStatus = (s) => String(s || '').toLowerCase();
function completedIds(steps) { return (steps || []).filter(s => normStatus(s.status) === 'completed').map(s => String(s.id)); }
/** selfAuditReopened semantics: a step completed before that is not completed after (deleted counts). Pure. */
function reopenedSteps(before, stepsAfter) {
  const after = new Map((stepsAfter || []).map(s => [String(s.id), normStatus(s.status)]));
  return (before || []).filter(id => after.get(id) !== 'completed');
}

const STOP = new Set(['the', 'and', 'with', 'from', 'that', 'this', 'into', 'then', 'for', 'over', 'each', 'when', 'after', 'before', 'file', 'files', 'step', 'steps', 'run', 'runs', 'test', 'tests', 'code', 'verify', 'commit', 'push', 'branch', 'open', 'merge', 'update', 'create', 'add', 'read', 'write', 'check', 'confirm', 'ensure', 'make', 'sure', 'goal', 'plan', 'done', 'complete', 'completed', 'work', 'via', 'using', 'todo', 'lane', 'session', 'chat', 'report', 'note', 'also', 'only', 'same', 'all', 'any']);
/** Nouns a step names: paths, PR numbers, shas, dotted/underscored identifiers, long words. Pure. */
function stepNouns(text) {
  const s = String(text || '');
  const out = new Set();
  for (const m of s.matchAll(/[\w./-]+\.[A-Za-z0-9]{1,6}\b/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/#(\d{1,6})\b/g)) out.add(`#${m[1]}`);
  for (const m of s.matchAll(/\b[0-9a-f]{7,40}\b/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/\b[A-Za-z][\w-]*[_-][\w-]+\b/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/\b[A-Za-z]{5,}\b/g)) { const w = m[0].toLowerCase(); if (!STOP.has(w)) out.add(w); }
  return [...out];
}
const KIND_RULES = [
  [/\b(commit|committed)\b/i, ['git_commit', 'run_command']],
  [/\b(push|pushed)\b/i, ['git_push', 'run_command']],
  [/\b(pull request|PR\b|open(?:ed)? a PR|merge)/i, ['open_pull_request', 'run_command']],
  [/\b(verify|verified|verification|tests? pass)/i, ['verify', 'run_command']],
  [/\b(send|sent|message|notify|report(?:ed)? up)\b/i, ['send_chat_message', 'notify_user']],
  [/\b(schedul|re-?arm|cadence)/i, ['schedule_message', 'update_schedule']],
  [/\b(ticket|feedback)\b/i, ['file_feedback', 'update_feedback']],
];
/**
 * Deterministic step → receipt pre-join (the ECT-style step 0): a completed step is
 * RECEIPTED when an ok:true receipt's tool matches the step's action kind, or its
 * argsHead / resultHead / ids mention one of the step's nouns (≥ 4 chars). Pure.
 */
function receiptJoin(steps, receipts) {
  const okReceipts = (receipts || []).filter(r => r && r.ok);
  const texts = okReceipts.map(r => `${r.tool} ${r.argsHead || ''} ${r.resultHead || ''} ${JSON.stringify(r.ids || {})}`.toLowerCase());
  return (steps || []).map(s => {
    const nouns = stepNouns(s.text).filter(n => n.length >= 4);
    const kinds = KIND_RULES.filter(([re]) => re.test(String(s.text || ''))).flatMap(([, tools]) => tools);
    const matched = [];
    okReceipts.forEach((r, i) => {
      const byNoun = nouns.some(n => texts[i].includes(n));
      const byKind = kinds.includes(r.tool) && r.tool !== 'run_command';
      if (byNoun || byKind) matched.push(String(r.id || '').slice(0, 8));
    });
    return { id: String(s.id), receipted: matched.length > 0, receipt_ids: matched.slice(0, 6) };
  });
}

/** Rebuild the audit decision point from a run's agent_events (see the header). Pure over the rows. */
function rebuildAuditPoint(events, opts) {
  const rows = (events || []).slice().sort((a, b) => Number(a.seq) - Number(b.seq));
  const grant = rows.find(e => e.type === 'progress' && /^Auto-audit:/.test(String(e.message || '')));
  if (!grant) return { ok: false, reason: 'no_grant_marker' };
  const S = Number(grant.seq);
  let planBefore = null, planAfter = null;
  for (const e of rows) {
    if (e.type !== 'plan_update' || !e.plan) continue;
    if (Number(e.seq) < S) planBefore = e.plan; else planAfter = e.plan;
  }
  if (!planBefore && opts.fallbackPlan) planBefore = opts.fallbackPlan;
  if (!planBefore || !Array.isArray(planBefore.steps) || !planBefore.steps.length) return { ok: false, reason: 'no_plan_before_grant' };
  const stepsBefore = planBefore.steps.map(s => ({ id: s.id, status: s.status, text: s.text, note: s.note }));
  const stepsAfter = planAfter && Array.isArray(planAfter.steps) ? planAfter.steps : stepsBefore;
  const completedBefore = completedIds(stepsBefore);
  const reopened = planAfter ? reopenedSteps(completedBefore, stepsAfter) : [];
  // receipts: pair each tool_result with the nearest preceding unpaired tool_call of the same name
  const pendingCalls = [];
  const receipts = [];
  let evidenceCalls = 0, toolCalls = 0, lastToolResultSeq = 0;
  let lastVerify = null;
  const textBefore = [];
  let guardAfter = 0;
  for (const e of rows) {
    const seq = Number(e.seq);
    if (seq >= S) { if (e.type === 'guard_marker' || e.type === 'draft_discarded') guardAfter += 1; continue; }
    if (e.type === 'tool_call') {
      toolCalls += 1;
      if (opts.isEvidenceToolName(e.name)) evidenceCalls += 1;
      pendingCalls.push(e);
    } else if (e.type === 'tool_result') {
      lastToolResultSeq = seq;
      const i = pendingCalls.map(c => c.name).lastIndexOf(e.name);
      const call = i >= 0 ? pendingCalls.splice(i, 1)[0] : null;
      let args = call ? call.args : null;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* truncated JSON: keep the raw head */ } }
      const draft = opts.extractReceipt(String(e.name || ''), args, String(e.result || ''), new Date());
      if (draft) {
        const heads = opts.receiptHeads(args, e.result);
        receipts.push({ id: `${seq}`, tool: draft.tool, ok: draft.ok, ids: draft.ids, argsHead: heads.argsHead, resultHead: heads.resultHead });
      }
    } else if (e.type === 'verify_result') {
      lastVerify = { passed: String(e.passed) === 'true', failedStage: e.failed_stage || null };
    } else if (e.type === 'text' && typeof e.delta === 'string') {
      if (seq > lastToolResultSeq) textBefore.push(e.delta);
    }
  }
  const finalText = textBefore.join('').trim().slice(0, 3000);
  return {
    ok: true, grantSeq: S, grantAt: grant.createdAt || null,
    stepsBefore, completedBefore, reopened, planAfterSeen: !!planAfter,
    receipts, evidenceCalls, toolCalls, lastVerify, finalText, guardAfter,
    completeAt: (rows.find(e => e.type === 'complete') || {}).createdAt || null,
  };
}

/** The audit_round_skip state + questions for a rebuilt point. Pure. */
function buildAuditRequest(pt, meta) {
  const reviewed = pt.completedBefore.slice(0, AUDIT_STEP_CAP);
  const stepById = new Map(pt.stepsBefore.map(s => [String(s.id), s]));
  const join = receiptJoin(reviewed.map(id => stepById.get(id)).filter(Boolean), pt.receipts);
  const joinById = new Map(join.map(j => [j.id, j]));
  const underReview = reviewed.map((id, i) => {
    const s = stepById.get(id);
    const j = joinById.get(String(id));
    return { position: i + 1, id: String(id), text: String(s?.text || '').slice(0, 140), receipt_prejoin: j ? { receipted: j.receipted, receipt_ids: j.receipt_ids } : null };
  });
  const perTool = {};
  for (const r of pt.receipts) { const k = r.tool; perTool[k] = perTool[k] || { ok: 0, err: 0 }; if (r.ok) perTool[k].ok += 1; else perTool[k].err += 1; }
  const state = {
    plan_steps: pt.stepsBefore.slice(0, 40).map(s => ({ id: String(s.id), status: s.status, text: String(s.text || '').slice(0, 140), ...(s.note ? { note: String(s.note).slice(0, 120) } : {}) })),
    completed_count: pt.completedBefore.length,
    blocked_count: pt.stepsBefore.filter(s => normStatus(s.status) === 'blocked').length,
    completed_steps_under_review: underReview,
    receipts_this_run: pt.receipts.slice(-16).map(r => ({ id: r.id, tool: r.tool, ok: r.ok, ids: r.ids, args: r.argsHead || null, result: r.resultHead || null })),
    receipt_counts_by_tool: perTool,
    last_verify: pt.lastVerify,
    evidence_tool_calls: pt.evidenceCalls,
    turns_bucket: bucketCount(meta.turnsBefore ?? pt.toolCalls),
    cost_bucket_usd: bucketCost(meta.costUsdBefore),
    final_summary: pt.finalText,
  };
  const questions = {
    any_reopen: {
      type: 'noul',
      instructions: 'A fresh self-audit of this run would REOPEN at least one of the completed steps under review — re-checking the work against the receipts would find a step marked completed whose work was not actually done this run.',
      criteria: { true: 'at least one reviewed step claims work the receipts do not show was done, or its only matching receipts are ok:false', false: 'every reviewed step is backed by an ok:true receipt that shows its work was done this run' },
    },
  };
  underReview.forEach((u) => {
    questions[`step_${u.position}_receipted`] = {
      type: 'noul',
      instructions: `This run's receipt ledger (\`receipts_this_run\`) contains a tool result evidencing the completion of the step at position ${u.position} of \`completed_steps_under_review\` — a commit sha, a PR number, exit 0 of the named check, a diff on the named file, or a result that states the step's work was done.`,
      criteria: { true: 'an ok:true receipt corresponds to what the step says was done (the right tool, a matching path / branch / id / command, or a result that states it)', false: 'no receipt corresponds to the step\'s work, the only corresponding receipts are ok:false, or the step describes work that would need a receipt none of the listed tools produced' },
    };
  });
  const allReceipted = join.length > 0 && join.every(j => j.receipted);
  const ect = allReceipted && (!pt.lastVerify || pt.lastVerify.passed === true);
  return { state, questions, reviewedCount: reviewed.length, join, ectSkip: ect, allReceipted };
}
function bucketCount(n) { n = Number(n); if (!Number.isFinite(n)) return 'unknown'; if (n < 5) return '0-4'; if (n < 15) return '5-14'; if (n < 40) return '15-39'; return '40+'; }
function bucketCost(usd) { usd = Number(usd); if (!Number.isFinite(usd)) return 'unknown'; if (usd < 0.25) return '<0.25'; if (usd < 1) return '0.25-1'; if (usd < 3) return '1-3'; return '3+'; }

// ── supervisor_turn_noop: the state + questions ──────────────────────────────

const TURN_NOOP_QUESTIONS = {
  will_act: {
    type: 'noul',
    instructions: 'Given the board facts, the pending inputs and the supervisor\'s recent notes, this supervisor turn will take a recorded ACTION — send a message to a lane, schedule or re-arm a cadence, file a ticket, an infra action, or an owner card — rather than end as a "WAKE|SWEEP: no-op" note.',
    criteria: {
      true: 'the pending inputs or the board carry something the supervisor must act on now: a failure, a blocked or stuck lane, a question or request addressed to it, a finished lane needing follow-up, an owner-facing decision, a cadence to re-arm',
      false: 'nothing moved that needs the supervisor: routine completions, progress or status chatter already covered by its recent notes, running lanes still running, and no waiting asks — the turn would close as a no-op',
    },
  },
  has_new_input: {
    type: 'noul',
    instructions: 'The pending inputs state at least one fact that the supervisor\'s last three notes do not already contain.',
    criteria: { true: 'a pending input reports a fact (a result, a failure, a request, a number, a state change) absent from the recent notes', false: 'every pending input repeats what the recent notes already say, or there are no pending inputs' },
  },
};

/** The supervisor_turn_noop state (memo-stable: buckets, quantised rates, hashed ids). Pure. */
function buildTurnNoopState(f) {
  return {
    target: f.target,
    origin: f.origin,
    minutes_since_previous_turn: f.windowMin,
    pending_inputs_total: f.pendingTotal,
    pending_inputs: f.pending,
    pending_flags: f.flags,
    has_new_input: f.newInput.hasNewInput,
    new_input_share: f.newInput.share,
    source_lanes: f.sourceLanes,
    board: f.board,
    target_history_7d: f.history,
    previous_notes: f.previousNotes,
  };
}

// ── Aggregates (mergeable) ───────────────────────────────────────────────────

function newAgg(meta = {}) {
  return {
    v: 1, probe: 'backtest-agent-decisions',
    runId: meta.runId || null, spec: meta.spec || null, candidate: meta.candidate || null, batchIndex: meta.batchIndex ?? 0,
    window: meta.window || null, cap: meta.cap ?? DEFAULT_CAP,
    rowsScanned: 0, rowsScored: 0, skipped: {}, totals: null,
    gate: { calls: 0, ok: 0, nullResults: 0, errors: 0, calibrated: 0, byBackend: {}, byMode: {}, latencies: [] },
    rows: [],
    aux: null, cursor: null, done: false, telemetryStubbedRows: null,
  };
}
function bump(obj, key, by = 1) { obj[key] = (obj[key] || 0) + by; }
function mergeCounts(x, y) { const o = { ...(x || {}) }; for (const k of Object.keys(y || {})) o[k] = (o[k] || 0) + y[k]; return o; }
function mergeAgg(x, y) {
  if (!x) return y; if (!y) return x;
  const out = newAgg({ runId: x.runId || y.runId, spec: x.spec || y.spec, candidate: x.candidate || y.candidate, window: x.window || y.window, cap: x.cap ?? y.cap });
  out.batchIndex = Math.max(x.batchIndex ?? 0, y.batchIndex ?? 0);
  out.batches = (x.batches || 1) + (y.batches || 1);
  out.rowsScanned = x.rowsScanned + y.rowsScanned; out.rowsScored = x.rowsScored + y.rowsScored;
  out.skipped = mergeCounts(x.skipped, y.skipped);
  out.totals = x.totals || y.totals;
  out.gate = { calls: x.gate.calls + y.gate.calls, ok: x.gate.ok + y.gate.ok, nullResults: x.gate.nullResults + y.gate.nullResults, errors: x.gate.errors + y.gate.errors, calibrated: x.gate.calibrated + y.gate.calibrated, byBackend: mergeCounts(x.gate.byBackend, y.gate.byBackend), byMode: mergeCounts(x.gate.byMode, y.gate.byMode), latencies: [...x.gate.latencies, ...y.gate.latencies] };
  out.rows = [...x.rows, ...y.rows];
  out.aux = x.aux || y.aux;
  out.cursor = y.cursor || x.cursor;
  out.done = !!(x.done || y.done);
  out.telemetryStubbedRows = (Number(x.telemetryStubbedRows) || 0) + (Number(y.telemetryStubbedRows) || 0);
  return out;
}
function noteGate(agg, g) {
  if (!g) return;
  agg.gate.calls += 1;
  if (g.error) agg.gate.errors += 1;
  else if (g.nullResult) agg.gate.nullResults += 1;
  else { agg.gate.ok += 1; if (g.calibrated) agg.gate.calibrated += 1; bump(agg.gate.byBackend, g.backend || 'unknown'); bump(agg.gate.byMode, g.mode || 'unknown'); }
  if (Number.isFinite(g.ms)) agg.gate.latencies.push(g.ms);
}

// ── Report ───────────────────────────────────────────────────────────────────

const r4 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const pct = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 10);
const ratio = (num, den) => (den ? num / den : null);
const confusion = (rows, skipOf, negOf) => {
  // positive = "skip"; correct skip = the turn was a no-op / the audit reopened nothing
  const m = { skip_correct: 0, skip_wrong: 0, run_negative: 0, run_positive: 0 };
  for (const r of rows) { const s = skipOf(r), neg = negOf(r); if (s && neg) m.skip_correct += 1; else if (s && !neg) m.skip_wrong += 1; else if (!s && neg) m.run_negative += 1; else m.run_positive += 1; }
  return m;
};
function reliability(rows, pOf, actualOf, bins = RELIABILITY_BINS) {
  const table = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, meanP: 0, actualRate: 0 }));
  for (const r of rows) { const p = pOf(r); if (!Number.isFinite(p)) continue; const i = Math.min(bins - 1, Math.max(0, Math.floor(p * bins))); table[i].n += 1; table[i].meanP += p; table[i].actualRate += actualOf(r) ? 1 : 0; }
  let ece = 0; const N = table.reduce((s, b) => s + b.n, 0);
  return { n: N, ece: N ? r4(table.reduce((s, b) => { if (!b.n) return s; return s + (b.n / N) * Math.abs(b.meanP / b.n - b.actualRate / b.n); }, 0)) : null, bins: table.map(b => ({ lo: r4(b.lo), hi: r4(b.hi), n: b.n, meanP: b.n ? r4(b.meanP / b.n) : null, actualRate: b.n ? r4(b.actualRate / b.n) : null })) };
}

function reportTurnNoop(agg) {
  const rows = agg.rows.filter(r => r.g === 1);
  const n = rows.length;
  const totals = agg.totals || {};
  const bands = {
    contract: (r) => turnNoopBand({ willAct: r.pw, hasNewInput: !!r.hn, pinned: !!r.pin }).act,
    jevOnly: (r) => turnNoopBand({ willAct: r.pw, hasNewInput: false, pinned: false }).quiet,
    featureOnly: (r) => !r.hn && !r.pin,
  };
  const noop = (r) => r.a === 0;
  const band = (name, fn) => {
    const inB = rows.filter(fn);
    const w = wilson(inB.filter(noop).length, inB.length);
    return { band: name, n_in_band: inB.length, coverage: pct(ratio(inB.length, n)), agreement: pct(w.p), agreementWilson95: [pct(w.lo), pct(w.hi)], confusion: confusion(rows, fn, noop) };
  };
  const base = wilson(rows.filter(noop).length, n);
  const seg = {};
  for (const r of rows) { const k = `${r.o}|${r.t}`; seg[k] = seg[k] || { n: 0, noop: 0, inBand: 0, inBandNoop: 0 }; seg[k].n += 1; if (noop(r)) seg[k].noop += 1; if (bands.contract(r)) { seg[k].inBand += 1; if (noop(r)) seg[k].inBandNoop += 1; } }
  const segments = Object.fromEntries(Object.entries(seg).map(([k, v]) => [k, { n: v.n, noopRate: pct(ratio(v.noop, v.n)), coverage: pct(ratio(v.inBand, v.n)), agreement: pct(ratio(v.inBandNoop, v.inBand)), wilsonLo: pct(wilson(v.inBandNoop, v.inBand).lo) }]));
  const contract = band('contract: will_act ≤ 0.15 ∧ ¬has_new_input(feature) ∧ ¬pinned', bands.contract);
  const inBand = rows.filter(bands.contract);
  const usd = inBand.filter(noop).map(r => (Number.isFinite(r.usd) ? r.usd : FALLBACK_TURN_USD));
  const minutes = inBand.filter(noop).map(r => r.min).filter(Number.isFinite);
  const days = agg.window ? agg.window.days : DEFAULT_DAYS;
  const perDayScored = ratio(n, days);
  const scaleToPopulation = totals.eligible ? totals.eligible / n : 1;
  const skipsPerDay = inBand.length ? (inBand.length / days) * scaleToPopulation : 0;
  const correctPerDay = inBand.filter(noop).length ? (inBand.filter(noop).length / days) * scaleToPopulation : 0;
  const wrongPerDay = skipsPerDay - correctPerDay;
  const savings = correctPerDay * (mean(usd) ?? FALLBACK_TURN_USD);
  const minutesPerDay = correctPerDay * ((mean(minutes) ?? 0) / 60000);
  const hn = reliability(rows, r => r.ph, r => !!r.hn);
  const wa = reliability(rows, r => r.pw, r => r.a === 1);
  const lo = wilson(inBand.filter(noop).length, inBand.length).lo;
  const verdict = n === 0 ? 'drop'
    : inBand.length >= 100 && lo !== null && lo >= 0.85 ? 'build-and-act-candidate'
    : inBand.length >= 30 && lo !== null && lo > base.p ? 'build-shadow'
    : inBand.length > 0 && wilson(inBand.filter(noop).length, inBand.length).p > base.p ? 'build-shadow'
    : 'drop';
  return {
    key: 'supervisor_turn_noop', n, gateCalls: agg.gate.calls, gateErrors: agg.gate.errors + agg.gate.nullResults,
    population: { window_days: days, eligible_rows_in_window: totals.eligible ?? null, scored_per_day: r4(perDayScored), by_origin: totals.byOrigin || null, note: 'eligible = supervisor_noop/action/note rows with origin schedule|agent (hook wakes stay under wake_triage); the scored set is a deterministic salted sample of them' },
    baseRate: { noop: pct(base.p), wilson95: [pct(base.lo), pct(base.hi)], action: pct(ratio(rows.filter(r => r.a === 1).length, n)) },
    bands: [contract, band('jev only: will_act ≤ 0.15', bands.jevOnly), band('feature only: ¬has_new_input ∧ ¬pinned', bands.featureOnly)],
    segments,
    pins: { has_new_input_feature_rate: pct(ratio(rows.filter(r => r.hn).length, n)), pinned_rate: pct(ratio(rows.filter(r => r.pin).length, n)), alarm_rate: pct(ratio(rows.filter(r => r.al).length, n)) },
    calibration: { will_act_vs_action: wa, has_new_input_vs_feature: hn, has_new_input_agreement: pct(ratio(rows.filter(r => (r.ph >= 0.5) === !!r.hn).length, n)) },
    projected: { skips_per_day: r4(skipsPerDay), correct_skips_per_day: r4(correctPerDay), wrong_skips_per_day: r4(wrongPerDay), mean_usd_per_noop_turn: r4(mean(usd)), usd_join_rate: pct(ratio(rows.filter(r => Number.isFinite(r.usd)).length, n)), mean_minutes_per_noop_turn: r4((mean(minutes) ?? 0) / 60000), savingsUsdPerDay: r4(savings), minutesPerDay: r4(minutesPerDay), note: 'a wrong skip re-parks the inputs to the next heartbeat (deferred, not lost); $ is the run_spend join on the supervisor chat within [note − 60 s, + 30 min], fallback the 14 d machine-turn mean' },
    latency: { p50: r4(quantile(agg.gate.latencies, 0.5)), p95: r4(quantile(agg.gate.latencies, 0.95)) },
    verdict, verdictRule: 'build-and-act-candidate: ≥ 100 in-band rows and Wilson LB ≥ 0.85; build-shadow: in-band agreement above the no-op base rate; drop: n = 0 or no lift over base',
    result: { key: 'supervisor_turn_noop', n, coverage: contract.coverage ?? 0, agreement: contract.agreement ?? 0, agreementLowerBound: contract.agreementWilson95[0] ?? 0, projectedSavingsUsdPerDay: r4(savings) ?? 0, verdict },
  };
}

function reportAudit(agg) {
  const rows = agg.rows.filter(r => r.g === 1);
  const n = rows.length;
  const totals = agg.totals || {};
  const noReopen = (r) => r.re === 0;
  const contractFn = (r) => auditSkipBand(r.ans).act;
  const ectFn = (r) => !!r.ect;
  const unionFn = (r) => ectFn(r) || (!ectFn(r) && contractFn(r));
  const band = (name, fn) => {
    const inB = rows.filter(fn);
    const w = wilson(inB.filter(noReopen).length, inB.length);
    const reopen = wilson(inB.filter(r => !noReopen(r)).length, inB.length);
    return { band: name, n_in_band: inB.length, coverage: pct(ratio(inB.length, n)), agreement_noReopen: pct(w.p), agreementWilson95: [pct(w.lo), pct(w.hi)], reopenRateInBand: pct(reopen.p), reopenWilson95: [pct(reopen.lo), pct(reopen.hi)], confusion: confusion(rows, fn, noReopen) };
  };
  const base = wilson(rows.filter(r => !noReopen(r)).length, n);
  const contract = band('contract: any_reopen ≤ 0.10 ∧ min_k step_k_receipted ≥ 0.85', contractFn);
  const ect = band('ECT step 0 (deterministic): every completed step receipt-joined ∧ last verify passed', ectFn);
  const union = band('ECT ∪ Jev residual', unionFn);
  const inBand = rows.filter(unionFn);
  const days = agg.window ? agg.window.days : DEFAULT_DAYS;
  const scale = totals.eligible ? totals.eligible / n : 1;
  const skipsPerDay = (inBand.length / days) * scale;
  const shed = rows.filter(r => Number.isFinite(r.shed)).map(r => r.shed);
  const roundMin = rows.filter(r => Number.isFinite(r.rmin)).map(r => r.rmin);
  const savings = shed.length ? skipsPerDay * mean(shed) : null;
  const harness = rows.filter(r => r.hl !== null && r.hl !== undefined);
  const harnessAgree = harness.filter(r => (r.hl === 1) === (r.re === 1)).length;
  const lo = wilson(inBand.filter(noReopen).length, inBand.length).lo;
  const reopenHi = wilson(inBand.filter(r => !noReopen(r)).length, inBand.length).hi;
  const verdict = n === 0 ? 'drop'
    : inBand.length >= 300 && reopenHi !== null && reopenHi <= 0.01 ? 'build-and-act-candidate'
    : inBand.length >= 30 && lo !== null && lo > 1 - base.p ? 'build-shadow'
    : inBand.length > 0 && ratio(inBand.filter(r => !noReopen(r)).length, inBand.length) < base.p ? 'build-shadow'
    : 'drop';
  return {
    key: 'audit_round_skip', n, gateCalls: agg.gate.calls, gateErrors: agg.gate.errors + agg.gate.nullResults,
    population: { window_days: days, eligible_rows_in_window: totals.eligible ?? null, audits_per_day: totals.eligible ? r4(totals.eligible / days) : null, stamped_rows_in_window: totals.stamped ?? null, note: 'eligible = self_audit_run rows (the audit RAN); the scored set is a deterministic salted sample stratified toward rows with an E5 decision stamp' },
    baseRate: { reopen: pct(base.p), wilson95: [pct(base.lo), pct(base.hi)], composite_reopen_or_guard: pct(ratio(rows.filter(r => r.re === 1 || r.gs > 0).length, n)) },
    bands: [contract, ect, union],
    steps: { mean_completed_under_review: r4(mean(rows.map(r => r.k))), mean_receipted_by_prejoin: r4(mean(rows.map(r => r.kj))), all_receipted_rate: pct(ratio(rows.filter(r => r.allj).length, n)), rows_with_verify: rows.filter(r => r.v !== null).length, verify_pass_rate: pct(ratio(rows.filter(r => r.v === 1).length, rows.filter(r => r.v !== null).length)) },
    harnessLabelCrossCheck: { n: harness.length, agreement: pct(ratio(harnessAgree, harness.length)), note: 'my reopen label vs the harness\'s own steps_unbacked outcome row (recordSelfAuditStepOutcomes) on E5-stamped rows' },
    calibration: { any_reopen_vs_reopen: reliability(rows, r => Number(r.ans && r.ans.any_reopen), r => r.re === 1), min_step_vs_noReopen: reliability(rows, r => auditSkipBand(r.ans).minStep, r => r.re === 0) },
    projected: { skips_per_day: r4(skipsPerDay), shed_usd_join_n: shed.length, mean_shed_usd_per_audit: r4(mean(shed)), p50_shed_usd: r4(quantile(shed, 0.5)), mean_round_minutes: r4(mean(roundMin)), savingsUsdPerDay: r4(savings), minutesPerDay: roundMin.length ? r4(skipsPerDay * mean(roundMin)) : null, note: 'shed $ = run_spend(run) − self_audit_run.meta.costUsdBefore on the same run (E5 seam; only rows since 2026-09-25 carry the stamp — an upper bound, it includes the verify stage after the round); minutes = complete − grant event time (upper bound too)' },
    latency: { p50: r4(quantile(agg.gate.latencies, 0.5)), p95: r4(quantile(agg.gate.latencies, 0.95)) },
    verdict, verdictRule: 'build-and-act-candidate: ≥ 300 in-band rows and Wilson UB of the in-band reopen rate ≤ 1%; build-shadow: in-band reopen rate below the base rate; drop: n = 0 or no lift',
    result: { key: 'audit_round_skip', n, coverage: union.coverage ?? 0, agreement: union.agreement_noReopen ?? 0, agreementLowerBound: union.agreementWilson95[0] ?? 0, projectedSavingsUsdPerDay: r4(savings) ?? 0, verdict },
  };
}

function buildReport(byCandidate) {
  const out = { probe: 'backtest-agent-decisions', generatedAt: new Date().toISOString(), candidates: {}, results: [], telemetry: null, aux: null };
  let stubbed = 0; let aux = null; let runId = null; let spec = null; let window = null;
  for (const key of CANDIDATES) {
    const agg = byCandidate[key];
    if (!agg) { out.candidates[key] = { key, n: 0, verdict: 'drop', reason: 'no aggregate lines' }; out.results.push({ key, n: 0, coverage: 0, agreement: 0, agreementLowerBound: 0, projectedSavingsUsdPerDay: 0, verdict: 'drop' }); continue; }
    stubbed += Number(agg.telemetryStubbedRows) || 0; aux = aux || agg.aux; runId = runId || agg.runId; spec = spec || agg.spec; window = window || agg.window;
    const rep = key === 'supervisor_turn_noop' ? reportTurnNoop(agg) : reportAudit(agg);
    rep.batches = agg.batches || 1; rep.rowsScanned = agg.rowsScanned; rep.skipped = agg.skipped; rep.done = agg.done;
    out.candidates[key] = rep;
    out.results.push(rep.result);
  }
  out.runId = runId; out.spec = spec; out.window = window;
  out.telemetry = { stubbedRows: stubbed, note: 'decision_gate writes intercepted by the recordLoopMetric stub (≥ 1 per decide call); aux.backtestLeakRows must read 0' };
  out.aux = aux;
  out.caveats = [
    'every ask ran under purpose "probe" with the candidate\'s own questions (neither key is a registered purpose) — act-mode, memo-free, challenger-free; production would resolve the seat chain instead of the pinned spec',
    'supervisor_turn_noop: the label is the note the turn actually wrote (classifySupervisorNote); a skipped turn has no label — the in-band agreement is precision on turns that RAN, the heartbeat-floor control rows do not exist yet',
    'supervisor_turn_noop: board counts use agent_runs as of the turn start (terminal statuses are exact; queued-now is not reconstructable); for the drain origin the queued rows come from the coalesced user row, so their ages are unknown',
    'audit_round_skip: the label is the plan after the audit round vs the completed set at the grant (selfAuditReopened); a struck / rejected final that reopened nothing is reported separately as the composite rate',
    'audit_round_skip: receipts are rebuilt from agent_events tool_call/tool_result pairs through the compiled extractReceipt — args are read from a 1,200-char head, results from a 4,000-char head',
  ];
  return out;
}

// ── Runtime wiring ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

/** Stub telemetry on the loop-metrics namespace BEFORE the first decide(); abort if the overwrite did not take. */
function stubTelemetry(lm) {
  const counter = { rows: 0 };
  const one = () => { counter.rows += 1; };
  const many = (arr) => { counter.rows += Array.isArray(arr) ? arr.length : 0; };
  try { lm.recordLoopMetric = one; lm.recordLoopMetrics = many; } catch { /* reported below */ }
  if (lm.recordLoopMetric !== one || lm.recordLoopMetrics !== many) throw new Error('telemetry stub did not take (non-writable export) — refusing to run: decide() would write decision_gate rows');
  return counter;
}

function loadLiveRuntime() {
  let prisma, dg, modes, lm, wtr, sup, math, rr, ev;
  try {
    prisma = require(MOD.database).default;
    lm = require(MOD.loopMetrics);
    dg = require(MOD.decisionGate);
    modes = require(MOD.decisionGateModes);
    wtr = require(MOD.wakeTriageRequest);
    rr = require(MOD.runReceipts);
    ev = require(MOD.evidenceTools);
    try { math = require(MOD.math); } catch { math = null; }
    try { sup = require(MOD.supervisor); } catch { sup = null; }
  } catch (err) {
    const e = new Error(`runtime modules unavailable (${err && err.message}) — run inside the backend container via prodq.sh`);
    e.exitCode = 3; throw e;
  }
  if (typeof dg.decide !== 'function') throw Object.assign(new Error('decision-gate: decide not exported'), { exitCode: 3 });
  if (typeof rr.extractReceipt !== 'function' || typeof rr.receiptHeads !== 'function') throw Object.assign(new Error('run-receipts: extractReceipt/receiptHeads not exported'), { exitCode: 3 });
  if (typeof wtr.wakeTriageCodeFlags !== 'function') throw Object.assign(new Error('wake-triage-request: wakeTriageCodeFlags not exported'), { exitCode: 3 });
  const telemetry = stubTelemetry(lm);
  const classify = sup && typeof sup.classifySupervisorNote === 'function' ? sup.classifySupervisorNote : classifySupervisorNoteFallback;
  const bucketFn = math && typeof math.bucketMinutes === 'function' ? math.bucketMinutes : bucketMinutesFallback;
  return {
    kind: 'live', prisma, telemetry, classify, bucketFn,
    classifySource: classify === classifySupervisorNoteFallback ? 'probe-copy-2026-09-27' : 'compiled',
    codeFlags: (rows, now) => wtr.wakeTriageCodeFlags(rows, now),
    extractReceipt: rr.extractReceipt, receiptHeads: rr.receiptHeads,
    isEvidenceToolName: typeof ev.isEvidenceToolName === 'function' ? ev.isEvidenceToolName : (n) => !!n,
    decide: (state, questions, spec, sessionId, candidate) => dg.decide(state, questions, { purpose: 'probe', timeoutMs: DECIDE_TIMEOUT_MS, sessionId, spec, memo: false, meta: { probeCandidate: candidate } }),
    decisionMode: async () => {
      try { if (typeof modes.refreshDecisionModes === 'function') await modes.refreshDecisionModes(); } catch { /* env fallback */ }
      try { return typeof dg.decisionModeWithSource === 'function' ? dg.decisionModeWithSource('probe') : { mode: 'act', source: 'probe' }; } catch { return { mode: 'unknown', source: 'unknown' }; }
    },
    disconnect: async () => { try { await prisma.$disconnect(); } catch { /* ignore */ } },
  };
}

// ── Data access (tagged SQL so the dry-run stub can dispatch) ────────────────

const SQL = {
  notesCount: `/* q:notesCount */
SELECT count(*)::int AS n, meta->>'origin' AS origin
FROM loop_metrics
WHERE kind IN ('supervisor_noop','supervisor_action','supervisor_note') AND meta->>'origin' IN ('schedule','agent')
  AND "createdAt" >= $1::timestamp AND "createdAt" <= $2::timestamp
GROUP BY 2`,
  notes: `/* q:notes */
SELECT m.id, m.kind, m."sessionId" AS chat_id, m.meta->>'origin' AS origin, m."createdAt" AS metric_at, m.meta->>'messageId' AS msg_prefix,
       c."userId" AS user_id, c."projectId" AS project_id, c."isSupervisor" AS is_supervisor, c."isProjectSupervisor" AS is_project_supervisor,
       x.id AS note_id, x."createdAt" AS note_at, (x.metadata->>'synthesisTime')::float AS synth_ms
FROM loop_metrics m
JOIN crossmodel_chats c ON c.id = m."sessionId"
LEFT JOIN LATERAL (
  SELECT y.id, y."createdAt", y.metadata FROM crossmodel_messages y
  WHERE y."chatId" = m."sessionId" AND y.role = 'assistant' AND y.id::text LIKE (m.meta->>'messageId') || '%'
  ORDER BY y."createdAt" DESC LIMIT 1
) x ON true
WHERE m.kind IN ('supervisor_noop','supervisor_action','supervisor_note') AND m.meta->>'origin' IN ('schedule','agent')
  AND m."createdAt" >= $1::timestamp AND m."createdAt" <= $2::timestamp
  AND (m."createdAt", m.id) > ($3::timestamp, $4::text)
ORDER BY m."createdAt", m.id
LIMIT $5::int`,
  prevNotes: `/* q:prevNotes */
SELECT y.id, y."createdAt", y.content, y.metadata->>'origin' AS origin FROM crossmodel_messages y
WHERE y."chatId" = $1::text AND y.role = 'assistant' AND (y."createdAt", y.id) < ($2::timestamp, $3::text)
  AND y.metadata->>'origin' IN ('schedule','hook','agent','machine','webhook')
ORDER BY y."createdAt" DESC, y.id DESC LIMIT 4`,
  prevUser: `/* q:prevUser */
SELECT y.id, y."createdAt", y.content, y.metadata->>'origin' AS origin FROM crossmodel_messages y
WHERE y."chatId" = $1::text AND y.role = 'user' AND (y."createdAt", y.id) < ($2::timestamp, $3::text)
ORDER BY y."createdAt" DESC, y.id DESC LIMIT 1`,
  hookEvents: `/* q:hookEvents */
SELECT e.id, h."targetChatId" AS target, e."eventType", e.payload, e."createdAt", e.status
FROM hook_events e JOIN event_hooks h ON h.id = e."hookId"
WHERE e."createdAt" >= $1::timestamp AND e."createdAt" <= $2::timestamp
ORDER BY e."createdAt" LIMIT 40000`,
  agentRuns: `/* q:agentRuns */
SELECT r.id, r."sessionId", r.status, r."startedAt", r."finishedAt", r."createdAt", left(r.error, 160) AS error, c."userId" AS user_id, c."projectId" AS project_id
FROM agent_runs r JOIN crossmodel_chats c ON c.id = r."sessionId"
WHERE (r."createdAt" >= $1::timestamp OR r."finishedAt" >= $1::timestamp OR r.status IN ('running','queued')) AND r."createdAt" <= $2::timestamp
LIMIT 80000`,
  ownerAsks: `/* q:ownerAsks */
SELECT "userId" AS user_id, "chatId" AS chat_id, status, "createdAt", "resolvedAt"
FROM owner_questions WHERE "createdAt" <= $2::timestamp AND ("resolvedAt" IS NULL OR "resolvedAt" >= $1::timestamp) LIMIT 10000`,
  tickets: `/* q:tickets */
SELECT "userId" AS user_id, "createdAt" FROM user_feature_requests WHERE "createdAt" >= $1::timestamp AND "createdAt" <= $2::timestamp LIMIT 40000`,
  supMetrics: `/* q:supMetrics */
SELECT "sessionId" AS chat_id, kind, "createdAt" FROM loop_metrics
WHERE kind IN ('supervisor_noop','supervisor_action','supervisor_note') AND "createdAt" >= $1::timestamp AND "createdAt" <= $2::timestamp LIMIT 60000`,
  supSpend: `/* q:supSpend */
SELECT m."sessionId" AS chat_id, m.value, m."createdAt" FROM loop_metrics m
WHERE m.kind = 'run_spend' AND m."createdAt" >= $1::timestamp AND m."createdAt" <= $2::timestamp
  AND m."sessionId" IN (SELECT id FROM crossmodel_chats WHERE "isSupervisor" OR "isProjectSupervisor")
ORDER BY m."createdAt" LIMIT 60000`,
  auditsCount: `/* q:auditsCount */
SELECT count(*)::int AS n, count(*) FILTER (WHERE meta ? 'selfAuditDecisionId')::int AS stamped
FROM loop_metrics WHERE kind = 'self_audit_run' AND "runId" IS NOT NULL AND "createdAt" >= $1::timestamp AND "createdAt" <= $2::timestamp`,
  audits: `/* q:audits */
SELECT m.id, m."runId" AS run_id, m."sessionId" AS chat_id, m."createdAt", m.meta
FROM loop_metrics m
WHERE m.kind = 'self_audit_run' AND m."runId" IS NOT NULL AND m."createdAt" >= $1::timestamp AND m."createdAt" <= $2::timestamp
  AND (m."createdAt", m.id) > ($3::timestamp, $4::text)
ORDER BY m."createdAt", m.id LIMIT $5::int`,
  events: `/* q:events */
SELECT e.seq, e.type, e."createdAt", e.payload->>'message' AS message, e.payload->>'name' AS name,
       left((e.payload->'args')::text, 1200) AS args, left(e.payload->>'result', 4000) AS result, e.payload->>'delta' AS delta,
       CASE WHEN e.type = 'plan_update' THEN e.payload->'plan' END AS plan,
       e.payload->>'passed' AS passed, e.payload->>'failedStage' AS failed_stage
FROM agent_events e
WHERE e."runId" = $1::text AND e.type IN ('progress','plan_update','tool_call','tool_result','text','complete','verify_result','guard_marker','draft_discarded')
ORDER BY e.seq`,
  planFallback: `/* q:planFallback */
SELECT e.payload->'plan' AS plan FROM agent_runs r JOIN agent_events e ON e."runId" = r.id
WHERE r."sessionId" = $1::text AND r."createdAt" < $2::timestamp AND e.type = 'plan_update'
ORDER BY r."createdAt" DESC, e.seq DESC LIMIT 1`,
  auditOutcome: `/* q:auditOutcome */
SELECT meta->>'question' AS question, meta->>'actual' AS actual FROM loop_metrics
WHERE kind = 'decision_gate' AND meta->>'purpose' = 'self_audit' AND meta->>'phase' = 'outcome' AND meta->>'question' = 'steps_unbacked'
  AND meta->>'id' = $1::text AND "createdAt" >= $2::timestamp AND "createdAt" <= $3::timestamp LIMIT 1`,
  runSpend: `/* q:runSpend */
SELECT value FROM loop_metrics WHERE kind = 'run_spend' AND "createdAt" >= $2::timestamp AND "createdAt" <= $3::timestamp
  AND ("runId" = $1::text OR meta->>'runId' = $1::text OR ($4::text <> '' AND meta->>'selfAuditDecisionId' = $4::text))
ORDER BY "createdAt" LIMIT 1`,
  auxLeak: `/* q:auxLeak */
SELECT count(*)::int AS n, count(*) FILTER (WHERE "sessionId" LIKE 'backtest:%')::int AS backtest_leak
FROM loop_metrics WHERE kind = 'decision_gate' AND meta->>'purpose' = 'probe' AND "createdAt" >= $1::timestamp AND "createdAt" <= $2::timestamp`,
};

const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const ms = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/** Preloaded side tables for supervisor_turn_noop (one read per invocation). */
async function preloadTurnNoop(q, window) {
  const from = iso(ms(window.from) - TARGET_HISTORY_MS - WINDOW_CAP_MS), to = window.to;
  const [hooks, runs, asks, tickets, sup, spend] = await Promise.all([
    q(SQL.hookEvents, iso(ms(window.from) - WINDOW_CAP_MS), to), q(SQL.agentRuns, iso(ms(window.from) - WINDOW_CAP_MS), to),
    q(SQL.ownerAsks, iso(ms(window.from) - WINDOW_CAP_MS), to), q(SQL.tickets, iso(ms(window.from) - WINDOW_CAP_MS), to),
    q(SQL.supMetrics, from, to), q(SQL.supSpend, iso(ms(window.from) - SPEND_JOIN_BEFORE_MS), iso(ms(window.to) + SPEND_JOIN_AFTER_MS)),
  ]);
  const hooksByTarget = new Map();
  for (const h of hooks || []) { const l = hooksByTarget.get(h.target) || []; l.push({ id: h.id, eventType: h.eventType, payload: h.payload || {}, createdAt: h.createdAt, status: h.status, t: ms(h.createdAt) }); hooksByTarget.set(h.target, l); }
  const runsBySession = new Map(); const runsByUser = new Map(); const runsByProject = new Map();
  for (const r of runs || []) {
    const push = (m, k) => { if (!k) return; const l = m.get(k) || []; l.push(r); m.set(k, l); };
    push(runsBySession, r.sessionId); push(runsByUser, r.user_id); push(runsByProject, r.project_id);
  }
  const supBySession = new Map();
  for (const s of sup || []) { const l = supBySession.get(s.chat_id) || []; l.push({ kind: s.kind, t: ms(s.createdAt) }); supBySession.set(s.chat_id, l); }
  const spendBySession = new Map();
  for (const s of spend || []) { const l = spendBySession.get(s.chat_id) || []; l.push({ usd: Number(s.value), t: ms(s.createdAt), used: false }); spendBySession.set(s.chat_id, l); }
  return { hooksByTarget, runsBySession, runsByUser, runsByProject, asks: (asks || []).map(a => ({ ...a, t: ms(a.createdAt), r: a.resolvedAt ? ms(a.resolvedAt) : null })), tickets: (tickets || []).map(t => ({ user_id: t.user_id, t: ms(t.createdAt) })), supBySession, spendBySession, sizes: { hooks: (hooks || []).length, runs: (runs || []).length, asks: (asks || []).length, tickets: (tickets || []).length, sup: (sup || []).length, spend: (spend || []).length } };
}

/** Score one supervisor note row; returns the compact tuple (no ids / text) or a skip reason. */
async function scoreTurnNoopRow(rt, pre, salt, r, gateCall) {
  if (!r.note_id) return { skip: 'note_row_not_found' };
  const noteAt = ms(r.note_at);
  const chatId = String(r.chat_id);
  const prev = await rt.q(SQL.prevNotes, chatId, iso(r.note_at), String(r.note_id));
  const prevUser = await rt.q(SQL.prevUser, chatId, iso(r.note_at), String(r.note_id));
  const user = prevUser && prevUser[0];
  const userAt = user ? ms(user.createdAt) : NaN;
  const synth = Number(r.synth_ms);
  // turn start: the machine user row when it is within 2 h before the note, else note − synthesisTime, else the note
  const t0 = Number.isFinite(userAt) && noteAt - userAt < 2 * 3600e3 ? userAt : Number.isFinite(synth) && synth > 0 ? noteAt - synth : noteAt;
  const prevMachine = (prev || [])[0];
  const since = Math.max(prevMachine ? ms(prevMachine.createdAt) : t0 - WINDOW_CAP_MS, t0 - WINDOW_CAP_MS);
  const origin = String(r.origin);
  let seg = origin === 'agent' ? 'agent_drain' : 'schedule_other';
  const userContent = user ? String(user.content || '') : '';
  if (origin === 'schedule') {
    if (userContent.includes('Fleet Supervisor sweep') || userContent.includes('Project Supervisor sweep')) seg = 'schedule_sweep';
  }
  // pending inputs
  let pendingRows = [];
  if (seg === 'agent_drain') {
    if (!user || String(user.origin || '') !== 'agent') return { skip: 'drain_user_row_not_found' };
    pendingRows = splitDrainBodies(userContent).map(b => ({ eventType: 'agent_message', sourceChatId: b.source, summary: b.body, depth: 0, createdAt: null }));
  } else {
    const all = pre.hooksByTarget.get(chatId) || [];
    pendingRows = all.filter(h => h.t > since && h.t <= t0).map(h => ({ eventType: h.eventType, sourceChatId: h.payload.sourceChatId, summary: h.payload.summary, depth: h.payload.depth, createdAt: h.createdAt, payload: h.payload }));
  }
  const pendingTotal = pendingRows.length;
  const pending = pendingInputRows(pendingRows, salt, t0, rt.bucketFn);
  const pins = pendingPins(pendingRows);
  let flags = null;
  try { const cf = rt.codeFlags(pendingRows.map(p => ({ id: p.sourceChatId || 'x', eventType: p.eventType, payload: { summary: p.summary, sourceChatId: p.sourceChatId, eventType: p.eventType }, createdAt: p.createdAt || new Date(t0) })), t0); flags = { any_question_or_request: cf.any_row_is_question_or_request, any_addressed_to_supervisor: cf.any_row_addressed_to_supervisor, any_failure_or_block: cf.any_row_reports_failure_or_block, any_guard_replaced_final: cf.any_row_guard_replaced_final, any_owner_facing: cf.any_row_owner_facing, distinct_sources: cf.distinct_sources, ...pins }; }
  catch { flags = { ...pins }; }
  const notes = (prev || []).slice(0, PREV_NOTES);
  const previousNotes = notes.map(n => ({ kind: rt.classify(n.content), head: String(n.content || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_HEAD_CHARS) }));
  const newInput = newInputShare(pendingRows.map(p => p.summary), notes.map(n => n.content));
  const sources = [...new Set(pendingRows.map(p => p.sourceChatId).filter(Boolean))].slice(0, 3);
  const sourceLanes = sources.map(s => ({ chat_id: hash8(salt, s), last_run: laneFacts(pre.runsBySession.get(s) || [], t0, rt.bucketFn) }));
  const scopeRuns = r.is_project_supervisor && r.project_id ? pre.runsByProject.get(r.project_id) || [] : pre.runsByUser.get(r.user_id) || [];
  const board = boardCounts(scopeRuns.filter(x => x.sessionId !== chatId), since, t0);
  const asks = pre.asks.filter(a => a.user_id === r.user_id && a.t <= t0 && (a.r === null || a.r > t0) && (!(r.is_project_supervisor && r.project_id) || true));
  board.owner_asks_open = asks.length;
  board.owner_asks_new_since = asks.filter(a => a.t > since).length;
  board.tickets_filed_since = pre.tickets.filter(t => t.user_id === r.user_id && t.t > since && t.t <= t0).length;
  board.hook_events_since = (pre.hooksByTarget.get(chatId) || []).filter(h => h.t > since && h.t <= t0).length;
  const history = targetHistory(pre.supBySession.get(chatId) || [], t0);
  const state = buildTurnNoopState({
    target: r.is_supervisor ? 'fleet supervisor chat' : r.is_project_supervisor ? 'project supervisor chat' : 'supervised chat',
    origin: seg === 'schedule_sweep' ? 'scheduled supervisor sweep' : seg === 'schedule_other' ? 'self-scheduled firing' : 'agent-message drain',
    windowMin: Math.max(0, Math.round((t0 - since) / 60000)), pendingTotal, pending, flags, newInput, sourceLanes, board, history, previousNotes,
  });
  // $ join: earliest unconsumed run_spend on this chat within [note − 60 s, note + 30 min]
  let usd = null;
  for (const s of pre.spendBySession.get(chatId) || []) { if (s.used || s.t < noteAt - SPEND_JOIN_BEFORE_MS || s.t > noteAt + SPEND_JOIN_AFTER_MS) continue; s.used = true; usd = s.usd; break; }
  const gate = await gateCall(state, TURN_NOOP_QUESTIONS);
  const answers = gate && gate.ok ? gate.answers : null;
  const pw = answers && answers.will_act ? Number(answers.will_act.noul) : NaN;
  const ph = answers && answers.has_new_input ? Number(answers.has_new_input.noul) : NaN;
  return {
    tuple: {
      g: gate && gate.ok ? 1 : 0, o: seg, t: r.is_supervisor ? 'fleet' : r.is_project_supervisor ? 'project' : 'other',
      a: r.kind === 'supervisor_noop' ? 0 : 1, k: String(r.kind).replace('supervisor_', ''),
      pw: Number.isFinite(pw) ? r4(pw) : null, ph: Number.isFinite(ph) ? r4(ph) : null,
      hn: newInput.hasNewInput ? 1 : 0, ns: newInput.share, pin: pins.pinned ? 1 : 0, al: pins.any_alarm ? 1 : 0,
      np: pendingTotal, usd: Number.isFinite(usd) ? r4(usd) : null, min: Number.isFinite(synth) ? synth : null, win: state.minutes_since_previous_turn,
      h7: history.turns_7d, cn: history.consecutive_noops,
    },
    gate,
  };
}

/** Score one self_audit_run row; returns the compact tuple or a skip reason. */
async function scoreAuditRow(rt, salt, r, window, gateCall) {
  const runId = String(r.run_id);
  const events = await rt.q(SQL.events, runId);
  if (!events || !events.length) return { skip: 'no_agent_events' };
  let fallbackPlan = null;
  if (!events.some(e => e.type === 'plan_update' && e.plan)) {
    try { const fb = await rt.q(SQL.planFallback, String(r.chat_id), iso(r.createdAt)); fallbackPlan = fb && fb[0] ? fb[0].plan : null; } catch { fallbackPlan = null; }
  }
  const pt = rebuildAuditPoint(events, { fallbackPlan, extractReceipt: rt.extractReceipt, receiptHeads: rt.receiptHeads, isEvidenceToolName: rt.isEvidenceToolName });
  if (!pt.ok) return { skip: pt.reason };
  if (!pt.completedBefore.length) return { skip: 'no_completed_steps_at_grant' };
  const meta = r.meta && typeof r.meta === 'object' ? r.meta : {};
  const req = buildAuditRequest(pt, meta);
  // harness label cross-check (E5-stamped rows only)
  let harness = null;
  if (meta.selfAuditDecisionId) {
    try { const o = await rt.q(SQL.auditOutcome, String(meta.selfAuditDecisionId), iso(r.createdAt), iso(ms(r.createdAt) + 6 * 3600e3)); if (o && o[0]) harness = String(o[0].actual) === 'true' ? 1 : String(o[0].actual) === 'false' ? 0 : null; } catch { harness = null; }
  }
  let shed = null;
  if (Number.isFinite(Number(meta.costUsdBefore))) {
    try { const s = await rt.q(SQL.runSpend, runId, iso(r.createdAt), iso(ms(r.createdAt) + 6 * 3600e3), String(meta.selfAuditDecisionId || '')); if (s && s[0] && Number.isFinite(Number(s[0].value))) shed = Math.max(0, Number(s[0].value) - Number(meta.costUsdBefore)); } catch { shed = null; }
  }
  const rmin = pt.grantAt && pt.completeAt ? Math.max(0, (ms(pt.completeAt) - ms(pt.grantAt)) / 60000) : null;
  const gate = await gateCall(req.state, req.questions);
  const answers = gate && gate.ok ? Object.fromEntries(Object.entries(gate.answers).map(([k, a]) => [k, a && a.type === 'noul' ? r4(Number(a.noul)) : null])) : null;
  return {
    tuple: {
      g: gate && gate.ok ? 1 : 0, re: pt.reopened.length > 0 ? 1 : 0, nr: pt.reopened.length, gs: pt.guardAfter, pa: pt.planAfterSeen ? 1 : 0,
      k: req.reviewedCount, kj: req.join.filter(j => j.receipted).length, allj: req.allReceipted ? 1 : 0, ect: req.ectSkip ? 1 : 0,
      v: pt.lastVerify ? (pt.lastVerify.passed ? 1 : 0) : null, nrc: pt.receipts.length, ev: pt.evidenceCalls,
      ans: answers, hl: harness, shed: shed !== null ? r4(shed) : null, rmin: rmin !== null ? r4(rmin) : null, st: meta.selfAuditDecisionId ? 1 : 0,
    },
    gate,
  };
}

// ── One batch per candidate ──────────────────────────────────────────────────

async function runBatch(rt, cfg, cursorState, candidate) {
  const { runId, spec, batch, salt, window, cap } = cursorState;
  const cstate = cursorState.candidates[candidate];
  const agg = newAgg({ runId, spec, candidate, batchIndex: cstate.batchIndex, window, cap });
  const q = (sql, ...params) => rt.prisma.$queryRawUnsafe(sql, ...params);
  rt.q = q;
  let cursor = cstate.cursor || { createdAt: '1970-01-01T00:00:00.000Z', id: '' };
  let scored = 0; let gateDead = 0; let done = false;
  if (cstate.batchIndex === 0) {
    agg.aux = {};
    try { const g = await q(SQL.auxLeak, window.from, iso(Date.now() + 3600e3)); const x = g && g[0]; if (x) agg.aux = { probeDecisionRowsInWindow: Number(x.n), backtestLeakRows: Number(x.backtest_leak) }; } catch (e) { agg.aux = { error: String(e.message || e).slice(0, 120) }; }
  }
  // population + sampling rate (deterministic, salted) so the cap spreads over the window
  if (!cstate.totals) {
    if (candidate === 'supervisor_turn_noop') {
      const rows = await q(SQL.notesCount, window.from, window.to);
      const byOrigin = {}; let eligible = 0;
      for (const x of rows || []) { byOrigin[x.origin] = Number(x.n); eligible += Number(x.n); }
      cstate.totals = { eligible, byOrigin, sampleRate: eligible ? Math.min(1, (cap * 1.15) / eligible) : 1 };
    } else {
      const rows = await q(SQL.auditsCount, window.from, window.to);
      const x = (rows && rows[0]) || { n: 0, stamped: 0 };
      const eligible = Number(x.n), stamped = Number(x.stamped), other = Math.max(0, eligible - stamped);
      const half = cap / 2;
      cstate.totals = { eligible, stamped, sampleRateStamped: stamped ? Math.min(1, (half * 1.15) / stamped) : 1, sampleRateOther: other ? Math.min(1, ((cap - Math.min(half, stamped)) * 1.15) / other) : 1 };
    }
  }
  agg.totals = cstate.totals;
  const remaining = () => Math.max(0, cap - cstate.scoredTotal - scored);
  const gateCall = async (state, questions) => {
    const t0 = Date.now();
    const gate = { ok: false };
    try {
      const res = await rt.decide(state, questions, spec, `backtest:${runId}`, candidate);
      const wall = Date.now() - t0;
      if (!res) { gate.nullResult = true; gate.ms = wall; gateDead += 1; }
      else {
        gate.ms = Number.isFinite(res.ms) ? res.ms : wall;
        gate.backend = res.backendSpec || res.backend || null; gate.mode = res.mode || null; gate.calibrated = !!res.calibrated;
        const answers = res.answers || {};
        if (Object.keys(answers).some(k => answers[k] && answers[k].type === 'noul')) { gate.ok = true; gateDead = 0; gate.answers = answers; }
        else gate.error = 'no noul answers';
      }
    } catch (err) { gate.error = String(err && err.message || err).slice(0, 80); gate.ms = Date.now() - t0; }
    if (gateDead >= 3) agg.gateUnavailable = 'decide() returned null 3× in a row (gate disabled or no servable backend for the spec)';
    const elapsed = Date.now() - t0;
    if (cfg.floorMs > 0 && elapsed < cfg.floorMs) await sleep(cfg.floorMs - elapsed);
    return gate;
  };
  let pre = null;
  if (candidate === 'supervisor_turn_noop') pre = cursorState.preload || (cursorState.preload = await preloadTurnNoop(q, window));
  while (scored < batch && remaining() > 0 && !done && !agg.gateUnavailable) {
    const want = Math.min(500, Math.max(50, batch * 4));
    const rows = candidate === 'supervisor_turn_noop'
      ? await q(SQL.notes, window.from, window.to, cursor.createdAt, cursor.id, want)
      : await q(SQL.audits, window.from, window.to, cursor.createdAt, cursor.id, want);
    if (!rows || !rows.length) { done = true; break; }
    agg.rowsScanned += rows.length;
    const last = rows[rows.length - 1];
    cursor = { createdAt: iso(last.metric_at || last.createdAt), id: String(last.id) };
    for (const r of rows) {
      if (scored >= batch || remaining() <= 0 || agg.gateUnavailable) break;
      const rate = candidate === 'supervisor_turn_noop' ? cstate.totals.sampleRate : (r.meta && r.meta.selfAuditDecisionId ? cstate.totals.sampleRateStamped : cstate.totals.sampleRateOther);
      if (!sampleKeep(salt, String(r.id), rate)) { bump(agg.skipped, 'not_sampled'); continue; }
      let out;
      try { out = candidate === 'supervisor_turn_noop' ? await scoreTurnNoopRow(rt, pre, salt, r, gateCall) : await scoreAuditRow(rt, salt, r, window, gateCall); }
      catch (err) { bump(agg.skipped, 'score_error'); if (!agg.firstError) agg.firstError = String(err && err.message || err).slice(0, 200); continue; }
      if (out.skip) { bump(agg.skipped, out.skip); continue; }
      noteGate(agg, out.gate);
      agg.rows.push(out.tuple);
      agg.rowsScored += 1; scored += 1;
    }
    if (rows.length < want) done = true;
  }
  if (remaining() <= 0) done = true;
  agg.cursor = cursor; agg.done = done;
  agg.telemetryStubbedRows = rt.telemetry ? rt.telemetry.rows : null;
  return agg;
}

// ── Cursor / output files ────────────────────────────────────────────────────

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 1)); }
function defaultRunId(days) { const d = new Date().toISOString().slice(0, 10).replace(/-/g, ''); return `ad-${d}-${days}d`; }

function parseArgs(argv) {
  const flags = { dryRun: false, merge: null, runId: null, outDir: null, help: false, candidate: 'all', cap: DEFAULT_CAP };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--merge') { flags.merge = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else if (a === '--run-id') flags.runId = argv[++i];
    else if (a === '--out-dir') flags.outDir = argv[++i];
    else if (a === '--candidate') flags.candidate = argv[++i];
    else if (a === '--cap') flags.cap = Number(argv[++i]);
    else if (a.startsWith('--')) throw Object.assign(new Error(`unknown flag ${a}`), { exitCode: 2 });
    else pos.push(a);
  }
  const days = pos[0] !== undefined ? Number(pos[0]) : DEFAULT_DAYS;
  const spec = pos[1] || DEFAULT_SPEC;
  const batch = pos[2] !== undefined ? Number(pos[2]) : DEFAULT_BATCH;
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw Object.assign(new Error('days must be 1..365'), { exitCode: 2 });
  if (!Number.isFinite(batch) || batch <= 0 || batch > 5000) throw Object.assign(new Error('batch must be 1..5000'), { exitCode: 2 });
  if (!Number.isFinite(flags.cap) || flags.cap <= 0 || flags.cap > 20000) throw Object.assign(new Error('cap must be 1..20000'), { exitCode: 2 });
  if (flags.candidate !== 'all' && !CANDIDATES.includes(flags.candidate)) throw Object.assign(new Error(`candidate must be all|${CANDIDATES.join('|')}`), { exitCode: 2 });
  return { ...flags, days, spec, batch };
}

const USAGE = `usage: backtest-agent-decisions.js <days=14> <spec=jev> [batch=200] [--cap 400] [--candidate all|supervisor_turn_noop|audit_round_skip] [--run-id X] [--out-dir D]
       backtest-agent-decisions.js --merge [runId|path.jsonl] [--out-dir D]
       backtest-agent-decisions.js --dry-run
Each invocation scores one batch per candidate and appends one aggregate line per candidate to <out-dir>/<runId>.jsonl; re-run until it prints done:true, then --merge.`;

function mergeLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const by = {}; let lines = 0;
  for (const line of text.split('\n')) {
    const t = line.trim(); if (!t) continue;
    const obj = JSON.parse(t);
    if (obj.probe !== 'backtest-agent-decisions' || !obj.candidate) continue;
    by[obj.candidate] = mergeAgg(by[obj.candidate], obj); lines += 1;
  }
  if (!lines) throw Object.assign(new Error(`no aggregate lines in ${file}`), { exitCode: 2 });
  for (const k of Object.keys(by)) by[k].batches = by[k].batches || 1;
  return by;
}

/** One invocation on a live runtime (or the dry-run stub): load/extend the cursor, score a batch per candidate, append the lines. */
async function runOnce(rt, args, opts = {}) {
  const outDir = args.outDir || DEFAULT_OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const pointer = path.join(outDir, LATEST_POINTER);
  const runId = args.runId || process.env.AD_BACKTEST_RUN_ID || (fs.existsSync(pointer) ? fs.readFileSync(pointer, 'utf8').trim() : '') || defaultRunId(args.days);
  const cursorFile = path.join(outDir, `${runId}.cursor.json`);
  let state = readJson(cursorFile);
  if (!state) {
    const to = new Date(opts.now || Date.now());
    const from = new Date(to.getTime() - args.days * 86400e3);
    state = { runId, spec: args.spec, days: args.days, batch: args.batch, cap: args.cap, salt: crypto.randomBytes(16).toString('hex'), window: { from: from.toISOString(), to: to.toISOString(), days: args.days }, candidates: Object.fromEntries(CANDIDATES.map(k => [k, { batchIndex: 0, cursor: null, done: false, scoredTotal: 0, totals: null }])), decisionMode: null, startedAt: new Date().toISOString() };
    fs.writeFileSync(pointer, runId);
  }
  const keys = args.candidate === 'all' ? CANDIDATES : [args.candidate];
  if (keys.every(k => state.candidates[k].done)) return { done: true, runId: state.runId, message: `run ${state.runId} is complete — use --merge ${state.runId}` };
  if (!state.decisionMode) state.decisionMode = await rt.decisionMode();
  state.batch = args.batch; state.cap = args.cap;
  const jsonl = path.join(outDir, `${state.runId}.jsonl`);
  const summary = { done: false, runId: state.runId, spec: state.spec, decisionMode: state.decisionMode, window: state.window, candidates: {}, jsonl, cursorFile };
  for (const k of keys) {
    const c = state.candidates[k];
    if (c.done) { summary.candidates[k] = { done: true, scoredTotal: c.scoredTotal }; continue; }
    const agg = await runBatch(rt, { floorMs: opts.floorMs ?? CALL_FLOOR_MS }, state, k);
    fs.appendFileSync(jsonl, JSON.stringify(agg) + '\n');
    c.batchIndex += 1; c.cursor = agg.cursor; c.done = !!agg.done; c.scoredTotal += agg.rowsScored; c.lastBatchAt = new Date().toISOString();
    summary.candidates[k] = { done: c.done, batchIndex: c.batchIndex, rowsScanned: agg.rowsScanned, rowsScored: agg.rowsScored, scoredTotal: c.scoredTotal, skipped: agg.skipped, gateOk: agg.gate.ok, gateErrors: agg.gate.errors + agg.gate.nullResults, gateUnavailable: agg.gateUnavailable || null, firstError: agg.firstError || null, totals: agg.totals };
  }
  delete state.preload;
  summary.done = keys.every(k => state.candidates[k].done);
  summary.telemetryStubbedRows = rt.telemetry ? rt.telemetry.rows : null;
  writeJson(cursorFile, state);
  return summary;
}

// ── Dry run: synthetic corpus + stubbed Prisma + stubbed decide ─────────────

function buildDryRuntime(seed = 7) {
  const rnd = mulberry32(seed);
  const base = Date.parse('2026-09-13T00:00:00.000Z');
  const chats = Array.from({ length: 6 }, (_, i) => ({ id: `chat-${i}-SYNTHETIC`, userId: `user-${i % 2}-SYNTHETIC`, projectId: i % 3 === 0 ? null : `proj-${i}`, isSupervisor: i % 3 === 0, isProjectSupervisor: i % 3 !== 0 }));
  const metrics = []; const messages = []; const hooks = []; const runs = []; const spend = [];
  let n = 0;
  for (const c of chats) {
    let t = base + Math.floor(rnd() * 3) * 3600e3;
    for (let i = 0; i < 60; i++) {
      t += 20 * 60e3 + Math.floor(rnd() * 90 * 60e3);
      const origin = rnd() < 0.5 ? 'schedule' : 'agent';
      const noop = rnd() < 0.58;
      const kind = noop ? 'supervisor_noop' : rnd() < 0.85 ? 'supervisor_action' : 'supervisor_note';
      const noteId = `note-${n}-aaaaaaaa`;
      const userContent = origin === 'schedule'
        ? `[MACHINE-TRIGGERED RUN] Fleet Supervisor sweep — SYNTHETIC ${n}`
        : `[2 agent messages arrived while this chat was busy — coalesced into ONE turn.]\n\n[AGENT-SENT MESSAGE — from chat "Lane A" (abcdef01) in project "x", another Digby agent, NOT the owner.] lane report ${n}: ${noop ? 'status unchanged, still running' : 'run FAILED with exit code 2, please advise'}\n\n— — —\n\n[queued agent message from chat abcdef02 — another Digby agent] progress ${n}`;
      messages.push({ id: `user-${n}`, chatId: c.id, role: 'user', createdAt: new Date(t - 5 * 60e3), content: userContent, origin });
      messages.push({ id: noteId, chatId: c.id, role: 'assistant', createdAt: new Date(t), content: noop ? 'SWEEP: no-op — nothing moved.' : `ACTIONS TAKEN (1): sent steer to lane ${n} about the failed run and re-armed the cadence to 60 minutes with receipts.`, origin, synthesisTime: 60e3 + rnd() * 300e3 });
      metrics.push({ id: `m-${n}`, kind, chatId: c.id, origin, createdAt: new Date(t + 60e3), msgPrefix: noteId.slice(0, 8), chat: c });
      if (origin === 'schedule' && rnd() < 0.7) hooks.push({ id: `h-${n}`, target: c.id, eventType: rnd() < 0.15 ? 'run_failed' : 'run_completed', payload: { sourceChatId: `lane-${n % 4}`, summary: noop ? `lane ${n % 4} finished routine tick` : `lane ${n % 4} FAILED: exit code 2 — needs the supervisor`, depth: 1 }, createdAt: new Date(t - 30 * 60e3), status: 'delivered' });
      runs.push({ id: `run-${n}`, sessionId: `lane-${n % 4}`, status: rnd() < 0.8 ? 'completed' : 'failed', startedAt: new Date(t - 50 * 60e3), finishedAt: new Date(t - 20 * 60e3), createdAt: new Date(t - 51 * 60e3), error: null, user_id: c.userId, project_id: c.projectId });
      if (rnd() < 0.8) spend.push({ chat_id: c.id, value: 0.1 + rnd() * 0.4, createdAt: new Date(t + 10e3) });
      n += 1;
    }
  }
  // audits
  const audits = []; const eventsByRun = new Map();
  for (let i = 0; i < 90; i++) {
    const t = base + i * 3 * 3600e3;
    const runId = `arun-${i}`;
    const steps = [1, 2, 3].map(k => ({ id: k, status: k <= 2 ? 'completed' : 'pending', text: k === 1 ? `commit the fix to src/thing_${i}.ts and push` : k === 2 ? `open PR #${100 + i} for the change` : 'wait for review' }));
    const reopen = rnd() < 0.04;
    const after = steps.map(s => ({ ...s, status: reopen && s.id === 2 ? 'in_progress' : s.status }));
    const ev = [
      { seq: 1, type: 'progress', message: 'start', createdAt: new Date(t) },
      { seq: 2, type: 'plan_update', plan: { goal: 'g', steps }, createdAt: new Date(t + 1000) },
      { seq: 3, type: 'tool_call', name: 'git_commit', args: JSON.stringify({ message: `fix src/thing_${i}.ts` }), createdAt: new Date(t + 2000) },
      { seq: 4, type: 'tool_result', name: 'git_commit', result: `[digby/session 1a2b3c${i}] fix src/thing_${i}.ts\n 1 file changed`, createdAt: new Date(t + 3000) },
      ...(rnd() < 0.7 ? [{ seq: 5, type: 'tool_call', name: 'open_pull_request', args: JSON.stringify({ title: `PR ${i}` }), createdAt: new Date(t + 4000) }, { seq: 6, type: 'tool_result', name: 'open_pull_request', result: JSON.stringify({ ok: true, tool: 'open_pull_request', ids: { prNumber: 100 + i } }), createdAt: new Date(t + 5000) }] : []),
      { seq: 7, type: 'text', delta: `Done: committed src/thing_${i}.ts and opened PR #${100 + i}.`, createdAt: new Date(t + 6000) },
      { seq: 8, type: 'progress', message: 'Auto-audit: double-checking the work really meets the goal…', createdAt: new Date(t + 7000) },
      ...(reopen ? [{ seq: 9, type: 'plan_update', plan: { goal: 'g', steps: after }, createdAt: new Date(t + 8000) }] : []),
      { seq: 10, type: 'complete', createdAt: new Date(t + 9 * 60e3) },
    ];
    eventsByRun.set(runId, ev);
    const stamped = i % 2 === 0;
    audits.push({ id: `sa-${i}`, run_id: runId, chat_id: `lane-${i % 4}`, createdAt: new Date(t + 7000), meta: stamped ? { costUsdBefore: 0.5 + rnd(), turnsBefore: 10 + i, selfAuditDecisionId: `dec${i}` } : { turnsBefore: 5 } });
    if (stamped) { metrics.push({ id: `dg-${i}`, kind: 'decision_gate', decisionId: `dec${i}`, question: 'steps_unbacked', actual: reopen ? 'true' : 'false', createdAt: new Date(t + 10 * 60e3) }); spend.push({ chat_id: `lane-${i % 4}`, runId, value: 1.2 + rnd(), createdAt: new Date(t + 12 * 60e3) }); }
  }
  const inWin = (d, from, to) => new Date(d) >= new Date(from) && new Date(d) <= new Date(to);
  const supKinds = new Set(['supervisor_noop', 'supervisor_action', 'supervisor_note']);
  const prisma = {
    async $queryRawUnsafe(sql, ...p) {
      const tag = (sql.match(/\/\* q:(\w+) \*\//) || [])[1];
      switch (tag) {
        case 'notesCount': { const o = {}; for (const m of metrics) if (supKinds.has(m.kind) && inWin(m.createdAt, p[0], p[1])) o[m.origin] = (o[m.origin] || 0) + 1; return Object.entries(o).map(([origin, n]) => ({ n, origin })); }
        case 'notes': {
          const [from, to, curT, curId, limit] = p;
          return metrics.filter(m => supKinds.has(m.kind) && inWin(m.createdAt, from, to) && (m.createdAt > new Date(curT) || (m.createdAt.getTime() === new Date(curT).getTime() && m.id > curId)))
            .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)).slice(0, limit)
            .map(m => { const note = messages.find(x => x.id.startsWith(m.msgPrefix) && x.chatId === m.chatId); return { id: m.id, kind: m.kind, chat_id: m.chatId, origin: m.origin, metric_at: m.createdAt, msg_prefix: m.msgPrefix, user_id: m.chat.userId, project_id: m.chat.projectId, is_supervisor: m.chat.isSupervisor, is_project_supervisor: m.chat.isProjectSupervisor, note_id: note ? note.id : null, note_at: note ? note.createdAt : null, synth_ms: note ? note.synthesisTime : null }; });
        }
        case 'prevNotes': { const [chatId, t, id] = p; return messages.filter(x => x.chatId === chatId && x.role === 'assistant' && (x.createdAt < new Date(t) || (x.createdAt.getTime() === new Date(t).getTime() && x.id < id))).sort((a, b) => b.createdAt - a.createdAt).slice(0, 4).map(x => ({ id: x.id, createdAt: x.createdAt, content: x.content, origin: x.origin })); }
        case 'prevUser': { const [chatId, t, id] = p; return messages.filter(x => x.chatId === chatId && x.role === 'user' && (x.createdAt < new Date(t) || (x.createdAt.getTime() === new Date(t).getTime() && x.id < id))).sort((a, b) => b.createdAt - a.createdAt).slice(0, 1).map(x => ({ id: x.id, createdAt: x.createdAt, content: x.content, origin: x.origin })); }
        case 'hookEvents': return hooks.filter(h => inWin(h.createdAt, p[0], p[1]));
        case 'agentRuns': return runs;
        case 'ownerAsks': return [];
        case 'tickets': return [];
        case 'supMetrics': return metrics.filter(m => supKinds.has(m.kind) && inWin(m.createdAt, p[0], p[1])).map(m => ({ chat_id: m.chatId, kind: m.kind, createdAt: m.createdAt }));
        case 'supSpend': return spend.filter(s => !s.runId && inWin(s.createdAt, p[0], p[1]));
        case 'auditsCount': { const a = audits.filter(x => inWin(x.createdAt, p[0], p[1])); return [{ n: a.length, stamped: a.filter(x => x.meta.selfAuditDecisionId).length }]; }
        case 'audits': { const [from, to, curT, curId, limit] = p; return audits.filter(a => inWin(a.createdAt, from, to) && (a.createdAt > new Date(curT) || (a.createdAt.getTime() === new Date(curT).getTime() && a.id > curId))).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit); }
        case 'events': return eventsByRun.get(p[0]) || [];
        case 'planFallback': return [];
        case 'auditOutcome': { const m = metrics.find(x => x.kind === 'decision_gate' && x.decisionId === p[0]); return m ? [{ question: m.question, actual: m.actual }] : []; }
        case 'runSpend': { const s = spend.find(x => x.runId === p[0]); return s ? [{ value: s.value }] : []; }
        case 'auxLeak': return [{ n: 0, backtest_leak: 0 }];
        default: throw new Error(`dry-run stub: unknown query ${tag}`);
      }
    },
    async $disconnect() { /* stub */ },
  };
  const decideRnd = mulberry32(seed + 1);
  const noul = (base) => Math.max(0, Math.min(1, base + (decideRnd() - 0.5) * 0.3));
  const decide = async (state, questions) => {
    if (decideRnd() < 0.01) return null;
    const answers = {};
    if (questions.will_act) {
      const failure = JSON.stringify(state).includes('FAILED') || (state.pending_flags && state.pending_flags.any_failure_or_block);
      answers.will_act = { type: 'noul', noul: r4(noul(failure ? 0.85 : 0.12)) };
      answers.has_new_input = { type: 'noul', noul: r4(noul(state.has_new_input ? 0.8 : 0.2)) };
    } else {
      answers.any_reopen = { type: 'noul', noul: r4(noul(0.06)) };
      for (const k of Object.keys(questions)) if (k.startsWith('step_')) answers[k] = { type: 'noul', noul: r4(noul(0.9)) };
    }
    return { id: 'dry', answers, backend: 'dry-run stub', backendSpec: 'stub', ms: Math.round(80 + decideRnd() * 300), mode: 'act', calibrated: true };
  };
  const extractReceipt = (tool, args, result) => {
    if (!new Set(['git_commit', 'open_pull_request', 'run_command', 'verify', 'git_push', 'send_chat_message']).has(tool)) return null;
    const text = String(result || '');
    let ok = true; let ids = {};
    try { const j = JSON.parse(text); if (typeof j.ok === 'boolean') ok = j.ok; ids = j.ids || {}; } catch { const m = text.match(/\[[^\]]*\s([0-9a-f]{6,})\]/); if (m) ids = { sha: m[1] }; }
    return { tool, ok, ids, inputHash: null, outputHash: null, createdAt: new Date() };
  };
  const receiptHeads = (args, result) => { const s = (v) => String(typeof v === 'string' ? v : JSON.stringify(v ?? {})).replace(/\s+/g, ' ').slice(0, 200); return { argsHead: s(args), resultHead: s(result) }; };
  return {
    kind: 'dry', prisma, telemetry: { rows: 0 }, classify: classifySupervisorNoteFallback, classifySource: 'probe-copy-2026-09-27', bucketFn: bucketMinutesFallback,
    codeFlags: (rows) => ({ any_row_is_question_or_request: rows.some(r => /please|advise|\?/i.test(String(r.payload.summary))), any_row_addressed_to_supervisor: rows.some(r => /supervisor/i.test(String(r.payload.summary))), any_row_reports_failure_or_block: rows.some(r => /fail|exit code [1-9]/i.test(String(r.payload.summary))), any_row_guard_replaced_final: false, any_row_owner_facing: false, distinct_sources: new Set(rows.map(r => r.payload.sourceChatId).filter(Boolean)).size }),
    extractReceipt, receiptHeads, isEvidenceToolName: (n) => n !== 'update_plan', decide,
    decisionMode: async () => ({ mode: 'act', source: 'dry-run' }), disconnect: async () => {},
    corpus: { notes: metrics.filter(m => supKinds.has(m.kind)).length, audits: audits.length }, now: base + 14 * 86400e3,
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
    const outDir = args.outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ad-backtest-dry-'));
    const dryArgs = { ...args, outDir, days: 14, batch: Math.min(args.batch, 60), cap: Math.min(args.cap, 150), runId: 'dry-run' };
    const batches = [];
    for (let i = 0; i < 40; i++) {
      const r = await runOnce(rt, dryArgs, { floorMs: 0, now: rt.now });
      batches.push({ done: r.done, candidates: Object.fromEntries(Object.entries(r.candidates || {}).map(([k, v]) => [k, { scored: v.rowsScored ?? 0, total: v.scoredTotal, done: v.done }])) });
      if (r.done) break;
    }
    const report = buildReport(mergeLines(path.join(outDir, 'dry-run.jsonl')));
    report.dryRun = { corpus: rt.corpus, batches, outDir };
    print(report);
    if (!args.outDir) fs.rmSync(outDir, { recursive: true, force: true });
    return 0;
  }
  if (args.merge) {
    const outDir = args.outDir || DEFAULT_OUT_DIR;
    let file;
    if (args.merge === true) { const pointer = path.join(outDir, LATEST_POINTER); const runId = args.runId || process.env.AD_BACKTEST_RUN_ID || (fs.existsSync(pointer) ? fs.readFileSync(pointer, 'utf8').trim() : '') || defaultRunId(args.days); file = path.join(outDir, `${runId}.jsonl`); }
    else if (String(args.merge).endsWith('.jsonl') || String(args.merge).includes('/')) file = String(args.merge);
    else file = path.join(outDir, `${args.merge}.jsonl`);
    const by = mergeLines(file);
    const report = buildReport(by);
    report.source = { file, batches: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.batches])) };
    print(report);
    return 0;
  }
  const rt = loadLiveRuntime();
  try { print(await runOnce(rt, args)); }
  finally { await rt.disconnect(); }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(err => { console.error('PROBE_FAIL', String(err && err.message || err).slice(0, 300)); process.exit(err && err.exitCode ? err.exitCode : 1); });
}

module.exports = {
  CANDIDATES, TURN_NOOP_TAU, AUDIT_REOPEN_BAR, AUDIT_STEP_TAU, NEW_INPUT_SHARE_MIN, FALLBACK_TURN_USD,
  wilson, quantile, mulberry32, hash8, sampleKeep, bucketMinutesFallback, bucketHours, quantiseRate,
  classifySupervisorNoteFallback, isAlarmInput, trigrams, newInputShare, targetHistory, splitDrainBodies, pendingInputRows, pendingPins,
  boardCounts, laneFacts, turnNoopBand, auditSkipBand, completedIds, reopenedSteps, stepNouns, receiptJoin, rebuildAuditPoint, buildAuditRequest,
  buildTurnNoopState, TURN_NOOP_QUESTIONS, newAgg, mergeAgg, reportTurnNoop, reportAudit, buildReport, stubTelemetry, parseArgs, buildDryRuntime, runOnce, mergeLines, SQL,
};

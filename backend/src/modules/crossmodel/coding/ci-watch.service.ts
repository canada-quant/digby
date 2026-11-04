/**
 * CI-WATCH (2026-10-20) — the no-LLM CI watch over LANE-pushed shas.
 *
 * WHY: red CI on a lane's pushed commit went unattended until some unrelated
 * wake — the most common coding failure mode, and continuous delivery stalled
 * on it silently. The post-push observer (ci-status.ts observeCiAfterPush) is
 * OFF by default since the 2026-09-11 gate flip (30 s after a push the PR
 * checks are still pending), and ci_failed was in neither stock supervisor
 * hook set, so emitHookEvent dropped it for every supervisor. Prod, 7 d before
 * this change: merge_gate_failure 160, merge_wait_once 139.
 *
 * WHAT: the worker cron CI_WATCH_JOB_ID (every 5 min; at most
 * CI_WATCH_MAX_PER_PASS GitHub reads per pass; zero model calls):
 *   1. CANDIDATES — ok git_push / open_pull_request receipts of the last 24 h
 *      (the coding sessions touched in the window → their receipts, on the
 *      [chatId, createdAt] index — never a table scan of run_tool_receipts)
 *      whose verdict under ['ci-watch'] / <sha> is missing or not terminal and
 *      due. An open_pull_request receipt first resolves the PR's head sha (one
 *      GET, remembered under 'pr:<receiptId>').
 *   2. SCOPE, before any GitHub read (review fix 2026-10-20): ci-watch only
 *      ever wakes a MACHINE LANE about a MACHINE push. A receipt whose run a
 *      human started (agent_runs.input: origin 'user', a legacy userTurnAt
 *      anchor, an owner dispatch — or no run at all: an owner-card execution)
 *      is observed only ('human_run'); so is a session with no machine
 *      lineage (no parentChatId, first run not machine-authored, project
 *      without an enabled project supervisor — 'not_machine_lane'). Out of
 *      scope ⇒ one telemetry row, the sha parked, never a run.
 *   3. ONE fetchCiStatus per sha with the LANE OWNER's token (the project's
 *      githubLabel). A 429 / rate-limit 403 backs that owner off (Retry-After /
 *      X-RateLimit-Reset, clamped 60 s..1 h) and two of them end the pass;
 *      404 / 403 / transport errors retry with a bounded count, then park the
 *      sha 'unobservable'.
 *   4. A COMPLETED failure (no check still running — or failing for
 *      CI_WATCH_FAILURE_SETTLE_MS while others run) is routed LANE FIRST:
 *      unless the lane already moved past it — a newer git_push receipt on the
 *      branch, OR the LIVE branch / PR head (one budgeted read) is another
 *      commit (pushes made with run_command / gh mint no git_push receipt; a
 *      moved PR head is adopted as the lane's next watched sha) — ONE
 *      enqueueDirectWake on the lane with the failing checks. A LIVE lane is
 *      never woken onto (it may be reading this verdict with its own
 *      check_ci): the sha is re-checked each interval and the wake queues once
 *      the lane is idle — or once the sha has been red for
 *      CI_WATCH_PS_MAX_HOLD_MS (the wake then parks until the run ends). A
 *      lane whose last run was explicitly STOPPED is never woken (a stop means
 *      stop) — the supervisor is told instead; an archived lane likewise.
 *      LOOP BUDGET: at most CI_WATCH_LANE_WAKE_MAX ci-watch wakes per lane per
 *      24 h (the wake is alarm-class: it bypasses the daily machine-run cap),
 *      and a lane with CI_WATCH_LANE_LOOP_REDS red pushes in 24 h is not woken
 *      again either — ONE 'lane_loop' escalation names the chain of red shas.
 *   5. THEN THE PROJECT SUPERVISOR: a later pass escalates ONCE per sha
 *      (emitCiFailed with extra.ciWatchEscalation, awaited) when the sha is
 *      still red, the branch head is still that sha, and the lane is idle —
 *      or once the sha has been red CI_WATCH_PS_MAX_HOLD_MS even while the
 *      lane is live (fail toward delivery). A green re-check (re-run)
 *      resolves it with no escalation; a failed re-read is retried like a poll
 *      before it escalates with the last verdict. An emission no hook heard
 *      is recorded 'no_supervisor' (never counted as escalated); a failed one
 *      releases its claim and retries next pass. Store claims fail CLOSED (a
 *      store error skips the step this pass — never a duplicate wake). The
 *      escalation row is ALARM-CLASS at delivery (hooks.service isAlarmEvent
 *      reads ciWatchEscalation — r2 interactions fix): a spent daily cap or a
 *      long busy park can no longer drop the row a terminal 'escalated' (and a
 *      lane_loop's 24 h lane silence) rests on.
 *      The project-scope hook carries ci_failed (project-supervisor.service
 *      union heal); hooks.service withholds that row while the lane is live
 *      for every OTHER ci_failed emission (the lane's own in-run check_ci).
 *
 * Verdict rows live in the context store (no migration) and are pruned after
 * CI_WATCH_RECORD_TTL_MS. Telemetry: loop_metrics kind 'ci_watch' (phases in
 * loop-metric-kinds.ts). Never throws: every step degrades to "try next pass".
 * Kill switch CI_WATCH_DISABLED=1 (the cron does nothing; hooks.service drops
 * ci_failed only on the ci-watch-provisioned project-supervisor hooks and
 * delivers every other subscriber as before; the supervisor ensure stops
 * unioning ci_failed into stock hooks; an escalation row is quiet again).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { repoTargetAllowed } from '../platform/instance-targets';
import type { CiStatus } from './ci-status';

const SOURCE = 'ci-watch';

export const CI_WATCH_DISABLED_ENV = 'CI_WATCH_DISABLED';
export const CI_WATCH_JOB_ID = 'ci-watch';
/** Cron cadence (the worker registers it); also the re-check interval for a pending sha. */
export const CI_WATCH_INTERVAL_SEC = 300;
/** GitHub reads per pass (a PR head resolve, a live-head read and a CI read each count one). */
export const CI_WATCH_MAX_PER_PASS = 30;
/** Receipt window — a push older than this is no longer watched. */
export const CI_WATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Store namespace of every ci-watch row (verdicts, PR pointers, claims, backoffs, lane ledgers). */
export const CI_WATCH_NS = ['ci-watch'];
/** A failure with checks still running is routed once it has been red this long (the full failing list usually lands first). */
export const CI_WATCH_FAILURE_SETTLE_MS = 20 * 60 * 1000;
/** After the lane wake: the first escalation check waits at least this long (the wake must deliver and start the run). */
export const CI_WATCH_LANE_GRACE_MS = 10 * 60 * 1000;
/** A lane still live this long after its wake no longer holds the supervisor back (fail toward delivery). */
export const CI_WATCH_PS_MAX_HOLD_MS = 2 * 60 * 60 * 1000;
/** A sha with NO checks (branch pushes before a PR exists) stops being polled after this age. */
export const CI_WATCH_NONE_TERMINAL_MS = 6 * 60 * 60 * 1000;
/** No-checks re-poll backoff ceiling. */
export const CI_WATCH_NONE_MAX_DELAY_MS = 2 * 60 * 60 * 1000;
/** Errors on one sha before it is parked 'unobservable' (404 / 403 non-rate-limit / transport) — or, after the wake, escalated with its last verdict. */
export const CI_WATCH_MAX_ERRORS = 3;
/** Re-check delay after a non-rate-limit GitHub error (the poll and the post-wake re-read alike). */
export const CI_WATCH_ERROR_RETRY_MS = 15 * 60 * 1000;
/** Rate-limit hits that end the pass early. */
export const CI_WATCH_RATE_LIMIT_STOP = 2;
/** Store rows older than this are pruned (well past the 24 h window + the 2 h hold). */
export const CI_WATCH_RECORD_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** Failing checks named in a wake / summary. */
export const CI_WATCH_FAILING_SHOWN = 8;
/** Candidate bounds (sessions with a run in the window; receipts read). */
export const CI_WATCH_SESSION_CAP = 500;
export const CI_WATCH_RECEIPT_CAP = 1000;
export const CI_WATCH_TOOLS = ['git_push', 'open_pull_request'] as const;
/** The lane loop budget's rolling window. */
export const CI_WATCH_LANE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * ci-watch wakes per lane per window. The wake is alarm-class (todo_wake: no
 * debounce, no daily machine-run cap), so THIS is its bound — a lane stuck in
 * a red-fix cycle gets its supervisor instead of an unbounded wake chain.
 */
export const CI_WATCH_LANE_WAKE_MAX = 3;
/** Red pushes per lane per window (woken or superseded) that mark a red-fix loop. */
export const CI_WATCH_LANE_LOOP_REDS = 5;
/** Red shas a lane-loop escalation names. */
export const CI_WATCH_CHAIN_SHOWN = 6;

export function ciWatchDisabled(): boolean {
  return process.env[CI_WATCH_DISABLED_ENV] === '1';
}

// ── types ────────────────────────────────────────────────────────────────────

export type CiWatchState = 'pending' | 'none' | 'success' | 'failure' | 'unobservable';
export type CiWatchOutcome =
  | 'success' | 'none' | 'superseded' | 'resolved' | 'escalated' | 'no_supervisor' | 'loop_suppressed' | 'out_of_scope'
  | 'not_found' | 'unobservable' | 'closed' | 'no_lane' | 'not_github' | 'isolated';
export type CiWatchEscalation = 'lane_idle' | 'max_hold' | 'lane_unwakeable' | 'lane_stopped' | 'lane_loop';
/**
 * Who ci-watch may wake about a sha. 'lane' = a machine push in a machine lane
 * (woken lane first). Everything else is observed only — telemetry, the sha
 * parked, never a run: 'human_run' (the push ran on a run a human started, or
 * on an owner-confirmed card), 'unknown_run' (the run row is gone) and
 * 'not_machine_lane' (no supervisor / dispatcher lineage).
 */
export type CiWatchScope = 'lane' | 'human_run' | 'unknown_run' | 'not_machine_lane';
export type RunOriginClass = 'human' | 'machine' | 'unknown';

/** The verdict row stored under ['ci-watch'] / <sha>. */
export interface CiWatchRecord {
  v: 1;
  sha: string;
  chatId: string;
  owner: string;
  repo: string;
  branch: string | null;
  prNumber: number | null;
  receiptId: string;
  receiptAt: string;
  state: CiWatchState;
  terminal: boolean;
  outcome: CiWatchOutcome | null;
  checks: number;
  errors: number;
  failing: string[];
  failingSince: string | null;
  firstSeenAt: string;
  lastCheckedAt: string | null;
  nextCheckAt: string;
  laneWokenAt: string | null;
  wakeEventId: string | null;
  escalatedAt: string | null;
  escalation: CiWatchEscalation | null;
  /** The receipt's run (agent_runs.id) — the scope gate's input. */
  runId?: string | null;
  /** Set on an out-of-scope row (never routed). */
  scope?: CiWatchScope | null;
  /** The last live branch / PR head read said this sha is still the head (null = not read / unreadable). */
  headVerified?: boolean | null;
}

/** The PR pointer stored under ['ci-watch'] / pr:<receiptId>: the PR's head sha once resolved (re-pointed when the head moves). */
export interface CiWatchPrPointer {
  v: 1;
  kind: 'pr';
  receiptId: string;
  owner: string;
  repo: string;
  prNumber: number;
  sha: string | null;
  branch: string | null;
  terminal: boolean;
  outcome: CiWatchOutcome | null;
  errors: number;
  nextCheckAt: string;
  scope?: CiWatchScope | null;
}

/** One red push in a lane's loop ledger. */
export interface CiWatchLaneRed { sha: string; branch: string | null; at: string; woken: boolean }

/** The per-lane loop ledger stored under ['ci-watch'] / lane:<chatId> (rolling CI_WATCH_LANE_WINDOW_MS). */
export interface CiWatchLaneLedger {
  v: 1;
  kind: 'lane';
  chatId: string;
  reds: CiWatchLaneRed[];
  loopEscalatedAt: string | null;
}

/** One receipt row as the candidate read returns it. */
export interface CiWatchReceiptRow {
  id: string;
  chatId: string;
  /** agent_runs.id of the run that minted it (null: an owner-card execution). */
  runId?: string | null;
  tool: string;
  ids: unknown;
  createdAt: Date;
}

/** A unit of work for one pass. `sha` is null for an unresolved PR (kind 'pr'). */
export interface CiWatchTarget {
  key: string;
  kind: 'sha' | 'pr';
  chatId: string;
  receiptId: string;
  receiptAt: Date;
  runId: string | null;
  sha: string | null;
  branch: string | null;
  owner: string | null;
  repo: string | null;
  prNumber: number | null;
}

export interface CiWatchLane {
  userId: string;
  archived: boolean;
  repoUrl: string | null;
  provider: string | null;
  githubLabel: string | null;
  /** Spawned by another chat (a supervisor, a dispatcher, a parent lane). */
  parentChatId: string | null;
  /** The session's FIRST run was machine-authored (ticket / supervisor / agent spawn); null = unknown this pass. */
  machineStarted: boolean | null;
  /** The lane's project has an enabled project supervisor. */
  projectSupervisorOn: boolean;
  /** The lane's newest run was explicitly STOPPED (a stop means stop — never woken). */
  lastRunStopped: boolean;
}

/** The origin fields of one agent_runs.input (never the prompt). */
export interface RunOriginFacts { origin: string | null; userTurnAt: string | null; ownerDispatch: boolean | string | null }

export interface PullHead { sha: string; ref: string | null; state: string; merged: boolean }

/** What one emitCiFailed delivered: hook rows written, and whether the emission itself failed. */
export interface CiFailedEmitResult { written: number; error?: boolean }

// ── pure helpers ─────────────────────────────────────────────────────────────

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const iso = (d: Date): string => d.toISOString();
const ms = (s: string | null | undefined): number => {
  const t = s ? new Date(s).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
};
const hhmmz = (d: Date): string => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
const MACHINE_ORIGINS = new Set(['schedule', 'hook', 'agent', 'webhook']);
/** Housekeeping cancels (claim-time / superseded / lane restore) — a cancelled run that is NOT a stop. */
const HOUSEKEEPING_CANCEL_RE = /claim time|before the run started|superseded|restored to a plain chat/i;

/** Two shas name the same commit (receipt shas may be abbreviated). Pure. */
export function sameSha(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = String(a ?? '').trim().toLowerCase();
  const y = String(b ?? '').trim().toLowerCase();
  if (!SHA_RE.test(x) || !SHA_RE.test(y)) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * The run that minted a receipt → human / machine — the executor's own rule
 * (run-executor: an explicit origin wins, else userTurnAt ? 'user' :
 * 'schedule'; an owner dispatch — origin 'agent' + ownerDispatch + an anchor —
 * runs as a USER run). No row ⇒ 'unknown'. Pure.
 */
export function classifyRunOrigin(f: RunOriginFacts | null | undefined): RunOriginClass {
  if (!f) return 'unknown';
  const origin = typeof f.origin === 'string' && f.origin.trim() ? f.origin.trim() : null;
  const anchored = typeof f.userTurnAt === 'string' ? f.userTurnAt.trim() !== '' : f.userTurnAt != null;
  const ownerDispatch = f.ownerDispatch === true || f.ownerDispatch === 'true';
  if (origin === 'user') return 'human';
  if (!origin) return anchored ? 'human' : 'machine';
  if (origin === 'agent' && ownerDispatch && anchored) return 'human';
  return MACHINE_ORIGINS.has(origin) ? 'machine' : 'unknown';
}

/**
 * May ci-watch wake this lane about this push? Only a MACHINE push in a
 * MACHINE lane: spawned by another chat, started by a machine run (ticket /
 * supervisor / agent lanes), or in a project with an enabled project
 * supervisor. null = the lineage is unknown this pass (retry). Pure.
 */
export function ciWatchScope(i: { receipt: RunOriginClass; parentChatId: string | null; machineStarted: boolean | null; projectSupervisorOn: boolean }): CiWatchScope | null {
  if (i.receipt === 'human') return 'human_run';
  if (i.receipt === 'unknown') return 'unknown_run';
  if (i.parentChatId || i.projectSupervisorOn || i.machineStarted === true) return 'lane';
  return i.machineStarted === null ? null : 'not_machine_lane';
}

/** The lane's newest run was an explicit STOP (status cancelled, not a claim-time / superseded housekeeping cancel). Pure. */
export function isExplicitStop(run: { status?: string | null; error?: string | null } | null | undefined): boolean {
  if (!run || run.status !== 'cancelled') return false;
  return !HOUSEKEEPING_CANCEL_RE.test(String(run.error ?? ''));
}

/** "owner/repo" of a GitHub https / ssh URL (null for anything else). */
export function parseGithubRepo(url: string | null | undefined): { owner: string; repo: string } | null {
  const m = String(url ?? '').trim().replace(/\/+$/, '').replace(/\.git$/, '').match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** owner / repo / number of a GitHub pull-request URL (the open_pull_request receipt's ids.url). */
export function parsePrUrl(url: string | null | undefined): { owner: string; repo: string; prNumber: number } | null {
  const m = String(url ?? '').trim().match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!m) return null;
  const n = Number(m[3]);
  return Number.isInteger(n) && n > 0 ? { owner: m[1], repo: m[2], prNumber: n } : null;
}

/**
 * Receipts → work units. git_push ⇒ a sha target keyed by the lowercased sha
 * (the newest receipt for a sha wins — rows arrive newest-first);
 * open_pull_request ⇒ a PR target keyed 'pr:<receiptId>'. Malformed rows are
 * skipped. Pure.
 */
export function receiptsToTargets(rows: CiWatchReceiptRow[]): { shas: Map<string, CiWatchTarget>; prs: CiWatchTarget[] } {
  const shas = new Map<string, CiWatchTarget>();
  const prs: CiWatchTarget[] = [];
  for (const r of rows) {
    const ids = (r?.ids && typeof r.ids === 'object' ? r.ids : {}) as Record<string, unknown>;
    const at = r?.createdAt instanceof Date ? r.createdAt : new Date(String(r?.createdAt ?? ''));
    if (!r?.id || !r?.chatId || !Number.isFinite(at.getTime())) continue;
    const runId = typeof r.runId === 'string' && r.runId ? r.runId : null;
    if (r.tool === 'git_push') {
      const sha = typeof ids.sha === 'string' ? ids.sha.trim().toLowerCase() : '';
      if (!SHA_RE.test(sha) || shas.has(sha)) continue;
      shas.set(sha, {
        key: sha, kind: 'sha', chatId: r.chatId, receiptId: r.id, receiptAt: at, runId, sha,
        branch: typeof ids.branch === 'string' && ids.branch ? ids.branch : null,
        owner: null, repo: null, prNumber: null,
      });
    } else if (r.tool === 'open_pull_request') {
      const pr = parsePrUrl(typeof ids.url === 'string' ? ids.url : '');
      if (!pr) continue;
      prs.push({
        key: `pr:${r.id}`, kind: 'pr', chatId: r.chatId, receiptId: r.id, receiptAt: at, runId, sha: null,
        branch: null, owner: pr.owner, repo: pr.repo, prNumber: pr.prNumber,
      });
    }
  }
  return { shas, prs };
}

/** A resolved PR pointer becomes (or enriches) a sha target. Pure; mutates `shas`. */
export function mergePrPointer(shas: Map<string, CiWatchTarget>, pr: CiWatchTarget, ptr: CiWatchPrPointer): void {
  if (!ptr.sha) return;
  const sha = ptr.sha.toLowerCase();
  const have = shas.get(sha);
  if (have) {
    if (have.prNumber == null) have.prNumber = ptr.prNumber;
    if (!have.owner) { have.owner = ptr.owner; have.repo = ptr.repo; }
    if (!have.branch && ptr.branch) have.branch = ptr.branch;
    return;
  }
  shas.set(sha, {
    key: sha, kind: 'sha', chatId: pr.chatId, receiptId: pr.receiptId, receiptAt: pr.receiptAt, runId: pr.runId, sha,
    branch: ptr.branch, owner: ptr.owner, repo: ptr.repo, prNumber: ptr.prNumber,
  });
}

/** Is this stored row due (absent, or not terminal and past nextCheckAt)? Pure. */
export function isDue(rec: { terminal?: boolean; nextCheckAt?: string } | null | undefined, now: Date): boolean {
  if (!rec) return true;
  if (rec.terminal) return false;
  const next = ms(rec.nextCheckAt);
  return !Number.isFinite(next) || next <= now.getTime();
}

/**
 * The pass order: URGENT rows first (a sha already known red — its route or
 * escalation may have been deferred for want of budget), then never-checked
 * targets (newest push first — the freshest red is the most actionable), then
 * the rest by oldest last check (fairness when the per-pass bound binds). Pure.
 */
export function orderDue<T extends { target: CiWatchTarget; lastCheckedAt: string | null; urgent?: boolean }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ua = a.urgent === true; const ub = b.urgent === true;
    if (ua !== ub) return ua ? -1 : 1;
    const la = ms(a.lastCheckedAt); const lb = ms(b.lastCheckedAt);
    const na = Number.isFinite(la); const nb = Number.isFinite(lb);
    if (na !== nb) return na ? 1 : -1;
    if (na && nb && la !== lb) return la - lb;
    return b.target.receiptAt.getTime() - a.target.receiptAt.getTime();
  });
}

/** A NEWER git_push receipt from the same lane on the same branch with a different sha (the red sha is history). Pure. */
export function findSupersedingPush(
  t: { chatId: string; sha: string; branch: string | null; receiptAt: Date | string },
  all: Iterable<CiWatchTarget>,
): CiWatchTarget | null {
  if (!t.branch) return null;
  const at = t.receiptAt instanceof Date ? t.receiptAt.getTime() : ms(t.receiptAt);
  if (!Number.isFinite(at)) return null;
  let best: CiWatchTarget | null = null;
  for (const o of all) {
    if (o.kind !== 'sha' || !o.sha || o.chatId !== t.chatId || o.sha === t.sha || o.branch !== t.branch) continue;
    if (o.receiptAt.getTime() <= at) continue;
    if (!best || o.receiptAt.getTime() > best.receiptAt.getTime()) best = o;
  }
  return best;
}

/** A fresh verdict row for a target (pure). */
export function newRecord(t: CiWatchTarget, owner: string, repo: string, now: Date): CiWatchRecord {
  return {
    v: 1, sha: String(t.sha), chatId: t.chatId, owner, repo, branch: t.branch, prNumber: t.prNumber,
    receiptId: t.receiptId, receiptAt: iso(t.receiptAt), state: 'pending', terminal: false, outcome: null,
    checks: 0, errors: 0, failing: [], failingSince: null, firstSeenAt: iso(now), lastCheckedAt: null,
    nextCheckAt: iso(now), laneWokenAt: null, wakeEventId: null, escalatedAt: null, escalation: null,
    runId: t.runId ?? null, scope: null, headVerified: null,
  };
}

/** No-checks re-poll delay: 10 min doubling per check, capped at 2 h. Pure. */
export function noneDelayMs(checks: number): number {
  const n = Math.max(0, Math.min(6, Math.floor(checks) - 1));
  return Math.min(CI_WATCH_NONE_MAX_DELAY_MS, 10 * 60 * 1000 * 2 ** n);
}

/**
 * Fold ONE CI observation into a verdict row. `route` is true exactly when a
 * COMPLETED failure must now be routed (lane first). Pure.
 *   success → terminal 'success';
 *   pending → re-check next interval;
 *   none    → re-poll with backoff; terminal 'none' past CI_WATCH_NONE_TERMINAL_MS;
 *   failure → route when no check is still running, or once red for
 *             CI_WATCH_FAILURE_SETTLE_MS; else re-check next interval.
 */
export function applyCiObservation(rec: CiWatchRecord, ci: CiStatus, now: Date): { rec: CiWatchRecord; route: boolean } {
  const next: CiWatchRecord = { ...rec, checks: rec.checks + 1, lastCheckedAt: iso(now), state: ci.state, errors: 0 };
  const interval = new Date(now.getTime() + CI_WATCH_INTERVAL_SEC * 1000);
  switch (ci.state) {
    case 'success':
      return { rec: { ...next, terminal: true, outcome: 'success', failing: [], failingSince: null }, route: false };
    case 'pending':
      return { rec: { ...next, failing: [], failingSince: null, nextCheckAt: iso(interval) }, route: false };
    case 'none': {
      const age = now.getTime() - ms(rec.receiptAt);
      if (Number.isFinite(age) && age >= CI_WATCH_NONE_TERMINAL_MS) return { rec: { ...next, terminal: true, outcome: 'none' }, route: false };
      return { rec: { ...next, nextCheckAt: iso(new Date(now.getTime() + noneDelayMs(next.checks))) }, route: false };
    }
    case 'failure': {
      const failing = (ci.failing ?? []).map(String).slice(0, 20);
      const since = rec.failingSince ?? iso(now);
      const running = (ci.checks ?? []).some((c) => c && c.status !== 'completed');
      const settled = !running || now.getTime() - ms(since) >= CI_WATCH_FAILURE_SETTLE_MS;
      const base = { ...next, failing, failingSince: since };
      return settled ? { rec: base, route: true } : { rec: { ...base, nextCheckAt: iso(interval) }, route: false };
    }
    default:
      return { rec: { ...next, nextCheckAt: iso(interval) }, route: false };
  }
}

/**
 * What a due row already handed to its lane needs now. Pure.
 *   superseded — the lane pushed a newer commit on the branch: stop;
 *   wait       — the lane is live and the hold has not run out: re-check later;
 *   recheck    — the lane is idle (or the hold ran out): read the live head
 *                and CI once more, then afterRecheck decides.
 */
export function escalationStep(i: { superseded: boolean; live: boolean; heldMs: number }): 'superseded' | 'wait' | 'recheck' {
  if (i.superseded) return 'superseded';
  if (i.live && i.heldMs < CI_WATCH_PS_MAX_HOLD_MS) return 'wait';
  return 'recheck';
}

/** How long the sha has been known red (first red observation, else the lane wake). Pure. */
export function redHeldMs(rec: Pick<CiWatchRecord, 'failingSince' | 'laneWokenAt'>, now: Date): number {
  const since = ms(rec.failingSince ?? rec.laneWokenAt);
  return Number.isFinite(since) ? Math.max(0, now.getTime() - since) : 0;
}

/**
 * After the re-check: green → resolved; a re-run still pending inside the hold
 * → wait; anything else → escalate. ('error' — the re-read failed — only
 * reaches here once the error budget or the hold ran out.) Pure.
 */
export function afterRecheck(i: { state: CiWatchState | 'error'; live: boolean; heldMs: number }): 'resolved' | 'wait' | 'escalate' {
  if (i.state === 'success') return 'resolved';
  if (i.state === 'pending' && i.heldMs < CI_WATCH_PS_MAX_HOLD_MS) return 'wait';
  return 'escalate';
}

// ── the lane loop ledger (pure) ──────────────────────────────────────────────

export const laneLedgerKey = (chatId: string): string => `lane:${chatId}`;

export function emptyLaneLedger(chatId: string): CiWatchLaneLedger {
  return { v: 1, kind: 'lane', chatId, reds: [], loopEscalatedAt: null };
}

/** Drop reds (and a loop escalation) older than the rolling window; tolerate a malformed row. Pure. */
export function pruneLaneLedger(l: Partial<CiWatchLaneLedger> | null | undefined, chatId: string, now: Date): CiWatchLaneLedger {
  const cut = now.getTime() - CI_WATCH_LANE_WINDOW_MS;
  const reds = (Array.isArray(l?.reds) ? l!.reds : [])
    .filter((r) => r && typeof r.sha === 'string' && ms(r.at) > cut)
    .map((r) => ({ sha: r.sha, branch: typeof r.branch === 'string' ? r.branch : null, at: r.at, woken: r.woken === true }))
    .slice(-50);
  const loop = typeof l?.loopEscalatedAt === 'string' && ms(l.loopEscalatedAt) > cut ? l.loopEscalatedAt : null;
  return { v: 1, kind: 'lane', chatId, reds, loopEscalatedAt: loop };
}

/** Record a red push (idempotent per sha). Pure. */
export function noteLaneRed(l: CiWatchLaneLedger, r: { sha: string; branch: string | null }, now: Date): CiWatchLaneLedger {
  if (l.reds.some((x) => sameSha(x.sha, r.sha))) return l;
  return { ...l, reds: [...l.reds, { sha: r.sha, branch: r.branch, at: iso(now), woken: false }] };
}

/** Mark a red push as woken (adds it when absent). Pure. */
export function markLaneWoken(l: CiWatchLaneLedger, r: { sha: string; branch: string | null }, now: Date): CiWatchLaneLedger {
  const base = noteLaneRed(l, r, now);
  return { ...base, reds: base.reds.map((x) => (sameSha(x.sha, r.sha) ? { ...x, woken: true } : x)) };
}

/**
 * The loop budget: `stop` once the lane has been woken CI_WATCH_LANE_WAKE_MAX
 * times in the window, or has pushed CI_WATCH_LANE_LOOP_REDS red commits in it
 * (a branch that stays red across N pushes — each sha superseded by the next —
 * is a loop even though no single sha was ever escalated). Pure.
 */
export function laneLoopVerdict(l: CiWatchLaneLedger): { wakes: number; reds: number; stop: boolean; why: 'wake_budget' | 'red_chain' | null } {
  const wakes = l.reds.filter((r) => r.woken).length;
  const reds = l.reds.length;
  const why = wakes >= CI_WATCH_LANE_WAKE_MAX ? 'wake_budget' : reds >= CI_WATCH_LANE_LOOP_REDS ? 'red_chain' : null;
  return { wakes, reds, stop: why !== null, why };
}

// ── text (pure) ──────────────────────────────────────────────────────────────

const failingText = (failing: string[]): string => {
  if (!failing.length) return 'combined status failure';
  const shown = failing.slice(0, CI_WATCH_FAILING_SHOWN).join(', ');
  return failing.length > CI_WATCH_FAILING_SHOWN ? `${shown} (+${failing.length - CI_WATCH_FAILING_SHOWN} more)` : shown;
};

/** The lane's direct wake (lane FIRST). `budget` names this wake's place in the lane's 24 h wake budget. Pure. */
export function renderLaneWakePrompt(r: CiWatchRecord, budget?: { count: number; max: number }): string {
  const where = `${r.owner}/${r.repo}@${r.sha.slice(0, 12)}`;
  const what = [r.branch ? `branch ${r.branch}` : null, r.prNumber ? `PR #${r.prNumber}` : null, `receipt ${r.receiptId.slice(0, 8)}`]
    .filter(Boolean).join(' · ');
  const tail = budget
    ? ` This is ci-watch wake ${budget.count} of at most ${budget.max} for this lane in 24 h — past that, red CI on this lane goes straight to its supervisor.`
    : '';
  return `[CI FAILED — ${where}] The commit this lane pushed (${what}) is RED on GitHub: ${failingText(r.failing)}. ` +
    `The pushed work is NOT done until CI is green. Read the failing check (check_ci with sha ${r.sha.slice(0, 12)} lists every check), ` +
    'fix, commit and push again — or, when the failure is pre-existing or unrelated to your change, say so with the evidence. ' +
    'ci-watch re-checks this sha: if it is still red once this lane is idle and the branch head has not moved, it is escalated to whoever supervises this lane.' +
    tail;
}

/**
 * The escalation sentence appended to the ci_failed summary the supervisor
 * reads. `opts.ledger` feeds the lane-loop chain; `opts.errors` marks a verdict
 * ci-watch could not re-read after the wake (the failing list is the last one
 * observed). Pure.
 */
export function renderEscalationNote(
  r: CiWatchRecord,
  reason: CiWatchEscalation,
  now: Date,
  why?: string,
  opts: { ledger?: CiWatchLaneLedger; errors?: number } = {},
): string {
  const where = `(${r.owner}/${r.repo}${r.branch ? `, branch ${r.branch}` : ''}${r.prNumber ? `, PR #${r.prNumber}` : ''})`;
  const woken = r.laneWokenAt ? hhmmz(new Date(r.laneWokenAt)) : null;
  const stale = opts.errors
    ? ` ci-watch could not re-read CI after the wake (${opts.errors} failed read${opts.errors === 1 ? '' : 's'}) — the failing list is the last one observed.`
    : '';
  if (reason === 'lane_unwakeable') {
    return `${where} The lane cannot be woken (${why || 'archived'}) — nobody owns this red commit: re-dispatch the fix or close it.`;
  }
  if (reason === 'lane_stopped') {
    return `${where} The lane's last run was STOPPED, so ci-watch did not wake it (a stop means stop) — decide whether this fix is still wanted: re-dispatch it, ask the owner, or close it.`;
  }
  if (reason === 'lane_loop') {
    const reds = opts.ledger?.reds ?? [];
    const shown = reds.slice(-CI_WATCH_CHAIN_SHOWN).map((x) => `${x.sha.slice(0, 12)}${x.branch ? `@${x.branch}` : ''}`).join(', ');
    const more = reds.length > CI_WATCH_CHAIN_SHOWN ? ', …' : '';
    const wakes = reds.filter((x) => x.woken).length;
    return `${where} This lane pushed ${reds.length} red commit${reds.length === 1 ? '' : 's'} in 24 h (${shown || r.sha.slice(0, 12)}${more}) and ci-watch already woke it ${wakes}× about red CI — it looks stuck in a red-CI loop, so ci-watch stops waking it for 24 h: read the failing check yourself, then steer the lane (send_chat_message), re-dispatch the fix, or record why the failure is outside the lane's reach (flaky infra, a missing secret, an unrelated failing check).`;
  }
  if (reason === 'max_hold') {
    const since = ms(r.failingSince ?? r.laneWokenAt);
    const h = Number.isFinite(since) ? Math.max(1, Math.round((now.getTime() - since) / 3_600_000)) : 2;
    return `${where} The commit has been red ~${h} h; ci-watch woke the lane at ${woken ?? '?'} with the failing checks and it is still busy without moving the branch head — check it is working on the red CI.${stale}`;
  }
  const head = r.headVerified === true
    ? 'the branch head is still this commit (read live)'
    : 'ci-watch saw no newer push on this branch (its live head could not be read)';
  return `${where} ci-watch woke the lane at ${woken ?? '?'} with the failing checks; the lane is idle and ${head} — steer it (send_chat_message) or re-dispatch the fix.${stale}`;
}

/**
 * GitHub error → what the watch does with it. 429, or a 403 that says rate
 * limit (X-RateLimit-Remaining 0 / Retry-After / the message) ⇒ back the
 * owner off; 404 / 422 ⇒ not found; other 403 ⇒ forbidden; else other. Pure.
 */
export function classifyGithubError(err: any, now: Date = new Date()): { kind: 'rate_limited' | 'not_found' | 'forbidden' | 'other'; status: number | null; retryAfterMs: number } {
  const status = Number(err?.response?.status);
  const st = Number.isFinite(status) ? status : null;
  const h = (err?.response?.headers ?? {}) as Record<string, unknown>;
  const header = (k: string): string => String(h[k] ?? h[k.toLowerCase()] ?? '');
  const retryAfter = Number(header('retry-after'));
  const reset = Number(header('x-ratelimit-reset'));
  let wait = 15 * 60 * 1000;
  if (Number.isFinite(retryAfter) && retryAfter > 0) wait = retryAfter * 1000;
  else if (Number.isFinite(reset) && reset > 0) wait = reset * 1000 - now.getTime();
  const retryAfterMs = Math.min(60 * 60 * 1000, Math.max(60 * 1000, wait));
  const msg = String(err?.response?.data?.message ?? err?.message ?? '').toLowerCase();
  if (st === 429) return { kind: 'rate_limited', status: st, retryAfterMs };
  if (st === 403 && (header('x-ratelimit-remaining') === '0' || header('retry-after') !== '' || msg.includes('rate limit'))) {
    return { kind: 'rate_limited', status: st, retryAfterMs };
  }
  if (st === 404 || st === 422) return { kind: 'not_found', status: st, retryAfterMs };
  if (st === 403) return { kind: 'forbidden', status: st, retryAfterMs };
  return { kind: 'other', status: st, retryAfterMs };
}

// ── side effects (injectable) ────────────────────────────────────────────────

const githubHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' });

/** ONE read of a pull request's head (sha, ref) and state. Throws on transport / HTTP errors. */
export async function fetchPullHead(token: string, owner: string, repo: string, prNumber: number): Promise<PullHead> {
  const axios = (await import('axios')).default;
  const resp = await axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: githubHeaders(token),
    timeout: 10_000,
  });
  const d = resp.data ?? {};
  return {
    sha: String(d?.head?.sha ?? ''),
    ref: d?.head?.ref ? String(d.head.ref) : null,
    state: String(d?.state ?? 'open'),
    merged: d?.merged === true || !!d?.merged_at,
  };
}

/**
 * ONE read of a branch's live head sha (the git ref — the lightest read:
 * pushes made with run_command / gh mint no git_push receipt, so the receipt
 * set alone cannot say a branch moved). 404 ⇒ the branch is gone. Throws on
 * transport / HTTP errors.
 */
export async function fetchBranchHead(token: string, owner: string, repo: string, branch: string): Promise<string> {
  const axios = (await import('axios')).default;
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  const resp = await axios.get(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${ref}`, {
    headers: githubHeaders(token),
    timeout: 10_000,
  });
  return String(resp.data?.object?.sha ?? '');
}

/**
 * Is the lane LIVE — a run in flight (chat-busy's three layers) or a wake
 * queued for it (a pending / delivering direct wake)? Used by the escalation
 * step and by hooks.service's project-supervisor gate. Every probe error reads
 * NOT live (fail toward delivery: the supervisor hears).
 *
 * r3 interactions fix (2026-10-20): a DELAYED direct wake that is not due yet
 * (payload.notBefore in the future — a merge intent's / an await_condition's
 * BACKSTOP one-shot, hours out) is no wake queued for the lane: it no longer
 * reads the lane live (it had deferred red-CI lane wakes and withheld the
 * supervisor's ci_failed row up to the 2 h hold on an idle lane). A
 * delivering row, and every due pending row, still count.
 */
export const LANE_LIVE_WAKE_SCAN = 50;
export async function isLaneLive(chatId: string): Promise<boolean> {
  try {
    const { isChatBusy } = await import('../chat-agent/chat-busy');
    if (await isChatBusy(chatId)) return true;
  } catch { /* fall through */ }
  try {
    const { TODO_WAKE_EVENT_TYPE, hookRowNotYetDue } = await import('../platform/hooks.service');
    const rows = await prisma.hookEvent.findMany({
      where: { status: { in: ['pending', 'delivering'] }, eventType: TODO_WAKE_EVENT_TYPE, hook: { targetChatId: chatId } },
      select: { status: true, payload: true },
      take: LANE_LIVE_WAKE_SCAN,
    });
    const nowMs = Date.now();
    // A full page reads live (the old count rule) — the bound never hides a due wake.
    return rows.length >= LANE_LIVE_WAKE_SCAN || rows.some((r: any) => r.status === 'delivering' || !hookRowNotYetDue(r, nowMs));
  } catch {
    return false;
  }
}

/**
 * The candidate receipts: coding sessions touched in the window → their ok
 * push / PR receipts. Every run flips its session row running → ready
 * (queueAgentRun / updateSessionState bump @updatedAt), so a session that
 * pushed inside the window was updated inside it too; a run still going is
 * caught by status 'running'. coding_sessions is small (one row per session),
 * and the receipt read rides the [chatId, createdAt] index — never a scan of
 * run_tool_receipts or agent_runs.
 */
async function loadCandidateReceipts(since: Date): Promise<CiWatchReceiptRow[]> {
  const sessions = await prisma.chatCodingState.findMany({
    where: { OR: [{ updatedAt: { gte: since } }, { status: 'running' }] },
    select: { id: true },
    orderBy: { updatedAt: 'desc' },
    take: CI_WATCH_SESSION_CAP,
  });
  const ids = [...new Set(sessions.map((s) => s.id).filter(Boolean))];
  if (!ids.length) return [];
  const rows = await prisma.runToolReceipt.findMany({
    where: { chatId: { in: ids }, ok: true, tool: { in: [...CI_WATCH_TOOLS] }, createdAt: { gte: since } },
    select: { id: true, chatId: true, runId: true, tool: true, ids: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: CI_WATCH_RECEIPT_CAP,
  });
  return rows as CiWatchReceiptRow[];
}

/**
 * The origin fields of the receipts' runs — ONE batched read per pass, by
 * primary key, reading only input->>'origin' / 'userTurnAt' /
 * 'ownerDispatch' (the input JSON carries the whole prompt). A run id that is
 * not an agent_runs row (a chat turn's telemetry id) is simply absent.
 */
async function loadRunOriginsDefault(runIds: string[]): Promise<Map<string, RunOriginFacts>> {
  const out = new Map<string, RunOriginFacts>();
  const ids = [...new Set(runIds.filter((x) => typeof x === 'string' && x.length > 0))].slice(0, CI_WATCH_RECEIPT_CAP);
  if (!ids.length) return out;
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; origin: string | null; userTurnAt: string | null; ownerDispatch: string | null }>>(
    `SELECT id, input->>'origin' AS origin, input->>'userTurnAt' AS "userTurnAt", input->>'ownerDispatch' AS "ownerDispatch"
       FROM agent_runs WHERE id = ANY($1::text[])`,
    ids,
  );
  for (const r of rows ?? []) out.set(String(r.id), { origin: r.origin ?? null, userTurnAt: r.userTurnAt ?? null, ownerDispatch: r.ownerDispatch ?? null });
  return out;
}

/**
 * The lane's chat + coding-state row, its lineage (parentChatId, the FIRST
 * run's origin, the project's supervisor toggle) and whether its NEWEST run
 * was an explicit stop. Throws on a DB error (the pass skips the lane — never
 * parks a sha on a hiccup); null only when the chat is gone.
 */
async function loadLaneDefault(chatId: string): Promise<CiWatchLane | null> {
  const c = await prisma.crossModelChat.findUnique({
    where: { id: chatId },
    select: {
      userId: true, archivedAt: true, parentChatId: true,
      codingState: {
        select: { status: true, project: { select: { repoUrl: true, repoProvider: true, githubLabel: true, projectSupervisorEnabled: true } } },
      },
    },
  });
  if (!c) return null;
  const cs = (c as any).codingState ?? null;
  const runs = await prisma.$queryRawUnsafe<Array<{ which: string; origin: string | null; userTurnAt: string | null; ownerDispatch: string | null; status: string | null; error: string | null }>>(
    `(SELECT 'first'::text AS which, input->>'origin' AS origin, input->>'userTurnAt' AS "userTurnAt", input->>'ownerDispatch' AS "ownerDispatch", status, error
        FROM agent_runs WHERE "sessionId" = $1 ORDER BY "createdAt" ASC LIMIT 1)
     UNION ALL
     (SELECT 'last'::text, NULL::text, NULL::text, NULL::text, status, error
        FROM agent_runs WHERE "sessionId" = $1 ORDER BY "createdAt" DESC LIMIT 1)`,
    chatId,
  );
  const first = (runs ?? []).find((r) => r.which === 'first') ?? null;
  const last = (runs ?? []).find((r) => r.which === 'last') ?? null;
  return {
    userId: c.userId,
    archived: !!c.archivedAt || cs?.status === 'archived',
    repoUrl: cs?.project?.repoUrl ?? null,
    provider: cs?.project?.repoProvider ?? null,
    githubLabel: cs?.project?.githubLabel ?? null,
    parentChatId: (c as any).parentChatId ?? null,
    machineStarted: first ? classifyRunOrigin(first) === 'machine' : false,
    projectSupervisorOn: cs?.project?.projectSupervisorEnabled === true,
    lastRunStopped: isExplicitStop(last),
  };
}

export interface CiWatchStore {
  getMany: <T>(keys: string[]) => Promise<Map<string, T>>;
  put: (key: string, value: Record<string, unknown>) => Promise<void>;
  /** Atomic create-only claim — false when the key already exists; THROWS on a store error (callers fail closed). */
  claim: (key: string, value: Record<string, unknown>) => Promise<boolean>;
  /** Drop a claim (a wake / emission that did not happen must be retried). */
  release: (key: string) => Promise<void>;
  prune: (before: Date) => Promise<number>;
}

async function defaultStore(): Promise<CiWatchStore> {
  const cs = await import('../memory/context-store');
  return {
    getMany: <T>(keys: string[]) => cs.storeGetMany<T>(CI_WATCH_NS, keys),
    put: (key, value) => cs.storePut(CI_WATCH_NS, key, value),
    claim: (key, value) => cs.storeCreate(CI_WATCH_NS, key, value),
    release: (key) => cs.storeDelete(CI_WATCH_NS, key),
    prune: (before) => cs.storePruneNamespace(CI_WATCH_NS, before),
  };
}

/**
 * r3 interactions fix (2026-10-20): a harness OUTCOME wake is about to tell a
 * lane its commit is RED — a merge intent BLOCKED at gate ci, an
 * await_condition 'ci' wake met red. ci-watch books it as the lane's ONE wake
 * about that sha: the lane ledger marks it woken (it counts toward
 * CI_WATCH_LANE_WAKE_MAX and CI_WATCH_LANE_LOOP_REDS) and the wake:<sha> claim
 * is taken, so route() never wakes the lane a second time about it. When the
 * lane's loop budget is already spent and ci-watch watches that sha, answers
 * 'loop': the caller does NOT wake the lane — ci-watch's next pass routes the
 * sha into the ONE lane_loop escalation (or keeps it suppressed), exactly as
 * for its own wakes; the two red-fix loops are one. Fail toward delivery:
 * CI_WATCH_DISABLED=1, a sha ci-watch does not watch, a store error ⇒
 * 'deliver'. Never throws.
 */
export async function noteHarnessRedWake(
  i: { chatId: string; sha: string; branch?: string | null; via: string },
  deps: { now?: Date; store?: CiWatchStore } = {},
): Promise<'deliver' | 'loop'> {
  if (ciWatchDisabled()) return 'deliver';
  const sha = String(i.sha ?? '').trim().toLowerCase();
  if (!i.chatId || !SHA_RE.test(sha)) return 'deliver';
  const now = deps.now ?? new Date();
  try {
    const store = deps.store ?? (await defaultStore());
    const lk = laneLedgerKey(i.chatId);
    const got = await store.getMany<any>([lk, sha]);
    const row = got.get(sha) as CiWatchRecord | undefined;
    const prev = got.get(lk) as CiWatchLaneLedger | undefined;
    const red = { sha, branch: i.branch ?? row?.branch ?? null };
    let ledger = noteLaneRed(pruneLaneLedger(prev && prev.kind === 'lane' ? prev : null, i.chatId, now), red, now);
    const loop = laneLoopVerdict(ledger);
    const watched = !!row && row.chatId === i.chatId && !row.terminal;
    if (loop.stop && watched) {
      await store.put(lk, ledger as unknown as Record<string, unknown>);
      metric(i.chatId, { phase: 'harness_wake', verdict: 'loop', via: i.via, sha, wakes: loop.wakes, reds: loop.reds, why: loop.why });
      return 'loop';
    }
    ledger = markLaneWoken(ledger, red, now);
    await store.put(lk, ledger as unknown as Record<string, unknown>);
    await store.claim(`wake:${sha}`, { at: iso(now), by: i.via }).catch(() => false);
    metric(i.chatId, { phase: 'harness_wake', verdict: 'deliver', via: i.via, sha, wakes: laneLoopVerdict(ledger).wakes, reds: loop.reds });
    return 'deliver';
  } catch (err: any) {
    logger.warn(`${SOURCE}: harness red wake for ${sha.slice(0, 12)} not booked (delivered anyway): ${err?.message ?? err}`, { source: SOURCE });
    return 'deliver';
  }
}

export interface CiWatchDeps {
  now?: Date;
  maxPerPass?: number;
  loadReceipts?: (since: Date) => Promise<CiWatchReceiptRow[]>;
  loadRunOrigins?: (runIds: string[]) => Promise<Map<string, RunOriginFacts>>;
  loadLane?: (chatId: string) => Promise<CiWatchLane | null>;
  getToken?: (userId: string, label: string | null) => Promise<string | null>;
  fetchCiStatus?: (token: string, owner: string, repo: string, sha: string) => Promise<CiStatus>;
  fetchPullHead?: (token: string, owner: string, repo: string, prNumber: number) => Promise<PullHead>;
  fetchBranchHead?: (token: string, owner: string, repo: string, branch: string) => Promise<string>;
  enqueueDirectWake?: (o: { targetChatId: string; prompt: string; meta?: Record<string, unknown> }) => Promise<{ ok: boolean; hookEventId?: string; error?: string }>;
  /** Awaited; a result with error:true is retried next pass, written:0 is recorded 'no_supervisor'. */
  emitCiFailed?: (sessionId: string, sha: string, failing: string[], opts?: { note?: string; extra?: Record<string, unknown> }) => Promise<CiFailedEmitResult | void> | CiFailedEmitResult | void;
  isLaneLive?: (chatId: string) => Promise<boolean>;
  /** An open merge intent / await_condition 'ci' wake of this lane on this sha owes the lane its wake (default merge-intent.service harnessWaitCoversSha). */
  harnessWaitCovers?: (chatId: string, sha: string) => Promise<boolean>;
  store?: CiWatchStore;
}

export interface CiWatchCounters {
  candidates: number; due: number; checked: number; red: number; woken: number; escalated: number;
  resolved: number; superseded: number; rateLimited: number; skipped: number; pruned: number;
  outOfScope: number; noSupervisor: number; loop: number;
}

/** The ≤ 200-char cron lastStatus line. Pure. */
export function renderPassSummary(c: CiWatchCounters): string {
  return `ci-watch: candidates ${c.candidates}, due ${c.due}, checked ${c.checked}, red ${c.red}, woken ${c.woken}, escalated ${c.escalated}, resolved ${c.resolved}, superseded ${c.superseded}, rate-limited ${c.rateLimited}, pruned ${c.pruned}, out-of-scope ${c.outOfScope}, no-supervisor ${c.noSupervisor}, loop ${c.loop}`.slice(0, 200);
}

function metric(sessionId: string | undefined, meta: Record<string, unknown>): void {
  try { recordLoopMetric({ kind: LOOP_METRIC_KINDS.CI_WATCH, ...(sessionId ? { sessionId } : {}), value: 1, meta }); } catch { /* telemetry never breaks the pass */ }
}

/**
 * ONE ci-watch pass (the cron handler). Never throws; returns the pass
 * summary for cron_jobs.lastStatus.
 */
export async function runCiWatchOnce(deps: CiWatchDeps = {}): Promise<string> {
  const c: CiWatchCounters = {
    candidates: 0, due: 0, checked: 0, red: 0, woken: 0, escalated: 0, resolved: 0, superseded: 0, rateLimited: 0, skipped: 0, pruned: 0,
    outOfScope: 0, noSupervisor: 0, loop: 0,
  };
  if (ciWatchDisabled()) return `ci-watch: disabled (${CI_WATCH_DISABLED_ENV}=1)`;
  const now = deps.now ?? new Date();
  const budgetMax = Math.max(1, Math.floor(deps.maxPerPass ?? CI_WATCH_MAX_PER_PASS));
  try {
    const store = deps.store ?? (await defaultStore());
    await new CiWatchPass(deps, now, budgetMax, c, store).run();
    if (c.checked > 0 || c.rateLimited > 0 || c.outOfScope > 0) metric(undefined, { phase: 'pass', ...c, budget: budgetMax });
  } catch (err: any) {
    logger.warn(`${SOURCE}: pass failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
  }
  return renderPassSummary(c);
}

type GithubError = ReturnType<typeof classifyGithubError>;
type LaneAccess = { l: CiWatchLane; token: string };
/** The live head read before a route / an escalation. */
type HeadRead =
  | { kind: 'current' }
  | { kind: 'moved'; sha: string; via: 'pr_head' | 'branch_head'; adopted: boolean }
  | { kind: 'closed'; why: 'pr_merged' | 'pr_closed' | 'branch_gone' }
  | { kind: 'unknown' }
  | { kind: 'no_budget' }
  | { kind: 'rate_limited' };

/** One pass's state + steps (a class only to share the per-pass caches; not exported). */
class CiWatchPass {
  private budget: number;
  private readonly loadReceipts: (since: Date) => Promise<CiWatchReceiptRow[]>;
  private readonly loadRunOrigins: (runIds: string[]) => Promise<Map<string, RunOriginFacts>>;
  private readonly loadLane: (chatId: string) => Promise<CiWatchLane | null>;
  private readonly getToken: (userId: string, label: string | null) => Promise<string | null>;
  private readonly fetchCi: (token: string, owner: string, repo: string, sha: string) => Promise<CiStatus>;
  private readonly fetchPr: (token: string, owner: string, repo: string, prNumber: number) => Promise<PullHead>;
  private readonly fetchHead: (token: string, owner: string, repo: string, branch: string) => Promise<string>;
  private readonly wake: NonNullable<CiWatchDeps['enqueueDirectWake']>;
  private readonly emit: NonNullable<CiWatchDeps['emitCiFailed']>;
  private readonly laneLive: (chatId: string) => Promise<boolean>;
  private readonly harnessCovers: (chatId: string, sha: string) => Promise<boolean>;
  private shas = new Map<string, CiWatchTarget>();
  private prs: CiWatchTarget[] = [];
  private records = new Map<string, CiWatchRecord>();
  private pointers = new Map<string, CiWatchPrPointer>();
  private origins = new Map<string, RunOriginFacts>();
  private originsFailed = false;
  private readonly lanes = new Map<string, CiWatchLane | null | 'error'>();
  private readonly tokens = new Map<string, string | null>();
  private readonly backoff = new Map<string, boolean>();
  private readonly ledgers = new Map<string, CiWatchLaneLedger>();
  private readonly done = new Set<string>();

  constructor(
    deps: CiWatchDeps,
    private readonly now: Date,
    budgetMax: number,
    private readonly c: CiWatchCounters,
    private readonly store: CiWatchStore,
  ) {
    this.budget = budgetMax;
    this.loadReceipts = deps.loadReceipts ?? loadCandidateReceipts;
    this.loadRunOrigins = deps.loadRunOrigins ?? loadRunOriginsDefault;
    this.loadLane = deps.loadLane ?? loadLaneDefault;
    this.getToken = deps.getToken ?? (async (userId, label) => (await import('../github/token-manager')).getValidToken(userId, label || undefined));
    this.fetchCi = deps.fetchCiStatus ?? (async (t, o, r, s) => (await import('./ci-status')).fetchCiStatus(t, o, r, s));
    this.fetchPr = deps.fetchPullHead ?? fetchPullHead;
    this.fetchHead = deps.fetchBranchHead ?? fetchBranchHead;
    this.wake = deps.enqueueDirectWake ?? (async (o) => (await import('../platform/hooks.service')).enqueueDirectWake(o));
    this.emit = deps.emitCiFailed ?? (async (s, sha, f, o) => (await import('./ci-status')).emitCiFailedAwaited(s, sha, f, o));
    this.laneLive = deps.isLaneLive ?? isLaneLive;
    this.harnessCovers = deps.harnessWaitCovers ?? (async (chatId, sha) => (await import('./merge-intent.service')).harnessWaitCoversSha(chatId, sha));
  }

  private at(offsetMs = 0): string { return iso(new Date(this.now.getTime() + offsetMs)); }
  private repoOf(rec: CiWatchRecord): string { return `${rec.owner}/${rec.repo}`; }

  async run(): Promise<void> {
    // Housekeeping first: the namespace only matters inside the 24 h window.
    this.c.pruned = await this.store.prune(new Date(this.now.getTime() - CI_WATCH_RECORD_TTL_MS)).catch(() => 0);
    const rows = await this.loadReceipts(new Date(this.now.getTime() - CI_WATCH_WINDOW_MS));
    const { shas, prs } = receiptsToTargets(rows);
    this.shas = shas;
    this.prs = prs;
    this.c.candidates = shas.size + prs.length;
    if (!this.c.candidates) return;

    // PR pointers → a resolved PR becomes (or enriches) a sha target; an unresolved due one is work.
    this.pointers = await this.store.getMany<CiWatchPrPointer>(prs.map((p) => p.key));
    const prWork: CiWatchTarget[] = [];
    for (const p of prs) {
      const ptr = this.pointers.get(p.key);
      if (ptr?.sha) mergePrPointer(this.shas, p, ptr);
      else if (isDue(ptr, this.now)) prWork.push(p);
    }
    this.records = await this.store.getMany<CiWatchRecord>([...this.shas.keys()]);

    const queue = orderDue([
      ...prWork.map((t) => ({ target: t, lastCheckedAt: null as string | null, urgent: false })),
      ...[...this.shas.values()]
        .filter((t) => isDue(this.records.get(t.key), this.now))
        .map((t) => {
          const rec = this.records.get(t.key);
          return { target: t, lastCheckedAt: rec?.lastCheckedAt ?? null, urgent: rec?.state === 'failure' };
        }),
    ]);
    this.c.due = queue.length;

    // The runs behind every receipt a FIRST check classifies — one batched read.
    const runIds = [...new Set(queue
      .filter((i) => i.target.kind === 'pr' || !this.records.get(i.target.key))
      .map((i) => i.target.runId)
      .filter((x): x is string => !!x))];
    if (runIds.length) {
      try {
        this.origins = await this.loadRunOrigins(runIds);
      } catch (err: any) {
        this.originsFailed = true; // new targets wait a pass — never classified on a hiccup
        logger.warn(`${SOURCE}: run-origin read failed (new targets wait a pass): ${err?.message ?? err}`, { source: SOURCE });
      }
    }

    for (const { target } of queue) {
      if (this.budget <= 0 || this.c.rateLimited >= CI_WATCH_RATE_LIMIT_STOP) break;
      try {
        if (target.kind === 'pr') await this.resolvePr(target);
        else await this.checkSha(target);
      } catch (err: any) {
        logger.warn(`${SOURCE}: target ${target.key.slice(0, 16)} failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
      }
    }
  }

  // ── caches + shared gates ─────────────────────────────────────────────────

  /** The lane (cached per pass). 'error' = the read failed — skip this pass, never park on a hiccup. */
  private async lane(chatId: string): Promise<CiWatchLane | null | 'error'> {
    if (!this.lanes.has(chatId)) {
      let v: CiWatchLane | null | 'error';
      try { v = await this.loadLane(chatId); } catch { v = 'error'; }
      this.lanes.set(chatId, v);
    }
    return this.lanes.get(chatId) ?? null;
  }

  private async token(l: CiWatchLane): Promise<string | null> {
    const k = `${l.userId}|${l.githubLabel ?? ''}`;
    if (!this.tokens.has(k)) this.tokens.set(k, await this.getToken(l.userId, l.githubLabel).catch(() => null));
    return this.tokens.get(k) ?? null;
  }

  /** The owner is backed off (rate limit / no token) — read once per pass, cached both ways. */
  private async backedOff(userId: string): Promise<boolean> {
    const hit = this.backoff.get(userId);
    if (hit !== undefined) return hit;
    const key = `backoff:${userId}`;
    const row = (await this.store.getMany<{ until?: string }>([key]).catch(() => new Map<string, { until?: string }>())).get(key);
    const on = !!row && ms(row.until) > this.now.getTime();
    this.backoff.set(userId, on);
    return on;
  }

  private async backOff(userId: string, untilMs: number, reason: string): Promise<void> {
    this.backoff.set(userId, true);
    await this.store.put(`backoff:${userId}`, { until: iso(new Date(untilMs)), reason, at: this.at() }).catch(() => {});
  }

  private async save(key: string, value: object): Promise<void> {
    await this.store.put(key, value as Record<string, unknown>)
      .catch((err: any) => logger.warn(`${SOURCE}: store write failed for ${key.slice(0, 20)}: ${err?.message ?? err}`, { source: SOURCE }));
  }

  /** The owner's GitHub token, or null = skip this pass (owner backed off / no token). */
  private async creds(l: CiWatchLane): Promise<string | null> {
    if (await this.backedOff(l.userId)) { this.c.skipped++; return null; }
    const token = await this.token(l);
    if (!token) {
      await this.backOff(l.userId, this.now.getTime() + 60 * 60 * 1000, 'no_token');
      this.c.skipped++;
      return null;
    }
    return token;
  }

  /** The receipt's run → human / machine / unknown; null = the batched read failed (wait a pass). */
  private receiptClass(t: CiWatchTarget): RunOriginClass | null {
    if (!t.runId) return 'human'; // no run: an owner-confirmed card executed it
    if (this.originsFailed) return null;
    return classifyRunOrigin(this.origins.get(t.runId) ?? null);
  }

  private scopeFor(t: CiWatchTarget, l: CiWatchLane): CiWatchScope | null {
    const receipt = this.receiptClass(t);
    if (receipt === null) return null;
    return ciWatchScope({ receipt, parentChatId: l.parentChatId, machineStarted: l.machineStarted, projectSupervisorOn: l.projectSupervisorOn });
  }

  /** Observe only: one telemetry row, the row parked — never a wake, never an escalation. */
  private async outOfScope(key: string, base: object, scope: CiWatchScope, chatId: string, sha: string | null): Promise<void> {
    this.c.outOfScope++;
    metric(chatId, { phase: 'out_of_scope', scope, sha, key: key.slice(0, 48) });
    await this.save(key, { ...base, terminal: true, outcome: 'out_of_scope', scope });
  }

  /** One GitHub read through the budget; a rate limit backs the owner off. */
  private async github<T>(userId: string, call: () => Promise<T>): Promise<{ ok: T } | { err: GithubError }> {
    this.budget--;
    this.c.checked++;
    try {
      return { ok: await call() };
    } catch (e: any) {
      const err = classifyGithubError(e, this.now);
      if (err.kind === 'rate_limited') {
        this.c.rateLimited++;
        await this.backOff(userId, this.now.getTime() + err.retryAfterMs, `http_${err.status ?? 'rate'}`);
      }
      return { err };
    }
  }

  /** The lane's loop ledger (cached per pass, pruned to the window). null = the store read failed. */
  private async ledger(chatId: string): Promise<CiWatchLaneLedger | null> {
    const cached = this.ledgers.get(chatId);
    if (cached) return cached;
    try {
      const key = laneLedgerKey(chatId);
      const got = (await this.store.getMany<CiWatchLaneLedger>([key])).get(key);
      const l = pruneLaneLedger(got && got.kind === 'lane' ? got : null, chatId, this.now);
      this.ledgers.set(chatId, l);
      return l;
    } catch {
      return null;
    }
  }

  private async putLedger(l: CiWatchLaneLedger): Promise<void> {
    this.ledgers.set(l.chatId, l);
    await this.save(laneLedgerKey(l.chatId), l);
  }

  // ── an unresolved PR → its head sha ───────────────────────────────────────

  private async resolvePr(target: CiWatchTarget): Promise<void> {
    const ptr: CiWatchPrPointer = this.pointers.get(target.key) ?? {
      v: 1, kind: 'pr', receiptId: target.receiptId, owner: String(target.owner), repo: String(target.repo),
      prNumber: Number(target.prNumber), sha: null, branch: null, terminal: false, outcome: null, errors: 0, nextCheckAt: this.at(),
    };
    if (!repoTargetAllowed(`https://github.com/${ptr.owner}/${ptr.repo}`)) { await this.save(target.key, { ...ptr, terminal: true, outcome: 'isolated' }); return; }
    const l = await this.lane(target.chatId);
    if (l === 'error') return;
    if (!l) { await this.save(target.key, { ...ptr, terminal: true, outcome: 'no_lane' }); return; }
    const scope = this.scopeFor(target, l);
    if (scope === null) return;
    if (scope !== 'lane') { await this.outOfScope(target.key, ptr, scope, target.chatId, null); return; }
    const token = await this.creds(l);
    if (!token) return;
    const r = await this.github(l.userId, () => this.fetchPr(token, ptr.owner, ptr.repo, ptr.prNumber));
    if ('err' in r) {
      if (r.err.kind === 'rate_limited') return;
      const errors = ptr.errors + 1;
      await this.save(target.key, errors >= CI_WATCH_MAX_ERRORS
        ? { ...ptr, errors, terminal: true, outcome: r.err.kind === 'not_found' ? 'not_found' : 'unobservable' }
        : { ...ptr, errors, nextCheckAt: this.at(CI_WATCH_ERROR_RETRY_MS) });
      return;
    }
    const head = r.ok;
    if (head.state !== 'open' || head.merged || !SHA_RE.test(head.sha)) {
      await this.save(target.key, { ...ptr, terminal: true, outcome: 'closed' });
      return;
    }
    const resolved: CiWatchPrPointer = { ...ptr, sha: head.sha.toLowerCase(), branch: head.ref, terminal: true, outcome: null };
    this.pointers.set(target.key, resolved);
    await this.save(target.key, resolved);
    mergePrPointer(this.shas, target, resolved);
    const sha = resolved.sha as string;
    if (!this.records.has(sha)) {
      const got = (await this.store.getMany<CiWatchRecord>([sha]).catch(() => new Map<string, CiWatchRecord>())).get(sha);
      if (got) this.records.set(sha, got);
    }
    // A sha parked 'none' before the PR existed gets its checks now — re-open it.
    const prev = this.records.get(sha);
    if (prev?.terminal && prev.outcome === 'none') {
      const reopened: CiWatchRecord = { ...prev, terminal: false, outcome: null, prNumber: prev.prNumber ?? resolved.prNumber, nextCheckAt: this.at() };
      this.records.set(sha, reopened);
      await this.save(sha, reopened);
    }
    const shaTarget = this.shas.get(sha);
    if (shaTarget && this.budget > 0 && isDue(this.records.get(sha), this.now)) await this.checkSha(shaTarget);
  }

  // ── one sha: poll, or (once handed to the lane) escalate ─────────────────

  private async checkSha(target: CiWatchTarget): Promise<void> {
    const sha = String(target.sha);
    if (this.done.has(sha)) return;
    this.done.add(sha);
    let rec = this.records.get(sha) ?? null;
    const l = await this.lane(target.chatId);
    if (l === 'error') return;
    if (!l) {
      await this.save(sha, { ...(rec ?? newRecord(target, target.owner ?? '', target.repo ?? '', this.now)), terminal: true, outcome: 'no_lane' });
      return;
    }
    // SCOPE before any GitHub read: a human's push / a non-machine lane is observed only.
    if (!rec) {
      const scope = this.scopeFor(target, l);
      if (scope === null) return;
      if (scope !== 'lane') {
        await this.outOfScope(sha, newRecord(target, target.owner ?? '', target.repo ?? '', this.now), scope, target.chatId, sha);
        return;
      }
    }
    const token = await this.creds(l);
    if (!token) return;
    const a: LaneAccess = { l, token };
    if (!rec) {
      const or = target.owner && target.repo ? { owner: target.owner, repo: target.repo } : parseGithubRepo(l.repoUrl);
      if (!or) { await this.save(sha, { ...newRecord(target, '', '', this.now), terminal: true, outcome: 'not_github' }); return; }
      rec = { ...newRecord(target, or.owner, or.repo, this.now), scope: 'lane' };
    } else if (target.prNumber != null && rec.prNumber == null) {
      rec = { ...rec, prNumber: target.prNumber };
    }
    if (!repoTargetAllowed(`https://github.com/${rec.owner}/${rec.repo}`)) { await this.save(sha, { ...rec, terminal: true, outcome: 'isolated' }); return; }
    if (this.budget <= 0) return;
    const next = rec.laneWokenAt ? await this.escalationCheck(rec, a) : await this.poll(rec, a);
    if (!next) return; // rate limited — the row stays due, nothing learned
    this.records.set(sha, next);
    await this.save(sha, next);
  }

  private async poll(rec: CiWatchRecord, a: LaneAccess): Promise<CiWatchRecord | null> {
    const r = await this.github(a.l.userId, () => this.fetchCi(a.token, rec.owner, rec.repo, rec.sha));
    if ('err' in r) {
      if (r.err.kind === 'rate_limited') return null;
      const errors = rec.errors + 1;
      return errors >= CI_WATCH_MAX_ERRORS
        ? { ...rec, errors, state: 'unobservable', terminal: true, outcome: r.err.kind === 'not_found' ? 'not_found' : 'unobservable', lastCheckedAt: this.at() }
        : { ...rec, errors, lastCheckedAt: this.at(), nextCheckAt: this.at(CI_WATCH_ERROR_RETRY_MS) };
    }
    const folded = applyCiObservation(rec, r.ok, this.now);
    return folded.route ? this.route(folded.rec, a) : folded.rec;
  }

  /**
   * The live head of the sha's PR (when known) or branch — ONE budgeted read.
   * A moved PR head is ADOPTED: the lane's PR pointer is re-pointed at it, so
   * the next pass watches the commit the lane actually pushed (with run_command
   * / gh it minted no git_push receipt).
   */
  private async liveHead(rec: CiWatchRecord, a: LaneAccess): Promise<HeadRead> {
    if (!rec.prNumber && !rec.branch) return { kind: 'unknown' };
    if (this.budget <= 0) return { kind: 'no_budget' };
    if (rec.prNumber) {
      const prNumber = rec.prNumber;
      const r = await this.github(a.l.userId, () => this.fetchPr(a.token, rec.owner, rec.repo, prNumber));
      if ('err' in r) return r.err.kind === 'rate_limited' ? { kind: 'rate_limited' } : { kind: 'unknown' };
      if (r.ok.merged) return { kind: 'closed', why: 'pr_merged' };
      if (r.ok.state !== 'open') return { kind: 'closed', why: 'pr_closed' };
      const head = String(r.ok.sha ?? '').toLowerCase();
      if (!SHA_RE.test(head)) return { kind: 'unknown' };
      if (sameSha(head, rec.sha)) return { kind: 'current' };
      const adopted = await this.adoptPrHead(rec, head, r.ok.ref);
      return { kind: 'moved', sha: head, via: 'pr_head', adopted };
    }
    const branch = rec.branch as string;
    const r = await this.github(a.l.userId, () => this.fetchHead(a.token, rec.owner, rec.repo, branch));
    if ('err' in r) {
      if (r.err.kind === 'rate_limited') return { kind: 'rate_limited' };
      // The CI read with this token succeeded, so a ref 404 means the branch is gone (merged / abandoned).
      return r.err.kind === 'not_found' ? { kind: 'closed', why: 'branch_gone' } : { kind: 'unknown' };
    }
    const head = String(r.ok ?? '').toLowerCase();
    if (!SHA_RE.test(head)) return { kind: 'unknown' };
    return sameSha(head, rec.sha) ? { kind: 'current' } : { kind: 'moved', sha: head, via: 'branch_head', adopted: false };
  }

  /** Re-point this lane's PR pointer at the PR's new head (the next pass watches it). */
  private async adoptPrHead(rec: CiWatchRecord, head: string, ref: string | null): Promise<boolean> {
    const lc = (s: string | null) => String(s ?? '').toLowerCase();
    const pr = this.prs.find((p) => p.chatId === rec.chatId && p.prNumber === rec.prNumber && lc(p.owner) === lc(rec.owner) && lc(p.repo) === lc(rec.repo));
    const ptr = pr ? this.pointers.get(pr.key) : undefined;
    if (!pr || !ptr) return false;
    const next: CiWatchPrPointer = { ...ptr, sha: head, branch: ref ?? ptr.branch, terminal: true, outcome: null };
    this.pointers.set(pr.key, next);
    await this.save(pr.key, next);
    return true;
  }

  /** The lane moved past this red sha. At route time it still counts toward the lane's red-push chain. */
  private async supersede(rec: CiWatchRecord, at: 'route' | 'escalation', by: string, via: 'receipt' | 'pr_head' | 'branch_head', adopted = false): Promise<CiWatchRecord> {
    this.c.superseded++;
    if (at === 'route') {
      this.c.red++;
      const ledger = await this.ledger(rec.chatId);
      if (ledger) await this.putLedger(noteLaneRed(ledger, rec, this.now));
    }
    metric(rec.chatId, { phase: 'superseded', at, via, sha: rec.sha, by, adopted, repo: this.repoOf(rec) });
    return { ...rec, terminal: true, outcome: 'superseded' };
  }

  private closed(rec: CiWatchRecord, why: string): CiWatchRecord {
    metric(rec.chatId, { phase: 'closed', why, sha: rec.sha, repo: this.repoOf(rec), prNumber: rec.prNumber });
    return { ...rec, terminal: true, outcome: 'closed' };
  }

  /** Route a COMPLETED red sha — the lane FIRST, inside the lane's loop budget. */
  private async route(rec: CiWatchRecord, a: LaneAccess): Promise<CiWatchRecord | null> {
    const l = a.l;
    const newer = findSupersedingPush(rec, this.shas.values());
    if (newer) return this.supersede(rec, 'route', String(newer.sha), 'receipt');
    // A LIVE lane may be reading this very verdict (its own check_ci) and
    // fixing it — never queue a wake onto it; re-check once it is idle (a
    // newer push then supersedes the sha). Bounded: red past the hold, the
    // wake is queued anyway (it parks until the run ends).
    if (redHeldMs(rec, this.now) < CI_WATCH_PS_MAX_HOLD_MS && await this.laneLive(rec.chatId).catch(() => false)) {
      return { ...rec, nextCheckAt: this.at(CI_WATCH_INTERVAL_SEC * 1000) };
    }
    // r3 interactions fix (2026-10-20): a merge intent / an await_condition
    // 'ci' wake this lane holds on this exact sha already owes the lane its
    // ONE wake about it (the harness wait's outcome, booked through
    // noteHarnessRedWake) — never a second wake from here. Same hold bound.
    if (redHeldMs(rec, this.now) < CI_WATCH_PS_MAX_HOLD_MS && await this.harnessCovers(rec.chatId, rec.sha).catch(() => false)) {
      return { ...rec, nextCheckAt: this.at(CI_WATCH_INTERVAL_SEC * 1000) };
    }
    const head = await this.liveHead(rec, a);
    if (head.kind === 'rate_limited') return null;
    if (head.kind === 'no_budget') return { ...rec, nextCheckAt: this.at() }; // urgent next pass
    if (head.kind === 'moved') return this.supersede(rec, 'route', head.sha, head.via, head.adopted);
    if (head.kind === 'closed') return this.closed(rec, head.why);
    rec = { ...rec, headVerified: head.kind === 'current' };
    this.c.red++;
    if (l.archived) return this.escalate(rec, 'lane_unwakeable', { why: 'the lane chat is archived' });
    if (l.lastRunStopped) return this.escalate(rec, 'lane_stopped');

    const ledger0 = await this.ledger(rec.chatId);
    if (!ledger0) return { ...rec, nextCheckAt: this.at(CI_WATCH_INTERVAL_SEC * 1000) }; // budget unreadable — fail closed
    if (ledger0.reds.some((x) => x.woken && sameSha(x.sha, rec.sha))) {
      // A harness outcome wake already told the lane (an abbreviated sha too —
      // the ledger matches by prefix): that was its one wake; the supervisor
      // escalation follows as after a ci-watch wake.
      metric(rec.chatId, { phase: 'harness_woken', sha: rec.sha, repo: this.repoOf(rec) });
      return { ...rec, laneWokenAt: rec.laneWokenAt ?? this.at(), nextCheckAt: this.at(CI_WATCH_LANE_GRACE_MS) };
    }
    let ledger = noteLaneRed(ledger0, rec, this.now);
    const loop = laneLoopVerdict(ledger);
    if (loop.stop) {
      this.c.loop++;
      if (ledger.loopEscalatedAt) {
        await this.putLedger(ledger);
        metric(rec.chatId, { phase: 'loop_suppressed', sha: rec.sha, repo: this.repoOf(rec), wakes: loop.wakes, reds: loop.reds, loopEscalatedAt: ledger.loopEscalatedAt });
        return { ...rec, terminal: true, outcome: 'loop_suppressed' };
      }
      const out = await this.escalate(rec, 'lane_loop', { ledger, why: loop.why ?? undefined });
      if (out.terminal) ledger = { ...ledger, loopEscalatedAt: this.at() };
      await this.putLedger(ledger);
      return out;
    }

    let first: boolean;
    try {
      first = await this.store.claim(`wake:${rec.sha}`, { at: this.at() });
    } catch (err: any) {
      await this.putLedger(ledger);
      logger.warn(`${SOURCE}: wake claim failed for ${rec.sha.slice(0, 12)} (fail closed — retried next pass): ${err?.message ?? err}`, { source: SOURCE });
      return { ...rec, nextCheckAt: this.at(CI_WATCH_INTERVAL_SEC * 1000) };
    }
    let wakeId: string | null = rec.wakeEventId;
    if (first) {
      const count = loop.wakes + 1;
      const res = await this.wake({
        targetChatId: rec.chatId,
        prompt: renderLaneWakePrompt(rec, { count, max: CI_WATCH_LANE_WAKE_MAX }),
        meta: { origin: 'ci-watch', sha: rec.sha, repo: this.repoOf(rec), ...(rec.prNumber ? { prNumber: rec.prNumber } : {}), failing: rec.failing.slice(0, 20), wakeCount: count, wakeMax: CI_WATCH_LANE_WAKE_MAX },
      }).catch((err: any) => ({ ok: false, error: String(err?.message ?? err) } as { ok: boolean; hookEventId?: string; error?: string }));
      if (!res?.ok) {
        // Nothing was enqueued: the claim goes back (a later pass may wake the lane) and the supervisor hears now.
        await this.store.release(`wake:${rec.sha}`).catch(() => {});
        await this.putLedger(ledger);
        return this.escalate(rec, 'lane_unwakeable', { why: `the wake could not be queued: ${String(res?.error ?? 'error').slice(0, 80)}` });
      }
      wakeId = res.hookEventId ?? null;
      this.c.woken++;
      metric(rec.chatId, { phase: 'lane_woken', sha: rec.sha, repo: this.repoOf(rec), failing: rec.failing.length, prNumber: rec.prNumber, wakeEventId: wakeId, wakeCount: count, wakeMax: CI_WATCH_LANE_WAKE_MAX, headVerified: rec.headVerified });
    }
    ledger = markLaneWoken(ledger, rec, this.now); // an existing claim = an earlier pass woke it
    await this.putLedger(ledger);
    return { ...rec, laneWokenAt: rec.laneWokenAt ?? this.at(), wakeEventId: wakeId, nextCheckAt: this.at(CI_WATCH_LANE_GRACE_MS) };
  }

  /** Already handed to the lane: wait while it is live, resolve on green, else tell the supervisor. */
  private async escalationCheck(rec: CiWatchRecord, a: LaneAccess): Promise<CiWatchRecord | null> {
    const heldMs = redHeldMs(rec, this.now);
    const newer = findSupersedingPush(rec, this.shas.values());
    const live = newer ? false : await this.laneLive(rec.chatId).catch(() => false);
    const step = escalationStep({ superseded: !!newer, live, heldMs });
    if (step === 'superseded') return this.supersede(rec, 'escalation', String(newer?.sha), 'receipt');
    if (step === 'wait') return { ...rec, nextCheckAt: this.at(CI_WATCH_INTERVAL_SEC * 1000) };
    const head = await this.liveHead(rec, a);
    if (head.kind === 'rate_limited') return null;
    if (head.kind === 'no_budget') return { ...rec, nextCheckAt: this.at() };
    if (head.kind === 'moved') return this.supersede(rec, 'escalation', head.sha, head.via, head.adopted);
    if (head.kind === 'closed') return this.closed(rec, head.why);
    const verified: CiWatchRecord = { ...rec, headVerified: head.kind === 'current' };
    if (this.budget <= 0) return { ...verified, nextCheckAt: this.at() };
    const r = await this.github(a.l.userId, () => this.fetchCi(a.token, rec.owner, rec.repo, rec.sha));
    const reason: CiWatchEscalation = a.l.archived ? 'lane_unwakeable' : a.l.lastRunStopped ? 'lane_stopped' : live ? 'max_hold' : 'lane_idle';
    const why = a.l.archived ? 'the lane chat was archived after the wake' : undefined;
    if ('err' in r) {
      if (r.err.kind === 'rate_limited') return null;
      // A failed re-read is retried like a poll; only the error budget or the hold escalates on the last verdict.
      const errors = rec.errors + 1;
      const failed: CiWatchRecord = { ...verified, errors, lastCheckedAt: this.at() };
      if (errors < CI_WATCH_MAX_ERRORS && heldMs < CI_WATCH_PS_MAX_HOLD_MS) return { ...failed, nextCheckAt: this.at(CI_WATCH_ERROR_RETRY_MS) };
      return this.escalate(failed, reason, { why, errors });
    }
    const next: CiWatchRecord = {
      ...verified, lastCheckedAt: this.at(), checks: rec.checks + 1, errors: 0, state: r.ok.state,
      ...(r.ok.state === 'failure' && r.ok.failing.length ? { failing: r.ok.failing.map(String).slice(0, 20) } : {}),
    };
    const verdict = afterRecheck({ state: r.ok.state, live, heldMs });
    if (verdict === 'resolved') {
      this.c.resolved++;
      metric(rec.chatId, { phase: 'resolved', sha: rec.sha, repo: this.repoOf(rec), heldMs });
      return { ...next, terminal: true, outcome: 'resolved' };
    }
    if (verdict === 'wait') return { ...next, nextCheckAt: this.at(CI_WATCH_INTERVAL_SEC * 1000) };
    return this.escalate(next, reason, { why });
  }

  /**
   * Tell the supervisor ONCE per sha (ci_failed carrying ciWatchEscalation),
   * AWAITED. The claim fails closed (a store error retries next pass); an
   * emission that failed releases its claim and retries; one no hook heard is
   * 'no_supervisor' — never counted as escalated.
   */
  private async escalate(rec: CiWatchRecord, reason: CiWatchEscalation, o: { why?: string; errors?: number; ledger?: CiWatchLaneLedger } = {}): Promise<CiWatchRecord> {
    const key = `emit:${rec.sha}`;
    let first: boolean;
    try {
      first = await this.store.claim(key, { at: this.at(), reason });
    } catch (err: any) {
      logger.warn(`${SOURCE}: escalation claim failed for ${rec.sha.slice(0, 12)} (fail closed — retried next pass): ${err?.message ?? err}`, { source: SOURCE });
      return { ...rec, nextCheckAt: this.at(CI_WATCH_INTERVAL_SEC * 1000) };
    }
    const done = (outcome: CiWatchOutcome): CiWatchRecord => ({ ...rec, terminal: true, outcome, escalation: reason, escalatedAt: this.at() });
    if (!first) return done('escalated'); // an earlier pass already told the supervisor (its row write was lost)
    let res: CiFailedEmitResult | undefined;
    try {
      res = (await this.emit(rec.chatId, rec.sha, rec.failing, {
        note: renderEscalationNote(rec, reason, this.now, o.why, { ledger: o.ledger, errors: o.errors }),
        extra: {
          ciWatch: true, ciWatchEscalation: reason, repo: this.repoOf(rec),
          ...(rec.branch ? { branch: rec.branch } : {}), ...(rec.prNumber ? { prNumber: rec.prNumber } : {}),
          ...(rec.laneWokenAt ? { laneWokenAt: rec.laneWokenAt } : {}), failing: rec.failing.slice(0, 20),
          ...(o.errors ? { verdictStale: true } : {}),
          ...(reason === 'lane_loop' && o.ledger ? { redChain: o.ledger.reds.slice(-CI_WATCH_CHAIN_SHOWN).map((x) => x.sha) } : {}),
          // ci-watch is a fresh harness observer, not a woken run — never inherit the lane's ladder rung.
          depth: 0,
        },
      })) as CiFailedEmitResult | undefined;
    } catch (err: any) {
      res = { written: 0, error: true };
      logger.warn(`${SOURCE}: ci_failed emission threw for ${rec.sha.slice(0, 12)}: ${err?.message ?? err}`, { source: SOURCE });
    }
    if (res?.error) {
      await this.store.release(key).catch(() => {});
      metric(rec.chatId, { phase: 'escalation_failed', reason, sha: rec.sha, repo: this.repoOf(rec) });
      return { ...rec, nextCheckAt: this.at(CI_WATCH_INTERVAL_SEC * 1000) };
    }
    if (typeof res?.written === 'number' && res.written <= 0) {
      this.c.noSupervisor++;
      metric(rec.chatId, { phase: 'no_supervisor', reason, sha: rec.sha, repo: this.repoOf(rec), prNumber: rec.prNumber });
      return done('no_supervisor');
    }
    this.c.escalated++;
    metric(rec.chatId, { phase: 'escalated', reason, sha: rec.sha, repo: this.repoOf(rec), failing: rec.failing.length, prNumber: rec.prNumber, written: res?.written ?? null });
    return done('escalated');
  }
}

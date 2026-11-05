/**
 * Hourly per-project digest — the fleet's "what needs my attention" rollup.
 *
 * Once an hour (the worker's `project-digest` durable cron — see worker.ts) this
 * sweep rewrites ONE project_digests row per (userId, projectId) bucket for every
 * user with activity in the trailing 1h window. projectId NULL is the UNGROUPED
 * bucket (chats with no project); uniqueness there rides the hand-written partial
 * index `project_digests_userId_ungrouped_key` (Postgres NULLs are distinct).
 *
 * Per bucket it collects DETERMINISTIC stats + ATTENTION ITEMS (blocked goals/
 * todos, failed runs, stuck queue messages, schedule errors, session errors,
 * stalled runs, decisions awaiting the user — staged pending confirmations
 * durably from Postgres, ask_user questions/permission approvals best-effort
 * from the worker's Redis pending keys), classifies a status (blocked >
 * needs_attention > on_track > idle), and writes a 2-3 sentence plain-English
 * summary via the utility LLM —
 * with a LOCAL TEMPLATE fallback (the generateTitle pattern) so an LLM outage
 * never leaves a stale/absent summary. A bucket whose inputs haven't moved
 * (same `signature`) skips the LLM call and the summary/attentionItems rewrite
 * entirely — only a cheap window-bounds touch lands so the row's updatedAt
 * keeps up with the sweep (the frontend's stale badge keys off it).
 *
 * The API side (GET /fleet/digests, fleet.service.getProjectDigests) is a
 * READ-ONLY projection of these rows — it never calls the LLM.
 *
 * Isolation: a bad user or bucket is caught + logged; the sweep continues.
 * Hidden fleet artifacts (supervisor chats, the Fleet HQ folder —
 * getSidebarHiddenFleetArtifacts) are excluded from every bucket.
 */

import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { utilityChat } from '../../../utils/utility-llm';
import { getSidebarHiddenFleetArtifacts } from './fleet.service';
import { CRON_LEASE_MS } from '../cron.service';
import { isHarnessErrorNote } from '../coding/harness-error-notes';
import { progressNoteForDisplay, progressNoteLead } from '../platform/progress-note';
import { isSupervisorOwnVoice } from './supervisor-own-voice';
// GOAL-UNPLANNED (architecture review #6, 2026-10-20): pure leaf — no config/redis.
import { goalUnplannedSignalDisabled } from '../platform/goal-unplanned';

// ── Tunables ──────────────────────────────────────────────────────────────────

/** Trailing window the digest summarizes (the cron cadence). */
export const DIGEST_WINDOW_MS = 60 * 60 * 1000; // 1h
/** A queued busy-chat message older than this is STUCK (the drain failed). */
export const STUCK_MESSAGE_MS = 30 * 60 * 1000;
/** A 'running' agent run with no heartbeat/update for this long is STALLED. */
export const STALLED_RUN_MS = 15 * 60 * 1000;
/** Bounds on pathological buckets (a runaway chat can flood messages/todos). */
const MAX_MESSAGES_SCANNED = 2_000;
export const MAX_ATTENTION_ITEMS = 20;
/** Digest-item ack silences older than this are pruned by the hourly sweep. */
export const ACK_PRUNE_AGE_MS = 30 * 864e5; // 30 days
/** Sweeper self-guard against overlapping hourly runs (deploy overlap etc.). */
export const MAX_USERS_PER_SWEEP = 500;
/**
 * Wall-clock budget for one sweep: stop CLEANLY before the worker's 10-min
 * cron lease expires — an over-lease sweep gets re-claimed by the other
 * color's worker during a deploy overlap, duplicating the whole run (double
 * LLM spend + racing digest writes). Deferred users are picked up by the next
 * hourly firing (the rotation below cycles who goes first).
 */
export const SWEEP_TIME_BUDGET_MS = CRON_LEASE_MS - 2 * 60 * 1000;
// Project-supervisor preflight 2026-09-14: a project with its own supervisor
// lane (crossmodel_chats.isProjectSupervisor) surfaces that lane's LATEST
// note in the Pulse as a "supervisor says" fact — the owner sees the project
// supervisor's own account without depending on the fleet chat relaying it
// (review 2026-09-13: owner-briefing/digest/watchdog had zero
// isProjectSupervisor references). Observe-only: the note is READ, scrubbed
// of ids, one line, and never gates anything.
/** Trailing window in which a project supervisor's note is "current". */
export const SUPERVISOR_SAYS_WINDOW_MS = 90 * 60 * 1000;
/** One line — bounded so the digest never becomes a wake-note mirror. */
export const SUPERVISOR_SAYS_MAX_CHARS = 200;
/** Newest supervisor assistant rows fetched per bucket (the first renderable wins). */
const SUPERVISOR_SAYS_FETCH = 5;
// Ticket C1 (sup3 2026-09-27, canlaw/canlegal-bench/spark-cluster audit): three
// honesty gates on the ETA class. The digest read on_pace for canlaw while its
// critical-path todo had been dep-blocked for weeks and the registered premise
// deadline was the next day, and "ETA 4.7 days" for a spark grid ending in
// hours — the class came from todo arithmetic alone.
//   (a) a deps-blocked todo whose block has aged past DEPS_BLOCK_STALE_MS joins
//       the gate (ordering that never resolves IS a stall). The age is taken
//       from the row's blockedAt stamp (review fix 2026-09-27: set on the
//       transition INTO 'blocked', cleared on the way out, untouched by a
//       reason / kind / note rewrite — updatedAt restarted on every one of
//       those, so a row lanes kept touching never aged past the gate);
//       updatedAt stays the fallback for a row with no stamp;
//   (b) a goal premise whose key ends in _by_unixts / _deadline / _due is a
//       DEADLINE — when the pace projection overshoots it (or it has passed
//       with work open) the class is behind_deadline;
//   (c) a progress note that LEADS with a HOLD / HELD / BLOCKED / ON HOLD
//       marker and does not say the hold was lifted yields 'held' — rendered
//       as a FACT about the note ("held per note"), never as an owner-set
//       status: a hold is the owner's only in the owner's own words
//       (supervisor doctrine) and the note is lane-authored.
// Observe-only (a digest class never gates a lane or a wake); fail-open (an
// unreadable or implausible premise is simply not a deadline — the decode
// never throws, see PLAUSIBLE_EPOCH_MS).
export const DEPS_BLOCK_STALE_MS = 72 * 60 * 60 * 1000;
export const DEADLINE_PREMISE_KEY_RE = /(?:_by_unixts|_deadline|_due)$/i;
/** The epoch window a deadline premise may decode into — 2001-09-09 ‥
 *  2096-10-02 as ms. Anything outside is NOT a deadline on any decode path:
 *  `new Date(1e20)` is an Invalid Date whose toISOString THROWS, and that
 *  throw used to escape computeGoalProgress and freeze the bucket's digest
 *  row on every sweep (review 2026-09-27). */
export const PLAUSIBLE_EPOCH_MS = { min: 1e12, max: 4e12 } as const;
/** Ticket C1 (c), tightened by the 2026-09-27 review: the marker must LEAD the
 *  note (at most three punctuation / bracket chars before it), so a bench
 *  verdict that merely mentions HOLD mid-sentence ("STATUS at_risk … s2v14r6
 *  HOLD (Δ+2.70 …)") is not a hold. Uppercase HOLD / HELD / BLOCKED as whole
 *  words, or "on hold" in any case. */
export const HOLD_NOTE_RE = /^\W{0,3}(?:HOLD|HELD|BLOCKED|[Oo][Nn][\s_-][Hh][Oo][Ll][Dd])\b/;
/** A note that says the hold is over is not a hold, whatever it leads with
 *  ("HOLD lifted by owner 09-26", "BLOCKED→unblocked 09-20, resumed"). */
export const HOLD_LIFTED_RE = /\b(?:lifted|unblocked|un-blocked|resumed|resuming|cleared|released|reopened|no longer)\b/i;
/** Ticket C1 (c): true only for a note that LEADS with a hold marker and does
 *  not say the hold was lifted. Pure — exported for tests and the doctrine pin. */
export const isHoldNote = (note: string | null | undefined): boolean =>
  typeof note === 'string' && HOLD_NOTE_RE.test(note.trim()) && !HOLD_LIFTED_RE.test(note);

// ── Exported shapes (the frontend consumes these verbatim via /fleet/digests) ─

export type ProjectDigestStatus = 'blocked' | 'needs_attention' | 'on_track' | 'idle';

export type DigestAttentionKind =
  | 'blocked_goal'
  | 'blocked_todo'
  | 'awaiting_input'
  | 'failed_run'
  | 'stuck_message'
  | 'schedule_error'
  | 'session_error'
  | 'stalled_session';

export interface DigestAttentionItem {
  kind: DigestAttentionKind;
  /** Human label: the goal/todo title, chat title, or schedule prompt snippet. */
  title: string;
  /** Why: blockedReason, run error, schedule lastStatus, session errorMessage… */
  detail: string | null;
  /** Drill-down ids (present iff relevant to the kind). */
  chatId?: string;
  goalId?: string;
  todoId?: string;
  runId?: string;
  scheduleId?: string;
  /**
   * ISO timestamp of the underlying signal. Display-only — EXCLUDED from the
   * digest signature (the Redis awaiting_input leg and iso(null) fallbacks
   * stamp the sweep time, which would defeat the skip-unchanged check).
   */
  at: string;
}

export interface DigestStats {
  /** Chats in the bucket (hidden fleet artifacts excluded). */
  chatCount: number;
  /** Bucket chats with ≥1 message or agent run in the window. */
  activeChats: number;
  messages: {
    total: number;
    user: number;
    assistant: number;
    /** metadata.origin counts; unmarked rows fall back to their role. */
    byOrigin: Record<string, number>;
  };
  runs: { started: number; completed: number; failed: number; active: number };
  todos: { total: number; done: number; blocked: number; dropped: number; createdInWindow: number; completedInWindow: number };
  goals: {
    total: number;
    done: number;
    blocked: number;
    createdInWindow: number;
    completedInWindow: number;
    /** Ticket 7ee38c8e: terminal goals with status 'archived' (done is counted
     *  above) — context that keeps an all-completed project from reading as
     *  goal-less in the Pulse. */
    archived: number;
    /** YYYY-MM-DD (UTC) of the newest terminal goal's updatedAt — the same
     *  completion-time proxy completedInWindow uses. Null = no terminal goals. */
    lastFinishedAt: string | null;
  };
  schedules: { firedInWindow: number; errored: number };
  /** Messages sitting in the busy-chat queue right now. */
  queuedMessages: number;
  /**
   * Project-supervisor preflight 2026-09-14: present ONLY when the bucket
   * holds the project's own supervisor lane (isProjectSupervisor). Counts
   * only (no ids, no wall clock) so the signature stays quiet on idle lanes:
   * runs = the lane's agent runs touching the window (already inside
   * `runs` — this is the attributable slice); notes = its assistant rows
   * in the window. Absent (undefined) for projects without a supervisor.
   */
  projectSupervisor?: { runsInWindow: number; notesInWindow: number };
}

// ── Goal progress + ETA (Project Pulse, owner 2026-09-04) ─────────────────────
// Deterministic facts computed in CODE from the bucket's already-loaded goals +
// todos (zero extra queries — the sweep's per-bucket cost is unchanged). The
// ETA is an honest pace projection, NEVER a model guess and NEVER a calendar
// date: "remaining / completions-per-day", expressed as "roughly N more days".

/** 'unplanned' (architecture review #6, 2026-10-20): an ACTIVE goal with zero open (non-dropped) todos —
 *  it used to read 'done' / "all tasks done" while the goal was still open. */
export type GoalEtaClass = 'on_pace' | 'no_movement' | 'blocked' | 'held' | 'behind_deadline' | 'done' | 'unplanned';

/** Ticket C1: the nearest deadline premise registered on the goal. */
export interface GoalEtaDeadline {
  /** The premise key as registered (e.g. sft2_start_by_unixts). */
  key: string;
  /** ISO instant of the deadline — FIXED by the premise, never wall-clock derived. */
  at: string;
  /** Days until the deadline at sweep time (negative = passed). Rounded to
   *  whole days beyond ±2d and one decimal inside, so the signature moves at
   *  most once a day far out and every ~2.4h only in the final 48h. */
  daysLeft: number;
}

export interface GoalEta {
  /** Todos still open (total - done). */
  remaining: number;
  /** Completions per day over the trailing 7d (24h fallback — see computeGoalEta). */
  pacePerDay: number;
  /** remaining / pacePerDay (1 decimal); null when pace is 0 or nothing remains. */
  etaDays: number | null;
  class: GoalEtaClass;
  /** Ticket C1: present only when a deadline premise is registered (nearest wins). */
  deadline?: GoalEtaDeadline;
}

export interface DigestGoalProgress {
  goalId: string;
  title: string;
  /** The goal row's own status ('active' | 'blocked' — only those are tracked). */
  status: string;
  todosDone: number;
  /** DROPPED todos are excluded (P7 N5) — cancelled work leaves the bar. */
  todosTotal: number;
  /** Blocked todos under this goal (ALL blocked rows — see depsBlockedCount). */
  blockedCount: number;
  /** The blockKind='deps' subset (P7 v1#20 split): deps-blocked rows describe
   *  ORDERING, not a stall — they do NOT gate the ETA class; only the
   *  remainder (gate-blocked: owner/agent/external/untyped) does. */
  depsBlockedCount: number;
  /** Dropped todos under this goal (excluded from every other count). */
  droppedCount: number;
  /** Todos completed in the trailing 24h / 7d. PROXY: project_todos has no
   *  status-change timestamp, so `updatedAt` of done rows stands in for the
   *  completion time (a later edit to a done todo re-counts it — pragmatic). */
  completed24h: number;
  completed7d: number;
  /** Progress-aware pulse (P7 v1#20): the goal's own progressNote, else the
   *  newest todo progressNote under it (by updatedAt). Null = none recorded. */
  progressNote: string | null;
  /** Ticket C1 (a): the deps-blocked subset whose block has aged past
   *  DEPS_BLOCK_STALE_MS — aged from the row's blockedAt stamp (set on the
   *  transition into 'blocked'; a reason / kind / note rewrite never touches
   *  it), updatedAt only for a row with no stamp. These rows DO gate. */
  staleDepsBlockedCount?: number;
  /** Ticket C1 (c): the goal's OWN progress note, else the freshest OPEN todo's
   *  note (never a done / dropped row's), LEADS with a hold marker and does
   *  not say it was lifted (isHoldNote). A fact about the note — not an
   *  owner-set status. */
  held?: boolean;
  eta: GoalEta;
}

export interface DigestEtaSummary {
  /** Active + blocked goals tracked (done/archived goals are history). */
  goalsTracked: number;
  goalsBlocked: number;
  todosDone: number;
  todosTotal: number;
  todosRemaining: number;
  /** Blocked todos across the tracked goals. */
  blockedCount: number;
  pacePerDay: number;
  etaDays: number | null;
  class: GoalEtaClass;
  /** Ticket C1: the deadline the rollup class was judged against (the nearest
   *  across tracked goals, or the nearest among the goals that are behind). */
  deadline?: GoalEtaDeadline;
  /** GOAL-UNPLANNED (2026-10-20): tracked goals in class 'unplanned' — present
   *  only when > 0, so every other project's stored signature is unchanged. */
  unplannedGoals?: number;
}

/** Bound on stored per-goal facts (a pathological project can hold hundreds of
 *  goals; blocked goals sort first so the cap never hides a gate). */
export const MAX_GOAL_PROGRESS_ITEMS = 12;

const COMPLETION_24H_MS = 24 * 60 * 60 * 1000;
const COMPLETION_7D_MS = 7 * 24 * 60 * 60 * 1000;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The ETA math (pure — pinned directly by tests):
 *   pace    = completed7d / 7; when the 7d window is empty, fall back to the
 *             trailing-24h count taken AS the daily rate (with the updatedAt
 *             proxy 7d ⊇ 24h so the fallback is defensive — it matters only if
 *             the two counts are ever sourced differently);
 *   etaDays = remaining / pace, when pace > 0 and something remains.
 * Class precedence: done > blocked > held > behind_deadline > on_pace >
 * no_movement. `blockedGate` is "any gate-blocked todo, a stale deps-blocked
 * todo, or the goal itself is blocked" — a gate outranks a finite pace because
 * the pace cannot be trusted through a gate; etaDays is still computed so the
 * UI can show both facts honestly. Ticket C1: `heldGate` (a HOLD note) sits
 * under blocked; `deadline` makes the class behind_deadline when the
 * projection overshoots the days left, or when the deadline has passed with
 * work still open and no pace to project from. GOAL-UNPLANNED (2026-10-20):
 * `unplannedEligible` (the goal row is ACTIVE) turns "nothing remains" into
 * 'unplanned' instead of 'done' — an open goal with no open todos needs a
 * plan, it is not finished (a gate / hold on it still wins).
 */
export function computeGoalEta(input: {
  remaining: number;
  blockedGate: boolean;
  completed24h: number;
  completed7d: number;
  /** Ticket C1 (c): a HOLD/HELD/BLOCKED progress note. */
  heldGate?: boolean;
  /** Ticket C1 (b): the nearest deadline premise, or null/undefined when none is registered. */
  deadline?: GoalEtaDeadline | null;
  /** GOAL-UNPLANNED: the goal row itself is still ACTIVE (unset — the rollup, legacy callers — keeps 'done'). */
  unplannedEligible?: boolean;
}): GoalEta {
  const { remaining, blockedGate, completed24h, completed7d, heldGate = false, deadline = null, unplannedEligible = false } = input;
  const pacePerDay = round2(completed7d > 0 ? completed7d / 7 : completed24h);
  const etaDays = remaining > 0 && pacePerDay > 0 ? round1(remaining / pacePerDay) : null;
  const behind = !!deadline && remaining > 0 && (etaDays !== null ? etaDays > deadline.daysLeft : deadline.daysLeft <= 0);
  const cls: GoalEtaClass =
    remaining <= 0 ? (unplannedEligible ? (blockedGate ? 'blocked' : heldGate ? 'held' : 'unplanned') : 'done')
      : blockedGate ? 'blocked'
        : heldGate ? 'held'
          : behind ? 'behind_deadline'
            : pacePerDay > 0 ? 'on_pace' : 'no_movement';
  return { remaining: Math.max(0, remaining), pacePerDay, etaDays, class: cls, ...(deadline ? { deadline } : {}) };
}

// ── Ticket C1 (b): deadline premises ─────────────────────────────────────────
// A tolerant reader mirroring platform/premise-register.ts readPremises —
// inlined because that module statically imports config/redis, which this
// sweep must not load (same rule as the supervisorSaysLine scrub above).

/** Inside the PLAUSIBLE_EPOCH_MS window AND representable as a Date (belt and
 *  braces — the window already excludes every value `new Date` rejects). */
export function isPlausibleEpochMs(ms: number | null | undefined): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms)
    && ms >= PLAUSIBLE_EPOCH_MS.min && ms < PLAUSIBLE_EPOCH_MS.max
    && Number.isFinite(new Date(ms).getTime());
}

/** Epoch ms encoded by a deadline premise, or null when its value cannot be
 *  read as an instant. Unit-driven first (ms / s / d / h), then the key's
 *  `_unixts` suffix, then a plausible-epoch heuristic for unitless values.
 *  EVERY path must land inside PLAUSIBLE_EPOCH_MS (2001‥2096) or the answer
 *  is null (review 2026-09-27): a `_by_unixts` key holding milliseconds
 *  (×1000 ⇒ year 58711), a 1e20 value, a 1e16 "seconds" value — none is a
 *  deadline, and none can become an Invalid Date. Pure — exported for tests. */
export function premiseDeadlineMs(p: { key: string; value: number; unit?: string | null; setAt?: string | null }): number | null {
  const v = Number(p.value);
  if (!Number.isFinite(v)) return null;
  const unit = String(p.unit ?? '').trim().toLowerCase();
  let ms: number | null = null;
  if (unit === 'ms' || unit === 'unix_ms' || unit === 'epoch_ms') {
    ms = v;
  } else if (/_unixts$/i.test(p.key) || ['s', 'sec', 'secs', 'seconds', 'unixts', 'unix', 'unix_s', 'epoch', 'epoch_s', 'ts'].includes(unit)) {
    ms = v * 1000;
  } else if (['d', 'day', 'days', 'h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) {
    const base = p.setAt ? Date.parse(p.setAt) : NaN;
    if (!Number.isFinite(base)) return null; // a relative deadline needs its anchor
    ms = base + v * (unit.startsWith('d') ? 864e5 : 36e5);
  } else if (!unit) {
    if (v >= PLAUSIBLE_EPOCH_MS.min && v < PLAUSIBLE_EPOCH_MS.max) ms = v;                             // ms epoch
    else if (v >= PLAUSIBLE_EPOCH_MS.min / 1000 && v < PLAUSIBLE_EPOCH_MS.max / 1000) ms = v * 1000;  // s epoch
  }
  return isPlausibleEpochMs(ms) ? ms : null;
}

/** Days-left rounding that bounds signature churn: whole days beyond ±2d,
 *  one decimal inside (the final 48h is where hours matter). Never -0. */
export function roundDaysLeft(precise: number): number {
  const n = Math.abs(precise) < 2 ? round1(precise) : Math.round(precise);
  return n === 0 ? 0 : n;
}

/** The NEAREST deadline premise on a goal's `premises` JSON (tolerant of
 *  legacy/garbage rows). Null = none registered or none readable. Pure, and
 *  NEVER throws (review 2026-09-27): a premise the decoder cannot read is
 *  simply not a deadline — the old `new Date(1e20).toISOString()` RangeError
 *  escaped computeGoalProgress and froze the project's digest row. */
export function goalDeadline(premises: unknown, now: Date): GoalEtaDeadline | null {
  if (!Array.isArray(premises)) return null;
  let best: { key: string; ms: number } | null = null;
  for (const raw of premises as unknown[]) {
    try {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as { key?: unknown; value?: unknown; unit?: unknown; setAt?: unknown };
      if (typeof p.key !== 'string' || !DEADLINE_PREMISE_KEY_RE.test(p.key)) continue;
      const ms = premiseDeadlineMs({
        key: p.key,
        value: Number(p.value),
        unit: typeof p.unit === 'string' ? p.unit : null,
        setAt: typeof p.setAt === 'string' ? p.setAt : null,
      });
      if (!isPlausibleEpochMs(ms)) continue;
      if (!best || ms < best.ms) best = { key: p.key, ms };
    } catch {
      /* an unreadable premise is not a deadline — never a thrown bucket */
    }
  }
  if (!best) return null;
  try {
    return { key: best.key, at: new Date(best.ms).toISOString(), daysLeft: roundDaysLeft((best.ms - now.getTime()) / 864e5) };
  } catch {
    return null;
  }
}

/** Rows as digestBucket selects them (blockKind/progressNote additive — P7;
 *  premises additive — ticket C1; blockedAt additive — review fix 2026-09-27). */
interface GoalRow { id: string; title: string; status: string; blockKind?: string | null; progressNote?: string | null; premises?: unknown; blockedAt?: Date | string | null }
interface TodoRow { goalId: string | null; status: string; updatedAt: Date; blockKind?: string | null; progressNote?: string | null; blockedAt?: Date | string | null }

/** Epoch ms of a blockedAt stamp, or NaN when absent / unreadable. */
function blockedAtMs(v: Date | string | null | undefined): number {
  if (!v) return NaN;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : NaN;
}

/** When a blocked todo's block BEGAN: its blockedAt stamp (the transition into
 *  'blocked' — goals.service stamps it and clears it; reason / kind / gate /
 *  note rewrites never touch it), else updatedAt for a row blocked before the
 *  stamp existed. Pure — exported for tests. */
export function blockStartMs(row: { blockedAt?: Date | string | null; updatedAt: Date }): number {
  const t = blockedAtMs(row.blockedAt);
  if (Number.isFinite(t)) return t;
  return row.updatedAt.getTime();
}

/**
 * Per-goal deterministic progress facts for the bucket's ACTIVE + BLOCKED
 * goals. Pure derivation over rows the bucket already loaded (one goals query
 * + one todos query per bucket — both pre-existing; no N+1). Deterministic
 * ORDER (blocked-status goals first, then title, then id) because the array
 * feeds the digest signature — findMany return order must not perturb it.
 * NO wall-clock values enter the shape: completed24h/7d are counts, so the
 * signature only moves when a completion lands or ages across a window edge
 * (at most two one-time regens per completed todo — intended: the pace fact
 * genuinely changed).
 */
export function computeGoalProgress(goals: GoalRow[], todos: TodoRow[], now: Date): DigestGoalProgress[] {
  const tracked = goals.filter((g) => g.status === 'active' || g.status === 'blocked');
  const staleCutoff = now.getTime() - DEPS_BLOCK_STALE_MS;
  const byGoal = new Map<string, TodoRow[]>();
  for (const t of todos) {
    if (!t.goalId) continue;
    const list = byGoal.get(t.goalId) ?? [];
    list.push(t);
    byGoal.set(t.goalId, list);
  }
  const cutoff24h = now.getTime() - COMPLETION_24H_MS;
  const cutoff7d = now.getTime() - COMPLETION_7D_MS;
  return tracked
    .map((g) => {
      const allRows = byGoal.get(g.id) ?? [];
      // P7 N5: DROPPED todos leave every pace/ETA count — cancelled work must
      // not hold the bar open (they stay visible via droppedCount).
      const droppedCount = allRows.filter((t) => t.status === 'dropped').length;
      const rows = allRows.filter((t) => t.status !== 'dropped');
      const done = rows.filter((t) => t.status === 'done');
      const blockedRows = rows.filter((t) => t.status === 'blocked');
      const blockedCount = blockedRows.length;
      // P7 v1#20 split: deps-blocked rows describe ordering (their turn comes
      // when the dependency lands) — only GATE-blocked rows (owner/agent/
      // external/untyped) gate the ETA class.
      const depsRows = blockedRows.filter((t) => t.blockKind === 'deps');
      const depsBlockedCount = depsRows.length;
      const gateBlockedCount = blockedCount - depsBlockedCount;
      // Ticket C1 (a): ordering that has not resolved in 72h is a stall — aged
      // from the row's blockedAt stamp (review fix 2026-09-27; a reason / note
      // rewrite no longer restarts the clock), updatedAt only for a row with
      // no stamp.
      const staleDepsBlockedCount = depsRows.filter((t) => blockStartMs(t) <= staleCutoff).length;
      // The goal's OWN deps-typed block ages the same way — but ONLY from its
      // blockedAt stamp: goal.updatedAt is re-stamped hourly by the premise
      // re-check, so it can never stand in for a block start.
      const goalBlockedAt = blockedAtMs(g.blockedAt);
      const goalDepsBlockStale = g.status === 'blocked' && g.blockKind === 'deps'
        && Number.isFinite(goalBlockedAt) && goalBlockedAt <= staleCutoff;
      // Completion-time proxy: updatedAt of done rows (no status-change stamps exist).
      const completed24h = done.filter((t) => t.updatedAt.getTime() >= cutoff24h).length;
      const completed7d = done.filter((t) => t.updatedAt.getTime() >= cutoff7d).length;
      // Newest progress note (goal's own wins; else the freshest todo note) —
      // the P7 pulse quote, unchanged.
      const noteRows = rows.filter((t) => typeof t.progressNote === 'string' && t.progressNote.trim());
      noteRows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      // Ticket a8d6e514: the stored note may be a 2,000-char continuation
      // ledger — the Pulse (and the signature hash) carry the bounded display
      // form; a note within 200 chars is byte-identical.
      const progressNote = progressNoteForDisplay((typeof g.progressNote === 'string' && g.progressNote.trim())
        ? g.progressNote.trim()
        : (noteRows[0]?.progressNote?.trim() ?? null));
      // Ticket C1 (c), review-tightened 2026-09-27: `held` reads the goal's OWN
      // note, else the freshest OPEN todo's note — never a done row's
      // (finishing a todo bumps updatedAt, so a done row's "was BLOCKED on
      // quota; shipped" was the freshest note and flipped a paced goal to held).
      const openNoteRows = noteRows.filter((t) => t.status !== 'done');
      const heldNote = (typeof g.progressNote === 'string' && g.progressNote.trim())
        ? g.progressNote.trim()
        : (openNoteRows[0]?.progressNote?.trim() ?? null);
      // a8d6e514: the HOLD marker + its 'lifted' escape are read from the LEAD only.
      const held = heldNote != null && isHoldNote(progressNoteLead(heldNote));
      // Ticket C1 (b): the nearest registered deadline premise — fail-open
      // null, and NEVER a throw out of the sweep (review 2026-09-27).
      let deadline: GoalEtaDeadline | null = null;
      try { deadline = goalDeadline(g.premises, now); } catch { deadline = null; }
      return {
        goalId: g.id,
        title: g.title,
        status: g.status,
        todosDone: done.length,
        todosTotal: rows.length,
        blockedCount,
        depsBlockedCount,
        droppedCount,
        completed24h,
        completed7d,
        progressNote,
        staleDepsBlockedCount,
        held,
        eta: computeGoalEta({
          remaining: rows.length - done.length,
          // The goal's OWN block gates unless it is itself deps-typed — and a
          // deps-typed one gates once its blockedAt stamp is stale; a STALE
          // deps-blocked todo (ticket C1 a) gates like any other gate.
          blockedGate: (g.status === 'blocked' && g.blockKind !== 'deps') || goalDepsBlockStale || gateBlockedCount > 0 || staleDepsBlockedCount > 0,
          completed24h,
          completed7d,
          heldGate: held,
          deadline,
          // GOAL-UNPLANNED (2026-10-20): an ACTIVE goal with nothing open is 'unplanned', never 'done'.
          unplannedEligible: g.status === 'active' && !goalUnplannedSignalDisabled(),
        }),
      };
    })
    .sort(
      (a, b) =>
        Number(b.status === 'blocked') - Number(a.status === 'blocked') ||
        a.title.localeCompare(b.title) ||
        a.goalId.localeCompare(b.goalId),
    )
    .slice(0, MAX_GOAL_PROGRESS_ITEMS);
}

/**
 * Project-level rollup. Null when no active/blocked goals exist (incl. the
 * UNGROUPED bucket — goals are project-scoped).
 * Rollup class: 'blocked' only when EVERY unfinished goal is gated — a single
 * blocked goal must not paint a project that is actively completing work as
 * blocked (the 547df1ff / 821d944d "blocked but grinding away" cry-wolf class;
 * the per-goal rows still carry their own 'blocked' class and blockedCount, so
 * nothing is hidden). Otherwise: done > on_pace > no_movement on the aggregate.
 */
export function computeEtaSummary(goalProgress: DigestGoalProgress[]): DigestEtaSummary | null {
  if (goalProgress.length === 0) return null;
  const todosDone = goalProgress.reduce((n, g) => n + g.todosDone, 0);
  const todosTotal = goalProgress.reduce((n, g) => n + g.todosTotal, 0);
  const remaining = todosTotal - todosDone;
  const completed24h = goalProgress.reduce((n, g) => n + g.completed24h, 0);
  const completed7d = goalProgress.reduce((n, g) => n + g.completed7d, 0);
  const blockedCount = goalProgress.reduce((n, g) => n + g.blockedCount, 0);
  const unfinished = goalProgress.filter((g) => g.eta.class !== 'done');
  const allGated = unfinished.length > 0 && unfinished.every((g) => g.eta.class === 'blocked');
  // Ticket C1: every unfinished goal blocked-or-held (with ≥1 held) ⇒ the
  // rollup is held. Any goal behind ITS OWN deadline ⇒ the rollup is behind,
  // naming that deadline: work is not fungible across goals, so a fast
  // sibling must never hide a late one — and, for the SAME reason, the
  // rollup's own projection is judged against NO deadline (review
  // 2026-09-27: summed remaining / summed pace compared with ONE goal's
  // deadline called a project late when no goal was — A: 2 open at 1/day,
  // due in 3 d, on pace; B: 50 open at 1/day, no deadline ⇒ the rollup read
  // behind_deadline "26 more days"). The rollup is behind_deadline iff some
  // goal is; the nearest deadline across tracked goals rides `deadline` as
  // an informational fact.
  const allHeld = !allGated && unfinished.length > 0 && unfinished.every((g) => g.eta.class === 'blocked' || g.eta.class === 'held');
  const behindGoals = unfinished.filter((g) => g.eta.class === 'behind_deadline');
  const nearestOf = (rows: DigestGoalProgress[]): GoalEtaDeadline | null =>
    rows.reduce<GoalEtaDeadline | null>((best, g) => {
      const d = g.eta.deadline;
      if (!d) return best;
      return !best || Date.parse(d.at) < Date.parse(best.at) ? d : best;
    }, null);
  const nearest = nearestOf(goalProgress);
  const base = computeGoalEta({ remaining, blockedGate: allGated, heldGate: allHeld, completed24h, completed7d });
  // GOAL-UNPLANNED (2026-10-20): an unplanned goal is unfinished work with no
  // movement to project — the rollup treats it like no_movement, so a project
  // whose open goals have nothing open never reads "all tasks done".
  const unplannedGoals = unfinished.filter((g) => g.eta.class === 'unplanned').length;
  const baseClass: GoalEtaClass = base.class === 'done' && unplannedGoals > 0 ? 'no_movement' : base.class;
  const behindByGoal = (baseClass === 'on_pace' || baseClass === 'no_movement') && behindGoals.length > 0;
  const deadline = behindByGoal ? nearestOf(behindGoals) ?? nearest : nearest;
  return {
    goalsTracked: goalProgress.length,
    goalsBlocked: goalProgress.filter((g) => g.status === 'blocked').length,
    todosDone,
    todosTotal,
    todosRemaining: base.remaining,
    blockedCount,
    pacePerDay: base.pacePerDay,
    etaDays: base.etaDays,
    class: behindByGoal ? 'behind_deadline' : baseClass,
    ...(deadline ? { deadline } : {}),
    ...(unplannedGoals > 0 ? { unplannedGoals } : {}),
  };
}

/** The rollup's phrase input — ONE builder so the template, the prompt and
 *  the tests can never disagree on which facts the phrase sees. */
export function etaSummaryPhrase(s: DigestEtaSummary): string {
  // The rollup phrase names a deadline ONLY when a goal is behind it (class
  // behind_deadline): project-wide numbers beside ONE goal's deadline read as
  // late when no goal is (review 2026-09-27). The per-goal lines carry every
  // registered deadline.
  const deadline = s.class === 'behind_deadline' && s.deadline ? { deadline: s.deadline } : {};
  // GOAL-UNPLANNED: nothing open anywhere, but unplanned goals ⇒ say so, never "no movement".
  const unplanned = s.unplannedGoals ?? 0;
  if (unplanned > 0 && s.todosRemaining <= 0 && s.class === 'no_movement') {
    return unplanned === 1 ? 'no open tasks — needs a plan' : `no open tasks — ${unplanned} goals need a plan`;
  }
  return goalEtaPhrase({
    blockedCount: s.blockedCount,
    eta: { remaining: s.todosRemaining, pacePerDay: s.pacePerDay, etaDays: s.etaDays, class: s.class, ...deadline },
  });
}

/**
 * The honest ETA phrase for one goal/rollup — STRICTLY from the computed facts
 * (shared by the LLM prompt, which must use it verbatim, and the local
 * template fallback). Never a calendar date.
 */
export function goalEtaPhrase(row: { blockedCount: number; eta: GoalEta; depsBlockedCount?: number; staleDepsBlockedCount?: number }): string {
  const { eta, blockedCount } = row;
  // Ticket C1: the deadline fact rides every phrase when one is registered
  // (empty string otherwise — the pre-C1 phrases stay byte-identical).
  const dl = eta.deadline ? ` (${deadlineName(eta.deadline.key)} deadline ${deadlineDuePhrase(eta.deadline.daysLeft)})` : '';
  switch (eta.class) {
    case 'done':
      return 'all tasks done';
    case 'unplanned':
      // GOAL-UNPLANNED (2026-10-20): the goal is open with nothing open under it.
      return `no open tasks — needs a plan${dl}`;
    case 'blocked': {
      const stale = row.staleDepsBlockedCount ?? 0;
      const gate = blockedCount - (row.depsBlockedCount ?? 0);
      // Ticket C1 (a): when the ONLY gating rows are stale deps, say so — "one
      // blocked task" would hide that the block is ordering that never resolved.
      if (stale > 0 && gate <= 0) {
        return (stale === 1
          ? 'one dependency-blocked task has waited over 3 days, gating progress'
          : `${stale} dependency-blocked tasks have waited over 3 days, gating progress`) + dl;
      }
      return (blockedCount === 1
        ? 'one blocked task is gating progress'
        : blockedCount > 1
          ? `${blockedCount} blocked tasks are gating progress`
          : 'the goal is blocked, gating progress') + dl;
    }
    case 'held':
      // A fact about the note, never an owner-set status (review 2026-09-27).
      return `the latest open progress note leads with a hold marker, so no estimate${dl}`;
    case 'behind_deadline': {
      const d = eta.deadline;
      if (!d) return 'behind its deadline'; // unreachable by construction (the class needs a deadline) — a phrase never throws
      const name = deadlineName(d.key);
      if (d.daysLeft < 0) {
        return `the ${name} deadline ${deadlineDuePhrase(d.daysLeft)} with ${eta.remaining} task${eta.remaining === 1 ? '' : 's'} still open`;
      }
      const days = Math.max(1, Math.round(eta.etaDays ?? 1));
      return `behind the ${name} deadline (${deadlineDuePhrase(d.daysLeft)}) — at the current pace roughly ${days === 1 ? 'a day' : `${days} more days`} of work remains`;
    }
    case 'on_pace': {
      const days = Math.max(1, Math.round(eta.etaDays ?? 1));
      return (days === 1
        ? 'at the current pace roughly a day to go'
        : `at the current pace roughly ${days} more days`) + dl;
    }
    case 'no_movement':
    default:
      return `no movement in the last week, so no reliable estimate${dl}`;
  }
}

/** "sft2_start_by_unixts" → "sft2 start" (the suffix is the type, not the name). */
export function deadlineName(key: string): string {
  const name = key.replace(DEADLINE_PREMISE_KEY_RE, '').replace(/[_\s]+/g, ' ').trim();
  return name || key;
}

/** Relative, never a calendar date: "due within a day" / "due in a day" /
 *  "due in N days" / "passed a day ago" / "passed N days ago". */
export function deadlineDuePhrase(daysLeft: number): string {
  if (daysLeft < 0) {
    const n = Math.max(1, Math.round(-daysLeft));
    return n === 1 ? 'passed a day ago' : `passed ${n} days ago`;
  }
  if (daysLeft < 1) return 'due within a day';
  const n = Math.round(daysLeft);
  return n === 1 ? 'due in a day' : `due in ${n} days`;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

/**
 * The honest "what finished" fact for a project with no ACTIVE goals left
 * (ticket 7ee38c8e: an all-completed project must never read as goal-less).
 * Shared by the local template fallback and the LLM prompt's overall fact so
 * the two surfaces can never disagree. STRICTLY deterministic: counts + a
 * YYYY-MM-DD date derived from terminal goals' updatedAt (the same proxy
 * completedInWindow uses) — no wall clock, no fabricated estimates. Empty
 * string when the project truly has no goals.
 */
export function completedGoalsPhrase(goals: DigestStats['goals']): string {
  // Defensive: older callers/fixtures may not carry `archived` yet (merged
  // 2026-09-13 with the review-16 neutral no-goal sentence) — never NaN.
  const terminal = (Number(goals?.done) || 0) + (Number(goals?.archived) || 0);
  if (terminal <= 0) return '';
  const when = goals.lastFinishedAt ? `, last finished ${goals.lastFinishedAt}` : '';
  return `${terminal} goal(s) already completed${when}`;
}

// ── Project-supervisor preflight 2026-09-14: "supervisor says" line ──────────

// isSupervisorOwnVoice — is this assistant row the supervisor LANE speaking, or a harness notice? Moved verbatim
// to fleet/supervisor-own-voice.ts (2026-10-21) so the struck-note repeat check shares the one predicate.

/**
 * ONE plain-English line from a project supervisor's note — the first
 * substantive line after scrubbing machine artifacts (mirrors
 * owner-briefing.service scrubMachineArtifacts; inlined because that module
 * statically imports config/redis, which this sweep must not load). Skips
 * table rows/separators, headers-only lines and anything shorter than a
 * clause; bounded to SUPERVISOR_SAYS_MAX_CHARS. Null when nothing renderable
 * survives (the fact is then simply omitted — never a fabricated summary).
 * Pure — exported for tests.
 */
export function supervisorSaysLine(content: unknown): string | null {
  const text = typeof content === 'string' ? content : String(content ?? '');
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (/^\|/.test(line)) continue;                       // table rows / separators
    if (/^(?:-{3,}|={3,}|\*{3,})$/.test(line)) continue;  // rules
    line = line
      .replace(/^(?:#{1,6}\s+|[-*•]\s+|\d+\.\s+)/, '')                                   // header / bullet chrome
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')                                            // [label](url) → label
      .replace(/\(\s*(?:msg|message|sched(?:ule)?|ticket|pr|run|chat|receipt|commit|sha|id|session)?\s*#?[0-9a-f]{8,}[^)]*\)/gi, '')
      .replace(/\b(?:msg|message|sched(?:ule)?|ticket|pr|run|chat|receipt|commit|sha|id|session)\s+#?[0-9a-f]{8,}\b/gi, '')
      .replace(/\b[0-9a-f]{8,}\b/g, (m) => (/\d/.test(m) ? '' : m))                        // bare digit-bearing hex ids
      .replace(/\b(?:at|around|by|since|until)\s+\d{1,2}:\d{2}(?::\d{2})?Z\b/gi, '')
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?Z\b/g, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/[✅⚠️❌🔔🚨]/g, '')
      .replace(/\s+([,.;:])/g, '$1')
      .replace(/\(\s*\)/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s—–→:,-]+|[\s—–→:,-]+$/g, '')
      .trim();
    if (line.length < 12) continue;                       // a bare label ("WAKE", "Status") is not a fact
    if (line.length > SUPERVISOR_SAYS_MAX_CHARS) line = `${line.slice(0, SUPERVISOR_SAYS_MAX_CHARS - 1).trimEnd()}…`;
    return line;
  }
  return null;
}

/** metadata.origin of a message row (defensive — metadata is arbitrary Json). */
function rowOrigin(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const o = (metadata as Record<string, unknown>).origin;
  return typeof o === 'string' && o ? o : null;
}

function iso(d: Date | null | undefined): string {
  return (d instanceof Date ? d : new Date()).toISOString();
}

/** Schedule lastStatus values that mean "this schedule needs the owner".
 *  'cancelled' is NOT an error — cancelling is a deliberate act (owner or
 *  supervisor via cancel_schedule); flagging it cried wolf on 9+ parked
 *  schedules (ticket 821d944d). */
function isScheduleError(lastStatus: string | null | undefined): boolean {
  return !!lastStatus && /^(error|failed)/i.test(lastStatus);
}

/**
 * A blocked goal/todo is an ATTENTION item only when it is actionable —
 * someone must decide or do something. Two classes are state, not signal
 * (owner 2026-08-29, ticket 821d944d: "these projects need attention even
 * though they are clearly chopping away towards their goals", led item a
 * dep-wait):
 *  1. '[deps] …' — blocked BY THE dependency system; auto-unblocks when its
 *     dependencies finish. No action exists; the attention-watchdog already
 *     collapses these to a tag (attention-watchdog.service.ts).
 *  2. Deliberately parked — the owner already decided: pause/drop/retire
 *     directives kept "retained for history". The decision HAPPENED; nothing
 *     is being asked. Phrases match the fleet's actual parking vocabulary
 *     (verified against live tt-rd / spark-cluster / CQL reasons).
 * Both classes still count in stats.todos/goals.blocked (the counts stay
 * honest); they just stop driving status and the items list.
 * Vocabulary discipline (adversarial review B1): only UNAMBIGUOUS parking
 * markers qualify — 'owner decision' and bare 'dropped' are excluded
 * because they match actionable reasons ("Needs owner decision on…",
 * "connection dropped mid-run"); live parked rows all co-carry
 * 'owner directive'/'owner pause', which is what anchors them here.
 */
const PARKED_BLOCK_RE = /\b(owner[\s-]*(directive|pause)|retained for history|will never execute|permanent(ly)? paused)\b/i;

// Owner-wait CLAIM detection (remediation P2 N10): canonical regexes live in
// platform/owner-questions.ts (a leaf module the watchdog shares) — re-exported
// here for this module's tests. A blocked reason asserting the owner is being
// waited on renders in the digest ONLY when an OPEN owner_questions (oq_) row
// backs it; a prose owner-wait nobody can answer is dropped (+ one
// `owner_wait_line_dropped` metric).
export { OWNER_WAIT_CLAIM_RE, INLINE_OQ_ID_RE } from '../platform/owner-questions';
import { OWNER_WAIT_CLAIM_RE, INLINE_OQ_ID_RE, isCounterQuestionRow } from '../platform/owner-questions';
// '[deps]' == DEPS_BLOCK_PREFIX in platform/goals.service.ts — inlined here:
// importing goals.service pulls the env-validation chain into the test env.
// Case-insensitive to match the attention-watchdog's /^\[deps\]/i.
const DEPS_REASON_RE = /^\[deps\]/i;
/** CanLaw 2026-09-15: the owner-facing detail of a blocked row whose reason
 *  claims an owner decision no owner question backs. Exported for the status
 *  logic and the pins — the string is the contract. */
export const TEAM_PAUSE_DETAIL = "Paused by the team's own rule — no owner decision is pending; the lane has been told.";
/** …and of a row whose cited card the owner already answered with a decision. */
export const STALE_GATE_DETAIL_PREFIX = 'You already answered the question this cites';
export function isTeamPauseItem(item: { kind: string; detail: string | null }): boolean {
  return (item.kind === 'blocked_goal' || item.kind === 'blocked_todo') && item.detail === TEAM_PAUSE_DETAIL;
}

function isActionableBlock(blockedReason: string | null | undefined): boolean {
  if (!blockedReason) return true; // unexplained manual block — surface it
  if (DEPS_REASON_RE.test(blockedReason)) return false;
  return !PARKED_BLOCK_RE.test(blockedReason);
}

/** A recently-STOPPED recurring cadence (overnight forensics 2026-08-24, fix
 *  3a): a recurring row with real history (runsCount >= 3) that was disabled
 *  within the last 24h needs the owner REGARDLESS of lastStatus — the run-cap
 *  disable leaves lastStatus 'started' and lifetime expiry leaves 'expired',
 *  neither of which the error regex sees, so a stopped project read as merely
 *  "idle". Recency = disabledAt (stamped by every stop path since P3, v1#13)
 *  falling back to lastFiredAt for rows disabled before the column existed. */
export const STOPPED_CADENCE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Trailing window in which ANY agent run counts as lane life (SA0906
 *  successor-awareness). MUST equal stopped-schedule-alert.ts's
 *  LANE_ACTIVITY_WINDOW_MS (pinned by a test) — inlined here because that
 *  module is only ever loaded via the dynamic filing seam below. */
export const STOPPED_LANE_ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000;
function isStoppedCadence(
  s: { enabled?: boolean; kind?: string; runsCount?: number; lastFiredAt: Date | null; disabledAt?: Date | null },
  now: Date,
): boolean {
  // v1#13: disabledAt (stamped by every stop path since P3) is the primary
  // recency signal — a machine cancel of a lane that had not FIRED recently
  // used to fall outside the lastFiredAt window and never reach the backstop.
  const stopAt = s.disabledAt ?? s.lastFiredAt;
  return s.enabled === false && s.kind === 'recurring' && (s.runsCount ?? 0) >= 3
    && !!stopAt && now.getTime() - stopAt.getTime() <= STOPPED_CADENCE_WINDOW_MS;
}

/**
 * Deterministic digest signature — EXCLUDES the window bounds on purpose, and
 * EXCLUDES the attention items' `at` stamps: two item paths carry wall-clock
 * times (the Redis awaiting_input leg stamps the sweep time; iso(null) on a
 * never-fired errored schedule falls back to now), which made the signature
 * differ every sweep for identical underlying state — hourly LLM regen the
 * skip exists to prevent.
 */
export function computeDigestSignature(input: {
  status: ProjectDigestStatus;
  stats: DigestStats;
  attentionItems: DigestAttentionItem[];
  /** Project Pulse: goal progress + ETA feed the signature so a progress change
   *  (a todo completed, a gate appearing, a pace shift) regenerates the summary.
   *  The shapes hold NO wall-clock values (counts + a count-derived etaDays), so
   *  quiet buckets keep skipping. NOTE: adding these keys changes every stored
   *  signature ONCE after deploy — one full-fleet regeneration on the first
   *  sweep is accepted (same class as any signature-input change). */
  goalProgress?: DigestGoalProgress[];
  etaSummary?: DigestEtaSummary | null;
  /** Program-truth reader (P7 G16): a current-state doc change regenerates the
   *  digest (the doc is bounded 4k, so hashing it is cheap). */
  programState?: string | null;
  /** Project-supervisor preflight 2026-09-14: the scrubbed "supervisor says"
   *  line. Keyed into the hash ONLY when present, so every project WITHOUT a
   *  supervisor lane keeps its stored signature byte-identical (no fleet-wide
   *  regen on deploy); a new note → one regen, the note ageing out → one more. */
  supervisorSays?: string | null;
}): string {
  const attentionItems = input.attentionItems.map(({ at: _at, ...rest }) => rest);
  return crypto
    .createHash('sha1')
    .update(
      JSON.stringify({
        status: input.status,
        stats: input.stats,
        attentionItems,
        goalProgress: input.goalProgress ?? [],
        etaSummary: input.etaSummary ?? null,
        programState: input.programState ?? null,
        ...(input.supervisorSays ? { supervisorSays: input.supervisorSays } : {}),
      }),
    )
    .digest('hex');
}

// ── Summary (utility LLM + local template fallback — the generateTitle pattern) ─

/** How many goals the summary (template + prompt) spells out by name. */
const SUMMARY_GOAL_CAP = 3;

/**
 * One deterministic "N of M tasks done toward "Goal" — <eta phrase>" fragment
 * per goal (shared by the local template and the prompt's goal-facts block).
 */
function goalFactLine(gp: DigestGoalProgress): string {
  // P7 v1#20: deps-blocked rows are ordering, not stalls — say so when they
  // are the only "blocked" rows, so the phrase and the class never disagree.
  const deps = gp.depsBlockedCount ?? 0;
  const gate = gp.blockedCount - deps;
  // Ticket C1 (a): name the stale subset so the fragment and the class agree.
  const stale = gp.staleDepsBlockedCount ?? 0;
  const blocked = gp.blockedCount > 0
    ? (gate > 0
      ? `, ${gp.blockedCount} blocked`
      : stale > 0
        ? `, ${deps} waiting on dependencies (${stale} for over 3 days)`
        : `, ${deps} waiting on dependencies`)
    : '';
  const note = gp.progressNote ? `; latest: "${progressNoteForDisplay(gp.progressNote, 90)}"` : '';
  return `${gp.todosDone} of ${gp.todosTotal} tasks done toward "${gp.title}"${blocked} — ${goalEtaPhrase(gp)}${note}`;
}

// ── Review 2026-09-13 issue 16 (PULSE part): no-goal buckets speak neutrally ──
// spark-cluster (86 runs, 0 active goal rows — its goal was marked done while
// the work continued) read 'no active goals… No progress… No action needed':
// three negative sentences about a busy project. The DATA was right; the
// prose was the defect. A tracked-goal-less bucket that DID work now gets ONE
// neutral sentence, never a "no progress toward any goal" verdict.

/** Did the bucket record any work in the window (mirrors the status derivation)? */
export function bucketHadActivity(stats: DigestStats): boolean {
  return stats.messages.total > 0 || stats.runs.started > 0 || stats.runs.active > 0
    || stats.runs.completed > 0 || stats.runs.failed > 0;
}

/** Plain-English "recent work" phrase from the non-zero activity facts only. */
export function recentWorkPhrase(stats: DigestStats): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (stats.runs.completed > 0) parts.push(`${plural(stats.runs.completed, 'run', 'runs')} finished`);
  if (stats.runs.failed > 0) parts.push(`${plural(stats.runs.failed, 'run', 'runs')} failed`);
  if (stats.runs.active > 0) parts.push(`${stats.runs.active} still running`);
  if (parts.length === 0 && stats.runs.started > 0) parts.push(`${plural(stats.runs.started, 'run', 'runs')} started`);
  if (stats.messages.assistant > 0) parts.push(plural(stats.messages.assistant, 'assistant update', 'assistant updates'));
  if (stats.messages.user > 0) parts.push(`${plural(stats.messages.user, 'message', 'messages')} from you`);
  return parts.length > 0 ? `${parts.join(', ')} in the last hour` : 'nothing recorded in the last hour';
}

/** THE one neutral sentence for a goal-less bucket that did work. */
export function neutralNoGoalSentence(projectName: string, stats: DigestStats): string {
  // Ticket 7ee38c8e (merged): say what already finished when goals exist but none is active.
  const completed = completedGoalsPhrase(stats.goals);
  return `No goal is being tracked for ${projectName}${completed ? ` (${completed})` : ''}; recent work: ${recentWorkPhrase(stats)}.`;
}

/** The degenerate verdicts the LLM must never ship for a goal-less bucket. */
// (The neutral clause the prompt asks for — "No goal is being tracked for X
// yet" — is deliberately NOT in this set; only the verdict phrasings are.)
const NEGATIVE_NO_GOAL_VERDICT_RE = /\bno progress\b|toward any goal|\bno active goals?\b|\bno action (?:is )?(?:needed|required)\b/i;

/** Local template — ALWAYS producible, used when the LLM returns empty/throws.
 *  `goalsScoped` is false ONLY for the UNGROUPED bucket (goals are project-
 *  scoped, so "no goal is being tracked" would be a non-fact there). */
export function fallbackDigestSummary(
  projectName: string,
  status: ProjectDigestStatus,
  stats: DigestStats,
  attentionItems: DigestAttentionItem[],
  goalProgress: DigestGoalProgress[] = [],
  etaSummary: DigestEtaSummary | null = null,
  goalsScoped: boolean = true,
  /** Project-supervisor preflight 2026-09-14: the project supervisor's own
   *  scrubbed one-liner (supervisorSaysLine) — appended as ONE trailing
   *  sentence on every branch; null (the default) leaves every existing
   *  template byte-identical. */
  supervisorSays: string | null = null,
): string {
  const supervisorTail = supervisorSays ? ` Its supervisor says: "${supervisorSays}".` : '';
  // Review 2026-09-13 issue 16: a goal-less project that did work → ONE neutral
  // sentence (the on_track branch; attention statuses keep their lead item).
  if (goalsScoped && goalProgress.length === 0 && status === 'on_track' && bucketHadActivity(stats)) {
    return `${neutralNoGoalSentence(projectName, stats)}${supervisorTail}`;
  }
  const activity =
    `${stats.messages.user} user message(s), ${stats.messages.assistant} assistant repl(ies), ` +
    `${stats.runs.completed} completed run(s) in the last hour`;
  // Deterministic goal + ETA tail (Project Pulse): goal counts BY NAME + the
  // computed eta phrase — appended to every status branch so an LLM outage
  // still ships the owner the goal linkage and the honest estimate.
  const goalBits = goalProgress.slice(0, SUMMARY_GOAL_CAP).map(goalFactLine);
  const overallEta =
    etaSummary && goalProgress.length > 1
      ? ` Overall: ${etaSummary.todosDone} of ${etaSummary.todosTotal} tasks done across ${etaSummary.goalsTracked} goals — ${etaSummaryPhrase(etaSummary)}.`
      : '';
  // Ticket 7ee38c8e: with zero tracked goals the tail must still say WHAT
  // finished — an all-completed project reads as goal-less otherwise (the
  // spark-cluster "no active goals tracked" owner confusion).
  const completion = completedGoalsPhrase(stats.goals);
  // Neutral wording (review 2026-09-13 issue 16): never the "no active goals"
  // verdict phrase the owner read as "nothing is happening".
  const completionTail = goalBits.length === 0 && completion ? ` No goal is being tracked right now — ${completion}.` : '';
  // Project-supervisor preflight 2026-09-14: the supervisor's line rides AFTER
  // the goal tail on every branch (one sentence, already scrubbed of ids).
  const goalTail = (goalBits.length > 0 ? ` Goals: ${goalBits.join('; ')}.${overallEta}` : completionTail) + supervisorTail;
  const first = attentionItems[0];
  switch (status) {
    case 'blocked': {
      const n = attentionItems.filter((i) => i.kind === 'blocked_goal' || i.kind === 'blocked_todo').length;
      return `${projectName} is blocked — ${n} blocked item(s), led by "${first?.title ?? 'unknown'}"${first?.detail ? `: ${first.detail}` : ''}. Activity: ${activity}.${goalTail}`;
    }
    case 'needs_attention':
      return `${projectName} needs attention — ${attentionItems.length} item(s), led by "${first?.title ?? 'unknown'}"${first?.detail ? `: ${first.detail}` : ''}. Activity: ${activity}.${goalTail}`;
    case 'on_track':
      return `${projectName} is active and on track: ${activity}. No blockers or failures detected.${goalTail}`;
    case 'idle':
    default:
      return `${projectName} was idle in the last hour — no new messages or runs across its ${stats.chatCount} chat(s).${goalTail}`;
  }
}

/**
 * Plain-English summary via the utility LLM (≤4 sentences: where the project
 * is, goal linkage BY NAME with the computed numbers, and the honest ETA
 * phrase VERBATIM from the goal facts); falls back to the local template when
 * the LLM returns empty or throws (mirrors generateTitle's hardening). Voice
 * rules mirror owner-briefing.service.ts: no ids, no Z-times, no markdown, no
 * jargon — project and goal names are fine.
 */
export async function summarizeDigest(
  projectName: string,
  status: ProjectDigestStatus,
  stats: DigestStats,
  attentionItems: DigestAttentionItem[],
  goalProgress: DigestGoalProgress[] = [],
  etaSummary: DigestEtaSummary | null = null,
  /** P7 G16: the project's own current-state doc (bounded upstream to 4k). */
  programState: string | null = null,
  /** false ONLY for the UNGROUPED bucket (see fallbackDigestSummary). */
  goalsScoped: boolean = true,
  /** Project-supervisor preflight 2026-09-14: the project supervisor's own
   *  scrubbed one-liner, or null when the project has no supervisor lane /
   *  no current note. Carried into the prompt as a quoted FACT the model may
   *  use in at most one clause — never a source of new claims. */
  supervisorSays: string | null = null,
): Promise<string> {
  const local = fallbackDigestSummary(projectName, status, stats, attentionItems, goalProgress, etaSummary, goalsScoped, supervisorSays);
  const noGoalTracked = goalsScoped && goalProgress.length === 0;
  // Review 2026-09-13 issue 16: a goal-less on-track bucket that did work ships
  // the ONE neutral sentence deterministically — no LLM call, no room for the
  // 'no active goals… No progress… No action needed' triple.
  if (noGoalTracked && status === 'on_track' && bucketHadActivity(stats)) return local;
  const goalFacts =
    goalProgress.length > 0
      ? goalProgress
          .slice(0, SUMMARY_GOAL_CAP + 3)
          .map((gp) => `- ${goalFactLine(gp)}`)
          .join('\n')
      : 'none tracked';
  // Ticket 7ee38c8e: a project whose goals ALL completed must not read as
  // goal-less — the prompt carries the same deterministic completion fact the
  // local fallback renders, so the LLM and the template can never disagree.
  const completionFact = completedGoalsPhrase(stats.goals);
  const overallFact =
    etaSummary
      ? `Overall: ${etaSummary.todosDone} of ${etaSummary.todosTotal} tasks done across ${etaSummary.goalsTracked} goal(s) — ${etaSummaryPhrase(etaSummary)}`
      : noGoalTracked
        // Review 2026-09-13 issue 16 + ticket 7ee38c8e (merged): a neutral
        // instruction, not a negative fact the model then triples, and — when
        // goals already finished — the deterministic completion context so an
        // all-completed project never reads as goal-less.
        ? `No goal is being tracked for this project right now${completionFact ? ` (${completionFact})` : ''}. Mention that in AT MOST one neutral clause (e.g. "No goal is being tracked for ${projectName} yet${completionFact ? ` — ${completionFact}` : ''}") and spend the rest on the recent work and the attention items. NEVER write that no progress was made, that no progress was reported toward any goal, or that no action is needed — those are verdicts, not facts.`
        : 'Overall: goals are project-scoped; this bucket has none to report on.';
  const prompt = `Write a status pulse for the project "${projectName}" (status: ${status}) — AT MOST 4 short plain-English sentences a busy non-technical owner instantly understands.

Weave together:
1. Where the project is right now (from the last-hour activity and attention items).
2. How that relates to its goals, BY NAME, with the exact progress numbers given below (e.g. 7 of 18 tasks done toward "Goal name").
3. The time estimate EXACTLY as phrased in the goal facts below — copy the estimate wording; never invent a date, a deadline, or any estimate not stated there.

Activity (last hour): ${JSON.stringify(stats)}
Attention items: ${attentionItems.length ? JSON.stringify(attentionItems.slice(0, 8)) : 'none'}
Goal facts (use these names, numbers, and estimate phrases verbatim):
${goalFacts}
${overallFact}
${programState ? `\nThe project's own current-state doc (what the PROGRAM says it is doing — reconcile the pulse against it; flag contradictions plainly):\n${programState.slice(0, 1200)}\n` : ''}${supervisorSays ? `\nThe project's own supervisor said this in its latest note (a FACT to relay in at most ONE clause, e.g. 'its supervisor reports …'; quote or paraphrase it — never extend it): "${supervisorSays}"\n` : ''}
HARD RULES: no ids or hex strings; no timestamps like "03:43Z"; no markdown, tables, or bullet lists; no jargon — project and goal names are fine. Lead with what needs the owner (if anything). Just the sentences, no preamble.`;

  try {
    const raw = await utilityChat(
      [
        { role: 'system', content: 'Output ONLY the digest sentences. No reasoning, no explanation, no commentary.' },
        { role: 'user', content: prompt },
      ],
      // contentOnly: never leak DeepSeek's reasoning channel into a user-facing summary.
      { maxTokens: 1024, temperature: 0.4, timeout: 10_000, contentOnly: true },
    );
    const summary = (raw || '').trim();
    if (!summary) {
      logger.warn(`project-digest: utility LLM returned empty content for "${projectName}", using local fallback`);
      return local;
    }
    // Review 2026-09-13 issue 16: the negative no-goal verdict never ships —
    // a goal-less bucket whose LLM prose still says "no progress toward any
    // goal" / "no action needed" falls back to the deterministic template.
    if (noGoalTracked && NEGATIVE_NO_GOAL_VERDICT_RE.test(summary)) {
      logger.warn(`project-digest: utility LLM wrote a negative no-goal verdict for "${projectName}" — using the neutral local template instead`);
      return local;
    }
    return summary.slice(0, 2_000);
  } catch (err: any) {
    logger.warn(`project-digest: utility LLM unavailable for "${projectName}", using local fallback — ${err?.message ?? err}`);
    return local;
  }
}

// ── Program-truth reader (P7 spark G16) ──────────────────────────────────────

/** Bound on the injected current-state doc. */
export const PROGRAM_STATE_MAX_CHARS = 4000;
export const PROGRAM_STATE_CACHE_SEC = 30 * 60;
export const PROGRAM_STATE_CACHE_KEY = (projectId: string) => `digest:programstate:${projectId}`;
const PROGRAM_STATE_REL_PATH = '.digby/rules/00-current-state.md';

/**
 * Read the project's `.digby/rules/00-current-state.md` from the bare MIRROR's
 * default branch (the P6 scaffold creates it; lanes are told to keep the
 * CURRENT phase/goals there). Bounded to 4k, cached per project for 30 min
 * (Redis; '' caches the absent case), FAIL-OPEN null on every failure.
 *
 * WHICH COPY (fixer 2026-09-27, finding docs-churn-log-2): this reads the
 * DEFAULT branch, not a lane's session branch, so a state-file change is
 * visible here only once it lands on main. The lane doctrine (coding/agent.ts
 * publishing bullet, scaffolding renderCurrentStateRule / "Docs are part of
 * the change") says exactly that and exempts a state-only PR (`.digby/**`
 * only) from the docs-only class (pr-diff-shape.ts isStatePath) so landing it
 * is never noticed or refused. Keep the three in step.
 *
 * Order matters for the jest graphs: the mirror-existence probe runs BEFORE
 * any Redis touch — suites that never provision a mirror bail here without
 * loading config/redis (whose env chain exits keyless workers). All deps are
 * dynamic imports for the same reason.
 */
export async function readProgramState(projectId: string): Promise<string | null> {
  try {
    const [ws, fsMod] = await Promise.all([import('../coding/workspace.service'), import('fs/promises')]);
    const mirror = ws.repoMirrorPath(projectId);
    try {
      await fsMod.access(mirror);
    } catch {
      return null; // no mirror (plain-chat project / never provisioned) — nothing to read
    }
    // Cache AFTER the cheap existence probe (see the docblock).
    let redis: any = null;
    try {
      redis = (await import('../../../config/redis')).default;
      const cached = await redis.get(PROGRAM_STATE_CACHE_KEY(projectId));
      if (cached !== null && cached !== undefined) return cached === '' ? null : String(cached);
    } catch { redis = null; /* cacheless read — still bounded by the 30-min sweep cadence */ }
    let out: string | null = null;
    // The default branch from the mirror's own HEAD; A1-demoted mirrors track
    // the remote under refs/remotes/origin/* (the learnings-index pattern).
    const branch = (await ws.git(['symbolic-ref', '--short', 'HEAD'], mirror, 15_000)
      .then((r: any) => r.stdout.trim()).catch(() => '')) || 'main';
    for (const ref of [`refs/remotes/origin/${branch}`, branch]) {
      try {
        const { stdout } = await ws.git(['show', `${ref}:${PROGRAM_STATE_REL_PATH}`], mirror, 15_000);
        const text = String(stdout ?? '').slice(0, PROGRAM_STATE_MAX_CHARS).trim();
        out = text || null;
        break;
      } catch { /* try the next ref */ }
    }
    if (redis) await redis.set(PROGRAM_STATE_CACHE_KEY(projectId), out ?? '', { EX: PROGRAM_STATE_CACHE_SEC }).catch(() => {});
    return out;
  } catch (err: any) {
    logger.warn(`project-digest: program-state read failed for ${projectId} (fail-open): ${err?.message ?? err}`);
    return null;
  }
}

// ── Bucket digest ─────────────────────────────────────────────────────────────

interface BucketChat {
  id: string;
  title: string;
  projectId: string | null;
  /** Project-supervisor preflight 2026-09-14: the project's own supervisor lane
   *  (at most one per project — partial unique index). Optional so older
   *  callers/fixtures keep working. */
  isProjectSupervisor?: boolean | null;
}

/**
 * A live staged confirmation (status 'pending', unexpired) — the DURABLE
 * "decision awaiting the user" signal, fetched once per user by digestUser
 * and fanned out to whichever bucket owns the chat.
 */
interface LiveConfirmation { chatId: string; summary: string; createdAt: Date }

/**
 * Regenerate ONE (userId, projectId) bucket. Errors propagate to the caller's
 * per-bucket catch — one bad bucket never kills the sweep.
 */
async function digestBucket(opts: {
  userId: string;
  projectId: string | null;
  projectName: string;
  chats: BucketChat[];
  pendingConfirmations: LiveConfirmation[];
  windowStart: Date;
  windowEnd: Date;
}): Promise<void> {
  const { userId, projectId, projectName, chats, pendingConfirmations, windowStart, windowEnd } = opts;
  const now = windowEnd;
  const chatIds = chats.map((c) => c.id);
  const chatTitle = new Map(chats.map((c) => [c.id, c.title]));
  // Project-supervisor preflight 2026-09-14: the project's own supervisor lane
  // (never in the UNGROUPED bucket — project supervisors are project-scoped).
  const supervisorChat = projectId ? chats.find((c) => c.isProjectSupervisor === true) ?? null : null;

  const [messages, runs, runningRuns, queued, schedules, codingStates, goals, todos, existing, supervisorNotes] = await Promise.all([
    // Window messages (role + origin stats; capped scan — a flood bucket degrades gracefully).
    prisma.crossModelMessage.findMany({
      where: { chatId: { in: chatIds }, createdAt: { gte: windowStart } },
      select: { chatId: true, role: true, metadata: true },
      take: MAX_MESSAGES_SCANNED,
    }),
    // Runs touched by the window (started in it, finished in it, or still
    // heartbeating through it — a long run that started BEFORE the window is
    // still activity while its heartbeat moves).
    prisma.agentRun.findMany({
      where: {
        sessionId: { in: chatIds },
        OR: [{ createdAt: { gte: windowStart } }, { finishedAt: { gte: windowStart } }, { heartbeatAt: { gte: windowStart } }],
      },
      select: { id: true, sessionId: true, status: true, error: true, createdAt: true, finishedAt: true, heartbeatAt: true },
    }),
    // Currently-'running' runs — the stalled-detection pool.
    prisma.agentRun.findMany({
      where: { sessionId: { in: chatIds }, status: 'running' },
      select: { id: true, sessionId: true, heartbeatAt: true, updatedAt: true, startedAt: true },
    }),
    // Busy-chat queue depth (+ stuck detection) for the bucket's chats.
    prisma.pendingChatMessage.findMany({
      where: { chatId: { in: chatIds } },
      select: { id: true, chatId: true, createdAt: true, source: true },
    }),
    prisma.chatSchedule.findMany({
      where: { sessionId: { in: chatIds } },
      select: { id: true, sessionId: true, lastFiredAt: true, lastStatus: true, prompt: true, enabled: true, kind: true, runsCount: true, cancelledBy: true, disabledAt: true },
    }),
    prisma.chatCodingState.findMany({
      where: { id: { in: chatIds } },
      select: { id: true, status: true, errorMessage: true, updatedAt: true },
    }),
    // Goals/todos are project-scoped — the UNGROUPED bucket has none.
    projectId
      ? prisma.projectGoal.findMany({
          where: { userId, projectId },
          // Ticket C1 (b): `premises` feeds the deadline gate (JSON, bounded 8/goal);
          // `blockedAt` (review fix 2026-09-27) ages the goal's own deps block.
          select: { id: true, title: true, status: true, blockedReason: true, blockKind: true, gateQuestionId: true, progressNote: true, premises: true, blockedAt: true, createdAt: true, updatedAt: true, createdByChatId: true },
        })
      : Promise.resolve([] as any[]),
    projectId
      ? prisma.projectTodo.findMany({
          where: { userId, projectId },
          // `blockedAt` (review fix 2026-09-27): the stale-deps gate ages a block from its transition stamp, not updatedAt.
          select: { id: true, goalId: true, title: true, status: true, blockedReason: true, blockKind: true, gateQuestionId: true, progressNote: true, blockedAt: true, createdAt: true, updatedAt: true, assigneeChatId: true },
        })
      : Promise.resolve([] as any[]),
    prisma.projectDigest.findFirst({
      where: { userId, projectId: projectId ?? null },
      select: { id: true, signature: true },
    }),
    // Project-supervisor preflight 2026-09-14: the supervisor lane's newest
    // assistant rows inside the 90-min "current" window — the first one in
    // the lane's own voice becomes the "supervisor says" fact. Fail-open:
    // a read error only drops the fact (the bucket still digests).
    supervisorChat
      ? prisma.crossModelMessage
          .findMany({
            where: { chatId: supervisorChat.id, role: 'assistant', createdAt: { gte: new Date(now.getTime() - SUPERVISOR_SAYS_WINDOW_MS) } },
            orderBy: { createdAt: 'desc' },
            take: SUPERVISOR_SAYS_FETCH,
            select: { content: true, metadata: true, createdAt: true },
          })
          .catch((err: any) => {
            logger.warn(`project-digest: project-supervisor note read failed for bucket ${userId}/${projectId} (fact omitted): ${err?.message ?? err}`);
            return [] as Array<{ content: string; metadata: unknown; createdAt: Date }>;
          })
      : Promise.resolve([] as Array<{ content: string; metadata: unknown; createdAt: Date }>),
  ]);

  // Project-supervisor preflight 2026-09-14: the one scrubbed line (or null).
  let supervisorSays: string | null = null;
  for (const row of supervisorNotes ?? []) {
    if (!isSupervisorOwnVoice(row.metadata)) continue;
    // Ticket dd4e20ad: a provider-killed wake's terminal envelope row CARRIES
    // the finalize stamp (metadata.engine 'agent' is unconditional in
    // chat-agent's base metadata), so it passes isSupervisorOwnVoice — and the
    // 429 "Sorry — I couldn't get an answer out this time…" fallback has no
    // ids/links/timestamps for supervisorSaysLine to scrub, so it rendered
    // VERBATIM as the supervisor's voice in the owner digest until a real note
    // displaced it. Two-lane exclusion mirrors attention-watchdog.service.ts
    // and project-status.service.ts (ticket 68742517): the deterministic
    // metadata.providerError marker first (stamped at persist since ticket
    // 08e58e1d), then the envelope shapes (isHarnessErrorNote) for rows
    // persisted before the marker existed or persisted unmarked.
    if ((row.metadata as any)?.providerError) continue;
    if (isHarnessErrorNote(row.content)) continue;
    supervisorSays = supervisorSaysLine(row.content);
    if (supervisorSays) break;
  }

  // ── Stats ────────────────────────────────────────────────────────────────
  const byOrigin: Record<string, number> = {};
  let userMsgs = 0;
  let assistantMsgs = 0;
  const activeChatIds = new Set<string>();
  for (const m of messages) {
    activeChatIds.add(m.chatId);
    const origin = rowOrigin(m.metadata) ?? m.role; // unmarked rows count under their role
    if (m.role === 'user') userMsgs++;
    // Harness status cards (project_status / session_status, 2026-09-15) are
    // written FOR the owner, not by a lane — they are not "assistant updates".
    else if (origin !== 'project_status' && origin !== 'session_status') assistantMsgs++;
    byOrigin[origin] = (byOrigin[origin] ?? 0) + 1;
  }

  let runsStarted = 0;
  let runsCompleted = 0;
  let runsFailed = 0;
  let runsActive = 0;
  for (const r of runs) {
    activeChatIds.add(r.sessionId);
    if (r.createdAt >= windowStart) runsStarted++;
    if (r.status === 'completed' && r.finishedAt && r.finishedAt >= windowStart) runsCompleted++;
    if (r.status === 'failed' && (r.finishedAt ?? r.createdAt) >= windowStart) runsFailed++;
    if (r.heartbeatAt && r.heartbeatAt >= windowStart) runsActive++;
  }

  // Canonicalize for the signature: findMany has no ORDER BY, so byOrigin's
  // key INSERTION order (and attentionItems' push order below) would otherwise
  // make the JSON.stringify hash order-sensitive → spurious regen + LLM spend.
  const byOriginSorted: Record<string, number> = {};
  for (const key of Object.keys(byOrigin).sort()) byOriginSorted[key] = byOrigin[key];

  const stats: DigestStats = {
    chatCount: chats.length,
    activeChats: activeChatIds.size,
    messages: { total: userMsgs + assistantMsgs, user: userMsgs, assistant: assistantMsgs, byOrigin: byOriginSorted },
    runs: { started: runsStarted, completed: runsCompleted, failed: runsFailed, active: runsActive },
    todos: {
      total: todos.length,
      done: todos.filter((t) => t.status === 'done').length,
      blocked: todos.filter((t) => t.status === 'blocked').length,
      // P7 N5: dropped = terminal owner-superseded cancellations (excluded from
      // the goalProgress pace/ETA math; counted here so nothing is hidden).
      dropped: todos.filter((t) => t.status === 'dropped').length,
      createdInWindow: todos.filter((t) => t.createdAt >= windowStart).length,
      completedInWindow: todos.filter((t) => t.status === 'done' && t.updatedAt >= windowStart).length,
    },
    goals: {
      total: goals.length,
      done: goals.filter((g) => g.status === 'done').length,
      blocked: goals.filter((g) => g.status === 'blocked').length,
      createdInWindow: goals.filter((g) => g.createdAt >= windowStart).length,
      completedInWindow: goals.filter((g) => g.status === 'done' && g.updatedAt >= windowStart).length,
      // Ticket 7ee38c8e: terminal-goal context — a project whose goals ALL
      // completed must not render like one that never had any. updatedAt of
      // terminal rows is the same completion-time proxy used above (a later
      // EDIT to a terminal goal re-stamps it — pragmatic, same caveat as the
      // todos proxy); the DATE (YYYY-MM-DD UTC) is stable across the hour, so
      // the signature does not drift on wall-clock noise.
      archived: goals.filter((g) => g.status === 'archived').length,
      lastFinishedAt: (() => {
        const terminal = goals.filter((g) => g.status === 'done' || g.status === 'archived');
        if (terminal.length === 0) return null;
        const newest = terminal.reduce((a, b) => (b.updatedAt.getTime() > a.updatedAt.getTime() ? b : a));
        return newest.updatedAt.toISOString().slice(0, 10);
      })(),
    },
    schedules: {
      firedInWindow: schedules.filter((s) => s.lastFiredAt && s.lastFiredAt >= windowStart).length,
      errored: schedules.filter((s) => isScheduleError(s.lastStatus)).length,
    },
    queuedMessages: queued.length,
    // Project-supervisor preflight 2026-09-14: the supervisor lane's own
    // slice of the window's activity (its runs already count in `runs`;
    // this attributes them). Key present only when the lane exists.
    ...(supervisorChat
      ? {
          projectSupervisor: {
            runsInWindow: runs.filter((r) => r.sessionId === supervisorChat.id).length,
            notesInWindow: messages.filter((m) => m.chatId === supervisorChat.id && m.role !== 'user').length,
          },
        }
      : {}),
  };

  // ── Attention items (priority order: blockers first) ─────────────────────
  // stuck_message suppression: drainChatQueue is a documented no-op while a run
  // owns the chat (the active run's finally drains), so a message queued behind
  // a HEALTHY long run is deferred, NOT stuck. Reuse the stalled_run freshness
  // field (heartbeatAt ?? updatedAt) so the two signals can never disagree.
  const liveRunChatIds = new Set(
    runningRuns
      .filter((r) => now.getTime() - (r.heartbeatAt ?? r.updatedAt).getTime() < STALLED_RUN_MS)
      .map((r) => r.sessionId),
  );
  const attentionItems: DigestAttentionItem[] = [];
  // ── Owner-wait line integrity + escalation (remediation P2 N10 + S2a) ─────
  // An "awaiting owner" claim must carry an OPEN owner-question (oq_) id or it
  // is dropped from the digest (the 21:17Z class: prose owner-waits nobody can
  // answer). Verified waits get the oq id + an 'awaiting you N day(s)' age
  // annotation past 24h, and a once-per-day Telegram re-push past 72h.
  const blockedGoalRows = goals.filter((g: any) => g.status === 'blocked' && isActionableBlock(g.blockedReason));
  const blockedTodoRows = todos.filter((t: any) => t.status === 'blocked' && isActionableBlock(t.blockedReason));
  const oqIdsToProbe = new Set<string>();
  for (const r of [...blockedGoalRows, ...blockedTodoRows] as any[]) {
    if (r.gateQuestionId) oqIdsToProbe.add(String(r.gateQuestionId));
    const inline = INLINE_OQ_ID_RE.exec(String(r.blockedReason ?? ''));
    if (inline) oqIdsToProbe.add(inline[0]);
    INLINE_OQ_ID_RE.lastIndex = 0;
  }
  const openOq = new Map<string, any>();
  // CanLaw 2026-09-15: probe at ANY status. An ANSWERED card whose answer was a
  // real decision (not a reply that was itself a question) means the owner
  // already spoke — the row is a stale gate the team must act on, never a
  // "team's own rule" and never an owner wait.
  const answeredOq = new Map<string, any>();
  if (oqIdsToProbe.size) {
    try {
      const rows = await prisma.ownerQuestion.findMany({ where: { id: { in: [...oqIdsToProbe] } } });
      for (const row of rows ?? []) {
        // Prod rows always carry status; a missing status (partial mock) keeps
        // the legacy "open" reading.
        const st = String((row as any).status ?? 'open');
        if (st === 'open') openOq.set(row.id, row);
        else if (st === 'answered' && !isCounterQuestionRow(row as any)) answeredOq.set(row.id, row);
      }
    } catch (err: any) {
      logger.warn(`project-digest: owner-question probe failed (owner-wait lines fail open): ${err?.message ?? err}`);
      // Fail OPEN: unprobeable ids count as open so a DB hiccup never hides a real wait.
      for (const id of oqIdsToProbe) openOq.set(id, null);
    }
  }
  const pushBlockedItem = async (row: any, base: DigestAttentionItem): Promise<void> => {
    const claimsOwnerWait = row.blockKind === 'owner' || OWNER_WAIT_CLAIM_RE.test(String(row.blockedReason ?? ''));
    if (!claimsOwnerWait) { attentionItems.push(base); return; }
    const inline = INLINE_OQ_ID_RE.exec(String(row.blockedReason ?? ''))?.[0];
    INLINE_OQ_ID_RE.lastIndex = 0;
    const oqId: string | null =
      (row.gateQuestionId && openOq.has(String(row.gateQuestionId)) ? String(row.gateQuestionId) : null)
      ?? (inline && openOq.has(inline) ? inline : null);
    if (!oqId) {
      const entity: 'goal' | 'todo' = base.kind === 'blocked_goal' ? 'goal' : 'todo';
      const rowId = entity === 'goal' ? String(base.goalId ?? '') : String(base.todoId ?? '');
      // An ANSWERED cited card (with a decision): the owner already spoke — a
      // STALE GATE the team must act on. Rendered as such; no corrective wake
      // (the owner-gate sweeper releases gateQuestionId-linked rows itself).
      const answeredId = (row.gateQuestionId && answeredOq.has(String(row.gateQuestionId)) ? String(row.gateQuestionId) : null)
        ?? (inline && answeredOq.has(inline) ? inline : null);
      if (answeredId) {
        try {
          const { recordLoopMetric } = await import('../platform/loop-metrics.service');
          recordLoopMetric({ kind: 'stale_gate', meta: { surface: 'project_digest', entity, id: rowId.slice(0, 8), oqId: answeredId.slice(0, 11), oqStatus: 'answered' } });
        } catch { /* telemetry never blocks */ }
        const answer = String(answeredOq.get(answeredId)?.answer ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
        attentionItems.push({
          ...base,
          detail: `${STALE_GATE_DETAIL_PREFIX}${answer ? ` ("${answer}")` : ''} — the team has to act on that answer; no owner decision is pending`,
        });
        return;
      }
      // N10: an owner-wait line with no open oq id is counted…
      try {
        const { recordLoopMetric } = await import('../platform/loop-metrics.service');
        recordLoopMetric({ kind: 'owner_wait_line_dropped', meta: { itemKind: base.kind, id: rowId, projectId: projectId ?? 'ungrouped' } });
      } catch { /* telemetry never blocks */ }
      // …and (CanLaw stall 2026-09-15) no longer silently dropped. The lane
      // that wrote the claim — and the project's supervisor — get ONE
      // corrective wake per row per 24h (the gate is lane-authored and theirs
      // to lift), and the owner's surfaces render the row truthfully: a block
      // the team imposed on itself, not a decision waiting on the owner. It
      // stays a plain blocked_* item (never awaiting_input — nothing here
      // needs the owner) and does NOT count as a standstill blocker, so the
      // dashboard headline reads "the machines are on it", not "needs you".
      // The lane-written reason is NOT quoted back to the owner (it is the
      // laundered phrase itself); the wake carries it to the lane.
      try {
        const { noteUnbackedOwnerWaitClaim } = await import('../platform/goals.service');
        await noteUnbackedOwnerWaitClaim({
          userId, entity, id: rowId, title: base.title,
          blockedReason: row.blockedReason ?? null,
          laneChatId: entity === 'todo' ? (row.assigneeChatId ?? null) : (row.createdByChatId ?? null),
          projectId: projectId ?? null, surface: 'project_digest',
        });
      } catch (err: any) {
        logger.warn(`project-digest: unbacked owner-claim wake failed (non-fatal): ${err?.message ?? err}`);
      }
      attentionItems.push({ ...base, detail: TEAM_PAUSE_DETAIL });
      logger.info(`project-digest: owner-wait claim with no open oq id rendered as a team-imposed block (${base.kind} ${rowId.slice(0, 8)})`);
      return;
    }
    const oqRow = openOq.get(oqId);
    const ageMs = oqRow?.createdAt instanceof Date ? now.getTime() - oqRow.createdAt.getTime() : 0;
    const days = Math.floor(ageMs / 86_400_000);
    // Default answer (P7 S2b): past the flagger's preset defaultAfterDays (with
    // a defaultOption — BOTH required; the service re-checks the pair), the
    // question AUTO-ANSWERS with the default: the answer wake fires as usual
    // and the owner gets a confirmation DM. This digest line then records the
    // application instead of an open wait. Same hourly seam as the 72h re-push.
    if (oqRow) {
      try {
        const { applyDefaultAnswerIfDue } = await import('../platform/owner-questions');
        if (await applyDefaultAnswerIfDue(oqRow, now)) {
          attentionItems.push({
            ...base,
            detail: `${base.detail ?? 'Awaiting owner decision'} [${oqId.slice(0, 11)} auto-answered with its preset default after ${days} day${days === 1 ? '' : 's'} — see the confirmation DM]`.trim(),
          });
          return; // no longer an open wait — the re-push below would lie
        }
      } catch (err: any) {
        logger.warn(`project-digest: default-answer check failed (non-fatal): ${err?.message ?? err}`);
      }
    }
    const suffix = days >= 1 ? `[${oqId.slice(0, 11)} open — awaiting you ${days} day${days === 1 ? '' : 's'}]` : `[${oqId.slice(0, 11)} open]`;
    attentionItems.push({ ...base, detail: `${base.detail ?? 'Awaiting owner decision'} ${suffix}`.trim() });
    // 72h escalation (S2a): re-push the Telegram DM once per question per day.
    if (oqRow && ageMs >= 72 * 60 * 60 * 1000) {
      try {
        const { repushOwnerQuestionReminder } = await import('../platform/owner-questions');
        await repushOwnerQuestionReminder(oqRow, days);
      } catch (err: any) {
        logger.warn(`project-digest: 72h owner-wait re-push failed (non-fatal): ${err?.message ?? err}`);
      }
    }
  };
  for (const g of blockedGoalRows) {
    await pushBlockedItem(g, { kind: 'blocked_goal', title: g.title, detail: g.blockedReason ?? null, goalId: g.id, at: iso(g.updatedAt) });
  }
  for (const t of blockedTodoRows) {
    await pushBlockedItem(t, { kind: 'blocked_todo', title: t.title, detail: t.blockedReason ?? null, todoId: t.id, goalId: t.goalId, at: iso(t.updatedAt) });
  }
  // awaiting_input — a human decision parks the work; outranks failures/errors
  // under the cap (pushed before them), still needs_attention (NOT blocked —
  // that tier is reserved for explicit goal/todo blockers).
  // Durable leg (Postgres): staged confirmations the user hasn't confirmed/
  // cancelled yet. The bucket lookup (chatTitle) inherently skips hidden fleet
  // artifacts and foreign chats — their confirmations land in no bucket.
  for (const c of pendingConfirmations) {
    const title = chatTitle.get(c.chatId);
    if (title === undefined) continue; // some OTHER bucket's chat (or hidden)
    attentionItems.push({
      kind: 'awaiting_input',
      title,
      detail: c.summary ? c.summary.slice(0, 120) : null,
      chatId: c.chatId,
      at: iso(c.createdAt),
    });
  }
  // Ephemeral leg (Redis, best-effort): ask_user questions + permission
  // approvals of LIVE runs (a parked run still heartbeats — run-executor's
  // lockRefresh interval — so liveRunChatIds IS the parked-on-input pool).
  // One probe per live-run chat, skipped when the durable leg already flagged
  // the chat; a Redis hiccup degrades to "nothing pending", never a failed sweep.
  const durableFlagged = new Set(
    attentionItems.filter((i) => i.kind === 'awaiting_input').map((i) => i.chatId),
  );
  const redisProbeChatIds = [...liveRunChatIds].filter((id) => !durableFlagged.has(id));
  if (redisProbeChatIds.length > 0) {
    try {
      const { getSessionAttention } = await import('../coding/session-run-lock');
      for (const chatId of redisProbeChatIds) {
        const attention = await getSessionAttention(chatId).catch(() => ({ approvals: [] as string[], questions: [] as string[] }));
        const hasApprovals = attention.approvals.length > 0;
        const hasQuestions = attention.questions.length > 0;
        if (!hasApprovals && !hasQuestions) continue;
        attentionItems.push({
          kind: 'awaiting_input',
          title: chatTitle.get(chatId) ?? chatId,
          detail: hasApprovals && hasQuestions
            ? 'Waiting on your input'
            : hasQuestions
              ? 'Waiting on your answer'
              : 'Waiting on a permission approval',
          chatId,
          at: iso(now),
        });
      }
    } catch (err: any) {
      logger.warn(`project-digest: Redis attention leg failed for bucket ${userId}/${projectId ?? 'ungrouped'} (sweep continues): ${err?.message ?? err}`);
    }
  }
  for (const r of runs.filter((r) => r.status === 'failed' && (r.finishedAt ?? r.createdAt) >= windowStart)) {
    attentionItems.push({
      kind: 'failed_run',
      title: chatTitle.get(r.sessionId) ?? r.sessionId,
      detail: r.error ? String(r.error).slice(0, 300) : null,
      runId: r.id,
      chatId: r.sessionId,
      at: iso(r.finishedAt ?? r.createdAt),
    });
  }
  // Ticket 911b6c45: errorMessage only means something while status==='error'.
  // A row healed by a bare status flip (orphan sweep / claim / healUnrunnable)
  // can still carry the failed attempt's text — surfacing it as an attention
  // item wakes supervisors about a healthy lane (the ticket's exact mishap:
  // 'ready' + stale provisioning text read as provisioning-broken for hours).
  for (const s of codingStates.filter((s) => s.status === 'error')) {
    attentionItems.push({
      kind: 'session_error',
      title: chatTitle.get(s.id) ?? s.id,
      detail: (s.errorMessage ?? `session status: ${s.status}`).slice(0, 300),
      chatId: s.id,
      at: iso(s.updatedAt),
    });
  }
  for (const r of runningRuns) {
    const lastBeat = r.heartbeatAt ?? r.updatedAt;
    if (now.getTime() - lastBeat.getTime() < STALLED_RUN_MS) continue;
    attentionItems.push({
      kind: 'stalled_session',
      title: chatTitle.get(r.sessionId) ?? r.sessionId,
      detail: `run has heartbeated nothing since ${iso(lastBeat)} (started ${iso(r.startedAt)})`,
      runId: r.id,
      chatId: r.sessionId,
      at: iso(lastBeat),
    });
  }
  // Errored schedules AND recently-stopped recurring cadences (fix 3a: a
  // cadence disabled by run-cap/expiry left lastStatus 'started'/'expired' —
  // invisible to the error regex, so the project read as idle, not stopped).
  // SUCCESSOR-AWARE (SA0906, prod replay b95e9df6): self-renewing
  // schedule_self chains retire a spent link per run budget and arm a fresh
  // successor — 10 disabled links + 1 enabled row + live runs is a HEALTHY
  // lane, and flagging every spent link buried real stops in cry-wolf. A
  // stopped cadence surfaces only when the lane's heartbeat died: no ENABLED
  // schedule on the same chat AND no agent run created in the trailing 6h
  // (probed only for surviving candidates; a probe ERROR keeps the item — a
  // passive surface fails loud). Live-ERROR rows (error:/failed — the schedule
  // still fires and fails) are NOT suppressed: a sibling doesn't fix them.
  const enabledScheduleSessions = new Set(schedules.filter((s) => s.enabled).map((s) => s.sessionId));
  const stoppedCandidates = schedules.filter(
    (s) => !isScheduleError(s.lastStatus) && isStoppedCadence(s, now) && !enabledScheduleSessions.has(s.sessionId)
      // Goal-gate park (ticket b1d435fd): 'parked:dormant' is a DELIBERATE
      // policy stop with its own notice + hook event, and the sweep ensure
      // resumes it when live work reappears — surfacing it as a dead cadence
      // would cry wolf on exactly the dormant-by-design state the owner asked
      // for. (The owner-card filing allowlist below already excludes it.)
      && s.lastStatus !== 'parked:dormant',
  );
  const laneRuns6h = new Map<string, number | null>();
  for (const sid of [...new Set(stoppedCandidates.map((s) => s.sessionId))]) {
    laneRuns6h.set(
      sid,
      await prisma.agentRun
        .count({ where: { sessionId: sid, createdAt: { gte: new Date(now.getTime() - STOPPED_LANE_ACTIVITY_WINDOW_MS) } } })
        .catch(() => null),
    );
  }
  const deadStoppedIds = new Set(
    stoppedCandidates.filter((s) => (laneRuns6h.get(s.sessionId) ?? 0) === 0).map((s) => s.id),
  );
  for (const s of schedules.filter((s) => isScheduleError(s.lastStatus) || deadStoppedIds.has(s.id))) {
    attentionItems.push({
      kind: 'schedule_error',
      title: (s.prompt ?? '').slice(0, 60) || 'schedule',
      detail: isScheduleError(s.lastStatus)
        ? s.lastStatus
        : `recurring schedule stopped after ${s.runsCount} runs (last status: ${s.lastStatus ?? 'unknown'}) — it will not resume on its own`,
      scheduleId: s.id,
      chatId: s.sessionId,
      at: iso(s.lastFiredAt),
    });
  }
  // Durable owner-decision backstop (SA0906): the stop-time fast lane is a
  // lossy in-process timer, so the hourly sweep re-offers every PROVABLY-dead
  // (run probe returned 0, not an error) machine-stopped cadence to the same
  // deduped filing seam (stopped-schedule-alert). Machine stops only — a
  // 'paused' row (and an owner-attributed cancel) stays human from here, and
  // a wrong decision card is the cry-wolf class the whole guard exists for.
  // v1#13: MACHINE-cancelled rows now qualify too — cancel paths stamp
  // cancelledBy at stop time, so this sweep no longer has to guess; the
  // 12-min in-process recheck stays the fast path, this hourly pass is the
  // durable one that survives worker restarts (it keys off the DB row).
  const filingCandidates = stoppedCandidates.filter(
    (s) => laneRuns6h.get(s.sessionId) === 0
      && (s.lastStatus === 'expired' || s.lastStatus === 'started'
        || (s.lastStatus === 'cancelled' && (s as any).cancelledBy === 'machine')),
  );
  if (filingCandidates.length > 0) {
    try {
      const { maybeFileStoppedScheduleDecision } = await import('../coding/stopped-schedule-alert');
      for (const s of filingCandidates) {
        const cause = s.lastStatus === 'cancelled' ? 'cancelled' as const : 'expired' as const;
        await maybeFileStoppedScheduleDecision(s.id, cause).catch(() => {});
      }
    } catch (err: any) {
      logger.warn(`project-digest: stopped-schedule decision backstop failed for bucket ${userId}/${projectId ?? 'ungrouped'} (sweep continues): ${err?.message ?? err}`);
    }
  }
  for (const q of queued.filter((q) => now.getTime() - q.createdAt.getTime() >= STUCK_MESSAGE_MS)) {
    if (liveRunChatIds.has(q.chatId)) continue; // healthy run owns the chat — the drain is deferred, not failed
    attentionItems.push({
      kind: 'stuck_message',
      title: chatTitle.get(q.chatId) ?? q.chatId,
      detail: `queued since ${iso(q.createdAt)} (source: ${q.source}) without draining`,
      chatId: q.chatId,
      at: iso(q.createdAt),
    });
  }
  // Cap, then STABLE-SORT into a canonical order — the SAME array feeds the
  // signature AND the stored row, so what you hash is what you store (findMany
  // return order is otherwise free to vary between sweeps).
  const itemKey = (i: DigestAttentionItem) => i.goalId ?? i.todoId ?? i.runId ?? i.scheduleId ?? i.chatId ?? '';
  const cappedAttention = attentionItems
    .slice(0, MAX_ATTENTION_ITEMS)
    .sort((a, b) => a.kind.localeCompare(b.kind) || itemKey(a).localeCompare(itemKey(b)));

  // ── Status ────────────────────────────────────────────────────────────────
  // A team-imposed pause (CanLaw 2026-09-15) is a flag, not a standstill that
  // needs the owner — it never flips a quiet project to 'blocked'.
  const hasBlocker = cappedAttention.some((i) => (i.kind === 'blocked_goal' || i.kind === 'blocked_todo') && !isTeamPauseItem(i));
  const hasActivity = stats.messages.total > 0 || stats.runs.started > 0 || stats.runs.active > 0;
  // 'blocked' means BLOCKED AND QUIET — a genuine standstill that needs the
  // owner. Blocked items in a project that is actively working are FLAGS, not
  // a standstill (owner 2026-08-28, ticket 547df1ff: "it says tt-rd is blocked
  // but I just checked on the session in there and it is grinding away") —
  // owner-paused / dep-waiting / retained-for-history todos otherwise kept
  // live projects red "Blocked" forever. The bucket then reads
  // needs_attention and the blocked items stay listed with their reasons.
  const status: ProjectDigestStatus = hasBlocker && !hasActivity
    ? 'blocked'
    : cappedAttention.length > 0
      ? 'needs_attention'
      : hasActivity
        ? 'on_track'
        : 'idle';
  // Accepted bands (adversarial review, PR #455 NB1/NB2):
  //  - STALLED_RUN_MS (15m) < DIGEST_WINDOW_MS (1h): a run wedged 15–60 min
  //    counts as BOTH activity AND a stalled_session item, so a blocked bucket
  //    with a freshly-wedged run reads needs_attention for up to ~45 min
  //    until the heartbeat ages out (the stall stays listed; it self-heals).
  //  - Machine-only traffic (hourly schedule fires, even instantly-failing
  //    ones) counts as activity: 'blocked' means "blocked AND completely
  //    silent for a full hour" — the ticket's intent, stated explicitly.

  // ── Goal progress + honest ETA (Project Pulse) — pure derivation over the
  // goals/todos this bucket ALREADY loaded (no extra queries; the sweep's
  // time-budget/lease profile is unchanged).
  const goalProgress = computeGoalProgress(goals, todos, now);
  const etaSummary = computeEtaSummary(goalProgress);

  // ── Program-truth reader (P7 spark G16): the project's OWN current-state doc
  // (.digby/rules/00-current-state.md — the P6 scaffold's always-injected rule
  // file) read from the bare MIRROR's default branch, bounded 4k, cached 30 min,
  // fail-open null. Rides the digest row + the summary prompt so the Pulse
  // reflects what the PROGRAM says it is doing, not only what the DB shows.
  const programState = projectId ? await readProgramState(projectId).catch(() => null) : null;

  // ── Signature skip — unchanged inputs ⇒ no LLM spend, no content rewrite ──
  const signature = computeDigestSignature({ status, stats, attentionItems: cappedAttention, goalProgress, etaSummary, programState, supervisorSays });
  if (existing?.signature === signature) {
    // …but STILL touch the row: the frontend's >2.5h "stale" badge keys off
    // updatedAt, and a quiet bucket (same signature for hours) would cry wolf
    // without this. @updatedAt refreshes automatically; summary/attentionItems/
    // stats/signature are NOT rewritten.
    await prisma.projectDigest.update({ where: { id: existing.id }, data: { windowStart, windowEnd } });
    return;
  }

  // Review 2026-09-13 issue 16: goals are project-scoped — the UNGROUPED bucket
  // (projectId null) can never track one, so it keeps the plain activity voice.
  const summary = await summarizeDigest(projectName, status, stats, cappedAttention, goalProgress, etaSummary, programState, projectId !== null, supervisorSays);
  const data = {
    status,
    summary,
    attentionItems: cappedAttention as any,
    goalProgress: goalProgress as any,
    // Program-truth reader (P7 G16) — String? column: plain null is fine.
    programState,
    // Prisma nullable-Json contract: JS null is rejected at runtime — DbNull
    // keeps "no goals tracked" as an SQL NULL the API maps back to null.
    etaSummary: (etaSummary ?? Prisma.DbNull) as any,
    // generatedAt rides INSIDE the stats JSON (no schema change): the moment
    // this summary text was actually written. The signature-skip touch above
    // never rewrites it, so the API can report honest generation time while
    // updatedAt keeps moving for the frontend's stale badge. It is stamped
    // AFTER the signature is computed, so it never perturbs the skip.
    stats: { ...stats, generatedAt: new Date().toISOString() } as any,
    signature,
    windowStart,
    windowEnd,
  };
  if (existing) {
    await prisma.projectDigest.update({ where: { id: existing.id }, data });
    return;
  }
  try {
    await prisma.projectDigest.create({ data: { userId, projectId: projectId ?? null, ...data } });
  } catch (err: any) {
    // Converge on a concurrent creator (the unique / partial-unique indexes make
    // the loser throw P2002): retry as an update of the winner's row.
    if (err?.code !== 'P2002') throw err;
    const winner = await prisma.projectDigest.findFirst({
      where: { userId, projectId: projectId ?? null },
      select: { id: true },
    });
    if (winner) await prisma.projectDigest.update({ where: { id: winner.id }, data });
  }
}

// ── User sweep ────────────────────────────────────────────────────────────────

async function digestUser(userId: string, windowStart: Date, windowEnd: Date): Promise<void> {
  const [chats, projects, hidden, pendingConfirmations] = await Promise.all([
    prisma.crossModelChat.findMany({
      // Archived chats — and chats riding in an archived folder — leave the
      // digest buckets (archive = de-clutter). Un-stamped DESCENDANTS of an
      // archived folder still bucket here; getProjectDigests hides their rows
      // at render time via the same path-prefix idiom.
      where: {
        userId,
        archivedAt: null,
        OR: [{ projectId: null }, { project: { archivedAt: null } }],
        // Ghost mode (owner 2026-10-22): a ghost chat never surfaces in the
        // cross-chat project digest (its title is the user's own; the digest
        // is a cross-chat view).
        ghostMode: false,
      },
      // Project-supervisor preflight 2026-09-14: carry the lane flag so the
      // bucket can surface the project supervisor's own note.
      select: { id: true, title: true, projectId: true, isProjectSupervisor: true },
    }),
    prisma.crossModelProject.findMany({
      // Archived folders stop producing digest buckets; their ghost rows retire
      // on this same run (the sweep's ghost-row cleanup), and getProjectDigests
      // hides any stale ones meanwhile.
      where: { userId, archivedAt: null },
      select: { id: true, name: true, supervised: true, isUserSpace: true },
    }),
    getSidebarHiddenFleetArtifacts(userId),
    // Live decisions awaiting the user (durable leg) — ONE query per user;
    // each bucket keeps only the rows whose chatId it owns.
    prisma.pendingConfirmation.findMany({
      where: { userId, status: 'pending', expiresAt: { gt: windowEnd } },
      select: { chatId: true, summary: true, createdAt: true },
    }),
  ]);
  const hiddenChatIds = new Set(hidden.chatIds);
  const hiddenProjectIds = new Set(hidden.projectIds);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  // Supervision opt-out: chats of UNSUPERVISED projects never enter a digest
  // bucket — with no bucket materializing, the ghost-row cleanup below retires
  // that project's digest row naturally on this same run.
  const unsupervisedProjectIds = new Set(projects.filter((p) => p.supervised === false).map((p) => p.id));
  // User Space (P3 §3): chats filed in the owner's hidden user-space project
  // digest as UNGROUPED — the digest surface doesn't change with auto-filing.
  // The bucket key is translated BEFORE the hidden/unsupervised filters: the
  // space is deliberately supervised:false, so without the translation EVERY
  // auto-filed chat would silently drop out of the digest.
  const userSpaceProjectIds = new Set(projects.filter((p) => p.isUserSpace).map((p) => p.id));

  // Bucket by projectId (null bucket = UNGROUPED), hidden artifacts excluded.
  const buckets = new Map<string | null, BucketChat[]>();
  for (const c of chats) {
    if (hiddenChatIds.has(c.id)) continue;
    const bucketProjectId = c.projectId && userSpaceProjectIds.has(c.projectId) ? null : c.projectId;
    if (bucketProjectId && hiddenProjectIds.has(bucketProjectId)) continue;
    if (bucketProjectId && unsupervisedProjectIds.has(bucketProjectId)) continue;
    const key = bucketProjectId ?? null;
    const list = buckets.get(key) ?? [];
    list.push(c);
    buckets.set(key, list);
  }

  for (const [projectId, bucketChats] of buckets) {
    try {
      await digestBucket({
        userId,
        projectId,
        projectName: projectId ? projectName.get(projectId) ?? 'Unknown project' : 'Ungrouped',
        chats: bucketChats,
        pendingConfirmations,
        windowStart,
        windowEnd,
      });
    } catch (err: any) {
      logger.warn(`project-digest: bucket ${userId}/${projectId ?? 'ungrouped'} failed (sweep continues): ${err?.message ?? err}`);
    }
  }

  // Ghost-row cleanup: digest rows whose projectId has no bucket THIS run
  // (project went chat-less, every chat moved elsewhere) would sit stale
  // forever — project/user deletion cascades, but those don't. Null-safe: the
  // UNGROUPED (projectId null) row is kept only while a null bucket exists.
  const bucketKeys = [...buckets.keys()];
  const { count } = await prisma.projectDigest.deleteMany({
    where: {
      userId,
      ...(bucketKeys.length > 0 ? { NOT: bucketKeys.map((projectId) => ({ projectId })) } : {}),
    },
  });
  if (count > 0) logger.info(`project-digest: removed ${count} ghost digest row(s) for user ${userId}`);
}

// ── Entry point (the worker cron handler) ─────────────────────────────────────

/**
 * ONE hourly digest sweep — the unit the worker's durable cron claims and fires
 * (`project-digest`, intervalSec 3600). Discovers users with trailing-1h
 * activity (messages or agent runs), then regenerates each of their project
 * buckets. Top-level errors PROPAGATE (the cron loop records lastStatus);
 * per-user and per-bucket errors are caught + logged here.
 *
 * Fairness + lease safety: users are processed in a STABLE sorted order,
 * rotated by the sweep hour, so the user-cap slice and the time-budget cutoff
 * defer a DIFFERENT tail each firing instead of silently starving the same
 * accounts forever; the sweep stops cleanly at SWEEP_TIME_BUDGET_MS (before
 * the cron lease could expire and hand a duplicate sweep to another worker).
 */
export async function runProjectDigestOnce(): Promise<void> {
  const sweepStartMs = Date.now();
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - DIGEST_WINDOW_MS);

  // Ack-silence graveyard prune: only rows whose snooze LAPSED >30 days ago.
  // Pruning on createdAt deleted ACTIVE silences (review 2026-08-16): a snooze
  // refreshed on day 29 was deleted on day 30 despite its future expiry, and
  // "acknowledged indefinitely" rows (snoozeUntil NULL — the advertised
  // semantics) silently expired every 30 days. NULL rows are never age-pruned;
  // SQL lt-comparison excludes them naturally. Runs FIRST so neither the
  // no-active-users early return nor the time budget can starve it; wrapped so
  // a prune hiccup can never kill the digest run.
  try {
    const { count } = await prisma.digestItemAck.deleteMany({
      // windowEnd (captured at sweep start) instead of a fresh Date.now(): the
      // sweep's budget accounting pins Date.now's call sequence.
      where: { snoozeUntil: { lt: new Date(windowEnd.getTime() - ACK_PRUNE_AGE_MS) } },
    });
    if (count > 0) logger.info(`project-digest: pruned ${count} digest-item ack(s) older than 30 days`);
  } catch (err: any) {
    logger.warn(`project-digest: ack prune failed (sweep continues): ${err?.message ?? err}`);
  }

  // Users with ANY message or agent-run activity in the window.
  const [activeChats, activeRuns] = await Promise.all([
    prisma.crossModelChat.findMany({
      where: { chatMessages: { some: { createdAt: { gte: windowStart } } } },
      select: { userId: true },
    }),
    prisma.agentRun.findMany({
      where: { OR: [{ createdAt: { gte: windowStart } }, { finishedAt: { gte: windowStart } }, { heartbeatAt: { gte: windowStart } }] },
      select: { state: { select: { userId: true } } },
    }),
  ]);
  const allUserIds = [
    ...new Set([
      ...activeChats.map((c) => c.userId),
      ...activeRuns.map((r) => r.state?.userId).filter((id): id is string => !!id),
    ]),
  ].sort();

  // Liveness touch for QUIET accounts: activity discovery means a user with no
  // trailing-1h messages/runs never enters the sweep, so their rows' updatedAt
  // froze and the dashboard's stale badge cried "pipeline may be behind" on
  // every idle project after 2.5 quiet hours (the badge's documented contract —
  // digest-freshness.ts — is that updatedAt moves every sweep). Touch the
  // buckets this firing will NOT process; processed buckets get theirs via the
  // signature-skip touch or a full rewrite. Wrapped: a touch hiccup must never
  // kill the sweep. (Placed BEFORE the no-active-users early return.)
  try {
    await prisma.projectDigest.updateMany({
      where: allUserIds.length > 0 ? { userId: { notIn: allUserIds } } : {},
      data: { updatedAt: windowEnd },
    });
  } catch (err: any) {
    logger.warn(`project-digest: quiet-bucket liveness touch failed (sweep continues): ${err?.message ?? err}`);
  }

  if (allUserIds.length === 0) return;
  if (allUserIds.length > MAX_USERS_PER_SWEEP) {
    logger.warn(
      `project-digest: ${allUserIds.length} active users exceed the ${MAX_USERS_PER_SWEEP}-user cap — ` +
        `${allUserIds.length - MAX_USERS_PER_SWEEP} deferred this sweep (rotation cycles who goes first)`,
    );
  }
  // Rotate the sorted order by the sweep's hour-since-epoch: consecutive
  // hourly firings start one position further along, so every user is reached
  // within `allUserIds.length` firings even under the cap/budget.
  const rotation = Math.floor(windowEnd.getTime() / 3_600_000) % allUserIds.length;
  const userIds = [...allUserIds.slice(rotation), ...allUserIds.slice(0, rotation)].slice(
    0,
    MAX_USERS_PER_SWEEP,
  );

  let digested = 0;
  let deferred = 0;
  for (let i = 0; i < userIds.length; i++) {
    if (Date.now() - sweepStartMs >= SWEEP_TIME_BUDGET_MS) {
      deferred = userIds.length - i;
      logger.warn(
        `project-digest: time budget (${SWEEP_TIME_BUDGET_MS}ms) reached — ` +
          `deferring ${deferred} user(s) to the next sweep`,
      );
      break;
    }
    const userId = userIds[i];
    try {
      await digestUser(userId, windowStart, windowEnd);
      digested++;
    } catch (err: any) {
      logger.warn(`project-digest: user ${userId} failed (sweep continues): ${err?.message ?? err}`);
    }
  }
  logger.info(
    `project-digest: sweep complete — ${digested}/${userIds.length} user(s) digested` +
      (deferred > 0 ? `, ${deferred} deferred (time budget)` : ''),
  );
}

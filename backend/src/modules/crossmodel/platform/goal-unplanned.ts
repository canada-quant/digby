/**
 * GOAL UNPLANNED (architecture review #6, 2026-10-20) — the pure leaf.
 *
 * Why: an ACTIVE goal with zero open (non-dropped) todos had nothing telling
 * anyone it needed a plan. The Project Pulse mapped "remaining ≤ 0" to class
 * 'done' and rendered "all tasks done" — while the goal was still open
 * (remaining EXCLUDES dropped todos, and maybeAutoCompleteGoal refuses to
 * close an all-dropped goal — the two contradicted each other); the [BOARD]
 * showed a plain '[active]' line; no sweep woke the project supervisor. A
 * goal whose last todo landed with its outcome still open (or whose todos were
 * all dropped, or that was never decomposed) simply sat.
 *
 * The four parts (kill switch GOAL_UNPLANNED_SIGNAL_DISABLED=1 for parts 1-3,
 * read per call; part 4 is GOAL_TRANSITION_METRICS_DISABLED in goals.service):
 *  1. fleet/project-digest computeGoalEta: class 'unplanned' ("no open tasks —
 *     needs a plan"); the rollup treats it like no_movement.
 *  2. board-digest goal lines: '· todos <open> open/<done> done' + 'UNPLANNED'.
 *  3. fleet/unplanned-goals.service detectUnplannedGoals (attention-watchdog
 *     sub-sweep): ONE '[GOAL UNPLANNED]' wake per goal per 24 h to the
 *     project supervisor when no lane chartered to it ran in the last 6 h.
 *  4. goal_transition / todo_transition loop_metrics (goals.service).
 *
 * Pure leaf (imports two pure leaves only) — fleet/project-digest must never
 * load config/redis through it.
 */

import { holdTokenIn } from './goal-done-suspect';
import { progressNoteLead } from './progress-note';

/** GOAL_UNPLANNED_SIGNAL_DISABLED=1 — no 'unplanned' class, no board counts / tag, no [GOAL UNPLANNED] wake. Read per call. */
export const goalUnplannedSignalDisabled = (): boolean => process.env.GOAL_UNPLANNED_SIGNAL_DISABLED === '1';

/**
 * Is this goal UNPLANNED — ACTIVE, zero open (pending / in_progress /
 * blocked) todos, and its progress note does not lead with a hold (a held
 * goal is waiting on purpose)? Blocked / done / archived goals never are.
 * Pure.
 */
export function isUnplannedGoal(goal: { status?: string | null; progressNote?: string | null }, openTodos: number): boolean {
  if (!goal || goal.status !== 'active') return false;
  if (!(Number(openTodos) === 0)) return false;
  return !holdTokenIn(progressNoteLead(goal.progressNote ?? null));
}

/** Part 3: a goal younger than this is never "unplanned" for the wake — its creator is still decomposing it. */
export const GOAL_UNPLANNED_MIN_AGE_MS = 60 * 60 * 1000;
/** Part 3: a lane chartered to the goal (or assigned one of its todos) that ran this recently means the goal is being worked. */
export const GOAL_UNPLANNED_LANE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Part 3: one wake per goal per this window (Redis NX) — the FIRST window of the backoff below. */
export const GOAL_UNPLANNED_DEDUPE_SEC = 24 * 60 * 60;
export const goalUnplannedWakeKey = (goalId: string): string => `goal-unplanned:wake:${goalId}`;
export const GOAL_UNPLANNED_WAKE_PREFIX = '[GOAL UNPLANNED]';

// ── Review fix (2026-10-20): bounded wakes ─────────────────────────────────────
//
// [GOAL UNPLANNED] direct wakes are alarm-class (they bypass the machine-run
// cap), and the first cut re-armed every 24 h forever with no first-deploy
// ramp: the first sweep would wake every supervisor once per pre-existing
// unplanned goal, and a north-star goal a supervisor deliberately leaves
// without todos would cost one paid wake per day indefinitely.
//  - RAMP: for GOAL_UNPLANNED_WAKE_RAMP_MS after the sweep first runs
//    (Redis SET NX stamp; an unreadable stamp counts as "in ramp"), candidates
//    are recorded (goal_unplanned outcome 'ramp', once per goal per 24 h) and
//    never woken — the directive-age posture.
//  - BACKOFF: consecutive wakes on a goal whose todo set did not move
//    (goalUnplannedTodoFingerprint) stretch the window 24 h → 72 h → 7 d, and
//    after GOAL_UNPLANNED_MAX_STREAK_WAKES the goal stays on the board's
//    UNPLANNED tag only, until its todos change (a created / closed / dropped
//    todo resets the streak) or the streak record lapses (30 d).

/** First-deploy ramp: no [GOAL UNPLANNED] wake for this long after the sweep first runs. */
export const GOAL_UNPLANNED_WAKE_RAMP_MS = 48 * 60 * 60 * 1000;
/** The sweep's first-run stamp (SET NX; a lost key re-arms one ramp — fail-quiet). */
export const GOAL_UNPLANNED_LIVE_SINCE_KEY = 'goal-unplanned:live-since';
export const GOAL_UNPLANNED_LIVE_SINCE_TTL_SEC = 400 * 24 * 3600;
/** One 'ramp' row per goal per this window. */
export const goalUnplannedRampKey = (goalId: string): string => `goal-unplanned:ramp:${goalId}`;
/** The dedupe window AFTER the n-th consecutive wake on an unchanged goal (index n - 1). */
export const GOAL_UNPLANNED_BACKOFF_SEC: readonly number[] = [GOAL_UNPLANNED_DEDUPE_SEC, 72 * 60 * 60, 7 * 24 * 60 * 60];
/** Wakes per unchanged-goal streak; after this the board's UNPLANNED tag is the only signal. */
export const GOAL_UNPLANNED_MAX_STREAK_WAKES = 3;
export const goalUnplannedStreakKey = (goalId: string): string => `goal-unplanned:streak:${goalId}`;
export const GOAL_UNPLANNED_STREAK_TTL_SEC = 30 * 24 * 3600;

/** The window to arm WITH the next wake, given how many wakes this streak already sent. Pure. */
export function goalUnplannedBackoffSec(priorWakes: number): number {
  const n = Math.max(0, Math.floor(Number(priorWakes) || 0));
  return GOAL_UNPLANNED_BACKOFF_SEC[Math.min(n, GOAL_UNPLANNED_BACKOFF_SEC.length - 1)];
}

/** The goal's todo-set fingerprint ("total:done:dropped") — a streak survives only while it is unchanged. Pure. */
export function goalUnplannedTodoFingerprint(todos: Array<{ status?: string | null }> | null | undefined): string {
  const rows = Array.isArray(todos) ? todos : [];
  return `${rows.length}:${rows.filter((t) => t?.status === 'done').length}:${rows.filter((t) => t?.status === 'dropped').length}`;
}

export interface GoalUnplannedStreak { n: number; fp: string; at?: string }

/** Parse a stored streak; a missing / unreadable / different-fingerprint record is a fresh streak (n 0). Pure. */
export function goalUnplannedPriorWakes(raw: unknown, currentFp: string): number {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!v || typeof v !== 'object' || (v as any).fp !== currentFp) return 0;
    const n = Number((v as any).n);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

const clip = (s: unknown, n = 90): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The part-3 wake text (design: '[GOAL UNPLANNED] goal <title>: no open todos. Create the next todo (with budget + criterion), close with evidence, or block with a kind + reason.'). Pure. */
export function renderGoalUnplannedWake(input: { goalId: string; title: string | null | undefined; doneTodos: number; droppedTodos: number; now?: Date }): string {
  const now = input.now ?? new Date();
  const counts = `${input.doneTodos} done${input.droppedTodos ? `, ${input.droppedTodos} dropped` : ''}`;
  return `${GOAL_UNPLANNED_WAKE_PREFIX} goal "${clip(input.title)}" (${String(input.goalId).slice(0, 8)}): no open todos (${counts}). ` +
    'Create the next todo (with budget + criterion), close with evidence, or block with a kind + reason.\n' +
    'Re-read it with goal_get first and act on its CURRENT state — a todo created since this wake was sent means nothing is missing. ' +
    `(harness-measured: no lane chartered to it ran in the last ${Math.round(GOAL_UNPLANNED_LANE_WINDOW_MS / 3_600_000)} h; wake sent ${now.toISOString()})`;
}

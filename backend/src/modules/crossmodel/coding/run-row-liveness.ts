/**
 * WHAT A ZERO-ROW HEARTBEAT ACTUALLY MEANS (ticket 65af5656, 2026-11-03).
 *
 * `run-executor`'s lease-refresh interval calls `heartbeatAgentRun(runId)`,
 * which is an `updateMany({ where: { id, status: 'running' }, … })`. Its return
 * value is therefore **the number of rows that are RUNNING right now** — not
 * the number of rows that EXIST. The zombie guard (FO firing 46, chat
 * 5a87b912: a chat deleted mid-run left the executor running ~90 min of real
 * GitHub actions with every FK write failing) reads `count === 0` as "the chat
 * and its row were deleted" and cancels the execution through the Stop-release
 * path. That inference is only valid for ONE of the ways a count can be 0.
 *
 * The observed failure (2026-11-03T09:15:44.96–45.03Z, 8 lanes, 64
 * `zombie_run_stopped` rows in ~50 ms): the count went to 0 for eight lanes at
 * once, and the guard hard-cancelled all of them at the same instant. Both
 * affected lanes finalized "(Stopped.)" 250 ms apart with
 * `continuation_suppressed{reason:'stopped'}` — the stop guard then refused to
 * queue a continuation, so each lane cost a supervisor wake to resume
 * (ticket 65af5656 / family deploy-kills-lane-background-workers).
 *
 * WHAT THIS FILE DOES *NOT* CLAIM. Which single actor moved those rows off
 * 'running' is NOT established here, and two candidate mechanisms were checked
 * and ruled out or left open rather than asserted:
 *   - boot `reconcileOrphanedRuns` (running → interrupted) CANNOT do it to a
 *     live lane: it only flips rows whose lease has expired, whose heartbeat is
 *     older than RUN_STALE_MS (10 min), or that never beat — while a live lane
 *     renews a 6-minute lease every 2.5 min (run-state.ts).
 *   - a satellite strip / terminal finalize elsewhere in the fleet only ever
 *     filters `status: 'queued'` rows, so it cannot move a live one either.
 * The defect does not depend on naming the actor: `count === 0` is simply not
 * evidence of absence, and that is the inference this module replaces. If a
 * future session needs the actor, it must be proven from the rows (agent_runs
 * audit columns), never inferred from this comment.
 *
 * The distinction this module draws, from the row itself:
 *
 *   - `row_gone`     — no row with that id exists at all. The original hazard
 *                      is real (every later write fails the FK); cancel it.
 *   - `resumable`    — the row exists and is ALREADY 'interrupted': something
 *                      marked it for resume. This run is not a zombie — it is a
 *                      hand-off. Release it as a SHUTDOWN interrupt so the
 *                      finalizer keeps the checkpoint ('interrupted',
 *                      attempt-neutral, re-claimable) instead of recording a
 *                      terminal stop that suppresses continuation.
 *   - `not_running`  — the row exists under any other status (completed by a
 *                      racing finalize, cancelled, re-queued by a backoff). The
 *                      run must NOT be cancelled from the heartbeat: a status
 *                      mismatch is not evidence of a deleted chat.
 *
 * Fail-open doctrine: an unreadable row is `unknown` — the caller does nothing
 * this interval and re-checks on the next one. Never cancel on a failed read.
 */

/** What the durable row says about this run, given a 0-row heartbeat. */
export type RunRowVerdict = 'row_gone' | 'resumable' | 'not_running' | 'unknown';

/**
 * Pure: classify a zero-touch heartbeat by reading the durable row back.
 * `row` is the `select`ed row (id + status) or null when no such id exists.
 * `readFailed` marks a thrown read — never a verdict of absence.
 */
export function classifyZeroHeartbeat(row: { status?: string | null } | null, readFailed = false): RunRowVerdict {
  if (readFailed) return 'unknown';
  if (!row) return 'row_gone';
  const status = String(row.status ?? '').trim();
  if (status === 'interrupted') return 'resumable';
  return 'not_running';
}

/**
 * How many CONSECUTIVE zero-touch heartbeats of a genuine `row_gone` it takes
 * before the execution is cancelled. Absence is unambiguous, but the FK hazard
 * the guard exists for costs ~90 min of runaway writes while one extra 2.5-min
 * interval costs almost nothing — and a single missed beat caused by a pool
 * hiccup or a concurrent statement's visibility never gets a chance to kill a
 * healthy lane again. Env-tunable for an operator who wants the old 1-strike
 * behaviour back without a deploy.
 */
export function zombieConfirmMisses(): number {
  const raw = parseInt(String(process.env.ZOMBIE_RUN_STOP_CONFIRM_MISSES ?? ''), 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 2;
}

/** The `zombie_run_stopped` meta `reason` for each verdict — one telemetry
 *  vocabulary so an operator can chart confirms vs. stand-downs vs. hand-offs. */
export function zombieStopReason(v: RunRowVerdict): string {
  if (v === 'row_gone') return 'run_row_gone';
  if (v === 'resumable') return 'run_row_interrupted_handoff';
  if (v === 'not_running') return 'run_row_not_running';
  return 'run_row_read_failed';
}

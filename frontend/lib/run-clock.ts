/**
 * Reopening a chat mid-reply (owner 2026-10-08: "i asked this and then moved to a new chat then reopened but it is
 * not showing where it was in the streaming steps"). The re-attach replays the run's buffered frames, each stamped
 * with the SERVER time it was sent (`ts`, ISO). Two things went wrong on the client:
 *   - the run clock was mounted at Date.now() on attach, so it restarted from 0:00 — replayedRunStart() turns a
 *     replayed frame's `ts` into the run's real start (the earliest one wins in CodeSessionView);
 *   - the 300 ms status throttle kept only the first and last line of the replayed burst, so the step list lost
 *     every earlier step — while the replay gate is open each status line is applied (CodeSessionView).
 */

/** A replayed frame's server timestamp as ms, or null when absent, unreadable or in the future (clock skew). */
export function replayedRunStart(ts: string | undefined | null, now: number = Date.now()): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms) || ms > now) return null;
  return ms;
}

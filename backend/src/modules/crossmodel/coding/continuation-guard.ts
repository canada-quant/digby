/**
 * STOP MEANS STOP (2026-09-29 — TB 2.1 v3b bench diagnosis).
 *
 * The unfinished-work backstop (run-executor.ts) queues a
 * `[HARNESS CONTINUATION rN/6]` run whenever a MACHINE run ends with open plan
 * steps. It never asked WHY the run ended: a run the user / an API client / a
 * supervisor STOPPED came back ~45 s later as round 1, and each later stop
 * queued the next round, up to six. On the TB 2.1 v3b bench every timed-out
 * trial was stopped by the adapter, so 92 of 98 continuations were created at
 * the instant a stopped run finished — on ARCHIVED sessions — and they used
 * more worker slot-hours than the real trials (13.3 vs 9.6). Production sees
 * the same path rarely (one continuation after a cancelled run in 7 days).
 *
 * Rules (each fail-open — a read error never drops a real resumption):
 *   - a run ended by an explicit stop queues NO continuation ('stopped');
 *   - a run cut by a graceful deploy (SIGTERM) queues none either — the
 *     interrupted row itself resumes from its checkpoint ('shutdown');
 *   - an ARCHIVED session never gets a continuation, at queue time or at
 *     claim time ('archived');
 *   - a Stop also cancels the session's QUEUED continuation rows, so the
 *     follow-up a finished run already queued cannot restart the lane.
 *
 * Telemetry: loop_metrics `continuation_suppressed {reason, seam, origin?}`.
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';

/**
 * 'awaiting_condition' (MERGE-INTENT-AWAIT, 2026-10-20): the run ended because
 * await_condition registered a CONDITION WAKE — the harness wakes the chat when
 * the condition is met (backstop at its horizon); a continuation would only
 * poll again. Not part of the stop guard (it has its own switch:
 * AWAIT_CONDITION_DISABLED=1 means no run ever ends this way).
 */
export type ContinuationSuppressReason = 'stopped' | 'shutdown' | 'archived' | 'awaiting_condition';

/** The marker every harness continuation prompt starts with (plan.service continuationPrompt). */
export const HARNESS_CONTINUATION_MARKER = '[HARNESS CONTINUATION';

/**
 * Pure: why the backstop must NOT queue a continuation for this run end, or
 * null when it may. Order matters: a deploy interrupt also trips the loop's
 * cancel flag, so 'shutdown' is checked before 'stopped'.
 */
export function continuationSuppressReasonFor(s: {
  shutdownInterrupted: boolean;
  cancelled: boolean;
  archived: boolean;
}): ContinuationSuppressReason | null {
  if (s.shutdownInterrupted) return 'shutdown';
  if (s.cancelled) return 'stopped';
  if (s.archived) return 'archived';
  return null;
}

/**
 * The honest line appended to the unfinished-work note when no continuation
 * is queued. null for 'shutdown': that run is not over — it resumes from its
 * checkpoint, so no note belongs in its transcript.
 */
export function suppressedContinuationNote(reason: ContinuationSuppressReason): string | null {
  if (reason === 'stopped') return 'No continuation queued — the run was stopped, and a stop means stop. Send a message to resume the remaining steps.';
  if (reason === 'archived') return 'No continuation queued — the session is archived.';
  if (reason === 'awaiting_condition') return 'No continuation queued — this run is waiting on a registered condition wake (await_condition); the harness wakes this chat when the condition is met.';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zero-mutation continuation streak (ticket 9a76855d, 2026-10-01)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Ticket lane 51c27a87 spent its ENTIRE 6-round continuation budget
 * (r0–r5/6, ~01:30Z, ticket 9a76855d) in an analysis loop with ZERO file
 * edits: every run re-read the same banked spec from session memory, got
 * compacted, lost context, re-read it, and ended "analysis-only". The banked
 * design was fine — the lane never reached its first edit_file call. A
 * streak of N consecutive continuation rounds with ZERO FILE MUTATIONS on a
 * still-unfinished board means auto-continuation is feeding the loop, so the
 * backstop stops queueing and wakes the supervisor instead.
 *
 * The streak rides the continuation prompt itself (same channel as the
 * rN/6 round marker) — no DB migration: continuationPrompt appends
 * `[zero-edit streak: K]`, each continuing run's backstop parses it, adds
 * 1 when the ending run also made zero file edits, and the threshold check
 * is pure. A USER-origin run never INCREMENTS the streak (interactive Q&A
 * on an open board must not manufacture stops) and any edit resets it to 0.
 *
 * Threshold default 3 (tolerates one legit pre-edit analysis round plus one
 * heavy re-read round before stopping): env CONTINUATION_ZERO_MUTATION_MAX_ROUNDS.
 * Telemetry: loop_metrics
 * `continuation_suppressed {reason:'zero_mutation_streak', seam:'backstop'}`.
 */

/** Tools whose dispatch genuinely mutates a file in the worktree. */
export const MUTATING_FILE_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'edit_file', 'ast_rewrite',
]);

/**
 * The prompt token carrying the zero-edit streak between rounds
 * (plan.service continuationPrompt → backstop parse). Plain text, not a
 * regex, so the schedule fire-time rewrite regex stays untouched.
 */
export const ZERO_EDIT_STREAK_TOKEN = '[zero-edit streak:';

/** Max consecutive zero-file-edit continuation rounds before force-stop. */
export function continuationZeroMutationMaxRounds(): number {
  const raw = parseInt(String(process.env.CONTINUATION_ZERO_MUTATION_MAX_ROUNDS ?? ''), 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 3;
}

/**
 * Pure: parse the zero-edit streak baked into an incoming continuation
 * prompt. 0 when absent (a first continuation / legacy prompt carries no
 * token). Never throws — a malformed token reads as 0 (fail-open: queue the
 * continuation; the streak rebuilds from this round's own behaviour).
 */
export function parseZeroEditStreak(message: string | undefined | null): number {
  const m = String(message ?? '').match(/\[zero-edit streak: (\d+)\]/);
  return m ? parseInt(m[1], 10) || 0 : 0;
}

/**
 * Pure: the streak carried into the NEXT round's prompt given this run's own
 * file-mutation count. An editing run resets the streak to 0; a zero-edit
 * MACHINE run increments by 1. A USER-origin run is neutral (carries the
 * parsed streak unchanged — interactive Q&A on an open board must neither
 * manufacture stops nor falsely reset an ongoing machine streak... but a
 * human turn legitimately resets it: they saw the board and chose to continue).
 * Cap note: the streak never grows past the round cap's reach in practice
 * (r6/6 ends the chain); a hand-crafted prompt with a huge baked streak
 * stops at the first zero-edit round — conservative, never unbounded.
 */
export function nextZeroEditStreak(parsedStreak: number, fileMutations: number, origin: string): number {
  if (fileMutations > 0) return 0;
  if (origin === 'user') return parsedStreak;
  return parsedStreak + 1;
}

/**
 * Pure: whether the backstop must NOT queue another auto-continuation
 * because the zero-edit streak has exhausted the threshold.
 */
export function zeroMutationSuppressReason(streak: number): 'zero_mutation_streak' | null {
  return streak >= continuationZeroMutationMaxRounds() ? 'zero_mutation_streak' : null;
}

/**
 * The honest line appended to the unfinished-work note when the streak stops
 * the auto-continuation. Tells the lane (and the supervisor reading the
 * transcript) exactly what to do instead.
 */
export function zeroMutationSuppressNote(streak: number, round: number): string {
  return `No continuation queued — the last ${streak} consecutive continuation round(s) produced ZERO file edits while plan steps stayed open (through round r${Math.max(round - 1, 0)}/6). The banked design is fine; the loop was re-reading instead of editing. Send a message (or steer the lane) to resume with an edits-first instruction.`;
}

/** Fail-open archived read: a DB hiccup reads as "not archived". */
export async function isSessionArchived(sessionId: string): Promise<boolean> {
  try {
    const row = await (prisma as any).crossModelChat.findUnique({ where: { id: sessionId }, select: { archivedAt: true } });
    return !!row?.archivedAt;
  } catch {
    return false;
  }
}

/** True when a run's input is a harness continuation (the prompt marker). */
export function isContinuationInput(input: unknown): boolean {
  return String((input as any)?.message ?? '').includes(HARNESS_CONTINUATION_MARKER);
}

/**
 * Cancel every QUEUED harness-continuation row of a session. The update is
 * conditional on status 'queued', so a row a worker claimed a moment earlier
 * is left to the cooperative cancel instead of being clobbered. Returns the
 * ids actually cancelled; never throws.
 */
export async function cancelQueuedContinuations(sessionId: string, why: string): Promise<string[]> {
  try {
    const rows: Array<{ id: string; input: unknown }> = await (prisma as any).agentRun.findMany({
      where: { sessionId, status: 'queued' },
      select: { id: true, input: true },
    });
    const ids = rows.filter((r) => isContinuationInput(r.input)).map((r) => r.id);
    if (!ids.length) return [];
    const cancelled: string[] = [];
    for (const id of ids) {
      const res = await (prisma as any).agentRun.updateMany({
        where: { id, status: 'queued' },
        data: { status: 'cancelled', finishedAt: new Date(), error: String(why).slice(0, 500) },
      });
      if (res?.count) cancelled.push(id);
    }
    if (cancelled.length) logger.info(`continuation-guard: cancelled ${cancelled.length} queued continuation run(s) on session ${sessionId.slice(0, 8)} (${why})`);
    return cancelled;
  } catch (err: any) {
    logger.warn(`continuation-guard: queued-continuation cancel failed for session ${sessionId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`);
    return [];
  }
}

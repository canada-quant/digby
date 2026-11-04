/**
 * Transient per-turn harness messages (ticket 63e9a3cb review B1).
 *
 * The agent loop pushes TRANSIENT system messages before each model turn
 * and splices them out right after: the [HARNESS CLOCK] note (a fresh per-turn
 * clock), the <plan> reminder (renderPlanReminder / the no-plan nudge), and
 * the [EVIDENCE LEDGER] note (feedback a84cc306 — the harness-maintained
 * per-run EVIDENCE LIST re-injected on machine-wake chat-lane turns).
 * They must never be persisted. The pre-fix checkpoint path passed the LIVE
 * messages array into an asynchronously-serializing executor closure, so a
 * checkpoint captured them whenever the model turn outlasted the git snapshot
 * — and the resume replay then rehydrated them wholesale: a STALE clock note
 * permanently mid-transcript, instructing citation of a stale "now" (the exact
 * failure class the note exists to kill), plus a persistent mid-conversation
 * system message per interruption cycle.
 *
 * The checkpoint path now snapshots the array at call time, but checkpoints
 * written by the OLD code stay poisoned — the resume replay strips these
 * shapes so old checkpoints heal on their next resume.
 */

import { EVIDENCE_LEDGER_PREFIX } from '../chat-agent/evidence-ledger';

/**
 * True for a transient per-turn harness message: a system-role message whose
 * text OPENS with the [HARNESS CLOCK] marker, a <plan> reminder wrapper, or
 * the [EVIDENCE LEDGER] note (a84cc306 reviewer 726f559a N3: unreachable
 * today — checkpoints snapshot pre-push/post-splice, and no per-step catch
 * persists the note — but a future edit could silently persist it; strip the
 * prefix like its sibling transients so old checkpoints heal the same way).
 * Deliberately shape-based (not index-based): the checkpoint replay is a flat
 * message list and each transient owns its whole message content. Guards:
 * user/assistant turns carrying the same markers are model CONTENT (a lane
 * quoting or imitating harness chrome), never spliced transients — kept; the
 * persistent repetition nudge ("Your previous reply started repeating…")
 * matches no listed prefix — kept.
 */
export function isTransientHarnessMessage(m: unknown): boolean {
  const msg = m as { role?: unknown; content?: unknown } | null | undefined;
  if (msg?.role !== 'system' || typeof msg.content !== 'string') return false;
  const c = msg.content.trimStart();
  return c.startsWith('[HARNESS CLOCK') || c.startsWith('<plan>') || c.startsWith(EVIDENCE_LEDGER_PREFIX);
}

/** The messages array minus its transient per-turn harness messages (order preserved). */
export function stripTransientHarnessMessages<T>(messages: T[]): T[] {
  return messages.filter((m) => !isTransientHarnessMessage(m));
}

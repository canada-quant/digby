/**
 * Stranded-steer recovery (feedback tickets 58790b7b / 6a99225c, 2026-08-26).
 *
 * A user message sent to a BUSY coding session rides the Redis steer mailbox
 * (session-run-lock.pushSteerMessage) and is consumed by the executing run at
 * each top-level step boundary (run-executor → drainSteerMessages). Two gaps
 * stranded entries indefinitely — accepted but never answered, the "messages
 * sit in queue and die silently" half of the zombie-running incident:
 *
 *  1. FINALIZE WINDOW — a steer pushed after the run's LAST step-boundary
 *     drain (during the final answer, or moments before a Stop/cancel) has no
 *     consumer once the run finalizes: the session flips 'ready', the lock is
 *     released, and the entry sits in Redis until some FUTURE run happens to
 *     start on that session and drain it. If none does, it is never answered.
 *  2. ORPHAN HEAL — when the orphan sweep (coding-data.service
 *     sweepOrphanedRunningSessions) resets a zombie 'running' session to
 *     'ready', whatever its mailbox already held was likewise stranded.
 *
 * The recovery: drain the mailbox and queue a follow-up run carrying the
 * drained content. The run is MACHINE-origin ('schedule') and deliberately
 * UNANCHORED (no userTurnAt): the sender typed DURING another run — possibly
 * before that run surfaced a confirmation prompt — so the recovered turn must
 * not launder into a user-anchored turn for pending-confirmation purposes
 * (the same doctrine as the plain-chat busy-queue drain, chat-agent.service
 * drainChatQueue).
 *
 * Best-effort end to end, never throws into a caller's finalize/sweep path:
 * losing the busy gate (a user run or the plan-continuation won the race
 * first) re-pushes the drained batch so the winner's first step-boundary
 * drain still consumes it. Steer content runs VERBATIM as the recovered run's
 * message — the user's own words, like drainChatQueue, not wrapped in an ops
 * banner that would persist as if the user typed it.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { queueAgentRun, SessionBusyError } from './run-state';
import { drainSteerMessages, pushSteerMessage, type SteerOrigin } from './session-run-lock';

/**
 * Drain sessionId's steer mailbox and queue the drained content as one
 * follow-up run. Returns true when a run was queued. `why` labels the call
 * site in logs ('run-finalize' | 'orphan-heal').
 */
export async function recoverStrandedSteers(sessionId: string, why: string): Promise<boolean> {
  let drained: { text: string; images: any[]; files: any[]; messageIds: string[]; entries?: Array<{ text: string; origin?: SteerOrigin; sourceChatId?: string }> } | null = null;
  try {
    drained = await drainSteerMessages(sessionId);
  } catch {
    drained = null; // a Redis hiccup degrades to "recover next pass", never a throw
  }
  if (!drained) return false;
  const text = typeof drained.text === 'string' ? drained.text : '';
  const images = Array.isArray(drained.images) ? drained.images : [];
  const files = Array.isArray(drained.files) ? drained.files : [];
  // fc7b2ca7: ids of the user transcript rows the steer path ALREADY persisted
  // eagerly for this content (one per steered message). Forwarded as
  // RunInput.existingUserMessageIds so the follow-up run ADOPTS those rows
  // instead of inserting byte-identical duplicates (2026-09-15 sighting: the
  // same triage note landed as msg 133f6923 AND msg 4e9a91e8).
  const messageIds = Array.isArray(drained.messageIds) ? drained.messageIds.filter((s): s is string => typeof s === 'string' && !!s) : [];
  // Review F1: an attachment-ONLY steer (blank text + images/files — the
  // controller accepts blank-message attachment runs, and a step-boundary
  // drain injects them fine) is REAL payload: queue it like any other. Only
  // a truly EMPTY drain (no text AND no attachments) is a no-op. Anything
  // richer must NEVER be dropped here — the LPOP already destroyed the
  // mailbox copy, so dropping it would convert stranding into loss.
  if (!text.trim() && !images.length && !files.length) return false;

  // LPOP was destructive: any failure from here RE-PUSHES the drained batch so
  // the content is never lost (one merged entry preserves order + the drain's
  // attachment-cap notes verbatim — and the already-persisted row ids, so a
  // later recovery still adopts rather than duplicates).
  // audit 2026-10-08 W2-9: the merged restore keeps the sender origin when every
  // drained entry shares one (a mixed batch restores unmarked — read as the owner,
  // exactly the pre-fix framing).
  const entryOrigins = Array.isArray(drained.entries) ? drained.entries : [];
  const sharedOrigin = entryOrigins.length && entryOrigins.every((e) => e.origin && e.origin === entryOrigins[0].origin) ? entryOrigins[0].origin : undefined;
  const sharedSource = sharedOrigin && entryOrigins.every((e) => e.sourceChatId && e.sourceChatId === entryOrigins[0].sourceChatId) ? entryOrigins[0].sourceChatId : undefined;
  const restore = async (): Promise<void> => {
    await pushSteerMessage(sessionId, {
      text, images, files, ...(messageIds.length ? { messageIds } : {}),
      ...(sharedOrigin ? { origin: sharedOrigin } : {}), ...(sharedSource ? { sourceChatId: sharedSource } : {}),
    })
      .catch(() => {});
  };

  try {
    const chat = await prisma.crossModelChat.findUnique({ where: { id: sessionId }, select: { userId: true } });
    if (!chat) {
      await restore();
      return false;
    }
    await queueAgentRun(sessionId, {
      message: text,
      images,
      files,
      userId: chat.userId,
      origin: 'schedule', // machine recovery — NOT a user-anchored turn (no userTurnAt)
      ...(messageIds.length ? { existingUserMessageIds: messageIds } : {}),
    });
    logger.info(`steer recovery (${why}): queued stranded steer message(s) as a follow-up run for session ${sessionId}`);
    return true;
  } catch (err: any) {
    await restore();
    // SessionBusyError is the expected race (a user run / plan continuation won
    // the gate; its first step drains the restored mailbox) — not warn-worthy.
    if (!(err instanceof SessionBusyError)) {
      logger.warn(`steer recovery (${why}) failed for session ${sessionId} (steers restored to the mailbox): ${err?.message ?? err}`);
    }
    return false;
  }
}

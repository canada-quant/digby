/**
 * Shared staged-upload resolution policy (ticket 1aefc929 — "image attachments
 * silently fail to send"): NEVER silently deliver text-only when the caller
 * staged attachments.
 *
 *   - EVERY staged id fails to resolve (expired 15-min Redis TTL / lost) →
 *     `fatalMessage` is set: the caller must HARD-ERROR with it (an SSE 'error'
 *     event on the plain-chat stream, an AppError(410) on the fleet supervisor
 *     send) — nothing runs, nothing persists, and the sender is TOLD. The
 *     pre-fix behavior proceeded text-only with only a server-side warn — the
 *     exact silent drop behind the owner report.
 *   - SOME fail → proceed with the survivors and append
 *     attachmentDropAnnotation() to the user message (the queued-drain idiom,
 *     chat-agent.service.ts) so the model AND the transcript show the loss.
 *
 * The loader is INJECTED (never statically imported here): upload.controller's
 * import chain reaches config/redis → config/env (process.exit at import in a
 * keyless env), and several callers (fleet.service, coding-stream) deliberately
 * reach it through a DYNAMIC import — a static import from this module would
 * break that boundary. The Attachment type import is type-only (erased).
 */
import logger from '../../utils/logger';
import type { Attachment } from './upload.controller';

export interface StagedUploadResolution {
  /** Resolved (id, attachment) pairs in input order — the survivors. */
  loaded: Array<{ id: string; attachment: Attachment }>;
  /** How many staged ids failed to resolve (expired/lost). */
  droppedCount: number;
  /** Set ONLY when the caller staged uploads and EVERY one failed — the exact
   *  user-facing sentence the hard error must carry. */
  fatalMessage?: string;
}

export async function resolveStagedUploads(
  uploadIds: string[],
  loadAttachment: (id: string) => Promise<Attachment | null>,
): Promise<StagedUploadResolution> {
  if (uploadIds.length === 0) return { loaded: [], droppedCount: 0 };
  const pairs = await Promise.all(uploadIds.map(async (id) => ({ id, attachment: await loadAttachment(id) })));
  for (const { id, attachment } of pairs) {
    // Never silent server-side either: a missing attachment used to be filtered
    // out without a trace (per-instance /tmp era) — the model answered as if
    // no file was sent.
    if (!attachment) logger.warn(`resolveStagedUploads: staged uploadId ${id} resolved to nothing (expired or lost)`);
  }
  const loaded = pairs.filter((l): l is { id: string; attachment: Attachment } => l.attachment !== null);
  const droppedCount = pairs.length - loaded.length;
  const fatalMessage = loaded.length === 0
    ? (uploadIds.length === 1
      ? 'Your attachment expired before the message could run — staged uploads live about 15 minutes. Re-attach it and send again; nothing was sent.'
      : `All ${uploadIds.length} attachments expired before the message could run — staged uploads live about 15 minutes. Re-attach them and send again; nothing was sent.`)
    : undefined;
  return { loaded, droppedCount, ...(fatalMessage ? { fatalMessage } : {}) };
}

/** The honest partial-drop annotation appended to the user message (visible to
 *  the model AND in the transcript bubble) — mirrors the queued-drain idiom
 *  (chat-agent.service.ts: "[N attachment(s) expired … — please re-send …]"). */
export function attachmentDropAnnotation(dropped: number): string {
  return `[${dropped} attachment(s) expired before this message was sent — please re-send ${dropped === 1 ? 'it' : 'them'}.]`;
}

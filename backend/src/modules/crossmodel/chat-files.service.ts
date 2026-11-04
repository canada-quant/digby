/**
 * Persistent per-chat files — upload persistence (2026-08-25).
 *
 * A staged /crossmodel/upload blob lives in Redis (cm:upload:<id>) for 15 min
 * (24h when queue-pinned). The moment a send actually CONSUMES it — the SSE
 * stream path, the busy-queue drain, the fleet supervisor send, or the
 * coding-surface inline — the bytes are persisted as a durable ChatFile row so
 * the file outlives the staging TTL and stays listable/downloadable for anyone
 * with read access to the chat.
 *
 * Contracts:
 *  - IDEMPOTENT per (uploadId, chatId): the schema's unique key + upsert make
 *    a retried send or a queue-drain re-resolution a no-op (first write wins).
 *  - FIRE-AND-FORGET SAFE: this module never throws — a persistence failure
 *    logs a warning and moves on; it must NEVER fail the send it rode in on.
 *  - SKIPS when there is no authed user or no chatId (anonymous/ephemeral
 *    sends have nothing durable to attach to).
 *  - SIZE GUARD: blobs over 25MB are skipped (logged) — the Redis staging
 *    path is unchanged for them.
 *
 * Byte fidelity: images/PDFs carry base64 in the staged blob (the ORIGINAL
 * binary is persisted); documents (docx/xlsx/txt/csv/…) keep only extracted
 * text in the staging format, so their durable copy IS that text and the
 * mimeType is normalized to text/plain — served bytes must always match the
 * Content-Type the routes advertise.
 */

import prisma from '../../config/database';
import logger from '../../utils/logger';
import type { Attachment } from './upload.controller';
import { sniffMime, sniffAudioMime } from './coding/chat-images';

/** Above this many DECODED bytes a file is not persisted (logged + skipped). */
export const CHAT_FILE_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export interface LoadedUpload {
  /** The staged upload id (Redis cm:upload:<id> key suffix). */
  id: string;
  attachment: Attachment;
}

/**
 * Resolve the durable bytes + served mime for a staged attachment. Returns
 * null when the attachment carries no persistable content (neither binary nor
 * extracted text — nothing durable to store).
 */
function resolveFileBytes(attachment: Attachment): { data: Uint8Array<ArrayBuffer>; mimeType: string } | null {
  if (attachment.base64) {
    const buf = Buffer.from(attachment.base64, 'base64');
    let mimeType = attachment.mimeType
      || (attachment.type === 'pdf' ? 'application/pdf'
        : attachment.type === 'image' ? 'image/png'
          : 'application/octet-stream');
    // Defense in depth (ticket 390b6767, 2026-09-25): a staged blob stamped
    // application/octet-stream (stage_upload {worktreePath} did, for every
    // binary) is served by the inline route on THIS stored mime — a real PNG
    // 415'd. Magic bytes override a generic/absent mime; an image-typed
    // attachment with no recognizable magic keeps the image/png default.
    // Ticket 6c050917 adds the AUDIO twin: an audio-typed attachment with a
    // generic mime heals from its magic bytes (the bake-off WAV class), and
    // audio is never re-defaulted to image/png.
    if (!attachment.mimeType || /octet-stream/i.test(attachment.mimeType)) {
      const sniffed = sniffMime(buf) || sniffAudioMime(buf);
      if (sniffed) mimeType = sniffed;
      else if (attachment.type === 'image') mimeType = 'image/png';
      else if (attachment.type === 'pdf') mimeType = 'application/pdf';
      else if (attachment.type === 'audio') mimeType = 'audio/wav';
    }
    // Fresh ArrayBuffer-backed copy (Prisma Bytes is Uint8Array<ArrayBuffer>;
    // a raw Buffer's SharedArrayBuffer-typed backing doesn't satisfy it).
    const data = new Uint8Array(new ArrayBuffer(buf.length));
    data.set(buf);
    return { data, mimeType };
  }
  if (attachment.extractedText) {
    // The staging format keeps no binary for documents — the durable copy is
    // the extracted text, served as text/plain so bytes match Content-Type.
    return { data: new TextEncoder().encode(attachment.extractedText), mimeType: 'text/plain' };
  }
  return null;
}

/**
 * Persist consumed staged uploads as durable ChatFile rows. Safe to call
 * fire-and-forget (`void persistChatUploads(...)`): every failure is caught,
 * logged, and swallowed per file.
 */
export async function persistChatUploads(args: {
  chatId?: string | null;
  userId?: string | null;
  loaded: LoadedUpload[];
}): Promise<void> {
  const { chatId, userId, loaded } = args;
  if (!chatId || !userId || !loaded?.length) return;
  for (const { id, attachment } of loaded) {
    try {
      if (!id || !attachment) continue;
      const resolved = resolveFileBytes(attachment);
      if (!resolved) continue;
      const { data, mimeType } = resolved;
      if (data.length > CHAT_FILE_MAX_BYTES) {
        logger.warn(
          `ChatFile persist skipped: "${attachment.filename}" is ${(data.length / 1024 / 1024).toFixed(1)}MB ` +
          `(> ${CHAT_FILE_MAX_BYTES / 1024 / 1024}MB cap) — uploadId ${id}, chat ${chatId}`,
        );
        continue;
      }
      await prisma.chatFile.upsert({
        where: { uploadId_chatId: { uploadId: id, chatId } },
        create: {
          chatId,
          userId,
          uploadId: id,
          filename: attachment.filename,
          mimeType,
          sizeBytes: data.length,
          data,
        },
        // First write wins — a retried send / queue-drain re-resolution must
        // not duplicate or mutate the row.
        update: {},
      });
    } catch (err: any) {
      // P2002 = unique (uploadId, chatId): a concurrent persist won the race —
      // the row exists, which is exactly the desired end state.
      if (err?.code === 'P2002') continue;
      logger.warn(`ChatFile persist failed for uploadId ${id} (chat ${chatId}): ${err?.message ?? err}`);
    }
  }
}

/**
 * Read-time chip → ChatFile resolution (ticket c6e8edda): user-row attachment
 * chips (metadata.attachments) stamped at send time carry the staged uploadId;
 * the durable ChatFile row persisted at consumption holds the bytes behind the
 * Bearer-authed byte routes. This joins the two so transcripts can render
 * image chips INLINE:
 *   (a) collect every chip uploadId across the loaded messages — FULLY
 *       guarded (metadata is JSONB: a non-object message metadata, a
 *       non-array attachments value, or a non-object chip is simply not a
 *       chip list and passes through untouched);
 *   (b) ONE batched chat_files lookup keyed on the (uploadId, chatId) dedupe
 *       unique — never an N+1, and legacy transcripts (no stamps) cost ZERO
 *       queries;
 *   (c) inject fileId (+ mimeType) into matching chips, building NEW
 *       metadata/chip objects — the loaded rows are never mutated in place.
 * Chips without an uploadId or without a ChatFile match pass through
 * unchanged (graceful degradation: they keep rendering as filename chips).
 * Best-effort: a lookup failure must never fail the transcript load.
 */
export async function injectChatFileIds<T extends { metadata?: unknown }>(
  chatId: string,
  messages: T[],
): Promise<T[]> {
  // (a) Collect — deduped so one query serves any number of chipped rows.
  const uploadIds = new Set<string>();
  for (const m of messages) {
    const meta = m?.metadata;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const chips = (meta as Record<string, unknown>).attachments;
    if (!Array.isArray(chips)) continue;
    for (const chip of chips) {
      const uploadId = (chip as { uploadId?: unknown } | null)?.uploadId;
      if (typeof uploadId === 'string' && uploadId) uploadIds.add(uploadId);
    }
  }
  if (!uploadIds.size) return messages;
  try {
    // (b) ONE batched lookup — uploadId is unique per chat (the dedupe key),
    // so an uploadId maps to at most one row here.
    const files = await prisma.chatFile.findMany({
      where: { chatId, uploadId: { in: [...uploadIds] } },
      select: { id: true, uploadId: true, mimeType: true },
    });
    if (!files.length) return messages;
    const byUploadId = new Map(files.map((f) => [f.uploadId as string, f]));
    // (c) Inject — NEW objects only; unmatched chips/rows pass through by
    // identity so unchanged messages keep their exact references.
    let replaced = false;
    const out = messages.map((m) => {
      const meta = m?.metadata;
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return m;
      const chips = (meta as Record<string, unknown>).attachments;
      if (!Array.isArray(chips)) return m;
      let changed = false;
      const newChips = chips.map((chip) => {
        if (!chip || typeof chip !== 'object' || Array.isArray(chip)) return chip;
        const uploadId = (chip as { uploadId?: unknown }).uploadId;
        if (typeof uploadId !== 'string' || !uploadId) return chip;
        const file = byUploadId.get(uploadId);
        if (!file) return chip;
        changed = true;
        return { ...(chip as Record<string, unknown>), fileId: file.id, mimeType: file.mimeType };
      });
      if (!changed) return m;
      replaced = true;
      return { ...m, metadata: { ...(meta as Record<string, unknown>), attachments: newChips } };
    });
    return replaced ? out : messages;
  } catch (err: any) {
    logger.warn(`injectChatFileIds failed (chat ${chatId}): ${err?.message ?? err}`);
    return messages;
  }
}

/**
 * Persistent per-chat files — HTTP handlers (2026-08-25).
 *
 * ChatFiles are durable copies of user UPLOADS (see chat-files.service.ts).
 * AUTHORIZATION mirrors reading the parent chat's messages EXACTLY:
 * crossmodel.service.getChatAccess + the chat-gate chatReadAccessGranted
 * decision — the owner or ANY project member (viewers included) may read;
 * non-members get the same 404 as a missing chat/file (the repo's
 * never-leak-existence convention, same as generated-files + getChatById).
 *
 * `data` (the bytea payload) is only ever sent by the two byte routes; the
 * list endpoint returns metadata only.
 */

import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import crossModelService from './crossmodel.service';
import { chatReadAccessGranted } from './chat-agent/chat-gate';
// Leaf module (no imports) — the magic-byte sniffer the stagedMime fix
// (2ab2ab99b) also builds on. Import-light: chat-images is dependency-free.
import { sniffMime, sniffAudioMime } from './coding/chat-images';
import {
  extractDocxText,
  extractPdfUploadText,
  extractPlainText,
  extractXlsxText,
} from './text-extract';

/**
 * Read-access gate: true iff the user may READ this chat (owner or any
 * project member — viewers included), mirroring getChatById(chatId, userId,
 * 'read'). A lookup failure fails closed.
 */
async function chatReadAccess(chatId: string, userId: string): Promise<boolean> {
  const { access, exists } = await crossModelService
    .getChatAccess(chatId, userId)
    .catch(() => ({ access: 'none' as const, exists: false }));
  return chatReadAccessGranted({ userId, access, exists });
}

/**
 * Mime ESSENCE: bare type/subtype — parameters, surrounding whitespace and
 * case stripped. Stored mimes are client-declared VERBATIM on the JSON upload
 * path (upload.controller detectMimeByExtension returns declaredMime as-is,
 * and resolveFileBytes persists it unchanged), so EVERY inline decision and
 * the served Content-Type must key on the essence, never the raw string —
 * otherwise `image/svg+xml; charset=utf-8` passes the image/* family check
 * yet dodges the exact-match SVG sandbox (review finding B1).
 */
export const mimeEssence = (m: string): string => m.split(';', 1)[0].trim().toLowerCase();

/** Mime families safe to render inline (preview / <img> / <audio>) — everything else is download-only. */
export function isInlineSafe(mimeType: string): boolean {
  const m = mimeEssence(mimeType);
  return m.startsWith('image/') || m === 'application/pdf' || m.startsWith('text/') || m.startsWith('audio/');
}

/**
 * Stored mimes that carry NO real type information (ticket 390b6767): rows
 * persisted before the stagedMime fix (stage_upload stamped every binary
 * application/octet-stream) or written with an empty mime. For these the
 * bytes are the only truth, so the inline route may re-derive the type.
 */
export function isUnspecificStoredMime(mimeType: string | null | undefined): boolean {
  const m = mimeEssence(mimeType ?? '');
  return m === '' || m === 'application/octet-stream';
}

/**
 * Scripting-capable mime types (stored HTML/SVG) are served inline only under
 * a CSP sandbox: scripts/forms/plugins blocked, so a stored file can never
 * ride the app origin's session. Raster images / PDFs / plain text render
 * normally and get no CSP (a sandbox header breaks browser PDF viewers).
 * Compares the ESSENCE — a parameterized/whitespace/case variant of html/svg
 * must not slip past (B1).
 */
export function needsInlineSandbox(mimeType: string): boolean {
  const m = mimeEssence(mimeType);
  return m === 'text/html' || m === 'image/svg+xml';
}

/**
 * RFC 6266 Content-Disposition: ASCII-safe fallback + UTF-8 filename* (mirrors
 * generated-files). Header-injection safe: the quoted-string fallback replaces
 * everything outside \x20-\x7E (CR/LF included) plus " and \, and
 * encodeURIComponent percent-encodes CR/LF in the filename* form.
 */
function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
  const safeName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * GET /api/crossmodel/chats/:chatId/files
 * Metadata list (id, uploadId, filename, mimeType, sizeBytes, createdAt),
 * newest first. Read access = owner or any project member.
 */
export async function listChatFiles(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const chatId = String(req.params.chatId || '');
    if (!chatId) return res.status(400).json({ error: 'chat id is required' });
    if (!(await chatReadAccess(chatId, userId))) {
      // 404 for missing AND non-member — never leak existence (repo convention).
      return res.status(404).json({ error: 'Chat not found' });
    }
    const files = await prisma.chatFile.findMany({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        uploadId: true,
        filename: true,
        mimeType: true,
        sizeBytes: true,
        createdAt: true,
      },
    });
    return res.json({ success: true, data: { files } });
  } catch (err: any) {
    logger.error(`listChatFiles error: ${err?.message ?? err}`);
    return res.status(500).json({ error: 'Failed to list chat files' });
  }
}

/**
 * GET /api/crossmodel/chat-uploads
 * User-wide ChatFile metadata list for the global Files page's "Chat uploads"
 * section (2026-08-31) — the per-chat route only ever served one chat, so
 * uploads (esp. images) were invisible on the global surface. Metadata only
 * (never the bytea payload), newest first, same 200-row bound as the
 * per-chat list. Caller's own uploads only (chat membership irrelevant —
 * uploader == owner of the row).
 */
export async function listUserChatFiles(req: AuthRequest, res: Response) {
  try {
    const files = await prisma.chatFile.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        uploadId: true,
        chatId: true,
        filename: true,
        mimeType: true,
        sizeBytes: true,
        createdAt: true,
      },
    });
    return res.json({ success: true, data: { files } });
  } catch (err: any) {
    logger.error(`listUserChatFiles error: ${err?.message ?? err}`);
    return res.status(500).json({ error: 'Failed to list chat files' });
  }
}

/**
 * DELETE /api/crossmodel/files/:fileId — remove one upload. Only the
 * UPLOADER may delete (mirrors deleteGeneratedFile's owner-only gate);
 * not-found AND not-owned collapse to the non-leaking 404.
 */
export async function deleteChatFile(req: AuthRequest, res: Response) {
  try {
    const file = await prisma.chatFile.findUnique({ where: { id: String(req.params.fileId || '') } });
    if (!file || file.userId !== req.user!.id) {
      return res.status(404).json({ error: 'File not found' });
    }
    await prisma.chatFile.delete({ where: { id: file.id } });
    return res.json({ ok: true });
  } catch (err: any) {
    logger.error(`deleteChatFile error: ${err?.message ?? err}`);
    return res.status(500).json({ error: 'Failed to delete file' });
  }
}

/** Shared byte-serving path for /download and /inline. */
async function serveChatFile(req: AuthRequest, res: Response, disposition: 'attachment' | 'inline') {
  try {
    const userId = req.user!.id;
    const file = await prisma.chatFile.findUnique({ where: { id: String(req.params.fileId || '') } });
    // Not-found AND not-a-member collapse to one 404 — cross-user existence
    // is never observable (mirrors downloadGeneratedFile).
    if (!file || !(await chatReadAccess(file.chatId, userId))) {
      return res.status(404).json({ error: 'File not found' });
    }
    // Ticket 390b6767: rows persisted before the stagedMime fix carry
    // application/octet-stream (or an empty mime) — for those the bytes are
    // the only truth. Re-derive the type from the leading magic bytes.
    // sniffMime only ever returns raster image types (png/jpeg/gif/webp), so
    // the B1 stored-XSS surface (svg/html) is UNREACHABLE through this path,
    // and non-image magic (ELF/zip) keeps its unspecific mime → 415 inline,
    // exactly as before. Ticket 6c050917 adds the AUDIO twin: sniffAudioMime
    // heals the persisted bake-off/voice-clip WAV rows that were staged as
    // octet-stream before audio joined the mime chain — the healed row serves
    // inline and the transcript's audio player works on OLD clips too.
    // sniffAudioMime only ever returns audio/*, so B1 stays unreachable here.
    let mimeType = file.mimeType;
    if (isUnspecificStoredMime(mimeType)) {
      const head = Buffer.from(file.data).subarray(0, 16);
      const sniffed = sniffMime(head) || sniffAudioMime(head);
      if (sniffed) {
        mimeType = sniffed;
        void prisma.chatFile
          .update({ where: { id: file.id }, data: { mimeType: sniffed } })
          .catch((err: any) => logger.warn(`ChatFile mime backfill failed for ${file.id}: ${err?.message ?? err}`));
      }
    }
    if (disposition === 'inline' && !isInlineSafe(mimeType)) {
      return res.status(415).json({ error: 'This file type cannot be previewed inline — use the download URL.' });
    }
    const buffer = Buffer.from(file.data);
    // Serve the normalized ESSENCE, never the verbatim stored string — defeats
    // any downstream parameter weirdness from the client-declared mime (B1).
    // A degenerate empty essence falls back to octet-stream (express's default).
    res.setHeader('Content-Type', mimeEssence(mimeType) || 'application/octet-stream');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', contentDisposition(disposition, file.filename));
    if (disposition === 'inline') {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (needsInlineSandbox(mimeType)) {
        res.setHeader('Content-Security-Policy', 'sandbox');
      }
    }
    return res.send(buffer);
  } catch (err: any) {
    logger.error(`serveChatFile (${disposition}) error: ${err?.message ?? err}`);
    return res.status(500).json({ error: 'Failed to serve file' });
  }
}

/** GET /api/crossmodel/files/:fileId/download — bytes as an attachment. */
export const downloadChatFile = (req: AuthRequest, res: Response) => serveChatFile(req, res, 'attachment');

/** GET /api/crossmodel/files/:fileId/inline — bytes inline (image/*, application/pdf, text/* only). */
export const inlineChatFile = (req: AuthRequest, res: Response) => serveChatFile(req, res, 'inline');

/** Char cap on the preview-text response — same ballpark as upload-time staging (50K). */
export const PREVIEW_TEXT_MAX_CHARS = 50000;

// Office essences preview-text can extract (mirrors the upload ALLOWED_TYPES set).
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS_MIME = 'application/vnd.ms-excel';

/**
 * GET /api/crossmodel/files/:fileId/preview-text
 * Extracted TEXT for the Files panel's in-panel preview modal. Same access
 * gate as the byte routes (owner or any project member; else the non-leaking
 * 404). Dispatch is on the stored mime ESSENCE:
 *   text/* + application/json|xml → utf-8 decode; pdf → pdf-extract;
 *   docx → mammoth; xlsx/xls → exceljs (SheetJS retired, ticket 3be57df0). Images 415 (the modal renders those
 *   from the inline byte route); every other family 415s. Response:
 *   { success, data: { text, truncated } } — capped at PREVIEW_TEXT_MAX_CHARS.
 * This is a TEXT route, not a byte re-serve — the /inline isInlineSafe
 * allowlist (stored-XSS guard, B1) is deliberately untouched.
 */
export async function previewTextChatFile(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const file = await prisma.chatFile.findUnique({ where: { id: String(req.params.fileId || '') } });
    // Not-found AND not-a-member collapse to one 404 — cross-user existence
    // is never observable (same convention as serveChatFile).
    if (!file || !(await chatReadAccess(file.chatId, userId))) {
      return res.status(404).json({ error: 'File not found' });
    }
    const m = mimeEssence(file.mimeType);
    const buffer = Buffer.from(file.data);
    let text: string;
    if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml') {
      text = extractPlainText(buffer);
    } else if (m === 'application/pdf') {
      text = await extractPdfUploadText(buffer, file.filename);
    } else if (m === DOCX_MIME) {
      text = await extractDocxText(buffer);
    } else if (m === XLSX_MIME || m === XLS_MIME) {
      text = await extractXlsxText(buffer);
    } else {
      return res.status(415).json({ error: 'This file type has no text preview.' });
    }
    const truncated = text.length > PREVIEW_TEXT_MAX_CHARS;
    return res.json({
      success: true,
      data: { text: truncated ? text.slice(0, PREVIEW_TEXT_MAX_CHARS) : text, truncated },
    });
  } catch (err: any) {
    logger.error(`previewTextChatFile error: ${err?.message ?? err}`);
    return res.status(500).json({ error: 'Failed to extract preview text' });
  }
}

export default {
  listChatFiles,
  listUserChatFiles,
  downloadChatFile,
  inlineChatFile,
  previewTextChatFile,
  deleteChatFile,
};

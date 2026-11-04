/**
 * Generated Files — HTTP API for the agent-created binary documents
 * (GeneratedFile rows written by the create_document / fill_pdf_form tools).
 *
 * LIST + DELETE live behind the app-level auth guard (generated-files.routes.ts).
 * The DOWNLOAD handler is ALSO mounted on a query-token router before the guard
 * (generated-files-public.routes.ts) so a plain browser link in chat markdown —
 * which can't send an Authorization header — still downloads the file.
 *
 * `data` (the base64 payload) is NEVER returned by the list endpoint and never
 * logged — only decoded on the byte paths (download + the image-only inline
 * route generate_image parts render from, 2026-09-24).
 */

import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import { mimeEssence } from './chat-files.controller';

// ── List the caller's generated files (metadata only — never the payload) ────

export async function listGeneratedFiles(req: AuthRequest, res: Response) {
  try {
    // Optional ?chatId= filter (2026-08-31): per-chat surfaces (the Files
    // panel) filter SERVER-side now — the old client-side filter over a
    // 200-row user-wide list silently lost attribution for older rows.
    const chatId = typeof req.query.chatId === 'string' && req.query.chatId.trim()
      ? req.query.chatId.trim()
      : undefined;
    const files = await prisma.generatedFile.findMany({
      where: { userId: req.user!.id, ...(chatId ? { chatId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        filename: true,
        format: true,
        mimeType: true,
        size: true,
        createdAt: true,
        // Nullable bare column (no FK) — lets per-chat surfaces (chat Files
        // panel, ticket 57ef1b9f PR2) filter client-side without a second
        // route. Additive metadata only; the payload is still never selected.
        chatId: true,
      },
    });
    res.json(files);
  } catch (err: any) {
    logger.error('listGeneratedFiles error:', err);
    res.status(500).json({ error: 'Failed to list generated files' });
  }
}

// ── Serve one file's bytes (download | inline) ────────────────────────────────
// Mounted both behind the app guard (Bearer) and on the pre-guard query-token
// router — req.user is set by either path. 404 for not-found AND not-owned
// (never leak existence across users).
//
// INLINE is image-only (generate_image, 2026-09-24): generated_files also holds
// HTML-adjacent formats (md, txt, json) and PDFs — none of those may render on
// the app origin from this route (no CSP sandbox here; the chat-files inline
// route owns that machinery). SVG is scripting-capable and is refused too.
// Everything non-image → 415, exactly like chat-files' serveChatFile.

/** True when the stored mime may be served inline by this route. */
export function isInlineImageMime(mimeType: string): boolean {
  const m = mimeEssence(mimeType || '');
  return m.startsWith('image/') && m !== 'image/svg+xml';
}

/** The columns the byte sender reads — a full GeneratedFile row satisfies it. */
export interface GeneratedFileBytesRow {
  filename: string;
  mimeType: string;
  /** base64 payload */
  data: string;
}

/**
 * Write one GeneratedFile's bytes onto the response: the decoded payload,
 * Content-Type (normalized ESSENCE for inline — never a parameterized/odd
 * stored string; the stored mime byte-for-byte for download), an RFC 6266
 * Content-Disposition (ASCII-safe fallback filename + UTF-8 filename*), and —
 * inline only — nosniff plus the caller's Cache-Control (default: an hour of
 * PRIVATE caching; generated rows are never rewritten after create, so a
 * transcript reload never re-fetches every figure). Download sets no cache
 * header, as before.
 *
 * Does NO authorization: shared (2026-09-24, tranche B) by the owner routes
 * below and the public shared-chat image route (sharing.controller.ts
 * getSharedChatImage — token-scoped, `public` caching), each of which decides
 * who may see the row BEFORE calling this.
 */
export function sendGeneratedFileBytes(
  res: Response,
  file: GeneratedFileBytesRow,
  opts: { disposition: 'attachment' | 'inline'; cacheControl?: string }
): void {
  const { disposition } = opts;
  const buffer = Buffer.from(file.data, 'base64');
  const safeName = file.filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', disposition === 'inline' ? mimeEssence(file.mimeType) : file.mimeType);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`
  );
  if (disposition === 'inline') {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', opts.cacheControl ?? 'private, max-age=3600');
  }
  res.send(buffer);
}

async function serveGeneratedFile(req: AuthRequest, res: Response, disposition: 'attachment' | 'inline') {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const file = await prisma.generatedFile.findUnique({ where: { id: req.params.id } });
    if (!file || file.userId !== req.user.id) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (disposition === 'inline' && !isInlineImageMime(file.mimeType)) {
      return res.status(415).json({ error: 'Only images can be shown inline — use the download URL.' });
    }

    logger.info(`GeneratedFile ${disposition}: ${file.filename} (${file.format}, ${file.size} bytes) user=${req.user.id}`);
    sendGeneratedFileBytes(res, file, { disposition });
  } catch (err: any) {
    logger.error(`${disposition === 'inline' ? 'inlineGeneratedFile' : 'downloadGeneratedFile'} error:`, err);
    res.status(500).json({ error: disposition === 'inline' ? 'Failed to serve file' : 'Failed to download file' });
  }
}

/** GET /api/crossmodel/generated-files/:id/download — bytes as an attachment. */
export async function downloadGeneratedFile(req: AuthRequest, res: Response) {
  return serveGeneratedFile(req, res, 'attachment');
}

/** GET /api/crossmodel/generated-files/:id/inline — image bytes inline (image/* only; 415 otherwise). */
export async function inlineGeneratedFile(req: AuthRequest, res: Response) {
  return serveGeneratedFile(req, res, 'inline');
}

// ── Delete one file ───────────────────────────────────────────────────────────

export async function deleteGeneratedFile(req: AuthRequest, res: Response) {
  try {
    const file = await prisma.generatedFile.findUnique({ where: { id: req.params.id } });
    if (!file || file.userId !== req.user!.id) {
      return res.status(404).json({ error: 'File not found' });
    }
    await prisma.generatedFile.delete({ where: { id: file.id } });
    res.json({ ok: true });
  } catch (err: any) {
    logger.error('deleteGeneratedFile error:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
}

export default {
  listGeneratedFiles,
  downloadGeneratedFile,
  inlineGeneratedFile,
  deleteGeneratedFile,
};

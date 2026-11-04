import { Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { AuthRequest } from '../../middleware/auth';
import prisma from '../../config/database';
import { processDocument } from './ingestion.service';
import redisClient from '../../config/redis';
import { extractDocxText, extractPdfUploadText, extractPlainText, extractXlsxText } from './text-extract';
import { convertHeicToJpeg, isHeicMime } from './heic';
import logger from '../../utils/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AttachmentFile {
  type: 'image' | 'pdf' | 'document' | 'audio';
  filename: string;
  mimeType?: string;
  base64?: string;
  extractedText?: string;
}

export interface Attachment extends AttachmentFile {
  // When multiple files are uploaded, additional ones are stored here
  // so model integrations can iterate all of them
  additionalFiles?: AttachmentFile[];
  // Set by crossmodel.controller when exactly ONE upload was loaded — lets the
  // model reference this exact upload later (e.g. fill_pdf_form's uploadId)
  // during the attachment's 15-min Redis TTL.
  uploadId?: string;
  // Ownership binding (adversarial review M2): the uploader's userId, stamped
  // at stash time by processUpload. null = anonymous upload (the open /upload
  // route carries no session identity to bind to — anonymous chats manage
  // their Redis session on the /stream path only). Consumers that accept an
  // uploadId from MODEL-controlled args (fill_pdf_form) must reject a stashed
  // owner that differs from the requesting user; a null owner stays loadable
  // (unchanged anonymous behavior, protected by the unguessable UUID + TTL).
  ownerUserId?: string | null;
}

// ─── Multer setup ─────────────────────────────────────────────────────────────

const ALLOWED_TYPES = new Set([
  // Images
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  // PDF
  'application/pdf',
  // Office documents
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // XLSX
  'application/vnd.ms-excel',                                                  // XLS (legacy)
  // Text-based
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/xml',
  'application/xml',
  'application/json',
  // Audio (ticket 6c050917 — inline audio player): the chat UI plays clips
  // (TTS bake-offs, voice notes) inline, so uploads must stage audio bytes.
  'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/x-m4a', 'audio/m4a',
  'audio/aac', 'audio/aacp',
  'audio/ogg', 'audio/opus', 'audio/vorbis',
  'audio/flac', 'audio/x-flac',
  'audio/webm',
  // Catch-all for xlsx/docx sometimes mis-identified by clients
  'application/octet-stream',
]);

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  // 50 MB — generous for PDF/docx/xlsx while bounding the in-memory buffer an
  // anonymous caller can force us to allocate (was 200 MB → OOM-DoS risk).
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ALLOWED_TYPES.has(file.mimetype)
      // Also accept by extension if MIME is generic
      || /\.(pdf|docx|xlsx|xls|txt|csv|json|xml|md|markdown|wav|mp3|m4a|aac|ogg|oga|opus|flac|webm)$/i.test(file.originalname)
      // 5957f657: an explicitly-typed text/* part (curl -F file=@x.diff;type=text/x-diff,
      // some HTTP clients) used to be silently dropped HERE, long before the
      // controller's sniff could judge the bytes. Let text/* parts through —
      // case-insensitively (RFC 2045; resolveUploadMime normalizes the rest) —
      // processUpload's resolveUploadMime still sniffs and 400s binary content,
      // so the controller stays the enforcement point (same trust model as the
      // JSON path, where the client-chosen mimeType was always advisory).
      || file.mimetype.toLowerCase().startsWith('text/');
    cb(null, allowed);
  },
}).single('file');

// ─── Startup: clean up stale /tmp files from previous server instances ────────
//
// The auto-delete timer is in-process, so it's lost on server restart.
// Without this cleanup, /tmp/cm_upload_*.json files accumulate indefinitely
// across container restarts (e.g. after GitHub Actions deploys).
// Called once from server.ts at startup — safe to run on every boot.

export function cleanupStaleTmpFiles(): void {
  try {
    const tmpDir = '/tmp';
    const stalePattern = /^cm_upload_[0-9a-f-]{36}\.json$/;
    let cleaned = 0;
    const files = fs.readdirSync(tmpDir);
    for (const file of files) {
      if (stalePattern.test(file)) {
        try {
          fs.unlinkSync(`${tmpDir}/${file}`);
          cleaned++;
        } catch { /* file may have just been deleted */ }
      }
    }
    if (cleaned > 0) {
      logger.info(`Upload: cleaned up ${cleaned} stale temp file(s) from previous server instance`);
    }
  } catch (err: any) {
    // Non-fatal — /tmp cleanup failure should never prevent startup
    logger.warn(`Upload: stale tmp cleanup failed (non-fatal): ${err?.message}`);
  }
}

// ─── Helper: save/load attachment (Redis, cross-instance) ─────────────────────
// Attachments were written to per-instance /tmp until 2026-08-16: with two web
// instances behind the per-request ALB, the /upload POST and the /stream GET
// routinely landed on different boxes, so loadAttachment() missed and the send
// SILENTLY proceeded without the file (same class as the stream-token 410).
// Redis is the only store both instances share for transient blobs. TTL matches
// the old 15-min /tmp auto-delete. /tmp remains as a same-instance fallback
// during a Redis outage (degraded to the pre-fix behavior, never worse).

const ATTACHMENT_TTL_SEC = 15 * 60;
/** Exported for message-queue.service — the busy-chat enqueue EXTENDS each
 *  staged blob's TTL so attachments outlive the queue dwell (ticket ac65d51e). */
export const attachmentKey = (uploadId: string) => `cm:upload:${uploadId}`;
/** Above this, log a warning — large base64 images are legal but worth visibility. */
const ATTACHMENT_WARN_BYTES = 8 * 1024 * 1024;

export async function saveAttachment(uploadId: string, attachment: Attachment): Promise<void> {
  const json = JSON.stringify(attachment);
  if (json.length > ATTACHMENT_WARN_BYTES) {
    logger.warn(`Upload ${uploadId}: large attachment payload (${(json.length / 1024 / 1024).toFixed(1)}MB) stored in Redis (15-min TTL)`);
  }
  try {
    await redisClient.set(attachmentKey(uploadId), json, { EX: ATTACHMENT_TTL_SEC });
  } catch (err) {
    // Redis down: keep the old single-instance behavior alive rather than fail the upload.
    logger.error(`Upload ${uploadId}: Redis store failed — falling back to /tmp (same-instance only)`, err);
    const tmpPath = `/tmp/cm_upload_${uploadId}.json`;
    fs.writeFileSync(tmpPath, json);
    setTimeout(() => {
      try { fs.unlinkSync(tmpPath); } catch {}
    }, ATTACHMENT_TTL_SEC * 1000).unref();
  }
}

export async function loadAttachment(uploadId: string): Promise<Attachment | null> {
  try {
    const raw = await redisClient.get(attachmentKey(uploadId));
    if (raw) return JSON.parse(raw) as Attachment;
  } catch {
    /* fall through to /tmp */
  }
  const tmpPath = `/tmp/cm_upload_${uploadId}.json`;
  try {
    if (!fs.existsSync(tmpPath)) return null;
    return JSON.parse(fs.readFileSync(tmpPath, 'utf-8')) as Attachment;
  } catch {
    return null;
  }
}

/**
 * Merge several loaded uploads into ONE composite Attachment (first image
 * becomes primary, remaining images/PDFs/docs ride `additionalFiles`, and all
 * extracted doc text is concatenated as `[filename]\n<text>` blocks).
 * Extracted 2026-08-19 from crossmodel.controller.ts streamQuery so the fleet
 * supervisor send path merges uploads IDENTICALLY to the plain-chat SSE path —
 * keep the two call sites' behavior locked to this one implementation.
 */
export function combineAttachments(rawAttachments: Attachment[]): Attachment | undefined {
  if (rawAttachments.length === 0) return undefined;
  const images = rawAttachments.filter(a => a.type === 'image' && a.base64);
  const pdfs   = rawAttachments.filter(a => a.type === 'pdf' && a.base64);
  const docs   = rawAttachments.filter(a => a.type === 'document' && a.extractedText);
  // Audio (ticket 6c050917): raw bytes only — no extracted text, no vision
  // channel. A combined audio-only send keeps the FIRST clip primary and the
  // rest ride additionalFiles so every uploadId still maps to its chip.
  const audios = rawAttachments.filter(a => a.type === 'audio' && a.base64);

  if (images.length > 0) {
    const allDocText = [...pdfs, ...docs]
      .map(d => `[${d.filename}]\n${d.extractedText || ''}`)
      .filter(t => t.includes('\n') && t.split('\n')[1]?.trim())
      .join('\n\n');
    return {
      ...images[0],
      extractedText: allDocText || undefined,
      additionalFiles: [...images.slice(1), ...pdfs, ...docs],
    };
  }
  if (pdfs.length > 0) {
    const allText = rawAttachments
      .filter(a => a.extractedText && a.extractedText.length > 5)
      .map(d => `[${d.filename}]\n${d.extractedText}`)
      .join('\n\n');
    return {
      ...pdfs[0],
      extractedText: allText || pdfs[0].extractedText,
      additionalFiles: [...pdfs.slice(1), ...docs],
    };
  }
  if (docs.length > 0) {
    const allText = docs.map(d => `[${d.filename}]\n${d.extractedText}`).join('\n\n');
    return {
      type: 'document',
      filename: docs.map(d => d.filename).join(', '),
      extractedText: allText,
      additionalFiles: docs.slice(1),
    };
  }
  if (audios.length > 0) {
    // Audio-only send (ticket 6c050917): raw bytes, nothing to extract — the
    // agent gets a short pointer note (the transcript chips carry the real
    // player), and the remaining clips ride additionalFiles.
    return {
      type: 'audio',
      filename: audios.map(a => a.filename).join(', '),
      mimeType: audios[0].mimeType,
      base64: audios[0].base64,
      extractedText: `[User attached ${audios.length === 1 ? 'an audio clip' : `${audios.length} audio clips`}: ${audios.map(a => a.filename).join(', ')} — no transcription available; ask the user about the content if relevant.]`,
      additionalFiles: audios.slice(1),
    };
  }
  return undefined;
}

// ─── Helper: detect type by extension fallback ────────────────────────────────

function detectMimeByExtension(filename: string, declaredMime: string): string {
  // Handle both 'application/octet-stream' (generic binary) and '' (empty — some browsers
  // don't set a MIME type for text files like .txt, .csv, .json, .xml, .md)
  if (declaredMime !== 'application/octet-stream' && declaredMime !== '') return declaredMime;
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const extMap: Record<string, string> = {
    'pdf':      'application/pdf',
    'docx':     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xlsx':     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'xls':      'application/vnd.ms-excel',
    'txt':      'text/plain',
    'csv':      'text/csv',
    'json':     'application/json',
    'xml':      'text/xml',
    'md':       'text/markdown',
    'markdown': 'text/markdown',
    // Audio (ticket 6c050917): browsers report no mime for some audio files
    // (e.g. .wav on older Safari) — the extension then decides, so the staged
    // blob carries a playable type and the inline route serves it.
    'wav':      'audio/wav',
    'mp3':      'audio/mpeg',
    'm4a':      'audio/mp4',
    'aac':      'audio/aac',
    'ogg':      'audio/ogg',
    'oga':      'audio/ogg',
    'opus':     'audio/ogg',
    'flac':     'audio/flac',
    'webm':     'audio/webm',
  };
  return extMap[ext] || declaredMime;
}

// ─── Helper: text-sniff an unknown-typed upload ───────────────────────────────
// Ticket 0025b3bc: browsers declare application/octet-stream (or no MIME at
// all) for any extension they don't map — .log, .out, .diff, extensionless
// files. The old dispatch chain then had NO branch for the generic type, so a
// plain-text OPTCGSim combat log was rejected with "Unsupported file type:
// application/octet-stream" even though it's ordinary UTF-8 (rename-to-.txt
// was the only workaround). Fix: when the declared/extension-resolved MIME is
// still generic, sniff the BYTES — no NUL and no other control chars (bar
// tab/LF/CR) in the first 8 KB means treat it as text/plain and route through
// the existing text branch (extract → document attachment). Anything binary
// keeps the old 400. Git uses the same heuristic for diff/plain detection.
//
// Ticket 5957f657 (the residual half 0025b3bc left behind): a SPECIFIC text/*
// mime the dispatch chain has no branch for — an OS/browser-mapped .diff
// arriving as text/x-diff, a .log as text/x-log — 400s identically even
// though the bytes are plain text. Same sniff, extended one step: an
// unmapped specific text/* mime whose bytes sniff as text also resolves to
// text/plain; binary content keeps the declared mime and the old 400.
const TEXT_SNIFF_WINDOW = 8 * 1024;
const GENERIC_MIMES = new Set(['application/octet-stream', '']);
// Specific text/* mimes WITH a dedicated dispatch branch (and ALLOWED_TYPES
// entry) — never rewritten, they route exactly as before.
const KNOWN_TEXT_MIMES = new Set(['text/plain', 'text/csv', 'text/markdown', 'text/xml']);

/** True when the first 8 KB contain no NUL or control bytes (tab/LF/CR
 *  excepted) — i.e. the buffer sniffs as text. Exported for tests. */
export function sniffIsText(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, TEXT_SNIFF_WINDOW);
  for (let i = 0; i < end; i++) {
    const c = buffer[i];
    if (c === 0x00) return false;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false;
  }
  return true;
}

/** Resolve the generic MIME (application/octet-stream or '') to text/plain
 *  when the bytes sniff as text — the ticket-0025b3bc fix at the one seam
 *  every upload path shares. Pure. Exported for tests. */
export function resolveGenericMimeBySniff(mimetype: string, buffer: Buffer): string {
  if (GENERIC_MIMES.has(mimetype) && sniffIsText(buffer)) return 'text/plain';
  return mimetype;
}

/** Resolve an UNMAPPED specific text/* mime (text/x-diff, text/x-log, …) to
 *  text/plain when the bytes sniff as text — the ticket-5957f657 residual
 *  half. The known text mimes (plain/csv/markdown/xml) keep their identity:
 *  they have dedicated dispatch branches and are never rewritten. A text/*
 *  mime on BINARY bytes keeps the declared mime, so the dispatch fallthrough
 *  still 400s it (an attacker naming a .zip "text/x-anything" gains nothing).
 *  Pure. Exported for tests. */
export function resolveSpecificTextMimeBySniff(mimetype: string, buffer: Buffer): string {
  if (
    mimetype.startsWith('text/') &&
    !KNOWN_TEXT_MIMES.has(mimetype) &&
    !GENERIC_MIMES.has(mimetype) &&
    sniffIsText(buffer)
  ) {
    return 'text/plain';
  }
  return mimetype;
}

/** The ONE seam both upload paths share for MIME resolution (0025b3bc +
 *  5957f657): the declared mime is first normalized to its RFC 2045 base
 *  form (type/subtype, lowercased, parameters stripped — browsers already
 *  send lowercase, hand-rolled clients may not, and a parameterized
 *  'text/csv; charset=utf-8' previously matched NO dispatch branch and 400ed),
 *  then extension map (generic mime only), then generic sniff, then
 *  specific-text sniff. Pure. Exported for tests. */
export function resolveUploadMime(filename: string, declaredMime: string, buffer: Buffer): string {
  const mime = declaredMime.split(';')[0].trim().toLowerCase();
  return resolveSpecificTextMimeBySniff(
    resolveGenericMimeBySniff(detectMimeByExtension(filename, mime), buffer),
    buffer,
  );
}

// ─── Controller ───────────────────────────────────────────────────────────────

export async function processUpload(req: AuthRequest, res: Response): Promise<void> {
  let originalname: string;
  let mimetype: string;
  let buffer: Buffer;

  // ── JSON upload (base64-encoded body) — bypasses multipart binary issues ──
  // Browser sends: { filename, mimeType, base64 } as application/json
  // This avoids Cloudflare/proxy multipart content inspection that blocks binary files
  if (req.body?.base64 && !req.file) {
    const { filename, mimeType, base64: b64 } = req.body;
    if (!filename || !mimeType || !b64) {
      res.status(400).json({ error: 'Missing filename, mimeType, or base64' });
      return;
    }
    try {
      buffer = Buffer.from(b64, 'base64');
    } catch {
      res.status(400).json({ error: 'Invalid base64 data' });
      return;
    }
    if (buffer.length > 50 * 1024 * 1024) {
      res.status(400).json({ error: 'File too large (max 50 MB)' });
      return;
    }
    originalname = filename;
    mimetype = resolveUploadMime(filename, mimeType, buffer);
    const allowed = ALLOWED_TYPES.has(mimetype)
      || /\.(pdf|docx|xlsx|xls|txt|csv|json|xml|md|markdown|wav|mp3|m4a|aac|ogg|oga|opus|flac|webm)$/i.test(filename)
      || mimetype.startsWith('image/')
      || mimetype.startsWith('audio/');
    if (!allowed) {
      res.status(400).json({ error: `Unsupported file type: ${mimetype}. Supported: images, audio, PDF, DOCX, XLSX, TXT, CSV, JSON, XML, Markdown, and other plain-text files (e.g. .log, .diff).` });
      return;
    }
  }
  // ── Multipart upload (traditional form-data) — kept for curl / backward compat
  else if (req.file) {
    originalname = req.file.originalname;
    mimetype = resolveUploadMime(req.file.originalname, req.file.mimetype, req.file.buffer);
    buffer = req.file.buffer;
  }
  // ── No file
  else {
    res.status(400).json({ error: 'No file provided or unsupported file type (max 50 MB).' });
    return;
  }

  // HEIC/HEIF → JPEG at the door (owner report 2026-09-03): the upload form
  // lists HEIC as supported, but OpenAI vision rejects it (the analyzer's
  // "convert to JPEG or PNG first" error the owner hit on a .heic screenshot)
  // and non-Safari browsers can't render it inline. Converting once here
  // fixes every downstream consumer — the feedback/knowledge-base analyzer,
  // chat vision injection, and the preview chip. A conversion failure keeps
  // the original bytes (the analyzer's helpful error stays the fallback).
  if (isHeicMime(mimetype)) {
    const jpeg = await convertHeicToJpeg(buffer);
    if (jpeg) {
      buffer = jpeg;
      mimetype = 'image/jpeg';
      originalname = originalname.replace(/\.(heic|heif)$/i, '.jpg');
      logger.info(`upload: converted HEIC upload to JPEG (${originalname})`);
    }
  }

  const uploadId = randomUUID();
  const base64 = buffer.toString('base64');
  let attachment: Attachment;
  let preview: string;

  try {
    if (mimetype.startsWith('image/')) {
      // ── Images: store base64 directly ─────────────────────────────────────
      attachment = { type: 'image', filename: originalname, mimeType: mimetype, base64 };
      preview = `data:${mimetype};base64,${base64.slice(0, 300)}`;

    } else if (mimetype === 'application/pdf') {
      // ── PDFs: store base64 for native Files API (OpenAI/Gemini/Grok)
      //   AND extract layout-faithful text (vision OCR for layout-sensitive /
      //   scanned docs, pdf-parse baseline) so Open Source models (GLM/Kimi/
      //   DeepSeek) AND RAG retrieval get accurate tables/numbers — not the
      //   column-flattened pdf-parse text that made models misread bank
      //   statements. Shared never-throwing extractor: text-extract.ts (the
      //   50K-char cap for model context stays at this call site).
      const extractedText = (await extractPdfUploadText(buffer, originalname)).slice(0, 50000).trim();
      // For image-based/scanned PDFs with no text layer, provide a note so
      // frontier models (OpenAI/Gemini) can use their vision to read the binary.
      // Open Source models (GLM/Kimi/DeepSeek) will acknowledge the limitation.
      const isScanned = !extractedText;
      attachment = {
        type: 'pdf',
        filename: originalname,
        mimeType: 'application/pdf',
        base64,
        extractedText: extractedText || (isScanned
          ? `[This is a scanned/image-based PDF with no extractable text. Filename: ${originalname}. ` +
            `If you support native PDF vision analysis (base64 is provided), please analyze it visually.]`
          : undefined),
      };
      preview = extractedText
        ? extractedText.slice(0, 200) + (extractedText.length > 200 ? '…' : '')
        : `[PDF: ${originalname} — ${Math.round(buffer.length / 1024)}KB — image-based]`;

    } else if (
      mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      // ── DOCX: extract text with mammoth (shared extractor: text-extract.ts) ─
      const extractedText = (await extractDocxText(buffer)).slice(0, 50000);
      // base64 is RETAINED (feedback 7f546b03): coding-session runs stage the
      // raw bytes onto the session filesystem — the 50K-char extracted text is
      // only the plain-chat/RAG copy, never the agent's file.
      attachment = { type: 'document', filename: originalname, mimeType: mimetype, extractedText, base64 };
      preview = extractedText.slice(0, 200) + (extractedText.length > 200 ? '…' : '');

    } else if (
      mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimetype === 'application/vnd.ms-excel'
    ) {
      // ── XLSX / XLS: extract all sheets as CSV-like text (shared: text-extract.ts) ─
      const extractedText = (await extractXlsxText(buffer)).slice(0, 20000);
      // base64 is RETAINED (feedback 7f546b03): coding-session runs stage the
      // raw bytes onto the session filesystem — the extracted sheet text is
      // only the plain-chat/RAG copy, never the agent's file.
      attachment = { type: 'document', filename: originalname, mimeType: mimetype, extractedText, base64 };
      preview = extractedText.slice(0, 200) + (extractedText.length > 200 ? '…' : '');

    } else if (
      mimetype === 'text/plain' ||
      mimetype === 'text/csv' ||
      mimetype === 'text/markdown' ||
      mimetype === 'application/json' ||
      mimetype === 'text/xml' ||
      mimetype === 'application/xml'
    ) {
      // ── Plain text, CSV, JSON, XML, Markdown: read directly (shared: text-extract.ts) ─
      const extractedText = extractPlainText(buffer).slice(0, 50000);
      // base64 is RETAINED (feedback 7f546b03): coding-session runs stage the
      // raw bytes onto the session filesystem — the 50K-char extracted text is
      // only the plain-chat/RAG copy, never the agent's file.
      attachment = { type: 'document', filename: originalname, mimeType: mimetype, extractedText, base64 };
      preview = extractedText.slice(0, 200) + (extractedText.length > 200 ? '…' : '');

    } else if (mimetype.startsWith('audio/')) {
      // ── Audio (ticket 6c050917 — inline audio player): stage the raw bytes
      //   as-is (no text extraction, no provider handoff) so the persisted
      //   ChatFile row serves a playable inline route and the transcript can
      //   render the AudioFilePlayer. The declared mime is trusted EXACTLY as
      //   images do — the inline route gates serving on the essence family
      //   (audio/* joins isInlineSafe), and the audio player's own blob gate
      //   (isBlobPlayableAudio) re-checks the FETCHED bytes' type before
      //   rendering a <audio> element.
      attachment = { type: 'audio', filename: originalname, mimeType: mimetype, base64 };
      preview = `[Audio: ${originalname} — ${Math.round(buffer.length / 1024)}KB]`;

    } else {
      res.status(400).json({ error: `Unsupported file type: ${mimetype}. Supported: images, audio, PDF, DOCX, XLSX, TXT, CSV, JSON, XML, Markdown, and other plain-text files (e.g. .log, .diff).` });
      return;
    }
  } catch (err) {
    logger.error('Upload processing error:', err);
    res.status(500).json({ error: 'Failed to process file.' });
    return;
  }

  // Save for AI context use during the chat stream — Redis (cross-instance),
  // 15-min TTL; /tmp fallback inside saveAttachment when Redis is down.
  // M2: stamp the uploader so uploadId-consuming tools can verify ownership
  // (null for anonymous uploads — see the Attachment interface note).
  attachment.ownerUserId = req.user?.userId ?? null;
  await saveAttachment(uploadId, attachment);

  logger.info(`Upload processed: ${originalname} (${mimetype}) → uploadId ${uploadId}, hasBase64=${!!attachment.base64}, extractedTextLen=${attachment.extractedText?.length ?? 0}`);

  // ── Auto-ingest into ProjectDocuments for authenticated users ─────────────
  // Images are AI-visual only — skip knowledge base ingestion for them
  // PDFs and documents get ingested so they appear in /files and RAG search
  let documentId: string | null = null;

  if (req.user && attachment.type !== 'image' && attachment.extractedText?.trim()) {
    const projectId = (req.body?.projectId as string | undefined) || null;
    try {
      const doc = await prisma.projectDocument.create({
        data: {
          userId: req.user.userId,
          projectId: projectId || null,
          name: originalname,
          mimeType: mimetype,
          status: 'processing',
          source: 'chat_upload',
          charCount: attachment.extractedText.length,
        },
      });
      documentId = doc.id;

      // Fire-and-forget ingestion — extracted text already available
      processDocument(doc.id, attachment.extractedText).catch(err => {
        logger.error(`Background ingestion failed for chat upload ${doc.id}:`, err);
      });

      logger.info(`Chat upload auto-ingested: ${originalname} → doc ${doc.id} (project: ${projectId ?? 'none'})`);
    } catch (err) {
      logger.warn('Failed to auto-ingest chat upload to ProjectDocuments:', err);
      // Don't fail the upload — the file still works for AI context
    }
  }

  res.json({ uploadId, type: attachment.type, filename: originalname, preview, documentId });
}

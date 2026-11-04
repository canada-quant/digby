/**
 * Gmail attachments → project knowledge base (ticket 99145890).
 *
 * The GMAIL-SOURCE leg of KB ingestion: fetch a Gmail attachment through the
 * SAME download path gmail_get_attachment uses (fetchGmailAttachmentRaw — no
 * second download shape), extract its text with the knowledge-base-standard
 * extractors (the shared vision hop for images, extractTextFromBuffer for
 * PDF/DOCX/text), and file it as a ProjectDocument that processDocument
 * chunks + embeds like any other source.
 *
 * DEDUP (the ticket's explicit ask): one Gmail attachment maps to one KB doc —
 * the key `gmail://<messageId>/<filename>` is stored in ProjectDocument
 * .sourceUrl and a re-ingest of the SAME attachment (UI re-click, agent
 * re-call, auto-ingest hook firing twice) returns the existing doc instead of
 * creating a duplicate row. The check runs BEFORE the Gmail fetch, so a repeat
 * add costs one indexed query, not a download.
 *
 * Error docs REPLACE: a prior doc for the same key whose ingestion FAILED is
 * deleted (chunks cascade) and re-ingested fresh — a transient vision/extract
 * failure must not permanently pin a dead row against the key.
 *
 * Everything here mirrors add_knowledge_file's contract (housekeeping-tools):
 * editor+ access, the same caps (docs/project, chat/hour, user/day via the
 * shared Redis rate slots), the same extraction pipeline, the same
 * fire-and-forget processDocument. The ONE structural difference is the
 * gmail_attachment source tag + dedup key — and that a failed extraction is
 * RECORDED as an error doc (so the Files tab shows why the attachment didn't
 * land) rather than returned as a tool-level refusal: the UI caller wants a
 * row to render, not a thrown error.
 */
import prisma from '../../config/database';
import logger from '../../utils/logger';
import { fetchGmailAttachmentRaw } from './google/google-mcp';
import { describeImageForKnowledgeBase } from './documents.controller';
import { extractTextFromBuffer, processDocument } from './ingestion.service';
// Same caps as add_knowledge_file / the REST upload (review F9: import the
// single source so the limits never drift from account-tools).
import { KNOWLEDGE_CAPS } from './platform/account-tools';

/** Same per-file cap as add_knowledge_file / the REST upload (30 MB). */
const GMAIL_ATTACHMENT_MAX_BYTES = 30 * 1024 * 1024;

export type GmailIngestOutcome =
  | { outcome: 'created'; documentId: string; name: string; charCount: number; status: string }
  | { outcome: 'duplicate'; documentId: string; name: string; status: string }
  | { outcome: 'error'; reason: string; message: string };

/** Stable dedup key: ONE Gmail attachment (messageId + filename) = ONE KB doc.
 *  gmail-mcp resolves attachments by filename CASE-INSENSITIVELY (gmail.ts
 *  find a => a.filename.toLowerCase() === filename.toLowerCase()), so the key
 *  must be case-insensitive too (review F4): Invoice.PDF and invoice.pdf are
 *  ONE attachment. Both halves are URI-encoded (F11: a filename containing
 *  '/' must not blur the key's structure). */
export function gmailAttachmentDedupKey(messageId: string, filename: string): string {
  return `gmail://${encodeURIComponent(messageId)}/${encodeURIComponent(filename.toLowerCase())}`;
}

interface Envelope {
  filename?: string;
  mimeType?: string;
  size?: number;
  base64?: string;
  messageId?: string;
  attachmentId?: string;
}

function isImageMimeType(mimeType: string, filename: string): boolean {
  if (/^image\//i.test(mimeType)) return true;
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif|dib|jpe|jfif)$/i.test(filename);
}

/**
 * Ingest one Gmail attachment into a project's knowledge base.
 *
 * @param projectId target project (access already checked by the caller — REST
 *                  controller / tool executor both run getProjectAccess first)
 * @param userId    the acting user (doc owner, rate-slot subject)
 * @param messageId Gmail message id (from gmail_search / gmail_get_message)
 * @param filename  attachment filename (the stable handle — gmail-mcp resolves
 *                  by filename, case-insensitive; the dedup key's second half)
 * @param sessionId rate-slot subject ('chat hour' bucket)
 * @param label     optional connected-account label (parity with the read tools)
 */
export async function ingestGmailAttachment(opts: {
  projectId: string;
  userId: string;
  messageId: string;
  filename: string;
  sessionId?: string;
  label?: string;
  /** Skip the rate slots (the auto-ingest hook has its own per-run dedup guard). */
  skipRateCap?: boolean;
  /** Pre-fetched raw MCP answer (the auto-ingest hook passes the SAME download
   *  the agent's gmail_get_attachment just made — one fetch, not two). */
  raw?: { ok: boolean; result: string; envelope: boolean };
}): Promise<GmailIngestOutcome> {
  const { projectId, userId, messageId, filename } = opts;
  if (!messageId.trim() || !filename.trim()) {
    return { outcome: 'error', reason: 'invalid', message: 'messageId and filename are both required.' };
  }
  const dedupKey = gmailAttachmentDedupKey(messageId.trim(), filename.trim());

  // ── Dedup BEFORE the fetch: a repeat add costs one indexed query. ──────────
  const existing = await prisma.projectDocument.findFirst({
    where: { projectId, sourceUrl: dedupKey },
    select: { id: true, name: true, status: true, userId: true },
  });
  if (existing && existing.status !== 'error') {
    return { outcome: 'duplicate', documentId: existing.id, name: existing.name, status: existing.status };
  }

  // ── Caps (same contract as add_knowledge_file — the shared KNOWLEDGE_CAPS
  //     single source, review F9; hour-key TTL 7200 per HOUR_KEY_TTL). ────────
  const docCount = await prisma.projectDocument.count({ where: { projectId } });
  if (docCount >= KNOWLEDGE_CAPS.docsPerProject) {
    return { outcome: 'error', reason: 'project_full', message: `The project already has ${docCount} documents (cap ${KNOWLEDGE_CAPS.docsPerProject}).` };
  }
  if (!opts.skipRateCap && opts.sessionId) {
    try {
      const redis = (await import('../../config/redis')).default;
      const { rateKeys, consumeRateSlots } = await import('./platform/rate-slots');
      const { dayKey, hourKey } = rateKeys('knowledge', userId, opts.sessionId);
      const gate = await consumeRateSlots(redis as any, [
        { key: hourKey, cap: KNOWLEDGE_CAPS.chatHourly, ttlSec: KNOWLEDGE_CAPS.hourKeyTtl, scope: 'chat_hourly' },
        { key: dayKey, cap: KNOWLEDGE_CAPS.userDaily, ttlSec: KNOWLEDGE_CAPS.dayKeyTtl, scope: 'user_daily' },
      ]);
      if (!gate.ok) {
        return {
          outcome: 'error', reason: 'rate_limited', scope: gate.scope,
          message: gate.scope === 'chat_hourly'
            ? 'This chat already added 10 knowledge documents this hour.'
            : 'The user already added 50 knowledge documents today.',
        } as GmailIngestOutcome;
      }
    } catch { /* cap check unavailable — allow (fail-open, same as add_knowledge_file) */ }
  }

  // ── Fetch through the SAME download path gmail_get_attachment uses. ───────
  // (raw: the auto-ingest hook passes the SAME download the agent's own
  //  gmail_get_attachment just made — one fetch, not two.)
  const raw = opts.raw ?? await fetchGmailAttachmentRaw(userId, messageId, undefined, filename, opts.label);
  if (!raw.ok) {
    return { outcome: 'error', reason: 'not_found', message: raw.result || 'No matching Gmail attachment was found in any connected account.' };
  }
  if (!raw.envelope) {
    // Text-like attachment (inline content) or a hard download failure the
    // server surfaced — neither carries a base64 body we can file. The inline
    // text case has no filename-certain envelope; treat as unreadable rather
    // than guessing bytes.
    return { outcome: 'error', reason: 'unreadable', message: 'That attachment did not come back as a downloadable binary (text attachments are read inline at chat time instead).' };
  }
  let env: Envelope;
  try { env = JSON.parse(raw.result); } catch {
    return { outcome: 'error', reason: 'unreadable', message: 'The attachment envelope could not be parsed.' };
  }
  const buffer = Buffer.from(String(env.base64 || ''), 'base64');
  if (!buffer.length) {
    return { outcome: 'error', reason: 'unreadable', message: 'The attachment downloaded as an empty file.' };
  }
  if (buffer.length > GMAIL_ATTACHMENT_MAX_BYTES) {
    return { outcome: 'error', reason: 'too_large', message: `The attachment is ${buffer.length} bytes — the knowledge limit is ${GMAIL_ATTACHMENT_MAX_BYTES}.` };
  }
  const mimeType = env.mimeType || 'application/octet-stream';
  // F4: prefer the SERVER-RESOLVED filename (the actual name on the Gmail
  // message) over the caller's spelling — gmail-mcp resolves case-insensitively,
  // so 'Invoice.PDF' requested and 'invoice.pdf' resolved are ONE attachment
  // (the dedup key is already case-normalized; this keeps the display name
  // stable across case-variant re-adds).
  const resolvedName = (env.filename || '').trim() || filename.trim();
  const displayName = resolvedName.slice(0, KNOWLEDGE_CAPS.nameMax);

  // ── Extract with the KB-standard extractors (the SAME hop add_knowledge_file
  //    and the REST upload use — images through the vision seat, PDFs/DOCX
  //    through extractTextFromBuffer). A failure is RECORDED (error doc), not
  //    thrown: the Files tab should show why the attachment didn't land, and a
  //    retry replaces the row (error-doc-replace below). ─────────────────────
  let text: string | null = null;
  let extractionError: string | null = null;
  try {
    if (isImageMimeType(mimeType, displayName)) {
      text = await describeImageForKnowledgeBase(buffer, mimeType, displayName);
    } else {
      text = await extractTextFromBuffer(buffer, mimeType, displayName);
    }
  } catch (err: any) {
    extractionError = String(err?.message || err);
  }

  // ── Create-or-replace under the dedup key. ────────────────────────────────
  // (single-writer race note: the project cap + rate slots bound the damage of
  // a rare same-key double-create; the second row is a visible duplicate the
  // user can delete, never data loss)
  const data = {
    projectId,
    userId,
    name: displayName,
    mimeType,
    status: text && text.trim() ? 'processing' : 'error',
    charCount: text ? text.length : 0,
    source: 'gmail_attachment',
    sourceUrl: dedupKey,
    ...(extractionError ? { errorMsg: extractionError.slice(0, 500) } : {}),
    ...(text && !text.trim() ? { errorMsg: 'Could not extract any text from that attachment.' } : {}),
  };
  if (existing && existing.status === 'error') {
    await prisma.projectDocument.delete({ where: { id: existing.id } }); // chunks cascade
  }
  const doc = await prisma.projectDocument.create({ data });

  if (text && text.trim()) {
    const body = text;
    processDocument(doc.id, body).catch((err) => {
      logger.error(`gmail-knowledge: background ingestion failed for doc ${doc.id}:`, err);
    });
  }
  logger.info(`gmail-knowledge: ingested "${displayName}" (${messageId}) into project ${projectId} as ${doc.id} (${data.status})`);
  return { outcome: 'created', documentId: doc.id, name: displayName, charCount: data.charCount, status: data.status };
}

/**
 * AUTO-INGEST RULE (ticket 99145890 ask #2, optional leg): when a project has
 * autoIngestGmailAttachments enabled, every gmail_get_attachment the agent
 * runs in that project files the attachment into the KB automatically —
 * fire-and-forget, dedup-guarded (the dedup key makes the second download a
 * no-op), capped by the same knowledge rate slots.
 *
 * This is the ONLY settings gate for the auto path (review F2: the hook must
 * never call ingestGmailAttachment directly — that would harvest attachments
 * from EVERY project regardless of the setting).
 */
export async function autoIngestGmailAttachmentIfEnabled(opts: {
  projectId?: string | null;
  userId: string;
  messageId: string;
  filename?: string;
  sessionId?: string;
  label?: string;
  /** Pre-fetched raw MCP answer (the hook passes the SAME download the
   *  agent's gmail_get_attachment just made — one fetch, not two). */
  raw?: { ok: boolean; result: string; envelope: boolean };
}): Promise<void> {
  const { projectId, userId, messageId } = opts;
  const filename = (opts.filename || '').trim();
  // 'chat' is the ungrouped-chat sentinel (chat runs thread projectId: 'chat')
  // — there is no project KB to file into, and a dangling FK would make the
  // create throw. Guard it here so every caller is safe.
  if (!projectId || projectId === 'chat' || !filename || !messageId.trim()) return;
  try {
    const { getProjectSettings } = await import('./langgraph/memory.graph');
    const settings = await getProjectSettings(projectId);
    if (!settings.autoIngestGmailAttachments) return;
    // The dedup check inside ingestGmailAttachment makes this cheap: an already-
    // ingested attachment resolves 'duplicate' after one indexed query.
    await ingestGmailAttachment({
      projectId, userId, messageId, filename,
      sessionId: opts.sessionId,
      label: opts.label,
      raw: opts.raw,
    });
  } catch (err) {
    logger.warn(`gmail-knowledge: auto-ingest hook failed for ${messageId}/${filename} in ${projectId}: ${(err as Error).message}`);
  }
}

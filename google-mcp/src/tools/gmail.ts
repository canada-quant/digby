/**
 * Gmail tools for the Google Workspace MCP server.
 *
 * Uses the googleapis npm package with a pre-existing access token.
 * Functions are called with the user's Google access token — no OAuth flow here.
 */

import { google } from 'googleapis';
import { randomUUID } from 'crypto';
import { marked } from 'marked';

/**
 * RFC 2047 "encoded-word" for header values that contain non-ASCII characters
 * (e.g. a Subject with em/en-dashes or emoji). Without this, raw UTF-8 in a
 * header gets misread as Latin-1 by mail clients → mojibake ("– " → "Ã¢Â€Â“").
 */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

/** Lightly strip Markdown for the plain-text alternative part (readable fallback). */
function markdownToPlainText(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')                       // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1')                 // bold
    .replace(/__([^_]+)__/g, '$1')                     // bold (underscore)
    .replace(/`([^`]+)`/g, '$1')                       // inline code
    .replace(/^\s*[-*+]\s+/gm, '• ')                   // bullets
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')    // links → "text (url)"
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** base64-encode UTF-8 text with RFC 2045 76-char line wrapping (for MIME body parts). */
function base64Body(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64').replace(/(.{76})/g, '$1\r\n');
}

/**
 * Build a base64url-encoded RFC822 message as multipart/alternative:
 *   - text/plain  : Markdown stripped to readable text
 *   - text/html   : Markdown rendered (GFM tables, bold, lists) so the email looks formatted
 * Subject is RFC 2047 encoded; both body parts are base64 (safe for UTF-8 / emoji).
 */
function buildRawMessage(to: string, subject: string, body: string, cc?: string, bcc?: string): string {
  const boundary = `=_cm_${randomUUID()}`;
  const htmlInner = marked.parse(body, { gfm: true, breaks: true, async: false }) as string;
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>` +
    `body{font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a}` +
    `table{border-collapse:collapse;margin:12px 0}` +
    `th,td{border:1px solid #ccc;padding:6px 10px;text-align:left;vertical-align:top}` +
    `th{background:#f4f4f5}` +
    `h1,h2,h3{margin:16px 0 8px;line-height:1.25}` +
    `code{background:#f4f4f5;padding:1px 4px;border-radius:3px;font-family:Consolas,monospace}` +
    `blockquote{border-left:3px solid #ddd;margin:8px 0;padding:2px 12px;color:#555}` +
    `</style></head><body>${htmlInner}</body></html>`;

  const lines = [
    `To: ${to}`,
    cc  ? `Cc: ${cc}`   : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${encodeHeaderValue(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    base64Body(markdownToPlainText(body)),
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    base64Body(html),
    ``,
    `--${boundary}--`,
  ].filter(line => line !== null).join('\r\n');

  return Buffer.from(lines, 'utf-8').toString('base64url');
}

function getAuth(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

/** Format bytes to human-readable size */
function formatSize(bytes?: number | string | null): string {
  if (!bytes) return '';
  const n = typeof bytes === 'string' ? parseInt(bytes) : bytes;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/** Decode base64url-encoded Gmail message body */
function decodeBody(data?: string): string {
  if (!data) return '';
  try {
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * HTML → readable plain text: block-closing tags become newlines, tags strip,
 * the common entities decode (bank notices are full of &#39; / &amp; / &nbsp;),
 * runs of spaces/tabs collapse while newlines survive. Exported for the vitest
 * pins (gmail.test.ts).
 */
export function htmlToText(html: string): string {
  return html
    // Style/script blocks are not content — strip them whole before tag-stripping
    // (live-verified on a Chase notice: the <style> block led the extracted text).
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    // Normalize CRLF/CR → LF (Outlook-style bank notices are full of \r\n) BEFORE
    // the newline handling below, so empty paragraphs collapse cleanly.
    .replace(/\r\n?/g, '\n')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (m, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return m; }
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract plain text body from a Gmail message payload (prefers text/plain,
 * falls back to htmlToText-stripped HTML). Exported for the vitest pins.
 *
 * The single-part top-level text/html arm is the 2026-10-01 fix for tickets
 * 9a818013 / a7f6c4e4: Chase statement notices (e.g. message 1a0f932ac3cec309,
 * live-verified) arrive as a bare top-level text/html part with body.data and
 * NO parts array — this function previously handled only top-level text/plain
 * and multipart payloads, so every such message read as "(no body content)".
 */
export function extractBody(payload: any, maxChars = 3000): string {
  if (!payload) return '';

  // Single-part plain text
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBody(payload.body.data).substring(0, maxChars);
  }

  // Single-part HTML, no multipart wrapper — see the docblock above.
  if (payload.mimeType === 'text/html' && payload.body?.data && !Array.isArray(payload.parts)) {
    return htmlToText(decodeBody(payload.body.data)).substring(0, maxChars);
  }

  // Multipart — look for text/plain part
  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBody(part.body.data).substring(0, maxChars);
      }
      // Nested multipart
      if (part.parts) {
        const nested = extractBody(part, maxChars);
        if (nested) return nested;
      }
    }
    // Fallback to text/html if no plain text found
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return htmlToText(decodeBody(part.body.data)).substring(0, maxChars);
      }
    }
  }

  return '';
}

/** Get header value from Gmail message headers */
function getHeader(headers: any[], name: string): string {
  return headers?.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

// ── Attachment helpers ─────────────────────────────────────────────────────────

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

/** Recursively collect every attachment part (parts with a filename + attachmentId) from a payload. */
function extractAttachments(payload: any, out: AttachmentMeta[] = []): AttachmentMeta[] {
  if (!payload) return out;
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  for (const part of parts) {
    if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
      out.push({
        filename:     part.filename,
        mimeType:     part.mimeType || 'application/octet-stream',
        size:         Number(part.body.size || 0),
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) extractAttachments(part, out);
  }
  return out;
}

/** Run an async mapper over items with bounded concurrency (keeps Gmail API calls under control). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Mime types whose attachment content is useful to return as inline text. */
const TEXT_ATTACHMENT_MIME = /^(text\/|application\/(json|xml|x-ndjson|csv|rtf|x-yaml|yaml)|application\/[\w.\-]+\+xml)/i;

// ── Tool implementations ──────────────────────────────────────────────────────

/**
 * Interactive ceiling on how many messages one search returns. This is bounded by the LLM context
 * window and Gmail API latency (one get() per message), NOT picked arbitrarily — bulk processing of
 * thousands belongs in a background ingestion job, not a synchronous fetch. The total number of
 * matches is still reported (resultSizeEstimate) even when only a page is returned.
 */
const MAX_LIST_RESULTS = 300;
/** Attachments require a full per-message fetch; only enrich up to this many to stay within the request timeout. */
const ATTACHMENT_FETCH_LIMIT = 100;

/**
 * Search/list Gmail messages — returns a formatted summary list.
 *
 * Pages through the Gmail API to return up to `maxResults` matches (not just the
 * first page), so deep historical sweeps work. When `includeAttachments` is true
 * (default) each message lists its attachments (filename, size, attachmentId) so
 * the caller can download them with gmail_get_attachment.
 */
export async function gmailListMessages(
  accessToken: string,
  query = '',
  maxResults = 25,
  includeAttachments = true,
): Promise<string> {
  const auth   = getAuth(accessToken);
  const gmail  = google.gmail({ version: 'v1', auth });
  const target = Math.min(Math.max(Number(maxResults) || 25, 1), MAX_LIST_RESULTS);

  // Page through messages.list until we have `target` ids or run out. `resultSizeEstimate` (cheap,
  // returned by list) tells us the TOTAL number of matches even when we only return a page of them.
  const ids: string[] = [];
  let pageToken: string | undefined;
  let estimate = 0;
  do {
    const listRes = await gmail.users.messages.list({
      userId:     'me',
      q:           query || undefined,
      maxResults:  Math.min(100, target - ids.length),
      pageToken,
    });
    if (!estimate) estimate = Number(listRes.data.resultSizeEstimate || 0);
    for (const m of listRes.data.messages || []) {
      if (m.id) ids.push(m.id);
    }
    pageToken = listRes.data.nextPageToken || undefined;
  } while (pageToken && ids.length < target);

  if (ids.length === 0) {
    return query
      ? `No messages found for query: ${query}`
      : 'No messages found.';
  }

  // Attachments need a 'full' fetch per message (expensive). Only enrich when the result set is small
  // enough to finish within the request timeout; otherwise list metadata only (fast).
  const enrich = includeAttachments && ids.length <= ATTACHMENT_FETCH_LIMIT;
  const format = enrich ? 'full' : 'metadata';
  const details = await mapLimit(ids, 10, (id) =>
    gmail.users.messages.get({
      userId: 'me',
      id,
      format,
      ...(enrich ? {} : { metadataHeaders: ['Subject', 'From', 'To', 'Date'] }),
    }).then(r => r.data).catch(() => null)
  );

  const lines: string[] = [];
  let idx = 1;
  let withAttachments = 0;

  for (const data of details) {
    if (!data) continue;
    const headers  = data.payload?.headers || [];
    const subject  = getHeader(headers, 'Subject') || '(no subject)';
    const from     = getHeader(headers, 'From')    || 'Unknown';
    const to       = getHeader(headers, 'To')      || '';
    const date     = getHeader(headers, 'Date')    || '';
    const snippet  = data.snippet                  || '';
    const id       = data.id                       || '';
    const unread   = data.labelIds?.includes('UNREAD') ? '🔵 ' : '';

    const attachments = enrich ? extractAttachments(data.payload) : [];
    if (attachments.length > 0) withAttachments++;

    const attachLine = attachments.length > 0
      ? `\n   📎 Attachments (${attachments.length}): ` +
        attachments.map(a => `${a.filename} [${formatSize(a.size)}] (attachmentId: ${a.attachmentId})`).join('; ')
      : '';

    lines.push(
      `${idx}. ${unread}**${subject}**\n` +
      `   From: ${from}\n` +
      (to ? `   To: ${to}\n` : '') +
      `   Date: ${date}\n` +
      `   ID: ${id}\n` +
      `   Preview: ${snippet.substring(0, 160)}…` +
      attachLine
    );
    idx++;
  }

  const more = !!pageToken || estimate > lines.length;
  const header =
    `Showing ${lines.length} message(s)` +
    (estimate ? ` of ~${estimate} total match(es)` : '') +
    (query ? ` for query: ${query}` : '') +
    (enrich
      ? ` — ${withAttachments} with attachments`
      : (includeAttachments ? ` — attachments omitted (too many results; narrow to ≤${ATTACHMENT_FETCH_LIMIT} to list attachments inline)` : '')) +
    (more
      ? `. More matches exist beyond this page — narrow the query (sender / date range / subject), or use bulk import to ingest everything.`
      : '.');

  return `${header}\n\n${lines.join('\n\n')}`;
}

/**
 * Read a single Gmail message — returns full headers, body, and an attachment list.
 *
 * @param maxChars  How much of the body to return (default 15000). Long emails are truncated.
 */
export async function gmailReadMessage(
  accessToken: string,
  messageId: string,
  maxChars = 15000,
): Promise<string> {
  const auth   = getAuth(accessToken);
  const gmail  = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.get({
    userId: 'me',
    id:     messageId,
    format: 'full',
  });

  const msg         = res.data;
  const headers     = msg.payload?.headers || [];
  const subject     = getHeader(headers, 'Subject') || '(no subject)';
  const from        = getHeader(headers, 'From')    || 'Unknown';
  const to          = getHeader(headers, 'To')      || '';
  const cc          = getHeader(headers, 'Cc')      || '';
  const date        = getHeader(headers, 'Date')    || '';
  const body        = extractBody(msg.payload, Math.min(Math.max(Number(maxChars) || 15000, 500), 50000));
  const attachments = extractAttachments(msg.payload);

  const attachmentBlock = attachments.length > 0
    ? [
        ``,
        `── Attachments (${attachments.length}) ──`,
        ...attachments.map(a =>
          `• ${a.filename} (${a.mimeType}, ${formatSize(a.size)}) — attachmentId: ${a.attachmentId}`
        ),
        `(Download with gmail_get_attachment using messageId="${messageId}" — prefer the FILENAME (e.g. filename="${attachments[0].filename}"); attachmentIds rotate per fetch and expire within ~2 minutes, so a listed attachmentId only works immediately.)`,
      ].join('\n')
    : '';

  return [
    `Subject: ${subject}`,
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Date: ${date}`,
    `Message ID: ${messageId}`,
    ``,
    body || '(no body content)',
    attachmentBlock || null,
  ].filter(l => l !== null).join('\n');
}

/**
 * Download a single attachment from a Gmail message.
 *
 * - For text-like attachments (txt, csv, json, xml, …) the decoded text content is returned inline.
 * - For binary attachments (PDF, docx, images, …) the base64-encoded bytes are returned (under a size
 *   cap) so an automated caller (e.g. knowledge-base ingestion) can decode and process them.
 *
 * If `attachmentId` is omitted, `filename` is used to locate the attachment within the message.
 *
 * attachmentId rotation (tickets 9a818013 / a7f6c4e4, live-verified 2026-10-01; TTL re-measured
 * 2026-10-02): Gmail mints a FRESH attachmentId for every part on every `format=full` fetch — two
 * back-to-back fetches of the same message disagree on all of them — and a previously-minted ID
 * stays valid for download only for a SHORT window: live probes 2026-10-02 downloaded with a ~90s-old
 * ID but a ~150s-old and a ~210s-old ID both failed with HTTP 400 "Invalid attachment token" (the
 * earlier "valid for at least minutes" claim was wrong). So the attachmentId shown by
 * gmail_list_messages / gmail_read_message is a WEAK handle: it usually cannot exact-match the fresh
 * list this function fetches, and the stale-id direct download only works inside the TTL window.
 * FILENAME is the stable handle — it matches on this function's own fresh fetch. Callers should
 * pass filename when they have it, and the renders now say so. When the exact match fails we still
 * download DIRECTLY with the caller's ID (valid inside the TTL window) and correlate it back to a
 * fresh attachment by byte size (a part's payload body.size equals the downloaded attachment size —
 * verified). Outside the window the caller gets the real API error plus the fresh IDs to retry with.
 * Kill switch: GMAIL_STALE_ATTACHMENT_ID_FALLBACK_DISABLED=1 restores exact-match-only.
 */
export async function gmailGetAttachment(
  accessToken: string,
  messageId: string,
  attachmentId?: string,
  filename?: string,
): Promise<string> {
  const auth  = getAuth(accessToken);
  const gmail = google.gmail({ version: 'v1', auth });

  const staleFallbackDisabled = () =>
    ['1', 'true', 'on'].includes(String(process.env.GMAIL_STALE_ATTACHMENT_ID_FALLBACK_DISABLED ?? '').trim().toLowerCase());

  /** Human-readable Gmail API error (404 vs permission vs …) — the caller deserves
   *  the real reason, never a collapsed "not found" (ticket ask, 2026-10-01). */
  const describeGapiError = (e: unknown): string => {
    const anyE = e as any;
    const code = anyE?.response?.status ?? anyE?.code;
    const reason = anyE?.errors?.[0]?.reason ?? anyE?.error?.errors?.[0]?.reason;
    const msg = String(anyE?.message ?? 'unknown error');
    return [code ? `HTTP ${code}` : null, reason, msg].filter(Boolean).join(' — ');
  };

  // Resolve attachment metadata (filename, mimeType, id) from the message structure.
  const msgRes      = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const attachments = extractAttachments(msgRes.data.payload);

  if (attachments.length === 0) {
    return `Message ${messageId} has no attachments.`;
  }

  const meta =
    (attachmentId && attachments.find(a => a.attachmentId === attachmentId)) ||
    (filename && attachments.find(a => a.filename.toLowerCase() === filename.toLowerCase())) ||
    (!attachmentId && !filename && attachments.length === 1 ? attachments[0] : undefined);

  const download = async (id: string) => {
    const attRes  = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id });
    const dataB64 = attRes.data.data || '';
    return { buf: Buffer.from(dataB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), size: Number(attRes.data.size || 0) };
  };

  let resolved: { filename: string; mimeType: string; attachmentId: string; buf: Buffer } | null = null;
  let viaStaleFallback = false;
  let ambiguityNote: string | null = null;
  if (meta) {
    try {
      const d = await download(meta.attachmentId);
      resolved = { filename: meta.filename, mimeType: meta.mimeType, attachmentId: meta.attachmentId, buf: d.buf };
    } catch (e) {
      return `Attachment download failed in message ${messageId}: Gmail API ${describeGapiError(e)}. ` +
        `The message's current attachments are: ` +
        attachments.map(a => `${a.filename} (attachmentId: ${a.attachmentId})`).join('; ');
    }
  } else if (attachmentId && !staleFallbackDisabled()) {
    // Exact match failed — the ID was minted by an earlier fetch. It may still be
    // downloadable: try it directly and size-correlate it back to a fresh part.
    // Same-size ambiguity: the BYTES are always exactly what the caller's
    // attachmentId downloaded (that is the ask); only the filename/mimeType
    // header can mislabel when several fresh parts share the byte size — so the
    // download proceeds and the ambiguity is flagged honestly in the output.
    try {
      const d = await download(attachmentId);
      const bySize = attachments.filter(a => a.size === d.size);
      const correlated = bySize[0];
      viaStaleFallback = true;
      ambiguityNote = bySize.length > 1
        ? `${bySize.length} attachments share this byte size (${d.size} B) — the filename/mimeType above is the FIRST match; the downloaded bytes are exactly what the requested attachmentId returned.`
        : null;
      resolved = {
        filename:     correlated?.filename ?? 'attachment',
        mimeType:     correlated?.mimeType ?? 'application/octet-stream',
        attachmentId,
        buf:          d.buf,
      };
    } catch (e) {
      // The ID is genuinely dead — surface the real API error plus the fresh IDs
      // the caller can retry with (this text passes the backend client through to
      // the model; it is NOT one of the squelched not-found strings).
      return `Attachment download failed in message ${messageId}: Gmail API ${describeGapiError(e)}. ` +
        `The attachmentId may have expired — the message's current attachments are: ` +
        attachments.map(a => `${a.filename} (attachmentId: ${a.attachmentId})`).join('; ');
    }
  }

  if (!resolved) {
    return `Could not find that attachment in message ${messageId}. Available: ` +
      attachments.map(a => `${a.filename} (attachmentId: ${a.attachmentId})`).join('; ');
  }

  const headerLines = [
    `Filename: ${resolved.filename}`,
    `MimeType: ${resolved.mimeType}`,
    `Size: ${formatSize(resolved.buf.length)}`,
    `messageId: ${messageId}`,
    `attachmentId: ${resolved.attachmentId}`,
    ...(viaStaleFallback ? ['Resolved: stale-id-fallback (size-correlated)'] : []),
    ...(ambiguityNote ? [`Note: ${ambiguityNote}`] : []),
  ];

  // Text-like → return decoded content directly (useful as model context).
  if (TEXT_ATTACHMENT_MIME.test(resolved.mimeType) || /\.(txt|csv|json|md|xml|ya?ml|log)$/i.test(resolved.filename)) {
    const text = resolved.buf.toString('utf-8').substring(0, 20000);
    return [...headerLines, ``, `── Content ──`, text].join('\n');
  }

  // Binary → return base64 (capped) for downstream decoding/ingestion.
  const MAX_INLINE_BYTES = 25 * 1024 * 1024; // 25MB
  if (resolved.buf.length > MAX_INLINE_BYTES) {
    return [...headerLines, ``, `(Attachment is ${formatSize(resolved.buf.length)} — too large to return inline. Open it in Gmail.)`].join('\n');
  }

  return JSON.stringify({
    filename:     resolved.filename,
    mimeType:     resolved.mimeType,
    size:         resolved.buf.length,
    encoding:     'base64',
    base64:       resolved.buf.toString('base64'),
    messageId,
    attachmentId: resolved.attachmentId,
    ...(viaStaleFallback ? { resolvedVia: 'stale-id-fallback' } : {}),
    ...(ambiguityNote ? { sizeAmbiguous: true, ambiguityNote } : {}),
  });
}

/**
 * Send a Gmail email — returns the sent message ID.
 */
export async function gmailSendEmail(
  accessToken: string,
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string,
): Promise<string> {
  const auth   = getAuth(accessToken);
  const gmail  = google.gmail({ version: 'v1', auth });

  const raw = buildRawMessage(to, subject, body, cc, bcc);

  const res = await gmail.users.messages.send({
    userId:      'me',
    requestBody: { raw },
  });

  return res.data.id || 'sent';
}

/**
 * Create a Gmail draft — returns the draft ID.
 */
export async function gmailCreateDraft(
  accessToken: string,
  to: string,
  subject: string,
  body: string,
): Promise<string> {
  const auth   = getAuth(accessToken);
  const gmail  = google.gmail({ version: 'v1', auth });

  const raw = buildRawMessage(to, subject, body);

  const res = await gmail.users.drafts.create({
    userId:      'me',
    requestBody: { message: { raw } },
  });

  return res.data.id || 'draft-created';
}

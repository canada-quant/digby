/**
 * Google MCP Client
 *
 * Calls the self-hosted Google MCP container via JSON-RPC 2.0 / MCP Streamable HTTP.
 * Mirrors the pattern in mcp-search.ts but passes a per-user Google access token
 * via the X-Google-Token header (resolved from DB by the token manager).
 *
 * The Google MCP container runs at http://google-mcp-prod:8000 (Docker network).
 * It validates X-API-Key then forwards X-Google-Token to the inner MCP server.
 *
 * Returns formatted context strings. READS surface a failed call as ONE readable
 * line (2026-10-04, integrations/integration-error.ts) — Google rejected the
 * account's credentials (reconnect / "Update permissions") / rate-limited /
 * Google down / the google-mcp connector did not answer — instead of '' (which
 * the coding executor rendered as "No Gmail messages matched …", a failure
 * dressed as an empty result). Not-connected, a per-account not-found and
 * genuinely-empty results keep ''; WRITES are unchanged.
 * INTEGRATION_ERROR_SURFACE_DISABLED=1 restores the old silent ''.
 */

import axios from 'axios';
import logger from '../../../utils/logger';
import { getAllValidTokens, hasGoogleConnected } from './token-manager';
import { extractPdfText } from '../pdf-extract';
// A leaf (imports only 'path'; its own seat runtime is lazily required) — the
// magic-byte sniffer gmail attachments now route on (d3cfbb44).
import { detectImageMime } from '../coding/view-image';
import {
  IntegrationApiError, INTEGRATION_SERVICES, integrationErrorSurfaceDisabled, surfacedOrEmpty,
  connectorTransportError, mcpOperationLabel, classifyUpstreamErrorText, stripErrorPrefix,
} from '../integrations/integration-error';

const SERVICE = INTEGRATION_SERVICES.google;
/** Reads run strict (a failure throws IntegrationApiError) unless the kill switch is set. */
const strictRead = () => !integrationErrorSurfaceDisabled();
const opOf = (toolName: string) => mcpOperationLabel(toolName, '');

/** Fan-out failure → IntegrationApiError (a plain rejection — an isError the classifier did not recognise — keeps its words as kind 'other'). */
function asIntegrationError(toolName: string, err: any): IntegrationApiError {
  return err instanceof IntegrationApiError ? err : new IntegrationApiError(SERVICE, opOf(toolName), 'other', null, stripErrorPrefix(String(err?.message ?? err)));
}

/** Labeled failure lines for a strict fan-out (one account → the bare line). */
function failureSections(failures: Array<{ label: string; err: IntegrationApiError }>, accountCount: number): string[] {
  return failures.map(f => (accountCount > 1 ? `--- ${f.label} ---\n${f.err.message}` : f.err.message));
}

const GOOGLE_MCP_URL     = process.env.GOOGLE_MCP_URL || 'http://google-mcp-prod:8000/mcp';
const GOOGLE_MCP_API_KEY = process.env.GOOGLE_MCP_API_KEY;

// ── Core MCP call (SSE streaming response) ────────────────────────────────────

/**
 * Low-level MCP call using an explicit access token.
 * All callers should use this so multi-account fan-out is straightforward.
 */
/**
 * `strict` (reads only): a transport failure (gateway), a JSON-RPC error, a
 * missing server key and an isError part that classifies as auth / rate-limited
 * / down all reject with IntegrationApiError; an UNCLASSIFIED isError (not
 * found, no permission on that file) stays a plain Error so the try-every-
 * account readers keep treating it as "not this account". Non-strict (writes,
 * and reads under the kill switch) is byte-identical to before.
 */
async function callMcpWithToken(
  token: string,
  toolName: string,
  params: Record<string, unknown>,
  strict = false,
): Promise<string | null> {
  const op = opOf(toolName);
  if (!GOOGLE_MCP_API_KEY) {
    logger.warn(`Google MCP: GOOGLE_MCP_API_KEY not set, skipping ${toolName}`);
    if (strict) throw new IntegrationApiError(SERVICE, op, 'not_configured', null, 'GOOGLE_MCP_API_KEY unset');
    return null;
  }

  const requestId = Date.now() + Math.floor(Math.random() * 10000);

  try {
    const response = await axios.post(
      GOOGLE_MCP_URL,
      {
        jsonrpc: '2.0',
        method:  'tools/call',
        params:  { name: toolName, arguments: params },
        id:      requestId,
      },
      {
        headers: {
          'Content-Type':   'application/json',
          'Accept':         'application/json, text/event-stream',
          'X-API-Key':      GOOGLE_MCP_API_KEY,
          'X-Google-Token': token,
        },
        timeout:      25000,
        responseType: 'stream',
      }
    );

    return new Promise((resolve, reject) => {
      const stream = response.data;
      let buffer   = '';
      let resolved = false;

      const safetyTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          stream.destroy();
          const e = new Error(`Google MCP ${toolName} timed out`);
          reject(strict ? connectorTransportError(SERVICE, op, e) : e);
        }
      }, 25000);

      stream.on('data', (chunk: Buffer) => {
        if (resolved) return;
        buffer += chunk.toString();

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const rawJson = trimmed.slice(5).trim();
          if (!rawJson || rawJson === '[DONE]') continue;

          try {
            const parsed = JSON.parse(rawJson);
            if (parsed.id !== requestId) continue;

            resolved = true;
            clearTimeout(safetyTimer);
            stream.destroy();

            if (parsed.error) {
              reject(strict
                ? new IntegrationApiError(SERVICE, op, 'other', null, `MCP error: ${parsed.error.message || 'unknown'}`)
                : new Error(parsed.error.message || 'MCP error'));
              return;
            }

            const content = parsed.result?.content;
            if (!content || !Array.isArray(content)) { resolve(null); return; }
            const text = content.find((c: any) => c.type === 'text')?.text || null;
            // The MCP SDK wraps a thrown tool error as a NORMAL result with
            // isError — reject so multi-account loops try the next account
            // instead of returning "Error: …" text as if it were content.
            if (parsed.result?.isError) {
              const kind = strict && text ? classifyUpstreamErrorText(text) : null;
              reject(kind
                ? new IntegrationApiError(SERVICE, op, kind, null, stripErrorPrefix(text as string))
                : new Error(text || `MCP tool ${toolName} error`));
              return;
            }
            resolve(text);
          } catch { /* skip non-JSON SSE lines */ }
        }
      });

      stream.on('error', (err: Error) => {
        if (!resolved) { resolved = true; clearTimeout(safetyTimer); reject(strict ? connectorTransportError(SERVICE, op, err) : err); }
      });

      stream.on('end', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(safetyTimer);
          const e = new Error(`SSE stream ended without response for ${toolName}`);
          reject(strict ? connectorTransportError(SERVICE, op, e) : e);
        }
      });
    });
  } catch (error: any) {
    logger.warn(`Google MCP ${toolName} failed: ${error.message}`);
    if (strict) throw connectorTransportError(SERVICE, op, error);
    return null;
  }
}

// ── Account resolution (labels) ───────────────────────────────────────────────

export type GoogleAccountResolution =
  | { ok: true; token: string }
  | { ok: false; reason: 'not_connected' | 'refresh_failed' | 'label_not_found'; message: string };

const normLabel = (s: string) => s.trim().toLowerCase();

/**
 * Match a caller-supplied account label against a connected account. The only
 * place models ever SEE labels is the fan-out section headers, which render
 * '--- Label (email) ---' — so accept the bare label, the email address, and
 * the full displayed composite, all case-insensitively, instead of demanding
 * the exact-case DB value (which made every mislabeled read a false
 * "not found", user reports 2026-08-08→08-11).
 */
function accountMatchesLabel(account: { label: string; email?: string }, raw: string): boolean {
  const wanted = normLabel(raw);
  if (!wanted) return false;
  if (normLabel(account.label) === wanted) return true;
  if (account.email) {
    if (normLabel(account.email) === wanted) return true;
    if (normLabel(`${account.label} (${account.email})`) === wanted) return true;
    // 'Anything (email)' composite still resolves on the email half.
    const m = /\(([^()]+)\)\s*$/.exec(raw);
    if (m && normLabel(m[1]) === normLabel(account.email)) return true;
  }
  return false;
}

/** Displayed form of the connected accounts — for error messages the model can act on. */
function formatAccountList(accounts: Array<{ label: string; email?: string }>): string {
  return accounts.map(a => (a.email ? `${a.label} (${a.email})` : a.label)).join(', ');
}

/**
 * Resolve a connected Google account to a live access token, distinguishing
 * WHY resolution failed (not connected / token refresh failed / bad label) so
 * callers can surface an actionable message instead of a generic "no result".
 */
export async function resolveGoogleAccount(userId: string, label?: string): Promise<GoogleAccountResolution> {
  const accounts = await getAllValidTokens(userId);
  if (accounts.length === 0) {
    const connected = await hasGoogleConnected(userId);
    return connected
      ? { ok: false, reason: 'refresh_failed', message: 'Google is connected but its access token could not be refreshed — reconnect the account in Settings → Integrations.' }
      : { ok: false, reason: 'not_connected', message: 'Google is not connected — connect an account in Settings → Integrations.' };
  }
  if (!label) return { ok: true, token: accounts[0].token }; // deterministic first-connected default
  const match = accounts.find(a => accountMatchesLabel(a, label));
  if (match) return { ok: true, token: match.token };
  return {
    ok: false,
    reason: 'label_not_found',
    message: `No connected Google account matches "${label}". Connected accounts: ${formatAccountList(accounts)}. Pass the bare label or the email address (case-insensitive).`,
  };
}

/**
 * Convenience wrapper: resolves a connected account token for userId (label
 * fuzzy-matched; omitted → first connected), then calls the MCP tool.
 */
async function callGoogleMcpTool(
  userId: string,
  toolName: string,
  params: Record<string, unknown>,
  label?: string,
  strict = false,
): Promise<string | null> {
  const account = await resolveGoogleAccount(userId, label);
  if (!account.ok) {
    logger.warn(`Google MCP: ${account.reason} for userId=${userId}${label ? ` (label=${label})` : ''}, skipping ${toolName}`);
    return null;
  }
  return callMcpWithToken(account.token, toolName, params, strict);
}

/**
 * Strict fan-out across every connected account (gmail list / calendar / drive
 * list): any rejected leg is a REAL failure for that account. All failed → the
 * failure lines are the answer; some failed → they ride under the successful
 * sections. Non-strict drops failed legs exactly as before.
 */
async function fanOut(
  accounts: Array<{ token: string; label: string; email?: string }>,
  toolName: string,
  params: Record<string, unknown>,
): Promise<{ sections: string[]; failureText: string }> {
  const strict = strictRead();
  const failures: Array<{ label: string; err: IntegrationApiError }> = [];
  const settled = await Promise.allSettled(
    accounts.map(async (account) => {
      const label = account.email ? `${account.label} (${account.email})` : account.label;
      let result: string | null;
      try {
        result = await callMcpWithToken(account.token, toolName, params, strict);
      } catch (err: any) {
        if (strict) failures.push({ label, err: asIntegrationError(toolName, err) });
        throw err;
      }
      if (!result) return null;
      return `--- ${label} ---\n${result}`;
    })
  );
  const sections = settled
    .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);
  if (sections.length > 0) sections.push(...failureSections(failures, 2));
  return { sections, failureText: sections.length === 0 ? failureSections(failures, accounts.length).join('\n') : '' };
}

/**
 * Strict try-every-account bookkeeping: an IntegrationApiError (auth / rate /
 * down / gateway / MCP error) on an account is kept; a plain Error (not found /
 * no access on THIS account) is the expected miss and is not. When no account
 * produced an answer the first kept failure is returned instead of ''.
 */
function firstSurfaced(errors: unknown[]): string {
  if (!strictRead()) return '';
  for (const e of errors) if (e instanceof IntegrationApiError) return e.message;
  return '';
}

// ── Public tool functions ─────────────────────────────────────────────────────

/**
 * List Gmail messages from ALL connected Google accounts / workspaces.
 * Queries each account in parallel and labels the results with the account name.
 * This mirrors the multi-account fan-out pattern used by getCalendarEvents().
 *
 * Previously only queried the first connected account — users with multiple
 * Google accounts (e.g. example-user@example.com) would never see emails from
 * non-primary accounts.
 */
export async function getGmailMessages(
  userId: string,
  query = '',
  maxResults = 25,
): Promise<string> {
  try {
    const accounts = await getAllValidTokens(userId);

    if (accounts.length === 0) return '';

    // Fan-out: query every connected account simultaneously
    const { sections, failureText } = await fanOut(accounts, 'gmail_list_messages', {
      query: query || undefined,
      maxResults,
    });

    if (sections.length === 0) return failureText;

    logger.info(
      `Google MCP: gmail_list_messages for userId=${userId} across ${accounts.length} account(s), query="${query}"`
    );
    return `[Gmail Messages]\n${sections.join('\n\n')}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

/**
 * Read a single Gmail message by ID. Returns formatted text. Pass label to read
 * from a specific connected account; without it, tries every connected account
 * (message IDs are account-specific — the old first-connected default 404'd
 * real messages living in a second account).
 */
export async function getGmailMessage(userId: string, messageId: string, label?: string): Promise<string> {
  try {
    if (label) {
      const result = await callGoogleMcpTool(userId, 'gmail_read_message', { messageId }, label, strictRead());
      return result ? `[Gmail Message]\n${result}` : '';
    }
    const accounts = await getAllValidTokens(userId);
    const errors: unknown[] = [];
    for (const account of accounts) {
      try {
        const result = await callMcpWithToken(account.token, 'gmail_read_message', { messageId }, strictRead());
        if (result) return `[Gmail Message]\n${result}`;
      } catch (e) { errors.push(e); /* message not in this account — try the next */ }
    }
    return firstSurfaced(errors);
  } catch (err) { return surfacedOrEmpty(err); }
}

/**
 * gmail_get_attachment returns binary attachments as a base64 JSON envelope —
 * unreadable to the answering model and transcript-bloating (feedback 9abf588f:
 * a PDF quote "failed to download" repeatedly even though the fetch succeeded).
 * Post-process the envelope here: PDFs go through the shared SOTA extractor
 * (pdf-parse + Gemini OCR fallback — the same path chat uploads use), DOCX
 * through mammoth, returning model-readable text. Images (d3cfbb44) are
 * described by the shared vision hop (image-describe.ts — the Image reader
 * seat, HEIC converted to JPEG inside, the same hop view_image and chat
 * uploads' analyzer use). Other binaries keep the base64 envelope, and every
 * extraction failure falls back to it unchanged.
 */
async function attachmentEnvelopeToText(result: string): Promise<string> {
  let env: { filename?: string; mimeType?: string; encoding?: string; base64?: string; resolvedVia?: string; sizeAmbiguous?: boolean; ambiguityNote?: string };
  try { env = JSON.parse(result); } catch { return result; }
  if (!env || env.encoding !== 'base64' || typeof env.base64 !== 'string' || !env.filename) return result;

  const buf    = Buffer.from(env.base64, 'base64');
  // Preserve the gmail-mcp server's resolution markers (tickets 9a818013/a7f6c4e4):
  // resolvedVia:'stale-id-fallback' says the caller's ROTATED attachmentId was
  // downloaded directly — the coding-integrations metric AND the agent's picture of
  // which path served the bytes both key on this string surviving the rebuild.
  const markers = [
    ...(env.resolvedVia ? [`Resolved: ${env.resolvedVia}`] : []),
    ...(env.sizeAmbiguous && env.ambiguityNote ? [`Note: ${env.ambiguityNote}`] : []),
  ];
  const header = `Filename: ${env.filename}\nMimeType: ${env.mimeType || 'application/octet-stream'}\nSize: ${buf.length} bytes${markers.length ? `\n${markers.join('\n')}` : ''}`;
  try {
    if (env.mimeType === 'application/pdf' || /\.pdf$/i.test(env.filename)) {
      const text = (await extractPdfText(buf, env.filename)).trim();
      if (text) return `${header}\n\n── Extracted text ──\n${text.substring(0, 20000)}`;
    } else if (/wordprocessingml|msword/i.test(env.mimeType || '') || /\.docx?$/i.test(env.filename)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mammoth = require('mammoth');
      const { value } = await mammoth.extractRawText({ buffer: buf });
      if (value && value.trim()) return `${header}\n\n── Extracted text ──\n${value.trim().substring(0, 20000)}`;
    } else if (isImageMime(env.mimeType || '', env.filename, buf)) {
      // Images (d3cfbb44): photographed documents emailed as IMG_xxxx.HEIC/JPG
      // were unreadable — a base64 blob the answering model cannot see. Route
      // the bytes to the shared vision hop (the Image reader seat — the same
      // one view_image, chat-upload analysis and the KB ingester use) and
      // return its description as model-readable text.
      return await imageAttachmentToText(result, buf, env, header);
    }
  } catch (e) {
    logger.warn('getGmailAttachment: text extraction failed — returning base64 envelope unchanged:', e);
  }
  return result;
}

// ── Image attachments (d3cfbb44) ────────────────────────────────────────────

/** Vision-cap bytes cap, matching the coding view_image tool (VIEW_IMAGE_MAX_BYTES). */
const GMAIL_ATTACHMENT_MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** Kill switch: images fall back to the base64 envelope (the pre-d3cfbb44 shape). */
export function gmailAttachmentVisionDisabled(): boolean {
  const v = String(process.env.GMAIL_ATTACHMENT_VISION_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * An attachment is an image when EITHER its declared mime or its extension
 * says image AND the magic bytes confirm it (view-image.ts detectImageMime —
 * PNG/JPEG/GIF/WebP/BMP/HEIC). The double gate keeps a mislabeled binary
 * (e.g. application/octet-stream IMG_0754.HEIC — Gmail sometimes serves
 * exactly that) readable while a non-image can never be routed to the vision
 * seat: the sniffer names the mime the BYTES prove, so the hop receives the
 * right format and HEIC is detected even without a declared mime.
 */
function isImageMime(declared: string, filename: string, buf: Buffer): boolean {
  const declaredIsImage = /^image\//i.test(declared);
  const nameIsImage     = /\.(png|jpe?g|gif|webp|bmp|heic|heif|dib|jpe|jfif)$/i.test(filename);
  if (!declaredIsImage && !nameIsImage) return false;
  return detectImageMime(buf, filename) !== null;
}

/** Framing for the vision description (header + the seat's answer). */
async function imageAttachmentToText(
  result: string, // the ORIGINAL envelope string — every fallback returns it verbatim
  buf: Buffer,
  env: { filename?: string; mimeType?: string },
  header: string,
): Promise<string> {
  if (gmailAttachmentVisionDisabled()) return result;
  if (buf.length > GMAIL_ATTACHMENT_MAX_IMAGE_BYTES) {
    // Honest, actionable, and cheap: the answer must not bloat the transcript
    // with megabytes of base64 the model cannot read anyway.
    return `${header}\n\nThis image attachment was downloaded but is too large for the vision reader (${(buf.length / (1024 * 1024)).toFixed(1)} MB > the ${GMAIL_ATTACHMENT_MAX_IMAGE_BYTES / (1024 * 1024)} MB cap), so its content could not be read. Ask the user to send a smaller version or a PDF (PDFs are text-extracted).`;
  }
  try {
    // Lazy require (the mammoth precedent): image-describe pulls the seat
    // runtime; google-mcp's module graph stays unchanged for its suites.
    const { describeImageWithVision } = require('../image-describe') as typeof import('../image-describe');
    // The sniffer names the mime the BYTES prove (a declared image/octet-stream
    // HEIC still routes correctly); the declared mime is only a last resort.
    const mime = detectImageMime(buf, env.filename || '') || env.mimeType || 'image/png';
    const description = await describeImageWithVision(buf, mime, env.filename || 'attachment');
    return `${header}\n\n── Image description (rendered by the vision model) ──\n${description}`;
  } catch (e) {
    logger.warn('getGmailAttachment: image description failed — returning base64 envelope unchanged:', e);
    // The envelope unchanged (the documented fallback): the model can still
    // relay the filename/mime/size facts to the user.
    return result;
  }
}

/**
 * Download a single Gmail attachment. With `label`, reads from that specific
 * connected account (feedback cb6a90b1 — parity with the other Google read
 * tools after #192); without it, tries every connected account (message IDs are
 * account-specific), returning the first account that has the attachment. Text
 * files come back as inline text; PDF/DOCX binaries as extracted text; images
 * (HEIC/JPG/PNG…) as a vision-model description (d3cfbb44); other binaries as
 * base64 JSON. Returns '' only when nothing downloadable was found.
 *
 * 2026-10-01 (tickets 9a818013 / a7f6c4e4): the gmail-mcp server now resolves
 * rotated (stale-but-valid) attachmentIds by downloading directly with the
 * caller's ID and surface real Gmail API errors — those answers are CONTENT, so
 * the old squelch (which dropped every per-account "Could not find that
 * attachment" to '' and left the agent a generic "No matching Gmail attachment")
 * is narrowed to the two genuinely-empty markers. Per-account outcomes are
 * logged so a dead download path is attributable in the box logs.
 */
const ATTACHMENT_EMPTY_RE = /^(Message .+ has no attachments\.|Could not find that attachment in message .+\.)/;

/**
 * The raw gmail-mcp answer for one attachment, BEFORE the model-oriented
 * `attachmentEnvelopeToText` post-processing (ticket 99145890): the KB
 * ingestion service needs the ORIGINAL envelope (filename/mimeType/base64/
 * messageId) so it can run the knowledge-base-standard extractors itself,
 * not the chat-optimized text.
 *
 *  ok        — true when `result` is CONTENT: a base64 JSON envelope (binary
 *              attachment, `envelope:true`), the header+content text of a
 *              text-like attachment, or a hard per-account download failure
 *              surfaced by the server (the caller decides how to treat it).
 *  result    — the raw MCP answer verbatim ('' when nothing was found).
 *  envelope  — true when result parses as the base64 JSON envelope shape.
 */
export interface GmailAttachmentRaw {
  ok: boolean;
  result: string;
  envelope: boolean;
}

function isEnvelopeResult(result: string): boolean {
  try {
    const env = JSON.parse(result);
    return !!(env && env.encoding === 'base64' && typeof env.base64 === 'string' && env.filename);
  } catch { return false; }
}

/**
 * Fetch the RAW gmail-mcp answer for one attachment (no envelope→text
 * post-processing). Account resolution, error surfacing and the
 * try-every-account loop are IDENTICAL to getGmailAttachment — this is the
 * same body split out so the KB ingester (gmail-knowledge.service) can share
 * the download path without a second Gmail API call shape.
 */
export async function fetchGmailAttachmentRaw(
  userId: string,
  messageId: string,
  attachmentId?: string,
  filename?: string,
  label?: string,
): Promise<GmailAttachmentRaw> {
  const args: Record<string, unknown> = { messageId };
  if (attachmentId) args.attachmentId = attachmentId;
  if (filename)     args.filename     = filename;

  try {
    // Named account → go straight to it instead of the try-every-account loop
    // (the loop can mask a per-account failure and fans out duplicate reads).
    if (label) {
      const account = await resolveGoogleAccount(userId, label);
      if (!account.ok) return { ok: false, result: '', envelope: false };
      const result = await callMcpWithToken(account.token, 'gmail_get_attachment', args, strictRead());
      if (!result) return { ok: false, result: '', envelope: false };
      if (ATTACHMENT_EMPTY_RE.test(result)) {
        logger.warn(`Google MCP: gmail_get_attachment userId=${userId} messageId=${messageId} account=${label}: no/unknown attachment`);
        return { ok: false, result: '', envelope: false };
      }
      return { ok: true, result, envelope: isEnvelopeResult(result) };
    }
    const accounts = await getAllValidTokens(userId);
    const errors: unknown[] = [];
    for (const account of accounts) {
      try {
        const result = await callMcpWithToken(account.token, 'gmail_get_attachment', args, strictRead());
        if (!result) continue;
        // A hard download failure (real Gmail API error, surfaced by the server) can
        // only come from the account that OWNS the message — non-owners reject on the
        // message fetch itself — so it is the actionable answer: return it.
        if (/^Attachment download failed/.test(result)) {
          logger.warn(`Google MCP: gmail_get_attachment userId=${userId} messageId=${messageId} account=${account.label}: ${result.substring(0, 160)}`);
          return { ok: true, result, envelope: false };
        }
        // Skip accounts that don't own this message (404 → null) or report no/unknown attachment.
        if (ATTACHMENT_EMPTY_RE.test(result)) continue;
        return { ok: true, result, envelope: isEnvelopeResult(result) };
      } catch (e) {
        logger.warn(`Google MCP: gmail_get_attachment userId=${userId} messageId=${messageId} account=${account.label} failed: ${(e as Error).message}`);
        errors.push(e);
        /* try the next account */
      }
    }
    logger.warn(`Google MCP: gmail_get_attachment userId=${userId} messageId=${messageId}: no account produced a download (tried ${accounts.length})`);
    return { ok: false, result: firstSurfaced(errors), envelope: false };
  } catch (err) { return { ok: false, result: surfacedOrEmpty(err), envelope: false }; }
}

export async function getGmailAttachment(
  userId: string,
  messageId: string,
  attachmentId?: string,
  filename?: string,
  label?: string,
): Promise<string> {
  const fetched = await fetchGmailAttachmentRaw(userId, messageId, attachmentId, filename, label);
  if (!fetched.ok) return fetched.result;
  return attachmentEnvelopeToText(fetched.result);
}

/**
 * Render a fetchGmailAttachmentRaw answer as the agent-facing text (the same
 * transform getGmailAttachment applies) — lets a caller that needs the RAW
 * envelope too (the 99145890 auto-ingest hook) share ONE download instead of
 * fetching twice.
 */
export async function gmailAttachmentTextFromRaw(raw: GmailAttachmentRaw): Promise<string> {
  return raw.ok ? attachmentEnvelopeToText(raw.result) : raw.result;
}

/**
 * List upcoming calendar events from ALL connected Google accounts / workspaces.
 * Queries each account in parallel and labels the results with the account name.
 * Defaults to next 7 days.
 * @param displayTimezone  Optional IANA timezone (e.g. "America/New_York") to display
 *                         all event times in the user's local timezone.
 */
export async function getCalendarEvents(
  userId: string,
  timeMin?: string,
  timeMax?: string,
  maxResults = 10,
  displayTimezone?: string,
): Promise<string> {
  try {
    const now = new Date();
    const accounts = await getAllValidTokens(userId);

    if (accounts.length === 0) return '';

    // Fan-out: query every connected workspace simultaneously
    const { sections, failureText } = await fanOut(accounts, 'calendar_list_events', {
      timeMin: timeMin || now.toISOString(),
      timeMax: timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      maxResults,
      ...(displayTimezone ? { displayTimezone } : {}),
    });

    if (sections.length === 0) return failureText;

    logger.info(
      `Google MCP: calendar_list_events for userId=${userId} across ${accounts.length} account(s)`
    );
    return `[Google Calendar Events]\n${sections.join('\n\n')}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

/**
 * List files in Google Drive. Pass label to search a specific connected
 * account; without it, fans out across ALL connected accounts with the same
 * '--- Label (email) ---' section headers gmail/calendar use (a second-account
 * Drive doc was previously undiscoverable without an exact label).
 */
export async function listDriveFiles(userId: string, query = '', label?: string): Promise<string> {
  try {
    if (label) {
      const result = await callGoogleMcpTool(userId, 'drive_list_files', { query, maxResults: 10 }, label, strictRead());
      return result ? `[Google Drive Files]\n${result}` : '';
    }
    const accounts = await getAllValidTokens(userId);
    if (accounts.length === 0) return '';

    const { sections, failureText } = await fanOut(accounts, 'drive_list_files', { query, maxResults: 10 });

    if (sections.length === 0) return failureText;

    logger.info(
      `Google MCP: drive_list_files for userId=${userId} across ${accounts.length} account(s), query="${query}"`
    );
    return `[Google Drive Files]\n${sections.join('\n\n')}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

/**
 * Read the text content of a Google Doc. Pass label to read from a specific
 * connected account; without it, tries every connected account (document
 * access is account-specific — first account that can read it wins).
 */
export async function getDocContent(userId: string, documentId: string, label?: string): Promise<string> {
  try {
    if (label) {
      const result = await callGoogleMcpTool(userId, 'docs_read_document', { documentId }, label, strictRead());
      return result ? `[Google Doc Content]\n${result}` : '';
    }
    const accounts = await getAllValidTokens(userId);
    const errors: unknown[] = [];
    for (const account of accounts) {
      try {
        const result = await callMcpWithToken(account.token, 'docs_read_document', { documentId }, strictRead());
        if (result) return `[Google Doc Content]\n${result}`;
      } catch (e) { errors.push(e); /* not accessible from this account — try the next */ }
    }
    return firstSurfaced(errors);
  } catch (err) { return surfacedOrEmpty(err); }
}

/**
 * Read data from a Google Sheet. Pass label to read from a specific connected
 * account; without it, tries every connected account (first that can read it wins).
 */
export async function getSheetData(
  userId: string,
  spreadsheetId: string,
  range = '',
  label?: string,
): Promise<string> {
  try {
    if (label) {
      const result = await callGoogleMcpTool(userId, 'sheets_read_data', { spreadsheetId, range }, label, strictRead());
      return result ? `[Google Sheets Data]\n${result}` : '';
    }
    const accounts = await getAllValidTokens(userId);
    const errors: unknown[] = [];
    for (const account of accounts) {
      try {
        const result = await callMcpWithToken(account.token, 'sheets_read_data', { spreadsheetId, range }, strictRead());
        if (result) return `[Google Sheets Data]\n${result}`;
      } catch (e) { errors.push(e); /* not accessible from this account — try the next */ }
    }
    return firstSurfaced(errors);
  } catch (err) { return surfacedOrEmpty(err); }
}

/**
 * Send a Gmail email on behalf of the user.
 * NOTE: This is called only after explicit user confirmation in the chat UI.
 */
// ── Write helpers (2026-09-23, owner: "add all of that") ──────────────────────
// Writes NEVER fan out across accounts (a read may try every connected account;
// a write must land in exactly one). Resolution: the label when given; the only
// account when one is connected; otherwise a refusal naming the accounts. The
// account's GRANTED scopes are checked BEFORE the call so an account connected
// before the write scopes existed answers with the re-consent instruction
// (Account → Integrations → "Update permissions") instead of a Google 403.
import { missingScopesForTool, scopeShortName } from './google-scopes';

export type GoogleWriteResolution =
  | { ok: true; token: string; label: string; email?: string }
  | { ok: false; reason: 'not_connected' | 'refresh_failed' | 'label_not_found' | 'ambiguous' | 'missing_scopes'; message: string };

export async function resolveGoogleWriteAccount(userId: string, tool: string, label?: string): Promise<GoogleWriteResolution> {
  const accounts = await getAllValidTokens(userId);
  if (accounts.length === 0) {
    const connected = await hasGoogleConnected(userId);
    return connected
      ? { ok: false, reason: 'refresh_failed', message: 'Google is connected but its access token could not be refreshed — reconnect the account in Account → Integrations.' }
      : { ok: false, reason: 'not_connected', message: 'Google is not connected — connect an account in Account → Integrations first.' };
  }
  let chosen = accounts[0];
  if (label) {
    const match = accounts.find(a => accountMatchesLabel(a, label));
    if (!match) {
      return { ok: false, reason: 'label_not_found', message: `No connected Google account matches "${label}". Connected accounts: ${formatAccountList(accounts)}. Pass the bare label or the email address.` };
    }
    chosen = match;
  } else if (accounts.length > 1) {
    return { ok: false, reason: 'ambiguous', message: `This is a WRITE and ${accounts.length} Google accounts are connected (${formatAccountList(accounts)}) — pass label to say which account the change belongs to.` };
  }
  let granted: string[] = [];
  try {
    // Dynamic import (import-graph discipline): config/database pulls config/env,
    // which process.exit()s under test without env — the read path never needed it.
    const { default: prisma } = await import('../../../config/database');
    const row = await (prisma as any).googleOAuthToken.findFirst({ where: { userId, label: chosen.label }, select: { scopes: true } });
    granted = Array.isArray(row?.scopes) ? row.scopes : [];
  } catch { granted = []; }
  const missing = missingScopesForTool(tool, granted);
  if (missing.length) {
    return {
      ok: false, reason: 'missing_scopes',
      message: `The Google account "${chosen.label}"${chosen.email ? ` (${chosen.email})` : ''} was connected without the ${missing.map(scopeShortName).join(', ')} permission that ${tool} needs. The user must open Account → Integrations → Google → "Update permissions" for that account (a quick re-consent) — you cannot grant it yourself. Say that plainly; do not retry.`,
    };
  }
  return { ok: true, token: chosen.token, label: chosen.label, email: chosen.email };
}

/** Run one WRITE tool on exactly one account; returns the MCP text or a refusal message. */
export async function runGoogleWriteTool(
  userId: string,
  tool: string,
  params: Record<string, unknown>,
  label?: string,
): Promise<{ ok: boolean; text: string; account?: string; reason?: string }> {
  const acct = await resolveGoogleWriteAccount(userId, tool, label);
  if (!acct.ok) return { ok: false, text: acct.message, reason: acct.reason };
  try {
    const result = await callMcpWithToken(acct.token, tool, params);
    if (!result) return { ok: false, text: `Google ${tool} returned no result — the MCP bridge may be down; try again in a minute.`, reason: 'no_result' };
    logger.info(`Google MCP: ${tool} for userId=${userId} account=${acct.label}`);
    return { ok: true, text: result, account: acct.email ? `${acct.label} (${acct.email})` : acct.label };
  } catch (error: any) {
    const detail = String(error?.response?.data?.error?.message ?? error?.message ?? error).slice(0, 300);
    return { ok: false, text: `Google ${tool} failed: ${detail}` };
  }
}

export async function sendGmailEmail(
  userId: string,
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string,
  label?: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const result = await callGoogleMcpTool(userId, 'gmail_send_email', {
      to, subject, body,
      ...(cc  && { cc }),
      ...(bcc && { bcc }),
    }, label);
    if (!result) return { success: false, error: 'No response from Gmail tool' };
    logger.info(`Google MCP: gmail_send_email for userId=${userId} to=${to}${label ? ` from=${label}` : ''}`);
    return { success: true, messageId: result };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Digby Code — chat FILE attachments (coding-session runs + steer).
 *
 * Feedback 7f546b03: a file uploaded into a coding-session chat never reached
 * the coding agent AS A FILE — chat uploads (POST /crossmodel/upload) stash
 * their bytes in Redis (cm:upload:<uuid>, 15-min TTL), but every coding entry
 * path dropped them (unified SSE ignored the ids; the platform send inlined a
 * 20K-char text preview; POST /run had no file channel at all). This module is
 * the payload type + validation gauntlet for the fix: the entry points resolve
 * upload ids into SessionFilePayloads, the payloads ride RunInput.files (and
 * the Redis steer mailbox), and the run-executor stages the decoded bytes into
 * `<worktree>/.digby/session/attachments/` (attachments.service) so the
 * agent's file/shell tools read the REAL file — not its extracted-text preview.
 *
 * Mirrors chat-images.ts: loud, specific errors (never silently strip), count
 * cap, base64 syntax check, per-file + total decoded-size caps. Unlike images
 * there is NO mime whitelist or magic-byte sniff — any file type the agent
 * might need (csv, docx, xlsx, txt, json, images without a vision channel, …)
 * is legal; the bytes are staged to disk, never sent to a model API.
 */

/** One attached file: base64 WITHOUT a data: prefix. */
export interface SessionFilePayload {
  name?: string;     // original filename, best-effort (sliced to 200 chars)
  mediaType: string; // any non-empty MIME string (≤100 chars) — NOT image-whitelisted
  data: string;      // base64 payload (no data:<mime>;base64, prefix)
  /**
   * Upload-time text extraction (feedback 7b5ee09b) — the text POST
   * /crossmodel/upload produced for a PDF/DOCX/XLSX/txt (text-extract.ts),
   * carried alongside the raw bytes so the run stages a readable
   * `<file>.extracted.txt` sibling: the session container has no guaranteed
   * pdftotext/mammoth, so without it a PDF lands as an opaque binary blob.
   * AUXILIARY data — never a validity condition (defensively capped, a file
   * never fails over its extract).
   */
  extractedText?: string;
}

export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 32 * 1024 * 1024;        // decoded, per file
export const MAX_FILE_TOTAL_BYTES = 48 * 1024 * 1024;  // decoded, across all files
export const MAX_FILE_EXTRACT_CHARS = 200_000;         // auxiliary text cap (never a rejection)
const MAX_FILE_NAME = 200;
const MAX_MEDIA_TYPE = 100;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export type ValidateFilesResult = { ok: true; files: SessionFilePayload[] } | { ok: false; error: string };

/** Decoded byte length of a valid base64 string (len % 4 === 0 already checked). */
function decodedBytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/**
 * Validate a raw `files` field (run/steer input, resolved upload payloads).
 * Absent/non-array is OK (zero files — the callers only ever build a real
 * array); anything malformed/oversized is a 400-level error string aimed at
 * the user. Repo idiom: reject loudly, NEVER silently strip a file.
 */
export function validateFiles(raw: unknown): ValidateFilesResult {
  if (raw == null || !Array.isArray(raw)) return { ok: true, files: [] };
  if (raw.length > MAX_FILES) return { ok: false, error: `At most ${MAX_FILES} files per message.` };
  const files: SessionFilePayload[] = [];
  let total = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const label = typeof r?.name === 'string' && r.name ? `"${r.name.slice(0, 60)}"` : `#${i + 1}`;
    if (!r || typeof r !== 'object') return { ok: false, error: `File ${label} is malformed.` };
    if (typeof r.mediaType !== 'string' || !r.mediaType.trim() || r.mediaType.length > MAX_MEDIA_TYPE) {
      return { ok: false, error: `File ${label} has an invalid media type.` };
    }
    if (r.name !== undefined && typeof r.name !== 'string') {
      return { ok: false, error: `File ${label} has an invalid name.` };
    }
    // The text extract is auxiliary (7b5ee09b): a non-string extract means the
    // payload itself is malformed (loud reject), but a string extract is only
    // ever capped — a file NEVER fails over its extract.
    if (r.extractedText !== undefined && typeof r.extractedText !== 'string') {
      return { ok: false, error: `File ${label} has an invalid text extract.` };
    }
    if (typeof r.data !== 'string' || !r.data) return { ok: false, error: `File ${label} has no data.` };
    // Syntax first: this also rejects a data: URL (the ':'/';' fail the alphabet).
    if (r.data.length % 4 !== 0 || !BASE64_RE.test(r.data)) {
      return { ok: false, error: `File ${label} is not valid base64 (send the raw base64 payload, without a data: prefix).` };
    }
    const bytes = decodedBytes(r.data);
    if (bytes > MAX_FILE_BYTES) {
      return { ok: false, error: `File ${label} is ~${Math.ceil(bytes / 1024 / 1024)} MB — the per-file limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.` };
    }
    total += bytes;
    if (total > MAX_FILE_TOTAL_BYTES) {
      return { ok: false, error: `The files total more than ${MAX_FILE_TOTAL_BYTES / 1024 / 1024} MB decoded — attach fewer or smaller files.` };
    }
    const f: SessionFilePayload = { mediaType: r.mediaType, data: r.data };
    if (typeof r.name === 'string' && r.name) f.name = r.name.slice(0, MAX_FILE_NAME);
    // Defensive cap on the auxiliary extract (7b5ee09b) — an empty extract is
    // dropped rather than carried as a pointless key.
    if (typeof r.extractedText === 'string' && r.extractedText) {
      f.extractedText = r.extractedText.slice(0, MAX_FILE_EXTRACT_CHARS);
    }
    files.push(f);
  }
  return { ok: true, files };
}

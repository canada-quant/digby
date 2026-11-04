/**
 * Feedback screenshots → disk + vision descriptions (ticket e87aee19).
 *
 * The feedback form (frontend FeedbackTab.tsx) packs up to 3 base64 data-URL
 * screenshots into the ticket description after a `\n\n---IMAGES---\n`
 * delimiter and POSTs it as one string. Left as-is, the blob: is invisible to
 * text-only lane models, bloats/truncates every brief/query/transcript that
 * renders the description, and poisons dedup/similarity comparisons with
 * base64 noise.
 *
 * This module is the single owner of that packed format:
 *   - splitPackedDescription / stripImagesSection — PURE parsing (no IO).
 *   - extractFeedbackImages — decode each data URL, write the bytes to
 *     <imagesRoot>/<ticketId>/<n>.<ext>, and return the description with the
 *     base64 section replaced by one `[screenshot N: <relpath>]` line per
 *     stored image. Runs on ticket creation AND on first sighting of a packed
 *     section anywhere else (dedup append, legacy ticket at dispatch).
 *   - renderScreenshotLines / getOrDescribeScreenshot — at dispatch time,
 *     vision-describe each referenced screenshot ONCE EVER (the text is cached
 *     alongside the image as <file>.desc.txt) so the fixing session actually
 *     SEES what the screenshot shows. Any failure (missing file, vision hop
 *     down) degrades silently to the file-reference line — a dispatch must
 *     never fail over a screenshot.
 *
 * Storage root: $FEEDBACK_IMAGES_ROOT, default <cwd>/uploads/feedback-images
 * (local-disk convention per the ticket; the env override exists so tests and
 * ops can point it at a tmp dir / mounted volume). The description only ever
 * carries the path RELATIVE to that root, so a root change never invalidates
 * stored tickets.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import logger from '../../../utils/logger';
import { describeImageWithVision } from '../image-describe';

/** MUST match the frontend packer (FeedbackTab.tsx IMAGE_DELIMITER). */
export const IMAGE_DELIMITER = '\n\n---IMAGES---\n';

const MAX_STORED_IMAGES = 5;      // hard bound at extraction (frontend allows 3)
const MAX_FILES_PER_TICKET = 25; // total per ticket dir across dedup-bumps (review N2)
const MAX_DESCRIBE_IMAGES = 3;    // cap of vision-described shots per dispatch brief
const VISION_DESC_MAX = 800;      // chars inlined per screenshot description
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // decode guard (a 5MB upload ≈ 6.7MB base64)

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export interface StoredFeedbackImage {
  /** 1-based screenshot number — matches its `[screenshot N: …]` ref line. */
  index: number;
  /** Path RELATIVE to imagesRoot() (POSIX separators) — what the description carries. */
  relPath: string;
  absPath: string;
  mimeType: string;
  bytes: number;
}

/** Storage root — read at CALL time (env-gate convention of the dispatch module). */
export function imagesRoot(): string {
  return process.env.FEEDBACK_IMAGES_ROOT || path.join(process.cwd(), 'uploads', 'feedback-images');
}

// ── Pure parsing (no IO) ──────────────────────────────────────────────────────

/**
 * Split a packed description into its human text and the raw data URLs.
 * Delimiter-absent → `{ text: raw, dataUrls: [] }`.
 */
export function splitPackedDescription(raw: string): { text: string; dataUrls: string[] } {
  const idx = raw.indexOf(IMAGE_DELIMITER);
  if (idx === -1) return { text: raw, dataUrls: [] };
  const text = raw.slice(0, idx);
  const dataUrls = raw
    .slice(idx + IMAGE_DELIMITER.length)
    .split('\n')
    .filter((s) => s.startsWith('data:image/'));
  return { text, dataUrls };
}

/**
 * Cut ANY residual packed-images section out of a description — pure, no IO.
 * Belt-and-braces for prompt builders: even if disk extraction failed, base64
 * must never ride into a brief.
 */
export function stripImagesSection(raw: string): string {
  return splitPackedDescription(raw).text;
}

const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

/** Decode a `data:image/<mime>;base64,<bytes>` URL — null on malformed/oversized. */
export function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } | null {
  const m = DATA_URL_RE.exec(dataUrl.trim());
  if (!m) return null;
  const b64 = m[2].replace(/\s/g, '');
  // Pre-decode bound: base64 inflates ~4/3 — reject BEFORE allocating the
  // decoded buffer (a 75mb request body must not force 55MB transient decodes).
  if (!b64.length || b64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return null;
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
  return { mimeType: m[1].toLowerCase(), buffer };
}

/** Parse the `[screenshot N: <relpath>]` reference lines a stripped description carries. */
export function parseScreenshotRefs(description: string): { index: number; relPath: string }[] {
  const refs: { index: number; relPath: string }[] = [];
  const re = /\[screenshot (\d+): ([^\]\n]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(description)) !== null) {
    refs.push({ index: parseInt(m[1], 10), relPath: m[2].trim() });
  }
  return refs;
}

/**
 * Resolve a ref's relPath against imagesRoot() — null on traversal attempts
 * (the description is untrusted text; a crafted `[screenshot 1: ../../.env]`
 * must resolve NOWHERE).
 */
export function resolveScreenshotPath(relPath: string): string | null {
  if (!relPath || relPath.split(/[\\/]/).includes('..')) return null;
  const root = path.resolve(imagesRoot());
  const abs = path.resolve(root, relPath);
  return abs.startsWith(root + path.sep) ? abs : null;
}

// ── Extraction (ticket creation / first sighting) ─────────────────────────────

/**
 * Extract every packed screenshot from `description`, write the decoded bytes
 * under <imagesRoot>/<ticketId>/, and return the description with the base64
 * section replaced by `[screenshot N: <relpath>]` reference lines.
 *
 * Idempotent per file (same bytes already on disk → no rewrite). NEVER throws:
 * on a disk failure the description is still returned STRIPPED (the base64 is
 * dropped even when the bytes can't be persisted) and the failure is logged —
 * keeping the row bounded outranks keeping the images.
 */
export async function extractFeedbackImages(
  description: string,
  ticketId: string,
): Promise<{ description: string; images: StoredFeedbackImage[] }> {
  const { text, dataUrls } = splitPackedDescription(description);
  if (!dataUrls.length) return { description, images: [] };

  const stored: StoredFeedbackImage[] = [];
  try {
    const dir = path.join(imagesRoot(), ticketId);
    await fs.mkdir(dir, { recursive: true });
    // Indices are unique per ticket dir across ALL extensions: a dedup append
    // can extract NEW screenshots into a ticket that already HAS some, and a
    // blind restart at 1 would overwrite earlier images (their refs live in
    // the stored description, their vision text in path-keyed .desc.txt
    // sidecars) — or, cross-extension, leave two refs both labelled
    // "screenshot 1". Next-free index whose file is absent or byte-identical.
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const used = new Set<number>();
    for (const name of names) {
      const m = /^(\d+)\./.exec(name);
      if (m) used.add(parseInt(m[1], 10));
    }
    let n = 0;
    for (const dataUrl of dataUrls.slice(0, MAX_STORED_IMAGES)) {
      const parsed = parseDataUrl(dataUrl);
      if (!parsed) continue; // malformed/oversized blob — skip the file, keep stripping
      const ext = EXT_BY_MIME[parsed.mimeType] || '.bin';
      let filename: string;
      let absPath: string;
      let existing: Buffer | null;
      do {
        n += 1;
        filename = `${n}${ext}`;
        absPath = path.join(dir, filename);
        existing = used.has(n) ? await fs.readFile(absPath).catch(() => null) : null;
      } while (used.has(n) && !(existing && existing.equals(parsed.buffer)));
      // The cap binds NEW stores only, and it binds them at ANY overflow index:
      // after a cap-skip n keeps climbing within this call, so a used.has(n)
      // check alone leaks indices MAX+1… (reviewer F1: a 2+-blob call on a full
      // dir wrote files 26–29 past the cap). A same-bytes hit reuses its index
      // at any depth (idempotent re-extraction) and is never capped.
      if (!existing && n > MAX_FILES_PER_TICKET) {
        continue; // dir at the per-ticket cap — skip storing, keep stripping (N2)
      }
      if (!existing) {
        // Write-then-rename: a concurrent instance never sees a partial file (N4).
        const tmp = `${absPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        await fs.writeFile(tmp, parsed.buffer);
        await fs.rename(tmp, absPath);
      }
      used.add(n);
      stored.push({
        index: n,
        relPath: `${ticketId}/${filename}`,
        absPath,
        mimeType: parsed.mimeType,
        bytes: parsed.buffer.length,
      });
    }
  } catch (err: any) {
    logger.warn(`feedback-images: extraction failed for ticket ${ticketId} — storing stripped description without files: ${err?.message ?? err}`);
    return { description: text, images: [] };
  }

  if (!stored.length) return { description: text, images: [] };
  const refs = stored.map((s) => `[screenshot ${s.index}: ${s.relPath}]`);
  return { description: `${text}\n\n${refs.join('\n')}`, images: stored };
}

// ── Vision describe at dispatch (cached, degrade-silent) ─────────────────────

/**
 * The cached vision description for a stored screenshot — or a FRESH describe
 * (cached alongside the image as <file>.desc.txt, so each image is described
 * ONCE EVER, never per dispatch). Returns null on ANY failure: unreadable
 * cache is fine, but a missing image or a failed vision hop degrades silently.
 */
export async function getOrDescribeScreenshot(absPath: string, mimeType: string): Promise<string | null> {
  const cachePath = `${absPath}.desc.txt`;
  const cached = await fs.readFile(cachePath, 'utf8').catch(() => null);
  if (cached && cached.trim()) return cached.trim().slice(0, VISION_DESC_MAX);
  try {
    const buffer = await fs.readFile(absPath);
    const text = (await describeImageWithVision(buffer, mimeType, path.basename(absPath))).trim();
    if (!text) return null;
    const capped = text.slice(0, VISION_DESC_MAX);
    // Best-effort cache write — a caching miss must not lose the description.
    await fs.writeFile(cachePath, capped, 'utf8').catch(() => {});
    return capped;
  } catch (err: any) {
    logger.warn(`feedback-images: vision describe failed for ${path.basename(absPath)} — degrading to the file-reference line: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Build the dispatch-facing screenshot lines for a (stripped) description: for
 * each referenced screenshot (cap MAX_DESCRIBE_IMAGES) the cached-or-fresh
 * vision text as `Screenshot N (vision): <text>`; a vision/disk failure
 * degrades to the bare file-reference line. NEVER throws — a screenshot must
 * never fail a dispatch.
 */
export async function renderScreenshotLines(description: string): Promise<string[]> {
  const refs = parseScreenshotRefs(description).slice(0, MAX_DESCRIBE_IMAGES);
  const lines: string[] = [];
  for (const ref of refs) {
    let vision: string | null = null;
    try {
      const absPath = resolveScreenshotPath(ref.relPath);
      const mimeType = absPath ? MIME_BY_EXT[path.extname(absPath).toLowerCase()] : undefined;
      if (absPath && mimeType) vision = await getOrDescribeScreenshot(absPath, mimeType);
    } catch {
      vision = null; // per-image guard — one bad ref never sinks the rest
    }
    lines.push(
      vision
        ? `Screenshot ${ref.index} (vision): ${vision}`
        : `Screenshot ${ref.index}: ${ref.relPath} (image on file — vision description unavailable)`,
    );
  }
  return lines;
}

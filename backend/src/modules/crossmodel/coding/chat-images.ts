/**
 * Digby Code — chat image attachments (coding-session runs + steer).
 *
 * Validation + conversion helpers for images the user attaches to a coding-chat
 * message. Images ride the JSON body as base64 (no data: prefix, no multipart —
 * express.json's 300mb limit already covers them) and are forwarded to
 * VISION-CAPABLE models as OpenAI-style image_url content parts. Text-only
 * models are rejected at the controller (never silently stripped).
 *
 * Defence in depth: mime whitelist, base64 syntax, per-image + total decoded
 * size caps, and a magic-byte sniff so a mislabeled/corrupt payload is rejected
 * before it can reach a provider (or be persisted into a transcript).
 */

/** One attached image as accepted by the API: base64 WITHOUT a data: prefix. */
export interface ChatImage {
  mediaType: string; // image/png | image/jpeg | image/webp | image/gif
  data: string;      // base64 payload (no data:<mime>;base64, prefix)
  name?: string;     // original filename, best-effort (sliced to 200 chars)
}

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;   // decoded, per image
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024;  // decoded, across all images
const MAX_IMAGE_NAME = 200;

const MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export type ValidateImagesResult = { ok: true; images: ChatImage[] } | { ok: false; error: string };

/** Decoded byte length of a valid base64 string (len % 4 === 0 already checked). */
function decodedBytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/** Identify an image's real format from its leading bytes (null = unrecognized).
 *  Exported 2026-09-24: image-generate.ts trusts THIS over a provider's label
 *  (Z.AI serves JPEG bytes as image/png). */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png'; // \x89PNG\r\n\x1a\n
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6) {
    const sig = buf.subarray(0, 6).toString('ascii');
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Identify an audio file's real format from its leading bytes (null = unrecognized).
 * Exported for the audio mime-heal chain (ticket 6c050917): staged and persisted
 * audio used to carry application/octet-stream (STAGED_MIME_BY_EXT had no audio
 * entries), which the inline byte route 415s — so the chat UI could never play
 * it. Recognizes RIFF/WAVE, ID3 + MPEG frame-sync, OggS, fLaC, and the ISO-BMFF
 * `ftyp` M4A brand. The returned type is ONLY ever audio/* — no scripting-capable
 * essence can come back, so the B1 stored-XSS surface (html/svg) stays
 * unreachable through every sniff-based heal path. An mp4 VIDEO (ftyp isom/
 * mp42/…) intentionally returns null — video is not this ticket's family.
 */
export function sniffAudioMime(buf: Buffer): string | null {
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (buf.length >= 3 && buf.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg'; // MPEG frame sync
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'fLaC') return 'audio/flac';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (brand.startsWith('M4A')) return 'audio/mp4'; // audio-only AAC container
  }
  return null;
}

/**
 * Validate the raw `images` field of a run/steer request body. Absent/empty is
 * OK (zero images); anything malformed/oversized/mislabeled is a 400-level
 * error string aimed at the user.
 */
export function validateImages(raw: unknown): ValidateImagesResult {
  if (raw == null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'images must be an array' };
  if (raw.length > MAX_IMAGES) return { ok: false, error: `At most ${MAX_IMAGES} images per message.` };
  const images: ChatImage[] = [];
  let total = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const label = typeof r?.name === 'string' && r.name ? `"${r.name.slice(0, 60)}"` : `#${i + 1}`;
    if (!r || typeof r !== 'object') return { ok: false, error: `Image ${label} is malformed.` };
    if (typeof r.mediaType !== 'string' || !MIME_WHITELIST.has(r.mediaType)) {
      return { ok: false, error: `Unsupported image type "${String(r.mediaType ?? '')}" — use PNG, JPEG, WebP, or GIF.` };
    }
    if (typeof r.data !== 'string' || !r.data) return { ok: false, error: `Image ${label} has no data.` };
    // Syntax first: this also rejects a data: URL (the ':'/';' fail the alphabet).
    if (r.data.length % 4 !== 0 || !BASE64_RE.test(r.data)) {
      return { ok: false, error: `Image ${label} is not valid base64 (send the raw base64 payload, without a data: prefix).` };
    }
    const bytes = decodedBytes(r.data);
    if (bytes > MAX_IMAGE_BYTES) {
      return { ok: false, error: `Image ${label} is ~${Math.ceil(bytes / 1024 / 1024)} MB — the per-image limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` };
    }
    total += bytes;
    if (total > MAX_TOTAL_BYTES) {
      return { ok: false, error: `The images total more than ${MAX_TOTAL_BYTES / 1024 / 1024} MB decoded — attach fewer or smaller images.` };
    }
    // Magic-byte sniff: the first 24 base64 chars decode to 18 bytes — enough for
    // every signature above. A mismatch means a corrupt or mislabeled upload.
    const head = Buffer.from(r.data.slice(0, 24), 'base64');
    const sniffed = sniffMime(head);
    if (sniffed !== r.mediaType) {
      return { ok: false, error: `Image ${label} declares ${r.mediaType} but its bytes ${sniffed ? `look like ${sniffed}` : 'are not a recognized image'} — the file may be corrupt or mislabeled.` };
    }
    const img: ChatImage = { mediaType: r.mediaType, data: r.data };
    if (typeof r.name === 'string' && r.name) img.name = r.name.slice(0, MAX_IMAGE_NAME);
    images.push(img);
  }
  return { ok: true, images };
}

/** OpenAI-style content parts for a vision model (data: URL per image). */
export function toImageContentParts(images: ChatImage[]): Array<{ type: 'image_url'; image_url: { url: string } }> {
  return images.map(i => ({ type: 'image_url' as const, image_url: { url: `data:${i.mediaType};base64,${i.data}` } }));
}

/** Text stand-in for an image (history downgrade, compaction, steer payloads). */
export function imagePlaceholder(img: { mediaType: string; name?: string }): string {
  return `[User attached image: ${img.name || 'image'} (${img.mediaType})]`;
}

/**
 * Normalize provider-message content into content parts: a string becomes one
 * text part, an array passes through as-is, anything else stringifies (null →
 * ''). Shared by the sanitizer's same-role merge so content arrays are NEVER
 * flattened with String() ("[object Object]").
 */
export function toParts(content: unknown): Array<{ type: string; [k: string]: any }> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [{ type: 'text', text: String(content ?? '') }];
}

/**
 * Text-only session models (glm-5.3; DeepSeek gained native vision with V4.1
 * Flash 2026-09-10) can't see pixels — but a
 * user's image attachment should still WORK, not 400 (owner wave 2026-09-03).
 * Describe each image once via the shared vision utility (glm-5.3-flash,
 * image-describe.ts) and return prompt-ready text blocks. Throws only when
 * EVERY description fails — the caller keeps its honest reject for that case.
 * Vision-capable models never take this path (they get native image parts).
 */
export async function describeImagesForTextOnlyModel(images: ChatImage[], sessionModel: string): Promise<string> {
  const { describeImageWithVision, resolveVisionDescribeModel } = await import('../image-describe');
  const describer = await resolveVisionDescribeModel(); // the Image reader SEAT's live model
  const blocks: string[] = [];
  let failures = 0;
  for (const img of images) {
    const name = img.name || 'attached image';
    try {
      const desc = await describeImageWithVision(Buffer.from(img.data, 'base64'), img.mediaType, name);
      blocks.push(`[IMAGE: ${name} — the session model (${sessionModel}) is text-only, so this attachment was described by the vision agent (${describer}). Treat the description as your view of the image and say so if asked.]\n${desc}\n[/IMAGE]`);
    } catch {
      failures++;
      blocks.push(`[IMAGE: ${name} — attached by the user, but the vision description failed. Tell the user you could not see this image.]`);
    }
  }
  if (failures === images.length) throw new Error('vision description failed for every attached image');
  return blocks.join('\n\n');
}

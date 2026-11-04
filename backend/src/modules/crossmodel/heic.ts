/**
 * HEIC/HEIF → JPEG conversion (owner report 2026-09-03): iPhones upload HEIC
 * by default and the upload form lists HEIC/HEIF as supported, but OpenAI
 * vision rejects it (image-describe threw "convert to JPEG or PNG first" on
 * the owner's .heic screenshot) and non-Safari browsers can't render it
 * inline. heic-convert is pure JS/WASM (bundled libheif — no native dep), so
 * it runs identically on the blue/green containers and the coding box.
 *
 * Shared by the two ingestion points that must never diverge:
 *   - upload.controller.ts (chat attachments — converts AT THE DOOR so chat
 *     vision injection, the analyzer, and the preview chip all get JPEG);
 *   - image-describe.ts (knowledge-base / feedback analyzer — direct HEIC
 *     uploads that bypass /crossmodel/upload).
 *
 * Returns null on ANY failure (corrupt file, decoder hiccup) so callers keep
 * their original-bytes fallback — conversion must never lose an upload.
 */
import logger from '../../utils/logger';

export async function convertHeicToJpeg(buffer: Buffer): Promise<Buffer | null> {
  try {
    // Dynamic import: the WASM decoder bundle is multi-MB — only pay the load
    // when an actual HEIC lands (every other upload type skips it entirely).
    const convert = (await import('heic-convert')).default;
    const out = await convert({ buffer, format: 'JPEG', quality: 0.92 });
    return Buffer.from(out);
  } catch (err: any) {
    logger.warn(`heic: HEIC→JPEG conversion failed (${err?.message ?? err})`);
    return null;
  }
}

/** True for the MIME types the conversion path handles. */
export function isHeicMime(mimeType: string | undefined | null): boolean {
  return mimeType === 'image/heic' || mimeType === 'image/heif';
}

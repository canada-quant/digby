/**
 * Binary sniffing for uploaded branding-pack assets (todo 61dc8aaf).
 *
 * WHY THIS FILE EXISTS INSTEAD OF A LIBRARY: the backend's dependency set has
 * no image decoder (`sharp`/`image-size`/`file-type` are all absent, and adding
 * a native module to the deploy image for a seasonal-logo feature is not a
 * trade worth making). Everything a branding pack needs is a HEADER read, not a
 * decode: which format the bytes really are, and how big the image claims to be.
 *
 * WHY SNIFF AT ALL: `multer`'s `file.mimetype` and `file.originalname` are both
 * attacker-controlled strings. An upload that says `image/png` while carrying
 * HTML is how a "branding asset" becomes stored XSS once some route serves it
 * with a content-type the browser will execute. So the accepted type here is
 * decided by MAGIC BYTES ONLY, and the served `Content-Type` is the value this
 * function returned — never the upload's own header.
 *
 * WHAT IS DELIBERATELY NOT SUPPORTED: SVG. The shared core tolerates an
 * operator's SVG on a self-hosted box (it is the operator's own filesystem and
 * the route serves it with `default-src 'none'`), but on Cloud an SVG arrives
 * through an HTTP upload and is served from OUR origin to every visitor — a
 * script-bearing SVG there is a same-origin XSS with no jail to fall back on.
 * Refusing it outright keeps this surface to formats the browser cannot script.
 * The rejection message says so, so an operator is not left guessing.
 *
 * Dimension reads are best-effort: a `null` means "could not prove a size", and
 * the caller treats that as a validation failure for slots that require them.
 */

export type SniffedImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/x-icon';

export interface SniffedImage {
  mimeType: SniffedImageType;
  width: number | null;
  height: number | null;
  /** True for GIF/APNG/WebP animation — the `spinner` slot expects one. */
  animated: boolean;
}

/** The formats a pack asset may be. Ordered by how cheap the check is. */
export const SNIFFED_MIME_TYPES: readonly SniffedImageType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/x-icon',
];

/** Hard per-asset ceiling. A branding asset is a logo or a spinner, not media. */
export const MAX_PACK_ASSET_BYTES = 2 * 1024 * 1024;

/** Decode a PNG `IHDR` (always the first chunk, at a fixed offset). */
function pngSize(buf: Buffer): { width: number | null; height: number | null; animated: boolean } {
  // 8-byte signature + 4-byte length + 4-byte "IHDR" = 16, then two BE uint32.
  if (buf.length < 24) return { width: null, height: null, animated: false };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  // APNG carries an `acTL` chunk before the first IDAT; scanning the first 2 KiB
  // is enough for every real APNG (it must declare frame count up front).
  const animated = buf.subarray(0, Math.min(buf.length, 2048)).includes(Buffer.from('acTL', 'ascii'));
  return { width: width || null, height: height || null, animated };
}

/** Walk JPEG segment markers to the first SOFn, which carries the dimensions. */
function jpegSize(buf: Buffer): { width: number | null; height: number | null } {
  let offset = 2; // skip SOI (FFD8)
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return { width: null, height: null }; // not a marker — give up
    const marker = buf[offset + 1];
    // SOF0..SOF15 except DHT(C4), JPG(C8) and DAC(CC) are frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const segLength = buf.readUInt16BE(offset + 2);
    if (segLength < 2) return { width: null, height: null }; // corrupt — never loop forever
    offset += 2 + segLength;
  }
  return { width: null, height: null };
}

function gifSize(buf: Buffer): { width: number | null; height: number | null; animated: boolean } {
  // Logical screen descriptor: 6-byte header then two LE uint16.
  if (buf.length < 10) return { width: null, height: null, animated: false };
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  // An animation has more than one image descriptor / a NETSCAPE loop block.
  // Counting 0x21 (extension introducer) occurrences is a cheap over-approximation
  // that never claims "static" for a real GIF89a animation.
  let frames = 0;
  for (let i = 0; i < buf.length - 1; i += 1) {
    if (buf[i] === 0x2c /* image separator */ && buf[i + 1] !== 0x00) frames += 1;
    if (frames > 1) break;
  }
  const declaresLoop = buf.subarray(0, Math.min(buf.length, 2048)).includes(Buffer.from('NETSCAPE2.0', 'ascii'));
  return { width: width || null, height: height || null, animated: declaresLoop || frames > 1 };
}

function webpInfo(buf: Buffer): { width: number | null; height: number | null; animated: boolean } {
  const chunk = buf.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && buf.length >= 30) {
    // Extended format: 24-bit canvas size minus one, and an animation flag byte.
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    const animated = (buf[20] & 0x02) !== 0;
    return { width, height, animated };
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    // Lossless: 14-bit width-1 / height-1 packed after the 0x2f signature.
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, animated: false };
  }
  if (chunk === 'VP8 ' && buf.length >= 30) {
    // Lossy: keyframe header, 16-bit size preceded by a 3-byte start code.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return { width: null, height: null, animated: false };
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, animated: false };
  }
  return { width: null, height: null, animated: false };
}

function icoSize(buf: Buffer): { width: number | null; height: number | null } {
  // ICONDIR: 6-byte header, then the first ICONDIRENTRY at 6.
  if (buf.length < 16) return { width: null, height: null };
  const count = buf.readUInt16LE(4);
  if (!count) return { width: null, height: null };
  // A stored 0 means 256 in the ICO format.
  const width = buf[6] || 256;
  const height = buf[7] || 256;
  return { width, height };
}

/**
 * Identify the image by its MAGIC BYTES. Returns null for anything not on the
 * allowlist (including SVG, HTML mislabelled as an image, and empty input).
 */
export function sniffImage(buf: Buffer | Uint8Array): SniffedImage | null {
  if (!buf || buf.length < 8) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  // PNG: \x89 P N G \r \n \x1a \n
  if (b.length >= 24 && b[0] === 0x89 && b.subarray(1, 4).toString('ascii') === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) {
    return { mimeType: 'image/png', ...pngSize(b) };
  }
  // JPEG: FFD8 FF, then any marker.
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { mimeType: 'image/jpeg', ...jpegSize(b), animated: false };
  }
  // GIF87a / GIF89a.
  if (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return { mimeType: 'image/gif', ...gifSize(b) };
  }
  // WebP: "RIFF" .... "WEBP"
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', ...webpInfo(b) };
  }
  // ICO: 00 00 01 00 (count > 0)
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00 && b.readUInt16LE(4) > 0) {
    return { mimeType: 'image/x-icon', ...icoSize(b), animated: false };
  }
  return null;
}
/**
 * Branding-pack VALIDATION — image sniffing + per-slot rules
 * (todo 61dc8aaf, Phase 2 Cloud).
 *
 * These are the tests that stop a "branding asset" from becoming stored XSS or a
 * broken page. The rule they pin: the accepted type comes from the BYTES, never
 * from the upload's own Content-Type / filename, and every asset must have
 * readable dimensions inside its slot's bounds before it can be stored.
 *
 * Fixtures are built from real headers rather than committed binaries — the
 * sniffer reads headers only, so a synthetic-but-well-formed head exercises
 * exactly the code path a real file does (and keeps the repo free of blobs).
 */
import { describe, it, expect } from '@jest/globals';
import { sniffImage, MAX_PACK_ASSET_BYTES } from './image-sniff';
import { prepareAsset, PACK_ASSET_SLOTS, SLOT_RULES, type PackAssetSlot } from './pack-validation';

// ── fixture builders ────────────────────────────────────────────────────────
/** A well-formed PNG header + IHDR for the given size. */
function pngBytes(width: number, height: number, opts: { apng?: boolean } = {}): Buffer {
  const sig = Buffer.from('89504e470d0a1a0a', 'hex');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  const ihdr = Buffer.from('49484452', 'hex');
  const dims = Buffer.alloc(8);
  dims.writeUInt32BE(width, 0);
  dims.writeUInt32BE(height, 4);
  const rest = Buffer.alloc(5); // bit depth, colour type, compression, filter, interlace
  const parts = [sig, len, ihdr, dims, rest];
  if (opts.apng) {
    // An `acTL` chunk anywhere in the first 2 KiB marks it animated.
    parts.push(Buffer.from('000000086163544c', 'hex'), Buffer.alloc(8));
  }
  parts.push(Buffer.alloc(32)); // padding so length checks are realistic
  return Buffer.concat(parts);
}

/** A GIF89a with the given logical-screen size; `loops` adds a NETSCAPE block. */
function gifBytes(width: number, height: number, opts: { animated?: boolean } = {}): Buffer {
  const head = Buffer.from('474946383961', 'hex'); // GIF89a
  const dims = Buffer.alloc(4);
  dims.writeUInt16LE(width, 0);
  dims.writeUInt16LE(height, 2);
  const parts = [head, dims, Buffer.alloc(4)];
  if (opts.animated) parts.push(Buffer.from('21FF0B4E45545343415045322E30', 'hex'));
  parts.push(Buffer.alloc(16));
  return Buffer.concat(parts);
}

/** A JPEG with an APP0 then a SOF0 carrying the dimensions. */
function jpegBytes(width: number, height: number): Buffer {
  const soi = Buffer.from('FFD8', 'hex');
  // APP0: marker FFE0, then a length field that COVERS ITSELF + the payload.
  // 12 bytes of payload ⇒ length 14 (0x000E). Getting this arithmetic wrong is
  // how a fixture silently desynchronises the marker walk.
  const app0 = Buffer.from('FFE0000E', 'hex');
  const app0Payload = Buffer.alloc(12);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0); // SOF0 marker
  sof.writeUInt16BE(17, 2); // length: 2 (self) + 1 precision + 2 height + 2 width + 3 components*3
  sof[4] = 8; // sample precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([soi, app0, app0Payload, sof, Buffer.alloc(16)]);
}

/** A WebP VP8X (extended) header. */
function webpBytes(width: number, height: number, opts: { animated?: boolean } = {}): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b[20] = opts.animated ? 0x02 : 0x00;
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function icoBytes(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt16LE(0, 0);
  b.writeUInt16LE(1, 2);
  b.writeUInt16LE(1, 4); // one image
  b[6] = width === 256 ? 0 : width;
  b[7] = height === 256 ? 0 : height;
  return b;
}

// ── sniffing ────────────────────────────────────────────────────────────────
describe('sniffImage — the type comes from the bytes, never the filename', () => {
  it('identifies PNG and reads its IHDR dimensions', () => {
    const s = sniffImage(pngBytes(64, 64));
    expect(s?.mimeType).toBe('image/png');
    expect(s).toMatchObject({ width: 64, height: 64 });
    expect(s?.animated).toBe(false);
  });

  it('flags an APNG as animated', () => {
    expect(sniffImage(pngBytes(64, 64, { apng: true }))?.animated).toBe(true);
  });

  it('identifies GIF87a/GIF89a with logical-screen dimensions', () => {
    expect(sniffImage(gifBytes(16, 16))).toMatchObject({ mimeType: 'image/gif', width: 16, height: 16 });
    expect(sniffImage(gifBytes(16, 16, { animated: true }))?.animated).toBe(true);
    expect(sniffImage(gifBytes(16, 16))?.animated).toBe(false);
  });

  it('walks JPEG segments to the SOF dimensions', () => {
    expect(sniffImage(jpegBytes(120, 40))).toMatchObject({ mimeType: 'image/jpeg', width: 120, height: 40 });
  });

  it('identifies WebP VP8X with canvas size', () => {
    expect(sniffImage(webpBytes(200, 80))).toMatchObject({ mimeType: 'image/webp', width: 200, height: 80 });
    expect(sniffImage(webpBytes(200, 80, { animated: true }))?.animated).toBe(true);
  });

  it('identifies ICO and reads a stored 0 as 256', () => {
    expect(sniffImage(icoBytes(32, 32))).toMatchObject({ mimeType: 'image/x-icon', width: 32, height: 32 });
    expect(sniffImage(icoBytes(256, 256))).toMatchObject({ width: 256, height: 256 });
  });

  it('refuses SVG, HTML and empty input', () => {
    // The same-origin XSS class: an SVG served from our origin can carry script.
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('<!doctype html><html><body>hi</body></html>'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    expect(sniffImage(Buffer.from('not an image at all'))).toBeNull();
  });
});

// ── per-slot validation ─────────────────────────────────────────────────────
describe('prepareAsset — per-slot bounds and the SVG refusal', () => {
  it('accepts a logo at a sane size and returns the sniffed type', () => {
    const res = prepareAsset('logo', pngBytes(400, 120));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    // A PNG whose name claimed anything else is still image/png.
    expect(res.asset.mimeType).toBe('image/png');
    expect(res.asset.width).toBe(400);
    expect(res.asset.height).toBe(120);
    // sha256 is what a deploy probe compares the served bytes against.
    expect(res.asset.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an SVG for any slot, naming the reason', () => {
    const res = prepareAsset('logo', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected rejection');
    expect(res.rejection.reason).toMatch(/SVG is not accepted/i);
  });

  it('refuses an app icon that is too small for its declared size', () => {
    const res = prepareAsset('icon512', pngBytes(48, 48));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected rejection');
    expect(res.rejection.reason).toMatch(/icon512/);
  });

  it('refuses an asset larger than the ceiling', () => {
    const huge = Buffer.concat([pngBytes(64, 64), Buffer.alloc(MAX_PACK_ASSET_BYTES)]);
    const res = prepareAsset('logo', huge);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected rejection');
    expect(res.rejection.reason).toMatch(/limit is 2048 KB/i);
  });

  it('refuses an empty file and an unknown slot', () => {
    expect(prepareAsset('logo', Buffer.alloc(0)).ok).toBe(false);
    expect(prepareAsset('nope' as PackAssetSlot, pngBytes(64, 64)).ok).toBe(false);
  });

  it('every declared slot has a rule, and every rule is satisfiable', () => {
    for (const slot of PACK_ASSET_SLOTS) {
      expect(SLOT_RULES[slot] ?? null).not.toBeNull();
      // A slot whose minimum exceeds its maximum could never accept anything.
      expect(SLOT_RULES[slot].minSize).toBeLessThanOrEqual(SLOT_RULES[slot].maxSize);
    }
  });
});
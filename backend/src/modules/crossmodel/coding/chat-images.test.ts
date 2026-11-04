/**
 * Chat image attachments — the validation gauntlet every attached image must
 * survive before it can reach a vision model (or be persisted into a
 * transcript): mime whitelist, base64 syntax, per-image + total decoded-size
 * caps, and a magic-byte sniff so a mislabeled/corrupt payload is rejected.
 * Plus the conversion helpers (image_url parts, placeholders, toParts).
 */

import {
  ChatImage, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES,
  validateImages, toImageContentParts, imagePlaceholder, toParts,
} from './chat-images';

/** Tiny valid payloads whose leading bytes carry each format's real signature. */
const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64');
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]); // \x89PNG\r\n\x1a\n + IHDR length
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]); // \xFF\xD8\xFF + JFIF
const GIF = b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]); // 'GIF89a' + 1x1 screen
const WEBP = b64([0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]); // 'RIFF' + size + 'WEBP'

const img = (mediaType: string, data: string, name?: string): ChatImage => (name ? { mediaType, data, name } : { mediaType, data });

/**
 * A syntactically valid base64 payload of ~`decodedBytes` decoded bytes whose
 * head still carries the given signature (the validator sniffs the first 24
 * base64 chars). 'A' is base64 for zero-bits, so the fill keeps the alphabet.
 */
function bigPayload(signature: number[], decodedBytes: number): string {
  const chars = Math.ceil(decodedBytes / 3) * 4; // 3 bytes → 4 chars, no padding
  const head = Buffer.from(signature).toString('base64').replace(/=+$/, '');
  return (head + 'A'.repeat(chars)).slice(0, chars);
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('validateImages — happy path', () => {
  test('accepts each whitelisted mime with its real magic bytes', () => {
    const cases: Array<[string, string]> = [
      ['image/png', PNG],
      ['image/jpeg', JPEG],
      ['image/gif', GIF],
      ['image/webp', WEBP],
    ];
    for (const [mediaType, data] of cases) {
      const r = validateImages([{ mediaType, data }]);
      expect(r).toEqual({ ok: true, images: [{ mediaType, data }] });
    }
  });

  test('accepts a full batch of MAX_IMAGES images', () => {
    const r = validateImages(Array.from({ length: MAX_IMAGES }, () => ({ mediaType: 'image/png', data: PNG })));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.images).toHaveLength(MAX_IMAGES);
  });

  test('absent / undefined / null / empty array all validate to zero images', () => {
    for (const raw of [undefined, null, []]) {
      expect(validateImages(raw)).toEqual({ ok: true, images: [] });
    }
  });

  test('keeps a sane name and slices an over-long one to 200 chars', () => {
    const named = validateImages([{ mediaType: 'image/png', data: PNG, name: 'cat.png' }]);
    expect(named).toEqual({ ok: true, images: [{ mediaType: 'image/png', data: PNG, name: 'cat.png' }] });

    const long = validateImages([{ mediaType: 'image/png', data: PNG, name: 'x'.repeat(260) }]);
    expect(long.ok).toBe(true);
    if (long.ok) {
      expect(long.images[0].name).toHaveLength(200);
      expect(long.images[0].name).toBe('x'.repeat(200));
    }
  });
});

describe('validateImages — rejection gauntlet', () => {
  test('a non-array images field is an error', () => {
    for (const raw of ['not-an-array', { mediaType: 'image/png', data: PNG }, 42]) {
      const r = validateImages(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('images must be an array');
    }
  });

  test('a non-object entry is malformed', () => {
    const r = validateImages([null]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('malformed');
  });

  test('a mime outside the whitelist (image/svg+xml) is rejected', () => {
    const r = validateImages([{ mediaType: 'image/svg+xml', data: b64([0x3c, 0x73, 0x76, 0x67]) }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('Unsupported image type');
      expect(r.error).toContain('image/svg+xml');
    }
  });

  test('a missing data payload is rejected', () => {
    const r = validateImages([{ mediaType: 'image/png' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('has no data');
  });

  test('a data:-prefixed URL is rejected (the : and ; fail the base64 alphabet)', () => {
    const r = validateImages([{ mediaType: 'image/png', data: `data:image/png;base64,${PNG}` }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not valid base64');
  });

  test('invalid base64 characters are rejected', () => {
    const r = validateImages([{ mediaType: 'image/png', data: 'abc!' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not valid base64');
  });

  test('a base64 length that is not a multiple of 4 is rejected', () => {
    const r = validateImages([{ mediaType: 'image/png', data: 'iVBORw0KG' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not valid base64');
  });

  test('a single image over 5 MB decoded is rejected', () => {
    const r = validateImages([{ mediaType: 'image/png', data: bigPayload(PNG_SIG, MAX_IMAGE_BYTES + 3) }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('per-image limit is 5 MB');
  });

  test('more than MAX_IMAGES images is rejected', () => {
    const r = validateImages(Array.from({ length: MAX_IMAGES + 1 }, () => ({ mediaType: 'image/png', data: PNG })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(`At most ${MAX_IMAGES} images per message`);
  });

  test('a batch over 12 MB decoded in total is rejected (each image individually legal)', () => {
    const perImage = Math.floor(MAX_TOTAL_BYTES / 3) + 300; // ~4.2 MB each — under the 5 MB per-image cap
    expect(perImage).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    const r = validateImages([
      { mediaType: 'image/png', data: bigPayload(PNG_SIG, perImage) },
      { mediaType: 'image/png', data: bigPayload(PNG_SIG, perImage) },
      { mediaType: 'image/png', data: bigPayload(PNG_SIG, perImage) },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('total more than 12 MB');
  });

  test('magic bytes that contradict the declared mime are rejected', () => {
    const r = validateImages([{ mediaType: 'image/jpeg', data: PNG, name: 'lies.jpg' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('declares image/jpeg');
      expect(r.error).toContain('look like image/png');
    }
  });

  test('bytes of no recognized format are rejected', () => {
    const r = validateImages([{ mediaType: 'image/png', data: bigPayload([0x00, 0x01, 0x02], 64) }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not a recognized image');
  });
});

describe('toImageContentParts', () => {
  test('builds OpenAI-style image_url parts with data: URLs', () => {
    const parts = toImageContentParts([img('image/png', 'AAAA'), img('image/webp', 'BBBB')]);
    expect(parts).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'data:image/webp;base64,BBBB' } },
    ]);
  });

  test('an empty batch yields no parts', () => {
    expect(toImageContentParts([])).toEqual([]);
  });
});

describe('imagePlaceholder', () => {
  test('uses the filename when present', () => {
    expect(imagePlaceholder({ mediaType: 'image/png', name: 'cat.png' })).toBe('[User attached image: cat.png (image/png)]');
  });

  test('falls back to a generic label without a name', () => {
    expect(imagePlaceholder({ mediaType: 'image/jpeg' })).toBe('[User attached image: image (image/jpeg)]');
  });
});

describe('toParts', () => {
  test('a string becomes a single text part', () => {
    expect(toParts('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });

  test('an array passes through as-is (same reference, never rebuilt)', () => {
    const arr = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];
    expect(toParts(arr)).toBe(arr);
  });

  test('null/undefined become an empty text part (never "[object Object]")', () => {
    expect(toParts(null)).toEqual([{ type: 'text', text: '' }]);
    expect(toParts(undefined)).toEqual([{ type: 'text', text: '' }]);
  });

  test('any other shape stringifies into a text part', () => {
    expect(toParts(42)).toEqual([{ type: 'text', text: '42' }]);
  });
});

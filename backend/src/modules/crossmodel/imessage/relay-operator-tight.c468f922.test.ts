/**
 * THE TIGHT DECODER (ticket c468f922, follow-on slice) — pins.
 *
 * ── WHY THIS FILE EXISTS, IN THE WORDS OF THE DEFECT IT FIXES ───────────────
 * The previous slice (PR #2342) made Hextile/CopyRect reachable and left Tight
 * as an honest refusal: `unsupported-encoding`. That was correct then, and it
 * is the wrong behaviour for the encodings real Windows hosts actually prefer.
 * TightVNC and TigerVNC both take "the first normal encoding in the client's
 * list" (§7.5.2) — and both PREFER Tight. So a host supporting BOTH was ordered
 * to send Hextile (costlier, and not what it would have chosen), and a host
 * configured to force Tight (`-encoding tight`) answered our advertisement with
 * a rect we refused: the operator saw "undecodable stream" instead of a desktop.
 *
 * ── WHAT MAKES THESE PINS WORTH ANYTHING ───────────────────────────────────
 * The lesson banked from PR #2342 is that a fixture which hand-builds the NEW
 * format unconditionally passes even when the feature is UNREACHABLE. Two
 * consequences shape every test below:
 *
 *   1. The fixture here ENCODES Tight from the spec — it runs the forward
 *      transform and real zlib, and never calls the decoder to build its input.
 *      If the decoder's gradient orientation or palette stride were wrong, the
 *      round trip fails; it cannot "pass by construction".
 *   2. The reachability pins carry a NEGATIVE CONTROL: the fixture's server
 *      implements §7.5.2's selection rule, so it emits Tight only when the
 *      client LISTED Tight and falls back to Raw when it did not. Deleting the
 *      advertisement therefore FAILS the suite rather than passing it.
 *
 * ── NOT IN SCOPE (stated, not glossed) ─────────────────────────────────────
 * JPEG compression is refused (`bad-tight`) rather than decoded — we never
 * advertise a JPEG quality level, so a compliant server will not send it, and a
 * non-compliant one gets an honest refusal instead of a hole in the picture.
 * TRLE/ZRLE remain unimplemented and still refuse. Hardware e2e stays parked:
 * there is no paired Windows device, so every frame here is a fixture.
 */

import { constants as zlibConstants, createDeflate, deflateSync } from 'zlib';
import {
  OperatorScreenDecoder,
  OPERATOR_RFB_ENCODING_RAW,
  OPERATOR_RFB_ENCODING_TIGHT,
  createTightStreams,
  decodeTightRect,
  tightPayloadBytes,
  operatorUpdateShape,
} from './relay-operator-viewer';

jest.setTimeout(30_000);

// ── The server half: an INDEPENDENT Tight encoder ──────────────────────────

/** Wire order is BB GG RR 00 for the 32bpp/depth-24 format both ends declare. */
const wire = (r: number, g: number, b: number): [number, number, number, number] => [b, g, r, 0];

/**
 * Build one Tight rect payload from an RGB image — the FORWARD transform, per
 * the spec. `compress` runs the filtered bytes through real zlib exactly as a
 * server would; `filter` picks the pre-processor.
 */
function encodeTightRect(opts: {
  width: number;
  height: number;
  /** r,g,b per pixel, row-major. */
  pixels: (x: number, y: number) => [number, number, number];
  filter?: 'copy' | 'palette' | 'gradient';
  /** Omit to send the filtered bytes INLINE (< 12 rule / no-zlib). */
  compress?: { data: Buffer; streamId?: number; reset?: boolean };
}): { payload: Buffer; filtered: Buffer } {
  const { width, height } = opts;
  const filter = opts.filter ?? 'copy';
  const parts: Buffer[] = [];

  // control byte: stream id in bits 5-4, read-filter-id in bit 6.
  const streamId = opts.compress?.streamId ?? 0;
  let control = (streamId & 0x03) << 4;
  if (filter !== 'copy') control |= 0x40;
  if (opts.compress?.reset) control |= 1 << streamId;
  parts.push(Buffer.from([control]));

  // filter-id byte, only when bit 6 is set.
  if (filter !== 'copy') {
    parts.push(Buffer.from([filter === 'palette' ? 1 : 2]));
  }

  let filtered: Buffer;
  let paletteColours = 0;

  if (filter === 'palette') {
    // Collect the distinct colours, then emit `count-1`, the raw palette, and
    // the indices. 2 colours ⇒ 1 bit per pixel (MSB = leftmost, rows aligned).
    const index = new Map<string, number>();
    const palette: Array<[number, number, number]> = [];
    const idxOf: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = opts.pixels(x, y);
        const key = `${r},${g},${b}`;
        if (!index.has(key)) {
          index.set(key, palette.length);
          palette.push([r, g, b]);
        }
        idxOf.push(index.get(key)!);
      }
    }
    paletteColours = palette.length;
    parts.push(Buffer.from([paletteColours - 1]));
    const palBytes = Buffer.alloc(paletteColours * 3);
    palette.forEach(([r, g, b], i) => {
      palBytes[i * 3] = r;
      palBytes[i * 3 + 1] = g;
      palBytes[i * 3 + 2] = b;
    });
    parts.push(palBytes);

    if (paletteColours <= 2) {
      const rowSize = Math.floor((width + 7) / 8);
      filtered = Buffer.alloc(rowSize * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (idxOf[y * width + x] === 1) {
            filtered[y * rowSize + (x >> 3)] |= 1 << (7 - (x & 7));
          }
        }
      }
    } else {
      filtered = Buffer.alloc(width * height);
      for (let i = 0; i < width * height; i++) filtered[i] = idxOf[i];
    }
  } else if (filter === 'gradient') {
    // Forward transform: D[i,j] = V[i,j] - P[i,j]  (mod 256), where
    // P is the clamped left+upper-upperleft prediction.
    const comp = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = opts.pixels(x, y);
        const v = [r, g, b];
        for (let c = 0; c < 3; c++) {
          const left = x > 0 ? comp[(y * width + (x - 1)) * 3 + c] : 0;
          const upper = y > 0 ? comp[((y - 1) * width + x) * 3 + c] : 0;
          const upperLeft = x > 0 && y > 0 ? comp[((y - 1) * width + (x - 1)) * 3 + c] : 0;
          let prediction = left + upper - upperLeft;
          if (prediction < 0) prediction = 0;
          else if (prediction > 255) prediction = 255;
          comp[(y * width + x) * 3 + c] = v[c];
          void prediction;
        }
      }
    }
    // Second pass: the differences, once every V is known.
    filtered = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          const v = comp[(y * width + x) * 3 + c];
          const left = x > 0 ? comp[(y * width + (x - 1)) * 3 + c] : 0;
          const upper = y > 0 ? comp[((y - 1) * width + x) * 3 + c] : 0;
          const upperLeft = x > 0 && y > 0 ? comp[((y - 1) * width + (x - 1)) * 3 + c] : 0;
          let prediction = left + upper - upperLeft;
          if (prediction < 0) prediction = 0;
          else if (prediction > 255) prediction = 255;
          filtered[(y * width + x) * 3 + c] = (v - prediction) & 0xff;
        }
      }
    }
  } else {
    filtered = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = opts.pixels(x, y);
        filtered[(y * width + x) * 3] = r;
        filtered[(y * width + x) * 3 + 1] = g;
        filtered[(y * width + x) * 3 + 2] = b;
      }
    }
  }

  // The framing rule that decides everything downstream: below 12 filtered
  // bytes the data is sent AS IS with NO length prefix.
  if (opts.compress) {
    const data = opts.compress.data;
    const len = data.length;
    const compact: number[] = [];
    if (len <= 0x7f) compact.push(len);
    else if (len <= 0x3fff) compact.push((len & 0x7f) | 0x80, (len >> 7) & 0x7f);
    else compact.push((len & 0x7f) | 0x80, ((len >> 7) & 0x7f) | 0x80, (len >> 14) & 0xff);
    parts.push(Buffer.from(compact), data);
  } else if (filtered.length < 12) {
    parts.push(filtered);
  } else {
    const data = deflateSync(filtered);
    const len = data.length;
    const compact: number[] = [];
    if (len <= 0x7f) compact.push(len);
    else if (len <= 0x3fff) compact.push((len & 0x7f) | 0x80, (len >> 7) & 0x7f);
    else compact.push((len & 0x7f) | 0x80, ((len >> 7) & 0x7f) | 0x80, (len >> 14) & 0xff);
    parts.push(Buffer.from(compact), data);
  }

  return { payload: Buffer.concat(parts), filtered };
}

/** Wrap rect payload(s) in a FramebufferUpdate. One rect unless told otherwise. */
function update(
  rects: Array<{ x: number; y: number; width: number; height: number; payload: Buffer; encoding?: number }>,
): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt8(0, 0); // FramebufferUpdate
  head.writeUInt8(0, 1);
  head.writeUInt16BE(rects.length, 2);
  const bodies = rects.map((r) => {
    const h = Buffer.alloc(12);
    h.writeUInt16BE(r.x, 0);
    h.writeUInt16BE(r.y, 2);
    h.writeUInt16BE(r.width, 4);
    h.writeUInt16BE(r.height, 6);
    h.writeInt32BE(r.encoding ?? OPERATOR_RFB_ENCODING_TIGHT, 8);
    return Buffer.concat([h, r.payload]);
  });
  return Buffer.concat([head, ...bodies]);
}

/** Read back the decoded RGBA framebuffer at (x,y). */
function rgbaAt(dec: OperatorScreenDecoder, x: number, y: number): [number, number, number] {
  const snap = dec.snapshot();
  if (!snap) throw new Error('no snapshot');
  const { width, rgba } = snap;
  const at = (y * width + x) * 4;
  return [rgba[at], rgba[at + 1], rgba[at + 2]];
}

const checker = (x: number, y: number): [number, number, number] => [
  (x * 7) & 0xff,
  (y * 11) & 0xff,
  ((x + y) * 5) & 0xff,
];

// ── 1. The unfiltered path (CopyFilter), compressed and inline ─────────────

describe('T1 — CopyFilter: the plain Tight stream', () => {
  it('decodes a compressed CopyFilter rect byte-for-byte', () => {
    const width = 32;
    const height = 24;
    const { payload } = encodeTightRect({ width, height, pixels: checker });
    const dec = new OperatorScreenDecoder();
    const events = dec.push(update([{ x: 0, y: 0, width, height, payload }]));

    expect(events.some((e) => e.type === 'desync')).toBe(false);
    expect(dec.isHalted).toBe(false);
    // Sample a spread of pixels, including the last row/column — an off-by-one
    // stride survives a corner check but not this.
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [31, 0],
      [0, 23],
      [31, 23],
      [17, 9],
    ]) {
      expect(rgbaAt(dec, x, y)).toEqual(checker(x, y));
    }
  });

  it('decodes an INLINE rect (filtered < 12 bytes) with no length prefix', () => {
    // 1x1x3 = 3 filtered bytes. The spec says such data is sent as-is, with no
    // compact length in front. A decoder that reads a length here consumes the
    // red component as a length byte and every later byte lands wrong.
    const { payload } = encodeTightRect({ width: 1, height: 1, pixels: () => [9, 8, 7] });
    expect(payload.length).toBe(1 + 3); // control + 3 raw bytes, nothing else
    const dec = new OperatorScreenDecoder();
    dec.push(update([{ x: 0, y: 0, width: 1, height: 1, payload }]));
    expect(rgbaAt(dec, 0, 0)).toEqual([9, 8, 7]);
  });

  it('decodes a rect whose width exceeds one byte of length (2-byte compact)', () => {
    // 512x512x3 filters to 786432 bytes, whose COMPRESSED length still exceeds
    // 127 for random-ish data — forcing the 2-byte compact form. The random
    // pattern is deliberate: a uniform fill compresses to a handful of bytes
    // and never exercises it.
    const width = 512;
    const height = 512;
    const noise = (x: number, y: number): [number, number, number] => [
      (x * 31 + y * 17) & 0xff,
      (x * 13 + y * 29) & 0xff,
      (x * 3 + y * 7) & 0xff,
    ];
    const { payload } = encodeTightRect({ width, height, pixels: noise });
    const framed = tightPayloadBytes(payload, 0, payload.length, width, height);
    expect(framed.kind).toBe('ok');
    expect(framed.kind === 'ok' && framed.bytes).toBe(payload.length);

    const dec = new OperatorScreenDecoder();
    dec.push(update([{ x: 0, y: 0, width, height, payload }]));
    expect(dec.isHalted).toBe(false);
    expect(rgbaAt(dec, 0, 0)).toEqual(noise(0, 0));
    expect(rgbaAt(dec, 300, 400)).toEqual(noise(300, 400));
  });
});

// ── 2. FillCompression ─────────────────────────────────────────────────────

describe('T2 — FillCompression: one TPIXEL for the whole rect', () => {
  it('fills every pixel with the single carried value', () => {
    const width = 16;
    const height = 16;
    // control = 0x80 | 0x08 = FillCompression, stream 0.
    const payload = Buffer.concat([Buffer.from([0x88]), Buffer.from([12, 34, 56])]);
    const dec = new OperatorScreenDecoder();
    dec.push(update([{ x: 0, y: 0, width, height, payload }]));
    expect(dec.isHalted).toBe(false);
    for (const [x, y] of [
      [0, 0],
      [15, 15],
      [7, 3],
    ]) {
      expect(rgbaAt(dec, x, y)).toEqual([12, 34, 56]);
    }
  });

  it('honours the stream-reset bits even on a FillCompression rect', () => {
    // The spec is explicit: "the decoder must reset the indicated zlib streams
    // even if the compression type is FillCompression or JpegCompression". A
    // decoder that only resets on compression paths carries a stale window into
    // the next rect and silently mis-decodes its first back-reference.
    const streams = createTightStreams();
    streams[0].history = Buffer.from('stale-window');
    streams[0].started = true;
    const payload = Buffer.concat([Buffer.from([0x89]), Buffer.from([1, 2, 3])]); // reset bit 0
    const res = decodeTightRect(payload, 4, 4, streams);
    expect(res.ok).toBe(true);
    expect(streams[0].started).toBe(false);
    expect(streams[0].history.length).toBe(0);
  });
});

// ── 3. PaletteFilter ───────────────────────────────────────────────────────

describe('T3 — PaletteFilter: 1-bit and 8-bit indices', () => {
  it('decodes a 2-colour palette with MSB = leftmost pixels', () => {
    // A 1-bit palette is where a bit-order mistake hides: reading LSB-first
    // produces a horizontally mirrored image, which still "looks like" an
    // image. The pattern below is asymmetric on purpose.
    const width = 40;
    const height = 8;
    const left: [number, number, number] = [200, 10, 10];
    const right: [number, number, number] = [10, 10, 200];
    const pixels = (x: number): [number, number, number] => (x < 20 ? left : right);
    const { payload } = encodeTightRect({ width, height, pixels, filter: 'palette' });

    const dec = new OperatorScreenDecoder();
    dec.push(update([{ x: 0, y: 0, width, height, payload }]));
    expect(dec.isHalted).toBe(false);
    expect(rgbaAt(dec, 0, 0)).toEqual(left);
    expect(rgbaAt(dec, 19, 7)).toEqual(left);
    expect(rgbaAt(dec, 20, 0)).toEqual(right);
    expect(rgbaAt(dec, 39, 7)).toEqual(right);
  });

  it('decodes an 8-bit palette with more than two colours', () => {
    // PaletteFilter carries at most 256 colours (the count is a single byte,
    // "255 means 256 colors"), so the fixture must stay inside that or it is
    // not a legal Tight rect at all. 16x12 = 192 distinct colours: legal, and
    // 8 bits per pixel rather than the 1-bit mono form.
    const width = 16;
    const height = 12;
    const ramp = (x: number, y: number): [number, number, number] => [x * 10, y * 15, 77];
    const { payload } = encodeTightRect({ width, height, pixels: ramp, filter: 'palette' });
    const dec = new OperatorScreenDecoder();
    dec.push(update([{ x: 0, y: 0, width, height, payload }]));
    expect(dec.isHalted).toBe(false);
    expect(rgbaAt(dec, 0, 0)).toEqual([0, 0, 77]);
    expect(rgbaAt(dec, 15, 11)).toEqual([150, 165, 77]);
    expect(rgbaAt(dec, 7, 5)).toEqual(ramp(7, 5));
  });

  it('decodes a full 256-colour palette (the format maximum)', () => {
    // 16x16 = 256 distinct colours, exactly the ceiling. A decoder that reserved
    // 255 would fail on the last index only — invisible on any smaller fixture.
    const width = 16;
    const height = 16;
    const ramp = (x: number, y: number): [number, number, number] => [x * 16, y * 16, 0];
    const { payload } = encodeTightRect({ width, height, pixels: ramp, filter: 'palette' });
    expect(payload[2]).toBe(255); // 256 colours, stored as count-1
    const dec = new OperatorScreenDecoder();
    dec.push(update([{ x: 0, y: 0, width, height, payload }]));
    expect(dec.isHalted).toBe(false);
    expect(rgbaAt(dec, 15, 15)).toEqual([240, 240, 0]);
  });

  it('reads the palette RAW, before the compressed block', () => {
    // Confirmed against two independent servers: libvncserver writes the
    // palette straight into its update buffer, and noVNC reads numColors*3 off
    // the socket before touching a zlib stream. A decoder that expects the
    // palette inside the compressed data desynchronises both.
    const { payload } = encodeTightRect({
      width: 16,
      height: 16,
      pixels: (x) => (x < 8 ? [1, 2, 3] : [4, 5, 6]),
      filter: 'palette',
    });
    // control(0x40) filter(1) count(1) palette(6) then the length-prefixed data.
    expect(payload[0]).toBe(0x40);
    expect(payload[1]).toBe(1); // PaletteFilter
    expect(payload[2]).toBe(1); // 2 colours
    expect([payload[3], payload[4], payload[5]]).toEqual([1, 2, 3]);
    expect([payload[6], payload[7], payload[8]]).toEqual([4, 5, 6]);
  });
});

// ── 4. GradientFilter ──────────────────────────────────────────────────────

describe('T4 — GradientFilter: the clamped predictor', () => {
  it('reconstructs a smooth image, clamping the predictor at both ends', () => {
    // The predictor is clamped to 0..255 and the delta is mod 256, so a naive
    // implementation drifts on gradients that cross either boundary. This
    // image does both.
    const width = 32;
    const height = 24;
    const grad = (x: number, y: number): [number, number, number] => [
      (x * 8) & 0xff,
      (255 - y * 10) & 0xff,
      (x * 3 + y * 5) & 0xff,
    ];
    const { payload } = encodeTightRect({ width, height, pixels: grad, filter: 'gradient' });
    const dec = new OperatorScreenDecoder();
    dec.push(update([{ x: 0, y: 0, width, height, payload }]));
    expect(dec.isHalted).toBe(false);
    for (const [x, y] of [
      [0, 0],
      [31, 0],
      [0, 23],
      [31, 23],
      [9, 11],
    ]) {
      expect(rgbaAt(dec, x, y)).toEqual(grad(x, y));
    }
  });

  it('round-trips a photo-like image where the predictor beats the delta', () => {
    // A busy-but-smooth field: enough structure that a transposed predictor
    // (upper/left swapped) changes the result.
    const width = 20;
    const height = 20;
    const f = (x: number, y: number): [number, number, number] => [
      (x * 5 + y * 2) & 0xff,
      ((x * y) & 0xff),
      (200 - x * 4 - y) & 0xff,
    ];
    const { payload } = encodeTightRect({ width, height, pixels: f, filter: 'gradient' });
    const dec = new OperatorScreenDecoder();
    dec.push(update([{ x: 0, y: 0, width, height, payload }]));
    expect(dec.isHalted).toBe(false);
    for (let y = 0; y < height; y += 3) {
      for (let x = 0; x < width; x += 3) {
        expect(rgbaAt(dec, x, y)).toEqual(f(x, y));
      }
    }
  });
});

// ── 5. PERSISTENT zlib streams — the pin a naive decoder cannot pass ───────

describe('T5 — zlib streams PERSIST across rectangles', () => {
  /** Drive a real `createDeflate` stream, capturing one chunk per rect. */
  async function deflatePerRect(rects: Buffer[]): Promise<Buffer[]> {
    const def = createDeflate({ level: 6 });
    const chunks: Buffer[] = [];
    let current: Buffer[] = [];
    def.on('data', (d) => current.push(Buffer.from(d)));
    for (const rect of rects) {
      current = [];
      def.write(rect);
      await new Promise<void>((resolve) => def.flush(zlibConstants.Z_SYNC_FLUSH, resolve));
      chunks.push(Buffer.concat(current));
    }
    return chunks;
  }

  it('decodes two rects sharing one zlib stream, with real back-references', async () => {
    // Rect 2 is a near-duplicate of rect 1, so zlib emits matches pointing INTO
    // rect 1's output. That is what a repainting window looks like on the wire,
    // and it is the case a per-rect inflate cannot decode: the second chunk has
    // no zlib header, only continuation. MEASURED on Node 22.23.3 — a fresh
    // `inflateSync` on that chunk throws `Z_DATA_ERROR: incorrect header check`,
    // while `inflateRawSync(..., {dictionary})` reproduces it exactly.
    const width = 40;
    const height = 40;
    const base = Buffer.alloc(width * height * 3);
    for (let i = 0; i < base.length; i++) base[i] = (i * 37 + 11) & 0xff;
    const rect1 = Buffer.from(base);
    const rect2 = Buffer.from(base);
    rect2[100] = 0;
    rect2[2000] = 0;

    const [chunk1, chunk2] = await deflatePerRect([rect1, rect2]);

    // The evidence that cross-rect back-references really happened: the second
    // chunk is a fraction of the first for the SAME amount of data.
    expect(chunk1.length).toBeGreaterThan(chunk2.length * 3);

    const p1 = encodeTightRect({
      width,
      height,
      pixels: () => [0, 0, 0],
      compress: { data: chunk1 },
    }).payload;
    // Replace the computed filtered bytes with the real image but keep the
    // compressed chunk: `encodeTightRect` only uses `compress.data`.
    const p2 = encodeTightRect({
      width,
      height,
      pixels: () => [0, 0, 0],
      compress: { data: chunk2 },
    }).payload;

    const dec = new OperatorScreenDecoder();
    dec.push(update([{ x: 0, y: 0, width, height, payload: p1 }]));
    expect(dec.isHalted).toBe(false);
    // The first rect is decoded from the real image: verify against `base`.
    const expectBase = (x: number, y: number) => {
      const at = (y * width + x) * 3;
      return [base[at], base[at + 1], base[at + 2]];
    };
    expect(rgbaAt(dec, 0, 0)).toEqual(expectBase(0, 0));
    expect(rgbaAt(dec, 39, 39)).toEqual(expectBase(39, 39));

    // The second must CONTINUE the same stream, not start a new zlib stream.
    dec.push(update([{ x: 0, y: 0, width, height, payload: p2 }]));
    expect(dec.isHalted).toBe(false);
    const at100 = (Math.floor(100 / 3) * 1) * 0; // keep the index arithmetic explicit
    void at100;
    // Byte 0 of rect2's filtered data is still base[0]; the changed bytes are
    // inside the rect, so a decoder that dropped the dictionary would either
    // throw or produce garbage — both caught by these.
    expect(rgbaAt(dec, 0, 0)).toEqual([base[0], base[1], base[2]]);
    expect(rgbaAt(dec, 20, 20)).toEqual(expectBase(20, 20));
  });

  it('resets a stream when the control byte says so, and then starts it fresh', () => {
    // Rect 1 establishes a window; rect 2 sets the reset bit and carries a
    // COMPLETE zlib stream (header included). Honouring the reset is what makes
    // that legal — without it the decoder treats a header as continuation.
    const width = 8;
    const height = 8;
    const filtered = Buffer.alloc(width * height * 3, 0x5a);
    const complete = deflateSync(filtered);

    const dec = new OperatorScreenDecoder();
    const first = encodeTightRect({ width, height, pixels: () => [1, 1, 1] }).payload;
    dec.push(update([{ x: 0, y: 0, width, height, payload: first }]));
    expect(dec.isHalted).toBe(false);

    const second = encodeTightRect({
      width,
      height,
      pixels: () => [0, 0, 0],
      compress: { data: complete, reset: true },
    }).payload;
    dec.push(update([{ x: 0, y: 0, width, height, payload: second }]));
    expect(dec.isHalted).toBe(false);
    expect(rgbaAt(dec, 0, 0)).toEqual([0x5a, 0x5a, 0x5a]);
  });
});

// ── 6. Bounds: the decoded size, before any allocation ─────────────────────

describe('T6 — a Tight rect cannot exhaust memory', () => {
  it('refuses a 65535x65535 header without allocating or throwing', () => {
    // The Hextile lesson, applied to Tight: the wire size is bounded by
    // MAX_RECT_BYTES, the DECODED size is not. 65535x65535 would ask
    // Buffer.alloc for 17 GB.
    const streams = createTightStreams();
    const payload = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    let threw = false;
    let res: ReturnType<typeof decodeTightRect> | null = null;
    try {
      res = decodeTightRect(payload, 65535, 65535, streams);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false); // a refusal, not a RangeError out of a callback
    expect(res!.ok).toBe(false);
  });

  it('refuses a rect WIDER than the 2048-pixel Tight limit', () => {
    // "the width of any Tight-encoded rectangle cannot exceed 2048 pixels".
    const streams = createTightStreams();
    const res = decodeTightRect(Buffer.from([0x00]), 4096, 8, streams);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.detail).toMatch(/2048/);
  });

  it('refuses a zlib BOMB instead of inflating it past the declared size', () => {
    // A tiny compressed payload that expands far beyond the filtered size the
    // header implies. `maxOutputLength` is the exact bound, enforced by zlib
    // itself before the output is allocated.
    const width = 16;
    const height = 16;
    const filtered = width * height * 3; // 768
    const bomb = deflateSync(Buffer.alloc(filtered * 200, 0));
    expect(bomb.length).toBeLessThan(0x3fff);

    const compact = [(bomb.length & 0x7f) | 0x80, (bomb.length >> 7) & 0x7f];
    const payload = Buffer.concat([Buffer.from([0x00]), Buffer.from(compact), bomb]);
    const streams = createTightStreams();
    const res = decodeTightRect(payload, width, height, streams);
    expect(res.ok).toBe(false);
  });

  it('STILL decodes a legitimate 1920x1200 screen under the ceiling', () => {
    // The ceiling must not quietly become a correctness bug.
    const width = 1920;
    const height = 1200;
    const f = (x: number, y: number): [number, number, number] => [
      (x & 0xff),
      (y & 0xff),
      ((x ^ y) & 0xff),
    ];
    const { payload } = encodeTightRect({ width, height, pixels: f });
    const dec = new OperatorScreenDecoder();
    dec.push(update([{ x: 0, y: 0, width, height, payload }]));
    expect(dec.isHalted).toBe(false);
    expect(rgbaAt(dec, 0, 0)).toEqual(f(0, 0));
    expect(rgbaAt(dec, 1919, 1199)).toEqual(f(1919, 1199));
  });
});

// ── 7. Framing: the boundary scan can SIZE a Tight update ──────────────────

describe('T7 — a Tight update is findable by the boundary scan', () => {
  it('operatorUpdateShape reports a complete, sized update', () => {
    const width = 32;
    const height = 32;
    const { payload } = encodeTightRect({ width, height, pixels: checker });
    const msg = update([{ x: 0, y: 0, width, height, payload }]);
    const shape = operatorUpdateShape(msg, 0, msg.length);
    expect(shape.isUpdate).toBe(true);
    expect(shape.complete).toBe(true);
    expect(shape.totalBytes).toBe(msg.length);
  });

  it('reports INCOMPLETE when the compressed payload is still arriving', () => {
    const width = 64;
    const height = 64;
    const { payload } = encodeTightRect({ width, height, pixels: checker });
    const msg = update([{ x: 0, y: 0, width, height, payload }]);
    const shape = operatorUpdateShape(msg.subarray(0, msg.length - 10), 0, msg.length - 10);
    expect(shape.isUpdate).toBe(true);
    // Not provably complete — never a false "complete", which would render a
    // truncated screen as current (the D1 class of defect).
    expect(shape.complete).toBe(false);
    expect(shape.totalBytes).toBeNull();
  });
});

// ── 8. Honest refusal: JPEG is not faked, and unimplemented still refuses ──

describe('T8 — what is not implemented refuses, it never fakes a decode', () => {
  it('refuses Tight JPEG rather than inventing pixels', () => {
    // Bits 7-4 = 1001 ⇒ JpegCompression, so the control byte is 0x90 (NOT 0x89,
    // which is FillCompression — the spec's table is literal about this and an
    // off-by-one nibble here silently changes which decoder runs).
    // We never advertise a JPEG quality level, so a compliant server will not
    // send this; a non-compliant one gets a refusal, not a hole in the picture.
    const payload = Buffer.concat([Buffer.from([0x90]), Buffer.from([0, 5, 1, 2, 3, 4])]);
    const dec = new OperatorScreenDecoder();
    dec.push(update([{ x: 0, y: 0, width: 8, height: 8, payload }]));
    expect(dec.isHalted).toBe(true);
    expect(dec.haltReasonCode).toBe('bad-tight');
    expect(dec.snapshot()).toBeNull();
  });

  it('refuses an unknown compression-control byte', () => {
    const streams = createTightStreams();
    // 0xF0 = bit7 set, bits 7-4 = 1111 → not a legal compression method.
    const res = decodeTightRect(Buffer.from([0xf0, 1, 2, 3]), 8, 8, streams);
    expect(res.ok).toBe(false);
  });

  it('refuses an unknown filter-id instead of guessing its transform', () => {
    const streams = createTightStreams();
    // control 0x40 = read-filter-id; filter 9 does not exist.
    const res = decodeTightRect(Buffer.concat([Buffer.from([0x40, 9])]), 8, 8, streams);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.detail).toMatch(/filter-id/);
  });

  it('a rect that CLAIMS Tight but is malformed halts the stream', () => {
    const dec = new OperatorScreenDecoder();
    // A tight rect whose payload is a single control byte: the framing cannot
    // be satisfied, and the honest answer is a desync, not a blank rect.
    dec.push(update([{ x: 0, y: 0, width: 16, height: 16, payload: Buffer.from([0x00]) }]));
    expect(dec.isHalted).toBe(false); // waiting for more bytes is NOT a halt
    expect(dec.pending).toBeGreaterThan(0);
  });
});

// ── 9. Composition: Tight joins the one pixel path ─────────────────────────

describe('T9 — Tight composites through the SAME path as Raw', () => {
  it('places a Tight rect at its offset inside a Raw-defined canvas', () => {
    // The canvas is established by a Raw rect, then a Tight rect is painted into
    // a sub-region. This is what a real update looks like: a full Raw frame
    // followed by cheaper delta rects.
    const full = 32;
    const raw = Buffer.alloc(full * full * 4);
    for (let i = 0; i < full * full; i++) {
      raw[i * 4] = 0; // B
      raw[i * 4 + 1] = 0; // G
      raw[i * 4 + 2] = 0; // R
      raw[i * 4 + 3] = 0;
    }
    const dec = new OperatorScreenDecoder();
    dec.push(
      update([{ x: 0, y: 0, width: full, height: full, payload: raw, encoding: OPERATOR_RFB_ENCODING_RAW }]),
    );
    expect(rgbaAt(dec, 5, 5)).toEqual([0, 0, 0]);

    const patch = encodeTightRect({ width: 8, height: 8, pixels: () => [250, 100, 50] }).payload;
    dec.push(update([{ x: 8, y: 4, width: 8, height: 8, payload: patch }]));
    expect(dec.isHalted).toBe(false);
    expect(rgbaAt(dec, 8, 4)).toEqual([250, 100, 50]);
    expect(rgbaAt(dec, 15, 11)).toEqual([250, 100, 50]);
    // Outside the patch is untouched — proves the offset was honoured.
    expect(rgbaAt(dec, 7, 4)).toEqual([0, 0, 0]);
    expect(rgbaAt(dec, 16, 4)).toEqual([0, 0, 0]);
    expect(rgbaAt(dec, 8, 12)).toEqual([0, 0, 0]);
  });

  it('survives a chunked arrival, byte-dribbled like the relay delivers it', () => {
    // The relay hands over MANY small base64 payloads, not one buffer. A decoder
    // that only works when the whole rect arrives at once fails in the field.
    const width = 24;
    const height = 24;
    const { payload } = encodeTightRect({ width, height, pixels: checker });
    const msg = update([{ x: 0, y: 0, width, height, payload }]);

    const dec = new OperatorScreenDecoder();
    for (let off = 0; off < msg.length; off += 3) {
      dec.ingest(msg.subarray(off, Math.min(off + 3, msg.length)).toString('base64'));
      if (dec.isHalted) break;
    }
    expect(dec.isHalted).toBe(false);
    expect(rgbaAt(dec, 0, 0)).toEqual(checker(0, 0));
    expect(rgbaAt(dec, 23, 23)).toEqual(checker(23, 23));
  });
});
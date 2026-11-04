/**
 * WINDOWS/RFB CODEC SLICE (ticket c468f922, 2026-11-02).
 *
 * ── WHAT THIS FILE PINS, AND WHY IT EXISTS ─────────────────────────────────
 * `relay-operator-viewer.ts` was written against ONE producer: our own Mac agent's
 * `RelayScreenChannel.sendScreen`, which emits a single origin-anchored Raw
 * rectangle per screen. A Windows VNC server does not work that way. Its updates
 * are deltas — a handful of small rectangles covering only the DIRTY regions —
 * and it reaches for CopyRect (a window drag, a scroll), Hextile (16x16 tiles) and
 * the LastRect pseudo-encoding to say "that is all the rectangles".
 *
 * Against such a stream the decoder did one of two things, both wrong:
 *   - a Hextile or CopyRect rect hit `unsupported-encoding` and HALTED, so a live
 *     Windows desktop came back as a codec desync; and
 *   - `number-of-rectangles = 0xFFFF` (LastRect) was read as a literal count, so
 *     the decoder waited for 65535 rectangles that were never coming.
 *
 * ── WHAT IS REAL HERE, AND WHAT IS NOT ─────────────────────────────────────
 * REAL: the decoder under test is the shipping module.
 * FIXTURES: every byte below is built to RFC 6143 §7.7 by hand. No Windows host
 * and no VNC server was available to this lane (see the final report), so these
 * are synthetic frames, exactly as the supervisor's steer allows. Each fixture
 * asserts the RFC field layout it encodes, so a fixture that drifts from the spec
 * fails here rather than quietly agreeing with a matching bug in the decoder.
 *
 * NOT CLAIMED: that a physical Windows box drives this. The device-gated e2e
 * stays PARKED.
 */

import {
  OPERATOR_RFB_BYTES_PER_PIXEL,
  OPERATOR_RFB_ENCODING_COPY_RECT,
  OPERATOR_RFB_ENCODING_DESKTOP_SIZE,
  OPERATOR_RFB_ENCODING_HEXTILE,
  OPERATOR_RFB_ENCODING_LAST_RECT,
  OPERATOR_RFB_ENCODING_RAW,
  OPERATOR_RFB_RECT_COUNT_LASTRECT,
  OPERATOR_HEXTILE_ANY_SUBRECTS,
  OPERATOR_HEXTILE_BACKGROUND_SPECIFIED,
  OPERATOR_HEXTILE_FOREGROUND_SPECIFIED,
  OPERATOR_HEXTILE_SUBRECTS_COLOURED,
  OperatorScreenDecoder,
  decodeHextileToWirePixels,
  operatorUpdateShape,
} from './relay-operator-viewer';

// ─────────────────────────────────────────────────────────────────────────────
// Wire helpers (RFC 6143). Everything is big-endian on this wire.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One pixel in the format both ends declare: 32bpp true colour, LITTLE-endian,
 * so the four bytes on the wire are `BB GG RR 00` (§7.6.2). Written as a helper
 * so no test hand-rolls the byte order and gets it "right" by accident.
 */
function pixel(r: number, g: number, b: number): Buffer {
  return Buffer.from([b & 0xff, g & 0xff, r & 0xff, 0x00]);
}

/** Update header: type(1)=0 padding(1)=0 number-of-rectangles(2). §7.6.1. */
function updateHeader(numRects: number): Buffer {
  const b = Buffer.alloc(4);
  b[0] = 0;
  b[1] = 0;
  b.writeUInt16BE(numRects, 2);
  return b;
}

/** Rect header: x(2) y(2) w(2) h(2) encoding(4). §7.6.1. */
function rectHeader(x: number, y: number, w: number, h: number, encoding: number): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(x, 0);
  b.writeUInt16BE(y, 2);
  b.writeUInt16BE(w, 4);
  b.writeUInt16BE(h, 6);
  b.writeInt32BE(encoding, 8);
  return b;
}

/** A rectangle filled with one colour, as a Raw rect. */
function rawRect(x: number, y: number, w: number, h: number, px: Buffer): Buffer {
  return Buffer.concat([rectHeader(x, y, w, h, OPERATOR_RFB_ENCODING_RAW), Buffer.concat(Array(w * h).fill(px))]);
}

/**
 * A whole framebuffer update carrying `rects`.
 *
 * ── ONE ENTRY MUST BE ONE COMPLETE RECT (header + payload) ──────────────────
 * The rect count is the array length, so passing a header and its payload as two
 * entries silently declares TWO rectangles — the first of which is a 12-byte
 * header followed by payload bytes the parser reads as another header. That is a
 * fixture bug that MASKS itself: it produced plausible-looking failures in the
 * CopyRect cases while the decoder was in fact correct. Use `rect()` below for
 * anything with a payload so this cannot be written by accident.
 */
function update(rects: Buffer[]): Buffer {
  return Buffer.concat([updateHeader(rects.length), ...rects]);
}

/** One complete rect: header + payload. The only safe way to build a rect. */
function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  encoding: number,
  payload: Buffer,
): Buffer {
  return Buffer.concat([rectHeader(x, y, w, h, encoding), payload]);
}

/** Read the RGBA of the snapshot at (x,y). */
function rgbaAt(rgba: Buffer, width: number, x: number, y: number): [number, number, number] {
  const i = (y * width + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2]];
}

/** A decoder already told its geometry, so rects land on a known canvas. */
function decoderAt(width: number, height: number): OperatorScreenDecoder {
  const dec = new OperatorScreenDecoder();
  dec.push(update([rectHeader(0, 0, width, height, OPERATOR_RFB_ENCODING_DESKTOP_SIZE)]));
  return dec;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The RFC field layout itself — so a drifted fixture fails loudly
// ─────────────────────────────────────────────────────────────────────────────

describe('THE FIXTURES MATCH RFC 6143 (a drifted fixture must not agree with a bug)', () => {
  it('a Rect header is 12 bytes, big-endian, with a signed 32-bit encoding', () => {
    const h = rectHeader(3, 5, 7, 11, OPERATOR_RFB_ENCODING_HEXTILE);
    expect(h).toHaveLength(12);
    expect(h.readUInt16BE(0)).toBe(3);
    expect(h.readUInt16BE(2)).toBe(5);
    expect(h.readUInt16BE(4)).toBe(7);
    expect(h.readUInt16BE(6)).toBe(11);
    expect(h.readInt32BE(8)).toBe(5);
  });

  it('the declared pixel format is BB GG RR 00 — the byte order the decoder inverts', () => {
    // If this ever disagrees with `operatorWirePixelsToRgba` the whole Windows
    // path would render with red and blue swapped, which looks almost right.
    expect(pixel(0x11, 0x22, 0x33)).toEqual(Buffer.from([0x33, 0x22, 0x11, 0x00]));
    expect(OPERATOR_RFB_BYTES_PER_PIXEL).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. HEXTILE — the encoding a Windows server actually reaches for
// ─────────────────────────────────────────────────────────────────────────────

describe('HEXTILE (5) DECODES — the Windows workhorse encoding', () => {
  it('a solid tile (background only) fills the tile with that colour', () => {
    // §7.7.4: mask=BackgroundSpecified(2), then one PIXEL. No subrects, so the
    // tile is a flat fill.
    const bg = pixel(10, 20, 30);
    const payload = Buffer.concat([Buffer.from([OPERATOR_HEXTILE_BACKGROUND_SPECIFIED]), bg]);
    const out = decodeHextileToWirePixels(payload, 16, 16);

    expect(out).not.toBeNull();
    // Every pixel of the 16x16 tile is the background, in wire order.
    expect(out!.subarray(0, 4)).toEqual(bg);
    expect(out!.subarray(16 * 16 * 4 - 4)).toEqual(bg);
  });

  it('a raw tile (mask bit 1) is literal pixels with NO other header', () => {
    // §7.7.4: "If the Raw bit is set, then the other bits are irrelevant;
    // width*height pixel values follow". A parser that read a subrect count here
    // would consume the image's first pixel as a count.
    const px = pixel(200, 100, 50);
    const payload = Buffer.concat([Buffer.from([1]), Buffer.concat(Array(16 * 16).fill(px))]);
    const out = decodeHextileToWirePixels(payload, 16, 16);

    expect(out).not.toBeNull();
    expect(out!.subarray(0, 4)).toEqual(px);
    expect(out).toHaveLength(16 * 16 * 4);
  });

  it('a subrect paints ONLY its region, with width/height nibbles meaning +1', () => {
    // §7.7.4: the position byte's nibbles are the tile-relative x,y; the size
    // byte's nibbles are width-1 and height-1. So pos=0x00 size=0xFF is the
    // WHOLE 16x16 tile, and pos=0x11 size=0x00 is a single pixel at (1,1).
    // Getting the +1 wrong paints a 15x15 tile and leaves a visible hairline.
    const bg = pixel(0, 0, 0);
    const fg = pixel(255, 255, 255);
    const mask =
      OPERATOR_HEXTILE_BACKGROUND_SPECIFIED |
      OPERATOR_HEXTILE_FOREGROUND_SPECIFIED |
      OPERATOR_HEXTILE_ANY_SUBRECTS;
    const singlePixel = Buffer.from([0x11, 0x00]); // x=1,y=1, w=1,h=1
    const payload = Buffer.concat([Buffer.from([mask]), bg, fg, Buffer.from([1]), singlePixel]);

    const out = decodeHextileToWirePixels(payload, 16, 16);
    expect(out).not.toBeNull();
    // The single subrect pixel is foreground...
    expect(out!.subarray((1 * 16 + 1) * 4, (1 * 16 + 1) * 4 + 4)).toEqual(fg);
    // ...and its neighbours are background, so the subrect really was bounded.
    expect(out!.subarray(0, 4)).toEqual(bg);
    expect(out!.subarray((2 * 16 + 2) * 4, (2 * 16 + 2) * 4 + 4)).toEqual(bg);
  });

  it('a coloured-subrect tile paints each subrect its OWN colour', () => {
    // §7.7.4: with SubrectsColoured(16) each subrect carries its own PIXEL, so
    // ForegroundSpecified may not also be set.
    //
    // GEOMETRY, deliberately small so each assertion is unambiguous: the size
    // byte's nibbles are width-1 / height-1, so `0x00` is a SINGLE pixel. Two
    // single-pixel subrects at opposite corners make "did each one get its own
    // colour" answerable without a fill overlapping the other.
    const bg = pixel(0, 0, 0);
    const red = pixel(255, 0, 0);
    const green = pixel(0, 255, 0);
    const mask =
      OPERATOR_HEXTILE_BACKGROUND_SPECIFIED |
      OPERATOR_HEXTILE_ANY_SUBRECTS |
      OPERATOR_HEXTILE_SUBRECTS_COLOURED;
    const payload = Buffer.concat([
      Buffer.from([mask]),
      bg,
      Buffer.from([2]), // two subrects
      red, Buffer.from([0x00, 0x00]), // (0,0) 1x1   -> top-left pixel
      green, Buffer.from([0xf0, 0x00]), // (15,0) 1x1 -> top-right pixel
    ]);

    const out = decodeHextileToWirePixels(payload, 16, 16);
    expect(out).not.toBeNull();
    expect(out!.subarray(0, 4)).toEqual(red); // (0,0)
    expect(out!.subarray(15 * 4, 15 * 4 + 4)).toEqual(green); // (15,0)
    // A pixel neither subrect touched keeps the background — so the two colours
    // really were local to their own subrects.
    expect(out!.subarray((1 * 16) * 4, (1 * 16) * 4 + 4)).toEqual(bg);
    expect(out!.subarray((1 * 16 + 8) * 4, (1 * 16 + 8) * 4 + 4)).toEqual(bg);
  });

  it('a multi-tile rectangle walks its tiles left-to-right, top-to-bottom', () => {
    // A 32x16 rect is TWO 16x16 tiles. §7.7.4 fixes the order; walking it wrong
    // swaps the halves and produces a picture that looks plausible and is not.
    const left = pixel(255, 0, 0);
    const right = pixel(0, 0, 255);
    const payload = Buffer.concat([
      Buffer.from([OPERATOR_HEXTILE_BACKGROUND_SPECIFIED]), left,
      Buffer.from([OPERATOR_HEXTILE_BACKGROUND_SPECIFIED]), right,
    ]);

    const out = decodeHextileToWirePixels(payload, 32, 16);
    expect(out).not.toBeNull();
    expect(out!.subarray(0, 4)).toEqual(left); // (0,0)
    expect(out!.subarray(16 * 4, 16 * 4 + 4)).toEqual(right); // (16,0)
  });

  it('the last tile in a row is CLIPPED to the rectangle, not padded to 16', () => {
    // §7.7.4: "if the width of the whole rectangle is not an exact multiple of
    // 16, then the width of the last tile ... will be correspondingly smaller".
    // A 20x8 rect is one full tile plus a 4x8 tile, and each is sized by ITS OWN
    // geometry — a parser that assumed 16x16 would read past the payload.
    const a = pixel(1, 2, 3);
    const b = pixel(4, 5, 6);
    const payload = Buffer.concat([
      Buffer.from([OPERATOR_HEXTILE_BACKGROUND_SPECIFIED]), a,
      Buffer.from([OPERATOR_HEXTILE_BACKGROUND_SPECIFIED]), b,
    ]);

    const out = decodeHextileToWirePixels(payload, 20, 8);
    expect(out).not.toBeNull();
    expect(out!.subarray(0, 4)).toEqual(a); // (0,0)
    expect(out!.subarray(16 * 4, 16 * 4 + 4)).toEqual(b); // (16,0) clipped tile
    expect(out!.subarray((1 * 20) * 4, (1 * 20) * 4 + 4)).toEqual(a); // (0,1)
  });

  it('background carries ACROSS tiles but is CLEARED by a raw tile (§7.7.4)', () => {
    // The delta-coding rule that is easiest to get wrong. After a raw tile there
    // is no valid previous background, so a following tile that does not specify
    // one is a malformed stream — guessing here paints a tile in a neighbour's
    // colour, which is a wrong picture rather than a refusal.
    const bg = pixel(9, 9, 9);
    const px = pixel(200, 200, 200);
    const raw16 = Buffer.concat([Buffer.from([1]), Buffer.concat(Array(16 * 16).fill(px))]);
    // Tile 1 fills with bg; tile 2 is raw (clearing bg); tile 3 specifies nothing.
    const payload = Buffer.concat([
      Buffer.from([OPERATOR_HEXTILE_BACKGROUND_SPECIFIED]), bg,
      raw16,
      Buffer.from([OPERATOR_HEXTILE_ANY_SUBRECTS]), Buffer.from([0]),
    ]);

    // 48x16 = three tiles. Tile 3 needs a background that no longer exists.
    expect(decodeHextileToWirePixels(payload, 48, 16)).toBeNull();
  });

  it('a malformed tile stream returns null instead of throwing into the pump', () => {
    // The decoder turns this into a `bad-hextile` desync; it may never raise into
    // a pump that is holding a live session open.
    expect(() => decodeHextileToWirePixels(Buffer.from([0]), 16, 16)).not.toThrow();
    expect(decodeHextileToWirePixels(Buffer.from([0]), 16, 16)).toBeNull();
    // A truncated payload (a raw tile claiming more pixels than were sent).
    expect(decodeHextileToWirePixels(Buffer.from([1, 0, 0, 0]), 16, 16)).toBeNull();
  });

  it('end-to-end: a Hextile rect composites onto the canvas via the Decoder', () => {
    const bg = pixel(12, 34, 56);
    const payload = Buffer.concat([Buffer.from([OPERATOR_HEXTILE_BACKGROUND_SPECIFIED]), bg]);
    const dec = decoderAt(16, 16);
    const events = dec.push(update([rect(0, 0, 16, 16, OPERATOR_RFB_ENCODING_HEXTILE, payload)]));

    expect(dec.isHalted).toBe(false);
    expect(events.some((e) => e.type === 'desync')).toBe(false);

    const snap = dec.snapshot();
    expect(snap).not.toBeNull();
    // Wire BB GG RR 00 -> RGBA RR GG BB
    expect(rgbaAt(snap!.rgba, 16, 0, 0)).toEqual([12, 34, 56]);
    expect(rgbaAt(snap!.rgba, 16, 15, 15)).toEqual([12, 34, 56]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. COPYRECT — the move a Windows server sends for a drag or a scroll
// ─────────────────────────────────────────────────────────────────────────────

describe('COPYRECT (1) MOVES PIXELS — including when source and dest overlap', () => {
  /**
   * Build a decoder holding an 8x8 canvas whose row y is coloured (0, y*10, 0),
   * so every row is identifiable and a mis-stride shows as the wrong row.
   */
  function gradientDecoder(): OperatorScreenDecoder {
    const dec = new OperatorScreenDecoder();
    const rows: Buffer[] = [];
    for (let y = 0; y < 8; y++) rows.push(Buffer.concat(Array(8).fill(pixel(0, y * 10, 0))));
    dec.push(update([rect(0, 0, 8, 8, OPERATOR_RFB_ENCODING_RAW, Buffer.concat(rows))]));
    return dec;
  }

  it('a CopyRect carries no pixels and moves the source region to the dest', () => {
    // §7.7.2: the payload is only src-x(2) src-y(2).
    const dec = gradientDecoder();
    // Move rows 4..7 up to rows 0..3.
    dec.push(update([Buffer.concat([rectHeader(0, 0, 8, 4, OPERATOR_RFB_ENCODING_COPY_RECT), Buffer.from([0, 0, 0, 4])])]));

    const snap = dec.snapshot()!;
    expect(rgbaAt(snap.rgba, 8, 0, 0)).toEqual([0, 40, 0]); // row 4
    expect(rgbaAt(snap.rgba, 8, 0, 3)).toEqual([0, 70, 0]); // row 7
    // Rows below the destination are untouched.
    expect(rgbaAt(snap.rgba, 8, 0, 4)).toEqual([0, 40, 0]);
  });

  it('an OVERLAPPING copy is a memmove, not a smearing forward copy', () => {
    // The scroll case, and the one that silently corrupts a screen: moving rows
    // 0..5 DOWN to rows 2..7 means the destination is BELOW the source, so a
    // naive forward (ascending row) copy overwrites rows it has not read yet —
    // every row ends up a copy of row 0 instead of its own source row. A picture
    // that is plausible and wrong, which is the worst kind.
    //
    // DIRECTION MATTERS: copying UPWARD (dst < src) is safe even without a
    // snapshot, so a test that only scrolls up passes against the buggy code and
    // proves nothing. This asserts the direction that actually aliases.
    const dec = gradientDecoder();
    dec.push(update([rect(0, 2, 8, 6, OPERATOR_RFB_ENCODING_COPY_RECT, Buffer.from([0, 0, 0, 0]))]));

    const snap = dec.snapshot()!;
    // Destination row (2+i) must hold what USED to be row i.
    for (let i = 0; i < 6; i++) {
      expect(rgbaAt(snap.rgba, 8, 0, 2 + i)).toEqual([0, i * 10, 0]);
    }
    // Rows ABOVE the destination are untouched: the visible smear in the buggy
    // version propagates the first row's colour downward, so a row that must
    // still hold its own original colour is the discriminator.
    expect(rgbaAt(snap.rgba, 8, 0, 0)).toEqual([0, 0, 0]);
    expect(rgbaAt(snap.rgba, 8, 0, 1)).toEqual([0, 10, 0]);
  });

  it('a CopyRect whose destination runs past the canvas is CLIPPED, not fatal', () => {
    const dec = gradientDecoder();
    const events = dec.push(update([Buffer.concat([rectHeader(0, 6, 8, 8, OPERATOR_RFB_ENCODING_COPY_RECT), Buffer.from([0, 0, 0, 0])])]));

    expect(dec.isHalted).toBe(false);
    expect(events.some((e) => e.type === 'desync')).toBe(false);
    const snap = dec.snapshot()!;
    expect(rgbaAt(snap.rgba, 8, 0, 6)).toEqual([0, 0, 0]); // row 0 copied down
    expect(snap.height).toBe(8); // canvas NOT grown: there were no pixels to grow with
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. LASTRECT + multi-rect updates — the shape a Windows server actually sends
// ─────────────────────────────────────────────────────────────────────────────

describe('A WINDOWS UPDATE IS MANY RECTANGLES, OFTEN LASTRECT-TERMINATED', () => {
  it('a multi-rect dirty update applies EVERY rect (not just the first)', () => {
    // The incremental shape: three small dirty regions in one update. A decoder
    // that stopped after one rect would show a desktop that is 2/3 stale.
    const dec = decoderAt(20, 20);
    const red = pixel(255, 0, 0);
    const green = pixel(0, 255, 0);
    const blue = pixel(0, 0, 255);
    dec.push(update([
      rawRect(0, 0, 4, 4, red),
      rawRect(10, 10, 4, 4, green),
      rawRect(16, 16, 4, 4, blue),
    ]));

    const snap = dec.snapshot()!;
    expect(rgbaAt(snap.rgba, 20, 0, 0)).toEqual([255, 0, 0]);
    expect(rgbaAt(snap.rgba, 20, 10, 10)).toEqual([0, 255, 0]);
    expect(rgbaAt(snap.rgba, 20, 16, 16)).toEqual([0, 0, 255]);
    // Untouched pixels stay as they were (black from the DesktopSize clear).
    expect(rgbaAt(snap.rgba, 20, 5, 5)).toEqual([0, 0, 0]);
  });

  it('number-of-rectangles = 0xFFFF is a SENTINEL terminated by LastRect', () => {
    // TigerVNC's server takes exactly this path for every update. Reading 0xFFFF
    // as a literal count makes the decoder wait for 65535 rectangles that will
    // never come, so the update never completes and the screen never renders.
    const red = pixel(255, 0, 0);
    const stream = Buffer.concat([
      updateHeader(OPERATOR_RFB_RECT_COUNT_LASTRECT),
      rawRect(0, 0, 4, 4, red),
      rectHeader(0, 0, 0, 0, OPERATOR_RFB_ENCODING_LAST_RECT),
    ]);

    const dec = decoderAt(8, 8);
    const events = dec.push(stream);

    expect(dec.isHalted).toBe(false);
    expect(events.some((e) => e.type === 'desync')).toBe(false);
    // LastRect ends the update, so a SECOND update after it must also decode —
    // which only happens if the decoder left LastRect mode correctly.
    dec.push(update([rawRect(0, 0, 8, 8, pixel(0, 0, 255))]));
    expect(dec.isHalted).toBe(false);
    expect(rgbaAt(dec.snapshot()!.rgba, 8, 0, 0)).toEqual([0, 0, 255]);
  });

  it('the shape walker sizes a multi-rect update without needing the pixels', () => {
    // This is what makes boundary detection work on a stream where an update is
    // 32 rects: the length is arithmetic per rect, so it is knowable up front.
    const red = pixel(255, 0, 0);
    const msg = update([rawRect(0, 0, 2, 2, red), rawRect(4, 4, 2, 2, red)]);
    const shape = operatorUpdateShape(msg, 0, msg.length);

    expect(shape.isUpdate).toBe(true);
    expect(shape.numRects).toBe(2);
    expect(shape.complete).toBe(true);
    expect(shape.totalBytes).toBe(msg.length);
    // Two rects is a delta, not a self-contained whole screen.
    expect(shape.fullFrame).toBe(false);
  });

  it('a Hextile rect is sized by walking its tiles, not by assuming Raw', () => {
    // Hextile is NOT w*h*4 — a solid tile is 5 bytes covering 256 pixels. Sizing
    // it as Raw would overrun the message by ~250x and desync the stream.
    const payload = Buffer.concat([Buffer.from([OPERATOR_HEXTILE_BACKGROUND_SPECIFIED]), pixel(1, 1, 1)]);
    const msg = update([rect(0, 0, 16, 16, OPERATOR_RFB_ENCODING_HEXTILE, payload)]);
    const shape = operatorUpdateShape(msg, 0, msg.length);

    expect(shape.isUpdate).toBe(true);
    expect(shape.complete).toBe(true);
    expect(shape.totalBytes).toBe(msg.length);
    expect(msg.length).toBeLessThan(16 * 16 * 4); // genuinely compressed
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. FAIL-LOUD IS PRESERVED — the property that must NOT be traded away
// ─────────────────────────────────────────────────────────────────────────────

describe('WHAT IS STILL UNSUPPORTED STILL REFUSES', () => {
  it('an encoding we cannot size HALTS with a named reason, never guesses', () => {
    // RRE(2)/TRLE(16)/ZRLE(17) size their payloads by rules this module does
    // not implement, so consuming one would put every later byte at the wrong
    // offset — a stream that can never resynchronise. Tight(7) left this list
    // when its decoder landed; the remaining three keep the property pinned.
    for (const encoding of [2, 16, 17]) {
      const dec = decoderAt(8, 8);
      const events = dec.push(update([Buffer.concat([rectHeader(0, 0, 4, 4, encoding), Buffer.alloc(32)])]));

      expect(dec.isHalted).toBe(true);
      expect(dec.haltReasonCode).toBe('unsupported-encoding');
      expect(events.some((e) => e.type === 'desync')).toBe(true);
    }
  });

  it('a hostile rect count costs a refusal rather than a 65535-rect walk', () => {
    const dec = decoderAt(8, 8);
    dec.push(update([Buffer.concat([rectHeader(0, 0, 4, 4, 9999), Buffer.alloc(8)])]));
    expect(dec.isHalted).toBe(true);
    expect(dec.haltReasonCode).toBe('unsupported-encoding');
  });
});
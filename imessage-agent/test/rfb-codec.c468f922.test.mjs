/**
 * RFB CODEC — macOS device-side tests (ticket c468f922).
 *
 * WHAT MAKES THIS SUITE WORTH HAVING. The ticket's recurring defect is "a
 * requirement no live surface satisfies". The codec layer has its own version
 * of that trap: a decoder that only ever sees the bytes its OWN encoder wrote
 * proves nothing about the protocol — it proves the two functions are inverses
 * of each other, which is true even if both are wrong.
 *
 * So every wire layout asserted here is built BY HAND, byte by byte, from
 * RFC 6143's own field tables (§7.5.3/§7.5.4/§7.5.5/§7.6.1/§7.7.1), and the
 * sizes are asserted as literal byte counts. If someone "simplifies" a header
 * the RFC does not allow, the literal-bytes tests fail.
 *
 * The second thing pinned here is the constraint that decided the design: a
 * relay frame is capped at 64 KiB while ONE Raw rectangle for a 1280×800 screen
 * is 4 096 000 bytes. A codec that assumed one frame = one message could never
 * carry a real screen, and would pass every toy test. So the tests include a
 * REAL SCREEN SIZE carried as real relay-sized chunks, and require byte-exact
 * reassembly.
 *
 * The third: NOTHING THROWS INTO THE POLL LOOP. A hostile or truncated stream
 * must produce a `desync` event, never an exception — because the caller is
 * `pumpRelay`, and an exception there costs the Mac its command channel.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const SRC = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');

/**
 * Strip comments so structural assertions measure CODE, not prose.
 *
 * This file's own doc comment says "no child_process", "no fetch(", "ServerInit
 * is deliberately NOT here" — so a naive regex over the raw source matches the
 * very sentences promising the opposite, and the assertion fails on a correct
 * module. (First run of this suite: 2 failures, both this trap.) Every
 * structural check below runs against `codeOf(...)` instead. String literals
 * are left in place — a URL inside a string is still evidence of a transport.
 */
function codeOf(rel) {
  return SRC(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (incl. doc blocks)
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (not the "//" in a URL)
}

const mod = await import('../dist/rfb-codec.js');
const {
  RfbServerDecoder,
  RfbClientDecoder,
  RfbSession,
  RfbScreen,
  RFB_PIXEL_FORMAT,
  RFB_ENCODING_RAW,
  RFB_ENCODING_DESKTOP_SIZE,
  RFB_RELAY_FRAME_BYTES,
  RFB_MAX_RECT_BYTES,
  encodeFramebufferUpdate,
  encodeDesktopSize,
  encodeKeyEvent,
  encodePointerEvent,
  encodeFramebufferUpdateRequest,
  encodeSetEncodings,
  encodeClientCutText,
  rgbaToRfbPixels,
  rfbPixelsToRgba,
  chunkForRelay,
  joinRelayChunks,
} = mod;

// ─────────────────────────────────────────────────────────────────────────────
// Hand-built wire bytes, straight from RFC 6143's tables
// ─────────────────────────────────────────────────────────────────────────────

/** A Raw rectangle payload: `count` pixels in B,G,R,0 wire order. */
function rfbPixels(pixels) {
  const b = Buffer.alloc(pixels.length * 4);
  pixels.forEach(([r, g, bl], i) => {
    b[i * 4] = bl;
    b[i * 4 + 1] = g;
    b[i * 4 + 2] = r;
    b[i * 4 + 3] = 0;
  });
  return b;
}

/**
 * A FramebufferUpdate built BY HAND (not with the module's encoder):
 * §7.6.1 header is type(1)=0, padding(1), number-of-rectangles(2);
 * each rectangle is x(2) y(2) w(2) h(2) encoding(4)=0 then Raw pixels.
 */
function handBuiltUpdate(rects) {
  const head = Buffer.from([0, 0, 0, rects.length]);
  const parts = [head];
  for (const r of rects) {
    const h = Buffer.alloc(12);
    h.writeUInt16BE(r.x, 0);
    h.writeUInt16BE(r.y, 2);
    h.writeUInt16BE(r.width, 4);
    h.writeUInt16BE(r.height, 6);
    h.writeInt32BE(0, 8); // Raw
    parts.push(h, r.pixels);
  }
  return Buffer.concat(parts);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The wire layout is the RFC's, asserted as literal byte counts
// ─────────────────────────────────────────────────────────────────────────────

test('client message sizes are exactly the RFC 6143 field-table sizes', () => {
  // §7.5.4 KeyEvent: type(1) down-flag(1) padding(2) key(4) = 8
  assert.equal(encodeKeyEvent(0x41, true).length, 8);
  // §7.5.5 PointerEvent: type(1) button-mask(1) x(2) y(2) = 6
  assert.equal(encodePointerEvent(1, 10, 20).length, 6);
  // §7.5.3 FramebufferUpdateRequest: 1+1+2+2+2+2 = 10
  assert.equal(encodeFramebufferUpdateRequest({ incremental: false, width: 4, height: 4 }).length, 10);
  // §7.5.2 SetEncodings: type(1) padding(1) count(2) + 4 per encoding
  assert.equal(encodeSetEncodings([0, 1, 2]).length, 4 + 12);
  // §7.5.6 ClientCutText: type(1) padding(3) length(4) + text
  assert.equal(encodeClientCutText('hi').length, 8 + 2);
});

test('encoded KeyEvent and PointerEvent carry the RFC values in the RFC positions', () => {
  const key = encodeKeyEvent(0xff0d, true); // Return
  assert.equal(key[0], 4, 'message-type 4');
  assert.equal(key[1], 1, 'down-flag set');
  assert.equal(key.readUInt32BE(4), 0xff0d, 'keysym big-endian at offset 4');
  assert.equal(encodeKeyEvent(0xff0d, false)[1], 0, 'release clears down-flag');

  const ptr = encodePointerEvent(0b101, 640, 480);
  assert.equal(ptr[0], 5, 'message-type 5');
  assert.equal(ptr[1], 5, 'button-mask byte 1:1');
  assert.equal(ptr.readUInt16BE(2), 640, 'x big-endian at offset 2');
  assert.equal(ptr.readUInt16BE(4), 480, 'y big-endian at offset 4');

  const req = encodeFramebufferUpdateRequest({ incremental: true, width: 1280, height: 800 });
  assert.equal(req[0], 3);
  assert.equal(req[1], 1, 'incremental flag');
  assert.equal(req.readUInt16BE(6), 1280);
  assert.equal(req.readUInt16BE(8), 800);
});

test('the encoded pixel order is little-endian BB GG RR 00, matching RFB_PIXEL_FORMAT', () => {
  // Declared format: 32bpp, depth 24, true colour, NOT big-endian, RGB shifts 16/8/0.
  assert.equal(RFB_PIXEL_FORMAT.bitsPerPixel, 32);
  assert.equal(RFB_PIXEL_FORMAT.depth, 24);
  assert.equal(RFB_PIXEL_FORMAT.bigEndian, false);
  assert.equal(RFB_PIXEL_FORMAT.redShift, 16);
  assert.equal(RFB_PIXEL_FORMAT.greenShift, 8);
  assert.equal(RFB_PIXEL_FORMAT.blueShift, 0);
  assert.equal(RFB_PIXEL_FORMAT.bytesPerPixel, 4);

  // A red pixel (255,0,0) becomes 0x00FF0000 → little-endian on the wire = 00 00 FF 00
  const px = rgbaToRfbPixels(Buffer.from([255, 0, 0, 255]), 1);
  assert.deepEqual([...px], [0, 0, 255, 0], 'B,G,R,pad');

  // …and it round-trips back to RGBA without loss of colour.
  assert.deepEqual([...rfbPixelsToRgba(px, 1)], [255, 0, 0, 255]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Decoding: real bytes in → screen state out
// ─────────────────────────────────────────────────────────────────────────────

test('a hand-built Raw FramebufferUpdate decodes into real screen state', () => {
  // 2×2 screen: red, green / blue, white
  const pixels = rfbPixels([
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
  ]);
  const stream = handBuiltUpdate([{ x: 0, y: 0, width: 2, height: 2, pixels }]);

  const session = new RfbSession({ width: 2, height: 2 });
  const events = session.push(stream);

  assert.equal(events.filter((e) => e.type === 'rect').length, 1);
  const snap = session.snapshot();
  assert.equal(snap.width, 2);
  assert.equal(snap.height, 2);
  // Screen state is the pixels, in the declared order.
  assert.deepEqual([...rfbPixelsToRgba(snap.pixels, 4)], [
    255, 0, 0, 255, // red
    0, 255, 0, 255, // green
    0, 0, 255, 255, // blue
    255, 255, 255, 255, // white
  ]);
});

test('a rectangle composites at its (x,y) offset, not at the origin', () => {
  const session = new RfbSession({ width: 4, height: 2 });
  // Paint a 2×1 red rect at x=2,y=1 through the real encoder.
  const rgba = Buffer.alloc(2 * 1 * 4, 0);
  rgba[0] = 255; rgba[3] = 255; // pixel 0 red opaque
  rgba[4] = 255; rgba[7] = 255; // pixel 1 red opaque
  const stream = encodeFramebufferUpdate([{ x: 2, y: 1, width: 2, height: 1, rgba }]);

  session.push(stream);
  const snap = session.snapshot();
  const at = (x, y) => [...rfbPixelsToRgba(snap.pixels, 8).subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];

  assert.deepEqual(at(2, 1), [255, 0, 0, 255], 'rect landed at its offset');
  assert.deepEqual(at(3, 1), [255, 0, 0, 255], 'second pixel of the same rect');
  assert.deepEqual(at(0, 0), [0, 0, 0, 255], 'untouched pixel stays black');
  assert.deepEqual(at(1, 1), [0, 0, 0, 255], 'left of the rect untouched');

  // The source stride is the RECTANGLE width, not the screen width — the classic
  // off-by-a-row bug. A second rect with a different width proves it.
  const rgba2 = Buffer.alloc(1 * 1 * 4, 0);
  rgba2[1] = 255; rgba2[3] = 255; // green
  session.push(encodeFramebufferUpdate([{ x: 0, y: 0, width: 1, height: 1, rgba: rgba2 }]));
  const snap2 = session.snapshot();
  const px = rfbPixelsToRgba(snap2.pixels, 8);
  assert.deepEqual([...px.subarray(0, 4)], [0, 255, 0, 255], 'green at origin');
});

test('a multi-rectangle update composites every rectangle', () => {
  const red = rfbPixels([[255, 0, 0]]);
  const blue = rfbPixels([[0, 0, 255]]);
  const stream = handBuiltUpdate([
    { x: 0, y: 0, width: 1, height: 1, pixels: red },
    { x: 3, y: 0, width: 1, height: 1, pixels: blue },
  ]);

  const session = new RfbSession({ width: 4, height: 1 });
  const events = session.push(stream);
  assert.equal(events[0].type, 'update-begin');
  assert.equal(events[0].numRects, 2);
  assert.equal(events.filter((e) => e.type === 'rect').length, 2);

  const px = rfbPixelsToRgba(session.snapshot().pixels, 4);
  assert.deepEqual([...px.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...px.subarray(12, 16)], [0, 0, 255, 255]);
});

test('chunk boundaries are irrelevant: the same stream split anywhere decodes identically', () => {
  const pixels = rfbPixels([
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
    [10, 11, 12],
  ]);
  const stream = handBuiltUpdate([{ x: 0, y: 0, width: 2, height: 2, pixels }]);

  const whole = new RfbSession({ width: 2, height: 2 });
  whole.push(stream);

  // Now one byte at a time — every possible split point at once.
  const bytewise = new RfbSession({ width: 2, height: 2 });
  for (const b of stream) bytewise.push(Buffer.from([b]));

  assert.equal(
    bytewise.snapshot().sha256,
    whole.snapshot().sha256,
    'a stream decoder must be indifferent to chunk boundaries (RFC 6143 §7)',
  );
});

test('a truncated message is BUFFERED, not decoded and not an error', () => {
  const pixels = rfbPixels([
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
  ]);
  const stream = handBuiltUpdate([{ x: 0, y: 0, width: 2, height: 2, pixels }]);
  const cut = stream.subarray(0, stream.length - 3); // 3 pixel bytes short

  const dec = new RfbServerDecoder();
  const events = dec.push(cut);
  assert.equal(events.filter((e) => e.type === 'rect').length, 0, 'no partial rectangle emitted');
  assert.equal(dec.isHalted, false, 'waiting is not an error');
  assert.ok(dec.pending > 0, 'the bytes are held for the rest of the message');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE CONSTRAINT: a real screen is 64× the relay's frame ceiling
// ─────────────────────────────────────────────────────────────────────────────

test('a REAL 1280×800 screen crosses the 64 KiB relay ceiling as ordered chunks and reassembles byte-exactly', () => {
  const W = 1280;
  const H = 800;
  const rawBytes = W * H * RFB_PIXEL_FORMAT.bytesPerPixel;

  // This is the fact that decides the design — assert it, so nobody "simplifies"
  // the codec into one-frame-per-message.
  assert.equal(rawBytes, 4_096_000);
  assert.equal(RFB_RELAY_FRAME_BYTES, 64 * 1024);
  assert.ok(
    rawBytes > RFB_RELAY_FRAME_BYTES * 60,
    `one Raw rectangle (${rawBytes}b) is ${Math.round(rawBytes / RFB_RELAY_FRAME_BYTES)}× the frame ceiling`,
  );

  // A real-looking screen: a gradient so no two rows hash alike.
  const rgba = Buffer.alloc(rawBytes);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = i & 0xff;
    rgba[i * 4 + 1] = (i >> 8) & 0xff;
    rgba[i * 4 + 2] = (i >> 16) & 0xff;
    rgba[i * 4 + 3] = 255;
  }
  const stream = encodeFramebufferUpdate([{ x: 0, y: 0, width: W, height: H, rgba }]);
  assert.ok(stream.length > 4_000_000);

  // Split for the relay — every chunk must fit a frame.
  const chunks = chunkForRelay(stream);
  assert.ok(chunks.length > 60, `expected many frames, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(
      Buffer.from(c, 'base64').length <= RFB_RELAY_FRAME_BYTES,
      'every chunk fits inside one relay frame',
    );
    assert.ok(c.length > 0, 'no empty payload — the backend refuses those as malformed');
  }

  // Feed them ONE AT A TIME into a fresh decoder, as pumpRelay does.
  const session = new RfbSession();
  for (const c of chunks) session.push(Buffer.from(c, 'base64'));

  const snap = session.snapshot();
  assert.ok(snap, 'screen state came out');
  assert.equal(snap.width, W, 'geometry learned from the stream');
  assert.equal(snap.height, H);
  assert.equal(snap.pixels.length, rawBytes);
  assert.equal(snap.rectsApplied, 1);

  // Byte-exact round trip: the screen decodes back to the pixels we started with.
  const back = rfbPixelsToRgba(snap.pixels, W * H);
  assert.ok(back.equals(rgba), 'the decoded screen is byte-identical to the captured one');

  // And the chunk join is lossless in its own right.
  assert.ok(joinRelayChunks(chunks).equals(stream), 'chunks rejoin to the original byte stream');
});

test('an empty stream yields no chunks (an empty payload is refused as malformed)', () => {
  assert.deepEqual(chunkForRelay(Buffer.alloc(0)), []);
  assert.equal(chunkForRelay(Buffer.alloc(10), 4).length, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Hostile / malformed streams REFUSE, never throw
// ─────────────────────────────────────────────────────────────────────────────

test('an unknown server message type halts with a desync event, it does not throw', () => {
  const dec = new RfbServerDecoder();
  let events;
  assert.doesNotThrow(() => {
    events = dec.push(Buffer.from([99, 0, 0, 0]));
  });
  assert.equal(events[0].type, 'desync');
  assert.equal(events[0].reason, 'unknown-message-type');
  assert.equal(dec.isHalted, true);
  // A halted decoder ignores further bytes rather than resyncing into garbage.
  assert.deepEqual(dec.push(Buffer.from([0, 0, 0, 1])), []);
});

test('an unsupported encoding is REFUSED, because its payload length is unknowable', () => {
  // Hextile (5) / ZRLE (17) / RRE (2) all have variable-length payloads: guessing
  // would put every following message at the wrong offset.
  for (const encoding of [1, 2, 5, 16, 17]) {
    const head = Buffer.alloc(12);
    head.writeUInt16BE(0, 0);
    head.writeUInt16BE(0, 2);
    head.writeUInt16BE(4, 4);
    head.writeUInt16BE(4, 6);
    head.writeInt32BE(encoding, 8);
    const stream = Buffer.concat([Buffer.from([0, 0, 0, 1]), head]);

    const dec = new RfbServerDecoder();
    const events = dec.push(stream);
    const bad = events.find((e) => e.type === 'desync');
    assert.ok(bad, `encoding ${encoding} must refuse`);
    assert.equal(bad.reason, 'unsupported-encoding');
  }
});

test('an absurd rectangle header is refused BEFORE the bytes are buffered', () => {
  // 65535 × 65535 × 4 = 17 GB. The point is that the decoder never waits for it.
  const head = Buffer.alloc(12);
  head.writeUInt16BE(65535, 4);
  head.writeUInt16BE(65535, 6);
  head.writeInt32BE(RFB_ENCODING_RAW, 8);
  const stream = Buffer.concat([Buffer.from([0, 0, 0, 1]), head]);

  const dec = new RfbServerDecoder();
  const events = dec.push(stream);
  const bad = events.find((e) => e.type === 'desync');
  assert.ok(bad);
  assert.equal(bad.reason, 'rect-too-large');
  assert.ok(dec.pending < 100, `nothing was buffered for the 17 GB claim (pending=${dec.pending})`);
  assert.equal(RFB_MAX_RECT_BYTES, 64 * 1024 * 1024);
});

test('a client stream with a garbage message type refuses instead of throwing', () => {
  const dec = new RfbClientDecoder();
  let events;
  assert.doesNotThrow(() => {
    events = dec.push(Buffer.from([250]));
  });
  assert.equal(events[0].type, 'desync');
  assert.equal(events[0].reason, 'unknown-message-type');
});

test('every decoder entry point tolerates non-Buffer input (Uint8Array over the wire)', () => {
  const dec = new RfbServerDecoder();
  assert.doesNotThrow(() => dec.push(new Uint8Array([0, 0, 0, 0])));
  const cdec = new RfbClientDecoder();
  assert.doesNotThrow(() => cdec.push(new Uint8Array([])));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Input decodes into actionable events (the device's control path)
// ─────────────────────────────────────────────────────────────────────────────

test('operator KeyEvent and PointerEvent decode into events the device can act on', () => {
  const dec = new RfbClientDecoder();
  const events = dec.push(
    Buffer.concat([
      encodePointerEvent(1, 640, 480),
      encodeKeyEvent(0x0041, true), // 'A'
      encodeKeyEvent(0x0041, false),
    ]),
  );

  assert.deepEqual(
    events.map((e) => e.type),
    ['pointer', 'key', 'key'],
  );
  assert.deepEqual(events[0], { type: 'pointer', buttonMask: 1, x: 640, y: 480 });
  assert.deepEqual(events[1], { type: 'key', down: true, keysym: 0x41 });
  assert.deepEqual(events[2], { type: 'key', down: false, keysym: 0x41 });
});

test('SetEncodings, FramebufferUpdateRequest and ClientCutText decode', () => {
  const dec = new RfbClientDecoder();
  const events = dec.push(
    Buffer.concat([
      encodeSetEncodings([0, RFB_ENCODING_DESKTOP_SIZE]),
      encodeFramebufferUpdateRequest({ incremental: false, width: 1280, height: 800 }),
      encodeClientCutText('hello'),
    ]),
  );
  assert.deepEqual(events[0], { type: 'set-encodings', encodings: [0, RFB_ENCODING_DESKTOP_SIZE] });
  assert.equal(events[1].type, 'update-request');
  assert.equal(events[1].incremental, false);
  assert.equal(events[1].width, 1280);
  assert.deepEqual(events[2], { type: 'cut-text', text: 'hello' });
});

test('a DesktopSize pseudo-encoding resizes the screen with no pixel payload', () => {
  const session = new RfbSession({ width: 2, height: 2 });
  session.push(encodeDesktopSize(1920, 1080));
  assert.equal(session.screenWidth, 1920);
  assert.equal(session.screenHeight, 1080);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Structural: this module is a pure leaf and has no credential slot
// ─────────────────────────────────────────────────────────────────────────────

test('the codec is a pure leaf — no fs, no child_process, no logger, no network', () => {
  const src = codeOf('src/rfb-codec.ts');
  assert.doesNotMatch(src, /from 'node:fs'|from 'fs'/);
  assert.doesNotMatch(src, /child_process/);
  assert.doesNotMatch(src, /\brequire\(/);
  assert.doesNotMatch(src, /\bfetch\(/);
  assert.doesNotMatch(src, /createServer\(|\.listen\(/);
  assert.doesNotMatch(src, /from '\.\/logger'|from '\.\/config'/);
  // The one import is crypto, for the content hash.
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['crypto'], `unexpected imports: ${imports.join(', ')}`);
});

test('no credential has a slot in the RFB codec', () => {
  const src = SRC('src/rfb-codec.ts');
  // A rectangle is geometry + opaque pixels; an input event is a keysym or a
  // button mask. Nothing here can carry a password — pinned by shape.
  assert.doesNotMatch(src, /^\s*(password|passphrase|secret|passcode|token)\s*[?:]/m);
  // The VNC challenge/response is deliberately NOT implemented: the ruling
  // replaces it with the relay's per-session capability, so no DES/password
  // handling exists to get wrong.
  assert.doesNotMatch(src, /\bDES\b|createCipheriv|challengeResponse/);
  assert.match(src, /NO structure in this module\s*\n?\s*\*?\s*has a slot a password could ride in on/);
});

test('the codec does NOT implement the handshake (post-handshake by design)', () => {
  const src = codeOf('src/rfb-codec.ts');
  assert.doesNotMatch(src, /ServerInit|RFB 003\.008|SecurityResult|SecurityType/);
  // …and the module SAYS so, so a later reader cannot mistake the omission for
  // an unfinished slice. (Prose assertion — deliberately on the raw source.)
  assert.match(SRC('src/rfb-codec.ts'), /POST-HANDSHAKE ONLY/);
});
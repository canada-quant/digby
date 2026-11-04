/**
 * RELAY SESSION SEAM — the codec BOLTED to the pump (ticket c468f922).
 *
 * ── THE DEFECT THIS SUITE EXISTS TO CATCH ───────────────────────────────────
 * The relay's first cut shipped routes, gates, queues, a capability mint and 31
 * passing tests — and NOTHING that ever dialled them. Independent review caught
 * it; a relay whose only peer is a test suite carries nothing. `index.ts` now
 * has a pump, and the codec is a separate module, which means the SAME trap is
 * available one layer up: a fully-tested codec that `pumpRelay` never calls
 * carries exactly as little as no codec at all.
 *
 * So the first block below is a SOURCE assertion that the pump's own body
 * reaches the codec in both directions, and that the capture failure path does
 * not silently pretend to have sent a screen. A refactor that orphans the codec
 * fails HERE rather than in a field report.
 *
 * The rest is behaviour, on real RFC 6143 bytes: input decodes into executable
 * actions, a captured screen encodes → chunks under the 64 KiB relay ceiling →
 * decodes back to byte-identical screen state, and a real BMP parses to RGBA.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const SRC = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');

/** Strip comments: structural claims must measure CODE, not the prose around it. */
function codeOf(rel) {
  return SRC(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const mod = await import('../dist/relay-session.js');
const {
  RelayControlChannel,
  RelayScreenChannel,
  RelaySessionCodec,
  RelayViewer,
  planInputAction,
  keysymToText,
  keysymToKeyName,
  RELAY_KEYSYM_NAMES,
  parseBmpToRgba,
  captureScreenRgba,
  relayScreenFrames,
  relayScreenBytes,
  fitScreenToBudget,
  RELAY_SCREEN_FRAME_BUDGET,
} = mod;

const codec = await import('../dist/rfb-codec.js');
const { encodeKeyEvent, encodePointerEvent, RFB_RELAY_FRAME_BYTES } = codec;

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE SEAM IS WIRED — the D-A lesson, applied to the codec
// ─────────────────────────────────────────────────────────────────────────────

test('the RELAY PUMP actually calls the codec, in both directions', () => {
  const index = codeOf('src/index.ts');

  // (a) the codec is imported by the module that owns the pump
  assert.match(index, /from '\.\/relay-session'/, 'index.ts must import the relay codec');

  // (b) the drain direction: pumpRelay → applyRelayInput → control.ingest.
  //     Anchor on the declaration, and assert the anchor EXISTS before slicing —
  //     a silent indexOf(-1) would make this window empty and the test vacuous.
  const pumpAt = index.search(/async function pumpRelay\(/);
  assert.ok(pumpAt > 0, 'pumpRelay must exist in index.ts');
  const pump = index.slice(pumpAt);
  assert.match(pump, /await applyRelayInput\(relayCodec, frame\)/, 'the pump must feed drained frames to the codec');

  const applyAt = index.search(/async function applyRelayInput\(/);
  assert.ok(applyAt > 0, 'applyRelayInput must exist');
  const apply = index.slice(applyAt, applyAt + 6000);
  assert.match(apply, /codec\.control\.ingest\(frame\.payloadB64\)/, 'the seam must decode through the control channel');
  // …and it EXECUTES what it decoded, instead of decoding into a void.
  assert.match(apply, /await computer\.click\(/, 'a decoded pointer press must be executed');
  assert.match(apply, /await computer\.keyPress\(|await computer\.typeText\(/, 'a decoded key must be executed');

  // (c) the send direction: the pump pushes a screen through the codec.
  assert.match(pump, /await sendRelayScreen\(config,/, 'the pump must send a screen');
  const sendAt = index.search(/async function sendRelayScreen\(/);
  assert.ok(sendAt > 0, 'sendRelayScreen must exist');
  const send = index.slice(sendAt, sendAt + 6000);
  assert.match(send, /captureScreenRgba\(/, 'a real capture must drive the screen');
  // Match on the METHOD, not the receiver's name: the field is `relayCodec`, so
  // a `/codec\.screen/` pattern is case-sensitive against "relayCodec" and would
  // fail on correct code. (Caught by this suite's own first run.)
  assert.match(send, /\.screen\.sendScreen\(/, 'the captured screen must be encoded by the codec');
  // …and the codec's frames reach the RELAY OUTBOX, not a local array.
  assert.match(send, /queueRelayFrame\(payloadB64\)/, 'encoded frames must go out through queueRelayFrame');
});

test('a codec instance is reset at every session boundary', () => {
  const index = codeOf('src/index.ts');
  // The decoder buffers partial messages; carrying that state across sessions
  // would prepend a dead session's tail to a live stream.
  const resets = index.match(/relayCodec\.reset\(\)/g) ?? [];
  assert.ok(resets.length >= 2, `expected a reset on session open AND close, found ${resets.length}`);
  assert.match(index, /out\.data\.sessionId !== relayPump\.sessionId/, 'a NEW session must be detectable');
});

test('a capture that produces nothing says so instead of sending a blank screen', () => {
  const index = codeOf('src/index.ts');
  const sendAt = index.search(/async function sendRelayScreen\(/);
  const send = index.slice(sendAt, sendAt + 6000);
  // Refused capture → log + return, never a fabricated frame.
  assert.match(send, /if \(!shot\)/, 'a null capture must be handled explicitly');
  assert.match(send, /relayScreenRefused = true/, 'the refusal must be remembered (log once, not per tick)');
  assert.match(send, /Screen Recording refused/, 'the refusal must be named for the operator');
});

test('the pump still cannot throw into the poll loop', () => {
  const index = codeOf('src/index.ts');
  const pumpAt = index.search(/async function pumpRelay\(/);
  const pump = index.slice(pumpAt, index.search(/async function applyRelayInput\(/));
  // Every await that can reject is inside a try, and the catch is present.
  assert.match(pump, /try \{/);
  assert.match(pump, /catch \{/, 'pumpRelay must keep its catch — an exception here costs the command channel');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Control direction: carried input → executable actions
// ─────────────────────────────────────────────────────────────────────────────

test('carried KeyEvent and PointerEvent payloads decode into executable actions', () => {
  const ch = new RelayControlChannel();

  // The operator clicks at (100, 200) — button 1 down — then releases.
  const down = ch.ingest(encodePointerEvent(1, 100, 200).toString('base64'));
  assert.deepEqual(down, [{ kind: 'pointer', buttonMask: 1, x: 100, y: 200, pressed: true }]);

  const up = ch.ingest(encodePointerEvent(0, 100, 200).toString('base64'));
  assert.deepEqual(up, [{ kind: 'pointer', buttonMask: 0, x: 100, y: 200, pressed: false }]);

  // And a key press/release for Return.
  const keyDown = ch.ingest(encodeKeyEvent(0xff0d, true).toString('base64'));
  assert.deepEqual(keyDown, [{ kind: 'key', keysym: 0xff0d, down: true }]);
  const keyUp = ch.ingest(encodeKeyEvent(0xff0d, false).toString('base64'));
  assert.deepEqual(keyUp, [{ kind: 'key', keysym: 0xff0d, down: false }]);

  assert.equal(ch.actionsApplied, 4);
  assert.equal(ch.isHalted, false);
});

test('input that spans relay frames decodes across the boundary', () => {
  const ch = new RelayControlChannel();
  const whole = encodePointerEvent(1, 640, 480);
  // Split mid-message, exactly as a chunker would.
  assert.deepEqual(ch.ingest(whole.subarray(0, 3).toString('base64')), [], 'no action from a partial message');
  assert.deepEqual(ch.ingest(whole.subarray(3).toString('base64')), [
    { kind: 'pointer', buttonMask: 1, x: 640, y: 480, pressed: true },
  ]);
});

test('a malformed control payload halts the channel instead of throwing', () => {
  const ch = new RelayControlChannel();
  let actions;
  assert.doesNotThrow(() => {
    actions = ch.ingest(Buffer.from([200, 1, 2, 3]).toString('base64'));
  });
  assert.deepEqual(actions, []);
  assert.equal(ch.isHalted, true);
  assert.match(ch.haltReason, /unknown-message-type/);
  // A halted channel ignores further input rather than resyncing into garbage.
  assert.deepEqual(ch.ingest(encodeKeyEvent(0x41, true).toString('base64')), []);
});

test('an empty or non-base64 payload is ignored, not crashed on', () => {
  const ch = new RelayControlChannel();
  assert.deepEqual(ch.ingest(''), [], 'an empty payload is a no-op');

  // A garbage string must NEVER throw into the poll loop. Whether it decodes to
  // zero bytes (nothing happens) or to a few lenient bytes (the decoder desyncs)
  // is base64-implementation detail — what is pinned is that the caller survives.
  let threw = null;
  try {
    ch.ingest('!!!not base64!!!');
  } catch (e) {
    threw = e;
  }
  assert.equal(threw, null, 'a malformed payload must not raise into pumpRelay');
});

test('a payload that decodes to no usable bytes leaves the channel healthy', () => {
  // '====' decodes to zero bytes: nothing to decode, so nothing to desync on.
  const ch = new RelayControlChannel();
  assert.deepEqual(ch.ingest('===='), []);
  assert.equal(ch.isHalted, false);
});

test('a bare pointer MOVE does not execute as a click', () => {
  // mask 0 = movement only. Acting on it would fire a click per mouse pixel.
  const action = planInputAction({ type: 'pointer', buttonMask: 0, x: 5, y: 6 });
  assert.equal(action.pressed, false);
  // …and the executor's guard is that flag, asserted in the seam test above.
  assert.equal(planInputAction({ type: 'pointer', buttonMask: 4, x: 5, y: 6 }).pressed, true);
});

test('keysyms bridge to the agent’s own input vocabulary', () => {
  // Printable → text (what typeText takes)
  assert.equal(keysymToText(0x41), 'A');
  assert.equal(keysymToText(0x61), 'a');
  assert.equal(keysymToText(0x20), ' ');
  // Non-printable → a key NAME (what keyPress takes)
  assert.equal(keysymToKeyName(0xff0d), 'Return');
  assert.equal(keysymToKeyName(0xff1b), 'Escape');
  assert.equal(keysymToKeyName(0xff51), 'Left');
  assert.equal(keysymToKeyName(0xffbe), 'F1');
  // The RFC's own table is the source: spot-check three values verbatim.
  assert.equal(RELAY_KEYSYM_NAMES[0xff08], 'BackSpace');
  assert.equal(RELAY_KEYSYM_NAMES[0xffff], 'Delete');
  assert.equal(RELAY_KEYSYM_NAMES[0xff54], 'Down');
  // A keysym that is neither printable nor named maps to nothing — reported,
  // never guessed into the wrong character.
  assert.equal(keysymToText(0x01000041), null);
  assert.equal(keysymToKeyName(0x01000041), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Screen direction: capture → RFB → relay frames → decoded screen
// ─────────────────────────────────────────────────────────────────────────────

/** A recognisable test screen: a gradient plus a few solid blocks. */
function testScreen(w, h) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = (x * 7) & 0xff;
      rgba[i + 1] = (y * 11) & 0xff;
      rgba[i + 2] = (x + y) & 0xff;
      rgba[i + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}

test('a captured screen encodes → chunks under the relay ceiling → decodes to byte-identical screen state', () => {
  const screen = testScreen(320, 200);
  const sent = [];
  const ch = new RelayScreenChannel();

  const frames = ch.sendScreen(screen, (b64) => sent.push(b64));

  // Every frame fits a relay frame — the ceiling is what the pump will hit.
  assert.ok(frames >= 1);
  assert.equal(sent.length, frames);
  for (const b64 of sent) {
    assert.ok(Buffer.from(b64, 'base64').length <= RFB_RELAY_FRAME_BYTES, 'a frame must fit the relay ceiling');
  }

  // The OPERATOR side reassembles and decodes — same class the backend e2e uses.
  const viewer = new RelayViewer();
  for (const b64 of sent) viewer.ingest(b64);

  assert.equal(viewer.width, 320);
  assert.equal(viewer.height, 200);
  const snap = viewer.snapshot();
  assert.ok(snap, 'the operator decoded a screen');
  assert.equal(snap.rectsApplied, 1);

  // THE PROOF: the screen the device captured is the screen the operator sees.
  assert.ok(viewer.rgba().equals(screen.rgba), 'decoded screen is byte-identical to the captured one');
});

test('a screen LARGER than one relay frame still arrives whole (the 4 MB case)', () => {
  // 1280×800 Raw = 4 096 000 bytes = 64× the frame ceiling.
  const screen = testScreen(1280, 800);
  const sent = [];
  new RelayScreenChannel().sendScreen(screen, (b64) => sent.push(b64));

  assert.ok(sent.length > 60, `expected many frames, got ${sent.length}`);
  for (const b64 of sent) {
    assert.ok(Buffer.from(b64, 'base64').length <= RFB_RELAY_FRAME_BYTES);
  }

  const viewer = new RelayViewer();
  for (const b64 of sent) viewer.ingest(b64);
  assert.equal(viewer.width, 1280);
  assert.equal(viewer.height, 800);
  assert.ok(viewer.rgba().equals(screen.rgba), 'a full-screen update survives the chunking');
});

test('a geometry change is announced to the operator first, so nothing is clipped', () => {
  const ch = new RelayScreenChannel();
  const sent = [];
  ch.sendScreen(testScreen(200, 100), (b) => sent.push(b));
  const first = sent.length;

  sent.length = 0;
  ch.sendScreen(testScreen(400, 300), (b) => sent.push(b));

  const viewer = new RelayViewer();
  for (const b of sent) viewer.ingest(b);
  assert.equal(viewer.width, 400, 'the operator learned the new geometry');
  assert.equal(viewer.height, 300);
  assert.ok(first > 0);
});

test('the same geometry sent twice sends no redundant DesktopSize', () => {
  const ch = new RelayScreenChannel();
  const a = [];
  ch.sendScreen(testScreen(64, 64), (b) => a.push(b));
  assert.ok(a.length >= 1, 'the first screen produced frames');

  // The FIRST exchange announces the geometry: a DesktopSize message and the Raw
  // update are SEPARATE FramebufferUpdate messages (each with numRects=1), so the
  // whole first capture concatenates to one stream containing encoding -223.
  const firstStream = Buffer.concat(a.map((x) => Buffer.from(x, 'base64')));
  assert.equal(firstStream[0], 0, 'a FramebufferUpdate');
  assert.ok(
    firstStream.includes(Buffer.from([0xff, 0xff, 0xff, 0x21])),
    'the first capture announces DesktopSize (-223 == 0xFFFFFF21)',
  );

  // Change-gating: an IDENTICAL screen sends nothing at all now, so to test
  // the DesktopSize suppression we need a screen that actually changed.
  const changed = testScreen(64, 64);
  changed.rgba[0] = (changed.rgba[0] + 7) & 0xff;
  const b = [];
  ch.sendScreen(changed, (x) => b.push(x));
  const secondStream = Buffer.concat(b.map((x) => Buffer.from(x, 'base64')));
  assert.ok(
    !secondStream.includes(Buffer.from([0xff, 0xff, 0xff, 0x21])),
    'an unchanged geometry must NOT re-announce DesktopSize',
  );
  assert.equal(secondStream[0], 0, 'still a FramebufferUpdate');

  // Both still decode to the same geometry.
  const viewer = new RelayViewer();
  for (const x of [...a, ...b]) viewer.ingest(x);
  assert.equal(viewer.width, 64);
  assert.equal(viewer.height, 64);
});

test('an empty or impossible screen sends nothing at all', () => {
  const ch = new RelayScreenChannel();
  const sent = [];
  assert.equal(ch.sendScreen({ width: 0, height: 0, rgba: Buffer.alloc(0) }, (b) => sent.push(b)), 0);
  // A buffer too small for the claimed geometry is refused, not padded.
  assert.equal(ch.sendScreen({ width: 10, height: 10, rgba: Buffer.alloc(8) }, (b) => sent.push(b)), 0);
  assert.deepEqual(sent, []);
});

test('session codec resets both halves at a boundary', () => {
  const c = new RelaySessionCodec();
  const sent = [];
  c.screen.sendScreen(testScreen(32, 32), (b) => sent.push(b));
  assert.equal(c.screen.stats.screens, 1);

  c.reset();
  assert.equal(c.screen.stats.screens, 0, 'the screen channel starts clean');
  assert.equal(c.control.actionsApplied, 0);
  assert.equal(c.control.isHalted, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Real BMP capture decode (macOS `screencapture -t bmp`)
// ─────────────────────────────────────────────────────────────────────────────

/** Build a real BMP fixture. `topDown` exercises the negative-height form. */
function buildBmp(w, h, opts = {}) {
  const bitCount = opts.bitCount ?? 24;
  const topDown = opts.topDown ?? false;
  const bpp = bitCount / 8;
  const stride = Math.floor((bitCount * w + 31) / 32) * 4;
  const pixelOffset = 54;
  const size = pixelOffset + stride * h;
  const buf = Buffer.alloc(size);

  buf.write('BM', 0);
  buf.writeUInt32LE(size, 2);
  buf.writeUInt32LE(pixelOffset, 10);
  buf.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(topDown ? -h : h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(bitCount, 28);
  buf.writeUInt32LE(0, 30); // BI_RGB

  for (let row = 0; row < h; row++) {
    const srcRow = topDown ? row : h - 1 - row;
    for (let col = 0; col < w; col++) {
      const o = pixelOffset + srcRow * stride + col * bpp;
      buf[o] = (col * 3) & 0xff; // B
      buf[o + 1] = (row * 5) & 0xff; // G
      buf[o + 2] = (col + row) & 0xff; // R
      if (bpp === 4) buf[o + 3] = 255;
    }
  }
  return buf;
}

test('a real 24-bit bottom-up BMP decodes to correct RGBA', () => {
  const bmp = buildBmp(4, 3, { bitCount: 24 });
  const shot = parseBmpToRgba(bmp);
  assert.ok(shot);
  assert.equal(shot.width, 4);
  assert.equal(shot.height, 3);
  assert.equal(shot.rgba.length, 4 * 3 * 4);

  // Row 0 of the SCREEN is the LAST stored row in a bottom-up BMP — the classic
  // upside-down bug, asserted at a corner.
  const px = (x, y) => [...shot.rgba.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
  // Screen (0,0): B=(0*3)=0, G=(0*5)=0, R=(0+0)=0, A=255
  assert.deepEqual(px(0, 0), [0, 0, 0, 255]);
  // Screen (3,2): B=9, G=10, R=5, A=255 → RGBA order
  assert.deepEqual(px(3, 2), [5, 10, 9, 255]);
});

test('a real 32-bit top-down BMP decodes to the same orientation', () => {
  const bmp = buildBmp(4, 3, { bitCount: 32, topDown: true });
  const shot = parseBmpToRgba(bmp);
  assert.ok(shot);
  assert.equal(shot.width, 4);
  assert.equal(shot.height, 3);
  const px = (x, y) => [...shot.rgba.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
  assert.deepEqual(px(0, 0), [0, 0, 0, 255]);
  assert.deepEqual(px(3, 2), [5, 10, 9, 255]);
});

test('an undecodable image is REFUSED, never guessed at', () => {
  assert.equal(parseBmpToRgba(Buffer.alloc(0)), null);
  assert.equal(parseBmpToRgba(Buffer.alloc(100)), null); // no 'BM'
  // Compressed / indexed / odd depths are refused rather than half-decoded.
  const compressed = buildBmp(2, 2, { bitCount: 24 });
  compressed.writeUInt32LE(1, 30); // BI_RLE8
  assert.equal(parseBmpToRgba(compressed), null);

  const indexed = buildBmp(2, 2, { bitCount: 8 });
  assert.equal(parseBmpToRgba(indexed), null);

  // A truncated file is refused too (a partial frame must not render).
  const truncated = buildBmp(8, 8, { bitCount: 24 }).subarray(0, 60);
  assert.equal(parseBmpToRgba(truncated), null);
});

test('captureScreenRgba runs the real command shape and cleans up after itself', async () => {
  const bmp = buildBmp(2, 2, { bitCount: 32 });
  const calls = [];
  const cleaned = [];
  const path = '/tmp/digby-relay-test/screen.bmp';

  const shot = await captureScreenRgba({
    run: async (args) => {
      calls.push(args);
    },
    readFile: () => bmp,
    tmpPath: () => path,
    cleanup: (p) => cleaned.push(p),
  });

  assert.ok(shot, 'the capture decoded');
  assert.equal(shot.width, 2);
  assert.deepEqual(calls[0].slice(0, 2), ['-t', 'bmp'], 'uncompressed BMP, not PNG');
  assert.ok(calls[0].includes('-x'), 'silent capture (no shutter sound on a remote session)');
  assert.deepEqual(cleaned, [path], 'the temp file is removed even on success');
});

test('a failing capture yields null and still cleans up (no leaked temp files)', async () => {
  const cleaned = [];
  const shot = await captureScreenRgba({
    run: async () => {
      throw new Error('denied');
    },
    readFile: () => {
      throw new Error('should not read');
    },
    tmpPath: () => '/tmp/x/screen.bmp',
    cleanup: (p) => cleaned.push(p),
  });
  assert.equal(shot, null, 'a refused capture is null, not a blank screen');
  assert.deepEqual(cleaned, ['/tmp/x/screen.bmp']);
});
// ─────────────────────────────────────────────────────────────────────────────
// 5. AUDIT F1 (2026-11-02) — the frame BUDGET, at real Mac resolutions
// ─────────────────────────────────────────────────────────────────────────────

test('F1: a REAL Retina/4K/5K screen is downscaled to fit the relay frame cap', () => {
  // The first cut encoded at native size. The real numbers, from the wire size
  // 16+4+12+w*h*4 over a 64 KiB frame:
  //   2880x1800 -> 317 frames, 3456x2234 -> 472, 3840x2160 -> 507, 5120x2880 -> 901
  // all past RELAY_QUEUE_MAX_FRAMES = 256, so on EVERY Retina Mac the stream
  // would be refused/truncated and the operator would see a third of a screen
  // and then nothing. The unit tests missed it because 1080p happens to fit.
  const MAXQ = 256;
  const cases = [
    [1280, 800, 63],
    [1920, 1080, 127],
    [2880, 1800, 317],
    [3024, 1964, 363],
    [3456, 2234, 472],
    [3840, 2160, 507],
    [5120, 2880, 901],
  ];
  for (const [w, h, expected] of cases) {
    // The formula is the contract: assert it, so a future "simplification" that
    // assumes one frame per screen fails here.
    assert.equal(relayScreenFrames(w, h), expected, `${w}x${h} frame count`);
  }

  for (const [w, h] of cases) {
    const screen = testScreen(w, h);
    const sent = [];
    const ch = new RelayScreenChannel();
    ch.sendScreen(screen, (b) => sent.push(b));

    // THE FIX: never more frames than the budget, whatever the display size.
    assert.ok(
      sent.length <= RELAY_SCREEN_FRAME_BUDGET,
      `${w}x${h} produced ${sent.length} frames, over the ${RELAY_SCREEN_FRAME_BUDGET} budget`,
    );
    // …and safely under the queue cap that would refuse the writer.
    assert.ok(sent.length < MAXQ, `${w}x${h} must stay under the relay queue cap`);
    for (const b of sent) {
      assert.ok(Buffer.from(b, 'base64').length <= RFB_RELAY_FRAME_BYTES);
    }

    // The operator still receives a WHOLE screen — just a smaller one.
    const viewer = new RelayViewer();
    for (const b of sent) viewer.ingest(b);
    assert.ok(viewer.width > 0 && viewer.height > 0, `${w}x${h} decoded`);
    assert.ok(
      viewer.height / viewer.width <= h / w + 0.02,
      'aspect ratio preserved (a per-axis fit would break click mapping)',
    );
    assert.equal(viewer.isHalted, false);
  }
});

test('F1: a screen that already fits is passed through UNCHANGED (no quality loss)', () => {
  // Identity, not just equality: the common small-screen case must not pay a
  // resample, and the e2e byte-identical round trips depend on it.
  const screen = testScreen(800, 600);
  assert.strictEqual(fitScreenToBudget(screen), screen);

  const sent = [];
  new RelayScreenChannel().sendScreen(screen, (b) => sent.push(b));
  const viewer = new RelayViewer();
  for (const b of sent) viewer.ingest(b);
  assert.ok(viewer.rgba().equals(screen.rgba), 'an in-budget screen is byte-identical end to end');
});

test('F1: an UNCHANGED screen sends NOTHING on the next tick', () => {
  // The pump ticks every ~25 s. The first cut re-captured, re-encoded and
  // re-pushed identical pixels every tick (~16 MB/min at 1280x800, ~30 MB x 4
  // at 4K). Change-gating is what makes a steady-state session cheap.
  const ch = new RelayScreenChannel();
  const screen = testScreen(320, 200);

  const first = [];
  ch.sendScreen(screen, (b) => first.push(b));
  assert.ok(first.length > 0, 'the first frame is sent');

  const second = [];
  assert.equal(ch.sendScreen(screen, (b) => second.push(b)), 0, 'an identical screen sends nothing');
  assert.deepEqual(second, []);

  // A real change DOES go out.
  const changed = testScreen(320, 200);
  changed.rgba[0] = (changed.rgba[0] + 1) & 0xff;
  const third = [];
  assert.ok(ch.sendScreen(changed, (b) => third.push(b)) > 0, 'changed pixels are sent');

  // `force` is the reconnect path: the operator has nothing yet.
  const forced = [];
  assert.ok(ch.sendScreen(changed, (b) => forced.push(b), { force: true }) > 0, 'force re-sends');
});

test('F1: the pump FORCES the first frame of each session and only the first', () => {
  const index = codeOf('src/index.ts');
  const pumpAt = index.search(/async function pumpRelay\(/);
  const pump = index.slice(pumpAt);
  assert.match(pump, /sendRelayScreen\(config, !relayScreenFirstSent\)/, 'first frame must bypass the gate');
  assert.match(pump, /relayScreenFirstSent = false/, 'a new session must re-arm the force');
  assert.match(pump, /relayScreenFirstSent = true/, 'later ticks must respect the gate');
});

test('F1: the budget constant is safely under the backend queue cap it mirrors', () => {
  // RELAY_QUEUE_MAX_FRAMES = 256 on the backend; the agent cannot import it.
  // Leaving headroom covers the DesktopSize announcement and drain lag.
  assert.ok(RELAY_SCREEN_FRAME_BUDGET < 256, 'budget must stay under the queue cap');
  assert.ok(RELAY_SCREEN_FRAME_BUDGET > 100, 'but not so small that 1080p is needlessly shrunk');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. AUDIT F2 (2026-11-02) — relay clicks must actually LAND
// ─────────────────────────────────────────────────────────────────────────────

test('F2: the relay path primes click geometry instead of being refused', () => {
  // toPoints() refuses every click until lastShot is set, and lastShot was set
  // ONLY by computer.screenshot(). The relay captures through its own
  // screencapture path, so every decoded operator click hit the guard, returned
  // {ok:false}, and was swallowed by the pump's catch: it decoded and vanished.
  const index = codeOf('src/index.ts');
  const sendAt = index.search(/async function sendRelayScreen\(/);
  const send = index.slice(sendAt, sendAt + 7000);
  assert.match(send, /computer\.primeScreenGeometry\(/, 'the relay capture must prime geometry');
  // …with the FITTED dimensions, not the native capture: the operator's
  // coordinates are in the frame they were sent.
  assert.match(send, /primeScreenGeometry\(g\.width, g\.height\)/, 'prime with the encoded frame size');

  const cmp = codeOf('src/computer.ts');
  assert.match(cmp, /export async function primeScreenGeometry\(/, 'the priming seam must exist');
  // It must USE the same reconciliation as screenshot() — not bypass the guard.
  const primeAt = cmp.search(/export async function primeScreenGeometry\(/);
  const prime = cmp.slice(primeAt, primeAt + 1800);
  assert.match(prime, /pickScreenSize\(/, 'reconcile through the real geometry check');
  assert.match(prime, /lastShot = \{/, 'and prime the same cache toPoints reads');
  assert.match(prime, /imageWidth,\s*\n\s*imageHeight,/, 'image dims are the operator frame space');
  // A geometry it cannot reconcile must REFUSE, not guess.
  assert.match(prime, /ok: false[\s\S]{0,80}picked\.mismatch/, 'unreconcilable geometry must refuse');
});

test('F2: an unusable geometry is reported, never silently swallowed', () => {
  const index = codeOf('src/index.ts');
  const sendAt = index.search(/async function sendRelayScreen\(/);
  const send = index.slice(sendAt, sendAt + 7000);
  assert.match(send, /geometry refused/, 'a refused prime must be named in the log');
});

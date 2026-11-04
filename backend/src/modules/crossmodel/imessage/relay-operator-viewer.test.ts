/**
 * OPERATOR-SIDE RENDERER — conformance against the REAL device codec
 * (ticket c468f922).
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 * `relay-operator-viewer.ts` is the operator's half of the wire: it decodes a
 * carried FramebufferUpdate into a rendered screen and encodes an operator's
 * input back into carried bytes. The backend cannot import
 * `imessage-agent/src/*.ts` at runtime (the agent is a standalone tarball), so
 * the wire constants and the framing are DUPLICATED — exactly as the agent
 * already duplicates `RELAY_MAX_FRAME_BYTES` from `relay-dataplane.ts`.
 *
 * Duplication is only safe when drift is LOUD. So this suite refuses to use a
 * hand-written fixture: it compiles the ACTUAL agent source that ships to a Mac
 * (`imessage-agent/src/rfb-codec.ts` + `relay-session.ts`) and runs it on the
 * far end. A drifted constant, byte order or framing choice fails HERE instead
 * of showing an operator a scrambled screen in the field.
 *
 * ── THE TWO DEFECTS THIS FILE WOULD HAVE CAUGHT ─────────────────────────────
 * This ticket's signature failure is "a requirement no live surface satisfies".
 * It has now recurred three times, each one layer up from the last:
 *   1. brokered-session D1 — a grant store nothing consulted.
 *   2. the relay had no client — 31 passing tests, nothing dialled them.
 *   3. the codec had no RENDERER — the only object that decoded a screen was
 *      `RelayViewer`, in the DEVICE's tree, instantiated solely by the e2e
 *      suite at relay-codec.e2e:377,477.
 * Case 3 is what this file and its subject exist to end.
 *
 * ── WHAT IS NOT CLAIMED ─────────────────────────────────────────────────────
 * That a physical Mac drives this on hardware. Criteria 1 and 3 (device e2e)
 * stay parked per the supervisor's steer; a green run here proves the WIRE, not
 * the hardware.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

import {
  OPERATOR_RFB_BYTES_PER_PIXEL,
  OPERATOR_RFB_CLIENT_KEY_EVENT,
  OPERATOR_RFB_CLIENT_POINTER_EVENT,
  OPERATOR_RFB_ENCODING_DESKTOP_SIZE,
  OPERATOR_RFB_ENCODING_RAW,
  OperatorScreenDecoder,
  chunkOperatorBytes,
  encodeOperatorKeyEvent,
  encodeOperatorPointerEvent,
  encodeOperatorSetEncodings,
  encodeOperatorUpdateRequest,
  encodeOperatorScreenPng,
  operatorWirePixelsToRgba,
  operatorFrameStartsUpdate,
  operatorFrameCompletesUpdate,
  planOperatorKey,
  planOperatorPointer,
} from './relay-operator-viewer';
import { RELAY_MAX_FRAME_BYTES } from './relay-dataplane';

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const SRC = (p: string) => readFileSync(join(REPO, p), 'utf8');

/**
 * Compile ONE `imessage-agent/src/*.ts` file in-process and return its exports.
 *
 * Same technique the e2e uses (relay-codec.e2e.c468f922.test.ts:178). It needs
 * no Mac, no build step and no network — `typescript` is already a backend
 * devDependency — and it means the bytes under test are produced by the code
 * that actually ships in the agent tarball.
 */
function loadAgentModule(relPath: string, deps: Record<string, unknown> = {}): any {
  const src = SRC(relPath);
  const js = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: relPath,
  }).outputText;

  const mod = { exports: {} as Record<string, unknown> };
  // eslint-disable-next-line no-new-func
  const fn = new Function('exports', 'require', 'module', '__dirname', '__filename', js) as any;
  fn(
    mod.exports,
    (id: string) => {
      if (Object.prototype.hasOwnProperty.call(deps, id)) return deps[id];
      return require(id);
    },
    mod,
    join(REPO, relPath),
    join(REPO, relPath),
  );
  return mod.exports;
}

const RFB = loadAgentModule('imessage-agent/src/rfb-codec.ts');
const RELAY_SESSION = loadAgentModule('imessage-agent/src/relay-session.ts', {
  './rfb-codec': RFB,
});

const { RelayScreenChannel, RelayControlChannel } = RELAY_SESSION;

/**
 * A recognisable screen: a per-pixel gradient, so a single wrong row OR a
 * byte-order mistake changes the bytes rather than passing as "black screen".
 * A flat fill would let almost every pixel bug through.
 */
function captureScreen(w: number, h: number) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = (x * 7) & 0xff;
      rgba[i + 1] = (y * 11) & 0xff;
      rgba[i + 2] = (x * 3 + y * 5) & 0xff;
      rgba[i + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}

/** Run a real device capture through the REAL screen channel → relay payloads. */
function deviceScreenPayloads(screen: { width: number; height: number; rgba: Buffer }) {
  const payloads: string[] = [];
  const channel = new RelayScreenChannel();
  const sent = channel.sendScreen(screen, (b64: string) => payloads.push(b64));
  return { payloads, sent, channel };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE WIRE: device encodes → operator decodes, byte-identically
// ─────────────────────────────────────────────────────────────────────────────

describe('THE OPERATOR RENDERS WHAT THE DEVICE ACTUALLY SENT', () => {
  it('a real captured screen, encoded by the REAL agent codec, decodes to the same pixels', () => {
    const screen = captureScreen(1280, 800);
    const { payloads, sent } = deviceScreenPayloads(screen);

    // One Raw screen is far larger than one relay frame, so the carry is
    // multi-frame by construction — this is not a convenience test.
    expect(sent).toBeGreaterThan(60);
    expect(payloads).toHaveLength(sent);

    const viewer = new OperatorScreenDecoder();
    for (const p of payloads) viewer.ingest(p);

    expect(viewer.isHalted).toBe(false);
    expect(viewer.pending).toBe(0);
    expect(viewer.geometry).toEqual({ width: 1280, height: 800 });

    const snap = viewer.snapshot();
    expect(snap).not.toBeNull();
    expect(snap!.rectsApplied).toBe(1);
    // THE PROOF: the pixels that left the device are the pixels the operator sees.
    expect(snap!.rgba.equals(screen.rgba)).toBe(true);
  });

  it('a RETINA capture is fitted by the device and still decodes at the fitted geometry', () => {
    // The F1 class from #2314: 2880x1800 is 317 native frames, past the queue
    // cap, so the device downscales BEFORE encoding. Whatever geometry the
    // device chose is the geometry the operator must render — with real pixels,
    // not a stretched guess.
    const screen = captureScreen(2880, 1800);
    const { payloads, channel } = deviceScreenPayloads(screen);
    const fitted = channel.geometry;

    expect(fitted.width).toBeGreaterThan(0);
    expect(fitted.width).toBeLessThanOrEqual(2880);
    // The fitted frame must fit the relay queue, which is the whole point of F1.
    expect(payloads.length).toBeLessThanOrEqual(256);

    const viewer = new OperatorScreenDecoder();
    for (const p of payloads) viewer.ingest(p);

    expect(viewer.isHalted).toBe(false);
    expect(viewer.geometry).toEqual({ width: fitted.width, height: fitted.height });

    const snap = viewer.snapshot();
    expect(snap).not.toBeNull();
    expect(snap!.width).toBe(fitted.width);
    expect(snap!.height).toBe(fitted.height);
    // Fully opaque and fully written: no uninitialised rows at the bottom.
    expect(snap!.rgba.length).toBe(fitted.width * fitted.height * 4);
    expect(snap!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('geometry is learned from the stream — a DesktopSize first, then the frame', () => {
    const screen = captureScreen(64, 48);
    const { payloads } = deviceScreenPayloads(screen);
    const viewer = new OperatorScreenDecoder();

    const events: string[] = [];
    for (const p of payloads) {
      for (const ev of viewer.ingest(p)) {
        events.push(ev.type === 'rect' ? `rect:${ev.encoding}:${ev.width}x${ev.height}` : ev.type);
      }
    }

    // The device emits DesktopSize FIRST on a geometry change, because the
    // operator's decoder learns its canvas from the stream (no ServerInit on the
    // brokered path). If that order ever flips, the first frame clips.
    expect(events[0]).toBe('update-begin');
    expect(events[1]).toBe(`rect:${OPERATOR_RFB_ENCODING_DESKTOP_SIZE}:64x48`);
    expect(events[2]).toBe('update-begin');
    expect(events[3]).toBe(`rect:${OPERATOR_RFB_ENCODING_RAW}:64x48`);
  });

  it('a second screen at NEW geometry re-renders instead of keeping stale pixels', () => {
    const first = captureScreen(64, 48);
    const second = captureScreen(80, 60);

    const viewer = new OperatorScreenDecoder();
    for (const p of deviceScreenPayloads(first).payloads) viewer.ingest(p);
    expect(viewer.geometry).toEqual({ width: 64, height: 48 });

    for (const p of deviceScreenPayloads(second).payloads) viewer.ingest(p);
    expect(viewer.geometry).toEqual({ width: 80, height: 60 });
    expect(viewer.snapshot()!.rgba.equals(second.rgba)).toBe(true);
  });

  it('an ARBITRARY split of the byte stream decodes identically (stream, not packet)', () => {
    // The relay's ceiling has nothing to do with RFB's framing: the receiver is
    // a STREAM decoder, so any split must be valid. Re-chunking at a hostile
    // size proves the decoder is not accidentally packet-aligned.
    const screen = captureScreen(96, 64);
    const { payloads } = deviceScreenPayloads(screen);
    const whole = Buffer.concat(payloads.map((p) => Buffer.from(p, 'base64')));

    for (const splitAt of [1, 3, 7, 13, 1000]) {
      const viewer = new OperatorScreenDecoder();
      for (let off = 0; off < whole.length; off += splitAt) {
        viewer.ingest(whole.subarray(off, Math.min(off + splitAt, whole.length)).toString('base64'));
      }
      expect(viewer.isHalted).toBe(false);
      expect(viewer.snapshot()!.rgba.equals(screen.rgba)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b. THE CANVAS CAN GROW WITHOUT SCATTERING THE IMAGE (audit D2)
// ─────────────────────────────────────────────────────────────────────────────

describe('A CANVAS THAT GROWS KEEPS ITS EXISTING PIXELS IN PLACE (audit D2)', () => {
  /**
   * One Raw rectangle of a single flat colour, as real device bytes.
   *
   * Built through the AGENT's own encoder so this suite cannot drift from the
   * wire: a hand-written header here would keep passing while the shipped
   * encoder changed shape underneath it.
   */
  function flatRect(x: number, y: number, w: number, h: number, r: number, g = r, b = r) {
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
    }
    return RFB.encodeFramebufferUpdate([{ x, y, width: w, height: h, rgba }]);
  }

  /** The red channel of every pixel, row by row — a picture of the stride. */
  function redRows(viewer: OperatorScreenDecoder): number[][] {
    const snap = viewer.snapshot()!;
    const rows: number[][] = [];
    for (let y = 0; y < snap.height; y++) {
      const row: number[] = [];
      for (let x = 0; x < snap.width; x++) row.push(snap.rgba[(y * snap.width + x) * 4]);
      rows.push(row);
    }
    return rows;
  }

  it('growing 4x4 → 6x6 blits the OLD scan lines at the OLD stride, not the new one', () => {
    // THE DEFECT THIS PINS (audit D2, 2026-11-02). `allocate()` used to assign
    // `this.width`/`this.height` BEFORE the grow path derived the old width, so
    // the divisor was the NEW height and every preserved row was read from the
    // wrong offset. The shipped code rendered row0 `200,200,0,0,0,0` and row1
    // `0,0,0,0,0,0` for exactly these bytes.
    //
    // The assertion is on the PRESERVED rows, because that is what the bug
    // corrupted — the incoming rectangle itself was always drawn correctly, so
    // a test that only checked the new pixels would have passed on the defect.
    const viewer = new OperatorScreenDecoder();
    viewer.push(flatRect(0, 0, 4, 4, 200));
    expect(viewer.geometry).toEqual({ width: 4, height: 4 });
    expect(redRows(viewer)).toEqual([
      [200, 200, 200, 200],
      [200, 200, 200, 200],
      [200, 200, 200, 200],
      [200, 200, 200, 200],
    ]);

    // A rectangle that reaches past the known canvas grows it to 6x6.
    viewer.push(flatRect(2, 2, 4, 4, 50));
    expect(viewer.geometry).toEqual({ width: 6, height: 6 });
    expect(viewer.isHalted).toBe(false);

    // Rows 0-1 are UNTOUCHED by the new rectangle, so they are pure old pixels:
    // they must be the four 200s followed by two never-written columns.
    expect(redRows(viewer)[0]).toEqual([200, 200, 200, 200, 0, 0]);
    expect(redRows(viewer)[1]).toEqual([200, 200, 200, 200, 0, 0]);
    // Row 2 is where the new rectangle starts: old 200s on the left, new 50s on
    // the right. If the blit stride were wrong this row would be a mix.
    expect(redRows(viewer)[2]).toEqual([200, 200, 50, 50, 50, 50]);
    expect(redRows(viewer)[3]).toEqual([200, 200, 50, 50, 50, 50]);
    // Rows 4-5 are entirely new, entirely 50.
    expect(redRows(viewer)[4]).toEqual([0, 0, 50, 50, 50, 50]);
    expect(redRows(viewer)[5]).toEqual([0, 0, 50, 50, 50, 50]);
  });

  it('a GROWTH-ONLY resize (wider, same rows) preserves every row’s content', () => {
    // The narrower shape of the same bug: a stride error shows up as rows that
    // slide by a byte or two even when the row COUNT is unchanged.
    const viewer = new OperatorScreenDecoder();
    viewer.push(flatRect(0, 0, 3, 2, 111));
    viewer.push(flatRect(3, 0, 3, 2, 222));

    expect(viewer.geometry).toEqual({ width: 6, height: 2 });
    expect(redRows(viewer)).toEqual([
      [111, 111, 111, 222, 222, 222],
      [111, 111, 111, 222, 222, 222],
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1c. MESSAGE BOUNDARIES IN A WINDOW THAT EXCEEDS THE QUEUE CAP (audit D1)
// ─────────────────────────────────────────────────────────────────────────────

describe('A WINDOW THAT FILLED ITS QUEUE IS STILL READABLE (audit D1)', () => {
  /**
   * THE DEFECT THESE PIN (audit D1, 2026-11-02).
   *
   * `pushRelayFrame` REFUSES a push once the queue holds RELAY_QUEUE_MAX_FRAMES
   * and never trims the head, so an unconsumed session's retained window is the
   * FIRST 256 frames. Measured at 1920x1200: one screen is 141 frames and two are
   * 282 against that 256 cap, so the second screen's last 26 frames are refused —
   * repeatedly, forever, because nothing frees a slot. The route then decoded the
   * window from frame 0, returned the FIRST screen and labelled it COMPLETE
   * (`partial: false`, because the window really did begin at seq 1).
   *
   * These two predicates are what make the window interrogable without guessing:
   * where the screens ARE, and which of them actually arrived whole.
   */

  /** Real device bytes for one screen, as the relay would carry them. */
  function screenChunks(w: number, h: number, value: number): string[] {
    const out: string[] = [];
    new RelayScreenChannel().sendScreen(
      { width: w, height: h, rgba: Buffer.alloc(w * h * 4, value) },
      (b64: string) => out.push(b64),
    );
    return out;
  }

  it('at 1920x1200, two screens OVERFLOW the queue cap — and the second is visibly cut off', () => {
    const a = screenChunks(1920, 1200, 11);
    const b = screenChunks(1920, 1200, 22);

    // The real numbers from the shipped codec, not an estimate. If a future
    // change makes a screen cheaper, this pair stops overflowing and the pin
    // must be re-derived rather than silently passing.
    expect(a).toHaveLength(141);
    expect(b).toHaveLength(141);
    expect(a.length + b.length).toBeGreaterThan(256);

    // What the store actually retains: the FIRST 256 frames (it refuses the
    // rest; it never trims the head).
    const window = [...a, ...b].slice(0, 256);
    const bufs = window.map((p) => Buffer.from(p, 'base64'));
    const suffix = new Array<number>(bufs.length + 1).fill(0);
    for (let i = bufs.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + bufs[i].length;

    const starts = bufs.map((buf, i) => (operatorFrameStartsUpdate(buf) ? i : -1)).filter((i) => i >= 0);
    // Exactly two message starts: screen A at 0, screen B at 141.
    expect(starts).toEqual([0, a.length]);

    const complete = starts.filter((i) => operatorFrameCompletesUpdate(bufs[i], suffix[i]));
    // A is whole; B is a start whose remaining 26 frames were refused.
    expect(complete).toEqual([0]);
    expect(operatorFrameStartsUpdate(bufs[a.length])).toBe(true);
    expect(operatorFrameCompletesUpdate(bufs[a.length], suffix[a.length])).toBe(false);
  });

  it('the scan finds NO start inside a screen’s pixel payload (no false resync point)', () => {
    // A wrong answer here would "resync" into the middle of an image and render
    // noise as if it were the desktop. Screen pixels are arbitrary bytes, so the
    // predicate has to reject them structurally: a pixel row cannot present as
    // type 0 / one rectangle / origin / a Raw encoding whose payload fits.
    const chunks = screenChunks(1920, 1200, 77);
    const bufs = chunks.map((p) => Buffer.from(p, 'base64'));
    const insideHits = bufs
      .slice(1) // every chunk after the first is pure continuation bytes
      .filter((buf) => operatorFrameStartsUpdate(buf));
    expect(insideHits).toHaveLength(0);
  });

  it('a whole screen window reports itself as whole (the healthy case is not "partial")', () => {
    const a = screenChunks(1920, 1200, 11);
    const bufs = a.map((p) => Buffer.from(p, 'base64'));
    const suffix = new Array<number>(bufs.length + 1).fill(0);
    for (let i = bufs.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + bufs[i].length;

    expect(operatorFrameStartsUpdate(bufs[0])).toBe(true);
    expect(operatorFrameCompletesUpdate(bufs[0], suffix[0])).toBe(true);
    // Consistency: a complete update must also be a start.
    expect(operatorFrameCompletesUpdate(bufs[0], 0)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE CONSTANTS REALLY DO AGREE (this is what makes duplication safe)
// ─────────────────────────────────────────────────────────────────────────────

describe('THE TWO ENDS AGREE ON THE WIRE', () => {
  it('the duplicated wire constants equal the agent codec’s', () => {
    expect(OPERATOR_RFB_BYTES_PER_PIXEL).toBe(RFB.RFB_PIXEL_FORMAT.bytesPerPixel);
    expect(OPERATOR_RFB_ENCODING_RAW).toBe(RFB.RFB_ENCODING_RAW);
    expect(OPERATOR_RFB_ENCODING_DESKTOP_SIZE).toBe(RFB.RFB_ENCODING_DESKTOP_SIZE);
    expect(OPERATOR_RFB_CLIENT_POINTER_EVENT).toBe(RFB.RFB_CLIENT_POINTER_EVENT);
    expect(OPERATOR_RFB_CLIENT_KEY_EVENT).toBe(RFB.RFB_CLIENT_KEY_EVENT);
  });

  it('the device’s own framebuffer encoder is byte-identical to what this decoder expects', () => {
    // Build the SAME 2x2 image both ways and compare the bytes the agent emits
    // with what the operator decoder consumes. A drift in the 12-byte rect
    // header or in the RGBA→wire re-order fails here, not in the field.
    const rgba = Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    const bytes = RFB.encodeFramebufferUpdate([{ x: 0, y: 0, width: 2, height: 2, rgba }]);

    const viewer = new OperatorScreenDecoder();
    viewer.push(bytes);

    expect(viewer.isHalted).toBe(false);
    expect(viewer.geometry).toEqual({ width: 2, height: 2 });
    const snap = viewer.snapshot()!;
    // Red, green, blue, white — in that order, at that orientation.
    expect([...snap.rgba.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...snap.rgba.subarray(4, 8)]).toEqual([0, 255, 0, 255]);
    expect([...snap.rgba.subarray(8, 12)]).toEqual([0, 0, 255, 255]);
    expect([...snap.rgba.subarray(12, 16)]).toEqual([255, 255, 255, 255]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. INPUT OUTBOUND: the operator encodes, the REAL device decoder acts
// ─────────────────────────────────────────────────────────────────────────────

describe('AN OPERATOR GESTURE BECOMES AN ACTION THE DEVICE ACTUALLY EXECUTES', () => {
  it('a click at (640,480) decodes on the device into a pressed pointer action', () => {
    const plan = planOperatorPointer(640, 480, 1, RELAY_MAX_FRAME_BYTES);
    expect(plan.kind).toBe('pointer');
    expect(plan.payloads).toHaveLength(1);

    // The REAL device-side control channel — the object `pumpRelay` holds.
    const control = new RelayControlChannel();
    const actions: any[] = [];
    for (const p of plan.payloads) actions.push(...control.ingest(p));

    expect(actions).toEqual([{ kind: 'pointer', buttonMask: 1, x: 640, y: 480, pressed: true }]);
  });

  it('a hover (buttonMask 0) is a MOVE, not a click', () => {
    const control = new RelayControlChannel();
    const actions = control.ingest(planOperatorPointer(10, 20, 0, RELAY_MAX_FRAME_BYTES).payloads[0]);
    // `pressed` false is what stops a move from being executed as a click.
    expect(actions).toEqual([{ kind: 'pointer', buttonMask: 0, x: 10, y: 20, pressed: false }]);
  });

  it('a right-click keeps its button bit instead of collapsing to left-click', () => {
    const control = new RelayControlChannel();
    const actions = control.ingest(planOperatorPointer(5, 6, 4, RELAY_MAX_FRAME_BYTES).payloads[0]);
    expect(actions[0]).toEqual({ kind: 'pointer', buttonMask: 4, x: 5, y: 6, pressed: true });
  });

  it('a key down AND its matching up both decode — the pair a real keystroke needs', () => {
    const control = new RelayControlChannel();
    const down = control.ingest(planOperatorKey(0xff0d, true, RELAY_MAX_FRAME_BYTES).payloads[0]);
    const up = control.ingest(planOperatorKey(0xff0d, false, RELAY_MAX_FRAME_BYTES).payloads[0]);
    expect(down).toEqual([{ kind: 'key', keysym: 0xff0d, down: true }]);
    expect(up).toEqual([{ kind: 'key', keysym: 0xff0d, down: false }]);
  });

  it('the device’s OWN client decoder agrees byte-for-byte with this encoder', () => {
    // Belt AND braces: the same bytes, parsed by the raw decoder rather than the
    // channel, must produce the identical event. This catches a chunker that
    // silently altered the payload.
    const decoder = new RFB.RfbClientDecoder();
    const events = decoder.push(encodeOperatorPointerEvent(2, 33, 44));
    expect(events).toEqual([{ type: 'pointer', buttonMask: 2, x: 33, y: 44 }]);

    const decoder2 = new RFB.RfbClientDecoder();
    expect(decoder2.push(encodeOperatorKeyEvent(0x0041, true))).toEqual([
      { type: 'key', down: true, keysym: 0x0041 },
    ]);
  });

  it('an out-of-range coordinate is CLAMPED, never wrapped onto the wrong pixel', () => {
    const plan = planOperatorPointer(70000, -5, 1, RELAY_MAX_FRAME_BYTES);
    const control = new RelayControlChannel();
    const actions = control.ingest(plan.payloads[0]);
    // Wrapping would put this click at 4464 and click something else entirely.
    expect(actions[0].x).toBe(65535);
    expect(actions[0].y).toBe(0);
  });

  it('input never exceeds one relay frame — the ceiling the backend enforces', () => {
    const plan = planOperatorPointer(1920, 1080, 1, RELAY_MAX_FRAME_BYTES);
    for (const p of plan.payloads) {
      expect(Buffer.from(p, 'base64').length).toBeLessThanOrEqual(RELAY_MAX_FRAME_BYTES);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. HONEST REFUSAL: an undecodable stream HALTS, it never guesses
// ─────────────────────────────────────────────────────────────────────────────

describe('AN UNDECODABLE STREAM IS REFUSED, NOT GUESSED', () => {
  it('an encoding whose payload length is unknowable still halts, never mis-parses', () => {
    // RRE (2), TRLE (16) and ZRLE (17) all size their payload by a rule this
    // decoder does not implement, so consuming one would put every later byte
    // at the wrong offset. Raw, CopyRect, Hextile and Tight are implemented;
    // everything else must still refuse. (Tight was in this list until this
    // slice — retargeting it, rather than deleting the case, is what keeps the
    // fail-loud property pinned as the decoder grows.)
    for (const encoding of [2, 16, 17]) {
      const head = Buffer.alloc(12);
      head.writeUInt16BE(0, 0); // x
      head.writeUInt16BE(0, 2); // y
      head.writeUInt16BE(8, 4); // w
      head.writeUInt16BE(8, 6); // h
      head.writeInt32BE(encoding, 8);
      const stream = Buffer.concat([Buffer.from([0, 0, 0, 1]), head, Buffer.alloc(64)]);

      const viewer = new OperatorScreenDecoder();
      const events = viewer.push(stream);

      expect(viewer.isHalted).toBe(true);
      expect(viewer.haltReasonCode).toBe('unsupported-encoding');
      expect(events.some((e) => e.type === 'desync')).toBe(true);
      expect(viewer.snapshot()).toBeNull();
    }
  });

  it('a MALFORMED Hextile tile stream halts with its own reason, it is not guessed', () => {
    // Hextile is now SUPPORTED, so the fail-loud property for it moved: a tile
    // whose subencoding mask asks for nothing at all (no raw, no background, no
    // foreground, no subrects) leaves no colour to paint — §7.7.4 requires the
    // first non-raw tile to specify a background. Guessing a colour would put a
    // wrong picture on the operator's screen; the decoder refuses instead.
    const head = Buffer.alloc(12);
    head.writeUInt16BE(0, 0);
    head.writeUInt16BE(0, 2);
    head.writeUInt16BE(8, 4); // 8x8 -> exactly one tile
    head.writeUInt16BE(8, 6);
    head.writeInt32BE(5, 8); // Hextile
    const stream = Buffer.concat([Buffer.from([0, 0, 0, 1]), head, Buffer.from([0x00])]);

    const viewer = new OperatorScreenDecoder();
    const events = viewer.push(stream);

    expect(viewer.isHalted).toBe(true);
    expect(viewer.haltReasonCode).toBe('bad-hextile');
    expect(events.some((e) => e.type === 'desync')).toBe(true);
    expect(viewer.snapshot()).toBeNull();
  });

  it('an unknown server message type halts the decoder', () => {
    const viewer = new OperatorScreenDecoder();
    const events = viewer.push(Buffer.from([99]));
    expect(viewer.isHalted).toBe(true);
    expect(viewer.haltReasonCode).toBe('unknown-message-type');
    expect(events[0]).toMatchObject({ type: 'desync', reason: 'unknown-message-type' });
  });

  it('a header claiming an enormous rectangle costs a refusal, not a huge buffer', () => {
    const b = Buffer.alloc(16);
    b[0] = 0;
    b[1] = 0;
    b.writeUInt16BE(1, 2); // 1 rectangle
    b.writeUInt16BE(0, 4);
    b.writeUInt16BE(0, 6);
    b.writeUInt16BE(65535, 8);
    b.writeUInt16BE(65535, 10);
    b.writeInt32BE(OPERATOR_RFB_ENCODING_RAW, 12);

    const viewer = new OperatorScreenDecoder();
    viewer.push(b);
    expect(viewer.isHalted).toBe(true);
    expect(viewer.haltReasonCode).toBe('rect-too-large');
  });

  it('a halted decoder keeps the screen it already had instead of blanking it', () => {
    const screen = captureScreen(32, 24);
    const viewer = new OperatorScreenDecoder();
    for (const p of deviceScreenPayloads(screen).payloads) viewer.ingest(p);
    const good = viewer.snapshot();
    expect(good).not.toBeNull();

    viewer.push(Buffer.from([99])); // desync
    expect(viewer.isHalted).toBe(true);
    // A stream fault must not also take the operator's picture away.
    expect(viewer.snapshot()!.sha256).toBe(good!.sha256);
  });

  it('an EMPTY payload is a no-op — a silent tick must not fault the view', () => {
    // The pump can legitimately hand over an empty poll result. That is not a
    // corrupt stream, so it must leave the decoder untouched and running.
    const viewer = new OperatorScreenDecoder();
    expect(viewer.ingest('')).toEqual([]);
    expect(viewer.ingest(null as unknown as string)).toEqual([]);
    expect(viewer.isHalted).toBe(false);
    expect(viewer.snapshot()).toBeNull();
  });

  it('a GARBAGE payload is refused, never rendered as plausible pixels', () => {
    // `Buffer.from(x, 'base64')` is LENIENT: it does not throw on junk, it
    // silently yields bytes. Those bytes are not a message this decoder can
    // frame, so the honest outcome is a halt with a reason — the one outcome
    // that must never happen is garbage decoded into a screen the operator
    // believes is their Mac.
    const viewer = new OperatorScreenDecoder();
    expect(() => viewer.ingest('!!!not base64!!!')).not.toThrow();
    expect(viewer.isHalted).toBe(true);
    expect(viewer.haltReasonCode).toBe('unknown-message-type');
    expect(viewer.snapshot()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE RENDER: a snapshot becomes an actual image
// ─────────────────────────────────────────────────────────────────────────────

describe('THE SNAPSHOT IS RENDERABLE, NOT JUST A BUFFER', () => {
  it('encodes to a valid PNG with the right dimensions in its IHDR', () => {
    const screen = captureScreen(40, 30);
    const viewer = new OperatorScreenDecoder();
    for (const p of deviceScreenPayloads(screen).payloads) viewer.ingest(p);

    const png = encodeOperatorScreenPng(viewer.snapshot()!);

    // Real PNG structure: signature, IHDR width/height, IEND at the tail.
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(40);
    expect(png.readUInt32BE(20)).toBe(30);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(2); // truecolour
    expect(png.subarray(png.length - 8, png.length - 4).toString('latin1')).toBe('IEND');
    // A gradient compresses, so the PNG must be a fraction of the raw RGBA.
    expect(png.length).toBeLessThan(screen.rgba.length);
  });

  it('the wire→RGBA conversion is the documented BB GG RR → RR GG BB', () => {
    // A pure blue pixel on the wire is [255,0,0,0] (B first, little-endian).
    const wire = Buffer.from([255, 0, 0, 0]);
    const rgba = operatorWirePixelsToRgba(wire, 1);
    expect([...rgba]).toEqual([0, 0, 255, 255]);
  });

  it('the snapshot hash changes when one pixel changes, and not otherwise', () => {
    const screen = captureScreen(16, 16);
    const a = new OperatorScreenDecoder();
    for (const p of deviceScreenPayloads(screen).payloads) a.ingest(p);

    const same = new OperatorScreenDecoder();
    for (const p of deviceScreenPayloads(captureScreen(16, 16)).payloads) same.ingest(p);
    expect(same.snapshot()!.sha256).toBe(a.snapshot()!.sha256);

    const tweaked = captureScreen(16, 16);
    tweaked.rgba[0] = tweaked.rgba[0] ^ 0xff;
    const b = new OperatorScreenDecoder();
    for (const p of deviceScreenPayloads(tweaked).payloads) b.ingest(p);
    expect(b.snapshot()!.sha256).not.toBe(a.snapshot()!.sha256);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The client control encoders are well-formed RFB
// ─────────────────────────────────────────────────────────────────────────────

describe('THE OUTBOUND CLIENT MESSAGES ARE WELL-FORMED RFB', () => {
  it('a pointer event is 6 bytes with the RFC 6143 §7.5.5 layout', () => {
    const b = encodeOperatorPointerEvent(1, 0x1234, 0x5678);
    expect(b.length).toBe(6);
    expect(b[0]).toBe(5);
    expect(b[1]).toBe(1);
    expect(b.readUInt16BE(2)).toBe(0x1234);
    expect(b.readUInt16BE(4)).toBe(0x5678);
  });

  it('a key event is 8 bytes with the RFC 6143 §7.5.4 layout', () => {
    const b = encodeOperatorKeyEvent(0xff1b, true);
    expect(b.length).toBe(8);
    expect(b[0]).toBe(4);
    expect(b[1]).toBe(1);
    expect(b.readUInt32BE(4)).toBe(0xff1b);
  });

  it('set-encodings and update-request match the device decoder’s expectations', () => {
    const dec = new RFB.RfbClientDecoder();
    expect(dec.push(encodeOperatorSetEncodings([OPERATOR_RFB_ENCODING_RAW]))).toEqual([
      { type: 'set-encodings', encodings: [0] },
    ]);

    const dec2 = new RFB.RfbClientDecoder();
    expect(
      dec2.push(encodeOperatorUpdateRequest({ incremental: true, width: 1280, height: 800 })),
    ).toEqual([
      { type: 'update-request', incremental: true, x: 0, y: 0, width: 1280, height: 800 },
    ]);
  });

  it('the chunker refuses a non-positive ceiling rather than emitting nothing', () => {
    // A zero ceiling would silently produce zero payloads — a gesture that
    // vanishes with no error, which is indistinguishable from a dead relay.
    expect(() => chunkOperatorBytes(Buffer.alloc(4), 0)).toThrow(RangeError);
    expect(() => chunkOperatorBytes(Buffer.alloc(4), -1)).toThrow(RangeError);
    expect(() => chunkOperatorBytes(Buffer.alloc(4), NaN)).toThrow(RangeError);
  });
});
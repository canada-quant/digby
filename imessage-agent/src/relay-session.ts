/**
 * RELAY SESSION — the codec BOLTED to the pump (ticket c468f922).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The previous slice shipped a relay that carries bytes, and an independent
 * review found the damning half of it: the relay had routes, gates, queues, a
 * capability mint and 31 passing tests, and NOTHING on earth that dialled them.
 * That is this ticket's recurring defect — "a requirement no live surface
 * satisfies" — and `rfb-codec.ts` is exposed to the SAME trap one layer up: a
 * codec that is unit-proven but that `pumpRelay` never calls carries exactly as
 * little as no codec at all.
 *
 * So this module is the joint. It owns the two directions of a brokered
 * session and is what `pumpRelay` (and the screen sender) actually call:
 *
 *   operator → device : relay frames → RfbClientDecoder → input actions,
 *                       which `index.ts` executes against `computer.*`.
 *   device → operator : captured screen → encodeFramebufferUpdate →
 *                       chunkForRelay → relay frames.
 *
 * Every IO is INJECTED (a queue function, an input sink, a capture function),
 * which is what lets the whole joint be exercised on Linux CI and by the
 * backend's end-to-end suite without a Mac. The module itself opens no socket,
 * reads no file, and calls no clock.
 *
 * ── THE FRAME CEILING, AGAIN ────────────────────────────────────────────────
 * A relay frame is capped at 64 KiB; one Raw 1280×800 update is 4 MB. So
 * `queueScreen` emits MANY frames per screen and the operator side reassembles
 * them through the same stream decoder. Nothing here assumes one frame = one
 * RFB message.
 *
 * ── HONEST SCOPE OF THIS SLICE ──────────────────────────────────────────────
 * What is REAL here: the RFC 6143 bytes, the decode to screen state and to
 * input actions, the chunking across the ceiling, and the pump calling all of
 * it. What is NOT yet proven: a live macOS capture driving it end-to-end
 * (`captureScreenRgba` exists and its DECODER is fully tested against a real
 * BMP fixture, but running it needs a Mac — parked as device e2e by the
 * supervisor's steer). Do not read this file as "remote desktop works on
 * hardware"; read it as "the codec is on the wire path".
 */

import { createHash } from 'crypto';
import { RfbClientDecoder, RfbServerEvent, RfbClientEvent, RfbSession, RFB_PIXEL_FORMAT, RFB_RELAY_FRAME_BYTES, encodeFramebufferUpdate, encodeDesktopSize, chunkForRelay, rgbaToRfbPixels } from './rfb-codec';

// ─────────────────────────────────────────────────────────────────────────────
// Direction: operator → device (control)
// ─────────────────────────────────────────────────────────────────────────────

/** An input action the agent can execute. Pure data — `index.ts` performs it. */
export type RelayInputAction =
  | { kind: 'pointer'; buttonMask: number; x: number; y: number; pressed: boolean }
  | { kind: 'key'; keysym: number; down: boolean };

/**
 * What the device does with one decoded client event. Returning `null` means
 * "decoded fine, but not something this device acts on in this slice" — which
 * is honest and observable, unlike silently swallowing it.
 *
 * `update-request` is null ON PURPOSE: an RFB server answers it by sending a
 * FramebufferUpdate, and this slice's sender is driven by the pump rather than
 * by a request queue. Saying so here beats pretending it is handled.
 */
export function planInputAction(ev: RfbClientEvent): RelayInputAction | null {
  switch (ev.type) {
    case 'pointer':
      // Buttons 1..8 are bits 0..7 (RFC 6143 §7.5.5). Any bit set = a press.
      return { kind: 'pointer', buttonMask: ev.buttonMask, x: ev.x, y: ev.y, pressed: ev.buttonMask !== 0 };
    case 'key':
      return { kind: 'key', keysym: ev.keysym, down: ev.down };
    default:
      return null;
  }
}

/** Keysyms for the non-printable keys worth naming (RFC 6143 §7.5.4 table). */
export const RELAY_KEYSYM_NAMES: Readonly<Record<number, string>> = {
  0xff08: 'BackSpace',
  0xff09: 'Tab',
  0xff0d: 'Return',
  0xff1b: 'Escape',
  0xff63: 'Insert',
  0xffff: 'Delete',
  0xff50: 'Home',
  0xff57: 'End',
  0xff55: 'PageUp',
  0xff56: 'PageDown',
  0xff51: 'Left',
  0xff52: 'Up',
  0xff53: 'Right',
  0xff54: 'Down',
  0xffbe: 'F1',
  0xffbf: 'F2',
  0xffc0: 'F3',
  0xffc1: 'F4',
  0xffc2: 'F5',
  0xffc3: 'F6',
  0xffc4: 'F7',
  0xffc5: 'F8',
  0xffc6: 'F9',
  0xffc7: 'F10',
  0xffc8: 'F11',
  0xffc9: 'F12',
};

/**
 * A keysym → the character it types, or null for a non-printable key.
 *
 * RFB carries keysyms, but `computer.typeText` takes a string and
 * `computer.keyPress` takes a key NAME. Bridging them is this function's whole
 * job, and it is pure so the mapping is testable without a Mac.
 *
 * Only Latin-1 printables map to text: the protocol's own cut-text message is
 * Latin-1, and a keysym above U+00FF is (per RFC 6143 §7.5.4) either a legacy
 * X keysym — handled by the table above — or a Unicode keysym with the 0x01000000
 * bit set, which this slice reports as unmapped rather than guessing.
 */
export function keysymToText(keysym: number): string | null {
  if (keysym >= 0x20 && keysym <= 0x7e) return String.fromCharCode(keysym);
  if (keysym >= 0xa0 && keysym <= 0xff) return String.fromCharCode(keysym);
  return null;
}

/** The named key for a keysym, when it is a non-printable key. */
export function keysymToKeyName(keysym: number): string | null {
  return RELAY_KEYSYM_NAMES[keysym] ?? null;
}

/**
 * The device half of the control channel: feed it the base64 payloads the pump
 * drained and it hands back ordered input actions.
 *
 * A malformed stream yields NO actions and marks the session halted — it never
 * throws, because the caller is the poll loop and an exception there costs the
 * Mac its command channel (the channel is how it gets repaired).
 */
export class RelayControlChannel {
  private decoder = new RfbClientDecoder();
  private applied = 0;
  private lastReason: string | null = null;

  get isHalted(): boolean {
    return this.decoder.isHalted;
  }

  get haltReason(): string | null {
    return this.lastReason;
  }

  get actionsApplied(): number {
    return this.applied;
  }

  /** Decode one carried payload into the actions it implies. */
  ingest(payloadB64: string): RelayInputAction[] {
    if (this.decoder.isHalted) return [];
    let bytes: Buffer;
    try {
      bytes = Buffer.from(payloadB64, 'base64');
    } catch {
      return [];
    }
    if (bytes.length === 0) return [];

    const events = this.decoder.push(bytes);
    const actions: RelayInputAction[] = [];
    for (const ev of events) {
      if (ev.type === 'desync') {
        this.lastReason = `${ev.reason}: ${ev.detail}`;
        break;
      }
      const action = planInputAction(ev);
      if (action) actions.push(action);
    }
    this.applied += actions.length;
    return actions;
  }

  reset(): void {
    this.decoder = new RfbClientDecoder();
    this.applied = 0;
    this.lastReason = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Direction: device → operator (screen)
// ─────────────────────────────────────────────────────────────────────────────

/** A captured screen, as raw RGBA bytes. */
export interface CapturedScreen {
  width: number;
  height: number;
  /** `width * height * 4` bytes, R,G,B,A order, top-to-bottom scan lines. */
  rgba: Buffer;
}

/**
 * How many relay frames ONE screen may occupy.
 *
 * ── WHY THIS EXISTS (audit F1, 2026-11-02) ──────────────────────────────────
 * The first cut of this module encoded the capture at its NATIVE size. On a
 * Retina Mac that is fatal, and silently so: the relay refuses the writer at
 * `RELAY_QUEUE_MAX_FRAMES = 256` and the agent's own outbox drops the oldest
 * frames past 256, so the stream is truncated or refused forever. The real
 * numbers, from the wire size `16 + 4 + 12 + w*h*4` divided by the 64 KiB frame:
 *
 *   1280×800  → 63 frames   ok      2560×1600 → 251  ok (barely)
 *   2880×1800 → 317 frames  DEAD    3024×1964 → 363  DEAD   (14" MacBook Pro)
 *   3456×2234 → 472 frames  DEAD    3840×2160 → 507  DEAD   (4K)
 *   5120×2880 → 901 frames  DEAD                           (5K)
 *
 * i.e. on EVERY Retina Mac — which is to say most paired Macs — the operator
 * would see at most a third of the screen and then nothing. The unit tests did
 * not catch it because they used 1080p, which happens to fit.
 *
 * 192 leaves headroom under the 256 ceiling for the DesktopSize announcement
 * and for the operator's own drain lag, without ever approaching the refusal.
 */
export const RELAY_SCREEN_FRAME_BUDGET = 192;

/** The wire size of one full-screen Raw update, before chunking. */
export function relayScreenBytes(width: number, height: number, bytesPerPixel = 4): number {
  // FramebufferUpdate header (4) + one rect header (12) + pixels,
  // plus the DesktopSize pseudo-rect (16) that rides along on a geometry change.
  return 16 + 4 + 12 + width * height * bytesPerPixel;
}

/** How many relay frames a full-screen update of this size needs. */
export function relayScreenFrames(width: number, height: number, bytesPerPixel = 4): number {
  return Math.ceil(relayScreenBytes(width, height, bytesPerPixel) / RFB_RELAY_FRAME_BYTES);
}

/**
 * Downscale a capture so one full screen fits `maxFrames` relay frames.
 *
 * Scale-to-fit rather than refusing to send: an operator who can see the whole
 * screen at 78% is being served, and one who can see a third of it at 100% is
 * not. The aspect ratio is preserved (both axes take the same factor), so click
 * coordinates remain a single uniform mapping — a per-axis fit would make the
 * operator's (x,y) require two different scalars and land clicks wrong.
 *
 * Uses an area-average box filter: a nearest-neighbour downscale of a text-heavy
 * desktop aliases badly enough that UI text becomes unreadable, and reading the
 * other machine's UI is the entire point.
 *
 * Returns the input UNCHANGED (same object) when it already fits, so callers can
 * rely on identity for the common small-screen case, and the e2e assertions of
 * byte-identical round trips keep holding where no scaling happened.
 */
export function fitScreenToBudget(
  screen: CapturedScreen,
  maxFrames: number = RELAY_SCREEN_FRAME_BUDGET,
): CapturedScreen {
  const { width, height, rgba } = screen;
  if (!(width > 0) || !(height > 0)) return screen;
  if (relayScreenFrames(width, height) <= maxFrames) return screen;

  const budgetBytes = maxFrames * RFB_RELAY_FRAME_BYTES;
  // Solve for the largest uniform factor s that fits: w*h*s^2*4 + 32 <= budget.
  const scale = Math.sqrt(Math.max(0, budgetBytes - 32) / (width * height * 4));
  // Never collapse to zero, and never round UP past the budget.
  const tw = Math.max(1, Math.min(width, Math.floor(width * scale)));
  const th = Math.max(1, Math.min(height, Math.floor(height * scale)));

  const out = Buffer.alloc(tw * th * 4);
  const xRatio = width / tw;
  const yRatio = height / th;

  for (let ty = 0; ty < th; ty++) {
    const sy0 = Math.floor(ty * yRatio);
    const sy1 = Math.max(sy0 + 1, Math.min(height, Math.floor((ty + 1) * yRatio)));
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = Math.floor(tx * xRatio);
      const sx1 = Math.max(sx0 + 1, Math.min(width, Math.floor((tx + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const rowBase = sy * width;
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (rowBase + sx) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          a += rgba[i + 3];
          n++;
        }
      }
      const d = (ty * tw + tx) * 4;
      out[d] = Math.round(r / n);
      out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n);
      out[d + 3] = Math.round(a / n);
    }
  }
  return { width: tw, height: th, rgba: out };
}

/**
 * The device half of the screen channel.
 *
 * `sendScreen` is the whole point: it turns a captured screen into REAL RFB
 * FramebufferUpdate bytes and then into as many relay frames as the 64 KiB
 * ceiling requires. It returns the count so the caller can log honestly
 * ("one screen = N frames") rather than pretending a screen is one frame.
 */
export class RelayScreenChannel {
  private width = 0;
  private height = 0;
  private framesSent = 0;
  private screensSent = 0;
  private lastHash: string | null = null;

  get geometry(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  get stats(): { frames: number; screens: number } {
    return { frames: this.framesSent, screens: this.screensSent };
  }

  /** The last screen's content hash — what change-gating compares. */
  get contentHash(): string | null {
    return this.lastHash;
  }

  /**
   * Encode + chunk one screen for the relay.
   *
   * ── TWO BUGS THIS SIGNATURE FIXES (audit F1, 2026-11-02) ──
   * 1. SIZE: the capture is fitted to `maxFrames` (default
   *    RELAY_SCREEN_FRAME_BUDGET) before encoding, so a Retina or 4K Mac cannot
   *    exceed the queue cap. See RELAY_SCREEN_FRAME_BUDGET for the dead-on-
   *    arrival numbers.
   * 2. REPETITION: an unchanged screen sends NOTHING. The pump ticks every ~25 s
   *    and the first cut re-captured, re-encoded and re-pushed the identical
   *    screen on every tick — ~16 MB/min at 1280×800 and ~30 MB × 4/min at 4K,
   *    for pixels the operator already had. `force` exists for the first frame
   *    after a reconnect, where the operator genuinely has nothing yet.
   *
   * `queue` receives base64 payloads in order; a geometry change emits a
   * DesktopSize pseudo-rectangle FIRST, because the operator's decoder learns
   * the canvas from the stream and would otherwise clip the new frame.
   */
  sendScreen(
    screen: CapturedScreen,
    queue: (payloadB64: string) => void,
    opts: { maxFrames?: number; force?: boolean } = {},
  ): number {
    const maxFrames = opts.maxFrames ?? RELAY_SCREEN_FRAME_BUDGET;
    const fitted = fitScreenToBudget(screen, maxFrames);
    const { width, height, rgba } = fitted;
    if (!(width > 0) || !(height > 0)) return 0;
    const need = width * height * 4;
    if (rgba.length < need) return 0;

    // Change-gating: identical pixels at identical geometry are not a new frame.
    const hash = createHash('sha256').update(rgba.subarray(0, need)).digest('hex');
    const geometryChanged = width !== this.width || height !== this.height;
    if (!opts.force && !geometryChanged && hash === this.lastHash) return 0;

    const parts: Buffer[] = [];
    if (geometryChanged) parts.push(encodeDesktopSize(width, height));

    parts.push(
      encodeFramebufferUpdate([
        { x: 0, y: 0, width, height, rgba: rgba.subarray(0, need) },
      ]),
    );

    const payloads = chunkForRelay(Buffer.concat(parts));
    for (const p of payloads) queue(p);
    this.width = width;
    this.height = height;
    this.lastHash = hash;
    this.framesSent += payloads.length;
    this.screensSent += 1;
    return payloads.length;
  }
}

/**
 * One brokered session's codec pair — what `pumpRelay` holds.
 *
 * Both channels are created together because a session without either one is
 * half a remote desktop: control with no screen is a blind operator, and screen
 * with no control is a video.
 */
export class RelaySessionCodec {
  readonly control = new RelayControlChannel();
  screen = new RelayScreenChannel();

  /** Reset on session end so the next session never inherits a cursor or a canvas. */
  reset(): void {
    this.control.reset();
    this.screen = new RelayScreenChannel();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Operator-side convenience: reassemble + decode the device's screen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The operator's view: feed it the frames the device sent and it decodes them
 * into screen state. This is the mirror of `RelayScreenChannel`, and the
 * backend's end-to-end suite uses exactly this object to prove the carry —
 * so what the test asserts is the same code the product runs.
 */
export class RelayViewer {
  private session = new RfbSession();

  /** Ingest one carried payload; returns the decoded events for observability. */
  ingest(payloadB64: string): RfbServerEvent[] {
    const bytes = Buffer.from(payloadB64, 'base64');
    if (bytes.length === 0) return [];
    return this.session.push(bytes);
  }

  get isHalted(): boolean {
    return this.session.isHalted;
  }

  get width(): number | null {
    return this.session.screenWidth;
  }

  get height(): number | null {
    return this.session.screenHeight;
  }

  /** The decoded screen state — dimensions, pixels and a content hash. */
  snapshot() {
    return this.session.snapshot();
  }

  /** The decoded screen as RGBA, for rendering or for a test comparison. */
  rgba(): Buffer | null {
    const snap = this.session.snapshot();
    if (!snap) return null;
    return rfbPixelsToRgbaLocal(snap.pixels, snap.width * snap.height);
  }
}

/** Local re-export shape kept tiny so this module's import list stays honest. */
function rfbPixelsToRgbaLocal(pixels: Buffer, pixelCount: number): Buffer {
  const out = Buffer.alloc(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    const s = i * 4;
    out[i * 4] = pixels[s + 2];
    out[i * 4 + 1] = pixels[s + 1];
    out[i * 4 + 2] = pixels[s];
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Real capture → RGBA (macOS), with a PURE, fully-tested decode
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an uncompressed BMP (as `screencapture -t bmp` writes) into RGBA.
 *
 * WHY BMP AND NOT PNG. The agent already reads PNG *headers* to learn
 * dimensions, but a full PNG decoder is a large, risky dependency and the
 * agent's only image need here is raw pixels. BMP is uncompressed, so this is a
 * bounded parser with no entropy decoding to get wrong.
 *
 * SUPPORTED: 24-bit and 32-bit BI_RGB, bottom-up or top-down, at either pixel
 * packing order. REFUSED (returns null, never throws): anything compressed,
 * anything indexed, any other bit depth — a screen that cannot be decoded must
 * look like a refused frame, not like a plausible wrong picture.
 *
 * Pure: no fs, no child_process. `captureScreenRgba` does the spawning.
 */
export function parseBmpToRgba(buf: Buffer): CapturedScreen | null {
  if (!buf || buf.length < 54) return null;
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) return null; // 'BM'

  const pixelOffset = buf.readUInt32LE(10);
  const dibSize = buf.readUInt32LE(14);
  if (dibSize < 40) return null; // BITMAPCOREHEADER or worse

  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const planes = buf.readUInt16LE(26);
  const bitCount = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (planes !== 1) return null;
  if (compression !== 0) return null; // BI_RGB only; no RLE, no bitfields
  if (bitCount !== 24 && bitCount !== 32) return null;
  if (width <= 0) return null;

  // A negative height means top-down rows (the sign is the row order).
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  if (height === 0) return null;

  const bytesPerPixel = bitCount / 8;
  const stride = Math.floor((bitCount * width + 31) / 32) * 4; // rows padded to 4 bytes
  const needed = pixelOffset + stride * height;
  if (buf.length < needed) return null;

  const rgba = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) {
    // Bottom-up BMP stores the LAST screen row first.
    const srcRow = topDown ? row : height - 1 - row;
    const srcBase = pixelOffset + srcRow * stride;
    for (let col = 0; col < width; col++) {
      const s = srcBase + col * bytesPerPixel;
      const d = (row * width + col) * 4;
      rgba[d] = buf[s + 2]; // R
      rgba[d + 1] = buf[s + 1]; // G
      rgba[d + 2] = buf[s]; // B
      rgba[d + 3] = bytesPerPixel === 4 ? buf[s + 3] : 255; // A (BMP's 4th byte is unused)
    }
  }
  return { width, height, rgba };
}

/** The permission/geometry facts a capture reports back, for honest logging. */
export interface CaptureIo {
  /** Run `screencapture -t bmp -x <path>`; resolves when the file exists. */
  run: (args: string[]) => Promise<void>;
  readFile: (path: string) => Buffer;
  tmpPath: () => string;
  cleanup?: (path: string) => void;
}

/**
 * Capture the screen as RGBA through `screencapture`'s BMP output.
 *
 * NOTE THE HONEST LIMIT: this runs on macOS only, and this slice's tests cover
 * its DECODER (`parseBmpToRgba`) against a real BMP fixture — not a live
 * capture, which needs a Mac with Screen Recording granted. That is the device
 * e2e the supervisor parked; it is named here rather than implied by a green
 * suite.
 */
export async function captureScreenRgba(io: CaptureIo): Promise<CapturedScreen | null> {
  const path = io.tmpPath();
  try {
    await io.run(['-t', 'bmp', '-x', path]);
    const buf = io.readFile(path);
    return parseBmpToRgba(buf);
  } catch {
    return null;
  } finally {
    try {
      io.cleanup?.(path);
    } catch {
      /* best-effort */
    }
  }
}

/** Sanity re-export so callers can assert the codec's declared frame ceiling. */
export { RFB_RELAY_FRAME_BYTES, RFB_PIXEL_FORMAT, rgbaToRfbPixels };
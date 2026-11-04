/**
 * RFB CODEC — the layer that turns carried bytes into a SCREEN
 * (ticket c468f922, owner ruling 2026-10-29/30 on card oq_b5118c38:
 * "can we do option three but a little more secure like how it's just like
 * TeamViewer").
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The relay data plane (`backend/…/relay-dataplane.ts` + the agent's
 * `pumpRelay`) CARRIES bytes and, until now, dropped every one of them on the
 * floor at the handler seam. A transport with no codec above it is a pipe into
 * a bucket: it proves bytes move and nothing else. This is the codec — the
 * piece that makes a carried FramebufferUpdate decode into actual pixels and a
 * carried PointerEvent/KeyEvent decode into an actual input intent.
 *
 * ── THE CONSTRAINT THAT DECIDES THE WHOLE DESIGN ────────────────────────────
 * A relay frame is capped at `RELAY_MAX_FRAME_BYTES` = 64 KiB
 * (`relay-dataplane.ts`), but ONE Raw rectangle for a 1280×800 screen is
 * 4 096 000 bytes — 64× the ceiling — and a full 4K screen is 33 MB. So a codec
 * that assumed "one relay frame = one RFB message" could never carry a real
 * screen at all: it would work perfectly on the test's toy payloads and fail on
 * the first genuine frame. That is the exact shape of defect this ticket keeps
 * re-learning (a requirement no live surface satisfies), one layer up.
 *
 * Therefore this codec is a STREAM codec on both directions:
 *   - `RfbServerDecoder` / `RfbClientDecoder` accept arbitrarily-split chunks
 *     and buffer partial messages (RFB §2: "The RFB protocol can operate over
 *     any reliable transport, either byte-stream or message based"), so the
 *     sender's chunk boundaries are irrelevant to the receiver;
 *   - `chunkForRelay` splits one outbound RFB byte stream into relay-sized
 *     base64 payloads, in order.
 * A 4 MB update therefore crosses as ~64 frames and reassembles byte-exactly.
 * Pinned by test at real screen sizes.
 *
 * ── SCOPE: POST-HANDSHAKE ONLY ──────────────────────────────────────────────
 * This codec starts AFTER the RFB handshake. Security-type negotiation,
 * ServerInit and the VNC challenge/response are deliberately NOT here, because
 * the ruling replaces them: the outer layer is the relay's per-session
 * capability (a 32-byte secret, hashed at rest), and the device's dedicated VNC
 * credential never enters this stream. Consequently NO structure in this module
 * has a slot a password could ride in on — a rectangle is geometry plus opaque
 * pixels, an input event is a keysym or a button mask. Pinned by test.
 *
 * ── THE PROPERTY THAT MAKES IT SAFE TO BOLT ONTO A POLL LOOP ────────────────
 * NOTHING HERE THROWS INTO THE CALLER. A malformed, truncated, oversized or
 * hostile stream produces a `desync` EVENT and halts that decoder — it never
 * raises into `pumpRelay`, because one bad frame must not cost the Mac its
 * command channel (the channel is how it gets repaired). Every length is
 * validated against a hard cap BEFORE the bytes are waited for, so a rectangle
 * claiming 65535×65535 cannot make the agent buffer 17 GB while it "waits".
 *
 * ── WIRE FORMAT ─────────────────────────────────────────────────────────────
 * RFC 6143 (the RFB protocol). All multi-byte integers are big-endian; pixel
 * values are byte-ordered by the agreed PIXEL_FORMAT. This module declares ONE
 * format for both ends — `RFB_PIXEL_FORMAT`, 32bpp/24 depth/true-colour
 * little-endian — which is what macOS Screen Sharing and every mainstream VNC
 * server produce natively.
 *
 * Pure leaf, in the same discipline as `brokered-session.ts` on the backend: no
 * fs, no child_process, no logger, no config, no clock, no I/O of any kind. The
 * only import is `crypto` for a content hash. That is what lets the identical
 * source be exercised by the agent's own suite AND by the backend's end-to-end
 * relay suite without either one needing a Mac.
 */

import { createHash } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Wire constants (RFC 6143 §7.5, §7.7)
// ─────────────────────────────────────────────────────────────────────────────

/** Client→server message types (RFC 6143 §7.5). */
export const RFB_CLIENT_SET_PIXEL_FORMAT = 0;
export const RFB_CLIENT_SET_ENCODINGS = 2;
export const RFB_CLIENT_FRAMEBUFFER_UPDATE_REQUEST = 3;
export const RFB_CLIENT_KEY_EVENT = 4;
export const RFB_CLIENT_POINTER_EVENT = 5;
export const RFB_CLIENT_CUT_TEXT = 6;

/** Server→client message types (RFC 6143 §7.6). */
export const RFB_SERVER_FRAMEBUFFER_UPDATE = 0;
export const RFB_SERVER_SET_COLOUR_MAP_ENTRIES = 1;
export const RFB_SERVER_BELL = 2;
export const RFB_SERVER_CUT_TEXT = 3;

/** Encodings (RFC 6143 §7.7) and the pseudo-encodings we recognise (§7.8). */
export const RFB_ENCODING_RAW = 0;
export const RFB_ENCODING_COPY_RECT = 1;
export const RFB_ENCODING_RRE = 2;
export const RFB_ENCODING_HEXTILE = 5;
export const RFB_ENCODING_TRLE = 16;
export const RFB_ENCODING_ZRLE = 17;
/** Pseudo-encoding: the rectangle carries a NEW framebuffer size, no pixels. */
export const RFB_ENCODING_DESKTOP_SIZE = -223;
/** Pseudo-encoding: a cursor shape. Its payload is size-dependent; unsupported. */
export const RFB_ENCODING_CURSOR = -239;

/**
 * The one pixel format this codec speaks, for both directions.
 *
 * 32 bits per pixel, 24 useful (the top byte is padding), true colour, and
 * NOT big-endian — so a pixel value `0x00RRGGBB` travels as the four bytes
 * `BB GG RR 00`. Every field here is asserted against RFC 6143 §7.4 by test.
 */
export const RFB_PIXEL_FORMAT = {
  bitsPerPixel: 32,
  depth: 24,
  bigEndian: false,
  trueColour: true,
  redMax: 255,
  greenMax: 255,
  blueMax: 255,
  redShift: 16,
  greenShift: 8,
  blueShift: 0,
  bytesPerPixel: 4,
} as const;

/**
 * Payload ceiling of ONE relay frame, MIRRORING `RELAY_MAX_FRAME_BYTES` in
 * `backend/src/modules/crossmodel/imessage/relay-dataplane.ts`.
 *
 * The agent cannot import the backend's constant (it ships as a src-only
 * tarball with no backend in it), so the number is duplicated here and pinned
 * by a backend test that reads BOTH files and fails if they ever diverge —
 * duplicated-but-drift-guarded beats a silent mismatch that only shows up as
 * `frame-too-large` in the field.
 */
export const RFB_RELAY_FRAME_BYTES = 64 * 1024;

/**
 * Largest single RAW rectangle we will accept: 64 MiB.
 *
 * A full 4K screen at 4 bytes/pixel is 33 MiB, so this admits one whole-screen
 * update — the ceiling exists to bound a hostile or desynced header, not to
 * constrain a legitimate frame.
 */
export const RFB_MAX_RECT_BYTES = 64 * 1024 * 1024;

/**
 * Largest framebuffer we will allocate: 128 MiB.
 *
 * A 6K display (6016×3384 at 4 B/px) is 81 MiB and fits; an 8K one does not,
 * which is the honest ceiling of a per-session pixel buffer on a device agent.
 * Validated BEFORE allocation so a bogus ServerInit/DesktopSize cannot OOM the
 * agent.
 */
export const RFB_MAX_FRAMEBUFFER_BYTES = 128 * 1024 * 1024;

/** Largest cut-text we will buffer (RFC 6143 §7.5.6). */
export const RFB_MAX_CUT_TEXT_BYTES = 1024 * 1024;

/**
 * How much undecoded input a decoder may hold while waiting for a rectangle to
 * complete: one maximum rectangle plus a few frames of slack. Exceeding it
 * means the stream is lying about a length, so the decoder desyncs rather than
 * growing without bound.
 */
export const RFB_MAX_PENDING_BYTES = RFB_MAX_RECT_BYTES + 8 * RFB_RELAY_FRAME_BYTES;

/** Events emitted by one `push` call, so a pathological stream cannot spin. */
const MAX_EVENTS_PER_PUSH = 4096;

// ─────────────────────────────────────────────────────────────────────────────
// Bounded byte queue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A FIFO of byte chunks with cheap `peek`/`drop`/`take`.
 *
 * Deliberately NOT `Buffer.concat` on every push: a 33 MiB rectangle arrives as
 * ~500 relay frames, and re-concatenating a growing buffer per frame is
 * quadratic. Chunks are kept as they arrived and copied out only when a message
 * is actually consumed.
 */
class ByteQueue {
  private chunks: Buffer[] = [];
  private head = 0;
  private total = 0;

  get size(): number {
    return this.total;
  }

  push(b: Buffer): void {
    if (b.length === 0) return;
    this.chunks.push(b);
    this.total += b.length;
  }

  /** Copy up to `n` bytes from the FRONT without consuming them. */
  peek(n: number): Buffer {
    const want = Math.min(n, this.total);
    const out = Buffer.allocUnsafe(want);
    let off = 0;
    let idx = 0;
    let skip = this.head;
    while (off < want && idx < this.chunks.length) {
      const c = this.chunks[idx];
      const avail = c.length - skip;
      if (avail <= 0) {
        idx++;
        skip = 0;
        continue;
      }
      const take = Math.min(avail, want - off);
      c.copy(out, off, skip, skip + take);
      off += take;
      skip += take;
      if (skip >= c.length) {
        idx++;
        skip = 0;
      }
    }
    return out;
  }

  /** Discard up to `n` bytes from the front. */
  drop(n: number): void {
    let left = Math.min(n, this.total);
    while (left > 0 && this.chunks.length > 0) {
      const c = this.chunks[0];
      const avail = c.length - this.head;
      if (avail <= left) {
        this.chunks.shift();
        this.total -= avail;
        left -= avail;
        this.head = 0;
      } else {
        this.head += left;
        this.total -= left;
        left = 0;
      }
    }
  }

  /** Consume exactly `n` bytes (caller has already checked availability). */
  take(n: number): Buffer {
    const b = this.peek(n);
    this.drop(b.length);
    return b;
  }

  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.total = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen state — what "decoded" actually means
// ─────────────────────────────────────────────────────────────────────────────

/** Why a decoder stopped. A halted decoder needs a NEW session; see `halted`. */
export type RfbDesyncReason =
  | 'unknown-message-type'
  | 'unsupported-encoding'
  | 'rect-too-large'
  | 'framebuffer-too-large'
  | 'cut-text-too-large'
  | 'pending-overflow'
  | 'bad-dimensions';

/** One decoded framebuffer, ready to render. */
export interface RfbScreenSnapshot {
  width: number;
  height: number;
  bytesPerPixel: number;
  /** A COPY of the framebuffer (RGBA-ordered per RFB_PIXEL_FORMAT: BB GG RR 00). */
  pixels: Buffer;
  /** Content hash of those bytes — cheap identity for "did the screen change". */
  sha256: string;
  /** How many rectangles have been composited into this framebuffer. */
  rectsApplied: number;
  /** How many pixel bytes have been composited. */
  bytesApplied: number;
}

function isValidDimension(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 0xffff;
}

/**
 * A framebuffer that Raw rectangles are composited into.
 *
 * This is the concrete meaning of "screen state out": dimensions, the pixel
 * bytes, and a hash. `applyRaw` clips out-of-bounds rectangles instead of
 * throwing — a server that sends a slightly-too-large rectangle is a bug to
 * survive, not a reason to drop a live session.
 */
export class RfbScreen {
  readonly width: number;
  readonly height: number;
  readonly bytesPerPixel: number;
  private buf: Buffer;
  rectsApplied = 0;
  bytesApplied = 0;

  constructor(width: number, height: number, bytesPerPixel: number = RFB_PIXEL_FORMAT.bytesPerPixel) {
    if (!isValidDimension(width) || !isValidDimension(height) || !isValidDimension(bytesPerPixel)) {
      throw new RangeError(`RfbScreen: bad dimensions ${width}x${height}x${bytesPerPixel}`);
    }
    const bytes = width * height * bytesPerPixel;
    if (bytes > RFB_MAX_FRAMEBUFFER_BYTES) {
      throw new RangeError(`RfbScreen: ${width}x${height} is ${bytes}b, over the ceiling`);
    }
    this.width = width;
    this.height = height;
    this.bytesPerPixel = bytesPerPixel;
    this.buf = Buffer.alloc(bytes);
  }

  /**
   * Composite one Raw rectangle at (x, y).
   *
   * `pixels` is the rectangle's own scan lines, left-to-right, top-to-bottom
   * (RFC 6143 §7.7.1) — so the source stride is the RECTANGLE width, not the
   * screen width. Getting that wrong is the classic off-by-a-row bug, so the
   * source offset is computed from `rectW` explicitly below.
   *
   * Returns false when the rectangle lies entirely outside the framebuffer (a
   * legal no-op), true otherwise.
   */
  applyRaw(x: number, y: number, rectW: number, rectH: number, pixels: Buffer): boolean {
    const bpp = this.bytesPerPixel;
    if (!isValidDimension(rectW) || !isValidDimension(rectH)) return false;
    const need = rectW * rectH * bpp;
    if (pixels.length < need) return false;

    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + rectW);
    const y1 = Math.min(this.height, y + rectH);
    if (x1 <= x0 || y1 <= y0) return false;

    const spanBytes = (x1 - x0) * bpp;
    let applied = 0;
    for (let row = y0; row < y1; row++) {
      const srcOff = ((row - y) * rectW + (x0 - x)) * bpp;
      const dstOff = (row * this.width + x0) * bpp;
      pixels.copy(this.buf, dstOff, srcOff, srcOff + spanBytes);
      applied += spanBytes;
    }
    this.rectsApplied += 1;
    this.bytesApplied += applied;
    return true;
  }

  /** Resize to a new geometry (DesktopSize pseudo-encoding). Content is cleared. */
  resize(width: number, height: number): void {
    if (!isValidDimension(width) || !isValidDimension(height)) {
      throw new RangeError(`RfbScreen: bad resize ${width}x${height}`);
    }
    const bytes = width * height * this.bytesPerPixel;
    if (bytes > RFB_MAX_FRAMEBUFFER_BYTES) {
      throw new RangeError(`RfbScreen: ${width}x${height} is ${bytes}b, over the ceiling`);
    }
    (this as { width: number }).width = width;
    (this as { height: number }).height = height;
    this.buf = Buffer.alloc(bytes);
  }

  /** A stable copy of the current screen state. */
  snapshot(): RfbScreenSnapshot {
    const pixels = Buffer.from(this.buf);
    return {
      width: this.width,
      height: this.height,
      bytesPerPixel: this.bytesPerPixel,
      pixels,
      sha256: createHash('sha256').update(pixels).digest('hex'),
      rectsApplied: this.rectsApplied,
      bytesApplied: this.bytesApplied,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Server→client decoding (the operator's view of the device's screen)
// ─────────────────────────────────────────────────────────────────────────────

export type RfbServerEvent =
  | { type: 'update-begin'; numRects: number }
  | {
      type: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      encoding: number;
      /** Raw pixels in wire order (BB GG RR 00); null for pseudo-encodings. */
      pixels: Buffer | null;
    }
  | { type: 'bell' }
  | { type: 'cut-text'; text: string }
  | { type: 'colour-map'; firstColour: number; numColours: number }
  | { type: 'desync'; reason: RfbDesyncReason; detail: string };

/**
 * Incremental decoder for the RFB server→client stream.
 *
 * Feed it relay frames in order; it emits whatever messages are now complete
 * and keeps the remainder buffered. Once it emits `desync` it is HALTED: a byte
 * stream with no message framing cannot be resynchronised without guessing, so
 * the honest response is to stop and let the session be re-established rather
 * than to emit plausible-looking garbage pixels into a live screen.
 */
export class RfbServerDecoder {
  readonly bytesPerPixel: number;
  private q = new ByteQueue();
  private rectsLeft = 0;
  private halted = false;
  private haltReason: RfbDesyncReason | null = null;

  constructor(opts: { bytesPerPixel?: number } = {}) {
    this.bytesPerPixel = opts.bytesPerPixel ?? RFB_PIXEL_FORMAT.bytesPerPixel;
  }

  /** True once the stream was refused; further pushes are ignored. */
  get isHalted(): boolean {
    return this.halted;
  }

  get haltReasonCode(): RfbDesyncReason | null {
    return this.haltReason;
  }

  /** Bytes buffered and not yet decoded (diagnostics). */
  get pending(): number {
    return this.q.size;
  }

  push(chunk: Buffer | Uint8Array): RfbServerEvent[] {
    const out: RfbServerEvent[] = [];
    if (this.halted) return out;
    this.q.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (this.q.size > RFB_MAX_PENDING_BYTES) {
      out.push(this.desync('pending-overflow', `buffered ${this.q.size}b waiting for a message`));
      return out;
    }
    for (let i = 0; i < MAX_EVENTS_PER_PUSH; i++) {
      const ev = this.step();
      if (!ev) break;
      out.push(ev);
      if (ev.type === 'desync') break;
    }
    return out;
  }

  private desync(reason: RfbDesyncReason, detail: string): RfbServerEvent {
    this.halted = true;
    this.haltReason = reason;
    this.q.clear();
    this.rectsLeft = 0;
    return { type: 'desync', reason, detail };
  }

  private step(): RfbServerEvent | null {
    if (this.q.size < 1) return null;
    const type = this.q.peek(1)[0];
    switch (type) {
      case RFB_SERVER_FRAMEBUFFER_UPDATE:
        return this.readFramebufferUpdate();
      case RFB_SERVER_SET_COLOUR_MAP_ENTRIES:
        return this.readColourMap();
      case RFB_SERVER_BELL:
        this.q.drop(1);
        return { type: 'bell' };
      case RFB_SERVER_CUT_TEXT:
        return this.readCutText();
      default:
        // An unknown SERVER message type means we cannot know how long it is,
        // so every subsequent byte would land at the wrong offset.
        return this.desync('unknown-message-type', `server message type ${type}`);
    }
  }

  private readFramebufferUpdate(): RfbServerEvent | null {
    // ── the update header: type(1) padding(1) number-of-rectangles(2) ──
    if (this.rectsLeft === 0) {
      if (this.q.size < 4) return null;
      const head = this.q.peek(4);
      const numRects = head.readUInt16BE(2);
      this.q.drop(4);
      this.rectsLeft = numRects;
      return { type: 'update-begin', numRects };
    }

    // ── one rectangle: x(2) y(2) w(2) h(2) encoding(4), then its payload ──
    if (this.q.size < 12) return null;
    const h = this.q.peek(12);
    const x = h.readUInt16BE(0);
    const y = h.readUInt16BE(2);
    const width = h.readUInt16BE(4);
    const height = h.readUInt16BE(6);
    const encoding = h.readInt32BE(8);

    // DesktopSize is a pseudo-encoding: the rectangle header IS the message and
    // carries the new framebuffer geometry with no pixel data.
    if (encoding === RFB_ENCODING_DESKTOP_SIZE) {
      this.q.drop(12);
      this.rectsLeft -= 1;
      return { type: 'rect', x: 0, y: 0, width, height, encoding, pixels: null };
    }

    // Only Raw is implemented. Anything else has a payload whose length we do
    // not know (Hextile/RRE/TRLE/ZRLE all vary), so consuming it would put us
    // at the wrong offset for every following message. Refuse the stream
    // instead of mis-parsing it: a client that receives `unsupported-encoding`
    // can fall back; a client that receives silent garbage never can.
    if (encoding !== RFB_ENCODING_RAW) {
      return this.desync('unsupported-encoding', `encoding ${encoding} (only Raw is implemented)`);
    }

    const payload = width * height * this.bytesPerPixel;
    // Validate BEFORE waiting for the bytes — a header claiming 65535×65535
    // must cost a refusal, never a 17 GB buffer.
    if (payload > RFB_MAX_RECT_BYTES) {
      return this.desync('rect-too-large', `${width}x${height} = ${payload}b`);
    }
    if (this.q.size < 12 + payload) return null;

    this.q.drop(12);
    const pixels = this.q.take(payload);
    this.rectsLeft -= 1;
    return { type: 'rect', x, y, width, height, encoding, pixels };
  }

  private readColourMap(): RfbServerEvent | null {
    // type(1) padding(1) first-colour(2) number-of-colours(2) then 6b per entry
    if (this.q.size < 6) return null;
    const h = this.q.peek(6);
    const firstColour = h.readUInt16BE(2);
    const numColours = h.readUInt16BE(4);
    const need = 6 + numColours * 6;
    if (this.q.size < need) return null;
    this.q.drop(need);
    return { type: 'colour-map', firstColour, numColours };
  }

  private readCutText(): RfbServerEvent | null {
    // type(1) padding(3) length(4) then length bytes of Latin-1
    if (this.q.size < 8) return null;
    const length = this.q.peek(8).readUInt32BE(4);
    if (length > RFB_MAX_CUT_TEXT_BYTES) {
      return this.desync('cut-text-too-large', `${length}b`);
    }
    if (this.q.size < 8 + length) return null;
    this.q.drop(8);
    const text = this.q.take(length).toString('latin1');
    return { type: 'cut-text', text };
  }
}

/**
 * A decoder PLUS the framebuffer it composites into — the object an operator
 * actually holds. `push` returns the raw events for observability; `snapshot`
 * is the decoded screen state.
 *
 * Geometry is learned from the stream: the first Raw rectangle establishes the
 * screen (grown to cover the region), and a DesktopSize pseudo-encoding resizes
 * it. That means the relayed stream is self-describing and no out-of-band
 * ServerInit is required for the brokered case.
 */
export class RfbSession {
  readonly decoder: RfbServerDecoder;
  private screen: RfbScreen | null;
  private screenBytesPerPixel: number;

  constructor(opts: { width?: number; height?: number; bytesPerPixel?: number } = {}) {
    this.screenBytesPerPixel = opts.bytesPerPixel ?? RFB_PIXEL_FORMAT.bytesPerPixel;
    this.decoder = new RfbServerDecoder({ bytesPerPixel: this.screenBytesPerPixel });
    this.screen =
      opts.width && opts.height ? new RfbScreen(opts.width, opts.height, this.screenBytesPerPixel) : null;
  }

  get isHalted(): boolean {
    return this.decoder.isHalted;
  }

  get screenWidth(): number | null {
    return this.screen ? this.screen.width : null;
  }

  get screenHeight(): number | null {
    return this.screen ? this.screen.height : null;
  }

  /** Feed relayed bytes; returns the decoded events and applies pixels. */
  push(chunk: Buffer | Uint8Array): RfbServerEvent[] {
    const events = this.decoder.push(chunk);
    for (const ev of events) this.apply(ev);
    return events;
  }

  private apply(ev: RfbServerEvent): void {
    if (ev.type === 'desync') {
      // Keep the pixels decoded so far — a halted stream should not also blank
      // the operator's screen — but stop claiming anything new.
      return;
    }
    if (ev.type !== 'rect') return;
    try {
      if (ev.encoding === RFB_ENCODING_DESKTOP_SIZE) {
        if (this.screen) this.screen.resize(ev.width, ev.height);
        else this.screen = new RfbScreen(ev.width, ev.height, this.screenBytesPerPixel);
        return;
      }
      if (ev.encoding !== RFB_ENCODING_RAW || !ev.pixels) return;
      if (!this.screen) {
        // First rectangle defines the canvas, grown to cover it.
        this.screen = new RfbScreen(
          Math.max(1, ev.x + ev.width),
          Math.max(1, ev.y + ev.height),
          this.screenBytesPerPixel,
        );
      } else if (ev.x + ev.width > this.screen.width || ev.y + ev.height > this.screen.height) {
        // A rectangle outside the known canvas grows it rather than being lost.
        const w = Math.max(this.screen.width, ev.x + ev.width);
        const h = Math.max(this.screen.height, ev.y + ev.height);
        const grown = new RfbScreen(w, h, this.screenBytesPerPixel);
        grown.applyRaw(0, 0, this.screen.width, this.screen.height, this.screen.snapshot().pixels);
        this.screen = grown;
      }
      this.screen.applyRaw(ev.x, ev.y, ev.width, ev.height, ev.pixels);
    } catch {
      // A refused allocation (over the framebuffer ceiling) must not throw into
      // the caller; the decoder's own validation normally catches it first.
    }
  }

  snapshot(): RfbScreenSnapshot | null {
    return this.screen ? this.screen.snapshot() : null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Client→server decoding (what the DEVICE must act on)
// ─────────────────────────────────────────────────────────────────────────────

export type RfbClientEvent =
  | { type: 'key'; down: boolean; keysym: number }
  | { type: 'pointer'; buttonMask: number; x: number; y: number }
  | { type: 'update-request'; incremental: boolean; x: number; y: number; width: number; height: number }
  | { type: 'set-encodings'; encodings: number[] }
  | { type: 'set-pixel-format'; bitsPerPixel: number; bytesPerPixel: number; depth: number }
  | { type: 'cut-text'; text: string }
  | { type: 'desync'; reason: RfbDesyncReason; detail: string };

/**
 * Incremental decoder for the RFB client→server stream — what the DEVICE reads
 * to learn that the operator clicked at (x, y) or pressed a key.
 *
 * Same contracts as the server decoder: chunk boundaries are irrelevant, every
 * length is capped before it is waited for, and a malformed stream halts with a
 * `desync` event instead of throwing into the poll loop.
 */
export class RfbClientDecoder {
  private q = new ByteQueue();
  private halted = false;
  private haltReason: RfbDesyncReason | null = null;

  get isHalted(): boolean {
    return this.halted;
  }

  get haltReasonCode(): RfbDesyncReason | null {
    return this.haltReason;
  }

  get pending(): number {
    return this.q.size;
  }

  push(chunk: Buffer | Uint8Array): RfbClientEvent[] {
    const out: RfbClientEvent[] = [];
    if (this.halted) return out;
    this.q.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (this.q.size > RFB_MAX_PENDING_BYTES) {
      out.push(this.desync('pending-overflow', `buffered ${this.q.size}b`));
      return out;
    }
    for (let i = 0; i < MAX_EVENTS_PER_PUSH; i++) {
      const ev = this.step();
      if (!ev) break;
      out.push(ev);
      if (ev.type === 'desync') break;
    }
    return out;
  }

  private desync(reason: RfbDesyncReason, detail: string): RfbClientEvent {
    this.halted = true;
    this.haltReason = reason;
    this.q.clear();
    return { type: 'desync', reason, detail };
  }

  private step(): RfbClientEvent | null {
    if (this.q.size < 1) return null;
    const type = this.q.peek(1)[0];
    switch (type) {
      case RFB_CLIENT_SET_PIXEL_FORMAT: {
        // type(1) padding(3) PIXEL_FORMAT(16) = 20 bytes (RFC 6143 §7.5.1)
        if (this.q.size < 20) return null;
        const b = this.q.take(20);
        return {
          type: 'set-pixel-format',
          bitsPerPixel: b[4],
          depth: b[5],
          bytesPerPixel: b[4] / 8,
        };
      }
      case RFB_CLIENT_SET_ENCODINGS: {
        // type(1) padding(1) count(2) then count × S32
        if (this.q.size < 4) return null;
        const head = this.q.peek(4);
        const count = head.readUInt16BE(2);
        const need = 4 + count * 4;
        if (this.q.size < need) return null;
        const b = this.q.take(need);
        const encodings: number[] = [];
        for (let i = 0; i < count; i++) encodings.push(b.readInt32BE(4 + i * 4));
        return { type: 'set-encodings', encodings };
      }
      case RFB_CLIENT_FRAMEBUFFER_UPDATE_REQUEST: {
        // type(1) incremental(1) x(2) y(2) w(2) h(2) = 10 bytes
        if (this.q.size < 10) return null;
        const b = this.q.take(10);
        return {
          type: 'update-request',
          incremental: b[1] !== 0,
          x: b.readUInt16BE(2),
          y: b.readUInt16BE(4),
          width: b.readUInt16BE(6),
          height: b.readUInt16BE(8),
        };
      }
      case RFB_CLIENT_KEY_EVENT: {
        // type(1) down(1) padding(2) key(4) = 8 bytes
        if (this.q.size < 8) return null;
        const b = this.q.take(8);
        return { type: 'key', down: b[1] !== 0, keysym: b.readUInt32BE(4) };
      }
      case RFB_CLIENT_POINTER_EVENT: {
        // type(1) button-mask(1) x(2) y(2) = 6 bytes
        if (this.q.size < 6) return null;
        const b = this.q.take(6);
        return { type: 'pointer', buttonMask: b[1], x: b.readUInt16BE(2), y: b.readUInt16BE(4) };
      }
      case RFB_CLIENT_CUT_TEXT: {
        // type(1) padding(3) length(4) then Latin-1 text
        if (this.q.size < 8) return null;
        const length = this.q.peek(8).readUInt32BE(4);
        if (length > RFB_MAX_CUT_TEXT_BYTES) return this.desync('cut-text-too-large', `${length}b`);
        if (this.q.size < 8 + length) return null;
        this.q.drop(8);
        return { type: 'cut-text', text: this.q.take(length).toString('latin1') };
      }
      default:
        return this.desync('unknown-message-type', `client message type ${type}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Encoding (both directions)
// ─────────────────────────────────────────────────────────────────────────────

/** One Raw rectangle for `encodeFramebufferUpdate`: RGBA in, RFB pixels out. */
export interface RfbRawRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** `width * height * 4` bytes, RGBA order, top-to-bottom scan lines. */
  rgba: Buffer;
}

/**
 * Build real RFB 3.8 FramebufferUpdate bytes from RGBA rectangles — the DEVICE
 * side of the screen path (macOS Screen Sharing would do this itself; a Digby
 * agent that captures its own screen must produce the same bytes).
 *
 * RGBA → `RFB_PIXEL_FORMAT` requires re-ordering, not just copying: the wire
 * pixel value is `0x00RRGGBB` and the format is LITTLE-endian, so the four
 * bytes on the wire are `BB GG RR 00`.
 */
export function encodeFramebufferUpdate(rects: RfbRawRect[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(4);
  header[0] = RFB_SERVER_FRAMEBUFFER_UPDATE;
  header[1] = 0;
  header.writeUInt16BE(rects.length, 2);
  parts.push(header);

  for (const r of rects) {
    const head = Buffer.alloc(12);
    head.writeUInt16BE(r.x, 0);
    head.writeUInt16BE(r.y, 2);
    head.writeUInt16BE(r.width, 4);
    head.writeUInt16BE(r.height, 6);
    head.writeInt32BE(RFB_ENCODING_RAW, 8);
    parts.push(head);
    parts.push(rgbaToRfbPixels(r.rgba, r.width * r.height));
  }
  return Buffer.concat(parts);
}

/** RGBA (R,G,B,A) → RFB little-endian 32bpp pixels (B,G,R,0). */
export function rgbaToRfbPixels(rgba: Buffer, pixelCount: number): Buffer {
  const out = Buffer.alloc(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    const s = i * 4;
    const d = i * 4;
    out[d] = rgba[s + 2]; // blue
    out[d + 1] = rgba[s + 1]; // green
    out[d + 2] = rgba[s]; // red
    out[d + 3] = 0; // padding
  }
  return out;
}

/** RFB little-endian 32bpp pixels (B,G,R,0) → RGBA, for assertions/rendering. */
export function rfbPixelsToRgba(pixels: Buffer, pixelCount: number): Buffer {
  const out = Buffer.alloc(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    const s = i * 4;
    out[i * 4] = pixels[s + 2]; // red
    out[i * 4 + 1] = pixels[s + 1]; // green
    out[i * 4 + 2] = pixels[s]; // blue
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** A DesktopSize pseudo-rectangle: "the framebuffer is now width×height". */
export function encodeDesktopSize(width: number, height: number): Buffer {
  const b = Buffer.alloc(16);
  b[0] = RFB_SERVER_FRAMEBUFFER_UPDATE;
  b[1] = 0;
  b.writeUInt16BE(1, 2);
  b.writeUInt16BE(0, 4);
  b.writeUInt16BE(0, 6);
  b.writeUInt16BE(width, 8);
  b.writeUInt16BE(height, 10);
  b.writeInt32BE(RFB_ENCODING_DESKTOP_SIZE, 12);
  return b;
}

/** KeyEvent — RFC 6143 §7.5.4: type(4) down(1) padding(2) key(4). */
export function encodeKeyEvent(keysym: number, down: boolean): Buffer {
  const b = Buffer.alloc(8);
  b[0] = RFB_CLIENT_KEY_EVENT;
  b[1] = down ? 1 : 0;
  b.writeUInt32BE(keysym >>> 0, 4);
  return b;
}

/** PointerEvent — RFC 6143 §7.5.5: type(5) button-mask(1) x(2) y(2). */
export function encodePointerEvent(buttonMask: number, x: number, y: number): Buffer {
  const b = Buffer.alloc(6);
  b[0] = RFB_CLIENT_POINTER_EVENT;
  b[1] = buttonMask & 0xff;
  b.writeUInt16BE(x & 0xffff, 2);
  b.writeUInt16BE(y & 0xffff, 4);
  return b;
}

/** FramebufferUpdateRequest — RFC 6143 §7.5.3: 10 bytes. */
export function encodeFramebufferUpdateRequest(opts: {
  incremental: boolean;
  x?: number;
  y?: number;
  width: number;
  height: number;
}): Buffer {
  const b = Buffer.alloc(10);
  b[0] = RFB_CLIENT_FRAMEBUFFER_UPDATE_REQUEST;
  b[1] = opts.incremental ? 1 : 0;
  b.writeUInt16BE((opts.x ?? 0) & 0xffff, 2);
  b.writeUInt16BE((opts.y ?? 0) & 0xffff, 4);
  b.writeUInt16BE(opts.width & 0xffff, 6);
  b.writeUInt16BE(opts.height & 0xffff, 8);
  return b;
}

/** SetEncodings — RFC 6143 §7.5.2: type(2) padding(1) count(2) then S32 each. */
export function encodeSetEncodings(encodings: number[]): Buffer {
  const b = Buffer.alloc(4 + encodings.length * 4);
  b[0] = RFB_CLIENT_SET_ENCODINGS;
  b[1] = 0;
  b.writeUInt16BE(encodings.length, 2);
  encodings.forEach((e, i) => b.writeInt32BE(e, 4 + i * 4));
  return b;
}

/** ClientCutText — RFC 6143 §7.5.6 (Latin-1 only, by the protocol). */
export function encodeClientCutText(text: string): Buffer {
  const body = Buffer.from(text, 'latin1');
  const b = Buffer.alloc(8 + body.length);
  b[0] = RFB_CLIENT_CUT_TEXT;
  b.writeUInt32BE(body.length, 4);
  body.copy(b, 8);
  return b;
}

// ─────────────────────────────────────────────────────────────────────────────
// Relay chunking — how a 4 MB update crosses a 64 KiB pipe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split one RFB byte stream into relay-sized base64 payloads, in order.
 *
 * This is the function that makes the data plane's frame ceiling irrelevant to
 * the codec: the receiver is a STREAM decoder, so any split is valid and the
 * concatenation of these payloads is byte-identical to the input. An empty
 * input yields no chunks (rather than one empty chunk, which the backend would
 * refuse as `malformed` and which would look like a dead session).
 */
export function chunkForRelay(bytes: Buffer, maxBytes: number = RFB_RELAY_FRAME_BYTES): string[] {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new RangeError(`chunkForRelay: maxBytes must be positive, got ${maxBytes}`);
  }
  const out: string[] = [];
  for (let off = 0; off < bytes.length; off += maxBytes) {
    out.push(bytes.subarray(off, Math.min(off + maxBytes, bytes.length)).toString('base64'));
  }
  return out;
}

/** Concatenate relay payloads back into the byte stream they carry. */
export function joinRelayChunks(chunks: string[]): Buffer {
  return Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64')));
}
/**
 * OPERATOR-SIDE RENDERER over the relay (ticket c468f922).
 *
 * ── WHAT WAS MISSING, AND WHY THIS FILE EXISTS ──────────────────────────────
 * After #2303/#2305 the relay CARRIES bytes, and after #2312/#2314 the device
 * ENCODES a real screen into them. Both ends of the wire existed. What did not
 * exist is the thing the operator is supposed to be looking at: the decoder
 * that turns carried bytes back into a screen, and the encoder that turns an
 * operator's click into carried bytes.
 *
 * The only object that decoded a screen was `RelayViewer`, and it lives in
 * `imessage-agent/src/relay-session.ts` — the DEVICE's tree, the codebase that
 * ships to a Mac. Its sole instantiation anywhere in the repo was the backend
 * e2e suite (`relay-codec.e2e.c468f922.test.ts:377,477`). So the operator had a
 * transport with a peer made of assertions: the same "requirement no live
 * surface satisfies" defect this ticket keeps re-learning (brokered-session
 * D1 → the relay had no client → the codec had no renderer), now one layer up
 * again.
 *
 * This module is the operator's half, in the tree that actually serves the
 * operator request.
 *
 * ── WHY THIS IS A SECOND IMPLEMENTATION, AND WHY THAT IS SAFE ───────────────
 * The backend cannot import `imessage-agent/src/*.ts` at runtime: the agent is
 * a standalone tarball with no backend in it, and reaching across that boundary
 * would couple a deploy on the server to the source layout of a client that is
 * installed on other people's Macs. So the wire constants are duplicated here —
 * exactly as `rfb-codec.ts` already duplicates `RELAY_MAX_FRAME_BYTES` from
 * `relay-dataplane.ts`.
 *
 * Duplication is only safe when drift is LOUD. `relay-operator-viewer.test.ts`
 * loads the REAL agent codec, encodes a screen and an input event with it, and
 * requires THIS module to decode them byte-identically — in both directions. A
 * drifted constant, byte order or framing choice fails that test instead of
 * showing the operator a scrambled screen in the field.
 *
 * ── SCOPE (honest) ──────────────────────────────────────────────────────────
 * IMPLEMENTED: RFB 3.8 server→client FramebufferUpdate with Raw rectangles,
 * **CopyRect (§7.7.2), Hextile (§7.7.4) and the LastRect pre-RFC extension**,
 * and the DesktopSize pseudo-encoding; Bell; ServerCutText; ColourMap (consumed
 * and reported, never applied — we only ever ask for true colour).
 * Client→server PointerEvent and KeyEvent encoding. Anything else (RRE, TRLE,
 * ZRLE, Tight, zlib) HALTS the decoder instead of guessing: an RFB stream with
 * no message framing cannot be resynchronised, and emitting plausible-looking
 * garbage into a live screen is worse than a visible refusal.
 *
 * Both ceilings are checked: the WIRE size of a rect (`MAX_RECT_BYTES`) and its
 * DECODED size (`MAX_FRAMEBUFFER_BYTES`). Hextile is the encoding where those
 * two numbers differ by two orders of magnitude — a 0.67 MB tile stream decodes
 * to 137 MB — so bounding only the payload would let a small frame force a huge
 * allocation.
 *
 * ── THE PRODUCER, WHICH THIS MODULE DOES NOT CONTAIN ───────────────────────
 * A decoder with no producer is dead code, and that is precisely what the
 * post-merge review of PR #2341 found. The producer now lives in
 * `windows-agent/src/rfb-client.ts` + `relay-rfb.ts`: a real RFB client that
 * performs the §7.1 handshake, ADVERTISES these encodings (§7.5.2 — a server
 * only sends what the client listed, so Hextile/LastRect were unreachable
 * before it), requests a frame (§7.5.1), and explains WHY it must exist before
 * commenting on either half.
 *
 * NOT CLAIMED HERE: that a physical Mac or PC drives this on hardware. The
 * device e2e (criteria 1 and 3) stays parked per the supervisor's steer;
 * nothing in this file implies it.
 */

import { createHash } from 'crypto';
import { constants as zlibConstants, deflateSync, inflateRawSync, inflateSync } from 'zlib';

// ─────────────────────────────────────────────────────────────────────────────
// The wire, as this side of the relay speaks it
// ─────────────────────────────────────────────────────────────────────────────

/** RFB 3.8 message types (RFC 6143 §7). Mirrors `imessage-agent/src/rfb-codec.ts`. */
export const OPERATOR_RFB_SERVER_FRAMEBUFFER_UPDATE = 0;
export const OPERATOR_RFB_SERVER_SET_COLOUR_MAP_ENTRIES = 1;
export const OPERATOR_RFB_SERVER_BELL = 2;
export const OPERATOR_RFB_SERVER_CUT_TEXT = 3;

export const OPERATOR_RFB_CLIENT_SET_ENCODINGS = 2;
export const OPERATOR_RFB_CLIENT_FRAMEBUFFER_UPDATE_REQUEST = 3;
export const OPERATOR_RFB_CLIENT_KEY_EVENT = 4;
export const OPERATOR_RFB_CLIENT_POINTER_EVENT = 5;
export const OPERATOR_RFB_CLIENT_CUT_TEXT = 6;

export const OPERATOR_RFB_ENCODING_RAW = 0;
export const OPERATOR_RFB_ENCODING_COPY_RECT = 1;
export const OPERATOR_RFB_ENCODING_HEXTILE = 5;
/**
 * Tight (RFC 6143 §7.7.3 / rfbproto "Tight Encoding").
 *
 * ── WHY THIS IS THE ENCODING THAT DECIDES WHETHER A REAL HOST WORKS ────────
 * TightVNC and TigerVNC both PREFER Tight: §7.5.2 lets a server choose from the
 * client's list, and both take the first normal encoding they support. So a
 * host that supports Tight and Hextile is ordered to send Hextile only because
 * we listed Hextile first — but a host that supports ONLY Tight (or is
 * configured to force it, `-encoding tight`) answered our previous
 * advertisement with a rect we refused as `unsupported-encoding`, and the
 * operator saw an undecodable stream instead of a desktop.
 */
export const OPERATOR_RFB_ENCODING_TIGHT = 7;
/**
 * Encodings this decoder DOES NOT implement, named so the refusal path and its
 * tests can refer to them without magic numbers. RRE(2), TRLE(16) and ZRLE(17)
 * each size their payload by a rule nothing here walks, so a rect using one is
 * refused rather than guessed — the fail-loud property, stated in terms of the
 * encodings that still lack a decoder.
 */
export const OPERATOR_RFB_ENCODING_RRE = 2;
export const OPERATOR_RFB_ENCODING_TRLE = 16;
export const OPERATOR_RFB_ENCODING_ZRLE = 17;
export const OPERATOR_RFB_ENCODING_DESKTOP_SIZE = -223;
/**
 * LastRect pseudo-encoding (a widespread pre-RFC extension, not in RFC 6143).
 *
 * A server that supports it declares `number-of-rectangles = 0xFFFF` and then
 * emits rectangles until one arrives carrying this encoding — that rect IS the
 * end-of-update marker and has no payload.
 *
 * ── WHY A DECODER THAT IGNORES THIS CANNOT TALK TO TIGERVNC ─────────────────
 * TigerVNC's server takes exactly this path (`EncodeManager::doUpdate` writes
 * `nRects = 0xFFFF` when the viewer advertised LastRect), including for the
 * initial full refresh. Without it the rect count is unknowable, so the message
 * length is unknowable, so every Windows update would be refused as an
 * undecodable stream — a decoder that passes every fixture and fails on the
 * first real Windows host.
 */
export const OPERATOR_RFB_ENCODING_LAST_RECT = -224;
/** The sentinel `number-of-rectangles` value that LastRect replaces (§7.6.1 + ext). */
export const OPERATOR_RFB_RECT_COUNT_LASTRECT = 0xffff;

/**
 * Hextile subencoding-mask bits, RFC 6143 §7.7.4. Named rather than inlined
 * because the mask is a bitfield and `mask & 8` is exactly the kind of magic
 * number that reads as a typo three months later.
 */
export const OPERATOR_HEXTILE_RAW = 1;
export const OPERATOR_HEXTILE_BACKGROUND_SPECIFIED = 2;
export const OPERATOR_HEXTILE_FOREGROUND_SPECIFIED = 4;
export const OPERATOR_HEXTILE_ANY_SUBRECTS = 8;
export const OPERATOR_HEXTILE_SUBRECTS_COLOURED = 16;

/** Hextile tiles are a fixed 16x16, with a clipped final row/column (§7.7.4). */
export const OPERATOR_HEXTILE_TILE = 16;

// ── Tight (rfbproto "Tight Encoding") ──────────────────────────────────────

/**
 * Filter ids carried when the compression-control byte's *read-filter-id* bit
 * (bit 6) is set. The filter is a PRE-PROCESSOR applied before zlib, so getting
 * the id wrong does not fail — it silently yields a plausible-looking image
 * computed from the wrong transform, which is the worst failure shape.
 */
export const OPERATOR_TIGHT_FILTER_COPY = 0;
export const OPERATOR_TIGHT_FILTER_PALETTE = 1;
export const OPERATOR_TIGHT_FILTER_GRADIENT = 2;

/**
 * A ``TPIXEL`` is 3 bytes — R, G, B — *only* when bits-per-pixel is 32, depth
 * is 24 and all three intensities are exactly 8 bits wide; otherwise it is the
 * agreed ``PIXEL`` (4 bytes here).
 *
 * Our client never sends SetPixelFormat (it accepts the host's), so the 3-byte
 * form is an ASSUMPTION about what the server chose, not a guarantee. It is
 * checked against the real ServerInit in the wild path and against the fixture
 * in tests; a format that is not the 3-byte case is refused rather than decoded
 * with the wrong stride. See `resolveTightPixelBytes`.
 */
export const OPERATOR_TIGHT_TPIXEL_BYTES = 3;

/**
 * Below this many filtered bytes the spec says the data is sent UNCOMPRESSED
 * and with NO compact length in front of it ("if the data size after applying
 * the filter but before the compression is less then 12, then the data is sent
 * as is"). The whole framing of a Tight rect hinges on this constant: get it
 * wrong and every following byte lands at the wrong offset.
 */
export const OPERATOR_TIGHT_MIN_COMPRESSED = 12;

/** A compact length is 1-3 bytes; the 3-byte form tops out at 2^22-1. */
export const OPERATOR_TIGHT_MAX_COMPACT_BYTES = 3;
export const OPERATOR_TIGHT_MAX_DATA_BYTES = 0x3fffff;

/**
 * zlib keeps a 32 KiB history window. A Tight stream PERSISTS across
 * rectangles, so a later rectangle's zlib data may back-reference output the
 * decoder produced for an earlier one — continuation therefore needs the
 * previous decompressed output as the dictionary. Measured: a naive per-rect
 * inflate of a real continuation throws `Z_DATA_ERROR incorrect header check`,
 * and the same bytes decode EXACTLY (verified byte-for-byte) when handed the
 * prior 32 KiB.
 */
const OPERATOR_TIGHT_ZLIB_WINDOW = 32768;

/**
 * The pixel format both ends declare: 32bpp true colour, little-endian, which
 * on the wire is the byte order `BB GG RR 00` (RFC 6143 §7.6.2). Duplicated
 * from the agent codec on purpose — see the conformance note above.
 */
export const OPERATOR_RFB_BYTES_PER_PIXEL = 4;

/**
 * The largest a single Hextile tile can possibly be on the wire, used to bound
 * the buffer a tile parse is allowed to look at.
 *
 * Worst case is a coloured-subrect tile: mask(1) + background(4) + foreground(4)
 * + subrect-count(1) + 255 subrects of (colour 4 + pos 1 + size 1). That is
 * 1540 bytes for a 256-pixel tile whose raw form would be 1024 — i.e. Hextile
 * can be BIGGER than Raw on pathological input, which is why the bound is
 * computed from the framing rather than assumed to be ≤ raw.
 */
const OPERATOR_HEXTILE_MAX_TILE_BYTES =
  1 + 2 * OPERATOR_RFB_BYTES_PER_PIXEL + 1 + 255 * (OPERATOR_RFB_BYTES_PER_PIXEL + 2);

/** Bounds. A header claiming 65535×65535 must cost a refusal, never a buffer. */
export const OPERATOR_RFB_MAX_RECT_BYTES = 64 * 1024 * 1024;
export const OPERATOR_RFB_MAX_FRAMEBUFFER_BYTES = 128 * 1024 * 1024;
export const OPERATOR_RFB_MAX_CUT_TEXT_BYTES = 1024 * 1024;
export const OPERATOR_RFB_MAX_PENDING_BYTES = OPERATOR_RFB_MAX_RECT_BYTES + 8 * 64 * 1024;

/** Bound on how many complete messages one push may decode (a hostile loop). */
const MAX_EVENTS_PER_PUSH = 4096;

export type OperatorDesyncReason =
  | 'unknown-message-type'
  | 'unsupported-encoding'
  | 'rect-too-large'
  | 'framebuffer-too-large'
  | 'cut-text-too-large'
  | 'pending-overflow'
  | 'bad-dimensions'
  | 'bad-hextile'
  | 'bad-tight';

/** One decoded server→client message. */
export type OperatorServerEvent =
  | { type: 'update-begin'; numRects: number }
  | {
      type: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      encoding: number;
      /** Wire-order pixels (BB GG RR 00); null for pseudo-encodings and CopyRect. */
      pixels: Buffer | null;
      /** CopyRect only: the framebuffer coordinate to copy FROM (§7.7.2). */
      copySrcX?: number;
      copySrcY?: number;
    }
  | { type: 'bell' }
  | { type: 'cut-text'; text: string }
  | { type: 'colour-map'; firstColour: number; numColours: number }
  | { type: 'desync'; reason: OperatorDesyncReason; detail: string };

/** Update header: type(1) padding(1) number-of-rectangles(2). RFC 6143 §7.6.1. */
const OPERATOR_UPDATE_HEADER_BYTES = 4;
/** One rectangle header: x(2) y(2) w(2) h(2) encoding(4). RFC 6143 §7.6.1. */
const OPERATOR_RECT_HEADER_BYTES = 12;

/**
 * A sane ceiling on rectangles per update. RFC 6143 allows up to 65535, but a
 * decoder that walks a hostile 65535-rect header while looking for a message
 * boundary is doing 65535 parses on the strength of four attacker-chosen bytes.
 * Windows VNC servers send a handful of dirty rects; 4096 is generous and keeps
 * the walk bounded.
 */
export const OPERATOR_MAX_RECTS_PER_UPDATE = 4096;

/**
 * What one rectangle's framing tells us, given however many bytes we hold.
 *
 * `totalBytes` is the rect INCLUDING its 12-byte header, or `null` when the
 * answer needs bytes we do not have (a Hextile payload's length is only knowable
 * by walking its tiles, so a truncated one is genuinely undecidable rather than
 * merely unknown — see `hextilePayloadBytes`).
 */
export interface OperatorRectShape {
  x: number;
  y: number;
  width: number;
  height: number;
  encoding: number;
  payloadBytes: number | null;
  totalBytes: number | null;
}

/** The whole framing of one FramebufferUpdate, as far as the bytes allow. */
export interface OperatorUpdateShape {
  /** Does this really look like the head of a FramebufferUpdate? */
  isUpdate: boolean;
  /** Declared rect count; `OPERATOR_RFB_RECT_COUNT_LASTRECT` when LastRect-terminated. */
  numRects: number;
  /**
   * Is the message SELF-DELIMITING — can its total length be derived from the
   * bytes supplied?
   *
   * Deliberately NOT "are those bytes all present here". A 1920×1200 Raw rect
   * is 9.2 MB and arrives across ~141 relay frames, so a single 64 KiB chunk can
   * never hold one; requiring presence would make every real screen look
   * incomplete. Presence is the CALLER's question, answered by comparing
   * `totalBytes` against the bytes it actually holds
   * (`operatorFrameCompletesUpdate` does exactly that).
   */
  complete: boolean;
  /** Total message length, or null when undecidable from the bytes supplied. */
  totalBytes: number | null;
  /** Was this update terminated by a LastRect marker rather than a count? */
  usedLastRect: boolean;
  /**
   * Is this update SELF-CONTAINED — exactly one Raw rectangle anchored at the
   * origin? That is the only shape for which "this update alone is a whole
   * picture" is true.
   *
   * ── THIS IS NOT THE SAME AS "a full refresh" (Windows slice, 2026-11-02) ───
   * TigerVNC's server splits every rectangle larger than 65536 px² or wider than
   * 2048 px, so a 1920×1080 *initial full refresh* leaves as ~32 rects of
   * 1920×34 — summary on the wire identical in shape to 32 dirty rects. There is
   * no framebuffer size on this wire to compare a union against (no ServerInit
   * on the brokered path), so "does this update cover the whole screen?" is NOT
   * decidable from the message alone.
   *
   * That is why the caller reasons about the stream rather than one message: a
   * window in which EVERY update is self-contained is a `sendScreen` stream,
   * where skipping to the newest is safe. Anything else is delta-coded, and the
   * only correct base is the oldest message the window actually holds.
   */
  fullFrame: boolean;
}

/** Read one rect header's framing without needing its payload present. */
function rectEncodingAt(buf: Buffer, off: number, limit: number): number | null {
  if (off + OPERATOR_RECT_HEADER_BYTES > limit) return null;
  return buf.readInt32BE(off + 8);
}

/**
 * The encoding of the FIRST rectangle of the update starting at `start`.
 *
 * Exported so the window scan can tell "a DesktopSize pseudo-rect that is
 * followed by the real update" (one buffer, two messages) from a real message —
 * the shape `sendScreen` emits on a geometry change.
 */
export function operatorFirstRectEncoding(
  buf: Buffer,
  start: number,
  limit: number,
): number | null {
  return rectEncodingAt(buf, start + OPERATOR_UPDATE_HEADER_BYTES, limit);
}

/** A message with no payload at all: 4-byte update header + 12-byte rect header. */
export const OPERATOR_EMPTY_UPDATE_BYTES = OPERATOR_UPDATE_HEADER_BYTES + OPERATOR_RECT_HEADER_BYTES;

/**
 * Walk a Hextile payload (RFC 6143 §7.7.4) and return its byte length.
 *
 * Returns `null` when the decision needs bytes past `limit` — the honest answer
 * for a payload whose tiles have not arrived yet. Hextile is NOT arithmetically
 * sized the way Raw is: its length is a function of the subencoding masks the
 * server chose, so it can only be found by walking the tiles in order.
 *
 * The walk is bounded twice over: tiles are fixed 16x16 so the tile COUNT is
 * known from the rect geometry alone, and each tile's size is bounded by
 * `OPERATOR_HEXTILE_MAX_TILE_BYTES`.
 */
function hextilePayloadBytes(
  buf: Buffer,
  start: number,
  limit: number,
  width: number,
  height: number,
): number | null {
  const bpp = OPERATOR_RFB_BYTES_PER_PIXEL;
  let p = start;
  const need = (n: number): boolean => p + n <= limit;

  for (let ty = 0; ty < height; ty += OPERATOR_HEXTILE_TILE) {
    const th = Math.min(OPERATOR_HEXTILE_TILE, height - ty);
    for (let tx = 0; tx < width; tx += OPERATOR_HEXTILE_TILE) {
      const tw = Math.min(OPERATOR_HEXTILE_TILE, width - tx);
      if (!need(1)) return null;
      const mask = buf[p];
      p += 1;

      if (mask & OPERATOR_HEXTILE_RAW) {
        // A Raw tile is w*h pixel values and nothing else — the mask IS its
        // whole header, so there is no subrect count to read.
        const raw = tw * th * bpp;
        if (!need(raw)) return null;
        p += raw;
        continue;
      }

      // §7.7.4: the FIRST non-raw tile of a rectangle must specify a
      // background. A stream that carries over from a tile that never set one
      // would paint an undefined colour, so it is refused rather than guessed.
      if (mask & OPERATOR_HEXTILE_BACKGROUND_SPECIFIED) {
        if (!need(bpp)) return null;
        p += bpp;
      }
      if (mask & OPERATOR_HEXTILE_FOREGROUND_SPECIFIED) {
        if (!need(bpp)) return null;
        p += bpp;
      }
      if (mask & OPERATOR_HEXTILE_ANY_SUBRECTS) {
        if (!need(1)) return null;
        const count = buf[p];
        p += 1;
        // A coloured subrect carries its own pixel value; an uncoloured one
        // uses the tile foreground. Both then carry position+size (2 bytes).
        const perSub = (mask & OPERATOR_HEXTILE_SUBRECTS_COLOURED ? bpp : 0) + 2;
        const subBytes = count * perSub;
        if (!need(subBytes)) return null;
        p += subBytes;
      }
      // AnySubrects clear ⇒ a solid background tile, nothing further to read.
    }
  }
  return p - start;
}

/** Read one rect header at `off`, or null if the header itself does not fit. */
function readRectShape(buf: Buffer, off: number, limit: number): OperatorRectShape | null {
  if (off + OPERATOR_RECT_HEADER_BYTES > limit) return null;
  const x = buf.readUInt16BE(off);
  const y = buf.readUInt16BE(off + 2);
  const width = buf.readUInt16BE(off + 4);
  const height = buf.readUInt16BE(off + 6);
  const encoding = buf.readInt32BE(off + 8);
  const payloadAt = off + OPERATOR_RECT_HEADER_BYTES;

  let payloadBytes: number | null;
  switch (encoding) {
    case OPERATOR_RFB_ENCODING_DESKTOP_SIZE:
      // A pseudo-encoding: the header IS the whole rect, no payload at all.
      payloadBytes = 0;
      break;
    case OPERATOR_RFB_ENCODING_LAST_RECT:
      // The end-of-update marker: header only, and it terminates the list.
      payloadBytes = 0;
      break;
    case OPERATOR_RFB_ENCODING_RAW:
      if (!isValidDimension(width) || !isValidDimension(height)) return null;
      payloadBytes = width * height * OPERATOR_RFB_BYTES_PER_PIXEL;
      break;
    case OPERATOR_RFB_ENCODING_COPY_RECT:
      // §7.7.2: the payload is just the source coordinate.
      payloadBytes = 4;
      break;
    case OPERATOR_RFB_ENCODING_HEXTILE:
      if (!isValidDimension(width) || !isValidDimension(height)) return null;
      payloadBytes = hextilePayloadBytes(buf, payloadAt, limit, width, height);
      break;
    case OPERATOR_RFB_ENCODING_TIGHT: {
      // Unlike Hextile, a Tight payload's length IS derivable from its header:
      // the filter and geometry determine the filtered size exactly, and the
      // compressed block is length-prefixed. That is what makes a real
      // TightVNC update findable by the boundary scan at all.
      if (!isValidDimension(width) || !isValidDimension(height)) return null;
      const framed = tightPayloadBytes(buf, payloadAt, limit, width, height);
      if (framed.kind !== 'ok') {
        payloadBytes = null;
        break;
      }
      // The framing says how long the rect IS; this says whether it is HERE.
      // Returning a total for bytes we do not hold would let the scan call a
      // half-arrived screen COMPLETE — the D1 lie, one encoding over.
      payloadBytes = payloadAt + framed.bytes <= limit ? framed.bytes : null;
      break;
    }
    default:
      // An encoding whose framing we do not know makes every later byte
      // unattributable — that is a refusal, never a guess.
      payloadBytes = null;
      break;
  }

  return {
    x,
    y,
    width,
    height,
    encoding,
    payloadBytes,
    totalBytes: payloadBytes === null ? null : OPERATOR_RECT_HEADER_BYTES + payloadBytes,
  };
}

/**
 * Frame one candidate FramebufferUpdate starting at `start` and report what it
 * is, using at most `limit` bytes of `buf`.
 *
 * ── WHY THIS REPLACED A ONE-RECTANGLE PREDICATE (2026-11-02, Windows slice) ──
 * The first cut assumed the only producer was `sendScreen`: ONE rectangle,
 * anchored at the origin, Raw-encoded. That is a correct description of OUR
 * device stream and a wrong description of a Windows VNC server, which answers
 * an incremental update request with N small rectangles covering only the DIRTY
 * regions — frequently Hextile- or CopyRect-encoded. Against that stream the old
 * predicate returned false for every real update, so the boundary scan found no
 * screen at all: `renderFrames` fell through to `no-coherent-message` and the
 * operator was told a live Windows desktop was an undecodable stream.
 *
 * Two facts make the general case decidable without guessing:
 *   - every rect header is a fixed 12 bytes, so the rect COUNT is read, not
 *     guessed;
 *   - Raw, CopyRect and DesktopSize payloads are arithmetically sized, and a
 *     Hextile payload is walkable, so "does the whole message fit?" is a real
 *     answer rather than an estimate.
 * Anything else still yields `complete: false`, which the caller reports as a
 * refusal — the fail-loud property is unchanged.
 */
export function operatorUpdateShape(buf: Buffer, start: number, limit: number): OperatorUpdateShape {
  const none: OperatorUpdateShape = {
    isUpdate: false,
    numRects: 0,
    complete: false,
    totalBytes: null,
    usedLastRect: false,
    fullFrame: false,
  };
  if (start + OPERATOR_UPDATE_HEADER_BYTES > limit) return none;
  if (buf[start] !== OPERATOR_RFB_SERVER_FRAMEBUFFER_UPDATE) return none;
  // RFC 6143 §7.6.1: the second byte is padding and carries no meaning.
  if (buf[start + 1] !== 0) return none;

  const declared = buf.readUInt16BE(start + 2);
  const lastRectMode = declared === OPERATOR_RFB_RECT_COUNT_LASTRECT;
  // A declared count of 0 is not a valid update (there is nothing to draw), and
  // a count above the ceiling is a hostile header rather than a real message.
  if (!lastRectMode && (declared < 1 || declared > OPERATOR_MAX_RECTS_PER_UPDATE)) return none;

  let p = start + OPERATOR_UPDATE_HEADER_BYTES;
  let first: OperatorRectShape | null = null;
  let seen = 0;

  for (;;) {
    if (!lastRectMode && seen >= declared) break;
    // LastRect mode is bounded by the same ceiling: a server that never emits
    // the marker must not walk us forever.
    if (lastRectMode && seen >= OPERATOR_MAX_RECTS_PER_UPDATE) return none;

    const encoding = rectEncodingAt(buf, p, limit);
    if (encoding === null) {
      // The next header has not arrived; not provably complete.
      return { isUpdate: true, numRects: declared, complete: false, totalBytes: null, usedLastRect: lastRectMode, fullFrame: false };
    }

    const rect = readRectShape(buf, p, limit);
    if (!rect || rect.totalBytes === null) {
      // Either the header/payload has not arrived, or the encoding is one whose
      // length we cannot derive. Both mean "not provably complete".
      return { isUpdate: true, numRects: declared, complete: false, totalBytes: null, usedLastRect: lastRectMode, fullFrame: false };
    }
    if (first === null) first = rect;
    seen += 1;
    p += rect.totalBytes;

    if (encoding === OPERATOR_RFB_ENCODING_LAST_RECT) {
      // The marker consumes its own 12-byte header and ends the update.
      return {
        isUpdate: true,
        numRects: declared,
        complete: true,
        totalBytes: p - start,
        usedLastRect: true,
        fullFrame: isSelfContained(first, seen),
      };
    }
  }

  return {
    isUpdate: true,
    numRects: declared,
    complete: true,
    totalBytes: p - start,
    usedLastRect: false,
    fullFrame: isSelfContained(first, seen),
  };
}

/**
 * Is an update a WHOLE picture on its own — one Raw rectangle anchored at the
 * origin, no LastRect marker, no pseudo-rect?
 *
 * This is `sendScreen`'s shape. It is deliberately NOT "covers the whole screen":
 * with no ServerInit on the brokered path there is no framebuffer size to compare
 * a union of rects against, and TigerVNC splits a genuine full refresh into dozens
 * of rects anyway. So the honest question is "is this self-contained?", and the
 * caller uses the answer to decide whether it may skip to the newest update or
 * must replay forward from a base.
 */
function isSelfContained(first: OperatorRectShape | null, rectCount: number): boolean {
  return (
    rectCount === 1 &&
    first !== null &&
    first.encoding === OPERATOR_RFB_ENCODING_RAW &&
    first.x === 0 &&
    first.y === 0
  );
}

/**
 * Does this frame look like the FIRST chunk of an update message?
 *
 * ── WHAT THIS IS FOR (audit D1, 2026-11-02) ─────────────────────────────────
 * The relay queue refuses pushes once it holds `RELAY_QUEUE_MAX_FRAMES`, and it
 * never trims its head on the write side. So a device streaming two screens with
 * no consumer leaves the queue holding the FIRST 256 frames: screen A complete,
 * screen B cut off part-way. Measured at 1920x1200 (the real numbers): one
 * screen is 141 frames, two are 282, so 26 frames of B are refused — and they
 * are refused AGAIN on every retry, forever, because nothing ever frees a slot.
 * The operator sees A for all time, and the route reported it as COMPLETE
 * (`partial: false`, because the window genuinely began at seq 1).
 *
 * `sendScreen` always starts chunking at byte 0 of a screen's own buffer, so a
 * message start is always at a FRAME boundary. That is what makes a boundary
 * findable in an arbitrary window without guessing — a predicate is only ever
 * asked about bytes at an index where a message could begin.
 */
export function operatorFrameStartsUpdate(bytes: Buffer): boolean {
  /**
   * ── DELIBERATELY STRICT (and why loosening it broke D1, 2026-11-02) ───────
   * This predicate is asked about EVERY frame in a window, including frames that
   * are pure continuation bytes of a screen's pixel payload. Pixels are
   * arbitrary, so a permissive predicate manufactures message starts inside an
   * image: a CopyRect rect is only 16 bytes, so `00 00 00 01` plus a plausible
   * header inside a truncated screen's payload parsed as a COMPLETE little
   * message. The scan then adopted that as the newest update and reported a
   * half-delivered screen as `partial: false` — the exact #2331 lie, one
   * encoding wider.
   *
   * The shape below is the one `sendScreen` emits and it is narrow enough that
   * pixel data does not present it by accident: exactly one rectangle, anchored
   * at the origin, Raw (or a bare DesktopSize), with sane dimensions. Detection
   * of a Windows full refresh does NOT need a looser rule here — a delta-coded
   * stream is anchored at the window start and replayed forward (see
   * `renderFrames`), which needs no boundary at all.
   */
  if (bytes.length < 16) return false;
  if (bytes[0] !== OPERATOR_RFB_SERVER_FRAMEBUFFER_UPDATE) return false;
  if (bytes[1] !== 0) return false;
  if (bytes.readUInt16BE(2) !== 1) return false;
  const x = bytes.readUInt16BE(4);
  const y = bytes.readUInt16BE(6);
  const width = bytes.readUInt16BE(8);
  const height = bytes.readUInt16BE(10);
  if (x !== 0 || y !== 0) return false;
  const encoding = bytes.readInt32BE(12);
  if (encoding === OPERATOR_RFB_ENCODING_DESKTOP_SIZE) return true;
  if (encoding !== OPERATOR_RFB_ENCODING_RAW) return false;
  return isValidDimension(width) && isValidDimension(height);
}

/**
 * Does the whole message that starts in `bytes` fit inside `bytesRemaining`?
 *
 * A start whose declared payload runs past the end of the retained window is a
 * screen the device was still sending when the queue filled: the frames exist
 * on the device and will be retried, but they are not here yet. Reporting that
 * as a complete screen is exactly the D1 lie.
 *
 * ── THE DesktopSize PREFIX (this is why the arithmetic is not just 16 + w*h*4) ──
 * On a geometry change `sendScreen` emits the DesktopSize pseudo-rect FIRST and
 * then the Raw update, concatenated into ONE buffer before chunking. So such a
 * screen's first chunk begins with a 16-byte message that trivially "fits" —
 * and a predicate that stopped there would call a HALF-SENT screen complete,
 * which is the very bug this function exists to prevent. When the start is a
 * DesktopSize, the screen's real weight is the pseudo-rect PLUS the update that
 * follows it at the geometry the pseudo-rect just declared.
 *
 * That two-message concatenation is still accounted for: the tail of the buffer
 * begins a NEW update header, and `operatorScreenWindowShape` walks it. This
 * wrapper answers the single-message question only, and the caller that needs
 * the concatenated answer uses the window walker.
 */
export function operatorFrameCompletesUpdate(bytes: Buffer, bytesRemaining: number): boolean {
  const shape = operatorUpdateShape(bytes, 0, bytes.length);
  if (!shape.isUpdate) return false;
  if (!shape.complete || shape.totalBytes === null) return false;
  if (shape.totalBytes > bytesRemaining) return false;
  // The DesktopSize-prefix case: a pseudo-rect must be followed by the update it
  // announced, and that update's bytes count toward the screen's weight.
  const first = readRectShape(bytes, OPERATOR_UPDATE_HEADER_BYTES, bytes.length);
  if (first && first.encoding === OPERATOR_RFB_ENCODING_DESKTOP_SIZE) {
    const next = operatorUpdateShape(bytes, shape.totalBytes, bytes.length);
    if (!next.isUpdate) return false; // announced an update that is not there
    if (!next.complete || next.totalBytes === null) return false;
    const needed = shape.totalBytes + next.totalBytes;
    // The declared geometry is the size of the pixels that follow; a next-update
    // that is smaller than that is still in flight.
    const declared = 16 + first.width * first.height * OPERATOR_RFB_BYTES_PER_PIXEL;
    return needed >= declared && needed <= bytesRemaining;
  }
  return true;
}

/**
 * The rendered screen, or null before any geometry has arrived.
 */
export interface OperatorScreenSnapshot {
  width: number;
  height: number;
  /** RGBA, top-to-bottom scan lines — what a canvas/PNG wants. */
  rgba: Buffer;
  /** sha256 of `rgba` — cheap identity for "did the screen change". */
  sha256: string;
  /** How many Raw rectangles have been composited into this framebuffer. */
  rectsApplied: number;
}

function isValidDimension(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 0xffff;
}

/**
 * A growable byte queue.
 *
 * `peek(n)` copies only what it needs and `take(n)` copies once; the previous
 * chunk list is dropped as it is consumed. This is the hot path for a stream
 * that decodes a few megabytes per screen, so it avoids `Buffer.concat` on
 * every message.
 */
class OperatorByteQueue {
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

  /** Consume `n` bytes and return them. */
  take(n: number): Buffer {
    const want = Math.min(n, this.total);
    const out = Buffer.allocUnsafe(want);
    let off = 0;
    while (off < want) {
      const c = this.chunks[0];
      const avail = c.length - this.head;
      if (avail <= 0) {
        this.chunks.shift();
        this.head = 0;
        continue;
      }
      const take = Math.min(avail, want - off);
      c.copy(out, off, this.head, this.head + take);
      off += take;
      this.head += take;
      if (this.head >= c.length) {
        this.chunks.shift();
        this.head = 0;
      }
    }
    this.total -= want;
    if (this.total === 0) {
      this.chunks = [];
      this.head = 0;
    }
    return out;
  }

  drop(n: number): void {
    this.take(n);
  }

  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.total = 0;
  }
}

/**
 * Decode a Hextile payload (RFC 6143 §7.7.4) into WIRE-ORDER pixels
 * (`BB GG RR 00`), so every encoding composites through ONE code path.
 *
 * Returns `null` on a malformed tile stream — a bad mask combination, a
 * payload that runs out mid-tile, or a subrect with no colour to paint it.
 * Returning null (rather than throwing) is what lets the caller turn it into a
 * `bad-hextile` desync instead of killing the pump.
 *
 * ── THE CARRY-OVER RULES ARE THE WHOLE RISK HERE ────────────────────────────
 * Hextile is delta-coded ACROSS tiles: a tile may omit its background or
 * foreground and reuse the previous tile's. §7.7.4 puts two hard limits on
 * that, and getting them wrong paints whole tiles in a neighbour's colour —
 * a wrong picture, which is far worse than a refusal:
 *   - a RAW tile clears both (its pixels are literal, so nothing carries);
 *   - a Coloured-subrect tile clears the FOREGROUND (each subrect brings its
 *     own), and §7.7.4 also forbids specifying both at once.
 * Anywhere a value is needed and neither specified nor carried, we refuse.
 */
export function decodeHextileToWirePixels(
  payload: Buffer,
  width: number,
  height: number,
): Buffer | null {
  const bpp = OPERATOR_RFB_BYTES_PER_PIXEL;
  // ── THE DECODED SIZE IS A DIFFERENT CEILING FROM THE PAYLOAD SIZE ────────
  // A Hextile rect's WIRE size is tiny and its DECODED size is not: a uniform
  // 6000x6000 screen walks a single 0.67 MB tile stream and decodes to 137 MB.
  // The caller bounds the payload (`OPERATOR_RFB_MAX_RECT_BYTES`) and the
  // framebuffer (`allocate()`), but this function allocates BEFORE either is
  // consulted, so a payload comfortably inside every payload cap could force a
  // 145 MB spike and a 65535x65535 header could ask `Buffer.alloc` for 17 GB and
  // throw `RangeError` out of a socket callback.
  //
  // Checking here (and not only at the call site) is deliberate: this is
  // `export`ed, so it is callable on its own and must be safe on its own.
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (width * height * bpp > OPERATOR_RFB_MAX_FRAMEBUFFER_BYTES) return null;
  const out = Buffer.alloc(width * height * bpp);
  let p = 0;
  let bg: Buffer | null = null;
  let fg: Buffer | null = null;

  const readPixel = (): Buffer | null => {
    if (p + bpp > payload.length) return null;
    const v = Buffer.from(payload.subarray(p, p + bpp));
    p += bpp;
    return v;
  };

  const fill = (x0: number, y0: number, w: number, h: number, pix: Buffer): void => {
    for (let yy = y0; yy < y0 + h; yy++) {
      let off = (yy * width + x0) * bpp;
      for (let xx = 0; xx < w; xx++) {
        pix.copy(out, off);
        off += bpp;
      }
    }
  };

  for (let ty = 0; ty < height; ty += OPERATOR_HEXTILE_TILE) {
    const th = Math.min(OPERATOR_HEXTILE_TILE, height - ty);
    for (let tx = 0; tx < width; tx += OPERATOR_HEXTILE_TILE) {
      const tw = Math.min(OPERATOR_HEXTILE_TILE, width - tx);
      if (p >= payload.length) return null;
      const mask = payload[p];

      // A Raw tile is w*h literal pixel values and nothing else.
      if (mask & OPERATOR_HEXTILE_RAW) {
        p += 1;
        const bytes = tw * th * bpp;
        if (p + bytes > payload.length) return null;
        for (let row = 0; row < th; row++) {
          payload.copy(
            out,
            ((ty + row) * width + tx) * bpp,
            p + row * tw * bpp,
            p + (row + 1) * tw * bpp,
          );
        }
        p += bytes;
        bg = null;
        fg = null;
        continue;
      }

      p += 1;

      if (mask & OPERATOR_HEXTILE_BACKGROUND_SPECIFIED) {
        const v = readPixel();
        if (!v) return null;
        bg = v;
      } else if (!bg) {
        // First non-raw tile MUST specify a background (§7.7.4); a carry-over
        // with nothing to carry is an undefined colour, not a default.
        return null;
      }

      if (mask & OPERATOR_HEXTILE_FOREGROUND_SPECIFIED) {
        // §7.7.4: "If this bit is set, then the SubrectsColored bit must be
        // zero." Both set is a malformed stream.
        if (mask & OPERATOR_HEXTILE_SUBRECTS_COLOURED) return null;
        const v = readPixel();
        if (!v) return null;
        fg = v;
      }

      const coloured = (mask & OPERATOR_HEXTILE_SUBRECTS_COLOURED) !== 0;
      const anySubrects = (mask & OPERATOR_HEXTILE_ANY_SUBRECTS) !== 0;

      // A tile with no subrects is a solid background fill.
      fill(tx, ty, tw, th, bg);
      if (!anySubrects) {
        // Foreground survives an AnySubrects-clear tile (§7.7.4 explicitly
        // allows carrying it from such a tile), so it is NOT cleared here.
        if (coloured) return null; // Coloured with no subrects to colour
        continue;
      }

      if (!coloured && !fg) return null; // nothing to paint the subrects with

      if (p >= payload.length) return null;
      const count = payload[p];
      p += 1;
      const perSub = (coloured ? bpp : 0) + 2;
      if (p + count * perSub > payload.length) return null;

      for (let s = 0; s < count; s++) {
        let pix: Buffer;
        if (coloured) {
          const v = readPixel();
          if (!v) return null;
          pix = v;
        } else {
          pix = fg as Buffer;
        }
        const pos = payload[p];
        const size = payload[p + 1];
        p += 2;
        // §7.7.4: high nibble of position is X; size nibbles are minus-one.
        const sx = pos >> 4;
        const sy = pos & 0x0f;
        const sw = (size >> 4) + 1;
        const sh = (size & 0x0f) + 1;
        // A subrect that overruns its tile is CLIPPED, not trusted: the RFC
        // allows the last row/column of tiles to be smaller than 16.
        const cw = Math.min(sw, tw - sx);
        const ch = Math.min(sh, th - sy);
        if (cw > 0 && ch > 0) fill(tx + sx, ty + sy, cw, ch, pix);
      }

      // §7.7.4: the foreground may not be carried over a Coloured tile.
      if (coloured) fg = null;
    }
  }
  return out;
}

// ── Tight (rfbproto "Tight Encoding") ──────────────────────────────────────

/**
 * Per-stream zlib state. Tight multiplexes up to FOUR independent zlib streams
 * and — this is the part that breaks a naive decoder — they PERSIST ACROSS
 * RECTANGLES. A later rect's compressed bytes may back-reference output the
 * decoder produced for an earlier one, so continuation needs that output as the
 * inflate dictionary.
 *
 * Measured on Node 22.23.3 (not assumed): feeding a continuation chunk to a
 * fresh `inflateSync` throws `Z_DATA_ERROR: incorrect header check`, because
 * only the FIRST chunk carries the 2-byte zlib header. Re-inflating the same
 * bytes with `inflateRawSync(..., { dictionary: previousOutput })` reproduces
 * the stream BYTE-EXACTLY. A test proves both legs (see the "no naive inflate"
 * pin), because a fixture that emits one self-contained rect per stream would
 * pass even with the continuation logic deleted.
 */
export interface OperatorTightStream {
  /** The last ≤32 KiB of decompressed output for this stream (the window). */
  history: Buffer;
  /** Has this stream produced output yet? False ⇒ the next chunk has a header. */
  started: boolean;
}

export type OperatorTightStreams = OperatorTightStream[];

/** Four streams, as the spec allows (§"Four separate zlib streams (0..3)"). */
export function createTightStreams(): OperatorTightStreams {
  return [
    { history: Buffer.alloc(0), started: false },
    { history: Buffer.alloc(0), started: false },
    { history: Buffer.alloc(0), started: false },
    { history: Buffer.alloc(0), started: false },
  ];
}

/**
 * Read a Tight "compact" length: 1, 2 or 3 bytes, little-endian 7-bit groups
 * with the top bit meaning "another byte follows" (the third byte carries 8
 * bits). Returns `null` when the bytes have not arrived.
 *
 * The 3-byte form tops out at 2^22-1 = 4194303, which is the hard ceiling on a
 * single Tight data block and therefore the ceiling our framing must respect.
 */
function readTightCompactLength(
  buf: Buffer,
  at: number,
  limit: number,
): { value: number; bytes: number } | null {
  if (at + 1 > limit) return null;
  const b0 = buf[at];
  if ((b0 & 0x80) === 0) return { value: b0, bytes: 1 };
  if (at + 2 > limit) return null;
  const b1 = buf[at + 1];
  let value = (b0 & 0x7f) | ((b1 & 0x7f) << 7);
  if ((b1 & 0x80) === 0) return { value, bytes: 2 };
  if (at + 3 > limit) return null;
  value |= buf[at + 2] << 14;
  return { value, bytes: 3 };
}

/** How many bytes a Tight rect's payload occupies, decided WITHOUT inflating. */
export type TightFraming =
  | { kind: 'ok'; bytes: number }
  | { kind: 'need-more' }
  | { kind: 'invalid'; detail: string };

/**
 * Every byte a Tight rect needs to DECIDE its length: control(1) + filter(1) +
 * palette-count(1) + a 256-colour palette (768) + a 3-byte compact length.
 *
 * This constant exists so the decoder can peek a SMALL bounded window instead of
 * copying its whole queue. `OperatorByteQueue.peek(n)` copies what it returns,
 * so peeking `q.size` on every Tight rect would copy the entire backlog — up to
 * `MAX_PENDING_BYTES` (66 MB) per rect, which is a performance cliff on exactly
 * the hot path this slice adds.
 */
export const OPERATOR_TIGHT_MAX_HEADER_BYTES =
  1 + 1 + 1 + 256 * OPERATOR_TIGHT_TPIXEL_BYTES + OPERATOR_TIGHT_MAX_COMPACT_BYTES;

/**
 * Walk one Tight rect payload and report its total length.
 *
 * ── WHY THE LENGTH IS DERIVABLE HERE, UNLIKE HEXTILE ───────────────────────
 * A Hextile payload can only be sized by walking its tiles, because every tile
 * carries its own mask. A Tight payload is different: the control byte names the
 * compression method, an optional filter byte names the transform, and the
 * filtered size is then a pure function of the rect geometry (plus the palette
 * size, which is stated up front). The compressed block is length-prefixed. So
 * the whole rect is walkable from its header alone — no inflation, no guessing.
 *
 * That is what lets the boundary scan (`operatorUpdateShape`) size a real
 * TightVNC update, and it is why `bytes` below is exact rather than an estimate.
 *
 * ── WHAT `limit` MEANS HERE (it is NOT "the whole payload must be present") ─
 * Only the HEADER must be inside `limit`; the data block need not be. Reporting
 * a total from a header is what lets a caller ask "have all `bytes` arrived
 * yet?" — which is precisely the question a chunked relay forces it to ask. A
 * caller that needs the data in hand must check separately (`bytes` is the
 * total, not the available count), exactly as the Raw path already does.
 *
 * `limit` must be ≥ the header for any answer better than `need-more`; see
 * `OPERATOR_TIGHT_MAX_HEADER_BYTES`.
 *
 * ── THE ONE RULE THAT BREAKS EVERYTHING IF MISSED ──────────────────────────
 * The compact length prefix exists ONLY when the filtered data is ≥ 12 bytes.
 * "If the data size after applying the filter but before the compression is
 * less then 12, then the data is sent as is, uncompressed" — with no length in
 * front. Reading a length there consumes a pixel byte as a length and every
 * later byte lands at the wrong offset.
 */
export function tightPayloadBytes(
  buf: Buffer,
  start: number,
  limit: number,
  width: number,
  height: number,
  tightPixelBytes: number = OPERATOR_TIGHT_TPIXEL_BYTES,
): TightFraming {
  if (!isValidDimension(width) || !isValidDimension(height)) {
    return { kind: 'invalid', detail: `tight rect ${width}x${height}` };
  }
  // "the width of any Tight-encoded rectangle cannot exceed 2048 pixels".
  if (width > 2048) return { kind: 'invalid', detail: `tight rect width ${width} > 2048` };

  let p = start;
  if (p + 1 > limit) return { kind: 'need-more' };
  const control = buf[p];
  p += 1;

  const compression = control & 0x80 ? (control >> 4) & 0x0f : 0;

  // ── FillCompression: one TPIXEL and nothing else ──────────────────────────
  if (control & 0x80 && compression === 0x8) {
    return { kind: 'ok', bytes: p + tightPixelBytes - start };
  }
  // ── JpegCompression: framed by a length, but we do not decode JPEG ────────
  // Reported as invalid so the caller refuses the stream HONESTLY rather than
  // skipping pixels it cannot produce. We never advertise a JPEG quality level,
  // so a compliant server will not send this; a non-compliant one gets a
  // refusal, not a hole in the picture.
  if (control & 0x80 && compression === 0x9) {
    return { kind: 'invalid', detail: 'tight JPEG compression is not implemented' };
  }

  let withoutZlib = false;
  let readFilterId: boolean;
  if (control & 0x80) {
    if (compression !== 0x0a && compression !== 0x0e) {
      return { kind: 'invalid', detail: `tight compression-control 0x${control.toString(16)}` };
    }
    withoutZlib = true;
    readFilterId = compression === 0x0e;
  } else {
    readFilterId = (control & 0x40) !== 0;
  }

  let filterId = OPERATOR_TIGHT_FILTER_COPY;
  if (readFilterId) {
    if (p + 1 > limit) return { kind: 'need-more' };
    filterId = buf[p];
    p += 1;
  }

  // ── PaletteFilter: the palette is RAW on the wire, BEFORE the zlib block ───
  // Confirmed against two independent implementations rather than inferred:
  // libvncserver writes the palette straight into its update buffer before
  // calling its compressed-send, and noVNC reads `numColors * 3` off the socket
  // before it touches a zlib stream. Reading it from inside the compressed data
  // would desynchronise both the palette and every following pixel.
  let paletteColors = 0;
  if (filterId === OPERATOR_TIGHT_FILTER_PALETTE) {
    if (p + 1 > limit) return { kind: 'need-more' };
    paletteColors = buf[p] + 1;
    p += 1;
    const paletteBytes = paletteColors * tightPixelBytes;
    if (p + paletteBytes > limit) return { kind: 'need-more' };
    p += paletteBytes;
  } else if (filterId !== OPERATOR_TIGHT_FILTER_COPY && filterId !== OPERATOR_TIGHT_FILTER_GRADIENT) {
    // An unknown filter is an unknown transform: its output size is not
    // something we may guess at.
    return { kind: 'invalid', detail: `tight filter-id ${filterId}` };
  }

  // ── The filtered size, a pure function of geometry + filter ───────────────
  let filtered: number;
  if (filterId === OPERATOR_TIGHT_FILTER_PALETTE) {
    // 2 colours ⇒ 1 bit per pixel, MSB = leftmost, each row byte-aligned;
    // otherwise 8 bits per pixel.
    const rowSize = paletteColors <= 2 ? Math.floor((width * 1 + 7) / 8) : width;
    filtered = rowSize * height;
  } else if (filterId === OPERATOR_TIGHT_FILTER_GRADIENT) {
    // One difference per colour component; only defined for 3-byte TPIXEL.
    if (tightPixelBytes !== OPERATOR_TIGHT_TPIXEL_BYTES) {
      return { kind: 'invalid', detail: 'tight gradient filter needs the 3-byte TPIXEL format' };
    }
    filtered = width * height * 3;
  } else {
    filtered = width * height * tightPixelBytes;
  }

  // Bound the RESULT before anything is buffered — the Hextile lesson
  // (`MAX_RECT_BYTES` bounds the wire, not the decode), applied up front here
  // because Tight's filtered size is known before a single byte is consumed.
  if (filtered > OPERATOR_RFB_MAX_FRAMEBUFFER_BYTES) {
    return { kind: 'invalid', detail: `tight ${width}x${height} filters to ${filtered}b` };
  }

  // "sent as is, uncompressed" — with NO length prefix.
  if (withoutZlib || filtered < OPERATOR_TIGHT_MIN_COMPRESSED) {
    return { kind: 'ok', bytes: p + filtered - start };
  }

  const len = readTightCompactLength(buf, p, limit);
  if (len === null) return { kind: 'need-more' };
  p += len.bytes;
  if (len.value > OPERATOR_TIGHT_MAX_DATA_BYTES) {
    return { kind: 'invalid', detail: `tight data length ${len.value}` };
  }
  return { kind: 'ok', bytes: p + len.value - start };
}

/** Result of decoding one Tight rect. */
export type TightDecodeResult =
  | { ok: true; pixels: Buffer; bytes: number }
  | { ok: false; detail: string };

/**
 * Decode one Tight rect (rfbproto "Tight Encoding") into WIRE-ORDER pixels
 * (`BB GG RR 00`), so it composites through the SAME pixel path as Raw and
 * Hextile. `streams` is mutated: Tight's zlib streams persist across rects.
 *
 * Returns a refusal (never a throw, never a partial picture) on anything
 * malformed. A wrong-but-plausible image is worse than a visible refusal.
 */
export function decodeTightRect(
  payload: Buffer,
  width: number,
  height: number,
  streams: OperatorTightStreams,
  tightPixelBytes: number = OPERATOR_TIGHT_TPIXEL_BYTES,
): TightDecodeResult {
  const bpp = OPERATOR_RFB_BYTES_PER_PIXEL;
  if (!isValidDimension(width) || !isValidDimension(height)) {
    return { ok: false, detail: `tight rect ${width}x${height}` };
  }
  // Bound BEFORE the alloc, computed from the geometry the header declared.
  if (width * height * bpp > OPERATOR_RFB_MAX_FRAMEBUFFER_BYTES) {
    return { ok: false, detail: `tight ${width}x${height} decodes to ${width * height * bpp}b` };
  }
  const out = Buffer.alloc(width * height * bpp);
  const writePixel = (index: number, r: number, g: number, b: number): void => {
    const at = index * bpp;
    out[at] = b; // wire order BB GG RR 00
    out[at + 1] = g;
    out[at + 2] = r;
    out[at + 3] = 0;
  };

  const framing = tightPayloadBytes(payload, 0, payload.length, width, height, tightPixelBytes);
  if (framing.kind !== 'ok') {
    return { ok: false, detail: framing.kind === 'invalid' ? framing.detail : 'tight payload truncated' };
  }

  let p = 0;
  const control = payload[p];
  p += 1;
  const compression = control & 0x80 ? (control >> 4) & 0x0f : 0;

  // ── Stream resets are honoured for EVERY compression method ───────────────
  // "the decoder must reset the indicated zlib streams even if the compression
  // type is FillCompression or JpegCompression". A decoder that only resets on
  // the compression paths carries a stale window into the next rect and then
  // silently mis-decodes its first back-reference.
  for (let bit = 0; bit < 4; bit++) {
    if (control & (1 << bit)) {
      streams[bit].history = Buffer.alloc(0);
      streams[bit].started = false;
    }
  }

  // ── FillCompression: one pixel value for the whole rect ───────────────────
  if (control & 0x80 && compression === 0x8) {
    if (p + tightPixelBytes > payload.length) return { ok: false, detail: 'tight fill truncated' };
    const r = payload[p];
    const g = payload[p + 1];
    const b = payload[p + 2];
    for (let i = 0; i < width * height; i++) writePixel(i, r, g, b);
    return { ok: true, pixels: out, bytes: framing.bytes };
  }

  let withoutZlib = false;
  let readFilterId: boolean;
  if (control & 0x80) {
    if (compression !== 0x0a && compression !== 0x0e) {
      return { ok: false, detail: `tight compression-control 0x${control.toString(16)}` };
    }
    withoutZlib = true;
    readFilterId = compression === 0x0e;
  } else {
    readFilterId = (control & 0x40) !== 0;
  }
  const streamId = (control >> 4) & 0x03;

  let filterId = OPERATOR_TIGHT_FILTER_COPY;
  if (readFilterId) {
    filterId = payload[p];
    p += 1;
  }

  let palette: number[] = [];
  if (filterId === OPERATOR_TIGHT_FILTER_PALETTE) {
    const paletteColors = payload[p] + 1;
    p += 1;
    for (let i = 0; i < paletteColors; i++) {
      palette.push(payload[p], payload[p + 1], payload[p + 2]);
      p += tightPixelBytes;
    }
  }

  let filtered: number;
  if (filterId === OPERATOR_TIGHT_FILTER_PALETTE) {
    const rowSize = palette.length / 3 <= 2 ? Math.floor((width * 1 + 7) / 8) : width;
    filtered = rowSize * height;
  } else if (filterId === OPERATOR_TIGHT_FILTER_GRADIENT) {
    filtered = width * height * 3;
  } else {
    filtered = width * height * tightPixelBytes;
  }

  // ── Fetch the filtered bytes: inline when <12, else through zlib ──────────
  let data: Buffer;
  if (withoutZlib || filtered < OPERATOR_TIGHT_MIN_COMPRESSED) {
    if (p + filtered > payload.length) return { ok: false, detail: 'tight data truncated' };
    data = payload.subarray(p, p + filtered);
    p += filtered;
  } else {
    const len = readTightCompactLength(payload, p, payload.length);
    if (len === null) return { ok: false, detail: 'tight length truncated' };
    p += len.bytes;
    if (p + len.value > payload.length) return { ok: false, detail: 'tight zlib data truncated' };
    const chunk = payload.subarray(p, p + len.value);
    p += len.value;

    const stream = streams[streamId];
    // `maxOutputLength` is the bound the Hextile lesson demands: the DECODED
    // size, enforced by zlib itself, before a byte is allocated. It is exact
    // rather than generous because the filtered size is known from the header.
    // Verified: exceeding it throws rather than silently truncating.
    try {
      const opts = {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
        maxOutputLength: Math.max(1, filtered),
      };
      const produced = stream.started
        ? inflateRawSync(chunk, { ...opts, dictionary: stream.history })
        : inflateSync(chunk, opts);
      data = produced;
      // Only the FIRST chunk carries a zlib header; every later chunk is
      // raw mid-stream continuation. Recording that is what makes rect N>1 work.
      const history = Buffer.concat([stream.history, produced]);
      stream.history =
        history.length > OPERATOR_TIGHT_ZLIB_WINDOW
          ? history.subarray(history.length - OPERATOR_TIGHT_ZLIB_WINDOW)
          : history;
      stream.started = true;
    } catch (err) {
      // A zlib failure means the stream state and the bytes disagree — a real
      // desync, not something to paper over with a blank rect.
      return { ok: false, detail: `tight zlib: ${(err as Error).message.slice(0, 80)}` };
    }
    if (data.length !== filtered) {
      return { ok: false, detail: `tight zlib produced ${data.length}b, expected ${filtered}b` };
    }
  }

  // ── Un-filter ─────────────────────────────────────────────────────────────
  if (filterId === OPERATOR_TIGHT_FILTER_PALETTE) {
    const colours = palette.length / 3;
    if (colours <= 2) {
      // 1 bit per pixel, MOST significant bit = leftmost, rows byte-aligned.
      const rowSize = Math.floor((width + 7) / 8);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const byte = data[y * rowSize + (x >> 3)];
          const bit = (byte >> (7 - (x & 7))) & 1;
          writePixel(y * width + x, palette[bit * 3], palette[bit * 3 + 1], palette[bit * 3 + 2]);
        }
      }
    } else {
      for (let i = 0; i < width * height; i++) {
        const idx = data[i];
        if (idx >= colours) return { ok: false, detail: `tight palette index ${idx} >= ${colours}` };
        writePixel(i, palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2]);
      }
    }
  } else if (filterId === OPERATOR_TIGHT_FILTER_GRADIENT) {
    // Reconstruct each component from the spec's own pseudo-code:
    //   P[i,j] = V[i-1,j] + V[i,j-1] - V[i-1,j-1]   (clamped to 0..MAX)
    //   V[i,j] = D[i,j] + P[i,j]                    (mod 256)
    // with V assumed 0 outside the rect — which makes row 0 a plain running sum
    // along the row, and column 0 a running sum down the column.
    //
    // `comp` holds V (the DECODED value) per component, because the right and
    // upper-left neighbours are decoded values, not differences. Working from
    // `out` instead would mean reverse-indexing the wire-order pixels for each
    // component, which is where a red/green swap hides.
    const comp = Buffer.alloc(width * height * 3);
    const left = [0, 0, 0];
    const upper = [0, 0, 0];
    const upperLeft = [0, 0, 0];
    let at = 0;
    for (let y = 0; y < height; y++) {
      // A new row: nothing to the left yet, and nothing above-and-left yet.
      left[0] = left[1] = left[2] = 0;
      upperLeft[0] = upperLeft[1] = upperLeft[2] = 0;
      for (let x = 0; x < width; x++) {
        const base = (y * width + x) * 3;
        const aboveBase = y > 0 ? ((y - 1) * width + x) * 3 : -1;
        for (let c = 0; c < 3; c++) {
          upper[c] = aboveBase >= 0 ? comp[aboveBase + c] : 0;
          let prediction = left[c] + upper[c] - upperLeft[c];
          if (prediction < 0) prediction = 0;
          else if (prediction > 255) prediction = 255;
          const value = (data[at++] + prediction) & 0xff;
          comp[base + c] = value;
          upperLeft[c] = upper[c];
          left[c] = value;
        }
      }
    }
    for (let i = 0; i < width * height; i++) {
      writePixel(i, comp[i * 3], comp[i * 3 + 1], comp[i * 3 + 2]);
    }
  } else {
    // CopyFilter: TPIXEL triples, R G B, verbatim.
    if (tightPixelBytes !== OPERATOR_TIGHT_TPIXEL_BYTES) {
      return { ok: false, detail: 'tight copy filter needs the 3-byte TPIXEL format' };
    }
    for (let i = 0; i < width * height; i++) {
      const at3 = i * 3;
      writePixel(i, data[at3], data[at3 + 1], data[at3 + 2]);
    }
  }

  return { ok: true, pixels: out, bytes: framing.bytes };
}

/** `BB GG RR 00` (wire) → `RR GG BB FF` (RGBA, what a renderer wants). */
export function operatorWirePixelsToRgba(pixels: Buffer, pixelCount: number): Buffer {
  const out = Buffer.alloc(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    const s = i * 4;
    out[i * 4] = pixels[s + 2]; // red
    out[i * 4 + 1] = pixels[s + 1]; // green
    out[i * 4 + 2] = pixels[s]; // blue
    out[i * 4 + 3] = 255; // opaque
  }
  return out;
}

/**
 * The operator's decoder AND the framebuffer it composites into.
 *
 * Feed it the payloads the operator drains from the relay, in sequence order.
 * `push` returns the decoded events for observability; `snapshot` is the
 * rendered screen.
 *
 * Geometry is learned from the stream — the first Raw rectangle sizes the
 * canvas and a DesktopSize pseudo-encoding resizes it — because the brokered
 * relay has no out-of-band ServerInit. That is what makes the carried stream
 * self-describing rather than dependent on a handshake the pump never runs.
 */
export class OperatorScreenDecoder {
  private q = new OperatorByteQueue();
  private rectsLeft = 0;
  /** Is the current update LastRect-terminated (count was the 0xFFFF sentinel)? */
  private lastRectMode = false;
  private halted = false;
  private haltReason: OperatorDesyncReason | null = null;

  private width = 0;
  private height = 0;
  private framebuffer: Buffer | null = null;
  private rectsApplied = 0;
  /**
   * Tight's four zlib streams. They live on the DECODER, not per rect, because
   * they persist across rectangles — a per-rect inflate throws on the second
   * rect (`Z_DATA_ERROR incorrect header check`), measured, not theorised.
   */
  private tightStreams: OperatorTightStreams = createTightStreams();

  get isHalted(): boolean {
    return this.halted;
  }

  get haltReasonCode(): OperatorDesyncReason | null {
    return this.haltReason;
  }

  /** Bytes buffered and not yet decoded (diagnostics). */
  get pending(): number {
    return this.q.size;
  }

  /** The current canvas size, or null before the first geometry. */
  get geometry(): { width: number; height: number } | null {
    return this.framebuffer ? { width: this.width, height: this.height } : null;
  }

  /** Feed one carried payload (base64, as the relay hands it over). */
  ingest(payloadB64: string): OperatorServerEvent[] {
    if (typeof payloadB64 !== 'string' || payloadB64.length === 0) return [];
    let bytes: Buffer;
    try {
      bytes = Buffer.from(payloadB64, 'base64');
    } catch {
      return [];
    }
    if (bytes.length === 0) return [];
    return this.push(bytes);
  }

  /** Feed raw carried bytes. */
  push(chunk: Buffer | Uint8Array): OperatorServerEvent[] {
    const out: OperatorServerEvent[] = [];
    if (this.halted) return out;
    this.q.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (this.q.size > OPERATOR_RFB_MAX_PENDING_BYTES) {
      out.push(this.desync('pending-overflow', `buffered ${this.q.size}b waiting for a message`));
      return out;
    }
    for (let i = 0; i < MAX_EVENTS_PER_PUSH; i++) {
      const ev = this.step();
      if (!ev) break;
      out.push(ev);
      if (ev.type === 'rect') this.applyRect(ev);
      if (ev.type === 'desync') break;
    }
    return out;
  }

  private desync(reason: OperatorDesyncReason, detail: string): OperatorServerEvent {
    this.halted = true;
    this.haltReason = reason;
    this.q.clear();
    this.rectsLeft = 0;
    // Reset the LastRect mode too. The decoder is dead after a halt (`push`
    // returns early), so this changes nothing today — but a future resync path
    // that reuses the instance would otherwise inherit a sentinel mode from a
    // stream that never terminated, and silently expect a terminator that will
    // not arrive.
    this.lastRectMode = false;
    return { type: 'desync', reason, detail };
  }

  private step(): OperatorServerEvent | null {
    if (this.q.size < 1) return null;
    const type = this.q.peek(1)[0];
    switch (type) {
      case OPERATOR_RFB_SERVER_FRAMEBUFFER_UPDATE:
        return this.readFramebufferUpdate();
      case OPERATOR_RFB_SERVER_SET_COLOUR_MAP_ENTRIES:
        return this.readColourMap();
      case OPERATOR_RFB_SERVER_BELL:
        this.q.drop(1);
        return { type: 'bell' };
      case OPERATOR_RFB_SERVER_CUT_TEXT:
        return this.readCutText();
      default:
        // An unknown SERVER message type means we cannot know its length, so
        // every following byte would land at the wrong offset.
        return this.desync('unknown-message-type', `server message type ${type}`);
    }
  }

  private readFramebufferUpdate(): OperatorServerEvent | null {
    // update header: type(1) padding(1) number-of-rectangles(2)
    if (this.rectsLeft === 0) {
      if (this.q.size < 4) return null;
      const head = this.q.peek(4);
      const numRects = head.readUInt16BE(2);
      this.q.drop(4);
      // LastRect mode: the count is a SENTINEL, not a number — the update runs
      // until a rect carrying the LastRect pseudo-encoding arrives. TigerVNC's
      // server sends exactly this for every update, so treating 0xFFFF as a
      // literal count would make the decoder spend 65535 rect parses waiting for
      // a marker it never looks for.
      this.lastRectMode = numRects === OPERATOR_RFB_RECT_COUNT_LASTRECT;
      this.rectsLeft = this.lastRectMode ? OPERATOR_MAX_RECTS_PER_UPDATE : numRects;
      return { type: 'update-begin', numRects };
    }

    // one rectangle: x(2) y(2) w(2) h(2) encoding(4), then its payload
    if (this.q.size < 12) return null;
    const h = this.q.peek(12);
    const x = h.readUInt16BE(0);
    const y = h.readUInt16BE(2);
    const width = h.readUInt16BE(4);
    const height = h.readUInt16BE(6);
    const encoding = h.readInt32BE(8);

    // DesktopSize is a pseudo-encoding: the header IS the message, no pixels.
    if (encoding === OPERATOR_RFB_ENCODING_DESKTOP_SIZE) {
      this.q.drop(12);
      this.rectsLeft -= 1;
      return { type: 'rect', x: 0, y: 0, width, height, encoding, pixels: null };
    }

    // ── LastRect: the end-of-update marker (pre-RFC extension) ───────────────
    // Header only, no payload, and it TERMINATES the rect list. Returning a rect
    // event keeps the observable stream uniform; zeroing `rectsLeft` here is what
    // lets the decoder move on to the next message instead of hunting for
    // rectangles that will never come.
    if (encoding === OPERATOR_RFB_ENCODING_LAST_RECT) {
      this.q.drop(12);
      this.rectsLeft = 0;
      this.lastRectMode = false;
      return { type: 'rect', x: 0, y: 0, width: 0, height: 0, encoding, pixels: null };
    }

    // ── CopyRect (RFC 6143 §7.7.2): the payload is a source coordinate ──────
    // No pixels arrive; the rectangle is a MOVE within the framebuffer. This is
    // what a Windows server sends for a dragged window or a scroll — which is
    // most of what changes on a desktop, so refusing it (as the Raw-only
    // decoder did) discarded the cheap half of every real update stream.
    if (encoding === OPERATOR_RFB_ENCODING_COPY_RECT) {
      if (this.q.size < 12 + 4) return null;
      const p = this.q.peek(16);
      const srcX = p.readUInt16BE(12);
      const srcY = p.readUInt16BE(14);
      this.q.drop(16);
      this.rectsLeft -= 1;
      return {
        type: 'rect',
        x,
        y,
        width,
        height,
        encoding,
        pixels: null,
        copySrcX: srcX,
        copySrcY: srcY,
      };
    }

    // ── Hextile (RFC 6143 §7.7.4): 16x16 tiles, per-tile subencoding mask ────
    // Its payload length is NOT arithmetic — it depends on the masks the server
    // chose — so it is found by walking the tiles. Walking is safe precisely
    // because the tile GRID is fixed by the rect geometry: we always know how
    // many tiles there are, and each one's size is bounded.
    if (encoding === OPERATOR_RFB_ENCODING_HEXTILE) {
      if (!isValidDimension(width) || !isValidDimension(height)) {
        return this.desync('bad-dimensions', `hextile rect ${width}x${height}`);
      }
      // ── REFUSE ON THE DECODED SIZE, BEFORE ALLOCATING (finding 4) ─────────
      // The payload ceiling below does NOT bound the decoded result, and Hextile
      // is the encoding where those two numbers come apart by two orders of
      // magnitude. Checking here too (not only inside the decode helper) means a
      // hostile or broken header is refused WITHOUT buffering a megabyte of tile
      // stream first — the refusal is cheap and immediate rather than correct
      // but late.
      if (width * height * OPERATOR_RFB_BYTES_PER_PIXEL > OPERATOR_RFB_MAX_FRAMEBUFFER_BYTES) {
        return this.desync(
          'rect-too-large',
          `hextile ${width}x${height} decodes to ${width * height * OPERATOR_RFB_BYTES_PER_PIXEL}b, ` +
            `over the ${OPERATOR_RFB_MAX_FRAMEBUFFER_BYTES}b framebuffer ceiling`,
        );
      }
      const tilesX = Math.ceil(width / OPERATOR_HEXTILE_TILE);
      const tilesY = Math.ceil(height / OPERATOR_HEXTILE_TILE);
      // Ceiling on what this rect could possibly cost. A hostile header cannot
      // make us buffer past it: the rect is refused before we wait for bytes.
      const maxPayload = Math.min(
        tilesX * tilesY * OPERATOR_HEXTILE_MAX_TILE_BYTES,
        OPERATOR_RFB_MAX_RECT_BYTES,
      );
      if (this.q.size < 12 + 1) return null;
      const windowBytes = Math.min(this.q.size, 12 + maxPayload);
      const buf = this.q.peek(windowBytes);
      const len = hextilePayloadBytes(buf, 12, buf.length, width, height);
      if (len === null) {
        // Two different situations, and they must not be confused:
        //   - every byte we hold was consumed and the walk simply ran out →
        //     the rest of the payload has not arrived yet, wait.
        //   - we already hold the entire possible payload and it still does not
        //     parse → the tile stream is malformed, halt.
        if (windowBytes >= 12 + maxPayload) {
          return this.desync('bad-hextile', `${width}x${height} did not parse inside ${maxPayload}b`);
        }
        return null;
      }
      if (len > OPERATOR_RFB_MAX_RECT_BYTES) {
        return this.desync('rect-too-large', `hextile ${width}x${height} = ${len}b`);
      }
      if (this.q.size < 12 + len) return null;
      this.q.drop(12);
      const payload = this.q.take(len);
      const pixels = decodeHextileToWirePixels(payload, width, height);
      if (!pixels) return this.desync('bad-hextile', `${width}x${height} tile stream is malformed`);
      this.rectsLeft -= 1;
      return { type: 'rect', x, y, width, height, encoding, pixels };
    }

    // ── Tight (rfbproto "Tight Encoding") ────────────────────────────────────
    // The encoding that decides whether a real Windows host renders at all:
    // TightVNC and TigerVNC both PREFER Tight, and a host forced to `tight`
    // used to answer our advertisement with a rect we refused.
    if (encoding === OPERATOR_RFB_ENCODING_TIGHT) {
      // PEEK A BOUNDED WINDOW, NOT THE WHOLE QUEUE — and START AT THE PAYLOAD.
      // `OperatorByteQueue.peek(n)` copies what it returns, so passing `q.size`
      // here would copy up to MAX_PENDING_BYTES (66 MB) for every Tight rect on
      // a 141-frame screen. The framing decision needs at most a control byte,
      // a filter byte, a 256-colour palette and a 3-byte compact length, so this
      // stays O(header) whatever the backlog.
      //
      // The queue front is the 12-byte RECT HEADER, so the payload starts at 12.
      // (Getting this wrong reads `x`'s high byte as a compression-control byte,
      // which parses as BasicCompression and then mis-frames everything.)
      const windowBytes = Math.min(this.q.size, 12 + OPERATOR_TIGHT_MAX_HEADER_BYTES);
      const header = this.q.peek(windowBytes);
      const framing = tightPayloadBytes(header, 12, windowBytes, width, height);
      if (framing.kind === 'invalid') {
        return this.desync('bad-tight', `${width}x${height}: ${framing.detail}`);
      }
      // `bytes` is the TOTAL rect size, derived from the header — so this is the
      // question "has the whole rect arrived?", which is what a chunked relay
      // forces us to ask. A short window is `need-more`, never a mis-parse.
      if (framing.kind === 'need-more') return null;
      if (this.q.size < 12 + framing.bytes) return null;

      this.q.drop(12);
      const payload = this.q.take(framing.bytes);
      const decoded = decodeTightRect(payload, width, height, this.tightStreams);
      if (!decoded.ok) return this.desync('bad-tight', `${width}x${height}: ${decoded.detail}`);
      this.rectsLeft -= 1;
      return { type: 'rect', x, y, width, height, encoding, pixels: decoded.pixels };
    }

    // Anything else (RRE 2, TRLE 16, ZRLE 17, …) has a payload length we cannot
    // derive, so consuming it would put every later byte at the wrong offset.
    // Refuse the stream rather than mis-parse it.
    if (encoding !== OPERATOR_RFB_ENCODING_RAW) {
      return this.desync(
        'unsupported-encoding',
        `encoding ${encoding} (Raw, CopyRect, Hextile and Tight are implemented)`,
      );
    }

    if (!isValidDimension(width) || !isValidDimension(height)) {
      return this.desync('bad-dimensions', `raw rect ${width}x${height}`);
    }
    const payload = width * height * OPERATOR_RFB_BYTES_PER_PIXEL;
    // Validate BEFORE waiting for bytes.
    if (payload > OPERATOR_RFB_MAX_RECT_BYTES) {
      return this.desync('rect-too-large', `${width}x${height} = ${payload}b`);
    }
    if (this.q.size < 12 + payload) return null;

    this.q.drop(12);
    const pixels = this.q.take(payload);
    this.rectsLeft -= 1;
    return { type: 'rect', x, y, width, height, encoding, pixels };
  }

  private readColourMap(): OperatorServerEvent | null {
    // type(1) padding(1) first-colour(2) number-of-colours(2) then 6b per entry
    if (this.q.size < 6) return null;
    const h = this.q.peek(6);
    const firstColour = h.readUInt16BE(2);
    const numColours = h.readUInt16BE(4);
    const need = 6 + numColours * 6;
    if (this.q.size < need) return null;
    this.q.drop(need);
    // We only ever ask for true colour, so an applied colour map would be a
    // protocol surprise. Consume it (the framing is known) and report it.
    return { type: 'colour-map', firstColour, numColours };
  }

  private readCutText(): OperatorServerEvent | null {
    // type(1) padding(3) length(4) then length bytes of Latin-1
    if (this.q.size < 8) return null;
    const length = this.q.peek(8).readUInt32BE(4);
    if (length > OPERATOR_RFB_MAX_CUT_TEXT_BYTES) {
      return this.desync('cut-text-too-large', `${length}b`);
    }
    if (this.q.size < 8 + length) return null;
    this.q.drop(8);
    return { type: 'cut-text', text: this.q.take(length).toString('latin1') };
  }

  // ── Compositing ───────────────────────────────────────────────────────────

  /**
   * Allocate a zeroed framebuffer WITHOUT touching the committed geometry.
   *
   * ── WHY THIS IS PURE, AND THE DEFECT THAT MADE IT SO (audit D2, 2026-11-02) ──
   * The first cut assigned `this.width`/`this.height` here and left the callers
   * to treat that assignment as "the canvas is now this size". The grow path
   * then computed the OLD stride as `old.length / (this.height * bpp)` — but by
   * that line `this.height` was already the NEW height, so the divisor was
   * wrong and every preserved scan line was copied from the wrong offset.
   *
   * Measured on the shipped code: a 4x4 canvas filled R=200 grown to 6x6 came
   * back as row0 `200,200,0,0,0,0` and row1 `0,0,0,0,0,0` — the second row of
   * the old image was read from 9 bytes into a 64-byte buffer instead of 16,
   * so the image was scattered rather than resized.
   *
   * The fix is structural rather than arithmetic: allocation and geometry
   * COMMITMENT are now two separate steps, so a caller literally cannot read
   * the new dimensions before deciding what the old ones were. `commitGeometry`
   * is the only writer of `this.width`/`this.height`.
   */
  private allocate(width: number, height: number): Buffer | null {
    if (!isValidDimension(width) || !isValidDimension(height)) return null;
    const bytes = width * height * OPERATOR_RFB_BYTES_PER_PIXEL;
    if (bytes > OPERATOR_RFB_MAX_FRAMEBUFFER_BYTES) return null;
    return Buffer.alloc(bytes);
  }

  /** Adopt a framebuffer AND the geometry it was allocated for, together. */
  private commitGeometry(buffer: Buffer, width: number, height: number): void {
    this.framebuffer = buffer;
    this.width = width;
    this.height = height;
  }

  private applyRect(ev: Extract<OperatorServerEvent, { type: 'rect' }>): void {
    try {
      if (ev.encoding === OPERATOR_RFB_ENCODING_DESKTOP_SIZE) {
        // A resize CLEARS the canvas: the pixels of the old geometry have no
        // meaning at the new one, and a half-stale composite is worse than a
        // visible blank the next rectangle fills.
        const blank = this.allocate(ev.width, ev.height);
        if (blank) this.commitGeometry(blank, ev.width, ev.height);
        return;
      }

      // ── CopyRect: a MOVE within the framebuffer, no pixels on the wire ─────
      // Applied FIRST, and against a snapshot of the source region, because the
      // copy is allowed to OVERLAP its destination (a scroll is exactly that).
      // Copying row-by-row straight out of the live framebuffer would smear the
      // first rows over the ones still to be read — the classic memmove bug.
      if (ev.encoding === OPERATOR_RFB_ENCODING_COPY_RECT) {
        this.applyCopyRect(ev);
        return;
      }

      // Raw and Hextile both arrive as wire-order pixels (`decodeHextile…`
      // produces the same layout), so they composite through ONE path. A
      // second pixel path would be a second place for the stride to be wrong.
      const isPixelRect =
        (ev.encoding === OPERATOR_RFB_ENCODING_RAW ||
          ev.encoding === OPERATOR_RFB_ENCODING_HEXTILE ||
          ev.encoding === OPERATOR_RFB_ENCODING_TIGHT) &&
        !!ev.pixels;
      if (!isPixelRect) return;
      const pixels = ev.pixels;
      if (!pixels) return;

      if (!this.framebuffer) {
        // First rectangle defines the canvas, grown to cover it.
        const w = Math.max(1, ev.x + ev.width);
        const h = Math.max(1, ev.y + ev.height);
        const fresh = this.allocate(w, h);
        if (!fresh) return;
        this.commitGeometry(fresh, w, h);
      } else if (ev.x + ev.width > this.width || ev.y + ev.height > this.height) {
        // A rectangle outside the known canvas GROWS it rather than being lost.
        //
        // D2: the old geometry is read BEFORE anything is committed, so the
        // source stride is the stride the old buffer actually has.
        const oldW = this.width;
        const oldH = this.height;
        const w = Math.max(oldW, ev.x + ev.width);
        const h = Math.max(oldH, ev.y + ev.height);
        const grown = this.allocate(w, h);
        if (!grown) return; // over the ceiling: keep the screen we have
        // Blit the old scan lines in, row by row (the stride changed).
        const old = this.framebuffer;
        const oldStride = oldW * OPERATOR_RFB_BYTES_PER_PIXEL;
        const keepRows = Math.min(h, oldH);
        for (let row = 0; row < keepRows; row++) {
          old.copy(
            grown,
            row * w * OPERATOR_RFB_BYTES_PER_PIXEL,
            row * oldStride,
            row * oldStride + oldStride,
          );
        }
        this.commitGeometry(grown, w, h);
      }

      const bpp = OPERATOR_RFB_BYTES_PER_PIXEL;
      const fb = this.framebuffer;
      if (!fb) return;

      // Clip instead of throwing: a slightly-too-large rectangle is a bug to
      // survive, not a reason to drop a live session (RFC 6143 §7.7.1).
      const x0 = Math.max(0, ev.x);
      const y0 = Math.max(0, ev.y);
      const x1 = Math.min(this.width, ev.x + ev.width);
      const y1 = Math.min(this.height, ev.y + ev.height);
      if (x1 <= x0 || y1 <= y0) return;

      const spanBytes = (x1 - x0) * bpp;
      for (let row = y0; row < y1; row++) {
        // Source stride is the RECTANGLE width, not the screen width — the
        // classic off-by-a-row bug, so it is computed from ev.width explicitly.
        const srcOff = ((row - ev.y) * ev.width + (x0 - ev.x)) * bpp;
        const dstOff = (row * this.width + x0) * bpp;
        pixels.copy(fb, dstOff, srcOff, srcOff + spanBytes);
      }
      this.rectsApplied += 1;
    } catch {
      // A refused allocation must not throw into a pump holding a session open.
    }
  }

  /**
   * Apply a CopyRect: move a region of the framebuffer onto another region
   * (RFC 6143 §7.7.2). No pixels travel — the server is telling us "those
   * pixels you already have are now here", which is what a window drag or a
   * scroll becomes on the wire.
   *
   * ── WHY THE SOURCE IS SNAPSHOTED FIRST ─────────────────────────────────────
   * The copy may OVERLAP its own destination; a scrolled toolbar is exactly
   * that, and it is the common case. Copying straight from the live buffer
   * forward would read bytes already overwritten by an earlier row of the same
   * copy — the classic memmove aliasing bug — and it produces a picture that
   * looks almost right, which is the worst kind of wrong. Reading the source
   * into its own buffer first makes the operation order-independent.
   *
   * A destination outside the known canvas is CLIPPED rather than grown: unlike
   * a pixel rect, a CopyRect carries no pixels to grow the canvas WITH, so there
   * would be nothing but blank to put there.
   */
  private applyCopyRect(ev: Extract<OperatorServerEvent, { type: 'rect' }>): void {
    const fb = this.framebuffer;
    const srcX0 = ev.copySrcX;
    const srcY0 = ev.copySrcY;
    if (!fb || typeof srcX0 !== 'number' || typeof srcY0 !== 'number') return;
    const bpp = OPERATOR_RFB_BYTES_PER_PIXEL;

    // Clip the DESTINATION to the canvas.
    const dx0 = Math.max(0, ev.x);
    const dy0 = Math.max(0, ev.y);
    const dx1 = Math.min(this.width, ev.x + ev.width);
    const dy1 = Math.min(this.height, ev.y + ev.height);
    if (dx1 <= dx0 || dy1 <= dy0) return;

    // The source rectangle is offset by however much the destination was
    // clipped, so the two stay in register.
    const sx0 = srcX0 + (dx0 - ev.x);
    const sy0 = srcY0 + (dy0 - ev.y);

    // Clip the SOURCE to the canvas as well: a Rect may legitimately name a
    // region the initial full-screen update never covered, and reading past the
    // buffer would throw out of the pump.
    const copyW = Math.min(dx1 - dx0, this.width - sx0);
    const copyH = Math.min(dy1 - dy0, this.height - sy0);
    if (copyW <= 0 || copyH <= 0) return;

    // Snapshot the source region row by row BEFORE writing anything.
    const spanBytes = copyW * bpp;
    const snapshot = Buffer.alloc(spanBytes * copyH);
    for (let row = 0; row < copyH; row++) {
      const from = ((sy0 + row) * this.width + sx0) * bpp;
      fb.copy(snapshot, row * spanBytes, from, from + spanBytes);
    }
    for (let row = 0; row < copyH; row++) {
      const to = ((dy0 + row) * this.width + dx0) * bpp;
      snapshot.copy(fb, to, row * spanBytes, row * spanBytes + spanBytes);
    }
    this.rectsApplied += 1;
  }

  /** The rendered screen, or null before any geometry has arrived. */
  snapshot(): OperatorScreenSnapshot | null {
    if (!this.framebuffer) return null;
    const pixelCount = this.width * this.height;
    if (pixelCount <= 0) return null;
    const rgba = operatorWirePixelsToRgba(this.framebuffer, pixelCount);
    return {
      width: this.width,
      height: this.height,
      rgba,
      sha256: createHash('sha256').update(rgba).digest('hex'),
      rectsApplied: this.rectsApplied,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering the snapshot as something a screen can actually show
// ─────────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 (IEEE 802.3) — the PNG chunk checksum, no table required. */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Encode an RGBA snapshot as a PNG (8-bit RGB, no alpha — a screen is opaque).
 *
 * WHY PNG AND NOT RAW. This is the difference between "the operator can inspect
 * a buffer" and "the operator sees a screen". An <img> tag needs an image, and
 * a raw 1280×800 RGBA body is 4 MB per frame over a route that is already
 * long-polling. PNG is pure zlib, which Node ships — no new dependency, nothing
 * to keep patched.
 */
export function encodeOperatorScreenPng(snapshot: OperatorScreenSnapshot): Buffer {
  const { width, height, rgba } = snapshot;
  // Each scan line is a filter byte (0 = None) followed by RGB triples.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const dstRow = y * (stride + 1);
    raw[dstRow] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = dstRow + 1 + x * 3;
      raw[d] = rgba[s];
      raw[d + 1] = rgba[s + 1];
      raw[d + 2] = rgba[s + 2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour (RGB)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Operator → device: input encoding outbound
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PointerEvent — RFC 6143 §7.5.5: type(5) button-mask(1) x(2) y(2).
 *
 * `buttonMask` bits 0..7 are buttons 1..8; 0 means "move with nothing held".
 * Coordinates are in the FITTED image space the operator is looking at, which
 * is exactly what the device primes its geometry with (audit F2) — so an
 * encoded click at (x, y) lands at (x, y).
 */
export function encodeOperatorPointerEvent(buttonMask: number, x: number, y: number): Buffer {
  const b = Buffer.alloc(6);
  b[0] = OPERATOR_RFB_CLIENT_POINTER_EVENT;
  b[1] = buttonMask & 0xff;
  b.writeUInt16BE(x & 0xffff, 2);
  b.writeUInt16BE(y & 0xffff, 4);
  return b;
}

/** KeyEvent — RFC 6143 §7.5.4: type(4) down-flag(1) padding(2) keysym(4). */
export function encodeOperatorKeyEvent(keysym: number, down: boolean): Buffer {
  const b = Buffer.alloc(8);
  b[0] = OPERATOR_RFB_CLIENT_KEY_EVENT;
  b[1] = down ? 1 : 0;
  b.writeUInt32BE(keysym >>> 0, 4);
  return b;
}

/** SetPixelFormat is never sent by this client: we accept the device's format. */

/** SetEncodings — RFC 6143 §7.5.2: type(2) padding(1) count(2) then S32 each. */
export function encodeOperatorSetEncodings(encodings: number[]): Buffer {
  const b = Buffer.alloc(4 + encodings.length * 4);
  b[0] = OPERATOR_RFB_CLIENT_SET_ENCODINGS;
  b[1] = 0;
  b.writeUInt16BE(encodings.length, 2);
  encodings.forEach((e, i) => b.writeInt32BE(e, 4 + i * 4));
  return b;
}

/** FramebufferUpdateRequest — RFC 6143 §7.5.3: 10 bytes. */
export function encodeOperatorUpdateRequest(opts: {
  incremental: boolean;
  x?: number;
  y?: number;
  width: number;
  height: number;
}): Buffer {
  const b = Buffer.alloc(10);
  b[0] = OPERATOR_RFB_CLIENT_FRAMEBUFFER_UPDATE_REQUEST;
  b[1] = opts.incremental ? 1 : 0;
  b.writeUInt16BE((opts.x ?? 0) & 0xffff, 2);
  b.writeUInt16BE((opts.y ?? 0) & 0xffff, 4);
  b.writeUInt16BE(opts.width & 0xffff, 6);
  b.writeUInt16BE(opts.height & 0xffff, 8);
  return b;
}

/**
 * Split client bytes into relay payloads.
 *
 * `maxBytes` must be the BACKEND's frame ceiling: an operator frame that
 * exceeds it is refused as `frame-too-large` before it ever reaches the device,
 * which in the field looks like "my clicks stopped working" with nothing in the
 * log. Input events are 6-8 bytes so this never splits in practice — but the
 * chunker is the same one the screen path uses, so there is one rule, not two.
 */
export function chunkOperatorBytes(bytes: Buffer, maxBytes: number): string[] {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new RangeError(`chunkOperatorBytes: maxBytes must be positive, got ${maxBytes}`);
  }
  const out: string[] = [];
  for (let off = 0; off < bytes.length; off += maxBytes) {
    out.push(bytes.subarray(off, Math.min(off + maxBytes, bytes.length)).toString('base64'));
  }
  return out;
}

/**
 * One operator gesture, ready for the relay: the RFB client bytes plus the
 * payload(s) to push. Pure, so the route handler stays a thin adapter.
 */
export interface OperatorInputPlan {
  /** Which gesture this is, for the audit line and for tests. */
  kind: 'pointer' | 'key';
  /** Base64 relay payloads, in order. */
  payloads: string[];
  /** The raw client bytes, before chunking. */
  bytes: Buffer;
}

/**
 * Plan a pointer gesture. `buttonMask` 0 = a hover/move, non-zero = a press of
 * those buttons (1 = left, 2 = middle, 4 = right).
 *
 * Coordinates are clamped to the RFB 16-bit field rather than wrapped: a click
 * at 70000 on a 1280-wide screen is a client bug, and silently wrapping it to
 * 4464 would put the click somewhere the operator did not point.
 */
export function planOperatorPointer(
  x: number,
  y: number,
  buttonMask = 0,
  maxBytes: number,
): OperatorInputPlan {
  const cx = Math.max(0, Math.min(0xffff, Math.round(Number.isFinite(x) ? x : 0)));
  const cy = Math.max(0, Math.min(0xffff, Math.round(Number.isFinite(y) ? y : 0)));
  const mask = Number.isFinite(buttonMask) ? Math.round(buttonMask) & 0xff : 0;
  const bytes = encodeOperatorPointerEvent(mask, cx, cy);
  return { kind: 'pointer', payloads: chunkOperatorBytes(bytes, maxBytes), bytes };
}

/** Plan a key gesture (keysym per RFC 6143 §7.5.4). */
export function planOperatorKey(keysym: number, down: boolean, maxBytes: number): OperatorInputPlan {
  const ks = Number.isFinite(keysym) ? Math.max(0, Math.min(0xffffffff, Math.floor(keysym))) : 0;
  const bytes = encodeOperatorKeyEvent(ks, down);
  return { kind: 'key', payloads: chunkOperatorBytes(bytes, maxBytes), bytes };
}
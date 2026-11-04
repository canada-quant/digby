/**
 * ── RFB CLIENT HANDSHAKE + THE ENCODING ADVERTISEMENT (ticket c468f922) ─────
 *
 * WHY THIS FILE EXISTS AT ALL — the post-merge review of PR #2341 found the
 * backend's Windows/RFB decoder was NEVER REACHABLE, and it was right. Two
 * independent breaks, both verified at source before this file was written:
 *
 *   1. NOBODY ADVERTISED ANYTHING. `encodeOperatorSetEncodings` and
 *      `encodeSetEncodings` existed but had ZERO production callers — only
 *      tests. RFC 6143 §7.5.2 is explicit: "The encoding-type is the encoding
 *      in which the pixel data is sent" and the server chooses from what the
 *      client listed ("The server may or may not choose to make use of this
 *      hint"). A server that was never told about Hextile (5), CopyRect (1) or
 *      the LastRect extension (-224) has no reason to ever emit them. So the
 *      backend grew a decoder for encodings NO SERVER WOULD SEND.
 *
 *   2. NO RFB SESSION WAS EVER ESTABLISHED. `OperatorScreenDecoder` is fed from
 *      the relay queue. Nothing on a Windows PC ever put an RFB server's bytes
 *      in that queue — `queueRelayFrame` had no callers at all ("Deliberately
 *      NOT wired to capture/input yet"), and the macOS agent's `sendScreen`
 *      emits Raw only. Every byte that reached the decoder was Raw, so the
 *      Hextile/CopyRect/LastRect paths were dead code on a live stream.
 *
 * This module is the missing CLIENT half, in protocol terms: the RFB 3.8
 * handshake a real client must perform, and the SetEncodings message that makes
 * the backend's decoder reachable. It owns NO socket — `push` takes server
 * bytes and returns the bytes to write back — so it is pure, testable on Linux
 * CI, and cannot itself block a poll loop.
 *
 * ── THE DRIFT GUARD, WHICH IS THE POINT ────────────────────────────────────
 * The advertisement is DERIVED from `DECODABLE_ENCODINGS`, never hand-written
 * at a call site. A future lane that adds a decoder must add its encoding
 * THERE; a lane that advertises something it cannot decode is refused by
 * `assertAdvertisable`. The failure mode this prevents is exactly the one the
 * review caught: a decoder and an advertisement drifting apart, leaving one of
 * them dead and every test still green.
 *
 * ── WHAT THIS DOES NOT DO (stated, not glossed) ────────────────────────────
 *   - It does not implement VNC authentication (RFB security type 2, DES). It
 *     selects security type None (1) and REFUSES a server that offers only
 *     VncAuth, rather than pretending. The operator channel reaches the host
 *     over the tailnet, so the transport is the auth boundary here.
 *   - It does not decode anything: it is the client, and decoding is the
 *     backend's `relay-operator-viewer.ts`. This module's job is to make that
 *     decoder reachable and to keep the two honest about the same list.
 *   - It does not capture the Windows desktop. It tunnels an RFB server that
 *     already runs on the PC (127.0.0.1:5900, the port the firewall already
 *     scopes to the tunnel interface) — see `relay-rfb.ts`.
 */

/** RFB 3.8 — the version this client speaks and the only one it accepts. */
export const RFB_VERSION_STRING = 'RFB 003.008\n';

/** Client message type 2: SetEncodings. RFC 6143 §7.5.2. */
export const RFB_CLIENT_MSG_SET_ENCODINGS = 2;

// ── Encoding ids (RFC 6143 §7.7 table + §8.4 IANA registry) ────────────────
export const RFB_ENCODING_RAW = 0;
export const RFB_ENCODING_COPY_RECT = 1;
export const RFB_ENCODING_HEXTILE = 5;
/**
 * Tight (rfbproto "Tight Encoding").
 *
 * The one that decides whether a real Windows host renders: TightVNC and
 * TigerVNC both PREFER it, so it leads the advertisement.
 */
export const RFB_ENCODING_TIGHT = 7;
/** Pseudo-encoding: framebuffer resize. §7.7.5. */
export const RFB_ENCODING_DESKTOP_SIZE = -223;
/** Pseudo-encoding: end-of-update marker (widespread pre-RFC extension). */
export const RFB_ENCODING_LAST_RECT = -224;

/**
 * THE SINGLE SOURCE OF TRUTH for "what this client may tell a server to send".
 *
 * Order IS the preference §7.5.2 describes: TightVNC's server takes "the first
 * normal encoding in the client's list" as its preferred encoding, and TigerVNC
 * does the same.
 *
 * ── WHY TIGHT NOW LEADS ────────────────────────────────────────────────────
 * Hextile used to lead, and that was correct while Tight was a follow-on slice.
 * It is no longer free: both TightVNC and TigerVNC PREFER Tight, so listing
 * Hextile first ORDERED them to send the more expensive encoding on every
 * update, and a host configured to force Tight (`-encoding tight`, the common
 * bandwidth-constrained default) had no legal way to answer us except with a
 * rect we refused as `unsupported-encoding` — the operator saw an undecodable
 * stream instead of a desktop. The decoder now exists and is pinned, so the
 * preference is honest.
 */
export const DECODABLE_ENCODINGS: readonly number[] = [
  RFB_ENCODING_TIGHT,
  RFB_ENCODING_HEXTILE,
  RFB_ENCODING_COPY_RECT,
  RFB_ENCODING_RAW,
];

/**
 * Pseudo-encodings are advertised the same way (§7.5.2 covers them: "-223 …
 * these are not really encodings … but are sent in SetEncodings"). DesktopSize
 * lets the server resize us; LastRect lets it send an unbounded rect list, which
 * is what makes a multi-rect dirty-region update decodable without guessing.
 */
export const DECODABLE_PSEUDO_ENCODINGS: readonly number[] = [RFB_ENCODING_DESKTOP_SIZE, RFB_ENCODING_LAST_RECT];

/** The ordered list a real client sends. Derived — never hand-written. */
export function advertisedEncodings(): number[] {
  return [...DECODABLE_ENCODINGS, ...DECODABLE_PSEUDO_ENCODINGS];
}

/**
 * Refuse to advertise an encoding this client has no decoder for.
 *
 * A plain "is it in the list" check over the constants above would be circular
 * and prove nothing, so this takes the list to SEND and validates it against
 * what we claim to decode. Called at build time of the message, so a bad list
 * fails loudly here instead of becoming an undecodable stream in the field.
 */
export function assertAdvertisable(encodings: readonly number[]): void {
  const known = new Set([...DECODABLE_ENCODINGS, ...DECODABLE_PSEUDO_ENCODINGS]);
  for (const e of encodings) {
    if (!known.has(e)) {
      throw new Error(`refusing to advertise encoding ${e}: no decoder claims it`);
    }
  }
}

/** SetEncodings — type(1) padding(1) count(2) then S32 per encoding. §7.5.2. */
export function encodeSetEncodings(encodings: readonly number[]): Buffer {
  assertAdvertisable(encodings);
  const buf = Buffer.alloc(4 + encodings.length * 4);
  buf.writeUInt8(RFB_CLIENT_MSG_SET_ENCODINGS, 0);
  buf.writeUInt8(0, 1); // padding
  buf.writeUInt16BE(encodings.length, 2);
  encodings.forEach((e, i) => buf.writeInt32BE(e, 4 + i * 4));
  return buf;
}

/** The advertisement this client sends once a session is up. */
export function encodeEncodingAdvertisement(): Buffer {
  return encodeSetEncodings(advertisedEncodings());
}

/** PointerEvent (type 5) — the operator's mouse. §7.5.3. */
export function encodePointerEvent(buttonMask: number, x: number, y: number): Buffer {
  const buf = Buffer.alloc(6);
  buf.writeUInt8(5, 0);
  buf.writeUInt8(buttonMask & 0xff, 1);
  buf.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(x))), 2);
  buf.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(y))), 4);
  return buf;
}

/** KeyEvent (type 4) — the keyboard. §7.5.4. */
export function encodeKeyEvent(keysym: number, down: boolean): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt8(4, 0);
  buf.writeUInt8(down ? 1 : 0, 1);
  buf.writeUInt16BE(0, 2); // padding
  buf.writeUInt32BE(keysym >>> 0, 4);
  return buf;
}

/**
 * FramebufferUpdateRequest (type 3). RFC 6143 §7.5.1.
 *
 * ── WHY THIS IS PART OF THE FIX, NOT AN EXTRA ──────────────────────────────
 * A server sends NO pixel data until one of these arrives: "the server sends a
 * FramebufferUpdate when the request has been satisfied". The backend already
 * owned an encoder for this (`encodeOperatorUpdateRequest`) and, like
 * SetEncodings, had ZERO production callers — so even a perfectly negotiated
 * session would sit silent forever. A pump that advertises encodings but never
 * asks for a frame reproduces the same defect one step later.
 */
export function encodeFramebufferUpdateRequest(opts: {
  incremental: boolean;
  width: number;
  height: number;
}): Buffer {
  const buf = Buffer.alloc(10);
  buf.writeUInt8(3, 0);
  buf.writeUInt8(opts.incremental ? 1 : 0, 1);
  buf.writeUInt16BE(0, 2); // x-position
  buf.writeUInt16BE(0, 4); // y-position
  buf.writeUInt16BE(Math.max(1, Math.min(0xffff, opts.width)), 6);
  buf.writeUInt16BE(Math.max(1, Math.min(0xffff, opts.height)), 8);
  return buf;
}

/** ClientInit (1 byte): shared-flag. §7.3.1. */
export const RFB_CLIENT_INIT_SHARED = Buffer.from([1]);

export type RfbHandshakePhase =
  | 'await-protocol-version'
  | 'await-security-types'
  | 'await-security-result'
  | 'await-server-init'
  | 'ready'
  | 'failed';

/** RFB security types we understand. 1 = None. 2 = VncAuth, deliberately not implemented. */
export const RFB_SECURITY_NONE = 1;
export const RFB_SECURITY_VNC_AUTH = 2;

export interface RfbServerInfo {
  width: number;
  height: number;
  name: string;
}

/**
 * The RFB 3.8 client handshake, as a pure state machine.
 *
 * RFC 6143 §7.1.1/§7.1.2 order:
 *   S→C ProtocolVersion → C→S ProtocolVersion
 *   S→C SecurityTypes   → C→S the chosen type (1 byte)
 *   S→C SecurityResult  → C→S ClientInit
 *   S→C ServerInit      → C→S SetEncodings (ours; RFC does not mandate it here
 *                          but EVERY real server requires it before it will
 *                          send anything but Raw — which is the whole point)
 *
 * `push()` returns the bytes to write back, or an empty buffer when it needs
 * more. It never throws on hostile input: a malformed server is a `failed`
 * phase, because a socket reader must not be able to take the process down.
 */
export class RfbClientHandshake {
  private phase: RfbHandshakePhase = 'await-protocol-version';
  private q: Buffer = Buffer.alloc(0);
  private failureReason: string | null = null;
  private server: RfbServerInfo | null = null;
  /** The SetEncodings bytes actually sent — pinned by tests, never guessed. */
  private advertisementSent: Buffer | null = null;

  get currentPhase(): RfbHandshakePhase {
    return this.phase;
  }

  get failure(): string | null {
    return this.failureReason;
  }

  get serverInfo(): RfbServerInfo | null {
    return this.server;
  }

  /** The exact SetEncodings message this client put on the wire (null before ready). */
  get advertisement(): Buffer | null {
    return this.advertisementSent;
  }

  private fail(reason: string): Buffer {
    this.phase = 'failed';
    this.failureReason = reason;
    return Buffer.alloc(0);
  }

  /**
   * Read the failed phase through a method, not a field comparison.
   *
   * TypeScript's control-flow analysis narrows `this.phase` across a call to
   * `step()` that it cannot see mutating it, so an inline `=== 'failed'` check
   * here is reported as an impossible comparison. The check is real and load
   * bearing (that is how a hostile server stops the loop), so the accessor
   * keeps the behaviour and tells the compiler the truth.
   */
  private isFailed(): boolean {
    return this.phase === 'failed';
  }

  /** Feed server bytes; returns the client bytes to send in response. */
  push(chunk: Buffer | Uint8Array): Buffer {
    if (this.isFailed()) return Buffer.alloc(0);
    this.q = this.q.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.q, Buffer.from(chunk)]);

    let out = Buffer.alloc(0);
    // Loop: one push can complete several phases (a fast local server batches).
    for (;;) {
      const step = this.step();
      if (step === null) break;
      if (this.isFailed()) return out;
      if (step.length > 0) out = Buffer.concat([out, step]);
      if (this.phase === 'ready') break;
    }
    return out;
  }

  /** One phase transition. Returns client bytes, or null when more input is needed. */
  private step(): Buffer | null {
    switch (this.phase) {
      case 'await-protocol-version': {
        if (this.q.length < 12) return null;
        const version = this.q.subarray(0, 12).toString('latin1');
        this.q = this.q.subarray(12);
        // We speak 3.8 only. 3.3/3.7 lack the security-types list this parser
        // reads, so accepting them would mean guessing — refuse instead.
        if (version !== RFB_VERSION_STRING) {
          return this.fail(`unsupported RFB version "${version.trim()}" (this client speaks 3.8 only)`);
        }
        this.phase = 'await-security-types';
        return Buffer.from(RFB_VERSION_STRING, 'latin1');
      }

      case 'await-security-types': {
        if (this.q.length < 1) return null;
        const count = this.q.readUInt8(0);
        if (count === 0) {
          // §7.1.2: zero types means the server is about to hang up; it sends
          // a reason string we surface rather than reporting a bare failure.
          if (this.q.length < 5) return null;
          const len = this.q.readUInt32BE(1);
          if (this.q.length < 5 + len) return null;
          const reason = this.q.subarray(5, 5 + len).toString('latin1');
          return this.fail(`server refused the connection: ${reason}`);
        }
        if (this.q.length < 1 + count) return null;
        const types = Array.from(this.q.subarray(1, 1 + count));
        this.q = this.q.subarray(1 + count);
        if (!types.includes(RFB_SECURITY_NONE)) {
          const offered = types
            .map((t) => (t === RFB_SECURITY_VNC_AUTH ? 'VncAuth(2)' : String(t)))
            .join(', ');
          return this.fail(
            `server offers no "None" security type (offered: ${offered}); VncAuth is not implemented`,
          );
        }
        this.phase = 'await-security-result';
        return Buffer.from([RFB_SECURITY_NONE]);
      }

      case 'await-security-result': {
        if (this.q.length < 4) return null;
        const result = this.q.readUInt32BE(0);
        this.q = this.q.subarray(4);
        if (result !== 0) {
          // §7.1.2: on failure the server follows with a reason string. Take it
          // when it is all here; a short read is not worth stalling the handshake.
          if (this.q.length >= 4) {
            const len = this.q.readUInt32BE(0);
            if (this.q.length >= 4 + len) return this.fail(`security handshake failed: ${this.q.subarray(4, 4 + len).toString('latin1')}`);
          }
          return this.fail('security handshake failed');
        }
        this.phase = 'await-server-init';
        return RFB_CLIENT_INIT_SHARED;
      }

      case 'await-server-init': {
        if (this.q.length < 24) return null;
        const width = this.q.readUInt16BE(0);
        const height = this.q.readUInt16BE(2);
        const nameLen = this.q.readUInt32BE(20);
        if (this.q.length < 24 + nameLen) return null;
        const name = this.q.subarray(24, 24 + nameLen).toString('latin1');
        this.q = this.q.subarray(24 + nameLen);
        this.server = { width, height, name };
        this.phase = 'ready';
        // THE MESSAGE THE REVIEW FOUND NOBODY SENT.
        this.advertisementSent = encodeEncodingAdvertisement();
        return this.advertisementSent;
      }

      default:
        return null;
    }
  }
}
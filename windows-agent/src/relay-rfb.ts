/**
 * ── RELAY ↔ RFB CARRIER (ticket c468f922) ──────────────────────────────────
 *
 * The post-merge review of PR #2341 found the backend's Windows/RFB decoder was
 * never reachable, and named the reason: the relay had "a server and NO CLIENT".
 * `windows-agent/src/index.ts` said so in its own words —
 *
 *     "Deliberately NOT wired to capture/input yet. … Wiring a fake screen
 *      producer in here would make it look finished while carrying nothing
 *      anyone can use."
 *
 * This module is that missing wire. It does exactly one job: connect to the RFB
 * server already running on this PC, perform the client handshake, ASK for a
 * frame, and hand the server's own bytes to the relay. Nothing here synthesises
 * pixels — every byte forwarded came off a real socket — so the backend decoder
 * is exercising its Hextile/CopyRect/LastRect paths against a real server or it
 * is not running at all.
 *
 * ── WHY THE HANDSHAKE LIVES IN THIS PROCESS AND NOT SERVER-SIDE ─────────────
 * The backend cannot open a socket to this PC (no inbound port; that is the
 * ruling's core property). So the PC must be the one that negotiates, which
 * makes this the only place where the FIX for "nobody advertised the encodings"
 * can legitimately live.
 *
 * ── IO IS INJECTED ─────────────────────────────────────────────────────────
 * No `net` import. `openSocket` is a seam, so the whole negotiation is testable
 * on Linux CI against an in-process fake RFC 6143 server — including the pin
 * that the server picks Hextile ONLY because we offered it. A real socket is
 * supplied by `nodeSocketOpener()`.
 */

import {
  RfbClientHandshake,
  advertisedEncodings,
  encodeFramebufferUpdateRequest,
  encodeKeyEvent,
  encodePointerEvent,
  RFB_ENCODING_HEXTILE,
} from './rfb-client';

/**
 * The minimum socket surface this module needs. Deliberately tiny: `onData` and
 * `onClose` are observers, so a transport that delivers both synchronously
 * (a test fixture) and asynchronously (a real socket) behaves identically.
 */
export interface RfbSocket {
  write(bytes: Buffer): void;
  close(): void;
}

export type RfbSocketOpener = (opts: {
  host: string;
  port: number;
  onData: (chunk: Buffer) => void;
  onClose: (reason: string) => void;
}) => Promise<RfbSocket>;

/** Where the PC's own RFB server listens. Same port the PF/firewall anchor scopes. */
export const DEFAULT_RFB_HOST = '127.0.0.1';
export const DEFAULT_RFB_PORT = 5900;

/** One frame's worth of carried bytes, already base64 for the relay. */
export interface CarriedChunk {
  payloadB64: string;
}

export interface RfbCarrierOptions {
  /** The RFB server to dial — normally the PC itself. */
  host?: string;
  port?: number;
  openSocket: RfbSocketOpener;
  /** Hand a chunk of server bytes to the relay. Best-effort; may throw. */
  emit: (chunk: CarriedChunk) => void;
  /** Observable log seam (never throws into the socket callbacks). */
  log?: (line: string) => void;
  /**
   * Coalescing window before the NEXT FramebufferUpdateRequest is sent after
   * server bytes arrive. Defaults to `CARRIER_REQUEST_COALESCE_MS`; tests pass 0.
   */
  requestCoalesceMs?: number;
}

/**
 * How long to wait after server bytes before asking for the next frame.
 *
 * ── WHY A RE-REQUEST LOOP EXISTS AT ALL (review finding D1) ────────────────
 * RFC 6143 §7.5.1 is unambiguous: a server sends a FramebufferUpdate ONLY in
 * response to a FramebufferUpdateRequest. The first cut of this carrier sent
 * exactly ONE request, at handshake (`requestFrame({incremental:false})`), and
 * there was no second call site anywhere in the production tree. So the live
 * carrier delivered one screen and then went permanently silent, while the
 * backend route kept rendering that same first frame as `partial: false` — the
 * "stale screen reported current" lie this whole ticket exists to kill, in its
 * Windows form.
 *
 * The coalesce window matters for the same reason a bare loop would be wrong:
 * a 1920x1200 screen arrives as ~141 relay-sized chunks, and requesting after
 * EVERY chunk would multiply request traffic by the chunk count for no gain.
 */
export const CARRIER_REQUEST_COALESCE_MS = 120;

export type CarrierState = 'connecting' | 'handshaking' | 'carrying' | 'failed' | 'closed';

/**
 * Split a server byte stream into relay-sized chunks.
 *
 * ── WHY CHUNKING IS NOT A LOGGING DETAIL ───────────────────────────────────
 * `RELAY_MAX_FRAME_BYTES` caps a single frame, and a 1920x1080 Raw update is
 * several MB — bigger than the cap by itself. So a carried stream MUST be split
 * or the update is refused outright. The receiver already reassembles: its
 * decoder is a byte queue fed chunk by chunk, which is exactly what RFC 6143
 * requires of any RFB implementation ("there is no requirement that the
 * messages be sent in any particular way over the TCP stream … messages may be
 * split"). Boundaries between chunks are therefore meaningless to the codec —
 * which is why this can chunk on a fixed size without inventing framing.
 */
export const CARRIER_CHUNK_BYTES = 48 * 1024;

export function chunkForRelay(bytes: Buffer, max = CARRIER_CHUNK_BYTES): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < bytes.length; off += max) out.push(bytes.subarray(off, off + max));
  return out;
}

/**
 * Drive a carrier session over an injected socket opener.
 *
 * Returns a controller so a caller can push operator input and stop the session.
 * The handshake is the SAME `RfbClientHandshake` a real client uses — this
 * function adds only the socket plumbing and the frame requests.
 */
export async function runRfbCarrier(opts: RfbCarrierOptions): Promise<{
  state: CarrierState;
  handshake: RfbClientHandshake;
  /** Operator pointer input → PointerEvent on the wire. */
  pointer: (mask: number, x: number, y: number) => void;
  /** Operator key input → KeyEvent on the wire. */
  key: (keysym: number, down: boolean) => void;
  /** Ask for another (incremental) frame. */
  requestFrame: (opts?: { incremental?: boolean }) => void;
  /**
   * Forward already-encoded client bytes (an operator PointerEvent/KeyEvent
   * that arrived over the relay) straight to the RFB server.
   *
   * Deliberately raw: the backend already encoded those bytes, and decoding
   * them here only to re-encode them would create a second copy of the wire
   * format to keep in sync — the exact class of bug this slice is fixing.
   */
  write: (bytes: Buffer) => void;
  stop: () => void;
}> {
  const handshake = new RfbClientHandshake();
  const log = opts.log ?? (() => {});
  let state: CarrierState = 'connecting';
  let socket: RfbSocket | null = null;
  let closed = false;
  let requestedOnce = false;

  const emitBytes = (bytes: Buffer): void => {
    if (bytes.length === 0) return;
    for (const chunk of chunkForRelay(bytes)) {
      try {
        opts.emit({ payloadB64: chunk.toString('base64') });
      } catch (err) {
        // A relay failure must never unwind a socket callback: losing the
        // carrier is recoverable, throwing here would take the agent's whole
        // poll loop (and the command channel) with it.
        log(`carrier: emit failed — ${(err as Error).message}`);
      }
    }
  };

  // Read through accessors: `state` is narrowed by the early return below, and
  // the handshake call in between is not visibly mutating it to the compiler.
  const isCarrying = (): boolean => state === 'carrying';

  // ── THE RE-REQUEST LOOP (review finding D1) ──────────────────────────────
  // RFC 6143 §7.5.1: a server sends an update ONLY when asked. The first cut of
  // this carrier asked exactly once, at handshake, and had NO second call site
  // anywhere in the production tree — so the live session delivered one screen
  // and then went permanently silent while the backend kept re-rendering that
  // first frame as `partial: false`.
  //
  // The timer is COALESCED rather than fired per chunk: one 1920x1200 screen
  // arrives as ~141 relay-sized chunks, and re-requesting after every chunk
  // would multiply request traffic by the chunk count for no freshness gain.
  const coalesceMs = opts.requestCoalesceMs ?? CARRIER_REQUEST_COALESCE_MS;
  let requestTimer: ReturnType<typeof setTimeout> | null = null;
  let framesRequested = 0;

  const requestNext = (incremental: boolean): void => {
    if (!socket || !isCarrying()) return;
    const info = handshake.serverInfo;
    socket.write(
      encodeFramebufferUpdateRequest({
        incremental,
        width: info?.width ?? 0,
        height: info?.height ?? 0,
      }),
    );
    requestedOnce = true;
    framesRequested += 1;
  };

  const scheduleNextRequest = (): void => {
    if (closed || !isCarrying()) return;
    // Already scheduled: this arrival joins the pending request (coalescing).
    if (requestTimer !== null) return;
    requestTimer = setTimeout(() => {
      requestTimer = null;
      // Ask for the NEXT frame. Incremental is correct here: we already hold a
      // base, so the server may send only the dirty regions — which is exactly
      // the CopyRect/Hextile path this whole slice exists to decode.
      requestNext(true);
    }, coalesceMs);
    // Never hold the process open on a screen-refresh timer.
    const t = requestTimer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  };

  const onServerBytes = (chunk: Buffer): void => {
    if (closed) return;
    if (isCarrying()) {
      // Past the handshake every byte is framebuffer data: forward it verbatim.
      // The backend decoder owns interpretation; doing any here would mean two
      // codecs to keep in sync, which is how the original defect happened.
      emitBytes(chunk);
      // …and ask for the next update, or this was the only screen we ever send.
      scheduleNextRequest();
      return;
    }
    const toSend = handshake.push(chunk);
    if (handshake.currentPhase === 'failed') {
      state = 'failed';
      log(`carrier: handshake failed — ${handshake.failure}`);
      socket?.close();
      return;
    }
    if (toSend.length > 0) socket?.write(toSend);
    if (handshake.currentPhase === 'ready' && state !== 'carrying') {
      state = 'carrying';
      const info = handshake.serverInfo;
      log(
        `carrier: RFB session up ${info?.width ?? '?'}x${info?.height ?? '?'} — ` +
          `advertised [${advertisedEncodings().join(', ')}]`,
      );
      // The advertisement has just gone out with the handshake's last write, so
      // the server is entitled to answer with a non-Raw encoding. Ask for the
      // first full frame; without this the session negotiates and then sits
      // silent, which is the SAME "nobody asked" defect one layer along.
      requestNext(false);
    }
  };

  try {
    socket = await opts.openSocket({
      host: opts.host ?? DEFAULT_RFB_HOST,
      port: opts.port ?? DEFAULT_RFB_PORT,
      onData: onServerBytes,
      onClose: (reason) => {
        if (closed) return;
        closed = true;
        if (state !== 'failed') state = 'closed';
        log(`carrier: closed — ${reason}`);
      },
    });
    state = 'handshaking';
  } catch (err) {
    state = 'failed';
    log(`carrier: connect failed — ${(err as Error).message}`);
  }

  return {
    get state() {
      return state;
    },
    handshake,
    pointer: (mask, x, y) => {
      if (state === 'carrying') socket?.write(encodePointerEvent(mask, x, y));
    },
    key: (keysym, down) => {
      if (state === 'carrying') socket?.write(encodeKeyEvent(keysym, down));
    },
    write: (bytes: Buffer) => {
      if (state === 'carrying') socket?.write(bytes);
    },
    requestFrame: (req = {}) => requestNext(req.incremental === true),
    stop: () => {
      if (closed) return;
      closed = true;
      state = 'closed';
      // ── CANCEL THE PENDING RE-REQUEST (leak fix) ─────────────────────────
      // Without this, a timer armed by `scheduleNextRequest` outlives the
      // carrier and fires `requestNext` against a dead socket — and in a test
      // process a surviving timer is exactly what makes jest report "a worker
      // process has failed to exit gracefully". `unref()` keeps it from holding
      // the EVENT LOOP open, but it does not cancel the work.
      if (requestTimer !== null) {
        clearTimeout(requestTimer);
        requestTimer = null;
      }
      try {
        socket?.close();
      } catch {
        /* closing an already-dead socket is not an error worth surfacing */
      }
    },
  } as {
    state: CarrierState;
    handshake: RfbClientHandshake;
    pointer: (mask: number, x: number, y: number) => void;
    key: (keysym: number, down: boolean) => void;
    requestFrame: (opts?: { incremental?: boolean }) => void;
    write: (bytes: Buffer) => void;
    stop: () => void;
  };
}

/** True when a server-chosen rect encoding is one this carrier can rely on. */
export function isCarriedEncoding(encoding: number): boolean {
  return encoding === RFB_ENCODING_HEXTILE || encoding === 0 || encoding === 1;
}

/**
 * A real TCP socket opener.
 *
 * Kept out of the module's static imports so the whole file stays loadable in a
 * test that has no network at all — `require` happens only when this factory is
 * CALLED, which the Windows agent's start-up path is the sole caller of.
 */
export function nodeSocketOpener(): RfbSocketOpener {
  return async ({ host, port, onData, onClose }) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const net = require('node:net') as typeof import('node:net');
    return await new Promise<RfbSocket>((resolve, reject) => {
      const sock = net.connect({ host, port });
      sock.once('connect', () =>
        resolve({
          write: (bytes: Buffer) => {
            try {
              sock.write(bytes);
            } catch {
              /* a dead socket surfaces through onClose below */
            }
          },
          close: () => sock.destroy(),
        }),
      );
      sock.on('data', (chunk: Buffer) => {
        try {
          onData(chunk);
        } catch {
          /* a consumer bug must not kill the socket handler */
        }
      });
      sock.once('error', (err: Error) => {
        reject(err);
        onClose(err.message);
      });
      sock.once('close', () => onClose('socket closed'));
    });
  };
}
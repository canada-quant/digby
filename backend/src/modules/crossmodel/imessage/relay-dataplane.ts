/**
 * RELAY DATA PLANE — the session-CARRYING half of brokered remote access
 * (ticket c468f922, owner ruling 2026-10-29/30 on card oq_b5118c38:
 * "can we do option three but a little more secure like how it's just like
 * TeamViewer").
 *
 * ── WHAT WAS MISSING, AND WHY THIS FILE EXISTS ──────────────────────────────
 * `brokered-session.ts` AUTHORIZES a session and `brokered-session.store.ts`
 * makes that authorization durable and reportable. Neither CARRIES anything. A
 * lane could hold a perfectly valid grant and there was still no path for one
 * byte of screen or input to reach the other end: authorization without a data
 * plane is a signed permission slip for a road nobody built.
 *
 * That gap is exactly the defect class this ticket keeps re-learning (see
 * brokered-session.store.ts D1): a requirement that no live surface satisfies.
 * This module is the surface's brain.
 *
 * ── THE RULING'S PROPERTIES, AND WHERE EACH ONE LIVES ───────────────────────
 *   1. OUTBOUND-RELAYED, NO PERMANENTLY OPEN INBOUND PORT. Both ends LONG-POLL
 *      a queue the server owns (`GET …/frames`). The device never accepts a
 *      connection and the server never dials the device — the same dial-out
 *      model `agent-link.ts` established. This module opens no port, adds no
 *      listener and requires no ws upgrade, which is why it can ship without
 *      touching TLS termination or the ALB.
 *   2. PER-SESSION AUTH **ON TOP OF** the hardened pairing token. Three
 *      independent gates, all of which must pass before a byte moves:
 *        (a) the transport identity — `authenticateAgent` (device) or the JWT
 *            user (operator), unchanged from today;
 *        (b) the SESSION — a grant that is consumed, unclosed and inside its
 *            window, bound to the presenting device id and channel;
 *        (c) the CAPABILITY — a 32-byte secret minted when the session is
 *            opened, stored ONLY as a SHA-256 hash, compared in constant time.
 *      (c) is what makes a stolen/replayed `sessionId` useless on its own: the
 *      id names the session, the capability proves the caller was given it.
 *   3. ENCRYPTED TUNNEL. TLS terminates at the ALB for every hop; the relay
 *      adds no plaintext path. The frame payload is OPAQUE to this module — it
 *      never inspects, decodes into a string, or logs it.
 *   4. TIME-BOXED. The relay inherits the grant's window. It cannot outlive the
 *      session it belongs to, and `closed`/`stale` refuse immediately.
 *
 * ── THE DECISION THAT MAKES REPLAY STRUCTURALLY IMPOSSIBLE ─────────────────
 * THE SERVER ASSIGNS THE SEQUENCE NUMBER (Redis `INCR`), never the client. A
 * client-chosen `seq` would have to be validated against the receiver's
 * high-water mark to stop a replay — a check that is easy to get subtly wrong
 * across processes. Allocating server-side makes duplicate, reordered and
 * replayed frames unrepresentable rather than merely rejected: a replayed POST
 * simply gets the NEXT number and is delivered as new data, which is exactly
 * what a replayed request is. Deduplication is therefore not a feature this
 * module has to get right; it has no room to exist.
 *
 * ── NO CREDENTIAL, STRUCTURALLY (the property acceptance criterion 5 needs) ──
 * NOTHING here has a slot a password could ride in on: a frame is opaque bytes
 * plus a server-assigned counter, and the capability is a random session secret
 * that is never logged, never echoed and never stored in the clear. A VNC/RDP
 * credential passed in by mistake has nowhere to go. Pinned by test.
 *
 * Pure leaf: no Prisma / Redis / logger / fs / child_process, and no clock is
 * read — `now` is always a parameter, so the state machine is testable and its
 * answer never depends on when it runs. That is the same discipline
 * `brokered-session.ts` follows, and it lets the device-side planner and this
 * module answer from ONE definition.
 */

import { createHash, timingSafeEqual } from 'crypto';
import {
  type BrokeredSessionGrant,
  brokeredSessionState,
} from './brokered-session';
import type { RemoteChannel } from './remote-access-verdict';

/**
 * Hard ceiling on a single frame's decoded payload: 64 KiB.
 *
 * The transport is JSON-over-HTTPS (`express.json({limit:'75mb'})` at app
 * level), so an unbounded frame would be a memory amplifier: one authenticated
 * client could pin arbitrary heap per queued frame. A screen tile and an input
 * event both fit comfortably; a client that wants to send more sends more
 * frames, which is the point of having a frame boundary at all.
 */
export const RELAY_MAX_FRAME_BYTES = 64 * 1024;

/** How many frames one poll may return. Bounded so a single drain cannot pin
 *  the event loop, and so a slow reader cannot be starved by one fast writer. */
export const RELAY_MAX_FRAMES_PER_POLL = 32;

/** Hard cap on queued frames per direction. A peer that stops polling must not
 *  grow the queue without bound — this is the backstop that turns "nobody is
 *  reading" into a visible refusal instead of a memory leak with a delay. */
export const RELAY_QUEUE_MAX_FRAMES = 256;

/** Queue/sequence key lifetime. Refreshed on every write, and never longer than
 *  the longest session window plus the grant retention, so a dead session's
 *  transport state self-expires. */
export const RELAY_QUEUE_TTL_SEC = (3600 + 7 * 24 * 60 * 60) as number;

/** Bytes of entropy in a session capability: 32, matching the pairing token
 *  (`imessage.service.ts` completePairing generates `randomBytes(32)`). */
export const RELAY_CAPABILITY_BYTES = 32;

/**
 * The request header a session capability travels in — NEVER the URL.
 *
 * Found by independent review (2026-11-02) of the first cut, which took the
 * capability as a `?capability=` query parameter. That is a credential in a
 * URL, and it reaches places a body never does: the ALB's and nginx's access
 * logs, any proxy in the chain, `Referer` on a subsequent navigation, and the
 * browser history of whoever pasted it. The ticket's criterion 5 says no
 * credential is ever logged — a query-string secret makes that false the moment
 * the first poll lands, and no amount of care in OUR logger would fix it,
 * because the write happens in infrastructure we do not own.
 *
 * A header is the same wire cost and none of those exposures. `capability-in-url`
 * exists so an old client that still sends the query param is REFUSED loudly
 * rather than silently ignored (silently ignoring would send it hunting for a
 * different bug with a credential already in its access log).
 */
export const RELAY_CAPABILITY_HEADER = 'x-session-capability';

/**
 * Which way a frame is travelling, named from the OPERATOR's point of view so
 * a call site reads as intent ("send this TO the device") rather than as a
 * queue name. The two directions have SEPARATE queues and SEPARATE counters:
 * screen bytes and input events must never be able to consume each other's
 * numbers, or a busy stream on one side would skip the other's cursors.
 */
export type RelayDirection = 'to-device' | 'to-operator';

/** The only two directions, exported so a caller iterates the real set. */
export const RELAY_DIRECTIONS: ReadonlyArray<RelayDirection> = ['to-device', 'to-operator'];

/**
 * Why a relay operation was refused. Closed vocabulary: a caller switches on
 * these, so a new code is a deliberate change and never a string surprise.
 */
export type RelayRefusal =
  /** No grant exists for this device — nothing was ever minted. */
  | 'no-session'
  /** The grant exists but is not HOLDING a live session: it was never consumed
   *  (`issued`), already ended (`closed`), or never opened (`expired`). */
  | 'not-open'
  /** The session WAS live and its window has passed with no recorded close
   *  (`stale`). The dangerous shape: refusing here is what closes the door on a
   *  channel that is authenticated with nobody behind it. */
  | 'stale'
  /** The grant names a different device than the one presenting it. */
  | 'wrong-device'
  /** The presented capability does not hash to the stored one. Deliberately
   *  ONE code for "wrong", "absent" and "never minted" so a prober cannot tell
   *  a valid session id from an invalid capability on it. */
  | 'wrong-capability'
  /** The decoded payload exceeds RELAY_MAX_FRAME_BYTES. */
  | 'frame-too-large'
  /** The payload is not base64, or a required field is empty/malformed. */
  | 'malformed'
  /** The peer's queue is at RELAY_QUEUE_MAX_FRAMES — refusing is the honest
   *  answer; silently dropping would look like packet loss on a screen. */
  | 'queue-full'
  /** The capability was sent as a query parameter. REFUSED, never ignored: a
   *  credential in a URL is already in someone's access log, and silently
   *  ignoring it would leave it there while the caller debugged the wrong thing. */
  | 'capability-in-url';

/** The single reason line for each refusal, so prose cannot drift per caller. */
const RELAY_REFUSAL_REASONS: Readonly<Record<RelayRefusal, string>> = {
  'no-session':
    'no brokered session exists for this device — open one before carrying frames over it',
  'not-open':
    'this brokered session is not holding a live operator session — frames may only travel over a session that was consumed, is unclosed, and is inside its window',
  stale:
    'this brokered session outlived its window without being closed — frames are refused until it is closed and a new session is opened',
  'wrong-device':
    'this session names a different device — a brokered session may only carry frames for the device it was minted for',
  'wrong-capability':
    'the session capability is missing or does not match this session — a session id alone never authorizes traffic',
  'frame-too-large': `a relay frame may not exceed ${RELAY_MAX_FRAME_BYTES} bytes — split the payload into more frames`,
  malformed: 'the frame is malformed — the payload must be non-empty base64 and every field a usable value',
  'queue-full': `the peer's relay queue is full (${RELAY_QUEUE_MAX_FRAMES} frames) — it is not reading; close the session or wait for it to drain`,
  'capability-in-url':
    'the session capability must travel in the x-session-capability HEADER, never in the URL — a query-string secret is written to access logs, proxies and Referer headers that no application code controls; re-send it as a header',
};

/** The ONE reason line for a refusal code. */
export function reasonForRelayRefusal(refusal: RelayRefusal): string {
  return RELAY_REFUSAL_REASONS[refusal];
}

/** A usable non-empty string. */
function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * The hash a capability is STORED as. SHA-256, matching the agent-token
 * precedent (`hashToken` in `imessage.service.ts`) rather than bcrypt: a
 * capability is 32 bytes of CSPRNG output, so there is no low-entropy guess to
 * slow down, and this hash is verified on EVERY frame — a per-frame bcrypt
 * would be a self-inflicted throughput ceiling on a screen stream.
 */
export function hashRelayCapability(capability: string): string {
  return createHash('sha256').update(capability).digest('hex');
}

/**
 * Constant-time capability comparison.
 *
 * `timingSafeEqual` throws on length mismatch, so that case is answered
 * separately — and deliberately does not short-circuit into a different code,
 * because "wrong length" and "wrong value" must be indistinguishable to the
 * caller. Comparing hex digests (always 64 chars) also keeps the length
 * mismatch case from ever reaching the throw for a real stored value.
 */
export function relayCapabilityMatches(presented: unknown, storedHash: unknown): boolean {
  if (!nonEmpty(presented) || !nonEmpty(storedHash)) return false;
  const a = Buffer.from(hashRelayCapability(presented), 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * May this session carry frames at all? The SESSION gate — gate (b) of the
 * three the header describes, evaluated on the grant the store already loaded.
 *
 * `stale` is separated from the other refusals on purpose: it is the ONE state
 * that means a channel was authenticated past its authorization, so a caller
 * (and the fleet) should be told exactly that rather than a generic "not open".
 */
export function relaySessionRefusal(
  grant: BrokeredSessionGrant | null | undefined,
  device: { agentId?: unknown; channel?: unknown } | null | undefined,
  now: number,
): RelayRefusal | null {
  if (!grant) return 'no-session';
  const state = brokeredSessionState(grant, now);
  if (state === 'stale') return 'stale';
  // 'open' is the ONLY carrying state: issued-but-unused never had an operator
  // show up, closed ended on purpose, expired never opened, none is nothing.
  if (state !== 'open') return 'not-open';
  if (!device || !nonEmpty(device.agentId) || device.agentId !== grant.agentId) return 'wrong-device';
  if (!device || device.channel !== grant.channel) return 'wrong-device';
  return null;
}

/**
 * Validate a base64 frame payload and report its decoded size.
 *
 * The strict base64 check is not pedantry: `Buffer.from(x,'base64')` SILENTLY
 * IGNORES invalid characters, so a payload carrying a raw credential-shaped
 * string would decode to garbage and be carried happily. Requiring the input to
 * be characters from the base64 alphabet (plus optional padding) means the
 * module can state what it transported.
 */
export function validateRelayPayload(
  payloadB64: unknown,
): { ok: true; bytes: number } | { ok: false; refusal: 'malformed' | 'frame-too-large' } {
  if (!nonEmpty(payloadB64)) return { ok: false, refusal: 'malformed' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payloadB64)) return { ok: false, refusal: 'malformed' };
  // Cheap length pre-check: a padded base64 quantum (4 chars) decodes to 3
  // bytes, minus one byte per '=' of padding.
  //
  // ── THE BUG THIS COMMENT REPLACES (found 2026-11-02, ticket c468f922) ──
  // This check used to be `Math.ceil(len * 3 / 4)`, which IGNORES padding and
  // therefore OVERESTIMATES by up to 2 bytes. A payload of EXACTLY
  // RELAY_MAX_FRAME_BYTES encodes to a string whose 3/4 length is
  // RELAY_MAX_FRAME_BYTES + 2, so the pre-check refused the largest LEGAL frame
  // as `frame-too-large` before the exact check ever ran.
  //
  // Nobody noticed because no test had ever pushed a payload at exactly the
  // ceiling: every existing test used small payloads where the overestimate
  // stayed under the limit. The RFB codec made it fatal — a screen is chunked
  // into FULL-CEILING frames by construction (`chunkForRelay`), so in the field
  // EVERY frame of EVERY screen would have been refused, i.e. no video at all,
  // with a 413 that looks like a size problem in the caller rather than an
  // arithmetic bug here. The exact check below is authoritative either way;
  // this pre-check only exists to refuse a grossly oversized payload before
  // allocating for it.
  const padding = payloadB64.endsWith('==') ? 2 : payloadB64.endsWith('=') ? 1 : 0;
  // Only trust the quantum arithmetic on a well-formed (4-char-multiple) string;
  // otherwise fall back to the un-subtracted bound, which can only over-estimate.
  const decodedUpperBound =
    payloadB64.length % 4 === 0
      ? (payloadB64.length / 4) * 3 - padding
      : Math.floor((payloadB64.length * 3) / 4);
  if (decodedUpperBound > RELAY_MAX_FRAME_BYTES) {
    return { ok: false, refusal: 'frame-too-large' };
  }
  const bytes = Buffer.from(payloadB64, 'base64').length;
  if (bytes === 0) return { ok: false, refusal: 'malformed' };
  if (bytes > RELAY_MAX_FRAME_BYTES) return { ok: false, refusal: 'frame-too-large' };
  return { ok: true, bytes };
}

/**
 * Should a write be refused because the peer is not reading?
 *
 * The check runs BEFORE the push so a full queue costs the writer a 409 rather
 * than a silent `LTRIM` drop — a screen that loses frames must look like a
 * stalled session, never like a corrupted one.
 */
export function relayQueueRefusal(currentDepth: number): RelayRefusal | null {
  return currentDepth >= RELAY_QUEUE_MAX_FRAMES ? 'queue-full' : null;
}

/**
 * Clamp a caller's requested poll size into the supported range.
 *
 * Absent/garbage reads as the maximum rather than as zero: a client that asks
 * for nothing is almost certainly a client that failed to send the parameter,
 * and answering "0 frames" forever would look exactly like a dead relay.
 */
export function clampRelayPollLimit(requested: unknown): number {
  const n = typeof requested === 'number' ? requested : parseInt(String(requested ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return RELAY_MAX_FRAMES_PER_POLL;
  return Math.min(Math.floor(n), RELAY_MAX_FRAMES_PER_POLL);
}

/**
 * Parse a receiver's cursor (`after`). Absent/garbage reads as 0 — "deliver
 * everything still queued" — which is the safe direction: the client's next
 * cursor comes from the frames it actually received.
 */
export function parseRelayCursor(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** One carried frame, exactly as it travels on the wire. */
export interface RelayFrame {
  /** ASSIGNED BY THE SERVER (`INCR`), never by the client — see the header. */
  seq: number;
  /** Opaque base64 payload. Never decoded, inspected or logged here. */
  payloadB64: string;
  /** When the relay accepted it (unix ms). */
  sentAt: number;
  /** Marks the last frame of a stream so the peer can stop polling early. */
  final?: boolean;
}

/**
 * Parse a stored frame defensively. A corrupt row must read as "skip this
 * frame", never throw into a poll loop that is holding a session open.
 */
export function parseRelayFrame(raw: string | null | undefined): RelayFrame | null {
  if (!nonEmpty(raw)) return null;
  try {
    const o = JSON.parse(raw) as RelayFrame;
    if (!o || typeof o.seq !== 'number' || !Number.isFinite(o.seq)) return null;
    if (!nonEmpty(o.payloadB64)) return null;
    if (typeof o.sentAt !== 'number') return null;
    return o;
  } catch {
    return null;
  }
}
/**
 * RELAY DATA PLANE STORE — the Redis half of the session-carrying relay
 * (ticket c468f922, owner ruling 2026-10-29/30 on card oq_b5118c38).
 *
 * `relay-dataplane.ts` is the pure state machine that decides whether a byte may
 * travel. This module is where the frames and the session capability actually
 * LIVE, because production runs multiple backend processes (2 web instances
 * behind an ALB + 1 worker): the process that accepts an operator's frame and
 * the process serving the device's long-poll are usually DIFFERENT. Same
 * discipline `agent-link.ts` established for its command broker.
 *
 * ── KEYS ────────────────────────────────────────────────────────────────────
 *   imsg:relay:q:<sessionId>:<direction>   — the frame queue (RPUSH / LRANGE)
 *   imsg:relay:seq:<sessionId>:<direction> — the server-assigned cursor (INCR)
 *   imsg:relay:cap:<sessionId>             — SHA-256 of the session capability
 *
 * ── WHY THE CAPABILITY IS NOT A FIELD ON THE GRANT ──────────────────────────
 * `brokered-session.ts` states the grant is "an authorization, not a secret",
 * and its own test pins the grant's exact key set so a credential-shaped field
 * can never be added by accident. Keeping the capability at its OWN key
 * preserves that property rather than carving an exception into it: the grant
 * that lists in a device row stays credential-free, and the secret lives
 * somewhere that is only ever read to answer one question — "was this caller
 * given this session?".
 *
 * ── THE CARRYING STATE IS RE-DERIVED ON EVERY OPERATION ─────────────────────
 * Nothing caches "the session is open" between frames. Every push and every
 * poll re-loads the grant and re-runs the leaf's gate, so the moment a session
 * is closed, overruns its window, or is replaced by a new grant, the very next
 * frame is refused. A relay that trusted a cached open-state would be a
 * permanently open door with extra steps — exactly what the ruling forbids.
 *
 * ⚠ NO TOP-LEVEL `config/redis` / `utils/logger` IMPORT — the D4/53-suite trap
 * documented in `brokered-session.store.ts`. A static import here would boot
 * `config/env.ts` and its `parseEnv` validation in every suite that reaches the
 * tool registry, turning dozens of unrelated suites red with a worker-crash
 * message that names nothing. Both `jest.mock` boundaries still intercept the
 * dynamic import, so tests mock them exactly as they do for the grant store.
 */

import {
  type RelayDirection,
  type RelayFrame,
  type RelayRefusal,
  RELAY_MAX_FRAMES_PER_POLL,
  RELAY_QUEUE_MAX_FRAMES,
  RELAY_QUEUE_TTL_SEC,
  clampRelayPollLimit,
  hashRelayCapability,
  parseRelayCursor,
  parseRelayFrame,
  relayCapabilityMatches,
  relayQueueRefusal,
  relaySessionRefusal,
  validateRelayPayload,
} from './relay-dataplane';
import { loadBrokeredSession } from './brokered-session.store';
import type { RemoteChannel } from './remote-access-verdict';

/** Hard bound on any single Redis call from this module (the D4 precedent). */
export const RELAY_REDIS_TIMEOUT_MS = 750;

/** Minimal structural type for the Redis calls used here, so this module never
 *  needs the concrete client type (and never imports it eagerly). */
interface RelayRedis {
  rPush(key: string, value: string): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lTrim(key: string, start: number, stop: number): Promise<unknown>;
  lLen(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

async function store(): Promise<RelayRedis> {
  const mod = await import('../../../config/redis');
  return mod.default as unknown as RelayRedis;
}

async function log(): Promise<{ warn: (...a: unknown[]) => void }> {
  const mod = await import('../../../utils/logger');
  return mod.default as unknown as { warn: (...a: unknown[]) => void };
}

/** Bound a store call so a WEDGED (not down) redis cannot hang a poll loop. */
async function bounded<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out after ${RELAY_REDIS_TIMEOUT_MS}ms`)),
          RELAY_REDIS_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const queueKey = (sessionId: string, dir: RelayDirection): string => `imsg:relay:q:${sessionId}:${dir}`;
const seqKey = (sessionId: string, dir: RelayDirection): string => `imsg:relay:seq:${sessionId}:${dir}`;
const capKey = (sessionId: string): string => `imsg:relay:cap:${sessionId}`;

/**
 * Mint and persist a session capability.
 *
 * CALLED ONLY FROM THE OPEN ROUTE, alongside the grant it belongs to, so the
 * two can never disagree about whether a session was ever authorized to carry
 * traffic. Returns the SHA-256 hash to store; the CALLER holds the plaintext
 * exactly once, hands it to the operator, and never persists it — the same
 * show-once contract `completePairing` uses for the agent token.
 *
 * TTL is the grant retention, NOT the session window: the hash must outlive the
 * window so a `stale` session's capability still reads as "wrong-capability"
 * (a refusal) rather than evaporating into "no-session" (a different, less
 * informative answer).
 */
export async function mintRelayCapability(sessionId: string, capability: string): Promise<boolean> {
  if (!sessionId || !capability) return false;
  try {
    const redis = await store();
    await bounded(
      redis.setEx(capKey(sessionId), RELAY_QUEUE_TTL_SEC, hashRelayCapability(capability)),
      'mintRelayCapability',
    );
    return true;
  } catch (e) {
    try { (await log()).warn('relay-dataplane: could not record capability', e); } catch { /* ignore */ }
    return false;
  }
}

/** Drop a session's transport state (queues, cursors, capability). Best-effort:
 *  a queue that fails to clear still self-expires via its TTL. */
export async function clearRelaySession(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    const redis = await store();
    const keys = [
      capKey(sessionId),
      ...(['to-device', 'to-operator'] as RelayDirection[]).flatMap((d) => [queueKey(sessionId, d), seqKey(sessionId, d)]),
    ];
    await bounded(Promise.all(keys.map((k) => redis.del(k))), 'clearRelaySession');
  } catch (e) {
    try { (await log()).warn('relay-dataplane: could not clear session', e); } catch { /* ignore */ }
  }
}

/**
 * THE GATE. Every push and every poll passes through here, and nothing caches
 * its verdict — see the header.
 *
 * Returns null when the caller may proceed, or the refusal to answer with.
 * Order is deliberate and matches the grant leaf's: identity, then state, then
 * the secret last, so a caller who is on the WRONG DEVICE never learns whether
 * the capability it holds is valid.
 */
export async function relayGate(args: {
  agentId: string;
  sessionId: string;
  channel: RemoteChannel;
  capability: string;
  now?: number;
}): Promise<RelayRefusal | null> {
  const now = args.now ?? Date.now();
  if (!args.agentId || !args.sessionId) return 'no-session';

  const grant = await loadBrokeredSession(args.agentId);
  const sessionRefusal = relaySessionRefusal(grant, { agentId: args.agentId, channel: args.channel }, now);
  if (sessionRefusal) return sessionRefusal;

  // The grant we just gated on must be the session being presented. Without
  // this, a caller holding device A's live session could present device A's
  // agent id with a STALE session id from an old grant and read its queue.
  if (!grant || grant.sessionId !== args.sessionId) return 'no-session';

  let storedHash: string | null = null;
  try {
    const redis = await store();
    storedHash = await bounded(redis.get(capKey(args.sessionId)), 'relayGate:cap');
  } catch (e) {
    try { (await log()).warn('relay-dataplane: could not read capability', e); } catch { /* ignore */ }
    // A store we cannot read must NOT authorize the frame. Fail closed: the
    // cost of a retry is one poll; the cost of carrying an unauthenticated
    // session is the whole threat model.
    return 'wrong-capability';
  }
  if (!relayCapabilityMatches(args.capability, storedHash)) return 'wrong-capability';
  return null;
}

/**
 * THE DEVICE-SIDE GATE — the same session check, for the peer that proves
 * itself with the PAIRING token instead of a session capability.
 *
 * ── WHY THIS IS A SECOND FUNCTION AND NOT A FLAG ON `relayGate` ─────────────
 * A `requireCapability?: boolean` would be a parameter whose `false` value
 * disables a security check — one careless call site and the relay carries an
 * unauthenticated session. Two separate functions make "the device path" a
 * thing you have to CHOOSE, and keep the operator path's checks unconditional.
 *
 * ── WHY THE DEVICE NEEDS NO CAPABILITY, AND WHY THAT IS NOT A WEAKENING ─────
 * The capability exists to stop a session ID alone from carrying traffic. The
 * device's identity is already a per-device secret: `authenticateAgent`
 * resolves a 32-byte token against its SHA-256 hash and yields the device row,
 * and the session is then resolved FROM THAT DEVICE'S OWN GRANT — the device
 * cannot name a session, so there is no ID to steal, and it can only ever reach
 * the queue belonging to the session minted for it. The operator, by contrast,
 * is a human JWT that outlives any one session, so the session capability is
 * exactly the missing binding on that side.
 *
 * The distinct protection this DOES add over the plain agent token: frames only
 * travel while a live, consumed, unclosed, in-window session exists for that
 * device — so pairing alone never carries bytes, and closing the session stops
 * the device's stream on the very next poll.
 */
export async function relayDeviceGate(args: {
  agentId: string;
  channel: RemoteChannel;
  now?: number;
}): Promise<{ refusal: RelayRefusal } | { sessionId: string }> {
  const now = args.now ?? Date.now();
  if (!args.agentId) return { refusal: 'no-session' };
  const grant = await loadBrokeredSession(args.agentId);
  const sessionRefusal = relaySessionRefusal(grant, { agentId: args.agentId, channel: args.channel }, now);
  if (sessionRefusal) return { refusal: sessionRefusal };
  if (!grant) return { refusal: 'no-session' };
  // The device is answered for the session it was GIVEN — never one it names.
  return { sessionId: grant.sessionId };
}

/**
 * Accept one frame into the peer's queue, allocating its sequence number
 * SERVER-SIDE (`INCR`) so replay and reordering are unrepresentable rather
 * than merely rejected — see the leaf's header for why that matters.
 */
export async function pushRelayFrame(args: {
  sessionId: string;
  direction: RelayDirection;
  payloadB64: string;
  final?: boolean;
  now?: number;
}): Promise<{ ok: true; frame: RelayFrame; depth: number } | { ok: false; refusal: RelayRefusal }> {
  const valid = validateRelayPayload(args.payloadB64);
  if (!valid.ok) return { ok: false, refusal: valid.refusal };

  const now = args.now ?? Date.now();
  try {
    const redis = await store();
    const key = queueKey(args.sessionId, args.direction);

    // Check depth BEFORE pushing: a full queue must cost the writer an honest
    // 409, never a silent LTRIM drop that a screen would render as corruption.
    const depth = await bounded(redis.lLen(key), 'pushRelayFrame:depth');
    const full = relayQueueRefusal(depth);
    if (full) return { ok: false, refusal: full };

    const seq = await bounded(redis.incr(seqKey(args.sessionId, args.direction)), 'pushRelayFrame:seq');
    const frame: RelayFrame = {
      seq,
      payloadB64: args.payloadB64,
      sentAt: now,
      ...(args.final ? { final: true as const } : {}),
    };
    await bounded(redis.rPush(key, JSON.stringify(frame)), 'pushRelayFrame:push');
    // Cap the list at the hard maximum even under a write race that slipped
    // past the depth check, then re-arm the TTL.
    await bounded(redis.lTrim(key, -RELAY_QUEUE_MAX_FRAMES, -1), 'pushRelayFrame:trim');
    await bounded(redis.expire(key, RELAY_QUEUE_TTL_SEC), 'pushRelayFrame:ttl');
    await bounded(redis.expire(seqKey(args.sessionId, args.direction), RELAY_QUEUE_TTL_SEC), 'pushRelayFrame:seqTtl');
    return { ok: true, frame, depth: Math.min(depth + 1, RELAY_QUEUE_MAX_FRAMES) };
  } catch (e) {
    try { (await log()).warn('relay-dataplane: could not push frame', e); } catch { /* ignore */ }
    // Refusing beats a frame that was acknowledged but never queued: a caller
    // that retries costs one round trip, a caller told "sent" that is not is
    // indistinguishable from a broken relay.
    return { ok: false, refusal: 'queue-full' };
  }
}

/**
 * Drain frames newer than the caller's cursor.
 *
 * Filters by SEQUENCE, not by queue position, so a rare local inversion between
 * a push and its cursor allocation cannot deliver a stale frame. Frames already
 * delivered (`seq <= after`) are skipped, which is also what makes the cursor
 * idempotent across processes and safe to replay after a dropped response.
 */
export async function pollRelayFrames(args: {
  sessionId: string;
  direction: RelayDirection;
  after?: unknown;
  limit?: unknown;
}): Promise<{ frames: RelayFrame[]; cursor: number; more: boolean }> {
  const after = parseRelayCursor(args.after);
  const limit = clampRelayPollLimit(args.limit);
  try {
    const redis = await store();
    const raw = await bounded(
      redis.lRange(queueKey(args.sessionId, args.direction), 0, -1),
      'pollRelayFrames:range',
    );
    const all = (raw || [])
      .map(parseRelayFrame)
      .filter((f): f is RelayFrame => f !== null && f.seq > after)
      .sort((a, b) => a.seq - b.seq);
    const frames = all.slice(0, limit);
    return {
      frames,
      cursor: frames.length ? frames[frames.length - 1].seq : after,
      more: all.length > frames.length,
    };
  } catch (e) {
    try { (await log()).warn('relay-dataplane: could not read frames', e); } catch { /* ignore */ }
    // An unreadable queue is an EMPTY poll, not an error: the peer re-polls and
    // the session stays open. Reporting a failure here would tear down a
    // perfectly good session because of one wedged read.
    return { frames: [], cursor: after, more: false };
  }
}

/**
 * Drop queued frames OLDER than `beforeSeq`, returning how many were dropped.
 *
 * ── WHY A READ-SIDE TRIM EXISTS AT ALL (audit D1, 2026-11-02) ───────────────
 * Before this, `to-operator` was only ever trimmed at PUSH time
 * (`pushRelayFrame`'s `lTrim(-RELAY_QUEUE_MAX_FRAMES, -1)`). Nothing ever
 * removed the head from the read side, so a device that kept pushing with no
 * consumer drove the queue to the 256 ceiling and then had EVERY further push
 * refused `queue-full` — permanently, because the render path it was pushing
 * for never freed a slot. That is the stall: measured at 1920x1200, two screens
 * are 282 frames, so the second screen alone overruns the cap.
 *
 * ── WHY IT IS NOT A ROUTINE READ SIDE-EFFECT ────────────────────────────────
 * The render route promises not to steal frames from a consuming client (its
 * own suite pins that). Compaction therefore fires ONLY under pressure — when
 * the queue is at its cap, where the alternative is not "the consumer keeps its
 * frames" but "the device can never push again". In normal operation this is
 * never called and the guarantee is untouched.
 *
 * Trimming by LIST INDEX is safe for the same reason `pushRelayFrame` trims:
 * frames are only ever appended and removed from the head, and a frame's index
 * can only move DOWN. Re-reading the list immediately before the LTRIM keeps
 * the window between read and trim as small as one round trip.
 */
export async function trimRelayQueueBefore(args: {
  sessionId: string;
  direction: RelayDirection;
  beforeSeq: number;
}): Promise<number> {
  if (!args.sessionId || !Number.isFinite(args.beforeSeq)) return 0;
  try {
    const redis = await store();
    const key = queueKey(args.sessionId, args.direction);
    const raw = await bounded(redis.lRange(key, 0, -1), 'trimRelayQueueBefore:range');
    const frames = (raw || []).map(parseRelayFrame).filter((f): f is RelayFrame => f !== null);
    const firstKept = frames.findIndex((f) => f.seq >= args.beforeSeq);
    if (firstKept <= 0) return 0;
    await bounded(redis.lTrim(key, firstKept, -1), 'trimRelayQueueBefore:trim');
    return firstKept;
  } catch (e) {
    // A failed compaction is not a failed render: the frames are still there to
    // read, and the next push-time trim still bounds the queue.
    try { (await log()).warn('relay-dataplane: could not compact queue', e); } catch { /* ignore */ }
    return 0;
  }
}

/** Re-exported so a caller can bound its own sizing without a second import. */
export { RELAY_MAX_FRAMES_PER_POLL };
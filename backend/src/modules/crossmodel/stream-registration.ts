/**
 * Stream-query pre-registration — Redis-backed, cross-instance.
 *
 * POST /stream/register stores the full query params under a random UUID token
 * and the frontend connects with GET /stream?streamToken=<uuid> (keeps the SSE
 * GET URL tiny for >1.5KB messages and upload batches).
 *
 * WHY REDIS: this registry was an in-memory Map until 2026-08-16. Production
 * runs TWO web instances behind a per-request ALB, so the register POST landed
 * on one instance and the EventSource GET on the other → HTTP 410 "expired or
 * not found" for roughly every other long message (live-reproduced 6/6 from a
 * single client). Same bug class as the live-runs registry fixed in PR #226 —
 * any cross-REQUEST state must live in Redis, never module memory.
 *
 * Semantics preserved from the Map version: 3-minute TTL (Redis EX — no sweeper
 * needed), single-use consume (GETDEL, atomic across instances), and a
 * per-identity pending cap of 10 (Redis counter with the same TTL; released on
 * consume). The old global 500-entry cap guarded WEB-PROCESS memory exhaustion
 * — moot in Redis (tiny values, 3-min TTL, per-identity cap + the route-level
 * 25/10min rate limit bound total keys), so it was dropped.
 *
 * Failure posture: storing fails CLOSED (the caller 503s — a token we could not
 * store must not be handed out), the anti-abuse counter fails OPEN (a Redis
 * hiccup must not block chat; the route rate limiter still guards).
 */

import redisClient from '../../config/redis';

const REG_KEY = (token: string) => `cm:streamreg:${token}`;
const COUNT_KEY = (identity: string) => `cm:streamreg:count:${identity}`;

/** A registration is consumed within seconds; 3 min covers slow clients. */
export const STREAM_REG_TTL_SEC = 180;
/** Max simultaneous pending registrations per userId (or per anon IP). */
export const MAX_PENDING_PER_IDENTITY = 10;

export interface StreamQueryRegistration {
  message: string;
  chatId?: string;
  mode: string;
  webSearch: boolean;
  uploadIds: string[];
  userId?: string;
  /** Client IP for anonymous users — used for the IP-session consume check. */
  clientIp?: string;
  /** Ghost mode (owner 2026-10-22): the per-send ghost opt-in (the guest toggle — guests have no chat row). */
  ghost?: boolean;
  /** Patience plan 1a label window: the client's modeSource ('picked' | 'default' | 'restored'), when sent. */
  modeSource?: string;
  /** Compute policy Dig deeper (2026-09-26): the assistant message id this send escalates, when sent. */
  escalationOf?: string;
  /** Guest sessions (audit 2026-09-26): the NAMED anonymous session key (uuid) the client registered — only stored for anonymous registrants. */
  sessionId?: string;
}

/** Identity key for the pending cap: userId for authed, ip:<addr> for anon. */
export function registrationIdentity(userId: string | undefined, clientIp: string): string {
  return userId || `ip:${clientIp}`;
}

/**
 * Reserve a pending slot for this identity. Returns false when the identity is
 * at its cap (caller responds 429). The counter shares the registration TTL so
 * abandoned tokens free their slots when they expire.
 */
export async function reserveRegistrationSlot(identity: string): Promise<boolean> {
  try {
    const count = await redisClient.incr(COUNT_KEY(identity));
    if (count === 1) await redisClient.expire(COUNT_KEY(identity), STREAM_REG_TTL_SEC);
    if (count > MAX_PENDING_PER_IDENTITY) {
      // Undo our increment so consuming users are not punished by rejected tries.
      await redisClient.decr(COUNT_KEY(identity)).catch(() => {});
      return false;
    }
    return true;
  } catch {
    return true; // anti-abuse only — never block chat on a Redis hiccup
  }
}

/** Release a pending slot (on consume). Never lets the counter key go negative-and-immortal. */
export async function releaseRegistrationSlot(identity: string): Promise<void> {
  try {
    const key = COUNT_KEY(identity);
    if (!(await redisClient.exists(key))) return;
    const n = await redisClient.decr(key);
    // DECR on a just-expired key recreates it at -1 with no TTL — delete it.
    if (n <= 0) await redisClient.del(key);
  } catch {
    /* best-effort */
  }
}

/** Store a registration under its token. Throws on Redis failure (caller 503s). */
export async function storeRegistration(token: string, reg: StreamQueryRegistration): Promise<void> {
  await redisClient.set(REG_KEY(token), JSON.stringify(reg), { EX: STREAM_REG_TTL_SEC });
}

/**
 * Atomically fetch-and-delete a registration (single-use, cross-instance).
 * Returns null when missing/expired/unparseable — the caller responds 410.
 * Note: consumption happens BEFORE the caller's ownership checks, so a 403
 * mismatch also burns the token. Tokens are cryptographically random UUIDs, so
 * a mismatch means a corrupted client, not a guessing attacker; single-use
 * atomicity across instances is worth more than resurrecting mismatched tokens.
 */
export async function consumeRegistration(token: string): Promise<StreamQueryRegistration | null> {
  let raw: string | null;
  try {
    raw = await redisClient.getDel(REG_KEY(token));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StreamQueryRegistration;
  } catch {
    return null;
  }
}

/**
 * Computer-use arbitration (ticket 4e4d56ff).
 *
 * The 2026-09-09 incident: TWO computer-agent sessions drove the same Mac
 * concurrently (a scrape session and the cbaf3e08 hot-patch validation
 * session). Each loop assumes it solely owns the screen/pointer/keyboard
 * between its screenshot and its click — with two loops interleaving, one
 * session's clicks were scaled against screenshots whose screen state the
 * OTHER session had already changed (omnibox focused, a modal Print dialog
 * raised). Every anomaly in the ticket (clicks "at wrong coordinates", dead
 * scrolls, dead arrow keys, one click landing in the address bar) is that
 * interference — while every individual action reported success.
 *
 * This module serializes computer-agent sessions per user with a Redis
 * mutex: the first session holds the lock for its whole run; a concurrent
 * session waits briefly, then gets a clear "Mac busy" capabilityNotice
 * instead of silently fighting for the pointer.
 *
 * Lock semantics: SET key token NX PX ttl (crash-safe via TTL), released with
 * a compare-and-delete Lua script so a holder never deletes a successor's
 * lock after its own TTL lapsed.
 */

import { randomUUID } from "crypto";
import redisClient from "../../../config/redis";
import logger from "../../../utils/logger";

import { ComputerUseHolder } from "./types";

const LOCK_PREFIX = "computer-use:lock:";
/** How long a contender waits for the in-flight session to finish (ms).
 *  cu-diag 2026-09-25 fix #6: 15 s → 60 s (three refusals in one evening
 *  were contenders that would have won the lock seconds later — sessions
 *  typically finish within a minute). `COMPUTER_LOCK_WAIT_MS` overrides;
 *  =15000 restores the pre-fix wait. */
export const LOCK_WAIT_MS_DEFAULT = 60_000;
export function lockWaitMs(): number {
  const s = String(process.env.COMPUTER_LOCK_WAIT_MS ?? "").trim();
  if (!s) return LOCK_WAIT_MS_DEFAULT;
  const raw = Number(s);
  return Number.isFinite(raw) && raw >= 0 ? raw : LOCK_WAIT_MS_DEFAULT;
}
/** @deprecated kept for importers — the live value is lockWaitMs(). */
export const LOCK_WAIT_MS = LOCK_WAIT_MS_DEFAULT;
/** Safety margin added to the session's own deadline for the lock TTL (ms). */
export const LOCK_TTL_MARGIN_MS = 120_000;
/** Absolute ceiling for a lock TTL regardless of the caller's deadline (ms). */
export const LOCK_TTL_MAX_MS = 12 * 60_000;

const RELEASE_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

function keyFor(userId: string, deviceId?: string | null): string {
  // Multi-Mac (2026-09-24): the lock is per-DEVICE — driving the MacBook Pro
  // must not block a concurrent session on the Mac mini. Legacy callers that
  // pass no deviceId keep the old per-user key shape.
  return deviceId ? `${LOCK_PREFIX}${userId}:${deviceId}` : `${LOCK_PREFIX}${userId}`;
}

/** The PRE-multi-Mac per-user key — kept as a secondary guard for the
 *  blue-green deploy window: an in-flight session on the OLD color still
 *  holds this key (both colors share Redis), and without checking it a
 *  new-color per-device session could double-drive the same Mac (the exact
 *  4e4d56ff incident class). We SET (not just check) it too, so an
 *  old-color contender is blocked symmetrically. */
function legacyKeyFor(userId: string): string {
  return `${LOCK_PREFIX}${userId}`;
}

/** cu-diag fix #6: the holder record lives in a SIBLING key (`<lock>:holder`)
 *  so the compare-and-delete token protocol on the lock key itself is
 *  untouched (the lock value stays the bare token). */
function holderKeyFor(lockKey: string): string {
  return `${lockKey}:holder`;
}

/**
 * Try to take the computer-use lock (per-device when a deviceId is given).
 * Returns the lock token on success, null when another session holds it.
 * Fails OPEN on Redis errors (a Redis hiccup must not disable computer use —
 * the broker itself is the harder serialization point and a missed lock only
 * re-exposes the original race, it doesn't break a working single-driver setup).
 *
 * Deploy-window guard (review N1): when a deviceId IS given we also take the
 * LEGACY per-user key — an in-flight session on the old blue/green color
 * still holds that key, and both colors share Redis.
 */
async function tryAcquire(
  userId: string,
  ttlMs: number,
  deviceId?: string | null,
): Promise<string | null> {
  const token = randomUUID();
  try {
    const keys = deviceId
      ? [keyFor(userId, deviceId), legacyKeyFor(userId)]
      : [keyFor(userId)];
    const results: (string | null)[] = [];
    for (const key of keys) {
      // Sequential NX-SETs: if the per-device key lands but the legacy one is
      // held (old-color session), release our per-device key and back off.
      results.push(await redisClient.set(key, token, { PX: ttlMs, NX: true }) as string | null);
    }
    const acquired = results.every((r) => r === "OK");
    if (!acquired) {
      // Roll back whatever we did land (best-effort; TTLs expire the rest).
      for (let i = 0; i < keys.length; i++) {
        if (results[i] === "OK") {
          await redisClient.eval(RELEASE_LUA, { keys: [keys[i]], arguments: [token] }).catch(() => {});
        }
      }
      return null;
    }
    return token;
  } catch (e: any) {
    logger.warn(
      `computer-use lock: acquire failed open for user ${userId}: ${e?.message || e}`,
    );
    return token; // fail open — treat as held by us
  }
}

/**
 * Acquire the computer-use lock, waiting up to LOCK_WAIT_MS for an in-flight
 * session to finish. Returns the token on success, null when the lock stayed
 * contended. ttlMs caps how long the lock can outlive a crashed holder.
 */
export async function acquireComputerUseLock(
  userId: string,
  ttlMs: number,
  deviceId?: string | null,
  waitMs: number = lockWaitMs(),
): Promise<string | null> {
  const ttl = Math.min(Math.max(ttlMs, 30_000), LOCK_TTL_MAX_MS);
  const giveUp = Date.now() + Math.max(waitMs, 0);
  for (;;) {
    const token = await tryAcquire(userId, ttl, deviceId);
    if (token) return token;
    if (Date.now() >= giveUp) return null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Release the lock (compare-and-delete on the token). Best-effort. */
export async function releaseComputerUseLock(
  userId: string,
  token: string,
  deviceId?: string | null,
): Promise<void> {
  try {
    // With a deviceId we hold BOTH keys (per-device + legacy deploy guard).
    const keys = deviceId
      ? [keyFor(userId, deviceId), legacyKeyFor(userId)]
      : [keyFor(userId)];
    for (const key of keys) {
      const deleted = await redisClient.eval(RELEASE_LUA, { keys: [key], arguments: [token] });
      // cu-diag fix #6: the holder record goes with the lock — only when WE
      // owned the lock (a successor's holder record must survive our release).
      if (Number(deleted) === 1) {
        await redisClient.del(holderKeyFor(key)).catch(() => {});
      }
    }
  } catch (e: any) {
    logger.warn(
      `computer-use lock: release failed for user ${userId} (TTL will expire it): ${e?.message || e}`,
    );
  }
}

/**
 * cu-diag 2026-09-25 fix #6: record WHO holds the lock (chat id + lane) next
 * to the lock keys, with the same TTL, so a contender's refusal and
 * get_account_overview can name the holder. Best-effort (never throws): a
 * missing record only degrades the refusal to "another session".
 */
export async function recordComputerUseHolder(
  userId: string,
  deviceId: string | null | undefined,
  holder: { chatId?: string | null; lane?: string | null },
  ttlMs: number,
): Promise<void> {
  const ttl = Math.min(Math.max(ttlMs, 30_000), LOCK_TTL_MAX_MS);
  const record: ComputerUseHolder = {
    chatId: holder.chatId ?? null,
    lane: holder.lane ?? null,
    since: new Date().toISOString(),
  };
  try {
    const keys = deviceId
      ? [keyFor(userId, deviceId), legacyKeyFor(userId)]
      : [keyFor(userId)];
    for (const key of keys) {
      await redisClient.set(holderKeyFor(key), JSON.stringify(record), { PX: ttl });
    }
  } catch (e: any) {
    logger.warn(`computer-use lock: holder record failed for user ${userId}: ${e?.message || e}`);
  }
}

/**
 * cu-diag fix #6: who currently holds the computer-use lock for this device
 * (per-device record first, then the legacy per-user record — an old-color
 * session during a deploy window). null = nobody recorded (free, a legacy
 * holder, or Redis unreachable — the caller treats it as "unknown holder",
 * never as "free").
 */
export async function describeComputerUseHolder(
  userId: string,
  deviceId?: string | null,
): Promise<ComputerUseHolder | null> {
  try {
    const keys = deviceId
      ? [keyFor(userId, deviceId), legacyKeyFor(userId)]
      : [keyFor(userId)];
    for (const key of keys) {
      const raw = await redisClient.get(holderKeyFor(key));
      if (!raw) continue;
      const parsed = JSON.parse(String(raw));
      return {
        chatId: typeof parsed?.chatId === "string" ? parsed.chatId : null,
        lane: typeof parsed?.lane === "string" ? parsed.lane : null,
        since: typeof parsed?.since === "string" ? parsed.since : null,
      };
    }
    return null;
  } catch (e: any) {
    logger.warn(`computer-use lock: holder read failed for user ${userId}: ${e?.message || e}`);
    return null;
  }
}

/** cu-diag fix #6: is the device's lock currently held (either key)? Used by
 *  get_account_overview to show the busy state. Fails to `false` on Redis
 *  errors (the overview must never fail on a lock read). */
export async function computerUseLockHeld(
  userId: string,
  deviceId?: string | null,
): Promise<boolean> {
  try {
    const keys = deviceId
      ? [keyFor(userId, deviceId), legacyKeyFor(userId)]
      : [keyFor(userId)];
    for (const key of keys) {
      const v = await redisClient.get(key);
      if (v) return true;
    }
    return false;
  } catch {
    return false;
  }
}

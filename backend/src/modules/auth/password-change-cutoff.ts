/**
 * Password-change cutoff for ACCESS tokens (2026-10-12, change-password).
 *
 * Access tokens are stateless JWTs and prod mints them with
 * JWT_EXPIRES_IN=7d (docker-compose.app.yml), so deleting a user's refresh
 * tokens alone would leave another device's access token working for up to a
 * week after the password changed. This leaf records ONE Redis key per user —
 * `auth:pw_cutoff:<userId>` = the unix second of the change — and the auth
 * middlewares reject a token whose `iat` is OLDER than it. The caller's own
 * fresh token is minted after the cutoff is taken, so it passes.
 *
 * Posture:
 *  - No key (every user who never changed their password) ⇒ no effect.
 *  - FAIL-OPEN: Redis not configured / not ready / slow / erroring ⇒ the
 *    token is treated as not revoked (a Redis outage must never log every
 *    user out). The refresh-token rows are revoked in Postgres regardless.
 *  - A per-process cache (CACHE_TTL_MS) keeps the hot path at ≤ 1 Redis GET
 *    per user per window; the process that records a change updates its own
 *    cache at once, other processes see it within the window.
 *  - The Redis client is INJECTED at boot (app.ts) — this module never
 *    imports config/redis, so the auth middleware stays importable in
 *    env-less tests (config/env hard-exits without env vars). Unconfigured ⇒
 *    no-op.
 */

/** The subset of the node-redis v4 client this module uses. */
export interface CutoffStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
  readonly isReady?: boolean;
}

/** Outlives any access token (prod JWT_EXPIRES_IN = 7d). */
export const CUTOFF_TTL_SECONDS = 30 * 24 * 60 * 60;
export const CUTOFF_CACHE_TTL_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 250;
const CACHE_MAX_ENTRIES = 10_000;

let store: CutoffStore | null = null;
const cache = new Map<string, { cutoff: number; at: number }>();

export function cutoffKey(userId: string): string {
  return `auth:pw_cutoff:${userId}`;
}

/** Wire the shared Redis client (app.ts). Passing null disables the check. */
export function configurePasswordChangeCutoffStore(s: CutoffStore | null): void {
  store = s;
  cache.clear();
}

function remember(userId: string, cutoff: number): void {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(userId, { cutoff, at: Date.now() });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Record a password change at `cutoffSec` (unix seconds). Returns true when
 * the cutoff reached Redis (or at least this process's cache when Redis is
 * unavailable → false). Never throws.
 */
export async function recordPasswordChangeCutoff(userId: string, cutoffSec: number): Promise<boolean> {
  remember(userId, cutoffSec);
  if (!store || store.isReady === false) return false;
  try {
    await withTimeout(store.set(cutoffKey(userId), String(cutoffSec), { EX: CUTOFF_TTL_SECONDS }), 2_000);
    return true;
  } catch {
    return false;
  }
}

/** The user's cutoff in unix seconds, 0 when none / unknown (fail-open). Never throws. */
export async function readPasswordChangeCutoff(userId: string): Promise<number> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CUTOFF_CACHE_TTL_MS) return hit.cutoff;
  if (!store || store.isReady === false) return hit?.cutoff ?? 0;
  let cutoff = 0;
  try {
    const raw = await withTimeout(store.get(cutoffKey(userId)), LOOKUP_TIMEOUT_MS);
    const n = raw == null ? 0 : Number(raw);
    cutoff = Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    // Fail-open, but keep a cutoff this process already knew about.
    cutoff = hit?.cutoff ?? 0;
  }
  remember(userId, cutoff);
  return cutoff;
}

/**
 * True when this verified access-token payload was issued BEFORE the user's
 * last password change. A token with no `iat` counts as issued at 0 (revoked
 * once a cutoff exists — jsonwebtoken always stamps iat). Never throws.
 */
export async function isRevokedByPasswordChange(payload: { userId?: string; iat?: number } | null | undefined): Promise<boolean> {
  try {
    const userId = payload?.userId;
    if (!userId || !store) return false;
    const cutoff = await readPasswordChangeCutoff(userId);
    if (!cutoff) return false;
    const iat = typeof payload?.iat === 'number' ? payload.iat : 0;
    return iat < cutoff;
  } catch {
    return false;
  }
}

/** Test seam: forget the cache (and optionally the store). */
export function __resetPasswordChangeCutoffForTest(): void {
  cache.clear();
  store = null;
}

/**
 * Rate limiting for deep_research (Patience 4) queries.
 *
 * Uses Redis with daily TTL keys for per-user usage tracking.
 * The daily limit is stored in the SystemSetting table and cached in memory
 * for 60 seconds to avoid hitting the DB on every request.
 */

import redisClient from '../../config/redis';
import prisma from '../../config/database';
import logger from '../../utils/logger';
// Leaf (database + logger only) — the patience switch flip writes ONE telemetry row.
import { recordLoopMetric } from './platform/loop-metrics.service';

// ── In-memory cache for the daily limit setting ──────────────────────────────

let _cachedLimit: number | null = null;
let _cachedLimitAt = 0;
const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Get the current deep_research daily limit from SystemSetting.
 * Cached in memory for 60 seconds.
 */
export async function getDeepResearchDailyLimit(): Promise<number> {
  const now = Date.now();
  if (_cachedLimit !== null && now - _cachedLimitAt < CACHE_TTL_MS) {
    return _cachedLimit;
  }

  try {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: 'deep_research_daily_limit' },
    });
    const limit = setting ? parseInt(setting.value, 10) : 5;
    _cachedLimit = isNaN(limit) || limit < 0 ? 5 : limit;
    _cachedLimitAt = now;
    return _cachedLimit;
  } catch (err) {
    logger.warn('Failed to read deep_research_daily_limit from DB, using default 5:', err);
    return _cachedLimit ?? 5;
  }
}

/** Force-invalidate the cached limit (called when admin updates the setting). */
export function invalidateLimitCache(): void {
  _cachedLimit = null;
  _cachedLimitAt = 0;
}

// ── patience_auto_only (patience plan Phase 1a, 2026-09-25) ──────────────────
// The ONE switch of the "always Auto" program (docs/PATIENCE_AUTO_ONLY_
// DEPRECATION_PLAN_2026-09-25.md §3.1): when on, EVERY human seam — the SSE
// stream, REST POST /platform/chats/:id/messages, Telegram — treats a human
// send into a non-supervisor chat as mode='auto' (ONE resolver since the
// 2026-09-26 audit: platform/send-mode.ts resolveSendMode; the REST seam can
// be exempted with PATIENCE_AUTO_ONLY_REST_DISABLED=1). SystemSetting
// `patience_auto_only` (admin PUT /admin/settings/patience_auto_only flips it
// LIVE — no deploy; same 60 s cache as deep_research_daily_limit) with env
// PATIENCE_AUTO_ONLY as the boot default. Phase 1a shipped it OFF (boot
// default false). LIVE STATE: the prod row has been `1` since 2026-09-26
// 20:35Z (the compute-policy step-2 rollout — every human send is Auto; an
// Account → Advanced preset rides as routing.requestedMode only). The flip
// is audited since the 2026-09-26 audit: `patience_auto_only_by` holds the
// admin identity, the PUT is idempotent (`changed:false` leaves `updatedAt`
// = the real flip time), and GET /admin/settings/patience-auto-only +
// GET /depth/policy report the state (admin facts / the user-facing flag).

export const PATIENCE_AUTO_ONLY_KEY = 'patience_auto_only';
/** Companion row: the admin identity that last flipped the switch (the supervisor-switch `_by` shape). */
export const PATIENCE_AUTO_ONLY_BY_KEY = `${PATIENCE_AUTO_ONLY_KEY}_by`;
export const PATIENCE_AUTO_ONLY_ENV = 'PATIENCE_AUTO_ONLY';
/** loop_metrics kind (mirrored in LOOP_METRIC_KINDS.PATIENCE_SWITCH): {action:'flipped', enabled, by, previous, previousSource}. */
export const PATIENCE_SWITCH_METRIC_KIND = 'patience_switch';

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/**
 * Parse a POSTED switch value: 1|true|on → true, 0|false|off → false, anything
 * else → null (the admin PUT rejects it). The READER stays lenient by design —
 * any stored value that is not 1|true|on reads as OFF (`onFlag`).
 */
export function parsePatienceSwitchValue(v: unknown): boolean | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'off') return false;
  return null;
}


/** The boot default from env PATIENCE_AUTO_ONLY (unset / anything but 1|true|on = false). */
export function patienceAutoOnlyBootDefault(): boolean {
  return onFlag(process.env.PATIENCE_AUTO_ONLY);
}

let _cachedAutoOnly: boolean | null = null;
let _cachedAutoOnlyAt = 0;

/**
 * Is the always-Auto switch on? SystemSetting row wins (1|true|on = on; any
 * other stored value = off); no row = the env boot default. Cached 60 s;
 * a DB error returns the last cached value, else the boot default — never
 * throws, never flips a send on an outage.
 */
export async function getPatienceAutoOnly(): Promise<boolean> {
  const now = Date.now();
  if (_cachedAutoOnly !== null && now - _cachedAutoOnlyAt < CACHE_TTL_MS) return _cachedAutoOnly;
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: PATIENCE_AUTO_ONLY_KEY } });
    _cachedAutoOnly = setting ? onFlag(setting.value) : patienceAutoOnlyBootDefault();
    _cachedAutoOnlyAt = now;
    return _cachedAutoOnly;
  } catch (err) {
    logger.warn('Failed to read patience_auto_only from DB, using the cached/boot value:', err);
    return _cachedAutoOnly ?? patienceAutoOnlyBootDefault();
  }
}

/** Force-invalidate the cached switch (admin PUT /admin/settings/patience_auto_only). */
export function invalidatePatienceAutoOnlyCache(): void {
  _cachedAutoOnly = null;
  _cachedAutoOnlyAt = 0;
}

// ── patience_auto_only: state + audited flip (audit 2026-09-26) ──────────────

export interface PatienceSwitchState {
  key: string;
  enabled: boolean;
  /** ISO of the last flip write (the row's updatedAt); null = no row (env boot default in force). */
  since: string | null;
  /** Admin identity that last flipped it; null = no row / a pre-audit flip (the 2026-09-26 20:35Z one). */
  updatedBy: string | null;
  source: 'setting' | 'env';
  bootDefault: boolean;
  envVar: string;
  /** Harness-composed status line, e.g. "Always Auto: ON since 2026-09-26 20:35Z by unknown (store row; …)". */
  line: string;
}

export function patienceSwitchLine(s: Omit<PatienceSwitchState, 'line'>): string {
  const state = s.enabled ? 'ON' : 'OFF';
  if (s.source === 'env') return `Always Auto: ${state} (no store row; env ${s.envVar} boot default)`;
  const since = s.since ? `${new Date(s.since).toISOString().slice(0, 16).replace('T', ' ')}Z` : 'unknown';
  return `Always Auto: ${state} since ${since} by ${s.updatedBy ?? 'unknown'} (store row; deleting it reverts to the env boot default = ${s.bootDefault ? 'ON' : 'OFF'})`;
}

/** The switch with since / updatedBy / source — GET /admin/settings/patience. Never throws. */
export async function getPatienceAutoOnlyState(): Promise<PatienceSwitchState> {
  const bootDefault = patienceAutoOnlyBootDefault();
  let enabled = bootDefault;
  let since: string | null = null;
  let updatedBy: string | null = null;
  let source: 'setting' | 'env' = 'env';
  try {
    const [row, byRow] = await Promise.all([
      prisma.systemSetting.findUnique({ where: { key: PATIENCE_AUTO_ONLY_KEY } }),
      prisma.systemSetting.findUnique({ where: { key: PATIENCE_AUTO_ONLY_BY_KEY } }),
    ]);
    if (row) {
      enabled = onFlag(row.value);
      source = 'setting';
      since = row.updatedAt ? new Date(row.updatedAt).toISOString() : null;
      updatedBy = byRow?.value ? String(byRow.value) : null;
    }
  } catch (err: any) {
    logger.warn(`patience-switch: state read failed (reporting the cached/boot value): ${err?.message ?? err}`);
    enabled = _cachedAutoOnly ?? bootDefault;
  }
  const base = { key: PATIENCE_AUTO_ONLY_KEY, enabled, since, updatedBy, source, bootDefault, envVar: PATIENCE_AUTO_ONLY_ENV };
  return { ...base, line: patienceSwitchLine(base) };
}

export interface PatienceSwitchFlipResult {
  key: string;
  enabled: boolean;
  /** false = the stored value already matched — nothing written, `since` untouched. */
  changed: boolean;
  setting: { key: string; value: string; updatedAt?: Date } | null;
}

/** The prod-state branch's names for the same shapes (audit 2026-09-26; both audit branches merged). */
export type PatienceAutoOnlyState = PatienceSwitchState;
export type PatienceAutoOnlyFlipResult = PatienceSwitchFlipResult;

/**
 * Write the switch (idempotent): compares against the STORED truth (uncached)
 * and returns changed:false without touching the row when it already matches,
 * so `since` stays the real flip time. A real flip upserts the value + the
 * `patience_auto_only_by` audit row, invalidates the cache and writes the
 * {action:'flipped'} telemetry row — the next flip is attributable. A missing
 * row is always written (the env boot default is not a stored truth).
 */
export async function setPatienceAutoOnly(enabled: boolean, by: string): Promise<PatienceSwitchFlipResult> {
  const row = await prisma.systemSetting.findUnique({ where: { key: PATIENCE_AUTO_ONLY_KEY } });
  const current = row ? onFlag(row.value) : patienceAutoOnlyBootDefault();
  if (row && current === enabled) {
    return { key: PATIENCE_AUTO_ONLY_KEY, enabled, changed: false, setting: { key: row.key, value: row.value, updatedAt: row.updatedAt } };

  }
  const value = enabled ? '1' : '0';
  const setting = await prisma.systemSetting.upsert({
    where: { key: PATIENCE_AUTO_ONLY_KEY },
    update: { value },
    create: { key: PATIENCE_AUTO_ONLY_KEY, value },
  });
  await prisma.systemSetting.upsert({
    where: { key: PATIENCE_AUTO_ONLY_BY_KEY },
    update: { value: by },
    create: { key: PATIENCE_AUTO_ONLY_BY_KEY, value: by },
  }).catch((err: any) => logger.warn(`patience-switch: audit row write failed: ${err?.message ?? err}`));
  invalidatePatienceAutoOnlyCache();
  recordLoopMetric({ kind: PATIENCE_SWITCH_METRIC_KIND, meta: { action: 'flipped', enabled, by, previous: current, previousSource: row ? 'setting' : 'env' } });
  logger.info(`patience-switch: Always Auto (patience_auto_only) turned ${enabled ? 'ON' : 'OFF'} by ${by}${row ? '' : ' (first store row; was the env boot default)'}`);
  return { key: PATIENCE_AUTO_ONLY_KEY, enabled, changed: true, setting: { key: setting.key, value: setting.value, updatedAt: setting.updatedAt } };
}

/**
 * The user-facing flag (GET /depth/policy): is every human send routed as
 * Auto right now? Read from the same 60 s cache. Never throws.
 */
export async function getDepthPolicyPublic(): Promise<{ autoOnly: boolean }> {
  try {
    return { autoOnly: await getPatienceAutoOnly() };
  } catch {
    return { autoOnly: false };
  }
}

// ── Redis key helpers ────────────────────────────────────────────────────────

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function usageKey(userId: string): string {
  return `deep_research_usage:${userId}:${todayUTC()}`;
}

/**
 * Get the current usage count for a user today.
 */
export async function getDeepResearchUsage(userId: string): Promise<number> {
  try {
    const val = await redisClient.get(usageKey(userId));
    return val ? parseInt(val, 10) : 0;
  } catch (err) {
    logger.warn('Redis getDeepResearchUsage failed:', err);
    return 0; // fail-open: allow the request if Redis is down
  }
}

/**
 * Increment the usage counter for a user today.
 * Sets a TTL of 24 hours so the key auto-expires.
 */
export async function incrementDeepResearchUsage(userId: string): Promise<number> {
  try {
    const key = usageKey(userId);
    const newCount = await redisClient.incr(key);
    // Set TTL to expire at end of day UTC (or 24h as a safe fallback)
    const now = new Date();
    const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const ttlSeconds = Math.max(Math.ceil((endOfDay.getTime() - now.getTime()) / 1000), 60);
    await redisClient.expire(key, ttlSeconds);
    return newCount;
  } catch (err) {
    logger.warn('Redis incrementDeepResearchUsage failed:', err);
    return 0; // fail-open
  }
}

/**
 * Check whether a user can use deep_research right now.
 * Returns { allowed, used, limit, remaining }.
 */
export async function checkDeepResearchQuota(userId: string): Promise<{
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
}> {
  const [used, limit] = await Promise.all([
    getDeepResearchUsage(userId),
    getDeepResearchDailyLimit(),
  ]);
  const remaining = Math.max(0, limit - used);
  return { allowed: used < limit, used, limit, remaining };
}

/**
 * Atomically reserve one deep_research use for a user today.
 *
 * INCR-first (atomic) then compare, so two concurrent requests can't both pass
 * a check-then-increment gap and blow past the daily limit. If the reservation
 * pushes the user over their limit we refund (DECR) and reject. The key's TTL
 * is (re)set on the winning INCR so it still auto-expires at end of day.
 *
 * Fails OPEN (allowed:true) if Redis is unavailable — matches the read-path
 * behavior so a Redis outage never hard-blocks paying users.
 */
export async function reserveDeepResearchQuota(userId: string): Promise<{
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
}> {
  const limit = await getDeepResearchDailyLimit();
  try {
    const key = usageKey(userId);
    const newCount = await redisClient.incr(key);
    // Set/refresh TTL to expire at end of day UTC (24h fallback).
    const now = new Date();
    const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const ttlSeconds = Math.max(Math.ceil((endOfDay.getTime() - now.getTime()) / 1000), 60);
    await redisClient.expire(key, ttlSeconds);

    if (newCount > limit) {
      // Over quota — refund the reservation so a rejected attempt doesn't
      // permanently consume a slot, and report the real (pre-attempt) usage.
      try { await redisClient.decr(key); } catch { /* best-effort refund */ }
      return { allowed: false, used: limit, limit, remaining: 0 };
    }
    return { allowed: true, used: newCount, limit, remaining: Math.max(0, limit - newCount) };
  } catch (err) {
    logger.warn('Redis reserveDeepResearchQuota failed (fail-open):', err);
    return { allowed: true, used: 0, limit, remaining: limit };
  }
}

/**
 * Give back ONE reserved deep_research use (audit 2026-10-03): a slot reserved
 * for a send that then never ran (the busy-queue enqueue failed) is returned.
 * Never drops the counter below 0; best-effort (a Redis error is logged, the
 * slot stays spent — the conservative failure).
 */
export async function refundDeepResearchQuota(userId: string): Promise<void> {
  try {
    const key = usageKey(userId);
    const after = await redisClient.decr(key);
    if (after < 0) await redisClient.incr(key).catch(() => 0); // the key had expired at midnight — back to 0, never negative
  } catch (err) {
    logger.warn('Redis refundDeepResearchQuota failed (slot stays spent):', err);
  }
}

/** QUEUED_COUNCIL_QUOTA_DISABLED=1 — a busy-chat Level 3 send is queued with no reserve (the pre-2026-10-03 behaviour: the drain ran the council unmetered). */
export function queuedCouncilQuotaDisabled(): boolean {
  const s = String(process.env.QUEUED_COUNCIL_QUOTA_DISABLED ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
}

// ── Anonymous (guest) deep research — owner 2026-09-23 ───────────────────────
// Signed-out visitors may run Deep Research too, under a SEPARATE, smaller
// daily allowance keyed on the client IP (guests have no stable identity; the
// cm_session cookie is client-controlled and trivially rotated). The key
// prefix deliberately differs from `deep_research_usage:` so the admin
// per-user usage scan above never parses an IP (IPv6 has colons) as a userId.
// ANON_DEEP_RESEARCH_DAILY_LIMIT overrides the default (0 disables guests).

export const DEFAULT_ANON_DEEP_RESEARCH_DAILY_LIMIT = 2;

export function getAnonDeepResearchDailyLimit(): number {
  const raw = process.env.ANON_DEEP_RESEARCH_DAILY_LIMIT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ANON_DEEP_RESEARCH_DAILY_LIMIT;
  const n = parseInt(raw, 10);
  return isNaN(n) || n < 0 ? DEFAULT_ANON_DEEP_RESEARCH_DAILY_LIMIT : n;
}

function anonUsageKey(clientIp: string): string {
  return `deep_research_anon_usage:${clientIp || 'unknown'}:${todayUTC()}`;
}

/**
 * Atomically reserve one guest deep_research use for this client IP today.
 * Same INCR-first + refund shape as reserveDeepResearchQuota. Unlike the
 * signed-in path this fails CLOSED on a Redis outage: guests are unmetered
 * otherwise, and the council is the most expensive run we offer.
 */
export async function reserveAnonDeepResearchQuota(clientIp: string): Promise<{
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
}> {
  const limit = getAnonDeepResearchDailyLimit();
  if (limit === 0) return { allowed: false, used: 0, limit, remaining: 0 };
  try {
    const key = anonUsageKey(clientIp);
    const newCount = await redisClient.incr(key);
    const now = new Date();
    const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const ttlSeconds = Math.max(Math.ceil((endOfDay.getTime() - now.getTime()) / 1000), 60);
    await redisClient.expire(key, ttlSeconds);
    if (newCount > limit) {
      try { await redisClient.decr(key); } catch { /* best-effort refund */ }
      return { allowed: false, used: limit, limit, remaining: 0 };
    }
    return { allowed: true, used: newCount, limit, remaining: Math.max(0, limit - newCount) };
  } catch (err) {
    logger.warn('Redis reserveAnonDeepResearchQuota failed (fail-closed):', err);
    return { allowed: false, used: 0, limit, remaining: 0 };
  }
}

/**
 * Non-reserving twin of reserveAnonDeepResearchQuota (patience plan §3.4):
 * does this client IP still have a guest council slot today? Never
 * increments; the same key and limit as the reserve; fails CLOSED (Redis
 * error ⇒ not allowed), and limit 0 ⇒ not allowed.
 */
export async function checkAnonDeepResearchQuota(clientIp: string): Promise<{
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
}> {
  const limit = getAnonDeepResearchDailyLimit();
  if (limit === 0) return { allowed: false, used: 0, limit, remaining: 0 };
  try {
    const val = await redisClient.get(anonUsageKey(clientIp));
    const used = val ? parseInt(val, 10) || 0 : 0;
    return { allowed: used < limit, used, limit, remaining: Math.max(0, limit - used) };
  } catch (err) {
    logger.warn('Redis checkAnonDeepResearchQuota failed (fail-closed):', err);
    return { allowed: false, used: 0, limit, remaining: 0 };
  }
}

export type DeepResearchAllowanceReason = 'quota_exhausted' | 'quota_unavailable' | 'guest_no_research';

/**
 * Pre-decision allowance for the Auto router (patience plan §3.4): may an
 * Auto pick of Level 3 stand for this sender? Non-reserving (the reserve at
 * the council site still runs for a permitted pick).
 *   signed-in — checkDeepResearchQuota; under `strict` (the patience_auto_only
 *               switch) a Redis error FAILS CLOSED (`quota_unavailable`):
 *               the heuristic promotes on bare words with no human choosing
 *               Level 3, so an outage must floor to Ensemble.
 *   guest     — `guest_no_research` until the hop-count probe proves a
 *               per-client quota key (§3.4 prerequisite; `guestAllowed:true`
 *               opts into the anon check once it is proven).
 */
export async function deepResearchAllowance(opts: { userId?: string | null; clientIp?: string; strict?: boolean; guestAllowed?: boolean }): Promise<{
  allowed: boolean;
  reasonKey?: DeepResearchAllowanceReason;
  remaining?: number;
  limit?: number;
}> {
  if (!opts.userId) {
    if (!opts.guestAllowed) return { allowed: false, reasonKey: 'guest_no_research' };
    const a = await checkAnonDeepResearchQuota(opts.clientIp || 'unknown');
    return a.allowed ? { allowed: true, remaining: a.remaining, limit: a.limit } : { allowed: false, reasonKey: a.limit === 0 ? 'guest_no_research' : 'quota_exhausted', remaining: 0, limit: a.limit };
  }
  try {
    const limit = await getDeepResearchDailyLimit();
    const val = await redisClient.get(usageKey(opts.userId));
    const used = val ? parseInt(val, 10) || 0 : 0;
    return used < limit
      ? { allowed: true, remaining: Math.max(0, limit - used), limit }
      : { allowed: false, reasonKey: 'quota_exhausted', remaining: 0, limit };
  } catch (err) {
    logger.warn(`Redis deepResearchAllowance failed (${opts.strict ? 'fail-closed under patience_auto_only' : 'fail-open'}):`, err);
    return opts.strict ? { allowed: false, reasonKey: 'quota_unavailable' } : { allowed: true };
  }
}

/**
 * Get aggregated deep_research usage for all users today.
 * Scans Redis keys matching the pattern. Used by admin dashboard.
 */
export async function getAllDeepResearchUsageToday(): Promise<
  { userId: string; count: number }[]
> {
  const pattern = `deep_research_usage:*:${todayUTC()}`;
  const results: { userId: string; count: number }[] = [];

  try {
    let cursor = 0;
    do {
      const reply = await redisClient.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = reply.cursor;
      for (const key of reply.keys) {
        const parts = key.split(':');
        const userId = parts[1]; // deep_research_usage:{userId}:{date}
        const val = await redisClient.get(key);
        if (userId && val) {
          results.push({ userId, count: parseInt(val, 10) });
        }
      }
    } while (cursor !== 0);
  } catch (err) {
    logger.warn('Redis scan for deep_research usage failed:', err);
  }

  return results;
}

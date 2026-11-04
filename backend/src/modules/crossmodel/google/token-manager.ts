/**
 * Google OAuth Token Manager
 *
 * Loads tokens from DB, decrypts, auto-refreshes if expired (5-min buffer),
 * and returns a valid access token for the given user.
 *
 * Supports multiple Google accounts per user (via label field).
 * When no label is specified, returns the first connected account (most users have one).
 *
 * Uses axios (already a backend dep) to call the Google token refresh endpoint
 * directly — no need for google-auth-library.
 */

import axios from 'axios';
import prisma from '../../../config/database';
import { encrypt, decrypt } from './crypto';
import logger from '../../../utils/logger';

/** Refresh tokens that expire within this many ms */
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * disabled-client latch (FO firing f156, 2026-10-18; family extended f157,
 * same day). A `disabled_client` OR `unauthorized_client` answer from the
 * refresh endpoint is a terminal CLIENT-level error — the OAuth client itself
 * is disabled/deleted in Google Cloud Console, so EVERY refresh fails until an
 * admin re-enables/replaces it. Google returns EITHER string for the same dead
 * client: f156 latched `disabled_client` (n=119/4 h), hours later prod flipped
 * to `unauthorized_client` for the same userId (n=253/4 h, still hot after the
 * f156 full-fleet roll — the exact escape f157 closes). It says nothing about
 * the user's grant, so unlike
 * invalid_grant the token row is KEPT (a re-enabled client makes the stored
 * refresh token work again). Without a latch, every getValidToken /
 * getAllValidTokens call re-attempts the refresh: one expired admin token looped
 * a level=error row every ~90 s (first 2026-10-17T23:59:27Z, n=119 in 4 h —
 * errors-1h read 38 against the 10.1/h standing baseline). While latched,
 * refreshes short-circuit to null with NO log; the first failure per window logs
 * ONE error and files ONE loop_metrics row (google_refresh_latch). Process-local
 * by design (the DeepSeek billing-latch shape, utils/utility-llm.ts) — every
 * process learns it once. Kill switch / tuning:
 * GOOGLE_REFRESH_DISABLED_CLIENT_LATCH_MS (default 6 h; 0 = latch off, legacy
 * behavior — every failure attempts + logs).
 */
const DISABLED_CLIENT_LATCH_DEFAULT_MS = 6 * 60 * 60 * 1000;
let googleDisabledClientLatchUntil = 0;
export function googleDisabledClientLatched(now: number = Date.now()): boolean { return now < googleDisabledClientLatchUntil; }
export function __resetGoogleDisabledClientLatchForTests(): void { googleDisabledClientLatchUntil = 0; }
function disabledClientLatchMs(): number {
  const raw = Number(process.env.GOOGLE_REFRESH_DISABLED_CLIENT_LATCH_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DISABLED_CLIENT_LATCH_DEFAULT_MS;
}

/**
 * FLEET-WIDE emission latch (ticket 07c1d554, 2026-10-19 — the e1cca01d
 * shape, github/token-manager.ts acquireFallbackWarnLatch). The f156/f157
 * latch above is PROCESS-LOCAL by design (every process must stop hammering
 * Google), which made its OWN one-per-window emission per-process too: on the
 * 3-box web+worker fleet with same-day deploy restarts, every process
 * relearned the dead client and re-emitted the level=error row — 35 rows
 * across 13 hours in 24 h from TWO dead-client users (each box's web+worker
 * pair × restarts), exactly the multi-process latch class e1cca01d convicted
 * for the label-miss warn. The EMISSION (error row + google_refresh_latch
 * metric) is now gated by a Redis NX key per userId, TTL
 * GOOGLE_REFRESH_LATCH_WARN_MS (default 24 h; 0 = legacy — every latch-arm
 * emits, the old per-window behavior). The retry latch stays 6 h /
 * GOOGLE_REFRESH_DISABLED_CLIENT_LATCH_MS: refreshes still silently re-check
 * the client every window (a re-enabled client recovers at that cadence),
 * only the LOG is once per user per day fleet-wide. Fail-open on a Redis
 * error (never silence the state — the e1cca01d doctrine), and a healthy
 * refresh releases a key THIS process holds so a later re-break warns at
 * once, not at TTL.
 */
const GOOGLE_REFRESH_LATCH_WARN_DEFAULT_MS = 24 * 60 * 60 * 1000;
const GOOGLE_REFRESH_WARN_LATCH_KEY = (userId: string) => `google:refresh-dead-client-warn:${userId}`;
/** Keys THIS process acquired — the only ones it may release on a healthy refresh. */
const googleRefreshWarnLatchedHere = new Set<string>();
export function __resetGoogleRefreshWarnLatchForTests(): void { googleRefreshWarnLatchedHere.clear(); }
function googleRefreshLatchWarnMs(): number {
  const raw = process.env.GOOGLE_REFRESH_LATCH_WARN_MS;
  if (raw === undefined || raw.trim() === '') return GOOGLE_REFRESH_LATCH_WARN_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : GOOGLE_REFRESH_LATCH_WARN_DEFAULT_MS;
}
/** True when this failure should emit its error + metric: the fleet latch was
 *  just acquired ('OK'), the kill switch is off (0 = legacy every-arm), or
 *  Redis is unavailable (fail-open). */
async function acquireGoogleRefreshEmitLatch(userId: string): Promise<boolean> {
  const ttlMs = googleRefreshLatchWarnMs();
  if (ttlMs === 0) return true; // legacy: every latch-arm emits
  try {
    const redis: any = (await import('../../../config/redis')).default;
    const key = GOOGLE_REFRESH_WARN_LATCH_KEY(userId);
    const got = await redis.set(key, String(Date.now()), { NX: true, PX: ttlMs });
    if (got === 'OK') {
      googleRefreshWarnLatchedHere.add(key);
      return true;
    }
    return false;
  } catch {
    return true; // fail-open — never silence a dead-client state
  }
}
/** A healthy refresh ends the dead-client state — release a warn key THIS
 *  process holds, so a later re-break (disconnect + reconnect again) warns at
 *  once instead of at TTL. */
async function releaseGoogleRefreshWarnLatchIfHeld(userId: string): Promise<void> {
  const key = GOOGLE_REFRESH_WARN_LATCH_KEY(userId);
  if (!googleRefreshWarnLatchedHere.has(key)) return;
  googleRefreshWarnLatchedHere.delete(key);
  try {
    const redis: any = (await import('../../../config/redis')).default;
    await redis.del(key);
  } catch { /* best-effort — the TTL lapses otherwise */ }
}

/**
 * Returns a valid Google access token for the user, refreshing if needed.
 * If label is specified, returns the token for that specific account.
 * Otherwise, returns the first available token (primary account).
 * Returns null if no token is stored or if refresh fails.
 */
export async function getValidToken(userId: string, label?: string): Promise<string | null> {
  try {
    const where = label
      ? { userId_label: { userId, label } }
      : undefined;

    const row = label
      ? await (prisma as any).googleOAuthToken.findUnique({ where })
      // No label → deterministic "first connected" account (oldest), so single-account
      // tools (incl. Gmail send) always resolve to the same account across calls.
      : await (prisma as any).googleOAuthToken.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } });

    if (!row) return null;

    const accessToken = decrypt(row.accessToken);

    // Token still valid — return it
    if (row.expiresAt.getTime() - Date.now() > REFRESH_BUFFER_MS) {
      return accessToken;
    }

    // Token expired (or close to expiry) — refresh it
    return await refreshToken(row);
  } catch (error: any) {
    logger.error(`getValidToken failed for userId=${userId}: ${error.message}`);
    return null;
  }
}

async function refreshToken(row: any): Promise<string | null> {
  // disabled_client latch: the OAuth client itself is dead — no attempt, no log
  // (one error + one metric per latch window, filed by the catch below).
  if (googleDisabledClientLatched()) return null;

  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    logger.error('Google OAuth credentials not configured — cannot refresh token');
    return null;
  }

  try {
    const refreshTokenDecrypted = decrypt(row.refreshToken);

    const params = new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshTokenDecrypted,
      grant_type:    'refresh_token',
    });

    const response = await axios.post(
      'https://oauth2.googleapis.com/token',
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      }
    );

    const { access_token, expires_in } = response.data as {
      access_token: string;
      expires_in: number;
    };

    const newExpiresAt = new Date(Date.now() + expires_in * 1000);

    // Update using the row's id (primary key) — supports multi-account
    await (prisma as any).googleOAuthToken.update({
      where: { id: row.id },
      data: {
        accessToken: encrypt(access_token),
        expiresAt:   newExpiresAt,
      },
    });

    logger.info(`Google token refreshed for userId=${row.userId}, label=${row.label}`);
    await releaseGoogleRefreshWarnLatchIfHeld(row.userId);
    return access_token;
  } catch (error: any) {
    const errCode = error.response?.data?.error;
    const errMsg = errCode || error.message;

    // disabled_client / unauthorized_client are terminal CLIENT-level (see the
    // latch note above): ONE
    // error + ONE loop_metrics row per latch window, then silent short-circuits
    // until the window expires and a retry re-checks the client. The token row
    // is KEPT — a disabled client says nothing about the user's grant.
    if (errCode === 'disabled_client' || errCode === 'unauthorized_client') {
      const latchMs = disabledClientLatchMs();
      if (latchMs > 0) {
        if (!googleDisabledClientLatched()) {
          // ALWAYS arm the process-local latch (this process must stop
          // hammering Google even when the emission is suppressed elsewhere).
          googleDisabledClientLatchUntil = Date.now() + latchMs;
          // (07c1d554) the EMISSION is fleet-latched: one error row per user
          // per GOOGLE_REFRESH_LATCH_WARN_MS across web+worker+boxes. A
          // suppressed arm still records a loop_metrics row (a positive
          // observable for post-deploy probes — loop_metrics is invisible to
          // the app_error_logs sweep).
          const emit = await acquireGoogleRefreshEmitLatch(row.userId);
          if (emit) {
            logger.error(`Google token refresh failed for userId=${row.userId}: ${errCode} — the OAuth client is disabled/unauthorized (Google Cloud Console); latching refreshes for ${latchMs} ms (GOOGLE_REFRESH_DISABLED_CLIENT_LATCH_MS)`);
            void import('../platform/loop-metrics.service')
              .then(({ recordLoopMetric, LOOP_METRIC_KINDS }) => recordLoopMetric({
                kind: LOOP_METRIC_KINDS.GOOGLE_REFRESH_LATCH,
                meta: { error: errCode, latchMs, userId: row.userId, label: row.label },
              }))
              .catch(() => undefined);
          } else {
            void import('../platform/loop-metrics.service')
              .then(({ recordLoopMetric, LOOP_METRIC_KINDS }) => recordLoopMetric({
                kind: LOOP_METRIC_KINDS.GOOGLE_REFRESH_LATCH_SUPPRESSED,
                meta: { error: errCode, latchMs, userId: row.userId, label: row.label },
              }))
              .catch(() => undefined);
          }
        }
        return null;
      }
      // latchMs === 0 (kill switch) → legacy behavior: fall through to the
      // shared log (and the status-400 deletion below, exactly as before).
    }

    logger.error(`Google token refresh failed for userId=${row.userId}: ${errMsg}`);

    // If refresh token is revoked/invalid, delete this specific token row
    if (
      error.response?.data?.error === 'invalid_grant' ||
      error.response?.status === 400
    ) {
      try {
        await (prisma as any).googleOAuthToken.delete({ where: { id: row.id } });
        logger.info(`Deleted invalid Google token id=${row.id} for userId=${row.userId} (invalid_grant)`);
      } catch { /* already deleted or doesn't exist */ }
    }

    return null;
  }
}

/**
 * Returns valid access tokens for ALL connected Google accounts for the user.
 * Used to fan-out queries across every workspace the user has authorized.
 * Each entry contains the decrypted, refreshed token plus its label and email.
 */
export async function getAllValidTokens(
  userId: string
): Promise<Array<{ token: string; label: string; email?: string }>> {
  try {
    const rows = await (prisma as any).googleOAuthToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    if (!rows || rows.length === 0) return [];

    const results: Array<{ token: string; label: string; email?: string }> = [];

    for (const row of rows) {
      try {
        const accessToken = decrypt(row.accessToken);

        // Token still valid — use it directly
        if (row.expiresAt.getTime() - Date.now() > REFRESH_BUFFER_MS) {
          results.push({
            token: accessToken,
            label: row.label || 'Personal',
            email: row.email || undefined,
          });
        } else {
          // Near expiry — refresh before use
          const refreshed = await refreshToken(row);
          if (refreshed) {
            results.push({
              token: refreshed,
              label: row.label || 'Personal',
              email: row.email || undefined,
            });
          }
        }
      } catch (err: any) {
        logger.warn(
          `getAllValidTokens: skipping account "${row.label}" for userId=${userId}: ${err.message}`
        );
      }
    }

    return results;
  } catch (error: any) {
    logger.error(`getAllValidTokens failed for userId=${userId}: ${error.message}`);
    return [];
  }
}

/**
 * Check if a user has at least one connected Google account.
 */
export async function hasGoogleConnected(userId: string): Promise<boolean> {
  try {
    const row = await (prisma as any).googleOAuthToken.findFirst({
      where: { userId },
      select: { id: true },
    });
    return row !== null;
  } catch {
    return false;
  }
}

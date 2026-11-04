/**
 * GitHub OAuth Token Manager
 *
 * Loads tokens from DB, decrypts using GITHUB_TOKEN_ENCRYPTION_KEY,
 * and returns valid access tokens for the given user.
 *
 * GitHub tokens do NOT expire — no refresh logic needed.
 *
 * Supports multiple GitHub accounts per user (via label field).
 * Uses (prisma as any).gitHubOAuthToken (capital H from Prisma model name).
 */

import prisma from '../../../config/database';
import { decryptWith } from '../google/crypto';
import logger from '../../../utils/logger';

/**
 * Label-miss fallback WARN latch (log-signal family lane 65787dde, ticket
 * e1cca01d, 2026-10-19; the f156 disabled_client latch shape, hardened per
 * adversarial review). The f121-hook fallback itself is correct and MUST keep
 * firing — it is the only thing that keeps pushes/PRs/merges working after a
 * connector disconnect+reconnect renames the account labels. But the warn
 * used to log on EVERY getValidToken call: six projects pinned the dead
 * "pasta_paul" label and a busy coding lane hot-looped 73 warn rows in 5 h
 * (RULE 1 recurrence: 6 distinct hours), all byte-identical, all from ONE
 * standing degraded state.
 *
 * FLEET-WIDE Redis NX latch (adversarial review finding 1: a process-local
 * 6 h latch still emits 4 rows/24 h in ONE process — 4 distinct hours ≥
 * RULE1_MIN_HOURS=3 — and ×6 processes across the fleet; the sweep would keep
 * filing this fingerprint). One key per (userId, pinnedLabel), PX = the
 * window: the first miss FLEET-WIDE warns + files one loop_metrics row,
 * every later miss falls back silently until the TTL lapses. A 24 h default
 * spaces rows ≥ 24 h apart, so any rolling 24 h window holds ≤ 2 rows ≤ 2
 * distinct hours — below RULE 1's 3-hour bar (RULE 2 never applies: the
 * message makes no suppression promise — "silence this" does not match
 * SUPPRESSION_PROMISE_RE). Fail-OPEN on a Redis error: an infra hiccup must
 * never silence the degraded state (the pre-fix warn-every-miss behavior
 * returns for the outage's duration, which is loud but honest).
 *
 * Recovery: a label HIT releases a latch this process acquired (one DEL —
 * no steady-state Redis traffic on the hot path; a latch another process
 * holds simply lapses at its TTL). Kill switch / tuning:
 * GITHUB_LABEL_FALLBACK_WARN_MS (default 24 h; 0 = legacy behavior — every
 * miss warns, no latch is set). Empty/unset/negative values fall back to the
 * default (compose forwards `${VAR:-}` as an EMPTY string, and Number('')===0
 * would otherwise silently disarm the latch — review finding 4).
 */
const GITHUB_LABEL_FALLBACK_WARN_DEFAULT_MS = 24 * 60 * 60 * 1000;
const GITHUB_LABEL_FALLBACK_LATCH_KEY = (userId: string, label: string) =>
  `github:label-fallback-warn:${userId}|${label}`;
/** Keys THIS process acquired — the only ones it may release on a label hit.
 *  Bounded by the distinct (userId,label) misses this process saw first. */
const githubLabelWarnLatchedHere = new Set<string>();
export function __resetGithubLabelFallbackLatchForTests(): void {
  githubLabelWarnLatchedHere.clear();
}
function githubLabelFallbackWarnMs(): number {
  const raw = process.env.GITHUB_LABEL_FALLBACK_WARN_MS;
  if (raw === undefined || raw.trim() === '') return GITHUB_LABEL_FALLBACK_WARN_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : GITHUB_LABEL_FALLBACK_WARN_DEFAULT_MS;
}
/** Log-safe interpolation for user-authored labels (review finding 9): a
 *  label carrying \n must not forge log lines or split the sweep fingerprint. */
function logSafeLabel(s: unknown): string {
  return String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120) || 'unknown';
}
/** True when this miss should warn: either the fleet latch was just acquired
 *  ('OK') or Redis is unavailable (fail-open — never silence the state). */
async function acquireFallbackWarnLatch(userId: string, label: string, ttlMs: number): Promise<boolean> {
  try {
    const redis: any = (await import('../../../config/redis')).default;
    const key = GITHUB_LABEL_FALLBACK_LATCH_KEY(userId, label);
    const got = await redis.set(key, String(Date.now()), { NX: true, PX: ttlMs });
    if (got === 'OK') {
      githubLabelWarnLatchedHere.add(key);
      return true;
    }
    return false;
  } catch {
    return true; // fail-open
  }
}
/** A label HIT ends the degraded state — release a latch THIS process holds so
 *  a later re-break (disconnect+reconnect again) warns at once, not at TTL. */
async function releaseFallbackWarnLatchIfHeld(userId: string, label: string): Promise<void> {
  const key = GITHUB_LABEL_FALLBACK_LATCH_KEY(userId, label);
  if (!githubLabelWarnLatchedHere.has(key)) return;
  githubLabelWarnLatchedHere.delete(key);
  try {
    const redis: any = (await import('../../../config/redis')).default;
    await redis.del(key);
  } catch { /* best-effort — the TTL lapses otherwise */ }
}

/**
 * Returns a valid GitHub access token for the user.
 * If label is specified, returns the token for that specific account.
 * Otherwise, returns the FIRST-CONNECTED account's token (the primary
 * account) — deterministic, matching getAllValidTokens' createdAt-asc
 * ordering. The previous unordered findFirst let Postgres return an
 * arbitrary row, so multi-account users got repos created under an
 * unpredictable account (ticket b1852d45: "it should have my gh. pat token"
 * — a chat-created repo landed somewhere the user could not find).
 * Returns null if no token is stored.
 */
export async function getValidToken(userId: string, label?: string): Promise<string | null> {
  try {
    const where = label
      ? { userId_label: { userId, label } }
      : undefined;

    let row = label
      ? await (prisma as any).gitHubOAuthToken.findUnique({ where })
      : await (prisma as any).gitHubOAuthToken.findFirst({
          where: { userId },
          orderBy: { createdAt: 'asc' },
        });
    // True ONLY when the pinned label itself hit — NOT on the fallback below
    // (e1cca01d: the recovery release must not fire on a fallback row, or it
    // would DEL the latch key the miss just acquired and the latch would
    // never hold).
    const labelHit = !!row;
    // Label-miss fallback (FO f121-hook, 2026-10-12): a disconnect+reconnect of
    // the GitHub connector can re-create the account rows under DIFFERENT labels
    // than the one a project pinned at configure-workspace time. The hard
    // findUnique miss then returned null and refused EVERY push/PR/merge on that
    // project ("No connected GitHub account/token") while unlabeled reads kept
    // working — a fleet-wide write outage with NO log line anywhere (the
    // !row path was silent). When the pinned label matches no row, fall back to
    // the first-connected account — deterministic (createdAt asc, the same
    // ordering getAllValidTokens documents) so ticket b1852d45's
    // wrong-account-hijack concern stays answered — and WARN so the degraded
    // state shows up in the error/telemetry surface. Kill switch:
    // GITHUB_LABEL_FALLBACK_DISABLED=1 restores the old hard failure.
    if (!row && label && process.env.GITHUB_LABEL_FALLBACK_DISABLED !== '1') {
      row = await (prisma as any).gitHubOAuthToken.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      if (row) {
        // e1cca01d latch (see the module-header note): the FIRST miss per
        // (userId,label) per fleet-wide TTL window warns + files ONE
        // github_label_fallback metric row; later misses fall back silently.
        // The FALLBACK still happens every call — only the logging is latched.
        const warnMs = githubLabelFallbackWarnMs();
        if (warnMs === 0 || (await acquireFallbackWarnLatch(userId, label, warnMs))) {
          logger.warn(
            `getValidToken: no GitHub account labeled "${logSafeLabel(label)}" for userId=${userId} — ` +
            `falling back to first-connected account "${logSafeLabel(row.label || 'Personal')}" (${logSafeLabel(row.username)}). ` +
            `Re-pin the project label or reconnect with the original label to silence this.`
          );
          void import('../platform/loop-metrics.service')
            .then(({ recordLoopMetric, LOOP_METRIC_KINDS }) => recordLoopMetric({
              kind: LOOP_METRIC_KINDS.GITHUB_LABEL_FALLBACK,
              meta: { pinnedLabel: label, fallbackLabel: row.label ?? null, fallbackUsername: row.username ?? null, userId, warnMs },
            }))
            .catch(() => undefined);
        }
      }
    }

    if (!row) return null;

    // e1cca01d: only a genuine label HIT ends the degraded state — release a
    // warn latch THIS process holds (a later re-break warns at once, not at
    // TTL). Never on the fallback row (see labelHit's comment).
    if (labelHit && label) await releaseFallbackWarnLatchIfHeld(userId, label);

    return decryptWith(row.accessToken, 'GITHUB_TOKEN_ENCRYPTION_KEY');
  } catch (error: any) {
    logger.error(`getValidToken failed for userId=${userId}: ${error.message}`);
    return null;
  }
}

/**
 * Returns valid access tokens for ALL connected GitHub accounts for the user.
 * Each entry contains the decrypted token plus its label and username.
 */
export async function getAllValidTokens(
  userId: string
): Promise<Array<{ token: string; label: string; username?: string }>> {
  try {
    const rows = await (prisma as any).gitHubOAuthToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    if (!rows || rows.length === 0) return [];

    const results: Array<{ token: string; label: string; username?: string }> = [];

    for (const row of rows) {
      try {
        const token = decryptWith(row.accessToken, 'GITHUB_TOKEN_ENCRYPTION_KEY');
        results.push({
          token,
          label: row.label || 'Personal',
          username: row.username || undefined,
        });
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
 * Check if a user has at least one connected GitHub account.
 */
export async function hasGitHubConnected(userId: string): Promise<boolean> {
  try {
    const row = await (prisma as any).gitHubOAuthToken.findFirst({
      where: { userId },
      select: { id: true },
    });
    return row !== null;
  } catch {
    return false;
  }
}

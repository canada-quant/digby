/**
 * OAuth-first read fallback (ticket f609ec35, 2026-09-22).
 *
 * X read tools prefer the authenticated X API v2 path when the caller's
 * per-user OAuth token is attached (X-X-Token header) — the unauthenticated
 * Bright Data scrape is defeated by X's login wall on profile/search pages.
 * When the API read is rejected (401/402/403 — the developer-app tier lacks
 * read access — the classic Free-tier case) we fall back to the scrape path
 * AND negative-cache the rejection per token, so a Free-tier app does not pay
 * a doomed 403 round-trip on every single read. Transient failures (429, 5xx,
 * network) fall back WITHOUT caching — the next read retries the API.
 */

import { createHash } from 'node:crypto';

const FORBIDDEN_TTL_MS = 60 * 60 * 1000; // 1h — tokens live ~2h, app tiers change rarely

const forbiddenUntil = new Map<string, number>();

/** Test hook: clear the negative cache between cases. */
export function resetApiReadCache(): void {
  forbiddenUntil.clear();
}

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Extract an HTTP status from an axios-style error, when present. */
function errorStatus(err: unknown): number | undefined {
  const e = err as { response?: { status?: number }; status?: number } | undefined;
  return e?.response?.status ?? e?.status;
}

export interface ReadFallbackDeps {
  /** Authenticated X API v2 read — must THROW on failure so we can fall back. */
  apiRead: (token: string) => Promise<string>;
  /** Unauthenticated scrape read (already wall-detected in brightdata-client). */
  scrapeRead: () => Promise<string>;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable negative-cache TTL in ms (tests). */
  forbiddenTtlMs?: number;
}

/**
 * Try the OAuth API read first (when a token is attached and not negatively
 * cached), otherwise / on failure run the scrape read. Never throws — the
 * scrape read returns honest error/degraded text for its own failures.
 */
export async function readWithOAuthFallback(
  xToken: string,
  deps: ReadFallbackDeps,
): Promise<string> {
  const now = deps.now ?? (() => Date.now());
  if (xToken) {
    const key = tokenKey(xToken);
    const until = forbiddenUntil.get(key);
    if (until === undefined || until <= now()) {
      try {
        return await deps.apiRead(xToken);
      } catch (err) {
        const status = errorStatus(err);
        if (status === 401 || status === 402 || status === 403) {
          forbiddenUntil.set(key, now() + (deps.forbiddenTtlMs ?? FORBIDDEN_TTL_MS));
        }
        console.warn(
          `[x-mcp] X API read failed (status ${status ?? '?'}) — falling back to scrape: ` +
          `${(err as Error | undefined)?.message ?? String(err)}`,
        );
      }
    }
  }
  return deps.scrapeRead();
}

/**
 * Moonshot (Kimi) context-caching strategy for the coding loop — audit roadmap #4.
 *
 * RESEARCHED MECHANISM (primary sources, verified 2026-09-02):
 *   - Caching on api.moonshot.ai chat completions is AUTOMATIC server-side
 *     prefix caching — "Context Caching is automatically enabled for all model
 *     requests"; a request can hit the prefix cache only when the previous
 *     request's prompt exceeded 256 tokens. There are NO explicit cache
 *     objects, NO cache headers, NO `cache` message role anymore (the old
 *     explicit /v1/caching + X-Msh-Context-Cache API is gone — its doc page
 *     now 404s). Nothing to create, refresh, or TTL-manage client-side.
 *       https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api
 *   - ONE optional request param improves hit rates: `prompt_cache_key`
 *     (string, default null) — "used to cache responses for similar requests
 *     to optimize cache hit rates"; the docs recommend a session/task
 *     identifier for multi-turn conversations. It is a ROUTING HINT, not an
 *     isolation boundary: a prefix hit still requires the requester to have
 *     sent the exact same prompt-token prefix, so sharing a key can never
 *     leak content across runs/users — it can only raise or lower hit rates.
 *       https://platform.kimi.ai/docs/api/chat
 *   - Savings are observable via `usage.cached_tokens` (same usage object as
 *     prompt_tokens/completion_tokens); in streaming mode usage arrives on a
 *     final chunk before [DONE] when `stream_options: {include_usage: true}`
 *     is set (documented for kimi-k3 / kimi-k2.6 / k2.7-code).
 *       https://platform.kimi.ai/docs/api/chat
 *   - Pricing (kimi-k3): $3.00/M input on a cache miss, $0.30/M on a cache
 *     hit (90% off), $15.00/M output — so on the coding loop's re-shipped
 *     transcripts the cached share of the prompt costs a tenth.
 *       https://platform.kimi.ai/docs/pricing/chat-k3
 *   - Failure modes: a cache miss/expiry is fully transparent (billed as
 *     normal input, `cached_tokens` ≈ 0 — never an error). The only
 *     client-side risk is K3's strict param contract 400-ing on an added
 *     param; the caller handles that by retrying the exact legacy payload
 *     once and latching the cache params off for that model (below).
 *
 * This module owns the request-shape strategy: `applyMoonshotCache` returns
 * the cache-annotated payload (or null when the flag is off / the provider
 * isn't Moonshot / the model latched off), and the latch that records a
 * provider-side rejection so we never pay a second failed round-trip.
 *
 * Env flag: MOONSHOT_CONTEXT_CACHE — default ON ('0'/'false'/'off' disables).
 * Default-on rationale: both added params are documented in the CURRENT
 * primary API reference for kimi-k3, and every failure path falls back to a
 * request byte-identical to today's (same payload object) with a single warn.
 */

import { createHash } from 'crypto';
import type { ProviderConfig } from './coding-model';

/** Flag check (read per-call so tests/ops can flip it without a reload). */
export function moonshotCacheEnabled(): boolean {
  const v = String(process.env.MOONSHOT_CONTEXT_CACHE ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/** Only Moonshot-hosted models get cache params (registry endpoints never match). */
export function isMoonshotProvider(provider: Pick<ProviderConfig, 'url'>): boolean {
  return typeof provider.url === 'string' && provider.url.includes('api.moonshot.ai');
}

// ── Rejection latch ───────────────────────────────────────────────────────────
// If the provider ever rejects the cache-annotated payload shape, remember it
// per model for the process lifetime: the caller retries that turn uncached
// and every later turn skips the cache params entirely (no repeated failed
// round-trips, exactly one warn). Redeploy/restart re-probes once.
const rejectedModels = new Set<string>();

export function cacheParamsLatchedOff(model: string): boolean {
  return rejectedModels.has(model);
}

export function latchCacheParamsOff(model: string): void {
  rejectedModels.add(model);
}

/** Test hook — clears the process-wide rejection latch. */
export function resetMoonshotCacheLatchForTests(): void {
  rejectedModels.clear();
}

/**
 * Per-run cache identity for `prompt_cache_key`: a hash of the model + the
 * transcript's FIRST SYSTEM MESSAGE — the run's byte-stable prefix head (it
 * carries the run-start clock + task/workspace context, so parallel runs get
 * distinct keys). Two runs that DO share an identical system block sharing a
 * key is semantically correct for prefix caching (see module header). The key
 * deliberately survives compaction: compaction rewrites the prefix, and the
 * next request simply re-warms the cache under the same routing key.
 */
export function deriveCacheKey(model: string, messages: any[]): string {
  const head = (Array.isArray(messages) ? messages : []).find((m) => m?.role === 'system') ?? messages?.[0];
  const content = typeof head?.content === 'string' ? head.content : JSON.stringify(head?.content ?? '');
  return 'digby-coding-' + createHash('sha256').update(`${model}\n${content}`).digest('hex').slice(0, 32);
}

export interface MoonshotCacheApplication {
  /** The cache-annotated payload (a shallow copy — the base payload is untouched). */
  payload: any;
  /** Exactly which keys were added, for the fallback warn log. */
  addedKeys: string[];
}

/**
 * THE strategy function: given the fully-assembled legacy payload, return the
 * cache-annotated variant, or null when cache params must not be sent (flag
 * off, non-Moonshot provider, or the model latched off after a rejection).
 * Never mutates `basePayload` — the caller keeps it as the exact fallback.
 */
export function applyMoonshotCache(
  provider: Pick<ProviderConfig, 'url' | 'model'>,
  basePayload: any,
  messages: any[],
): MoonshotCacheApplication | null {
  if (!moonshotCacheEnabled()) return null;
  if (!isMoonshotProvider(provider)) return null;
  if (cacheParamsLatchedOff(provider.model)) return null;

  const payload = { ...basePayload };
  const addedKeys: string[] = ['prompt_cache_key'];
  payload.prompt_cache_key = deriveCacheKey(provider.model, messages);

  // K3 strips stream_options via omitParams (pre-cache caution: unverified on
  // K3's strict param contract). On the CACHE PATH we restore it — it is
  // documented for K3 and it's how usage.cached_tokens becomes observable in
  // streaming. If K3 rejects it, the same fallback+latch covers it. Models
  // that already send stream_options (kimi-k2.6) keep their base value.
  if (!('stream_options' in payload)) {
    payload.stream_options = { include_usage: true };
    addedKeys.push('stream_options');
  }
  return { payload, addedKeys };
}

/**
 * True for provider rejections plausibly CAUSED by the added cache params
 * (payload-shape 4xx). Deliberately excludes 401/403 (auth — the fallback
 * would fail identically), 429 (rate limit — the loop's transient backoff
 * must see it; an immediate uncached retry would burn rate budget and latch
 * the cache off spuriously), timeouts and network errors (not param-caused;
 * an in-place retry would double the stream window worst-case).
 */
export function isCacheParamRejection(err: any): boolean {
  const status = err?.response?.status;
  return status === 400 || status === 413 || status === 422;
}

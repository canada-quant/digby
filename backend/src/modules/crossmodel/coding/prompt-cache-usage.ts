/**
 * Prompt-cache hit tokens from a provider's `usage` block, for EVERY shape we
 * serve (audit 2026-10-08 W3-2 — SOTA quick win #1).
 *
 * Before this, coding-model.ts read only Moonshot's top-level
 * `usage.cached_tokens`, so every `cql-litellm:*` seat (all supervisors and
 * lanes), every DeepSeek seat and every Z.ai seat recorded ZERO cache
 * effectiveness — the top cost metric in published agent practice was
 * invisible for the seats that cost the most (the Fleet Supervisor alone:
 * 88.4M input tokens / $69.66 in 52 h).
 *
 * Shapes (first present wins; all are "prompt tokens served from cache", a
 * SUBSET of prompt_tokens — clamped to it):
 *   usage.cached_tokens                          Moonshot (Kimi) direct
 *   usage.prompt_cache_hit_tokens                DeepSeek direct (…_miss_tokens is the rest)
 *   usage.prompt_tokens_details.cached_tokens    OpenAI-compatible: LiteLLM, Z.ai (GLM), DashScope (Qwen), vLLM
 *   usage.input_tokens_details.cached_tokens     OpenAI Responses-style passthrough
 *   usage.cache_read_input_tokens                Anthropic-style passthrough (LiteLLM)
 *
 * Pure leaf. Kill switch PROMPT_CACHE_METRICS_DISABLED=1 restores the
 * Moonshot-only read (and drops the cache fields from the spend rows —
 * loop-metrics.service recordRunSpend reads the same switch).
 */

export function promptCacheMetricsDisabled(): boolean {
  const v = String(process.env.PROMPT_CACHE_METRICS_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

function nonNegative(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Which usage shape carried the cached count (telemetry / tests). */
export type PromptCacheShape = 'moonshot' | 'deepseek' | 'openai_details' | 'responses_details' | 'anthropic';

/**
 * Cached prompt tokens + the shape they came from, or undefined when the
 * provider reported none. Clamped to `usage.prompt_tokens` when that is known.
 */
export function readCachedPromptTokens(usage: any): { tokens: number; shape: PromptCacheShape } | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const clamp = (n: number) => {
    const prompt = nonNegative(usage.prompt_tokens);
    return prompt !== undefined ? Math.min(n, prompt) : n;
  };
  const moonshot = nonNegative(usage.cached_tokens);
  if (moonshot !== undefined) return { tokens: clamp(moonshot), shape: 'moonshot' };
  if (promptCacheMetricsDisabled()) return undefined;
  const deepseek = nonNegative(usage.prompt_cache_hit_tokens);
  if (deepseek !== undefined) return { tokens: clamp(deepseek), shape: 'deepseek' };
  const details = nonNegative(usage.prompt_tokens_details?.cached_tokens);
  if (details !== undefined) return { tokens: clamp(details), shape: 'openai_details' };
  const responses = nonNegative(usage.input_tokens_details?.cached_tokens);
  if (responses !== undefined) return { tokens: clamp(responses), shape: 'responses_details' };
  const anthropic = nonNegative(usage.cache_read_input_tokens);
  if (anthropic !== undefined) return { tokens: clamp(anthropic), shape: 'anthropic' };
  return undefined;
}

/** Just the count (the coding-model.ts usage seam). */
export function parseCachedPromptTokens(usage: any): number | undefined {
  return readCachedPromptTokens(usage)?.tokens;
}

/** Cache-hit ratio in [0, 1] rounded to 3 places, or undefined when nothing was read. */
export function cacheHitRatio(cachedTokens: number | undefined, promptTokens: number | undefined): number | undefined {
  const c = nonNegative(cachedTokens);
  const p = nonNegative(promptTokens);
  if (c === undefined || p === undefined || p <= 0) return undefined;
  return Math.round(Math.min(1, c / p) * 1000) / 1000;
}

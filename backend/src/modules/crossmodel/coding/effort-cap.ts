/**
 * Reasoning-effort CAP (2026-10-04, the lead-effort A/B — owner chose "A/B lower lead effort").
 *
 * The human-turn effort cut (chat-agent/human-turn-effort.ts, owner 2026-09-22: human turns at 'high' instead of
 * 'max') reaches only BUILT-IN glm / deepseek seats — a custom-endpoint lead ('label:model', e.g. the prod
 * `cql-litellm:api-optimize-zai-glm-5.3-flash`) is sent 'max' by its seat (2026-09-29 "max reasoning everywhere")
 * and the cut never applied: 7-day human first-token p50 152 s (L1) / 183 s (L2) on that seat. A CAP lowers an
 * effort the request ALREADY carries — it never adds the parameter, so an endpoint that does not take
 * `reasoning_effort` (its seat omits it) is untouched and can never 400 on it. Pure leaf.
 */
export type EffortCap = 'low' | 'medium' | 'high';

const RANK: Record<string, number> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

/** `extra` with `reasoning_effort` lowered to `cap` when it is ABOVE it; otherwise `extra` unchanged. Pure. */
export function capReasoningEffort<T extends Record<string, any> | undefined>(extra: T, cap: EffortCap | null | undefined): T {
  if (!cap || !extra || typeof extra !== 'object') return extra;
  const cur = (extra as Record<string, any>).reasoning_effort;
  if (typeof cur !== 'string' || !(cur in RANK)) return extra;
  return RANK[cur] > RANK[cap] ? ({ ...extra, reasoning_effort: cap } as T) : extra;
}

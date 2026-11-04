/**
 * Truncated-thinking recovery (2026-09-11 — owner: "we wanted the supervisor
 * on glm-5.3 max thinking; figure out what went wrong").
 *
 * On thinking models the reasoning stream counts against the per-turn output
 * cap. GLM-5.3 at reasoning_effort 'max' spent the whole 16k per-turn default
 * reasoning about a long supervisor note and returned finish_reason 'length'
 * with EMPTY content; the loop treated that as "the model answered nothing"
 * and the run ended with no final (23 of 124 supervisor wakes after the 09-10
 * seat swap). These helpers are pure so the decision and the reshaped provider
 * extras are unit-tested without the agent loop's module graph.
 *
 * Review 2026-09-13 issue 6: the cap key is PROVIDER-SPECIFIC. Kimi K3's
 * contract is `max_completion_tokens` and its ProviderConfig strips
 * `max_tokens` via omitParams, so the original recovery (which only raised
 * `max_tokens`) was a no-op on Kimi — 4 recoveries on 09-13 re-rolled the same
 * 16,384 budget (reasoning 67-71k chars each). The recovery now raises whichever
 * key the seat actually honours. Kimi K3's documented `max_completion_tokens`
 * range is default 131,072 / max 1,048,576 (platform.kimi.ai K3 quickstart,
 * checked 2026-09-13), so doubling to the 65,536 floor is well inside the cap.
 */

export interface TurnLike {
  content?: string | null;
  reasoning?: string | null;
  finishReason?: string | null;
  toolCalls?: unknown[];
}

/** An answer-less turn whose budget went to thinking: no tool calls, no prose,
 *  and either the provider said 'length' or it streamed reasoning only. */
export function isEmptyTruncatedTurn(turn: TurnLike): boolean {
  if ((turn.toolCalls?.length ?? 0) > 0) return false;
  if ((turn.content ?? '').trim()) return false;
  if (turn.finishReason === 'cancelled' || turn.finishReason === 'error') return false;
  return turn.finishReason === 'length' || (turn.reasoning ?? '').length > 0;
}

/** Recovery floor for the retried turn's output budget. */
export const TRUNCATION_RECOVERY_MIN_MAX_TOKENS = 65_536;

/** The per-turn output-cap keys a seat may honour. */
export type OutputCapKey = 'max_tokens' | 'max_completion_tokens';

/**
 * Review 2026-09-13 issue 6: which payload key bounds this seat's output.
 * `max_completion_tokens` when the seat already carries it OR strips
 * `max_tokens` via omitParams (Kimi K3 does both); `max_tokens` otherwise
 * (GLM-5.3, DeepSeek, Qwen, custom endpoints — the runModelTurn default).
 */
export function truncationCapKey(extra: Record<string, any> | undefined, omitParams?: readonly string[]): OutputCapKey {
  const prev = extra ?? {};
  if (prev.max_completion_tokens !== undefined) return 'max_completion_tokens';
  if (omitParams?.includes('max_tokens')) return 'max_completion_tokens';
  return 'max_tokens';
}

/**
 * Provider extras for the retry: at least double the output budget (floor
 * 65,536) on the cap key the seat honours and, when the seat runs at
 * reasoning_effort 'max', one notch less thinking ('high'). Every other extra
 * is preserved; the input is not mutated.
 *
 * Review 2026-09-13 issue 6: takes the provider's omitParams so a seat that
 * strips `max_tokens` gets `max_completion_tokens` raised instead of a key the
 * payload assembly deletes.
 */
export function recoveryExtras(extra: Record<string, any> | undefined, omitParams?: readonly string[]): Record<string, any> {
  const prev = extra ?? {};
  const capKey = truncationCapKey(prev, omitParams);
  // 16,384 is the runModelTurn `max_tokens` default — the budget the failed
  // turn actually ran with whenever the seat set no cap of its own.
  const prevMax = Number(prev[capKey]) || 16_384;
  return {
    ...prev,
    [capKey]: Math.max(prevMax * 2, TRUNCATION_RECOVERY_MIN_MAX_TOKENS),
    ...(prev.reasoning_effort === 'max' ? { reasoning_effort: 'high' } : {}),
  };
}

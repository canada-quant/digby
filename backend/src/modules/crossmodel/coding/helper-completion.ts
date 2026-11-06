/**
 * Shared NON-STREAMING completion for the fast seats — the Helper
 * (web_pipe / youtube_pipe digests) and the Utility override leg — plus the
 * admin role tester, so the Test button exercises the exact runtime shape.
 *
 * Why this exists (owner report 2026-09-08): the owner pointed the Helper seat
 * at a custom Qwen3-4B on a LiteLLM/vLLM gateway. The seat WAS honored, but a
 * Qwen3 thinks by default: with a 1400-token budget the model spent everything
 * reasoning and the pipes returned an EMPTY digest as a "successful" result —
 * either `content: ''` (vLLM reasoning parser on) or a leading `<think>` block
 * cut off mid-thought (parser off), which the old closed-tag-only strip passed
 * through verbatim. Nothing named the model, so it looked like the seat was
 * ignored. This module:
 *   1. sends the thinking-disable directive (THINKING_OFF_EXTRA) to every
 *      CUSTOM endpoint, retrying once without it on a 4xx and latching off per
 *      model in-process (same idiom as the embeddings `dimensions` retry);
 *   2. extracts the answer robustly — closed AND unclosed `<think>` blocks are
 *      never returned as prose;
 *   3. throws a diagnostic error when the answer is empty, naming the model and
 *      the fix, so callers fall to their honest fallback instead of shipping ''.
 */

import axios from 'axios';
import logger from '../../../utils/logger';
import {
  ProviderConfig, THINKING_OFF_EXTRA, DEEPSEEK_THINKING_OFF_EXTRA, DASHSCOPE_THINKING_OFF_EXTRA,
  isDeepSeekBuiltInProvider, isDashScopeQwenBuiltInProvider, fastSeatQwenThinkingOffDisabled,
  latchReasoningEffort, nextReasoningEffortAfterRejection, reasoningEffortLatch,
} from './coding-model';

export interface NonStreamingAnswer {
  /** Answer prose with any leading <think>…</think> removed; '' when the model
   *  produced only reasoning (or an UNCLOSED think block). Trimmed. */
  text: string;
  /** reasoning_content was present, or a <think> block led the content. */
  hadReasoning: boolean;
  finishReason: string | null;
}

/**
 * Pure: strip a LEADING <think> block from raw model content — closed AND
 * unclosed (an unclosed block means max_tokens ran out mid-thought: that text
 * is reasoning, never prose, so it strips to ''). Shared by
 * extractNonStreamingAnswer (non-streaming path) and the endpoint verifier's
 * full-stream parse probe — ONE regex pair, never duplicated.
 */
export function stripLeadingThink(raw: string): { text: string; hadThink: boolean } {
  const closed = /^\s*<think>[\s\S]*?<\/think>\s*/i.exec(raw);
  if (closed) return { text: raw.slice(closed[0].length), hadThink: true };
  if (/^\s*<think>/i.test(raw)) {
    // Unclosed: max_tokens ran out mid-thought — this is reasoning, never prose.
    return { text: '', hadThink: true };
  }
  return { text: raw, hadThink: false };
}

/** Pure: pull the answer out of one chat.completion choice (non-streaming). */
export function extractNonStreamingAnswer(choice: any): NonStreamingAnswer {
  const msg = choice?.message ?? {};
  const raw = String(msg.content ?? '');
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
  const stripped = stripLeadingThink(raw);
  const hadReasoning = (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) || stripped.hadThink;
  return { text: stripped.text.trim(), hadReasoning, finishReason };
}

export function isCustomEndpoint(p: ProviderConfig): boolean {
  return p.label.endsWith('(custom endpoint)');
}

/**
 * DeepSeek built-ins THINK BY DEFAULT (V4.1 Flash, 2026-09-10 — the 2026-09-04
 * vendor flip made V4 do the same) and the agent-seat provider extras carry
 * `thinking:{type:'enabled'}` + `reasoning_effort:'max'`. The fast seats served
 * here must not inherit that — a 512-1400 token budget burns entirely on
 * reasoning and the digest/title comes back EMPTY (the 2026-09-04 class) — so
 * the vendor's per-call switch is forced off here unless the caller keeps it
 * (reflection's advisory consult wants the reasoning). Verified live 2026-09-10:
 * `thinking:{type:'disabled'}` → zero reasoning tokens on deepseek-flash. The
 * constant + predicate live in coding-model.ts (shared with the streaming
 * helper-tier worker path via fastSeatProvider); re-exported here for callers.
 */
export { DEEPSEEK_THINKING_OFF_EXTRA };
export const isDeepSeekBuiltIn = isDeepSeekBuiltInProvider;

// Per-model latch: a server that 4xx's the thinking-off directive is asked once.
const thinkingOffRejected = new Set<string>();
export function __resetThinkingOffLatchForTests(): void { thinkingOffRejected.clear(); }

/**
 * POST a non-streaming chat completion. For CUSTOM endpoints whose payload
 * does not already carry the directive (admin "no-think" flag → provider.extra),
 * the thinking-off directive is tried first and dropped + latched on a 4xx.
 * DeepSeek built-ins get the vendor's own `thinking:{type:'disabled'}` (and
 * lose a spread-in `reasoning_effort`) unless `opts.keepThinking`. Other
 * built-ins are sent the payload untouched (their thinking handling is
 * per-provider and already explicit at each seam).
 */
export async function postNonStreamingCompletion(
  p: ProviderConfig,
  requested: Record<string, any>,
  opts: { timeout: number; keepThinking?: boolean },
): Promise<any> {
  let payload = requested;
  if (isDeepSeekBuiltIn(p) && !opts.keepThinking) {
    const { reasoning_effort: _reasoningEffort, ...rest } = requested;
    payload = { ...rest, ...DEEPSEEK_THINKING_OFF_EXTRA };
  }
  // 2026-11-06 (log-signal family 3769b1b3, lead of the utility-override class):
  // a DashScope Qwen3 BUILT-IN reasons by default in non-streaming mode, exactly
  // like the custom-endpoint Qwen3 of the 2026-09-08 report — and this seam only
  // ever applied a thinking-off shape to DeepSeek built-ins and CUSTOM endpoints,
  // so a DashScope built-in seat paid the full reasoning latency on EVERY call.
  // Measured live 2026-11-06 against dashscope-intl, same key, same prompt:
  //   enable_thinking:false → HTTP 200 in  2,729 ms (no reasoning tokens)
  //   (omitted)             → HTTP 200 in 30,782 ms (2,008 reasoning tokens)
  // Why it mattered: the Utility seat's OVERRIDE leg resolves the BUILT-IN
  // qwen3.6-27b (model-roles resolveRoleModel) and utilityChat admits a built-in
  // there (`!spec.includes(':')`), so every caller with a bounded budget
  // (10/12/15/30 s — the prod warn's own timeouts) blew its deadline, latched the
  // override off, and re-filed 'utility role override unreachable' — a REAL
  // recurrence, not the designed fallback it had been adjudicated as. Same
  // constant, same predicate and same kill switch as fastSeatProvider, so a
  // DashScope Qwen built-in behaves identically on the streamed and bounded paths.
  if (isDashScopeQwenBuiltInProvider(p) && !opts.keepThinking && !fastSeatQwenThinkingOffDisabled()) {
    payload = { ...payload, ...DASHSCOPE_THINKING_OFF_EXTRA };
  }
  // 2026-09-29: the agent seats' reasoning_effort 'max' (coding-model.ts
  // customEndpointEffortExtra) never rides a BOUNDED non-streaming seat
  // (Helper / Utility / capability seats) on a custom endpoint — those keep
  // their thinking-off shape, exactly as before and as their built-in twins.
  if (isCustomEndpoint(p) && !opts.keepThinking && 'reasoning_effort' in payload) {
    const { reasoning_effort: _boundedEffort, ...rest } = payload;
    payload = rest;
  }
  // Ticket 4c691bfe: a rung an earlier call LATCHED after a 400 applies from the
  // START of every later call, so the ladder pays the rejection once per
  // (endpoint, model) per process instead of once per call. Scoped to the
  // value the owner's wave sends ('max'): a caller that already picked a lower
  // effort keeps it, and nothing else about the payload changes.
  if (isCustomEndpoint(p) && payload.reasoning_effort === 'max') {
    const latched = reasoningEffortLatch(p);
    if (latched === 'omit') {
      payload = { ...payload };
      delete payload.reasoning_effort;
    } else if (latched) {
      // The latch type never holds 'max' — any latched rung is a step DOWN.
      payload = { ...payload, reasoning_effort: latched };
    }
  }
  const headers = { ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}), 'Content-Type': 'application/json' };
  const latchKey = `${p.url}::${p.model}`;
  const tryOff = isCustomEndpoint(p) && !('chat_template_kwargs' in payload) && !thinkingOffRejected.has(latchKey);
  if (tryOff) {
    try {
      return await postWithEffortLadder(p, { ...payload, ...THINKING_OFF_EXTRA }, headers, opts.timeout);
    } catch (err: any) {
      const status = err?.response?.status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        thinkingOffRejected.add(latchKey);
        logger.warn(`helper-completion: ${p.model} (${p.label}) rejected the thinking-off directive (HTTP ${status}) — retrying without it; latched off for this model`);
      } else {
        throw err;
      }
    }
  }
  return postWithEffortLadder(p, payload, headers, opts.timeout);
}

/**
 * ── Reasoning-effort ladder for BOUNDED non-streaming seats (ticket
 * 4c691bfe, 2026-10-29) ────────────────────────────────────────────────────
 * A custom endpoint's provider extras carry `reasoning_effort:'max'`
 * (coding-model.ts `customEndpointEffortExtra` — the owner's 2026-09-29 "max
 * reasoning everywhere" wave). The STREAMED path has always had a ladder for
 * it: runModelTurn catches the 400 and calls
 * `nextReasoningEffortAfterRejection`, stepping down one rung and LATCHING it
 * per (endpoint, model) so no later turn re-pays the rejection.
 *
 * The non-streaming seat path had NO ladder. `postNonStreamingCompletion` only
 * dropped `reasoning_effort` for the bounded seats (Helper / Utility /
 * capability), and `seatCompletion` re-adds a provider extra verbatim — so the
 * Image reader (`vision_describe`, keepThinking:true), the frontier council and
 * reflection sent `'max'` to `tt-qwen3.8-flash-next` on EVERY call, forever:
 *   "reasoning_effort must be one of ('minimal','low','medium','high','xhigh'),
 *    got 'max'"
 * 170 rows / 24 h across 8 hours (log-signal 4c691bfe) with each swallows-call
 * failing identically — the standing-failure class the sweep flags.
 *
 * This is the SAME pure classifier the streamed path uses (one implementation,
 * never a copy) plus the same latch, so a seat proves its accepted level once
 * and every later call sends it (the latch is set when the provider has NAMED a
 * remedy — the same posture as the streamed path; if every attempt is then
 * rejected the error still propagates). Kill switch: none needed — the ladder is
 * bounded (≤2 retries) and only ever LOWERS the effort the provider refused;
 * it can never send a value the provider did not name or a higher rung.
 */
async function postWithEffortLadder(
  p: ProviderConfig,
  payload: Record<string, any>,
  headers: Record<string, string>,
  timeout: number,
): Promise<any> {
  let body = payload;
  let fixes = 0;
  for (;;) {
    try {
      return await axios.post(p.url, body, { headers, timeout });
    } catch (err: any) {
      if (err?.response?.status !== 400 || fixes >= 2) throw err;
      const detail = providerErrorDetail(err);
      if (!detail) throw err;
      const sent = body.reasoning_effort as string | undefined;
      const next = nextReasoningEffortAfterRejection(sent, detail);
      if (!next) throw err;
      // `'omit'` means "drop the key entirely" on this seam.
      const nextValue = next === 'omit' ? undefined : next;
      if ((nextValue ?? null) === (sent ?? null)) throw err;
      // Latch so later calls on this (endpoint, model) start at the level the
      // provider ACCEPTED instead of re-paying the 400 every turn.
      latchReasoningEffort(p, next);
      fixes += 1;
      const retry = { ...body };
      if (nextValue === undefined) delete retry.reasoning_effort; else retry.reasoning_effort = nextValue;
      logger.warn(
        `helper-completion: ${p.model} (${p.label}) rejected reasoning_effort=${sent ?? '(proxy-injected)'} (HTTP 400) — retrying once with ${nextValue === undefined ? 'no reasoning_effort' : `reasoning_effort:'${nextValue}'`} and latching it for this model.`,
        { source: 'helper-completion' },
      );
      body = retry;
    }
  }
}

/** The provider's own message from a rejected non-streaming call, bounded. */
function providerErrorDetail(err: any, cap = 600): string {
  const body = err?.response?.data;
  const msg = body?.error?.message ?? body?.message ?? body?.detail
    ?? (typeof body === 'string' ? body : undefined)
    ?? err?.message ?? '';
  return String(msg).replace(/\s+/g, ' ').trim().slice(0, cap);
}

/** Thrown when the model returned no answer prose — callers fall to their
 *  honest fallback and the message names the model AND the fix. */
export class HelperEmptyAnswerError extends Error {
  constructor(public readonly provider: ProviderConfig, public readonly answer: NonStreamingAnswer) {
    super(
      answer.hadReasoning
        ? `${provider.model} (${provider.label}) returned no answer text — it spent the budget thinking (finish_reason=${answer.finishReason ?? 'n/a'}). Flag the model "no-think" in the endpoint dialog (Account → Admin → Endpoints) or pick a non-thinking model for this seat.`
        : `${provider.model} (${provider.label}) returned no answer text (finish_reason=${answer.finishReason ?? 'n/a'}).`,
    );
  }
}

/**
 * ONE non-streaming completion with the seat's payload contract (provider
 * extras first so the caller's params win; omitParams stripped). Returns the
 * extracted answer or throws HelperEmptyAnswerError when it is empty.
 */
export async function runHelperCompletion(
  p: ProviderConfig,
  messages: Array<{ role: string; content: string }>,
  opts: { maxTokens: number; temperature?: number; timeoutMs: number },
): Promise<NonStreamingAnswer> {
  const payload: Record<string, any> = {
    ...p.extra,
    model: p.model,
    messages,
    max_tokens: opts.maxTokens,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  };
  for (const k of p.omitParams ?? []) delete payload[k];
  const r = await postNonStreamingCompletion(p, payload, { timeout: opts.timeoutMs });
  const answer = extractNonStreamingAnswer(r.data?.choices?.[0]);
  if (!answer.text) throw new HelperEmptyAnswerError(p, answer);
  return answer;
}

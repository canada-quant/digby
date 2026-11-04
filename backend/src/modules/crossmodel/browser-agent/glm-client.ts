/**
 * Chat client for the browser agent — runs on the BROWSER AGENT seat (model
 * role `browser_agent`; built-in default glm-5.3 on Z.AI, reasoning_effort
 * "high"). The file keeps its historical name (glm-client) because every test
 * and the loop import `glmChat` / `glmConfigured` / `stripThink` from here.
 *
 * 2026-09-22 (owner: every model call admin-editable): the model is no longer
 * a constant — Account → Admin → Endpoints → Model roles → "Browser agent"
 * moves it between built-ins and registered custom endpoints. The call goes
 * through seat-call.ts (non-streaming, OpenAI function tools, provider payload
 * contract), so any OpenAI-compatible endpoint works.
 *
 * Reasoning: the seat asks for effort "high", NOT "max" — an OWNER-FLAGGED
 * EXCEPTION to the 2026-09-03 "GLM at max" directive, because the browser
 * sub-session is hard-bounded (maxSteps 6, 120s deadline) and max-effort
 * reasoning cannot fit those bounds. A DeepSeek built-in on this seat runs
 * with thinking OFF for the same reason (speed per bounded step). A leading
 * <think>…</think> block inside content (the GLM-5.2 shape) is stripped
 * both in seat-call and by stripThink() here.
 */

import { retryOnModelNotFound } from '../langgraph/pipeline-utils';
import { providerKeyMissing, resolveSeat, seatCompletion, seatUnservableReasonFor } from '../seat-call';

export const BROWSER_AGENT_ROLE = 'browser_agent';
/** The seat's BUILT-IN default (GLM-5.2 → 5.3 cutover, owner 2026-09-03). */
export const BROWSER_AGENT_DEFAULT_MODEL = 'glm-5.3';

export interface GlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export interface GlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface GlmChoiceMessage {
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: GlmToolCall[];
  /** The model id that actually answered (for honest labels). */
  model?: string;
}

/** Strip a leading <think>…</think> reasoning block a model emits inside content (5.2 shape; tolerated everywhere). */
export function stripThink(s: string | null | undefined): string {
  const text = s || '';
  const m = text.match(/^\s*<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/);
  if (m) return m[2].trim();
  // feedback fcc28eba: an UNTERMINATED leading <think> block (the provider cut
  // the completion mid-reasoning, e.g. max_tokens) is ALL reasoning with no
  // answer at all. Returning it verbatim surfaced the model's chain-of-thought —
  // its narration of the tool calls it planned first — as the browser agent's
  // "final report". Treat reasoning-only payloads as empty so the caller falls
  // through to the wrap-up path instead.
  if (/^\s*<think>/.test(text)) return '';
  return text;
}

/** True when the Browser agent seat can be served on this instance (its
 *  model has a key, or is a custom endpoint). Fail-open on resolver trouble. */
export async function glmConfigured(): Promise<boolean> {
  try {
    return (await seatUnservableReasonFor(BROWSER_AGENT_ROLE, BROWSER_AGENT_DEFAULT_MODEL)) === null;
  } catch {
    return true;
  }
}

/** The model id the Browser agent seat runs right now (labels / logs). */
export async function browserAgentModel(): Promise<string> {
  try {
    return (await resolveSeat(BROWSER_AGENT_ROLE, BROWSER_AGENT_DEFAULT_MODEL)).provider.model;
  } catch {
    return BROWSER_AGENT_DEFAULT_MODEL;
  }
}

export interface GlmChatOpts {
  messages: GlmMessage[];
  tools?: any[];
  toolChoice?: 'auto' | 'none';
  /**
   * OWNER-FLAGGED EXCEPTION to the 2026-09-03 "GLM at max" directive: the
   * browser sub-session is hard-bounded (maxSteps 6, 120s deadline — see
   * runBrowserAgentSession), and 'max'-effort reasoning cannot fit those
   * bounds — so the browser agent stays at 'high'. Applied only when the
   * seat's provider contract has a reasoning_effort knob.
   */
  reasoningEffort?: 'high' | 'max';
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
}

/**
 * One non-streaming turn on the Browser agent seat. Returns the assistant
 * message (content + tool_calls in the OpenAI shape the loop replays). Wrapped
 * with retryOnModelNotFound to ride out a provider's "model not found"
 * maintenance blips (Z.AI's ~6am UTC window).
 */
export async function glmChat(opts: GlmChatOpts): Promise<GlmChoiceMessage> {
  const seat = await resolveSeat(BROWSER_AGENT_ROLE, BROWSER_AGENT_DEFAULT_MODEL);
  const keyless = providerKeyMissing(seat.provider);
  if (keyless) throw new Error(`Browser agent seat unavailable: ${keyless}. Assign a model under Account → Admin → Endpoints → Model roles → Browser agent, or set the provider key.`);

  const result = await retryOnModelNotFound(
    () => seatCompletion(seat.provider, opts.messages, {
      maxTokens: opts.maxTokens ?? 16384,
      // Kimi rejects temperature (fixed server-side) — the seat gate already
      // keeps must-stream Kimi off this seat; every other provider takes it.
      temperature: opts.temperature ?? 0.7,
      timeoutMs: opts.timeout ?? 150000,
      tools: opts.tools,
      toolChoice: opts.toolChoice ?? 'auto',
      reasoningEffort: opts.reasoningEffort ?? 'high',
    }),
    `${seat.provider.model} browser-agent turn`,
  );

  return {
    content: result.text || null,
    reasoning_content: result.reasoning || null,
    tool_calls: result.toolCalls.length
      ? result.toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments } }))
      : undefined,
    model: seat.provider.model,
  };
}

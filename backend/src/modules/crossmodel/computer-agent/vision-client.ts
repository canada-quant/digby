/**
 * Vision client for the computer-use loop — runs on the COMPUTER-USE VISION
 * seat (model role `computer_vision`; built-in default deepseek-flash: native
 * image input + function calling on one OpenAI-compatible request).
 *
 * 2026-09-22 (owner: no frontier models anywhere; every model call
 * admin-editable): replaces the hardcoded gpt-5.6-luna Responses-API client.
 * The LOOP keeps speaking the Responses-style item vocabulary it always used
 * (`input_text` / `input_image` user items, `function_call` +
 * `function_call_output` echoes) — this module translates that into
 * chat.completions messages (user parts with image_url, assistant tool_calls,
 * tool results) and back, so computer-loop.ts and its tests are untouched.
 *
 * Kept dependency-free of the chat pipeline (same as browser-agent/glm-client).
 */

import logger from '../../../utils/logger';
import {
  describeSeatError,
  imageUrlPart,
  providerKeyMissing,
  seatCompletion,
  seatProviderChain,
  seatUnservableReasonFor,
  warnSeatFailure,
} from '../seat-call';

export const COMPUTER_VISION_ROLE = 'computer_vision';
export const COMPUTER_VISION_DEFAULT_MODEL = 'deepseek-flash';

/**
 * Ticket c4fa5417 (2026-10-29) — the vision hop had NO provider chain and NO
 * per-attempt bound: `visionChat` resolved the seat's ONE provider and called
 * it with a 90 s timeout, so a hung seat ended the whole computer-use session.
 *
 * The live incident: the `computer_vision` seat served a custom endpoint that
 * stopped producing a first token (probed 2026-10-29T04:1xZ — no token in
 * 55 s, while the seat's own built-in `deepseek-flash` answered the identical
 * call shape in 683 ms and `glm-5.3-flash` in 2.6 s). Every camera-only
 * read-only probe on a HEALTHY paired Mac (frame 1568×882, refusedRepeats 0,
 * noChangeStrikes 0, degenerateFrames 0) died at step 1 with
 * "the vision model call failed (timeout of 90000ms exceeded)" — 4× across
 * two supervisor sweeps — because one dead provider was the entire chain.
 *
 * Fix shape (mirrors image-describe.ts, the sibling vision hop that has always
 * walked a chain): try the seat's model, then its custom fallback, then the
 * built-in default; bound EACH attempt; and DEMOTE (never drop) a provider that
 * timed out to the back of later steps' chains, so a healthy provider is not
 * made to wait behind a hung one on every one of the loop's steps.
 */

/** One provider attempt. Healthy seats answer a screenshot+function-tools call
 *  in well under 5 s (live probes above); 45 s keeps a wide margin for a cold
 *  self-hosted node while refusing to let ONE hung provider eat the hop. */
export const COMPUTER_VISION_ATTEMPT_TIMEOUT_MS = 45_000;

/** The whole hop, ALL attempts included — the same envelope the single call had
 *  before this ticket, so walking a chain can never cost MORE wall clock than
 *  the call it replaced. */
export const COMPUTER_VISION_BUDGET_MS = 90_000;

/** Below this, another attempt is not worth starting. */
const MIN_ATTEMPT_MS = 5_000;

/** How long a provider that TIMED OUT is DEMOTED to the back of later steps'
 *  chains (never dropped — an instance with one seat model must keep working).
 *  A seat that hung once usually hangs again; ordering it last means a healthy
 *  provider answers first instead of every step paying the timeout again. */
export const COMPUTER_VISION_TIMEOUT_LATCH_MS = 10 * 60_000;

const timedOutUntil = new Map<string, number>();
/** Test-only: clear the timeout latch between cases. */
export function __resetComputerVisionTimeoutLatchForTests(): void {
  timedOutUntil.clear();
}

function providerLatchKey(p: { url: string; model: string }): string {
  return `${p.url}::${p.model}`;
}

/**
 * Did this attempt die because the provider never answered? axios reports its
 * own client timeout as ECONNABORTED ("timeout of 90000ms exceeded" — the
 * exact string in ticket c4fa5417); a socket-level stall can surface as
 * ETIMEDOUT. Anything else (a 400/500, a DNS failure) is a DIFFERENT failure
 * and must not latch the provider off.
 */
export function isVisionTimeout(err: any): boolean {
  const code = String(err?.code ?? '');
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ERR_CANCELED') return true;
  const msg = String(err?.message ?? '');
  return /timeout of \d+\s*ms exceeded/i.test(msg) || /\btimed out\b/i.test(msg);
}

export interface VisionFunctionCall {
  callId: string;
  name: string;
  /** Raw JSON arguments string from the model. */
  arguments: string;
}

export interface VisionChatResult {
  functionCalls: VisionFunctionCall[];
  /** Concatenated answer text (final answer). */
  text: string;
  /** The model id that answered (honest attribution). */
  model?: string;
}

/** A single item in the loop's `input` array (Responses-style vocabulary). */
export type VisionInputItem =
  | {
      role: 'user';
      content: Array<
        | { type: 'input_text'; text: string }
        | { type: 'input_image'; image_url: string }
      >;
    }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface VisionToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** True when the Computer-use vision seat can be served on this instance. */
export async function visionConfigured(): Promise<boolean> {
  try {
    return (await seatUnservableReasonFor(COMPUTER_VISION_ROLE, COMPUTER_VISION_DEFAULT_MODEL)) === null;
  } catch {
    return true;
  }
}

/** Why the seat cannot run here (null = fine) — for honest capability notices. */
export async function visionUnavailableReason(): Promise<string | null> {
  try {
    return await seatUnservableReasonFor(COMPUTER_VISION_ROLE, COMPUTER_VISION_DEFAULT_MODEL);
  } catch {
    return null;
  }
}

/** Split a `data:<mime>;base64,<data>` URL into its parts (already-inline images pass through). */
function dataUrlToPart(url: string): { type: 'image_url'; image_url: { url: string } } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? imageUrlPart(m[1], m[2]) : { type: 'image_url', image_url: { url } };
}

/**
 * Responses-style items → chat.completions messages. Consecutive function_call
 * items become ONE assistant message with several tool_calls (the shape every
 * OpenAI-compatible provider expects before the matching tool results).
 */
export function toChatMessages(instructions: string, input: VisionInputItem[]): any[] {
  const messages: any[] = [{ role: 'system', content: instructions }];
  for (const item of input) {
    if ('role' in item) {
      const parts = item.content.map(c =>
        c.type === 'input_text' ? { type: 'text', text: c.text } : dataUrlToPart(c.image_url),
      );
      const onlyText = parts.every(p => p.type === 'text');
      messages.push({ role: 'user', content: onlyText ? parts.map((p: any) => p.text).join('\n\n') : parts });
      continue;
    }
    if (item.type === 'function_call') {
      const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } };
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant' && Array.isArray(last.tool_calls) && !last._closed) last.tool_calls.push(call);
      else messages.push({ role: 'assistant', content: '', tool_calls: [call] });
      continue;
    }
    if (item.type === 'function_call_output') {
      // Mark the preceding assistant turn closed: a later function_call starts a new one.
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') last._closed = true;
      const priorTool = messages[messages.length - 1];
      if (priorTool?.role === 'tool') { /* several results in a row are fine */ }
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
    }
  }
  // Drop the private bookkeeping flag before the wire.
  for (const m of messages) delete m._closed;
  return messages;
}

/** Responses-style flattened tool defs → OpenAI function tools. */
export function toChatTools(tools: VisionToolDef[] | undefined): any[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/**
 * One vision step, served off the seat's CHAIN (ticket c4fa5417).
 *
 * `opts.timeout` is the TOTAL hop budget (default 90 s — the same envelope the
 * single unbounded call had), split into per-attempt bounds so ONE hung
 * provider can never consume it: a provider that times out is latched and the
 * next one in the chain serves the same step.
 */
export async function visionChat(opts: {
  instructions: string;
  input: VisionInputItem[];
  tools?: VisionToolDef[];
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
  timeout?: number;
}): Promise<VisionChatResult> {
  const budgetMs = opts.timeout ?? COMPUTER_VISION_BUDGET_MS;
  const chain = await seatProviderChain(COMPUTER_VISION_ROLE, COMPUTER_VISION_DEFAULT_MODEL, { requiresVision: true });
  if (!chain.length) {
    throw new Error(`Computer-use vision seat unavailable. Assign a vision model under Account → Admin → Endpoints → Model roles → Computer-use vision, or set the provider key.`);
  }
  // A provider that already timed out this process goes LAST — still reachable
  // (never silently dropped: an instance with one seat model must keep working),
  // but behind every provider that has not hung.
  const now = Date.now();
  const fresh = chain.filter(p => (timedOutUntil.get(providerLatchKey(p)) ?? 0) <= now);
  const staler = chain.filter(p => (timedOutUntil.get(providerLatchKey(p)) ?? 0) > now);
  const ordered = [...fresh, ...staler];

  const messages = toChatMessages(opts.instructions, opts.input);
  const tools = toChatTools(opts.tools);
  const errors: string[] = [];
  const deadline = Date.now() + budgetMs;

  for (const provider of ordered) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      errors.push(`no time left in the ${Math.round(budgetMs / 1000)}s vision budget for ${provider.model}`);
      break;
    }
    const keyless = providerKeyMissing(provider);
    if (keyless) { errors.push(`${provider.model}: ${keyless}`); continue; }
    const attemptTimeout = Math.min(COMPUTER_VISION_ATTEMPT_TIMEOUT_MS, remaining);
    try {
      const result = await seatCompletion(provider, messages, {
        maxTokens: opts.maxTokens ?? 4096,
        timeoutMs: attemptTimeout,
        tools,
        toolChoice: opts.tools?.length ? 'auto' : undefined,
        reasoningEffort: opts.reasoningEffort === 'high' || opts.reasoningEffort === 'medium' ? 'high' : 'low',
      });
      // It answered — it is not a hung provider any more.
      timedOutUntil.delete(providerLatchKey(provider));
      return {
        functionCalls: result.toolCalls.map(tc => ({ callId: tc.id, name: tc.name, arguments: tc.arguments || '{}' })),
        text: result.text,
        model: provider.model,
      };
    } catch (err: any) {
      warnSeatFailure(COMPUTER_VISION_ROLE, provider, err);
      errors.push(`${provider.model} (${provider.label}): ${describeSeatError(err)}`);
      if (isVisionTimeout(err)) {
        timedOutUntil.set(providerLatchKey(provider), Date.now() + COMPUTER_VISION_TIMEOUT_LATCH_MS);
        logger.warn(
          `computer vision: ${provider.model} (${provider.label}) did not answer within ${Math.round(attemptTimeout / 1000)}s — serving the next provider in the seat chain and demoting it behind them for ${Math.round(COMPUTER_VISION_TIMEOUT_LATCH_MS / 60000)} min (ticket c4fa5417).`,
          { source: 'computer-vision' },
        );
      }
    }
  }
  throw new Error(`no provider in the computer-use vision seat chain answered — ${errors.join('; ')}`);
}

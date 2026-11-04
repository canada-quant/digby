/**
 * Seat runtime — the ONE way to call a model that a named SEAT resolves to,
 * NON-STREAMING, with optional inline images and function tools.
 *
 * 2026-09-22 (owner: "the user can fully configure and edit ALL models for the
 * entire app"): every model call that used to be a hardcoded vendor constant —
 * the image describer, PDF OCR, the browser agent, computer-use vision, Digby
 * Kids, the profile interview — now resolves its model through the admin's
 * model roles (model-roles.service.ts) and calls it through this module, so a
 * seat can be moved between built-ins and registered custom endpoints without
 * a code change, exactly like the chat / coding seats.
 *
 * Contract:
 *   - resolveSeat(role, builtInDefault) → the seat's ProviderConfig (override
 *     or built-in; fail-open to the built-in default like every other seam).
 *   - seatCompletion(provider, messages, opts) → one chat.completions call in
 *     the provider's payload contract: provider extras first, the CALLER's
 *     output budget wins (a provider's agent-seat max_tokens "thinking room"
 *     must not override a 4k description budget), omitParams stripped, Kimi's
 *     max_completion_tokens honored, DeepSeek built-ins thinking-OFF unless
 *     the caller keeps it (bounded per-step seats want speed), custom
 *     endpoints get the no-think directive try-then-latch, and a leading
 *     <think> block is stripped from the answer (helper-completion.ts).
 *   - Tool calls come back in the OpenAI function shape the callers already
 *     speak (browser-agent/glm-loop.ts, computer-agent/computer-loop.ts).
 */

import logger from '../../utils/logger';
import {
  ProviderConfig,
  resolveProviderForRun,
  resolveRoleModelForRun,
  resolveRoleFallbackForRun,
  seatServability,
} from './coding/coding-model';
import { postNonStreamingCompletion, stripLeadingThink, isCustomEndpoint } from './coding/helper-completion';

export interface ResolvedSeat {
  role: string;
  /** The spec the seat resolved to — a built-in id or '<label>:<modelId>'. */
  spec: string;
  provider: ProviderConfig;
  isCustom: boolean;
}

/** True when a provider accepts image_url content parts. Built-ins carry the
 *  flag on their provider entry (glm-5.3 is deliberately TEXT-ONLY — vision is
 *  glm-5.3-flash, coding-model.ts); custom endpoints carry the registry
 *  entry's boolean (supportsVision = entry.vision === true, resolved in
 *  model-endpoints.service — only an admin-flagged [vision] model passes, and
 *  the seat save-guard refuses unflagged customs on image-bearing seats). */
export function providerAcceptsImages(p: ProviderConfig): boolean {
  return p.supportsVision === true;
}

/** Ticket 06d2886a (2026-10-12): a vision seat whose stored override no longer
 *  resolves (endpoint deleted/disabled — e.g. the CQL-Public breach retirements)
 *  used to fail open through normalizeCodingModel's UNKNOWN-id default to
 *  glm-5.3 — a TEXT-ONLY model — so the first image_url part earned a provider
 *  400 and every computer_task dispatch died at step 1. The admin save-guard
 *  (model-roles.service assertAssignable VISION_ROLES check) refuses exactly
 *  this assignment; the RUNTIME path must refuse it too: when a seat that
 *  sends images resolves to a KNOWN text-only provider, skip it (warn, the
 *  dead spec named) and fall back to the admin's custom fallback, then the
 *  seat's built-in vision default. NEVER falls back when the resolved provider
 *  is the seat's own configured built-in (that is the admin's explicit choice,
 *  already refused at save time if wrong) — only the accidental
 *  unresolvable-spec → unknown-default path is intercepted. */
export async function resolveVisionSeat(
  role: string,
  builtInDefault: string,
  opts?: { userId?: string },
): Promise<ResolvedSeat> {
  const seat = await resolveSeat(role, builtInDefault, opts);
  if (providerAcceptsImages(seat.provider) || seat.spec === builtInDefault) return seat;
  // The resolved provider is (or fails open to) a known text-only model while
  // the seat's own spec is something else — try the admin's custom fallback,
  // then the built-in default, both through the same vision check.
  const candidates: Array<{ spec: string; via: string }> = [];
  const fbSpec = await resolveRoleFallbackForRun(role);
  if (fbSpec && fbSpec !== seat.spec) candidates.push({ spec: fbSpec, via: 'the seat\'s custom fallback' });
  if (seat.spec !== builtInDefault) candidates.push({ spec: builtInDefault, via: 'the seat\'s built-in default' });
  for (const c of candidates) {
    let provider: ProviderConfig;
    try {
      provider = await resolveProviderForRun(c.spec, opts?.userId);
    } catch {
      continue;
    }
    if (!providerAcceptsImages(provider)) continue;
    logger.warn(
      `seat-call: ${role} seat spec "${seat.spec}" resolved to ${seat.provider.model} (${seat.provider.label}), which does not accept inline images — serving ${provider.model} via ${c.via} instead. Fix the seat under Account → Admin → Endpoints → Model roles → ${role} (the stored spec no longer resolves).`,
      { source: 'seat-call' },
    );
    return { role, spec: c.spec, provider, isCustom: isCustomEndpoint(provider) };
  }
  // Nothing vision-capable behind the seat: return the ORIGINAL resolution —
  // the callers' text-only refusal (seatCompletion's guard below) gives the
  // admin an actionable message instead of a provider 400.
  return seat;
}

/** The seat's provider: admin override, else `builtInDefault` (fail-open). */
export async function resolveSeat(role: string, builtInDefault: string, opts?: { userId?: string; fastSeat?: boolean }): Promise<ResolvedSeat> {
  const spec = await resolveRoleModelForRun(role, builtInDefault);
  const provider = await resolveProviderForRun(spec, opts?.userId, opts?.fastSeat ? { fastSeat: true } : undefined);
  return { role, spec, provider, isCustom: isCustomEndpoint(provider) };
}

/**
 * Why the seat cannot be served on this instance (a keyless built-in), or null
 * when it can. Same honesty rule as the chat lane's seat pre-flight.
 */
export async function seatUnservableReasonFor(role: string, builtInDefault: string, userId?: string): Promise<string | null> {
  const spec = await resolveRoleModelForRun(role, builtInDefault);
  return (await seatServability(spec, userId)).reason;
}

/**
 * The providers to try for a seat, in order: the seat's own model, the admin's
 * custom fallback (when set and different), then the built-in default (when the
 * seat runs something else) — deduplicated by url+model. Callers walk the list
 * and stop at the first usable answer.
 *
 * Ticket 06d2886a: `requiresVision: true` (image-bearing seats — the Image
 * reader, the PDF reader) SKIPS providers that are KNOWN text-only, with the
 * same warn resolveVisionSeat emits, so a dead stored override cannot put a
 * text-only model at the head of the chain. The seat's own configured built-in
 * is never skipped (the admin's explicit choice, refused at save time when
 * wrong) — only the accidental unresolvable-spec → unknown-default path.
 */
export async function seatProviderChain(role: string, builtInDefault: string, opts?: { userId?: string; requiresVision?: boolean }): Promise<ProviderConfig[]> {
  const seat = await resolveSeat(role, builtInDefault, opts);
  const chain: ProviderConfig[] = [];
  const skipIfTextOnly = (p: ProviderConfig, via: string): boolean => {
    if (!opts?.requiresVision || providerAcceptsImages(p) || seat.spec === builtInDefault) return false;
    logger.warn(
      `seat-call: ${role} seat spec "${seat.spec}" resolved to ${p.model} (${p.label}), which does not accept inline images — serving the ${via} instead. Fix the seat under Account → Admin → Endpoints → Model roles → ${role} (the stored spec no longer resolves).`,
      { source: 'seat-call' },
    );
    return true;
  };
  if (!skipIfTextOnly(seat.provider, 'next vision-capable provider in the seat chain')) chain.push(seat.provider);
  const fb = await resolveRoleFallbackForRun(role);
  if (fb && fb !== seat.spec) {
    try {
      const p = await resolveProviderForRun(fb, opts?.userId);
      if (!skipIfTextOnly(p, 'seat custom fallback')) chain.push(p);
    } catch { /* unresolvable fallback — skipped */ }
  }
  if (seat.spec !== builtInDefault) {
    try {
      const p = await resolveProviderForRun(builtInDefault, opts?.userId);
      if (!skipIfTextOnly(p, `built-in default (${builtInDefault})`)) chain.push(p);
    } catch { /* built-in always resolves */ }
  }
  const seen = new Set<string>();
  return chain.filter(p => {
    const k = `${p.url}::${p.model}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A provider that cannot be called at all on this instance (keyless built-in). */
export function providerKeyMissing(p: ProviderConfig): string | null {
  if (p.apiKey || isCustomEndpoint(p)) return null;
  return p.envKey
    ? `${p.model} needs the ${p.envKey} environment variable (${p.label}), which is not set on this instance`
    : `${p.model} needs a ${p.label} API key that is not set on this instance`;
}

export interface SeatToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string from the model. */
  arguments: string;
}

export interface SeatCompletionResult {
  /** Answer prose (leading <think> stripped, trimmed) — '' when the model only reasoned or only called tools. */
  text: string;
  /** reasoning_content when the provider returns it separately. */
  reasoning: string;
  toolCalls: SeatToolCall[];
  finishReason: string | null;
  hadReasoning: boolean;
}

export interface SeatCompletionOpts {
  maxTokens: number;
  temperature?: number;
  timeoutMs: number;
  /** OpenAI function tools ({type:'function', function:{name, description, parameters}}). */
  tools?: any[];
  toolChoice?: 'auto' | 'none';
  /** Keep a DeepSeek built-in's thinking on (default OFF on these bounded seats — speed). */
  keepThinking?: boolean;
  /** Override the provider's reasoning_effort when its contract has one (GLM low|high|max, DeepSeek). */
  reasoningEffort?: 'low' | 'high' | 'max';
}

/** `{type:'image_url', image_url:{url:'data:…'}}` for an inline image. */
export function imageUrlPart(mimeType: string, base64: string): { type: 'image_url'; image_url: { url: string } } {
  return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } };
}

/** One non-streaming chat completion in the provider's payload contract. */
export async function seatCompletion(provider: ProviderConfig, messages: any[], opts: SeatCompletionOpts): Promise<SeatCompletionResult> {
  // Ticket 06d2886a: never PUT image parts on the wire to a provider that is
  // KNOWN text-only — the provider's 400 is unactionable ("Request failed with
  // status code 400"); this names the seat, the model and the fix. Callers
  // whose seat resolved vision-capable (or unknown) are untouched.
  if (provider.supportsVision !== true && messages.some(m => Array.isArray(m.content) && m.content.some((p: any) => p?.type === 'image_url'))) {
    throw new Error(
      `${provider.model} (${provider.label}) cannot serve this call: it does not accept inline images, but the request carries image_url parts. Assign a vision model to the seat under Account → Admin → Endpoints → Model roles (this seat sends images inline) — the same rule the seat picker enforces.`,
    );
  }
  const extra: Record<string, any> = { ...(provider.extra ?? {}) };
  // The caller owns the output budget on these seats.
  delete extra.max_tokens;
  delete extra.max_completion_tokens;
  if (opts.reasoningEffort && 'reasoning_effort' in extra) extra.reasoning_effort = opts.reasoningEffort;
  // Kimi K3 accepts reasoning_effort low|high|max (default max) but its provider
  // entry omits the key so agent seats run the default — a bounded seat that
  // asks for an effort gets it here (verified live 2026-09-22).
  if (opts.reasoningEffort && !('reasoning_effort' in extra) && /^https:\/\/api\.moonshot\.ai\//i.test(provider.url) && /^kimi-k3/i.test(provider.model)) {
    extra.reasoning_effort = opts.reasoningEffort;
  }
  const payload: Record<string, any> = {
    ...extra,
    model: provider.model,
    messages,
    max_tokens: opts.maxTokens,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  };
  // Kimi's contract: output cap via max_completion_tokens, max_tokens rejected.
  if ((provider.omitParams ?? []).includes('max_tokens')) payload.max_completion_tokens = opts.maxTokens;
  for (const k of provider.omitParams ?? []) delete payload[k];
  if (opts.tools && opts.tools.length) {
    payload.tools = opts.tools;
    payload.tool_choice = opts.toolChoice ?? 'auto';
  }
  const r = await postNonStreamingCompletion(provider, payload, { timeout: opts.timeoutMs, keepThinking: opts.keepThinking });
  const choice = r.data?.choices?.[0];
  const msg = choice?.message ?? {};
  const raw = typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content) ? msg.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
  const stripped = stripLeadingThink(raw);
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  const toolCalls: SeatToolCall[] = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((tc: any) => ({
        id: String(tc?.id || ''),
        name: String(tc?.function?.name || ''),
        arguments: typeof tc?.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc?.function?.arguments ?? {}),
      }))
    : [];
  return {
    text: stripped.text.trim(),
    reasoning,
    toolCalls,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    hadReasoning: reasoning.length > 0 || stripped.hadThink,
  };
}

/** Log-friendly one-liner for a failed seat call (status + provider message, bounded). */
export function describeSeatError(err: any): string {
  const status = err?.response?.status;
  const body = err?.response?.data;
  const providerMsg = body?.error?.message || body?.message || (typeof body === 'string' ? body : '');
  const msg = String(providerMsg || err?.message || err || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return status ? `HTTP ${status}${msg ? ` — ${msg}` : ''}` : msg || 'request failed';
}

/** Warn once per (role, provider) about a seat call failure — bounded noise. */
export function warnSeatFailure(role: string, p: ProviderConfig, err: any): void {
  logger.warn(`${role} seat: ${p.model} (${p.label}) failed — ${describeSeatError(err)}`);
}

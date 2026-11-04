/**
 * Digby Edge — per-model PARSE verification battery (owner directive
 * 2026-09-15: self-hosted GPU nodes — e.g. a Nebius B300 — are first-class
 * admin-selectable fallbacks, so the admin must be able to prove a served
 * model PARSES before seating it).
 *
 * POST /admin/model-endpoints/:id/verify {modelId} runs FOUR probes against
 * one registered endpoint model, SEQUENTIALLY (a single-GPU node must not be
 * parallel-hit):
 *   1. chat_stream — the deep streaming parse probe (the heart of this
 *      module): a full streamed completion consumed to the end, EVERY SSE
 *      frame JSON-parsed. The role tester's first-token probe
 *      (probeChatCompletion) proves auth + model id but never parses past the
 *      first chunk — a server that emits malformed SSE mid-stream, or burns
 *      the whole budget on reasoning, used to look green until a real run
 *      failed. This probe fails on: an invalid-JSON frame (naming the frame),
 *      a stream that ends without finish_reason/[DONE], a stream that never
 *      ends (20s), or an answer that is empty after Digby's REAL <think>
 *      strip (with the "spent the budget thinking … flag no-think" guidance
 *      when the model only reasoned).
 *   2. utility    — the REAL non-streaming utility/helper call shape
 *                   (probeNonStreamingCompletion — thinking-off directive,
 *                   <think> strip, empty answer names the fix).
 *   3. embeddings — the 1536-dim contract probe (probeEmbeddings).
 *   4. rerank     — the Cohere-style /rerank shape probe (probeRerank).
 *
 * Every probe failure is caught and key-scrubbed (scrubError) — the battery
 * NEVER throws past the AppError(400) for an unresolvable spec. The API key
 * never appears in any result.
 *
 * Import discipline (mirrors model-roles.service.ts): axios/logger +
 * model-roles.service exports + the registry resolver are eager (that module
 * already eagerly imports prisma/context-store — fine on the admin controller
 * path); coding-model and helper-completion stay DYNAMIC imports inside the
 * functions so this module's load-time graph never pulls the run path (and
 * NEVER config/redis|config/env — jest-worker-killing boundary).
 */

import axios from 'axios';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import { resolveRegistryModel } from './model-endpoints.service';
import {
  authHeaders,
  probeEmbeddings,
  probeNonStreamingCompletion,
  probeRerank,
  scrubError,
  roleTestCustomTimeoutMs,
} from './model-roles.service';

/** Hard byte cap for the chat_stream probe (F2, adversarial review
 *  2026-09-15) — see consumeChatStream. */
const MAX_STREAM_BYTES = 4 * 1024 * 1024;

export interface EndpointModelVerifyShapeResult {
  shape: 'chat_stream' | 'utility' | 'embeddings' | 'rerank' | 'decision';
  ok: boolean;
  latencyMs: number;
  detail?: string;
  error?: string;
}

export interface EndpointModelVerifyResult {
  model: string;
  results: EndpointModelVerifyShapeResult[];
}

interface StreamParseOutcome {
  ok: boolean;
  /** Number of JSON data frames parsed (not counting [DONE]). */
  frames: number;
  finishReason: string | null;
  doneSeen: boolean;
  /** Accumulated choices[0].delta.content (think blocks NOT yet stripped). */
  content: string;
  /** Accumulated length of choices[0].delta.reasoning_content. */
  reasoningLen: number;
  error?: string;
}

/**
 * Consume the WHOLE SSE stream of one streaming chat completion, parsing
 * every frame. Resolves (never rejects): transport/timeout errors and parse
 * failures land in `error`; the caller applies the pass criteria.
 */
async function consumeChatStream(stream: any): Promise<StreamParseOutcome> {
  return new Promise<StreamParseOutcome>((resolve) => {
    const out: StreamParseOutcome = {
      ok: false, frames: 0, finishReason: null, doneSeen: false,
      content: '', reasoningLen: 0,
    };
    let buffer = '';
    let settled = false;
    // F2 (adversarial review 2026-09-15): hard byte cap — the battery's whole
    // purpose is talking to UNPROVEN admin-registered servers, and a runaway
    // one could otherwise stream garbage into the API process's heap for the
    // full 20s window. 4 MB is far past any legitimate 64-token probe answer.
    let received = 0;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { stream.destroy(); } catch { /* closing */ }
      if (error) out.error = error;
      else out.ok = true;
      resolve(out);
    };
    const timer = setTimeout(() => {
      finish(`stream did not complete within ${roleTestCustomTimeoutMs() / 1000}s`);
    }, roleTestCustomTimeoutMs());

    /** Parse one SSE event block; throws on an invalid-JSON data frame. */
    const processEvent = (event: string): void => {
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { out.doneSeen = true; continue; }
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new Error(`SSE frame #${out.frames + 1} is not valid JSON: ${data.slice(0, 80)}`);
        }
        out.frames++;
        const choice = parsed?.choices?.[0];
        const delta = choice?.delta ?? {};
        if (typeof delta.content === 'string') out.content += delta.content;
        if (typeof delta.reasoning_content === 'string') out.reasoningLen += delta.reasoning_content.length;
        if (typeof choice?.finish_reason === 'string') out.finishReason = choice.finish_reason;
      }
    };

    stream.on('data', (chunk: any) => {
      if (settled) return;
      received += typeof chunk === 'string' ? chunk.length : (chunk?.length ?? 0);
      if (received > MAX_STREAM_BYTES) {
        finish(`stream exceeded ${MAX_STREAM_BYTES} bytes without completing — not a well-formed chat-completions stream`);
        return;
      }
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const event of events) {
        if (!event.trim()) continue;
        try {
          processEvent(event);
        } catch (err: any) {
          finish(String(err?.message || err));
          return;
        }
      }
    });
    stream.on('end', () => {
      if (settled) return;
      if (buffer.trim()) {
        // A trailing event with no blank-line terminator — parse what arrived.
        try {
          processEvent(buffer);
        } catch (err: any) {
          finish(String(err?.message || err));
          return;
        }
        buffer = '';
      }
      finish();
    });
    stream.on('error', (err: Error) => finish(String(err?.message || err || 'stream error')));
  });
}

/**
 * Shape 1 — the deep streaming PARSE probe: POST provider.url with
 * stream:true and verify the whole response parses and carries a real answer.
 * Guards (colon-spec-must-stay-custom, built-in-needs-a-key) identical to
 * probeChatCompletion's.
 */
async function probeChatStreamParse(spec: string): Promise<EndpointModelVerifyShapeResult> {
  const shape = 'chat_stream' as const;
  const t0 = Date.now();
  let apiKey: string | undefined;
  try {
    const { resolveProviderForRun } = await import('../coding/coding-model');
    const { stripLeadingThink } = await import('../coding/helper-completion');
    const provider = await resolveProviderForRun(spec);
    // A colon spec that silently fell back to built-ins is a config error the
    // verifier must SURFACE, not mask (that silent fallback IS the Edge 401 bug).
    if (spec.includes(':') && !provider.label.endsWith('(custom endpoint)')) {
      return { shape, ok: false, latencyMs: Date.now() - t0, error: `"${spec}" no longer resolves to an enabled, [coding]-flagged endpoint model — the run path would silently fall back to ${provider.model}.` };
    }
    apiKey = provider.apiKey;
    if (!provider.apiKey && !spec.includes(':')) {
      return { shape, ok: false, latencyMs: Date.now() - t0, error: `The built-in provider for "${provider.model}" has no API key set on this instance (${provider.label}).` };
    }
    const payload: any = {
      model: provider.model,
      messages: [{ role: 'user', content: 'Parse check — reply with the single word OK.' }],
      max_tokens: 64,
      stream: true,
      ...provider.extra,
    };
    for (const k of provider.omitParams ?? []) delete payload[k];
    const resp = await axios.post(provider.url, payload, {
      headers: authHeaders(provider.apiKey),
      timeout: roleTestCustomTimeoutMs(), // registry models are custom endpoints (2026-10-07 longer budget)
      responseType: 'stream',
    });
    const r = await consumeChatStream(resp.data);
    if (!r.ok) {
      return { shape, ok: false, latencyMs: Date.now() - t0, error: scrubError(new Error(r.error), apiKey) };
    }
    // PASS CRITERIA (all three):
    if (r.frames === 0) {
      return { shape, ok: false, latencyMs: Date.now() - t0, error: 'stream ended without any parseable SSE data frames' };
    }
    if (!r.finishReason && !r.doneSeen) {
      return { shape, ok: false, latencyMs: Date.now() - t0, error: 'stream ended without finish_reason/[DONE]' };
    }
    // Digby's REAL <think> strip (helper-completion) — a reasoning-shaped
    // answer must not count as prose.
    const stripped = stripLeadingThink(r.content);
    const answer = stripped.text.trim();
    if (!answer) {
      if (r.reasoningLen > 0 || stripped.hadThink) {
        // Same guidance HelperEmptyAnswerError throws on the non-streaming
        // path — the model reasoned the whole budget away.
        return { shape, ok: false, latencyMs: Date.now() - t0, error: `${provider.model} (${provider.label}) returned no answer text — it spent the budget thinking (finish_reason=${r.finishReason ?? 'n/a'}). Flag the model "no-think" in the endpoint dialog (Account → Admin → Endpoints) or pick a non-thinking model for this seat.` };
      }
      return { shape, ok: false, latencyMs: Date.now() - t0, error: 'stream completed but the accumulated answer content is empty' };
    }
    return {
      shape, ok: true, latencyMs: Date.now() - t0,
      detail: `stream parse OK — ${r.frames} frame(s), finish_reason=${r.finishReason ?? 'n/a'}${r.doneSeen ? '' : ' (no [DONE])'}, answer ${answer.length} chars after think-strip (reasoning_content ${r.reasoningLen} chars)`,
    };
  } catch (err: any) {
    return { shape, ok: false, latencyMs: Date.now() - t0, error: scrubError(err, apiKey) };
  }
}

/** Map a ModelRoleTestResult (the shared role probes) onto a verify shape row. */
function shapeResult(
  shape: EndpointModelVerifyShapeResult['shape'],
  r: { ok: boolean; latencyMs: number; detail?: string; error?: string },
): EndpointModelVerifyShapeResult {
  return {
    shape, ok: r.ok, latencyMs: r.latencyMs,
    ...(r.detail ? { detail: r.detail } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

/**
 * Run the four-shape parse-verification battery against one endpoint model
 * spec ('<label>:<modelId>'). SEQUENTIAL on purpose (single-GPU nodes).
 * Throws AppError(400) only when the spec does not resolve; every probe-level
 * failure is a scrubbed { ok:false, error } row.
 */
export async function verifyEndpointModel(spec: string): Promise<EndpointModelVerifyResult> {
  const reg = await resolveRegistryModel(spec).catch(() => null);
  if (!reg) {
    throw new AppError(400, `"${spec}" does not resolve — check the endpoint label, model id, and that the endpoint is enabled.`);
  }
  const { isTypedDecisionSpec } = await import('../platform/decision-gate');
  if (reg.providerShape === 'systemone' || reg.providerShape === 'systemone_chat' || reg.decision === 'systemone_chat' || reg.kind === 'decision'
    // Review 3c18284e (condition 6): a spec THIS process learned is typed-decision (guard
    // 400 on its logit leg) verifies over its own transport too — an unflagged spec drew
    // the 4-probe chat battery and "verified" broken while healthy.
    || isTypedDecisionSpec(spec)) {
    // A decision server speaks only /systemone (or, for the typed-decision chat
    // proxy — the `systemone_chat` shape or a model flagged decision:'systemone_chat'
    // on an OpenAI-compatible endpoint, 2026-09-26 — a questions-carrying
    // /chat/completions) — the chat/embeddings/rerank battery would 404 / 400 on
    // it. One real typed-decision probe over the model's own transport is the verdict.
    // Ticket 2df5ed65: a DECISION-KIND model (unflagged but read as decision by
    // the [typed decisions] chip, a detection, or the id heuristic — e.g. an
    // `agx-laya` route on a LiteLLM openai_chat row) is in the same class: the
    // chat battery's plain call draws its usage-guide 400 and the model verified
    // "broken" while healthy. registryDecisionTransport is the single source of
    // truth for the transport (shape > flag > kind).
    // Review 3c18284e (condition 6): the latch is consulted TOO — a spec this process
    // LEARNED is typed-decision (guard 400 on its logit leg) verifies over the chat
    // transport even when no flag/kind says so; before the latch existed an unflagged
    // spec drew the 4-probe chat battery and "verified" broken while healthy.
    const { registryDecisionTransport } = await import('../platform/decision-gate');
    const transport = registryDecisionTransport(reg, spec) ?? 'chat' as const;
    logger.info(`endpoint-verifier: verifying "${spec}" (${reg.providerShape === 'systemone' ? 'systemone' : 'systemone_chat'} decision probe)`);
    const { probeSystemOneServer } = await import('../platform/decision-gate');
    const r = await probeSystemOneServer({ baseUrl: reg.baseUrl, apiKey: reg.apiKey, model: reg.model, transport }).catch((err: any) => ({
      ok: false, target: spec, latencyMs: 0, error: scrubError(err, reg.apiKey),
    }));
    return { model: spec, results: [shapeResult('decision', r)] };
  }
  logger.info(`endpoint-verifier: verifying "${spec}" (4 probes, sequential)`);
  const results: EndpointModelVerifyShapeResult[] = [];
  results.push(await probeChatStreamParse(spec));
  results.push(shapeResult('utility', await probeNonStreamingCompletion(spec, spec).catch((err: any) => ({
    ok: false, latencyMs: 0, error: scrubError(err, reg.apiKey),
  }))));
  results.push(shapeResult('embeddings', await probeEmbeddings(spec).catch((err: any) => ({
    ok: false, latencyMs: 0, error: scrubError(err, reg.apiKey),
  }))));
  results.push(shapeResult('rerank', await probeRerank(spec).catch((err: any) => ({
    ok: false, latencyMs: 0, error: scrubError(err, reg.apiKey),
  }))));
  return { model: spec, results };
}

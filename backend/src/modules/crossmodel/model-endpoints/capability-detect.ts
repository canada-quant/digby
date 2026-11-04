/**
 * Digby Edge — AUTOMATIC capability detection for custom-endpoint models
 * (2026-09-27, owner: "replace manual flag-picking with a Detect capabilities
 * action"). The gpt-6-astra incident (a 128-tool OpenAI cap + a proxy-injected
 * reasoning_effort, both discovered in PRODUCTION after 48 rejected supervisor
 * turns) is the kind of fact this suite establishes BEFORE a seat is assigned.
 *
 *   POST /admin/model-endpoints/:id/detect            — every model of the endpoint
 *   POST /admin/model-endpoints/:id/detect/:modelId   — one model
 *   → detectEndpointCapabilities(endpointId, { modelId?, capabilities? })
 *   → { endpointId, label, detectedAt, models: DetectedModelReport[] }
 *
 * Per model, a BOUNDED probe suite (every probe: its own 20 s timeout + its own
 * try/catch → a row { ok:false, evidence } never a throw; ≤ 4 models in flight;
 * inside a model the probes run in small groups so a single-GPU node is never
 * hammered and the per-model wall clock stays bounded):
 *
 *   1. chat_stream      POST stream:true → 'json' (OpenAI SSE chunks) | 'raw_text'
 *                       (plain-token data: lines — tool calls cannot ride it) |
 *                       null; also whether reasoning_content / a <think> block
 *                       appeared (feeds 5).
 *   2. tool_calling     one tiny `ping` tool → tool_calls returned? (a 400 that
 *                       names reasoning_effort feeds 4).
 *   3. max_tools        200 stub tools → 200 = no cap seen; a 400 "array too
 *                       long" → the cap it names, else 128 tried once.
 *   4. reasoning_effort reasoning_effort:'low' + the ping tool → 'supported' |
 *                       'unsupported' (the "use /v1/responses or 'none'" case).
 *   5. thinking_default reasoning seen in 1 → the thinking-off directive is
 *                       tried: honoured ⇒ thinking:'off'; rejected ⇒ latch note.
 *   6. vision           a 1×1 PNG image part → accepted?
 *   7. embeddings       probeEmbeddings (1536 contract + MRL truncation) → dims.
 *   8. rerank           probeRerank → Cohere-style /rerank served?
 *   9. typed_decisions  probeSystemOneServer transport 'chat' → decision:'systemone_chat'.
 *  10. image_generation ONLY for image-looking ids / [image] entries (never spend
 *                       otherwise) → probeImageGenerate.
 *  11. context_window   GET /models metadata (context_length / max_model_len /
 *                       context_window / max_context_length) → tokens or blank.
 *
 * The verdicts SET the entry's flags (applyDetectionToEntry — pure; a flag the
 * admin set by hand — `manualFlags` — is never overwritten), the results ride
 * the entry as `capabilities` (evidence line + timestamp per probe), and the
 * entry is persisted through model-endpoints.service applyModelDetection.
 *
 * Never logs or returns API keys: every evidence string that could echo a
 * provider body goes through scrubError. Import discipline mirrors
 * endpoint-verifier.ts: axios / logger / AppError / prisma / the two services
 * are eager; coding-model, decision-gate and image-generate are DYNAMIC imports
 * inside the probes (never config/env at load — it process.exit(1)s under jest).
 */

import axios from 'axios';
import logger from '../../../utils/logger';
import prisma from '../../../config/database';
import { AppError } from '../../../middleware/error-handler';
import { decryptValue } from '../coding/credentials.service';
import { parseToolCapFromError, providerClassForModelId } from '../coding/provider-limits';
import { TOOLS_TOO_LONG_RE, classifyInvalidRequest } from '../coding/seat-invalid-request';
import { litellmModelInfoUrls, litellmMaxInputTokens } from '../coding/gateway-model-info';
import {
  DETECT_CAPABILITIES,
  applyModelDetection,
  heuristicModelKind,
  isDecisionProviderShape,
  type DetectCapability,
  type DetectedCapabilityResult,
  type EndpointModelEntry,
  type EndpointModelKind,
} from './model-endpoints.service';
import { probeEmbeddings, probeRerank, scrubError, authHeaders, ROLE_TEST_TIMEOUT_MS } from './model-roles.service';

export interface DetectedModelReport {
  id: string;
  detectedAt: string;
  results: DetectedCapabilityResult[];
  /** The model entry AFTER detection applied its flags (what was persisted). */
  entry: EndpointModelEntry;
  /** Flags detection changed on this run, e.g. ['maxTools=128', 'reasoningEffort=unsupported']. */
  changed: string[];
}

export interface DetectEndpointResult {
  endpointId: string;
  label: string;
  detectedAt: string;
  models: DetectedModelReport[];
}

export interface DetectOptions {
  modelId?: string;
  capabilities?: string[];
}

/** A model that is a TYPED-DECISION model: flagged decision:'systemone_chat', kind 'decision',
 *  or served by a decision-shaped endpoint ('systemone' / 'systemone_chat'). Pure. */
export function isDecisionModelEntry(entry: Pick<EndpointModelEntry, 'decision' | 'kind'>, providerShape: unknown): boolean {
  return entry.decision === 'systemone_chat' || entry.kind === 'decision' || isDecisionProviderShape(providerShape);
}

/** The probe capability set a decision model runs (the /verify call, nothing else). */
export const DECISION_MODEL_CAPABILITIES: readonly DetectCapability[] = ['decision'];

/** Models probed at once across the endpoint. */
export const DETECT_MAX_CONCURRENT_MODELS = 4;
/** Per-probe wall clock (the role tester's 20 s). */
export const DETECT_PROBE_TIMEOUT_MS = ROLE_TEST_TIMEOUT_MS;
/** GET /models (context window) is a metadata read — the connectivity check's 5 s. */
const MODELS_LIST_TIMEOUT_MS = 5_000;
/** Hard byte cap on the streamed probe (the verifier's guard). */
const MAX_STREAM_BYTES = 1024 * 1024;
const EVIDENCE_CAP = 600;

/** A real 1×1 transparent PNG — the vision probe's image part. */
export const ONE_PIXEL_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The tiny function tool the tool-calling / effort probes send. */
export const PING_TOOL = {
  type: 'function',
  function: { name: 'ping', description: 'Reply with pong. Call it when asked.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
} as const;

/** The stub tools the max-tools probe sends (N distinct names, empty schemas). */
export function stubTools(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    type: 'function',
    function: { name: `probe_tool_${i}`, description: `Probe tool ${i}.`, parameters: { type: 'object', properties: {} } },
  }));
}

/** The probe order — groups run in parallel INSIDE a model, groups in sequence. */
const PROBE_GROUPS: DetectCapability[][] = [
  ['chat_stream', 'tool_calling', 'max_tools'],
  ['reasoning_effort', 'thinking_default', 'vision'],
  ['embeddings', 'rerank', 'typed_decisions'],
  ['image_generation', 'context_window'],
];

interface ProbeContext {
  baseUrl: string;
  chatUrl: string;
  apiKey: string | null;
  model: string;
  /** '<label>:<modelId>' — the spec the shared probes (embeddings / rerank / image) resolve. */
  spec: string;
  entry: EndpointModelEntry;
  /** Cross-probe signals (1 → 5, 2 → 4). */
  signals: { thinkingSeen?: boolean; chatStreamRan?: boolean; effortRejected?: string | null };
  /** The endpoint's providerShape — the decision probe's transport follows it ('systemone' → /systemone, else the chat route). */
  providerShape?: string;
}

const nowIso = () => new Date().toISOString();

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not complete within ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, guard]).finally(() => { if (timer) clearTimeout(timer); }) as Promise<T>;
}

/** Key-scrubbed, bounded evidence text. */
function redact(text: string, apiKey: string | null): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return scrubError(new Error(s), apiKey).slice(0, EVIDENCE_CAP);
}

/** The provider's own words from an axios error (streamed body drained, JSON body serialised), key-scrubbed. */
async function providerDetail(err: any, apiKey: string | null): Promise<string> {
  try {
    const { drainAxiosErrorBody, extractProviderErrorDetail } = await import('../coding/coding-model');
    const body = await drainAxiosErrorBody(err);
    const detail = extractProviderErrorDetail(body, EVIDENCE_CAP);
    return redact(detail || String(err?.message || ''), apiKey);
  } catch {
    return redact(String(err?.message || ''), apiKey);
  }
}

function httpStatus(err: any): number | undefined {
  const s = err?.response?.status;
  return typeof s === 'number' ? s : undefined;
}

function row(capability: DetectCapability, t0: number, r: { ok: boolean; value: DetectedCapabilityResult['value']; evidence: string; skipped?: boolean }): DetectedCapabilityResult {
  return {
    capability,
    ok: r.ok,
    value: r.value,
    evidence: r.evidence.slice(0, EVIDENCE_CAP),
    latencyMs: Date.now() - t0,
    at: nowIso(),
    ...(r.skipped ? { skipped: true } : {}),
  };
}

// ── SSE consumer (bounded) ───────────────────────────────────────────────────

interface StreamOutcome {
  jsonFrames: number;
  rawLines: number;
  content: string;
  reasoningLen: number;
  finishReason: string | null;
  doneSeen: boolean;
  toolCallDeltas: number;
  error?: string;
}

function consumeSse(stream: any, timeoutMs: number): Promise<StreamOutcome> {
  return new Promise<StreamOutcome>((resolve) => {
    const out: StreamOutcome = { jsonFrames: 0, rawLines: 0, content: '', reasoningLen: 0, finishReason: null, doneSeen: false, toolCallDeltas: 0 };
    let buffer = '';
    let received = 0;
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { stream.destroy(); } catch { /* closing */ }
      if (error) out.error = error;
      resolve(out);
    };
    const timer = setTimeout(() => finish(`stream did not complete within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    timer.unref?.();
    const takeLine = (line: string) => {
      const t = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (!t.startsWith('data:')) return;
      const data = t.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') { out.doneSeen = true; return; }
      try {
        const parsed = JSON.parse(data);
        out.jsonFrames++;
        const choice = parsed?.choices?.[0];
        const delta = choice?.delta ?? {};
        if (typeof delta.content === 'string') out.content += delta.content;
        if (typeof delta.reasoning_content === 'string') out.reasoningLen += delta.reasoning_content.length;
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) out.toolCallDeltas += delta.tool_calls.length;
        if (typeof choice?.finish_reason === 'string') out.finishReason = choice.finish_reason;
      } catch {
        // A non-JSON payload — the raw-text gateway shape (coding-model sseRawTextPayload).
        out.rawLines++;
        out.content += data.startsWith(' ') ? data.slice(1) : data;
      }
    };
    stream.on('data', (chunk: any) => {
      if (settled) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      received += text.length;
      if (received > MAX_STREAM_BYTES) { finish(`stream exceeded ${MAX_STREAM_BYTES} bytes without completing`); return; }
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) takeLine(line);
    });
    stream.on('end', () => { if (settled) return; if (buffer.trim()) takeLine(buffer); finish(); });
    stream.on('close', () => finish());
    stream.on('error', (err: Error) => finish(String(err?.message || err || 'stream error')));
  });
}

// ── The probes ───────────────────────────────────────────────────────────────

function chatPost(ctx: ProbeContext, body: Record<string, any>, extra?: Record<string, any>) {
  return axios.post(ctx.chatUrl, body, {
    headers: authHeaders(ctx.apiKey),
    timeout: DETECT_PROBE_TIMEOUT_MS,
    ...extra,
  });
}

async function probeChatStream(ctx: ProbeContext): Promise<DetectedCapabilityResult> {
  const t0 = Date.now();
  ctx.signals.chatStreamRan = true;
  try {
    const resp = await chatPost(ctx, {
      model: ctx.model,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      max_tokens: 32,
      stream: true,
    }, { responseType: 'stream' });
    const r = await consumeSse(resp.data, DETECT_PROBE_TIMEOUT_MS);
    const thinkSeen = /<think>/i.test(r.content);
    ctx.signals.thinkingSeen = r.reasoningLen > 0 || thinkSeen;
    const thinkingNote = r.reasoningLen > 0 ? `; reasoning_content ${r.reasoningLen} chars (thinks by default)` : thinkSeen ? '; a <think> block in content (thinks by default)' : '; no reasoning seen';
    if (r.error && r.jsonFrames === 0 && r.rawLines === 0) {
      return row('chat_stream', t0, { ok: false, value: null, evidence: redact(`sent stream:true → ${r.error}`, ctx.apiKey) });
    }
    if (r.jsonFrames > 0) {
      return row('chat_stream', t0, {
        ok: true, value: 'json',
        evidence: redact(`sent stream:true → ${r.jsonFrames} OpenAI JSON chunk(s), finish_reason=${r.finishReason ?? 'n/a'}${r.doneSeen ? '' : ' (no [DONE])'}, ${r.content.trim().length} answer chars${thinkingNote}${r.error ? ` (${r.error})` : ''}`, ctx.apiKey),
      });
    }
    if (r.rawLines > 0) {
      return row('chat_stream', t0, {
        ok: true, value: 'raw_text',
        evidence: redact(`sent stream:true → ${r.rawLines} RAW-TEXT data: line(s), no JSON chunks — tool calls cannot ride this stream (agentic seats answer prose-only); ${r.content.trim().length} answer chars${thinkingNote}`, ctx.apiKey),
      });
    }
    return row('chat_stream', t0, { ok: false, value: null, evidence: 'sent stream:true → the stream ended without any data: frames' });
  } catch (err: any) {
    return row('chat_stream', t0, { ok: false, value: null, evidence: `sent stream:true → ${httpStatus(err) ? `HTTP ${httpStatus(err)}: ` : ''}${await providerDetail(err, ctx.apiKey)}` });
  }
}

async function probeToolCalling(ctx: ProbeContext): Promise<DetectedCapabilityResult> {
  const t0 = Date.now();
  try {
    const resp = await chatPost(ctx, {
      model: ctx.model,
      messages: [{ role: 'user', content: 'Call the ping tool now.' }],
      tools: [PING_TOOL],
      tool_choice: 'auto',
      max_tokens: 64,
      stream: false,
    });
    const msg = resp.data?.choices?.[0]?.message ?? {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length) {
      const names = calls.map((c: any) => String(c?.function?.name ?? c?.name ?? '?')).join(', ');
      return row('tool_calling', t0, { ok: true, value: true, evidence: redact(`sent 1 tool (ping) → tool_calls returned: ${names}`, ctx.apiKey) });
    }
    const text = String(msg.content ?? '').trim();
    return row('tool_calling', t0, { ok: true, value: false, evidence: redact(`sent 1 tool (ping) → answered in prose without tool_calls${text ? `: "${text.slice(0, 80)}"` : ''}`, ctx.apiKey) });
  } catch (err: any) {
    const status = httpStatus(err);
    const detail = await providerDetail(err, ctx.apiKey);
    if (status === 400) {
      const { REASONING_EFFORT_REJECTION_RE } = await import('../coding/coding-model');
      if (REASONING_EFFORT_REJECTION_RE.test(detail)) {
        ctx.signals.effortRejected = detail;
        return row('tool_calling', t0, { ok: true, value: null, evidence: `sent 1 tool (ping) → HTTP 400 naming reasoning_effort (the proxy injects one; tools + reasoning_effort refused — see reasoning_effort): ${detail}` });
      }
      return row('tool_calling', t0, { ok: true, value: null, evidence: `sent 1 tool (ping) → HTTP 400: ${detail}` });
    }
    return row('tool_calling', t0, { ok: false, value: null, evidence: `sent 1 tool (ping) → ${status ? `HTTP ${status}: ` : ''}${detail}` });
  }
}

async function probeMaxTools(ctx: ProbeContext): Promise<DetectedCapabilityResult> {
  const t0 = Date.now();
  const send = (n: number) => chatPost(ctx, {
    model: ctx.model,
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    tools: stubTools(n),
    tool_choice: 'auto',
    max_tokens: 8,
    stream: false,
  });
  try {
    await send(200);
    return row('max_tools', t0, { ok: true, value: 200, evidence: 'sent 200 stub tools → HTTP 200 (≥200 accepted, no cap seen)' });
  } catch (err: any) {
    const status = httpStatus(err);
    const detail = await providerDetail(err, ctx.apiKey);
    if (status !== 400) {
      return row('max_tools', t0, { ok: false, value: null, evidence: `sent 200 stub tools → ${status ? `HTTP ${status}: ` : ''}${detail}` });
    }
    if (!TOOLS_TOO_LONG_RE.test(detail)) {
      const cls = classifyInvalidRequest({ errorStatus: 400, providerError: detail });
      const { REASONING_EFFORT_REJECTION_RE } = await import('../coding/coding-model');
      if (REASONING_EFFORT_REJECTION_RE.test(detail)) ctx.signals.effortRejected = detail;
      return row('max_tools', t0, { ok: true, value: null, evidence: `sent 200 stub tools → HTTP 400 not about the array length${cls ? ` (${cls.kind})` : ''}: ${detail}` });
    }
    const cap = parseToolCapFromError(detail);
    if (cap) {
      return row('max_tools', t0, { ok: true, value: cap, evidence: `sent 200 stub tools → HTTP 400 "array too long", the body names the cap ${cap}: ${detail}` });
    }
    // The body says "too many" without a number — one bounded retry at 128 (the OpenAI documented cap).
    try {
      await send(128);
      return row('max_tools', t0, { ok: true, value: 128, evidence: `sent 200 stub tools → HTTP 400 "too many tools" (no number); sent 128 → HTTP 200 — cap 128: ${detail}` });
    } catch (err2: any) {
      const detail2 = await providerDetail(err2, ctx.apiKey);
      return row('max_tools', t0, { ok: true, value: null, evidence: `sent 200 stub tools → HTTP 400 "too many tools" (no number); sent 128 → ${httpStatus(err2) ? `HTTP ${httpStatus(err2)}` : 'error'} — the cap is below 128, set max tools by hand: ${detail2}` });
    }
  }
}

async function probeReasoningEffort(ctx: ProbeContext): Promise<DetectedCapabilityResult> {
  const t0 = Date.now();
  if (ctx.signals.effortRejected) {
    const d = ctx.signals.effortRejected;
    return row('reasoning_effort', t0, {
      ok: true, value: 'unsupported',
      evidence: `the tool-calling probe already got HTTP 400 naming reasoning_effort${/\/v1\/responses|['"]none['"]/i.test(d) ? " — the server says: use /v1/responses or set reasoning_effort to 'none' (LiteLLM: add reasoning_effort: none under litellm_params for this model group)" : ''}: ${d}`,
    });
  }
  try {
    await chatPost(ctx, {
      model: ctx.model,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      tools: [PING_TOOL],
      tool_choice: 'auto',
      reasoning_effort: 'low',
      max_tokens: 8,
      stream: false,
    });
    return row('reasoning_effort', t0, { ok: true, value: 'supported', evidence: "sent reasoning_effort:'low' + 1 tool → HTTP 200 (accepted)" });
  } catch (err: any) {
    const status = httpStatus(err);
    const detail = await providerDetail(err, ctx.apiKey);
    if (status === 400) {
      const { REASONING_EFFORT_REJECTION_RE } = await import('../coding/coding-model');
      if (REASONING_EFFORT_REJECTION_RE.test(detail)) {
        return row('reasoning_effort', t0, {
          ok: true, value: 'unsupported',
          evidence: `sent reasoning_effort:'low' + 1 tool → HTTP 400${/\/v1\/responses|['"]none['"]/i.test(detail) ? " — the server says: use /v1/responses or set reasoning_effort to 'none' (LiteLLM: add reasoning_effort: none under litellm_params for this model group)" : ''}: ${detail}`,
        });
      }
      return row('reasoning_effort', t0, { ok: true, value: null, evidence: `sent reasoning_effort:'low' + 1 tool → HTTP 400 not about reasoning_effort: ${detail}` });
    }
    return row('reasoning_effort', t0, { ok: false, value: null, evidence: `sent reasoning_effort:'low' + 1 tool → ${status ? `HTTP ${status}: ` : ''}${detail}` });
  }
}

/** Evidence prefix the flag application keys on (thinking:'off' only when the directive was honoured). */
export const THINKING_DIRECTIVE_HONOURED = 'thinks by default; directive honoured';

async function probeThinkingDefault(ctx: ProbeContext): Promise<DetectedCapabilityResult> {
  const t0 = Date.now();
  const hasReasoning = (msg: any) => (typeof msg?.reasoning_content === 'string' && msg.reasoning_content.length > 0) || /<think>/i.test(String(msg?.content ?? ''));
  try {
    if (!ctx.signals.chatStreamRan) {
      // The stream probe was not part of this run — one plain call decides whether the model reasons by default.
      const resp = await chatPost(ctx, { model: ctx.model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 32, stream: false });
      ctx.signals.thinkingSeen = hasReasoning(resp.data?.choices?.[0]?.message);
    }
    if (!ctx.signals.thinkingSeen) {
      return row('thinking_default', t0, { ok: true, value: false, evidence: 'no reasoning_content / <think> block in the probe answer — the model does not think by default; the thinking-off directive was not tried' });
    }
    const { THINKING_OFF_EXTRA } = await import('../coding/coding-model');
    try {
      const resp = await chatPost(ctx, {
        model: ctx.model,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        max_tokens: 32,
        stream: false,
        ...THINKING_OFF_EXTRA,
      });
      const msg = resp.data?.choices?.[0]?.message;
      if (hasReasoning(msg)) {
        return row('thinking_default', t0, { ok: true, value: true, evidence: 'thinks by default; directive IGNORED (chat_template_kwargs.enable_thinking=false → HTTP 200 but reasoning still present) — pick a non-thinking model for the fast seats or budget max_tokens' });
      }
      return row('thinking_default', t0, { ok: true, value: true, evidence: `${THINKING_DIRECTIVE_HONOURED} (chat_template_kwargs.enable_thinking=false → HTTP 200, no reasoning) — thinking:'off' set` });
    } catch (err: any) {
      const status = httpStatus(err);
      const detail = await providerDetail(err, ctx.apiKey);
      if (status && status >= 400 && status < 500) {
        return row('thinking_default', t0, { ok: true, value: true, evidence: `thinks by default; directive REJECTED (chat_template_kwargs.enable_thinking=false → HTTP ${status}) — helper-completion latches it off for this model; the fast seats will pay for its reasoning: ${detail}` });
      }
      return row('thinking_default', t0, { ok: false, value: true, evidence: `thinks by default; the directive probe failed → ${status ? `HTTP ${status}: ` : ''}${detail}` });
    }
  } catch (err: any) {
    return row('thinking_default', t0, { ok: false, value: null, evidence: `probe failed → ${httpStatus(err) ? `HTTP ${httpStatus(err)}: ` : ''}${await providerDetail(err, ctx.apiKey)}` });
  }
}

async function probeVision(ctx: ProbeContext): Promise<DetectedCapabilityResult> {
  const t0 = Date.now();
  try {
    await chatPost(ctx, {
      model: ctx.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What color?' }, { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } }] }],
      max_tokens: 8,
      stream: false,
    });
    return row('vision', t0, { ok: true, value: true, evidence: 'sent a 1×1 PNG image_url part → HTTP 200 (image input accepted)' });
  } catch (err: any) {
    const status = httpStatus(err);
    const detail = await providerDetail(err, ctx.apiKey);
    if (status && status >= 400 && status < 500) {
      return row('vision', t0, { ok: true, value: false, evidence: `sent a 1×1 PNG image_url part → HTTP ${status} (image input rejected): ${detail}` });
    }
    return row('vision', t0, { ok: false, value: null, evidence: `sent a 1×1 PNG image_url part → ${status ? `HTTP ${status}: ` : ''}${detail}` });
  }
}

/** The dimension count a probeEmbeddings detail / error names, or null. Pure. */
export function parseEmbeddingDims(text: string | undefined | null): number | null {
  const s = String(text ?? '');
  const m = /native (\d{2,6}) dims|(\d{2,6}) dimensions|returns? (\d{2,6})-dimensional|returned (\d{2,6})-dimensional/i.exec(s);
  if (!m) return null;
  const n = parseInt(m[1] ?? m[2] ?? m[3] ?? m[4], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Evidence marker the flag application keys on for the MRL flag. */
export const MATRYOSHKA_TRUNCATED_MARK = 'Matryoshka-truncated';

async function probeEmbeddingsCap(ctx: ProbeContext): Promise<DetectedCapabilityResult> {
  const t0 = Date.now();
  try {
    const r = await withTimeout(probeEmbeddings(ctx.spec), DETECT_PROBE_TIMEOUT_MS + 500, 'the /embeddings probe');
    if (r.ok) {
      const dims = parseEmbeddingDims(r.detail) ?? 1536;
      return row('embeddings', t0, { ok: true, value: dims, evidence: redact(`POST /embeddings → ${r.detail ?? 'ok'}`, ctx.apiKey) });
    }
    const err = String(r.error ?? '');
    const dims = parseEmbeddingDims(err);
    if (/HTTP (404|400|405|501)/.test(err) && dims === null) {
      return row('embeddings', t0, { ok: false, value: null, evidence: redact(`POST /embeddings → no /embeddings route for this model (${err})`, ctx.apiKey) });
    }
    return row('embeddings', t0, { ok: false, value: dims, evidence: redact(`POST /embeddings → ${err}`, ctx.apiKey) });
  } catch (err: any) {
    return row('embeddings', t0, { ok: false, value: null, evidence: `POST /embeddings → ${redact(String(err?.message || err), ctx.apiKey)}` });
  }
}

async function probeRerankCap(ctx: ProbeContext): Promise<DetectedCapabilityResult> {
  const t0 = Date.now();
  try {
    const r = await withTimeout(probeRerank(ctx.spec), DETECT_PROBE_TIMEOUT_MS + 500, 'the /rerank probe');
    if (r.ok) return row('rerank', t0, { ok: true, value: true, evidence: redact(`POST /rerank → ${r.detail ?? 'ok'}`, ctx.apiKey) });
    return row('rerank', t0, { ok: true, value: false, evidence: redact(`POST /rerank → not served: ${r.error ?? 'failed'}`, ctx.apiKey) });
  } catch (err: any) {
    return row('rerank', t0, { ok: false, value: null, evidence: `POST /rerank → ${redact(String(err?.message || err), ctx.apiKey)}` });
  }
}

async function probeTypedDecisions(ctx: ProbeContext): Promise<DetectedCapabilityResult> {
  const t0 = Date.now();
  try {
    const { probeSystemOneServer } = await import('../platform/decision-gate');
    const r = await withTimeout(
      probeSystemOneServer({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey ?? undefined, model: ctx.model, transport: 'chat' }),
      DETECT_PROBE_TIMEOUT_MS + 500, 'the typed-decision probe',
    );
    if (r.ok) return row('typed_decisions', t0, { ok: true, value: true, evidence: redact(`one typed-decision question map via /chat/completions → answers envelope parsed: ${r.detail ?? 'ok'}`, ctx.apiKey) });
    return row('typed_decisions', t0, { ok: true, value: false, evidence: redact(`one typed-decision question map via /chat/completions → not a typed-decision model: ${r.error ?? 'no answers envelope'}`, ctx.apiKey) });
  } catch (err: any) {
    return row('typed_decisions', t0, { ok: false, value: null, evidence: `typed-decision probe → ${redact(String(err?.message || err), ctx.apiKey)}` });
  }
}

/** The ONE probe a decision model gets: the same typed-decision call /verify makes
 *  (endpoint-verifier.ts) over the model's own transport. */
async function probeDecision(ctx: ProbeContext): Promise<DetectedCapabilityResult> {
  const t0 = Date.now();
  const transport = ctx.providerShape === 'systemone' ? 'systemone' as const : 'chat' as const;
  const route = transport === 'systemone' ? 'POST /systemone' : 'POST /chat/completions (questions map)';
  try {
    const { probeSystemOneServer } = await import('../platform/decision-gate');
    const r = await withTimeout(
      probeSystemOneServer({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey ?? undefined, model: ctx.model, transport }),
      DETECT_PROBE_TIMEOUT_MS + 500, 'the typed-decision probe',
    );
    if (r.ok) return row('decision', t0, { ok: true, value: true, evidence: redact(`typed-decision model — one noul + choice via ${route} → answers envelope parsed: ${r.detail ?? 'ok'}; chat capabilities not applicable`, ctx.apiKey) });
    return row('decision', t0, { ok: false, value: null, evidence: redact(`typed-decision model — one noul + choice via ${route} → ${r.error ?? 'no answers envelope'}; chat capabilities not applicable`, ctx.apiKey) });
  } catch (err: any) {
    return row('decision', t0, { ok: false, value: null, evidence: `typed-decision probe (${route}) → ${redact(String(err?.message || err), ctx.apiKey)}` });
  }
}

/** Image generation is only ever probed for image-looking ids / [image] entries (spend). Pure. */
export function looksLikeImageModel(entry: Pick<EndpointModelEntry, 'id' | 'image' | 'kind'>): boolean {
  return entry.image === true || entry.kind === 'image' || heuristicModelKind(entry.id) === 'image';
}

async function probeImageGeneration(ctx: ProbeContext): Promise<DetectedCapabilityResult> {
  const t0 = Date.now();
  if (!looksLikeImageModel(ctx.entry)) {
    return row('image_generation', t0, { ok: true, value: null, evidence: 'id does not look like an image model — not probed (flag [image] or set kind to image to force a probe)', skipped: true });
  }
  try {
    const { probeImageGenerate, imageProbeTimeoutMs } = await import('../image-generate');
    // 04c8ffd1 (review B1): a per-entry imageTimeoutMs raises the detect probe
    // budget with it — a slow local backend (5-10 min/generation) the admin
    // explicitly unblocked must not be detected "failed" against the stock 180 s.
    const { resolveRegistryModel } = await import('./model-endpoints.service');
    let entryImageTimeoutMs: number | undefined;
    try {
      const reg = await resolveRegistryModel(ctx.spec);
      entryImageTimeoutMs = reg?.imageTimeoutMs && reg.imageTimeoutMs > 0 ? reg.imageTimeoutMs : undefined;
    } catch { /* registry miss — the probe itself reports the skip */ }
    const budgetMs = Math.max(imageProbeTimeoutMs(), entryImageTimeoutMs ?? 0);
    const r = await withTimeout(probeImageGenerate(ctx.spec, budgetMs), budgetMs + 5_000, 'the image-generation probe');
    if (r.ok) return row('image_generation', t0, { ok: true, value: true, evidence: redact(`POST /images/generations (tiny prompt) → ${r.detail}`, ctx.apiKey) });
    return row('image_generation', t0, { ok: true, value: false, evidence: redact(`POST /images/generations (tiny prompt) → failed: ${r.detail}`, ctx.apiKey) });
  } catch (err: any) {
    return row('image_generation', t0, { ok: false, value: null, evidence: `image-generation probe → ${redact(String(err?.message || err), ctx.apiKey)}` });
  }
}

const CONTEXT_FIELDS = ['context_length', 'max_model_len', 'context_window', 'max_context_length'] as const;

// ── LiteLLM /model/info (audit 2026-10-06 T1-2) ──────────────────────────────
// LiteLLM's OpenAI-compatible GET /v1/models carries NO context field, so every
// gateway seat stayed blank and ran at the 160k registry default (7,426
// compactions / 48 h on the owner's cql-litellm lanes). The proxy publishes the
// window on GET /model/info (also mounted at /v1/model/info) as
// `data[].model_info.max_input_tokens`, one row per DEPLOYMENT of a model group
// (`data[].model_name`) — the group's usable window is the MIN across its
// deployments (a router may send any request to any of them). Tried only when
// /models yields no window. Kill switch CAPABILITY_DETECT_LITELLM_MODEL_INFO_DISABLED=1.
export function litellmModelInfoDisabled(): boolean {
  const v = String(process.env.CAPABILITY_DETECT_LITELLM_MODEL_INFO_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
// audit 2026-10-08 W2-3: the two pure /model/info parsers moved to the leaf
// coding/gateway-model-info.ts (the run-time window lookup uses them without
// pulling this module's prisma graph into the run path) — re-exported here.
export { litellmModelInfoUrls, litellmMaxInputTokens } from '../coding/gateway-model-info';
async function probeLitellmModelInfo(ctx: ProbeContext): Promise<{ tokens: number; evidence: string } | { tokens: null; evidence: string }> {
  const tried: string[] = [];
  for (const url of litellmModelInfoUrls(ctx.baseUrl)) {
    const path = url.slice(url.indexOf('/', url.indexOf('//') + 2)) || url;
    try {
      const resp = await axios.get(url, { headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}, timeout: MODELS_LIST_TIMEOUT_MS });
      if (!Array.isArray(resp.data?.data)) { tried.push(`${path} → no data[] list`); continue; }
      const hit = litellmMaxInputTokens(resp.data, ctx.model);
      if (hit) return { tokens: hit.tokens, evidence: `GET ${path} → model_info.max_input_tokens=${hit.tokens} tokens for "${ctx.model}" (min across ${hit.deployments} deployment${hit.deployments === 1 ? '' : 's'})` };
      tried.push(`${path} → no max_input_tokens for model_name "${ctx.model}"`);
      break; // a LiteLLM list that lacks the model will not gain it on the alias path
    } catch (err: any) {
      tried.push(`${path} → ${httpStatus(err) ? `HTTP ${httpStatus(err)}` : redact(String(err?.message || err), ctx.apiKey).slice(0, 80)}`);
    }
  }
  return { tokens: null, evidence: tried.join('; ') };
}

async function probeContextWindow(ctx: ProbeContext): Promise<DetectedCapabilityResult> {
  const t0 = Date.now();
  // audit 2026-10-06 T1-2: a /models miss falls through to LiteLLM /model/info.
  const viaModelInfo = async (blankEvidence: string, okOnMiss: boolean): Promise<DetectedCapabilityResult> => {
    if (litellmModelInfoDisabled()) return row('context_window', t0, { ok: okOnMiss, value: null, evidence: blankEvidence });
    const mi = await probeLitellmModelInfo(ctx);
    if (mi.tokens) return row('context_window', t0, { ok: true, value: mi.tokens, evidence: `${blankEvidence.replace(/ — context window left blank$/, '')}; ${mi.evidence}` });
    return row('context_window', t0, { ok: okOnMiss, value: null, evidence: `${blankEvidence}${mi.evidence ? ` (LiteLLM /model/info: ${mi.evidence})` : ''}` });
  };
  try {
    const resp = await axios.get(`${ctx.baseUrl}/models`, { headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}, timeout: MODELS_LIST_TIMEOUT_MS });
    const list: any[] = Array.isArray(resp.data?.data) ? resp.data.data : [];
    const meta = list.find((m) => String(m?.id ?? '') === ctx.model);
    if (!meta) {
      return viaModelInfo(`GET /models → ${list.length} model(s) listed, "${ctx.model}" not among them — context window left blank`, true);
    }
    for (const f of CONTEXT_FIELDS) {
      const v = Number((meta as any)[f]);
      if (Number.isFinite(v) && v > 0) return row('context_window', t0, { ok: true, value: Math.floor(v), evidence: `GET /models → ${f}=${Math.floor(v)} tokens for "${ctx.model}"` });
    }
    return viaModelInfo(`GET /models → "${ctx.model}" listed but carries no ${CONTEXT_FIELDS.join(' / ')} field — context window left blank`, true);
  } catch (err: any) {
    return viaModelInfo(`GET /models → ${httpStatus(err) ? `HTTP ${httpStatus(err)}: ` : ''}${await providerDetail(err, ctx.apiKey)}`, false);
  }
}

const PROBES: Record<DetectCapability, (ctx: ProbeContext) => Promise<DetectedCapabilityResult>> = {
  chat_stream: probeChatStream,
  tool_calling: probeToolCalling,
  max_tools: probeMaxTools,
  reasoning_effort: probeReasoningEffort,
  thinking_default: probeThinkingDefault,
  vision: probeVision,
  embeddings: probeEmbeddingsCap,
  rerank: probeRerankCap,
  typed_decisions: probeTypedDecisions,
  image_generation: probeImageGeneration,
  context_window: probeContextWindow,
  decision: probeDecision,
};

/** The decision model's own group — never part of PROBE_GROUPS (a chat model never runs it). */
const DECISION_PROBE_GROUP: DetectCapability[] = ['decision'];

/** Run one probe under its own guard: a throw or a hang becomes an ok:false row.
 * The image_generation probe carries its own budget (imageProbeTimeoutMs, 180 s
 * since ticket 61d33af9 — real image backends take ~118 s at the default shape),
 * so its outer guard is the budget + grace, not the 20 s chat-probe cap.
 * Ticket bd51693b (04c8ffd1 follow-up): the entry's own imageTimeoutMs raises
 * the guard with it — the inner probe already budgets for it (review B1), so
 * the outer guard must not cut a probe the inner budget still allows to run:
 * the Detect dialog reported a 5-min backend "failed" at 185 s against its own
 * raised budget. Mirrors the model-roles Test button (d6b60a528 B1). */
async function runProbe(cap: DetectCapability, ctx: ProbeContext): Promise<DetectedCapabilityResult> {
  const t0 = Date.now();
  try {
    const entryImageTimeoutMs = ctx.entry.imageTimeoutMs && ctx.entry.imageTimeoutMs > 0 ? ctx.entry.imageTimeoutMs : undefined;
    const imageBudget = cap === 'image_generation'
      ? Math.max((await import('../image-generate')).imageProbeTimeoutMs(), entryImageTimeoutMs ?? 0) + 5_000
      : DETECT_PROBE_TIMEOUT_MS + 5_000;
    return await withTimeout(PROBES[cap](ctx), imageBudget, `the ${cap} probe`);
  } catch (err: any) {
    return row(cap, t0, { ok: false, value: null, evidence: redact(String(err?.message || err || 'probe failed'), ctx.apiKey) });
  }
}

/** The whole suite for one model — groups in sequence, probes inside a group in parallel. */
export async function runModelProbes(ctx: ProbeContext, caps: readonly DetectCapability[]): Promise<DetectedCapabilityResult[]> {
  const want = new Set(caps);
  const results: DetectedCapabilityResult[] = [];
  // The decision probe is its own group: detectEndpointCapabilities narrows a decision
  // model's caps to it and strips it from a chat model's, so each model runs one side.
  for (const group of [...PROBE_GROUPS, DECISION_PROBE_GROUP]) {
    const picked = group.filter((c) => want.has(c));
    if (!picked.length) continue;
    results.push(...await Promise.all(picked.map((c) => runProbe(c, ctx))));
  }
  return results;
}

// ── Applying the verdicts (pure) ─────────────────────────────────────────────

const FLAG_FIELDS = ['maxTools', 'reasoningEffort', 'thinking', 'vision', 'matryoshka', 'decision', 'image', 'contextWindow', 'kind', 'providerClass'] as const;
type FlagField = typeof FLAG_FIELDS[number];

/**
 * Apply detection results to a model entry — PURE. Returns the COMPLETE next
 * entry (a flag detection cleared is absent) and the list of "field=value"
 * changes. A field named in entry.manualFlags is never touched. `capabilities`
 * always carries this run's rows.
 */
export function applyDetectionToEntry(entry: EndpointModelEntry, results: DetectedCapabilityResult[], detectedAt: string = nowIso()): { entry: EndpointModelEntry; changed: string[] } {
  const manual = new Set((entry.manualFlags ?? []).map((f) => String(f)));
  const next: EndpointModelEntry = { ...entry };
  const changed: string[] = [];
  const get = (c: DetectCapability) => results.find((r) => r.capability === c && r.ok && !r.skipped);
  const before = (f: FlagField) => JSON.stringify((entry as any)[f] ?? null);
  const set = (f: FlagField, value: unknown) => {
    if (manual.has(f)) return;
    if (value === undefined || value === null || value === false) delete (next as any)[f];
    else (next as any)[f] = value;
    const after = JSON.stringify((next as any)[f] ?? null);
    if (after !== before(f)) changed.push(`${f}=${(next as any)[f] === undefined ? 'unset' : String((next as any)[f])}`);
  };

  const maxTools = get('max_tools');
  if (typeof maxTools?.value === 'number' && maxTools.value > 0 && maxTools.value < 200) set('maxTools', Math.floor(maxTools.value));

  const effort = get('reasoning_effort');
  if (effort?.value === 'supported' || effort?.value === 'unsupported') set('reasoningEffort', effort.value);

  // thinking:'off' is only ever SET (the directive proved to switch reasoning
  // off); a model that does not think by default keeps whatever the admin set.
  const thinking = get('thinking_default');
  if (thinking?.value === true && thinking.evidence.startsWith(THINKING_DIRECTIVE_HONOURED)) set('thinking', 'off');

  // A 4xx on the image part is deterministic — vision is set OR cleared.
  const vision = get('vision');
  if (typeof vision?.value === 'boolean') set('vision', vision.value);

  const emb = get('embeddings');
  if (emb && typeof emb.value === 'number') {
    if (emb.evidence.includes(MATRYOSHKA_TRUNCATED_MARK)) set('matryoshka', true);
  }

  const chat = get('chat_stream');
  const tools = get('tool_calling');
  const chatCapable = (chat && (chat.value === 'json' || chat.value === 'raw_text')) || tools?.value === true;

  // decision: set on a parsed answers envelope; cleared only when the same run
  // proved the model is a CHAT model (a chat model must never carry the flag —
  // decision-gate would route typed questions to it).
  const decision = get('typed_decisions');
  if (decision?.value === true) set('decision', 'systemone_chat');
  else if (decision?.value === false && chatCapable) set('decision', undefined);

  // image: only ever SET (a failed generation may be the provider's bad minute).
  const image = get('image_generation');
  if (image?.value === true) set('image', true);

  const cw = get('context_window');
  if (typeof cw?.value === 'number' && cw.value > 0) set('contextWindow', Math.floor(cw.value));

  // 2026-09-28: the decision model's own probe (the /verify call) — a parsed envelope
  // pins kind 'decision'; it never touches the `decision` flag (the admin's flag or the
  // endpoint shape is what routed the model here in the first place).
  const decisionProbe = get('decision');

  let kind: EndpointModelKind | null = null;
  if (chatCapable) kind = 'chat';
  else if (decision?.value === true || decisionProbe?.value === true) kind = 'decision';
  else if (image?.value === true) kind = 'image';
  else if (emb && typeof emb.value === 'number') kind = 'embeddings';
  else if (get('rerank')?.value === true) kind = 'rerank';
  if (kind) set('kind', kind);

  if (!entry.providerClass) set('providerClass', providerClassForModelId(entry.id));

  next.capabilities = { detectedAt, results: results.map((r) => ({ ...r })) };
  return { entry: next, changed };
}

// ── Orchestration ────────────────────────────────────────────────────────────

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

/** The DetectCapability subset a request asked for (unknown names dropped; empty = all). */
export function selectCapabilities(requested: string[] | undefined): DetectCapability[] {
  const known = new Set<string>(DETECT_CAPABILITIES);
  const picked = (requested ?? []).map((c) => String(c).trim()).filter((c) => known.has(c)) as DetectCapability[];
  return picked.length ? [...new Set(picked)] : [...DETECT_CAPABILITIES];
}

export async function detectEndpointCapabilities(endpointId: string, opts: DetectOptions = {}): Promise<DetectEndpointResult> {
  const rowData = await prisma.modelEndpoint.findUnique({ where: { id: endpointId } });
  if (!rowData) throw new AppError(404, 'Model endpoint not found');
  const models = (Array.isArray(rowData.models) ? (rowData.models as unknown as EndpointModelEntry[]) : []).filter((m) => m && typeof m.id === 'string' && m.id);
  const modelId = typeof opts.modelId === 'string' ? opts.modelId.trim() : '';
  const targets = modelId ? models.filter((m) => m.id === modelId) : models;
  if (modelId && !targets.length) throw new AppError(400, `Model "${modelId.slice(0, 300)}" is not registered on endpoint "${rowData.label}".`);
  if (!targets.length) throw new AppError(400, 'The endpoint has no models to detect.');
  let apiKey: string | null = null;
  if (rowData.apiKeyEnc) {
    try { apiKey = decryptValue(rowData.apiKeyEnc); } catch {
      throw new AppError(400, 'Stored API key no longer decrypts (JWT_SECRET drift?) — re-enter it before detecting capabilities.');
    }
  }
  const caps = selectCapabilities(opts.capabilities);
  const detectedAt = nowIso();
  const baseUrl = String(rowData.baseUrl).replace(/\/+$/, '');
  logger.info(`capability-detect: "${rowData.label}" — ${targets.length} model(s), ${caps.length} probe(s) each, ≤${DETECT_MAX_CONCURRENT_MODELS} models in flight`);

  const reports = await mapWithConcurrency(targets, DETECT_MAX_CONCURRENT_MODELS, async (entry): Promise<DetectedModelReport> => {
    const ctx: ProbeContext = {
      baseUrl,
      chatUrl: `${baseUrl}/chat/completions`,
      apiKey,
      model: entry.id,
      spec: `${rowData.label}:${entry.id}`,
      entry,
      signals: {},
      providerShape: String(rowData.providerShape || ''),
    };
    // 2026-09-28 (owner: "when I try and test laya endpoint in endpoint ui it errors"):
    // a DECISION model runs ONLY the typed-decision probe (the /verify call) — the chat
    // probes 500 on a typed-decision proxy ("'coroutine' object is not an iterator" from
    // LiteLLM → Laya) and mean nothing there; a chat model never runs it.
    const decisionModel = isDecisionModelEntry(entry, rowData.providerShape);
    const entryCaps: DetectCapability[] = decisionModel
      ? [...DECISION_MODEL_CAPABILITIES]
      : caps.filter((c) => c !== 'decision');
    if (decisionModel) logger.info(`capability-detect: ${ctx.spec} is a typed-decision model — chat probes skipped, decision probe only`);
    const results = await runModelProbes(ctx, entryCaps);
    const applied = applyDetectionToEntry(entry, results, detectedAt);
    let saved: EndpointModelEntry = applied.entry;
    try {
      saved = await applyModelDetection(rowData.id, entry.id, applied.entry);
    } catch (err: any) {
      logger.warn(`capability-detect: "${ctx.spec}" — results not persisted (${err?.message}); returning the in-memory entry`);
    }
    logger.info(`capability-detect: ${ctx.spec} — ${results.length} probes, ${applied.changed.length} changed${applied.changed.length ? ` (${applied.changed.join(', ')})` : ''}`);
    return { id: entry.id, detectedAt, results, entry: saved, changed: applied.changed };
  });

  return { endpointId: rowData.id, label: rowData.label, detectedAt, models: reports };
}

export type { DetectCapability };

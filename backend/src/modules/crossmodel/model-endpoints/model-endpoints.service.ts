/**
 * Digby Edge (Phase 2) — custom model endpoint registry.
 *
 * Lets an admin point a Digby instance (esp. self-hosted) at any
 * OpenAI-compatible model server (Ollama, vLLM, LM Studio, OpenRouter,
 * llama.cpp) alongside the built-in providers. A registry model is addressed
 * as `<label>:<modelId>` and resolves (coding/coding-model.ts) to
 * `<baseUrl>/chat/completions` with the decrypted key.
 *
 * Security model (mirrors coding/credentials.service.ts):
 *  - API keys are AES-256-GCM encrypted at rest via the credentials.service
 *    helpers (key derived from JWT_SECRET) and are NEVER returned by any API
 *    response — list/get responses carry a `hasApiKey` boolean only.
 *  - v1 supports ONLY providerShape 'openai_chat'; anything else is a clear
 *    400 (the shape column exists so future shapes don't need a migration).
 *  - Labels are lowercase [a-z0-9-_] with no ':' — a label prefixes the
 *    '<label>:<modelId>' run-model spec, so ':' in a label would make specs
 *    unparseable. Uniqueness is per owner (NULL owner = instance-wide) and
 *    enforced HERE, not in the DB.
 *  - The connectivity check never leaks the key: errors are reduced to a
 *    status/timeout/unreachable message with any key occurrence stripped.
 *    It is also two-stage: GET /models, then — when a key is set and models
 *    were listed — a 1-token POST /chat/completions, because several providers
 *    serve /models WITHOUT auth and a green models list alone never proved
 *    the key works for the only call the run path makes (ticket e94387f6).
 *    The probe walks up to 3 listed models in order and stops at the first
 *    answer: routers like LiteLLM list routes with no live engine, so a dead
 *    first-listed model must not fail discovery while the rest answer
 *    (ticket 1dc89d48).
 *
 * Run-path cache: registry resolutions are cached in-process for 30s keyed by
 * the full '<label>:<modelId>' spec (+ userId) so a coding run hits the DB at
 * most twice a minute. Mutations clear the cache immediately; TTL alone would
 * also converge (a fresh worker/container starts empty anyway).
 */

import axios from 'axios';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import { encryptValue, decryptValue } from '../coding/credentials.service';
import { resolveMaxTools, isProviderClass, type ProviderClass as VendorProviderClass } from '../coding/provider-limits';
// Two DIFFERENT classes share the word (wave/final merge 2026-09-27): the VENDOR
// class (provider-limits — drives the tool cap: openai / moonshot / deepseek / …)
// and the GOVERNANCE class (provider-class — 'frontier' | 'open', audit E3 seat
// badges). Each field below is typed by its meaning.
import { endpointProviderClass, modelProviderClass, type ProviderClass as GovernanceProviderClass } from './provider-class';

export const PROVIDER_SHAPE_OPENAI_CHAT = 'openai_chat';
/** A TypeSafe-compatible DECISION server (POST <baseUrl>/systemone, GET
 *  <baseUrl>/models): TypeSafe Jev itself, or a self-hosted JevK5 / NeoHorse-
 *  Jev / Kev / Laya server. Assignable ONLY to the Decision gate seat
 *  (model-roles.service assertAssignable); the chat/coding run path never
 *  resolves it (resolveProviderForRun requires [coding], which this shape's
 *  models never carry). 2026-09-24. */
export const PROVIDER_SHAPE_SYSTEMONE = 'systemone';
/** A LiteLLM-style TYPED-DECISION PROXY (2026-09-26, Laya follow-up): the same
 *  systemone REQUEST semantics carried over an OpenAI chat route — POST
 *  <baseUrl>/chat/completions with `{ model, messages:[{role:'user', content:
 *  <state text>}], questions }`; the answer map rides back as a JSON STRING in
 *  `choices[0].message.content` (`{ model, result:{ model, answers, usage } }`).
 *  Live-probed on llm.cql.ca (`agx-laya`): `/v1/systemone` 404s there and a
 *  chat call with logprobs 400s ("a typed-decision model, not a chat model").
 *  Assignable ONLY to the Decision gate seat (like 'systemone'); the chat /
 *  coding run path never resolves it. GET <baseUrl>/models is served. */
export const PROVIDER_SHAPE_SYSTEMONE_CHAT = 'systemone_chat';
export const PROVIDER_SHAPES: readonly string[] = [PROVIDER_SHAPE_OPENAI_CHAT, PROVIDER_SHAPE_SYSTEMONE, PROVIDER_SHAPE_SYSTEMONE_CHAT];
/** The DECISION shapes: a TypeSafe-compatible /systemone server or the typed-decision chat proxy. */
export const DECISION_PROVIDER_SHAPES: readonly string[] = [PROVIDER_SHAPE_SYSTEMONE, PROVIDER_SHAPE_SYSTEMONE_CHAT];
/** True for a providerShape the decision gate drives with its systemone client (either transport). */
export function isDecisionProviderShape(shape: unknown): boolean {
  return typeof shape === 'string' && DECISION_PROVIDER_SHAPES.includes(shape);
}
/** Lowercase alnum + - _ (no ':' — it is the label/modelId separator). */
export const ENDPOINT_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TEST_TIMEOUT_MS = 5000;
/**
 * Max models the completion-auth probe walks, in listed order, before giving
 * up (ticket 1dc89d48). Bounded so a fully-dead server fails the check in
 * ≤ PROBE_MAX_ATTEMPTS × TEST_TIMEOUT_MS, plus at most ONE typed-decision
 * re-probe (15 s hard deadline, ticket 2df5ed65) — the whole check stays
 * ≤ ~35 s wall clock, safely under the frontend client's 45 s API timeout
 * (reviewer B2: unbounded rescues could reach 60 s and a healthy-but-slow
 * endpoint rendered broken — the ticket's own symptom, reintroduced).
 */
const PROBE_MAX_ATTEMPTS = 3;
const REGISTRY_CACHE_TTL_MS = 30_000;

export interface EndpointModelEntry {
  id: string;
  displayName?: string;
  vision?: boolean;
  coding?: boolean;
  /** MRL-trained embedding model (Qwen3-Embedding, text-embedding-3, nomic
   *  v1.5…): when the server returns MORE than 1536 dims, Digby truncates to
   *  the leading 1536 + L2-normalizes — the standard Matryoshka operation, and
   *  what DashScope does server-side for `dimensions`. Never applied unflagged
   *  (truncating a non-MRL vector silently corrupts retrieval). */
  matryoshka?: boolean;
  /** 'off' = send the thinking-disable directive on every call to this model
   *  (vLLM/SGLang/Qwen convention chat_template_kwargs.enable_thinking=false).
   *  Default-thinking models on the non-streaming Helper/Utility seats spend
   *  their whole token budget reasoning and return EMPTY content otherwise. */
  thinking?: 'default' | 'off';
  /** 2026-09-24: serves an OpenAI-compatible POST <baseUrl>/images/generations
   *  ({model, prompt, size 'WxH', n, response_format 'b64_json'} → data[0]
   *  .b64_json or .url) — the ONLY registry models the Image generator seat
   *  accepts (model-roles.service assertAssignable; runtime image-generate.ts).
   *  Meaningless on the chat/coding run path. */
  image?: boolean;
  /** 2026-10-23 (ticket 04c8ffd1): per-model image-generation timeout in ms for
   *  [image]-flagged registry models. Local/self-hosted image backends (a
   *  Qwen-Image stack behind LiteLLM) legitimately take 5-10 min per generation;
   *  the shipped 120 s custom-leg cap hard-died mid-generation. Clamped
   *  [IMAGE_MODEL_TIMEOUT_MIN_MS, IMAGE_MODEL_TIMEOUT_MAX_MS] on save; absent =
   *  the IMAGE_CUSTOM_TIMEOUT_MS env, else the 120 s default. Read by
   *  image-generate.ts legForSpec. Meaningless on non-image models. */
  imageTimeoutMs?: number;
  /** 2026-10-25 (todo 87b020c4, owner ruling oq_7af5537b): per-model BASE-URL
   *  override for the images route of an [image]-flagged model — the image leg
   *  posts to <imagesUrl>/images/generations (and derives its async job polls
   *  from it) INSTEAD of the endpoint's baseUrl. It is a BASE: it must carry
   *  the SAME path prefix the endpoint's baseUrl carries (llm-cql's baseUrl is
   *  https://llm.cql.ca/v1, so its tailnet form is http://100.64.0.1:4001/v1
   *  — the bare host would post to /images/generations and 404). Purpose: send
   *  the LONG-RUNNING image class over a direct private path while chat traffic
   *  keeps baseUrl (Cloudflare). http is allowed on purpose — the override
   *  targets private/encrypted links (tailnet WireGuard), never the public
   *  internet. Normalized on save (trim, trailing slash stripped, a pasted
   *  full route URL folds back to its base, http(s) URL-parse — garbage is
   *  DROPPED, house style, the save never fails); absent = the endpoint's
   *  baseUrl (the documented fallback: clear the field and the seat reverts).
   *  Read by image-generate.ts legForSpec. Meaningless on non-image models. */
  imagesUrl?: string;
  /** 2026-09-26 (decision backends): the admin asserts this server returns
   *  CALIBRATED probabilities. Without it a registry decision backend (a
   *  systemone server or a logprob readout) is uncalibrated until the
   *  readiness job fits a temperature for it — an act purpose then never
   *  acts on its answers (decision-gate.ts isCalibratedBackend). */
  calibrated?: boolean;
  /** 2026-09-26 (decision backends): per-backend state cap in characters
   *  (Laya's 512-token window ≈ 1,200 chars; JevK5 / openjev 16k tokens). The
   *  gate cuts the state at min(this, DECISION_STATE_MAX_CHARS) and stamps
   *  meta.stateTruncated. Meaningless on the chat/coding run path. */
  maxStateChars?: number;
  /** 2026-09-28 (decision-gate spend rows): the price this endpoint's model bills
   *  at, USD per 1M input / output tokens. Unset = the endpoint's
   *  settings.usdPerMTokIn/Out, else $0 badged "self-hosted" in API costs
   *  (never a silent list-price guess). Read by the decision gate today. */
  usdPerMTokIn?: number;
  usdPerMTokOut?: number;
  /** 2026-09-26 (Laya follow-up): THIS model on an OpenAI-compatible endpoint is
   *  a TYPED-DECISION model served through /chat/completions — LiteLLM fronting
   *  Laya (llm.cql.ca `agx-laya`, registered in prod under the `cql-litellm`
   *  endpoint next to 36 chat / embedding ids). The decision gate then calls it
   *  with the `systemone_chat` transport (the questions map in the body, the
   *  JSON answers envelope in the message content) instead of the logprob
   *  readout, which that proxy 400s ("a typed-decision model, not a chat
   *  model"). The DOCUMENTED way to register Laya-via-LiteLLM; the dedicated
   *  PROVIDER_SHAPE_SYSTEMONE_CHAT endpoint shape is the alternative for a
   *  proxy that serves only decision models. Meaningless on the chat/coding
   *  run path; never flag a chat model. Pair it with maxStateChars ≈ 3800 (the
   *  proxy silently cuts the state at 1,024 input tokens). */
  decision?: 'systemone_chat';
  // ── 2026-09-27 seat/provider limits (owner incident: the Fleet Supervisor on
  //    `cql-litellm:api-openai-gpt-6-astra` 400'd every turn — 195 tools on a
  //    128-tool OpenAI cap, then reasoning_effort injected by the proxy). ──
  /** Per-model TOOL cap (tools array length the server accepts). Unset = the
   *  endpoint's settings.maxTools, else the provider-class default (OpenAI-like
   *  ids → 128), else unlimited. The run path TRIMS the tool list to it
   *  (coding/provider-limits.ts). Admin-set or written by Detect capabilities. */
  maxTools?: number;
  /** Does the model accept `reasoning_effort` / `thinking` on /chat/completions
   *  with tools? 'supported' = the seat's effort flows through; 'unsupported' /
   *  'auto' (default) = OMITTED for custom endpoints (a proxy that injects one
   *  is retried once with reasoning_effort:'none', then latched). */
  reasoningEffort?: 'supported' | 'unsupported' | 'auto';
  /** Admin override of the provider-class heuristic (provider-limits.ts
   *  providerClassForModelId) — drives the class default tool cap. */
  providerClass?: VendorProviderClass;
  /** What the model IS. Unset = derived: explicit `coding`/`image`/`decision`
   *  flags, then the last detection, then an id heuristic (embed/rerank/asr/tts/
   *  image), else 'chat'. Only 'chat' models are seat-assignable to the chat /
   *  agent / coding seats (the legacy [coding] flag reads true for them). */
  kind?: EndpointModelKind;
  /** Context window in TOKENS from /models metadata when the server publishes
   *  one (context_length / max_model_len / context_window); blank otherwise.
   *  Sizes the run's transcript budget for this model. */
  contextWindow?: number;
  /** Last "Detect capabilities" run for this model (capability-detect.ts):
   *  one result row per probed capability with the evidence line + timestamp.
   *  Detection SETS the flags above; `manualFlags` names the ones the admin
   *  overrode by hand, which a re-detect never overwrites. */
  capabilities?: DetectedCapabilities;
  manualFlags?: string[];
  /** 2026-10-06 (f90 follow-up, owner 2026-09-18 route teardown): the entry is
   *  RETIRED — listed for provenance but never served. The gateway route was
   *  torn down (canlegal-bench benchmark done), so every call 400s
   *  "Invalid model name" (a deterministic rejection the retry lanes cannot
   *  fix — agent.ts CAPABILITY_REJECTION_RE fails fast on it). A retired entry
   *  stops resolving here (resolveRegistryModel → null), so seats fall back to
   *  their built-in + badge `resolves:false`, the catalog card goes
   *  servable:false, and no automatic pick ever routes to it. Admin-set via the
   *  Endpoints editor's "retired" chip. NEVER touched by detection (not a
   *  FLAG_FIELD) and never auto-cleared — un-retiring is a human decision. */
  unservable?: boolean;
}

export type EndpointModelKind = 'chat' | 'embeddings' | 'rerank' | 'asr' | 'tts' | 'image' | 'decision';
export const ENDPOINT_MODEL_KINDS: readonly EndpointModelKind[] = ['chat', 'embeddings', 'rerank', 'asr', 'tts', 'image', 'decision'];

// 2026-10-23 (ticket 04c8ffd1): the save-time clamp for a per-model image
// generation timeout (EndpointModelEntry.imageTimeoutMs). The MAX stays
// strictly under the agent tool's 15-min hard race (TOOL_HARD_TIMEOUT_MS,
// coding/agent.ts) so the tool's own ceiling is never what kills the call.
export const IMAGE_MODEL_TIMEOUT_MIN_MS = 30_000;
export const IMAGE_MODEL_TIMEOUT_MAX_MS = 720_000; // 12 min — leaves the whole-call budget (≤780 s) real margin under the agent tool's 15-min hard race (review B2: 780+840 left only 60 s for setup+storage)

export type DetectCapability =
  | 'chat_stream' | 'tool_calling' | 'max_tools' | 'reasoning_effort' | 'thinking_default'
  | 'vision' | 'embeddings' | 'rerank' | 'typed_decisions' | 'image_generation' | 'context_window'
  /** 2026-09-28: the ONLY probe a DECISION model gets (a model flagged decision:'systemone_chat',
   *  kind 'decision', or on a decision-shaped endpoint) — the same typed-decision call /verify
   *  makes; the chat probes are not applicable and are never sent (they 500 on LiteLLM → Laya). */
  | 'decision';
export const DETECT_CAPABILITIES: readonly DetectCapability[] = [
  'chat_stream', 'tool_calling', 'max_tools', 'reasoning_effort', 'thinking_default',
  'vision', 'embeddings', 'rerank', 'typed_decisions', 'image_generation', 'context_window',
  'decision',
];

export interface DetectedCapabilityResult {
  capability: DetectCapability;
  /** The probe ran to a verdict (false = the probe itself failed / was skipped — `evidence` says why). */
  ok: boolean;
  /** The detected value: boolean for yes/no capabilities, a number for max_tools /
   *  context_window / embedding dims, a string for shapes ('json' | 'raw_text',
   *  'supported' | 'unsupported'), null when undetermined. */
  value: boolean | number | string | null;
  /** One line a human reads — what was sent, what came back. Key-scrubbed. */
  evidence: string;
  latencyMs: number;
  /** ISO timestamp of this probe. */
  at: string;
  /** True when the probe was skipped on purpose (e.g. image generation on a non-image id). */
  skipped?: boolean;
}

export interface DetectedCapabilities {
  detectedAt: string;
  results: DetectedCapabilityResult[];
}

/** Endpoint-level settings (row column `settings`, JSONB, 2026-09-27). */
export interface EndpointSettings {
  /** Tool cap for EVERY model on this endpoint that has no per-model cap
   *  (a proxy fronting one provider family). */
  maxTools?: number;
  /** 2026-09-28 (decision-gate spend rows): the endpoint-wide price, USD per 1M
   *  input / output tokens, for every model without its own usdPerMTokIn/Out.
   *  Unset = $0 badged "self-hosted" in API costs. */
  usdPerMTokIn?: number;
  usdPerMTokOut?: number;
}

/** The API shape — apiKeyEnc is NEVER part of it. */
export interface ModelEndpointSummary {
  id: string;
  ownerUserId: string | null;
  label: string;
  providerShape: string;
  baseUrl: string;
  hasApiKey: boolean;
  models: EndpointModelEntry[];
  settings: EndpointSettings;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** 2026-09-27 (audit E3, seat governance): the endpoint's class from its HOST
   *  ('frontier' = a frontier vendor's own API host). Derived on read, never
   *  stored — provider-class.ts. */
  providerClass: GovernanceProviderClass;
  /** The listed model ids whose id-or-host class is 'frontier' (a proxy that
   *  lists `api-anthropic-claude-…` next to open-weight ids). Empty on an
   *  open endpoint with open ids. The admin UI badges these. */
  frontierModelIds: string[];
}

export interface EndpointInput {
  label: string;
  providerShape: string;
  baseUrl: string;
  apiKey?: string;
  models: EndpointModelEntry[];
  settings?: EndpointSettings | null;
  enabled?: boolean;
}

function summarize(r: any): ModelEndpointSummary {
  const models: EndpointModelEntry[] = Array.isArray(r.models) ? r.models : [];
  return {
    id: r.id,
    ownerUserId: r.ownerUserId ?? null,
    label: r.label,
    providerShape: r.providerShape,
    baseUrl: r.baseUrl,
    hasApiKey: !!r.apiKeyEnc,
    models,
    settings: validateSettings(r.settings),
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    providerClass: endpointProviderClass(r.baseUrl),
    frontierModelIds: models
      .filter(m => m?.id && modelProviderClass(r.baseUrl, m.id) === 'frontier')
      .map(m => m.id),
  };
}

/** Validate + normalize the label. Throws AppError(400) with a clear message. */
function normalizeLabel(raw: string): string {
  const label = String(raw || '').trim().toLowerCase();
  if (!ENDPOINT_LABEL_RE.test(label)) {
    throw new AppError(400, 'Label must be 1-64 chars: lowercase letters, digits, dashes, underscores (starting with a letter or digit). It prefixes models as "<label>:<modelId>".');
  }
  return label;
}

function validateShape(shape: string): string {
  const s = String(shape || '').trim();
  if (!PROVIDER_SHAPES.includes(s)) {
    throw new AppError(400, `providerShape "${shape}" is not supported — use "${PROVIDER_SHAPE_OPENAI_CHAT}" (OpenAI-compatible /chat/completions), "${PROVIDER_SHAPE_SYSTEMONE}" (TypeSafe-compatible decision server: POST /systemone) or "${PROVIDER_SHAPE_SYSTEMONE_CHAT}" (a typed-decision proxy such as LiteLLM serving Laya: POST /chat/completions with a questions map, JSON answers in the message content).`);
  }
  return s;
}

/** Validate http(s) URL and store WITHOUT a trailing slash. */
export function normalizeBaseUrl(raw: string): string {
  const s = String(raw || '').trim();
  let u: URL;
  try { u = new URL(s); } catch {
    throw new AppError(400, `baseUrl "${s.slice(0, 80)}" is not a valid URL — expected something like http://192.168.1.50:11434/v1.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AppError(400, `baseUrl must be http:// or https:// (got "${u.protocol}//").`);
  }
  return s.replace(/\/+$/, '');
}

function validateModels(models: EndpointModelEntry[]): EndpointModelEntry[] {
  if (!Array.isArray(models) || !models.length) {
    throw new AppError(400, 'At least one model is required.');
  }
  const seen = new Set<string>();
  const out: EndpointModelEntry[] = [];
  for (const m of models) {
    const id = String(m?.id || '').trim();
    if (!id) throw new AppError(400, 'Every model needs a non-empty id.');
    if (seen.has(id)) throw new AppError(400, `Duplicate model id "${id}".`);
    seen.add(id);
    const entry: EndpointModelEntry = { id };
    if (m.displayName) entry.displayName = String(m.displayName).trim().slice(0, 200);
    if (m.vision === true) entry.vision = true;
    if (m.coding === true) entry.coding = true;
    // Whitelist copy — a flag missing here is silently dropped on save.
    if (m.matryoshka === true) entry.matryoshka = true;
    if (m.thinking === 'off') entry.thinking = 'off';
    if (m.image === true) entry.image = true;
    // 2026-10-23 (04c8ffd1): per-model image timeout, clamped on save (house style: normalize, never reject the whole save).
    if (typeof m.imageTimeoutMs === 'number' && Number.isFinite(m.imageTimeoutMs) && m.imageTimeoutMs > 0) {
      entry.imageTimeoutMs = Math.min(IMAGE_MODEL_TIMEOUT_MAX_MS, Math.max(IMAGE_MODEL_TIMEOUT_MIN_MS, Math.floor(m.imageTimeoutMs)));
    }
    // 2026-10-25 (todo 87b020c4): per-model images-route base-URL override —
    // normalize, never reject (house style): trim, trailing-slash strip, and a
    // pasted FULL route URL ('…/images/generations') folds back to its base —
    // the field is a BASE (the leg appends the route; a doubled suffix would
    // 404 every call and mis-derive the async job poll); http(s) URL-parse;
    // garbage is dropped silently.
    if (typeof m.imagesUrl === 'string') {
      const u = m.imagesUrl.trim().replace(/\/+$/, '').replace(/\/images\/generations$/i, '').replace(/\/+$/, '');
      if (u && u.length <= 2048 && /^https?:\/\//i.test(u)) {
        try { new URL(u); entry.imagesUrl = u; } catch { /* garbage — dropped */ }
      }
    }
    // 2026-09-26 decision-backend flags (whitelist copy like the others).
    if (m.calibrated === true) entry.calibrated = true;
    if (typeof m.maxStateChars === 'number' && Number.isFinite(m.maxStateChars) && m.maxStateChars > 0) entry.maxStateChars = Math.floor(m.maxStateChars);
    // 2026-09-28 decision-gate spend rows: per-model price (USD / M tokens), whitelist copy.
    if (typeof m.usdPerMTokIn === 'number' && Number.isFinite(m.usdPerMTokIn) && m.usdPerMTokIn >= 0) entry.usdPerMTokIn = m.usdPerMTokIn;
    if (typeof m.usdPerMTokOut === 'number' && Number.isFinite(m.usdPerMTokOut) && m.usdPerMTokOut >= 0) entry.usdPerMTokOut = m.usdPerMTokOut;
    if (m.decision === PROVIDER_SHAPE_SYSTEMONE_CHAT) entry.decision = PROVIDER_SHAPE_SYSTEMONE_CHAT;
    // 2026-09-27 seat/provider limits + detection (whitelist copy like the others).
    if (typeof m.maxTools === 'number' && Number.isFinite(m.maxTools) && m.maxTools > 0) entry.maxTools = Math.floor(m.maxTools);
    if (m.reasoningEffort === 'supported' || m.reasoningEffort === 'unsupported' || m.reasoningEffort === 'auto') entry.reasoningEffort = m.reasoningEffort;
    // Every class the validation admits (PROVIDER_CLASSES — widened 2026-09-27 to the four open-model vendors) survives the save.
    if (isProviderClass(m.providerClass)) entry.providerClass = m.providerClass;
    if (typeof m.kind === 'string' && (ENDPOINT_MODEL_KINDS as readonly string[]).includes(m.kind)) entry.kind = m.kind as EndpointModelKind;
    if (typeof m.contextWindow === 'number' && Number.isFinite(m.contextWindow) && m.contextWindow > 0) entry.contextWindow = Math.floor(m.contextWindow);
    const caps = sanitizeDetectedCapabilities(m.capabilities);
    if (caps) entry.capabilities = caps;
    if (Array.isArray(m.manualFlags)) {
      const flags = [...new Set(m.manualFlags.filter((f: unknown): f is string => typeof f === 'string' && !!f.trim()).map((f: string) => f.trim().slice(0, 40)))].slice(0, 32);
      if (flags.length) entry.manualFlags = flags;
    }
    // 2026-10-06 retired entries (f90 follow-up): whitelist copy — the flag survives every save.
    if (m.unservable === true) entry.unservable = true;
    out.push(entry);
  }
  return out;
}

/** Whitelist copy of a stored / submitted detection block; null when unusable. */
export function sanitizeDetectedCapabilities(raw: unknown): DetectedCapabilities | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const detectedAt = typeof r.detectedAt === 'string' && Number.isFinite(Date.parse(r.detectedAt)) ? r.detectedAt : null;
  if (!detectedAt || !Array.isArray(r.results)) return null;
  const results: DetectedCapabilityResult[] = [];
  for (const x of r.results as unknown[]) {
    if (!x || typeof x !== 'object') continue;
    const e = x as Record<string, unknown>;
    if (typeof e.capability !== 'string' || !(DETECT_CAPABILITIES as readonly string[]).includes(e.capability)) continue;
    const value = typeof e.value === 'boolean' || typeof e.value === 'number' || typeof e.value === 'string' ? e.value : null;
    results.push({
      capability: e.capability as DetectCapability,
      ok: e.ok === true,
      value: typeof value === 'string' ? value.slice(0, 200) : value,
      evidence: String(e.evidence ?? '').slice(0, 600),
      latencyMs: typeof e.latencyMs === 'number' && Number.isFinite(e.latencyMs) ? Math.max(0, Math.floor(e.latencyMs)) : 0,
      at: typeof e.at === 'string' && Number.isFinite(Date.parse(e.at)) ? e.at : detectedAt,
      ...(e.skipped === true ? { skipped: true } : {}),
    });
    if (results.length >= DETECT_CAPABILITIES.length * 2) break;
  }
  return { detectedAt, results };
}

/** Whitelist copy of the endpoint-level settings; always an object. */
export function validateSettings(raw: unknown): EndpointSettings {
  const out: EndpointSettings = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.maxTools === 'number' && Number.isFinite(r.maxTools) && r.maxTools > 0) out.maxTools = Math.floor(r.maxTools);
  if (typeof r.usdPerMTokIn === 'number' && Number.isFinite(r.usdPerMTokIn) && r.usdPerMTokIn >= 0) out.usdPerMTokIn = r.usdPerMTokIn;
  if (typeof r.usdPerMTokOut === 'number' && Number.isFinite(r.usdPerMTokOut) && r.usdPerMTokOut >= 0) out.usdPerMTokOut = r.usdPerMTokOut;
  return out;
}

const KIND_ID_HEURISTICS: Array<[RegExp, EndpointModelKind]> = [
  [/rerank/i, 'rerank'],
  [/embed/i, 'embeddings'],
  [/whisper|\basr\b|transcri|speech-to-text|stt\b|paraformer/i, 'asr'],
  [/\btts\b|text-to-speech|speech(?!-to)|cosyvoice/i, 'tts'],
  [/dall-e|flux|stable-diffusion|sdxl|cogview|imagen|z-image|wan2|qwen-image|\bimage\b/i, 'image'],
  [/\bjev\b|\blaya\b|systemone|neohorse|\bkev\b/i, 'decision'],
];

/**
 * 2026-10-06 chat-catalog leak (agx-embed / agx-rerank on the cql-litellm
 * gateway): runtime registry rows synced from a LiteLLM gateway's /v1/models
 * can carry a stored kind/coding flag that lies — the bounded id token wins
 * REGARDLESS of the flag. Bounded noun tokens only, so a real chat id never
 * matches ('bge-reranker-v2-m3' with an explicit chat kind stays chat).
 */
const NON_CHAT_ID_OVERRIDES: Array<[RegExp, EndpointModelKind]> = [
  [/(^|[-_.])(embed|embedding)([-_.]|$)/i, 'embeddings'],
  [/(^|[-_.])rerank([-_.]|$)/i, 'rerank'],
];

/** The kind a model id suggests, or null when nothing matches (chat is the default elsewhere). Pure. */
export function heuristicModelKind(id: string | undefined | null): EndpointModelKind | null {
  const s = String(id ?? '');
  if (!s) return null;
  for (const [re, kind] of KIND_ID_HEURISTICS) if (re.test(s)) return kind;
  return null;
}

/** The kind the last detection established, or null. Pure. */
export function detectedModelKind(caps: DetectedCapabilities | undefined | null): EndpointModelKind | null {
  if (!caps || !Array.isArray(caps.results)) return null;
  const get = (c: DetectCapability) => caps.results.find((r) => r.capability === c && r.ok && !r.skipped);
  if (get('chat_stream')?.value || get('tool_calling')?.value === true) return 'chat';
  if (get('typed_decisions')?.value === true) return 'decision';
  if (get('image_generation')?.value === true) return 'image';
  if (typeof get('embeddings')?.value === 'number') return 'embeddings';
  if (get('rerank')?.value === true) return 'rerank';
  return null;
}

/**
 * What the model IS (2026-09-27, owner: "coding is a seat choice, not a model
 * capability"): an explicit `kind` wins; the legacy [coding] flag asserts chat;
 * [image] / [decision] flags assert their kinds; then the last detection; then
 * the id heuristic; else 'chat'. Pure. 2026-10-06: a bounded embed/rerank id
 * token overrides the stored kind/coding flag (gateway sync rows can lie).
 */
export function modelKindOf(entry: EndpointModelEntry | undefined | null): EndpointModelKind {
  if (!entry) return 'chat';
  // Gateway sync (LiteLLM /v1/models) serves embed/rerank routes; the stored
  // kind can lie — the bounded id token wins (never matches a real chat id).
  for (const [re, kind] of NON_CHAT_ID_OVERRIDES) if (re.test(entry.id)) return kind;
  if (entry.kind && (ENDPOINT_MODEL_KINDS as readonly string[]).includes(entry.kind)) return entry.kind;
  if (entry.coding === true) return 'chat';
  if (entry.image === true) return 'image';
  if (entry.decision === PROVIDER_SHAPE_SYSTEMONE_CHAT) return 'decision';
  const detected = detectedModelKind(entry.capabilities);
  if (detected) return detected;
  return heuristicModelKind(entry.id) ?? 'chat';
}

/** Selectable for the chat / agent / coding seats (replaces the [coding] flag requirement). Pure. */
export function isChatCapableEntry(entry: EndpointModelEntry | undefined | null): boolean {
  return modelKindOf(entry) === 'chat';
}

/** 09a03aef (2026-10-24): resolve the raw registry MODEL ENTRY (not the
 *  run-shaped resolution) for a '<label>:<modelId>' spec — the seat-save
 *  validation reads the entry's own fields (imageTimeoutMs, the Detect
 *  capabilities' measured image_generation latency). Null when the spec does
 *  not resolve to an enabled entry (same match rules as resolveRegistryModel:
 *  instance-wide rows first, per-user rows only for their owner, retired
 *  entries null). Uncached — this is a rare admin-path read, never the run
 *  path. */
export async function resolveRegistryModelEntry(spec: string, userId?: string): Promise<EndpointModelEntry | null> {
  const parsed = parseRegistrySpec(spec);
  if (!parsed) return null;
  try {
    const row = await prisma.modelEndpoint.findFirst({
      where: {
        label: parsed.label,
        enabled: true,
        OR: [{ ownerUserId: null }, ...(userId ? [{ ownerUserId: userId }] : [])],
      },
      orderBy: { ownerUserId: 'asc' },
    });
    if (!row || !Array.isArray(row.models)) return null;
    const entry = (row.models as unknown as EndpointModelEntry[]).find(m => m?.id === parsed.modelId);
    if (!entry || entry.unservable === true) return null;
    return entry;
  } catch (err: any) {
    logger.warn(`model-endpoints: entry lookup failed for "${spec}": ${err?.message}`);
    return null;
  }
}

async function assertLabelFree(label: string, ownerUserId: string | null, excludeId?: string): Promise<void> {
  const clash = await prisma.modelEndpoint.findFirst({
    where: { label, ownerUserId, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (clash) {
    throw new AppError(409, `An endpoint labeled "${label}" already exists${ownerUserId ? '' : ' (instance-wide)'} — labels must be unique per owner.`);
  }
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listEndpoints(): Promise<ModelEndpointSummary[]> {
  const rows = await prisma.modelEndpoint.findMany({ orderBy: [{ label: 'asc' }] });
  return rows.map(summarize);
}

/** One endpoint by id, sanitized exactly like listEndpoints rows (hasApiKey,
 *  NEVER the key). Null when unknown — the verify route 404s on it and needs
 *  the label + model list to build the '<label>:<modelId>' spec. */
export async function getEndpoint(id: string): Promise<ModelEndpointSummary | null> {
  const row = await prisma.modelEndpoint.findUnique({ where: { id } });
  return row ? summarize(row) : null;
}

export async function createEndpoint(input: EndpointInput): Promise<ModelEndpointSummary> {
  const providerShape = validateShape(input.providerShape);
  const label = normalizeLabel(input.label);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const models = validateModels(input.models);
  const apiKey = String(input.apiKey || '').trim();
  await assertLabelFree(label, null); // v1: instance-wide only
  // `as any` on the data object (2026-09-27): the `settings` column landed with
  // migration 20260927150000 — a Prisma client generated from an older schema
  // (another checkout sharing node_modules) must not break the type-check.
  const createData: any = {
    ownerUserId: null,
    label,
    providerShape,
    baseUrl,
    apiKeyEnc: apiKey ? encryptValue(apiKey) : null,
    models: models as any,
    settings: validateSettings(input.settings) as any,
    enabled: input.enabled !== false,
  };
  const row = await prisma.modelEndpoint.create({ data: createData });
  clearRegistryModelCache();
  logger.info(`model-endpoints: created "${label}" (${models.length} model(s), key=${apiKey ? 'set' : 'none'})`);
  return summarize(row);
}

export async function updateEndpoint(id: string, patch: Partial<EndpointInput>): Promise<ModelEndpointSummary> {
  const existing = await prisma.modelEndpoint.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'Model endpoint not found');
  const data: any = {};
  if (patch.providerShape !== undefined) data.providerShape = validateShape(patch.providerShape);
  if (patch.label !== undefined) {
    const label = normalizeLabel(patch.label);
    await assertLabelFree(label, existing.ownerUserId ?? null, id);
    data.label = label;
  }
  if (patch.baseUrl !== undefined) data.baseUrl = normalizeBaseUrl(patch.baseUrl);
  if (patch.models !== undefined) data.models = validateModels(patch.models) as any;
  if (patch.settings !== undefined) data.settings = validateSettings(patch.settings) as any;
  if (patch.enabled !== undefined) data.enabled = patch.enabled === true;
  if (patch.apiKey !== undefined) {
    // Patch semantics: '' clears the key; a value re-encrypts; omitted = untouched.
    const k = patch.apiKey.trim();
    data.apiKeyEnc = k ? encryptValue(k) : null;
  }
  const row = await prisma.modelEndpoint.update({ where: { id }, data });
  clearRegistryModelCache();
  logger.info(`model-endpoints: updated "${row.label}" (${Object.keys(data).join(', ') || 'no-op'})`);
  return summarize(row);
}

export async function deleteEndpoint(id: string): Promise<boolean> {
  const r = await prisma.modelEndpoint.deleteMany({ where: { id } });
  if (r.count > 0) {
    clearRegistryModelCache();
    logger.info(`model-endpoints: deleted ${id.slice(0, 8)}`);
  }
  return r.count > 0;
}

// ── Connectivity check ───────────────────────────────────────────────────────

export interface EndpointTestResult {
  ok: boolean;
  models?: string[];
  error?: string;
  /** Human detail from a successful probe (the systemone check reports the sanity answers). */
  detail?: string;
  /**
   * POST /chat/completions auth probe outcome — present ONLY when the probe
   * ran (an API key is set AND the /models list was non-empty). 'failed'
   * always comes with ok:false + a distinct error: GET /models is served
   * without auth by several providers (OpenRouter, some vLLM/Ollama proxies),
   * so a green models list alone never proved the key (ticket e94387f6).
   */
  completionAuth?: 'ok' | 'failed';
  /**
   * The listed model that answered the completion-auth probe — present ONLY
   * when the probe fell back past earlier listed model(s) (ticket 1dc89d48).
   * Omitted when the first-listed model answered (the common healthy case),
   * keeping that success shape byte-identical. Tells the admin their server's
   * list order hides a dead/slow route.
   */
  probedModel?: string;
}

/** Error text safe to show an admin: never carries the endpoint's API key. */
function safeTestError(err: any, apiKey: string | null): string {
  const status = err?.response?.status;
  let msg = status
    ? `HTTP ${status}${err?.response?.statusText ? ` ${err.response.statusText}` : ''}`
    : err?.code === 'ECONNABORTED' || /timeout/i.test(String(err?.message || ''))
      ? `Timed out after ${TEST_TIMEOUT_MS / 1000}s`
      : `Unreachable (${err?.code || err?.message || 'connection failed'})`;
  if (apiKey) msg = msg.split(apiKey).join('•••');
  return msg;
}

/** GET <baseUrl>/models (5s timeout). Throws on failure — callers wrap with safeTestError. */
async function fetchRemoteModelIds(baseUrl: string, apiKey: string | null): Promise<string[]> {
  const resp = await axios.get(`${baseUrl}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    timeout: TEST_TIMEOUT_MS,
  });
  return Array.isArray(resp.data?.data)
    ? resp.data.data.map((m: any) => String(m?.id || '')).filter(Boolean)
    : [];
}

/**
 * POST <baseUrl>/chat/completions with a 1-token request against ONE listed
 * model (5s timeout) — proves the key is valid for the ONLY call the run path
 * ever makes. Throws on failure — callers wrap with safeTestError.
 */
async function probeCompletionAuth(baseUrl: string, apiKey: string, model: string): Promise<void> {
  await axios.post(`${baseUrl}/chat/completions`, {
    model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false,
  }, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: TEST_TIMEOUT_MS,
  });
}

/**
 * Distinct, key-safe message for a failed completion probe: the models list
 * already succeeded, so say that explicitly — the failure is specific to the
 * call the run path actually makes (ticket e94387f6).
 */
function completionAuthError(err: any, apiKey: string | null): string {
  const status = err?.response?.status;
  const hint = (status === 401 || status === 403) ? ' — check the key' : '';
  return `models list OK, but POST /chat/completions failed: ${safeTestError(err, apiKey)}${hint}`;
}

/**
 * All-probes-failed message for the bounded fallback (ticket 1dc89d48): every
 * probed model is named with its own key-safe error so the admin sees WHICH
 * routes failed, not just the first-listed one. The check-the-key hint
 * survives when ANY attempt got 401/403 (router-level auth failure).
 * Ticket 2df5ed65: a model that answered the chat probe with its
 * typed-decision USAGE GUIDE and then failed the typed-decision re-probe is
 * named as such — the admin must see both shapes failed, not a bare 400.
 */
function completionAuthErrorAll(failures: { model: string; err: any; usageGuide?: boolean; decisionError?: string }[], apiKey: string | null): string {
  const detail = failures.map(f => `${f.model} (${safeTestError(f.err, apiKey)}${f.usageGuide ? ` — a typed-decision usage guide; the typed-decision re-probe failed too${f.decisionError ? `: ${f.decisionError}` : ''}` : ''})`).join('; ');
  const anyAuth = failures.some(f => {
    const s = f.err?.response?.status;
    return s === 401 || s === 403;
  });
  return `models list OK, but POST /chat/completions failed on all ${failures.length} probed model(s): ${detail}${anyAuth ? ' — check the key' : ''}`;
}

/**
 * Ticket 2df5ed65: a typed-decision server's USAGE-GUIDE 400 — the refusal a
 * decision model gives a plain chat call (the LiteLLM gateway's verbatim
 * shape, live-probed on llm.cql.ca `agx-laya`: "agx-laya is a typed-decision
 * model, not a chat model. Send `\"questions\": {key: {\"instructions\": str,
 * \"type\": \"choice\"|\"noul\"|\"score\", \"criteria\": [..]}}` … in the request
 * body alongside the user message (the state)"). Narrow on purpose: an
 * auth/billing 400 or a malformed-request 400 must stay a failure. Pure.
 */
function isTypedDecisionUsageGuide400(err: any): boolean {
  if (err?.response?.status !== 400) return false;
  let body = '';
  try {
    body = typeof err?.response?.data === 'string' ? err.response.data : JSON.stringify(err?.response?.data ?? '');
  } catch { body = ''; }
  const m = `${String(err?.message ?? '')} ${body.slice(0, 2000)}`.toLowerCase();
  // The key: a questions-map schema named in the refusal. The JSON-key match
  // accepts both a raw-string body (`"questions":`) and an object body that
  // JSON.stringify double-quotes (`\"questions\":`) — reviewer A4: the old
  // `includes('"questions"')` form could never match the object shape.
  const namesQuestions = /['\\"]?questions['\\"]?\s*:/.test(m);
  return m.includes('typed-decision model, not a chat model')
    || (namesQuestions && m.includes('choice') && (m.includes('noul') || m.includes('score')));
}

/**
 * Ticket 2df5ed65: re-probe a model that 400'd the chat shape with its
 * typed-decision usage guide using the DECISION gate's own client — one noul
 * + one choice over the sanity state through POST /chat/completions with the
 * questions map (the systemone_chat transport; the same Authorization header
 * and route, so a pass proves the key exactly as well as the 1-token chat
 * probe). Returns the probe's own { ok, detail | error } — never throws.
 */
async function reprobeAsTypedDecision(baseUrl: string, apiKey: string | null, model: string, declared: boolean): Promise<{ ok: true; detail?: string } | { ok: false; error?: string }> {
  try {
    const { probeSystemOneServer } = await import('../platform/decision-gate');
    const r = await probeSystemOneServer({ baseUrl, apiKey: apiKey ?? undefined, model, transport: 'chat' as const });
    if (!r.ok) return { ok: false, error: r.error };
    return {
      ok: true,
      detail: `"${model}" is a typed-decision model, not a chat model — the 1-token chat probe it rejected is the wrong shape for it, not a broken endpoint. ${r.detail ?? ''}${declared ? '' : ` Tick [typed decisions] on "${model}" so every Test surface drives it with the questions map.`}`.trim(),
    };
  } catch (err: any) {
    return { ok: false, error: safeTestError(err, apiKey) };
  }
}

/**
 * GET /models, then — only when a key is set and the list is non-empty — the
 * completion-auth probe, walking up to PROBE_MAX_ATTEMPTS listed models until
 * one answers (ticket 1dc89d48). Never leaks the key. Shared by
 * testEndpointConnection (saved row) and probeEndpointModels (unsaved draft).
 */
async function runConnectivityCheck(baseUrl: string, apiKey: string | null, rowModels?: EndpointModelEntry[]): Promise<EndpointTestResult> {
  let models: string[];
  try {
    models = await fetchRemoteModelIds(baseUrl, apiKey);
  } catch (err: any) {
    return { ok: false, error: safeTestError(err, apiKey) };
  }
  if (!apiKey || !models.length) return { ok: true, models };
  // Ticket 2df5ed65 — the walk is KIND-AWARE. A typed-decision model (flagged
  // [typed decisions], kind "decision", or an id the registry already reads
  // as decision — e.g. agx-laya on a LiteLLM openai_chat row) is NOT a chat
  // model: the 1-token chat probe draws its usage-guide 400 and a healthy
  // endpoint rendered broken. Three guards:
  //   1. non-chat listed models are SKIPPED by the auth walk (a chat model
  //      answers it instead — decision/embeddings/rerank routes 400 by design);
  //   2. a 400 carrying the typed-decision usage guide is RE-PROBED with the
  //      decision gate's own client — a pass is an "endpoint healthy, wrong
  //      test shape" verdict with the [typed decisions] hint, never a failure;
  //   3. when NO chat-capable model can answer, the decision model IS the
  //      endpoint's contract: its typed-decision probe is the verdict. A row
  //   that DECLARES a decision model gets it probed alongside the chat walk,
  //   and a failing declared decision model fails the Test (mirrors
  //   runSystemOneCheck).
  const rowList = Array.isArray(rowModels) ? rowModels.filter(m => m && m.id) as EndpointModelEntry[] : [];
  const rowById = new Map(rowList.map(m => [m.id as string, m]));
  const kindOfListed = (id: string): EndpointModelKind => {
    const row = rowById.get(id);
    return row ? modelKindOf(row) : (heuristicModelKind(id) ?? 'chat');
  };
  const declaredDecision = rowList.find(m => modelKindOf(m) === 'decision');
  const listedDecisionIds = models.filter(id => kindOfListed(id) === 'decision');
  // Bounded per-model fallback (ticket 1dc89d48): the first-listed model is
  // not special — LiteLLM-style routers list routes with no live engine, so a
  // dead/slow FIRST model must not kill discovery while later models answer.
  // Ticket 2df5ed65: the walk only probes CHAT-capable entries. When none of
  // the first-listed models is chat-capable, the decision probe carries the
  // verdict and the walk stands down entirely.
  const eligible = models
    .map((model, index) => ({ model, index }))
    .filter(e => kindOfListed(e.model) === 'chat');
  const attempts = (eligible.length || !listedDecisionIds.length)
    ? (eligible.length ? eligible : models.map((model, index) => ({ model, index }))).slice(0, PROBE_MAX_ATTEMPTS)
    : [];
  // The typed-decision target: the declared row model first; when the row
  // declares none and no chat model can answer the auth probe, the first
  // decision-kind LISTED id (the undeclared agx-laya case).
  // Reviewer A3: a declared id that is NOT in the fetched /models list is a
  // NOTE, never the probe target — runSystemOneCheck treats the same class
  // as a note (a renamed LiteLLM route must not false-red the Test).
  const declaredListed = declaredDecision && models.includes(declaredDecision.id) ? declaredDecision : undefined;
  const decisionTarget = declaredListed?.id ?? (attempts.length ? undefined : listedDecisionIds[0]);
  const decisionDeclared = declaredDecision?.id === decisionTarget;
  const decisionNote = declaredDecision && !declaredListed
    ? `"${declaredDecision.id}" is declared [typed decisions] but is not in the server's /models list (renamed route?) — the decision probe was skipped.`
    : undefined;
  // Reviewer B2: one shared wall-clock budget across the walk + every
  // decision probe — 3×5 s chat + 15 s rescue + 15 s declared probe could
  // reach 45 s, exactly the frontend client's API_TIMEOUT_MS, and a
  // healthy-but-slow endpoint rendered broken (the ticket's own symptom,
  // reintroduced). The deadline leaves 10 s of headroom under the client
  // timeout; probes skipped for time are named in the verdict, never silent.
  const deadline = Date.now() + 35_000;
  const inBudget = () => Date.now() < deadline;
  // Reviewer B2: at most ONE typed-decision RESCUE per check (15 s hard
  // deadline each) — the budget above is the hard stop, the counter keeps
  // the common path fast.
  let rescuesUsed = 0;
  const runDecisionProbe = () => { rescuesUsed += 1; return reprobeAsTypedDecision(baseUrl, apiKey, String(decisionTarget), decisionDeclared); };
  const failures: { model: string; err: any; usageGuide?: boolean; decisionError?: string }[] = [];
  for (const [attemptNo, { model, index }] of attempts.entries()) {
    // Reviewer B2: the shared budget — a walk that has already spent its
    // budget stops here; the remaining models are named as skipped, never
    // silently dropped.
    if (attemptNo > 0 && !inBudget()) {
      failures.push({ model, err: new Error(`skipped: the connectivity check's 35 s budget ran out`) });
      continue;
    }
    try {
      await probeCompletionAuth(baseUrl, apiKey, model);
      // A declared decision model rides along (ticket 2df5ed65): the
      // endpoint's contract includes it, so its route is probed with the
      // decision shape and a failure is the verdict.
      if (decisionTarget) {
        const r = inBudget() ? await runDecisionProbe() : { ok: false as const, error: 'skipped: the check budget ran out' };
        if (!r?.ok) {
          return {
            ok: false,
            models,
            completionAuth: 'ok',
            error: `models list OK and the chat probe authenticated via "${model}", but the typed-decision probe on "${decisionTarget}" failed: ${r?.error || 'no answer'} — the decision model's route is this endpoint's declared purpose.`,
          };
        }
        return { ok: true, models, completionAuth: 'ok', detail: r?.detail };
      }
      return {
        ok: true,
        models,
        completionAuth: 'ok',
        // Name the answering model ONLY when the probe walked past the
        // first-listed one — the admin should know the list order hides a
        // dead/slow route. Omitted on a first-model hit so the healthy
        // success shape stays byte-identical. The comparison is INDEX-based
        // (ticket f380838a): an exotic list can repeat the same model id
        // within the first attempts, and a value-based check would treat the
        // answering duplicate as a first-model hit and omit probedModel.
        ...(index === (eligible[0]?.index ?? 0) ? {} : { probedModel: model }),
        ...(decisionNote ? { detail: decisionNote } : {}),
      };
    } catch (err: any) {
      // The usage guide is the model telling us the test SHAPE is wrong, not
      // that it is broken: re-probe with the decision gate's client before
      // counting the failure (the undeclared decision-model case). Reviewer
      // B2: the rescue budget is ONE — after that the failure stands.
      if (rescuesUsed === 0 && isTypedDecisionUsageGuide400(err)) {
        rescuesUsed += 1;
        const rescue = await reprobeAsTypedDecision(baseUrl, apiKey, model, rowById.has(model) && declaredDecision?.id === model);
        if (rescue?.ok) return { ok: true, models, completionAuth: 'ok', detail: rescue.detail };
        failures.push({ model, err, usageGuide: true, decisionError: rescue && !rescue.ok ? rescue.error : undefined });
      } else {
        failures.push({ model, err });
      }
    }
  }
  // No chat model answered (or none was eligible): the decision model is the
  // endpoint's contract — its probe is the verdict.
  // Reviewer B1: chat-probe failures are NEVER erased on this path. If chat
  // attempts ran and ALL failed, that is a failure — a passing decision
  // probe cannot convert it to ok (the ticket's own bug class, inverted: a
  // per-route key that cannot call chat routes must not render "Connected ·
  // chat-completion auth verified"). And when NO chat probe ran at all (an
  // all-decision list), completionAuth is OMITTED, not 'ok' — the field's
  // contract says it is present only when the chat probe ran.
  const chatAllFailed = attempts.length > 0 && failures.length === attempts.length;
  if (decisionTarget) {
    const r = await runDecisionProbe();
    if (r?.ok) {
      if (chatAllFailed) {
        return {
          ok: false,
          models,
          completionAuth: 'failed',
          error: `${failures.length === 1 ? completionAuthError(failures[0].err, apiKey) : completionAuthErrorAll(failures, apiKey)} — the typed-decision probe on "${decisionTarget}" answered, but the chat route(s) did not; a key that cannot call the chat routes is still a failed Test.`,
        };
      }
      // No chat attempt ran: the decision probe is the whole contract — a
      // pass is healthy, and completionAuth is omitted (no chat probe ran).
      return { ok: true, models, detail: `${r.detail ?? ''}${decisionNote ? ` ${decisionNote}` : ''}`.trim() };
    }
    // The decision probe failed: name the chat failures too when any ran.
    const chatPart = attempts.length === 0
      ? ''
      : failures.length
        ? `${failures.length === 1 ? completionAuthError(failures[0].err, apiKey) : completionAuthErrorAll(failures, apiKey)}; and `
        : 'no chat-capable model answered; ';
    return {
      ok: false,
      models,
      ...(attempts.length ? { completionAuth: 'failed' as const } : {}),
      error: `${chatPart}the typed-decision probe on "${decisionTarget}" failed: ${r?.error || 'no answer'}.${decisionNote ? ` ${decisionNote}` : ''}`,
    };
  }
  return {
    ok: false,
    models,
    completionAuth: 'failed',
    // Single-model lists keep the original single-probe message byte-identical
    // (a usage-guide 400 that also failed its decision re-probe says so).
    error: failures.length === 1
      ? completionAuthError(failures[0].err, apiKey) + (failures[0].usageGuide
        ? ` — "${failures[0].model}" answered with its typed-decision usage guide and the typed-decision re-probe failed too${failures[0].decisionError ? `: ${failures[0].decisionError}` : ''}`
        : '')
      : completionAuthErrorAll(failures, apiKey),
  };
}

/** Decrypts a row's stored key; a drifted key is a friendly error string, not an exception. */
function decryptRowKey(row: { apiKeyEnc: string | null }): { apiKey: string | null; error?: string } {
  if (!row.apiKeyEnc) return { apiKey: null };
  try {
    return { apiKey: decryptValue(row.apiKeyEnc) };
  } catch {
    return { apiKey: null, error: 'Stored API key no longer decrypts (JWT_SECRET drift?) — re-enter it.' };
  }
}

/**
 * Connectivity check for a saved endpoint: GET <baseUrl>/models with the
 * decrypted key, then (key set + models listed) a minimal POST
 * /chat/completions that actually proves the key (5s timeouts). Never leaks
 * the key.
 */
export async function testEndpointConnection(id: string): Promise<EndpointTestResult> {
  const row = await prisma.modelEndpoint.findUnique({ where: { id } });
  if (!row) throw new AppError(404, 'Model endpoint not found');
  const { apiKey, error } = decryptRowKey(row);
  if (error) return { ok: false, error };
  if (isDecisionProviderShape(row.providerShape)) return runSystemOneCheck(row.baseUrl, apiKey, row.models as any, row.providerShape);
  return runConnectivityCheck(row.baseUrl, apiKey, row.models as any);
}

/**
 * Connectivity check for a DECISION server: GET <baseUrl>/models (TypeSafe
 * serves it; a self-hosted server may not — a 404 there is tolerated when the
 * row already lists models), then one real /systemone probe on the first
 * listed model through the decision gate's own client. Never leaks the key.
 *
 * 2026-09-26 (`systemone_chat`, the LiteLLM typed-decision proxy): GET /models
 * is EXPECTED to answer (LiteLLM serves it — no 404 tolerance), the probe goes
 * through POST /chat/completions, and the probe model is the FIRST ROW MODEL
 * (the proxy lists every route it fronts, most of them chat models — the
 * first listed id is not the decision model). A row model absent from the
 * proxy's list is reported in the detail, never a failure by itself: the
 * typed-decision probe is the verdict.
 */
async function runSystemOneCheck(baseUrl: string, apiKey: string | null, rowModels?: EndpointModelEntry[], shape: string = PROVIDER_SHAPE_SYSTEMONE): Promise<EndpointTestResult> {
  const chat = shape === PROVIDER_SHAPE_SYSTEMONE_CHAT;
  let models: string[] = [];
  try {
    models = await fetchRemoteModelIds(baseUrl, apiKey);
  } catch (err: any) {
    if (chat || err?.response?.status !== 404 || !Array.isArray(rowModels) || !rowModels.length) {
      return { ok: false, error: safeTestError(err, apiKey) };
    }
    models = rowModels.map(m => m.id);
  }
  const firstRowModel = (Array.isArray(rowModels) && rowModels[0]?.id) || '';
  const probeModel = chat ? (firstRowModel || models[0] || '') : (models[0] || firstRowModel);
  if (!probeModel) return { ok: true, models };
  const unlisted = chat && firstRowModel && models.length && !models.includes(firstRowModel) ? ` — NOTE: "${firstRowModel}" is not in the proxy's /models list (${models.length} listed); check the model id` : '';
  try {
    const { probeSystemOneServer } = await import('../platform/decision-gate');
    const r = await probeSystemOneServer({ baseUrl, apiKey: apiKey ?? undefined, model: probeModel, ...(chat ? { transport: 'chat' as const } : {}) });
    return r.ok
      ? { ok: true, models, completionAuth: 'ok', ...(r.detail || unlisted ? { detail: `${r.detail ?? ''}${unlisted}` } : {}) }
      : { ok: false, models, completionAuth: 'failed', error: `${r.error || (chat ? 'the typed-decision probe through /chat/completions failed' : 'the /systemone probe failed')}${unlisted}` };
  } catch (err: any) {
    return { ok: false, models, completionAuth: 'failed', error: safeTestError(err, apiKey) };
  }
}

export interface ProbeInput {
  baseUrl: string;
  apiKey?: string;
  endpointId?: string;
}

/**
 * Model auto-discovery for the add/edit dialog: the same connectivity check as
 * a saved endpoint (GET /models, then the completion-auth probe when a key is
 * set) WITHOUT persisting anything. Key precedence: an explicitly passed
 * apiKey wins (the admin just typed a replacement), then the stored key of
 * endpointId (edit dialog with the key field untouched), else no auth. Never
 * leaks the key.
 */
export async function probeEndpointModels(input: ProbeInput): Promise<EndpointTestResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  let apiKey: string | null = String(input.apiKey || '').trim() || null;
  if (!apiKey && input.endpointId) {
    const row = await prisma.modelEndpoint.findUnique({ where: { id: input.endpointId } });
    if (!row) throw new AppError(404, 'Model endpoint not found');
    const stored = decryptRowKey(row);
    if (stored.error) return { ok: false, error: stored.error };
    apiKey = stored.apiKey;
    // Ticket 2df5ed65: the edit dialog's Fetch-from-server runs the same
    // KIND-AWARE connectivity check — the row's declared models are the kind
    // source when the dialog did not change them.
    return runConnectivityCheck(baseUrl, apiKey, row.models as any);
  }
  return runConnectivityCheck(baseUrl, apiKey);
}

// ── Registry resolution (coding run path) ────────────────────────────────────

/** What coding-model.ts needs to build a ProviderConfig for a registry model. */
export interface RegistryModelResolution {
  /** <baseUrl>/chat/completions */
  url: string;
  /** The endpoint's bare base URL — for non-chat surfaces (embeddings/rerank
   *  role overrides call <baseUrl>/embeddings and <baseUrl>/rerank). */
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  /** Human label for logs/usage rows: the endpoint label. */
  label: string;
  supportsVision: boolean;
  /** LEGACY alias of `chatCapable` (2026-09-27, owner: "coding is a seat
   *  choice, not a model capability"): true for every chat-capable model
   *  (modelKindOf === 'chat'), whether or not the entry carries the old flag. */
  coding: boolean;
  /** Selectable for the chat / agent / coding seats — the model IS a chat
   *  model (explicit kind, legacy [coding], detection, or the id heuristic). */
  chatCapable: boolean;
  /** What the model is (modelKindOf). */
  kind: EndpointModelKind;
  /** Resolved tool cap: model.maxTools > endpoint settings.maxTools > provider
   *  class default (OpenAI-like ids → 128). Absent = unlimited. */
  maxTools?: number;
  maxToolsSource: 'model' | 'endpoint' | 'class' | 'none';
  /** Provider class (admin override or the id heuristic). */
  providerClass: VendorProviderClass;
  /** 'supported' | 'unsupported' | 'auto' (default auto = omit reasoning params). */
  reasoningEffort: 'supported' | 'unsupported' | 'auto';
  /** Context window in tokens when the entry carries one. */
  contextWindow?: number;
  /** Admin flagged this as an MRL embedding model (client-side 1536 truncation OK). */
  matryoshka: boolean;
  /** Admin asked for thinking to be disabled on every call to this model. */
  thinkingOff: boolean;
  /** The endpoint's providerShape ('openai_chat' | 'systemone' | 'systemone_chat') — the decision
   *  gate picks its client + transport by it; the chat/coding path only ever sees openai_chat. */
  providerShape: string;
  /** Admin flagged this model [image] (serves POST <baseUrl>/images/generations).
   *  Present ONLY when true (consumers test `=== true`, like the other flags) —
   *  the existing resolution pins stay byte-identical for unflagged models. */
  image?: true;
  /** 2026-10-23 (04c8ffd1): the entry's per-model image timeout (already clamped at save). Present ONLY when set. */
  imageTimeoutMs?: number;
  /** 2026-10-25 (todo 87b020c4): the entry's per-model images-route base-URL
   *  override (already normalized at save). Present ONLY when set — image
   *  consumers fall back to baseUrl; chat consumers never read it. */
  imagesUrl?: string;
  /** 2026-09-26: the admin asserted calibrated probabilities on this decision
   *  backend. Present ONLY when true (same convention as `image`). */
  calibrated?: true;
  /** 2026-09-26: the per-backend state cap for the decision gate. Present ONLY
   *  when the entry carries a positive value. */
  maxStateChars?: number;
  /** 2026-09-28 (decision-gate spend rows): the price in force for this model —
   *  the entry's usdPerMTokIn/Out, else the endpoint's settings.usdPerMTokIn/Out.
   *  Present ONLY when set somewhere (absent = self-hosted / unpriced). */
  usdPerMTokIn?: number;
  usdPerMTokOut?: number;
  /** 2026-09-26 (Laya follow-up): the model is flagged as a typed-decision model
   *  behind an OpenAI-compatible proxy — the decision gate uses the
   *  systemone_chat transport for it. Present ONLY when flagged. */
  decision?: 'systemone_chat';
  /** 2026-09-27 (audit E3, seat governance): the model's GOVERNANCE class from
   *  its host OR id (provider-class.ts). Present ONLY when 'frontier' — the same
   *  present-only convention as `image`, so every open-model resolution pin
   *  stays byte-identical. model-roles.service assertAssignable records a
   *  `seat_governance` row for a frontier-class model on the governed chat /
   *  supervisor seats (observe-only by default; FRONTIER_SEATS_REFUSE=1 makes
   *  the save refuse); the run path never reads it. Named `governanceClass`
   *  because `providerClass` on this object is the VENDOR class the tool-cap
   *  heuristics read (seat/provider limits, 2026-09-27) — two different axes. */
  governanceClass?: 'frontier';
}

interface CacheEntry { resolution: RegistryModelResolution | null; expiresAt: number; }
const registryCache = new Map<string, CacheEntry>();

/** Test hook + mutation invalidation. */
export function clearRegistryModelCache(): void { registryCache.clear(); }

/**
 * Parse a '<label>:<modelId>' run-model spec. Returns null for anything that
 * is not spec-shaped (built-in ids never contain ':' — they skip the registry
 * entirely, keeping built-in resolution byte-identical).
 */
export function parseRegistrySpec(spec: string): { label: string; modelId: string } | null {
  const s = String(spec || '');
  const i = s.indexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  const label = s.slice(0, i);
  if (!ENDPOINT_LABEL_RE.test(label)) return null;
  return { label, modelId: s.slice(i + 1) };
}

/**
 * Resolve '<label>:<modelId>' against the enabled registry. NULL (not an
 * error) when nothing matches — the caller falls back to the built-in
 * providers. ownerUserId NULL rows (instance-wide) match everyone; per-user
 * rows match only their owner (future). 30s in-process cache keyed by
 * spec+userId; mutations clear it.
 */
export async function resolveRegistryModel(spec: string, userId?: string): Promise<RegistryModelResolution | null> {
  const parsed = parseRegistrySpec(spec);
  if (!parsed) return null;
  const cacheKey = `${spec}::${userId || ''}`;
  const hit = registryCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.resolution;

  let resolution: RegistryModelResolution | null = null;
  try {
    const row = await prisma.modelEndpoint.findFirst({
      where: {
        label: parsed.label,
        enabled: true,
        OR: [{ ownerUserId: null }, ...(userId ? [{ ownerUserId: userId }] : [])],
      },
      orderBy: { ownerUserId: 'asc' }, // NULL (instance-wide) first; per-user rows are future
    });
    const entry = row && Array.isArray(row.models)
      ? (row.models as unknown as EndpointModelEntry[]).find(m => m?.id === parsed.modelId)
      : undefined;
    // 2026-10-06 retired entry (f90 follow-up): listed for provenance, never
    // served — resolve to NULL so every consumer takes its existing
    // "no longer resolves" path (seat resolves:false + built-in fallback,
    // catalog servable:false, verify 400), exactly like a deleted model.
    if (row && entry && entry.unservable === true) {
      registryCache.set(cacheKey, { resolution: null, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS });
      return null;
    }
    if (row && entry) {
      let apiKey: string | undefined;
      if (row.apiKeyEnc) {
        try { apiKey = decryptValue(row.apiKeyEnc); } catch (err: any) {
          logger.warn(`model-endpoints: key for "${parsed.label}" no longer decrypts (${err?.message}) — treating the spec as unresolvable`);
          registryCache.set(cacheKey, { resolution: null, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS });
          return null;
        }
      }
      // A DECISION-shape endpoint (systemone / systemone_chat) serves decision
      // models only — never chat-capable, whatever the entry's flags say (the
      // chat/coding run path must never resolve it; it always resolved
      // `coding:false` before 2026-09-27).
      const kind: EndpointModelKind = isDecisionProviderShape(row.providerShape) ? 'decision' : modelKindOf(entry);
      const chatCapable = kind === 'chat';
      // 2026-09-28 decision-gate spend rows: model price > endpoint price > unset.
      const endpointSettings = validateSettings((row as any).settings);
      const priceOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
      const priceIn = priceOf(entry.usdPerMTokIn) ?? priceOf(endpointSettings.usdPerMTokIn);
      const priceOut = priceOf(entry.usdPerMTokOut) ?? priceOf(endpointSettings.usdPerMTokOut);
      const limits = resolveMaxTools({
        modelId: entry.id,
        maxTools: entry.maxTools,
        providerClass: entry.providerClass,
        endpointMaxTools: validateSettings((row as any).settings).maxTools,
      });
      resolution = {
        url: `${row.baseUrl}/chat/completions`,
        baseUrl: row.baseUrl,
        apiKey,
        model: entry.id,
        label: row.label,
        supportsVision: entry.vision === true,
        coding: chatCapable,
        chatCapable,
        kind,
        ...(limits.limit !== undefined ? { maxTools: limits.limit } : {}),
        maxToolsSource: limits.source,
        providerClass: limits.providerClass,
        reasoningEffort: entry.reasoningEffort ?? 'auto',
        ...(typeof entry.contextWindow === 'number' && entry.contextWindow > 0 ? { contextWindow: Math.floor(entry.contextWindow) } : {}),
        matryoshka: entry.matryoshka === true,
        thinkingOff: entry.thinking === 'off',
        providerShape: String(row.providerShape || PROVIDER_SHAPE_OPENAI_CHAT),
        ...(entry.image === true ? { image: true as const } : {}),
        ...(typeof entry.imageTimeoutMs === 'number' && entry.imageTimeoutMs > 0 ? { imageTimeoutMs: entry.imageTimeoutMs } : {}),
        ...(typeof entry.imagesUrl === 'string' && entry.imagesUrl ? { imagesUrl: entry.imagesUrl } : {}),
        ...(entry.calibrated === true ? { calibrated: true as const } : {}),
        ...(typeof entry.maxStateChars === 'number' && Number.isFinite(entry.maxStateChars) && entry.maxStateChars > 0 ? { maxStateChars: Math.floor(entry.maxStateChars) } : {}),
        ...(typeof priceIn === 'number' ? { usdPerMTokIn: priceIn } : {}),
        ...(typeof priceOut === 'number' ? { usdPerMTokOut: priceOut } : {}),
        ...(entry.decision === PROVIDER_SHAPE_SYSTEMONE_CHAT ? { decision: 'systemone_chat' as const } : {}),
        ...(modelProviderClass(row.baseUrl, entry.id) === 'frontier' ? { governanceClass: 'frontier' as const } : {}),
      };
    }
  } catch (err: any) {
    // A DB hiccup must not kill the run path — fall back to built-ins.
    logger.warn(`model-endpoints: registry lookup failed for "${spec}": ${err?.message}`);
  }
  registryCache.set(cacheKey, { resolution, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS });
  return resolution;
}

// ── Capability detection persistence (2026-09-27, capability-detect.ts) ──────

// ── Model-list sync from the endpoint's live /v1/models (ticket 780cd7a4) ────

/** A sync's diff, reported per model id (never the entries — the flags may
 *  carry detected capabilities; the summary list is the UI's source). */
export interface EndpointModelsSyncDiff {
  added: string[];
  /** Ids the server no longer lists that were retired (unservable: true set). */
  retired: string[];
  /** Ids still listed server-side that carry unservable: true — NOT un-retired
   *  (un-retiring is a human decision, same as every other manual flag). */
  backButKeptRetired: string[];
  /** Ids the server lists that the row already had — untouched. */
  unchanged: string[];
}

/**
 * SYNC the endpoint's stored model list against its live /v1/models (ticket
 * 780cd7a4): the list was a snapshot taken when the endpoint was saved — a
 * gateway that retires or adds routes left the row advertising models that 400
 * "Invalid model name" at request time. Refresh semantics, deliberately
 * conservative:
 *
 *   ADD      — every server-listed id missing from the row lands as a bare
 *              entry { id } (the dialog's Fetch-from-server merge, made
 *              persistent). The id heuristic (modelKindOf) still sorts
 *              embed/rerank ids out of the chat catalog on read, so a bare
 *              entry cannot leak into a chat seat.
 *   RETIRE   — a row id ABSENT from the server's list gets unservable: true —
 *              the exact semantics of the 2026-10-06 "retired" chip: the
 *              entry STAYS for provenance, the spec stops resolving (seats
 *              fall back to their built-in and badge resolves:false), the
 *              catalog card goes servable:false. A hand-retired entry the
 *              server no longer lists keeps its flag (it is already retired).
 *              A row id the server lists again is NEVER un-retired here —
 *              un-retiring is a human decision (backButKeptRetired reports it).
 *   PRESERVE — every other flag of every entry (vision, kind, maxTools,
 *              manualFlags, capabilities, prices…) is carried through
 *              validateModels unchanged, exactly like an admin save.
 *
 * Nothing is deleted: a stored seat override or pool pointing at a retired id
 * keeps resolving-or-falling-back exactly as it does today. A failed
 * /v1/models fetch throws (safeTestError text, 502) and the row is untouched.
 * Kill switch: MODEL_ENDPOINT_SYNC_DISABLED=1 refuses with 400.
 */
export async function refreshEndpointModels(endpointId: string): Promise<ModelEndpointSummary & { sync: EndpointModelsSyncDiff }> {
  if (process.env.MODEL_ENDPOINT_SYNC_DISABLED === '1') {
    throw new AppError(400, 'Model-list sync is disabled (MODEL_ENDPOINT_SYNC_DISABLED=1).');
  }
  const row = await prisma.modelEndpoint.findUnique({ where: { id: endpointId } });
  if (!row) throw new AppError(404, 'Model endpoint not found');
  const { apiKey, error } = decryptRowKey(row);
  if (error) return Promise.reject(new AppError(400, error));
  let listed: string[];
  try {
    listed = await fetchRemoteModelIds(row.baseUrl, apiKey);
  } catch (err: any) {
    // Key-safe, admin-readable — the same text the Test button shows.
    throw new AppError(502, safeTestError(err, apiKey));
  }
  // Normalize ONCE, immediately after the fetch (review F1-R): trim every id and
  // drop empties, so the dark-server guard, the retire-side membership set and
  // the add-loop below all read the SAME list. The F1 fix normalized the
  // add-loop alone — asymmetry with two edges: a whitespace-padded listing of
  // an EXISTING served id ('  glm-5.3  ') missed the raw listedSet and wrongly
  // RETIRED the served entry, and a whitespace-only id ('   ') passed the
  // zero-model guard (raw length 1) only to retire the whole row. Normalized
  // here, the padded id matches its row entry and the whitespace-only list IS
  // the zero-model refusal. Case stays significant (ids are case-sensitive).
  listed = [...new Set(listed.map((s) => String(s).trim()).filter(Boolean))];
  const listedSet = new Set(listed);
  const current = Array.isArray(row.models) ? (row.models as unknown as EndpointModelEntry[]) : [];
  // Dark-server guard: some proxies answer GET /v1/models with an EMPTY list
  // while chat still works (a /models quirk, a routing bug, a half-up gateway).
  // Retiring the WHOLE row off that would be a misfire the admin cannot easily
  // see coming — refuse and name the state (the Test button still diagnoses).
  if (!listed.length && current.length) {
    throw new AppError(502, `${row.baseUrl}/models listed ZERO models while ${current.length} are registered on "${row.label}" — refusing to retire the whole row (a dark or misbehaving /models route). Test the endpoint; if the server really is gone, edit or delete it instead.`);
  }
  const diff: EndpointModelsSyncDiff = { added: [], retired: [], backButKeptRetired: [], unchanged: [] };
  const next: EndpointModelEntry[] = current.map((m) => {
    const entry = { ...m };
    const served = listedSet.has(m?.id);
    if (!served && entry.unservable !== true) {
      entry.unservable = true;
      diff.retired.push(entry.id);
    } else if (served && entry.unservable === true) {
      diff.backButKeptRetired.push(entry.id);
    } else if (served) {
      diff.unchanged.push(entry.id);
    }
    // !served && unservable already true → already retired by hand; no change, not reported.
    return entry;
  });
  const have = new Set(next.map((m) => m.id));
  // Dedupe + trim the server's list: a misbehaving /v1/models can list the
  // same id twice (or padded with whitespace — review F1); validateModels 400s
  // on duplicates, so a raw double-listing must not turn the admin's Sync into
  // a refusal. Case stays significant (ids are case-sensitive).
  const fresh = [...new Set(listed.map((s) => String(s).trim()).filter(Boolean))];
  for (const id of fresh) {
    if (!have.has(id)) { next.push({ id }); diff.added.push(id); }
  }
  if (!diff.added.length && !diff.retired.length) {
    // Nothing to write — still report the sync (and any backButKeptRetired
    // note) so the admin sees the server was asked.
    return { ...summarize(row), sync: diff };
  }
  const validated = validateModels(next);
  const updated = await prisma.modelEndpoint.update({ where: { id: endpointId }, data: { models: validated as any } });
  clearRegistryModelCache();
  return { ...summarize(updated), sync: diff };
}

/**
 * Persist ONE model entry as detection rebuilt it: re-reads the row, REPLACES
 * that model's entry with `next` (the caller passes the COMPLETE entry — a
 * flag detection cleared is simply absent from it), runs the whole list
 * through validateModels (the same whitelist copy every save gets — unknown
 * keys and garbage values are dropped), writes it back, clears the registry
 * cache and returns the saved entry. 404 when the endpoint is gone, 400 when
 * the model id is not on the row.
 */
export async function applyModelDetection(endpointId: string, modelId: string, next: EndpointModelEntry): Promise<EndpointModelEntry> {
  const row = await prisma.modelEndpoint.findUnique({ where: { id: endpointId } });
  if (!row) throw new AppError(404, 'Model endpoint not found');
  const models = (Array.isArray(row.models) ? (row.models as unknown as EndpointModelEntry[]) : []).map((m) => ({ ...m }));
  const i = models.findIndex((m) => m?.id === modelId);
  if (i < 0) throw new AppError(400, `Model "${String(modelId).slice(0, 300)}" is not registered on endpoint "${row.label}".`);
  models[i] = { ...next, id: modelId };
  const validated = validateModels(models);
  await prisma.modelEndpoint.update({ where: { id: endpointId }, data: { models: validated as any } });
  clearRegistryModelCache();
  return validated[i];
}

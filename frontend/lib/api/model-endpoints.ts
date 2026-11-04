/**
 * Model endpoints API — Digby Edge (Phase 2) custom model endpoint registry
 * (`/api/crossmodel/admin/model-endpoints/*`). ADMIN-only server-side (403 for
 * non-admins). API keys are write-only: responses carry `hasApiKey`, never the
 * key. A registry model is addressed as `<label>:<modelId>` (coding model
 * picker, Account → Coding).
 */

import apiClient, { API_TIMEOUT_MS } from '../api-client';

/** What a registry model IS (2026-09-27). Only 'chat' models are selectable for
 *  the chat / agent / coding seats — "coding is a seat choice, not a model
 *  capability" (owner). Mirrors backend EndpointModelKind. */
export type EndpointModelKind = 'chat' | 'embeddings' | 'rerank' | 'asr' | 'tts' | 'image' | 'decision';
export const ENDPOINT_MODEL_KINDS: readonly EndpointModelKind[] = ['chat', 'embeddings', 'rerank', 'asr', 'tts', 'image', 'decision'];
/** Provider family behind a custom endpoint (drives the default tool cap: openai → 128). */
export type ProviderClass = 'openai' | 'anthropic' | 'google' | 'moonshot' | 'deepseek' | 'zai' | 'dashscope' | 'other';
export const PROVIDER_CLASSES: readonly ProviderClass[] = ['openai', 'anthropic', 'google', 'moonshot', 'deepseek', 'zai', 'dashscope', 'other'];
/** Does the model accept `reasoning_effort` / `thinking` with tools on /chat/completions?
 *  'auto' (default) and 'unsupported' = Digby OMITS the params for custom endpoints. */
export type ReasoningEffortSupport = 'supported' | 'unsupported' | 'auto';
export const REASONING_EFFORT_SUPPORTS: readonly ReasoningEffortSupport[] = ['supported', 'unsupported', 'auto'];

/** The capability-detection suite (backend capability-detect.ts), one result row each. */
export type DetectCapability =
  | 'chat_stream' | 'tool_calling' | 'max_tools' | 'reasoning_effort' | 'thinking_default'
  | 'vision' | 'embeddings' | 'rerank' | 'typed_decisions' | 'image_generation' | 'context_window'
  /** 2026-09-28: the ONLY probe a typed-decision model gets (the same call Verify makes) — chat
   *  capabilities are not applicable to it and are never probed. */
  | 'decision';
export const DETECT_CAPABILITY_LABELS: Record<DetectCapability, string> = {
  decision: 'Typed decision (the Verify probe)',
  chat_stream: 'Chat streaming (JSON chunks vs raw text)',
  tool_calling: 'Tool calling',
  max_tools: 'Max tools per request',
  reasoning_effort: 'reasoning_effort with tools',
  thinking_default: 'Thinks by default (no-think directive)',
  vision: 'Vision (image input)',
  embeddings: 'Embeddings (dims)',
  rerank: 'Rerank (/rerank)',
  typed_decisions: 'Typed decisions (questions body)',
  image_generation: 'Image generation',
  context_window: 'Context window (tokens)',
};

export interface DetectedCapabilityResult {
  capability: DetectCapability | string;
  /** The probe reached a verdict (false = the probe itself failed / was skipped — `evidence` says why). */
  ok: boolean;
  /** boolean for yes/no capabilities, a number for max_tools / context_window / embedding dims,
   *  a string for shapes ('json' | 'raw_text', 'supported' | 'unsupported'), null when undetermined. */
  value: boolean | number | string | null;
  /** One key-scrubbed line — what was sent, what came back. */
  evidence: string;
  latencyMs: number;
  /** ISO timestamp of this probe. */
  at: string;
  skipped?: boolean;
}

export interface DetectedCapabilities {
  detectedAt: string;
  results: DetectedCapabilityResult[];
}

/** Endpoint-level settings (2026-09-27): one tool cap for every model on the
 *  endpoint that carries no per-model cap (a proxy fronting one provider family). */
export interface EndpointSettings {
  maxTools?: number;
  /** 2026-09-28 (decision-gate spend rows): endpoint-wide price, USD per 1M
   *  input / output tokens, for every model without its own. Unset = $0 badged
   *  "self-hosted" in Account → Admin → API costs. */
  usdPerMTokIn?: number;
  usdPerMTokOut?: number;
}

export interface EndpointModel {
  id: string;
  displayName?: string;
  vision?: boolean;
  /** @deprecated LEGACY alias (2026-09-27): the backend reads it TRUE for every
   *  chat-capable model — it is no longer a toggle in the UI. Use `kind` /
   *  isChatCapableModel(). Kept so stored entries and older backends round-trip. */
  coding?: boolean;
  // ── 2026-09-27 seat/provider limits (owner incident: a supervisor seat on an
  //    OpenAI model behind LiteLLM 400'd every turn — 195 tools on a 128-tool
  //    cap, then a proxy-injected reasoning_effort) ──
  /** Largest `tools` array the server accepts. Unset = the endpoint's
   *  settings.maxTools, else the provider-class default (openai → 128), else
   *  unlimited. Digby trims the long tail automatically (core + doctrine tools
   *  first). Admin-set or written by Detect capabilities. */
  maxTools?: number;
  /** Whether the model takes reasoning_effort / thinking with tools. Custom
   *  endpoints receive them only when 'supported'. */
  reasoningEffort?: ReasoningEffortSupport;
  /** Provider family behind the endpoint (admin override of the id heuristic). */
  providerClass?: ProviderClass;
  /** What the model is. Unset = derived (legacy [coding] / [image] / [typed
   *  decisions] flags, then the last detection, then an id heuristic, else chat). */
  kind?: EndpointModelKind;
  /** Context window in TOKENS (from /models metadata when published). */
  contextWindow?: number;
  /** The last "Detect capabilities" run for this model (evidence per capability). */
  capabilities?: DetectedCapabilities;
  /** Flags the admin set BY HAND — a re-detect never overwrites them. */
  manualFlags?: string[];
  /** Image GENERATION model served on an OpenAI-shaped POST /images/generations
   *  route — the only registry models the Image generator seat accepts
   *  (2026-09-24). Distinct from [vision] (image INPUT). */
  image?: boolean;
  /** 2026-10-23 (04c8ffd1): per-model image-generation timeout in ms for
   *  [image]-flagged registry models — slow local backends (Qwen-Image behind
   *  LiteLLM, 5-10 min/generation) need 300000-600000. Backend clamps
   *  [30000, 780000] on save; absent = the IMAGE_CUSTOM_TIMEOUT_MS env, else
   *  the 120 s default. */
  imageTimeoutMs?: number;
  /** MRL-trained embedding model: Digby truncates a longer vector to 1536
   *  client-side (Qwen3-Embedding, text-embedding-3, nomic v1.5…). */
  matryoshka?: boolean;
  /** 'off' = Digby sends the thinking-disable directive on every call — for
   *  default-thinking models (Qwen3…) on the non-streaming Helper/Utility seats. */
  thinking?: 'default' | 'off';
  /** Decision backends (2026-09-26): the admin ASSERTS this model's server
   *  returns calibrated probabilities (TypeSafe Jev, JevK5 with its server-side
   *  temperature). Unset = uncalibrated until the readiness job fits a
   *  temperature for it, so an act purpose it answers is downgraded to shadow
   *  (Laya ships over-confident — leave it unset). */
  calibrated?: boolean;
  /** Decision backends (2026-09-26): the gate truncates the STATE to this many
   *  characters before calling the model and stamps meta.stateTruncated (Laya's
   *  512-token context ≈ 1,200 chars; JevK5 / openjev / NeoHorse take 16k tokens;
   *  Laya behind LiteLLM cuts at 1,024 input tokens — set ≈ 3,800). */
  maxStateChars?: number;
  /** 2026-09-28 (decision-gate spend rows): what THIS model bills at, USD per
   *  1M input / output tokens (0 = free). Unset = the endpoint's settings price,
   *  else $0 badged "self-hosted" in API costs — never a silent list-price guess. */
  usdPerMTokIn?: number;
  usdPerMTokOut?: number;
  /** Laya follow-up (2026-09-26): THIS model on an OpenAI-compatible endpoint is a
   *  TYPED-DECISION model served through /chat/completions (LiteLLM fronting Laya
   *  — llm.example.com `agx-laya` on the `cql-litellm` endpoint). The decision gate
   *  then calls it with the systemone_chat transport (questions in the body, the
   *  JSON answers envelope in the message content) instead of the logprob
   *  readout, which that proxy refuses. Never flag a chat model. */
  decision?: 'systemone_chat';
  /** 2026-10-06 (f90 follow-up): RETIRED — listed for provenance, never served
   *  (the gateway route was torn down; every call 400s "Invalid model name").
   *  The spec stops resolving (seats fall back to their built-in and badge
   *  `resolves:false`) and the catalog card goes servable:false, so no
   *  automatic pick ever routes here. Toggle the "retired" chip in the editor. */
  unservable?: boolean;
}

export interface ModelEndpoint {
  id: string;
  ownerUserId: string | null;
  label: string;
  providerShape: string;
  baseUrl: string;
  hasApiKey: boolean;
  models: EndpointModel[];
  /** Endpoint-level settings (2026-09-27). Absent on pre-2026-09-27 backends. */
  settings?: EndpointSettings;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Seat governance (audit E3, 2026-09-27): the endpoint's class from its
   *  HOST — 'frontier' = a frontier vendor's own API host. Server-derived on
   *  read, never stored. Absent on pre-2026-09-27 backends. */
  providerClass?: 'frontier' | 'open';
  /** The listed model ids whose host-or-id class is frontier (a proxy that
   *  lists `api-anthropic-claude-…` next to open ids). Absent on old backends. */
  frontierModelIds?: string[];
}

// ── Model kind + chat capability (2026-09-27; mirrors backend modelKindOf) ──

/** Id heuristics, first match wins — the same order as the backend's. */
const KIND_ID_HEURISTICS: Array<[RegExp, EndpointModelKind]> = [
  [/rerank/i, 'rerank'],
  [/embed/i, 'embeddings'],
  [/whisper|\basr\b|transcri|speech-to-text|stt\b|paraformer/i, 'asr'],
  [/\btts\b|text-to-speech|speech(?!-to)|cosyvoice/i, 'tts'],
  [/dall-e|flux|stable-diffusion|sdxl|cogview|imagen|z-image|wan2|qwen-image|\bimage\b/i, 'image'],
  [/\bjev\b|\blaya\b|systemone|neohorse|\bkev\b/i, 'decision'],
];

/** The kind a model id suggests, or null (chat is the default elsewhere). Pure. */
export function heuristicModelKind(id: string | undefined | null): EndpointModelKind | null {
  const s = String(id ?? '');
  if (!s) return null;
  for (const [re, kind] of KIND_ID_HEURISTICS) if (re.test(s)) return kind;
  return null;
}

/** True when the id looks like a non-chat model (embeddings / rerank / asr / tts / image / decision). Pure. */
export function looksNonChatModelId(id: string | undefined | null): boolean {
  return heuristicModelKind(id) !== null;
}

/** The kind the last detection established, or null. Pure. */
export function detectedModelKind(caps: DetectedCapabilities | undefined | null): EndpointModelKind | null {
  if (!caps || !Array.isArray(caps.results)) return null;
  const get = (c: DetectCapability) => caps.results.find(r => r.capability === c && r.ok && !r.skipped);
  if (get('chat_stream')?.value || get('tool_calling')?.value === true) return 'chat';
  if (get('typed_decisions')?.value === true) return 'decision';
  if (get('image_generation')?.value === true) return 'image';
  if (typeof get('embeddings')?.value === 'number') return 'embeddings';
  if (get('rerank')?.value === true) return 'rerank';
  return null;
}

/**
 * What the model IS: an explicit `kind` wins; the legacy [coding] flag asserts
 * chat; [image] / [typed decisions] assert their kinds; then the last
 * detection; then the id heuristic; else 'chat'. Pure — mirrors the backend.
 */
export function modelKindOf(m: Pick<EndpointModel, 'id' | 'kind' | 'coding' | 'image' | 'decision' | 'capabilities'> | null | undefined): EndpointModelKind {
  if (!m) return 'chat';
  if (m.kind && (ENDPOINT_MODEL_KINDS as readonly string[]).includes(m.kind)) return m.kind;
  if (m.coding === true) return 'chat';
  if (m.image === true) return 'image';
  if (m.decision === 'systemone_chat') return 'decision';
  return detectedModelKind(m.capabilities) ?? heuristicModelKind(m.id) ?? 'chat';
}

/** Selectable for the chat / agent / coding seats and Account → Coding. Pure. */
export function isChatCapableModel(m: Pick<EndpointModel, 'id' | 'kind' | 'coding' | 'image' | 'decision' | 'capabilities'> | null | undefined): boolean {
  return modelKindOf(m) === 'chat';
}

export interface ModelEndpointInput {
  label: string;
  /** 'openai_chat' (default) — OpenAI-compatible /chat/completions server;
   *  'systemone' — TypeSafe-compatible DECISION server (POST /systemone):
   *  TypeSafe Jev, or a self-hosted open-weight server — Laya (`laya-serve`),
   *  openjev (vLLM; CC BY-NC, testing only), JevK5 (`jevk5-serve`),
   *  NeoHorse-Jev (`neohorse-decision serve`) or Kev. Assignable only to the
   *  Decision gate seat (as its model, its fallback, or a per-purpose
   *  primary / challenger — see decisionBackendsApi);
   *  'systemone_chat' (2026-09-26) — a proxy that serves ONLY typed-decision
   *  models through POST /chat/completions with a `questions` map (LiteLLM
   *  fronting Laya). For a proxy that ALSO serves chat models (prod's
   *  `cql-litellm`) keep 'openai_chat' and flag the decision model
   *  `decision: 'systemone_chat'` instead — the documented way. */
  providerShape?: 'openai_chat' | 'systemone' | 'systemone_chat';
  baseUrl: string;
  apiKey?: string;
  models: EndpointModel[];
  /** Endpoint-level settings (2026-09-27): { maxTools } — the tool cap for every
   *  model on this endpoint without a per-model cap. */
  settings?: EndpointSettings | null;
  enabled?: boolean;
}

/** One model's "Detect capabilities" report (2026-09-27, backend capability-detect.ts). */
export interface DetectedModelReport {
  id: string;
  detectedAt: string;
  results: DetectedCapabilityResult[];
  /** The model entry AFTER detection applied its flags (what the backend persisted). */
  entry: EndpointModel;
  /** Flags detection changed on this run, e.g. ['maxTools=128', 'reasoningEffort=unsupported']. */
  changed: string[];
}

export interface DetectEndpointResult {
  endpointId: string;
  label: string;
  detectedAt: string;
  models: DetectedModelReport[];
}

export interface EndpointTestResult {
  ok: boolean;
  models?: string[];
  error?: string;
  /**
   * POST /chat/completions auth probe outcome — present only when the probe
   * ran (an API key is set AND the /models list was non-empty). 'failed'
   * always comes with ok:false + a distinct error: GET /models is served
   * without auth by several providers, so a green models list alone never
   * proved the key.
   */
  completionAuth?: 'ok' | 'failed';
  /**
   * The listed model that answered the auth probe — present only when the
   * probe fell back past earlier listed model(s) (ticket 1dc89d48): the
   * server's list order hides a dead/slow route.
   */
  probedModel?: string;
  /**
   * Human detail from a successful probe (ticket 2df5ed65): the typed-decision
   * shape note when the endpoint's decision model answered the decision-shaped
   * probe (a plain chat probe is the wrong shape for it, not a broken endpoint).
   */
  detail?: string;
}

export interface EndpointModelVerifyShapeResult {
  shape: 'chat_stream' | 'utility' | 'embeddings' | 'rerank' | 'decision';
  ok: boolean;
  latencyMs: number;
  detail?: string;
  error?: string;
}

/** A model-list sync's diff (ticket 780cd7a4, backend EndpointModelsSyncDiff):
 *  ids the server newly lists (added as bare entries), ids the server no longer
 *  lists (marked unservable "retired"), ids back on the server that stay
 *  retired (un-retiring is a human decision), and untouched ids. */
export interface EndpointModelsSyncDiff {
  added: string[];
  retired: string[];
  backButKeptRetired: string[];
  unchanged: string[];
}

export interface EndpointModelVerifyResult {
  model: string;
  results: EndpointModelVerifyShapeResult[];
}

export const modelEndpointsApi = {
  list: async (): Promise<ModelEndpoint[]> => {
    const response = await apiClient.get('/crossmodel/admin/model-endpoints');
    return response.data.data.endpoints;
  },

  create: async (input: ModelEndpointInput): Promise<ModelEndpoint> => {
    const response = await apiClient.post('/crossmodel/admin/model-endpoints', {
      ...input,
      providerShape: input.providerShape ?? 'openai_chat',
    });
    return response.data.data.endpoint;
  },

  update: async (id: string, patch: Partial<ModelEndpointInput>): Promise<ModelEndpoint> => {
    const response = await apiClient.patch(`/crossmodel/admin/model-endpoints/${id}`, patch);
    return response.data.data.endpoint;
  },

  remove: async (id: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/admin/model-endpoints/${id}`);
  },

  test: async (id: string): Promise<EndpointTestResult> => {
    const response = await apiClient.post(`/crossmodel/admin/model-endpoints/${id}/test`);
    return response.data.data;
  },

  /**
   * Model-list SYNC (ticket 780cd7a4): re-pull the endpoint's live /v1/models
   * server-side (stored key — never sent from here) and merge it into the row:
   * NEW ids are added as bare entries, row ids the server no longer lists are
   * marked unservable ("retired" — they stop resolving and never auto-route),
   * every other flag is preserved, and nothing is deleted. Returns the
   * sanitized endpoint + the sync diff { added, retired, backButKeptRetired,
   * unchanged }.
   */
  refresh: async (id: string): Promise<ModelEndpoint & { sync: EndpointModelsSyncDiff }> => {
    const response = await apiClient.post(`/crossmodel/admin/model-endpoints/${id}/refresh`);
    return response.data.data;
  },

  /** Per-model PARSE verification battery (chat_stream full-SSE parse /
   *  utility non-streaming / embeddings 1536-dim / rerank) — sequential,
   *  key-scrubbed. Proves a served model parses before it is seated as a
   *  fallback. */
  verify: async (id: string, modelId: string): Promise<EndpointModelVerifyResult> => {
    const response = await apiClient.post(`/crossmodel/admin/model-endpoints/${id}/verify`, { modelId });
    return response.data.data;
  },

  /**
   * Model auto-discovery for the add/edit dialog: GET <baseUrl>/models server-
   * side WITHOUT persisting anything. Pass endpointId (edit dialog, key field
   * untouched) to reuse the stored key; an explicit apiKey always wins.
   */
  probe: async (input: { baseUrl: string; apiKey?: string; endpointId?: string }): Promise<EndpointTestResult> => {
    const response = await apiClient.post('/crossmodel/admin/model-endpoints/probe', input);
    return response.data.data;
  },

  /**
   * Detect capabilities (2026-09-27): a bounded probe suite against EVERY model
   * of a SAVED endpoint (≤4 models at a time, ~20 s per probe) — chat streaming
   * shape, tool calling, max tools, reasoning_effort, thinking-by-default,
   * vision, embeddings dims, rerank, typed decisions, image generation (image
   * ids only), context window. The backend SETS the model flags with evidence
   * (never a flag in `manualFlags`) and persists them; the report carries each
   * model's entry after the run.
   */
  detect: async (id: string, capabilities?: string[]): Promise<DetectEndpointResult> => {
    const response = await apiClient.post(`/crossmodel/admin/model-endpoints/${id}/detect`, capabilities?.length ? { capabilities } : {}, {
      // Independent-review F-1 (2026-10-10): detect's DELIVERY is a buffered
      // JSON POST — by the same ALB idle-timeout premise that streamed the
      // seat Test (60 s, live-verified), a raised client timeout buys nothing
      // here: the request is cut at 60 s whatever we set, and the backend's
      // image probe would keep generating (billed) behind it. So the client
      // keeps the 55 s pre-change envelope (ROLE_TEST_CUSTOM_WAIT_MS — under
      // the ALB cut); a slow image backend's detect row lands as the probe's
      // typed 60 s-timeout evidence (value:false, evidence naming the budget)
      // and the [image] flag is only ever SET by detect, never cleared — use
      // the seat's Test button (the streamed twin, 180 s) to verify a slow
      // image backend end-to-end. Streaming the detect delivery is a separate
      // follow-up, deliberately out of this ticket's scope.
      timeout: Math.max(API_TIMEOUT_MS, ROLE_TEST_CUSTOM_WAIT_MS),
    });
    return response.data.data;
  },

  /** Detect capabilities for ONE model of a saved endpoint (same suite, same persistence). */
  detectModel: async (id: string, modelId: string, capabilities?: string[]): Promise<DetectEndpointResult> => {
    const response = await apiClient.post(`/crossmodel/admin/model-endpoints/${id}/detect/${encodeURIComponent(modelId)}`, capabilities?.length ? { capabilities } : {}, {
      // Independent-review F-1: same delivery-bound rationale as detect().
      timeout: Math.max(API_TIMEOUT_MS, ROLE_TEST_CUSTOM_WAIT_MS),
    });
    return response.data.data;
  },
};

// ── Model roles (which model serves each named seat: Digby, Double Checker,
//    Triple Checker, …; owner seat names 2026-09-15) ──

export interface ModelRole {
  key: string;
  persona: string;
  description: string;
  /** '' = "the built-in multi-provider chain" (utility/embeddings/rerank/asr/tts). */
  defaultModel: string;
  /** Set when the seat's unset value follows ANOTHER seat's resolved model (the
   *  view's defaultModel then already carries that resolved model). */
  inheritsFrom?: string;
  /** Worker seats (Architect / Explorer): '' = each lane's own coding model. */
  followsSession?: boolean;
  /** Owner 2026-09-15 "add custom fallback": true when the seat's runtime has
   *  a fallback seam the admin may point at their own model. */
  fallbackable: boolean;
  /** What happens on failure when NO custom fallback is set (plain words). */
  builtInFallback: string;
  /** The admin's custom fallback model, or null (built-in fallback behaviour). */
  fallback: string | null;
  /** False when a stored endpoint-spec fallback no longer resolves. */
  fallbackResolves: boolean;
  /** The stored override, or null when the role runs its default. */
  override: string | null;
  /** What the role actually runs right now (override || defaultModel). */
  effective: string;
  /** False when a stored endpoint-spec override no longer resolves (endpoint
   *  deleted/disabled/renamed) — the seat silently runs its default until fixed. */
  resolves: boolean;
  /** False when the effective model cannot serve on THIS instance (a built-in
   *  whose provider API key is missing — the keyless-Edge trap). */
  servable: boolean;
  unservableReason?: string;
  /** The exact backend .env variable to add for an unservable seat (e.g.
   *  'MOONSHOT_API_KEY') — the badge names it instead of "no API key". */
  missingEnvKey?: string;
  /** e5298647: on coding_default only — the VIEWING admin's own Account →
   *  Coding pick when it shadows this seat for their own sessions (stamps a
   *  different model than the seat's effective). Absent when no shadow exists. */
  viewerPick?: { stored: string; resolved: string };
  /** Built-in model ids this seat accepts (server-computed — the picker's
   *  "Built-in models" group; empty for non-chat seats). Absent on pre-2026-09-22
   *  backends — callers fall back to an empty list. */
  builtInOptions?: string[];
  /** 2026-09-27: the seat's configured model is LATCHED OFF by a deterministic
   *  invalid-request rejection (tools over the model's cap, reasoning_effort
   *  refused with tools, tools unsupported, unknown parameter, model not found,
   *  context too long) and runs on `to` until `until`. The row badges
   *  "seat unusable: <reason> — running on <to> since <since>". */
  latched?: { from: string; to: string; reason: string; fingerprint?: string; since: string; until: string };
  /** Seat governance (audit E3, 2026-09-27): 'frontier' when the EFFECTIVE
   *  model is a registry spec whose class is frontier (a frontier vendor host,
   *  or a proxy model id naming a closed frontier family). Present ONLY then —
   *  the seat keeps serving; the badge names it. Governance is observe-only
   *  by default (a `seat_governance` telemetry row); the opt-in
   *  FRONTIER_SEATS_REFUSE=1 makes the next SAVE of such a spec on a chat /
   *  supervisor seat a 400 (probes are never refused). */
  providerClass?: 'frontier';
  /** Same signal for the seat's custom fallback. Present ONLY when frontier. */
  fallbackProviderClass?: 'frontier';
  /** True (the default) = a frontier-class model may be saved on a governed
   *  seat; false = FRONTIER_SEATS_REFUSE=1 is set on this instance. Absent on
   *  pre-2026-09-27 backends (treated as allowed). */
  frontierSeatsAllowed?: boolean;
}

/** One built-in model with the call parameters the code fixes for it (the
 *  admin "model map", read-only — 2026-09-22). */
export interface BuiltInModelInfo {
  id: string;
  provider: string;
  envKey: string;
  present: boolean;
  supportsVision: boolean;
  mustStream: boolean;
  params: string;
  contextChars?: number;
  defaultFor: string[];
}

/** A fixed pipeline / fallback order that is not a single seat pick. */
export interface FixedChain {
  key: string;
  title: string;
  steps: string[];
  envKeys?: string[];
  seats?: string[];
}

/** One provider .env key the built-in seat defaults run on — presence only,
 *  never the value. */
export interface ProviderKeyStatus {
  envKey: string;
  provider: string;
  present: boolean;
  serves: string[];
}

export interface ModelRoleTestResult {
  ok: boolean;
  target: string;
  latencyMs: number;
  detail?: string;
  error?: string;
  /** Image generator seat only (2026-09-24): the probe's actual picture
   *  (smallest size the model serves) as base64 — the row renders it under
   *  the Test line so an admin SEES what the seat draws. */
  image?: { mediaType: string; data: string };
}

// ── Ticket 61d33af9 (2026-10-10): how long the client WAITS on a seat Test ──
// The backend's own probe budgets are the authority; the client must never cut
// a healthy-but-slow probe earlier than the backend would. Values mirror the
// backend: ROLE_TEST_TIMEOUT_MS (20 s built-ins), roleTestCustomTimeoutMs
// (55 s custom endpoints), imageProbeTimeoutMs (180 s image seat). Static
// mirrors, NOT live-read: a legitimately env-raised backend budget above these
// numbers still gets cut here — raise the mirror with the backend constant
// (the test-timeout pins live in ModelRolesSection.test.tsx's call-shape pins).
// 04c8ffd1 (2026-10-23): the image seat's wait now covers the custom leg's
// per-model ceiling (720 s leg + 60 s download allowance), not the 180 s probe
// budget — see IMAGE_TEST_WAIT_MS.
/** Built-in seat probe budget (backend ROLE_TEST_TIMEOUT_MS). */
export const ROLE_TEST_WAIT_MS = 20_000;
/** Custom-endpoint (`<label>:<model>`) seat probe budget (backend
 * roleTestCustomTimeoutMs default ROLE_TEST_CUSTOM_TIMEOUT_DEFAULT_MS). */
export const ROLE_TEST_CUSTOM_WAIT_MS = 55_000;
/** Image-generator seat client-side wait (a MAX-WAIT on the SSE Test reader,
 *  never a live-cut: the backend always writes its result frame, and the reader
 *  aborts here only if that frame never arrives). Ticket 61d33af9 raised the
 *  backend probe budget 55 s → 180 s; 04c8ffd1 (2026-10-23) raises this wait to
 *  810 s because a per-model imageTimeoutMs on the registry entry (or the
 *  IMAGE_CUSTOM_TIMEOUT_MS env) can raise the custom leg to 720 s + a 60 s
 *  download allowance on the probe path — the wait must cover the longest
 *  possible server-concluded probe. */
export const IMAGE_TEST_WAIT_MS = 810_000;
/** Grace over the budget before the streaming reader gives up (backend
 * IMAGE_PROBE_HARD_CAP_GRACE_MS + a round-trip allowance). */
export const STREAM_GRACE_MS = 15_000;

/** The client-side wait for a seat Test: image seat 810 s (04c8ffd1 — covers a
 *  per-model-raised custom leg, 720 s + download), any custom
 * (`<label>:<model>`) spec 55 s, built-ins 20 s — the backend's own budget,
 * so its typed timeout answers first when a model is genuinely dead. */
export function roleTestWaitMs(role: string, model?: string): number {
  if (role === 'image_generate') return IMAGE_TEST_WAIT_MS;
  return typeof model === 'string' && model.includes(':') ? ROLE_TEST_CUSTOM_WAIT_MS : ROLE_TEST_WAIT_MS;
}

/** One gated purpose of the decision gate with its stored (fleet-wide),
 *  env-only and effective mode (WI-S, 2026-09-25). */
export interface DecisionModeView {
  purpose: string;
  label: string;
  description: string;
  /** The stored fleet-wide mode, or null when the purpose runs its env/default mode. */
  storeMode: 'off' | 'shadow' | 'act' | null;
  /** What env alone gives on the answering backend process. */
  envMode: 'off' | 'shadow' | 'act';
  /** What the answering process runs right now. */
  effective: 'off' | 'shadow' | 'act';
  effectiveSource: 'disabled' | 'store' | 'env_purpose' | 'env_default' | 'default' | 'registry_cap' | 'retired_default';
  /** E12 (2026-09-25): the flip-readiness stamp the report wrote for this
   *  purpose (null = never stamped) and whether a PUT of `act` would be
   *  admitted right now. Absent on pre-E12 backends. */
  readiness?: { ready: boolean; at: string | null; metrics: Record<string, unknown>; reasons?: string[]; stale: boolean } | null;
  admission?: { admitted: boolean; reason?: string };
}

export interface DecisionModeConfig {
  purposes: DecisionModeView[];
  /** DECISION_GATE_DISABLED is set on the answering process — every purpose is off there. */
  gateDisabled: boolean;
  /** E12: DECISION_GATE_ADMISSION_DISABLED is set on the answering process — act is admitted without a readiness stamp. */
  admissionDisabled?: boolean;
}

/** Decision-gate modes: ONE stored row, read by every box (web A/B + worker C)
 *  within a 30 s cache — a flip is one PUT, fleet-wide, no env staging, no
 *  redeploy. GET /admin/model-roles/decision-modes; PUT { modes }. */
export const decisionGateApi = {
  listModes: async (): Promise<DecisionModeConfig> => {
    const response = await apiClient.get('/crossmodel/admin/model-roles/decision-modes');
    return response.data.data;
  },
  /** { <purpose>: 'off' | 'shadow' | 'act' | '' } — '' clears the stored mode (env/default applies again). */
  updateModes: async (modes: Record<string, string>): Promise<DecisionModeConfig> => {
    const response = await apiClient.put('/crossmodel/admin/model-roles/decision-modes', { modes });
    return response.data.data;
  },
  /** The latest flip-readiness stamp per purpose (E1 2026-09-25) — written by
   *  `npm run decision-gate:fit -- --stamp`; `purposes` null = never stamped. */
  readiness: async (): Promise<DecisionReadinessView> => {
    const response = await apiClient.get('/crossmodel/admin/model-roles/decision-readiness');
    return response.data.data;
  },
  /** The decision-role REGISTRY (rollout self-governance, 2026-09-27): every
   *  purpose with its tier, what it decides, the consumer site, what act does,
   *  the harness label, bars, caps and kill switches — joined with the live
   *  modes and the rollout automaton's view. */
  registry: async (): Promise<DecisionRegistryView> => {
    const response = await apiClient.get('/crossmodel/admin/model-roles/decision-registry');
    return response.data.data;
  },
  /** The rollout automaton's switch (SystemSetting decision_gate_auto_rollout) + ledger. */
  rollout: async (): Promise<DecisionRolloutView> => {
    const response = await apiClient.get('/crossmodel/admin/model-roles/decision-rollout');
    return response.data.data;
  },
  /** Flip the automaton on / off (idempotent, audited with the admin's identity). */
  setRollout: async (enabled: boolean): Promise<DecisionRolloutView> => {
    const response = await apiClient.put('/crossmodel/admin/model-roles/decision-rollout', { enabled });
    return response.data.data;
  },
};

/** One decision-role registry row (rollout self-governance, 2026-09-27) with the live modes joined. */
export interface DecisionRegistryRow {
  purpose: string;
  label: string;
  description: string;
  decides: string;
  consumerSite: string;
  consumer: string;
  actDoes: string;
  harnessLabel: string;
  question: string;
  questionShape: string;
  defaultThreshold: number;
  killSwitches: string[];
  ownerLock: string | null;
  /** 1 = flips to act automatically on a measured READY stamp; 2 = reported ready to the owner; 3 = never auto. */
  tier: 1 | 2 | 3;
  tierWhy: string;
  bars: { minLabels: number; minDays: number; minActBandN: number; minActBandPrecision: number; minAuroc: number; minCoverageAt5: number; controlGated: boolean };
  actCap: { since: string; why: string; liftEnv: string; active: boolean } | null;
  /** roster 2026-10-06 B-2: the purpose is no longer ASKED on human turns (machine turns still ask). Absent on an older backend. */
  retiredOnHumanTurns?: { since: string; why: string; sites: string; liftEnv: string; globalLiftEnv: string; active: boolean } | null;
  effective: 'off' | 'shadow' | 'act' | null;
  effectiveSource: string | null;
  storeMode: 'off' | 'shadow' | 'act' | null;
  readiness: { ready: boolean; at: string | null; stale: boolean; reasons?: string[] } | null;
  admission: { admitted: boolean; reason?: string } | null;
  primarySpec: string | null;
  parked: boolean;
  /** 2026-09-28 (owner: "add jev to api costs"): answered backend calls (memo hits excluded) and the USD the
   *  run_spend rows recorded for this purpose over the last 24 h; `pricedCalls24h` < `calls24h` = history the
   *  backfill has not minted yet. Absent on a pre-2026-09-28 backend. */
  calls24h?: number;
  costUsd24h?: number;
  pricedCalls24h?: number;
}

export interface DecisionRolloutAction { at: string; purpose: string; from: string; to: string; reason: string; bars?: Record<string, unknown>; by?: string }

export interface DecisionRolloutView {
  switch: { enabled: boolean; bootDefault: boolean; dryRun: boolean; jobDisabled: boolean; intervalMin: number; since: string | null; updatedBy: string | null };
  state: {
    lastRunAt: string | null;
    lastReadinessComputedAt: string | null;
    lastSummary: string | null;
    parked: Record<string, { until: string; reason: string; demotedAt: string[] }>;
    actions: DecisionRolloutAction[];
    ownerAsks: Record<string, { questionId: string; at: string; tier: 2 | 3 }>;
    inconsistencies: string[];
  };
  tierRule: string;
  recentDemotes: Array<{ purpose: string; at: string; precision: number | null; n: number | null; outcome: string }>;
}

export interface DecisionRegistryView {
  registry: DecisionRegistryRow[];
  rollout: DecisionRolloutView;
  tierRule: string;
  modes: { gateDisabled: boolean; admissionDisabled: boolean };
}

/** One purpose's flip-readiness verdict (E1): READY only when every §6 bar is met. */
export interface PurposeReadiness {
  ready: boolean;
  /** ISO time of the report that produced it. */
  at: string;
  backend: string;
  /** 2026-09-26: the SPEC the stamp was measured on — act is admitted only
   *  while it equals the purpose's effective primary. Absent on older stamps. */
  backendSpec?: string;
  /** Every bar missed, named (empty when ready). */
  reasons: string[];
  windowDays: number;
  partition: string;
  /** Per-purpose silent-degradation counters over the window (2026-09-26 audit; absent on older stamps):
   *  `downgraded` > 0 on an act purpose means asks ran the pre-gate path while the row said act. */
  health?: { calls: number; fails: number; downgraded: number; fellThrough: number; latched: number };
  metrics: {
    n: number;
    days: number;
    accuracy: number;
    brier: number;
    ece: number;
    auroc: number;
    coverageAt5: { coverage: number; threshold: number | null; n: number; errors: number };
    actBand: { n: number; correct: number; precision: number; coverage: number; threshold: number };
    positives: number;
    negatives: number;
    deduped: number;
    undedupable: number;
  };
}

/** One (purpose, backend) entry of the readiness job's stored report — the
 *  comparison table's row (2026-09-26 per-purpose backends + challengers).
 *  The numbers live under `metrics` on today's backend; a future flat shape is
 *  tolerated by `readinessEntryMetrics` (lib/decision-backends.ts). Every
 *  2026-09-26 field (backendSpec, role, calls, failRate, p50Ms, p95Ms) is
 *  OPTIONAL — pre-challenger reports omit them. */
export interface DecisionReadinessEntryMetrics {
  n: number;
  days?: number;
  /** Agreement with the outcome label (accuracy at the purpose's act cutoff). */
  accuracy: number;
  brier: number;
  ece: number;
  auroc: number;
  coverageAt5: { coverage: number; threshold: number | null; n: number; errors: number };
  actBand: { n: number; correct: number; precision: number; coverage: number; threshold: number };
  positives?: number;
  negatives?: number;
  /** Decision rows this backend answered in the window (ok + failed, challenger rows included). */
  calls?: number;
  /** Share of `calls` that errored / timed out (challenger_timeout counts). */
  failRate?: number;
  p50Ms?: number;
  p95Ms?: number;
}

export interface DecisionReadinessEntry {
  purpose: string;
  /** The backend LABEL as the row recorded it (e.g. "TypeSafe Jev (systemone)"). */
  backend: string;
  /** The backend SPEC (`jev`, `deepseek-flash`, `<label>:<modelId>`) — what the per-purpose config stores. Absent on pre-2026-09-26 reports. */
  backendSpec?: string;
  /** The backend's seat in the purpose's chain when the report ran. Absent on older reports — the page derives it from the stored config. */
  role?: 'primary' | 'challenger' | 'fallback';
  /** 2026-09-26 (audit): set ⇒ this entry holds only a NON-HUMAN segment's rows ('machine' | 'supervisor') — reported for visibility, never the stamp, never READY. */
  segment?: string;
  calibrated?: boolean;
  metrics?: DecisionReadinessEntryMetrics;
  ready: boolean;
  reasons?: string[];
}

export interface DecisionReadinessReport {
  computedAt: string;
  windowDays?: number;
  rows?: number;
  entries: DecisionReadinessEntry[];
}

export interface DecisionReadinessView {
  /** { <purpose>: PurposeReadiness }, or null when neither the worker job nor the fit script has stamped. */
  purposes: Record<string, PurposeReadiness> | null;
  stampedAt: string | null;
  /** ISO time of the worker's decision-gate-readiness job's latest STORED report (E1 job, 2026-09-25), or null; absent on older backends. */
  computedAt?: string | null;
  /** The job's latest stored report — every (purpose, backend) entry, the
   *  comparison table's source (2026-09-26). null / absent = the job has
   *  never run on this backend. */
  report?: DecisionReadinessReport | null;
  /** The job's cadence / window / kill switch as the backend reads its env; absent on older backends. */
  job?: { id: string; intervalMin: number; windowDays: number; disabled: boolean };
  bars: { minLabels: number; minDays: number; minActBandPrecision: number; minActBandN: number; minAuroc: number; minCoverageAt5: number; imessageMinPositives: number };
  stampDisabled: boolean;
  howTo: string;
  /** DOI-17 (2026-09-28): the 401/403 auth-latch state of the ANSWERING backend process (per process — the
   *  worker keeps its own map). null = DECISION_GATE_LATCH_VIEW_DISABLED on that backend; absent = older backend. */
  latches?: DecisionLatchView | null;
}

/** One latched decision backend (a 401/403 answer parks it for a cooldown; one probe ask per cooldown). */
export interface DecisionLatchEntry {
  key: string;
  spec: string;
  backend: string;
  status: number;
  since: string;
  at: string;
  until: string;
  /** true while the cooldown holds (or a half-open probe is in flight) — asks skip this backend. */
  holding: boolean;
  probing: boolean;
  relatches: number;
  remainingMs: number;
}

export interface DecisionLatchView {
  latches: DecisionLatchEntry[];
  cooldownMs: number;
  scope: 'process';
  at: string;
}

// ── Decision backends — per-purpose primary + challengers (2026-09-26, owner:
//    "support the open weight version of jev for testing different decision
//    models … we are self hosting laya now") ──

/** One backend the decision gate can call: a built-in (`jev`, `deepseek-flash`)
 *  or a registered endpoint model (`<label>:<modelId>`). */
export interface DecisionBackendCandidate {
  spec: string;
  /** 'systemone' = a TypeSafe-compatible POST /systemone server (Jev, Laya, JevK5, NeoHorse, openjev); 'logit' = a logprob readout on a chat server;
   *  'systemone_chat' (2026-09-26) = a typed-decision model reached through /chat/completions (a `systemone_chat` endpoint, or a model
   *  flagged [typed decisions] on an OpenAI-compatible endpoint — `cql-litellm:agx-laya`). */
  kind: 'systemone' | 'logit' | 'systemone_chat';
  label: string;
  /** Calibrated by construction / admin assertion (or a fitted temperature) — an uncalibrated backend's answer is downgraded to shadow on an act purpose. */
  calibrated: boolean;
  servable: boolean;
  unservableReason?: string;
}

/** The stored per-purpose backend config (store row ['instance','decision-gate']/backends). */
export interface DecisionBackendsConfig {
  /** { <purpose>: { primary?: spec, challengers?: spec[] } } — a purpose with no entry runs the seat chain.
   *  `challengers` STORED as `[]` = explicitly NONE (overrides defaultChallengers); ABSENT = inherit the defaults
   *  (backend platform/decision-gate-backends.ts `configuredChallengerSpecs`: `own ?? defaultChallengers`). */
  purposes: Record<string, { primary?: string; challengers?: string[] }>;
  /** Challengers for every purpose that names none of its own. */
  defaultChallengers?: string[];
  /** Per-(backend, purpose) fitted temperature `'<spec>|<purpose>'` — written by the readiness job (plan item A), read-only here. */
  temps?: Record<string, number>;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

/** One purpose as the backend's admin view reports it (platform/decision-gate-backends.ts
 *  DecisionBackendPurposeView): what is stored AND what actually runs. */
export interface DecisionBackendPurposeView {
  purpose: string;
  label: string;
  /** Stored per-purpose primary / challengers (null = unset → seat model / defaultChallengers). */
  primary: string | null;
  challengers: string[] | null;
  /** What runs: the configured primary, else the seat model. */
  effectivePrimary: string;
  /** The challengers that would run (before the answering-leg subtraction / cap). */
  effectiveChallengers: string[];
  /** The full chain spec order for the purpose (servability not applied). */
  chain: string[];
  /** The fleet-effective mode (store row, else env) — what a primary change would demote from. */
  mode: string;
}

/** GET (and PUT — the backend returns the same fresh view) /admin/model-roles/decision-backends.
 *  Every field but `config` / `candidates` / `purposes` is optional: the panel
 *  tolerates a backend that returns less (lib/decision-backends.ts
 *  `isDecisionBackendsView` / `coerceBackendsView`). */
export interface DecisionBackendsView {
  config: DecisionBackendsConfig;
  candidates: DecisionBackendCandidate[];
  /** Every gated purpose in registry order — the backend sends VIEW OBJECTS; a
   *  bare string[] (an older contract) is tolerated by lib/decision-backends.ts `purposeKeys`. */
  purposes: Array<DecisionBackendPurposeView | string>;
  /** The Decision gate seat's model / custom fallback as the backend resolved them. */
  seatModel?: string;
  seatFallback?: string;
  challengerMax?: number;
  challengerGraceMs?: number;
  /** 2026-09-26 (Laya follow-up): a detached challenger's own deadline from t0, and whether challengers are detached (zero added latency) on that process. */
  challengerTimeoutMs?: number;
  challengerDetached?: boolean;
}

/** PUT body: only the keys present change. Per purpose: `primary: ''` clears
 *  its primary (back to the seat chain); `challengers: null` clears its OWN
 *  list (the default challengers apply again); `challengers: []` = explicitly
 *  NONE (overrides the defaults); an absent key leaves that field untouched.
 *  `defaultChallengers: []` clears the defaults. Mirrors the backend's
 *  updateDecisionBackends (platform/decision-gate-backends.ts). */
export interface DecisionBackendsPatch {
  purposes?: Record<string, { primary?: string; challengers?: string[] | null }>;
  defaultChallengers?: string[];
}

/** Per-purpose primary + challengers: ONE stored row read by every box within
 *  30 s. GET/PUT /admin/model-roles/decision-backends. A primary change on an
 *  act purpose drops that purpose to shadow until the readiness job re-stamps
 *  the new backend (≤ 6 h). Challengers only ever ADD telemetry rows (their
 *  answers never act). Test a backend with modelRolesApi.test('decision', spec).
 *  `update` resolves to whatever the PUT returned — the backend sends the same
 *  view as GET, but callers must coerce (lib/decision-backends.ts
 *  `coerceBackendsView`) or re-GET rather than trust the shape. */
export const decisionBackendsApi = {
  get: async (): Promise<DecisionBackendsView> => {
    const response = await apiClient.get('/crossmodel/admin/model-roles/decision-backends');
    return response.data.data;
  },
  update: async (patch: DecisionBackendsPatch): Promise<Partial<DecisionBackendsView> | null | undefined> => {
    const response = await apiClient.put('/crossmodel/admin/model-roles/decision-backends', patch);
    return response.data?.data;
  },
};

export const modelRolesApi = {
  /** Roles + which provider .env keys are set on this instance (providerKeys
   *  is absent on pre-2026-09-05 backends — callers default it to []). */
  list: async (): Promise<{ roles: ModelRole[]; providerKeys: ProviderKeyStatus[]; builtIns: BuiltInModelInfo[]; chains: FixedChain[] }> => {
    const response = await apiClient.get('/crossmodel/admin/model-roles');
    return {
      roles: response.data.data.roles,
      providerKeys: response.data.data.providerKeys ?? [],
      builtIns: response.data.data.builtIns ?? [],
      chains: response.data.data.chains ?? [],
    };
  },

  /** Partial update: roles { <roleKey>: '<model spec>' | '' } ('' resets to the
   *  default) and/or fallbacks { <roleKey>: '<model spec>' | '' } ('' clears
   *  the custom fallback back to Digby's built-in behaviour). */
  update: async (roles: Record<string, string>, fallbacks: Record<string, string> = {}): Promise<ModelRole[]> => {
    const response = await apiClient.put('/crossmodel/admin/model-roles', {
      ...(Object.keys(roles).length ? { roles } : {}),
      ...(Object.keys(fallbacks).length ? { fallbacks } : {}),
    });
    return response.data.data.roles;
  },
  /**
   * 09a03aef: the same PUT, returning the advisory save-time warnings the
   * backend attached (an [image] seat model whose measured probe latency
   * implies > its chain timeout at chat sizes — the save proceeds, the admin
   * sees the line). Empty array when the backend sent none.
   */
  updateWithWarnings: async (roles: Record<string, string>, fallbacks: Record<string, string> = {}): Promise<{ roles: ModelRole[]; warnings: string[] }> => {
    const response = await apiClient.put('/crossmodel/admin/model-roles', {
      ...(Object.keys(roles).length ? { roles } : {}),
      ...(Object.keys(fallbacks).length ? { fallbacks } : {}),
    });
    return { roles: response.data.data.roles, warnings: Array.isArray(response.data.data.warnings) ? response.data.data.warnings : [] };
  },

  /**
   * Live connection test with the role's REAL call shape (chat completion
   * first-token probe / embeddings 1536-dim check / Cohere-style rerank /
   * multipart /audio/transcriptions with a tiny silent WAV).
   * `model` tests an unsaved candidate ('' = the built-in default); omitted =
   * the currently stored config. `fallback: true` tests the seat's custom
   * fallback slot instead of the seat itself.
   */
  test: async (role: string, model?: string, opts?: { fallback?: boolean }): Promise<ModelRoleTestResult> => {
    const response = await apiClient.post('/crossmodel/admin/model-roles/test', {
      role,
      ...(model === undefined ? {} : { model }),
      ...(opts?.fallback ? { fallback: true } : {}),
    }, {
      // Ticket 61d33af9: the instance default (45 s) is BELOW the probe budgets the
      // backend can now take (custom seats 55 s, the image seat 180 s) — a slow-but-
      // healthy probe reported "timeout" client-side before the backend answered.
      // The backend's own typed timeout is the authority; the client just waits.
      // The IMAGE seat uses testStream() below — this override covers the others.
      timeout: Math.max(API_TIMEOUT_MS, roleTestWaitMs(role, model)),
    });
    return response.data.data;
  },

  /**
   * Ticket 61d33af9 (2026-10-10): the STREAMING Test — POST
   * /crossmodel/admin/model-roles/test/stream as SSE. The image seat's probe
   * runs up to 180 s (real self-hosted image backends take ~118 s at the
   * OpenAI Images default shape), which outlives both the instance axios
   * timeout and every proxy idle window on the way (ALB 60 s); the backend
   * therefore flushes immediately and writes ': keepalive' comments every
   * 15 s, ending with ONE `data: {"type":"result",…}` frame. This reader
   * ignores keepalives, resolves on the result frame, and aborts at the
   * backend's budget + grace so a lost backend can never hang the button.
   */
  testStream: async (role: string, model?: string, opts?: { fallback?: boolean }): Promise<ModelRoleTestResult> => {
    const body = JSON.stringify({
      role,
      ...(model === undefined ? {} : { model }),
      ...(opts?.fallback ? { fallback: true } : {}),
    });
    // Independent-review F-5: fetch (not apiClient) cannot ride the axios
    // 401→refresh interceptor, so a stale access token would surface as a raw
    // "HTTP 401" — retry ONCE through the refresh endpoint (the same
    // { withCredentials } round-trip api-client.ts uses) before failing.
    const openStream = async (tokenOverride?: string): Promise<Response> => {
      const token = tokenOverride ?? (typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null);
      return fetch('/api/crossmodel/admin/model-roles/test/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body,
        credentials: 'include',
        signal: controller.signal,
      });
    };
    const controller = new AbortController();
    // Independent-review F-3: pass `model` (the sync twin's F2 fix) — only
    // IMAGE_ROLES ride the stream today and that branch ignores `model`, but
    // any future custom-spec seat routed here must get its 55 s budget, not 20 s.
    const budgetMs = roleTestWaitMs(role, model) + STREAM_GRACE_MS;
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      let response = await openStream();
      if (response.status === 401) {
        try {
          const refreshed = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
          if (refreshed.ok) {
            const j: any = await refreshed.json().catch(() => null);
            const fresh: string | undefined = j?.data?.accessToken;
            if (fresh) {
              try { localStorage.setItem('accessToken', fresh); } catch { /* private mode */ }
              response = await openStream(fresh);
            }
          }
        } catch { /* refresh failed — surface the original 401 below */ }
      }
      if (!response.ok || !response.body) {
        // Non-stream failures (403 admin gate, validation) arrive as JSON —
        // surface them like the axios path does.
        let message = `HTTP ${response.status}`;
        try {
          const j = await response.json();
          if (j?.error) message = j.error;
        } catch { /* not JSON */ }
        throw new Error(message);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 2);
          if (!frame.startsWith('data:')) continue; // ': keepalive' / ': open' comments
          try {
            const payload = JSON.parse(frame.slice(5).trim());
            if (payload?.type === 'result' && payload.result) {
              controller.abort(); // the terminal frame — stop the stream
              return payload.result as ModelRoleTestResult;
            }
          } catch { /* a malformed frame is ignored; the abort timer governs */ }
        }
        if (done) throw new Error('the stream ended before a result frame arrived');
      }
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Seats govern sessions (2026-09-28): "Apply seats to existing sessions" —
   * clears framework-stamped project overrides that point at built-ins,
   * re-stamps provenance-less live sessions to the Workspace default seat and
   * lists the explicit picks left alone. dryRun true (the preview) writes nothing.
   */
  applySeats: async (dryRun: boolean): Promise<SeatApplyReport> => {
    const response = await apiClient.post('/crossmodel/admin/model-roles/apply-seats', { dryRun });
    return response.data.data;
  },
};

export interface SeatApplyProjectRow { projectId: string; codingModel: string; source: 'user' | 'machine' | null; action: 'cleared' | 'kept'; reason: string }
export interface SeatApplySessionRow { sessionId: string; projectId: string; from: string; to: string; action: 'restamped' | 'explicit' | 'already_on_seat'; modelSource: string | null }
export interface SeatApplyPrefRow { userId: string; codingModel: string; action: 'explicit' | 'ignored' }
export interface SeatApplyReport {
  dryRun: boolean;
  seat: string;
  at: string;
  projects: { cleared: number; kept: number; rows: SeatApplyProjectRow[] };
  sessions: { restamped: number; explicit: number; alreadyOnSeat: number; rows: SeatApplySessionRow[] };
  prefs: { explicit: number; ignored: number; rows: SeatApplyPrefRow[] };
  errors: string[];
}

// ── Auto pools (dynamic roster phase 1, 2026-10-03) ──────────────────────────
// Per-lane ORDERED model lists the Auto roster planner picks from. An empty
// pool follows its seats (quick → Quick answers, lead → Digby, checker →
// Double Checker, colleague → Double + Triple Checker). Frontier-class models
// are never allowed (owner rule 2026-10-03: automatic picks use open models only).

export type AutoPoolRole = 'quick' | 'lead' | 'checker' | 'colleague';

/** One chat-capable model with its capability card (backend model-catalog.ts). */
export interface CatalogModelCard {
  spec: string;
  name: string;
  source: 'builtin' | 'registry';
  family: string;
  tier: 'fast' | 'standard' | 'strong';
  vision: boolean;
  contextChars: number | null;
  maxTools: number | null;
  priceIn: number | null;
  priceOut: number | null;
  frontier: boolean;
  autoEligible: boolean;
  servable: boolean;
  thinkingOff: boolean;
}

export interface EffectiveAutoPool {
  role: AutoPoolRole;
  models: string[];
  source: 'pool' | 'seats';
  dropped: Array<{ spec: string; reason: string }>;
}

export interface AutoPoolsView {
  config: { pools: Partial<Record<AutoPoolRole, string[]>>; updatedAt?: string; updatedBy?: string | null };
  effective: Record<AutoPoolRole, EffectiveAutoPool>;
  catalog: CatalogModelCard[];
  roles: Array<{ role: AutoPoolRole; label: string; seats: string[] }>;
  maxModels: number;
  disabled: boolean;
}

/** True for the full GET view (a pre-2026-10-03 backend 404s; a partial body hides the panel). */
export function isAutoPoolsView(v: unknown): v is AutoPoolsView {
  const x = v as AutoPoolsView | null;
  return !!x && typeof x === 'object' && !!x.config && !!x.effective && Array.isArray(x.catalog) && Array.isArray(x.roles);
}

// ── Reflection council (F2, owner 2026-10-06 late) ───────────────────────────
// Automatic picks never choose a frontier model; the ONE place frontier models
// run is the reflection council: after repeated failures an agent reflects and
// consults 1–3 frontier advisors of its choosing. The admin list below is only
// the DEFAULT the harness uses when the agent ignores its reflect note.

export interface FrontierCouncilModel {
  spec: string;
  name: string;
  family: string;
  tier: 'fast' | 'standard' | 'strong';
  priceIn: number | null;
  priceOut: number | null;
}

export interface ReflectionCouncilView {
  config: { models: string[]; updatedAt?: string; updatedBy?: string | null };
  /** Every servable frontier-class model (provider-diversity order). */
  candidates: FrontierCouncilModel[];
  /** What the harness auto-run consults right now. */
  defaults: string[];
  source: 'admin' | 'diversity';
  dropped: Array<{ spec: string; reason: string }>;
  maxModels: number;
  disabled: boolean;
  maxPerRun: number;
  sessionDailyCap: number;
}

/** True for the full GET view (an older backend 404s; a partial body hides the panel). */
export function isReflectionCouncilView(v: unknown): v is ReflectionCouncilView {
  const x = v as ReflectionCouncilView | null;
  return !!x && typeof x === 'object' && !!x.config && Array.isArray(x.candidates) && Array.isArray(x.defaults);
}

export const reflectionCouncilApi = {
  get: async (): Promise<ReflectionCouncilView> => {
    const response = await apiClient.get('/crossmodel/admin/model-roles/reflection-council');
    return response.data.data;
  },
  /** REPLACES the default list; [] = the provider-diversity default. */
  update: async (models: string[]): Promise<Pick<ReflectionCouncilView, 'config' | 'candidates' | 'defaults' | 'source' | 'dropped'>> => {
    const response = await apiClient.put('/crossmodel/admin/model-roles/reflection-council', { models });
    return response.data.data;
  },
};

export const autoPoolsApi = {
  get: async (): Promise<AutoPoolsView> => {
    const response = await apiClient.get('/crossmodel/admin/model-roles/auto-pools');
    return response.data.data;
  },
  /** Each listed role REPLACES that pool; [] or null = follow its seats again. */
  update: async (pools: Partial<Record<AutoPoolRole, string[] | null>>): Promise<{ config: AutoPoolsView['config']; effective: AutoPoolsView['effective'] }> => {
    const response = await apiClient.put('/crossmodel/admin/model-roles/auto-pools', { pools });
    return response.data.data;
  },
};

// ── Ghost mode endpoint (2026-10-22) ────────────────────────────────────────
// Per-chat "ghost mode" routes a chat's models to ONE admin-designated
// self-hosted endpoint (an "abliterated" unrestricted model) and keeps the
// chat out of memory / learning / cross-chat surfacing. THIS is the admin
// designation: which registry model the ghost chats run on, and whether the
// feature is offered at all. Guests and signed-in users toggle ghost mode per
// chat (or per guest session) client-side; the backend applies the routing.

export interface GhostEndpointView {
  /** The designated '<label>:<modelId>' registry spec, or null = none set. */
  spec: string | null;
  /** False = ghost mode is not offered (no endpoint designated / disabled). */
  enabled: boolean;
  /** When the designation was last saved (ISO). */
  updatedAt?: string;
}

/**
 * The view from a raw response body, tolerating BOTH shapes this client can
 * meet (review D1, 2026-10-22): the deployed backend wraps it —
 * `data: { config: { spec, enabled, updatedAt }, effective: {…} }` — while
 * the frozen contract describes the flat `{ spec, enabled, updatedAt }`.
 * Returns null when NEITHER shape holds (an older backend / partial body —
 * the caller hides its panel, exactly like isReflectionCouncilView).
 */
export function ghostEndpointViewFrom(v: unknown): GhostEndpointView | null {
  if (!v || typeof v !== 'object') return null;
  const x = v as { config?: unknown } & Record<string, unknown>;
  // The backend wrap: the designation rides `config` (effective = what a run
  // routes to right now — derived, not stored; the panel shows the stored row).
  const candidate = (x.config && typeof x.config === 'object') ? x.config as Record<string, unknown> : x;
  if (!('spec' in candidate) || !('enabled' in candidate)) return null;
  if (candidate.spec !== null && typeof candidate.spec !== 'string') return null;
  if (typeof candidate.enabled !== 'boolean') return null;
  const updatedAt = candidate.updatedAt;
  return {
    spec: (candidate.spec as string | null) ?? null,
    enabled: candidate.enabled,
    ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
  };
}

/** True for the GET view (an older backend 404s; a partial body hides the panel).
 *  Tolerates both the flat contract shape and the backend's { config, … } wrap. */
export function isGhostEndpointView(v: unknown): v is GhostEndpointView {
  return ghostEndpointViewFrom(v) !== null;
}

export const ghostEndpointApi = {
  get: async (): Promise<GhostEndpointView> => {
    const response = await apiClient.get('/crossmodel/admin/model-roles/ghost-endpoint');
    // Both the flat contract body and the backend's { config, effective } wrap
    // (review D1) — ghostEndpointViewFrom unwraps either; null throws here so
    // the caller's catch treats it as "older backend" and hides the panel.
    const view = ghostEndpointViewFrom(response.data?.data);
    if (!view) throw new Error('unexpected ghost-endpoint view');
    return view;
  },
  /**
   * Set (or clear with null) the designated spec and/or the enabled flag.
   * The backend REPLACES the designation: a body WITHOUT `spec` CLEARS it
   * (`req.body?.spec ?? null` → the empty-spec branch), so callers MUST always
   * send the spec alongside `enabled` (never { enabled } alone — that would
   * wipe the designation). 400s carry `{ error }` with a human reason
   * (unresolvable spec, non-chat model, not servable) — callers surface that text.
   */
  update: async (patch: { spec: string | null; enabled?: boolean }): Promise<GhostEndpointView> => {
    const response = await apiClient.put('/crossmodel/admin/model-roles/ghost-endpoint', patch);
    const view = ghostEndpointViewFrom(response.data?.data);
    if (!view) throw new Error('unexpected ghost-endpoint view');
    return view;
  },
};

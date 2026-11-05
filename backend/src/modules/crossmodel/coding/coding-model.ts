/**
 * Digby Code — open-source model resolver + streaming chat caller.
 *
 * ONLY open-source models are allowed in the coding pipeline (product decision):
 *   glm-5.3        → ZAI direct        (reasoning ALWAYS ON — thinking {type:'disabled'} now
 *                                       hard-fails the request; reasoning_effort max, owner 2026-09-03)
 *   deepseek-flash → DeepSeek direct   (DeepSeek V4.1 Flash, released 2026-09-10: 1M context,
 *                                       thinking ON by default + reasoning_effort max, function
 *                                       calling, NATIVE VISION. The vendor retired deepseek-v4-flash
 *                                       and routes deepseek-v4-pro here from 2026-09-14 — both
 *                                       legacy ids alias forward in normalizeCodingModel)
 *   kimi-k3        → Moonshot direct   (must stream; sampling fixed server-side — OMIT temperature;
 *                                       thinking always on; output cap via max_completion_tokens)
 *   kimi-k2.6      → Moonshot direct   (legacy — no pipeline references it since the 2026-08
 *                                       chat lineup change; kept for pre-K3 stored sessions;
 *                                       must stream; temperature 1)
 *   glm-5.3-flash  → ZAI direct        (vision utility: Image reader + PDF reader seats;
 *                                       reasons before answering — budget max_tokens)
 *   qwen3.6-flash  → DashScope direct  (Digby Kids seat default; fast, text-only)
 *
 * All three are OpenAI-compatible /chat/completions with function-calling. This
 * module streams one turn: it emits reasoning + content deltas via callbacks and
 * assembles any tool_calls from streamed fragments, returning them to the loop.
 */

import axios from 'axios';
import { StringDecoder } from 'string_decoder';
import logger from '../../../utils/logger';
import { logHandled } from '../../../utils/log-level';
import { parseCachedPromptTokens } from './prompt-cache-usage';
import { toParts } from './chat-images';
import { applyMoonshotCache, isCacheParamRejection, latchCacheParamsOff } from './moonshot-cache';
import { providerToolLimit, trimToolsToLimit, type ProviderClass } from './provider-limits';
import { noteRegistryPrice } from './cost';
import { hoistSystemMessages, isSystemOrderRejection, latchSystemFirst, systemFirstLatched, systemFirstNormalizeDisabled, ensureSystemFirstLatchHydrated } from './system-first';
import { resolveToolCallSlot, appendArgumentsFragment, argumentFragmentLength, unreadArgumentFragmentLength, uniqueToolCallId, mergeOrphanContinuations, diagnoseToolCallFinalize, UNRESOLVABLE_SLOT, DUPLICATE_FRAGMENT, type ToolCallSlot } from './tool-arguments'; // ticket 5bdbb126: index/id-aware slotting; 3b75ba8e: finished-slot closure; efdb3d31: fold an orphaned continuation slot back into its call, + the GATEWAY-OR-OURS received-byte rule (incl. the unread-shape counter that voids a false gateway verdict)
import { finalizeVerdictFields, finalizeVerdictSummary } from './tool-call-finalize-meta'; // efdb3d31: the verdict must survive a JSONB read (key order is canonicalised, so it rides a 2-char key), and the warn line is formatted by the SAME function so the two sinks cannot drift

/**
 * Ticket 5bdbb126 (review F2): handed to every tool call in a turn whose stream
 * could not be routed unambiguously. Deliberately unparseable so the executor
 * refuses each call — a fail-closed turn, never a mis-executed mutation.
 */
const AMBIGUOUS_STREAM_ARGUMENTS = '<<ambiguous tool-call stream — arguments could not be routed>>';

export type CodingModelId = 'glm-5.3' | 'deepseek-flash' | 'kimi-k3' | 'kimi-k2.6' | 'qwen3.6-27b' | 'glm-5.3-flash' | 'qwen3.6-flash';

/** Every built-in id the seat system may name (mirrored by model-roles
 *  BUILT_IN_MODEL_IDS — the drift test pins them equal). */
export const BUILT_IN_CODING_MODEL_IDS: readonly CodingModelId[] = ['glm-5.3', 'deepseek-flash', 'kimi-k3', 'kimi-k2.6', 'qwen3.6-27b', 'glm-5.3-flash', 'qwen3.6-flash'];

/** The fast HELPER tier for mechanical worker roles (scrape→markdown→RAG):
 *  no reasoning overhead, a fraction of the price, same tool-calling API. */
export const HELPER_MODEL: CodingModelId = 'qwen3.6-27b'; // helper tier (ingestor etc.) — validated on L1 2026-07-15; was deepseek-v4-flash

export function normalizeCodingModel(m: string | undefined | null): CodingModelId {
  // Legacy alias: sessions/prefs stored as glm-5.2 before the GLM-5.3 cutover
  // (owner 2026-09-03) auto-migrate to glm-5.3 — same pattern as the
  // kimi-k2.6 → kimi-k3 prefs migration, so no glm-5.2 provider entry remains.
  if (m === 'glm-5.2') return 'glm-5.3';
  // DeepSeek V4.1 Flash cutover (2026-09-10): the vendor retired deepseek-v4-flash
  // (temporarily routed to V4.1 Flash) and routes deepseek-v4-pro to V4.1 Flash
  // from 2026-09-14 12:00 Beijing — stored sessions/prefs/seat overrides on
  // either legacy id run on deepseek-flash with its real call shape.
  if (m === 'deepseek-v4-pro' || m === 'deepseek-v4-flash') return 'deepseek-flash';
  if (m === 'deepseek-flash' || m === 'kimi-k3' || m === 'kimi-k2.6' || m === 'qwen3.6-27b' || m === 'glm-5.3-flash' || m === 'qwen3.6-flash') return m;
  return 'glm-5.3';
}

export interface ProviderConfig {
  url: string;
  apiKey: string | undefined;
  model: string;
  label: string;
  /** The .env variable this provider's key comes from (built-ins only —
   *  custom endpoints carry their own stored key). Lets error messages and
   *  the admin UI name the EXACT variable to set instead of "an API key". */
  envKey?: string;
  extra: Record<string, any>;
  /** Base payload keys the provider REJECTS or fixes server-side (deleted after assembly). */
  omitParams?: string[];
  /** True when the model accepts image_url content parts (vision). Text-only
   *  models must be REJECTED at the API layer when images are attached. */
  supportsVision?: boolean;
  /**
   * Per-model running-transcript budget (chars, ~4/token) — the COMPACTION
   * TRIGGER for coding runs, sized to the model's real window. Deliberately
   * well under the raw window: the whole transcript is re-sent on EVERY step
   * (≤40/run), so prompt cost + prompt-processing latency scale with fill,
   * and long-context attention quality degrades near the limit. Compacted
   * material stays recoverable via search_memory. Omitted → profile default.
   */
  contextChars?: number;
  // ── 2026-09-27 seat/provider limits (custom endpoints; built-ins leave them unset) ──
  /** Tool cap the server accepts per request (registry model.maxTools >
   *  endpoint settings.maxTools > provider-class default — OpenAI-like ids
   *  128). The agent loop TRIMS its tool list to min(this, a cap learned from a
   *  live 400) — provider-limits.ts. Unset = unlimited. */
  maxTools?: number;
  /** How the registry resolved `maxTools`: 'model' (admin / detected flag),
   *  'endpoint' (settings.maxTools), 'class' (a DOCUMENTED provider-class cap).
   *  Telemetry prints it verbatim — never 'learned' unless a live 400 taught it. */
  maxToolsSource?: 'model' | 'endpoint' | 'class' | 'none';
  /** 2026-09-29 (owner: "max reasoning and max output tokens everywhere
   *  regardless of the litellm provider / endpoint"): 'auto' (registry
   *  default) = the seat sends reasoning_effort 'max' (the registry resolve puts
   *  it in `extra`) and a rejected value steps DOWN once and is latched
   *  (nextReasoningEffortAfterRejection); the provider-specific `thinking`
   *  switch is still stripped. 'supported' = every seat param flows through
   *  (incl. `thinking`). 'unsupported' = reasoning_effort omitted (the admin's
   *  explicit opt-out). Built-ins ignore it. */
  reasoningEffort?: 'supported' | 'unsupported' | 'auto';
  /** Provider class behind a custom endpoint (heuristic or admin override). */
  providerClass?: ProviderClass;
  /** audit 2026-10-08 W3-4: the registry spec ('<label>:<modelId>') a CUSTOM endpoint
   *  resolved from. Spend / token telemetry keys on it so one gateway model is ONE
   *  line (coding rows used to carry the bare modelId, chat rows the spec). Unset on
   *  built-ins. */
  spec?: string;
  /** audit 2026-10-06 T1-1: how a CUSTOM endpoint's `contextChars` was sized —
   *  'registry' (a published contextWindow on the model entry), 'family' (no
   *  window; the model id names a known built-in family — glm-5.3+, kimi-k3,
   *  deepseek-flash / v4+ — so the built-in's budget applies), 'default' (the
   *  conservative 160k). Rides the run's `context` event + `context_budget`
   *  loop_metrics row. Unset on built-ins and under the kill switch. audit
   *  2026-10-08 W2-3 adds 'model_info' (the gateway's LiteLLM /model/info
   *  window) and 'gateway_family' (a verified non-built-in family). */
  contextCharsSource?: ContextCharsSource;
}

/**
 * The model key spend / token telemetry uses for a provider (audit 2026-10-08
 * W3-4): the registry spec for a custom endpoint, the bare id for a built-in.
 * Kill switch SPEND_MODEL_KEY_NORMALIZE_DISABLED=1 restores the bare id.
 */
export function spendModelKeyNormalizeDisabled(): boolean {
  const v = String(process.env.SPEND_MODEL_KEY_NORMALIZE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
export function spendModelKey(p: Pick<ProviderConfig, 'model' | 'spec'>): string {
  return !spendModelKeyNormalizeDisabled() && p.spec ? p.spec : p.model;
}

/** audit 2026-10-06 T1-1 — see ProviderConfig.contextCharsSource. audit
 *  2026-10-08 W2-3 adds 'model_info' (the gateway's own LiteLLM /model/info
 *  max_input_tokens, read at run time — coding/gateway-model-info.ts) and
 *  'gateway_family' (a non-built-in family with a verified window —
 *  GATEWAY_CONTEXT_FAMILIES). */
export type ContextCharsSource = 'registry' | 'model_info' | 'family' | 'gateway_family' | 'default';

/** audit 2026-10-08 W2-3: the INFERRED sizings — never a window the registry
 *  entry publishes — that the agent loop's size-rejection ceiling
 *  (learnContextCharCeiling) may correct downward. Pure. */
export function isInferredContextSource(src: ContextCharsSource | string | undefined | null): boolean {
  return src === 'family' || src === 'gateway_family' || src === 'model_info';
}

/** The predicate every custom-endpoint seam keys on (helper-completion's
 *  isCustomEndpoint is the same test — kept here too so this module needs no
 *  import from helper-completion, which imports this one). */
export function isCustomEndpointProvider(p: Pick<ProviderConfig, 'label'>): boolean {
  return String(p?.label ?? '').endsWith('(custom endpoint)');
}

export function resolveProvider(modelId: CodingModelId): ProviderConfig {
  switch (modelId) {
    case 'qwen3.6-27b':
      // L1 chat tier experiment (owner, 2026-07-15): a small fast model for
      // simple questions + normal tool calls. DashScope intl OpenAI-compatible
      // endpoint supports function calling + streaming.
      return {
        url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
        apiKey: process.env.DASHSCOPE_API_KEY,
        model: 'qwen3.6-27b',
        envKey: 'DASHSCOPE_API_KEY',
        label: 'DashScope intl (Qwen)',
        extra: { temperature: 0.5 },
        contextChars: 120_000,   // ~30k tok of a 128k window (helper tier stays lean)
        supportsVision: true,
      };
    case 'qwen3.6-flash':
      // Qwen 3.6 Flash (DashScope intl): the Digby Kids seat's built-in default
      // (2026-09-22 seat cutover — was a hardcoded constant in
      // qwen-kid.integration.ts). Fast, cheap, calm at low temperature; the
      // kid path streams it with its own max_tokens. Text-only here.
      return {
        url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
        apiKey: process.env.DASHSCOPE_API_KEY,
        model: 'qwen3.6-flash',
        envKey: 'DASHSCOPE_API_KEY',
        label: 'DashScope intl (Qwen 3.6 Flash)',
        extra: { temperature: 0.5 },
        contextChars: 120_000,
      };
    case 'glm-5.3-flash':
      // GLM-5.3 Flash (ZAI): the natively-multimodal member of the GLM-5
      // series — the built-in default for the Image reader + PDF reader (OCR)
      // seats (2026-09-22 seat cutover — was the hardcoded VISION_UTILITY_MODEL
      // in image-describe.ts). Thinking cannot be disabled (400 code 1210);
      // reasoning_effort low|high|max (default max) — the vision-utility
      // contract runs LOW: verified live 2026-09-22 it spends 0-8 reasoning
      // tokens on OCR yet got every table cell right, and it is the cheap fast
      // path ($0.15/$0.50 per M). Seat callers may raise it per call. Accepts
      // image_url parts AND whole PDFs as `file` parts (data URI ≤50 MB);
      // max_tokens up to 131,072; tool_choice 'auto' only.
      return {
        url: 'https://api.z.ai/api/paas/v4/chat/completions',
        apiKey: process.env.ZAI_API_KEY,
        model: 'glm-5.3-flash',
        envKey: 'ZAI_API_KEY',
        label: 'ZAI direct (GLM-5.3 Flash)',
        extra: { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
        contextChars: 400_000,
        supportsVision: true,
      };
    case 'deepseek-flash':
      // DeepSeek V4.1 Flash (api-docs.deepseek.com, released 2026-09-10): the
      // vendor's single current model — outperforms V4 Pro on their evals at
      // ~1/4 the price, 1M context, 384K max output, thinking DEFAULT-ON with a
      // per-call `thinking:{type:'disabled'}` switch (the fast seats use it via
      // helper-completion / utility-llm), function calling, native vision.
      // Agent seats keep reasoning_effort 'max' (owner 2026-09-03 directive for
      // every DeepSeek reasoning call site).
      return {
        url: 'https://api.deepseek.com/chat/completions',
        apiKey: process.env.DEEPSEEK_API_KEY,
        model: 'deepseek-flash',
        envKey: 'DEEPSEEK_API_KEY',
        label: 'DeepSeek direct',
        // max_tokens 65536 (2026-09-11): reasoning tokens count against
        // max_tokens on thinking models — the 16k runModelTurn default let a
        // 'max'-effort final turn spend everything thinking and return EMPTY
        // content (the glm-5.3 supervisor-seat failure). 384K max output here.
        // 2026-09-29 (owner: max output everywhere): the vendor's range is
        // [1, 393216] (live-probed) — maxOutputTokensFor.
        extra: { reasoning_effort: 'max', thinking: { type: 'enabled' }, max_tokens: maxOutputTokensFor('deepseek-flash') },
        contextChars: 4_000_000, // ~1M tok — VERIFIED LIVE 2026-09-10: a 916k-token needle request answered correctly in 23s on our key
        supportsVision: true,    // VERIFIED LIVE 2026-09-10: image_url data-URL part answered correctly
      };
    case 'kimi-k3':
      // Kimi K3 (released 2026-07-16, per platform.kimi.ai docs): sampling params
      // are FIXED server-side — temperature/top_p are pinned (1.0/0.95) and ANY
      // explicit value returns an error, so they must be omitted (unlike K2.6's
      // required temperature:1). Thinking is ALWAYS ON; reasoning_effort accepts
      // 'low'/'high'/'max' (default 'max' — platform.kimi.ai models-overview +
      // use-reasoning-effort, verified 2026-09-20; the launch-era max-only
      // contract was widened), so it is omitted and the seat runs at max. Output
      // cap uses max_completion_tokens (max_tokens is the K2.x param — stripped
      // below).
      // Bounded capability seats may pass 'low' per call (seat-call.ts sets the
      // knob for kimi-k3 explicitly since this entry omits it).
      return {
        url: 'https://api.moonshot.ai/v1/chat/completions',
        apiKey: process.env.MOONSHOT_API_KEY,
        model: 'kimi-k3',
        envKey: 'MOONSHOT_API_KEY',
        label: 'Moonshot direct',
        // 65,536 (ticket 22c309f4, 2026-09-20): K3's reasoning stream counts
        // against max_completion_tokens — the 16,384 cap let a max-effort turn
        // spend everything thinking and return EMPTY content (4 real recoveries
        // on 2026-09-13 with 67-71k-char reasoning traces; turn-recovery.ts).
        // Vendor default is 131,072 / max 1,048,576, so 65,536 (deepseek-seat
        // parity + the truncation-recovery floor) stays well inside contract —
        // and a cap is a ceiling, not a reservation: only actual output bills.
        // 2026-09-29 (owner: max output everywhere): 262,144 — the vendor
        // accepts up to 1,048,576 (= the whole window, live-probed), but input +
        // output must fit that window; Digby's K3 transcript budget is ~200k
        // tokens, so 262k is the largest cap that can never overflow it.
        extra: { max_completion_tokens: maxOutputTokensFor('kimi-k3') },
        contextChars: 800_000,   // ~200k tok of K3's 1M window — the big-context option; raise further once per-step cost/latency at high fill is validated
        // K3 rejects params outside its fixed contract, and a payload 400 is
        // unrecoverable in the turn retry path — strip stream_options too
        // (usage falls back to the char estimate) until prod-verified on K3.
        omitParams: ['max_tokens', 'stream_options'],
        supportsVision: true,
      };
    case 'kimi-k2.6':
      return {
        url: 'https://api.moonshot.ai/v1/chat/completions',
        apiKey: process.env.MOONSHOT_API_KEY,
        model: 'kimi-k2.6',
        envKey: 'MOONSHOT_API_KEY',
        label: 'Moonshot direct',
        extra: { temperature: 1 }, // kimi-k2.6 requires temperature=1
        contextChars: 400_000,   // ~100k tok of a 256k window
        supportsVision: true,
      };
    case 'glm-5.3':
    default:
      // GLM-5.3 (ZAI, API live 2026-08-18; cutover owner 2026-09-03): reasoning
      // is ALWAYS ON — `thinking: { type: 'disabled' }` now hard-fails the
      // request, so thinking must stay enabled everywhere. reasoning_effort
      // levels are low|high|max; the coding agent runs 'max' (owner directive).
      // GLM-5.3 flagship is TEXT-ONLY (vision = glm-5.3-flash, see
      // image-describe.ts) — supportsVision deliberately unset.
      return {
        url: 'https://api.z.ai/api/paas/v4/chat/completions',
        apiKey: process.env.ZAI_API_KEY,
        model: 'glm-5.3',
        envKey: 'ZAI_API_KEY',
        label: 'ZAI direct',
        // max_tokens 65536 (2026-09-11, owner: the Fleet Supervisor on this
        // seat "returned no output" on 23 of 124 wakes): GLM-5.3's thinking
        // counts against max_tokens (128K max output); at reasoning_effort
        // 'max' a long final note spent the 16k runModelTurn default entirely
        // on reasoning and came back finish_reason 'length' with EMPTY content.
        // 2026-09-29 (owner: max output everywhere): the vendor's range is
        // [1, 131072] (live-probed) — maxOutputTokensFor.
        extra: { thinking: { type: 'enabled' }, reasoning_effort: 'max', temperature: 0.6, max_tokens: maxOutputTokensFor('glm-5.3') }, // temp 0.6 carried from 5.2 — no vendor contraindication found
        contextChars: 4_000_000, // ~1M tok — GLM-5.3's real window (docs.z.ai; VERIFIED LIVE 2026-09-10: a 1.15M-token request answered 200 on our key). Prompt caching ($0.26/M cached input) keeps high-fill refills affordable.
      };
  }
}

/**
 * Provider-message content: plain text, or OpenAI-style parts (text + image_url)
 * for vision turns. The array shape is only ever sent to vision-capable models —
 * ZAI/glm rejects non-string content, so the sanitizer collapses single-text-part
 * arrays back to a plain string (keeps today's traffic byte-identical).
 */
export type ModelContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type ModelContent = string | ModelContentPart[];

/** True when the model can see images (attach-images gate at the API layer). */
export function modelSupportsVision(id: CodingModelId): boolean {
  return resolveProvider(id).supportsVision === true;
}

// ── Digby Edge (Phase 2): custom endpoint registry ───────────────────────────
// A codingModel of '<label>:<modelId>' resolves against the admin-managed
// model_endpoints registry (model-endpoints.service.ts) — an enabled,
// coding-capable row yields a ProviderConfig pointed at that server. Built-in
// ids never contain ':' and skip the registry ENTIRELY: with no registry rows
// the run path is byte-identical to before. The service is loaded via dynamic
// import so this module's load-time graph stays unchanged (jest workers exit
// if config/env is pulled in transitively — see .digby/notes/learnings.md).

/** Default transcript budget for registry models (unknown real windows). */
const REGISTRY_CONTEXT_CHARS = 160_000; // ~40k tok — conservative until measured
/** Fleet cap for any model's transcript budget (the 1M-token built-ins). */
const REGISTRY_CONTEXT_CHARS_MAX = 4_000_000;

/** Transcript budget from a published context window (tokens): ~50% of the
 *  window in chars (4 chars/token × 0.5), never below the default, never above
 *  the fleet cap. Unknown → the default. Pure. */
export function registryContextChars(contextWindowTokens: number | undefined | null): number {
  if (typeof contextWindowTokens !== 'number' || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return REGISTRY_CONTEXT_CHARS;
  return Math.max(REGISTRY_CONTEXT_CHARS, Math.min(REGISTRY_CONTEXT_CHARS_MAX, Math.floor(contextWindowTokens * 2)));
}

// ── Context budget by MODEL FAMILY (audit 2026-10-06 T1-1) ───────────────────
// Every lane and supervisor seated on the owner's LiteLLM gateway
// (`cql-litellm:api-optimize-zai-glm-5.3`, fallback `…moonshot-kimi-k3`) ran
// at the 160k-char registry DEFAULT — no gateway entry carries a contextWindow
// and LiteLLM's /v1/models publishes none — while the SAME model on the
// built-in seat runs at 4,000,000 chars. 7,426 compactions in 48 h on 30
// gateway lanes vs 28 on 2 built-in lanes; supervisors clamped to 160k by the
// chat-profile min(); runs re-reading what compaction evicted for hours. The
// OUTPUT budget already infers the family from the model id
// (MAX_OUTPUT_FAMILIES, 2026-09-29); the context budget now does too: a
// registry model with NO published window whose id names a known family gets
// that built-in's contextChars (read from resolveProvider, so it never drifts
// from the built-in table), floored at the registry default and capped at the
// fleet cap. Ordered — first match wins; smaller variants come first so a
// "-flash" never inherits the flagship's window, and size-reduced variants
// (air / mini / lite / nano / tiny / small) stay on the default. Families
// whose built-in budget is BELOW the registry default (qwen3.6 = 120k — a
// deliberate "helper tier stays lean" choice, not the window) are not listed:
// they would change nothing. Pre-5.3 GLM (200k windows) and pre-V4 DeepSeek
// (64–128k) are deliberately NOT matched. A family budget that overshoots a
// self-hosted server's max_model_len is corrected by the agent loop's
// size-rejection ceiling (agent.ts, family budgets only).
// Kill switch REGISTRY_CONTEXT_FAMILY_DISABLED=1 restores the 160k default
// (and drops the source field) byte-for-byte.
const CONTEXT_FAMILIES: ReadonlyArray<readonly [RegExp, CodingModelId | null]> = [
  [/(?:^|[^a-z0-9])glm-5\.(?:[3-9]|\d{2,})(?:\.\d+)?-flash(?![a-z0-9])/i, 'glm-5.3-flash'],
  [/(?:^|[^a-z0-9])glm-5\.(?:[3-9]|\d{2,})(?:\.\d+)?-(?:air|mini|lite|nano|tiny|small)(?![a-z0-9])/i, null],
  [/(?:^|[^a-z0-9])glm-5\.(?:[3-9]|\d{2,})(?![0-9])/i, 'glm-5.3'],
  [/(?:^|[^a-z0-9])kimi-k3(?![a-z0-9])/i, 'kimi-k3'],
  [/(?:^|[^a-z0-9])deepseek-(?:flash|v4|v[5-9])(?![0-9])/i, 'deepseek-flash'],
];
export function registryContextFamilyDisabled(): boolean {
  const v = String(process.env.REGISTRY_CONTEXT_FAMILY_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
// ── Context budget for GATEWAY families with no built-in (audit 2026-10-08 W2-3) ──
// The 10-06 family table above only maps ids onto BUILT-INS (glm / kimi-k3 /
// deepseek), so every other family on the owner's LiteLLM gateway stayed on
// the 160k default — the One Piece lane's project-pinned
// `cql-litellm:api-alibaba-qwen3.8-max` logged 650 compactions in 18 h (76 % of
// the fleet's), re-read files 35× per run and spent $63 on one feature. These
// rows carry a budget for families with VERIFIED windows (sources below), as
// "~X tok of the window" choices matching the built-in table's own posture:
//   - hosted Qwen 3.7+ max / plus / flash SKUs (Alibaba Model Studio):
//     Qwen3.8-Max 983,616 tokens (~1M) — runtimewire.com/models/qwen/qwen3.8-max,
//     noqta.tn "qwen3-8-max developer guide 2026"; Qwen3.8-Flash 1M (hosted;
//     the open Qwen3.8-Flash-Next checkpoint is 262,144 native) —
//     help.aliyun.com/en/model-studio/qwen3-8-flash, openrouter.ai qwen3.8-flash;
//     Qwen3.7-Plus 1M / 992K on DashScope — vercel.com/ai-gateway qwen3.7-plus.
//     Budget 800,000 chars — the SAME "~200k tok of a ~1M window" choice the
//     built-in kimi-k3 entry makes (big-context option, per-step cost bounded:
//     Qwen3.8-Max bills $2/M input). Only SKUs with NO further suffix: the
//     self-hosted `-next` checkpoints, size-tagged `-27b` builds and the `-open`
//     route are not the hosted model and stay on the default.
//   - Xiaomi node-b V2.6 Flash (mimo-v26-flash-rl, spark-mimo-v26-flash-rl):
//     hosted window 1,048,576 tokens (openrouter.ai/xiaomi/mimo-v2.6-flash), but
//     the RL variants are self-hosted — 400,000 chars (~100k tok), conservative.
//   - Moonshot kimi-for-coding: ~256k window — 400,000 chars (~100k tok), the
//     built-in kimi-k2.6 entry's own choice for a 256k window.
// A budget that overshoots a deployment is corrected by the agent loop's
// size-rejection ceiling exactly like 'family' (isInferredContextSource). Kill
// switch REGISTRY_CONTEXT_GATEWAY_FAMILY_DISABLED=1 (this table only);
// REGISTRY_CONTEXT_FAMILY_DISABLED=1 still restores the 160k default for every
// inferred sizing.
export interface GatewayContextFamily { key: string; windowTokens: number; chars: number }
const GATEWAY_CONTEXT_FAMILIES: ReadonlyArray<readonly [RegExp, GatewayContextFamily]> = [
  [/(?:^|[^a-z0-9])qwen3\.(?:[7-9]|\d{2,})-(?:max|plus|flash)(?![a-z0-9-])/i, { key: 'qwen3.7+-hosted', windowTokens: 983_616, chars: 800_000 }],
  [/(?:^|[^a-z0-9])mimo-v2?\.?6-flash/i, { key: 'mimo-v2.6-flash', windowTokens: 1_048_576, chars: 400_000 }],
  [/(?:^|[^a-z0-9])kimi-for-coding(?![a-z0-9])/i, { key: 'kimi-for-coding', windowTokens: 262_144, chars: 400_000 }],
];
export function registryContextGatewayFamilyDisabled(): boolean {
  const v = String(process.env.REGISTRY_CONTEXT_GATEWAY_FAMILY_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
/** The gateway family (non-built-in) a registry model id sizes like, or null. Pure. */
export function gatewayContextFamilyFor(modelId: string | undefined | null): GatewayContextFamily | null {
  const id = String(modelId ?? '');
  if (!id) return null;
  for (const [re, fam] of GATEWAY_CONTEXT_FAMILIES) if (re.test(id)) return fam;
  return null;
}
/** The built-in a registry model id belongs to for CONTEXT sizing, or null. Pure. */
export function contextFamilyFor(modelId: string | undefined | null): CodingModelId | null {
  const id = String(modelId ?? '');
  if (!id) return null;
  for (const [re, builtIn] of CONTEXT_FAMILIES) if (re.test(id)) return builtIn;
  return null;
}

// ── Kimi K3 reasoning replay BY FAMILY (build 2026-10-08 Q-2) ────────────────
// Moonshot's Preserved-Thinking contract (ticket 22c309f4): every replayed
// assistant message must carry its reasoning_content as-is — stripping it
// degrades multi-step tool use. agent.ts matched only the bare built-in id
// 'kimi-k3', so the owner's gateway Kimi seat
// (`cql-litellm:api-optimize-moonshot-kimi-k3`) replayed NO reasoning on any
// turn. A custom endpoint whose model id names the Kimi K3 family (the same
// CONTEXT_FAMILIES rule that sizes its window) now replays it too. A gateway
// that rejects the field (a 400 naming reasoning_content) gets ONE retry
// without it and the replay is latched OFF for that (endpoint, model) for the
// process — the run never sees the rejection. Kill switch
// KIMI_REASONING_REPLAY_FAMILY_DISABLED=1 restores the bare-id match.
export function kimiReasoningReplayFamilyDisabled(): boolean {
  const v = String(process.env.KIMI_REASONING_REPLAY_FAMILY_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
const reasoningReplayRejected = new Set<string>();
const replayLatchKey = (p: Pick<ProviderConfig, 'url' | 'model'>) => `${String(p.url ?? '').toLowerCase()}::${p.model}`;
export function latchReasoningReplayOff(p: Pick<ProviderConfig, 'url' | 'model'>): void { reasoningReplayRejected.add(replayLatchKey(p)); }
export function reasoningReplayLatchedOff(p: Pick<ProviderConfig, 'url' | 'model'>): boolean { return reasoningReplayRejected.has(replayLatchKey(p)); }
export function __resetReasoningReplayLatchForTests(): void { reasoningReplayRejected.clear(); }
/** Does this provider's assistant history carry reasoning_content back (Kimi K3 Preserved Thinking)? */
export function replaysReasoning(p: Pick<ProviderConfig, 'model' | 'url' | 'label'>): boolean {
  if (p.model === 'kimi-k3') return true; // the built-in (and an exact-id custom endpoint) — unchanged
  if (kimiReasoningReplayFamilyDisabled() || !isCustomEndpointProvider(p)) return false;
  return contextFamilyFor(p.model) === 'kimi-k3' && !reasoningReplayLatchedOff(p);
}
/** A 400 body that REJECTS the replayed reasoning field (an unknown / extra / forbidden field) —
 *  never the opposite complaint ("reasoning_content is missing …"), which stripping would worsen. */
export const REASONING_CONTENT_REJECTION_RE = /reasoning[_ -]?content[^\n]{0,160}(?:not (?:permitted|allowed|supported)|extra (?:inputs?|fields?)|unexpected|unknown|unrecognized|invalid|additional propert)|(?:extra (?:inputs?|fields?)|unexpected|unknown|unrecognized|additional propert)[^\n]{0,160}reasoning[_ -]?content/i;
const REASONING_CONTENT_REQUIRED_RE = /reasoning[_ -]?content[^\n]{0,40}\b(?:is\s+)?(?:missing|required)\b|(?:missing|required)[^\n]{0,40}reasoning[_ -]?content/i;
/** True when a 400 detail rejects the replayed field (and does not ask for it). */
export function isReasoningContentRejection(detail: string): boolean {
  const d = String(detail ?? '');
  return REASONING_CONTENT_REJECTION_RE.test(d) && !REASONING_CONTENT_REQUIRED_RE.test(d);
}
/** The request messages with every reasoning_content field dropped (a copy; input untouched). */
export function stripReasoningContent(messages: any[]): any[] {
  return (Array.isArray(messages) ? messages : []).map((m) => {
    if (m && typeof m === 'object' && 'reasoning_content' in m) {
      const { reasoning_content: _r, ...rest } = m;
      return rest;
    }
    return m;
  });
}
/**
 * A registry model's transcript budget + where it came from (audit 2026-10-06
 * T1-1): a published window wins ('registry'); else the model id's built-in
 * family ('family' — live-verified budgets); else (audit 2026-10-08 W2-3) the
 * gateway's own /model/info window when the caller read one ('model_info');
 * else a verified gateway family ('gateway_family'); else the conservative
 * default ('default'). Under
 * the REGISTRY_CONTEXT_FAMILY_DISABLED kill switch every inferred step is
 * skipped and `source` is omitted (the pre-fix ProviderConfig shape). Pure
 * (reads the env per call).
 */
export function registryContextBudget(
  contextWindowTokens: number | undefined | null,
  modelId: string | undefined | null,
  /** audit 2026-10-08 W2-3: the gateway's LiteLLM /model/info max_input_tokens
   *  for this model (gateway-model-info.ts), when the run path read one. */
  modelInfoTokens?: number | null,
): { chars: number; source?: ContextCharsSource } {
  const familyOff = registryContextFamilyDisabled();
  const published = typeof contextWindowTokens === 'number' && Number.isFinite(contextWindowTokens) && contextWindowTokens > 0;
  if (published) return { chars: registryContextChars(contextWindowTokens), ...(familyOff ? {} : { source: 'registry' as const }) };
  if (familyOff) return { chars: REGISTRY_CONTEXT_CHARS };
  // The built-in family (glm-5.3+ / kimi-k3 / deepseek v4+) keeps its LIVE-VERIFIED
  // budget (audit 2026-10-06 T1-1): a gateway /model/info value is often LiteLLM's
  // generic model-map default, and a smaller one would re-open the 10-06
  // compaction storm on the GLM / Kimi lanes.
  const family = contextFamilyFor(modelId);
  const familyChars = family ? resolveProvider(family).contextChars : undefined;
  if (typeof familyChars === 'number' && familyChars > REGISTRY_CONTEXT_CHARS) {
    return { chars: Math.min(REGISTRY_CONTEXT_CHARS_MAX, familyChars), source: 'family' };
  }
  // audit 2026-10-08 W2-3: for every other model the gateway's own window beats the id-inferred table.
  if (typeof modelInfoTokens === 'number' && Number.isFinite(modelInfoTokens) && modelInfoTokens > 0) {
    return { chars: registryContextChars(modelInfoTokens), source: 'model_info' };
  }
  const gw = registryContextGatewayFamilyDisabled() ? null : gatewayContextFamilyFor(modelId);
  if (gw) return { chars: Math.min(REGISTRY_CONTEXT_CHARS_MAX, Math.max(REGISTRY_CONTEXT_CHARS, gw.chars)), source: 'gateway_family' };
  return { chars: REGISTRY_CONTEXT_CHARS, source: 'default' };
}

/** audit 2026-10-08 W2-3: the gateway-published window for a registry model
 *  with NO published contextWindow — null when one is published, under either
 *  kill switch, under jest (unless opted in), or on any failure. */
async function registryModelInfoTokens(reg: { contextWindow?: number | null; baseUrl?: string; url?: string; apiKey?: string; model: string }): Promise<number | null> {
  try {
    const published = typeof reg.contextWindow === 'number' && Number.isFinite(reg.contextWindow) && reg.contextWindow > 0;
    if (published || registryContextFamilyDisabled()) return null;
    // A built-in family sizing wins over /model/info (registryContextBudget) — never wait on a fetch it would ignore.
    const fam = contextFamilyFor(reg.model);
    if (fam && (resolveProvider(fam).contextChars ?? 0) > REGISTRY_CONTEXT_CHARS) return null;
    const m = await import('./gateway-model-info');
    if (!m.gatewayModelInfoRuntimeEnabled()) return null;
    const baseUrl = reg.baseUrl || String(reg.url ?? '').replace(/\/chat\/completions\/?$/i, '');
    return await m.gatewayModelInfoWindow({ baseUrl, apiKey: reg.apiKey ?? null, model: reg.model });
  } catch {
    return null;
  }
}

/** Chat-capable registry resolution (2026-09-27 — "coding is a seat choice, not
 *  a model capability"): the resolver's `chatCapable` when present, else the
 *  legacy `coding` flag (older mocks / rows resolved before the field existed). */
export function registryChatCapable(reg: { chatCapable?: boolean; coding?: boolean } | null | undefined): boolean {
  if (!reg) return false;
  if (typeof reg.chatCapable === 'boolean') return reg.chatCapable;
  return reg.coding === true;
}

/**
 * The thinking-disable directive for OpenAI-compatible self-hosted servers
 * (vLLM / SGLang / llama.cpp honor `chat_template_kwargs.enable_thinking` for
 * Qwen3-family templates; LiteLLM forwards it to vLLM). Owner report
 * 2026-09-08: a default-thinking Qwen3-4B on the Helper seat spent its whole
 * non-streaming budget reasoning and returned EMPTY digests. Sent when the
 * admin flags a registry model "no-think", and tried-then-latched-off by the
 * non-streaming helper path for every custom endpoint (helper-completion.ts).
 */
export const THINKING_OFF_EXTRA = { chat_template_kwargs: { enable_thinking: false } } as const;

/**
 * DeepSeek's own switch. The built-in agent-seat entry carries
 * `thinking:{type:'enabled'}` + `reasoning_effort:'max'`; the FAST seats (the
 * Helper tier's workers, the utility override leg, web/youtube digests, the
 * admin role tester) must not inherit that — V4.1 Flash thinks by default and a
 * 512-1400 token budget burns entirely on reasoning (the 2026-09-04 class).
 * Verified live 2026-09-10: disabled → zero reasoning tokens.
 */
export const DEEPSEEK_THINKING_OFF_EXTRA = { thinking: { type: 'disabled' } } as const;
export function isDeepSeekBuiltInProvider(p: ProviderConfig): boolean {
  return !p.label.endsWith('(custom endpoint)') && /^https:\/\/api\.deepseek\.com\//i.test(p.url);
}
/**
 * DashScope's own switch for its Qwen3-family built-ins. Probe QTH1020 (2026-10-20, from the live backend):
 * qwen3.6-27b reasons ~1.4–2.1k tokens by default before a web_pipe digest — 25–36 s per call vs 5–7 s with it
 * off, same answer length (qwen3.6-flash thinks too, 12–17 s). utilityChat's DashScope leg already sends it
 * (2026-09-04); the fast seats never did. FAST_SEAT_QWEN_THINKING_OFF_DISABLED=1 restores the untouched payload.
 */
export const DASHSCOPE_THINKING_OFF_EXTRA = { enable_thinking: false } as const;
export function isDashScopeQwenBuiltInProvider(p: ProviderConfig): boolean {
  return !p.label.endsWith('(custom endpoint)') && /^https:\/\/dashscope(-intl)?\.aliyuncs\.com\//i.test(p.url) && /^qwen3/i.test(p.model);
}
export function fastSeatQwenThinkingOffDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FAST_SEAT_QWEN_THINKING_OFF_DISABLED === '1';
}
/** The fast-seat shape of a provider: DeepSeek built-ins lose reasoning extras
 *  and get thinking switched off; DashScope Qwen3 built-ins get `enable_thinking:
 *  false`; everything else is returned untouched (GLM cannot disable thinking,
 *  custom endpoints carry their own no-think flag).
 *  The agent-seat `max_tokens` (65536, 2026-09-11) exists only to give the
 *  THINKING room — a no-think seat drops it too and falls back to the
 *  runModelTurn default (16k), so mechanical Helper work keeps its old cap. */
export function fastSeatProvider(p: ProviderConfig): ProviderConfig {
  // 2026-09-29: a custom-endpoint FAST seat does not inherit the agent seats'
  // reasoning_effort 'max' (parity with the built-in fast seats, which run
  // thinking off); it keeps the max output budget.
  if (isCustomEndpointProvider(p) && p.extra && 'reasoning_effort' in p.extra) {
    const { reasoning_effort: _fastEffort, ...restExtra } = p.extra as Record<string, any>;
    return { ...p, extra: restExtra };
  }
  if (isDashScopeQwenBuiltInProvider(p) && !fastSeatQwenThinkingOffDisabled()) {
    return { ...p, extra: { ...(p.extra ?? {}), ...DASHSCOPE_THINKING_OFF_EXTRA } };
  }
  if (!isDeepSeekBuiltInProvider(p)) return p;
  const { reasoning_effort: _reasoningEffort, max_tokens: _thinkingBudget, ...rest } = (p.extra ?? {}) as Record<string, any>;
  return { ...p, extra: { ...rest, ...DEEPSEEK_THINKING_OFF_EXTRA } };
}

/**
 * Async, registry-aware provider resolution for the coding run path. Anything
 * that is not a valid, enabled, coding-capable '<label>:<modelId>' registry
 * spec falls back to the built-in switch (normalizeCodingModel → glm-5.3).
 * `opts.fastSeat` asks for the Helper-seat shape (see fastSeatProvider) — the
 * delegate path sets it for helper-tier workers so a DeepSeek Helper does not
 * run mechanical work at reasoning_effort 'max'.
 */
export async function resolveProviderForRun(model: string | undefined, userId?: string, opts?: { fastSeat?: boolean }): Promise<ProviderConfig> {
  const p = await resolveProviderForRunInner(model, userId);
  return opts?.fastSeat ? fastSeatProvider(p) : p;
}

async function resolveProviderForRunInner(model: string | undefined, userId?: string): Promise<ProviderConfig> {
  if (model && model.includes(':')) {
    try {
      const { resolveRegistryModel } = await import('../model-endpoints/model-endpoints.service');
      const reg = await resolveRegistryModel(model, userId);
      if (reg && registryChatCapable(reg)) {
        // audit 2026-10-06 T1-1: published window > model family > default.
        // audit 2026-10-08 W2-3: with no published window: the built-in family,
        // then the gateway's own LiteLLM /model/info window (gateway-model-info.ts
        // — cached per endpoint, awaited ≤ 1.5 s, never throws), then the
        // gateway family table, then the default.
        const modelInfoTokens = await registryModelInfoTokens(reg);
        const ctxBudget = registryContextBudget(reg.contextWindow, reg.model, modelInfoTokens);
        // build 2026-10-08 Q-1: the endpoint entry's usdPerMTokIn/Out (when set) prices this spec in the run meter.
        noteRegistryPrice(model.trim(), { in: reg.usdPerMTokIn, out: reg.usdPerMTokOut });
        return {
          url: reg.url,
          apiKey: reg.apiKey,
          model: reg.model,
          spec: model.trim(),
          label: `${reg.label} (custom endpoint)`,
          // Admin-flagged "no-think" models get the disable directive on EVERY
          // call (streaming workers + non-streaming helper/utility seats).
          // 2026-09-29 (owner: "max reasoning and max output tokens everywhere
          // regardless of the litellm provider / endpoint"): every model gets
          // its MAX output (maxOutputTokensFor — live-probed vendor limits)
          // and a thinking model gets reasoning_effort 'max'
          // (customEndpointEffortExtra; a rejected value steps down + latches).
          extra: reg.thinkingOff
            ? { ...THINKING_OFF_EXTRA, ...customEndpointThinkingBudgetExtra(reg.model) }
            : { ...customEndpointThinkingBudgetExtra(reg.model), ...customEndpointEffortExtra(reg) },
          // 2026-09-27: a published context window (tokens, from /models
          // metadata via Detect capabilities) sizes the transcript budget at
          // ~50% of the window (chars ≈ 4/token × 0.5), inside the fleet cap;
          // unknown windows keep the conservative default — unless the model
          // id names a known built-in family (audit 2026-10-06 T1-1).
          contextChars: ctxBudget.chars,
          ...(ctxBudget.source ? { contextCharsSource: ctxBudget.source } : {}),
          supportsVision: reg.supportsVision,
          // 2026-09-27 seat/provider limits (resolved by the registry:
          // model > endpoint > provider-class default).
          ...(typeof reg.maxTools === 'number' && reg.maxTools > 0 ? { maxTools: reg.maxTools, maxToolsSource: reg.maxToolsSource } : {}),
          reasoningEffort: reg.reasoningEffort ?? 'auto',
          ...(reg.providerClass ? { providerClass: reg.providerClass } : {}),
        };
      }
      // A colon-spec that misses the registry must SAY what it falls back to
      // and why — the silent version of this fallback hid the 68b1aba3
      // stamping bug (Edge runs 401'd on keyless ZAI with no hint in logs).
      logger.warn(`resolveProviderForRun: custom-endpoint spec "${model}" did not resolve to an enabled chat-capable registry model (${reg ? `the model entry is registered as a ${reg.kind ?? 'non-chat'} model, not a chat model` : 'no enabled registry row / model entry'}) — falling back to built-in ${normalizeCodingModel(model)}`, { source: 'run-model-turn' });
    } catch { /* registry unavailable → built-ins */ }
  }
  return resolveProvider(normalizeCodingModel(model));
}

/**
 * Model-roles seam (Digby Edge): the spec a named SEAT runs on — the admin's
 * instance-wide override (model-roles.service) or the built-in fallback.
 * Dynamic import + fail-open for the same reason as resolveRegistryModel
 * above: the run path must survive a missing/broken config module, and this
 * module's load-time graph must stay unchanged for jest workers.
 */
export async function resolveRoleModelForRun(role: string, fallback: string): Promise<string> {
  try {
    const { resolveRoleModel } = await import('../model-endpoints/model-roles.service');
    return (await resolveRoleModel(role as any)) || fallback;
  } catch { return fallback; }
}

/**
 * The admin's OVERRIDE for a seat, and nothing else (review F2, 2026-10-27):
 * '' when the seat is UNTOUCHED — unlike resolveRoleModelForRun this never
 * substitutes the built-in default. Callers that must only act on an
 * EXPLICIT admin declaration (the chat lead's vision upgrade consulting the
 * vision_describe seat) use this: reading the EFFECTIVE model would return
 * the built-in (e.g. glm-5.3-flash) on every untouched instance and
 * displace the guaranteed built-in upgrade. Same dynamic-import + fail-open
 * posture as resolveRoleModelForRun ('' = treat as no override).
 */
export async function roleOverrideForRun(role: string): Promise<string> {
  try {
    const { getModelRoleOverrides } = await import('../model-endpoints/model-roles.service');
    return (await getModelRoleOverrides())[role] || '';
  } catch { return ''; }
}

/**
 * The admin's CUSTOM fallback model for a seat (owner 2026-09-15 "add custom
 * fallback") — the spec that should serve when the seat's own model fails —
 * or '' when none is configured (Digby's built-in fallback behaviour stands).
 * Same dynamic-import + fail-open posture as resolveRoleModelForRun.
 */
export async function resolveRoleFallbackForRun(role: string): Promise<string> {
  try {
    const { resolveRoleFallback } = await import('../model-endpoints/model-roles.service');
    return (await resolveRoleFallback(role)) || '';
  } catch { return ''; }
}

/** Thrown by the chat lane's seat pre-flight when a seat cannot be served on
 *  this instance — the detached-run catch surfaces its message VERBATIM to the
 *  user (a config problem needs the fix named, not "try again"). */
export class SeatUnservableError extends Error {}

/**
 * Digby Edge honesty check (owner report 2026-09-04): can this model spec be
 * SERVED on this instance? Returns null when yes, else a human-readable
 * reason. Keyless CUSTOM endpoints are legitimate (Ollama/llama.cpp); a
 * BUILT-IN provider without its env key can only 401 — on a keyless Edge box
 * that used to surface as a 401 compact-and-retry crawl ending in an opaque
 * ⚠︎ note (or a checker "draft" made of error text). Fail-open on config
 * hiccups: this must never block a run the provider could actually serve.
 */
export async function seatUnservableReason(model: string | undefined, userId?: string): Promise<string | null> {
  return (await seatServability(model, userId)).reason;
}

/**
 * Structured servability (owner ask 2026-09-05): the reason NAMES the exact
 * .env variable to set, and `missingEnvKey` carries it separately so the admin
 * UI can badge "add MOONSHOT_API_KEY" instead of a generic "no API key".
 */
export async function seatServability(
  model: string | undefined,
  userId?: string,
): Promise<{ reason: string | null; missingEnvKey?: string }> {
  try {
    const p = await resolveProviderForRun(model, userId);
    if (p.apiKey || p.label.endsWith('(custom endpoint)')) return { reason: null };
    const need = p.envKey
      ? `needs the ${p.envKey} environment variable (${p.label}), which is not set on this instance`
      : `needs a ${p.label} API key that is not set on this instance`;
    return {
      reason: model?.includes(':')
        ? `"${model}" no longer resolves to an enabled endpoint model, and the built-in fallback (${p.model}) ${need}`
        : `its model "${p.model}" ${need}`,
      ...(p.envKey ? { missingEnvKey: p.envKey } : {}),
    };
  } catch {
    return { reason: null };
  }
}

/** Async vision gate: registry models honor their entry's vision flag. */
export async function modelSupportsVisionForRun(model: string | undefined, userId?: string): Promise<boolean> {
  if (model && model.includes(':')) {
    try {
      const { resolveRegistryModel } = await import('../model-endpoints/model-endpoints.service');
      const reg = await resolveRegistryModel(model, userId);
      if (reg) return reg.supportsVision;
    } catch { /* registry unavailable → built-in answer */ }
  }
  return modelSupportsVision(normalizeCodingModel(model));
}

export interface StreamedToolCall {
  id: string;
  /** INTERNAL tool name (the agent loop maps a model-facing alias back here). */
  name: string;
  arguments: string; // raw JSON string (assembled from fragments)
  /** The name exactly as the model emitted it when it differs from `name`
   *  (tool-scope.ts disambiguation) — replayed verbatim in the assistant record. */
  emittedName?: string;
}

export interface TurnResult {
  content: string;
  reasoning: string;
  toolCalls: StreamedToolCall[];
  finishReason: string | null;
  errorMessage?: string; // set only when the caller synthesizes an error turn
  errorStatus?: number;  // HTTP status from the provider, when available
  /** The provider's OWN parsed reason for a rejected request (one line,
   *  bounded), recovered from the drained error body — e.g. Moonshot's
   *  {"error":{"message":"…"}}. Absent when the body was empty/unusable.
   *  Ticket 189cfeb9: a status-only note blamed "too large or malformed" on a
   *  ~4h Moonshot 400-incident window; the real cause sat in the body the
   *  harness already drained but never surfaced. */
  providerError?: string;
  /** The provider's own requested wait before retrying, in ms — parsed from the
   *  Retry-After response header (delta-seconds or HTTP-date) on a rejected
   *  turn when sent. Absent when the provider sent no usable header. The
   *  transient backoff lane treats it as a FLOOR (ticket cffaa701): the fixed
   *  table alone expired inside every provider rate window during the
   *  2026-09-14 glm-5.3 throttle incident (six worker deaths in ~1.5h). */
  retryAfterMs?: number;
  /** EFDB3D31 EMISSION SIGNAL — did the SSE stream reach its OWN terminator?
   *
   *  `true`  : we saw the `data: [DONE]` sentinel, so the transport finished
   *            the way the OpenAI-compatible protocol says it must.
   *  `false` : the stream closed WITHOUT it (end/close/abort) — the gateway
   *            severed the connection mid-payload. Any tool call still in
   *            `toolCalls` was built from a partial delta run and its
   *            arguments may be arbitrarily short (measured 17/39/41/67/84
   *            byte cuts on the llm-cql custom-endpoint path).
   *  `undefined`: the provider never uses the sentinel on this path (some
   *            LiteLLM configs just close), or this TurnResult was synthesized
   *            by a caller. Callers must treat undefined as "no information"
   *            and NOT as a failure — the C-2 dispatch-reject-repair lane is
   *            the deliberate protection for that ambiguity.
   *
   *  WHY IT MATTERS (measured, not stylistic): before this field, `finish()`
   *  resolved on `end` and `close` alike, so a severed stream was byte-for-byte
   *  indistinguishable from a clean finish. A half-built `goal_update`
   *  (`{"goalId": "8f0dcd6f-9469-48a7-87a9-8bb`) then reached the executor as
   *  if the model had declared the turn COMPLETE with `finish_reason:
   *  'tool_calls'` — which is exactly what every stored row reads. */
  streamCompleted?: boolean;
  /** EFDB3D31 CRITERION 1 — the per-fragment arithmetic, carried OFF the
   *  finalize seam so it can ride the DISPATCH_REJECT row as well.
   *
   *  WHY THIS HAD TO MOVE (measured 2026-10-30, post-deploy): the whole
   *  gateway-or-ours diagnosis already existed, but only on the sibling
   *  `tool_call_finalize` row written inside this function. A call that was
   *  REJECTED therefore carried `argLen` (a dispatched length) with no
   *  gateway side to compare it against — so the rejection row could not say
   *  whether those bytes ever arrived. The two rows are written milliseconds
   *  apart from the same turn, but only one of them is the row a reader
   *  follows when asking "why was this call rejected?".
   *
   *  LENGTHS AND COUNTS ONLY — never payload bytes, same discipline as the
   *  finalize row. Absent when the turn ended before the finalize seam ran
   *  (cancelled, or an ambiguous accumulator, where the arithmetic would be
   *  meaningless rather than merely unknown). */
  streamTrace?: {
    /** Sum of `function.arguments` lengths on deltas we PARSED. */
    receivedBytes: number;
    /** What actually landed in the slots. */
    accumulatedBytes: number;
    /** receivedBytes - accumulatedBytes. */
    droppedBytes: number;
    /** Deltas that carried argument bytes at all. */
    fragments: number;
    /** Un-drained SSE tail at finish(). */
    undrainedBufferBytes: number;
    /** "0:7" = slot → fragments that ROUTED into it. */
    assemblyTrace: string;
    /** Deltas that carried no usable `index`. */
    deltasWithoutIndex: number;
    /**
     * Bytes a delta carried in a shape this accumulator cannot READ
     * (efdb3d31, 2026-10-30) — legacy `function_call.arguments`, a top-level
     * `arguments`. Invisible to BOTH sides of received-vs-accumulated, so a
     * non-zero count VOIDS the gateway verdict (see unreadArgumentFragmentLength).
     */
    unreadArgBytes: number;
    /**
     * Lines the SSE frame reader skipped BEFORE any counter ran (firing 6).
     * Those bytes enter NEITHER side of received-vs-accumulated, so a non-zero
     * count VOIDS the gateway verdict. Carried onto the turn result because a
     * cut turn is REJECTED, and the reject row is where blame is adjudicated.
     */
    skippedRawLines: number;
    skippedRawBytes: number;
    /** Events split across several `data:` lines (the spec joins them; this reader does not). */
    multilineDataEvents: number;
    /** `data:` frames that failed JSON.parse, and how many carried tool-call bytes (`pc`). */
    parseFailLines: number;
    parseFailToolCalls: number;
  };
  /** Provider-reported token usage from the stream's final chunk, when sent.
   *  `cachedTokens` = prompt tokens served from the provider's context cache
   *  (Moonshot `usage.cached_tokens` — billed at ~10% of the input rate; see
   *  moonshot-cache.ts). Absent when the provider doesn't report it. */
  usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number };
}

export interface StreamCallbacks {
  onReasoning?: (delta: string) => void;
  onContent?: (delta: string) => void;
}

/**
 * Extract a one-line, bounded provider error reason from a drained HTTP error
 * body. Handles the OpenAI-style {"error":{"message":…}} shape (Moonshot,
 * DeepSeek), GLM's {"error":{"code","message"}}, flat {"message":…} and
 * {"error":"…"}, and falls back to the raw text when the body isn't JSON.
 * Whitespace-collapsed and capped so it is safe to embed in a user-facing
 * note or a metric meta. '' when the body carries nothing usable.
 */
export function extractProviderErrorDetail(body: string, cap = 300): string {
  const raw = (body || '').trim();
  if (!raw) return '';
  let msg = '';
  try {
    const j = JSON.parse(raw);
    const e = j?.error;
    if (typeof e === 'string') msg = e;
    else if (e && typeof e.message === 'string') msg = e.message;
    else if (typeof j?.message === 'string') msg = j.message;
  } catch { /* not JSON — fall through to the raw text */ }
  if (!msg) msg = raw;
  msg = msg.replace(/\s+/g, ' ').trim();
  return msg.length > cap ? `${msg.slice(0, cap)}…` : msg;
}

/**
 * Parse a Retry-After response header value (RFC 9110 §10.2.3: delta-seconds
 * or HTTP-date) into milliseconds-from-now. Axios lower-cases header names, so
 * callers pass `err?.response?.headers?.['retry-after']`. Returns undefined
 * when the value is absent/unparseable (a missing header must never CHANGE the
 * backoff); a past HTTP-date clamps to 0 (the window already ended — retry
 * immediately). Ticket cffaa701: the transient lane uses this as a wait FLOOR
 * so a provider-stated rate window is honored instead of hammered.
 */
export function parseRetryAfterHeader(raw: unknown, nowMs = Date.now()): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = (Array.isArray(raw) ? String(raw[0] ?? '') : String(raw)).trim();
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const ms = Math.round(parseFloat(s) * 1000);
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
  }
  // HTTP-date branch — gated on a real date SHAPE first: Date.parse is
  // notoriously lenient ('-5' parses as a date in V8), and a garbage header
  // must never CHANGE the backoff. IMF-fixdate / RFC-850 / asctime all carry
  // a 3-letter month or weekday name; ISO-8601 starts with a 4-digit year.
  if (!/[A-Za-z]{3}/.test(s) && !/^\d{4}-\d{2}-\d{2}/.test(s)) return undefined;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, t - nowMs);
  return undefined;
}

// Degeneration guard: open-source models sometimes fall into a repetition loop —
// emitting the same sentence hundreds of times. Left unchecked it wastes tokens
// AND poisons the transcript (that giant assistant message pushes the next request
// over the context window → 400s on every resume). We abort the stream when the
// prose runs absurdly long or a suffix keeps repeating.
const MAX_CONTENT_CHARS = 40_000;      // hard cap on a single turn's prose (tool args excluded)
const REPEAT_UNIT_CHARS = 120;         // length of the suffix probed for repetition
const REPEAT_WINDOW_CHARS = 1600;      // look-back window the suffix is counted in
const REPEAT_MIN_OCCURRENCES = 6;      // this many repeats of the suffix ⇒ degenerate
export const REPEAT_LINE_MIN_CHARS = 40; // a repeated LINE must be at least this long to count (short bullets/table separators repeat legitimately)
const REPEAT_LINE_MIN_OCCURRENCES = 5; // this many copies of one long line in a turn ⇒ degenerate

/**
 * The content payload of an SSE `data:` line for the RAW-TEXT fallback path
 * (gateways that stream plain tokens instead of OpenAI JSON chunks). Strips a
 * trailing CR (CRLF streams), the `data:` field name, and exactly ONE optional
 * leading space (per the SSE spec) — everything else, including inter-token
 * spaces, is preserved verbatim so multi-token prose reassembles correctly.
 * Pure + exported for unit tests.
 */
export function sseRawTextPayload(line: string): string {
  const s = (line.endsWith('\r') ? line.slice(0, -1) : line).replace(/^\s*data:/, '');
  return s.startsWith(' ') ? s.slice(1) : s;
}

/**
 * Does a `data:` payload that FAILED to parse carry a tool-call STRUCTURE?
 * (efdb3d31, 2026-10-30 — independent review D4.)
 *
 * The parse-fail counter exists to answer one question: did tool-call bytes
 * arrive in a frame we discarded? The first cut tested for the bare substring
 * `"function"`, which fires on perfectly ordinary prose that merely mentions
 * the quoted word — labelling a benign token as a corrupted tool-call frame and
 * weakening the very discriminator the field exists for.
 *
 * A real (mangled) tool-call chunk carries a JSON KEY, so require one: the
 * `tool_calls` array key, or the `arguments` field of a function object. Both
 * are matched WITH their quote+colon so prose cannot satisfy them, and neither
 * requires the payload to be valid JSON — a frame cut mid-structure still shows
 * the key it was cut after, which is exactly the evidence wanted.
 */
export function looksLikeToolCallFrame(payload: string): boolean {
  return /"tool_calls"\s*:/.test(payload)
    || /"arguments"\s*:/.test(payload)
    || /"function"\s*:\s*\{/.test(payload);
}

/**
 * Line-granularity repetition index (ticket 03587322, 2026-09-21, lane 596102ca
 * firing-256): the suffix probe in looksRepetitive needs the repeated unit to be
 * CONTIGUOUS at the tail — a derailed run that repeats one narration line with
 * OTHER text interleaved (the lane repeated "Executing the two mandated
 * transcript pulls — get_chat_messages on both lanes (independent, batched):"
 * dozens of times across a ~38-min streaming final, with "The volume cap broke
 * the loop. Now executing…" fragments between copies) sails straight past it.
 * This index counts NORMALIZED lines (whitespace collapsed, digit-runs folded so
 * a numbered loop line shares one form) of at least REPEAT_LINE_MIN_CHARS.
 * Fenced code blocks are stripped first — pasting a repeated log block is
 * legitimate diagnostics, not a decoder loop. Pure + exported for unit tests
 * and for the agent loop's CROSS-turn repeated-line tracker.
 */
export function longLineRepeatCounts(content: string, opts?: { foldDigits?: boolean }): Map<string, { line: string; count: number }> {
  const prose = content.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  const counts = new Map<string, { line: string; count: number }>();
  for (const rawLine of prose.split('\n')) {
    const norm = rawLine.replace(/\s+/g, ' ').trim();
    if (norm.length < REPEAT_LINE_MIN_CHARS) continue;
    // Digit-folding lets a NUMBERED loop line share one form ("Writing junk
    // todo noop-f256-break12 …" ≡ "…break13 …"). The agent loop's CROSS-turn
    // tracker passes foldDigits:false (adversarial-review F2, 03587322):
    // numbered PROGRESS lines ("Step 12 of 47 — running the migration for
    // shard 12") fold to one key while carrying real per-turn information, so
    // folding there would false-positive the RUN-ENDING guard on ordinary
    // batch work; the incident line was verbatim-identical across turns, so
    // exact normalization loses nothing. The in-turn probe keeps the fold —
    // a turn-level repetition trip only retries a turn, and numbered spam in
    // ONE turn is a real degeneration shape.
    const key = opts?.foldDigits === false ? norm : norm.replace(/\d+/g, '#');
    const entry = counts.get(key) ?? { line: norm, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return counts;
}

/**
 * The first long line repeated ≥ REPEAT_LINE_MIN_OCCURRENCES times in this
 * content, or null. Catches the interleaved-repeat shape the suffix probe is
 * blind to. Pure + exported for unit tests.
 */
export function repeatedLineInContent(content: string): { line: string; count: number } | null {
  for (const entry of longLineRepeatCounts(content).values()) {
    if (entry.count >= REPEAT_LINE_MIN_OCCURRENCES) return entry;
  }
  return null;
}

/**
 * True when streamed prose has run away: either absurdly long, a long line
 * repeats throughout it (interleaved repetition), or its trailing suffix
 * repeats many times within the look-back window (a model repetition loop).
 * Pure + exported so it can be unit-tested; the stream calls it on a throttle.
 */
export function looksRepetitive(content: string): boolean {
  if (content.length > MAX_CONTENT_CHARS) return true;
  if (repeatedLineInContent(content)) return true;
  const unit = content.slice(-REPEAT_UNIT_CHARS);
  if (unit.trim().length < 24) return false;
  const window = content.slice(-REPEAT_WINDOW_CHARS);
  let count = 0, idx = 0;
  while ((idx = window.indexOf(unit, idx)) !== -1) { count++; idx += unit.length; }
  return count >= REPEAT_MIN_OCCURRENCES;
}

/**
 * Reasoning-side degeneration guard (review 2026-10-20 of deep research without a wall clock): with the stall
 * watchdog on (runModelTurn `stallMs`) every reasoning token is LIVENESS, so a model looping inside its thinking kept
 * the stream "alive" until its output budget (deepseek-flash: 393k tokens) — nothing probed reasoning for repetition.
 * Only the contiguous TAIL probe applies here — never looksRepetitive's 40k-char cap (a max-effort reasoning trace is
 * routinely longer) nor its per-line count (a thinking model legitimately re-states "let me re-check …" lines) — over
 * a wider window so a whole paragraph re-emitted in a loop is caught too: the last REASONING_REPEAT_UNIT_CHARS seen
 * REASONING_REPEAT_MIN_OCCURRENCES times inside the last REASONING_REPEAT_WINDOW_CHARS (loop periods up to 4,000
 * chars). Pure + exported for unit tests; the stream calls it on a throttle, in stall mode only.
 */
export const REASONING_REPEAT_UNIT_CHARS = 200;
export const REASONING_REPEAT_WINDOW_CHARS = 24_000;
export const REASONING_REPEAT_MIN_OCCURRENCES = 6;
export const REASONING_REPEAT_CHECK_EVERY_CHARS = 2_000;
export function looksReasoningLoop(reasoning: string): boolean {
  const unit = reasoning.slice(-REASONING_REPEAT_UNIT_CHARS);
  if (unit.length < REASONING_REPEAT_UNIT_CHARS || unit.trim().length < 24) return false;
  const window = reasoning.slice(-REASONING_REPEAT_WINDOW_CHARS);
  let count = 0, idx = 0;
  while ((idx = window.indexOf(unit, idx)) !== -1) { count++; idx += unit.length; }
  return count >= REASONING_REPEAT_MIN_OCCURRENCES;
}

// createThinkRouter moved to ./think-router (2026-10-04) — re-exported for existing importers.
import { createThinkRouter } from './think-router';
export { createThinkRouter };

/**
 * Run ONE streamed turn. Returns assembled content + tool calls.
 * `tools` omitted → the model must answer (no more tool rounds).
 */
/**
 * ZAI (GLM) rejects structurally-loose message arrays with error 1214
 * ("messages parameter is illegal") — observed with consecutive same-role
 * messages after harness injections (council notes, FINAL TURN, drafts).
 * Sanitize provider-agnostically: merge consecutive same-role non-tool
 * messages and drop tool results whose paired assistant tool_calls are gone
 * (possible after compaction). Harmless for providers that don't care.
 */
// Review 2026-09-13 issue 9: placeholder for an empty assistant turn that
// cannot simply be dropped (see the empty-assistant block in sanitizeMessages).
export const EMPTY_ASSISTANT_PLACEHOLDER = '[no content]';

/** True when a message's content carries no text at all (string/array/null). */
function isBlankContent(content: any): boolean {
  if (content == null) return true;
  if (typeof content === 'string') return content.trim() === '';
  if (Array.isArray(content)) {
    // An array with any non-text part (image etc.) is NOT blank.
    return content.every(p => p && p.type === 'text' && String(p.text ?? '').trim() === '');
  }
  return false;
}

export function sanitizeMessages(messages: any[]): any[] {
  const out: any[] = [];
  const pendingToolIds = new Set<string>();
  // Review 2026-09-13 issue 9: count empty-assistant repairs so one warn per
  // turn keeps the upstream cause (reasoning-only / truncated turn assembled
  // in-request) visible in the logs.
  let emptyDropped = 0;
  let emptyPlaceholdered = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || !m.role) continue;
    if (m.role === 'tool') {
      const id = m.tool_call_id;
      if (id && !pendingToolIds.has(id)) continue; // orphan result — drop
      if (id) pendingToolIds.delete(id);
      out.push(m);
      continue;
    }
    // Review 2026-09-13 issue 9: Moonshot 400s with "the message at position N
    // with role assistant must not be empty" on an empty-content assistant
    // turn that carries no tool_calls (a reasoning-only or truncated turn
    // assembled in-request). The shrink/transient retries preserved that
    // message, so every occurrence burned ~5 requests and often gave up.
    // Repair provider-agnostically at request build: drop the message, or —
    // when dropping would leave two consecutive user turns — keep the turn
    // shape with a single placeholder token. (Empty assistants WITH tool_calls
    // are legal and needed for tool linkage — untouched below.)
    if (m.role === 'assistant' && !(Array.isArray(m.tool_calls) && m.tool_calls.length > 0) && isBlankContent(m.content)) {
      const prev = out[out.length - 1];
      let next: any = undefined;
      for (let j = i + 1; j < messages.length; j++) {
        const n = messages[j];
        if (n && n.role && n.role !== 'tool') { next = n; break; } // tools after it are orphans — dropped
      }
      if (prev?.role === 'user' && next?.role === 'user') {
        emptyPlaceholdered++;
        out.push({ ...m, content: EMPTY_ASSISTANT_PLACEHOLDER });
      } else {
        emptyDropped++;
      }
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id) pendingToolIds.add(tc.id);
      out.push(m);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && !prev.tool_calls) {
      // Array-aware merge: never String() a content array (that yields
      // "[object Object]"). Adjacent text parts join with '\n\n'; a lone
      // text part collapses back to a plain string so all-string traffic
      // stays byte-identical (ZAI/glm rejects array content, error 1214).
      const merged: Array<{ type: string; [k: string]: any }> = [];
      for (const p of [...toParts(prev.content), ...toParts(m.content)]) {
        const last = merged[merged.length - 1];
        if (p.type === 'text' && last?.type === 'text') last.text += '\n\n' + String(p.text ?? '');
        else merged.push(p.type === 'text' ? { ...p } : p);
      }
      prev.content = merged.length === 1 && merged[0].type === 'text' ? merged[0].text : merged;
      continue;
    }
    out.push({ ...m });
  }
  // Safety net: a conversation whose first non-system message is an assistant
  // turn is illegal for ZAI (1214) — can only happen if the user question was
  // lost upstream. Insert a minimal user turn to keep the run alive.
  const firstNonSystem = out.findIndex(m => m.role !== 'system');
  if (firstNonSystem >= 0 && out[firstNonSystem].role !== 'user') {
    out.splice(firstNonSystem, 0, { role: 'user', content: '[HARNESS] Continue the in-progress task described above.' });
  }
  // Review 2026-09-13 issue 9: one warn per turn — observe/record only.
  // Ticket 6d4cebff (log-signal family 5ae52ca3, 2026-10-24): the repair IS the
  // product (an expected, handled recovery — the taxonomy's logHandled class).
  // It was an untagged warn, so 191 rows/24h of a designed repair became a
  // sweep-filed "defect" every week (f182 82116bfcf already pinned it as a
  // known signature). info + logClass:'handled': console-visible in dev, and
  // the warn+ Prisma transport never persists it, so the class stops at the
  // source. The message text is unchanged so greps/audit pins keep matching.
  if (emptyDropped || emptyPlaceholdered) {
    logHandled(`sanitizeMessages: repaired ${emptyDropped + emptyPlaceholdered} empty assistant message(s) without tool_calls (dropped=${emptyDropped}, placeholder=${emptyPlaceholdered}) — upstream assembled an empty (reasoning-only/truncated) assistant turn`, { source: 'run-model-turn' });
  }
  return out;
}

// ── Reasoning effort + output budget on EVERY endpoint (2026-09-29) ─────────
// History: 2026-09-27 (the gpt-6-astra incident — the owner's LiteLLM proxy
// answered 400 "Function tools with reasoning_effort are not supported … set
// reasoning_effort to 'none'" even when Digby sent NO effort, the proxy
// injected one) made custom endpoints OMIT reasoning_effort/thinking unless the
// registry entry said 'supported'. That silently ran every gateway-backed seat
// at the gateway's DEFAULT effort (TB 2.1 bench probe on
// cql-litellm:api-optimize-zai-glm-5.3: 2,841 reasoning tokens with nothing
// sent vs 5,525 at 'max'), and gave only glm-5.x / kimi-k3 more than the
// 16,384 default output cap.
//
// Owner 2026-09-29: "it is supposed to use max reasoning and max output tokens
// everywhere regardless of the litellm provider / endpoint". Rules now:
//   (1) a custom-endpoint agent seat SENDS reasoning_effort 'max' (registry
//       resolve → customEndpointEffortExtra) and its model's MAX output
//       (maxOutputTokensFor — live-probed vendor ranges); the provider-specific
//       `thinking` switch is still stripped (not an OpenAI-compatible param);
//   (2) a 400 that rejects the effort VALUE steps down ONCE to the highest
//       value the error names (else the next rung of max → xhigh → high →
//       medium → low) and LATCHES it for (endpoint, model) in this process; a
//       400 that rejects effort WITH TOOLS latches 'none' (the 2026-09-27
//       rule); a server that does not know the parameter latches 'omit';
//   (3) a 400 on the output cap retries at the cap the error NAMES
//       ("[1, 131072]", "at most N", "N > M") and learns it; a context-length
//       400 ("maximum context length is C … (M in the messages") retries at
//       C − M − margin and learns the window (later turns are clamped from an
//       input estimate); anything unparseable falls back to 16,384 once;
//   (4) the admin's 'unsupported' flag and the "no-think" flag still win.

export type ReasoningEffortLatch = 'none' | 'omit' | 'xhigh' | 'high' | 'medium' | 'low';
/** Highest first. 'max' is the value every agent seat asks for. */
export const REASONING_EFFORT_LADDER = ['max', 'xhigh', 'high', 'medium', 'low'] as const;
const reasoningEffortLatches = new Map<string, ReasoningEffortLatch>();
const reasoningLatchKey = (p: Pick<ProviderConfig, 'url' | 'model'>) => `${String(p.url ?? '').toLowerCase()}::${p.model}`;
export function reasoningEffortLatch(p: Pick<ProviderConfig, 'url' | 'model'>): ReasoningEffortLatch | undefined {
  return reasoningEffortLatches.get(reasoningLatchKey(p));
}
export function latchReasoningEffort(p: Pick<ProviderConfig, 'url' | 'model'>, v: ReasoningEffortLatch): void {
  reasoningEffortLatches.set(reasoningLatchKey(p), v);
}
export function reasoningEffortNoneLatched(p: Pick<ProviderConfig, 'url' | 'model'>): boolean {
  return reasoningEffortLatch(p) === 'none';
}
export function latchReasoningEffortNone(p: Pick<ProviderConfig, 'url' | 'model'>): void {
  latchReasoningEffort(p, 'none');
}
export function __resetReasoningEffortLatchForTests(): void { reasoningEffortLatches.clear(); }
/** The exact provider phrasing (shared with seat-invalid-request.ts's classifier). */
export const REASONING_EFFORT_REJECTION_RE = /reasoning[_ -]?effort[^.]{0,160}(not supported|unsupported|not allowed|invalid|unknown)|(not supported|unsupported|unknown|unrecognized|invalid)[^.]{0,80}reasoning[_ -]?effort|use \/v1\/responses or set reasoning[_ -]?effort/i;
/** Effort cannot ride WITH function tools at all (gpt-6-astra via LiteLLM) → 'none'. */
const EFFORT_WITH_TOOLS_RE = /use \/v1\/responses or set reasoning[_ -]?effort|function tools with reasoning[_ -]?effort|reasoning[_ -]?effort[^.]{0,80}\b(?:with|and)\s+(?:function\s+)?tools/i;
/** The server does not know the parameter at all → 'omit'. */
const EFFORT_PARAM_UNKNOWN_RE = /(?:unrecognized|unknown|unexpected|extra)[^.]{0,60}(?:argument|parameter|field|input|key)s?[^.]{0,80}reasoning[_ -]?effort|reasoning[_ -]?effort[^.]{0,60}(?:not permitted|extra inputs|unexpected|unknown (?:parameter|field|argument))/i;
/** A value-level rejection that names the allowed levels without the param name (ZAI: "please use low, high, or max"). */
const EFFORT_VALUE_LIST_RE = /please use\s+(?:low|medium|high|max|xhigh)\b|(?:supported|valid|allowed|one of)[^.]{0,40}\b(?:low|medium|high|max|xhigh)\b/i;

/** The lower of two effort levels (a latched rung caps a higher request; a caller's lower pick stays). */
function lowerEffort(a: string, b: ReasoningEffortLatch): string {
  if (b === 'none' || b === 'omit') return b;
  const ia = REASONING_EFFORT_LADDER.indexOf(a as any);
  const ib = REASONING_EFFORT_LADDER.indexOf(b as any);
  if (ia < 0) return a; // a non-ladder value (e.g. 'none', 'minimal') is the caller's own choice
  return ia >= ib ? a : b;
}

/**
 * Pure: what to send after a 400 rejected the reasoning params — 'none' (effort
 * cannot ride with tools), 'omit' (unknown parameter), a LOWER rung (value
 * rejected; the highest level the error names below the one sent, else the
 * next rung), or null (not an effort rejection).
 */
export function nextReasoningEffortAfterRejection(sent: string | undefined, detail: string): ReasoningEffortLatch | null {
  const d = String(detail ?? '');
  if (!d) return null;
  if (EFFORT_WITH_TOOLS_RE.test(d)) return sent === 'none' ? null : 'none';
  if (EFFORT_PARAM_UNKNOWN_RE.test(d)) return sent === undefined ? null : 'omit';
  if (!sent || sent === 'none') return null;
  if (!(REASONING_EFFORT_REJECTION_RE.test(d) || EFFORT_VALUE_LIST_RE.test(d))) return null;
  const idx = REASONING_EFFORT_LADDER.indexOf(sent as any);
  if (idx < 0) return null;
  const below = REASONING_EFFORT_LADDER.slice(idx + 1) as ReadonlyArray<ReasoningEffortLatch>;
  const named = below.find((v) => new RegExp(`(?:^|[^a-z])${v}(?:[^a-z]|$)`, 'i').test(d));
  return named ?? below[0] ?? 'omit';
}

/**
 * Live-probed maximum output tokens (2026-09-29, bench box, tiny prompt):
 * ZAI glm-5.3 "max_tokens … [1,131072]"; DeepSeek deepseek-flash
 * "[1, 393216]"; DashScope qwen3.8-flash via the gateway "[1, 131072]";
 * Moonshot kimi-k3 accepts up to 1,048,576 (its whole window) — capped at
 * 262,144 so prompt + output always fit. Unknown families get 131,072 and the
 * budget ladder learns the real cap from the first 400 that names it.
 */
const MAX_OUTPUT_FAMILIES: ReadonlyArray<readonly [RegExp, number]> = [
  [/(?:^|[^a-z0-9])glm-5(?:\.\d+)?(?![0-9])/i, 131_072],
  [/(?:^|[^a-z0-9])deepseek/i, 393_216],
  [/(?:^|[^a-z0-9])qwen3/i, 131_072],
  [/(?:^|[^a-z0-9])kimi-k3(?![a-z0-9])/i, 262_144],
];
export const CUSTOM_ENDPOINT_DEFAULT_MAX_OUTPUT = 131_072;
/** @deprecated 2026-09-29 — the pre-max-output budget for always-thinking families; kept for readers of old telemetry. */
export const CUSTOM_ENDPOINT_THINKING_BUDGET = 65_536;
/** The runModelTurn default output cap (also the last-resort retry budget after a budget 400). */
export const DEFAULT_TURN_MAX_TOKENS = 16_384;
export function maxOutputTokensFor(modelId: string): number {
  const id = String(modelId ?? '');
  for (const [re, n] of MAX_OUTPUT_FAMILIES) if (re.test(id)) return n;
  return CUSTOM_ENDPOINT_DEFAULT_MAX_OUTPUT;
}
/** Provider extras for a custom-endpoint model: its MAX output budget (every model — owner 2026-09-29). */
export function customEndpointThinkingBudgetExtra(modelId: string): Record<string, any> {
  return { max_tokens: maxOutputTokensFor(modelId) };
}
/** Provider extras for a custom-endpoint model: reasoning_effort 'max' unless the admin flagged it 'unsupported'. */
export function customEndpointEffortExtra(reg: { reasoningEffort?: string }): Record<string, any> {
  if (reg?.reasoningEffort === 'unsupported') return {};
  return { reasoning_effort: 'max' };
}


// Learned limits per (endpoint, model), process-local: an explicit output cap
// the provider named, and a context window it named (the per-turn clamp).
const learnedOutputCaps = new Map<string, number>();
const learnedContextWindows = new Map<string, number>();
function budgetKey(p: Pick<ProviderConfig, 'url' | 'model'>): string { return `${p.url}|${p.model}`; }
export function learnedOutputCap(p: Pick<ProviderConfig, 'url' | 'model'>): number | undefined { return learnedOutputCaps.get(budgetKey(p)); }
/** (endpoint, model) pairs whose "named cap" CHANGED between rejections — the
 *  tell that the number describes the PROMPT, not the model (see below). */
const variedOutputCaps = new Set<string>();
export function __resetVariedOutputCapsForTests(): void { variedOutputCaps.clear(); }
/**
 * Latch an output cap the provider NAMED — but only while that number stays
 * STABLE for this (endpoint, model).
 *
 * Ticket c6af45ef (2026-10-29, 29 rows / 3 h): `tt-qwen3.8-flash-next` named a
 * DIFFERENT "cap" on every rejection and the min-merge below ratcheted the
 * model down one rejected round-trip at a time — 131072 → 43421 → 42902 →
 * 38236 → 33840 → 31473 → 29117 → 29003 → 28243 → 17268, forever, because a
 * smaller number can only ever replace a larger one and the value never
 * recovered. Those numbers are a CONTEXT-WINDOW remainder (window minus the
 * prompt that was just sent), which changes with every turn — learning it as
 * the model's output ceiling is a category error, and each turn paid a fresh
 * 400 to discover it. A number that moves is therefore NOT a model property:
 * the first time it changes we stop latching from this lane for good (the
 * window itself is still learned by learnContextWindow above — that IS a
 * model property, and the per-turn retry still uses the value for the turn).
 */
export function learnOutputCap(p: Pick<ProviderConfig, 'url' | 'model'>, cap: number): void {
  const key = budgetKey(p);
  if (variedOutputCaps.has(key)) return;
  const prev = learnedOutputCaps.get(key);
  if (prev !== undefined && prev !== cap) {
    // Two different numbers named for the same model ⇒ prompt-derived. CLEAR
    // the latch (freezing it at the first value would keep the same wrong
    // ceiling) and refuse to learn another from this lane for good.
    variedOutputCaps.add(key);
    learnedOutputCaps.delete(key);
    logger.warn(`runModelTurn: ${p.model} named two different output caps (${prev} then ${cap}) — the figure tracks the PROMPT, not the model, so the learned cap is cleared and no longer latched (the per-turn retry still uses it; the context window stays learned).`, { source: 'run-model-turn' });
    return;
  }
  learnedOutputCaps.set(key, prev ? Math.min(prev, cap) : cap);
}
export function learnedContextWindow(p: Pick<ProviderConfig, 'url' | 'model'>): number | undefined { return learnedContextWindows.get(budgetKey(p)); }
export function learnContextWindow(p: Pick<ProviderConfig, 'url' | 'model'>, tokens: number): void { learnedContextWindows.set(budgetKey(p), tokens); }
// audit 2026-10-06 T1-1: a FAMILY-inferred transcript budget (registryContextBudget
// source 'family') is a guess about a server we never measured — a self-hosted
// GLM-5.3 may run with a 128k max_model_len. When such a seat rejects a request
// and its body NAMES size, the agent loop learns a char CEILING (85 % of the
// rejected transcript, never below the 160k registry default) per (endpoint,
// model), process-wide, and compacts against min(budget, ceiling) from then on.
const learnedContextCharCeilings = new Map<string, number>();
export function learnedContextCharCeiling(p: Pick<ProviderConfig, 'url' | 'model'>): number | undefined { return learnedContextCharCeilings.get(budgetKey(p)); }
/** Learn (min-merge) a ceiling from a size-named rejection at `rejectedChars`; returns the ceiling now in force. */
export function learnContextCharCeiling(p: Pick<ProviderConfig, 'url' | 'model'>, rejectedChars: number): number {
  const next = Math.max(REGISTRY_CONTEXT_CHARS, Math.floor(rejectedChars * 0.85));
  const prev = learnedContextCharCeilings.get(budgetKey(p));
  const merged = prev ? Math.min(prev, next) : next;
  learnedContextCharCeilings.set(budgetKey(p), merged);
  return merged;
}
export function __resetContextCharCeilingsForTests(): void { learnedContextCharCeilings.clear(); }
/** Compat (2026-09-29 thinking budget): "latched" = the model's cap was learned at/below the default. */
export function thinkingBudgetLatched(p: Pick<ProviderConfig, 'url' | 'model'>): boolean {
  const c = learnedOutputCap(p); return c !== undefined && c <= DEFAULT_TURN_MAX_TOKENS;
}
export function latchThinkingBudgetOff(p: Pick<ProviderConfig, 'url' | 'model'>): void { learnOutputCap(p, DEFAULT_TURN_MAX_TOKENS); }
export function __resetThinkingBudgetLatchForTests(): void { learnedOutputCaps.clear(); learnedContextWindows.clear(); variedOutputCaps.clear(); }
/** A 400 that names the output budget / context length (vLLM, LiteLLM, OpenAI-compatible wording). */
export const OUTPUT_BUDGET_REJECTION_RE = /max[_ ]?(completion[_ ]?)?tokens|maximum context length|context length|context window|too many tokens|requested \d+ tokens|output tokens/i;
const CONTEXT_LENGTH_RE = /maximum context length is (\d{3,8})\s*tokens[\s\S]{0,240}?\((\d{1,8}) in the messages/i;
const OUTPUT_CAP_RES: ReadonlyArray<RegExp> = [
  /max[_ ]?(?:completion[_ ]?)?tokens[^\n]{0,120}?\[\s*1\s*,\s*(\d{3,8})\s*\]/i,   // ZAI / DeepSeek / DashScope ranges
  /\[\s*1\s*,\s*(\d{3,8})\s*\][^\n]{0,60}max[_ ]?tokens/i,
  /(?:supports at most|at most|no more than|less than or equal to|<=)\s*(\d{3,8})\s*(?:completion |output )?tokens?/i,
  /max[_ ]?(?:completion[_ ]?)?tokens:?\s*\d{3,9}\s*>\s*(\d{3,8})/i,               // Anthropic via LiteLLM: "max_tokens: 200000 > 128000"
];
const CONTEXT_MARGIN_TOKENS = 1_024;

/**
 * Pure: the output cap to retry with after a 400 on the budget, or null.
 * `learn: 'cap'` = the provider named the MODEL's output cap (latch it);
 * 'window' = a context-length overflow (learn the window, not a cap);
 * 'fallback' = unparseable budget wording → the 16,384 default once.
 */
export function outputBudgetFixForRejection(sentCap: number, detail: string): { cap: number; learn: 'cap' | 'window' | 'fallback'; window?: number } | null {
  const d = String(detail ?? '');
  if (!(sentCap > 0) || !OUTPUT_BUDGET_REJECTION_RE.test(d)) return null;
  const ctx = d.match(CONTEXT_LENGTH_RE);
  if (ctx) {
    const window = Number(ctx[1]); const inMessages = Number(ctx[2]);
    const allowed = window - inMessages - CONTEXT_MARGIN_TOKENS;
    return allowed >= 1_024 && allowed < sentCap ? { cap: allowed, learn: 'window', window } : null;
  }
  for (const re of OUTPUT_CAP_RES) {
    const m = d.match(re);
    const n = m ? Number(m[1]) : NaN;
    if (Number.isFinite(n) && n >= 256 && n < sentCap) return { cap: n, learn: 'cap' };
  }
  return sentCap > DEFAULT_TURN_MAX_TOKENS ? { cap: DEFAULT_TURN_MAX_TOKENS, learn: 'fallback' } : null;
}

/** Rough prompt-size estimate (tokens) for the learned-window clamp: ~3 chars/token, deliberately high. */
function estimatePromptTokens(messages: any[]): number {
  let chars = 0;
  for (const m of messages ?? []) {
    const c = m?.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) for (const part of c) chars += typeof part?.text === 'string' ? part.text.length : 1_000;
    if (m?.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 3);
}

/** The payload key a provider takes its output cap under (Kimi K3: max_completion_tokens). */
function outputCapKey(payload: Record<string, any>): 'max_tokens' | 'max_completion_tokens' {
  return payload.max_completion_tokens !== undefined && payload.max_tokens === undefined ? 'max_completion_tokens' : 'max_tokens';
}

/** Strip / pin the reasoning params on a custom-endpoint payload. Mutates `payload`. Pure otherwise. */
export function applyReasoningEffortHygiene(provider: ProviderConfig, payload: Record<string, any>): void {
  if (!isCustomEndpointProvider(provider)) return;
  const latch = reasoningEffortLatch(provider);
  if (latch === 'none') { payload.reasoning_effort = 'none'; delete payload.thinking; return; }
  if (latch === 'omit') { delete payload.reasoning_effort; delete payload.thinking; return; }
  if (provider.reasoningEffort === 'supported') {
    if (latch && payload.reasoning_effort !== undefined) payload.reasoning_effort = lowerEffort(String(payload.reasoning_effort), latch);
    return;
  }
  delete payload.thinking;
  if (provider.reasoningEffort === 'unsupported') { delete payload.reasoning_effort; return; }
  if (latch && payload.reasoning_effort !== undefined) payload.reasoning_effort = lowerEffort(String(payload.reasoning_effort), latch);
}

/**
 * Cap the tools array for a provider — the payload-level safety net every
 * runModelTurn caller gets (the agent loop pre-trims with the same rule and
 * tells the model; other callers — seat-call, browser agent — send few tools).
 *
 * History: FO firing 35 (b085607e, 2026-09-27) shipped this seam as a FIRST-N
 * truncation to CUSTOM_ENDPOINT_TOOLS_MAX for custom endpoints after the
 * api-openai-gpt-6-astra 400 storm (122 rows in 2 h). The 2026-09-27
 * seat/provider-limits wave composes it: the SPECIFIC cap wins when known
 * (registry model > endpoint > provider class, min'd with a cap learned from a
 * live 400 — provider-limits.ts providerToolLimit), else the OPT-IN blanket
 * env `CUSTOM_ENDPOINT_TOOLS_MAX` (2026-09-27 late: the blanket DEFAULT of 128
 * is GONE — "who said 128 is the limit??" — a custom endpoint with no known cap
 * is UNLIMITED here, exactly like a built-in); the survivors are chosen by the
 * stable PRIORITY order (core + doctrine tools first, connector writes go
 * first) — unconditional since TOOL_LIMIT_TRIM_DISABLED was deleted 2026-11-02
 * (RSW-1), its first-N default having baked out; it never switched off a real
 * cap. Built-ins
 * are NEVER capped (ZAI/Moonshot/DeepSeek take the full array). The agent loop
 * itself no longer reaches this net on a capped seat: it offers core + tool
 * GROUPS (tool-groups.ts) and sends a list that already fits. Pure.
 */
export function capToolsForProvider(provider: ProviderConfig, tools: any[] | undefined): any[] | undefined {
  if (!tools || !tools.length) return tools;
  const limit = providerToolLimit(provider);
  if (limit === undefined || tools.length <= limit) return tools;
  return trimToolsToLimit(tools, limit).tools;
}

/**
 * The request body ONE streamed turn sends — the seat's fixed extras, the
 * provider's omitParams, the tool list (capped for the provider), and (custom
 * endpoints) the reasoning-effort hygiene. Shared with the admin role tester so
 * the Test button exercises the REAL shape (tools + effort), not a bare ping.
 */
export function buildTurnPayload(provider: ProviderConfig, sanitized: any[], tools: any[] | undefined): Record<string, any> {
  const payload: any = {
    model: provider.model,
    messages: sanitized,
    max_tokens: 16384,
    stream: true,
    // Ask for token usage on the final stream chunk (OpenAI-compatible).
    // ZAI sends usage unconditionally and tolerates the flag; providers that
    // reject it can strip it via omitParams.
    stream_options: { include_usage: true },
    ...provider.extra,
  };
  for (const k of provider.omitParams ?? []) delete payload[k];
  // 2026-09-29: a cap / context window the provider NAMED in an earlier 400
  // (runModelTurn's budget ladder) clamps every later turn in this process —
  // the model runs at its real maximum instead of re-paying the rejection.
  const capKey = outputCapKey(payload);
  const learnedCap = learnedOutputCap(provider);
  if (learnedCap && Number(payload[capKey]) > learnedCap) payload[capKey] = learnedCap;
  const window = learnedContextWindow(provider);
  if (window) {
    const allowed = window - estimatePromptTokens(sanitized) - CONTEXT_MARGIN_TOKENS;
    if (allowed >= 1_024 && Number(payload[capKey]) > allowed) payload[capKey] = allowed;
  }
  if (tools && tools.length) {
    const capped = capToolsForProvider(provider, tools);
    if (capped !== tools) {
      // The trim is designed behaviour (the endpoint's tool cap), so it is an
      // info line ONCE per (endpoint, model) per process — it fired at warn on
      // EVERY capped turn (161 rows / 2 h on the cql-litellm seats). The agent
      // loop's tool_list_trimmed metric still counts every run; this fires
      // for callers that sent an over-limit list straight in.
      const key = `${provider.url}|${provider.model}`;
      if (!toolTrimNoticed.has(key)) {
        toolTrimNoticed.add(key);
        logger.info(`runModelTurn: tools trimmed ${tools.length} → ${capped?.length ?? 0} for [${provider.label}/${provider.model}] — the endpoint caps the tools array (specific cap: registry model / endpoint / provider class / learned; blanket CUSTOM_ENDPOINT_TOOLS_MAX; ${trimOrderLabel()} kept, the rest unavailable per turn; logged once per model per process)`);
      }
    }
    payload.tools = capped;
    payload.tool_choice = 'auto';
  }
  applyReasoningEffortHygiene(provider, payload);
  return payload;
}
function trimOrderLabel(): string {
  return 'priority order (core + doctrine tools first)';
}
/** (endpoint url | model) pairs whose tool-cap trim has been logged this process. */
const toolTrimNoticed = new Set<string>();
export function __resetToolTrimNoticeForTests(): void { toolTrimNoticed.clear(); }

/**
 * Drain a streamed axios error body ONCE (bounded: 2 KB / 1.5 s) and cache it
 * on the error as `digbyBody`, so runModelTurn's own fingerprinting and the
 * agent loop's provider-error extraction read the same text. Never throws;
 * '' when there is nothing usable.
 */
export async function drainAxiosErrorBody(err: any): Promise<string> {
  if (!err) return '';
  if (typeof err.digbyBody === 'string') return err.digbyBody;
  let bodyText = '';
  try {
    const d = err?.response?.data;
    if (d && typeof d === 'object' && typeof d.on === 'function') {
      bodyText = await new Promise<string>((resolve) => {
        let acc = '';
        const t = setTimeout(() => resolve(acc), 1500);
        d.on('data', (c: any) => { acc += String(c); if (acc.length > 2000) { clearTimeout(t); resolve(acc); } });
        d.on('end', () => { clearTimeout(t); resolve(acc); });
        d.on('error', () => { clearTimeout(t); resolve(acc); });
      });
    } else if (typeof d === 'string') bodyText = d;
    else if (d) { try { bodyText = JSON.stringify(d); } catch { /* circular — stays empty */ } }
  } catch { /* bodyText stays empty */ }
  try { err.digbyBody = bodyText; } catch { /* frozen error object — ignore */ }
  return bodyText;
}

/**
 * Token-idle STALL watchdog (deep research without a wall clock, 2026-10-20 — chat-agent/council-dispatch.ts
 * researchNoWallClock). The only stall guard a model turn had was the per-call socket timeout: follow-redirects arms
 * `socket.setTimeout(timeoutMs)` → `socket.destroy` and only clears its OWN wall-clock timer on 'response', so after
 * the headers the socket stays byte-idle-killed at 290 s — blind to an SSE stream that sends keep-alive comments (or
 * empty `data:` lines) but no token, and fatal to a gateway model that thinks silently for > 290 s. With `stallMs`
 * set: the pre-header wait is max(timeoutMs, stallMs), the post-header socket idle timer is switched OFF, and the
 * watchdog cuts the stream once NO token (content / reasoning / tool_calls / usage / raw-text payload) has arrived for
 * `stallMs` — a comment or empty line never resets it. The cut is an ESTALL error, so the agent loop's transient
 * lane retries the turn (never the lead-seat-unreachable lane — a stall is not a connection failure). Absent ⇒ today's behaviour byte-for-byte.
 *
 * Two companions (review 2026-10-20), stall mode only:
 *   - reasoning is liveness, so it is BOUNDED: a reasoning stream that loops (looksReasoningLoop) ends the turn as
 *     'repetition' — the agent loop's nudge-and-retry lane — instead of streaming the loop to the output budget;
 *   - a gateway's `delta.reasoning` field (OpenRouter, vLLM, Ollama) — liveness for the watchdog — reaches
 *     `reasoning` + callbacks.onReasoning like `reasoning_content` (only when no reasoning_content rides the same
 *     delta), so every consumer of the run's events (the council dispatch wait, the deploy drain) shares one
 *     definition of liveness with the watchdog.
 */
export interface ModelTurnOptions {
  /** Token-idle stall bound (ms). Unset ⇒ no watchdog (the socket timeout alone, as before). */
  stallMs?: number;
}

/** The watchdog's poll cadence: ≤ 15 s, and fine enough (stall/4) for a short bound. Pure. */
export function streamStallPollMs(stallMs: number): number {
  return Math.max(250, Math.min(15_000, Math.floor(stallMs / 4)));
}

export async function runModelTurn(
  provider: ProviderConfig,
  messages: any[],
  tools: any[] | undefined,
  callbacks: StreamCallbacks,
  timeoutMs = 290_000,
  isCancelled?: () => boolean,
  opts?: ModelTurnOptions,
): Promise<TurnResult> {
  const stallMs = typeof opts?.stallMs === 'number' && Number.isFinite(opts.stallMs) && opts.stallMs > 0 ? opts.stallMs : undefined;
  const sanitized = sanitizeMessages(messages);
  // ── SYSTEM-FIRST backends (ticket 68167bbf, 2026-10-28): a strict
  //    OpenAI-compatible deployment (vLLM on the Tenstorrent Quietbox, via
  //    LiteLLM) 400s the whole turn with "messages[2].role is system; the
  //    system message must be first" because the agent loop pushes its
  //    per-turn [HARNESS CLOCK] note as a trailing system message after the
  //    user turn (the logged fingerprint: system:53440 user:2407 system:265 —
  //    265 chars is exactly buildCodingClockNote). A backend that has ALREADY
  //    rejected the order is LATched (system-first.ts; the latch is DURABLE in
  //    Redis since ticket 5809b75f, so a restarted process inherits it rather
  //    than re-buying the 400), so every later turn pays this pre-dispatch
  //    merge instead of a rejection.
  //    Never speculative: Moonshot prefix-caching needs a byte-stable leading
  //    system block and a per-turn clock note folded into it would destroy the
  //    cache hit rate (K3 re-ships a ~53k prefix per turn). Kill switch
  //    SYSTEM_FIRST_NORMALIZE_DISABLED=1.
  let systemFirstApplied = false;
  let wire: any[] = sanitized;
  // Durable latch hydration (ticket 5809b75f): a fresh process INHERITS the
  // strictness an earlier process learned instead of re-buying it with a live
  // 400. Idempotent (one Redis read per process), best-effort, and awaited so
  // the pre-dispatch merge below can actually see it on this very turn.
  if (!systemFirstNormalizeDisabled()) await ensureSystemFirstLatchHydrated();
  if (!systemFirstNormalizeDisabled() && systemFirstLatched(provider)) {
    const hoisted = hoistSystemMessages(sanitized);
    if (hoisted.changed) {
      wire = hoisted.messages;
      systemFirstApplied = true;
      logHandled(`runModelTurn: merged ${hoisted.systemCount} system messages into ONE leading system message for [${provider.label}/${provider.model}] — this backend requires system-first (learned from an earlier 400; ticket 68167bbf)`, { source: 'run-model-turn' });
    }
  }
  let payload: any = buildTurnPayload(provider, wire, tools);

  // ── Moonshot context caching (audit #4; see moonshot-cache.ts for the
  // researched mechanism + doc URLs). Server-side prefix caching is automatic;
  // this adds the documented `prompt_cache_key` routing hint (per-run identity
  // hashed off the stable system prefix) and restores stream_options so
  // usage.cached_tokens is observable. `payload` above stays untouched — on a
  // param-shape rejection we retry with that EXACT legacy payload once and
  // latch the cache params off for this model (single warn, loop unaffected).
  let cacheApp = applyMoonshotCache(provider, payload, wire);

  // STOP DURING THINKING: a reasoning model streams for 100+ seconds; without an
  // abort the run only halts at the NEXT step boundary, so Stop felt dead while
  // the model was "thinking" (owner-reported 2026-07-19). An AbortController +
  // a cancel poll aborts the in-flight HTTP request immediately when Stop is
  // pressed — even before the first token, and mid-stream. The loop then sees
  // finishReason 'cancelled' and bails without persisting the partial turn.
  const abort = new AbortController();
  let cancelPoll: ReturnType<typeof setInterval> | undefined;
  if (isCancelled) {
    if (isCancelled()) return { content: '', reasoning: '', toolCalls: [], finishReason: 'cancelled' };
    cancelPoll = setInterval(() => { try { if (isCancelled()) abort.abort(); } catch { /* ignore */ } }, 250);
  }
  const clearCancelPoll = () => { if (cancelPoll) clearInterval(cancelPoll); };

  const postTurn = (body: any) => axios.post(provider.url, body, {
    // Keyless custom endpoints (Ollama, llama.cpp) get NO Authorization
    // header — "Bearer undefined" can trip servers that do check auth.
    headers: { ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}), 'Content-Type': 'application/json' },
    // Stall mode: the wait for the headers is a stall too (no token yet) — never shorter than today's bound.
    timeout: stallMs !== undefined ? Math.max(timeoutMs, stallMs) : timeoutMs,
    responseType: 'stream',
    signal: abort.signal,
  });

  let response;
  try {
    // Corrective retries, each at most ONCE per turn and composable (a cache
    // shape fix, then an effort fix, then a budget fix — a second fix never
    // throws away the first). Anything else, or a failure after the fixes,
    // flows to the standard handling below with its body drained.
    let useCache = !!cacheApp;
    let effortOverride: ReasoningEffortLatch | undefined;
    let effortFixes = 0; // up to TWO: a value step-down can be followed by an effort-with-tools refusal (OpenAI via LiteLLM)
    let budgetOverride: number | undefined;
    let stripReasoning = false; // build 2026-10-08 Q-2: the gateway rejected the replayed reasoning_content
    let systemFirstRetried = false; // ticket 68167bbf: ONE shape-changing retry for a system-order 400
    const capKey = outputCapKey(payload);
    const bodyNow = (): any => {
      const b: any = { ...(useCache && cacheApp ? cacheApp.payload : payload) };
      if (effortOverride) {
        delete b.thinking;
        if (effortOverride === 'omit') delete b.reasoning_effort; else b.reasoning_effort = effortOverride;
      }
      if (budgetOverride) b[capKey] = budgetOverride;
      if (stripReasoning && Array.isArray(b.messages)) b.messages = stripReasoningContent(b.messages);
      return b;
    };
    for (;;) {
      try {
        response = await postTurn(bodyNow());
        break;
      } catch (err: any) {
        const wasCancelled = abort.signal.aborted || err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError';
        if (wasCancelled) throw err;
        // Cache-annotated payload rejected on shape (4xx) → single warn, latch
        // the params off for this model, and retry without them so the coding
        // loop never sees a cache-side failure.
        if (useCache && cacheApp && isCacheParamRejection(err)) {
          latchCacheParamsOff(provider.model);
          logger.warn(`moonshot context-cache params rejected (HTTP ${err?.response?.status}) [${provider.model}] — retrying uncached, cache params latched off for this model (added: ${cacheApp.addedKeys.join(', ')})`, { source: 'run-model-turn' });
          useCache = false;
          continue;
        }
        if (err?.response?.status !== 400) throw err;
        const detail = extractProviderErrorDetail(await drainAxiosErrorBody(err), 600);
        // ── SYSTEM-MESSAGE ORDER rejected (ticket 68167bbf, 2026-10-28): the
        //    backend requires every system message to precede the first user
        //    turn — "messages[2].role is system; the system message must be
        //    first" (vLLM behind LiteLLM). This is the ONLY way to learn that a
        //    seat is strict, so one rejection is expected per process; the fix
        //    is a DIFFERENT request, not a re-send of the identical payload:
        //    merge every system message into one leading block and retry ONCE
        //    (the cache-params / reasoning-content / effort / budget ladder's
        //    exact precedent — each fix is bounded and changes the shape).
        //    The latch means no later turn on this (endpoint, model) pays the
        //    rejection again. Classification still reaches the agent loop: a
        //    SECOND system-order 400 fails the turn fast there instead of
        //    entering the spurious-transient backoff+shrink storm.
        if (!systemFirstRetried && !systemFirstNormalizeDisabled() && isSystemOrderRejection(detail)) {
          systemFirstRetried = true;
          const hoisted = hoistSystemMessages(wire);
          if (hoisted.changed) {
            latchSystemFirst(provider);
            wire = hoisted.messages;
            payload = buildTurnPayload(provider, wire, tools);
            cacheApp = applyMoonshotCache(provider, payload, wire);
            systemFirstApplied = true;
            // Taxo­nomy (ticket 5809b75f, 2026-10-29): the merge below REPAIRED
            // the turn — the product working as designed, not a fault. It was an
            // untagged warn, so EVERY process paid one such row to re-learn a
            // seat another process already knew (93 deploy waves/24h = ~93 rows
            // of a successful repair), which a sweep reads as "the fix
            // regressed". Same ruling the sanitizeMessages repair got (ticket
            // 6d4cebff, :1096): logClass:'handled' at info, message text
            // unchanged so greps/audit pins keep matching. The give-up stays a
            // genuine warn: agent.ts's message_order lane is untouched, and the
            // durable latch above means a healthy fleet reaches this line about
            // ONCE PER SEAT rather than once per deploy.
            logHandled(`runModelTurn: ${provider.model} (${provider.label}) requires system-first messages (HTTP 400: "${detail.slice(0, 160)}") — merged ${hoisted.systemCount} system message(s) into ONE leading system message and retrying once; system-first latched ON for this endpoint+model (SYSTEM_FIRST_NORMALIZE_DISABLED=1 stops the normalization).`, { source: 'run-model-turn' });
            void import('../platform/loop-metrics.service')
              .then((lm) => lm.recordLoopMetric({ kind: 'system_first_replay', meta: { outcome: 'rejected_latched', model: provider.model, label: provider.label, systemCount: hoisted.systemCount, ...(provider.spec ? { spec: provider.spec } : {}) } }))
              .catch(() => { /* telemetry never breaks a turn */ });
            continue;
          }
          // Nothing to hoist (the order was already legal) — the rejection is
          // about something else that merely reads like it. Fall through.
        }
        // build 2026-10-08 Q-2: a custom endpoint that rejects the replayed Kimi reasoning_content
        // field — retry once without it and latch the replay off for this (endpoint, model).
        if (!stripReasoning && isCustomEndpointProvider(provider) && isReasoningContentRejection(detail)
          && (bodyNow().messages ?? []).some((m: any) => m && typeof m === 'object' && 'reasoning_content' in m)) {
          latchReasoningReplayOff(provider);
          stripReasoning = true;
          logger.warn(`runModelTurn: ${provider.model} (${provider.label}) rejected the replayed reasoning_content (HTTP 400) — retrying once without it; reasoning replay latched OFF for this model (KIMI_REASONING_REPLAY_FAMILY_DISABLED=1 stops the replay everywhere).`, { source: 'run-model-turn' });
          void import('../platform/loop-metrics.service')
            .then((lm) => lm.recordLoopMetric({ kind: 'reasoning_replay', meta: { outcome: 'rejected_latched', model: provider.model, label: provider.label, ...(provider.spec ? { spec: provider.spec } : {}) } }))
            .catch(() => { /* telemetry never breaks a turn */ });
          continue;
        }
        // Effort rejected (2026-09-27 'none' rule; 2026-09-29 value ladder).
        if (effortFixes < 2 && isCustomEndpointProvider(provider)) {
          const sent = bodyNow().reasoning_effort as string | undefined;
          const next = nextReasoningEffortAfterRejection(sent, detail);
          if (next && next !== (sent ?? 'omit')) {
            latchReasoningEffort(provider, next);
            effortOverride = next;
            effortFixes++;
            logger.warn(`runModelTurn: ${provider.model} (${provider.label}) rejected reasoning_effort=${sent ?? '(proxy-injected)'} (HTTP 400) — retrying once with ${next === 'omit' ? 'no reasoning_effort' : `reasoning_effort:'${next}'`} and latching it for this model${next === 'none' ? ". LiteLLM fix: add `reasoning_effort: none` under litellm_params for this model group, or route it via /v1/responses" : ''}.`, { source: 'run-model-turn' });
            continue;
          }
        }
        // Output budget rejected (2026-09-29): retry at the cap the provider
        // NAMED (learned), or C − M on a context overflow (window learned),
        // or the 16,384 default once when nothing parses.
        if (budgetOverride === undefined) {
          const sentCap = Number(bodyNow()[capKey]);
          const fix = outputBudgetFixForRejection(sentCap, detail);
          if (fix) {
            if (fix.learn === 'cap' || (fix.learn === 'fallback' && /max[_ ]?(completion[_ ]?)?tokens/i.test(detail) && !/context/i.test(detail))) learnOutputCap(provider, fix.cap);
            if (fix.learn === 'window' && fix.window) learnContextWindow(provider, fix.window);
            budgetOverride = fix.cap;
            // Ticket c6af45ef (log-signal family, 2026-10-30): this is a REPAIR
            // THAT WORKED — the turn is retried at an acceptable cap and
            // succeeds — not an internal fault. It fired at UNTAGGED warn on
            // every turn of a seat whose "named cap" is prompt-derived
            // (tt-qwen3.8-flash-next: 21 rows in 21 minutes, every one
            // `max_tokens 131072`), so the sweep filed it as a standing defect
            // in perpetuity. Same ruling the system-first merge above got
            // (ticket 5809b75f, :1660) and the sanitizeMessages repair before it
            // (6d4cebff): logClass:'handled' at info, message text UNCHANGED so
            // greps and audit pins keep matching. The occurrences stay durably
            // measurable as loop_metrics provider_rejected rows (meta.lane
            // 'output_budget'), which is where a rate belongs — a per-turn warn
            // in the error table is not.
            logHandled(`runModelTurn: ${provider.model} (${provider.label}) rejected ${capKey} ${sentCap} (HTTP 400) — retrying once at ${fix.cap} (${fix.learn === 'cap' ? 'the cap the provider named, learned for this model' : fix.learn === 'window' ? `the ${fix.window}-token context window minus this prompt, window learned` : 'the default — the rejection named no cap'}).`, { source: 'run-model-turn' });
            void import('../platform/loop-metrics.service')
              .then((lm) => lm.recordLoopMetric({
                kind: lm.LOOP_METRIC_KINDS.PROVIDER_REJECTED,
                value: sentCap, unit: 'tokens',
                meta: { lane: 'output_budget', outcome: 'repaired', model: provider.model, label: provider.label, sentCap, retryCap: fix.cap, learn: fix.learn, ...(provider.spec ? { spec: provider.spec } : {}) },
              }))
              .catch(() => { /* telemetry never breaks a turn */ });
            continue;
          }
        }
        throw err;
      }
    }
  } catch (err: any) {
    clearCancelPoll();
    // Aborted before/at connect → a clean cancelled turn (not an error the
    // recovery path would try to compact-and-retry).
    if (abort.signal.aborted || err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') {
      return { content: '', reasoning: '', toolCalls: [], finishReason: 'cancelled' };
    }
    if (err?.response?.status === 400) {
      // Structural fingerprint (roles + tool-call linkage, no content) so
      // ZAI 1214 'messages parameter is illegal' is finally diagnosable.
      const sizeOf = (c: any): string => Array.isArray(c)
        ? `${c.reduce((n: number, p: any) => n + (p?.type === 'text' ? String(p.text ?? '').length : 0), 0)} imgs:${c.filter((p: any) => p?.type === 'image_url').length}`
        : String(String(c ?? '').length);
      const fp = sanitized.map((m: any) => `${m.role}${m.tool_calls ? `+tc${m.tool_calls.length}` : ''}${m.tool_call_id ? '(id)' : ''}:${sizeOf(m.content)}`).join(' ');
      logger.warn(`runModelTurn 400 fingerprint [${provider.model}] tools=${tools?.length ?? 0}${systemFirstApplied ? ' (system-first merge APPLIED this turn)' : systemFirstLatched(provider) ? ' (this seat is system-first latched)' : ''}: ${fp.slice(0, 1500)}`, {
        model: provider.model,
        source: 'run-model-turn',
      });
    }
    throw err;
  }

  if (stallMs !== undefined) {
    // follow-redirects leaves `socket.setTimeout(timeout)` → `socket.destroy` armed after the headers: a byte-idle
    // kill that would preempt the token watchdog with a status-less abort. Switch it off — the watchdog owns idleness
    // (a byte-idle stream is token-idle too, so nothing is left unguarded).
    try {
      const sock: any = (response as any)?.request?.socket ?? (response as any)?.data?.socket;
      if (sock && typeof sock.setTimeout === 'function') sock.setTimeout(0);
    } catch { /* best effort — the socket timeout stays as it was */ }
  }

  return new Promise<TurnResult>((resolve, reject) => {
    const stream = response.data;
    let buffer = '';
    // Ticket f3e56567: decode the SSE bytes through a STATEFUL UTF-8 decoder.
    //
    // WHY. This reader used to do `buffer += chunk.toString()`. `Buffer#toString`
    // decodes each chunk INDEPENDENTLY, so a UTF-8 code point whose bytes
    // straddle a TCP/gateway packet boundary becomes two invalid sequences and
    // each half decodes to U+FFFD REPLACEMENT CHARACTER. In this stream those
    // replacement chars land INSIDE a tool call's JSON string literal, so
    // `parseToolArguments` still SUCCEEDS and the tool STILL EXECUTES — with
    // silently corrupted arguments and NO error anywhere: a supervisor's
    // `send_chat_message` delivered `"… depth >= 2 shards \uFFFD\uFFFD 4 lanes …"`
    // where the model had written `"… × 4 lanes …"`, and a `todo_update`
    // progressNote was stored mutated while the tool reported success (ticket
    // f3e56567, reproduced in tool-arguments.f3e56567.test.ts).
    //
    // The corruption scales with the NUMBER of multi-byte glyphs and with how
    // the transport packetises — never with payload LENGTH — which is why the
    // reporter saw different cut lengths (2,545 then 1,111 chars) on two
    // attempts of the same call and why "short pure-ASCII sends landed". A
    // StringDecoder carries the incomplete trailing bytes of one chunk into the
    // next, so a split code point is emitted whole exactly once.
    //
    // Pure-decode change: a genuinely truncated payload is still REJECTED by
    // parseToolArguments (the 2026-08-30 audit holds — nothing here completes a
    // severed call). See `decodeChunk` / the flush in finish().
    const decoder = new StringDecoder('utf8');
    /** Decode one Buffer chunk, carrying any split code point into the next. */
    const decodeChunk = (chunk: any): string => {
      // A gateway that hands us a string keeps the old path (already decoded
      // text). Anything byte-shaped goes through the stateful decoder; an
      // ArrayBuffer (independent review N3) would make decoder.write throw, so
      // narrow it first rather than turning a decode into a rejected turn.
      if (typeof chunk === 'string') return chunk;
      if (Buffer.isBuffer(chunk)) return decoder.write(chunk);
      return decoder.write(Buffer.from(chunk as any));
    };
    let content = '';
    let reasoning = '';
    let finishReason: string | null = null;
    let settled = false;
    // efdb3d31 EMISSION SIGNAL (see TurnResult.streamCompleted): did the SSE
    // transport send its own `data: [DONE]` terminator? Absent sentinel ⇒ the
    // connection was severed mid-payload and any tool call is partial.
    let sawDone = false;
    let lastRepCheck = 0;
    // Ticket efdb3d31 (2026-10-29): the GATEWAY-OR-OURS discriminator.
    // Sum of every `function.arguments` fragment length the gateway ACTUALLY
    // handed us, per the SSE deltas. Compared at finalize against the bytes we
    // accumulated into the slots:
    //   sum(deltaArgsLen) === sum(slot.args.length) ⇒ we appended everything we
    //     received, so the payload the gateway SENT was already short ⇒ GATEWAY.
    //   sum(deltaArgsLen)  >  sum(slot.args.length) ⇒ fragments arrived and we
    //     dropped them ⇒ OURS (duplicate-drop or a routing refusal).
    // `buffer.length` at finish() is the second ours-side probe: the SSE reader
    // splits on '\n' and keeps the incomplete tail in `buffer`, which finish()
    // has never drained — a stream that ends WITHOUT a trailing newline loses
    // that final line silently. Non-zero here is direct evidence of that path.
    // LENGTHS ONLY (no payload bytes), so nothing sensitive is recorded.
    let deltaArgsLen = 0;
    let deltaArgFragments = 0;
    // efdb3d31 (2026-10-30): THE PARSE-FAIL BLIND SPOT — MEASURED, not tidy-up.
    // `deltaArgsLen` only counts deltas we PARSED. A `data:` frame our JSON
    // reader rejects is invisible to it, so `recv == acc` can read perfectly
    // while whole tool-call fragments are discarded at the frame boundary. That
    // is one of the three hypotheses this instrumentation exists to separate,
    // and nothing recorded it. Counts and lengths only, never content.
    let parseFailLines = 0;
    let parseFailBytes = 0;
    let parseFailToolCalls = 0;
    // efdb3d31 (2026-10-30, firing 6 — MEASURED). THE SECOND BLIND SPOT, and the
    // worse of the two: a line that does not start with `data:` is skipped by
    // this reader before any counter can see it. `recv` is a sum over `data:`
    // frames we PARSED, so a payload split across lines — or emitted with the
    // prefix lost — contributes to NEITHER side of the recv-vs-acc subtraction
    // and renders a perfectly clean `drop=0` that blames the gateway.
    //
    // Blank lines (event separators), `:`-comments and the SSE non-payload
    // fields (`event:`/`id:`/`retry:`) are legitimate and are NOT counted;
    // anything else in a `data:`-framed stream is a raw line we discarded
    // unread. Lengths and counts only, never content.
    let skippedRawLines = 0;
    let skippedRawBytes = 0;
    // An SSE EVENT split across several `data:` lines is legal (the spec joins
    // them with "\n"). This reader parses each `data:` line as its own JSON
    // document, so a spec-compliant split frame fails to parse — and, if its
    // continuation lines carry no `data:` prefix, part of it lands in
    // `skippedRaw*` instead. Counting the multi-line events makes that shape
    // observable rather than inferred.
    let multilineDataEvents = 0;
    let dataLinesThisEvent = 0;
    // Per-slot assembly trace: how many argument fragments actually landed in
    // each slot, and how many deltas carried NO usable `index`. A gateway that
    // renumbers or omits `index` mid-call makes fragments land in the wrong
    // slot; without these two numbers the finalize row's slot table cannot tell
    // "the bytes never arrived" from "the bytes arrived in the wrong bucket".
    const slotFragments: Record<number, number> = {};
    let deltasWithoutIndex = 0;
    // efdb3d31 (2026-10-30): bytes a delta carried in a shape this accumulator
    // cannot READ (legacy `function_call.arguments`, a top-level `arguments`).
    // Such bytes are invisible to BOTH sides of the recv-vs-acc subtraction, so
    // they would render a clean `drop=0` and hand the verdict to the gateway
    // for a defect of ours. Non-zero here VOIDS the gateway verdict for the
    // turn. Lengths only, never content.
    let unreadArgBytes = 0;
    let usage: { promptTokens: number; completionTokens: number; cachedTokens?: number } | undefined;
    const toolAcc: Record<number, ToolCallSlot> = {};
    // Ticket 5bdbb126: which slot a fragment last landed in — an anonymous
    // fragment continues the call being STREAMED, not the highest index.
    let lastToolSlot = -1;
    // Set when a fragment could not be routed to any call: the turn fails
    // closed rather than executing a tool with another call's arguments.
    let toolAccAmbiguous = false;
    // Ticket 3b75ba8e: fragments dropped as a PROVEN re-send of a payload a
    // slot already holds in full (same gateway id, same tool, same bytes) — a
    // retransmitting gateway must not fire a mutating call twice. Logged so the
    // drop is observable, never silent.
    let toolAccDuplicates = 0;

    // Route GLM's leading <think>…</think> (streamed inside content) to `reasoning`.
    const thinkRouter = createThinkRouter(provider.model, {
      onAnswer: (s) => { content += s; callbacks.onContent?.(s); },
      onThink: (s) => { reasoning += s; callbacks.onReasoning?.(s); },
    });

    // Token-idle stall watchdog (see ModelTurnOptions): lastDeltaAt moves ONLY on a parsed token payload.
    let lastDeltaAt = Date.now();
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    const clearStall = () => { if (stallTimer) { clearInterval(stallTimer); stallTimer = undefined; } };
    if (stallMs !== undefined) {
      stallTimer = setInterval(() => {
        if (settled) { clearStall(); return; }
        if (Date.now() - lastDeltaAt <= stallMs) return;
        settled = true;
        clearStall();
        clearCancelPoll();
        // ESTALL, never ETIMEDOUT: a stall is the MODEL going quiet, not the host — an ETIMEDOUT text matched
        // helper-seat's LEAD_SOFT_UNREACHABLE after one retry and moved a custom-endpoint colleague onto the
        // coding_default chain for the rest of the run (integration review 2026-10-20). The agent loop's
        // transient lane matches ESTALL itself.
        const err: any = new Error(`ESTALL: model stream stalled — no tokens for ${Math.round(stallMs / 1000)}s`);
        err.code = 'ESTALL';
        try { stream.destroy(err); } catch { /* already closing */ }
        reject(err);
      }, streamStallPollMs(stallMs));
      stallTimer.unref?.();
    }

    const finish = () => {
      if (settled) return; // stream.destroy() fires end/close/error — resolve once
      settled = true;
      clearStall();
      clearCancelPoll();
      thinkRouter.flush();
      // Ticket f3e56567 — NOTE ON THE DECODER REMAINDER (deliberately NOT flushed).
      // A stream that ends mid-code-point leaves up to 3 bytes held inside the
      // StringDecoder. They are intentionally dropped rather than appended to
      // `buffer`: finish() below does not drain the trailing fragment (by design
      // — efdb3d31 keeps it as the `undrainedBufferBytes` discriminator), so any
      // bytes pushed here would be stranded and never parsed anyway, and adding
      // synthesized U+FFFD chars to a BYTE counter would corrupt the
      // gateway-or-ours reading. Dropping them cannot make a severed call
      // executable (no byte-removal completes a JSON object), so the 2026-08-30
      // audit holds.
      // efdb3d31 DEFECT FIX (post-merge review, 2026-10-29 — real, reproduced).
      // The line loop only processes COMPLETE lines: it does
      //     const lines = buffer.split('\n'); buffer = lines.pop() || '';
      // so the final unterminated fragment is parked in `buffer` waiting for a
      // next chunk that may never come. A gateway that ends the stream with
      // `data: [DONE]` and NO trailing newline therefore leaves the sentinel
      // sitting in `buffer`, never parsed — and a perfectly CLEAN stream read
      // `streamCompleted: false`, which is a false positive pointing straight at
      // the re-emit lane (an extra round-trip on every such turn, and on a
      // sentinel-less provider that never sends it at all the field is merely
      // undefined, which is safe). Probe the tail WITHOUT draining it:
      // `buffer.length` is the discriminator's undrainedBufferBytes and must
      // keep that exact meaning.
      if (!sawDone && buffer.trim() === 'data: [DONE]') sawDone = true;
      if (usage && typeof usage.cachedTokens === 'number') {
        logger.debug(`prompt cache [${provider.model}]: ${usage.cachedTokens}/${usage.promptTokens} prompt tokens served from cache`);
      }
      if (toolAccDuplicates > 0) {
        // Ticket 3b75ba8e: make a dropped re-send visible. A silent drop is the
        // fail-silent shape the 2026-08-30 audit forbids, so it always surfaces.
        logger.warn(`tool-call stream [${provider.model}]: dropped ${toolAccDuplicates} duplicate fragment(s) — a re-send of a call already assembled in full (same gateway id, tool and payload)`, { source: 'run-model-turn', model: provider.model });
      }
      // Ticket efdb3d31: EMISSION-SIDE GUARD — fold an ORPHANED CONTINUATION slot
      // back into the call it belongs to. The model splits one `goal_update` into
      // a header delta (index 0, with id+name) and a continuation delta at a
      // DIFFERENT index carrying NO name; rule 1 (explicit index wins) routes the
      // continuation into a fresh UNNAMED slot, which the `.filter(tc => tc.name)`
      // below then DISCARDED. The call was dispatched holding only its header
      // (`{"goalId": "8f0dcd6f", "progressNote": `) and read "did not parse as a
      // JSON object … NOTHING was executed" — the reporter's exact symptom, on
      // both a long note and a deliberately short retry, because the mechanism is
      // positional rather than about length.
      // mergeOrphanContinuations folds ONLY: an unnamed slot, attributable to
      // exactly one named call (same gateway id, else a single-call turn), whose
      // owner has NOT already assembled a complete payload (a2da5f49's rule — a
      // finished call never absorbs foreign bytes). Slot index is the GATEWAY's
      // `index`, not arrival order, so the orphan is folded from either side: a
      // BACKWARD fold (tail numbered below the name-carrying fragment — the live
      // post-deploy shape) happens only when the join parses as a complete JSON
      // object, so nothing is completed or guessed. Bytes only ever move between
      // slots of the SAME call, so the 2026-08-30 audit holds: a genuinely
      // truncated payload still dies at the parser.
      // Skipped when the turn could not be ROUTED (toolAccAmbiguous): there the
      // bytes are not attributable to any call, which is what the 5bdbb126 F2/X1
      // fail-closed guard exists for.
      if (!toolAccAmbiguous) {
        const foldedSlots = mergeOrphanContinuations(toolAcc);
        if (foldedSlots.length) {
          // Observable, never silent — a folded continuation always surfaces.
          logger.warn(`tool-call stream [${provider.model}]: folded orphaned continuation slot(s) ${foldedSlots.join(',')} into their owning call — the nameless continuation was being discarded and its call dispatched truncated`, { source: 'run-model-turn', model: provider.model });
        }
      }
      // Ticket efdb3d31 (2026-10-29, FIFTH POST-DEPLOY DROP): OBSERVE-ONLY
      // finalize-seam diagnosis. Six attribution repairs have shipped and the
      // live seat still drops `goal_update` with exactly ONE ok:false row and
      // "Unexpected end of JSON input" — a reason that, measured, can only come
      // from a severed head dispatched ALONE (welding a complete payload onto a
      // head yields "Expected ',' or '}'" or "Unexpected non-whitespace
      // character after JSON" instead). A probe driving these shipped functions
      // with fifteen candidate shapes agreed: every shape carrying a complete
      // payload is already repaired or yields a second, parseable call. So on
      // the live drops NO complete payload was in this table at all, and no
      // further attribution rule can recover one.
      //
      // What remains is a small set of mechanisms that only the slot table plus
      // the provider's finish_reason can separate — above all an output-cap cut
      // ('length'), which is currently INVISIBLE: isEmptyTruncatedTurn bails the
      // moment any tool call exists, so a cap-truncated call is dispatched
      // instead of retried. This records the discriminating facts and changes
      // nothing about the turn.
      if (!toolAccAmbiguous) {
        try {
          const diag = diagnoseToolCallFinalize(toolAcc, finishReason);
          // efdb3d31 GATEWAY-OR-OURS discriminator (lengths only, never bytes).
          //   receivedBytes  = what the gateway actually handed us in SSE deltas
          //   accumulatedBytes = what we managed to put in the slots
          //   unmatchedBufferBytes = the un-drained SSE tail at finish()
          // received === accumulated && buffer === 0 ⇒ the gateway SENT it short.
          // received > accumulated, or buffer > 0 ⇒ WE dropped it.
          const receivedBytes = deltaArgsLen;
          const accumulatedBytes = Object.keys(toolAcc).reduce((s, k) => s + (toolAcc[+k]?.args?.length ?? 0), 0);
          const droppedBytes = receivedBytes - accumulatedBytes;
          // ONE input object feeds BOTH sinks (efdb3d31, 2026-10-29). They used to
          // be assembled separately, which is how the warn line kept a
          // `finishReason=` the meta row dropped: two writers, one fact. The
          // warn line and the durable row must never disagree about the numbers
          // that name the half, and the discriminator now travels inside the
          // 2-char `gw` value so a read cut cannot remove it from either.
          const verdictInput = {
            droppedBytes, undrainedBufferBytes: buffer.length,
            receivedBytes, accumulatedBytes, fragments: deltaArgFragments,
            finishReason: diag.finishReason,
            // efdb3d31 (2026-10-30): the two facts the guard and the frame
            // reader were blind to — the transport's own verdict (`sc`) and the
            // frames we DISCARDED at the parse boundary (`pf/pb/pc`).
            streamCompleted: sawDone,
            parseFailLines, parseFailBytes, parseFailToolCalls,
            // efdb3d31 (2026-10-30, firing 6): lines the frame reader skipped
            // before any counter could see them, and SSE events that arrived
            // split across several `data:` lines. Both are the same class as
            // `parseFail*` — bytes that never entered `receivedBytes` — so a
            // non-zero voids the gateway verdict for the same reason.
            skippedRawLines, skippedRawBytes, multilineDataEvents,
            // efdb3d31 (2026-10-30): bytes we never COUNTED because they rode a
            // shape the accumulator cannot read. Non-zero VOIDS the gateway
            // verdict — see unreadArgumentFragmentLength.
            unreadArgBytes,
          };
          // Per-slot assembly trace, compact: "0:6,1:2" = slot → fragment count,
          // plus how many deltas carried no usable `index`. Together with
          // `frag=` (every delta that carried argument bytes) this separates
          // "bytes never arrived" from "bytes arrived and landed in the wrong
          // bucket". Short key so it survives the 240-char meta read cut.
          const assemblyTrace = Object.keys(slotFragments)
            .sort((a, b) => Number(a) - Number(b))
            .map(k => `${k}:${slotFragments[+k]}`).join(',');
          if (diag.verdict !== 'ok') {
            // Local visibility (box logs) …
            // ORDER MATTERS (efdb3d31, 2026-10-29 — measured, not stylistic). Both
            // sinks for this diagnosis are READ at a ~200-char cut: the durable
            // meta is truncated by the telemetry read surface, and this warn line
            // was stored cut mid-word ("…claims=none GATEWA"), losing the verdict
            // it exists to carry. So the GATEWAY-OR-OURS summary leads, and the
            // verbose slot detail follows where a cut cannot hide the answer.
            //
            // The summary is now ONE shared formatter (finalizeVerdictSummary),
            // not an inline template, so the warn line cannot drift from the meta
            // row again — and it carries `fr=` and the verdict AHEAD of the
            // verbose tail. Measured on the live 22:05:59.211Z row: the previous
            // order put `finishReason=` past char 240 in both sinks, which hid
            // the ONE field that separates an output-cap cut ('length') from a
            // clean provider end that still arrived short ('tool_calls'/null).
            logger.warn(`tool-call stream [${provider.model}]: GATEWAY-OR-OURS ${finalizeVerdictSummary(verdictInput)} verdict=${diag.verdict} — receivedBytes=${receivedBytes} accumulatedBytes=${accumulatedBytes} droppedBytes=${droppedBytes} fragments=${deltaArgFragments} undrainedBufferBytes=${buffer.length} finishReason=${diag.finishReason ?? 'null'} slots=${diag.slots} named=${diag.named} unnamed=${diag.unnamed} broken=${diag.broken.map((b: { k: number; name: string; len: number; reason: string }) => `${b.k}:${b.name}:len${b.len}:${b.reason}`).join('|') || 'none'} discardedComplete=[${diag.discardedComplete.join(',')}] claims=${diag.claims.map((c: { k: number; owners: number[] }) => `${c.k}->[${c.owners.join(',')}]`).join('|') || 'none'}`, { source: 'run-model-turn', model: provider.model });
            // … and the durable row, so the NEXT drop is diagnosed from data.
            void import('../platform/loop-metrics.service')
              .then((lm) => lm.recordLoopMetric({
                kind: lm.LOOP_METRIC_KINDS.TOOL_CALL_FINALIZE,
                // NB: StreamCallbacks carries only onReasoning/onContent at this
                // seam, so there is no sessionId/runId to attribute here. Both
                // fields are optional on LoopMetricInput; the meta carries the
                // model + provider label, which is enough to find the turn.
                meta: {
                  // KEY ORDER IS NOT A LEVER HERE (efdb3d31, 2026-10-29 —
                  // CORRECTION to PR #2087, measured after it deployed).
                  // PR #2087 wrote `culprit` first so the verdict would lead.
                  // That was a NO-OP: loop_metrics.meta is a JSONB column
                  // (migration 20260902000000_loop_metrics: `"meta" JSONB`), and
                  // jsonb canonicalises object keys by LENGTH then bytewise — it
                  // discards the writer's insertion order entirely.
                  //
                  // One live event from the 70cb50de deploy proves it. Same
                  // moment, two sinks:
                  //   warn line: "GATEWAY-OR-OURS culprit=gateway receivedBytes=1810 …"
                  //              (a text log — order survived)
                  //   meta row : {"label","model","named","slots","broken","claims","culprit",…}
                  //              (jsonb's order — the reorder discarded)
                  //
                  // So the lever is key LENGTH: a 2-char key is emitted before
                  // every longer key, so it is always inside the reader's cut.
                  // finalizeVerdictFields carries the verdict AND its arithmetic
                  // in that one short value, so a truncation cannot separate a
                  // verdict from the numbers that justify it.
                  //
                  // The SAME `verdictInput` object feeds the warn line above, so
                  // the two sinks cannot disagree — and `fr=` now rides inside
                  // the short value, because finish_reason was measured sitting
                  // PAST this same 240-char cut as its own long key (it lands
                  // after `broken`, which alone ends at ±238 chars on the live
                  // row). The discriminator the row exists to answer was the one
                  // field the cut removed.
                  ...finalizeVerdictFields(verdictInput),
                  // efdb3d31 (2026-10-30): the per-slot assembly trace and the
                  // index-handling count. `sl` = slot→fragment count, `ni` =
                  // deltas with no usable index. BOTH keys must sort AFTER `gw`:
                  // jsonb orders by key length then BYTEWISE, so a 2-char key
                  // named anything below "gw" (`as`) would sit ahead of the
                  // verdict and push it past the 240-char read cut — the exact
                  // failure this row exists to prevent. `gw` < `ni` < `sl`.
                  sl: assemblyTrace,
                  ni: deltasWithoutIndex,
                  verdict: diag.verdict,
                  slots: diag.slots, named: diag.named, unnamed: diag.unnamed,
                  broken: diag.broken, discardedComplete: diag.discardedComplete, claims: diag.claims,
                  model: provider.model, label: provider.label,
                },
              }))
              .catch(() => { /* telemetry never breaks a turn */ });
          }
        } catch { /* diagnosis never breaks a turn */ }
      }
      const toolCalls: StreamedToolCall[] = Object.keys(toolAcc)
        .sort((a, b) => Number(a) - Number(b))
        .map(k => ({
          id: toolAcc[+k].id,
          name: toolAcc[+k].name,
          // Ticket 5bdbb126 (review F2): when part of the stream could not be
          // routed to a call, the turn's arguments are not trustworthy — every
          // call is handed an unparseable payload so the executor rejects them
          // ("NOTHING was executed") instead of running one tool with another
          // tool's bytes. Same observable outcome as refusing the turn, while
          // the model still gets the per-call rejection it can recover from.
          arguments: toolAccAmbiguous ? AMBIGUOUS_STREAM_ARGUMENTS : toolAcc[+k].args,
        }))
        .filter(tc => tc.name);
      // efdb3d31 CRITERION 1 (2026-10-30): carry the per-fragment arithmetic
      // OFF this seam so a REJECTED call's own row can state whether its bytes
      // ever arrived. Computed from the same promise-scope counters the finalize
      // row uses, so the two rows cannot disagree; suppressed when the
      // accumulator was ambiguous, where the arithmetic would be meaningless
      // rather than merely unknown.
      const streamTrace = toolAccAmbiguous ? undefined : {
        receivedBytes: deltaArgsLen,
        accumulatedBytes: Object.keys(toolAcc).reduce((s, k) => s + (toolAcc[+k]?.args?.length ?? 0), 0),
        droppedBytes: deltaArgsLen - Object.keys(toolAcc).reduce((s, k) => s + (toolAcc[+k]?.args?.length ?? 0), 0),
        fragments: deltaArgFragments,
        undrainedBufferBytes: buffer.length,
        assemblyTrace: Object.keys(slotFragments)
          .sort((a, b) => Number(a) - Number(b))
          .map(k => `${k}:${slotFragments[+k]}`).join(','),
        deltasWithoutIndex,
        // efdb3d31 (2026-10-30): carried to the REJECT row too, because a
        // rejection on a turn whose argument bytes rode an unreadable shape is
        // OURS, and the reject row is where a reader decides who to blame.
        unreadArgBytes,
        // efdb3d31 (2026-10-30, firing 6 CORRECTION — independent review): the
        // same reasoning, applied to the counters firing 6 ADDED. Carrying them
        // on the finalize row only made them unreadable at exactly the seam that
        // matters: a cut turn is REJECTED, the reject row is emitted, and an
        // analyst reading it could not see that lines had been skipped or that
        // tool-call frames had been discarded. Recording a counter the reader
        // cannot reach is the same as not recording it.
        skippedRawLines,
        skippedRawBytes,
        multilineDataEvents,
        parseFailLines,
        parseFailToolCalls,
      };
      resolve({ content, reasoning, toolCalls, finishReason, usage, streamCompleted: sawDone, streamTrace });
    };

    // Throttled wrapper around looksRepetitive (scan at most every ~400 chars).
    const degenerating = (): boolean => {
      if (content.length - lastRepCheck < 400) return false;
      lastRepCheck = content.length;
      return looksRepetitive(content);
    };
    // Stall mode only (see ModelTurnOptions): the reasoning twin, throttled to one probe per ~2,000 reasoning chars.
    let lastReasoningRepCheck = 0;
    const reasoningLooping = (): boolean => {
      if (stallMs === undefined || reasoning.length - lastReasoningRepCheck < REASONING_REPEAT_CHECK_EVERY_CHARS) return false;
      lastReasoningRepCheck = reasoning.length;
      return looksReasoningLoop(reasoning);
    };

    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      // Stop pressed mid-stream (e.g. during a long reasoning phase): abandon
      // this turn NOW rather than waiting for the step boundary.
      if (isCancelled?.()) {
        finishReason = 'cancelled';
        try { stream.destroy(); } catch { /* already closing */ }
        finish();
        return;
      }
      buffer += decodeChunk(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) {
          // Blank line = end of an SSE event. Record a multi-line event, then reset.
          if (dataLinesThisEvent > 1) multilineDataEvents += 1;
          dataLinesThisEvent = 0;
          continue;
        }
        if (!t.startsWith('data:')) {
          // efdb3d31 (2026-10-30, firing 6): RECORD THE UNREAD LINE. The three
          // prefixes below are legitimate SSE and cost nothing; ANY other line
          // in a data:-framed stream is payload we discarded before it could be
          // counted, which is exactly the verdict-blind spot this counter
          // exists for. (A `:` comment is the spec's keepalive.)
          if (!(t.startsWith(':') || t.startsWith('event:') || t.startsWith('id:') || t.startsWith('retry:'))) {
            skippedRawLines += 1;
            skippedRawBytes += t.length;
          }
          continue;
        }
        dataLinesThisEvent += 1;
        const data = t.slice(5).trim();
        if (data === '[DONE]') {
          // efdb3d31 EMISSION SIGNAL: the protocol's own terminator. Record it
          // and keep the existing `continue` — nothing downstream changes here.
          sawDone = true;
          continue;
        }
        try {
          const parsed = JSON.parse(data);
          // Usage arrives on the final chunk (often with an empty choices array).
          if (parsed.usage && typeof parsed.usage.prompt_tokens === 'number') {
            lastDeltaAt = Date.now();
            // Context-cache savings: audit 2026-10-08 W3-2 reads EVERY provider
            // shape (Moonshot `cached_tokens`, DeepSeek `prompt_cache_hit_tokens`,
            // OpenAI-compatible / LiteLLM / Z.ai `prompt_tokens_details.cached_tokens`,
            // Anthropic passthrough) — was Moonshot-only, so gateway / DeepSeek /
            // GLM seats recorded zero cache. PROMPT_CACHE_METRICS_DISABLED=1 restores it.
            const cachedTokens = parseCachedPromptTokens(parsed.usage);
            usage = {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens || 0,
              ...(typeof cachedTokens === 'number' ? { cachedTokens } : {}),
            };
          }
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};
          if (choice.finish_reason) finishReason = choice.finish_reason;

          // A token of any kind is liveness (a `reasoning` field some gateways use instead of reasoning_content too).
          if (delta.reasoning_content || delta.content || (typeof delta.reasoning === 'string' && delta.reasoning) || (Array.isArray(delta.tool_calls) && delta.tool_calls.length)) {
            lastDeltaAt = Date.now();
          }
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            callbacks.onReasoning?.(delta.reasoning_content);
          } else if (stallMs !== undefined && typeof delta.reasoning === 'string' && delta.reasoning) {
            // Stall mode (see ModelTurnOptions): a gateway's `reasoning` field is reasoning like reasoning_content —
            // the watchdog above already counts it, so the run's events must carry it too.
            reasoning += delta.reasoning;
            callbacks.onReasoning?.(delta.reasoning);
          }
          if (delta.content) {
            thinkRouter.feed(delta.content);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              // Ticket efdb3d31 GATEWAY-OR-OURS discriminator — COUNT FIRST.
              // This MUST stay ahead of the UNRESOLVABLE_SLOT and
              // DUPLICATE_FRAGMENT branches below, because those are precisely
              // the two places THIS code discards bytes the gateway already
              // handed us. Counting after them (the shape this instrument was
              // first landed in) makes every ours-side drop invisible: received
              // then equals accumulated, `droppedBytes` reads 0, and a real drop
              // is mislabelled 'gateway'. That is the one verdict this
              // instrument exists to get right, so the count is unconditional
              // here and the accumulator's own length rule is used
              // (argumentFragmentLength mirrors appendArgumentsFragment), so an
              // OBJECT fragment cannot drive droppedBytes negative.
              const fragBytes = argumentFragmentLength(tc.function?.arguments);
              if (fragBytes > 0) {
                deltaArgsLen += fragBytes;
                deltaArgFragments += 1;
              } else {
                // efdb3d31 (2026-10-30): ZERO BYTES ON THE PATH WE READ is not
                // the same as ZERO BYTES SENT. A delta carrying its payload on
                // `arguments`/`function_call.arguments` is invisible to BOTH
                // sides of recv-vs-acc, so it would render `drop=0` and hand
                // the verdict to the gateway for our own defect. Count it here
                // (inside the else, so a clean delta costs nothing) and let the
                // finalize row VOID the gateway verdict with `ur=`.
                unreadArgBytes += unreadArgumentFragmentLength(tc);
              }
              // Assembly-trace side channel (efdb3d31): a delta with no usable
              // `index` is routed by id or by "the call being streamed", which
              // is exactly where a mid-stream renumbering would mis-bucket
              // bytes. Counts only — resolveToolCallSlot stays the sole router.
              const rawIdx = tc?.index;
              if (!(typeof rawIdx === 'number' && Number.isFinite(rawIdx))
                && !(typeof rawIdx === 'string' && /^\d+$/.test(rawIdx.trim()))) {
                deltasWithoutIndex += 1;
              }
              // Ticket 5bdbb126: an index-less gateway used to collapse EVERY
              // call of a turn into slot 0, concatenating two independent
              // complete payloads into `{…}{…}` — the whole turn then failed to
              // parse and read as "truncated or malformed". resolveToolCallSlot
              // keys on index, else id, else the call actually being streamed,
              // and REFUSES (never guesses) when that is ambiguous.
              const idx = resolveToolCallSlot(toolAcc, tc, lastToolSlot);
              if (idx === UNRESOLVABLE_SLOT) {
                // Two calls are open and this fragment cannot be routed: fail
                // the turn closed rather than execute one tool with another
                // tool's arguments (adversarial review F2/X1).
                toolAccAmbiguous = true;
                continue;
              }
              if (idx === DUPLICATE_FRAGMENT) {
                // Ticket 3b75ba8e: the gateway retransmitted a payload this
                // slot already holds in full. Appending it would fire the SAME
                // call twice (a zero-argument MUTATING tool included) and make
                // the arguments unparseable — drop it, keep the good call.
                toolAccDuplicates += 1;
                continue;
              }
              lastToolSlot = idx;
              if (!toolAcc[idx]) toolAcc[idx] = { id: tc.id || `call_${idx}`, name: '', args: '' };
              // Assembly trace: count the fragments that actually landed here.
              slotFragments[idx] = (slotFragments[idx] ?? 0) + 1;
              // Ticket 3b75ba8e: keep the gateway's own id as the routing key
              // and de-duplicate only the EMITTED id — one gateway id reused for
              // two calls would otherwise replay duplicate tool_call ids, which
              // provider APIs reject.
              if (tc.id) {
                toolAcc[idx].gwId = tc.id;
                toolAcc[idx].id = uniqueToolCallId(toolAcc, idx, tc.id);
              }
              if (tc.function?.name) toolAcc[idx].name = tc.function.name;
              // A gateway may stream arguments as a parsed object, not a
              // fragment string — string-concatenating one produced the
              // literal text "[object Object]" (ticket 5bdbb126).
              if (tc.function?.arguments) {
                // NOTE (efdb3d31): the received-side count is taken at the TOP
                // of this loop body, before the routing/duplicate branches — do
                // not re-count here or every byte lands twice and droppedBytes
                // reads negative.
                toolAcc[idx].args = appendArgumentsFragment(toolAcc[idx].args, tc.function.arguments);
              }
            }
          }
        } catch {
          // Non-JSON `data:` line. Standard OpenAI SSE carries JSON delta
          // chunks, but some OpenAI-compatible gateways (observed on a
          // LiteLLM/vLLM proxy config, llm.cql.ca — a registered Digby Edge
          // endpoint) stream RAW TEXT tokens as the data payload instead.
          // This parser used to discard every such line as a "keepalive", so
          // those endpoints produced an empty answer — a blank/hung chat with
          // no error (owner report 2026-09-05). Treat a non-empty, non-JSON
          // payload as a content delta, preserving the token's own spacing
          // (SSE strips only ONE leading space after "data:"). Genuine
          // keepalives are empty `data:` lines or `:`-comment lines (the latter
          // never match `data:`), so they still no-op. NOTE: tool calls cannot
          // ride a raw-text stream, so agentic seats on such an endpoint answer
          // in prose only — the gateway should emit standard JSON chunks for
          // full function-calling support.
          const raw = sseRawTextPayload(line);
          // efdb3d31 (2026-10-30): RECORD THE DISCARD. A frame we could not
          // parse is either the legitimate raw-text token this branch exists
          // for, or a mangled JSON chunk carrying tool-call bytes — and until
          // now both were indistinguishable and both were absent from the
          // finalize arithmetic.
          //
          // TWO PRECISION FIXES (independent review D3/D4, same day):
          //  - an EMPTY `data:` payload is a KEEPALIVE, not a failure. It
          //    reaches this catch only because `JSON.parse('')` throws, so
          //    counting it made a perfectly clean turn read `pf=1 pb=0` — a
          //    token that names nothing and dilutes the discriminator. Skip it.
          //  - `pc` must count a tool-call SHAPE, not the bare word
          //    `"function"`: legitimate prose containing the quoted word would
          //    otherwise be reported as a corrupted tool-call frame. Require a
          //    JSON-ish key (`"tool_calls":`, `"function": {`, `"arguments":`).
          if (data) {
            parseFailLines += 1;
            parseFailBytes += data.length;
            if (looksLikeToolCallFrame(data)) parseFailToolCalls += 1;
          }
          if (raw) { lastDeltaAt = Date.now(); thinkRouter.feed(raw); }
        }
      }
      // Abort a runaway/looping generation: drop the repeated tail, flag the turn
      // so the agent loop can nudge + retry instead of persisting the garbage.
      if (!settled && degenerating()) {
        finishReason = 'repetition';
        content = content.slice(0, Math.max(0, content.length - REPEAT_WINDOW_CHARS))
          + '\n[Output truncated — the model began repeating itself.]';
        try { stream.destroy(); } catch { /* already closing */ }
        finish();
      }
      // …and a looping REASONING stream (stall mode): the same 'repetition' turn end — the agent loop nudges and
      // retries (bounded) instead of the watchdog-alive loop running to the output budget.
      if (!settled && reasoningLooping()) {
        finishReason = 'repetition';
        reasoning = reasoning.slice(0, Math.max(0, reasoning.length - REASONING_REPEAT_WINDOW_CHARS))
          + '\n[Reasoning truncated — the model began repeating itself.]';
        try { stream.destroy(); } catch { /* already closing */ }
        finish();
      }
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', (err: Error) => {
      if (settled) return;
      clearStall();
      clearCancelPoll();
      // An abort() (Stop) surfaces here as a stream error — resolve it as a
      // clean cancelled turn, not a reject the recovery path would retry.
      if (abort.signal.aborted || (err as any)?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') {
        settled = true;
        resolve({ content, reasoning, toolCalls: [], finishReason: 'cancelled', usage });
        return;
      }
      reject(err);
    });
  });
}

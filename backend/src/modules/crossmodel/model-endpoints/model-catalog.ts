/**
 * Model catalog — dynamic roster, phase 1 (docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md §5;
 * owner chose option B on 2026-10-03).
 *
 * ONE list of every CHAT-capable model this instance can run: the built-ins
 * (coding-model.ts) plus every chat-capable model on an ENABLED registry
 * endpoint (Account → Admin → Endpoints). Each entry carries a capability CARD
 * the roster planner and the admin Auto-pools editor read:
 *   family   — the vendor / model line, so a checker can be picked from a
 *              DIFFERENT family than the lead (independent coverage);
 *   tier     — fast / standard / strong, from the model id;
 *   vision, contextChars, maxTools, price (USD per 1M tokens, null = unknown;
 *              a registry model with no price of its own takes its built-in
 *              TWIN's list price — roster 2026-10-06 C-1, `priceSource`),
 *   frontier — the seat-governance class (provider-class.ts). A frontier card
 *              is NEVER `autoEligible` (owner 2026-10-06 late: "pickers should
 *              never choose frontier anyway" — frontier models are consulted
 *              only by the reflection council, coding/frontier-council.ts).
 *              The effective AUTO-PICK POLICY (platform/roster-policy.ts) is
 *              'open_only' whatever the store says; only the env opt-in
 *              AUTO_PICK_FRONTIER_ENABLED=1 honours a stored 'all' again (the
 *              C-1 cost-weighted admission);
 *   servable — a built-in whose provider key is missing cannot answer here.
 * Everything is derived on read — nothing is stored. The pure helpers
 * (modelFamily, modelTier, builtInCard, registryCard) carry the rules and are
 * unit-tested; listChatModelCatalog only gathers rows.
 */

// coding-model is loaded LAZILY (listChatModelCatalog): it pulls the env-validated
// provider config, and admin controllers import this module at load time.
import type { ProviderConfig } from '../coding/coding-model';
import { PRICES } from '../coding/cost';
import type { EndpointModelEntry, ModelEndpointSummary } from './model-endpoints.service';
import { DEFAULT_AUTO_PICK_POLICY, type AutoPickPolicy } from '../platform/roster-policy';

export type ModelTier = 'fast' | 'standard' | 'strong';

export interface ModelCard {
  /** The spec a seat / pool stores: a built-in id ('glm-5.3') or '<label>:<modelId>'. */
  spec: string;
  /** Display name for pickers. */
  name: string;
  source: 'builtin' | 'registry';
  family: string;
  tier: ModelTier;
  vision: boolean;
  /** Transcript budget in characters; null = the run path's default. */
  contextChars: number | null;
  /** Tool-list cap; null = no documented cap. */
  maxTools: number | null;
  /** USD per 1M input / output tokens; null = no price on record. */
  priceIn: number | null;
  priceOut: number | null;
  /** Where the price came from (roster 2026-10-06 C-1): the registry entry, the endpoint's settings, the built-in
   *  cost table, or a built-in TWIN of the same model line; absent / null = no price on record. */
  priceSource?: 'entry' | 'endpoint' | 'builtin' | 'twin' | null;
  /** Seat-governance class: a frontier vendor host or a closed frontier model id. */
  frontier: boolean;
  /** May an AUTOMATIC pick choose it — the effective auto-pick policy (roster-policy.ts): 'open_only' (the hard rule,
   *  owner 2026-10-06 late) ⇒ open models only; 'all' only under the env opt-in AUTO_PICK_FRONTIER_ENABLED=1. */
  autoEligible: boolean;
  /** A built-in needs its provider key on this instance; a listed registry model is servable
   *  unless the entry is RETIRED (2026-10-06: `unservable` on the entry — the gateway route
   *  was torn down, so the card stays listed but never routes). */
  servable: boolean;
  /** The model is flagged "no-think" on its endpoint entry (registry only). */
  thinkingOff: boolean;
}

const FAMILY_RULES: ReadonlyArray<[RegExp, string]> = [
  [/glm|zhipu|z-?ai\b/i, 'glm'],
  [/kimi|moonshot/i, 'kimi'],
  [/deepseek/i, 'deepseek'],
  [/qwen|qwq|dashscope|alibaba/i, 'qwen'],
  [/mimo|xiaomi/i, 'mimo'],
  // MiniMax (gateway swap 2026-10-24, live-probed on llm.example.com): served as
  // `minimax-m3.1-flash` plus the bare alias `m3.1-flash` (both e2e 200, ctx
  // 262144 via /model/info) on the spark boxes, replacing the deepseek-v4.1-flash
  // routes that now dead-name 404. The bare alias carries no vendor stem, so the
  // versioned m-flash shape itself names the line — `m<version>-flash`.
  [/minimax|\bm\d+(?:\.\d+)?-flash/i, 'minimax'],
  [/claude|anthropic/i, 'claude'],
  [/gpt|openai|\bo[134]\b/i, 'gpt'],
  [/grok|xai\b/i, 'grok'],
  [/gemini|gemma/i, 'gemini'],
  [/llama|meta-/i, 'llama'],
  [/mistral|mixtral|codestral/i, 'mistral'],
  [/command|cohere/i, 'cohere'],
  [/laya|jev|kev\b/i, 'decision'],
];

/** The model id part of a spec ('<label>:<modelId>' → modelId). Pure. */
export function modelIdOf(spec: string): string {
  const s = String(spec ?? '');
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * The model family a spec belongs to — matched on the MODEL id only, never the
 * endpoint label (a gateway label like "cql-litellm" says nothing about the
 * model). The vendor prefix a proxy adds ("api-optimize-alibaba-deepseek-…")
 * is ignored in favour of the model line it names: the rules run on the id
 * with any "api-<vendor>-" style routing prefix stripped first. Pure.
 */
export function modelFamily(spec: string): string {
  const id = modelIdOf(spec).toLowerCase();
  // Proxy routing prefixes name the HOSTING vendor, not the model line
  // ("api-optimize-alibaba-deepseek-v4.1-flash" is DeepSeek served by Alibaba).
  const core = id.replace(/^(?:api-)?(?:optimize-)?(?:alibaba|fireworks|together|azure|bedrock|vertex|openrouter|groq|cerebras)-(?=.)/, '').replace(/^(?:api|tt|spark|agx)-/, '');
  for (const [re, fam] of FAMILY_RULES) if (re.test(core)) return fam;
  for (const [re, fam] of FAMILY_RULES) if (re.test(id)) return fam;
  return 'other';
}

/**
 * Speed / strength tier from the model id. fast = flash / mini / lite / nano /
 * haiku / turbo / helper / luna, or a parameter count ≤ 32B; strong = max /
 * pro / opus / ultra / sol / astra; everything else standard. A heuristic for
 * ordering and display — the admin's pool order always wins. Pure.
 */
export function modelTier(spec: string): ModelTier {
  const id = modelIdOf(spec).toLowerCase();
  if (/(?:^|[-_.\s])(flash|mini|lite|nano|haiku|turbo|helper|luna|small)(?:$|[-_.\s])/.test(id)) return 'fast';
  const params = id.match(/(?:^|[-_.\s])(\d+(?:\.\d+)?)b(?:$|[-_.\s])/);
  if (params && Number(params[1]) <= 32) return 'fast';
  if (/(?:^|[-_.\s])(max|pro|opus|ultra|sol|astra)(?:$|[-_.\s])/.test(id)) return 'strong';
  return 'standard';
}

/** A built-in's card from its provider entry (pure over the inputs). */
export function builtInCard(id: string, p: Pick<ProviderConfig, 'supportsVision' | 'contextChars' | 'envKey'>, env: NodeJS.ProcessEnv = process.env): ModelCard {
  const price = PRICES[id];
  return {
    spec: id,
    name: id,
    source: 'builtin',
    family: modelFamily(id),
    tier: modelTier(id),
    vision: p.supportsVision === true,
    contextChars: typeof p.contextChars === 'number' && p.contextChars > 0 ? p.contextChars : null,
    maxTools: null,
    priceIn: price ? price.in : null,
    priceOut: price ? price.out : null,
    priceSource: price ? 'builtin' : null,
    frontier: false,
    autoEligible: true,
    servable: !p.envKey || !!String(env[p.envKey] ?? '').trim(),
    thinkingOff: false,
  };
}

/** A registry model's card (pure over the endpoint summary + its entry). */
/** Tokens → transcript chars (~4 chars/token, half the window) — the run path's registryContextChars is passed in by the loader. */
const approxContextChars = (tokens: number): number => Math.round(tokens * 4 * 0.5);

/**
 * The built-in TWIN of a registry model id, for its price (roster 2026-10-06 C-1): the same model line served
 * directly — routing prefixes ("api-", "optimize-", hosting vendors) stripped, then an exact cost-table id or a known
 * alias (`api-optimize-zai-glm-5.3` ⇒ glm-5.3, `api-optimize-alibaba-deepseek-v4.1-flash` ⇒ deepseek-flash,
 * `api-optimize-moonshot-kimi-k3` ⇒ kimi-k3). null when no built-in shares the line. Pure.
 */
const TWIN_ALIASES: Readonly<Record<string, string>> = { 'deepseek-v4.1-flash': 'deepseek-flash', 'deepseek-v4-1-flash': 'deepseek-flash' };
export function builtInTwinOf(modelId: string): string | null {
  const core = String(modelId ?? '').toLowerCase()
    .replace(/^(?:api-)?(?:optimize-)?(?:alibaba|fireworks|together|azure|bedrock|vertex|openrouter|groq|cerebras|moonshot|zai|z-ai|dashscope)-(?=.)/, '')
    .replace(/^(?:api|tt|spark|agx)-/, '');
  const id = TWIN_ALIASES[core] ?? core;
  return Object.prototype.hasOwnProperty.call(PRICES, id) ? id : null;
}

export function registryCard(ep: Pick<ModelEndpointSummary, 'label' | 'settings' | 'frontierModelIds' | 'providerClass'>, m: EndpointModelEntry, toContextChars: (tokens: number) => number = approxContextChars, opts: { autoPickPolicy?: AutoPickPolicy } = {}): ModelCard {
  const settings = (ep.settings ?? {}) as { maxTools?: number; usdPerMTokIn?: number; usdPerMTokOut?: number };
  const frontier = ep.providerClass === 'frontier' || (ep.frontierModelIds ?? []).includes(m.id);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const maxTools = num(m.maxTools) ?? num(settings.maxTools);
  const policy = opts.autoPickPolicy ?? DEFAULT_AUTO_PICK_POLICY;
  const entryIn = num(m.usdPerMTokIn), entryOut = num(m.usdPerMTokOut);
  const epIn = num(settings.usdPerMTokIn), epOut = num(settings.usdPerMTokOut);
  const twin = entryIn === null && entryOut === null && epIn === null && epOut === null && !frontier ? builtInTwinOf(m.id) : null;
  const priceIn = entryIn ?? epIn ?? (twin ? PRICES[twin].in : null);
  const priceOut = entryOut ?? epOut ?? (twin ? PRICES[twin].out : null);
  const priceSource: ModelCard['priceSource'] = entryIn !== null || entryOut !== null ? 'entry' : epIn !== null || epOut !== null ? 'endpoint' : twin ? 'twin' : null;
  return {
    spec: `${ep.label}:${m.id}`,
    name: `${ep.label} · ${m.displayName || m.id}`,
    source: 'registry',
    family: modelFamily(m.id),
    tier: modelTier(m.id),
    vision: m.vision === true,
    contextChars: typeof m.contextWindow === 'number' && m.contextWindow > 0 ? toContextChars(m.contextWindow) : null,
    maxTools: maxTools && maxTools > 0 ? maxTools : null,
    priceIn,
    priceOut,
    priceSource,
    frontier,
    autoEligible: policy === 'all' ? true : !frontier,
    // 2026-10-06 retired entries (f90 follow-up): a retired model stays LISTED
    // (the admin sees it) but is never a candidate — the same shape a keyless
    // built-in has (builtInCard), so turn-plan / model-pick / call-in all
    // filter it out.
    servable: m.unservable !== true,
    thinkingOff: m.thinking === 'off',
  };
}

/**
 * Every chat-capable model this instance can run, built-ins first (in the
 * run path's own order), then enabled registry models by endpoint label.
 * Never throws: a registry read failure returns the built-ins alone.
 */
export async function listChatModelCatalog(): Promise<ModelCard[]> {
  const { BUILT_IN_CODING_MODEL_IDS, resolveProvider, registryContextChars } = await import('../coding/coding-model');
  const cards: ModelCard[] = BUILT_IN_CODING_MODEL_IDS.map((id) => builtInCard(id, resolveProvider(id)));
  try {
    const { listEndpoints, isChatCapableEntry } = await import('./model-endpoints.service');
    // The EFFECTIVE auto-pick policy decides `autoEligible` on every registry card — 'open_only' unless the env opt-in
    // AUTO_PICK_FRONTIER_ENABLED=1 (owner 2026-10-06 late); a policy read failure serves 'open_only' (never throws).
    const { autoPickPolicy } = await import('../platform/roster-policy');
    const policy = await autoPickPolicy().catch(() => DEFAULT_AUTO_PICK_POLICY);
    for (const ep of await listEndpoints()) {
      if (!ep.enabled) continue;
      for (const m of ep.models ?? []) if (isChatCapableEntry(m)) cards.push(registryCard(ep, m, registryContextChars, { autoPickPolicy: policy }));
    }
  } catch { /* registry unavailable — the built-ins alone */ }
  return cards;
}

/** Index a catalog by spec (pure). */
export function catalogBySpec(cards: readonly ModelCard[]): Map<string, ModelCard> {
  return new Map(cards.map((c) => [c.spec, c]));
}

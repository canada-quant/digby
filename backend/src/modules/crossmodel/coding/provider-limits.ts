/**
 * Per-provider TOOL LIMITS + provider class for custom-endpoint models
 * (2026-09-27, owner incident: the Fleet Supervisor seated on
 * `cql-litellm:api-openai-gpt-6-astra` 400'd EVERY turn for 6 h — 48
 * provider_rejected rows — with "Invalid 'tools': array too long. Expected an
 * array with maximum length 128, but got an array with length 195". OpenAI's
 * chat-completions contract caps `tools` at 128; the supervisor sends ~195.
 * Nothing in the harness knew the cap, so the same request was retried on the
 * same model through the backoff + shrink lanes instead of being trimmed or
 * re-seated.)
 *
 * This leaf answers three questions, all PURE and deterministic:
 *   1. What PROVIDER CLASS is a custom-endpoint model? (`providerClassForModelId`
 *      — from the model id: gpt-*, o[1-9], openai → 'openai', claude/anthropic →
 *      'anthropic', gemini/google → 'google', else 'other'.) An admin override
 *      on the registry entry wins over the heuristic.
 *   2. What is its TOOL LIMIT? (`resolveMaxTools` — the model entry's
 *      `maxTools`, else the endpoint's `settings.maxTools`, else the class
 *      default: 128 for OpenAI-like ids (their documented cap); Anthropic
 *      documents no hard tool-count cap and Google's is far above our tool
 *      count, so both stay unlimited; 'other' unlimited.) A cap LEARNED from a
 *      live 400 ("maximum length N") is honoured process-locally on top
 *      (`learnToolLimit` / `effectiveToolLimit`).
 *   3. Which tools go when the list is over the limit? (`trimToolsToLimit` —
 *      a STABLE priority: pinned core / doctrine-mandated tools first, then
 *      platform reads, then platform mutations, then connector reads, then
 *      connector writes; within a tier the input order is kept; the long tail
 *      is dropped from the lowest tier up. Same input ⇒ same output, pinned
 *      by provider-limits.test.ts.)
 *
 * Ordering: the priority order is unconditional (TOOL_LIMIT_TRIM_DISABLED was
 * deleted 2026-11-02 — its first-N default had baked out; `opts.plain` still
 * asks for first-N explicitly). Pure leaf — imports
 * only the tool-name leaves (no config/env, no prisma).
 *
 * 2026-09-27 (late) — "who said 128 is the limit??": the interim fix b085607e
 * had applied a BLANKET 128 cap to EVERY custom endpoint, so a Kimi K3 behind
 * the owner's LiteLLM proxy (`api-optimize-moonshot-kimi-k3`, 0 tools-too-long
 * 400s ever) was trimmed 196 → 128 and the row said the cap was "learned".
 * Now: NO blanket default — with no registry / endpoint / verified-class cap
 * and no cap learned from a live 400, a custom endpoint is UNLIMITED;
 * `CUSTOM_ENDPOINT_TOOLS_MAX` is an OPT-IN blanket (unset = none); the
 * provider-class table below carries only DOCUMENTED caps (OpenAI 128, Gemini
 * 512) with the source cited; Moonshot / DeepSeek / Z.AI / DashScope /
 * Anthropic document none and stay unlimited until a 400 teaches one; and the
 * telemetry `source` is honest ('learned' only when a 400 body named it —
 * `providerToolLimitDetail`). When a real cap binds, the agent loop no longer
 * trims: it offers a small core + tool GROUPS on demand (coding/tool-groups.ts).
 */

import { PLATFORM_READ_TOOLS, PLATFORM_MUTATING_TOOLS } from '../platform/platform-tool-names';

export type ProviderClass = 'openai' | 'anthropic' | 'google' | 'moonshot' | 'deepseek' | 'zai' | 'dashscope' | 'other';
export const PROVIDER_CLASSES: readonly ProviderClass[] = ['openai', 'anthropic', 'google', 'moonshot', 'deepseek', 'zai', 'dashscope', 'other'];

/** OpenAI's documented chat-completions cap on the `tools` array. */
export const OPENAI_MAX_TOOLS = 128;
/** Gemini's cap on function declarations per request — the API's own 400:
 *  "At most 512 function declarations can be specified." */
export const GOOGLE_MAX_TOOLS = 512;

/**
 * Per-provider-class tool caps — DOCUMENTED ones only (verified 2026-09-27).
 * `undefined` = the vendor documents no cap: unlimited until a live 400 body
 * names one (learnToolLimit). Never guess a number here — the b085607e blanket
 * 128 is exactly the mistake this table replaces.
 *   openai    128  — OpenAI Chat Completions `tools`: "array too long. Expected an
 *                    array with maximum length 128" (the gpt-6-astra incident
 *                    body; https://platform.openai.com/docs/guides/function-calling).
 *   google    512  — Gemini API 400 INVALID_ARGUMENT "At most 512 function
 *                    declarations can be specified."
 *                    (https://github.com/google-gemini/gemini-cli/issues/19083 quotes
 *                    the live error; the guide https://ai.google.dev/gemini-api/docs/function-calling
 *                    states no number).
 *   moonshot  none — the Kimi tool-calling guide states NO count limit and
 *                    recommends "Dynamically Loaded Tools" for dozens/hundreds of
 *                    tools (https://platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls).
 *   deepseek  none — https://api-docs.deepseek.com/guides/function_calling states no
 *                    count limit (the "128" in third-party write-ups is parallel tool
 *                    CALLS per turn, not definitions).
 *   zai       none — no documented cap (Z.AI function-calling guide).
 *   dashscope none — https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling
 *                    states no count limit.
 *   anthropic none — Anthropic documents no hard tool-count cap (the tool-search
 *                    tool takes up to 10,000 deferred tools).
 *   other     none
 */
export const PROVIDER_CLASS_TOOL_LIMITS: Readonly<Record<ProviderClass, number | undefined>> = Object.freeze({
  openai: OPENAI_MAX_TOOLS,
  google: GOOGLE_MAX_TOOLS,
  anthropic: undefined,
  moonshot: undefined,
  deepseek: undefined,
  zai: undefined,
  dashscope: undefined,
  other: undefined,
});

/* TOOL_LIMIT_TRIM_DISABLED was DELETED 2026-11-02 (RSW-1 delete-with-ledger,
 * goal 393f731e): its default was the LIVE behaviour — the priority ORDER was
 * already on, and the switch only restored the interim first-N (b085607e) shape
 * for a readout that has since baked out. `trimToolsToLimit` keeps its explicit
 * `opts.plain` parameter (the capability is the option, not an env flag), so a
 * caller can still ask for first-N; nothing sets that from the environment. */

/** Provider class from a model id (a custom endpoint carries no provider of its
 *  own — a LiteLLM proxy fronts many). A proxy id names the vendor somewhere in
 *  the slug (`api-optimize-moonshot-kimi-k3` → moonshot, `api-openai-gpt-6-astra`
 *  → openai); the vendor tokens are checked BEFORE the generic OpenAI ones so a
 *  "kimi" / "deepseek" / "qwen" id never reads as OpenAI-like. Pure. */
export function providerClassForModelId(id: string | undefined | null): ProviderClass {
  const s = String(id ?? '').toLowerCase();
  if (!s) return 'other';
  if (/kimi|moonshot/.test(s)) return 'moonshot';
  if (/deepseek/.test(s)) return 'deepseek';
  if (/(^|[\/:_.-])(glm|zai|z\.ai|zhipu|cogview|chatglm)/.test(s)) return 'zai';
  // DashScope-BRANDED ids only (the commercial qwen-plus/max/turbo/flash tiers,
  // the dashscope/tongyi hosts) — an open-weight Qwen on Ollama / Nebius / vLLM
  // is 'other' (model-endpoints.service.test.ts pins qwen3:32b → other).
  if (/dashscope|tongyi|(^|[\/:_.-])qwen-(plus|max|turbo|flash|long)|qwen3?-(asr|tts|vl|omni)|text-embedding-v\d|qwen3-rerank/.test(s)) return 'dashscope';
  if (/claude|anthropic/.test(s)) return 'anthropic';
  if (/gemini|gemma|google|palm|imagen|veo/.test(s)) return 'google';
  if (/(^|[\/:_.-])(gpt|chatgpt|openai|o[1-9](?:[-_.]|$)|davinci|text-embedding-(3|ada)|omni|whisper|tts-1|dall-e)/.test(s)) return 'openai';
  return 'other';
}

/** The class default tool cap — the DOCUMENTED table only (openai 128, google 512); everyone else unlimited. */
export function defaultMaxToolsForClass(cls: ProviderClass): number | undefined {
  return PROVIDER_CLASS_TOOL_LIMITS[cls];
}

export interface ToolLimitInput {
  modelId: string;
  /** The registry entry's explicit cap (admin-set or detected). */
  maxTools?: number | null;
  /** The registry entry's explicit provider class (admin override). */
  providerClass?: ProviderClass | string | null;
  /** The endpoint-level cap (endpoint settings.maxTools). */
  endpointMaxTools?: number | null;
}

export interface ToolLimitResolution {
  limit?: number;
  source: 'model' | 'endpoint' | 'class' | 'none';
  providerClass: ProviderClass;
}

function positiveInt(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function isProviderClass(x: unknown): x is ProviderClass {
  return typeof x === 'string' && (PROVIDER_CLASSES as readonly string[]).includes(x);
}

/** model.maxTools > endpoint.settings.maxTools > class default > none. Pure. */
export function resolveMaxTools(input: ToolLimitInput): ToolLimitResolution {
  const providerClass: ProviderClass = isProviderClass(input.providerClass) ? input.providerClass : providerClassForModelId(input.modelId);
  const model = positiveInt(input.maxTools);
  if (model !== undefined) return { limit: model, source: 'model', providerClass };
  const endpoint = positiveInt(input.endpointMaxTools);
  if (endpoint !== undefined) return { limit: endpoint, source: 'endpoint', providerClass };
  const cls = defaultMaxToolsForClass(providerClass);
  if (cls !== undefined) return { limit: cls, source: 'class', providerClass };
  return { source: 'none', providerClass };
}

// ── Learned caps (process-local; the live 400 names the real number) ─────────

const learned = new Map<string, number>();

export function toolLimitKey(url: string | undefined | null, model: string | undefined | null): string {
  return `${String(url ?? '').trim().toLowerCase()}::${String(model ?? '').trim()}`;
}

/** Remember a cap a provider stated in a 400 body. Smaller caps win. */
export function learnToolLimit(key: string, cap: number): number {
  const c = positiveInt(cap);
  if (c === undefined) return learned.get(key) ?? NaN;
  const prev = learned.get(key);
  const next = prev === undefined ? c : Math.min(prev, c);
  learned.set(key, next);
  return next;
}

export function learnedToolLimit(key: string): number | undefined {
  return learned.get(key);
}

export function __resetLearnedToolLimitsForTests(): void {
  learned.clear();
}

/** The cap the loop must honour for a provider right now: min(configured, learned). */
export function effectiveToolLimit(provider: { url?: string; model?: string; maxTools?: number | null }): number | undefined {
  const configured = positiveInt(provider.maxTools);
  const learnedCap = learned.get(toolLimitKey(provider.url, provider.model));
  if (configured === undefined) return learnedCap;
  if (learnedCap === undefined) return configured;
  return Math.min(configured, learnedCap);
}

/**
 * The OPT-IN blanket cap for custom endpoints that carry no specific cap —
 * `CUSTOM_ENDPOINT_TOOLS_MAX`. UNSET (the default since 2026-09-27 late) means
 * NO blanket: the b085607e interim fix's default of 128 is GONE ("who said 128
 * is the limit??" — it trimmed a Kimi K3 behind a proxy that never rejected a
 * tool list). An invalid / non-positive value is ignored (no cap). A specific
 * cap (registry / endpoint / documented class / learned) always wins over it.
 */
export function customEndpointToolsMax(): number | undefined {
  const raw = String(process.env.CUSTOM_ENDPOINT_TOOLS_MAX ?? '').trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Where a binding tool cap came from — the ONLY values telemetry may print.
 *  'learned' is reserved for a cap a live 400 body named (learnToolLimit). */
export type ToolLimitSource = 'model' | 'endpoint' | 'class' | 'learned' | 'blanket' | 'none';

export interface ProviderToolLimitInput {
  url?: string;
  model?: string;
  label?: string;
  maxTools?: number | null;
  /** How the registry resolved `maxTools` (model-endpoints.service: model > endpoint > class). */
  maxToolsSource?: 'model' | 'endpoint' | 'class' | 'none' | string | null;
}

/**
 * THE tool limit a provider gets, WITH its honest source:
 *   built-in providers → none (their gateways take the full array);
 *   custom endpoints → the SPECIFIC cap when one is known — the registry's
 *   (model > endpoint > documented provider class) min'd with a cap LEARNED
 *   from a live 400 (the smaller wins; 'learned' only when the learned one is
 *   the binding one) — else the OPT-IN blanket env ('blanket'), else NONE
 *   (unlimited: no trim, no note, no row).
 */
export function providerToolLimitDetail(provider: ProviderToolLimitInput): { limit?: number; source: ToolLimitSource } {
  if (!String(provider.label ?? '').endsWith('(custom endpoint)')) return { source: 'none' };
  const configured = positiveInt(provider.maxTools);
  const configuredSource: ToolLimitSource = configured === undefined
    ? 'none'
    : (provider.maxToolsSource === 'endpoint' || provider.maxToolsSource === 'class' ? provider.maxToolsSource : 'model');
  const learnedCap = learned.get(toolLimitKey(provider.url, provider.model));
  if (configured !== undefined && learnedCap !== undefined) {
    return learnedCap < configured ? { limit: learnedCap, source: 'learned' } : { limit: configured, source: configuredSource };
  }
  if (learnedCap !== undefined) return { limit: learnedCap, source: 'learned' };
  if (configured !== undefined) return { limit: configured, source: configuredSource };
  const blanket = customEndpointToolsMax();
  if (blanket !== undefined) return { limit: blanket, source: 'blanket' };
  return { source: 'none' };
}

/** The number alone (callers that only cap). */
export function providerToolLimit(provider: ProviderToolLimitInput): number | undefined {
  return providerToolLimitDetail(provider).limit;
}

/**
 * The cap a provider's rejection body names, when it does:
 *   "Expected an array with maximum length 128, but got an array with length 195"
 *   "tools: at most 64 tools are supported" / "max 100 tools" / "maximum of 128 functions"
 * Returns null when no number is stated (the caller must not guess).
 */
export function parseToolCapFromError(message: string | undefined | null): number | null {
  const s = String(message ?? '');
  if (!s) return null;
  const patterns = [
    /maximum length (\d{1,5})/i,
    /at most (\d{1,5}) (?:tools?|functions?)/i,
    /max(?:imum)?(?: of)? (\d{1,5}) (?:tools?|functions?)/i,
    /(?:tools?|functions?)[^0-9]{0,40}?(?:limit|cap|maximum)[^0-9]{0,20}(\d{1,5})/i,
    /(\d{1,5}) (?:tools?|functions?) (?:max(?:imum)?|limit|allowed)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

// ── Trim priority ────────────────────────────────────────────────────────────

/** Tier 0: never trimmed while any lower tier remains — the loop's core
 *  workspace/web/memory tools, delegation, and the doctrine-mandated
 *  coordination + account tools every playbook row names. Order matters
 *  only relative to other tiers (the list is a set). */
export const TOOL_TRIM_PINNED: readonly string[] = [
  // workspace core
  'read_file', 'view_image', 'list_dir', 'glob', 'grep', 'write_file', 'edit_file', 'run_command', 'ast_search', 'ast_rewrite', 'rewind_to_step',
  'git_status', 'git_diff', 'git_log', 'git_show', 'git_commit', 'git_push', 'open_pull_request', 'check_ci', 'merge_pull_request', 'await_condition',
  'update_plan', 'verify', 'start_background_process', 'read_process_output', 'wait_for_process_output', 'list_processes', 'stop_process', 'schedule_self',
  // web + memory + user
  'search_engine', 'scrape_as_markdown', 'browser_task', 'computer_task', 'web_pipe', 'youtube_pipe', 'search_memory', 'search_code_semantic', 'ask_user',
  'create_document', 'read_document', 'update_document', 'list_files', 'fill_pdf_form',
  // delegation / progressive disclosure (tool-groups.ts gateway tools)
  'delegate', 'delegate_parallel', 'delegate_status', 'load_tool_group', 'list_tool_groups', 'load_tools',
  // fleet coordination (supervisor doctrine)
  'list_chats', 'get_chat_status', 'get_chat_messages', 'send_chat_message', 'wait_for_chat', 'create_chat', 'start_coding_session', 'search_chats', 'resolve_id',
  'list_schedules', 'schedule_get', 'schedule_message', 'update_schedule', 'cancel_schedule', 'pause_schedule', 'resume_schedule',
  'get_supervisor_state', 'update_supervisor_state', 'get_fleet_telemetry', 'get_run_receipts', 'get_spend',
  'list_infra_blockers', 'register_infra_blocker', 'clear_infra_blocker',
  'file_feedback', 'list_feedback', 'get_feedback', 'update_feedback', 'resolve_feedback',
  'goal_list', 'goal_get', 'goal_create', 'goal_update', 'goal_premise_set', 'todo_list', 'todo_get', 'todo_create', 'todo_update',
  'hook_list', 'hook_subscribe', 'hook_update', 'hook_unsubscribe',
  'subscribe_drive_watch', 'unsubscribe_drive_watch',
  'list_owner_questions', 'flag_owner_question', 'answer_owner_question', 'dismiss_owner_question',
  'stop_run', 'answer_chat_question', 'approve_request', 'list_pending_confirmations', 'cancel_confirmation',
  'get_chat_autonomy', 'set_chat_autonomy', 'get_project', 'list_projects', 'dispatch_platform_task',
  'get_model_roles', 'test_model_role',
  // account tools (the "Doing things for the user" doctrine)
  'get_account_overview', 'list_memory', 'remember_fact', 'forget_fact', 'list_canvases', 'get_canvas', 'list_knowledge_documents',
  'telegram_connect_link', 'get_chat_instructions', 'set_chat_instructions', 'add_knowledge_url', 'add_knowledge_note', 'update_canvas',
  'notify_user', 'create_share_link', 'revoke_share_link', 'generate_image',
];

const PINNED = new Set(TOOL_TRIM_PINNED);
const PLATFORM_READ = new Set<string>(PLATFORM_READ_TOOLS as readonly string[]);
const PLATFORM_MUTATING = new Set<string>(PLATFORM_MUTATING_TOOLS as readonly string[]);
/** Connector (integration) tool prefixes — the long tail on every chat seat. */
// mcp_ = user-added MCP servers (ticket e294f9a4): connector tier, so a cap drops them before core / platform tools.
const CONNECTOR_PREFIX = /^(gmail|drive|calendar|docs|sheets|slides|github|slack|discord|asana|x|xero|plaid|imessage|mcp)_/;
const CONNECTOR_WRITE = /_(send|create|update|post|write|append|upload|delete|remove)(_|$)/;

export type ToolTrimTier = 0 | 1 | 2 | 3 | 4;
export const TOOL_TRIM_TIER_LABELS: Record<ToolTrimTier, string> = {
  0: 'core',
  1: 'platform reads',
  2: 'platform actions',
  3: 'connector reads',
  4: 'connector writes',
};

/** 0 pinned · 1 platform read · 2 platform action / unknown · 3 connector read · 4 connector write. Pure. */
export function toolTrimTier(name: string | undefined | null): ToolTrimTier {
  const n = String(name ?? '');
  if (!n) return 2;
  if (PINNED.has(n)) return 0;
  if (CONNECTOR_PREFIX.test(n)) return CONNECTOR_WRITE.test(n) ? 4 : 3;
  if (PLATFORM_READ.has(n)) return 1;
  if (PLATFORM_MUTATING.has(n)) return 2;
  return 2;
}

export interface ToolTrimResult<T> {
  tools: T[];
  from: number;
  to: number;
  dropped: string[];
  /** Human labels of the tiers that lost at least one tool, highest tier first. */
  droppedGroups: string[];
}

function toolName(t: any): string {
  return String(t?.function?.name ?? t?.name ?? '');
}

/**
 * Keep at most `limit` tools by tier (0 first), input order within a tier.
 * Returns the input untouched (same reference) when it already fits or the
 * limit is not a positive number. Pure; never mutates the input.
 * The priority ORDER is the only default now: `opts.plain` still asks for the
 * FIRST N in input order (the interim fix's shape, b085607e), but it is an
 * explicit opt-in — it never switches the cap off, and nothing sets it from the
 * environment since TOOL_LIMIT_TRIM_DISABLED was deleted 2026-11-02.
 */
export function trimToolsToLimit<T>(tools: readonly T[], limit: number | undefined | null, opts?: { plain?: boolean }): ToolTrimResult<T> {
  const lim = positiveInt(limit);
  if (lim === undefined || tools.length <= lim) {
    return { tools: tools as T[], from: tools.length, to: tools.length, dropped: [], droppedGroups: [] };
  }
  const plain = opts?.plain ?? false;
  if (plain) {
    const kept = tools.slice(0, lim) as T[];
    const drop = tools.slice(lim);
    const tiers = new Set<ToolTrimTier>(drop.map((t) => toolTrimTier(toolName(t))));
    return {
      tools: kept, from: tools.length, to: kept.length,
      dropped: drop.map(toolName),
      droppedGroups: ([4, 3, 2, 1, 0] as ToolTrimTier[]).filter((t) => tiers.has(t)).map((t) => TOOL_TRIM_TIER_LABELS[t]),
    };
  }
  const indexed = tools.map((t, i) => ({ t, i, tier: toolTrimTier(toolName(t)) }));
  indexed.sort((a, b) => (a.tier - b.tier) || (a.i - b.i));
  const keep = indexed.slice(0, lim);
  const drop = indexed.slice(lim);
  // Re-emit the kept tools in their ORIGINAL order — the model sees the same
  // relative layout it would have without a cap, minus the tail.
  keep.sort((a, b) => a.i - b.i);
  const droppedTiers = new Set<ToolTrimTier>(drop.map((d) => d.tier));
  const droppedGroups = ([4, 3, 2, 1, 0] as ToolTrimTier[]).filter((t) => droppedTiers.has(t)).map((t) => TOOL_TRIM_TIER_LABELS[t]);
  return {
    tools: keep.map((k) => k.t),
    from: tools.length,
    to: keep.length,
    dropped: drop.sort((a, b) => a.i - b.i).map((d) => toolName(d.t)),
    droppedGroups,
  };
}

/** The one-line system note the model reads on a trimmed turn. Pure. */
export function toolTrimSystemNote(r: { from: number; to: number; droppedGroups: string[] }, limit: number, model: string): string {
  const groups = r.droppedGroups.length ? r.droppedGroups.join(', ') : 'long tail';
  return `[HARNESS NOTE — TOOL LIMIT: ${model} accepts at most ${limit} tools per request, so ${r.from - r.to} of the ${r.from} tools are unavailable THIS turn (dropped groups: ${groups}). Work with the tools listed; do not narrate calls to tools you cannot see.]`;
}

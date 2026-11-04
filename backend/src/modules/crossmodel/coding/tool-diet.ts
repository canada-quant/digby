/**
 * TOOL DIET (build 2026-10-08 A2; docs audit 2026-10-08 architecture.md item A, reframed).
 *
 * The "57k-token guest prompt" was ~85 % TOOL SCHEMAS: every chat run — a guest's
 * included — was sent the whole chat roster (208 tools ≈ 49k o200k tokens), while
 * guests called a platform tool in 1 of 59 turns (7 days to 10-08) and signed-in
 * human turns used one in 19 %. Two levers live here; the third (shorter
 * descriptions) is a text change guarded by coding/tool-description-budget.test.ts.
 *
 *   A2-1  GUEST SUBSET — an anonymous chat run (session id `anon-…`) is offered only
 *         web + documents + image + delegation (GUEST_TOOL_NAMES, 16 tools). Every
 *         platform / account / connector tool refuses a guest anyway, and the guest
 *         doctrine already says "you have NO account tools". A by-name call to a
 *         removed tool is refused by the existing tool_preflight seam (tool_not_offered).
 *         A pure removal — acts directly. Kill switch GUEST_TOOL_SUBSET_DISABLED=1.
 *
 *   A2-2  PROGRESSIVE DISCLOSURE ON HUMAN CHAT TURNS — the tool-groups machinery
 *         (coding/tool-groups.ts: an always-on core + groups the turn text obviously
 *         needs + list_tool_groups / load_tools + by-name AUTO-LOAD) had run 0 times
 *         in prod since it shipped (0 tool_groups rows since 10-01). WHY: agent.ts
 *         turns it on only when a provider tool cap binds or TOOL_GROUPS_ALWAYS=1 —
 *         built-in seats never carry a cap, the gateway Kimi / GLM ids have no
 *         documented class cap (the blanket 128 is opt-in since 09-27, and
 *         CUSTOM_ENDPOINT_TOOLS_MAX is not forwarded by compose either), and
 *         TOOL_GROUPS_ALWAYS was never forwarded by docker-compose.app.yml, so it could
 *         not be set in prod at all. This module turns it on BY PROFILE (a top-level,
 *         signed-in, human-typed plain-chat turn — never a supervisor, a machine wake,
 *         a worker or a coding lane), add-only within the run (no cap ⇒ ToolGroupSession
 *         never evicts; the tools array changes at most once per load).
 *         Rollout (architecture.md A1 step 2): the mode lives in ONE context-store row
 *         ['instance','tool-diet'] / 'config' { chatToolGroups: 'off'|'shadow'|'act',
 *         canaryUserIds?: string[] } (scripts/framework-audit/set-tool-diet.js; 30 s
 *         cache; a read failure = the defaults, so nothing widens on an error):
 *           shadow (default) — only the CANARY acts (absent list ⇒ the owner);
 *                              everyone else records what the core view WOULD have
 *                              missed (`wouldMiss`) on the full-list turn;
 *           act              — every eligible human chat turn acts;
 *           off              — nobody acts; the would-miss row is still recorded.
 *         Kill switch CHAT_TOOL_GROUPS_DISABLED=1 = today's behaviour byte-for-byte
 *         (no store read, no row); the global TOOL_GROUPS_DISABLED=1 stops it too.
 *
 * TELEMETRY: loop_metrics `tool_diet` — ONE row per guest chat run and per eligible
 * human chat run: { segment: guest|human_chat, mode, acted, canary, fullTools,
 * fullChars, offeredTools, offeredChars, called[], wouldMiss[], autoLoads, loads,
 * loadedGroups } (+ the A2b lane fields — see the A2b section at the bottom). The
 * shadow bar (architecture.md): ≤ 3 % of human turns with a non-empty wouldMiss
 * before the canary widens.
 *
 *   A2b   LANE-AWARE STARTING SETS (build 2026-10-08 A2b) — the turn plan's lane
 *         (quick / standard / checked / research) + needs_live_web pick the starting
 *         view; see the section at the bottom.
 *
 * Pure except for the lazy context-store read (no prisma import at module load).
 */

import { ToolGroupSession, initialToolGroups, groupForTool, hintGroupsForText, TOOL_GROUP_META_TOOLS, type ToolGroupId } from './tool-groups';

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** The loop_metrics kind (one row per guest / eligible human chat run). */
export const TOOL_DIET_METRIC = 'tool_diet';

// ── A2-1 the guest subset ────────────────────────────────────────────────────

/**
 * What an anonymous chat run is offered (architecture.md A1 step 1: web, documents,
 * image, delegation — the report's 15 + delegate_status, which the background
 * delegate schema names). The document / image / browser tools answer a guest with
 * their own sign-in line — that refusal IS the sign-up nudge the guest doctrine asks
 * for. Harness-owned extras (council tools, call_in) ride input.extraTools and are
 * appended after this filter.
 */
export const GUEST_TOOL_NAMES: ReadonlySet<string> = new Set([
  // web
  'search_engine', 'scrape_as_markdown', 'fetch_image', 'web_pipe', 'youtube_pipe', 'browser_task',
  // session memory (delegated workers offload their findings there)
  'search_memory',
  // documents + image
  'create_document', 'read_document', 'update_document', 'list_files', 'fill_pdf_form', 'generate_image',
  // delegation
  'delegate', 'delegate_parallel', 'delegate_status',
]);

export function guestToolSubsetDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.GUEST_TOOL_SUBSET_DISABLED);
}

/** An anonymous chat session id (chat-agent.service runSessionId). */
export function isGuestSession(sessionId: string | undefined | null): boolean {
  return String(sessionId ?? '').startsWith('anon-');
}

/** The guest subset of a tool list (input order kept). Pure. */
export function guestToolSubset<T extends { function?: { name?: string } }>(tools: readonly T[]): T[] {
  return tools.filter((t) => GUEST_TOOL_NAMES.has(String(t?.function?.name ?? '')));
}

// ── A2-2 progressive disclosure on human chat turns ──────────────────────────

export type ChatToolGroupsMode = 'off' | 'shadow' | 'act';

/** The owner — the default canary ("a new act path starts on the owner canary"). */
export const TOOL_DIET_CANARY_DEFAULT_USER_IDS: readonly string[] = Object.freeze(['83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4']);

export function chatToolGroupsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.CHAT_TOOL_GROUPS_DISABLED);
}

export interface ToolDietConfig {
  chatToolGroups: ChatToolGroupsMode;
  canaryUserIds: string[];
  /** true when the row carries no canaryUserIds (the owner default applies). */
  canaryDefault: boolean;
  /** build 2026-10-08 A2b: the lane-aware starting sets — same off / shadow / act semantics and canary as
   *  chatToolGroups (absent ⇒ shadow); a lane set acts only where chatToolGroups already acts. */
  laneToolSets: ChatToolGroupsMode;
  /** build 2026-10-08 A2b: needs_live_web below this ⇒ a quick / standard turn holds the web tools back (0 = never). */
  laneWebDropBelow: number;
}

const isMode = (m: unknown): m is ChatToolGroupsMode => m === 'off' || m === 'act' || m === 'shadow';

/** The store row → the config (pure; absent / malformed fields take the defaults). */
export function toolDietConfigFrom(row: unknown): ToolDietConfig {
  const r = row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : {};
  const m = r.chatToolGroups;
  const listed = Array.isArray(r.canaryUserIds);
  const ids = listed
    ? (r.canaryUserIds as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())
    : [...TOOL_DIET_CANARY_DEFAULT_USER_IDS];
  const below = r.laneWebDropBelow;
  return {
    chatToolGroups: isMode(m) ? m : 'shadow',
    canaryUserIds: [...new Set(ids)],
    canaryDefault: !listed,
    laneToolSets: isMode(r.laneToolSets) ? r.laneToolSets : 'shadow',
    laneWebDropBelow: typeof below === 'number' && Number.isFinite(below) && below >= 0 && below <= 1 ? below : LANE_WEB_DROP_BELOW_DEFAULT,
  };
}

export const TOOL_DIET_CONFIG_NS = ['instance', 'tool-diet'];
export const TOOL_DIET_CONFIG_KEY = 'config';
const CONFIG_TTL_MS = 30_000;
let configCache: { cfg: ToolDietConfig; expiresAt: number } | null = null;
export function __resetToolDietConfigForTests(): void { configCache = null; }

/** The live config (30 s cache; a read failure = the defaults: shadow + the owner canary). */
export async function toolDietConfig(): Promise<ToolDietConfig> {
  if (configCache && configCache.expiresAt > Date.now()) return configCache.cfg;
  let cfg: ToolDietConfig;
  try {
    const { storeGet } = await import('../memory/context-store');
    cfg = toolDietConfigFrom(await storeGet<Record<string, unknown>>(TOOL_DIET_CONFIG_NS, TOOL_DIET_CONFIG_KEY));
  } catch {
    cfg = toolDietConfigFrom(null);
  }
  configCache = { cfg, expiresAt: Date.now() + CONFIG_TTL_MS };
  return cfg;
}

/**
 * Is this run a HUMAN plain-chat turn the diet may act on? Top-level (no worker
 * role), a chat-kind profile without the supervisor tools, a signed-in session
 * (guests get the subset instead), not machine-triggered. Pure.
 */
export function isHumanPlainChatRun(r: {
  role?: unknown; profileKind: string; supervisorTools?: boolean; sessionId: string; machineTriggered?: boolean; userId?: string | null;
}): boolean {
  return !r.role && r.profileKind !== 'coding' && !r.supervisorTools && !isGuestSession(r.sessionId)
    && r.machineTriggered !== true && !!r.userId;
}

export interface ChatToolGroupsDecision {
  mode: ChatToolGroupsMode;
  /** Progressive disclosure runs for this turn. */
  acts: boolean;
  /** The sender is on the canary list. */
  canary: boolean;
}

/** Mode + canary → does this sender act? Pure. */
export function decideChatToolGroups(cfg: ToolDietConfig, userId: string | null | undefined): ChatToolGroupsDecision {
  const canary = !!userId && cfg.canaryUserIds.includes(userId);
  const acts = cfg.chatToolGroups === 'act' || (cfg.chatToolGroups === 'shadow' && canary);
  return { mode: cfg.chatToolGroups, acts, canary };
}

/**
 * The NON-core tools signed-in human plain-chat turns call most, preloaded one
 * by one (no whole group) so the core-first view misses them less — read from
 * prod loop_metrics chat_platform_usage, 2026-09-24 → 10-08 (1,177 human turns,
 * non-supervisor, non-guest; account tools are preloaded as a group anyway):
 * topology_check 18, create_canvas 10, get_chat_autonomy 5, read_session_file 5,
 * list_session_files 4, configure_workspace 4, pause_schedule 4 (+ its pair
 * resume_schedule), list_github_repos 3, list_pending_confirmations 3.
 */
export const CHAT_PRELOAD_TOOLS: readonly string[] = [
  'topology_check', 'create_canvas', 'get_chat_autonomy', 'read_session_file', 'list_session_files',
  'configure_workspace', 'pause_schedule', 'resume_schedule', 'list_github_repos', 'list_pending_confirmations',
];

/**
 * The tool names a progressive-disclosure turn would START with: the core +
 * the groups the turn text obviously needs + the chat lane's habitual account
 * group (+ triage when the prompt works the feedback queue, + the user's MCP
 * group when the text names one of their servers) + CHAT_PRELOAD_TOOLS + the
 * gateway pair. The same preload agent.ts runs when groups act — used here to
 * compute the shadow would-miss. Pure.
 */
export function chatToolGroupsInitialView(names: readonly string[], opts: { text: string; triage: boolean; extraGroups?: readonly ToolGroupId[] }): Set<string> {
  const session = new ToolGroupSession(names);
  for (const g of initialToolGroups({ text: opts.text, knownTools: names, chatLane: true, triage: opts.triage, supervisor: false })) session.load(g);
  for (const g of opts.extraGroups ?? []) session.load(g);
  session.loadTools(CHAT_PRELOAD_TOOLS);
  const view = new Set<string>(names.filter((n) => session.isVisible(n)));
  for (const n of TOOL_GROUP_META_TOOLS) view.add(n);
  return view;
}

/**
 * The run's own prompt material the group preload reads (agent.ts — the same
 * text whether groups act or the shadow view is computed): the USER turns of
 * history + the message + the scheduler notice. Pure.
 */
export function toolGroupsPromptText(input: {
  history?: ReadonlyArray<{ role?: string; content?: unknown }>; userMessage?: string; schedulerNotice?: string;
}): string {
  return [
    ...(input.history ?? []).filter((h) => h?.role === 'user').map((h) => (typeof h.content === 'string' ? h.content : Array.isArray(h.content) ? h.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n') : '')),
    input.userMessage || '', input.schedulerNotice || '',
  ].join('\n');
}

/** The distinct tool names a run CALLED (from its transcript parts), in first-call order. Pure. */
export function calledToolNames(parts: ReadonlyArray<unknown> | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of parts ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as { type?: unknown; name?: unknown };
    if (p.type !== 'tool_call' || typeof p.name !== 'string' || !p.name) continue;
    if (!out.includes(p.name)) out.push(p.name);
  }
  return out;
}

/**
 * Tools the run called that were in its FULL list but outside the initial
 * progressive view — what a core-first turn would have had to auto-load (or,
 * for a model that only calls what it sees, would have missed). Meta tools and
 * harness extras (grouped 'core') never count. Pure.
 */
export function wouldMissTools(called: readonly string[], fullNames: ReadonlySet<string>, initialView: ReadonlySet<string>): string[] {
  return called.filter((n) => fullNames.has(n) && !initialView.has(n) && groupForTool(n) !== 'core');
}

/** Serialized size of a tool list — the schema bytes a turn sends (a token proxy: o200k ≈ chars / 4.4). */
export function schemaChars(tools: ReadonlyArray<unknown>): number {
  try { return JSON.stringify(tools).length; } catch { return 0; }
}

// ── A2b lane-aware starting sets from the turn plan ──────────────────────────
//
// build 2026-10-08 A2b — owner 2026-10-08: "is this properly configured with the jev / laya decision model? i thought
// that stopped a lot of unnecessary tools". It was not: the decision gate's turn_plan purpose (platform/turn-plan.ts,
// ACT fleet-wide) classifies EVERY human turn into a lane + traits, yet no tool set depended on it — a Quick turn was
// sent the same ~200 schemas as a research turn (and the retired `tool_intent` purpose never had an act consumer).
// A2b reads the plan the turn ALREADY computed (zero extra decision calls: chat-agent hands the agent a getter over
// it) and picks the STARTING view of A2-2's progressive disclosure:
//
//   quick      QUICK_LANE_TOOL_NAMES (web reads + a minimal read set) + whatever the TEXT names (the hint rules'
//              groups, a verbatim tool name, QUICK_TEXT_CUES) — every other core tool is HELD BACK
//              (ToolGroupSession.deferCore) and no account / platform / connector group starts loaded;
//   standard   A2's view, unchanged (core + account + the measured preload + hinted groups);
//   checked    A2's view + CHECKED_LANE_TOOLS (the user's uploads — what a second opinion is usually checking);
//   research   A2's view + RESEARCH_LANE_TOOLS (uploads + the connector SEARCH reads a broad ask reaches for);
//   web drop   needs_live_web < laneWebDropBelow (default 0.05) on a QUICK / STANDARD turn whose text has no web cue
//              ⇒ the web tools are held back too. Never on checked / research: in the 14-day replay a checked turn
//              with needs_live_web < 0.1 still reached for the web on 10 of 30 turns.
//
// A held-back or unloaded tool is never refused: a by-name call auto-loads it (ToolGroupSession.ensureLoadedFor), and
// list_tool_groups lists the held-back core tools as the group 'core'. Harness extras (council tools, call_in) are
// always in view. Only a CLASSIFIED plan counts (a gate that did not answer ⇒ A2's view, the "standard" behaviour).
//
// Rollout — the A2 store row ['instance','tool-diet'] / 'config' gains `laneToolSets` 'off' | 'shadow' (default) |
// 'act' and `laneWebDropBelow` (scripts/framework-audit/set-tool-diet.js), with A2's canary: a lane set ACTS only
// where A2 already acts (it refines A2's starting view); every other eligible human chat turn records what the lane's
// view would have missed. Kill switch: CHAT_TOOL_GROUPS_DISABLED=1 stops A2 and A2b (no new env var); a lane-only
// rollback is the store row (`laneToolSets: 'off'`).
//
// TELEMETRY — the A2 `tool_diet` human_chat row gains: lane, needsLiveWeb, laneMode, laneActed, laneCanary,
// laneSource ('start' = the plan was in at run start; 'late' = only by run end — shadow only), webDropped,
// laneOfferedTools, laneOfferedChars, laneWouldMiss[] (tools the run called outside the lane's starting view:
// auto-loaded when acting, a would-be miss in shadow). Bar before widening: ≤ 3 % of a lane's turns with a non-empty
// laneWouldMiss (A2's shadow bar), per lane.

export type ToolLane = 'quick' | 'standard' | 'checked' | 'research';
const TOOL_LANES: readonly ToolLane[] = ['quick', 'standard', 'checked', 'research'];

/** What the agent loop needs from the turn plan: the classified lane and the needs_live_web noul. */
export interface ToolLaneHint {
  lane: ToolLane;
  needsLiveWeb: number | null;
}

/**
 * needs_live_web below this ⇒ a quick / standard turn holds the web tools back (store `laneWebDropBelow`). From the
 * 14-day replay (Jev's needs_live_web clusters at ≥ 0.03): below 0.05 holds the web back on 36 % of quick and 40 % of
 * standard turns, and 1.5 % / 0.5 % of those lanes' turns then searched anyway (auto-loaded); below 0.1 it was
 * 59 % / 69 % held back but 2.6 % / 4.1 % searched anyway — over the 3 % bar on standard.
 */
export const LANE_WEB_DROP_BELOW_DEFAULT = 0.05;

/**
 * The turn plan → the hint (pure; structural, so no turn-plan import). Only a CLASSIFIED plan counts — a plan with
 * no answer carries the preset's fallback lane (`cls: null`), which is not a classification.
 */
export function toolLaneHintFromPlan(p: { lane?: unknown; cls?: { needsLiveWeb?: unknown } | null } | null | undefined): ToolLaneHint | null {
  if (!p || !p.cls || typeof p.lane !== 'string' || !(TOOL_LANES as readonly string[]).includes(p.lane)) return null;
  const w = p.cls.needsLiveWeb;
  return { lane: p.lane as ToolLane, needsLiveWeb: typeof w === 'number' && Number.isFinite(w) ? w : null };
}

/** Read the run's hint getter (never throws; a malformed answer = no hint). */
export function readToolLaneHint(get: (() => ToolLaneHint | null | undefined) | undefined): ToolLaneHint | null {
  try {
    const h = get?.();
    return h && (TOOL_LANES as readonly string[]).includes(h.lane) ? { lane: h.lane, needsLiveWeb: typeof h.needsLiveWeb === 'number' && Number.isFinite(h.needsLiveWeb) ? h.needsLiveWeb : null } : null;
  } catch { return null; }
}

/** The web tools a low-needs_live_web quick / standard turn holds back. */
export const WEB_LANE_TOOLS: readonly string[] = ['search_engine', 'scrape_as_markdown', 'web_pipe', 'youtube_pipe', 'fetch_image', 'browser_task'];

/**
 * The Quick lane's starting set: the web reads a lookup answers from, plus a minimal read set — session memory, the
 * user's files and memory, what is set up on the account. Replay (14 d, 195 quick-classified human turns): every tool
 * those turns called is here except browser_task ×2, remember_fact ×1, file_feedback ×1 — each also reachable by a
 * text cue / hint rule below, and by name.
 */
export const QUICK_LANE_TOOL_NAMES: readonly string[] = [
  'search_engine', 'scrape_as_markdown', 'web_pipe', 'youtube_pipe', 'fetch_image',
  'search_memory', 'read_document', 'list_files', 'list_memory', 'get_account_overview',
];

/** Checked lane extras: the user's own uploads (contracts, statements, records — what a second opinion checks). */
export const CHECKED_LANE_TOOLS: readonly string[] = ['list_chat_uploads', 'read_chat_upload'];
/** Research lane extras: the uploads + the connector SEARCH reads a broad ask reaches for (present only when connected). */
export const RESEARCH_LANE_TOOLS: readonly string[] = [...CHECKED_LANE_TOOLS, 'github_search_code', 'drive_search', 'drive_get_doc'];

/**
 * Quick-lane TEXT cues → held-back core tools the text obviously needs (a preload heuristic, never a gate — every
 * tool stays callable by name). The account / connector / platform groups come from tool-groups.ts's hint rules.
 */
export const QUICK_TEXT_CUES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\b(?:pdf|docx?|word doc(?:ument)?|document|form)\b/i, ['create_document', 'update_document', 'fill_pdf_form']],
  [/\b(?:draw|drawing|image|picture|illustration|logo|photo|render)\b/i, ['generate_image']],
  [/\b(?:browse|browser|log ?in|sign ?in|click|website)\b/i, ['browser_task']],
  [/\b(?:remind(?:er)?|schedule|every (?:day|morning|evening|night|week|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow at|in \d+ (?:min(?:ute)?s?|hours?))\b/i, ['schedule_message', 'list_schedules', 'update_schedule', 'cancel_schedule']],
  [/\b(?:repo|repository|coding session|pull request|deploy|build (?:me )?(?:an? )?(?:app|site|website|tool))\b/i, ['start_coding_session']],
  [/\b(?:bug|feedback|feature request|broken|not working)\b/i, ['file_feedback', 'get_feedback']],
  [/\b(?:chats?|conversations?|sessions?)\b/i, ['list_chats', 'search_chats', 'get_chat_messages', 'get_chat_status']],
  [/\b(?:delegate|in parallel|sub-?agents?)\b/i, ['delegate', 'delegate_parallel', 'delegate_status']],
];

/** A text that asks for the web keeps the web tools whatever needs_live_web says. */
const WEB_TEXT_CUE = /\b(?:search|look(?:ing)? ?up|google|online|internet|web|website|browse|browser|log ?in|sign ?in|click|url|link|news|latest|today|tonight|current(?:ly)?|price|weather|score|stocks?)\b|https?:\/\/|www\./i;
const VERBATIM_TOOL_NAME = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

export interface LaneToolView {
  /** The tool names in view at run start (+ the gateway pair). */
  view: Set<string>;
  lane: ToolLane;
  /** The web tools were held back (needs_live_web below the bar, no web cue in the text). */
  webDropped: boolean;
}

/**
 * The tool names a lane's turn STARTS with (pure). `names` = the run's full list; `keep` = names always in view (the
 * harness extras); `text` = toolGroupsPromptText. Standard = chatToolGroupsInitialView exactly.
 */
export function laneToolView(names: readonly string[], opts: {
  text: string; triage: boolean; extraGroups?: readonly ToolGroupId[]; hint: ToolLaneHint; keep?: Iterable<string>; webDropBelow?: number;
}): LaneToolView {
  const text = String(opts.text ?? '');
  const known = new Set(names);
  const verbatim = new Set((text.match(VERBATIM_TOOL_NAME) ?? []).filter((n) => known.has(n)));
  let view: Set<string>;
  if (opts.hint.lane === 'quick') {
    // The groups the TEXT names (+ triage / the user's MCP group) — never the chat lane's habitual account group.
    const s = new ToolGroupSession(names);
    for (const g of hintGroupsForText(text, names)) s.load(g);
    if (opts.triage) s.load('triage');
    for (const g of opts.extraGroups ?? []) s.load(g);
    view = new Set(names.filter((n) => groupForTool(n) !== 'core' && s.isVisible(n)));
    for (const n of QUICK_LANE_TOOL_NAMES) if (known.has(n)) view.add(n);
    for (const [re, tools] of QUICK_TEXT_CUES) if (re.test(text)) for (const n of tools) if (known.has(n)) view.add(n);
  } else {
    view = chatToolGroupsInitialView(names, { text, triage: opts.triage, extraGroups: opts.extraGroups });
    const extra = opts.hint.lane === 'research' ? RESEARCH_LANE_TOOLS : opts.hint.lane === 'checked' ? CHECKED_LANE_TOOLS : [];
    for (const n of extra) if (known.has(n)) view.add(n);
  }
  const below = opts.webDropBelow ?? LANE_WEB_DROP_BELOW_DEFAULT;
  const webDropped = (opts.hint.lane === 'quick' || opts.hint.lane === 'standard')
    && opts.hint.needsLiveWeb !== null && opts.hint.needsLiveWeb < below && !WEB_TEXT_CUE.test(text);
  if (webDropped) for (const n of WEB_LANE_TOOLS) view.delete(n);
  for (const n of verbatim) view.add(n);
  for (const n of opts.keep ?? []) if (known.has(n)) view.add(n);
  for (const n of TOOL_GROUP_META_TOOLS) view.add(n);
  return { view, lane: opts.hint.lane, webDropped };
}

/** Tools a run called that were in its full list but outside the lane's starting view (meta tools never count). Pure. */
export function laneWouldMissTools(called: readonly string[], fullNames: ReadonlySet<string>, view: ReadonlySet<string>): string[] {
  return called.filter((n) => fullNames.has(n) && !view.has(n) && !TOOL_GROUP_META_TOOLS.includes(n));
}

export interface LaneToolSetsDecision {
  mode: ChatToolGroupsMode;
  /** The lane's starting set replaces A2's for this sender (only where A2 acts). */
  acts: boolean;
  canary: boolean;
}

/** Mode + canary + whether A2 acts for this sender → does the lane set act? Pure. */
export function decideLaneToolSets(cfg: ToolDietConfig, userId: string | null | undefined, chatToolGroupsActs: boolean): LaneToolSetsDecision {
  const canary = !!userId && cfg.canaryUserIds.includes(userId);
  const acts = chatToolGroupsActs && (cfg.laneToolSets === 'act' || (cfg.laneToolSets === 'shadow' && canary));
  return { mode: cfg.laneToolSets, acts, canary };
}

/** The per-run lane record (agent.ts keeps one on its tool-diet state). */
export interface ChatLaneDiet extends LaneToolSetsDecision {
  lane: ToolLane;
  needsLiveWeb: number | null;
  /** 'start' = the plan was in at run start (the only source that can act); 'late' = only by run end (shadow row). */
  source: 'start' | 'late';
  view: Set<string>;
  webDropped: boolean;
  offeredTools: number;
  offeredChars: number;
}

/** Build the lane record for a run (pure). Null when there is no classified plan. A 'late' record never acts. */
export function chatLaneDiet(hint: ToolLaneHint | null, tools: ReadonlyArray<{ function?: { name?: string } }>, opts: {
  text: string; triage: boolean; extraGroups?: readonly ToolGroupId[]; keep?: Iterable<string>; webDropBelow: number;
  decision: LaneToolSetsDecision; source: 'start' | 'late';
}): ChatLaneDiet | null {
  if (!hint) return null;
  const names = tools.map((t) => String(t?.function?.name ?? '')).filter(Boolean);
  const lv = laneToolView(names, { text: opts.text, triage: opts.triage, extraGroups: opts.extraGroups, hint, keep: opts.keep, webDropBelow: opts.webDropBelow });
  return {
    ...opts.decision, acts: opts.decision.acts && opts.source === 'start',
    lane: hint.lane, needsLiveWeb: hint.needsLiveWeb, source: opts.source, view: lv.view, webDropped: lv.webDropped,
    offeredTools: lv.view.size, offeredChars: schemaChars(tools.filter((t) => lv.view.has(String(t?.function?.name ?? '')))),
  };
}

/** The lane fields of the tool_diet row (pure; {} without a lane record). */
export function laneDietMeta(lane: ChatLaneDiet | null, called: readonly string[], fullNames: ReadonlySet<string>): Record<string, unknown> {
  if (!lane) return {};
  const miss = laneWouldMissTools(called, fullNames, lane.view);
  return {
    lane: lane.lane, needsLiveWeb: lane.needsLiveWeb === null ? null : Number(lane.needsLiveWeb.toFixed(3)),
    laneMode: lane.mode, laneActed: lane.acts, laneCanary: lane.canary, laneSource: lane.source, webDropped: lane.webDropped,
    laneOfferedTools: lane.offeredTools, laneOfferedChars: lane.offeredChars, laneWouldMiss: miss.slice(0, 40),
  };
}

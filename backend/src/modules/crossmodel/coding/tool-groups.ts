/**
 * PROGRESSIVE TOOL DISCLOSURE — tool groups (2026-09-27).
 *
 * Owner, on reading "Tool list trimmed to api-optimize-moonshot-kimi-k3's
 * 128-tool limit (196 → 128; dropped: connector writes, connector reads,
 * platform actions)": "this is not good from my pov it should be way smarter
 * than just trimming? or set a group of tools behind another tool or
 * something else?"
 *
 * This leaf is the "something else": the SOTA pattern every agent harness
 * converged on (deferred / searchable tools) — a small ALWAYS-ON CORE plus tool
 * GROUPS the model loads on demand through two gateway tools:
 *
 *   list_tool_groups()            → every group with a one-line description,
 *                                   its size, whether it is loaded, the cap and
 *                                   the headroom.
 *   load_tools({group} | {query}) → loads a whole group, or the tools whose
 *                                   names / group match a keyword query, into
 *                                   THIS run's active list for the rest of the
 *                                   run. Over the cap ⇒ the least-recently-USED
 *                                   non-core group is evicted and the result
 *                                   says so.
 *
 * A tool the model calls BY NAME that is not in view is auto-loaded on first
 * call (never an "unknown tool" refusal) — the executors resolve every tool
 * from the full registry regardless of what the model currently sees; the
 * schema filter is only what the model is shown.
 *
 * When it applies (agent.ts): whenever the provider's tool cap is BELOW the
 * run's full list (a documented / configured / learned cap — never the retired
 * blanket 128), or universally under TOOL_GROUPS_ALWAYS=1 (token savings: a
 * ~200-tool schema is ~55k tokens on every turn). With no cap and the switch
 * off, behaviour is byte-identical to before. TOOL_GROUPS_DISABLED=1 restores
 * the priority trim.
 *
 * Grouping is DETERMINISTIC and TOTAL: `groupForTool` maps every tool name to
 * exactly one group by rule (explicit core list → account / triage /
 * supervisor sets → connector prefix → platform read / mutating registries →
 * core for anything unknown, e.g. a council's extra tools), so a tool added
 * anywhere in the registry is grouped without touching this file;
 * tool-groups.test.ts pins the totality and that the core stays under
 * CORE_MAX (96) on the real coding and chat lists.
 *
 * Pure leaf: imports only the tool-name leaves (platform-tool-names,
 * tool-scope). No env reads outside the two switch helpers, no prisma.
 */

import { PLATFORM_READ_TOOLS, PLATFORM_MUTATING_TOOLS } from '../platform/platform-tool-names';
import { SUPERVISOR_ONLY_TOOLS, TRIAGE_TOOLS, TRIAGE_TOOL_GROUP } from './tool-scope';

// ── Gateway tools ────────────────────────────────────────────────────────────

export const LIST_TOOL_GROUPS_TOOL = 'list_tool_groups';
export const LOAD_TOOLS_TOOL = 'load_tools';
/** The two gateway (meta) tools — always in view while groups are active. */
export const TOOL_GROUP_META_TOOLS: readonly string[] = [LIST_TOOL_GROUPS_TOOL, LOAD_TOOLS_TOOL];

/**
 * audit 2026-10-06 T5-7 (schooltime F5): a project supervisor spent ~20 calls
 * and 34 min hunting for merge_pull_request because the doctrine promised that
 * any tool "loads automatically" — but coding-lane tools (merge / open PR,
 * git_*, run_command, file edits) do not exist on a chat / supervisor profile
 * at all, so nothing could ever load them. A by-name call (or a load_tools
 * query) for such a tool on a non-coding profile now answers AT ONCE with
 * where the tool lives. Kill switch LANE_ONLY_TOOL_HINT_DISABLED=1 restores
 * the generic not-offered refusal.
 */
export function laneOnlyToolHintDisabled(): boolean {
  return process.env.LANE_ONLY_TOOL_HINT_DISABLED === '1';
}

/** The refusal hint for a coding-lane tool called on a profile that does not carry it. */
export function laneOnlyToolHint(tool: string): string {
  return `${tool} is a LANE-ONLY tool: it exists only in a coding session that owns a worktree, never on this profile, and no tool group can load it — ` +
    `ask the lane that owns the worktree to do it (send_chat_message to that lane), or dispatch a lane for it (start_coding_session); do not search for it`;
}

/**
 * The coding-lane tool names a load_tools query names (by exact name), for
 * the T5-7 hint on a non-coding profile. Pure.
 */
export function laneOnlyToolsInQuery(query: string, laneOnlyNames: Iterable<string>): string[] {
  const q = String(query ?? '').toLowerCase();
  if (!q.trim()) return [];
  const out: string[] = [];
  for (const n of laneOnlyNames) {
    const name = String(n).toLowerCase();
    if (q.includes(name)) out.push(n);
  }
  return out.slice(0, 5);
}

export function toolGroupsDisabled(): boolean {
  const v = String(process.env.TOOL_GROUPS_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
/** Opt-in universal progressive disclosure (groups even with no provider cap). */
export function toolGroupsAlways(): boolean {
  const v = String(process.env.TOOL_GROUPS_ALWAYS ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// ── Groups ───────────────────────────────────────────────────────────────────

export type ToolGroupId =
  | 'core'
  | 'account'
  | 'triage'
  | 'supervisor'
  | 'platform_reads'
  | 'platform_actions'
  | 'connector_google'
  | 'connector_github'
  | 'connector_slack'
  | 'connector_asana'
  | 'connector_x'
  | 'connector_xero'
  | 'connector_plaid'
  | 'connector_imessage'
  | 'connector_discord'
  | 'connector_mcp';

export const TOOL_GROUP_IDS: readonly ToolGroupId[] = [
  'core', 'account', 'triage', 'supervisor', 'platform_reads', 'platform_actions',
  'connector_google', 'connector_github', 'connector_slack', 'connector_asana', 'connector_x', 'connector_xero', 'connector_plaid', 'connector_imessage', 'connector_discord', 'connector_mcp',
];

export const TOOL_GROUP_DESCRIPTIONS: Readonly<Record<ToolGroupId, string>> = Object.freeze({
  core: 'Always on: files, shell, git, plan, processes, web search/scrape, browser + computer use, documents, delegation, chat messaging, schedules, goals/todos, receipts, feedback, owner questions.',
  account: 'The user\'s account: memory (list/remember/forget), feeds, canvases, knowledge base (URL/note), Telegram notify + connect link, share links, per-chat instructions, email as Digby.',
  triage: 'Feedback-queue triage: list_feedback + the ticket update tool — only when the task is to work or triage feedback tickets.',
  supervisor: 'Supervisor-only: the supervisor state doc and the fleet infra-blocker registry (executable only in a supervisor chat).',
  platform_reads: 'More platform reads: delegated-task status (task_list / task_get), fleet telemetry, model roles + seat tests, autonomy, pending confirmations, session files/diffs, uploads, spend, instances, webhooks, preferences.',
  platform_actions: 'More platform actions: chat/project housekeeping (move/rename/archive/create project), autonomy grants, hooks, infra actions, watched resources, session settings, workspace import/sync, canvases + knowledge files, memory rebuild, sharing, webhooks, instance sends, deletes.',
  connector_google: 'Google Workspace: Gmail search/read/send/draft, Drive search/read/upload, Calendar list/create, Docs, Sheets, Slides.',
  connector_github: 'GitHub (the user\'s connected accounts): code search, issues, pull requests.',
  connector_slack: 'Slack: search, channels, history, post as the user.',
  connector_asana: 'Asana: search/list tasks and projects, create/update tasks.',
  connector_x: 'X (Twitter): search posts, profiles, trends, post as the user.',
  connector_xero: 'Xero accounting: organisation, contacts, invoices.',
  connector_plaid: 'Plaid banking: linked accounts, balances, transactions.',
  connector_imessage: 'iMessage / SMS + Apple Calendar via the paired Mac: list chats, read messages, send, list Calendar.app events.',
  connector_discord: 'Discord: list guilds and channels, read channel messages, send messages, read DMs.',
  connector_mcp: 'The user\'s OWN MCP servers (Account → Integrations → MCP servers): every tool named mcp_<server>_<tool> — services Digby has no built-in connector for.',
});

/** Bound on the always-on core (pinned by tool-groups.test.ts on the REAL lists). */
export const CORE_MAX = 96;

/**
 * The always-on core: workspace + web + documents + delegation + the gateway,
 * plus the fleet-coordination tools every playbook / supervisor doctrine row
 * names on ordinary turns (messaging, schedules, goals/todos, receipts,
 * feedback filing, owner questions, run control).
 */
export const CORE_TOOL_NAMES: readonly string[] = [
  // workspace
  'read_file', 'view_image', 'list_dir', 'glob', 'grep', 'ast_search', 'ast_rewrite', 'write_file', 'edit_file', 'rewind_to_step', 'run_command',
  'git_status', 'git_diff', 'git_log', 'git_show', 'git_commit', 'git_push', 'open_pull_request', 'check_ci', 'merge_pull_request',
  'update_plan', 'verify', 'search_memory', 'search_code_semantic', 'web_pipe', 'youtube_pipe',
  'start_background_process', 'read_process_output', 'wait_for_process_output', 'list_processes', 'stop_process', 'ask_user', 'schedule_self',
  // web + documents
  'search_engine', 'scrape_as_markdown', 'browser_task', 'computer_task',
  'create_document', 'read_document', 'update_document', 'list_files', 'fill_pdf_form', 'generate_image',
  // delegation + the gateway
  'delegate', 'delegate_parallel', 'delegate_status', 'load_tool_group', LIST_TOOL_GROUPS_TOOL, LOAD_TOOLS_TOOL,
  // fleet coordination (platform tools the doctrine names on ordinary turns)
  'list_chats', 'get_chat_status', 'get_chat_messages', 'send_chat_message', 'wait_for_chat', 'create_chat', 'start_coding_session',
  'search_chats', 'resolve_id', 'list_schedules', 'schedule_get', 'schedule_message', 'update_schedule', 'cancel_schedule',
  'get_run_receipts', 'get_spend', 'goal_list', 'goal_get', 'goal_create', 'goal_update', 'goal_premise_set',
  'todo_list', 'todo_get', 'todo_create', 'todo_update', 'hook_list', 'hook_subscribe',
  'subscribe_drive_watch', 'unsubscribe_drive_watch',
  'list_owner_questions', 'flag_owner_question', 'answer_owner_question', 'file_feedback', 'get_feedback',
  'get_project', 'list_projects', 'stop_run', 'answer_chat_question', 'approve_request', 'get_chat_instructions',
];

/** The account group — the 18 account tools (platform/account-tools.ts
 *  ACCOUNT_TOOL_NAMES; tool-groups.test.ts pins equality with isAccountTool). */
export const ACCOUNT_GROUP_TOOLS: readonly string[] = [
  'get_account_overview', 'list_memory', 'list_canvases', 'get_canvas', 'list_knowledge_documents', 'telegram_connect_link',
  'remember_fact', 'forget_fact', 'add_knowledge_url', 'add_knowledge_note', 'update_canvas', 'revoke_share_link', 'notify_user',
  'set_chat_instructions', 'send_email_as_digby', 'create_share_link',
];

const CORE = new Set(CORE_TOOL_NAMES);
const ACCOUNT = new Set(ACCOUNT_GROUP_TOOLS);
const PLATFORM_READ = new Set<string>(PLATFORM_READ_TOOLS as readonly string[]);
const PLATFORM_MUTATING = new Set<string>(PLATFORM_MUTATING_TOOLS as readonly string[]);

const CONNECTOR_PREFIX_GROUPS: ReadonlyArray<[RegExp, ToolGroupId]> = [
  [/^(gmail|drive|calendar|docs|sheets|slides)_/, 'connector_google'],
  [/^github_/, 'connector_github'],
  [/^slack_/, 'connector_slack'],
  [/^asana_/, 'connector_asana'],
  [/^x_/, 'connector_x'],
  [/^xero_/, 'connector_xero'],
  [/^plaid_/, 'connector_plaid'],
  [/^(?:imessage|mac_calendar)_/, 'connector_imessage'],
  [/^discord_/, 'connector_discord'],
  // User-added MCP servers (ticket e294f9a4): mcp_<slug>_<tool> — never core, so a
  // user with many servers never crowds the always-on core.
  [/^mcp_[a-z0-9]{1,12}_/, 'connector_mcp'],
];

/** The ONE group a tool belongs to. Total and deterministic (see the header). */
export function groupForTool(name: string | undefined | null): ToolGroupId {
  const n = String(name ?? '');
  if (!n) return 'core';
  if (CORE.has(n)) return 'core';
  if (ACCOUNT.has(n)) return 'account';
  if (TRIAGE_TOOLS.has(n)) return 'triage';
  if (SUPERVISOR_ONLY_TOOLS.has(n)) return 'supervisor';
  for (const [re, g] of CONNECTOR_PREFIX_GROUPS) if (re.test(n)) return g;
  if (PLATFORM_READ.has(n)) return 'platform_reads';
  if (PLATFORM_MUTATING.has(n)) return 'platform_actions';
  return 'core';
}

export function isToolGroupId(x: unknown): x is ToolGroupId {
  return typeof x === 'string' && (TOOL_GROUP_IDS as readonly string[]).includes(x);
}

// ── Prompt hints ─────────────────────────────────────────────────────────────

/** Deterministic keyword → group hints read off the task text at run start
 *  (a PRELOAD heuristic — the group stays loadable regardless; never a gate). */
const HINT_RULES: ReadonlyArray<[ToolGroupId, RegExp]> = [
  ['connector_google', /\bg-?mail\b|\bgoogle (?:drive|docs?|sheets?|slides?|calendar|workspace)\b|\bgdrive\b|\bspreadsheet\b|\bcalendar\b/i],
  ['connector_github', /\bgithub\b|\bpull requests?\b|\bPRs?\s?#\d/i],
  ['connector_slack', /\bslack\b/i],
  ['connector_asana', /\basana\b/i],
  ['connector_x', /\btwitter\b|\btweets?\b|\bx\.com\b|\bpost (?:it |this )?on x\b/i],
  ['connector_xero', /\bxero\b|\binvoices?\b/i],
  ['connector_plaid', /\bplaid\b|\bbank (?:accounts?|balances?|transactions?)\b/i],
  ['connector_imessage', /\bimessage\b|\bsms\b|\btext (?:me|message)\b|\bapple calendar\b|\bmac calendar\b|\bcalendar\.app\b/i],
  ['connector_discord', /\bdiscord\b|\bguilds?\b|\bDMs?\b/i],
  ['connector_mcp', /\bmcp\b|\bmcp servers?\b/i],
  ['account', /\bremember\b|\bmemor(?:y|ies)\b|\bfeeds?\b|\bcanvas\b|\bknowledge base\b|\btelegram\b|\bnotify me\b|\bshare link\b|\bemail me\b/i],
  ['triage', /\[TICKET (?:BATCH )?DISPATCH|\bfeedback tickets?\b|\btriage_ticket\b|\blist_feedback\b|\bupdate_feedback\b/i],
  ['supervisor', /\bsupervisor\b|\binfra.?blocker/i],
  ['platform_actions', /\bautonomy\b|\bwebhooks?\b|\bpreferences\b|\barchive\b|\brename\b|\bimport (?:a |the |this )?repo\b|\bworkspace\b|\binfra_action\b/i],
  ['platform_reads', /\btelemetry\b|\bmodel roles?\b|\bseats?\b|\bpending confirmations?\b|\buploads?\b|\bsession files?\b/i],
];

const TOOL_NAME_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * Groups the text obviously needs: the keyword rules above plus any tool named
 * verbatim in the text (`gmail_search` ⇒ connector_google) that this run
 * actually carries. Order: first mention wins; never 'core'. Pure.
 */
export function hintGroupsForText(text: string | undefined | null, knownTools?: Iterable<string>): ToolGroupId[] {
  const t = String(text ?? '');
  if (!t) return [];
  const out: ToolGroupId[] = [];
  const add = (g: ToolGroupId) => { if (g !== 'core' && !out.includes(g)) out.push(g); };
  for (const [g, re] of HINT_RULES) if (re.test(t)) add(g);
  // A verbatim tool name only counts against THIS run's list.
  if (knownTools) {
    const known = new Set(knownTools);
    for (const tok of t.match(TOOL_NAME_TOKEN) ?? []) if (known.has(tok)) add(groupForTool(tok));
  }
  return out;
}

// ── The per-run session ──────────────────────────────────────────────────────

export interface LoadResult {
  ok: boolean;
  group?: ToolGroupId;
  /** Tool names newly in view. */
  loaded: string[];
  /** Groups evicted to make room. */
  evicted: ToolGroupId[];
  already?: boolean;
  partial?: boolean;
  reason?: 'unknown_group' | 'empty_group' | 'no_match' | 'too_large';
  message: string;
}

interface LoadedGroup { names: Set<string>; lastUsed: number }

/**
 * build 2026-10-08 A2b (coding/tool-diet.ts lane-aware starting sets): what list_tool_groups says about the core
 * tools a lane HELD BACK for this turn — listed as the group 'core' (load_tools({group:'core'}) brings them all back;
 * a by-name call auto-loads one). Only ever shown while something is held back.
 */
export const DEFERRED_CORE_DESCRIPTION = 'Core tools held back for this turn by its lane (web, documents, delegation, schedules, goals/todos, chats, feedback…) — call one by name, or load_tools({group:"core"}) for all of them.';

/**
 * The loaded-group state of ONE run: which tools are in view, LRU eviction
 * under the cap, auto-loads, and the snapshot telemetry reads. Pure and
 * synchronous; the agent loop owns one per run and re-feeds it the full list
 * when the list changes (withheld tools, a seat fallback with another cap).
 */
export class ToolGroupSession {
  private cap: number | undefined;
  private members = new Map<ToolGroupId, string[]>();
  private groupOf = new Map<string, ToolGroupId>();
  private loaded = new Map<ToolGroupId, LoadedGroup>();
  /** build 2026-10-08 A2b: core tools HELD BACK (not in view) — empty unless a lane-aware starting set deferred
   *  them (deferCore / seedView). Empty = every core tool in view, byte-identical to before. */
  private deferred = new Set<string>();
  private tick = 0;
  /** Every eviction this run, in order (a group may appear more than once). */
  readonly evictedLog: ToolGroupId[] = [];
  autoLoads = 0;
  loads = 0;

  constructor(toolNames: Iterable<string>, cap?: number) {
    this.setTools(toolNames);
    this.cap = positive(cap);
  }

  /** (Re)declare the run's FULL tool list (the names the executor can resolve). */
  setTools(toolNames: Iterable<string>): void {
    this.members = new Map();
    this.groupOf = new Map();
    for (const n of toolNames) {
      if (!n || this.groupOf.has(n)) continue;
      const g = groupForTool(n);
      this.groupOf.set(n, g);
      const arr = this.members.get(g) ?? [];
      arr.push(n);
      this.members.set(g, arr);
    }
    // Loaded names that left the list are dropped; empty loads vanish.
    for (const [g, lg] of this.loaded) {
      for (const n of [...lg.names]) if (this.groupOf.get(n) !== g) lg.names.delete(n);
      if (!lg.names.size) this.loaded.delete(g);
    }
    this.fitToCap();
  }

  /** The cap in force (undefined = unlimited). Lowering it evicts LRU groups. */
  setCap(cap: number | undefined): void {
    this.cap = positive(cap);
    this.fitToCap();
  }
  getCap(): number | undefined { return this.cap; }

  get coreNames(): string[] { return this.members.get('core') ?? []; }
  /** Core tools IN VIEW (all of them unless a lane held some back). */
  coreCount(): number { return this.deferred.size ? this.coreNames.filter((n) => !this.deferred.has(n)).length : this.coreNames.length; }
  /** build 2026-10-08 A2b: the core tools of THIS list currently held back. */
  deferredNames(): string[] { return this.deferred.size ? this.coreNames.filter((n) => this.deferred.has(n)) : []; }
  deferredCount(): number { return this.deferredNames().length; }

  /**
   * build 2026-10-08 A2b: HOLD BACK core tools for this run (a lane-aware starting set — coding/tool-diet.ts). A
   * held-back tool leaves the view but stays callable: a by-name call auto-loads it (ensureLoadedFor), and
   * load_tools({group:'core'}) / a keyword query bring it back. Non-core and unknown names are ignored. Returns
   * the names newly held back.
   */
  deferCore(names: Iterable<string>): string[] {
    const out: string[] = [];
    for (const n of names) {
      if (this.groupOf.get(n) !== 'core' || this.deferred.has(n)) continue;
      this.deferred.add(n);
      out.push(n);
    }
    return out;
  }

  /**
   * build 2026-10-08 A2b: make the view EXACTLY `view` ∩ this list — every loaded group is cleared, core tools
   * outside the view are held back, non-core tools inside it are loaded one by one (loadTools: no whole group, no
   * eviction, stops at the cap). The run-start seed of a lane-aware set; the load counter restarts (the seed is
   * not a model load).
   */
  seedView(view: ReadonlySet<string>): void {
    this.loaded = new Map();
    this.deferred = new Set();
    this.deferCore(this.coreNames.filter((n) => !view.has(n)));
    this.loadTools([...this.groupOf.keys()].filter((n) => view.has(n)));
    this.loads = 0;
  }
  loadedCount(): number { let n = 0; for (const lg of this.loaded.values()) n += lg.names.size; return n; }
  visibleCount(): number { return this.coreCount() + this.loadedCount(); }
  /** Tools that can still be added before the cap binds (Infinity = no cap). */
  headroom(): number { return this.cap === undefined ? Number.POSITIVE_INFINITY : Math.max(0, this.cap - this.visibleCount()); }

  groupOfTool(name: string): ToolGroupId | undefined { return this.groupOf.get(name); }
  hasTool(name: string): boolean { return this.groupOf.has(name); }

  isVisible(name: string): boolean {
    const g = this.groupOf.get(name);
    if (!g) return false;
    if (g === 'core') return !this.deferred.has(name);
    return this.loaded.get(g)?.names.has(name) ?? false;
  }

  /** Loaded groups, most-recently-used first. */
  loadedGroups(): ToolGroupId[] {
    return [...this.loaded.entries()].sort((a, b) => b[1].lastUsed - a[1].lastUsed).map(([g]) => g);
  }

  /** Every non-core group this run carries, with counts (what list_tool_groups prints). */
  available(): Array<{ id: ToolGroupId; description: string; tools: number; loaded: number; names: string[] }> {
    const out: Array<{ id: ToolGroupId; description: string; tools: number; loaded: number; names: string[] }> = [];
    // build 2026-10-08 A2b: core tools a lane held back are offered as the group 'core' (names = the held-back ones).
    const held = this.deferredNames();
    if (held.length) out.push({ id: 'core', description: DEFERRED_CORE_DESCRIPTION, tools: this.coreNames.length, loaded: this.coreNames.length - held.length, names: held });
    for (const id of TOOL_GROUP_IDS) {
      if (id === 'core') continue;
      const names = this.members.get(id);
      if (!names?.length) continue;
      out.push({ id, description: TOOL_GROUP_DESCRIPTIONS[id], tools: names.length, loaded: this.loaded.get(id)?.names.size ?? 0, names });
    }
    return out;
  }

  /** The list_tool_groups result body. */
  listing(): { cap: number | null; inView: number; headroom: number | null; core: number; loadedGroups: ToolGroupId[]; groups: Array<{ group: ToolGroupId; description: string; tools: number; loaded: 'yes' | 'partial' | 'no'; names?: string[] }> } {
    return {
      cap: this.cap ?? null,
      inView: this.visibleCount(),
      headroom: this.cap === undefined ? null : this.headroom(),
      core: this.coreCount(),
      loadedGroups: this.loadedGroups(),
      groups: this.available().map((g) => ({
        group: g.id, description: g.description, tools: g.tools,
        loaded: g.loaded === 0 ? 'no' : (g.loaded === g.tools ? 'yes' : 'partial'),
        ...(g.loaded === g.tools ? {} : { names: g.names }),
      })),
    };
  }

  /** Load a whole group (the rest of it when partially loaded). */
  load(group: string): LoadResult {
    // build 2026-10-08 A2b: 'core' is loadable only while a lane holds core tools back (it brings them all back).
    if (group === 'core' && this.deferredCount()) return this.loadDeferredCore();
    if (!isToolGroupId(group) || group === 'core') {
      return { ok: false, loaded: [], evicted: [], reason: 'unknown_group', message: `Unknown tool group "${group}". Available: ${this.available().map((g) => g.id).join(', ') || 'none'}. Call list_tool_groups.` };
    }
    const names = this.members.get(group) ?? [];
    if (!names.length) return { ok: false, group, loaded: [], evicted: [], reason: 'empty_group', message: `Group "${group}" carries no tools in this run.` };
    const missing = names.filter((n) => !this.isVisible(n));
    if (!missing.length) return { ok: true, group, loaded: [], evicted: [], already: true, message: `Group "${group}" is already in your tool list (${names.length} tools).` };
    const evicted = this.makeRoom(missing.length, new Set([group]));
    if (this.cap !== undefined && this.headroom() < missing.length) {
      const fit = Math.max(0, this.headroom());
      if (fit === 0) return { ok: false, group, loaded: [], evicted, reason: 'too_large', message: `Group "${group}" has ${missing.length} tools but only ${this.coreCount()} core tools fit under this model's ${this.cap}-tool cap. Load a subset with load_tools({query}).` };
      const subset = missing.slice(0, fit);
      this.put(group, subset);
      this.loads += 1;
      return { ok: true, group, loaded: subset, evicted, partial: true, message: `Loaded ${subset.length} of ${missing.length} "${group}" tools (the cap of ${this.cap} binds)${evictedNote(evicted)}. Load the rest by name with load_tools({query}).` };
    }
    this.put(group, missing);
    this.loads += 1;
    return { ok: true, group, loaded: missing, evicted, message: `Loaded ${missing.length} "${group}" tools — in your tool list from the next round on${evictedNote(evicted)}.` };
  }

  /** Load the tools matching a keyword query (name tokens, group id or description words). */
  loadQuery(query: string): LoadResult {
    const tokens = String(query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    if (!tokens.length) return { ok: false, loaded: [], evicted: [], reason: 'no_match', message: 'Give a keyword query of at least 3 characters, or a group id.' };
    // Pass 1: tool NAMES that carry a token ("gmail" ⇒ gmail_*). Pass 2, only
    // when no name matched: groups whose id / description carries a token
    // ("banking" ⇒ connector_plaid) — the whole group.
    const wanted = new Map<ToolGroupId, string[]>();
    const want = (g: ToolGroupId, n: string) => { const arr = wanted.get(g) ?? []; arr.push(n); wanted.set(g, arr); };
    let nameMatches = 0;
    for (const g of this.available()) {
      for (const n of g.names) {
        if (!tokens.some((t) => n.includes(t))) continue;
        nameMatches += 1;
        if (!this.isVisible(n)) want(g.id, n);
      }
    }
    if (nameMatches && !wanted.size) {
      return { ok: false, loaded: [], evicted: [], reason: 'no_match', message: `Every tool matching "${query}" is already in your tool list.` };
    }
    if (!wanted.size) {
      for (const g of this.available()) {
        if (!tokens.some((t) => g.id.includes(t) || g.description.toLowerCase().includes(t))) continue;
        for (const n of g.names) if (!this.isVisible(n)) want(g.id, n);
      }
    }
    const total = [...wanted.values()].reduce((n, a) => n + a.length, 0);
    if (!total) {
      return { ok: false, loaded: [], evicted: [], reason: 'no_match', message: `No tool matches "${query}". Call list_tool_groups for the groups.` };
    }
    const evicted = this.makeRoom(total, new Set(wanted.keys()));
    let room = this.cap === undefined ? Number.POSITIVE_INFINITY : this.headroom();
    const loaded: string[] = [];
    for (const [g, names] of wanted) {
      const take = names.slice(0, Math.max(0, Math.min(names.length, room)));
      if (!take.length) continue;
      this.put(g, take);
      loaded.push(...take);
      room -= take.length;
    }
    this.loads += 1;
    const partial = loaded.length < total;
    if (!loaded.length) return { ok: false, loaded: [], evicted, reason: 'too_large', message: `No headroom under the ${this.cap}-tool cap for "${query}" (${this.coreCount()} core tools in view).` };
    return { ok: true, loaded, evicted, partial, message: `Loaded ${loaded.length}${partial ? ` of ${total}` : ''} tools matching "${query}" — in your tool list from the next round on${evictedNote(evicted)}.` };
  }

  /**
   * Load SPECIFIC tools (no whole group, no eviction) — a profile's measured
   * preload (build 2026-10-08 A2-2: the non-core tools human chat turns call
   * most). Unknown and already-visible names are skipped (a core tool held
   * back by a lane, A2b, comes back); stops at the
   * cap. Returns the names newly in view.
   */
  loadTools(names: Iterable<string>): string[] {
    const added: string[] = [];
    for (const n of names) {
      const g = this.groupOf.get(n);
      // A core tool is skipped while in view; one a lane held back (A2b) comes back (put('core') un-holds it).
      if (!g || this.isVisible(n)) continue;
      if (this.cap !== undefined && this.headroom() < 1) break;
      this.put(g, [n]);
      added.push(n);
    }
    return added;
  }

  /**
   * AUTO-LOAD on a by-name call to a tool not in view: the whole group when it
   * fits (after LRU eviction), else just that tool. Returns null when the tool
   * is unknown to this run or already visible.
   */
  ensureLoadedFor(name: string): LoadResult | null {
    const g = this.groupOf.get(name);
    if (!g || this.isVisible(name)) return null;
    // build 2026-10-08 A2b: a core tool the lane held back (the only invisible core tool) comes back on its own.
    if (g === 'core') {
      const evicted = this.makeRoom(1, new Set());
      if (this.cap !== undefined && this.headroom() < 1) {
        return { ok: false, group: g, loaded: [], evicted, reason: 'too_large', message: `${name} executed, but no headroom under the ${this.cap}-tool cap to keep it in view.` };
      }
      this.put(g, [name]);
      this.autoLoads += 1;
      return { ok: true, group: g, loaded: [name], evicted, partial: true, message: `Auto-loaded ${name} (a core tool held back for this turn) on your call${evictedNote(evicted)}.` };
    }
    const names = (this.members.get(g) ?? []).filter((n) => !this.isVisible(n));
    const evicted = this.makeRoom(names.length, new Set([g]));
    const whole = this.cap === undefined || this.headroom() >= names.length;
    if (whole) {
      this.put(g, names);
      this.autoLoads += 1;
      return { ok: true, group: g, loaded: names, evicted, message: `Auto-loaded the "${g}" group (${names.length} tools) on your call to ${name}${evictedNote(evicted)}.` };
    }
    const more = this.makeRoom(1, new Set([g]));
    evicted.push(...more);
    if (this.cap !== undefined && this.headroom() < 1) {
      return { ok: false, group: g, loaded: [], evicted, reason: 'too_large', message: `${name} executed, but no headroom under the ${this.cap}-tool cap to keep it in view.` };
    }
    this.put(g, [name]);
    this.autoLoads += 1;
    return { ok: true, group: g, loaded: [name], evicted, partial: true, message: `Auto-loaded ${name} (group "${g}") on your call${evictedNote(evicted)}.` };
  }

  /** LRU bookkeeping: a call to a loaded tool refreshes its group. */
  noteUse(name: string): void {
    const g = this.groupOf.get(name);
    if (!g || g === 'core') return;
    const lg = this.loaded.get(g);
    if (lg) lg.lastUsed = ++this.tick;
  }

  /** The subset of `tools` the model sees this turn (core + loaded), input order. */
  visible<T extends { function: { name: string } }>(tools: readonly T[]): T[] {
    return tools.filter((t) => this.isVisible(t?.function?.name));
  }

  snapshot(): { cap: number | null; core: number; inView: number; loaded: ToolGroupId[]; evicted: ToolGroupId[]; autoLoads: number; loads: number; held?: number } {
    const held = this.deferredCount();
    return { cap: this.cap ?? null, core: this.coreCount(), inView: this.visibleCount(), loaded: this.loadedGroups(), evicted: [...this.evictedLog], autoLoads: this.autoLoads, loads: this.loads, ...(held ? { held } : {}) };
  }

  // ── internals ──
  /** build 2026-10-08 A2b: load_tools({group:'core'}) while a lane holds core tools back. */
  private loadDeferredCore(): LoadResult {
    const missing = this.deferredNames();
    const evicted = this.makeRoom(missing.length, new Set());
    const fit = this.cap === undefined ? missing.length : Math.min(missing.length, this.headroom());
    if (fit <= 0) return { ok: false, group: 'core', loaded: [], evicted, reason: 'too_large', message: `No headroom under the ${this.cap}-tool cap for the held-back core tools. Load a subset with load_tools({query}).` };
    const take = missing.slice(0, fit);
    this.put('core', take);
    this.loads += 1;
    const partial = take.length < missing.length;
    return { ok: true, group: 'core', loaded: take, evicted, ...(partial ? { partial: true } : {}), message: `Loaded ${take.length}${partial ? ` of ${missing.length}` : ''} held-back core tools — in your tool list from the next round on${evictedNote(evicted)}.` };
  }

  private put(group: ToolGroupId, names: string[]): void {
    // build 2026-10-08 A2b: "loading" a held-back core tool = no longer holding it back (core is never LRU-tracked).
    if (group === 'core') { for (const n of names) this.deferred.delete(n); return; }
    const lg = this.loaded.get(group) ?? { names: new Set<string>(), lastUsed: 0 };
    for (const n of names) lg.names.add(n);
    lg.lastUsed = ++this.tick;
    this.loaded.set(group, lg);
  }

  /** Evict least-recently-used loaded groups (never core, never `protect`)
   *  until `needed` more tools fit under the cap. Returns the evicted ids. */
  private makeRoom(needed: number, protect: Set<ToolGroupId>): ToolGroupId[] {
    const evicted: ToolGroupId[] = [];
    if (this.cap === undefined) return evicted;
    while (this.visibleCount() + needed > this.cap) {
      const victim = [...this.loaded.entries()].filter(([g]) => !protect.has(g)).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!victim) break;
      this.loaded.delete(victim[0]);
      evicted.push(victim[0]);
      this.evictedLog.push(victim[0]);
    }
    return evicted;
  }

  private fitToCap(): void {
    if (this.cap === undefined) return;
    while (this.visibleCount() > this.cap && this.loaded.size) {
      const victim = [...this.loaded.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      this.loaded.delete(victim[0]);
      this.evictedLog.push(victim[0]);
    }
  }
}

function positive(n: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
function evictedNote(evicted: ToolGroupId[]): string {
  return evicted.length ? `; evicted the least-recently-used group${evicted.length > 1 ? 's' : ''} ${evicted.join(', ')} to make room (reload with load_tools)` : '';
}

/**
 * Preload order at run start: groups the task text obviously needs first, then
 * the profile's habitual group (chat lanes carry the account tools by default),
 * then triage when the prompt works the feedback queue, then the supervisor
 * doc tools on a supervisor seat. Loaded in order until the cap binds.
 */
export function initialToolGroups(opts: { text: string; knownTools: Iterable<string>; chatLane: boolean; triage: boolean; supervisor: boolean }): ToolGroupId[] {
  const out = hintGroupsForText(opts.text, opts.knownTools);
  const add = (g: ToolGroupId) => { if (!out.includes(g)) out.push(g); };
  if (opts.chatLane) add('account');
  if (opts.triage) add(TRIAGE_TOOL_GROUP as ToolGroupId);
  if (opts.supervisor) add('supervisor');
  return out;
}

// ── Prompt surfaces ──────────────────────────────────────────────────────────

/** Prefix of the transient per-turn note (spliced out after the turn, like the clock note). */
export const TOOL_GROUPS_NOTE_PREFIX = '[HARNESS NOTE — TOOL GROUPS';

/** ONE informative line per turn while groups are active. Pure. */
export function toolGroupsSystemNote(session: ToolGroupSession, model: string): string {
  const cap = session.getCap();
  const loaded = session.loadedGroups();
  const pending = session.available().filter((g) => g.loaded < g.tools).map((g) => g.id);
  const capText = cap === undefined ? `${session.visibleCount()} tools in view` : `${session.visibleCount()}/${cap} tools in view (${model} takes at most ${cap} per request)`;
  const held = session.deferredCount();
  return `${TOOL_GROUPS_NOTE_PREFIX}: ${capText} — core${held ? ` (${held} held back for this turn)` : ''}${loaded.length ? ' + ' + loaded.join(', ') : ''}. ${pending.length} tool group${pending.length === 1 ? '' : 's'} available on demand${pending.length ? ` (${pending.join(', ')})` : ''} — call ${LIST_TOOL_GROUPS_TOOL} to see them and ${LOAD_TOOLS_TOOL}({group}) or ${LOAD_TOOLS_TOOL}({query}) to add one; a tool you call by name is loaded automatically.]`;
}

/** The live-run status line ("tool groups: core + X, Y"). Pure. */
export function toolGroupsProgressLine(session: ToolGroupSession): string {
  const cap = session.getCap();
  const loaded = session.loadedGroups();
  const pending = session.available().filter((g) => g.loaded < g.tools).length;
  return `Tool groups: core${loaded.length ? ' + ' + loaded.join(', ') : ''} (${session.visibleCount()}${cap === undefined ? '' : `/${cap}`} tools); ${pending} more on demand`;
}

export const LIST_TOOL_GROUPS_SCHEMA = {
  type: 'function' as const,
  function: {
    name: LIST_TOOL_GROUPS_TOOL,
    description: 'List the optional tool GROUPS of this run (connectors like Google/GitHub/Slack, more platform reads/actions, account tools…) with a one-line description each, which are loaded, this model\'s tool cap and the headroom. Call it when you need a capability you do not see in your tool list; then load_tools.',
    parameters: { type: 'object', properties: {} },
  },
};

export const LOAD_TOOLS_SCHEMA = {
  type: 'function' as const,
  function: {
    name: LOAD_TOOLS_TOOL,
    description: 'Load a tool group (by id from list_tool_groups) or the tools matching a keyword query (e.g. "gmail", "asana task", "webhook") into your tool list for the rest of this run. Under the model\'s tool cap the least-recently-used loaded group is evicted to make room and the result says so. A tool you call by name that is not loaded is loaded automatically on first call — you never need this to call a tool you already know the name of.',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'A group id from list_tool_groups (e.g. connector_google, account, platform_actions).' },
        query: { type: 'string', description: 'A keyword query matched against tool names and group descriptions (used when no group is given).' },
      },
    },
  },
};

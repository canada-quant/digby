/**
 * search_code_semantic — SCOPE + HONESTY (fs-code-knowledge, 2026-10-22).
 *
 * The Fleet Supervisor told the owner a shipped UI feature "does not exist":
 * it is an UNGROUPED chat, every chat-surface run carries the sentinel
 * projectId 'chat' (`ctx.projectId || 'chat'`, chat-agent.service), and the
 * tool searched project 'chat' — a scope no index sync ever writes. The empty
 * result said "the index may still be building … use grep/glob" (tools the
 * supervisor does not have), which read as absence.
 *
 * This module decides WHAT the tool searches and HOW a miss is worded:
 *   - an ungrouped-chat scope ('chat' / none) holds no code index: a
 *     supervisor chat searches the platform repository's project index (the
 *     instance's own SELF_REPO, resolved through the projects whose repoUrl
 *     names it); any other caller gets an honest "no code index here — a miss
 *     is NOT evidence of absence" result instead of a fake empty search;
 *   - a project whose index was never built answers the same way;
 *   - a miss in a real index says not-found ≠ does-not-exist and names only
 *     the existence-capable probes THIS caller actually holds;
 *   - hits carry the index's provenance ("index of <branch>@<sha7>, synced
 *     <age> ago") when code-index.service recorded it.
 *
 * Pure leaf on purpose (prompt-hygiene / jest light): the only import is the
 * import-free instance-targets leaf; every DB / store / search call arrives as
 * an injected dependency (CodeSearchDeps — tools.ts wires the real ones).
 */

import { normalizeGithubRepoTarget } from '../platform/instance-targets';

/** The sentinel projectId chat-agent.service launches every chat-surface run with. */
export const UNGROUPED_CHAT_SCOPE = 'chat';

/** =1 restores the pre-2026-10-22 search_code_semantic (searches ctx.projectId whatever it is; the old empty wording). */
export function codeSearchChatScopeRefuseDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_SEARCH_CHAT_SCOPE_REFUSE_DISABLED === '1';
}

/** =1 restores the pre-2026-10-22 index walk (reverse-alpha DFS, 2,500 cap, no provenance, sweep only on a complete pass) and drops the freshness prefix. */
export function codeIndexWalkV2Disabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_INDEX_WALK_V2_DISABLED === '1';
}

/**
 * =1 restores the pre-2026-10-23 stale-base behaviour: every checkout a sync
 * reads may update AND delete index rows, however old its base is (the
 * regression an external session's walk-v2 opened: a month-old lane checkout
 * purged newer files' rows from the prod index).
 */
export function codeIndexStaleBaseGuardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_INDEX_STALE_BASE_GUARD_DISABLED === '1';
}

/**
 * The code index's freshness view as this module reads it: walk v2 writes a
 * small `[projectId,'code-index']/meta` record (fileCount, never the files
 * map) next to the state row; a legacy row is summarised the same way
 * (code-index.service readCodeIndexState). `files` is present only on the
 * legacy full-state read (CODE_INDEX_WALK_V2_DISABLED=1).
 */
export interface CodeIndexStateView {
  files?: Record<string, string>;
  /** Files the index holds a hash for (the meta record's count of `files`). */
  fileCount?: number;
  lastSyncAt?: string;
  /** HEAD commit of the checkout the last sync read (walk v2) — only when HEAD was the same before the walk and after the last file read. */
  indexedSha?: string;
  /** HEAD moved during the last sync: the commit before the walk … */
  headMovedFrom?: string;
  /** … and the commit after the last file read (files reflect either). */
  headMovedTo?: string;
  /** Branch of that checkout ('detached' when HEAD was detached). */
  branch?: string;
  /**
   * merge-base(HEAD, origin/<base>) the index was last synced from (the
   * stale-base gate's lineage anchor): the next sync's sweep may delete rows
   * only when its anchor is at-or-ahead of this. Absent on legacy syncs.
   */
  indexedAnchor?: string;
  /** The last sync hit the per-sync embed budget — some files still reflect an older checkout or are missing. */
  partial?: boolean;
  /** Eligible files the last walk listed. */
  listed?: number;
  /** The last walk hit its file cap — files beyond it were never listed. */
  truncated?: boolean;
  /** Directory / file entries the last walk could not read (EACCES, EMFILE, an ENOENT race …) — an unlisted file was evicted only when stat proved it gone. */
  listingErrors?: number;
  /** Files the last sync held back because the project's code-row cap had no room: files the cap evicted (unchanged since; their last copy is archived) and test files the index does not hold yet. */
  capDeferred?: number;
  /** Files OUT of the hot index because of the cap, counted when the last sync wrote the state: every cap-evicted file (including the ones that sync evicted) plus new test files deferred for room. Preferred over capDeferred, which only counts the embed loop's holds. */
  capHeld?: number;
  /** The last sync could not read the per-file row counts, so the code-row cap was not applied that pass (the next readable pass applies it). */
  capSkipped?: 'stats_unreadable';
  /**
   * The last sync was refused by the stale-base gate: the checkout's base was
   * too far behind the default branch to be trusted with the shared index
   * (2026-10-23). The index is FROZEN (rows untouched) — older than
   * lastSyncAt looks. `staleReason` names why no base could be trusted.
   */
  staleRefused?: true;
  staleReason?: 'no_repo' | 'no_base' | 'base_unreadable' | 'stale_base' | 'detached_head' | 'clock_skew';
}

/** True for the ungrouped-chat sentinel (or no project at all): no index sync ever writes this scope. */
export function isUngroupedChatScope(projectId: string | null | undefined): boolean {
  return !projectId || projectId === UNGROUPED_CHAT_SCOPE;
}

export function indexedFileCount(state: CodeIndexStateView | null | undefined): number {
  if (state?.files && typeof state.files === 'object') return Object.keys(state.files).length;
  const n = Number(state?.fileCount);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** "just now" / "12m" / "5h" / "3d" — relative age of an ISO stamp; null when unparseable. */
export function ageText(iso: string | undefined, nowMs: number): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.floor((nowMs - t) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The provenance line for a code-index answer: what checkout the index came
 * from and how old it is. '' when the state carries nothing to say. A legacy
 * row (no sha / branch recorded) says so instead of implying main.
 */
export function renderCodeIndexFreshness(state: CodeIndexStateView | null | undefined, nowMs: number): string {
  if (!state) return '';
  const age = ageText(state.lastSyncAt, nowMs);
  const sha7 = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{7,40}$/i.test(v) ? v.slice(0, 7) : '');
  const sha = sha7(state.indexedSha);
  const movedFrom = sha7(state.headMovedFrom);
  const movedTo = sha7(state.headMovedTo);
  const branch = typeof state.branch === 'string' && state.branch.trim() ? state.branch.trim().slice(0, 80) : '';
  const synced = age ? `, synced ${age}` : '';
  const head = sha
    ? `index of ${branch || '?'}@${sha}${synced}`
    : movedFrom && movedTo
      ? `index of ${branch || '?'}@${movedFrom}..${movedTo}${synced} — HEAD moved during the sync, so files reflect either commit`
      : `index ${age ? `synced ${age}` : 'sync time unknown'} — branch/commit not recorded`;
  const n = indexedFileCount(state);
  const notes: string[] = [`${n.toLocaleString('en-US')} file${n === 1 ? '' : 's'}`];
  if (state.partial) notes.push('partial: the last sync hit its embed budget, so some files are older or not yet indexed');
  if (state.truncated) notes.push('the walk hit its file cap — some files were never listed');
  const errs = Number(state.listingErrors);
  if (Number.isFinite(errs) && errs > 0) notes.push(`the last walk could not read ${errs} entr${errs === 1 ? 'y' : 'ies'} — files there keep their last-synced rows`);
  // capHeld (written at state-write time) also counts the files the cap evicted
  // in that very sync, which capDeferred never saw; an older record carries only capDeferred.
  const held = Number(state.capHeld);
  const deferred = Number.isFinite(held) && held >= 0 && state.capHeld !== undefined ? held : Number(state.capDeferred);
  if (Number.isFinite(deferred) && deferred > 0) notes.push(`${deferred} file${deferred === 1 ? '' : 's'} not indexed — the project's code-row cap is full`);
  if (state.staleRefused) notes.push(`FROZEN — the last sync was refused by the stale-base gate (${state.staleReason || 'stale checkout'}): rows are older than "synced" reads`);
  return `[${head} · ${notes.join(' · ')}. It is a lane checkout, not necessarily main — treat hits as leads]`;
}

/** Who is asking — the parts of ToolContext the probe list depends on. */
export interface CodeSearchCaller {
  projectId?: string;
  sessionId: string;
  userId: string;
  surface: 'chat' | 'coding';
  /** True when the caller can call this tool name (role policy + surface + switches). */
  hasTool: (name: string) => boolean;
}

/** Tools that exist only on the coding surface (a chat run has no worktree or shell). */
const CODING_SURFACE_TOOLS: ReadonlySet<string> = new Set(['grep', 'glob', 'read_file', 'git_show', 'run_command']);

/**
 * hasTool for the probe list: the worker role policy (allowedTools), the
 * surface (chat runs have no worktree tools) and whether an integration tool
 * is in this process's schema (its switch). Pure.
 */
export function probeToolAvailable(
  name: string,
  c: { surface: 'chat' | 'coding'; allowedTools?: ReadonlySet<string>; integrationTool: (n: string) => boolean },
): boolean {
  if (c.allowedTools && !c.allowedTools.has(name)) return false;
  if (CODING_SURFACE_TOOLS.has(name)) return c.surface === 'coding';
  if (name.startsWith('github_')) return c.integrationTool(name);
  return true;
}

/**
 * The existence-capable probes THIS caller holds, most direct first. Never
 * names a tool the caller lacks (the old message sent the supervisor to
 * grep/glob it does not have).
 */
export function codeAbsenceProbes(c: {
  surface: 'chat' | 'coding';
  supervisor: boolean;
  hasTool: (name: string) => boolean;
  /** Which index the caller searched: a project supervisor asks one of its OWN project's lanes; the Fleet Supervisor (platform / no scope) the platform repo's lane. */
  scope?: 'project' | 'platform' | 'none';
}): string[] {
  const out: string[] = [];
  if (c.surface === 'coding') {
    const local = ['grep', 'glob', 'read_file'].filter(c.hasTool);
    if (local.length) out.push(`${local.join(' / ')} on this worktree (this session's branch)`);
    if (c.hasTool('git_show')) out.push('git_show {ref:"origin/<default branch>", path} for the file as it is on the default branch');
    else if (c.hasTool('run_command')) out.push('run_command `git show origin/<default branch>:<path>` for the file as it is on the default branch');
  }
  if (c.hasTool('github_get_file_contents')) out.push('github_get_file_contents {owner, repo, path} — reads the file on the default branch (needs a connected GitHub account)');
  if (c.hasTool('github_search_code')) out.push('github_search_code — GitHub\'s own index of the default branch (its 0 results can also mean "not indexed")');
  if (c.surface === 'chat') {
    if (c.supervisor && c.hasTool('send_chat_message')) {
      out.push(c.scope === 'project'
        ? 'send_chat_message to one of this project\'s coding lanes asking it to run `git show origin/<default branch>:<path>` (a lane reads the repository directly)'
        : 'send_chat_message to a coding lane in that repository\'s project (the Framework Operator lane for the platform repo) asking it to run `git show origin/main:<path>`');
    }
    if (c.hasTool('read_session_file')) out.push('read_session_file on a lane\'s worktree (that lane\'s branch, not main)');
  }
  return out;
}

function probeSentence(probes: string[]): string {
  if (!probes.length) return 'No direct code-reading tool is available in this run — say the code was NOT checked, never that it does not exist.';
  return `To check whether it exists, use: ${probes.map((p, i) => `(${i + 1}) ${p}`).join('; ')}.`;
}

export type NoIndexKind = 'chat_scope' | 'project_unindexed' | 'platform_unindexed';

/** The honest answer when there is no index to search — nothing was searched, so nothing was "not found". */
export function renderNoCodeIndex(kind: NoIndexKind, probes: string[], opts: { platformProjectName?: string } = {}): string {
  const lead = kind === 'chat_scope'
    ? 'NO CODE INDEX in this chat\'s scope — an ungrouped chat holds no repository index, so NOTHING was searched.'
    : kind === 'platform_unindexed'
      ? `NO CODE INDEX for the platform repository yet${opts.platformProjectName ? ` (project "${opts.platformProjectName}")` : ''} — it is built from a coding lane's checkout at run start, and none has been recorded, so NOTHING was searched.`
      : 'NO CODE INDEX for this project yet — it is built from a coding session\'s checkout at run start, and none has been recorded, so NOTHING was searched.';
  return `${lead} This is NOT evidence that the code does not exist. ${probeSentence(probes)}`;
}

/** The answer for a real index that matched nothing: not-found ≠ does-not-exist. */
export function renderNoCodeMatch(probes: string[], lines: { header?: string; freshness?: string } = {}): string {
  const head = [lines.header, lines.freshness].filter(Boolean).join('\n');
  const body = 'No indexed code matched THIS phrasing. Not found is NOT does-not-exist: the index can lag main, come from another branch, or miss a file, and the concept may live under different vocabulary — try once more with different words (what the code DOES). Before saying any code or feature does not exist, read it directly. '
    + probeSentence(probes);
  return head ? `${head}\n${body}` : body;
}

export interface PlatformProjectCandidate {
  id: string;
  name: string;
  repoUrl: string | null;
  state: CodeIndexStateView | null;
}

/**
 * Which of the owner's projects holds the platform repository's index: the
 * ones whose repoUrl normalizes to the instance's own repo slug, best index
 * first (most indexed files, then freshest sync). null when none names the
 * repo. Pure.
 */
export function pickPlatformIndexProject(candidates: PlatformProjectCandidate[], ownSlug: string): PlatformProjectCandidate | null {
  const slug = normalizeGithubRepoTarget(ownSlug || '');
  if (!slug) return null;
  const matching = candidates.filter(p => p.repoUrl && normalizeGithubRepoTarget(p.repoUrl) === slug);
  if (!matching.length) return null;
  const syncedAt = (p: PlatformProjectCandidate) => {
    const t = Date.parse(p.state?.lastSyncAt || '');
    return Number.isFinite(t) ? t : 0;
  };
  return [...matching].sort((a, b) => (indexedFileCount(b.state) - indexedFileCount(a.state)) || (syncedAt(b) - syncedAt(a)))[0];
}

export interface CodeSearchHit { ref?: string | null; content: string }

export interface CodeSearchDeps {
  search: (projectId: string, query: string, k: number) => Promise<CodeSearchHit[]>;
  /** The state row; null when it does not exist. A throw means "unknown" (fail open: search anyway). */
  readState: (projectId: string) => Promise<CodeIndexStateView | null>;
  /** supervisorChatFlag: true / false, null when unreadable. */
  isSupervisorChat: (chatId: string) => Promise<boolean | null>;
  /** The owner's live projects that carry a repoUrl. */
  listRepoProjects: (userId: string) => Promise<Array<{ id: string; name: string; repoUrl: string | null }>>;
  /** The instance's own repo slug ('' when none / refused). */
  ownRepoSlug: () => string;
  now?: () => number;
}

export interface CodeSearchOutcome {
  text: string;
  hits: number;
  /** none = nothing searched (no index in scope); project = the caller's project; platform = the platform repo's project. */
  scope: 'none' | 'project' | 'platform';
  searchedProjectId?: string;
  noIndex?: NoIndexKind;
}

/** At most this many repo-matching projects have their index state read when resolving the platform index. */
const PLATFORM_CANDIDATES_MAX = 5;

/**
 * Run search_code_semantic with honest scoping. Never throws on a lookup
 * failure (each degrades: unknown supervisor flag ⇒ not a supervisor,
 * unreadable state ⇒ search without a freshness line); only the search
 * itself may throw, exactly as before.
 */
export async function runCodeSemanticSearch(
  caller: CodeSearchCaller,
  query: string,
  deps: CodeSearchDeps,
  opts: { k?: number; cap?: (s: string) => string; freshness?: boolean } = {},
): Promise<CodeSearchOutcome> {
  const k = opts.k ?? 8;
  const cap = opts.cap ?? ((s: string) => s);
  const now = deps.now ? deps.now() : Date.now();
  let supervisor = false;
  let projectId = caller.projectId;
  let state: CodeIndexStateView | null | undefined;
  let header = '';
  let scope: 'project' | 'platform' = 'project';

  // A supervisor's ask-a-lane probe needs the flag; it is read only where it can
  // change the answer (a chat-surface caller about to get a no-index / miss
  // answer — a coding lane never holds the chat-only probes), at most once.
  let supervisorRead = false;
  const resolveSupervisor = async (): Promise<boolean> => {
    if (supervisorRead) return supervisor;
    supervisorRead = true;
    supervisor = caller.surface === 'chat' && (await deps.isSupervisorChat(caller.sessionId).catch(() => null)) === true;
    return supervisor;
  };

  if (isUngroupedChatScope(projectId)) {
    await resolveSupervisor();
    const probes = () => codeAbsenceProbes({ surface: caller.surface, supervisor, hasTool: caller.hasTool, scope: 'platform' });
    if (!supervisor) return { text: renderNoCodeIndex('chat_scope', probes()), hits: 0, scope: 'none', noIndex: 'chat_scope' };
    let slug = '';
    try { slug = deps.ownRepoSlug() || ''; } catch { slug = ''; }
    const projects = slug ? await deps.listRepoProjects(caller.userId).catch(() => []) : [];
    const norm = normalizeGithubRepoTarget(slug);
    const matching = norm ? projects.filter(p => p.repoUrl && normalizeGithubRepoTarget(p.repoUrl) === norm).slice(0, PLATFORM_CANDIDATES_MAX) : [];
    const withState: PlatformProjectCandidate[] = await Promise.all(matching.map(async p => ({
      ...p, state: await deps.readState(p.id).catch(() => null),
    })));
    const pick = pickPlatformIndexProject(withState, slug);
    if (!pick) return { text: renderNoCodeIndex('chat_scope', probes()), hits: 0, scope: 'none', noIndex: 'chat_scope' };
    if (!pick.state) return { text: renderNoCodeIndex('platform_unindexed', probes(), { platformProjectName: pick.name }), hits: 0, scope: 'none', noIndex: 'platform_unindexed' };
    projectId = pick.id;
    state = pick.state;
    scope = 'platform';
    header = `[searched the platform repository's code index — project "${pick.name}" (${pick.id.slice(0, 8)}); this chat has no index of its own]`;
  } else {
    try {
      state = await deps.readState(projectId as string);
    } catch {
      state = undefined; // unknown — search anyway, no freshness line
    }
    if (state === null) {
      // A PROJECT supervisor (a chat in its project) gets the same ask-a-lane
      // probe as the Fleet Supervisor — worded for its own project's lanes.
      await resolveSupervisor();
      return { text: renderNoCodeIndex('project_unindexed', codeAbsenceProbes({ surface: caller.surface, supervisor, hasTool: caller.hasTool, scope: 'project' })), hits: 0, scope: 'none', noIndex: 'project_unindexed' };
    }
  }

  const hits = await deps.search(projectId as string, query, k);
  const freshness = opts.freshness !== false ? renderCodeIndexFreshness(state, now) : '';
  if (!hits.length) {
    await resolveSupervisor();
    return {
      text: renderNoCodeMatch(codeAbsenceProbes({ surface: caller.surface, supervisor, hasTool: caller.hasTool, scope }), { header, freshness }),
      hits: 0, scope, searchedProjectId: projectId,
    };
  }
  const head = [header, freshness].filter(Boolean).join('\n');
  const body = hits.map((h, i) => `[${i + 1}] ${h.ref}\n${cap(h.content)}`).join('\n\n');
  return { text: head ? `${head}\n${body}` : body, hits: hits.length, scope, searchedProjectId: projectId };
}

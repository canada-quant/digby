/**
 * REPO SEMANTIC INDEX (Cerebras/CocoIndex-style) — language-aware embeddings
 * over a coding project's workspace, kept current INCREMENTALLY: per-file
 * content hashes are tracked in the context store, and on each sync only
 * changed files are re-embedded (memReplaceRef swaps a file's rows atomically
 * by ref). Rows live in the unified digby_memory store (scope: project,
 * source: 'code'), so `search_code_semantic` is just a scoped memSearch —
 * grep finds exact symbols; this finds code by MEANING ("where do we throttle
 * provisioning retries?") the way Cursor showed matters on large codebases.
 *
 * Sync triggers fire-and-forget at coding-run start, throttled per project.
 * Everything is best-effort — an index failure never touches the run.
 */

import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { storeGet, storePut, storeDelete } from '../memory/context-store';
import { memReplaceRef, memSearch, enforceScopeCap, memListRefStats, memArchiveRefs, memPurgeArchivedRefs, memPurgeArchivedRefsExcept, memDeleteRefs, worthEmbedding, MemHit } from '../memory/unified-memory.service';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { codeIndexWalkV2Disabled, codeIndexStaleBaseGuardDisabled, type CodeIndexStateView } from './code-search';

const execFileAsync = promisify(execFile);

const SYNC_THROTTLE_MS = 10 * 60 * 1000;   // at most one sync per project per 10 min
// 600 left ~40% of a mid-size repo (crossmodel itself: ~1,025 eligible files)
// permanently unindexed — whole subtrees silently invisible to
// search_code_semantic (owner 2026-09-04). The walk is cheap readdir work;
// embed cost stays bounded by MAX_CHANGED_PER_SYNC.
const MAX_FILES = 2500;                    // safety bound per sync walk (legacy walk, CODE_INDEX_WALK_V2_DISABLED=1)
// Walk v2 (fs-code-knowledge, 2026-10-22): the platform repo has ~3,500
// eligible files, so 2,500 left 29% never listed — and the reverse-alpha DFS
// starved whole subtrees (chat-agent/: 0 of 164). Listing is cheap readdir +
// stat work; the EMBED cost stays bounded by MAX_CHANGED_PER_SYNC.
const MAX_FILES_V2 = 6000;
const MAX_FILE_BYTES = 200 * 1024;         // skip generated monsters
const MAX_CHANGED_PER_SYNC = 150;          // embed at most N changed files per sync (rest next time)
const CHUNKS_PER_FILE = 20;
const PROJECT_CODE_CAP = 40_000;           // 'code'-source digby_memory rows per project scope
// The tiered cap reads one row per ref; a page this full is incomplete — the
// cap then plans over the page it has (whole files, hashes dropped), and the
// next sync reads again. The cap keeps the scope far below it (≤ 40k rows +
// one sync's ≤ 150 × 20 chunks).
const CODE_REF_STATS_LIMIT = 60_000;
// search_code_semantic reads the freshness view on every call (up to five
// projects for a supervisor): cache it per process; a sync in this process
// refreshes its own entry at once.
const STATE_VIEW_TTL_MS = 60_000;
const STATE_VIEW_CACHE_MAX = 500;
// The complete-listing archive backstop (round 4): at most once a day per
// project — the tracked sweep (state.files + state.capEvicted) purges every
// deletion it knows about at once; this only catches untracked archived copies.
const ARCHIVE_BACKSTOP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Vanished-file sweep (integration review 2026-10-23): refs per memDeleteRefs
// statement — the sweep is ONE hot DELETE + ONE archive purge per chunk, never
// two full-scope statements per file.
const SWEEP_DELETE_CHUNK = 500;

const DENY_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '__pycache__', '.venv', 'venv', 'target', '.turbo', 'out', '.cache']);
const EXT_LANG: Record<string, string | null> = {
  '.ts': 'js', '.tsx': 'js', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.rb': 'ruby',
  '.php': 'php', '.c': 'cpp', '.h': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'js',
  '.swift': 'swift', '.kt': 'js', '.scala': 'scala', '.md': 'markdown', '.html': 'html',
  '.sql': null, '.sh': null, '.yml': null, '.yaml': null, '.prisma': null, '.css': null,
  '.scss': null, '.vue': 'html', '.svelte': 'html', '.json': null,
};

interface CodeIndexState extends CodeIndexStateView {
  files: Record<string, string>; // relPath → sha1(content)
  lastSyncAt?: string;
  /** When the one-time repair of hashes the old generic cap pinned (a hash, no rows) completed — walk v2 only; a legacy sync drops it, so the repair re-runs after a v2 off → on flip. */
  pinRepairAt?: string;
  /**
   * Files the tiered row cap evicted (archived), relPath → sha1 of the content
   * evicted (review fix 2026-10-23 round 4). Dropping only the hash made an
   * evicted live file read as NEW: it re-embedded next sync, pushed the scope
   * over the cap again, and the cap evicted the next-oldest file — forever.
   * An entry with an UNCHANGED hash re-embeds only when the measured live rows
   * have room for it; changed content re-embeds. The vanished-file sweep walks
   * these too, so a deleted file's archived copy is purged. Walk v2 only; a
   * legacy sync drops it (it re-embeds the file anyway).
   */
  capEvicted?: Record<string, string>;
  /** When the complete-listing archive backstop last ran (state only; a legacy sync drops it). */
  archiveSweptAt?: string;
  /**
   * merge-base(HEAD, origin/<base>) of the checkout that produced this state
   * (stale-base gate, leg 2): the sweep of the NEXT sync may delete rows only
   * when its own anchor is at-or-ahead of this one. Absent on legacy / no-repo
   * syncs — then the next sweep keeps its pre-fix behaviour.
   */
  indexedAnchor?: string;
  /** The last sync was REFUSED by the stale-base gate (state + meta; see CodeIndexStateView.staleRefused). */
  staleRefused?: true;
  staleReason?: 'no_repo' | 'no_base' | 'base_unreadable' | 'stale_base' | 'clock_skew';
}

/** A walk-v2 listing. `listingErrors` > 0 ⇒ the listing is PARTIAL: some entries could not be read, so "not listed" never means "deleted". */
export interface CodeWalkResult {
  files: string[];
  truncated: boolean;
  /** readdir / stat failures (EACCES, EMFILE, an ENOENT race between readdir and stat …). */
  listingErrors: number;
  /** Failure count per error code ('UNKNOWN' when the error carried none). */
  errorCodes: Record<string, number>;
}

/**
 * Walk v2: BREADTH-FIRST over name-sorted entries, so a file cap starves the
 * deepest files across the whole tree instead of every top-level directory
 * that sorts early (the DFS popped siblings in reverse order and never reached
 * backend/…/chat-agent/). `truncated` says the cap cut the listing short —
 * the vanished-file sweep must then never treat "not listed" as "deleted".
 * Every unreadable directory (readdir) or file (stat) is COUNTED, never
 * silently skipped (review fix 2026-10-23: an EACCES subdirectory, an EMFILE
 * on the root or a file that vanished between readdir and stat read as a
 * complete listing, and the sweep evicted the live files under it).
 * Exported for tests.
 */
export async function walkCodeFilesBreadthFirst(root: string, maxFiles = MAX_FILES_V2): Promise<CodeWalkResult> {
  const out: string[] = [];
  const queue = [root];
  const errorCodes: Record<string, number> = {};
  let listingErrors = 0;
  const noteError = (err: unknown) => {
    listingErrors++;
    const code = typeof (err as any)?.code === 'string' && (err as any).code ? String((err as any).code) : 'UNKNOWN';
    errorCodes[code] = (errorCodes[code] || 0) + 1;
  };
  for (let qi = 0; qi < queue.length; qi++) {
    const dir = queue[qi];
    let entries: Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (err) { noteError(err); continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      // Hidden dirs AND hidden files are skipped (dotfiles carry secrets/noise).
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (!DENY_DIRS.has(e.name)) queue.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!(ext in EXT_LANG)) continue;
        if (ext === '.json' && !/^(package|tsconfig|composer)/.test(e.name)) continue; // data blobs out
        const full = path.join(dir, e.name);
        let size: number;
        try { size = (await fs.stat(full)).size; } catch (err) { noteError(err); continue; }
        if (size > MAX_FILE_BYTES) continue; // skip generated monsters
        if (out.length >= maxFiles) return { files: out, truncated: true, listingErrors, errorCodes };
        out.push(full);
      }
    }
  }
  return { files: out, truncated: false, listingErrors, errorCodes };
}

/** Test files embed last: the per-sync budget goes to the code itself first on a first build. */
export function isTestPath(rel: string): boolean {
  return /\.(test|spec)\.[^/\\]+$/i.test(rel) || /(^|[/\\])__tests__[/\\]/.test(rel);
}

/**
 * HEAD sha + branch of the checkout the index is built from — the index's
 * provenance (it reads a lane worktree, not main). Best-effort: no git, not a
 * repo, or a timeout ⇒ {}. Discovery is fenced at the checkout root so a
 * plain directory nested inside another repo never reports the outer one.
 * Exported for tests.
 */
export async function readGitHead(root: string): Promise<{ sha?: string; branch?: string }> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(root)),
    // Worktrees on the shared volume can be owned by a container user.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
  };
  const run = async (args: string[]) => (await execFileAsync('git', args, { cwd: root, env, timeout: 5000 })).stdout.toString().trim();
  try {
    const sha = await run(['rev-parse', 'HEAD']);
    if (!/^[0-9a-f]{40}$/.test(sha)) return {};
    let branch = '';
    try { branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { branch = ''; }
    return { sha, branch: branch === 'HEAD' ? 'detached' : branch || undefined };
  } catch {
    return {};
  }
}

/**
 * The provenance a sync may claim: the commit read BEFORE the walk must still
 * be HEAD after the last file read (review fix 2026-10-23: the sha was read
 * once up front while a lane kept committing during the embed loop, so the
 * line named a commit some indexed files did not come from). Moved ⇒ no
 * single sha, the range is recorded instead. Pure; exported for tests.
 */
export function headProvenance(before: { sha?: string; branch?: string }, after: { sha?: string; branch?: string }): Pick<CodeIndexStateView, 'indexedSha' | 'branch' | 'headMovedFrom' | 'headMovedTo'> {
  const branch = before.branch && before.branch === after.branch ? before.branch : undefined;
  if (before.sha && before.sha === after.sha) return { indexedSha: before.sha, ...(branch ? { branch } : {}) };
  if (!before.sha && !after.sha) return {};
  return { ...(branch ? { branch } : {}), ...(before.sha ? { headMovedFrom: before.sha } : {}), ...(after.sha ? { headMovedTo: after.sha } : {}) };
}

/**
 * How far a checkout's base may lag the default branch before its syncs stop
 * WRITING the shared index (stale-base gate, 2026-10-23). Lane worktrees
 * legitimately run a base behind — one squash-merge lands mid-run and the
 * next sync still wants a full pass — but a lane that sits for weeks is a
 * stale vantage: its files map pins a dead tree, and its complete listing
 * purges every newer file's rows. 14 days holds both (reviewed: infra-fix
 * lanes had bases ~1.5 days old on 2026-10-22; the stale class — a
 * month-old lane — clusters at 30+ days).
 */
export const STALE_BASE_MAX_BEHIND_MS = 14 * 24 * 60 * 60 * 1000;

/** What the stale-base gate decided about a checkout. */
export interface StaleBaseDecision {
  /** The checkout's base is near enough to the default branch to write the shared index. */
  allowed: boolean;
  /** Names the refusing leg ('no_repo' / 'no_base' allow by fallback — reason kept for the metric). */
  reason?: 'no_repo' | 'no_base' | 'base_unreadable' | 'stale_base' | 'clock_skew';
  /** The branch the base was resolved from (origin/<branch> in the shared mirror). */
  baseBranch?: string;
  /** The sha that branch holds in the mirror right now. */
  baseSha?: string;
  /** merge-base(HEAD, baseSha) — the commit the checkout was actually created from. */
  mergeBaseSha?: string;
  /** Age of that merge-base (the checkout's own HEAD when no origin refs exist). */
  baseAgeMs?: number;
  /** HEAD's commit time, when readable. */
  headCommitMs?: number;
  gate: 'default' | 'legacy';
}

/**
 * Stale-base gate: a checkout may update AND delete the project's shared
 * index rows only while its BASE is near the default branch. The staleness
 * metric is the AGE OF merge-base(HEAD, origin/<baseBranch>) — the commit the
 * checkout was created from — which behaves under every merge shape:
 *   - a fresh lane, base == main tip → merge-base is that tip (age ≈ 0);
 *   - a fresh lane with its own commits, main advanced by a squash-merge
 *     (never a fast-forward) → merge-base is still the creation base (≈ days);
 *   - a month-old lane, however many commits it made since → merge-base is
 *     the month-old base → refused.
 * A worktree shares the project mirror's refs, so origin/<branch> names the
 * live tip whatever the lane has since committed. No origin refs at all (a
 * Digby-owned local-mirror project, an init-only repo) fall back to the age
 * of the checkout's own HEAD — an active local project commits recently; a
 * plain directory or an unborn repo (no HEAD) has no lineage to be stale and
 * is allowed fail-open. Reads never throw; every git failure is a decision.
 */
export async function decideStaleBase(root: string, opts?: { baseBranch?: string | null; nowMs?: number }): Promise<StaleBaseDecision> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(root)),
    // Worktrees on the shared volume can be owned by a container user.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
  };
  const run = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', args, { cwd: root, env, timeout: 5000 });
      return stdout.toString();
    } catch { return null; }
  };
  const commitMsOf = async (sha: string): Promise<number | undefined> => {
    const c = await run(['show', '-s', '--format=%ct', sha]);
    const n = c ? Number(c.trim()) : NaN;
    return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
  };
  const nowMs = opts?.nowMs ?? Date.now();
  const head = await run(['rev-parse', 'HEAD']);
  if (!head || !/^[0-9a-f]{40}$/.test(head.trim())) {
    // No HEAD: a plain directory, an unborn branch, or no git at all — nothing
    // in git terms can be stale, and standalone/test trees must keep syncing.
    return { allowed: true, reason: 'no_repo', gate: 'default' };
  }
  const headSha = head.trim();
  const headCommitMs = await commitMsOf(headSha);
  // Base candidates: the session's base branch under origin/…, then every
  // origin ref the remote tracks (the layout demoteMirrorRefspec keeps), main
  // first — a checkout with no baseBranch still resolves a base.
  const wanted = (opts?.baseBranch || '').replace(/^refs\/heads\//, '');
  const candidates: Array<{ branch: string; sha: string }> = [];
  if (wanted) {
    const direct = await run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${wanted}`]);
    if (direct && /^[0-9a-f]{40}$/.test(direct.trim())) candidates.push({ branch: wanted, sha: direct.trim() });
  }
  const tracked = await run(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/remotes/origin/']);
  if (tracked) {
    const rows = tracked.trim().split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const sp = l.indexOf(' ');
      return { branch: l.slice(0, sp), sha: l.slice(sp + 1).trim() };
    }).filter(r => /^[0-9a-f]{40}$/.test(r.sha));
    rows.sort((a, b) => (a.branch === 'main' ? -1 : b.branch === 'main' ? 1 : a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0));
    for (const r of rows) if (!candidates.some(c => c.branch === r.branch)) candidates.push({ branch: r.branch, sha: r.sha });
  }
  // No origin ref anywhere (a local-mirror project, an init-only repo): the
  // checkout's own HEAD age is the freshness proxy — fail-open on an
  // unreadable commit time (never freeze an index over a clock read).
  if (!candidates.length) {
    if (headCommitMs === undefined) return { allowed: true, reason: 'no_base', gate: 'default' };
    const baseAgeMs = Math.max(0, nowMs - headCommitMs);
    return {
      allowed: baseAgeMs <= STALE_BASE_MAX_BEHIND_MS,
      reason: baseAgeMs <= STALE_BASE_MAX_BEHIND_MS ? 'no_base' : 'stale_base',
      mergeBaseSha: headSha, baseAgeMs, headCommitMs, gate: 'default',
    };
  }
  const base = candidates[0];
  const mbRaw = await run(['merge-base', headSha, base.sha]);
  const mbSha = mbRaw && /^[0-9a-f]{40}$/.test(mbRaw.trim()) ? mbRaw.trim() : null;
  // Unrelated histories (the base shares nothing with HEAD): fall back to the
  // HEAD-age proxy rather than guessing.
  const anchorSha = mbSha ?? headSha;
  const anchorMs = await commitMsOf(anchorSha);
  if (anchorMs === undefined) {
    // A commit time the checkout cannot name (corrupt object, odd clock): a
    // base exists but its age is unreadable — refuse rather than trust it.
    return { allowed: false, reason: 'clock_skew', baseBranch: base.branch, baseSha: base.sha, gate: 'default', ...(headCommitMs !== undefined ? { headCommitMs } : {}) };
  }
  const baseAgeMs = Math.max(0, nowMs - anchorMs);
  const allowed = baseAgeMs <= STALE_BASE_MAX_BEHIND_MS;
  return {
    allowed,
    reason: allowed ? undefined : 'stale_base',
    baseBranch: base.branch,
    baseSha: base.sha,
    mergeBaseSha: mbSha ?? headSha,
    baseAgeMs,
    ...(headCommitMs !== undefined ? { headCommitMs } : {}),
    gate: 'default',
  };
}

/** Shared read-only git env for provenance / staleness probes of a checkout (safe.directory for container-owned worktrees). */
function gitProbeEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(root)),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
  };
}
async function runGitProbe(args: string[], root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: root, env: gitProbeEnv(root), timeout: 5000 });
    return stdout.toString();
  } catch { return null; }
}

/**
 * ANCHOR lineage guard for the destructive sweep (stale-base gate, leg 2):
 * a sync may DELETE / ARCHIVE-PURGE index rows only when the BASE ANCHOR of
 * the checkout it reads is at-or-ahead-of the anchor the index was last
 * synced from — merge-base(HEAD, origin/<base>) on main's line. Comparing
 * anchors (not the syncing lane's tip) is what makes it correct across
 * lanes: every fresh lane's anchor sits on main's first-parent line, so a
 * newer anchor CONTAINS the older recorded one (`--is-ancestor`), while a
 * month-old checkout's anchor never covers a newer recorded anchor — its
 * "complete listing" speaks for a dead tree and must not purge newer files'
 * rows (the prod incident). Either anchor missing / unreadable (a legacy
 * state, the guard switched off, git unable to decide) reads 'unknown' and
 * the sweep keeps its pre-fix behaviour — the 14-day base window (leg 1)
 * already bounds that case. Never throws.
 */
export async function anchorCoversRecorded(
  root: string,
  recordedAnchor: string | null | undefined,
  currentAnchor: string | null | undefined,
): Promise<'covers' | 'unknown' | 'foreign'> {
  if (!recordedAnchor || !currentAnchor) return 'unknown';
  if (!/^[0-9a-f]{40}$/.test(recordedAnchor) || !/^[0-9a-f]{40}$/.test(currentAnchor)) return 'unknown';
  if (recordedAnchor === currentAnchor) return 'covers';
  const res = await runGitProbe(['merge-base', '--is-ancestor', recordedAnchor, currentAnchor], root);
  // exit 0 = ancestor ⇒ covers; exit 1 = not an ancestor ⇒ foreign (a git
  // crash reads null too, but two valid 40-hex shas already prove git works
  // here — and the 14-day leg bounds a wrong 'foreign' to a skipped sweep).
  return res === null ? 'foreign' : 'covers';
}

/** The freshness view of a full state row: every field but the files map (and the cap-evicted map and the repair / backstop markers), plus its count. */
function summariseCodeIndexState(state: CodeIndexState): CodeIndexStateView {
  const { files, pinRepairAt: _repair, capEvicted: _evicted, archiveSweptAt: _swept, ...rest } = state;
  // The stale-refusal marker rides through to the meta record (a frozen index
  // must not read as fresh): the destructuring above keeps it in `rest`.
  return { ...rest, fileCount: files && typeof files === 'object' ? Object.keys(files).length : 0 };
}

const stateViewCache = new Map<string, { at: number; view: CodeIndexStateView | null }>();
function cacheStateView(projectId: string, view: CodeIndexStateView | null): void {
  if (stateViewCache.size >= STATE_VIEW_CACHE_MAX) stateViewCache.clear();
  stateViewCache.set(projectId, { at: Date.now(), view });
}
// A permanently unreadable directory (a container-owned data/ in a lane
// checkout) makes EVERY walk report listing errors: warn once per project per
// process (warn rows land in app_error_logs), debug after — the index_swept
// row of every pass carries the count.
const listingErrorWarned = new Set<string>();
/** Tests: forget every cached freshness view and the per-process warn dedupe. */
export function resetCodeIndexStateCache(): void {
  stateViewCache.clear();
  listingErrorWarned.clear();
}

/**
 * The project's index FRESHNESS view; null when no sync ever ran. Throws on a
 * store failure (callers decide; a failure is never cached).
 *
 * Walk v2 reads only the small `meta` record a sync writes beside the state
 * (review fix 2026-10-23: every search_code_semantic call read the whole
 * state row — a path → sha1 map of up to 6,000 files, for up to five
 * projects on a supervisor's call), cached per process for 60 s. A legacy
 * row with no meta yet is read once and summarised. CODE_INDEX_WALK_V2_DISABLED=1
 * reads the full state row (no meta is maintained under it).
 */
export async function readCodeIndexState(projectId: string): Promise<CodeIndexStateView | null> {
  if (codeIndexWalkV2Disabled()) return (await storeGet<CodeIndexState>([projectId, 'code-index'], 'state')) || null;
  const hit = stateViewCache.get(projectId);
  if (hit && Date.now() - hit.at < STATE_VIEW_TTL_MS) return hit.view;
  const meta = await storeGet<CodeIndexStateView>([projectId, 'code-index'], 'meta');
  let view: CodeIndexStateView | null = meta || null;
  if (!view) {
    const legacy = await storeGet<CodeIndexState>([projectId, 'code-index'], 'state');
    view = legacy ? summariseCodeIndexState(legacy) : null;
  }
  cacheStateView(projectId, view);
  return view;
}

/** One ref's rows as the tiered cap sees them. */
export interface CodeRefStat { ref: string; rows: number; newestMs: number }
export type CodeCapTier = 'orphan' | 'test' | 'code';
export interface CodeCapPlan {
  /** Whole files to evict, in eviction order. */
  evict: Array<{ ref: string; rows: number; tier: CodeCapTier }>;
  rowsBefore: number;
  rowsAfter: number;
}

/**
 * Which files the per-project code-row cap evicts (review fix 2026-10-23).
 * The generic oldest-first scope cap evicted the STABLE core files first and
 * their hashes stayed in the state, so they were never re-embedded. Now, whole
 * files at a time until the scope fits: rows the index state no longer knows
 * (vanished / deleted / orphaned refs) first, then test files, then live code;
 * oldest-embedded first within a tier (ref name breaks ties). Pure; exported
 * for tests.
 */
export function planCodeIndexCapEviction(stats: CodeRefStat[], cap: number, isLive: (ref: string) => boolean): CodeCapPlan {
  const rowsBefore = stats.reduce((sum, s) => sum + Math.max(0, s.rows || 0), 0);
  const limit = Math.max(0, Math.floor(cap));
  if (rowsBefore <= limit) return { evict: [], rowsBefore, rowsAfter: rowsBefore };
  const tierOf = (ref: string): CodeCapTier => (!isLive(ref) ? 'orphan' : isTestPath(ref) ? 'test' : 'code');
  const rank: Record<CodeCapTier, number> = { orphan: 0, test: 1, code: 2 };
  const ordered = stats
    .map(s => ({ ...s, tier: tierOf(s.ref) }))
    .sort((a, b) => (rank[a.tier] - rank[b.tier]) || (a.newestMs - b.newestMs) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const evict: CodeCapPlan['evict'] = [];
  let rows = rowsBefore;
  for (const s of ordered) {
    if (rows <= limit) break;
    evict.push({ ref: s.ref, rows: s.rows, tier: s.tier });
    rows -= Math.max(0, s.rows || 0);
  }
  return { evict, rowsBefore, rowsAfter: rows };
}

/** State keys by stored ref (memStore truncates refs to 400 chars). */
function liveRefKeys(state: CodeIndexState): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const k of Object.keys(state.files)) {
    const ref = k.slice(0, 400);
    const list = out.get(ref);
    if (list) list.push(k); else out.set(ref, [k]);
  }
  return out;
}

/** The live rows the row cap has to share: the total, and per stored ref so a later replacement adjusts it exactly. */
interface LiveCodeRows { total: number; byRef: Map<string, number> }

/** Rows of the files the state knows (orphans and still-hot cap-evicted refs excluded — the cap takes them first or again); null when unmeasurable. */
async function measureLiveCodeRows(projectId: string, state: CodeIndexState): Promise<LiveCodeRows | null> {
  let stats: CodeRefStat[] | null = null;
  try { stats = await memListRefStats({ type: 'project', id: projectId }, 'code', CODE_REF_STATS_LIMIT); } catch { stats = null; }
  if (!stats || stats.length >= CODE_REF_STATS_LIMIT) return null;
  const live = liveRefKeys(state);
  const byRef = new Map<string, number>();
  let total = 0;
  for (const st of stats) {
    if (!live.has(st.ref)) continue;
    const rows = Math.max(0, st.rows || 0);
    byRef.set(st.ref, rows);
    total += rows;
  }
  return { total, byRef };
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      // Hidden dirs AND hidden files are skipped (dotfiles carry secrets/noise).
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!DENY_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!(ext in EXT_LANG)) continue;
        if (ext === '.json' && !/^(package|tsconfig|composer)/.test(e.name)) continue; // data blobs out
        try { if ((await fs.stat(full)).size > MAX_FILE_BYTES) continue; } catch { continue; }
        out.push(full);
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

async function chunkFile(relPath: string, content: string): Promise<string[]> {
  const lang = EXT_LANG[path.extname(relPath).toLowerCase()];
  const splitter = lang
    ? RecursiveCharacterTextSplitter.fromLanguage(lang as any, { chunkSize: 1400, chunkOverlap: 120 })
    : new RecursiveCharacterTextSplitter({ chunkSize: 1400, chunkOverlap: 120 });
  const docs = await splitter.createDocuments([content]);
  return docs.slice(0, CHUNKS_PER_FILE).map(d => d.pageContent);
}

/**
 * Incrementally sync a project's code index from a checkout on disk.
 * Returns counts; never throws.
 */
const inFlightSyncs = new Set<string>(); // in-process guard: one sync per project at a time

export async function syncCodeIndex(projectId: string, repoRoot: string, opts?: { force?: boolean; userId?: string; maxFiles?: number; rowCap?: number; baseBranch?: string | null }): Promise<{ changed: number; removed: number; skipped: boolean }> {
  if (inFlightSyncs.has(projectId)) return { changed: 0, removed: 0, skipped: true };
  inFlightSyncs.add(projectId);
  try {
    const state = (await storeGet<CodeIndexState>([projectId, 'code-index'], 'state')) || { files: {} };
    if (!opts?.force && state.lastSyncAt && Date.now() - new Date(state.lastSyncAt).getTime() < SYNC_THROTTLE_MS) {
      return { changed: 0, removed: 0, skipped: true };
    }
    // Stamp the throttle FIRST so a cross-process concurrent run-start won't double-sync.
    await storePut([projectId, 'code-index'], 'state', { ...state, lastSyncAt: new Date().toISOString() } as any);

    const v2 = !codeIndexWalkV2Disabled();
    const staleGuard = v2 && !codeIndexStaleBaseGuardDisabled();
    // Stale-base gate (2026-10-23): a checkout far from its base branch must
    // not write the SHARED index — a month-old lane worktree's "complete
    // listing" purges every newer file's rows, and its files map pins a dead
    // tree. Walk v2 made this live at scale (the 2,500-file cap previously
    // turned every real repo's walk partial, so the sweep never fired); the
    // walk is now a full listing, so the gate sits here instead.
    let stale: StaleBaseDecision | null = null;
    if (staleGuard) {
      stale = await decideStaleBase(repoRoot, { baseBranch: opts?.baseBranch });
      if (!stale.allowed) {
        const ageDays = stale.baseAgeMs != null && Number.isFinite(stale.baseAgeMs) ? ` (base ${Math.round(stale.baseAgeMs / 86_400_000)}d old)` : '';
        logger.warn(`code-index: project ${projectId} sync REFUSED — ${stale.reason}${ageDays}${stale.baseBranch ? `, base ${stale.baseBranch}@${stale.baseSha?.slice(0, 7)}` : ''}; index rows untouched (CODE_INDEX_STALE_BASE_GUARD_DISABLED=1 restores the old behaviour)`);
        // Record the refusal on the freshness view: the index is FROZEN at an
        // older tree, and a search answer must not read lastSyncAt as fresh.
        const refusedState: CodeIndexState = {
          ...state,
          lastSyncAt: new Date().toISOString(),
          staleRefused: true,
          staleReason: stale.reason,
        };
        try {
          await storePut([projectId, 'code-index'], 'state', refusedState as any);
          const meta = summariseCodeIndexState(refusedState);
          await storePut([projectId, 'code-index'], 'meta', meta as any);
          cacheStateView(projectId, meta);
        } catch { /* best-effort; the rows are what matters */ }
        const metaRow: any = {
          index: 'code', projectId, refused: true, reason: stale.reason, ...(stale.baseBranch ? { baseBranch: stale.baseBranch } : {}), ...(stale.baseSha ? { baseSha: stale.baseSha } : {}),
          ...(stale.baseAgeMs != null && Number.isFinite(stale.baseAgeMs) ? { baseAgeDays: Math.round(stale.baseAgeMs / 86_400_000) } : {}),
        };
        recordLoopMetric({ kind: LOOP_METRIC_KINDS.INDEX_SWEPT, value: 0, meta: metaRow });
        return { changed: 0, removed: 0, skipped: true };
      }
    }
    const scope = { type: 'project' as const, id: projectId };
    const rowCap = opts?.rowCap ?? PROJECT_CODE_CAP;
    // v2: breadth-first full LISTING (the embed budget below never shortens it),
    // test files embedded after the code they test; HEAD is read from this same
    // checkout right before the walk and again after the last file read.
    const headBefore = v2 ? await readGitHead(repoRoot) : {};
    const walk: CodeWalkResult = v2
      ? await walkCodeFilesBreadthFirst(repoRoot, opts?.maxFiles ?? MAX_FILES_V2)
      : { files: await walkFiles(repoRoot), truncated: false, listingErrors: 0, errorCodes: {} };
    const files = v2
      ? [...walk.files.filter(f => !isTestPath(path.relative(repoRoot, f))), ...walk.files.filter(f => isTestPath(path.relative(repoRoot, f)))]
      : walk.files;
    const listed = new Set(files.map(f => path.relative(repoRoot, f)));
    let removed = 0;
    let sweepKept = 0;
    let archivePurged = 0;
    let archiveSweptAt: string | undefined = v2 ? state.archiveSweptAt : undefined;
    // Files the tiered cap evicted (round 4), relPath → content hash at
    // eviction. An entry the state also holds as a live file is stale.
    const capEvicted: Record<string, string> = {};
    if (v2 && state.capEvicted && typeof state.capEvicted === 'object') {
      for (const [rel, h] of Object.entries(state.capEvicted)) {
        if (typeof h === 'string' && !Object.prototype.hasOwnProperty.call(state.files, rel)) capEvicted[rel] = h;
      }
    }
    if (v2) {
      // Vanished-file sweep from the LISTING, independent of the embed budget
      // (the legacy sweep never ran on the platform repo: its walk always hit
      // the cap, so deleted / renamed files' rows stayed forever). A complete
      // listing is authoritative. A PARTIAL one — capped, or with ANY read
      // error (EACCES, EMFILE, an ENOENT race) — evicts an unlisted file only
      // when fs.stat proves it gone (ENOENT / ENOTDIR): a live file beyond the
      // cap or under an unreadable directory keeps its rows, a real deletion
      // anywhere else is still swept (review fix 2026-10-23, round 3: skipping
      // the whole sweep on a listing error turned it off for good in a checkout
      // with a permanently unreadable directory). It runs before the embed loop
      // so the cap's headroom check below already sees the freed rows.
      if (walk.listingErrors > 0) {
        const codes = Object.entries(walk.errorCodes).map(([c, n]) => `${c}×${n}`).join(', ');
        const line = `code-index: project ${projectId} walk could not read ${walk.listingErrors} entr${walk.listingErrors === 1 ? 'y' : 'ies'} (${codes}) — unlisted files are evicted only when stat proves them gone`;
        if (listingErrorWarned.has(projectId)) {
          logger.debug(line);
        } else {
          if (listingErrorWarned.size >= STATE_VIEW_CACHE_MAX) listingErrorWarned.clear();
          listingErrorWarned.add(projectId);
          logger.warn(`${line} (logged once per project per process; every pass counts on index_swept)`);
        }
      }
      const partialListing = walk.truncated || walk.listingErrors > 0;
      const provenGone = async (rel: string): Promise<boolean> => {
        if (!partialListing) return true;
        try { await fs.stat(path.join(repoRoot, rel)); return false; } catch (err: any) { return err?.code === 'ENOENT' || err?.code === 'ENOTDIR'; }
      };
      // ANCHOR lineage guard (stale-base gate, leg 2): the sweep DELETES
      // rows, so it runs only when this checkout's base anchor is at-or-ahead
      // of the anchor recorded at the index's last sync. Unknown lineage (a
      // legacy / bootstrap state, no anchor readable) keeps the pre-fix
      // behaviour — leg 1's 14-day base window already bounds that case.
      const recordedAnchor = typeof state.indexedAnchor === 'string' && /^[0-9a-f]{40}$/.test(state.indexedAnchor) ? state.indexedAnchor : null;
      const currentAnchor = stale?.mergeBaseSha && /^[0-9a-f]{40}$/.test(stale.mergeBaseSha) ? stale.mergeBaseSha : null;
      const lineage = staleGuard
        ? await anchorCoversRecorded(repoRoot, recordedAnchor, currentAnchor)
        : 'unknown' as const;
      const sweepAllowed = lineage === 'covers' || lineage === 'unknown';
      const goneFiles: string[] = [];
      if (sweepAllowed) {
        for (const rel of Object.keys(state.files)) {
          if (listed.has(rel)) continue;
          if (!(await provenGone(rel))) { sweepKept++; continue; }
          goneFiles.push(rel);
        }
      }
      // A file the cap ARCHIVED is in no files map the sweep above reads
      // (review fix 2026-10-23 round 4): deleted from the checkout, its
      // archived copy resurfaced in search_memory's cold leg for up to 365
      // days. Same rule — gone ⇒ a real deletion (hot rows, if a move never
      // happened, and every archived copy).
      const goneEvicted: string[] = [];
      for (const rel of Object.keys(capEvicted)) {
        if (listed.has(rel)) continue;
        if (!(await provenGone(rel))) { sweepKept++; continue; }
        goneEvicted.push(rel);
      }
      // Both swept in BATCHES (integration review 2026-10-23: a vanished file
      // was two full-scope statements, unbounded, on the IOPS-bound RDS) —
      // memDeleteRefs is one hot DELETE + one archive purge per chunk, and
      // never throws — like the per-file memReplaceRef(…, []) it replaces.
      const gone = [...goneFiles, ...goneEvicted];
      for (let i = 0; i < gone.length; i += SWEEP_DELETE_CHUNK) await memDeleteRefs(scope, 'code', gone.slice(i, i + SWEEP_DELETE_CHUNK));
      for (const rel of goneFiles) delete state.files[rel];
      for (const rel of goneEvicted) delete capEvicted[rel];
      removed += gone.length;
      // Backstop (round 4), COMPLETE listings only, at most once a day: an
      // archived copy of a file the listing does not hold is deleted content
      // — an untracked one (a legacy-era eviction, a purge that failed above).
      // ONE statement; a failure retries next pass.
      const sweptMs = archiveSweptAt ? Date.parse(archiveSweptAt) : NaN;
      if (!partialListing && !(Date.now() - sweptMs < ARCHIVE_BACKSTOP_INTERVAL_MS)) {
        const n = await memPurgeArchivedRefsExcept(scope, 'code', [...listed]);
        if (n !== null) { archivePurged = n; archiveSweptAt = new Date().toISOString(); }
      }
    }
    // One-time repair (v2, review fix 2026-10-23 round 3) of hashes the OLD
    // generic oldest-row cap pinned: it evicted rows and kept the file's hash,
    // so the file was never re-embedded until it changed. A state file with no
    // hot rows behind it is a candidate; the embed loop below re-runs the
    // store's own quality gate on its unchanged content (no embed call) and
    // drops the pin only when the file would store rows — a file gated as
    // trivial keeps its hash (no re-embed churn). Marked done once a pass
    // visited every listed file; an unreadable ref listing retries next sync.
    let repairCandidates: Set<string> | null = null;
    let repairDone = false;
    let pinRepaired = 0;
    if (v2 && !state.pinRepairAt) {
      const keys = Object.keys(state.files);
      if (!keys.length) {
        repairDone = true;
      } else {
        let stats: CodeRefStat[] | null = null;
        try { stats = await memListRefStats(scope, 'code', CODE_REF_STATS_LIMIT); } catch { stats = null; }
        if (stats && stats.length < CODE_REF_STATS_LIMIT) {
          const hot = new Set(stats.filter(st => (st.rows || 0) > 0).map(st => st.ref));
          repairCandidates = new Set(keys.filter(k => !hot.has(k.slice(0, 400))));
        }
      }
    }
    const seen = new Set<string>();
    let changed = 0;
    let brokeEarly = false;
    // A pin candidate deferred for cap room keeps its pin AND keeps the repair
    // alive: pinRepairAt must not land while candidates still wait for room
    // (review D1 follow-up, 2026-10-23 — else they stay hash-pinned and
    // row-less forever, the exact state the repair exists to clear).
    let repairDeferred = 0;
    // Row-cap headroom (v2): measured lazily, once, at the first file that
    // needs it, then kept exact as files are replaced. A file the cap evicted
    // whose content is UNCHANGED since (state.capEvicted) re-embeds only when
    // the live rows have room for it — unmeasurable ⇒ held (review fix
    // 2026-10-23 round 4: it re-embedded unconditionally, pushed the scope
    // over the cap again, and the cap evicted the next-oldest file — an
    // endless loop of up to 150 re-embeds per sync once live code alone
    // exceeded the cap). A test file the index does not hold waits for room
    // too (unmeasurable ⇒ embed, as before). Changed content of an evicted
    // file and a genuinely new code file embed; the cap then evicts the
    // oldest, which is held from then on. undefined = not measured yet.
    let live: LiveCodeRows | null | undefined;
    let capDeferred = 0;
    // New test files (never in the index) the cap had no room for — with the
    // cap-evicted map, the files OUT of the hot index (capHeld, below).
    let capDeferredNew = 0;
    const embedded: string[] = [];
    for (const full of files) {
      if (changed >= MAX_CHANGED_PER_SYNC) { brokeEarly = true; break; }
      const rel = path.relative(repoRoot, full);
      seen.add(rel);
      let content = '';
      try { content = await fs.readFile(full, 'utf8'); } catch { continue; }
      if (!content.trim()) continue;
      const hash = crypto.createHash('sha1').update(content).digest('hex');
      const unchanged = state.files[rel] === hash;
      if (unchanged && !repairCandidates?.has(rel)) continue;
      const capHeld = v2 && capEvicted[rel] === hash;
      if (capHeld) {
        if (live === undefined) live = await measureLiveCodeRows(projectId, state);
        if (!live || live.total >= rowCap) { capDeferred++; continue; } // no room even for one row: skip the chunking
      }
      const chunks = await chunkFile(rel, content);
      if (unchanged) {
        // A pin candidate (hash, no rows): trivially gated content keeps its pin.
        if (!chunks.some(c => worthEmbedding(c))) continue;
        // A candidate has no hot rows by construction, so the TEST-TIER room
        // check applies to it directly — WITHOUT dropping the pin first
        // (review D1, 2026-10-23: the delete used to sit here, so a test
        // candidate deferred for room lost its hash with no rows stored, and
        // the next sync re-embeded it as a "new" file past the room check).
        if (v2 && isTestPath(rel)) {
          if (live === undefined) live = await measureLiveCodeRows(projectId, state);
          if (live && live.total + chunks.length > rowCap) {
            capDeferred++;
            repairDeferred++;
            if (!Object.prototype.hasOwnProperty.call(capEvicted, rel)) capDeferredNew++;
            continue;
          }
        }
      }
      const known = Object.prototype.hasOwnProperty.call(state.files, rel);
      if (capHeld) {
        if (live && live.total + chunks.length > rowCap) { capDeferred++; continue; }
      } else if (v2 && !known && isTestPath(rel)) {
        if (live === undefined) live = await measureLiveCodeRows(projectId, state);
        if (live && live.total + chunks.length > rowCap) {
          capDeferred++;
          if (!Object.prototype.hasOwnProperty.call(capEvicted, rel)) capDeferredNew++;
          continue;
        }
      }
      const n = await memReplaceRef(
        scope, 'code', rel,
        chunks.map((c, i) => ({ title: `${rel}${chunks.length > 1 ? ` (part ${i + 1})` : ''}`, content: c })),
        // cap enforced ONCE per sync below; userId = provenance stamp (memory
        // unification 2026-09-14 — reads are gated by project scope, not by it)
        { maxChunks: CHUNKS_PER_FILE, skipCap: true, ...(opts?.userId ? { userId: opts.userId } : {}) }
      );
      // Record the hash even when nothing was stored (content gated as trivial):
      // otherwise the file is deleted-and-retried on every sync forever. Known
      // tradeoff: an embed outage stores keyword-only rows and the hash pins
      // them until the file next changes — FTS still finds them, so recall
      // degrades rather than breaks.
      state.files[rel] = hash;
      delete capEvicted[rel];
      if (unchanged) pinRepaired++;
      changed++;
      embedded.push(rel);
      if (live) {
        // byRef holds exactly the rows the total counts for this ref (0 for a file the state did not know).
        const refKey = rel.slice(0, 400);
        const stored = Math.max(0, Number(n) || 0);
        live.total += stored - (live.byRef.get(refKey) ?? 0);
        live.byRef.set(refKey, stored);
      }
    }
    if (repairCandidates && !brokeEarly && !repairDeferred) repairDone = true;
    // A re-embedded file is back in the hot tier: an archived copy of it (the
    // cap moved it there earlier) is a stale version — purge it so the archive
    // holds only files that are out of the hot tier. One statement per sync.
    if (v2 && embedded.length) await memPurgeArchivedRefs(scope, 'code', embedded);
    if (!v2 && !brokeEarly && files.length < MAX_FILES) {
      // Remove rows for files that vanished from the tree — but ONLY when this
      // sync saw the complete tree. After an early break (changed-file budget or
      // walk cap), unvisited files are absent from `seen` while still on disk;
      // sweeping then would wrongly evict live files from the index.
      for (const rel of Object.keys(state.files)) {
        if (seen.has(rel)) continue;
        await memReplaceRef(scope, 'code', rel, []);
        delete state.files[rel];
        removed++;
      }
    }
    // Tiered row cap (v2, review fix 2026-10-23). Planned BEFORE the state is
    // written: an evicted file's hash MOVES from state.files to
    // state.capEvicted first and its rows are evicted after, so a crash in
    // between leaves a held file whose rows are still hot (searchable; the
    // next cap archives them) — never a hash with no rows behind it. A held
    // file with unchanged content re-embeds only when there is room (round 4
    // — no evict / re-embed loop). Live files' rows are ARCHIVED, not deleted
    // (round 3: the 2026-10-20 "archive instead of delete when a store is
    // full" rule — memArchiveRefs keeps one archived generation per file and
    // the re-embed above purges it once the file is hot again); orphan refs
    // (no file behind them) are deleted and purged (round 4). An UNREADABLE ref listing skips the cap this pass
    // (capSkipped:'stats_unreadable'; the overflow is bounded by one sync's
    // 150 files × 20 rows and the next readable pass caps) — never the generic
    // oldest-row cap, which evicts part of a file and keeps its hash (the
    // pinned-hash defect). A full page plans over the page it has.
    let capPlan: CodeCapPlan | null = null;
    let capSkipped: 'stats_unreadable' | undefined;
    let capStatsPartial = false;
    if (v2 && changed) {
      let stats: CodeRefStat[] | null = null;
      try { stats = await memListRefStats(scope, 'code', CODE_REF_STATS_LIMIT); } catch { stats = null; }
      if (!stats) {
        capSkipped = 'stats_unreadable';
      } else {
        capStatsPartial = stats.length >= CODE_REF_STATS_LIMIT;
        const liveKeys = liveRefKeys(state);
        // A cap-evicted ref still holding hot rows (its move never happened)
        // is a live file's copy: archived again, never deleted as an orphan.
        const heldRefs = new Set(Object.keys(capEvicted).map(k => k.slice(0, 400)));
        capPlan = planCodeIndexCapEviction(stats, rowCap, (ref) => liveKeys.has(ref) || heldRefs.has(ref));
        for (const e of capPlan.evict) {
          for (const k of liveKeys.get(e.ref) || []) { capEvicted[k] = state.files[k]; delete state.files[k]; }
        }
      }
    }
    const headAfter = v2 ? await readGitHead(repoRoot) : {};
    // Files OUT of the hot index because of the cap, counted at write time
    // (integration review 2026-10-23): every cap-evicted file — including the
    // ones THIS pass evicted, which capDeferred (embed-loop holds only) never
    // saw — plus new test files deferred for room. The freshness line reads this.
    const capOut = Object.keys(capEvicted).length + capDeferredNew;
    const nextState: CodeIndexState = v2
      ? {
        files: state.files,
        lastSyncAt: new Date().toISOString(),
        ...headProvenance(headBefore, headAfter),
        ...(stale?.mergeBaseSha && /^[0-9a-f]{40}$/.test(stale.mergeBaseSha) ? { indexedAnchor: stale.mergeBaseSha } : {}),
        partial: brokeEarly,
        listed: files.length,
        truncated: walk.truncated,
        ...(walk.listingErrors ? { listingErrors: walk.listingErrors } : {}),
        ...(capDeferred ? { capDeferred } : {}),
        ...(capOut ? { capHeld: capOut } : {}),
        ...(capSkipped ? { capSkipped } : {}),
        ...(state.pinRepairAt || repairDone ? { pinRepairAt: state.pinRepairAt || new Date().toISOString() } : {}),
        ...(Object.keys(capEvicted).length ? { capEvicted } : {}),
        ...(archiveSweptAt ? { archiveSweptAt } : {}),
      }
      : { files: state.files, lastSyncAt: new Date().toISOString() };
    await storePut([projectId, 'code-index'], 'state', nextState as any);
    if (!v2) {
      // A v2 freshness record would outlive this legacy sync and, once the
      // switch clears, read as the index's state (an older sha / age / count)
      // until the next v2 sync. Drop it; the next v2 read summarises this row.
      stateViewCache.delete(projectId);
      try { await storeDelete([projectId, 'code-index'], 'meta'); } catch { /* best-effort */ }
    }
    if (v2) {
      // The small freshness record search_code_semantic reads (never the files map).
      const meta = summariseCodeIndexState(nextState);
      try {
        await storePut([projectId, 'code-index'], 'meta', meta as any);
        cacheStateView(projectId, meta);
      } catch (err: any) {
        stateViewCache.delete(projectId);
        logger.warn(`code-index: freshness record write failed for project ${projectId} (non-fatal): ${err?.message}`);
      }
    }
    const capEvictions = capPlan?.evict ?? [];
    const capEvictedRows = capEvictions.reduce((sum, e) => sum + e.rows, 0);
    if (capEvictions.length) {
      // An ORPHAN ref has no file the state knows behind it — mostly a file
      // deleted from the repo: a real deletion (rows + archived copies), never
      // archived (round 4). Test / code tiers are live files: archived.
      const orphanRefs = capEvictions.filter(e => e.tier === 'orphan').map(e => e.ref);
      const archiveRefs = capEvictions.filter(e => e.tier !== 'orphan').map(e => e.ref);
      if (orphanRefs.length) await memDeleteRefs(scope, 'code', orphanRefs);
      const moved = archiveRefs.length ? await memArchiveRefs(scope, 'code', archiveRefs, 'code_index_tiered') : null;
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.MEMORY_SCOPE_EVICTED,
        value: capEvictedRows,
        unit: 'rows',
        meta: {
          scopeType: 'project', scopeId: projectId, source: 'code', cap: rowCap, reason: 'code_index_tiered', files: capEvictions.length,
          ...(moved?.archived ? { archived: true } : {}), ...(moved?.archiveFailed ? { archiveFailed: true } : {}),
          ...(orphanRefs.length ? { orphansDeleted: orphanRefs.length } : {}),
        },
      });
    } else if (changed && !v2) {
      // Source-scoped sweep: the project scope is shared with the learnings index
      // — a source-blind oldest-first sweep would evict those rows first.
      await enforceScopeCap(scope, PROJECT_CODE_CAP, 'code');
    }
    if (changed || removed || walk.listingErrors || capSkipped || capEvictions.length || archivePurged) {
      if (changed || removed || capEvictions.length) logger.info(`code-index: project ${projectId} synced (+${changed} files, -${removed}${capEvictions.length ? `, cap evicted ${capEvictions.length}` : ''})`);
      // Telemetry (remediation P0): one row per sync pass that touched the
      // index — sweep/evict volume is chartable next to retrieval hit rates.
      const tiers = { orphan: 0, test: 0, code: 0 };
      for (const e of capEvictions) tiers[e.tier]++;
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.INDEX_SWEPT,
        value: removed,
        meta: {
          index: 'code', projectId, changed, removed,
          ...(v2 ? {
            listed: files.length, truncated: walk.truncated, partial: brokeEarly,
            ...(walk.listingErrors ? { listingErrors: walk.listingErrors, errorCodes: walk.errorCodes } : {}),
            ...(sweepKept ? { sweepKept } : {}),
            ...(capEvictions.length ? { capEvictedFiles: capEvictions.length, capEvictedRows, capTiers: tiers } : {}),
            ...(capStatsPartial ? { capStatsPartial: true } : {}),
            ...(capSkipped ? { capSkipped } : {}),
            ...(capDeferred ? { capDeferred } : {}),
            ...(pinRepaired ? { pinRepaired } : {}),
            ...(archivePurged ? { archivePurged } : {}),
            ...(Object.keys(capEvicted).length ? { capHeldFiles: Object.keys(capEvicted).length } : {}),
            ...(nextState.headMovedFrom || nextState.headMovedTo ? { headMoved: true } : {}),
          } : {}),
        },
      });
    }
    return { changed, removed, skipped: false };
  } catch (e: any) {
    logger.warn(`code-index: sync failed (non-fatal): ${e.message}`);
    return { changed: 0, removed: 0, skipped: false };
  } finally {
    inFlightSyncs.delete(projectId);
  }
}

/** Fire-and-forget sync at run start. `baseBranch` names the ref the stale-base gate measures against (the session's base). */
export function kickCodeIndexSync(projectId: string | undefined, repoRoot: string | undefined, userId?: string, baseBranch?: string | null): void {
  if (!projectId || !repoRoot) return;
  void syncCodeIndex(projectId, repoRoot, userId ? { userId, ...(baseBranch ? { baseBranch } : {}) } : (baseBranch ? { baseBranch } : undefined)).catch(() => {});
}

/** Semantic code search over the project index (hybrid fusion + rerank inside memSearch). */
export async function searchCodeSemantic(projectId: string, query: string, k = 8): Promise<MemHit[]> {
  return memSearch([{ type: 'project', id: projectId }], query, k, { sources: ['code'], purpose: 'code_index' });
}

// ── Run-start contextual injection (buildLearningsBlock's code-index sibling) ─

const MATCH_MIN_QUERY_CHARS = 30; // "yes", "continue", "do it" — steering turns match nothing meaningful
const MATCH_MAX_FILES = 6;
const MATCH_CHAR_BUDGET = 900;

/**
 * [CODE INDEX MATCHES] block for the system prompt: the files the embedding
 * index semantically matches to the user's task, so the index pays off on
 * EVERY run instead of only when the model thinks to call
 * search_code_semantic. Paths + a matched-chunk snippet, deduped per file,
 * bounded to ~900 chars. Empty string when there's nothing (short steering
 * message, index not built yet, any failure) — never throws.
 */
export async function buildCodeMatchesBlock(
  projectId: string | undefined,
  query: string,
  maxFiles = MATCH_MAX_FILES,
  budget = MATCH_CHAR_BUDGET,
): Promise<string> {
  if (!projectId || (query || '').trim().length < MATCH_MIN_QUERY_CHARS) return '';
  try {
    const hits = await searchCodeSemantic(projectId, query.slice(0, 2000), maxFiles * 2);
    if (!hits.length) return '';
    const header = `[CODE INDEX MATCHES — files the repo embedding index matches to this task (vector nearest-neighbours: treat as leads, not ground truth); read the relevant ones, search_code_semantic for more]`;
    let block = header;
    const seen = new Set<string>();
    for (const h of hits) {
      const file = (h.ref || '').replace(/ \(part \d+\)$/, '');
      if (!file || seen.has(file)) continue;
      seen.add(file);
      const snippet = h.content.replace(/\s+/g, ' ').trim().slice(0, 90);
      const line = `\n- ${file} — "${snippet}…"`;
      if (block.length + line.length > budget) break;
      block += line;
      if (seen.size >= maxFiles) break;
    }
    return block === header ? '' : block;
  } catch {
    return '';
  }
}

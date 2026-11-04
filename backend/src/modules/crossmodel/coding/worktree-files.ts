/**
 * Phase-1 worktree file tree + inline file viewer (feedback ticket 999e3dbe).
 *
 * READ-ONLY JSON endpoints backing the chat sidebar Files tab for a chat that
 * carries a coding worktree at ${CODING_WORKSPACE_ROOT}/worktrees/<chatId>:
 *
 *   GET /api/crossmodel/chats/:chatId/worktree/tree?path=<rel-dir>&showIgnored=0|1
 *       → { path, entries: [{ name, path, type: 'file'|'dir', size?, status? }] }
 *       ONE directory level. status is the git badge letter (M/A/D/?) for
 *       entries changed vs HEAD. .git / node_modules are ALWAYS excluded;
 *       .gitignore is respected unless showIgnored=1. Dirs sort before files.
 *
 *   GET /api/crossmodel/chats/:chatId/worktree/file?path=<rel-file>
 *       → { path, content, truncated }
 *       UTF-8 text only. 400 for directories, 413 over 256 KB, 415 for binary
 *       (NUL bytes / high non-text ratio in the first 8 KB sniff window).
 *
 * SECURITY (this serves the user's real code — non-negotiable):
 *   - Ownership: the same getSessionForUser(chatId, userId, 'owner') gate the
 *     other coding routes use (coding-stream.controller startRun/stopRun) —
 *     404, never an existence leak, when the chat isn't the caller's.
 *   - The worktree root is worktreePath(chatId) — a chatId-keyed path, never
 *     the session row's persisted worktreePath (a DB string the agent could
 *     influence must not steer file serving). Missing dir → 404 "no worktree".
 *   - resolveSafeWorktreePath: rejects absolute paths, any '..' segment, NUL
 *     bytes, backslash tricks, and .git/node_modules segments; then fs.realpath
 *     on BOTH the root and the target with an inside-root equality/prefix
 *     check, so a symlink anywhere in the chain can't escape the worktree.
 *
 * Directory listing is readdir-based (git ls-tree alone can never surface
 * UNTRACKED or IGNORED files, which this endpoint must show with badges) and
 * merged with `git ls-tree` so a tracked file deleted from disk still lists
 * with its D badge. Badges come from ONE `git status --porcelain -z` scoped to
 * the listed dir. Ignored entries are filtered via ONE batched
 * `git check-ignore` (exit 1 = nothing ignored, tolerated — hence the local
 * exit-code-returning execGit instead of workspace.service's throwing git()).
 */

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Request, Response } from 'express';
import logger from '../../../utils/logger';
import { getSessionForUser } from './coding-data.service';
import { worktreePath } from './workspace.service';
import {
  getWorktreeSnapshot,
  snapshotLevel,
  snapshotMeta,
  normalizeSnapshotPath,
  WorktreeSnapshot,
} from './worktree-snapshot.service';
import { requestRemoteWorktreeFile, requestRemoteWorktreeRaw } from './worktree-remote-read';

/** Files larger than this are rejected 413 (inline viewer is for source, not blobs). */
export const MAX_FILE_BYTES = 256 * 1024;
/** Binary sniff window — NUL byte or a high non-text ratio in this prefix ⇒ 415. */
export const SNIFF_BYTES = 8192;
/**
 * Ticket 19fbd876: DOWNLOAD cap for the raw byte route. The inline viewer
 * caps at 256 KB, but the download route exists to hand the owner real
 * deliverables (decks, PDFs, archives) — so it gets its own, larger cap.
 * 16 MB bounds BOTH the web-box read AND the cross-box Redis reply: base64 of
 * 16 MB is ~21.9 MB of JSON, under Redis's default 32 MB pub/sub
 * client-output-buffer limit — a larger payload would get the reply
 * subscriber connection killed by the server, and the read would degrade to
 * the honest 404 (timeout) instead of downloading.
 */
export const MAX_RAW_BYTES = 16 * 1024 * 1024;
/** Per-git-call ceiling so a wedged repo can't hang a web request. */
const GIT_TIMEOUT_MS = 20_000;
/** Viewer cap on one directory level — a pathological dir can't OOM the response. */
const MAX_TREE_ENTRIES = 5000;

/** Local error with an HTTP status (keeps this module off the config/env import chain). */
export class WorktreeFilesError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'WorktreeFilesError';
    Object.setPrototypeOf(this, WorktreeFilesError.prototype);
  }
}

export type WorktreeEntryType = 'file' | 'dir';
export interface WorktreeTreeEntry {
  name: string;
  path: string;
  type: WorktreeEntryType;
  size?: number;
  /** Last-modified time (epoch ms) — files AND dirs; the Files tab shows it
   *  and sorts most-recent first (owner 2026-09-17). Absent for a tracked
   *  file that is gone from disk (status 'D'). */
  mtime?: number;
  status?: 'M' | 'A' | 'D' | '?';
}

/** git subprocess env, mirroring workspace.service's gitEnv hardening (no
 *  inherited provider keys, no prompts, no user/system config, safe.directory=*). */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
  };
}

interface GitOut { code: number; stdout: string; stderr: string }

/**
 * execFile('git', …) that RESOLVES on any exit code (never throws on non-zero):
 * `git check-ignore` exits 1 when nothing matched and `git ls-tree HEAD` exits
 * 128 on an unborn HEAD — both are data, not failures. Only spawn-level errors
 * (ENOENT binary, timeout kill) reject. `input` feeds --stdin (check-ignore's
 * -z mode ONLY works with --stdin).
 */
function execGit(args: string[], cwd: string, input?: string): Promise<GitOut> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git', args,
      { cwd, env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error as any).code === 'ENOENT') return reject(error);
        if (error && ((error as any).killed || (error as any).signal)) return reject(error);
        const code = typeof (error as any)?.code === 'number' ? (error as any).code : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

/** Repo-root-relative forward-slash path joining (paths inside a worktree are always posix-style for git). */
function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/**
 * THE path-escape guard (exported for unit tests — ticket 999e3dbe).
 * Resolves `relPath` against the worktree `root` and returns the real,
 * symlink-free absolute path plus its repo-root-relative posix form.
 * Throws WorktreeFilesError(400) on any escape attempt and (404) when the
 * target does not exist.
 */
export async function resolveSafeWorktreePath(
  root: string,
  relPath: string,
): Promise<{ abs: string; rel: string }> {
  const rel0 = relPath ?? '';
  if (typeof rel0 !== 'string') throw new WorktreeFilesError(400, 'path must be a string');
  if (rel0.includes('\0')) throw new WorktreeFilesError(400, 'Invalid path');
  // Backslash tricks: on POSIX a backslash is a legal name char, but for a web
  // path param it only ever signals Windows-style escape confusion — reject.
  if (rel0.includes('\\')) throw new WorktreeFilesError(400, 'Invalid path');
  if (path.posix.isAbsolute(rel0) || /^[a-zA-Z]:/.test(rel0)) {
    throw new WorktreeFilesError(400, 'Absolute paths are not allowed');
  }
  const rawSegments = rel0.split('/');
  if (rawSegments.some((s) => s === '..')) {
    throw new WorktreeFilesError(400, 'Path escapes the worktree');
  }
  const norm = path.posix.normalize(rel0);
  const normSegments = norm.split('/').filter((s) => s && s !== '.');
  // .git anywhere in the chain = git internals, never served; node_modules is
  // always excluded from this viewer. Case-insensitive: on case-folding
  // filesystems the variants alias the same dirs.
  for (const seg of normSegments) {
    const low = seg.toLowerCase();
    if (low === '.git' || low === 'node_modules') {
      throw new WorktreeFilesError(400, `Access to ${low === '.git' ? '.git' : 'node_modules'} is not allowed`);
    }
  }
  const rootReal = await fs.realpath(root);
  const candidate = normSegments.length ? path.join(rootReal, ...normSegments) : rootReal;
  let targetReal: string;
  try {
    targetReal = await fs.realpath(candidate);
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new WorktreeFilesError(404, 'Path not found in the worktree');
    throw err;
  }
  // Symlink-aware containment: the TARGET's real path must BE the root or live
  // strictly inside it. (root is realpath'd first so a symlinked root itself
  // can't produce a false prefix mismatch.)
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw new WorktreeFilesError(400, 'Path escapes the worktree');
  }
  const rel = path.relative(rootReal, targetReal).split(path.sep).join('/');
  // Review finding F1 (ticket 999e3dbe): the pre-realpath segment ban above is
  // checked on the REQUEST path — an in-worktree symlink pointing AT .git or
  // node_modules (e.g. `ln -s .git x`, creatable by the agent) would resolve
  // inside the root and pass containment. Re-check the RESOLVED relative
  // path's segments so the invariant holds for what is actually served.
  for (const seg of rel.split('/')) {
    const low = seg.toLowerCase();
    if (low === '.git' || low === 'node_modules') {
      throw new WorktreeFilesError(400, `Access to ${low === '.git' ? '.git' : 'node_modules'} is not allowed`);
    }
  }
  return { abs: targetReal, rel };
}

/** Parse `git status --porcelain -z` output into repo-root-relative → XY records.
 *  -z renames/copies emit `XY <to>\0<from>\0` (destination first). */
function parsePorcelain(z: string): Array<{ xy: string; path: string }> {
  const out: Array<{ xy: string; path: string }> = [];
  const parts = z.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    if (!p) continue;
    out.push({ xy, path: p });
    if (xy[0] === 'R' || xy[0] === 'C') i++; // consume the source-path record
  }
  return out;
}

/** Ticket 999e3dbe badge mapping: modified→M, added/staged-new→A, deleted→D,
 *  untracked '??'→'?', renamed→M. */
function badgeFor(xy: string): 'M' | 'A' | 'D' | '?' | undefined {
  if (xy === '??') return '?';
  const [x, y] = xy;
  if (x === 'A') return 'A';
  if (x === 'R') return 'M';
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'M' || y === 'M' || x === 'T' || y === 'T') return 'M';
  if (x === 'C') return 'A';
  if (x === 'U' || y === 'U') return 'M'; // conflicted — surface as modified
  return undefined;
}

/**
 * Badge letters for the DIRECT CHILDREN of `relDir`, from ONE porcelain call
 * scoped to that dir. A nested change (sub/deep/file.ts when listing root)
 * does NOT badge the child dir — only the `?? newdir/` untracked-dir collapse
 * badges a directory.
 */
async function statusBadges(root: string, relDir: string): Promise<Map<string, 'M' | 'A' | 'D' | '?'>> {
  const map = new Map<string, 'M' | 'A' | 'D' | '?'>();
  const pathspec = relDir || '.';
  const { code, stdout } = await execGit(['status', '--porcelain', '-z', '--', pathspec], root);
  if (code !== 0) return map; // unborn HEAD / git hiccup → no badges, not a failure
  const prefix = relDir ? `${relDir}/` : '';
  for (const { xy, path: p } of parsePorcelain(stdout)) {
    if (prefix && !p.startsWith(prefix)) continue;
    const rest = prefix ? p.slice(prefix.length) : p;
    if (!rest) continue;
    const badge = badgeFor(xy);
    if (!badge) continue;
    if (rest.endsWith('/')) {
      // Untracked-dir collapse ('?? newdir/') — badges the dir entry itself.
      if (!rest.slice(0, -1).includes('/')) map.set(rest.slice(0, -1), badge);
      continue;
    }
    if (rest.includes('/')) continue; // nested change — not a direct child
    map.set(rest, badge);
  }
  return map;
}

/** HEAD's direct children of `relDir` via `git ls-tree -z -l` (the merge source
 *  that keeps a deleted-but-tracked file listed with its D badge). Unborn HEAD
 *  (empty repo) → empty map, never a failure. */
async function lsTreeLevel(root: string, relDir: string): Promise<Map<string, { type: WorktreeEntryType; size?: number }>> {
  const map = new Map<string, { type: WorktreeEntryType; size?: number }>();
  const ref = relDir ? `HEAD:${relDir}` : 'HEAD';
  const { code, stdout } = await execGit(['ls-tree', '-z', '-l', ref], root);
  if (code !== 0) return map;
  for (const rec of stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(/\s+/);
    const name = rec.slice(tab + 1);
    if (!name) continue;
    const type: WorktreeEntryType = meta[1] === 'tree' ? 'dir' : 'file';
    const size = meta[1] === 'blob' && /^\d+$/.test(meta[3] ?? '') ? parseInt(meta[3], 10) : undefined;
    map.set(name, size === undefined ? { type } : { type, size });
  }
  return map;
}

/** The .gitignore filter: ONE batched `git check-ignore --stdin` over the
 *  candidate paths (dirs carry a trailing slash so dir-only rules match).
 *  check-ignore skips index-tracked paths by default, so tracked files are
 *  never hidden. Any git failure → fail OPEN (show the entries) — the viewer
 *  degrades to unfiltered, never to hiding real files. */
async function ignoredSet(root: string, relPaths: string[]): Promise<Set<string>> {
  const set = new Set<string>();
  if (!relPaths.length) return set;
  // -z requires --stdin: paths go in NUL-separated, matches come out the same
  // way (no core.quotePath C-quoting to undo).
  const input = relPaths.map((p) => p + '\0').join('');
  const { code, stdout } = await execGit(['check-ignore', '-z', '--stdin'], root, input);
  if (code !== 0) return set; // 1 = nothing ignored; 128 = git error (fail open)
  for (const p of stdout.split('\0')) {
    if (!p) continue;
    set.add(p.endsWith('/') ? p.slice(0, -1) : p);
  }
  return set;
}

/** One directory level, merged from readdir + ls-tree + porcelain + check-ignore. */
async function listDirLevel(
  root: string,
  abs: string,
  rel: string,
  showIgnored: boolean,
): Promise<{ entries: WorktreeTreeEntry[]; truncated: boolean }> {
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  // .git / node_modules are ALWAYS excluded from listings, at any level.
  const onDisk = dirents.filter((d) => {
    const low = d.name.toLowerCase();
    return low !== '.git' && low !== 'node_modules';
  });

  if (!showIgnored && onDisk.length) {
    const ignored = await ignoredSet(
      root,
      onDisk.map((d) => joinRel(rel, d.name) + (d.isDirectory() ? '/' : '')),
    );
    for (let i = onDisk.length - 1; i >= 0; i--) {
      if (ignored.has(joinRel(rel, onDisk[i].name))) onDisk.splice(i, 1);
    }
  }

  const [tracked, badges] = await Promise.all([lsTreeLevel(root, rel), statusBadges(root, rel)]);
  const byName = new Map<string, WorktreeTreeEntry>();

  await Promise.all(onDisk.map(async (d) => {
    const entry: WorktreeTreeEntry = {
      name: d.name,
      path: joinRel(rel, d.name),
      // A symlink reports as a file — navigating/fetching it re-enters the
      // realpath guard, which decides whether the target is servable.
      type: d.isDirectory() ? 'dir' : 'file',
    };
    const st = await fs.stat(path.join(abs, d.name)).catch(() => null);
    if (st) {
      if (entry.type === 'file') entry.size = st.size;
      entry.mtime = Math.round(st.mtimeMs);
    }
    const badge = badges.get(d.name);
    if (badge) entry.status = badge;
    byName.set(d.name, entry);
  }));

  // Tracked in HEAD but GONE from disk → still listed, with its D badge.
  for (const [name, t] of tracked) {
    if (byName.has(name)) continue;
    const low = name.toLowerCase();
    if (low === '.git' || low === 'node_modules') continue;
    const badge = badges.get(name);
    if (badge !== 'D') continue; // absent from disk for a non-deletion reason (e.g. skip-worktree) — leave it out
    const entry: WorktreeTreeEntry = { name, path: joinRel(rel, name), type: t.type, status: 'D' };
    if (t.size !== undefined) entry.size = t.size;
    byName.set(name, entry);
  }

  let entries = [...byName.values()];
  // Dirs before files, then plain codepoint order (localeCompare drifts with
  // the host's ICU build — codepoint sort is identical everywhere).
  entries.sort((a, b) => (a.type === b.type
    ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    : a.type === 'dir' ? -1 : 1));
  const truncated = entries.length > MAX_TREE_ENTRIES;
  if (truncated) entries = entries.slice(0, MAX_TREE_ENTRIES);
  return { entries, truncated };
}

/** Binary sniff: a NUL byte is decisive; otherwise >10% non-text codepoints in
 *  the window means this isn't UTF-8-readable source (ticket 999e3dbe: 415). */
export function isProbablyBinary(buf: Buffer): boolean {
  if (!buf.length) return false;
  let suspicious = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) return true;
    // Allowed text bytes: printable ASCII, \t \n \r, and any byte that can be
    // part of a multi-byte UTF-8 sequence (>= 0x80).
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x08) suspicious++;
    else if (b === 0x7f) suspicious++;
  }
  return suspicious / buf.length > 0.1;
}

/** Ownership + worktree-existence prelude shared by both endpoints. Returns
 *  null (response already sent) on any rejection.
 *
 *  Ticket 1c767622: when the chat's worktree is NOT on this box's local volume
 *  (the ALB scattered the request to a web box that doesn't host it), fall
 *  back to the Redis-published snapshot instead of 404ing — Retry used to be
 *  the only way out because it re-rolled the ALB dice. Serve order (see the
 *  ORIGIN FENCE inside): disk normally wins; a RUN-origin snapshot (worker
 *  box, post-terminal-run — the live copy) beats any disk copy; neither → 404. */
export interface ResolvedWorktree {
  chatId: string;
  root: string | null;
  snapshot: WorktreeSnapshot | null;
  disk: boolean;
}

async function resolveOwnedWorktree(req: Request, res: Response): Promise<ResolvedWorktree | null> {
  const userId = (req as any).user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const chatId = (req.params as any).chatId ?? (req.params as any).id;
  const r = await resolveWorktreeForUser(chatId, userId, 'owner');
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return null;
  }
  return r.ctx;
}

/**
 * Access + location resolution WITHOUT an Express response — the in-loop
 * read_session_file / list_session_files tools (capability gap audit T3b,
 * 2026-09-24) share it with the HTTP handlers above. minAccess 'read' lets a
 * project MEMBER read a lane's worktree (the HTTP viewer stays owner-only).
 */
export async function resolveWorktreeForUser(
  chatId: string,
  userId: string,
  minAccess: 'owner' | 'read' = 'owner',
): Promise<{ ok: true; ctx: ResolvedWorktree } | { ok: false; status: number; error: string }> {
  const session = await getSessionForUser(chatId, userId, minAccess).catch(() => null);
  if (!session) return { ok: false, status: 404, error: 'Session not found' };
  // The chatId-keyed path — NOT the persisted session.worktreePath string.
  const root = worktreePath(chatId);
  const st = await fs.stat(root).catch(() => null);
  // Ticket 1c767622: the shared snapshot (published by whichever box owns the
  // live worktree). One Redis GET, best-effort; null when absent/Redis down.
  const snapshot = await getWorktreeSnapshot(chatId);
  if (st && st.isDirectory()) {
    // ORIGIN FENCE (deliberately clock-free — review round 1: box clocks and
    // worktree-root mtimes are both unreliable cross-box signals; content-only
    // edits don't bump the root's mtime, so a live box could wrongly serve its
    // own budget-truncated snapshot over its full disk copy). The snapshot
    // wins ONLY when the worker box published it after a terminal run
    // (origin:'run' — the live, authoritative copy). A provision-time
    // snapshot (origin:'provision') is the SAME generation as any web box's
    // disk copy, so disk wins that tie for full fidelity. A payload without
    // an origin field does NOT override disk (fail-safe: no such keys exist
    // in prod — the origin-less version never shipped).
    if (snapshot && snapshot.origin === 'run') {
      return { ok: true, ctx: { chatId, root: null, snapshot, disk: false } };
    }
    return { ok: true, ctx: { chatId, root, snapshot: null, disk: true } };
  }
  // Not on THIS box's volume: the snapshot fills the hole (the reported bug —
  // Retry used to be the only way out because it re-rolled the ALB dice).
  if (snapshot) return { ok: true, ctx: { chatId, root: null, snapshot, disk: false } };
  return { ok: false, status: 404, error: 'No coding worktree on disk for this chat — the worktree is provisioned when the first run starts.' };
}

function sendWorktreeError(res: Response, err: any, logCtx: string): Response {
  if (err instanceof WorktreeFilesError) return res.status(err.statusCode).json({ error: err.message });
  logger.warn(`worktree-files: ${logCtx} failed: ${err?.message ?? err}`);
  return res.status(500).json({ error: 'Could not read the worktree — try again.' });
}

/** One tree level as { status, body } — shared by the HTTP handler and the
 *  list_session_files tool. A WorktreeFilesError / snapshot-path reject maps to
 *  its 4xx here; anything else propagates for the caller's 500 handling. */
export async function listWorktreeTreeCore(ctx: ResolvedWorktree, relParam: string, showIgnored = false): Promise<{ status: number; body: any }> {
  try {
    // Ticket 1c767622: snapshot fallback — this box lacks the chat's volume,
    // so serve the shared snapshot's level instead of 404ing. Same
    // { path, entries } shape the frontend already renders, plus an optional
    // additive `snapshot` marker (publishedAt/branch) the UI may show.
    if (!ctx.disk) {
      let rel: string;
      try {
        rel = normalizeSnapshotPath(relParam);
      } catch (e: any) {
        // Lexical rejects mirror the disk path's 400s (normalize throws plain
        // Errors to stay import-cycle-free — map them here, not in sendWorktreeError).
        return { status: 400, body: { error: e?.message ?? 'Invalid path' } };
      }
      const level = snapshotLevel(ctx.snapshot!, rel, showIgnored);
      return { status: 200, body: { path: rel, entries: level.entries, ...(level.truncated ? { truncated: true } : {}), snapshot: snapshotMeta(ctx.snapshot!) } };
    }
    const { abs, rel } = await resolveSafeWorktreePath(ctx.root!, relParam);
    const st = await fs.stat(abs);
    if (!st.isDirectory()) return { status: 400, body: { error: 'Not a directory' } };
    const { entries, truncated } = await listDirLevel(ctx.root!, abs, rel, showIgnored);
    return { status: 200, body: { path: rel, entries, ...(truncated ? { truncated: true } : {}) } };
  } catch (err: any) {
    if (err instanceof WorktreeFilesError) return { status: err.statusCode, body: { error: err.message } };
    throw err;
  }
}

/** One file as { status, body } — shared by the HTTP handler and the
 *  read_session_file tool. Disk → snapshot → live cross-box read, exactly the
 *  Files-tab order; guards (size, binary, path jail) are identical. */
export async function readWorktreeFileCore(ctx: ResolvedWorktree, relParam: string): Promise<{ status: number; body: any }> {
  try {
    if (!relParam) return { status: 400, body: { error: 'path is required' } };
    // Ticket 1c767622: snapshot fallback — serve base64 content from the
    // shared snapshot when this box lacks the volume. Missing content in the
    // snapshot (over-budget / binary / too large) is an honest 404 with a
    // snapshot-aware message, not a crash.
    if (!ctx.disk) {
      let rel: string;
      try {
        rel = normalizeSnapshotPath(relParam);
      } catch (e: any) {
        // Lexical rejects mirror the disk path's 400s (review round-2 finding
        // 3 — this path used to fall through to a 500).
        return { status: 400, body: { error: e?.message ?? 'Invalid path' } };
      }
      const snap = ctx.snapshot!;
      const entry = snap.entries.find(e => e.path === rel && e.type === 'file');
      const b64 = entry ? snap.files?.[rel] : undefined;
      if (b64 !== undefined) {
        return { status: 200, body: { path: rel, content: Buffer.from(b64, 'base64').toString('utf8'), truncated: false, snapshot: snapshotMeta(snap) } };
      }
      // Live cross-box read (owner 2026-09-17 — "how come I can't view this
      // file?"): the snapshot carries at most 256 KB of content per session,
      // so files past the budget, binary-sniffed, or written AFTER the last
      // terminal run list but have no bytes here. Ask the box that hosts the
      // worktree over Redis (worktree-remote-read.ts); the worker there
      // applies the same guards this handler applies on disk. No answer
      // within the timeout ⇒ the honest 404 below, never a hang.
      const remote = await requestRemoteWorktreeFile(ctx.chatId, rel);
      if (remote) {
        if (remote.ok) return { status: 200, body: { path: remote.path, content: remote.content, truncated: false, live: true } };
        return { status: remote.status, body: { error: remote.error } };
      }
      if (!entry) return { status: 404, body: { error: 'Path not found in the worktree' } };
      return { status: 404, body: { error: 'This file isn\'t in the shared snapshot (over the content budget or binary) and the box that hosts the worktree didn\'t answer — try again in a moment.' } };
    }
    const { abs, rel } = await resolveSafeWorktreePath(ctx.root!, relParam);
    const st = await fs.stat(abs);
    if (st.isDirectory()) return { status: 400, body: { error: 'Path is a directory — use the tree endpoint.' } };
    if (!st.isFile()) return { status: 400, body: { error: 'Not a regular file' } };
    if (st.size > MAX_FILE_BYTES) {
      return { status: 413, body: { error: `File is too large to view inline (${st.size} bytes — the limit is ${MAX_FILE_BYTES} bytes / 256 KB).` } };
    }
    const buf = await fs.readFile(abs);
    if (isProbablyBinary(buf.subarray(0, SNIFF_BYTES))) {
      return { status: 415, body: { error: 'Binary file — only UTF-8 text files can be viewed inline.' } };
    }
    const content = buf.toString('utf8');
    if (content.includes('\ufffd')) {
      // Decodes with replacement chars ⇒ not really UTF-8 text.
      return { status: 415, body: { error: 'Binary file — only UTF-8 text files can be viewed inline.' } };
    }
    return { status: 200, body: { path: rel, content, truncated: false } };
  } catch (err: any) {
    if (err instanceof WorktreeFilesError) return { status: err.statusCode, body: { error: err.message } };
    throw err;
  }
}

/**
 * GET /chats/:chatId/worktree/tree?path=<rel-dir>&showIgnored=0|1
 * (mounted in crossmodel.routes.ts; ticket 999e3dbe)
 */
export async function getWorktreeTree(req: Request, res: Response) {
  try {
    const ctx = await resolveOwnedWorktree(req, res);
    if (!ctx) return;
    const relParam = typeof (req.query as any)?.path === 'string' ? (req.query as any).path : '';
    const showIgnored = (req.query as any)?.showIgnored === '1' || (req.query as any)?.showIgnored === 'true';
    const r = await listWorktreeTreeCore(ctx, relParam, showIgnored);
    return res.status(r.status).json(r.body);
  } catch (err: any) {
    return sendWorktreeError(res, err, `tree ${(req.params as any)?.chatId ?? (req.params as any)?.id}`);
  }
}

/**
 * RFC 6266 Content-Disposition for the raw download route — the SAME
 * header-injection-safe shape chat-files.controller.ts / generated-files
 * use: an ASCII-safe quoted fallback (everything outside \x20-\x7E plus "
 * and \ replaced) + a UTF-8 filename* form, so a worktree filename with a
 * quote (review B2, ticket 19fbd876: `foo".pdf` shipped a malformed header)
 * or a non-latin1 name (which crashed the raw template literal) can never
 * break the header or the response.
 */
function rawContentDisposition(filename: string): string {
  const safeName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * GET /chats/:chatId/worktree/raw?path=<rel-file>
 * (mounted in crossmodel.routes.ts; ticket 19fbd876)
 *
 * The DOWNLOAD companion to /worktree/file: serves the file's REAL BYTES
 * (binary included) with application/octet-stream + a Content-Disposition
 * attachment header naming the basename. Without it, the Files tab's download
 * button blobbed the 415 inline-preview notice text out as a mislabeled .txt
 * — the exact incident (a 59 KB PDF handed over as cql-dgx-b300-deck.txt).
 *
 * Same ownership + path-escape guards as /worktree/file; NO binary sniff and
 * NO 256 KB inline cap (the download exists FOR binaries and real
 * deliverables) — a 16 MB cap (MAX_RAW_BYTES) bounds the read instead.
 * Serve order mirrors the viewer: disk → shared snapshot (base64) → live
 * cross-box read. 404 when none of the three holds the bytes (same honest
 * errors as the viewer path, never a partial/empty 200).
 */
export async function getWorktreeRaw(req: Request, res: Response) {
  try {
    const ctx = await resolveOwnedWorktree(req, res);
    if (!ctx) return;
    const relParam = typeof (req.query as any)?.path === 'string' ? (req.query as any).path : '';
    const r = await readWorktreeRawCore(ctx, relParam);
    if (r.status !== 200) {
      return res.status(r.status).json({ error: (r as { body?: any }).body?.error ?? 'Could not read the file' });
    }
    const raw = r as { buf: Buffer; rel: string };
    // Basename only (never a path with directories) — `attachment` makes
    // browsers honour it as the save name; the guard already rejected
    // traversal/NUL, so the basename is a plain filename.
    const filename = raw.rel.split('/').pop() || 'download';
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', rawContentDisposition(filename));
    res.setHeader('Content-Length', String(raw.buf.length));
    return res.status(200).send(raw.buf);
  } catch (err: any) {
    return sendWorktreeError(res, err, `raw ${(req.params as any)?.chatId ?? (req.params as any)?.id}`);
  }
}

/**
 * One file's RAW BYTES as { status, body } | { status: 200, buf, rel } — the
 * download companion to readWorktreeFileCore (ticket 19fbd876). Serve order
 * disk → shared snapshot → live cross-box read, exactly the Files-tab order;
 * guards (path jail, 16 MB download cap) are the viewer's, WITHOUT the
 * binary sniff / 256 KB inline cap (a download exists to hand over binaries).
 */
export async function readWorktreeRawCore(ctx: ResolvedWorktree, relParam: string): Promise<{ status: number; body: any } | { status: 200; buf: Buffer; rel: string }> {
  try {
    if (!relParam) return { status: 400, body: { error: 'path is required' } };
    if (!ctx.disk) {
      // Shared snapshot first (binary files are normally excluded at publish
      // by budget/sniff, but when the bytes ARE there they are exact).
      let rel: string;
      try {
        rel = normalizeSnapshotPath(relParam);
      } catch (e: any) {
        return { status: 400, body: { error: e?.message ?? 'Invalid path' } };
      }
      const snap = ctx.snapshot!;
      const entry = snap.entries.find(e => e.path === rel && e.type === 'file');
      const b64 = entry ? snap.files?.[rel] : undefined;
      if (b64 !== undefined) {
        return { status: 200, buf: Buffer.from(b64, 'base64'), rel };
      }
      // Live cross-box read — the same escape hatch the viewer uses; the
      // remote op 'raw' (19fbd876) returns base64 bytes with no text guards.
      const remote = await requestRemoteWorktreeRaw(ctx.chatId, rel);
      if (remote) {
        if (remote.ok) {
          // op 'raw' replies carry b64; a defensive guard against a reply
          // shaped like op 'read' keeps a malformed payload from crashing.
          const b64 = (remote as { b64?: string }).b64;
          if (typeof b64 === 'string') return { status: 200, buf: Buffer.from(b64, 'base64'), rel: remote.path };
          return { status: 500, body: { error: 'The hosting box answered without file bytes — try again.' } };
        }
        return { status: remote.status, body: { error: remote.error } };
      }
      if (!entry) return { status: 404, body: { error: 'Path not found in the worktree' } };
      return { status: 404, body: { error: 'This file isn\'t in the shared snapshot and the box that hosts the worktree didn\'t answer — try again in a moment.' } };
    }
    const { abs, rel } = await resolveSafeWorktreePath(ctx.root!, relParam);
    const st = await fs.stat(abs);
    if (st.isDirectory()) return { status: 400, body: { error: 'Path is a directory — use the tree endpoint.' } };
    if (!st.isFile()) return { status: 400, body: { error: 'Not a regular file' } };
    if (st.size > MAX_RAW_BYTES) {
      return { status: 413, body: { error: `File is too large to download (${st.size} bytes — the limit is ${MAX_RAW_BYTES} bytes / 16 MB).` } };
    }
    const buf = await fs.readFile(abs);
    if (buf.length > MAX_RAW_BYTES) {
      return { status: 413, body: { error: `File is too large to download (${buf.length} bytes — the limit is ${MAX_RAW_BYTES} bytes / 16 MB).` } };
    }
    return { status: 200, buf, rel };
  } catch (err: any) {
    if (err instanceof WorktreeFilesError) return { status: err.statusCode, body: { error: err.message } };
    throw err;
  }
}

/**
 * GET /chats/:chatId/worktree/file?path=<rel-file>
 * (mounted in crossmodel.routes.ts; ticket 999e3dbe)
 */
export async function getWorktreeFile(req: Request, res: Response) {
  try {
    const ctx = await resolveOwnedWorktree(req, res);
    if (!ctx) return;
    const relParam = typeof (req.query as any)?.path === 'string' ? (req.query as any).path : '';
    const r = await readWorktreeFileCore(ctx, relParam);
    return res.status(r.status).json(r.body);
  } catch (err: any) {
    return sendWorktreeError(res, err, `file ${(req.params as any)?.chatId ?? (req.params as any)?.id}`);
  }
}

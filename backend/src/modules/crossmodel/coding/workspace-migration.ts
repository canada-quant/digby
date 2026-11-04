/**
 * PER-USER WORKSPACE SUBTREE — migration of EXISTING data (build 2026-10-08
 * ISO-4; isolation.md staged plan steps 3–4). New sessions land per-user on
 * their own (workspace-placement.ts); this moves a user's EXISTING legacy
 * worktrees + sandbox homes (and, with `mirrors`, the mirrors of projects they
 * own) into `<root>/<userKey>/…` so the dev container can mount only that.
 *
 * RULES (each one a test in workspace-migration.test.ts):
 *   - DRY RUN BY DEFAULT: `planUserMigration` writes nothing; only
 *     `applyUserMigration` moves, and the CLI calls it only with --apply.
 *   - PER USER: one user per run; a user key held by another user aborts.
 *   - NEVER A LIVE RUN: a session with a queued/running agent_run (or a held
 *     session run-lock, or status 'running') is skipped — re-checked under the
 *     session run-lock right before its move; its container is stopped only
 *     after the lock is held.
 *   - ATOMIC PER ITEM: rename(2) on one filesystem; the git links are
 *     rewritten in both directions (worktree `.git` ↔ the mirror's
 *     `worktrees/<name>/gitdir`); the moved worktree is verified with
 *     `git rev-parse --git-dir` and the item is ROLLED BACK on any failure
 *     (never an orphaned lane).
 *   - A relative COMPATIBILITY SYMLINK stays at each legacy path (the
 *     dual-read resolvers follow it; per-session containers also mount the
 *     moved worktree at its legacy path) and absolute paths in the session's
 *     `$DIGBY_ENV` file + any Python venv (pyvenv.cfg + bin/ scripts) are
 *     rewritten old → new, recorded for the revert.
 *   - A mirror moves only when EVERY worktree attached to it belongs to this
 *     user (a shared project's mirror stays legacy and is mounted on its own).
 *   - REVERSIBLE: every move is recorded in a manifest
 *     (`<root>/.digby-layout-migrations/<runId>.json`); `revertMigration`
 *     replays it backwards under the same rules.
 * Telemetry: one `workspace_isolation` row per item (phase 'migration').
 */

import * as fs from 'fs/promises';
import { lstatSync, readFileSync, existsSync } from 'fs';
import * as path from 'path';
import {
  LAYOUT_ROOT, userSubtreeKey, subtreeOwnerSync, ensureUserSubtreeSync,
  legacyWorktreePath, legacySandboxHome, legacyMirrorPath,
  subtreeWorktreePath, subtreeSandboxHome, subtreeMirrorPath, pathSubtreeKey,
  forgetPlacement, noteWorktreePlacement, noteMirrorPlacement, resolveWorktreePathSync,
} from './workspace-layout';

export type MigrationItemKind = 'worktree' | 'home' | 'mirror';
export interface MigrationItem {
  kind: MigrationItemKind;
  sessionId?: string;
  projectId?: string;
  from: string;
  to: string;
  status: 'planned' | 'skipped' | 'moved' | 'failed' | 'reverted' | 'revert_failed';
  reason?: string;
  /** worktree: the mirror admin dir whose `gitdir` file points back at it (null = standalone repo) */
  adminDir?: string | null;
  /** worktree: the DB worktreePath before the move (restored by the revert) */
  dbPathBefore?: string | null;
  /** files (relative to the worktree) whose absolute paths were rewritten */
  rewrote?: string[];
  /** mirror: the attached worktree `.git` files rewritten (absolute) */
  attached?: string[];
}
export interface MigrationManifest {
  runId: string;
  userId: string;
  key: string;
  root: string;
  createdAt: string;
  mirrors: boolean;
  items: MigrationItem[];
}

export interface MigrationDeps {
  root: string;
  sessionsOf: (userId: string) => Promise<Array<{ id: string; projectId: string | null; status: string; worktreePath: string | null }>>;
  projectsOwnedBy: (userId: string) => Promise<string[]>;
  /** owners of the given sessions (missing id = no row) */
  ownersOf: (sessionIds: string[]) => Promise<Map<string, string>>;
  /** the subset of these sessions with a queued/running agent run or status 'running' */
  liveSessions: (sessionIds: string[]) => Promise<Set<string>>;
  setWorktreePath: (sessionId: string, p: string | null) => Promise<void>;
  /** session run-lock (NX); false = held elsewhere */
  lock: (sessionId: string) => Promise<boolean>;
  unlock: (sessionId: string) => Promise<void>;
  stopContainer: (sessionId: string) => Promise<void>;
  /** `git rev-parse --git-dir` (cwd) succeeds? */
  gitOk: (cwd: string) => Promise<boolean>;
  record: (meta: Record<string, unknown>, sessionId?: string) => void;
  log: (line: string) => void;
}

const isRealDir = (p: string): boolean => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
const isSymlink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** `gitdir: X` of a linked worktree's `.git` FILE, or null. */
function gitdirOf(wt: string): string | null {
  try {
    const st = lstatSync(path.join(wt, '.git'));
    if (!st.isFile()) return null;
    const m = readFileSync(path.join(wt, '.git'), 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    return m ? m[1] : null;
  } catch { return null; }
}

/** The worktrees attached to a bare mirror: [{ adminDir, gitFile }] from `<mirror>/worktrees/<name>/gitdir`. */
async function attachedWorktrees(mirror: string): Promise<Array<{ adminDir: string; gitFile: string }>> {
  const out: Array<{ adminDir: string; gitFile: string }> = [];
  const dir = path.join(mirror, 'worktrees');
  let names: string[] = [];
  try { names = await fs.readdir(dir); } catch { return out; }
  for (const n of names) {
    const adminDir = path.join(dir, n);
    const gitFile = await fs.readFile(path.join(adminDir, 'gitdir'), 'utf8').then((t) => t.trim()).catch(() => '');
    if (gitFile) out.push({ adminDir, gitFile });
  }
  return out;
}

/** The session id a worktree path belongs to (`…/worktrees/<sid>` legacy or per-user). */
function sessionIdOfWorktree(wt: string): string | null {
  const parts = wt.split('/').filter(Boolean);
  const i = parts.lastIndexOf('worktrees');
  return i >= 0 && parts[i + 1] ? parts[i + 1] : null;
}

// ── Plan (read-only) ─────────────────────────────────────────────────────────

export async function planUserMigration(userId: string, deps: MigrationDeps, opts: { mirrors?: boolean } = {}): Promise<{ key: string; items: MigrationItem[]; error?: string }> {
  const root = deps.root;
  const key = userSubtreeKey(userId);
  const owner = subtreeOwnerSync(key, root);
  if (owner && owner !== userId) return { key, items: [], error: `subtree ${key} belongs to another user` };
  const sessions = await deps.sessionsOf(userId);
  const live = await deps.liveSessions(sessions.map((s) => s.id));
  const items: MigrationItem[] = [];
  for (const s of sessions) {
    const from = legacyWorktreePath(s.id, root);
    if (isRealDir(from)) {
      const to = subtreeWorktreePath(key, s.id, root);
      const it: MigrationItem = { kind: 'worktree', sessionId: s.id, projectId: s.projectId ?? undefined, from, to, status: 'planned', dbPathBefore: s.worktreePath };
      if (live.has(s.id)) { it.status = 'skipped'; it.reason = 'live_run'; } else if (existsSync(to)) { it.status = 'skipped'; it.reason = 'dest_exists'; }
      items.push(it);
    }
    const homeFrom = legacySandboxHome(s.id, root);
    if (isRealDir(homeFrom)) {
      const homeTo = subtreeSandboxHome(key, s.id, root);
      const it: MigrationItem = { kind: 'home', sessionId: s.id, from: homeFrom, to: homeTo, status: 'planned' };
      if (live.has(s.id)) { it.status = 'skipped'; it.reason = 'live_run'; } else if (existsSync(homeTo)) { it.status = 'skipped'; it.reason = 'dest_exists'; }
      items.push(it);
    }
  }
  if (opts.mirrors) {
    for (const pid of await deps.projectsOwnedBy(userId)) {
      const from = legacyMirrorPath(pid, root);
      if (!isRealDir(from)) continue;
      const to = subtreeMirrorPath(key, pid, root);
      const it: MigrationItem = { kind: 'mirror', projectId: pid, from, to, status: 'planned' };
      const attached = await attachedWorktrees(from);
      const sids = attached.map((a) => sessionIdOfWorktree(path.dirname(a.gitFile))).filter((x): x is string => !!x);
      const owners = await deps.ownersOf(sids);
      const liveAttached = await deps.liveSessions(sids);
      if (existsSync(to)) { it.status = 'skipped'; it.reason = 'dest_exists'; }
      else if (sids.some((sid) => owners.get(sid) !== userId)) { it.status = 'skipped'; it.reason = 'shared_with_other_users'; }
      else if (liveAttached.size) { it.status = 'skipped'; it.reason = 'live_run'; }
      items.push(it);
    }
  }
  return { key, items };
}

// ── Path rewrites (absolute paths baked into the worktree) ───────────────────

const MAX_REWRITE_BYTES = 2 * 1024 * 1024;

/** Replace `from` → `to` in one text file; true when it changed. Binary / huge files are left alone. */
async function rewriteFile(file: string, from: string, to: string): Promise<boolean> {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > MAX_REWRITE_BYTES) return false;
    const buf = await fs.readFile(file);
    if (buf.includes(0)) return false; // binary
    const text = buf.toString('utf8');
    if (!text.includes(from)) return false;
    await fs.writeFile(file, text.split(from).join(to));
    return true;
  } catch { return false; }
}

/**
 * The files of a worktree that carry its absolute path: `.digby/session/env.sh`
 * ($DIGBY_ENV) and Python venvs (a dir with pyvenv.cfg up to two levels deep:
 * pyvenv.cfg + bin/* scripts). Relative paths. Bounded.
 */
async function pathBearingFiles(wt: string): Promise<string[]> {
  const out: string[] = [];
  if (existsSync(path.join(wt, '.digby', 'session', 'env.sh'))) out.push('.digby/session/env.sh');
  const venvs: string[] = [];
  const scan = async (rel: string, depth: number) => {
    if (depth > 2) return;
    let ents: import('fs').Dirent[] = [];
    try { ents = await fs.readdir(path.join(wt, rel), { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => e.isFile() && e.name === 'pyvenv.cfg')) { venvs.push(rel); return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name === '.git' || e.name === 'node_modules') continue;
      await scan(rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  await scan('', 0);
  for (const v of venvs) {
    out.push(v ? `${v}/pyvenv.cfg` : 'pyvenv.cfg');
    const bin = path.join(wt, v, 'bin');
    let ents: string[] = [];
    try { ents = await fs.readdir(bin); } catch { /* no bin */ }
    for (const n of ents.slice(0, 400)) out.push(v ? `${v}/bin/${n}` : `bin/${n}`);
  }
  return out;
}

async function rewriteAll(wt: string, rels: string[], from: string, to: string): Promise<string[]> {
  const done: string[] = [];
  for (const r of rels) if (await rewriteFile(path.join(wt, r), from, to)) done.push(r);
  return done;
}

// ── Apply ────────────────────────────────────────────────────────────────────

async function writeIfPointsAt(file: string, expected: string, next: string): Promise<boolean> {
  const cur = await fs.readFile(file, 'utf8').catch(() => null);
  if (cur === null || cur.trim().replace(/^gitdir:\s*/, '') !== expected) return false;
  await fs.writeFile(file, cur.startsWith('gitdir:') ? `gitdir: ${next}\n` : `${next}\n`);
  return true;
}

async function moveWorktree(it: MigrationItem, home: MigrationItem | undefined, deps: MigrationDeps): Promise<void> {
  const sid = it.sessionId!;
  if (!(await deps.lock(sid))) { it.status = 'skipped'; it.reason = 'run_lock_held'; if (home) { home.status = 'skipped'; home.reason = 'run_lock_held'; } return; }
  try {
    if ((await deps.liveSessions([sid])).size) { it.status = 'skipped'; it.reason = 'live_run'; if (home) { home.status = 'skipped'; home.reason = 'live_run'; } return; }
    await deps.stopContainer(sid).catch(() => {});
    const gitdir = gitdirOf(it.from);
    it.adminDir = gitdir;
    await fs.mkdir(path.dirname(it.to), { recursive: true });
    await fs.rename(it.from, it.to);
    let linkFixed = false;
    try {
      if (gitdir) linkFixed = await writeIfPointsAt(path.join(gitdir, 'gitdir'), path.join(it.from, '.git'), path.join(it.to, '.git'));
      await fs.symlink(path.relative(path.dirname(it.from), it.to), it.from);
      it.rewrote = await rewriteAll(it.to, await pathBearingFiles(it.to), it.from, it.to);
      if (!(await deps.gitOk(it.to))) throw new Error('git rev-parse failed in the moved worktree');
    } catch (err: any) {
      // Roll THIS item back — never leave an orphaned lane.
      await rewriteAll(it.to, it.rewrote ?? [], it.to, it.from).catch(() => {});
      if (isSymlink(it.from)) await fs.unlink(it.from).catch(() => {});
      await fs.rename(it.to, it.from).catch(() => {});
      if (gitdir && linkFixed) await writeIfPointsAt(path.join(gitdir, 'gitdir'), path.join(it.to, '.git'), path.join(it.from, '.git')).catch(() => {});
      it.status = 'failed'; it.reason = String(err?.message ?? err).slice(0, 160); it.rewrote = [];
      if (home) { home.status = 'skipped'; home.reason = 'worktree_move_failed'; }
      return;
    }
    if (it.dbPathBefore) await deps.setWorktreePath(sid, it.to);
    forgetPlacement(sid);
    noteWorktreePlacement(sid, it.to);
    it.status = 'moved';
    if (home && home.status === 'planned') await moveHome(home);
  } finally {
    await deps.unlock(sid);
  }
}

async function moveHome(home: MigrationItem): Promise<void> {
  try {
    await fs.mkdir(path.dirname(home.to), { recursive: true });
    await fs.rename(home.from, home.to);
    home.status = 'moved';
  } catch (err: any) {
    home.status = 'failed'; home.reason = String(err?.message ?? err).slice(0, 160);
  }
}

async function moveMirror(it: MigrationItem, deps: MigrationDeps): Promise<void> {
  const attached = await attachedWorktrees(it.from);
  const sids = Array.from(new Set(attached.map((a) => sessionIdOfWorktree(path.dirname(a.gitFile))).filter((x): x is string => !!x)));
  const locked: string[] = [];
  try {
    for (const sid of sids) {
      if (!(await deps.lock(sid))) { it.status = 'skipped'; it.reason = 'run_lock_held'; return; }
      locked.push(sid);
    }
    if ((await deps.liveSessions(sids)).size) { it.status = 'skipped'; it.reason = 'live_run'; return; }
    for (const sid of sids) await deps.stopContainer(sid).catch(() => {});
    await fs.mkdir(path.dirname(it.to), { recursive: true });
    await fs.rename(it.from, it.to);
    const rewritten: Array<{ gitFile: string; was: string; now: string }> = [];
    try {
      for (const a of attached) {
        const name = path.basename(a.adminDir);
        const was = path.join(it.from, 'worktrees', name);
        const now = path.join(it.to, 'worktrees', name);
        if (await writeIfPointsAt(a.gitFile, was, now)) rewritten.push({ gitFile: a.gitFile, was, now });
      }
      await fs.symlink(path.relative(path.dirname(it.from), it.to), it.from);
      for (const a of attached) {
        const wt = path.dirname(a.gitFile);
        if (existsSync(wt) && !(await deps.gitOk(wt))) throw new Error(`git failed in attached worktree ${sessionIdOfWorktree(wt) ?? wt}`);
      }
    } catch (err: any) {
      for (const r of rewritten) await writeIfPointsAt(r.gitFile, r.now, r.was).catch(() => {});
      if (isSymlink(it.from)) await fs.unlink(it.from).catch(() => {});
      await fs.rename(it.to, it.from).catch(() => {});
      it.status = 'failed'; it.reason = String(err?.message ?? err).slice(0, 160);
      return;
    }
    it.attached = rewritten.map((r) => r.gitFile);
    forgetPlacement(undefined, it.projectId);
    noteMirrorPlacement(it.projectId!, it.to);
    it.status = 'moved';
  } finally {
    for (const sid of locked) await deps.unlock(sid);
  }
}

export function migrationManifestPath(root: string, runId: string): string {
  return path.join(root, '.digby-layout-migrations', `${runId}.json`);
}

async function saveManifest(m: MigrationManifest): Promise<string> {
  const file = migrationManifestPath(m.root, m.runId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(m, null, 2)}\n`);
  return file;
}

/** Execute a plan (worktrees + their homes first, then standalone homes, then mirrors). Writes the manifest. */
export async function applyUserMigration(userId: string, plan: { key: string; items: MigrationItem[] }, deps: MigrationDeps, runId: string, opts: { mirrors?: boolean } = {}): Promise<{ manifest: MigrationManifest; manifestFile: string }> {
  ensureUserSubtreeSync(userId, deps.root);
  const manifest: MigrationManifest = { runId, userId, key: plan.key, root: deps.root, createdAt: new Date().toISOString(), mirrors: !!opts.mirrors, items: plan.items.map((i) => ({ ...i })) };
  const homes = new Map(manifest.items.filter((i) => i.kind === 'home').map((i) => [i.sessionId!, i]));
  for (const it of manifest.items.filter((i) => i.kind === 'worktree' && i.status === 'planned')) {
    await moveWorktree(it, homes.get(it.sessionId!), deps);
    deps.record({ phase: 'migration', action: 'move', what: 'worktree', outcome: it.status, reason: it.reason, runId }, it.sessionId);
    deps.log(`${it.status.padEnd(8)} worktree ${it.sessionId} ${it.reason ?? ''}`);
  }
  for (const h of manifest.items.filter((i) => i.kind === 'home' && i.status === 'planned')) {
    // A home whose worktree was NOT in this plan (reaped worktree): own lock + live re-check.
    if (!(await deps.lock(h.sessionId!))) { h.status = 'skipped'; h.reason = 'run_lock_held'; continue; }
    try {
      if ((await deps.liveSessions([h.sessionId!])).size) { h.status = 'skipped'; h.reason = 'live_run'; continue; }
      await deps.stopContainer(h.sessionId!).catch(() => {});
      await moveHome(h);
    } finally { await deps.unlock(h.sessionId!); }
  }
  for (const h of manifest.items.filter((i) => i.kind === 'home')) {
    deps.record({ phase: 'migration', action: 'move', what: 'home', outcome: h.status, reason: h.reason, runId }, h.sessionId);
  }
  if (opts.mirrors) {
    for (const it of manifest.items.filter((i) => i.kind === 'mirror' && i.status === 'planned')) {
      await moveMirror(it, deps);
      deps.record({ phase: 'migration', action: 'move', what: 'mirror', projectId: it.projectId, outcome: it.status, reason: it.reason, runId });
      deps.log(`${it.status.padEnd(8)} mirror ${it.projectId} ${it.reason ?? ''}`);
    }
  }
  const counts = countByStatus(manifest.items);
  deps.record({ phase: 'migration', action: 'summary', runId, ...counts });
  return { manifest, manifestFile: await saveManifest(manifest) };
}

function countByStatus(items: MigrationItem[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const i of items) c[i.status] = (c[i.status] ?? 0) + 1;
  return c;
}

// ── Revert ───────────────────────────────────────────────────────────────────

/** Replay a manifest backwards (mirrors first, then homes, then worktrees). Writes the updated manifest. */
export async function revertMigration(manifest: MigrationManifest, deps: MigrationDeps, opts: { apply?: boolean } = {}): Promise<{ manifest: MigrationManifest; planned: MigrationItem[] }> {
  const moved = manifest.items.filter((i) => i.status === 'moved');
  const order = [...moved.filter((i) => i.kind === 'mirror'), ...moved.filter((i) => i.kind === 'home'), ...moved.filter((i) => i.kind === 'worktree')];
  if (!opts.apply) return { manifest, planned: order };
  for (const it of order) {
    const sids = it.kind === 'mirror'
      ? Array.from(new Set((it.attached ?? []).map((g) => sessionIdOfWorktree(path.dirname(g))).filter((x): x is string => !!x)))
      : [it.sessionId!];
    const locked: string[] = [];
    try {
      let ok = true;
      for (const sid of sids) { if (await deps.lock(sid)) locked.push(sid); else { ok = false; break; } }
      if (!ok || (await deps.liveSessions(sids)).size) { it.reason = 'revert_deferred_live'; continue; }
      for (const sid of sids) await deps.stopContainer(sid).catch(() => {});
      if (isSymlink(it.from)) await fs.unlink(it.from);
      await fs.rename(it.to, it.from);
      if (it.kind === 'mirror') {
        // The attached worktrees' `.git` files point into the moved mirror — point them back.
        for (const g of it.attached ?? []) {
          const cur = await fs.readFile(g, 'utf8').catch(() => '');
          const m = cur.match(/^gitdir:\s*(.+?)\s*$/m);
          if (m && m[1].startsWith(`${it.to}/`)) await fs.writeFile(g, `gitdir: ${it.from}${m[1].slice(it.to.length)}\n`);
        }
        forgetPlacement(undefined, it.projectId);
      } else if (it.kind === 'worktree') {
        // The admin dir was recorded at its pre-move (legacy-mirror) path —
        // valid again once mirrors are reverted first (the order above), and
        // reachable through the mirror's compatibility link otherwise.
        if (it.adminDir) await writeIfPointsAt(path.join(it.adminDir, 'gitdir'), path.join(it.to, '.git'), path.join(it.from, '.git'));
        await rewriteAll(it.from, it.rewrote ?? [], it.to, it.from);
        if (it.dbPathBefore !== undefined) await deps.setWorktreePath(it.sessionId!, it.dbPathBefore ?? null);
        forgetPlacement(it.sessionId);
      }
      it.status = 'reverted';
    } catch (err: any) {
      it.status = 'revert_failed'; it.reason = String(err?.message ?? err).slice(0, 160);
    } finally {
      for (const sid of locked) await deps.unlock(sid);
      deps.record({ phase: 'migration', action: 'revert', what: it.kind, outcome: it.status, reason: it.reason, runId: manifest.runId }, it.sessionId);
    }
  }
  await saveManifest(manifest);
  return { manifest, planned: order };
}

// ── Census (read-only verification) ──────────────────────────────────────────

export interface UserWorkspaceCensus {
  userId: string;
  key: string;
  sessions: number;
  legacyWorktrees: number;
  perUserWorktrees: number;
  compatLinks: number;
  danglingCompatLinks: string[];
  brokenWorktrees: string[];
  legacyHomes: number;
  perUserHomes: number;
  /** a live session whose DB path names a legacy link instead of its physical home (the run-executor normalizes it on the next run) */
  dbPathStale: number;
}

/** Census of one user's workspace layout + git health (the canary's "0 orphans" check). Read-only. */
export async function userWorkspaceCensus(userId: string, deps: MigrationDeps): Promise<UserWorkspaceCensus> {
  const root = deps.root;
  const key = userSubtreeKey(userId);
  const sessions = await deps.sessionsOf(userId);
  const c: UserWorkspaceCensus = { userId, key, sessions: sessions.length, legacyWorktrees: 0, perUserWorktrees: 0, compatLinks: 0, danglingCompatLinks: [], brokenWorktrees: [], legacyHomes: 0, perUserHomes: 0, dbPathStale: 0 };
  for (const s of sessions) {
    const legacy = legacyWorktreePath(s.id, root);
    if (isSymlink(legacy)) {
      c.compatLinks++;
      if (!existsSync(legacy)) c.danglingCompatLinks.push(s.id);
    }
    const wt = resolveWorktreePathSync(s.id, root);
    if (existsSync(wt)) {
      if (pathSubtreeKey(wt, root)) c.perUserWorktrees++; else c.legacyWorktrees++;
      if (!(await deps.gitOk(wt))) c.brokenWorktrees.push(s.id);
      if (s.worktreePath && s.worktreePath !== wt && s.status !== 'archived') c.dbPathStale++;
    }
    if (isRealDir(legacySandboxHome(s.id, root))) c.legacyHomes++;
    if (isRealDir(subtreeSandboxHome(key, s.id, root))) c.perUserHomes++;
  }
  return c;
}

// ── Production deps (prisma + redis run-lock + docker) ───────────────────────

export async function defaultMigrationDeps(runId: string, root = LAYOUT_ROOT): Promise<MigrationDeps> {
  const prisma = (await import('../../../config/database')).default as any;
  const lockMod = await import('./session-run-lock');
  // 2026-10-11: the one-shot CLI (workerq.sh) never boots the app, so the shared Redis client was never
  // connected — acquireSessionRunLock swallowed "client closed" and EVERY item read run_lock_held (the
  // canary users' first --apply moved nothing). Connect it here; an unreachable Redis now fails the run
  // loudly instead of masquerading as held locks.
  await (await import('../../../config/redis')).connectRedis();
  const token = `workspace-migration-${process.pid}:${runId}`;
  const { git } = await import('./workspace.service');
  return {
    root,
    sessionsOf: async (userId) => prisma.chatCodingState.findMany({ where: { userId }, select: { id: true, projectId: true, status: true, worktreePath: true } }),
    projectsOwnedBy: async (userId) => (await prisma.crossModelProject.findMany({ where: { userId }, select: { id: true } })).map((p: any) => p.id),
    ownersOf: async (ids) => {
      if (!ids.length) return new Map();
      const rows = await prisma.chatCodingState.findMany({ where: { id: { in: ids } }, select: { id: true, userId: true } });
      return new Map(rows.map((r: any) => [r.id, r.userId]));
    },
    liveSessions: async (ids) => {
      if (!ids.length) return new Set();
      const runs = await prisma.agentRun.findMany({ where: { sessionId: { in: ids }, status: { in: ['queued', 'running'] } }, select: { sessionId: true } });
      const running = await prisma.chatCodingState.findMany({ where: { id: { in: ids }, status: 'running' }, select: { id: true } });
      // (The session run-lock is checked by ACQUIRING it before every move — `lock` below.)
      return new Set<string>([...runs.map((r: any) => r.sessionId), ...running.map((r: any) => r.id)]);
    },
    setWorktreePath: async (id, p) => { await prisma.chatCodingState.update({ where: { id }, data: { worktreePath: p } }); },
    lock: (id) => lockMod.acquireSessionRunLock(id, token),
    unlock: (id) => lockMod.releaseSessionRunLock(id, token),
    stopContainer: async (id) => { await (await import('./container.service')).stopSessionContainer(id); },
    gitOk: (cwd) => git(['rev-parse', '--git-dir'], cwd, 30_000).then(() => true).catch(() => false),
    record: (meta, sessionId) => {
      void import('../platform/loop-metrics.service')
        .then((m) => m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.WORKSPACE_ISOLATION, sessionId, meta }))
        .catch(() => {});
    },
    log: (line) => console.log(line),
  };
}

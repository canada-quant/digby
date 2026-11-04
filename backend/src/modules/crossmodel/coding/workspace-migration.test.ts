/**
 * build 2026-10-08 ISO — the per-user migration (workspace-migration.ts)
 * against REAL git on a tmp volume shaped like box C's: one legacy mirror
 * shared by user A's two sessions and user B's one, sandbox homes, a
 * $DIGBY_ENV file and a Python venv carrying absolute worktree paths.
 * Pins: dry-run writes nothing; a live run / a held run-lock is skipped; a
 * moved worktree keeps working (both git link directions + a compatibility
 * link); absolute paths are rewritten; a shared mirror never moves; a
 * failed verify rolls the item back (no orphan); the revert restores
 * everything; the census counts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  planUserMigration, applyUserMigration, revertMigration, userWorkspaceCensus, migrationManifestPath,
  type MigrationDeps,
} from './workspace-migration';
import { userSubtreeKey, resolveWorktreePathSync, __resetLayoutMemoForTest } from './workspace-layout';

const A = '808aeb11-2222-4333-8444-555566667777';
const B = 'ffe3c1aa-0000-4000-8000-000000000009';
const KA = userSubtreeKey(A);
const git = (args: string[], cwd: string): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
const gitOk = async (cwd: string) => { try { git(['rev-parse', '--git-dir'], cwd); git(['rev-parse', 'HEAD'], cwd); return true; } catch { return false; } };

let root: string;
let db: Map<string, { userId: string; projectId: string | null; status: string; worktreePath: string | null }>;
let live: Set<string>;
let locked: Set<string>;
let stopped: string[];
let rows: any[];

function mkDeps(over: Partial<MigrationDeps> = {}): MigrationDeps {
  return {
    root,
    sessionsOf: async (u) => [...db.entries()].filter(([, s]) => s.userId === u).map(([id, s]) => ({ id, projectId: s.projectId, status: s.status, worktreePath: s.worktreePath })),
    projectsOwnedBy: async (u) => (u === A ? ['pa', 'pshared'] : []),
    ownersOf: async (ids) => new Map(ids.filter((i) => db.has(i)).map((i) => [i, db.get(i)!.userId])),
    liveSessions: async (ids) => new Set(ids.filter((i) => live.has(i))),
    setWorktreePath: async (id, p) => { db.get(id)!.worktreePath = p; },
    lock: async (id) => !locked.has(id),
    unlock: async () => {},
    stopContainer: async (id) => { stopped.push(id); },
    gitOk,
    record: (meta, sessionId) => rows.push({ meta, sessionId }),
    log: () => {},
    ...over,
  };
}

function legacyWorktree(mirror: string, sid: string): string {
  const wt = path.join(root, 'worktrees', sid);
  git(['worktree', 'add', '-q', '-b', `digby/session-${sid}`, wt, 'main'], mirror);
  return wt;
}

beforeEach(() => {
  __resetLayoutMemoForTest();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-mig-'));
  const up = path.join(root, '..', `${path.basename(root)}-up`);
  fs.mkdirSync(up);
  git(['init', '-q', '-b', 'main'], up);
  fs.writeFileSync(path.join(up, 'a.txt'), 'x\n');
  git(['add', '.'], up);
  git(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], up);
  fs.mkdirSync(path.join(root, 'repos'), { recursive: true });
  fs.mkdirSync(path.join(root, 'worktrees', '.sandbox-home'), { recursive: true });
  // pshared: A's project whose mirror B also has a worktree on (a shared project); pa: only A.
  git(['clone', '-q', '--bare', up, path.join(root, 'repos', 'pshared.git')], root);
  git(['clone', '-q', '--bare', up, path.join(root, 'repos', 'pa.git')], root);
  const a1 = legacyWorktree(path.join(root, 'repos', 'pshared.git'), 'a1');
  legacyWorktree(path.join(root, 'repos', 'pshared.git'), 'a2');
  legacyWorktree(path.join(root, 'repos', 'pshared.git'), 'b1');
  legacyWorktree(path.join(root, 'repos', 'pa.git'), 'a3');
  fs.mkdirSync(path.join(root, 'worktrees', '.sandbox-home', 'a1', '.aws'), { recursive: true });
  fs.mkdirSync(path.join(a1, '.digby', 'session'), { recursive: true });
  fs.writeFileSync(path.join(a1, '.digby', 'session', 'env.sh'), `export PATH=${a1}/.venv/bin:$PATH\n`);
  fs.mkdirSync(path.join(a1, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(a1, '.venv', 'pyvenv.cfg'), `home = /usr/bin\ncommand = python -m venv ${a1}/.venv\n`);
  fs.writeFileSync(path.join(a1, '.venv', 'bin', 'pip'), `#!${a1}/.venv/bin/python\nimport sys\n`);
  db = new Map([
    ['a1', { userId: A, projectId: 'pshared', status: 'ready', worktreePath: a1 }],
    ['a2', { userId: A, projectId: 'pshared', status: 'ready', worktreePath: path.join(root, 'worktrees', 'a2') }],
    ['a3', { userId: A, projectId: 'pa', status: 'archived', worktreePath: path.join(root, 'worktrees', 'a3') }],
    ['b1', { userId: B, projectId: 'pshared', status: 'ready', worktreePath: path.join(root, 'worktrees', 'b1') }],
  ]);
  live = new Set(); locked = new Set(); stopped = []; rows = [];
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(`${root}-up`, { recursive: true, force: true });
});

describe('plan (dry run)', () => {
  it('lists the user\'s worktrees + homes, skips a live run, writes NOTHING', async () => {
    live.add('a2');
    const before = fs.readdirSync(root).sort();
    const plan = await planUserMigration(A, mkDeps(), { mirrors: true });
    expect(plan.key).toBe(KA);
    const by = (k: string, id: string) => plan.items.find((i) => i.kind === k && (i.sessionId === id || i.projectId === id));
    expect(by('worktree', 'a1')).toMatchObject({ status: 'planned', to: path.join(root, KA, 'worktrees', 'a1') });
    expect(by('worktree', 'a2')).toMatchObject({ status: 'skipped', reason: 'live_run' });
    expect(by('home', 'a1')).toMatchObject({ status: 'planned' });
    expect(by('mirror', 'pshared')).toMatchObject({ status: 'skipped', reason: 'shared_with_other_users' });
    expect(by('mirror', 'pa')).toMatchObject({ status: 'planned' });
    expect(plan.items.some((i) => i.sessionId === 'b1')).toBe(false); // never another user's
    expect(fs.readdirSync(root).sort()).toEqual(before);
    expect(stopped).toEqual([]);
  });
});

describe('apply', () => {
  it('moves worktree + home, keeps git working both ways, leaves a compat link, rewrites absolute paths, updates the DB', async () => {
    const deps = mkDeps();
    const plan = await planUserMigration(A, deps);
    const { manifest, manifestFile } = await applyUserMigration(A, plan, deps, 'run1');
    const a1 = manifest.items.find((i) => i.kind === 'worktree' && i.sessionId === 'a1')!;
    expect(a1.status).toBe('moved');
    const to = path.join(root, KA, 'worktrees', 'a1');
    expect(await gitOk(to)).toBe(true);
    expect(git(['worktree', 'list', '--porcelain'], path.join(root, 'repos', 'pshared.git'))).toContain(to);
    expect(fs.lstatSync(path.join(root, 'worktrees', 'a1')).isSymbolicLink()).toBe(true);
    __resetLayoutMemoForTest();
    expect(resolveWorktreePathSync('a1', root)).toBe(to);
    expect(fs.readFileSync(path.join(to, '.digby', 'session', 'env.sh'), 'utf8')).toContain(`${to}/.venv/bin`);
    expect(fs.readFileSync(path.join(to, '.venv', 'bin', 'pip'), 'utf8')).toContain(`#!${to}/.venv/bin/python`);
    expect(a1.rewrote).toEqual(expect.arrayContaining(['.digby/session/env.sh', '.venv/pyvenv.cfg', '.venv/bin/pip']));
    expect(db.get('a1')!.worktreePath).toBe(to);
    expect(fs.existsSync(path.join(root, KA, '.sandbox-home', 'a1', '.aws'))).toBe(true);
    expect(stopped).toEqual(expect.arrayContaining(['a1', 'a2', 'a3']));
    expect(await gitOk(path.join(root, 'worktrees', 'b1'))).toBe(true); // B untouched, still on the shared mirror
    expect(fs.lstatSync(path.join(root, 'worktrees', 'b1')).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(manifestFile)).toBe(true);
    expect(manifestFile).toBe(migrationManifestPath(root, 'run1'));
    expect(rows.find((r) => r.meta.action === 'summary').meta).toMatchObject({ phase: 'migration', moved: 4 }); // a1 a2 a3 + a1 home
  });

  it('re-checks under the lock: a held run-lock or a run that went live after planning is skipped', async () => {
    const deps = mkDeps();
    const plan = await planUserMigration(A, deps);
    locked.add('a1');
    live.add('a2');
    const { manifest } = await applyUserMigration(A, plan, deps, 'run2');
    expect(manifest.items.find((i) => i.kind === 'worktree' && i.sessionId === 'a1')).toMatchObject({ status: 'skipped', reason: 'run_lock_held' });
    expect(manifest.items.find((i) => i.kind === 'worktree' && i.sessionId === 'a2')).toMatchObject({ status: 'skipped', reason: 'live_run' });
    expect(fs.lstatSync(path.join(root, 'worktrees', 'a1')).isDirectory()).toBe(true);
    expect(stopped).not.toContain('a1');
  });

  it('a failed verify ROLLS THE ITEM BACK — never an orphaned lane', async () => {
    const deps = mkDeps({ gitOk: async (cwd) => !cwd.includes(`${KA}/worktrees/a1`) && gitOk(cwd) });
    const plan = await planUserMigration(A, deps);
    const { manifest } = await applyUserMigration(A, plan, deps, 'run3');
    expect(manifest.items.find((i) => i.kind === 'worktree' && i.sessionId === 'a1')).toMatchObject({ status: 'failed' });
    const legacy = path.join(root, 'worktrees', 'a1');
    expect(fs.lstatSync(legacy).isDirectory()).toBe(true);
    expect(await gitOk(legacy)).toBe(true);
    expect(fs.readFileSync(path.join(legacy, '.digby', 'session', 'env.sh'), 'utf8')).toContain(`${legacy}/.venv/bin`);
    expect(db.get('a1')!.worktreePath).toBe(legacy);
    expect(manifest.items.find((i) => i.kind === 'home' && i.sessionId === 'a1')).toMatchObject({ status: 'skipped', reason: 'worktree_move_failed' });
  });

  it('--mirrors moves only an UNSHARED mirror and re-links its worktrees', async () => {
    const deps = mkDeps();
    const plan = await planUserMigration(A, deps, { mirrors: true });
    const { manifest } = await applyUserMigration(A, plan, deps, 'run4', { mirrors: true });
    expect(manifest.items.find((i) => i.kind === 'mirror' && i.projectId === 'pa')).toMatchObject({ status: 'moved' });
    expect(manifest.items.find((i) => i.kind === 'mirror' && i.projectId === 'pshared')).toMatchObject({ status: 'skipped' });
    const a3 = path.join(root, KA, 'worktrees', 'a3');
    expect(fs.readFileSync(path.join(a3, '.git'), 'utf8')).toContain(path.join(root, KA, 'repos', 'pa.git'));
    expect(await gitOk(a3)).toBe(true);
    expect(fs.lstatSync(path.join(root, 'repos', 'pa.git')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(root, 'repos', 'pshared.git')).isDirectory()).toBe(true);
  });
});

describe('revert + census', () => {
  it('the revert restores every moved item (paths, links, rewrites, DB) and the census sees 0 orphans', async () => {
    const deps = mkDeps();
    const plan = await planUserMigration(A, deps, { mirrors: true });
    const { manifest } = await applyUserMigration(A, plan, deps, 'run5', { mirrors: true });
    const mid = await userWorkspaceCensus(A, deps);
    expect(mid).toMatchObject({ perUserWorktrees: 3, legacyWorktrees: 0, compatLinks: 3, brokenWorktrees: [], danglingCompatLinks: [], perUserHomes: 1 });

    const dry = await revertMigration(JSON.parse(JSON.stringify(manifest)), deps);
    expect(dry.planned.length).toBeGreaterThan(0);
    expect(fs.lstatSync(path.join(root, 'worktrees', 'a1')).isSymbolicLink()).toBe(true); // dry run changed nothing

    const movedCount = manifest.items.filter((i) => i.status === 'moved').length;
    expect(movedCount).toBe(5); // a1 a2 a3 + a1's home + the pa mirror
    const r = await revertMigration(manifest, deps, { apply: true });
    expect(r.manifest.items.filter((i) => i.status === 'reverted').length).toBe(movedCount);
    expect(r.manifest.items.some((i) => i.status === 'revert_failed')).toBe(false);
    for (const sid of ['a1', 'a2', 'a3']) {
      const legacy = path.join(root, 'worktrees', sid);
      expect(fs.lstatSync(legacy).isDirectory()).toBe(true);
      expect(await gitOk(legacy)).toBe(true);
      expect(db.get(sid)!.worktreePath).toBe(legacy);
    }
    expect(fs.lstatSync(path.join(root, 'repos', 'pa.git')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(root, 'worktrees', 'a1', '.digby', 'session', 'env.sh'), 'utf8')).toContain(`${path.join(root, 'worktrees', 'a1')}/.venv/bin`);
    expect(fs.existsSync(path.join(root, 'worktrees', '.sandbox-home', 'a1', '.aws'))).toBe(true);
    __resetLayoutMemoForTest();
    const after = await userWorkspaceCensus(A, deps);
    expect(after).toMatchObject({ perUserWorktrees: 0, legacyWorktrees: 3, compatLinks: 0, brokenWorktrees: [] });
  });

  it('a key held by another user refuses the whole run', async () => {
    fs.mkdirSync(path.join(root, KA), { recursive: true });
    fs.writeFileSync(path.join(root, KA, '.digby-user-subtree'), JSON.stringify({ userId: 'someone-else' }));
    const plan = await planUserMigration(A, mkDeps());
    expect(plan.error).toMatch(/another user/);
    expect(plan.items).toEqual([]);
  });
});

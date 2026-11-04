/**
 * Integration tests (REAL git in tmp dirs) for the 812767b7 durability fix:
 * snapshotWorktreeGitState captures the checked-out branch + uncommitted work
 * into mirror-side refs that survive the worktree dir being wiped (deploys
 * recreate containers); reattachWorktree then rebuilds on the agent's actual
 * branch and re-applies the wip state instead of rolling the session back to
 * its own branch tip with a clean tree.
 *
 * CODING_WORKSPACE_ROOT is overridden BEFORE the module is required (it is read
 * at module load), so the mirror + worktrees land in the tmp dir.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-ws-restore-'));
process.env.CODING_WORKSPACE_ROOT = ROOT;

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// project-lock (new workspace.service dependency, todo fed7731d) pulls
// config/redis → config/env (process.exit at import) — same boundary mock.
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ws = require('./workspace.service') as typeof import('./workspace.service');

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();

const PROJECT = 'proj-restore';
let remote: string;

beforeAll(() => {
  // A tiny stand-in for the GitHub remote: one commit on main.
  const seed = path.join(ROOT, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  git(['init', '-b', 'main'], seed);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
  git(['add', '-A'], seed);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'], seed);
  remote = path.join(ROOT, 'remote.git');
  git(['clone', '--bare', seed, remote], ROOT);
}, 30_000);

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('worktree durability across wipes (812767b7)', () => {
  test('rebuilds on the agent branch with uncommitted work restored', async () => {
    const sessionId = 's-dirty';
    const sessionBranch = 'digby/session-s-dirty';
    // Provision like the run-start path does.
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', sessionBranch, null);
    // The agent cuts a feature branch and makes uncommitted edits: a tracked
    // modification plus a brand-new untracked file.
    git(['checkout', '-b', 'digby/feedback-x'], wt);
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\nTWO\n');
    fs.writeFileSync(path.join(wt, 'new.ts'), 'export const x = 1;\n');

    const snap = await ws.snapshotWorktreeGitState(wt, sessionId);
    expect(snap).toEqual({ branch: 'digby/feedback-x', wip: expect.any(String) });

    // The wipe: deploy recreates the container and the worktree dir is gone.
    fs.rmSync(wt, { recursive: true, force: true });

    const wt2 = await ws.reattachWorktree(PROJECT, sessionId, remote, 'main', sessionBranch, null, snap);
    expect(wt2).toBe(wt);
    expect(git(['branch', '--show-current'], wt2)).toBe('digby/feedback-x');
    expect(fs.readFileSync(path.join(wt2, 'a.txt'), 'utf8')).toBe('one\nTWO\n');
    expect(fs.readFileSync(path.join(wt2, 'new.ts'), 'utf8')).toBe('export const x = 1;\n');
    // Successful apply consumes the wip ref — a later reattach must not re-apply it.
    expect(() => git(['rev-parse', '--verify', `refs/digby-wip/${sessionId}`], wt2)).toThrow();
  }, 30_000);

  test('snapshot never mutates the agent-visible index (checkpoint-safety)', async () => {
    const sessionId = 's-index';
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', 'digby/session-s-index', null);
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\nTWO\n');
    fs.writeFileSync(path.join(wt, 'new.ts'), 'export const y = 2;\n');
    // Pre-snapshot: nothing staged, worktree dirty.
    expect(git(['diff', '--cached', '--name-only'], wt)).toBe('');
    const statusBefore = git(['status', '--porcelain'], wt);

    const snap = await ws.snapshotWorktreeGitState(wt, sessionId);
    expect(snap?.wip).toEqual(expect.any(String));

    // The real index is untouched: still nothing staged, status identical.
    expect(git(['diff', '--cached', '--name-only'], wt)).toBe('');
    expect(git(['status', '--porcelain'], wt)).toBe(statusBefore);
    // No temp index files leak into the workspace root.
    expect(fs.readdirSync(ROOT).filter((f) => f.startsWith('.snap-index-'))).toEqual([]);
  }, 30_000);

  test('an EMBEDDED repo without a checked-out commit no longer kills the snapshot — it is excluded, the rest is captured (tick 10, session 421938f3)', async () => {
    const sessionId = 's-embedded';
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', 'digby/session-s-embedded', null);
    // The lane's own uncommitted work…
    fs.writeFileSync(path.join(wt, 'notes.md'), 'keep me\n');
    // …plus a nested clone with no commit (what `git add -A` refuses: "does
    // not have a commit checked out / fatal: adding files failed").
    const nested = path.join(wt, 'audit-pack12');
    fs.mkdirSync(nested, { recursive: true });
    git(['init', '-b', 'main'], nested);
    fs.writeFileSync(path.join(nested, 'data.jsonl'), '{"x":1}\n');
    expect(() => git(['add', '-A'], wt)).toThrow(/does not have a commit checked out/);

    const snap = await ws.snapshotWorktreeGitState(wt, sessionId);
    expect(snap).toEqual({ branch: 'digby/session-s-embedded', wip: expect.any(String) });
    // The stash carries the lane's file and NOT the embedded repo (staged via
    // the temp index, so it lives in the stash commit's own tree — `stash
    // create` has no ^3 untracked parent).
    const tree = git(['ls-tree', '-r', '--name-only', snap!.wip!], wt).split('\n');
    expect(tree).toContain('notes.md');
    expect(tree.some((f) => f.startsWith('audit-pack12'))).toBe(false);
    // The agent-visible index is still untouched.
    expect(git(['diff', '--cached', '--name-only'], wt)).toBe('');
  }, 30_000);

  test('clean tree snapshots wip:null and clears any stale wip ref', async () => {
    const sessionId = 's-clean';
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', 'digby/session-s-clean', null);
    // Plant a stale wip ref, then snapshot a clean tree — it must be deleted.
    const tip = git(['rev-parse', 'HEAD'], wt);
    git(['update-ref', `refs/digby-wip/${sessionId}`, tip], wt);
    const snap = await ws.snapshotWorktreeGitState(wt, sessionId);
    expect(snap).toEqual({ branch: 'digby/session-s-clean', wip: null });
    expect(() => git(['rev-parse', '--verify', `refs/digby-wip/${sessionId}`], wt)).toThrow();
  }, 30_000);

  test('missing snapshot branch falls back to the session branch; no-restore keeps old behavior', async () => {
    const sessionId = 's-fallback';
    const sessionBranch = 'digby/session-s-fallback';
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', sessionBranch, null);
    fs.rmSync(wt, { recursive: true, force: true });
    const wt2 = await ws.reattachWorktree(PROJECT, sessionId, remote, 'main', sessionBranch, null, {
      branch: 'digby/does-not-exist',
      wip: null,
    });
    expect(git(['branch', '--show-current'], wt2)).toBe(sessionBranch);

    // And without a snapshot (legacy checkpoint), behavior is unchanged.
    const sessionId2 = 's-legacy';
    const sessionBranch2 = 'digby/session-s-legacy';
    const wtA = await ws.ensureWorktree(PROJECT, sessionId2, remote, 'main', sessionBranch2, null);
    fs.rmSync(wtA, { recursive: true, force: true });
    const wtB = await ws.reattachWorktree(PROJECT, sessionId2, remote, 'main', sessionBranch2, null);
    expect(git(['branch', '--show-current'], wtB)).toBe(sessionBranch2);
  }, 30_000);

  test('dangling gitdir link: existing broken worktree is rebuilt from the mirror (#142)', async () => {
    const sessionId = 's-dangling';
    const sessionBranch = 'digby/session-s-dangling';
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', sessionBranch, null);
    expect(git(['rev-parse', '--git-dir'], wt)).toBeTruthy(); // healthy baseline

    // Break it exactly like prod: the .git file points at a mirror-side admin
    // dir that no longer exists (mirror re-cloned / project changed).
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: /nonexistent/dead-mirror/worktrees/${sessionId}\n`);
    expect(() => git(['rev-parse', '--git-dir'], wt)).toThrow();

    // Reattach must detect the broken repo, remove it, and rebuild on the
    // session branch — not return the stale dir.
    const wt2 = await ws.reattachWorktree(PROJECT, sessionId, remote, 'main', sessionBranch, null);
    expect(wt2).toBe(wt);
    expect(git(['branch', '--show-current'], wt2)).toBe(sessionBranch);
    expect(fs.readFileSync(path.join(wt2, 'a.txt'), 'utf8')).toBe('one\n');
  }, 30_000);

  test('non-repo worktree dir (botched provisioning) is rebuilt too (#142)', async () => {
    const sessionId = 's-notrepo';
    const sessionBranch = 'digby/session-s-notrepo';
    // Make the branch exist in the mirror, then replace the worktree with a
    // plain directory that has no .git at all (the "empty worktree" mode).
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', sessionBranch, null);
    fs.rmSync(wt, { recursive: true, force: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, 'stray.txt'), 'orphan\n');
    expect(() => git(['rev-parse', '--git-dir'], wt)).toThrow();

    const wt2 = await ws.reattachWorktree(PROJECT, sessionId, remote, 'main', sessionBranch, null);
    expect(git(['branch', '--show-current'], wt2)).toBe(sessionBranch);
    expect(fs.existsSync(path.join(wt2, 'stray.txt'))).toBe(false); // rebuilt clean
    expect(fs.readFileSync(path.join(wt2, 'a.txt'), 'utf8')).toBe('one\n');
  }, 30_000);

  test('healthy existing worktree is reused untouched — uncommitted work survives (#142)', async () => {
    const sessionId = 's-healthy';
    const sessionBranch = 'digby/session-s-healthy';
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', sessionBranch, null);
    fs.writeFileSync(path.join(wt, 'keep.txt'), 'precious\n'); // uncommitted work
    const wt2 = await ws.reattachWorktree(PROJECT, sessionId, remote, 'main', sessionBranch, null);
    expect(wt2).toBe(wt);
    expect(fs.readFileSync(path.join(wt2, 'keep.txt'), 'utf8')).toBe('precious\n');
  }, 30_000);
});

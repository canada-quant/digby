/**
 * Checkpoint snapshot hardening (autonomy loop #16, 2026-09-21):
 *   - a git `add` killed by a signal (the worker box's OOM killer) is retried
 *     ONCE after a pause and the checkpoint still lands;
 *   - two concurrent snapshots for ONE session coalesce onto a single git walk
 *     (live: two checkpoints 16 ms apart both died the same way).
 * git is intercepted at child_process.execFile; the filesystem is a no-op.
 */
process.env.CODING_WORKSPACE_ROOT = '/tmp/digby-wt-coalesce-test';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) } }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
const mockRecordLoopMetric = jest.fn(async () => {});
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => (mockRecordLoopMetric as any)(...a),
  LOOP_METRIC_KINDS: { WORKTREE_SNAPSHOT_FAILED: 'worktree_snapshot_failed', WORKTREE_SNAPSHOT_COALESCED: 'worktree_snapshot_coalesced' },
}));
jest.mock('fs/promises', () => ({
  mkdir: jest.fn(async () => undefined),
  access: jest.fn(async () => { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }),
  copyFile: jest.fn(async () => undefined),
  unlink: jest.fn(async () => undefined),
  readFile: jest.fn(async () => { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }),
  writeFile: jest.fn(async () => undefined),
  rm: jest.fn(async () => undefined),
  stat: jest.fn(async () => { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }),
  lstat: jest.fn(async () => { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }),
  readdir: jest.fn(async () => []),
}));

const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: any[]) => execFileMock(...args) }));

import { snapshotWorktreeGitState } from './workspace.service';
import logger from '../../../utils/logger';

/** git router: per-args behaviour; `addFailures` = how many `add` calls fail with a SIGKILL shape first; `addDelayMs` slows `add`. */
function routeGit(opts: { addFailures?: number; addDelayMs?: number } = {}) {
  let addFailures = opts.addFailures ?? 0;
  const calls: string[][] = [];
  execFileMock.mockImplementation((_cmd: string, args: string[], _o: any, cb: any) => {
    calls.push(args);
    const done = (err: any, stdout = '') => cb(err, { stdout, stderr: '' });
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return done(null, 'main\n');
    if (args[0] === 'rev-parse' && args[1] === '--git-path') return done(null, '.git/index\n');
    if (args[0] === 'add') {
      const fail = addFailures > 0;
      if (fail) addFailures -= 1;
      const finish = () => (fail
        ? done(Object.assign(new Error('Command failed: git add -A -- .\n'), { stderr: '', code: null, signal: 'SIGKILL', killed: false }))
        : done(null, ''));
      if (opts.addDelayMs) setTimeout(finish, opts.addDelayMs); else finish();
      return;
    }
    if (args[0] === 'stash' && args[1] === 'create') return done(null, 'abc123\n');
    if (args[0] === 'update-ref') return done(null, '');
    return done(null, '');
  });
  return calls;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('snapshotWorktreeGitState — killed-add retry + per-session coalesce (loop #16)', () => {
  it('a SIGKILLed `git add` is retried once after a pause and the checkpoint lands (branch + wip)', async () => {
    const calls = routeGit({ addFailures: 1 });
    const t0 = Date.now();
    const snap = await snapshotWorktreeGitState('/tmp/digby-wt-coalesce-test/worktrees/k1', 'k1');
    expect(snap).toEqual({ branch: 'main', wip: 'abc123' });
    expect(calls.filter((a) => a[0] === 'add')).toHaveLength(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400); // the 1.5 s pause
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'worktree_snapshot_failed' }));
  });

  it('a second SIGKILL (retry exhausted) fails classified: warn names [killed] + signal, metric meta carries code/signal, result null', async () => {
    const calls = routeGit({ addFailures: 2 });
    const snap = await snapshotWorktreeGitState('/tmp/digby-wt-coalesce-test/worktrees/k2', 'k2');
    expect(snap).toBeNull();
    expect(calls.filter((a) => a[0] === 'add')).toHaveLength(2);
    expect((logger.warn as jest.Mock).mock.calls.some((c: any[]) => /worktree snapshot failed for k2 \[killed\]: git was killed by SIGKILL/.test(String(c[0])))).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'worktree_snapshot_failed', sessionId: 'k2', meta: { class: 'killed', code: null, signal: 'SIGKILL' } }));
  });

  it('two concurrent snapshots for ONE session share a single git walk; a different session runs its own', async () => {
    const calls = routeGit({ addDelayMs: 60 });
    const [a, b, c] = await Promise.all([
      snapshotWorktreeGitState('/tmp/digby-wt-coalesce-test/worktrees/k3', 'k3'),
      snapshotWorktreeGitState('/tmp/digby-wt-coalesce-test/worktrees/k3', 'k3'),
      snapshotWorktreeGitState('/tmp/digby-wt-coalesce-test/worktrees/k4', 'k4'),
    ]);
    expect(a).toEqual({ branch: 'main', wip: 'abc123' });
    expect(b).toBe(a); // the very same result object — no second walk
    expect(c).toEqual({ branch: 'main', wip: 'abc123' });
    expect(calls.filter((x) => x[0] === 'stash' && x[1] === 'create')).toHaveLength(2); // k3 once, k4 once
    await new Promise((r) => setTimeout(r, 20));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'worktree_snapshot_coalesced', sessionId: 'k3' }));
    // after completion a NEW snapshot for k3 starts a fresh walk
    await snapshotWorktreeGitState('/tmp/digby-wt-coalesce-test/worktrees/k3', 'k3');
    expect(calls.filter((x) => x[0] === 'stash' && x[1] === 'create')).toHaveLength(3);
  });
});

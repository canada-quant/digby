/**
 * Firing 3 (2026-09-22): the killed-add retry must RESEED the temp index.
 *
 * Live defect (session e083ff2e, 3× on 2026-09-22 07:48/09:22/10:26Z): a
 * `git add -A` against the throwaway GIT_INDEX_FILE died to the worker box's
 * OOM killer (SIGKILL — no cleanup), leaking `<tmpIndex>.lock`. The loop-#16
 * killed-retry then reused GIT_INDEX_FILE verbatim and died INSTANTLY on
 * `Unable to create '<tmpIndex>.lock': File exists` (exit 128 → class
 * 'other') — the retry was dead on arrival, ~1.7 s after the kill (kill +
 * the 1.5 s pause + instant abort). The checkpoint was lost even though the
 * retry existed precisely to save it.
 *
 * These pins assert the fix: before a killed (or unstable) retry, the stale
 * `<tmpIndex>.lock` is unlinked and the real index re-copied; and the
 * snapshot's finally unlinks the LOCK too (the litter that accumulated on
 * box C since August).
 */
process.env.CODING_WORKSPACE_ROOT = '/tmp/digby-wt-lock-reseed-test';

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

import * as fsp from 'fs/promises';
import { snapshotWorktreeGitState } from './workspace.service';

/** The git call router: `add` fails with the SIGKILL shape `addFailures` times; records GIT_INDEX_FILE per call. */
function routeGit(opts: { addFailures?: number } = {}) {
  let addFailures = opts.addFailures ?? 0;
  const addIndexFiles: (string | undefined)[] = [];
  execFileMock.mockImplementation((_cmd: string, args: string[], o: any, cb: any) => {
    const done = (err: any, stdout = '') => cb(err, { stdout, stderr: '' });
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return done(null, 'main\n');
    if (args[0] === 'rev-parse' && args[1] === '--git-path') return done(null, '.git/index\n');
    if (args[0] === 'add') {
      addIndexFiles.push(o?.env?.GIT_INDEX_FILE);
      const fail = addFailures > 0;
      if (fail) addFailures -= 1;
      return fail
        ? done(Object.assign(new Error('Command failed: git add -A -- .\n'), { stderr: '', code: null, signal: 'SIGKILL', killed: false }))
        : done(null, '');
    }
    if (args[0] === 'stash' && args[1] === 'create') return done(null, 'abc123\n');
    if (args[0] === 'update-ref') return done(null, '');
    return done(null, '');
  });
  return addIndexFiles;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('snapshotWorktreeGitState — killed-add retry reseeds the temp index (firing 3)', () => {
  it('after a SIGKILLed add, the stale <tmpIndex>.lock is unlinked and the real index re-copied BEFORE the retry', async () => {
    const addIndexFiles = routeGit({ addFailures: 1 });
    const snap = await snapshotWorktreeGitState('/tmp/digby-wt-lock-reseed-test/worktrees/r1', 'r1');
    expect(snap).toEqual({ branch: 'main', wip: 'abc123' });
    expect(addIndexFiles).toHaveLength(2);
    // both attempts use the SAME throwaway index — the fix is not a new path
    expect(addIndexFiles[0]).toBe(addIndexFiles[1]);
    const tmpIndex = addIndexFiles[0] as string;
    expect(tmpIndex).toMatch(/\/\.snap-index-r1-/);
    // RESEED: the leaked lock was unlinked and the real index re-copied
    expect(fsp.unlink).toHaveBeenCalledWith(`${tmpIndex}.lock`);
    expect((fsp.copyFile as jest.Mock).mock.calls.filter((c: any[]) => c[1] === tmpIndex)).toHaveLength(2);
  });

  it('the finally cleans BOTH the index and its lock (the August litter class)', async () => {
    const addIndexFiles = routeGit({ addFailures: 0 });
    await snapshotWorktreeGitState('/tmp/digby-wt-lock-reseed-test/worktrees/r2', 'r2');
    const tmpIndex = addIndexFiles[0] as string;
    const unlinked = (fsp.unlink as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    expect(unlinked).toContain(tmpIndex);
    expect(unlinked).toContain(`${tmpIndex}.lock`);
  });

  it('a retry that fails AGAIN with the lock-exists shape is still classified and does not loop', async () => {
    // attempt 0: SIGKILL; attempt 1 (after reseed): exit 128 lock-exists — the
    // pre-fix live shape, now reachable only if the lock reappears mid-retry.
    let addCalls = 0;
    execFileMock.mockImplementation((_cmd: string, args: string[], o: any, cb: any) => {
      const done = (err: any, stdout = '') => cb(err, { stdout, stderr: '' });
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return done(null, 'main\n');
      if (args[0] === 'rev-parse' && args[1] === '--git-path') return done(null, '.git/index\n');
      if (args[0] === 'add') {
        addCalls++;
        if (addCalls === 1) return done(Object.assign(new Error('Command failed: git add -A -- .\n'), { stderr: '', code: null, signal: 'SIGKILL' }));
        return done(Object.assign(new Error("Command failed: git add -A -- .\nfatal: Unable to create 'x.lock': File exists."), { stderr: "fatal: Unable to create 'x.lock': File exists.", code: 128, signal: null }));
      }
      if (args[0] === 'stash' && args[1] === 'create') return done(null, 'abc123\n');
      if (args[0] === 'update-ref') return done(null, '');
      return done(null, '');
    });
    const snap = await snapshotWorktreeGitState('/tmp/digby-wt-lock-reseed-test/worktrees/r3', 'r3');
    expect(snap).toBeNull();
    expect(addCalls).toBe(2); // exactly one retry — never a loop
  });
});

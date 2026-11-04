/**
 * Regression test for the 2026-10-20 + 2026-10-09 provisioning race (sessions
 * d66f78f9 / f0dd977c, FO lane 401b72f8): `git worktree add -b …` ran OUTSIDE
 * the cross-process project lock, so two same-project provisions started
 * milliseconds apart (63ms / 3.2s in prod) raced the shared bare mirror's ONE
 * config file — the loser died "could not lock config file config: File
 * exists / unable to write upstream branch configuration", flipped to
 * status='error', and its stashed first prompt was never delivered
 * (sweepPendingFirstPrompts only picks status:'ready' rows — d66f78f9 sat
 * parked 2h34m until a later dispatch healed it).
 *
 * The add now runs under withProjectLock (addWorktreeSerialized) with a
 * bounded retry on the transient git lock class. These tests prove:
 *   1. two concurrent same-project ensureWorktree calls take the project lock
 *      for their worktree ADD (2 lock bodies per call) and never overlap;
 *   2. a mirror config.lock held by an unrelated process is RETRIED past,
 *      not fatal (the prod error class, reproduced with a real lock file);
 *   3. fail-open posture is preserved (Redis down → in-process mutex only).
 *
 * REAL git against tmp dirs, same style as workspace-mirror-lock.test.ts: the
 * "remote" is a local bare repo passed by filesystem path.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// workspace.service reads CODING_WORKSPACE_ROOT / CODING_ENV_ROOT AT MODULE
// LOAD — point both at sibling tmp dirs before importing it.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-ws-wt-lock-'));
process.env.CODING_WORKSPACE_ROOT = ROOT;
const ENV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-ws-wt-lock-env-'));
process.env.CODING_ENV_ROOT = ENV_ROOT;

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ws = require('./workspace.service') as typeof import('./workspace.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const projectLock = require('./project-lock') as typeof import('./project-lock');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const redisMock = require('../../../config/redis').default as { set: jest.Mock; eval: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const loggerMock = require('../../../utils/logger').default as { warn: jest.Mock };

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();

let remote: string;

beforeAll(() => {
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
  fs.rmSync(ENV_ROOT, { recursive: true, force: true });
});

// ── Serialization instrumentation (workspace-mirror-lock.test.ts pattern) ────
interface Interval { enter: number; exit: number }

const realWithProjectLock = projectLock.withProjectLock;

const instrumentWithProjectLock = (intervals: Interval[]) => {
  let clock = 0;
  return jest.spyOn(projectLock, 'withProjectLock').mockImplementation(
    <T,>(projectId: string, fn: () => Promise<T>): Promise<T> =>
      realWithProjectLock(projectId, async () => {
        const rec: Interval = { enter: ++clock, exit: 0 };
        intervals.push(rec);
        try {
          return await fn();
        } finally {
          rec.exit = ++clock;
        }
      }),
  );
};

describe('worktree add is serialized + retried (2026-10-20 config-lock race)', () => {
  test('two concurrent same-project provisions both take the project lock for their worktree add, non-overlapping', async () => {
    const intervals: Interval[] = [];
    const spy = instrumentWithProjectLock(intervals);
    loggerMock.warn.mockClear();
    try {
      const [w1, w2] = await Promise.all([
        ws.ensureWorktree('p-race', 's-race-1', remote, 'main', 'digby/session-s-race-1', null),
        ws.ensureWorktree('p-race', 's-race-2', remote, 'main', 'digby/session-s-race-2', null),
      ]);
      // (i) both worktrees exist and are usable git repos
      expect(git(['rev-parse', '--is-inside-work-tree'], w1)).toBe('true');
      expect(git(['rev-parse', '--is-inside-work-tree'], w2)).toBe('true');
      // (ii) both branches exist in the shared mirror
      const mirror = ws.repoMirrorPath('p-race');
      expect(git(['rev-parse', '--verify', 'digby/session-s-race-1'], mirror)).toBeTruthy();
      expect(git(['rev-parse', '--verify', 'digby/session-s-race-2'], mirror)).toBeTruthy();
      // (iii) TWO lock bodies per call (mirror refresh + the worktree ADD itself)
      // — the add is what the fix moves under the lock. The first session's
      // setWorktreeIdentity `git config` runs OUTSIDE the lock and writes the
      // mirror's common config, so on a loaded runner it can hold config.lock
      // while the second add runs: that add is retried, and each bounded retry
      // re-enters the lock once (CI 2026-10-21 saw 5 calls). Only those logged
      // retries may add a call.
      const retries = loggerMock.warn.mock.calls.filter(c => /worktree add hit a git config lock/.test(String(c[0]))).length;
      expect(spy).toHaveBeenCalledTimes(4 + retries);
      expect(spy.mock.calls.every(c => c[0] === 'p-race')).toBe(true);
      // (iv) same-project lock bodies never overlap (in-process mutex layer).
      const sorted = [...intervals].sort((a, b) => a.enter - b.enter);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].enter).toBeGreaterThan(sorted[i - 1].exit);
      }
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  test('a mirror config.lock held by an unrelated process is retried past, not fatal (the prod error class)', async () => {
    // Warm the mirror so refs/remotes/origin/main exists: the first call
    // clones (--mirror, heads only); the SECOND runs the fetch path that
    // populates remote-tracking refs. Prod mirrors always have it — that is
    // why the worktree add writes upstream branch config (into the mirror's
    // COMMON config file) at all, and thus why the config.lock contends.
    await ws.ensureRepoMirror('p-retry', remote);
    await ws.ensureRepoMirror('p-retry', remote);
    const mirror = ws.repoMirrorPath('p-retry');
    expect(git(['rev-parse', '--verify', 'origin/main'], mirror)).toBeTruthy();

    // Hold the mirror's config lock exactly like a concurrent git process
    // would (reaper prune / another session's `git config` — a linked
    // worktree's plain config write goes to the COMMON config file, proven
    // in the 2026-10-20 repro).
    const lockPath = path.join(mirror, 'config.lock');
    fs.writeFileSync(lockPath, '');
    const provisioning = ws.ensureWorktree('p-retry', 's-retry', remote, 'main', 'digby/session-s-retry', null);
    // Release it shortly after the first attempt fails — the bounded retry
    // (500ms backoff, 8 attempts) must bridge this gap and succeed.
    const release = setTimeout(() => { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } }, 300);
    try {
      const wt = await provisioning;
      expect(git(['rev-parse', '--is-inside-work-tree'], wt)).toBe('true');
      // The branch survived the failed attempt + retry cleanup cycle
      // (a failed `worktree add -b` leaves the branch ref behind — the
      // retry must delete it or die "already exists").
      expect(git(['rev-parse', '--verify', 'digby/session-s-retry'], mirror)).toBeTruthy();
    } finally {
      clearTimeout(release);
      try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    }
  }, 60_000);

  test('a lock that never releases surfaces the real error after the bounded retries (no infinite loop)', async () => {
    await ws.ensureRepoMirror('p-stuck', remote);
    await ws.ensureRepoMirror('p-stuck', remote);
    const mirror = ws.repoMirrorPath('p-stuck');
    const lockPath = path.join(mirror, 'config.lock');
    fs.writeFileSync(lockPath, '');
    try {
      await ws.ensureWorktree('p-stuck', 's-stuck', remote, 'main', 'digby/session-s-stuck', null);
      throw new Error('expected provisioning to fail');
    } catch (err: any) {
      // The ORIGINAL git error surfaces (redacted shape), not a hang — the
      // retry is bounded and the failure stays diagnosable.
      expect(String(err.message)).toMatch(/could not lock config file/i);
    } finally {
      try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    }
  }, 60_000);

  test('fail-open preserved: Redis down still provisions via the in-process mutex', async () => {
    redisMock.set.mockRejectedValue(new Error('redis down'));
    try {
      const wt = await ws.ensureWorktree('p-failopen', 's-failopen', remote, 'main', 'digby/session-s-failopen', null);
      expect(git(['rev-parse', '--is-inside-work-tree'], wt)).toBe('true');
    } finally {
      redisMock.set.mockResolvedValue('OK');
    }
  }, 60_000);
});

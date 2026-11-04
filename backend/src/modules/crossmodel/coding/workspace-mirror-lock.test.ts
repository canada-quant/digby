/**
 * Regression test for todo fed7731d / PR #252 review: ensureRepoMirror's
 * clone/fetch paths mutate the SHARED per-project bare mirror
 * (${CODING_WORKSPACE_ROOT}/repos/<projectId>.git) with no cross-process
 * serialization — web + worker + blue/green processes could race a
 * clone/fetch --prune on the same mirror. The whole mirror mutation now runs
 * under the cross-process project lock (project-lock.ts). These tests prove
 * concurrent provisions SERIALIZE: the lock-wrapped clone/fetch bodies never
 * overlap — with the Redis layer healthy, AND in the fail-open posture
 * (Redis down → in-process mutex alone still serializes within a process).
 *
 * REAL git against tmp dirs, same style as workspace-env.test.ts: the
 * "remote" is a local bare repo passed by filesystem path (ensureRepoMirror
 * does not URL-validate; `git clone --mirror <path>` works locally).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// workspace.service reads CODING_WORKSPACE_ROOT / CODING_ENV_ROOT AT MODULE
// LOAD and refuses to boot with the env store inside the workspace — point
// both at SIBLING tmp dirs before importing it (workspace-env.test.ts pattern).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-ws-mirror-lock-'));
process.env.CODING_WORKSPACE_ROOT = ROOT;
const ENV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-ws-mirror-envstore-'));
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

// ── Serialization instrumentation ────────────────────────────────────────────
// Spy on withProjectLock (ts-jest CommonJS interop: workspace.service's named
// import resolves through the module exports object at call time, so the spy
// intercepts it) with a wrapper that CALLS THROUGH to the real implementation
// while recording monotonic enter/exit markers around each wrapped body. If
// the two bodies serialize, one exit strictly precedes the other enter.
interface Interval { enter: number; exit: number }

// Captured BEFORE any spy is installed — always the genuine implementation.
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

const expectSerialized = (intervals: Interval[]) => {
  expect(intervals).toHaveLength(2);
  const [first, second] = [...intervals].sort((a, b) => a.enter - b.enter);
  expect(second.enter).toBeGreaterThan(first.exit); // no overlap
};

describe('ensureRepoMirror concurrent provisions serialize under the project lock (todo fed7731d)', () => {
  test('two concurrent ensureRepoMirror calls run their mirror mutations non-overlapping', async () => {
    const intervals: Interval[] = [];
    const spy = instrumentWithProjectLock(intervals);
    try {
      const [m1, m2] = await Promise.all([
        ws.ensureRepoMirror('p1', remote),
        ws.ensureRepoMirror('p1', remote),
      ]);
      // (i) both resolve to the same mirror path
      expect(m1).toBe(m2);
      expect(m1).toBe(ws.repoMirrorPath('p1'));
      // (ii) the mirror mutation went through the project lock for 'p1'
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls.every(c => c[0] === 'p1')).toBe(true);
      // (iii) the two wrapped bodies did NOT overlap
      expectSerialized(intervals);
      // (iv) the mirror exists on disk afterwards
      expect(fs.existsSync(m1)).toBe(true);
      expect(fs.existsSync(path.join(m1, 'HEAD'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  test('fail-open preserved: Redis down still serializes via the in-process mutex', async () => {
    redisMock.set.mockRejectedValue(new Error('redis down'));
    const intervals: Interval[] = [];
    const spy = instrumentWithProjectLock(intervals);
    try {
      const [m1, m2] = await Promise.all([
        ws.ensureRepoMirror('p2', remote),
        ws.ensureRepoMirror('p2', remote),
      ]);
      // Both still SUCCEED under the degraded lock…
      expect(m1).toBe(m2);
      expect(fs.existsSync(m1)).toBe(true);
      // …and the in-process mutex layer still serializes within one process.
      expectSerialized(intervals);
    } finally {
      spy.mockRestore();
      redisMock.set.mockResolvedValue('OK');
    }
  }, 30_000);
});

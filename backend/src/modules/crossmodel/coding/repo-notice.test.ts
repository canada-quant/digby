/**
 * I2a (repo-integrity remediation, 2026-09-09) — run-start [REPO NOTICE].
 *
 * Real incident: an external project's main ran as two divergent lines for
 * ~11 days; lanes kept cloning/building on the stale line and nothing at run
 * start said so. buildRepoDivergenceNotice compares origin/<base> against the
 * session branch's merge-base (best-effort fetch first) and returns a one-line
 * notice when the base has advanced by more than 20 commits.
 *
 * Real git repos in tmp (the tools.test.ts git fixture pattern).
 */

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

// Real git repos + a real fetch per test: 20+ sequential commits in beforeEach
// blow jest's 5s default on a loaded CI box (observed 2026-09-09: timeout kill
// → late git logging → "Cannot log after tests are done" + a red deploy gate).
jest.setTimeout(60_000);

import { buildRepoDivergenceNotice, resetRepoNoticeCache } from './workspace.service';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const g = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

describe('I2a: run-start divergence notice', () => {
  let origin: string;
  let wt: string;

  /** origin repo on main + a clone with a session branch cut at commit 1. */
  beforeEach(async () => {
    resetRepoNoticeCache();
    origin = await fs.mkdtemp(path.join(os.tmpdir(), 'i2a-origin-'));
    g(origin, ['init', '-q', '-b', 'main']);
    g(origin, ['config', 'user.email', 't@example.com']);
    g(origin, ['config', 'user.name', 't']);
    await fs.writeFile(path.join(origin, 'f.txt'), 'v1\n');
    g(origin, ['add', '.']);
    g(origin, ['commit', '-qm', 'c1']);

    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'i2a-clone-'));
    wt = path.join(parent, 'wt');
    execFileSync('git', ['clone', '-q', origin, wt], { stdio: 'pipe' });
    g(wt, ['config', 'user.email', 't@example.com']);
    g(wt, ['config', 'user.name', 't']);
    g(wt, ['checkout', '-q', '-b', 'digby/session-1']);
  });

  afterEach(async () => {
    await fs.rm(origin, { recursive: true, force: true });
    await fs.rm(path.dirname(wt), { recursive: true, force: true });
    resetRepoNoticeCache();
  });

  /** Advance origin/main by n commits. */
  const advanceOrigin = (n: number) => {
    for (let i = 0; i < n; i++) {
      execFileSync('bash', ['-c', `echo v${i + 2} >> f.txt`], { cwd: origin });
      g(origin, ['add', '.']);
      g(origin, ['commit', '-qm', `c${i + 2}`]);
    }
  };

  it('says nothing at or under the 20-commit threshold', async () => {
    advanceOrigin(20);
    await expect(buildRepoDivergenceNotice(wt, 'main')).resolves.toBe('');
  });

  it('emits ONE [REPO NOTICE] line with counts + tips past the threshold (fetches origin first)', async () => {
    advanceOrigin(25); // the fetch inside the notice is what sees these
    resetRepoNoticeCache();
    const notice = await buildRepoDivergenceNotice(wt, 'main');
    expect(notice).toContain('[REPO NOTICE]');
    expect(notice).toContain('origin/main has advanced 25 commits');
    const headSha = g(wt, ['rev-parse', 'HEAD']).trim().slice(0, 10);
    const baseSha = g(origin, ['rev-parse', 'main']).trim().slice(0, 10);
    expect(notice).toContain(`branch tip ${headSha}`);
    expect(notice).toContain(`origin/main tip ${baseSha}`);
    expect(notice).toContain('NEVER resolve a conflict by emptying a file');
    expect(notice.split('\n')).toHaveLength(1); // one line — injected into the repo-context block
  });

  it('is cached per worktree (a second call inside the TTL reuses the computed notice)', async () => {
    advanceOrigin(25);
    resetRepoNoticeCache();
    const first = await buildRepoDivergenceNotice(wt, 'main');
    expect(first).toContain('advanced 25 commits');
    advanceOrigin(5); // origin moves again…
    const second = await buildRepoDivergenceNotice(wt, 'main');
    expect(second).toBe(first); // …but the cached notice is reused (no refetch per delegate)
  });

  it('a missing base branch yields silence', async () => {
    advanceOrigin(30);
    resetRepoNoticeCache();
    await expect(buildRepoDivergenceNotice(wt, '')).resolves.toBe('');
  });

  it('a repo with no origin (blank standalone) degrades to silence, never throws', async () => {
    const blank = await fs.mkdtemp(path.join(os.tmpdir(), 'i2a-blank-'));
    try {
      g(blank, ['init', '-q', '-b', 'main']);
      await expect(buildRepoDivergenceNotice(blank, 'main')).resolves.toBe('');
    } finally {
      await fs.rm(blank, { recursive: true, force: true });
    }
  });
});

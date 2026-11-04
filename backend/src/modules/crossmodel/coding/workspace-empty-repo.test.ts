/**
 * Regression tests for the empty-upstream provisioning fix (2026-08-17):
 * ensureWorktree against a remote with ZERO commits used to die with
 * "fatal: invalid reference: HEAD" (git worktree add … HEAD on an unborn HEAD),
 * leaving the session stuck at coding.status=error (prod errlog 2026-08-16;
 * feedback tickets: empty-repo provisioning cluster). The fix seeds a
 * mirror-local initial commit on baseBranch when no base ref resolves, so
 * provisioning succeeds and the remote is never mutated.
 *
 * CODING_WORKSPACE_ROOT is overridden BEFORE the module is required (it is read
 * at module load), so the mirror + worktrees land in the tmp dir.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-ws-empty-'));
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

const PROJECT = 'proj-empty';
let remote: string;

beforeAll(() => {
  // An EMPTY bare remote — zero commits, unborn HEAD (the exact repro shape of
  // a freshly-created GitHub repo attached to a project).
  remote = path.join(ROOT, 'remote.git');
  git(['init', '--bare', '-b', 'main', remote], ROOT);
}, 30_000);

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('ensureWorktree against an EMPTY upstream repo', () => {
  test('provisions successfully by seeding a mirror-local initial commit', async () => {
    const sessionId = 's-empty-1';
    const sessionBranch = 'digby/session-s-empty-1';
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', sessionBranch, null);

    // Session branch checked out, rooted at the seeded initial commit.
    expect(git(['branch', '--show-current'], wt)).toBe(sessionBranch);
    expect(git(['rev-list', '--count', 'HEAD'], wt)).toBe('1');
    expect(git(['log', '--format=%s', 'HEAD'], wt)).toMatch(/seeded by Digby/);

    // The seed is mirror-LOCAL: the upstream remote is never mutated.
    expect(git(['for-each-ref', '--format=%(refname)'], remote)).toBe('');
  });

  test('a second session on the same project provisions off the seeded mirror', async () => {
    const wt2 = await ws.ensureWorktree(PROJECT, 's-empty-2', remote, 'main', 'digby/session-s-empty-2', null);
    expect(git(['branch', '--show-current'], wt2)).toBe('digby/session-s-empty-2');
    expect(git(['rev-list', '--count', 'HEAD'], wt2)).toBe('1');
  });

  test('startRef chaining still wins over the seed fallback', async () => {
    // A prior session branch is a local ref in the mirror — the existing
    // chaining path must keep priority over the empty-repo fallback.
    const wt3 = await ws.ensureWorktree(
      PROJECT, 's-empty-3', remote, 'main', 'digby/session-s-empty-3', null, 'digby/session-s-empty-1',
    );
    expect(git(['branch', '--show-current'], wt3)).toBe('digby/session-s-empty-3');
    expect(git(['rev-list', '--count', 'HEAD'], wt3)).toBe('1');
  });

  test('re-provisioning an existing worktree is a no-op (path reuse)', async () => {
    const again = await ws.ensureWorktree(PROJECT, 's-empty-1', remote, 'main', 'digby/session-s-empty-1', null);
    expect(git(['branch', '--show-current'], again)).toBe('digby/session-s-empty-1');
  });
});

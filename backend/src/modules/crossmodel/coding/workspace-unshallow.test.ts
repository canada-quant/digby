/**
 * Regression test for ticket b3a35131 (2026-09-14): a SHALLOW project mirror
 * (an ops re-clone with --depth / a disk-prune re-seed) silently broke git
 * archaeology in every session worktree — path-scoped `git log -- <path>`
 * stopped at the grafted shallow boundary (whose whole-tree diff made it look
 * like ONE unrelated commit touched every file), rev ranges died with
 * "unknown revision", and read roles (no shell) could not do per-file history
 * at all. ensureRepoMirror now detects a shallow mirror and heals it with a
 * full `fetch --unshallow` — pinned here against real git with a local
 * file:// remote (no network).
 *
 * CODING_WORKSPACE_ROOT is overridden BEFORE the module is required (it is read
 * at module load), so the mirror lands in the tmp dir.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-ws-unshallow-'));
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

const PROJECT = 'proj-shallow';
const COMMITS = 6;
let origin: string;
let mirror: string;

beforeAll(() => {
  // An "upstream" repo with COMMITS commits of real per-file history.
  origin = path.join(ROOT, 'origin');
  fs.mkdirSync(origin);
  git(['init', '-q', '-b', 'main'], origin);
  git(['config', 'user.email', 't@example.com'], origin);
  git(['config', 'user.name', 't'], origin);
  for (let i = 1; i <= COMMITS; i++) {
    fs.writeFileSync(path.join(origin, i % 2 ? 'a.txt' : 'b.txt'), `rev ${i}\n`);
    git(['add', '.'], origin);
    git(['commit', '-qm', `commit ${i}`], origin);
  }

  // Pre-seed the project's mirror as SHALLOW — the failure shape from prod
  // (clone --depth needs the file:// transport; a plain path hardlinks objects).
  mirror = path.join(ROOT, 'repos', `${PROJECT}.git`);
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  git(['clone', '-q', '--mirror', '--depth', '1', `file://${origin}`, mirror], ROOT);
  expect(git(['rev-parse', '--is-shallow-repository'], mirror)).toBe('true'); // premise
}, 60_000);

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('ensureRepoMirror against a SHALLOW existing mirror (b3a35131)', () => {
  test('heals to complete history via fetch --unshallow', async () => {
    await ws.ensureRepoMirror(PROJECT, `file://${origin}`, null);

    expect(git(['rev-parse', '--is-shallow-repository'], mirror)).toBe('false');
    // Full history reachable via the demoted remote ref layout.
    expect(git(['rev-list', '--count', 'refs/remotes/origin/main'], mirror)).toBe(String(COMMITS));
    // Per-file archaeology works again: the boundary-collapse is gone.
    const aLog = git(['log', '--format=%s', 'refs/remotes/origin/main', '--', 'a.txt'], mirror);
    expect(aLog.split('\n').filter(Boolean)).toHaveLength(Math.ceil(COMMITS / 2));
    expect(aLog).not.toContain('commit 2');
  }, 60_000);

  test('a second ensure is a cheap no-op (stays complete, no error)', async () => {
    await ws.ensureRepoMirror(PROJECT, `file://${origin}`, null);
    expect(git(['rev-parse', '--is-shallow-repository'], mirror)).toBe('false');
  }, 60_000);

  test('provisioning a worktree off the healed mirror exposes full history to the session', async () => {
    const wt = await ws.ensureWorktree(PROJECT, 's-unshallow-1', `file://${origin}`, 'main', 'digby/session-s-unshallow-1', null);
    expect(git(['rev-parse', '--is-shallow-repository'], wt)).toBe('false');
    expect(git(['rev-list', '--count', 'HEAD'], wt)).toBe(String(COMMITS));
    const scoped = git(['log', '--format=%s', 'HEAD', '--', 'b.txt'], wt);
    expect(scoped.split('\n').filter(Boolean)).toHaveLength(Math.floor(COMMITS / 2));
  }, 60_000);
});

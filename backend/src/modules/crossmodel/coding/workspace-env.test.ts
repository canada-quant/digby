/**
 * Integration tests (REAL git + fs in tmp dirs) for the 2026-08-20 env-seed
 * durability fix ("canlaw key wiped after deploys").
 *
 * The per-session env file (<wt>/.digby/session/env.sh — the $DIGBY_ENV agents
 * append exports to) is GIT-IGNORED (installWorktreeExcludes adds .digby/ to
 * info/exclude), so neither the checkpoint stash snapshot nor the reaper's
 * `git add -A` WIP commit ever carried it: reaping a worktree destroyed the
 * session's env seed and re-provision started empty. The fix keeps a sidecar
 * copy OUTSIDE git (session-env/<sessionId>.sh on the same volume), captured
 * at checkpoint/reap time and restored on every (re)provision path.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-ws-env-'));
process.env.CODING_WORKSPACE_ROOT = ROOT;
// The sidecar store lives OUTSIDE the workspace volume (its own root, mounted
// only into backend/worker in prod) — a SIBLING tmp dir here: the load-time
// guard in workspace.service refuses any CODING_ENV_ROOT inside the workspace.
const ENV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-ws-envstore-'));
process.env.CODING_ENV_ROOT = ENV_ROOT;

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

const PROJECT = 'proj-env';
let remote: string;

const ENV_CONTENT = 'export CANLAW_SA_PRIV_B64=dummy-test-value-not-a-secret\nexport PATH="$HOME/bin:$PATH"\n';
const envPath = (wt: string) => path.join(wt, '.digby', 'session', 'env.sh');
const sidecarPath = (sessionId: string) => path.join(ENV_ROOT, `${sessionId}.sh`);

const writeEnv = (wt: string, content = ENV_CONTENT) => {
  fs.mkdirSync(path.dirname(envPath(wt)), { recursive: true });
  fs.writeFileSync(envPath(wt), content);
};

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

describe('session env seed durability across worktree wipes (2026-08-20)', () => {
  test('env.sh is git-ignored (why git snapshots alone could never save it)', async () => {
    const wt = await ws.ensureWorktree(PROJECT, 's-ignored', remote, 'main', 'digby/session-s-ignored', null);
    writeEnv(wt);
    // The harness scratch exclude keeps .digby/ out of git status entirely —
    // so `git add -A` (reaper WIP + checkpoint stash) provably skips env.sh.
    expect(git(['status', '--porcelain'], wt)).toBe('');
    expect(git(['check-ignore', '.digby/session/env.sh'], wt)).toBe('.digby/session/env.sh');
  }, 30_000);

  test('checkpoint snapshot sidecars env.sh; wipe + reattach restores it verbatim', async () => {
    const sessionId = 's-roundtrip';
    const branch = `digby/session-${sessionId}`;
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', branch, null);
    writeEnv(wt);

    const snap = await ws.snapshotWorktreeGitState(wt, sessionId);
    expect(fs.existsSync(sidecarPath(sessionId))).toBe(true);
    expect(fs.readFileSync(sidecarPath(sessionId), 'utf8')).toBe(ENV_CONTENT);
    // Secret hygiene: the sidecar is owner-only.
    expect(fs.statSync(sidecarPath(sessionId)).mode & 0o777).toBe(0o600);

    // The wipe: reaper/deploy destroys the worktree (env.sh was never in git).
    fs.rmSync(wt, { recursive: true, force: true });

    const wt2 = await ws.reattachWorktree(PROJECT, sessionId, remote, 'main', branch, null, snap);
    expect(fs.readFileSync(envPath(wt2), 'utf8')).toBe(ENV_CONTENT);
  }, 30_000);

  test('restore NEVER overwrites a live env.sh (worktree copy wins)', async () => {
    const sessionId = 's-no-clobber';
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', `digby/session-${sessionId}`, null);
    writeEnv(wt, 'export OLD=1\n');
    await ws.persistSessionEnv(wt, sessionId);            // sidecar := OLD
    writeEnv(wt, 'export NEW=2\n');                       // live file moved on
    const restored = await ws.restoreSessionEnv(wt, sessionId);
    expect(restored).toBe(false);
    expect(fs.readFileSync(envPath(wt), 'utf8')).toBe('export NEW=2\n');
  }, 30_000);

  test('persist is a no-op without env.sh; removeSessionEnv deletes the sidecar', async () => {
    const sessionId = 's-lifecycle';
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', `digby/session-${sessionId}`, null);
    expect(await ws.persistSessionEnv(wt, sessionId)).toBe(false);
    expect(fs.existsSync(sidecarPath(sessionId))).toBe(false);
    writeEnv(wt);
    expect(await ws.persistSessionEnv(wt, sessionId)).toBe(true);
    expect(fs.existsSync(sidecarPath(sessionId))).toBe(true);
    await ws.removeSessionEnv(sessionId);
    expect(fs.existsSync(sidecarPath(sessionId))).toBe(false);
  }, 30_000);

  test('blank-project worktrees restore the env seed too', async () => {
    const sessionId = 's-blank';
    // Simulate a prior capture for a session whose worktree is gone entirely.
    fs.mkdirSync(path.dirname(sidecarPath(sessionId)), { recursive: true });
    fs.writeFileSync(sidecarPath(sessionId), ENV_CONTENT, { mode: 0o600 });
    const wt = await ws.ensureBlankWorktree(sessionId, 'main', `digby/session-${sessionId}`, null);
    expect(fs.readFileSync(envPath(wt), 'utf8')).toBe(ENV_CONTENT);
  }, 30_000);

  test('deleting env.sh CLEARS the sidecar — removed secrets never resurrect (review finding)', async () => {
    const sessionId = 's-revoke';
    const branch = `digby/session-${sessionId}`;
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', branch, null);
    writeEnv(wt);
    await ws.persistSessionEnv(wt, sessionId);
    expect(fs.existsSync(sidecarPath(sessionId))).toBe(true);

    // The user/agent revokes a leaked key by deleting the seed: the next
    // checkpoint must propagate the deletion, not keep the old sidecar.
    fs.rmSync(envPath(wt), { force: true });
    expect(await ws.persistSessionEnv(wt, sessionId)).toBe(false);
    expect(fs.existsSync(sidecarPath(sessionId))).toBe(false);

    // A later wipe+re-provision restores NOTHING — the revocation holds.
    fs.rmSync(wt, { recursive: true, force: true });
    const wt2 = await ws.reattachWorktree(PROJECT, sessionId, remote, 'main', branch, null, null);
    expect(fs.existsSync(envPath(wt2))).toBe(false);
  }, 30_000);

  test('P6 (B24/CanLaw B12) missing ≠ empty: a persist against a GONE worktree KEEPS the sidecar (the only surviving copy)', async () => {
    const sessionId = 's-p6-keep';
    const branch = `digby/session-${sessionId}`;
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', branch, null);
    writeEnv(wt);
    await ws.persistSessionEnv(wt, sessionId);
    expect(fs.existsSync(sidecarPath(sessionId))).toBe(true);

    // The WHOLE worktree is wiped (deploy/reap) and a straggling persist —
    // e.g. a reap pass over the already-gone dir — fires against it. Pre-P6
    // this DELETED the sidecar right before re-provision needed it.
    fs.rmSync(wt, { recursive: true, force: true });
    expect(await ws.persistSessionEnv(wt, sessionId)).toBe(false);
    expect(fs.existsSync(sidecarPath(sessionId))).toBe(true); // kept

    // Re-provision restores the seed from the surviving sidecar.
    const wt2 = await ws.reattachWorktree(PROJECT, sessionId, remote, 'main', branch, null, null);
    expect(fs.readFileSync(envPath(wt2), 'utf8')).toBe(ENV_CONTENT);
  }, 30_000);
});

describe('persist failure warn rate-limit (2026-08-22 EACCES log storm)', () => {
  // Root cause then: the coding_session_env named volume was root-owned while
  // the server runs as nodejs → every checkpoint's persistSessionEnv EACCES'd
  // and EACH failure logged a warn → 8,299 app_error_log rows/48h, masking all
  // other signal. The fix warns ONCE per session per process. Failure
  // injection here is deterministic and uid-independent: a DIRECTORY
  // pre-created at the sidecar DESTINATION path makes the final rename fail
  // (EISDIR — a file cannot be renamed over a directory) without any fs
  // monkey-patching. (Loop #8 made the tmp name unique per call, so the old
  // `<sid>.sh.<pid>.tmp` blocker no longer intercepts the copy.)
  const blockerFor = (sid: string) => sidecarPath(sid);

  test('a durable persist failure warns ONCE per session, never per attempt', async () => {
    const wt = path.join(ROOT, 'wt-ratelimit');
    fs.mkdirSync(wt, { recursive: true });
    writeEnv(wt);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loggerMock = require('../../../utils/logger').default;
    fs.mkdirSync(blockerFor('sid-rl-a'), { recursive: true });
    fs.mkdirSync(blockerFor('sid-rl-b'), { recursive: true });
    try {
      const before = loggerMock.warn.mock.calls.length;
      expect(await ws.persistSessionEnv(wt, 'sid-rl-a')).toBe(false);
      expect(await ws.persistSessionEnv(wt, 'sid-rl-a')).toBe(false);
      expect(await ws.persistSessionEnv(wt, 'sid-rl-a')).toBe(false);
      // Three failed attempts, ONE warn — the storm can't recur.
      expect(loggerMock.warn.mock.calls.length).toBe(before + 1);
      expect(loggerMock.warn.mock.calls[before][0]).toContain('suppressed');
      // The gate is per-SESSION, not global: a different session still warns.
      expect(await ws.persistSessionEnv(wt, 'sid-rl-b')).toBe(false);
      expect(loggerMock.warn.mock.calls.length).toBe(before + 2);
    } finally {
      fs.rmSync(blockerFor('sid-rl-a'), { recursive: true, force: true });
      fs.rmSync(blockerFor('sid-rl-b'), { recursive: true, force: true });
    }
  }, 30_000);

  test('the happy path still captures the sidecar verbatim after the change', async () => {
    const wt = path.join(ROOT, 'wt-healthy-persist');
    fs.mkdirSync(wt, { recursive: true });
    writeEnv(wt);
    expect(await ws.persistSessionEnv(wt, 'sid-healthy')).toBe(true);
    expect(fs.readFileSync(sidecarPath('sid-healthy'), 'utf8')).toBe(ENV_CONTENT);
  }, 30_000);
});

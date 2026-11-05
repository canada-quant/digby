/**
 * Tests for workspace.service pure helpers (branch naming + path layout).
 * The git-invoking functions are exercised by the prod E2E, not unit-mocked here.
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

import { sessionBranchName, worktreePath, CODING_WORKSPACE_ROOT } from './workspace.service';

describe('sessionBranchName', () => {
  test('derives a stable, git-safe branch from the session id', () => {
    const b = sessionBranchName('a1b2c3d4-1111-2222-3333-444455556666');
    expect(b).toBe('digby/session-a1b2c3d4');
    expect(b).toMatch(/^digby\/session-[0-9a-f]{8}$/);
  });
});

describe('worktreePath', () => {
  test('is rooted under the workspace root/worktrees', () => {
    const p = worktreePath('sess-123');
    expect(p).toBe(`${CODING_WORKSPACE_ROOT}/worktrees/sess-123`);
  });
});

// --- Ownership-drift hardening (nightly 2026-08-02) ---
// Runner containers used to execute git as root (stock node:20 default),
// leaving root-owned objects/paths in the shared volume; the backend (uid
// 1001) then failed snapshots with EACCES / "detected dubious ownership"
// (128 fails/48h). The complete fix runs the runner as uid 1001 (see
// container.service.ts BASE_CREATE, covered in container.service.test.ts);
// this side keeps defense-in-depth: subprocess-scoped safe.directory=* so
// backend git survives any residual drift window (legacy root-owned paths
// before the next entrypoint chown, root-started legacy containers).

const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: any[]) => execFileMock(...args) }));

// The ensureWorktree unit tests below only exercise the base-REF resolution
// logic — keep them off the real filesystem (WORKSPACE_ROOT defaults to
// /app/…, which does not exist on dev machines): mkdir succeeds, access
// rejects so pathExists() is false and provisioning always proceeds.
jest.mock('fs/promises', () => ({
  mkdir: jest.fn(async () => undefined),
  access: jest.fn(async () => { throw new Error('ENOENT'); }),
}));

import { git, ensureWorktree, ensureRepoMirror, repoMirrorPath, isUsableWorktree } from './workspace.service';

describe('git subprocess env (ownership-drift resilience)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) =>
      cb(null, { stdout: '', stderr: '' }),
    );
  });

  test('carries subprocess-scoped safe.directory=* config + the 58cb5dfc secrets-exclude file', async () => {
    await git(['status'], '/tmp/whatever');
    const opts = execFileMock.mock.calls[0][2];
    expect(opts.env.GIT_CONFIG_COUNT).toBe('2');
    expect(opts.env.GIT_CONFIG_KEY_0).toBe('safe.directory');
    expect(opts.env.GIT_CONFIG_VALUE_0).toBe('*');
    // Ticket 58cb5dfc: every harness-issued `git add` skips .digby/secrets/ via
    // a harness-level ignore file (works even on pre-fix worktree excludes).
    expect(opts.env.GIT_CONFIG_KEY_1).toBe('core.excludesFile');
    expect(opts.env.GIT_CONFIG_VALUE_1).toMatch(/\.digby-harness-add-ignore$/);
  });
});

// --- isUsableWorktree spellings (2026-10-27 runner-image roll, PR #2029 CI) ---
// The #142 probe classifies reuse-vs-rebuild by the probe error's message. git
// ≤ 2.55 spells a dangling gitfile fatal "not a git repository: <path>"; git
// ≥ 2.56 spells the SAME condition "gitfile does not point to a valid
// repository: <path>" — the one-spelling probe classified broken worktrees
// usable and the rebuild never fired (shard 4/4 red on PR #2029). Both
// spellings must classify unusable; anything else must stay TRUE (fail-open:
// never destroy a worktree git merely hesitated on).
describe('isUsableWorktree classifies both git spellings of a broken worktree (PR #2029)', () => {
  test.each([
    ['git ≤ 2.55 spelling', 'fatal: not a git repository: /x/mirror/worktrees/s-dangling/.git'],
    ['git ≥ 2.56 spelling', 'fatal: gitfile does not point to a valid repository: /x/mirror/worktrees/s-dangling/.git'],
  ])('%s → unusable (rebuild)', (_label, message) => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) =>
      cb(new Error(message)));
    return expect(isUsableWorktree('/tmp/wt')).resolves.toBe(false);
  });

  test('an unrelated failure (EACCES / index lock) stays usable — fail-open', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) =>
      cb(new Error('fatal: Unable to create /tmp/wt/.git/index.lock: File exists')));
    await expect(isUsableWorktree('/tmp/wt')).resolves.toBe(true);
  });

  test('an empty error message stays usable — fail-open', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) =>
      cb(new Error('')));
    await expect(isUsableWorktree('/tmp/wt')).resolves.toBe(true);
  });
});

// --- Zero-commit repo provisioning (feedback 2026-08-16, prod session 7d4360ff) ---
// A freshly created GitHub repo has NO commits: the mirror clones fine but no
// ref resolves (no origin/<base>, unborn HEAD) and `git worktree add … HEAD`
// died with "fatal: invalid reference: HEAD" — a failure the user then saw
// misreported as "Project not found". ensureWorktree seeds a mirror-LOCAL
// initial commit on the base branch when NOTHING resolves (the seed itself —
// real git against an empty bare remote — is pinned by
// workspace-empty-repo.test.ts). These unit tests pin the NEGATIVE space: a
// repo with a resolvable base is never seeded.
describe('ensureWorktree base-ref resolution (zero-commit seeding negative space)', () => {
  beforeEach(() => jest.clearAllMocks());

  const gitCalls = (): string[][] => execFileMock.mock.calls.map((c: any[]) => c[1] as string[]);

  it('a repo whose origin/<base> resolves is NEVER seeded (normal path unchanged)', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'origin/main') {
        return cb(null, { stdout: 'deadbeef\n', stderr: '' });
      }
      return cb(null, { stdout: '', stderr: '' });
    });
    await ensureWorktree('proj-ok', 'sess-ok', 'https://github.com/a/ok.git', 'main', 'digby/session-ok', null);
    const calls = gitCalls();
    expect(calls.some((a) => a[0] === 'commit-tree')).toBe(false);
    expect(calls.some((a) => a[0] === 'update-ref')).toBe(false);
    const add = calls.find((a) => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toEqual(['worktree', 'add', '-b', 'digby/session-ok', worktreePath('sess-ok'), 'origin/main']);
  });

  it('a valid HEAD fallback (base branch renamed upstream) is NOT treated as zero-commit', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'origin/main') {
        return cb(new Error('fatal: Needed a single revision')); // no origin/main
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
        return cb(null, { stdout: 'beadfeed\n', stderr: '' }); // …but HEAD exists
      }
      return cb(null, { stdout: '', stderr: '' });
    });
    await ensureWorktree('proj-master', 'sess-m1', 'https://github.com/a/master.git', 'main', 'digby/session-m1', null);
    const calls = gitCalls();
    expect(calls.some((a) => a[0] === 'commit-tree')).toBe(false);
    const add = calls.find((a) => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toEqual(['worktree', 'add', '-b', 'digby/session-m1', worktreePath('sess-m1'), 'HEAD']);
  });
});

// --- Shallow-mirror self-heal (ticket b3a35131, 2026-09-14) ---
// A shallow project mirror silently broke per-file git archaeology in every
// session worktree (path-scoped git_log collapsed to the grafted boundary
// commit). ensureRepoMirror now probes + heals with fetch --unshallow. These
// unit tests pin WHEN the heal fires (only when shallow, never on the clone
// path, kill-switch honored); the real-git end-to-end heal is pinned by
// workspace-unshallow.test.ts.
describe('ensureRepoMirror shallow-mirror heal (ticket b3a35131)', () => {
  const fsMock = jest.requireMock('fs/promises') as { access: jest.Mock };
  const PROJECT = 'proj-heal';
  const mirrorDir = repoMirrorPath(PROJECT);
  const calls = (): string[][] => execFileMock.mock.calls.map((c: any[]) => c[1] as string[]);

  beforeEach(() => {
    jest.clearAllMocks();
    // Mirror dir EXISTS (the default module mock makes every path missing,
    // which would take the fresh-clone branch this describe is not testing).
    fsMock.access.mockImplementation(async (p: any) => {
      if (String(p) === mirrorDir) return undefined;
      throw new Error('ENOENT');
    });
  });
  afterAll(() => {
    fsMock.access.mockImplementation(async () => { throw new Error('ENOENT'); });
  });

  it('a SHALLOW mirror is healed with fetch --unshallow, after the refresh fetch and before de-auth', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') {
        return cb(null, { stdout: 'true\n', stderr: '' });
      }
      return cb(null, { stdout: '', stderr: '' });
    });
    await ensureRepoMirror(PROJECT, 'https://github.com/a/x.git', null);
    const c = calls();
    const iRefresh = c.findIndex((a) => a[0] === 'fetch' && a[1] === '--prune');
    const iUnshallow = c.findIndex((a) => a[0] === 'fetch' && a[1] === '--unshallow');
    const setUrls = c.map((a, i) => ({ a, i })).filter(({ a }) => a[0] === 'remote' && a[1] === 'set-url');
    expect(iRefresh).toBeGreaterThanOrEqual(0);
    expect(iUnshallow).toBeGreaterThan(iRefresh);
    expect(c[iUnshallow]).toEqual(['fetch', '--unshallow', 'origin']);
    // …and the token strip in finally still happens AFTER the heal.
    expect(setUrls[setUrls.length - 1].i).toBeGreaterThan(iUnshallow);
  });

  it('a COMPLETE mirror is probed but never re-unshallowed (cheap steady state)', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') {
        return cb(null, { stdout: 'false\n', stderr: '' });
      }
      return cb(null, { stdout: '', stderr: '' });
    });
    await ensureRepoMirror(PROJECT, 'https://github.com/a/x.git', null);
    const c = calls();
    expect(c.some((a) => a[0] === 'rev-parse' && a[1] === '--is-shallow-repository')).toBe(true);
    expect(c.some((a) => a[0] === 'fetch' && a[1] === '--unshallow')).toBe(false);
  });

  it('a SHALLOW mirror is probed and healed by a single unshallow FETCH, then the residue prune runs (d6110694: the prune reads the same probe result)', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) =>
      cb(null, { stdout: 'true\n', stderr: '' }),
    );
    await ensureRepoMirror(PROJECT, 'https://github.com/a/x.git', null);
    const c = calls();
    expect(c.some((a) => a[1] === '--is-shallow-repository')).toBe(true);
    expect(c.some((a) => a[1] === '--unshallow')).toBe(true);
  });
});

// --- Backlog audit T7 (2026-09-28): git() never rethrows a credential ---
// execFile echoes the full argv into err.message, so a failed
// `git remote set-url origin https://x-access-token:<token>@…` carried the
// GitHub OAuth token through every caller's logger.warn into app_error_logs.
// The wrapper scrubs message / cmd / stderr in place; the error object (code,
// killed) is the same one, so callers still branch on it.
describe('git() rethrows a credential-scrubbed error (T7)', () => {
  const FAKE_GHO = 'gho_' + 'FAKEfakeFAKEfakeFAKEfakeFAKEfake9012';
  const AUTHED = `https://x-access-token:${FAKE_GHO}@github.com/example-org/repo`;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const failingExec = () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      const err: any = new Error(`Command failed: git ${args.join(' ')}\nerror: No such remote 'origin'`);
      err.code = 2;
      err.killed = false;
      err.cmd = `git ${args.join(' ')}`;
      err.stderr = "error: No such remote 'origin'";
      err.stdout = '';
      return cb(err, { stdout: '', stderr: err.stderr });
    });
  };

  it('masks the authed URL in message / cmd and keeps code + identity', async () => {
    failingExec();
    let caught: any = null;
    try { await git(['remote', 'set-url', 'origin', AUTHED], '/tmp/mirror'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).not.toContain(FAKE_GHO);
    expect(caught.message).toContain('https://***@github.com/example-org/repo');
    expect(caught.message).toContain("No such remote 'origin'");
    expect(caught.cmd).not.toContain(FAKE_GHO);
    expect(caught.code).toBe(2);
    expect(caught.killed).toBe(false);
  });

  it('the warn line ensureRepoMirror interpolates (err.message) carries no token', async () => {
    failingExec();
    let caught: any = null;
    try { await git(['remote', 'set-url', 'origin', AUTHED], '/tmp/mirror'); } catch (e) { caught = e; }
    const warnLine = `coding workspace: mirror fetch failed for p1 (using cache): ${caught.message}`;
    expect(warnLine).not.toContain(FAKE_GHO);
    expect(warnLine).toContain('https://***@github.com');
  });
});

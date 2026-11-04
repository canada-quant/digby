/**
 * Ticket 58cb5dfc regression pin (REAL git in tmp dirs). Incident (CanLaw Path C
 * session cec340f2, 2026-09-18 23:25–23:27Z): a worktree's git index was
 * EXTERNALLY mutated — 408 pre-existing .digby/* files, including
 * .digby/secrets/ credentials, appeared staged (" A" intent-to-add rows) with
 * no lane-issued command, HEAD and branch unchanged.
 *
 * Mechanism verified against this code: the run checkpoint's
 * snapshotWorktreeGitState swept every untracked, non-excluded file into the
 * mirror-side wip stash — .digby/secrets/ included, since NOTHING git-ignored
 * it (repo .gitignore doesn't know the path; info/exclude covered only
 * .digby/session/) — and reattachWorktree's `git stash apply` on the rebuilt
 * worktree landed the whole set in the REAL index as staged (older git) /
 * intent-to-add (newer git) entries: an externally-staged state one broad
 * `git add -A`/`git commit` away from committing and pushing credentials.
 *
 * The fix, pinned here in three layers:
 *   1. snapshotWorktreeGitState + captureVerifyFingerprint never sweep
 *      GIT_ADD_NEVER_INCLUDE paths (.digby/secrets/) into git objects;
 *   2. a successful restore unstages everything (mixed `git reset`) — restored
 *      content returns untracked / unstaged-modified, its true pre-snapshot
 *      state;
 *   3. installWorktreeExcludes git-ignores .digby/secrets/ in every worktree,
 *      topping up older exclude files idempotently;
 *   3b. the reuse early-returns (ensureWorktree / ensureBlankWorktree /
 *      reattachWorktree) top the exclude up on EVERY attach, so live pre-fix
 *      worktrees gain the secrets ignore without re-provisioning (reviewer
 *      M3/M6: worktreeDiffHash's `git add -A -N` bypasses gitEnv's
 *      core.excludesFile and could otherwise still ITA-stage credentials).
 *
 * CODING_WORKSPACE_ROOT is overridden BEFORE the module is required (it is read
 * at module load), so the mirror + worktrees land in the tmp dir.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-ws-secrets-'));
process.env.CODING_WORKSPACE_ROOT = ROOT;

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// project-lock (workspace.service dependency) pulls config/redis → config/env
// (process.exit at import) — same boundary mock as workspace-restore.test.ts.
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) },
}));
// verify-state pulls context-store → config/database → config/env (process.exit
// at import) — mocked at the boundary; captureVerifyFingerprint never touches it.
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ws = require('./workspace.service') as typeof import('./workspace.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const verifyState = require('./verify-state') as typeof import('./verify-state');

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();

const PROJECT = 'proj-secrets';
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
});

const treeListing = (committish: string, wt: string): string[] =>
  git(['ls-tree', '-r', '--name-only', committish], wt).split('\n').filter(Boolean);

describe('ticket 58cb5dfc — worktree git index external mutation / secrets staging', () => {
  test('layer 1: the checkpoint wip stash never captures .digby/secrets/ (and the real index stays untouched)', async () => {
    const sessionId = 's-secrets-snap';
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', 'digby/session-s-secrets-snap', null);
    fs.mkdirSync(path.join(wt, '.digby', 'secrets'), { recursive: true });
    fs.mkdirSync(path.join(wt, '.digby', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.digby', 'secrets', 'canlaw.env'), 'CANLAW_KEY=supersecret\n');
    fs.writeFileSync(path.join(wt, '.digby', 'notes', 'n1.md'), 'ops note\n');
    const statusBefore = git(['status', '--porcelain'], wt);
    expect(git(['diff', '--cached', '--name-only'], wt)).toBe('');

    const snap = await ws.snapshotWorktreeGitState(wt, sessionId);
    expect(snap?.wip).toEqual(expect.any(String));

    // The wip commit carries the lane's ops notes but NOT the secrets file.
    const listing = treeListing(snap!.wip!, wt);
    expect(listing).toContain('.digby/notes/n1.md');
    expect(listing.some((p) => p.startsWith('.digby/secrets/'))).toBe(false);

    // The agent-visible index/worktree state is byte-identical (checkpoint-safety).
    expect(git(['status', '--porcelain'], wt)).toBe(statusBefore);
    expect(git(['diff', '--cached', '--name-only'], wt)).toBe('');
  }, 30_000);

  test('layer 2: wipe → reattach restores content with a CLEAN index — nothing externally staged', async () => {
    const sessionId = 's-secrets-restore';
    const sessionBranch = 'digby/session-s-secrets-restore';
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', sessionBranch, null);
    fs.mkdirSync(path.join(wt, '.digby', 'secrets'), { recursive: true });
    fs.mkdirSync(path.join(wt, '.digby', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.digby', 'secrets', 'canlaw.env'), 'CANLAW_KEY=supersecret\n');
    fs.writeFileSync(path.join(wt, '.digby', 'notes', 'n1.md'), 'ops note\n');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\nTWO\n'); // tracked modification

    const snap = await ws.snapshotWorktreeGitState(wt, sessionId);
    expect(snap).toEqual({ branch: sessionBranch, wip: expect.any(String) });

    // The wipe: deploy/reap recreates the container and the worktree dir is gone.
    fs.rmSync(wt, { recursive: true, force: true });

    const wt2 = await ws.reattachWorktree(PROJECT, sessionId, remote, 'main', sessionBranch, null, snap);
    expect(wt2).toBe(wt);
    // Content restored: tracked mod + untracked note. The secrets file was never
    // in the wip (layer 1) — like env.sh, secret state does not ride git across
    // a wipe (the env sidecar is the secret-durability channel).
    expect(fs.readFileSync(path.join(wt2, 'a.txt'), 'utf8')).toBe('one\nTWO\n');
    expect(fs.readFileSync(path.join(wt2, '.digby', 'notes', 'n1.md'), 'utf8')).toBe('ops note\n');
    expect(fs.existsSync(path.join(wt2, '.digby', 'secrets', 'canlaw.env'))).toBe(false);

    // THE PIN: the incident's 408 externally-staged entries. Post-reattach the
    // index must be pristine — restored content is untracked/unstaged again.
    // (Asserted via name-only diffs, not porcelain XY: the helper's .trim()
    // would eat a leading " M" column and a staged "M " would slip through.)
    expect(git(['diff', '--cached', '--name-only'], wt2)).toBe('');        // nothing staged / ita
    expect(git(['diff', '--name-only'], wt2)).toBe('a.txt');               // tracked mod UNSTAGED
    expect(git(['ls-files', '--others', '--exclude-standard'], wt2)).toBe('.digby/notes/n1.md'); // restored as untracked
    // Successful apply still consumes the wip ref.
    expect(() => git(['rev-parse', '--verify', `refs/digby-wip/${sessionId}`], wt2)).toThrow();
  }, 30_000);

  test('layer 3: installWorktreeExcludes git-ignores .digby/secrets/ and tops up older installs idempotently', async () => {
    const sessionId = 's-secrets-exclude';
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', 'digby/session-s-secrets-exclude', null);
    const rel = git(['rev-parse', '--git-path', 'info/exclude'], wt);
    const excludePath = path.isAbsolute(rel) ? rel : path.join(wt, rel);
    const content = fs.readFileSync(excludePath, 'utf8');
    expect(content).toContain('.digby/session/');
    expect(content).toContain('.digby/secrets/');

    // check-ignore now covers credentials — the incident's "empty check-ignore".
    fs.mkdirSync(path.join(wt, '.digby', 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.digby', 'secrets', 'k.env'), 'X=1\n');
    expect(git(['check-ignore', '.digby/secrets/k.env'], wt)).toBe('.digby/secrets/k.env');
    // A broad lane-side add cannot stage them.
    git(['add', '-A'], wt);
    expect(git(['status', '--porcelain', '-uall'], wt)).toBe('');
    git(['reset'], wt);

    // Idempotent re-install: exactly one occurrence of each pattern.
    await ws.installWorktreeExcludes(wt);
    const again = fs.readFileSync(excludePath, 'utf8');
    expect(again.match(/^\.digby\/secrets\/$/gm) ?? []).toHaveLength(1);
    expect(again.match(/^\.digby\/session\/$/gm) ?? []).toHaveLength(1);

    // Top-up: a pre-58cb5dfc exclude (marker + session only) gains secrets.
    fs.writeFileSync(excludePath, '\n# Digby Code harness scratch — never commit\n.digby/session/\n');
    await ws.installWorktreeExcludes(wt);
    const topped = fs.readFileSync(excludePath, 'utf8');
    expect(topped).toContain('.digby/session/');
    expect(topped.match(/^\.digby\/secrets\/$/gm) ?? []).toHaveLength(1);
  }, 30_000);

  test('layer 1b: captureVerifyFingerprint never writes .digby/secrets/ into the fingerprint tree', async () => {
    const sessionId = 's-secrets-fp';
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', 'digby/session-s-secrets-fp', null);
    fs.mkdirSync(path.join(wt, '.digby', 'secrets'), { recursive: true });
    fs.mkdirSync(path.join(wt, '.digby', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.digby', 'secrets', 'canlaw.env'), 'CANLAW_KEY=supersecret\n');
    fs.writeFileSync(path.join(wt, '.digby', 'notes', 'n1.md'), 'ops note\n');
    const statusBefore = git(['status', '--porcelain'], wt);

    const fp = await verifyState.captureVerifyFingerprint(wt);
    expect(fp?.tree).toEqual(expect.any(String));
    const listing = treeListing(fp!.tree!, wt);
    expect(listing).toContain('.digby/notes/n1.md');
    expect(listing.some((p) => p.startsWith('.digby/secrets/'))).toBe(false);
    // Throwaway-index contract intact: real index/worktree untouched.
    expect(git(['status', '--porcelain'], wt)).toBe(statusBefore);
    expect(git(['diff', '--cached', '--name-only'], wt)).toBe('');
  }, 30_000);

  test('layer 3b: reuse early-returns top up a stale (pre-topup) exclude — the add -A -N staging path stays closed', async () => {
    // Reviewer M3/M6 (58cb5dfc): LIVE pre-fix worktrees reuse-return from every
    // attach path and never re-run provisioning, so the secrets exclude never
    // arrived — leaving worktreeDiffHash's `git add -A -N` (which bypasses
    // gitEnv) able to ITA-stage credentials. Each reuse return now tops up.
    const sessionId = 's-secrets-reuse';
    const branch = 'digby/session-s-secrets-reuse';
    const wt = await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', branch, null);
    const rel = git(['rev-parse', '--git-path', 'info/exclude'], wt);
    const excludePath = path.isAbsolute(rel) ? rel : path.join(wt, rel);
    const stripToPreFix = () =>
      fs.writeFileSync(excludePath, '\n# Digby Code harness scratch — never commit\n.digby/session/\n');
    const secretsCount = () =>
      fs.readFileSync(excludePath, 'utf8').match(/^\.digby\/secrets\/$/gm) ?? [];

    // (1) ensureWorktree reuse return. Repro precondition: on a pre-topup
    // worktree the reviewer's `git add -A -N` stages the credential.
    stripToPreFix();
    fs.mkdirSync(path.join(wt, '.digby', 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.digby', 'secrets', 'k.env'), 'X=1\n');
    git(['add', '-A', '-N'], wt);
    // ITA rows are invisible to `git diff --cached` in this git version — the
    // incident signature lives in porcelain (" A"), so assert there.
    const stagedBefore = git(['status', '--porcelain', '-uall'], wt);
    expect(stagedBefore).toContain('.digby/secrets/k.env');
    expect(stagedBefore).not.toContain('??'); // externally-STAGED, not merely untracked
    git(['reset'], wt);
    // The reuse early-return tops the exclude up…
    await ws.ensureWorktree(PROJECT, sessionId, remote, 'main', branch, null);
    expect(secretsCount()).toHaveLength(1);
    // …and the same add -A -N now stages nothing (the path is git-ignored).
    git(['add', '-A', '-N'], wt);
    expect(git(['status', '--porcelain', '-uall'], wt)).toBe('');
    git(['reset'], wt);

    // (2) reattachWorktree reuse return (worktree exists + usable → early return).
    stripToPreFix();
    await ws.reattachWorktree(PROJECT, sessionId, remote, 'main', branch, null);
    expect(secretsCount()).toHaveLength(1);

    // (3) blank-project reuse return.
    const blankSession = 's-secrets-reuse-blank';
    const blankBranch = 'digby/session-s-secrets-reuse-blank';
    const bwt = await ws.ensureBlankWorktree(blankSession, 'main', blankBranch);
    const brel = git(['rev-parse', '--git-path', 'info/exclude'], bwt);
    const bexclude = path.isAbsolute(brel) ? brel : path.join(bwt, brel);
    fs.writeFileSync(bexclude, '\n# Digby Code harness scratch — never commit\n.digby/session/\n');
    await ws.ensureBlankWorktree(blankSession, 'main', blankBranch);
    expect(fs.readFileSync(bexclude, 'utf8').match(/^\.digby\/secrets\/$/gm) ?? []).toHaveLength(1);
  }, 30_000);
});

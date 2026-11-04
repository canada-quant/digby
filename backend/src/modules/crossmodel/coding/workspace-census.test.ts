/**
 * Review 2026-09-13 issue 8 — workspace.service census + ownership helpers.
 *
 * Box A (0-slot cron-only worker, stale COPY of the coding-workspaces volume)
 * won the worktree-reaper claim, deleted its copy of each worktree and nulled
 * the SHARED DB path — orphaning box C's real dir (177 of 223 dirs, 79 GB).
 * Two helpers back the fix: isWorkspaceVolumeOwner (who may write reap
 * outcomes) and listWorktreeDirsOnDisk (census by DIRECTORY, not DB path).
 * Real filesystem under a per-test tmp root (set BEFORE the module loads —
 * WORKSPACE_ROOT is a module-level const).
 */

import * as os from 'os';
import * as path from 'path';
import * as fsSync from 'fs';

const ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), 'digby-census-'));
process.env.CODING_WORKSPACE_ROOT = ROOT;
// The env-seed sidecar root must live OUTSIDE the workspace root (boot guard).
process.env.CODING_ENV_ROOT = path.join(path.dirname(ROOT), `${path.basename(ROOT)}-env`);

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

import { isWorkspaceVolumeOwner, listWorktreeDirsOnDisk, CODING_WORKSPACE_ROOT } from './workspace.service';

const WORKTREES = path.join(ROOT, 'worktrees');

afterAll(() => {
  fsSync.rmSync(ROOT, { recursive: true, force: true });
});

describe('isWorkspaceVolumeOwner (review 2026-09-13 issue 8)', () => {
  const saved = { owner: process.env.CODING_WORKSPACE_VOLUME_OWNER, conc: process.env.CODING_WORKER_CONCURRENCY };
  afterEach(() => {
    if (saved.owner === undefined) delete process.env.CODING_WORKSPACE_VOLUME_OWNER; else process.env.CODING_WORKSPACE_VOLUME_OWNER = saved.owner;
    if (saved.conc === undefined) delete process.env.CODING_WORKER_CONCURRENCY; else process.env.CODING_WORKER_CONCURRENCY = saved.conc;
  });

  it('a 0-slot (cron-only) worker — box A — is NOT the owner', () => {
    delete process.env.CODING_WORKSPACE_VOLUME_OWNER;
    process.env.CODING_WORKER_CONCURRENCY = '0';
    expect(isWorkspaceVolumeOwner()).toBe(false);
  });

  it('a worker with slots — box C — IS the owner', () => {
    delete process.env.CODING_WORKSPACE_VOLUME_OWNER;
    process.env.CODING_WORKER_CONCURRENCY = '24';
    expect(isWorkspaceVolumeOwner()).toBe(true);
  });

  it('unset/invalid concurrency (dev, single-box install) keeps today\'s behaviour: the only box owns everything', () => {
    delete process.env.CODING_WORKSPACE_VOLUME_OWNER;
    delete process.env.CODING_WORKER_CONCURRENCY;
    expect(isWorkspaceVolumeOwner()).toBe(true);
    process.env.CODING_WORKER_CONCURRENCY = 'lots';
    expect(isWorkspaceVolumeOwner()).toBe(true);
  });

  it('the opt-in CODING_WORKSPACE_VOLUME_OWNER override wins over the inference in both directions', () => {
    process.env.CODING_WORKER_CONCURRENCY = '0';
    process.env.CODING_WORKSPACE_VOLUME_OWNER = '1';
    expect(isWorkspaceVolumeOwner()).toBe(true);
    process.env.CODING_WORKER_CONCURRENCY = '24';
    process.env.CODING_WORKSPACE_VOLUME_OWNER = '0';
    expect(isWorkspaceVolumeOwner()).toBe(false);
    process.env.CODING_WORKSPACE_VOLUME_OWNER = ' '; // blank = unset → inference
    expect(isWorkspaceVolumeOwner()).toBe(true);
  });
});

describe('listWorktreeDirsOnDisk (review 2026-09-13 issue 8)', () => {
  it('is rooted at the configured workspace root', () => {
    expect(CODING_WORKSPACE_ROOT).toBe(ROOT);
  });

  it('returns null (not []) when the worktrees root does not exist — callers must fail SAFE, not treat it as empty', async () => {
    expect(fsSync.existsSync(WORKTREES)).toBe(false);
    expect(await listWorktreeDirsOnDisk()).toBeNull();
  });

  it('lists session dirs with their mtime, skipping files and dot-entries (.sandbox-home)', async () => {
    fsSync.mkdirSync(path.join(WORKTREES, 'sess-aaaa'), { recursive: true });
    fsSync.mkdirSync(path.join(WORKTREES, 'sess-bbbb'), { recursive: true });
    fsSync.mkdirSync(path.join(WORKTREES, '.sandbox-home', 'sess-aaaa'), { recursive: true });
    fsSync.writeFileSync(path.join(WORKTREES, 'stray-file.txt'), 'x');
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    fsSync.utimesSync(path.join(WORKTREES, 'sess-aaaa'), old, old);

    const census = await listWorktreeDirsOnDisk();
    expect(census).not.toBeNull();
    const byId = new Map(census!.map(d => [d.sessionId, d.mtimeMs]));
    expect([...byId.keys()].sort()).toEqual(['sess-aaaa', 'sess-bbbb']);
    expect(byId.get('sess-aaaa')).toBeLessThan(Date.now() - 29 * 24 * 3600 * 1000); // the backdated mtime is what the reaper's idle rule reads
    expect(byId.get('sess-bbbb')).toBeGreaterThan(Date.now() - 60_000);
  });

  it('an empty worktrees root is [] (distinct from the null of a missing root)', async () => {
    fsSync.rmSync(WORKTREES, { recursive: true, force: true });
    fsSync.mkdirSync(WORKTREES, { recursive: true });
    expect(await listWorktreeDirsOnDisk()).toEqual([]);
  });
});

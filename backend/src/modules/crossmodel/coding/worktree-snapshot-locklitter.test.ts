/**
 * Disk lock-litter sweep (Framework Operator firing 3, 2026-09-22).
 *
 * The live litter: 12+ zero-byte `.snap-index-*.lock` strays in
 * WORKSPACE_ROOT on box C's worker container (Aug 3 → Sep 18 2026), leaked
 * by signal-killed `git add` / `git stash create` whose locks nothing ever
 * removed. These pins hold the sweep to its safety contract:
 *   - removes ONLY `.snap-index-*` files in WORKSPACE_ROOT,
 *   - ONLY zero-byte ones,
 *   - ONLY ones older than SNAP_LOCK_SWEEP_MIN_AGE_MIN (60 min),
 *   - never repos/ worktrees/ or any other file.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-wt-locklitter-'));
process.env.CODING_WORKSPACE_ROOT = ROOT;
const ENV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-wt-locklitter-env-'));
process.env.CODING_ENV_ROOT = ENV_ROOT;

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => (mockRecordLoopMetric as any)(...a),
  LOOP_METRIC_KINDS: { WORKTREE_SNAPSHOT_LOCK_SWEEP: 'worktree_snapshot_lock_sweep' },
}));

import { sweepSnapshotLockLitter, SNAP_LOCK_SWEEP_MIN_AGE_MIN } from './worktree-snapshot.service';

const OLD = new Date(Date.now() - (SNAP_LOCK_SWEEP_MIN_AGE_MIN + 30) * 60_000);
const FRESH = new Date(Date.now() - 30_000);

function touch(name: string, opts: { mtime?: Date; content?: string } = {}) {
  const full = path.join(ROOT, name);
  fs.writeFileSync(full, opts.content ?? '');
  fs.utimesSync(full, opts.mtime ?? FRESH, opts.mtime ?? FRESH);
  return full;
}

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.rmSync(ENV_ROOT, { recursive: true, force: true }); });

describe('sweepSnapshotLockLitter (firing 3 — the .snap-index-*.lock litter class)', () => {
  it('removes ONLY stale zero-byte .snap-index-* strays; keeps fresh locks, non-empty files, and foreign names', async () => {
    const staleA = touch('.snap-index-e083ff2e-0000000000000-placeholder-1-1790072781122-wgj9og.lock', { mtime: OLD });
    const staleB = touch('.snap-index-01771065-fc9f-473d-a739-dceb7481abf9-1-1785747175544-kcmf34.stash.63883.lock', { mtime: OLD });
    const freshLock = touch('.snap-index-e083ff2e-0000000000000-placeholder-1-1799999999999-fresh123.lock', { mtime: FRESH });
    const nonEmpty = touch('.snap-index-e083ff2e-0000000000000-placeholder-1-1790072781120-notzero.lock', { mtime: OLD, content: 'x' });
    const foreign = touch('.index-something-else.lock', { mtime: OLD });
    fs.mkdirSync(path.join(ROOT, 'repos'), { recursive: true });
    fs.mkdirSync(path.join(ROOT, 'worktrees'), { recursive: true });

    const r = await sweepSnapshotLockLitter({ force: true });
    expect(r).not.toBeNull();
    expect(r!.removed).toBe(2);
    expect(r!.scanned).toBe(4); // staleA + staleB + freshLock + nonEmpty (foreign names are never scanned)
    expect(fs.existsSync(staleA)).toBe(false);
    expect(fs.existsSync(staleB)).toBe(false);
    expect(fs.existsSync(freshLock)).toBe(true);
    expect(fs.existsSync(nonEmpty)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'repos'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'worktrees'))).toBe(true);
  });

  it('removes nothing when there is no litter (removed=0, result returned)', async () => {
    const r = await sweepSnapshotLockLitter({ force: true });
    // the previous test's KEEPERS are still there (freshLock + nonEmpty) —
    // re-scanned every pass but never removed: the sweep is idempotent.
    expect(r).toEqual({ scanned: 2, removed: 0, ms: expect.any(Number) });
  });
});

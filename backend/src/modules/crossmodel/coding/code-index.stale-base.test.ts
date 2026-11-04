/**
 * Code-index stale-base gate (2026-10-23). The regression PR #1905's walk v2
 * opened: the walk cap 2,500→6,000 removed the ACCIDENTAL protection (every
 * real repo's walk was previously partial, so the vanished-file sweep never
 * fired), and a month-old lane worktree's COMPLETE listing started deleting
 * every newer file's rows from the shared project index.
 *
 * DISCRIMINATOR (fails on the pre-fix sync): "a stale checkout's sync never
 * deletes the newer files' rows" — plus the anchor lineage leg (a sweep runs
 * only when the checkout's base anchor is at-or-ahead of the recorded one)
 * and the fail-open cases that keep standalone trees syncing. Mocks mirror
 * code-index.walk-v2.test.ts; the git worlds are REAL repos cloned over
 * file:// (the same refs/remotes/origin layout a lane worktree holds).
 */
const storeMap = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => storeMap.get(`${ns.join('/')}::${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { storeMap.set(`${ns.join('/')}::${key}`, JSON.parse(JSON.stringify(value))); }),
  storeDelete: jest.fn(async (ns: string[], key: string) => { storeMap.delete(`${ns.join('/')}::${key}`); }),
}));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => 1),
  memSearch: jest.fn(async () => []),
  enforceScopeCap: jest.fn(async () => {}),
  memListRefStats: jest.fn(async () => []),
  memDeleteRefs: jest.fn(async () => 0),
  memArchiveRefs: jest.fn(async () => ({ evicted: 0, archived: true, archiveFailed: false })),
  memPurgeArchivedRefs: jest.fn(async () => {}),
  memPurgeArchivedRefsExcept: jest.fn(async () => 0),
  worthEmbedding: jest.fn(() => true),
}));
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: mockLogger,
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { INDEX_SWEPT: 'index_swept' },
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { syncCodeIndex, decideStaleBase, readCodeIndexState, resetCodeIndexStateCache, STALE_BASE_MAX_BEHIND_MS } from './code-index.service';
import { renderCodeIndexFreshness } from './code-search';

const { memReplaceRef, memDeleteRefs } = jest.requireMock('../memory/unified-memory.service');
const sweptRefs = () => (memDeleteRefs as jest.Mock).mock.calls.flatMap(c => c[2] as string[]);
const { recordLoopMetric } = jest.requireMock('../platform/loop-metrics.service');
const metricRows = () => (recordLoopMetric as jest.Mock).mock.calls.map(c => c[0]);

const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root }).toString().trim();
/** git with commit dates overridden (backdating a commit N days). */
const gitDated = (root: string, days: number, ...args: string[]) => {
  const stamp = String(Math.floor((Date.now() - days * 86_400_000) / 1000));
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd: root,
    env: { ...process.env, GIT_COMMITTER_DATE: stamp, GIT_AUTHOR_DATE: stamp },
  }).toString().trim();
};

async function mkTree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-stale-'));
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body, 'utf8');
  }
  return root;
}

/** A "platform" repo: a 30-day-old base commit, then current main adds newfile.ts. */
async function buildPlatform(): Promise<{ mainRoot: string; baseSha: string; tipSha: string }> {
  const mainRoot = await mkTree({ 'base.ts': 'export const base = 1;\n' });
  git(mainRoot, 'init', '-q', '-b', 'main');
  git(mainRoot, 'add', '-A');
  gitDated(mainRoot, 30, 'commit', '-q', '-m', 'base');
  const baseSha = git(mainRoot, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(mainRoot, 'newfile.ts'), 'export const newfile = 1;\n', 'utf8');
  git(mainRoot, 'add', '-A');
  git(mainRoot, 'commit', '-q', '-m', 'new file on main');
  const tipSha = git(mainRoot, 'rev-parse', 'HEAD');
  return { mainRoot, baseSha, tipSha };
}

/** A lane checkout: a clone of the platform repo with HEAD at <at> on a lane branch. */
async function laneCheckout(mainRoot: string, name: string, at: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `code-index-lane-${name}-`));
  git(root, 'clone', '-q', `file://${mainRoot}`, '.');
  git(root, 'checkout', '-q', '-b', `digby/session-${name}`, at);
  return root;
}

beforeEach(() => {
  storeMap.clear();
  for (const fn of Object.values(mockLogger)) fn.mockClear();
  (memReplaceRef as jest.Mock).mockClear(); (memDeleteRefs as jest.Mock).mockClear();
  (recordLoopMetric as jest.Mock).mockClear();
  resetCodeIndexStateCache();
  delete process.env.CODE_INDEX_WALK_V2_DISABLED;
  delete process.env.CODE_INDEX_STALE_BASE_GUARD_DISABLED;
});
afterEach(() => { jest.restoreAllMocks(); });
afterAll(() => { delete process.env.CODE_INDEX_WALK_V2_DISABLED; delete process.env.CODE_INDEX_STALE_BASE_GUARD_DISABLED; });

describe('decideStaleBase — the staleness metric is the age of merge-base(HEAD, origin/<base>)', () => {
  test('a checkout on the default tip is allowed (age ~0)', async () => {
    const { mainRoot, tipSha } = await buildPlatform();
    const lane = await laneCheckout(mainRoot, 'fresh', tipSha);
    const d = await decideStaleBase(lane, { baseBranch: 'main' });
    expect(d.allowed).toBe(true);
    expect(d.baseBranch).toBe('main');
    expect(d.mergeBaseSha).toBe(tipSha);
    expect(d.baseAgeMs ?? 0).toBeLessThan(STALE_BASE_MAX_BEHIND_MS);
  });

  test('a lane with its own commits on a FRESH base is allowed (main advanced by squash-merges: merge-base is still the base)', async () => {
    const { mainRoot, tipSha } = await buildPlatform();
    // The lane branched at the TIP and made its own commit.
    const lane = await laneCheckout(mainRoot, 'wip', tipSha);
    await fs.writeFile(path.join(lane, 'lane.ts'), 'export const lane = 1;\n', 'utf8');
    git(lane, 'add', '-A');
    git(lane, 'commit', '-q', '-m', 'lane wip');
    // Meanwhile main advanced by an unrelated squash commit.
    git(mainRoot, 'commit', '-q', '--allow-empty', '-m', 'main squash');
    git(lane, 'fetch', '-q', 'origin', 'main:refs/remotes/origin/main');
    const d = await decideStaleBase(lane, { baseBranch: 'main' });
    expect(d.allowed).toBe(true);
    // merge-base is the branch point (the old tip), not the lane HEAD.
    expect(d.mergeBaseSha).toBe(tipSha);
  });

  test('a month-old base is refused with the age and the base named', async () => {
    const { mainRoot, baseSha } = await buildPlatform();
    const lane = await laneCheckout(mainRoot, 'stale', baseSha);
    const d = await decideStaleBase(lane, { baseBranch: 'main' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('stale_base');
    expect(d.baseBranch).toBe('main');
    expect(d.mergeBaseSha).toBe(baseSha);
    expect(d.baseAgeMs ?? 0).toBeGreaterThan(STALE_BASE_MAX_BEHIND_MS);
  });

  test('a plain directory (no git) is allowed fail-open — standalone trees keep syncing', async () => {
    const root = await mkTree({ 'a.ts': 'x' });
    const d = await decideStaleBase(root, {});
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('no_repo');
  });

  test('a repo with no origin refs falls back to the HEAD age (an active local project is allowed)', async () => {
    const root = await mkTree({ 'a.ts': 'x' });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'now');
    const d = await decideStaleBase(root, { baseBranch: 'main' });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('no_base');
    expect(d.mergeBaseSha).toBe(git(root, 'rev-parse', 'HEAD'));
  });
});

describe('syncCodeIndex — a stale checkout cannot write the shared index', () => {
  test("DISCRIMINATOR: a stale lane sync never deletes the newer files' rows (pre-fix: the stale listing purged them)", async () => {
    const { mainRoot, tipSha, baseSha } = await buildPlatform();
    const fresh = await laneCheckout(mainRoot, 'sync-fresh', tipSha);
    const stale = await laneCheckout(mainRoot, 'sync-stale', baseSha);
    const projectId = 'proj-stale-sync';
    // First: the FRESH checkout builds the index (holds newfile.ts).
    await syncCodeIndex(projectId, fresh, { force: true, baseBranch: 'main' });
    expect(Object.keys(storeMap.get(`${projectId}/code-index::state`).files)).toContain('newfile.ts');
    // Now the STALE lane syncs (its complete listing lacks newfile.ts).
    (memDeleteRefs as jest.Mock).mockClear(); (memReplaceRef as jest.Mock).mockClear(); (recordLoopMetric as jest.Mock).mockClear();
    const res = await syncCodeIndex(projectId, stale, { force: true, baseBranch: 'main' });
    expect(res).toMatchObject({ changed: 0, removed: 0, skipped: true });
    // The index still holds the NEWER file's hash; no rows were deleted.
    expect(Object.keys(storeMap.get(`${projectId}/code-index::state`).files)).toContain('newfile.ts');
    expect(sweptRefs()).toEqual([]);
    // One index_swept metric row carries the refusal.
    const rows = metricRows().filter(r => r.meta?.projectId === projectId && r.meta?.refused);
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ refused: true, reason: 'stale_base' });
    // The freshness view says FROZEN, not fresh.
    resetCodeIndexStateCache();
    const state = await readCodeIndexState(projectId);
    expect(state).toMatchObject({ staleRefused: true, staleReason: 'stale_base' });
    const line = renderCodeIndexFreshness(state, Date.now());
    expect(line).toContain('FROZEN');
  });

  test('the kill switch restores the pre-fix behaviour (the stale checkout purges the newer rows again)', async () => {
    process.env.CODE_INDEX_STALE_BASE_GUARD_DISABLED = '1';
    const { mainRoot, tipSha, baseSha } = await buildPlatform();
    const fresh = await laneCheckout(mainRoot, 'kill-fresh', tipSha);
    const stale = await laneCheckout(mainRoot, 'kill-stale', baseSha);
    const projectId = 'proj-stale-kill';
    await syncCodeIndex(projectId, fresh, { force: true, baseBranch: 'main' });
    expect(Object.keys(storeMap.get(`${projectId}/code-index::state`).files)).toContain('newfile.ts');
    const res = await syncCodeIndex(projectId, stale, { force: true, baseBranch: 'main' });
    // Pre-fix behaviour: the stale complete listing purged the newer file.
    expect(res.removed).toBe(1);
    expect(res.skipped).toBe(false);
    expect(Object.keys(storeMap.get(`${projectId}/code-index::state`).files)).not.toContain('newfile.ts');
  });

  test('a refused sync leaves the index searchable and a later FRESH sync clears the FROZEN marker', async () => {
    const { mainRoot, tipSha, baseSha } = await buildPlatform();
    const fresh = await laneCheckout(mainRoot, 'thaw-fresh', tipSha);
    const stale = await laneCheckout(mainRoot, 'thaw-stale', baseSha);
    const projectId = 'proj-stale-thaw';
    await syncCodeIndex(projectId, fresh, { force: true, baseBranch: 'main' });
    await syncCodeIndex(projectId, stale, { force: true, baseBranch: 'main' });
    resetCodeIndexStateCache();
    expect((await readCodeIndexState(projectId))?.staleRefused).toBe(true);
    // A fresh checkout syncs again — the marker must clear.
    await syncCodeIndex(projectId, fresh, { force: true, baseBranch: 'main' });
    resetCodeIndexStateCache();
    const state = await readCodeIndexState(projectId);
    expect(state?.staleRefused).toBeFalsy();
    expect(state?.indexedAnchor).toBe(tipSha);
    const line = renderCodeIndexFreshness(state, Date.now());
    expect(line).not.toContain('FROZEN');
  });
});

describe('syncCodeIndex — pin repair never drops a hash it did not store rows for (review D1)', () => {
  test('a room-deferred TEST-tier pin candidate keeps its hash and the repair stays open', async () => {
    const root = await mkTree({ 'a.ts': 'x', 'b.test.ts': 'y' });
    git(root, 'init', '-q', '-b', 'digby/session-repair');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'c1');
    const head = git(root, 'rev-parse', 'HEAD');
    git(root, 'remote', 'add', 'origin', 'https://example.com/r.git');
    git(root, 'update-ref', 'refs/remotes/origin/main', head);
    const projectId = 'proj-pin-repair';
    // First sync: a code file + a test file, a tiny row cap with room for both.
    await syncCodeIndex(projectId, root, { force: true, baseBranch: 'main', rowCap: 40 });
    const st1 = storeMap.get(`${projectId}/code-index::state`);
    expect(Object.keys(st1.files)).toEqual(expect.arrayContaining(['a.ts', 'b.test.ts']));
    // Forge the pre-repair world: the generic cap evicted the test file's
    // rows but kept its hash (the pinned-hash defect the repair clears).
    st1.pinRepairAt = undefined;
    delete st1.capEvicted;
    storeMap.set(`${projectId}/code-index::state`, st1);
    const { memListRefStats } = jest.requireMock('../memory/unified-memory.service');
    (memListRefStats as jest.Mock).mockClear();
    // No hot rows behind the test file → it becomes a repair candidate whose
    // chunks would exceed a now-tiny cap → deferred, pin kept.
    (memListRefStats as jest.Mock)
      .mockImplementationOnce(async () => [{ ref: 'a.ts', rows: 4 }])   // repair-candidate scan
      .mockImplementation(async () => [{ ref: 'a.ts', rows: 4 }]);       // cap planning + live measure
    (memReplaceRef as jest.Mock).mockClear();
    const res = await syncCodeIndex(projectId, root, { force: true, baseBranch: 'main', rowCap: 4 });
    expect(res.skipped).toBe(false);
    const st2 = storeMap.get(`${projectId}/code-index::state`);
    // The test file kept its pin (hash) AND the repair stays open for it.
    expect(Object.keys(st2.files)).toContain('b.test.ts');
    expect(st2.pinRepairAt).toBeUndefined();
    expect(st2.capDeferred).toBe(1);
  });

  test('a repair candidate with room is re-stored and the pin drops (repair done)', async () => {
    const root = await mkTree({ 'a.ts': 'x', 'b.ts': 'y'.repeat(300) });
    git(root, 'init', '-q', '-b', 'digby/session-repair2');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'c1');
    const head = git(root, 'rev-parse', 'HEAD');
    git(root, 'remote', 'add', 'origin', 'https://example.com/r.git');
    git(root, 'update-ref', 'refs/remotes/origin/main', head);
    const projectId = 'proj-pin-repair-ok';
    await syncCodeIndex(projectId, root, { force: true, baseBranch: 'main', rowCap: 40 });
    const st1 = storeMap.get(`${projectId}/code-index::state`);
    st1.pinRepairAt = undefined;
    delete st1.capEvicted;
    storeMap.set(`${projectId}/code-index::state`, st1);
    const { memListRefStats } = jest.requireMock('../memory/unified-memory.service');
    (memListRefStats as jest.Mock).mockClear();
    (memListRefStats as jest.Mock).mockImplementation(async () => [{ ref: 'a.ts', rows: 4 }]);
    (memReplaceRef as jest.Mock).mockClear();
    await syncCodeIndex(projectId, root, { force: true, baseBranch: 'main', rowCap: 40 });
    const st2 = storeMap.get(`${projectId}/code-index::state`);
    expect(st2.pinRepairAt).toBeTruthy();
    expect(Object.keys(st2.files)).toEqual(expect.arrayContaining(['a.ts', 'b.ts']));
  });
});

describe('syncCodeIndex — anchor lineage: the sweep runs only at-or-ahead of the recorded anchor', () => {
  test('a checkout whose anchor is BEHIND the recorded one never sweeps (leg 2 with no leg-1 refusal)', async () => {
    const { mainRoot, tipSha } = await buildPlatform();
    // Two fresh lanes off the SAME tip: lane A syncs (records anchor = tip),
    // main then advances, lane B syncs from the OLD tip clone — its anchor
    // (the old tip) is behind the recorded one ONLY after main advanced
    // between their syncs. Forge that directly: record the NEWER anchor.
    const laneA = await laneCheckout(mainRoot, 'anchor-a', tipSha);
    const projectId = 'proj-anchor-foreign';
    await syncCodeIndex(projectId, laneA, { force: true, baseBranch: 'main' });
    // main advances; laneB stays at the old tip (still inside the 14-day window).
    git(mainRoot, 'commit', '-q', '--allow-empty', '-m', 'main advanced');
    git(laneA, 'fetch', '-q', 'origin', 'main:refs/remotes/origin/main');
    const newTip = git(laneA, 'rev-parse', 'refs/remotes/origin/main');
    const laneB = await laneCheckout(mainRoot, 'anchor-b', tipSha);
    // State carries the NEWER anchor (as if laneB's rival synced after main advanced).
    const stateRow = storeMap.get(`${projectId}/code-index::state`);
    stateRow.indexedAnchor = newTip;
    storeMap.set(`${projectId}/code-index::state`, stateRow);
    // laneB's tree still holds every file; delete one so a pre-fix sweep WOULD run.
    await fs.unlink(path.join(laneB, 'base.ts'));
    (memDeleteRefs as jest.Mock).mockClear();
    const res = await syncCodeIndex(projectId, laneB, { force: true, baseBranch: 'main' });
    // Leg 1 passes (anchor age ~0) but leg 2 refuses the sweep: rows stay.
    expect(res.skipped).toBe(false);
    expect(sweptRefs()).toEqual([]);
    expect(Object.keys(storeMap.get(`${projectId}/code-index::state`).files)).toContain('base.ts');
  });
});

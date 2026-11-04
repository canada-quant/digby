/**
 * Code index — WHICH files the vanished-file sweep removes, HOW it deletes
 * them, and the freshness count (integration review, 2026-10-23).
 *
 * WHICH (c30b98c3c's rule, restored): a COMPLETE listing is the truth — every
 * unlisted file the index tracks (state.files + capEvicted) is swept; a
 * PARTIAL listing (capped, or with a read error) sweeps an unlisted file only
 * when fs.stat proves it gone. An interim "sweep only what this checkout's git
 * history proves deleted" rule was reverted: it never swept an untracked file,
 * a gitignored file or a reaped lane's files (their rows stayed forever) and
 * missed default branches other than main / master and bare 'local' mirrors.
 * The cost it targeted is the KNOWN, BOUNDED gap pinned below: there is ONE
 * index per project and every lane syncs it from its own worktree, so a lane
 * at another commit sweeps the other lane's lane-only files and that lane
 * re-embeds them on its next sync (only those files — nothing else churns).
 *
 * HOW: the sweep deletes in BATCHES — one memDeleteRefs (one hot DELETE + one
 * archive purge) per 500 refs, never two full-scope statements per file.
 *
 * FRESHNESS: `capHeld` is counted when the state is written, so the files the
 * cap evicted in that very sync show on the freshness line at once.
 *
 * DISCRIMINATORS: "an untracked file that vanished is swept" and "a reaped
 * lane's files are swept" fail on 993fefb48 (the git-proof rule kept them);
 * the batch cases fail on c30b98c3c (per-file deletes).
 *
 * The lanes are REAL git worktrees of one clone (shared refs, origin/main +
 * origin/HEAD), like the coding plane's per-project mirror; the digby_memory
 * rows are faked statefully (ref → rows) as in code-index.cap.test.ts.
 */
const storeMap = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => storeMap.get(`${ns.join('/')}::${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { storeMap.set(`${ns.join('/')}::${key}`, JSON.parse(JSON.stringify(value))); }),
  storeDelete: jest.fn(async (ns: string[], key: string) => { storeMap.delete(`${ns.join('/')}::${key}`); }),
}));
const mockRows = new Map<string, { rows: number; at: number }>();
const mockArchive = new Map<string, number>();
const mockClock = { t: 0 };
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async (_scope: any, _src: string, ref: string, items: any[]) => {
    if (!items.length) { mockRows.delete(ref); mockArchive.delete(ref); return 0; }
    mockRows.set(ref, { rows: items.length, at: ++mockClock.t });
    return items.length;
  }),
  memSearch: jest.fn(async () => []),
  enforceScopeCap: jest.fn(async () => {}),
  memListRefStats: jest.fn(async () => [...mockRows].map(([ref, r]) => ({ ref, rows: r.rows, newestMs: r.at }))),
  memDeleteRefs: jest.fn(async (_scope: any, _src: string, refs: string[]) => {
    let n = 0;
    for (const r of refs) { n += mockRows.get(r)?.rows ?? 0; mockRows.delete(r); mockArchive.delete(r); }
    return n;
  }),
  memArchiveRefs: jest.fn(async (_scope: any, _src: string, refs: string[]) => {
    let n = 0;
    for (const r of refs) {
      const row = mockRows.get(r);
      mockArchive.delete(r);
      if (row) { n += row.rows; mockArchive.set(r, row.rows); mockRows.delete(r); }
    }
    return { evicted: n, archived: true, archiveFailed: false };
  }),
  memPurgeArchivedRefs: jest.fn(async (_scope: any, _src: string, refs: string[]) => { for (const r of refs) mockArchive.delete(r); }),
  memPurgeArchivedRefsExcept: jest.fn(async (_scope: any, _src: string, keep: string[]) => {
    const k = new Set(keep);
    let n = 0;
    for (const r of [...mockArchive.keys()]) if (!k.has(r)) { n += mockArchive.get(r) ?? 0; mockArchive.delete(r); }
    return n;
  }),
  worthEmbedding: () => true,
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { INDEX_SWEPT: 'index_swept', MEMORY_SCOPE_EVICTED: 'memory_scope_evicted' },
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { syncCodeIndex, readCodeIndexState, resetCodeIndexStateCache } from './code-index.service';
import { renderCodeIndexFreshness } from './code-search';

const um = jest.requireMock('../memory/unified-memory.service');
const embedCalls = () => (um.memReplaceRef as jest.Mock).mock.calls.filter(c => Array.isArray(c[3]) && c[3].length > 0).map(c => c[2] as string);
const perFileDeletes = () => (um.memReplaceRef as jest.Mock).mock.calls.filter(c => Array.isArray(c[3]) && c[3].length === 0).map(c => c[2] as string);
const stateOf = (p: string) => storeMap.get(`${p}/code-index::state`);

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body, 'utf8');
  }
}

/** An upstream repo, ONE clone (the per-project mirror: shared refs, origin/main + origin/HEAD) and a lane factory. */
async function mkProject(files: Record<string, string>) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-sweep-'));
  const up = path.join(base, 'up');
  await fs.mkdir(up);
  git(up, 'init', '-q', '-b', 'main');
  await write(up, files);
  git(up, 'add', '-A');
  git(up, 'commit', '-q', '-m', 'base');
  const mirror = path.join(base, 'mirror');
  git(base, 'clone', '-q', up, mirror);
  let n = 0;
  return {
    mirror,
    /** A new lane worktree at origin/main (the lane branched NOW); returns its path and branch. */
    lane: (name: string) => {
      const branch = `digby/session-${name}`;
      const wt = path.join(base, 'lanes', `${name}-${n++}`);
      git(mirror, 'worktree', 'add', '-q', '-b', branch, wt, 'origin/main');
      return { wt, branch };
    },
  };
}
async function laneCommit(wt: string, changes: { write?: Record<string, string>; remove?: string[] }): Promise<void> {
  if (changes.write) await write(wt, changes.write);
  for (const r of changes.remove || []) await fs.unlink(path.join(wt, r));
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'lane work');
}
const sync = (p: string, wt: string, rowCap = 100) => syncCodeIndex(p, wt, { force: true, rowCap });

const BASE = {
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export const b = 1;\n',
  'src/old.ts': 'export const old = 1;\n',
};

beforeEach(() => {
  storeMap.clear();
  mockRows.clear();
  mockArchive.clear();
  mockClock.t = 0;
  for (const k of ['memReplaceRef', 'memListRefStats', 'memDeleteRefs', 'memArchiveRefs', 'memPurgeArchivedRefs', 'memPurgeArchivedRefsExcept']) (um[k] as jest.Mock).mockClear();
  mockRecordLoopMetric.mockClear();
  resetCodeIndexStateCache();
  delete process.env.CODE_INDEX_WALK_V2_DISABLED;
});
afterAll(() => { delete process.env.CODE_INDEX_WALK_V2_DISABLED; });

describe('which files the sweep removes — a complete listing is the truth (c30b98c3c rule, restored)', () => {
  it('a git checkout: an UNTRACKED file that vanished is swept (the git-proof rule kept its rows forever)', async () => {
    const proj = await mkProject(BASE);
    const { wt } = proj.lane('scratch');
    await write(wt, { 'src/scratch.ts': 'export const scratch = 1;\n' }); // never committed
    await sync('p-untracked', wt);
    expect(stateOf('p-untracked').files).toHaveProperty(['src/scratch.ts']);
    await fs.unlink(path.join(wt, 'src/scratch.ts'));
    const res = await sync('p-untracked', wt);
    expect(res.removed).toBe(1);
    expect(stateOf('p-untracked').files).not.toHaveProperty(['src/scratch.ts']);
    expect(mockRows.has('src/scratch.ts')).toBe(false);
  });

  it('a REAPED lane\'s files are swept by the next sync of a surviving lane (worktree + branch gone)', async () => {
    const proj = await mkProject(BASE);
    const A = proj.lane('reaped');
    const B = proj.lane('survivor');
    await laneCommit(A.wt, { write: { 'src/lane/x.ts': 'export const x = 1;\n', 'src/lane/y.ts': 'export const y = 1;\n' } });
    await sync('p-reaped', A.wt);
    git(proj.mirror, 'worktree', 'remove', '--force', A.wt);
    git(proj.mirror, 'branch', '-D', A.branch);
    const res = await sync('p-reaped', B.wt);
    expect(res.removed).toBe(2);
    expect(Object.keys(stateOf('p-reaped').files).sort()).toEqual(Object.keys(BASE).sort());
    expect(mockRows.has('src/lane/x.ts') || mockRows.has('src/lane/y.ts')).toBe(false);
  });

  it('KNOWN, BOUNDED gap (one index per project): lanes at different commits sweep / re-embed only each other\'s lane-only files', async () => {
    const proj = await mkProject(BASE);
    const A = proj.lane('a');
    const B = proj.lane('b');
    await laneCommit(A.wt, { write: { 'src/lane/only.ts': 'export const only = 1;\n' } });
    await sync('p-gap', A.wt);
    (um.memReplaceRef as jest.Mock).mockClear();
    expect(await sync('p-gap', B.wt)).toMatchObject({ changed: 0, removed: 1 });
    expect(await sync('p-gap', A.wt)).toMatchObject({ changed: 1, removed: 0 });
    // Only the lane-only file moved — the shared files never re-embed.
    expect(embedCalls()).toEqual(['src/lane/only.ts']);
  });
});

describe('the sweep deletes in batches', () => {
  it('N vanished files ⇒ ONE memDeleteRefs, never a per-file delete', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-batch-'));
    const many: Record<string, string> = { 'keep.ts': 'export const keep = 1;\n' };
    for (let i = 0; i < 12; i++) many[`gone/g${i}.ts`] = `export const g${i} = ${i};\n`;
    await write(root, many);
    await sync('p-batch', root);
    await fs.rm(path.join(root, 'gone'), { recursive: true });
    (um.memReplaceRef as jest.Mock).mockClear();
    const res = await sync('p-batch', root);
    expect(res.removed).toBe(12);
    expect(perFileDeletes()).toEqual([]);
    expect(um.memDeleteRefs).toHaveBeenCalledTimes(1);
    expect(((um.memDeleteRefs as jest.Mock).mock.calls[0][2] as string[]).sort()).toEqual(Object.keys(many).filter(k => k !== 'keep.ts').sort());
  });

  it('one memDeleteRefs per 500 refs — vanished files and vanished cap-evicted entries share the batches', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-chunks-'));
    await write(root, { 'keep.ts': 'export const keep = 1;\n' });
    const files: Record<string, string> = { 'keep.ts': 'stale-hash' };
    for (let i = 0; i < 700; i++) files[`gone/f${i}.ts`] = `h${i}`;
    const capEvicted: Record<string, string> = {};
    for (let i = 0; i < 350; i++) capEvicted[`gone/e${i}.test.ts`] = `e${i}`;
    storeMap.set('p-chunks/code-index::state', { files, capEvicted, lastSyncAt: '2020-01-01T00:00:00.000Z', pinRepairAt: '2020-01-01T00:00:00.000Z' });
    const res = await sync('p-chunks', root);
    expect(res.removed).toBe(1050);
    expect(perFileDeletes()).toEqual([]);
    const batches = (um.memDeleteRefs as jest.Mock).mock.calls.map(c => (c[2] as string[]).length);
    expect(batches).toEqual([500, 500, 50]);
    const swept = new Set((um.memDeleteRefs as jest.Mock).mock.calls.flatMap(c => c[2] as string[]));
    expect(swept.size).toBe(1050);
    expect(swept.has('gone/e349.test.ts') && swept.has('gone/f699.ts')).toBe(true);
    expect(Object.keys(stateOf('p-chunks').files)).toEqual(['keep.ts']);
    expect(stateOf('p-chunks')).not.toHaveProperty('capEvicted');
  });
});

describe('the freshness line counts files the cap evicted in the latest sync', () => {
  it('right after an evicting sync — not one sync later', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-fresh-'));
    await write(root, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n', 't.test.ts': 'test("t", () => {});\n' });
    await sync('p-fresh', root, 100);
    await write(root, { 'c.ts': 'export const c = 1;\n' });
    await sync('p-fresh', root, 3); // embeds c.ts, the cap evicts t.test.ts in this same pass
    expect(Object.keys(stateOf('p-fresh').capEvicted)).toEqual(['t.test.ts']);
    resetCodeIndexStateCache();
    const view = await readCodeIndexState('p-fresh');
    expect(view).toMatchObject({ capHeld: 1 });
    expect(renderCodeIndexFreshness(view, Date.now())).toContain('1 file not indexed — the project\'s code-row cap is full');
  });
});

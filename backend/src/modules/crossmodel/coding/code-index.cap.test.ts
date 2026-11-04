/**
 * Code-index row cap (fs-code-knowledge review fix, 2026-10-23). Walk v2 lists
 * up to 6,000 files, so the per-project 40,000 'code'-row cap can bind. The
 * generic enforceScopeCap evicts the OLDEST rows — the stable core files — and
 * the evicted file's hash stayed in the index state, so the file was never
 * re-embedded: core code silently and permanently dropped out of
 * search_code_semantic.
 *
 * Now the code index runs its own tiered cap: rows of files the state no
 * longer knows (vanished / deleted / orphaned) go first, then *.test.* files,
 * then live code oldest-first, whole files at a time; every evicted file's
 * hash is dropped from the state so it re-embeds on a later sync, and a
 * test file the cap evicted is not re-embedded while there is no headroom (no
 * churn). DISCRIMINATORS (fail on the pre-fix sync): the tier-order test and
 * the re-embed test.
 *
 * The digby_memory rows are faked statefully (ref → {rows, at}) so the cap
 * sees exactly what the sync wrote.
 */
const storeMap = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => storeMap.get(`${ns.join('/')}::${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { storeMap.set(`${ns.join('/')}::${key}`, JSON.parse(JSON.stringify(value))); }),
}));
const mockRows = new Map<string, { rows: number; at: number }>();
// The cold tier (digby_memory_archive), faked per ref: ref → archived rows.
const mockArchive = new Map<string, number>();
const mockClock = { t: 0 };
// The real store's quality gate (unified-memory worthEmbedding), copied so the
// pin repair's "would this content store rows?" check runs against it.
const mockWorth = (content: string): boolean => {
  const t = content.trim();
  if (t.length >= 200) return true;
  if (t.length < 25) return false;
  return /[\/\\]|\berror\b|Error|https?:|[a-zA-Z_]+\(|[a-zA-Z0-9_]+\.[a-zA-Z]{2,4}\b|\d{2,}|`|_/.test(t);
};
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
  // The archive MOVE: hot rows → cold, replacing the ref's previous archived generation.
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
  // The complete-listing backstop: purge every archived ref NOT in `keep`; returns rows purged.
  memPurgeArchivedRefsExcept: jest.fn(async (_scope: any, _src: string, keep: string[]) => {
    const k = new Set(keep);
    let n = 0;
    for (const r of [...mockArchive.keys()]) if (!k.has(r)) { n += mockArchive.get(r) ?? 0; mockArchive.delete(r); }
    return n;
  }),
  worthEmbedding: (c: string) => mockWorth(c),
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
import { syncCodeIndex, planCodeIndexCapEviction, resetCodeIndexStateCache } from './code-index.service';

const um = jest.requireMock('../memory/unified-memory.service');

async function mkTree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-cap-'));
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body, 'utf8');
  }
  return root;
}
const stateOf = (p: string) => storeMap.get(`${p}/code-index::state`);
const embeddedRefs = () => (um.memReplaceRef as jest.Mock).mock.calls.filter(c => Array.isArray(c[3]) && c[3].length > 0).map(c => c[2]);

beforeEach(() => {
  storeMap.clear();
  mockRows.clear();
  mockArchive.clear();
  mockClock.t = 0;
  for (const k of ['memReplaceRef', 'enforceScopeCap', 'memListRefStats', 'memDeleteRefs', 'memArchiveRefs', 'memPurgeArchivedRefs', 'memPurgeArchivedRefsExcept']) (um[k] as jest.Mock).mockClear();
  mockRecordLoopMetric.mockClear();
  resetCodeIndexStateCache();
  delete process.env.CODE_INDEX_WALK_V2_DISABLED;
});
afterAll(() => { delete process.env.CODE_INDEX_WALK_V2_DISABLED; });

describe('planCodeIndexCapEviction (pure)', () => {
  const stats = [
    { ref: 'src/core.ts', rows: 3, newestMs: 1 },
    { ref: 'src/util.ts', rows: 2, newestMs: 5 },
    { ref: 'src/core.test.ts', rows: 2, newestMs: 9 },
    { ref: 'src/gone.ts', rows: 1, newestMs: 10 },
  ];
  const live = (r: string) => r !== 'src/gone.ts';

  it('under the cap evicts nothing', () => {
    expect(planCodeIndexCapEviction(stats, 8, live)).toMatchObject({ evict: [], rowsBefore: 8, rowsAfter: 8 });
  });
  it('orphans first, then tests, then live code oldest-first — whole files, stopping once under the cap', () => {
    expect(planCodeIndexCapEviction(stats, 7, live).evict.map(e => e.ref)).toEqual(['src/gone.ts']);
    expect(planCodeIndexCapEviction(stats, 5, live).evict.map(e => `${e.tier}:${e.ref}`)).toEqual(['orphan:src/gone.ts', 'test:src/core.test.ts']);
    const deep = planCodeIndexCapEviction(stats, 2, live);
    expect(deep.evict.map(e => e.ref)).toEqual(['src/gone.ts', 'src/core.test.ts', 'src/core.ts']);
    expect(deep.rowsAfter).toBe(2);
  });
});

describe('syncCodeIndex — the tiered cap (walk v2)', () => {
  it('evicts orphan + test rows before live code, and drops the evicted hashes', async () => {
    const root = await mkTree({ 'src/core.ts': 'export const core = 1;\n', 'src/old.ts': 'export const old = 1;\n', 'src/util.ts': 'export const util = 1;\n', 'src/core.test.ts': 'test("c", () => {});\n' });
    await syncCodeIndex('proj-tier', root, { force: true, rowCap: 100 });
    mockRows.set('src/deleted-long-ago.ts', { rows: 1, at: 1_000 }); // a row the state does not know (newest, still first out)
    await fs.writeFile(path.join(root, 'src/new.ts'), 'export const fresh = 1;\n', 'utf8');
    await syncCodeIndex('proj-tier', root, { force: true, rowCap: 4 });
    expect(um.enforceScopeCap).not.toHaveBeenCalled();
    // Round 4: an ORPHAN ref (no file behind it in the state — mostly a deleted
    // file) is a real deletion: deleted AND purged, never archived. Test / code
    // tiers are evictions of live files: archived.
    expect((um.memDeleteRefs as jest.Mock).mock.calls.map(c => c[2])).toEqual([['src/deleted-long-ago.ts']]);
    expect((um.memArchiveRefs as jest.Mock).mock.calls.map(c => [c[2], c[3]])).toEqual([[['src/core.test.ts'], 'code_index_tiered']]);
    expect([...mockArchive.keys()]).toEqual(['src/core.test.ts']);
    expect(Object.keys(stateOf('proj-tier').files).sort()).toEqual(['src/core.ts', 'src/new.ts', 'src/old.ts', 'src/util.ts']);
    expect(stateOf('proj-tier').capEvicted).toEqual({ 'src/core.test.ts': expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect([...mockRows.keys()].sort()).toEqual(['src/core.ts', 'src/new.ts', 'src/old.ts', 'src/util.ts']);
    const swept = mockRecordLoopMetric.mock.calls.map(c => c[0]).filter(r => r.kind === 'index_swept').pop();
    expect(swept.meta).toMatchObject({ capEvictedFiles: 2, capEvictedRows: 2, capTiers: { orphan: 1, test: 1, code: 0 } });
    const evicted = mockRecordLoopMetric.mock.calls.map(c => c[0]).filter(r => r.kind === 'memory_scope_evicted');
    expect(evicted).toHaveLength(1);
    expect(evicted[0]).toMatchObject({ value: 2, meta: { source: 'code', cap: 4, reason: 'code_index_tiered', files: 2, archived: true, orphansDeleted: 1 } });
  });

  it('cap-evicted rows are MOVED into the archive (archive instead of delete) — never deleted and purged', async () => {
    // Review finding (round 3): memDeleteRefs deleted the evicted refs' rows AND
    // purged their archived copies, so a test file the cap evicted and then held
    // back (capDeferred) was in neither tier — search_memory's cold leg could not
    // find it, where the generic cap had archived it (the 2026-10-20 rule).
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n', 't.test.ts': 'test("t", () => {});\n' });
    await syncCodeIndex('proj-archive', root, { force: true, rowCap: 100 });
    await fs.writeFile(path.join(root, 'c.ts'), 'export const c = 1;\n', 'utf8');
    await syncCodeIndex('proj-archive', root, { force: true, rowCap: 3 });
    expect(um.memDeleteRefs).not.toHaveBeenCalled();
    expect([...mockArchive.keys()]).toEqual(['t.test.ts']);
    expect(mockRows.has('t.test.ts')).toBe(false);
    // Held back (capDeferred) — it is still reachable in the cold tier.
    await syncCodeIndex('proj-archive', root, { force: true, rowCap: 3 });
    expect(stateOf('proj-archive').capDeferred).toBe(1);
    expect([...mockArchive.keys()]).toEqual(['t.test.ts']);
  });

  it('a file back in the hot tier loses its stale archived copy (one tier at a time), and the archive keeps one generation per ref', async () => {
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n', 'c.ts': 'export const c = 1;\n' });
    await syncCodeIndex('proj-regen', root, { force: true, rowCap: 100 });
    await fs.writeFile(path.join(root, 'c.ts'), 'export const c = 2;\n', 'utf8');
    await syncCodeIndex('proj-regen', root, { force: true, rowCap: 2 });
    expect([...mockArchive.keys()]).toEqual(['a.ts']);
    await syncCodeIndex('proj-regen', root, { force: true, rowCap: 100 }); // a.ts re-embeds
    expect(embeddedRefs()).toContain('a.ts');
    expect(mockArchive.has('a.ts')).toBe(false);
    const purged = (um.memPurgeArchivedRefs as jest.Mock).mock.calls.map(c => c[2]);
    expect(purged[purged.length - 1]).toEqual(['a.ts']);
  });

  it('an evicted live file re-embeds on the next sync (its hash is no longer pinned)', async () => {
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n', 'c.ts': 'export const c = 1;\n' });
    await syncCodeIndex('proj-reembed', root, { force: true, rowCap: 100 });
    await fs.writeFile(path.join(root, 'c.ts'), 'export const c = 2;\n', 'utf8');
    await syncCodeIndex('proj-reembed', root, { force: true, rowCap: 2 });
    expect((um.memArchiveRefs as jest.Mock).mock.calls.map(c => c[2])).toEqual([['a.ts']]); // oldest live code
    expect(stateOf('proj-reembed').files).not.toHaveProperty(['a.ts']);
    (um.memReplaceRef as jest.Mock).mockClear();
    await syncCodeIndex('proj-reembed', root, { force: true, rowCap: 100 });
    expect(embeddedRefs()).toEqual(['a.ts']);
    expect(stateOf('proj-reembed').files).toHaveProperty(['a.ts']);
  });

  it('a test file the cap evicted is not re-embedded while there is no headroom (no churn), and returns once there is', async () => {
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n', 't.test.ts': 'test("t", () => {});\n' });
    await syncCodeIndex('proj-churn', root, { force: true, rowCap: 100 });
    await fs.writeFile(path.join(root, 'c.ts'), 'export const c = 1;\n', 'utf8');
    await syncCodeIndex('proj-churn', root, { force: true, rowCap: 3 });
    expect(stateOf('proj-churn').files).not.toHaveProperty(['t.test.ts']);
    (um.memReplaceRef as jest.Mock).mockClear();
    const again = await syncCodeIndex('proj-churn', root, { force: true, rowCap: 3 });
    expect(again.changed).toBe(0);
    expect(embeddedRefs()).toEqual([]);
    expect(stateOf('proj-churn').capDeferred).toBe(1);
    await fs.unlink(path.join(root, 'c.ts')); // room again: the sweep runs before the embed loop
    await syncCodeIndex('proj-churn', root, { force: true, rowCap: 3 });
    expect(stateOf('proj-churn').files).toHaveProperty(['t.test.ts']);
  });

  it('an unreadable ref listing SKIPS the cap this pass (capSkipped) — never the generic cap that pins hashes; the next readable pass caps', async () => {
    // Review finding (round 3): one transient stats error fell back to the
    // generic oldest-ROW cap, which evicts part of a file and drops no hash —
    // the original pinned-hash defect, back on any DB blip over the cap.
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    (um.memListRefStats as jest.Mock).mockResolvedValueOnce(null);
    const res = await syncCodeIndex('proj-fallback', root, { force: true, rowCap: 1 });
    expect(res.changed).toBe(2);
    expect(um.enforceScopeCap).not.toHaveBeenCalled();
    expect(um.memArchiveRefs).not.toHaveBeenCalled();
    expect(stateOf('proj-fallback')).toMatchObject({ capSkipped: 'stats_unreadable' });
    expect(Object.keys(stateOf('proj-fallback').files).sort()).toEqual(['a.ts', 'b.ts']);
    const swept = mockRecordLoopMetric.mock.calls.map(c => c[0]).filter(r => r.kind === 'index_swept').pop();
    expect(swept.meta).toMatchObject({ capSkipped: 'stats_unreadable' });
    await fs.writeFile(path.join(root, 'c.ts'), 'export const c = 1;\n', 'utf8');
    await syncCodeIndex('proj-fallback', root, { force: true, rowCap: 1 });
    expect(um.enforceScopeCap).not.toHaveBeenCalled();
    expect((um.memArchiveRefs as jest.Mock).mock.calls.map(c => c[2])).toEqual([['a.ts', 'b.ts']]);
    expect(stateOf('proj-fallback')).not.toHaveProperty('capSkipped');
    expect(Object.keys(stateOf('proj-fallback').files)).toEqual(['c.ts']);
  });

  it('a full ref-stats page still plans the tiered cap over the page (never the generic cap)', async () => {
    const page = Array.from({ length: 60_000 }, (_, i) => ({ ref: `gen/${String(i).padStart(5, '0')}.ts`, rows: 1, newestMs: i + 1 }));
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n' });
    (um.memListRefStats as jest.Mock).mockResolvedValueOnce(page);
    await syncCodeIndex('proj-fullpage', root, { force: true, rowCap: 59_995 });
    expect(um.enforceScopeCap).not.toHaveBeenCalled();
    // The page's refs are files the state does not know (orphans): deleted + purged, never archived (round 4).
    expect((um.memDeleteRefs as jest.Mock).mock.calls.map(c => c[2])).toEqual([['gen/00000.ts', 'gen/00001.ts', 'gen/00002.ts', 'gen/00003.ts', 'gen/00004.ts']]);
    expect(um.memArchiveRefs).not.toHaveBeenCalled();
    const swept = mockRecordLoopMetric.mock.calls.map(c => c[0]).filter(r => r.kind === 'index_swept').pop();
    expect(swept.meta).toMatchObject({ capStatsPartial: true, capEvictedFiles: 5 });
  });

  it('CODE_INDEX_WALK_V2_DISABLED=1 keeps the generic oldest-first cap byte-for-byte', async () => {
    process.env.CODE_INDEX_WALK_V2_DISABLED = '1';
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n' });
    await syncCodeIndex('proj-legacy-cap', root, { force: true });
    expect(um.memListRefStats).not.toHaveBeenCalled();
    expect(um.memArchiveRefs).not.toHaveBeenCalled();
    expect(um.memPurgeArchivedRefs).not.toHaveBeenCalled();
    expect(um.enforceScopeCap).toHaveBeenCalledWith({ type: 'project', id: 'proj-legacy-cap' }, 40_000, 'code');
  });
});

describe('syncCodeIndex — cap-evicted files at a FIXED cap (round 4: no endless re-embed loop)', () => {
  // Review finding (round 4): the tiered cap dropped each evicted file's hash
  // and the headroom guard held back only TEST files, so a cap-evicted live
  // code file counted as new and re-embedded next sync, pushing the scope back
  // over the cap, which evicted the next-oldest file — forever (a/b/c at one
  // row each, cap 2: embed a archive b, embed b archive c, embed c archive a …).
  // Every pass re-embedded up to 150 files. The pre-existing re-embed test
  // hid it by raising the cap on the re-embed pass. Now the cap RECORDS the
  // evicted file's hash (state.capEvicted) and an unchanged one re-embeds only
  // when the measured live rows have room for it.
  const A = 'export const a = 1;\n';
  const B = 'export const b = 1;\n';
  const C = 'export const c = 1;\n';

  it('the evicted set stays stable and NOTHING is re-embedded over many syncs at a fixed cap', async () => {
    const root = await mkTree({ 'a.ts': A, 'b.ts': B, 'c.ts': C });
    await syncCodeIndex('proj-loop', root, { force: true, rowCap: 2 });
    expect([...mockArchive.keys()]).toEqual(['a.ts']);
    expect(Object.keys(stateOf('proj-loop').capEvicted)).toEqual(['a.ts']);
    for (let pass = 1; pass <= 4; pass++) {
      (um.memReplaceRef as jest.Mock).mockClear();
      (um.memArchiveRefs as jest.Mock).mockClear();
      const res = await syncCodeIndex('proj-loop', root, { force: true, rowCap: 2 });
      expect(res.changed).toBe(0);
      expect(embeddedRefs()).toEqual([]);
      expect(um.memArchiveRefs).not.toHaveBeenCalled();
      expect([...mockArchive.keys()]).toEqual(['a.ts']);
      expect([...mockRows.keys()].sort()).toEqual(['b.ts', 'c.ts']);
      expect(Object.keys(stateOf('proj-loop').capEvicted)).toEqual(['a.ts']);
      expect(stateOf('proj-loop').capDeferred).toBe(1);
    }
  });

  it('changed content of a cap-evicted file and a genuinely new file still embed at the fixed cap — then it is stable again', async () => {
    const root = await mkTree({ 'a.ts': A, 'b.ts': B, 'c.ts': C });
    await syncCodeIndex('proj-loop-change', root, { force: true, rowCap: 2 });
    await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 2;\n', 'utf8');
    (um.memReplaceRef as jest.Mock).mockClear();
    await syncCodeIndex('proj-loop-change', root, { force: true, rowCap: 2 });
    expect(embeddedRefs()).toEqual(['a.ts']);
    expect(mockArchive.has('a.ts')).toBe(false); // the stale archived generation is purged
    expect([...mockArchive.keys()]).toEqual(['b.ts']); // the cap took the next-oldest instead
    expect(Object.keys(stateOf('proj-loop-change').capEvicted)).toEqual(['b.ts']);
    await fs.writeFile(path.join(root, 'd.ts'), 'export const d = 1;\n', 'utf8');
    (um.memReplaceRef as jest.Mock).mockClear();
    await syncCodeIndex('proj-loop-change', root, { force: true, rowCap: 2 });
    expect(embeddedRefs()).toEqual(['d.ts']); // b.ts (unchanged, evicted) is NOT re-embedded beside it
    expect(Object.keys(stateOf('proj-loop-change').capEvicted).sort()).toEqual(['b.ts', 'c.ts']);
    (um.memReplaceRef as jest.Mock).mockClear();
    (um.memArchiveRefs as jest.Mock).mockClear();
    await syncCodeIndex('proj-loop-change', root, { force: true, rowCap: 2 });
    expect(embeddedRefs()).toEqual([]);
    expect(um.memArchiveRefs).not.toHaveBeenCalled();
  });

  it('a cap-held file re-embeds once the cap has room for it (a live file deleted), and leaves the record', async () => {
    const root = await mkTree({ 'a.ts': A, 'b.ts': B, 'c.ts': C });
    await syncCodeIndex('proj-loop-room', root, { force: true, rowCap: 2 });
    await fs.unlink(path.join(root, 'c.ts'));
    (um.memReplaceRef as jest.Mock).mockClear();
    await syncCodeIndex('proj-loop-room', root, { force: true, rowCap: 2 });
    expect(embeddedRefs()).toEqual(['a.ts']);
    expect([...mockRows.keys()].sort()).toEqual(['a.ts', 'b.ts']);
    expect(mockArchive.size).toBe(0);
    expect(stateOf('proj-loop-room').capEvicted ?? {}).toEqual({});
    expect(stateOf('proj-loop-room')).not.toHaveProperty('capDeferred');
  });

  it('a cap-evicted ref whose rows are still hot (the move failed) is archived again, never deleted as an orphan', async () => {
    const root = await mkTree({ 'a.ts': A, 'b.ts': B, 'c.ts': C });
    (um.memArchiveRefs as jest.Mock).mockImplementationOnce(async () => ({ evicted: 0, archived: false, archiveFailed: true }));
    await syncCodeIndex('proj-loop-stuck', root, { force: true, rowCap: 2 });
    expect(mockRows.has('a.ts')).toBe(true); // the move did not happen
    await fs.writeFile(path.join(root, 'd.ts'), 'export const d = 1;\n', 'utf8');
    (um.memArchiveRefs as jest.Mock).mockClear();
    await syncCodeIndex('proj-loop-stuck', root, { force: true, rowCap: 2 });
    expect(um.memDeleteRefs).not.toHaveBeenCalled();
    expect((um.memArchiveRefs as jest.Mock).mock.calls[0][2]).toContain('a.ts');
    expect(mockArchive.has('a.ts')).toBe(true);
  });

  it('the freshness record never carries the cap-evicted map', async () => {
    const root = await mkTree({ 'a.ts': A, 'b.ts': B, 'c.ts': C });
    await syncCodeIndex('proj-loop-meta', root, { force: true, rowCap: 2 });
    await syncCodeIndex('proj-loop-meta', root, { force: true, rowCap: 2 });
    const meta = storeMap.get('proj-loop-meta/code-index::meta');
    expect(meta).not.toHaveProperty('capEvicted');
    expect(meta).not.toHaveProperty('archiveSweptAt');
    expect(meta).toMatchObject({ fileCount: 2, capDeferred: 1 });
  });
});

describe('syncCodeIndex — a deleted file never resurfaces from the archive (round 4)', () => {
  // Review finding (round 4): a file the tiered cap archived had no hash in
  // state.files and the v2 sweep only walked state.files, so deleting it from
  // the checkout never purged its archived copy — search_memory's cold leg
  // returned it [archived] for up to 365 days. Orphan-tier refs (mostly
  // deleted files) were archived too instead of deleted + purged.
  const A = 'export const a = 1;\n';
  const B = 'export const b = 1;\n';

  it('a cap-archived file deleted from the checkout loses its archived copy (complete listing)', async () => {
    const root = await mkTree({ 'a.ts': A, 'b.ts': B, 't.test.ts': 'test("t", () => {});\n' });
    await syncCodeIndex('proj-gone', root, { force: true, rowCap: 100 });
    await fs.writeFile(path.join(root, 'c.ts'), 'export const c = 1;\n', 'utf8');
    await syncCodeIndex('proj-gone', root, { force: true, rowCap: 3 });
    expect([...mockArchive.keys()]).toEqual(['t.test.ts']);
    await fs.unlink(path.join(root, 't.test.ts'));
    const res = await syncCodeIndex('proj-gone', root, { force: true, rowCap: 3 });
    await syncCodeIndex('proj-gone', root, { force: true, rowCap: 3 });
    expect(mockArchive.has('t.test.ts')).toBe(false);
    expect(stateOf('proj-gone').capEvicted ?? {}).not.toHaveProperty(['t.test.ts']);
    expect(res.removed).toBe(1);
    expect((um.memDeleteRefs as jest.Mock).mock.calls.map(c => c[2])).toEqual([['t.test.ts']]);
  });

  it('a partial listing purges a cap-evicted file only when stat proves it gone; one alive beyond the listing keeps its archived copy', async () => {
    const root = await mkTree({ 'a.ts': A, 'b.ts': B, 't.test.ts': 'test("t", () => {});\n', 'u.test.ts': 'test("u", () => {});\n' });
    await syncCodeIndex('proj-gone-partial', root, { force: true, rowCap: 100 });
    await fs.writeFile(path.join(root, 'c.ts'), 'export const c = 1;\n', 'utf8');
    await syncCodeIndex('proj-gone-partial', root, { force: true, rowCap: 3 });
    expect([...mockArchive.keys()].sort()).toEqual(['t.test.ts', 'u.test.ts']);
    await fs.unlink(path.join(root, 't.test.ts'));
    (um.memPurgeArchivedRefsExcept as jest.Mock).mockClear();
    await syncCodeIndex('proj-gone-partial', root, { force: true, rowCap: 3, maxFiles: 1 }); // lists a.ts only
    expect(mockArchive.has('t.test.ts')).toBe(false);
    expect(mockArchive.has('u.test.ts')).toBe(true);
    expect(Object.keys(stateOf('proj-gone-partial').capEvicted)).toEqual(['u.test.ts']);
    expect(Object.keys(stateOf('proj-gone-partial').files).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(um.memPurgeArchivedRefsExcept).not.toHaveBeenCalled(); // never on a partial listing
  });

  it('a complete listing purges archived code rows whose file is not listed (untracked copies) — at most once a day; a listed file\'s archived copy stays', async () => {
    const root = await mkTree({ 'a.ts': A, 'b.ts': B, 'c.ts': 'export const c = 1;\n' });
    await syncCodeIndex('proj-backstop', root, { force: true, rowCap: 2 });
    expect([...mockArchive.keys()]).toEqual(['a.ts']);
    expect(typeof stateOf('proj-backstop').archiveSweptAt).toBe('string');
    mockArchive.set('old/removed.ts', 3); // archived before anything tracked it (a legacy-era eviction)
    (um.memPurgeArchivedRefsExcept as jest.Mock).mockClear();
    await syncCodeIndex('proj-backstop', root, { force: true, rowCap: 2 });
    expect(um.memPurgeArchivedRefsExcept).not.toHaveBeenCalled(); // ran within the last 24 h
    storeMap.set('proj-backstop/code-index::state', { ...stateOf('proj-backstop'), archiveSweptAt: new Date(Date.now() - 25 * 3600_000).toISOString() });
    await syncCodeIndex('proj-backstop', root, { force: true, rowCap: 2 });
    expect(um.memPurgeArchivedRefsExcept).toHaveBeenCalledTimes(1);
    expect((um.memPurgeArchivedRefsExcept as jest.Mock).mock.calls[0][2].slice().sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(mockArchive.has('old/removed.ts')).toBe(false);
    expect(mockArchive.has('a.ts')).toBe(true);
    const swept = mockRecordLoopMetric.mock.calls.map(c => c[0]).filter(r => r.kind === 'index_swept').pop();
    expect(swept.meta).toMatchObject({ archivePurged: 3 });
  });

  it('a partial listing never runs the backstop purge (an unlisted file may be alive)', async () => {
    const root = await mkTree({ 'a.ts': A, 'b.ts': B });
    mockArchive.set('b.ts', 1);
    await syncCodeIndex('proj-backstop-partial', root, { force: true, rowCap: 100, maxFiles: 1 });
    expect(um.memPurgeArchivedRefsExcept).not.toHaveBeenCalled();
    expect(stateOf('proj-backstop-partial')).not.toHaveProperty('archiveSweptAt');
  });
});

describe('syncCodeIndex — one-time repair of hashes pinned by the old generic cap (walk v2)', () => {
  // Review finding (round 3): only the NEW tiered cap drops hashes; a project
  // whose legacy index already went over the cap (the generic oldest-ROW cap)
  // still holds hashes with no rows behind them — missing from
  // search_code_semantic until the file next changes.
  const sha1 = (s: string) => require('crypto').createHash('sha1').update(s).digest('hex');
  const CORE = `export function throttleProvisioningRetries(attempt: number): number {\n  return Math.min(30_000, 250 * 2 ** attempt); // capped exponential backoff for provisioning\n}\n`;
  const SWEPT = `export const RETRY_POLICY = { base_ms: 250, max_ms: 30_000, jitter: true, reason: 'provider 429s burst' };\n`;
  const TINY = 'x\n';
  const HELD = `export const held = { path: 'src/held.ts', note: 'has rows' };\n`;
  const seed = async (projectId: string) => {
    const root = await mkTree({ 'core.ts': CORE, 'swept.ts': SWEPT, 'tiny.ts': TINY, 'held.ts': HELD });
    storeMap.set(`${projectId}/code-index::state`, {
      files: { 'core.ts': sha1(CORE), 'swept.ts': sha1(SWEPT), 'tiny.ts': sha1(TINY), 'held.ts': sha1(HELD) },
      lastSyncAt: '2026-10-01T00:00:00Z',
    });
    mockRows.set('held.ts', { rows: 1, at: ++mockClock.t });
    mockArchive.set('swept.ts', 1); // the generic cap ARCHIVED it (post-2026-10-20) and kept the hash
    return root;
  };

  it('re-embeds a pinned file once (no rows, content passes the store gate), purges its stale archived copy, and never churns a trivially-gated file', async () => {
    const root = await seed('proj-pins');
    const res = await syncCodeIndex('proj-pins', root, { force: true, rowCap: 100 });
    expect(embeddedRefs().sort()).toEqual(['core.ts', 'swept.ts']);
    expect(res.changed).toBe(2);
    expect(mockArchive.has('swept.ts')).toBe(false);
    const state = stateOf('proj-pins');
    expect(Object.keys(state.files).sort()).toEqual(['core.ts', 'held.ts', 'swept.ts', 'tiny.ts']);
    expect(typeof state.pinRepairAt).toBe('string');
    const swept = mockRecordLoopMetric.mock.calls.map(c => c[0]).filter(r => r.kind === 'index_swept').pop();
    expect(swept.meta).toMatchObject({ pinRepaired: 2 });
    // One-time: the next pass reads no stats for a repair and re-embeds nothing (tiny.ts keeps its hash).
    (um.memReplaceRef as jest.Mock).mockClear();
    (um.memListRefStats as jest.Mock).mockClear();
    const again = await syncCodeIndex('proj-pins', root, { force: true, rowCap: 100 });
    expect(again.changed).toBe(0);
    expect(embeddedRefs()).toEqual([]);
    expect(um.memListRefStats).not.toHaveBeenCalled();
  });

  it('an unreadable ref listing defers the repair to the next pass (never marked done blind)', async () => {
    const root = await seed('proj-pins-later');
    (um.memListRefStats as jest.Mock).mockResolvedValueOnce(null);
    await syncCodeIndex('proj-pins-later', root, { force: true, rowCap: 100 });
    expect(embeddedRefs()).toEqual([]);
    expect(stateOf('proj-pins-later')).not.toHaveProperty('pinRepairAt');
    await syncCodeIndex('proj-pins-later', root, { force: true, rowCap: 100 });
    expect(embeddedRefs().sort()).toEqual(['core.ts', 'swept.ts']);
    expect(stateOf('proj-pins-later')).toHaveProperty('pinRepairAt');
  });

  it('the freshness record never carries the repair marker', async () => {
    const root = await seed('proj-pins-meta');
    await syncCodeIndex('proj-pins-meta', root, { force: true, rowCap: 100 });
    expect(storeMap.get('proj-pins-meta/code-index::meta')).not.toHaveProperty('pinRepairAt');
  });
});

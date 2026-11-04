/**
 * Code-index walk v2 (fs-code-knowledge, 2026-10-22). The platform repo
 * outgrew the 2,500-file walk cap and the reverse-alpha DFS never reached
 * backend/…/chat-agent/ (0 of 164 files); the vanished-file sweep only ran on a
 * complete pass inside the embed budget, so deleted files kept their rows
 * forever; the state carried no branch / commit, so a search answer could not
 * say what checkout it came from.
 *
 * DISCRIMINATOR (fails on the pre-fix sync): "a deleted file is swept even
 * when the sync spends its whole embed budget" — the old sweep was skipped on
 * any early break. Mocks mirror code-index.test.ts.
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
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { syncCodeIndex, walkCodeFilesBreadthFirst, isTestPath, readCodeIndexState, resetCodeIndexStateCache } from './code-index.service';
import { renderCodeIndexFreshness } from './code-search';

const { memReplaceRef, memDeleteRefs } = jest.requireMock('../memory/unified-memory.service');
// The sweep deletes in BATCHES (round 5): the refs every memDeleteRefs call swept, flattened.
const sweptRefs = () => (memDeleteRefs as jest.Mock).mock.calls.flatMap(c => c[2] as string[]);
const perFileDeletes = () => (memReplaceRef as jest.Mock).mock.calls.filter(c => Array.isArray(c[3]) && c[3].length === 0).map(c => c[2]);
const { storeGet } = jest.requireMock('../memory/context-store');
const execFileP = promisify(execFile);
// The real module object the service's `import * as fs` forwards to (a live
// getter binding) — spying here reaches the service's readdir / stat.
const realFs: typeof import('fs/promises') = require('fs/promises');
const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

async function mkTree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-v2-'));
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body, 'utf8');
  }
  return root;
}

beforeEach(() => {
  storeMap.clear();
  for (const fn of Object.values(mockLogger)) fn.mockClear();
  (memReplaceRef as jest.Mock).mockClear(); (memDeleteRefs as jest.Mock).mockClear();
  (storeGet as jest.Mock).mockClear();
  resetCodeIndexStateCache();
  delete process.env.CODE_INDEX_WALK_V2_DISABLED;
});
afterEach(() => { jest.restoreAllMocks(); });
afterAll(() => { delete process.env.CODE_INDEX_WALK_V2_DISABLED; });

describe('walk v2 — breadth-first listing', () => {
  test('a deep directory is reached under a small cap (the reverse-alpha DFS spent it all in the last sibling)', async () => {
    const files: Record<string, string> = { 'backend/chat-agent/core.ts': 'export const core = 1;\n' };
    for (let i = 0; i < 10; i++) files[`zz/deep/er/still/f${i}.ts`] = `export const f${i} = ${i};\n`;
    const root = await mkTree(files);
    const { files: listed, truncated } = await walkCodeFilesBreadthFirst(root, 5);
    expect(truncated).toBe(true);
    expect(listed).toHaveLength(5);
    expect(listed.map(f => path.relative(root, f))).toContain(path.join('backend', 'chat-agent', 'core.ts'));
  });

  test('a listing that fits is complete (truncated:false) and skips hidden / denied / non-code entries', async () => {
    const root = await mkTree({ 'a.ts': 'x', '.env.ts': 'x', 'node_modules/m/i.ts': 'x', 'data.bin': 'x', 'src/b.ts': 'x' });
    const { files: listed, truncated } = await walkCodeFilesBreadthFirst(root, 100);
    expect(truncated).toBe(false);
    expect(listed.map(f => path.relative(root, f)).sort()).toEqual(['a.ts', path.join('src', 'b.ts')]);
  });

  test('isTestPath: *.test.* / *.spec.* / __tests__/ embed after the code they test', () => {
    expect(isTestPath('backend/src/a.test.ts')).toBe(true);
    expect(isTestPath('frontend/x.spec.tsx')).toBe(true);
    expect(isTestPath('pkg/__tests__/a.ts')).toBe(true);
    expect(isTestPath('backend/src/latest.ts')).toBe(false);
  });
});

describe('walk v2 — vanished-file sweep + provenance', () => {
  test('a deleted file is swept even when the sync spends its whole embed budget (old code: no sweep on an early break)', async () => {
    const root = await mkTree({ 'gone.ts': 'export const gone = 1;\n', 'keep.ts': 'export const keep = 1;\n' });
    await syncCodeIndex('proj-sweep-budget', root, { force: true });
    await fs.unlink(path.join(root, 'gone.ts'));
    for (let i = 0; i < 151; i++) await fs.writeFile(path.join(root, `n${String(i).padStart(3, '0')}.ts`), `export const n${i} = ${i};\n`, 'utf8');
    const res = await syncCodeIndex('proj-sweep-budget', root, { force: true });
    expect(res.changed).toBe(150);
    expect(res.removed).toBe(1);
    const raw = storeMap.get('proj-sweep-budget/code-index::state');
    expect(raw.files).not.toHaveProperty(['gone.ts']);
    expect(raw.files).toHaveProperty(['keep.ts']);
    expect((await readCodeIndexState('proj-sweep-budget'))?.partial).toBe(true);
  });

  test('a capped listing never evicts a live file beyond the cap — only files gone from disk', async () => {
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n', 'c.ts': 'export const c = 1;\n', 'd.ts': 'export const d = 1;\n' });
    await syncCodeIndex('proj-sweep-cap', root, { force: true });
    await fs.unlink(path.join(root, 'd.ts'));
    (memReplaceRef as jest.Mock).mockClear(); (memDeleteRefs as jest.Mock).mockClear();
    const res = await syncCodeIndex('proj-sweep-cap', root, { force: true, maxFiles: 2 });
    expect(res.removed).toBe(1);
    expect(Object.keys(storeMap.get('proj-sweep-cap/code-index::state').files).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect((await readCodeIndexState('proj-sweep-cap'))?.truncated).toBe(true);
    expect(sweptRefs()).toEqual(['d.ts']);
    expect(perFileDeletes()).toEqual([]);
  });

  test('test files embed after the code (first-build budget goes to the code itself)', async () => {
    const root = await mkTree({ 'a.test.ts': 'test("a", () => {});\n', 'b.ts': 'export const b = 1;\n' });
    await syncCodeIndex('proj-order', root, { force: true });
    const refs = (memReplaceRef as jest.Mock).mock.calls.map(c => c[2]);
    expect(refs).toEqual(['b.ts', 'a.test.ts']);
  });

  test("the state records the checkout's branch + HEAD sha", async () => {
    const root = await mkTree({ 'src/a.ts': 'export const a = 1;\n' });
    const g = (...args: string[]) => execFileP('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root });
    await g('init', '-q', '-b', 'digby/session-abc');
    await g('add', '-A');
    await g('commit', '-q', '-m', 'init');
    const head = (await execFileP('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    await syncCodeIndex('proj-prov', root, { force: true });
    const state = await readCodeIndexState('proj-prov');
    expect(state).toMatchObject({ indexedSha: head, branch: 'digby/session-abc', partial: false, truncated: false, listed: 1 });
  });

  test('a plain directory (no repo) records no provenance and still syncs', async () => {
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n' });
    const res = await syncCodeIndex('proj-norepo', root, { force: true });
    expect(res.changed).toBe(1);
    const state = await readCodeIndexState('proj-norepo');
    expect(state).not.toHaveProperty('indexedSha');
    expect(state).toMatchObject({ listed: 1, partial: false, truncated: false });
  });

  test('CODE_INDEX_WALK_V2_DISABLED=1 writes the legacy state shape (no provenance)', async () => {
    process.env.CODE_INDEX_WALK_V2_DISABLED = '1';
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n' });
    await syncCodeIndex('proj-legacy', root, { force: true });
    const state = await readCodeIndexState('proj-legacy');
    expect(Object.keys(state || {}).sort()).toEqual(['files', 'lastSyncAt']);
  });
});

describe('walk v2 — a listing with read errors: an unlisted file is evicted only when stat says it is gone (review fixes)', () => {
  const removedRefs = sweptRefs;

  test('a subdirectory readdir EACCES never evicts the live files under it', async () => {
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n', 'sub/b.ts': 'export const b = 1;\n', 'sub/c.ts': 'export const c = 1;\n' });
    await syncCodeIndex('proj-eacces', root, { force: true });
    const realReaddir = realFs.readdir.bind(realFs);
    jest.spyOn(realFs, 'readdir').mockImplementation((async (dir: any, opts: any) => {
      if (path.resolve(String(dir)) === path.join(root, 'sub')) throw errno('EACCES');
      return realReaddir(dir, opts);
    }) as any);
    (memReplaceRef as jest.Mock).mockClear(); (memDeleteRefs as jest.Mock).mockClear();
    const res = await syncCodeIndex('proj-eacces', root, { force: true });
    expect(res.removed).toBe(0);
    expect(removedRefs()).toHaveLength(0);
    resetCodeIndexStateCache();
    const state = await readCodeIndexState('proj-eacces');
    expect(storeMap.get('proj-eacces/code-index::state').files).toHaveProperty([path.join('sub', 'b.ts')]);
    expect(storeMap.get('proj-eacces/code-index::state').files).toHaveProperty([path.join('sub', 'c.ts')]);
    expect(state).toMatchObject({ listingErrors: 1 });
    expect(state).not.toHaveProperty('sweepSkipped');
    const line = renderCodeIndexFreshness(state, Date.now());
    expect(line).toContain('could not read 1 entry');
    expect(line).toContain('files there keep their last-synced rows');
  });

  test('a permanently unreadable directory no longer turns the sweep off: a file deleted elsewhere is still swept', async () => {
    // Review finding (round 3): a container-owned data/ (mode 700) inside a lane
    // checkout made EVERY walk partial, so the project never swept again and a
    // deleted / renamed file's rows stayed indexed forever.
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n', 'gone.ts': 'export const gone = 1;\n', 'data/d.ts': 'export const d = 1;\n' });
    await syncCodeIndex('proj-perm', root, { force: true });
    const realReaddir = realFs.readdir.bind(realFs);
    const realStat = realFs.stat.bind(realFs);
    jest.spyOn(realFs, 'readdir').mockImplementation((async (dir: any, opts: any) => {
      if (path.resolve(String(dir)) === path.join(root, 'data')) throw errno('EACCES');
      return realReaddir(dir, opts);
    }) as any);
    // stat inside a mode-700 directory another user owns answers EACCES (no search permission).
    jest.spyOn(realFs, 'stat').mockImplementation((async (p: any, o?: any) => {
      if (path.resolve(String(p)).startsWith(path.join(root, 'data') + path.sep)) throw errno('EACCES');
      return realStat(p, o);
    }) as any);
    await fs.unlink(path.join(root, 'gone.ts'));
    (memReplaceRef as jest.Mock).mockClear(); (memDeleteRefs as jest.Mock).mockClear();
    const res = await syncCodeIndex('proj-perm', root, { force: true });
    expect(res.removed).toBe(1);
    expect(removedRefs()).toEqual(['gone.ts']);
    expect(Object.keys(storeMap.get('proj-perm/code-index::state').files).sort()).toEqual(['a.ts', path.join('data', 'd.ts')]);
  });

  test('the listing-error warn is logged once per project per process (later passes count on index_swept only)', async () => {
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n', 'sub/b.ts': 'export const b = 1;\n' });
    const realReaddir = realFs.readdir.bind(realFs);
    jest.spyOn(realFs, 'readdir').mockImplementation((async (dir: any, opts: any) => {
      if (path.resolve(String(dir)) === path.join(root, 'sub')) throw errno('EACCES');
      return realReaddir(dir, opts);
    }) as any);
    for (let i = 0; i < 3; i++) await syncCodeIndex('proj-warn-once', root, { force: true });
    const warns = mockLogger.warn.mock.calls.filter(c => /proj-warn-once/.test(String(c[0])));
    expect(warns).toHaveLength(1);
    const { recordLoopMetric } = jest.requireMock('../platform/loop-metrics.service');
    const rows = (recordLoopMetric as jest.Mock).mock.calls.map(c => c[0]).filter(r => r.meta?.projectId === 'proj-warn-once');
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.meta).toMatchObject({ listingErrors: 1, errorCodes: { EACCES: 1 } });
  });

  test('a root readdir failure (EMFILE) lists nothing and evicts only what stat proves gone', async () => {
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n', 'c.ts': 'export const c = 1;\n' });
    await syncCodeIndex('proj-emfile', root, { force: true });
    await fs.unlink(path.join(root, 'c.ts'));
    const realReaddir = realFs.readdir.bind(realFs);
    jest.spyOn(realFs, 'readdir').mockImplementation((async (dir: any, opts: any) => {
      if (path.resolve(String(dir)) === path.resolve(root)) throw errno('EMFILE');
      return realReaddir(dir, opts);
    }) as any);
    const res = await syncCodeIndex('proj-emfile', root, { force: true });
    expect(res.removed).toBe(1);
    expect(Object.keys(storeMap.get('proj-emfile/code-index::state').files).sort()).toEqual(['a.ts', 'b.ts']);
  });

  test('a stat that fails after readdir makes the listing partial; a real ENOENT race is a real deletion', async () => {
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    await syncCodeIndex('proj-race', root, { force: true });
    const realStat = realFs.stat.bind(realFs);
    jest.spyOn(realFs, 'stat').mockImplementation((async (p: any, o?: any) => {
      if (path.resolve(String(p)) === path.join(root, 'b.ts')) throw errno('ENOENT');
      return realStat(p, o);
    }) as any);
    const res = await syncCodeIndex('proj-race', root, { force: true });
    expect(res.removed).toBe(1);
    expect(storeMap.get('proj-race/code-index::state')).toMatchObject({ listingErrors: 1 });
    expect(storeMap.get('proj-race/code-index::state').files).not.toHaveProperty(['b.ts']);
    expect(storeMap.get('proj-race/code-index::state').files).toHaveProperty(['a.ts']);
  });

  test('a stat that fails with EMFILE after readdir keeps the file', async () => {
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    await syncCodeIndex('proj-race-emfile', root, { force: true });
    const realStat = realFs.stat.bind(realFs);
    jest.spyOn(realFs, 'stat').mockImplementation((async (p: any, o?: any) => {
      if (path.resolve(String(p)) === path.join(root, 'b.ts')) throw errno('EMFILE');
      return realStat(p, o);
    }) as any);
    const res = await syncCodeIndex('proj-race-emfile', root, { force: true });
    expect(res.removed).toBe(0);
    expect(storeMap.get('proj-race-emfile/code-index::state').files).toHaveProperty(['b.ts']);
  });

  test('walkCodeFilesBreadthFirst reports the error count and codes', async () => {
    const root = await mkTree({ 'a.ts': 'x', 'sub/b.ts': 'x' });
    const realReaddir = realFs.readdir.bind(realFs);
    jest.spyOn(realFs, 'readdir').mockImplementation((async (dir: any, opts: any) => {
      if (path.resolve(String(dir)) === path.join(root, 'sub')) throw errno('EACCES');
      return realReaddir(dir, opts);
    }) as any);
    const walk = await walkCodeFilesBreadthFirst(root, 100);
    expect(walk.files.map(f => path.relative(root, f))).toEqual(['a.ts']);
    expect(walk).toMatchObject({ truncated: false, listingErrors: 1, errorCodes: { EACCES: 1 } });
  });
});

describe('provenance: the sha recorded is the commit the walked tree was at (review fix)', () => {
  test('HEAD moving mid-sync never records a single sha — the range is named instead', async () => {
    const root = await mkTree({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root }).toString().trim();
    git('init', '-q', '-b', 'digby/session-move');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const before = git('rev-parse', 'HEAD');
    // The lane commits while the sync is embedding (the sync is fire-and-forget at run start).
    (memReplaceRef as jest.Mock).mockImplementationOnce(async () => { git('commit', '-q', '--allow-empty', '-m', 'lane work'); return 1; });
    await syncCodeIndex('proj-move', root, { force: true });
    const after = git('rev-parse', 'HEAD');
    expect(after).not.toBe(before);
    const state = storeMap.get('proj-move/code-index::state');
    expect(state).not.toHaveProperty('indexedSha');
    expect(state).toMatchObject({ branch: 'digby/session-move', headMovedFrom: before, headMovedTo: after });
    resetCodeIndexStateCache();
    const line = renderCodeIndexFreshness(await readCodeIndexState('proj-move'), Date.now());
    expect(line).toContain(`index of digby/session-move@${before.slice(0, 7)}..${after.slice(0, 7)}`);
    expect(line).toContain('HEAD moved during the sync');
  });
});

describe('search-time reads load only the small freshness record (review fix)', () => {
  test('readCodeIndexState reads the meta key — never the files map — and caches it per process', async () => {
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    await syncCodeIndex('proj-meta', root, { force: true });
    (storeGet as jest.Mock).mockClear();
    resetCodeIndexStateCache();
    const first = await readCodeIndexState('proj-meta');
    const second = await readCodeIndexState('proj-meta');
    expect((storeGet as jest.Mock).mock.calls.map(c => c[1])).toEqual(['meta']);
    expect(first).not.toHaveProperty('files');
    expect(first).toMatchObject({ fileCount: 2, listed: 2, partial: false, truncated: false });
    expect(second).toEqual(first);
  });

  test('a legacy row (no meta yet) is read once and summarised without its files map', async () => {
    storeMap.set('proj-old/code-index::state', { files: { 'a.ts': 'h', 'b.ts': 'h', 'c.ts': 'h' }, lastSyncAt: '2026-10-01T00:00:00Z' });
    const view = await readCodeIndexState('proj-old');
    expect(view).toEqual({ lastSyncAt: '2026-10-01T00:00:00Z', fileCount: 3 });
    expect(await readCodeIndexState('proj-never')).toBeNull();
  });

  test('a sync in this process refreshes the cached view at once', async () => {
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n' });
    await syncCodeIndex('proj-refresh', root, { force: true });
    expect((await readCodeIndexState('proj-refresh'))?.fileCount).toBe(1);
    await fs.writeFile(path.join(root, 'b.ts'), 'export const b = 1;\n', 'utf8');
    await syncCodeIndex('proj-refresh', root, { force: true });
    expect((await readCodeIndexState('proj-refresh'))?.fileCount).toBe(2);
  });

  test('a v2 → disabled → v2 flip never serves the stale v2 freshness record (the legacy sync drops it)', async () => {
    // Review finding (round 3): syncs under the kill switch update only the
    // state row; once the switch cleared, the old meta (sha, age, fileCount of
    // the last v2 sync) won over the newer state until the next v2 sync.
    const root = await mkTree({ 'a.ts': 'export const a = 1;\n' });
    await syncCodeIndex('proj-flip', root, { force: true });
    expect(storeMap.get('proj-flip/code-index::meta')).toMatchObject({ fileCount: 1 });
    process.env.CODE_INDEX_WALK_V2_DISABLED = '1';
    await fs.writeFile(path.join(root, 'b.ts'), 'export const b = 1;\n', 'utf8');
    await syncCodeIndex('proj-flip', root, { force: true });
    expect(storeMap.has('proj-flip/code-index::meta')).toBe(false);
    delete process.env.CODE_INDEX_WALK_V2_DISABLED;
    resetCodeIndexStateCache();
    const view = await readCodeIndexState('proj-flip');
    expect(view).toMatchObject({ fileCount: 2, lastSyncAt: storeMap.get('proj-flip/code-index::state').lastSyncAt });
    expect(view).not.toHaveProperty('listed');
  });

  test('CODE_INDEX_WALK_V2_DISABLED=1 reads the legacy full state (no meta is maintained)', async () => {
    process.env.CODE_INDEX_WALK_V2_DISABLED = '1';
    storeMap.set('proj-ks/code-index::state', { files: { 'a.ts': 'h' }, lastSyncAt: '2026-10-01T00:00:00Z' });
    storeMap.set('proj-ks/code-index::meta', { fileCount: 99 });
    const view = await readCodeIndexState('proj-ks');
    expect(view).toEqual({ files: { 'a.ts': 'h' }, lastSyncAt: '2026-10-01T00:00:00Z' });
  });
});

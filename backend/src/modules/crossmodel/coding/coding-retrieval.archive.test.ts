/**
 * search_memory's COLD LEG (owner 2026-10-20 "archive instead of delete"): when
 * the hot search returns fewer than k findings, the explicit tool tops up from
 * digby_memory_archive and labels those findings "[archived]". Pins: opt-in
 * (the run-start injection never reads the cold tier), the same scopes + the
 * same per-user gate + the same source filter as the hot read, ≤ k total,
 * de-duplicated against hot hits, bounded by a short timeout, fail-open.
 */
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { projectDocument: { count: jest.fn(async () => 0) } },
}));
jest.mock('../rag.service', () => ({
  __esModule: true,
  embedTexts: jest.fn(),
  rerankTexts: jest.fn(async () => null),
  retrieveChunks: jest.fn(async () => []),
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  ...jest.requireActual('../memory/unified-memory.service'),
  memSearch: jest.fn(async () => []),
  memSearchForUser: jest.fn(async () => []),
  memSearchArchive: jest.fn(async () => []),
  memSearchArchiveForUser: jest.fn(async () => []),
}));
// A short cold-leg budget so the timeout pin runs fast.
jest.mock('../memory/memory-archive', () => ({
  __esModule: true,
  ...jest.requireActual('../memory/memory-archive'),
  ARCHIVE_SEARCH_TIMEOUT_MS: 30,
}));
jest.mock('../memory/memory-access', () => ({
  __esModule: true,
  authorizedProjectScopeIds: jest.fn(async (_u: string, ids: string[]) => ids),
  ownsAllProjects: jest.fn(async () => true),
}));
jest.mock('../platform/folder-inheritance', () => ({ __esModule: true, getRagScopeFolderIds: jest.fn(async (id: string) => [id]) }));
jest.mock('../langgraph/memory.graph', () => ({ __esModule: true, getProjectSettings: jest.fn(async () => ({ crossProjectMemory: true })) }));

import { searchMemory } from './coding-retrieval.service';

const { memSearch, memSearchForUser, memSearchArchive, memSearchArchiveForUser } = jest.requireMock('../memory/unified-memory.service');

const hot = (n: number) => Array.from({ length: n }, (_, i) => ({
  ref: `hot-${i}`, title: '', source: 'orchestrator', content: `hot finding ${i}`, scopeType: 'session', scopeId: 's1', createdAt: '2026-10-19',
}));
const cold = (n: number, extra: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => ({
  ref: `cold-${i}`, title: '', source: 'compaction', content: `cold finding ${i}`, scopeType: 'session', scopeId: 's1', createdAt: '2026-09-01', archived: true, archivedAt: '2026-09-20', ...extra,
}));

beforeEach(() => {
  for (const m of [memSearch, memSearchForUser, memSearchArchive, memSearchArchiveForUser]) { m.mockReset(); m.mockImplementation(async () => []); }
});

describe('search_memory archive top-up', () => {
  it('tops a short hot result up from the archive, labelled [archived], ≤ k total', async () => {
    memSearchForUser.mockResolvedValue(hot(2));
    memSearchArchiveForUser.mockResolvedValue(cold(6));
    const out = await searchMemory('s1', 'what did the build say', 6, { scope: 'session', userId: 'u1', includeArchive: true });
    expect(out).toHaveLength(6);
    expect(out.slice(0, 2).map((f) => f.ref)).toEqual(['hot-0', 'hot-1']);
    expect(out.slice(0, 2).every((f) => !f.archived && !f.content.startsWith('[archived]'))).toBe(true);
    for (const f of out.slice(2)) {
      expect(f.archived).toBe(true);
      expect(f.content.startsWith('[archived] cold finding')).toBe(true);
    }
    // Same scopes + gate + query as the hot read.
    expect(memSearchArchiveForUser).toHaveBeenCalledWith('u1', [{ type: 'session', id: 's1' }], 'what did the build say', 6, expect.objectContaining({ purpose: 'coding_retrieval_archive' }));
  });

  it('is OPT-IN: without includeArchive (the run-start injection) the archive is never read', async () => {
    memSearchForUser.mockResolvedValue(hot(1));
    memSearchArchiveForUser.mockResolvedValue(cold(3));
    const out = await searchMemory('s1', 'q', 6, { scope: 'project', projectId: 'p1', userId: 'u1', sources: ['learning', 'decision'] });
    expect(out).toHaveLength(1);
    expect(memSearchArchiveForUser).not.toHaveBeenCalled();
    expect(memSearchArchive).not.toHaveBeenCalled();
  });

  it('no top-up when the hot search already returned k', async () => {
    memSearchForUser.mockResolvedValue(hot(6));
    const out = await searchMemory('s1', 'q', 6, { userId: 'u1', includeArchive: true });
    expect(out).toHaveLength(6);
    expect(memSearchArchiveForUser).not.toHaveBeenCalled();
  });

  it('passes the project scope + the source filter through, and skips cold rows the hot result already holds', async () => {
    memSearchForUser.mockResolvedValue(hot(1));
    memSearchArchiveForUser.mockResolvedValue([...cold(1, { content: 'hot finding 0' }), ...cold(1, { ref: 'learn-hash', source: 'learning', content: 'a learning' })]);
    const out = await searchMemory('s1', 'q', 6, { scope: 'all', projectId: 'p1', userId: 'u1', sources: ['learning'], includeArchive: true });
    expect(memSearchArchiveForUser).toHaveBeenCalledWith('u1', [{ type: 'session', id: 's1' }, { type: 'project', id: 'p1' }], 'q', 6, expect.objectContaining({ sources: ['learning'] }));
    expect(out.map((f) => f.content)).toEqual(['hot finding 0', '[archived] a learning']);
    expect(out[1].ref).toBe('learnings.md'); // same display mapping as hot learning rows
  });

  it('without a userId the cold leg is the ungated session-only read, like the hot one', async () => {
    memSearch.mockResolvedValue([]);
    memSearchArchive.mockResolvedValue(cold(2));
    const out = await searchMemory('s1', 'q', 6, { projectId: 'p1', includeArchive: true });
    expect(memSearchArchiveForUser).not.toHaveBeenCalled();
    expect(memSearchArchive).toHaveBeenCalledWith([{ type: 'session', id: 's1' }], 'q', 6, expect.any(Object));
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.archived)).toBe(true);
  });

  it('fail-open: an archive error or a slow archive leaves the hot result unchanged', async () => {
    memSearchForUser.mockResolvedValue(hot(2));
    memSearchArchiveForUser.mockRejectedValue(new Error('archive down'));
    expect((await searchMemory('s1', 'q', 6, { userId: 'u1', includeArchive: true })).map((f) => f.ref)).toEqual(['hot-0', 'hot-1']);
    memSearchArchiveForUser.mockImplementation(() => new Promise((r) => setTimeout(() => r(cold(4)), 500)));
    const t0 = Date.now();
    const out = await searchMemory('s1', 'q', 6, { userId: 'u1', includeArchive: true });
    expect(out.map((f) => f.ref)).toEqual(['hot-0', 'hot-1']);
    expect(Date.now() - t0).toBeLessThan(400);
  });
});

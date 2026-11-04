/**
 * fs-durable-memory (2026-10-22): the optional `refs` filter on memSearch /
 * memSearchArchive (+ their per-user gates). A supervisor's search_memory
 * reads the owner's user-scope 'conversation' distills of ONE chat (ref = the
 * chat id) — the filter must reach both SQL legs with the right parameter
 * position after the sources filter, change nothing when absent, and never
 * widen the gate (a user scope other than the caller's own runs no SQL).
 */

const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => []) },
  crossModelProject: { findMany: jest.fn(async () => []) },
  projectMember: { findMany: jest.fn(async () => []) },
  $executeRawUnsafe: jest.fn(async () => 0),
  $queryRawUnsafe: jest.fn(async () => []),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../rag.service', () => ({
  __esModule: true,
  embedTexts: jest.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
  rerankTexts: jest.fn(async () => []),
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { memSearch, memSearchForUser, memSearchArchive, memSearchArchiveForUser, _clearQueryEmbedCache } from './unified-memory.service';

const searchCalls = () => (mockPrisma.$queryRawUnsafe.mock.calls as any[][]).filter((c) => /FROM digby_memory(_archive)?\b/.test(String(c[0])) && !/CREATE|ALTER/.test(String(c[0])));

beforeEach(() => {
  jest.clearAllMocks();
  _clearQueryEmbedCache();
});

describe('memSearch refs filter', () => {
  it('both legs carry `ref = ANY(...)` at the parameter after the sources filter', async () => {
    await memSearch([{ type: 'user', id: 'owner-1' }], 'h100 retired', 6, { sources: ['conversation'], refs: ['fs-chat-1'] });
    const calls = searchCalls().filter((c) => String(c[0]).includes('FROM digby_memory WHERE'));
    expect(calls.length).toBeGreaterThanOrEqual(2); // vector + FTS
    for (const c of calls) {
      const sql = String(c[0]);
      // $1/$2 scope, $3 vector-or-query, $4 sources, $5 refs
      expect(sql).toContain('AND source = ANY($4::text[])');
      expect(sql).toContain('AND ref = ANY($5::text[])');
      expect(c[4]).toEqual(['conversation']);
      expect(c[5]).toEqual(['fs-chat-1']);
    }
  });

  it('refs without sources take the first filter slot', async () => {
    await memSearch([{ type: 'user', id: 'owner-1' }], 'q', 6, { refs: ['fs-chat-1'] });
    const fts = searchCalls().find((c) => String(c[0]).includes('to_tsvector'))!;
    expect(String(fts[0])).toContain('AND ref = ANY($4::text[])');
    expect(String(fts[0])).not.toContain('source = ANY');
    expect(fts[4]).toEqual(['fs-chat-1']);
  });

  it('no refs ⇒ no ref filter (unchanged SQL)', async () => {
    await memSearch([{ type: 'user', id: 'owner-1' }], 'q', 6, { sources: ['conversation'] });
    for (const c of searchCalls()) expect(String(c[0])).not.toContain('ref = ANY');
  });

  it("the gate still holds: another user's scope runs no SQL", async () => {
    const hits = await memSearchForUser('owner-1', [{ type: 'user', id: 'someone-else' }], 'q', 6, { sources: ['conversation'], refs: ['fs-chat-1'] });
    expect(hits).toEqual([]);
    expect(searchCalls()).toHaveLength(0);
  });
});

describe('memSearchArchive refs filter', () => {
  it('the cold read carries the same filter (and the gate)', async () => {
    await memSearchArchive([{ type: 'user', id: 'owner-1' }], 'q', 6, { sources: ['conversation'], refs: ['fs-chat-1'] });
    const c = searchCalls().find((x) => String(x[0]).includes('FROM digby_memory_archive'))!;
    expect(String(c[0])).toContain('AND ref = ANY($5::text[])');
    expect(c[5]).toEqual(['fs-chat-1']);
    jest.clearAllMocks();
    expect(await memSearchArchiveForUser('owner-1', [{ type: 'user', id: 'someone-else' }], 'q', 6, { refs: ['x'] })).toEqual([]);
    expect(searchCalls()).toHaveLength(0);
  });
});

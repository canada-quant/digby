/**
 * Tests for the retrieval math: RRF fusion, age decay, and the write-time
 * quality gate. Pure functions — the heavy I/O paths are mocked away.
 *
 * 2026-09-14: + the per-user gate and knowledge-base federation in searchMemory
 * (owner: coding sessions read the project knowledge base and decisions; one
 * user never reads another user's memory or projects).
 */
const mockProjectDocumentCount: jest.Mock = jest.fn(async () => 0);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { projectDocument: { count: (...a: any[]) => mockProjectDocumentCount(...a) } },
}));
const mockRetrieveChunks: jest.Mock = jest.fn(async (): Promise<any[]> => []);
const mockRerankTexts: jest.Mock = jest.fn(async (): Promise<any> => null);
jest.mock('../rag.service', () => ({
  __esModule: true,
  embedTexts: jest.fn(),
  rerankTexts: (...a: any[]) => mockRerankTexts(...a),
  retrieveChunks: (...a: any[]) => mockRetrieveChunks(...a),
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// Keep the REAL pure helpers (rrfFuse etc. re-export through this module) but
// mock the storage boundary so the scope-widening tests can assert memSearch args.
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  ...jest.requireActual('../memory/unified-memory.service'),
  memSearch: jest.fn(async () => []),
  memSearchForUser: jest.fn(async () => []),
  memInventory: jest.fn(async () => ({})),
}));
// The access leaf (memory-access.ts) is unit-tested on its own; here it is a
// seam — default: every requested project is authorized.
const mockAuthorizedProjectScopeIds: jest.Mock = jest.fn(async (_u: string, ids: string[]) => ids);
const mockOwnsAllProjects: jest.Mock = jest.fn(async () => true); // blend precondition — owner by default
jest.mock('../memory/memory-access', () => ({
  __esModule: true,
  authorizedProjectScopeIds: (...a: any[]) => mockAuthorizedProjectScopeIds(...a),
  ownsAllProjects: (...a: any[]) => mockOwnsAllProjects(...a),
}));
const mockGetRagScopeFolderIds: jest.Mock = jest.fn(async (id: string) => [id]);
jest.mock('../platform/folder-inheritance', () => ({
  __esModule: true,
  getRagScopeFolderIds: (...a: any[]) => mockGetRagScopeFolderIds(...a),
}));
// getProjectSettings is dynamic-imported (heavy static chain) — mocked at the boundary.
const mockGetProjectSettings: jest.Mock = jest.fn(async () => ({ crossProjectMemory: true }));
jest.mock('../langgraph/memory.graph', () => ({
  __esModule: true,
  getProjectSettings: (...a: any[]) => mockGetProjectSettings(...a),
}));

import { rrfFuse, ageDecayFactor, worthEmbedding, searchMemory, buildSessionMemoryInventory, chunkToFinding, KNOWLEDGE_BASE_SOURCE } from './coding-retrieval.service';

const { memSearch, memSearchForUser, memInventory } = jest.requireMock('../memory/unified-memory.service');

describe('rrfFuse', () => {
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };
  test('consensus beats a single strong vote', () => {
    // b is #2 in both lists; a and c are #1 in one list each.
    const fused = rrfFuse([[a, b], [c, b]]);
    expect(fused[0].id).toBe('b'); // 2/(60+1) > 1/60
  });
  test('a doc in one list still ranks', () => {
    const fused = rrfFuse([[a], []]);
    expect(fused).toHaveLength(1);
    expect(fused[0].rrf).toBeCloseTo(1 / 60);
  });
  test('empty lists fuse to empty', () => {
    expect(rrfFuse([[], []])).toEqual([]);
  });
});

describe('ageDecayFactor', () => {
  const now = Date.now();
  test('fresh content is undamped', () => {
    expect(ageDecayFactor(new Date(now), now)).toBeCloseTo(1, 2);
  });
  test('one half-life ≈ 0.75 (dampened, not killed)', () => {
    expect(ageDecayFactor(new Date(now - 14 * 86_400_000), now)).toBeCloseTo(0.75, 2);
  });
  test('very old content floors at 0.5', () => {
    expect(ageDecayFactor(new Date(now - 400 * 86_400_000), now)).toBeCloseTo(0.5, 2);
  });
  test('missing timestamp is neutral', () => {
    expect(ageDecayFactor(null)).toBe(1);
  });
});

const hit = (source: string, ref: string, content: string, scopeType = 'session', scopeId = 's1') =>
  ({ ref, title: '', source, content, scopeType, scopeId, createdAt: '' });

const chunk = (over: Partial<any> = {}) => ({
  id: 'c1', documentId: 'd1', documentName: 'spec.pdf', mimeType: 'application/pdf',
  content: 'The API must return 429 with Retry-After on quota exhaustion.', chunkIndex: 3,
  relevanceScore: 0.9, metadata: {}, ...over,
});

beforeEach(() => {
  (memSearch as jest.Mock).mockClear().mockResolvedValue([]);
  (memSearchForUser as jest.Mock).mockClear().mockResolvedValue([]);
  mockProjectDocumentCount.mockClear().mockResolvedValue(0);
  mockRetrieveChunks.mockClear().mockResolvedValue([]);
  mockRerankTexts.mockClear().mockResolvedValue(null);
  mockAuthorizedProjectScopeIds.mockClear().mockImplementation(async (_u: string, ids: string[]) => ids);
  mockGetRagScopeFolderIds.mockClear().mockImplementation(async (id: string) => [id]);
  mockGetProjectSettings.mockClear().mockResolvedValue({ crossProjectMemory: true });
});

describe('searchMemory scope widening (audit #11: session | project | all) + the per-user gate (2026-09-14)', () => {
  test("default 'all' with a projectId AND a userId queries BOTH scopes through the GATED read", async () => {
    await searchMemory('sess-1', 'auth token refresh', 6, { projectId: 'proj-1', userId: 'u1' });
    expect(memSearchForUser).toHaveBeenCalledWith(
      'u1', [{ type: 'session', id: 'sess-1' }, { type: 'project', id: 'proj-1' }],
      'auth token refresh', 6, { purpose: 'coding_retrieval' },
    );
    expect(memSearch).not.toHaveBeenCalled();
    expect(mockAuthorizedProjectScopeIds).toHaveBeenCalledWith('u1', ['proj-1']);
  });

  test("default 'all' with a projectId but NO userId drops the project scope (fail closed) — session only, ungated read", async () => {
    await searchMemory('sess-1', 'auth token refresh', 6, { projectId: 'proj-1' });
    expect(memSearch).toHaveBeenCalledWith([{ type: 'session', id: 'sess-1' }], 'auth token refresh', 6, { purpose: 'coding_retrieval' });
    expect(memSearchForUser).not.toHaveBeenCalled();
    expect(mockAuthorizedProjectScopeIds).not.toHaveBeenCalled();
    expect(mockRetrieveChunks).not.toHaveBeenCalled();
  });

  test("default 'all' WITHOUT a projectId degrades to session-only (legacy callers unchanged)", async () => {
    await searchMemory('sess-1', 'query');
    expect(memSearch).toHaveBeenCalledWith([{ type: 'session', id: 'sess-1' }], 'query', 6, { purpose: 'coding_retrieval' });
  });

  test("scope 'session' / 'project' select exactly one scope; sources filter passes through", async () => {
    await searchMemory('sess-1', 'q', 6, { scope: 'session', projectId: 'proj-1', userId: 'u1' });
    expect(memSearchForUser).toHaveBeenLastCalledWith('u1', [{ type: 'session', id: 'sess-1' }], 'q', 6, { purpose: 'coding_retrieval' });
    await searchMemory('sess-1', 'q', 6, { scope: 'project', projectId: 'proj-1', userId: 'u1', sources: ['learning'] });
    expect(memSearchForUser).toHaveBeenLastCalledWith('u1', [{ type: 'project', id: 'proj-1' }], 'q', 6, { sources: ['learning'], purpose: 'coding_retrieval' });
  });

  test("scope 'project' without a projectId is an empty no-op (never a session leak)", async () => {
    expect(await searchMemory('sess-1', 'q', 6, { scope: 'project', userId: 'u1' })).toEqual([]);
    expect(memSearch).not.toHaveBeenCalled();
    expect(memSearchForUser).not.toHaveBeenCalled();
  });

  test("scope 'project' for a project the user CANNOT read is empty — no unified read, no knowledge-base read, no doc count", async () => {
    mockAuthorizedProjectScopeIds.mockResolvedValue([]);
    expect(await searchMemory('sess-1', 'q', 6, { scope: 'project', projectId: 'foreign-proj', userId: 'u1' })).toEqual([]);
    expect(memSearchForUser).not.toHaveBeenCalled();
    expect(memSearch).not.toHaveBeenCalled();
    expect(mockRetrieveChunks).not.toHaveBeenCalled();
    expect(mockProjectDocumentCount).not.toHaveBeenCalled();
  });

  test("scope 'all' for an unreadable project keeps ONLY the caller's session scope", async () => {
    mockAuthorizedProjectScopeIds.mockResolvedValue([]);
    await searchMemory('sess-1', 'q', 6, { projectId: 'foreign-proj', userId: 'u1' });
    expect(memSearchForUser).toHaveBeenCalledWith('u1', [{ type: 'session', id: 'sess-1' }], 'q', 6, { purpose: 'coding_retrieval' });
    expect(mockRetrieveChunks).not.toHaveBeenCalled();
  });

  test('the folder chain widens the project scope — every AUTHORIZED ancestor joins; an unauthorized ancestor is dropped', async () => {
    mockGetRagScopeFolderIds.mockResolvedValue(['root', 'mid', 'proj-1']);
    mockAuthorizedProjectScopeIds.mockResolvedValue(['proj-1', 'mid']); // 'root' is someone else's
    await searchMemory('sess-1', 'q', 6, { scope: 'project', projectId: 'proj-1', userId: 'u1' });
    expect(mockAuthorizedProjectScopeIds).toHaveBeenCalledWith('u1', ['proj-1', 'root', 'mid']);
    expect(memSearchForUser).toHaveBeenCalledWith(
      'u1', [{ type: 'project', id: 'proj-1' }, { type: 'project', id: 'mid' }], 'q', 6, { purpose: 'coding_retrieval' },
    );
  });

  test("learning hits surface with the human-meaningful ref 'learnings.md'", async () => {
    (memSearchForUser as jest.Mock).mockResolvedValue([
      hit('learning', 'learning:abc123', 'gh CLI is NOT installed — use curl REST.'),
      hit('web_pipe', 'https://example.com', 'page content'),
    ]);
    const out = await searchMemory('sess-1', 'gh cli', 2, { projectId: 'proj-1', userId: 'u1' });
    expect(out[0]).toEqual({ ref: 'learnings.md', source: 'learning', content: 'gh CLI is NOT installed — use curl REST.' });
    expect(out[1].ref).toBe('https://example.com'); // non-learning refs untouched
  });
});

describe('searchMemory knowledge-base federation (owner 2026-09-14: coding reads the project KB)', () => {
  test('a document chunk joins the results as source document with a doc:<id>#<chunk> ref and a [name] content prefix', async () => {
    mockProjectDocumentCount.mockResolvedValue(2);
    mockRetrieveChunks.mockResolvedValue([chunk()]);
    const out = await searchMemory('sess-1', 'quota exhaustion behavior', 6, { projectId: 'proj-1', userId: 'u1' });
    expect(out).toEqual([{ ref: 'doc:d1#3', source: KNOWLEDGE_BASE_SOURCE, content: '[spec.pdf] The API must return 429 with Retry-After on quota exhaustion.' }]);
    // The chat path's exact call shape: (query, projectId, k, 'dashscope', ancestors = chain minus the leaf, blendUserId).
    expect(mockRetrieveChunks).toHaveBeenCalledWith('quota exhaustion behavior', 'proj-1', 6, 'dashscope', [], 'u1');
  });

  test('ancestor folders = the RAG scope chain minus the leaf (mirrors chat-context), doc-count gate spans the chain + the owned blend', async () => {
    mockGetRagScopeFolderIds.mockResolvedValue(['root', 'mid', 'proj-1']);
    mockProjectDocumentCount.mockResolvedValue(1);
    mockRetrieveChunks.mockResolvedValue([chunk()]);
    await searchMemory('sess-1', 'q', 4, { scope: 'project', projectId: 'proj-1', userId: 'u1' });
    expect(mockRetrieveChunks).toHaveBeenCalledWith('q', 'proj-1', 4, 'dashscope', ['root', 'mid'], 'u1');
    expect(mockProjectDocumentCount).toHaveBeenCalledWith({
      where: { status: 'ready', OR: [{ projectId: { in: ['root', 'mid', 'proj-1'] } }, { userId: 'u1', projectId: { not: null } }] },
    });
  });

  test('crossProjectMemory OFF withholds the blend key (isolated project) — the owned-projects blend is a real opt-out', async () => {
    mockGetProjectSettings.mockResolvedValue({ crossProjectMemory: false });
    mockProjectDocumentCount.mockResolvedValue(1);
    mockRetrieveChunks.mockResolvedValue([chunk()]);
    await searchMemory('sess-1', 'q', 6, { scope: 'project', projectId: 'proj-1', userId: 'u1' });
    expect(mockRetrieveChunks).toHaveBeenCalledWith('q', 'proj-1', 6, 'dashscope', [], undefined);
    expect(mockProjectDocumentCount).toHaveBeenCalledWith({ where: { status: 'ready', OR: [{ projectId: { in: ['proj-1'] } }] } });
  });

  test('unreadable settings default to crossProjectMemory ON (like getProjectSettings itself)', async () => {
    mockGetProjectSettings.mockRejectedValue(new Error('store down'));
    mockProjectDocumentCount.mockResolvedValue(1);
    await searchMemory('sess-1', 'q', 6, { scope: 'project', projectId: 'proj-1', userId: 'u1' });
    expect(mockRetrieveChunks).toHaveBeenCalledWith('q', 'proj-1', 6, 'dashscope', [], 'u1');
  });

  test('a project with no knowledge base skips the KB read entirely (no wasted embedding call)', async () => {
    mockProjectDocumentCount.mockResolvedValue(0);
    await searchMemory('sess-1', 'q', 6, { scope: 'project', projectId: 'proj-1', userId: 'u1' });
    expect(mockRetrieveChunks).not.toHaveBeenCalled();
  });

  test("a source filter that excludes 'document' never touches the knowledge base; ['document'] alone still federates", async () => {
    mockProjectDocumentCount.mockResolvedValue(1);
    mockRetrieveChunks.mockResolvedValue([chunk()]);
    await searchMemory('sess-1', 'q', 6, { scope: 'project', projectId: 'proj-1', userId: 'u1', sources: ['learning'] });
    expect(mockRetrieveChunks).not.toHaveBeenCalled();
    expect(mockProjectDocumentCount).not.toHaveBeenCalled();

    const out = await searchMemory('sess-1', 'q', 6, { scope: 'project', projectId: 'proj-1', userId: 'u1', sources: ['document'] });
    expect(memSearchForUser).toHaveBeenLastCalledWith('u1', [{ type: 'project', id: 'proj-1' }], 'q', 6, { sources: ['document'], purpose: 'coding_retrieval' });
    expect(out.map(f => f.source)).toEqual(['document']);
  });

  test('unified + document hits are merged and RERANKED to top k; the rerank score rides `score`', async () => {
    (memSearchForUser as jest.Mock).mockResolvedValue([
      hit('learning', 'learning:1', 'Always run prisma generate after schema edits.', 'project', 'proj-1'),
      hit('decision', 'decision:2', 'Decision: rate limiting uses a token bucket per API key.', 'project', 'proj-1'),
    ]);
    mockProjectDocumentCount.mockResolvedValue(1);
    mockRetrieveChunks.mockResolvedValue([chunk()]);
    // The cross-encoder puts the document first, the decision second, drops the learning.
    mockRerankTexts.mockResolvedValue([{ index: 2, score: 0.91 }, { index: 1, score: 0.62 }]);
    const out = await searchMemory('sess-1', 'rate limiting', 2, { scope: 'project', projectId: 'proj-1', userId: 'u1' });
    expect(mockRerankTexts).toHaveBeenCalledWith('rate limiting', [
      'Always run prisma generate after schema edits.',
      'Decision: rate limiting uses a token bucket per API key.',
      '[spec.pdf] The API must return 429 with Retry-After on quota exhaustion.',
    ], 2);
    expect(out).toEqual([
      { ref: 'doc:d1#3', source: 'document', content: '[spec.pdf] The API must return 429 with Retry-After on quota exhaustion.', score: 0.91 },
      { ref: 'decision:2', source: 'decision', content: 'Decision: rate limiting uses a token bucket per API key.', score: 0.62 },
    ]);
  });

  test('reranker unavailable → unified-first order sliced to k, no scores', async () => {
    (memSearchForUser as jest.Mock).mockResolvedValue([hit('learning', 'learning:1', 'first learning', 'project', 'proj-1')]);
    mockProjectDocumentCount.mockResolvedValue(1);
    mockRetrieveChunks.mockResolvedValue([chunk(), chunk({ id: 'c2', documentId: 'd2', chunkIndex: 0, documentName: 'notes.md', content: 'second doc' })]);
    mockRerankTexts.mockResolvedValue(null);
    const out = await searchMemory('sess-1', 'q', 2, { scope: 'project', projectId: 'proj-1', userId: 'u1' });
    expect(out).toEqual([
      { ref: 'learnings.md', source: 'learning', content: 'first learning' },
      { ref: 'doc:d1#3', source: 'document', content: '[spec.pdf] The API must return 429 with Retry-After on quota exhaustion.' },
    ]);
    expect(out.every(f => f.score === undefined)).toBe(true);
  });

  test('a KB chunk that was ALSO bridged into the unified store collapses to one item (content fingerprint)', async () => {
    (memSearchForUser as jest.Mock).mockResolvedValue([hit('document', 'doc:d1#3', 'The API must return 429 with Retry-After on quota exhaustion.', 'project', 'proj-1')]);
    mockProjectDocumentCount.mockResolvedValue(1);
    mockRetrieveChunks.mockResolvedValue([chunk()]);
    const out = await searchMemory('sess-1', 'q', 6, { scope: 'project', projectId: 'proj-1', userId: 'u1' });
    expect(out).toHaveLength(1);
    expect(mockRerankTexts).not.toHaveBeenCalled(); // a single survivor needs no rerank
  });

  test('a knowledge-base failure degrades to the unified hits (never a thrown request)', async () => {
    (memSearchForUser as jest.Mock).mockResolvedValue([hit('learning', 'learning:1', 'still here', 'project', 'proj-1')]);
    mockProjectDocumentCount.mockResolvedValue(1);
    mockRetrieveChunks.mockRejectedValue(new Error('dashscope 500'));
    const out = await searchMemory('sess-1', 'q', 6, { scope: 'project', projectId: 'proj-1', userId: 'u1' });
    expect(out).toEqual([{ ref: 'learnings.md', source: 'learning', content: 'still here' }]);
  });

  test('blended-in chunks from another OWNED project carry their source project in the label', () => {
    expect(chunkToFinding(chunk({ sourceProjectName: 'Other Venture' }) as any).content)
      .toBe('[spec.pdf] [project: Other Venture] The API must return 429 with Retry-After on quota exhaustion.');
  });
});

describe('searchMemory — projectMemoryIsolated (2026-10-20: a plain chat in the hidden user space)', () => {
  test('the project scope of the unified store is never searched (its learnings / decisions mix unrelated chats); the knowledge base still federates', async () => {
    (memSearchForUser as jest.Mock).mockClear();
    mockProjectDocumentCount.mockResolvedValue(1);
    mockRetrieveChunks.mockResolvedValue([chunk()]);
    const out = await searchMemory('sess-1', 'logo brief', 6, { projectId: 'userspace', userId: 'u1', projectMemoryIsolated: true });
    expect(memSearchForUser).toHaveBeenCalledWith('u1', [{ type: 'session', id: 'sess-1' }], 'logo brief', 6, { purpose: 'coding_retrieval' });
    expect(mockRetrieveChunks).toHaveBeenCalledWith('logo brief', 'userspace', 6, 'dashscope', [], 'u1');
    expect(out.map(f => f.source)).toContain(KNOWLEDGE_BASE_SOURCE);
  });

  test("scope 'project' alone: no unified search at all, only the uploaded files", async () => {
    (memSearchForUser as jest.Mock).mockClear();
    mockProjectDocumentCount.mockResolvedValue(1);
    mockRetrieveChunks.mockResolvedValue([chunk()]);
    const out = await searchMemory('sess-1', 'q', 6, { scope: 'project', projectId: 'userspace', userId: 'u1', projectMemoryIsolated: true });
    expect(memSearchForUser).not.toHaveBeenCalled();
    expect(out.map(f => f.source)).toEqual([KNOWLEDGE_BASE_SOURCE]);
  });

  test('without the flag the project scope is searched as before', async () => {
    (memSearchForUser as jest.Mock).mockClear();
    mockProjectDocumentCount.mockResolvedValue(0);
    await searchMemory('sess-1', 'q', 6, { projectId: 'proj-1', userId: 'u1' });
    expect((memSearchForUser as jest.Mock).mock.calls[0][1]).toEqual([{ type: 'session', id: 'sess-1' }, { type: 'project', id: 'proj-1' }]);
  });
});

describe('worthEmbedding', () => {
  test('long content always clears the bar', () => {
    expect(worthEmbedding('x'.repeat(200))).toBe(true);
  });
  test('pleasantries are rejected', () => {
    expect(worthEmbedding('sounds good, thanks!')).toBe(false);
    expect(worthEmbedding('ok')).toBe(false);
  });
  test('short but concrete content passes (paths, errors, code)', () => {
    expect(worthEmbedding('fix is in src/modules/auth.ts line 42')).toBe(true);
    expect(worthEmbedding('TypeError: cannot read foo of undefined here')).toBe(true);
    expect(worthEmbedding('run DATABASE_URL=test npx prisma migrate deploy first')).toBe(true);
  });
});

// Owner 2026-09-04: a model that believes memory is empty never searches it —
// the inventory line tells the model at run start what search_memory holds.
describe('buildSessionMemoryInventory', () => {
  beforeEach(() => (memInventory as jest.Mock).mockReset());

  test('formats per-source counts into one standing prompt line', async () => {
    (memInventory as jest.Mock).mockResolvedValue({ web_pipe: 18, worker: 12, compaction: 8 });
    const line = await buildSessionMemoryInventory('sess-1');
    expect(line).toContain('[SESSION MEMORY INVENTORY]');
    expect(line).toContain('38 stored chunks');
    expect(line).toContain('web_pipe 18');
    expect(line).toContain('search_memory');
  });

  test('empty store → empty string (fresh sessions get no noise)', async () => {
    (memInventory as jest.Mock).mockResolvedValue({});
    expect(await buildSessionMemoryInventory('sess-1')).toBe('');
  });

  test('failure → empty string (best-effort, never throws)', async () => {
    (memInventory as jest.Mock).mockRejectedValue(new Error('down'));
    expect(await buildSessionMemoryInventory('sess-1')).toBe('');
  });
});

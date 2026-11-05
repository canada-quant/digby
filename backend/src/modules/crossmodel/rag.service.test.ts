/**
 * Tests for rag.service.ts.
 *
 * storeChunks — the raw multi-row INSERT into project_chunks binds extracted
 * document text, which can carry NUL bytes (Postgres TEXT/JSONB rejects 0x00
 * with error 22021; one bad chunk would poison a whole 50-row batch — issue
 * #90).
 *
 * Blended account-wide RAG (owner decision 2026-08-13): retrieveChunks blends
 * chunks from the user's OTHER owned projects into every project retrieval —
 * in-scope arms boosted (weighted RRF), the global arm double-gated in SQL
 * (owned projects only AND chunk.userId = the requester, so another user's
 * documents NEVER cross over), out-of-scope rows capped to a minority of the
 * final top-K and labeled with their source project. retrieveGlobalChunks
 * gives project-less chats the same owned-projects retrieval, fully labeled.
 *
 * Prisma / axios / logger / utility-llm are mocked; no network or DB. The
 * axios mock answers embeddings with a fixed vector and (when a DASHSCOPE key
 * is present in the env) reranks as IDENTITY with descending scores — so
 * ordering assertions pin the weighted-RRF blend deterministically whether or
 * not the rerank path runs.
 *
 * DASHSCOPE_API_KEY is set BEFORE the import: rag.service captures it at
 * module load, and the keyless-self-host guard (2026-10-26) throws a
 * config-shaped error instead of POSTing `Bearer undefined` to DashScope —
 * the built-in path tests here are the CONFIGURED instance.
 */

// Keyless-guard coverage lives in rag.keyless-guard.test.ts (needs its own
// module registry to load rag.service WITHOUT the key).
process.env.DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || 'test-dashscope-key';

const mockPrisma: any = {
  $executeRawUnsafe: jest.fn(),
  $queryRawUnsafe: jest.fn(),
  crossModelProject: { findMany: jest.fn() },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));
// logger + utility-llm transitively import config/env, whose Zod validation
// process.exit(1)s in a keyless test environment — mock them out.
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: jest.fn(),
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
// model-roles seam (embedTexts/rerank honor the embeddings/rerank role
// overrides): unset → built-in DashScope paths, behavior identical. The real
// modules pull config/env (worker-killing process.exit in jest).
const mockGetModelRoleOverrides = jest.fn(async (): Promise<Record<string, string>> => ({}));
jest.mock('./model-endpoints/model-roles.service', () => ({ __esModule: true, getModelRoleOverrides: (...a: any[]) => mockGetModelRoleOverrides(...(a as [])) }));
const mockResolveRegistryModel = jest.fn(async (): Promise<any> => null);
jest.mock('./model-endpoints/model-endpoints.service', () => ({ __esModule: true, resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...(a as [])) }));

import axios from 'axios';
import {
  storeChunks, RAGChunk, retrieveChunks, retrieveGlobalChunks,
  buildContextBlock, buildCrossProjectBlock, RetrievedChunk, embedTexts,
} from './rag.service';

const mockedAxios = axios as unknown as { post: jest.Mock };
const NUL = String.fromCharCode(0);

function chunk(content: string, fileName = 'doc.pdf'): RAGChunk {
  return { content, chunkIndex: 0, tokenCount: 10, metadata: { fileName } } as RAGChunk;
}

/** A search-arm result row as the raw SQL queries return it. */
function row(id: string, over: Record<string, any> = {}) {
  return {
    id, documentId: `doc-${id}`, documentName: `${id}.pdf`, mimeType: 'pdf',
    content: `content of ${id}`, chunkIndex: 0, metadata: {}, score: 0.9, ...over,
  };
}

// Per-test arm results, dispatched by SQL shape (see wireRetrievalMocks).
let inScopeSemantic: any[] = [];
let inScopeKeyword: any[] = [];
let globalSemantic: any[] = [];
let globalKeyword: any[] = [];

function wireRetrievalMocks(ownedProjects: Array<{ id: string; name: string }>) {
  mockPrisma.crossModelProject.findMany.mockResolvedValue(ownedProjects);
  mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) => {
    if (sql.includes('"chunkIndex" =')) return []; // neighbor expansion — none in these tests
    const isGlobal = sql.includes('pc."userId" =');
    const isSemantic = sql.includes('pc.embedding <=>');
    if (isGlobal) return isSemantic ? globalSemantic : globalKeyword;
    return isSemantic ? inScopeSemantic : inScopeKeyword;
  });
  mockedAxios.post.mockImplementation(async (url: string, body: any) => {
    if (url.includes('/embeddings')) {
      return { data: { data: (body.input as string[]).map((_t, i) => ({ index: i, embedding: [0.1, 0.2, 0.3] })) } };
    }
    if (url.includes('/reranks')) {
      // IDENTITY rerank: keeps the RRF candidate order, scores descending.
      const n = Math.min(body.top_n, body.documents.length);
      return { data: { results: Array.from({ length: n }, (_x, i) => ({ index: i, relevance_score: 1 - i * 0.01 })) } };
    }
    throw new Error(`unexpected axios.post ${url}`);
  });
}

/** All raw-query calls hitting the GLOBAL (cross-project) arm. */
const globalArmCalls = () =>
  mockPrisma.$queryRawUnsafe.mock.calls.filter(([sql]: [string]) => sql.includes('pc."userId" ='));

beforeEach(() => {
  jest.clearAllMocks();
  // Persistent mockResolvedValue set inside one describe must not leak into
  // the next (clearAllMocks keeps implementations) — pin the no-override
  // default for every test; the role-override describe re-sets per test.
  mockGetModelRoleOverrides.mockReset().mockResolvedValue({});
  mockResolveRegistryModel.mockReset().mockResolvedValue(null);
  inScopeSemantic = [];
  inScopeKeyword = [];
  globalSemantic = [];
  globalKeyword = [];
});

describe('embedTexts — embeddings role override (Digby Edge)', () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
  });

  it('unset override → the built-in DashScope path (unchanged default)', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ index: 0, embedding: new Array(1536).fill(0.1) }] } });
    const [vec] = await embedTexts(['hello']);
    expect(vec).toHaveLength(1536);
    expect(mockedAxios.post.mock.calls[0][0]).toContain('dashscope-intl.aliyuncs.com');
  });

  it('a resolving override embeds via the custom /embeddings endpoint (keyless → no auth header)', async () => {
    mockGetModelRoleOverrides.mockResolvedValue({ embeddings: 'my-ollama:nomic-embed' });
    mockResolveRegistryModel.mockResolvedValue({ baseUrl: 'http://10.0.0.5:11434/v1', model: 'nomic-embed', apiKey: undefined });
    mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ index: 0, embedding: new Array(1536).fill(0.2) }] } });
    const [vec] = await embedTexts(['hello']);
    expect(vec).toHaveLength(1536);
    expect(mockedAxios.post.mock.calls[0][0]).toBe('http://10.0.0.5:11434/v1/embeddings');
    expect(mockedAxios.post.mock.calls[0][2].headers.Authorization).toBeUndefined();
  });

  it('FAILS CLOSED: a configured override that no longer resolves throws — never a silent DashScope fallback (mixed vector spaces)', async () => {
    mockGetModelRoleOverrides.mockResolvedValue({ embeddings: 'my-ollama:nomic-embed' });
    mockResolveRegistryModel.mockResolvedValue(null); // endpoint disabled/deleted
    await expect(embedTexts(['hello'])).rejects.toThrow(/does not currently resolve/);
    expect(mockedAxios.post).not.toHaveBeenCalled(); // DashScope was NOT called
  });

  it('a wrong-dimension custom embedding is a hard error naming the spec', async () => {
    mockGetModelRoleOverrides.mockResolvedValue({ embeddings: 'my-ollama:nomic-embed' });
    mockResolveRegistryModel.mockResolvedValue({ baseUrl: 'http://10.0.0.5:11434/v1', model: 'nomic-embed', apiKey: 'k' });
    mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ index: 0, embedding: new Array(768).fill(0.2) }] } });
    await expect(embedTexts(['hello'])).rejects.toThrow(/768.*1536|1536.*768/);
  });

  // ── Matryoshka (owner 2026-09-08: Qwen3-Embedding-8B natively returns 4096) ──

  it('an UNFLAGGED model returning 4096 dims still fails closed, and the error says whether `dimensions` was REJECTED or ignored', async () => {
    mockGetModelRoleOverrides.mockResolvedValue({ embeddings: 'cql:Qwen3-Embedding-8B' });
    mockResolveRegistryModel.mockResolvedValue({ baseUrl: 'https://llm.cql.ca/v1', model: 'Qwen3-Embedding-8B', apiKey: 'k' });
    // Server IGNORES the param (200 with the native size).
    mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ index: 0, embedding: new Array(4096).fill(0.2) }] } });
    await expect(embedTexts(['hello'])).rejects.toThrow(/4096 dimensions \(the server ignored the dimensions=1536 request\)[\s\S]*flag it "MRL"/);
    // Server REJECTS the param (400 → retry without → native size).
    mockedAxios.post.mockReset();
    mockedAxios.post
      .mockRejectedValueOnce(Object.assign(new Error('bad'), { response: { status: 400 } }))
      .mockResolvedValueOnce({ data: { data: [{ index: 0, embedding: new Array(4096).fill(0.2) }] } });
    await expect(embedTexts(['hello'])).rejects.toThrow(/4096 dimensions \(the server REJECTED the dimensions=1536 request\)[\s\S]*is_matryoshka/);
  });

  it('a model FLAGGED matryoshka is truncated to the leading 1536 dims and L2-normalized (the `dimensions` operation, client-side)', async () => {
    mockGetModelRoleOverrides.mockResolvedValue({ embeddings: 'cql:Qwen3-Embedding-8B' });
    mockResolveRegistryModel.mockResolvedValue({ baseUrl: 'https://llm.cql.ca/v1', model: 'Qwen3-Embedding-8B', apiKey: 'k', matryoshka: true });
    // Distinct head vs tail so truncation (not resampling) is provable.
    const native = [...new Array(1536).fill(3), ...new Array(4096 - 1536).fill(99)];
    mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ index: 0, embedding: native }] } });
    const [vec] = await embedTexts(['hello']);
    expect(vec).toHaveLength(1536);
    // Every kept component was 3 → after L2 normalization each is 1/sqrt(1536).
    expect(vec[0]).toBeCloseTo(1 / Math.sqrt(1536), 10);
    expect(vec[1535]).toBeCloseTo(1 / Math.sqrt(1536), 10);
    expect(Math.hypot(...vec)).toBeCloseTo(1, 8);
    // A flagged model that natively matches is passed through untouched.
    mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ index: 0, embedding: new Array(1536).fill(0.5) }] } });
    const [same] = await embedTexts(['hi']);
    expect(same[0]).toBe(0.5);
  });

  it('a flagged model returning FEWER than 1536 dims cannot be padded — still a hard error', async () => {
    mockGetModelRoleOverrides.mockResolvedValue({ embeddings: 'cql:small-embed' });
    mockResolveRegistryModel.mockResolvedValue({ baseUrl: 'https://llm.cql.ca/v1', model: 'small-embed', apiKey: 'k', matryoshka: true });
    mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ index: 0, embedding: new Array(768).fill(0.2) }] } });
    await expect(embedTexts(['hello'])).rejects.toThrow(/768[\s\S]*1536/);
  });
});

describe('storeChunks', () => {
  test('rejects on chunk/embedding count mismatch', async () => {
    await expect(storeChunks('d1', null, 'u1', [chunk('a')], [])).rejects.toThrow('mismatch');
    expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  test('strips NUL bytes from chunk content and metadata before the batch INSERT', async () => {
    const chunks = [
      { ...chunk(`bank state${NUL}ment`), chunkIndex: 0 },
      { ...chunk('clean'), chunkIndex: 1, metadata: { fileName: `re${NUL}port.pdf`, page: 3 } },
    ];
    await storeChunks('d1', 'p1', 'u1', chunks, [[0.1, 0.2], [0.3, 0.4]]);

    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = mockPrisma.$executeRawUnsafe.mock.calls[0];
    expect(sql).toContain('INSERT INTO project_chunks');
    // Every bound string param (content, vector, metadata json) is NUL-free.
    for (const arg of params) {
      if (typeof arg === 'string') expect(arg.includes(NUL)).toBe(false);
    }
    // Row 1: content sanitized (params[3]); Row 2: metadata json has the NUL
    // escape sequence removed entirely, page preserved (params[15]).
    expect(params[3]).toBe('bank statement');
    expect(params[15]).toBe('{"fileName":"report.pdf","page":3}');
  });

  test('preserves literal backslash-u0000 TEXT in metadata (escape-parity safe)', async () => {
    // Reviewer finding on PR #106: stripping the 6-char sequence from serialized
    // JSON corrupts strings that legitimately contain that TEXT. The fix strips
    // raw NULs from values BEFORE serialization, so literal text round-trips.
    const BS = String.fromCharCode(92);
    const literalName = `re${BS}u0000port.pdf`; // 15 chars, no raw NUL
    const chunks = [{ ...chunk('clean'), chunkIndex: 0, metadata: { fileName: literalName, page: 1 } }];
    await storeChunks('d1', null, 'u1', chunks, [[0.1]]);

    const [, ...params] = mockPrisma.$executeRawUnsafe.mock.calls[0];
    const metaJson = params[7];
    expect(metaJson.includes(NUL)).toBe(false); // Postgres-safe text…
    expect(JSON.parse(metaJson).fileName).toBe(literalName); // …and lossless round-trip
  });

  test('batches >50 chunks into multiple INSERTs', async () => {
    const chunks = Array.from({ length: 51 }, (_, i) => ({ ...chunk(`c${i}`), chunkIndex: i }));
    const embeddings = chunks.map(() => [0.1]);
    await storeChunks('d1', null, 'u1', chunks, embeddings);
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
  });
});

// ── Blended account-wide retrieval (retrieveChunks + userId) ─────────────────

describe('retrieveChunks — blended cross-project arm', () => {
  test('without userId behaves exactly as before: no ownership lookup, no global arm, no labels', async () => {
    wireRetrievalMocks([{ id: 'p2', name: 'Other' }]);
    inScopeSemantic = [row('A1')];
    const out = await retrieveChunks('q', 'p1', 5, 'dashscope', []);
    expect(out.map((c) => c.id)).toEqual(['A1']);
    expect(out[0].sourceProjectName).toBeUndefined();
    expect(mockPrisma.crossModelProject.findMany).not.toHaveBeenCalled();
    expect(globalArmCalls()).toHaveLength(0);
  });

  test('blends a same-user cross-project hit BELOW an equally-ranked in-scope hit, labeled with its source project', async () => {
    wireRetrievalMocks([{ id: 'p1', name: 'Current' }, { id: 'p2', name: 'Other' }]);
    inScopeSemantic = [row('A1')];                       // in-scope arm, rank 0 (weight 1.0)
    globalSemantic = [row('B1', { projectId: 'p2' })];   // global arm, rank 0 (weight 0.75)
    const out = await retrieveChunks('q', 'p1', 5, 'dashscope', [], 'u1');

    // Boost ordering: equal ranks → the in-scope chunk wins the RRF blend.
    expect(out.map((c) => c.id)).toEqual(['A1', 'B1']);
    expect(out[0].sourceProjectName).toBeUndefined();          // current project — unlabeled
    expect(out[1].sourceProjectName).toBe('Other');            // cross-project — attributed
    // Ownership is resolved through the requesting user's OWNED projects only
    // (archived folders excluded — archive/restore, owner 2026-09-08).
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', archivedAt: null },
      select: { id: true, name: true },
    });
  });

  test('the global arm is double-gated in SQL: owned projects only AND chunk.userId = the requester', async () => {
    wireRetrievalMocks([{ id: 'p1', name: 'Current' }, { id: 'p2', name: 'Other' }]);
    inScopeSemantic = [row('A1')];
    await retrieveChunks('q', 'p1', 5, 'dashscope', [], 'u1');

    const calls = globalArmCalls();
    expect(calls).toHaveLength(2); // semantic + keyword
    for (const [sql, ...params] of calls) {
      expect(sql).toContain('pc."projectId" = ANY($2::text[])');
      expect(sql).toContain('pc."userId" = $3');
      expect(params[1]).toEqual(['p2']); // owned minus the current scope — NEVER another user's project
      expect(params[2]).toBe('u1');
    }
  });

  test('inside a member-shared project: its docs stay in-scope, the global arm still covers ONLY owned projects', async () => {
    // 'pShared' is owned by someone else (absent from the owned list) — the
    // in-scope arm may read it (membership), but it never joins the global arm
    // of any other chat, and the global arm here spans the user's own projects.
    wireRetrievalMocks([{ id: 'p1', name: 'Mine 1' }, { id: 'p2', name: 'Mine 2' }]);
    inScopeSemantic = [row('S1')];
    await retrieveChunks('q', 'pShared', 5, 'dashscope', [], 'u1');

    const inScopeCall = mockPrisma.$queryRawUnsafe.mock.calls.find(
      ([sql]: [string]) => sql.includes('pc.embedding <=>') && !sql.includes('pc."userId" ='),
    )!;
    expect(inScopeCall[2]).toBe('pShared'); // shared project readable in-scope
    const calls = globalArmCalls();
    expect(calls).toHaveLength(2);
    for (const [, ...params] of calls) {
      expect(params[1].sort()).toEqual(['p1', 'p2']); // owned only — pShared excluded
    }
  });

  test('skips the global queries entirely when the user owns no other projects', async () => {
    wireRetrievalMocks([{ id: 'p1', name: 'Current' }]);
    inScopeSemantic = [row('A1')];
    const out = await retrieveChunks('q', 'p1', 5, 'dashscope', [], 'u1');
    expect(out.map((c) => c.id)).toEqual(['A1']);
    expect(globalArmCalls()).toHaveLength(0);
  });

  test('caps out-of-scope chunks to a minority of the final top-K even when they out-rank in-scope hits', async () => {
    wireRetrievalMocks([{ id: 'p1', name: 'Current' }, { id: 'p2', name: 'Other' }]);
    inScopeSemantic = [row('A1'), row('A2'), row('A3'), row('A4')];
    // Globals hit BOTH global arms → they win the weighted RRF outright…
    globalSemantic = [row('B1', { projectId: 'p2' }), row('B2', { projectId: 'p2' }), row('B3', { projectId: 'p2' })];
    globalKeyword = [...globalSemantic];
    const out = await retrieveChunks('q', 'p1', 5, 'dashscope', [], 'u1');

    // …but the composition cap holds them to 2 of the final 5 (still first,
    // preserving relevance order), with in-scope rows filling the rest.
    expect(out).toHaveLength(5);
    expect(out.map((c) => c.id)).toEqual(['B1', 'B2', 'A1', 'A2', 'A3']);
    expect(out.filter((c) => c.sourceProjectName).map((c) => c.id)).toEqual(['B1', 'B2']);
  });

  test('out-of-scope chunks may backfill when in-scope results cannot fill the top-K', async () => {
    wireRetrievalMocks([{ id: 'p1', name: 'Current' }, { id: 'p2', name: 'Other' }]);
    inScopeSemantic = [row('A1')]; // the current project barely matches
    globalSemantic = [row('B1', { projectId: 'p2' }), row('B2', { projectId: 'p2' }), row('B3', { projectId: 'p2' })];
    globalKeyword = [...globalSemantic];
    const out = await retrieveChunks('q', 'p1', 4, 'dashscope', [], 'u1');

    // cap(4) = 1 → B1 admitted, A1 in, then B2/B3 backfill the empty slots.
    expect(out.map((c) => c.id)).toEqual(['B1', 'A1', 'B2', 'B3']);
    expect(out.filter((c) => c.sourceProjectName)).toHaveLength(3);
  });
});

// ── Project-less chats (retrieveGlobalChunks) ────────────────────────────────

describe('retrieveGlobalChunks — account-wide retrieval for no-project chats', () => {
  test('searches ALL owned projects (chunk.userId-gated) and labels every result with its source project', async () => {
    wireRetrievalMocks([{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }]);
    globalSemantic = [row('C1', { projectId: 'p1' }), row('C2', { projectId: 'p2' })];
    const out = await retrieveGlobalChunks('q', 'u1', 5, 'dashscope');

    expect(out.map((c) => c.id)).toEqual(['C1', 'C2']);
    expect(out.map((c) => c.sourceProjectName)).toEqual(['Alpha', 'Beta']);
    const calls = globalArmCalls();
    expect(calls).toHaveLength(2); // semantic + keyword, both gated
    for (const [sql, ...params] of calls) {
      expect(sql).toContain('pc."userId" = $3');
      expect(params[1].sort()).toEqual(['p1', 'p2']);
      expect(params[2]).toBe('u1');
    }
  });

  test('returns [] without touching the DB search or the embedder when the user owns no projects', async () => {
    wireRetrievalMocks([]);
    const out = await retrieveGlobalChunks('q', 'u1', 5, 'dashscope');
    expect(out).toEqual([]);
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});

// ── Context-block labeling ────────────────────────────────────────────────────

describe('context blocks label cross-project knowledge', () => {
  const labeled: RetrievedChunk = {
    id: 'x1', documentId: 'd1', documentName: 'spec.pdf', mimeType: 'pdf',
    content: 'cross-project content', chunkIndex: 0, relevanceScore: 0.8,
    metadata: {}, sourceProjectName: 'Other Project',
  };
  const local: RetrievedChunk = { ...labeled, id: 'x2', documentName: 'local.pdf', sourceProjectName: undefined };

  test('buildContextBlock tags cross-project entries and adds the attribution note', () => {
    const block = buildContextBlock('Current', null, [local, labeled]);
    expect(block).toContain('spec.pdf — from project "Other Project"');
    expect(block).toContain('attribute them to that project');
    expect(block).not.toContain('local.pdf — from project'); // in-scope rows stay unlabeled
  });

  test('buildContextBlock omits the attribution note when every chunk is in-scope', () => {
    const block = buildContextBlock('Current', null, [local]);
    expect(block).not.toContain('attribute them to that project');
  });

  test('buildCrossProjectBlock accepts a custom header for project-less chats', () => {
    const block = buildCrossProjectBlock([labeled], 'RELEVANT CONTEXT FROM YOUR PROJECTS');
    expect(block).toContain('═══ RELEVANT CONTEXT FROM YOUR PROJECTS ═══');
    expect(block).toContain('from project "Other Project"');
    // Default header preserved for existing callers.
    expect(buildCrossProjectBlock([labeled])).toContain('FROM YOUR OTHER PROJECTS');
  });
});

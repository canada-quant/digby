/**
 * Project learnings → chat: the per-user gate END TO END (owner 2026-09-14:
 * "one user can never access memory or knowledge about another user or another
 * user's projects").
 *
 * Unlike the boundary suite, the unified store and memory-access are REAL here;
 * only prisma + the embedding/rerank leaf are mocked. The digby_memory SQL
 * layer echoes one row per scope actually queried (same trick as
 * memory/unified-memory.gated.test.ts), so a hit's scopeId IS the proof of which
 * project scopes reached the DB — and a foreign id that never shows up was
 * dropped BEFORE the query, by the gate, not by rendering.
 */

const mockPrisma: any = {
  crossModelProject: {
    findMany: jest.fn(),
    // ownsAllProjects (blend precondition, EOD review 2026-09-14): derived from the same fixture the findMany mock serves.
    count: jest.fn(async ({ where }: any) => {
      const rows: any[] = await mockPrisma.crossModelProject.findMany({ where: { id: { in: where?.id?.in ?? [] } }, select: { id: true, userId: true, parentId: true } });
      return rows.filter((r) => r.userId === where?.userId).length;
    }),
  },
  projectMember: { findMany: jest.fn(async () => []) },
  crossModelChat: { findMany: jest.fn(async () => []) },
  $executeRawUnsafe: jest.fn(async () => 0),
  $queryRawUnsafe: jest.fn(async () => []),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), setEx: jest.fn(), del: jest.fn() } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../rag.service', () => ({
  __esModule: true,
  // Null query embedding → the vector leg throws and is skipped; only the FTS leg returns rows.
  embedTexts: jest.fn(async (texts: string[]) => texts.map(() => null)),
  rerankTexts: jest.fn(async () => []),
  retrieveChunks: jest.fn(async () => []),
  retrieveGlobalChunks: jest.fn(async () => []),
  buildContextBlock: jest.fn(() => ''),
  buildCrossProjectBlock: jest.fn(() => ''),
}));
jest.mock('../context.service', () => ({ __esModule: true, default: { loadChatContext: jest.fn(), loadSessionContext: jest.fn() } }));
jest.mock('../langgraph/memory.graph', () => ({ getEnrichedContext: jest.fn(), getProjectSettings: jest.fn() }));

import { retrieveProjectLearnings, buildProjectLearningsSubBlock, PROJECT_LEARNINGS_HEADER } from './chat-context';

// Folder tree: alice owns R (root) → C → G, and a second root P2. bob owns F.
// bob is a MEMBER of C (so C and its descendant G are readable by bob). carol is a stranger.
const PROJECTS: Record<string, { id: string; userId: string; parentId: string | null; name: string }> = {
  R:  { id: 'R',  userId: 'alice', parentId: null, name: 'Root' },
  C:  { id: 'C',  userId: 'alice', parentId: 'R',  name: 'Child' },
  G:  { id: 'G',  userId: 'alice', parentId: 'C',  name: 'Grandchild' },
  P2: { id: 'P2', userId: 'alice', parentId: null, name: 'Second Root' },
  F:  { id: 'F',  userId: 'bob',   parentId: null, name: 'Bobs Project' },
};

/** The digby_memory SELECTs that actually ran, as scope ids (project scopes only). */
function queriedProjectIds(): string[] {
  const out: string[] = [];
  for (const call of mockPrisma.$queryRawUnsafe.mock.calls as any[][]) {
    const sql = String(call[0]);
    if (!sql.includes('FROM digby_memory') || !sql.includes('to_tsvector')) continue;
    const n = (sql.match(/scope_type = \$/g) || []).length;
    for (let i = 0; i < n; i++) if (call[1 + i * 2] === 'project') out.push(call[2 + i * 2]);
  }
  return out.sort();
}

/** The `source = ANY($n)` filter param of the FTS query that ran (undefined when none). */
function queriedSources(): string[] | undefined {
  for (const call of mockPrisma.$queryRawUnsafe.mock.calls as any[][]) {
    const sql = String(call[0]);
    if (!sql.includes('FROM digby_memory') || !sql.includes('to_tsvector')) continue;
    if (!sql.includes('source = ANY')) return undefined;
    return call[call.length - 1];
  }
  return undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.crossModelProject.findMany.mockImplementation(async ({ where, select }: any) => {
    let rows: any[] = [];
    if (where?.id?.in) rows = where.id.in.filter((id: string) => PROJECTS[id]).map((id: string) => PROJECTS[id]);
    else if (where?.userId) {
      const notIn: string[] = where.id?.notIn ?? [];
      rows = Object.values(PROJECTS).filter((r) => r.userId === where.userId && !notIn.includes(r.id));
    }
    if (!select) return rows;
    return rows.map((r) => Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, (r as any)[k]])));
  });
  mockPrisma.projectMember.findMany.mockImplementation(async ({ where }: any) =>
    (where.userId === 'bob' ? ['C'] : []).filter((p) => where.projectId.in.includes(p)).map((projectId) => ({ projectId })));
  // Echo one FTS 'learning' row per scope queried — a hit's scopeId proves the scope reached SQL.
  mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string, ...params: any[]) => {
    if (!String(sql).includes('to_tsvector')) return [];
    const n = (String(sql).match(/scope_type = \$/g) || []).length;
    const rows: any[] = [];
    for (let i = 0; i < n; i++) {
      const type = params[i * 2]; const id = params[i * 2 + 1];
      rows.push({ id: `${type}:${id}`, ref: 'hash', title: '', source: 'learning', content: `convention of ${id}`, scope_type: type, scope_id: id, created_at: new Date(), score: 1 });
    }
    return rows;
  });
});

const ids = (hits: Array<{ scopeId: string }>) => hits.map((h) => h.scopeId).sort();

describe('retrieveProjectLearnings — the foreign project id is dropped BEFORE the query', () => {
  it('alice in C with the RAG chain [R, C] plus a smuggled foreign F: F never reaches SQL, the rest does', async () => {
    const hits = await retrieveProjectLearnings({ userId: 'alice', projectId: 'C', ragScopeIds: ['R', 'C', 'F'], message: 'how do we run migrations', k: 10 });
    expect(queriedProjectIds()).toEqual(['C', 'R']);
    expect(ids(hits)).toEqual(['C', 'R']);
    expect(queriedSources()).toEqual(['learning', 'decision']);
    // In-scope hits render without any provenance marker (the legend line
    // mentions the markers by name, so check the bullet lines only).
    const block = buildProjectLearningsSubBlock(hits, ['C', 'R', 'C']);
    expect(block).toContain(`[${PROJECT_LEARNINGS_HEADER} — 2 durable notes`);
    const bullets = block.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(2);
    for (const b of bullets) expect(b).toMatch(/^- \(learning · learnings\.md\) convention of (C|R)$/);
  });

  it('bob (member of C only) reads C and its descendants, never the ancestor R he is not a member of, never alice\'s other roots — and, as a MEMBER, gets NO blend of his own projects into the shared context (EOD review 2026-09-14)', async () => {
    const hits = await retrieveProjectLearnings({ userId: 'bob', projectId: 'G', ragScopeIds: ['R', 'C', 'G'], blendUserId: 'bob', message: 'x', k: 10 });
    // Blend on for bob → his OWNED F joins; R is dropped (membership is on C); P2 (alice's) is never in play.
    expect(queriedProjectIds()).toEqual(['C', 'G']);
    expect(ids(hits)).toEqual(['C', 'G']);
    const block = buildProjectLearningsSubBlock(hits, ['G', 'R', 'C']);
    expect(block).not.toContain('Bobs Project'); // bob's private F never enters the shared project's context
    expect(block).not.toContain('Second Root');
  });

  it('the owned-project blend (crossProjectMemory on) adds alice\'s OTHER owned roots, labelled by name — never bob\'s F', async () => {
    const hits = await retrieveProjectLearnings({ userId: 'alice', projectId: 'C', ragScopeIds: ['R', 'C'], blendUserId: 'alice', message: 'x', k: 10 });
    expect(queriedProjectIds()).toEqual(['C', 'G', 'P2', 'R']);
    expect(ids(hits)).toEqual(['C', 'G', 'P2', 'R']);
    const block = buildProjectLearningsSubBlock(hits, ['C', 'R', 'C']);
    expect(block).toContain('- (learning · learnings.md · from project "Second Root") convention of P2');
    expect(block).toContain('- (learning · learnings.md · from project "Grandchild") convention of G');
    expect(block).not.toContain('Bobs Project');
    expect(block).not.toContain('[Second Root]'); // the store's title label is folded into the marker, not printed twice
  });

  it('with the blend OFF the read stays inside the folder chain (no owned roots joined)', async () => {
    const hits = await retrieveProjectLearnings({ userId: 'alice', projectId: 'C', ragScopeIds: ['R', 'C'], message: 'x', k: 10 });
    expect(queriedProjectIds()).toEqual(['C', 'R']);
    expect(ids(hits)).toEqual(['C', 'R']);
  });

  it('a blend key naming someone else is refused — alice\'s read never widens on bob\'s behalf', async () => {
    const hits = await retrieveProjectLearnings({ userId: 'alice', projectId: 'C', ragScopeIds: ['C'], blendUserId: 'bob', message: 'x', k: 10 });
    expect(queriedProjectIds()).toEqual(['C']);
    expect(ids(hits)).toEqual(['C']);
  });

  it('a stranger (carol) gets nothing and NO digby_memory query runs at all', async () => {
    const hits = await retrieveProjectLearnings({ userId: 'carol', projectId: 'C', ragScopeIds: ['R', 'C'], blendUserId: 'carol', message: 'x', k: 10 });
    expect(hits).toEqual([]);
    expect(queriedProjectIds()).toEqual([]);
    expect(buildProjectLearningsSubBlock(hits, ['C', 'R'])).toBe('');
  });

  it('an unknown / deleted project id is a no-op scope, not a widening', async () => {
    const hits = await retrieveProjectLearnings({ userId: 'alice', projectId: 'ZZZ', ragScopeIds: ['ZZZ'], message: 'x', k: 10 });
    expect(hits).toEqual([]);
    expect(queriedProjectIds()).toEqual([]);
  });

  it('a gate lookup failure fails CLOSED — nothing is queried, nothing rendered', async () => {
    mockPrisma.crossModelProject.findMany.mockRejectedValue(new Error('db down'));
    const hits = await retrieveProjectLearnings({ userId: 'alice', projectId: 'C', ragScopeIds: ['R', 'C'], blendUserId: 'alice', message: 'x', k: 10 });
    expect(hits).toEqual([]);
    expect(queriedProjectIds()).toEqual([]);
  });
});

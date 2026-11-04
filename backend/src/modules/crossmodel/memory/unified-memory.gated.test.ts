/**
 * Per-user memory gates on the unified store (owner 2026-09-14: "one user can
 * never read memory or knowledge about another user or another user's
 * projects"). These pins cover memSearchForUser / memSearchProjectsBlended —
 * the REQUEST-derived read path — with the real memory-access predicate over
 * a mocked prisma. The SQL layer is mocked to echo one row per scope actually
 * queried, so a hit's scopeId IS the proof of which scopes reached the DB.
 */

const mockPrisma: any = {
  crossModelProject: {
    findMany: jest.fn(),
    // ownsAllProjects (blend precondition, EOD review 2026-09-14): owner rows from the fixture.
    count: jest.fn(async ({ where }: any) => (where?.id?.in ?? []).filter((id: string) => PROJECTS[id]?.userId === where?.userId).length),
  },
  projectMember: { findMany: jest.fn(async () => []) },
  crossModelChat: { findMany: jest.fn() },
  $executeRawUnsafe: jest.fn(async () => 0),
  $queryRawUnsafe: jest.fn(async () => []),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../rag.service', () => ({
  __esModule: true,
  // Null query embedding → the vector leg throws and is skipped; only the FTS leg returns rows.
  embedTexts: jest.fn(async (texts: string[]) => texts.map(() => null)),
  rerankTexts: jest.fn(async () => []),
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import {
  memSearchForUser, memSearchProjectsBlended, authorizedMemScopes, memSearch, BLEND_OWNED_PROJECT_CAP, MemScope,
} from './unified-memory.service';

// Folder tree: alice owns R (root) → C → G, and a second root P2. bob owns F.
// bob is a MEMBER of C (so C and its descendant G are readable by bob). carol is a stranger.
const PROJECTS: Record<string, { id: string; userId: string; parentId: string | null; name: string }> = {
  R:  { id: 'R',  userId: 'alice', parentId: null, name: 'Root' },
  C:  { id: 'C',  userId: 'alice', parentId: 'R',  name: 'Child' },
  G:  { id: 'G',  userId: 'alice', parentId: 'C',  name: 'Grandchild' },
  P2: { id: 'P2', userId: 'alice', parentId: null, name: 'Second Root', isUserSpace: true } as any, // alice's hidden user space (excludeUserSpace pin)
  F:  { id: 'F',  userId: 'bob',   parentId: null, name: 'Bobs Project' },
};
// Chats: chatA = alice's, no project. chatB = bob's, inside C. chatF = bob's, inside F. chatX = carol's.
const CHATS: Record<string, { id: string; userId: string; projectId: string | null }> = {
  chatA: { id: 'chatA', userId: 'alice', projectId: null },
  chatB: { id: 'chatB', userId: 'bob',   projectId: 'C' },
  chatF: { id: 'chatF', userId: 'bob',   projectId: 'F' },
  chatX: { id: 'chatX', userId: 'carol', projectId: null },
};

/** The digby_memory SELECTs that actually ran, as [scopeType, scopeId] pairs. */
function queriedScopes(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const call of mockPrisma.$queryRawUnsafe.mock.calls as any[][]) {
    const sql = String(call[0]);
    if (!sql.includes('FROM digby_memory') || !sql.includes('to_tsvector')) continue;
    const n = (sql.match(/scope_type = \$/g) || []).length;
    for (let i = 0; i < n; i++) out.push([call[1 + i * 2], call[2 + i * 2]]);
  }
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.crossModelProject.findMany.mockImplementation(async ({ where, select }: any) => {
    let rows: any[] = [];
    if (where?.id?.in) rows = where.id.in.filter((id: string) => PROJECTS[id]).map((id: string) => PROJECTS[id]);
    else if (where?.userId) {
      const notIn: string[] = where.id?.notIn ?? [];
      rows = Object.values(PROJECTS).filter((r) => r.userId === where.userId && !notIn.includes(r.id) && !(where.isUserSpace === false && (r as any).isUserSpace));
    }
    if (!select) return rows;
    return rows.map((r) => Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, (r as any)[k]])));
  });
  mockPrisma.projectMember.findMany.mockImplementation(async ({ where }: any) =>
    (where.userId === 'bob' ? ['C'] : []).filter((p) => where.projectId.in.includes(p)).map((projectId) => ({ projectId })));
  mockPrisma.crossModelChat.findMany.mockImplementation(async ({ where }: any) =>
    (where?.id?.in ?? []).filter((id: string) => CHATS[id]).map((id: string) => ({ ...CHATS[id] })));
  // Echo one FTS row per scope queried — a hit's scopeId proves the scope reached SQL.
  mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string, ...params: any[]) => {
    if (!String(sql).includes('to_tsvector')) return [];
    const n = (String(sql).match(/scope_type = \$/g) || []).length;
    const rows: any[] = [];
    for (let i = 0; i < n; i++) {
      const type = params[i * 2]; const id = params[i * 2 + 1];
      rows.push({ id: `${type}:${id}`, ref: '', title: 'row', source: 'code', content: `content of ${id}`, scope_type: type, scope_id: id, created_at: new Date(), score: 1 });
    }
    return rows;
  });
});

const P = (id: string): MemScope => ({ type: 'project', id });
const S = (id: string): MemScope => ({ type: 'session', id });
const U = (id: string): MemScope => ({ type: 'user', id });
const ids = (hits: Array<{ scopeId: string }>) => hits.map((h) => h.scopeId).sort();

describe('memSearchForUser — project scopes', () => {
  it('drops foreign project scopes and keeps owned ones (alice: her tree, never F)', async () => {
    const hits = await memSearchForUser('alice', [P('R'), P('C'), P('G'), P('F')], 'anything', 10);
    expect(ids(hits)).toEqual(['C', 'G', 'R']);
    expect(queriedScopes().map(([, id]) => id)).not.toContain('F');
  });

  it('keeps member-inherited scopes (bob: C via membership, G via inheritance, F owned; never R)', async () => {
    const hits = await memSearchForUser('bob', [P('R'), P('C'), P('G'), P('F')], 'anything', 10);
    expect(ids(hits)).toEqual(['C', 'F', 'G']);
  });

  it('a stranger gets nothing and NO memory SQL runs', async () => {
    expect(await memSearchForUser('carol', [P('R'), P('C'), P('F')], 'anything', 10)).toEqual([]);
    expect(queriedScopes()).toEqual([]);
  });
});

describe('memSearchForUser — user scopes', () => {
  it("rejects a foreign 'user' scope and keeps the caller's own", async () => {
    const hits = await memSearchForUser('alice', [U('alice'), U('bob')], 'preferences', 10);
    expect(ids(hits)).toEqual(['alice']);
    expect(queriedScopes()).toEqual([['user', 'alice']]);
  });
});

describe('memSearchForUser — session/chat scopes', () => {
  it('rejects a chat scope the user cannot access (another user, no shared project) and unknown ids', async () => {
    const hits = await memSearchForUser('alice', [S('chatA'), S('chatX'), S('chatF'), S('nope')], 'findings', 10);
    expect(ids(hits)).toEqual(['chatA']);
    const queried = queriedScopes().map(([, id]) => id);
    expect(queried).not.toContain('chatX');
    expect(queried).not.toContain('chatF');
    expect(queried).not.toContain('nope');
  });

  it("keeps another user's chat when it sits in a project the caller may read (alice owns C ⇒ reads bob's chatB)", async () => {
    const hits = await memSearchForUser('alice', [S('chatB')], 'findings', 10);
    expect(ids(hits)).toEqual(['chatB']);
  });

  it("a member does not reach the owner's chats outside the shared project (bob: chatB own, chatA no)", async () => {
    const hits = await memSearchForUser('bob', [S('chatA'), S('chatB'), { type: 'chat', id: 'chatF' }], 'findings', 10);
    expect(ids(hits)).toEqual(['chatB', 'chatF']);
  });

  it('resolves every chat with ONE findMany and one authorization pass over the union of project ids', async () => {
    await memSearchForUser('alice', [P('R'), S('chatB'), S('chatF'), S('chatA')], 'x', 10);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.crossModelChat.findMany.mock.calls[0][0];
    expect(arg.where.id.in.sort()).toEqual(['chatA', 'chatB', 'chatF']);
    expect(arg.select).toEqual({ id: true, userId: true, projectId: true });
    // authorizedProjectScopeIds saw R (explicit) + C, F (from the chats) — one candidate lookup
    const projectLookups = mockPrisma.crossModelProject.findMany.mock.calls.filter((c: any[]) => c[0]?.where?.id?.in);
    expect(projectLookups[0][0].where.id.in.sort()).toEqual(['C', 'F', 'R']);
  });
});

describe('memSearchForUser — fail closed', () => {
  it('a chat lookup error yields no hits and runs no memory SQL', async () => {
    mockPrisma.crossModelChat.findMany.mockRejectedValueOnce(new Error('down'));
    expect(await memSearchForUser('alice', [P('R'), S('chatA')], 'x', 10)).toEqual([]);
    expect(queriedScopes()).toEqual([]);
  });

  it('a project lookup error yields no hits (memory-access fails closed underneath)', async () => {
    mockPrisma.crossModelProject.findMany.mockRejectedValueOnce(new Error('down'));
    expect(await memSearchForUser('alice', [P('R')], 'x', 10)).toEqual([]);
    expect(queriedScopes()).toEqual([]);
  });

  it('empty user / query / scopes short-circuit without touching the DB', async () => {
    expect(await memSearchForUser('', [P('R')], 'x', 10)).toEqual([]);
    expect(await memSearchForUser('alice', [P('R')], '   ', 10)).toEqual([]);
    expect(await memSearchForUser('alice', [], 'x', 10)).toEqual([]);
    expect(mockPrisma.crossModelChat.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelProject.findMany).not.toHaveBeenCalled();
    expect(queriedScopes()).toEqual([]);
  });

  it('authorizedMemScopes preserves order and collapses duplicates', async () => {
    expect(await authorizedMemScopes('alice', [P('G'), P('F'), U('alice'), P('G'), S('chatA')]))
      .toEqual([P('G'), U('alice'), S('chatA')]);
  });

  it('passes the source filter through to memSearch unchanged', async () => {
    await memSearchForUser('alice', [P('R')], 'x', 10, { sources: ['learning', 'document'] });
    const call = mockPrisma.$queryRawUnsafe.mock.calls.find((c: any[]) => String(c[0]).includes('to_tsvector'));
    expect(String(call[0])).toContain('source = ANY(');
    expect(call[call.length - 1]).toEqual(['learning', 'document']);
  });
});

describe('memSearchProjectsBlended — owned-project blend', () => {
  it("never includes another user's project (alice: primary C + owned R, G, P2 — never bob's F)", async () => {
    const hits = await memSearchProjectsBlended('alice', ['C'], 'decision', 10, { blendOwned: true });
    expect(ids(hits)).toEqual(['C', 'G', 'P2', 'R']);
    expect(queriedScopes().map(([, id]) => id)).not.toContain('F');
    for (const [type] of queriedScopes()) expect(type).toBe('project');
  });

  it('a MEMBER never blends — not even their own projects — into a shared project they do not own (bob: C only; never F, never R/G/P2) (EOD review 2026-09-14)', async () => {
    const hits = await memSearchProjectsBlended('bob', ['C'], 'decision', 10, { blendOwned: true });
    expect(ids(hits)).toEqual(['C']);
    const queried = queriedScopes().map(([, id]) => id);
    for (const foreign of ['F', 'R', 'G', 'P2']) expect(queried).not.toContain(foreign);
  });

  it('an OWNER blends their other owned projects (bob: F primary + nothing else owned; alice: C primary + R/G/P2)', async () => {
    const bob = await memSearchProjectsBlended('bob', ['F'], 'decision', 10, { blendOwned: true });
    expect(ids(bob)).toEqual(['F']);
    const alice = await memSearchProjectsBlended('alice', ['C'], 'decision', 10, { blendOwned: true });
    expect(ids(alice).sort()).toEqual(['C', 'G', 'P2', 'R']);
  });

  it('excludeUserSpace (2026-10-20): the hidden user space (P2) never joins the owned blend; the primary and other owned projects stay', async () => {
    const hits = await memSearchProjectsBlended('alice', ['C'], 'decision', 10, { blendOwned: true, excludeUserSpace: true });
    expect(ids(hits).sort()).toEqual(['C', 'G', 'R']);
    expect(queriedScopes().map(([, id]) => id)).not.toContain('P2');
  });

  it('without blendOwned only the authorized primaries are searched (alice: C kept, F dropped)', async () => {
    const hits = await memSearchProjectsBlended('alice', ['C', 'F'], 'decision', 10);
    expect(ids(hits)).toEqual(['C']);
    expect(hits[0].crossProject).toBe(false);
    expect(hits[0].title).toBe('row'); // primary hits are not relabelled
  });

  it('labels cross-project hits with their project name (structured fields + title prefix; one findMany)', async () => {
    const hits = await memSearchProjectsBlended('alice', ['C'], 'decision', 10, { blendOwned: true });
    const byId = Object.fromEntries(hits.map((h) => [h.scopeId, h]));
    expect(byId.C).toMatchObject({ projectId: 'C', crossProject: false, title: 'row' });
    expect(byId.R).toMatchObject({ projectId: 'R', projectName: 'Root', crossProject: true, title: '[Root] row' });
    expect(byId.P2).toMatchObject({ projectId: 'P2', projectName: 'Second Root', crossProject: true, title: '[Second Root] row' });
    const nameLookups = mockPrisma.crossModelProject.findMany.mock.calls.filter((c: any[]) => c[0]?.select?.name);
    expect(nameLookups).toHaveLength(1);
    expect(nameLookups[0][0].where.id.in.sort()).toEqual(['G', 'P2', 'R']);
  });

  it('an unauthorized primary and no blend yields nothing and runs no memory SQL (carol on C)', async () => {
    expect(await memSearchProjectsBlended('carol', ['C'], 'decision', 10)).toEqual([]);
    expect(await memSearchProjectsBlended('carol', ['C'], 'decision', 10, { blendOwned: true })).toEqual([]);
    expect(queriedScopes()).toEqual([]);
  });

  it(`caps the owned blend at ${BLEND_OWNED_PROJECT_CAP} projects and excludes the primaries from the owned lookup`, async () => {
    await memSearchProjectsBlended('alice', ['C'], 'decision', 10, { blendOwned: true, ownedCap: 500 });
    const ownedLookup = mockPrisma.crossModelProject.findMany.mock.calls.find((c: any[]) => c[0]?.where?.userId === 'alice');
    expect(ownedLookup).toBeDefined();
    expect(ownedLookup[0].take).toBe(BLEND_OWNED_PROJECT_CAP);
    expect(ownedLookup[0].where.id.notIn).toEqual(['C']);
  });

  // ── Ticket a6ba3fda (2026-10-17): the no-primary owned blend (projectless
  // supervisor chats) + gated extraScopes ──────────────────────────────────────
  it('NO-PRIMARY blend: empty primaries + blendOwned searches the caller\'s OWNED projects (alice: R/C/G/P2; never bob\'s F)', async () => {
    const hits = await memSearchProjectsBlended('alice', [], 'fleet sweep', 10, { blendOwned: true });
    expect(ids(hits)).toEqual(['C', 'G', 'P2', 'R']);
    expect(queriedScopes().map(([, id]) => id)).not.toContain('F');
    for (const [type] of queriedScopes()) expect(type).toBe('project');
  });

  it('NO-PRIMARY without blendOwned stays a no-op (no owned lookup, no memory SQL) — the fleet path opts in explicitly', async () => {
    expect(await memSearchProjectsBlended('alice', [], 'x', 10)).toEqual([]);
    expect(mockPrisma.crossModelProject.findMany.mock.calls.find((c: any[]) => c[0]?.where?.userId === 'alice')).toBeUndefined();
    expect(queriedScopes()).toEqual([]);
  });

  it('NO-PRIMARY + extraScopes: the caller\'s OWN chat scope joins, a stranger\'s never does (the authorizedMemScopes gate)', async () => {
    const hits = await memSearchProjectsBlended('alice', [], 'fleet sweep', 10, {
      blendOwned: true,
      extraScopes: [S('chatA'), S('chatX'), { type: 'chat', id: 'chatB' }],
    });
    // alice owns chatA; chatB sits in project C which alice owns ⇒ both pass the
    // gate; carol's chatX is dropped before SQL. Projects come from the blend.
    expect(ids(hits)).toEqual(['C', 'G', 'P2', 'R', 'chatA', 'chatB'].sort());
    const queried = queriedScopes();
    expect(queried.map(([, id]) => id)).not.toContain('chatX');
    expect(queried).toContainEqual(['session', 'chatA']);
    expect(queried).toContainEqual(['chat', 'chatB']);
  });

  it('NO-PRIMARY: a chat/session-scope hit is never labelled "another project" (scopeId is a chat id, not a project id)', async () => {
    const hits = await memSearchProjectsBlended('alice', [], 'fleet sweep', 10, {
      blendOwned: true,
      extraScopes: [S('chatA')],
    });
    const chatHit = hits.find((h) => h.scopeType === 'session')!;
    expect(chatHit).toBeDefined();
    expect(chatHit).toMatchObject({ crossProject: false, projectName: null, projectId: '' });
    expect(chatHit.title).not.toContain('another project');
    // No chat id is ever sent to the project-name lookup.
    for (const call of mockPrisma.crossModelProject.findMany.mock.calls as any[][]) {
      if (call[0]?.select?.name) expect(call[0].where.id.in).not.toContain('chatA');
    }
  });

  it('NO-PRIMARY: a member\'s other owned projects blend in (bob owns F, no primary — the fleet path is owner-scoped by definition)', async () => {
    const hits = await memSearchProjectsBlended('bob', [], 'x', 10, { blendOwned: true, extraScopes: [S('chatF')] });
    expect(ids(hits)).toEqual(['F', 'chatF'].sort());
  });

  it('NO-PRIMARY fails closed on a lookup error', async () => {
    mockPrisma.crossModelProject.findMany.mockRejectedValue(new Error('down'));
    expect(await memSearchProjectsBlended('alice', [], 'x', 10, { blendOwned: true })).toEqual([]);
    expect(queriedScopes()).toEqual([]);
  });

  it('fails closed on a lookup error', async () => {
    mockPrisma.crossModelProject.findMany.mockRejectedValue(new Error('down'));
    expect(await memSearchProjectsBlended('alice', ['C'], 'decision', 10, { blendOwned: true })).toEqual([]);
    expect(queriedScopes()).toEqual([]);
  });
});

describe('memSearch stays the raw scope-trusting primitive (existing callers unchanged)', () => {
  it('queries exactly the scopes it is handed — no user gate of its own', async () => {
    const hits = await memSearch([P('F'), S('chatX')], 'x', 10);
    expect(ids(hits)).toEqual(['F', 'chatX']);
    expect(mockPrisma.crossModelChat.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.projectMember.findMany).not.toHaveBeenCalled();
  });
});

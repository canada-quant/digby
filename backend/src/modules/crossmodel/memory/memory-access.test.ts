/**
 * Memory access gates (owner 2026-09-14): one user can never read memory or
 * knowledge about another user or another user's projects. These pins cover
 * the access predicate every memory read goes through.
 */
const mockPrisma: any = {
  crossModelProject: { findMany: jest.fn() },
  projectMember: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { authorizedProjectScopeIds, canReadProjectMemory, ownedProjectIds, ownsAllProjects } from './memory-access';

// Folder tree: root R (owner alice) → child C (owner alice) → grandchild G (owner alice).
// Foreign project F (owner bob). Bob is a MEMBER of C only.
const ROWS: Record<string, { id: string; userId: string; parentId: string | null }> = {
  R: { id: 'R', userId: 'alice', parentId: null },
  C: { id: 'C', userId: 'alice', parentId: 'R' },
  G: { id: 'G', userId: 'alice', parentId: 'C' },
  F: { id: 'F', userId: 'bob', parentId: null },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.crossModelProject.findMany.mockImplementation(async ({ where, select }: any) => {
    if (where?.id?.in) return where.id.in.filter((id: string) => ROWS[id]).map((id: string) => ROWS[id]);
    if (where?.userId) {
      const notIn: string[] = where.id?.notIn ?? [];
      return Object.values(ROWS).filter((r) => r.userId === where.userId && !notIn.includes(r.id)).map((r) => (select?.id ? { id: r.id } : r));
    }
    return [];
  });
  mockPrisma.projectMember.findMany.mockImplementation(async ({ where }: any) =>
    (where.userId === 'bob' ? ['C'] : []).filter((p) => where.projectId.in.includes(p)).map((projectId) => ({ projectId })));
});

describe('authorizedProjectScopeIds — owner, inherited member, and everyone else', () => {
  it('the owner reads every folder in their tree; a foreign project is DROPPED, never widened', async () => {
    expect(await authorizedProjectScopeIds('alice', ['R', 'C', 'G', 'F'])).toEqual(['R', 'C', 'G']);
  });

  it('a member of folder C reads C and its descendant G (inheritance flows DOWN), not the parent R', async () => {
    expect(await authorizedProjectScopeIds('bob', ['R', 'C', 'G'])).toEqual(['C', 'G']);
  });

  it('a stranger reads nothing; unknown ids are never scopes', async () => {
    expect(await authorizedProjectScopeIds('carol', ['R', 'C', 'G', 'F', 'nope'])).toEqual([]);
    expect(await authorizedProjectScopeIds('alice', ['nope'])).toEqual([]);
  });

  it('fails CLOSED on a lookup error (no scopes), and on empty input', async () => {
    mockPrisma.crossModelProject.findMany.mockRejectedValueOnce(new Error('down'));
    expect(await authorizedProjectScopeIds('alice', ['R'])).toEqual([]);
    expect(await authorizedProjectScopeIds('', ['R'])).toEqual([]);
    expect(await authorizedProjectScopeIds('alice', [])).toEqual([]);
  });

  it('canReadProjectMemory is the single-project form', async () => {
    expect(await canReadProjectMemory('bob', 'G')).toBe(true);
    expect(await canReadProjectMemory('bob', 'R')).toBe(false);
    expect(await canReadProjectMemory('bob', 'F')).toBe(true); // bob owns F
    expect(await canReadProjectMemory('alice', 'F')).toBe(false);
  });
});

describe('ownedProjectIds — the ONLY set cross-project blending may span', () => {
  it('returns owned projects only (never member-shared), honouring the exclusion', async () => {
    expect((await ownedProjectIds('alice')).sort()).toEqual(['C', 'G', 'R']);
    expect(await ownedProjectIds('bob')).toEqual(['F']); // bob is a MEMBER of C — not included
    expect((await ownedProjectIds('alice', { exclude: ['C'] })).sort()).toEqual(['G', 'R']);
  });

  it('excludeUserSpace (2026-10-20) asks the DB for isUserSpace false — the hidden space never joins a learnings blend', async () => {
    await ownedProjectIds('alice', { excludeUserSpace: true });
    expect(mockPrisma.crossModelProject.findMany.mock.calls.at(-1)[0].where).toEqual({ userId: 'alice', isUserSpace: false });
    await ownedProjectIds('alice', { exclude: ['C'] });
    expect(mockPrisma.crossModelProject.findMany.mock.calls.at(-1)[0].where).toEqual({ userId: 'alice', id: { notIn: ['C'] } });
  });

  it('fails closed', async () => {
    mockPrisma.crossModelProject.findMany.mockRejectedValueOnce(new Error('down'));
    expect(await ownedProjectIds('alice')).toEqual([]);
    expect(await ownedProjectIds('')).toEqual([]);
  });
});

describe('ownsAllProjects — the blend precondition (EOD review 2026-09-14)', () => {
  beforeEach(() => {
    mockPrisma.crossModelProject.count = jest.fn(async ({ where }: any) =>
      where.id.in.filter((id: string) => ROWS[id] && ROWS[id].userId === where.userId).length);
  });
  it('true only when the caller owns EVERY project; a member is not an owner', async () => {
    expect(await ownsAllProjects('alice', ['R', 'C'])).toBe(true);
    expect(await ownsAllProjects('bob', ['C'])).toBe(false); // member of C, not owner
    expect(await ownsAllProjects('alice', ['R', 'F'])).toBe(false);
    expect(await ownsAllProjects('bob', ['F'])).toBe(true);
  });
  it('fails closed on empty input and lookup errors', async () => {
    expect(await ownsAllProjects('alice', [])).toBe(false);
    expect(await ownsAllProjects('', ['R'])).toBe(false);
    mockPrisma.crossModelProject.count.mockRejectedValueOnce(new Error('down'));
    expect(await ownsAllProjects('alice', ['R'])).toBe(false);
  });
});

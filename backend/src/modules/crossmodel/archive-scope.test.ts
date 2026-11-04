/**
 * archive-scope unit tests (owner 2026-09-08 archive/restore) — the shared
 * "which projects are hidden by archival?" resolution behind the default chat
 * lists and search. Pins:
 *   - the fast path: NO archived folders ⇒ one probe, no subtree query, [];
 *   - subtree expansion via the materialized path (descendants ride along);
 *   - extraProjectIds widen the archived-root probe (member projects);
 *   - chatArchiveExclusion's where-fragment keeps unfiled chats visible
 *     (explicit projectId:null arm — SQL NOT IN drops NULLs).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findMany: jest.fn() },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { getArchiveHiddenProjectIds, chatArchiveExclusion } from './archive-scope';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getArchiveHiddenProjectIds', () => {
  it('fast path: no archived folders ⇒ [] after ONE query (no subtree scan)', async () => {
    mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
    await expect(getArchiveHiddenProjectIds('u1')).resolves.toEqual([]);
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ archivedAt: { not: null }, OR: [{ userId: 'u1' }] }),
      }),
    );
  });

  it('archived folders expand to their whole subtree via the materialized path', async () => {
    mockPrisma.crossModelProject.findMany
      .mockResolvedValueOnce([{ id: 'root', path: '/root' }]) // archived roots
      .mockResolvedValueOnce([{ id: 'child' }, { id: 'grandchild' }]); // descendants
    await expect(getArchiveHiddenProjectIds('u1')).resolves.toEqual(['root', 'child', 'grandchild']);
    // The subtree probe matched the root's path prefix (trailing slash — no
    // sibling-id prefix collisions, the moveFolder/deleteProject idiom).
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        where: { OR: [{ path: { startsWith: '/root/' } }] },
      }),
    );
  });

  it('a blank/legacy path falls back to /<id> (never a match-everything prefix)', async () => {
    mockPrisma.crossModelProject.findMany
      .mockResolvedValueOnce([{ id: 'legacy', path: '' }])
      .mockResolvedValueOnce([]);
    await expect(getArchiveHiddenProjectIds('u1')).resolves.toEqual(['legacy']);
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        where: { OR: [{ path: { startsWith: '/legacy/' } }] },
      }),
    );
  });

  it('extraProjectIds widen the archived-root probe (shared folders the owner archived)', async () => {
    mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
    await getArchiveHiddenProjectIds('u1', ['pm-1', 'pm-2']);
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ userId: 'u1' }, { id: { in: ['pm-1', 'pm-2'] } }],
        }),
      }),
    );
  });
});

describe('chatArchiveExclusion', () => {
  it('no hidden folders ⇒ just the own-stamp filter', () => {
    expect(chatArchiveExclusion([])).toEqual({ archivedAt: null });
  });

  it('hidden folders ⇒ own-stamp filter + notIn arm that KEEPS unfiled (projectId null) chats', () => {
    expect(chatArchiveExclusion(['p1', 'p2'])).toEqual({
      archivedAt: null,
      AND: [{ OR: [{ projectId: null }, { projectId: { notIn: ['p1', 'p2'] } }] }],
    });
  });
});

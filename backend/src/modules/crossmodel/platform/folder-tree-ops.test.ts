/**
 * Folder tree (P2 platform unification) — the SHARED subtree-rewrite ops
 * (folder-tree-ops.ts) unit-tested directly with a mocked Prisma, following
 * the folder-tree.test.ts fixture style. Pins:
 *   - relocateFolderChildren with reparent null → every direct child becomes a
 *     TRUTHFUL root (parentId null, depth 0, path '/'+id) with descendants
 *     (incl. nested grandchildren) re-anchored: depth-shift FIRST on the old
 *     path prefix, then path-prefix swaps;
 *   - reparent set → move semantics under the target (depth/​path consistent);
 *   - a childless folder delete is a no-op (no writes);
 *   - a depth-cap violation rejects BEFORE any write;
 *   - rewriteSubtreeRoot ordering (updateMany depth shift precedes path swaps).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: {
    findMany: jest.fn(),
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 0 })),
  },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time — mock AppError (same shape).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
// folder-inheritance imports the store (never read by these ops).
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));

import { relocateFolderChildren, rewriteSubtreeRoot } from './folder-tree-ops';
import { MAX_FOLDER_DEPTH } from './folder-inheritance';

interface Row { id: string; parentId: string | null; depth: number; path: string }

/** Wire crossModelProject.findMany for the two where-shapes the ops use. */
function mockTree(rows: Row[]) {
  mockPrisma.crossModelProject.findMany.mockImplementation(async ({ where, orderBy, select }: any = {}) => {
    let out = rows;
    if (where?.parentId !== undefined) out = out.filter((r) => r.parentId === where.parentId);
    if (where?.path?.startsWith) out = out.filter((r) => r.path.startsWith(where.path.startsWith));
    if (orderBy?.depth === 'asc') out = [...out].sort((a, b) => a.depth - b.depth);
    return select ? out.map(({ id, path, depth }) => ({ id, path, depth })) : out;
  });
}

/** A folder p with two direct children, one of which has a nested grandchild. */
const TREE: Row[] = [
  { id: 'p', parentId: null, depth: 0, path: '/p' },
  { id: 'c', parentId: 'p', depth: 1, path: '/p/c' },
  { id: 'gc', parentId: 'c', depth: 2, path: '/p/c/gc' },
  { id: 'ggc', parentId: 'gc', depth: 3, path: '/p/c/gc/ggc' },
  { id: 'c2', parentId: 'p', depth: 1, path: '/p/c2' },
];

beforeEach(() => jest.clearAllMocks());

describe('relocateFolderChildren with reparent null (delete → children become roots)', () => {
  it('promotes every direct child to a TRUTHFUL root and re-anchors nested descendants', async () => {
    mockTree(TREE);
    const n = await relocateFolderChildren(mockPrisma, { folder: { id: 'p', path: '/p' }, reparent: null });
    expect(n).toBe(2); // c and c2

    // Both children are roots now.
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'c' }, data: { parentId: null, depth: 0, path: '/c' },
    });
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'c2' }, data: { parentId: null, depth: 0, path: '/c2' },
    });
    // Nested descendants keep consistency: grandchild + great-grandchild paths.
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'gc' }, data: { path: '/c/gc' },
    });
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'ggc' }, data: { path: '/c/gc/ggc' },
    });
    // Depth shift FIRST, matched on the OLD prefix, exactly -1 for c's subtree…
    expect(mockPrisma.crossModelProject.updateMany).toHaveBeenCalledWith({
      where: { path: { startsWith: '/p/c/' } }, data: { depth: { increment: -1 } },
    });
    // …and it precedes every path swap (after the swap the old prefix matches nothing).
    const firstSwap = Math.min(...mockPrisma.crossModelProject.update.mock.invocationCallOrder);
    expect(mockPrisma.crossModelProject.updateMany.mock.invocationCallOrder[0]).toBeLessThan(firstSwap);
    // c2's subtree is empty → no depth-shift updateMany for it.
    expect(mockPrisma.crossModelProject.updateMany).toHaveBeenCalledTimes(1);
  });

  it('a childless folder delete is a no-op (0 relocated, zero writes)', async () => {
    mockTree(TREE);
    const n = await relocateFolderChildren(mockPrisma, { folder: { id: 'ggc', path: '/p/c/gc/ggc' }, reparent: null });
    expect(n).toBe(0);
    expect(mockPrisma.crossModelProject.update).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelProject.updateMany).not.toHaveBeenCalled();
  });
});

describe('relocateFolderChildren with reparent set (delete → children move)', () => {
  it('moves each child (with its subtree) under the reparent target', async () => {
    mockTree(TREE);
    const n = await relocateFolderChildren(mockPrisma, {
      folder: { id: 'p', path: '/p' },
      reparent: { id: 't', path: '/t', depth: 0 },
    });
    expect(n).toBe(2);
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'c' }, data: { parentId: 't', depth: 1, path: '/t/c' },
    });
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'c2' }, data: { parentId: 't', depth: 1, path: '/t/c2' },
    });
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'gc' }, data: { path: '/t/c/gc' },
    });
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'ggc' }, data: { path: '/t/c/gc/ggc' },
    });
    // Same depth under a depth-0 target → no descendant shift needed.
    expect(mockPrisma.crossModelProject.updateMany).not.toHaveBeenCalled();
  });

  it('shifts descendant depths when the target is deeper', async () => {
    mockTree(TREE);
    await relocateFolderChildren(mockPrisma, {
      folder: { id: 'p', path: '/p' },
      reparent: { id: 't', path: '/x/t', depth: 1 },
    });
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'c' }, data: { parentId: 't', depth: 2, path: '/x/t/c' },
    });
    expect(mockPrisma.crossModelProject.updateMany).toHaveBeenCalledWith({
      where: { path: { startsWith: '/p/c/' } }, data: { depth: { increment: 1 } },
    });
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'ggc' }, data: { path: '/x/t/c/gc/ggc' },
    });
  });

  it('a depth-cap violation rejects BEFORE any write (pre-check)', async () => {
    mockTree(TREE);
    // c's subtree is 2 deep (gc, ggc): target at depth MAX-1 → MAX+1 > MAX.
    const deepTarget = { id: 't', path: '/a/b/c/d/t', depth: MAX_FOLDER_DEPTH - 1 };
    await expect(relocateFolderChildren(mockPrisma, { folder: { id: 'p', path: '/p' }, reparent: deepTarget }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/depth limit/) });
    expect(mockPrisma.crossModelProject.update).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelProject.updateMany).not.toHaveBeenCalled();
  });

  it('a subtree that exactly reaches the cap is allowed', async () => {
    mockTree(TREE);
    // c's subtree height is 2 (gc, ggc): target at MAX-3 → deepest lands exactly at MAX.
    const target = { id: 't', path: '/a/b/t', depth: MAX_FOLDER_DEPTH - 3 };
    await expect(relocateFolderChildren(mockPrisma, { folder: { id: 'p', path: '/p' }, reparent: target }))
      .resolves.toBe(2);
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'c' }, data: { parentId: 't', depth: MAX_FOLDER_DEPTH - 2, path: '/a/b/t/c' },
    });
  });
});

describe('rewriteSubtreeRoot', () => {
  it('depth-shifts FIRST (old prefix), then swaps paths, then repoints the root', async () => {
    const child = { id: 'c', path: '/p/c', depth: 1 };
    const descendants = [
      { id: 'gc', path: '/p/c/gc', depth: 2 },
      { id: 'ggc', path: '/p/c/gc/ggc', depth: 3 },
    ];
    await rewriteSubtreeRoot(mockPrisma, child, descendants, null, '/c', 0);

    expect(mockPrisma.crossModelProject.updateMany).toHaveBeenCalledWith({
      where: { path: { startsWith: '/p/c/' } }, data: { depth: { increment: -1 } },
    });
    expect(mockPrisma.crossModelProject.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'gc' }, data: { path: '/c/gc' },
    });
    expect(mockPrisma.crossModelProject.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'ggc' }, data: { path: '/c/gc/ggc' },
    });
    expect(mockPrisma.crossModelProject.update).toHaveBeenNthCalledWith(3, {
      where: { id: 'c' }, data: { parentId: null, depth: 0, path: '/c' },
    });
    expect(mockPrisma.crossModelProject.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(mockPrisma.crossModelProject.update.mock.invocationCallOrder[0]);
  });

  it('skips the depth shift when the delta is zero or there are no descendants', async () => {
    await rewriteSubtreeRoot(mockPrisma, { id: 'c', path: '/p/c', depth: 1 }, [], 't', '/t/c', 1);
    expect(mockPrisma.crossModelProject.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'c' }, data: { parentId: 't', depth: 1, path: '/t/c' },
    });
  });
});

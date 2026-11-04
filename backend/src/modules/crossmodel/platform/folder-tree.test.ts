/**
 * Folder tree (P2 platform unification) — tree ops + ancestor inheritance,
 * unit-tested with mocked Prisma (pattern follows platform.service.test.ts).
 *
 * Pins: nested create depth/path maintenance, the depth cap (5), move
 * cycle/depth checks + subtree path/depth rewrites, delete child promotion /
 * reparentTo fixups, effective systemPrompt concat (root→leaf), inherited
 * member roles, store-read merging, workspace resolution from the nearest
 * ancestor with repoProvider, and FOLDERS_INHERITANCE=off fallback behavior.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: {
    findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(),
    create: jest.fn(), update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })),
    delete: jest.fn(async () => ({})), deleteMany: jest.fn(async () => ({})),
  },
  crossModelChat: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(async () => ({})), deleteMany: jest.fn(async () => ({})) },
  chatCodingState: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(async () => ({})), deleteMany: jest.fn(async () => ({})) },
  projectMember: { findUnique: jest.fn(), findMany: jest.fn() },
  userPreferences: { findUnique: jest.fn() },
  activity: { create: jest.fn(async () => ({})) },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};

jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { incr: jest.fn(), expire: jest.fn(), decr: jest.fn(), set: jest.fn(), del: jest.fn() } }));

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

// crossmodel.service's model integrations (never called in these tests).
jest.mock('../integrations/moonshot.integration', () => ({ __esModule: true, default: { synthesize: jest.fn(), generateTitle: jest.fn() } }));

// Store reads (folder-inheritance merges them) — controllable per test.
const mockStoreGet = jest.fn(async (..._args: any[]) => null as any);
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../langgraph/memory.graph', () => ({
  __esModule: true,
  getProjectSettings: jest.fn(async () => ({ crossProjectMemory: false })),
  setProjectSettings: jest.fn(async () => ({ crossProjectMemory: true })),
  updateContextAsync: jest.fn(),
}));

// Coding-side dynamic imports (provisioning / cleanup paths) — no-ops.
jest.mock('../coding/workspace.service', () => ({
  __esModule: true,
  sessionBranchName: (id: string) => `digby/session-${id.slice(0, 8)}`,
  worktreePath: (id: string) => `/wt/${id}`,
  ensureWorktree: jest.fn(async () => '/wt/x'),
  ensureBlankWorktree: jest.fn(async () => '/wt/x'),
  removeWorktree: jest.fn(async () => {}),
  removeSessionEnv: jest.fn(async () => {}),
}));
jest.mock('../coding/container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(async () => ({})),
  stopSessionContainer: jest.fn(async () => {}),
}));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true,
  clearSessionMemory: jest.fn(async () => {}),
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
}));
jest.mock('../coding/scaffolding.service', () => ({ __esModule: true, scaffoldProjectDocs: jest.fn(async () => {}), ensureProjectDocs: jest.fn(async () => ({ scaffold: {}, refresh: {} })) }));
jest.mock('../coding/coding-memory.service', () => ({ __esModule: true, inheritSessionMemory: jest.fn(async () => {}) }));
jest.mock('../coding/verify.service', () => ({ __esModule: true, readDigbyConfig: jest.fn(async () => null) }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => {}),
  memClear: jest.fn(async () => {}),
}));

import * as platform from './platform.service';
import {
  getEffectiveSystemPrompt,
  getMergedProjectStoreState,
  mergeNearestWins,
  MAX_FOLDER_DEPTH,
} from './folder-inheritance';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const OWNER = 'u-owner';
const OTHER = 'u-other';

function folder(over: Partial<any> = {}): any {
  return {
    id: 'f', userId: OWNER, name: 'Folder', description: null, systemPrompt: null,
    emoji: '📁', color: 'violet', isPublic: false,
    repoUrl: null, repoProvider: null, defaultBranch: 'main', githubLabel: null,
    parentId: null, depth: 0, path: '/f',
    members: [] as Array<{ userId: string; role: string }>,
    createdAt: new Date('2026-07-01'), updatedAt: new Date('2026-07-02'),
    ...over,
  };
}

/**
 * Wire crossModelProject.findUnique/findFirst/findMany against a fixture map
 * (keyed by id), honoring the where-shapes the tree ops + inheritance helpers
 * actually use (path startsWith, parentId, id.in, userId, repoProvider not-null).
 */
function mockFolders(folders: Record<string, any>) {
  const all = Object.values(folders);
  mockPrisma.crossModelProject.findUnique.mockImplementation(async ({ where }: any) => folders[where.id] ?? null);
  mockPrisma.crossModelProject.findFirst.mockImplementation(async ({ where }: any = {}) => {
    let rows = all;
    if (where?.id) rows = rows.filter((f) => f.id === where.id);
    if (where?.userId) rows = rows.filter((f) => f.userId === where.userId);
    if (where?.repoProvider?.not === null) rows = rows.filter((f) => f.repoProvider != null);
    if (where?.path?.startsWith) rows = rows.filter((f) => f.path.startsWith(where.path.startsWith));
    if (where?.OR) rows = rows.filter((f) => where.OR.some((c: any) => (c.userId && f.userId === c.userId)));
    return rows[0] ?? null;
  });
  mockPrisma.crossModelProject.findMany.mockImplementation(async ({ where, orderBy }: any = {}) => {
    let rows = all;
    if (where?.path?.startsWith) rows = rows.filter((f) => f.path.startsWith(where.path.startsWith));
    if (where?.parentId !== undefined) rows = rows.filter((f) => f.parentId === where.parentId);
    if (where?.id?.in) rows = rows.filter((f) => where.id.in.includes(f.id));
    if (where?.userId) rows = rows.filter((f) => f.userId === where.userId);
    if (orderBy?.depth === 'asc') rows = [...rows].sort((a, b) => a.depth - b.depth);
    if (orderBy?.depth === 'desc') rows = [...rows].sort((a, b) => b.depth - a.depth);
    return rows;
  });
}

/** Wire projectMember.findMany for ancestor-membership lookups (where userId + projectId.in). */
function mockMembers(rows: Array<{ userId: string; projectId: string; role: string }>) {
  mockPrisma.projectMember.findMany.mockImplementation(async ({ where }: any = {}) => {
    let out = rows;
    if (where?.userId) out = out.filter((m) => m.userId === where.userId);
    if (where?.projectId?.in) out = out.filter((m) => where.projectId.in.includes(m.projectId));
    return out;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FOLDERS_INHERITANCE; // default: inheritance ON
  mockFolders({});
  mockMembers([]);
  mockStoreGet.mockResolvedValue(null);
  mockPrisma.activity.create.mockResolvedValue({});
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
  mockPrisma.chatCodingState.findFirst.mockResolvedValue(null);
  mockPrisma.chatCodingState.findUnique.mockResolvedValue(null);
  mockPrisma.userPreferences.findUnique.mockResolvedValue(null);
});

// ── createProject (nested) ────────────────────────────────────────────────────

describe('createProject with parentId', () => {
  it('a nested create sets depth = parent.depth + 1 and path = parent.path/id', async () => {
    mockFolders({ root: folder({ id: 'root', depth: 0, path: '/root' }) });
    mockPrisma.crossModelProject.create.mockImplementation(async ({ data }: any) => ({ ...data }));
    const p = await platform.createProject({ userId: OWNER, name: 'Child', parentId: 'root' });
    expect(mockPrisma.crossModelProject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ parentId: 'root', depth: 1, path: `/root/${p.id}` }),
    });
  });

  it('a root create still sets depth 0 + path /id (pre-P2 creates left them unset)', async () => {
    mockPrisma.crossModelProject.create.mockImplementation(async ({ data }: any) => ({ ...data }));
    const p = await platform.createProject({ userId: OWNER, name: 'Root' });
    expect(mockPrisma.crossModelProject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ parentId: null, depth: 0, path: `/${p.id}` }),
    });
  });

  it('rejects creating past the depth cap (parent at depth 5)', async () => {
    mockFolders({ deep: folder({ id: 'deep', depth: MAX_FOLDER_DEPTH, path: '/a/b/c/d/e/deep' }) });
    await expect(platform.createProject({ userId: OWNER, name: 'TooDeep', parentId: 'deep' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.crossModelProject.create).not.toHaveBeenCalled();
  });

  it('a viewer member of the parent cannot create a subfolder (403); a stranger gets 404', async () => {
    mockFolders({ root: folder({ id: 'root', userId: OTHER, members: [{ userId: 'u-v', role: 'viewer' }] }) });
    await expect(platform.createProject({ userId: 'u-v', name: 'X', parentId: 'root' }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(platform.createProject({ userId: 'u-rando', name: 'X', parentId: 'root' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('an editor member of the parent CAN create a subfolder', async () => {
    mockFolders({ root: folder({ id: 'root', userId: OTHER, members: [{ userId: 'u-e', role: 'editor' }] }) });
    mockPrisma.crossModelProject.create.mockImplementation(async ({ data }: any) => ({ ...data }));
    await expect(platform.createProject({ userId: 'u-e', name: 'X', parentId: 'root' })).resolves.toBeTruthy();
  });
});

// ── moveFolder ────────────────────────────────────────────────────────────────

describe('moveFolder', () => {
  const tree = () => ({
    r: folder({ id: 'r', depth: 0, path: '/r' }),
    a: folder({ id: 'a', parentId: 'r', depth: 1, path: '/r/a' }),
    ac: folder({ id: 'ac', parentId: 'a', depth: 2, path: '/r/a/ac' }),
    x: folder({ id: 'x', depth: 0, path: '/x' }),
    w: folder({ id: 'w', parentId: 'x', depth: 2, path: '/x/w' }),
  });

  it('rejects moving a folder into itself or its own subtree (cycle check)', async () => {
    mockFolders(tree());
    await expect(platform.moveFolder({ userId: OWNER, folderId: 'a', newParentId: 'a' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(platform.moveFolder({ userId: OWNER, folderId: 'a', newParentId: 'ac' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/subtree/) });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a move that would push the subtree past the depth cap', async () => {
    mockFolders({
      ...tree(),
      t: folder({ id: 't', depth: 4, path: '/x/y/z/w/t' }),
    });
    // a (depth 1) has ac (depth 2) → subtreeHeight 1; under t → 5 + 1 > 5.
    await expect(platform.moveFolder({ userId: OWNER, folderId: 'a', newParentId: 't' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rewrites the folder + descendant paths and shifts depths in one transaction', async () => {
    mockFolders(tree());
    mockPrisma.crossModelProject.findUnique.mockImplementation(async ({ where }: any) => tree()[where.id as keyof ReturnType<typeof tree>] ?? null);
    await platform.moveFolder({ userId: OWNER, folderId: 'a', newParentId: 'w' });

    expect(mockPrisma.$transaction).toHaveBeenCalled();
    // descendant ac: prefix swap /r/a → /x/w/a
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'ac' }, data: { path: '/x/w/a/ac' },
    });
    // uniform depth shift (+2) via updateMany over the subtree
    expect(mockPrisma.crossModelProject.updateMany).toHaveBeenCalledWith({
      where: { path: { startsWith: '/r/a/' } }, data: { depth: { increment: 2 } },
    });
    // the folder itself: new parent, depth, path
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'a' }, data: { parentId: 'w', depth: 3, path: '/x/w/a' },
    });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'project.move' }) }),
    );
  });

  it('moves to the root with newParentId null (depth 0, path /id)', async () => {
    mockFolders(tree());
    await platform.moveFolder({ userId: OWNER, folderId: 'a', newParentId: null });
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'ac' }, data: { path: '/a/ac' },
    });
    expect(mockPrisma.crossModelProject.updateMany).toHaveBeenCalledWith({
      where: { path: { startsWith: '/r/a/' } }, data: { depth: { increment: -1 } },
    });
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'a' }, data: { parentId: null, depth: 0, path: '/a' },
    });
  });

  it('is owner-only — a non-owner (even of the target) gets 404', async () => {
    mockFolders(tree());
    await expect(platform.moveFolder({ userId: OTHER, folderId: 'a', newParentId: 'x' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── deleteProject (children) ──────────────────────────────────────────────────

describe('deleteProject with children', () => {
  const tree = () => ({
    p: folder({ id: 'p', depth: 0, path: '/p' }),
    c: folder({ id: 'c', parentId: 'p', depth: 1, path: '/p/c' }),
    gc: folder({ id: 'gc', parentId: 'c', depth: 2, path: '/p/c/gc' }),
    t: folder({ id: 't', depth: 0, path: '/t' }),
  });

  it('promotes children to roots and rewrites their subtree paths (FK SetNull fixup)', async () => {
    mockFolders(tree());
    const r = await platform.deleteProject({ userId: OWNER, projectId: 'p' });
    expect(r.success).toBe(true);
    expect(mockPrisma.crossModelProject.delete).toHaveBeenCalledWith({ where: { id: 'p' } });
    // grandchild path rewritten under the promoted child
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'gc' }, data: { path: '/c/gc' },
    });
    expect(mockPrisma.crossModelProject.updateMany).toHaveBeenCalledWith({
      where: { path: { startsWith: '/p/c/' } }, data: { depth: { increment: -1 } },
    });
    // child becomes a root
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'c' }, data: { parentId: null, depth: 0, path: '/c' },
    });
  });

  it('reparentTo moves the children under another folder instead', async () => {
    mockFolders(tree());
    await platform.deleteProject({ userId: OWNER, projectId: 'p', reparentTo: 't' });
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'gc' }, data: { path: '/t/c/gc' },
    });
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'c' }, data: { parentId: 't', depth: 1, path: '/t/c' },
    });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'project.delete', metadata: expect.objectContaining({ reparentTo: 't' }) }) }),
    );
  });

  it('rejects reparentTo inside the deleted subtree', async () => {
    mockFolders(tree());
    await expect(platform.deleteProject({ userId: OWNER, projectId: 'p', reparentTo: 'gc' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.crossModelProject.delete).not.toHaveBeenCalled();
  });

  it('rejects reparentTo that would overflow the depth cap', async () => {
    mockFolders({
      p: folder({ id: 'p', depth: 0, path: '/p' }),
      c: folder({ id: 'c', parentId: 'p', depth: 1, path: '/p/c' }),
      gc: folder({ id: 'gc', parentId: 'c', depth: 2, path: '/p/c/gc' }),
      deep: folder({ id: 'deep', depth: 4, path: '/x/y/z/w/deep' }),
    });
    await expect(platform.deleteProject({ userId: OWNER, projectId: 'p', reparentTo: 'deep' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.crossModelProject.delete).not.toHaveBeenCalled();
  });
});

// ── getFolderTree / getBreadcrumbs ────────────────────────────────────────────

describe('getFolderTree / getBreadcrumbs', () => {
  it('returns owned + shared folders with parentId/depth/path (additive fields)', async () => {
    const owned = folder({ id: 'root', path: '/root' });
    const child = folder({ id: 'child', parentId: 'root', depth: 1, path: '/root/child' });
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { ...owned, _count: { chats: 1, documents: 0 }, members: [] },
      { ...child, _count: { chats: 0, documents: 2 }, members: [{ userId: 'u' }] },
    ]);
    mockPrisma.projectMember.findMany.mockResolvedValue([
      { role: 'editor', project: { ...folder({ id: 'shared', userId: OTHER, path: '/shared' }), user: { id: OTHER, name: 'Olga', email: 'o@x' }, _count: { chats: 3, documents: 1 } } },
    ]);
    const tree = await platform.getFolderTree({ userId: OWNER });
    expect(tree.owned.map((f: any) => [f.id, f.parentId, f.depth, f.path])).toEqual([
      ['root', null, 0, '/root'],
      ['child', 'root', 1, '/root/child'],
    ]);
    expect(tree.owned[0].chatCount).toBe(1);
    expect(tree.shared[0]).toEqual(expect.objectContaining({ id: 'shared', parentId: null, depth: 0, path: '/shared', memberRole: 'editor', ownerName: 'Olga' }));
  });

  it('breadcrumbs return the root→leaf chain from the materialized path', async () => {
    const folders = {
      root: folder({ id: 'root', name: 'Work', path: '/root' }),
      mid: folder({ id: 'mid', name: 'Clients', parentId: 'root', depth: 1, path: '/root/mid' }),
      leaf: folder({ id: 'leaf', name: 'Acme', parentId: 'mid', depth: 2, path: '/root/mid/leaf' }),
    };
    mockFolders(folders);
    const chain = await platform.getBreadcrumbs({ userId: OWNER, folderId: 'leaf' });
    expect(chain.map((f: any) => f.name)).toEqual(['Work', 'Clients', 'Acme']);
    expect(chain.map((f: any) => f.depth)).toEqual([0, 1, 2]);
  });

  it('breadcrumbs deny strangers (404)', async () => {
    mockFolders({ root: folder({ id: 'root', userId: OTHER, members: [] }) });
    await expect(platform.getBreadcrumbs({ userId: 'u-rando', folderId: 'root' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── Inheritance: systemPrompt ─────────────────────────────────────────────────

describe('getEffectiveSystemPrompt', () => {
  const prompted = () => ({
    root: folder({ id: 'root', name: 'Work', path: '/root', systemPrompt: 'Root prompt.' }),
    mid: folder({ id: 'mid', name: 'Clients', parentId: 'root', depth: 1, path: '/root/mid', systemPrompt: 'Mid prompt.' }),
    leaf: folder({ id: 'leaf', name: 'Acme', parentId: 'mid', depth: 2, path: '/root/mid/leaf', systemPrompt: 'Leaf prompt.' }),
  });

  it('concatenates non-empty prompts root→leaf with blank-line separators', async () => {
    mockFolders(prompted());
    await expect(getEffectiveSystemPrompt('leaf')).resolves.toBe('Root prompt.\n\nMid prompt.\n\nLeaf prompt.');
    await expect(getEffectiveSystemPrompt('mid')).resolves.toBe('Root prompt.\n\nMid prompt.');
    await expect(getEffectiveSystemPrompt('root')).resolves.toBe('Root prompt.');
  });

  it('skips empty prompts in the chain', async () => {
    const f = prompted();
    f.mid.systemPrompt = null;
    mockFolders(f);
    await expect(getEffectiveSystemPrompt('leaf')).resolves.toBe('Root prompt.\n\nLeaf prompt.');
  });

  it('flag off → leaf-only (root-only/pre-P2 behavior)', async () => {
    process.env.FOLDERS_INHERITANCE = 'off';
    mockFolders(prompted());
    await expect(getEffectiveSystemPrompt('leaf')).resolves.toBe('Leaf prompt.');
  });
});

// ── Inheritance: members (effective role) ─────────────────────────────────────

describe('member role inheritance (via platform authz)', () => {
  const shared = () => ({
    root: folder({ id: 'root', userId: OTHER, path: '/root' }),
    mid: folder({ id: 'mid', userId: OTHER, parentId: 'root', depth: 1, path: '/root/mid' }),
    leaf: folder({
      id: 'leaf', userId: OTHER, parentId: 'mid', depth: 2, path: '/root/mid/leaf',
      members: [{ userId: 'u-member', role: 'viewer' }],
    }),
  });

  it('viewer on the child + editor on an ancestor → effective editor (can create chats)', async () => {
    mockFolders(shared());
    mockMembers([{ userId: 'u-member', projectId: 'root', role: 'editor' }]);
    mockPrisma.crossModelChat.create.mockResolvedValue({ id: 'c-new', title: 'T', mode: 'single_thinking', projectId: 'leaf' });
    const chat = await platform.createChat({ userId: 'u-member', title: 'T', projectId: 'leaf' });
    expect(chat.id).toBe('c-new');
    expect(mockPrisma.crossModelChat.create).toHaveBeenCalled();
  });

  it('flag off → the leaf row alone decides (viewer blocked)', async () => {
    process.env.FOLDERS_INHERITANCE = 'off';
    mockFolders(shared());
    mockMembers([{ userId: 'u-member', projectId: 'root', role: 'editor' }]);
    await expect(platform.createChat({ userId: 'u-member', title: 'T', projectId: 'leaf' }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
  });

  it('the owner of ANY ancestor has full access to the subtree', async () => {
    mockFolders(shared());
    mockPrisma.crossModelChat.create.mockResolvedValue({ id: 'c-new', title: 'T', mode: 'single_thinking', projectId: 'leaf' });
    // u-member is not a member anywhere, but OWNS the root ancestor.
    const folders = shared();
    folders.root.userId = 'u-member';
    mockFolders(folders);
    const chat = await platform.createChat({ userId: 'u-member', title: 'T', projectId: 'leaf' });
    expect(chat.id).toBe('c-new');
  });
});

// ── Inheritance: memory store reads (merged, writes stay leaf) ────────────────

describe('merged project store reads', () => {
  it('mergeNearestWins: nearest wins scalars, arrays concatenate root→leaf, objects deep-merge', () => {
    const merged = mergeNearestWins<any>([
      { summary: 'root', topics: ['a'], nested: { x: 1 } },
      null,
      { topics: ['b'], nested: { y: 2 } },
      { summary: 'leaf', topics: ['c'] },
    ]);
    expect(merged).toEqual({ summary: 'leaf', topics: ['a', 'b', 'c'], nested: { x: 1, y: 2 } });
    expect(mergeNearestWins([null, null])).toBeNull();
  });

  it('getMergedProjectStoreState merges the chain (nearest-wins + array concat)', async () => {
    mockFolders({
      root: folder({ id: 'root', path: '/root' }),
      mid: folder({ id: 'mid', parentId: 'root', depth: 1, path: '/root/mid' }),
      leaf: folder({ id: 'leaf', parentId: 'mid', depth: 2, path: '/root/mid/leaf' }),
    });
    const store: Record<string, any> = {
      'root:context': { summary: 'root summary', recentDecisions: ['d1'] },
      'leaf:context': { summary: 'leaf summary', openItems: ['o1'] },
    };
    mockStoreGet.mockImplementation(async (ns: string[]) => store[ns.join(':')] ?? null);
    const merged = await getMergedProjectStoreState<any>('leaf', 'context');
    expect(merged).toEqual({ summary: 'leaf summary', recentDecisions: ['d1'], openItems: ['o1'] });
  });

  it('flag off → leaf-only read', async () => {
    process.env.FOLDERS_INHERITANCE = 'off';
    mockFolders({
      root: folder({ id: 'root', path: '/root' }),
      leaf: folder({ id: 'leaf', parentId: 'root', depth: 1, path: '/root/leaf' }),
    });
    const store: Record<string, any> = {
      'root:settings': { crossProjectMemory: true },
      'leaf:settings': {},
    };
    mockStoreGet.mockImplementation(async (ns: string[]) => store[ns.join(':')] ?? null);
    const v = await getMergedProjectStoreState<any>('leaf', 'settings');
    expect(v).toEqual({});
    expect(mockStoreGet).toHaveBeenCalledTimes(1);
  });

  it('flag on → an ancestor-only key is inherited by the leaf', async () => {
    mockFolders({
      root: folder({ id: 'root', path: '/root' }),
      leaf: folder({ id: 'leaf', parentId: 'root', depth: 1, path: '/root/leaf' }),
    });
    const store: Record<string, any> = { 'root:settings': { crossProjectMemory: true } };
    mockStoreGet.mockImplementation(async (ns: string[]) => store[ns.join(':')] ?? null);
    const v = await getMergedProjectStoreState<any>('leaf', 'settings');
    expect(v).toEqual({ crossProjectMemory: true });
  });
});

// ── Inheritance: workspace resolution ─────────────────────────────────────────

describe('startCodingSession workspace resolution', () => {
  const wsTree = () => ({
    ws: folder({
      id: 'ws', depth: 0, path: '/ws',
      repoProvider: 'github', repoUrl: 'https://github.com/a/b', defaultBranch: 'main',
    }),
    child: folder({ id: 'child', parentId: 'ws', depth: 1, path: '/ws/child' }),
  });

  it('resolves the workspace from the nearest ancestor with repoProvider', async () => {
    mockFolders(wsTree());
    mockPrisma.crossModelChat.create.mockImplementation(async ({ data }: any) => ({
      id: 'sess-1', userId: data.userId, projectId: data.projectId, title: data.title, mode: 'code',
      createdAt: new Date(), updatedAt: new Date(),
    }));
    mockPrisma.chatCodingState.create.mockImplementation(async ({ data }: any) => ({
      id: data.id, projectId: data.projectId, userId: data.userId, title: data.title, branch: 'pending',
      baseBranch: 'main', worktreePath: null, permissionMode: data.permissionMode, model: data.model,
      status: 'provisioning', errorMessage: null, createdAt: new Date(), updatedAt: new Date(),
    }));
    const s = await platform.startCodingSession({ userId: OWNER, projectId: 'child', title: 'Fix' });
    // Session is filed under the RESOLVED workspace folder (the whole run path
    // reads session.project.repoUrl/provider off state.projectId).
    expect(mockPrisma.crossModelChat.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ projectId: 'ws' }) }),
    );
    expect(s.projectId).toBe('ws');
    expect(s.branch).toBe('digby/session-sess-1');
  });

  it('flag off → a plain child folder provisions a BLANK workspace on the leaf (repo-less builds need no inheritance)', async () => {
    process.env.FOLDERS_INHERITANCE = 'off';
    mockFolders(wsTree());
    mockPrisma.crossModelChat.create.mockImplementation(async ({ data }: any) => ({
      id: 'sess-1', userId: data.userId, projectId: data.projectId, title: data.title, mode: 'thinking',
      createdAt: new Date(), updatedAt: new Date(),
    }));
    mockPrisma.chatCodingState.create.mockImplementation(async ({ data }: any) => ({
      id: data.id, projectId: data.projectId, userId: data.userId, title: data.title, branch: 'pending',
      baseBranch: 'main', worktreePath: null, permissionMode: data.permissionMode, model: data.model,
      status: 'provisioning', errorMessage: null, createdAt: new Date(), updatedAt: new Date(),
    }));
    const s = await platform.startCodingSession({ userId: OWNER, projectId: 'child', title: 'Fix' });
    // With inheritance off there is no ancestor retarget — but the leaf itself
    // still hosts the session as a BLANK workspace (repoProvider null → provider
    // 'blank'): a plain owned folder is a valid net-new-build target, not a 404.
    expect(mockPrisma.crossModelChat.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ projectId: 'child' }) }),
    );
    expect(s.projectId).toBe('child');
  });
});

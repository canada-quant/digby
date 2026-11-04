/**
 * GET /projects/:id — the folder chat rows carry LINEAGE (2026-10-21, lanefix/nesting).
 * The sidebar merges these rows into its chat list when a folder expands; rows
 * without parentChatId always rendered as roots, so an older child of the folder's
 * Project Supervisor (6ef785c3 under daee2916) showed flat. Pins: the select carries
 * parentChatId / isSupervisor / userId / displayParentChatId and the response rows
 * pass them through; under DISPLAY_PARENT_NESTING_DISABLED=1 none of them are
 * selected (today's rows byte-for-byte).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn() },
  crossModelChat: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => ({ id: 'chat-sup' })), create: jest.fn() },
  chatCodingState: { findMany: jest.fn(async () => []) },
  projectDocument: { findMany: jest.fn(async () => []) },
  projectMember: { findMany: jest.fn(async () => []) },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// Heavy boundaries the controller pulls at import (config/env process.exit hazard).
jest.mock('../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error { statusCode: number; constructor(m: string, c = 500) { super(m); this.statusCode = c; } },
}));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('./langgraph/memory.graph', () => ({
  __esModule: true,
  getProjectSettings: jest.fn(async () => ({ crossProjectMemory: false, codingModel: null })),
}));
jest.mock('./platform/folder-inheritance', () => ({
  __esModule: true,
  getNearestWorkspaceFolder: jest.fn(async () => null),
}));

const mockGetLatestProjectStatus: jest.Mock = jest.fn();
jest.mock('./fleet/project-status.service', () => ({
  __esModule: true,
  getLatestProjectStatus: (...a: any[]) => mockGetLatestProjectStatus(...a),
}));

import { getProject, createProjectChat } from './projects.controller';

const OWNER = 'u-owner';
const P1 = 'proj-crossmodel';

function res() {
  const r: any = { status: jest.fn(() => r), json: jest.fn(() => r) };
  return r;
}

const LINEAGE_FIELDS = ['parentChatId', 'isSupervisor', 'userId', 'displayParentChatId'];

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DISPLAY_PARENT_NESTING_DISABLED;
  mockGetLatestProjectStatus.mockResolvedValue(null);
  mockPrisma.crossModelProject.findUnique.mockResolvedValue({
    id: P1, userId: OWNER, name: 'crossmodel', description: null, systemPrompt: null, emoji: null, color: null,
    isPublic: false, shareToken: null, repoUrl: null, repoProvider: null, workspaceAt: null, archivedAt: null,
    supervised: true, projectSupervisorEnabled: true, autoArchiveIdleDays: 14,
    createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-10-21T00:00:00Z'),
    members: [], _count: { chats: 3, documents: 0 },
  });
});
afterAll(() => { delete process.env.DISPLAY_PARENT_NESTING_DISABLED; });

/** The chats findMany call (the one filtered on projectId + archivedAt). */
const chatsQuery = () => mockPrisma.crossModelChat.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.projectId === P1 && 'archivedAt' in (a.where ?? {}));

describe('getProject — folder chat rows carry lineage (2026-10-21)', () => {
  it('selects parentChatId / isSupervisor / userId / displayParentChatId and passes them through', async () => {
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => (args?.where?.projectId === P1 ? [
      { id: 'ps-daee2916', title: 'crossmodel Supervisor', mode: 'auto', createdAt: new Date(), updatedAt: new Date(), shareLink: null, parentChatId: null, isSupervisor: false, userId: OWNER, displayParentChatId: null },
      { id: 'watch-6ef785c3', title: 'Crossmodel R&D Research Watch Update', mode: 'auto', createdAt: new Date(), updatedAt: new Date(), shareLink: null, parentChatId: 'ps-daee2916', isSupervisor: false, userId: OWNER, displayParentChatId: null },
      { id: 'lane-241242d0', title: 'ticket 4a8fcbde', mode: 'auto', createdAt: new Date(), updatedAt: new Date(), shareLink: null, parentChatId: null, isSupervisor: false, userId: OWNER, displayParentChatId: 'ps-daee2916' },
    ] : []));
    const r = res();
    await getProject({ user: { id: OWNER }, params: { id: P1 } } as any, r);
    const q = chatsQuery();
    for (const f of LINEAGE_FIELDS) expect(q.select[f]).toBe(true);
    const body = r.json.mock.calls[0][0];
    const byId = new Map(body.chats.map((c: any) => [c.id, c]));
    expect(byId.get('watch-6ef785c3')).toEqual(expect.objectContaining({ parentChatId: 'ps-daee2916', userId: OWNER }));
    expect(byId.get('lane-241242d0')).toEqual(expect.objectContaining({ parentChatId: null, displayParentChatId: 'ps-daee2916' }));
  });

  it('DISPLAY_PARENT_NESTING_DISABLED=1 — no lineage field is selected (today\'s rows)', async () => {
    process.env.DISPLAY_PARENT_NESTING_DISABLED = '1';
    const r = res();
    await getProject({ user: { id: OWNER }, params: { id: P1 } } as any, r);
    const q = chatsQuery();
    expect(Object.keys(q.select).sort()).toEqual(['createdAt', 'id', 'mode', 'shareLink', 'title', 'updatedAt']);
    expect(r.status).not.toHaveBeenCalledWith(500);
  });
});

describe('POST /projects/:id/chats — the 201 body under the switch (third review 2026-10-22)', () => {
  // A create with no `select` returns every scalar, the new column included —
  // under DISPLAY_PARENT_NESTING_DISABLED the body must be the pre-2026-10-21 one.
  const created = { id: 'c-new', userId: OWNER, projectId: P1, title: 'New Chat', mode: 'auto', parentChatId: null, displayParentChatId: null, createdAt: new Date('2026-10-22T00:00:00Z'), updatedAt: new Date('2026-10-22T00:00:00Z') };
  const req = { user: { id: OWNER }, params: { id: P1 }, body: {} } as any;

  it('switch OFF: the created row is returned as Prisma gave it', async () => {
    mockPrisma.crossModelChat.create.mockResolvedValue({ ...created });
    const r = res();
    await createProjectChat(req, r);
    expect(r.status).toHaveBeenCalledWith(201);
    expect(r.json.mock.calls[0][0]).toEqual(created);
  });

  it('DISPLAY_PARENT_NESTING_DISABLED=1 (and "true" — the wave\'s one parser): no displayParentChatId key in the body', async () => {
    for (const v of ['1', 'true']) {
      process.env.DISPLAY_PARENT_NESTING_DISABLED = v;
      mockPrisma.crossModelChat.create.mockResolvedValue({ ...created });
      const r = res();
      await createProjectChat(req, r);
      expect(r.status).toHaveBeenCalledWith(201);
      const body = r.json.mock.calls[0][0];
      expect(body).not.toHaveProperty('displayParentChatId');
      const { displayParentChatId: _dp, ...preWave } = created;
      expect(body).toEqual(preWave);
    }
  });
});

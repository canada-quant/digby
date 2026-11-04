/**
 * GET /projects/:id — `latestProjectStatus` field (owner ask 2026-09-14: the
 * hourly project supervisor status card). Pins: the field carries the newest
 * project_status card's metadata verbatim, is null without one, and a read
 * failure degrades to null instead of failing the GET.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn() },
  crossModelChat: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => ({ id: 'chat-sup' })) },
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

import { getProject } from './projects.controller';

const OWNER = 'u-owner';
const P1 = 'proj-1';

function res() {
  const r: any = { status: jest.fn(() => r), json: jest.fn(() => r) };
  return r;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.crossModelProject.findUnique.mockResolvedValue({
    id: P1, userId: OWNER, name: 'CanLaw', description: null, systemPrompt: null, emoji: null, color: null,
    isPublic: false, shareToken: null, repoUrl: null, repoProvider: null, workspaceAt: null, archivedAt: null,
    supervised: true, projectSupervisorEnabled: true, autoArchiveIdleDays: null,
    createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-14T00:00:00Z'),
    members: [], _count: { chats: 0, documents: 0 },
  });
});

describe('getProject → latestProjectStatus', () => {
  it('carries the newest project_status card metadata verbatim', async () => {
    const card = {
      origin: 'project_status', kind: 'project_status',
      generatedAt: '2026-09-14T15:00:00.000Z', since: '2026-09-14T14:00:00.000Z',
      status: {
        projectName: 'CanLaw', headline: 'CanLaw: 2 of 3 goals active, 1 blocked on the SoR rebuild; 2 lanes working',
        workingOn: ['Rebuild the SoR index'], doneSince: [], blocked: ['Goal blocked: the SoR rebuild'], next: ['Write the benchmark report'],
        goals: { active: 2, done: 0, blocked: 1 }, todos: { inProgress: 1, pending: 1, blocked: 0, doneSince: 0 },
        lanesRunning: 2, ownerItems: 0,
      },
    };
    mockGetLatestProjectStatus.mockResolvedValue(card);
    const r = res();
    await getProject({ user: { id: OWNER }, params: { id: P1 } } as any, r);
    expect(mockGetLatestProjectStatus).toHaveBeenCalledWith(P1);
    expect(r.json).toHaveBeenCalledTimes(1);
    const body = r.json.mock.calls[0][0];
    expect(body.id).toBe(P1);
    expect(body.projectSupervisorEnabled).toBe(true);
    expect(body.projectSupervisorChatId).toBe('chat-sup');
    expect(body.latestProjectStatus).toEqual(card);
  });

  it('is null when the project has no card yet', async () => {
    mockGetLatestProjectStatus.mockResolvedValue(null);
    const r = res();
    await getProject({ user: { id: OWNER }, params: { id: P1 } } as any, r);
    expect(r.json.mock.calls[0][0].latestProjectStatus).toBeNull();
    expect(r.status).not.toHaveBeenCalledWith(500);
  });

  it('a status read failure degrades to null — never fails the project GET', async () => {
    mockGetLatestProjectStatus.mockRejectedValue(new Error('db hiccup'));
    const r = res();
    await getProject({ user: { id: OWNER }, params: { id: P1 } } as any, r);
    expect(r.json).toHaveBeenCalledTimes(1);
    expect(r.json.mock.calls[0][0].latestProjectStatus).toBeNull();
    expect(r.status).not.toHaveBeenCalledWith(500);
  });
});

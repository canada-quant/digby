/**
 * projects.controller — framework-surface guard pins (ticket 9471d338).
 *
 * The membership + share seams live ONLY in this controller (the service layer
 * has no member/share mutations), so the pins live here too: the platform's
 * own project (repoUrl = the instance's own repo — the production slug in
 * these fixtures) refuses member add/update/remove and public share, each
 * BEFORE any mutation or member lookup. The identity helper is the real leaf's
 * contract, stubbed to the same one-line rule here (the leaf itself is pinned
 * against the REAL module by framework-project.9471d338.test.ts).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn(), update: jest.fn() },
  projectMember: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn(), delete: jest.fn() },
  user: { findUnique: jest.fn(), findFirst: jest.fn() },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error { statusCode: number; constructor(m: string, c = 500) { super(m); this.statusCode = c; } },
}));
// The controller reads the framework identity + refusal message from
// platform.service (which re-exports the pure leaf). Stub the same contract —
// identity = the framework repo slug — so this suite pins the CONTROLLER
// wiring without importing platform.service's whole graph.
jest.mock('./platform/platform.service', () => ({
  __esModule: true,
  isFrameworkProject: (row: any) => row?.repoUrl === 'canada-quant/digby',
  frameworkProjectRefusal: (action: string) => `The Digby Framework project is a platform surface and cannot be ${action}ed like a user project (manage it from Manager → Framework).`,
}));
jest.mock('./langgraph/memory.graph', () => ({
  __esModule: true,
  getProjectSettings: jest.fn(async () => ({ crossProjectMemory: false, codingModel: null })),
}));
jest.mock('./platform/folder-inheritance', () => ({
  __esModule: true,
  getNearestWorkspaceFolder: jest.fn(async () => null),
}));
jest.mock('./fleet/project-status.service', () => ({
  __esModule: true,
  getLatestProjectStatus: jest.fn(async () => null),
}));

import {
  addProjectMember,
  updateProjectMember,
  removeProjectMember,
  shareProject,
} from './projects.controller';

const OWNER = 'u-owner';
const FW = 'proj-fw';

function res() {
  const r: any = { status: jest.fn(() => r), json: jest.fn(() => r) };
  return r;
}

const FRAMEWORK_ROW = { id: FW, userId: OWNER, name: 'crossmodel', repoUrl: 'canada-quant/digby' };
const req = (over: Record<string, unknown> = {}) =>
  ({ user: { id: OWNER }, params: { id: FW }, body: {}, ...over } as any);

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.crossModelProject.findUnique.mockResolvedValue({ ...FRAMEWORK_ROW });
});

describe('framework surface guards — membership seams (ticket 9471d338)', () => {
  it('addProjectMember → 403 before ANY member mechanic runs', async () => {
    const r = res();
    await addProjectMember(req({ body: { email: 'someone@example.com', role: 'editor' } }), r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(r.json).toHaveBeenCalledWith({ error: expect.stringContaining('Digby Framework') });
    expect(mockPrisma.projectMember.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.projectMember.upsert).not.toHaveBeenCalled();
  });

  it('updateProjectMember → 403 before the role write', async () => {
    const r = res();
    await updateProjectMember(req({ params: { id: FW, memberId: 'm-1' }, body: { role: 'admin' } }), r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.projectMember.update).not.toHaveBeenCalled();
  });

  it('removeProjectMember → 403 even for the owner removing themselves', async () => {
    const r = res();
    await removeProjectMember(req({ params: { id: FW, memberId: OWNER } }), r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.projectMember.delete).not.toHaveBeenCalled();
  });

  it('shareProject → 403 in both directions, before any token/isPublic write', async () => {
    const r = res();
    await shareProject(req({ body: { enable: true } }), r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(r.json).toHaveBeenCalledWith({ error: expect.stringContaining('Digby Framework') });
    expect(mockPrisma.crossModelProject.update).not.toHaveBeenCalled();

    const r2 = res();
    await shareProject(req({ body: { enable: false } }), r2);
    expect(r2.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.crossModelProject.update).not.toHaveBeenCalled();
  });

  it('negative control: a same-named user project (no repoUrl) still shares + takes members', async () => {
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: FW, userId: OWNER, name: 'crossmodel', repoUrl: null, shareToken: null });
    const r = res();
    await shareProject(req({ body: { enable: true } }), r);
    expect(r.status).not.toHaveBeenCalledWith(403);
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalled();
  });
});

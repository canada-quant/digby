/**
 * WI-N (2026-09-25) — controller pin for POST /coding/projects (importProject):
 * the SSRF jail added in the 2026-09-24 capability-gap review. Before that
 * review this route only checked the URL scheme; now every non-blank import
 * runs project-workspace.service.validateRepoUrl and a rejection is a 400
 * carrying the validator's own message with NO project created.
 *
 * Mock boundary: colocated mock-everything pattern (same style as
 * coding.controller.updateSession.test.ts) — only importProject is exercised.
 * validateRepoUrl itself is mocked here (its private-host / scheme / port /
 * credential rules are pinned in project-workspace.service's own tests); what
 * this suite pins is the CONTROLLER contract around it: called with the raw
 * repoUrl, message forwarded verbatim, create short-circuited, blank projects
 * skip it, and the derived-name / provider mapping on the happy path.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelChat: { updateMany: jest.fn(async () => ({ count: 1 })) },
  crossModelProject: { findFirst: jest.fn(), create: jest.fn() },
  activity: { create: jest.fn(async () => ({})) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

jest.mock('../platform/platform.service', () => ({}));
jest.mock('../github/token-manager', () => ({ getAllValidTokens: jest.fn(), getValidToken: jest.fn() }));
jest.mock('./workspace.service', () => ({
  removeWorktree: jest.fn(), removeSessionEnv: jest.fn(), git: jest.fn(), worktreePath: jest.fn(),
}));
jest.mock('./plan.service', () => ({ getPlan: jest.fn(), applyPlan: jest.fn(), planToUpdate: jest.fn() }));

// The SSRF validator — DYNAMIC import inside importProject; the static import
// of this module (commitKnowledgeFile) is unused here.
const mockValidateRepoUrl: jest.Mock = jest.fn();
jest.mock('./project-workspace.service', () => ({
  commitKnowledgeFile: jest.fn(),
  validateRepoUrl: (...a: any[]) => mockValidateRepoUrl(...a),
}));

const mockCreateCodingProject: jest.Mock = jest.fn();
jest.mock('./coding-data.service', () => ({
  getSessionForUser: jest.fn(), updateSessionState: jest.fn(),
  listCodingProjects: jest.fn(), createCodingProject: (...a: any[]) => mockCreateCodingProject(...a), getCodingProjectForUser: jest.fn(),
  deleteCodingProjectData: jest.fn(), listCodingChats: jest.fn(),
  listCodingTranscript: jest.fn(), listCodingTranscriptPage: jest.fn(),
  stripInlineImageData: jest.fn(), listRunningSessionIdsForUser: jest.fn(),
}));
jest.mock('./coding-retrieval.service', () => ({ clearSessionMemory: jest.fn() }));
jest.mock('./usage-store', () => ({ loadSessionUsage: jest.fn() }));
jest.mock('./schedule.service', () => ({ getScheduleHealth: jest.fn() }));
jest.mock('./credentials.service', () => ({
  listCredentials: jest.fn(), upsertCredential: jest.fn(), deleteCredential: jest.fn(),
}));
jest.mock('../memory/context-store', () => ({ storeGet: jest.fn() }));
jest.mock('./container.service', () => ({ stopSessionContainer: jest.fn(), removeSandboxHome: jest.fn() }));
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));

import codingController from './coding.controller';

const CREATED = { id: 'p1', name: 'crossmodel', repoUrl: 'https://github.com/example-org/crossmodel' };

function makeReqRes(body: any) {
  const req: any = { user: { id: 'u1' }, params: {}, body };
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { req, res };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateRepoUrl.mockReturnValue(null); // valid unless a test says otherwise
  mockCreateCodingProject.mockResolvedValue(CREATED);
});

describe('POST /coding/projects — validateRepoUrl SSRF jail (capability gap review 2026-09-24)', () => {
  it('an invalid repoUrl is a 400 carrying the validator\'s message verbatim, and NO project is created', async () => {
    mockValidateRepoUrl.mockReturnValue('Private/loopback hosts are not allowed');
    const { req, res } = makeReqRes({ repoUrl: 'https://10.0.0.11/internal/repo.git' });
    await codingController.importProject(req, res);
    expect(mockValidateRepoUrl).toHaveBeenCalledWith('https://10.0.0.11/internal/repo.git');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Private/loopback hosts are not allowed' });
    expect(mockCreateCodingProject).not.toHaveBeenCalled();
  });

  it('every validator message is forwarded as-is (scheme / port / credentials / unparsable)', async () => {
    for (const [url, message] of [
      ['http://github.com/o/r.git', 'Only https git URLs are supported'],
      ['https://github.com:8443/o/r.git', 'Custom ports are not supported'],
      ['https://user:pw@github.com/o/r.git', 'Credentials in the URL are not supported'],
      ['not a url', 'Invalid URL'],
    ] as const) {
      mockValidateRepoUrl.mockReturnValueOnce(message);
      const { req, res } = makeReqRes({ repoUrl: url });
      await codingController.importProject(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: message });
    }
    expect(mockCreateCodingProject).not.toHaveBeenCalled();
  });

  it('a missing / non-string repoUrl is refused BEFORE the validator runs', async () => {
    for (const body of [{}, { repoUrl: 42 }, { repoUrl: '' }, { name: 'x', provider: 'github' }]) {
      const { req, res } = makeReqRes(body);
      await codingController.importProject(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'repoUrl is required' });
    }
    expect(mockValidateRepoUrl).not.toHaveBeenCalled();
    expect(mockCreateCodingProject).not.toHaveBeenCalled();
  });

  it('a valid repoUrl passes the validator and creates the project (name derived from the repo, provider github, branch main)', async () => {
    const { req, res } = makeReqRes({ repoUrl: 'https://github.com/example-org/crossmodel.git' });
    await codingController.importProject(req, res);
    expect(mockValidateRepoUrl).toHaveBeenCalledWith('https://github.com/example-org/crossmodel.git');
    expect(mockCreateCodingProject).toHaveBeenCalledWith({
      userId: 'u1',
      name: 'crossmodel',
      repoUrl: 'https://github.com/example-org/crossmodel.git',
      defaultBranch: 'main',
      provider: 'github',
      githubLabel: null,
    });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: CREATED });
  });

  it('explicit name / defaultBranch / provider git / githubLabel are honoured on the happy path', async () => {
    const { req, res } = makeReqRes({
      repoUrl: 'https://git.example.org/team/svc', name: '  Service  ', defaultBranch: 'develop', provider: 'git', githubLabel: 'work',
    });
    await codingController.importProject(req, res);
    expect(mockCreateCodingProject).toHaveBeenCalledWith({
      userId: 'u1', name: 'Service', repoUrl: 'https://git.example.org/team/svc',
      defaultBranch: 'develop', provider: 'git', githubLabel: 'work',
    });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: CREATED });
  });

  it('a BLANK project skips the validator entirely (no repo) but requires a name', async () => {
    const blank = makeReqRes({ provider: 'blank', name: 'Scratch' });
    await codingController.importProject(blank.req, blank.res);
    expect(mockValidateRepoUrl).not.toHaveBeenCalled();
    expect(mockCreateCodingProject).toHaveBeenCalledWith({
      userId: 'u1', name: 'Scratch', repoUrl: '', defaultBranch: 'main', provider: 'blank', githubLabel: null,
    });
    expect(blank.res.json).toHaveBeenCalledWith({ success: true, data: CREATED });

    mockCreateCodingProject.mockClear();
    const unnamed = makeReqRes({ provider: 'blank', name: '   ' });
    await codingController.importProject(unnamed.req, unnamed.res);
    expect(unnamed.res.status).toHaveBeenCalledWith(400);
    expect(unnamed.res.json).toHaveBeenCalledWith({ error: 'A project name is required for a blank project' });
    expect(mockCreateCodingProject).not.toHaveBeenCalled();
  });

  it('a create failure is a 500 with the generic message (the validator already passed)', async () => {
    mockCreateCodingProject.mockRejectedValue(new Error('db down'));
    const { req, res } = makeReqRes({ repoUrl: 'https://github.com/o/r' });
    await codingController.importProject(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to import project' });
  });
});

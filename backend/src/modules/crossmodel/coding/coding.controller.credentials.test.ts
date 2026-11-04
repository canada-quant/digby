/**
 * Replay pin — ticket c02b85bf (chat-side visibility of coding-credential
 * NAMES): the REST write paths. The chat-side [YOUR INTEGRATION STATUS] block
 * (5-min Redis TTL) now lists the NAMES of stored credentials, so EVERY write
 * path must drop the cache or the next chat turn answers from a stale block —
 * the reviewer advisory on cc68ab28c flagged this wiring as untested behavior.
 * store_secret's invalidation is pinned in secret-handoff-tools.test.ts; this
 * file pins the two REST doors (Account → Coding save + delete).
 *
 * Mock boundary: colocated mock-everything pattern (same style as
 * coding.controller.updateSession.test.ts) — only the credential handlers are
 * exercised; heavy service imports are mocked because their import chains
 * reach config/redis → config/env (process.exit in a keyless env).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = { activity: { create: jest.fn(async () => ({})) } };
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../middleware/error-handler', () => ({
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

const mockInvalidate: jest.Mock = jest.fn(async () => undefined);
jest.mock('../langgraph/integration-status-cache', () => ({
  invalidateIntegrationStatusCache: (...a: any[]) => mockInvalidate(...a),
}));

const mockUpsert: jest.Mock = jest.fn(async () => ({ id: 'c1', envKey: 'CLOUDFLARE_API_TOKEN', preview: '••••1234' }));
const mockDelete: jest.Mock = jest.fn(async () => true);
jest.mock('./credentials.service', () => ({
  listCredentials: jest.fn(), upsertCredential: (...a: any[]) => mockUpsert(...a),
  deleteCredential: (...a: any[]) => mockDelete(...a), getCredentialEnv: jest.fn(),
  listShellCredentialNames: jest.fn(),
}));

jest.mock('../platform/platform.service', () => ({}));
jest.mock('../github/token-manager', () => ({ getAllValidTokens: jest.fn(), getValidToken: jest.fn() }));
jest.mock('./workspace.service', () => ({
  removeWorktree: jest.fn(), removeSessionEnv: jest.fn(), git: jest.fn(), worktreePath: jest.fn(),
}));
jest.mock('./plan.service', () => ({ getPlan: jest.fn(), applyPlan: jest.fn(), planToUpdate: jest.fn() }));
jest.mock('./project-workspace.service', () => ({ commitKnowledgeFile: jest.fn() }));
jest.mock('./coding-data.service', () => ({
  getSessionForUser: jest.fn(), updateSessionState: jest.fn(), listCodingProjects: jest.fn(),
  createCodingProject: jest.fn(), getCodingProjectForUser: jest.fn(), deleteCodingProjectData: jest.fn(),
  listCodingChats: jest.fn(), listCodingTranscript: jest.fn(), listCodingTranscriptPage: jest.fn(),
  stripInlineImageData: jest.fn(), listRunningSessionIdsForUser: jest.fn(),
}));
jest.mock('./coding-retrieval.service', () => ({ clearSessionMemory: jest.fn() }));
jest.mock('./usage-store', () => ({ loadSessionUsage: jest.fn() }));
jest.mock('./schedule.service', () => ({ getScheduleHealth: jest.fn() }));
jest.mock('../memory/context-store', () => ({ storeGet: jest.fn() }));
jest.mock('./container.service', () => ({ stopSessionContainer: jest.fn(), removeSandboxHome: jest.fn() }));
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));

import codingController from './coding.controller';

function makeReqRes(body: any, params: any = {}) {
  const req: any = { user: { id: 'u1' }, params, body };
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { req, res };
}

beforeEach(() => { jest.clearAllMocks(); });

describe('c02b85bf — credential writes drop the integration-status cache', () => {
  it('SAVE invalidates cm_integ_status:<uid> so the new NAME is visible to the next chat turn, not after the 5-min TTL', async () => {
    const { req, res } = makeReqRes({ provider: 'cloudflare', envKey: 'CLOUDFLARE_API_TOKEN', value: 'FAKE-token-only' });
    await codingController.saveCodingCredential(req, res);
    expect(mockUpsert).toHaveBeenCalledWith('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'FAKE-token-only', '');
    expect(mockInvalidate).toHaveBeenCalledWith('u1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('DELETE invalidates cm_integ_status:<uid> (a stale block would list a removed key as available)', async () => {
    const { req, res } = makeReqRes({}, { id: 'c1' });
    await codingController.deleteCodingCredential(req, res);
    expect(mockDelete).toHaveBeenCalledWith('u1', 'c1');
    expect(mockInvalidate).toHaveBeenCalledWith('u1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('a FAILED save (validation error) never invalidates and answers 400', async () => {
    mockUpsert.mockRejectedValueOnce(new Error('envKey must be UPPER_SNAKE_CASE'));
    const { req, res } = makeReqRes({ provider: 'custom', envKey: 'bad_key', value: 'x' });
    await codingController.saveCodingCredential(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('a DELETE of a missing id (404) never invalidates', async () => {
    mockDelete.mockResolvedValueOnce(false);
    const { req, res } = makeReqRes({}, { id: 'nope' });
    await codingController.deleteCodingCredential(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});

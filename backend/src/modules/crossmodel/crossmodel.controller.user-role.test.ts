jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));

const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    user: { findUnique: (...a: any[]) => mockFindUnique(...a), update: (...a: any[]) => mockUpdate(...a) },
  },
}));

jest.mock('./crossmodel.service', () => ({ __esModule: true, default: {} }));
jest.mock('./model-endpoints/model-endpoints.service', () => ({ __esModule: true, resolveRegistryModel: jest.fn(async () => null) }));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(),
  combineAttachments: jest.fn(() => null),
}));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('./integrations/qwen-kid.integration', () => ({
  streamKidResponse: jest.fn(),
  generateKidStatus: jest.fn(),
}));
jest.mock('./mcp-search', () => ({ searchWithBrightData: jest.fn() }));
jest.mock('./browser-agent', () => ({ runBrowserAgentSession: jest.fn() }));
jest.mock('./chat-agent/chat-gate', () => ({
  decideChatGate: jest.fn(), mapAttachmentForAgent: jest.fn(),
  chatWriteAccessGranted: jest.fn(), chatReadAccessGranted: jest.fn(), streamAccessDeniedError: jest.fn(),
}));
jest.mock('./integration-context', () => ({ buildIntegrationContext: jest.fn(async () => ({ additionalContext: undefined, imessagePairedAgentId: null })), buildIntegrationContextBounded: jest.fn(async (build) => build()) }));
jest.mock('./rate-limit.service', () => ({
  checkDeepResearchQuota: jest.fn(), reserveDeepResearchQuota: jest.fn(), getDeepResearchDailyLimit: jest.fn(),
  getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
}));
jest.mock('./coding/coding-data.service', () => ({ getChatCapability: jest.fn() }));
jest.mock('./chat-agent/chat-busy', () => ({ isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({
  attachRemoteChatRun: jest.fn(),
  replayFinishedRemoteRun: jest.fn(async () => false),
}));
jest.mock('./coding/coding-stream.controller', () => ({
  __esModule: true,
  default: { streamRun: jest.fn() },
}));
// Review 2026-10-23: the admin hard delete runs the shared FK-less cleanup (auth.service purgeUserAccount).
const mockPurgeUserAccount = jest.fn(async (_id: string) => undefined);
jest.mock('../auth/auth.service', () => ({ __esModule: true, default: {}, purgeUserAccount: (id: string) => mockPurgeUserAccount(id) }));
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  queryLoopMetrics: jest.fn(),
  summarizeLoopMetrics: jest.fn(),
}));

import controller from './crossmodel.controller';

/**
 * PATCH /api/crossmodel/admin/users/:id/role (owner 2026-10-16: "the ability to edit users as an admin to upgrade
 * them to an admin"). Pins: admin-only, never your own row, the owner is never demoted, Digby Kids never admin.
 */
const mkReq = (user: any, id: string, role: unknown): any => ({ user, params: { id }, body: { role } });
const mkRes = (): any => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn((b: any) => { res.body = b; return res; });
  return res;
};
const ADMIN = { id: 'u-admin', role: 'ADMIN', email: 'admin@digby.example.com' };
const MORTAL = { id: 'u-user', role: 'USER', email: 'user@digby.example.com' };
const target = (over: Record<string, unknown> = {}) => ({ id: 'u-t', email: 't@digby.example.com', role: 'USER', isChild: false, ...over });

describe('adminSetUserRole', () => {
  beforeEach(() => { mockFindUnique.mockReset(); mockUpdate.mockReset(); });

  it('promotes a user to admin', async () => {
    mockFindUnique.mockResolvedValue(target());
    mockUpdate.mockResolvedValue({ id: 'u-t', email: 't@digby.example.com', role: 'ADMIN' });
    const res = mkRes();
    await controller.adminSetUserRole(mkReq(ADMIN, 'u-t', 'admin'), res);
    expect(res.statusCode).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u-t' }, data: { role: 'ADMIN' } }));
    expect(res.body.data.role).toBe('ADMIN');
  });

  it('demotes an admin back to user', async () => {
    mockFindUnique.mockResolvedValue(target({ role: 'ADMIN' }));
    mockUpdate.mockResolvedValue({ id: 'u-t', email: 't@digby.example.com', role: 'USER' });
    const res = mkRes();
    await controller.adminSetUserRole(mkReq(ADMIN, 'u-t', 'USER'), res);
    expect(res.statusCode).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { role: 'USER' } }));
  });

  it('refuses a non-admin caller', async () => {
    const res = mkRes();
    await controller.adminSetUserRole(mkReq(MORTAL, 'u-t', 'ADMIN'), res);
    expect(res.statusCode).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses a bad role, your own row, the owner demotion and a kids account', async () => {
    for (const [req, setup, code] of [
      [mkReq(ADMIN, 'u-t', 'ROOT'), () => mockFindUnique.mockResolvedValue(target()), 400],
      [mkReq(ADMIN, 'u-admin', 'USER'), () => mockFindUnique.mockResolvedValue(target({ id: 'u-admin' })), 400],
      [mkReq(ADMIN, 'u-p', 'USER'), () => mockFindUnique.mockResolvedValue(target({ id: 'u-p', email: 'Paul@Sunday.Market', role: 'ADMIN' })), 400],
      [mkReq(ADMIN, 'u-k', 'ADMIN'), () => mockFindUnique.mockResolvedValue(target({ id: 'u-k', isChild: true })), 400],
      [mkReq(ADMIN, 'u-x', 'ADMIN'), () => mockFindUnique.mockResolvedValue(null), 404],
    ] as Array<[any, () => void, number]>) {
      setup();
      const res = mkRes();
      await controller.adminSetUserRole(req, res);
      expect(res.statusCode).toBe(code);
    }
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});


describe('adminDeleteUser (review 2026-10-23)', () => {
  beforeEach(() => { mockFindUnique.mockReset(); mockPurgeUserAccount.mockClear(); });

  it('goes through the shared FK-less cleanup (cold supervisor archive, thread rows, memory mirror) — never a bare FK cascade', async () => {
    mockFindUnique.mockResolvedValue({ id: 'u-t', email: 't@digby.example.com' });
    const res = mkRes();
    await controller.adminDeleteUser({ user: ADMIN, params: { id: 'u-t' }, body: {} } as any, res);
    expect(res.statusCode).toBe(200);
    expect(mockPurgeUserAccount).toHaveBeenCalledWith('u-t');
  });

  it('still refuses a non-admin, your own account and an unknown user (nothing purged)', async () => {
    for (const [user, id, found, code] of [[MORTAL, 'u-t', true, 403], [ADMIN, 'u-admin', true, 400], [ADMIN, 'u-x', false, 404]] as Array<[any, string, boolean, number]>) {
      mockFindUnique.mockResolvedValue(found ? { id, email: 'x@digby.example.com' } : null);
      const res = mkRes();
      await controller.adminDeleteUser({ user, params: { id }, body: {} } as any, res);
      expect(res.statusCode).toBe(code);
    }
    expect(mockPurgeUserAccount).not.toHaveBeenCalled();
  });

  // Ticket 054daeb7 (2026-10-27): the owner deleted the canonical deploy-smoke
  // account at 04:13:43Z and every wave after failed the authenticated smoke
  // with a bare 401. The delete must refuse protected accounts up front.
  describe('adminDeleteUser protected deploy-smoke accounts (ticket 054daeb7)', () => {
    const ENV_ORIG = process.env.ADMIN_DELETE_PROTECTED_EMAILS;

    afterEach(() => {
      if (ENV_ORIG === undefined) delete process.env.ADMIN_DELETE_PROTECTED_EMAILS;
      else process.env.ADMIN_DELETE_PROTECTED_EMAILS = ENV_ORIG;
    });

    it('refuses the canonical smoke account (default protected list) and purges nothing', async () => {
      delete process.env.ADMIN_DELETE_PROTECTED_EMAILS;
      mockFindUnique.mockResolvedValue({ id: 'u-smoke', email: 'claudebot@digby.example.com' });
      const res = mkRes();
      await controller.adminDeleteUser({ user: ADMIN, params: { id: 'u-smoke' }, body: {} } as any, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('protected deploy-smoke account');
      expect(mockPurgeUserAccount).not.toHaveBeenCalled();
    });

    it('protects case-insensitively and honors a custom ADMIN_DELETE_PROTECTED_EMAILS list', async () => {
      process.env.ADMIN_DELETE_PROTECTED_EMAILS = 'Smoke-One@digby.example.com, smoke-two@digby.example.com';
      for (const email of ['smoke-one@digby.example.com', 'Smoke-Two@digby.example.com']) {
        mockFindUnique.mockResolvedValue({ id: 'u-x', email });
        const res = mkRes();
        await controller.adminDeleteUser({ user: ADMIN, params: { id: 'u-x' }, body: {} } as any, res);
        expect(res.statusCode).toBe(400);
      }
      expect(mockPurgeUserAccount).not.toHaveBeenCalled();
    });

    it('an explicitly emptied list is the documented override (owner can still delete)', async () => {
      process.env.ADMIN_DELETE_PROTECTED_EMAILS = '';
      mockFindUnique.mockResolvedValue({ id: 'u-smoke', email: 'claudebot@digby.example.com' });
      const res = mkRes();
      await controller.adminDeleteUser({ user: ADMIN, params: { id: 'u-smoke' }, body: {} } as any, res);
      expect(res.statusCode).toBe(200);
      expect(mockPurgeUserAccount).toHaveBeenCalledWith('u-smoke');
    });

    it('an ordinary account is untouched by the guard (delete still works)', async () => {
      delete process.env.ADMIN_DELETE_PROTECTED_EMAILS;
      mockFindUnique.mockResolvedValue({ id: 'u-t', email: 'someone-else@digby.example.com' });
      const res = mkRes();
      await controller.adminDeleteUser({ user: ADMIN, params: { id: 'u-t' }, body: {} } as any, res);
      expect(res.statusCode).toBe(200);
      expect(mockPurgeUserAccount).toHaveBeenCalledWith('u-t');
    });
  });
});

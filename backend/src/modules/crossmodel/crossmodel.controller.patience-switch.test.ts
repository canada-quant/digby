/**
 * Always-Auto switch (`patience_auto_only`) — the admin REST surface after the
 * 2026-09-26 audit (finding docs-drift-3 #3: the prod flip of 20:35:16Z went
 * through the bare upsert and left no author):
 *   PUT /admin/settings/patience_auto_only
 *     body { value: '0'|'1'|true|false|on|off } → validated, idempotent
 *     (changed:false when unchanged), audited via setPatienceAutoOnly with the
 *     admin's email; a non-admin is 403d; a bad value is 400d; the response
 *     carries the fresh state.
 *   GET /admin/settings/patience → enabled / since / updatedBy / source /
 *     bootDefault + the harness line; admin only.
 * Harness: the label-window suite's mocked import graph — the controller is
 * imported for real, rate-limit.service is mocked at the boundary.
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));
const mockUpsert = jest.fn(async ({ where, update }: any) => ({ key: where.key, value: update.value }));
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    crossModelChat: { findUnique: jest.fn() },
    crossModelMessage: { findMany: jest.fn() },
    systemSetting: { upsert: (a: any) => mockUpsert(a), findMany: jest.fn(async () => []) },
  },
}));
jest.mock('./crossmodel.service', () => ({ __esModule: true, default: { getChatAccess: jest.fn(async () => ({ access: 'owner', exists: true })) } }));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(), combineAttachments: jest.fn(() => null), persistChatUploads: jest.fn(async () => {}) }));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('./integrations/qwen-kid.integration', () => ({ streamKidResponse: jest.fn(async () => {}), generateKidStatus: jest.fn(async () => '') }));
jest.mock('./mcp-search', () => ({ searchWithBrightData: jest.fn(async () => []) }));
jest.mock('./browser-agent', () => ({ runBrowserAgentSession: jest.fn() }));
jest.mock('./chat-agent/chat-gate', () => ({
  decideChatGate: jest.fn(), mapAttachmentForAgent: jest.fn(() => ({ userImages: [], documentText: '' })),
  chatWriteAccessGranted: jest.fn(() => true), chatReadAccessGranted: jest.fn(), streamAccessDeniedError: jest.fn(),
}));
jest.mock('./guest-location', () => ({ buildGuestLocationBlock: jest.fn(async () => undefined) }));
jest.mock('./integration-context', () => ({ buildIntegrationContext: jest.fn(async () => ({ additionalContext: '', imessagePairedAgentId: null })), buildIntegrationContextBounded: jest.fn(async (build) => build()) }));
const mockInvalidateAutoOnly: jest.Mock = jest.fn();
const mockSetPatience: jest.Mock = jest.fn();
const mockGetPatienceState: jest.Mock = jest.fn();
jest.mock('./rate-limit.service', () => ({
  ...jest.requireActual('./rate-limit.service'),
  checkDeepResearchQuota: jest.fn(), reserveDeepResearchQuota: jest.fn(), reserveAnonDeepResearchQuota: jest.fn(),
  getDeepResearchDailyLimit: jest.fn(), getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
  getPatienceAutoOnly: jest.fn(async () => false), invalidatePatienceAutoOnlyCache: (...a: any[]) => mockInvalidateAutoOnly(...a),
  deepResearchAllowance: jest.fn(),
  setPatienceAutoOnly: (...a: any[]) => mockSetPatience(...a),
  getPatienceAutoOnlyState: (...a: any[]) => mockGetPatienceState(...a),
}));
jest.mock('./coding/coding-data.service', () => ({ getChatCapability: jest.fn(async () => ({ hasWorkspaceState: false, codeCapable: false })) }));
jest.mock('./chat-agent/chat-busy', () => ({ isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({ attachRemoteChatRun: jest.fn(), replayFinishedRemoteRun: jest.fn(async () => false) }));
jest.mock('./coding/coding-stream.controller', () => ({ __esModule: true, default: { streamRun: jest.fn() } }));
jest.mock('./platform/loop-metrics.service', () => ({ ...jest.requireActual('./platform/loop-metrics.service'), recordLoopMetric: jest.fn() }));
jest.mock('./platform/auto-router-gate', () => ({ ...jest.requireActual('./platform/auto-router-gate'), shadowAutoRouteAgainst: jest.fn(async () => {}), routeMessageAuto: jest.fn() }));
jest.mock('./chat-agent/chat-agent.service', () => ({ startDetachedChatRun: jest.fn(), chatAgentRunKey: jest.fn(() => 'agent-key') }));
jest.mock('./coding/live-runs', () => ({ isRunActive: jest.fn(() => false), subscribeRun: jest.fn(() => null) }));
jest.mock('./platform/supervisor-switch', () => ({
  ...jest.requireActual('./platform/supervisor-switch'),
  setSupervisorSwitch: jest.fn(),
  getSupervisorSwitchState: jest.fn(),
}));

import controller from './crossmodel.controller';
import fs from 'fs';
import path from 'path';

const STATE = {
  key: 'patience_auto_only', enabled: true, since: '2026-09-26T20:35:16.556Z', updatedBy: null, source: 'setting', bootDefault: false, envVar: 'PATIENCE_AUTO_ONLY',
  line: 'Always Auto: ON since 2026-09-26 20:35Z by unknown (store row; deleting it reverts to the env boot default = OFF)',
};
const ADMIN = { id: 'u-admin', email: 'admin@example.com', role: 'ADMIN' };
const OWNER = { id: 'u-paul', email: 'example-user@example.com', role: 'USER' };
const PLEB = { id: 'u-2', email: 'someone@example.com', role: 'USER' };

const mkReq = (over: any = {}): any => ({ params: {}, body: {}, query: {}, headers: {}, ...over });
const mkRes = (): any => {
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPatienceState.mockResolvedValue(STATE);
  mockSetPatience.mockResolvedValue({ key: 'patience_auto_only', enabled: false, changed: true, setting: { key: 'patience_auto_only', value: '0' } });
});

describe('PUT /admin/settings/patience_auto_only — audited flip', () => {
  it('403s a non-admin before touching anything', async () => {
    const res = mkRes();
    await controller.updateAdminSetting(mkReq({ user: PLEB, params: { key: 'patience_auto_only' }, body: { value: '0' } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSetPatience).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('400s a value outside 1|0|true|false|on|off (no write) — the reader would have read "maybe" as OFF silently', async () => {
    const res = mkRes();
    await controller.updateAdminSetting(mkReq({ user: ADMIN, params: { key: 'patience_auto_only' }, body: { value: 'maybe' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'value must be one of 1|0|true|false|on|off for patience_auto_only' });
    expect(mockSetPatience).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('an ADMIN flips it OFF: setPatienceAutoOnly(false, email), never the bare upsert; the response carries changed + state', async () => {
    const res = mkRes();
    await controller.updateAdminSetting(mkReq({ user: ADMIN, params: { key: 'patience_auto_only' }, body: { value: 'off' } }), res);
    expect(mockSetPatience).toHaveBeenCalledWith(false, 'admin@example.com');
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockInvalidateAutoOnly).not.toHaveBeenCalled(); // the service invalidates inside the flip
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { key: 'patience_auto_only', value: '0' }, changed: true, state: STATE });
  });

  it('the owner email is an admin too; an unchanged value answers changed:false with the stored row', async () => {
    mockSetPatience.mockResolvedValue({ key: 'patience_auto_only', enabled: true, changed: false, setting: { key: 'patience_auto_only', value: '1' } });
    const res = mkRes();
    await controller.updateAdminSetting(mkReq({ user: OWNER, params: { key: 'patience_auto_only' }, body: { value: true } }), res);
    expect(mockSetPatience).toHaveBeenCalledWith(true, 'example-user@example.com');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { key: 'patience_auto_only', value: '1' }, changed: false, state: STATE });
  });

  it('500s (never throws) when the flip fails', async () => {
    mockSetPatience.mockRejectedValue(new Error('db down'));
    const res = mkRes();
    await controller.updateAdminSetting(mkReq({ user: ADMIN, params: { key: 'patience_auto_only' }, body: { value: '1' } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('GET /admin/settings/patience', () => {
  it('403s a non-admin', async () => {
    const res = mkRes();
    await controller.getAdminPatienceSettings(mkReq({ user: PLEB }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetPatienceState).not.toHaveBeenCalled();
  });

  it('returns enabled / since / updatedBy / source / bootDefault and the line for an admin', async () => {
    const res = mkRes();
    await controller.getAdminPatienceSettings(mkReq({ user: ADMIN }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: STATE });
    expect(res.json.mock.calls[0][0].data).toMatchObject({ enabled: true, since: '2026-09-26T20:35:16.556Z', updatedBy: null, source: 'setting', bootDefault: false });
  });

  it('500s (never throws) when the state read fails', async () => {
    mockGetPatienceState.mockRejectedValue(new Error('db down'));
    const res = mkRes();
    await controller.getAdminPatienceSettings(mkReq({ user: OWNER }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('is routed: GET /admin/settings/patience is registered before the :key PUT, and the PUT doc names the key', () => {
    const routes = fs.readFileSync(path.join(__dirname, 'crossmodel.routes.ts'), 'utf8');
    expect(routes).toContain("router.get('/admin/settings/patience', controller.getAdminPatienceSettings);");
    expect(routes.indexOf("router.get('/admin/settings/patience'")).toBeLessThan(routes.indexOf("router.put('/admin/settings/:key'"));
  });
});

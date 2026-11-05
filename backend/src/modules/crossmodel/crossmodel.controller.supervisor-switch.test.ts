/**
 * Supervisor OFF switch — the admin REST surface (owner 2026-09-26):
 *   PUT /admin/settings/fleet_supervisor_enabled | project_supervisors_enabled
 *     body { value: '0'|'1'|true|false|on|off } → validated, idempotent
 *     (changed:false when unchanged), audited via setSupervisorSwitch with the
 *     admin's email; a non-admin is 403d; a bad value is 400d; the response
 *     carries the fresh state.
 *   GET /admin/settings/supervisors → both switches with since / updatedBy /
 *     skipped + the harness line; admin only.
 * The generic (non-switch) key path is untouched (patience_auto_only still
 * invalidates its own cache). Harness: the label-window suite's mocked
 * import graph — the controller is imported for real, supervisor-switch is
 * mocked at the boundary.
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
const mockSetAutoOnly: jest.Mock = jest.fn();
const AUTO_ONLY_STATE = { key: 'patience_auto_only', enabled: true, since: '2026-09-26T20:35:16.556Z', updatedBy: 'admin@digby.ai', source: 'setting', bootDefault: false, envVar: 'PATIENCE_AUTO_ONLY' };
const mockAutoOnlyState: jest.Mock = jest.fn(async () => AUTO_ONLY_STATE);
const mockDepthPolicy: jest.Mock = jest.fn(async () => ({ autoOnly: true }));
jest.mock('./rate-limit.service', () => ({
  checkDeepResearchQuota: jest.fn(), reserveDeepResearchQuota: jest.fn(), reserveAnonDeepResearchQuota: jest.fn(),
  getDeepResearchDailyLimit: jest.fn(), getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
  getPatienceAutoOnly: jest.fn(async () => false), invalidatePatienceAutoOnlyCache: (...a: any[]) => mockInvalidateAutoOnly(...a),
  setPatienceAutoOnly: (...a: any[]) => mockSetAutoOnly(...a),
  getPatienceAutoOnlyState: (...a: any[]) => mockAutoOnlyState(...a),
  getDepthPolicyPublic: (...a: any[]) => mockDepthPolicy(...a),
  deepResearchAllowance: jest.fn(), PATIENCE_AUTO_ONLY_KEY: 'patience_auto_only',
  parsePatienceSwitchValue: (v: unknown) => { const x = String(v ?? '').trim().toLowerCase(); return x === '1' || x === 'true' || x === 'on' ? true : x === '0' || x === 'false' || x === 'off' ? false : null; },
}));
jest.mock('./coding/coding-data.service', () => ({ getChatCapability: jest.fn(async () => ({ hasWorkspaceState: false, codeCapable: false })) }));
jest.mock('./chat-agent/chat-busy', () => ({ isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({ attachRemoteChatRun: jest.fn(), replayFinishedRemoteRun: jest.fn(async () => false) }));
jest.mock('./coding/coding-stream.controller', () => ({ __esModule: true, default: { streamRun: jest.fn() } }));
jest.mock('./platform/loop-metrics.service', () => ({ ...jest.requireActual('./platform/loop-metrics.service'), recordLoopMetric: jest.fn() }));
jest.mock('./platform/auto-router-gate', () => ({ ...jest.requireActual('./platform/auto-router-gate'), shadowAutoRouteAgainst: jest.fn(async () => {}), routeMessageAuto: jest.fn() }));
jest.mock('./chat-agent/chat-agent.service', () => ({ startDetachedChatRun: jest.fn(), chatAgentRunKey: jest.fn(() => 'agent-key') }));
jest.mock('./coding/live-runs', () => ({ isRunActive: jest.fn(() => false), subscribeRun: jest.fn(() => null) }));

const mockSetSwitch: jest.Mock = jest.fn();
const mockGetState: jest.Mock = jest.fn();
jest.mock('./platform/supervisor-switch', () => ({
  ...jest.requireActual('./platform/supervisor-switch'),
  setSupervisorSwitch: (...a: any[]) => mockSetSwitch(...a),
  getSupervisorSwitchState: (...a: any[]) => mockGetState(...a),
}));

import controller from './crossmodel.controller';

const STATE = {
  fleet: { target: 'fleet', key: 'fleet_supervisor_enabled', enabled: false, since: '2026-09-26T17:30:00.000Z', updatedBy: 'example-user@example.com', skipped: 3, source: 'setting', bootDefault: true, envVar: 'FLEET_SUPERVISOR_ENABLED' },
  project: { target: 'project', key: 'project_supervisors_enabled', enabled: true, since: null, updatedBy: null, skipped: 0, source: 'env', bootDefault: true, envVar: 'PROJECT_SUPERVISORS_ENABLED' },
  line: 'Fleet supervisor: OFF since 2026-09-26 17:30Z by example-user@example.com — wakes skipped: 3',
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
  mockGetState.mockResolvedValue(STATE);
  mockSetSwitch.mockResolvedValue({ target: 'fleet', key: 'fleet_supervisor_enabled', enabled: false, changed: true, setting: { key: 'fleet_supervisor_enabled', value: '0' } });
});

describe('PUT /admin/settings/:key — supervisor switches', () => {
  it('403s a non-admin before touching anything', async () => {
    const res = mkRes();
    await controller.updateAdminSetting(mkReq({ user: PLEB, params: { key: 'fleet_supervisor_enabled' }, body: { value: '0' } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSetSwitch).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('400s a value outside 1|0|true|false|on|off (no write)', async () => {
    const res = mkRes();
    await controller.updateAdminSetting(mkReq({ user: ADMIN, params: { key: 'project_supervisors_enabled' }, body: { value: 'maybe' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'value must be one of 1|0|true|false|on|off for project_supervisors_enabled' });
    expect(mockSetSwitch).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('an ADMIN flips the fleet switch OFF: setSupervisorSwitch(key, false, email), never the generic upsert; the response carries changed + state', async () => {
    const res = mkRes();
    await controller.updateAdminSetting(mkReq({ user: ADMIN, params: { key: 'fleet_supervisor_enabled' }, body: { value: 'off' } }), res);
    expect(mockSetSwitch).toHaveBeenCalledWith('fleet_supervisor_enabled', false, 'admin@example.com');
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { key: 'fleet_supervisor_enabled', value: '0' }, changed: true, state: STATE });
  });

  it('the owner email is an admin too; an unchanged value answers changed:false', async () => {
    mockSetSwitch.mockResolvedValue({ target: 'project', key: 'project_supervisors_enabled', enabled: true, changed: false, setting: null });
    const res = mkRes();
    await controller.updateAdminSetting(mkReq({ user: OWNER, params: { key: 'project_supervisors_enabled' }, body: { value: true } }), res);
    expect(mockSetSwitch).toHaveBeenCalledWith('project_supervisors_enabled', true, 'example-user@example.com');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { key: 'project_supervisors_enabled', value: '1' }, changed: false, state: STATE });
  });

  it('a non-switch key still takes the generic upsert path (deep_research_daily_limit)', async () => {
    const res = mkRes();
    await controller.updateAdminSetting(mkReq({ user: ADMIN, params: { key: 'deep_research_daily_limit' }, body: { value: '7' } }), res);
    expect(mockSetSwitch).not.toHaveBeenCalled();
    expect(mockSetAutoOnly).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalledWith({ where: { key: 'deep_research_daily_limit' }, update: { value: '7' }, create: { key: 'deep_research_daily_limit', value: '7' } });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { key: 'deep_research_daily_limit', value: '7' } });
  });

  // Audit 2026-09-26 (patience_auto_only prod state vs documented contract):
  // the always-Auto switch takes the SAME audited, idempotent path as the
  // supervisor switches — never the bare upsert that left the 20:35Z flip's
  // actor unrecoverable.
  it('patience_auto_only is audited + idempotent: setPatienceAutoOnly(parsed, admin) and the fresh state ride the response', async () => {
    mockSetAutoOnly.mockResolvedValue({ key: 'patience_auto_only', enabled: false, changed: true, setting: { key: 'patience_auto_only', value: '0' } });
    const res = mkRes();
    await controller.updateAdminSetting(mkReq({ user: ADMIN, params: { key: 'patience_auto_only' }, body: { value: 'off' } }), res);
    expect(mockSetSwitch).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockSetAutoOnly).toHaveBeenCalledWith(false, 'admin@example.com');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { key: 'patience_auto_only', value: '0' }, changed: true, state: AUTO_ONLY_STATE });
  });

  it('patience_auto_only rejects a non-boolean value with 400 and writes nothing', async () => {
    const res = mkRes();
    await controller.updateAdminSetting(mkReq({ user: ADMIN, params: { key: 'patience_auto_only' }, body: { value: 'maybe' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetAutoOnly).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('an unchanged patience_auto_only value answers changed:false (nothing written)', async () => {
    mockSetAutoOnly.mockResolvedValue({ key: 'patience_auto_only', enabled: true, changed: false, setting: { key: 'patience_auto_only', value: '1' } });
    const res = mkRes();
    await controller.updateAdminSetting(mkReq({ user: OWNER, params: { key: 'patience_auto_only' }, body: { value: '1' } }), res);
    expect(mockSetAutoOnly).toHaveBeenCalledWith(true, 'example-user@example.com');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { key: 'patience_auto_only', value: '1' }, changed: false, state: AUTO_ONLY_STATE });
  });
});

describe('GET /admin/settings/patience-auto-only + GET /depth/policy', () => {
  it('403s a non-admin on the admin GET; the admin gets the audited state', async () => {
    const res = mkRes();
    await controller.getAdminPatienceAutoOnly(mkReq({ user: { id: 'u2', role: 'USER', email: 'x@y.z' } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    const res2 = mkRes();
    await controller.getAdminPatienceAutoOnly(mkReq({ user: ADMIN }), res2);
    expect(res2.json).toHaveBeenCalledWith({ success: true, data: AUTO_ONLY_STATE });
  });

  it('the user-facing policy carries ONLY the flag (no admin facts)', async () => {
    const res = mkRes();
    await controller.getDepthPolicy(mkReq({ user: { id: 'u2', role: 'USER', email: 'x@y.z' } }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { autoOnly: true } });
  });
});

describe('GET /admin/settings/supervisors', () => {
  it('403s a non-admin', async () => {
    const res = mkRes();
    await controller.getAdminSupervisorSettings(mkReq({ user: PLEB }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetState).not.toHaveBeenCalled();
  });

  it('returns both switches with since / updatedBy / skipped and the line for an admin', async () => {
    const res = mkRes();
    await controller.getAdminSupervisorSettings(mkReq({ user: ADMIN }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: STATE });
    expect(res.json.mock.calls[0][0].data.fleet).toMatchObject({ enabled: false, since: '2026-09-26T17:30:00.000Z', updatedBy: 'example-user@example.com', skipped: 3 });
  });

  it('500s (never throws) when the state read fails', async () => {
    mockGetState.mockRejectedValue(new Error('db down'));
    const res = mkRes();
    await controller.getAdminSupervisorSettings(mkReq({ user: OWNER }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

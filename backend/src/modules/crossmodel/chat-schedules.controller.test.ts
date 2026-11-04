/**
 * /api/crossmodel/chats/:id/schedules — the per-chat schedules endpoints
 * behind the app-level authenticate guard (crossmodel.routes.ts):
 *   GET    — list (owner OR project member, read level — 404 without
 *            existence leak) with the { success, data: { schedules } } envelope.
 *   DELETE /:scheduleId — cancel without confirmation (rm9); wiring pins here,
 *            access/audit/event semantics pinned in platform.service.test.ts +
 *            coding/chat-schedules.service.test.ts.
 *   PATCH  /:scheduleId {enabled} — pause/resume; same split.
 *
 * Boundaries mocked per .digby/notes/learnings.md: importing the real service
 * graph pulls config/database + config/redis → config/env, which exits the
 * jest worker at import. Every controller import that isn't pure types gets a
 * load-time stand-in; only the handlers' own seams (getChatAccess,
 * schedule.service's listSchedules, platform.service's cancelChatSchedule /
 * setChatScheduleEnabled) record calls.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));

// The ONE live authz seam — getChatAccess decides 200 vs 404.
const mockGetChatAccess: jest.Mock = jest.fn();
jest.mock('./crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: (...a: any[]) => mockGetChatAccess(...a) },
}));

// The ONE live data seam — dynamically imported by the handler.
const mockListSchedules: jest.Mock = jest.fn();
jest.mock('./coding/schedule.service', () => ({
  __esModule: true,
  listSchedules: (...a: any[]) => mockListSchedules(...a),
}));

// Platform seams for the mutation endpoints (rm9): the controller calls the
// statically imported platformService — access gates, audit, and hook-event
// semantics live (and are pinned) in platform.service / schedule.service.
const mockCancelChatSchedule: jest.Mock = jest.fn();
const mockSetChatScheduleEnabled: jest.Mock = jest.fn();
jest.mock('./platform/platform.service', () => ({
  __esModule: true,
  cancelChatSchedule: (...a: any[]) => mockCancelChatSchedule(...a),
  setChatScheduleEnabled: (...a: any[]) => mockSetChatScheduleEnabled(...a),
}));
jest.mock('./platform/auto-router', () => ({ __esModule: true, routeMessageHeuristic: jest.fn() }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn() }));
jest.mock('./feedback/feedback.service', () => ({ __esModule: true, FEEDBACK_TYPES: [] }));
jest.mock('./langgraph/memory.graph', () => ({ __esModule: true, updateContextAsync: jest.fn() }));
jest.mock('./integrations/qwen-kid.integration', () => ({
  __esModule: true,
  streamKidResponse: jest.fn(),
  generateKidStatus: jest.fn(),
}));
jest.mock('./mcp-search', () => ({ __esModule: true, searchWithBrightData: jest.fn() }));
jest.mock('./browser-agent', () => ({ __esModule: true, runBrowserAgentSession: jest.fn() }));
jest.mock('./chat-agent/chat-gate', () => ({
  __esModule: true,
  decideChatGate: jest.fn(),
  mapAttachmentForAgent: jest.fn(),
  chatWriteAccessGranted: jest.fn(),
  chatReadAccessGranted: jest.fn(),
  streamAccessDeniedError: jest.fn(),
}));
jest.mock('./integration-context', () => ({ __esModule: true, buildIntegrationContext: jest.fn(async () => ({ additionalContext: undefined, imessagePairedAgentId: null })), buildIntegrationContextBounded: jest.fn(async (build) => build()) }));
jest.mock('./rate-limit.service', () => ({
  __esModule: true,
  checkDeepResearchQuota: jest.fn(),
  reserveDeepResearchQuota: jest.fn(),
  getDeepResearchDailyLimit: jest.fn(),
  getAllDeepResearchUsageToday: jest.fn(),
  invalidateLimitCache: jest.fn(),
}));

import controller from './crossmodel.controller';

const OWNER = 'u-owner';
const CHAT = 'c1';

const mkReq = (over: any = {}): any => ({
  params: { id: CHAT },
  user: { id: OWNER },
  ...over,
});

const mkRes = (): any => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const SCHEDULE = {
  id: 's1', kind: 'recurring', prompt: 'check the fleet', intervalSec: 3600,
  nextRunAt: '2026-08-17T09:00:00.000Z', enabled: true, runsCount: 2, maxRuns: 500,
  expiresAt: '2026-09-16T00:00:00.000Z', lastFiredAt: '2026-08-16T09:00:00.000Z',
  lastStatus: 'started', dailyFiresUsed: 2, dailyCapLimit: 48, capWindowResetsAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  mockListSchedules.mockResolvedValue([SCHEDULE]);
});

describe('listChatSchedules', () => {
  it('owner → 200 with the schedules envelope (listSchedules called with the chat id)', async () => {
    const res = mkRes();
    const next = jest.fn();
    await controller.listChatSchedules(mkReq(), res, next);

    expect(mockGetChatAccess).toHaveBeenCalledWith(CHAT, OWNER);
    expect(mockListSchedules).toHaveBeenCalledWith(CHAT);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { schedules: [SCHEDULE] } });
    expect(next).not.toHaveBeenCalled();
  });

  it('project member (read access) → 200 — the streamChatRun access rule, not owner-only', async () => {
    mockGetChatAccess.mockResolvedValue({ access: 'read', exists: true });
    const res = mkRes();
    await controller.listChatSchedules(mkReq(), res, jest.fn());

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { schedules: [SCHEDULE] } });
  });

  it('foreign chat (no access) → 404, never reveals the schedules', async () => {
    mockGetChatAccess.mockResolvedValue({ access: 'none', exists: true });
    const res = mkRes();
    await controller.listChatSchedules(mkReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Chat not found' });
    expect(mockListSchedules).not.toHaveBeenCalled();
  });

  it('missing chat → 404 (same no-existence-leak shape)', async () => {
    mockGetChatAccess.mockResolvedValue({ access: 'none', exists: false });
    const res = mkRes();
    await controller.listChatSchedules(mkReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockListSchedules).not.toHaveBeenCalled();
  });

  it('a service failure routes to next(err) — never an unhandled rejection', async () => {
    mockListSchedules.mockRejectedValue(new Error('redis down'));
    const next = jest.fn();
    await controller.listChatSchedules(mkReq(), mkRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'redis down' }));
  });
});

// ── DELETE /chats/:id/schedules/:scheduleId (rm9 — cancel without asking) ─────

const SCHEDULE_ID = 'a0b1c2d3-0000-4000-8000-000000000001';
const mkScheduleReq = (over: any = {}): any => ({
  params: { id: CHAT, scheduleId: SCHEDULE_ID },
  user: { id: OWNER },
  body: {},
  ...over,
});

describe('cancelChatSchedule (controller wiring)', () => {
  it('owner → 200 with the platform result in the data envelope (deaf-lane warning included)', async () => {
    mockCancelChatSchedule.mockResolvedValue({ cancelled: true, alreadyDisabled: false, warning: 'WARNING — no enabled schedules left' });
    const res = mkRes();
    const next = jest.fn();
    await controller.cancelChatSchedule(mkScheduleReq(), res, next);

    expect(mockCancelChatSchedule).toHaveBeenCalledWith({ userId: OWNER, chatId: CHAT, scheduleId: SCHEDULE_ID });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { cancelled: true, alreadyDisabled: false, warning: 'WARNING — no enabled schedules left' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('platform access refusals (foreign 404 / member 403) propagate to next(err) with their status', async () => {
    for (const statusCode of [404, 403]) {
      mockCancelChatSchedule.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode }));
      const next = jest.fn();
      await controller.cancelChatSchedule(mkScheduleReq(), mkRes(), next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode }));
    }
  });
});

describe('updateChatSchedule (controller wiring — pause/resume)', () => {
  it('passes the validated enabled boolean through and returns the schedule envelope', async () => {
    const schedule = { ...SCHEDULE, enabled: false, lastStatus: 'paused' };
    mockSetChatScheduleEnabled.mockResolvedValue({ schedule, changed: true });
    const res = mkRes();
    const next = jest.fn();
    await controller.updateChatSchedule(mkScheduleReq({ body: { enabled: false } }), res, next);

    expect(mockSetChatScheduleEnabled).toHaveBeenCalledWith({ userId: OWNER, chatId: CHAT, scheduleId: SCHEDULE_ID, enabled: false });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { schedule, changed: true } });
    expect(next).not.toHaveBeenCalled();
  });

  it('resume goes through the same seam with enabled:true (the Undo path)', async () => {
    mockSetChatScheduleEnabled.mockResolvedValue({ schedule: SCHEDULE, changed: true });
    await controller.updateChatSchedule(mkScheduleReq({ body: { enabled: true } }), mkRes(), jest.fn());
    expect(mockSetChatScheduleEnabled).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('cadence-rule refusals (409 completed / cap) propagate to next(err)', async () => {
    mockSetChatScheduleEnabled.mockRejectedValue(Object.assign(new Error('Schedule already completed its runs'), { statusCode: 409 }));
    const next = jest.fn();
    await controller.updateChatSchedule(mkScheduleReq({ body: { enabled: true } }), mkRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
  });
});

/**
 * streamQuery × RESEARCH ROUTING BY THE TURN PLAN (roster 2026-10-06 A-3, platform/lane-depth.ts routeResearchLane).
 * Pins the controller seam (the decision rule itself is pinned in platform/lane-depth.test.ts):
 *   - an Auto send asks the research route AFTER resolveSendMode and BEFORE the routing card / the quota reserve;
 *   - a 'research' route runs the council: mode deep_research, the routing card + routingSource auto_turn_plan, the
 *     council quota reserved (decideChatGate gets lane 'research'), the answered plan handed to the run
 *     (turnPlanPrefetched) — and a lost reserve demotes to Ensemble like any Auto Level 3 (the rejection row says
 *     lane research);
 *   - a 'keyword_retired' route runs Ensemble with no reserve;
 *   - a throwing helper / an escalation / an explicit level: the router's level stands, nothing re-routed.
 * Harness: crossmodel.controller.dig-deeper.test.ts (mocked import graph; startDetachedChatRun is the sink).
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));

const mockFindUser = jest.fn();
const mockFindChat = jest.fn();
const mockFindMessage: jest.Mock = jest.fn(async () => null);
const mockFindFirstMessage: jest.Mock = jest.fn(async () => null);
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    user: { findUnique: (...a: any[]) => mockFindUser(...a) },
    crossModelChat: { findUnique: (...a: any[]) => mockFindChat(...a) },
    crossModelMessage: { findMany: jest.fn(), findUnique: (...a: any[]) => mockFindMessage(...a), findFirst: (...a: any[]) => mockFindFirstMessage(...a) },
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
const mockDecideChatGate = jest.fn();
jest.mock('./chat-agent/chat-gate', () => ({
  decideChatGate: (...a: any[]) => mockDecideChatGate(...a),
  mapAttachmentForAgent: jest.fn(() => ({ userImages: [], documentText: '' })),
  chatWriteAccessGranted: jest.fn(() => true),
  chatReadAccessGranted: jest.fn(),
  streamAccessDeniedError: jest.fn(),
}));
jest.mock('./guest-location', () => ({ buildGuestLocationBlock: jest.fn(async () => undefined) }));
jest.mock('./integration-context', () => ({ buildIntegrationContext: jest.fn(async () => ({ additionalContext: '', imessagePairedAgentId: null })), buildIntegrationContextBounded: jest.fn(async (build) => build()) }));
const mockAutoOnly: jest.Mock = jest.fn(async () => false);
const mockAllowance: jest.Mock = jest.fn();
const mockReserve: jest.Mock = jest.fn();
const mockReserveAnon: jest.Mock = jest.fn();
jest.mock('./rate-limit.service', () => ({
  checkDeepResearchQuota: jest.fn(),
  reserveDeepResearchQuota: (...a: any[]) => mockReserve(...a),
  reserveAnonDeepResearchQuota: (...a: any[]) => mockReserveAnon(...a),
  getDeepResearchDailyLimit: jest.fn(), getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
  getPatienceAutoOnly: (...a: any[]) => mockAutoOnly(...a),
  invalidatePatienceAutoOnlyCache: jest.fn(),
  deepResearchAllowance: (...a: any[]) => mockAllowance(...a),
  PATIENCE_AUTO_ONLY_KEY: 'patience_auto_only',
}));
jest.mock('./coding/coding-data.service', () => ({ getChatCapability: jest.fn(async () => ({ hasWorkspaceState: false, codeCapable: false })) }));
jest.mock('./chat-agent/chat-busy', () => ({ isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({ attachRemoteChatRun: jest.fn(), replayFinishedRemoteRun: jest.fn(async () => false) }));
jest.mock('./coding/coding-stream.controller', () => ({ __esModule: true, default: { streamRun: jest.fn() } }));
const mockRecordMetric: jest.Mock = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  ...jest.requireActual('./platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordMetric(...a),
}));
const mockRoute: jest.Mock = jest.fn();
jest.mock('./platform/auto-router-gate', () => ({
  ...jest.requireActual('./platform/auto-router-gate'),
  shadowAutoRouteAgainst: jest.fn(async () => {}),
  routeMessageAuto: (...a: any[]) => mockRoute(...a),
}));
const mockStartDetachedChatRun: jest.Mock = jest.fn();
jest.mock('./chat-agent/chat-agent.service', () => ({
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatAgentRunKey: jest.fn(() => 'agent-key'),
  preemptMachineRunForUserMessage: jest.fn(async () => ({ preempted: false, freed: false })),
  nudgeQueueDrainSoon: jest.fn(),
}));
jest.mock('./message-as-answer', () => ({ resolveParkedQuestionWithOwnerText: jest.fn(async () => ({ resolved: false })) }));
jest.mock('./coding/live-runs', () => ({ isRunActive: jest.fn(() => false), subscribeRun: jest.fn(() => null) }));
jest.mock('./chat-agent/compute-policy-labels', () => ({
  __esModule: true,
  labelComputePolicyEscalated: jest.fn(() => 'escalated'),
  labelRevisionMaterialFromMetadata: jest.fn(() => false),
  labelDraftsAgreeFromMetadata: jest.fn(() => false),
  factsFromDepthMetadata: (meta: any) => (meta?.depth?.facts ?? null),
}));
const mockRouteResearch: jest.Mock = jest.fn();
jest.mock('./platform/lane-depth', () => ({ __esModule: true, routeResearchLane: (...a: any[]) => mockRouteResearch(...a) }));

import controller from './crossmodel.controller';

const CHAT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const MSG = '9b2e7c1a-2d3f-4e5a-8b6c-1d2e3f4a5b6c';
const mkReq = (over: any = {}): any => ({ query: { message: 'Explain the history of Quebec sovereignty', mode: 'auto', chatId: CHAT }, headers: {}, on: jest.fn(), user: { id: 'u1' }, ...over });
const mkRes = (): any => {
  const res: any = {
    frames: [] as string[], writableEnded: false,
    status: jest.fn(() => res), json: jest.fn(() => res), setHeader: jest.fn(), cookie: jest.fn(), flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => { res.frames.push(chunk); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
  };
  return res;
};
const events = (res: any) => res.frames.filter((f: string) => f.startsWith('data: ')).map((f: string) => JSON.parse(f.replace(/^data: /, '')));
const flush = () => new Promise(r => setImmediate(r));
const heuristicRoute = (level: string, reasonKey = 'default_ensemble') => ({ level, reason: 'default ensemble', reasonKey, suggestCode: false, needsWorkspace: false, source: 'heuristic', heuristicLevel: level });
const TURN_PLAN = { lane: 'research', act: false, mode: 'act', reason: 'lane research', decisionId: 'tp-r', cls: null, roster: null };

beforeEach(() => {
  jest.clearAllMocks();
  mockDecideChatGate.mockImplementation(({ mode, lane }: any) => ({ action: 'agent', councilMode: lane === 'research' || mode === 'deep_research' }));
  mockFindUser.mockResolvedValue({ isChild: false });
  mockFindChat.mockResolvedValue({ id: CHAT, userId: 'u1', projectId: null, title: 't', isSupervisor: false, isProjectSupervisor: false });
  mockStartDetachedChatRun.mockResolvedValue('run-key-1');
  mockAutoOnly.mockResolvedValue(false);
  mockAllowance.mockResolvedValue({ allowed: true });
  mockReserve.mockResolvedValue({ allowed: true, used: 1, limit: 5, remaining: 4 });
  mockRoute.mockImplementation(async () => heuristicRoute('thinking'));
  mockRouteResearch.mockImplementation(async (i: any) => ({ mode: i.mode, routing: i.routing, turnPlan: null, route: 'not_governed', why: 'test' }));
});

describe('research routing by the turn plan at the stream controller (A-3)', () => {
  it('a governed Auto send: the route is asked with the resolved level + routing card, after resolveSendMode', async () => {
    await controller.streamQuery(mkReq(), mkRes(), jest.fn());
    await flush();
    expect(mockRouteResearch).toHaveBeenCalledTimes(1);
    expect(mockRouteResearch.mock.calls[0][0]).toMatchObject({ seam: 'web', userId: 'u1', chatId: CHAT, mode: 'thinking', autoRouted: true, isSupervisorChat: false, isChild: false, escalation: false, routing: { level: 'thinking' } });
    // not governed ⇒ nothing changes
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'thinking' });
    expect(mockStartDetachedChatRun.mock.calls[0][0].turnPlanPrefetched).toBeUndefined();
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it('2026-10-20: the route gets the router\'s Level 3 ALLOWANCE verdict (a guest / quota-denied sender is never lane-routed to a council)', async () => {
    await controller.streamQuery(mkReq(), mkRes(), jest.fn());
    await flush();
    expect(mockRouteResearch.mock.calls[0][0]).toMatchObject({ deepResearchAllowed: true });
    expect(mockRouteResearch.mock.calls[0][0].deepResearchDenyReason).toBeUndefined();
    mockAllowance.mockResolvedValue({ allowed: false, reasonKey: 'quota_exhausted' });
    await controller.streamQuery(mkReq(), mkRes(), jest.fn());
    await flush();
    expect(mockRouteResearch.mock.calls[1][0]).toMatchObject({ mode: 'thinking', deepResearchAllowed: false, deepResearchDenyReason: 'quota_exhausted' });
  });

  it('route research ⇒ the COUNCIL: mode deep_research, the routing card says turn_plan, the quota is reserved (lane research), the plan rides into the run', async () => {
    mockRouteResearch.mockImplementation(async (i: any) => ({
      mode: 'deep_research', routingSource: 'auto_turn_plan', turnPlan: TURN_PLAN, route: 'research', why: 'lane research (p 0.70 ≥ 0.5)',
      routing: { ...i.routing, level: 'deep_research', reasonKey: 'turn_plan_research', source: 'turn_plan', reason: 'turn plan: research' },
    }));
    const res = mkRes();
    await controller.streamQuery(mkReq(), res, jest.fn());
    await flush();
    expect(mockDecideChatGate).toHaveBeenCalledWith({ mode: 'deep_research', userId: 'u1', lane: 'research' });
    expect(mockReserve).toHaveBeenCalledWith('u1');
    const args = mockStartDetachedChatRun.mock.calls[0][0];
    expect(args).toMatchObject({ mode: 'deep_research', routingSource: 'auto_turn_plan', turnPlanPrefetched: TURN_PLAN, routing: { level: 'deep_research', reasonKey: 'turn_plan_research', source: 'turn_plan' } });
    expect(events(res).filter((e: any) => e.type === 'routing').at(-1)?.data).toMatchObject({ level: 'deep_research', reasonKey: 'turn_plan_research' });
  });

  it('a research route that LOSES the reserve is demoted to Ensemble like any Auto Level 3 — never an error; the rejection row says lane research', async () => {
    mockRouteResearch.mockImplementation(async (i: any) => ({
      mode: 'deep_research', routingSource: 'auto_turn_plan', turnPlan: TURN_PLAN, route: 'research', why: 'x',
      routing: { ...i.routing, level: 'deep_research', reasonKey: 'turn_plan_research', source: 'turn_plan', reason: 'turn plan: research' },
    }));
    mockReserve.mockResolvedValue({ allowed: false, used: 5, limit: 5, remaining: 0 });
    const res = mkRes();
    await controller.streamQuery(mkReq(), res, jest.fn());
    await flush();
    expect(events(res).find((e: any) => e.type === 'error')).toBeUndefined();
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'thinking', routing: { level: 'thinking', reasonKey: 'quota_exhausted' } });
    const row = mockRecordMetric.mock.calls.map((c: any[]) => c[0]).find((r: any) => r?.kind === 'deep_research_quota_rejected');
    expect(row?.meta).toMatchObject({ demoted: true, autoRouted: true, lane: 'research', laneSource: 'turn_plan' });
  });

  it('a keyword Level 3 the turn plan retired runs Ensemble with NO reserve', async () => {
    mockRoute.mockImplementation(async () => heuristicRoute('deep_research', 'research_requested'));
    mockRouteResearch.mockImplementation(async (i: any) => ({
      mode: 'thinking', routingSource: 'auto_turn_plan', turnPlan: TURN_PLAN, route: 'keyword_retired', why: 'lane standard',
      routing: { ...i.routing, level: 'thinking', reasonKey: 'turn_plan_lane', source: 'turn_plan', reason: 'retired' },
    }));
    await controller.streamQuery(mkReq(), mkRes(), jest.fn());
    await flush();
    expect(mockRouteResearch.mock.calls[0][0]).toMatchObject({ mode: 'deep_research', routing: { reasonKey: 'research_requested' } });
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'thinking', routing: { reasonKey: 'turn_plan_lane' } });
  });

  it('fails OPEN: a throwing route keeps the router\'s level (a keyword Level 3 still reserves and runs the council)', async () => {
    mockRoute.mockImplementation(async () => heuristicRoute('deep_research', 'research_requested'));
    mockRouteResearch.mockImplementation(async () => { throw new Error('boom'); });
    const res = mkRes();
    await controller.streamQuery(mkReq(), res, jest.fn());
    await flush();
    expect(mockReserve).toHaveBeenCalledWith('u1');
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'deep_research' });
    expect(events(res).find((e: any) => e.type === 'error')).toBeUndefined();
  });

  // integ/ghost-composer review fix (2026-10-22): the route asks the CLOUD turn plan with the message + prior turns
  // before the run, so it must know the turn is ghost — the row's stored flag (read with the chat row), else the
  // per-send opt-in of a chatId-less send (guests / the createChat-failure fallback).
  it('GHOST: a ghost chat row hands ghost:true to the route; a normal row ghost:false (a stale per-send flag never wins over the row)', async () => {
    mockFindChat.mockResolvedValue({ id: CHAT, userId: 'u1', projectId: null, title: 't', isSupervisor: false, isProjectSupervisor: false, ghostMode: true });
    await controller.streamQuery(mkReq(), mkRes(), jest.fn());
    await flush();
    expect(mockFindChat.mock.calls[0][0].select).toMatchObject({ ghostMode: true });
    expect(mockRouteResearch.mock.calls[0][0]).toMatchObject({ ghost: true });
    mockFindChat.mockResolvedValue({ id: CHAT, userId: 'u1', projectId: null, title: 't', isSupervisor: false, isProjectSupervisor: false, ghostMode: false });
    await controller.streamQuery(mkReq({ query: { message: 'Explain the history of Quebec sovereignty', mode: 'auto', chatId: CHAT, ghost: true } }), mkRes(), jest.fn());
    await flush();
    expect(mockRouteResearch.mock.calls[1][0]).toMatchObject({ ghost: false });
  });

  it('GHOST: a chatId-less send carries its per-send opt-in to the route', async () => {
    // (the route's zod schema coerces the wire 'true' to a boolean before the handler — the harness skips zod)
    await controller.streamQuery(mkReq({ query: { message: 'Explain the history of Quebec sovereignty', mode: 'auto', ghost: true } }), mkRes(), jest.fn());
    await flush();
    expect(mockRouteResearch).toHaveBeenCalledTimes(1);
    expect(mockRouteResearch.mock.calls[0][0]).toMatchObject({ chatId: null, ghost: true });
  });

  it('an explicit level (not Auto-routed) and a Dig-deeper tap are never re-routed', async () => {
    await controller.streamQuery(mkReq({ query: { message: 'x', mode: 'thinking', chatId: CHAT } }), mkRes(), jest.fn());
    await flush();
    expect(mockRouteResearch).not.toHaveBeenCalled();
    mockFindMessage.mockResolvedValue({ id: MSG, chatId: CHAT, role: 'assistant', metadata: { mode: 'single_thinking' }, createdAt: new Date() });
    mockFindFirstMessage.mockResolvedValue({ content: 'the original question' });
    await controller.streamQuery(mkReq({ query: { message: 'x', mode: 'auto', chatId: CHAT, escalationOf: MSG } }), mkRes(), jest.fn());
    await flush();
    expect(mockRouteResearch).not.toHaveBeenCalled();
  });
});

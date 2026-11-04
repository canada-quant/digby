/**
 * streamQuery × patience plan Phase 1a (2026-09-25; switch OFF by default):
 *   1. LABEL WINDOW — a signed-in adult's PICKED level (modeSource 'picked')
 *      in a non-supervisor chat fires shadowAutoRouteAgainst (non-blocking,
 *      after the send is admitted) with actual = the level; every explicit
 *      level stamps routingSource into the run. Unsignalled / default levels,
 *      guests, kids, supervisor chats and refused sends never fire it.
 *   2. mode='auto' → routeMessageAuto; routing (reasonKey/source) + routingSource
 *      'auto_<source>' ride into startDetachedChatRun.
 *   3. patience_auto_only ON → an explicit level is routed as Auto with
 *      requestedMode kept; the allowance (fail-closed, guests off L3) flows
 *      into routeMessageAuto; the label window does NOT fire.
 *   4. quota refusal writes a deep_research_quota_rejected row; under the
 *      switch a refused reserve DEMOTES to Ensemble instead of erroring.
 * Harness: crossmodel.controller.guest-session.test.ts (mocked import graph;
 * startDetachedChatRun is the sink; subscribeRun false ends the response).
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));

const mockFindUser = jest.fn();
const mockFindChat = jest.fn();
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    user: { findUnique: (...a: any[]) => mockFindUser(...a) },
    crossModelChat: { findUnique: (...a: any[]) => mockFindChat(...a) },
    crossModelMessage: { findMany: jest.fn() },
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
  // audit 2026-09-26: the honoured-preset kill switch reads the env at call time (real implementation)
  parsePatienceSwitchValue: jest.fn(), setPatienceAutoOnly: jest.fn(), getPatienceAutoOnlyState: jest.fn(),
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
const mockShadow: jest.Mock = jest.fn(async () => {});
const mockRoute: jest.Mock = jest.fn();
jest.mock('./platform/auto-router-gate', () => ({
  ...jest.requireActual('./platform/auto-router-gate'),
  shadowAutoRouteAgainst: (...a: any[]) => mockShadow(...a),
  routeMessageAuto: (...a: any[]) => mockRoute(...a),
}));
const mockStartDetachedChatRun: jest.Mock = jest.fn();
jest.mock('./chat-agent/chat-agent.service', () => ({
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatAgentRunKey: jest.fn(() => 'agent-key'),
}));
// subscribeRun → null: the run "ended in the same tick" (the response ends
// cleanly; `false` would trip `unsubChat?.()` — optional chaining only guards
// null/undefined — and surface a spurious error frame).
jest.mock('./coding/live-runs', () => ({ isRunActive: jest.fn(() => false), subscribeRun: jest.fn(() => null) }));

import controller from './crossmodel.controller';

const CHAT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const mkReq = (over: any = {}): any => ({ query: { message: 'What is the capital of France?', mode: 'thinking' }, headers: {}, on: jest.fn(), ...over });
const mkRes = (): any => {
  const res: any = {
    frames: [] as string[], writableEnded: false,
    status: jest.fn(() => res), json: jest.fn(() => res), setHeader: jest.fn(), flushHeaders: jest.fn(), cookie: jest.fn(),
    write: jest.fn((chunk: string) => { res.frames.push(chunk); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
  };
  return res;
};
const events = (res: any) => res.frames.map((f: string) => JSON.parse(f.replace(/^data: /, '')));
const flush = () => new Promise(r => setImmediate(r));
const heuristicRoute = (level: string) => ({ level, reason: 'default ensemble', reasonKey: 'default_ensemble', suggestCode: false, needsWorkspace: false, source: 'heuristic', heuristicLevel: level });

beforeEach(() => {
  delete process.env.PATIENCE_AUTO_ONLY_HONOUR_PRESET;
  jest.clearAllMocks();
  mockDecideChatGate.mockImplementation(({ mode }: any) => ({ action: 'agent', councilMode: mode === 'deep_research' }));
  mockFindUser.mockResolvedValue({ isChild: false });
  mockFindChat.mockResolvedValue({ id: CHAT, userId: 'u1', projectId: null, title: 't', isSupervisor: false, isProjectSupervisor: false });
  mockStartDetachedChatRun.mockResolvedValue('run-key-1');
  mockAutoOnly.mockResolvedValue(false);
  mockAllowance.mockResolvedValue({ allowed: true });
  mockReserve.mockResolvedValue({ allowed: true, used: 1, limit: 5, remaining: 4 });
  mockReserveAnon.mockResolvedValue({ allowed: true, used: 1, limit: 2, remaining: 1 });
  mockRoute.mockImplementation(async () => heuristicRoute('thinking'));
});

describe('label window (explicit level, switch off)', () => {
  it('signed-in explicit level WITHOUT modeSource: no label-window call (not a human label — §4.2 only picked counts); routingSource user_explicit still rides into the run', async () => {
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' } }), res, jest.fn());
    await flush();
    expect(mockShadow).not.toHaveBeenCalled();
    expect(mockRoute).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'thinking', routingSource: 'user_explicit' });
    expect(mockStartDetachedChatRun.mock.calls[0][0].routing).toBeUndefined();
  });

  it("modeSource=default / restored → routingSource user_default, no label-window call", async () => {
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'thinking', modeSource: 'default' } }), mkRes(), jest.fn());
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'thinking', modeSource: 'restored' } }), mkRes(), jest.fn());
    await flush();
    expect(mockShadow).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ routingSource: 'user_default' });
    expect(mockStartDetachedChatRun.mock.calls[1][0]).toMatchObject({ routingSource: 'user_default' });
  });

  it("modeSource=picked → shadowAutoRouteAgainst fires with actual = the level (note user_picked; routingSource 'user_picked'); the send is unchanged", async () => {
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'deep_research', modeSource: 'picked' } }), res, jest.fn());
    await flush();
    expect(mockShadow).toHaveBeenCalledTimes(1);
    expect(mockShadow.mock.calls[0][0]).toMatchObject({ content: 'Hello', hasWorkspace: false });
    expect(mockShadow.mock.calls[0][1]).toBe('deep_research');
    expect(mockShadow.mock.calls[0][2]).toMatchObject({ modeSource: 'picked', segment: 'user' });
    expect(mockRoute).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'deep_research', routingSource: 'user_picked' });
  });

  it('a picked Level 3 REFUSED on quota never fires the label window (the row would have labelled a send that did not happen)', async () => {
    mockReserve.mockResolvedValue({ allowed: false, used: 5, limit: 5, remaining: 0 });
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'deep_research', modeSource: 'picked' } }), res, jest.fn());
    await flush();
    expect(events(res).find((e: any) => e.type === 'error')?.data).toMatchObject({ code: 'RATE_LIMIT_DEEP_RESEARCH' });
    expect(mockShadow).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
  });

  it('guests never reach the label window (and get no routingSource)', async () => {
    const res = mkRes();
    await controller.streamQuery(mkReq({ query: { message: 'Hello', mode: 'thinking', modeSource: 'picked' } }), res, jest.fn());
    await flush();
    expect(mockShadow).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun.mock.calls[0][0].routingSource).toBeUndefined();
  });

  it('kids never reach the label window nor the router', async () => {
    mockFindUser.mockResolvedValue({ isChild: true, childAge: 9, childGuardrails: null });
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'kid' }, query: { message: 'Hello', mode: 'auto' } }), res, jest.fn());
    await controller.streamQuery(mkReq({ user: { id: 'kid' }, query: { message: 'Hello', mode: 'thinking', modeSource: 'picked' } }), mkRes(), jest.fn());
    await flush();
    expect(mockShadow).not.toHaveBeenCalled();
    expect(mockRoute).not.toHaveBeenCalled();
    expect(events(res)[0]).toMatchObject({ type: 'init', data: { mode: 'kids' } });
  });

  it('supervisor chats are excluded (their level is the stored thinking, never a label)', async () => {
    mockFindChat.mockResolvedValue({ id: CHAT, userId: 'u1', projectId: null, title: 't', isSupervisor: true, isProjectSupervisor: false });
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'thinking', chatId: CHAT, modeSource: 'picked' } }), res, jest.fn());
    await flush();
    expect(mockShadow).not.toHaveBeenCalled();
  });
});

describe("mode='auto'", () => {
  it('routes through routeMessageAuto; routing carries reasonKey/source and routingSource is auto_<source>; the allowance is probed on EVERY auto send (audit 2026-09-26 routing-unify-1 — not only under the switch)', async () => {
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'auto' } }), res, jest.fn());
    expect(mockRoute).toHaveBeenCalledTimes(1);
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ content: 'Hello', hasWorkspace: false, allowDeepResearch: true, segment: 'user' });
    expect(mockAllowance).toHaveBeenCalledTimes(1);
    expect(mockAllowance.mock.calls[0][0]).toMatchObject({ userId: 'u1', strict: true });
    expect(mockShadow).not.toHaveBeenCalled();
    const args = mockStartDetachedChatRun.mock.calls[0][0];
    expect(args).toMatchObject({ mode: 'thinking', routingSource: 'auto_heuristic', routing: { level: 'thinking', reasonKey: 'default_ensemble', source: 'heuristic' } });
    expect(events(res).find((e: any) => e.type === 'routing')?.data).toMatchObject({ level: 'thinking', reasonKey: 'default_ensemble' });
  });

  it('an exhausted allowance clamps the router BEFORE the pick (allowDeepResearch:false, quota_exhausted) — the default signed-in web send never hard-errors on quota', async () => {
    mockAllowance.mockResolvedValue({ allowed: false, reasonKey: 'quota_exhausted' });
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Please research the market for X', mode: 'auto' } }), mkRes(), jest.fn());
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ allowDeepResearch: false, allowDeepResearchReason: 'quota_exhausted' });
  });

  it('routing-unify-1: an Auto-routed Level 3 that LOSES the reserve race demotes to Ensemble with the switch OFF too (metric autoRouted:true, demoted:true, no error frame)', async () => {
    mockRoute.mockImplementation(async () => heuristicRoute('deep_research'));
    mockReserve.mockResolvedValue({ allowed: false, used: 5, limit: 5, remaining: 0 });
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'research this', mode: 'auto' } }), res, jest.fn());
    const ev = events(res);
    expect(ev.find((e: any) => e.type === 'error')).toBeUndefined();
    const routings = ev.filter((e: any) => e.type === 'routing');
    expect(routings[routings.length - 1].data).toMatchObject({ level: 'thinking', reasonKey: 'quota_exhausted', clamped: 'quota' });
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'thinking', routing: { level: 'thinking', clamped: 'quota' } });
    const row = mockRecordMetric.mock.calls.find((c: any[]) => c[0].kind === 'deep_research_quota_rejected')?.[0];
    expect(row.meta).toMatchObject({ scope: 'user', mode: 'deep_research', autoOnly: false, autoRouted: true, demoted: true });
  });

  it('supervisors-auto-2: a HUMAN mode=auto send into a supervisor chat is routed with allowDeepResearch:false (supervisor_no_research) and segment supervisor — never the council on a supervisor lane; no allowance probe, no error', async () => {
    mockFindChat.mockResolvedValue({ id: CHAT, userId: 'u1', projectId: null, title: 't', isSupervisor: true, isProjectSupervisor: false });
    mockRoute.mockImplementation(async (i: any) => (i.allowDeepResearch === false ? { ...heuristicRoute('thinking'), clamped: 'supervisor', reasonKey: 'supervisor_no_research' } : heuristicRoute('deep_research')));
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Please research the market for X', mode: 'auto', chatId: CHAT } }), res, jest.fn());
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ allowDeepResearch: false, allowDeepResearchReason: 'supervisor_no_research', segment: 'supervisor' });
    expect(mockAllowance).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
    expect(events(res).find((e: any) => e.type === 'error')).toBeUndefined();
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'thinking' });
  });

  it('an EXPLICIT deep_research into a supervisor chat is floored to thinking (supervisor_no_research); SUPERVISOR_AUTO_RESEARCH_ENABLED=1 restores it', async () => {
    mockFindChat.mockResolvedValue({ id: CHAT, userId: 'u1', projectId: null, title: 't', isSupervisor: false, isProjectSupervisor: true });
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'go deep', mode: 'deep_research', chatId: CHAT } }), mkRes(), jest.fn());
    expect(mockRoute).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'thinking', routing: { level: 'thinking', reasonKey: 'supervisor_no_research', clamped: 'supervisor', requestedMode: 'deep_research' } });
    process.env.SUPERVISOR_AUTO_RESEARCH_ENABLED = '1';
    try {
      await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'go deep', mode: 'deep_research', chatId: CHAT } }), mkRes(), jest.fn());
      expect(mockStartDetachedChatRun.mock.calls[1][0]).toMatchObject({ mode: 'deep_research' });
    } finally { delete process.env.SUPERVISOR_AUTO_RESEARCH_ENABLED; }
  });
});

describe('patience_auto_only switch ON', () => {
  it('an explicit level is routed as Auto with requestedMode kept (also on the router ask); the strict allowance flows into the router; a PICKED level still feeds the label window once admitted (audit 2026-09-26 settings-switches-4 option A)', async () => {
    mockAutoOnly.mockResolvedValue(true);
    mockAllowance.mockResolvedValue({ allowed: false, reasonKey: 'quota_exhausted' });
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'deep_research', modeSource: 'picked' } }), res, jest.fn());
    await flush();
    expect(mockRoute).toHaveBeenCalledTimes(1);
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ allowDeepResearch: false, allowDeepResearchReason: 'quota_exhausted', modeSource: 'picked', segment: 'user', requestedMode: 'deep_research' });
    expect(mockAllowance.mock.calls[0][0]).toMatchObject({ userId: 'u1', strict: true });
    expect(mockShadow).toHaveBeenCalledTimes(1);
    expect(mockShadow.mock.calls[0][1]).toBe('deep_research');
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'thinking', routingSource: 'auto_heuristic', routing: { requestedMode: 'deep_research', modeSource: 'picked' } });
  });

  // Audit 2026-09-26; since c99b404a (2026-10-27) the sender is a REST / API
  // caller (the Advanced tab that stored web presets is gone): a stored client
  // preset rides as {mode: preset, modeSource:'default'} — under the switch it
  // is routed as Auto like every other human send, the preset kept ONLY as
  // routing.requestedMode. No label window: 'default' is not a human pick.
  it("a stored client preset (modeSource 'default') from a signed-in user is routed as Auto with requestedMode kept", async () => {
    mockAutoOnly.mockResolvedValue(true);
    mockAllowance.mockResolvedValue({ allowed: true });
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'thinking', modeSource: 'default' } }), res, jest.fn());
    expect(mockRoute).toHaveBeenCalledTimes(1);
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ allowDeepResearch: true, modeSource: 'default', segment: 'user' });
    expect(mockShadow).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'thinking', routingSource: 'auto_heuristic', routing: { level: 'thinking', requestedMode: 'thinking', modeSource: 'default' } });
  });

  it("PATIENCE_AUTO_ONLY_HONOUR_PRESET=1 (opt-in): a SIGNED-IN stored client preset (modeSource 'default') keeps its level under the switch: no router, routingSource user_default, no requestedMode, no label window", async () => {
    process.env.PATIENCE_AUTO_ONLY_HONOUR_PRESET = '1';
    mockAutoOnly.mockResolvedValue(true);
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'deep_research', modeSource: 'default' } }), res, jest.fn());
    expect(mockRoute).not.toHaveBeenCalled();
    expect(mockAllowance).not.toHaveBeenCalled();
    expect(mockShadow).not.toHaveBeenCalled();
    const args = mockStartDetachedChatRun.mock.calls[0][0];
    expect(args).toMatchObject({ mode: 'deep_research', routingSource: 'user_default' });
    expect(args.routing).toBeUndefined();
    expect(events(res).find((e: any) => e.type === 'routing')).toBeUndefined();
  });

  it("the opt-in is narrow: a guest's forced Ensemble ('default', no userId) and a legacy-picker 'picked' / 'restored' send are still routed as Auto", async () => {
    process.env.PATIENCE_AUTO_ONLY_HONOUR_PRESET = '1';
    mockAutoOnly.mockResolvedValue(true);
    mockAllowance.mockResolvedValue({ allowed: true });
    await controller.streamQuery(mkReq({ query: { message: 'Hello', mode: 'thinking', modeSource: 'default' } }), mkRes(), jest.fn());
    expect(mockRoute).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ routingSource: 'auto_heuristic', routing: { requestedMode: 'thinking', modeSource: 'default' } });
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'thinking', modeSource: 'restored' } }), mkRes(), jest.fn());
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'thinking', modeSource: 'picked' } }), mkRes(), jest.fn());
    expect(mockRoute).toHaveBeenCalledTimes(3);
    expect(mockStartDetachedChatRun.mock.calls[1][0]).toMatchObject({ routing: { requestedMode: 'thinking', modeSource: 'restored' } });
    expect(mockStartDetachedChatRun.mock.calls[2][0]).toMatchObject({ routing: { requestedMode: 'thinking', modeSource: 'picked' } });
  });

  it('guests are routed too, with the guest allowance (off Level 3 until proven)', async () => {
    mockAutoOnly.mockResolvedValue(true);
    mockAllowance.mockResolvedValue({ allowed: false, reasonKey: 'guest_no_research' });
    const res = mkRes();
    await controller.streamQuery(mkReq({ query: { message: 'Hello', mode: 'thinking' } }), res, jest.fn());
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ allowDeepResearch: false, allowDeepResearchReason: 'guest_no_research', segment: 'guest' });
    expect(mockAllowance.mock.calls[0][0]).toMatchObject({ userId: undefined, strict: true });
  });

  it('kids and supervisor chats are never routed under the switch; browser_agent is untouched', async () => {
    mockAutoOnly.mockResolvedValue(true);
    mockFindChat.mockResolvedValue({ id: CHAT, userId: 'u1', projectId: null, title: 't', isSupervisor: false, isProjectSupervisor: true });
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'thinking', chatId: CHAT } }), mkRes(), jest.fn());
    expect(mockRoute).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'thinking' });
    mockFindUser.mockResolvedValue({ isChild: true, childAge: 9, childGuardrails: null });
    await controller.streamQuery(mkReq({ user: { id: 'kid' }, query: { message: 'Hello', mode: 'thinking' } }), mkRes(), jest.fn());
    expect(mockRoute).not.toHaveBeenCalled();
    expect(mockAutoOnly).not.toHaveBeenCalled(); // neither the supervisor-chat send nor the kid send consulted the switch
  });

  it('a refused reserve after an Auto Level 3 pick DEMOTES to Ensemble (routing rewritten, metric demoted:true, no error)', async () => {
    mockAutoOnly.mockResolvedValue(true);
    mockRoute.mockImplementation(async () => heuristicRoute('deep_research'));
    mockReserve.mockResolvedValue({ allowed: false, used: 5, limit: 5, remaining: 0 });
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'research this', mode: 'thinking' } }), res, jest.fn());
    const ev = events(res);
    expect(ev.find((e: any) => e.type === 'error')).toBeUndefined();
    const routings = ev.filter((e: any) => e.type === 'routing');
    expect(routings[routings.length - 1].data).toMatchObject({ level: 'thinking', reasonKey: 'quota_exhausted', clamped: 'quota' });
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'thinking', routing: { level: 'thinking', clamped: 'quota' } });
    const row = mockRecordMetric.mock.calls.find((c: any[]) => c[0].kind === 'deep_research_quota_rejected')?.[0];
    expect(row.meta).toMatchObject({ scope: 'user', anon: false, mode: 'deep_research', autoOnly: true, demoted: true, limit: 5, used: 5 });
  });
});

describe('deep_research_quota_rejected telemetry (switch off)', () => {
  it('a signed-in explicit Level 3 refused on quota writes the row and still errors as before', async () => {
    mockReserve.mockResolvedValue({ allowed: false, used: 5, limit: 5, remaining: 0 });
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'deep_research' } }), res, jest.fn());
    expect(events(res).find((e: any) => e.type === 'error')?.data).toMatchObject({ code: 'RATE_LIMIT_DEEP_RESEARCH' });
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    const row = mockRecordMetric.mock.calls.find((c: any[]) => c[0].kind === 'deep_research_quota_rejected')?.[0];
    expect(row.meta).toMatchObject({ scope: 'user', anon: false, mode: 'deep_research', routingSource: 'user_explicit', autoOnly: false, demoted: false });
  });
  it('a guest refusal is scope anon', async () => {
    mockReserveAnon.mockResolvedValue({ allowed: false, used: 2, limit: 2, remaining: 0 });
    const res = mkRes();
    await controller.streamQuery(mkReq({ query: { message: 'Hello', mode: 'deep_research' } }), res, jest.fn());
    expect(events(res).find((e: any) => e.type === 'error')?.data).toMatchObject({ code: 'RATE_LIMIT_DEEP_RESEARCH_GUEST' });
    const row = mockRecordMetric.mock.calls.find((c: any[]) => c[0].kind === 'deep_research_quota_rejected')?.[0];
    expect(row.meta).toMatchObject({ scope: 'anon', anon: true });
  });
});

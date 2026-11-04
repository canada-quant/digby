/**
 * streamQuery × compute policy (branch cp/harness, 2026-09-26):
 *   1. EARLY FLUSH — the SSE headers flush BEFORE the Auto router await
 *      (design §5 step 0), idempotently (one flushHeaders per request, the attachment-fatal path
 *      included).
 *   2. DIG DEEPER — escalationOf resolves the NEXT rung not yet spent on the
 *      message (verify → research), re-runs the ORIGINAL question with the
 *      `escalation` arg (never a new user turn, never the router / label
 *      window), refuses guests (SIGNIN_DEEPER), kids, foreign / non-assistant
 *      rows, an exhausted message, an over-budget message and
 *      DIG_DEEPER_DISABLED=1 — all as plain SSE 'error' frames; the tap writes
 *      the message's `escalated` label; a research rung reserves the council
 *      quota like any Level 3 send.
 *   3. THE BEACON — POST /ux/beacon records one ux_beacon row; UX_BEACON_DISABLED=1 → 204, nothing.
 *   4. VALIDATION — escalationOf must be a uuid.
 * Harness: crossmodel.controller.label-window.test.ts (mocked import graph;
 * startDetachedChatRun is the sink; subscribeRun null ends the response).
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
  // the busy branch: a user turn never preempts a user run; nothing to nudge
  preemptMachineRunForUserMessage: jest.fn(async () => ({ preempted: false, freed: false })),
  nudgeQueueDrainSoon: jest.fn(),
}));
jest.mock('./message-as-answer', () => ({ resolveParkedQuestionWithOwnerText: jest.fn(async () => ({ resolved: false })) }));
jest.mock('./coding/live-runs', () => ({ isRunActive: jest.fn(() => false), subscribeRun: jest.fn(() => null) }));
const mockLabelEscalated: jest.Mock = jest.fn(() => 'escalated');
const mockLabelRevisionFromMeta: jest.Mock = jest.fn(() => false);
jest.mock('./chat-agent/compute-policy-labels', () => ({
  __esModule: true,
  labelComputePolicyEscalated: (...a: any[]) => mockLabelEscalated(...a),
  // cp/labels: a tap on an 'updated' row also labels revision_material; the facts ride from metadata.depth.facts.
  labelRevisionMaterialFromMetadata: (...a: any[]) => mockLabelRevisionFromMeta(...a),
  // audit drafts-agree-label-semantics: a tap on an acted (skipped-reconcile) row labels drafts_agree too.
  labelDraftsAgreeFromMetadata: jest.fn(() => false),
  factsFromDepthMetadata: (meta: any) => (meta?.depth?.facts ?? null),
}));

import controller from './crossmodel.controller';
import * as chatGateMock from './chat-agent/chat-gate';
import { streamQuerySchema, uxBeaconSchema } from './crossmodel.validation';

const CHAT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const MSG = '9b2e7c1a-2d3f-4e5a-8b6c-1d2e3f4a5b6c';
const mkReq = (over: any = {}): any => ({ query: { message: 'What is the capital of France?', mode: 'thinking' }, headers: {}, on: jest.fn(), ...over });
const mkRes = (): any => {
  const res: any = {
    frames: [] as string[], writableEnded: false, calls: [] as string[],
    status: jest.fn(() => res), json: jest.fn(() => res), setHeader: jest.fn(), cookie: jest.fn(),
    flushHeaders: jest.fn(() => { res.calls.push('flushHeaders'); }),
    write: jest.fn((chunk: string) => { res.frames.push(chunk); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
  };
  return res;
};
const events = (res: any) => res.frames.filter((f: string) => f.startsWith('data: ')).map((f: string) => JSON.parse(f.replace(/^data: /, '')));
const flush = () => new Promise(r => setImmediate(r));
const heuristicRoute = (level: string) => ({ level, reason: 'default ensemble', reasonKey: 'default_ensemble', suggestCode: false, needsWorkspace: false, source: 'heuristic', heuristicLevel: level });
const ORIGINAL_Q = 'How much does the plan cost per month?';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DIG_DEEPER_DISABLED;
  delete process.env.UX_BEACON_DISABLED;
  mockDecideChatGate.mockImplementation(({ mode }: any) => ({ action: 'agent', councilMode: mode === 'deep_research' }));
  mockFindUser.mockResolvedValue({ isChild: false });
  mockFindChat.mockResolvedValue({ id: CHAT, userId: 'u1', projectId: null, title: 't', isSupervisor: false, isProjectSupervisor: false });
  mockStartDetachedChatRun.mockResolvedValue('run-key-1');
  mockAutoOnly.mockResolvedValue(false);
  mockAllowance.mockResolvedValue({ allowed: true });
  mockReserve.mockResolvedValue({ allowed: true, used: 1, limit: 5, remaining: 4 });
  mockReserveAnon.mockResolvedValue({ allowed: true, used: 1, limit: 2, remaining: 1 });
  mockRoute.mockImplementation(async () => { return heuristicRoute('thinking'); });
  mockFindMessage.mockResolvedValue(null);
  mockFindFirstMessage.mockResolvedValue({ content: ORIGINAL_Q });
});

describe('early header flush (design §5 step 0)', () => {
  it('mode=auto: flushHeaders runs BEFORE routeMessageAuto is awaited, exactly once for the request', async () => {
    const res = mkRes();
    let flushedWhenRouted = false;
    mockRoute.mockImplementation(async () => { flushedWhenRouted = res.calls.includes('flushHeaders'); return heuristicRoute('thinking'); });
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'auto', chatId: CHAT } }), res, jest.fn());
    await flush();
    expect(mockRoute).toHaveBeenCalledTimes(1);
    expect(flushedWhenRouted).toBe(true);
    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
  });

  it('a guest send sets the session cookie before the flush', async () => {
    const res = mkRes();
    await controller.streamQuery(mkReq({ query: { message: 'Hello', mode: 'thinking' }, cookies: {} }), res, jest.fn());
    await flush();
    expect(res.cookie).toHaveBeenCalledWith('cm_session', expect.any(String), expect.objectContaining({ httpOnly: true }));
    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
  });

  it('a bare/undefined message still 400s as JSON (the guard runs before the flush)', async () => {
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'undefined', mode: 'thinking' } }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });
});

describe('Dig deeper — escalationOf', () => {
  const assistantRow = (metadata: any, createdAt = new Date()) => ({ id: MSG, chatId: CHAT, role: 'assistant', metadata, createdAt });

  it('an unchecked (L1) answer → the VERIFY rung: mode thinking, the ORIGINAL question, escalation {ofMessageId, rung verify}, routingSource escalation, no router, no label window, the escalated label written', async () => {
    mockFindMessage.mockResolvedValue(assistantRow({ mode: 'single_thinking', depth: { plan: { preset: 'single_thinking', spawnChecker: false }, decision: { id: 'cp-9', answers: { depth: { type: 'choice', choice: 'ordinary', confidence: 0.6, probabilities: {} } }, mode: 'shadow' } } }));
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Dig deeper', mode: 'auto', chatId: CHAT, escalationOf: MSG, modeSource: 'picked' } }), res, jest.fn());
    await flush();
    expect(mockRoute).not.toHaveBeenCalled();
    expect(mockShadow).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'thinking', message: ORIGINAL_Q, chatId: CHAT, escalation: { ofMessageId: MSG, rung: 'verify' }, routingSource: 'escalation' });
    expect(mockStartDetachedChatRun.mock.calls[0][0].routing).toBeUndefined();
    expect(mockLabelEscalated).toHaveBeenCalledTimes(1);
    expect(mockLabelEscalated.mock.calls[0][0]).toMatchObject({ rung: 'verify', sessionId: CHAT, decisionStash: { id: 'cp-9' } });
    expect(mockReserve).not.toHaveBeenCalled(); // verify is not a council rung
  });

  it('audit 2026-10-03: a tap on a chat the caller cannot WRITE is refused before the answer row is read or any label is written', async () => {
    (chatGateMock.chatWriteAccessGranted as jest.Mock).mockReturnValueOnce(false);
    mockFindMessage.mockResolvedValue(assistantRow({ mode: 'single_thinking' }));
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'stranger' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), res, jest.fn());
    await flush();
    expect(events(res).find((e: any) => e.type === 'error')?.data.code).toBe('ESCALATION_NOT_FOUND');
    expect(mockFindMessage).not.toHaveBeenCalled();
    expect(mockFindFirstMessage).not.toHaveBeenCalled();
    expect(mockLabelEscalated).not.toHaveBeenCalled();
    expect(mockLabelRevisionFromMeta).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
  });

  it('audit 2026-10-03: a hand-built tap on a SUPERVISOR chat is refused (the chip is never offered there; the run-level clamp does not cover a rung)', async () => {
    mockFindChat.mockResolvedValue({ id: CHAT, userId: 'u1', projectId: null, title: 't', isSupervisor: false, isProjectSupervisor: true });
    mockFindMessage.mockResolvedValue(assistantRow({ mode: 'thinking' }));
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), res, jest.fn());
    await flush();
    expect(events(res).find((e: any) => e.type === 'error')?.data.code).toBe('ESCALATION_SUPERVISOR');
    expect(mockLabelEscalated).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
  });

  it('a checked (L2) answer → the RESEARCH rung: mode deep_research, the council quota is reserved like any Level 3 send', async () => {
    mockFindMessage.mockResolvedValue(assistantRow({ mode: 'thinking' }));
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: '', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), res, jest.fn());
    await flush();
    expect(mockReserve).toHaveBeenCalledWith('u1');
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'deep_research', escalation: { ofMessageId: MSG, rung: 'research' }, message: ORIGINAL_Q });
  });

  it('audit 2026-09-26 (routing-unify-2): a research-rung tap on an EXHAUSTED allowance is refused BEFORE the label / mode rewrite with ESCALATION_QUOTA (the plain "deeper looks left" message), no run, no label', async () => {
    mockFindMessage.mockResolvedValue(assistantRow({ mode: 'thinking' }));
    mockAllowance.mockResolvedValue({ allowed: false, reasonKey: 'quota_exhausted', remaining: 0, limit: 5 });
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), res, jest.fn());
    await flush();
    const err = events(res).find((e: any) => e.type === 'error');
    expect(err?.data.code).toBe('ESCALATION_QUOTA');
    expect(err?.data.message).toContain('No deeper looks left today (0 of 5');
    expect(mockAllowance).toHaveBeenCalledWith({ userId: 'u1', strict: true });
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockLabelEscalated).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    // a VERIFY rung never consults the allowance (no council)
    mockFindMessage.mockResolvedValue(assistantRow({ mode: 'single_thinking' }));
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), mkRes(), jest.fn());
    await flush();
    expect(mockAllowance).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
  });

  it('a research-rung tap that passed the allowance but LOSES the reserve race is still refused (RATE_LIMIT_DEEP_RESEARCH), no run starts', async () => {
    mockFindMessage.mockResolvedValue(assistantRow({ mode: 'thinking' }));
    mockReserve.mockResolvedValue({ allowed: false, used: 5, limit: 5, remaining: 0 });
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), res, jest.fn());
    await flush();
    expect(events(res).find((e: any) => e.type === 'error')?.data.code).toBe('RATE_LIMIT_DEEP_RESEARCH');
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
  });

  it.each([
    ['a guest', { query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }, 'SIGNIN_DEEPER'],
    ['a kid account', { user: { id: 'k1' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG }, kid: true }, 'SIGNIN_DEEPER'],
    ['no chatId', { user: { id: 'u1' }, query: { message: 'x', mode: 'thinking', escalationOf: MSG } }, 'ESCALATION_NO_CHAT'],
  ])('%s → refused with an SSE error frame, no run', async (_label, over: any, code) => {
    if (over.kid) mockFindUser.mockResolvedValue({ isChild: true, childAge: 9 });
    mockFindMessage.mockResolvedValue(assistantRow({ mode: 'thinking' }));
    const res = mkRes();
    await controller.streamQuery(mkReq(over), res, jest.fn());
    await flush();
    const err = events(res).find((e: any) => e.type === 'error');
    expect(err?.data.code).toBe(code);
    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
    expect(res.writableEnded).toBe(true);
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(mockLabelEscalated).not.toHaveBeenCalled();
  });

  it('a row in ANOTHER chat / a user row / a missing row → ESCALATION_NOT_FOUND', async () => {
    for (const row of [null, { ...assistantRow({ mode: 'thinking' }), chatId: 'other' }, { ...assistantRow({ mode: 'thinking' }), role: 'user' }]) {
      mockFindMessage.mockResolvedValue(row);
      const res = mkRes();
      await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), res, jest.fn());
      await flush();
      expect(events(res).find((e: any) => e.type === 'error')?.data.code).toBe('ESCALATION_NOT_FOUND');
    }
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
  });

  it('an exhausted message (council answer / research already run / a deeper-findings row) → ESCALATION_EXHAUSTED', async () => {
    for (const meta of [{ mode: 'deep_research' }, { mode: 'thinking', depth: { plan: { preset: 'thinking', spawnChecker: true }, escalations: [{ rung: 'research', at: 'x' }] } }, { kind: 'deeper_findings', mode: 'thinking' }]) {
      mockFindMessage.mockResolvedValue(assistantRow(meta));
      const res = mkRes();
      await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), res, jest.fn());
      await flush();
      expect(events(res).find((e: any) => e.type === 'error')?.data.code).toBe('ESCALATION_EXHAUSTED');
    }
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
  });

  it('REGRESSION PIN (owner 2026-09-27, no hidden cost caps): a message whose cumulative spend is past the OLD $0.25 bound — finalize spend PLUS a spent rung, with a legacy `budget.maxUsd` stamped on the row — is NEVER refused on cost; the next rung runs', async () => {
    mockFindMessage.mockResolvedValue(assistantRow({ mode: 'single_thinking', depth: { plan: { preset: 'single_thinking', spawnChecker: false }, budget: { maxUsd: 0.25 }, spentUsd: 0.12, escalations: [{ rung: 'verify', at: 't', status: 'done', messageId: 'v1', spentUsd: 0.14 }] } }));
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), res, jest.fn());
    await flush();
    expect(events(res).find((e: any) => e.type === 'error')).toBeUndefined();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ escalation: { ofMessageId: MSG, rung: 'research' } });
  });

  it('audit 2026-09-26 (routing-unify-4): a rung still RUNNING on the message refuses a second tap (ESCALATION_EXHAUSTED) instead of re-spending the quota; an interrupted rung is re-offered', async () => {
    mockFindMessage.mockResolvedValue(assistantRow({ mode: 'thinking', depth: { plan: { preset: 'thinking', spawnChecker: true }, escalations: [{ rung: 'research', at: 't', status: 'running' }] } }));
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), res, jest.fn());
    await flush();
    expect(events(res).find((e: any) => e.type === 'error')?.data.code).toBe('ESCALATION_EXHAUSTED');
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    mockFindMessage.mockResolvedValue(assistantRow({ mode: 'thinking', depth: { plan: { preset: 'thinking', spawnChecker: true }, escalations: [{ rung: 'research', at: 't', status: 'interrupted' }] } }));
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), mkRes(), jest.fn());
    await flush();
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ mode: 'deep_research', escalation: { ofMessageId: MSG, rung: 'research' } });
  });

  it('a heavily-spent message (metadata.depth.spentUsd far past any old bound, a legacy budget.maxUsd on the row, DEPTH_BUDGET_MAX_USD set) is NEVER answered with DEPTH_BUDGET_EXCEEDED — the code no longer exists; the rung runs', async () => {
    mockFindMessage.mockResolvedValue(assistantRow({ mode: 'single_thinking', depth: { plan: { preset: 'single_thinking', spawnChecker: false }, budget: { maxUsd: 0.25 }, spentUsd: 9.31 } }));
    process.env.DEPTH_BUDGET_MAX_USD = '0.25';
    try {
      const res = mkRes();
      await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), res, jest.fn());
      await flush();
      const err = events(res).find((e: any) => e.type === 'error');
      expect(err).toBeUndefined();
      expect(JSON.stringify(events(res))).not.toContain('DEPTH_BUDGET_EXCEEDED');
      expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    } finally { delete process.env.DEPTH_BUDGET_MAX_USD; }
  });

  it('DIG_DEEPER_DISABLED=1 rejects the param gracefully (SSE error, code DIG_DEEPER_DISABLED), no DB read, no run', async () => {
    process.env.DIG_DEEPER_DISABLED = '1';
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), res, jest.fn());
    await flush();
    expect(events(res).find((e: any) => e.type === 'error')?.data.code).toBe('DIG_DEEPER_DISABLED');
    expect(mockFindMessage).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
  });

  it('the question behind the answer missing → ESCALATION_NO_QUESTION', async () => {
    mockFindMessage.mockResolvedValue(assistantRow({ mode: 'thinking' }));
    mockFindFirstMessage.mockResolvedValue(null);
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), res, jest.fn());
    await flush();
    expect(events(res).find((e: any) => e.type === 'error')?.data.code).toBe('ESCALATION_NO_QUESTION');
  });

  it('a BUSY chat refuses the tap (ESCALATION_BUSY) instead of queueing the original question as a plain re-ask', async () => {
    mockFindMessage.mockResolvedValue(assistantRow({ mode: 'single_thinking' }));
    const { isChatBusy } = jest.requireMock('./chat-agent/chat-busy');
    (isChatBusy as jest.Mock).mockResolvedValueOnce(true);
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'x', mode: 'thinking', chatId: CHAT, escalationOf: MSG } }), res, jest.fn());
    await flush();
    expect(events(res).find((e: any) => e.type === 'error')?.data.code).toBe('ESCALATION_BUSY');
    expect(events(res).find((e: any) => e.type === 'queued')).toBeUndefined();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
  });

  it('a machine-shaped send never reaches the escalation path (no escalationOf ⇒ no escalation arg)', async () => {
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'Hello', mode: 'thinking', chatId: CHAT } }), res, jest.fn());
    await flush();
    expect(mockStartDetachedChatRun.mock.calls[0][0].escalation).toBeUndefined();
    expect(mockFindMessage).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  it('escalationOf must be a uuid; a valid one passes through the stream schema', () => {
    expect(streamQuerySchema.safeParse({ query: { message: 'x', escalationOf: 'nope' } }).success).toBe(false);
    const ok = streamQuerySchema.safeParse({ query: { message: 'x', escalationOf: MSG } });
    expect(ok.success).toBe(true);
    expect((ok as any).data.query.escalationOf).toBe(MSG);
  });
  it('the beacon schema accepts the fixed event set and bounded fields', () => {
    expect(uxBeaconSchema.safeParse({ body: { event: 'first_paint', chatId: CHAT, ms: 1200 } }).success).toBe(true);
    expect(uxBeaconSchema.safeParse({ body: { event: 'model_prose' } }).success).toBe(false);
    expect(uxBeaconSchema.safeParse({ body: { event: 'tap', ms: -1 } }).success).toBe(false);
  });
});

describe('POST /ux/beacon', () => {
  it('records ONE ux_beacon row (value = client ms) and answers 204', async () => {
    const res = mkRes();
    await controller.uxBeacon({ body: { event: 'first_paint', chatId: CHAT, messageId: MSG, ms: 1234, mode: 'thinking' }, user: { id: 'u1' } } as any, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(204);
    const row = mockRecordMetric.mock.calls.find((c: any) => c[0].kind === 'ux_beacon')?.[0];
    expect(row).toMatchObject({ kind: 'ux_beacon', sessionId: CHAT, value: 1234, unit: 'ms', meta: { event: 'first_paint', messageId: MSG, mode: 'thinking', guest: false } });
  });
  it('audit 2026-09-26 (guest-persistence-4): a GUEST beacon keys its row on anon-<sid> (the body sessionId, else the cm_session cookie) — the same key ux_ttft / compute_policy stamp', async () => {
    const SID = '4f1c2b3a-1111-4222-8333-444455556666';
    await controller.uxBeacon({ body: { event: 'first_paint', ms: 900, sessionId: SID }, cookies: {} } as any, mkRes(), jest.fn());
    expect(mockRecordMetric.mock.calls[0][0]).toMatchObject({ kind: 'ux_beacon', sessionId: `anon-${SID}`, meta: { event: 'first_paint', guest: true } });
    await controller.uxBeacon({ body: { event: 'tap', target: 'signin_deeper' }, cookies: { cm_session: SID } } as any, mkRes(), jest.fn());
    expect(mockRecordMetric.mock.calls[1][0]).toMatchObject({ sessionId: `anon-${SID}`, meta: { target: 'signin_deeper' } });
    expect(uxBeaconSchema.safeParse({ body: { event: 'tap', sessionId: SID } }).success).toBe(true);
    expect(uxBeaconSchema.safeParse({ body: { event: 'tap', sessionId: 'nope' } }).success).toBe(false);
  });

  it('UX_BEACON_DISABLED=1 → 204 and nothing recorded; guests are flagged', async () => {
    process.env.UX_BEACON_DISABLED = '1';
    const res = mkRes();
    await controller.uxBeacon({ body: { event: 'tap', target: 'escalate' } } as any, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(204);
    expect(mockRecordMetric).not.toHaveBeenCalled();
    delete process.env.UX_BEACON_DISABLED;
    await controller.uxBeacon({ body: { event: 'tap', target: 'escalate' } } as any, mkRes(), jest.fn());
    expect(mockRecordMetric.mock.calls[0][0].meta).toMatchObject({ event: 'tap', target: 'escalate', guest: true });
  });
});

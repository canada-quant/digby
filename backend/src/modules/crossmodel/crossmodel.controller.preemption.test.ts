/**
 * streamQuery busy-branch wiring for F1/F2 (owner incident 2026-09-04):
 *   - a USER-TYPED send to a chat whose active run is MACHINE-triggered
 *     requests preemption; slot freed → the controller FALLS THROUGH and
 *     starts the user's run immediately (no enqueue);
 *   - not freed (user run / slow teardown / coding run) → the message queues
 *     (the 'queued' SSE event) and the F2(b) immediate-drain nudge fires;
 *   - an idle chat never touches the preemption seam;
 *   - anonymous sends (no chatId) never preempt — nothing of theirs queues.
 *
 * Harness mirrors crossmodel.controller.guest-session.test.ts (mock req/res
 * driving the REAL controller; every heavy boundary mocked).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));

const mockFindUser = jest.fn();
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    user: { findUnique: (...a: any[]) => mockFindUser(...a) },
    // The P5 satellite router probes the chat row with `.findUnique().catch()`
    // — must return a real promise. null = no owned chat row ⇒ the send stays
    // on the PLAIN-chat lane (exactly the lane under test).
    crossModelChat: { findUnique: jest.fn(async () => null) },
    crossModelMessage: { findMany: jest.fn(async () => []) },
  },
}));

const mockGetChatAccess = jest.fn(async (..._a: any[]) => ({ access: 'owner', exists: true }));
jest.mock('./crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: (...a: any[]) => mockGetChatAccess(...a) },
}));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(),
  combineAttachments: jest.fn(() => null),
}));
jest.mock('./chat-files.service', () => ({ persistChatUploads: jest.fn() }));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('./integrations/qwen-kid.integration', () => ({ streamKidResponse: jest.fn(), generateKidStatus: jest.fn() }));
jest.mock('./mcp-search', () => ({ searchWithBrightData: jest.fn() }));
jest.mock('./browser-agent', () => ({ runBrowserAgentSession: jest.fn() }));

const mockDecideChatGate = jest.fn();
jest.mock('./chat-agent/chat-gate', () => ({
  decideChatGate: (...a: any[]) => mockDecideChatGate(...a),
  mapAttachmentForAgent: jest.fn(() => ({ userImages: [], documentText: '' })),
  chatWriteAccessGranted: jest.fn(() => true),
  chatReadAccessGranted: jest.fn(),
  streamAccessDeniedError: jest.fn(() => ({ message: 'Chat not found' })),
}));
jest.mock('./integration-context', () => ({
  buildIntegrationContext: jest.fn(async () => ({ additionalContext: '', imessagePairedAgentId: null })),
  buildIntegrationContextBounded: jest.fn(async (build) => build()),
}));
const mockReserve = jest.fn(async (..._a: any[]): Promise<any> => ({ allowed: true, used: 1, limit: 5, remaining: 4 }));
const mockRefund = jest.fn(async (..._a: any[]) => {});
jest.mock('./rate-limit.service', () => ({
  checkDeepResearchQuota: jest.fn(), reserveDeepResearchQuota: (...a: any[]) => mockReserve(...a), getDeepResearchDailyLimit: jest.fn(),
  getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
  refundDeepResearchQuota: (...a: any[]) => mockRefund(...a),
  queuedCouncilQuotaDisabled: () => process.env.QUEUED_COUNCIL_QUOTA_DISABLED === '1',
}));
jest.mock('./coding/coding-data.service', () => ({ getChatCapability: jest.fn() }));

const mockIsChatBusy = jest.fn(async (..._a: any[]) => false);
jest.mock('./chat-agent/chat-busy', () => ({
  isChatBusy: (...a: any[]) => mockIsChatBusy(...a),
}));
jest.mock('./chat-agent/run-event-mirror', () => ({
  attachRemoteChatRun: jest.fn(),
  replayFinishedRemoteRun: jest.fn(async () => false),
}));
jest.mock('./coding/coding-stream.controller', () => ({
  __esModule: true,
  default: { streamRun: jest.fn() },
}));

const mockStartDetachedChatRun = jest.fn();
const mockPreemptMachineRun = jest.fn(async (..._a: any[]): Promise<{ preempted: boolean; freed: boolean }> => ({ preempted: false, freed: false }));
const mockNudgeQueueDrainSoon = jest.fn();
jest.mock('./chat-agent/chat-agent.service', () => ({
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  preemptMachineRunForUserMessage: (...a: any[]) => mockPreemptMachineRun(...a),
  nudgeQueueDrainSoon: (...a: any[]) => mockNudgeQueueDrainSoon(...a),
  chatAgentRunKey: jest.fn(() => 'agent-key'),
}));
const mockEnqueueChatMessage = jest.fn(async (..._a: any[]) => ({ id: 'p1', position: 1 }));
jest.mock('./chat-agent/message-queue.service', () => ({
  enqueueChatMessage: (...a: any[]) => mockEnqueueChatMessage(...a),
}));
jest.mock('./coding/live-runs', () => ({
  isRunActive: jest.fn(() => false),
  subscribeRun: jest.fn(() => false),
}));

import controller from './crossmodel.controller';

const CHAT_ID = 'chat-1';

const mkReq = (over: any = {}): any => ({
  query: { message: 'urgent question', mode: 'single_thinking', chatId: CHAT_ID },
  user: { id: 'u1' },
  on: jest.fn(),
  ...over,
});
const mkRes = (): any => {
  const res: any = {
    statusCode: 200,
    frames: [] as string[],
    writableEnded: false,
    headersSent: false,
    status: jest.fn((c: number) => { res.statusCode = c; return res; }),
    json: jest.fn((b: any) => res),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    cookie: jest.fn(),
    write: jest.fn((chunk: string) => { res.frames.push(chunk); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
  };
  return res;
};
const frameTypes = (res: any): string[] =>
  res.frames.map((f: string) => { try { return JSON.parse(f.replace(/^data: /, '')).type; } catch { return ''; } });

beforeEach(() => {
  jest.clearAllMocks();
  mockDecideChatGate.mockReturnValue({ action: 'agent' });
  mockFindUser.mockResolvedValue({ isChild: false });
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  mockIsChatBusy.mockResolvedValue(false);
  mockPreemptMachineRun.mockResolvedValue({ preempted: false, freed: false });
  mockStartDetachedChatRun.mockResolvedValue('run-key-1');
  mockEnqueueChatMessage.mockResolvedValue({ id: 'p1', position: 1 });
  mockReserve.mockResolvedValue({ allowed: true, used: 1, limit: 5, remaining: 4 });
  delete process.env.QUEUED_COUNCIL_QUOTA_DISABLED;
});

describe('streamQuery — F1 preemption + F2 queue wiring (incident 2026-09-04)', () => {
  it('busy + machine run PREEMPTED AND FREED → falls through to an immediate start (no enqueue, no queued event)', async () => {
    mockIsChatBusy.mockResolvedValueOnce(true); // the guard's check
    mockPreemptMachineRun.mockResolvedValueOnce({ preempted: true, freed: true });
    const res = mkRes();
    await controller.streamQuery(mkReq(), res, jest.fn());

    expect(mockPreemptMachineRun).toHaveBeenCalledWith(CHAT_ID);
    expect(mockEnqueueChatMessage).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ userId: 'u1', chatId: CHAT_ID, message: 'urgent question' });
    expect(frameTypes(res)).not.toContain('queued');
  });

  it('busy + NOT freed (user run / slow teardown) → queues, emits the queued event, fires the F2(b) nudge — never starts a second run', async () => {
    mockIsChatBusy.mockResolvedValueOnce(true);
    mockPreemptMachineRun.mockResolvedValueOnce({ preempted: true, freed: false });
    const res = mkRes();
    await controller.streamQuery(mkReq(), res, jest.fn());

    expect(mockEnqueueChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT_ID, userId: 'u1', content: 'urgent question', source: 'user' }),
    );
    expect(frameTypes(res)).toContain('queued');
    expect(mockNudgeQueueDrainSoon).toHaveBeenCalledWith(CHAT_ID, 'u1');
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(res.writableEnded).toBe(true);
  });

  it('idle chat never touches the preemption seam', async () => {
    const res = mkRes();
    await controller.streamQuery(mkReq(), res, jest.fn());
    expect(mockPreemptMachineRun).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
  });

  it('a LOST start race (startDetachedChatRun → null) queues + nudges instead of erroring', async () => {
    mockStartDetachedChatRun.mockResolvedValueOnce(null);
    const res = mkRes();
    await controller.streamQuery(mkReq(), res, jest.fn());
    expect(frameTypes(res)).toContain('queued');
    expect(mockNudgeQueueDrainSoon).toHaveBeenCalledWith(CHAT_ID, 'u1');
  });

  it('anonymous busy session (no chatId): no preemption, no queue — the legacy busy error stands', async () => {
    const { isRunActive } = jest.requireMock('./coding/live-runs');
    (isRunActive as jest.Mock).mockReturnValueOnce(true); // session-key busy path
    const res = mkRes();
    await controller.streamQuery(mkReq({
      query: { message: 'hi', mode: 'single_thinking', sessionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
      user: undefined,
    }), res, jest.fn());
    expect(mockPreemptMachineRun).not.toHaveBeenCalled();
    expect(mockEnqueueChatMessage).not.toHaveBeenCalled();
    expect(frameTypes(res)).toContain('error');
  });
});

describe('streamQuery — a queued Level 3 send holds its deep-research slot (audit 2026-10-03)', () => {
  const council = () => mockDecideChatGate.mockReturnValue({ action: 'agent', councilMode: true });
  const l3Req = () => mkReq({ query: { message: 'Research the 1995 referendum', mode: 'deep_research', chatId: CHAT_ID } });

  it('busy chat: the slot is reserved ONCE at enqueue (the drain has no reserve of its own)', async () => {
    council();
    mockIsChatBusy.mockResolvedValueOnce(true);
    const res = mkRes();
    await controller.streamQuery(l3Req(), res, jest.fn());
    expect(mockReserve).toHaveBeenCalledTimes(1);
    expect(mockEnqueueChatMessage).toHaveBeenCalledWith(expect.objectContaining({ mode: 'deep_research' }));
    expect(frameTypes(res)).toContain('queued');
  });

  it('busy chat + exhausted quota on an EXPLICIT Level 3: refused like the direct path, nothing queued', async () => {
    council();
    mockIsChatBusy.mockResolvedValueOnce(true);
    mockReserve.mockResolvedValueOnce({ allowed: false, used: 5, limit: 5, remaining: 0 });
    const res = mkRes();
    await controller.streamQuery(l3Req(), res, jest.fn());
    expect(mockEnqueueChatMessage).not.toHaveBeenCalled();
    const err = res.frames.map((f: string) => JSON.parse(f.replace(/^data: /, ''))).find((e: any) => e.type === 'error');
    expect(err?.data.code).toBe('RATE_LIMIT_DEEP_RESEARCH');
  });

  it('a LOST start race after the direct reserve queues WITHOUT a second charge', async () => {
    council();
    mockStartDetachedChatRun.mockResolvedValueOnce(null);
    const res = mkRes();
    await controller.streamQuery(l3Req(), res, jest.fn());
    expect(mockReserve).toHaveBeenCalledTimes(1);
    expect(frameTypes(res)).toContain('queued');
  });

  it('an enqueue failure gives the slot back', async () => {
    council();
    mockIsChatBusy.mockResolvedValueOnce(true);
    mockEnqueueChatMessage.mockRejectedValueOnce(Object.assign(new Error('queue full'), { statusCode: 409 }));
    const res = mkRes();
    await controller.streamQuery(l3Req(), res, jest.fn());
    expect(mockReserve).toHaveBeenCalledTimes(1);
    expect(mockRefund).toHaveBeenCalledWith('u1');
  });

  it('QUEUED_COUNCIL_QUOTA_DISABLED=1 restores the unmetered queue', async () => {
    process.env.QUEUED_COUNCIL_QUOTA_DISABLED = '1';
    council();
    mockIsChatBusy.mockResolvedValueOnce(true);
    await controller.streamQuery(l3Req(), mkRes(), jest.fn());
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockEnqueueChatMessage).toHaveBeenCalledTimes(1);
  });
});

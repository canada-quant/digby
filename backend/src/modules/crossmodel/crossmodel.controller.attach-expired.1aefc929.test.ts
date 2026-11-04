/**
 * streamQuery staged-attachment failure policy (ticket 1aefc929 — "attached
 * images never arrive… no error is surfaced"): the plain-chat /stream send
 * must NEVER silently deliver text-only when the caller staged uploads.
 *
 *   - EVERY staged id fails to resolve (15-min Redis TTL expired / lost) →
 *     a hard SSE 'error' event (the client toasts it — CodeSessionView) is
 *     emitted BEFORE anything runs or persists: no detached run, no queue,
 *     no optimistic user row. The pre-fix behavior proceeded text-only with
 *     only a server-side warn — the exact silent drop behind the owner
 *     report (and behind the Fleet Supervisor's failed 4-screenshot forward
 *     at 2026-09-13 18:31:26Z).
 *   - SOME fail → the send proceeds with the survivors and the user message
 *     carries the honest drop annotation (the queued-drain idiom).
 *
 * Harness mirrors crossmodel.controller.preemption.test.ts (mock req/res
 * driving the REAL controller; every heavy boundary mocked — config/env exits
 * the process at import in a keyless env, per .digby/notes/learnings.md).
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

const mockLoadAttachment = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockCombineAttachments = jest.fn((..._a: any[]): any => undefined);
jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: (...a: any[]) => mockLoadAttachment(...a),
  combineAttachments: (...a: any[]) => mockCombineAttachments(...a),
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
jest.mock('./rate-limit.service', () => ({
  checkDeepResearchQuota: jest.fn(), reserveDeepResearchQuota: jest.fn(), getDeepResearchDailyLimit: jest.fn(),
  getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
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
jest.mock('./chat-agent/chat-agent.service', () => ({
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  preemptMachineRunForUserMessage: jest.fn(async () => ({ preempted: false, freed: false })),
  nudgeQueueDrainSoon: jest.fn(),
  chatAgentRunKey: jest.fn(() => 'agent-key'),
}));
const mockEnqueueChatMessage = jest.fn(async (..._a: any[]) => ({ id: 'p1', position: 1 }));
jest.mock('./chat-agent/message-queue.service', () => ({
  enqueueChatMessage: (...a: any[]) => mockEnqueueChatMessage(...a),
}));
jest.mock('./coding/live-runs', () => ({
  isRunActive: jest.fn(() => false),
  // Returns a real unsubscribe fn — a falsey non-null return makes the
  // controller's `unsubChat?.()` throw "unsubChat is not a function" (the
  // optional call only short-circuits on null/undefined).
  subscribeRun: jest.fn(() => () => {}),
}));

import controller from './crossmodel.controller';

const CHAT_ID = 'chat-1';
// UUID-shaped ids — sanitizeUploadIds drops anything else BEFORE resolution.
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

const mkReq = (over: any = {}): any => ({
  query: { message: 'look at these', mode: 'single_thinking', chatId: CHAT_ID, uploadId: [U1, U2] },
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
const sseEvents = (res: any): any[] =>
  res.frames
    .filter((f: string) => f.startsWith('data: '))
    .map((f: string) => { try { return JSON.parse(f.slice(6)); } catch { return null; } })
    .filter(Boolean);

beforeEach(() => {
  jest.clearAllMocks();
  mockDecideChatGate.mockReturnValue({ action: 'agent' });
  mockFindUser.mockResolvedValue({ isChild: false });
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  mockIsChatBusy.mockResolvedValue(false);
  mockStartDetachedChatRun.mockResolvedValue('run-key-1');
});

describe('streamQuery — staged-attachment failure policy (ticket 1aefc929)', () => {
  it('TOTAL loss: ALL staged ids expired → hard SSE error, nothing runs, nothing queues, stream ends', async () => {
    mockLoadAttachment.mockResolvedValue(null); // both blobs gone (15-min TTL)
    const res = mkRes();
    await controller.streamQuery(mkReq(), res, jest.fn());

    const errors = sseEvents(res).filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].data.message).toContain('All 2 attachments expired');
    expect(errors[0].data.message).toMatch(/nothing was sent/i);
    expect(res.writableEnded).toBe(true);
    // Nothing ran, nothing queued, nothing persisted:
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(mockEnqueueChatMessage).not.toHaveBeenCalled();
    expect(sseEvents(res).some((e) => e.type === 'queued')).toBe(false);
  });

  it('PARTIAL loss: one of two expired → send proceeds with the survivor AND the message carries the drop annotation', async () => {
    mockLoadAttachment.mockImplementation(async (id: string) =>
      id === U1 ? { type: 'image', filename: 'shot.png', mimeType: 'image/png', base64: 'QUJD' } : null);
    mockCombineAttachments.mockReturnValue({ type: 'image', filename: 'shot.png', base64: 'QUJD' });
    const res = mkRes();
    await controller.streamQuery(mkReq(), res, jest.fn());

    expect(sseEvents(res).filter((e) => e.type === 'error')).toHaveLength(0);
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    const sent = mockStartDetachedChatRun.mock.calls[0][0];
    expect(sent.message).toContain('look at these');
    expect(sent.message).toContain('1 attachment(s) expired');
    expect(sent.message).toContain('re-send it');
  });

  it('NO loss: every staged id resolves → the message goes through untouched (no annotation)', async () => {
    mockLoadAttachment.mockResolvedValue({ type: 'image', filename: 'a.png', base64: 'QUJD' });
    mockCombineAttachments.mockReturnValue({ type: 'image', filename: 'a.png', base64: 'QUJD' });
    const res = mkRes();
    await controller.streamQuery(mkReq(), res, jest.fn());

    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    const sent = mockStartDetachedChatRun.mock.calls[0][0];
    expect(sent.message).toBe('look at these');
    expect(sseEvents(res).filter((e) => e.type === 'error')).toHaveLength(0);
  });
});

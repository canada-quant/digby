/**
 * GET /session/:sessionId/stream — the GUEST reattach (stream drops,
 * 2026-10-20). A guest whose SSE dropped mid-answer used to be told to resend
 * while the run kept going; this endpoint is the anonymous twin of
 * GET /chats/:id/stream. Pins:
 *   - posture: GUEST_STREAM_ATTACH_DISABLED=1 ⇒ 404, a signed-in caller ⇒ 404,
 *     a non-uuid id ⇒ 400 (nothing attached);
 *   - precedence: this process's ACTIVE run (replay + tail) → the other box's
 *     mirror (keyed `session:<sid>`, the guest liveness probe as isBusy) →
 *     this process's retained FINISHED run → a just-finished mirror replay →
 *     one complete{interrupted:true}. A live run anywhere outranks a finished
 *     one (review 2026-10-20: the retained run can be the guest's PREVIOUS
 *     turn while the turn the tab waits on runs on the other box);
 *   - isolation: the run key and the mirror key are derived from the path id —
 *     session B's request never sees session A's events;
 *   - telemetry: sse_reattach source local / truncated / remote, and a viewer
 *     that leaves mid-run writes sse_viewer_drop (surface guest).
 *
 * live-runs is the REAL registry (the local path exercises the true replay);
 * the mirror, the guest liveness probe and loop metrics are mocked boundaries.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./crossmodel.service', () => ({ __esModule: true, default: {} }));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn() }));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('./view/view-mode', () => ({ resolveViewMode: jest.fn(async () => 'full'), resolveViewModeForRequest: jest.fn(async () => 'full') }));
jest.mock('./integrations/qwen-kid.integration', () => ({ streamKidResponse: jest.fn(), generateKidStatus: jest.fn() }));
jest.mock('./mcp-search', () => ({ searchWithBrightData: jest.fn() }));
jest.mock('./browser-agent', () => ({ runBrowserAgentSession: jest.fn() }));
jest.mock('./chat-agent/chat-gate', () => ({
  decideChatGate: jest.fn(), mapAttachmentForAgent: jest.fn(),
  chatWriteAccessGranted: jest.fn(), chatReadAccessGranted: jest.fn(), streamAccessDeniedError: jest.fn(),
}));
jest.mock('./integration-context', () => ({ buildIntegrationContext: jest.fn(), buildIntegrationContextBounded: jest.fn() }));
jest.mock('./rate-limit.service', () => ({
  checkDeepResearchQuota: jest.fn(), reserveDeepResearchQuota: jest.fn(), getDeepResearchDailyLimit: jest.fn(),
  getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
}));
const mockGuestRunActive = jest.fn(async (..._a: any[]) => false);
jest.mock('./chat-agent/guest-session-run', () => ({
  ...jest.requireActual('./chat-agent/guest-session-run'),
  isGuestSessionRunActive: (...a: any[]) => mockGuestRunActive(...a),
}));
const mockAttachRemoteChatRun = jest.fn();
const mockReplayFinishedRemoteRun = jest.fn(async (..._a: any[]) => false);
jest.mock('./chat-agent/run-event-mirror', () => ({
  guestMirrorId: (sid: string) => `session:${sid}`,
  attachRemoteChatRun: (...a: any[]) => mockAttachRemoteChatRun(...a),
  replayFinishedRemoteRun: (...a: any[]) => mockReplayFinishedRemoteRun(...a),
}));
const mockRecordMetric: jest.Mock = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  ...jest.requireActual('./platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordMetric(...a),
}));

import controller from './crossmodel.controller';
import { startLiveRun, pushRunEvent, endLiveRun } from './coding/live-runs';
import { __resetStreamMetricThrottle } from './chat-agent/stream-drops';

const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const SID_C = 'cccccccc-3333-4333-8333-333333333333';
const SID_D = 'dddddddd-4444-4444-8444-444444444444';
const SID_E = 'eeeeeeee-5555-4555-8555-555555555555';
const SID_F = 'ffffffff-6666-4666-8666-666666666666';
const SID_G = 'abababab-7777-4777-8777-777777777777';

const mkReq = (sessionId: string, over: any = {}) => {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    req: { params: { sessionId }, query: {}, on: jest.fn((ev: string, cb: () => void) => { (handlers[ev] ??= []).push(cb); }), ...over } as any,
    close: () => { for (const cb of handlers.close ?? []) cb(); },
  };
};
const mkRes = (): any => {
  const res: any = {
    statusCode: 200, body: undefined as any, frames: [] as string[], writableEnded: false, headersSent: false,
    status: jest.fn((c: number) => { res.statusCode = c; return res; }),
    json: jest.fn((b: any) => { res.body = b; return res; }),
    setHeader: jest.fn(), flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => { res.frames.push(chunk); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
  };
  return res;
};
const sseEvents = (res: any) => res.frames.filter((f: string) => f.startsWith('data: ')).map((f: string) => JSON.parse(f.slice(6)));
const rows = (kind: string) => mockRecordMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === kind);

beforeEach(() => {
  // Fake timers: the real registry's 30 s retention timeout and the attach's
  // 20 s heartbeat must never outlive the suite.
  jest.useFakeTimers();
  jest.clearAllMocks();
  __resetStreamMetricThrottle();
  mockGuestRunActive.mockResolvedValue(false);
  delete process.env.GUEST_STREAM_ATTACH_DISABLED;
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  delete process.env.GUEST_STREAM_ATTACH_DISABLED;
});

describe('guestSessionStream — posture', () => {
  it('GUEST_STREAM_ATTACH_DISABLED=1 ⇒ 404 and nothing is attached', async () => {
    process.env.GUEST_STREAM_ATTACH_DISABLED = '1';
    const res = mkRes();
    await controller.guestSessionStream(mkReq(SID_A).req, res);
    expect(res.statusCode).toBe(404);
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });
  it('a signed-in caller ⇒ 404 (their chats have rows + /chats/:id/stream)', async () => {
    const res = mkRes();
    await controller.guestSessionStream(mkReq(SID_A, { user: { id: 'u1' } }).req, res);
    expect(res.statusCode).toBe(404);
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });
  it('a non-uuid id ⇒ 400 (never a key built from arbitrary input)', async () => {
    const res = mkRes();
    await controller.guestSessionStream(mkReq('../chat:abc').req, res);
    expect(res.statusCode).toBe(400);
    expect(mockGuestRunActive).not.toHaveBeenCalled();
  });
});

describe('guestSessionStream — attach precedence', () => {
  it('1. a run in THIS process replays + tails (sse_reattach source local); a mid-run leave is a guest drop', async () => {
    startLiveRun(`chat:session:${SID_A}`);
    pushRunEvent(`chat:session:${SID_A}`, 'chunk', { content: 'hello ' });
    const { req, close } = mkReq(SID_A);
    const res = mkRes();
    await controller.guestSessionStream(req, res);
    expect(sseEvents(res)).toEqual([{ type: 'chunk', data: { content: 'hello ' }, ts: expect.any(String) }]);
    pushRunEvent(`chat:session:${SID_A}`, 'chunk', { content: 'world' });
    expect(sseEvents(res)).toHaveLength(2);
    expect(rows('sse_reattach')[0]).toMatchObject({ sessionId: `anon-${SID_A}`, meta: { surface: 'guest', source: 'local', guest: true } });
    close();
    expect(rows('sse_viewer_drop')[0]).toMatchObject({ sessionId: `anon-${SID_A}`, meta: { surface: 'guest', path: 'local', eventsWritten: 2, guest: true } });
    expect(mockAttachRemoteChatRun).not.toHaveBeenCalled();
    endLiveRun(`chat:session:${SID_A}`);
  });

  it('isolation: session B never sees session A\'s run', async () => {
    startLiveRun(`chat:session:${SID_C}`);
    pushRunEvent(`chat:session:${SID_C}`, 'chunk', { content: 'A-private' });
    const res = mkRes();
    await controller.guestSessionStream(mkReq(SID_B).req, res);
    expect(JSON.stringify(res.frames)).not.toContain('A-private');
    expect(sseEvents(res)).toEqual([{ type: 'complete', data: { interrupted: true } }]);
    expect(mockGuestRunActive).toHaveBeenCalledWith(SID_B);
    expect(mockReplayFinishedRemoteRun).toHaveBeenCalledWith(res, `session:${SID_B}`);
    endLiveRun(`chat:session:${SID_C}`);
  });

  it('2. a guest run live on the OTHER box tails the session-keyed mirror with the guest liveness probe', async () => {
    mockGuestRunActive.mockResolvedValue(true);
    const { req } = mkReq(SID_D);
    const res = mkRes();
    await controller.guestSessionStream(req, res);
    expect(mockAttachRemoteChatRun).toHaveBeenCalledTimes(1);
    const arg = mockAttachRemoteChatRun.mock.calls[0][0];
    expect(arg).toMatchObject({ req, res, chatId: `session:${SID_D}` });
    mockGuestRunActive.mockClear();
    await arg.isBusy();
    expect(mockGuestRunActive).toHaveBeenCalledWith(SID_D);
    arg.onReplay({ events: 12, truncated: false });
    expect(rows('sse_reattach')[0]).toMatchObject({ meta: { surface: 'guest', source: 'remote', events: 12 } });
    arg.onDrop({ eventsWritten: 3, elapsedMs: 900 });
    expect(rows('sse_viewer_drop')[0]).toMatchObject({ meta: { surface: 'guest', path: 'remote', eventsWritten: 3 } });
  });

  // Review 2026-10-20: the 30 s retention of THIS process's previous turn
  // used to win over the newer turn live on the other box — the tab got the
  // previous answer replayed as the reply to its new question.
  it('2b. a newer turn live on the OTHER box outranks this process\'s retained finished (previous) turn', async () => {
    const key = `chat:session:${SID_F}`;
    startLiveRun(key);
    pushRunEvent(key, 'chunk', { content: 'OLD ANSWER to Q1' });
    pushRunEvent(key, 'complete', {});
    endLiveRun(key); // finished — kept 30 s for a late viewer
    jest.advanceTimersByTime(10_000);
    mockGuestRunActive.mockResolvedValue(true); // Q2 runs on the other box
    const { req } = mkReq(SID_F);
    const res = mkRes();
    await controller.guestSessionStream(req, res);
    expect(JSON.stringify(res.frames)).not.toContain('OLD ANSWER');
    expect(mockAttachRemoteChatRun).toHaveBeenCalledTimes(1);
    expect(mockAttachRemoteChatRun.mock.calls[0][0]).toMatchObject({ req, res, chatId: `session:${SID_F}` });
  });

  it('2c. a retained finished run in THIS process replays only once nothing is live anywhere', async () => {
    const key = `chat:session:${SID_G}`;
    startLiveRun(key);
    pushRunEvent(key, 'chunk', { content: 'the finished answer' });
    pushRunEvent(key, 'complete', {});
    endLiveRun(key);
    const res = mkRes();
    await controller.guestSessionStream(mkReq(SID_G).req, res);
    expect(mockGuestRunActive).toHaveBeenCalledWith(SID_G); // asked BEFORE the retained replay
    expect(sseEvents(res).map((e: any) => e.type)).toEqual(['chunk', 'complete']);
    expect(mockAttachRemoteChatRun).not.toHaveBeenCalled();
    expect(mockReplayFinishedRemoteRun).not.toHaveBeenCalled();
    expect(rows('sse_reattach')[0]).toMatchObject({ meta: { surface: 'guest', source: 'local' } });
  });

  it('3. a just-finished run on the other box replays from the mirror (nothing else written)', async () => {
    mockReplayFinishedRemoteRun.mockResolvedValueOnce(true);
    const res = mkRes();
    await controller.guestSessionStream(mkReq(SID_E).req, res);
    expect(mockReplayFinishedRemoteRun).toHaveBeenCalledWith(res, `session:${SID_E}`);
    expect(sseEvents(res)).toEqual([]);
  });

  it('4. nothing anywhere ⇒ one complete{interrupted:true} (the client then reads /state)', async () => {
    const res = mkRes();
    await controller.guestSessionStream(mkReq(SID_E).req, res);
    expect(sseEvents(res)).toEqual([{ type: 'complete', data: { interrupted: true } }]);
    expect(res.writableEnded).toBe(true);
  });
});

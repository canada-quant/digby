/**
 * Unified GET /chats/:id/stream — ATTACH routing (streamChatRun). Pins the
 * cross-instance fix (fix/chat-attach-cross-instance):
 *   1. a LOCAL run (in-process registry) attaches directly (unchanged);
 *   2. a workspace-state chat routes to the coding durable-log tail (unchanged);
 *   3. a BUSY plain chat with NO local run — the run lives on the OTHER
 *      blue/green instance — tails the Redis run-event mirror instead of the
 *      old complete{interrupted:true} lie (which contradicted the chat list's
 *      simultaneous "running" from isChatBusy);
 *   4. an idle plain chat still gets the single interrupted complete;
 *   plus the back-compat ?message= guard, which now 409s on the CROSS-PROCESS
 *   busy truth (isChatBusy) — the local-registry-only check answered with the
 *   wrong error text for runs live on the other instance.
 *
 * live-runs is the REAL registry (path 1 exercises the true subscribe);
 * everything else on the controller's import graph is a mocked boundary
 * (config/env exits the process at import — per .digby/notes/learnings.md).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));

const mockGetChatById = jest.fn();
jest.mock('./crossmodel.service', () => ({
  __esModule: true,
  default: { getChatById: (...a: any[]) => mockGetChatById(...a) },
}));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn() }));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
// Minimal view (2026-10-16): these pins are about ATTACH PRECEDENCE with the same req/res — the per-viewer frame
// filter (view/minimal-sse.ts) is pinned in view/minimal-view.test.ts.
jest.mock('./view/view-mode', () => ({ resolveViewMode: jest.fn(async () => 'full'), resolveViewModeForRequest: jest.fn(async () => 'full') }));
jest.mock('./integrations/qwen-kid.integration', () => ({ streamKidResponse: jest.fn(), generateKidStatus: jest.fn() }));
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

// Dynamic-import seams inside streamChatRun.
const mockGetChatCapability = jest.fn();
jest.mock('./coding/coding-data.service', () => ({
  getChatCapability: (...a: any[]) => mockGetChatCapability(...a),
}));
const mockIsChatBusy = jest.fn();
jest.mock('./chat-agent/chat-busy', () => ({ isChatBusy: (...a: any[]) => mockIsChatBusy(...a) }));
const mockAttachRemoteChatRun = jest.fn();
const mockReplayFinishedRemoteRun = jest.fn(async (..._a: any[]) => false);
jest.mock('./chat-agent/run-event-mirror', () => ({
  attachRemoteChatRun: (...a: any[]) => mockAttachRemoteChatRun(...a),
  replayFinishedRemoteRun: (...a: any[]) => mockReplayFinishedRemoteRun(...a),
}));
const mockCodingStreamRun = jest.fn();
jest.mock('./coding/coding-stream.controller', () => ({
  __esModule: true,
  default: { streamRun: (...a: any[]) => mockCodingStreamRun(...a) },
}));
// Stream drops (2026-10-20): the attach's telemetry rows land here.
const mockRecordMetric: jest.Mock = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  ...jest.requireActual('./platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordMetric(...a),
}));

import controller from './crossmodel.controller';
import { startLiveRun, pushRunEvent, endLiveRun, isRunActive } from './coding/live-runs';
import { __resetStreamMetricThrottle } from './chat-agent/stream-drops';

const CAP_PLAIN = { codeCapable: false, hasWorkspaceState: false, workspaceReady: false };

// Distinct chat ids per test: live-runs is REAL and retains finished runs for
// 30s (a retained run on a reused id would satisfy findLiveRunKey and hijack
// the later-precedence tests).
const mkReq = (id: string, over: any = {}): any => ({
  params: { id },
  query: {},
  user: { id: 'u1' },
  on: jest.fn(),
  ...over,
});
const mkRes = (): any => {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    frames: [] as string[],
    writableEnded: false,
    headersSent: false,
    status: jest.fn((c: number) => { res.statusCode = c; return res; }),
    json: jest.fn((b: any) => { res.body = b; return res; }),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => { res.frames.push(chunk); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
  };
  return res;
};
const sseEvents = (res: any) =>
  res.frames.filter((f: string) => f.startsWith('data: ')).map((f: string) => JSON.parse(f.slice(6)));

beforeEach(() => {
  jest.clearAllMocks();
  __resetStreamMetricThrottle();
  mockGetChatById.mockImplementation(async (id: string) => ({ id, title: 'T', mode: 'thinking', userId: 'u1', projectId: null }));
  mockGetChatCapability.mockResolvedValue(CAP_PLAIN);
  mockIsChatBusy.mockResolvedValue(false);
});

describe('streamChatRun — attach precedence', () => {
  it('1. a LOCAL run attaches directly (replay + terminal end), never the mirror', async () => {
    startLiveRun('chat:c-local');
    pushRunEvent('chat:c-local', 'chunk', { content: 'hi' });
    const res = mkRes();
    await controller.streamChatRun(mkReq('c-local'), res);
    // Frames carry the event's server wall-clock `ts` since 2026-09-08 (replayed
    // parts are stamped with when they happened, not the client's ingest time).
    expect(sseEvents(res)[0]).toEqual({ type: 'chunk', data: { content: 'hi' }, ts: expect.any(String) });
    pushRunEvent('chat:c-local', 'complete', { totalTime: 1 });
    endLiveRun('chat:c-local');
    expect(res.writableEnded).toBe(true);
    expect(mockAttachRemoteChatRun).not.toHaveBeenCalled();
    expect(mockIsChatBusy).not.toHaveBeenCalled(); // local fast path stays cheap
  });

  it('2. a workspace-state chat routes to the coding durable-log tail', async () => {
    mockGetChatCapability.mockResolvedValue({ codeCapable: true, hasWorkspaceState: true, workspaceReady: true });
    const req = mkReq('c-ws');
    const res = mkRes();
    await controller.streamChatRun(req, res);
    expect(mockCodingStreamRun).toHaveBeenCalledWith(req, res);
    expect(mockAttachRemoteChatRun).not.toHaveBeenCalled();
  });

  it('3. a BUSY plain chat with no local run tails the cross-instance mirror (the fix)', async () => {
    expect(isRunActive('chat:c-remote')).toBe(false); // pre-condition: nothing local
    mockIsChatBusy.mockResolvedValue(true); // …but the OTHER instance holds the run
    const req = mkReq('c-remote');
    const res = mkRes();
    await controller.streamChatRun(req, res);
    // Stream drops (2026-10-20): the attach also carries the telemetry hooks
    // (sse_reattach on the first replay, sse_viewer_drop on a mid-run leave).
    expect(mockAttachRemoteChatRun).toHaveBeenCalledWith({ req, res, chatId: 'c-remote', onReplay: expect.any(Function), onDrop: expect.any(Function) });
    // The old behavior — the interrupted lie — must be gone on this path.
    expect(sseEvents(res).some((e: any) => e.data?.interrupted)).toBe(false);
    const { onReplay, onDrop } = mockAttachRemoteChatRun.mock.calls[0][0];
    onReplay({ events: 2000, truncated: true });
    onDrop({ eventsWritten: 5, elapsedMs: 1200 });
    const kinds = mockRecordMetric.mock.calls.map((c: any[]) => c[0]);
    expect(kinds.find((r: any) => r.kind === 'sse_reattach')).toMatchObject({ sessionId: 'c-remote', meta: { surface: 'attach', source: 'truncated', events: 2000, guest: false } });
    expect(kinds.find((r: any) => r.kind === 'sse_viewer_drop')).toMatchObject({ sessionId: 'c-remote', meta: { surface: 'attach', path: 'remote', eventsWritten: 5 } });
  });

  it('6. a LOCAL reattach records sse_reattach (local) and a mid-run leave records ONE sse_viewer_drop (stream drops 2026-10-20)', async () => {
    startLiveRun('chat:c-local-drop');
    pushRunEvent('chat:c-local-drop', 'chunk', { content: 'hi' });
    const handlers: Array<() => void> = [];
    const req = mkReq('c-local-drop', { on: jest.fn((ev: string, cb: () => void) => { if (ev === 'close') handlers.push(cb); }) });
    const res = mkRes();
    await controller.streamChatRun(req, res);
    const rowsOf = (k: string) => mockRecordMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === k);
    expect(rowsOf('sse_reattach')[0]).toMatchObject({ sessionId: 'c-local-drop', meta: { surface: 'attach', source: 'local' } });
    for (const cb of handlers) cb(); // the viewer leaves while the run is still going
    expect(rowsOf('sse_viewer_drop')).toHaveLength(1);
    expect(rowsOf('sse_viewer_drop')[0]).toMatchObject({ meta: { surface: 'attach', path: 'local', eventsWritten: 1, guest: false, runElapsedMs: expect.any(Number) } });
    endLiveRun('chat:c-local-drop');
  });

  it('4. an idle plain chat still gets the single interrupted complete (after the finished-run replay declines)', async () => {
    const res = mkRes();
    await controller.streamChatRun(mkReq('c-idle'), res);
    expect(sseEvents(res)).toEqual([{ type: 'complete', data: { interrupted: true } }]);
    expect(res.writableEnded).toBe(true);
    expect(mockAttachRemoteChatRun).not.toHaveBeenCalled();
    expect(mockReplayFinishedRemoteRun).toHaveBeenCalledWith(res, 'c-idle');
  });

  it('5. a just-finished peer-instance run replays from the mirror instead of the interrupted lie', async () => {
    mockReplayFinishedRemoteRun.mockResolvedValueOnce(true); // mirror held a fresh terminal and streamed it
    const res = mkRes();
    await controller.streamChatRun(mkReq('c-just-done'), res);
    expect(mockAttachRemoteChatRun).not.toHaveBeenCalled();
    // The controller writes nothing itself — the replay owned the stream.
    expect(sseEvents(res)).toEqual([]);
  });
});

describe('streamChatRun — back-compat ?message= guard (plain chats)', () => {
  it('409s on the CROSS-PROCESS busy truth, not just a local run', async () => {
    mockIsChatBusy.mockResolvedValue(true); // run on the other instance — no local registry entry
    const res = mkRes();
    await controller.streamChatRun(mkReq('c-guard-busy', { query: { message: 'hello' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already in progress/);
  });

  it('400s (send via POST) when the chat is genuinely idle', async () => {
    const res = mkRes();
    await controller.streamChatRun(mkReq('c-guard-idle', { query: { message: 'hello' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/POST \/api\/crossmodel\/stream/);
  });
});

/**
 * Stream drops (2026-10-20, owner "why does connection drop?") — streamQuery +
 * the ux beacon. Pins:
 *   1. the 20 s SSE heartbeat starts AT the header flush: a stalled pre-run
 *      await (here the staged-upload resolution) is covered by heartbeats, and
 *      once the run attaches there is still exactly ONE timer (one heartbeat
 *      per 20 s, never two); SSE_EARLY_HEARTBEAT_DISABLED=1 restores the old
 *      start (no heartbeat during the await);
 *   2. a viewer that closes BEFORE the final event while the run is active
 *      writes one throttled sse_viewer_drop row (surface stream, guest key
 *      anon-<sid>, no text); a close after the terminal, or with
 *      SSE_DROP_TELEMETRY_DISABLED=1, writes nothing;
 *   3. POST /ux/beacon accepts stream_drop / stream_resume with attempts /
 *      outcome / guest, throttles them per session, and records nothing under
 *      SSE_DROP_TELEMETRY_DISABLED=1 (other events unaffected).
 *
 * Every import-graph boundary is mocked like the guest-session suite
 * (config/env exits the process at import).
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
    crossModelChat: { findUnique: jest.fn() },
    crossModelMessage: { findMany: jest.fn() },
  },
}));
jest.mock('./crossmodel.service', () => ({ __esModule: true, default: {} }));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(), combineAttachments: jest.fn(() => null) }));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('./integrations/qwen-kid.integration', () => ({ streamKidResponse: jest.fn(), generateKidStatus: jest.fn() }));
jest.mock('./mcp-search', () => ({ searchWithBrightData: jest.fn() }));
jest.mock('./browser-agent', () => ({ runBrowserAgentSession: jest.fn() }));
jest.mock('./chat-agent/chat-gate', () => ({
  decideChatGate: jest.fn(() => ({ action: 'agent' })),
  mapAttachmentForAgent: jest.fn(() => ({ userImages: [], documentText: '' })),
  chatWriteAccessGranted: jest.fn(), chatReadAccessGranted: jest.fn(), streamAccessDeniedError: jest.fn(),
}));
jest.mock('./guest-location', () => ({ buildGuestLocationBlock: jest.fn(async () => undefined) }));
jest.mock('./integration-context', () => ({
  buildIntegrationContext: jest.fn(async () => ({ additionalContext: '', imessagePairedAgentId: null })),
  buildIntegrationContextBounded: jest.fn(async (build) => build()),
}));
jest.mock('./rate-limit.service', () => ({
  checkDeepResearchQuota: jest.fn(async () => ({ allowed: true, used: 0, limit: 2, remaining: 2 })), reserveDeepResearchQuota: jest.fn(), getDeepResearchDailyLimit: jest.fn(),
  getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
  getPatienceAutoOnly: jest.fn(async () => false),
}));
jest.mock('./coding/coding-data.service', () => ({ getChatCapability: jest.fn() }));
jest.mock('./chat-agent/chat-busy', () => ({ isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({ attachRemoteChatRun: jest.fn(), replayFinishedRemoteRun: jest.fn(async () => false) }));
jest.mock('./coding/coding-stream.controller', () => ({ __esModule: true, default: { streamRun: jest.fn() } }));
jest.mock('./chat-agent/guest-session-run', () => ({ isGuestSessionRunActive: jest.fn(async () => false) }));
jest.mock('./stream-registration', () => ({
  ...jest.requireActual('./stream-registration'),
  storeRegistration: jest.fn(async () => {}), consumeRegistration: jest.fn(async () => null),
  reserveRegistrationSlot: jest.fn(async () => true), releaseRegistrationSlot: jest.fn(async () => {}),
}));

const mockStartDetachedChatRun = jest.fn();
jest.mock('./chat-agent/chat-agent.service', () => ({
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatAgentRunKey: jest.fn(() => 'agent-key'),
}));
// The run stays live for the viewer: subscribeRun hands back an unsubscribe
// (the response stays open) and captures the emitter so a test can push the
// terminal. 'agent-key' (the pre-start busy check) is idle; the started run is active.
let emitToViewer: ((e: any) => void) | null = null;
const mockIsRunActive = jest.fn((k: string) => k === 'run-key-1');
jest.mock('./coding/live-runs', () => ({
  isRunActive: (k: string) => mockIsRunActive(k),
  subscribeRun: jest.fn((_k: string, emit: (e: any) => void) => { emitToViewer = emit; return () => { emitToViewer = null; }; }),
}));
// The stalled pre-run await (between the header flush and the old heartbeat start).
let releaseStaged: (() => void) | null = null;
const mockResolveStaged = jest.fn(() => new Promise((resolve) => { releaseStaged = () => resolve({ loaded: [], droppedCount: 0 }); }));
jest.mock('./attachment-resolution', () => ({
  resolveStagedUploads: (..._a: any[]) => mockResolveStaged(),
  attachmentDropAnnotation: jest.fn(() => ''),
}));
const mockRecordMetric: jest.Mock = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  ...jest.requireActual('./platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordMetric(...a),
}));

import controller from './crossmodel.controller';
import { __resetStreamMetricThrottle } from './chat-agent/stream-drops';

const SID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const mkReq = () => {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    req: {
      query: { message: 'Hello Digby', mode: 'single_thinking', webSearch: 'true', sessionId: SID },
      on: jest.fn((ev: string, cb: () => void) => { (handlers[ev] ??= []).push(cb); }),
    } as any,
    close: () => { for (const cb of handlers.close ?? []) cb(); },
  };
};
const mkRes = (): any => {
  const res: any = {
    statusCode: 200,
    frames: [] as string[],
    writableEnded: false,
    headersSent: false,
    status: jest.fn((c: number) => { res.statusCode = c; return res; }),
    json: jest.fn(() => res),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    cookie: jest.fn(),
    write: jest.fn((chunk: string) => { res.frames.push(chunk); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
  };
  return res;
};
const heartbeats = (res: any) => res.frames.filter((f: string) => f === ': heartbeat\n\n').length;
/** Let the controller's await chain (dynamic imports included) run until `cond` holds. */
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await jest.advanceTimersByTimeAsync(0);
  expect(cond()).toBe(true);
};
const drops = () => mockRecordMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'sse_viewer_drop');

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  __resetStreamMetricThrottle();
  emitToViewer = null;
  releaseStaged = null;
  mockFindUser.mockResolvedValue({ isChild: false });
  mockStartDetachedChatRun.mockResolvedValue('run-key-1');
  delete process.env.SSE_EARLY_HEARTBEAT_DISABLED;
  delete process.env.SSE_DROP_TELEMETRY_DISABLED;
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.SSE_EARLY_HEARTBEAT_DISABLED;
  delete process.env.SSE_DROP_TELEMETRY_DISABLED;
});

/** Start streamQuery and park it on the stalled staged-upload await. */
const startStalled = async () => {
  const { req, close } = mkReq();
  const res = mkRes();
  const done = controller.streamQuery(req, res, jest.fn());
  await until(() => mockResolveStaged.mock.calls.length > 0);
  return { req, res, close, done };
};
/** Release the stall and let the run attach (subscribeRun called). */
const releaseAndAttach = async (done: Promise<unknown>) => {
  releaseStaged!();
  await until(() => emitToViewer !== null);
  await done;
};

describe('streamQuery — the SSE heartbeat starts at the header flush (stream drops 2026-10-20)', () => {
  it('a stalled pre-run await is covered by heartbeats, and the attached run keeps exactly ONE timer', async () => {
    const { res, done } = await startStalled();
    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(heartbeats(res)).toBe(1); // the ALB's 60 s idle timer is fed before the run even starts
    await jest.advanceTimersByTimeAsync(20_000);
    expect(heartbeats(res)).toBe(2);
    await releaseAndAttach(done);
    const before = heartbeats(res);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(heartbeats(res)).toBe(before + 1); // one timer — the old site's start is a no-op now
    await jest.advanceTimersByTimeAsync(20_000);
    expect(heartbeats(res)).toBe(before + 2);
    emitToViewer!({ type: 'complete', data: {} });
    expect(res.writableEnded).toBe(true);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(heartbeats(res)).toBe(before + 2); // cleared with the response
  });

  it('SSE_EARLY_HEARTBEAT_DISABLED=1: no heartbeat during the pre-run await (the pre-fix start), one timer after', async () => {
    process.env.SSE_EARLY_HEARTBEAT_DISABLED = '1';
    const { res, done } = await startStalled();
    await jest.advanceTimersByTimeAsync(40_000);
    expect(heartbeats(res)).toBe(0);
    await releaseAndAttach(done);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(heartbeats(res)).toBe(1);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(heartbeats(res)).toBe(2);
  });
});

describe('streamQuery — sse_viewer_drop', () => {
  it('a viewer that leaves mid-run writes ONE row (surface stream, guest key, counts only — no text)', async () => {
    const { res, close, done } = await startStalled();
    await releaseAndAttach(done);
    emitToViewer!({ type: 'chunk', data: { content: 'secret words' } });
    emitToViewer!({ type: 'progress', data: { message: 'x' } });
    close();
    const rows = drops();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'sse_viewer_drop', sessionId: `anon-${SID}`, unit: 'ms',
      meta: { surface: 'stream', path: 'local', eventsWritten: 2, guest: true, host: expect.any(String) },
    });
    expect(JSON.stringify(rows[0])).not.toContain('secret');
    expect(res.writableEnded).toBe(false); // detach only — the run is untouched
  });

  it('a close AFTER the terminal is not a drop', async () => {
    const { close, done } = await startStalled();
    await releaseAndAttach(done);
    emitToViewer!({ type: 'complete', data: {} });
    close();
    expect(drops()).toHaveLength(0);
  });

  it('a close while the run is no longer active is not a drop', async () => {
    const { close, done } = await startStalled();
    await releaseAndAttach(done);
    mockIsRunActive.mockImplementation(() => false);
    close();
    expect(drops()).toHaveLength(0);
    mockIsRunActive.mockImplementation((k: string) => k === 'run-key-1');
  });

  it('SSE_DROP_TELEMETRY_DISABLED=1 writes nothing', async () => {
    process.env.SSE_DROP_TELEMETRY_DISABLED = '1';
    const { close, done } = await startStalled();
    await releaseAndAttach(done);
    close();
    expect(drops()).toHaveLength(0);
  });
});

describe('POST /ux/beacon — stream_drop / stream_resume', () => {
  const beacon = async (body: any, extra: any = {}) => {
    const res = mkRes();
    await controller.uxBeacon({ body, cookies: {}, ip: '10.0.0.1', ...extra } as any, res, jest.fn());
    return res;
  };
  const beaconRows = () => mockRecordMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'ux_beacon');

  it('records attempts / outcome / the client guest flag on the ux_beacon row', async () => {
    const res = await beacon({ event: 'stream_drop', sessionId: SID, ms: 9_000, attempts: 2, outcome: 'retrying', guest: true });
    expect(res.status).toHaveBeenCalledWith(204);
    expect(beaconRows()[0]).toMatchObject({ kind: 'ux_beacon', sessionId: `anon-${SID}`, value: 9_000, meta: { event: 'stream_drop', attempts: 2, outcome: 'retrying', guest: true } });
  });

  it('throttles a flapping client per session (a second drop inside the window records nothing) — resume is its own key', async () => {
    await beacon({ event: 'stream_drop', sessionId: SID, attempts: 0, outcome: 'retrying' });
    await beacon({ event: 'stream_drop', sessionId: SID, attempts: 0, outcome: 'retrying' });
    await beacon({ event: 'stream_resume', sessionId: SID, attempts: 1, outcome: 'resumed' });
    expect(beaconRows().map((r: any) => r.meta.event)).toEqual(['stream_drop', 'stream_resume']);
    // first_paint never rides the stream throttle.
    await beacon({ event: 'first_paint', sessionId: SID, ms: 1 });
    await beacon({ event: 'first_paint', sessionId: SID, ms: 1 });
    expect(beaconRows().filter((r: any) => r.meta.event === 'first_paint')).toHaveLength(2);
  });

  // Review 2026-10-20: the chat uuid in a beacon is never checked, so a client
  // can rotate it to slip the per-key throttle — the client itself (hashed,
  // hops-anchored ip; never req.ip, the ALB node) is capped instead.
  it('one client rotating chat uuids is capped per client; a second guest behind the same ALB node still records', async () => {
    process.env.QUOTA_TRUSTED_PROXY_HOPS = '2';
    try {
      const alb = '10.0.0.4';
      const chat = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      for (let i = 0; i < 20; i++) {
        await beacon({ event: 'stream_drop', chatId: chat(i), attempts: 0, outcome: 'retrying' }, { ip: alb, headers: { 'x-forwarded-for': `203.0.113.9, ${alb}` } });
      }
      expect(beaconRows()).toHaveLength(6);
      await beacon({ event: 'stream_drop', chatId: chat(99), attempts: 0, outcome: 'retrying' }, { ip: alb, headers: { 'x-forwarded-for': `198.51.100.7, ${alb}` } });
      expect(beaconRows()).toHaveLength(7);
      expect(beaconRows()[6].sessionId).toBe(chat(99));
    } finally {
      delete process.env.QUOTA_TRUSTED_PROXY_HOPS;
    }
  });

  it('SSE_DROP_TELEMETRY_DISABLED=1: stream beacons answer 204 and record nothing; other events still record', async () => {
    process.env.SSE_DROP_TELEMETRY_DISABLED = '1';
    const res = await beacon({ event: 'stream_drop', sessionId: SID, attempts: 0, outcome: 'retrying' });
    expect(res.status).toHaveBeenCalledWith(204);
    await beacon({ event: 'tap', target: 'escalate', sessionId: SID });
    expect(beaconRows().map((r: any) => r.meta.event)).toEqual(['tap']);
    expect(beaconRows()[0].meta).not.toHaveProperty('attempts');
  });
});

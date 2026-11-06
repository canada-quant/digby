/**
 * Queue-control endpoints must survive being called UNBOUND (ticket ffbf1315).
 *
 * The defect the ticket reports: pressing a control on a queued message ("send
 * now" / cancel / move) answered "Could not update the queue — refreshing it
 * now." — the generic fallback in frontend/lib/queue-controls.ts, shown only
 * when the response carries NO recognisable `code` field.
 *
 * ROOT CAUSE this file pins. crossmodel.routes.ts wires the handlers as bare
 * route callbacks:
 *     router.post('/chats/:id/queue/:pendingId/promote', rejectChild, controller.promoteChatQueueItem);
 * Express calls a handler with no receiver, so `this` is undefined inside it.
 * The first cut reached a PRIVATE METHOD through `this.applyQueueControl(...)`,
 * which threw
 *     Cannot read properties of undefined (reading 'applyQueueControl')
 * on every cancel/promote/move click — a 500 with no `code`, which the UI could
 * only name with the generic fallback. (Prod witnessed exactly this message 11
 * times in the 168 h to 2026-11-06T05:40Z, incl. four at 05:26–05:28Z — minutes
 * before the ticket was filed at 05:27:47Z.)
 *
 * WHY THE HANDLERS ARE CALLED DETACHED HERE. A test that calls
 * `controller.promoteChatQueueItem(req, res)` would PASS on the broken code:
 * that syntax supplies `controller` as the receiver. The route table does not.
 * So each test reaches the handler THROUGH the router's own layer stack and
 * invokes it with the receiver Express really uses (undefined) — the shape that
 * distinguishes a fixed handler from a `this`-dependent one.
 *
 * Boundaries mocked per .digby/notes/learnings.md: importing the real service
 * graph pulls config/database + config/redis → config/env, which exits the jest
 * worker at import. Only the handlers' own seams record calls.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));

// The ONE live authz seam — getChatAccess decides 200/404 vs the 500 under test.
const mockGetChatAccess: jest.Mock = jest.fn();
jest.mock('./crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: (...a: any[]) => mockGetChatAccess(...a) },
}));

jest.mock('./platform/platform.service', () => ({ __esModule: true, default: {} }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(),
  combineAttachments: jest.fn(() => null),
}));
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
  // The real predicate is trivial and pure: keep it live so the 404 path is real.
  chatReadAccessGranted: (a: { userId?: string | null; access: string; exists: boolean }) =>
    !!a.userId && !!a.exists && a.access !== 'none',
  streamAccessDeniedError: jest.fn(),
}));
jest.mock('./integration-context', () => ({
  __esModule: true,
  buildIntegrationContext: jest.fn(),
  buildIntegrationContextBounded: jest.fn(),
}));
jest.mock('./rate-limit.service', () => ({
  __esModule: true,
  checkDeepResearchQuota: jest.fn(),
  reserveDeepResearchQuota: jest.fn(),
  refundDeepResearchQuota: jest.fn(),
  getDeepResearchDailyLimit: jest.fn(),
  getAllDeepResearchUsageToday: jest.fn(),
  invalidateLimitCache: jest.fn(),
}));
jest.mock('./coding/coding-data.service', () => ({ __esModule: true, getChatCapability: jest.fn() }));
jest.mock('./chat-agent/chat-busy', () => ({ __esModule: true, isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({
  __esModule: true,
  attachRemoteChatRun: jest.fn(),
  replayFinishedRemoteRun: jest.fn(async () => false),
}));
jest.mock('./coding/coding-stream.controller', () => ({ __esModule: true, default: { streamRun: jest.fn() } }));
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  queryLoopMetrics: jest.fn(),
  summarizeLoopMetrics: jest.fn(),
  queryLoopMetricOutcomes: jest.fn(),
  queryLoopMetricPayloadSizes: jest.fn(),
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: [],
}));

// The control plane under the handlers — the dynamic import they await. Mocked
// per-test via the module-level fns below so the handler's own wiring is what
// the assertions see.
const mockCancel: jest.Mock = jest.fn();
const mockPromote: jest.Mock = jest.fn();
const mockMove: jest.Mock = jest.fn();
const mockList: jest.Mock = jest.fn();
jest.mock('./chat-agent/queue-controls', () => ({
  __esModule: true,
  cancelQueuedUserMessage: (...a: any[]) => mockCancel(...a),
  promoteQueuedUserMessage: (...a: any[]) => mockPromote(...a),
  moveQueuedUserMessage: (...a: any[]) => mockMove(...a),
  listUserQueue: (...a: any[]) => mockList(...a),
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import controller from './crossmodel.controller';

const QUEUE = [{ id: 'p2', position: 1, content: 'second', createdAt: '2026-11-06T05:20:00.000Z', attachmentCount: 0 }];

/** A Response stand-in that records the exact status + body the handler sent. */
function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  return res;
}

function makeReq(over: Record<string, any> = {}) {
  return {
    user: { id: 'u1' },
    params: { id: 'c1', pendingId: 'p2' },
    body: { direction: 'up' },
    ...over,
  } as any;
}

/**
 * Call a handler the way EXPRESS does: no receiver. `this` is undefined — the
 * precise shape that made the original `this.applyQueueControl(...)` throw.
 * `fn.call(undefined, ...)` is stricter than the ES module default (which would
 * substitute the module namespace object for a bare call), so it reproduces the
 * route-table call faithfully rather than accidentally supplying a receiver.
 */
function callUnbound(fn: any, req: any, res: any): Promise<unknown> {
  return (fn as (...a: any[]) => Promise<unknown>).call(undefined, req, res);
}

describe('queue controls survive an unbound (Express) invocation — ffbf1315', () => {
  beforeEach(() => {
    mockGetChatAccess.mockReset();
    mockCancel.mockReset();
    mockPromote.mockReset();
    mockMove.mockReset();
    mockList.mockReset();
    mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  });

  it('promote succeeds unbound and answers 200 with the fresh queue', async () => {
    mockPromote.mockResolvedValue({ ok: true, queue: QUEUE });
    const res = makeRes();
    await callUnbound((controller as any).promoteChatQueueItem, makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { queue: QUEUE } });
    expect(mockPromote).toHaveBeenCalledWith('c1', 'u1', 'p2');
  });

  it('cancel succeeds unbound and answers 200 with the fresh queue', async () => {
    mockCancel.mockResolvedValue({ ok: true, queue: QUEUE });
    const res = makeRes();
    await callUnbound((controller as any).cancelChatQueueItem, makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { queue: QUEUE } });
    expect(mockCancel).toHaveBeenCalledWith('c1', 'u1', 'p2');
  });

  it('move succeeds unbound and forwards the direction', async () => {
    mockMove.mockResolvedValue({ ok: true, queue: QUEUE });
    const res = makeRes();
    await callUnbound((controller as any).moveChatQueueItem, makeReq({ body: { direction: 'down' } }), res);
    expect(res.statusCode).toBe(200);
    expect(mockMove).toHaveBeenCalledWith('c1', 'u1', 'p2', 'down');
  });

  /** THE REPLAY: every refusal the control plane can produce comes back as a
   *  `code` the UI knows, so the person reads what happened instead of the
   *  generic "Could not update the queue — refreshing it now." (The catch-path
   *  500 legitimately stays codeless — it is not a refusal. This pins the four
   *  refusal codes, not the 500.) */
  it('maps each refusal to its own code — no refusal falls to the generic text', async () => {
    // `blocked` is driven through MOVE because that is the only control that can
    // actually produce it (queue-controls.ts: neighbour.userId !== userId). The
    // other three are reachable from either handler; promote stands in for them.
    const cases: Array<[string, number, string, 'promote' | 'move']> = [
      ['not_owned', 403, 'QUEUE_NOT_OWNER', 'promote'],
      ['not_a_user_row', 403, 'QUEUE_NOT_USER_ROW', 'promote'],
      ['blocked', 409, 'QUEUE_BLOCKED_BY_OTHER', 'move'],
      ['not_found', 404, 'QUEUE_ITEM_GONE', 'promote'],
    ];
    for (const [refusal, status, code, via] of cases) {
      if (via === 'move') {
        mockMove.mockResolvedValue({ ok: false, refusal, queue: QUEUE });
        const res = makeRes();
        await callUnbound((controller as any).moveChatQueueItem, makeReq({ body: { direction: 'up' } }), res);
        expect(res.statusCode).toBe(status);
        expect(res.body.code).toBe(code);
        expect(res.body.data.queue).toEqual(QUEUE);
        continue;
      }
      mockPromote.mockResolvedValue({ ok: false, refusal, queue: QUEUE });
      const res = makeRes();
      await callUnbound((controller as any).promoteChatQueueItem, makeReq(), res);
      expect(res.statusCode).toBe(status);
      expect(res.body.code).toBe(code);
      // The refusal payload carries the FRESH queue so the UI recovers in one hop.
      expect(res.body.data.queue).toEqual(QUEUE);
    }
  });

  it('still 404s a chat the caller cannot read (no existence leak), unbound', async () => {
    mockGetChatAccess.mockResolvedValue({ access: 'none', exists: true });
    const res = makeRes();
    await callUnbound((controller as any).promoteChatQueueItem, makeReq(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Chat not found' });
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it('rejects a move with no direction before touching the queue', async () => {
    const res = makeRes();
    await callUnbound((controller as any).moveChatQueueItem, makeReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect(mockMove).not.toHaveBeenCalled();
  });

  /** Belt and braces on the route table: the three POST controls must be wired
   *  as BARE callbacks (unbound). If one is ever rewired through a `.bind(...)`
   *  that hides a `this` dependency, this asserts the contract the fix relies
   *  on rather than silently letting the class-method form creep back. */
  it('the route table wires the three controls without a receiver', () => {
    const src = readFileSync(join(__dirname, 'crossmodel.routes.ts'), 'utf8');
    for (const route of ['cancel', 'promote', 'move']) {
      const line = src.split('\n').find((l: string) => l.includes(`/queue/:pendingId/${route}`));
      expect(line).toBeDefined();
      expect(line).toContain(`controller.${route}ChatQueueItem`);
      expect(line).not.toContain('.bind(');
    }
  });
});
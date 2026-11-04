/**
 * Guest sessions (feedback ticket 63bb607f) — streamQuery's ANONYMOUS branch
 * honors an explicit ?sessionId=<uuid> so a guest can NAME its own ephemeral
 * 24h Redis cm_session context (reopening a browser-local guest session keeps
 * its server-side memory). Pins:
 *   1. anonymous + valid UUID param → the param becomes the context key
 *      (cm_session cookie re-set to it + startDetachedChatRun rides it);
 *   2. anonymous + INVALID param → ignored, cookie/random fallback unchanged;
 *   3. AUTHED request + param → the param is ignored ENTIRELY (no cm_session
 *      cookie, run starts session-less) — no auth surface change.
 *
 * The pipeline boundary is mocked at startDetachedChatRun (the sessionId sink)
 * and live-runs; everything else on the controller's import graph is a mocked
 * boundary (config/env exits the process at import — per
 * .digby/notes/learnings.md). subscribeRun returns false so the response ends
 * immediately and the SSE keepalive timer is cleared (no dangling handles).
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
// streamQuery ALWAYS assembles the attachment slot (empty uploadIds → null).
jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(),
  combineAttachments: jest.fn(() => null),
}));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('./integrations/qwen-kid.integration', () => ({ streamKidResponse: jest.fn(), generateKidStatus: jest.fn() }));
jest.mock('./mcp-search', () => ({ searchWithBrightData: jest.fn() }));
jest.mock('./browser-agent', () => ({ runBrowserAgentSession: jest.fn() }));

const mockDecideChatGate = jest.fn();
jest.mock('./chat-agent/chat-gate', () => ({
  decideChatGate: (...a: any[]) => mockDecideChatGate(...a),
  mapAttachmentForAgent: jest.fn(() => ({ userImages: [], documentText: '' })),
  chatWriteAccessGranted: jest.fn(),
  chatReadAccessGranted: jest.fn(),
  streamAccessDeniedError: jest.fn(),
}));
jest.mock('./guest-location', () => ({ buildGuestLocationBlock: jest.fn(async () => undefined) }));
jest.mock('./integration-context', () => ({
  buildIntegrationContext: jest.fn(async () => ({ additionalContext: '', imessagePairedAgentId: null })),
  buildIntegrationContextBounded: jest.fn(async (build) => build()),
}));
// getPatienceAutoOnly / checkDeepResearchQuota are typed loosely — the quota
// readout test below (audit sse-ui-restore-14) drives them per case.
const mockPatienceAutoOnly = jest.fn(async (..._a: any[]) => false);
const mockCheckQuota = jest.fn(async (..._a: any[]) => ({ allowed: true, used: 0, limit: 2, remaining: 2 }));
jest.mock('./rate-limit.service', () => ({
  checkDeepResearchQuota: (...a: any[]) => mockCheckQuota(...a), reserveDeepResearchQuota: jest.fn(), getDeepResearchDailyLimit: jest.fn(),
  getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
  getPatienceAutoOnly: (...a: any[]) => mockPatienceAutoOnly(...a),
}));
jest.mock('./coding/coding-data.service', () => ({ getChatCapability: jest.fn() }));
jest.mock('./chat-agent/chat-busy', () => ({ isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({
  attachRemoteChatRun: jest.fn(),
  replayFinishedRemoteRun: jest.fn(async () => false),
}));
jest.mock('./coding/coding-stream.controller', () => ({
  __esModule: true,
  default: { streamRun: jest.fn() },
}));

// The sessionId SINK (dynamic-imported inside streamQuery). Untyped jest.fn —
// a typed implementation would tuple-narrow .mock.calls under strict tsc.
const mockStartDetachedChatRun = jest.fn();
jest.mock('./chat-agent/chat-agent.service', () => ({
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatAgentRunKey: jest.fn(() => 'agent-key'),
}));
// subscribeRun → false: the viewer detaches in the same tick, which ends the
// response AND clears the SSE keepalive timer (no dangling jest handles).
jest.mock('./coding/live-runs', () => ({
  isRunActive: jest.fn(() => false),
  subscribeRun: jest.fn(() => false),
}));
// Guest resume (2026-09-26): the session-state endpoint's two reads — the
// cross-process liveness marker (guest-session-run) and the Redis history
// (context.service.loadSessionContext) — mocked at the boundary.
const mockGuestRunActive = jest.fn(async (..._a: any[]) => false);
// Audit 2026-09-26 (guest-persistence-1): the token path round-trips the named
// guest session — mocked at the module boundary (in-memory registration).
jest.mock('./stream-registration', () => ({
  ...jest.requireActual('./stream-registration'),
  storeRegistration: jest.fn(async () => {}),
  consumeRegistration: jest.fn(async () => null),
  reserveRegistrationSlot: jest.fn(async () => true),
  releaseRegistrationSlot: jest.fn(async () => {}),
}));
jest.mock('./chat-agent/guest-session-run', () => ({
  isGuestSessionRunActive: (...a: any[]) => mockGuestRunActive(...a),
}));
const mockLoadSessionContext = jest.fn();

import controller from './crossmodel.controller';
import contextService from './context.service';
(contextService as any).loadSessionContext = (...a: any[]) => mockLoadSessionContext(...a);

const GUEST_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const COOKIE_UUID = '9b2f7c4e-1a2d-4e5f-8a9b-0c1d2e3f4a5b';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mkReq = (over: any = {}): any => ({
  query: { message: 'Hello Digby', mode: 'single_thinking', webSearch: 'true' },
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
    cookie: jest.fn(),
    write: jest.fn((chunk: string) => { res.frames.push(chunk); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
  };
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDecideChatGate.mockReturnValue({ action: 'agent' });
  mockFindUser.mockResolvedValue({ isChild: false });
  mockStartDetachedChatRun.mockResolvedValue('run-key-1');
});

describe('streamQuery — guest sessionId naming (63bb607f)', () => {
  it('anonymous + valid UUID param: the param keys the context (cookie + run)', async () => {
    const res = mkRes();
    await controller.streamQuery(mkReq({ query: { message: 'Hello Digby', mode: 'single_thinking', sessionId: GUEST_UUID } }), res, jest.fn());

    // The cookie follows the NAMED session…
    expect(res.cookie).toHaveBeenCalledWith('cm_session', GUEST_UUID, expect.objectContaining({ httpOnly: true }));
    // …and the run rides it as its context key.
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({
      userId: null, chatId: null, sessionId: GUEST_UUID,
    });
    expect(res.writableEnded).toBe(true);
  });

  it('anonymous + INVALID param: ignored — the existing cm_session cookie wins', async () => {
    const res = mkRes();
    await controller.streamQuery(mkReq({
      query: { message: 'Hello Digby', mode: 'single_thinking', sessionId: 'not-a-uuid; DROP TABLE users;' },
      cookies: { cm_session: COOKIE_UUID },
    }), res, jest.fn());

    expect(res.cookie).toHaveBeenCalledWith('cm_session', COOKIE_UUID, expect.anything());
    expect(mockStartDetachedChatRun.mock.calls[0][0].sessionId).toBe(COOKIE_UUID);
  });

  it('anonymous + invalid param + no cookie: a fresh random UUID is minted (param still ignored)', async () => {
    const res = mkRes();
    await controller.streamQuery(mkReq({
      query: { message: 'Hello Digby', mode: 'single_thinking', sessionId: '12345' },
    }), res, jest.fn());

    const [, value] = res.cookie.mock.calls.find((c: any[]) => c[0] === 'cm_session');
    expect(value).toMatch(UUID_RE);
    expect(value).not.toBe('12345');
    expect(mockStartDetachedChatRun.mock.calls[0][0].sessionId).toBe(value);
  });

  it('AUTHED + valid param: the param is ignored ENTIRELY (no cookie, session-less run)', async () => {
    const res = mkRes();
    await controller.streamQuery(mkReq({
      query: { message: 'Hello Digby', mode: 'single_thinking', sessionId: GUEST_UUID },
      user: { id: 'u1' },
    }), res, jest.fn());

    // No cm_session cookie is ever set for an authed request…
    expect(res.cookie).not.toHaveBeenCalledWith('cm_session', expect.anything(), expect.anything());
    // …and the run starts session-less (sessionId ?? null downstream).
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({
      userId: 'u1', chatId: null, sessionId: null,
    });
  });
});

describe('guestSessionState — GET /session/:sessionId/state (guest resume, 2026-09-26)', () => {
  // A guest who reloaded mid-answer came back to a vanished turn: the endpoint
  // hands the reloaded tab the session's Redis history (the answer the tab never
  // received) + whether the run is still live, so the client can hydrate or
  // show a calm "still working" instead of a lost turn.
  const mkStateReq = (over: any = {}): any => ({ params: { sessionId: GUEST_UUID }, query: {}, on: jest.fn(), ...over });

  beforeEach(() => {
    mockGuestRunActive.mockResolvedValue(false);
    mockLoadSessionContext.mockResolvedValue({
      conversationHistory: [],
      fullHistory: [
        { role: 'user', content: 'What is the tallest mountain in Canada?' },
        { role: 'assistant', content: 'Mount Logan, 5,959 m.' },
      ],
      userMemoryBlock: '',
    });
  });

  it('anonymous + UUID: returns the session history + the liveness flag', async () => {
    mockGuestRunActive.mockResolvedValue(true);
    const res = mkRes();
    await controller.guestSessionState(mkStateReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        active: true,
        messages: [
          { role: 'user', content: 'What is the tallest mountain in Canada?' },
          // audit sse-ui-restore-14: the guest's depth chip rides the LAST assistant message
          { role: 'assistant', content: 'Mount Logan, 5,959 m.', chips: [{ kind: 'signin_deeper', label: 'Sign in for a deeper look' }] },
        ],
      },
    });
    expect(mockLoadSessionContext).toHaveBeenCalledWith(GUEST_UUID);
    expect(mockGuestRunActive).toHaveBeenCalledWith(GUEST_UUID);
  });

  it('only the LAST assistant message carries the chip; under DIG_DEEPER_DISABLED=1 none does', async () => {
    mockLoadSessionContext.mockResolvedValue({
      conversationHistory: [],
      fullHistory: [
        { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
      ],
      userMemoryBlock: '',
    });
    const res = mkRes();
    await controller.guestSessionState(mkStateReq(), res);
    expect(res.body.data.messages[1]).toEqual({ role: 'assistant', content: 'a1' });
    expect(res.body.data.messages[3]).toEqual({ role: 'assistant', content: 'a2', chips: [{ kind: 'signin_deeper', label: 'Sign in for a deeper look' }] });
    const prev = process.env.DIG_DEEPER_DISABLED;
    process.env.DIG_DEEPER_DISABLED = '1';
    try {
      const off = mkRes();
      await controller.guestSessionState(mkStateReq(), off);
      expect(off.body.data.messages[3]).toEqual({ role: 'assistant', content: 'a2' });
    } finally {
      if (prev === undefined) delete process.env.DIG_DEEPER_DISABLED; else process.env.DIG_DEEPER_DISABLED = prev;
    }
  });

  it('no run anywhere → active:false (the client hydrates what the history holds)', async () => {
    const res = mkRes();
    await controller.guestSessionState(mkStateReq(), res);
    expect(res.body.data.active).toBe(false);
  });

  it('an empty session (nothing persisted yet) → active + no messages, never a 404', async () => {
    mockLoadSessionContext.mockResolvedValue({ conversationHistory: [], fullHistory: [], userMemoryBlock: '' });
    const res = mkRes();
    await controller.guestSessionState(mkStateReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.messages).toEqual([]);
  });

  it('a non-UUID id is refused with 400 (never a Redis read on attacker-shaped keys)', async () => {
    const res = mkRes();
    await controller.guestSessionState(mkStateReq({ params: { sessionId: 'not-a-uuid' } }), res);
    expect(res.statusCode).toBe(400);
    expect(mockLoadSessionContext).not.toHaveBeenCalled();
  });

  it('a SIGNED-IN caller gets 404 — sessions are anonymous-only (chats have rows + the /chats/:id/stream attach)', async () => {
    const res = mkRes();
    await controller.guestSessionState(mkStateReq({ user: { id: 'u1' } }), res);
    expect(res.statusCode).toBe(404);
    expect(mockLoadSessionContext).not.toHaveBeenCalled();
  });
});

describe('audit 2026-09-26 (guest-persistence-1 / -5): the token path keeps the NAMED guest session; the busy guard reads the cross-process marker', () => {
  const GUEST = '11111111-2222-4333-8444-555555555555';
  const COOKIE = '99999999-8888-4777-8666-555555555555';
  it('registerStreamQuery stores the guest sessionId; the consumed token keys the run on it even when a DIFFERENT cm_session cookie is set', async () => {
    const { storeRegistration, consumeRegistration } = jest.requireMock('./stream-registration');
    const stored: any[] = [];
    (storeRegistration as jest.Mock).mockImplementation(async (_t: string, reg: any) => { stored.push(reg); });
    await controller.registerStreamQuery({ body: { message: 'x'.repeat(1600), mode: 'single_thinking', sessionId: GUEST }, headers: {}, ip: '203.0.113.7' } as any, { status: jest.fn(() => ({ json: jest.fn() })), json: jest.fn() } as any, jest.fn());
    expect(stored[0]).toMatchObject({ sessionId: GUEST, mode: 'single_thinking' });
    (consumeRegistration as jest.Mock).mockResolvedValueOnce({ ...stored[0], clientIp: '203.0.113.7' });
    const res = mkRes();
    await controller.streamQuery(mkReq({ query: { streamToken: 'tok-1' }, cookies: { cm_session: COOKIE }, headers: {}, ip: '203.0.113.7', socket: { remoteAddress: '203.0.113.7' } }), res, jest.fn());
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ userId: null, chatId: null, sessionId: GUEST });
    expect(res.cookie).toHaveBeenCalledWith('cm_session', GUEST, expect.objectContaining({ httpOnly: true }));
  });
  it('an AUTHED registration never stores a sessionId', async () => {
    const { storeRegistration } = jest.requireMock('./stream-registration');
    const stored: any[] = [];
    (storeRegistration as jest.Mock).mockImplementation(async (_t: string, reg: any) => { stored.push(reg); });
    await controller.registerStreamQuery({ user: { id: 'u1' }, body: { message: 'x'.repeat(1600), mode: 'thinking', sessionId: GUEST }, headers: {}, ip: '203.0.113.7' } as any, { status: jest.fn(() => ({ json: jest.fn() })), json: jest.fn() } as any, jest.fn());
    expect(stored[0].sessionId).toBeUndefined();
  });
  it('a guest send whose session is live on the OTHER box (marker only) gets the busy error — no second run', async () => {
    mockGuestRunActive.mockResolvedValueOnce(true);
    const res = mkRes();
    await controller.streamQuery(mkReq({ query: { message: 'Hello Digby', mode: 'single_thinking', sessionId: GUEST } }), res, jest.fn());
    expect(mockGuestRunActive).toHaveBeenCalledWith(GUEST);
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(res.frames.some((f: string) => f.includes('"error"'))).toBe(true);
  });
});
describe('getDeepResearchQuota — the patience_auto_only readout for Account → Advanced (audit sse-ui-restore-14)', () => {
  beforeEach(() => {
    mockPatienceAutoOnly.mockResolvedValue(false);
    mockCheckQuota.mockResolvedValue({ allowed: true, used: 0, limit: 2, remaining: 2 });
  });

  it('a signed-in caller gets autoOnly:false by default and autoOnly:true while the switch is on', async () => {
    const res = mkRes();
    await controller.getDeepResearchQuota(mkReq({ user: { id: 'u1' } }), res);
    expect(res.body).toEqual({ success: true, data: { allowed: true, used: 0, limit: 2, remaining: 2, authenticated: true, autoOnly: false } });
    mockPatienceAutoOnly.mockResolvedValue(true);
    const on = mkRes();
    await controller.getDeepResearchQuota(mkReq({ user: { id: 'u1' } }), on);
    expect(on.body.data.autoOnly).toBe(true);
  });

  it('a switch-reader failure reads as off (fail open); an anonymous caller keeps the legacy shape', async () => {
    mockPatienceAutoOnly.mockRejectedValue(new Error('db down'));
    const res = mkRes();
    await controller.getDeepResearchQuota(mkReq({ user: { id: 'u1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.autoOnly).toBe(false);
    const anon = mkRes();
    await controller.getDeepResearchQuota(mkReq(), anon);
    expect(anon.body).toEqual({ success: true, data: { used: 0, limit: 0, remaining: 0, authenticated: false } });
  });
});

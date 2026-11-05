/**
 * PATCH /api/crossmodel/admin/feature-requests/:id — the dependsOnTicketIds
 * branch of adminUpdateFeatureRequest (9dacab1a round-1 review F7/F8/F9),
 * pinned directly on the handler with stubbed req/res (mirrors
 * crossmodel.controller.user-role.test.ts; prisma mocked via
 * jest.mock('../../config/database')).
 *
 * The admin REST path is the HUMAN writer for dependsOnTicketIds:
 *  - non-admin 403;
 *  - a DISPATCHED row is refused 409 BEFORE any validation (F9);
 *  - a cycle is refused 409 (setTicketDependencies);
 *  - a COMBINED payload (deps + status + adminNote) applies BOTH in ONE
 *    prisma updateMany call (F7);
 *  - a context conflict (the optimistic-concurrency guard matches 0 rows
 *    twice) is a clean 409, never a clobber (F8).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));

// In-memory userFeatureRequest table (findUnique/findMany/updateMany/update).
let tickets: Array<Record<string, any>> = [];
const mockFindUnique = jest.fn(async ({ where, select }: any) => {
  const r = tickets.find((t) => t.id === where.id);
  if (!r) return null;
  if (!select) return { ...r };
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(select)) if (v === true) out[k] = r[k];
  return out;
});
// The prefix tier's startsWith lookup — faithful to getFeedbackTicketById.
const mockPrefixFindMany = jest.fn(async ({ where, take }: any) => {
  const p = String(where?.id?.startsWith ?? '');
  return tickets.filter((t) => t.id.startsWith(p)).slice(0, take ?? 3);
});
const mockUpdateMany = jest.fn(async ({ where, data }: any) => {
  let count = 0;
  for (const r of tickets) {
    if (r.id !== where.id) continue;
    // The optimistic-concurrency guard: { context: { equals } } or the
    // OR-empty shape for an expected {} (SQL NULL matches equals:null).
    const have = r.context ?? null;
    if (where.context) {
      const want = where.context.equals;
      const eq = want === null ? have === null : JSON.stringify(have ?? {}) === JSON.stringify(want);
      if (!eq) continue;
    } else if (where.OR) {
      const eqEmpty = where.OR.some((b: any) => b.context && b.context.equals !== null && b.context.equals !== undefined
        && Object.keys(b.context.equals).length === 0 && JSON.stringify(have ?? {}) === '{}');
      const eqNull = where.OR.some((b: any) => b.context && b.context.equals === null && have === null);
      if (!eqEmpty && !eqNull) continue;
    }
    Object.assign(r, data, { updatedAt: new Date() });
    count++;
  }
  return { count };
});
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    userFeatureRequest: {
      findUnique: (...a: any[]) => mockFindUnique(a[0]),
      findMany: (...a: any[]) => mockPrefixFindMany(a[0]),
      updateMany: (...a: any[]) => mockUpdateMany(a[0]),
      update: jest.fn(async ({ where, data }: any) => {
        const r = tickets.find((t) => t.id === where.id);
        if (r) Object.assign(r, data);
        return r ?? null;
      }),
    },
  },
}));

// The controller's import chain pulls the REAL feedback.service (via
// error-handler → env validation → process.exit) — mock the module, with
// getFeedbackTicketById resolving from the in-memory table through the
// prisma mocks EXACTLY the way the real one does: exact id via findUnique,
// then the ≥8-char prefix tier via findMany({ where: { id: { startsWith } } })
// (unique → row; ambiguous → ambiguous; miss → not_found). Routing through
// the prisma mocks (not resolving in JS) is what lets the PREFIX test assert
// the prefix tier was actually consulted.
const fbSvc = {
  getFeedbackTicketById: jest.fn(async (id: string) => {
    const key = id.trim();
    if (!key) return { ok: false, reason: 'not_found' };
    const exact = await mockFindUnique({ where: { id: key } });
    if (exact) return { ok: true, ticket: { ...exact } };
    if (key.length < 8) return { ok: false, reason: 'not_found' };
    const byPrefix = await mockPrefixFindMany({ where: { id: { startsWith: key } }, take: 3 });
    if (byPrefix.length === 1) return { ok: true, ticket: { ...byPrefix[0] } };
    if (byPrefix.length > 1) return { ok: false, reason: 'ambiguous', candidates: byPrefix.map((t: any) => t.id) };
    return { ok: false, reason: 'not_found' };
  }),
};
jest.mock('./feedback/feedback.service', () => ({ __esModule: true, ...fbSvc, FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] }));

jest.mock('./crossmodel.service', () => ({ __esModule: true, default: {} }));
jest.mock('./model-endpoints/model-endpoints.service', () => ({ __esModule: true, resolveRegistryModel: jest.fn(async () => null) }));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(),
  combineAttachments: jest.fn(() => null),
}));
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
  decideChatGate: jest.fn(), mapAttachmentForAgent: jest.fn(),
  chatWriteAccessGranted: jest.fn(), chatReadAccessGranted: jest.fn(), streamAccessDeniedError: jest.fn(),
}));
jest.mock('./integration-context', () => ({ __esModule: true, buildIntegrationContext: jest.fn(async () => ({ additionalContext: undefined, imessagePairedAgentId: null })), buildIntegrationContextBounded: jest.fn(async (build: any) => build()) }));
jest.mock('./rate-limit.service', () => ({
  __esModule: true,
  checkDeepResearchQuota: jest.fn(), reserveDeepResearchQuota: jest.fn(), getDeepResearchDailyLimit: jest.fn(),
  getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
}));
jest.mock('./coding/coding-data.service', () => ({ __esModule: true, getChatCapability: jest.fn() }));
jest.mock('./chat-agent/chat-busy', () => ({ __esModule: true, isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({
  __esModule: true,
  attachRemoteChatRun: jest.fn(),
  replayFinishedRemoteRun: jest.fn(async () => false),
}));
jest.mock('./coding/coding-stream.controller', () => ({
  __esModule: true,
  default: { streamRun: jest.fn() },
}));
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  queryLoopMetrics: jest.fn(),
  summarizeLoopMetrics: jest.fn(),
}));

import controller from './crossmodel.controller';

const SELF = '9dacab1a-0000-4000-8000-000000000001';
const DEP = 'bbbbbbbb-0000-4000-8000-000000000002';
const ADMIN = { id: 'u-admin', role: 'ADMIN', email: 'admin@digby.ai' };
const MORTAL = { id: 'u-user', role: 'USER', email: 'user@digby.ai' };

const mkReq = (user: any, id: string, body: any): any => ({ user, params: { id }, body });
const mkRes = (): any => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn((b: any) => { res.body = b; return res; });
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  tickets = [];
});

describe('adminUpdateFeatureRequest — dependsOnTicketIds (9dacab1a F7/F8/F9)', () => {
  it('sets deps on an undispatched ticket: canonical ids stored in context, 200', async () => {
    tickets = [
      { id: SELF, status: 'open', context: {}, source: 'agent' },
      { id: DEP, status: 'open', context: {}, source: 'agent' },
    ];
    const res = mkRes();
    await controller.adminUpdateFeatureRequest(mkReq(ADMIN, SELF, { dependsOnTicketIds: [DEP] }), res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const stored = tickets.find((t) => t.id === SELF)!;
    expect(stored.context.dependsOnTicketIds).toEqual([DEP]);
    expect(res.body.data.dependsOnTicketIds).toEqual([DEP]);
  });

  it('PREFIX canonicalization end-to-end: an 8-char prefix input lands as the canonical FULL id', async () => {
    tickets = [
      { id: SELF, status: 'open', context: {}, source: 'agent' },
      { id: DEP, status: 'open', context: {}, source: 'agent' },
    ];
    const res = mkRes();
    // 'bbbbbbbb' is DEP's unique 8-char prefix — getFeedbackTicketById's
    // prefix tier (the mocked findMany startsWith) resolves it to the FULL
    // row, and the stored set holds the CANONICAL full id (F2).
    await controller.adminUpdateFeatureRequest(mkReq(ADMIN, SELF, { dependsOnTicketIds: [DEP.slice(0, 8)] }), res, jest.fn());
    expect(res.statusCode).toBe(200);
    const stored = tickets.find((t) => t.id === SELF)!;
    expect(stored.context.dependsOnTicketIds).toEqual([DEP]); // canonical, NOT 'bbbbbbbb'
    expect(mockPrefixFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { startsWith: 'bbbbbbbb' } } }));
  });

  it('non-admin 403 — nothing validated, nothing written', async () => {
    tickets = [{ id: SELF, status: 'open', context: {}, source: 'agent' }];
    const res = mkRes();
    await controller.adminUpdateFeatureRequest(mkReq(MORTAL, SELF, { dependsOnTicketIds: [DEP] }), res, jest.fn());
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain('admin access required');
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('a DISPATCHED row is refused 409 BEFORE validation (F9)', async () => {
    const otherLane = 'lane-ffffffff-0000-0000-0000000000ff';
    tickets = [{ id: SELF, status: 'in_progress', context: { dispatchedTo: otherLane, dispatchMode: 'ticket_lane' }, source: 'agent' }];
    const res = mkRes();
    await controller.adminUpdateFeatureRequest(mkReq(ADMIN, SELF, { dependsOnTicketIds: [DEP] }), res, jest.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain('dispatched to a lane');
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('a cycle is refused 409 (setTicketDependencies) — nothing written', async () => {
    // DEP already waits on SELF; setting SELF → DEP closes the loop.
    tickets = [
      { id: SELF, status: 'open', context: {}, source: 'agent' },
      { id: DEP, status: 'open', context: { dependsOnTicketIds: [SELF] }, source: 'agent' },
    ];
    const res = mkRes();
    await controller.adminUpdateFeatureRequest(mkReq(ADMIN, SELF, { dependsOnTicketIds: [DEP] }), res, jest.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain('cycle');
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('an unknown dep id is refused 404', async () => {
    tickets = [{ id: SELF, status: 'open', context: {}, source: 'agent' }];
    const res = mkRes();
    await controller.adminUpdateFeatureRequest(mkReq(ADMIN, SELF, { dependsOnTicketIds: ['ghost-0000-0000-00000000dead'] }), res, jest.fn());
    expect(res.statusCode).toBe(404);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('a self-reference is refused 400', async () => {
    tickets = [{ id: SELF, status: 'open', context: {}, source: 'agent' }];
    const res = mkRes();
    await controller.adminUpdateFeatureRequest(mkReq(ADMIN, SELF, { dependsOnTicketIds: [SELF] }), res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('COMBINED payload (deps + status + adminNote) applies BOTH in ONE updateMany call (F7)', async () => {
    tickets = [
      { id: SELF, status: 'open', context: {}, source: 'agent', adminNote: null, priority: 0 },
      { id: DEP, status: 'open', context: {}, source: 'agent' },
    ];
    const res = mkRes();
    await controller.adminUpdateFeatureRequest(mkReq(ADMIN, SELF, { dependsOnTicketIds: [DEP], status: 'in_progress', adminNote: 'owner gated this' }), res, jest.fn());
    expect(res.statusCode).toBe(200);
    // ONE write, both parts.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const data = mockUpdateMany.mock.calls[0][0].data;
    expect(data.context.dependsOnTicketIds).toEqual([DEP]);
    expect(data.status).toBe('in_progress');
    expect(data.adminNote).toBe('owner gated this');
    const stored = tickets.find((t) => t.id === SELF)!;
    expect(stored.status).toBe('in_progress');
    expect(stored.adminNote).toBe('owner gated this');
    expect(stored.context.dependsOnTicketIds).toEqual([DEP]);
  });

  it('CONTEXT-CONFLICT: a guard that matches 0 rows TWICE is a clean 409 — never a clobber (F8)', async () => {
    tickets = [
      { id: SELF, status: 'open', context: {}, source: 'agent' },
      { id: DEP, status: 'open', context: {}, source: 'agent' },
    ];
    // The guard never matches: a "winning writer" keeps mutating the row
    // between the handler's reads (simulate by making updateMany reject the
    // guard every time — the row's context moves before each attempt).
    mockUpdateMany.mockImplementation(async () => {
      // The winner's write lands "between" the handler's read and its write.
      const r = tickets.find((t) => t.id === SELF)!;
      r.context = { winner: `touched-${Date.now()}` };
      return { count: 0 };
    });
    const res = mkRes();
    await controller.adminUpdateFeatureRequest(mkReq(ADMIN, SELF, { dependsOnTicketIds: [DEP] }), res, jest.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain('changed while the dependencies were being written');
    // TWO guarded attempts — the initial write + exactly ONE retry.
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
    // The winner's field was never clobbered by the losing writer.
    expect(tickets.find((t) => t.id === SELF)!.context.winner).toBeDefined();
    expect(tickets.find((t) => t.id === SELF)!.context.dependsOnTicketIds).toBeUndefined();
  });

  it('the conflict RETRY lands when the fresh read agrees (the race resolves, one extra write)', async () => {
    tickets = [
      { id: SELF, status: 'open', context: {}, source: 'agent' },
      { id: DEP, status: 'open', context: {}, source: 'agent' },
    ];
    let calls = 0;
    mockUpdateMany.mockImplementation(async ({ where, data }: any) => {
      calls++;
      if (calls === 1) {
        // The winner lands, then the handler's fresh read sees THIS context.
        const r = tickets.find((t) => t.id === SELF)!;
        r.context = { winner: 'theirs' };
        return { count: 0 };
      }
      // The retry: guard on the fresh context {winner:'theirs'} → matches.
      const r = tickets.find((t) => t.id === SELF)!;
      if (JSON.stringify(r.context) !== JSON.stringify(where.context?.equals)) return { count: 0 };
      Object.assign(r, data, { updatedAt: new Date() });
      return { count: 1 };
    });
    const res = mkRes();
    await controller.adminUpdateFeatureRequest(mkReq(ADMIN, SELF, { dependsOnTicketIds: [DEP] }), res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
    const stored = tickets.find((t) => t.id === SELF)!;
    // The retry MERGED onto the winner's context — both survive.
    expect(stored.context.winner).toBe('theirs');
    expect(stored.context.dependsOnTicketIds).toEqual([DEP]);
    // The retry guarded on the fresh (winner's) context.
    expect(mockUpdateMany.mock.calls[1][0].where.context.equals).toEqual({ winner: 'theirs' });
  });

  it('ROUND-2 B2 (19e0c050): the conflict retry REFUSES when the fresh read shows the row was dispatched mid-race (409, no second write)', async () => {
    // The pre-fix retry re-applied the full {status, adminNote, priority,
    // context} payload against the fresh row unconditionally. Between the
    // first read and the fresh read the dispatcher can stamp dispatchedTo —
    // the retry would then write deps onto a row a lane now owns. The
    // re-check refuses instead; nothing is mutated by the retry.
    tickets = [
      { id: SELF, status: 'open', context: {}, source: 'agent' },
      { id: DEP, status: 'open', context: {}, source: 'agent' },
    ];
    let calls = 0;
    mockUpdateMany.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        // The guard misses AND the dispatcher stamps the row in the same
        // window — the handler's fresh read (findUnique below) must see it.
        const r = tickets.find((t) => t.id === SELF)!;
        r.context = { dispatchedTo: 'lane-eeeeeeee-0000-0000-0000000000ee', dispatchMode: 'ticket_lane' };
        return { count: 0 };
      }
      return { count: 1 };
    });
    const res = mkRes();
    await controller.adminUpdateFeatureRequest(mkReq(ADMIN, SELF, { dependsOnTicketIds: [DEP], adminNote: 'gate it' }), res, jest.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain('dispatched to a lane');
    // The retry write NEVER ran — one attempt only.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    // The dispatcher's stamp survived untouched: no deps, no adminNote.
    const stored = tickets.find((t) => t.id === SELF)!;
    expect(stored.context.dispatchedTo).toBe('lane-eeeeeeee-0000-0000-0000000000ee');
    expect(stored.context.dependsOnTicketIds).toBeUndefined();
    expect(stored.adminNote ?? null).toBeNull();
  });
});

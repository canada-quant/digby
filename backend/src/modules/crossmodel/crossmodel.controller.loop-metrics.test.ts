/**
 * GET /api/crossmodel/admin/loop-metrics (audit #12) — endpoint tests.
 *
 * Pins the admin posture (EXACTLY the /admin/job-health gate: role ADMIN or
 * the owner email, everyone else 403 before any DB work) and the response
 * contract both ways: no ?kind → compact all-kinds summary; ?kind= →
 * bucketed series with clamped hours + validated bucket unit; service
 * failure → 500, never a leak of the underlying error.
 *
 * The controller's import graph is mocked exactly like
 * crossmodel.controller.kid-serp.test.ts (config/env exits the process at
 * import — per .digby/notes/learnings.md); the loop-metrics service itself is
 * a mocked boundary here — its math is pinned in loop-metrics.service.test.ts.
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
jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(),
  combineAttachments: jest.fn(() => null),
}));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('./integrations/qwen-kid.integration', () => ({
  streamKidResponse: jest.fn(),
  generateKidStatus: jest.fn(),
}));
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

// The boundary under test's other side — math pinned in loop-metrics.service.test.ts.
const mockQueryLoopMetrics = jest.fn();
const mockSummarizeLoopMetrics = jest.fn();
const mockQueryOutcomes = jest.fn();
const mockQueryPayloads = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  queryLoopMetrics: (...a: any[]) => mockQueryLoopMetrics(...a),
  queryLoopMetricOutcomes: (...a: any[]) => mockQueryOutcomes(...a),
  queryLoopMetricPayloadSizes: (...a: any[]) => mockQueryPayloads(...a),
  summarizeLoopMetrics: (...a: any[]) => mockSummarizeLoopMetrics(...a),
}));

import controller from './crossmodel.controller';

const mkReq = (user: any, query: Record<string, string> = {}): any => ({ user, query });
const mkRes = (): any => {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    status: jest.fn((c: number) => { res.statusCode = c; return res; }),
    json: jest.fn((b: any) => { res.body = b; return res; }),
  };
  return res;
};

const ADMIN = { id: 'u-admin', role: 'ADMIN', email: 'admin@digby.example.com' };
const OWNER = { id: 'u-paul', role: 'USER', email: 'paul@sunday.market' };
const MORTAL = { id: 'u-user', role: 'USER', email: 'user@digby.example.com' };

beforeEach(() => {
  jest.clearAllMocks();
  mockSummarizeLoopMetrics.mockResolvedValue([{ kind: 'guard_strike', count: 3, sum: 7 }]);
  mockQueryLoopMetrics.mockResolvedValue([
    { bucket: '2026-09-02T10:00:00.000Z', kind: 'guard_strike', count: 3, sum: 7, avg: 2.3333 },
  ]);
  mockQueryOutcomes.mockResolvedValue(null);
  mockQueryPayloads.mockResolvedValue([]);
});

describe('getAdminLoopMetrics — admin posture (mirrors /admin/job-health)', () => {
  it('403s an anonymous request before touching the service', async () => {
    const res = mkRes();
    await controller.getAdminLoopMetrics(mkReq(undefined), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
    expect(mockSummarizeLoopMetrics).not.toHaveBeenCalled();
    expect(mockQueryLoopMetrics).not.toHaveBeenCalled();
  });

  it('403s a non-admin user', async () => {
    const res = mkRes();
    await controller.getAdminLoopMetrics(mkReq(MORTAL, { kind: 'guard_strike' }), res);
    expect(res.statusCode).toBe(403);
    expect(mockQueryLoopMetrics).not.toHaveBeenCalled();
  });

  it('admits role ADMIN and the owner email alike', async () => {
    for (const user of [ADMIN, OWNER]) {
      const res = mkRes();
      await controller.getAdminLoopMetrics(mkReq(user), res);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
    }
  });
});

describe('getAdminLoopMetrics — response contract', () => {
  it('no ?kind → compact all-kinds summary over 24h by default', async () => {
    const res = mkRes();
    await controller.getAdminLoopMetrics(mkReq(ADMIN), res);
    expect(mockSummarizeLoopMetrics).toHaveBeenCalledWith(24);
    expect(mockQueryLoopMetrics).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      success: true,
      data: { mode: 'summary', hours: 24, kinds: [{ kind: 'guard_strike', count: 3, sum: 7 }] },
    });
  });

  it('?kind= → bucketed series, passing kind/hours/bucket through', async () => {
    const res = mkRes();
    await controller.getAdminLoopMetrics(mkReq(ADMIN, { kind: 'guard_strike', hours: '48', bucket: 'day' }), res);
    expect(mockQueryLoopMetrics).toHaveBeenCalledWith('guard_strike', { hours: 48, bucket: 'day' });
    // Ticket d59499f4: the REST twin carries the same aggregate the tool view
    // does, so the two surfaces cannot drift.
    expect(mockQueryOutcomes).toHaveBeenCalledWith('guard_strike', { hours: 48, bucket: 'day' });
    expect(mockQueryPayloads).toHaveBeenCalledWith('guard_strike', { hours: 48 });
    expect(res.body).toEqual({
      success: true,
      data: {
        mode: 'series',
        kind: 'guard_strike',
        hours: 48,
        bucket: 'day',
        buckets: [{ bucket: '2026-09-02T10:00:00.000Z', kind: 'guard_strike', count: 3, sum: 7, avg: 2.3333 }],
        outcomes: null,
        payloadSizes: null,
      },
    });
  });

  it('returns the ok/fail aggregate grouped by unit, and never fails the counts with it', async () => {
    mockQueryOutcomes.mockResolvedValueOnce({
      flag: 'ok',
      buckets: [{ bucket: '2026-09-02T10:00:00.000Z', unit: 'attempt', total: 7, ok: 6, fail: 1, unlabeled: 0, rate: 0.8571 }],
      byUnit: [{ unit: 'attempt', total: 7, ok: 6, fail: 1, unlabeled: 0, rate: 0.8571 }],
      window: { total: 7, ok: 6, fail: 1, unlabeled: 0, rate: 0.8571 },
    });
    mockQueryPayloads.mockResolvedValueOnce([{ unit: 'attempt', field: 'chars', n: 7, p50: 1200, p95: 7800, max: 9100, avg: 2100 }]);
    const res = mkRes();
    await controller.getAdminLoopMetrics(mkReq(ADMIN, { kind: 'rag_embed_call' }), res);
    expect(res.body.data.outcomes.window).toMatchObject({ total: 7, ok: 6, fail: 1, rate: 0.8571 });
    expect(res.body.data.payloadSizes[0]).toMatchObject({ field: 'chars', p95: 7800 });

    // A broken aggregate read leaves it null — the counts still answer.
    mockQueryOutcomes.mockRejectedValueOnce(new Error('pg: boom'));
    mockQueryPayloads.mockRejectedValueOnce(new Error('pg: boom'));
    const res2 = mkRes();
    await controller.getAdminLoopMetrics(mkReq(ADMIN, { kind: 'rag_embed_call' }), res2);
    expect(res2.statusCode).toBe(200);
    expect(res2.body.data.buckets).toHaveLength(1);
    expect(res2.body.data.outcomes).toBeNull();
    expect(res2.body.data.payloadSizes).toBeNull();
  });

  it('sanitizes params: hours clamped to [1, 2160], junk bucket → hour, blank kind → summary', async () => {
    const res1 = mkRes();
    await controller.getAdminLoopMetrics(mkReq(ADMIN, { kind: 'run_spend', hours: '999999', bucket: 'fortnight' }), res1);
    expect(mockQueryLoopMetrics).toHaveBeenCalledWith('run_spend', { hours: 2160, bucket: 'hour' });

    const res2 = mkRes();
    await controller.getAdminLoopMetrics(mkReq(ADMIN, { kind: 'run_spend', hours: '-5' }), res2);
    expect(mockQueryLoopMetrics).toHaveBeenLastCalledWith('run_spend', { hours: 1, bucket: 'hour' });

    const res3 = mkRes();
    await controller.getAdminLoopMetrics(mkReq(ADMIN, { kind: '   ' }), res3);
    expect(mockSummarizeLoopMetrics).toHaveBeenCalledTimes(1);
    expect(res3.body.data.mode).toBe('summary');
  });

  it('a service failure maps to a bare 500 (no error detail leak)', async () => {
    mockSummarizeLoopMetrics.mockRejectedValueOnce(new Error('pg: relation does not exist'));
    const res = mkRes();
    await controller.getAdminLoopMetrics(mkReq(ADMIN), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to get loop metrics' });
  });
});

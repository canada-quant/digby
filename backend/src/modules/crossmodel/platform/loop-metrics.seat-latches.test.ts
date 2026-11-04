/**
 * 2026-09-27 seat/provider limits — listActiveSeatLatches: the DB-backed view of
 * seats LATCHED off by a deterministic invalid-request rejection (the newest
 * seat_fallback row per (role, from) whose meta.latchedUntil is still ahead),
 * read by the admin Model roles page, the owner briefing and the project status
 * card. Plus the noteSeatFallback meta extension (fingerprint + latchedUntil).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockCreateMany: jest.Mock = jest.fn(async () => ({ count: 1 }));
const mockFindMany: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    loopMetric: {
      createMany: (...a: any[]) => mockCreateMany(...a),
      findMany: (...a: any[]) => mockFindMany(...a),
      deleteMany: jest.fn(),
      groupBy: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
}));

import { listActiveSeatLatches, noteSeatFallback, flushLoopMetrics } from './loop-metrics.service';

const NOW = Date.parse('2026-09-27T19:00:00.000Z');
const row = (createdAt: string, meta: Record<string, unknown>) => ({ createdAt: new Date(createdAt), meta });

beforeEach(() => { jest.clearAllMocks(); });

describe('listActiveSeatLatches', () => {
  it('returns the live latch per (role, from) with since = the oldest live row, ignores expired / unlatched rows', async () => {
    mockFindMany.mockResolvedValueOnce([
      // newest first, as the query orders them
      row('2026-09-27T18:45:00.000Z', { role: 'supervisor', from: 'cql-litellm:api-openai-gpt-6-astra', to: 'glm-5.3', reason: 'invalid_request:reasoning_effort_unsupported (latched) — …', fingerprint: 'reasoning_effort_unsupported', latchedUntil: '2026-09-27T19:15:00.000Z', status: 'retrying' }),
      row('2026-09-27T18:40:00.000Z', { role: 'supervisor', from: 'cql-litellm:api-openai-gpt-6-astra', to: 'glm-5.3', reason: 'invalid_request:reasoning_effort_unsupported — …', fingerprint: 'reasoning_effort_unsupported', latchedUntil: '2026-09-27T19:10:00.000Z', status: 'retrying' }),
      row('2026-09-27T18:30:00.000Z', { role: 'supervisor', from: 'cql-litellm:api-openai-gpt-6-astra', to: 'glm-5.3', reason: 'HTTP 429', status: 'retrying' }), // no latch → ignored
      row('2026-09-27T17:00:00.000Z', { role: 'coding_default', from: 'spark:qwen', to: 'glm-5.3', reason: 'invalid_request:tools_unsupported', fingerprint: 'tools_unsupported', latchedUntil: '2026-09-27T17:30:00.000Z' }), // expired
      row('2026-09-27T18:50:00.000Z', { seat: 'chat_orchestrator', from: 'x:y', to: 'kimi-k3', reason: 'invalid_request:model_not_found — …', fingerprint: 'model_not_found', latchedUntil: '2026-09-27T19:20:00.000Z' }), // orchestrator shape (meta.seat)
      row('2026-09-27T18:55:00.000Z', { role: 'supervisor', to: 'glm-5.3', reason: 'no from', latchedUntil: '2026-09-27T19:20:00.000Z' }), // no from → ignored
    ]);
    const latches = await listActiveSeatLatches(NOW);
    expect(latches).toEqual([
      { role: 'supervisor', from: 'cql-litellm:api-openai-gpt-6-astra', to: 'glm-5.3', reason: 'invalid_request:reasoning_effort_unsupported (latched) — …', fingerprint: 'reasoning_effort_unsupported', since: '2026-09-27T18:40:00.000Z', until: '2026-09-27T19:15:00.000Z' },
      { role: 'chat_orchestrator', from: 'x:y', to: 'kimi-k3', reason: 'invalid_request:model_not_found — …', fingerprint: 'model_not_found', since: '2026-09-27T18:50:00.000Z', until: '2026-09-27T19:20:00.000Z' },
    ]);
    const q = mockFindMany.mock.calls[0][0];
    expect(q.where.kind).toBe('seat_fallback');
    expect(q.orderBy).toEqual({ createdAt: 'desc' });
    expect(q.take).toBe(2000);
  });

  it('is [] when nothing is latched and propagates DB errors (callers fail open)', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    expect(await listActiveSeatLatches(NOW)).toEqual([]);
    mockFindMany.mockRejectedValueOnce(new Error('db down'));
    await expect(listActiveSeatLatches(NOW)).rejects.toThrow('db down');
  });
});

describe('noteSeatFallback meta (2026-09-27 extension)', () => {
  it('carries fingerprint + latchedUntil when given, bounded, and nothing else new when absent', async () => {
    noteSeatFallback({ role: 'supervisor', from: 'a:b', to: 'glm-5.3', reason: 'invalid_request:tools_too_long — x', status: 'retrying', httpStatus: 400, fingerprint: 'tools_too_long', latchedUntil: '2026-09-27T19:15:00.000Z' });
    noteSeatFallback({ role: 'supervisor', from: 'a:b', to: 'glm-5.3', reason: 'HTTP 429', status: 'retrying', httpStatus: 429 });
    await flushLoopMetrics();
    const rows = mockCreateMany.mock.calls.flatMap((c: any[]) => c[0].data);
    expect(rows).toHaveLength(2);
    expect(rows[0].meta).toMatchObject({ role: 'supervisor', fingerprint: 'tools_too_long', latchedUntil: '2026-09-27T19:15:00.000Z', httpStatus: 400 });
    expect(rows[1].meta).not.toHaveProperty('fingerprint');
    expect(rows[1].meta).not.toHaveProperty('latchedUntil');
  });
});

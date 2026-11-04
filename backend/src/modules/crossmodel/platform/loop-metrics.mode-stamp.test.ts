/**
 * Patience plan 1a (2026-09-25) — the MetricStamp carries `mode` +
 * `routingSource` so run_spend / run_tokens rows read cost per level (and per
 * routing judge) without a join to chat_search_usage; a site's own meta.mode
 * still wins over the stamp; the new `deep_research_quota_rejected` kind is
 * registered. Prisma + logger mocked (loop-metrics.service.test.ts pattern).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockCreateMany: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { loopMetric: { createMany: (...a: any[]) => mockCreateMany(...a) } },
}));

import { LOOP_METRIC_KINDS, recordLoopMetric, recordRunSpend, flushLoopMetrics, __resetLoopMetricsForTest, type MetricStamp } from './loop-metrics.service';

const flushedRows = (): any[] => mockCreateMany.mock.calls.flatMap((c: any[]) => c[0].data);

beforeEach(() => {
  jest.clearAllMocks();
  __resetLoopMetricsForTest();
  mockCreateMany.mockResolvedValue({ count: 0 });
});

const stamp: MetricStamp = { model: 'kimi-k3', profile: 'chat', triggerKind: 'user', mode: 'thinking', routingSource: 'auto_heuristic' };

it('run_spend and run_tokens rows carry the stamp\'s mode + routingSource', async () => {
  recordRunSpend('run-1', 'chat-1', {
    totalInTokens: 10, totalOutTokens: 5, totalCostUsd: 0.01, turns: 1,
    agents: [{ model: 'kimi-k3', inTokens: 10, outTokens: 5, costUsd: 0.01, role: 'lead', agent: 'Digby' }],
  } as any, stamp);
  await flushLoopMetrics();
  const rows = flushedRows();
  const spend = rows.find(r => r.kind === LOOP_METRIC_KINDS.RUN_SPEND);
  const tokensIn = rows.find(r => r.kind === LOOP_METRIC_KINDS.RUN_TOKENS_IN);
  expect(spend.meta).toMatchObject({ model: 'kimi-k3', provider: 'moonshot', profile: 'chat', triggerKind: 'user', mode: 'thinking', routingSource: 'auto_heuristic' });
  expect(tokensIn.meta).toMatchObject({ mode: 'thinking', routingSource: 'auto_heuristic' });
});

it('a site\'s explicit meta.mode wins over the stamp; an unstamped row has neither key', async () => {
  recordLoopMetric({ kind: LOOP_METRIC_KINDS.CHAT_SEARCH_USAGE, sessionId: 's', stamp, meta: { mode: 'deep_research', webToolCalls: 0 } });
  recordLoopMetric({ kind: LOOP_METRIC_KINDS.CHAT_SEARCH_USAGE, sessionId: 's', meta: { webToolCalls: 0 } });
  await flushLoopMetrics();
  const [a, b] = flushedRows();
  expect(a.meta).toMatchObject({ mode: 'deep_research', routingSource: 'auto_heuristic' });
  expect(b.meta.mode).toBeUndefined();
  expect(b.meta.routingSource).toBeUndefined();
});

it('deep_research_quota_rejected is a registered kind and records with its meta', async () => {
  expect(LOOP_METRIC_KINDS.DEEP_RESEARCH_QUOTA_REJECTED).toBe('deep_research_quota_rejected');
  recordLoopMetric({ kind: LOOP_METRIC_KINDS.DEEP_RESEARCH_QUOTA_REJECTED, sessionId: 'c1', meta: { scope: 'anon', anon: true, mode: 'deep_research', limit: 2, used: 2, autoOnly: false, demoted: false } });
  await flushLoopMetrics();
  expect(flushedRows()[0]).toMatchObject({ kind: 'deep_research_quota_rejected', meta: { scope: 'anon', anon: true } });
});

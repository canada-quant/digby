/**
 * decision-gate-spend.ts — the pure composer behind the API-costs "Decision
 * gate" block (2026-09-28): calls vs priced calls, USD per backend / purpose,
 * p50, the what-it-replaced estimate and the pricing facts the panel prints.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: { $queryRaw: jest.fn(async () => []) } }));
jest.mock('./loop-metrics.service', () => ({ LOOP_METRIC_KINDS: {}, recordLoopMetric: jest.fn(), recordLoopMetrics: jest.fn() }));

import { REPLACED_BASIS, composeDecisionSpendSummary, decisionSpendSummary, decisionSpendByPurpose24h } from './decision-gate-spend';

const since = new Date('2026-09-27T00:00:00.000Z');

describe('composeDecisionSpendSummary', () => {
  it('joins calls (decision rows) with priced calls (run_spend rows) per backend and per purpose, keeps the gap visible, sums the totals', () => {
    const s = composeDecisionSpendSummary({
      windowDays: 7, since,
      callsByBackend: [{ key: 'TypeSafe Jev', calls: 13_743, inputTokens: 12_270_000, p50Ms: 164 }, { key: 'DeepSeek logprob readout', calls: 40, inputTokens: 90_000, p50Ms: 900 }],
      callsByPurpose: [{ key: 'wake_triage', calls: 9_000, inputTokens: 8_000_000, p50Ms: 150 }, { key: 'auto_route', calls: 4_783, inputTokens: 4_360_000, p50Ms: 180 }],
      spendByBackend: [{ key: 'TypeSafe Jev', pricedCalls: 5_799, usd: 0.2436, inTokens: 5_800_000, priceSource: 'list', unpriced: false, model: 'jev-1.13.0' }],
      spendByPurpose: [{ key: 'wake_triage', pricedCalls: 5_799, usd: 0.2436, inTokens: 5_800_000, priceSource: 'list', unpriced: false, model: 'jev-1.13.0' }],
      memoHits: 321,
      avoided: [{ purpose: 'wake_triage', avoided: 89 }, { purpose: 'sweep_triage', avoided: 12 }, { purpose: 'supervisor_turn_noop', avoided: 0 }],
      runMeans: [{ triggerKind: 'hook', meanUsd: 0.61, runs: 400 }],
    });
    expect(s.totals).toEqual({ calls: 13_783, pricedCalls: 5_799, memoHits: 321, inputTokens: 12_360_000, usd: 0.2436 });
    expect(s.byBackend[0]).toMatchObject({ backend: 'TypeSafe Jev', model: 'jev-1.13.0', calls: 13_743, pricedCalls: 5_799, inputTokens: 12_270_000, usd: 0.2436, p50Ms: 164, priceSource: 'list', unpriced: false });
    // A backend with calls but no spend rows yet (pre-backfill history) still lists — at $0 with 0 priced calls.
    expect(s.byBackend[1]).toMatchObject({ backend: 'DeepSeek logprob readout', calls: 40, pricedCalls: 0, usd: 0, p50Ms: 900, priceSource: null });
    expect(s.byPurpose.map(p => p.purpose)).toEqual(['wake_triage', 'auto_route']);
    expect(s.byPurpose[1]).toMatchObject({ calls: 4_783, pricedCalls: 0, usd: 0 });
    // What it replaced: only purposes with avoided rows; the hook mean prices a parked wake; a schedule mean is absent → estimate null.
    expect(s.replaced).toHaveLength(2);
    expect(s.replaced[0]).toMatchObject({ purpose: 'wake_triage', unit: 'parked hook wake', avoided: 89, meanRunUsd: 0.61, runsSampled: 400, estimateUsd: 54.29 });
    expect(s.replaced[1]).toMatchObject({ purpose: 'sweep_triage', avoided: 12, meanRunUsd: null, runsSampled: 0, estimateUsd: null });
    expect(s.replaced[0].basis).toContain('mean run_spend');
    expect(s.pricing.typesafe).toMatchObject({ usdPerMTokIn: 0.042, usdPerMTokOut: 0, source: 'list', url: 'https://docs.typesafe.ai/models' });
    expect(s.pricing).toMatchObject({ envIn: 'TYPESAFE_USD_PER_MTOK_IN', envOut: 'TYPESAFE_USD_PER_MTOK_OUT' });
    expect(s.since).toBe(since.toISOString());
  });

  it('a self-hosted backend rides through as unpriced; an empty window is an empty (never null) block', () => {
    const s = composeDecisionSpendSummary({
      windowDays: 1, since, callsByBackend: [{ key: 'cql-litellm (systemone chat)', calls: 5, inputTokens: 0, p50Ms: 300 }], callsByPurpose: [],
      spendByBackend: [{ key: 'cql-litellm (systemone chat)', pricedCalls: 5, usd: 0, inTokens: 4_000, priceSource: 'self_hosted', unpriced: true, model: 'cql-litellm:agx-laya' }],
      spendByPurpose: [], memoHits: 0, avoided: [], runMeans: [],
    });
    // inputTokens = max(decision-row tokens, spend-row tokens): the estimate covers a backend that reports no usage.
    expect(s.byBackend[0]).toMatchObject({ unpriced: true, priceSource: 'self_hosted', inputTokens: 4_000, usd: 0 });
    const e = composeDecisionSpendSummary({ windowDays: 1, since, callsByBackend: [], callsByPurpose: [], spendByBackend: [], spendByPurpose: [], memoHits: 0, avoided: [], runMeans: [] });
    expect(e.totals).toEqual({ calls: 0, pricedCalls: 0, memoHits: 0, inputTokens: 0, usd: 0 });
    expect(e.byBackend).toEqual([]);
    expect(e.replaced).toEqual([]);
  });

  it('REPLACED_BASIS names the run kind each avoided unit stands in for', () => {
    expect(REPLACED_BASIS.wake_triage.triggerKind).toBe('hook');
    expect(REPLACED_BASIS.sweep_triage.triggerKind).toBe('schedule');
    expect(REPLACED_BASIS.supervisor_turn_noop.triggerKind).toBe('schedule');
  });
});

describe('the DB readers fail open', () => {
  it('decisionSpendSummary returns the empty block when the query throws; decisionSpendByPurpose24h returns an empty map', async () => {
    const prisma = (await import('../../../config/database')).default as any;
    prisma.$queryRaw.mockRejectedValue(new Error('relation missing'));
    const s = await decisionSpendSummary({ since, windowDays: 3 });
    expect(s.totals.calls).toBe(0);
    expect(s.windowDays).toBe(3);
    const m = await decisionSpendByPurpose24h();
    expect(m.size).toBe(0);
  });
});

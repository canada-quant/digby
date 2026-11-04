/**
 * build 2026-10-08 C — cache-aware cost per run. context.md §1.7: "Admin → API
 * costs shows a cache % but no cache-aware dollars." Every metered turn now
 * carries the dollars the provider prompt cache saved (the cached share billed
 * at the documented cached rate instead of the miss rate), and the run_spend
 * row says what the cache saved and what the run would have cost without it.
 * Expected values derive from priceFor, so a price-table edit never breaks this.
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

import { UsageAccumulator, cacheSavedUsd, priceFor } from './cost';
import { recordRunSpend, flushLoopMetrics, __resetLoopMetricsForTest } from '../platform/loop-metrics.service';

const flushed = (): any[] => mockCreateMany.mock.calls.flatMap((c: any[]) => c[0].data);

beforeEach(() => {
  jest.clearAllMocks();
  __resetLoopMetricsForTest();
  mockCreateMany.mockResolvedValue({ count: 0 });
  delete process.env.PROMPT_CACHE_METRICS_DISABLED;
});
afterEach(() => { delete process.env.PROMPT_CACHE_METRICS_DISABLED; });

describe('cacheSavedUsd', () => {
  it('prices the cached share at (miss − cached) rate for a model with a documented cached rate', () => {
    const p = priceFor('kimi-k3');
    expect(p.cachedIn).toBeDefined();
    const saved = cacheSavedUsd('kimi-k3', { promptTokens: 100_000, completionTokens: 1_000, cachedTokens: 90_000, estimated: false });
    expect(saved).toBeCloseTo((90_000 * (p.in - p.cachedIn!)) / 1e6, 9);
    expect(saved).toBeGreaterThan(0);
  });

  it('0 with no cached tokens, or when the model documents no cached rate (the meter bills hits at the full rate)', () => {
    expect(cacheSavedUsd('kimi-k3', { promptTokens: 100_000, completionTokens: 1, estimated: false })).toBe(0);
    const noRate = 'some-unpriced-model';
    const expected = priceFor(noRate).cachedIn === undefined ? 0 : 1; // DEFAULT_PRICE documents none
    expect(Math.sign(cacheSavedUsd(noRate, { promptTokens: 10_000, completionTokens: 1, cachedTokens: 9_000, estimated: false }))).toBe(expected);
  });

  it('UsageAccumulator rows carry cacheSavedUsd only when the cache saved something (other rows byte-identical)', () => {
    const acc = new UsageAccumulator('r-test');
    acc.record('Digby', 'kimi-k3', { promptTokens: 100_000, completionTokens: 1_000, cachedTokens: 90_000, estimated: false });
    acc.record('Digby', 'kimi-k3', { promptTokens: 110_000, completionTokens: 1_000, cachedTokens: 100_000, estimated: false });
    acc.record('Worker', 'kimi-k3', { promptTokens: 20_000, completionTokens: 100, estimated: false });
    const rows = acc.snapshot().agents;
    const lead = rows.find((r) => r.agent === 'Digby')!;
    const p = priceFor('kimi-k3');
    expect(lead.cacheSavedUsd).toBeCloseTo((190_000 * (p.in - p.cachedIn!)) / 1e6, 9);
    expect('cacheSavedUsd' in rows.find((r) => r.agent === 'Worker')!).toBe(false);
  });
});

describe('run_spend carries cache-aware dollars', () => {
  it('cacheSavedUsd + noCacheUsd (= the cache-aware cost + what the cache saved)', async () => {
    const acc = new UsageAccumulator('run-c');
    acc.record('Digby', 'kimi-k3', { promptTokens: 200_000, completionTokens: 2_000, cachedTokens: 190_000, estimated: false });
    const snap = acc.snapshot();
    recordRunSpend('run-c', 'sess-c', snap);
    await flushLoopMetrics();
    const spend = flushed().find((r) => r.kind === 'run_spend');
    const saved = snap.agents[0].cacheSavedUsd!;
    expect(spend.value).toBeCloseTo(snap.totalCostUsd, 9);
    expect(spend.meta.cacheSavedUsd).toBeCloseTo(saved, 6);
    expect(spend.meta.noCacheUsd).toBeCloseTo(snap.totalCostUsd + saved, 6);
    expect(spend.meta.noCacheUsd).toBeGreaterThan(spend.value * 3); // 95 % cached at a 10× discount
  });

  it('absent when nothing was saved, and under PROMPT_CACHE_METRICS_DISABLED=1', async () => {
    recordRunSpend('run-d', 'sess-d', { totalInTokens: 1_000, totalOutTokens: 10, totalCostUsd: 0.01, agents: [{ model: 'glm-5.3', inTokens: 1_000, outTokens: 10, costUsd: 0.01 }] });
    process.env.PROMPT_CACHE_METRICS_DISABLED = '1';
    recordRunSpend('run-e', 'sess-e', { totalInTokens: 1_000, totalOutTokens: 10, totalCostUsd: 0.01, agents: [{ model: 'kimi-k3', inTokens: 1_000, outTokens: 10, costUsd: 0.01, cachedTokens: 900, cacheSavedUsd: 0.002 }] });
    await flushLoopMetrics();
    for (const r of flushed().filter((x) => x.kind === 'run_spend')) {
      expect('cacheSavedUsd' in r.meta).toBe(false);
      expect('noCacheUsd' in r.meta).toBe(false);
    }
  });
});

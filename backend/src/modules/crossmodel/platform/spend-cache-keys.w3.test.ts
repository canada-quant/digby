/**
 * audit 2026-10-08 W3-2 (prompt-cache metrics for every provider shape) +
 * W3-4 (one name per model on spend rows) + W3-1 (drainLoopMetrics waits for
 * in-flight batches).
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

import { recordRunSpend, flushLoopMetrics, drainLoopMetrics, __resetLoopMetricsForTest } from './loop-metrics.service';
import { readCachedPromptTokens, parseCachedPromptTokens, cacheHitRatio } from '../coding/prompt-cache-usage';
import { UsageAccumulator, priceFor, turnCostUsd, PRICES, DEFAULT_PRICE } from '../coding/cost';
import { spendModelKey } from '../coding/coding-model';
import { bareToSpecMap, canonicalSpendModelKey, foldByCanonicalModel } from './spend-model-keys';

const rows = () => mockCreateMany.mock.calls.flatMap((c: any[]) => c[0]?.data ?? []) as any[];

beforeEach(() => {
  mockCreateMany.mockReset();
  mockCreateMany.mockResolvedValue({ count: 0 });
  __resetLoopMetricsForTest();
  delete process.env.PROMPT_CACHE_METRICS_DISABLED;
  delete process.env.SPEND_MODEL_KEY_NORMALIZE_DISABLED;
});
afterAll(() => {
  delete process.env.PROMPT_CACHE_METRICS_DISABLED;
  delete process.env.SPEND_MODEL_KEY_NORMALIZE_DISABLED;
});

describe('prompt-cache-usage (W3-2): every provider usage shape', () => {
  it('Moonshot top-level cached_tokens', () => {
    expect(readCachedPromptTokens({ prompt_tokens: 1000, completion_tokens: 5, cached_tokens: 900 })).toEqual({ tokens: 900, shape: 'moonshot' });
  });
  it('DeepSeek prompt_cache_hit_tokens (miss tokens are the rest)', () => {
    expect(readCachedPromptTokens({ prompt_tokens: 64_000, prompt_cache_hit_tokens: 60_416, prompt_cache_miss_tokens: 3_584 })).toEqual({ tokens: 60_416, shape: 'deepseek' });
  });
  it('OpenAI-compatible / LiteLLM / Z.ai prompt_tokens_details.cached_tokens', () => {
    // the shape a cql-litellm:api-optimize-zai-glm-5.3 stream ends with
    expect(readCachedPromptTokens({ prompt_tokens: 88_000, completion_tokens: 900, prompt_tokens_details: { cached_tokens: 81_920 } })).toEqual({ tokens: 81_920, shape: 'openai_details' });
  });
  it('Responses-style and Anthropic passthroughs', () => {
    expect(readCachedPromptTokens({ prompt_tokens: 10, input_tokens_details: { cached_tokens: 4 } })).toEqual({ tokens: 4, shape: 'responses_details' });
    expect(readCachedPromptTokens({ prompt_tokens: 10, cache_read_input_tokens: 6 })).toEqual({ tokens: 6, shape: 'anthropic' });
  });
  it('clamps to prompt_tokens; ignores garbage; none reported ⇒ undefined', () => {
    expect(parseCachedPromptTokens({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 250 } })).toBe(100);
    expect(parseCachedPromptTokens({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: -3 } })).toBeUndefined();
    expect(parseCachedPromptTokens({ prompt_tokens: 100 })).toBeUndefined();
    expect(parseCachedPromptTokens(null)).toBeUndefined();
    expect(cacheHitRatio(81_920, 88_000)).toBe(0.931);
    expect(cacheHitRatio(undefined, 10)).toBeUndefined();
  });
  it('kill switch PROMPT_CACHE_METRICS_DISABLED=1 ⇒ Moonshot-only (the pre-fix read)', () => {
    process.env.PROMPT_CACHE_METRICS_DISABLED = '1';
    expect(parseCachedPromptTokens({ prompt_tokens: 100, cached_tokens: 50 })).toBe(50);
    expect(parseCachedPromptTokens({ prompt_tokens: 100, prompt_cache_hit_tokens: 50 })).toBeUndefined();
    expect(parseCachedPromptTokens({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 50 } })).toBeUndefined();
  });
});

describe('cost.ts (W3-4): spec rows keep their bare-id price', () => {
  it('priceFor falls back to the bare id of a spec, then (build 2026-10-08 Q-1) the model family, else DEFAULT_PRICE', () => {
    expect(priceFor('kimi-k3')).toBe(PRICES['kimi-k3']);
    expect(priceFor('ollama:kimi-k3')).toBe(PRICES['kimi-k3']);
    expect(priceFor('cql-litellm:api-optimize-zai-glm-5.3')).toBe(PRICES['glm-5.3']);
    expect(priceFor('api-optimize-zai-glm-5.3')).toBe(PRICES['glm-5.3']);
    expect(priceFor('cql-litellm:some-unknown-model')).toBe(DEFAULT_PRICE);
    process.env.SPEND_FAMILY_PRICING_DISABLED = '1';
    try {
      expect(priceFor('cql-litellm:api-optimize-zai-glm-5.3')).toBe(DEFAULT_PRICE);
    } finally {
      delete process.env.SPEND_FAMILY_PRICING_DISABLED;
    }
  });
  it('cached input bills at the cache rate when the model has one (kimi-k3 $0.30/M)', () => {
    const full = turnCostUsd('kimi-k3', { promptTokens: 1_000_000, completionTokens: 0, estimated: false });
    const cached = turnCostUsd('kimi-k3', { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 900_000, estimated: false });
    expect(full).toBeCloseTo(3.0, 6);
    expect(cached).toBeCloseTo(0.1 * 3.0 + 0.9 * 0.3, 6);
  });
  it('UsageAccumulator rows carry the spec; pricing is unchanged by it', () => {
    const a = new UsageAccumulator('r1');
    a.record('Digby', 'api-optimize-zai-glm-5.3', { promptTokens: 1000, completionTokens: 10, cachedTokens: 800, estimated: false }, undefined, 'cql-litellm:api-optimize-zai-glm-5.3');
    const b = new UsageAccumulator('r2');
    b.record('Digby', 'api-optimize-zai-glm-5.3', { promptTokens: 1000, completionTokens: 10, cachedTokens: 800, estimated: false });
    expect(a.snapshot().agents[0]).toMatchObject({ model: 'api-optimize-zai-glm-5.3', spec: 'cql-litellm:api-optimize-zai-glm-5.3', cachedTokens: 800 });
    expect(a.snapshot().totalCostUsd).toBe(b.snapshot().totalCostUsd);
  });
  it('spendModelKey: spec for a custom endpoint, bare for a built-in; kill switch restores bare', () => {
    expect(spendModelKey({ model: 'api-optimize-zai-glm-5.3', spec: 'cql-litellm:api-optimize-zai-glm-5.3' })).toBe('cql-litellm:api-optimize-zai-glm-5.3');
    expect(spendModelKey({ model: 'glm-5.3' })).toBe('glm-5.3');
    process.env.SPEND_MODEL_KEY_NORMALIZE_DISABLED = '1';
    expect(spendModelKey({ model: 'api-optimize-zai-glm-5.3', spec: 'cql-litellm:api-optimize-zai-glm-5.3' })).toBe('api-optimize-zai-glm-5.3');
  });
});

describe('recordRunSpend (W3-2 cache fields + W3-4 one model name)', () => {
  // REPLAY shape: a gateway lane run (coding) and a gateway supervisor turn (chat) on the SAME model —
  // prod 10-08 showed `api-optimize-zai-glm-5.3` ($156.07) and `cql-litellm:api-optimize-zai-glm-5.3` ($13.69).
  const SPEC = 'cql-litellm:api-optimize-zai-glm-5.3';
  const BARE = 'api-optimize-zai-glm-5.3';
  const codingUsage = {
    totalInTokens: 5_000_000, totalOutTokens: 40_000, totalCostUsd: 3.1, turns: 120, estimated: false,
    agents: [
      { agent: 'Digby', model: BARE, spec: SPEC, inTokens: 4_000_000, outTokens: 30_000, cachedTokens: 3_200_000, costUsd: 2.5, peakPromptTokens: 90_000 },
      { agent: 'worker', role: 'explorer', model: BARE, spec: SPEC, inTokens: 1_000_000, outTokens: 10_000, cachedTokens: 500_000, costUsd: 0.6 },
    ],
  };

  it('keys every row on the spec and records the cached share (run_tokens_in meta + run_spend meta)', async () => {
    recordRunSpend('rmu1', 'lane-1', codingUsage, { model: SPEC, profile: 'coding' });
    await flushLoopMetrics();
    const tin = rows().find((r) => r.kind === 'run_tokens_in');
    expect(tin.meta).toMatchObject({ model: SPEC, cachedTokens: 3_700_000 });
    const spend = rows().find((r) => r.kind === 'run_spend');
    expect(spend.meta).toMatchObject({ model: SPEC, models: [SPEC], seats: { [SPEC]: ['lead', 'explorer'] }, inTokens: 5_000_000, cachedTokens: 3_700_000, cacheHitRatio: 0.74 });
  });

  it('kill switches: SPEND_MODEL_KEY_NORMALIZE_DISABLED=1 keys on the bare id; PROMPT_CACHE_METRICS_DISABLED=1 drops the cache fields', async () => {
    process.env.SPEND_MODEL_KEY_NORMALIZE_DISABLED = '1';
    process.env.PROMPT_CACHE_METRICS_DISABLED = '1';
    recordRunSpend('rmu2', 'lane-1', codingUsage, { model: BARE, profile: 'coding' });
    await flushLoopMetrics();
    const tin = rows().find((r) => r.kind === 'run_tokens_in');
    expect(tin.meta).toEqual(expect.objectContaining({ model: BARE }));
    expect(tin.meta.cachedTokens).toBeUndefined();
    const spend = rows().find((r) => r.kind === 'run_spend');
    expect(spend.meta.models).toEqual([BARE]);
    expect(spend.meta.inTokens).toBeUndefined();
    expect(spend.meta.cacheHitRatio).toBeUndefined();
  });

  it('build 2026-10-08 Q-1: run_tokens_in carries the non-built-in price source; a built-in row carries none', async () => {
    const acc = new UsageAccumulator('rq1');
    acc.record('Digby', BARE, { promptTokens: 1000, completionTokens: 10, cachedTokens: 800, estimated: false }, undefined, SPEC);
    acc.record('Checker', 'deepseek-flash', { promptTokens: 500, completionTokens: 5, estimated: false }, 'cross_checker');
    recordRunSpend('rq1', 'lane-1', acc.snapshot(), { model: SPEC, profile: 'coding' });
    await flushLoopMetrics();
    const tins = rows().filter((r) => r.kind === 'run_tokens_in');
    expect(tins.find((r) => r.meta.model === SPEC).meta).toMatchObject({ priceSource: 'family:glm-5.3' });
    expect(tins.find((r) => r.meta.model === 'deepseek-flash').meta.priceSource).toBeUndefined();
  });

  it('a run that reported no cache keeps cachedTokens 0 on run_spend and none on run_tokens_in', async () => {
    recordRunSpend('rmu3', 's', { totalInTokens: 10, totalOutTokens: 1, totalCostUsd: 0, agents: [{ model: 'glm-5.3', inTokens: 10, outTokens: 1, costUsd: 0 }] }, { model: 'glm-5.3', profile: 'chat' });
    await flushLoopMetrics();
    expect(rows().find((r) => r.kind === 'run_tokens_in').meta.cachedTokens).toBeUndefined();
    expect(rows().find((r) => r.kind === 'run_spend').meta).toMatchObject({ inTokens: 10, cachedTokens: 0, cacheHitRatio: 0 });
  });
});

describe('drainLoopMetrics (W3-1): waits for a batch already in flight', () => {
  it('a timer flush in flight is awaited before the drain resolves', async () => {
    let release!: () => void;
    mockCreateMany.mockImplementationOnce(() => new Promise((r) => { release = () => r({ count: 1 }); }));
    recordRunSpend('rmu4', 's', { totalInTokens: 1, totalOutTokens: 1, totalCostUsd: 0.01, agents: [] });
    const first = flushLoopMetrics(); // the size/timer-triggered flush, still writing
    let drained = false;
    const d = drainLoopMetrics(5_000).then((r) => { drained = true; return r; });
    await new Promise((r) => setImmediate(r));
    expect(drained).toBe(false);
    release();
    await first;
    const r = await d;
    expect(r).toMatchObject({ inflight: 1, timedOut: false });
  });
});

describe('spend-model-keys (W3-4): fold history on read', () => {
  const endpoints = [
    { label: 'cql-litellm', enabled: true, models: [{ id: 'api-optimize-zai-glm-5.3' }, { id: 'api-alibaba-qwen3.8-max' }, { id: 'glm-5.3' }] },
    { label: 'other', enabled: true, models: [{ id: 'api-alibaba-qwen3.8-max' }] },
    { label: 'off', enabled: false, models: [{ id: 'only-on-disabled' }] },
  ];
  const isBuiltIn = (id: string) => id === 'glm-5.3';
  it('maps a bare id served by exactly ONE enabled endpoint; ambiguous / built-in / disabled ids are left alone', () => {
    const m = bareToSpecMap(endpoints, isBuiltIn);
    expect(m.get('api-optimize-zai-glm-5.3')).toBe('cql-litellm:api-optimize-zai-glm-5.3');
    expect(m.has('api-alibaba-qwen3.8-max')).toBe(false); // two endpoints serve it
    expect(m.has('glm-5.3')).toBe(false); // a built-in id stays the built-in
    expect(m.has('only-on-disabled')).toBe(false);
    expect(canonicalSpendModelKey('cql-litellm:x', m)).toBe('cql-litellm:x');
  });
  it('folds the two names of one model into one line', () => {
    const m = bareToSpecMap(endpoints, isBuiltIn);
    const folded = foldByCanonicalModel(
      [{ model: 'api-optimize-zai-glm-5.3', usd: 156.07 }, { model: 'cql-litellm:api-optimize-zai-glm-5.3', usd: 13.69 }, { model: 'glm-5.3', usd: 32.17 }],
      m,
      (into, from) => { into.usd += from.usd; },
    );
    expect(folded).toEqual([{ model: 'cql-litellm:api-optimize-zai-glm-5.3', usd: 169.76 }, { model: 'glm-5.3', usd: 32.17 }]);
  });
});

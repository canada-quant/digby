/**
 * build 2026-10-08 Q-1 — verified vendor list prices + gateway FAMILY pricing + registry price wins.
 *
 * REPLAY SHAPES (prod run_tokens_in, 14 days to 2026-10-08): the meter priced every gateway model
 * that is not exactly a built-in id at DEFAULT_PRICE ($0.60 / $2.40, no cached rate) —
 * `api-optimize-zai-glm-5.3` 4,344.5M coding + 779.9M chat input tokens, `api-optimize-moonshot-kimi-k3`
 * 1,067M, `api-anthropic-claude-fable-5-1` (the owner's Project Supervisor seat, list $10 / $50) 46.6M —
 * and the built-in GLM-5.3 row itself at $0.60 / $2.20 with no cached rate (Z.ai lists $1.40 / $0.26 / $4.40).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  PRICES, DEFAULT_PRICE, priceFor, resolvePrice, turnCostUsd, familyPriceFor, noteRegistryPrice,
  __resetRegistryPricesForTests, UsageAccumulator, priceSourceLabel,
} from './cost';

beforeEach(() => {
  __resetRegistryPricesForTests();
  delete process.env.SPEND_FAMILY_PRICING_DISABLED;
});
afterAll(() => { delete process.env.SPEND_FAMILY_PRICING_DISABLED; });

describe('verified list rows (cost.ts PRICES)', () => {
  it('GLM-5.3 is Z.ai list $1.40 in / $0.26 cached / $4.40 out (was $0.60 / $2.20, no cached rate)', () => {
    expect(PRICES['glm-5.3']).toEqual({ in: 1.4, out: 4.4, cachedIn: 0.26 });
  });
  it('cached-input rates are carried for Kimi, DeepSeek, GLM and Qwen', () => {
    expect(PRICES['kimi-k3'].cachedIn).toBe(0.3);
    expect(PRICES['deepseek-flash'].cachedIn).toBe(0.003);
    expect(PRICES['glm-5.3'].cachedIn).toBe(0.26);
    expect(PRICES['qwen3.6-flash'].cachedIn).toBe(0.025);
  });
});

describe('gateway specs price by model FAMILY (the prod model list, 14 days to 2026-10-08)', () => {
  it.each([
    ['cql-litellm:api-optimize-zai-glm-5.3', 'glm-5.3', 1.4, 4.4, 0.26],
    ['api-optimize-zai-glm-5.3', 'glm-5.3', 1.4, 4.4, 0.26],
    ['cql-litellm:api-optimize-zai-glm-5.3-flash', 'glm-5.3-flash', 0.15, 0.5, 0.03],
    ['cql-litellm:api-optimize-moonshot-kimi-k3', 'kimi-k3', 3, 15, 0.3],
    ['cql-litellm:api-optimize-alibaba-deepseek-v4.1-flash', 'deepseek-flash', 0.15, 0.6, 0.003],
    ['api-deepseek-v4.1-flash', 'deepseek-flash', 0.15, 0.6, 0.003],
    ['api-optimize-alibaba-deepseek-v4-flash-0731', 'deepseek-flash', 0.15, 0.6, 0.003],
    ['api-deepseek-v4-pro', 'deepseek-v4-pro', 0.66, 1.98, 0.022],
    ['api-fireworks-deepseek-v4-pro', 'deepseek-v4-pro', 0.66, 1.98, 0.022],
    ['cql-litellm:api-alibaba-qwen3.8-max', 'qwen3.8-max', 2, 6, undefined],
    ['api-optimize-alibaba-qwen3.8-flash', 'qwen3.8-flash', 0.15, 0.47, undefined],
    ['api-optimize-alibaba-qwen3.7-max', 'qwen3.7-max', 2.5, 7.5, 0.5],
    ['api-optimize-alibaba-qwen3.7-plus', 'qwen3.7-plus', 0.4, 1.6, 0.08],
    ['api-optimize-alibaba-qwen3.6-flash', 'qwen3.6-flash', 0.25, 1.5, 0.025],
    ['cql-litellm:api-anthropic-claude-fable-5-1', 'claude-fable-5.1', 10, 50, 0.25],
    ['cql-litellm:api-anthropic-claude-opus-5', 'claude-opus-5', 5, 25, 0.5],
    ['cql-litellm:api-anthropic-claude-opus-4-8', 'claude-opus-4.5+', 5, 25, 0.5],
    ['cql-litellm:api-xai-grok-4.6', 'grok-4.6', 2, 6, 0.5],
    ['cql-litellm:api-openai-gpt-5.6-sol', 'gpt-5.6-sol', 4, 20, 0.4],
  ])('%s → %s', (spec, key, pin, pout, cached) => {
    const r = resolvePrice(spec);
    expect(r.source).toBe(spec.includes(':') && PRICES[spec.slice(spec.indexOf(':') + 1)] ? 'builtin' : 'family');
    expect(familyPriceFor(spec)?.key).toBe(key);
    expect(r.price.in).toBe(pin);
    expect(r.price.out).toBe(pout);
    expect(r.price.cachedIn).toBe(cached);
  });

  it.each([
    'api-optimize-moonshot-kimi-for-coding', // a subscription — no per-token list price
    'api-alibaba-qwen3.8-open', // not the hosted SKU
    'qwen3.8-flash-next', // self-hosted checkpoint
    'spark-mimo-v26-flash-rl',
    'glm-5.2-flash', // no published 5.2-flash price
    'kimi-k3-turbo',
    'cql-litellm:agx-laya',
  ])('%s stays on DEFAULT_PRICE (no verified family row)', (id) => {
    expect(familyPriceFor(id)).toBeNull();
    expect(priceFor(id)).toBe(DEFAULT_PRICE);
  });

  it('claude-opus-5-5 is not claude-opus-5 (version digits never bleed)', () => {
    expect(familyPriceFor('api-anthropic-claude-opus-5-5')?.key).toBe('claude-opus-5.5');
    expect(familyPriceFor('api-anthropic-claude-fable-5')?.key).toBe('claude-fable-5');
  });

  it('REPLAY: a 10-08 gateway GLM lane run (5.35M prompt, 5.19M cached, 0.30M out) — $2.89 at cache-aware list vs $3.93 metered before (no cache rate, $0.60 in)', () => {
    const usage = { promptTokens: 5_350_000, completionTokens: 300_000, cachedTokens: 5_190_000, estimated: false };
    const now = turnCostUsd('cql-litellm:api-optimize-zai-glm-5.3', usage);
    expect(now).toBeCloseTo((160_000 * 1.4 + 5_190_000 * 0.26 + 300_000 * 4.4) / 1e6, 6);
    process.env.SPEND_FAMILY_PRICING_DISABLED = '1';
    const before = turnCostUsd('cql-litellm:api-optimize-zai-glm-5.3', usage);
    expect(before).toBeCloseTo((5_350_000 * 0.6 + 300_000 * 2.4) / 1e6, 6); // the pre-change DEFAULT_PRICE meter
  });

  it('kill switch SPEND_FAMILY_PRICING_DISABLED=1 restores the pre-change lookup (exact id → bare id → default)', () => {
    process.env.SPEND_FAMILY_PRICING_DISABLED = '1';
    expect(priceFor('cql-litellm:api-optimize-zai-glm-5.3')).toBe(DEFAULT_PRICE);
    expect(priceFor('ollama:kimi-k3')).toBe(PRICES['kimi-k3']);
    expect(priceFor('glm-5.3')).toBe(PRICES['glm-5.3']);
  });
});

describe('a registry price (usdPerMTokIn/Out) still wins', () => {
  it('a noted registry price beats the family row; cached input then bills at the registry input rate', () => {
    noteRegistryPrice('cql-litellm:api-optimize-zai-glm-5.3', { in: 1.0, out: 3.0 });
    const r = resolvePrice('cql-litellm:api-optimize-zai-glm-5.3');
    expect(r).toEqual({ price: { in: 1.0, out: 3.0 }, source: 'registry' });
    expect(turnCostUsd('cql-litellm:api-optimize-zai-glm-5.3', { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 900_000, estimated: false })).toBeCloseTo(1.0, 6);
  });
  it('a one-sided registry price keeps the family value for the other side (and its cached rate when input is not overridden)', () => {
    noteRegistryPrice('cql-litellm:api-optimize-zai-glm-5.3', { out: 5 });
    expect(resolvePrice('cql-litellm:api-optimize-zai-glm-5.3').price).toEqual({ in: 1.4, out: 5, cachedIn: 0.26 });
  });
  it('an explicit registry argument (the API-costs view) overrides the noted one; null means "none"', () => {
    noteRegistryPrice('cql-litellm:api-optimize-zai-glm-5.3', { in: 9, out: 9 });
    expect(resolvePrice('cql-litellm:api-optimize-zai-glm-5.3', { in: 0, out: 0 }).price).toEqual({ in: 0, out: 0 });
    expect(resolvePrice('cql-litellm:api-optimize-zai-glm-5.3', null).source).toBe('family');
  });
  it('a re-resolve with no price clears the noted one; a built-in id never reads the registry', () => {
    noteRegistryPrice('cql-litellm:api-optimize-zai-glm-5.3', { in: 1, out: 1 });
    noteRegistryPrice('cql-litellm:api-optimize-zai-glm-5.3', { in: undefined, out: undefined });
    expect(resolvePrice('cql-litellm:api-optimize-zai-glm-5.3').source).toBe('family');
    noteRegistryPrice('glm-5.3', { in: 1, out: 1 }); // not a spec — ignored
    expect(resolvePrice('glm-5.3').source).toBe('builtin');
  });
});

describe('the run meter (UsageAccumulator) prices a custom endpoint by its spec and stamps the source', () => {
  it('gateway GLM row: family price + priceSource family:glm-5.3; a built-in row carries no source', () => {
    const acc = new UsageAccumulator('rq1');
    acc.record('Digby', 'api-optimize-zai-glm-5.3', { promptTokens: 1_000_000, completionTokens: 100_000, cachedTokens: 900_000, estimated: false }, undefined, 'cql-litellm:api-optimize-zai-glm-5.3');
    acc.record('Checker', 'deepseek-flash', { promptTokens: 1_000_000, completionTokens: 0, estimated: false }, 'cross_checker');
    const rows = acc.snapshot().agents;
    const lead = rows.find((r) => r.agent === 'Digby')!;
    expect(lead.priceSource).toBe('family:glm-5.3');
    expect(lead.costUsd).toBeCloseTo((100_000 * 1.4 + 900_000 * 0.26 + 100_000 * 4.4) / 1e6, 6);
    expect(rows.find((r) => r.agent === 'Checker')!.priceSource).toBeUndefined();
  });
  it('a noted registry price is what the meter bills', () => {
    noteRegistryPrice('cql-litellm:api-optimize-zai-glm-5.3', { in: 2, out: 2 });
    const acc = new UsageAccumulator('rq2');
    acc.record('Digby', 'api-optimize-zai-glm-5.3', { promptTokens: 1_000_000, completionTokens: 1_000_000, estimated: false }, undefined, 'cql-litellm:api-optimize-zai-glm-5.3');
    expect(acc.snapshot().agents[0]).toMatchObject({ priceSource: 'registry' });
    expect(acc.snapshot().totalCostUsd).toBeCloseTo(4, 6);
  });
  it('priceSourceLabel: builtin → undefined, family → family:<key>, others verbatim', () => {
    expect(priceSourceLabel(resolvePrice('kimi-k3'))).toBeUndefined();
    expect(priceSourceLabel(resolvePrice('cql-litellm:api-alibaba-qwen3.8-max'))).toBe('family:qwen3.8-max');
    expect(priceSourceLabel(resolvePrice('cql-litellm:unknown-x'))).toBe('default');
  });
});

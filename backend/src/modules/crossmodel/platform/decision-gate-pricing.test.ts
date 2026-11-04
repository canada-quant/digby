/**
 * decision-gate-pricing.ts — the decision gate's SPEND rows (owner 2026-09-28:
 * "did you make sure to add jev to api costs as well" — it had not been):
 * the price table (Jev list / env override, registry price, self-hosted,
 * unpriced), the rows one call mints, the estimate path and the kill switch.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockRecordLoopMetrics = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate', RUN_SPEND: 'run_spend', RUN_TOKENS_IN: 'run_tokens_in', RUN_TOKENS_OUT: 'run_tokens_out' },
  recordLoopMetric: jest.fn(),
  recordLoopMetrics: (...a: any[]) => mockRecordLoopMetrics(...a),
}));

import {
  DECISION_GATE_SYNTHETIC_SESSION,
  DECISION_SPEND_PROFILE,
  TYPESAFE_LIST_USD_PER_MTOK_IN,
  TYPESAFE_LIST_USD_PER_MTOK_OUT,
  TYPESAFE_PRICE_SOURCE_URL,
  decisionCallUsd,
  decisionPriceFor,
  decisionProviderOf,
  decisionSpendRows,
  estimateDecisionPromptTokens,
  isJevModelId,
  recordDecisionSpend,
  typesafePrice,
} from './decision-gate-pricing';

const ENV = ['TYPESAFE_USD_PER_MTOK_IN', 'TYPESAFE_USD_PER_MTOK_OUT'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  mockRecordLoopMetrics.mockReset();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('the price table', () => {
  it('TypeSafe Jev is priced at the vendor LIST price — $42 per billion input tokens = $0.042 / M, output not metered (docs.typesafe.ai/models)', () => {
    expect(TYPESAFE_LIST_USD_PER_MTOK_IN).toBe(0.042);
    expect(TYPESAFE_LIST_USD_PER_MTOK_OUT).toBe(0);
    expect(TYPESAFE_PRICE_SOURCE_URL).toBe('https://docs.typesafe.ai/models');
    const p = typesafePrice();
    expect(p).toMatchObject({ in: 0.042, out: 0, source: 'list' });
    expect(p.note).toContain('TYPESAFE_USD_PER_MTOK_IN');
  });

  it('TYPESAFE_USD_PER_MTOK_IN / _OUT override the list price (source env); garbage is ignored', () => {
    process.env.TYPESAFE_USD_PER_MTOK_IN = '0.025';
    expect(typesafePrice()).toMatchObject({ in: 0.025, out: 0, source: 'env' });
    process.env.TYPESAFE_USD_PER_MTOK_OUT = '0.5';
    expect(typesafePrice()).toMatchObject({ in: 0.025, out: 0.5, source: 'env' });
    process.env.TYPESAFE_USD_PER_MTOK_IN = 'free';
    delete process.env.TYPESAFE_USD_PER_MTOK_OUT;
    expect(typesafePrice()).toMatchObject({ in: 0.042, out: 0, source: 'list' });
    process.env.TYPESAFE_USD_PER_MTOK_IN = '-1';
    expect(typesafePrice().source).toBe('list');
  });

  it('isJevModelId recognises every TypeSafe id shape and nothing else', () => {
    for (const id of ['jev-1.13.0', 'jev-latest', 'jev', 'typesafe-ai/jev', 'typesafe/jev-1.13', 'JEV-1.14.0']) expect(isJevModelId(id)).toBe(true);
    for (const id of ['deepseek-flash', 'cql-litellm:agx-laya', 'kimi-k3', '', undefined, 'jevons-model']) expect(isJevModelId(id as any)).toBe(false);
  });

  it('decisionPriceFor: jev → typesafe; a registry spec → the registry price when set, else self_hosted $0; deepseek-flash → the coding list rate; unknown → unpriced', () => {
    expect(decisionPriceFor('jev-1.13.0')).toMatchObject({ in: 0.042, out: 0, source: 'list' });
    expect(decisionPriceFor('cql-litellm:agx-laya')).toMatchObject({ in: 0, out: 0, source: 'self_hosted' });
    expect(decisionPriceFor('cql-litellm:agx-laya').note).toContain('usdPerMTokIn');
    expect(decisionPriceFor('cql-litellm:agx-laya', { registryPrice: { in: 0.1 } })).toMatchObject({ in: 0.1, out: 0, source: 'registry' });
    expect(decisionPriceFor('cql-litellm:agx-laya', { registryPrice: { in: 0.1, out: 0.3 } })).toMatchObject({ in: 0.1, out: 0.3, source: 'registry' });
    // A registry price of 0 is a real "free" price, not unset.
    expect(decisionPriceFor('cql-litellm:agx-laya', { registryPrice: { in: 0 } })).toMatchObject({ in: 0, out: 0, source: 'registry' });
    expect(decisionPriceFor('deepseek-flash')).toMatchObject({ in: 0.15, out: 0.6, source: 'list' });
    expect(decisionPriceFor('some-new-decision-model')).toMatchObject({ in: 0, out: 0, source: 'unpriced' });
  });

  it('decisionCallUsd prices per million and never goes negative / NaN; the estimate is ~4 chars per token', () => {
    expect(decisionCallUsd(typesafePrice(), 1_000_000, 0)).toBeCloseTo(0.042, 6);
    expect(decisionCallUsd(typesafePrice(), 2_500, 0)).toBeCloseTo(0.000105, 9);
    expect(decisionCallUsd({ in: 0.15, out: 0.6, source: 'list', note: '' }, 1000, 3)).toBeCloseTo(0.0001518, 9);
    expect(decisionCallUsd({ in: 0.15, out: 0.6, source: 'list', note: '' }, -5, NaN)).toBe(0);
    expect(estimateDecisionPromptTokens(4000)).toBe(1000);
    expect(estimateDecisionPromptTokens(4001)).toBe(1001);
    expect(estimateDecisionPromptTokens(-1)).toBe(0);
  });

  it('decisionProviderOf: typesafe for jev, the endpoint label for a registry spec, deepseek for the readout', () => {
    expect(decisionProviderOf('jev-1.13.0')).toBe('typesafe');
    expect(decisionProviderOf('jev-1.13.0', 'jev')).toBe('typesafe');
    expect(decisionProviderOf('cql-litellm:agx-laya')).toBe('cql-litellm');
    expect(decisionProviderOf('deepseek-flash', 'deepseek-flash')).toBe('deepseek');
    expect(decisionProviderOf('mystery')).toBeUndefined();
  });
});

describe('the rows one call mints', () => {
  const base = { decisionId: 'abcd1234', purpose: 'wake_triage', backend: 'TypeSafe Jev', backendSpec: 'jev', backendKind: 'systemone', model: 'jev-1.13.0', promptChars: 8000, ms: 164 };

  it('reported usage → run_tokens_in (exact, estimated:false) + ONE run_spend priced at the Jev list rate, no run_tokens_out at 0 output', () => {
    const rows = decisionSpendRows({ ...base, sessionId: 'chat-1', inputTokens: 2750, outputTokens: 0 });
    expect(rows.map(r => r.kind)).toEqual(['run_tokens_in', 'run_spend']);
    const [tin, spend] = rows;
    expect(tin).toMatchObject({ sessionId: 'chat-1', runId: 'dg-abcd1234', value: 2750, unit: 'tokens' });
    expect(tin.meta).toMatchObject({ model: 'jev-1.13.0', provider: 'typesafe', profile: DECISION_SPEND_PROFILE, purpose: 'wake_triage', backend: 'TypeSafe Jev', backendSpec: 'jev', decisionId: 'abcd1234', estimated: false });
    expect(tin.meta!.challenger).toBeUndefined();
    expect(spend).toMatchObject({ sessionId: 'chat-1', runId: 'dg-abcd1234', unit: 'usd' });
    expect(spend.value).toBeCloseTo(2750 * 0.042 / 1_000_000, 12);
    expect(spend.meta).toMatchObject({ model: 'jev-1.13.0', models: ['jev-1.13.0'], profile: 'decision', purpose: 'wake_triage', decisionId: 'abcd1234', inTokens: 2750, outTokens: 0, priceSource: 'list', usdPerMTokIn: 0.042, usdPerMTokOut: 0, estimated: false, turns: 1, ms: 164 });
    expect(spend.meta!.unpriced).toBeUndefined();
  });

  it('no reported usage → the prefill estimate (promptChars / 4, estimated:true); no session → the synthetic decision-gate session', () => {
    const rows = decisionSpendRows({ ...base, inputTokens: undefined });
    expect(rows[0]).toMatchObject({ kind: 'run_tokens_in', value: 2000, sessionId: DECISION_GATE_SYNTHETIC_SESSION });
    expect(rows[0].meta).toMatchObject({ estimated: true });
    expect(rows[1].meta).toMatchObject({ estimated: true, inTokens: 2000 });
    expect(DECISION_GATE_SYNTHETIC_SESSION).toBe('decision-gate');
  });

  it('the DeepSeek logprob readout spends one output token per question → a run_tokens_out row, priced at the deepseek-flash list rate', () => {
    const rows = decisionSpendRows({ ...base, backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash', backendKind: 'logit', model: 'deepseek-flash', inputTokens: 1200, outputTokens: 3 });
    expect(rows.map(r => r.kind)).toEqual(['run_tokens_in', 'run_tokens_out', 'run_spend']);
    expect(rows[1]).toMatchObject({ value: 3, unit: 'tokens' });
    expect(rows[1].meta).toMatchObject({ model: 'deepseek-flash', provider: 'deepseek' });
    expect(rows[2].value).toBeCloseTo((1200 * 0.15 + 3 * 0.6) / 1_000_000, 12);
    expect(rows[2].meta).toMatchObject({ priceSource: 'list' });
  });

  it('a registry backend (Laya on cql-litellm) with no registry price → $0 run_spend flagged self_hosted + unpriced:true; with a registry price → priced', () => {
    const free = decisionSpendRows({ ...base, backend: 'cql-litellm (systemone chat)', backendSpec: 'cql-litellm:agx-laya', model: 'cql-litellm:agx-laya', inputTokens: 900 });
    const spend = free[free.length - 1];
    expect(spend.value).toBe(0);
    expect(spend.meta).toMatchObject({ model: 'cql-litellm:agx-laya', provider: 'cql-litellm', priceSource: 'self_hosted', unpriced: true });
    const priced = decisionSpendRows({ ...base, backend: 'cql-litellm (systemone chat)', backendSpec: 'cql-litellm:agx-laya', model: 'cql-litellm:agx-laya', inputTokens: 1_000_000, registryPrice: { in: 0.2, out: 0.8 } });
    expect(priced[priced.length - 1].value).toBeCloseTo(0.2, 9);
    expect(priced[priced.length - 1].meta).toMatchObject({ priceSource: 'registry', usdPerMTokIn: 0.2, usdPerMTokOut: 0.8 });
    expect(priced[priced.length - 1].meta!.unpriced).toBeUndefined();
  });

  it('a challenger row is tagged challenger:true on every row it mints (never merged with the primary)', () => {
    const rows = decisionSpendRows({ ...base, decisionId: 'abcd1234~c0', challenger: true, inputTokens: 10 });
    expect(rows.every(r => r.meta!.challenger === true)).toBe(true);
    expect(rows[0].runId).toBe('dg-abcd1234~c0');
  });

  it('no model / no decision id → nothing', () => {
    expect(decisionSpendRows({ ...base, model: '' })).toEqual([]);
    expect(decisionSpendRows({ ...base, decisionId: '' })).toEqual([]);
  });

  it('recordDecisionSpend rides recordLoopMetrics (one batch)', () => {
    recordDecisionSpend({ ...base, inputTokens: 100 });
    expect(mockRecordLoopMetrics).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetrics.mock.calls[0][0].map((r: any) => r.kind)).toEqual(['run_tokens_in', 'run_spend']);
  });

  it('recordDecisionSpend never throws into the gate', () => {
    mockRecordLoopMetrics.mockImplementation(() => { throw new Error('buffer full'); });
    expect(() => recordDecisionSpend({ ...base, inputTokens: 100 })).not.toThrow();
  });
});

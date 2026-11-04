/**
 * decide() → spend rows (2026-09-28, owner: "did you make sure to add jev to
 * api costs as well"): every ANSWERED backend call mints run_tokens_in /
 * run_tokens_out / ONE run_spend through recordLoopMetrics — the primary leg
 * (and a fallback leg), a registry backend priced by the registry, the probe;
 * a memo hit and an all-legs-failed ask mint nothing; the kill switch drops
 * them. The decision row itself still goes through recordLoopMetric FIRST.
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockRecordLoopMetric = jest.fn();
const mockRecordLoopMetrics = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' },
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordLoopMetrics: (...a: any[]) => mockRecordLoopMetrics(...a),
}));
jest.mock('../model-endpoints/model-roles.service', () => ({
  resolveRoleModel: jest.fn(async () => 'jev'),
  resolveRoleFallback: jest.fn(async () => ''),
}));
const mockResolveRegistryModel = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));
const mockStoreGet = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: jest.fn(async () => undefined),
}));

import axios from 'axios';
import { clearDecisionBackendCache, clearDecisionBackendTempsCache, clearDecisionMemo, decide, type DecisionQuestion } from './decision-gate';
import { clearDecisionBackendsConfigCache } from './decision-gate-backends';
import { clearDecisionModeCache } from './decision-gate-modes';

const post = (axios as any).post as jest.Mock;
const ENV = ['TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY', 'DECISION_GATE_DEFAULT_MODE', 'DECISION_GATE_SPEND_ROWS_DISABLED', 'TYPESAFE_USD_PER_MTOK_IN', 'TYPESAFE_MODEL'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
  post.mockReset();
  mockRecordLoopMetric.mockReset();
  mockRecordLoopMetrics.mockReset();
  mockStoreGet.mockReset();
  mockStoreGet.mockResolvedValue(null);
  mockResolveRegistryModel.mockReset();
  mockResolveRegistryModel.mockResolvedValue(null);
  clearDecisionBackendCache();
  clearDecisionBackendTempsCache();
  clearDecisionBackendsConfigCache();
  clearDecisionModeCache();
  clearDecisionMemo();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const QUESTIONS: Record<string, DecisionQuestion> = {
  refund: { type: 'noul', instructions: 'The customer asks for money back.' },
  team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'money', technical: 'bugs', sales: 'plans' } },
};
const JEV_ANSWER = { model: 'jev-1.13.0', answers: { refund: { type: 'noul', noul: 0.9 }, team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, technical: 0.05, sales: 0.05 }, confidence: 0.9 } }, usage: { input_tokens: 2750, output_tokens: 0 } };
const spendBatches = () => mockRecordLoopMetrics.mock.calls.map(c => c[0] as any[]);

describe('decide() spend rows', () => {
  it('Jev primary with reported usage: the decision row first (recordLoopMetric), then ONE batch of run_tokens_in + run_spend at $0.042/M under the SERVED chat id', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    post.mockResolvedValueOnce({ data: JEV_ANSWER });
    const r = await decide({ message: 'refund me' }, QUESTIONS, { purpose: 'wake_triage', sessionId: 'chat-42' });
    expect(r).not.toBeNull();
    const decisionRow = mockRecordLoopMetric.mock.calls[0][0];
    expect(decisionRow.kind).toBe('decision_gate');
    const batches = spendBatches();
    expect(batches).toHaveLength(1);
    const rows = batches[0];
    expect(rows.map(x => x.kind)).toEqual(['run_tokens_in', 'run_spend']);
    expect(rows[0]).toMatchObject({ sessionId: 'chat-42', runId: `dg-${r!.id}`, value: 2750 });
    expect(rows[0].meta).toMatchObject({ model: 'jev-1.13.0', provider: 'typesafe', profile: 'decision', purpose: 'wake_triage', backend: 'TypeSafe Jev', backendSpec: 'jev', backendKind: 'systemone', decisionId: r!.id, estimated: false });
    expect(rows[1].value).toBeCloseTo(2750 * 0.042 / 1_000_000, 12);
    expect(rows[1].meta).toMatchObject({ model: 'jev-1.13.0', priceSource: 'list', usdPerMTokIn: 0.042, inTokens: 2750, outTokens: 0, purpose: 'wake_triage', decisionId: r!.id });
    expect(rows[1].meta.challenger).toBeUndefined();
    // The decision row's own meta is untouched by the spend hook.
    expect(decisionRow.meta).toMatchObject({ purpose: 'wake_triage', ok: true, inputTokens: 2750 });
    expect(decisionRow.meta.spend).toBeUndefined();
  });

  it('Jev without a usage block: the rows carry the prefill ESTIMATE (state + questions chars / 4, estimated:true) and the synthetic decision-gate session', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    post.mockResolvedValueOnce({ data: { answers: JEV_ANSWER.answers } });
    const state = { message: 'x'.repeat(3_000) };
    const r = await decide(state, QUESTIONS, { purpose: 'auto_route' });
    expect(r).not.toBeNull();
    const rows = spendBatches()[0];
    // The estimate's input is the gate's own stateText rendering (meta.stateChars on the decision row) + the questions JSON.
    const stateChars = mockRecordLoopMetric.mock.calls[0][0].meta.stateChars as number;
    const expectedTokens = Math.ceil((stateChars + JSON.stringify(QUESTIONS).length) / 4);
    expect(rows[0]).toMatchObject({ kind: 'run_tokens_in', value: expectedTokens, sessionId: 'decision-gate' });
    expect(rows[0].meta).toMatchObject({ estimated: true, model: 'jev-1.13.0' });
    expect(rows[1].meta).toMatchObject({ estimated: true, inTokens: expectedTokens, priceSource: 'list' });
  });

  it('TypeSafe fails → the DeepSeek readout answers: the FALLBACK leg is what gets priced (deepseek-flash list rate, one output token per question)', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'd';
    post.mockRejectedValueOnce({ response: { status: 500 } });
    post.mockImplementation(async () => ({ data: { model: 'deepseek-chat', choices: [{ logprobs: { content: [{ token: 'A', logprob: Math.log(0.7), top_logprobs: [{ token: 'A', logprob: Math.log(0.7) }, { token: 'B', logprob: Math.log(0.3) }, { token: 'C', logprob: Math.log(0.0001) }] }] } }], usage: { prompt_tokens: 600 } } }));
    const r = await decide('s', QUESTIONS, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(r!.backend).toBe('DeepSeek logprob readout');
    const batches = spendBatches();
    expect(batches).toHaveLength(1); // the failed Jev leg mints nothing
    const rows = batches[0];
    expect(rows.map(x => x.kind)).toEqual(['run_tokens_in', 'run_tokens_out', 'run_spend']);
    expect(rows[0]).toMatchObject({ value: 1200 }); // 600 prompt tokens × 2 questions (one prefill each)
    expect(rows[1]).toMatchObject({ value: 2 });
    expect(rows[2].meta).toMatchObject({ model: 'deepseek-flash', provider: 'deepseek', backendSpec: 'deepseek-flash', backendKind: 'logit', priceSource: 'list', usdPerMTokIn: 0.15, usdPerMTokOut: 0.6 });
    expect(rows[2].value).toBeCloseTo((1200 * 0.15 + 2 * 0.6) / 1_000_000, 12);
  });

  it('a registry backend is priced under its <label>:<modelId> spec from the registry price (model entry, else endpoint settings); none → self_hosted $0', async () => {
    const LAYA = { url: 'http://laya:8000/v1/chat/completions', baseUrl: 'http://laya:8000/v1', apiKey: 'lk', model: 'agx-laya', label: 'cql-litellm', supportsVision: false, coding: false, matryoshka: false, thinkingOff: false, providerShape: 'systemone' };
    mockResolveRegistryModel.mockResolvedValue({ ...LAYA, usdPerMTokIn: 0.2, usdPerMTokOut: 0.8 });
    post.mockResolvedValue({ data: { model: 'agx-laya', answers: JEV_ANSWER.answers, usage: { input_tokens: 1_000_000, output_tokens: 0 } } });
    const r = await decide('s', QUESTIONS, { purpose: 'auto_route', spec: 'cql-litellm:agx-laya', memo: false, timeoutMs: 5000 });
    expect(r).not.toBeNull();
    let rows = spendBatches()[0];
    expect(rows[rows.length - 1].meta).toMatchObject({ model: 'cql-litellm:agx-laya', provider: 'cql-litellm', priceSource: 'registry', usdPerMTokIn: 0.2, usdPerMTokOut: 0.8 });
    expect(rows[rows.length - 1].value).toBeCloseTo(0.2, 9);
    // No registry price → self-hosted $0, badged (unpriced:true), never a list-price guess.
    mockRecordLoopMetrics.mockReset();
    mockResolveRegistryModel.mockResolvedValue(LAYA);
    clearDecisionBackendCache();
    await decide('s', QUESTIONS, { purpose: 'auto_route', spec: 'cql-litellm:agx-laya', memo: false, timeoutMs: 5000 });
    rows = spendBatches()[0];
    expect(rows[rows.length - 1]).toMatchObject({ value: 0 });
    expect(rows[rows.length - 1].meta).toMatchObject({ priceSource: 'self_hosted', unpriced: true });
  });

  it('a memo hit mints NO spend rows (no backend was called); the probe purpose DOES', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    post.mockResolvedValue({ data: JEV_ANSWER });
    await decide({ message: 'same' }, QUESTIONS, { purpose: 'wake_triage' });
    expect(spendBatches()).toHaveLength(1);
    const hit = await decide({ message: 'same' }, QUESTIONS, { purpose: 'wake_triage' });
    expect(hit!.cached).toBe(true);
    expect(spendBatches()).toHaveLength(1); // unchanged
    // The admin Test button (purpose 'probe', spec-pinned) is a real call — it is priced too.
    await decide({ message: 'probe' }, QUESTIONS, { purpose: 'probe', spec: 'jev', timeoutMs: 5000 });
    expect(spendBatches()).toHaveLength(2);
    expect(spendBatches()[1][1].meta).toMatchObject({ purpose: 'probe', model: 'jev-1.13.0' });
  });

  it('all legs failed → decision row only, no spend rows', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    post.mockRejectedValue({ response: { status: 500 } });
    expect(await decide('s', QUESTIONS, { purpose: 'auto_route', timeoutMs: 2000 })).toBeNull();
    expect(mockRecordLoopMetric).toHaveBeenCalled();
    expect(spendBatches()).toHaveLength(0);
  });

  it('TYPESAFE_USD_PER_MTOK_IN re-prices Jev rows (source env) and the model id the server ANSWERED with is the priced id', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.TYPESAFE_USD_PER_MTOK_IN = '0.025';
    post.mockResolvedValueOnce({ data: { ...JEV_ANSWER, model: 'jev-1.14.0' } });
    await decide('u', QUESTIONS, { purpose: 'auto_route', timeoutMs: 2000 });
    const rows = spendBatches()[0];
    expect(rows[1].meta).toMatchObject({ model: 'jev-1.14.0', priceSource: 'env', usdPerMTokIn: 0.025 });
    expect(rows[1].value).toBeCloseTo(2750 * 0.025 / 1_000_000, 12);
  });
});

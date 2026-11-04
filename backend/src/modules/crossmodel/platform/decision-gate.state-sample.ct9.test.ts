/**
 * decision-gate.ts — backlog CT-9 (2026-09-28): the sampled-state corpus is ON
 * by default at a low rate (0.05 global, wake_triage 0.2) outside NODE_ENV=test;
 * env rates still win; RATE=0 / _DISABLED=1 turn it off; probes never sample.
 * (decision-gate.test.ts pins the hermetic test default of 0 and the row shape.)
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' }, recordLoopMetric: jest.fn() }));
jest.mock('../model-endpoints/model-roles.service', () => ({ resolveRoleModel: jest.fn(async () => 'jev'), resolveRoleFallback: jest.fn(async () => '') }));
jest.mock('../model-endpoints/model-endpoints.service', () => ({ resolveRegistryModel: jest.fn(async () => null) }));
jest.mock('../memory/context-store', () => ({ storeGet: jest.fn(async () => null), storePut: jest.fn(async () => undefined) }));

import { STATE_SAMPLE_RATE_DEFAULT, STATE_SAMPLE_RATE_PURPOSE_DEFAULTS, stateSampleRate } from './decision-gate';

const ENV = ['DECISION_GATE_STATE_SAMPLE_RATE', 'DECISION_GATE_STATE_SAMPLE_RATE_WAKE_TRIAGE', 'DECISION_GATE_STATE_SAMPLE_RATE_AUTO_ROUTE', 'DECISION_GATE_STATE_SAMPLE_DISABLED'];
const savedNodeEnv = process.env.NODE_ENV;
beforeEach(() => { for (const k of ENV) delete process.env[k]; });
afterEach(() => { for (const k of ENV) delete process.env[k]; process.env.NODE_ENV = savedNodeEnv; });

describe('CT-9 — sampled-state corpus defaults', () => {
  it('under NODE_ENV=test the bare default stays 0 (hermeticity); an env rate opts a suite in', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(stateSampleRate('wake_triage')).toBe(0);
    expect(stateSampleRate('auto_route')).toBe(0);
    process.env.DECISION_GATE_STATE_SAMPLE_RATE = '0.3';
    expect(stateSampleRate('auto_route')).toBe(0.3);
  });
  it('outside test: 0.05 globally, wake_triage 0.2; per-purpose env, then the global env, win; RATE=0 and _DISABLED=1 turn it off; probes never sample', () => {
    expect(STATE_SAMPLE_RATE_DEFAULT).toBe(0.05);
    expect(STATE_SAMPLE_RATE_PURPOSE_DEFAULTS).toEqual({ wake_triage: 0.2, task_kind: 0 });
    process.env.NODE_ENV = 'production';
    expect(stateSampleRate('wake_triage')).toBe(0.2);
    expect(stateSampleRate('auto_route')).toBe(0.05);
    expect(stateSampleRate('compute_policy')).toBe(0.05);
    expect(stateSampleRate('probe')).toBe(0);
    process.env.DECISION_GATE_STATE_SAMPLE_RATE = '0.01';
    expect(stateSampleRate('wake_triage')).toBe(0.01); // the global env beats the per-purpose BUILT-IN default
    process.env.DECISION_GATE_STATE_SAMPLE_RATE_WAKE_TRIAGE = '0.5';
    expect(stateSampleRate('wake_triage')).toBe(0.5);
    process.env.DECISION_GATE_STATE_SAMPLE_RATE = '0';
    expect(stateSampleRate('auto_route')).toBe(0);
    delete process.env.DECISION_GATE_STATE_SAMPLE_RATE;
    process.env.DECISION_GATE_STATE_SAMPLE_RATE_AUTO_ROUTE = '';
    expect(stateSampleRate('auto_route')).toBe(0.05); // a blank compose passthrough is UNSET
    process.env.DECISION_GATE_STATE_SAMPLE_DISABLED = '1';
    expect(stateSampleRate('wake_triage')).toBe(0);
    expect(stateSampleRate('auto_route')).toBe(0);
  });
});

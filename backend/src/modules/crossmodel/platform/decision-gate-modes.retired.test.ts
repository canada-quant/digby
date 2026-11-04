/**
 * decision-gate-modes.ts — backlog E13 (2026-09-28): REGISTRY RETIREMENT.
 *   - tool_intent is retired: PURPOSE_RETIRED names it, its bare default mode is
 *     'off' (source 'retired_default'), an explicit per-purpose env / the
 *     DECISION_GATE_DEFAULT_MODE env still govern, the lift env restores the
 *     ordinary bare default, and it is act-capped (an 'act' resolves to shadow).
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../memory/context-store', () => ({ storeGet: jest.fn(async () => null), storePut: jest.fn(async () => undefined) }));
class FakeAppError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
jest.mock('../../../middleware/error-handler', () => ({ AppError: FakeAppError }));
jest.mock('./loop-metrics.service', () => ({ LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' }, recordLoopMetric: jest.fn() }));

import { PURPOSE_ACT_CAPS, PURPOSE_RETIRED, capDecisionMode, envDecisionMode, purposeActCap, purposeRetired, retireLiftEnv } from './decision-gate-modes';

const ENV = ['DECISION_GATE_MODE_TOOL_INTENT', 'DECISION_GATE_DEFAULT_MODE', 'DECISION_GATE_TOOL_INTENT_RETIRE_LIFTED', 'DECISION_GATE_TOOL_INTENT_ACT_CAP_DISABLED'];
beforeEach(() => { for (const k of ENV) delete process.env[k]; });
afterEach(() => { for (const k of ENV) delete process.env[k]; });

describe('E13 — PURPOSE_RETIRED (tool_intent)', () => {
  it('names tool_intent with a since date + why; purposeRetired reads it; the lift env is DECISION_GATE_TOOL_INTENT_RETIRE_LIFTED', () => {
    expect(Object.keys(PURPOSE_RETIRED)).toEqual(['tool_intent']);
    expect(PURPOSE_RETIRED.tool_intent).toMatchObject({ since: '2026-09-28', why: expect.stringMatching(/no act consumer/) });
    expect(purposeRetired('tool_intent')).toBe(true);
    expect(purposeRetired('wake_triage')).toBe(false);
    expect(retireLiftEnv('tool_intent')).toBe('DECISION_GATE_TOOL_INTENT_RETIRE_LIFTED');
    process.env.DECISION_GATE_TOOL_INTENT_RETIRE_LIFTED = '1';
    expect(purposeRetired('tool_intent')).toBe(false);
  });
  it('bare default mode is off (source retired_default); per-purpose env and DECISION_GATE_DEFAULT_MODE win; lifted ⇒ the ordinary bare default; other purposes unchanged', () => {
    expect(envDecisionMode('tool_intent')).toEqual({ mode: 'off', source: 'retired_default' });
    expect(envDecisionMode('wake_triage').source).toBe('default');
    process.env.DECISION_GATE_MODE_TOOL_INTENT = 'shadow';
    expect(envDecisionMode('tool_intent')).toEqual({ mode: 'shadow', source: 'env_purpose' });
    delete process.env.DECISION_GATE_MODE_TOOL_INTENT;
    process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
    expect(envDecisionMode('tool_intent')).toEqual({ mode: 'shadow', source: 'env_default' });
    delete process.env.DECISION_GATE_DEFAULT_MODE;
    process.env.DECISION_GATE_TOOL_INTENT_RETIRE_LIFTED = '1';
    expect(envDecisionMode('tool_intent').source).toBe('default');
  });
  it('a retired purpose is act-capped: PURPOSE_ACT_CAPS names it, an act resolves to shadow (registry_cap), and the cap lifts under its own env', () => {
    expect(Object.keys(PURPOSE_ACT_CAPS)).toContain('tool_intent');
    expect(purposeActCap('tool_intent')).toMatchObject({ since: '2026-09-28', liftEnv: 'DECISION_GATE_TOOL_INTENT_ACT_CAP_DISABLED', why: expect.stringMatching(/retired/) });
    expect(capDecisionMode('tool_intent', { mode: 'act', source: 'store' })).toEqual({ mode: 'shadow', source: 'registry_cap' });
    expect(capDecisionMode('tool_intent', { mode: 'off', source: 'store' })).toEqual({ mode: 'off', source: 'store' });
    process.env.DECISION_GATE_TOOL_INTENT_ACT_CAP_DISABLED = '1';
    expect(capDecisionMode('tool_intent', { mode: 'act', source: 'store' })).toEqual({ mode: 'act', source: 'store' });
  });
});

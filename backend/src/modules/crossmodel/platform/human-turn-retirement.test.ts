/**
 * roster 2026-10-06 B-2 — platform/human-turn-retirement.ts skipRetiredHumanAsk: the ONE check every
 * retired-on-human-turns ask site makes (auto_route / compute_policy / checker_route / drafts_agree).
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
const mockRecord: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecord(...a),
}));

import { skipRetiredHumanAsk, DECISION_ASK_RETIRED_KIND } from './human-turn-retirement';
import { LOOP_METRIC_KINDS } from './loop-metrics.service';
import { TURN_PLAN_HYGIENE_KIND } from '../chat-agent/turn-plan-labels';

const ENV = ['DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED', 'DECISION_GATE_COMPUTE_POLICY_HUMAN_RETIRE_LIFTED'];
beforeEach(() => { mockRecord.mockReset(); for (const k of ENV) delete process.env[k]; });
afterAll(() => { for (const k of ENV) delete process.env[k]; });

describe('skipRetiredHumanAsk', () => {
  it('a retired purpose ⇒ true + ONE decision_ask_retired row { purpose, site, segment } on the session', () => {
    expect(skipRetiredHumanAsk('compute_policy', { site: 'send', segment: 'user', sessionId: 'c1' })).toBe(true);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0]).toEqual({ kind: 'decision_ask_retired', sessionId: 'c1', meta: { purpose: 'compute_policy', site: 'send', segment: 'user' } });
  });

  it('a purpose that is not retired on human turns ⇒ false, no row', () => {
    expect(skipRetiredHumanAsk('turn_plan', { site: 'x' })).toBe(false);
    expect(skipRetiredHumanAsk('wake_triage', { site: 'x' })).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('the per-purpose lift env and the global kill switch ⇒ false, no row (the ask runs as before)', () => {
    process.env.DECISION_GATE_COMPUTE_POLICY_HUMAN_RETIRE_LIFTED = '1';
    expect(skipRetiredHumanAsk('compute_policy', { site: 'send' })).toBe(false);
    expect(skipRetiredHumanAsk('drafts_agree', { site: 'reconcile' })).toBe(true);
    process.env.DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED = '1';
    expect(skipRetiredHumanAsk('drafts_agree', { site: 'reconcile' })).toBe(false);
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('never throws: a recorder failure still answers (the skip stands only when the row path did not throw — else the ask runs)', () => {
    mockRecord.mockImplementation(() => { throw new Error('boom'); });
    expect(() => skipRetiredHumanAsk('auto_route', { site: 'route' })).not.toThrow();
  });

  it('the literal kinds equal the LOOP_METRIC_KINDS registry (partial mocks in consumer suites cannot drop them)', () => {
    expect(DECISION_ASK_RETIRED_KIND).toBe(LOOP_METRIC_KINDS.DECISION_ASK_RETIRED);
    expect(TURN_PLAN_HYGIENE_KIND).toBe(LOOP_METRIC_KINDS.TURN_PLAN_HYGIENE);
  });
});

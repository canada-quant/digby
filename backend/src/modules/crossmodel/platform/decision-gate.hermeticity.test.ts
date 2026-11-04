/**
 * Ticket 0aeb8844-adjacent / e580b601 verify-blocker — decision-gate
 * hermeticity under NODE_ENV='test' (source-level fix replay).
 *
 * THE SHORTFALL (found while un-blocking the e580b601 PR's verify pass,
 * 2026-09-24 17:39–17:53Z): hooks.service.test.ts's wake-telemetry pin
 * "a delivered wake records wake_delivered … expect(recordLoopMetric)
 * .toHaveBeenCalledTimes(1)" failed in EVERY Digby coding container with
 * "Expected 1, Received 3" while CI (keyless jest env) stayed green at the
 * same sha. Cause: decisionMode() defaulted every purpose to 'shadow', and
 * backendForSpec() serves the DeepSeek logprob readout whenever
 * DEEPSEEK_API_KEY is present — coding containers carry the owner's real
 * provider keys, so the wake sweep's wake_triage decide() ran LIVE (a real
 * API call from inside a unit test) and its two shadow telemetry rows rode
 * the same mocked recordLoopMetric. Verified live in-container: the 3 calls
 * were [wake_triage decision], [wake_triage outcome], [wake_delivered].
 *
 * FIX (decision-gate.ts): the BARE default is 'off' under NODE_ENV='test';
 * an explicit DECISION_GATE_MODE_<PURPOSE> / DECISION_GATE_DEFAULT_MODE
 * always wins; 'probe' is always 'act'; production default stays 'shadow'.
 *
 * Pinned here:
 *   (i)   bare default is 'off' under jest's NODE_ENV='test' EVEN WITH
 *         DEEPSEEK_API_KEY present (the exact container condition);
 *   (ii)  explicit DECISION_GATE_DEFAULT_MODE='shadow' overrides the test
 *         default (suites that exercise the gate opt back in);
 *   (iii) per-purpose DECISION_GATE_MODE_WAKE_TRIAGE='shadow' overrides too;
 *   (iv)  decide() with the bare test default makes NO axios call even with
 *         the key present (no live API calls from unit tests);
 *   (v)   production shape: with NODE_ENV unset, the bare default is
 *         'shadow' (the pre-fix behavior is preserved outside tests).
 */

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' },
  recordLoopMetric: jest.fn(),
}));
import axios from 'axios';

import { decisionMode, decide } from './decision-gate';

const post = (axios as any).post as jest.Mock;
const ENV_KEYS = ['DECISION_GATE_DISABLED', 'DECISION_GATE_DEFAULT_MODE', 'DECISION_GATE_MODE_WAKE_TRIAGE', 'DEEPSEEK_API_KEY', 'NODE_ENV'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.NODE_ENV = 'test';
  post.mockReset();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('decision-gate hermeticity under NODE_ENV=test (e580b601 verify-blocker class)', () => {
  it('(i) bare default is off under test EVEN WITH the real provider key present — the coding-container condition', () => {
    process.env.DEEPSEEK_API_KEY = 'container-carries-a-real-provider-key';
    expect(decisionMode('wake_triage')).toBe('off');
    expect(decisionMode('auto_route')).toBe('off');
  });

  it('(ii) explicit DECISION_GATE_DEFAULT_MODE overrides the test default (gate-exercising suites opt back in)', () => {
    process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
    expect(decisionMode('wake_triage')).toBe('shadow');
  });

  it('(iii) per-purpose DECISION_GATE_MODE_WAKE_TRIAGE overrides too', () => {
    process.env.DECISION_GATE_MODE_WAKE_TRIAGE = 'shadow';
    expect(decisionMode('wake_triage')).toBe('shadow');
    expect(decisionMode('auto_route')).toBe('off'); // other purposes keep the test default
  });

  it('(iv) decide() makes NO axios call under the bare test default, key present — no live API calls from unit tests', async () => {
    process.env.DEEPSEEK_API_KEY = 'container-carries-a-real-provider-key';
    const r = await decide('state', { q: { type: 'noul', instructions: 'needs a turn now?' } }, { purpose: 'wake_triage' });
    expect(r).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('(v) production shape preserved: NODE_ENV unset → bare default shadow', () => {
    delete process.env.NODE_ENV;
    expect(decisionMode('wake_triage')).toBe('shadow');
  });
});

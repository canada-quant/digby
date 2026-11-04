/**
 * A4 (2026-10-04 coding quick wins) — machine-firing effort step-down: the pure
 * decision (machine-firing-effort.ts) and the provider seam
 * (coding/effort-cap.ts capReasoningEffort — the ONE lower-only cap, shared with the chat lead-effort A/B) through the REAL payload builder, so the
 * custom-endpoint effort contract is pinned end to end: a built-in GLM /
 * DeepSeek seat goes max → high, a custom endpoint that sends an effort goes
 * max → high, an 'unsupported' endpoint / a no-think model / Kimi K3 (no effort
 * key) still send none. The run-executor wiring is pinned in
 * run-executor.test.ts, the agent seam in agent-machine-firing-effort.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));

import { capReasoningEffort } from './effort-cap';
import {
  machineFiringEffortStepdownDisabled, machineFiringEffortApplies, machineFiringEffortDecision, MACHINE_FIRING_STEPDOWN_EFFORT,
} from './machine-firing-effort';
import {
  resolveProvider, buildTurnPayload, customEndpointEffortExtra, __resetReasoningEffortLatchForTests, latchReasoningEffort,
  ProviderConfig, THINKING_OFF_EXTRA,
} from './coding-model';

const msgs = [{ role: 'user', content: 'hi' }];
const tool = { type: 'function', function: { name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} } } };
const custom = (reasoningEffort: 'auto' | 'supported' | 'unsupported', extra: Record<string, any>): ProviderConfig => ({
  url: 'https://llm.example.test/v1/chat/completions', apiKey: 'k', model: 'api-optimize-zai-glm-5.3',
  label: 'gw (custom endpoint)', extra, reasoningEffort,
});

beforeEach(() => {
  __resetReasoningEffortLatchForTests();
  delete process.env.MACHINE_FIRING_EFFORT_STEPDOWN_DISABLED;
});

describe('machineFiringEffortApplies', () => {
  it('schedule and hook firings only — never a human turn, an owner dispatch, an agent send or an auto-resume', () => {
    expect(machineFiringEffortApplies({ triggerKind: 'schedule' })).toBe(true);
    expect(machineFiringEffortApplies({ triggerKind: 'hook' })).toBe(true);
    expect(machineFiringEffortApplies({ triggerKind: 'user' })).toBe(false);
    expect(machineFiringEffortApplies({ triggerKind: 'machine' })).toBe(false); // agent / webhook / auto-resume
    expect(machineFiringEffortApplies({ triggerKind: 'schedule', ownerDispatch: true })).toBe(false);
  });
});

describe('machineFiringEffortDecision', () => {
  it('all-complete board ⇒ cap high; open board / no plan ⇒ keep (recorded only)', () => {
    expect(machineFiringEffortDecision({ hasPlan: true, allComplete: true })).toEqual({ cap: 'high', reason: 'all_complete_board' });
    expect(machineFiringEffortDecision({ hasPlan: true, allComplete: false })).toEqual({ cap: null, reason: 'board_open' });
    expect(machineFiringEffortDecision({ hasPlan: false, allComplete: false })).toEqual({ cap: null, reason: 'no_plan' });
    expect(MACHINE_FIRING_STEPDOWN_EFFORT).toBe('high');
  });
  it('kill switch reader', () => {
    expect(machineFiringEffortStepdownDisabled()).toBe(false);
    process.env.MACHINE_FIRING_EFFORT_STEPDOWN_DISABLED = '1';
    expect(machineFiringEffortStepdownDisabled()).toBe(true);
  });
});

describe('capReasoningEffort (lower-only; never adds the key)', () => {
  it('lowers max / xhigh to the cap, keeps an effort at or below it and non-ladder values', () => {
    expect(capReasoningEffort({ reasoning_effort: 'max', max_tokens: 9 }, 'high')).toEqual({ reasoning_effort: 'high', max_tokens: 9 });
    expect(capReasoningEffort({ reasoning_effort: 'xhigh' }, 'high')).toEqual({ reasoning_effort: 'high' });
    const atCap = { reasoning_effort: 'high' };
    expect(capReasoningEffort(atCap, 'high')).toBe(atCap);
    const below = { reasoning_effort: 'medium' };
    expect(capReasoningEffort(below, 'high')).toBe(below);
    const none = { reasoning_effort: 'none' };
    expect(capReasoningEffort(none, 'high')).toBe(none);
    const noKey = { max_completion_tokens: 262144 };
    expect(capReasoningEffort(noKey, 'high')).toBe(noKey);
    expect(capReasoningEffort(undefined, 'high')).toBeUndefined();
  });

  it('never mutates the input extra', () => {
    const extra = { reasoning_effort: 'max' };
    capReasoningEffort(extra, 'high');
    expect(extra).toEqual({ reasoning_effort: 'max' });
  });

  it('built-in GLM-5.3 and DeepSeek agent seats send high; Kimi K3 (no effort key) still sends none', () => {
    for (const id of ['glm-5.3', 'deepseek-flash'] as const) {
      const p = resolveProvider(id);
      expect(p.extra?.reasoning_effort).toBe('max');
      const capped = { ...p, extra: capReasoningEffort(p.extra, 'high') };
      expect(buildTurnPayload(capped, msgs, [tool]).reasoning_effort).toBe('high');
    }
    const kimi = resolveProvider('kimi-k3');
    const kimiCapped = { ...kimi, extra: capReasoningEffort(kimi.extra, 'high') };
    expect(kimiCapped.extra).toBe(kimi.extra);
    expect(buildTurnPayload(kimiCapped, msgs, [tool])).not.toHaveProperty('reasoning_effort');
  });

  it('custom endpoints: an effort-sending endpoint (auto / supported) gets high; unsupported / no-think get nothing', () => {
    const auto = custom('auto', { ...customEndpointEffortExtra({ reasoningEffort: 'auto' }) });
    expect(buildTurnPayload({ ...auto, extra: capReasoningEffort(auto.extra, 'high') }, msgs, [tool]).reasoning_effort).toBe('high');
    const supported = custom('supported', { ...customEndpointEffortExtra({ reasoningEffort: 'supported' }) });
    expect(buildTurnPayload({ ...supported, extra: capReasoningEffort(supported.extra, 'high') }, msgs, [tool]).reasoning_effort).toBe('high');

    const unsupported = custom('unsupported', { ...customEndpointEffortExtra({ reasoningEffort: 'unsupported' }) });
    expect(unsupported.extra).toEqual({});
    expect(buildTurnPayload({ ...unsupported, extra: capReasoningEffort(unsupported.extra, 'high') }, msgs, [tool])).not.toHaveProperty('reasoning_effort');

    const noThink = custom('auto', { ...THINKING_OFF_EXTRA });
    expect(buildTurnPayload({ ...noThink, extra: capReasoningEffort(noThink.extra, 'high') }, msgs, [tool])).not.toHaveProperty('reasoning_effort');
  });

  it('a latched lower rung on a custom endpoint still wins at payload time (hygiene runs after the cap)', () => {
    const auto = custom('auto', { reasoning_effort: 'max' });
    latchReasoningEffort(auto, 'medium');
    expect(buildTurnPayload({ ...auto, extra: capReasoningEffort(auto.extra, 'high') }, msgs, [tool]).reasoning_effort).toBe('medium');
    latchReasoningEffort(auto, 'none');
    expect(buildTurnPayload({ ...auto, extra: capReasoningEffort(auto.extra, 'high') }, msgs, [tool]).reasoning_effort).toBe('none');
  });
});

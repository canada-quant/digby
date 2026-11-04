import { capReasoningEffort } from './effort-cap';

describe('capReasoningEffort', () => {
  it('lowers an effort above the cap', () => {
    expect(capReasoningEffort({ reasoning_effort: 'max', max_tokens: 9 }, 'high')).toEqual({ reasoning_effort: 'high', max_tokens: 9 });
    expect(capReasoningEffort({ reasoning_effort: 'xhigh' }, 'medium')).toEqual({ reasoning_effort: 'medium' });
  });
  it('never raises, never adds the param, never touches unknown values', () => {
    expect(capReasoningEffort({ reasoning_effort: 'low' }, 'high')).toEqual({ reasoning_effort: 'low' });
    expect(capReasoningEffort({ temperature: 0.6 }, 'high')).toEqual({ temperature: 0.6 });
    expect(capReasoningEffort({ reasoning_effort: 'turbo' }, 'high')).toEqual({ reasoning_effort: 'turbo' });
    expect(capReasoningEffort(undefined, 'high')).toBeUndefined();
  });
  it('no cap = unchanged (same object)', () => {
    const x = { reasoning_effort: 'max' };
    expect(capReasoningEffort(x, null)).toBe(x);
  });
});

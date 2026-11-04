import { humanTurnProviderExtra, effortProviderExtra } from './human-turn-effort';

describe('humanTurnProviderExtra — a human-typed turn answers at CHAT_HUMAN_TURN_EFFORT (owner 2026-09-22: 10-minute waits)', () => {
  afterEach(() => { delete process.env.CHAT_HUMAN_TURN_EFFORT; });
  it("built-in glm / deepseek seats get reasoning_effort 'high' on a human turn; machine turns keep the seat's 'max'", () => {
    expect(humanTurnProviderExtra('glm-5.3', false)).toEqual({ providerExtra: { reasoning_effort: 'high' } });
    expect(humanTurnProviderExtra('deepseek-flash', false)).toEqual({ providerExtra: { reasoning_effort: 'high' } });
    expect(humanTurnProviderExtra('glm-5.3', true)).toEqual({});
  });
  it('kimi-k3 and custom endpoints are never sent the param', () => {
    expect(humanTurnProviderExtra('kimi-k3', false)).toEqual({});
    expect(humanTurnProviderExtra('nebius-b300:glm-5.3', false)).toEqual({});
    expect(humanTurnProviderExtra('', false)).toEqual({});
  });
  it("CHAT_HUMAN_TURN_EFFORT=max restores everywhere-max; other valid values pass through; junk falls back to 'high'", () => {
    process.env.CHAT_HUMAN_TURN_EFFORT = 'max';
    expect(humanTurnProviderExtra('glm-5.3', false)).toEqual({});
    process.env.CHAT_HUMAN_TURN_EFFORT = 'medium';
    expect(humanTurnProviderExtra('glm-5.3', false)).toEqual({ providerExtra: { reasoning_effort: 'medium' } });
    process.env.CHAT_HUMAN_TURN_EFFORT = 'turbo';
    expect(humanTurnProviderExtra('glm-5.3', false)).toEqual({ providerExtra: { reasoning_effort: 'high' } });
  });
});

describe('effortProviderExtra — the shared model rule (N9 wake_effort act path reuses it)', () => {
  it("built-in glm / deepseek take the param; 'max' and null send nothing; kimi-k3 and custom endpoints never get it", () => {
    expect(effortProviderExtra('glm-5.3', 'high')).toEqual({ providerExtra: { reasoning_effort: 'high' } });
    expect(effortProviderExtra('deepseek-flash', 'medium')).toEqual({ providerExtra: { reasoning_effort: 'medium' } });
    expect(effortProviderExtra('glm-5.3', 'max')).toEqual({});
    expect(effortProviderExtra('glm-5.3', null)).toEqual({});
    expect(effortProviderExtra('kimi-k3', 'high')).toEqual({});
    expect(effortProviderExtra('nebius-b300:glm-5.3', 'high')).toEqual({});
  });
});

describe('lead-effort A/B arm (2026-10-04)', () => {
  const { leadEffortArm, leadEffortAbShare, stableUnit } = jest.requireActual('./human-turn-effort') as typeof import('./human-turn-effort');

  it('share: default 0.5, blank / garbage = default, clamped 0..1', () => {
    expect(leadEffortAbShare({})).toBe(0.5);
    expect(leadEffortAbShare({ CHAT_LEAD_EFFORT_AB_SHARE: '' })).toBe(0.5);
    expect(leadEffortAbShare({ CHAT_LEAD_EFFORT_AB_SHARE: 'x' })).toBe(0.5);
    expect(leadEffortAbShare({ CHAT_LEAD_EFFORT_AB_SHARE: '2' })).toBe(1);
    expect(leadEffortAbShare({ CHAT_LEAD_EFFORT_AB_SHARE: '-1' })).toBe(0);
  });

  it('the arm is stable per turn key and splits roughly by the share', () => {
    expect(leadEffortArm('chat-1:123', {})).toBe(leadEffortArm('chat-1:123', {}));
    const arms = Array.from({ length: 2000 }, (_, i) => leadEffortArm(`c:${i}`, {}));
    const high = arms.filter((a) => a === 'high').length;
    expect(high).toBeGreaterThan(850);
    expect(high).toBeLessThan(1150);
    expect(stableUnit('x')).toBeGreaterThanOrEqual(0);
    expect(stableUnit('x')).toBeLessThan(1);
  });

  it('share 1 = every turn high, share 0 = every turn control; the kill switch = no arm', () => {
    expect(leadEffortArm('k', { CHAT_LEAD_EFFORT_AB_SHARE: '1' })).toBe('high');
    expect(leadEffortArm('k', { CHAT_LEAD_EFFORT_AB_SHARE: '0' })).toBe('max');
    expect(leadEffortArm('k', { CHAT_LEAD_EFFORT_AB_DISABLED: '1' })).toBeNull();
    expect(leadEffortArm('', {})).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { addableCouncilModels, councilBadges, councilDirty } from './reflection-council';
import type { FrontierCouncilModel } from '@/lib/api/model-endpoints';

const m = (spec: string, over: Partial<FrontierCouncilModel> = {}): FrontierCouncilModel => ({
  spec, name: spec, family: 'claude', tier: 'strong', priceIn: null, priceOut: null, ...over,
});

describe('reflection council editor helpers', () => {
  it('offers only candidates not already on the council', () => {
    expect(addableCouncilModels([m('a'), m('b'), m('c')], ['b']).map(x => x.spec)).toEqual(['a', 'c']);
  });
  it('dirty when the list or its order changed', () => {
    expect(councilDirty(['a', 'b'], ['a', 'b'])).toBe(false);
    expect(councilDirty(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(councilDirty([], ['a'])).toBe(true);
  });
  it('badges: vendor, tier, price or an honest "price unknown"', () => {
    expect(councilBadges(m('x', { family: 'gpt', priceIn: 1.25, priceOut: 10 }))).toEqual(['gpt', 'strong', '$1.25→$10/M']);
    expect(councilBadges(m('y'))).toEqual(['claude', 'strong', 'price unknown (estimated)']);
    expect(councilBadges(undefined)).toEqual(['not available here']);
  });
});

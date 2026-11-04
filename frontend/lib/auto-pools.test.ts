import { describe, it, expect } from 'vitest';
import { draftFromView, dirtyPoolPatch, addableModels, cardBadges, movePoolEntry } from './auto-pools';
import type { CatalogModelCard } from '@/lib/api/model-endpoints';

const card = (spec: string, over: Partial<CatalogModelCard> = {}): CatalogModelCard => ({
  spec, name: spec, source: 'registry', family: 'qwen', tier: 'standard', vision: false, contextChars: null, maxTools: null,
  priceIn: null, priceOut: null, frontier: false, autoEligible: true, servable: true, thinkingOff: false, ...over,
});

describe('draftFromView / dirtyPoolPatch', () => {
  const view = { config: { pools: { quick: ['a', 'b'] } } };
  it('the draft is the stored lists; untouched roles are empty (following the seats)', () => {
    expect(draftFromView(view)).toEqual({ quick: ['a', 'b'], lead: [], checker: [], colleague: [] });
  });
  it('only changed roles are sent; a cleared list is sent as []', () => {
    const d = draftFromView(view);
    expect(dirtyPoolPatch(view, d)).toEqual({});
    expect(dirtyPoolPatch(view, { ...d, quick: ['b', 'a'] })).toEqual({ quick: ['b', 'a'] });
    expect(dirtyPoolPatch(view, { ...d, quick: [] })).toEqual({ quick: [] });
    expect(dirtyPoolPatch(view, { ...d, lead: ['x'] })).toEqual({ lead: ['x'] });
  });
});

describe('addableModels', () => {
  const catalog = [
    card('strong', { tier: 'strong' }),
    card('fast', { tier: 'fast' }),
    card('claude', { frontier: true, autoEligible: false }),
    card('listed'),
  ];
  it('never offers a frontier model or one already listed', () => {
    expect(addableModels(catalog, 'lead', ['listed']).map(c => c.spec)).toEqual(['strong', 'fast']);
  });
  it('the Quick pool lists fast models first', () => {
    expect(addableModels(catalog, 'quick', []).map(c => c.spec)).toEqual(['fast', 'listed', 'strong']);
  });
});

describe('cardBadges', () => {
  it('names family, tier, vision, no-think, price and a missing key', () => {
    expect(cardBadges(card('x', { tier: 'fast', vision: true, thinkingOff: true, priceIn: 0.1, priceOut: 0.3, servable: false })))
      .toEqual(['qwen', 'fast', 'vision', 'no-think', '$0.1→$0.3/M', 'no key here']);
    expect(cardBadges(undefined)).toEqual(['unknown model']);
  });
});

describe('movePoolEntry', () => {
  it('swaps neighbours and is a no-op at the ends', () => {
    expect(movePoolEntry(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(movePoolEntry(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(movePoolEntry(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});

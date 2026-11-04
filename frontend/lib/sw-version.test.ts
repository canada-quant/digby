import { describe, it, expect } from 'vitest';
import { parseSwVersion, shouldReloadForSwVersion, versionToStore, SW_RELOAD_MIN_GAP_MS } from './sw-version';

describe('sw-version — no reload ping-pong during a rollout (owner recording 2026-10-07)', () => {
  it('parses digby-vNNN only', () => {
    expect(parseSwVersion('digby-v405')).toBe(405);
    expect(parseSwVersion('reloading')).toBeNull();
    expect(parseSwVersion(null)).toBeNull();
  });

  it('reloads only for a strictly newer version', () => {
    const base = { lastReloadAt: null, now: 1_000_000 };
    expect(shouldReloadForSwVersion({ ...base, lastKnown: 'digby-v404', incoming: 'digby-v405' })).toBe(true);
    expect(shouldReloadForSwVersion({ ...base, lastKnown: 'digby-v405', incoming: 'digby-v404' })).toBe(false); // the old box's sw.js
    expect(shouldReloadForSwVersion({ ...base, lastKnown: 'digby-v405', incoming: 'digby-v405' })).toBe(false);
    expect(shouldReloadForSwVersion({ ...base, lastKnown: 'reloading', incoming: 'digby-v405' })).toBe(false);
    expect(shouldReloadForSwVersion({ ...base, lastKnown: null, incoming: 'digby-v405' })).toBe(false); // first visit
  });

  it('never auto-reloads twice within the gap', () => {
    const now = 5_000_000;
    expect(shouldReloadForSwVersion({ lastKnown: 'digby-v404', incoming: 'digby-v405', lastReloadAt: now - 5_000, now })).toBe(false);
    expect(shouldReloadForSwVersion({ lastKnown: 'digby-v404', incoming: 'digby-v405', lastReloadAt: now - SW_RELOAD_MIN_GAP_MS - 1, now })).toBe(true);
  });

  it('the stored version never goes down', () => {
    expect(versionToStore('digby-v405', 'digby-v404')).toBe('digby-v405');
    expect(versionToStore('digby-v404', 'digby-v405')).toBe('digby-v405');
    expect(versionToStore('reloading', 'digby-v405')).toBe('digby-v405');
    expect(versionToStore(null, 'digby-v405')).toBe('digby-v405');
  });

  it('replays the rollout: alternating v404/v405 sw.js triggers at most ONE reload', () => {
    let stored: string | null = 'digby-v404';
    let lastReloadAt: number | null = null;
    let reloads = 0;
    let now = 0;
    for (let i = 0; i < 40; i++) {
      now += 2_500;
      const incoming = i % 2 === 0 ? 'digby-v405' : 'digby-v404';
      if (shouldReloadForSwVersion({ lastKnown: stored, incoming, lastReloadAt, now })) { reloads++; lastReloadAt = now; }
      stored = versionToStore(stored, incoming);
    }
    expect(reloads).toBe(1);
  });
});

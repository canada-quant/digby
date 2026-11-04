/**
 * MessageNavigator helper tests — node-environment vitest idiom (no jsdom,
 * same as assistant-parts.test.tsx): pin the pure pieces (preview truncation,
 * tick collision filtering). The component's DOM measurement itself is
 * observer-driven and exercised in the browser.
 */

import { describe, it, expect } from 'vitest';
import { navPreview, dropCollisions, type NavTick } from './MessageNavigator';

const tick = (id: string, pct: number): NavTick => ({ id, preview: `msg ${id}`, pct });

describe('navPreview', () => {
  it('collapses newlines and repeated whitespace into one line', () => {
    expect(navPreview('hello\n\nworld   again\there')).toBe('hello world again here');
  });

  it('trims leading/trailing whitespace', () => {
    expect(navPreview('   padded   ')).toBe('padded');
  });

  it('returns empty string for empty/whitespace-only content', () => {
    expect(navPreview('')).toBe('');
    expect(navPreview('  \n ')).toBe('');
  });

  it('keeps short content untouched', () => {
    expect(navPreview('short message')).toBe('short message');
  });

  it('truncates beyond 64 chars with an ellipsis', () => {
    const long = `x${'y'.repeat(100)}`;
    const out = navPreview(long);
    expect(out.length).toBe(64);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('dropCollisions', () => {
  it('passes everything through when the rail height is unmeasured', () => {
    const ticks = [tick('a', 0.5), tick('a2', 0.501)];
    expect(dropCollisions(ticks, 0)).toEqual(ticks);
  });

  it('keeps well-separated ticks', () => {
    // 1000px rail: 100px apart — no drop.
    const ticks = [tick('a', 0.1), tick('b', 0.2), tick('c', 0.9)];
    expect(dropCollisions(ticks, 1000).map(t => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a tick that lands too close to the previous kept one (keeps the earlier)', () => {
    // 800px rail, min gap 16px: b is 8px after a → dropped; c is 400px after a → kept.
    const ticks = [tick('a', 0.1), tick('b', 0.11), tick('c', 0.6)];
    expect(dropCollisions(ticks, 800).map(t => t.id)).toEqual(['a', 'c']);
  });

  it('measures the gap against the last KEPT tick, not the last dropped one', () => {
    // Chain a(80px) b(88px, dropped vs a) c(92px, dropped vs a) d(200px, kept).
    const ticks = [tick('a', 0.1), tick('b', 0.11), tick('c', 0.115), tick('d', 0.25)];
    expect(dropCollisions(ticks, 800).map(t => t.id)).toEqual(['a', 'd']);
  });

  it('handles a single tick and an empty list', () => {
    expect(dropCollisions([tick('a', 0.5)], 800)).toHaveLength(1);
    expect(dropCollisions([], 800)).toEqual([]);
  });
});

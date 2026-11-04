import { describe, it, expect } from 'vitest';
import { isDigestStale, DIGEST_STALE_MS } from './digest-freshness';

describe('isDigestStale (feedback f3256715 — Project Progress stale badge cried wolf)', () => {
  const NOW = Date.parse('2026-09-03T13:00:00Z');
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  it('a quiet blocked bucket (2d-old content, hourly-touched row) is NOT stale', () => {
    // The f3256715 repro: CQL Business Ops — summary text written 2 days ago,
    // signature-skip touch refreshed updatedAt 20 minutes ago.
    const digest = { generatedAt: iso(2 * 24 * 60 * 60 * 1000), updatedAt: iso(20 * 60 * 1000) };
    expect(isDigestStale(digest, NOW)).toBe(false);
  });

  it('a genuinely behind pipeline (updatedAt untouched for >2.5h) IS stale', () => {
    const digest = { generatedAt: iso(3 * 60 * 60 * 1000), updatedAt: iso(3 * 60 * 60 * 1000) };
    expect(isDigestStale(digest, NOW)).toBe(true);
  });

  it('exactly at the boundary is not stale; one ms past it is', () => {
    expect(isDigestStale({ updatedAt: iso(DIGEST_STALE_MS) }, NOW)).toBe(false);
    expect(isDigestStale({ updatedAt: iso(DIGEST_STALE_MS + 1) }, NOW)).toBe(true);
  });

  it('deploy skew: an old backend row without updatedAt falls back to generatedAt', () => {
    expect(isDigestStale({ generatedAt: iso(3 * 60 * 60 * 1000) }, NOW)).toBe(true);
    expect(isDigestStale({ generatedAt: iso(10 * 60 * 1000) }, NOW)).toBe(false);
  });

  it('missing or unparseable timestamps never cry wolf', () => {
    expect(isDigestStale({}, NOW)).toBe(false);
    expect(isDigestStale({ updatedAt: 'not-a-date' }, NOW)).toBe(false);
  });
});

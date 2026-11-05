/**
 * Retained chat-view cache (ticket b5734922).
 *
 * Owner report 2026-11-04: "every navigation away from chats and back causes a
 * long wait; why are chats not cached?" Root cause: /account, /files and
 * /management are sibling routes, so a round trip unmounts app/crossmodel/
 * page.tsx and the transcript view — every React bit of chat state dies and
 * re-fetches from zero. Only the CODING transcript had a retained snapshot.
 *
 * These are BEHAVIOUR tests (real imports, injected clock) for the shared
 * primitive both surfaces now use. The contract that matters for correctness
 * is here: a retained entry is a FIRST PAINT only, and every way it could
 * outlive its truth — a stale TTL, a corrupted timestamp, a deleted chat, a
 * signed-out account — must resolve to "not served".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRetainedCache,
  CHAT_LIST_CACHE_MAX,
  CHAT_LIST_CACHE_TTL_MS,
} from './chat-view-cache';

const TTL = 1000;

describe('createRetainedCache — first paint, then reconcile', () => {
  let now: number;
  const clock = () => now;
  let cache: ReturnType<typeof createRetainedCache<string>>;

  beforeEach(() => {
    now = 1_000_000;
    cache = createRetainedCache<string>({ ttlMs: TTL, max: 3, now: clock });
  });

  it('serves a retained value immediately (the instant first paint)', () => {
    cache.write('c1', 'rows');
    // Same tick as the write: this is the navigation-return read, and it must
    // hit — a miss here means the user waits on the network again.
    expect(cache.read('c1')).toEqual({ value: 'rows', at: 1_000_000 });
  });

  it('a written value wins over the previous one (revalidate replaces, never merges)', () => {
    cache.write('c1', 'stale-rows');
    cache.read('c1');
    // The fetch resolving is the ONLY writer on reconcile; a seed never
    // re-writes. So a server page that dropped a row must fully replace it.
    cache.write('c1', 'fresh-rows');
    expect(cache.read('c1')?.value).toBe('fresh-rows');
  });

  it('expires past the TTL and drops the entry (no half-hour-old "instant" paint)', () => {
    cache.write('c1', 'rows');
    now += TTL + 1;
    expect(cache.read('c1')).toBeNull();
    // Dropped, not merely hidden — a later read cannot resurrect it.
    expect(cache.size()).toBe(0);
  });

  it('the TTL boundary is inclusive of the last fresh millisecond', () => {
    cache.write('c1', 'rows');
    now += TTL;
    expect(cache.read('c1')?.value).toBe('rows');
    now += 1;
    expect(cache.read('c1')).toBeNull();
  });

  it('never serves an entry with a corrupted timestamp (fails closed)', () => {
    // A NaN/absent `at` must read as expired, never as valid-forever: this is
    // the difference between a stale card and a permanently stale card.
    const bad = createRetainedCache<string>({ ttlMs: TTL, max: 3, now: () => Number.NaN });
    bad.write('c1', 'rows');
    expect(bad.read('c1')).toBeNull();
  });

  it('purge drops exactly one chat — the delete-path contract', () => {
    cache.write('c1', 'a');
    cache.write('c2', 'b');
    cache.purge('c1');
    expect(cache.read('c1')).toBeNull();
    expect(cache.read('c2')?.value).toBe('b');
  });

  it('clear drops everything — the sign-out contract', () => {
    cache.write('c1', 'a');
    cache.write('c2', 'b');
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.read('c1')).toBeNull();
    expect(cache.read('c2')).toBeNull();
  });

  it('evicts the oldest VISIT (LRU), not the oldest write', () => {
    cache.write('c1', 'a');
    cache.write('c2', 'b');
    cache.write('c3', 'c');
    cache.read('c1');          // c1 becomes most-recently-used
    cache.write('c4', 'd');    // over max ⇒ evict the true oldest (c2)
    expect(cache.read('c2')).toBeNull();
    expect(cache.read('c1')?.value).toBe('a');
    expect(cache.read('c3')?.value).toBe('c');
    expect(cache.read('c4')?.value).toBe('d');
  });

  it('stays bounded under repeated writes of new keys', () => {
    for (let i = 0; i < 50; i++) cache.write(`k${i}`, `v${i}`);
    expect(cache.size()).toBe(3);
    expect(cache.read('k49')?.value).toBe('v49');
  });

  it('ignores an empty key instead of storing under ""', () => {
    cache.write('', 'x');
    expect(cache.size()).toBe(0);
    expect(cache.read('')).toBeNull();
    cache.purge('');
  });

  it('a max of 0 or less still keeps one entry (a 0-cap cache would never paint)', () => {
    const tiny = createRetainedCache<string>({ ttlMs: TTL, max: 0, now: clock });
    tiny.write('c1', 'rows');
    expect(tiny.read('c1')?.value).toBe('rows');
  });

  it('honours the default clock when none is injected', () => {
    const real = createRetainedCache<string>({ ttlMs: TTL, max: 1 });
    real.write('c1', 'rows');
    expect(real.read('c1')?.value).toBe('rows');
  });
});

describe('ticket b5734922 — the shipped budget', () => {
  it('the sidebar list is a single short-lived page', () => {
    expect(CHAT_LIST_CACHE_MAX).toBe(1);
    expect(CHAT_LIST_CACHE_TTL_MS).toBeGreaterThan(0);
    // Ten minutes, not hours: the rail is the navigation surface, and a stale
    // rail mis-orders the user's own recents.
    expect(CHAT_LIST_CACHE_TTL_MS).toBe(10 * 60 * 1000);
  });
});
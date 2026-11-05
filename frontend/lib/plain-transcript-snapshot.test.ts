/**
 * plain-transcript-snapshot.ts — ticket ce78ab80 (owner report 2026-11-04:
 * "how come everytime i navigate away from chats and then back i have to wait
 * so long for chats to load? arent they in cache or anything ?").
 *
 * The store's whole job is that a re-open paints instead of waiting, WITHOUT
 * ever letting a stale row outlive its usefulness (the 2026-10-27 stale-delete
 * report: a deleted chat re-opened from a cached transcript). So the rules
 * under test are: TTL expiry, bounded LRU-by-write eviction, explicit drop,
 * and a hit that always reflects the LAST WRITTEN page rather than an older
 * one.
 */
import { describe, it, expect } from 'vitest';
import {
  createSnapshotStore,
  PLAIN_SNAPSHOT_MAX,
  PLAIN_SNAPSHOT_TTL_MS,
  type PlainSnapshotPayload,
} from './plain-transcript-snapshot';

type Row = { id: string; content?: string };

const payload = (tag: string): PlainSnapshotPayload<Row> => ({
  messages: [{ id: tag, content: `msg ${tag}` }],
  paging: { hasMore: false, cursor: null },
  pendingIds: [],
  supervisorChat: false,
});

/** Store with a controllable clock (no fake timers — the TTL rule is pure). */
function storeAt(clock: { t: number }, opts: { ttlMs?: number; max?: number } = {}) {
  return createSnapshotStore<Row>({ ...opts, now: () => clock.t });
}

describe('plain transcript snapshot — lifetime rules', () => {
  it('misses on an unknown chat and returns the written payload on a hit', () => {
    const clock = { t: 1_000 };
    const store = storeAt(clock);
    expect(store.read('chat-a')).toBeNull();
    store.write('chat-a', payload('a'));
    const snap = store.read('chat-a');
    expect(snap).not.toBeNull();
    expect(snap!.messages).toEqual([{ id: 'a', content: 'msg a' }]);
    expect(snap!.at).toBe(1_000);
  });

  it('expires a snapshot past the TTL and drops it on read (no lingering stale row)', () => {
    const clock = { t: 0 };
    const store = storeAt(clock, { ttlMs: 1_000 });
    store.write('chat-a', payload('a'));
    clock.t = 1_000; // exactly at the bound: still fresh (matches the coding snapshot's `>` rule)
    expect(store.read('chat-a')).not.toBeNull();
    clock.t = 1_001; // one ms past: expired
    expect(store.read('chat-a')).toBeNull();
    expect(store.size()).toBe(0); // expired entry was deleted, not just hidden
  });

  it('defaults to the documented 15-minute TTL and 8-chat cap', () => {
    expect(PLAIN_SNAPSHOT_TTL_MS).toBe(15 * 60 * 1000);
    expect(PLAIN_SNAPSHOT_MAX).toBe(8);
  });

  it('a re-write REPLACES the payload and re-anchors the TTL', () => {
    const clock = { t: 0 };
    const store = storeAt(clock, { ttlMs: 100 });
    store.write('chat-a', payload('old'));
    clock.t = 90;
    store.write('chat-a', payload('new'));
    clock.t = 150; // 150 since the first write, only 60 since the second
    expect(store.read('chat-a')!.messages[0].id).toBe('new');
  });
});

describe('plain transcript snapshot — bounded memory', () => {
  it('evicts the least-recently-WRITTEN chat once past the cap', () => {
    const clock = { t: 1_000 };
    const store = storeAt(clock, { max: 3 });
    for (const id of ['a', 'b', 'c']) { clock.t += 1; store.write(id, payload(id)); }
    expect(store.size()).toBe(3);
    // Touch 'a' by re-writing it: now 'b' is the oldest, so 'b' goes next.
    clock.t += 1; store.write('a', payload('a'));
    clock.t += 1; store.write('d', payload('d'));
    expect(store.size()).toBe(3);
    expect(store.read('b')).toBeNull();
    expect(store.read('a')).not.toBeNull();
    expect(store.read('c')).not.toBeNull();
    expect(store.read('d')).not.toBeNull();
  });

  it('drop() removes one chat and leaves the others (the delete/archive purge)', () => {
    const clock = { t: 1_000 };
    const store = storeAt(clock);
    store.write('a', payload('a'));
    store.write('b', payload('b'));
    store.drop('a');
    expect(store.read('a')).toBeNull();
    expect(store.read('b')).not.toBeNull();
  });

  it('dropping an absent chat is a no-op (purge runs on every removal path)', () => {
    const clock = { t: 1_000 };
    const store = storeAt(clock);
    store.write('a', payload('a'));
    expect(() => store.drop('never-seen')).not.toThrow();
    expect(store.size()).toBe(1);
  });

  it('keeps the queued-message partition, paging cursor and supervisor flag intact (a hit must paint the whole view, not just rows)', () => {
    const clock = { t: 1_000 };
    const store = storeAt(clock);
    store.write('chat-a', {
      messages: [{ id: 'm1' }, { id: 'pending-row-1' }],
      paging: { hasMore: true, cursor: 'cursor-1' },
      pendingIds: ['pending-row-1'],
      supervisorChat: true,
    });
    const snap = store.read('chat-a')!;
    expect(snap.pendingIds).toEqual(['pending-row-1']);
    expect(snap.paging).toEqual({ hasMore: true, cursor: 'cursor-1' });
    expect(snap.supervisorChat).toBe(true);
  });
});
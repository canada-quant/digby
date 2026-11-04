/**
 * Guest send-while-running queue (d0777a67) — the pure leaf's tests. The
 * reported bug: "queued messages doesn't seem to work when not logged in" —
 * a guest's mid-run send was dropped by the C3 chatless guard while the
 * composer's footer promise said "your message queues and sends next".
 *
 * These tests pin the LEAF's decisions (stage / hold / drain / merge); the
 * view wiring is pinned in guest-send-queue.wiring.test.tsx.
 */

import { describe, expect, it } from 'vitest';
import {
  GUEST_QUEUE_CAPTION,
  GUEST_QUEUE_ID_PREFIX,
  guestDrainAction,
  isGuestQueueId,
  makeGuestQueued,
  mergeGuestQueued,
  stageChatlessBehindLive,
} from './guest-send-queue';

describe('makeGuestQueued / isGuestQueueId', () => {
  it('mints gq-* ids that never collide with server / provision / send echo ids', () => {
    const q = makeGuestQueued({ message: 'follow-up question' });
    expect(q.id.startsWith(GUEST_QUEUE_ID_PREFIX)).toBe(true);
    expect(isGuestQueueId(q.id)).toBe(true);
    // Distinct prefixes from the other echo families.
    expect(isGuestQueueId('pq-123')).toBe(false);
    expect(isGuestQueueId('tmp-123')).toBe(false);
    expect(isGuestQueueId('pending-123')).toBe(false);
    expect(isGuestQueueId(null)).toBe(false);
    expect(isGuestQueueId(undefined)).toBe(false);
  });

  it('every mint is unique and stamps its creation time', () => {
    const a = makeGuestQueued({ message: 'one', now: 1_000 });
    const b = makeGuestQueued({ message: 'two', now: 1_000 });
    expect(a.id).not.toBe(b.id);
    expect(a.createdAt).toBe(new Date(1_000).toISOString());
    expect(a.message).toBe('one');
  });
});

describe('stageChatlessBehindLive — a chatless mid-run send', () => {
  it('a GUEST stages into the client queue (the reported bug: never dropped)', () => {
    expect(stageChatlessBehindLive({ liveRunning: true, guest: true })).toBe(true);
  });

  it('the signed-in createChat-failure FALLBACK keeps the C3 hold (no client queue)', () => {
    expect(stageChatlessBehindLive({ liveRunning: true, guest: false })).toBe(false);
  });

  it('no live run never stages (the normal send path runs)', () => {
    expect(stageChatlessBehindLive({ liveRunning: false, guest: true })).toBe(false);
    expect(stageChatlessBehindLive({ liveRunning: false, guest: false })).toBe(false);
  });
});

describe('guestDrainAction — when does the queue go out', () => {
  it('nothing queued, or a run still live: wait', () => {
    expect(guestDrainAction({ queued: 0, liveRunning: false })).toBe('wait');
    expect(guestDrainAction({ queued: 0, liveRunning: true })).toBe('wait');
    expect(guestDrainAction({ queued: 2, liveRunning: true })).toBe('wait');
  });

  it('queued + the run ended: ONE send fires', () => {
    expect(guestDrainAction({ queued: 1, liveRunning: false })).toBe('send');
    expect(guestDrainAction({ queued: 3, liveRunning: false })).toBe('send');
  });
});

describe('mergeGuestQueued — oldest first, blank-line joined', () => {
  it('joins queued messages in queue order', () => {
    const items = [
      makeGuestQueued({ message: 'first held question', now: 1 }),
      makeGuestQueued({ message: 'second held question', now: 2 }),
    ];
    expect(mergeGuestQueued(items).message).toBe('first held question\n\nsecond held question');
  });

  it('blank / whitespace-only entries drop out; an empty queue merges empty', () => {
    expect(mergeGuestQueued([makeGuestQueued({ message: '   ' })]).message).toBe('');
    expect(mergeGuestQueued([])).toEqual({ message: '', uploads: [] });
    expect(mergeGuestQueued([makeGuestQueued({ message: ' a ' }), makeGuestQueued({ message: '' })]).message).toBe('a');
  });
});

describe('625773b5 — held uploads ride the queue (guests have an attachment bar now)', () => {
  const upload = { uploadId: 'up-1', filename: 'board.png', type: 'image', localPreview: 'blob:x' };

  it('makeGuestQueued keeps the staged chips and defaults to none', () => {
    expect(makeGuestQueued({ message: 'm' }).uploads).toEqual([]);
    expect(makeGuestQueued({ message: 'm', uploads: [upload] }).uploads).toEqual([upload]);
  });

  it('merge flattens every held upload in queue order', () => {
    const merged = mergeGuestQueued([
      makeGuestQueued({ message: 'one', uploads: [upload], now: 1 }),
      makeGuestQueued({ message: 'two', uploads: [{ uploadId: 'up-2', filename: 'log.txt' }], now: 2 }),
    ]);
    expect(merged.uploads.map(u => u.uploadId)).toEqual(['up-1', 'up-2']);
    expect(merged.message).toBe('one\n\ntwo');
  });

  it('an attachment-only hold survives the merge (no text, chips intact)', () => {
    const merged = mergeGuestQueued([makeGuestQueued({ message: '', uploads: [upload] })]);
    expect(merged.message).toBe('');
    expect(merged.uploads).toEqual([upload]);
  });
});

describe('caption', () => {
  it('promises exactly what the queue does — never "Stop ends it" for a guest hold', () => {
    expect(GUEST_QUEUE_CAPTION).toBe('Queued — sends when this answer finishes');
    expect(GUEST_QUEUE_CAPTION).not.toContain('Stop');
  });
});

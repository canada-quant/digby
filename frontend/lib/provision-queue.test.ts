import { describe, it, expect } from 'vitest';
import {
  drainAction, isProvisionQueueId, loadProvisionQueue, makeQueued, mergeIntoInitial, mergeQueued,
  saveProvisionQueue, PROVISION_QUEUE_IMAGE_BUDGET, PROVISION_QUEUE_TTL_MS,
} from './provision-queue';

function memStore(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, v); },
  };
}

describe('provision queue (owner 2026-10-14: queue a send while the session provisions)', () => {
  it('queued ids are pq-* and never look like server ids', () => {
    const q = makeQueued({ message: 'hi', now: 1 });
    expect(isProvisionQueueId(q.id)).toBe(true);
    expect(isProvisionQueueId('8f1c2e7a-0000-4000-8000-000000000000')).toBe(false);
    expect(isProvisionQueueId('steer-1')).toBe(false);
  });

  it('mergeQueued joins text oldest-first and keeps every image + upload', () => {
    const a = makeQueued({ message: ' first ', images: [{ mediaType: 'image/png', data: 'A' }], uploads: [{ uploadId: 'u1' }] });
    const b = makeQueued({ message: '', uploads: [{ uploadId: 'u2' }] });
    const c = makeQueued({ message: 'third' });
    const m = mergeQueued([a, b, c]);
    expect(m.message).toBe('first\n\nthird');
    expect(m.images).toHaveLength(1);
    expect(m.uploads.map((u) => u.uploadId)).toEqual(['u1', 'u2']);
  });

  it('mergeIntoInitial puts the session-creating message first', () => {
    expect(mergeIntoInitial('build it', [makeQueued({ message: 'and add tests' })])).toBe('build it\n\nand add tests');
    expect(mergeIntoInitial('build it', [])).toBe('build it');
    expect(mergeIntoInitial('', [makeQueued({ message: 'only this' })])).toBe('only this');
  });

  it('drainAction sends only when ready, idle, and the auto-start message is not still pending', () => {
    const ready = { queued: 1, sessionStatus: 'ready', liveRunning: false, initialPending: false };
    expect(drainAction(ready)).toBe('send');
    expect(drainAction({ ...ready, queued: 0 })).toBe('wait');
    expect(drainAction({ ...ready, sessionStatus: 'provisioning' })).toBe('wait');
    expect(drainAction({ ...ready, liveRunning: true })).toBe('wait');
    expect(drainAction({ ...ready, initialPending: true })).toBe('wait');
  });

  it('persists per session, survives a reload, and clears on an empty save', () => {
    const store = memStore();
    const q = makeQueued({ message: 'keep me', uploads: [{ uploadId: 'u1', filename: 'a.pdf' }] });
    saveProvisionQueue('s1', [q], store);
    expect(loadProvisionQueue('s1', store)).toEqual([q]);
    expect(loadProvisionQueue('s2', store)).toEqual([]);
    saveProvisionQueue('s1', [], store);
    expect(loadProvisionQueue('s1', store)).toEqual([]);
  });

  it('drops images from the stash when it would be too large, never the text', () => {
    const store = memStore();
    const big = 'x'.repeat(PROVISION_QUEUE_IMAGE_BUDGET + 10);
    saveProvisionQueue('s1', [makeQueued({ message: 'with pic', images: [{ mediaType: 'image/png', data: big }] })], store);
    const back = loadProvisionQueue('s1', store);
    expect(back[0].message).toBe('with pic');
    expect(back[0].images).toEqual([]);
  });

  it('a stale or malformed stash reads as empty', () => {
    const store = memStore();
    saveProvisionQueue('s1', [makeQueued({ message: 'old' })], store);
    expect(loadProvisionQueue('s1', store, Date.now() + PROVISION_QUEUE_TTL_MS + 1)).toEqual([]);
    store.setItem('digby.provisionQueue.s2', '{not json');
    expect(loadProvisionQueue('s2', store)).toEqual([]);
    store.setItem('digby.provisionQueue.s3', JSON.stringify({ at: Date.now(), items: [{ id: 'evil', message: 1 }] }));
    expect(loadProvisionQueue('s3', store)).toEqual([]);
  });

  it('a missing / throwing storage never throws', () => {
    expect(() => saveProvisionQueue('s1', [makeQueued({ message: 'x' })], null)).not.toThrow();
    expect(loadProvisionQueue('s1', null)).toEqual([]);
    const throwing = { ...memStore(), getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } } as Storage;
    expect(() => saveProvisionQueue('s1', [makeQueued({ message: 'x' })], throwing)).not.toThrow();
    expect(loadProvisionQueue('s1', throwing)).toEqual([]);
  });
});

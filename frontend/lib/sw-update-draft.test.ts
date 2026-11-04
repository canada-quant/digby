/**
 * SW-update draft stash/restore tests (UI overhaul P5): the sessionStorage
 * handshake that keeps an in-progress composer draft across the service
 * worker's forced reload (UpdateNotification → ChatComposerTextarea).
 */

import { describe, it, expect } from 'vitest';
import { stashDraft, takeStashedDraft, DRAFT_RESTORE_WINDOW_MS } from './sw-update-draft';

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    size: () => map.size,
  };
}

describe('sw-update draft stash/restore', () => {
  it('round-trips a draft for the same path', () => {
    const s = makeStorage();
    stashDraft('/crossmodel', 'hello — mid-thought draft', s, 1000);
    expect(takeStashedDraft('/crossmodel', s, 2000)).toBe('hello — mid-thought draft');
  });

  it('is one-shot: a second take returns null', () => {
    const s = makeStorage();
    stashDraft('/crossmodel', 'once', s, 1000);
    expect(takeStashedDraft('/crossmodel', s, 1001)).toBe('once');
    expect(takeStashedDraft('/crossmodel', s, 1002)).toBeNull();
    expect(s.size()).toBe(0);
  });

  it('is keyed by path — a management-tab draft never restores into the chat composer', () => {
    const s = makeStorage();
    stashDraft('/crossmodel/management', 'supervisor note', s, 1000);
    expect(takeStashedDraft('/crossmodel', s, 1001)).toBeNull();
    expect(takeStashedDraft('/crossmodel/management', s, 1001)).toBe('supervisor note');
  });

  it('never stashes an empty or whitespace-only draft', () => {
    const s = makeStorage();
    stashDraft('/crossmodel', '', s, 1000);
    stashDraft('/crossmodel', '   \n', s, 1000);
    expect(s.size()).toBe(0);
    expect(takeStashedDraft('/crossmodel', s, 1001)).toBeNull();
  });

  it('rejects a stale stash (reload never happened) — and still removes it', () => {
    const s = makeStorage();
    stashDraft('/crossmodel', 'orphaned', s, 1000);
    expect(takeStashedDraft('/crossmodel', s, 1000 + DRAFT_RESTORE_WINDOW_MS + 1)).toBeNull();
    expect(s.size()).toBe(0);
  });

  it('restores exactly at the freshness boundary', () => {
    const s = makeStorage();
    stashDraft('/crossmodel', 'boundary', s, 1000);
    expect(takeStashedDraft('/crossmodel', s, 1000 + DRAFT_RESTORE_WINDOW_MS)).toBe('boundary');
  });

  it('survives garbage in storage (malformed JSON, wrong shapes)', () => {
    const s = makeStorage();
    s.setItem('digby.composer.swdraft:/crossmodel', 'not json {');
    expect(takeStashedDraft('/crossmodel', s, 1000)).toBeNull();
    s.setItem('digby.composer.swdraft:/crossmodel', JSON.stringify({ text: 42, ts: 1 }));
    expect(takeStashedDraft('/crossmodel', s, 1000)).toBeNull();
    s.setItem('digby.composer.swdraft:/crossmodel', JSON.stringify({ ts: 1 }));
    expect(takeStashedDraft('/crossmodel', s, 1000)).toBeNull();
  });

  it('a throwing storage (private mode) is swallowed, not thrown', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => stashDraft('/crossmodel', 'x', throwing, 1000)).not.toThrow();
    expect(takeStashedDraft('/crossmodel', throwing, 1000)).toBeNull();
  });
});

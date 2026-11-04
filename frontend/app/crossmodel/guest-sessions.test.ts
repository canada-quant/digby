/**
 * guest-sessions store pins (feedback ticket 63bb607f) — the browser-local,
 * non-durable history backing the anonymous guest sidebar.
 *
 * Vitest runs in the NODE environment (no jsdom — see vitest.config.ts), so
 * `window` is undefined by default: the SSR-safe branch is exercised by
 * simply NOT installing the stub, and the storage branch by installing a
 * minimal in-memory window.localStorage pair.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CodingMessage } from '@/lib/api/coding';
import {
  loadGuestSessions,
  getGuestSession,
  upsertGuestSession,
  removeGuestSession,
  guestSessionTitle,
  retitleGuestSession,
  MAX_SESSIONS,
  MAX_MESSAGES,
  MAX_SESSION_BYTES,
  type GuestSessionRecord,
} from './guest-sessions';

// ── In-memory localStorage stub ────────────────────────────────────────────
let backing: Record<string, string>;
let quotaBomb: boolean; // when true, setItem throws QuotaExceededError

function installWindow() {
  backing = {};
  quotaBomb = false;
  (globalThis as any).window = {
    localStorage: {
      getItem: (k: string) => (k in backing ? backing[k] : null),
      setItem: (k: string, v: string) => {
        if (quotaBomb) {
          const err = new Error('quota') as any;
          err.name = 'QuotaExceededError';
          throw err;
        }
        backing[k] = String(v);
      },
      removeItem: (k: string) => { delete backing[k]; },
    },
  };
}

function uninstallWindow() {
  delete (globalThis as any).window;
}

const msg = (id: string, over: Partial<CodingMessage> = {}): CodingMessage => ({
  id,
  role: 'user',
  content: `content-${id}`,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

const rec = (id: string, over: Partial<GuestSessionRecord> = {}): GuestSessionRecord => ({
  id,
  title: `t-${id}`,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: `2026-09-01T00:00:${id.padStart(2, '0')}.000Z`,
  messages: [msg('m1')],
  ...over,
});

beforeEach(installWindow);
afterEach(uninstallWindow);

describe('SSR safety (no window)', () => {
  it('reads return empty and writes no-op when window is undefined', () => {
    uninstallWindow();
    expect(loadGuestSessions()).toEqual([]);
    expect(getGuestSession('x')).toBeUndefined();
    expect(() => upsertGuestSession(rec('a'))).not.toThrow();
    expect(() => removeGuestSession('a')).not.toThrow();
    expect(loadGuestSessions()).toEqual([]);
  });
});

describe('round-trip', () => {
  it('upsert → load returns the record, sorted newest-updated first', () => {
    upsertGuestSession(rec('01'));
    upsertGuestSession(rec('02')); // updatedAt :02 > :01
    const list = loadGuestSessions();
    expect(list.map(s => s.id)).toEqual(['02', '01']);
    expect(getGuestSession('01')?.title).toBe('t-01');
    expect(getGuestSession('nope')).toBeUndefined();
  });

  it('upsert with the same id replaces in place and re-sorts to the front', () => {
    upsertGuestSession(rec('01'));
    upsertGuestSession(rec('02'));
    upsertGuestSession(rec('01', { updatedAt: '2026-09-01T00:00:30.000Z', title: 'renamed' }));
    const list = loadGuestSessions();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: '01', title: 'renamed' });
  });

  it('removeGuestSession deletes only the target', () => {
    upsertGuestSession(rec('01'));
    upsertGuestSession(rec('02'));
    removeGuestSession('01');
    expect(loadGuestSessions().map(s => s.id)).toEqual(['02']);
  });

  it('a corrupted store blob loads as empty instead of throwing', () => {
    backing['digbyGuestSessions.v1'] = '{not json';
    expect(loadGuestSessions()).toEqual([]);
    backing['digbyGuestSessions.v1'] = JSON.stringify({ version: 2, sessions: 'nope' });
    expect(loadGuestSessions()).toEqual([]);
  });
});

describe('caps', () => {
  it(`the ${MAX_SESSIONS + 1}th session evicts the LRU tail`, () => {
    for (let i = 1; i <= MAX_SESSIONS; i++) {
      upsertGuestSession(rec(String(i).padStart(2, '0')));
    }
    expect(loadGuestSessions()).toHaveLength(MAX_SESSIONS);
    // A fresh record is newest → the OLDEST (id 01) evicts.
    upsertGuestSession(rec('99', { updatedAt: '2026-09-01T01:00:00.000Z' }));
    const list = loadGuestSessions();
    expect(list).toHaveLength(MAX_SESSIONS);
    expect(list[0].id).toBe('99');
    expect(list.some(s => s.id === '01')).toBe(false);
    expect(list.some(s => s.id === '02')).toBe(true);
  });

  it(`trims a session to the last ${MAX_MESSAGES} messages`, () => {
    const messages = Array.from({ length: MAX_MESSAGES + 5 }, (_, i) => msg(`m${i}`));
    upsertGuestSession(rec('01', { messages }));
    const stored = getGuestSession('01')!;
    expect(stored.messages).toHaveLength(MAX_MESSAGES);
    expect(stored.messages[0].id).toBe('m5'); // the oldest 5 dropped
    expect(stored.messages[MAX_MESSAGES - 1].id).toBe(`m${MAX_MESSAGES + 4}`);
  });

  it('strips plainMeta.models/modelLabels on write but keeps the rest of plainMeta', () => {
    upsertGuestSession(rec('01', {
      messages: [msg('m1', {
        role: 'assistant',
        plainMeta: {
          mode: 'thinking',
          followUps: ['next?'],
          models: { 'kimi-k3': { response: 'huge blob' } },
          modelLabels: { 'kimi-k3': 'Kimi K3' },
        },
      })],
    }));
    const meta = getGuestSession('01')!.messages[0].plainMeta!;
    expect(meta.models).toBeUndefined();
    expect(meta.modelLabels).toBeUndefined();
    expect(meta.mode).toBe('thinking');
    expect(meta.followUps).toEqual(['next?']);
  });

  it('drops message parts when the serialized session exceeds the byte cap', () => {
    const big = 'x'.repeat(MAX_SESSION_BYTES); // one oversized text part
    upsertGuestSession(rec('01', {
      messages: [msg('m1', {
        role: 'assistant',
        parts: [{ type: 'text', text: big } as any],
      })],
    }));
    const stored = getGuestSession('01')!;
    expect(stored.messages[0].parts).toBeUndefined();
    expect(stored.messages[0].content).toBe('content-m1'); // content survives
  });
});

describe('quota safety', () => {
  it('on QuotaExceededError evicts half the list and retries once — chat never breaks', () => {
    for (let i = 1; i <= 4; i++) upsertGuestSession(rec(String(i).padStart(2, '0')));
    quotaBomb = true;
    expect(() => upsertGuestSession(rec('99', { updatedAt: '2026-09-01T01:00:00.000Z' }))).not.toThrow();
    // The retry writes the new record + at most half of MAX_SESSIONS of the old
    // list — but the stub still bombs, so the store is whatever the last
    // SUCCESSFUL write left: persistence skipped, nothing corrupted.
    expect(loadGuestSessions()).toHaveLength(4);
    // And with quota available again, a fresh upsert works (no poisoned state).
    quotaBomb = false;
    upsertGuestSession(rec('99', { updatedAt: '2026-09-01T01:00:00.000Z' }));
    expect(getGuestSession('99')).toBeDefined();
  });

  it('non-quota write failures silently no-op', () => {
    (globalThis as any).window.localStorage.setItem = () => { throw new Error('SecurityError'); };
    expect(() => upsertGuestSession(rec('01'))).not.toThrow();
    expect(loadGuestSessions()).toEqual([]);
  });
});

describe('guestSessionTitle', () => {
  it('keeps short text as-is', () => {
    expect(guestSessionTitle('Hello there')).toBe('Hello there');
  });

  it('truncates beyond 60 chars with an ellipsis', () => {
    const long = 'a'.repeat(61);
    expect(guestSessionTitle(long)).toBe(`${'a'.repeat(60)}…`);
  });

  it('collapses whitespace runs (single-line rail rows)', () => {
    expect(guestSessionTitle('hello\n\n  world\t!')).toBe('hello world !');
  });

  it('falls back for empty input', () => {
    expect(guestSessionTitle('')).toBe('New conversation');
    expect(guestSessionTitle('   ')).toBe('New conversation');
  });
});

describe('retitleGuestSession — the server title replaces the placeholder (2026-09-26)', () => {
  // "guest mode, chat title generation didn't work": the rail only ever held
  // the first-message placeholder. The 'chat-title' frame / the autoTitle echo
  // on complete now retitle the browser-local record — but only while it still
  // holds the placeholder, so a title already applied (or the earlier frame's)
  // is never clobbered.
  const QUESTION = 'What is the tallest mountain in Canada and how tall is it?';

  it('replaces a first-message placeholder title and reports the change', () => {
    upsertGuestSession(rec('g1', { title: guestSessionTitle(QUESTION), messages: [msg('m1', { content: QUESTION })] }));
    expect(retitleGuestSession('g1', 'Canada’s Highest Peak')).toBe(true);
    expect(getGuestSession('g1')?.title).toBe('Canada’s Highest Peak');
    // The sidebar's non-null autoTitle contract: the rail row now reads the server title.
    expect(loadGuestSessions().find(s => s.id === 'g1')?.title).toBe('Canada’s Highest Peak');
  });

  it('a second title (the autoTitle echo after the chat-title frame) is a no-op on a real title', () => {
    upsertGuestSession(rec('g2', { title: guestSessionTitle(QUESTION), messages: [msg('m1', { content: QUESTION })] }));
    expect(retitleGuestSession('g2', 'Canada’s Highest Peak')).toBe(true);
    expect(retitleGuestSession('g2', 'Some Later Title')).toBe(false);
    expect(getGuestSession('g2')?.title).toBe('Canada’s Highest Peak');
  });

  it('the truncated "…" placeholder shape is replaced too', () => {
    const long = 'x'.repeat(80);
    upsertGuestSession(rec('g3', { title: guestSessionTitle(long), messages: [msg('m1', { content: long })] }));
    expect(getGuestSession('g3')?.title.endsWith('…')).toBe(true);
    expect(retitleGuestSession('g3', 'A Real Title')).toBe(true);
    expect(getGuestSession('g3')?.title).toBe('A Real Title');
  });

  it('a missing record, an empty title, and an identical title are no-ops', () => {
    expect(retitleGuestSession('nope', 'Title')).toBe(false);
    upsertGuestSession(rec('g4', { title: guestSessionTitle(QUESTION), messages: [msg('m1', { content: QUESTION })] }));
    expect(retitleGuestSession('g4', '   ')).toBe(false);
    expect(retitleGuestSession('g4', guestSessionTitle(QUESTION))).toBe(false);
    expect(getGuestSession('g4')?.title).toBe(guestSessionTitle(QUESTION));
  });

  it('keeps the record otherwise intact (messages, timestamps)', () => {
    const before = rec('g5', { title: guestSessionTitle(QUESTION), messages: [msg('m1', { content: QUESTION }), msg('m2', { role: 'assistant', content: 'Mount Logan.' })] });
    upsertGuestSession(before);
    retitleGuestSession('g5', 'Canada’s Highest Peak');
    const after = getGuestSession('g5')!;
    expect(after.messages).toEqual(before.messages);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('SSR-safe: no window ⇒ false, never throws', () => {
    uninstallWindow();
    expect(retitleGuestSession('g1', 'Title')).toBe(false);
    installWindow();
  });
});

/**
 * Chat-list events (ticket 6201e0ee) — the sidebar's push subscription.
 *
 * Node-environment vitest (the codebase convention for lib modules): the
 * hook's EventSource wiring is pinned at the SOURCE level (the C3
 * retirement-pin idiom — stable identifiers, never line numbers) plus pure
 * tests for the URL builder, the kill switch, and the page's onNotice gate.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { chatEventsUrl } from './chat-events';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const HOOK = readSrc('./chat-events.ts');
const PAGE = readSrc('../app/crossmodel/page.tsx');

describe('chat-events pure helpers', () => {
  it('chatEventsUrl puts the token in the query string (EventSource cannot set headers)', () => {
    expect(chatEventsUrl('http://localhost:4000/api', 'tok-1')).toBe(
      'http://localhost:4000/api/crossmodel/chats/events?token=tok-1',
    );
  });

  it('chatEventsUrl omits the query entirely for an empty token', () => {
    expect(chatEventsUrl('http://localhost:4000/api', '')).toBe(
      'http://localhost:4000/api/crossmodel/chats/events',
    );
  });
});

describe('chat-events hook wiring [chat-events.ts]', () => {
  it('subscribes via EventSource to /crossmodel/chats/events with ?token=', () => {
    expect(HOOK).toContain("new EventSource(chatEventsUrl(apiBase, liveToken))");
  });

  it('the lib module (NOT page.tsx) holds the EventSource — the C3 pin stays true', () => {
    expect(HOOK).toContain('new EventSource(');
    expect(PAGE).not.toContain('new EventSource(');
  });

  it("handles the 'chat-list-changed' frame and the terminal 'complete' frame", () => {
    expect(HOOK).toContain("parsed.type === 'chat-list-changed'");
    expect(HOOK).toContain("parsed.type === 'complete'");
    expect(HOOK).toContain('es?.close()');
  });

  it('re-subscribes when the live token changes (review N2: localStorage rotates every ~15m)', () => {
    expect(HOOK).toContain('}, [enabled, liveToken]);');
    // The focus listener that re-reads the token the api client refreshed.
    expect(HOOK).toContain("window.addEventListener('focus', onFocus)");
  });
});

describe('page wiring [page.tsx] — a notice kicks the existing delta poll', () => {
  it('mounts useChatListEvents right after the delta poll it kicks', () => {
    expect(PAGE).toContain('useChatListEvents({');
  });

  it('the delta fetch ASKS for archived rows — review B1: without includeArchived the push-kicked fetch still cannot see another lane\'s archive', () => {
    // THE B1 pin: the param must ride the only listChatChanges call site.
    const call = PAGE.slice(PAGE.indexOf('listChatChanges({'), PAGE.indexOf('listChatChanges({') + 260);
    expect(call).toContain('includeArchived: true');
  });

  it('the notice handler calls refreshChatChanges (the existing delta fetch)', () => {
    const region = PAGE.slice(
      PAGE.indexOf('useChatListEvents({'),
      PAGE.indexOf('// The running sessions reconcile'),
    );
    expect(region).toContain('refreshChatChanges();');
    // Gated exactly like the poll itself: no watermark → no kick (the full
    // fetch is in flight and carries the row anyway).
    expect(region).toContain('chatsSinceRef.current');
  });

  it('subscription is signed-in + non-kid gated, same as the delta poll', () => {
    const region = PAGE.slice(
      PAGE.indexOf('useChatListEvents({'),
      PAGE.indexOf('// The running sessions reconcile'),
    );
    expect(region).toContain('enabled: !!user && !isKid');
    expect(region).toContain('token: accessToken');
  });

  it('the SSE token state is read on mount and cleared on a definitive auth failure', () => {
    expect(PAGE).toContain("const [accessToken, setAccessToken] = useState<string | null>(null);");
    expect(PAGE).toContain("try { setAccessToken(localStorage.getItem('accessToken')); } catch");
    expect(PAGE).toContain('setAccessToken(null);');
  });
});

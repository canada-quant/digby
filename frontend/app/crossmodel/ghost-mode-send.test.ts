/**
 * Ghost mode (2026-10-22) — the GUEST send-param wiring.
 *
 * buildPlainStreamUrl is the ONE builder behind every chatId-less guest send
 * (the view's live send + the auto-start hand-off both call it). These pins
 * mirror label-window-mode-source.test.ts: ghost=true must ride EVERY URL
 * shape the builder can produce — the short-message GET query, the
 * >1500-char register body, the token URL the register returns, and the
 * register-FAILURE fallback — and must be ABSENT when ghost is off, so a
 * non-ghost conversation never accidentally routes through the admin's
 * endpoint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

vi.mock('@/lib/api-client', () => ({ ensureFreshAuthCookie: vi.fn(async () => {}) }));

import { buildPlainStreamUrl } from './plain-session';

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ streamToken: '11111111-1111-4111-8111-111111111111' }) }));
  (globalThis as any).fetch = fetchMock;
});
afterEach(() => { (globalThis as any).fetch = originalFetch; });

const query = (url: string) => new URL(url).searchParams;

describe('buildPlainStreamUrl — ghost rides every send shape', () => {
  it('short message: ghost=true on the GET query, absent when off/undefined', async () => {
    const on = await buildPlainStreamUrl({ message: 'hi', mode: 'thinking', webSearch: false, ghost: true });
    expect(query(on).get('ghost')).toBe('true');
    const off = await buildPlainStreamUrl({ message: 'hi', mode: 'thinking', webSearch: false, ghost: false });
    expect(query(off).has('ghost')).toBe(false);
    const unset = await buildPlainStreamUrl({ message: 'hi', mode: 'thinking', webSearch: false });
    expect(query(unset).has('ghost')).toBe(false);
  });

  it('short message composes with the guest session id (both ride the same query)', async () => {
    const url = await buildPlainStreamUrl({ message: 'hi', mode: 'thinking', webSearch: false, sessionId: '22222222-2222-4222-8222-222222222222', ghost: true });
    expect(query(url).get('ghost')).toBe('true');
    expect(query(url).get('sessionId')).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('long message: the register body carries ghost, and so does the returned token URL', async () => {
    const long = 'x'.repeat(1600);
    const url = await buildPlainStreamUrl({ message: long, mode: 'thinking', webSearch: false, ghost: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.ghost).toBe('true');
    // belt-and-braces: the token URL carries it too (the consume path re-reads it)
    expect(query(url).get('ghost')).toBe('true');
  });

  it('long message, ghost off: neither the register body nor the token URL carries it', async () => {
    const long = 'x'.repeat(1600);
    const url = await buildPlainStreamUrl({ message: long, mode: 'thinking', webSearch: false });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.ghost).toBeUndefined();
    expect(query(url).has('ghost')).toBe(false);
  });

  it('register FAILURE: the direct fallback query still carries ghost (a ghost turn never silently de-ghosts)', async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    (globalThis as any).fetch = fetchMock;
    const long = 'x'.repeat(1600);
    const url = await buildPlainStreamUrl({ message: long, mode: 'thinking', webSearch: false, ghost: true });
    expect(query(url).get('ghost')).toBe('true');
    expect(query(url).get('message')).toBe(long.substring(0, 1500)); // the truncating fallback shape
  });
});

describe('the guest send path threads plain.ghost (source pins)', () => {
  // The view's ONE plain send site must forward ghost — a `ghost` prop that
  // never reached buildPlainStreamUrl would leave ghost mode as a no-op UI
  // toggle. Source-pin idiom (label-window-mode-source.test.ts): the exact
  // call shape is asserted so a rename/regression fails loudly.
  const src = readFileSync(fileURLToPath(new URL('./components/CodeSessionView.tsx', import.meta.url)), 'utf8');

  it('the live plain send passes ghost: plainCfg.ghost', () => {
    expect(src).toContain('ghost: plainCfg.ghost');
  });

  it('the composer toggle renders whenever the page wires a ghost toggle (guest, or signed-in own plain chat)', () => {
    expect(src).toContain("{plain?.onToggleGhost && (");
  });
});

describe('the signed-in composer ghost toggle (owner ask 2026-10-22: "where is the ghost model icon for users to test in the ui?")', () => {
  // Signed-in users on their OWN plain chats get the same composer Ghost icon
  // guests have — before this change the icon was guest-gated and signed-in
  // users had to find the side-panel Settings switch. Source pins on the page
  // wiring (the exact call shapes, so a regression fails loudly).
  const pageSrc = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');

  // integ/ghost-composer (2026-10-22): #1897's three page pins were written
  // against its own wiring (signedInGhostChatId → toggleChatGhost, an inline
  // updateChat, a ghostToggles mirror). The merged toggle routes the SAME
  // behaviour through lib/ghost-composer.ts (ghostTarget / flipChatGhost, both
  // unit-tested in lib/ghost-composer.test.ts), so the pins below assert the
  // merged call shapes — what each pin PROVES is unchanged.
  it('the page passes the signed-in toggle for the user\'s own plain chats only (guests keep theirs)', () => {
    // superseded pin: `… : (signedInGhostChatId ? toggleChatGhost : undefined)` —
    // the signed-in arm now reads ghostTarget (the same eligibility rule + a KNOWN posture).
    expect(pageSrc).toMatch(/onToggleGhost: chatlessActive\?\.guest && activeGuestId\s*\? toggleGuestGhost\s*: ghostTarget\?\.kind === 'chat'\s*\? \(\) => void toggleChatGhost\(ghostTarget\.chatId, ghostTarget\.on\)\s*: undefined,/);
  });

  it('the signed-in toggle writes the chat row (PUT /chats/:id ghostMode) — the row governs the send server-side', () => {
    // superseded pin: `await crossModelApi.updateChat(chatId, { ghostMode: next })` —
    // the write is lib/ghost-composer.ts flipChatGhost (updateChat(id, { ghostMode: !current }), unit-tested).
    // (integ/ghost-composer review fix: a 4th arg captures the PUT's answer for the pending-flip hold —
    // the write itself is unchanged, so the pin reads the call up to it.)
    expect(pageSrc).toContain('const next = await flipChatGhost(crossModelApi.updateChat, chatId, current, (row) => { saved = row; });');
  });

  it('the composer button and the side-panel Settings switch share ONE eligibility rule', () => {
    expect(pageSrc).toContain('ghostChatId={signedInGhostChatId}');
    // …and that rule is ONE pure function, which the composer target reads too.
    expect(pageSrc).toContain('const signedInGhostChatId = ghostEligibleChatId(ghostInput);');
    expect(pageSrc).toContain('const ghostTarget = ghostToggleTarget(ghostInput);');
  });
});

/**
 * fetchPlainRunActive 'gone' tri-state — owner report 2026-10-27 ("when you
 * delete a chat or a session it doesn't go away but still sits in the chat if
 * you have it open"): the liveness probe is the plain chat's ONLY 404-capable
 * signal (GET /crossmodel/agent/active returns 404 "Chat not found", no
 * existence leak, when the chat row is gone). It used to collapse every
 * non-OK response to null = "unknown", making a DELETED chat
 * indistinguishable from a transient outage — so the reconnect loop kept
 * retrying a dead chat forever ("Reconnecting…" forever).
 *
 * Behavioral test (node env, fetch stubbed): 404 ⇒ 'gone' (terminal), 500 ⇒
 * null (unknown, retries continue), 200 ⇒ boolean. Same style as the
 * chat-flavor helper tests — pure-function seams, no jsdom.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PLAIN_SESSION_SRC = readSrc('./plain-session.ts');

// The module under test reads localStorage + process.env at call time and
// fetches via global fetch — import it AFTER the stubs exist (dynamic import,
// node environment, window undefined ⇒ the localStorage branch returns null
// and the token guard short-circuits… which would make every case null).
// Instead: evaluate the module's own function against a stubbed fetch by
// importing with a localStorage present. Simplest faithful harness: define
// the pieces the function needs on globalThis and import the real module.
describe('fetchPlainRunActive — deleted-chat 404 surfaces as terminal gone (owner 2026-10-27)', () => {
  const originalFetch = globalThis.fetch;
  let status = 500;
  let body: unknown = { data: { active: false } };

  beforeEach(() => {
    (globalThis as any).localStorage = { getItem: () => 'token', setItem: () => {} };
    (globalThis as any).window = { localStorage: { getItem: () => 'token' } };
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as any).localStorage;
    delete (globalThis as any).window;
  });

  it('a 404 from the liveness probe resolves to "gone" — terminal, not unknown', async () => {
    status = 404; body = { error: 'Chat not found' };
    const { fetchPlainRunActive } = await import('./plain-session');
    expect(await fetchPlainRunActive('chat-1')).toBe('gone');
  });

  it('a 5xx stays null (unknown) so transient outages keep the retry loop alive', async () => {
    status = 503; body = {};
    const { fetchPlainRunActive } = await import('./plain-session');
    expect(await fetchPlainRunActive('chat-1')).toBeNull();
  });

  it('a 200 still resolves the boolean liveness answer', async () => {
    status = 200; body = { data: { active: true } };
    const { fetchPlainRunActive } = await import('./plain-session');
    expect(await fetchPlainRunActive('chat-1')).toBe(true);
  });

  it('source pin: the 404 branch is explicit and documented (guards a silent re-collapse)', () => {
    expect(PLAIN_SESSION_SRC).toContain("Promise<boolean | 'gone' | null>");
    expect(PLAIN_SESSION_SRC).toContain('if (r.status === 404) return \'gone\';');
  });

  it('source pin: existing call sites stayed compatible (=== true / === false checks unchanged in shape)', () => {
    // The union widened; every pre-existing consumer treats 'gone' as neither
    // true nor false, so they are unaffected until they opt in. The consumers
    // live in CodeSessionView.tsx (the reconnect/resync probes), not here.
    const viewSrc = readSrc('./components/CodeSessionView.tsx');
    const consumers = viewSrc.match(/active === (?:true|false)/g) ?? [];
    expect(consumers.length).toBeGreaterThan(0);
    // And the two opt-in sites act on 'gone' terminally.
    expect(viewSrc.match(/if \(active === 'gone'\) \{/g)?.length ?? 0).toBe(2);
  });
});

/**
 * Ticket b0edd255 pin — management (+ account) shell rides the app-shell
 * height idiom, never the banner-vulnerable in-flow h-dvh root.
 *
 * THE BUG (user report: "management tab doesnt display full height osmsetimes
 * i think due to top ads floating banner up top … only in the management
 * tab"): the management route's root was an IN-FLOW `h-dvh` div. Any
 * top-of-<body> in-flow insertion (a GPT anchor ad that persists across SPA
 * navigation from the chat route, or a browser-injected banner) pushed the
 * whole route down by the banner's height while it kept height:100dvh — and
 * with `html, body { overflow: hidden }` (globals.css) there is no page
 * scroll to compensate, so the bottom banner-height strip was clipped
 * unreachable. The chat/instances shells are `fixed inset-0` +
 * var(--app-height)/var(--app-top), which anchor to the VIEWPORT and ignore
 * in-flow insertions — hence "only in the management tab". The account route
 * shared the exact vulnerable shape.
 *
 * THE FIX: both roots adopt the chat-shell idiom (page.tsx):
 * `fixed inset-0 flex flex-col bg-background overflow-hidden` +
 * `style={{ height: 'var(--app-height, 100dvh)', top: 'var(--app-top, 0px)' }}`.
 * AppViewportVars (mounted by the /crossmodel layout for EVERY route under
 * it — P1.4 pins that) keeps the vars live against the visual viewport.
 *
 * SOURCE-LEVEL pins in the phase0-ui-pins / p1-shell-pins idiom: anchor on
 * stable identifiers, never line numbers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const MGMT = read('./page.tsx');
const ACCT = read('../account/page.tsx');
const LAYOUT_CM = read('../layout.tsx');

const SHELL_CLASS = 'fixed inset-0 flex flex-col bg-background overflow-hidden';
const HEIGHT_VAR = "height: 'var(--app-height, 100dvh)'";
const TOP_VAR = "top: 'var(--app-top, 0px)'";
const VULNERABLE_SHELL = 'h-dvh bg-background flex flex-col overflow-hidden';

describe('ticket b0edd255 — management/account shells are viewport-pinned (banner-proof)', () => {
  it('management root is fixed inset-0 + app-viewport vars, not the in-flow h-dvh shell', () => {
    expect(MGMT).toContain(`className="${SHELL_CLASS}"`);
    expect(MGMT).toContain(HEIGHT_VAR);
    expect(MGMT).toContain(TOP_VAR);
    expect(MGMT).not.toContain(VULNERABLE_SHELL);
  });

  it('account root (same reported shape) is fixed inset-0 + app-viewport vars, not the in-flow h-dvh shell', () => {
    expect(ACCT).toContain(`className="${SHELL_CLASS}"`);
    expect(ACCT).toContain(HEIGHT_VAR);
    expect(ACCT).toContain(TOP_VAR);
    expect(ACCT).not.toContain(VULNERABLE_SHELL);
  });

  it('the /crossmodel layout still mounts AppViewportVars for every route under it (the vars these shells consume)', () => {
    expect(LAYOUT_CM).toContain('AppViewportVars');
  });
});

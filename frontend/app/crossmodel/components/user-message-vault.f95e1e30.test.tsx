/**
 * One-tap "Vault this" — feedback ticket f95e1e30, part 2.
 *
 * Two things are pinned here, both required for the affordance to be honest:
 *
 *  1. THE COMPONENT'S OWN RAILS (SSR, node-env vitest — same idiom as
 *     plain-message-actions.test.tsx): a flagged paste offers ONE button whose
 *     label counts the values; an already-vaulted row renders a "stored as $X"
 *     note INSTEAD of a button; a disabled row (member view / guest) offers
 *     nothing clickable.
 *
 *  2. THE MOUNT GATE (source pin, same idiom as
 *     user-message-copy.57542e64.test.tsx): the transcript renders the button
 *     ONLY when the server stamped `credentialPaste` AND the row has a REAL
 *     persisted message id (CROSSMODEL_MSG_ID_RE) AND the viewer owns the chat.
 *     A live/guest echo has no row — the route would 404 — so it gets no button.
 *
 * The component NEVER sniffs for credentials itself: `flag` is the server's
 * decision, and the source pin below asserts the gate reads the flag rather than
 * matching key shapes in the browser.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UserMessageVaultButton } from './code-transcript';

const render = (over: Partial<Parameters<typeof UserMessageVaultButton>[0]> = {}) =>
  renderToStaticMarkup(createElement(UserMessageVaultButton, {
    chatId: 'chat-1',
    messageId: '11111111-1111-4111-8111-111111111111',
    flag: { count: 2, patterns: ['Credential assignment'] },
    ...over,
  }));

describe('UserMessageVaultButton — the affordance', () => {
  it('offers ONE vault action on a flagged paste, labelled by the server count', () => {
    const html = render();
    expect(html).toContain('Vault');
    // The plural label counts the values the server found — the owner is told
    // how much this one click will store.
    expect(html).toContain('Vault these 2 credentials');
    expect(html).toContain('aria-label="Vault these 2 credentials"');
  });

  it('a single value reads in the singular', () => {
    const html = render({ flag: { count: 1, patterns: ['HuggingFace token'] } });
    expect(html).toContain('Vault this credential');
  });

  it('an already-vaulted row renders "stored as $X" and NO button (no double-store by accident)', () => {
    const html = render({ flag: { count: 2, patterns: ['Credential assignment'], vaulted: ['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN'] } });
    expect(html).toContain('stored as $BREV_ACCESS_TOKEN, $BREV_REFRESH_TOKEN');
    // No clickable control at all — the store cannot be re-offered. (The
    // sr-only label still names the action for screen readers; only the
    // BUTTON must be gone.)
    expect(html).not.toContain('<button');
    expect(html).toContain('aria-hidden="true"');
  });

  it('a partly-vaulted row names what was NOT stored AND keeps a live RETRY (finding #4)', () => {
    const html = render({
      flag: {
        count: 2,
        patterns: ['Credential assignment'],
        vaulted: ['BREV_ACCESS_TOKEN'],
        notStored: ['BREV_REFRESH_TOKEN'],
      },
    });
    // What landed is still named…
    expect(html).toContain('Retry vault');
    expect(html).toContain('BREV_REFRESH_TOKEN');
    // …and the owner can finish the job without an agent: a live control, not a
    // dead note. Pre-fix this row rendered a static "stored as $X" span whose
    // only remaining path to the failed value was store_secret.
    expect(html).toContain('<button');
    // A live control — `disabled` appears only inside the Tailwind
    // `disabled:opacity-50` class, never as an attribute.
    expect(html).not.toMatch(/<button[^>]*\sdisabled(?:=|\s|>)/);
    // The retry names the pending key for a screen reader too.
    expect(html).toContain('aria-label="Retry vaulting: BREV_REFRESH_TOKEN not stored"');
  });

  it('the button is disabled where the route would refuse (member view / guest)', () => {
    const html = render({ disabled: true });
    expect(html).toContain('disabled');
  });

  it('the control never carries a value — the label is built from the count alone', () => {
    const html = render();
    // No credential-shaped text can appear: the component has no access to the
    // row's content, only the server's count/pattern names.
    expect(html).not.toMatch(/eyJ[A-Za-z0-9]/);
    expect(html).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });
});

// ── The mount gate (source pins) ──────────────────────────────────────────

const VIEW = readFileSync(resolve(__dirname, './CodeSessionView.tsx'), 'utf8');

/** The mount site plus the GATE that guards it — a window from the ticket tag
 *  back to the opening brace of its JSX comment block, wide enough to contain
 *  the whole `{cond && (` condition. */
function mountWindow(): string {
  const at = VIEW.indexOf('<UserMessageVaultButton');
  const start = VIEW.lastIndexOf('One-tap "Vault this"', at);
  return VIEW.slice(start >= 0 ? start : at - 600, at + 400);
}

describe('the transcript mounts the vault button behind BOTH rails', () => {
  it('renders on the server flag AND a real persisted row id', () => {
    // The mount must reference all four: the flag, the id-shape test, the chat
    // id, and the owner-only viewer gate. Losing any one of them ships a button
    // that 404s (no row) or is offered to a member the route refuses.
    const block = mountWindow();
    expect(block).toContain('UserMessageVaultButton');
    expect(block).toContain('m.plainMeta.credentialPaste');
    expect(block).toContain('CROSSMODEL_MSG_ID_RE.test(m.id)');
    expect(block).toContain('memberViewOnly');
    expect(block).toContain('!!chatId');
  });

  it('the gate is the SERVER flag — the browser never sniffs the content itself', () => {
    // The condition must not test the message text for key shapes: detection
    // lives in exactly one place (backend platform/credential-paste.ts).
    expect(mountWindow()).not.toMatch(/m\.content\??\.(match|test|includes)\(/);
  });

  it('a live/guest echo (no uuid row id) never gets a button', () => {
    // CROSSMODEL_MSG_ID_RE is the uuid shape the route validates; a tmp-/steer-
    // echo id fails it, so the gate already excludes those rows.
    expect(VIEW).toContain("const CROSSMODEL_MSG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;");
    expect(mountWindow()).toContain('CROSSMODEL_MSG_ID_RE.test(m.id) && !!chatId && !memberViewOnly');
  });
});
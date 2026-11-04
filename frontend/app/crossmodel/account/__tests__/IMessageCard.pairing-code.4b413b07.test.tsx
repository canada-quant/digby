/**
 * Ticket 4b413b07 — "new macbookpro no code>?" (owner report, NEW MacBook Pro
 * cqlstannembp1 paired 2026-10-22T06:55Z, filed 20:54Z the same day).
 *
 * What happened: the new Mac's agent showed its native prompt — "Enter your
 * Digby pairing code. Get it from digby.example.com → Account → Integrations → iMessage
 * → Connect your Mac." — but inside the DESKTOP app that dialog rendered NO
 * code anywhere: the desktop branch was one-click-only by design (the code
 * rides in env DIGBY_PAIR_CODE and is never displayed), and the dialog's own
 * "Prefer to install manually? Download the agent" link leads to a flow that
 * REQUIRES the code. A user stuck on the manual path — as the owner was, with
 * the DMG's bundled 0.6.3 agent — was sent to a dialog that never showed the
 * thing being asked for. ("no code>" — the arrows are the prompt's own
 * "digby.example.com → Account → Integrations" breadcrumb.)
 *
 * The fix: the pairing code renders in EVERY macOS consumption branch of the
 * dialog — the desktop one-click branch (new), the browser .pkg branch (as
 * before, now via the shared component), and the Terminal one-liner branch
 * (the code is embedded in the command). Windows is unchanged: its agent
 * pairs via env vars and never asks for a code.
 *
 * Node-environment vitest constraints (no jsdom, no effects — the
 * IMessageCard.agent-update.31fd8440.test.tsx idiom):
 *   1. SSR render of the PURE PairingCodeBox for its display contract;
 *   2. SOURCE-LEVEL pins on IMessageCard.tsx for the effectful wiring
 *      (the desktop branch renders the box; the .pkg branch reuses it;
 *      the Windows branch never does).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { PairingCodeBox } from '../IMessageCard';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const CARD = readSrc('../IMessageCard.tsx');

const renderBox = (over: Partial<Parameters<typeof PairingCodeBox>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(PairingCodeBox, {
      pairingCode: 'AB2C-D4EF',
      onCopy: () => {},
      ...over,
    }),
  );

describe('PairingCodeBox — display contract (SSR)', () => {
  it('renders the code verbatim, large mono, with a copy affordance', () => {
    const html = renderBox();
    expect(html).toContain('data-testid="pairing-code-box"');
    expect(html).toContain('AB2C-D4EF');
    // The copy affordance (aria label drives the accessible name).
    expect(html).toContain('Copy the pairing code');
  });

  it('renders any code shape without mangling it (the alphabet excludes 0/O/1/I)', () => {
    expect(renderBox({ pairingCode: 'ZZ9Z-ZZ9Z' })).toContain('ZZ9Z-ZZ9Z');
  });
});

describe('IMessageCard — the code is visible in every macOS branch (source pins)', () => {
  it('the DESKTOP one-click branch renders the PairingCodeBox (the 4b413b07 gap)', () => {
    // The desktop branch's helper copy + the box inside the same branch.
    expect(CARD).toContain('Asked for a pairing code on this Mac?');
    // The box is wired from the SAME pairingCode state the one-click button uses.
    // (405927c9 interim, 2026-10-25: the .pkg flow's gate gained a freshness
    // condition — the slice markers below name the CURRENT gate strings.)
    const desktopBranch = CARD.slice(
      CARD.indexOf('{isDesktop && ('),
      CARD.indexOf('{!isDesktop && !isWindowsBrowser && pkgFresh && ('),
    );
    expect(desktopBranch).toContain('<PairingCodeBox');
    expect(desktopBranch).toContain('pairingCode={pairingCode}');
  });

  it('the desktop branch renders the box only for macOS — Windows never asks for a code', () => {
    const desktopBranch = CARD.slice(
      CARD.indexOf('{isDesktop && ('),
      CARD.indexOf('{!isDesktop && !isWindowsBrowser && pkgFresh && ('),
    );
    expect(desktopBranch).toContain('{!isWindows && (');
    // …and no unconditional box: exactly one PairingCodeBox occurrence inside
    // the desktop branch, gated by !isWindows.
    expect(desktopBranch.match(/<PairingCodeBox/g)?.length).toBe(1);
  });

  it('the browser .pkg branch reuses the SAME component (no duplicate code-box markup)', () => {
    const pkgBranch = CARD.slice(
      CARD.indexOf('{!isDesktop && !isWindowsBrowser && pkgFresh && ('),
      CARD.indexOf('{!isDesktop && !isWindowsBrowser && !pkgFresh && ('),
    );
    expect(pkgBranch).toContain('<PairingCodeBox');
    // The old inline code box (span font-mono tracking-widest) is gone from
    // the file — replaced by the shared component.
    expect(CARD).not.toContain('tracking-widest">{pairingCode}');
  });

  it('the Terminal one-liner branch still carries the code inside the command', () => {
    const termBranch = CARD.slice(CARD.indexOf('{!isDesktop && !isWindowsBrowser && !pkgFresh && ('));
    expect(termBranch).toContain('{installCmd}');
  });
});

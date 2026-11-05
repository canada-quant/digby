/**
 * Ticket 0afda0af (owner-filed, 2026-11-02) — "cant connect to my mac minmin
 * anymore and says to run a command that acutally never apopears".
 *
 * TWO HALVES, both pinned here.
 *
 * 1. "says to run a command" — the native shell. When the one-click setup path
 *    finds a self-managed agent already on the Mac, macos-app/Sources/Digby/
 *    main.swift raises an NSAlert telling the user to use the one-line command
 *    shown on the iMessage card (the "already installed" branch additionally
 *    said "run its update command from the iMessage card").
 *
 * 2. "actually never appears" — THIS card. Every command branch of the pairing
 *    dialog was gated `!isDesktop` (the .pkg branch and the Terminal one-liner
 *    branch both). Inside the desktop app — the ONLY place those alerts can
 *    fire, because the shell injects __digbyDesktop.canSetupIMessage — the
 *    dialog therefore rendered a one-click button and a pairing code and NO
 *    command whatsoever. The UI structurally could not show the remedy the
 *    native alert named, so a Mac that came back offline had no reachable way
 *    to be re-paired: the user was sent, twice, to a command that never
 *    rendered.
 *
 * The fix renders the SAME one-liner (it embeds the live pairing code) inside
 * the desktop branch via DesktopCommandFallback, below the one-click button,
 * and corrects both native alerts to describe the path that now exists.
 *
 * Node-environment vitest constraints (the 4b413b07 / 405927c9 idiom):
 *   1. SSR render of the PURE DesktopCommandFallback for its display contract;
 *   2. SOURCE-LEVEL pins on IMessageCard.tsx and main.swift for the wiring that
 *      only exists under a real WKWebView (no jsdom, no effects).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { DesktopCommandFallback } from '../IMessageCard';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const CARD = readSrc('../IMessageCard.tsx');
/** repo-relative from frontend/app/crossmodel/account/__tests__ → repo root. */
const MAIN_SWIFT = readSrc('../../../../../macos-app/Sources/Digby/main.swift');

const INSTALL_CMD =
  'curl -fsSL https://digby.ai/install-digby-agent.sh | bash -s -- AB2C-D4EF';

const renderFallback = (over: Partial<Parameters<typeof DesktopCommandFallback>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(DesktopCommandFallback, {
      installCmd: INSTALL_CMD,
      onCopy: () => {},
      ...over,
    }),
  );

describe('DesktopCommandFallback — display contract (SSR)', () => {
  it('renders the exact command verbatim, including the live pairing code', () => {
    const html = renderFallback();
    expect(html).toContain('data-testid="desktop-command-fallback"');
    expect(html).toContain('data-testid="desktop-command-text"');
    // The whole line, un-mangled — this is what gets pasted into Terminal.
    expect(html).toContain(INSTALL_CMD);
    expect(html).toContain('AB2C-D4EF');
  });

  it('offers a copy affordance for the command', () => {
    expect(renderFallback()).toContain('Copy the install command');
  });

  it('names the different-account case AND the file to clear, because the installer keeps an existing pairing', () => {
    // install.sh: `if [[ ! -f "$HOME/.config/digby-agent/config.json" ]]` →
    // a paired Mac is reinstalled but NOT re-paired (`▶ Already paired`). An
    // agent paired to another Digby account therefore stays offline after the
    // command alone; the card must say so and name the exact file.
    const html = renderFallback();
    expect(html).toContain('different');
    expect(html).toContain('rm ~/.config/digby-agent/config.json');
  });

  it('renders any command shape without mangling it (self-host origin + API arg)', () => {
    const selfHost =
      'curl -fsSL https://digby.example.com/install-digby-agent.sh | ' +
      'DIGBY_INSTALL_HOST=https://digby.example.com bash -s -- ZZ9Z-ZZ9Z https://digby.example.com/api';
    expect(renderFallback({ installCmd: selfHost })).toContain(selfHost);
  });
});

describe('IMessageCard — the desktop branch renders the command (0afda0af source pins)', () => {
  /** The desktop one-click branch, up to the first browser-only branch. */
  const desktopBranch = CARD.slice(
    CARD.indexOf('{isDesktop && ('),
    CARD.indexOf('{!isDesktop && !isWindowsBrowser && pkgFresh && ('),
  );

  it('the desktop branch mounts DesktopCommandFallback with the real installCmd', () => {
    expect(desktopBranch).toContain('<DesktopCommandFallback');
    expect(desktopBranch).toContain('installCmd={installCmd}');
  });

  it('REPLAY of the defect: the command is not gated out in the desktop branch', () => {
    // The bug: `installCmd` rendered only inside `{!isDesktop && …}` branches,
    // so in the desktop shell the string was unreachable. Assert the desktop
    // branch carries it directly — not merely that the file defines it.
    expect(desktopBranch).toContain('installCmd={installCmd}');
    // …and only once (no duplicated block across branches).
    expect(desktopBranch.match(/<DesktopCommandFallback/g)?.length).toBe(1);
  });

  it('the fallback is macOS-only — the Windows shell pairs via env vars and never shows a code', () => {
    // LOAD-BEARING, and pinned at the MOUNT (review finding MAJOR 1, 2026-11-02):
    // windows-shell/Bridge.cs:22 injects `canSetupIMessage: true`, so `isDesktop`
    // is TRUE on Windows too and an unguarded mount WOULD leak a bash one-liner
    // onto a PC. The earlier version of this assertion matched any
    // `{!isWindows && (` in the branch — and the branch holds a SECOND, older one
    // (the pairing-code box), so removing this guard still passed 12/12. Assert
    // the guard ADJACENT to the mount instead; nothing weaker detects it.
    const mount = desktopBranch.slice(desktopBranch.indexOf('{/* 0afda0af'));
    expect(mount.length).toBeGreaterThan(0);
    expect(mount).toMatch(/\{!isWindows && \(\s*<DesktopCommandFallback/);
  });

  it('the browser branches still own their own command rendering (no regression)', () => {
    expect(CARD).toContain('{!isDesktop && !isWindowsBrowser && !pkgFresh && (');
    expect(CARD).toContain('{installCmd}');
  });
});

describe('macOS shell alerts — they describe a path the card can actually render', () => {
  it('no alert points the user at a card "in your browser" (the desktop user never sees it)', () => {
    // The exact phrase that made the promise false for a desktop user: it
    // framed the remedy as living somewhere other than where they were.
    expect(MAIN_SWIFT).not.toContain('iMessage card in your browser');
  });

  it('no alert promises an "update command" — the update one-liner cannot re-pair a differently-paired Mac', () => {
    // `--update-only` explicitly exits when config.json is absent, and when it
    // exists install.sh prints "Already paired" and skips pairing. Sending a
    // user whose agent is paired to ANOTHER account to the update command is
    // advice that cannot change anything.
    expect(MAIN_SWIFT).not.toContain('run its update command');
  });

  it('the already-installed alert names Connect your Mac and the command it shows', () => {
    expect(MAIN_SWIFT).toContain('open Connect your Mac and paste the one-line command it shows');
  });

  it('the not-paired alert names the same in-app path', () => {
    expect(MAIN_SWIFT).toContain('Account → Integrations → Connect your Mac');
  });
});
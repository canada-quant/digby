/**
 * Ticket 405927c9 interim (Fleet directive 2026-10-25, owner "make it
 * professional" burst): the served DigbyAgent.pkg is the June 2026 build
 * (commit 0c43a016e) — the nameless "Install ''" window the owner hit — while
 * the branded/title-fixed pkg script landed 2026-10-18 (#1752/#1757) and its
 * rebuild is owner-gated on the mac mini (oq_6e5df2b1). Until that rebuild is
 * published, the iMessage card must NOT feature the stale pkg as the primary
 * install path: the one-line installer (which always pulls the CURRENT
 * release tarball) becomes the primary flow, and the pkg returns only when a
 * FRESHNESS STAMP says the served pkg bundles the current agent release.
 *
 * Mechanism (mirrors the DMG's 31fd8440 desktop-latest.json stamp):
 *   1. build-pkg.sh stages frontend/public/DigbyAgent.pkg.json next to the
 *      pkg at publish time ({version, url, agentVersion}).
 *   2. sw.js never intercepts the stamp (same bypass as desktop-latest.json).
 *   3. IMessageCard fetches the stamp once; pkgStampIsFresh(stamp, latest)
 *      gates the pkg CTA. No stamp (the June build) → not fresh.
 *
 * Idioms per the repo's node-environment vitest constraints (no jsdom, no
 * effects — see IMessageCard.agent-update.31fd8440.test.tsx): imported pure
 * helpers for the truth table, raw source reads for the effectful wiring.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { pkgStampIsFresh } from '../IMessageCard';
import { detectPlatform } from '@/app/(site)/_components/PlatformCta';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const CARD = readSrc('../IMessageCard.tsx');
const SW = readSrc('../../../../public/sw.js');
const PKG_BUILD = readSrc('../../../../../macos-pkg/build-pkg.sh');

describe('pkgStampIsFresh — the freshness truth table (FAIL CLOSED)', () => {
  it('no stamp (the pre-stamp June build) → NOT fresh: the pkg is de-featured', () => {
    expect(pkgStampIsFresh(null, '0.9.10')).toBe(false);
    expect(pkgStampIsFresh(undefined, '0.9.10')).toBe(false);
    expect(pkgStampIsFresh(null, undefined)).toBe(false);
  });
  it('a malformed/partial stamp → NOT fresh (a hand-edited stub must not re-feature the stale build)', () => {
    // Reviewer MAJOR 2: featuring a download fails CLOSED — the 31fd8440
    // "unreadable → never outdated" rule governs badging the user's OWN device,
    // not whether to offer an artifact.
    expect(pkgStampIsFresh({} as never, '0.9.10')).toBe(false);
    expect(pkgStampIsFresh([] as never, '0.9.10')).toBe(false);
    expect(pkgStampIsFresh({ agentVersion: null }, '0.9.10')).toBe(false);
    expect(pkgStampIsFresh({ agentVersion: '' }, '0.9.10')).toBe(false);
    expect(pkgStampIsFresh({ agentVersion: 'unknown' }, '0.9.10')).toBe(false);
  });
  it('a NON-STRING agentVersion (hand-edited stamp, unquoted number) → NOT fresh, and never throws', () => {
    // Reviewer MINOR 2: JSON.parse yields live values — agentVersionOlder would
    // TypeError on a number, unmounting the whole card in the render body.
    expect(() => pkgStampIsFresh({ agentVersion: 0.9 } as never, '0.9.10')).not.toThrow();
    expect(pkgStampIsFresh({ agentVersion: 0.9 } as never, '0.9.10')).toBe(false);
    expect(pkgStampIsFresh({ agentVersion: 910 } as never, '0.9.10')).toBe(false);
    expect(pkgStampIsFresh({ agentVersion: '0.9.10' }, 0.9 as never)).toBe(false);
    expect(pkgStampIsFresh({ agentVersion: '0.9.10' }, 910 as never)).toBe(false);
  });
  it('latest release version not loaded / unreadable → NOT fresh (reviewer MINOR 5: no fail-open window)', () => {
    expect(pkgStampIsFresh({ agentVersion: '0.9.10' }, undefined)).toBe(false);
    expect(pkgStampIsFresh({ agentVersion: '0.9.10' }, null)).toBe(false);
    expect(pkgStampIsFresh({ agentVersion: '0.9.10' }, 'unknown')).toBe(false);
  });
  it('a stamp matching the current release → fresh', () => {
    expect(pkgStampIsFresh({ agentVersion: '0.9.10' }, '0.9.10')).toBe(true);
  });
  it('a stamp NEWER than the manifest → fresh (never de-feature a newer build)', () => {
    expect(pkgStampIsFresh({ agentVersion: '0.9.11' }, '0.9.10')).toBe(true);
  });
  it('a stamp OLDER than the current release → NOT fresh (a stale rebuild stays hidden)', () => {
    expect(pkgStampIsFresh({ agentVersion: '0.9.9' }, '0.9.10')).toBe(false);
    expect(pkgStampIsFresh({ agentVersion: '0.6.3' }, '0.9.10')).toBe(false);
  });
});

describe('IMessageCard wiring — the pkg CTA is freshness-gated', () => {
  it('fetches the publish-time stamp NEXT TO the pkg (PKG_URL may be off-origin), bypassing caches', () => {
    expect(CARD).toContain('fetch(`${PKG_URL}.json`, { cache: \'no-store\' })');
  });
  it('the zero-Terminal .pkg flow renders ONLY for browser-macOS while the stamp is fresh', () => {
    expect(CARD).toContain('{!isDesktop && !isWindowsBrowser && pkgFresh && (');
  });
  it('the one-line installer is the browser-macOS default whenever the pkg is not fresh', () => {
    expect(CARD).toContain('{!isDesktop && !isWindowsBrowser && !pkgFresh && (');
  });
  it('a published-but-stale pkg gets the mid-refresh note and NO download link', () => {
    expect(CARD).toContain('The click-through installer is being refreshed');
    // Exactly one pkg download href in the whole card: the fresh flow's.
    const hrefs = CARD.match(/href=\{PKG_URL\}/g) ?? [];
    expect(hrefs).toHaveLength(1);
  });
  it('Windows browser users get the ONE-installer app pointer, not macOS flows', () => {
    // Reviewer re-round MAJOR 1 (2026-10-25): the gate is on isWindowsBrowser,
    // which is derived from the UA (reachable in EVERY browser) — the old
    // isWindows flag is shell-only (Bridge.cs injects it with
    // canSetupIMessage), so a gate on it was dead code and a plain Windows
    // browser fell through to the macOS bash one-liner.
    expect(CARD).toContain('{!isDesktop && isWindowsBrowser && (');
    expect(CARD).toContain('/Digby-Setup.exe');
    expect(CARD).toContain(
      'setIsWindowsBrowser(detectPlatform(navigator.userAgent, navigator.maxTouchPoints)',
    );
  });
});

describe('detectPlatform — the Windows-browser discriminator is UA-derived (behavioral)', () => {
  it('a Windows browser UA → windows (the branch the shell-only flag could never reach)', () => {
    expect(
      detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'),
    ).toBe('windows');
  });
  it('a macOS browser UA → mac (pkg / one-liner flows as before)', () => {
    expect(
      detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15'),
    ).toBe('mac');
  });
  it('an iPad posing as a Mac → null (touch check, mirrors PlatformCta)', () => {
    expect(
      detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5),
    ).toBe(null);
  });
  it('a phone UA → null (neither desktop flow)', () => {
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15')).toBe(null);
  });
});

describe('build-pkg.sh — publishes the stamp with the pkg', () => {
  it('stages the pkg AND its freshness stamp into frontend/public', () => {
    expect(PKG_BUILD).toContain('cp "$OUT" "$ROOT/frontend/public/DigbyAgent.pkg"');
    expect(PKG_BUILD).toContain('$ROOT/frontend/public/DigbyAgent.pkg.json');
  });
  it('the stamp carries the agent version the pkg bundles (pkg version IS the agent version)', () => {
    expect(PKG_BUILD).toContain('"agentVersion": "$VERSION"');
  });
  it('the publish instructions commit both files together', () => {
    expect(PKG_BUILD).toContain(
      'git add frontend/public/DigbyAgent.pkg frontend/public/DigbyAgent.pkg.json',
    );
  });
});

describe('sw.js — the stamp is never SW-cached', () => {
  it('bypasses /DigbyAgent.pkg.json like the other agent artifacts', () => {
    expect(SW).toContain("url.pathname === '/DigbyAgent.pkg.json'");
  });
});

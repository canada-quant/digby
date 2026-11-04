/**
 * Phase 0 UI pins (receipts-backed audit, 2026-09-07).
 *
 * SOURCE-LEVEL pins (the c1-convergence-smoke / dashboard-polish idiom —
 * anchor on stable identifiers, never line numbers):
 *
 * 1. Eleven unscrollable routes: globals.css sets `html, body
 *    { overflow: hidden }` app-wide, so any route whose root is
 *    min-h-screen/min-h-dvh with no inner scroll container clips everything
 *    below the fold with no way to reach it. The fix (the app/login/page.tsx
 *    precedent) makes the root `h-dvh overflow-y-auto` — the root IS the
 *    scroll container, and sticky headers stick because they live inside it.
 *
 * 2. Permissions-Policy microphone=(self): `microphone=()` hard-blocked
 *    navigator.mediaDevices.getUserMedia — the voice-composer fallback path
 *    (Firefox + the Mac app) — for first-party pages too.
 *
 * 3. typescript.ignoreBuildErrors must stay OFF: production builds are the
 *    last gate; shipping with type errors silently is never acceptable.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Every route the audit found unreachable below the fold. `stickyHeader`
 *  routes must keep the header INSIDE the scroll container to keep sticking. */
const ROUTES: { rel: string; stickyHeader: boolean }[] = [
  // Legal pages moved into the public site shell (2026-10-14): the shell's
  // layout owns the scroll root, SiteChrome's header is the sticky one.
  { rel: './(site)/layout.tsx', stickyHeader: false },
  { rel: './crossmodel/shared/chat/[token]/page.tsx', stickyHeader: true },
  { rel: './crossmodel/shared/project/[token]/page.tsx', stickyHeader: true },
  { rel: './help/help-doc.tsx', stickyHeader: true },
  { rel: './help/help-index.tsx', stickyHeader: true },
  { rel: './crossmodel/files/page.tsx', stickyHeader: true },
  { rel: './crossmodel/projects/[id]/page.tsx', stickyHeader: true },
  { rel: './crossmodel/admin/page.tsx', stickyHeader: true },
  { rel: './dashboard/page.tsx', stickyHeader: false },
  { rel: './dashboard/analytics/page.tsx', stickyHeader: false },
];

const SCROLL_ROOT = 'h-dvh overflow-y-auto';

describe('Phase 0 — routes must own their scroll (html/body scroll is disabled app-wide)', () => {
  for (const { rel, stickyHeader } of ROUTES) {
    describe(rel, () => {
      const src = read(rel);

      it('has an h-dvh + overflow-y-auto scroll container', () => {
        expect(src).toContain(SCROLL_ROOT);
      });

      it('does not regress the main root back to a scroll-less min-h-screen/min-h-dvh shell', () => {
        // Loading/error early-returns may keep min-h-screen (a centered spinner
        // never overflows); the pin is that the scroll container exists AND the
        // root class string it replaced is gone.
        expect(src).not.toContain('"min-h-screen bg-background');
        expect(src).not.toContain('"min-h-dvh bg-background');
      });

      if (stickyHeader) {
        it('keeps the sticky header INSIDE the scroll container (after it in source)', () => {
          const container = src.indexOf(SCROLL_ROOT);
          const sticky = src.indexOf('sticky top-0', container);
          expect(container).toBeGreaterThanOrEqual(0);
          expect(sticky).toBeGreaterThan(container);
        });
      }
    });
  }
});

describe('Phase 0 — public site shell keeps its sticky header inside the scroll root', () => {
  it('the layout owns the h-dvh scroll root; every page renders <SiteShell> (sticky header) inside it', () => {
    // 2026-10-16 redesign: the chrome moved from the layout into <SiteShell>
    // (rendered by each page, so it can follow the page's language). The
    // layout's div is still the ONE scroll container the header sticks in.
    const layout = read('./(site)/layout.tsx');
    expect(layout).toContain(SCROLL_ROOT);
    expect(layout).toContain('data-site-scroll');
    expect(read('./(site)/_components/SiteShell.tsx')).toContain('<SiteHeader');
    expect(read('./(site)/_components/SiteChrome.tsx')).toContain('sticky top-0');
    for (const page of ['./(site)/[slug]/page.tsx', './(site)/learn/page.tsx', './(site)/learn/[slug]/page.tsx', './(site)/privacy/page.tsx', './(site)/terms/page.tsx']) {
      expect(read(page), page).toContain('<SiteShell');
    }
  });
});

describe('Phase 0 — next.config.ts pins', () => {
  const config = read('../next.config.ts');

  it('Permissions-Policy allows first-party microphone (voice composer) and nothing more', () => {
    expect(config).toContain(
      "{ key: 'Permissions-Policy', value: 'geolocation=(), microphone=(self), camera=(), payment=()' }",
    );
    // The old hard-block shape must not come back.
    expect(config).not.toContain('microphone=()');
  });

  it('production builds are type-checked (ignoreBuildErrors stays off)', () => {
    expect(config).toContain('ignoreBuildErrors: false');
    expect(config).not.toContain('ignoreBuildErrors: true');
  });
});

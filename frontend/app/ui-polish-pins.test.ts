/**
 * UI polish / harden pins (2026-09-14) — source-level, no line numbers.
 *
 * 1. Secondary page chrome shares ScrollableTabBar + PageBackButton.
 * 2. Dialogs keep the phone gutter AND stay inside the visible viewport.
 * 3. Skip-to-content + reduced-motion live in the global shell.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(FRONTEND_ROOT, rel), 'utf8');

const TAB_SITES = [
  'app/crossmodel/account/page.tsx',
  'app/crossmodel/management/page.tsx',
  'app/crossmodel/projects/[id]/page.tsx',
  'app/crossmodel/account/AdminTab.tsx',
];

const BACK_SITES = [
  'app/crossmodel/account/page.tsx',
  'app/crossmodel/management/page.tsx',
  'app/crossmodel/projects/[id]/page.tsx',
  'app/crossmodel/files/page.tsx',
  'app/help/help-index.tsx',
  'app/help/help-doc.tsx',
  'app/login/page.tsx',
];

describe('UI polish — shared tab strip', () => {
  for (const rel of TAB_SITES) {
    it(`${rel} uses ScrollableTabBar (no local overflow-x-auto tab copy)`, () => {
      const src = read(rel);
      expect(src).toContain("from '@/components/ui/scrollable-tab-bar'");
      expect(src).toContain('<ScrollableTabBar');
    });
  }
});

describe('UI polish — shared back control + skip target', () => {
  for (const rel of BACK_SITES.filter((r) => r !== 'app/login/page.tsx')) {
    it(`${rel} uses PageBackButton`, () => {
      expect(read(rel)).toContain("from '@/components/ui/page-back-button'");
      expect(read(rel)).toContain('<PageBackButton');
    });
  }

  it('root layout exposes a skip-to-content link', () => {
    const src = read('app/layout.tsx');
    expect(src).toContain('href="#main"');
    expect(src).toContain('Skip to content');
  });

  it('globals.css owns skip-link + reduced-motion (autofill kept)', () => {
    const src = read('app/globals.css');
    expect(src).toContain('.skip-link');
    expect(src).toContain('prefers-reduced-motion: reduce');
    expect(src).toContain('input:-webkit-autofill');
    expect(src).toContain('-webkit-tap-highlight-color: transparent');
  });
});

describe('UI polish — auth + coarse-pointer follow-up (live QA 2026-09-14)', () => {
  it('login/signup right column is the scroll container (not a centered h-dvh clip)', () => {
    const src = read('app/login/page.tsx');
    expect(src).toContain('overflow-hidden');
    expect(src).toContain('flex-1 min-h-0 min-w-0 overflow-y-auto');
    expect(src).toContain('min-h-full');
    expect(src).not.toContain('placeholder="••••••••"');
    expect(src).toContain('placeholder="Password"');
    expect(src).toContain("from '@/components/ui/password-toggle'");
    expect(src).toContain('text-xs text-muted-foreground');
    expect(src).toContain('Continue without an account');
    expect(src).toContain('min-h-11');
  });

  it('PasswordToggle is named and has a 44px coarse hit area', () => {
    const src = read('components/ui/password-toggle.tsx');
    expect(src).toContain('aria-label={label}');
    expect(src).toContain('sr-only');
    expect(src).toContain('[@media(pointer:coarse)]:min-h-11');
  });

  it('PageBackButton default name is explicit and coarse-floored', () => {
    const src = read('components/ui/page-back-button.tsx');
    expect(src).toContain("label = 'Back to previous page'");
    expect(src).toContain('sr-only');
    expect(src).toContain('[@media(pointer:coarse)]:min-h-11');
  });

  it('legal pages live in the public site shell (its header + breadcrumbs lead back to the chat)', () => {
    // Moved from /crossmodel/{terms,privacy} 2026-10-14 — the back control is
    // the site header's logo / "Start chatting" + the breadcrumb trail.
    for (const rel of ['app/(site)/terms/page.tsx', 'app/(site)/privacy/page.tsx']) {
      expect(read(rel)).toContain('<Breadcrumbs trail={trail} />');
    }
    expect(read('app/(site)/_components/SiteShell.tsx')).toContain('<SiteHeader');
  });

  it('FloatingChrome pills grow to 44px on coarse pointers (overflow no longer clips hit slop)', () => {
    const src = read('app/crossmodel/components/FloatingChrome.tsx');
    expect(src).toContain('[@media(pointer:coarse)]:size-11');
    expect(src).not.toMatch(/PILL\} fixed left-3 z-\(--z-raised\) overflow-hidden/);
  });

  it('guest + authed sidebar close buttons are named and coarse-floored', () => {
    // Digby Frontier (2026-10-06): both rails share RailBrandRow's collapse
    // button — named "Close sidebar" with the coarse-pointer 44px floor.
    const guest = read('app/crossmodel/components/GuestSidebar.tsx');
    expect(guest).toContain('<RailBrandRow onCollapse={onClose} />');
    const parts = read('app/crossmodel/components/rail-parts.tsx');
    expect(parts).toContain("collapseLabel = 'Close sidebar'");
    expect(parts).toContain('aria-label={collapseLabel}');
    expect(parts).toContain('[@media(pointer:coarse)]:min-h-11');
    const page = read('app/crossmodel/page.tsx');
    expect(page).toContain('<RailBrandRow onCollapse={() => setSidebarOpen(false)} />');
    expect(page).toContain("aria-label={isTranscribing ? 'Transcribing'");
    expect(page).toContain('aria-label="Attach files"');
  });

  it('PWA install prompt sits above the composer and has a named 44px dismiss', () => {
    const src = read('src/components/PWAInstallPrompt.tsx');
    expect(src).toContain('7.25rem + env(safe-area-inset-bottom');
    expect(src).toContain('Dismiss install prompt');
    expect(src).toContain('[@media(pointer:coarse)]:min-h-11');
    expect(src).toContain('handleDismiss');
  });
});

describe('UI polish — dialogs stay on-screen on short phones', () => {
  it('DialogContent keeps the gutter and a viewport-capped max-height', () => {
    const src = read('components/ui/dialog.tsx');
    expect(src).toContain('w-[calc(100%-2rem)]');
    expect(src).toContain('max-w-[calc(100%-2rem)]');
    expect(src).toContain('max-h-[calc(100dvh-2rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))]');
  });

  it('AlertDialogContent uses the same gutter + max-height (was w-full)', () => {
    const src = read('components/ui/alert-dialog.tsx');
    expect(src).toContain('w-[calc(100%-2rem)]');
    expect(src).toContain('max-w-[calc(100%-2rem)]');
    expect(src).toContain('max-h-[calc(100dvh-2rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))]');
  });
});

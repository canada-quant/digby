/**
 * Ticket 013746f4 — "you can still zoom on pwa … also we want to change the
 * icon to open the sidebar from the digby icon to a simple list icon" (owner).
 *
 * Two lanes, pinned here:
 *  - the root `viewport` export stays zoomable (WCAG 1.4.4 — browser tabs keep
 *    pinch-zoom; P1.8 in p1-shell-pins.test.ts);
 *  - the INSTALLED app (standalone display mode) locks the viewport at scale 1
 *    at runtime (maximum-scale=1, user-scalable=no — honoured by iOS only in
 *    standalone, which is exactly the carve-out we want) and the standalone
 *    root gets `touch-action: pan-x pan-y`.
 * Node-environment vitest: the merge logic is a pure function; the DOM wiring
 * is pinned by source reads (same idiom as use-app-viewport.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { lockedViewportContent, isViewportLocked, isStandaloneDisplay, PWA_ZOOM_LOCK_DIRECTIVES } from './use-pwa-zoom-lock';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(FRONTEND_ROOT, rel), 'utf8');

// What Next renders from app/layout.tsx's viewport export today.
const NEXT_VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';

describe('lockedViewportContent (ticket 013746f4)', () => {
  it('appends the lock and keeps every other directive verbatim and in order', () => {
    expect(lockedViewportContent(NEXT_VIEWPORT)).toBe(
      'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content, maximum-scale=1, user-scalable=no',
    );
  });

  it('is idempotent — locking a locked string changes nothing', () => {
    const once = lockedViewportContent(NEXT_VIEWPORT);
    expect(lockedViewportContent(once)).toBe(once);
  });

  it('REPLACES a prior zoomable value of the lock keys (never two maximum-scale directives)', () => {
    const out = lockedViewportContent('width=device-width, maximum-scale=5, user-scalable=yes, initial-scale=1');
    expect(out).toBe('width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
    expect(out.match(/maximum-scale/g)).toHaveLength(1);
    expect(out.match(/user-scalable/g)).toHaveLength(1);
  });

  it('a missing/empty tag still yields a complete, locked viewport', () => {
    expect(lockedViewportContent('')).toBe('width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
    expect(lockedViewportContent(null)).toBe(lockedViewportContent(undefined));
  });

  it('isViewportLocked recognises the lock regardless of order/case and rejects a partial lock', () => {
    expect(isViewportLocked(lockedViewportContent(NEXT_VIEWPORT))).toBe(true);
    expect(isViewportLocked('user-scalable=NO, Maximum-Scale=1, width=device-width')).toBe(true);
    expect(isViewportLocked(NEXT_VIEWPORT)).toBe(false);
    expect(isViewportLocked('width=device-width, maximum-scale=1')).toBe(false);
    expect(PWA_ZOOM_LOCK_DIRECTIVES).toEqual(['maximum-scale=1', 'user-scalable=no']);
  });
});

describe('isStandaloneDisplay', () => {
  it('true for the display-mode media query OR the legacy iOS navigator.standalone flag', () => {
    expect(isStandaloneDisplay({ displayModeStandalone: true, navigatorStandalone: undefined })).toBe(true);
    expect(isStandaloneDisplay({ displayModeStandalone: false, navigatorStandalone: true })).toBe(true);
  });
  it('false in a browser tab (neither signal) — pinch-zoom stays there', () => {
    expect(isStandaloneDisplay({ displayModeStandalone: false, navigatorStandalone: false })).toBe(false);
    expect(isStandaloneDisplay({ displayModeStandalone: false, navigatorStandalone: undefined })).toBe(false);
  });
});

describe('ticket 013746f4 wiring pins', () => {
  it('the hook is standalone-gated and rewrites the viewport meta at runtime (browser tabs untouched)', () => {
    const src = read('lib/use-pwa-zoom-lock.ts');
    expect(src).toContain("(display-mode: standalone)");
    expect(src).toContain("if (!standalone) return;");
    expect(src).toContain('meta[name="viewport"]');
    expect(src).toContain('MutationObserver');
  });

  it('the /crossmodel layout mount runs the zoom lock beside the viewport vars', () => {
    const src = read('app/crossmodel/AppViewportVars.tsx');
    expect(src).toContain('usePwaZoomLock()');
    expect(src).toContain('useAppViewportVars()');
    expect(read('app/crossmodel/layout.tsx')).toContain('<AppViewportVars />');
  });

  it('the root viewport export stays zoomable (WCAG 1.4.4) — the lock is runtime + standalone only', () => {
    const layout = read('app/layout.tsx');
    expect(layout).toContain('initialScale: 1');
    expect(layout).not.toContain('maximumScale');
    expect(layout).not.toContain('userScalable');
  });

  it('globals.css forbids zoom gestures on the standalone root only', () => {
    const css = read('app/globals.css');
    const standalone = css.slice(css.indexOf('@media (display-mode: standalone)'));
    const block = standalone.slice(0, standalone.indexOf('@layer base'));
    expect(block).toContain('touch-action: pan-x pan-y');
    // The base layer (browser tabs) keeps the double-tap-only clamp.
    const base = css.slice(css.indexOf('@layer base'));
    expect(base).toContain('touch-action: manipulation');
    expect(base.slice(0, base.indexOf('.font-display'))).not.toContain('touch-action: pan');
  });

  it('the sidebar toggle shows a plain panel glyph, not the Digby hat image (Digby Frontier header)', () => {
    const chrome = read('app/crossmodel/components/FloatingChrome.tsx');
    const left = chrome.slice(chrome.indexOf('LEFT — sidebar closed'), chrome.indexOf('Chat title — the per-chat menu'));
    expect(left).toContain('<PanelLeft className="size-[18px]"');
    expect(left).toContain('aria-label="Open sidebar"');
    expect(left).not.toContain('digbyhat');
    expect(chrome).not.toContain("from 'next/image'");
  });
});

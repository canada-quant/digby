'use client';

/**
 * usePwaZoomLock — in the INSTALLED app (standalone display mode) the viewport
 * is locked at scale 1 (no pinch-zoom, no double-tap zoom); in a browser tab
 * nothing changes and pinch-zoom stays available (WCAG 1.4.4 — the root
 * `viewport` export in app/layout.tsx deliberately carries no maximumScale /
 * userScalable, pinned by app/p1-shell-pins.test.ts).
 *
 * Why two lanes (ticket 013746f4 "you can still zoom on pwa", owner): the
 * earlier fix (ticket d0624b13) only killed DOUBLE-TAP zoom via
 * `touch-action: manipulation` and kept pinch on purpose for accessibility in
 * the browser. The owner's ask is about the Home Screen app, where a fixed
 * chat shell that pinch-zooms is a bug, not a feature: the shell is
 * `fixed inset-0`, so a zoomed viewport leaves the composer and rails
 * off-screen with no way to scroll them back. iOS honours
 * `user-scalable=no` / `maximum-scale=1` ONLY in standalone mode (Safari
 * ignores them in a tab since iOS 10 — precisely the accessibility carve-out
 * we want to keep), Chromium PWAs honour them everywhere; so the lock is
 * applied at runtime, only when the page is running installed.
 *
 * Mechanics: rewrite the `<meta name="viewport">` content in place (WebKit and
 * Chromium re-read it live) and keep it rewritten across client navigations
 * (Next's metadata reconciler can re-render the tag) via a MutationObserver
 * on <head>. globals.css adds the belt-and-braces `touch-action: pan-x pan-y`
 * on the standalone root for engines that key pinch off touch-action.
 */

import { useEffect } from 'react';

/** The zoom-lock directives appended in standalone mode. */
export const PWA_ZOOM_LOCK_DIRECTIVES = ['maximum-scale=1', 'user-scalable=no'] as const;

/** Directives that a lock REPLACES (any prior value of these two keys). */
const LOCK_KEYS = new Set(['maximum-scale', 'user-scalable']);

/**
 * Pure: merge the zoom lock into an existing viewport `content` string. Every
 * other directive (width, initial-scale, viewport-fit, interactive-widget) is
 * preserved verbatim and in order; the two lock keys are replaced if present
 * and appended otherwise. Idempotent — locking a locked string is a no-op.
 */
export function lockedViewportContent(current: string | null | undefined): string {
  const kept = String(current ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !LOCK_KEYS.has(part.split('=')[0]!.trim().toLowerCase()));
  if (!kept.some(part => /^width=/i.test(part))) kept.unshift('width=device-width');
  if (!kept.some(part => /^initial-scale=/i.test(part))) kept.push('initial-scale=1');
  return [...kept, ...PWA_ZOOM_LOCK_DIRECTIVES].join(', ');
}

/** Pure: true when the viewport `content` already carries both lock directives. */
export function isViewportLocked(content: string | null | undefined): boolean {
  const parts = String(content ?? '').split(',').map(p => p.trim().toLowerCase());
  return PWA_ZOOM_LOCK_DIRECTIVES.every(d => parts.includes(d));
}

/**
 * Pure: the installed-app discriminator — the display-mode media query (every
 * engine) or the legacy iOS `navigator.standalone` flag.
 */
export function isStandaloneDisplay(args: { displayModeStandalone: boolean; navigatorStandalone: boolean | undefined }): boolean {
  return args.displayModeStandalone === true || args.navigatorStandalone === true;
}

/** Apply the lock to a document's viewport meta (creating the tag if the page
 *  somehow has none). Returns the content written. Idempotent. */
export function applyViewportZoomLock(doc: Document): string {
  let meta = doc.head.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) {
    meta = doc.createElement('meta');
    meta.name = 'viewport';
    doc.head.appendChild(meta);
  }
  const next = lockedViewportContent(meta.content);
  if (meta.content !== next) meta.content = next;
  return next;
}

export function usePwaZoomLock(): void {
  useEffect(() => {
    const nav = window.navigator as Navigator & { standalone?: boolean };
    const standalone = isStandaloneDisplay({
      displayModeStandalone: window.matchMedia?.('(display-mode: standalone)').matches === true,
      navigatorStandalone: nav.standalone,
    });
    if (!standalone) return; // browser tab: pinch-zoom stays (WCAG 1.4.4)
    applyViewportZoomLock(document);
    // Re-assert after any head mutation (Next re-rendering the viewport tag on
    // a client navigation would otherwise silently restore the zoomable value).
    const observer = new MutationObserver(() => {
      const meta = document.head.querySelector<HTMLMetaElement>('meta[name="viewport"]');
      if (!meta || !isViewportLocked(meta.content)) applyViewportZoomLock(document);
    });
    observer.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['content'] });
    return () => observer.disconnect();
  }, []);
}

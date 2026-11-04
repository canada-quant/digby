'use client';

/**
 * useAppViewportVars — pins --app-height / --app-top to the VISUAL viewport so
 * the fixed app shell always fills exactly what's on screen (UI overhaul
 * Phase 1: hoisted out of app/crossmodel/page.tsx, where only the main chat
 * route mounted it while instances/profile and the workspace-panel drawer read
 * the vars too).
 *
 * Fixes the iOS standalone-PWA white band under the app (layout viewport
 * computes tall/short vs. the real visible area) and keeps the shell flush
 * through keyboard show/hide, URL-bar collapse, and orientation changes — in
 * and out of PWA, every browser (visualViewport is universal since iOS 13;
 * innerHeight is the fallback).
 *
 * Mounted ONCE for the whole /crossmodel tree via <AppViewportVars /> in
 * app/crossmodel/layout.tsx. SSR-safe: everything happens in a mount effect;
 * globals.css carries the 100dvh default for pre-hydration / no-JS.
 *
 * Ticket c0e58120 (2026-09-15): a keyboard dismissed WITHOUT a viewport event
 * (the focused composer hidden by a drawer) left the shell pinned at the
 * keyboard-open height — see resolveVisibleViewport for the stale-keyboard
 * guard and the delayed re-measure schedule that catches it.
 */

import { useEffect } from 'react';

/**
 * Cap for the standalone bottom-gap compensation (ticket 45cb5171). The iOS 26
 * installed-PWA shortfall equals env(safe-area-inset-bottom) (≤ ~34px portrait,
 * ~21px landscape on home-indicator iPhones). A shortfall LARGER than this cap
 * means the software keyboard is open (the visual viewport genuinely shrank) —
 * compensating there would push the composer off-screen, so the cap doubles as
 * the keyboard discriminator.
 */
export const STANDALONE_GAP_CAP_PX = 64;

/**
 * iOS 26 WebKit installed-PWA viewport quirk (ticket 45cb5171): with
 * viewport-fit=cover in a Home Screen app, viewport units AND the viewport
 * measurements report the available height MINUS env(safe-area-inset-bottom)
 * (~34px on home-indicator iPhones) — every --app-height shell renders short
 * by exactly that inset, leaving a band under the app ("check out the bottom").
 * Compensate ONLY in the installed app on iOS:
 *  - browser mode must never compensate (visualViewport is the visible truth
 *    there — URL-bar collapse would overshoot the shell), and desktop/Android
 *    PWAs don't have the bug (their screen-vs-viewport delta is either 0 or
 *    window chrome larger than the cap, i.e. safely ignored);
 *  - older iOS standalone reports full-bleed (gap 0) → no-op, so pre-26
 *    devices keep their exact prior behaviour;
 *  - a gap beyond the cap = keyboard open → no compensation.
 * Pure + injectable so the contract is unit-testable in the node env.
 */
export function standaloneBottomCompensation(args: {
  vvHeight: number;
  screenHeight: number;
  isStandalone: boolean;
  isIOS: boolean;
  /** Owner report 2026-09-16 (iPhone 15 Pro Max, iOS 26), MEASURED by the
   *  device's own pwa_viewport rows: visualViewport = innerHeight = 873 on a
   *  932pt screen, insets 59 top / 34 bottom, screen.height 932, and
   *  --app-height already "932px" — yet the drawer, its backdrop and the
   *  composer all stopped at 873 with a white strip below. The gap was the
   *  STATUS-BAR band: iOS sized the web app's viewport to screen − 59 and
   *  anchored it at the physical top, so the bottom 59pt lies OUTSIDE the
   *  document viewport and nothing we paint reaches it — compensating only
   *  pushed the shell's bottom (the composer) under the edge. Rule: the
   *  compensation covers the BOTTOM-inset shortfall only (the 45cb5171 shape:
   *  gap ≤ insetBottom); a gap of the top-inset size is the anchoring quirk,
   *  fixed by the 'default' status-bar style (layout.tsx) and never by
   *  stretching the shell. Without inset readings the legacy 64px cap
   *  applies. */
  screenWidth?: number;
  insetTop?: number;
  insetBottom?: number;
  isIPhone?: boolean;
}): number {
  if (!args.isStandalone || !args.isIOS) return 0;
  const insetBottom = Number.isFinite(args.insetBottom) ? Math.max(0, args.insetBottom as number) : 0;
  const insetsKnown = Number.isFinite(args.insetBottom) || Number.isFinite(args.insetTop);
  // Cap = the bottom inset (+ rounding). The keyboard is ≥ 250px on every
  // iPhone, so it can never be mistaken for an inset gap either way.
  const cap = insetsKnown ? insetBottom + 8 : STANDALONE_GAP_CAP_PX;
  const gap = args.screenHeight - args.vvHeight;
  if (!Number.isFinite(gap) || gap <= 0 || gap > cap) return 0;
  return Math.round(gap);
}

/**
 * env(safe-area-inset-*) in CSS px, read through a throwaway fixed probe
 * (JS has no direct access to env()). Zero everywhere without insets.
 */
export function readSafeAreaInsets(doc: Document): { top: number; right: number; bottom: number; left: number } {
  const probe = doc.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;'
    + 'padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);'
    + 'padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px)';
  doc.body.appendChild(probe);
  const cs = doc.defaultView?.getComputedStyle(probe);
  const num = (v: string | undefined) => { const n = parseFloat(String(v ?? '0')); return Number.isFinite(n) ? n : 0; };
  const out = { top: num(cs?.paddingTop), right: num(cs?.paddingRight), bottom: num(cs?.paddingBottom), left: num(cs?.paddingLeft) };
  probe.remove();
  return out;
}

/** Session-scoped once-flag for the installed-app viewport diagnostic. */
export const PWA_VIEWPORT_REPORT_KEY = 'digby.pwaViewportReported.v3';

/** localStorage key + cadence for the "re-add the Home Screen app" hint. */
export const PWA_READD_HINT_KEY = 'digby.pwaReaddHint.v1';
export const PWA_READD_HINT_EVERY_MS = 7 * 24 * 3600_000;
export const PWA_READD_HINT_TEXT = "Digby's Home Screen app is running with an old status-bar setting, so a blank strip shows under the app. Remove the icon and add Digby to your Home Screen again to pick up the fix.";

/**
 * The stale-install signature (owner 2026-09-17 "looks like the ui fix … never
 * merged? still a huge blank space at bottom" — it HAD merged: iOS bakes
 * `apple-mobile-web-app-status-bar-style` into the Home Screen icon when it
 * is added, so a copy installed under the old black-translucent style keeps
 * its 873pt-on-a-932pt-screen web view, anchored under the status bar, with
 * the strip at the bottom that no CSS can paint). Signature: standalone iOS,
 * a top inset (translucent bar), and a web view exactly the screen minus that
 * inset. A fresh install under the 'default' style reports insetTop 0.
 */
export function staleStatusBarInstall(args: { isStandalone: boolean; isIOS: boolean; insetTop?: number; innerHeight: number; screenHeight: number }): boolean {
  if (!args.isStandalone || !args.isIOS) return false;
  const top = Number.isFinite(args.insetTop) ? (args.insetTop as number) : 0;
  if (top < 40 || !Number.isFinite(args.innerHeight) || !Number.isFinite(args.screenHeight) || args.screenHeight <= 0) return false;
  return Math.abs(args.screenHeight - args.innerHeight - top) <= 4;
}

/**
 * Pure: the diagnostic payload the installed app reports ONCE per session
 * (analytics event `pwa_viewport`) — the device's real viewport numbers, so
 * an iOS viewport regression is diagnosed from the row instead of from
 * screenshots. Exported for tests.
 */
export function buildPwaViewportDiagnostic(w: Window, insets: { top: number; bottom: number; left: number; right: number }, appHeight: string): Record<string, unknown> {
  const vv = w.visualViewport;
  // v2 (owner 2026-09-16, second report): DOM geometry — where the shell and
  // the composer actually END versus the layout viewport, and what element
  // (if any) sits at points below the layout viewport's bottom edge. A null
  // hit there means the point is outside the document's viewport: the region
  // is not ours to paint.
  const doc = w.document;
  const rect = (sel: string) => { const el = doc?.querySelector?.(sel); const r = el?.getBoundingClientRect?.(); return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) } : null; };
  const hits: Record<string, string | null> = {};
  for (const y of [860, 880, 900, 925]) {
    let tag: string | null = null;
    try { const el = doc?.elementFromPoint?.(Math.round((w.innerWidth || 0) / 2), y) as HTMLElement | null; tag = el ? `${el.tagName.toLowerCase()}${el.dataset?.appShell !== undefined ? '[shell]' : ''}${el.dataset?.composer !== undefined ? '[composer]' : ''}` : null; } catch { tag = 'err'; }
    hits[`y${y}`] = tag;
  }
  return {
    shellRect: rect('[data-app-shell]'), composerRect: rect('[data-composer]'), hits,
    htmlBg: doc?.defaultView?.getComputedStyle?.(doc.documentElement)?.backgroundColor ?? null,
    bodyBg: doc?.body ? doc.defaultView?.getComputedStyle?.(doc.body)?.backgroundColor ?? null : null,
    vvHeight: vv?.height ?? null, vvWidth: vv?.width ?? null, vvOffsetTop: vv?.offsetTop ?? null, vvScale: vv?.scale ?? null,
    innerHeight: w.innerHeight, innerWidth: w.innerWidth, outerHeight: w.outerHeight,
    screenHeight: w.screen?.height ?? null, screenWidth: w.screen?.width ?? null, availHeight: w.screen?.availHeight ?? null,
    clientHeight: w.document?.documentElement?.clientHeight ?? null, dpr: w.devicePixelRatio,
    insetTop: insets.top, insetBottom: insets.bottom, insetLeft: insets.left, insetRight: insets.right,
    appHeight,
    displayStandalone: w.matchMedia?.('(display-mode: standalone)').matches === true,
    displayFullscreen: w.matchMedia?.('(display-mode: fullscreen)').matches === true,
    navigatorStandalone: (w.navigator as Navigator & { standalone?: boolean }).standalone ?? null,
    landscape: w.matchMedia?.('(orientation: landscape)').matches === true,
    // v3 (owner 2026-09-17 "top bar still white in night mode"): the theme the
    // page is showing vs the OS preference, and every theme-color tag the
    // engine can pick from — so a status-bar colour report is read from a row.
    htmlClass: doc?.documentElement?.className ?? null,
    prefersDark: w.matchMedia?.('(prefers-color-scheme: dark)').matches === true,
    themeColorMetas: Array.from(doc?.querySelectorAll?.('meta[name="theme-color"]') ?? []).map((m) => ({
      content: (m as Element).getAttribute?.('content') ?? null,
      media: (m as Element).getAttribute?.('media') ?? null,
    })),
    ua: String(w.navigator.userAgent).slice(0, 160),
  };
}

/** Elements whose focus can summon the software keyboard. */
export function isKeyboardTarget(el: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false;
  const tag = String(el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/**
 * Stale-keyboard guard (ticket c0e58120 — "still odd white margin blocking
 * bottom view", iPhone: the shell ended at ~2/3 of the screen with a white
 * block below, right after the side panel was opened from the composer).
 *
 * iOS does NOT resize the layout viewport for the keyboard — only the VISUAL
 * viewport shrinks (and offsetTop pans). When the focused composer is removed
 * or hidden while the keyboard is up (opening a drawer, switching surface),
 * WebKit dismisses the keyboard WITHOUT a `focusout` on the gone element and,
 * observed on iOS 26, without a visualViewport `resize` — so the last pinned
 * --app-height is the KEYBOARD-OPEN height and the shell stays short.
 *
 * The visual viewport can only be shorter than the layout viewport (by more
 * than the standalone inset cap) for two reasons: the keyboard, or pinch-zoom.
 * With no keyboard-capable element focused and scale ≈ 1, neither applies —
 * the layout viewport (innerHeight) is the visible truth and the pan is 0.
 * Pure + injectable so the contract is unit-testable in the node env.
 */
export function resolveVisibleViewport(args: {
  vvHeight: number;
  vvOffsetTop: number;
  innerHeight: number;
  scale: number;
  keyboardFocused: boolean;
}): { height: number; top: number; staleKeyboard: boolean } {
  const { vvHeight, vvOffsetTop, innerHeight, scale, keyboardFocused } = args;
  const shortfall = innerHeight - vvHeight;
  const staleKeyboard =
    !keyboardFocused &&
    Number.isFinite(shortfall) &&
    shortfall > STANDALONE_GAP_CAP_PX &&
    (!Number.isFinite(scale) || scale <= 1.01);
  if (staleKeyboard) return { height: innerHeight, top: 0, staleKeyboard: true };
  return { height: vvHeight, top: vvOffsetTop, staleKeyboard: false };
}

/** Delays (ms) at which a focus change / tap / visibility change re-measures:
 *  the iOS keyboard animation runs ~250–300 ms; the last sample catches slow
 *  dismissals. Exported for the wiring pin. */
export const VIEWPORT_REMEASURE_DELAYS_MS = [60, 320, 720] as const;

export function useAppViewportVars(): void {
  useEffect(() => {
    const nav = window.navigator as Navigator & { standalone?: boolean };
    const isStandalone =
      window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true;
    // iPadOS reports as Macintosh — the touch-point count is the discriminator.
    const isIOS =
      /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
    const isIPhone = /iPhone|iPod/.test(nav.userAgent);
    // env() insets, re-read on rotation (the island moves to the side edge).
    let insets = readSafeAreaInsets(document);
    let insetsWidth = window.innerWidth;
    const setAppHeight = () => {
      if (window.innerWidth !== insetsWidth) { insets = readSafeAreaInsets(document); insetsWidth = window.innerWidth; }
      const vv = window.visualViewport;
      const resolved = resolveVisibleViewport({
        vvHeight: vv?.height ?? window.innerHeight,
        vvOffsetTop: vv?.offsetTop ?? 0,
        innerHeight: window.innerHeight,
        scale: vv?.scale ?? 1,
        keyboardFocused: isKeyboardTarget(document.activeElement as HTMLElement | null),
      });
      const h = resolved.height;
      // Guard transient 0-height reports (observed during some iOS transitions)
      // — pinning 0px would collapse the shell until the next event.
      if (h > 0) {
        const compensated =
          h +
          standaloneBottomCompensation({
            vvHeight: h,
            screenHeight: window.screen?.height ?? 0,
            screenWidth: window.screen?.width ?? 0,
            insetTop: insets.top,
            insetBottom: insets.bottom,
            isStandalone,
            isIOS,
            isIPhone,
          });
        document.documentElement.style.setProperty('--app-height', `${Math.round(compensated)}px`);
        // The part of the shell that lies BELOW the measured viewport (the
        // compensation). Surfaces that must stay reachable pad by it (owner
        // 2026-09-16: on a device where that region is not paintable, the
        // composer would otherwise sit under the edge).
        document.documentElement.style.setProperty('--app-overflow', `${Math.max(0, Math.round(compensated - h))}px`);
        // iOS pans the VISUAL viewport over the layout viewport when the
        // keyboard opens (offsetTop > 0). Without this the fixed shell stays
        // anchored to the LAYOUT top: the composer rides to the top of the
        // visible area and the region below it renders as a white void.
        document.documentElement.style.setProperty('--app-top', `${Math.round(resolved.top)}px`);
      }
    };
    // Focus changes, taps and tab switches re-measure on a short schedule —
    // the keyboard dismissal that fires NO viewport event (see
    // resolveVisibleViewport) is caught by the delayed samples. One pending
    // schedule at a time; every timer is cleared on unmount.
    let timers: ReturnType<typeof setTimeout>[] = [];
    const scheduleRemeasure = () => {
      timers.forEach(clearTimeout);
      timers = VIEWPORT_REMEASURE_DELAYS_MS.map(ms => setTimeout(setAppHeight, ms));
    };
    setAppHeight();
    // One-shot diagnostic (owner report 2026-09-16): the installed iOS app
    // records its real viewport numbers once per session so the next viewport
    // regression is read from a row, not reconstructed from screenshots.
    // Fire-and-forget after the first settled measurement; a signed-out or
    // offline app simply skips it.
    let diagTimer: ReturnType<typeof setTimeout> | undefined;
    if (isStandalone && isIOS) {
      diagTimer = setTimeout(() => {
        try {
          if (window.sessionStorage.getItem(PWA_VIEWPORT_REPORT_KEY)) return;
          window.sessionStorage.setItem(PWA_VIEWPORT_REPORT_KEY, '1');
          const props = buildPwaViewportDiagnostic(window, insets, document.documentElement.style.getPropertyValue('--app-height'));
          void import('@/lib/api-client').then(({ default: apiClient }) =>
            apiClient.post('/analytics/track', { event: 'pwa_viewport', properties: props }).catch(() => {}),
          ).catch(() => {});
        } catch { /* storage or network unavailable — diagnostic only */ }
        // Stale-install hint (owner 2026-09-17): the only fix for a Home Screen
        // copy that baked in the old status-bar style is re-adding it — say so
        // once a week, in the app, instead of leaving the strip unexplained.
        try {
          if (staleStatusBarInstall({ isStandalone, isIOS, insetTop: insets.top, innerHeight: window.innerHeight, screenHeight: window.screen?.height ?? 0 })) {
            const last = Number(window.localStorage.getItem(PWA_READD_HINT_KEY) ?? 0);
            if (!Number.isFinite(last) || Date.now() - last > PWA_READD_HINT_EVERY_MS) {
              window.localStorage.setItem(PWA_READD_HINT_KEY, String(Date.now()));
              void import('sonner').then(({ toast }) => toast.message('Re-add Digby to your Home Screen', { description: PWA_READD_HINT_TEXT, duration: 15_000 })).catch(() => {});
            }
          }
        } catch { /* storage unavailable — hint only */ }
      }, 1500);
    }
    const vv = window.visualViewport;
    vv?.addEventListener('resize', setAppHeight);
    vv?.addEventListener('scroll', setAppHeight);
    window.addEventListener('resize', setAppHeight);
    window.addEventListener('orientationchange', setAppHeight);
    document.addEventListener('focusin', scheduleRemeasure, true);
    document.addEventListener('focusout', scheduleRemeasure, true);
    document.addEventListener('pointerup', scheduleRemeasure, true);
    document.addEventListener('visibilitychange', scheduleRemeasure);
    return () => {
      timers.forEach(clearTimeout);
      if (diagTimer) clearTimeout(diagTimer);
      vv?.removeEventListener('resize', setAppHeight);
      vv?.removeEventListener('scroll', setAppHeight);
      window.removeEventListener('resize', setAppHeight);
      window.removeEventListener('orientationchange', setAppHeight);
      document.removeEventListener('focusin', scheduleRemeasure, true);
      document.removeEventListener('focusout', scheduleRemeasure, true);
      document.removeEventListener('pointerup', scheduleRemeasure, true);
      document.removeEventListener('visibilitychange', scheduleRemeasure);
      document.documentElement.style.removeProperty('--app-height');
      document.documentElement.style.removeProperty('--app-top');
      document.documentElement.style.removeProperty('--app-overflow');
    };
  }, []);
}

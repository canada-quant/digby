/**
 * Ticket 45cb5171 — "app not taking full height of mobile PWA" (iPhone, band at
 * the bottom). Root cause: the iOS 26 WebKit installed-PWA quirk — with
 * viewport-fit=cover in a Home Screen app, viewport units AND viewport
 * measurements report the available height MINUS env(safe-area-inset-bottom)
 * (~34px), so every --app-height shell rendered short by exactly the inset.
 *
 * Node-environment vitest (no jsdom): the contract lives in the exported PURE
 * compensation function; the React effect is a thin shell over it (same idiom
 * as lib/use-resizable.test.ts). Source pins keep the wiring honest: the hook
 * must stay standalone+iOS gated, the fixed chat shell must keep reading
 * var(--app-height (never the CSS overshoot), and login keeps pwa-viewport-fill.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  staleStatusBarInstall, PWA_READD_HINT_KEY,
  standaloneBottomCompensation,
  buildPwaViewportDiagnostic,
  PWA_VIEWPORT_REPORT_KEY,
  STANDALONE_GAP_CAP_PX,
  resolveVisibleViewport,
  isKeyboardTarget,
  VIEWPORT_REMEASURE_DELAYS_MS,
} from './use-app-viewport';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(FRONTEND_ROOT, rel), 'utf8');

const IPHONE_SCREEN = 852; // iPhone 15 Pro logical points (portrait)
const INSET = 34; // home-indicator safe-area-inset-bottom on that device

describe('standaloneBottomCompensation (ticket 45cb5171)', () => {
  it('compensates exactly the shortfall in an iOS installed PWA (the bug case)', () => {
    // iOS 26 standalone: vvHeight excludes the 34px inset → gap 34 → +34.
    expect(
      standaloneBottomCompensation({
        vvHeight: IPHONE_SCREEN - INSET,
        screenHeight: IPHONE_SCREEN,
        isStandalone: true,
        isIOS: true,
      }),
    ).toBe(INSET);
  });

  it('is a no-op on older iOS standalone (full-bleed: gap 0 — pre-26 behaviour preserved)', () => {
    expect(
      standaloneBottomCompensation({
        vvHeight: IPHONE_SCREEN,
        screenHeight: IPHONE_SCREEN,
        isStandalone: true,
        isIOS: true,
      }),
    ).toBe(0);
  });

  it('never compensates in browser mode (visualViewport is the visible truth there)', () => {
    expect(
      standaloneBottomCompensation({
        vvHeight: IPHONE_SCREEN - INSET,
        screenHeight: IPHONE_SCREEN,
        isStandalone: false,
        isIOS: true,
      }),
    ).toBe(0);
  });

  it('never compensates off iOS (desktop/Android PWAs do not have the WebKit bug)', () => {
    expect(
      standaloneBottomCompensation({
        vvHeight: IPHONE_SCREEN - INSET,
        screenHeight: IPHONE_SCREEN,
        isStandalone: true,
        isIOS: false,
      }),
    ).toBe(0);
  });

  it('treats a large shortfall as the software keyboard — no compensation', () => {
    // Keyboard open: vvHeight shrinks by ~300px. Compensating would push the
    // composer off-screen. The cap doubles as the keyboard discriminator.
    expect(
      standaloneBottomCompensation({
        vvHeight: IPHONE_SCREEN - 336,
        screenHeight: IPHONE_SCREEN,
        isStandalone: true,
        isIOS: true,
      }),
    ).toBe(0);
  });

  it('honours the cap boundary (inclusive at the cap, excluded above it)', () => {
    const base = { screenHeight: 1000, isStandalone: true, isIOS: true };
    expect(standaloneBottomCompensation({ ...base, vvHeight: 1000 - STANDALONE_GAP_CAP_PX })).toBe(
      STANDALONE_GAP_CAP_PX,
    );
    expect(standaloneBottomCompensation({ ...base, vvHeight: 1000 - STANDALONE_GAP_CAP_PX - 1 })).toBe(0);
  });

  it('rejects non-finite and inverted inputs (never NaN/negative into layout)', () => {
    const base = { screenHeight: IPHONE_SCREEN, isStandalone: true, isIOS: true };
    expect(standaloneBottomCompensation({ ...base, vvHeight: NaN })).toBe(0);
    expect(standaloneBottomCompensation({ ...base, vvHeight: IPHONE_SCREEN + 50 })).toBe(0);
  });
});

describe('ticket 45cb5171 wiring pins', () => {
  it('the hook stays standalone-gated (display-mode media query or navigator.standalone)', () => {
    const src = read('lib/use-app-viewport.ts');
    expect(src).toContain('(display-mode: standalone)');
    expect(src).toContain('standaloneBottomCompensation');
  });

  it('the hook stays iOS-gated (desktop PWAs must never compensate)', () => {
    const src = read('lib/use-app-viewport.ts');
    expect(src).toMatch(/iPad\|iPhone\|iPod/);
    expect(src).toContain('maxTouchPoints');
  });

  it('the fixed chat shell keeps reading var(--app-height — never the CSS overshoot', () => {
    const src = read('app/crossmodel/page.tsx');
    expect(src).toContain("height: 'var(--app-height, 100dvh)'");
    expect(src).not.toContain('pwa-viewport-fill');
  });

  it('globals.css carries the standalone-only overshoot utility for scroll surfaces', () => {
    const css = read('app/globals.css');
    expect(css).toContain('@media (display-mode: standalone)');
    expect(css).toContain('.pwa-viewport-fill');
    expect(css).toContain('calc(100dvh + env(safe-area-inset-bottom, 0px))');
  });

  it('login (the signed-out PWA entry) uses the overshoot utility', () => {
    const src = read('app/login/page.tsx');
    expect(src).toContain('pwa-viewport-fill');
  });
});

/**
 * Ticket c0e58120 — "still odd white margin blocking bottom view and right
 * sidebar can't be used with iphone dynamic island" (owner screenshot: the
 * shell ended at ~2/3 of the screen with a white block below; the panel's tab
 * strip sat under the status bar). Two defects, pinned here:
 *  - a keyboard dismissed WITHOUT a viewport event left --app-height pinned at
 *    the keyboard-open height → resolveVisibleViewport's stale-keyboard guard
 *    + the delayed re-measure schedule on focus/tap/visibility;
 *  - the workspace-panel drawer had no safe-area top padding.
 */
describe('resolveVisibleViewport — stale-keyboard guard (ticket c0e58120)', () => {
  const LAYOUT_H = 852; // iOS layout viewport never shrinks for the keyboard
  const KEYBOARD = 336;

  it('the bug case: keyboard-open visual viewport, nothing focused, scale 1 → layout height, pan 0', () => {
    expect(
      resolveVisibleViewport({ vvHeight: LAYOUT_H - KEYBOARD, vvOffsetTop: 120, innerHeight: LAYOUT_H, scale: 1, keyboardFocused: false }),
    ).toEqual({ height: LAYOUT_H, top: 0, staleKeyboard: true });
  });

  it('a genuinely open keyboard (composer focused) keeps the visual viewport + pan — the composer must stay reachable', () => {
    expect(
      resolveVisibleViewport({ vvHeight: LAYOUT_H - KEYBOARD, vvOffsetTop: 120, innerHeight: LAYOUT_H, scale: 1, keyboardFocused: true }),
    ).toEqual({ height: LAYOUT_H - KEYBOARD, top: 120, staleKeyboard: false });
  });

  it('pinch-zoom (scale > 1) is never mistaken for a stale keyboard', () => {
    expect(
      resolveVisibleViewport({ vvHeight: LAYOUT_H / 2, vvOffsetTop: 200, innerHeight: LAYOUT_H, scale: 2, keyboardFocused: false }),
    ).toEqual({ height: LAYOUT_H / 2, top: 200, staleKeyboard: false });
  });

  it('the iOS 26 standalone inset shortfall (≤ cap) is NOT a stale keyboard — the compensation path owns it', () => {
    expect(
      resolveVisibleViewport({ vvHeight: LAYOUT_H - 34, vvOffsetTop: 0, innerHeight: LAYOUT_H, scale: 1, keyboardFocused: false }),
    ).toEqual({ height: LAYOUT_H - 34, top: 0, staleKeyboard: false });
    // Boundary: exactly the cap is still the inset lane; one more px is the keyboard.
    expect(resolveVisibleViewport({ vvHeight: 1000 - STANDALONE_GAP_CAP_PX, vvOffsetTop: 0, innerHeight: 1000, scale: 1, keyboardFocused: false }).staleKeyboard).toBe(false);
    expect(resolveVisibleViewport({ vvHeight: 1000 - STANDALONE_GAP_CAP_PX - 1, vvOffsetTop: 0, innerHeight: 1000, scale: 1, keyboardFocused: false }).staleKeyboard).toBe(true);
  });

  it('Chromium resizes-content (innerHeight shrinks with the keyboard) → no shortfall → untouched', () => {
    expect(
      resolveVisibleViewport({ vvHeight: LAYOUT_H - KEYBOARD, vvOffsetTop: 0, innerHeight: LAYOUT_H - KEYBOARD, scale: 1, keyboardFocused: false }),
    ).toEqual({ height: LAYOUT_H - KEYBOARD, top: 0, staleKeyboard: false });
  });

  it('a visual viewport TALLER than the layout viewport (or NaN) is passed through, never "fixed"', () => {
    expect(resolveVisibleViewport({ vvHeight: LAYOUT_H + 34, vvOffsetTop: 0, innerHeight: LAYOUT_H, scale: 1, keyboardFocused: false }).staleKeyboard).toBe(false);
    expect(resolveVisibleViewport({ vvHeight: NaN, vvOffsetTop: 0, innerHeight: LAYOUT_H, scale: 1, keyboardFocused: false }).staleKeyboard).toBe(false);
  });

  it('isKeyboardTarget: inputs, textareas, selects and contenteditable (the tiptap composer) — nothing else', () => {
    expect(isKeyboardTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isKeyboardTarget({ tagName: 'textarea' })).toBe(true);
    expect(isKeyboardTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isKeyboardTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isKeyboardTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isKeyboardTarget({ tagName: 'BODY', isContentEditable: false })).toBe(false);
    expect(isKeyboardTarget(null)).toBe(false);
  });
});

describe('ticket c0e58120 wiring pins', () => {
  it('the hook re-measures on focus changes, taps and visibility on the delayed schedule (past the keyboard animation)', () => {
    const src = read('lib/use-app-viewport.ts');
    expect(src).toContain('resolveVisibleViewport({');
    expect(src).toContain('keyboardFocused: isKeyboardTarget(document.activeElement');
    for (const ev of ['focusin', 'focusout', 'pointerup', 'visibilitychange']) {
      expect(src).toContain(`addEventListener('${ev}', scheduleRemeasure`);
      expect(src).toContain(`removeEventListener('${ev}', scheduleRemeasure`);
    }
    expect(VIEWPORT_REMEASURE_DELAYS_MS.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...VIEWPORT_REMEASURE_DELAYS_MS)).toBeGreaterThan(300); // iOS keyboard animation ≈ 250–300 ms
    expect(src).toContain('timers.forEach(clearTimeout)'); // no timer survives unmount
  });

  it('the workspace-panel drawer pads its top by the safe-area inset (tab strip clear of the status bar / island)', () => {
    const view = read('app/crossmodel/components/CodeSessionView.tsx');
    const aside = view.slice(view.indexOf('<aside'), view.indexOf('WorkspacePanel onClose={closePanel}'));
    expect(aside).toContain("paddingTop: 'env(safe-area-inset-top, 0px)'");
    // Still pinned to the visual viewport vars in drawer mode (P1 pins).
    expect(aside).toContain('max-md:h-[var(--app-height,100dvh)]');
    expect(aside).toContain('max-md:top-[var(--app-top,0px)]');
  });
});

/**
 * Owner report 2026-09-16 ("how come this white space margin persist on the
 * ios pwa on the bottom", iPhone 15 Pro Max, iOS 26): both screenshots put the
 * shell's bottom edge at 873pt on a 932pt screen — short by exactly the 59pt
 * TOP inset while the content still drew under the status bar. The
 * screen-vs-viewport compensation can only restore what `screen.height`
 * knows about, and on that device `screen.height` itself came back minus the
 * island band. Pinned here: the inset-aware compensation, the probe, the
 * diagnostic payload, and the composer's zero-bottom-padding rule on mobile.
 */
describe('inset-aware standalone compensation (owner report 2026-09-16, measured by the device)', () => {
  const PRO_MAX = { screenWidth: 430, insetTop: 59, insetBottom: 34, isStandalone: true, isIOS: true, isIPhone: true };

  it("the owner's device: viewport 873 on a 932 screen (the status-bar band) → NO compensation — that region is outside the document viewport and unpaintable", () => {
    expect(standaloneBottomCompensation({ ...PRO_MAX, vvHeight: 873, screenHeight: 932 })).toBe(0);
    // Both insets stripped (93) is not the bottom-inset shape either.
    expect(standaloneBottomCompensation({ ...PRO_MAX, vvHeight: 839, screenHeight: 932 })).toBe(0);
  });

  it('the 45cb5171 shape (viewport short by the BOTTOM inset only) still compensates exactly the inset', () => {
    expect(standaloneBottomCompensation({ ...PRO_MAX, vvHeight: 898, screenHeight: 932 })).toBe(34);
    expect(standaloneBottomCompensation({ ...PRO_MAX, screenWidth: 393, vvHeight: 818, screenHeight: 852 })).toBe(34);
    // full-bleed (pre-26): gap 0 → no-op
    expect(standaloneBottomCompensation({ ...PRO_MAX, vvHeight: 932, screenHeight: 932 })).toBe(0);
  });

  it("'default' status-bar style (web view anchored below the status bar: insetTop 0): the 873 viewport IS the drawable area → no compensation", () => {
    expect(standaloneBottomCompensation({ ...PRO_MAX, insetTop: 0, vvHeight: 873, screenHeight: 932 })).toBe(0);
    // landscape iPhone: the 21px bottom inset gap still compensates
    expect(standaloneBottomCompensation({ ...PRO_MAX, screenWidth: 932, screenHeight: 430, insetTop: 0, insetBottom: 21, vvHeight: 409 })).toBe(21);
  });

  it('the cap is the bottom inset (+8) when insets are known; a keyboard-sized shortfall is never compensated; no readings → legacy 64px cap', () => {
    expect(standaloneBottomCompensation({ ...PRO_MAX, vvHeight: 932 - 42, screenHeight: 932 })).toBe(42);
    expect(standaloneBottomCompensation({ ...PRO_MAX, vvHeight: 932 - 43, screenHeight: 932 })).toBe(0);
    expect(standaloneBottomCompensation({ ...PRO_MAX, vvHeight: 500, screenHeight: 932 })).toBe(0);
    expect(standaloneBottomCompensation({ vvHeight: 932 - 59, screenHeight: 932, isStandalone: true, isIOS: true })).toBe(59);
    expect(standaloneBottomCompensation({ vvHeight: 932 - 70, screenHeight: 932, isStandalone: true, isIOS: true })).toBe(0);
  });

  it("layout.tsx anchors the Home Screen app below the status bar ('default' style) — the fix for the unpaintable strip", () => {
    const layout = read('app/layout.tsx');
    expect(layout).toContain("statusBarStyle: 'default'");
    expect(layout).toContain("'apple-mobile-web-app-status-bar-style': 'default'");
    expect(layout).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />');
    expect(layout).not.toContain("content=\"black-translucent\"");
  });

  it('buildPwaViewportDiagnostic carries every number the fix depends on', () => {
    const fakeWindow = {
      visualViewport: { height: 839, width: 430, offsetTop: 0, scale: 1 },
      innerHeight: 839, innerWidth: 430, outerHeight: 839, devicePixelRatio: 3,
      screen: { height: 873, width: 430, availHeight: 873 },
      document: { documentElement: { clientHeight: 839 } },
      matchMedia: (q: string) => ({ matches: q.includes('standalone') }),
      navigator: { standalone: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)' },
    } as unknown as Window;
    const d = buildPwaViewportDiagnostic(fakeWindow, { top: 59, bottom: 34, left: 0, right: 0 }, '873px');
    expect(d).toMatchObject({ vvHeight: 839, screenHeight: 873, screenWidth: 430, insetTop: 59, insetBottom: 34, appHeight: '873px', displayStandalone: true, navigatorStandalone: true, landscape: false });
    // v2 geometry fields are present (null without a DOM) and never throw.
    expect(d).toHaveProperty('shellRect'); expect(d).toHaveProperty('composerRect'); expect(d).toHaveProperty('hits');
    // v3 theme fields (owner 2026-09-17 "top bar still white in night mode"):
    // html class, OS preference, and every theme-color tag — empty/null here
    // (no DOM in the fake), never a throw.
    expect(d).toMatchObject({ prefersDark: false, themeColorMetas: [] });
    expect(d).toHaveProperty('htmlClass');
    expect(PWA_VIEWPORT_REPORT_KEY).toContain('pwaViewportReported');
  });

  it('wiring pins: the hook reads the env() insets through the probe, passes them to the compensation, and reports the diagnostic once', () => {
    const src = read('lib/use-app-viewport.ts');
    expect(src).toContain('readSafeAreaInsets(document)');
    expect(src).toContain('insetTop: insets.top');
    expect(src).toContain('insetBottom: insets.bottom');
    expect(src).toContain("event: 'pwa_viewport'");
    expect(src).toContain('sessionStorage.getItem(PWA_VIEWPORT_REPORT_KEY)');
  });

  it('the unified composer breathes on mobile: the larger of 0.5rem, the home-indicator inset and the shell overflow (owner 2026-09-17)', () => {
    const view = read('app/crossmodel/components/CodeSessionView.tsx');
    // The 2026-09-16 zero-padding rule was a misdiagnosis of the status-bar
    // band; the owner asked for air under the pill on 2026-09-17. Desktop
    // keeps the p-3 rhythm — as CLASSES, never an inline paddingBottom (an
    // inline value overrode the desktop pad and the pill sat flush).
    // Digby Frontier (2026-10-06): 24px gutters, 14px of air on desktop.
    expect(view).toContain('relative bg-background px-4 sm:px-6 pt-0 pb-[max(0.5rem,env(safe-area-inset-bottom,0px),var(--app-overflow,0px))] sm:pb-[max(14px,var(--app-overflow,0px))] shrink-0');
    expect(view).not.toContain("paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))'");
    expect(view).not.toContain("paddingBottom: 'var(--app-overflow, 0px)'");
    expect(read('lib/use-app-viewport.ts')).toContain("setProperty('--app-overflow'");
  });
});

describe('composer rhythm (owner 2026-09-17 "not nicely even or centered … too tall")', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
  it('Digby Frontier rhythm: a 16px textarea on top (never sub-16px — iOS zoom), 34px tool circles and a 36px send circle in the toolbar', () => {
    const composer = read('app/crossmodel/components/ChatComposer.tsx');
    // Mobile font stays 16px: iOS Safari auto-zooms the page when a focused
    // input's font-size is below 16px (owner 2026-09-18 "the zoom came back").
    expect(composer).toContain("'text-[16px] leading-[1.5] text-ink placeholder:text-ink-3'");
    expect(composer).not.toMatch(/text-\[1[0-5](?:\.\d+)?px\] sm:/); // no sub-16px mobile font on any composer textarea
    expect(composer).toContain("size === 'home' ? 'min-h-[64px]' : 'min-h-[30px]'");
    expect(composer).toContain("'relative flex size-[34px] shrink-0 items-center justify-center rounded-full");
    expect(composer).toContain("'relative flex size-9 shrink-0 items-center justify-center rounded-full '");
    const view = read('app/crossmodel/components/CodeSessionView.tsx');
    // attach + mic ride the shared circles — no 44px touch-only floor that made the row taller than the send button on phones
    expect(view).toContain('className={COMPOSER_ATTACH_BTN}');
    expect(view).toContain(': COMPOSER_TOOL_BTN}');
    expect(view).not.toContain('min-h-11 min-w-11 [@media(pointer:fine)]:min-h-8');
  });
});

describe('staleStatusBarInstall (owner 2026-09-17 — the merged status-bar fix never reaches a Home Screen copy installed under the old style)', () => {
  it("Paul's 14:36Z row: standalone iOS, insetTop 59, web view 873 on a 932 screen → stale install", () => {
    expect(staleStatusBarInstall({ isStandalone: true, isIOS: true, insetTop: 59, innerHeight: 873, screenHeight: 932 })).toBe(true);
    // the second iPhone on the account (852 screen)
    expect(staleStatusBarInstall({ isStandalone: true, isIOS: true, insetTop: 59, innerHeight: 793, screenHeight: 852 })).toBe(true);
  });
  it("a fresh install under the 'default' style (insetTop 0), Safari (not standalone), a keyboard-shortened viewport, and a full-bleed web view are not stale", () => {
    expect(staleStatusBarInstall({ isStandalone: true, isIOS: true, insetTop: 0, innerHeight: 873, screenHeight: 932 })).toBe(false);
    expect(staleStatusBarInstall({ isStandalone: false, isIOS: true, insetTop: 59, innerHeight: 873, screenHeight: 932 })).toBe(false);
    expect(staleStatusBarInstall({ isStandalone: true, isIOS: true, insetTop: 59, innerHeight: 520, screenHeight: 932 })).toBe(false);
    expect(staleStatusBarInstall({ isStandalone: true, isIOS: true, insetTop: 59, innerHeight: 932, screenHeight: 932 })).toBe(false);
    expect(staleStatusBarInstall({ isStandalone: true, isIOS: false, insetTop: 59, innerHeight: 873, screenHeight: 932 })).toBe(false);
  });
  it('wiring pin: the hook shows the re-add hint once a week behind the detector, next to the one-shot diagnostic', () => {
    const src = readFileSync(join(process.cwd(), 'lib/use-app-viewport.ts'), 'utf8');
    expect(src).toContain('if (staleStatusBarInstall({ isStandalone, isIOS, insetTop: insets.top, innerHeight: window.innerHeight, screenHeight: window.screen?.height ?? 0 })) {');
    expect(src).toContain("window.localStorage.getItem(PWA_READD_HINT_KEY)");
    expect(src).toContain("toast.message('Re-add Digby to your Home Screen'");
    expect(PWA_READD_HINT_KEY).toBe('digby.pwaReaddHint.v1');
  });
});

/**
 * Ticket ce014662 — owner report: "when you clickl a link within a digby
 * session it opens the url in the mac os cleint with no way to get back to the
 * main app…also i thought we fully updated this to show in the sidebar as a
 * browser windows when links were clicked oespecially on a mac os client it
 * just rended the browser window in the sidebar"
 *
 * Root cause (two halves):
 *  1. The web app HAS the fix — this InAppBrowser overlay (owner directive
 *     2026-07-14, "Back to Digby" chrome) — but its isStandalone() gate tests
 *     display-mode: standalone / navigator.standalone, neither of which is
 *     EVER true inside a native WKWebView (display-mode reports "browser";
 *     navigator.standalone is iOS-Safari-only). The macOS shell injects
 *     window.__digbyDesktop at document start precisely for this detection —
 *     the gate just never read it. So in Digby.app every external link fell
 *     through to the shell's own funnel…
 *  2. …whose createWebViewWith force-loaded EVERY target=_blank request
 *     in-place (chat markdown renders all links as target="_blank"), and the
 *     programmatic webView.load() bypasses decidePolicyFor's external-host
 *     branch (navigationType .other ≠ .linkActivated) — the external page
 *     replaced the whole app with no visible way back (only hidden ⌘[/swipe).
 *
 * This suite pins both halves by reading the REAL source files (the macOS
 * shell is Swift — not importable into vitest — and the gate is exercised via
 * jsdom globals), so a regression on either side reddens here.
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Extract isStandalone's source text from the component and EVALUATE it
 *  against a stubbed window — a behavioral test of the REAL bytes, runnable
 *  in vitest's node environment (the repo has no jsdom). TS casts are
 *  stripped so plain JS eval works. */
const evalGate = (windowStub: unknown): boolean => {
  const src = readSrc('./InAppBrowser.tsx');
  const m = src.match(/function isStandalone\(\): boolean \{[\s\S]*?\n\}/);
  if (!m) throw new Error('isStandalone not found in InAppBrowser.tsx');
  const js = m[0]
    .replace(/\): boolean \{/, ') {')
    .replace(/window as any\)/g, 'window)')
    .replace(/\(window as any\)/g, '(window)')
    .replace(/window\.navigator as any\)/g, 'window.navigator)');
  return new Function('window', `${js}\nreturn isStandalone();`)(windowStub) as boolean;
};

describe('ce014662 — InAppBrowser gate recognizes the desktop shell', () => {
  it('the gate source checks window.__digbyDesktop (the shell injects it at document start)', () => {
    const src = readSrc('./InAppBrowser.tsx');
    expect(src).toContain('__digbyDesktop');
    const fn = src.slice(src.indexOf('function isStandalone'), src.indexOf('export default function InAppBrowser'));
    expect(fn).toContain('__digbyDesktop');
  });

  it('BEHAVIOR: gate returns TRUE with only __digbyDesktop set — the WKWebView case (no matchMedia, no standalone)', () => {
    // The exact native-shell situation where the legacy gate read false
    // forever: matchMedia absent, navigator.standalone absent, flag present.
    const wkWebViewWindow = {
      __digbyDesktop: { version: '0.1.10', platform: 'mac', canSetupIMessage: true },
      // no matchMedia, no navigator — deliberately absent
    };
    expect(evalGate(wkWebViewWindow)).toBe(true);
  });

  it('BEHAVIOR: gate stays FALSE in a plain browser tab (no flag, no standalone display-mode)', () => {
    const browserTabWindow = {
      matchMedia: (q: string) => ({ matches: q.includes('browser') }), // display-mode: browser
      navigator: {}, // every real browser has navigator
    };
    expect(evalGate(browserTabWindow)).toBe(false);
  });

  it('BEHAVIOR: the PWA path still works (display-mode: standalone, no desktop flag)', () => {
    const pwaWindow = { matchMedia: (q: string) => ({ matches: q.includes('standalone') }) };
    expect(evalGate(pwaWindow)).toBe(true);
  });

  it('BEHAVIOR: the iOS-Safari legacy navigator.standalone path still works', () => {
    const iosWindow = { navigator: { standalone: true } };
    expect(evalGate(iosWindow)).toBe(true);
  });

  it('the gate guards SSR (typeof window check intact)', () => {
    const src = readSrc('./InAppBrowser.tsx');
    const fn = src.slice(src.indexOf('function isStandalone'), src.indexOf('export default function InAppBrowser'));
    expect(fn).toContain("typeof window === 'undefined'");
    expect(() => evalGate(undefined)).not.toThrow();
    expect(evalGate(undefined)).toBe(false);
  });
});

describe('ce014662 — macOS shell (main.swift) link handling', () => {
  const swift = readSrc('../../../../macos-app/Sources/Digby/main.swift');

  it('createWebViewWith routes non-allowlisted hosts to the SYSTEM BROWSER instead of loading in-place', () => {
    const i = swift.indexOf('func webView(_ webView: WKWebView, createWebViewWith');
    expect(i).toBeGreaterThanOrEqual(0);
    const fn = swift.slice(i, i + 900); // the whole function body incl. both return-nil arms
    expect(fn).toContain('NSWorkspace.shared.open(url)');
    // The allowlisted (OAuth) hosts keep the in-place funnel.
    expect(fn).toContain('keepInApp(host)');
    expect(fn).toContain('webView.load(navigationAction.request)');
    // Guard order matters: the host check must come BEFORE the in-place load.
    expect(fn.indexOf('NSWorkspace.shared.open(url)')).toBeLessThan(fn.indexOf('webView.load(navigationAction.request)'));
  });

  it('the external-link comment names the .linkActivated/.other bypass it fixes', () => {
    // Documentation pin: the fix's rationale must survive refactors.
    expect(swift).toContain('navigationType');
    expect(swift).toContain('ce014662');
  });

  it('the window title reflects an off-Digby host (no more silent "Digby" on github.com)', () => {
    const i = swift.indexOf('func webView(_ webView: WKWebView, didFinish');
    expect(i).toBeGreaterThanOrEqual(0);
    const fn = swift.slice(i, i + 400);
    expect(fn).toContain('Digby — \\(host)');
  });
});

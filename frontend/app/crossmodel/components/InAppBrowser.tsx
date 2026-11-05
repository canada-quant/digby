'use client';

/**
 * In-app browser (owner directive 2026-07-14): in the installed macOS/iOS app
 * (standalone display-mode) an external link used to REPLACE the whole Digby
 * view with no way back (web-app windows have no browser chrome). Now every
 * external link opens a full-screen browser INSIDE Digby — header with
 * "Back to Digby", the page URL, reload, and open-in-system-browser — with the
 * page in an iframe below.
 *
 * Notes:
 * - Gated to standalone/PWA mode: in a normal browser tab, links keep native
 *   behavior (new tab etc.).
 * - Sites that forbid embedding (X-Frame-Options / frame-ancestors) render
 *   blank — the header stays on top with "Open in Browser" as the escape
 *   hatch, and a hint appears after a few seconds.
 * - A document-level capture-phase click listener intercepts EVERY external
 *   http(s) anchor app-wide (chat markdown, briefing, feeds, sources, canvases)
 *   without touching any call site.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, RotateCw, Compass, X } from 'lucide-react';
import { useBranding } from '@/app/branding/BrandingProvider';

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // Ticket ce014662 (2026-09-28, owner report "click a link within a digby
  // session it opens the url in the mac os client with no way to get back"):
  // the NATIVE desktop shells (macOS WKWebView, Windows WebView2) never report
  // display-mode: standalone — a WKWebView's display-mode is always "browser"
  // and navigator.standalone is iOS-Safari-only — so this gate was never true
  // in Digby.app and the overlay (the "Back to Digby" in-app browser this
  // component IS, owner directive 2026-07-14) silently never attached there:
  // every external link replaced the whole app with no visible way back. The
  // shells inject window.__digbyDesktop at document start precisely so the web
  // app can detect them (the iMessage card + voice composer already read it) —
  // honor it here too.
  if ((window as any).__digbyDesktop) return true;
  return window.matchMedia?.('(display-mode: standalone)')?.matches
    || (window.navigator as any).standalone === true; // iOS Safari legacy flag
}

export default function InAppBrowser() {
  const branding = useBranding();
  const [url, setUrl] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0); // bump to reload
  const [showBlockHint, setShowBlockHint] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    setUrl(null);
    setShowBlockHint(false);
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);

  // Global interceptor — capture phase beats React handlers and default nav.
  useEffect(() => {
    if (!isStandalone()) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (!/^https?:\/\//i.test(href)) return;               // internal/relative, mailto:, tel: — native
      try {
        if (new URL(href).origin === window.location.origin) return; // in-app route — native
      } catch { return; }
      e.preventDefault();
      e.stopPropagation();
      setUrl(href);
      setFrameKey(k => k + 1);
      setShowBlockHint(false);
      if (hintTimer.current) clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setShowBlockHint(true), 4000);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // ESC returns to Digby.
  useEffect(() => {
    if (!url) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [url, close]);

  if (!url) return null;

  let host = url;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }

  return (
    <>
      {/* Mobile sheet idiom (UI Phase 6a): below md the in-app browser renders
          as a near-full-height BOTTOM SHEET over a backdrop — the same idiom
          as the agent-browser sheet (BrowserPanel.tsx) — so user link-taps and
          agent browsing share one mobile grammar. md+ keeps the original
          full-screen takeover. z-[200] predates the z tokens and deliberately
          sits above toasts; the backdrop slots just beneath it. */}
      <div className="fixed inset-0 z-[199] bg-black/40 md:hidden" onClick={close} />
      <div className="fixed inset-0 z-[200] flex flex-col bg-background pt-[env(safe-area-inset-top,0px)] max-md:top-[max(env(safe-area-inset-top,0px),6vh)] max-md:pt-0 max-md:rounded-t-2xl max-md:border-t max-md:border-border max-md:shadow-2xl max-md:overflow-hidden">
      <div className="mx-auto mt-1.5 h-1 w-9 rounded-full bg-muted-foreground/30 md:hidden" aria-hidden="true" />
      {/* Chrome */}
      <div className="flex items-center gap-2 border-b bg-card/95 px-2.5 h-12 shrink-0">
        <button
          onClick={close}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-ink-2 hover:bg-muted transition-colors"
          aria-label={`Back to ${branding.name}`}
        >
          <ArrowLeft className="size-4" />
          {branding.name}
        </button>
        <div className="flex-1 min-w-0 rounded-full border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground truncate select-all" title={url}>
          {host}
          <span className="opacity-50">{(() => { try { const u = new URL(url); return u.pathname !== '/' ? u.pathname : ''; } catch { return ''; } })()}</span>
        </div>
        <button onClick={() => setFrameKey(k => k + 1)} className="p-2 rounded-lg hover:bg-muted text-muted-foreground" title="Reload" aria-label="Reload">
          <RotateCw className="size-4" />
        </button>
        <button
          onClick={() => { window.open(url, '_blank', 'noopener'); }}
          className="p-2 rounded-lg hover:bg-muted text-muted-foreground"
          title="Open in Browser"
          aria-label="Open in Browser"
        >
          <Compass className="size-4" />
        </button>
        <button onClick={close} className="p-2 rounded-lg hover:bg-muted text-muted-foreground" title="Close" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>

      {/* Blocked-embed hint (many big sites forbid iframes) */}
      {showBlockHint && (
        <div className="flex items-center justify-between gap-3 bg-warn/10 border-b border-warn/60 dark:border-warn/40 px-3 py-1.5 text-[11px] text-warn-ink">
          <span>Page not loading? Some sites don&apos;t allow embedding.</span>
          <span className="flex items-center gap-3 shrink-0">
            <button onClick={() => window.open(url, '_blank', 'noopener')} className="font-medium underline underline-offset-2">
              Open in Browser
            </button>
            <button onClick={() => setShowBlockHint(false)} aria-label="Dismiss" className="opacity-60 hover:opacity-100"><X className="size-3.5" /></button>
          </span>
        </div>
      )}

      {/* The page */}
      <iframe
        key={frameKey}
        src={url}
        className="flex-1 w-full border-0 bg-white"
        // Don't delegate sensitive capabilities (clipboard-read / geolocation) to an
        // arbitrary cross-origin page loaded here (2026-07-21 pre-launch audit).
        allow="fullscreen"
        referrerPolicy="no-referrer"
        title={host}
      />
      </div>
    </>
  );
}

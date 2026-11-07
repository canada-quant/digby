'use client';

/**
 * Branding for CLIENT components (todo d2d32b57) — plus the RUNTIME PACK OVERLAY
 * (todo 61dc8aaf, Phase 2 Cloud).
 *
 * The root layout resolves the operator's branding on the SERVER (build time
 * for static routes) and passes the snapshot down here, so client surfaces
 * never read `process.env` themselves (a client bundle cannot see
 * `DIGBY_BRAND_*`, and `NEXT_PUBLIC_` would bake a second copy of every
 * value). Rendering a component with no provider (a unit test, a story, an
 * error boundary that mounted above the layout) yields DEFAULT_BRANDING —
 * the shipped Digby identity — never a blank.
 *
 * WHY THE PACK IS FETCHED HERE AND NOT IN THE LAYOUT. `brandingFromEnv()` runs
 * at module scope, which Next prerenders: a seasonal pack activated at 14:00
 * would otherwise not appear until the next deploy. The server snapshot stays the
 * FIRST PAINT (correct for SEO, no-JS visitors and the shipped identity), and this
 * provider asks for the ACTIVE pack once on mount and merges it over that
 * snapshot. Only a pack that is actually active ever changes anything, so an
 * instance with no pack behaves exactly as before — one cheap same-origin GET,
 * no redirect, no blocked render.
 *
 * WHO APPLIES IT. Every consumer that reads `useBranding()` — `BrandLogo`,
 * `BrandSpinner`, the login panel, error page, chat chrome, share pages —
 * re-renders with the seasonal identity automatically, because they all read the
 * ONE context. The pack layer adds no per-surface plumbing.
 *
 * WHAT THE OVERLAY CANNOT DO, stated plainly: server-rendered `<title>`,
 * metadata description, OpenGraph/Twitter cards and the PWA manifest are baked
 * or force-static, so a pack does not rewrite them mid-session. The DOCUMENT
 * title and the favicon ARE updated here (both are live DOM), which covers the
 * visible tab identity; anything crawler-facing keeps the deployed identity
 * until the next build. That is the honest boundary of a no-rebuild skin.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_BRANDING, type Branding } from '@/lib/branding';
import { applyPack, parseActivePack, type ActivePack } from '@/lib/branding/pack';

const BrandingContext = createContext<Branding>(DEFAULT_BRANDING);

/** Set when the fetch should be skipped (tests, storybook, SSR-only mounts). */
export interface BrandingProviderProps {
  value: Branding;
  children: ReactNode;
  /**
   * Fetch the active branding pack on mount. Default true — a Cloud instance
   * should pick up a seasonal skin without a rebuild. Pass false from a unit
   * test or a surface that must stay on the shipped identity deterministically.
   */
  runtimePack?: boolean;
}

export function BrandingProvider({ value, children, runtimePack = true }: BrandingProviderProps) {
  const [pack, setPack] = useState<ActivePack | null>(null);

  useEffect(() => {
    if (!runtimePack) {
      setPack(null);
      return;
    }
    let cancelled = false;
    // A same-origin GET. `credentials: 'same-origin'` is irrelevant for a public
    // read but keeps the request cookie-less and cacheable exactly as a visitor's.
    fetch('/api/crossmodel/branding/pack', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        // A malformed / HTML / error body parses to null, which leaves the
        // shipped branding in place — never throw inside a provider.
        if (!cancelled) setPack(parseActivePack(json));
      })
      .catch(() => {
        // Network failure = no seasonal skin. The site must never depend on this
        // request succeeding; the server snapshot already rendered.
      });
    return () => {
      cancelled = true;
    };
  }, [runtimePack]);

  const branding = pack ? applyPack(value, pack) : value;

  // Live DOM identity that a pack DOES own: the tab title and the favicon. Both
  // are patched only while a pack is active, and restored to the server snapshot
  // when it is rolled back, so a rollback is visible without a reload.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (!pack) return;
    const prevTitle = document.title;
    document.title = branding.title;

    const links: HTMLLinkElement[] = [];
    const addIcon = (rel: string, href: string, extra?: Record<string, string>) => {
      const el = document.createElement('link');
      el.rel = rel;
      el.href = href;
      if (extra) for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
      el.setAttribute('data-branding-pack', pack.id);
      document.head.appendChild(el);
      links.push(el);
    };
    // Disable the shipped icons while the pack is on: a browser picks the LAST
    // matching rel=icon, but leaving stale 16/32 links in place makes that
    // ordering fragile across engines. Restoring them on cleanup is exact.
    const shipped = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="apple-touch-icon"]'));
    for (const el of shipped) el.setAttribute('data-branding-pack-disabled', '1');
    addIcon('icon', branding.assets.favicon32, { sizes: '32x32', type: 'image/png' });
    addIcon('icon', branding.assets.icon512, { sizes: '512x512', type: 'image/png' });
    addIcon('apple-touch-icon', branding.assets.appleTouchIcon);

    return () => {
      document.title = prevTitle;
      for (const el of links) el.remove();
      for (const el of shipped) el.removeAttribute('data-branding-pack-disabled');
    };
  }, [pack, branding.title, branding.assets.favicon32, branding.assets.icon512, branding.assets.appleTouchIcon]);

  return <BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider>;
}

/** The active branding. Safe anywhere: defaults to the shipped Digby identity. */
export function useBranding(): Branding {
  return useContext(BrandingContext);
}

/**
 * The raw active pack (id, assets with sha256, activatedAt) — for admin/preview
 * surfaces that need more than the merged `Branding`. Null when none is active.
 */
export function useActivePack(): ActivePack | null {
  const [pack, setPack] = useState<ActivePack | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/crossmodel/branding/pack', { credentials: 'same-origin' });
      if (!res.ok) return setPack(null);
      setPack(parseActivePack(await res.json()));
    } catch {
      setPack(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return pack;
}
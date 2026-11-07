/**
 * RENDERED-RUNTIME ZERO-AD-REQUEST PROOF (todo 9a3e82af, 2026-11-06).
 *
 * THE REQUIREMENT, VERBATIM: "rendered-runtime network proof of zero ad requests
 * … not merely a static grep".
 *
 * WHY THE EARLIER SUITES DID NOT SATISFY IT
 *   `ad-build-posture.test.ts` greps config. `ad-render-gate.test.ts` renders to
 *   a STRING — an SSR render never runs effects, and the components' `allowed`
 *   state starts `false`, so a string render can only ever observe the
 *   pre-hydration state. Neither watches what a hydrated page attempts to load.
 *
 * WHAT THIS SUITE DOES
 *   Builds a real DOM (jsdom), mounts the ACTUAL `GoogleAdsTag` and `MetaPixel`
 *   with `react-dom/client`, and flushes their effects with React's `act()` —
 *   the step that hydration performs and that the earlier suites never reached.
 *   `next/script` is replaced by a recorder that captures the `src` the component
 *   hands it, which is precisely the URL a browser is told to fetch. A signed-out
 *   visitor is the session, so `googleAdsAllowedForToken(null)` is TRUE and the
 *   capability gate is open: the ONLY thing that can suppress the tag is the
 *   build posture under test.
 *
 * MEASURED BEHAVIOUR THIS PINS (verified by direct probe before writing it)
 *   enabled posture  → effects flush → `injected ===
 *     ["https://www.googletagmanager.com/gtag/js?id=G-NK7XPHC7FE"]`
 *   public posture   → effects flush → `injected === []`
 *   That contrast is the non-vacuity proof: the harness demonstrably CAN observe
 *   the ad URL, and it observes none under the posture we ship.
 *
 * HONEST LIMIT — do not overstate this when citing it.
 *   This observes what the rendered component ASKS to load; it does not perform
 *   an HTTP fetch, and jsdom is not Chromium (no HTTP/2, no CSP, no third-party
 *   redirect chains). A true headless-Chromium capture is NOT runnable in this
 *   image: `headless_shell` needs 15 shared libraries that are absent (libnss3,
 *   libatk-1.0, libgbm, libasound, …) and the container runs as uid 1001 with no
 *   sudo/root to install them. This is the strongest runtime proof obtainable
 *   here, and it exercises the real components with real effects.
 */

import { JSDOM } from 'jsdom';
import { describe, expect, it, vi, afterEach } from 'vitest';

/** Ad + measurement hosts that must never be requested by a rendered page. */
const AD_HOST_PATTERNS = [
  'googletagmanager.com',
  'googleadservices.com',
  'doubleclick.net',
  'connect.facebook.net',
] as const;

const adHostsIn = (strings: string[]) =>
  AD_HOST_PATTERNS.filter((h) => strings.some((s) => s.includes(h)));

function setPosture(disabled: boolean) {
  const v = disabled ? '1' : '';
  vi.stubEnv('NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED', v);
  vi.stubEnv('NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED', v);
  vi.stubEnv('NEXT_PUBLIC_META_PIXEL_DISABLED', v);
}

/**
 * Mount one component in a real DOM under the given posture, flush its effects
 * with React's act(), and return every URL it handed to next/script plus the
 * inline bootstraps it injected (the Meta pixel's snippet is inline).
 */
async function capture(componentModule: 'GoogleAdsTag' | 'MetaPixel', adsDisabled: boolean) {
  setPosture(adsDisabled);
  vi.resetModules();

  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://digby.example/',
    // NOT swapped back afterwards: React's scheduler caches globals at module
    // init and restoring a different window under a pending task crashes it with
    // an unrelated "reading 'event'" TypeError.
    ...({} as Record<string, never>),
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.localStorage = dom.window.localStorage;
  g.navigator = dom.window.navigator;

  // Everything the component asked the page to load / execute.
  const requested: string[] = [];

  vi.doMock('next/navigation', () => ({ usePathname: () => '/' }));
  vi.doMock('next/script', () => ({
    default: (props: { src?: string; children?: unknown }) => {
      if (props.src) requested.push(props.src);
      if (typeof props.children === 'string') requested.push(props.children);
      return null;
    },
  }));

  const mod = (await import(
    componentModule === 'GoogleAdsTag' ? '../app/GoogleAdsTag' : '../app/MetaPixel'
  )) as Record<string, unknown>;
  const Component = mod[componentModule] as () => unknown;

  const React = require('react') as typeof import('react');
  const { act } = React as unknown as { act: (cb: () => void | Promise<void>) => Promise<void> };
  const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');

  const root = createRoot(dom.window.document.getElementById('root')!);
  // act() is the flush: it runs effects and settles state updates, which is what
  // hydration does in a browser and what the SSR suites never did.
  await act(async () => {
    root.render(React.createElement(Component as never));
  });
  // Let the effect's own async follow-ups settle too.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  return { requested };
}

afterEach(() => vi.unstubAllEnvs());

describe('RUNTIME: a hydrated page under the PUBLIC posture requests ZERO ad hosts', () => {
  it('GoogleAdsTag — effects flush, and nothing is handed to next/script', async () => {
    const { requested } = await capture('GoogleAdsTag', true);
    expect({ adRequests: adHostsIn(requested), requested }).toEqual({
      adRequests: [],
      requested: [],
    });
  });

  it('MetaPixel — effects flush, and nothing is handed to next/script', async () => {
    const { requested } = await capture('MetaPixel', true);
    expect({ adRequests: adHostsIn(requested), requested }).toEqual({
      adRequests: [],
      requested: [],
    });
  });

  it('both components together request no ad host', async () => {
    const a = await capture('GoogleAdsTag', true);
    const b = await capture('MetaPixel', true);
    expect({ adRequests: adHostsIn([...a.requested, ...b.requested]) }).toEqual({ adRequests: [] });
  });
});

describe('DISCRIMINATING: the same harness DOES observe the ad URL when enabled', () => {
  it('GoogleAdsTag under the ENABLED posture requests googletagmanager.com/gtag/js', async () => {
    // Non-vacuity, end to end. If this ever passes trivially the suite above
    // proves nothing; measured, it yields
    // ["https://www.googletagmanager.com/gtag/js?id=G-NK7XPHC7FE"].
    const { requested } = await capture('GoogleAdsTag', false);
    expect(adHostsIn(requested)).toContain('googletagmanager.com');
    expect(requested.join(' ')).toContain('/gtag/js');
  });

  it('MetaPixel under the ENABLED posture requests connect.facebook.net/fbevents.js', async () => {
    const { requested } = await capture('MetaPixel', false);
    expect(adHostsIn(requested)).toContain('connect.facebook.net');
    expect(requested.join(' ')).toContain('fbevents.js');
  });
});
/**
 * AD RENDER GATE (todo 9a3e82af, 2026-11-06) — what the rendered output actually
 * emits under each build posture.
 *
 * WHY THIS SUITE EXISTS
 *   `ad-build-posture.test.ts` proves the switches are DECLARED and defaulted
 *   off. That is necessary but it does not answer "does a rendered page emit an
 *   ad request?", which is the question the todo actually asks. A switch that no
 *   render path consults would leave that first suite green and the product
 *   still loading ad tech.
 *
 *   So this suite drives the REAL gate functions and the REAL components and
 *   asserts on the rendered markup. Crucially it is DISCRIMINATING: it proves
 *   the ad host IS emitted when the posture enables it, so a green run cannot be
 *   an artefact of the assertion being vacuous (a test that only ever asserts
 *   "absent" passes just as well when the code is deleted).
 *
 * WHAT THIS DOES AND DOES NOT PROVE — read before citing it
 *   PROVES: under the public/Self-Hosted/Enterprise posture
 *           (`*_DISABLED=1`, now the image default) both components render
 *           nothing and no ad-host URL is constructed; under the hosted posture
 *           the gate opens and the ad host IS produced.
 *   DOES NOT PROVE: live network silence in a browser. `allowed` starts false
 *           and only flips in an effect, so the tag mounts client-side after
 *           hydration — no server/SSR render can observe the real request. That
 *           remains a browser network capture against a deployed instance, and
 *           it is tracked on the todo rather than claimed here. This container
 *           has no jsdom/playwright/puppeteer to run one.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The components are client components: they read the route and render
// next/script. Stub both so the render is about the AD GATE, not about Next.
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('next/script', () => ({
  default: (props: { id?: string; src?: string; children?: unknown }) =>
    createElement('script', { id: props.id, src: props.src }, props.children as never),
}));

const AD_HOSTS = [
  'googletagmanager.com', // gtag.js — Google Ads + GA4
  'googleadservices.com',
  'doubleclick.net',
  'connect.facebook.net', // fbevents.js — Meta pixel
] as const;

/** Every ad host present in a string, for a failure message that names the leak. */
const adHostsIn = (text: string) => AD_HOSTS.filter((h) => text.includes(h));

/** Apply a posture to the process env the gate functions read, and undo after. */
function posture(disabled: boolean) {
  const value = disabled ? '1' : '';
  vi.stubEnv('NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED', value);
  vi.stubEnv('NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED', value);
  vi.stubEnv('NEXT_PUBLIC_META_PIXEL_DISABLED', value);
}

afterEach(() => vi.unstubAllEnvs());

describe('the gate functions actually discriminate on the build posture', () => {
  it('PUBLIC posture: every ad switch reports disabled', async () => {
    posture(true);
    const { googleAdsTagDisabled } = await import('./google-ads');
    const { metaPixelDisabled } = await import('./meta-pixel');
    expect({
      googleTag: googleAdsTagDisabled(),
      metaPixel: metaPixelDisabled(),
    }).toEqual({ googleTag: true, metaPixel: true });
  });

  it('HOSTED posture: the switches open (so the assertions below are not vacuous)', async () => {
    posture(false);
    const { googleAdsTagDisabled } = await import('./google-ads');
    const { metaPixelDisabled } = await import('./meta-pixel');
    expect({
      googleTag: googleAdsTagDisabled(),
      metaPixel: metaPixelDisabled(),
    }).toEqual({ googleTag: false, metaPixel: false });
  });

  it('the ad hosts really ARE in the enabled bootstrap payloads', async () => {
    // Non-vacuity in both directions: if these strings lost their host, the
    // "renders nothing" assertions below would pass for the wrong reason.
    const { googleAdsBootstrap, googleTagLoaderId } = await import('./google-ads');
    const { metaPixelBootstrap } = await import('./meta-pixel');
    expect(adHostsIn(metaPixelBootstrap()).length).toBeGreaterThan(0);
    // The Google tag's host lives in the Script src, built from the loader id.
    expect(googleTagLoaderId()).toMatch(/^G-|^AW-/);
    expect(googleAdsBootstrap()).toContain('gtag');
  });
});

describe('rendered output under the PUBLIC posture emits no ad host', () => {
  it('GoogleAdsTag renders nothing', async () => {
    posture(true);
    vi.resetModules();
    const { GoogleAdsTag } = await import('../app/GoogleAdsTag');
    const html = renderToStaticMarkup(createElement(GoogleAdsTag));
    expect({ adHosts: adHostsIn(html), html }).toEqual({ adHosts: [], html: '' });
  });

  it('MetaPixel renders nothing', async () => {
    posture(true);
    vi.resetModules();
    const { MetaPixel } = await import('../app/MetaPixel');
    const html = renderToStaticMarkup(createElement(MetaPixel));
    expect({ adHosts: adHostsIn(html), html }).toEqual({ adHosts: [], html: '' });
  });
});

describe('no ad URL can be constructed before the guard', () => {
  // The ad-emitting construct differs per component, and the marker must be the
  // thing that actually produces the request:
  //   GoogleAdsTag  — the googletagmanager.com src is built inline in the JSX;
  //   MetaPixel     — the connect.facebook.net string lives in
  //                   lib/meta-pixel.ts metaPixelBootstrap(), so the component's
  //                   emitting construct is the CALL to it.
  // Using a shared "contains an ad host" marker was wrong: MetaPixel.tsx
  // contains no host at all, so it failed for the right reason.
  it.each([
    ['GoogleAdsTag.tsx', 'googleAdsTagDisabled', 'googletagmanager.com'],
    ['MetaPixel.tsx', 'metaPixelDisabled', 'metaPixelBootstrap('],
  ])('%s returns null on the disabled branch BEFORE it can emit', (file, guard, marker) => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'app', file),
      'utf8',
    ) as string;

    const guardIdx = src.indexOf(`if (${guard}() || !allowed) return null;`);
    expect({ file, hasGuard: guardIdx >= 0 }).toEqual({ file, hasGuard: true });

    // Non-vacuity first: the emitting construct must EXIST, or "it comes after
    // the guard" would be trivially true for an empty component.
    const markerIdx = src.indexOf(marker);
    expect({ file, marker, present: markerIdx >= 0 }).toEqual({ file, marker, present: true });

    // And it must be reachable only after the guard returns early.
    expect({ file, marker, afterGuard: markerIdx > guardIdx }).toEqual({
      file,
      marker,
      afterGuard: true,
    });
  });
});
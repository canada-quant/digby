'use client';

/**
 * The site's ONE Google tag (gtag.js) — rendered by app/layout.tsx on every page (Google: "every page … Don't add
 * more than one Google tag to each page"). Loaded by the GA4 id (Google's GA snippet); GA4 G-NK7XPHC7FE and Google
 * Ads AW-00000000000 are `config`s in the SAME bootstrap — never a second gtag.js. Ids, the Sign-up conversion and
 * the Digby Kids exclusion: lib/google-ads.ts.
 *
 * Loads after hydration, once the session is known: a visitor or an adult account loads it; a child session never
 * does. The decision is re-read on every route change, so a child who signs in after the tag loaded as a visitor
 * switches it off (ga-disable-<id>) for the rest of the visit.
 */
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Script from 'next/script';
import { disableGoogleAds, googleAdsAllowedForToken, googleAdsBootstrap, googleAdsTagDisabled, googleTagLoaderId } from '@/lib/google-ads';

function storedToken(): string | null {
  try { return localStorage.getItem('accessToken'); } catch { return null; }
}

export function GoogleAdsTag() {
  const pathname = usePathname();
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const ok = googleAdsAllowedForToken(storedToken());
    if (!ok) disableGoogleAds();
    // Once loaded the library stays; a session that later turns out to be a child only flips the disable flags.
    setAllowed((was) => was || ok);
  }, [pathname]);

  if (googleAdsTagDisabled() || !allowed) return null;
  return (
    <>
      <Script id="google-ads-gtag" src={`https://www.googletagmanager.com/gtag/js?id=${googleTagLoaderId()}`} strategy="afterInteractive" />
      <Script id="google-ads-gtag-init" strategy="afterInteractive">{googleAdsBootstrap()}</Script>
    </>
  );
}

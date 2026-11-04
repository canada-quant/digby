'use client';

/**
 * The site's ONE Meta Pixel (4660227547545860) — rendered by app/layout.tsx on every page, beside the Google tag.
 * Loads after hydration, once the session is known: a visitor or an adult account loads it; a Digby Kids session
 * never does, and a child who signs in after it loaded as a visitor revokes it for the rest of the visit. Ids, the
 * sign-up event and the rules: lib/meta-pixel.ts.
 */
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Script from 'next/script';
import { googleAdsAllowedForToken } from '@/lib/google-ads';
import { disableMetaPixel, metaPixelBootstrap, metaPixelDisabled, persistFbcFromUrl } from '@/lib/meta-pixel';

function storedToken(): string | null {
  try { return localStorage.getItem('accessToken'); } catch { return null; }
}

export function MetaPixel() {
  const pathname = usePathname();
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const ok = googleAdsAllowedForToken(storedToken());
    if (!ok) disableMetaPixel();
    // Meta ClickID: keep ?fbclid as the _fbc cookie even when Meta's script is blocked (lib/meta-pixel.ts).
    else persistFbcFromUrl();
    // Once loaded the library stays; a session that later turns out to be a child only revokes it.
    setAllowed((was) => was || ok);
  }, [pathname]);

  if (metaPixelDisabled() || !allowed) return null;
  return <Script id="meta-pixel" strategy="afterInteractive">{metaPixelBootstrap()}</Script>;
}

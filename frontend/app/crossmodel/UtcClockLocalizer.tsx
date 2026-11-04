'use client';

import { useEffect } from 'react';
import { startDomUtcLocalizer } from '@/lib/dom-utc-localizer';

/**
 * Shows every UTC clock in the app ("· idle since 17:39Z", "Live snapshot as of 14:41Z", ISO stamps) in the viewer's
 * own time zone — see lib/dom-utc-localizer.ts. Starts after hydration so server and client markup still match.
 */
export default function UtcClockLocalizer() {
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    return startDomUtcLocalizer(document.documentElement);
  }, []);
  return null;
}

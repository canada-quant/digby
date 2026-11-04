'use client';

/**
 * First-party visitor analytics (owner 2026-10-07) — rendered ONCE by app/layout.tsx on every page, beside the
 * Google tag. On the first render of a page load it records the LANDING (first / last-touch attribution + the
 * visitor id); on every route change a page_view; when the page hides it flushes the queue with sendBeacon.
 * Everything is gated in lib/visitor-analytics.ts: never a Digby Kids session (the Google tag's fail-closed token
 * read, re-checked per event), NEXT_PUBLIC_VISITOR_ANALYTICS_DISABLED=1 turns it off at build time. Renders nothing.
 */
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { visitorCapture } from '@/lib/visitor-analytics';

export function VisitorAnalytics() {
  const pathname = usePathname();

  useEffect(() => {
    try {
      const cap = visitorCapture();
      if (!cap) return;
      cap.land();
      cap.track('page_view', undefined, pathname || '/');
    } catch { /* analytics never breaks the page */ }
  }, [pathname]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        try { visitorCapture()?.flush({ beacon: true }); } catch { /* ignore */ }
      }
    };
    const onPageHide = () => { try { visitorCapture()?.flush({ beacon: true }); } catch { /* ignore */ } };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  return null;
}

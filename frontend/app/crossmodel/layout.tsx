import type { Metadata } from 'next';
import InAppBrowser from './components/InAppBrowser';
import AppViewportVars from './AppViewportVars';
import UtcClockLocalizer from './UtcClockLocalizer';
import { DEFAULT_DESCRIPTION, DEFAULT_TITLE, OG_IMAGE, organizationLd, softwareApplicationLd, websiteLd } from '@/lib/site/seo';
import { SITE_URL } from '@/lib/site/content';
import { brandingFromEnv } from '@/lib/branding';

// The chat app is served at the ROOT (proxy.ts rewrites / → /crossmodel), so
// this metadata is the digby.ai home page's: the canonical is the bare domain
// (never /crossmodel — the old name; 2026-10-14 SEO pass, lib/site/seo.ts).
// Signed-in screens under this layout (account, files, …) are robots.txt-
// blocked, so the shared canonical never competes with them.
// Shared branding core (todo d2d32b57) — one resolution for this layout's
// openGraph block. NOTE the bug this replaces: `siteName` was left hard-coded
// to 'Digby' while lib/site/seo.ts already used branding.name for the same
// field, so a rebranded instance contradicted itself in its own metadata
// (independent review, 2026-11-05).
const branding = brandingFromEnv();

export const metadata: Metadata = {
  title: { absolute: DEFAULT_TITLE },
  description: DEFAULT_DESCRIPTION,
  alternates: { canonical: SITE_URL },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    siteName: branding.name,
    locale: 'en_CA',
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: `${branding.name} — ${branding.tagline}` }],
  },
  twitter: { card: 'summary_large_image', title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION, images: [OG_IMAGE] },
};

const HOME_JSON_LD = JSON.stringify([organizationLd(), websiteLd(), softwareApplicationLd()]).replace(/</g, '\\u003c');

export default function CrossModelLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: HOME_JSON_LD }} />
      {/* Pins --app-height/--app-top (visual viewport) for EVERY /crossmodel
          route — the chat shell, instances, profile, and all drawer surfaces
          read these vars (UI overhaul Phase 1: hoisted from page.tsx). */}
      <AppViewportVars />
      {/* Every UTC clock on screen ("· idle since 17:39Z") in the viewer's own time zone (owner 2026-10-16). */}
      <UtcClockLocalizer />
      {children}
      {/* In the installed app (standalone), external links open in this in-app
          browser overlay (Back-to-Digby chrome) instead of hijacking the window. */}
      <InAppBrowser />
    </>
  );
}

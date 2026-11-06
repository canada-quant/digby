import type { Metadata, Viewport } from 'next';
import { preload } from 'react-dom';
import './fonts.css';
import './globals.css';
import { Providers } from './providers';
import { BrandingProvider } from './branding/BrandingProvider';
import { PWAInstallPrompt } from '../src/components/PWAInstallPrompt';
import { UpdateNotification } from '../src/components/UpdateNotification';
import { GoogleAdsTag } from './GoogleAdsTag';
import { VisitorAnalytics } from './VisitorAnalytics';
import { ClientErrorReporter } from './ClientErrorReporter';
import { MetaPixel } from './MetaPixel';
import { brandingFromEnv } from '@/lib/branding';

// Digby Frontier type system (2026-10-06 redesign): Geist is the UI sans,
// Newsreader the serif for headings + assistant answers, Geist Mono for model
// ids and code. Self-hosted since 2026-10-20 (app/fonts.css + public/fonts/ —
// the exact files and rules next/font/google generated), so the production
// build never fetches Google Fonts. `.dg-font-vars` sets the CSS variables
// globals.css maps onto --font-sans / --font-serif / --font-mono (`font-serif`,
// `font-mono` utilities); `.dg-font-text` is the body face.
// The latin files next/font preloaded: Geist, Newsreader (normal + italic),
// Geist Mono.
const PRELOADED_FONTS = [
  '/fonts/caa3a2e1cccd8315.woff2',
  '/fonts/d38f3bca7db33566.woff2',
  '/fonts/2b7d3311b69a4dca.woff2',
  '/fonts/797e433ab948586e.woff2',
];

// Branding is resolved ONCE per build (the root layout is a static route) from
// DIGBY_BRAND_* (lib/branding — the shared branding core, todo d2d32b57). With
// nothing set every value below is byte-identical to the shipped Digby
// identity, which is why the P7 pins (app/p7-pwa-pins.test.ts) still hold.
const branding = brandingFromEnv();

export const viewport: Viewport = {
  // Browser-chrome color per scheme, matching the real app backgrounds
  // (globals.css: light --bg = white, dark --bg = oklch(0.205 0 0)).
  // The manifest carries the light value — it only supports one.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: branding.theme.light },
    { media: '(prefers-color-scheme: dark)', color: branding.theme.dark },
  ],
  width: 'device-width',
  initialScale: 1,
  // Pinch-zoom stays ENABLED (WCAG 1.4.4; owner-approved, UI overhaul
  // Phase 1) — do not cap the scale or turn user scaling back off.
  // Double-tap zoom is separately disabled via `touch-action: manipulation`
  // on the html/body base layer in globals.css (ticket d0624b13, owner
  // question oq_48632205, 2026-09-15) — that is the sanctioned lever; keep
  // pinch gestures working here.
  viewportFit: 'cover',
  // Resize the layout viewport when the software keyboard opens (Chromium;
  // inert on iOS Safari) — keeps the composer reachable now that the app shell
  // is `fixed inset-0` (UI chrome redesign, 2026-07-24).
  interactiveWidget: 'resizes-content',
};

/** A rebranded instance links the DYNAMIC manifest (identical base document,
 *  operator name/icons/colours on top). The shipped identity keeps the static
 *  file — its installed-app id and P7 pins must never move. */
const MANIFEST_HREF = branding.isDefault ? '/manifest.json' : '/branding/manifest';

export const metadata: Metadata = {
  // metadataBase: every relative canonical / Open Graph URL resolves on the
  // production domain (2026-10-14 SEO pass — lib/site/seo.ts).
  metadataBase: new URL('https://digby.ai'),
  title: { default: branding.title, template: '%s' },
  description: branding.description,
  applicationName: branding.name,
  manifest: MANIFEST_HREF,
  appleWebApp: {
    capable: true,
    // 'default' (owner 2026-09-16, iPhone 15 Pro Max on iOS 26): with
    // black-translucent iOS sized the Home Screen app's viewport to the
    // screen MINUS the status-bar band (873 of 932pt) yet anchored it at the
    // physical top, leaving a 59pt strip at the bottom that no CSS can paint
    // (the drawer, backdrop and composer all stopped at 873 while
    // --app-height read 932px). 'default' anchors the web view BELOW the
    // status bar, so the same 873pt viewport ends flush at the screen edge;
    // the status-bar band takes the per-scheme theme-color above.
    statusBarStyle: 'default',
    title: branding.shortName,
    startupImage: [
      branding.assets.appleTouchIcon,
    ],
  },
  icons: {
    icon: [
      { url: branding.assets.favicon16, sizes: '16x16', type: 'image/png' },
      { url: branding.assets.favicon32, sizes: '32x32', type: 'image/png' },
      { url: branding.assets.icon192, sizes: '192x192', type: 'image/png' },
      { url: branding.assets.icon512, sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: branding.assets.appleTouchIcon, sizes: '180x180', type: 'image/png' },
    ],
    shortcut: branding.assets.favicon32,
  },
  other: {
    'mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-status-bar-style': 'default',
    'apple-mobile-web-app-title': branding.shortName,
    'application-name': branding.name,
    'msapplication-TileColor': branding.theme.dark,
    'msapplication-TileImage': branding.assets.icon192,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // ReactDOM.preload dedupes by href and hoists into <head> (what next/font did).
  for (const href of PRELOADED_FONTS) preload(href, { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
  return (
    <html
      lang="en-CA"
      suppressHydrationWarning
      className="dg-font-vars"
    >
      <head>
        <link rel="manifest" href={MANIFEST_HREF} />
        <link rel="apple-touch-icon" href={branding.assets.icon192} />
        <link rel="apple-touch-icon" sizes="152x152" href="/icons/icon-152x152.png" />
        <link rel="apple-touch-icon" sizes="180x180" href={branding.assets.appleTouchIcon} />
        <link rel="apple-touch-icon" sizes="167x167" href="/icons/icon-167x167.png" />
        <link rel="icon" type="image/png" sizes="32x32" href={branding.assets.favicon32} />
        <link rel="icon" type="image/png" sizes="16x16" href={branding.assets.favicon16} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content={branding.shortName} />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="application-name" content={branding.name} />
        {/* theme-color meta comes from `viewport.themeColor` above — do not
            add a raw theme-color meta tag here (a second, unqualified tag
            overrides the media-queried pair in some browsers). */}
        {/* iOS Splash Screens */}
        <link rel="apple-touch-startup-image" href="/splash-2048x2732.png" media="(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2)" />
        <link rel="apple-touch-startup-image" href="/splash-1668x2388.png" media="(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2)" />
        <link rel="apple-touch-startup-image" href="/splash-1536x2048.png" media="(device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2)" />
        <link rel="apple-touch-startup-image" href="/splash-1125x2436.png" media="(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)" />
        <link rel="apple-touch-startup-image" href="/splash-1242x2688.png" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3)" />
        <link rel="apple-touch-startup-image" href="/splash-828x1792.png" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2)" />
        <link rel="apple-touch-startup-image" href="/splash-750x1334.png" media="(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)" />
        <link rel="apple-touch-startup-image" href="/splash-640x1136.png" media="(device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2)" />
      </head>
      <body className="dg-font-text font-sans text-[14px] antialiased">
        <a href="#main" className="skip-link">Skip to content</a>
        <BrandingProvider value={branding}>
          <Providers>{children}</Providers>
          {/* EVERY branding consumer must sit INSIDE the provider (review
              2026-11-05): the context default is the shipped Digby identity,
              so a consumer rendered outside it silently misbrands on a
              rebranded instance instead of crashing — the failure mode a test
              cannot catch. Keep new overlays inside this element. */}
          <PWAInstallPrompt />
        </BrandingProvider>
        <UpdateNotification />
        {/* The site's ONE Google tag (GA4 G-NK7XPHC7FE + Google Ads AW-16512038948 and its Page view / Sign-up
            conversions) — every page, never a Digby Kids session (app/GoogleAdsTag.tsx, lib/google-ads.ts). */}
        <GoogleAdsTag />
        {/* First-party visitor analytics (owner 2026-10-07): visitor id + first / last-touch traffic source + page views
            → Account → Admin → Users & traffic. Same Digby Kids exclusion as the Google tag (lib/visitor-analytics.ts). */}
        <VisitorAnalytics />
        {/* Client UI error capture (ticket d4e643a5, owner on 81b229e1: "you should;d be capturing all these ui errors
            somewhere and auto filing tickets"): installs window.onerror + unhandledrejection → POST /client-error →
            app_error_logs (source 'client-error') → the EXISTING hourly log-signal-sweep auto-files the ticket.
            User text and credential shapes are scrubbed in the tab (lib/client-error-reporter.ts) and again on the
            server. NEXT_PUBLIC_CLIENT_ERROR_REPORT_DISABLED=1 turns it off at build time. Renders nothing. */}
        <ClientErrorReporter />
        {/* The site's ONE Meta Pixel (4660227547545860) — same never-for-Digby-Kids rule (app/MetaPixel.tsx). */}
        <MetaPixel />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js').then(function(registration) {
                    console.log('SW registered:', registration.scope);
                  }).catch(function(err) {
                    console.log('SW registration failed:', err);
                  });
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}

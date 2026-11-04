import type { Metadata, Viewport } from 'next';
import { preload } from 'react-dom';
import './fonts.css';
import './globals.css';
import { Providers } from './providers';
import { PWAInstallPrompt } from '../src/components/PWAInstallPrompt';
import { UpdateNotification } from '../src/components/UpdateNotification';
import { GoogleAdsTag } from './GoogleAdsTag';
import { VisitorAnalytics } from './VisitorAnalytics';
import { MetaPixel } from './MetaPixel';

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

export const viewport: Viewport = {
  // Browser-chrome color per scheme, matching the real app backgrounds
  // (globals.css: light --bg = white, dark --bg = oklch(0.205 0 0)).
  // The manifest carries the light value (#ffffff) — it only supports one.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    // Frontier dark --bg = oklch(0.205 0 0) ≈ #171717.
    { media: '(prefers-color-scheme: dark)', color: '#171717' },
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

export const metadata: Metadata = {
  // metadataBase: every relative canonical / Open Graph URL resolves on the
  // production domain (2026-10-14 SEO pass — lib/site/seo.ts).
  metadataBase: new URL('https://digby.example.com'),
  title: { default: 'Digby — Private, Canadian AI Assistant', template: '%s' },
  description: 'Digby is a Canadian AI assistant: open-weight AI models running on Canadian hardware, your chats, memory and files stored in Canada, live web search, and double-checked answers.',
  applicationName: 'Digby',
  manifest: '/manifest.json',
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
    title: 'Digby',
    startupImage: [
      '/apple-touch-icon.png',
    ],
  },
  icons: {
    icon: [
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
    shortcut: '/favicon-32x32.png',
  },
  other: {
    'mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-status-bar-style': 'default',
    'apple-mobile-web-app-title': 'Digby',
    'application-name': 'Digby',
    'msapplication-TileColor': '#171717',
    'msapplication-TileImage': '/icon-192x192.png',
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
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/icon-192x192.png" />
        <link rel="apple-touch-icon" sizes="152x152" href="/icons/icon-152x152.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="apple-touch-icon" sizes="167x167" href="/icons/icon-167x167.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Digby" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="application-name" content="Digby" />
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
        <Providers>{children}</Providers>
        <PWAInstallPrompt />
        <UpdateNotification />
        {/* The site's ONE Google tag (GA4 G-NK7XPHC7FE + Google Ads AW-00000000000 and its Page view / Sign-up
            conversions) — every page, never a Digby Kids session (app/GoogleAdsTag.tsx, lib/google-ads.ts). */}
        <GoogleAdsTag />
        {/* First-party visitor analytics (owner 2026-10-07): visitor id + first / last-touch traffic source + page views
            → Account → Admin → Users & traffic. Same Digby Kids exclusion as the Google tag (lib/visitor-analytics.ts). */}
        <VisitorAnalytics />
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

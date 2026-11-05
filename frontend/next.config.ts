import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    // The `http://localhost` pattern was removed 2026-10-12 (credential-incident
    // hardening): Next's private-IP check already blocked it, so it only widened
    // the optimizer's allow-list. Keep this list to hosts whose DNS we control.
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'digby.ai',
      },
    ],
  },
  typescript: {
    // Production builds MUST be type-clean (audit Phase 0, 2026-09-07). This was
    // `true`, silently shipping type errors; CI runs tsc clean so the gate costs
    // nothing when the codebase is healthy. Pinned by app/phase0-ui-pins.test.ts.
    ignoreBuildErrors: false,
  },
  // Baseline security headers (2026-07-21 pre-launch audit). These are the safe,
  // non-breaking set: clickjacking protection, MIME sniffing off, referrer
  // trimming, and locking down powerful features. A full script-src CSP is a
  // deliberate follow-up (needs per-request nonces for the inline service-worker
  // script + AdSense) so it doesn't break the live app.
  // Legacy /crossmodel/* legal pages moved to clean top-level routes
  // (2026-10-14 — "crossmodel was the old name"). proxy.ts 308s every other
  // legacy /crossmodel document URL; these two also cover client navigations
  // because the pages no longer exist under app/crossmodel.
  async redirects() {
    return [
      { source: '/crossmodel/privacy', destination: '/privacy', permanent: true },
      { source: '/crossmodel/terms', destination: '/terms', permanent: true },
    ];
  },
  async headers() {
    return [
      // Self-hosted fonts (app/fonts.css): files are named by content hash, so
      // they cache like /_next/static/media did under next/font/google.
      {
        source: '/fonts/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // microphone=(self): first-party only — the voice composer fallback path
          // (use-voice-composer.ts getUserMedia, Firefox + the Mac app) needs it;
          // the old empty allowlist hard-blocked getUserMedia app-wide.
          // Cross-origin frames stay denied. (audit Phase 0, 2026-09-07)
          { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(self), camera=(), payment=()' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;

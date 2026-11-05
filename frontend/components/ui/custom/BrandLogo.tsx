'use client';

/**
 * The brand mark, from the shared branding core (todo d2d32b57).
 *
 * Three things every consumer used to hand-roll, now in ONE place:
 *  - the light/dark variant (an operator may ship a white-on-dark logo and a
 *    dark-on-light one; `logoForScheme` picks, falling back to the plain logo);
 *  - the missing-file fallback: if an operator's asset 404s, the image swaps
 *    to the shipped Digby mark so a page never renders a broken-image box;
 *  - an accessible name that follows the branding (`logoAlt`, defaulting to
 *    the product name).
 *
 * TWO TRAPS this component exists to get right (independent review,
 * 2026-11-05 — both were live defects in the first cut):
 *  1. The scheme must be derived on EVERY render, never captured in
 *     `useState`'s one-shot initialiser: `resolvedTheme` is `undefined` on the
 *     first render (next-themes mounts after hydration), so a captured value
 *     is permanently the LIGHT variant — a dark-mode visitor, or anyone
 *     toggling the theme, would never see `logoDark`.
 *  2. An operator SVG cannot go through `next/image` (next.config.ts does not
 *     set `dangerouslyAllowSVG`, so the optimizer answers 400). `logoIsRaster`
 *     routes an SVG to a plain `<img>` instead, which the asset route serves
 *     with a locked-down CSP.
 */
import { useState } from 'react';
import Image from 'next/image';
import { useTheme } from 'next-themes';
import { DEFAULT_BRANDING, logoForScheme, logoIsRaster } from '@/lib/branding';
import { useBranding } from '@/app/branding/BrandingProvider';

export function BrandLogo({
  size = 32,
  compact = false,
  className,
  priority,
  alt,
}: {
  /** Square edge in px. */
  size?: number;
  /** Use the compact mark (sidebar row, install prompt) instead of the full logo. */
  compact?: boolean;
  className?: string;
  priority?: boolean;
  /** Accessible text; defaults to the branding's `logoAlt`. Pass '' for decorative. */
  alt?: string;
}) {
  const branding = useBranding();
  const { resolvedTheme } = useTheme();
  // Derived every render — see trap 1 above.
  const configured = compact
    ? branding.assets.logoCompact
    : logoForScheme(branding, resolvedTheme === 'dark' ? 'dark' : 'light');
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  // The failure fallback is per-source: a broken light logo must not suppress
  // a valid dark one after a theme switch.
  const src = failedSrc === configured ? DEFAULT_BRANDING.assets.logo : configured;
  const accessibleName = alt ?? branding.logoAlt;

  if (!logoIsRaster(src)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={accessibleName}
        width={size}
        height={size}
        draggable={false}
        onError={() => {
          if (src !== DEFAULT_BRANDING.assets.logo) setFailedSrc(src);
        }}
        className={className}
      />
    );
  }

  return (
    <Image
      src={src}
      alt={accessibleName}
      width={size}
      height={size}
      priority={priority}
      draggable={false}
      onError={() => {
        // Never loop: the Digby mark is the last step.
        if (src !== DEFAULT_BRANDING.assets.logo) setFailedSrc(src);
      }}
      className={className}
    />
  );
}
'use client';

/**
 * The brand spinner as a bare image (todo d2d32b57) — the shared mechanism
 * behind DigbyLoader and the chat hero.
 *
 * A plain `<img>` on purpose: `next/image` re-encodes a GIF and kills the
 * animation.
 *
 * The fallback is a real LADDER, not one step (independent review 2026-11-05:
 * the docs promised "static twin, then the shipped Digby mark" while the code
 * stopped at the static twin — and because `spinnerStatic` defaults to the
 * operator's own logo, an operator pointing both knobs at missing files got a
 * broken-image box). Order:
 *   1. the animated spinner (or the static twin under reduced motion);
 *   2. the static twin, if the animated asset 404s;
 *   3. the SHIPPED Digby mark, so a page never renders an empty box.
 */
import { useState } from 'react';
import { DEFAULT_BRANDING } from '@/lib/branding';
import { useBranding } from '@/app/branding/BrandingProvider';
import { usePrefersReducedMotion } from '@/hooks/use-prefers-reduced-motion';

export function BrandSpinner({
  size = 28,
  className,
  alt = '',
}: {
  /** Square edge in px. */
  size?: number;
  className?: string;
  /** Accessible text. Defaults to '' — the spinner is usually decorative and
   *  the surrounding status text carries the meaning. */
  alt?: string;
}) {
  const branding = useBranding();
  const reducedMotion = usePrefersReducedMotion();
  const shipped = DEFAULT_BRANDING.assets.spinnerStatic;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const preferred = reducedMotion ? branding.assets.spinnerStatic : branding.assets.spinner;
  // Ladder: preferred → static twin → shipped mark. `failedSrc` records what
  // already 404'd so a 404 never loops back to the same URL.
  const steps = [preferred, branding.assets.spinnerStatic, shipped];
  const src = steps.find((s) => s && s !== failedSrc) ?? shipped;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      draggable={false}
      onError={() => {
        // Advance one rung; the shipped mark is the last and is never skipped
        // past (if IT fails there is nothing left to try).
        if (src !== shipped) setFailedSrc(src);
      }}
      className={className}
      data-brand-spinner={reducedMotion ? 'static' : 'animated'}
    />
  );
}
'use client';

import { cn } from '@/lib/utils';
import { BrandSpinner } from '@/components/ui/custom/BrandSpinner';

/**
 * The brand loader (owner request, ticket 38f5403f; corrected 2026-08-22;
 * operator-brandable 2026-11-05, todo d2d32b57):
 * the ANIMATED asset's propeller already spins — the mark itself must never
 * rotate. The only motion we add is a tiny slow vertical float (owner:
 * "it just needs to float up and down a tiny bit").
 *
 * The asset, the `prefers-reduced-motion` static twin and the missing-file
 * fallback all live in BrandSpinner (the shared branding core); this wrapper
 * only adds the status role + the float class.
 */
export function DigbyLoader({
  size = 28,
  className,
  label = 'Loading',
}: {
  /** Square edge in px (the hat scales to fit). Owner 2026-08-24 (98853f4f): bigger
      everywhere — chat loading stage ~2x (22→44), chat surfaces larger, default 24→28. */
  size?: number;
  className?: string;
  /** Accessible status label. */
  label?: string;
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn('digby-loader inline-flex items-center justify-center shrink-0', className)}
      style={{ width: size, height: size }}
    >
      <BrandSpinner size={size} className="h-full w-full object-contain select-none pointer-events-none" />
      {/* Float keyframes live in globals.css (.digby-loader — P4): a style
          tag here injected one duplicate copy per mounted loader. */}
    </span>
  );
}

'use client';

import { cn } from '@/lib/utils';

/**
 * The Digby hat loader (owner request, ticket 38f5403f; corrected 2026-08-22):
 * the ANIMATED GIF's propeller already spins — the hat itself must never
 * rotate. The only motion we add is a tiny slow vertical float (owner:
 * "it just needs to float up and down a tiny bit"). Falls back to the static
 * /digbyhat.png when the gif asset is absent (onError swap), so the loader
 * degrades gracefully on deploys that predate the asset. prefers-reduced-motion
 * disables the float (the gif's own propeller animation remains).
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
      {/* Plain <img>: next/image would re-encode the gif and kill the propeller animation. */}
      {/* /digbyspin.gif is the OWNER'S original animated hat (52 frames, uploaded
          2026-08-22) — the generated stand-in was retired the moment it landed. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/digbyspin.gif"
        alt=""
        width={size}
        height={size}
        draggable={false}
        onError={(e) => {
          const img = e.currentTarget;
          if (!img.src.endsWith('/digbyhat.png')) img.src = '/digbyhat.png';
        }}
        className="h-full w-full object-contain select-none pointer-events-none"
      />
      {/* Float keyframes live in globals.css (.digby-loader — P4): a style
          tag here injected one duplicate copy per mounted loader. */}
    </span>
  );
}

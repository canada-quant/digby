'use client';

import { useEffect, useState } from 'react';

/**
 * Rotating hero tagline for the logged-out home screen (owner request
 * 2026-08-31): cycles the Canadian-flavoured one-liners every few seconds
 * with a soft fade/slide on each swap. prefers-reduced-motion shows the
 * swaps without animation. No aria-live — announcing every rotation would
 * spam screen readers; the current phrase is simply read as-is.
 */
const TAGLINES = [
  'Hosted on Canadian soil',
  'Sovereign. Secure. Yours.',
  'Writes. Codes. Creates.',
  'Eh-I, done right',
  'Polite, but powerful',
  'Double-double the productivity',
];

const ROTATE_MS = 3000;

export default function RotatingTagline() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % TAGLINES.length), ROTATE_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <h2 className="m-0 font-serif text-[clamp(28px,7vw,40px)] font-normal leading-[1.1] tracking-[-0.015em] text-balance text-ink">
      {/* key remounts per phrase so the entrance animation replays on each swap */}
      <span key={index} className="rotating-tagline-swap">
        {TAGLINES[index]}
      </span>
      <style>{`
        .rotating-tagline-swap {
          display: inline-block;
          animation: rotating-tagline-in 0.45s ease both;
        }
        @keyframes rotating-tagline-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .rotating-tagline-swap { animation: none; }
        }
      `}</style>
    </h2>
  );
}

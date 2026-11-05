'use client';

/**
 * `prefers-reduced-motion: reduce` as React state (todo d2d32b57).
 *
 * The CSS side of reduced motion (globals.css) only kills the CSS animations —
 * an ANIMATED GIF's own frames keep playing, so an operator's spinner needs a
 * real swap to its static twin. Renders `false` on the server and on first
 * client paint (matching SSR, so no hydration mismatch), then reads the media
 * query and follows it live.
 */
import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(QUERY);
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
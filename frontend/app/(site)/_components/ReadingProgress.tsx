'use client';

import { useEffect, useState } from 'react';

/**
 * Article reading progress (2026-10-16 redesign): a 2px bar on the bottom edge
 * of the sticky header, tracking the SITE scroll root (`[data-site-scroll]` —
 * body scrolling is off app-wide), not window. Renders nothing until it has
 * measured, so it is invisible without JS.
 */
export default function ReadingProgress() {
  const [p, setP] = useState<number | null>(null);

  useEffect(() => {
    const root = document.querySelector<HTMLElement>('[data-site-scroll]');
    if (!root) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const max = root.scrollHeight - root.clientHeight;
      setP(max > 0 ? Math.min(1, Math.max(0, root.scrollTop / max)) : 0);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    root.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      root.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  if (p === null) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5">
      <div className="h-full bg-send transition-[width] duration-100" style={{ width: `${(p * 100).toFixed(2)}%` }} />
    </div>
  );
}

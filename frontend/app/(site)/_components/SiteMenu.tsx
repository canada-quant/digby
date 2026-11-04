'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/**
 * The full-screen mobile menu's disclosure (2026-10-16 redesign). The menu is a
 * native <details>: its summary is the round menu button in the header and its
 * panel is a fixed full-screen overlay, so it opens and closes with no JS and
 * every link is server-rendered (the panel arrives as `children`). The summary
 * sits ABOVE the overlay (z-50 vs z-40) and turns into the × close button, so
 * closing works without JS too.
 *
 * Progressive enhancement only: Escape closes it, following a link or a route
 * change closes it (the header persists across client navigations, so the DOM
 * `open` state would otherwise survive), and the page behind stops scrolling
 * while it is open (the site scroll root is `[data-site-scroll]`, not window).
 */
export default function SiteMenu({ label, children }: { label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    const el = ref.current;
    if (el) el.open = false;
  }, [pathname]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.querySelector<HTMLElement>('[data-site-scroll]');
    const sync = () => {
      if (root) root.style.overflowY = el.open ? 'hidden' : '';
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && el.open) {
        el.open = false;
        el.querySelector('summary')?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest('a')) el.open = false;
    };
    el.addEventListener('toggle', sync);
    el.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('toggle', sync);
      el.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      if (root) root.style.overflowY = '';
    };
  }, []);

  return (
    <details ref={ref} className="group md:hidden">
      <summary
        aria-label={label}
        className="relative z-50 flex size-11 cursor-pointer list-none flex-col items-center justify-center gap-[5px] rounded-full border border-line-2 bg-background text-ink transition-colors hover:bg-hover [&::-webkit-details-marker]:hidden"
      >
        <span aria-hidden="true" className="block h-[1.5px] w-4 bg-current transition-transform duration-200 group-open:translate-y-[3.25px] group-open:rotate-45" />
        <span aria-hidden="true" className="block h-[1.5px] w-4 bg-current transition-transform duration-200 group-open:-translate-y-[3.25px] group-open:-rotate-45" />
      </summary>
      {children}
    </details>
  );
}

/**
 * Public site scroll root (about / features / Canada landing pages / learn /
 * legal). globals.css turns body scrolling off app-wide (the chat shell is
 * `fixed inset-0`), so this div IS the scroll container — the sticky header and
 * the sticky ask bar stick inside it, and the reading-progress bar + menu
 * scroll-lock find it by `data-site-scroll`. The chrome itself is rendered per
 * page by <SiteShell> (_components/SiteShell.tsx) so it can follow the page's
 * language.
 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-site-scroll className="h-dvh overflow-y-auto flex flex-col bg-background text-ink">
      {children}
    </div>
  );
}

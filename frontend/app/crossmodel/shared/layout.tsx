import type { Metadata } from 'next';

// Shared chats / projects are public BY LINK, never for search (2026-10-14 SEO
// pass): keep them out of every index. robots.ts deliberately does NOT block
// /shared/ — a robots.txt block would hide this noindex from crawlers.
export const metadata: Metadata = {
  title: 'Shared conversation · Digby',
  robots: { index: false, follow: false },
};

export default function SharedLayout({ children }: { children: React.ReactNode }) {
  return children;
}

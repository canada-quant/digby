import type { Metadata } from 'next';
import { brandingFromEnv } from '@/lib/branding';

// Shared chats / projects are public BY LINK, never for search (2026-10-14 SEO
// pass): keep them out of every index. robots.ts deliberately does NOT block
// /shared/ — a robots.txt block would hide this noindex from crawlers.
// Shared branding core (todo d2d32b57): a rebranded instance names itself here.
const branding = brandingFromEnv();

export const metadata: Metadata = {
  title: `Shared conversation · ${branding.name}`,
  robots: { index: false, follow: false },
};

export default function SharedLayout({ children }: { children: React.ReactNode }) {
  return children;
}

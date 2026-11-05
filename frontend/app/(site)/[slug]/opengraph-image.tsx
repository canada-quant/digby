import { SITE_PAGES, getSitePage } from '@/lib/site/content';
import { OG_SIZE, renderOg } from '@/lib/site/og';
import { brandingFromEnv } from '@/lib/branding';

// Each landing page's own social card (2026-10-16 site review).
export const alt = `${brandingFromEnv().name} — ${brandingFromEnv().tagline}`;
export const size = OG_SIZE;
export const contentType = 'image/png';
export const dynamicParams = false;

export function generateStaticParams() {
  return SITE_PAGES.map((p) => ({ slug: p.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const page = getSitePage((await params).slug);
  return renderOg({ eyebrow: page?.eyebrow, title: page?.h1 ?? 'Private, Canadian AI.' });
}

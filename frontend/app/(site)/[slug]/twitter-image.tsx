import { SITE_PAGES, getSitePage } from '@/lib/site/content';
import { OG_SIZE, renderOg } from '@/lib/site/og';
import { brandingFromEnv } from '@/lib/branding';

// The same card for X / Twitter (file-based, so the hashed URL is right).
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

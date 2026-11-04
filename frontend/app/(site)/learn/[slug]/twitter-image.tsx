import { LEARN_ARTICLES, getLearnArticle } from '@/lib/site/content';
import { OG_SIZE, renderOg } from '@/lib/site/og';

// The same card for X / Twitter (file-based, so the hashed URL is right).
export const alt = 'A Digby guide';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const dynamicParams = false;

export function generateStaticParams() {
  return LEARN_ARTICLES.map((a) => ({ slug: a.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const a = getLearnArticle((await params).slug);
  return renderOg({ eyebrow: a ? `Guide · ${a.readMinutes} min read` : 'Guide', title: a?.h1 ?? 'Digby guides' });
}

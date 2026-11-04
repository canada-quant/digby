import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getHelpDocContent, getHelpDocMeta, getHelpManifest } from '@/lib/help-docs';
import { HelpDoc } from '../help-doc';

// Reads content/help from disk at request time (see ./page.tsx).
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const meta = getHelpDocMeta(slug);
  return { title: meta ? `${meta.title} — Digby Help` : 'Help — Digby' };
}

export default async function HelpDocPage({ params }: Params) {
  const { slug } = await params;
  const meta = getHelpDocMeta(slug);
  const content = meta ? getHelpDocContent(slug) : null;
  if (!meta || content == null) notFound();
  // Only slug/source cross the RSC boundary for the link rewriter.
  const docs = getHelpManifest().docs.map(({ slug: s, source }) => ({ slug: s, source }));
  return <HelpDoc meta={meta} content={content} docs={docs} />;
}

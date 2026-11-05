import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getHelpDocContent, getHelpDocMeta, getHelpManifest } from '@/lib/help-docs';
import { brandingFromEnv } from '@/lib/branding';
import { HelpDoc } from '../help-doc';

// Reads content/help from disk at request time (see ./page.tsx).
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const meta = getHelpDocMeta(slug);
  // Shared branding core (todo d2d32b57) — read per request (this route is
  // force-dynamic), so a rebranded instance names itself in every help title.
  const branding = brandingFromEnv();
  return { title: meta ? `${meta.title} — ${branding.name} Help` : `Help — ${branding.name}` };
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

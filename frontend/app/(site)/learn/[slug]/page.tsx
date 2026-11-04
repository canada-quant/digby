import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LEARN_ARTICLES, getLearnArticle } from '@/lib/site/content';
import { articleLd, breadcrumbLd, faqLd, learnArticleMetadata, organizationLd, websiteLd } from '@/lib/site/seo';
import { JsonLd } from '../../_components/SiteChrome';
import { SiteShell } from '../../_components/SiteShell';
import { ChatCta, FaqList, PromptCard, RelatedLinks, Sections } from '../../_components/ContentBlocks';
import { ProductShot } from '../../_components/ProductShot';

export const dynamicParams = false;

export function generateStaticParams() {
  return LEARN_ARTICLES.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const a = getLearnArticle((await params).slug);
  return a ? learnArticleMetadata(a) : {};
}

const fmt = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * A Learn guide (2026-10-16 redesign): "← Learn" back link, serif headline,
 * meta, serif lede, numbered sections in ONE reading column (articles read
 * best narrow on every screen), FAQ, prompt card, keep reading, closing CTA —
 * plus the reading-progress bar on the header.
 */
export default async function LearnArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const a = getLearnArticle((await params).slug);
  if (!a) notFound();
  const path = `/learn/${a.slug}`;
  const trail = [{ href: '/learn', label: 'Learn' }, { href: path, label: a.nav }];
  return (
    <SiteShell path={path} askPlaceholder={a.askPlaceholder} progress>
      <article lang="en-CA" className="mx-auto w-full max-w-3xl px-5 pb-6 md:px-8">
        <JsonLd data={{ '@context': 'https://schema.org', '@graph': [organizationLd(), websiteLd(), breadcrumbLd(trail), articleLd(a), ...(a.faqs?.length ? [faqLd(a.faqs)] : [])] }} />
        <header className="dg-rise pt-5 pb-9 md:pt-12 md:pb-12">
          <Link href="/learn" className="inline-flex h-9 items-center font-mono text-[11px] uppercase tracking-[0.09em] text-ink-2 hover:text-ink">← Learn</Link>
          <h1 className="mt-3 font-serif text-[40px] font-normal leading-[0.98] tracking-[-0.02em] text-balance text-ink md:text-[56px]">{a.h1}</h1>
          <p className="mt-4 font-mono text-[12px] uppercase tracking-[0.06em] text-ink-3">
            Updated <time dateTime={a.updated}>{fmt(a.updated)}</time> · {a.readMinutes} min read
          </p>
          <p className="mt-6 font-serif text-[21px] leading-[1.3] text-ink md:text-[24px]">{a.lede}</p>
        </header>
        {a.shot ? <ProductShot shot={a.shot} className="mb-10" /> : null}
        <Sections sections={a.sections} layout="article" />
        {a.faqs?.length ? <FaqList faqs={a.faqs} title="Frequently asked questions" layout="article" /> : null}
        {a.prompts?.length ? <PromptCard prompts={a.prompts} layout="article" /> : null}
        <RelatedLinks slugs={a.related} layout="article" />
        <ChatCta layout="article" />
      </article>
    </SiteShell>
  );
}

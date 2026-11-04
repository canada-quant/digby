import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SITE_PAGES, getSitePage } from '@/lib/site/content';
import { pageGraphLd, sitePageMetadata } from '@/lib/site/seo';
import { siteStrings } from '@/lib/site/strings';
import { Breadcrumbs, JsonLd } from '../_components/SiteChrome';
import { SiteShell } from '../_components/SiteShell';
import { ChatCta, FaqList, Hero, MEASURE, PromptCard, RelatedLinks, Sections } from '../_components/ContentBlocks';
import { ProductShot } from '../_components/ProductShot';

/**
 * Every public landing page (about, features, private-ai, sovereign-ai, …) —
 * one template, one data entry each in lib/site/content.ts. Statically
 * generated; an unknown slug is a 404 (dynamicParams = false), so this root
 * segment never swallows a real route (static routes win in Next anyway).
 *
 * Block order (2026-10-16 redesign): Hero → product shot (when the page has one) → Sections → FAQ → Prompt card →
 * Keep reading → closing CTA → footer, with the sticky ask bar over all of it.
 *
 * Structured data (2026-10-29 SEO wave): the WHOLE graph — Organization,
 * WebSite, WebPage, BreadcrumbList, Service and (where the page shows Q&A)
 * FAQPage — comes from `pageGraphLd` in one @graph block. A new page in
 * content.ts inherits all of it with no template change.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return SITE_PAGES.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const page = getSitePage((await params).slug);
  return page ? sitePageMetadata(page) : {};
}

export default async function SiteLandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const page = getSitePage((await params).slug);
  if (!page) notFound();
  const path = `/${page.slug}`;
  const trail = [{ href: path, label: page.nav }];
  const t = siteStrings(page.lang);
  return (
    <SiteShell path={path} lang={page.lang} askPlaceholder={page.askPlaceholder}>
      <article className={`${MEASURE} pb-6`}>
        <JsonLd data={{ '@context': 'https://schema.org', '@graph': pageGraphLd(page, trail) }} />
        <Breadcrumbs trail={trail} />
        <Hero eyebrow={page.eyebrow} h1={page.h1} lede={page.lede} lang={page.lang} cta={page.cta} secondary={page.secondary} platformCta={page.platformCta} />
        {page.shot ? <ProductShot shot={page.shot} className="-mt-2 mb-10 md:mb-16" /> : null}
        <Sections sections={page.sections} />
        {page.faqs?.length ? <FaqList faqs={page.faqs} title={page.faqHeading === false ? null : t.faqTitle} /> : null}
        {page.prompts?.length ? <PromptCard prompts={page.prompts} lang={page.lang} /> : null}
        <RelatedLinks slugs={page.related} lang={page.lang} />
        <ChatCta lang={page.lang} />
      </article>
    </SiteShell>
  );
}

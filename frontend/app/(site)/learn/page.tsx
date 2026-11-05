import Link from 'next/link';
import { LEARN_TOPICS, learnArticlesForTopic } from '@/lib/site/content';
import { breadcrumbLd, organizationLd, pageMetadata, websiteLd } from '@/lib/site/seo';
import { two } from '@/lib/site/strings';
import { Breadcrumbs, JsonLd } from '../_components/SiteChrome';
import { SiteShell } from '../_components/SiteShell';
import { ChatCta, Hero, MEASURE } from '../_components/ContentBlocks';
import { brandingFromEnv } from '@/lib/branding';

// Shared branding core (todo d2d32b57): server component, resolved at build.
const BRANDING = brandingFromEnv();

export const metadata = pageMetadata({
  path: '/learn',
  title: `Learn — guides to private and sovereign AI in Canada · ${BRANDING.name}`,
  description: 'Plain-language guides on sovereign AI, data residency, open-weight models and using AI safely at work in Canada.',
  keywords: ['sovereign ai guide', 'private ai canada guide', 'ai data residency', 'open weight models'],
});

/**
 * Learn index (2026-10-16 redesign). Topic filters are plain links
 * (/learn?topic=privacy) filtered on the server — no JS needed; the canonical
 * stays /learn, so filtered views never compete with it in search.
 */
export default async function LearnIndexPage({ searchParams }: { searchParams: Promise<{ topic?: string | string[] }> }) {
  const raw = (await searchParams).topic;
  const { topic, articles } = learnArticlesForTopic(Array.isArray(raw) ? raw[0] : raw);
  const trail = [{ href: '/learn', label: 'Learn' }];
  const filters: { label: string; href: string; active: boolean }[] = [
    { label: 'All', href: '/learn', active: topic === null },
    ...LEARN_TOPICS.map((t) => ({ label: t, href: `/learn?topic=${t.toLowerCase()}`, active: topic === t })),
  ];
  return (
    <SiteShell path="/learn" askPlaceholder="Ask about AI in Canada…">
      <div className={`${MEASURE} pb-6`}>
        <JsonLd data={{ '@context': 'https://schema.org', '@graph': [organizationLd(), websiteLd(), breadcrumbLd(trail)] }} />
        <Breadcrumbs trail={trail} />
        <Hero
          eyebrow="Learn"
          h1="Guides to private & sovereign AI in Canada"
          lede="Plain-language explainers on where your AI data goes, what makes AI sovereign, and how to choose tools you can trust."
          cta="Ask Digby instead"
          secondary={null}
        />
        <nav aria-label="Topics" className="-mx-5 overflow-x-auto px-5 [scrollbar-width:none] md:mx-0 md:px-0 [&::-webkit-scrollbar]:hidden">
          <ul className="flex gap-2">
            {filters.map((f) => (
              <li key={f.label} className="shrink-0">
                <Link
                  href={f.href}
                  scroll={false}
                  aria-current={f.active ? 'page' : undefined}
                  className={`inline-flex h-[38px] items-center rounded-full border px-4 text-[14px] transition-colors ${f.active ? 'border-send bg-send text-send-ink' : 'border-line-2 text-ink hover:bg-hover'}`}
                >
                  {f.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <ul className="mt-4 md:mt-8">
          {articles.map((a, i) => (
            <li key={a.slug}>
              <Link
                href={`/learn/${a.slug}`}
                className="group grid grid-cols-[28px_minmax(0,1fr)] gap-x-2 border-b border-line py-5 lg:grid-cols-[56px_minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-x-10 lg:py-7"
              >
                <span className="pt-1.5 font-mono text-[11px] tracking-[0.06em] text-ink-3">{two(i + 1)}</span>
                <span className="font-serif text-[23px] leading-[1.02] tracking-[-0.01em] text-ink group-hover:underline group-hover:decoration-line-2 group-hover:underline-offset-4 lg:text-[30px]">{a.h1}</span>
                <span className="col-start-2 lg:col-start-3 lg:row-start-1">
                  <span className="mt-2 block text-[14.5px] leading-[1.5] text-ink-2 lg:mt-1 lg:text-[15.5px]">{a.description}</span>
                  <span className="mt-2.5 block font-mono text-[11.5px] uppercase tracking-[0.06em] text-ink-3">{a.topic} · {a.readMinutes} min read</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <ChatCta />
      </div>
    </SiteShell>
  );
}

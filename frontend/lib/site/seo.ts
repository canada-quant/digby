/**
 * Metadata + schema.org JSON-LD builders for the public site (pure — unit
 * tested in seo.test.ts). Every page gets: a canonical URL on digby.ai, Open
 * Graph + Twitter cards, and the structured data that fits it (Organization +
 * WebSite + SoftwareApplication on the home, BreadcrumbList everywhere,
 * FAQPage where a page has FAQs, Article on the guides).
 */
import type { Metadata } from 'next';
import { CONTACT_EMAIL, SITE_NAME, SITE_URL, type Faq, type LearnArticle, type SitePage } from './content';
import { pricingOfferDescription, pricingOfferPrice } from './pricing';
import { brandText, brandingFromEnv } from '@/lib/branding';

// Shared branding core (todo d2d32b57): a self-hosted operator's name /
// description / logo replace Digby's in every metadata + schema.org node.
// Nothing set ⇒ the shipped Digby strings, byte-identical to before.
const branding = brandingFromEnv();

export const DEFAULT_TITLE = branding.title;
export const DEFAULT_DESCRIPTION = branding.description;

/** The default social card (app/opengraph-image.tsx). Pages that set their own
 *  openGraph object must name it — a segment's metadata object replaces the
 *  inherited file-based image. */
export const OG_IMAGE = '/opengraph-image';

export const absoluteUrl = (path: string) => (path === '/' ? SITE_URL : `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`);

export function pageMetadata(args: {
  path: string;
  title: string;
  description: string;
  keywords?: string[];
  type?: 'website' | 'article';
  locale?: string;
  publishedTime?: string;
  modifiedTime?: string;
  /** hreflang alternates: BCP-47 → path (x-default included by the caller). */
  languages?: Record<string, string>;
  /** The segment ships its own opengraph-image + twitter-image files: leave
   *  `images` unset so Next's file-based tags (hashed URLs) win. */
  fileImages?: boolean;
}): Metadata {
  const url = absoluteUrl(args.path);
  const images = args.fileImages ? {} : { images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: `${branding.name} — ${branding.tagline}` }] };
  return {
    title: { absolute: args.title },
    description: args.description,
    keywords: args.keywords,
    alternates: {
      canonical: url,
      ...(args.languages ? { languages: Object.fromEntries(Object.entries(args.languages).map(([l, p]) => [l, absoluteUrl(p)])) } : {}),
    },
    openGraph: {
      type: args.type ?? 'website',
      url,
      title: args.title,
      description: args.description,
      siteName: branding.name,
      locale: (args.locale ?? 'en-CA').replace('-', '_'),
      ...images,
      ...(args.publishedTime ? { publishedTime: args.publishedTime } : {}),
      ...(args.modifiedTime ? { modifiedTime: args.modifiedTime } : {}),
    },
    twitter: { card: 'summary_large_image', title: args.title, description: args.description, ...(args.fileImages ? {} : { images: [OG_IMAGE] }) },
    robots: { index: true, follow: true },
  };
}

/** hreflang map for a page with a translation: both languages + x-default (English). */
export function pageLanguages(p: SitePage): Record<string, string> | undefined {
  if (!p.alternate) return undefined;
  const self = { lang: p.lang ?? 'en-CA', slug: p.slug };
  const pair = [self, p.alternate];
  const english = pair.find((x) => x.lang.startsWith('en')) ?? self;
  return { ...Object.fromEntries(pair.map((x) => [x.lang, `/${x.slug}`])), 'x-default': `/${english.slug}` };
}

export function sitePageMetadata(p: SitePage): Metadata {
  // Shared branding core (todo d2d32b57): these titles are DATA in content.ts,
  // not JSX, so a rebranded instance would otherwise ship "Digby features —…"
  // metadata with no way to change it short of editing source. brandText
  // rewrites the standalone product word and is a no-op on the shipped name.
  return pageMetadata({
    path: `/${p.slug}`, title: brandText(p.title, branding), description: brandText(p.description, branding), keywords: p.keywords, locale: p.lang,
    languages: pageLanguages(p), fileImages: true,
  });
}

export function learnArticleMetadata(a: LearnArticle): Metadata {
  return pageMetadata({
    path: `/learn/${a.slug}`, title: brandText(a.title, branding), description: brandText(a.description, branding), keywords: a.keywords,
    type: 'article', publishedTime: a.published, modifiedTime: a.updated, fileImages: true,
  });
}

/**
 * Public profiles for the Organization's `sameAs` (schema.org wants the entity's
 * OTHER homes: social, code, registry). Deliberately EMPTY until a profile is
 * confirmed real — a `sameAs` pointing at a handle we do not own hands the
 * entity to whoever does. The owner supplies these (Account → socials) and they
 * land here once, for every page.
 */
export const SAME_AS_PROFILES: string[] = [];

export function organizationLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: branding.name,
    url: SITE_URL,
    logo: `${SITE_URL}${branding.assets.icon512}`,
    email: CONTACT_EMAIL,
    areaServed: { '@type': 'Country', name: 'Canada' },
    // No street address: Digby publishes no registered office, and schema.org
    // `address` is a factual claim, not a branding field. Country + region of
    // operation is all that is true today ("Canadian HQ" in the org sense).
    address: { '@type': 'PostalAddress', addressCountry: 'CA' },
    knowsLanguage: ['en-CA', 'fr-CA'],
    contactPoint: [{
      '@type': 'ContactPoint',
      contactType: 'customer support',
      email: CONTACT_EMAIL,
      availableLanguage: ['en-CA', 'fr-CA'],
      areaServed: 'CA',
    }],
    description: DEFAULT_DESCRIPTION,
    ...(SAME_AS_PROFILES.length ? { sameAs: [...SAME_AS_PROFILES] } : {}),
  };
}

export function websiteLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    name: branding.name,
    url: SITE_URL,
    inLanguage: ['en-CA', 'fr-CA'],
    publisher: { '@id': `${SITE_URL}/#organization` },
  };
}

export function softwareApplicationLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: branding.name,
    url: SITE_URL,
    applicationCategory: 'ProductivityApplication',
    operatingSystem: 'Web, macOS, Windows, iOS, Android',
    // No `price` while the owner's pricing card is open (oq_88a750bc): a
    // schema Offer with price '0' IS a published $0 claim. One constant
    // (lib/site/pricing.ts) restores the money properties everywhere at once.
    offers: { '@type': 'Offer', ...pricingOfferPrice(), description: pricingOfferDescription() },
    description: DEFAULT_DESCRIPTION,
    publisher: { '@id': `${SITE_URL}/#organization` },
  };
}

export function breadcrumbLd(trail: { href: string; label: string }[]) {
  const items = [{ href: '/', label: branding.name }, ...trail];
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.label, item: absoluteUrl(t.href) })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-page schema (2026-10-29 SEO wave)
//
// One composer, `pageGraphLd`, so a NEW page in content.ts gets its schema for
// free — the page template renders whatever the composer returns. Shapes are
// the ones Google's Rich Results requires:
//  · Organization + WebSite   — once, on every page (referenced by @id)
//  · WebPage                  — the page itself, with its real lastmod + language
//  · BreadcrumbList           — trail from the chat home
//  · FAQPage                  — only where VISIBLE Q&A exists (Google penalises
//                               a FAQPage whose questions are not on the page)
//  · Service                  — the offer, for the product/compliance/vertical
//                               pages a buyer evaluates; carries our real
//                               Canadian-hardware + residency facts, never a
//                               certification we do not hold
// ─────────────────────────────────────────────────────────────────────────────

/** Service schema for the pages that sell the product (not for the guides). */
export function serviceLd(p: SitePage) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    '@id': `${absoluteUrl(`/${p.slug}`)}#service`,
    name: p.nav === SITE_NAME ? SITE_NAME : `${SITE_NAME} — ${p.nav}`,
    serviceType: 'AI assistant',
    description: p.description,
    url: absoluteUrl(`/${p.slug}`),
    provider: { '@id': `${SITE_URL}/#organization` },
    areaServed: { '@type': 'Country', name: 'Canada' },
    availableLanguage: ['en-CA', 'fr-CA'],
    // The offer line, derived from the owner's pricing decision in
    // lib/site/pricing.ts — never a hard-coded price. While the price is
    // unpublished the node carries NO `price` property at all: a schema Offer
    // with `price: '0'` IS a published $0 claim, machine-readable, and the
    // owner has not made it (oq_88a750bc is open). The day they answer, one
    // constant flips this node and every visible row together.
    offers: { '@type': 'Offer', ...pricingOfferPrice(), description: pricingOfferDescription() },
  };
}

export function webPageLd(p: SitePage) {
  const url = absoluteUrl(`/${p.slug}`);
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${url}#webpage`,
    url,
    name: p.title,
    description: p.description,
    inLanguage: p.lang ?? 'en-CA',
    dateModified: p.updated,
    isPartOf: { '@id': `${SITE_URL}/#website` },
    about: { '@id': `${SITE_URL}/#organization` },
    publisher: { '@id': `${SITE_URL}/#organization` },
  };
}

/**
 * The whole graph for one landing page, in dependency order. Pages that are not
 * a product offer (the guides, the legal pages) pass `service: false`.
 */
export function pageGraphLd(p: SitePage, trail: { href: string; label: string }[], opts: { service?: boolean } = {}) {
  const graph: unknown[] = [organizationLd(), websiteLd(), webPageLd(p), breadcrumbLd(trail)];
  if (opts.service === true || (opts.service !== false && SERVICE_PAGE_GROUPS.includes(p.group))) graph.push(serviceLd(p));
  if (p.faqs?.length) graph.push(faqLd(p.faqs));
  return graph;
}

/** The groups whose pages describe the product offer itself. */
export const SERVICE_PAGE_GROUPS: SitePage['group'][] = ['product', 'canada', 'compare', 'local'];

export function faqLd(faqs: Faq[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  };
}

export function articleLd(a: LearnArticle) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.h1,
    description: a.description,
    datePublished: a.published,
    dateModified: a.updated,
    mainEntityOfPage: absoluteUrl(`/learn/${a.slug}`),
    author: { '@id': `${SITE_URL}/#organization` },
    publisher: { '@id': `${SITE_URL}/#organization` },
    image: `${SITE_URL}/opengraph-image`,
    inLanguage: 'en-CA',
  };
}

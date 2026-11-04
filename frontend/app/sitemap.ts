import type { MetadataRoute } from 'next';
import { LEARN_ARTICLES, SITE_PAGES } from '@/lib/site/content';
import { absoluteUrl, pageLanguages } from '@/lib/site/seo';

/**
 * /sitemap.xml — every public, indexable page (lib/site/content.ts is the
 * source). `lastModified` is each page's REAL last content change (2026-10-16
 * site review: it used to be the request time on every URL, which teaches
 * search engines to ignore it). Translated pages carry their hreflang pair.
 */
const SITE_UPDATED = '2026-10-16';
const LEGAL_UPDATED = '2026-10-14';
const PRIVACY_UPDATED = '2026-10-16'; // §3–§4: no training on user content, every model in Canada
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
const latest = (dates: string[]) => dates.reduce((a, b) => (b > a ? b : a), SITE_UPDATED);

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: absoluteUrl('/'), lastModified: day(SITE_UPDATED), changeFrequency: 'weekly', priority: 1 },
    ...SITE_PAGES.map((p) => {
      const languages = pageLanguages(p);
      return {
        url: absoluteUrl(`/${p.slug}`),
        lastModified: day(p.updated),
        changeFrequency: 'monthly' as const,
        priority: p.group === 'canada' ? 0.9 : p.group === 'compare' ? 0.8 : p.group === 'local' ? 0.6 : 0.7,
        ...(languages ? { alternates: { languages: Object.fromEntries(Object.entries(languages).map(([l, path]) => [l, absoluteUrl(path)])) } } : {}),
      };
    }),
    { url: absoluteUrl('/learn'), lastModified: day(latest(LEARN_ARTICLES.map((a) => a.updated))), changeFrequency: 'weekly', priority: 0.7 },
    ...LEARN_ARTICLES.map((a) => ({
      url: absoluteUrl(`/learn/${a.slug}`),
      lastModified: day(a.updated),
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
    { url: absoluteUrl('/privacy'), lastModified: day(PRIVACY_UPDATED), changeFrequency: 'yearly', priority: 0.3 },
    { url: absoluteUrl('/terms'), lastModified: day(LEGAL_UPDATED), changeFrequency: 'yearly', priority: 0.3 },
  ];
}

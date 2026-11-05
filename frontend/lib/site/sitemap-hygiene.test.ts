import { describe, it, expect } from 'vitest';
import sitemap from '@/app/sitemap';
import robots from '@/app/robots';
import { SITE_URL, SITE_PAGES, LEARN_ARTICLES, publicPaths } from '@/lib/site/content';
import { absoluteUrl, pageLanguages, sitePageMetadata, learnArticleMetadata } from '@/lib/site/seo';

/**
 * Canonical / hreflang / sitemap / robots hygiene pins (goal 252a1d17,
 * todo f5b8ae2b).
 *
 * These assert the properties a crawler actually relies on, so a future page or
 * a future refactor cannot silently break indexation:
 *   · every indexable URL in the sitemap corresponds to a real page (and vice versa)
 *   · every page self-canonicals to its own absolute digby.ai URL
 *   · every hreflang pair is RECIPROCAL and carries x-default
 *   · robots.txt points at the sitemap and never blocks an indexable page
 *   · no duplicate title or description can reach a crawler
 */

const entries = sitemap();

describe('sitemap', () => {
  it('lists exactly the public paths — nothing missing, nothing invented', () => {
    const listed = new Set(entries.map((e) => e.url));
    const expected = new Set(publicPaths().map((p) => absoluteUrl(p)));
    expect([...expected].filter((u) => !listed.has(u)), 'public paths absent from sitemap').toEqual([]);
    expect([...listed].filter((u) => !expected.has(u)), 'sitemap URLs with no page').toEqual([]);
  });

  it('never emits a duplicate URL', () => {
    const urls = entries.map((e) => e.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('every entry carries a real lastmod and an in-range priority', () => {
    for (const e of entries) {
      expect(e.lastModified, e.url).toBeTruthy();
      const d = new Date(e.lastModified as string | Date);
      expect(Number.isNaN(d.getTime()), e.url).toBe(false);
      // A future lastmod teaches crawlers the feed is untrustworthy.
      expect(d.getTime() <= Date.now() + 86_400_000, `${e.url} lastmod is in the future`).toBe(true);
      expect(e.priority, e.url).toBeGreaterThan(0);
      expect(e.priority, e.url).toBeLessThanOrEqual(1);
    }
  });

  it('priorities follow the site hierarchy', () => {
    const pri = (path: string) => entries.find((e) => e.url === absoluteUrl(path))!.priority!;
    expect(pri('/')).toBe(1);
    // Country-level pages outrank the city layer; a city page must never
    // outrank its own hub.
    expect(pri('/industries')).toBeGreaterThan(pri('/ai-legal-toronto'));
    expect(pri('/ai-legal-toronto')).toBeLessThan(pri('/private-ai'));
    expect(pri('/privacy')).toBeLessThan(pri('/ai-legal-toronto'));
  });

  it('all absolute on the canonical origin, no trailing slash, no legacy path', () => {
    for (const e of entries) {
      expect(e.url, e.url).toMatch(/^https:\/\/digby\.ai(\/[a-z0-9-]+)*$/);
      if (e.url !== SITE_URL) expect(e.url.endsWith('/'), e.url).toBe(false);
      expect(e.url, e.url).not.toContain('/crossmodel');
    }
  });

  it('carries hreflang alternates for every translated page', () => {
    for (const p of SITE_PAGES.filter((x) => x.alternate)) {
      const e = entries.find((x) => x.url === absoluteUrl(`/${p.slug}`))!;
      const langs = (e.alternates?.languages ?? {}) as Record<string, string>;
      expect(Object.keys(langs).sort(), p.slug).toEqual(['en-CA', 'fr-CA', 'x-default']);
    }
  });
});

describe('canonical', () => {
  it('every landing page canonicals to its own absolute URL', () => {
    for (const p of SITE_PAGES) {
      const md = sitePageMetadata(p);
      expect(md.alternates?.canonical, p.slug).toBe(absoluteUrl(`/${p.slug}`));
    }
  });

  it('every guide canonicals to its own absolute URL', () => {
    for (const a of LEARN_ARTICLES) {
      const md = learnArticleMetadata(a);
      expect(md.alternates?.canonical, a.slug).toBe(absoluteUrl(`/learn/${a.slug}`));
    }
  });

  it('no page is canonicalised onto another page (no canonical collisions)', () => {
    const canonicals = [...SITE_PAGES.map((p) => sitePageMetadata(p)), ...LEARN_ARTICLES.map((a) => learnArticleMetadata(a))].map(
      (m) => m.alternates!.canonical as string,
    );
    expect(new Set(canonicals).size).toBe(canonicals.length);
  });

  it('every page is indexable (robots meta is not blocking a public page)', () => {
    for (const p of SITE_PAGES) expect(sitePageMetadata(p).robots, p.slug).toMatchObject({ index: true, follow: true });
    for (const a of LEARN_ARTICLES) expect(learnArticleMetadata(a).robots, a.slug).toMatchObject({ index: true, follow: true });
  });
});

describe('hreflang', () => {
  it('every pair is reciprocal and carries exactly one x-default', () => {
    for (const p of SITE_PAGES.filter((x) => x.alternate)) {
      const mine = pageLanguages(p)!;
      expect(mine[p.lang ?? 'en-CA'], p.slug).toBe(`/${p.slug}`);
      expect(mine[p.alternate!.lang], p.slug).toBe(`/${p.alternate!.slug}`);
      expect(mine['x-default'], p.slug).toBeDefined();
      expect(Object.keys(mine).filter((k) => k === 'x-default')).toHaveLength(1);

      // The other side points back at us with the same set.
      const other = SITE_PAGES.find((x) => x.slug === p.alternate!.slug)!;
      const theirs = pageLanguages(other)!;
      expect(theirs[p.lang ?? 'en-CA'], other.slug).toBe(`/${p.slug}`);
      expect(theirs['x-default'], other.slug).toBe(mine['x-default']);
    }
  });

  it('a page with no translation declares no hreflang (never a self-only pair)', () => {
    for (const p of SITE_PAGES.filter((x) => !x.alternate)) {
      expect(pageLanguages(p), p.slug).toBeUndefined();
    }
  });
});

describe('robots', () => {
  const r = robots() as { rules: { userAgent: string; allow?: string; disallow?: string[] }[]; sitemap: string; host: string };

  it('points at the sitemap on the canonical origin', () => {
    expect(r.sitemap).toBe(`${SITE_URL}/sitemap.xml`);
    expect(r.host).toBe(SITE_URL);
  });

  it('never blocks a path the sitemap asks to be indexed', () => {
    const disallow = r.rules.flatMap((x) => x.disallow ?? []);
    for (const path of publicPaths()) {
      const hit = disallow.find((d) => d !== '/' && path.startsWith(d));
      expect(hit, `${path} is disallowed by ${hit}`).toBeUndefined();
    }
  });

  it('keeps the signed-in app screens out of the index', () => {
    const disallow = r.rules.flatMap((x) => x.disallow ?? []);
    for (const app of ['/api/', '/account', '/admin', '/dashboard', '/projects']) {
      expect(disallow, app).toContain(app);
    }
  });
});

describe('no duplicate metadata reaches a crawler', () => {
  it('titles are unique across every indexable page', () => {
    const titles = [...SITE_PAGES.map((p) => p.title), ...LEARN_ARTICLES.map((a) => a.title)];
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('descriptions are unique across every indexable page', () => {
    const descs = [...SITE_PAGES.map((p) => p.description), ...LEARN_ARTICLES.map((a) => a.description)];
    expect(new Set(descs).size).toBe(descs.length);
  });

  it('search-sized: titles <= 60 chars, descriptions 110-160', () => {
    for (const p of [...SITE_PAGES, ...LEARN_ARTICLES]) {
      expect(p.title.length, p.title).toBeLessThanOrEqual(60);
      expect(p.description.length, (p as { slug: string }).slug).toBeGreaterThanOrEqual(110);
      expect(p.description.length, (p as { slug: string }).slug).toBeLessThanOrEqual(160);
    }
  });
});
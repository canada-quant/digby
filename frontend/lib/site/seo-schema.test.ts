import { describe, it, expect } from 'vitest';
import { LEARN_ARTICLES, SITE_PAGES, publicPaths, resolveRelated } from './content';
import { absoluteUrl, pageGraphLd, serviceLd, webPageLd, breadcrumbLd, organizationLd } from './seo';

/**
 * Structured-data + internal-link integrity pins for the public site
 * (2026-10-29 SEO wave, goal 252a1d17).
 *
 * The point of these tests is the PROMISE the composer makes: a new page added
 * to content.ts gets its whole schema graph and its interlinking for free. A
 * page that arrives without schema, or without enough contextual inbound links,
 * fails here rather than shipping as an orphan.
 */

const trailOf = (slug: string) => {
  const p = SITE_PAGES.find((x) => x.slug === slug)!;
  return [{ href: `/${p.slug}`, label: p.nav }];
};

describe('structured data', () => {
  it('every landing page gets Organization, WebSite, WebPage and BreadcrumbList', () => {
    for (const p of SITE_PAGES) {
      const graph = pageGraphLd(p, trailOf(p.slug)) as { '@type': string }[];
      const types = graph.map((n) => n['@type']);
      for (const required of ['Organization', 'WebSite', 'WebPage', 'BreadcrumbList']) {
        expect(types, `${p.slug} → ${required}`).toContain(required);
      }
    }
  });

  it('FAQPage is emitted exactly when the page shows its questions', () => {
    for (const p of SITE_PAGES) {
      const types = (pageGraphLd(p, trailOf(p.slug)) as { '@type': string }[]).map((n) => n['@type']);
      expect(types.includes('FAQPage'), `${p.slug} faqs=${p.faqs?.length ?? 0}`).toBe(!!p.faqs?.length);
    }
  });

  it('Service schema rides the pages that sell the product, not the guides', () => {
    for (const p of SITE_PAGES) {
      const types = (pageGraphLd(p, trailOf(p.slug)) as { '@type': string }[]).map((n) => n['@type']);
      const expected = p.group !== 'company';
      expect(types.includes('Service'), `${p.slug} (${p.group})`).toBe(expected);
    }
    // A company page can still opt in explicitly.
    const about = SITE_PAGES.find((p) => p.slug === 'about')!;
    const forced = pageGraphLd(about, trailOf('about'), { service: true }) as { '@type': string }[];
    expect(forced.map((n) => n['@type'])).toContain('Service');
  });

  it('Service claims no certification and names no model vendor', () => {
    // Claim-shaped wording is allowed only in a NEGATED sentence (the rules
    // page necessarily says "the certification claims we do not make").
    const NEGATED = /\b(no|not|never|holds no|hold no|without|claim|does not|do not|isn.t|is not)\b/i;
    for (const p of SITE_PAGES) {
      const svc = serviceLd(p);
      const text = [svc.name, svc.serviceType, svc.description, svc.offers.description].join(' ');
      for (const sentence of text.split(/(?<=[.!?])\s+/)) {
        if (!/certif|\bcompliant\b|iso 9001|soc 2/i.test(sentence)) continue;
        expect(NEGATED.test(sentence), `${p.slug}: ${sentence}`).toBe(true);
      }
      expect(JSON.stringify(svc), p.slug).not.toMatch(/kimi|glm|deepseek|qwen|moonshot/i);
    }
  });

  it('WebPage carries the real modified date, language and publisher', () => {
    for (const p of SITE_PAGES) {
      const w = webPageLd(p);
      expect(w.dateModified, p.slug).toBe(p.updated);
      expect(w.inLanguage, p.slug).toBe(p.lang ?? 'en-CA');
      expect(w.url, p.slug).toBe(absoluteUrl(`/${p.slug}`));
      expect(w.publisher).toEqual({ '@id': 'https://digby.example.com/#organization' });
    }
  });

  it('the Organization is a Canadian entity with a resolvable @id', () => {
    const org = organizationLd();
    expect(org['@id']).toBe('https://digby.example.com/#organization');
    expect(org.address).toMatchObject({ addressCountry: 'CA' });
    expect(org.knowsLanguage).toEqual(['en-CA', 'fr-CA']);
    expect(org.contactPoint[0].areaServed).toBe('CA');
  });

  it('breadcrumbs are positional, absolute and start at the chat home', () => {
    const ld = breadcrumbLd([{ href: '/industries', label: 'Industries' }, { href: '/industries-legal', label: 'Legal' }]);
    expect(ld.itemListElement).toHaveLength(3);
    ld.itemListElement.forEach((el, i) => {
      expect(el.position).toBe(i + 1);
      expect(el.item).toMatch(/^https:\/\/digby\.example\.com/);
    });
  });

  it('the emitted graph is JSON-serialisable (it is inlined into a script tag)', () => {
    for (const p of SITE_PAGES) {
      const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': pageGraphLd(p, trailOf(p.slug)) });
      expect(() => JSON.parse(json)).not.toThrow();
      expect(json).not.toMatch(/undefined/);
    }
  });
});

describe('internal-link mesh', () => {
  /** Body links only — the "related" cards are boilerplate on every page. */
  const inbound = new Map<string, Set<string>>();
  for (const p of SITE_PAGES) {
    for (const s of p.sections) {
      for (const l of s.links ?? []) {
        if (!l.href.startsWith('/')) continue;
        if (!inbound.has(l.href)) inbound.set(l.href, new Set());
        inbound.get(l.href)!.add(`/${p.slug}`);
      }
    }
  }
  for (const a of LEARN_ARTICLES) {
    for (const s of a.sections) {
      for (const l of s.links ?? []) {
        if (!l.href.startsWith('/')) continue;
        if (!inbound.has(l.href)) inbound.set(l.href, new Set());
        inbound.get(l.href)!.add(`/learn/${a.slug}`);
      }
    }
  }

  it('every landing page has at least 3 contextual inbound body links', () => {
    const thin: string[] = [];
    for (const p of SITE_PAGES) {
      const from = inbound.get(`/${p.slug}`)?.size ?? 0;
      if (from < 3) thin.push(`/${p.slug} (${from})`);
    }
    expect(thin, `pages with <3 contextual inbound links`).toEqual([]);
  });

  it('every guide has at least 2 contextual inbound body links', () => {
    const thin: string[] = [];
    for (const a of LEARN_ARTICLES) {
      const from = inbound.get(`/learn/${a.slug}`)?.size ?? 0;
      if (from < 2) thin.push(`/learn/${a.slug} (${from})`);
    }
    expect(thin, `guides with <2 contextual inbound links`).toEqual([]);
  });

  it('no body link points at a page or guide that does not exist', () => {
    // /Digby.dmg + /Digby-Setup.exe are real download files, not pages.
    const known = new Set([...publicPaths(), '/', '/Digby.dmg', '/Digby-Setup.exe']);
    for (const p of [...SITE_PAGES, ...LEARN_ARTICLES]) {
      for (const s of p.sections) {
        for (const l of s.links ?? []) {
          if (!l.href.startsWith('/')) continue;
          expect(known.has(l.href), `${(p as { slug: string }).slug} → ${l.href}`).toBe(true);
        }
      }
    }
  });

  it('every related slug resolves (a broken related card is a broken page)', () => {
    for (const p of [...SITE_PAGES, ...LEARN_ARTICLES]) {
      for (const r of p.related) {
        expect(resolveRelated(r), `${(p as { slug: string }).slug} → ${r}`).not.toBeNull();
      }
    }
  });

  it('anchors are descriptive, never "click here"', () => {
    for (const p of [...SITE_PAGES, ...LEARN_ARTICLES]) {
      for (const s of p.sections) {
        for (const l of s.links ?? []) {
          // Two words minimum and never a bare "click here" — descriptive is
          // about specificity, not character count.
          expect(l.label.trim().split(/\s+/).length, `${(p as { slug: string }).slug} → ${l.href}`).toBeGreaterThanOrEqual(2);
          expect(l.label, `${(p as { slug: string }).slug} → ${l.href}`).not.toMatch(/^(click here|read more|more|here|link)$/i);
        }
      }
    }
  });
});
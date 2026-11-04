import { describe, it, expect } from 'vitest';
import { SITE_PAGES, publicPaths } from './content';
import { CITY_MARKETS, CITY_VERTICALS, cityPageWords } from './cities';

/**
 * Anti-doorway pins for the city × vertical layer (goal 252a1d17, todo 75241c35).
 *
 * The whole risk of a programmatic page set is that it becomes 30 pages that
 * differ only by a substituted city name — which is a doorway set, and which
 * search engines correctly treat as noise. These tests make thinness a build
 * failure rather than a judgement call made later by a human with a spreadsheet.
 */

const cityPages = SITE_PAGES.filter((p) => p.group === 'local');
const expectedCount = CITY_MARKETS.length * CITY_VERTICALS.length;

describe('city × vertical layer', () => {
  it('ships exactly one page per city × vertical cell', () => {
    expect(cityPages).toHaveLength(expectedCount);
    expect(expectedCount).toBe(30);
    const slugs = cityPages.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every cell exists for every market (no silently dropped cell)', () => {
    for (const m of CITY_MARKETS) {
      for (const v of CITY_VERTICALS) {
        const slug = `ai-${v.slug}-${m.slug}`;
        expect(publicPaths(), slug).toContain(`/${slug}`);
      }
    }
  });

  it('each page carries real substance — 500+ words of its own copy', () => {
    for (const p of cityPages) {
      expect(cityPageWords(p), p.slug).toBeGreaterThanOrEqual(500);
    }
  });

  it("each city's own context passage is unique to that city", () => {
    // The section that must never repeat is the city-reality block: one per
    // city per vertical, and distinct across all 30.
    const passages = new Map<string, string[]>();
    for (const m of CITY_MARKETS) {
      for (const v of CITY_VERTICALS) {
        const page = cityPages.find((p) => p.slug === `ai-${v.slug}-${m.slug}`)!;
        const section = page.sections.find((s) => s.heading.includes('reality'))!;
        expect(section, `${m.slug}/${v.slug}`).toBeDefined();
        for (const para of section.paragraphs ?? []) {
          const key = para.trim();
          passages.set(key, [...(passages.get(key) ?? []), `${m.slug}/${v.slug}`]);
        }
      }
    }
    const shared = [...passages.entries()].filter(([, where]) => where.length > 1);
    expect(shared.map(([text, where]) => `${where.join(',')}: ${text.slice(0, 60)}`), 'a city passage reused across cells').toEqual([]);
  });

  it('each page names its own province statute and regulator context', () => {
    for (const p of cityPages) {
      const body = p.sections.flatMap((s) => [s.heading, ...(s.paragraphs ?? [])]).join(' ');
      const m = CITY_MARKETS.find((x) => p.slug.endsWith(`-${x.slug}`))!;
      const v = CITY_VERTICALS.find((x) => p.slug.startsWith(`ai-${x.slug}-`))!;
      // The province must appear, and the vertical's regulator/statute sentence
      // must be present (it lives in REGION_LAW and is what makes the page local).
      expect(body, p.slug).toContain(m.province);
      const statuteHeadings = ['What British Columbia', 'What Alberta', 'What Manitoba', 'What Ontario', 'What Québec', 'What Nova Scotia'];
      expect(statuteHeadings.some((h) => p.sections.some((s) => s.heading.startsWith(h))), p.slug).toBe(true);
      expect(p.nav, p.slug).toContain(m.city);
      expect(v.slug, p.slug).toBeTruthy();
    }
  });

  it('never fabricates a local office, datacenter or customer', () => {
    // The ONLY local hardware fact Digby has is the Victoria tuning lab. Any
    // city page naming a facility must be a Victoria page, and must not claim
    // an office or a datacenter there.
    for (const p of cityPages) {
      const body = p.sections
        .flatMap((s) => [s.heading, ...(s.paragraphs ?? []), ...(s.bullets ?? [])])
        .join(' ');
      const isVictoria = p.slug.endsWith('-victoria');
      if (!isVictoria) {
        expect(body, p.slug).not.toMatch(/\b(our|Digby’s|Digby's) (office|datacenter|data centre|facility|lab)\b/i);
        expect(body, p.slug).not.toMatch(/Victoria, British Columbia/i);
      } else {
        // Even Victoria may not claim an office or a datacenter — only the lab.
        expect(body, p.slug).not.toMatch(/\b(our|Digby’s|Digby's) (office|datacenter|data centre)\b/i);
      }
      // No invented customer names or counts.
      expect(body, p.slug).not.toMatch(/\b\d{2,}\+? (customers|clients|organisations|organizations)\b/i);
    }
  });

  it('the only local-hardware claim is the Victoria lab, stated plainly', () => {
    const victoria = cityPages.filter((p) => p.slug.endsWith('-victoria'));
    expect(victoria.length).toBe(3);
    for (const p of victoria) {
      const body = p.sections.flatMap((s) => [...(s.paragraphs ?? [])]).join(' ');
      expect(body, p.slug).toMatch(/lab/i);
      expect(body, p.slug).toMatch(/Victoria/);
    }
    // And no other market carries `proximity` copy at all.
    for (const m of CITY_MARKETS.filter((x) => x.slug !== 'victoria')) {
      expect(m.proximity, m.slug).toBeUndefined();
    }
  });

  it('every page is self-canonical and in the sitemap source', () => {
    // Canonical comes from the slug via seo.ts; publicPaths() is what the
    // sitemap iterates, so membership here IS sitemap membership.
    const paths = new Set(publicPaths());
    for (const p of cityPages) {
      expect(paths.has(`/${p.slug}`), p.slug).toBe(true);
      expect(p.updated, p.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('city pages carry FAQPage-eligible Q&A (the schema rides visible questions)', () => {
    for (const p of cityPages) {
      expect(p.faqs?.length, p.slug).toBeGreaterThanOrEqual(3);
      for (const f of p.faqs!) {
        expect(f.q.trim().endsWith('?'), `${p.slug}: ${f.q}`).toBe(true);
        expect(f.a.split(/\s+/).length, `${p.slug}: ${f.q}`).toBeGreaterThan(15);
      }
    }
  });

  it('no city page claims a certification', () => {
    const NEGATED = /\b(no|not|never|holds no|hold no|without|claim|cannot|does not|do not|isn’t|is not)\b/i;
    for (const p of cityPages) {
      for (const s of p.sections) {
        for (const str of [s.heading, ...(s.paragraphs ?? []), ...(s.bullets ?? [])]) {
          for (const sentence of str.split(/(?<=[.!?])\s+/)) {
            if (sentence.trim().endsWith('?')) continue;
            if (!/certif|\bcompliant\b|iso 9001|soc 2/i.test(sentence)) continue;
            expect(NEGATED.test(sentence), `${p.slug}: ${sentence}`).toBe(true);
          }
        }
      }
      for (const f of p.faqs ?? []) {
        if (!/certif|\bcompliant\b|iso 9001|soc 2/i.test(`${f.q} ${f.a}`)) continue;
        expect(NEGATED.test(f.a), `${p.slug} FAQ: ${f.q}`).toBe(true);
      }
    }
  });
});
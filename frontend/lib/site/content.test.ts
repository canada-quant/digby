import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import {
  CHAT_HREF, CONTACT_EMAIL, HEADER_NAV, LEARN_ARTICLES, LEARN_TOPICS, MENU_PRIMARY, MENU_PRODUCTS, SITE_PAGES,
  footerColumns, learnArticlesForTopic, publicPaths, resolveRelated, splitLead,
} from './content';
import { siteStrings } from './strings';
import { absoluteUrl, breadcrumbLd, faqLd, pageLanguages, sitePageMetadata } from './seo';
import { SHOTS, shotSrc } from './shots';
import { APP_SUB_PATHS } from '../../proxy';

/**
 * Interlinking + SEO integrity pins for the public site (owner 2026-10-14:
 * "make sure everything is always interlinking and there is a way to always
 * get back to the root domain to chat").
 */

const paths = publicPaths();
const knownTargets = new Set([...paths, '/Digby.dmg', '/Digby-Setup.exe', '/login', `mailto:${CONTACT_EMAIL}`]);

describe('public site content', () => {
  it('slugs are unique and never collide with an app screen or real route', () => {
    const slugs = SITE_PAGES.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const appDir = fileURLToPath(new URL('../../app', import.meta.url));
    const routes = readdirSync(appDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('(')).map((d) => d.name);
    for (const s of slugs) {
      expect(APP_SUB_PATHS as readonly string[]).not.toContain(s);
      expect(routes).not.toContain(s);
      expect(s).not.toBe('crossmodel');
    }
  });

  it('titles and descriptions are unique and search-sized', () => {
    const all = [...SITE_PAGES, ...LEARN_ARTICLES];
    expect(new Set(all.map((p) => p.title)).size).toBe(all.length);
    expect(new Set(all.map((p) => p.description)).size).toBe(all.length);
    // 2026-10-16 site review: search results cut titles past ~60 characters
    // and descriptions past ~160.
    for (const p of all) {
      expect(p.title.length, p.title).toBeLessThanOrEqual(60);
      expect(p.description.length, p.slug).toBeGreaterThanOrEqual(110);
      expect(p.description.length, p.slug).toBeLessThanOrEqual(160);
    }
  });

  it('every page carries a real last-updated date (the sitemap lastmod)', () => {
    for (const p of [...SITE_PAGES, ...LEARN_ARTICLES]) {
      expect(p.updated, p.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(p.updated)), p.slug).toBe(false);
    }
  });

  it('translations are paired both ways and resolve to an hreflang map with x-default', () => {
    for (const p of SITE_PAGES.filter((x) => x.alternate)) {
      const other = SITE_PAGES.find((x) => x.slug === p.alternate!.slug);
      expect(other, p.slug).toBeDefined();
      expect(other!.alternate?.slug, p.slug).toBe(p.slug);
      expect((other!.lang ?? 'en-CA'), p.slug).toBe(p.alternate!.lang);
      const langs = pageLanguages(p)!;
      expect(langs['x-default']).toBe('/sovereign-ai');
      expect(Object.keys(langs).sort()).toEqual(['en-CA', 'fr-CA', 'x-default']);
    }
    expect(SITE_PAGES.filter((x) => x.alternate).length).toBe(2);
  });

  it('every product screenshot exists on disk in all four variants', () => {
    const pub = fileURLToPath(new URL('../../public', import.meta.url));
    for (const key of Object.keys(SHOTS) as (keyof typeof SHOTS)[]) {
      for (const scheme of ['light', 'dark'] as const) for (const form of ['desktop', 'mobile'] as const) {
        expect(existsSync(pub + shotSrc(key, scheme, form)), `${key}-${scheme}-${form}`).toBe(true);
      }
    }
  });

  it('comparison pages: a table with one cell per column, dated sources, and a Compare footer column', () => {
    const compare = SITE_PAGES.filter((p) => p.group === 'compare');
    expect(compare.map((p) => p.slug).sort()).toEqual([
      'digby-vs-augure-ai', 'digby-vs-chatgpt', 'digby-vs-cohere-north', 'digby-vs-discreetly-ai', 'digby-vs-microsoft-copilot',
    ]);
    for (const p of compare) {
      const tables = p.sections.filter((s) => s.table);
      expect(tables.length, p.slug).toBe(1);
      const t = tables[0].table!;
      expect(t.columns[0]).toBe('Digby');
      // Mobile layout breaks on long cells (2026-10-28 SEO wave): keep columns
      // at most 3 (Digby + one or two competitors) and cells short.
      expect(t.columns.length, p.slug).toBeLessThanOrEqual(3);
      for (const r of t.rows) expect(r.cells.length, `${p.slug}: ${r.label}`).toBe(t.columns.length);
      expect(t.note, p.slug).toMatch(/as of October 2026/i);
      const sources = p.sections.flatMap((s) => s.sources ?? []);
      expect(sources.length, p.slug).toBeGreaterThanOrEqual(2);
      for (const src of sources) expect(src.href, p.slug).toMatch(/^https:\/\//);
    }
    const col = footerColumns().find((c) => c.title === 'Compare')!;
    expect(col.links.map((l) => l.href).sort()).toEqual(compare.map((p) => `/${p.slug}`).sort());
  });

  it('never answers "does my data leave Canada" with a bare no (claims discipline 2026-10-16)', () => {
    for (const p of [...SITE_PAGES, ...LEARN_ARTICLES]) {
      for (const f of p.faqs ?? []) {
        if (/leave Canada/i.test(f.q)) {
          expect(f.a, p.slug).not.toMatch(/^No\b/);
          expect(f.a, p.slug).toMatch(/search/i);
        }
      }
    }
  });

  it('the main landing pages carry real depth (SEO: ≥ 380 words of their own copy)', () => {
    const words = (p: (typeof SITE_PAGES)[number]) => [p.h1, p.lede,
      ...p.sections.flatMap((s) => [s.heading, ...(s.paragraphs ?? []), ...(s.bullets ?? []), ...(s.chips ?? []),
        ...(s.table ? s.table.rows.flatMap((r) => [r.label, ...r.cells]) : [])]),
      ...(p.faqs ?? []).flatMap((f) => [f.q, f.a])].join(' ').split(/\s+/).length;
    for (const slug of ['private-ai', 'sovereign-ai', 'canadian-ai-chatbot', 'chatgpt-alternative', 'features', 'ai-for-business', 'digby-vs-chatgpt', 'digby-vs-microsoft-copilot', 'digby-vs-cohere-north']) {
      expect(words(SITE_PAGES.find((p) => p.slug === slug)!), slug).toBeGreaterThanOrEqual(380);
    }
  });

  it('every related slug resolves (no dead "keep reading" cards)', () => {
    for (const p of [...SITE_PAGES, ...LEARN_ARTICLES]) {
      expect(p.related.length, p.slug).toBeGreaterThanOrEqual(2);
      for (const r of p.related) expect(resolveRelated(r), `${p.slug} → ${r}`).not.toBeNull();
    }
  });

  it('every in-content link points at a real public page', () => {
    for (const p of [...SITE_PAGES, ...LEARN_ARTICLES]) {
      for (const s of p.sections) for (const l of s.links ?? []) {
        expect(knownTargets.has(l.href), `${p.slug}: ${l.href}`).toBe(true);
      }
    }
    for (const l of [...HEADER_NAV, ...MENU_PRIMARY, ...MENU_PRODUCTS]) expect(knownTargets.has(l.href), l.href).toBe(true);
  });

  it('every hero secondary button points at a real page — and never at the page itself', () => {
    for (const p of SITE_PAGES) {
      if (!p.secondary) continue;
      expect(knownTargets.has(p.secondary.href), `${p.slug}: ${p.secondary.href}`).toBe(true);
      expect(p.secondary.href, p.slug).not.toBe(`/${p.slug}`);
    }
    // The default secondary is /features — so Features must set its own.
    expect(SITE_PAGES.find((p) => p.slug === 'features')!.secondary).toBeDefined();
  });

  it('no model VENDOR names in any visible copy, title or description (keywords are the owner\'s SEO call)', () => {
    const vendor = /\b(kimi|glm|deepseek|qwen)\b/i;
    const visible = (x: { keywords: string[] }) => JSON.stringify({ ...x, keywords: [] });
    for (const p of [...SITE_PAGES, ...LEARN_ARTICLES]) {
      expect(visible(p), (p as { slug: string }).slug).not.toMatch(vendor);
    }
  });

  it('the industry/compliance wave (2026-10-28) makes no certification or compliance CLAIM', () => {
    // Owner directive 2026-10-28: ten industry/trust pages, with the claims
    // discipline intact. Digby holds no PIPEDA / Law 25 / PHIPA / SOC 2 / ISO
    // certificate, so every mention of certification must be a DISCLAIMER.
    // Each sentence that names certification or compliance must carry a
    // negation ("holds no", "we do not claim", "is not", "no such" …).
    const wave = [
      'industries', 'industries-legal', 'industries-healthcare', 'industries-credit-unions', 'industries-public-sector',
      'industries-manufacturing', 'industries-first-nations', 'compliance', 'infrastructure',
      'digby-vs-augure-ai', 'digby-vs-discreetly-ai',
    ];
    // On a comparison page a sentence that names the COMPETITOR is a sourced
    // fact about them, not a claim by us — the pin is about Digby's own copy.
    const COMPETITOR = /augure|discreetly/i;
    const NEGATED = /\b(no|not|never|holds no|hold no|without|claim|cannot|does not|do not|isn’t|is not)\b/i;
    for (const slug of wave) {
      const page = SITE_PAGES.find((p) => p.slug === slug);
      expect(page, slug).toBeDefined();
      for (const sec of page!.sections) {
        // A section about the COMPETITOR ("What Augure AI actually is") states
        // sourced facts about them, not claims by us — the pin is Digby's copy.
        if (COMPETITOR.test(sec.heading)) continue;
        const body: string[] = [sec.heading, ...(sec.paragraphs ?? []), ...(sec.bullets ?? []), ...(sec.chips ?? []),
          ...(sec.table ? sec.table.rows.flatMap((r) => [r.label, ...r.cells]) : [])];
        for (const str of body) {
          // split into sentences so one negated sentence cannot launder another
          for (const sentence of str.split(/(?<=[.!?])\s+/)) {
            // a QUESTION asserts nothing — "Do you hold any certification?" is
            // exactly the checklist question this page should be asking.
            if (sentence.trim().endsWith('?')) continue;
            // Claim-shaped words only: "compliance" as a TOPIC ("policy and
            // compliance Q&A") is legitimate; "compliant" as a STATE is a claim.
            if (!/certif|\bcompliant\b|iso 9001|soc 2/i.test(sentence)) continue;
            expect(NEGATED.test(sentence), `${slug}: ${sentence}`).toBe(true);
          }
        }
      }
      // Page-level copy (title/lede/card) is always ours.
      for (const str of [page!.title, page!.description, page!.h1, page!.lede, page!.card ?? '']) {
        for (const sentence of str.split(/(?<=[.!?])\s+/)) {
          if (sentence.trim().endsWith('?')) continue;
          if (!/certif|\bcompliant\b|iso 9001|soc 2/i.test(sentence)) continue;
          expect(NEGATED.test(sentence), `${slug}: ${sentence}`).toBe(true);
        }
      }
      // A FAQ is a question + answer pair, so the question may pose the claim
      // ("Is Digby PIPEDA compliant?") as long as the answer refuses it.
      for (const f of page!.faqs ?? []) {
        if (!/certif|\bcompliant\b|iso 9001|soc 2/i.test(`${f.q} ${f.a}`)) continue;
        expect(NEGATED.test(f.a), `${slug} FAQ: ${f.q} → ${f.a}`).toBe(true);
      }
    }
  });

  it('the industry pages form a real two-way cluster with compliance and the comparison pair', () => {
    const sectors = ['industries-legal', 'industries-healthcare', 'industries-credit-unions', 'industries-public-sector', 'industries-manufacturing', 'industries-first-nations'];
    const hub = SITE_PAGES.find((p) => p.slug === 'industries')!;
    // The hub links out to every sector in its body, not only via `related`.
    const hubLinks = hub.sections.flatMap((s) => s.links ?? []).map((l) => l.href);
    for (const s of sectors) expect(hubLinks, s).toContain(`/${s}`);
    for (const s of sectors) {
      const page = SITE_PAGES.find((p) => p.slug === s)!;
      expect(page.group, s).toBe('canada');
      // Each sector points back at the hub, and at compliance + private-ai.
      // The wave brief names the four links literally, on every sector page.
      for (const req of ['industries', 'compliance', 'private-ai', 'ai-for-business']) {
        expect(page.related, `${s} → ${req}`).toContain(req);
      }
      // 4–6 FAQs per the wave brief.
      expect(page.faqs!.length, s).toBeGreaterThanOrEqual(4);
      expect(page.faqs!.length, s).toBeLessThanOrEqual(6);
    }
    const compliance = SITE_PAGES.find((p) => p.slug === 'compliance')!;
    expect(compliance.faqs!.length).toBeGreaterThanOrEqual(6);
    expect(compliance.faqs!.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(compliance)).toMatch(/not legal advice/i);
  });

  it('every page and guide has one inverse block, two prompts and a non-empty card blurb', () => {
    for (const p of [...SITE_PAGES.filter((x) => x.slug !== 'faq'), ...LEARN_ARTICLES]) {
      expect(p.sections.filter((s) => s.tone === 'inverse').length, p.slug).toBe(1);
      expect(p.prompts?.length, p.slug).toBe(2);
      expect(p.card, p.slug).toBeTruthy();
    }
  });

  it('every guide has a Learn topic and the topic filter narrows (unknown = all)', () => {
    for (const a of LEARN_ARTICLES) expect(LEARN_TOPICS).toContain(a.topic);
    expect(learnArticlesForTopic('privacy').articles.every((a) => a.topic === 'Privacy')).toBe(true);
    expect(learnArticlesForTopic('PRIVACY').topic).toBe('Privacy');
    expect(learnArticlesForTopic('nope').articles).toHaveLength(LEARN_ARTICLES.length);
    expect(learnArticlesForTopic(undefined).topic).toBeNull();
  });

  it('bullet lead lines follow the spec split', () => {
    expect(splitLead('Live web search — when a question is time-sensitive')).toEqual({ lead: 'Live web search', rest: 'when a question is time-sensitive' });
    expect(splitLead('Memory is visible: open Settings and read every fact.')).toEqual({ lead: 'Memory is visible', rest: 'open Settings and read every fact.' });
    expect(splitLead('Open beats opaque. No single company should own it.')).toEqual({ lead: 'Open beats opaque.', rest: 'No single company should own it.' });
    expect(splitLead('Where is it processed?')).toEqual({ lead: '', rest: 'Where is it processed?' });
  });

  it('the French page gets French chrome strings', () => {
    const fr = siteStrings('fr-CA');
    const en = siteStrings();
    for (const k of ['tryAsking', 'keepReading', 'swipe', 'askDefault', 'ctaTitle', 'menu'] as const) {
      expect(typeof fr[k]).toBe('string');
    }
    expect(fr.keepReading).not.toBe(en.keepReading);
    expect(fr.askDefault).not.toBe(en.askDefault);
    for (const l of MENU_PRIMARY) expect(fr.menuLabels[l.href], l.href).toBeTruthy();
    for (const p of MENU_PRODUCTS) expect(fr.productLabels[p.href], p.href).toBeTruthy();
  });

  it('the footer reaches EVERY public page, and the chat is always one click away', () => {
    const footer = new Set(footerColumns().flatMap((c) => c.links.map((l) => l.href)));
    for (const path of paths) {
      if (path === '/') continue; // the logo + "Start chatting" CTAs carry the root
      expect(footer.has(path), path).toBe(true);
    }
    expect(CHAT_HREF).toBe('/');
  });

  it('no public page is under the legacy /crossmodel name', () => {
    for (const path of paths) expect(path.startsWith('/crossmodel')).toBe(false);
  });

  it('the Canada keyword set is covered by dedicated pages', () => {
    const kw = SITE_PAGES.flatMap((p) => p.keywords);
    for (const k of ['private ai canada', 'sovereign canada ai models', 'canada ai chatbot', 'chatgpt alternative canada']) {
      expect(kw, k).toContain(k);
    }
  });
});

describe('training claim matches the privacy policy', () => {
  // Owner 2026-10-16: Digby never trains on user content. The site may say so
  // only while the privacy policy does — this pins the two together.
  const policy = readFileSync(fileURLToPath(new URL('../../app/(site)/privacy/page.tsx', import.meta.url)), 'utf8');
  const claims = JSON.stringify([...SITE_PAGES, ...LEARN_ARTICLES]).toLowerCase();

  it('the policy states it', () => {
    expect(policy).toContain('We do not use your conversations, memory, uploaded files or any other content you provide to train or fine-tune AI models');
  });

  it('the site states it on the privacy-facing pages', () => {
    for (const slug of ['private-ai', 'faq', 'digby-vs-chatgpt', 'digby-vs-microsoft-copilot']) {
      const page = SITE_PAGES.find((p) => p.slug === slug)!;
      expect(JSON.stringify(page).toLowerCase(), slug).toMatch(/never (be )?used to train|never uses your conversations|never used to train|train or fine-tune/);
    }
    expect(claims).toContain('never uses your conversations, memory or files to train or fine-tune');
  });
});

describe('seo builders', () => {
  it('canonical URLs are absolute on digby.example.com', () => {
    expect(absoluteUrl('/')).toBe('https://digby.example.com');
    expect(absoluteUrl('/about')).toBe('https://digby.example.com/about');
    const m = sitePageMetadata(SITE_PAGES[0]);
    expect(m.alternates?.canonical).toBe(`https://digby.example.com/${SITE_PAGES[0].slug}`);
  });

  it('breadcrumbs start at the chat home', () => {
    const ld = breadcrumbLd([{ href: '/learn', label: 'Learn' }]);
    expect(ld.itemListElement[0]).toMatchObject({ position: 1, item: 'https://digby.example.com' });
    expect(ld.itemListElement[1]).toMatchObject({ position: 2, item: 'https://digby.example.com/learn' });
  });

  it('FAQ schema mirrors the visible questions', () => {
    const ld = faqLd([{ q: 'Q?', a: 'A.' }]);
    expect(ld.mainEntity[0]).toEqual({ '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: 'A.' } });
  });
});

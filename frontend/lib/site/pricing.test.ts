import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { LEARN_ARTICLES, SITE_PAGES } from './content';
import { faqLd, pageGraphLd, serviceLd, softwareApplicationLd } from './seo';
import {
  PRICING_FAQ_QUESTION, PRICING_FAQ_QUESTION_FR, PRICING_PUBLISHED, PRICING_ROW_VALUE,
  PUBLISHED_PRICE_CAD_PER_MONTH, pricingAnswer, pricingAnswerAt, pricingAnswerFr,
  pricingOfferPrice, pricingOfferPriceAt, pricingRowValueAt,
} from './pricing';

/**
 * Pricing-row + named-model pins (owner ruling 2026-10-30: "no names models
 * and it's free" — the model half acted on here, the price half still gated).
 *
 * Two things this file exists to stop:
 *  1. A later lane re-introducing a named model-variant row ("Digby fast" …).
 *     The owner RULED them out, so the placeholder is deleted, not null — and
 *     a deleted placeholder cannot be quietly filled in later.
 *  2. A price being published by side effect: a hard-coded figure, a bare
 *     "free" sold as a price, or a schema `Offer` carrying `price: '0'` —
 *     which is a published $0 claim in machine-readable form.
 */

const source = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf-8');

/** Everything the site actually renders as copy (keywords excluded: SEO-only). */
function renderedStrings(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const p of [...SITE_PAGES, ...LEARN_ARTICLES]) {
    const visible = { ...p, keywords: [] };
    out.push({ where: (p as { slug: string }).slug, text: JSON.stringify(visible) });
  }
  return out;
}

describe('named model variants are REMOVED (owner ruling, not a pending lever)', () => {
  it('the old model-line placeholder module is gone, not left at null', () => {
    // The lever was "give Digby's tuned models public names". The owner ruled
    // "no names models" (2026-10-30), so the lever is RESOLVED and its
    // placeholder must not survive as a null waiting to be filled.
    expect(() => source('./models-pricing.ts')).toThrow();
  });

  it('no consumer imports or exports a model line', () => {
    // Source-level, but on IMPORT/EXPORT lines only: pricing.ts discusses the
    // deleted `MODEL_LINE` in its doc comment (so a future lane knows why it is
    // gone), and a comment is not a consumer.
    const wiring = /^\s*(import|export)\b[^\n]*\b(MODEL_LINE|NamedModel|MODEL_LINE_PENDING)\b/m;
    for (const f of ['./content.ts', './seo.ts', './cities.ts', './pricing.ts']) {
      expect(source(f), f).not.toMatch(wiring);
      expect(source(f), f).not.toMatch(/from\s+['"]\.\/models-pricing['"]/);
    }
  });

  it('no page carries a Digby-branded model-variant name', () => {
    // The shape the owner rejected: a marketing variant name in front of a
    // model word, rendered as a proper noun ("Digby Fast", "Digby Deep").
    // Matched on RENDERED copy, so an SEO keyword cannot hide one.
    const properNoun = /\bDigby\s+(Fast|Deep|Research|Pro|Lite|Max|Ultra|Turbo|Flash)\b/;
    // Lowercase shapes too, minus "research" — "What should Digby research?"
    // is a verb phrase in ordinary English, not a product name, and that
    // sentence is legitimate copy. The capitalized form above still catches a
    // genuine "Digby Research" variant.
    const lowercase = /\bDigby\s+(fast|deep|pro|lite|max|ultra|turbo|flash)\b/i;
    for (const { where, text } of renderedStrings()) {
      expect(text, where).not.toMatch(properNoun);
      expect(text, where).not.toMatch(lowercase);
    }
  });

  it('no model VENDOR name appears in rendered copy either', () => {
    const vendor = /\b(kimi|glm|deepseek|qwen|moonshot)\b/i;
    for (const { where, text } of renderedStrings()) {
      expect(text, where).not.toMatch(vendor);
    }
  });
});

describe('pricing row: one constant, PUBLISHED at the $0 entry point', () => {
  it('the constant is published at 0 — the owner answered oq_88a750bc', () => {
    // Owner, 2026-10-30, verbatim: "Free to start — publish a $0 entry point
    // and keep larger engagements on 'contact us'". If this fails someone
    // unpublished or raised it without a ruling.
    expect(PUBLISHED_PRICE_CAD_PER_MONTH).toBe(0);
    expect(PRICING_PUBLISHED).toBe(true);
    expect(PRICING_ROW_VALUE).toMatch(/\bfree to start\b/i);
    expect(PRICING_ROW_VALUE).toMatch(/contact us/i);
  });

  it('the row publishes $0 and routes ABOVE $0 to contact us — no ladder', () => {
    // The owner picked "free TO START", not "free, full stop": everything above
    // the entry point is unpriced. Augure's CAD tier ladder is what we do not copy.
    expect(PRICING_ROW_VALUE).not.toMatch(/pro|max|enterprise|premium|plus/i);
    expect(PRICING_ROW_VALUE).not.toMatch(/\$\s*[1-9]/);
    const answer = pricingAnswer();
    expect(answer).toMatch(/CAD \$0|free to start/i);
    expect(answer).toMatch(/contact us|written number|quoted|set with you/i);
    // A published answer may say "free to start" — but must not claim it is
    // free with no ceiling, because larger engagements are quoted.
    expect(answer).not.toMatch(/\bnothing\b/i);
  });

  it('the fr-CA answer publishes the same ruling, not a bare "gratuit"', () => {
    expect(pricingAnswerFr()).toMatch(/gratuit pour commencer/i);
    expect(pricingAnswerFr()).toMatch(/contactez-nous/i);
    expect(pricingAnswerFr()).not.toMatch(/\$\s*[1-9]/);
  });

  it('both directions of the flip stay green (null and a paid from-price)', () => {
    // The one-line promise in either direction: `null` re-unpublishes to
    // "Quoted on request", and a paid figure becomes a from-price. Neither may
    // ever crash or render "undefined".
    expect(pricingRowValueAt(null)).toBe('Quoted on request');
    expect(pricingRowValueAt(20)).toMatch(/from CAD \$20/i);
    expect(pricingOfferPriceAt(null)).toEqual({});
    expect(pricingOfferPriceAt(20)).toEqual({ price: '20', priceCurrency: 'CAD' });
    for (const text of [pricingAnswerAt(null), pricingAnswerAt(20), pricingAnswerAt(0)]) {
      expect(text.length).toBeGreaterThan(40);
      expect(text).not.toMatch(/\bundefined\b|\bnull\b/);
    }
  });

  it('the FAQ question is the one the keyword map targets', () => {
    expect(PRICING_FAQ_QUESTION).toBe('How much does private Canadian AI cost?');
  });

  it('no page hard-codes a CAD price for Digby', () => {
    // Competitor prices are sourced facts about THEM; this pin is about ours.
    // Our own price cell must come from PRICING_ROW_VALUE.
    for (const p of SITE_PAGES) {
      for (const s of p.sections) {
        for (const row of s.table?.rows ?? []) {
          if (!/^price/i.test(row.label)) continue;
          // The Digby cell is column 0 on every comparison table.
          expect(row.cells[0], `${p.slug}: ${row.label}`).toBe(PRICING_ROW_VALUE);
        }
      }
    }
  });

  it('no page asks the same FAQ question twice', () => {
    // This wave replaced several pages' "Is Digby free?" entry with the shared
    // PRICING_FAQ_QUESTION. On a page that already had a cost entry, that
    // would render the same question twice — and emit a duplicate FAQPage
    // entity, which is a schema error rather than a style nit.
    for (const p of [...SITE_PAGES, ...LEARN_ARTICLES]) {
      const qs = (p.faqs ?? []).map((f) => f.q.toLowerCase());
      expect(new Set(qs).size, `${(p as { slug: string }).slug}: duplicate FAQ question`).toBe(qs.length);
    }
  });

  it('/private-ai actually carries the cost entry it is documented as owning', () => {
    // KEYWORD-MAP.md §1 designates /private-ai as THE answer page for the
    // "private AI pricing Canada" cluster, so it must really carry the row.
    const page = SITE_PAGES.find((p) => p.slug === 'private-ai')!;
    expect((page.faqs ?? []).some((f) => f.q === PRICING_FAQ_QUESTION)).toBe(true);
  });

  it('the fr-CA page publishes the ruling from the same constant', () => {
    // "Digby est-il gratuit ? … Oui" used to answer this page's price question
    // in the affirmative before any ruling existed. Now it publishes the same
    // $0-entry-point answer as English, from the same constant.
    const page = SITE_PAGES.find((p) => p.slug === 'ia-souveraine-canada')!;
    const entry = (page.faqs ?? []).find((f) => f.q === PRICING_FAQ_QUESTION_FR)!;
    expect(entry, 'fr-CA cost entry missing').toBeDefined();
    expect(entry.a).toBe(pricingAnswerFr());
    expect(entry.a).toMatch(/gratuit pour commencer/i);
    expect(entry.a).toMatch(/contactez-nous/i);
    // No French tier ladder and no figure above $0 — the ruling's shape.
    expect(entry.a).not.toMatch(/\$\s*[1-9]/);
    expect(entry.a).not.toMatch(/\bpro\b|\bmax\b|entreprise|premium/i);
  });

  it('every cost answer on the site comes from the one constant', () => {
    for (const p of SITE_PAGES) {
      for (const f of p.faqs ?? []) {
        if (!/how much does .*cost/i.test(f.q)) continue;
        expect(f.a, `${p.slug}: ${f.q}`).toBe(pricingAnswer());
        expect(f.q, `${p.slug}`).toBe(PRICING_FAQ_QUESTION);
      }
    }
  });
});

describe('pricing reaches the structured data exactly as the owner published it', () => {
  it('emits the published $0 / CAD offer, and agrees with the visible row', () => {
    // The owner decided ($0 entry point), so a schema Offer carrying a $0 price
    // is now an OWNED claim rather than the accidental one this PR removed.
    expect(pricingOfferPrice()).toEqual({ price: '0', priceCurrency: 'CAD' });
    for (const node of [serviceLd(SITE_PAGES[0]), softwareApplicationLd()]) {
      const offers = (node as { offers: { price?: string; priceCurrency?: string; description?: string } }).offers;
      expect(offers.price).toBe('0');
      expect(offers.priceCurrency).toBe('CAD');
      // Above $0 stays unpriced: the description routes to contact-us.
      expect(offers.description).toMatch(/free to start/i);
      expect(offers.description).toMatch(/contact|quoted/i);
    }
  });

  it('emits NO money property if the price is ever unpublished again', () => {
    // Regression pin for the bug this PR fixed: `price: '0'` while nobody had
    // decided was a $0 claim published by accident. `null` must emit nothing.
    expect(pricingOfferPriceAt(null)).toEqual({});
  });

  it('the FAQPage answer for the cost question is the constant, verbatim', () => {
    const page = SITE_PAGES.find((p) => (p.faqs ?? []).some((f) => f.q === PRICING_FAQ_QUESTION));
    expect(page, 'no page asks the pricing question').toBeDefined();
    const ld = faqLd(page!.faqs!) as { mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
    const entry = ld.mainEntity.find((e) => e.name === PRICING_FAQ_QUESTION)!;
    expect(entry.acceptedAnswer.text).toBe(pricingAnswer());
    // And it rides a real FAQPage on the page graph, so Google can read it.
    const types = (pageGraphLd(page!, [{ href: `/${page!.slug}`, label: page!.nav }]) as { '@type': string }[])
      .map((n) => n['@type']);
    expect(types).toContain('FAQPage');
  });
});
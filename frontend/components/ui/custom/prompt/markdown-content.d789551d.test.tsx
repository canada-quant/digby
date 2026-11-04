/**
 * Replay pin — in-chat user feedback ticket d789551d ("formatting broken",
 * 2026-09-08, chat aa5f035a-13aa-4094-a8f7-7dfe9d162a98, message
 * 0337c8aa-7869-4f1b-a001-73c65ad930fc).
 *
 * The user reported broken formatting 3 minutes after the assistant message
 * below. The stored message body (reproduced VERBATIM here, including curly
 * quotes, em-dashes, and accented characters) is valid CommonMark: bold
 * product names inline, but a single dense paragraph with no list markers.
 * This suite pins what the renderer provably does with that exact input:
 *   - bold spans parse to <strong> (no literal `**` leaks),
 *   - unicode (— “ ” É £) survives intact,
 *   - the output is exactly one <p> — i.e. the "wall of text" the user saw
 *     is the message AS AUTHORED by the model, not a renderer collapse.
 * If a future renderer change breaks any of these, this test catches it
 * before another "formatting broken" report has to.
 *
 * UPDATED 2026-10-06 (ticket 6ee7a779): the one-paragraph pin is superseded.
 * A ~1,900-char answer with seven bold-led items and ZERO line breaks is the
 * lost-newline shape (the model's paragraph breaks arrived as spaces — 44
 * supervisor answers in three days carried it, and the owner reported the same
 * "one big block of text"). lib/wall-of-text.ts now re-lines it at render: one
 * paragraph per bold-led item, still no invented list markup.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { MarkdownContent } from './markdown-content';

const render = (md: string) =>
  renderToStaticMarkup(createElement(MarkdownContent, null, md));

// Verbatim stored content of the reported message (ticket d789551d).
const REPORTED_MESSAGE = `Checked the actual fashion editorial on this — GQ's crossbody gallery, British GQ's guide, Esquire, Men's Health, and Stylecaster's “The Best Men's Crossbody Bags for 2026” — plus the EDC community's take (Nomads Nation's tier list). Here's what designer actually survives the “bigger than a fanny pack” filter: **Porter-Yoshida Tanker Shoulder, ~$215** — GQ's “Best Travel Crossbody,” and the one every fashion guy in Japan has owned for decades. Holds way more than a fanny pack, water-resistant nylon, timeless. This is the designer answer that isn't a flex purchase. **Bellroy x CARRÉ CORDURA Sling 6L, $129** — not a fashion house, but it's the current EDC-designer crossover (Carré is a Belgian fashion brand). Nomads Nation put the 6L in S-tier. You asked “luxury or not luxury doesn't matter” — this is the trend pick. **Burberry Medium Canvas Check Crossbody, ~$1,100–1,400** — Stylecaster's top designer pick for 2026, described as fitting “phone, keys, wallet, maybe a small notebook” — so, genuinely useful capacity. This is the entry point for a real luxury crossbody that isn't a logo pouch. **Sandqvist Rucksack Sling 10L, ~$120** — Swedish designer brand, British GQ's “Best Scandinavian Crossbody.” 10L is backpack-adjacent. If “designer” for you means “looks expensive and European, not a logo,” this is it. **Bleu de Chauffe Driver Bag, ~£155** — French leather, British GQ's luxury pick. Heritage motorcycling aesthetic, ages beautifully. Smaller than the others but real leather at a sane price. **Uniqlo Multi Pocket Shoulder Bag, $25** — not designer, but British GQ calls it “basically a dupe of the Porter-Yoshida Tanker.” If you want the look without the price, this is the cheat code. **Bottega Veneta Cassette, $2,900** — GQ's designer pick, but it's “more jewelry than luggage.” Flagging because it's the obvious designer answer and it fails your capacity requirement hard. What the editorials quietly agree on: the “designer crossbody” market right now is split between actual useful bags (Porter-Yoshida, Burberry, Sandqvist) and phone-holder jewelry (Bottega, most Louis Vuitton, Gucci). The $215 Porter-Yoshida is the sweet spot — real designer pedigree, real capacity, not trying to be a necklace. My pick from this tier: **Porter-Yoshida Tanker**. It's the one fashion editors and EDC nerds both respect, and it's the only designer option where “holds more than a fanny pack” is a feature, not a compromise.`;

const BOLD_ITEMS = [
  'Porter-Yoshida Tanker Shoulder, ~$215',
  'Bellroy x CARRÉ CORDURA Sling 6L, $129',
  'Burberry Medium Canvas Check Crossbody, ~$1,100–1,400',
  'Sandqvist Rucksack Sling 10L, ~$120',
  'Bleu de Chauffe Driver Bag, ~£155',
  'Uniqlo Multi Pocket Shoulder Bag, $25',
  'Bottega Veneta Cassette, $2,900',
  'Porter-Yoshida Tanker',
];

describe('MarkdownContent — ticket d789551d replay ("formatting broken" report)', () => {
  it('parses every inline bold span — no literal ** leaks to the user', () => {
    const html = render(REPORTED_MESSAGE);
    expect(html).not.toContain('**');
    for (const item of BOLD_ITEMS) {
      // Renderer adds Tailwind classes to <strong>; match class-tolerantly.
      expect(html).toMatch(new RegExp(`<strong[^>]*>${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</strong>`));
    }
  });

  it('preserves unicode verbatim — em-dashes, curly quotes, accents, £', () => {
    const html = render(REPORTED_MESSAGE);
    expect(html).toContain('—');
    expect(html).toContain('“The Best Men');
    expect(html).toContain('CARRÉ');
    expect(html).toContain('~£155');
  });

  it('re-lines the newline-collapsed answer: one paragraph per bold-led item (ticket 6ee7a779), never an invented list', () => {
    const html = render(REPORTED_MESSAGE);
    const paragraphCount = (html.match(/<p[\s>]/g) ?? []).length;
    expect(paragraphCount).toBe(9); // intro + seven bold-led items + the closing paragraph
    for (const item of BOLD_ITEMS.slice(0, 7)) {
      expect(html).toMatch(new RegExp(`<p[^>]*><strong[^>]*>${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</strong>`));
    }
    // Still honest: the renderer does not invent LIST structure the model did not write.
    expect(html).not.toContain('<ul');
    expect(html).not.toContain('<li');
  });

  it('keeps the closing recommendation intact end-to-end', () => {
    const html = render(REPORTED_MESSAGE);
    expect(html).toContain('a feature, not a compromise.');
    expect(html).toMatch(/^<p[\s>]/);
  });
});

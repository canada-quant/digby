/**
 * serp-bound unit tests (feedback ticket ba968a07) — the bounded-SERP choke
 * point for every model-context injection. Pure module: no mocks needed.
 */

import {
  boundSerpForContext,
  SERP_BOUND_MAX_RESULTS,
  SERP_BOUND_MAX_CHARS,
  SERP_BOUND_SNIPPET_CHARS,
} from './serp-bound';

describe('boundSerpForContext — URL hygiene', () => {
  it('unwraps google redirect wrappers to the real destination', () => {
    const raw = 'Cerebras news https://www.google.com/url?q=https://cerebras.net/press&sa=U more text';
    const { text, resultCount } = boundSerpForContext(raw);
    expect(resultCount).toBe(1);
    expect(text).toContain('https://cerebras.net/press');
    expect(text).not.toContain('google.com/url');
  });

  it('drops non-citation hosts (google search pages, vendor doc host)', () => {
    const raw =
      'junk https://www.google.com/search?q=cerebras and https://docs.brightdata.com/api-error ' +
      'real https://www.tomshardware.com/cerebras-wse3';
    const { text, resultCount } = boundSerpForContext(raw);
    expect(resultCount).toBe(1);
    expect(text).toContain('https://www.tomshardware.com/cerebras-wse3');
    expect(text).not.toContain('google.com/search');
    expect(text).not.toContain('docs.brightdata.com');
  });

  it('collapses duplicate mentions of one result (anchor + bare + wrapped)', () => {
    const raw =
      '[Cerebras nets $1.1B](https://www.google.com/url?q=https://cerebras.net/press&sa=U) first mention\n' +
      'see also https://cerebras.net/press and again https://cerebras.net/press.\n' +
      'Second story https://www.tomshardware.com/cerebras-wse3 here';
    const { text, resultCount } = boundSerpForContext(raw);
    expect(resultCount).toBe(2);
    // The one kept mention of cerebras.net/press rides the anchor's title.
    expect((text.match(/cerebras\.net\/press/g) || [])).toHaveLength(1);
    expect(text).toContain('[Cerebras nets $1.1B](https://cerebras.net/press)');
  });

  it('strips trailing sentence punctuation from prose URLs', () => {
    const { text, resultCount } = boundSerpForContext('Read https://example.com/story.');
    expect(resultCount).toBe(1);
    expect(text).toContain('https://example.com/story');
    expect(text).not.toContain('story.');
  });

  it('uses the markdown anchor title when present, never inventing one otherwise', () => {
    const anchored = boundSerpForContext('[Real Title](https://example.com/a) snippet words');
    expect(anchored.text).toContain('[Real Title](https://example.com/a)');
    // A bare URL with no same-line label renders as the bare URL — no
    // fabricated title, and the line is NOT a markdown link.
    const bare = boundSerpForContext('intro words\nhttps://example.com/b\nsnippet line');
    expect(bare.text).toContain('1. https://example.com/b');
    expect(bare.text).not.toContain('](https://example.com/b)');
  });

  it('takes same-line text before the URL as the label for bare mentions', () => {
    const { text } = boundSerpForContext('Cerebras nets $1.1B https://cerebras.net/press — more context');
    expect(text).toContain('[Cerebras nets $1.1B](https://cerebras.net/press)');
  });
});

describe('boundSerpForContext — caps', () => {
  it(`caps at ${SERP_BOUND_MAX_RESULTS} results and notes the truncation`, () => {
    const raw = Array.from({ length: 12 }, (_, i) => `Story ${i} https://site${i}.example.com/p`).join('\n');
    const { text, resultCount } = boundSerpForContext(raw);
    expect(resultCount).toBe(SERP_BOUND_MAX_RESULTS);
    expect(text).toContain('https://site0.example.com/p');
    expect(text).toContain(`https://site${SERP_BOUND_MAX_RESULTS - 1}.example.com/p`);
    expect(text).not.toContain(`https://site${SERP_BOUND_MAX_RESULTS}.example.com/p`);
    expect(text).toContain('truncated');
  });

  it(`hard-caps the block at ${SERP_BOUND_MAX_CHARS} chars even with giant snippets`, () => {
    // Fat lines (~640 chars each after the label/snippet caps): 8 × 640 > 4000,
    // so the char budget — not the result-count cap — does the cutting.
    const raw = Array.from({ length: 8 }, (_, i) =>
      `Story ${i} ${'labelpad '.repeat(15)} https://site${i}.example.com/${'p'.repeat(200)} ${'snippet words padding '.repeat(80)}`).join('\n');
    const { text, resultCount } = boundSerpForContext(raw);
    expect(text.length).toBeLessThanOrEqual(SERP_BOUND_MAX_CHARS);
    expect(resultCount).toBeGreaterThan(0);
    expect(resultCount).toBeLessThan(8); // the budget cut results before the K cap
    expect(text).toContain('truncated');
  });

  it(`caps each snippet window at ${SERP_BOUND_SNIPPET_CHARS} chars`, () => {
    const raw = `https://example.com/p ${'x'.repeat(900)}`;
    const { text } = boundSerpForContext(raw);
    const snippet = text.split(' — ')[1];
    expect(snippet.length).toBe(SERP_BOUND_SNIPPET_CHARS);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('snippets never swallow a second URL on the same line', () => {
    const raw = 'https://a.example.com/1 cached copy https://b.example.com/2 tail';
    const { text, resultCount } = boundSerpForContext(raw);
    expect(resultCount).toBe(2);
    const line1 = text.split('\n')[0];
    expect((line1.match(/https?:\/\//g) || [])).toHaveLength(1);
  });
});

describe('boundSerpForContext — fallback & edge cases', () => {
  it('empty / whitespace input returns an empty block', () => {
    expect(boundSerpForContext('')).toEqual({ text: '', resultCount: 0 });
    expect(boundSerpForContext('   \n\t ')).toEqual({ text: '', resultCount: 0 });
  });

  it('non-empty input with NO parseable citation returns the raw head, resultCount 0', () => {
    const raw = 'Just prose about the answer, no links at all.';
    expect(boundSerpForContext(raw)).toEqual({ text: raw, resultCount: 0 });
  });

  it('the no-citation fallback head-caps at the char budget and notes it', () => {
    const raw = `prose ${'padding '.repeat(2000)}`;
    const { text, resultCount } = boundSerpForContext(raw);
    expect(resultCount).toBe(0);
    expect(text.length).toBeLessThanOrEqual(SERP_BOUND_MAX_CHARS);
    expect(text.startsWith('prose')).toBe(true);
    expect(text).toContain('truncated');
  });

  it('a SERP whose ONLY urls are non-citation hosts falls back to the raw head', () => {
    const raw = 'results page https://www.google.com/search?q=x end';
    const { text, resultCount } = boundSerpForContext(raw);
    expect(resultCount).toBe(0);
    expect(text).toBe(raw); // short enough to survive whole — grounding kept
  });
});

describe('boundSerpForContext — idempotence (double-bounding is a no-op)', () => {
  const cases: Array<[string, string]> = [
    ['wrapped anchors + bare + dups',
      '[Cerebras nets $1.1B](https://www.google.com/url?q=https://cerebras.net/press&sa=U) Raises money for wafer chips\n' +
      'Tom takes a look https://www.tomshardware.com/cerebras-wse3 — deep dive review\n' +
      'bare https://example.com/no-label\n' +
      'junk https://www.google.com/search?q=cerebras\n'],
    ['over-K results', Array.from({ length: 12 }, (_, i) => `Story ${i} https://site${i}.example.com/p`).join('\n')],
    ['giant snippets', Array.from({ length: 8 }, (_, i) => `https://s${i}.example.com/p ${'pad '.repeat(200)}`).join('\n')],
    ['no-citation prose', 'Just prose, no links.'],
    ['mixed anchor on its own line', '[A Title](https://example.com/t)\nThe snippet lives on the next line here.\n'],
  ];
  it.each(cases)('bound(bound(x)) === bound(x): %s', (_name, raw) => {
    const once = boundSerpForContext(raw);
    const twice = boundSerpForContext(once.text);
    expect(twice).toEqual(once);
  });

  // Adversarial review C5: the no-citation fallback's head-cap used to slice
  // mid-HOSTNAME — the fragment ("https://www.goo") no longer matched the
  // non-citation host regex, so a re-bound promoted it to a bogus result
  // (resultCount 0→1). Sweep the lead padding so the budget cut lands at every
  // offset through the dropped host: the cut must retreat to whitespace, and
  // every URL surviving in the output must exist VERBATIM in the input.
  it('fallback head-cap never cuts mid-hostname (review C5 padding sweep)', () => {
    for (let pad = 0; pad < 30; pad++) {
      const raw =
        'lead '.repeat(780) + 'p'.repeat(pad) +
        ' https://www.google.com/search?q=cerebras+news ' +
        'tail '.repeat(400);
      const once = boundSerpForContext(raw);
      expect(once.resultCount).toBe(0);
      expect(once.text.length).toBeLessThanOrEqual(SERP_BOUND_MAX_CHARS);
      expect(once.text).toContain('truncated');
      const outUrls = once.text.match(/https?:\/\/[^\s"')\]}>]+/g) || [];
      for (const u of outUrls) expect(raw).toContain(u); // no manufactured fragments
      const twice = boundSerpForContext(once.text);
      expect(twice).toEqual(once); // idempotent across the whole sweep
    }
  });
});

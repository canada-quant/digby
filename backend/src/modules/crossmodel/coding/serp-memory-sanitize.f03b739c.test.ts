/**
 * Ticket f03b739c (2026-10-13) — REPLAY: malformed Bright Data SERP payloads
 * (base64 icons, sxsrf/fbs tokens, pagination arrays, truncated JSON) were
 * embedded verbatim into SESSION MEMORY through the agent loop's tool-result
 * offload paths, polluting every later search_memory retrieval.
 *
 * These suites pin the write-boundary fix from BOTH sides:
 *  1. the pure gate (serp-memory-sanitize.ts): failed search surfaces are
 *     never embedded; SERP payloads distill to titles/links/snippets;
 *     ordinary content is untouched; the kill switch restores the old reading.
 *  2. the agent-loop offload sites (agent.ts — same harness as
 *     agent-offload-honesty.test.ts): a big raw-SERP search_engine result is
 *     stored DISTILLED (no base64, no pagination arrays), and a failed-search
 *     surface stores the compact error record instead of the raw body.
 *  3. the compaction embed path (compaction.ts): a compacted-away SERP tool
 *     result embeds distilled content too.
 *
 * The SERP fixtures below mirror the incident evidence verbatim in shape:
 * base64 webp favicon blobs, google.com/goto?sxsrf|fbs redirect tokens,
 * navigation/pagination arrays, encrypted-tbn image URLs, and the
 * truncated-JSON body whose claimed results_cnt was 2220.
 */

// ── The pure gate ────────────────────────────────────────────────────────────
import {
  sanitizeForMemoryEmbed,
  distillSerpPayload,
  isFailedSearchResult,
  looksLikeSerpPayload,
  failedSearchCompactRecord,
  serpMemorySanitizeDisabled,
} from './serp-memory-sanitize';

// The incident's raw SERP body (shape-preserving): organic results PLUS the
// scaffolding that got embedded chunk by chunk.
const RAW_SERP = JSON.stringify({
  query: 'brightdata serp api pricing',
  results_cnt: 2220,
  search_information: { total_results: 2220, time_taken_displayed: 0.42, query_displayed: 'brightdata serp api pricing' },
  search_parameters: { q: 'brightdata serp api pricing', gl: 'co', hl: 'en', engine: 'google', device: 'desktop' },
  pagination: { current: 1, total: 223, other_pages: { 2: '/search?q=brightdata&start=10', 3: '/search?q=brightdata&start=20' } },
  navigation: [
    { display_text: 'All', link: 'https://www.google.com/search?q=brightdata&tbm=' },
    { display_text: 'Images', link: 'https://www.google.com/search?q=brightdata&tbm=isch' },
  ],
  serpapi_pagination: { next_link: 'https://www.google.com/search?q=brightdata&start=10' },
  organic: [
    {
      position: 1,
      title: 'Bright Data SERP API — Pricing',
      link: 'https://brightdata.com/products/serp-api?gsr=1&sxsrf=APwXEdf ABC123&fbs=abcdef',
      snippet: 'Collect SERP data at scale with the SERP API.',
      favicon: 'data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAf/QQ1JAAA=' +
        'A'.repeat(900),
      sitelinks: { search_box: { link: 'https://www.google.com/search?q=brightdata&si=1' } },
      about_this_result: { source: { description: 'Bright Data homepage' } },
    },
    {
      position: 2,
      title: 'Web Scraper API docs',
      link: 'https://docs.brightdata.com/scraping-automation/serp-api',
      snippet: 'SERP API returns structured JSON with organic results.',
      thumbnail: 'https://encrypted-tbn1.gstatic.com/images?q=tbn:ANd9GcTx',
    },
  ],
  related_searches: [{ query: 'brightdata alternatives' }, { query: 'serp api vs scraperapi' }],
  people_also_ask: [{ question: 'What is a SERP API?', snippet: 'A SERP API returns search results as JSON.' }],
});

const FAILED_SEARCH_PROVIDER_ERROR =
  'Web search failed — the search provider answered with an error instead of results (SERP error, x-brd-error-code=sr_rate_limit, HTTP 429). This is a provider-side failure, NOT an indication that no results exist. Wait briefly (the provider documents a ~15 s floor for query-level bans) and retry, or rephrase the query. Do not treat this as an empty topic: use other tools, your own knowledge, or retry web search shortly.';

const FAILED_SEARCH_NON_JSON =
  'Unexpected non-JSON response from Bright Data for search_engine (truncated body, claimed results_cnt 2220, locale en-CO) — treating as failure.';

describe('serp-memory-sanitize — pure gate (ticket f03b739c)', () => {
  afterEach(() => { delete process.env.SERP_MEMORY_SANITIZE_DISABLED; });

  test('isFailedSearchResult matches both incident failure surfaces', () => {
    expect(isFailedSearchResult(FAILED_SEARCH_PROVIDER_ERROR)).toBe(true);
    expect(isFailedSearchResult(FAILED_SEARCH_NON_JSON)).toBe(true);
    // leading whitespace tolerated
    expect(isFailedSearchResult(`\n\n  ${FAILED_SEARCH_NON_JSON}`)).toBe(true);
    expect(isFailedSearchResult('Web search failed — unrelated prose that merely starts similarly but is not the harness surface')).toBe(false);
    expect(isFailedSearchResult('[Web Search Results]\nQuery: x\n\n{"organic":[]}')).toBe(false);
    expect(isFailedSearchResult('')).toBe(false);
  });

  test('B1 aggravation (PR #1462 review): the THROWN-error wrapper shape matches too', () => {
    // tool-executor.ts:1744 shapes a thrown gateway error as
    // `Tool call failed: <message>. DO NOT retry this tool. …` — the
    // "Unexpected non-JSON response from Bright Data" class arrives WRAPPED
    // in production. The old prefix-only check missed it.
    const wrapped = `Tool call failed: ${FAILED_SEARCH_NON_JSON}. DO NOT retry this tool. Use the information you already have to answer the user's question directly.`;
    expect(isFailedSearchResult(wrapped)).toBe(true);
    // an unrelated Tool call failed: message is NOT a search failure
    expect(isFailedSearchResult('Tool call failed: ENOTFOUND dns error. DO NOT retry this tool.')).toBe(false);
  });

  test('N1 (PR #1462 review): sxsrf/fbs validation tokens are stripped from distilled links', () => {
    const serp = JSON.stringify({
      organic: [
        { title: 'Result one', link: 'https://example.com/page?gsr=1&sxsrf=APwXEdf&fbs=abc&ved=2ahU', snippet: 'Snippet one.' },
        { title: 'Result two', link: 'https://example.com/other?id=42', snippet: 'Snippet two.' },
      ],
    });
    const r = sanitizeForMemoryEmbed(serp);
    expect(r.action).toBe('store');
    expect(r.content).not.toContain('sxsrf=');
    expect(r.content).not.toContain('fbs=');
    expect(r.content).toContain('https://example.com/other?id=42'); // real params kept
  });

  test('looksLikeSerpPayload detects the incident shapes', () => {
    expect(looksLikeSerpPayload(`[Web Search Results]\nQuery: q\n\n${RAW_SERP}`)).toBe(true);
    expect(looksLikeSerpPayload(RAW_SERP)).toBe(true);
    expect(looksLikeSerpPayload('{"organic":[{"title":"t","link":"https://x.com"}]}')).toBe(true);
    expect(looksLikeSerpPayload('ordinary run_command output with no serp markers at all, just text')).toBe(false);
    expect(looksLikeSerpPayload('')).toBe(false);
  });

  test('P4d regression (PR #1462 review): ordinary JSON with a results[] array passes through UNDISTILLED', () => {
    // The reviewer's false-positive case: an audit-style payload whose only
    // SERP resemblance is a `results` array of {title, detail, verdict} — the
    // OLD key-only heuristic distilled it 411 → 52 chars, losing the detail,
    // verdict and summary. The shape gate (link+text items) now keeps it.
    const audit = JSON.stringify({
      results: [
        { title: 'Security audit finding #1', detail: 'Critical: dependency X has a known RCE, upgrade to Y. The exploit path goes through the login flow at src/auth.ts:42 where the token is not validated.', verdict: 'FAIL' },
        { title: 'Security audit finding #2', detail: 'High: the /api endpoint leaks internal headers when called with the debug flag.', verdict: 'WARN' },
      ],
      summary: '2 findings, 1 critical',
    });
    expect(looksLikeSerpPayload(audit)).toBe(false);
    const r = sanitizeForMemoryEmbed(audit);
    expect(r.action).toBe('store');
    expect(r.distilled).toBe(false);
    expect(r.content).toBe(audit); // byte-identical — no data loss
  });

  test('P4d companion: a results[] array WITH link-bearing items still distills (the real SERP shape)', () => {
    const serp = JSON.stringify({
      results: [
        { title: 'Result one', link: 'https://example.com/one', snippet: 'First result snippet.' },
        { title: 'Result two', link: 'https://example.com/two', snippet: 'Second result snippet.', favicon: 'data:image/webp;base64,UklGR' + 'A'.repeat(500) },
      ],
    });
    expect(looksLikeSerpPayload(serp)).toBe(true);
    const r = sanitizeForMemoryEmbed(serp);
    expect(r.action).toBe('store');
    expect(r.distilled).toBe(true);
    expect(r.content).toContain('https://example.com/one');
    expect(r.content).not.toContain('base64');
  });

  test('distillSerpPayload keeps organic titles/links/snippets and drops every scaffolding class', () => {
    const out = distillSerpPayload(RAW_SERP);
    expect(out).toContain('Bright Data SERP API — Pricing');
    expect(out).toContain('https://docs.brightdata.com/scraping-automation/serp-api');
    expect(out).toContain('Collect SERP data at scale with the SERP API.');
    expect(out).toContain('Query: brightdata serp api pricing');
    // scaffolding gone: base64 blobs, pagination, navigation, related, PAA,
    // search_information/parameters, results_cnt
    expect(out).not.toContain('base64');
    expect(out).not.toContain('UklGR');
    expect(out).not.toContain('pagination');
    expect(out).not.toContain('navigation');
    expect(out).not.toContain('related_searches');
    expect(out).not.toContain('people_also_ask');
    expect(out).not.toContain('search_information');
    expect(out).not.toContain('results_cnt');
    expect(out).not.toContain('encrypted-tbn');
    expect(out).not.toContain('sitelinks');
    expect(out).not.toContain('about_this_result');
    expect(out).not.toMatch(/"position"/);
    // massive shrink: the raw body is dominated by the base64 icon blob
    expect(out.length).toBeLessThan(RAW_SERP.length / 4);
  });

  test('distillSerpPayload tolerates the [Web Search Results] wrapper header', () => {
    const out = distillSerpPayload(`[Web Search Results]\nQuery: brightdata serp api pricing\n\n${RAW_SERP}`);
    expect(out).toContain('Bright Data SERP API — Pricing');
    expect(out).not.toContain('base64');
  });

  test('distillSerpPayload returns \'\' for unparseable bodies (never guesses)', () => {
    expect(distillSerpPayload('{"organic": [TRUNCATED')).toBe('');
    expect(distillSerpPayload('plain text not json')).toBe('');
    expect(distillSerpPayload('')).toBe('');
  });

  test('P14 regression (PR #1462 review): a TRUNCATED SERP body — the incident\'s primary class — salvages, never passes through raw', () => {
    // The reviewer's decisive probe: a bare truncated SERP body (no failure
    // prefix, JSON cut mid-base64-favicon) passed through BYTE-IDENTICAL
    // (8053→8053 chars, base64 + pagination + sxsrf all still embedded). The
    // distiller now salvages: bounded truncation repair → distill what
    // survived; else mechanical noise-strip. Never the raw body.
    const good = JSON.stringify({
      query: 'brightdata serp api pricing',
      results_cnt: 2220,
      pagination: { current: 1, total: 223, other_pages: { 2: '/search?q=x&start=10' } },
      navigation: [{ display_text: 'All', link: 'https://www.google.com/search?q=x' }],
      organic: [
        { position: 1, title: 'Bright Data SERP API — Pricing', link: 'https://brightdata.com/products/serp-api?gserp=1&sxsrf=APwXEdf&fbs=abc', snippet: 'Collect SERP data at scale with the SERP API.', favicon: `data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAY${'A'.repeat(4_000)}` },
        { position: 2, title: 'Web Scraper API docs', link: 'https://docs.brightdata.com/scraping-automation/serp-api', snippet: 'SERP API returns structured JSON.', thumbnail: 'https://encrypted-tbn1.gstatic.com/images?q=tbn:ANd9GcTx' },
      ],
    });
    const truncated = good.slice(0, good.length - 2_500); // cut mid-base64-favicon
    expect(() => JSON.parse(truncated)).toThrow(); // the class the old distiller bailed on
    expect(looksLikeSerpPayload(truncated)).toBe(true);
    const r = sanitizeForMemoryEmbed(truncated);
    expect(r.action).toBe('store');
    expect(r.distilled).toBe(true);
    expect(r.content.length).toBeLessThan(truncated.length / 3); // massive shrink, not byte-identical
    expect(r.content).not.toContain('base64');
    expect(r.content).not.toMatch(/A{100}/);
    expect(r.content).toContain('Bright Data SERP API — Pricing'); // complete items survive
  });

  test('P14 worst case: an unrepairable SERP-shaped body still mechanically strips the parse-free noise classes', () => {
    // organic key present (the gate fires), structure too broken to repair,
    // nothing survives distillation — the mechanical strip still shrinks it.
    const garbage = '{"organic":[{"favicon":"data:image/webp;base64,' + 'A'.repeat(5_000);
    expect(looksLikeSerpPayload(garbage)).toBe(true);
    const r = sanitizeForMemoryEmbed(garbage);
    expect(r.action).toBe('store');
    expect(r.content.length).toBeLessThan(200); // 5k of base64 → a strip marker
    expect(r.content).toContain('[base64 icon stripped]');
  });

  test('sanitizeForMemoryEmbed: skip for failed searches, distill for SERP, passthrough otherwise', () => {
    const skippedProvider = sanitizeForMemoryEmbed(FAILED_SEARCH_PROVIDER_ERROR);
    expect(skippedProvider.action).toBe('skip');
    expect(skippedProvider.reason).toBe('failed-search-result');
    const skippedNonJson = sanitizeForMemoryEmbed(FAILED_SEARCH_NON_JSON);
    expect(skippedNonJson.action).toBe('skip');
    expect(skippedNonJson.reason).toBe('failed-search-result');

    const distilled = sanitizeForMemoryEmbed(RAW_SERP);
    expect(distilled.action).toBe('store');
    expect(distilled.distilled).toBe(true);
    expect(distilled.content).not.toContain('base64');

    const untouched = sanitizeForMemoryEmbed('# README\n\nSome ordinary page content that must pass through byte-identical.\n'.repeat(5));
    expect(untouched.action).toBe('store');
    expect(untouched.distilled).toBe(false);
  });

  test('sanitizeForMemoryEmbed keeps the ORIGINAL when a SERP-looking body yields no distillation', () => {
    const weird = '[Web Search Results]\nQuery: q\n\n{"organic": [truncated';
    const r = sanitizeForMemoryEmbed(weird);
    expect(r.action).toBe('store');
    expect(r.content).toBe(weird);
  });

  test('failedSearchCompactRecord is compact and carries no raw body', () => {
    const rec = failedSearchCompactRecord(FAILED_SEARCH_NON_JSON, 'search_engine');
    expect(rec).toContain('search failed');
    expect(rec).toContain('ticket f03b739c');
    expect(rec).not.toContain('base64');
    expect(rec.length).toBeLessThan(400);
    expect(rec).toMatch(/Recorded: \d{4}-\d{2}-\d{2}T/);
  });

  test('kill switch SERP_MEMORY_SANITIZE_DISABLED=1 restores passthrough byte-for-byte', () => {
    process.env.SERP_MEMORY_SANITIZE_DISABLED = '1';
    expect(serpMemorySanitizeDisabled()).toBe(true);
    expect(sanitizeForMemoryEmbed(RAW_SERP)).toEqual({ action: 'store', content: RAW_SERP, distilled: false });
    expect(sanitizeForMemoryEmbed(FAILED_SEARCH_NON_JSON)).toEqual({ action: 'store', content: FAILED_SEARCH_NON_JSON, distilled: false });
  });
});

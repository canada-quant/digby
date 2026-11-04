/**
 * WEB-2 — SEARCH ROUTE POLICY (goal 9ecd595e / todo 9cd3fad1, WRP-1 D1·D2·D3·D5).
 *
 * Every case below is quoted from the reported Polk County run. The OLD
 * behaviour this file fails on: `planNextRoute` / `querySimilarity` /
 * `inferRecency` did not exist, so nothing refused a paraphrase retry, nothing
 * bounded a search to the window the question implied, and nothing told the
 * model that a throttle is a ROUTE change rather than something to narrate.
 *
 * Pinned:
 *   D1 — the exact three searches from the run are one query restated; the
 *        guard refuses the 2nd and 3rd and NAMES the next source class.
 *   D2 — a fresh/news-framed question gets a hard `after:` bound and a window
 *        label; an undated question gets NONE (inventing one would drop the
 *        right answer); stale results are filtered from the candidate set and
 *        the removal is countable.
 *   D3 — the attempt budget, the jittered capped backoff, and the transient
 *        classifier that decides silent-rotate versus honest-degrade.
 *   D5 — an official URL is RESOLVED from a SERP, never constructed; when the
 *        SERP holds no link the caller is told "not found", never "down".
 */
import {
  queryTokens, normalizeQuery, querySimilarity, closestIssued,
  inferRecency, withRecencyBound, filterByRecency,
  planNextRoute, planNextRouteForRun, recordAttempt, newRouteState, nextRouteClass,
  clusterFor, backoffMs, isTransientSearchFailure,
  officialUrlSearchQuery, resolveDomainUrl, exhaustedSearchMessage,
  newsFeedUrl, parseNewsFeed, renderNewsFeed,
  ROUTE_LADDER, PARAPHRASE_SIMILARITY, MAX_ROUTE_ATTEMPTS, BACKOFF_CAP_MS,
} from './web-search-route';

// The three searches the run actually issued, in order.
const Q1 = 'Polk County 281 arrested human trafficking bust';
const Q2 = '"Polk County" 281 arrested human trafficking opera';
const Q3 = 'WESH Polk County 281 arrests human trafficking operation';

describe('WEB-2 D1 — a retry must change the ROUTE, not the wording', () => {
  it('recognises the run\'s three searches as one query restated', () => {
    // All three are above the paraphrase bar, so none could be re-issued.
    expect(querySimilarity(Q1, Q2)).toBeGreaterThanOrEqual(PARAPHRASE_SIMILARITY);
    expect(querySimilarity(Q1, Q3)).toBeGreaterThanOrEqual(PARAPHRASE_SIMILARITY);
    expect(querySimilarity(Q2, Q3)).toBeGreaterThanOrEqual(PARAPHRASE_SIMILARITY);
  });

  it('collapses cosmetic operator/quote noise so a variant compares as identical', () => {
    expect(normalizeQuery('"Polk County" 281 arrested')).toBe(normalizeQuery('polk county 281 arrested!!!'));
    expect(querySimilarity('"Polk County" 281', 'Polk County 281')).toBe(1);
  });

  it('does NOT refuse a genuine new question (no over-blocking)', () => {
    expect(querySimilarity(Q1, 'WESH newsroom contact address')).toBeLessThan(0.34);
  });

  it('refuses the paraphrase and names the next source class', () => {
    const state = newRouteState();
    const first = planNextRoute(Q1, state);
    expect(first.action).toBe('search');
    expect(first.route).toBe('serp');
    recordAttempt(state, Q1, 'serp', false); // came back empty for the window

    const second = planNextRoute(Q2, state);
    expect(second.action).toBe('refuse');            // ← old behaviour: issued it anyway
    expect(second.route).toBe('news_feed');          // the ladder moved to a NEW source class
    expect(second.reason).toContain('restates');
    expect(second.reason).toContain('news feed');
    expect(second.duplicateOf).toBe(Q1);
  });

  it('tells the model to reuse results when the restatement follows a SEARCH THAT WORKED', () => {
    const state = newRouteState();
    recordAttempt(state, Q1, 'serp', true);
    const plan = planNextRoute(Q3, state);
    expect(plan.action).toBe('refuse');
    expect(plan.reason).toContain('ALREADY returned results');
  });

  it('walks the whole ladder exactly once, then reports exhaustion', () => {
    const state = newRouteState();
    expect(planNextRoute(Q1, state).route).toBe('serp');
    recordAttempt(state, Q1, 'serp');
    expect(planNextRoute(Q2, state).route).toBe('news_feed');
    recordAttempt(state, Q2, 'news_feed');
    expect(planNextRoute(Q3, state).route).toBe('direct_outlet');
    expect(ROUTE_LADDER).toContain('primary_domain');
    expect(nextRouteClass(['serp', 'news_feed', 'direct_outlet', 'primary_domain'])).toBeNull();
  });

  it('gives each QUESTION its own budget (a spent ladder never gags a second question)', () => {
    const clusters: any[] = [];
    // Question 1: the first phrasing is searched, the restatement is refused
    // (D1), and the ladder escorts it to the next source class.
    const first = planNextRouteForRun(Q1, clusters);
    expect(first.action).toBe('search');
    recordAttempt(clusterFor(Q1, clusters).cluster.state, Q1, first.route!);
    expect(planNextRouteForRun(Q2, clusters).action).toBe('refuse');

    // Question 2 — a different subject — opens its OWN cluster and is searched
    // normally, unaffected by question 1's spent budget.
    const second = planNextRouteForRun('WESH newsroom contact address', clusters);
    expect(second.action).toBe('search');
    expect(clusters).toHaveLength(2);
    // …and its own ladder starts at the top again.
    expect(second.route).toBe('serp');
  });

  it('spends at most MAX_ROUTE_ATTEMPTS per question', () => {
    expect(MAX_ROUTE_ATTEMPTS).toBe(4);
    const state = newRouteState();
    for (let i = 0; i < MAX_ROUTE_ATTEMPTS; i += 1) recordAttempt(state, `q${i}`, 'serp');
    expect(planNextRoute('fresh different question', state).action).toBe('exhausted');
  });
});

describe('WEB-2 D2 — a hard recency bound derived from the question', () => {
  const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

  it('bounds a fresh news question to the past week and labels the window', () => {
    const b = inferRecency(Q1, NOW); // "(bust", "arrested", a headline — news-shaped
    expect(b.window).toBe('week');
    expect(b.afterDate).toBe('2026-10-24');
    expect(b.label).toBe('past week');
    expect(withRecencyBound(Q1, b)).toBe(`${Q1} after:2026-10-24`);
  });

  it('reads the narrower framings the user actually types', () => {
    expect(inferRecency('what happened today in Polk County', NOW).window).toBe('day');
    expect(inferRecency('polk county news this month', NOW).window).toBe('month');
    expect(inferRecency('polk county trafficking news this year', NOW).window).toBe('year');
  });

  it('leaves an undated question unbounded — inventing a window drops the right answer', () => {
    const b = inferRecency('who founded the Polk County sheriff department', NOW);
    expect(b.window).toBeNull();
    expect(b.afterDate).toBeNull();
    expect(withRecencyBound('who founded X', b)).toBe('who founded X');
  });

  it('honours an explicitly historical framing instead of forcing freshness', () => {
    const b = inferRecency('the 2022 Polk County sting in 2022', NOW);
    expect(b.window).toBeNull();
    expect(b.source).toBe('explicit-year');
  });

  it('does not double-bound a query that already carries after:', () => {
    const b = inferRecency(Q1, NOW);
    expect(withRecencyBound('x after:2020-01-01', b)).toBe('x after:2020-01-01');
  });

  it('filters stale results out of the candidate set and counts them (never eyeballed downstream)', () => {
    const rows = [
      { title: 'fresh', date: '2026-10-30T00:00:00Z' },
      { title: '2023 sting', date: '2023-03-01T00:00:00Z' },
      { title: 'undated', date: null },
      { title: 'prose date', date: '3 days ago' as any },
    ];
    const out = filterByRecency(rows, inferRecency(Q1, NOW), NOW);
    expect(out.removed).toBe(1);
    expect(out.kept.map((r) => r.title)).toEqual(['fresh', 'undated', 'prose date']);
  });

  it('surfaces the window in the plan so the answer can report what was searched', () => {
    const plan = planNextRoute(Q1, newRouteState(), NOW);
    expect(plan.recency.label).toBe('past week');
    expect(plan.query).toContain('after:2026-10-24');
    expect(plan.reason).toContain('past week');
  });
});

describe('WEB-2 D3 — bounded, jittered, silent failover', () => {
  it('backs off exponentially inside a hard cap, with jitter that de-synchronises retries', () => {
    expect(backoffMs(1, 0.5)).toBe(500);
    expect(backoffMs(2, 0.5)).toBe(1000);
    expect(backoffMs(3, 0.5)).toBe(2000);
    expect(backoffMs(10, 0.5)).toBe(BACKOFF_CAP_MS);       // capped, never parks the run
    expect(backoffMs(1, 0)).toBeLessThan(backoffMs(1, 1));  // jitter is real
    expect(backoffMs(1, 0.5)).not.toBe(backoffMs(1, 0.37));
  });

  it('classifies throttle shapes as transient (route change, never an apology)', () => {
    expect(isTransientSearchFailure({ code: 'sr_rate_limit' })).toBe(true);
    expect(isTransientSearchFailure({ code: 'bucket_rate_limit' })).toBe(true);
    expect(isTransientSearchFailure({ status: 429 })).toBe(true);
    expect(isTransientSearchFailure({ status: 503 })).toBe(true);
    expect(isTransientSearchFailure({ retryable: true })).toBe(true);
    // A deterministic query rejection is NOT transient — retrying is futile.
    expect(isTransientSearchFailure({ code: 'unexpected_q', retryable: false })).toBe(false);
    expect(isTransientSearchFailure(null)).toBe(false);
  });

  it('degrades to "here is what I could verify" — no apology, no "source is down"', () => {
    const msg = exhaustedSearchMessage(Q1, ['serp', 'news_feed'], 'the sheriff confirmed an operation');
    expect(msg).toContain('verified');
    expect(msg).toContain('verified/unverified');
    expect(msg).not.toMatch(/sorry|apolog|unfortunately/i);
    expect(msg).toContain('Do NOT report the sources as down');
  });
});

describe('WEB-2 D5 — resolve an official URL, never construct one', () => {
  it('builds a site: query that resolves the real page', () => {
    expect(officialUrlSearchQuery('polksheriff.org', 'news release 281 arrested'))
      .toBe('site:polksheriff.org news release 281 arrested');
    expect(officialUrlSearchQuery('https://www.polksheriff.org/about', 'news'))
      .toBe('site:www.polksheriff.org news');
  });

  it('picks the real newsroom URL out of a SERP, preferring an article path over the homepage', () => {
    const serp = JSON.stringify({ organic: [
      { link: 'https://www.polksheriff.org/', title: 'Home' },
      { link: 'https://www.polksheriff.org/news/press-release-281-arrests', title: 'Press release' },
      { link: 'https://othersite.com/story', title: 'Other' },
    ] });
    expect(resolveDomainUrl(serp, 'polksheriff.org')).toBe('https://www.polksheriff.org/news/press-release-281-arrests');
  });

  it('returns null when the SERP holds no link — the caller says "not found", never "down"', () => {
    expect(resolveDomainUrl(JSON.stringify({ organic: [{ link: 'https://elsewhere.com/x' }] }), 'polksheriff.org')).toBeNull();
    expect(resolveDomainUrl('', 'polksheriff.org')).toBeNull();
  });

  it('ignores assets when choosing the page', () => {
    const serp = 'https://polksheriff.org/, https://polksheriff.org/style.css, https://polksheriff.org/press/281';
    expect(resolveDomainUrl(serp, 'polksheriff.org')).toBe('https://polksheriff.org/press/281');
  });
});

describe('WEB-2 — the news-feed route (a genuinely different source class)', () => {
  it('builds a Google-News RSS URL for the same question', () => {
    expect(newsFeedUrl(Q1)).toContain('news.google.com/rss/search?q=');
    expect(newsFeedUrl(Q1)).toContain(encodeURIComponent(Q1));
  });

  it('parses RSS items into date-bearing rows', () => {
    const xml = `<rss><channel>
      <item><title><![CDATA[281 arrested in Polk County operation]]></title>
        <link>https://wesh.com/article/281</link>
        <pubDate>Fri, 31 Oct 2026 08:00:00 GMT</pubDate>
        <source>WESH</source></item>
      <item><title>Second item &amp; more</title><link>https://example.com/b</link></item>
    </channel></rss>`;
    const rows = parseNewsFeed(xml);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      title: '281 arrested in Polk County operation',
      url: 'https://wesh.com/article/281',
      date: 'Fri, 31 Oct 2026 08:00:00 GMT',
      source: 'WESH',
    });
    expect(rows[1].title).toBe('Second item & more');
    expect(rows[1].date).toBeNull();
  });

  it('renders the window label so the model can report what it searched', () => {
    const rows = [{ title: 'T', url: 'https://a/b', date: 'Fri, 31 Oct 2026 08:00:00 GMT', source: 'WESH' }];
    expect(renderNewsFeed(rows, inferRecency(Q1))).toContain('past week');
    expect(renderNewsFeed([], inferRecency(Q1))).toContain('no items matched');
  });
});

describe('WEB-2 — tokenisation edge cases', () => {
  it('drops stopwords and query operators, keeps the distinctive terms', () => {
    const t = queryTokens('The LATEST news about "Polk County" 281 arrested');
    expect(t.has('the')).toBe(false);
    expect(t.has('latest')).toBe(false);
    expect(t.has('polk')).toBe(true);
    expect(t.has('281')).toBe(true);
  });

  it('an empty/stopword-only query never falsely matches another', () => {
    expect(queryTokens('the of and')).toBeInstanceOf(Set);
    expect(queryTokens('the of and').size).toBe(0);
    expect(querySimilarity('the of and', Q1)).toBe(0);
    expect(closestIssued('the of', [])).toBeNull();
  });
});
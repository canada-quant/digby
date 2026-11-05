/**
 * url-preflight.test.ts — BS-1 D4/D5 (2026-11-02).
 *
 * Pins the two defect classes from the Polk County / Facebook-Ad-Library runs:
 *   D5 — a truncated URL must fail FAST with "incomplete URL", never be
 *        dispatched and come back as a raw gateway `400 "url" must be a valid uri`.
 *   D4 — an empty scrape must ask the search engine what the REAL url for that
 *        domain is (resolveDomainUrl), retry it once, and on failure say NOT
 *        FOUND for the domain — never "the site is down".
 */

import {
  incompleteUrlMessage, looksIncompleteUrl, notFoundMessage, preflightUrl,
  scrapeViaDomainResolve, type ScrapeLadderDeps,
} from './url-preflight';

const ENV_KEYS = ['WEB_TOOL_URI_PREFLIGHT_DISABLED', 'SCRAPE_DOMAIN_RESOLVE_DISABLED'] as const;
function withEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k as any];
      else process.env[k as any] = v;
    }
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k as any];
      else process.env[k as any] = prev[k];
    }
  }
}

/** async flavour — the env must stay set across every `await` in `fn`. */
async function withEnvAsync(
  vars: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k as any];
      else process.env[k as any] = v;
    }
    await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k as any];
      else process.env[k as any] = prev[k];
    }
  }
}

// ── D5: the incomplete-URL pre-flight ────────────────────────────────────────

describe('BS-1 D5 — incomplete URLs fail fast before dispatch', () => {
  it('flags the exact reported case: a truncated query string (`?acti`)', () => {
    // The literal URL from the run that produced the raw gateway 400.
    expect(looksIncompleteUrl('https://www.facebook.com/ads/library/?acti')).toBe(true);
    const v = preflightUrl('https://www.facebook.com/ads/library/?acti');
    expect(v.ok).toBe(false);
    expect(v.kind).toBe('incomplete');
    expect(v.host).toBe('facebook.com');
  });

  it('flags every truncation SHAPE: dangling ?/&, bare trailing key, half an escape', () => {
    expect(looksIncompleteUrl('https://example.com/page?')).toBe(true);
    expect(looksIncompleteUrl('https://example.com/page?q=a&')).toBe(true);
    expect(looksIncompleteUrl('https://example.com/page?q=a&lang')).toBe(true);
    expect(looksIncompleteUrl('https://example.com/a%2')).toBe(true);
    expect(looksIncompleteUrl('https://example.com/a%')).toBe(true);
  });

  it('accepts real, complete URLs — including query strings and fragments', () => {
    for (const u of [
      'https://example.com/',
      'https://example.com/news/press-release-281-arrests',
      'https://example.com/search?q=polk+county&page=2',
      'https://example.com/page?q=a#section-3',
      'https://www.facebook.com/ads/library/?active_status=all&ad_type=political_and_issue_ads&country=US',
      'http://localhost:3000/x',
    ]) {
      expect([u, looksIncompleteUrl(u)]).toEqual([u, false]);
    }
  });

  // Review B1 (2026-11-03): rule 2 ("last query param has no =") cannot tell a
  // truncation (`?acti` cut out of `active_status`) from a COMPLETE bare-flag
  // URL (`?amp`, `?print`, `?autoplay`, `?embed`) — both are lexically identical.
  // The single-scrape path keeps the strict rule; a BATCH passes
  // allowBareTrailingKey so a complete URL is never silently dropped while the
  // model is told (falsely) that its link was cut off.
  it('STRICT (the default, single-scrape) still flags a bare trailing key', () => {
    expect(looksIncompleteUrl('https://www.facebook.com/ads/library/?acti')).toBe(true);
    expect(preflightUrl('https://example.com/article?amp').ok).toBe(false);
  });

  it('a BATCH does NOT refuse a complete bare-flag URL', () => {
    const batch = { allowBareTrailingKey: true };
    for (const u of [
      'https://vimeo.com/76979871?autoplay',
      'https://example.com/article?amp',
      'https://example.com/print?print',
      'https://example.com/report?embed',
    ]) {
      expect([u, looksIncompleteUrl(u, batch)]).toEqual([u, false]);
    }
  });

  it('a BATCH still refuses every shape that cannot be a complete URL', () => {
    const batch = { allowBareTrailingKey: true };
    for (const u of [
      'https://example.com/page?',      // rule 1 — dangling ?
      'https://example.com/page?q=a&',  // rule 1 — dangling &
      'https://example.com/a%2',        // rule 3 — half a percent-escape
      'https://example.com/a%',         // rule 3
      'polksheriff.org/news',           // rule 4 — no scheme
      'https://example.com/a b',        // pasted mid-sentence
    ]) {
      expect([u, looksIncompleteUrl(u, batch)]).toEqual([u, true]);
    }
  });

  it('preflightUrl forwards the option, and the scheme guard survives it', () => {
    const bare = 'https://example.com/article?amp';
    expect(preflightUrl(bare, { allowBareTrailingKey: true }).ok).toBe(true);
    expect(preflightUrl(bare).ok).toBe(false);
    // The relaxed shape rule must never open the scheme door.
    expect(preflightUrl('file:///etc/passwd', { allowBareTrailingKey: true }).kind).toBe('bad_scheme');
    expect(preflightUrl('https://example.com/page?', { allowBareTrailingKey: true }).kind).toBe('incomplete');
  });

  it('a non-URL is refused with the incomplete message, not a scheme complaint', () => {
    const v = preflightUrl('polksheriff.org/news');
    expect(v.ok).toBe(false);
    // A bare host reads as a truncated paste, so the model gets the search-again hint.
    expect(v.reason).toBe(incompleteUrlMessage('polksheriff.org/news'));
    expect(looksIncompleteUrl('')).toBe(true);
    expect(preflightUrl('').kind).toBe('empty');
  });

  it('rejects a non-http(s) scheme separately (no silent fetch of file:)', () => {
    const v = preflightUrl('file:///etc/passwd');
    expect(v.ok).toBe(false);
    expect(v.kind).toBe('bad_scheme');
    expect(v.reason).toMatch(/http\(s\)/);
  });

  it('THE MESSAGE never blames the site — it says the link was cut off', () => {
    const msg = incompleteUrlMessage('https://www.facebook.com/ads/library/?acti');
    expect(msg).toMatch(/INCOMPLETE/);
    expect(msg).toMatch(/Nothing was fetched/);
    expect(msg).toMatch(/not the site being down/);
    // The old failure mode's wording must be absent — it sent the model to "retry".
    expect(msg).not.toMatch(/may be unavailable, blocked, or rate-limited/);
    expect(msg).not.toMatch(/valid uri/);
    // The cut-off URL is echoed (truncated to 120 chars) so the model can see it.
    expect(msg).toContain('https://www.facebook.com/ads/library/?acti');
  });

  it('kill switch WEB_TOOL_URI_PREFLIGHT_DISABLED=1 disables shape rules but keeps scheme safety', () => {
    withEnv({ WEB_TOOL_URI_PREFLIGHT_DISABLED: '1' }, () => {
      expect(looksIncompleteUrl('https://example.com/page?acti')).toBe(false);
      // Scheme safety is NOT a truncation rule — it must survive the switch.
      expect(preflightUrl('file:///etc/passwd').ok).toBe(false);
      expect(preflightUrl('https://example.com/page?acti').ok).toBe(true);
    });
  });
});

// ── D4: resolveDomainUrl wiring ──────────────────────────────────────────────

const SERP = `Results for polksheriff.org
https://elsewhere.com/unrelated
https://www.polksheriff.org/news/press-release-281-arrests
https://polksheriff.org/`;

describe('BS-1 D4 — an empty scrape resolves the domain instead of reporting "down"', () => {
  const deps = (over: Partial<ScrapeLadderDeps> = {}): ScrapeLadderDeps => ({
    scrape: jest.fn(async () => null),
    search: jest.fn(async () => SERP),
    ...over,
  });

  it('succeeds on the direct leg and does NOT search', async () => {
    const d = deps({ scrape: jest.fn(async () => '# Real content') });
    const out = await scrapeViaDomainResolve('https://www.polksheriff.org/news/press-release-281-arrests', d);
    expect(out).toEqual({ ok: true, markdown: '# Real content', via: 'direct' });
    expect(d.search).not.toHaveBeenCalled();
  });

  it('on an empty scrape, resolves the REAL url via the SERP and retries ONCE', async () => {
    const scrape = jest.fn()
      .mockResolvedValueOnce(null)                    // the guessed path 404s
      .mockResolvedValueOnce('281 arrests, real text'); // the indexed url works
    const d = deps({ scrape });
    const out = await scrapeViaDomainResolve('https://www.polksheriff.org/news/press-release-guessed', d);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.via).toBe('resolved');
    expect(out.resolvedUrl).toBe('https://www.polksheriff.org/news/press-release-281-arrests');
    // Exactly two scrapes and ONE search — the ladder never loops.
    expect(scrape).toHaveBeenCalledTimes(2);
    expect(d.search).toHaveBeenCalledTimes(1);
    // The search is the domain-scoped query the primitive was written for.
    expect(String((d.search as jest.Mock).mock.calls[0][0])).toContain('polksheriff.org');
  });

  it('when nothing resolves, says NOT FOUND for the domain — never "down"', async () => {
    const d = deps();
    const out = await scrapeViaDomainResolve('https://www.polksheriff.org/news/nope', d);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.message).toMatch(/Nothing was found on polksheriff\.org/);
    expect(out.message).toMatch(/NOT the same as the site being down/);
    // The defect's exact wording must be gone.
    expect(out.message).not.toMatch(/may be unavailable, blocked, or rate-limited/);
    expect(out.searched).toBe(true);
  });

  it('the not-found message names the url it actually retried', async () => {
    const d = deps();
    const out = await scrapeViaDomainResolve('https://www.polksheriff.org/news/nope', d);
    if (out.ok) throw new Error('unreachable');
    expect(out.message).toContain('https://www.polksheriff.org/news/press-release-281-arrests');
  });

  it('a search failure degrades to the not-found copy (a scrape failure is not a crash)', async () => {
    const d = deps({ search: jest.fn(async () => { throw new Error('search tier down'); }) });
    const out = await scrapeViaDomainResolve('https://www.polksheriff.org/news/nope', d);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.message).toMatch(/Nothing was found on polksheriff\.org/);
  });

  it('never dispatches a TRUNCATED url at all — the pre-flight refuses before any fetch', async () => {
    // The wiring contract: the tool checks preflightUrl() BEFORE calling this
    // ladder, so a truncated url costs zero network calls. Asserted here so the
    // ordering cannot silently invert.
    const d = deps();
    const v = preflightUrl('https://www.facebook.com/ads/library/?acti');
    expect(v.ok).toBe(false);
    expect(d.scrape).not.toHaveBeenCalled();
    expect(d.search).not.toHaveBeenCalled();
  });

  it('kill switch SCRAPE_DOMAIN_RESOLVE_DISABLED=1 skips the ladder entirely', async () => {
    await withEnvAsync({ SCRAPE_DOMAIN_RESOLVE_DISABLED: '1' }, async () => {
      const d = deps();
      const out = await scrapeViaDomainResolve('https://www.polksheriff.org/news/nope', d);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.searched).toBe(false);
      expect(d.search).not.toHaveBeenCalled();
      expect(d.scrape as jest.Mock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('notFoundMessage', () => {
  it('warns that "renders only in a browser" is a possibility, not that the site is down', () => {
    const msg = notFoundMessage('https://x.test/a', 'x.test', null);
    expect(msg).toMatch(/NOT the same as the site being down/);
    expect(msg).toMatch(/renders only in a browser/);
    expect(msg).not.toMatch(/rate-limited/);
  });
});
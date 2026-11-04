/**
 * SERP provider-error guard — ticket 9b944f30 (replay).
 *
 * THE INCIDENT (live repro in the ticket, 2026-10-07): a web_pipe query for
 * "Bouncing Angels Xtreme Dance Dome inflatable disco dome in stock" returned
 * a "successful" digest whose ONLY embedded source was
 * https://docs.brightdata.com/scraping-automation/serp-api/debugging — the
 * search provider's own troubleshooting page. BrightData's MCP gateway tier
 * had wrapped a provider failure (429 sr_rate_limit auto-throttle / 502 with
 * x-brd-error-code) as a SUCCESSFUL tool result whose text was the error body
 * linking its docs; web_pipe's topLinks non-JSON fallback extracted the docs
 * URL as the sole "source", scraped it (the docs serve fine), stored it to
 * session RAG and digested it as a healthy call. The recurrence is documented
 * since 2026-09-25 (release-roundup search) and 2026-09-27 (identical
 * Bright-Data-docs-as-source signature) — worked around by hand each time.
 *
 * THE FIX under test:
 *  1. serpProviderErrorDetail detects the provider error body (catalog codes,
 *     x-brd-error-code header text, auto-throttle phrasing, req_id + vendor
 *     docs link) and web_pipe returns an explicit "search backend failed
 *     (SERP error)" naming the code — NO scrape, NO store, NO digest.
 *  2. Transient classes (rate-limit/challenge) get ONE backoff retry.
 *  3. Even an unknown-shape error body leaking a vendor URL never becomes a
 *     source: search-derived targets on the provider's own host are dropped
 *     on the non-JSON (regex-fallback) path.
 *  4. A legitimate SERP whose organic results point at the vendor (a query
 *     ABOUT BrightData) stays healthy — the guard only fires on non-JSON
 *     error bodies.
 */

import { runWebPipe } from './web-pipe';
import {
  isProviderSourceUrl,
  serpProviderErrorDetail,
  serpBackendFailedSummary,
  serpCarriesOrganic,
} from '../serp-provider-guard';
import { callMcpTool } from '../mcp-search';
import { storeFindings } from './coding-retrieval.service';
import axios from 'axios';

jest.mock('../mcp-search', () => ({ callMcpTool: jest.fn(), extractPdfTextFromUrl: jest.fn() }));
jest.mock('./coding-retrieval.service', () => ({ storeFindings: jest.fn().mockResolvedValue(7) }));
// model-roles seam (qwenSummarize resolves the coding_helper seat): unset →
// built-in SUMMARY_MODEL, behavior identical (same idiom as web-pipe.test.ts).
jest.mock('../model-endpoints/model-roles.service', () => ({ __esModule: true, resolveRoleModel: jest.fn(async () => '') }));
jest.mock('axios');
jest.mock('../../../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const mockMcp = callMcpTool as jest.Mock;
const mockStore = storeFindings as jest.Mock;
const mockPost = (axios.post as jest.Mock);

// ── Fixtures shaped like the real incident payloads ───────────────────────────

/** The exact URL the incident ingested as its sole "source". */
const INCIDENT_DOCS_URL =
  'https://docs.brightdata.com/scraping-automation/serp-api/debugging#serp-api-error-catalog';

/** The provider's 429 body as BrightData's MCP tier returns it in content
 *  text (headers flattened into the body by the MCP wrapper). */
const SERP_429_BODY = [
  'HTTP/1.1 429 The request was auto-throttled due to low success rate',
  'x-brd-error-code: sr_rate_limit',
  'x-brd-error: The request was auto-throttled due to low success rate. Please decrease your request rate to 60/min.',
  `See https://docs.brightdata.com/scraping-automation/serp-api/debugging for the error catalog.`,
  'req_id=hl_d09913c7_a1lw123bkcg',
].join('\n');

/** A 502 query-mismatch body (deterministic — the identical query fails
 *  identically, so no retry). */
const SERP_502_UNEXPECTED_Q = [
  'HTTP/1.1 502 Bad Gateway',
  'x-brd-error-code: unexpected_q',
  'x-brd-error: Search query mismatch',
].join('\n');

/** The exact query from the ticket's live repro. */
const INCIDENT_QUERY = 'Bouncing Angels Xtreme Dance Dome inflatable disco dome in stock';

/** A healthy brd_json SERP (organic array) — must NEVER be treated as an error. */
const HEALTHY_SERP = JSON.stringify({
  organic: [
    { link: 'https://bouncingangels.com/xtreme-dance-dome', title: 'Xtreme Dance Dome — Bouncing Angels' },
    { link: 'https://www.partyrentals.ca/disco-dome', title: 'Disco Dome Rental' },
  ],
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DASHSCOPE_API_KEY = 'test-key';
  mockPost.mockResolvedValue({ data: { choices: [{ message: { content: 'DIGEST: healthy' } }] } });
});

// ── THE INCIDENT REPLAY ───────────────────────────────────────────────────────

describe('ticket 9b944f30 — the incident replay (provider error body → was a healthy digest)', () => {
  test('THE REPRO: a SERP that is the provider\'s 429 error body is NOT ingested — explicit failure, no scrape/store/digest', async () => {
    mockMcp.mockImplementation(async (tool: string) => {
      if (tool === 'search_engine') return SERP_429_BODY;
      return 'docs page markdown '.repeat(100); // the docs scrape WOULD succeed — must never happen
    });
    const r = await runWebPipe('sess-9b944f30-1', { query: INCIDENT_QUERY, focus: 'stock, price, lead time, Canada shipping' }, undefined, { sameHostGapMs: 0, serpRetryMs: 0 });
    // THE BUG (pre-fix): ok:true with docs.brightdata.com as the sole source.
    expect(r.ok).toBe(false);
    expect(r.sources).toEqual([]);          // the provider's docs NEVER become a source
    expect(r.storedChunks).toBe(0);         // never stored to session RAG
    expect(mockStore).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled(); // no digest model call — nothing to digest
    // the failure is EXPLICIT and names the provider error code (throttle vs block)
    expect(r.summary).toContain('search backend failed (SERP error)');
    expect(r.summary).toContain('sr_rate_limit');
    expect(r.summary).toContain('HTTP 429');
    expect(r.summary).toContain('req_id=hl_d09913c7_a1lw123bkcg');
    // the provider's docs page was never scraped
    expect(mockMcp.mock.calls.filter(c => c[0] === 'scrape_as_markdown')).toHaveLength(0);
  });

  test('the transient 429 class gets ONE backoff retry — and succeeds when the retry answers healthy', async () => {
    const serpCalls: string[] = [];
    mockMcp.mockImplementation(async (tool: string) => {
      if (tool === 'search_engine') {
        serpCalls.push(serpCalls.length === 0 ? 'first' : 'retry');
        return serpCalls.length === 1 ? SERP_429_BODY : HEALTHY_SERP;
      }
      return 'product page markdown '.repeat(50);
    });
    const r = await runWebPipe('sess-9b944f30-2', { query: INCIDENT_QUERY }, undefined, { sameHostGapMs: 0, serpRetryMs: 0 });
    expect(serpCalls).toEqual(['first', 'retry']); // exactly one retry
    expect(r.ok).toBe(true);                       // the retry recovered — normal pipeline
    expect(r.sources.map(s => s.url)).toEqual([
      'https://bouncingangels.com/xtreme-dance-dome',
      'https://www.partyrentals.ca/disco-dome',
    ]);
    expect(mockStore).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test('the retry happens AFTER a real backoff delay (default policy: one bounded wait, not a hammer)', async () => {
    mockMcp.mockImplementation(async (tool: string) => (tool === 'search_engine' ? SERP_429_BODY : 'x'.repeat(500)));
    await runWebPipe('sess-9b944f30-3', { query: INCIDENT_QUERY }, undefined, { sameHostGapMs: 0, serpRetryMs: 25 });
    expect(mockMcp.mock.calls.filter(c => c[0] === 'search_engine')).toHaveLength(2);
  });

  test('unexpected_q (502, deterministic query mismatch) fails fast — NO retry of the identical query', async () => {
    mockMcp.mockImplementation(async (tool: string) => (tool === 'search_engine' ? SERP_502_UNEXPECTED_Q : 'x'.repeat(500)));
    const r = await runWebPipe('sess-9b944f30-4', { query: 'same identical query' }, undefined, { sameHostGapMs: 0, serpRetryMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('unexpected_q');
    expect(r.summary).toMatch(/rephrase/i);
    // deterministic: retrying the identical query fails identically → zero retries
    expect(mockMcp.mock.calls.filter(c => c[0] === 'search_engine')).toHaveLength(1);
    expect(mockStore).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });
});

// ── Second layer: the provider-host filter (unknown-shape error bodies) ──────

describe('ticket 9b944f30 — provider-host filter on the non-JSON search path', () => {
  test('an unknown-shape error body whose only link is the vendor docs URL yields zero sources (was: docs-as-source)', async () => {
    // No catalog code, no auto-throttle phrasing — just an HTML-ish error page
    // linking the vendor's docs. The first detection layer does not fire; the
    // host filter must still refuse to ingest the vendor page as a "source".
    const UNKNOWN_SHAPE = [
      '<html><body><h1>Upstream error</h1>',
      '<p>The search backend could not complete this request.</p>',
      `<p>See <a href="${INCIDENT_DOCS_URL}">troubleshooting</a> for details.</p>`,
      '</body></html>',
    ].join('\n');
    mockMcp.mockImplementation(async (tool: string) => {
      if (tool === 'search_engine') return UNKNOWN_SHAPE;
      return 'docs page markdown '.repeat(100);
    });
    const r = await runWebPipe('sess-9b944f30-5', { query: INCIDENT_QUERY }, undefined, { sameHostGapMs: 0, serpRetryMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.sources).toEqual([]);
    expect(mockStore).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockMcp.mock.calls.filter(c => c[0] === 'scrape_as_markdown')).toHaveLength(0);
    expect(r.summary).toContain("search provider's own host");
  });

  test('GIVEN urls are never filtered — reading the vendor\'s docs on purpose is a legitimate ask', async () => {
    mockMcp.mockResolvedValue('vendor docs content '.repeat(100));
    const r = await runWebPipe('sess-9b944f30-6', { urls: [INCIDENT_DOCS_URL] }, undefined, { sameHostGapMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.sources.map(s => s.url)).toEqual([INCIDENT_DOCS_URL]);
    expect(mockStore).toHaveBeenCalledTimes(1);
  });

  test('a JSON SERP whose organic results legitimately include brightdata.com (a query ABOUT the provider) keeps them', async () => {
    const aboutSerp = JSON.stringify({
      organic: [
        { link: INCIDENT_DOCS_URL, title: 'SERP troubleshooting — Bright Data' },
        { link: 'https://brightdata.com/products/serp-api', title: 'SERP API product page' },
      ],
    });
    mockMcp.mockImplementation(async (tool: string) => {
      if (tool === 'search_engine') return aboutSerp;
      return 'bright data docs content '.repeat(100);
    });
    const r = await runWebPipe('sess-9b944f30-7', { query: 'BrightData SERP API error codes sr_rate_limit' }, undefined, { sameHostGapMs: 0, serpRetryMs: 0 });
    expect(r.ok).toBe(true); // a real organic result set is never an error page
    expect(r.sources).toHaveLength(2);
    expect(mockStore).toHaveBeenCalledTimes(1);
  });
});

// ── Guard unit tests (pure) ──────────────────────────────────────────────────

describe('ticket 9b944f30 review — false-positive vectors (probe-proven, now anchored)', () => {
  test('a HEALTHY non-JSON SERP mentioning "Verifying your domain" is NOT a provider error (bare "verifying" is ordinary English)', async () => {
    // The reviewer's probe killed this healthy search pre-fix: bare-word
    // "Verifying" matched the catalog and the pipe declared a SERP error.
    const healthyNonJson = [
      'Verifying your domain ownership in Google Search Central — troubleshooting guide',
      'https://support.google.com/webmasters/answer/9008080',
      'https://developers.google.com/search/docs'
    ].join('\n');
    expect(serpProviderErrorDetail(healthyNonJson)).toBeNull();
    mockMcp.mockImplementation(async (tool: string) => {
      if (tool === 'search_engine') return healthyNonJson;
      return 'google webmaster guide content '.repeat(100);
    });
    const r = await runWebPipe('sess-9b944f30-fp1', { query: 'verify domain ownership google search console' }, undefined, { sameHostGapMs: 0, serpRetryMs: 0 });
    expect(r.ok).toBe(true);                                  // healthy search SURVIVES
    expect(r.summary).toContain('DIGEST: healthy');
    expect(mockMcp.mock.calls.filter(c => c[0] === 'search_engine')).toHaveLength(1); // no burned retry
    expect(r.sources.map(s => s.url)).toEqual([
      'https://support.google.com/webmasters/answer/9008080',
      'https://developers.google.com/search/docs',
    ]);
  });

  test('an "auto-throttle" article page with NO vendor anchor is NOT a provider error', () => {
    // Pre-fix, the unanchored "auto-throttled" phrase classified this as an error.
    expect(serpProviderErrorDetail('How APIs auto-throttle: a guide to rate limits. See https://en.wikipedia.org/wiki/Rate_limiting for background.')).toBeNull();
    // The same phrasing WITH a vendor anchor (the docs link the real error bodies carry) still fires.
    expect(serpProviderErrorDetail('The request was auto-throttled. See https://docs.brightdata.com/scraping-automation/serp-api/debugging')).not.toBeNull();
  });

  test('a bare catalog code with zero vendor anchor does NOT fire layer 1 (falls to layer 2 — still never ingested)', () => {
    // "sr_rate_limit" alone, no header name, no vendor link, no req_id.
    expect(serpProviderErrorDetail('error: sr_rate_limit while fetching')).toBeNull();
    // The header form is STRONG and fires standalone.
    expect(serpProviderErrorDetail('x-brd-error-code: sr_rate_limit')).not.toBeNull();
  });

  test('the header-form STRONG trigger fires standalone for every catalog code', () => {
    for (const code of ['sr_rate_limit', 'bucket_rate_limit', 'failed_query_rejected', 'repeat_query_rejected', 'client_10110', 'verifying', 'unexpected_q']) {
      expect(serpProviderErrorDetail(`x-brd-error-code: ${code}\nx-brd-error: detail`)).not.toBeNull();
    }
  });

  test('a prefixed organic JSON (stray non-JSON prefix) is a real result set, not an error (serp-redirects idiom)', () => {
    const prefixed = `Here are the results:\n${JSON.stringify({ organic: [{ link: 'https://a.example/one', title: 'One' }] })}`;
    expect(serpCarriesOrganic(prefixed)).toBe(true);
    expect(serpProviderErrorDetail(prefixed)).toBeNull();
  });

  test('query-ban codes state a 15 s minimum wait → NO in-band retry (the vendor bans the query 15 s; an immediate retry re-burns it)', async () => {
    const bannedBody = [
      'HTTP/1.1 429 Too Many Requests',
      'x-brd-error-code: failed_query_rejected',
      'x-brd-error: This query recently failed and cannot be attempted at this time. Please try again later, after a minimum of 15 seconds.',
    ].join('\n');
    mockMcp.mockImplementation(async (tool: string) => (tool === 'search_engine' ? bannedBody : 'x'.repeat(500)));
    const r = await runWebPipe('sess-9b944f30-w1', { query: 'a recently failed query' }, undefined, { sameHostGapMs: 0, serpRetryMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('failed_query_rejected');
    expect(r.summary).toMatch(/15 s minimum|minimum.*15/i);
    expect(mockMcp.mock.calls.filter(c => c[0] === 'search_engine')).toHaveLength(1); // ZERO retries
    expect(mockStore).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('x-brd-rate-limit-period-ms is honored: a stated 60 s period blocks the 3 s in-band retry', async () => {
    const periodBody = [
      'x-brd-error-code: bucket_rate_limit',
      'x-brd-error: Your system is sending too many of this type of request.',
      'x-brd-rate-limit-period-ms: 60000',
    ].join('\n');
    mockMcp.mockImplementation(async (tool: string) => (tool === 'search_engine' ? periodBody : 'x'.repeat(500)));
    const r = await runWebPipe('sess-9b944f30-w2', { query: 'rate limited query' }, undefined, { sameHostGapMs: 0, serpRetryMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('bucket_rate_limit');
    expect(mockMcp.mock.calls.filter(c => c[0] === 'search_engine')).toHaveLength(1); // ZERO retries
  });

  test('a null retry (gateway died mid-backoff) still names attempt-1\'s provider code', async () => {
    let serpCalls = 0;
    mockMcp.mockImplementation(async (tool: string) => {
      if (tool === 'search_engine') {
        serpCalls++;
        return serpCalls === 1 ? SERP_429_BODY : null; // retry reaches a dead gateway
      }
      return 'x'.repeat(500);
    });
    const r = await runWebPipe('sess-9b944f30-w3', { query: INCIDENT_QUERY }, undefined, { sameHostGapMs: 0, serpRetryMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('sr_rate_limit');            // attempt-1's code preserved
    expect(r.summary).toContain('retry then failed');        // the honest second failure
    expect(mockStore).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('ticket 9b944f30 review — the pre-unwrap wrapper hole (post-unwrap filter)', () => {
  test('a google.com/url?q=<vendor docs> wrapper (locally decodable, no network) resolving to the provider host is dropped POST-unwrap', async () => {
    // Pre-fix, the host filter ran BEFORE unwrapSerpLinks and saw google.com —
    // the wrapper resolved to docs.brightdata.com and was scraped+stored.
    const wrapperSerp = [
      'Upstream error — see the troubleshooting guide:',
      'https://www.google.com/url?q=https://docs.brightdata.com/scraping-automation/serp-api/debugging',
    ].join('\n');
    mockMcp.mockImplementation(async (tool: string) => {
      if (tool === 'search_engine') return wrapperSerp;
      return 'vendor docs markdown '.repeat(100); // the docs scrape WOULD succeed
    });
    const r = await runWebPipe('sess-9b944f30-u1', { query: INCIDENT_QUERY }, undefined, { sameHostGapMs: 0, serpRetryMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.sources).toEqual([]);       // never a source, even via a wrapper
    expect(r.storedChunks).toBe(0);
    expect(mockStore).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockMcp.mock.calls.filter(c => c[0] === 'scrape_as_markdown')).toHaveLength(0);
    expect(r.summary).toMatch(/provider's own host|search backend failed/i);
  });

  test('a GIVEN google.com/url?q=<vendor docs> wrapper resolving to the provider docs is NOT dropped (explicit caller choice)', async () => {
    mockMcp.mockResolvedValue('vendor docs markdown '.repeat(100));
    const r = await runWebPipe('sess-9b944f30-u2', { urls: ['https://www.google.com/url?q=https://docs.brightdata.com/scraping-automation/serp-api/debugging'] }, undefined, { sameHostGapMs: 0 });
    expect(r.ok).toBe(true);
    // unwrapped to the real docs URL (the wrapper carried no #fragment) and KEPT
    expect(r.sources.map(s => s.url)).toEqual(['https://docs.brightdata.com/scraping-automation/serp-api/debugging']);
    expect(mockStore).toHaveBeenCalledTimes(1);
  });
});

describe('serpProviderErrorDetail — classification', () => {
  test('the 429 incident body: code + status + reqId + retryable', () => {
    const e = serpProviderErrorDetail(SERP_429_BODY)!;
    expect(e).not.toBeNull();
    expect(e.code).toBe('sr_rate_limit');
    expect(e.status).toBe(429);
    expect(e.reqId).toBe('hl_d09913c7_a1lw123bkcg');
    expect(e.retryable).toBe(true);
  });

  test('unexpected_q is NOT retryable (query mismatch is deterministic)', () => {
    const e = serpProviderErrorDetail(SERP_502_UNEXPECTED_Q)!;
    expect(e.code).toBe('unexpected_q');
    expect(e.retryable).toBe(false);
  });

  test('every catalog 429 code is detected (bucket_rate_limit, failed_query_rejected, repeat_query_rejected, client_10110, verifying)', () => {
    for (const code of ['bucket_rate_limit', 'failed_query_rejected', 'repeat_query_rejected', 'client_10110', 'verifying']) {
      const e = serpProviderErrorDetail(`x-brd-error-code: ${code}\nx-brd-error: throttle detail`);
      expect(e).not.toBeNull();
      expect(e!.code).toBe(code);
      expect(e!.retryable).toBe(true);
    }
  });

  test('a healthy brd_json SERP is NEVER an error (organic[] present)', () => {
    expect(serpProviderErrorDetail(HEALTHY_SERP)).toBeNull();
    expect(serpCarriesOrganic(HEALTHY_SERP)).toBe(true);
    // even when the organic SNIPPETS discuss provider error codes
    const aboutSerp = JSON.stringify({ organic: [{ link: INCIDENT_DOCS_URL, title: 'sr_rate_limit explained' }] });
    expect(serpProviderErrorDetail(aboutSerp)).toBeNull();
  });

  test('ordinary pages that merely mention throttling are NOT errors', () => {
    expect(serpProviderErrorDetail('Rate limiting explained: how APIs throttle clients and what to do about it.')).toBeNull();
    expect(serpProviderErrorDetail('Try again later — the site is busy right now.')).toBeNull();
    expect(serpProviderErrorDetail('')).toBeNull();
  });

  
});

describe('isProviderSourceUrl — host matching', () => {
  test('brightdata.com and every subdomain match; lookalikes do not', () => {
    expect(isProviderSourceUrl('https://brightdata.com/')).toBe(true);
    expect(isProviderSourceUrl('https://docs.brightdata.com/scraping-automation/serp-api/debugging')).toBe(true);
    expect(isProviderSourceUrl('https://api.brightdata.com/request')).toBe(true);
    expect(isProviderSourceUrl('https://brightdata.com.evil.com/x')).toBe(false); // suffix, not subdomain
    expect(isProviderSourceUrl('https://notbrightdata.com/')).toBe(false);
    expect(isProviderSourceUrl('https://example.com/?ref=docs.brightdata.com')).toBe(false); // query, not host
    expect(isProviderSourceUrl('not a url')).toBe(false);
  });
});

describe('serpBackendFailedSummary — the explicit failure text', () => {
  test('names the provider, the code, HTTP status and req_id', () => {
    const s = serpBackendFailedSummary({ code: 'sr_rate_limit', status: 429, reqId: 'hl_d09913c7_a1lw123bkcg', retryable: true, snippet: '…' });
    expect(s).toContain('search backend failed (SERP error)');
    expect(s).toContain('x-brd-error-code=sr_rate_limit');
    expect(s).toContain('HTTP 429');
    expect(s).toContain('req_id=hl_d09913c7_a1lw123bkcg');
    expect(s).toContain('not scraped or stored');
    expect(s).toMatch(/backing off|rephrase/i);
  });
});

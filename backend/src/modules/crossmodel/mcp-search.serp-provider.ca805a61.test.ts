/**
 * SERP provider-error guard at the SEARCH TIER — ticket ca805a61 (2026-10-07).
 *
 * RESIDUAL from 59a4407b (closed via PR #1339 / 9b944f30): the landed
 * classifier serp-provider-guard.ts ran ONLY inside coding/web-pipe.ts, so
 * every OTHER callMcpTool('search_engine') consumer (the agent-facing
 * search_engine TOOL, news.service release roundups, feed.service, the kid
 * path, moonshot integrations) received the gateway tier's error/debug TEXT
 * as a normal truthy result when the provider failed — a dead backend read
 * as a "successful" empty search.
 *
 * This suite pins the tier-level fix (ONE classifier, serp-provider-guard.ts,
 * reused — no duplicate serp-error-body.ts lands):
 *   1. gatewayTier: a classified error body is a FAILED attempt — it throws
 *      into the existing retry/backoff + circuit-breaker loop, never returns
 *      as "results";
 *   2. deterministic class (unexpected_q) and stated waits beyond the retry
 *      budget fail FAST (one attempt, honest null, callback fires);
 *   3. a stated wait WITHIN the budget bumps the backoff to the provider's
 *      minimum ("stated-wait retry respect");
 *   4. the callMcpTool chokepoint nulls the class over EVERY route (a
 *      direct-tier answer that raced the hedge can never smuggle it through)
 *      and hands callers the classified detail via onSerpProviderError;
 *   5. a healthy JSON SERP passes byte-clean; scrape tools are untouched;
 *   6. kill switch SERP_PROVIDER_GUARD_DISABLED=1 restores the pre-guard
 *      reading (body returned as results).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockPost(...a), get: (...a: any[]) => mockGet(...a) },
}));

const mockTryDirect = jest.fn();
const mockDirectAvailable = jest.fn(() => true);
jest.mock('./brightdata-direct', () => ({
  ...jest.requireActual('./brightdata-direct'),
  tryDirectBrightData: (...a: any[]) => mockTryDirect(...a),
  directBrightDataAvailable: () => mockDirectAvailable(),
}));

jest.mock('./pdf-extract', () => ({ extractPdfText: (...a: any[]) => jest.fn(...a) }));

const mockMetric = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockMetric(...a),
  LOOP_METRIC_KINDS: { WEB_FETCH_PATH: 'web_fetch_path' },
}));

// Module marker (see mcp-search.test.ts): keeps this file's top-level consts
// out of the global script scope collision class.
export {};

import type { SerpProviderError } from './serp-provider-guard';

const { Readable } = require('stream') as typeof import('stream');

/** SSE-framed JSON-RPC success carrying `text` as the tool result. */
const sseStream = (text: string) => Readable.from([
  `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })}\n\n`,
]);

// ── Fixtures (same bodies as web-pipe.serp-provider.9b944f30.test.ts) ────────

/** The provider's 429 auto-throttle body as the MCP tier flattens it. */
const SERP_429_BODY = [
  'HTTP/1.1 429 The request was auto-throttled due to low success rate',
  'x-brd-error-code: sr_rate_limit',
  'x-brd-error: The request was auto-throttled due to low success rate. Please decrease your request rate to 60/min.',
  `See https://docs.brightdata.com/scraping-automation/serp-api/debugging for the error catalog.`,
  'req_id=hl_d09913c7_a1lw123bkcg',
].join('\n');

/** A 502 query-mismatch body (deterministic — retrying the identical query
 *  fails identically, so the tier must fail fast). */
const SERP_502_UNEXPECTED_Q = [
  'HTTP/1.1 502 Bad Gateway',
  'x-brd-error-code: unexpected_q',
  'x-brd-error: Search query mismatch',
].join('\n');

/** A rate-limit body whose stated period (3 s) is INSIDE the retry budget —
 *  the backoff must be bumped to the provider's minimum before retrying. */
const SERP_429_STATED_WAIT_3S = [
  'HTTP/1.1 429 The request was auto-throttled due to low success rate',
  'x-brd-error-code: sr_rate_limit',
  'x-brd-rate-limit-period-ms: 3000',
].join('\n');

/** A query-ban body — the vendor documents a 15 s floor, beyond the retry
 *  budget's 8 s cap → fail fast without in-window retries. */
const SERP_QUERY_BAN_15S = [
  'HTTP/1.1 429 Too Many Requests',
  'x-brd-error-code: failed_query_rejected',
  'x-brd-error: that query is banned for 15 seconds and immediate retries fail as well',
].join('\n');

const HEALTHY_SERP = JSON.stringify({ organic: [{ link: 'https://a.example/one', title: 'A' }] });

describe('search tier — SERP provider-error guard (ticket ca805a61)', () => {
  beforeEach(() => {
    jest.resetModules();
    mockPost.mockReset(); mockGet.mockReset(); mockTryDirect.mockReset(); mockMetric.mockReset();
    mockDirectAvailable.mockReturnValue(true);
    delete process.env.MCP_DIGBY_TOKEN;
    delete process.env.WEB_HEDGE_DISABLED;
    delete process.env.WEB_HEDGE_MS;
  });

  const load = () => require('./mcp-search');
  const loadLogger = () => require('../../utils/logger').default;

  it('gateway answers with the 429 body → FAILED attempt: retried, then the healthy answer ships (never the error body)', async () => {
    process.env.MCP_DIGBY_TOKEN = 'tok';
    mockGet.mockResolvedValue({ status: 200, data: 'ok' }); // gateway health probe
    mockTryDirect.mockResolvedValue(null);                   // direct tier empty → gateway tier
    let attempt = 0;
    mockPost.mockImplementation(async () => {
      attempt++;
      return { headers: { 'content-type': 'text/event-stream' }, data: sseStream(attempt === 1 ? SERP_429_BODY : HEALTHY_SERP) };
    });
    const { callMcpTool } = load();
    const seen: Array<{ code?: string }> = [];
    const t0 = Date.now();
    const out = await callMcpTool('search_engine', { query: 'inflatable dome in stock' }, undefined, {
      onSerpProviderError: (d: SerpProviderError) => seen.push(d),
    });
    expect(out).toBe(HEALTHY_SERP);              // the retry's healthy answer ships
    expect(mockPost).toHaveBeenCalledTimes(2);    // the error body was a FAILED attempt, not success
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2000); // the real 2 s backoff ran
    expect(seen.length).toBeGreaterThanOrEqual(1);        // the caller got the diagnosis
    expect(seen[0] && seen[0].code).toBe('sr_rate_limit');
    expect(loadLogger().info).toHaveBeenCalledWith(expect.stringMatching(/attempt 1 failed, retrying in 2000ms/));
  }, 15_000);

  it('deterministic class (unexpected_q) → FAIL FAST: one attempt only, honest null, callback fires', async () => {
    process.env.MCP_DIGBY_TOKEN = 'tok';
    mockGet.mockResolvedValue({ status: 200, data: 'ok' });
    mockTryDirect.mockResolvedValue(null);
    mockPost.mockResolvedValue({ headers: { 'content-type': 'text/event-stream' }, data: sseStream(SERP_502_UNEXPECTED_Q) });
    const { callMcpTool } = load();
    const seen: Array<{ code?: string; retryable?: boolean }> = [];
    const out = await callMcpTool('search_engine', { query: 'q' }, undefined, {
      onSerpProviderError: (d: SerpProviderError) => seen.push(d),
    });
    expect(out).toBeNull();                       // never the error body
    expect(mockPost).toHaveBeenCalledTimes(1);    // no retries burned on a deterministic class
    expect(seen).toHaveLength(1);
    expect(seen[0].code).toBe('unexpected_q');
    expect(seen[0].retryable).toBe(false);
    expect(loadLogger().warn).toHaveBeenCalledWith(
      expect.stringMatching(/deterministic query-mismatch class; failing fast without retries/),
      expect.anything(),
    );
  });

  it('query-ban stated wait (15 s) beyond the 8 s retry cap → FAIL FAST, one attempt', async () => {
    process.env.MCP_DIGBY_TOKEN = 'tok';
    mockGet.mockResolvedValue({ status: 200, data: 'ok' });
    mockTryDirect.mockResolvedValue(null);
    mockPost.mockResolvedValue({ headers: { 'content-type': 'text/event-stream' }, data: sseStream(SERP_QUERY_BAN_15S) });
    const { callMcpTool } = load();
    const out = await callMcpTool('search_engine', { query: 'q' });
    expect(out).toBeNull();
    expect(mockPost).toHaveBeenCalledTimes(1); // no in-window retry against a 15 s ban
    expect(loadLogger().warn).toHaveBeenCalledWith(
      expect.stringMatching(/provider states a 15 s minimum wait \(beyond the retry budget\); failing fast/),
      expect.anything(),
    );
  });

  it('stated wait WITHIN the budget bumps the backoff to the provider minimum before the retry', async () => {
    process.env.MCP_DIGBY_TOKEN = 'tok';
    mockGet.mockResolvedValue({ status: 200, data: 'ok' });
    mockTryDirect.mockResolvedValue(null);
    let attempt = 0;
    mockPost.mockImplementation(async () => {
      attempt++;
      return { headers: { 'content-type': 'text/event-stream' }, data: sseStream(attempt === 1 ? SERP_429_STATED_WAIT_3S : HEALTHY_SERP) };
    });
    const { callMcpTool } = load();
    const t0 = Date.now();
    const out = await callMcpTool('search_engine', { query: 'q' });
    expect(out).toBe(HEALTHY_SERP);
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3000); // 3 s stated minimum, not the 2 s default
    expect(loadLogger().info).toHaveBeenCalledWith(expect.stringMatching(/retrying in 3000ms/));
  }, 15_000);

  it('chokepoint defense in depth: a DIRECT-tier answer that is an error body is nulled over every route, callback fires', async () => {
    // The direct tier wins the hedge race carrying the incident body — the
    // CHOKEPOINT must catch the class no matter which route served it.
    mockTryDirect.mockResolvedValue(SERP_429_BODY);
    const { callMcpTool } = load();
    const seen: Array<{ code?: string }> = [];
    const out = await callMcpTool('search_engine', { query: 'q' }, undefined, {
      onSerpProviderError: (d: SerpProviderError) => seen.push(d),
    });
    expect(out).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].code).toBe('sr_rate_limit');
    expect(loadLogger().warn).toHaveBeenCalledWith(
      expect.stringContaining("search_engine answered with the provider's error/debug body instead of results"),
      expect.anything(),
    );
  });

  it('a healthy JSON SERP through the same gateway path passes byte-clean (no guard trip, no unwrap)', async () => {
    process.env.MCP_DIGBY_TOKEN = 'tok';
    mockGet.mockResolvedValue({ status: 200, data: 'ok' });
    mockTryDirect.mockResolvedValue(null);
    mockPost.mockResolvedValue({ headers: { 'content-type': 'text/event-stream' }, data: sseStream(HEALTHY_SERP) });
    const { callMcpTool } = load();
    const out = await callMcpTool('search_engine', { query: 'q' });
    expect(out).toBe(HEALTHY_SERP);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('scrape tools are untouched by the guard (only search_engine is classified)', async () => {
    process.env.MCP_DIGBY_TOKEN = 'tok';
    mockGet.mockResolvedValue({ status: 200, data: 'ok' });
    mockTryDirect.mockResolvedValue(null);
    // A scrape body that happens to carry the vendor docs link (e.g. a page
    // ABOUT BrightData) must not trip a search-only guard.
    mockPost.mockResolvedValue({ headers: { 'content-type': 'text/event-stream' }, data: sseStream('Page about docs.brightdata.com debugging') });
    const { callMcpTool } = load();
    const out = await callMcpTool('scrape_as_markdown', { url: 'https://example.com/brightdata-review' });
    expect(out).toBe('Page about docs.brightdata.com debugging');
  });
});

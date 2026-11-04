/**
 * Characterization pin — log-signal family 2026-10-21 (tickets 78b4dc66 +
 * 33005438, lane ae8c5605): two web-search warn fingerprints the hourly
 * log-signal-sweep filed are DESIGNED per-target observability, not defects.
 * This suite pins the designed behavior so a future refactor cannot silently
 * change the warn shapes/levels (the sweep fingerprints them) or the
 * containment bounds that keep the classes bounded.
 *
 *   1. GATEWAY search_engine SSE safety timer (ticket 78b4dc66's
 *      fingerprint, live 55 rows/24h scaling with search traffic):
 *        "Digby Web Search: search_engine SSE stream timed out (90s)"
 *      (mcp-search.ts callMcpToolOnce safety timer) — fires once per gateway
 *      attempt. search_engine carries the FULL retry budget (4 attempts, the
 *      2026-07-13 OOM-respawn fix), so a silent gateway stream yields at most
 *      4 SSE warns + 1 exhausted warn per user call, then the caller sees an
 *      honest null. The sibling lane-99e4a4eb pin
 *      (log-signal-webscrape-timeouts.cb0a7e52.test.ts) pins the
 *      scrape_as_markdown variant (30s × 2 attempts) — this pin adds the
 *      search_engine variant (90s × 4), which that suite does not cover.
 *
 *   2. PDF fetch/extract failed (ticket 33005438's fingerprint, the
 *      rule1-boots once-per-boot shape — a burst when a worker boots onto a
 *      conversation whose transcript cites an unfetchable PDF, then silence):
 *        "Digby Web Search: PDF fetch/extract failed for \"<url>\": <reason>"
 *      (mcp-search.ts extractPdfTextFromUrl catch) — ONE warn per target,
 *      returns null, and the caller falls through to the normal scrape path
 *      (never a retry storm: the failure is per-URL and the fetch is never
 *      retried inside extractPdfTextFromUrl).
 *
 * Adjudication (lane ae8c5605, 2026-10-21, live evidence this run): no
 * deterministic framework defect. The isap.sejm.gov.pl class (19 rows) was a
 * single slow-target burst 13:17→14:10Z Oct 20 — 0 rows of the fingerprint
 * after 14:10:28Z; a second target (maxContentLength exceeded) is the same
 * designed per-target class. The search_engine SSE rows scale with slow-gateway
 * traffic; the warn LEVEL is the observability contract (the sweep reads
 * warn+error only) — these pins assert the levels stay warn and the messages
 * keep the exact shapes the sweep normalizes, so the class remains visible but
 * is never mistaken for a plumbing failure.
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

const mockExtractPdfText = jest.fn();
jest.mock('./pdf-extract', () => ({
  extractPdfText: (...a: any[]) => mockExtractPdfText(...a),
}));

const mockMetric = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockMetric(...a),
  LOOP_METRIC_KINDS: { WEB_FETCH_PATH: 'web_fetch_path' },
}));

export {};

describe('log-signal family 78b4dc66/33005438 — designed per-target web-search observability', () => {
  beforeEach(() => {
    jest.resetModules();
    mockPost.mockReset();
    mockGet.mockReset();
    mockTryDirect.mockReset();
    mockMetric.mockReset();
    mockExtractPdfText.mockReset();
    mockDirectAvailable.mockReturnValue(true);
    delete process.env.MCP_DIGBY_TOKEN;
  });

  function load() {
    return require('./mcp-search');
  }
  function loadLogger() {
    return require('../../utils/logger').default;
  }

  // ── 1. 78b4dc66: the gateway search_engine SSE safety timer, full budget ────

  it('78b4dc66: a silent gateway search_engine stream walks 4×90s SSE-timeout attempts then ONE exhausted warn — exact shapes, warn level, honest null', async () => {
    const logger = loadLogger();
    process.env.MCP_DIGBY_TOKEN = 'tok';
    // Direct tier unavailable → the call walks straight into the gateway tier.
    mockDirectAvailable.mockReturnValue(false);
    mockGet.mockResolvedValue({ status: 200, data: 'ok' }); // gateway health probe
    // A stream that opens and NEVER emits: the 90s search_engine safety
    // timer is the only settle path — the exact prod shape behind the
    // fingerprint ("SSE stream timed out (90s)").
    const silentStream = () => ({
      destroy: jest.fn(),
      on: (_ev: string, _cb: (chunk: Buffer) => void) => { /* never emits */ },
    });
    mockPost.mockImplementation(() => Promise.resolve({
      headers: { 'content-type': 'text/event-stream' },
      data: silentStream(),
    }));
    const { callMcpTool } = load();
    const p = callMcpTool('search_engine', { query: 'slow serp' });
    const out = await (async () => {
      jest.useFakeTimers();
      try {
        // 4 attempts × 90s safety timer + the 2s→4s→8s backoff between them.
        await jest.advanceTimersByTimeAsync(90_000 * 4 + 2_000 + 4_000 + 8_000 + 2_000);
        return await p;
      } finally {
        jest.useRealTimers();
      }
    })();
    // The caller sees an honest null — never a partial/hung answer.
    expect(out).toBeNull();
    // Exactly 4 gateway attempts for search_engine — the full retry budget
    // (the 2026-07-13 OOM-respawn fix) is the designed bound.
    expect(mockPost).toHaveBeenCalledTimes(4);
    // The 78b4dc66 fingerprint fired once per attempt, at warn level, with
    // the exact 90s shape the sweep normalizes.
    const sseWarns = (logger.warn as jest.Mock).mock.calls.filter((c: any[]) => /SSE stream timed out/.test(String(c[0])));
    expect(sseWarns).toHaveLength(4);
    expect(sseWarns[0][0]).toBe('Digby Web Search: search_engine SSE stream timed out (90s)');
    expect(sseWarns[0][1]).toEqual({ source: 'web-search', tool: 'search_engine' });
    // …and ONE exhausted warn after the budget is spent (the sibling
    // acacd214 shape, here on the search_engine budget).
    const exhaustedWarns = (logger.warn as jest.Mock).mock.calls.filter((c: any[]) => /gateway attempt\(s\)/.test(String(c[0])));
    expect(exhaustedWarns).toHaveLength(1);
    expect(exhaustedWarns[0][0]).toBe('Digby Web Search: search_engine failed after 4 gateway attempt(s): MCP tool search_engine timed out');
  });

  // ── 2. 33005438: the per-target PDF fetch failure, never retried ────────────

  it('33005438: an unfetchable PDF target warns ONCE per target with the URL and reason, returns null — no retry, no storm', async () => {
    const logger = loadLogger();
    // The isap.sejm.gov.pl shape: axios rejects with the transport's own
    // reason (redirects exceeded). One call, one warn, null.
    mockGet.mockRejectedValueOnce(new Error('Maximum number of redirects exceeded'));
    const { extractPdfTextFromUrl } = load();
    const out = await extractPdfTextFromUrl('https://isap.sejm.gov.pl/isap.nsf/download.xsp/WDU2017000035');
    expect(out).toBeNull();
    // The failure path makes exactly ONE fetch attempt — extractPdfTextFromUrl
    // never retries (the caller falls through to the normal scrape path).
    expect(mockGet).toHaveBeenCalledTimes(1);
    const pdfWarns = (logger.warn as jest.Mock).mock.calls.filter((c: any[]) => /PDF fetch\/extract failed/.test(String(c[0])));
    expect(pdfWarns).toHaveLength(1);
    // The exact shape the sweep normalizes: URL + the transport's reason.
    expect(pdfWarns[0][0]).toBe('Digby Web Search: PDF fetch/extract failed for "https://isap.sejm.gov.pl/isap.nsf/download.xsp/WDU2017000035": Maximum number of redirects exceeded');
    expect(pdfWarns[0][1]).toEqual({ source: 'web-search' });
    // Second target, different reason (maxContentLength) — the same designed
    // per-target class: each target fails alone, once.
    (logger.warn as jest.Mock).mockClear();
    mockGet.mockReset();
    mockGet.mockRejectedValueOnce(new Error('maxContentLength size of 20971520 exceeded'));
    expect(await extractPdfTextFromUrl('https://www-pub.iaea.org/MTCD/Publications/PDF/p15935-25-028')).toBeNull();
    const again = (logger.warn as jest.Mock).mock.calls.filter((c: any[]) => /PDF fetch\/extract failed/.test(String(c[0])));
    expect(again).toHaveLength(1);
    expect(again[0][0]).toContain('maxContentLength size of 20971520 exceeded');
  });

  it('33005438: a PDF that fetches but is NOT a PDF (HTML error page) warns nothing — the normal scrape path handles it', async () => {
    const logger = loadLogger();
    // 200 with an HTML body: not %PDF- magic, not the PDF content type →
    // silent null (no warn — this is the "not actually a PDF" by-design path).
    mockGet.mockResolvedValueOnce({ data: Buffer.from('<html>error page</html>'), headers: { 'content-type': 'text/html' } });
    const { extractPdfTextFromUrl } = load();
    expect(await extractPdfTextFromUrl('https://example.com/doc.pdf')).toBeNull();
    expect((logger.warn as jest.Mock).mock.calls.filter((c: any[]) => /PDF fetch\/extract failed/.test(String(c[0])))).toHaveLength(0);
  });
});

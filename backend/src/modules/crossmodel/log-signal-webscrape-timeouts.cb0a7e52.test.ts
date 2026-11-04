/**
 * Characterization pin — log-signal family 2026-10-20 (tickets cb0a7e52 + 6da0db0a
 * + 0c9d23e2 + acacd214): the four web-search warn fingerprints the hourly
 * log-signal-sweep filed are ONE designed tier-failover observability class,
 * not four defects. This suite pins the DESIGNED behavior so a future refactor
 * cannot silently change the warn shapes/levels (the sweep fingerprints them)
 * or the containment bounds that keep the class bounded.
 *
 * The class, end to end (one slow/unreachable TARGET behind BrightData):
 *   1. DIRECT tier  — axios timeout (ECONNABORTED) after timeoutMs (60s scrape
 *      default; web_pipe/browser-agent pass 45s overrides):
 *        "BrightData direct: scrape_as_markdown failed:  timeout of 60000ms exceeded"
 *      (brightdata-direct.ts catch-all; ticket 0c9d23e2's fingerprint) — ONE warn;
 *      ECONNABORTED is in the NEVER-RETRY set (isRetryableBdError → false) and the
 *      1.5× overall budget (BD_TOTAL_BUDGET_FACTOR) already bounded the attempt.
 *   2. GATEWAY tier — callMcpToolOnce's 30s scrape SSE safety timer fires per
 *      attempt (exactly 2 attempts for scrape_as_markdown):
 *        "Digby Web Search: scrape_as_markdown SSE stream timed out (30s)" ×2
 *      (mcp-search.ts; ticket 6da0db0a's fingerprint)
 *   3. Exhausted   — after the bounded budget:
 *        "Digby Web Search: scrape_as_markdown failed after 2 gateway attempt(s):
 *         MCP tool scrape_as_markdown timed out"
 *      (mcp-search.ts; ticket acacd214's fingerprint) + a circuit-breaker failure.
 *   4. DIRECT search_engine miss (empty_body class) falls through to the gateway:
 *        "Digby Web Search: DIRECT search_engine returned nothing after <n> ms
 *         (empty_body) — trying the gateway"
 *      (mcp-search.ts routeMcpTool finish(); ticket cb0a7e52's fingerprint) —
 *      the DESIGNED sequential fallback for an empty SERP body, which can be a
 *      transient hiccup (issue #85 keeps empty SERPs non-deterministic).
 *
 * Adjudication (lane 99e4a4eb, 2026-10-20): no deterministic framework defect.
 * 771 web_fetch_path metrics/24h are overwhelmingly winner=direct ok at 2-8 s;
 * the timeout rows scale with slow-target traffic (the 16-17Z spike: 434+77
 * fetches across parallel sessions), and a direct-tier timeout is rescued live
 * by the hedged gateway (a 01:01:13Z row: winner=gateway after
 * directClass=timeout). The warn LEVEL is the observability contract
 * (FRAMEWORK_LESSONS 62718124: the sweep reads warn+error only) — these pins
 * assert the levels stay warn and the messages keep the exact shapes the sweep
 * normalizes, so the class remains visible but is never mistaken for a
 * plumbing failure again.
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

describe('log-signal family cb0a7e52/6da0db0a/0c9d23e2/acacd214 — designed tier-failover observability', () => {
  beforeEach(() => {
    jest.resetModules();
    mockPost.mockReset();
    mockGet.mockReset();
    mockTryDirect.mockReset();
    mockMetric.mockReset();
    mockDirectAvailable.mockReturnValue(true);
    delete process.env.MCP_DIGBY_TOKEN;
    delete process.env.WEB_HEDGE_DISABLED;
    delete process.env.WEB_HEDGE_MS;
    delete process.env.WEB_DIRECT_ADAPTIVE_MISS_RATE;
    delete process.env.WEB_DIRECT_ADAPTIVE_MIN_SAMPLES;
    delete process.env.WEB_DIRECT_ADAPTIVE_WINDOW;
    delete process.env.WEB_DIRECT_ADAPTIVE_HEDGE_MS;
  });

  /** The mcp-search module under its mocks (direct tier mocked out). */
  function load() {
    return require('./mcp-search');
  }
  /** The REAL brightdata-direct (only the logger/axios seams are mocked; the
   *  normal require('./brightdata-direct') is the MOCKED re-export mcp-search
   *  sees — the direct-tier tests need the real functions). */
  function loadDirect() {
    process.env.BRIGHTDATA_API_TOKEN = 'test-token';
    return jest.requireActual('./brightdata-direct');
  }
  function loadLogger() {
    return require('../../utils/logger').default;
  }
  const flush = (ms = 10) => new Promise((r) => setTimeout(r, ms));

  // ── 1. cb0a7e52: the DIRECT search_engine empty_body miss warn ─────────────

  it('cb0a7e52: DIRECT search_engine empty_body miss → the exact "trying the gateway" warn, at warn level', async () => {
    const logger = loadLogger();
    // Direct tier reports an empty_body miss through onMiss and answers null.
    mockTryDirect.mockImplementation((_t: string, _a: any, _ms: any, opts: any) => {
      opts?.onMiss?.({ class: 'empty_body' });
      return Promise.resolve(null);
    });
    const { callMcpTool } = load();
    // MCP_DIGBY_TOKEN unset → the gateway tier bails at once; the miss warn
    // still fires BEFORE the gateway call (the designed sequential order).
    expect(await callMcpTool('search_engine', { query: 'q' })).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^Digby Web Search: DIRECT search_engine returned nothing after \d+ ms \(empty_body\) — trying the gateway$/),
      expect.objectContaining({ source: 'web-search', tool: 'search_engine' }),
    );
    // The miss is ALSO visible in the designed metric (winner none, empty body).
    await flush();
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'web_fetch_path',
      meta: expect.objectContaining({ tool: 'search_engine', winner: 'none', directOutcome: 'empty', directClass: 'empty_body' }),
    }));
  });

  // ── 2. 6da0db0a + acacd214: the gateway-tier SSE timeout walk, bounded ──────

  it('6da0db0a + acacd214: a silent gateway stream walks 2 SSE-timeout attempts then the exhausted warn — exact shapes, no more', async () => {
    const logger = loadLogger();
    process.env.MCP_DIGBY_TOKEN = 'tok';
    // Direct tier unavailable → the call walks straight into the gateway tier.
    mockDirectAvailable.mockReturnValue(false);
    mockGet.mockResolvedValue({ status: 200, data: 'ok' }); // gateway health probe
    // A stream that opens and NEVER emits: the 30s scrape safety timer is the
    // only settle path — the exact prod shape behind the fingerprint.
    const silentStream = () => ({
      destroy: jest.fn(),
      on: (_ev: string, _cb: (chunk: Buffer) => void) => { /* never emits */ },
    });
    mockPost.mockImplementation(() => Promise.resolve({
      headers: { 'content-type': 'text/event-stream' },
      data: silentStream(),
    }));
    const { callMcpTool } = load();
    const p = callMcpTool('scrape_as_markdown', { url: 'https://silent.example.com/x' });
    const out = await (async () => {
      jest.useFakeTimers();
      try {
        // attempt 1: 30s safety timer → reject + SSE warn; 2s backoff;
        // attempt 2: 30s safety timer → reject + SSE warn; exhausted warn.
        await jest.advanceTimersByTimeAsync(30_000 + 2_000 + 30_000 + 1_000);
        return await p;
      } finally {
        jest.useRealTimers();
      }
    })();
    expect(out).toBeNull();
    // Exactly 2 gateway attempts for scrape_as_markdown — the "after 2 gateway
    // attempt(s)" in the acacd214 fingerprint is the designed budget.
    expect(mockPost).toHaveBeenCalledTimes(2);
    // The 6da0db0a fingerprint fired once per attempt, at warn level.
    const sseWarns = (logger.warn as jest.Mock).mock.calls.filter((c: any[]) => /SSE stream timed out/.test(String(c[0])));
    expect(sseWarns).toHaveLength(2);
    expect(sseWarns[0][0]).toBe('Digby Web Search: scrape_as_markdown SSE stream timed out (30s)');
    expect(sseWarns[0][1]).toEqual({ source: 'web-search', tool: 'scrape_as_markdown' });
    // The acacd214 fingerprint fires exactly once, after the budget is spent.
    const exhaustedWarns = (logger.warn as jest.Mock).mock.calls.filter((c: any[]) => /gateway attempt\(s\)/.test(String(c[0])));
    expect(exhaustedWarns).toHaveLength(1);
    expect(exhaustedWarns[0][0]).toBe('Digby Web Search: scrape_as_markdown failed after 2 gateway attempt(s): MCP tool scrape_as_markdown timed out');
    expect(exhaustedWarns[0][1]).toEqual({ source: 'web-search', tool: 'scrape_as_markdown' });
  });

  // ── 3. 0c9d23e2: the direct-tier ECONNABORTED catch-all, never retried ─────

  it('0c9d23e2: ECONNABORTED (our own timeout) is NEVER retried — one warn per slow target, not a storm', async () => {
    const logger = loadLogger();
    const { tryDirectBrightData } = loadDirect();
    mockPost.mockRejectedValue(Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' }));
    expect(await tryDirectBrightData('scrape_as_markdown', { url: 'https://slow.example.com/x' })).toBeNull();
    // ONE request, ONE warn — the exact catch-all line the fingerprint normalizes
    // (note the double space: `${err.response?.status || ''} ${err.message}` with
    // no HTTP status on a client-side timeout). The 60000 IS the code's own
    // DEFAULT_TIMEOUT_MS as the axios config it sends (not an authored string).
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][2]).toMatchObject({ timeout: 60_000 });
    expect(logger.warn).toHaveBeenCalledWith(
      'BrightData direct: scrape_as_markdown failed:  timeout of 60000ms exceeded',
      expect.objectContaining({ source: 'brightdata-direct', tool: 'scrape_as_markdown' }),
    );
  });

  it('0c9d23e2: classifyDirectMiss maps ECONNABORTED → {class:"timeout"} — the miss telemetry a hedged call sees', () => {
    const { classifyDirectMiss } = loadDirect();
    expect(classifyDirectMiss({ code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' }))
      .toEqual({ class: 'timeout', code: 'ECONNABORTED' });
  });

  // ── 4. The two tiers compose: a direct timeout falls through to the gateway ─

  it('0c9d23e2 → 6da0db0a/acacd214 composition: a direct-tier timeout walks into the gateway tier — the failover seam, in ONE call', async () => {
    const logger = loadLogger();
    process.env.MCP_DIGBY_TOKEN = 'tok';
    // The direct tier TIMES OUT (the ECONNABORTED class): the real
    // tryDirectBrightData catches, warns the 0c9d23e2 catch-all line, reports
    // the miss class through onMiss and answers null — the exact seam the
    // prod walk starts from. The mocked-out mcp-search direct tier re-creates
    // that contract here.
    mockTryDirect.mockImplementation((_t: string, _a: any, _ms: any, opts: any) => {
      opts?.onMiss?.({ class: 'timeout', code: 'ECONNABORTED' });
      return Promise.resolve(null);
    });
    mockGet.mockResolvedValue({ status: 200, data: 'ok' }); // gateway health probe
    const { Readable } = require('stream') as typeof import('stream');
    const sse = (text: string) => Readable.from([`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })}\n\n`]);
    mockPost.mockImplementation(() => Promise.resolve({
      headers: { 'content-type': 'text/event-stream' },
      data: sse('GATEWAY-ANSWER'),
    }));
    const { callMcpTool } = load();
    // A hedge is armed by default (WEB_HEDGE_MS unset → the 12s base window):
    // the direct null settles instantly, the sequential path takes over and the
    // gateway answers — the FAILover the metric row records as
    // winner=gateway, directOutcome=empty, directClass=timeout.
    const out = await callMcpTool('scrape_as_markdown', { url: 'https://slow.example.com/y' });
    expect(out).toBe('GATEWAY-ANSWER');
    // The direct-tier miss warn fired (the sequential, user-facing cost)…
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/DIRECT scrape_as_markdown returned nothing after \d+ ms \(timeout\) — trying the gateway/),
      expect.objectContaining({ source: 'web-search', tool: 'scrape_as_markdown' }),
    );
    // …and the gateway tier really served the answer (its POST ran, health
    // probe included).
    expect(mockPost).toHaveBeenCalled();
    await flush();
    // The designed walk is visible in the metric: the direct timeout was
    // rescued by the gateway — the seam's own telemetry row.
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'web_fetch_path',
      meta: expect.objectContaining({ tool: 'scrape_as_markdown', winner: 'gateway', directOutcome: 'empty', directClass: 'timeout' }),
    }));
  });
});

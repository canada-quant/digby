/**
 * callMcpTool direct-tier routing — issue #85.
 *
 * A scrape_as_markdown empty-body is a DETERMINISTIC content result (PDF /
 * blocked / JS-shell page), not a plumbing failure: the gateway tier hits the
 * same BrightData backend and would return empty too, so callMcpTool must skip
 * it (saves ~30s/attempt and stops the ~820 warns/48h log flood). Transient
 * direct failures (null) must still fall through to the gateway path.
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

// Module marker — without any import/export this file would be a global script
// and its top-level consts would collide with brightdata-direct.test.ts (which
// is also script-style and declares a global `mockPost`): TS2451.
export {};

describe('callMcpTool — direct-tier empty-body routing (#85)', () => {
  beforeEach(() => {
    jest.resetModules();
    mockPost.mockReset();
    mockGet.mockReset();
    mockTryDirect.mockReset();
    mockDirectAvailable.mockReturnValue(true);
    delete process.env.MCP_DIGBY_TOKEN;
  });

  function load() {
    // re-require after env/mocks are set (module reads env at import)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./mcp-search');
  }

  function loadLogger() {
    // must be required AFTER jest.resetModules() so the assertions see the same
    // mock instance the module under test logs to (a top-level import would be
    // the pre-reset registry instance and capture nothing).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../utils/logger').default;
  }

  it('scrape_as_markdown empty-body → null WITHOUT touching the gateway', async () => {
    // require the MOCKED module (not requireActual) so instanceof matches the
    // class instance the module under test sees.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DirectEmptyBodyError } = require('./brightdata-direct');
    const logger = loadLogger();
    mockTryDirect.mockRejectedValue(new DirectEmptyBodyError('empty body from BrightData direct'));
    const { callMcpTool } = load();
    // NOTE: not a .pdf URL — PDF targets take the dedicated extraction path (below)
    const out = await callMcpTool('scrape_as_markdown', { url: 'https://example.com/x' });
    expect(out).toBeNull();
    expect(mockPost).not.toHaveBeenCalled(); // gateway never tried
    expect(mockGet).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('skipping gateway'));
  });

  it('transient direct failure (null) → still falls through to the gateway path', async () => {
    const logger = loadLogger();
    mockTryDirect.mockResolvedValue(null);
    const { callMcpTool } = load();
    const out = await callMcpTool('scrape_as_markdown', { url: 'https://example.com' });
    // MCP_DIGBY_TOKEN unset → gateway path bails early, but the fallthrough
    // warn proves the routing still reaches the gateway tier for non-
    // deterministic failures (pre-#85 behavior preserved).
    expect(out).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('trying the gateway'), expect.anything());
  });
});

describe('callMcpTool — PDF target extraction (ticket bf4e0629)', () => {
  beforeEach(() => {
    jest.resetModules();
    mockPost.mockReset();
    mockGet.mockReset();
    mockTryDirect.mockReset();
    mockExtractPdfText.mockReset();
    mockDirectAvailable.mockReturnValue(true);
    delete process.env.MCP_DIGBY_TOKEN;
  });

  function load() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./mcp-search');
  }

  const pdfBytes = () => Buffer.from('%PDF-1.7\nfake pdf body');

  it('.pdf URL → bytes fetched + text extracted; the scrape tier is never touched', async () => {
    mockGet.mockResolvedValue({ data: pdfBytes(), headers: { 'content-type': 'application/pdf' } });
    mockExtractPdfText.mockResolvedValue('Comprehensive rules section 1-1: ...');
    const { callMcpTool } = load();
    const out = await callMcpTool('scrape_as_markdown', { url: 'https://en.example.com/pdf/rule_comprehensive.pdf' });
    expect(out).toBe('Comprehensive rules section 1-1: ...');
    expect(mockTryDirect).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockExtractPdfText).toHaveBeenCalledWith(expect.any(Buffer), 'rule_comprehensive.pdf');
  });

  it('scrape body starting %PDF- (no .pdf extension) → re-fetch + extract, never raw bytes', async () => {
    mockTryDirect.mockResolvedValue('%PDF-1.7\n%âã FlateDecode stream h...endstream');
    mockGet.mockResolvedValue({ data: pdfBytes(), headers: { 'content-type': 'application/pdf' } });
    mockExtractPdfText.mockResolvedValue('extracted rulebook text');
    const { callMcpTool } = load();
    const out = await callMcpTool('scrape_as_markdown', { url: 'https://example.com/download?id=42' });
    expect(out).toBe('extracted rulebook text');
  });

  it('scrape body is PDF but re-fetch fails → null, NOT the binary garbage', async () => {
    mockTryDirect.mockResolvedValue('%PDF-1.4 binary...');
    mockGet.mockRejectedValue(new Error('fetch refused'));
    const { callMcpTool } = load();
    const out = await callMcpTool('scrape_as_markdown', { url: 'https://example.com/doc' });
    expect(out).toBeNull();
  });

  it('.pdf URL that is actually HTML → falls through to the normal scrape', async () => {
    mockGet.mockResolvedValue({ data: Buffer.from('<html>not a pdf</html>'), headers: { 'content-type': 'text/html' } });
    mockTryDirect.mockResolvedValue('# real markdown page');
    const { callMcpTool } = load();
    const out = await callMcpTool('scrape_as_markdown', { url: 'https://example.com/fake.pdf' });
    expect(out).toBe('# real markdown page');
    expect(mockExtractPdfText).not.toHaveBeenCalled();
  });

  it('extraction cap: oversized PDF text is truncated with an explicit marker', async () => {
    mockGet.mockResolvedValue({ data: pdfBytes(), headers: { 'content-type': 'application/pdf' } });
    mockExtractPdfText.mockResolvedValue('x'.repeat(120_000));
    const { extractPdfTextFromUrl } = load();
    const out = await extractPdfTextFromUrl('https://example.com/big.pdf');
    expect(out).toContain('[PDF text truncated at');
    expect(out!.length).toBeLessThan(120_000);
  });
});

// ── SERP redirect wrappers at the search_engine chokepoint (2026-09-14) ───────
// Owner: "is our web_pipe broken??" — since ~09-13 BrightData's Google SERP
// returns organic[].link as https://www.google.com/goto?url=<opaque>. Every
// consumer (chat/coding tool result, [Web Search Results], web_pipe, news, kid
// path) reads through callMcpTool('search_engine'), so the unwrap lives here.
describe('callMcpTool — search_engine SERP redirect unwrap (2026-09-14)', () => {
  const GOTO = 'https://www.google.com/goto?url=CAESQ0FVX3lxTE1nVzNtV2hZWDNqZk5oV0dJc3RJM1hLbVo1RDNZ';
  const REAL = 'https://vllm.ai/blog/2026-07-27-k3';
  const SERP = JSON.stringify({ organic: [{ link: GOTO, display_link: 'vllm.ai', title: 'K3 on vLLM' }, { link: 'https://plain.example/p', title: 'Plain' }] });

  beforeEach(() => {
    jest.resetModules();
    mockPost.mockReset();
    mockGet.mockReset();
    mockTryDirect.mockReset();
    mockDirectAvailable.mockReturnValue(true);
    delete process.env.MCP_DIGBY_TOKEN;
  });

  function load() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./mcp-search');
  }

  it('the SERP the model reads carries the REAL URL, not the goto wrapper', async () => {
    mockTryDirect.mockResolvedValue(SERP);
    mockGet.mockResolvedValue({ status: 302, headers: { location: REAL }, data: '' });
    const { callMcpTool } = load();
    const out = await callMcpTool('search_engine', { query: 'kimi k3', engine: 'google' });
    const parsed = JSON.parse(out);
    expect(parsed.organic[0]).toMatchObject({ link: REAL, display_link: 'vllm.ai', title: 'K3 on vLLM' });
    expect(parsed.organic[1].link).toBe('https://plain.example/p');
    expect(out).not.toContain('google.com/goto');
    expect(mockGet).toHaveBeenCalledWith(GOTO, expect.objectContaining({ maxRedirects: 0 }));
  });

  it('searchWithBrightData ([Web Search Results] block) cites the real URL too', async () => {
    mockTryDirect.mockResolvedValue(SERP);
    mockGet.mockResolvedValue({ status: 302, headers: { location: REAL }, data: '' });
    const { searchWithBrightData } = load();
    const block = await searchWithBrightData('kimi k3 vllm blog');
    expect(block).toContain('[Web Search Results]');
    expect(block).toContain(REAL);
    expect(block).not.toContain('google.com/goto');
  });

  it('a wrapper-free SERP passes through byte-identical with no hop request', async () => {
    const clean = JSON.stringify({ organic: [{ link: REAL, title: 'x' }] });
    mockTryDirect.mockResolvedValue(clean);
    const { callMcpTool } = load();
    expect(await callMcpTool('search_engine', { query: 'q' })).toBe(clean);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('a null search result (both tiers down) stays null', async () => {
    mockTryDirect.mockResolvedValue(null);
    const { callMcpTool } = load();
    expect(await callMcpTool('search_engine', { query: 'q' })).toBeNull();
  });
});

// ── Hedged gateway (autonomy loop #7, 2026-09-19): the direct tier timed out 67×
//    in 4 h (45–60 s each) before falling back; the gateway now starts in
//    parallel once the direct call is slow, and the first useful answer wins. ──
describe('routeMcpTool — hedged gateway', () => {
  const { Readable } = require('stream') as typeof import('stream');
  const sseStream = (text: string) => Readable.from([`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })}\n\n`]);
  const flush = () => new Promise((r) => setTimeout(r, 5));

  beforeEach(() => {
    jest.resetModules();
    mockPost.mockReset(); mockGet.mockReset(); mockTryDirect.mockReset(); mockMetric.mockReset();
    mockDirectAvailable.mockReturnValue(true);
    delete process.env.MCP_DIGBY_TOKEN;
    delete process.env.WEB_HEDGE_DISABLED;
    delete process.env.WEB_HEDGE_MS;
  });
  function load() { return require('./mcp-search'); }

  it('a fast direct answer wins outright — the gateway is never called', async () => {
    process.env.WEB_HEDGE_MS = '50';
    mockTryDirect.mockResolvedValue('DIRECT');
    const { callMcpTool, webHedgeMs } = load();
    expect(webHedgeMs('search_engine')).toBe(50);
    expect(webHedgeMs('scrape_batch')).toBe(0); // batches never hedge
    expect(await callMcpTool('scrape_as_markdown', { url: 'https://example.com/a' })).toBe('DIRECT');
    expect(mockPost).not.toHaveBeenCalled();
    await flush();
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'web_fetch_path', meta: expect.objectContaining({ tool: 'scrape_as_markdown', winner: 'direct', hedged: false, directOutcome: 'ok' }) }));
  });

  it('a slow direct call races a hedged gateway call and the gateway answer ships first', async () => {
    process.env.MCP_DIGBY_TOKEN = 'tok';
    process.env.WEB_HEDGE_MS = '10';
    mockTryDirect.mockImplementation(() => new Promise((res) => setTimeout(() => res('DIRECT-LATE'), 400)));
    mockGet.mockResolvedValue({ status: 200, data: 'ok' }); // gateway health probe
    mockPost.mockResolvedValue({ headers: { 'content-type': 'text/event-stream' }, data: sseStream('GATEWAY') });
    const { callMcpTool } = load();
    const t0 = Date.now();
    const out = await callMcpTool('scrape_as_markdown', { url: 'https://example.com/slow' });
    expect(out).toBe('GATEWAY');
    expect(Date.now() - t0).toBeLessThan(350); // did not wait for the slow direct call
    expect(mockPost).toHaveBeenCalledTimes(1);
    await flush();
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ winner: 'gateway', hedged: true, directOutcome: 'pending' }) }));
  });

  it('the hedged gateway comes back empty first → the direct answer still ships (hedged, winner direct)', async () => {
    process.env.WEB_HEDGE_MS = '10'; // MCP_DIGBY_TOKEN unset → the gateway tier answers null at once
    mockTryDirect.mockImplementation(() => new Promise((res) => setTimeout(() => res('DIRECT'), 80)));
    const { callMcpTool } = load();
    expect(await callMcpTool('search_engine', { query: 'q' })).toBe('DIRECT');
    await flush();
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ tool: 'search_engine', winner: 'direct', hedged: true, directOutcome: 'ok' }) }));
  });

  it('kill switch WEB_HEDGE_DISABLED=1 → the sequential order: direct empty, then the gateway', async () => {
    process.env.WEB_HEDGE_DISABLED = '1';
    mockTryDirect.mockResolvedValue(null);
    const { callMcpTool, webHedgeMs } = load();
    expect(webHedgeMs('search_engine')).toBe(0);
    const logger = require('../../utils/logger').default;
    expect(await callMcpTool('search_engine', { query: 'q' })).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/DIRECT search_engine returned nothing after \d+ ms \(unknown\) — trying the gateway/), expect.anything());
    await flush();
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ winner: 'none', hedged: false, directOutcome: 'empty', directClass: 'unknown', hedgeMs: 0, adaptive: false }) }));
  });
});

// ── PE-06 (2026-09-28): adaptive hedge for the DIRECT search tier + miss-class telemetry ──
describe('routeMcpTool — adaptive hedge (backlog audit PE-06)', () => {
  const { Readable } = require('stream') as typeof import('stream');
  const sseStream = (text: string) => Readable.from([`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })}\n\n`]);
  const flush = (ms = 5) => new Promise((r) => setTimeout(r, ms));

  beforeEach(() => {
    jest.resetModules();
    mockPost.mockReset(); mockGet.mockReset(); mockTryDirect.mockReset(); mockMetric.mockReset();
    mockDirectAvailable.mockReturnValue(true);
    delete process.env.MCP_DIGBY_TOKEN;
    delete process.env.WEB_HEDGE_DISABLED;
    delete process.env.WEB_HEDGE_MS;
    delete process.env.WEB_DIRECT_ADAPTIVE_MISS_RATE;
    delete process.env.WEB_DIRECT_ADAPTIVE_MIN_SAMPLES;
    delete process.env.WEB_DIRECT_ADAPTIVE_WINDOW;
    delete process.env.WEB_DIRECT_ADAPTIVE_HEDGE_MS;
  });
  function load() { return require('./mcp-search'); }
  /** A direct miss whose class the tier reports through onMiss (the 4th arg). */
  const directMissAfter = (ms: number, cls = 'serp_captcha') => (_t: string, _a: any, _ms: any, opts: any) =>
    new Promise((res) => setTimeout(() => { opts?.onMiss?.({ class: cls }); res(null); }, ms));

  it('adaptiveHedgePlan: base hedge until the window holds ≥ min samples AND the miss rate exceeds the bar; then the adaptive trigger; never for scrape', () => {
    process.env.WEB_DIRECT_ADAPTIVE_MIN_SAMPLES = '4';
    const { adaptiveHedgePlan, noteDirectOutcome, directMissRate, WEB_HEDGE_DEFAULT_MS } = load();
    expect(adaptiveHedgePlan('search_engine', WEB_HEDGE_DEFAULT_MS)).toEqual({ hedgeMs: WEB_HEDGE_DEFAULT_MS, adaptive: false, missRate: 0, n: 0 });
    noteDirectOutcome('search_engine', true); noteDirectOutcome('search_engine', true); noteDirectOutcome('search_engine', false);
    expect(adaptiveHedgePlan('search_engine', WEB_HEDGE_DEFAULT_MS).adaptive).toBe(false); // n=3 < 4
    noteDirectOutcome('search_engine', false);
    expect(directMissRate('search_engine')).toEqual({ rate: 0.5, n: 4 });
    expect(adaptiveHedgePlan('search_engine', WEB_HEDGE_DEFAULT_MS)).toEqual({ hedgeMs: 0, adaptive: true, missRate: 0.5, n: 4 });
    // scrape_as_markdown hedges but never adapts; a disabled base hedge disables the adaptive one too
    noteDirectOutcome('scrape_as_markdown', true); noteDirectOutcome('scrape_as_markdown', true); noteDirectOutcome('scrape_as_markdown', true); noteDirectOutcome('scrape_as_markdown', true);
    expect(adaptiveHedgePlan('scrape_as_markdown', WEB_HEDGE_DEFAULT_MS).adaptive).toBe(false);
    expect(adaptiveHedgePlan('search_engine', 0)).toEqual({ hedgeMs: 0, adaptive: false, missRate: 0.5, n: 4 });
    // the rate falls under the bar → back to the base trigger
    for (let i = 0; i < 8; i++) noteDirectOutcome('search_engine', false);
    expect(adaptiveHedgePlan('search_engine', WEB_HEDGE_DEFAULT_MS).adaptive).toBe(false);
  });

  it('the window is bounded (WEB_DIRECT_ADAPTIVE_WINDOW) and the adaptive trigger honours WEB_DIRECT_ADAPTIVE_HEDGE_MS (capped at the base)', () => {
    process.env.WEB_DIRECT_ADAPTIVE_WINDOW = '5';
    process.env.WEB_DIRECT_ADAPTIVE_MIN_SAMPLES = '5';
    process.env.WEB_DIRECT_ADAPTIVE_HEDGE_MS = '3000';
    const { adaptiveHedgePlan, noteDirectOutcome, directMissRate } = load();
    for (let i = 0; i < 20; i++) noteDirectOutcome('search_engine', true);
    for (let i = 0; i < 3; i++) noteDirectOutcome('search_engine', false);
    expect(directMissRate('search_engine')).toEqual({ rate: 0.4, n: 5 }); // only the last 5 count
    expect(adaptiveHedgePlan('search_engine', 12_000)).toEqual({ hedgeMs: 3000, adaptive: true, missRate: 0.4, n: 5 });
    expect(adaptiveHedgePlan('search_engine', 1000).hedgeMs).toBe(1000);
  });

  it('a direct miss records its class + the hedge plan on the web_fetch_path row, and the miss feeds the window', async () => {
    process.env.WEB_HEDGE_MS = '200';
    mockTryDirect.mockImplementation(directMissAfter(5, 'serp_consent'));
    const { callMcpTool, directMissRate } = load();
    expect(await callMcpTool('search_engine', { query: 'q' })).toBeNull(); // no gateway token → null
    await flush();
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'web_fetch_path', meta: expect.objectContaining({ tool: 'search_engine', winner: 'none', hedged: false, directOutcome: 'empty', directClass: 'serp_consent', hedgeMs: 200, adaptive: false, directMissRate: 0, directWindow: 0 }) }));
    expect(directMissRate('search_engine')).toEqual({ rate: 1, n: 1 });
    const logger = require('../../utils/logger').default;
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/DIRECT search_engine returned nothing after \d+ ms \(serp_consent\) — trying the gateway/), expect.anything());
  });

  it('once the miss rate crosses the bar the gateway starts AT ONCE and answers while the direct call is still failing (p95 wait drops)', async () => {
    process.env.MCP_DIGBY_TOKEN = 'tok';
    process.env.WEB_DIRECT_ADAPTIVE_MIN_SAMPLES = '3';
    const { callMcpTool, noteDirectOutcome } = load();
    for (let i = 0; i < 3; i++) noteDirectOutcome('search_engine', true);
    mockTryDirect.mockImplementation(directMissAfter(300, 'timeout'));
    mockGet.mockResolvedValue({ status: 200, data: 'ok' }); // gateway health probe
    mockPost.mockResolvedValue({ headers: { 'content-type': 'text/event-stream' }, data: sseStream('{"organic":[{"link":"https://g"}]}') });
    const t0 = Date.now();
    const out = await callMcpTool('search_engine', { query: 'q' });
    expect(out).toContain('"organic"');
    expect(Date.now() - t0).toBeLessThan(250); // did not wait for the 300 ms direct miss (nor a 12 s hedge)
    expect(mockPost).toHaveBeenCalledTimes(1);
    await flush();
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ tool: 'search_engine', winner: 'gateway', hedged: true, directOutcome: 'pending', hedgeMs: 0, adaptive: true, directMissRate: 1, directWindow: 3 }) }));
    // the late row lands when the direct call settles, naming its class
    await flush(350);
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ tool: 'search_engine', phase: 'direct_settled', directLate: 'empty', directClass: 'timeout', adaptive: true }) }));
    const logger = require('../../utils/logger').default;
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('adaptive hedge ON for search_engine'));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('returned nothing')); // the hedged miss is info, not warn
  });

  it('in adaptive mode a fast direct answer still wins the race (the gateway call is simply dropped) and counts as a hit', async () => {
    process.env.MCP_DIGBY_TOKEN = 'tok';
    process.env.WEB_DIRECT_ADAPTIVE_MIN_SAMPLES = '2';
    const { callMcpTool, noteDirectOutcome, directMissRate } = load();
    noteDirectOutcome('search_engine', true); noteDirectOutcome('search_engine', true);
    mockTryDirect.mockImplementation(() => new Promise((res) => setTimeout(() => res('DIRECT'), 10)));
    mockGet.mockResolvedValue({ status: 200, data: 'ok' });
    mockPost.mockImplementation(() => new Promise((res) => setTimeout(() => res({ headers: { 'content-type': 'text/event-stream' }, data: sseStream('GATEWAY') }), 400)));
    expect(await callMcpTool('search_engine', { query: 'q' })).toBe('DIRECT');
    await flush();
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ winner: 'direct', hedged: true, directOutcome: 'ok', adaptive: true }) }));
    expect(directMissRate('search_engine')).toEqual({ rate: 2 / 3, n: 3 });
  });

  it('a deterministic empty (scrape) never feeds the window', async () => {
    const { DirectEmptyBodyError } = require('./brightdata-direct');
    mockTryDirect.mockRejectedValue(new DirectEmptyBodyError('empty body from BrightData direct'));
    const { callMcpTool, directMissRate } = load();
    expect(await callMcpTool('scrape_as_markdown', { url: 'https://example.com/a' })).toBeNull();
    await flush();
    expect(directMissRate('scrape_as_markdown')).toEqual({ rate: 0, n: 0 });
  });
});

describe('unfetchable target (loop #19): the model gets the reason + sandbox alternative, the gateway is never tried', () => {
  it('callMcpTool(scrape_as_markdown) returns the guidance text and records directOutcome unfetchable', async () => {
    const { DirectUnfetchableTargetError } = require('./brightdata-direct');
    mockPost.mockClear(); mockMetric.mockClear();
    mockDirectAvailable.mockReturnValue(true);
    mockTryDirect.mockRejectedValue(new DirectUnfetchableTargetError('http://89.124.36.202:4000/v1/models', 'raw IP address host 89.124.36.202'));
    const { callMcpTool } = require('./mcp-search');
    const out = await callMcpTool('scrape_as_markdown', { url: 'http://89.124.36.202:4000/v1/models' });
    expect(String(out)).toContain('[unfetchable target] The cloud fetcher cannot reach http://89.124.36.202:4000/v1/models: raw IP address host');
    expect(String(out)).toContain('run_command: curl');
    expect(mockPost).not.toHaveBeenCalled(); // no gateway tier call
    await new Promise((r) => setTimeout(r, 20));
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'web_fetch_path', meta: expect.objectContaining({ tool: 'scrape_as_markdown', directOutcome: 'unfetchable', reason: 'raw IP address host 89.124.36.202' }) }));
  });
});

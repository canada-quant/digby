/**
 * VERIFY-4 (e) — a LIVE throttle injection through the REAL failover ladder.
 *
 * Ticket 1cc1f52e criterion (e): "inject a throttle (or simulate 429) and
 * confirm the delivered SHAPE does not change."
 *
 * The unit replay (research-pipeline-acceptance.1cc1f52e.test.ts) proves the
 * shape contract with callMcpTool MOCKED — a shape-only reading. This file
 * closes the other half: it stands up a REAL local HTTP server, points the
 * REAL gateway tier at it through the genuine env seams (MCP_DIGBY_URL /
 * MCP_DIGBY_HEALTH_URL), and makes the REAL `callMcpTool` walk the REAL
 * retry/backoff/circuit-breaker ladder against three wire replies:
 *
 *   1. healthy           — a real organic SERP, answered as plain JSON-RPC
 *   2. provider-throttle — HTTP 200 carrying BrightData's OWN throttle text as
 *                          the tool result. This is the PRODUCTION shape
 *                          (ticket ca805a61): the gateway answers a failing
 *                          search backend with the provider's error text as a
 *                          NORMAL tools/call result, so a caller that trusted
 *                          the body would deliver an error message as "results".
 *   3. hard-429          — HTTP 429 at the transport layer: a real socket
 *                          status, which lands in the retry ladder's catch.
 *
 * WHAT IS ASSERTED is the OBSERVED behaviour, not a wish: attempt counts (the
 * bounded-attempt half of criterion (a)), the honest `null` degradation, and
 * the invariant that the provider's error text NEVER escapes as a result in
 * any of the three states. That last one is criterion (e)'s actual content:
 * a throttle must change the OUTCOME, never the SHAPE of what the model sees.
 *
 * The direct tier is disabled through its OWN availability predicate (no env
 * token, no admin-store key) rather than a mock, so every byte here travels a
 * real socket into real code.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// D3 observability: `recordSerpResume` dynamically imports this service. Capture
// what the ladder actually reports so the test asserts on the EMITTED ROWS
// rather than on an intention. Other rows (web_fetch_path) pass through.
const mockRecordLoopMetric = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

const resumeRows = () => mockRecordLoopMetric.mock.calls
  .map(([row]) => row)
  .filter((row) => row && row.kind === 'web_serp_resume');

import http from 'http';
import type { AddressInfo } from 'net';

export {};

/** BrightData's own auto-throttle body, verbatim in shape from the reported run. */
const THROTTLE_TEXT = [
  'HTTP/1.1 429 The request was auto-throttled due to low success rate',
  'x-brd-error-code: sr_rate_limit',
  'x-brd-rate-limit-period-ms: 60000',
  'https://docs.brightdata.com/scraping-automation/serp-api/debugging#serp-api-error-catalog',
].join('\n');

/** Same shape, but a stated wait that is over the 8 s fail-fast cap yet small
 *  enough to wait out inside a test's own resume budget (D3). */
const THROTTLE_TEXT_9S = THROTTLE_TEXT.replace('period-ms: 60000', 'period-ms: 9000');

/** A real organic SERP text — what a healthy tool result looks like. */
const HEALTHY_TEXT = [
  'Organic results for "Polk County 281 arrested human trafficking bust":',
  '1. FOX 13 Tampa Bay — Disney workers, deputy and youth coach among 281 arrested in Polk County human trafficking sting.',
  '2. Polk County Sheriff\'s Office — Operation Polk Around & Find Out II, 488 charges filed.',
].join('\n');

const QUERY = 'Polk County 281 arrested human trafficking bust';

type Mode = 'healthy' | 'provider-throttle' | 'hard-429' | 'throttle-then-healthy';

let server: http.Server;
let mode: Mode = 'healthy';
/** Every POST the ladder actually made, with its arrival time. */
let attempts: number[] = [];

function rpcText(id: unknown, text: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }] },
  });
}

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url || '').startsWith('/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      // POST /mcp — a tools/call
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        attempts.push(Date.now());
        let id: unknown = null;
        try { id = JSON.parse(body)?.id ?? null; } catch { /* keep null */ }
        if (mode === 'healthy') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(rpcText(id, HEALTHY_TEXT));
          return;
        }
        if (mode === 'provider-throttle') {
          // The real gateway shape: HTTP 200, provider error text as the result.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(rpcText(id, THROTTLE_TEXT));
          return;
        }
        if (mode === 'throttle-then-healthy') {
          // Throttle ONCE with a 9 s stated wait — over the 8 s fail-fast cap,
          // under a caller's own resume budget — then answer honestly. This is
          // the shape a resume ladder has to survive: the ban lifts, the SAME
          // request is re-sent, and real results come back.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(rpcText(id, attempts.length === 1 ? THROTTLE_TEXT_9S : HEALTHY_TEXT));
          return;
        }
        // hard-429 — transport-level throttle
        res.writeHead(429, { 'content-type': 'text/plain' });
        res.end(THROTTLE_TEXT);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** Load the REAL module after the env seams are pointed at the local server. */
function load(origin: string): any {
  jest.resetModules();
  // Kill the direct tier through its OWN predicate: no env token, no store key.
  delete process.env.BRIGHTDATA_API_TOKEN;
  process.env.MCP_DIGBY_URL = `${origin}/mcp`;
  process.env.MCP_DIGBY_HEALTH_URL = `${origin}/health`;
  process.env.MCP_DIGBY_TOKEN = 'test-gateway-token';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./mcp-search');
}

beforeAll(async () => {
  const origin = await startServer();
  (global as any).__origin = origin;
});

afterAll(() => {
  server?.close();
  delete process.env.MCP_DIGBY_URL;
  delete process.env.MCP_DIGBY_HEALTH_URL;
  delete process.env.MCP_DIGBY_TOKEN;
});

beforeEach(() => {
  attempts = [];
  mode = 'healthy';
  // The emitted-rows mock is module-level and shared across tests; without this
  // a previous test's resume row would masquerade as this one's.
  mockRecordLoopMetric.mockClear();
});

describe('1cc1f52e (e) — a LIVE throttle through the real failover ladder', () => {
  it('healthy: the organic SERP comes back as the tool result in exactly ONE attempt', async () => {
    // jest.resetModules() + re-require gives a FRESH module registry, so the
    // circuit breaker starts closed on every load — no test-only hook needed.
    const { callMcpTool } = load((global as any).__origin);
    const out = await callMcpTool('search_engine', { query: QUERY });
    expect(out).toBe(HEALTHY_TEXT);
    expect(attempts).toHaveLength(1);
  }, 20000);

  it('provider throttle text on HTTP 200: fails FAST to null — the error text never escapes as results', async () => {
    // jest.resetModules() + re-require gives a FRESH module registry, so the
    // circuit breaker starts closed on every load — no test-only hook needed.
    const { callMcpTool } = load((global as any).__origin);
    mode = 'provider-throttle';
    const out = await callMcpTool('search_engine', { query: QUERY });
    // (e)'s real content: the model must never receive the provider's apology
    // text AS a search result. The honest degradation is null.
    expect(out).toBeNull();
    expect(out).not.toEqual(expect.stringContaining('auto-throttled'));
    // The provider stated a 60 s minimum wait (> the 8 s cap) → fail-fast by
    // design: ONE request, no retry storm against a limit already refused.
    expect(attempts).toHaveLength(1);
  }, 20000);

  it('hard 429: the bounded retry ladder runs and still degrades to null, never to the error body', async () => {
    // jest.resetModules() + re-require gives a FRESH module registry, so the
    // circuit breaker starts closed on every load — no test-only hook needed.
    const { callMcpTool } = load((global as any).__origin);
    mode = 'hard-429';
    const t0 = Date.now();
    const out = await callMcpTool('search_engine', { query: QUERY });
    const elapsed = Date.now() - t0;
    expect(out).toBeNull();
    // search_engine's budget is 4 attempts (2s→4s→8s backoff ≈14 s).
    expect(attempts).toHaveLength(4);
    expect(elapsed).toBeGreaterThanOrEqual(13000);
    // Bounded, and the backoff actually spaced the attempts.
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(1900);
    expect(attempts[3] - attempts[2]).toBeGreaterThanOrEqual(7800);
  }, 40000);

  it('the delivered SHAPE is identical across all three states: text or null, never a provider error body', async () => {
    const { callMcpTool } = load((global as any).__origin);
    const observed: Array<{ mode: Mode; shape: string; attempts: number }> = [];
    for (const m of ['healthy', 'provider-throttle', 'hard-429'] as Mode[]) {
      attempts = [];
      mode = m;
      const out = await callMcpTool('search_engine', { query: QUERY });
      observed.push({
        mode: m,
        shape: out === null ? 'null' : typeof out === 'string' ? 'text' : typeof out,
        attempts: attempts.length,
      });
    }
    // The SHAPE vocabulary is closed: only real text or an honest null. A
    // throttle moves which one you get — never the set of shapes.
    expect(observed.map(o => o.shape)).toEqual(['text', 'null', 'null']);
    // …and every non-healthy state is bounded.
    expect(observed.filter(o => o.mode !== 'healthy').every(o => o.attempts <= 4)).toBe(true);
  }, 60000);

  // ── D3 (goal 9ecd595e): the resume ladder ───────────────────────────────────
  // These two are the pair that proves the fix is an OPT-IN and not a blanket
  // de-fanging of the ca805a61 fail-fast contract.

  it('D3 default (no resumeBudgetMs): a 9s-stated throttle still FAILS FAST — the interactive contract is untouched', async () => {
    const { callMcpTool } = load((global as any).__origin);
    mode = 'throttle-then-healthy';
    const t0 = Date.now();
    const out = await callMcpTool('search_engine', { query: QUERY });
    const elapsed = Date.now() - t0;
    // 9s > the 8s cap and no budget was offered → exactly today's behaviour.
    expect(out).toBeNull();
    expect(attempts).toHaveLength(1);
    expect(elapsed).toBeLessThan(2000); // no waiting at all
  }, 20000);

  it('D3 opt-in (resumeBudgetMs): the same throttle is WAITED OUT and the call RESUMES to real results', async () => {
    const { callMcpTool } = load((global as any).__origin);
    mode = 'throttle-then-healthy';
    const t0 = Date.now();
    const out = await callMcpTool('search_engine', { query: QUERY }, undefined, { resumeBudgetMs: 30000 });
    const elapsed = Date.now() - t0;
    // THE POINT OF D3: the call does not surface the throttle — it comes back
    // with the real SERP, having re-sent the SAME logical request.
    expect(out).toBe(HEALTHY_TEXT);
    expect(out).not.toEqual(expect.stringContaining('auto-throttled'));
    // It really did retry (2 requests), and it really did wait out the stated ban.
    expect(attempts).toHaveLength(2);
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(8500);
    expect(elapsed).toBeGreaterThanOrEqual(8500);
  }, 45000);

  it('D3 budget is a ceiling: a stated wait beyond it still fails fast rather than overrunning', async () => {
    const { callMcpTool } = load((global as any).__origin);
    mode = 'throttle-then-healthy';
    const t0 = Date.now();
    // The provider states 9s; the caller can only afford 4s → must NOT wait.
    const out = await callMcpTool('search_engine', { query: QUERY }, undefined, { resumeBudgetMs: 4000 });
    const elapsed = Date.now() - t0;
    expect(out).toBeNull();
    expect(attempts).toHaveLength(1);
    expect(elapsed).toBeLessThan(2000);
  }, 20000);

  // ── D3 OBSERVABILITY (goal 9ecd595e): a resume must be MEASURABLE ───────────
  // Before this, the ladder left only a `logger.info` line inside a container,
  // so "a resume happened" and "no throttle occurred" were the same reading:
  // zero rows. These pin the asymmetry in both directions.

  it('D3 observability: a call that WAITED OUT a stated throttle emits exactly ONE web_serp_resume row saying so', async () => {
    const { callMcpTool } = load((global as any).__origin);
    mode = 'throttle-then-healthy';
    const out = await callMcpTool('search_engine', { query: QUERY }, undefined, { resumeBudgetMs: 30000 });
    expect(out).toBe(HEALTHY_TEXT);

    // recordSerpResume fire-and-forgets a dynamic import; let it settle.
    await new Promise(r => setTimeout(r, 200));
    const rows = resumeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('web_serp_resume');
    expect(rows[0].meta).toMatchObject({
      tool: 'search_engine',
      outcome: 'resumed',
      resumeWaits: 1,
      statedWaitMs: 9000,
      budgetMs: 30000,
    });
    // The row is a real measurement of the wait, not a constant.
    expect(rows[0].value).toBeGreaterThanOrEqual(8500);
    expect(rows[0].meta.waitedMs).toBeGreaterThanOrEqual(8500);
  }, 45000);

  it('D3 observability: the DEFAULT fail-fast path emits NO row — silence now means "no resume", not "unobservable"', async () => {
    const { callMcpTool } = load((global as any).__origin);
    mode = 'throttle-then-healthy';
    // No resumeBudgetMs → ca805a61 fail-fast. It must stay silent: an emitted
    // row here would make every ordinary throttle look like a resume.
    const out = await callMcpTool('search_engine', { query: QUERY });
    expect(out).toBeNull();
    await new Promise(r => setTimeout(r, 200));
    expect(resumeRows()).toHaveLength(0);
  }, 20000);

  it('D3 observability: a budget too small to wait emits NO row either — only an ACTUAL resume counts', async () => {
    const { callMcpTool } = load((global as any).__origin);
    mode = 'throttle-then-healthy';
    const out = await callMcpTool('search_engine', { query: QUERY }, undefined, { resumeBudgetMs: 4000 });
    expect(out).toBeNull();
    await new Promise(r => setTimeout(r, 200));
    expect(resumeRows()).toHaveLength(0);
  }, 20000);
});
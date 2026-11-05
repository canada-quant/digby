/**
 * Interactive cloud-browser actions must ALL ride this driver's MCP wire
 * session — ticket bbe53f95.
 *
 * MEASURED DEFECT (prod box A, the DEPLOYED dist, CLOUD_BROWSER_CDP=1):
 *   open        ok=true  len=1565  9604ms   cap=cdp
 *   snapshot    ok=true  len=1896    622ms
 *   follow-link ok=true  len=3143   2342ms
 *   scroll      ok=FALSE          75409ms   ← "scraping_browser_scroll SSE
 *                                              stream timed out (60s)"
 * The SAME `scraping_browser_scroll` against the SAME Mcp-Session-Id, hand
 * rolled over raw HTTP, answered in 380 ms. So the session was fine and the
 * gateway was fine — the DRIVER was calling the wrong mount.
 *
 * Root cause: `scroll()`, `screenshot()` and `liveView()` called
 * `callMcpTool(...)` DIRECTLY instead of going through the driver's private
 * `cdp()` helper. `cdp()` is what supplies the two halves of the wire-session
 * contract:
 *   - `sessionKey`  → `mcpSessions.headers()` mints/rides the Mcp-Session-Id,
 *                     so all calls share ONE gateway stdio child (ONE browser)
 *   - `gatewayUrl`  → the STATEFUL `/browser/mcp` mount
 * Without them a `scraping_browser_*` call lands on the SHARED STATELESS `/mcp`
 * mount and gets its own fresh stdio child — hence its own blank browser. It
 * scrolls/screenshots a page nobody navigated, and (because that child has to
 * cold-start a CDP session for nothing) typically times out at the 60 s SSE cap.
 *
 * These tests are BEHAVIOURAL (they assert on the call the driver makes), so
 * they fail if any future edit deep-links a `scraping_browser_*` call past
 * `cdp()` again, whatever the reason.
 *
 * cloud-driver reads CLOUD_BROWSER_CDP AT MODULE LOAD (repo idiom), so every
 * case does jest.resetModules() + env setup + require.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCallMcpTool = jest.fn();
jest.mock('../mcp-search', () => ({
  __esModule: true,
  callMcpTool: (...a: any[]) => mockCallMcpTool(...a),
  // The session targets `cdp()` depends on. A module mock must mirror them, or
  // `cdp()` throws and every action falls back to the scrape path — which would
  // make the assertions below vacuous.
  mcpGatewayTarget: () => ({ url: 'https://mcp.test/mcp', token: 'test-token' }),
  mcpBrowserGatewayTarget: () => ({ url: 'https://mcp.test/browser/mcp', token: 'test-token' }),
}));

const mockSessionHeaders = jest.fn(async () => ({ 'Mcp-Session-Id': 'sid-abc123' }));
jest.mock('../mcp-session', () => ({
  __esModule: true,
  mcpSessions: {
    headers: (...a: any[]): any => (mockSessionHeaders as any)(...a),
    release: jest.fn(async () => undefined),
    invalidate: jest.fn(),
  },
  browserMcpSessionKey: () => 'test:browser:session-key',
}));

const mockDirectScreenshotPng: any = jest.fn(async () => null);
jest.mock('../brightdata-direct', () => ({
  __esModule: true,
  directScreenshotPng: (...a: any[]): any => mockDirectScreenshotPng(...a),
}));

jest.mock('../platform/instance-setup', () => ({
  __esModule: true,
  webSearchStatus: () => ({ configured: true }),
  webSearchProblemSuffix: () => '',
}));

// Module marker (repo idiom: keeps this file a module, not a global script).
export {};

const SAVED_CDP = process.env.CLOUD_BROWSER_CDP;

/** Options bag the driver attaches to every session-scoped gateway call. */
const SESSION_OPTS = {
  sessionKey: 'test:browser:session-key',
  gatewayUrl: 'https://mcp.test/browser/mcp',
};

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockSessionHeaders.mockImplementation(async () => ({ 'Mcp-Session-Id': 'sid-abc123' }));
  mockDirectScreenshotPng.mockImplementation(async () => null);
  process.env.CLOUD_BROWSER_CDP = '1'; // interactive: CDP enabled
});

afterEach(() => {
  if (SAVED_CDP === undefined) delete process.env.CLOUD_BROWSER_CDP;
  else process.env.CLOUD_BROWSER_CDP = SAVED_CDP;
});

function loadDriver() {
  const { CloudBrowserDriver } = require('./cloud-driver');
  return new CloudBrowserDriver();
}

/**
 * Drive the driver to mode==='cdp' the way production does: one successful
 * navigate (which also reads the page text), then hand back the driver.
 */
async function loadedDriver() {
  mockCallMcpTool.mockImplementation(async (tool: string) => {
    if (tool === 'scraping_browser_navigate') return 'Example Domain page body';
    if (tool === 'scraping_browser_get_text') return 'Example Domain page body';
    return null;
  });
  const driver = loadDriver();
  const nav = await driver.execute({ name: 'navigate', url: 'https://example.test/' });
  expect(nav.ok).toBe(true);
  expect(driver.interactionCapability()).toBe('cdp');
  mockCallMcpTool.mockClear();
  return driver;
}

/** The options bag of the Nth recorded call to `tool`. */
function optsFor(tool: string) {
  const call = mockCallMcpTool.mock.calls.find((c) => c[0] === tool);
  expect(call).toBeDefined();
  return call![3];
}

describe('interactive cloud actions ride the MCP wire session (ticket bbe53f95)', () => {
  it('scroll rides the session — sessionKey + stateful /browser/mcp mount', async () => {
    const driver = await loadedDriver();
    mockCallMcpTool.mockImplementation(async (tool: string) =>
      tool === 'scraping_browser_scroll' ? 'Scrolled down' : null);

    const res = await driver.execute({ name: 'scroll', direction: 'down' });

    expect(res.ok).toBe(true);
    // THE REGRESSION PIN: these two options are the whole fix. Without them the
    // call lands on the stateless /mcp mount with a fresh, blank browser.
    // (The handshake itself happens inside the real `callMcpTool`, which is
    // mocked at this seam — so the wire contract this driver OWNS and can get
    // wrong is precisely the options bag it passes.)
    expect(optsFor('scraping_browser_scroll')).toEqual(SESSION_OPTS);
  });

  it('scroll forwards an explicit pixel amount through the session', async () => {
    const driver = await loadedDriver();
    mockCallMcpTool.mockImplementation(async (tool: string) =>
      tool === 'scraping_browser_scroll' ? 'Scrolled' : null);

    await driver.execute({ name: 'scroll', direction: 'up', amount: 480 });

    const call = mockCallMcpTool.mock.calls.find((c) => c[0] === 'scraping_browser_scroll')!;
    expect(call[1]).toEqual({ direction: 'up', pixels: 480 });
    expect(call[3]).toEqual(SESSION_OPTS);
  });

  it('screenshot rides the session', async () => {
    const driver = await loadedDriver();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    mockCallMcpTool.mockImplementation(async (tool: string) =>
      tool === 'scraping_browser_screenshot' ? png : null);

    const res = await driver.execute({ name: 'screenshot' });

    expect(res.ok).toBe(true);
    expect(res.screenshotBase64).toBe(png);
    expect(optsFor('scraping_browser_screenshot')).toEqual(SESSION_OPTS);
  });

  it('liveView rides the session (the panel render is the SESSION page)', async () => {
    const driver = await loadedDriver();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    mockCallMcpTool.mockImplementation(async (tool: string) =>
      tool === 'scraping_browser_screenshot' ? png : null);

    const frame = await driver.liveView();

    expect(frame?.screenshotBase64).toBe(png);
    expect(optsFor('scraping_browser_screenshot')).toEqual(SESSION_OPTS);
    // A live CDP session must NOT fall back to the URL-render (Web Unlocker)
    // path — that path cannot show a scrolled/interacted page.
    expect(mockDirectScreenshotPng).not.toHaveBeenCalled();
  });

  it('click and type keep riding the session (no regression on the already-correct pair)', async () => {
    const driver = await loadedDriver();
    mockCallMcpTool.mockImplementation(async () => 'ok');

    await driver.execute({ name: 'click', ref: 'e5', element: 'link "Learn more"' });
    await driver.execute({ name: 'type', ref: 'e7', text: 'hello', element: 'textbox "Search"' });

    expect(optsFor('scraping_browser_click_ref')).toEqual(SESSION_OPTS);
    expect(optsFor('scraping_browser_type_ref')).toEqual(SESSION_OPTS);
  });

  it('EVERY scraping_browser_* call carries the session contract — the class guard', async () => {
    // The point of this case: a future edit must not deep-link ANY browser tool
    // past cdp(). Enumerate what a full session does and assert each call.
    const driver = await loadedDriver();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    mockCallMcpTool.mockImplementation(async (tool: string) => {
      if (tool === 'scraping_browser_screenshot') return png;
      return 'ok';
    });

    await driver.execute({ name: 'scroll', direction: 'down' });
    await driver.execute({ name: 'screenshot' });
    await driver.execute({ name: 'click', ref: 'e5' });
    await driver.execute({ name: 'type', ref: 'e7', text: 'x', element: 'textbox' });
    await driver.execute({ name: 'get_content', format: 'snapshot' });

    const browserCalls = mockCallMcpTool.mock.calls.filter((c) =>
      String(c[0]).startsWith('scraping_browser_'));
    expect(browserCalls.length).toBeGreaterThan(0);
    for (const call of browserCalls) {
      expect({ tool: call[0], opts: call[3] }).toEqual({ tool: call[0], opts: SESSION_OPTS });
    }
  });

  it('the scrape fallback still rides the SHARED stateless mount (unchanged contract)', async () => {
    // Guard against an over-eager fix: the read-only scrape path is NOT a
    // session call and must keep its byte-identical pre-fix shape (no opts).
    mockCallMcpTool.mockImplementation(async (tool: string) =>
      tool === 'scrape_as_markdown' ? '# Page' : null);
    delete process.env.CLOUD_BROWSER_CDP; // prod default: read-only scrape mode
    jest.resetModules();
    const { CloudBrowserDriver } = require('./cloud-driver');
    const driver = new CloudBrowserDriver();

    const nav = await driver.execute({ name: 'navigate', url: 'https://example.test/' });

    expect(nav.ok).toBe(true);
    const call = mockCallMcpTool.mock.calls.find((c) => c[0] === 'scrape_as_markdown')!;
    expect(call[3]).toBeUndefined();
  });
});
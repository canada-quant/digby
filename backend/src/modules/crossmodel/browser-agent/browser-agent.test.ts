/**
 * browser_task read-only capability surfacing — feedback c3c06260.
 *
 * The CLOUD browser driver silently degrades to read-only when interactive
 * browsing is unavailable — either the BrightData Scraping Browser zone blocks
 * this server's egress IP (407 ip_forbidden) OR CDP is disabled by config
 * (CLOUD_BROWSER_CDP unset, the prod default) — and the CALLING agent used to
 * discover it only from sub-agent narration several steps in. These tests pin:
 *   1. CloudBrowserDriver.interactionCapability() names the REAL cause
 *      (zone-blocked vs disabled-by-config vs transient-unavailable), and the
 *      read-only refusal text is cause-aware (no more blanket "zone is blocking").
 *   2. runBrowserAgentSession appends a READ-ONLY ceiling to the cloud system
 *      prompt when the ceiling is knowable up front (disabled-by-config), and
 *      ends read-only cloud sessions with a hard, cause-naming capabilityNotice
 *      (unless the local Mac fallback engaged).
 *   3. formatBrowserTaskToolResult (tool-executor) PREPENDS that notice as a
 *      hard banner so it is the first thing the calling model reads — and stays
 *      byte-identical to the legacy format when no notice is present.
 *
 * cloud-driver reads CLOUD_BROWSER_CDP AT MODULE LOAD, so every case does
 * jest.resetModules() + env setup + require (repo idiom: wrapper arrows over
 * module-level mock fns keep one assertion target across the resets).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCallMcpTool = jest.fn();
jest.mock('../mcp-search', () => ({
  __esModule: true,
  callMcpTool: (...a: any[]) => mockCallMcpTool(...a),
  // Real exports the driver calls for the stateful browser mount (ticket
  // 5f69fdc4). A module mock must mirror them or `cdp()` throws and every
  // navigate falls back to scrape — which is NOT what these tests assert.
  mcpGatewayTarget: () => ({ url: 'https://mcp.test/mcp', token: 'test-token' }),
  mcpBrowserGatewayTarget: () => ({ url: 'https://mcp.test/browser/mcp', token: 'test-token' }),
}));

const mockGlmChat = jest.fn();
jest.mock('./glm-client', () => ({
  __esModule: true,
  glmChat: (...a: any[]) => mockGlmChat(...a),
  glmConfigured: () => true,
  stripThink: (s: string) => s,
}));

const mockSelectBrowserDriver = jest.fn();
const mockSelectLocalFallback = jest.fn();
jest.mock('./router', () => ({
  __esModule: true,
  selectBrowserDriver: (...a: any[]) => mockSelectBrowserDriver(...a),
  selectLocalFallbackDriver: (...a: any[]) => mockSelectLocalFallback(...a),
}));

// tool-executor's import graph reaches prisma / upload / pipes — mock the same
// boundaries document-tools.test.ts does so requiring it stays hermetic.
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(async () => null) }));
jest.mock('../coding/web-pipe', () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock('../coding/youtube-pipe', () => ({ __esModule: true, runYoutubePipe: jest.fn() }));

// Module marker — without any import/export this file would be a global script
// and its top-level consts could collide with other script-style tests (TS2451).
export {};

const SAVED_CDP = process.env.CLOUD_BROWSER_CDP;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  delete process.env.CLOUD_BROWSER_CDP; // prod default: CDP disabled by config
});

afterEach(() => {
  if (SAVED_CDP === undefined) delete process.env.CLOUD_BROWSER_CDP;
  else process.env.CLOUD_BROWSER_CDP = SAVED_CDP;
});

/** Fresh driver instance whose module read the CURRENT env at load. */
function loadDriver() {
  const { CloudBrowserDriver } = require('./cloud-driver');
  return new CloudBrowserDriver();
}

function loadGlmLoop() {
  return require('./glm-loop');
}

describe('CloudBrowserDriver — interactionCapability + cause-aware refusals (c3c06260)', () => {
  it('CDP disabled by config: eager disabled-by-config, scrape navigate works, click refusal names the config cause', async () => {
    mockCallMcpTool.mockImplementation(async (tool: string) => (tool === 'scrape_as_markdown' ? '# Page' : null));
    const driver = loadDriver();

    // Eager signal — knowable BEFORE any navigate.
    expect(driver.interactionCapability()).toBe('disabled-by-config');

    const nav = await driver.execute({ name: 'navigate', url: 'https://example.test/' });
    expect(nav.ok).toBe(true);
    expect(nav.content).toContain('# Page');
    expect(mockCallMcpTool).toHaveBeenCalledWith('scrape_as_markdown', { url: 'https://example.test/' }, expect.any(Number));
    // CDP is never attempted in this config.
    expect(mockCallMcpTool).not.toHaveBeenCalledWith('scraping_browser_navigate', expect.anything(), expect.anything());

    const click = await driver.execute({ name: 'click', ref: 'e5' });
    expect(click.ok).toBe(false);
    expect(click.error).toContain('CLOUD_BROWSER_CDP');
    expect(click.error).not.toContain('zone is blocking');
    expect(click.error).not.toContain('ip_forbidden');
    expect(driver.wasInteractiveRefused()).toBe(true);
    expect(driver.interactionCapability()).toBe('disabled-by-config');
  });

  it('CDP enabled + zone-block text: navigate falls back to scrape, capability is zone-blocked, refusal names the allowlist fix', async () => {
    process.env.CLOUD_BROWSER_CDP = '1';
    mockCallMcpTool.mockImplementation(async (tool: string) => {
      if (tool === 'scraping_browser_navigate') return 'Error: connectOverCDP WebSocket error: 407 Auth Failed (ip_forbidden)';
      if (tool === 'scrape_as_markdown') return '# Page';
      return null;
    });
    const driver = loadDriver();

    const nav = await driver.execute({ name: 'navigate', url: 'https://example.test/' });
    expect(nav.ok).toBe(true); // read-only scrape fallback
    expect(nav.content).toContain('# Page');
    expect(driver.interactionCapability()).toBe('zone-blocked');

    const click = await driver.execute({ name: 'click', ref: 'e5' });
    expect(click.ok).toBe(false);
    expect(click.error).toContain('egress IP');
    expect(click.error).toContain('allowlist');
    expect(driver.wasInteractiveRefused()).toBe(true);
  });

  it('CDP enabled + transient null (gateway swallowed the error): capability is unavailable, NOT zone-blocked', async () => {
    process.env.CLOUD_BROWSER_CDP = '1';
    mockCallMcpTool.mockImplementation(async (tool: string) => (tool === 'scrape_as_markdown' ? '# Page' : null));
    const driver = loadDriver();

    const nav = await driver.execute({ name: 'navigate', url: 'https://example.test/' });
    expect(nav.ok).toBe(true); // scrape fallback still serves the page
    expect(driver.interactionCapability()).toBe('unavailable');
    expect(driver.interactionCapability()).not.toBe('zone-blocked');
  });

  it('CDP mid-session zone-block (live session drops): a blocked click flips capability to zone-blocked, NOT a false cdp (review F1)', async () => {
    process.env.CLOUD_BROWSER_CDP = '1';
    mockCallMcpTool.mockImplementation(async (tool: string) => {
      if (tool === 'scraping_browser_navigate') return 'navigated ok';
      if (tool === 'scraping_browser_get_text') return 'page text';
      if (tool === 'scraping_browser_click_ref') return 'Error: 407 Auth Failed (ip_forbidden)';
      if (tool === 'scrape_as_markdown') return '# Page';
      return null;
    });
    const driver = loadDriver();

    const nav = await driver.execute({ name: 'navigate', url: 'https://example.test/' });
    expect(nav.ok).toBe(true);
    expect(driver.interactionCapability()).toBe('cdp'); // live interactive session

    const click = await driver.execute({ name: 'click', ref: 'e5' });
    expect(click.ok).toBe(false);
    // The session ends zone-blocked, NOT 'cdp' — otherwise no capabilityNotice
    // would fire and the block would stay invisible (the ticket's failure mode).
    expect(driver.interactionCapability()).toBe('zone-blocked');
  });

  it('a successful CDP navigate after a mid-session block clears the zone-block signal (review F1)', async () => {
    process.env.CLOUD_BROWSER_CDP = '1';
    let unblock = false;
    mockCallMcpTool.mockImplementation(async (tool: string) => {
      if (tool === 'scraping_browser_navigate') return 'navigated ok';
      if (tool === 'scraping_browser_get_text') return 'page text';
      if (tool === 'scraping_browser_click_ref') return unblock ? 'clicked' : 'Error: 407 Auth Failed (ip_forbidden)';
      if (tool === 'scrape_as_markdown') return '# Page';
      return null;
    });
    const driver = loadDriver();

    await driver.execute({ name: 'navigate', url: 'https://example.test/' });
    expect(driver.interactionCapability()).toBe('cdp');
    await driver.execute({ name: 'click', ref: 'e5' }); // mid-session block
    expect(driver.interactionCapability()).toBe('zone-blocked');

    unblock = true;
    // mode is still 'cdp' (never demoted), so the next navigate retries CDP —
    // its success proves the zone lets us through again.
    await driver.execute({ name: 'navigate', url: 'https://example.test/2' });
    expect(driver.interactionCapability()).toBe('cdp');
  });

  it('CDP enabled + EMPTY get_text: falls through to the scrape path instead of ok:true with 0 bytes (5f69fdc4)', async () => {
    process.env.CLOUD_BROWSER_CDP = '1';
    mockCallMcpTool.mockImplementation(async (tool: string) => {
      if (tool === 'scraping_browser_navigate') return 'navigated ok';
      if (tool === 'scraping_browser_get_text') return ''; // live session, blank read
      if (tool === 'scrape_as_markdown') return '# Page';
      return null;
    });
    const driver = loadDriver();

    const nav = await driver.execute({ name: 'navigate', url: 'https://example.test/' });
    // Pre-fix this returned ok:true with content '' — indistinguishable from a
    // genuinely empty document. The scrape path must serve the rendered page.
    expect(nav.ok).toBe(true);
    expect(nav.content).toContain('# Page');
    expect(mockCallMcpTool).toHaveBeenCalledWith('scrape_as_markdown', { url: 'https://example.test/' }, expect.any(Number));
  });

  it('CDP enabled + WHITESPACE-ONLY get_text is treated as empty too (5f69fdc4)', async () => {
    process.env.CLOUD_BROWSER_CDP = '1';
    mockCallMcpTool.mockImplementation(async (tool: string) => {
      if (tool === 'scraping_browser_navigate') return 'navigated ok';
      if (tool === 'scraping_browser_get_text') return '   \n\t  ';
      if (tool === 'scrape_as_markdown') return '# Page';
      return null;
    });
    const driver = loadDriver();

    const nav = await driver.execute({ name: 'navigate', url: 'https://example.test/' });
    expect(nav.ok).toBe(true);
    expect(nav.content).toContain('# Page');
  });
});

describe('runBrowserAgentSession — capabilityNotice + read-only ceiling (c3c06260)', () => {
  const turn = (id: string, name: string, args: any) => ({
    content: '',
    tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
  });
  const LOCAL_STATUS = 'connected but too old — Mac app v0.1.0; the local browser needs v0.2.0 or newer';

  it('read-only cloud session (CDP disabled, no local fallback): notice names the cause, the local status, and the remediation tool; system prompt carries the eager ceiling', async () => {
    const driver = loadDriver(); // env unset → disabled-by-config
    mockSelectBrowserDriver.mockResolvedValue({ driver, kind: 'cloud', reason: 'r', localStatus: LOCAL_STATUS });
    mockSelectLocalFallback.mockResolvedValue(null);

    // Snapshot the system prompt AT EACH CALL — the mock records the messages
    // array by reference, so reading .mock.calls later shows the mutated end state.
    const sysAtCall: string[] = [];
    mockGlmChat.mockImplementation((input: any) => {
      sysAtCall.push(String(input.messages[0]?.content ?? ''));
      return Promise.resolve(
        sysAtCall.length === 1
          ? turn('t1', 'click', { ref: 'e5' })
          : turn('t2', 'done', { message: 'partial findings' }),
      );
    });

    const events: Array<{ type: string; data: any }> = [];
    const { runBrowserAgentSession } = loadGlmLoop();
    const result = await runBrowserAgentSession({
      userId: 'u1', chatId: null, message: 'log in and pull the invoice list', maxSteps: 5,
      sendEvent: (t: string, d: any) => events.push({ type: t, data: d }),
    });

    expect(result.driverUsed).toBe('cloud');
    expect(result.finalResponse).toBe('partial findings');
    expect(result.capabilityNotice).toBeDefined();
    expect(result.capabilityNotice).toContain('READ-ONLY');
    expect(result.capabilityNotice).toContain('CLOUD_BROWSER_CDP'); // disabled-by-config cause
    expect(result.capabilityNotice).toContain(LOCAL_STATUS);
    expect(result.capabilityNotice).toContain('get_platform_network_info');

    // The driving model was told at STEP 0, not after a refused click.
    expect(sysAtCall[0]).toContain('READ-ONLY');
    expect(sysAtCall[0]).toContain('click/type/scroll/screenshot WILL be refused');

    // Additive SSE: the full-page browser_agent mode renders progress events.
    expect(events.some((e) => e.type === 'progress' && e.data?.stage === 'browser-capability'
      && String(e.data?.message).includes('READ-ONLY'))).toBe(true);
  });

  it('NO notice when the cloud→local fallback engages (interactive session on the Mac browser)', async () => {
    const driver = loadDriver(); // read-only cloud
    mockSelectBrowserDriver.mockResolvedValue({ driver, kind: 'cloud', reason: 'r', localStatus: LOCAL_STATUS });
    const localDriver = {
      kind: 'local' as const,
      isAvailable: jest.fn(async () => true),
      execute: jest.fn(async (action: any) => ({ ok: true, driver: 'local', action: action.name, content: 'x' })),
      close: jest.fn(async () => {}),
    };
    mockSelectLocalFallback.mockResolvedValue({
      driver: localDriver, kind: 'local',
      reason: 'switching to your Mac browser', localStatus: 'connected (Mac app v0.2.1)',
    });
    // Snapshot the system prompt AT EACH CALL (see the notice test above).
    const sysAtCall: string[] = [];
    mockGlmChat.mockImplementation((input: any) => {
      sysAtCall.push(String(input.messages[0]?.content ?? ''));
      return Promise.resolve(
        sysAtCall.length === 1
          ? turn('t1', 'click', { ref: 'e5' })  // refused → fallback engages
          : turn('t2', 'done', { message: 'done via the Mac browser' }),
      );
    });

    const { runBrowserAgentSession } = loadGlmLoop();
    const result = await runBrowserAgentSession({
      userId: 'u1', chatId: null, message: 'log in and pull the invoice list', maxSteps: 5,
      sendEvent: () => {},
    });

    expect(mockSelectLocalFallback).toHaveBeenCalledWith('u1');
    // Regression pin (b346ce80): with a usable Mac fallback, the eager READ-ONLY
    // ceiling must NOT be pinned into the prompt — it would suppress the very
    // click refusal that triggers this re-route, stranding the online Mac.
    expect(sysAtCall[0]).not.toContain('READ-ONLY from the start');
    expect(result.driverUsed).toBe('local');
    expect(result.finalResponse).toBe('done via the Mac browser');
    expect(result.capabilityNotice).toBeUndefined();
    expect(localDriver.close).toHaveBeenCalled();
  });
});

describe('runBrowserAgentSession — the banner only when the read-only limit BIT (ticket ccd634fb)', () => {
  const turn = (id: string, name: string, args: any) => ({
    content: '',
    tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
  });
  const LOCAL_STATUS = 'not connected — no Digby Mac agent is paired';
  const SAVED = process.env.BROWSER_READONLY_BANNER_ON_NEED_DISABLED;
  afterEach(() => {
    if (SAVED === undefined) delete process.env.BROWSER_READONLY_BANNER_ON_NEED_DISABLED;
    else process.env.BROWSER_READONLY_BANNER_ON_NEED_DISABLED = SAVED;
  });

  async function run(script: Array<ReturnType<typeof turn> | { content: string }>, maxSteps = 5) {
    mockCallMcpTool.mockImplementation(async (tool: string) => (tool === 'scrape_as_markdown' ? '# Example Domain\nThis domain is for use in documentation examples.' : null));
    const driver = loadDriver(); // CDP disabled by config — every cloud session is read-only
    mockSelectBrowserDriver.mockResolvedValue({ driver, kind: 'cloud', reason: 'r', localStatus: LOCAL_STATUS });
    mockSelectLocalFallback.mockResolvedValue(null);
    let i = 0;
    mockGlmChat.mockImplementation(() => Promise.resolve(script[Math.min(i++, script.length - 1)]));
    const events: Array<{ type: string; data: any }> = [];
    const { runBrowserAgentSession } = loadGlmLoop();
    const result = await runBrowserAgentSession({
      userId: 'u1', chatId: null, message: 'use the browser to open https://example.com and tell me the exact page heading',
      maxSteps, liveView: false, sendEvent: (t: string, d: any) => events.push({ type: t, data: d }),
    });
    return { result, events };
  }

  it('the nightly 05-tools-browser shape: a pure page read (navigate → done) carries NO banner, only a header note', async () => {
    const { result, events } = await run([
      turn('t1', 'navigate', { url: 'https://example.com' }),
      turn('t2', 'done', { message: 'The heading is "Example Domain".' }),
    ]);
    expect(result.finalResponse).toBe('The heading is "Example Domain".');
    expect(result.capabilityNotice).toBeUndefined();
    expect(result.readOnlyNote).toMatch(/read-only cloud browser/);
    expect(events.some((e) => e.data?.stage === 'browser-capability')).toBe(false);
    const out = require('../tool-executor').formatBrowserTaskToolResult(result);
    expect(out.startsWith('[Browser agent result — driver: cloud, steps: 2')).toBe(true);
    expect(out).toContain(' · mode: read-only cloud browser');
    expect(out).not.toMatch(/UNAVAILABLE/);
  });

  it('done with needs_interaction=true keeps the hard banner (the part needing a click is NOT done)', async () => {
    const { result, events } = await run([
      turn('t1', 'navigate', { url: 'https://example.com' }),
      turn('t2', 'done', { message: 'I read the page but the form needs a login.', needs_interaction: true }),
    ]);
    expect(result.capabilityNotice).toContain('READ-ONLY');
    expect(result.readOnlyNote).toBeUndefined();
    expect(events.some((e) => e.data?.stage === 'browser-capability')).toBe(true);
  });

  it('an answer that SAYS it could not interact keeps the banner even without the flag', async () => {
    const { result } = await run([
      turn('t1', 'navigate', { url: 'https://example.com' }),
      turn('t2', 'done', { message: 'I could not click the Accept button, so the list is partial.' }),
    ]);
    expect(result.capabilityNotice).toContain('READ-ONLY');
    const { answerReportsInteractionLimit } = loadGlmLoop();
    expect(answerReportsInteractionLimit('The heading is "Example Domain".')).toBe(false);
    expect(answerReportsInteractionLimit('The page requires a login to see prices.')).toBe(true);
    expect(answerReportsInteractionLimit('Interaction was unavailable, so I read the public page only.')).toBe(true);
  });

  it('a refused interactive action keeps the hard banner even when done is clean', async () => {
    const { result } = await run([
      turn('t1', 'click', { ref: 'e5' }),
      turn('t2', 'done', { message: 'partial findings' }),
    ]);
    expect(result.capabilityNotice).toContain('READ-ONLY');
  });

  it('a plain final turn (no tool call) is the model\'s own answer — no banner', async () => {
    const { result } = await run([
      turn('t1', 'navigate', { url: 'https://example.com' }),
      { content: 'The heading is "Example Domain".' },
    ]);
    expect(result.finalResponse).toBe('The heading is "Example Domain".');
    expect(result.capabilityNotice).toBeUndefined();
  });

  it('a session that did not end on the model\'s own answer (steps ran out → harness wrap-up) keeps the banner', async () => {
    const { result } = await run([
      turn('t1', 'navigate', { url: 'https://example.com' }),
      turn('t2', 'navigate', { url: 'https://example.com/more' }),
      { content: 'Wrapped report.' }, // the wrap-up call
    ], 2);
    expect(result.finalResponse).toBe('Wrapped report.');
    expect(result.capabilityNotice).toContain('READ-ONLY');
  });

  it('kill switch BROWSER_READONLY_BANNER_ON_NEED_DISABLED=1: every read-only cloud session carries the banner (old behaviour)', async () => {
    process.env.BROWSER_READONLY_BANNER_ON_NEED_DISABLED = '1';
    const { result } = await run([
      turn('t1', 'navigate', { url: 'https://example.com' }),
      turn('t2', 'done', { message: 'The heading is "Example Domain".' }),
    ]);
    expect(result.capabilityNotice).toContain('READ-ONLY');
    expect(result.readOnlyNote).toBeUndefined();
  });
});

describe('formatBrowserTaskToolResult — hard banner at the tool-result surface (c3c06260)', () => {
  function loadFormatter() {
    return require('../tool-executor').formatBrowserTaskToolResult;
  }

  const base = {
    finalResponse: '  findings here  ',
    elapsed: 1234,
    title: null,
    driverUsed: 'cloud',
    driverReason: 'cloud picked',
    localBrowserStatus: 'connected (Mac app v0.2.1)',
    steps: 3,
  };

  it('with capabilityNotice: banner is FIRST, then the notice, then the legacy header + text', () => {
    const formatBrowserTaskToolResult = loadFormatter();
    const notice = 'INTERACTION UNAVAILABLE — this browser session ran READ-ONLY. The cloud browser could not click, type, scroll, or screenshot: test cause.';
    const out = formatBrowserTaskToolResult({ ...base, capabilityNotice: notice });

    expect(out.startsWith('[BROWSER_TASK — INTERACTION UNAVAILABLE (hard capability limit)]\n')).toBe(true);
    expect(out).toContain(`\n${notice}\n`);
    expect(out).toContain('[Browser agent result — driver: cloud, steps: 3');
    expect(out.endsWith('\nfindings here')).toBe(true);
  });

  it('without capabilityNotice: byte-identical to the legacy format', () => {
    const formatBrowserTaskToolResult = loadFormatter();
    const expectedLegacy =
      '[Browser agent result — driver: cloud, steps: 3' +
      ' · local browser: connected (Mac app v0.2.1)' +
      ' · why: cloud picked]\nfindings here';
    expect(formatBrowserTaskToolResult(base)).toBe(expectedLegacy);
  });

  it('without the optional driver lines: byte-identical to the legacy minimal format', () => {
    const formatBrowserTaskToolResult = loadFormatter();
    const minimal = { finalResponse: 'findings here', elapsed: 5, driverUsed: 'cloud', steps: 1 };
    expect(formatBrowserTaskToolResult(minimal)).toBe('[Browser agent result — driver: cloud, steps: 1]\nfindings here');
  });
});

describe('forwardableBrowserObservation — browser_task → calling-lane event forwarding (UI Phase 6a)', () => {
  function load() {
    const te = require('../tool-executor');
    return { fwd: te.forwardableBrowserObservation, MAX: te.MAX_FORWARDED_SCREENSHOT_CHARS };
  }

  it('forwards a browser-observation verbatim under the coding-vocabulary name', () => {
    const { fwd } = load();
    const data = {
      action: 'navigate', ok: true, url: 'https://example.com/pricing',
      driver: 'cloud', preview: 'Example Domain…', reasoning: 'Opening the pricing page',
    };
    expect(fwd('browser-observation', data)).toEqual({ type: 'browser_observation', data });
  });

  it('forwards the separate screenshot event with its base64 payload intact', () => {
    const { fwd } = load();
    const data = { action: 'screenshot', ok: true, url: 'https://example.com', driver: 'local', screenshotBase64: 'iVBORw0KGgo=' };
    expect(fwd('browser-observation', data)).toEqual({ type: 'browser_observation', data });
  });

  it('drops an OVERSIZED screenshot payload from the frame — never the observation itself', () => {
    const { fwd, MAX } = load();
    const data = { action: 'screenshot', ok: true, url: 'https://example.com', driver: 'local', screenshotBase64: 'x'.repeat(MAX + 1) };
    expect(fwd('browser-observation', data)).toEqual({
      type: 'browser_observation',
      data: { action: 'screenshot', ok: true, url: 'https://example.com', driver: 'local' },
    });
  });

  it("the sub-session's OWN narration stays private: progress/chunk/confirm never forward", () => {
    const { fwd } = load();
    expect(fwd('progress', { message: 'Reading the page…', stage: 'browsing' })).toBeNull();
    expect(fwd('chunk', { content: 'final answer text' })).toBeNull();
    expect(fwd('confirm', { action: 'click' })).toBeNull();
    expect(fwd('browser-observation', null)).toBeNull();
    expect(fwd('browser-observation', 'not an object')).toBeNull();
  });
});

describe('forwardableBrowserObservation — computer_task frames (computer use, 2026-09-09)', () => {
  function load() {
    const te = require('../tool-executor');
    return { fwd: te.forwardableBrowserObservation, MAX: te.MAX_FORWARDED_SCREENSHOT_CHARS };
  }

  it('maps computer-observation to browser_observation tagged driver:computer with a JPEG mime default', () => {
    const { fwd } = load();
    const data = { action: 'click', ok: true, preview: 'click done', reasoning: 'open the profile menu' };
    expect(fwd('computer-observation', data)).toEqual({
      type: 'browser_observation',
      data: { ...data, driver: 'computer', mime: 'image/jpeg' },
    });
  });

  it('keeps an explicit mime/app and the live flag; drops an oversized screen frame payload only', () => {
    const { fwd, MAX } = load();
    const ok = { action: 'screenshot', ok: true, live: true, mime: 'image/jpeg', app: 'Google Chrome', screenshotBase64: '/9j/' };
    expect(fwd('computer-observation', ok)).toEqual({ type: 'browser_observation', data: { ...ok, driver: 'computer' } });
    const big = { ...ok, screenshotBase64: 'x'.repeat(MAX + 1) };
    const out = fwd('computer-observation', big)!;
    expect(out.data.screenshotBase64).toBeUndefined();
    expect(out.data.app).toBe('Google Chrome');
  });

  it('still rejects unrelated event types and non-object payloads', () => {
    const { fwd } = load();
    expect(fwd('progress', { message: 'Driving your Mac' })).toBeNull();
    expect(fwd('computer-observation', null)).toBeNull();
  });
});

/**
 * Ticket 6f4d42f2 — the agent-facing render path for the not-configured
 * message.
 *
 * The service-level contract (resolution order env → store, no-echo, message
 * text) is pinned by search-provider-config.6f4d42f2.test.ts. THIS suite pins
 * what the MODEL actually sees: when the shared search-config-state leaf says
 * no backend is armed (no env BRIGHTDATA_API_TOKEN, no admin-store key, no
 * gateway token — the state callMcpTool's pre-flight records), the
 * ToolExecutor's search_engine and scrape_as_markdown cases return the
 * operator-actionable SEARCH_NOT_CONFIGURED_MSG ("set a Bright Data key in
 * Admin → Settings") — NOT the generic degraded/unreachable wording the
 * owner's self-hosted chat hit (9 searches, every path failed, no actionable
 * message). When the leaf says armed, the existing degraded wording stands
 * (a transient outage must NOT be misdiagnosed as misconfiguration).
 *
 * The mcp-search module is mocked (callMcpTool → null, the not-configured
 * tier outcome) — exactly the partial-factory mock shape every tool-executor
 * suite uses; search-config-state is a PURE import-free leaf, so the real one
 * runs.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  generatedFile: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), aggregate: jest.fn() },
  projectDocument: { findFirst: jest.fn(), findMany: jest.fn() },
  projectChunk: { findMany: jest.fn() },
  chatFile: { findMany: jest.fn() },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(async () => null),
}));

jest.mock('./mcp-search', () => ({
  __esModule: true,
  callMcpTool: jest.fn(async () => null),
  webToolsDegraded: jest.fn(() => false),
}));
jest.mock('./coding/web-pipe', () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock('./coding/youtube-pipe', () => ({ __esModule: true, runYoutubePipe: jest.fn() }));
jest.mock('./browser-agent/glm-client', () => ({
  __esModule: true,
  glmChat: jest.fn(),
  stripThink: (s: string | null | undefined) => {
    const text = s || '';
    const m = text.match(/^\s*<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/);
    if (m) return m[2].trim();
    if (/^\s*<think>/.test(text)) return '';
    return text;
  },
}));
jest.mock('./browser-agent/router', () => ({
  __esModule: true,
  selectBrowserDriver: jest.fn(),
  selectLocalFallbackDriver: jest.fn(),
}));

import { ToolCache } from './tool-executor';
import { recordSearchConfigState, __resetSearchConfigStateForTest, SEARCH_NOT_CONFIGURED_MSG } from './platform/search-config-state';

/** Minimal ToolCache drive: execute one tool call and return the rendered text. */
async function runTool(toolName: string, args: Record<string, any>): Promise<string> {
  const cache = new ToolCache({} as any);
  return (cache as any).executeToolCall(toolName, args) as Promise<string>;
}

describe('tool-executor search tools — not-configured render (ticket 6f4d42f2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetSearchConfigStateForTest();
  });

  it('search_engine returns SEARCH_NOT_CONFIGURED_MSG when no backend is armed', async () => {
    recordSearchConfigState({ at: Date.now(), anyBackendArmed: false });
    const out = await runTool('search_engine', { query: 'top AI news today' });
    expect(out).toBe(SEARCH_NOT_CONFIGURED_MSG);
    expect(out).toMatch(/Admin → Settings/i);
  });

  it('search_engine keeps the EXISTING wording when a backend IS armed (transient outage ≠ misconfiguration)', async () => {
    recordSearchConfigState({ at: Date.now(), anyBackendArmed: true });
    const out = await runTool('search_engine', { query: 'top AI news today' });
    expect(out).not.toBe(SEARCH_NOT_CONFIGURED_MSG);
    // The legacy null-result wording (webToolsDegraded mocked false):
    expect(out).toMatch(/No search results found/i);
  });

  it('scrape_as_markdown returns SEARCH_NOT_CONFIGURED_MSG when no backend is armed', async () => {
    recordSearchConfigState({ at: Date.now(), anyBackendArmed: false });
    const out = await runTool('scrape_as_markdown', { url: 'https://example.com/article' });
    expect(out).toBe(SEARCH_NOT_CONFIGURED_MSG);
  });

  it('scrape_as_markdown keeps an honest not-found wording when a backend is armed (BS-1 D4)', async () => {
    recordSearchConfigState({ at: Date.now(), anyBackendArmed: true });
    const out = await runTool('scrape_as_markdown', { url: 'https://example.com/article' });
    expect(out).not.toBe(SEARCH_NOT_CONFIGURED_MSG);
    // BS-1 D4 (2026-11-02): this used to assert the "may be unavailable, blocked,
    // or rate-limited" copy — i.e. "the SITE is down". That wording is the defect:
    // an empty scrape is far more often a wrong/guessed PATH than a dead site
    // (WRP-1 D5-R), and telling the model "the source is down" sends it to
    // apologize or give up instead of re-checking the path. The transient-outage
    // intent of this test is preserved below — what changed is that the copy now
    // says NOT FOUND for the path, and may never say "rate-limited".
    expect(out).toMatch(/Nothing was found|NOT the same as the site being down/i);
    expect(out).not.toMatch(/rate-limited|unavailable, blocked/i);
  });

  it('BEFORE any callMcpTool (no recorded state), the legacy wording stands — never a false misconfiguration claim', async () => {
    // Fresh process: the pre-flight never ran (e.g. a tool path that bypasses
    // callMcpTool) — the leaf is null and the consumer must NOT claim
    // misconfiguration from absent evidence.
    const out = await runTool('search_engine', { query: 'top AI news today' });
    expect(out).not.toBe(SEARCH_NOT_CONFIGURED_MSG);
  });
});

describe('scrape_batch pre-flight (ticket 169d5080 residual)', () => {
  // BS-1 D5 (2026-11-02) wired preflightUrl into scrape_as_markdown but NOT into
  // its sibling, so ONE cut-off URL in a batch still reached the gateway verbatim
  // and came back as a raw `400 ... "url" must be a valid uri`.
  //
  // The batch path CANNOT simply reuse the strict verdict: rule 2 ("last query
  // param has no `=`") is lexically unable to tell a truncation (`?acti` cut out
  // of `active_status`) from a COMPLETE bare-flag URL (`?amp`, `?print`,
  // `?autoplay`). Refusing on rule 2 alone silently drops a page the model asked
  // for and tells it, falsely, that its link was cut off; sharing the array with
  // an ambiguous member lets one bad URL 400 the whole call. So the ambiguous
  // members are dispatched ONE AT A TIME. These cases pin that three-way split.
  beforeEach(() => {
    jest.clearAllMocks();
    __resetSearchConfigStateForTest();
    recordSearchConfigState({ at: Date.now(), anyBackendArmed: true });
  });

  const TRUNCATED = 'https://www.facebook.com/ads/library/?acti';

  it('a fully valid batch rides ONE call, unchanged, with no refusal note', async () => {
    const { callMcpTool } = require('./mcp-search');
    const urls = ['https://a.test/1', 'https://b.test/2'];
    const out = await runTool('scrape_batch', { urls });
    expect(callMcpTool).toHaveBeenCalledTimes(1);
    expect(callMcpTool.mock.calls[0][1].urls).toEqual(urls);
    expect(out).not.toMatch(/not fetched|could not fetch/i);
  });

  it('an AMBIGUOUS url (rule 2) is dispatched ALONE — it neither poisons the batch nor is silently dropped', async () => {
    const { callMcpTool } = require('./mcp-search');
    await runTool('scrape_batch', { urls: [TRUNCATED, 'https://a.test/1', 'https://b.test/2'] });
    // The unambiguous pair rides one call; the ambiguous one gets its own.
    expect(callMcpTool).toHaveBeenCalledTimes(2);
    expect(callMcpTool.mock.calls[0][1].urls).toEqual(['https://a.test/1', 'https://b.test/2']);
    expect(callMcpTool.mock.calls[1][1].urls).toEqual([TRUNCATED]);
  });

  it('an ambiguous url that comes back empty is reported alone, never as the whole batch failing', async () => {
    const { callMcpTool } = require('./mcp-search');
    const out = await runTool('scrape_batch', { urls: [TRUNCATED, 'https://a.test/1'] });
    expect(callMcpTool).toHaveBeenCalledTimes(2);
    // The member-scoped explanation, not a raw gateway 400 and not "the site is down".
    expect(out).toMatch(/could not fetch/i);
    expect(out).toMatch(/cut off|re-send/i);
    expect(out).not.toMatch(/must be a valid uri/i);
  });

  it('an ambiguous member does NOT stop the other pages being fetched', async () => {
    const { callMcpTool } = require('./mcp-search');
    callMcpTool.mockImplementation(async (_tool: string, args: any) =>
      args.urls[0] === TRUNCATED ? null : `CONTENT for ${args.urls.join(',')}`);
    const out = await runTool('scrape_batch', { urls: [TRUNCATED, 'https://a.test/1'] });
    expect(out).toContain('CONTENT for https://a.test/1');
  });

  it('shapes that can never be a real URL are refused OUTRIGHT — never dispatched', async () => {
    const { callMcpTool } = require('./mcp-search');
    const BAD = [
      'https://example.com/page?',      // rule 1 — dangling ?
      'https://example.com/page?q=a&',  // rule 1 — dangling &
      'https://example.com/a%2',        // rule 3 — half a percent-escape
      'polksheriff.org/news',           // rule 4 — no scheme
      'https://example.com/a b',        // pasted mid-sentence
    ];
    const out = await runTool('scrape_batch', { urls: [...BAD, 'https://a.test/1'] });
    // Only the valid one is dispatched; each bad one is named.
    expect(callMcpTool).toHaveBeenCalledTimes(1);
    expect(callMcpTool.mock.calls[0][1].urls).toEqual(['https://a.test/1']);
    for (const b of BAD) expect(out).toContain(b);
    expect(out).toMatch(/not fetched/i);
  });

  it('padded urls are trimmed before dispatch (a padded member re-creates the 400)', async () => {
    const { callMcpTool } = require('./mcp-search');
    await runTool('scrape_batch', { urls: ['  https://a.test/1  ', 'https://b.test/2\n'] });
    expect(callMcpTool.mock.calls[0][1].urls).toEqual(['https://a.test/1', 'https://b.test/2']);
  });
});

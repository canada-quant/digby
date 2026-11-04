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

  it('scrape_as_markdown keeps the existing failed-fetch wording when a backend is armed', async () => {
    recordSearchConfigState({ at: Date.now(), anyBackendArmed: true });
    const out = await runTool('scrape_as_markdown', { url: 'https://example.com/article' });
    expect(out).not.toBe(SEARCH_NOT_CONFIGURED_MSG);
    expect(out).toMatch(/Failed to fetch|unavailable|blocked|rate-limited/i);
  });

  it('BEFORE any callMcpTool (no recorded state), the legacy wording stands — never a false misconfiguration claim', async () => {
    // Fresh process: the pre-flight never ran (e.g. a tool path that bypasses
    // callMcpTool) — the leaf is null and the consumer must NOT claim
    // misconfiguration from absent evidence.
    const out = await runTool('search_engine', { query: 'top AI news today' });
    expect(out).not.toBe(SEARCH_NOT_CONFIGURED_MSG);
  });
});

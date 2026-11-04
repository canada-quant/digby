/**
 * Consumer-surface SERP provider-error pins — ticket ca805a61 (2026-10-07).
 *
 * The tier guard (mcp-search.serp-provider.ca805a61.test.ts) pins the
 * classification + null at the gateway tier and the callMcpTool chokepoint.
 * THIS suite pins what the ticket's named CONSUMERS now surface:
 *
 *   1. the agent-facing search_engine TOOL (tool-executor): a classified
 *      provider-error body must come back as an EXPLICIT "Web search failed …
 *      x-brd-error-code=…" message — never the vendor's error text as a
 *      "result list", and never a bare "No search results found." that reads
 *      as "nothing exists" while the provider is down;
 *   2. youtube_pipe's zero-target summary: a dead search backend names the
 *      SERP-error cause (not "no videos exist"), both via the tier callback
 *      and the local defense-in-depth classifier;
 *   3. web_pipe's 9b944f30 explicit failure is PRESERVED (not regressed to
 *      the generic zero-source note) when the tier — not the pipe —
 *      classifies the body.
 */

// Repo idiom (tool-executor.88915954.test.ts): mock the logger and the
// config/database chain BEFORE requiring tool-executor — logger imports
// config/env, which zod-validates process.env and exits at module load; the
// surfaces under test never need real env. Same for the heavyweight deps.
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(async () => null) }));

jest.mock('./mcp-search', () => ({
  callMcpTool: jest.fn(),
  webToolsDegraded: jest.fn(() => false),
}));

import { callMcpTool } from './mcp-search';
import { ToolCache } from './tool-executor';
import { runYoutubePipe } from './coding/youtube-pipe';
import { runWebPipe } from './coding/web-pipe';
import { storeFindings } from './coding/coding-retrieval.service';
import axios from 'axios';

jest.mock('./coding/coding-retrieval.service', () => ({ storeFindings: jest.fn().mockResolvedValue(7) }));
jest.mock('./model-endpoints/model-roles.service', () => ({ __esModule: true, resolveRoleModel: jest.fn(async () => '') }));
jest.mock('./speech', () => ({ transcribeAudio: jest.fn(), textToSpeech: jest.fn(), sttConfigured: jest.fn() }));
jest.mock('axios');

const mockMcp = callMcpTool as jest.Mock;
const mockStore = storeFindings as jest.Mock;

/** The provider's 429 auto-throttle body (9b944f30 fixture, verbatim class). */
const SERP_429_BODY = [
  'HTTP/1.1 429 The request was auto-throttled due to low success rate',
  'x-brd-error-code: sr_rate_limit',
  'x-brd-error: The request was auto-throttled due to low success rate. Please decrease your request rate to 60/min.',
  `See https://docs.brightdata.com/scraping-automation/serp-api/debugging for the error catalog.`,
  'req_id=hl_d09913c7_a1lw123bkcg',
].join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  mockMcp.mockReset();
  mockStore.mockReset().mockResolvedValue(7);
  (axios.post as jest.Mock).mockResolvedValue({ data: { choices: [{ message: { content: 'DIGEST: healthy' } }] } });
});

// ── 1. the agent-facing search_engine TOOL surface ───────────────────────────

describe('tool-executor search_engine — provider-error body surfaces as an explicit failure (ca805a61)', () => {
  test('classified body (tier nulls it) → explicit "Web search failed … x-brd-error-code=sr_rate_limit", never the vendor text as results', async () => {
    // The tier's behavior (gatewayTier + chokepoint) is pinned in the tier
    // suite; here callMcpTool is mocked to the tier's CONTRACT: null result +
    // the classified detail delivered via onSerpProviderError.
    mockMcp.mockImplementation(async (_tool: string, _args: any, _to?: number, opts?: any) => {
      opts?.onSerpProviderError?.({
        code: 'sr_rate_limit', status: 429, reqId: 'hl_d09913c7_a1lw123bkcg',
        minWaitMs: 15000, retryable: true, snippet: '…',
      });
      return null;
    });
    const te = new ToolCache('user-1', 'chat-1');
    const out = await te.getOrExecute('search_engine', { query: 'stock price' });
    expect(out).toContain('Web search failed');
    expect(out).toContain('x-brd-error-code=sr_rate_limit');
    expect(out).toContain('HTTP 429');
    expect(out).toContain('NOT an indication that no results exist');
    // the pre-fix bug shape: the vendor's error text returned AS the results
    expect(out).not.toContain('docs.brightdata.com');
    expect(out).not.toMatch(/^No search results found/);
  });

  test('deterministic class (unexpected_q) names the rephrase guidance', async () => {
    mockMcp.mockImplementation(async (_t: string, _a: any, _to?: number, opts?: any) => {
      opts?.onSerpProviderError?.({ code: 'unexpected_q', status: 502, retryable: false, snippet: '…' });
      return null;
    });
    const te = new ToolCache('user-1', 'chat-1');
    const out = await te.getOrExecute('search_engine', { query: 'q' });
    expect(out).toContain('x-brd-error-code=unexpected_q');
    expect(out).toContain('rephrase');
  });

  test('a plain null (no classified detail) keeps the legacy degraded/empty messages when a search backend exists', async () => {
    const prev = process.env.BRIGHTDATA_API_TOKEN;
    process.env.BRIGHTDATA_API_TOKEN = 'test-token';
    try {
      mockMcp.mockResolvedValue(null);
      const te = new ToolCache('user-1', 'chat-1');
      const out = await te.getOrExecute('search_engine', { query: 'q' });
      expect(out).toMatch(/No search results found|Web search is temporarily unavailable/);
      expect(out).not.toMatch(/NOT configured/);
    } finally {
      if (prev !== undefined) process.env.BRIGHTDATA_API_TOKEN = prev; else delete process.env.BRIGHTDATA_API_TOKEN;
    }
  });

  test('self-host 2026-10-20: with NO search backend a null answer is the honest "not configured on this instance" line, never a bare "no results"', async () => {
    mockMcp.mockResolvedValue(null); // this suite's env carries no BRIGHTDATA_API_TOKEN / MCP_DIGBY_TOKEN
    const te = new ToolCache('user-1', 'chat-1');
    const out = await te.getOrExecute('search_engine', { query: 'q' });
    expect(out).toMatch(/^Web search is NOT configured on this Digby instance/);
    expect(out).not.toMatch(/^No search results found/);
  });

  test('a healthy SERP still returns the body verbatim', async () => {
    const healthy = JSON.stringify({ organic: [{ link: 'https://a.example/one', title: 'A' }] });
    mockMcp.mockResolvedValue(healthy);
    const te = new ToolCache('user-1', 'chat-1');
    expect(await te.getOrExecute('search_engine', { query: 'q' })).toBe(healthy);
  });
});

// ── 2. youtube_pipe's zero-target cause naming ────────────────────────────────

describe('youtube_pipe zero-target — a dead backend is named, never "no videos exist" (ca805a61)', () => {
  test('tier-classified null names the SERP error + code in the summary', async () => {
    mockMcp.mockImplementation(async (_t: string, _a: any, _to?: number, opts?: any) => {
      opts?.onSerpProviderError?.({ code: 'sr_rate_limit', status: 429, retryable: true, snippet: '…' });
      return null;
    });
    const r = await runYoutubePipe('sess-ca805a61-1', { query: 'kubernetes deep dive talk' }, undefined);
    expect(r.ok).toBe(false);
    expect(r.storedChunks).toBe(0);
    expect(r.summary).toContain('search backend failed (SERP error');
    expect(r.summary).toContain('x-brd-error-code=sr_rate_limit');
  });

  test('local defense in depth: an UN-nulled error body reaching the pipe names the cause and ingests nothing', async () => {
    // kill switch OFF, but the tier missed it (differently-shaped future body,
    // a mock, or SERP_PROVIDER_GUARD_DISABLED=1 on the tier path) — the pipe's
    // local classifier still refuses to parse the body as links.
    mockMcp.mockResolvedValue(SERP_429_BODY);
    const r = await runYoutubePipe('sess-ca805a61-2', { query: 'kubernetes deep dive talk' }, undefined);
    expect(r.ok).toBe(false);
    expect(r.videos).toEqual([]);
    expect(r.storedChunks).toBe(0);
    expect(r.summary).toContain('search backend answered with an error/debug body');
    expect(r.summary).toContain('sr_rate_limit');
  });

  test('a healthy SERP with no YouTube hits keeps the honest plain note', async () => {
    mockMcp.mockResolvedValue(JSON.stringify({ organic: [{ link: 'https://example.com/a', title: 'A' }] }));
    const r = await runYoutubePipe('sess-ca805a61-3', { query: 'quiet topic' }, undefined);
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('youtube_pipe found no videos (no YouTube urls given and search returned none).');
  });

  test('self-host 2026-10-20: a search that never ran (null, no provider error) on an instance with NO search backend names the configuration gap', async () => {
    mockMcp.mockResolvedValue(null); // this suite's env carries no search token
    const r = await runYoutubePipe('sess-ca805a61-4', { query: 'quiet topic' }, undefined);
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/web search is NOT configured on this Digby instance/);
  });
});

// ── 3. web_pipe's landed 9b944f30 explicit failure is PRESERVED ──────────────

describe('web_pipe — the 9b944f30 explicit SERP failure survives the tier guard (ca805a61)', () => {
  test('tier-classified null + callback → the 9b944f30 "search backend failed (SERP error)" summary, code named, nothing ingested', async () => {
    mockMcp.mockImplementation(async (_t: string, _a: any, _to?: number, opts?: any) => {
      opts?.onSerpProviderError?.({ code: 'sr_rate_limit', status: 429, minWaitMs: 15000, retryable: true, snippet: '…' });
      return null;
    });
    const r = await runWebPipe('sess-ca805a61-4', { query: 'inflatable dome in stock' }, undefined, { sameHostGapMs: 0, serpRetryMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.sources).toEqual([]);
    expect(r.storedChunks).toBe(0);
    expect(mockStore).not.toHaveBeenCalled();
    expect(r.summary).toContain('web_pipe search backend failed (SERP error)');
    expect(r.summary).toContain('x-brd-error-code=sr_rate_limit');
  });

  
});

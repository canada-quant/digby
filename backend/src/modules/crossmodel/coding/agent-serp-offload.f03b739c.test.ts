/**
 * Ticket f03b739c (2026-10-13) — INTEGRATION REPLAY: the incident happened
 * in a CROSS-CHECKER lane (chat profile) whose search_engine call returned a
 * raw/malformed Bright Data SERP body; the agent loop's offload paths
 * embedded it into session memory verbatim (worthEmbedding passes anything
 * ≥200 chars), so base64 webp icons, sxsrf/fbs URL tokens and pagination
 * arrays now surface in every search_memory retrieval.
 *
 * This suite drives the REAL agent loop (same harness as
 * agent-offload-honesty.test.ts; search_engine replays through the real
 * ToolCache → processToolCalls → callMcpTool routing with only the MCP
 * transport mocked — the body the tier returned IS the incident's) plus the
 * REAL compaction module, and pins:
 *  - a big raw-SERP search_engine result is stored DISTILLED (no base64,
 *    no pagination/navigation arrays) while the search signal survives;
 *  - a FAILED-search surface (the ca805a61 provider-error text) stores the
 *    compact error record instead of the raw body;
 *  - an ordinary big tool result still offloads byte-identical;
 *  - a compacted-away SERP tool result embeds distilled content too;
 *  - the kill switch restores the pre-fix embedding.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn(), publish: jest.fn() },
}));

// MCP integration modules (the coding-integrations import chain).
jest.mock('../github/github-mcp', () => ({
  searchCode: jest.fn(), listIssues: jest.fn(), getIssue: jest.fn(), listPullRequests: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  resolveGoogleAccount: jest.fn(), getGmailMessages: jest.fn(), getGmailMessage: jest.fn(),
  getGmailAttachment: jest.fn(), getCalendarEvents: jest.fn(), listDriveFiles: jest.fn(),
  getDocContent: jest.fn(), getSheetData: jest.fn(),
}));
jest.mock('../slack/slack-mcp', () => ({
  searchMessages: jest.fn(), listChannels: jest.fn(), getChannelHistory: jest.fn(),
}));
jest.mock('../asana/asana-mcp', () => ({
  searchTasks: jest.fn(), listMyTasks: jest.fn(), listProjects: jest.fn(),
}));
jest.mock('../x/x-mcp', () => ({
  search: jest.fn(), getUserProfile: jest.fn(), getTrends: jest.fn(),
}));
jest.mock('../xero/xero-mcp', () => ({
  getOrganisation: jest.fn(), getContacts: jest.fn(), getInvoices: jest.fn(),
}));
jest.mock('../plaid/plaid-mcp', () => ({
  getAccounts: jest.fn(), getBalances: jest.fn(), getTransactions: jest.fn(),
}));
jest.mock('../imessage/imessage.service', () => ({
  getPrimaryAgent: jest.fn(), isOnline: jest.fn(),
}));
jest.mock('../imessage/agent-link', () => ({
  agentBroker: { dispatch: jest.fn() },
}));

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'small result');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The search tier's MCP transport: the incident's body arrives through the
// REAL routing (ToolCache → processToolCalls → callMcpTool), so only the
// network leg is mocked. Partial factory shape = web-pipe.test.ts precedent.
const mockCallMcpTool: jest.Mock = jest.fn(async () => null);
jest.mock('../mcp-search', () => ({
  __esModule: true,
  callMcpTool: (...a: any[]) => mockCallMcpTool(...a),
  webToolsDegraded: () => false,
  extractPdfTextFromUrl: jest.fn(async () => null),
  searchWithBrightData: jest.fn(async () => ''),
  scrapeUrlWithBrightData: jest.fn(async () => ''),
}));

jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', CONTEXT_COMPACTION: 'context_compaction' },
}));

const _store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { _store.set(ns.join('/') + '::' + key, value); }),
}));

jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
  JOURNAL_ENTRIES_N: 6,
  MACHINE_JOURNAL_ENTRIES_N: 10,
  MACHINE_JOURNAL_BLOCK_CAP: 4000,
}));

jest.mock('./container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({
  __esModule: true,
  gatherSessionCredentialEnv: jest.fn(async () => ({})),
  credentialEnvNote: jest.fn(() => ''),
}));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn() }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ""),
}));

// The seam under test: what the agent loop offers to session memory.
const mockStoreFindings: jest.Mock = jest.fn(async () => 1);
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  storeFindings: (...a: any[]) => mockStoreFindings(...a),
  buildSessionMemoryInventory: jest.fn(async () => ''),
}));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

// ── the compaction leg ──
jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: jest.fn(async () => 'RECAP: ran a web search; results embedded; moving on.'),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { compactMessages } from './compaction';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 6,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/f03b739c-test',
  sessionId: 'sess-f03b739c',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'search the web and cross-check the answer',
  emit: jest.fn(),
});

// search_engine IS in OFFLOAD_TOOLS — a >6k result hits the orchestrator
// large-read path; that is the incident's store.
const SEARCH_TURN = {
  content: 'Searching.',
  reasoning: '',
  toolCalls: [{ id: 't1', name: 'search_engine', arguments: '{"query":"brightdata serp api pricing"}' }],
  finishReason: 'tool_calls',
};
const FEEDBACK_TURN = {
  content: 'Pulling the queue.',
  reasoning: '',
  toolCalls: [{ id: 't1', name: 'list_feedback', arguments: '{"status":"open"}' }],
  finishReason: 'tool_calls',
};
const FINAL_TURN = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const serpBody = (pad: number) => JSON.stringify({
  query: 'brightdata serp api pricing',
  results_cnt: 2220,
  pagination: { current: 1, total: 223, other_pages: { 2: '/search?q=x&start=10' } },
  navigation: [{ display_text: 'All', link: 'https://www.google.com/search?q=x' }],
  organic: [
    {
      position: 1,
      title: 'Bright Data SERP API — Pricing',
      link: 'https://brightdata.com/products/serp-api',
      snippet: 'Collect SERP data at scale with the SERP API.',
      favicon: `data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAf/QQ1J${'A'.repeat(pad)}`,
    },
    {
      position: 2,
      title: 'Web Scraper API docs',
      link: 'https://docs.brightdata.com/scraping-automation/serp-api',
      snippet: 'SERP API returns structured JSON.',
      thumbnail: 'https://encrypted-tbn1.gstatic.com/images?q=tbn:ANd9GcTx',
    },
  ],
});

const storedContents = () => mockStoreFindings.mock.calls.flatMap((c: any[]) => (c[2] || []).map((i: any) => String(i.content || '')));
const toolResultEvents = (input: AgentRunInput) =>
  (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'tool_result').map((c) => c[1]);

beforeEach(() => {
  jest.clearAllMocks();
  mockStoreFindings.mockReset().mockResolvedValue(1);
  mockCallMcpTool.mockReset().mockResolvedValue(null);
  mockExecuteCodingTool.mockReset().mockResolvedValue('small result');
  _store.clear();
});

afterEach(() => { delete process.env.SERP_MEMORY_SANITIZE_DISABLED; });

describe('agent-loop offload gates (ticket f03b739c)', () => {
  it('a big raw-SERP search_engine result is stored DISTILLED — scaffolding never reaches memory', async () => {
    const raw = `[Web Search Results]\nQuery: brightdata serp api pricing\n\n${serpBody(9_000)}`;
    expect(raw.length).toBeGreaterThan(6_000); // LARGE_READ_CHARS
    mockCallMcpTool.mockResolvedValue(raw);
    mockRunModelTurn.mockResolvedValueOnce(SEARCH_TURN).mockResolvedValueOnce(FINAL_TURN);
    const input = makeInput();
    await runCodingAgent(input);

    const stored = storedContents();
    expect(stored.length).toBeGreaterThan(0);
    const all = stored.join('\n');
    // the useful signal survived
    expect(all).toContain('Bright Data SERP API — Pricing');
    expect(all).toContain('https://docs.brightdata.com/scraping-automation/serp-api');
    // the incident's garbage classes are gone
    expect(all).not.toContain('base64');
    expect(all).not.toContain('UklGR');
    expect(all).not.toContain('pagination');
    expect(all).not.toContain('navigation');
    expect(all).not.toContain('encrypted-tbn');
    expect(all).not.toContain('results_cnt');
    // and the store shrank, not grew
    const biggest = Math.max(...stored.map(s => s.length));
    expect(biggest).toBeLessThan(raw.length);
  });

  it('the MODEL still sees the full raw result (sanitization is embed-only — no behavior change in context)', async () => {
    const raw = `[Web Search Results]\nQuery: brightdata serp api pricing\n\n${serpBody(9_000)}`;
    mockCallMcpTool.mockResolvedValue(raw);
    mockRunModelTurn.mockResolvedValueOnce(SEARCH_TURN).mockResolvedValueOnce(FINAL_TURN);
    const input = makeInput();
    await runCodingAgent(input);
    const [ev] = toolResultEvents(input);
    // the model-facing text keeps the ORIGINAL result head, not the distillate
    expect(ev.result.slice(0, 40)).toBe(raw.slice(0, 40));
  });

  it('a FAILED search surface (provider error, ca805a61 text) stores the compact error record — never the raw body', async () => {
    // The incident's hard-error class: the gateway answered with a LARGE
    // "Unexpected non-JSON response from Bright Data for search_engine"
    // envelope carrying the truncated SERP body — no vendor error anchors, so
    // the provider-error classifier let it through as a "result" and the old
    // code embedded it verbatim. Replay: the tier reports the classified
    // error AND the surface stays long enough to hit the offload path.
    const failed = 'Unexpected non-JSON response from Bright Data for search_engine — the gateway returned the truncated provider body instead of JSON:' +
      `{"query":"brightdata serp api pricing","results_cnt":2220,"organic":[{"title":"t","favicon":"data:image/webp;base64,${'A'.repeat(6_000)}]}{"organic": [TRUNC`;
    expect(failed.length).toBeGreaterThan(6_000); // LARGE_READ_CHARS — the offload fires
    mockCallMcpTool.mockResolvedValue(failed);
    mockRunModelTurn.mockResolvedValueOnce(SEARCH_TURN).mockResolvedValueOnce(FINAL_TURN);
    const input = makeInput();
    await runCodingAgent(input);

    const stored = storedContents();
    expect(stored.length).toBeGreaterThan(0);
    const all = stored.join('\n');
    expect(all).toContain('search failed');
    expect(all).toContain('ticket f03b739c');
    // the body is NOT embedded — only the compact record with its bounded
    // (≤200-char) diagnostic head; the base64 blob and the bulk never land
    expect(all).not.toContain('base64');
    expect(all).not.toMatch(/A{100}/);
    expect(all.length).toBeLessThan(1_000);
  });

  it('ordinary big tool output still offloads byte-identical (no over-matching)', async () => {
    const big = `HEAD ${'x'.repeat(12_000)} TAIL`;
    mockExecuteCodingTool.mockResolvedValueOnce(big);
    // a NON-offload tool exercises the >8k catch-all path
    mockRunModelTurn.mockResolvedValueOnce(FEEDBACK_TURN).mockResolvedValueOnce(FINAL_TURN);
    await runCodingAgent(makeInput());
    const stored = storedContents();
    expect(stored.join('\n')).toContain(big);
  });

  it('kill switch SERP_MEMORY_SANITIZE_DISABLED=1 restores raw embedding (pre-fix behavior)', async () => {
    process.env.SERP_MEMORY_SANITIZE_DISABLED = '1';
    const raw = `[Web Search Results]\nQuery: brightdata serp api pricing\n\n${serpBody(9_000)}`;
    mockCallMcpTool.mockResolvedValue(raw);
    mockRunModelTurn.mockResolvedValueOnce(SEARCH_TURN).mockResolvedValueOnce(FINAL_TURN);
    await runCodingAgent(makeInput());
    const all = storedContents().join('\n');
    expect(all).toContain('data:image/webp;base64');
  });
});

describe('compaction embed gate (ticket f03b739c)', () => {
  beforeAll(() => { process.env.COMPACTION_OFFLOAD_STOP_DISABLED = '1'; });
  afterAll(() => { delete process.env.COMPACTION_OFFLOAD_STOP_DISABLED; });

  it('a compacted-away raw SERP tool result embeds DISTILLED content', async () => {
    const raw = `[Web Search Results]\nQuery: q\n\n${serpBody(9_000)}`;
    const msgs: any[] = [
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'search the web' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'search_engine' } }] },
      { role: 'tool', tool_call_id: 't', content: raw },
      { role: 'assistant', content: 'analyzed the results' },
      { role: 'user', content: 'go deeper' },
    ];
    // pad with filler so compaction actually triggers
    for (let i = 0; i < 60; i++) {
      msgs.push({ role: 'assistant', content: `filler turn ${i} with some ordinary content that is long enough to matter for the window budget.` });
      msgs.push({ role: 'user', content: `ack ${i}` });
    }
    const out = await compactMessages(msgs, 'sess-f03b739c', { mode: 'full' });
    expect(out).not.toBeNull();
    const all = mockStoreFindings.mock.calls.flatMap((c: any[]) => (c[2] || []).map((i: any) => String(i.content || ''))).join('\n');
    expect(all).toContain('[tool result] Query: brightdata serp api pricing'); // distilled form present
    expect(all).not.toContain('data:image/webp;base64');        // scaffolding never embeds
    expect(all).not.toContain('UklGR');
    expect(all).not.toContain('pagination');
  });

  it('a compacted-away FAILED search surface embeds the compact error record, not the body', async () => {
    const failed = 'Unexpected non-JSON response from Bright Data for search_engine (truncated body, claimed results_cnt 2220, locale en-CO) — treating as failure.' + 'x'.repeat(3_000);
    const msgs: any[] = [
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'search the web' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'search_engine' } }] },
      { role: 'tool', tool_call_id: 't', content: failed },
      { role: 'assistant', content: 'noted the failure' },
      { role: 'user', content: 'retry differently' },
    ];
    for (let i = 0; i < 60; i++) {
      msgs.push({ role: 'assistant', content: `filler turn ${i} with some ordinary content that is long enough to matter for the window budget.` });
      msgs.push({ role: 'user', content: `ack ${i}` });
    }
    const out = await compactMessages(msgs, 'sess-f03b739c', { mode: 'full' });
    expect(out).not.toBeNull();
    const all = mockStoreFindings.mock.calls.flatMap((c: any[]) => (c[2] || []).map((i: any) => String(i.content || ''))).join('\n');
    expect(all).toContain('compact error record');               // the compact record embeds
    expect(all).toContain('ticket f03b739c');
    expect(all).not.toMatch(/x{100}/);                           // the padded body never embeds
  });
});

/**
 * build 2026-10-08 C — the REAL agent loop:
 *
 *  C-2 REPLAY of run 99b4f357 (2026-10-07, cql-litellm:api-optimize-zai-glm-5.3,
 *      schedule-triggered, failed at step 204): a tool call whose arguments were
 *      not valid JSON stayed in history and the gateway 400'd every later request
 *      ("Invalid tool call in messages: tool_calls[].function.arguments for
 *      function 'computer_task' must be a JSON object string (or an object), got
 *      invalid J…"). Pre-fix: backoff resent the same payload, a mode:'full'
 *      compaction kept the bad call in the verbatim window, two shrinks, gave up.
 *      Now: the history is repaired deterministically and the step retried —
 *      no compaction, no backoff, no shrink.
 *  C-1 the chat fast path: a chat turn whose tool results cross the compaction
 *      trigger is cleared deterministically (no ~9 s LLM summary) for the owner
 *      canary; every other user gets a shadow row and the summariser as before.
 *  C   the gauge: the `context` event carries the turn's prompt / cached tokens
 *      and the run ends with ONE run_summary row.
 *
 * Harness: agent-context-budget.t1.test.ts (repo-standard stand-ins).
 */

const mockUtilityChat: jest.Mock = jest.fn(async () => 'RECAP: searched four sources.');
jest.mock('../../../utils/utility-llm', () => ({
  ...jest.requireActual('../../../utils/utility-llm'),
  utilityChat: (...a: any[]) => mockUtilityChat(...a),
}));
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

// The model turn: ONE mock drives every case (per-test call shapes).
const mockRunModelTurn: jest.Mock = jest.fn();
const mockSent: any[][] = [];
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  // mockSent: a deep copy of the messages AS SENT (the loop mutates the same array afterwards).
  return { ...actual, runModelTurn: (...a: any[]) => { mockSent.push(JSON.parse(JSON.stringify(a[1] ?? []))); return mockRunModelTurn(...a); } };
});

// Coding-tool execution: the big-output producer.
const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'small result');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  noteSeatFallback: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss', CONTEXT_BUDGET: 'context_budget' },
}));
// The gateway seat the audit measured: a registry model with NO contextWindow.
const mockResolveRegistryModel: jest.Mock = jest.fn(async (spec: string) => (spec === 'cql-litellm:api-optimize-zai-glm-5.3'
  ? { url: 'https://llm.cql.ca/v1/chat/completions', apiKey: 'sk-gw', model: 'api-optimize-zai-glm-5.3', label: 'cql-litellm', supportsVision: false, coding: true, chatCapable: true }
  : null));
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
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
// The seam under test (v1#19): whether a store ACTUALLY happened drives the marker.
const mockStoreFindings: jest.Mock = jest.fn(async () => 1);
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  storeFindings: (...a: any[]) => mockStoreFindings(...a),
  buildSessionMemoryInventory: jest.fn(async () => ''),
}));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

import { runCodingAgent } from './agent';
import { __resetContextCharCeilingsForTests } from './coding-model';
import { __resetSeatInvalidRequestLatchesForTests } from './seat-invalid-request';
import { OWNER_CANARY_USER_ID } from './context-gauge';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

const CODING: AgentProfile = {
  kind: 'coding', maxSteps: 8, maxDelegations: 0, contextCharBudget: 90_000,
  workspaceTools: false, planReminders: false, memorySource: 'coding',
};
const CHAT: AgentProfile = {
  kind: 'chat', maxSteps: 8, maxDelegations: 0, contextCharBudget: 60_000,
  workspaceTools: false, planReminders: false, memorySource: 'chat',
};
const makeInput = (profile: AgentProfile, userId = 'u1'): AgentRunInput => ({
  worktree: '/tmp/c-context-test', sessionId: 'sess-c-ctx', projectId: 'p1', userId,
  permissionMode: 'auto', model: 'glm-5.3', projectName: 'test', branch: 'main', profile,
  doctrineOverride: 'You are a test agent.', history: [], userMessage: 'Pay the hydro bill.', emit: jest.fn(),
});
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const rows = (kind: string, event?: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === kind && (!event || r?.meta?.event === event));
const contextEvents = (input: AgentRunInput) => (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'context').map((c) => c[1]);
const progress = (input: AgentRunInput) => (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'progress').map((c) => String(c[1]?.message ?? ''));

/** The incident's exact provider body (LiteLLM-wrapped OpenAI-compatible validation). */
const INCIDENT_400 = "litellm.BadRequestError: OpenAIException - Invalid tool call in messages: tool_calls[].function.arguments for function 'computer_task' must be a JSON object string (or an object), got invalid JSON";
const TRUNCATED_ARGS = '{"query": "hydro bill due date, then open the';
const MALFORMED_TURN = { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'bad1', name: 'search_memory', arguments: TRUNCATED_ARGS }] };
const REJECTED = { content: '', reasoning: '', toolCalls: [], finishReason: 'error', errorStatus: 400, errorMessage: 'Request failed with status code 400', providerError: INCIDENT_400 };

const sentToolArgs = (callIdx: number): string[] => (mockSent[callIdx] as any[])
  .filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
  .flatMap((m) => m.tool_calls.map((t: any) => t.function.arguments));

const SWITCHES = ['HISTORY_REPAIR_DISABLED', 'CHAT_CONTEXT_CLEARING', 'CONTEXT_GAUGE_DISABLED'];
beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockStoreFindings.mockResolvedValue(1);
  mockExecuteCodingTool.mockReset();
  mockExecuteCodingTool.mockResolvedValue('small result');
  mockRunModelTurn.mockReset();
  mockSent.length = 0;
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1';
  for (const k of SWITCHES) delete process.env[k];
  __resetContextCharCeilingsForTests();
  __resetSeatInvalidRequestLatchesForTests();
});
afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
  for (const k of SWITCHES) delete process.env[k];
});

describe('C-2 REPLAY run 99b4f357 — a malformed tool call in history is repaired, never compacted', () => {
  it('the 400 is answered by a deterministic repair and ONE retry: no backoff, no compaction, no shrink', async () => {
    mockRunModelTurn.mockResolvedValueOnce(MALFORMED_TURN).mockResolvedValueOnce(REJECTED).mockResolvedValueOnce(FINAL);
    const input = makeInput(CODING);
    const result = await runCodingAgent(input);
    expect(result.modelErrored ?? false).toBe(false);
    expect(result.finalText).toContain('Done.');
    expect(mockRunModelTurn).toHaveBeenCalledTimes(3);
    // the rejected request carried the malformed arguments; the retry carries a valid JSON object in their place
    expect(sentToolArgs(1)).toEqual([TRUNCATED_ARGS]);
    const [fixed] = sentToolArgs(2);
    expect(JSON.parse(fixed)).toMatchObject({ raw_head: TRUNCATED_ARGS });
    expect(mockUtilityChat).not.toHaveBeenCalled(); // pre-fix: a mode:'full' LLM compaction
    expect(rows('provider_rejected')).toEqual([]); // pre-fix: shrink_retry ×2 + gave_up
    const [row] = rows('context_edit', 'history_repair');
    expect(row).toMatchObject({ value: 1, unit: 'calls', meta: expect.objectContaining({ outcome: 'repaired', status: 400, attempt: 1, tools: ['search_memory'] }) });
    expect(progress(input).some((m) => m.includes('repaired 1 call'))).toBe(true);
  });

  it('nothing malformed in history ⇒ a nothing_to_repair row and the old lanes (the same request is re-sent after a backoff)', async () => {
    mockRunModelTurn.mockResolvedValueOnce(REJECTED).mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput(CODING));
    expect(result.modelErrored ?? false).toBe(false);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(rows('context_edit', 'history_repair')[0].meta.outcome).toBe('nothing_to_repair');
  });

  it('HISTORY_REPAIR_DISABLED=1 restores the pre-fix lanes: the malformed arguments are re-sent unchanged', async () => {
    process.env.HISTORY_REPAIR_DISABLED = '1';
    mockRunModelTurn.mockResolvedValueOnce(MALFORMED_TURN).mockResolvedValueOnce(REJECTED).mockResolvedValueOnce(FINAL);
    await runCodingAgent(makeInput(CODING));
    expect(mockRunModelTurn).toHaveBeenCalledTimes(3);
    expect(sentToolArgs(2)).toEqual([TRUNCATED_ARGS]);
    expect(rows('context_edit', 'history_repair')).toEqual([]);
  });
});

describe('C-1 chat fast path in the loop', () => {
  const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  const toolTurn = (i: number) => ({ content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: `w${i}`, name: 'search_memory', arguments: JSON.stringify({ query: `${WORDS[i]} rebate` }) }] });
  const drive = () => {
    mockExecuteCodingTool.mockImplementation(async () => `RESULT ${'y'.repeat(14_000)}`);
    for (let i = 0; i < WORDS.length; i++) mockRunModelTurn.mockResolvedValueOnce(toolTurn(i));
    mockRunModelTurn.mockResolvedValueOnce(FINAL);
  };

  it('owner canary: the compaction trigger is answered by a deterministic clear — no LLM summary call', async () => {
    drive();
    const input = makeInput(CHAT, OWNER_CANARY_USER_ID);
    const result = await runCodingAgent(input);
    expect(result.finalText).toContain('Done.');
    expect(mockUtilityChat).not.toHaveBeenCalled();
    const cleared = rows('context_edit', 'chat_clear');
    expect(cleared.length).toBeGreaterThan(0);
    expect(cleared.every((r) => r.meta.outcome === 'cleared')).toBe(true);
    expect(rows('context_compaction')).toEqual([]);
    expect(progress(input).some((m) => m.startsWith('Cleared older tool results'))).toBe(true);
    // the request after the clear carries stubs for the oldest results, the newest rounds raw
    const lastSent = mockSent.at(-1) as any[];
    const toolMsgs = lastSent.filter((m) => m.role === 'tool');
    expect(String(toolMsgs[0].content).startsWith('[cleared to save context: search_memory')).toBe(true);
    expect(String(toolMsgs.at(-1).content).startsWith('RESULT ')).toBe(true);
  });

  it('any other user: a shadow row, then the summariser exactly as before', async () => {
    drive();
    await runCodingAgent(makeInput(CHAT, 'someone-else'));
    expect(mockUtilityChat).toHaveBeenCalled();
    const r = rows('context_edit', 'chat_clear');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].meta).toMatchObject({ outcome: 'shadow', decision: 'shadow' });
  });

  it('CHAT_CONTEXT_CLEARING=off: no row, the summariser as before', async () => {
    process.env.CHAT_CONTEXT_CLEARING = 'off';
    drive();
    await runCodingAgent(makeInput(CHAT, OWNER_CANARY_USER_ID));
    expect(mockUtilityChat).toHaveBeenCalled();
    expect(rows('context_edit', 'chat_clear')).toEqual([]);
  });
});

describe('C gauge in the loop', () => {
  const USAGE_FINAL = { ...FINAL, usage: { promptTokens: 70_000, completionTokens: 120, cachedTokens: 52_000 } };

  it("the context event carries the turn's prompt / cached tokens; ONE run_summary row at the end", async () => {
    mockRunModelTurn.mockResolvedValueOnce(USAGE_FINAL);
    const input = makeInput(CODING);
    await runCodingAgent(input);
    const withTurn = contextEvents(input).filter((e) => e.turn);
    expect(withTurn[0].turn).toEqual({ promptTokens: 70_000, cachedTokens: 52_000, cacheHit: 0.743 });
    const summary = rows('context_edit', 'run_summary');
    expect(summary).toHaveLength(1);
    expect(summary[0].meta).toMatchObject({ providerTurns: 1, peakPromptTokens: 70_000, sumCachedTokens: 52_000, t1Events: 0, profile: 'coding' });
  });

  it('CONTEXT_GAUGE_DISABLED=1: no turn field, no rows', async () => {
    process.env.CONTEXT_GAUGE_DISABLED = '1';
    mockRunModelTurn.mockResolvedValueOnce(USAGE_FINAL);
    const input = makeInput(CODING);
    await runCodingAgent(input);
    expect(contextEvents(input).some((e) => 'turn' in e)).toBe(false);
    expect(rows('context_edit')).toEqual([]);
  });
});

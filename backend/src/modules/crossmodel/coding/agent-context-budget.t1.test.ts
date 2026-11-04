/**
 * audit 2026-10-06 T1-1 + T1-4 — the REAL agent loop on a chat (supervisor-shaped) profile.
 *
 * T1-1: the Fleet Supervisor + every project supervisor seated on
 * `cql-litellm:api-optimize-zai-glm-5.3` ran at min(1M profile, 160k seat) =
 * 160k chars → ~10 compactions per wake (808 rows / 52 h on the Fleet chat).
 * The seat now sizes by model family (4M), so the 1M PROFILE budget binds;
 * the `context` event names what binds (budgetSource) and the seat's sizing
 * (seatContextSource); ONE `context_budget` row per run names the source. The
 * kill switch restores 160k and the old event shape.
 *
 * T1-4: search_memory results (~8k each) were stored BACK to session memory by
 * the big-result offload — 40,917 self-stored chunks in 14 days. A memory read
 * is never re-offloaded; the display marker says so; the kill switch restores it.
 *
 * Harness: agent-offload-honesty.test.ts (repo-standard stand-ins).
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

// The model turn: ONE mock drives every case (per-test call shapes).
const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
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
  ? { url: 'https://llm.example.com/v1/chat/completions', apiKey: 'sk-gw', model: 'api-optimize-zai-glm-5.3', label: 'cql-litellm', supportsVision: false, coding: true, chatCapable: true }
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
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

const SUPERVISOR_LIKE: AgentProfile = {
  kind: 'chat', maxSteps: 6, maxDelegations: 0, contextCharBudget: 1_000_000,
  workspaceTools: false, planReminders: false, memorySource: 'chat',
};
const makeInput = (model = 'cql-litellm:api-optimize-zai-glm-5.3'): AgentRunInput => ({
  worktree: '/tmp/t1-context-budget-test', sessionId: 'sess-t1-ctx', projectId: 'p1', userId: 'u1',
  permissionMode: 'auto', model, projectName: 'test', branch: 'main', profile: SUPERVISOR_LIKE,
  doctrineOverride: 'You are a test agent.', history: [], userMessage: 'status?', emit: jest.fn(),
});
const FINAL = { content: 'All quiet.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const contextEvents = (input: AgentRunInput) => (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'context').map((c) => c[1]);
const toolResultEvents = (input: AgentRunInput) => (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'tool_result').map((c) => c[1]);
const rows = (kind: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === kind);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockStoreFindings.mockResolvedValue(1);
  delete process.env.REGISTRY_CONTEXT_FAMILY_DISABLED;
  delete process.env.MEMORY_READ_REOFFLOAD_SKIP_DISABLED;
  __resetContextCharCeilingsForTests();
  __resetSeatInvalidRequestLatchesForTests();
});

describe('T1-1 — a supervisor on the gateway glm-5.3 seat is no longer clamped to 160k', () => {
  it("the profile's 1M budget binds (seat sized by family to 4M); the event + the context_budget row name the sources", async () => {
    mockRunModelTurn.mockResolvedValueOnce(FINAL);
    const input = makeInput();
    await runCodingAgent(input);
    const [ev] = contextEvents(input);
    expect(ev).toMatchObject({ budget: 1_000_000, budgetSource: 'profile', seatContextSource: 'family' });
    const [row] = rows('context_budget');
    expect(row).toMatchObject({ value: 1_000_000, unit: 'chars', meta: { model: 'api-optimize-zai-glm-5.3', source: 'family', seatContextChars: 4_000_000, budget: 1_000_000, outcome: 'run_start' } });
  });

  it('a built-in seat: budgetSource names the profile, seatContextSource builtin, and NO context_budget row', async () => {
    mockRunModelTurn.mockResolvedValueOnce(FINAL);
    const input = makeInput('glm-5.3');
    await runCodingAgent(input);
    expect(contextEvents(input)[0]).toMatchObject({ budget: 1_000_000, budgetSource: 'profile', seatContextSource: 'builtin' });
    expect(rows('context_budget')).toHaveLength(0);
  });

  it('a FAMILY budget the server rejects BY SIZE learns a ceiling (size lane, never the 30-min seat latch): a ceiling_learned row, then the event reports size_rejection', async () => {
    const TOO_LARGE = {
      content: '', reasoning: '', toolCalls: [], finishReason: 'error', errorStatus: 400,
      errorMessage: 'Request too large or malformed for the model',
      providerError: '{"error":{"message":"This model\'s maximum context length is 131072 tokens"}}',
    };
    mockRunModelTurn.mockResolvedValueOnce(TOO_LARGE).mockResolvedValueOnce(FINAL);
    const input = makeInput();
    await runCodingAgent(input);
    const learned = rows('context_budget').filter((r) => r.meta?.outcome === 'ceiling_learned');
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({ value: 160_000, meta: { source: 'family', budget: 1_000_000, ceiling: 160_000, status: 400 } });
    const evs = contextEvents(input);
    expect(evs[evs.length - 1]).toMatchObject({ budget: 160_000, budgetSource: 'size_rejection', seatContextSource: 'family' });
    // the size lane served it — the seat was NOT latched off / re-seated (the run stayed on the gateway)
    expect(mockRunModelTurn.mock.calls.every((c) => c[0].model === 'api-optimize-zai-glm-5.3')).toBe(true);
  });

  it('kill switch REGISTRY_CONTEXT_FAMILY_DISABLED=1 → the pre-fix 160k clamp, no source fields, no row', async () => {
    process.env.REGISTRY_CONTEXT_FAMILY_DISABLED = '1';
    mockRunModelTurn.mockResolvedValueOnce(FINAL);
    const input = makeInput();
    await runCodingAgent(input);
    const [ev] = contextEvents(input);
    expect(ev.budget).toBe(160_000);
    expect('budgetSource' in ev).toBe(false);
    expect('seatContextSource' in ev).toBe(false);
    expect(rows('context_budget')).toHaveLength(0);
  });
});

describe('T1-4 — a memory read is never stored back to memory', () => {
  const MEM_TURN = { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'm1', name: 'search_memory', arguments: '{"query":"ALRI licence decision"}' }] };

  it('a >8k search_memory result: no store call, the marker says why', async () => {
    mockExecuteCodingTool.mockResolvedValueOnce(`(orchestrator · search_memory: ALRI) ${'h'.repeat(12_000)}`);
    mockRunModelTurn.mockResolvedValueOnce(MEM_TURN).mockResolvedValueOnce(FINAL);
    const input = makeInput('glm-5.3');
    await runCodingAgent(input);
    expect(mockStoreFindings.mock.calls.find((c) => String(c[2]?.[0]?.ref || '').startsWith('search_memory:'))).toBeUndefined();
    const [ev] = toolResultEvents(input);
    expect(ev.result).toContain('…[truncated');
    expect(ev.result).toContain('a memory read is never re-stored to memory');
    expect(ev.result).not.toContain('searchable via search_memory');
  });

  it('kill switch MEMORY_READ_REOFFLOAD_SKIP_DISABLED=1 → stored again (pre-fix)', async () => {
    process.env.MEMORY_READ_REOFFLOAD_SKIP_DISABLED = '1';
    mockExecuteCodingTool.mockResolvedValueOnce(`hits ${'h'.repeat(12_000)}`);
    mockRunModelTurn.mockResolvedValueOnce(MEM_TURN).mockResolvedValueOnce(FINAL);
    const input = makeInput('glm-5.3');
    await runCodingAgent(input);
    expect(mockStoreFindings.mock.calls.find((c) => String(c[2]?.[0]?.ref || '').startsWith('search_memory:'))).toBeDefined();
    expect(toolResultEvents(input)[0].result).toContain('full detail is searchable via search_memory');
  });
});

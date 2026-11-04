/**
 * P4 CanLaw L4 — durable intermediate deliverables: a substantial mid-run
 * assistant text on a TOOL-CALLING turn (superseded by construction — it never
 * becomes finalText) that cites ≥1 of this run's harness receipt ids is
 * offloaded to session memory (storeFindings, ref 'intermediate:<runId>:<step>')
 * instead of being lost to the final-only consumers. Bounded ≤5/run, ≥600
 * chars, orchestrator only.
 *
 * Harness: the REAL ./agent module with the repo-standard stand-ins (the
 * agent-zero-tool-gate.test.ts precedent); the model turn is a jest mock.
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

const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'probe result: 1 row read');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
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
const mockStoreFindings: jest.Mock = jest.fn(async () => 1);
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  storeFindings: (...a: any[]) => mockStoreFindings(...a),
}));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
jest.mock('./run-receipts.service', () => ({
  __esModule: true,
  recordRunReceiptAsync: jest.fn(),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import type { ToolReceipt } from './run-receipts';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 6,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

const RID = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111';
const PRIOR_RECEIPT: ToolReceipt = {
  id: RID, chatId: 'sess-interm-1', runId: 'run-1', tool: 'send_chat_message', ok: true,
  ids: { chatId: 'c2' }, inputHash: null, outputHash: null, createdAt: new Date('2026-09-09T11:00:00Z'),
};

const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree: '/tmp/intermediate-offload-test',
  sessionId: 'sess-interm-1',
  runId: 'run-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'audit and report',
  emit: jest.fn(),
  // Pre-seed the receipt collector (the executor does this on resume; the
  // collector IS input.receipts — agent.ts line `input.receipts ?? []`).
  receipts: [PRIOR_RECEIPT],
  ...over,
});

/** A ≥600-char intermediate deliverable citing the receipt's 8-char prefix. */
const DELIVERABLE = (
  `Results table (receipt ${RID.slice(0, 8)} backed):\n` +
  'lane A: 42 rows migrated cleanly, checksum stable across both reads.\n'.repeat(9) +
  'Now re-checking lane B before the final verdict.'
);

const TOOL_TURN_WITH_TEXT = {
  content: DELIVERABLE,
  reasoning: '',
  toolCalls: [{ id: 't1', name: 'list_feedback', arguments: '{"status":"open"}' }],
  finishReason: 'tool_calls',
};
const FINAL = { content: 'Final: both lanes clean.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const intermediateCalls = () => mockStoreFindings.mock.calls.filter((c) => c[1] === 'intermediate');

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('durable intermediate deliverables (P4 CanLaw L4)', () => {
  it('a ≥600-char receipt-citing text on a tool-calling turn is offloaded to session memory with ref intermediate:<runId>:<step>', async () => {
    expect(DELIVERABLE.length).toBeGreaterThanOrEqual(600);
    mockRunModelTurn
      .mockResolvedValueOnce(TOOL_TURN_WITH_TEXT)
      .mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput());

    expect(result.finalText).toBe(FINAL.content);
    expect(intermediateCalls()).toHaveLength(1);
    const [sessionId, source, items] = intermediateCalls()[0];
    expect(sessionId).toBe('sess-interm-1');
    expect(source).toBe('intermediate');
    expect(items).toEqual([{ ref: 'intermediate:run-1:0', content: DELIVERABLE }]);
  });

  it('short texts and texts citing NO receipt are never offloaded', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce({ ...TOOL_TURN_WITH_TEXT, content: 'Quick check first.' })
      .mockResolvedValueOnce({ ...TOOL_TURN_WITH_TEXT, content: 'x'.repeat(700) }) // long but cites nothing
      .mockResolvedValueOnce(FINAL);
    await runCodingAgent(makeInput());
    expect(intermediateCalls()).toHaveLength(0);
  });
});

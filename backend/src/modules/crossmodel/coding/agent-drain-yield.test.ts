
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

const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'probe result: 1 file read');
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
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
// The session-scope read (this chat's earlier receipts) — lazily loaded only when a claim is still open.
const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => []);
jest.mock('./run-receipts.service', () => ({
  __esModule: true,
  recordRunReceiptAsync: jest.fn(),
  getRecentChatReceipts: (...a: any[]) => mockGetRecentChatReceipts(...a),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

/**
 * Soft drain yield (2026-10-19 — the corrected #1778): a draining worker asks
 * a long run to hand off. The loop honours it only at the TOP of a step (the
 * previous turn's tools are done, no model stream in flight) and calls
 * onDrainYield — which marks the run interrupted + cancelled — so every
 * post-loop step (auto-verify, review, nudges) skips exactly as on the hard
 * drain bound, and no further model turn or tool runs on the retiring worker.
 */
const PROFILE: AgentProfile = {
  kind: 'chat', maxSteps: 6, maxDelegations: 0, contextCharBudget: 100_000,
  workspaceTools: false, planReminders: false, memorySource: 'chat',
};

function makeInput(over: Partial<AgentRunInput>): AgentRunInput {
  return {
    worktree: '/tmp/drain-yield-test', sessionId: 'sess-drain-1', projectId: 'p1', userId: 'u1',
    permissionMode: 'auto', model: 'glm-5.2', projectName: 'test', branch: 'main', profile: PROFILE,
    doctrineOverride: 'You are a test agent.', history: [], userMessage: 'do the thing',
    emit: jest.fn(), ...over,
  };
}

const TOOL_TURN = {
  content: '', reasoning: '', finishReason: 'tool_calls',
  toolCalls: [{ id: 't1', name: 'get_account_overview', arguments: '{}' }],
};
const FINAL = { content: 'All done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => { jest.clearAllMocks(); mockRunModelTurn.mockReset(); _store.clear(); });

describe('soft drain yield', () => {
  it('a yield requested during a turn hands off at the next step boundary: the turn\'s tools finish, no further model turn runs', async () => {
    let yieldAsked = false;
    let cancelled = false;
    const onDrainYield = jest.fn(() => { cancelled = true; });
    mockRunModelTurn.mockImplementationOnce(async () => { yieldAsked = true; return TOOL_TURN; }).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({
      isCancelled: () => cancelled,
      isDrainYieldRequested: () => yieldAsked,
      onDrainYield,
    }));
    expect(onDrainYield).toHaveBeenCalledTimes(1);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(1); // nothing after the hand-off
  });

  it('no yield requested ⇒ the run is untouched', async () => {
    const onDrainYield = jest.fn();
    mockRunModelTurn.mockResolvedValueOnce(TOOL_TURN).mockResolvedValue(FINAL);
    const r = await runCodingAgent(makeInput({ isDrainYieldRequested: () => false, onDrainYield }));
    expect(onDrainYield).not.toHaveBeenCalled();
    expect(r.finalText).toBe('All done.');
  });

  it('a user Stop wins over a yield (the run is not re-queued as interrupted)', async () => {
    const onDrainYield = jest.fn();
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ isCancelled: () => true, isDrainYieldRequested: () => true, onDrainYield }));
    expect(onDrainYield).not.toHaveBeenCalled();
  });
});

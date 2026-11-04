/**
 * RETRY-LANE BUDGET GRANTS (owner transcript 2026-09-08 audit): every retry
 * lane in agentLoop re-enters the for-loop with `continue`, which consumes a
 * step — on the LAST step the promised retry never ran: the loop exited with
 * finalText '' and modelErrored false, so a provider error / repeating turn /
 * leaked plain-text tool call on the final step was recorded as a clean
 * "completed" run. The lanes now grant the step (or, for the leak lane, a
 * tool round) so the retry actually executes.
 *
 * Harness: the zero-tool gate's stand-ins (this header is a copy of
 * agent-zero-tool-gate.test.ts's — keep them in sync).
 *
 * (Original header follows.)
 * ZERO-TOOL PRE-FINAL GATE (kernel-opt lane b95e9df6, fabrication incident #13):
 * a machine-triggered wake pattern-completed its own hyper-templated prompt into
 * a COMPLETE fabricated audit report in ~2 minutes — claimed commit, folds,
 * prompt updates, future-dated stamps — with ZERO tool calls; the reactive
 * evidence guard caught it only POST-generation (full re-orchestration cost).
 *
 * The gate is deterministic (no LLM, no claim regex): a MACHINE-triggered
 * top-level run whose finalize turn carries no tool_calls while the run has
 * executed ZERO tool calls gets its draft DISCARDED once and a harness notice
 * injected; the second zero-tool finalize passes through to the guard lanes.
 * User runs and any run with ≥1 executed tool call are never touched, and a
 * run at its step cap is granted exactly one extra tool round.
 *
 * Harness: the REAL ./agent module with the repo-standard stand-ins
 * (agent-reject-back.test.ts precedent); the model turn is a jest mock;
 * executeCodingTool is mocked so a probing turn dispatches cheaply.
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

// Coding-tool execution: mocked so a probing turn (read_file) dispatches
// without a worktree; the schemas stay real.
const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'probe result: 1 file read');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// Telemetry: the gate fires GUARD_STRIKE rows with seam zero_tool_prefinal;
// remediation P0 adds PROVIDER_REJECTED (non-transient model-call rejections)
// and SELF_AUDIT_RUN.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', PROVIDER_REJECTED: 'provider_rejected', SELF_AUDIT_RUN: 'self_audit_run' },
}));

// In-memory context store (loop-goal-monitor.test.ts pattern) so the REAL
// usage-store reads/writes work without a DB.
const _store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { _store.set(ns.join('/') + '::' + key, value); }),
}));

// Run-journal reads stay empty (chat profile skips them anyway).
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
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 1, // every case below runs its FIRST turn on the capped final step
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/retry-lanes-test',
  sessionId: 'sess-retry-lanes-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'answer the question',
  emit: jest.fn(),
});

const GOOD_FINAL = { content: 'Here is the answer.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const PROBE_TURN = {
  content: 'Reading first.', reasoning: '',
  toolCalls: [{ id: 't1', name: 'list_feedback', arguments: '{"status":"open"}' }], // chat-lane-offered evidence tool (see agent-zero-tool-gate.test.ts)
  finishReason: 'tool_calls',
};

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset (not just clear): a case that queues more turns than the loop
  // consumes must not leak its leftovers into the next case's queue.
  mockRunModelTurn.mockReset();
  _store.clear();
});

describe('retry lanes on the FINAL step actually retry (2026-09-08)', () => {
  it('a non-transient provider error (HTTP 400 naming a size cause) on the last step is retried once instead of ending the run as a silent "completed" with finalText ""', async () => {
    mockRunModelTurn
      // Post-4251dcb3 a BARE in-budget 400 takes the transient backoff lane;
      // the size-named provider body keeps this case in the shrink lane it tests.
      .mockResolvedValueOnce({ content: '', reasoning: '', toolCalls: [], finishReason: 'error', errorStatus: 400, errorMessage: 'bad request', providerError: '{"error":{"message":"maximum context length exceeded"}}' })
      .mockResolvedValueOnce(GOOD_FINAL);
    const result = await runCodingAgent(makeInput());
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(mockRunModelTurn.mock.calls[1][2]).toBeUndefined(); // still the tool-less final-step shape
    expect(result.finalText).toBe(GOOD_FINAL.content);
    expect(result.modelErrored).toBeFalsy();
    // Remediation P0: the 400-class rejection emitted ONE provider_rejected
    // row carrying the run stamp (model/profile/triggerKind) + the request
    // shape (chars/status/attempt).
    const rejected = mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'provider_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0][0].meta).toMatchObject({ status: 400, attempt: 1 });
    expect(rejected[0][0].meta.chars).toBeGreaterThan(0);
    expect(rejected[0][0].stamp).toMatchObject({ model: 'glm-5.3', profile: 'chat', triggerKind: 'user' });
  });

  it('a repeating turn on the last step is nudged and retried, not dropped', async () => {
    // The stream layer flags degenerate repetition itself (finishReason 'repetition').
    const LOOPING = { content: 'again and again. '.repeat(40), reasoning: '', toolCalls: [], finishReason: 'repetition' };
    mockRunModelTurn
      .mockResolvedValueOnce(LOOPING)
      .mockResolvedValueOnce(GOOD_FINAL);
    const result = await runCodingAgent(makeInput());
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(result.finalText).toBe(GOOD_FINAL.content);
  });

  it('a tool call leaked as PLAIN TEXT on the last step gets a REAL tool round (tools attached, FINAL TURN notice spliced), then the answer', async () => {
    const LEAKED = {
      content: 'Let me read it.\n<invoke name="list_feedback"><parameter name="status">open</parameter></invoke>',
      reasoning: '', toolCalls: [], finishReason: 'stop',
    };
    mockRunModelTurn
      .mockResolvedValueOnce(LEAKED)
      .mockResolvedValueOnce(PROBE_TURN)
      .mockResolvedValueOnce(GOOD_FINAL);
    const result = await runCodingAgent(makeInput());
    expect(mockRunModelTurn).toHaveBeenCalledTimes(3);
    expect(mockRunModelTurn.mock.calls[0][2]).toBeUndefined();        // capped final step: no tools
    expect(Array.isArray(mockRunModelTurn.mock.calls[1][2])).toBe(true); // granted round carries tools
    // The loop passes its LIVE messages array to every turn (the same object
    // is mutated later), so inspect ORDER: no FINAL TURN notice may precede the
    // leak notice — the step-2 forced-answer notice legitimately follows it.
    const msgs = mockRunModelTurn.mock.calls[1][1] as any[];
    const isUserText = (m: any, needle: string) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(needle);
    const leakIdx = msgs.findIndex((m) => isUserText(m, 'tool-call markup as PLAIN TEXT'));
    expect(leakIdx).toBeGreaterThanOrEqual(0);
    expect(msgs.slice(0, leakIdx).some((m) => isUserText(m, 'FINAL TURN:'))).toBe(false);
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
    expect(result.finalText).toBe(GOOD_FINAL.content);
  });
});

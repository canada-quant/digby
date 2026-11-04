/**
 * Ticket 78f32515 — agent-side wiring pin for the breaker lane notice.
 *
 * THE GAP: a lane whose run was ended by the narrated-tool-emit loop breaker
 * (PR #894, ticket 177a31b7) learned about it only indirectly — the auto-filed
 * ticket lands in the supervisor queue; the attention_needed alarm reaches
 * hook subscribers. A relaunched lane derailed IDENTICALLY because nothing
 * told it why its previous run died (ticket 0aecbe92: CanLaw session
 * 10cb988f burned TWO consecutive scheduled runs to the same wrong-tool
 * derailment, zero steps executed).
 *
 * THE FIX PINNED HERE: at breaker trip, agent.ts chains the deduped
 * attribution filing into writeBreakerLaneNotice — a one-shot [BREAKER
 * NOTICE] naming the breaker, the streak shape, and the auto-filed ticket id,
 * consumed into the lane's next run's [SCHEDULER NOTICE] context by the
 * run-executor (executor-side pin in run-executor.test.ts; unit pin in
 * breaker-lane-notice.78f32515.test.ts).
 *
 * Scaffold mirrors agent-narr-loop-break.177a31b7.test.ts (same mock set).
 */

jest.setTimeout(60_000);

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

// The model turn: ONE mock drives every case.
const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, seatUnservableReason: async () => null, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'probe result: ok');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// In-memory context store — the REAL plan.service helpers run against it.
const _store = new Map<string, any>();
const mockStoreGet: jest.Mock = jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null);
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => mockStoreGet(...(a as [string[], string])),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { _store.set(ns.join('/') + '::' + key, value); }),
}));

jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
jest.mock('./coding-memory.service', () => ({
  __esModule: true,
  getUserCodingMemory: jest.fn(async () => null),
  getProjectMemory: jest.fn(async () => null),
  getSessionMemory: jest.fn(async () => null),
  formatCodingMemoryBlock: jest.fn(() => ''),
}));
jest.mock('./scaffolding.service', () => ({
  __esModule: true,
  assessDocsHealth: jest.fn(async () => ({ drift: [], nudgeSilenced: true, commandsUserOwned: false, autoRefreshable: true })),
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
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn(), buildCodeMatchesBlock: jest.fn(async () => '') }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0), buildSessionMemoryInventory: jest.fn(async () => '') }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

// The boundary under test: the trip's attribution filing RETURNS the ticket
// id, and the notice write must ride its resolution with that id.
const mockFileStreakInvestigation: jest.Mock = jest.fn(async () => 'ticket-78f32515-notice');
const mockWriteBreakerLaneNotice: jest.Mock = jest.fn(async () => undefined);
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  fileStreakInvestigation: (...a: any[]) => mockFileStreakInvestigation(...a),
  writeBreakerLaneNotice: (...a: any[]) => mockWriteBreakerLaneNotice(...a),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordRunSpend: jest.fn(),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
}));

// Plan board: actual module, getPlan mocked per-case (goal-continue resurrects
// the wedge — the incident's mechanism).
const mockGetPlan: jest.Mock = jest.fn(async () => null);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlan: (...a: any[]) => mockGetPlan(...a),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 6,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: true,
  planReminders: true,
  memorySource: 'coding',
};

const makeInput = (sessionId: string): AgentRunInput => ({
  worktree: '/tmp/narr-loop-notice-78f32515-test-does-not-exist',
  sessionId,
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'relay the window gate to the peer lane',
  emit: jest.fn(),
});

const wedgePlan = () => ({
  goal: 'relay the window gate',
  acceptanceCriteria: ['relay delivered'],
  steps: [
    { id: 1, text: 'open the window gate', status: 'completed' },
    { id: 2, text: 'send the window-gate relay to 521020fe', status: 'in_progress' },
  ],
  version: 3,
  updatedAt: '2026-09-20T01:30:00.000Z',
});

const TURN = (content: string) => ({ content, reasoning: '', toolCalls: [], finishReason: 'stop' });

/** The 177a31b7 incident's exact wedge line (announce channel — names NO tool). */
const INCIDENT_LINE = 'Sending the window-gate relay to 521020fe NOW:';

const flushFireAndForget = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

describe('ticket 78f32515 — breaker trip writes the derailed lane a one-shot notice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _store.clear();
    mockGetPlan.mockResolvedValue(null);
    mockFileStreakInvestigation.mockResolvedValue('ticket-78f32515-notice');
  });

  it('trip chains the attribution filing into writeBreakerLaneNotice with the ticket id, breaker, and streak shape', async () => {
    mockGetPlan.mockResolvedValue(wedgePlan());
    mockRunModelTurn
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))
      .mockResolvedValue(TURN('unreachable — the loop must already be broken'));

    const result = await runCodingAgent(makeInput('sess-78f32515'));
    await flushFireAndForget();

    expect(result.narrLoopEnded).toBeDefined();
    // Attribution filing still intact (the run-end parity contract).
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    // …and its resolution fed the lane notice verbatim.
    expect(mockWriteBreakerLaneNotice).toHaveBeenCalledTimes(1);
    const [sessionId, notice] = mockWriteBreakerLaneNotice.mock.calls[0];
    expect(sessionId).toBe('sess-78f32515');
    expect(notice.breaker).toBe('narrated-tool-emit loop');
    expect(notice.tool).toBeNull(); // the incident line names no tool
    expect(notice.repeats).toBe(4);
    expect(notice.snippet).toContain('Sending the window-gate relay');
    expect(notice.ticketId).toBe('ticket-78f32515-notice');
  });

  it('a filing that resolves null still writes the notice (id-less, honest)', async () => {
    mockFileStreakInvestigation.mockResolvedValue(null);
    mockGetPlan.mockResolvedValue(wedgePlan());
    mockRunModelTurn
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))
      .mockResolvedValue(TURN('unreachable'));

    const result = await runCodingAgent(makeInput('sess-78f32515-noid'));
    await flushFireAndForget();

    expect(result.narrLoopEnded).toBeDefined();
    expect(mockWriteBreakerLaneNotice).toHaveBeenCalledTimes(1);
    expect(mockWriteBreakerLaneNotice.mock.calls[0][1].ticketId).toBeNull();
  });

  it('no trip (a real tool call breaks the streak) → no notice written', async () => {
    mockGetPlan.mockResolvedValue(wedgePlan());
    mockRunModelTurn
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))
      .mockResolvedValueOnce({
        content: '', reasoning: '',
        toolCalls: [{ id: 't3', name: 'send_chat_message', arguments: JSON.stringify({ chatId: '521020fe-ebe5-4d97-8b58-fdbe8c95445f', content: 'relay' }) }],
        finishReason: 'tool_calls',
      })
      .mockResolvedValue(TURN('Relay sent — the receipt confirms delivery.'));

    const result = await runCodingAgent(makeInput('sess-78f32515-recover'));
    await flushFireAndForget();

    expect(result.narrLoopEnded).toBeUndefined();
    expect(mockWriteBreakerLaneNotice).not.toHaveBeenCalled();
  });
});

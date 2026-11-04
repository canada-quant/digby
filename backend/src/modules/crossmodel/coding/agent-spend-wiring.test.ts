/**
 * Audit #8 riders — the two agent.ts telemetry wirings, pinned end-to-end
 * through the REAL agent loop (agent-reject-back.test.ts scaffold, coding-
 * shaped profile so the finalize block `topLevel && profile.workspaceTools`
 * actually runs):
 *   (a) recordRunSpend fires at run finalize, right after commitRunUsage,
 *       with the run's usage runId + sessionId + final snapshot;
 *   (b) turn.usage.cachedTokens threads into the accumulator so the snapshot
 *       recordRunSpend receives carries cache visibility.
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

// The model turn: ONE mock drives every case.
const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  // seatUnservableReason: the worker pre-flight (2026-09-08) must not refuse
  // dispatch in keyless jest.
  return { ...actual, seatUnservableReason: async () => null, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

// In-memory context store so the REAL usage-store (commitRunUsage) works.
const _store = new Map<string, any>();
const mockStorePut: jest.Mock = jest.fn(async (ns: string[], key: string, value: any) => { _store.set(ns.join('/') + '::' + key, value); });
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null),
  storePut: (...a: any[]) => mockStorePut(...(a as [string[], string, any])),
}));

jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
// Coding memory tiers (workspaceTools profile reads all three).
jest.mock('./coding-memory.service', () => ({
  __esModule: true,
  getUserCodingMemory: jest.fn(async () => null),
  getProjectMemory: jest.fn(async () => null),
  getSessionMemory: jest.fn(async () => null),
  formatCodingMemoryBlock: jest.fn(() => ''),
}));
// buildAgentGuide's docs-health nudge dynamic-imports scaffolding.service.
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
  buildChatWakeClockNote: jest.fn(() => ""),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0), buildSessionMemoryInventory: jest.fn(async () => '') }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

// THE seam under test: the loop-metrics spend recorder (wave 1, audit #12) +
// the remediation-P0 stamp/self-audit telemetry.
const mockRecordRunSpend: jest.Mock = jest.fn();
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordRunSpend: (...a: any[]) => mockRecordRunSpend(...a),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits', SELF_AUDIT_RUN: 'self_audit_run', GUARD_STRIKE: 'guard_strike', GOAL_CONTINUE: 'goal_continue' },
}));

// Plan board (goal-continue/self-audit lane): actual module, getPlan mocked —
// null keeps every pre-existing case identity (the lane needs 'auto' anyway).
const mockGetPlan: jest.Mock = jest.fn(async () => null);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlan: (...a: any[]) => mockGetPlan(...a),
}));

import { runCodingAgent, runChatWorker } from './agent';
import { UsageAccumulator } from './cost';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

// Coding-shaped but minimal: workspaceTools TRUE is what routes the finalize
// through commitRunUsage + recordRunSpend; permissionMode 'ask' + no plan/verify
// chain keeps the goal-continue/auto-verify tails inert; the missing worktree
// path degrades every fs read gracefully (buildRepoContext catches).
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 4,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: true,
  planReminders: false,
  memorySource: 'coding',
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/spend-wiring-test-does-not-exist',
  sessionId: 'sess-spend-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'ask',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'do the thing',
  emit: jest.fn(),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPlan.mockResolvedValue(null);
  _store.clear();
});

describe('agent.ts finalize telemetry wiring (audit #8 riders)', () => {
  it('records run spend at finalize — usage runId + sessionId + the FINAL snapshot, after commitRunUsage', async () => {
    mockRunModelTurn.mockResolvedValueOnce({
      content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 1000, completionTokens: 200, cachedTokens: 300 },
    });
    const input = makeInput();
    await runCodingAgent(input);

    expect(mockRecordRunSpend).toHaveBeenCalledTimes(1);
    const [runId, sessionId, snapshot] = mockRecordRunSpend.mock.calls[0];
    // The usage runId (idempotent across resumes) — the same one the
    // accumulator stamps on every snapshot.
    expect(runId).toBe(input.usage!.runId);
    expect(sessionId).toBe('sess-spend-1');
    expect(snapshot.totalInTokens).toBe(1000);
    expect(snapshot.totalOutTokens).toBe(200);
    expect(snapshot.turns).toBe(1);
    // commitRunUsage (the session-usage store write) landed BEFORE the spend record.
    const commitCall = mockStorePut.mock.calls.find((c: any[]) => Array.isArray(c[0]) && c[0].includes('coding-usage'));
    expect(commitCall).toBeDefined();
    expect(mockStorePut.mock.invocationCallOrder[mockStorePut.mock.calls.indexOf(commitCall!)])
      .toBeLessThan(mockRecordRunSpend.mock.invocationCallOrder[0]);
    // Remediation P0 (N6): the spend record carries the run's metric stamp so
    // the run_spend/run_tokens rows land with model/provider/profile/trigger.
    expect(mockRecordRunSpend.mock.calls[0][3]).toMatchObject({
      model: 'kimi-k3', profile: 'coding', triggerKind: 'user',
    });
  });

  it('remediation P0: the pre-finish SELF-AUDIT round emits ONE self_audit_run row with the run stamp', async () => {
    // All plan steps completed → the goal-continue lane takes the self-audit
    // branch once (auto mode + planReminders), grants a round, then finishes.
    mockGetPlan.mockResolvedValue({
      goal: 'ship it', acceptanceCriteria: ['it works'],
      steps: [{ id: 1, text: 'the step', status: 'completed' }],
    });
    mockRunModelTurn
      .mockResolvedValueOnce({ content: 'All steps done.', reasoning: '', toolCalls: [], finishReason: 'stop' })
      .mockResolvedValueOnce({ content: 'Re-verified — final summary.', reasoning: '', toolCalls: [], finishReason: 'stop' });
    const input = { ...makeInput(), permissionMode: 'auto' as const, profile: { ...CODING_TEST_PROFILE, planReminders: true } };
    const result = await runCodingAgent(input);

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2); // the audit round actually ran
    const audits = mockRecordLoopMetric.mock.calls.filter((c: any[]) => c[0]?.kind === 'self_audit_run');
    expect(audits).toHaveLength(1); // once per run, ever (selfAudited latch)
    expect(audits[0][0].sessionId).toBe('sess-spend-1');
    expect(audits[0][0].stamp).toMatchObject({ model: 'kimi-k3', profile: 'coding', triggerKind: 'user' });
    expect(result.finalText).toContain('final summary');
  });

  it('agent-decisions prerequisite 6: ONE goal_continue row per goal-continue EVALUATION (progressed / stalls / evidenceToolCalls / resumed) with the run stamp — the second stall round is the last', async () => {
    // One PENDING step the model never advances: round 0 progressed (the
    // board is new to the run) → resume; round 1 stall 1 → resume; round 2
    // stall 2 → stop honestly. Three finals, three evaluations.
    const pendingBoard = { goal: 'ship it', acceptanceCriteria: ['it works'], steps: [{ id: 1, text: 'the step', status: 'pending' }] };
    const finals = () => mockRunModelTurn
      .mockResolvedValueOnce({ content: 'Paused.', reasoning: '', toolCalls: [], finishReason: 'stop' })
      .mockResolvedValueOnce({ content: 'Still paused.', reasoning: '', toolCalls: [], finishReason: 'stop' })
      .mockResolvedValueOnce({ content: 'Cannot progress — stopping.', reasoning: '', toolCalls: [], finishReason: 'stop' });
    mockGetPlan.mockResolvedValue(pendingBoard);
    finals();
    const input = { ...makeInput(), permissionMode: 'auto' as const, profile: { ...CODING_TEST_PROFILE, planReminders: true } };
    await runCodingAgent(input);

    expect(mockRunModelTurn).toHaveBeenCalledTimes(3);
    const rows = mockRecordLoopMetric.mock.calls.filter((c: any[]) => c[0]?.kind === 'goal_continue').map((c: any[]) => c[0]);
    expect(rows.map((r: any) => r.meta)).toEqual([
      expect.objectContaining({ round: 0, max: 40, progressed: true, stalls: 0, evidenceToolCalls: 0, unfinished: 1, resumed: true }),
      expect.objectContaining({ round: 1, progressed: false, stalls: 1, resumed: true }),
      expect.objectContaining({ round: 2, progressed: false, stalls: 2, resumed: false }),
    ]);
    expect(rows[0].sessionId).toBe('sess-spend-1');
    expect(rows[0].stamp).toMatchObject({ model: 'kimi-k3', profile: 'coding', triggerKind: 'user' });
  });

  it('threads turn.usage.cachedTokens into the accumulator — cache visibility rides the spend snapshot', async () => {
    mockRunModelTurn.mockResolvedValueOnce({
      content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 1000, completionTokens: 200, cachedTokens: 300 },
    });
    await runCodingAgent(makeInput());

    const snapshot = mockRecordRunSpend.mock.calls[0][2];
    expect(snapshot.totalCachedTokens).toBe(300);
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0].cachedTokens).toBe(300);
    expect(snapshot.agents[0].inTokens).toBe(1000); // cached is a subset marker, never subtracted
  });

  it('a provider that reports no cachedTokens leaves the snapshot cache-clean (no spurious zeros)', async () => {
    mockRunModelTurn.mockResolvedValueOnce({
      content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 500, completionTokens: 50 },
    });
    await runCodingAgent(makeInput());

    const snapshot = mockRecordRunSpend.mock.calls[0][2];
    expect(snapshot.totalCachedTokens).toBe(0);
    expect(snapshot.agents[0].cachedTokens).toBeUndefined();
  });
});

// Review 2026-09-13 issue 5: chat-profile runs (workspaceTools:false — plain
// chat, the Fleet Supervisor, council lanes) used to fall out of the
// `topLevel && profile.workspaceTools` finalize gate and meter $0. They now
// land run_spend with their own profile + seat model; the coding-only session
// meter (commitRunUsage) stays coding-only.
describe('Review 2026-09-13 issue 5: chat-profile spend is metered', () => {
  const CHAT_TEST_PROFILE: AgentProfile = {
    kind: 'chat',
    maxSteps: 4,
    maxDelegations: 0,
    contextCharBudget: 100_000,
    workspaceTools: false,
    planReminders: false,
    memorySource: 'chat',
  };

  it('a workspace-less chat run records run spend with profile chat + the seat model, and never commits the coding session meter', async () => {
    mockRunModelTurn.mockResolvedValueOnce({
      content: 'fleet looks fine', reasoning: '', toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 60_000, completionTokens: 900 },
    });
    const input: AgentRunInput = { ...makeInput(), profile: CHAT_TEST_PROFILE, machineTriggered: true, sessionId: 'sess-supervisor-1' };
    await runCodingAgent(input);

    expect(mockRecordRunSpend).toHaveBeenCalledTimes(1);
    const [runId, sessionId, snapshot, stamp] = mockRecordRunSpend.mock.calls[0];
    expect(runId).toBe(input.usage!.runId);
    expect(sessionId).toBe('sess-supervisor-1');
    expect(snapshot.totalInTokens).toBe(60_000);
    expect(snapshot.totalOutTokens).toBe(900);
    // The stamp is what lets spend-cap / dashboards split chat from coding spend.
    expect(stamp).toMatchObject({ model: 'kimi-k3', profile: 'chat', triggerKind: 'machine' });
    // commitRunUsage is a workspace feature — no coding-usage store write for a chat run.
    const commitCall = mockStorePut.mock.calls.find((c: any[]) => Array.isArray(c[0]) && c[0].includes('coding-usage'));
    expect(commitCall).toBeUndefined();
  });

  it('coding runs are unchanged: commitRunUsage still lands and still precedes recordRunSpend', async () => {
    mockRunModelTurn.mockResolvedValueOnce({
      content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 10 },
    });
    await runCodingAgent(makeInput());
    const commitCall = mockStorePut.mock.calls.find((c: any[]) => Array.isArray(c[0]) && c[0].includes('coding-usage'));
    expect(commitCall).toBeDefined();
    expect(mockRecordRunSpend).toHaveBeenCalledTimes(1);
    expect(mockRecordRunSpend.mock.calls[0][3]).toMatchObject({ profile: 'coding' });
  });
});

describe('WI-D: a SHARED turn ledger is held by the loop and written by its settle — never by the loop itself', () => {
  it('runCodingAgent retains the ledger for its lifetime, skips its own recordRunSpend, and the caller\'s close() settles once with the full snapshot', async () => {
    mockRunModelTurn.mockResolvedValueOnce({
      content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 1000, completionTokens: 200 },
    });
    const settle = jest.fn();
    const ledger = new UsageAccumulator().shareAcrossRuns(settle);
    const input = { ...makeInput(), usage: ledger };
    await runCodingAgent(input);

    // The loop does NOT write run_spend for a shared ledger (it would double-count every retry).
    expect(mockRecordRunSpend).not.toHaveBeenCalled();
    // …and it released its hold; the caller's own hold keeps the ledger open.
    expect(settle).not.toHaveBeenCalled();
    expect(ledger.holdCount).toBe(1);
    expect(ledger.snapshot().totalInTokens).toBe(1000);

    ledger.close();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0]).toBe(ledger);
  });

  it('a plain (unshared) accumulator keeps the pre-WI-D contract: the loop writes run_spend itself', async () => {
    mockRunModelTurn.mockResolvedValueOnce({
      content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 2 },
    });
    const input = { ...makeInput(), usage: new UsageAccumulator() };
    await runCodingAgent(input);
    expect(mockRecordRunSpend).toHaveBeenCalledTimes(1);
    expect(mockRecordRunSpend.mock.calls[0][0]).toBe(input.usage!.runId);
  });
});

describe('seat-label fix (2026-09-25): AgentRunInput.usageRole meters a worker loop under its OWN seat', () => {
  // The L2 reconcile pass's shape: one-shot chat profile, no web tools, the
  // cross_checker WORKER role (its prompt/toolset), the LEAD's model.
  const CHAT_ONE_SHOT: AgentProfile = {
    kind: 'chat', maxSteps: 1, maxDelegations: 0, contextCharBudget: 100_000,
    workspaceTools: false, planReminders: false, memorySource: 'chat',
  };
  const turn = (promptTokens: number, completionTokens: number) => ({
    content: 'reconciled', reasoning: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens, completionTokens },
  });

  it('runChatWorker(…, "cross_checker") with usageRole "reconcile" records role "reconcile" on its OWN row — it never merges into the checker\'s row on the same model', async () => {
    const ledger = new UsageAccumulator().shareAcrossRuns(() => {});
    // The Double Checker already recorded on the SAME model (the prod lead-override case, run rmuheibibik4zav).
    ledger.record('Cross-checker', 'kimi-k3', { promptTokens: 500, completionTokens: 100, estimated: false }, 'cross_checker');
    mockRunModelTurn.mockResolvedValueOnce(turn(800, 150));
    const input: AgentRunInput = {
      ...makeInput(), profile: CHAT_ONE_SHOT, noWebTools: true, usage: ledger, usageRole: 'reconcile',
      userMessage: 'QUESTION:\nthe question\n\nYOUR DRAFT ANSWER:\ndraft\n\nCROSS-CHECK DRAFT\n\nWrite the final reconciled answer now.',
    };
    await runChatWorker(input, 'cross_checker');

    const rows = ledger.snapshot().agents;
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.role === 'cross_checker')).toMatchObject({ agent: 'Cross-checker', model: 'kimi-k3', inTokens: 500, outTokens: 100, turns: 1 }); // untouched
    expect(rows.find(r => r.role === 'reconcile')).toMatchObject({ agent: 'Cross-checker (reconcile)', model: 'kimi-k3', inTokens: 800, outTokens: 150, turns: 1 });
    // Shared ledger contract unchanged: the loop wrote nothing itself and released its hold.
    expect(mockRecordRunSpend).not.toHaveBeenCalled();
    expect(ledger.holdCount).toBe(1);
  });

  it('without usageRole a cross_checker worker still records role "cross_checker" under the role label (byte-identical)', async () => {
    const ledger = new UsageAccumulator().shareAcrossRuns(() => {});
    mockRunModelTurn.mockResolvedValueOnce(turn(500, 100));
    await runChatWorker({ ...makeInput(), profile: CHAT_ONE_SHOT, noWebTools: true, usage: ledger }, 'cross_checker');
    expect(ledger.snapshot().agents).toEqual([
      expect.objectContaining({ agent: 'Cross-checker', role: 'cross_checker', model: 'kimi-k3', inTokens: 500, outTokens: 100, turns: 1 }),
    ]);
  });
});

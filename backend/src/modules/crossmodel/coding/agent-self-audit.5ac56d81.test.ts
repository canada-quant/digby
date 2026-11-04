/**
 * REPLAY TEST — ticket 5ac56d81 (coding-harness plan-audit false-premise loop).
 *
 * WHAT HAPPENED (overnight 2026-09-18, canlegal-bench session d4c97977): the
 * agent-loop SELF-AUDIT fired 14 substantively identical FALSE-premise
 * rejections against a session whose plan was honestly 4/10 complete with
 * steps 5–10 BLOCKED on a measured multi-day external generation drain. Each
 * rejection asserted "You marked every plan step complete" (the lane never
 * had) and demanded reopening; the lane correctly declined; the audit re-fired
 * on the next schedule cadence tick (~4 min defense + a supervisor wake each).
 *
 * ROOT CAUSE (agent.ts goal-continue/self-audit lane):
 *   (a) `unfinished` counts only pending/in_progress, so a BLOCKED-step plan
 *       fell into the all-done self-audit branch and got the false premise;
 *   (b) the `selfAudited` latch is per-run (restored only from the in-run
 *       resume checkpoint), so every schedule firing re-audited an UNCHANGED
 *       plan — no cross-run dedupe.
 *
 * FIX PINNED HERE:
 *   1. Blocked-step plans get a TRUE-premise audit prompt (names completed/
 *      blocked counts, carries each blocker note, blesses a blocked step with
 *      a still-running external wait as a LEGITIMATE holding state, audits the
 *      completed work + re-probes each blocker) — never the "every step
 *      complete" blanket premise.
 *   2. The last-audited plan signature (id:status:text, notes excluded — the
 *      goal-continue lane's standing "plan changed" definition) is persisted
 *      in the context store; an UNCHANGED plan skips the repeat audit. A
 *      changed plan re-fires; a store failure fails OPEN to firing.
 *
 * Scaffold: agent-spend-wiring.test.ts (real agent loop, in-memory context
 * store, requireActual plan.service so the dedupe helpers run for real).
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
  return { ...actual, seatUnservableReason: async () => null, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

// In-memory context store — the REAL plan.service dedupe helpers run against it.
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

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordRunSpend: jest.fn(),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits', SELF_AUDIT_RUN: 'self_audit_run', GUARD_STRIKE: 'guard_strike' },
}));

// Plan board: actual module (so the 5ac56d81 dedupe helpers run for real
// against the in-memory store), getPlan mocked per-case.
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
  maxSteps: 4,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: true,
  planReminders: true,
  memorySource: 'coding',
};

const makeInput = (sessionId: string): AgentRunInput => ({
  worktree: '/tmp/self-audit-5ac56d81-test-does-not-exist',
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
  userMessage: 'check in on the drain',
  emit: jest.fn(),
});

const TURN = (content: string) => ({ content, reasoning: '', toolCalls: [], finishReason: 'stop' });

/** The ticket's plan shape: 4 completed, 6 blocked on an external multi-day drain. */
const blockedPlan = (note = 'waiting on the generation drain (261/14,053 records)') => ({
  goal: 're-add frontier-v1',
  acceptanceCriteria: ['sweep accepted'],
  steps: [
    { id: 1, text: 'scaffold the runner', status: 'completed' },
    { id: 2, text: 'wire the workers', status: 'completed' },
    { id: 3, text: 'seed the queue', status: 'completed' },
    { id: 4, text: 'start the drain', status: 'completed' },
    { id: 5, text: 'drain shard A', status: 'blocked', note },
    { id: 6, text: 'drain shard B', status: 'blocked', note },
    { id: 7, text: 'drain shard C', status: 'blocked', note },
    { id: 8, text: 'drain shard D', status: 'blocked', note },
    { id: 9, text: 'merge the sweep', status: 'blocked', note },
    { id: 10, text: 'accept the sweep', status: 'blocked', note },
  ],
  version: 7,
  updatedAt: '2026-09-18T10:00:00.000Z',
});

const selfAuditMetrics = () =>
  mockRecordLoopMetric.mock.calls.filter((c: any[]) => c[0]?.kind === 'self_audit_run');
/** Audit prompts visible in the LAST model turn of the run-slice from mock-call
 *  index `from` (mock.calls accumulate across runs within a test — always slice
 *  per run; the harness passes the LIVE messages array, so earlier turns alias
 *  later pushes — the last call is the canonical per-run message history). */
const auditMessagesFrom = (from: number) => {
  const calls = mockRunModelTurn.mock.calls.slice(from);
  if (!calls.length) return [];
  const lastMsgs = calls[calls.length - 1][1] as any[];
  return lastMsgs.filter((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[HARNESS SELF-AUDIT'));
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPlan.mockResolvedValue(null);
  _store.clear();
});

describe('ticket 5ac56d81 — self-audit false-premise loop replay', () => {
  it('REPLAY: a blocked-step plan gets ONE true-premise audit, and the next run with an unchanged plan SKIPS the repeat', async () => {
    mockGetPlan.mockResolvedValue(blockedPlan());

    // ── Run 1 (the first cadence tick): the audit fires ONCE with the TRUE
    // premise — never "You marked every plan step complete".
    const input1 = makeInput('sess-5ac56d81');
    mockRunModelTurn
      .mockResolvedValueOnce(TURN('drain progressing, nothing to do this tick.'))
      .mockResolvedValueOnce(TURN('Re-verified — completed work holds; blockers still real. Final summary.'));
    await runCodingAgent(input1);

    expect(selfAuditMetrics()).toHaveLength(1);
    expect(selfAuditMetrics()[0][0].meta).toMatchObject({ blockedSteps: 6 });
    const msgs1 = auditMessagesFrom(0);
    expect(msgs1).toHaveLength(1);
    // TRUE premise: names the real plan state + blesses the holding state.
    expect(msgs1[0].content).toContain('4 of 10 step(s) completed, 6 blocked');
    expect(msgs1[0].content).toContain('LEGITIMATE holding state');
    expect(msgs1[0].content).toContain('waiting on the generation drain');
    expect(msgs1[0].content).not.toContain('You marked every plan step complete');
    // The dedupe signature was persisted under the session's plan namespace.
    expect(_store.get('sess-5ac56d81/coding-plan::self-audit-sig')?.sig).toBeTruthy();

    // ── Run 2 (the NEXT cadence tick, plan UNCHANGED): no repeat audit — the
    // 14-identical-rejections loop dies here. One model turn, no audit
    // message, no second self_audit_run row, a visible skip progress line.
    const beforeRun2 = mockRunModelTurn.mock.calls.length;
    const input2 = makeInput('sess-5ac56d81');
    mockRunModelTurn.mockResolvedValueOnce(TURN('drain progressing, nothing to do this tick.'));
    await runCodingAgent(input2);

    expect(mockRunModelTurn).toHaveBeenCalledTimes(3); // 2 (run 1) + 1 (run 2)
    expect(selfAuditMetrics()).toHaveLength(1); // still ONE — no repeat
    expect(auditMessagesFrom(beforeRun2)).toHaveLength(0);
    expect((input2.emit as jest.Mock).mock.calls.some((c: any[]) =>
      c[0] === 'progress' && typeof c[1]?.message === 'string' && c[1].message.includes('Auto-audit skipped: plan unchanged'),
    )).toBe(true);
  });

  it('an ALL-COMPLETED plan keeps the original premise, fires once, and dedupes the repeat too', async () => {
    mockGetPlan.mockResolvedValue({
      goal: 'ship it', acceptanceCriteria: ['it works'],
      steps: [{ id: 1, text: 'the step', status: 'completed' }],
      version: 3, updatedAt: '2026-09-18T10:00:00.000Z',
    });

    const input1 = makeInput('sess-5ac56d81-all-done');
    mockRunModelTurn
      .mockResolvedValueOnce(TURN('All steps done.'))
      .mockResolvedValueOnce(TURN('Re-verified — final summary.'));
    await runCodingAgent(input1);

    expect(selfAuditMetrics()).toHaveLength(1);
    expect(selfAuditMetrics()[0][0].meta).toMatchObject({ blockedSteps: 0 });
    // Premise TRUE here — the original message is the correct one.
    expect(auditMessagesFrom(0)[0].content).toContain('You marked every plan step complete');

    const beforeRun2 = mockRunModelTurn.mock.calls.length;
    const input2 = makeInput('sess-5ac56d81-all-done');
    mockRunModelTurn.mockResolvedValueOnce(TURN('still done.'));
    await runCodingAgent(input2);
    expect(selfAuditMetrics()).toHaveLength(1); // unchanged plan ⇒ no repeat
    expect(auditMessagesFrom(beforeRun2)).toHaveLength(0);
  });

  it('a CHANGED plan re-fires the audit (dedupe is per plan STATE, not a permanent latch)', async () => {
    mockGetPlan.mockResolvedValue(blockedPlan());
    const input1 = makeInput('sess-5ac56d81-changed');
    mockRunModelTurn
      .mockResolvedValueOnce(TURN('tick one.'))
      .mockResolvedValueOnce(TURN('audited.'));
    await runCodingAgent(input1);
    expect(selfAuditMetrics()).toHaveLength(1);

    // A blocker cleared: step 5 finished → the plan sig changed → re-audit.
    const plan2 = blockedPlan();
    plan2.steps[4] = { id: 5, text: 'drain shard A', status: 'completed' };
    mockGetPlan.mockResolvedValue(plan2);
    const beforeRun2 = mockRunModelTurn.mock.calls.length;
    const input2 = makeInput('sess-5ac56d81-changed');
    mockRunModelTurn
      .mockResolvedValueOnce(TURN('tick two.'))
      .mockResolvedValueOnce(TURN('audited again.'));
    await runCodingAgent(input2);
    expect(selfAuditMetrics()).toHaveLength(2);
    expect(auditMessagesFrom(beforeRun2)[0].content).toContain('5 of 10 step(s) completed, 5 blocked');
  });

  it('a NOTE-ONLY plan edit (trajectory annotation) does NOT re-arm the audit — sig matches the goal-continue planSig definition', async () => {
    mockGetPlan.mockResolvedValue(blockedPlan('waiting on the generation drain (117/14,053 records)'));
    const input1 = makeInput('sess-5ac56d81-note');
    mockRunModelTurn
      .mockResolvedValueOnce(TURN('tick one.'))
      .mockResolvedValueOnce(TURN('audited.'));
    await runCodingAgent(input1);
    expect(selfAuditMetrics()).toHaveLength(1);

    // The lane annotates trajectory in the blocked-step notes each firing —
    // id:status:text unchanged ⇒ still the same plan STATE ⇒ skip.
    mockGetPlan.mockResolvedValue(blockedPlan('waiting on the generation drain (261/14,053 records)'));
    const input2 = makeInput('sess-5ac56d81-note');
    mockRunModelTurn.mockResolvedValueOnce(TURN('tick two.'));
    await runCodingAgent(input2);
    expect(selfAuditMetrics()).toHaveLength(1);
  });

  it('a dedupe-store read failure fails OPEN: the audit fires (pre-fix behavior), never breaks the run', async () => {
    mockGetPlan.mockResolvedValue(blockedPlan());
    mockStoreGet.mockRejectedValueOnce(new Error('context store down'));
    const input1 = makeInput('sess-5ac56d81-failopen');
    mockRunModelTurn
      .mockResolvedValueOnce(TURN('tick one.'))
      .mockResolvedValueOnce(TURN('audited.'));
    const result = await runCodingAgent(input1);
    expect(selfAuditMetrics()).toHaveLength(1);
    expect(result.finalText).toContain('audited');
  });
});

/**
 * Verify-stop reflection parity (2026-09-10 adversarial review): the auto-verify
 * loop's same-failureSignature stop is the verify lane's derail breaker — when
 * it fires, the run must consult the cross-checker seat (advice rides the
 * final; capped by the shared per-run reflection counter) AND file the deduped
 * framework-vs-model attribution ticket, exactly like the tool-streak breaker.
 * The OTHER stop reasons (no code changed / oscillation) stay reflection-free:
 * they indict the fix loop's motion, not a recurring deterministic signature.
 *
 * Scaffold mirrors sched-provider-fail.test.ts (the REAL agentLoop with the
 * model turn + IO-boundary services stubbed); verify.service is mocked to a
 * deterministic failing chain.
 */

jest.setTimeout(60_000);

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// config/env calls process.exit(1) without env vars and kills the jest worker at
// import (agent → tools → platform-tools → platform.service reaches it).
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));

const mockRunModelTurn = jest.fn();
jest.mock('./coding-model', () => ({
  ...(jest.requireActual('./coding-model')),
  seatUnservableReason: async () => null,
  runModelTurn: (...a: any[]) => mockRunModelTurn(...a),
}));
jest.mock('./coding-memory.service', () => ({
  __esModule: true,
  getUserCodingMemory: jest.fn(async () => null),
  getProjectMemory: jest.fn(async () => null),
  getSessionMemory: jest.fn(async () => null),
  formatCodingMemoryBlock: jest.fn(() => ''),
  updateCodingMemoryAsync: jest.fn(),
}));
jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
jest.mock('./run-receipts.service', () => ({ __esModule: true, recordRunReceiptAsync: jest.fn() }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ""),
}));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => 'tok') }));
jest.mock('./container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => null),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({
  __esModule: true,
  gatherSessionCredentialEnv: jest.fn(async () => ({})),
  credentialEnvNote: jest.fn(() => ''),
}));
jest.mock('./plan.service', () => ({
  __esModule: true,
  getPlan: jest.fn(async () => null),
  getPlanStrict: jest.fn(async () => null),
  applyPlan: jest.fn(),
  planToUpdate: jest.fn(),
  renderPlanReminder: jest.fn(() => ''),
}));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn(), buildCodeMatchesBlock: jest.fn(async () => '') }));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0), buildSessionMemoryInventory: jest.fn(async () => '') }));
jest.mock('./verify-state', () => ({
  __esModule: true,
  recordVerify: jest.fn(async () => {}),
  captureVerifyFingerprint: jest.fn(async () => null),
}));
jest.mock('./usage-store', () => ({
  __esModule: true,
  loadSessionUsage: jest.fn(async () => ({})),
  commitRunUsage: jest.fn(async (_s: string, snap: any) => snap),
  mergeRunIntoSession: jest.fn((_prior: any, snap: any) => snap),
  emptySessionUsage: jest.fn(() => ({})),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', PROVIDER_REJECTED: 'provider_rejected', SELF_AUDIT_RUN: 'self_audit_run' },
}));

// The verify chain: one 'test' stage that always fails with the same tail; the
// failure signature is pinned constant so the same-signature stop is the ONLY
// variable under test (loop knobs are per-test via mockLoopCfg).
const FAILING_STAGE = {
  key: 'test', command: 'jest', exitCode: 1, passed: false,
  outputTail: 'FAIL src/x.test.ts — expected 1 got 2',
};
const mockRunVerifyChain: jest.Mock = jest.fn(async (..._a: any[]) => ({
  passed: false, ran: true, failedStage: 'test', unverified: false, stages: [{ ...FAILING_STAGE }],
}));
const mockLoopCfg = {
  maxAutoContinueRounds: 0, maxAutoVerifyIterations: 2, resumeStepBudget: 30,
  sameFailureStop: 1, oscillationWindow: 5, perCommandTimeoutMs: 1000,
};
jest.mock('./verify.service', () => ({
  __esModule: true,
  readDigbyConfig: jest.fn(async () => null),
  // DW-2 (FO f118): agent.ts's auto-verify re-read uses the DETAILED reader.
  readDigbyConfigDetailed: jest.fn(async () => ({ absent: true as const })),
  resolveVerifyChain: jest.fn(() => [{ key: 'test', command: 'jest' }]),
  runVerifyChain: (...a: any[]) => mockRunVerifyChain(...a),
  loopConfig: jest.fn(() => ({ ...mockLoopCfg })),
  failureSignature: jest.fn(() => 'SIG-1'),
  renderVerifyFeedback: jest.fn(() => '[HARNESS VERIFY FEEDBACK] test failing'),
}));

// Reflection seam under test — cap mutable per test (the agent reads it via
// dynamic import, which resolves to this same object).
const mockReflection = {
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: jest.fn(async (..._a: any[]): Promise<string | null> => 'ADVICE: the fixture clock is frozen — advance it before asserting.'),
  fileStreakInvestigation: jest.fn(async (..._a: any[]): Promise<void> => undefined),
};
jest.mock('./reflection', () => mockReflection);

jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  ...(jest.requireActual('../feedback/feedback.service')),
  fileFeedbackTicket: jest.fn(async () => ({})),
}));

// Integration wrapper modules pulled in transitively via tools → platform-tools
// (same base set as sched-provider-fail.test.ts — they must never load for real).
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

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';

const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const baseInput = (): AgentRunInput => ({
  worktree: '/tmp/wt-verify-reflection-nonexistent',
  sessionId: 's-verify-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'proj',
  branch: 'digby/x',
  history: [],
  userMessage: 'fix the flaky suite',
  emit: jest.fn(),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRunModelTurn.mockResolvedValue(FINAL);
  mockRunVerifyChain.mockResolvedValue({
    passed: false, ran: true, failedStage: 'test', unverified: false, stages: [{ ...FAILING_STAGE }],
  });
  mockReflection.REFLECTION_MAX_PER_RUN = 2;
  mockReflection.consultCrossCheckerOnStreak.mockResolvedValue('ADVICE: the fixture clock is frozen — advance it before asserting.');
});

describe('verify same-signature stop parity (2026-09-10)', () => {
  it('the same-signature stop consults the cross-checker (advice rides the final) AND files the attribution ticket', async () => {
    // sameFailureStop 1 ⇒ the first failing verify already stops on signature.
    mockLoopCfg.sameFailureStop = 1;
    const result = await runCodingAgent(baseInput());

    expect(result.finalText).toContain('Auto-verify stopped: the same "test" failure recurred');
    // The consult ran once and its advice rides the FINAL (the run is stopping).
    expect(mockReflection.consultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(result.finalText).toContain('[CROSS-CHECK REFLECTION');
    expect(result.finalText).toContain('the fixture clock is frozen');
    // The attribution ticket carries the signature + stage + failing tail.
    expect(mockReflection.fileStreakInvestigation).toHaveBeenCalledTimes(1);
    const evidence = mockReflection.fileStreakInvestigation.mock.calls[0][0];
    expect(evidence).toMatchObject({ sessionId: 's-verify-1', tool: 'verify', perma: false });
    expect(evidence.recentFailures[0]).toContain('SIG-1');
    expect(evidence.recentFailures[0]).toContain('test');
    expect(evidence.recentFailures.join('\n')).toContain('expected 1 got 2');
  });

  it('the consult respects the shared per-run cap (ticket still filed; no advice in the final)', async () => {
    mockLoopCfg.sameFailureStop = 1;
    mockReflection.REFLECTION_MAX_PER_RUN = 0; // cap already spent
    const result = await runCodingAgent(baseInput());

    expect(mockReflection.consultCrossCheckerOnStreak).not.toHaveBeenCalled();
    expect(mockReflection.fileStreakInvestigation).toHaveBeenCalledTimes(1); // attribution never gated by the consult cap
    expect(result.finalText).toContain('Auto-verify stopped');
    expect(result.finalText).not.toContain('[CROSS-CHECK REFLECTION');
  });

  it('a consult failure is fail-open: the honest stop still lands, with the ticket', async () => {
    mockLoopCfg.sameFailureStop = 1;
    mockReflection.consultCrossCheckerOnStreak.mockRejectedValueOnce(new Error('seat down'));
    const result = await runCodingAgent(baseInput());

    expect(result.finalText).toContain('Auto-verify stopped: the same "test" failure recurred');
    expect(result.finalText).not.toContain('[CROSS-CHECK REFLECTION');
    expect(mockReflection.fileStreakInvestigation).toHaveBeenCalledTimes(1);
  });

  it('the OTHER stop reasons (no code changed) stay reflection-free', async () => {
    // sameFailureStop 5 ⇒ iteration 1 resumes with feedback; iteration 2 stops
    // on the unchanged diff hash BEFORE the signature count matters.
    mockLoopCfg.sameFailureStop = 5;
    const result = await runCodingAgent(baseInput());

    expect(result.finalText).toContain('Auto-verify stopped: no code changed since the last verify');
    expect(mockReflection.consultCrossCheckerOnStreak).not.toHaveBeenCalled();
    expect(mockReflection.fileStreakInvestigation).not.toHaveBeenCalled();
  });
});

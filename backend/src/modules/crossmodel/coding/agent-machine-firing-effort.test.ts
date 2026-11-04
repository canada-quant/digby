/**
 * A4 (2026-10-04 coding quick wins — machine-firing-effort.ts): the agent seam
 * of the machine-firing effort step-down.
 *
 * Pins: AgentRunInput.machineFiringEffort {cap:'high'} lowers the LEAD seat's
 * reasoning_effort on the request the model actually receives (a built-in
 * GLM-5.3 seat: max → high) and stamps run_spend with {reasoningEffort,
 * effortReason}; {cap:null} keeps max and stamps the baseline; a seat that
 * sends no effort (Kimi K3) is left alone and stamps 'default'; no field ⇒ the
 * request and the run_spend stamp are exactly today's.
 *
 * Scaffold: agent-verify-absent.test.ts (REAL agentLoop, model turn + IO-
 * boundary services stubbed).
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
const mockRecordVerifyAbsent: jest.Mock = jest.fn(async () => {});
jest.mock('./verify-state', () => ({
  __esModule: true,
  ...(jest.requireActual('./verify-state')), // keeps the REAL verifyAbsentTelemetryDisabled (env kill switch under test)
  recordVerify: jest.fn(async () => {}),
  getVerifyState: jest.fn(async () => null),
  captureVerifyFingerprint: jest.fn(async () => null),
  recordVerifyAbsent: (...a: any[]) => mockRecordVerifyAbsent(...a),
}));
jest.mock('./usage-store', () => ({
  __esModule: true,
  loadSessionUsage: jest.fn(async () => ({})),
  commitRunUsage: jest.fn(async (_s: string, snap: any) => snap),
  mergeRunIntoSession: jest.fn((_prior: any, snap: any) => snap),
  emptySessionUsage: jest.fn(() => ({})),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
const mockRecordRunSpend: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: (...a: any[]) => mockRecordRunSpend(...a),
  noteSeatFallback: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', PROVIDER_REJECTED: 'provider_rejected', SELF_AUDIT_RUN: 'self_audit_run', VERIFY_ABSENT: 'verify_absent' },
}));


// verify-state's real module (kept for the kill-switch reader) imports the
// context store — stub it so nothing reaches Prisma.
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
  storeDelete: jest.fn(async () => {}),
}));

// The verify chain resolves EMPTY (no .digby/config.json / no runnable command)
// through the REAL resolveVerifyChain; runVerifyChain must never be reached.
const mockReadDigbyConfig: jest.Mock = jest.fn(async () => null);
const mockRunVerifyChain: jest.Mock = jest.fn(async () => { throw new Error('runVerifyChain must not run without a chain'); });
const mockLoopCfg = {
  maxAutoContinueRounds: 0, maxAutoVerifyIterations: 2, resumeStepBudget: 30,
  sameFailureStop: 3, oscillationWindow: 5, perCommandTimeoutMs: 1000,
};
jest.mock('./verify.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./verify.service')),
  readDigbyConfig: (...a: any[]) => mockReadDigbyConfig(...a),
  // DW-2 (FO f118): agent.ts's auto-verify re-read now uses the DETAILED
  // reader — route it through the same mock so mid-run config fixtures
  // (created/fixed by the lane under test) stay visible to the seam.
  readDigbyConfigDetailed: (...a: any[]) => Promise.resolve(mockReadDigbyConfig(...a)).then(c => (c ? { config: c } : { absent: true as const })),
  runVerifyChain: (...a: any[]) => mockRunVerifyChain(...a),
  loopConfig: jest.fn(() => ({ ...mockLoopCfg })),
}));
jest.mock('./verify-limiter', () => ({
  __esModule: true,
  withVerifySlot: jest.fn(async (fn: () => Promise<any>) => fn()),
}));
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => true),
  REFLECTION_MAX_PER_RUN: 0,
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  fileStreakInvestigation: jest.fn(async () => undefined),
}));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  ...(jest.requireActual('../feedback/feedback.service')),
  fileFeedbackTicket: jest.fn(async () => ({})),
}));

// Integration wrapper modules pulled in transitively via tools → platform-tools
// (same base set as agent-verify-reflection.test.ts — they must never load for real).
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
const baseInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree: '/tmp/wt-machine-effort-nonexistent',
  sessionId: 's-mfe-1',
  runId: 'run-mfe-1',
  projectId: 'p-mfe',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.3',
  projectName: 'mfe',
  branch: 'digby/x',
  history: [],
  userMessage: '[MACHINE-TRIGGERED RUN — schedule abc] tick',
  machineTriggered: true,
  emit: jest.fn(),
  ...over,
});
/** The provider the FIRST model turn was sent on (runModelTurn(provider, messages, …)). */
const firstProvider = () => mockRunModelTurn.mock.calls[0][0] as { model: string; extra?: Record<string, any> };
const spendStamp = () => mockRecordRunSpend.mock.calls[0][3] as Record<string, any>;

beforeEach(() => {
  jest.clearAllMocks();
  mockReadDigbyConfig.mockResolvedValue(null);
  mockRunModelTurn.mockResolvedValue(FINAL);
});

describe('A4: machine-firing effort step-down at the agent seam (2026-10-04)', () => {
  it('cap high on a built-in GLM-5.3 lead: the model receives reasoning_effort high; run_spend stamps effort + reason', async () => {
    await runCodingAgent(baseInput({ machineFiringEffort: { cap: 'high', reason: 'all_complete_board' } }));
    expect(firstProvider().model).toBe('glm-5.3');
    expect(firstProvider().extra?.reasoning_effort).toBe('high');
    expect(mockRecordRunSpend).toHaveBeenCalledTimes(1);
    expect(spendStamp()).toMatchObject({ reasoningEffort: 'high', effortReason: 'all_complete_board' });
  });

  it('cap null (an open board): max is kept and the baseline is stamped', async () => {
    await runCodingAgent(baseInput({ machineFiringEffort: { cap: null, reason: 'board_open' } }));
    expect(firstProvider().extra?.reasoning_effort).toBe('max');
    expect(spendStamp()).toMatchObject({ reasoningEffort: 'max', effortReason: 'board_open' });
  });

  it('a seat that sends no effort (Kimi K3) is left alone — stamped "default"', async () => {
    await runCodingAgent(baseInput({ model: 'kimi-k3', machineFiringEffort: { cap: 'high', reason: 'all_complete_board' } }));
    expect(firstProvider().extra).not.toHaveProperty('reasoning_effort');
    expect(spendStamp()).toMatchObject({ reasoningEffort: 'default', effortReason: 'all_complete_board' });
  });

  it('a caller providerExtra still merges, and the cap applies on top of it (lower-only)', async () => {
    await runCodingAgent(baseInput({ providerExtra: { temperature: 0.2 }, machineFiringEffort: { cap: 'high', reason: 'all_complete_board' } }));
    expect(firstProvider().extra).toMatchObject({ temperature: 0.2, reasoning_effort: 'high' });
  });

  it('no field (a human turn / the kill switch): today\'s request and run_spend stamp', async () => {
    await runCodingAgent(baseInput({ machineTriggered: undefined, userMessage: 'please tidy the README' }));
    expect(firstProvider().extra?.reasoning_effort).toBe('max');
    expect(spendStamp()).not.toHaveProperty('reasoningEffort');
    expect(spendStamp()).not.toHaveProperty('effortReason');
  });
});

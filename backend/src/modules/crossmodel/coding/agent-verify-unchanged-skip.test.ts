/**
 * A1 (2026-10-04 coding quick wins — verify-unchanged-skip.ts): the harness
 * auto-verify SKIPS the chain when the worktree content is unchanged since this
 * session's last GREEN verify of the same chain.
 *
 * Pins:
 *  - a green record of THIS chain (chainSig) whose tree equals the tree now ⇒
 *    no chain run, no verify_start / verify_result, no recordVerify (the
 *    earlier green stays the record of evidence), ONE verify_skipped
 *    {reason:'unchanged_since_green'} event, the honest transcript line (never
 *    the green "Auto-verify passed" check) and ONE verify_unchanged_skip row;
 *  - a different tree, a subset / other-chain signature, a legacy record with
 *    no chainSig, a hollow (unverified / deferred) pass, a red, or a capture
 *    failure ⇒ the chain runs exactly as before;
 *  - a chain that runs records chainSig + stages (the skip key);
 *  - AUTO_VERIFY_UNCHANGED_SKIP_DISABLED=1 ⇒ the chain runs and no chainSig /
 *    stages are written (today's record shape).
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
const mockRecordVerify: jest.Mock = jest.fn(async () => {});
const mockGetVerifyState: jest.Mock = jest.fn(async () => null);
const mockCaptureWorktreeTree: jest.Mock = jest.fn(async () => null);
jest.mock('./verify-state', () => ({
  __esModule: true,
  ...(jest.requireActual('./verify-state')),
  recordVerify: (...a: any[]) => mockRecordVerify(...a),
  getVerifyState: (...a: any[]) => mockGetVerifyState(...a),
  captureVerifyFingerprint: jest.fn(async () => ({ sha: 'sha-now', tree: 'tree-now' })),
  captureWorktreeTree: (...a: any[]) => mockCaptureWorktreeTree(...a),
  readHeadSha: jest.fn(async () => null),
  recordVerifyAbsent: jest.fn(async () => {}),
}));
jest.mock('./usage-store', () => ({
  __esModule: true,
  loadSessionUsage: jest.fn(async () => ({})),
  commitRunUsage: jest.fn(async (_s: string, snap: any) => snap),
  mergeRunIntoSession: jest.fn((_prior: any, snap: any) => snap),
  emptySessionUsage: jest.fn(() => ({})),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  noteSeatFallback: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', PROVIDER_REJECTED: 'provider_rejected', SELF_AUDIT_RUN: 'self_audit_run', VERIFY_ABSENT: 'verify_absent', VERIFY_UNCHANGED_SKIP: 'verify_unchanged_skip' },
}));


// verify-state's real module (kept for the kill-switch reader) imports the
// context store — stub it so nothing reaches Prisma.
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
  storeDelete: jest.fn(async () => {}),
}));

// The verify chain resolves through the REAL resolveVerifyChain from the
// mocked config (typecheck + test); runVerifyChain is the chain itself.
const mockReadDigbyConfig: jest.Mock = jest.fn(async () => null);
const mockRunVerifyChain: jest.Mock = jest.fn(async () => GREEN_TWO);
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
import { verifyChainSignature } from './verify-unchanged-skip';

const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const GREEN_TWO = { passed: true, ran: true, unverified: false, stages: [
  { key: 'typecheck', command: 'tsc --noEmit', exitCode: 0, passed: true, outputTail: '' },
  { key: 'test', command: 'jest', exitCode: 0, passed: true, outputTail: '' },
] };
const CONFIG = { commands: { typecheck: 'tsc --noEmit', test: 'jest' } };
const CHAIN = [{ key: 'typecheck', command: 'tsc --noEmit' }, { key: 'test', command: 'jest' }];
const SIG = verifyChainSignature(CHAIN);
const GREEN_RECORD = { passed: true, at: '2026-10-03T22:15:00.000Z', sha: 'abc123def4567890', tree: 'tree-green', chainSig: SIG, stages: ['typecheck', 'test'] };

const emitted: Array<{ type: string; data: any }> = [];
const baseInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree: '/tmp/wt-verify-unchanged-nonexistent',
  sessionId: 's-vu-1',
  runId: 'run-vu-1',
  projectId: 'p-vu',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'vu',
  branch: 'digby/x',
  history: [],
  userMessage: 'check the board and report',
  emit: jest.fn((type: string, data: any) => { emitted.push({ type, data }); }),
  ...over,
});

const skipRows = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'verify_unchanged_skip');

beforeEach(() => {
  jest.clearAllMocks();
  emitted.length = 0;
  delete process.env.AUTO_VERIFY_UNCHANGED_SKIP_DISABLED;
  mockReadDigbyConfig.mockResolvedValue(CONFIG);
  mockRunModelTurn.mockResolvedValue(FINAL);
  mockRunVerifyChain.mockImplementation(async () => GREEN_TWO);
  mockGetVerifyState.mockResolvedValue({ ...GREEN_RECORD });
  mockCaptureWorktreeTree.mockResolvedValue('tree-green');
});
afterAll(() => { delete process.env.AUTO_VERIFY_UNCHANGED_SKIP_DISABLED; });

describe('A1: auto-verify skips an unchanged tree after a green of the same chain (2026-10-04)', () => {
  it('unchanged since the last green: no chain, no verify_start/result, no new record — an honest skip event, line and row', async () => {
    const result = await runCodingAgent(baseInput());

    expect(result.finalText).toBe('Done.');
    expect(mockRunVerifyChain).not.toHaveBeenCalled();
    expect(mockRecordVerify).not.toHaveBeenCalled(); // the earlier green stays the record of evidence
    expect(mockCaptureWorktreeTree).toHaveBeenCalledWith('/tmp/wt-verify-unchanged-nonexistent');
    expect(emitted.find(e => e.type === 'verify_start')).toBeUndefined();
    expect(emitted.find(e => e.type === 'verify_result')).toBeUndefined();

    const skipped = emitted.filter(e => e.type === 'verify_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].data).toEqual({ reason: 'unchanged_since_green', auto: true, lastGreenAt: GREEN_RECORD.at, lastGreenSha: GREEN_RECORD.sha, stages: ['typecheck', 'test'] });

    // The transcript line names the EARLIER green — never the "✓ Auto-verify passed" check.
    const texts = result.parts.filter((p: any) => p.type === 'text').map((p: any) => String(p.text));
    expect(texts.some(t => /Auto-verify passed/.test(t))).toBe(false);
    const line = texts.find(t => /Auto-verify skipped/.test(t));
    expect(line).toContain("unchanged since this session's last GREEN verify (typecheck, test at 2026-10-03T22:15Z on abc123def456)");
    expect(line).toContain('The chain did not run this time');

    const rows = skipRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: 's-vu-1', runId: 'run-vu-1',
      meta: { seam: 'auto', reason: 'unchanged_since_green', stages: ['typecheck', 'test'], lastGreenAt: GREEN_RECORD.at, lastGreenSha: GREEN_RECORD.sha, autoVerifyIters: 0 },
    });
    expect(typeof rows[0].meta.captureMs).toBe('number');
  });

  it('the tree CHANGED since the green: the chain runs and records chainSig + stages (the skip key for next time)', async () => {
    mockCaptureWorktreeTree.mockResolvedValue('tree-edited');
    await runCodingAgent(baseInput());

    expect(mockRunVerifyChain).toHaveBeenCalledTimes(1);
    expect(emitted.find(e => e.type === 'verify_skipped')).toBeUndefined();
    expect(skipRows()).toHaveLength(0);
    expect(mockRecordVerify).toHaveBeenCalledTimes(1);
    const [, passed, , extra] = mockRecordVerify.mock.calls[0];
    expect(passed).toBe(true);
    expect(extra).toMatchObject({ chainSig: SIG, stages: ['typecheck', 'test'] });
  });

  it.each([
    ['a subset / other-chain signature (verify({only:[lint]}) pass)', { chainSig: verifyChainSignature([{ key: 'typecheck', command: 'tsc --noEmit' }]) }],
    ['a legacy record with no chainSig', { chainSig: undefined }],
    ['a hollow pass (stage tool missing)', { unverified: true }],
    ['a DEFERRED pass (memory pressure)', { deferred: true }],
    ['a red', { passed: false, failedStage: 'test' }],
    ['a record without a tree', { tree: null }],
  ])('%s never skips — the chain runs', async (_label, over) => {
    mockGetVerifyState.mockResolvedValue({ ...GREEN_RECORD, ...over });
    await runCodingAgent(baseInput());
    expect(mockRunVerifyChain).toHaveBeenCalledTimes(1);
    expect(emitted.find(e => e.type === 'verify_skipped')).toBeUndefined();
    expect(skipRows()).toHaveLength(0);
  });

  it('fail-open: a capture failure (null tree) or a throwing state read runs the chain', async () => {
    mockCaptureWorktreeTree.mockResolvedValue(null);
    await runCodingAgent(baseInput());
    expect(mockRunVerifyChain).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    emitted.length = 0;
    mockRunVerifyChain.mockImplementation(async () => GREEN_TWO);
    mockRunModelTurn.mockResolvedValue(FINAL);
    mockReadDigbyConfig.mockResolvedValue(CONFIG);
    mockGetVerifyState.mockRejectedValue(new Error('store down'));
    await runCodingAgent(baseInput());
    expect(mockRunVerifyChain).toHaveBeenCalledTimes(1);
    expect(skipRows()).toHaveLength(0);
  });

  it('AUTO_VERIFY_UNCHANGED_SKIP_DISABLED=1: today\'s behaviour — the chain runs on an unchanged tree, no state read for the skip, no chainSig / stages written', async () => {
    process.env.AUTO_VERIFY_UNCHANGED_SKIP_DISABLED = '1';
    const result = await runCodingAgent(baseInput());

    expect(mockRunVerifyChain).toHaveBeenCalledTimes(1);
    expect(mockCaptureWorktreeTree).not.toHaveBeenCalled();
    expect(emitted.find(e => e.type === 'verify_skipped')).toBeUndefined();
    expect(skipRows()).toHaveLength(0);
    expect(result.parts.some((p: any) => p.type === 'text' && /Auto-verify passed \(typecheck, test\)/.test(String(p.text)))).toBe(true);
    const extra = mockRecordVerify.mock.calls[0][3];
    expect(extra).not.toHaveProperty('chainSig');
    expect(extra).not.toHaveProperty('stages');
    expect(Object.keys(extra).sort()).toEqual(['deferred', 'fingerprint', 'unverified']);
  });
});

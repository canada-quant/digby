/**
 * REPLAY TEST — tt-rd audit 2026-09-27, self-audit churn (findings 1/2/3/6).
 *
 * WHAT HAPPENED (14 d of prod, verified in the audit): lane ddd26be0 took the
 * harness [HARNESS SELF-AUDIT] round on 224 of 244 runs even though its own
 * plan ended in a "Self-audit fresh re-probes; final answer" step — the
 * 2026-09-18 dedupe (ticket 5ac56d81) never matched because its signature
 * embedded the step TEXT and the lane's text carried firing / window ids
 * (F186 → F187) that changed every tick. The only skip mechanism was the Jev
 * self_audit purpose (shadow, AUROC 0.232), so the round ran on ~100 % of
 * eligible finishes; the prompt ordered "re-read/re-run … each acceptance
 * criterion" with no receipt exemption, and the skip left no telemetry row.
 *
 * FIX PINNED HERE (coding/self-audit-receipt-rule.ts + agent.ts):
 *   1. DUPLICATE STEP: a completed lane-authored self-audit step + ≥1 ok
 *      evidence receipt this run ⇒ the harness round is skipped (row
 *      self_audit_skip reason 'duplicate_step'). Kill switch restores it.
 *   2. TEXT-INSENSITIVE SIG: "F186" → "F187" on an otherwise unchanged plan
 *      dedupes (reason 'plan_unchanged' — now a telemetry row, finding 6).
 *   3. RECEIPT RULE: shadow by default (recorded on the self_audit_run row);
 *      act skips except a 1-in-10 control sample that runs with control:true
 *      and writes a self_audit_control row after the round.
 *   4. PROMPT v2: "ONLY audit this firing … CITE that receipt … ONE cheap
 *      check … TERMINAL" (kill switch restores the 2026-09-18 wording).
 *   5. selfAuditRoundId rides every self_audit_* row AND run_spend.
 *
 * Scaffold: agent-self-audit.5ac56d81.test.ts (real agent loop, in-memory
 * context store, requireActual plan.service).
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
  return { ...actual, seatUnservableReason: async () => null, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

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
// The receipt rule reads the session's last verify: none recorded (the
// backtest's "absent counts as OK"); the fingerprint capture is never reached.
const mockGetVerifyState: jest.Mock = jest.fn(async () => null);
// Fixer 2026-09-27 (finding 4): the receipt rule reads the tree through the
// side-effect-free captureWorktreeTree (act only) and the HEAD sha through
// readHeadSha (shadow) — never captureVerifyFingerprint (which consumes the
// chain's parked infra-red verdict).
const mockCaptureWorktreeTree: jest.Mock = jest.fn(async () => null);
const mockReadHeadSha: jest.Mock = jest.fn(async () => null);
const mockCaptureVerifyFingerprint: jest.Mock = jest.fn(async () => null);
jest.mock('./verify-state', () => ({
  __esModule: true,
  recordVerify: jest.fn(async () => {}),
  getVerifyState: (...a: any[]) => mockGetVerifyState(...a),
  captureVerifyFingerprint: (...a: any[]) => mockCaptureVerifyFingerprint(...a),
  captureWorktreeTree: (...a: any[]) => mockCaptureWorktreeTree(...a),
  readHeadSha: (...a: any[]) => mockReadHeadSha(...a),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
const mockRecordRunSpend: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordRunSpend: (...a: any[]) => mockRecordRunSpend(...a),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    SELF_AUDIT_RUN: 'self_audit_run', SELF_AUDIT_SKIP: 'self_audit_skip', SELF_AUDIT_CONTROL: 'self_audit_control', SELF_AUDIT_SHADOW: 'self_audit_shadow', GUARD_STRIKE: 'guard_strike',
  },
}));

const mockGetPlan: jest.Mock = jest.fn(async () => null);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlan: (...a: any[]) => mockGetPlan(...a),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import type { ToolReceipt } from './run-receipts';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 4,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: true,
  planReminders: true,
  memorySource: 'coding',
};

const makeInput = (sessionId: string, extra: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree: '/tmp/self-audit-churn-test-does-not-exist',
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
  userMessage: 'Scheduled firing: keep the speed mission moving',
  emit: jest.fn(),
  ...extra,
});

const TURN = (content: string) => ({ content, reasoning: '', toolCalls: [], finishReason: 'stop' });
const okReceipt = (over: Partial<ToolReceipt>): ToolReceipt => ({
  id: 'r-0000-0001', chatId: 's', runId: null, tool: 'run_command', ok: true, ids: {}, inputHash: null, outputHash: null, createdAt: new Date(), ...over,
});

/** The tt-rd shape: real steps + the lane's OWN trailing self-audit step, all completed. */
const ttrdPlan = (auditText: string) => ({
  goal: 'node-a speed mission — bisect the phantom token in the async patch',
  acceptanceCriteria: ['probe_speed.py client-visible tok/s recorded'],
  steps: [
    { id: 1, text: 'Edit src/speed/sched.py (L-HT1zd)', status: 'completed' },
    { id: 2, text: 'Push the branch', status: 'completed' },
    { id: 7, text: auditText, status: 'completed' },
  ],
  version: 1484,
  updatedAt: '2026-09-27T17:09:00.000Z',
});
/** Receipts that JOIN every step above (write_file by noun, git_push by kind, run_command for the probe). */
const ttrdReceipts = (): ToolReceipt[] => [
  okReceipt({ id: 'r-edit-0001', tool: 'write_file', argsHead: '{"path":"src/speed/sched.py"}' }),
  okReceipt({ id: 'r-push-0002', tool: 'git_push', resultHead: 'pushed' }),
  okReceipt({ id: 'r-probe-003', tool: 'run_command', argsHead: 'python probe_speed.py', resultHead: '5.08 tok/s' }),
];

const rowsOf = (kind: string) => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === kind);
const auditMessagesFrom = (from: number) => {
  const calls = mockRunModelTurn.mock.calls.slice(from);
  if (!calls.length) return [];
  const lastMsgs = calls[calls.length - 1][1] as any[];
  return lastMsgs.filter((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[HARNESS SELF-AUDIT'));
};

const ENV = ['SELF_AUDIT_RECEIPT_RULE_MODE'] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of ENV) savedEnv[k] = process.env[k]; });
beforeEach(() => {
  jest.clearAllMocks();
  mockGetPlan.mockResolvedValue(null);
  mockGetVerifyState.mockResolvedValue(null);
  mockCaptureWorktreeTree.mockResolvedValue(null);
  mockReadHeadSha.mockResolvedValue(null);
  _store.clear();
  for (const k of ENV) delete process.env[k];
});
afterAll(() => { for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });

describe('tt-rd audit 2026-09-27 — self-audit churn replay (agent loop)', () => {
  it('REPLAY finding 1: the lane\'s OWN completed self-audit step + evidence receipts ⇒ the harness round is SKIPPED (duplicate_step row, sig recorded, one model turn)', async () => {
    mockGetPlan.mockResolvedValue(ttrdPlan('Self-audit fresh re-probes; final answer (F186, L-HT1zd)'));
    const input = makeInput('sess-churn-dup', { receipts: ttrdReceipts() });
    mockRunModelTurn.mockResolvedValueOnce(TURN('Final: 5.08 tok/s client-visible; bisect narrowed to L-HT1zd.'));
    await runCodingAgent(input);

    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
    expect(auditMessagesFrom(0)).toHaveLength(0);
    expect(rowsOf('self_audit_run')).toHaveLength(0);
    const skips = rowsOf('self_audit_skip');
    expect(skips).toHaveLength(1);
    expect(skips[0].meta).toMatchObject({ reason: 'duplicate_step', stepId: '7', receipts: 3, steps: 3, blockedSteps: 0 });
    expect(typeof skips[0].stamp?.selfAuditRoundId).toBe('string');
    expect(_store.get('sess-churn-dup/coding-plan::self-audit-sig')?.sig).toBeTruthy();
    expect((input.emit as jest.Mock).mock.calls.some((c: any[]) => c[0] === 'progress' && String(c[1]?.message).includes('the plan’s own self-audit step #7 already completed'))).toBe(true);
    // The run_spend row carries the same round id (finding 6: joinable on EVERY round).
    expect(mockRecordRunSpend).toHaveBeenCalledTimes(1);
    expect(mockRecordRunSpend.mock.calls[0][3]?.selfAuditRoundId).toBe(skips[0].stamp.selfAuditRoundId);
  });

  it('finding 1: a receipt-less "audit" step never skips the harness round', async () => {
    mockGetPlan.mockResolvedValue(ttrdPlan('Self-audit fresh re-probes; final answer'));
    mockRunModelTurn.mockResolvedValueOnce(TURN('done.')).mockResolvedValueOnce(TURN('audited.'));
    await runCodingAgent(makeInput('sess-churn-dup-noreceipt', { receipts: [] }));
    expect(rowsOf('self_audit_run')).toHaveLength(1);
    expect(rowsOf('self_audit_skip')).toHaveLength(0);
  });

  it('REPLAY finding 1b: the dedupe signature ignores step TEXT — "F186" → "F187" on the next firing dedupes (plan_unchanged row)', async () => {
    // No lane audit step this time (so the harness round is the one that runs); no joining receipts.
    const plan = (tag: string) => ({ ...ttrdPlan('x'), steps: [{ id: 1, text: `Bisect layer ${tag}`, status: 'completed' }] });
    mockGetPlan.mockResolvedValue(plan('F186'));
    mockRunModelTurn.mockResolvedValueOnce(TURN('tick one.')).mockResolvedValueOnce(TURN('audited.'));
    await runCodingAgent(makeInput('sess-churn-sig'));
    expect(rowsOf('self_audit_run')).toHaveLength(1);

    mockGetPlan.mockResolvedValue(plan('F187'));
    const before = mockRunModelTurn.mock.calls.length;
    mockRunModelTurn.mockResolvedValueOnce(TURN('tick two.'));
    await runCodingAgent(makeInput('sess-churn-sig'));
    expect(rowsOf('self_audit_run')).toHaveLength(1);
    expect(auditMessagesFrom(before)).toHaveLength(0);
    const skips = rowsOf('self_audit_skip');
    expect(skips).toHaveLength(1);
    expect(skips[0].meta).toMatchObject({ reason: 'plan_unchanged', steps: 1 });
  });

  it('finding 2 (shadow, default): the receipt rule is EVALUATED and recorded on the self_audit_run row but the round still runs; the prompt is v2', async () => {
    mockGetPlan.mockResolvedValue({ ...ttrdPlan('x'), steps: ttrdPlan('x').steps.slice(0, 2) }); // no lane audit step
    mockRunModelTurn.mockResolvedValueOnce(TURN('done.')).mockResolvedValueOnce(TURN('audited.'));
    await runCodingAgent(makeInput('sess-churn-shadow', { receipts: ttrdReceipts(), runId: 'run-0000-0001' }));
    const runs = rowsOf('self_audit_run');
    expect(runs).toHaveLength(1);
    expect(runs[0].meta.receiptRule).toMatchObject({ wouldSkip: true, mode: 'shadow', source: 'env', steps: 2, receipted: 2, blockedSteps: 0, treeCompared: false, reasons: [] });
    expect(runs[0].meta.control).toBeUndefined();
    expect(typeof runs[0].stamp.selfAuditRoundId).toBe('string');
    expect(rowsOf('self_audit_skip')).toHaveLength(0);
    // Fixer finding 5: the shadow readout carries the harness OUTCOME label
    // (reopened ⇔ the rule would have been wrong to skip) on the same round id.
    const shadow = rowsOf('self_audit_shadow');
    expect(shadow).toHaveLength(1);
    expect(shadow[0].meta).toMatchObject({ wouldSkip: true, mode: 'shadow', reopened: false, steps: 2, receipted: 2, reasons: [], rejectBacksAfter: 0, guardStrikesAfter: 0 });
    expect(shadow[0].stamp.selfAuditRoundId).toBe(runs[0].stamp.selfAuditRoundId);
    expect(rowsOf('self_audit_control')).toHaveLength(0);
    // Fixer finding 4: no verify recorded ⇒ no git at all, and never the fingerprint capture.
    expect(mockCaptureWorktreeTree).not.toHaveBeenCalled();
    expect(mockReadHeadSha).not.toHaveBeenCalled();
    expect(mockCaptureVerifyFingerprint).not.toHaveBeenCalled();
    const [audit] = auditMessagesFrom(0);
    expect(audit.content).toContain('This is the ONLY audit this firing gets — never plan, schedule or narrate a second pass (SA2/SA3)');
    expect(audit.content).toContain('CITE that receipt by id — do not re-run it');
    expect(audit.content).toContain('with ONE cheap check');
    expect(audit.content).toContain('is TERMINAL');
    expect(audit.content).toContain('deliverable first, audit line last');
    expect(audit.content).toContain('probe_speed.py client-visible tok/s recorded');
    expect(audit.content).not.toContain('Re-read/re-run the relevant files or commands');
  });

  it('finding 2 (act): the receipt rule SKIPS the round (receipt_rule row) on a non-control run id; a CONTROL run id (1-in-10) runs the round with control:true and labels it with a self_audit_control row after the round', async () => {
    process.env.SELF_AUDIT_RECEIPT_RULE_MODE = 'act';
    const plan = { ...ttrdPlan('x'), steps: ttrdPlan('x').steps.slice(0, 2) };
    mockGetPlan.mockResolvedValue(plan);
    mockRunModelTurn.mockResolvedValueOnce(TURN('done.'));
    await runCodingAgent(makeInput('sess-churn-act', { receipts: ttrdReceipts(), runId: 'run-0000-0001' }));
    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
    expect(rowsOf('self_audit_run')).toHaveLength(0);
    expect(rowsOf('self_audit_skip')[0].meta).toMatchObject({ reason: 'receipt_rule', steps: 2, receipts: 2, mode: 'act', source: 'env' });
    expect(_store.get('sess-churn-act/coding-plan::self-audit-sig')?.sig).toBeTruthy();

    jest.clearAllMocks();
    _store.clear();
    mockGetPlan.mockResolvedValue(plan);
    mockRunModelTurn.mockResolvedValueOnce(TURN('done.')).mockResolvedValueOnce(TURN('audited — nothing reopened.'));
    const input = makeInput('sess-churn-control', { receipts: ttrdReceipts(), runId: 'run-0000-0000' });
    await runCodingAgent(input);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    const runs = rowsOf('self_audit_run');
    expect(runs).toHaveLength(1);
    expect(runs[0].meta).toMatchObject({ control: true, receiptRule: { wouldSkip: true, mode: 'act' } });
    expect((input.emit as jest.Mock).mock.calls.some((c: any[]) => c[0] === 'progress' && String(c[1]?.message).includes('receipt-rule control sample'))).toBe(true);
    const control = rowsOf('self_audit_control');
    expect(control).toHaveLength(1);
    expect(control[0].meta).toMatchObject({ reopened: false, steps: 2, receipted: 2, rejectBacksAfter: 0 });
    expect(control[0].stamp.selfAuditRoundId).toBe(runs[0].stamp.selfAuditRoundId);
    expect(rowsOf('self_audit_shadow')).toHaveLength(0); // a control round is labelled as control, not shadow
  });

  it('fixer finding 3: in ACT the receipt rule never skips a BLOCKED-plan board — the round runs (blocked variant), the row names blocked_steps, no skip row, no tree capture', async () => {
    process.env.SELF_AUDIT_RECEIPT_RULE_MODE = 'act';
    mockGetPlan.mockResolvedValue({ ...ttrdPlan('x'), steps: [...ttrdPlan('x').steps.slice(0, 2), { id: 9, text: 'Wait for the reviewer verdict on PR #706', status: 'blocked', note: 'awaiting reviewer verdict' }] });
    mockGetVerifyState.mockResolvedValue({ passed: true, at: 't', sha: 'sha-1', tree: 'tree-1' });
    mockRunModelTurn.mockResolvedValueOnce(TURN('still blocked on the verdict.')).mockResolvedValueOnce(TURN('blocker still real; nothing reopened.'));
    await runCodingAgent(makeInput('sess-churn-blocked', { receipts: ttrdReceipts(), runId: 'run-0000-0001' }));
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    const runs = rowsOf('self_audit_run');
    expect(runs).toHaveLength(1);
    expect(runs[0].meta.blockedSteps).toBe(1);
    expect(runs[0].meta.receiptRule).toMatchObject({ wouldSkip: false, mode: 'act', blockedSteps: 1 });
    expect(runs[0].meta.receiptRule.reasons).toContain('blocked_steps');
    expect(rowsOf('self_audit_skip')).toHaveLength(0);
    const [audit] = auditMessagesFrom(0);
    expect(audit.content).toContain('Re-confirm each BLOCKED step');
    // The cheap terms failed first ⇒ the expensive tree capture is never taken.
    expect(mockCaptureWorktreeTree).not.toHaveBeenCalled();
    expect(rowsOf('self_audit_shadow')[0].meta).toMatchObject({ wouldSkip: false, mode: 'act', reopened: false });
  });

  it('fixer finding 4: the verify-tree capture runs ONLY in act and ONLY once every cheaper term passes — shadow records the HEAD-sha match with treeCompared:false; act compares the side-effect-free tree; an unknown tree in act never skips', async () => {
    const plan = { ...ttrdPlan('x'), steps: ttrdPlan('x').steps.slice(0, 2) };
    const verified = { passed: true, at: 't', sha: 'sha-1', tree: 'tree-1' };
    // SHADOW: a recorded verify with a tree ⇒ no capture, one cheap sha read.
    mockGetPlan.mockResolvedValue(plan);
    mockGetVerifyState.mockResolvedValue(verified);
    mockReadHeadSha.mockResolvedValue('sha-1');
    mockRunModelTurn.mockResolvedValueOnce(TURN('done.')).mockResolvedValueOnce(TURN('audited.'));
    await runCodingAgent(makeInput('sess-churn-tree-shadow', { receipts: ttrdReceipts(), runId: 'run-0000-0001' }));
    expect(mockCaptureWorktreeTree).not.toHaveBeenCalled();
    expect(mockCaptureVerifyFingerprint).not.toHaveBeenCalled();
    expect(mockReadHeadSha).toHaveBeenCalledTimes(1);
    expect(rowsOf('self_audit_run')[0].meta.receiptRule).toMatchObject({ wouldSkip: true, mode: 'shadow', treeCompared: false, shaMatch: true });
    expect(typeof rowsOf('self_audit_run')[0].meta.receiptRule.captureMs).toBe('number');

    // ACT, same tree ⇒ the capture is taken, compared, and the round is skipped.
    process.env.SELF_AUDIT_RECEIPT_RULE_MODE = 'act';
    jest.clearAllMocks(); _store.clear();
    mockGetPlan.mockResolvedValue(plan);
    mockGetVerifyState.mockResolvedValue(verified);
    mockCaptureWorktreeTree.mockResolvedValue('tree-1');
    mockRunModelTurn.mockResolvedValueOnce(TURN('done.'));
    await runCodingAgent(makeInput('sess-churn-tree-act', { receipts: ttrdReceipts(), runId: 'run-0000-0001' }));
    expect(mockCaptureWorktreeTree).toHaveBeenCalledTimes(1);
    expect(mockCaptureVerifyFingerprint).not.toHaveBeenCalled();
    expect(mockReadHeadSha).not.toHaveBeenCalled();
    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
    expect(rowsOf('self_audit_skip')[0].meta).toMatchObject({ reason: 'receipt_rule', mode: 'act' });

    // ACT, stale tree ⇒ no skip (verify_tree_stale), treeCompared:true, the round runs.
    jest.clearAllMocks(); _store.clear();
    mockGetPlan.mockResolvedValue(plan);
    mockGetVerifyState.mockResolvedValue(verified);
    mockCaptureWorktreeTree.mockResolvedValue('tree-2');
    mockRunModelTurn.mockResolvedValueOnce(TURN('done.')).mockResolvedValueOnce(TURN('audited.'));
    await runCodingAgent(makeInput('sess-churn-tree-stale', { receipts: ttrdReceipts(), runId: 'run-0000-0001' }));
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(rowsOf('self_audit_run')[0].meta.receiptRule).toMatchObject({ wouldSkip: false, treeCompared: true, reasons: ['verify_tree_stale'] });

    // ACT, the capture FAILS ⇒ an unknown tree never skips in act.
    jest.clearAllMocks(); _store.clear();
    mockGetPlan.mockResolvedValue(plan);
    mockGetVerifyState.mockResolvedValue(verified);
    mockCaptureWorktreeTree.mockResolvedValue(null);
    mockRunModelTurn.mockResolvedValueOnce(TURN('done.')).mockResolvedValueOnce(TURN('audited.'));
    await runCodingAgent(makeInput('sess-churn-tree-unknown', { receipts: ttrdReceipts(), runId: 'run-0000-0001' }));
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(rowsOf('self_audit_run')[0].meta.receiptRule).toMatchObject({ wouldSkip: false, treeCompared: false, reasons: ['verify_tree_unknown'] });

    // ACT, an UNRECEIPTED step ⇒ the cheap terms fail first: no capture at all, just the sha read.
    jest.clearAllMocks(); _store.clear();
    mockGetPlan.mockResolvedValue({ ...plan, steps: [plan.steps[0], { id: 2, text: 'Write the postmortem doc', status: 'completed' }] });
    mockGetVerifyState.mockResolvedValue(verified);
    mockRunModelTurn.mockResolvedValueOnce(TURN('done.')).mockResolvedValueOnce(TURN('audited.'));
    await runCodingAgent(makeInput('sess-churn-tree-cheapfail', { receipts: ttrdReceipts(), runId: 'run-0000-0001' }));
    expect(mockCaptureWorktreeTree).not.toHaveBeenCalled();
    expect(mockReadHeadSha).toHaveBeenCalledTimes(1);
    expect(rowsOf('self_audit_run')[0].meta.receiptRule).toMatchObject({ wouldSkip: false, reasons: ['unreceipted_steps'] });
  });

  it('finding 2 never skips when a step is UNRECEIPTED (act)', async () => {
    process.env.SELF_AUDIT_RECEIPT_RULE_MODE = 'act';
    mockGetPlan.mockResolvedValue({ ...ttrdPlan('x'), steps: [{ id: 1, text: 'Edit src/speed/sched.py', status: 'completed' }, { id: 2, text: 'Write the postmortem doc', status: 'completed' }] });
    mockRunModelTurn.mockResolvedValueOnce(TURN('done.')).mockResolvedValueOnce(TURN('audited.'));
    await runCodingAgent(makeInput('sess-churn-unreceipted', { receipts: ttrdReceipts(), runId: 'run-0000-0001' }));
    expect(rowsOf('self_audit_run')).toHaveLength(1);
    expect(rowsOf('self_audit_run')[0].meta.receiptRule).toMatchObject({ wouldSkip: false, reasons: ['unreceipted_steps'] });
    expect(rowsOf('self_audit_skip')).toHaveLength(0);
  });
});

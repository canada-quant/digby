/**
 * REPLAY — audit 2026-10-08 W2-13 (sota.md #6): an eligible run got BOTH a
 * same-model self-audit pass and a cross-family independent reviewer in the same
 * round. When the reviewer (a different model family) returned a usable report,
 * the round now asks the lead only to act on the reviewer's FAIL / UNVERIFIED
 * items — the same-model "re-verify every criterion" pass is skipped (a
 * self_audit_skip row 'reviewer_ran' instead of self_audit_run). A same-family
 * review, or the kill switch, keeps today's self-audit.
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

const mockReviewerSeat = { value: 'deepseek-flash' };
// The model turn: ONE mock drives every case.
const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return {
    ...actual, seatUnservableReason: async () => null, runModelTurn: (...a: any[]) => mockRunModelTurn(...a),
    // W2-13: the Reviewer seat (coding_reviewer) resolves to mockReviewerSeat — a DIFFERENT family from the kimi-k3 lead by default.
    resolveRoleModelForRun: async (role: string, fallback: string) => (role === 'coding_reviewer' ? mockReviewerSeat.value : fallback),
  };
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
  LOOP_METRIC_KINDS: { CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits', SELF_AUDIT_RUN: 'self_audit_run', SELF_AUDIT_SKIP: 'self_audit_skip', GUARD_STRIKE: 'guard_strike', INDEPENDENT_REVIEW: 'independent_review' },
}));

// Plan board: actual module (so the 5ac56d81 dedupe helpers run for real
// against the in-memory store), getPlan mocked per-case.
const mockGetPlan: jest.Mock = jest.fn(async () => null);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlan: (...a: any[]) => mockGetPlan(...a),
}));


// The A3 gate under test: the seam helpers are spies that call through to the
// REAL module by default (assigned / continuation verdicts stay real); a case
// overrides the measured verdict.
const mockReadRunStartHead: jest.Mock = jest.fn(async () => 'head-at-start');
const mockReviewDiffGate: jest.Mock = jest.fn();
jest.mock('./review-diff-gate', () => {
  const actual = jest.requireActual('./review-diff-gate');
  return {
    ...actual,
    readRunStartHead: (...a: any[]) => mockReadRunStartHead(...a),
    reviewDiffGate: (...a: any[]) => mockReviewDiffGate(...a),
  };
});

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { ownerDispatchHeader } from '../platform/agent-send-header';

const PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 6,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: true,
  planReminders: true,
  memorySource: 'coding',
};

const TASK = 'Fix the typo in src/util.ts (utill → util) and report what changed.';
const makeInput = (sessionId: string, userMessage = TASK): AgentRunInput => ({
  worktree: '/tmp/review-diff-gate-agent-test-does-not-exist',
  sessionId,
  runId: `run-${sessionId}`,
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

const TURN = (content: string) => ({ content, reasoning: '', toolCalls: [], finishReason: 'stop' });
const WORK_TURN = { content: '', reasoning: '', toolCalls: [{ id: 'w1', name: 'run_command', arguments: JSON.stringify({ command: 'true' }) }], finishReason: 'tool_calls' };
const DONE_PLAN = {
  goal: 'fix the typo', acceptanceCriteria: ['typo fixed'],
  steps: [{ id: 1, text: 'fix the typo', status: 'completed' }],
  version: 1, updatedAt: '2026-10-04T00:00:00.000Z',
};

const rows = (kind: string) => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === kind);
const harnessMsgs = () => {
  const calls = mockRunModelTurn.mock.calls;
  const msgs = (calls[calls.length - 1]?.[1] ?? []) as any[];
  return msgs.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[HARNESS'));
};
const script = () => {
  mockRunModelTurn.mockReset();
  mockRunModelTurn
    .mockResolvedValueOnce(WORK_TURN)
    .mockResolvedValueOnce(TURN('Fixed the typo: utill → util in src/util.ts.'))
    .mockResolvedValueOnce(TURN('1. PASS — the typo is fixed in src/util.ts.\nVERDICT: PASS'))
    .mockResolvedValue(TURN('Done — the reviewer found nothing to fix.'));
};

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  delete process.env.SELF_AUDIT_REVIEWER_SKIP_DISABLED;
  delete process.env.INDEPENDENT_REVIEW_DISABLED;
  mockReviewerSeat.value = 'deepseek-flash';
  mockGetPlan.mockResolvedValue(DONE_PLAN);
  mockReadRunStartHead.mockResolvedValue('head-at-start');
  mockReviewDiffGate.mockResolvedValue({ skip: false, gate: 'non_trivial', stat: { files: 7, lines: 412, binary: 0, risky: [] } });
});
afterAll(() => { delete process.env.SELF_AUDIT_REVIEWER_SKIP_DISABLED; });

describe('audit 2026-10-08 W2-13 — the cross-family reviewer replaces the same-model self-audit pass', () => {
  it('REPLAY: a deepseek-flash reviewer on a kimi-k3 lead → ONE reviewer-findings message, no self-audit pass', async () => {
    script();
    await runCodingAgent({ ...makeInput('s-w2-13'), profile: { ...PROFILE, maxDelegations: 3 } });
    const review = rows('independent_review').find((r: any) => r.meta?.ran === true);
    expect(review?.meta).toMatchObject({ replacedSelfAudit: true, reviewModel: 'deepseek-flash' });
    expect(rows('self_audit_run')).toHaveLength(0);
    expect(rows('self_audit_skip').some((r: any) => r.meta?.reason === 'reviewer_ran' && r.meta?.reviewModel === 'deepseek-flash')).toBe(true);
    const msgs = harnessMsgs();
    expect(msgs.some((m) => m.content.startsWith('[HARNESS INDEPENDENT REVIEW — not typed by the user] A different model (deepseek-flash)'))).toBe(true);
    expect(msgs.some((m) => m.content.startsWith('[HARNESS SELF-AUDIT'))).toBe(false);
    expect(msgs.find((m) => m.content.startsWith('[HARNESS INDEPENDENT REVIEW'))!.content).toContain('VERDICT: PASS'); // the findings ride it
  });

  it('a SAME-family reviewer (the lead model) keeps the self-audit pass', async () => {
    mockReviewerSeat.value = 'cql-litellm:api-optimize-moonshot-kimi-k3';
    script();
    await runCodingAgent({ ...makeInput('s-w2-13-same'), profile: { ...PROFILE, maxDelegations: 3 } });
    expect(rows('self_audit_run')).toHaveLength(1);
    expect(harnessMsgs().some((m) => m.content.startsWith('[HARNESS SELF-AUDIT'))).toBe(true);
  });

  it('SELF_AUDIT_REVIEWER_SKIP_DISABLED=1 keeps the self-audit pass (today)', async () => {
    process.env.SELF_AUDIT_REVIEWER_SKIP_DISABLED = '1';
    script();
    await runCodingAgent({ ...makeInput('s-w2-13-ks'), profile: { ...PROFILE, maxDelegations: 3 } });
    expect(rows('self_audit_run')).toHaveLength(1);
    expect(harnessMsgs().some((m) => m.content.startsWith('[HARNESS SELF-AUDIT'))).toBe(true);
    expect(rows('independent_review').find((r: any) => r.meta?.ran === true)?.meta?.replacedSelfAudit).toBeUndefined();
  });
});

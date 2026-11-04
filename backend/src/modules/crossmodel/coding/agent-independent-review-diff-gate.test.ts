/**
 * A3 (2026-10-04 coding quick wins — review-diff-gate.ts): the independent
 * reviewer runs only where it pays. Pins the agent seam:
 *  - an eligible TASK run whose own diff is TRIVIAL skips the reviewer; the
 *    existing independent_review row carries reason 'trivial_diff' + the
 *    numbers (diffGate, diff {files, lines, binary, risky});
 *  - a non-trivial diff dispatches the reviewer exactly as before (the row
 *    carries diffGate 'non_trivial' + the numbers);
 *  - assigned work (owner dispatch — the bench path) never reads a start HEAD
 *    and always keeps the reviewer (diffGate 'assigned');
 *  - INDEPENDENT_REVIEW_DIFF_GATE_DISABLED=1: no start-HEAD read, no gate
 *    call, the row without any diff keys, the reviewer dispatched (today).
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
  LOOP_METRIC_KINDS: { CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits', SELF_AUDIT_RUN: 'self_audit_run', GUARD_STRIKE: 'guard_strike', INDEPENDENT_REVIEW: 'independent_review' },
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

const reviewRows = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === 'independent_review');
const progress = (input: AgentRunInput) => (input.emit as jest.Mock).mock.calls
  .filter((c: any[]) => c[0] === 'progress').map((c: any[]) => String(c[1]?.message ?? ''));
const runOnce = async (input: AgentRunInput) => {
  mockRunModelTurn
    .mockResolvedValueOnce(WORK_TURN)
    .mockResolvedValueOnce(TURN('Fixed the typo.'))
    .mockResolvedValue(TURN('Audited — final summary.'));
  return runCodingAgent(input);
};

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  delete process.env.INDEPENDENT_REVIEW_DIFF_GATE_DISABLED;
  delete process.env.INDEPENDENT_REVIEW_DISABLED;
  mockGetPlan.mockResolvedValue(DONE_PLAN);
  mockReadRunStartHead.mockResolvedValue('head-at-start');
  const actual = jest.requireActual('./review-diff-gate');
  mockReviewDiffGate.mockImplementation((o: any) => actual.reviewDiffGate(o));
});
afterAll(() => { delete process.env.INDEPENDENT_REVIEW_DIFF_GATE_DISABLED; });

describe('A3: independent reviewer only where it pays (2026-10-04)', () => {
  it('a TRIVIAL own diff skips the reviewer; the row says trivial_diff with the numbers', async () => {
    mockReviewDiffGate.mockResolvedValue({ skip: true, gate: 'trivial', stat: { files: 1, lines: 2, binary: 0, risky: [] } });
    const input = makeInput('s-a3-trivial');
    await runOnce(input);

    expect(mockReadRunStartHead).toHaveBeenCalledWith('/tmp/review-diff-gate-agent-test-does-not-exist');
    expect(mockReviewDiffGate).toHaveBeenCalledWith({ worktree: '/tmp/review-diff-gate-agent-test-does-not-exist', startHead: 'head-at-start', source: 'message', rawMessage: TASK, mutatingWork: 0 }); // T7-5: `true` is read-only
    const rows = reviewRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ ran: false, reason: 'trivial_diff', source: 'message', diffGate: 'trivial', diff: { files: 1, lines: 2, binary: 0, risky: [] } });
    const p = progress(input);
    expect(p.some(m => m.startsWith('Independent review skipped: trivial diff (1 file(s), 2 changed line(s), no risky path)'))).toBe(true);
    expect(p.some(m => m.startsWith('Independent review: a different model'))).toBe(false);
  });

  it('a NON-trivial diff dispatches the reviewer as before; the row carries the numbers', async () => {
    mockReviewDiffGate.mockResolvedValue({ skip: false, gate: 'non_trivial', stat: { files: 7, lines: 412, binary: 0, risky: [] } });
    const input = makeInput('s-a3-big');
    await runOnce(input);

    expect(progress(input).some(m => m.startsWith('Independent review: a different model'))).toBe(true);
    const meta = reviewRows()[0].meta;
    expect(meta.reason).not.toBe('trivial_diff');
    expect(meta).toMatchObject({ diffGate: 'non_trivial', diff: { files: 7, lines: 412 } });
  });

  it('ASSIGNED work (owner dispatch — the bench path) reads no start HEAD and always keeps the reviewer', async () => {
    const msg = `${ownerDispatchHeader('Bench PS', 'abcdef123456', 'digby-benchmarks', new Date('2026-10-04T01:00:00Z'))}${TASK}`;
    const input = makeInput('s-a3-assigned', msg);
    await runOnce(input);

    expect(mockReadRunStartHead).not.toHaveBeenCalled();
    expect(progress(input).some(m => m.startsWith('Independent review: a different model'))).toBe(true);
    expect(reviewRows()[0].meta).toMatchObject({ diffGate: 'assigned', dispatched: true });
    expect(reviewRows()[0].meta).not.toHaveProperty('diff');
  });

  it('INDEPENDENT_REVIEW_DIFF_GATE_DISABLED=1: no start-HEAD read, no gate, the row without diff keys, the reviewer dispatched (today)', async () => {
    process.env.INDEPENDENT_REVIEW_DIFF_GATE_DISABLED = '1';
    mockReviewDiffGate.mockResolvedValue({ skip: true, gate: 'trivial', stat: { files: 1, lines: 2, binary: 0, risky: [] } });
    const input = makeInput('s-a3-off');
    await runOnce(input);

    expect(mockReadRunStartHead).not.toHaveBeenCalled();
    expect(mockReviewDiffGate).not.toHaveBeenCalled();
    expect(progress(input).some(m => m.startsWith('Independent review: a different model'))).toBe(true);
    const meta = reviewRows()[0].meta;
    expect(meta).not.toHaveProperty('diffGate');
    expect(meta).not.toHaveProperty('diff');
    expect(meta.reason).not.toBe('trivial_diff');
  });

  it('an ineligible run (a schedule firing — no task request) never measures', async () => {
    const input = makeInput('s-a3-firing', '[MACHINE-TRIGGERED RUN — schedule abc] Check the board and continue.');
    await runOnce(input);
    expect(mockReadRunStartHead).not.toHaveBeenCalled();
    expect(mockReviewDiffGate).not.toHaveBeenCalled();
    expect(reviewRows()[0].meta).toMatchObject({ ran: false, reason: 'no_task_request' });
  });
});

// ── audit 2026-10-06 T7-5 — no-diff/no-mutation skip + the review never replaces the answer ──
describe('T7-5: independent review on an empty diff, and the kept answer', () => {
  const EMPTY = { files: 0, lines: 0, binary: 0, risky: [] as string[] };
  const WRITE_TURN = { content: '', reasoning: '', toolCalls: [{ id: 'w2', name: 'write_file', arguments: JSON.stringify({ path: '/tmp/x.txt', content: 'x' }) }], finishReason: 'tool_calls' };
  const MUTATING_CMD_TURN = { content: '', reasoning: '', toolCalls: [{ id: 'w3', name: 'run_command', arguments: JSON.stringify({ command: 'echo hi > /app/out.txt' }) }], finishReason: 'tool_calls' };
  beforeEach(() => {
    delete process.env.INDEPENDENT_REVIEW_NO_DIFF_SKIP_DISABLED;
    delete process.env.INDEPENDENT_REVIEW_KEEP_ANSWER_DISABLED;
    const actual = jest.requireActual('./review-diff-gate');
    // The worktree is empty: the verdict runs for real on a zero-file stat.
    mockReviewDiffGate.mockImplementation(async (o: any) => ({ ...actual.reviewDiffGateVerdict({ assigned: false, source: o.source, stat: EMPTY, ...(typeof o.mutatingWork === 'number' ? { mutatingWork: o.mutatingWork } : {}) }), stat: EMPTY }));
  });
  afterAll(() => { delete process.env.INDEPENDENT_REVIEW_NO_DIFF_SKIP_DISABLED; delete process.env.INDEPENDENT_REVIEW_KEEP_ANSWER_DISABLED; });

  it('an empty diff after READ-ONLY commands skips the reviewer (reason no_diff_no_mutation, mutatingWork 0)', async () => {
    const input = makeInput('s-t75-reads');
    await runOnce(input); // WORK_TURN = run_command `true`
    expect(reviewRows()[0].meta).toMatchObject({ ran: false, reason: 'no_diff_no_mutation', diffGate: 'no_diff_no_mutation', mutatingWork: 0 });
    expect(progress(input).some((m) => m.startsWith('Independent review skipped: no diff and no mutating work'))).toBe(true);
    expect(progress(input).some((m) => m.startsWith('Independent review: a different model'))).toBe(false);
  });

  it.each([
    ['a file write', WRITE_TURN],
    ['a run_command that redirects into a file', MUTATING_CMD_TURN],
  ])('an empty diff after %s keeps the reviewer (no_diff — the work happened outside the worktree)', async (_l, turn) => {
    const input = makeInput(`s-t75-${String(_l).length}`);
    mockRunModelTurn
      .mockResolvedValueOnce(turn)
      .mockResolvedValueOnce(TURN('Done.'))
      .mockResolvedValue(TURN('Audited — final summary.'));
    await runCodingAgent(input);
    expect(reviewRows()[0].meta).toMatchObject({ diffGate: 'no_diff', mutatingWork: 1 });
    expect(progress(input).some((m) => m.startsWith('Independent review: a different model'))).toBe(true);
  });

  it('INDEPENDENT_REVIEW_NO_DIFF_SKIP_DISABLED=1: an empty diff keeps the reviewer as before', async () => {
    process.env.INDEPENDENT_REVIEW_NO_DIFF_SKIP_DISABLED = '1';
    const input = makeInput('s-t75-ks');
    await runOnce(input);
    expect(reviewRows()[0].meta).toMatchObject({ diffGate: 'no_diff' });
    expect(progress(input).some((m) => m.startsWith('Independent review: a different model'))).toBe(true);
  });
});

describe('T7-5: the reviewer never replaces the lead answer', () => {
  beforeEach(() => {
    delete process.env.INDEPENDENT_REVIEW_KEEP_ANSWER_DISABLED;
    mockReviewDiffGate.mockResolvedValue({ skip: false, gate: 'non_trivial', stat: { files: 7, lines: 412, binary: 0, risky: [] } });
  });
  afterAll(() => { delete process.env.INDEPENDENT_REVIEW_KEEP_ANSWER_DISABLED; });
  const review = (o: { lead: string; reviewer: string; post: string; fix?: boolean }) => {
    // lead work → lead answer → (review worker report) → lead post-review final.
    mockRunModelTurn.mockReset();
    mockRunModelTurn
      .mockResolvedValueOnce(WORK_TURN)
      .mockResolvedValueOnce(TURN(o.lead))
      .mockResolvedValueOnce(TURN(o.reviewer));
    if (o.fix) {
      mockRunModelTurn.mockResolvedValueOnce({ content: '', reasoning: '', toolCalls: [{ id: 'f1', name: 'write_file', arguments: JSON.stringify({ path: 'src/util.ts', content: 'x' }) }], finishReason: 'tool_calls' });
    }
    mockRunModelTurn.mockResolvedValue(TURN(o.post));
  };

  it('a review round that changes nothing keeps the pre-review answer + ONE review line', async () => {
    review({ lead: 'Fixed the typo: utill → util in src/util.ts.', reviewer: 'PASS — requirement 1. no defects found', post: 'All criteria verified — the typo fix holds. Audit — criterion 1 PASS.' });
    const r = await runCodingAgent({ ...makeInput('s-t75-keep'), profile: { ...PROFILE, maxDelegations: 3 } });
    expect(reviewRows().find((x: any) => x.meta?.ran === true)).toBeTruthy();
    expect(r.finalText.startsWith('Fixed the typo: utill → util in src/util.ts.')).toBe(true);
    expect(r.finalText).toContain('_Independent review (a second model checked this against your original request): no defects found — All criteria verified — the typo fix holds._');
    expect(r.finalText).not.toContain('Audit — criterion 1 PASS');
    expect(mockRecordLoopMetric.mock.calls.some((c: any[]) => c[0]?.kind === 'independent_review_answer' && c[0]?.meta?.phase === 'answer_kept')).toBe(true);
  });

  it('a review round that FIXED something (a write) keeps its own final — it describes the new state', async () => {
    review({ lead: 'Fixed the typo.', reviewer: 'FAIL — requirement 2: util2 still misspelled', post: 'Fixed both typos after the review flagged util2.', fix: true });
    const r = await runCodingAgent({ ...makeInput('s-t75-fix'), profile: { ...PROFILE, maxDelegations: 3 } });
    expect(reviewRows().some((x: any) => x.meta?.ran === true)).toBe(true);
    expect(r.finalText).toBe('Fixed both typos after the review flagged util2.');
    expect(mockRecordLoopMetric.mock.calls.some((c: any[]) => c[0]?.kind === 'independent_review_answer' && c[0]?.meta?.phase === 'answer_revised')).toBe(true);
  });

  it('INDEPENDENT_REVIEW_KEEP_ANSWER_DISABLED=1: the post-review final is the answer (today)', async () => {
    process.env.INDEPENDENT_REVIEW_KEEP_ANSWER_DISABLED = '1';
    review({ lead: 'Fixed the typo.', reviewer: 'PASS — no defects found', post: 'All criteria verified.' });
    const r = await runCodingAgent({ ...makeInput('s-t75-keep-ks'), profile: { ...PROFILE, maxDelegations: 3 } });
    expect(reviewRows().some((x: any) => x.meta?.ran === true)).toBe(true);
    expect(r.finalText).toBe('All criteria verified.');
  });
});

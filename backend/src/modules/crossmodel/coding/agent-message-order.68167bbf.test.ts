/**
 * NON-RETRYABLE message-order 400 — ticket 68167bbf, 2026-10-28.
 *
 * THE MISHAP (acceptance criterion 2): a system-order rejection from a strict
 * OpenAI-compatible backend matched NO deterministic fingerprint, so the agent
 * loop's spurious-in-budget-400 lane owned it: 3 backoffs of the byte-identical
 * payload + 2 context SHRINKS, then "5 retries" and an aborted turn — on EVERY
 * turn, forever, because nothing in that budget can REORDER messages. Prod
 * app_error_logs showed the 400 bursts with "coding agent turn failed: aborted"
 * rows clustered right after them.
 *
 * runModelTurn now heals the order ONCE (system-first.ts; pinned end-to-end in
 * coding-model.system-first.test.ts). This file pins the agent loop's half: a
 * system-order rejection that reaches the loop has ALREADY survived that heal,
 * so it is deterministic — ONE model call, an honest note, one
 * provider_rejected row tagged lane 'message_order', and NO backoff, NO shrink.
 *
 * Scaffold mirrors agent-spurious-400-retry.4251dcb3.test.ts (same mock set).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));
jest.mock('../github/github-mcp', () => ({
  __esModule: true, isGitHubMcpConfigured: jest.fn(() => false), callGitHubMcpTool: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  __esModule: true, isGoogleMcpConfigured: jest.fn(() => false), callGoogleMcpTool: jest.fn(),
}));
jest.mock('../imessage/agent-link', () => ({
  agentBroker: { dispatch: jest.fn() },
}));

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'probe result: ok');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', PROVIDER_REJECTED: 'provider_rejected' },
}));

const _store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { _store.set(ns.join('/') + '::' + key, value); }),
}));
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
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

const mockFileFeedbackTicket: jest.Mock = jest.fn(async () => ({ ok: true }));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  ...jest.requireActual('../feedback/feedback.service'),
  fileFeedbackTicket: (...a: any[]) => mockFileFeedbackTicket(...a),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { CAPABILITY_REJECTION_RE } from './agent';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 800_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/system-first-order-test',
  sessionId: 'sess-68167bbf',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'finish the audit',
  emit: jest.fn(),
});

/** The VERBATIM incident rejection, as the loop sees it after the heal failed. */
const SYSTEM_ORDER_400 = {
  content: '', reasoning: '', toolCalls: [], finishReason: 'error',
  errorMessage: 'litellm.BadRequestError: OpenAIException - messages[2].role is system; the system message must be first',
  errorStatus: 400,
};
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const rejectionMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'provider_rejected');

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockExecuteCodingTool.mockResolvedValue('probe result: ok');
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1';
});

afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
});

describe('system-order 400 is NON-RETRYABLE (ticket 68167bbf, acceptance criterion 2)', () => {
  it('THE MISHAP REPLAY: ONE model call — no backoff, no shrink, no "5 retries" storm', async () => {
    mockRunModelTurn.mockResolvedValue(SYSTEM_ORDER_400); // rejects forever
    const emit = jest.fn();
    const result = await runCodingAgent({ ...makeInput(), emit });

    // The whole point of the ticket: the retry storm is GONE. Before the fix
    // this shape took 1 + 3 backoffs + 2 shrinks = 6 model calls per turn.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);

    // Honest terminal state, not a fake success.
    expect(result.modelErrored).toBe(true);
    expect(result.modelErrorStatus).toBe(400);
    expect(result.finalText).toContain('MESSAGE ORDER');
    expect(result.finalText).toContain('the system message must be first'); // the provider's own words
    expect(result.finalText).not.toContain('5 retries');

    // Telemetry names the new lane (queryable evidence for the 24h criterion).
    const rows = rejectionMetrics();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual(expect.objectContaining({ outcome: 'gave_up', lane: 'message_order', status: 400 }));

    // The retry lanes provably never ran.
    const progress = emit.mock.calls.map((c) => c[1]?.message || '').join('\n');
    expect(progress).not.toContain('backing off');
    expect(progress).not.toContain('shrank context');
  });

  it('does not file a seat-misconfiguration ticket (the seat is FINE — only the message order was wrong)', async () => {
    mockRunModelTurn.mockResolvedValue(SYSTEM_ORDER_400);
    await runCodingAgent(makeInput());
    await new Promise((r) => setImmediate(r));
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('the CAPABILITY regex does NOT swallow this shape — the two lanes are distinct', () => {
    // If CAPABILITY_REJECTION_RE matched, the failure would be blamed on tool
    // calling and file a misleading "enable auto tool choice" ticket.
    expect(CAPABILITY_REJECTION_RE.test(SYSTEM_ORDER_400.errorMessage)).toBe(false);
  });

  it('the 4251dcb3 spurious-in-budget-400 contract is UNTOUCHED for a bare 400', async () => {
    const BARE_400 = {
      content: '', reasoning: '', toolCalls: [], finishReason: 'error',
      errorMessage: 'Request too large or malformed for the model', errorStatus: 400,
    };
    mockRunModelTurn.mockResolvedValueOnce(BARE_400).mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput());
    expect(result.finalText).toBe('Done.');
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2); // still one backoff retry
  });

  it('a system-order 400 with a size-naming body keeps ITS lane (the classifier is narrow)', async () => {
    // A body that mentions both size and a system message must not be captured
    // by mistake: the size lane still owns a size-named rejection.
    const MIXED = {
      ...SYSTEM_ORDER_400,
      providerError: 'request exceeds the maximum context length allowed',
    };
    mockRunModelTurn.mockResolvedValueOnce(MIXED).mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput());
    expect(result.finalText).toBe('Done.');
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
  });

  it('kill switch SYSTEM_FIRST_NORMALIZE_DISABLED=1 restores the PRIOR retry lanes (a true revert)', async () => {
    // The ledger line promises a byte-for-byte revert, so an operator flipping
    // the switch must get the old backoff path back — not the new fast-fail.
    // Adversarial review finding #2: this lane used to be ungated, which made
    // the revert claim false.
    process.env.SYSTEM_FIRST_NORMALIZE_DISABLED = '1';
    mockRunModelTurn.mockResolvedValueOnce(SYSTEM_ORDER_400).mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput());

    expect(result.finalText).toBe('Done.');       // the old lane retried and recovered
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2); // ONE backoff, not the fast-fail
    // The new lane left NO row of its own; the failure went to the legacy path.
    expect(rejectionMetrics().some((m) => m.meta?.lane === 'message_order')).toBe(false);
    delete process.env.SYSTEM_FIRST_NORMALIZE_DISABLED;
  });
});
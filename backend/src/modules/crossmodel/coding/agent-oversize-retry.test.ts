/**
 * Provider too-large rejections — oversize shrink-retry (remediation P1).
 *
 * Four production firings died "The model kept rejecting the request (too
 * large or malformed …; transcript 178k–439k chars vs ~800k budget), 2
 * compact-and-retry attempts exhausted" — with ZERO tools run. The transcript
 * was UNDER the context budget (so compactMessages no-oped) and every message
 * was under the 14k per-message cap (so clipOversizedMessages no-oped): both
 * retries resent the byte-identical payload. The fix shrinks the LARGEST
 * tool-result bodies (head/tail excerpt, largest-first) toward HALF the
 * rejected size before each retry, so a size-class rejection converges to an
 * acceptable request instead of burning the budget on identical resends.
 *
 * Scaffold mirrors agent-derail-break.test.ts (same mock set).
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
  noteSeatFallback: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', PROVIDER_REJECTED: 'provider_rejected' },
}));

// Keyed-shell determinism (2026-09-17): the lead-seat HTTP fallback (1b1d81f35)
// serves built-ins (glm-5.3/deepseek-flash/kimi-k3) only when ZAI/DEEPSEEK/
// MOONSHOT keys exist — a keyed dev shell flips these no-shrink lanes into
// recoveries (CI is keyless, which is why main stays green). Pin the keyless
// instance these tests describe; restore the caller's env after.
const SEAT_FALLBACK_ENV_KEYS = ['ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY'];
const savedSeatFallbackEnv = SEAT_FALLBACK_ENV_KEYS.map((k) => ({ k, v: process.env[k] }));
beforeAll(() => { for (const { k } of savedSeatFallbackEnv) delete process.env[k]; });
afterAll(() => { for (const { k, v } of savedSeatFallbackEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

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
  buildChatWakeClockNote: jest.fn(() => ""),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

// The incident shape: transcript far UNDER the context budget, but over the
// provider's real acceptance ceiling.
const CONTEXT_BUDGET = 800_000;
const PROVIDER_LIMIT_CHARS = 50_000;

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: CONTEXT_BUDGET,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

/** 12 answered tool rounds of 13k chars each ≈ 156k — every message under the
 *  14k per-message clip cap, total under the 800k budget: both old recovery
 *  legs no-op on this transcript. */
const bigHistory = (): any[] => {
  const out: any[] = [];
  for (let i = 0; i < 12; i++) {
    out.push({
      role: 'assistant', content: '',
      tool_calls: [{ id: `h${i}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"big.txt"}' } }],
    });
    out.push({ role: 'tool', tool_call_id: `h${i}`, content: `file part ${i}\n` + 'x'.repeat(13_000) });
  }
  return out;
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/oversize-retry-test',
  sessionId: 'sess-oversize-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: bigHistory() as any,
  userMessage: 'finish the audit',
  emit: jest.fn(),
});

const messageChars = (messages: any[]): number =>
  messages.reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);

const TOO_LARGE = {
  content: '', reasoning: '', toolCalls: [], finishReason: 'error',
  errorMessage: 'Request too large or malformed for the model', errorStatus: 400,
  // The provider's drained body naming the size cause — post-4251dcb3 this is
  // what keeps a rejection in the shrink lane; a bare in-budget 400 (no size
  // cause) takes the transient backoff lane first (spurious-window class).
  providerError: '{"error":{"message":"request exceeds the maximum context length allowed"}}',
};
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const rejectionMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'provider_rejected');

/** Size-gated provider: rejects any request over the limit, serves the rest —
 *  first served turn runs one real tool, then finishes. */
const wireSizeGatedProvider = () => {
  let served = 0;
  mockRunModelTurn.mockImplementation(async (_provider: any, messages: any[]) => {
    if (messageChars(messages) > PROVIDER_LIMIT_CHARS) return TOO_LARGE;
    served += 1;
    if (served === 1) {
      return {
        content: '', reasoning: '',
        toolCalls: [{ id: 't1', name: 'update_feedback', arguments: '{"id":"deadbeef-1","status":"done"}' }],
        finishReason: 'tool_calls',
      };
    }
    return FINAL;
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockExecuteCodingTool.mockResolvedValue('probe result: ok');
  // Millisecond transient backoffs — the backoff lane otherwise waits 10s+ per attempt.
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1';
});

afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
});

describe('provider too-large rejections — oversize shrink-retry', () => {
  it('rejects twice, shrinks the largest tool results each time, then the run completes WITH tools run', async () => {
    wireSizeGatedProvider();
    const result = await runCodingAgent(makeInput());

    // Converged: the run finished cleanly and a tool actually executed —
    // never again "2 attempts exhausted — zero tools ran".
    expect(result.finalText).toBe('Done.');
    expect(result.modelErrored).toBeUndefined();
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);

    // Two size-class rejections, each answered with a strictly smaller retry.
    const rejected = rejectionMetrics();
    expect(rejected).toHaveLength(2);
    expect(rejected[0].meta).toMatchObject({ attempt: 1, status: 400, outcome: 'shrink_retry' });
    expect(rejected[1].meta).toMatchObject({ attempt: 2, status: 400, outcome: 'shrink_retry' });
    expect(rejected[0].meta.retryChars).toBeLessThan(rejected[0].meta.chars);
    expect(rejected[1].meta.retryChars).toBeLessThan(rejected[1].meta.chars);
    expect(rejected[1].meta.chars).toBeLessThanOrEqual(rejected[0].meta.retryChars);

    // The accepted request carries head/tail-clipped tool results — same
    // message count (nothing removed, only bodies shrunk; tool_call_id
    // preservation is pinned in compaction.test.ts on the helper itself).
    const acceptedCall = mockRunModelTurn.mock.calls.find((c) => messageChars(c[1]) <= PROVIDER_LIMIT_CHARS);
    expect(acceptedCall).toBeDefined();
    const clipped = (acceptedCall![1] as any[]).filter((m) => m.role === 'tool' && String(m.content).includes('…[clipped'));
    expect(clipped.length).toBeGreaterThan(0);
    const firstRejectedCall = mockRunModelTurn.mock.calls[0][1] as any[];
    expect((acceptedCall![1] as any[]).filter((m) => m.role === 'tool').length)
      .toBe(firstRejectedCall.filter((m) => m.role === 'tool').length);
  });

  it('a size-class give-up records the gave_up outcome (shrink exhausted against a tiny provider limit)', async () => {
    // Provider rejects EVERYTHING — even fully-shrunk transcripts.
    mockRunModelTurn.mockResolvedValue(TOO_LARGE);
    const result = await runCodingAgent(makeInput());

    expect(result.modelErrored).toBe(true);
    expect(result.modelErrorKind).toBe('size');
    const rejected = rejectionMetrics();
    expect(rejected.map((m) => m.meta.outcome)).toEqual(['shrink_retry', 'shrink_retry', 'gave_up']);
    // Each retry was still strictly smaller — the loop never resent an
    // identical payload while a smaller one was possible.
    expect(rejected[0].meta.retryChars).toBeLessThan(rejected[0].meta.chars);
    expect(rejected[1].meta.retryChars).toBeLessThan(rejected[1].meta.chars);
  });

  it('a transient 429 keeps its backoff lane — no shrink, no provider_rejected rows', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce({ ...TOO_LARGE, errorMessage: 'rate limited', errorStatus: 429 })
      .mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput());

    expect(result.finalText).toBe('Done.');
    expect(rejectionMetrics()).toHaveLength(0);
  }, 30_000); // generous headroom — AGENT_TRANSIENT_BACKOFF_MS=1,1,1 makes the backoff ~instant
});

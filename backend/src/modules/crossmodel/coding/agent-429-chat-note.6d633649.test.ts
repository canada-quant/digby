/**
 * Chat-audience terminal note on provider 429 (ticket 6d633649 — replay pin).
 *
 * 2026-09-14 04:44–04:47Z: a casual L2-Ensemble chat question ("i just watched
 * akira…", chat 3e9cac18, kimi-k3 seat, chat profile — contextCharBudget
 * 100_000) died on a provider-side HTTP 429 ("Rate limit reached for
 * requests"). The transient lane did its job — 3 backoff-and-retry attempts
 * (10s/30s/60s) — but the rate window outlasted the ~100s budget, so the loop
 * stopped honestly with modelErrorTerminalNote. The FAILURE was provider
 * capacity (the 05:36Z resend succeeded on the same build); the DEFECT was
 * the note's audience: operator jargon ("transcript ~48k chars vs ~100k
 * context budget, 3 backoff-and-retry attempts exhausted… Stopping here
 * rather than reporting a false success") posted into an end-user chat
 * bubble — the user reported "what is failing here??".
 *
 * The fix: modelErrorTerminalNote gains audience:'operator'|'user'; the agent
 * loop passes 'user' for non-coding profiles (chat/chat_research). The
 * engineering detail stays queryable in the provider_rejected loop-metric
 * meta (chars/model/status/providerError) and the progress events — only the
 * bubble copy changes. Coding sessions keep the dense operator note.
 *
 * Scaffold mirrors agent-error-surface.189cfeb9.test.ts (same mock set).
 */

import { Readable } from 'stream';

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
// MOONSHOT keys exist — a keyed dev shell flips these terminal-note lanes into
// recoveries (CI is keyless, which is why main stays green). Pin the keyless
// instance these tests describe; restore the caller's env after.
const SEAT_FALLBACK_ENV_KEYS = ['ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY'];
const savedSeatFallbackEnv = SEAT_FALLBACK_ENV_KEYS.map((k) => ({ k, v: process.env[k] }));
beforeAll(() => { for (const { k } of savedSeatFallbackEnv) delete process.env[k]; });
afterAll(() => { for (const { k, v } of savedSeatFallbackEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const mockFileFeedbackTicket: jest.Mock = jest.fn(async () => ({ id: 'ticket-1' }));
jest.mock('../feedback/feedback.service', () => {
  const actual = jest.requireActual('../feedback/feedback.service');
  return { ...actual, fileFeedbackTicket: (...a: any[]) => mockFileFeedbackTicket(...a) };
});

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

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000, // chatProfile('thinking') — the incident's "~100k context budget"
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 90_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const makeInput = (profile: AgentProfile): AgentRunInput => ({
  worktree: '/tmp/error-surface-6d633649',
  sessionId: 'sess-6d633649',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile,
  doctrineOverride: 'You are a test agent.',
  history: [
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'earlier question' },
  ] as any,
  userMessage: 'i just watched akira… can you help me understand??',
  emit: jest.fn(),
});

/** The incident's exact rejection: Moonshot-style OpenAI-compatible 429 body. */
const rateLimitError = () =>
  Object.assign(new Error('Request failed with status code 429'), {
    response: { status: 429, data: Readable.from(['{"error":{"message":"Rate limit reached for requests","type":"rate_limit_reached_error"}}']) },
  });

const rejectionMetrics = () =>
  mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'provider_rejected');

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockExecuteCodingTool.mockResolvedValue('probe result: ok');
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1'; // backoff lane in milliseconds
});

afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
});

describe('chat-profile terminal note on provider 429 (ticket 6d633649)', () => {
  it('an end user gets a PLAIN-language note — the operator jargon stays out of the bubble', async () => {
    mockRunModelTurn.mockImplementation(async () => { throw rateLimitError(); });
    const result = await runCodingAgent(makeInput(CHAT_TEST_PROFILE));

    // Still an honest give-up after the bounded backoffs — never a fake success.
    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4); // 1 initial + 3 backoff retries

    // The bubble: what failed, that it is not the user's fault, what to do next.
    expect(result.finalText).toContain('rate-limiting');
    expect(result.finalText).toContain('3 retries');
    expect(result.finalText).toContain('Nothing is wrong with your message');
    expect(result.finalText).toContain('resending in a minute or two');

    // The jargon that produced "what is failing here??" is gone from the bubble…
    expect(result.finalText).not.toContain('context budget');
    expect(result.finalText).not.toContain('backoff-and-retry');
    expect(result.finalText).not.toContain('kept rejecting the request');
    expect(result.finalText).not.toContain('false success');
    expect(result.finalText).not.toContain('provider said');

    // …but the engineering detail is NOT lost — it stays queryable in telemetry.
    const metrics = rejectionMetrics();
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics.every((m) => m.meta?.status === 429)).toBe(true);
    expect(metrics.every((m) => m.meta?.providerError === 'Rate limit reached for requests')).toBe(true);
  });

  it('a CODING-profile run keeps the dense operator note (evidence over vagueness there)', async () => {
    mockRunModelTurn.mockImplementation(async () => { throw rateLimitError(); });
    const result = await runCodingAgent(makeInput(CODING_TEST_PROFILE));

    expect(result.modelErrored).toBe(true);
    expect(result.finalText).toContain('kept rejecting the request');
    expect(result.finalText).toContain('rate-limited the request (HTTP 429)');
    expect(result.finalText).toContain('provider said: Rate limit reached for requests');
    expect(result.finalText).toContain('backoff-and-retry attempts exhausted');
  });
});

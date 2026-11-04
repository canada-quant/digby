/**
 * Provider-error SURFACE (ticket 189cfeb9 — replay pin).
 *
 * 2026-09-11: the Tenstorrent R&D lane (chat a8976e11, kimi-k3 seat) had 3
 * consecutive runs die "The model kept rejecting the request (the request was
 * too large or malformed for the model; transcript ~46k/~34k chars vs ~800k
 * context budget, 2 compact-and-retry attempts exhausted)" during a ~4h
 * Moonshot 400-incident window (08:50–12:39Z; the next firing succeeded on
 * the SAME build + SAME transcript prefix — provider-side, not the harness
 * and not per-chat corruption). The harness already DRAINED the provider's
 * error body (bounded, agent.ts catch) but used it only for a worker-log
 * line: the terminal note guessed from the bare status and the loop_metrics
 * meta never carried the provider's own reason — the ticket's "why does the
 * provider reject in-budget requests?" was unanswerable from queryable
 * evidence. The same discard also blinded the billing-outage regex
 * (/insufficient balance/ tests turn.errorMessage — axios's generic message,
 * not the body) on streaming requests.
 *
 * The fix: parse the drained body into TurnResult.providerError
 * (extractProviderErrorDetail), append it to errorMessage (regexes see it),
 * and surface it in the terminal note + provider_rejected metric meta.
 *
 * Scaffold mirrors agent-oversize-retry.test.ts (same mock set).
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
// MOONSHOT keys exist — a keyed dev shell flips these billing lanes into
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
import { modelErrorTerminalNote } from './compaction';
import { extractProviderErrorDetail } from './coding-model';

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
  worktree: '/tmp/error-surface-189cfeb9',
  sessionId: 'sess-189cfeb9',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'earlier question' },
  ] as any,
  userMessage: 'continue the mission',
  emit: jest.fn(),
});

/** An axios-style rejection whose error body arrives as a STREAM (exactly
 *  what responseType:'stream' yields on a provider 400). */
const axiosStreamError = (status: number, body: string) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: Readable.from([body]) },
  });

const rejectionMetrics = () =>
  mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'provider_rejected');

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockExecuteCodingTool.mockResolvedValue('probe result: ok');
  // Post-4251dcb3 a bare/non-size-named in-budget 400 takes the transient
  // backoff lane first — millisecond backoffs keep this suite under the 5s cap.
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1';
});

afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
});

describe('extractProviderErrorDetail (unit)', () => {
  it('parses the OpenAI-style {"error":{"message":…}} shape (Moonshot/DeepSeek)', () => {
    expect(extractProviderErrorDetail('{"error":{"message":"prompt logprobs is not supported","type":"invalid_request_error"}}'))
      .toBe('prompt logprobs is not supported');
  });
  it('parses GLM\'s {"error":{"code","message"}} shape', () => {
    expect(extractProviderErrorDetail('{"error":{"code":"1214","message":"messages parameter is illegal"}}'))
      .toBe('messages parameter is illegal');
  });
  it('parses flat {"message":…} and string {"error":"…"}', () => {
    expect(extractProviderErrorDetail('{"message":"boom"}')).toBe('boom');
    expect(extractProviderErrorDetail('{"error":"kaput"}')).toBe('kaput');
  });
  it('falls back to raw text for non-JSON bodies, whitespace-collapsed', () => {
    expect(extractProviderErrorDetail('  Bad\nRequest:\t too many things  ')).toBe('Bad Request: too many things');
  });
  it('returns "" for empty/whitespace bodies', () => {
    expect(extractProviderErrorDetail('')).toBe('');
    expect(extractProviderErrorDetail('   ')).toBe('');
  });
  it('caps the detail (bounded for notes + metric metas)', () => {
    const out = extractProviderErrorDetail('x'.repeat(500));
    expect(out.length).toBeLessThanOrEqual(301); // 300 + ellipsis
  });
});

describe('modelErrorTerminalNote (unit)', () => {
  it('without providerError is byte-identical to the pre-fix note (the exact string the lane saw)', () => {
    expect(modelErrorTerminalNote({ errorStatus: 400, transcriptChars: 34_000, contextBudget: 800_000, attempts: 2 }))
      .toBe('The model kept rejecting the request (the request was too large or malformed for the model; transcript ~34k chars vs ~800k context budget, 2 compact-and-retry attempts exhausted). Stopping here rather than reporting a false success — the transcript was within budget, so this was likely a transient provider issue — resending the message usually succeeds.');
  });
  it('with providerError appends the provider\'s own reason', () => {
    expect(modelErrorTerminalNote({ errorStatus: 400, providerError: 'prompt logprobs is not supported', transcriptChars: 34_000, contextBudget: 800_000, attempts: 2 }))
      .toContain('too large or malformed for the model; provider said: prompt logprobs is not supported; transcript ~34k chars');
  });
});

describe('provider-error surface through the agent loop (ticket 189cfeb9)', () => {
  it('a streamed 400 body reaches the terminal note AND the gave_up metric meta', async () => {
    mockRunModelTurn.mockImplementation(async () => {
      throw axiosStreamError(400, '{"error":{"message":"prompt logprobs is not supported","type":"invalid_request_error"}}');
    });
    const result = await runCodingAgent(makeInput());

    // Gave up honestly after the bounded recoveries — never a fake success.
    expect(result.modelErrored).toBe(true);
    // Post-6d633649 a CHAT-profile bubble speaks plainly (HTTP status + what
    // to do next); the operator note is pinned through the loop in
    // agent-429-chat-note.6d633649.test.ts and by the unit tests above.
    expect(result.finalText).toContain('HTTP 400');
    expect(result.finalText).not.toContain('kept rejecting the request');
    expect(result.finalText).not.toContain('provider said:');
    // The provider's own reason still reaches the QUERYABLE surface (the real
    // 189cfeb9 pin): the gave_up metric meta.
    // Post-4251dcb3 the non-size-named in-budget 400 backs off first: 1 initial
    // + 3 backoff retries + 2 shrink-retries (fall-through), then gave_up.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(6);
    const metrics = rejectionMetrics();
    expect(metrics.filter((m) => m.meta?.outcome === 'shrink_retry')).toHaveLength(2);
    const gaveUp = metrics.find((m) => m.meta?.outcome === 'gave_up');
    expect(gaveUp).toBeDefined();
    expect(gaveUp!.meta.providerError).toBe('prompt logprobs is not supported');
    expect(metrics.every((m) => m.meta?.providerError === 'prompt logprobs is not supported')).toBe(true);
  });

  it('a body-carried "insufficient balance" now trips the billing outage path (was blind on streaming requests)', async () => {
    mockRunModelTurn.mockImplementation(async () => {
      throw axiosStreamError(400, '{"error":{"message":"account suspended due to insufficient balance"}}');
    });
    const result = await runCodingAgent(makeInput());

    expect(result.finalText).toContain('PROVIDER BILLING OUTAGE');
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    // Fail-fast: ONE provider call, zero shrink/backoff retries burned.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
    expect(rejectionMetrics()).toHaveLength(0);
  });

  it('an empty error body degrades to the pre-fix note (no providerError anywhere)', async () => {
    mockRunModelTurn.mockImplementation(async () => {
      throw Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: undefined } });
    });
    const result = await runCodingAgent(makeInput());

    expect(result.modelErrored).toBe(true);
    // Chat-audience note (6d633649): plain HTTP-status copy, no operator jargon.
    expect(result.finalText).toContain('HTTP 400');
    expect(result.finalText).not.toContain('kept rejecting the request');
    expect(result.finalText).not.toContain('provider said:');
    expect(rejectionMetrics().every((m) => m.meta?.providerError === undefined)).toBe(true);
  });
});

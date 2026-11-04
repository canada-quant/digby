/**
 * Rate-limit-aware transient backoff + throttled continuation wake (ticket
 * cffaa701 — replay pin).
 *
 * The incident (2026-09-14, ~16:30–18:05Z): a canlegal-bench worker coding
 * chat (184abfe9, glm-5.3 seat) died SIX times in ~1.5h on provider HTTP 429s
 * ("Rate limit reached for requests") — deaths at ~71k/~110k/~243k chars vs a
 * ~4000k context budget, i.e. NOT size. Each death: the 3-attempt
 * backoff-and-retry budget (10s/30s/60s, ≤100s total) expired INSIDE the
 * provider's rate window, every retry hammered the still-limited window, and
 * the run gave up mid-plan; the ~45s continuation wake then re-entered the
 * same window and died again. A second project (spark-cluster doc worker) hit
 * the same window the same afternoon. glm-5.3 traffic shares ONE provider key
 * (ZAI_API_KEY) across all sessions, so the throttle is fleet-wide.
 *
 * The fix pinned here:
 *  1. Retry-After honored — the error-turn synthesis recovers the provider's
 *     Retry-After header (delta-seconds or HTTP-date) onto the turn and the
 *     transient lane treats it as a wait FLOOR (capped), not a suggestion.
 *  2. Class-aware backoff tables — UNATTENDED runs (machine-triggered or
 *     helper fast-seat) default to a 5-attempt table reaching into minutes
 *     (10s/30s/60s/120s/240s) with ±25% jitter on built-in tables so
 *     concurrent lanes stop retrying in lockstep; interactive (user-turn)
 *     runs keep the short 3-attempt table. AGENT_TRANSIENT_BACKOFF_MS still
 *     overrides EVERY class exactly (back-compat for the existing suites);
 *     AGENT_TRANSIENT_BACKOFF_MACHINE_MS overrides only the unattended table.
 *  3. Throttled continuation wake — run-executor passes a 3–5 min (jittered)
 *     delay to queueContinuationRun when the finalizing run died transient
 *     (schedule.service.providerThrottleRequeueDelayMs; the schedule.service
 *     unit tests pin its range + env override).
 *
 * Scaffold mirrors agent-429-chat-note.6d633649.test.ts (same mock set).
 */

import { Readable } from 'stream';
import logger from '../../../utils/logger';

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
// MOONSHOT keys exist — a keyed dev shell flips these give-up lanes into
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

import {
  runCodingAgent,
  computeTransientWaitMs,
  parseBackoffTableEnv,
  TRANSIENT_BACKOFF_USER_DEFAULT_MS,
  TRANSIENT_BACKOFF_MACHINE_DEFAULT_MS,
  TRANSIENT_RETRY_AFTER_CAP_DEFAULT_MS,
} from './agent';
import { parseRetryAfterHeader } from './coding-model';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 90_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const makeInput = (extra?: Partial<AgentRunInput>): { input: AgentRunInput; emit: jest.Mock } => {
  const emit = jest.fn();
  const input: AgentRunInput = {
    worktree: '/tmp/throttle-cffaa701',
    sessionId: 'sess-cffaa701',
    projectId: 'p1',
    userId: 'u1',
    permissionMode: 'auto',
    model: 'glm-5.3',
    projectName: 'test',
    branch: 'main',
    profile: CODING_TEST_PROFILE,
    doctrineOverride: 'You are a test agent.',
    history: [
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'earlier question' },
    ] as any,
    userMessage: 'continue the bench run',
    emit,
    ...(extra ?? {}),
  } as AgentRunInput;
  return { input, emit };
};

/** The incident's rejection, without a Retry-After header. */
const rateLimitError = () =>
  Object.assign(new Error('Request failed with status code 429'), {
    response: { status: 429, data: Readable.from(['{"error":{"message":"Rate limit reached for requests","type":"rate_limit_reached_error"}}']) },
  });

/** The same 429 WITH the provider's Retry-After header (delta-seconds). */
const rateLimitErrorWithRetryAfter = (retryAfter: string) =>
  Object.assign(new Error('Request failed with status code 429'), {
    response: {
      status: 429,
      headers: { 'retry-after': retryAfter },
      data: Readable.from(['{"error":{"message":"Rate limit reached for requests","type":"rate_limit_reached_error"}}']),
    },
  });

const ENV_KEYS = [
  'AGENT_TRANSIENT_BACKOFF_MS',
  'AGENT_TRANSIENT_BACKOFF_MACHINE_MS',
  'AGENT_TRANSIENT_RETRY_AFTER_CAP_MS',
] as const;

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockExecuteCodingTool.mockResolvedValue('probe result: ok');
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

/* ── 1. parseRetryAfterHeader ───────────────────────────────────────────── */

describe('parseRetryAfterHeader (cffaa701)', () => {
  it('delta-seconds → ms', () => {
    expect(parseRetryAfterHeader('120')).toBe(120_000);
    expect(parseRetryAfterHeader('0')).toBe(0);
    expect(parseRetryAfterHeader('1.5')).toBe(1_500);
  });
  it('HTTP-date → ms-from-now (past dates clamp to 0)', () => {
    const now = Date.parse('2026-09-14T18:00:00.000Z');
    expect(parseRetryAfterHeader('Mon, 14 Sep 2026 18:02:00 GMT', now)).toBe(120_000);
    expect(parseRetryAfterHeader('Mon, 14 Sep 2026 17:59:00 GMT', now)).toBe(0);
  });
  it('absent/garbage → undefined (the table alone decides)', () => {
    expect(parseRetryAfterHeader(undefined)).toBeUndefined();
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterHeader('')).toBeUndefined();
    expect(parseRetryAfterHeader('not-a-date')).toBeUndefined();
    expect(parseRetryAfterHeader('-5')).toBeUndefined();
  });
  it('array header values use the first element', () => {
    expect(parseRetryAfterHeader(['30', '60'])).toBe(30_000);
  });
});

/* ── 2. computeTransientWaitMs (+ the shipped default tables) ───────────── */

describe('computeTransientWaitMs (cffaa701)', () => {
  it('pins the shipped defaults: 3-attempt user table, 5-attempt unattended table reaching into minutes', () => {
    expect(TRANSIENT_BACKOFF_USER_DEFAULT_MS).toEqual([10_000, 30_000, 60_000]);
    expect(TRANSIENT_BACKOFF_MACHINE_DEFAULT_MS).toEqual([10_000, 30_000, 60_000, 120_000, 240_000]);
    expect(TRANSIENT_RETRY_AFTER_CAP_DEFAULT_MS).toBe(600_000);
  });
  it('picks the table value by attempt (1-indexed), clamping to the last entry', () => {
    const table = [1, 2, 3];
    expect(computeTransientWaitMs({ attempt: 1, tableMs: table })).toBe(1);
    expect(computeTransientWaitMs({ attempt: 2, tableMs: table })).toBe(2);
    expect(computeTransientWaitMs({ attempt: 3, tableMs: table })).toBe(3);
    expect(computeTransientWaitMs({ attempt: 9, tableMs: table })).toBe(3);
  });
  it('Retry-After raises the wait to the floor…', () => {
    expect(computeTransientWaitMs({ attempt: 1, tableMs: [1], retryAfterMs: 120_000 })).toBe(120_000);
  });
  it('…but never above the cap (a pathological header cannot park a run for hours)', () => {
    expect(computeTransientWaitMs({ attempt: 1, tableMs: [1], retryAfterMs: 9_000_000 })).toBe(600_000);
    expect(computeTransientWaitMs({ attempt: 1, tableMs: [1], retryAfterMs: 9_000_000, retryAfterCapMs: 3 })).toBe(3);
  });
  it('a Retry-After BELOW the table value does not shorten the wait', () => {
    expect(computeTransientWaitMs({ attempt: 3, tableMs: [10_000, 30_000, 60_000], retryAfterMs: 5_000 })).toBe(60_000);
  });
  it('jitter stays within ±25% of the table value (and env tables pass through exact when jitter is off)', () => {
    const table = [100_000];
    expect(computeTransientWaitMs({ attempt: 1, tableMs: table, jitter: true, rand: () => 0 })).toBe(75_000);
    expect(computeTransientWaitMs({ attempt: 1, tableMs: table, jitter: true, rand: () => 0.999999 })).toBeLessThanOrEqual(125_000);
    expect(computeTransientWaitMs({ attempt: 1, tableMs: table, jitter: false, rand: () => 0.5 })).toBe(100_000);
  });
  it('parseBackoffTableEnv: "ms,ms,…" → numbers; garbage filtered; unset → empty', () => {
    expect(parseBackoffTableEnv('1, 2,3')).toEqual([1, 2, 3]);
    expect(parseBackoffTableEnv('1,x,3')).toEqual([1, 3]);
    expect(parseBackoffTableEnv(undefined)).toEqual([]);
    expect(parseBackoffTableEnv('')).toEqual([]);
  });
});

/* ── 3. Loop integration: class-aware budgets + honored Retry-After ─────── */

describe('transient lane class budgets in the agent loop (cffaa701)', () => {
  it('an UNATTENDED (machine-triggered) run gets the machine table: 1 initial + 5 backoff retries before the honest give-up', async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS = '1,1,1,1,1';
    mockRunModelTurn.mockImplementation(async () => { throw rateLimitError(); });
    const { input } = makeInput({ machineTriggered: true });
    const result = await runCodingAgent(input);

    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(6); // 1 + 5 — the pre-cffaa701 budget died at 4
    expect(result.finalText).toContain('5 backoff-and-retry attempts exhausted');
    expect(result.finalText).toContain('rate-limited the request (HTTP 429)');
  });

  it('an OWNER-DISPATCH run (user-classified, machineTriggered false) is unattended too: the machine table, 1 + 5 retries (2026-10-01)', async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS = '1,1,1,1,1';
    mockRunModelTurn.mockImplementation(async () => { throw rateLimitError(); });
    const { input } = makeInput({ machineTriggered: false, ownerDispatch: true });
    const result = await runCodingAgent(input);

    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(6);
    expect(result.finalText).toContain('5 backoff-and-retry attempts exhausted');
  });

  it('a helper FAST-SEAT worker is unattended too: same 5-retry budget', async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS = '1,1,1,1,1';
    mockRunModelTurn.mockImplementation(async () => { throw rateLimitError(); });
    const { input } = makeInput({ fastSeat: true });
    const result = await runCodingAgent(input);

    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(6);
  });

  it('a delegate worker of a MACHINE parent inherits the long table via workerUnattended (review finding: the spread strips machineTriggered for the zero-tool gate — the backoff class alone must survive)', async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS = '1,1,1,1,1';
    mockRunModelTurn.mockImplementation(async () => { throw rateLimitError(); });
    // The delegate spread's exact output shape: machineTriggered stripped,
    // workerUnattended set from the parent's class.
    const { input } = makeInput({ machineTriggered: undefined, workerUnattended: true });
    const result = await runCodingAgent(input);

    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(6);
  });

  it('a delegate worker of a USER parent keeps the short table (machineTriggered stripped, workerUnattended unset — a human is waiting on the parent)', async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1';
    mockRunModelTurn.mockImplementation(async () => { throw rateLimitError(); });
    const { input } = makeInput({ machineTriggered: undefined, workerUnattended: undefined });
    const result = await runCodingAgent(input);

    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
  });

  it('AGENT_TRANSIENT_BACKOFF_MS still overrides EVERY class exactly (back-compat: the existing suites set "1,1,1")', async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1';
    process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS = '9,9,9,9,9'; // must be ignored while the general override is set
    mockRunModelTurn.mockImplementation(async () => { throw rateLimitError(); });
    const { input } = makeInput({ machineTriggered: true });
    const result = await runCodingAgent(input);

    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4); // 1 + 3
    expect(result.finalText).toContain('3 backoff-and-retry attempts exhausted');
  });

  it('a user-turn run keeps the short budget even when only the MACHINE env is set (no leak across classes)', async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1'; // user class reads the general override…
    process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS = '9,9,9,9,9,9,9'; // …never the machine table
    mockRunModelTurn.mockImplementation(async () => { throw rateLimitError(); });
    const { input } = makeInput(); // no machineTriggered / fastSeat → interactive
    const result = await runCodingAgent(input);

    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4); // 1 + 3
  });

  it("Retry-After is HONORED: the provider's stated window becomes the wait floor (capped), and the progress line says so", async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS = '1,1,1,1,1';
    process.env.AGENT_TRANSIENT_RETRY_AFTER_CAP_MS = '3'; // floor min(120s, 3ms) → the test sleeps ~3ms/attempt
    mockRunModelTurn.mockImplementation(async () => { throw rateLimitErrorWithRetryAfter('120'); });
    const { input, emit } = makeInput({ machineTriggered: true });
    const result = await runCodingAgent(input);

    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(6);
    const progress = emit.mock.calls.filter((c) => c[0] === 'progress').map((c) => String(c[1]?.message ?? ''));
    expect(progress.some((m) => m.includes("honoring the provider's Retry-After"))).toBe(true);
  });

  it('without a Retry-After header the progress line carries NO honored-marker (missing header must not change the story)', async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS = '1,1,1,1,1';
    mockRunModelTurn.mockImplementation(async () => { throw rateLimitError(); });
    const { input, emit } = makeInput({ machineTriggered: true });
    await runCodingAgent(input);

    const progress = emit.mock.calls.filter((c) => c[0] === 'progress').map((c) => String(c[1]?.message ?? ''));
    expect(progress.some((m) => m.includes('backing off'))).toBe(true); // the lane ran
    expect(progress.some((m) => m.includes('Retry-After'))).toBe(false);
  });

  it('the honored floor is capped: AGENT_TRANSIENT_RETRY_AFTER_CAP_MS binds a pathological header', async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS = '1,1,1,1,1';
    process.env.AGENT_TRANSIENT_RETRY_AFTER_CAP_MS = '2'; // header says 3600s; the run waits ≤2ms/attempt
    const started = Date.now();
    mockRunModelTurn.mockImplementation(async () => { throw rateLimitErrorWithRetryAfter('3600'); });
    const { input } = makeInput({ machineTriggered: true });
    await runCodingAgent(input);

    expect(Date.now() - started).toBeLessThan(10_000); // un-capped it would park for an hour
    expect(mockRunModelTurn).toHaveBeenCalledTimes(6);
  });
});

/* ── 5. FO firing 48 (2026-09-29): warn attribution into app_error_logs ────
 * The audit's errors_4h readout showed the coding loop's warn classes (turn
 * failures, lead-seat rejections) landing with context=null — untraceable to
 * any session/run. agentWarn now stamps { sessionId, runId, source } as the
 * logger's meta arg (logger's DB transport stores it as context JSON). This
 * drives the same 429 lane as the tests above and pins the meta shape. */
describe('warn attribution (FO firing 48 — app_error_logs context)', () => {
  it('every turn-failed warn carries { sessionId, runId, source } so the app_error_logs row is traceable', async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS = '1,1,1,1,1';
    mockRunModelTurn.mockImplementation(async () => { throw rateLimitError(); });
    const { input } = makeInput({ machineTriggered: true, runId: 'run-f48-attrib' });
    const result = await runCodingAgent(input);

    expect(result.modelErrored).toBe(true); // the lane ran to exhaustion
    const warn = logger.warn as jest.Mock;
    // 2026-10-24 (family 5ae52ca3 review F2): agentWarn moved to the winston
    // OBJECT form (splat-safety — a printf token in the message used to eat the
    // whole meta). The mock now sees ONE argument: the record object.
    const turnFails = warn.mock.calls
      .map((c) => c[0] as any)
      .filter((o) => o && typeof o === 'object' && String(o?.message ?? '').startsWith('coding agent turn failed'));
    expect(turnFails.length).toBe(6); // one per attempt — the exact class the audit saw 24×/4h
    for (const rec of turnFails) {
      expect(rec).toMatchObject({ level: 'warn', sessionId: 'sess-cffaa701', runId: 'run-f48-attrib', source: 'coding-agent' });
    }
  });

  it('a run WITHOUT a runId omits the key entirely (never a null runId string)', async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS = '1,1,1,1,1';
    mockRunModelTurn.mockImplementation(async () => { throw rateLimitError(); });
    const { input } = makeInput({ machineTriggered: true });
    await runCodingAgent(input);

    const warn = logger.warn as jest.Mock;
    const turnFails = warn.mock.calls
      .map((c) => c[0] as any)
      .filter((o) => o && typeof o === 'object' && String(o?.message ?? '').startsWith('coding agent turn failed'));
    expect(turnFails.length).toBeGreaterThan(0);
    for (const rec of turnFails) {
      expect(rec).toMatchObject({ sessionId: 'sess-cffaa701', source: 'coding-agent' });
      expect(rec).not.toHaveProperty('runId');
    }
  });
});

describe('2026-09-29 — a provider QUOTA 403 takes the transient lane (provider-quota.ts)', () => {
  const quota403 = () =>
    Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403, data: Readable.from(['{"error":{"message":"litellm.APIError: APIError: OpenAIException - You\'ve reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends."}}']) },
    });
  it('backs off and retries the SAME request (machine table: 1 + 5), never the shrink lane', async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS = '1,1,1,1,1';
    mockRunModelTurn.mockImplementation(async () => { throw quota403(); });
    const { input } = makeInput({ machineTriggered: true });
    const result = await runCodingAgent(input);
    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(6);
    expect(result.finalText).toContain('5 backoff-and-retry attempts exhausted');
    const outcomes = mockRecordLoopMetric.mock.calls.filter((c: any[]) => c[0]?.kind === 'provider_rejected').map((c: any[]) => c[0]?.meta?.outcome);
    expect(outcomes).not.toContain('shrink_retry');
  });
  it('a quota 403 that clears on the next call recovers the run', async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS = '1,1,1,1,1';
    mockRunModelTurn
      .mockImplementationOnce(async () => { throw quota403(); })
      .mockImplementation(async () => ({ content: 'done — the task is complete.', reasoning: '', toolCalls: [], finishReason: 'stop' }));
    const { input } = makeInput({ machineTriggered: true });
    const result = await runCodingAgent(input);
    expect(result.modelErrored).toBeFalsy();
    expect(mockRunModelTurn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('2026-09-29 — a STATUS-LESS stream abort on a small transcript is transport, not size', () => {
  it('"aborted" with no HTTP status takes the backoff lane (1 + 5), never shrink_retry', async () => {
    process.env.AGENT_TRANSIENT_BACKOFF_MACHINE_MS = '1,1,1,1,1';
    mockRunModelTurn.mockImplementation(async () => { throw new Error('aborted'); });
    const { input } = makeInput({ machineTriggered: true });
    const result = await runCodingAgent(input);
    expect(result.modelErrored).toBe(true);
    expect(result.modelErrorKind).toBe('transient');
    expect(mockRunModelTurn).toHaveBeenCalledTimes(6);
    const outcomes = mockRecordLoopMetric.mock.calls.filter((c: any[]) => c[0]?.kind === 'provider_rejected').map((c: any[]) => c[0]?.meta?.outcome);
    expect(outcomes).not.toContain('shrink_retry');
  });
});

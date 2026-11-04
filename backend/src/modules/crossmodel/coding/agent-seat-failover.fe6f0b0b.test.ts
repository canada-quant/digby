/**
 * Main coding seat transient failover (ticket fe6f0b0b — replay pin).
 *
 * 2026-09-17 ~00:55Z: a user-triggered coding run (chat bed38114, "Rebuild
 * Eric Foundation WordPress Site") whose stamped seat was the custom-endpoint
 * spec '<label>:spark-glm-5.3-flash' (the owner's LiteLLM/vLLM gateway) died
 * with the routing error AS ITS FINAL ANSWER — "The model kept rejecting the
 * request (the model provider returned HTTP 500; provider said:
 * litellm.InternalServerError: OpenAIException - Connection error.. Received
 * Model Group=spark-glm-5.3-flash Available Model Group Fallbacks=None;
 * transcript ~62k chars vs ~160k context budget)" — during a platform deploy
 * window. The transient backoff lane did its job (the gateway outage outlasted
 * the table); the DEFECT was the give-up: the main coding seat had NO failover
 * seam, so a transient provider 500 ended the run outright. The run then sat
 * idle ~2h until a manual supervisor steer revived it.
 *
 * The fix (mirrors the owner-2026-09-15 custom-fallback architecture and the
 * helper-seat failover idiom): when the transient budget is spent on a CODING
 * profile (never the helper tier — its own lane; never chat profiles — their
 * post-turn fallback lives in chat-agent), the loop walks the seat's failover
 * chain ONCE per candidate: the admin's custom fallback for the coding seat
 * (model-roles `coding_default` slot, now fallbackable), then — when the
 * failed seat is a custom endpoint — the built-in glm-5.3 safety net. Each
 * candidate must be servable here (keyless Edge fails closed). Never silent:
 * progress event + transcript part + seat_fallback telemetry + the run
 * result's seatFallback. Kill switch: CODING_SEAT_FALLBACK_DISABLED=1.
 *
 * Scaffold mirrors agent-429-chat-note.6d633649.test.ts (same mock set), plus
 * minimal model-endpoints / model-roles service mocks (run-path consumers use
 * dynamic imports only — no load-time graph impact).
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
const mockNoteSeatFallback: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  noteSeatFallback: (...a: any[]) => mockNoteSeatFallback(...a),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', PROVIDER_REJECTED: 'provider_rejected', SEAT_FALLBACK: 'seat_fallback' },
}));

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
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

// The custom-endpoint registry (dynamic import in coding-model's
// resolveProviderForRun): per-spec resolution for the incident seat and the
// admin's fallback endpoint.
const REGISTRY: Record<string, any> = {
  'spark:spark-glm-5.3-flash': {
    url: 'http://spark.test/v1/chat/completions',
    apiKey: 'spark-key', model: 'spark-glm-5.3-flash', label: 'spark',
    coding: true, thinkingOff: false, supportsVision: false,
  },
  'fb:glm-5p3': {
    url: 'http://fireworks.test/v1/chat/completions',
    apiKey: 'fb-key', model: 'glm-5p3', label: 'fb',
    coding: true, thinkingOff: false, supportsVision: false,
  },
};
const mockResolveRegistryModel: jest.Mock = jest.fn();
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));

// The model-roles store (dynamic import in coding-model's role seams): the
// admin's custom fallback for the coding seat, controlled per test.
const mockResolveRoleFallback: jest.Mock = jest.fn();
const mockResolveRoleModel: jest.Mock = jest.fn();
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleFallback: (...a: any[]) => mockResolveRoleFallback(...a),
  resolveRoleModel: (...a: any[]) => mockResolveRoleModel(...a),
}));

import { runCodingAgent } from './agent';
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

const makeInput = (model: string, extra?: Partial<AgentRunInput>): AgentRunInput => ({
  worktree: '/tmp/seat-failover-fe6f0b0b',
  sessionId: 'sess-fe6f0b0b',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model,
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'earlier question' },
  ] as any,
  userMessage: 'finish the rebuild',
  emit: jest.fn(),
  ...extra,
});

/** The incident's exact rejection: the gateway's LiteLLM-router 500 body. */
const spark500 = () =>
  Object.assign(new Error('Request failed with status code 500'), {
    response: {
      status: 500,
      data: Readable.from(['{"error":{"message":"litellm.InternalServerError: OpenAIException - Connection error.. Received Model Group=spark-glm-5.3-flash Available Model Group Fallbacks=None"}}']),
    },
  });

const FINAL = { content: 'Done — the rebuild is finished.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** Every turn 500s on the incident seat; the failover seat answers. */
const queueIncidentTurns = (failures: number, thenFinal: any = FINAL) => {
  for (let i = 0; i < failures; i += 1) {
    mockRunModelTurn.mockImplementationOnce(async () => { throw spark500(); });
  }
  mockRunModelTurn.mockResolvedValue(thenFinal);
};

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1'; // backoff lane in milliseconds
  process.env.ZAI_API_KEY = 'test-zai-key'; // the built-in glm-5.3 is servable by default
  // Owner 2026-09-17: the LEAD seat now fails over IMMEDIATELY on 429/5xx/billing
  // (helper-seat.ts leadSeatHttpFailure — no backoff burned first). These pins
  // cover the budget-exhaustion SAFETY NET underneath it, so the immediate
  // lane is switched off here; the immediate path has its own pin below and in
  // agent-helper-seat-fallback.test.ts.
  process.env.LEAD_SEAT_FALLBACK_DISABLED = '1';
  mockExecuteCodingTool.mockResolvedValue('probe result: ok');
  mockResolveRegistryModel.mockImplementation(async (spec: string) => REGISTRY[spec] ?? null);
  mockResolveRoleFallback.mockImplementation(async () => ''); // no admin custom fallback by default
  mockResolveRoleModel.mockImplementation(async () => '');
});

afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
  delete process.env.ZAI_API_KEY;
  delete process.env.CODING_SEAT_FALLBACK_DISABLED;
  delete process.env.LEAD_SEAT_FALLBACK_DISABLED;
});

describe('main coding seat transient failover (ticket fe6f0b0b)', () => {
  it('REPLAYS the incident: the spark seat 500s through the backoff budget and the run SURVIVES on the built-in glm-5.3 — never a terminal routing error', async () => {
    queueIncidentTurns(4); // 1 initial + 3 backoff retries (then the failover retry answers)
    const result = await runCodingAgent(makeInput('spark:spark-glm-5.3-flash'));

    // The run recovered — no model death, no "kept rejecting" terminal note.
    expect(result.modelErrored ?? false).toBe(false);
    expect(result.finalText).toContain('Done — the rebuild is finished.');
    expect(result.finalText).not.toContain('kept rejecting the request');

    // 1 initial + 3 backoffs on the dead seat, then the SAME turn retried on glm-5.3.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(5);
    expect(mockRunModelTurn.mock.calls[0][0].url).toBe('http://spark.test/v1/chat/completions');
    expect(mockRunModelTurn.mock.calls[4][0].url).toContain('api.z.ai');

    // Attribution: run result, transcript part, telemetry — never a silent swap.
    expect(result.seatFallback).toMatchObject({
      role: 'coding_default', from: 'spark:spark-glm-5.3-flash', to: 'glm-5.3', status: 'recovered', httpStatus: 500,
    });
    expect(result.parts.some((p: any) => p?.type === 'text' && String(p.text).includes('SEAT FAILOVER'))).toBe(true);
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({
      role: 'coding_default', from: 'spark:spark-glm-5.3-flash', to: 'glm-5.3', status: 'retrying', httpStatus: 500,
    }));
  });

  it("prefers the admin's custom fallback for the coding seat over the built-in safety net", async () => {
    mockResolveRoleFallback.mockImplementation(async (key: string) => (key === 'coding_default' ? 'fb:glm-5p3' : ''));
    queueIncidentTurns(4);
    const result = await runCodingAgent(makeInput('spark:spark-glm-5.3-flash'));

    expect(result.modelErrored ?? false).toBe(false);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(5);
    expect(mockRunModelTurn.mock.calls[4][0].url).toBe('http://fireworks.test/v1/chat/completions');
    expect(result.seatFallback).toMatchObject({ role: 'coding_default', to: 'fb:glm-5p3', customFallback: true });
  });

  it('a BUILT-IN seat with a custom fallback set fails over to it (the built-in leg is skipped — it IS the failed seat)', async () => {
    mockResolveRoleFallback.mockImplementation(async (key: string) => (key === 'coding_default' ? 'fb:glm-5p3' : ''));
    queueIncidentTurns(4);
    const result = await runCodingAgent(makeInput('glm-5.3'));

    expect(result.modelErrored ?? false).toBe(false);
    expect(mockRunModelTurn.mock.calls[0][0].url).toContain('api.z.ai');
    expect(mockRunModelTurn.mock.calls[4][0].url).toBe('http://fireworks.test/v1/chat/completions');
    expect(result.seatFallback).toMatchObject({ role: 'coding_default', from: 'glm-5.3', to: 'fb:glm-5p3', customFallback: true });
  });

  it('no servable candidate (keyless built-in, no custom fallback) → the honest terminal note stands, now NAMING the failed failover attempt', async () => {
    delete process.env.ZAI_API_KEY; // the built-in glm-5.3 cannot serve on this instance
    queueIncidentTurns(4);
    const result = await runCodingAgent(makeInput('spark:spark-glm-5.3-flash'));

    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4); // 1 initial + 3 backoffs — no failover retry
    expect(result.finalText).toContain('kept rejecting the request');
    expect(result.finalText).toContain('Seat failover was attempted (glm-5.3)');
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({
      role: 'coding_default', from: 'spark:spark-glm-5.3-flash', to: 'glm-5.3', status: 'unavailable',
    }));
    expect(result.seatFallback).toBeUndefined();
  });

  it('kill switch: CODING_SEAT_FALLBACK_DISABLED=1 keeps the old terminal behavior', async () => {
    process.env.CODING_SEAT_FALLBACK_DISABLED = '1';
    queueIncidentTurns(4);
    const result = await runCodingAgent(makeInput('spark:spark-glm-5.3-flash'));

    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
    expect(result.finalText).toContain('kept rejecting the request');
    expect(result.finalText).not.toContain('Seat failover');
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  });

  it('never the helper tier: a fastSeat worker on a transient-500 custom seat keeps its own lanes (no main-seat failover)', async () => {
    queueIncidentTurns(4);
    const result = await runCodingAgent(makeInput('spark:spark-glm-5.3-flash', { fastSeat: true }));

    // 429/5xx are NOT helper-seat-fallbackable (they stay on the transient
    // lane) and the main-seat lane excludes fastSeat — the run ends honestly.
    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
    expect(result.seatFallback).toBeUndefined();
  });

  // ── Review-nit regression pins (sub-session 686bfe19, MERGE-SAFE + 4 nits) ──

  it('nit 2: a DEAD custom-fallback spec is skipped (never serves under a dead name) — the built-in leg fails over properly labeled', async () => {
    // The admin's fallback 'fb:dead' is NOT in the registry (endpoint removed):
    // resolveProviderForRun falls through to the built-in glm-5.3 (fail-open) —
    // the lane must NOT latch it under the 'fb:dead' name. The built-in leg then
    // offers glm-5.3 properly labeled.
    mockResolveRoleFallback.mockImplementation(async (key: string) => (key === 'coding_default' ? 'fb:dead' : ''));
    queueIncidentTurns(4);
    const result = await runCodingAgent(makeInput('spark:spark-glm-5.3-flash'));

    expect(result.modelErrored ?? false).toBe(false);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(5);
    expect(mockRunModelTurn.mock.calls[4][0].url).toContain('api.z.ai');
    expect(result.seatFallback).toMatchObject({ role: 'coding_default', to: 'glm-5.3', status: 'recovered' });
    expect(result.seatFallback!.to).not.toBe('fb:dead');
    // The misconfigured fallback is telemetered as unavailable — the admin signal.
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({
      role: 'coding_default', to: 'fb:dead', status: 'unavailable',
    }));
  });

  it('nit 3: a custom fallback that IS the built-in glm-5.3 is probed ONCE (chain dedupe)', async () => {
    delete process.env.ZAI_API_KEY; // glm-5.3 cannot serve here
    mockResolveRoleFallback.mockImplementation(async (key: string) => (key === 'coding_default' ? 'glm-5.3' : ''));
    queueIncidentTurns(4);
    const result = await runCodingAgent(makeInput('spark:spark-glm-5.3-flash'));

    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4); // no failover retry
    // Chain was [glm-5.3 (custom), glm-5.3 (built-in)] — the dedupe skips the
    // second occurrence: ONE probe, ONE 'unavailable' telemetry row.
    const unavailable = mockNoteSeatFallback.mock.calls.filter((c) => c[0]?.status === 'unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0][0]).toMatchObject({ role: 'coding_default', to: 'glm-5.3' });
    expect(result.finalText).toContain('Seat failover was attempted (glm-5.3)');
    expect(result.finalText).not.toContain('glm-5.3 / glm-5.3');
  });

  it('nit 4: the kill switch accepts true/on (parser mirrors the helper sibling)', async () => {
    process.env.CODING_SEAT_FALLBACK_DISABLED = 'true';
    queueIncidentTurns(4);
    const result = await runCodingAgent(makeInput('spark:spark-glm-5.3-flash'));

    expect(result.modelErrored).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  });
});

describe('immediate lead fallback (owner 2026-09-17) layered ABOVE the budget-exhaustion safety net', () => {
  it('with the immediate lane ON, the spark seat\'s FIRST 500 already moves the turn to glm-5.3 — no backoff budget burned, same attribution contract', async () => {
    delete process.env.LEAD_SEAT_FALLBACK_DISABLED;
    queueIncidentTurns(1);
    const result = await runCodingAgent(makeInput('spark:spark-glm-5.3-flash'));
    expect(result.modelErrored ?? false).toBe(false);
    expect(result.finalText).toContain('Done — the rebuild is finished.');
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(mockRunModelTurn.mock.calls[0][0].url).toBe('http://spark.test/v1/chat/completions');
    expect(mockRunModelTurn.mock.calls[1][0].url).toContain('api.z.ai');
    expect(result.seatFallback).toMatchObject({ role: 'coding_default', from: 'spark:spark-glm-5.3-flash', to: 'glm-5.3', status: 'recovered', httpStatus: 500, reason: 'HTTP 500' });
    expect(result.parts.some((p: any) => p?.type === 'text' && String(p.text).includes('SEAT FAILOVER'))).toBe(true);
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({ role: 'coding_default', to: 'glm-5.3', status: 'retrying', httpStatus: 500, caller: 'lead' }));
  });

  it('CODING_SEAT_FALLBACK_DISABLED=1 switches the immediate lane off as well (an operator who disables seat fallback means all of it)', async () => {
    delete process.env.LEAD_SEAT_FALLBACK_DISABLED;
    process.env.CODING_SEAT_FALLBACK_DISABLED = '1';
    queueIncidentTurns(4);
    const result = await runCodingAgent(makeInput('spark:spark-glm-5.3-flash'));
    expect(result.modelErrored).toBe(true);
    expect(result.seatFallback).toBeUndefined();
  });

  // FO firing 38 (2026-09-28): the Moonshot kimi-k3 account was suspended for
  // insufficient balance (HTTP 429 body "exceeded_current_quota_error") from
  // ~22:00Z — every coding lead turn 429'd, failed over sticky to
  // cql-litellm, and the run SURVIVED. 17 warns + seat_fallback rows over 4 h,
  // ZERO owner tickets: the 2026-08-25 run-death 'billing' ticket
  // (agent.ts modelError lane) never fires when a healthy fallback absorbs
  // the suspension. This pin: the FIRST sticky fallback files ONE deduped
  // owner-action ticket (title-deduped against the run-death ticket), and the
  // kill switch suppresses only the ticket, never the failover.
  it('ABSORBED billing: the sticky 429 suspension fails over, the run SURVIVES, and ONE owner-action ticket files (the run-death path never ran)', async () => {
    delete process.env.LEAD_SEAT_FALLBACK_DISABLED;
    // The exact prod body (app_error_logs 2026-09-28 02:29:12Z): Moonshot
    // serves the suspension as HTTP 429 with a billing body.
    const billing429 = () =>
      Object.assign(new Error('Request failed with status code 429 (HTTP 429) body: {"error":{"message":"Your account org-b71a956942b14d278e02e662dc2d70aa <ak-f8chbnq3k3wi11gkuxri> is suspended due to insufficient balance, please recharge your account or check your plan and billing details","type":"exceeded_current_quota_error"}}'), {
        response: { status: 429, data: Readable.from(['{"error":{"message":"suspended due to insufficient balance, please recharge your account or check your plan and billing details"}}']) },
      });
    mockRunModelTurn.mockImplementationOnce(async () => { throw billing429(); });
    mockRunModelTurn.mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput('spark:spark-glm-5.3-flash'));
    expect(result.modelErrored ?? false).toBe(false);
    expect(result.finalText).toContain('Done — the rebuild is finished.');
    expect(result.seatFallback).toMatchObject({ status: 'recovered', reason: 'billing', httpStatus: 429 });
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(mockFileFeedbackTicket).toHaveBeenCalledWith(expect.objectContaining({
      type: 'mishap',
      priority: 5,
      area: 'owner-action',
      title: 'PROVIDER BILLING OUTAGE — model account suspended for insufficient balance (owner recharge needed)',
    }));
  });

  });

// Autonomy loop #3 (2026-09-19): Z.AI rate-limited glm-5.3 for three hours —
// 210 rejected lead turns across 16 sessions. The immediate lane above moved
// each turn to a sibling seat, but the revert path re-probed the chosen seat
// on EVERY step, so every step paid one rejected round trip (which itself
// counted against the provider's per-minute budget). The breaker below.
describe('provider cooldown breaker (autonomy loop #3) — a rate-limited provider stops being probed every step', () => {
  const zai429 = () =>
    Object.assign(new Error('Request failed with status code 429'), {
      response: { status: 429, data: Readable.from(['{"error":{"code":"1302","message":"Rate limit reached for requests"}}']) },
    });
  const rejectOnceThenFinal = () => {
    mockRunModelTurn.mockImplementationOnce(async () => { throw zai429(); });
    mockRunModelTurn.mockResolvedValue(FINAL);
  };

  beforeEach(() => {
    delete process.env.LEAD_SEAT_FALLBACK_DISABLED; // the immediate lane is ON
    process.env.DEEPSEEK_API_KEY = 'test-ds-key'; // the first built-in sibling of glm-5.3 is servable
    const { __resetProviderCooldownForTests } = jest.requireActual('./provider-cooldown');
    __resetProviderCooldownForTests();
  });
  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
    const { __resetProviderCooldownForTests } = jest.requireActual('./provider-cooldown');
    __resetProviderCooldownForTests();
  });

  it('three 429s trip the breaker; the next run on that seat STARTS on the fallback with zero calls to the rate-limited provider, honestly attributed', async () => {
    for (let i = 0; i < 3; i += 1) {
      rejectOnceThenFinal();
      const r = await runCodingAgent(makeInput('glm-5.3'));
      expect(r.finalText).toContain('Done — the rebuild is finished.');
      expect(mockRunModelTurn.mock.calls[0][0].url).toContain('api.z.ai'); // probed, rejected…
      expect(mockRunModelTurn.mock.calls[1][0].url).toContain('api.deepseek.com'); // …fell back
      mockRunModelTurn.mockClear();
    }
    // Fourth run: the breaker holds — no probe of api.z.ai at all.
    mockRunModelTurn.mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput('glm-5.3'));
    expect(result.finalText).toContain('Done — the rebuild is finished.');
    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
    expect(mockRunModelTurn.mock.calls[0][0].url).toContain('api.deepseek.com');
    expect(result.seatFallback).toMatchObject({ role: 'coding_default', from: 'glm-5.3', to: 'deepseek-flash', status: 'recovered', httpStatus: 429 });
    expect(result.parts.some((p: any) => p?.type === 'text' && /SEAT FAILOVER.*cooling down/.test(String(p.text)))).toBe(true);
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({ role: 'coding_default', to: 'deepseek-flash', reason: 'HTTP 429 (provider cooldown)', caller: 'lead' }));
  });

  });

describe('lead-effort A/B — effortCap reaches the request (2026-10-04)', () => {
  it("caps the built-in seat's 'max' to 'high' on the lead AND on the failover seat", async () => {
    queueIncidentTurns(4);
    await runCodingAgent(makeInput('spark:spark-glm-5.3-flash', { effortCap: 'high' }));
    const efforts = mockRunModelTurn.mock.calls.map((c: any[]) => c[0]?.extra?.reasoning_effort);
    // the failover built-in glm-5.3 sends 'max' by itself — the cap lowers it to 'high'
    expect(efforts[4]).toBe('high');
    expect(efforts.every((e: unknown) => e === undefined || e === 'high')).toBe(true);
  });

  it("no cap = today's request (the built-in keeps 'max')", async () => {
    queueIncidentTurns(4);
    await runCodingAgent(makeInput('spark:spark-glm-5.3-flash'));
    expect(mockRunModelTurn.mock.calls[4][0]?.extra?.reasoning_effort).toBe('max');
  });
});

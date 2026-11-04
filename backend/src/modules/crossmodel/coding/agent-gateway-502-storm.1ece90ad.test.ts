/**
 * Log-signal ticket 1ece90ad — characterization replay pin.
 *
 * The sweep fingerprint (2026-10-24, 32 warn rows across 8 distinct hours):
 *   coding agent [Digby]: lead seat llm-cql (custom endpoint)
 *   (llm-cql:api-optimize-zai-glm-5.3) rejected the turn (HTTP 502) — this
 *   turn on glm-5.3
 *
 * ADJUDICATION (lane 1f46af47, 2026-10-25): DESIGNED OBSERVABILITY, not a
 * defect. The llm.example.com gateway (CF tunnel → LiteLLM) flapped in short
 * bursts (502s ~13:37, ~17:01; 524s ~14:46–15:01 — Cloudflare's ~100 s
 * wall). Every resilience layer did its job on every row:
 *   • the lead-seat fallback moved each rejected turn to the built-in
 *     glm-5.3 and the run SURVIVED — zero error-level rows in the window
 *     (level=error search for "llm-cql": total 0), no run deaths;
 *   • the process-local cooldown breaker tripped in EVERY dense burst
 *     (6 "tripped the cooldown breaker (3 rejections in 120 s)" rows, ladder
 *     180→360 s visible: 10:15→until 10:18:29, 10:20→until 10:26:00);
 *   • same-endpoint candidates are deferred behind off-endpoint ones on a
 *     gateway 5xx (audit 2026-10-06 T1-6);
 *   • the sparse 524 probes (~6–9 min apart, one per run) can never trip a
 *     breaker that needs 3 strikes inside 120 s — by design: a probe after
 *     each cooldown lapse is how the primary is re-admitted.
 * The signal stopped at 17:02Z (7 h before triage) and the gateway answered
 * 200 in 0.14 s at triage time. Nothing to fix in the repo; this pin locks
 * the composite contract the sweep measured so a future regression in ANY of
 * those layers fails HERE first, naming this ticket.
 *
 * Scaffold mirrors agent-seat-failover.fe6f0b0b.test.ts (same mock set).
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
// The REAL kinds registry (loop-metric-kinds.ts is an import-free leaf): the
// stub shape below would hand recordLoopMetric `kind: undefined` for the
// breaker's PROVIDER_COOLDOWN row — which this suite asserts.
jest.mock('../platform/loop-metric-kinds', () => jest.requireActual('../platform/loop-metric-kinds'));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  noteSeatFallback: (...a: any[]) => mockNoteSeatFallback(...a),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: jest.requireActual('../platform/loop-metric-kinds').LOOP_METRIC_KINDS,
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

// The incident gateway: llm.example.com (label 'llm-cql' — coding-model.ts appends
// ' (custom endpoint)', so the warn replays the prod fingerprint verbatim).
const GW_URL = 'https://llm.example.com/v1/chat/completions';
const REGISTRY: Record<string, any> = {
  'llm-cql:api-optimize-zai-glm-5.3': {
    url: GW_URL, apiKey: 'sk-cql', model: 'api-optimize-zai-glm-5.3', label: 'llm-cql',
    coding: true, thinkingOff: false, supportsVision: false,
  },
  'llm-cql:api-optimize-alibaba-deepseek-v4.1-flash': {
    url: GW_URL, apiKey: 'sk-cql', model: 'api-optimize-alibaba-deepseek-v4.1-flash', label: 'llm-cql',
    coding: true, thinkingOff: false, supportsVision: false,
  },
  'llm-cql:api-optimize-moonshot-kimi-k3': {
    url: GW_URL, apiKey: 'sk-cql', model: 'api-optimize-moonshot-kimi-k3', label: 'llm-cql',
    coding: true, thinkingOff: false, supportsVision: false,
  },
};
const mockResolveRegistryModel: jest.Mock = jest.fn();
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));

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
import logger from '../../../utils/logger';

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
  worktree: '/tmp/agent-gateway-502-1ece90ad',
  sessionId: 'sess-1ece90ad',
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
  userMessage: 'finish the work',
  emit: jest.fn(),
  ...extra,
});

/** The prod rejection: the gateway answers 502 (Cloudflare/LiteLLM edge). */
const gw502 = () =>
  Object.assign(new Error('Request failed with status code 502'), {
    response: {
      status: 502,
      data: Readable.from(['{"error":{"message":"litellm.NotFoundError: Gateway error — upstream connection failed"}}']),
    },
  });

const FINAL = { content: 'Done — the work is finished.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** One prod-shaped run: the lead turn rejects once, the fallback answers. */
const rejectOnceThenFinal = () => {
  mockRunModelTurn.mockImplementationOnce(async () => { throw gw502(); });
  mockRunModelTurn.mockResolvedValue(FINAL);
};

const warnMessages = (): string[] => (logger.warn as unknown as jest.Mock).mock.calls.map((c: any[]) => String(c[0]?.message ?? ''));

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1';
  process.env.ZAI_API_KEY = 'test-zai-key'; // the built-in glm-5.3 is servable
  // Prod-default posture for EVERY switch this suite's behavior depends on —
  // sibling suites set some of these and never clear them (jest sandboxes
  // per-file today, but suite order is size-based and one bump away).
  delete process.env.LEAD_SEAT_FALLBACK_DISABLED; // the immediate lane is ON (prod default)
  delete process.env.CODING_SEAT_FALLBACK_DISABLED;
  delete process.env.SEAT_FALLBACK_SAME_ENDPOINT_LAST_DISABLED;
  mockExecuteCodingTool.mockResolvedValue('probe result: ok');
  mockResolveRegistryModel.mockImplementation(async (spec: string) => REGISTRY[spec] ?? null);
  mockResolveRoleFallback.mockImplementation(async () => ''); // prod shape: no admin custom fallback set
  mockResolveRoleModel.mockImplementation(async () => '');
  const { __resetProviderCooldownForTests } = jest.requireActual('./provider-cooldown');
  __resetProviderCooldownForTests();
});

afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
  delete process.env.ZAI_API_KEY;
  delete process.env.LEAD_SEAT_FALLBACK_DISABLED;
  delete process.env.CODING_SEAT_FALLBACK_DISABLED;
  delete process.env.SEAT_FALLBACK_SAME_ENDPOINT_LAST_DISABLED;
  const { __resetProviderCooldownForTests } = jest.requireActual('./provider-cooldown');
  __resetProviderCooldownForTests();
});

describe('log-signal 1ece90ad — llm.example.com gateway 502 flap (2026-10-24): designed resilience, characterized', () => {
  it('REPLAYS the prod row verbatim: the custom-endpoint lead seat 502s, the turn moves to the built-in glm-5.3, the run SURVIVES, and the warn IS the fingerprint', async () => {
    rejectOnceThenFinal();
    const result = await runCodingAgent(makeInput('llm-cql:api-optimize-zai-glm-5.3'));

    // The run recovered — no model death (the 24h window had ZERO error-level rows).
    expect(result.modelErrored ?? false).toBe(false);
    expect(result.finalText).toContain('Done — the work is finished.');

    // The rejected turn on the gateway, then the SAME turn on the built-in.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(mockRunModelTurn.mock.calls[0][0].url).toBe(GW_URL);
    expect(mockRunModelTurn.mock.calls[1][0].url).toContain('api.z.ai');

    // The exact app_error_logs fingerprint the sweep filed (newest prod row,
    // 2026-10-24T17:02:00.301Z) — warn-level, source coding-agent.
    expect(warnMessages()).toContain(
      'coding agent [Digby]: lead seat llm-cql (custom endpoint) (llm-cql:api-optimize-zai-glm-5.3) rejected the turn (HTTP 502) — this turn on glm-5.3',
    );

    // Attribution contract (fe6f0b0b): run result + telemetry, never silent.
    expect(result.seatFallback).toMatchObject({
      role: 'coding_default', from: 'llm-cql:api-optimize-zai-glm-5.3', to: 'glm-5.3', status: 'recovered', httpStatus: 502, reason: 'HTTP 502',
    });
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({
      role: 'coding_default', from: 'llm-cql:api-optimize-zai-glm-5.3', to: 'glm-5.3', status: 'retrying', httpStatus: 502, caller: 'lead',
    }));
  });

  it('the sibling fingerprint (same gateway, alibaba-flash seat) warns the same shape — one root cause, the gateway, not the model', async () => {
    rejectOnceThenFinal();
    const result = await runCodingAgent(makeInput('llm-cql:api-optimize-alibaba-deepseek-v4.1-flash'));

    expect(result.modelErrored ?? false).toBe(false);
    expect(mockRunModelTurn.mock.calls[0][0].url).toBe(GW_URL);
    expect(mockRunModelTurn.mock.calls[1][0].url).toContain('api.z.ai');
    expect(warnMessages()).toContain(
      'coding agent [Digby]: lead seat llm-cql (custom endpoint) (llm-cql:api-optimize-alibaba-deepseek-v4.1-flash) rejected the turn (HTTP 502) — this turn on glm-5.3',
    );
  });

  it('a same-gateway custom fallback is DEFERRED behind the off-endpoint built-in (T1-6 composite through the loop)', async () => {
    // The admin fallback points at the SAME gateway (a different model on
    // llm-cql): a 502 is the GATEWAY failing, so the off-endpoint built-in
    // serves first and the same-label candidate is only telemetered deferred.
    mockResolveRoleFallback.mockImplementation(async (key: string) => (key === 'coding_default' ? 'llm-cql:api-optimize-moonshot-kimi-k3' : ''));
    rejectOnceThenFinal();
    const result = await runCodingAgent(makeInput('llm-cql:api-optimize-zai-glm-5.3'));

    expect(result.modelErrored ?? false).toBe(false);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(mockRunModelTurn.mock.calls[0][0].url).toBe(GW_URL);
    // The pin: WITHOUT orderFallbackCandidates's deferral the admin's custom
    // spec is FIRST in the candidate list and would serve — these two asserts
    // (model id + no customFallback flag) are what make the deferral carry.
    expect(mockRunModelTurn.mock.calls[1][0].model).toBe('glm-5.3');
    expect(mockRunModelTurn.mock.calls[1][0].url).toContain('api.z.ai'); // off-endpoint FIRST — not the same-gateway kimi
    expect(result.seatFallback).not.toHaveProperty('customFallback');
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({
      role: 'coding_default', to: 'glm-5.3', status: 'retrying', httpStatus: 502,
      sameEndpointDeferred: ['llm-cql:api-optimize-moonshot-kimi-k3'],
    }));
  });

  it('the storm is BOUNDED at run start: three rejected runs trip the process-local breaker and the FOURTH run starts on glm-5.3 with zero gateway probes', async () => {
    // Three one-strike runs (the prod bursts were exactly this shape: 3
    // rejections inside 120 s → trip; six trip rows on 2026-10-24).
    for (let i = 0; i < 3; i += 1) {
      rejectOnceThenFinal();
      const r = await runCodingAgent(makeInput('llm-cql:api-optimize-zai-glm-5.3'));
      expect(r.finalText).toContain('Done — the work is finished.');
      expect(mockRunModelTurn.mock.calls[0][0].url).toBe(GW_URL); // probed, rejected…
      expect(mockRunModelTurn.mock.calls[1][0].url).toContain('api.z.ai'); // …fell back
      mockRunModelTurn.mockClear();
    }

    // The trip warn the sweep's sibling rows showed (cooldown-breaker telemetry).
    expect(warnMessages().some((m) => m.includes('provider llm-cql (custom endpoint) tripped the cooldown breaker (3 rejections in 120 s)'))).toBe(true);
    // The trip telemeters exactly one provider_cooldown loop metric naming the
    // gateway and the hold (the run-start pre-seat stamps httpStatus 429 as the
    // cooldown CLASS — the 502s that tripped it are in the trip warn above).
    const cooldownMetrics = mockRecordLoopMetric.mock.calls
      .map((c: any[]) => c[0])
      .filter((m: any) => m?.kind === 'provider_cooldown');
    expect(cooldownMetrics).toHaveLength(1);
    expect(cooldownMetrics[0].meta).toMatchObject({ provider: 'llm-cql (custom endpoint)', httpStatus: 502 });

    // Fourth run: the breaker holds — NO probe of the gateway at all.
    mockRunModelTurn.mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput('llm-cql:api-optimize-zai-glm-5.3'));
    expect(result.finalText).toContain('Done — the work is finished.');
    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
    expect(mockRunModelTurn.mock.calls[0][0].url).toContain('api.z.ai');
    expect(mockRunModelTurn.mock.calls.every((c: any[]) => !String(c[0]?.url ?? '').includes('llm.example.com'))).toBe(true);
    // httpStatus 429 here is the cooldown CLASS the run-start pre-seat stamps
    // (agent.ts run-start lane) — the 502s that tripped it are in the warn above.
    expect(result.seatFallback).toMatchObject({ role: 'coding_default', from: 'llm-cql:api-optimize-zai-glm-5.3', to: 'glm-5.3', status: 'recovered', httpStatus: 429 });
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({
      role: 'coding_default', to: 'glm-5.3', reason: 'HTTP 429 (provider cooldown)', caller: 'lead',
    }));
  });
});

// ── Log-signal family lane 92dc54d6 — ticket 5eea44df (2026-10-26) ──────────────
// The moonshot-kimi-k3 variant of the 1ece90ad gateway-502 class: 7 rows/24h
// (Oct 25, 16:21–19:36Z) of
//   coding agent [Digby]: lead seat llm-cql (custom endpoint)
//   (llm-cql:api-optimize-moonshot-kimi-k3) rejected the turn (HTTP 502) —
//   this turn on glm-5.3
// Adjudication (lane 92dc54d6, 2026-10-27): NOT a framework defect — the
// SAME class as 1ece90ad (zai-glm-5.3 seat) and its alibaba-flash sibling:
// one gateway (llm.example.com, the owner's Cloudflare-fronted edge), one
// resilience contract (the SAME turn moves to the off-endpoint built-in and
// the run survives — zero error-level rows in the 24h windows). The seat name
// in the fingerprint is the only difference; this block adds the kimi-k3
// seat so THIS ticket's own fingerprint is replayed by name (its id-named
// pin for closure) under the same harness the 1ece90ad suite built.
describe('log-signal 5eea44df — the kimi-k3 seat variant of the gateway-502 class (one gateway, one resilience contract)', () => {
  it('REPLAYS the prod row: the moonshot-kimi-k3 seat on llm.example.com 502s and the SAME turn answers on glm-5.3 — the run survives, the warn IS the fingerprint', async () => {
    rejectOnceThenFinal();
    const result = await runCodingAgent(makeInput('llm-cql:api-optimize-moonshot-kimi-k3'));

    expect(result.modelErrored ?? false).toBe(false);
    expect(result.finalText).toContain('Done — the work is finished.');
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(mockRunModelTurn.mock.calls[0][0].url).toBe(GW_URL);
    expect(mockRunModelTurn.mock.calls[1][0].url).toContain('api.z.ai');
    expect(warnMessages()).toContain(
      'coding agent [Digby]: lead seat llm-cql (custom endpoint) (llm-cql:api-optimize-moonshot-kimi-k3) rejected the turn (HTTP 502) — this turn on glm-5.3',
    );
  });
});

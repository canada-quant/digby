/**
 * 2026-09-27 seat/provider limits — REPLAY of the gpt-6-astra incident through
 * the agent loop.
 *
 * Prod (2026-09-27 18:26–18:45Z): the Fleet Supervisor seated on
 * `cql-litellm:api-openai-gpt-6-astra` 400'd EVERY turn for 6 h — 48
 * provider_rejected rows — "Invalid 'tools': array too long. Expected an array
 * with maximum length 128, but got an array with length 195", then (with fewer
 * tools) "Function tools with reasoning_effort are not supported …". Only
 * 429/5xx/billing moved the lead seat; a 400 went to the backoff + shrink lanes
 * and was re-sent to the same model, wake after wake.
 *
 * Pins now: (1) the list sent on the first call already FITS the provider's cap
 * — the OpenAI class's DOCUMENTED 128 on the registry entry — through
 * PROGRESSIVE TOOL DISCLOSURE (core + the gateway pair, never a trim; 2026-09-27
 * late); (2) a 400 that names a SMALLER cap is LEARNED and the turn re-sent once
 * with the list re-fitted to it (a cap below the core falls to the residual
 * priority trim, telemetered with the HONEST source 'learned'); (3) the next
 * deterministic 400 LATCHES the seat and moves the REST OF THE RUN to the seat's
 * custom fallback / the built-in order (pickLeadFallback, the 429 path) — never a
 * silent swap (progress + transcript note + seat_fallback row with the
 * fingerprint + latchedUntil); (4) a NEW run on the latched seat starts on the
 * fallback WITHOUT probing the seat; (5) the seat role rides the run so the
 * SUPERVISOR seat's custom fallback is the one consulted; (6) the kill switch
 * restores the capability fail-fast; (7) with no servable fallback the run fails
 * fast (never the 7-retry crawl) and the latch still records.
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
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  noteSeatFallback: (...a: any[]) => mockNoteSeatFallback(...a),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', PROVIDER_REJECTED: 'provider_rejected', SEAT_FALLBACK: 'seat_fallback', PROVIDER_COOLDOWN: 'provider_cooldown', TOOL_LIST_TRIMMED: 'tool_list_trimmed', TOOL_GROUPS: 'tool_groups' },
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

/** The incident seat (an OpenAI-like id behind the owner's LiteLLM proxy) + the admin's custom fallback for the SUPERVISOR seat. */
const REGISTRY: Record<string, any> = {
  'cql-litellm:api-openai-gpt-6-astra': {
    url: 'https://llm.cql.ca/v1/chat/completions', baseUrl: 'https://llm.cql.ca/v1',
    apiKey: 'sk-cql', model: 'api-openai-gpt-6-astra', label: 'cql-litellm',
    coding: true, chatCapable: true, kind: 'chat', thinkingOff: false, supportsVision: false,
    providerClass: 'openai', maxTools: 128, maxToolsSource: 'class', reasoningEffort: 'auto',
  },
  'cql-litellm:api-anthropic-claude-fable-5-1': {
    url: 'https://llm.cql.ca/v1/chat/completions', baseUrl: 'https://llm.cql.ca/v1',
    apiKey: 'sk-cql', model: 'api-anthropic-claude-fable-5-1', label: 'cql-litellm',
    coding: true, chatCapable: true, kind: 'chat', thinkingOff: false, supportsVision: false,
    providerClass: 'anthropic', maxToolsSource: 'none', reasoningEffort: 'auto',
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
import { __resetSeatInvalidRequestLatchesForTests, listSeatInvalidRequestLatches, seatInvalidRequestLatch } from './seat-invalid-request';
import { __resetLearnedToolLimitsForTests, learnedToolLimit, toolLimitKey } from './provider-limits';
import { __resetProviderCooldownForTests } from './provider-cooldown';

const PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 90_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const SEAT = 'cql-litellm:api-openai-gpt-6-astra';
const makeInput = (extra?: Partial<AgentRunInput>): AgentRunInput => ({
  worktree: '/tmp/seat-invalid-request',
  sessionId: 'sess-astra',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: SEAT,
  seatRole: 'supervisor',
  projectName: 'test',
  branch: 'chat',
  profile: PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [] as any,
  userMessage: 'sweep the fleet',
  emit: jest.fn(),
  ...extra,
});

const TOOLS_TOO_LONG_64 = "litellm.BadRequestError: OpenAIException - Invalid 'tools': array too long. Expected an array with maximum length 64, but got an array with length 128.";
const TOOLS_TOO_LONG_128 = "litellm.BadRequestError: OpenAIException - Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 195.";
const EFFORT_400 = "litellm.BadRequestError: OpenAIException - Function tools with reasoning_effort are not supported for gpt-6-astra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";
const http400 = (body: string) => Object.assign(new Error('Request failed with status code 400'), {
  response: { status: 400, data: Readable.from([`{"error":{"message":${JSON.stringify(body)}}}`]) },
});
const FINAL = { content: 'SWEEP: no-op — nothing needs me.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  __resetSeatInvalidRequestLatchesForTests();
  __resetLearnedToolLimitsForTests();
  __resetProviderCooldownForTests();
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1';
  process.env.ZAI_API_KEY = 'test-zai-key'; // the built-in glm-5.3 is servable
  delete process.env.CUSTOM_ENDPOINT_TOOLS_MAX;
  mockExecuteCodingTool.mockResolvedValue('probe result: ok');
  mockResolveRegistryModel.mockImplementation(async (spec: string) => REGISTRY[spec] ?? null);
  mockResolveRoleFallback.mockImplementation(async () => '');
  mockResolveRoleModel.mockImplementation(async () => '');
});

afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
  delete process.env.ZAI_API_KEY;
});

const toolNames = (call: any[]): string[] => (call[2] ?? []).map((t: any) => t?.function?.name);

describe('deterministic-4xx seat fallback + latch (the gpt-6-astra incident)', () => {
  it('REPLAYS the incident: trim → learned cap re-send → latch + sticky fallback on the supervisor seat', async () => {
    mockRunModelTurn
      .mockImplementationOnce(async () => { throw http400(TOOLS_TOO_LONG_64); })   // call 1: ≤128 tools sent (core + gateway), the body says the cap is 64
      .mockImplementationOnce(async () => { throw http400(EFFORT_400); })          // call 2: 64 tools, the proxy's injected effort is refused
      .mockResolvedValue(FINAL);                                                    // call 3+: the fallback seat answers
    const result = await runCodingAgent(makeInput());

    expect(result.modelErrored ?? false).toBe(false);
    expect(result.finalText).toContain('SWEEP: no-op');
    expect(mockRunModelTurn).toHaveBeenCalledTimes(3);

    // (1) the FIRST call already FITS the registry's documented 128 (OpenAI class)
    //     — progressive disclosure: the core + the two gateway tools, no trim row,
    //     every core tool present.
    const first = mockRunModelTurn.mock.calls[0];
    expect(first[0].url).toBe('https://llm.cql.ca/v1/chat/completions');
    expect(first[2].length).toBeLessThanOrEqual(128);
    expect(toolNames(first)).toEqual(expect.arrayContaining(['read_file', 'run_command', 'search_engine', 'ask_user', 'list_tool_groups', 'load_tools']));
    expect(toolNames(first)).not.toContain('gmail_search'); // a connector group, on demand
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'tool_list_trimmed', meta: expect.objectContaining({ limit: 128 }) }));
    // (the run's ONE tool_groups row reads the LAST cap in force — 64 after the learned cap below)
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tool_groups', meta: expect.objectContaining({ cap: 64, evicted: [], loaded: [] }) }));

    // (2) the 400 named 64 — learned, re-sent ONCE with ≤64 tools on the SAME seat;
    //     64 is below the core, so the residual priority trim runs with the
    //     HONEST source 'learned' (the only trim row this run writes).
    const second = mockRunModelTurn.mock.calls[1];
    expect(second[0].url).toBe('https://llm.cql.ca/v1/chat/completions');
    expect(second[2]).toHaveLength(64);
    expect(learnedToolLimit(toolLimitKey('https://llm.cql.ca/v1/chat/completions', 'api-openai-gpt-6-astra'))).toBe(64);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tool_list_trimmed', meta: expect.objectContaining({ limit: 64, to: 64, source: 'learned', mode: 'core_residual' }) }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'provider_rejected', meta: expect.objectContaining({ lane: 'invalid_request', fingerprint: 'tools_too_long', outcome: 'trim_retry', cap: 64 }) }));

    // (3) the effort 400 LATCHES the seat and the rest of the run moves to the built-in glm-5.3.
    expect(mockRunModelTurn.mock.calls[2][0].url).toContain('api.z.ai');
    const latch = seatInvalidRequestLatch(SEAT)!;
    expect(latch).toMatchObject({ kind: 'reasoning_effort_unsupported', status: 400, strikes: 1 });
    expect(result.seatFallback).toMatchObject({ role: 'supervisor', from: SEAT, to: 'glm-5.3', status: 'recovered', httpStatus: 400 });
    expect(String(result.seatFallback!.reason)).toMatch(/^invalid_request:reasoning_effort_unsupported/);
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({
      role: 'supervisor', from: SEAT, to: 'glm-5.3', status: 'retrying', httpStatus: 400,
      fingerprint: 'reasoning_effort_unsupported', latchedUntil: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'provider_rejected', meta: expect.objectContaining({ lane: 'invalid_request', fingerprint: 'reasoning_effort_unsupported', outcome: 'seat_fallback' }) }));
    const note = result.parts.find((p: any) => p?.type === 'text' && String(p.text).includes('SEAT FAILOVER')) as any;
    expect(note).toBeTruthy();
    expect(note.text).toContain('deterministically');
    expect(note.text).toContain('reasoning_effort: none');
    // (5) the SUPERVISOR seat's custom fallback was the one consulted, not coding_default's.
    expect(mockResolveRoleFallback).toHaveBeenCalledWith('supervisor');
    // never the 7-retry crawl: no transient backoff, no shrink
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it("prefers the SUPERVISOR seat's admin custom fallback (another chat-capable registry model) over the built-in order", async () => {
    mockResolveRoleFallback.mockImplementation(async (key: string) => (key === 'supervisor' ? 'cql-litellm:api-anthropic-claude-fable-5-1' : ''));
    mockRunModelTurn
      .mockImplementationOnce(async () => { throw http400(EFFORT_400); })
      .mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput());
    expect(result.modelErrored ?? false).toBe(false);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(mockRunModelTurn.mock.calls[1][0].model).toBe('api-anthropic-claude-fable-5-1');
    // the Anthropic-class fallback has NO known cap (Anthropic documents none) and
    // the blanket default is gone (2026-09-27 late): the FULL list goes, untrimmed,
    // and nothing was learned for it.
    expect(mockRunModelTurn.mock.calls[1][2].length).toBeGreaterThan(128);
    expect(learnedToolLimit(toolLimitKey('https://llm.cql.ca/v1/chat/completions', 'api-anthropic-claude-fable-5-1'))).toBeUndefined();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'tool_list_trimmed' }));
    expect(result.seatFallback).toMatchObject({ to: 'cql-litellm:api-anthropic-claude-fable-5-1', customFallback: true });
  });

  it('a NEW run on the latched seat starts on the fallback WITHOUT probing the seat (no retry on latched models)', async () => {
    mockRunModelTurn
      .mockImplementationOnce(async () => { throw http400(EFFORT_400); })
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(seatInvalidRequestLatch(SEAT)).toBeTruthy();
    mockRunModelTurn.mockClear();
    mockNoteSeatFallback.mockClear();

    const again = await runCodingAgent(makeInput({ sessionId: 'sess-astra-2' }));
    expect(again.modelErrored ?? false).toBe(false);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
    expect(mockRunModelTurn.mock.calls[0][0].url).toContain('api.z.ai'); // the custom endpoint was never called
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({
      role: 'supervisor', from: SEAT, to: 'glm-5.3', fingerprint: 'reasoning_effort_unsupported', latchedUntil: expect.any(String),
    }));
    expect(String(mockNoteSeatFallback.mock.calls[0][0].reason)).toContain('(latched)');
    expect(again.parts.some((p: any) => p?.type === 'text' && String(p.text).includes('is unusable'))).toBe(true);
    expect(again.seatFallback).toMatchObject({ role: 'supervisor', from: SEAT, to: 'glm-5.3' });
  });

  it('with NO servable fallback the run fails fast on the capability lane and the latch still records', async () => {
    // Hermetic (FO firing 36, 2026-09-27): a dev sandbox carries real provider
    // keys (DEEPSEEK_API_KEY, MOONSHOT_API_KEY, …) that CI never has — deleting
    // only ZAI_API_KEY left OTHER built-ins servable, the run found a fallback
    // and retried (2 runModelTurn calls vs the 1 this test pins). Delete every
    // built-in coding provider envKey (coding-model.ts: ZAI/DEEPSEEK/MOONSHOT),
    // restore after so no env state leaks to later suites.
    const savedKeys: Record<string, string | undefined> = {};
    for (const k of ['ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY']) {
      savedKeys[k] = process.env[k];
      delete process.env[k];
    }
    try {
      mockRunModelTurn.mockImplementationOnce(async () => { throw http400(EFFORT_400); }).mockResolvedValue(FINAL);
      const result = await runCodingAgent(makeInput());
      expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
      expect(result.modelErrored).toBe(true);
      expect(result.modelErrorKind).toBe('capability');
      expect(seatInvalidRequestLatch(SEAT)).toMatchObject({ kind: 'reasoning_effort_unsupported' });
      expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'provider_rejected', meta: expect.objectContaining({ lane: 'invalid_request', outcome: 'gave_up' }) }));
    } finally {
      for (const [k, v] of Object.entries(savedKeys)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it('a genuine transient (429) still takes the 429 lane, and a plain unclassified 400 never latches', async () => {
    mockRunModelTurn
      .mockImplementationOnce(async () => { throw Object.assign(new Error('Request failed with status code 429'), { response: { status: 429, data: Readable.from(['{"error":{"message":"rate limited"}}']) } }); })
      .mockResolvedValue(FINAL);
    const r = await runCodingAgent(makeInput());
    expect(r.modelErrored ?? false).toBe(false);
    expect(seatInvalidRequestLatch(SEAT)).toBeNull();
    expect(String(r.seatFallback?.reason)).toBe('HTTP 429');

    __resetProviderCooldownForTests();
    mockRunModelTurn.mockClear();
    mockRunModelTurn
      .mockImplementationOnce(async () => { throw http400('messages parameter is illegal (1214)'); })
      .mockResolvedValue(FINAL);
    const r2 = await runCodingAgent(makeInput({ sessionId: 'sess-astra-3' }));
    expect(r2.modelErrored ?? false).toBe(false);
    expect(seatInvalidRequestLatch(SEAT)).toBeNull(); // the spurious-400 class stays on its own lanes
  });
});

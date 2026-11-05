/**
 * REPLAY — audit 2026-10-08 W2-4 (plumbing.md F5 / lanes.md F6): Alibaba's
 * content-moderation 400 ("InternalError.Algo.DataInspectionFailed: Input text
 * data may contain inappropriate content", qwen3.8-max via the owner's LiteLLM
 * gateway — "No fallback model group found") was treated as a spurious
 * transient 400: 5 backoffs of the IDENTICAL payload (9/30/71/133/280 s), two
 * useless shrinks, then run 45c4f136 failed after 87 min with "the request was
 * too large or malformed". Now: no backoff, no shrink — the FIRST hit fails the
 * run over to the next seat in the chain with ONE model-facing line; a second
 * hit (or no servable fallback) ends the run with an honest content-filter note.
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

const REGISTRY: Record<string, any> = {
  'cql-litellm:api-alibaba-qwen3.8-max': {
    url: 'https://llm.cql.ca/v1/chat/completions', baseUrl: 'https://llm.cql.ca/v1',
    apiKey: 'sk-cql', model: 'api-alibaba-qwen3.8-max', label: 'cql-litellm',
    coding: true, chatCapable: true, kind: 'chat', thinkingOff: false, supportsVision: false,
    maxToolsSource: 'none', reasoningEffort: 'auto',
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
import { __resetSeatInvalidRequestLatchesForTests, classifyContentFilter, listSeatInvalidRequestLatches } from './seat-invalid-request';
import { __resetLearnedToolLimitsForTests } from './provider-limits';
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

const SEAT = 'cql-litellm:api-alibaba-qwen3.8-max';
const makeInput = (extra?: Partial<AgentRunInput>): AgentRunInput => ({
  worktree: '/tmp/content-filter',
  sessionId: 'sess-c919294b',
  projectId: 'p-onepiece',
  userId: 'u1',
  permissionMode: 'auto',
  model: SEAT,
  projectName: 'One Piece TCG',
  branch: 'chat',
  profile: PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [] as any,
  userMessage: 'Curate spoiler/leak trackers',
  emit: jest.fn(),
  ...extra,
});

/** The real incident body shape (LiteLLM-wrapped DashScope moderation 400). */
const DATA_INSPECTION_400 = 'litellm.BadRequestError: OpenAIException - InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content.. Received Model Group=api-alibaba-qwen3.8-max\nAvailable Model Group Fallbacks=None No fallback model group found for original model_group=api-alibaba-qwen3.8-max.';
const http400 = (body: string) => Object.assign(new Error('Request failed with status code 400'), {
  response: { status: 400, data: Readable.from([`{"error":{"message":${JSON.stringify(body)}}}`]) },
});
const FINAL = { content: 'Trackers curated.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  __resetSeatInvalidRequestLatchesForTests();
  __resetLearnedToolLimitsForTests();
  __resetProviderCooldownForTests();
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1';
  process.env.ZAI_API_KEY = 'test-zai-key'; // the built-in glm-5.3 is servable
  delete process.env.CONTENT_FILTER_LANE_DISABLED;
  mockExecuteCodingTool.mockResolvedValue('probe result: ok');
  mockResolveRegistryModel.mockImplementation(async (spec: string) => REGISTRY[spec] ?? null);
  mockResolveRoleFallback.mockImplementation(async () => '');
  mockResolveRoleModel.mockImplementation(async () => '');
});

afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
  delete process.env.ZAI_API_KEY;
  delete process.env.CONTENT_FILTER_LANE_DISABLED;
});

const rows = (lane: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r: any) => r?.kind === 'provider_rejected' && r?.meta?.lane === lane);

describe('classifyContentFilter (pure)', () => {
  it('matches the incident body on a 400; never a size / tool / auth 4xx; never a 5xx', () => {
    expect(classifyContentFilter({ errorStatus: 400, providerError: DATA_INSPECTION_400 })).toMatchObject({ status: 400 });
    expect(classifyContentFilter({ errorStatus: 400, providerError: 'The response was filtered due to the prompt triggering Azure OpenAI content management policy.' })).not.toBeNull();
    expect(classifyContentFilter({ errorStatus: 400, providerError: "Invalid 'tools': array too long" })).toBeNull();
    expect(classifyContentFilter({ errorStatus: 400, providerError: 'context length exceeded' })).toBeNull();
    expect(classifyContentFilter({ errorStatus: 500, providerError: DATA_INSPECTION_400 })).toBeNull();
    expect(classifyContentFilter({ errorStatus: 400, providerError: 'type safety check failed' })).toBeNull();
  });
});

describe('audit 2026-10-08 W2-4 — a provider content filter is not a transient 400', () => {
  it('REPLAY: no backoff, no shrink — the run fails over ONCE to the next seat and the model is told in one line', async () => {
    mockRunModelTurn
      .mockImplementationOnce(async () => { throw http400(DATA_INSPECTION_400); })
      .mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput());
    expect(result.modelErrored ?? false).toBe(false);
    expect(result.finalText).toContain('Trackers curated.');
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2); // pre-fix: 5 backoffs + 2 shrinks on the SAME seat
    expect(mockRunModelTurn.mock.calls[0][0].url).toBe('https://llm.cql.ca/v1/chat/completions');
    expect(mockRunModelTurn.mock.calls[1][0].url).toContain('api.z.ai');
    const secondMessages = JSON.stringify(mockRunModelTurn.mock.calls[1][1]);
    expect(secondMessages).toContain('REFUSED the last request with its content filter');
    expect(rows('content_filter')).toEqual([expect.objectContaining({ meta: expect.objectContaining({ outcome: 'seat_fallback', status: 400, model: 'api-alibaba-qwen3.8-max' }) })]);
    expect(rows('transient')).toEqual([]);
    expect(rows('size')).toEqual([]);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ outcome: 'shrink_retry' }) }));
    expect(listSeatInvalidRequestLatches()).toEqual([]); // the seat is fine for other content — never latched
    expect(result.seatFallback).toMatchObject({ from: SEAT, to: 'glm-5.3', httpStatus: 400 });
    expect(String(result.seatFallback!.reason)).toMatch(/^content_filter — /);
  });

  it('a second refusal on the fallback ends the run with an honest content-filter note (kind content_filter)', async () => {
    mockRunModelTurn
      .mockImplementationOnce(async () => { throw http400(DATA_INSPECTION_400); })
      .mockImplementationOnce(async () => { throw http400('Request flagged by the content filter: content_filter'); })
      .mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput());
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(result.modelErrored).toBe(true);
    expect(result.modelErrorKind).toBe('content_filter');
    expect(result.finalText).toContain('PROVIDER CONTENT FILTER');
    expect(result.finalText).not.toContain('too large or malformed');
  });

  it('no servable fallback: the FIRST refusal ends the run honestly (never the backoff crawl)', async () => {
    const KEYS = ['ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'DASHSCOPE_API_KEY'];
    const saved = KEYS.map((k) => [k, process.env[k]] as const);
    for (const k of KEYS) delete process.env[k]; // no built-in is servable (CI shape)
    try {
      mockRunModelTurn.mockImplementationOnce(async () => { throw http400(DATA_INSPECTION_400); }).mockResolvedValue(FINAL);
      const result = await runCodingAgent(makeInput());
      expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
      expect(result.modelErrorKind).toBe('content_filter');
      expect(rows('content_filter')).toEqual([expect.objectContaining({ meta: expect.objectContaining({ outcome: 'gave_up' }) })]);
    } finally {
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('CONTENT_FILTER_LANE_DISABLED=1 restores the transient lane (the same request is re-sent)', async () => {
    process.env.CONTENT_FILTER_LANE_DISABLED = '1';
    mockRunModelTurn
      .mockImplementationOnce(async () => { throw http400(DATA_INSPECTION_400); })
      .mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput());
    expect(result.modelErrored ?? false).toBe(false);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(mockRunModelTurn.mock.calls[1][0].url).toBe('https://llm.cql.ca/v1/chat/completions'); // same seat, a backoff retry
    expect(rows('content_filter')).toEqual([]);
  });
});

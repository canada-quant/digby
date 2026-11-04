/**
 * build 2026-10-08 Q-2 — REPLAY: the gateway Kimi seat replays its reasoning (Preserved Thinking).
 *
 * Prod (context.md §1.7): `agent.ts` replayed reasoning_content only for the bare built-in id 'kimi-k3', so
 * `cql-litellm:api-optimize-moonshot-kimi-k3` (2,098 chat + 197 coding runs in 14 days) never carried it.
 * Drives the REAL agent loop on a REGISTRY-resolved provider (resolveRegistryModel mocked like
 * coding-model.test.ts); only runModelTurn + the tool executor are mocked (agent-k3-conformance scaffold).
 * Also pins Q-1's run-path seam: resolving the spec notes the endpoint's registry price for the meter.
 */


jest.setTimeout(60_000);

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
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
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
const mockConsultCrossCheckerOnStreak: jest.Mock = jest.fn(async () => null);
const mockFileStreakInvestigation: jest.Mock = jest.fn(async () => undefined);
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: (...a: any[]) => mockConsultCrossCheckerOnStreak(...a),
  fileStreakInvestigation: (...a: any[]) => mockFileStreakInvestigation(...a),
}));

const mockResolveRegistryModel: jest.Mock = jest.fn();
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { __resetReasoningReplayLatchForTests } from './coding-model';
import { resolvePrice, __resetRegistryPricesForTests } from './cost';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
} as AgentProfile;

const makeInput = (model: string): AgentRunInput => ({
  worktree: '/tmp/k3-gateway-replay-q2-test',
  sessionId: 'sess-q2',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model,
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'check the open tickets',
  emit: jest.fn(),
});

const registryEntry = (model: string, extra: Record<string, unknown> = {}) => ({
  url: 'https://llm.example.com/v1/chat/completions',
  baseUrl: 'https://llm.example.com/v1',
  apiKey: 'sk-cql',
  model,
  label: 'cql-litellm',
  supportsVision: false,
  coding: true,
  chatCapable: true,
  kind: 'chat',
  reasoningEffort: 'auto',
  ...extra,
});

const FINAL = { content: 'Done — three tickets are open.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const TOOL_TURN = (trace: string) => ({ content: 'Probing the queue.', reasoning: trace, toolCalls: [{ id: 't1', name: 'list_feedback', arguments: '{}' }], finishReason: 'tool_calls' });
const messagesOf = (n: number): any[] => mockRunModelTurn.mock.calls[n][1] as any[];
const toolCallRecord = (n: number) => messagesOf(n).find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));

beforeEach(() => {
  mockRunModelTurn.mockReset();
  mockExecuteCodingTool.mockClear();
  mockRecordLoopMetric.mockClear();
  mockResolveRegistryModel.mockReset();
  __resetReasoningReplayLatchForTests();
  __resetRegistryPricesForTests();
  delete process.env.KIMI_REASONING_REPLAY_FAMILY_DISABLED;
});
afterAll(() => { delete process.env.KIMI_REASONING_REPLAY_FAMILY_DISABLED; });

describe('gateway Kimi K3 seat — reasoning replay by family (build 2026-10-08 Q-2)', () => {
  const SPEC = 'cql-litellm:api-optimize-moonshot-kimi-k3';

  it('the tool-call turn reasoning_content rides the NEXT request on the gateway seat; one reasoning_replay row', async () => {
    mockResolveRegistryModel.mockResolvedValue(registryEntry('api-optimize-moonshot-kimi-k3'));
    const trace = 'I should list the open tickets first. '.repeat(50);
    mockRunModelTurn.mockResolvedValueOnce(TOOL_TURN(trace)).mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput(SPEC));
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect((mockRunModelTurn.mock.calls[0][0] as any).model).toBe('api-optimize-moonshot-kimi-k3');
    expect(toolCallRecord(1).reasoning_content).toBe(trace);
    expect(result.finalText).toBe(FINAL.content);
    const rows = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r: any) => r?.kind === 'reasoning_replay');
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ outcome: 'replayed', model: 'api-optimize-moonshot-kimi-k3', spec: SPEC });
  });

  it('a gateway GLM seat stays untouched (no reasoning_content, no row)', async () => {
    mockResolveRegistryModel.mockResolvedValue(registryEntry('api-optimize-zai-glm-5.3'));
    mockRunModelTurn.mockResolvedValueOnce(TOOL_TURN('glm thinks in its own channel')).mockResolvedValueOnce(FINAL);
    await runCodingAgent(makeInput('cql-litellm:api-optimize-zai-glm-5.3'));
    expect(toolCallRecord(1)).not.toHaveProperty('reasoning_content');
    expect(mockRecordLoopMetric.mock.calls.some((c) => c[0]?.kind === 'reasoning_replay')).toBe(false);
  });

  it('kill switch KIMI_REASONING_REPLAY_FAMILY_DISABLED=1 restores the pre-change gateway behaviour', async () => {
    process.env.KIMI_REASONING_REPLAY_FAMILY_DISABLED = '1';
    mockResolveRegistryModel.mockResolvedValue(registryEntry('api-optimize-moonshot-kimi-k3'));
    mockRunModelTurn.mockResolvedValueOnce(TOOL_TURN('trace')).mockResolvedValueOnce(FINAL);
    await runCodingAgent(makeInput(SPEC));
    expect(toolCallRecord(1)).not.toHaveProperty('reasoning_content');
  });

  it('Q-1 seam: resolving the spec notes the endpoint registry price, which the meter then applies', async () => {
    mockResolveRegistryModel.mockResolvedValue(registryEntry('api-optimize-moonshot-kimi-k3', { usdPerMTokIn: 2.5, usdPerMTokOut: 10 }));
    mockRunModelTurn.mockResolvedValueOnce(FINAL);
    await runCodingAgent(makeInput(SPEC));
    expect(resolvePrice(SPEC)).toEqual({ price: { in: 2.5, out: 10 }, source: 'registry' });
  });
});

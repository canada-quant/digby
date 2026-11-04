/**
 * Quick-lane web budget in the agent loop (roster 2026-10-06 C-4; ./web-tool-cap.ts). Real Quick answers made
 * 6, 2, 4, 4, 0, 4, 3, 1 web calls against a brief that says ONE search: the harness now enforces 1 search + 1 page
 * read on a run that carries `webToolCaps` (act), counts would-be refusals in shadow, and leaves every other run alone.
 * Scaffold mirrors agent-loop-volume.54a172ac.test.ts (same mock set) + a canned ToolCache for the web tools.
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

const mockWebExec: jest.Mock = jest.fn(async (name: string) => `${name}: 3 results — the answer is 42 (example.com)`);
jest.mock('../tool-executor', () => {
  const actual = jest.requireActual('../tool-executor');
  return {
    ...actual,
    ToolCache: class { getOrExecute(name: string, args: any) { return mockWebExec(name, args); } },
  };
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
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  fileStreakInvestigation: jest.fn(async () => undefined),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { quickWebToolCaps } from './web-tool-cap';

const PROFILE: AgentProfile = {
  kind: 'coding', maxSteps: 10, maxDelegations: 0, contextCharBudget: 100_000,
  workspaceTools: false, planReminders: false, memorySource: 'coding',
};

const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree: '/tmp/quick-web-budget-test', sessionId: 'sess-quick-web', projectId: 'p1', userId: 'u1',
  permissionMode: 'auto', model: 'kimi-k3', projectName: 'test', branch: 'main', profile: PROFILE,
  doctrineOverride: 'You are a test agent.', history: [], userMessage: 'what is the answer', emit: jest.fn(), ...over,
});

const call = (n: number, name: string, args: Record<string, unknown>) => ({
  content: '', reasoning: '', toolCalls: [{ id: `c${n}`, name, arguments: JSON.stringify(args) }], finishReason: 'tool_calls',
});
const FINAL = { content: 'It is 42 (example.com).', reasoning: '', toolCalls: [], finishReason: 'stop' };
const toolNamesOf = (i: number): string[] => (mockRunModelTurn.mock.calls[i]?.[2] ?? []).map((t: any) => t?.function?.name).filter(Boolean);
const messageTextsOf = (i: number): string[] => (mockRunModelTurn.mock.calls[i]?.[1] ?? []).map((m: any) => String(m?.content ?? ''));
const budgetRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'quick_web_budget');

/** search, search, scrape, scrape — the over-searching Quick answer shape. */
const overSearching = () => mockRunModelTurn
  .mockResolvedValueOnce(call(1, 'search_engine', { query: 'answer' }))
  .mockResolvedValueOnce(call(2, 'search_engine', { query: 'answer again' }))
  .mockResolvedValueOnce(call(3, 'scrape_as_markdown', { url: 'https://example.com/a' }))
  .mockResolvedValueOnce(call(4, 'scrape_as_markdown', { url: 'https://example.com/b' }))
  .mockResolvedValue(FINAL);

describe('Quick-lane web budget in the agent loop (roster 2026-10-06 C-4)', () => {
  beforeEach(() => { jest.clearAllMocks(); _store.clear(); });

  it('ACT: one search + one page read execute; the second of each is refused BEFORE it runs, its class leaves the tool list, the result carries the counts', async () => {
    overSearching();
    const r = await runCodingAgent(makeInput({ webToolCaps: quickWebToolCaps('act') }));
    expect(mockWebExec.mock.calls.map((c) => c[0])).toEqual(['search_engine', 'scrape_as_markdown']);
    // The second search's refusal is failure-shaped and tells the model to answer now.
    const refusal = messageTextsOf(2).find((t) => t.includes('Quick lane web budget'));
    expect(refusal).toContain('Tool search_engine failed');
    expect(refusal).toContain('answer NOW');
    // The search class is gone from the next round's tool list; the fetch class still offered until spent.
    expect(toolNamesOf(2)).not.toContain('search_engine');
    expect(toolNamesOf(2)).toContain('scrape_as_markdown');
    expect(toolNamesOf(4)).not.toContain('scrape_as_markdown');
    expect(r.webToolCap).toMatchObject({ mode: 'act', search: 1, fetch: 1, refused: 2, wouldRefuse: 0 });
    expect(budgetRows().map((m) => m.meta.cls)).toEqual(['search', 'fetch']);
  });

  it('SHADOW: every call executes; the would-be refusals are counted', async () => {
    overSearching();
    const r = await runCodingAgent(makeInput({ webToolCaps: quickWebToolCaps('shadow') }));
    expect(mockWebExec).toHaveBeenCalledTimes(4);
    expect(r.webToolCap).toMatchObject({ mode: 'shadow', search: 2, fetch: 2, refused: 0, wouldRefuse: 2 });
    expect(budgetRows()).toHaveLength(0);
  });

  it('no webToolCaps (every non-Quick run): untouched — no counts on the result', async () => {
    overSearching();
    const r = await runCodingAgent(makeInput());
    expect(mockWebExec).toHaveBeenCalledTimes(4);
    expect(r.webToolCap).toBeUndefined();
  });
});

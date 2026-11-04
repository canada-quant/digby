/**
 * F2 — the frontier reflection council wired into the REAL agent loop (owner 2026-10-06 late).
 *
 * A lane's read_file fails 3× (trip 1: the Double-Checker consult runs, as today), then 3× again (trip 2: repeated
 * failures). Pinned:
 *   - the second trip does NOT consult the Double Checker — the frontier council supersedes it;
 *   - the next step carries the [REFLECT — REPEATED FAILURES] note (every failure text + args, the run goal) and
 *     offers consult_frontier_council (never offered before the trigger);
 *   - the agent's call runs the advisors IT chose through the harness and the answers come back as the tool result
 *     plus ONE subagent transcript part;
 *   - FRONTIER_REFLECTION_COUNCIL_DISABLED=1 restores today's behaviour (two consults, no note, no tool);
 *   - a human Quick-lane turn (fastSeat) never gets a council.
 * Scaffold mirrors agent-derail-break.d2cceee3.test.ts (same mock set). No provider keys: the council's I/O is
 * injected through __setFrontierCouncilDepsForTests.
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
  __esModule: true, agentBroker: { dispatch: jest.fn() },
}));

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

const FAIL = 'Tool read_file failed: ENOENT: no such file or directory, open \'src/missing.ts\'';
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, name: string) => (name === 'read_file' ? FAIL : 'probe result: ok'));
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

jest.mock('../tool-executor', () => {
  const actual = jest.requireActual('../tool-executor');
  return {
    ...actual,
    ToolCache: jest.fn().mockImplementation(() => ({ getOrExecute: jest.fn(async () => 'probe result: ok') })),
  };
});

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordLoopMetrics: jest.fn(),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss', TOOL_BATCH_CAP: 'tool_batch_cap' },
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
const mockConsultCrossCheckerOnStreak: jest.Mock = jest.fn(async () => 'Check the path exists before reading it.');
const mockFileStreakInvestigation: jest.Mock = jest.fn(async () => undefined);
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: (...a: any[]) => mockConsultCrossCheckerOnStreak(...a),
  fileStreakInvestigation: (...a: any[]) => mockFileStreakInvestigation(...a),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { __setFrontierCouncilDepsForTests, FRONTIER_COUNCIL_TOOL, REFLECT_NOTE_PREFIX, COUNCIL_RESULT_PREFIX, type FrontierCouncilDeps } from './frontier-council';

const PROFILE: AgentProfile = { kind: 'coding', maxSteps: 14, maxDelegations: 0, contextCharBudget: 100_000, workspaceTools: false, planReminders: false, memorySource: 'coding' };
const CLAUDE = 'cql-litellm:api-anthropic-claude-fable-5-1';
const GPT = 'cql-litellm:api-openai-gpt-6-astra';

const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree: '/tmp/frontier-council-agent-test',
  sessionId: 'sess-frontier-council',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'Fix the missing module import in src/missing.ts',
  emit: jest.fn(),
  ...over,
});

const readCall = (n: number) => ({ id: `r${n}`, name: 'read_file', arguments: JSON.stringify({ path: `src/missing${'abcdefgh'[n % 8]}.ts` }) });
const turn = (toolCalls: any[], content = '') => ({ content, reasoning: 'Now read_file the module to see the import.', toolCalls, finishReason: 'tool_calls' as const });
const FINAL = { content: 'Done: the module path was wrong; fixed per the council.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };
const listCall = (n: number) => ({ id: `l${n}`, name: 'list_files', arguments: JSON.stringify({}) });
const councilCall = { id: 'fc1', name: FRONTIER_COUNCIL_TOOL, arguments: JSON.stringify({ models: [CLAUDE, GPT], reflection: 'read_file keeps failing with ENOENT on src/missing*.ts — I guessed the paths instead of listing the directory.', question: 'What is the right way to locate the module?' }) };

/** The scripted run: trip 1 (3 fails), an aligned success while read_file is withheld, trip 2 (3 fails), then the
 *  reflection + council call, then the final. */
const script = (withCouncil: boolean) => [
  turn([readCall(1)]), turn([readCall(2)]), turn([readCall(3)]),
  turn([listCall(1)]),
  turn([readCall(4)]), turn([readCall(5)]), turn([readCall(6)]),
  ...(withCouncil ? [turn([councilCall], 'Reflection: I guessed paths; ENOENT every time.')] : []),
  FINAL,
];

let advisorSpecs: string[] = [];
let councilMetrics: any[] = [];
const testDeps = (over: Partial<FrontierCouncilDeps> = {}): Partial<FrontierCouncilDeps> => ({
  models: async () => ({ candidates: [
    { spec: CLAUDE, family: 'claude', tier: 'strong', priceIn: 15, priceOut: 75 },
    { spec: GPT, family: 'gpt', tier: 'strong', priceIn: null, priceOut: null },
  ], defaults: [CLAUDE] }),
  priorRuns: async () => ({ consecutiveFailed: 0, failed: [] }),
  consumeTripMarker: async () => false,
  setTripMarker: async () => undefined,
  dailyCount: async () => 0,
  bumpDaily: async () => undefined,
  plan: async () => null,
  charter: async () => null,
  callAdvisor: async (spec) => { advisorSpecs.push(spec); return { text: `DIAGNOSIS: guessed paths.\nNEXT STEP: list_files src/ then read the real file (${spec}).`, inTokens: 500, outTokens: 80 }; },
  recordMetric: (r) => councilMetrics.push(r),
  recordRows: () => undefined,
  now: () => 0,
  ...over,
});

const conversation = () => mockRunModelTurn.mock.calls[mockRunModelTurn.mock.calls.length - 1]?.[1] as Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
const offeredAtCall = (k: number) => new Set<string>(((mockRunModelTurn.mock.calls[k]?.[2] ?? []) as Array<{ function?: { name?: string } }>).map((t) => t?.function?.name as string).filter(Boolean));

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  advisorSpecs = [];
  councilMetrics = [];
  delete process.env.FRONTIER_REFLECTION_COUNCIL_DISABLED;
  __setFrontierCouncilDepsForTests(testDeps());
});
afterAll(() => __setFrontierCouncilDepsForTests(null));

describe('F2 — the frontier reflection council in the agent loop', () => {
  it('repeated failures ⇒ no second Double-Checker consult, the reflect note + the tool appear, the agent\'s chosen advisors answer as the tool result and a transcript part', async () => {
    for (const t of script(true)) mockRunModelTurn.mockResolvedValueOnce(t);
    const res = await runCodingAgent(makeInput());

    // trip 1 consulted the Double Checker (today's path); trip 2 escalated to the council instead
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);

    // the tool is offered only from the turn after the second trip
    const councilTurnIdx = mockRunModelTurn.mock.calls.findIndex((_c, k) => offeredAtCall(k).has(FRONTIER_COUNCIL_TOOL));
    expect(councilTurnIdx).toBe(7);
    for (let k = 0; k < councilTurnIdx; k++) expect(offeredAtCall(k).has(FRONTIER_COUNCIL_TOOL)).toBe(false);

    // the reflect note: every failure (texts + args), the run goal, the advisors
    const userTexts = conversation().filter((m) => m.role === 'user').map((m) => String(m.content));
    const note = userTexts.find((t) => t.startsWith(REFLECT_NOTE_PREFIX));
    expect(note).toBeDefined();
    expect(note).toContain('a second failure-streak trip this run');
    expect(note).toContain('no such file or directory');
    expect(note).toContain('"path":"src/missing');
    expect(note).toContain('Fix the missing module import');
    expect(note).toContain(CLAUDE);

    // the agent's call ran its two advisors; the answer is the tool result
    expect(advisorSpecs.sort()).toEqual([CLAUDE, GPT].sort());
    const toolResult = conversation().find((m) => m.role === 'tool' && String(m.content).startsWith(COUNCIL_RESULT_PREFIX));
    expect(String(toolResult?.content)).toContain('advisors chosen by you');
    expect(String(toolResult?.content)).toContain('NEXT STEP: list_files src/');

    // ONE subagent transcript part; the run finished normally
    const councilParts = res.parts.filter((p) => p.type === 'subagent' && p.role === 'reflection_council');
    expect(councilParts).toHaveLength(1);
    expect(res.finalText).toContain('fixed per the council');
    expect(councilMetrics.find((m) => m.meta?.phase === 'run')?.meta).toMatchObject({ trigger: 'streak_repeat', chosenBy: 'agent' });
  });

  it('the agent ignores the note for 2 steps ⇒ the harness consults the default advisors and injects the answers', async () => {
    const ignore = [turn([listCall(7)]), turn([listCall(8)]), turn([listCall(9)])];
    for (const t of [...script(false).slice(0, -1), ...ignore, FINAL]) mockRunModelTurn.mockResolvedValueOnce(t);
    await runCodingAgent(makeInput());
    expect(advisorSpecs).toEqual([CLAUDE]); // the configured default list
    const injected = conversation().filter((m) => m.role === 'user').map((m) => String(m.content)).find((t) => t.startsWith(COUNCIL_RESULT_PREFIX));
    expect(injected).toContain('advisors chosen by the harness');
    expect(councilMetrics.find((m) => m.meta?.phase === 'run')?.meta).toMatchObject({ chosenBy: 'harness' });
  });

  it('kill switch FRONTIER_REFLECTION_COUNCIL_DISABLED=1: today\'s behaviour — both trips consult the Double Checker, no note, no tool', async () => {
    process.env.FRONTIER_REFLECTION_COUNCIL_DISABLED = '1';
    for (const t of script(false)) mockRunModelTurn.mockResolvedValueOnce(t);
    await runCodingAgent(makeInput());
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(2);
    expect(mockRunModelTurn.mock.calls.some((_c, k) => offeredAtCall(k).has(FRONTIER_COUNCIL_TOOL))).toBe(false);
    expect(conversation().some((m) => m.role === 'user' && String(m.content).startsWith(REFLECT_NOTE_PREFIX))).toBe(false);
    expect(advisorSpecs).toEqual([]);
  });

  it('a human Quick-lane turn (fastSeat) never gets a council', async () => {
    for (const t of script(false)) mockRunModelTurn.mockResolvedValueOnce(t);
    await runCodingAgent(makeInput({ fastSeat: true }));
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(2);
    expect(councilMetrics).toEqual([]);
    expect(advisorSpecs).toEqual([]);
  });

  it('an instance with no servable frontier model: the trigger cannot arm — the Double-Checker consult stands on both trips', async () => {
    __setFrontierCouncilDepsForTests(testDeps({ models: async () => ({ candidates: [], defaults: [] }) }));
    for (const t of script(false)) mockRunModelTurn.mockResolvedValueOnce(t);
    await runCodingAgent(makeInput());
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(2);
    expect(councilMetrics.filter((m) => m.meta?.phase === 'no_models')).toHaveLength(1);
  });
});

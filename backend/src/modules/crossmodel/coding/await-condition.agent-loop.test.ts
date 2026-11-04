/**
 * MERGE-INTENT-AWAIT (2026-10-20) — ToolContext.requestEndTurn on the REAL agent
 * loop (coding/agent.ts): a tool (await_condition) that registered a condition
 * wake asks the loop to END the run — the NEXT turn is ONE tools-off final
 * carrying the tool's notice (never FINAL_TURN_NOTICE), the result says
 * awaitingCondition (the executor's continuation stands down on it), and a run
 * whose tool never asks runs to the model's own stop. Harness copied from
 * agent-answer-first-split.test.ts (a real agent loop over a mocked model turn).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// message-queue.service imports middleware/error-handler → config/env, which
// process.exit(1)s in jest without the mirror (the busy-chat-queue learning).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
const mockPrismaCreate: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingChatMessage: {
      count: jest.fn(async () => 20), // the Fleet chat's full queue (MAX_QUEUE_DEPTH)
      create: (...a: any[]) => mockPrismaCreate(...a),
    },
  },
}));
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

/** The incident's refusal, thrown by the executePlatformTool mock so the
 *  REAL executeCodingTool catch-all (tools.ts:2479-2481) renders the filed
 *  text — byte-faithful, never hand-assembled at the executor seam. */
const mockExecutePlatformTool: jest.Mock = jest.fn();
jest.mock('../platform/platform-tools', () => {
  const actual = jest.requireActual('../platform/platform-tools');
  return { ...actual, executePlatformTool: (...a: any[]) => mockExecutePlatformTool(...a) };
});

/** send_chat_message goes through the REAL executeCodingTool (permission
 *  check → isPlatformTool → mocked executePlatformTool throw → REAL
 *  catch-all render); every other tool succeeds harmlessly (the lane's
 *  recovery update_supervisor_state lands, the probes the narration named
 *  were legit next steps). */
const WAIT_NOTICE = '[HARNESS — WAITING ON A CONDITION] await_condition registered a CONDITION WAKE for: CI on o/r@aaaaaaaaaaaa finished. Tools are off for this last turn.';
const mockExecuteCodingTool: jest.Mock = jest.fn();
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  mockExecuteCodingTool.mockImplementation(async (ctx: any, name: string, _args: any) => {
    if (name === 'await_condition') {
      ctx.requestEndTurn?.(WAIT_NOTICE);
      return 'CONDITION NOT MET after 600s (CI on o/r@aaaaaaaaaaaa finished)\nRegistered a CONDITION WAKE … This run is ending — write a one-line status and stop; do not poll.';
    }
    return 'probe result: ok';
  });
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  noteSeatFallback: jest.fn(),
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
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn(), buildCodeMatchesBlock: jest.fn(async () => '') }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0), buildSessionMemoryInventory: jest.fn(async () => ''), searchMemory: jest.fn(async () => []) }));
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

import { runCodingAgent, FINAL_TURN_NOTICE } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

// A lane profile (await_condition is a lane-only tool) without the plan machinery — the end-of-run
// collapse is what is pinned here; goal-continue's stand-down is the same `toolEndTurnRequest` guard.
const PROFILE: AgentProfile = {
  kind: 'coding', maxSteps: 8, maxDelegations: 0, contextCharBudget: 1_000_000, runDeadlineMs: 480_000,
  workspaceTools: true, planReminders: false, memorySource: 'coding',
};
const callTurn = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  content: '', reasoning: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }], finishReason: 'tool_calls',
});
const FINAL = { content: 'Waiting on CI for aaaaaaaaaaaa — the harness wakes this chat when it finishes.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree: '/tmp/await-condition-agent-test', sessionId: 'sess-await', projectId: 'p1', userId: 'u1',
  permissionMode: 'auto', model: 'kimi-k3', projectName: 'test', branch: 'main',
  profile: PROFILE, doctrineOverride: 'You are a test agent.', history: [], userMessage: 'Merge it once CI is green.',
  emit: jest.fn(), ...over,
});
const msgsOf = (call: any[]): any[] => (call.find((a: any) => Array.isArray(a) && a.some((m: any) => m?.role)) ?? []) as any[];
const lastUser = (call: any[]): string => String([...msgsOf(call)].reverse().find((m: any) => m?.role === 'user')?.content ?? '');
beforeEach(() => { mockRunModelTurn.mockReset(); mockExecuteCodingTool.mockClear(); mockRecordLoopMetric.mockClear(); });

describe('ToolContext.requestEndTurn — a tool ends the run (MERGE-INTENT-AWAIT)', () => {
  it('after await_condition registers a wake, the NEXT turn is the tools-off final with the tool\'s notice; the result says awaitingCondition', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('c1', 'search_memory', { query: 'ci' }))
      .mockResolvedValueOnce(callTurn('c2', 'await_condition', { condition: 'ci', sha: 'a'.repeat(40) }))
      .mockResolvedValue(FINAL);
    const r = await runCodingAgent(makeInput());
    expect(r.finalText).toBe(FINAL.content);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(3);
    const finalCall = mockRunModelTurn.mock.calls[2];
    expect(lastUser(finalCall)).toBe(WAIT_NOTICE);
    expect(finalCall[2] ?? []).toEqual([]); // tools omitted on the final turn
    expect(mockRunModelTurn.mock.calls.some((c) => msgsOf(c).some((m: any) => m?.role === 'user' && m.content === FINAL_TURN_NOTICE))).toBe(false);
    expect(r.awaitingCondition).toBe(true);
    expect(r).not.toHaveProperty('deadlineHit');
  });

  it('goal-continue STANDS DOWN: an auto run with unfinished plan steps that registered a wait is not resumed in-process', async () => {
    const plan = { goal: 'merge once green', acceptanceCriteria: [], steps: [{ id: 1, text: 'wait for CI then merge', status: 'in_progress' }], version: 1, updatedAt: new Date().toISOString() };
    _store.set('sess-await/coding-plan::plan', plan);
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('c1', 'await_condition', { condition: 'ci', sha: 'a'.repeat(40) }))
      .mockResolvedValue(FINAL);
    const r = await runCodingAgent(makeInput({ profile: { ...PROFILE, planReminders: true } }));
    expect(r.awaitingCondition).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2); // the call + the tools-off final — no auto-continue round
    expect(lastUser(mockRunModelTurn.mock.calls[1])).toBe(WAIT_NOTICE);
    _store.clear();
  });

  it('a run whose tools never ask runs to the model\'s own stop and carries no awaitingCondition', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('c1', 'search_memory', { query: 'ci' }))
      .mockResolvedValueOnce(callTurn('c2', 'search_memory', { query: 'again' }))
      .mockResolvedValue(FINAL);
    const r = await runCodingAgent(makeInput());
    expect(mockRunModelTurn).toHaveBeenCalledTimes(3);
    expect((mockRunModelTurn.mock.calls[2][2] ?? []).length).toBeGreaterThan(0);
    expect(r).not.toHaveProperty('awaitingCondition');
  });
});

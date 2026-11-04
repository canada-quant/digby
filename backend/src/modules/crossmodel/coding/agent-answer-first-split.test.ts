/**
 * build 2026-10-08 A1 — the answer-first soft deadline on the REAL agent loop (coding/agent.ts endTurnAfterToolRound):
 * the owner-answer-first observer's hook lets the first tool round(s) run, then — at the first step boundary past
 * ~45 s — collapses the turn to ONE tools-off final carrying the answer-first notice (never FINAL_TURN_NOTICE), with
 * no deadlineHit; a shadow observer never collapses. Harness copied from agent-budget-final-turn.test.ts (a real
 * agent loop over a mocked model turn).
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
const mockExecuteCodingTool: jest.Mock = jest.fn();
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  mockExecuteCodingTool.mockImplementation(async (ctx: any, name: string, args: any) => {
    if (name === 'send_chat_message') return actual.executeCodingTool(ctx, name, args);
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

/**
 * Compute policy DepthBudget (branch cp/harness, 2026-09-26 — design §4 hard
 * rails): `AgentRunInput.forceFinalTurn` polled beside the run deadline in
 * coding/agent.ts. True ⇒ the NEXT turn is the FINAL TURN through the same
 * mechanism the deadline uses (tools omitted, FINAL_TURN_NOTICE pushed, a
 * 'deadline'-stage progress with NO key — the FIXED progress-key set in
 * chat-agent/compute-policy-wiring is the client's lookup table and 'budget'
 * is deliberately not in it, review 2026-09-26 M8) — the model still writes a
 * complete answer; nothing is truncated. Absent / false / throwing ⇒ the loop
 * runs exactly as before. (The mock preamble above is the derail-break
 * harness: a REAL agent loop over a mocked model turn.)
 */
import { runCodingAgent, FINAL_TURN_NOTICE } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

const CHAT_PROFILE: AgentProfile = {
  kind: 'chat', maxSteps: 6, maxDelegations: 0, contextCharBudget: 1_000_000, runDeadlineMs: 480_000,
  workspaceTools: false, planReminders: false, memorySource: 'chat',
};
const probeTurn = (n: number) => ({
  content: '', reasoning: 'checking one more source',
  toolCalls: [{ id: `t${n}`, name: 'search_memory', arguments: JSON.stringify({ query: `probe ${n}` }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'The complete answer, written in full.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree: '/tmp/budget-final-turn-test', sessionId: 'sess-budget', projectId: 'p1', userId: 'u1',
  permissionMode: 'auto', model: 'kimi-k3', projectName: 'test', branch: 'main',
  profile: CHAT_PROFILE, doctrineOverride: 'You are a test agent.', history: [], userMessage: 'How much does it cost?',
  emit: jest.fn(), ...over,
});
beforeEach(() => { mockRunModelTurn.mockReset(); mockExecuteCodingTool.mockClear(); mockRecordLoopMetric.mockClear(); });


import { createAnswerFirstObserver } from '../chat-agent/owner-answer-first';

describe('build 2026-10-08 A1 — the answer-first split on the real agent loop', () => {
  const AF_PREFIX = '[HARNESS NOTICE — not typed by the user] FINAL TURN: ANSWER FIRST';
  /** Each model call "takes" 30 s on the observer's clock; a turn that sees the answer-first notice answers. */
  const modelOnClock = (clock: { t: number }, seen: number[]) => {
    let n = 0;
    mockRunModelTurn.mockImplementation(async (...args: any[]) => {
      const msgs = (args.find((a: any) => Array.isArray(a) && a.some((m: any) => m?.role)) ?? []) as any[];
      const last = [...msgs].reverse().find((m: any) => m?.role === 'user');
      clock.t += 30_000;
      if (typeof last?.content === 'string' && last.content.startsWith(AF_PREFIX)) { seen.push(n); return FINAL; }
      n += 1;
      return n >= 5 ? FINAL : probeTurn(n);
    });
  };

  it('act: two tool rounds (0 s, 30 s) run; at the 60 s boundary the next turn is the tools-off answer with the answer-first notice', async () => {
    const clock = { t: 0 };
    const seen: number[] = [];
    modelOnClock(clock, seen);
    const o = createAnswerFirstObserver({ act: true, turnStartedAt: 0, now: () => clock.t });
    const r = await runCodingAgent(makeInput({ emit: (t: string, d: any) => o.observe(t, d), endTurnAfterToolRound: o.hook() }));
    expect(r.finalText).toBe(FINAL.content);
    expect(mockRunModelTurn.mock.calls.length).toBe(3); // probe @0 s, probe @30 s, the answer @60 s
    expect(seen).toEqual([2]);
    // the answer-first notice REPLACES the deliverable-framed FINAL_TURN_NOTICE (both share the harness prefix — compare whole texts)
    expect(mockRunModelTurn.mock.calls.some((c) => ((c.find((a: any) => Array.isArray(a) && a.some((m: any) => m?.role)) ?? []) as any[]).some((m: any) => m?.role === 'user' && m.content === FINAL_TURN_NOTICE))).toBe(false);
    expect(o.split()).toEqual({ atMs: 60_000, toolsBefore: 2, mutationsBefore: 0 });
    expect(r).not.toHaveProperty('deadlineHit');
  });

  it('shadow: the same hook only records — the loop runs to the model\'s own stop', async () => {
    const clock = { t: 0 };
    const seen: number[] = [];
    modelOnClock(clock, seen);
    const o = createAnswerFirstObserver({ act: false, turnStartedAt: 0, now: () => clock.t });
    const r = await runCodingAgent(makeInput({ emit: (t: string, d: any) => o.observe(t, d), endTurnAfterToolRound: o.hook() }));
    expect(r.finalText).toBe(FINAL.content);
    expect(mockRunModelTurn.mock.calls.length).toBe(5); // 4 probes + the model's own answer
    expect(seen).toEqual([]);
    expect(o.split()).toEqual({ atMs: 60_000, toolsBefore: 2, mutationsBefore: 0 });
    expect(o.toolNames()).toEqual(['search_memory', 'search_memory', 'search_memory', 'search_memory']);
  });
});

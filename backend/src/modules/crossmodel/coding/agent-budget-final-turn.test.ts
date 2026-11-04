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
/** Did ANY model turn see FINAL_TURN_NOTICE (the loop mutates one messages array — a final check over the shared reference is only meaningful as "ever pushed"). */
const finalNoticeEverPushed = () => mockRunModelTurn.mock.calls
  .some((c) => ((c.find((a: any) => Array.isArray(a) && a.some((m: any) => m?.role)) ?? []) as any[])
    .some((m: any) => m?.role === 'user' && typeof m.content === 'string' && m.content.startsWith(FINAL_TURN_NOTICE.slice(0, 40))));

beforeEach(() => { mockRunModelTurn.mockReset(); mockExecuteCodingTool.mockClear(); mockRecordLoopMetric.mockClear(); });

describe('DepthBudget → FINAL TURN (coding/agent.ts forceFinalTurn)', () => {
  it('WITHOUT the hook the loop runs its tool rounds to the model\'s own stop (baseline)', async () => {
    mockRunModelTurn.mockResolvedValueOnce(probeTurn(1)).mockResolvedValueOnce(probeTurn(2)).mockResolvedValueOnce(probeTurn(3)).mockResolvedValue(FINAL);
    const r = await runCodingAgent(makeInput());
    expect(r.finalText).toBe(FINAL.content);
    expect(mockRunModelTurn.mock.calls.length).toBe(4);
    expect(finalNoticeEverPushed()).toBe(false);
  });

  it('the hook returning true after the first tool round collapses the step budget: the NEXT turn carries FINAL_TURN_NOTICE (tools omitted), a progress {stage deadline, no key} fires, and the model\'s complete final is delivered untruncated', async () => {
    // A model that keeps probing until the harness tells it the turn is FINAL —
    // then writes its complete answer (the FINAL-TURN contract).
    // (the loop mutates ONE messages array, so the verdict is taken at call time, not from the captured reference)
    let n = 0;
    const noticeAtCall: number[] = [];
    mockRunModelTurn.mockImplementation(async (...args: any[]) => {
      const msgs = (args.find((a: any) => Array.isArray(a) && a.some((m: any) => m?.role)) ?? []) as any[];
      const last = [...msgs].reverse().find((m: any) => m?.role === 'user');
      if (typeof last?.content === 'string' && last.content.startsWith(FINAL_TURN_NOTICE.slice(0, 40))) { noticeAtCall.push(n); return FINAL; }
      n += 1;
      return probeTurn(n);
    });
    let polls = 0;
    const emit = jest.fn();
    const r = await runCodingAgent(makeInput({ emit, forceFinalTurn: () => { polls += 1; return polls >= 2; } }));
    expect(r.finalText).toBe(FINAL.content);
    // step 0: probe (hook false) → step 1: the hook says true ⇒ step 1 is the last step ⇒ FINAL TURN notice, no tools
    expect(mockRunModelTurn.mock.calls.length).toBe(2);
    expect(noticeAtCall).toEqual([1]);
    const budgetProgress = emit.mock.calls.find(([t, d]) => t === 'progress' && d?.stage === 'deadline' && /budget/i.test(String(d?.message)));
    expect(budgetProgress).toBeTruthy();
    expect(budgetProgress![1]).toMatchObject({ stage: 'deadline', message: expect.stringMatching(/budget/i) });
    // stage 'deadline' like the time-budget event; NO key — the client's fixed
    // progress-key lookup (compute-policy-wiring PROGRESS_KEYS) has no 'budget'
    // entry by design (review 2026-09-26 M8).
    expect(budgetProgress![1].key).toBeUndefined();
    // the final answer is the model's own complete text — never a truncated stream
    expect(r.finalText).not.toMatch(/\.\.\.$/);
  });

  it('a hook that throws is fail-open: the loop behaves as if no hook were passed', async () => {
    mockRunModelTurn.mockResolvedValueOnce(probeTurn(1)).mockResolvedValueOnce(probeTurn(2)).mockResolvedValue(FINAL);
    const r = await runCodingAgent(makeInput({ forceFinalTurn: () => { throw new Error('ledger down'); } }));
    expect(r.finalText).toBe(FINAL.content);
    expect(mockRunModelTurn.mock.calls.length).toBe(3);
    expect(finalNoticeEverPushed()).toBe(false);
  });

  it('a hook that always answers false never collapses the budget', async () => {
    mockRunModelTurn.mockResolvedValueOnce(probeTurn(1)).mockResolvedValueOnce(probeTurn(2)).mockResolvedValue(FINAL);
    const r = await runCodingAgent(makeInput({ forceFinalTurn: () => false }));
    expect(r.finalText).toBe(FINAL.content);
    expect(mockRunModelTurn.mock.calls.length).toBe(3);
    expect(r).not.toHaveProperty('deadlineHit');
  });
});

/**
 * H2 (audit 2026-09-26, finding tests-gaps-4): the run deadline is what
 * DepthBudget.maxBackgroundMs now rides (chat-agent councilDeadlinesFor →
 * profile.runDeadlineMs). The collapse must (a) still deliver the model's
 * complete final through the FINAL-TURN mechanism and (b) REPORT itself on
 * the result (`deadlineHit: true`, only when set) so the chat harness can
 * stamp metadata.depth.facts.backgroundDeadlineHit — the compute_policy row
 * then describes a bound the run actually ran under.
 */
describe('profile.runDeadlineMs → FINAL TURN reports deadlineHit on the result (H2)', () => {
  it('a run that outlives runDeadlineMs collapses to its FINAL TURN: "Time budget reached" progress (stage deadline, no key), the complete final, and result.deadlineHit === true', async () => {
    let n = 0;
    const noticeAtCall: number[] = [];
    mockRunModelTurn.mockImplementation(async (...args: any[]) => {
      const msgs = (args.find((a: any) => Array.isArray(a) && a.some((m: any) => m?.role)) ?? []) as any[];
      const last = [...msgs].reverse().find((m: any) => m?.role === 'user');
      if (typeof last?.content === 'string' && last.content.startsWith(FINAL_TURN_NOTICE.slice(0, 40))) { noticeAtCall.push(n); return FINAL; }
      n += 1;
      // the first model turn alone outlives the (tiny) deadline — the step-1
      // check fires before the model is asked again
      await new Promise(res => setTimeout(res, 320));
      return probeTurn(n);
    });
    const emit = jest.fn();
    const r = await runCodingAgent(makeInput({ emit, profile: { ...CHAT_PROFILE, runDeadlineMs: 200 } }));
    expect(r.finalText).toBe(FINAL.content);
    expect(r.deadlineHit).toBe(true);
    expect(noticeAtCall).toEqual([1]);
    expect(mockRunModelTurn.mock.calls.length).toBe(2);
    const deadlineProgress = emit.mock.calls.find(([t, d]) => t === 'progress' && d?.stage === 'deadline');
    expect(deadlineProgress).toBeTruthy();
    expect(deadlineProgress![1]).toMatchObject({ stage: 'deadline', message: 'Time budget reached — answering now' });
    expect(deadlineProgress![1].key).toBeUndefined();
    expect(r.finalText).not.toMatch(/\.\.\.$/);
  });

  it('a run that finishes inside runDeadlineMs carries NO deadlineHit key (a clean finish leaves no trace)', async () => {
    mockRunModelTurn.mockResolvedValueOnce(probeTurn(1)).mockResolvedValue(FINAL);
    const r = await runCodingAgent(makeInput({ profile: { ...CHAT_PROFILE, runDeadlineMs: 480_000 } }));
    expect(r.finalText).toBe(FINAL.content);
    expect(r).not.toHaveProperty('deadlineHit');
    expect(finalNoticeEverPushed()).toBe(false);
  });
});

/**
 * Hand-off polish (2026-09-28, audit CT-2 a): `endTurnAfterToolRound` — the
 * chat harness's "the sub-session started; finish now" hook — collapses the
 * step budget through the SAME final-turn mechanism but pushes the CALLER's
 * notice (never FINAL_TURN_NOTICE's deliverable framing), fires the
 * 'Sub-session started' progress line (stage deadline, no key), never marks
 * deadlineHit, and fails open on a throw / empty answer.
 */
describe('endTurnAfterToolRound → one tools-off final with the caller\'s notice (coding/agent.ts)', () => {
  const SPAWN_NOTICE = '[HARNESS NOTICE — not typed by the user] The sub-session "Deck" is running now and tool calls are no longer available on this turn. Write your final answer in a few sentences.';
  const modelThatObeysNotice = (noticeAtCall: number[]) => {
    let n = 0;
    mockRunModelTurn.mockImplementation(async (...args: any[]) => {
      const msgs = (args.find((a: any) => Array.isArray(a) && a.some((m: any) => m?.role)) ?? []) as any[];
      const last = [...msgs].reverse().find((m: any) => m?.role === 'user');
      if (typeof last?.content === 'string' && last.content === SPAWN_NOTICE) { noticeAtCall.push(n); return FINAL; }
      n += 1;
      return probeTurn(n);
    });
  };

  it('the hook answering the notice after the first tool round: the NEXT turn carries THAT notice (not FINAL_TURN_NOTICE), tools omitted, "Sub-session started" progress, no deadlineHit', async () => {
    const noticeAtCall: number[] = [];
    modelThatObeysNotice(noticeAtCall);
    let polls = 0;
    const emit = jest.fn();
    const r = await runCodingAgent(makeInput({ emit, endTurnAfterToolRound: () => { polls += 1; return polls >= 2 ? SPAWN_NOTICE : null; } }));
    expect(r.finalText).toBe(FINAL.content);
    expect(mockRunModelTurn.mock.calls.length).toBe(2); // step 0 probe (spawn) → step 1 = the final turn
    expect(noticeAtCall).toEqual([1]);
    // the caller's notice, never the deliverable-framed FINAL_TURN_NOTICE (both share the harness prefix — compare the whole text)
    expect(mockRunModelTurn.mock.calls.some((c) => ((c.find((a: any) => Array.isArray(a) && a.some((m: any) => m?.role)) ?? []) as any[]).some((m: any) => m?.role === 'user' && m.content === FINAL_TURN_NOTICE))).toBe(false);
    const progress = emit.mock.calls.find(([t, d]) => t === 'progress' && d?.stage === 'deadline');
    expect(progress![1]).toMatchObject({ stage: 'deadline', message: 'Sub-session started — finishing the answer' });
    expect(progress![1].key).toBeUndefined();
    expect(r).not.toHaveProperty('deadlineHit');
  });

  it('a hook that answers null / "" / throws never collapses the budget (fail-open)', async () => {
    for (const hook of [() => null, () => '', () => { throw new Error('boom'); }]) {
      mockRunModelTurn.mockReset();
      mockRunModelTurn.mockResolvedValueOnce(probeTurn(1)).mockResolvedValueOnce(probeTurn(2)).mockResolvedValue(FINAL);
      const r = await runCodingAgent(makeInput({ endTurnAfterToolRound: hook as any }));
      expect(r.finalText).toBe(FINAL.content);
      expect(mockRunModelTurn.mock.calls.length).toBe(3);
      expect(finalNoticeEverPushed()).toBe(false);
    }
  });
});

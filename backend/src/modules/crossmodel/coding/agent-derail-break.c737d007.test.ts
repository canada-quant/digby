/**
 * REPLAY TEST — ticket c737d007 (enhancement, 2026-09-22): "Wrong-tool guard
 * blind spot: churning args / churning named-intent defeats every
 * signature-keyed streak ladder" (shortfall-hunt cycle 2, Finding 1; MAST
 * FM-2.3/FM-2.6).
 *
 * THE BLIND SPOT (verified against fresh bytes 2026-09-22): every ladder in
 * the five-lane wrong-tool containment map keys on a CONSECUTIVE IDENTICAL
 * signature —
 *   · success-side intent tracker (ticket 2c98b460): missKey was the
 *     called→intended PAIR — a mismatch counted only when it was the SAME
 *     pair as the previous turn, so a lane whose NAMED intent churned
 *     turn-to-turn reset its own count to 1 forever (steer needs 3, trip
 *     needs 5);
 *   · identical-call break: name:full-args — any args variation defeats it;
 *   · near-identical leg: digit-collapse only — word-level args churn
 *     defeats it;
 *   · failure derail streak: same-tool FAILURE-shaped results only;
 *   · 03587322 repeated-narration line: verbatim repeats only.
 * A derail calling the same wrong tool while its ARGS and/or its NAMED
 * intent churned accumulated NO counter anywhere and burned budget to
 * GOAL-CONTINUE exhaustion — the pre-2c98b460 hole one level up.
 *
 * THE FIX (this pin): the success-side streak is re-keyed PAIR-AGNOSTIC on
 * the CALLED tool alone (agent.ts state block "SUCCESS-side wrong-tool
 * tracker" — ticket c737d007 comment). The named intent is a confabulated
 * rationalization; the derail signal is the lock on ONE wrong tool. Same
 * 3-steer / 5-trip ladder, same resets (an aligned success ends the streak;
 * a different CALLED tool restarts it at 1). intentMissChurned records
 * whether the streak's named intent rotated and rides the guard_strike
 * metrics as meta.churned (churned:false = the legacy pair-keyed ladder
 * would ALSO have caught it — identical-pair trip; churned:true = a
 * blind-spot catch) so the next cycle can measure the wild rate before
 * tuning thresholds. The trip evidence text tells the TRUTH under churn
 * ("a rotating set of OTHER tools (latest: X)") instead of naming one
 * intent that was only the last rationalization.
 *
 * ACCEPTED RESIDUAL (pinned by the BOUNDARY test): (a) ALTERNATING two
 * called tools still defeats the per-tool key; (b) a same-tool success loop
 * whose narration convicts NOTHING accumulates no counter anywhere —
 * counting bare same-tool successes would convict legitimate sequential
 * work (ticket triage, numbered reads). The volume cap owns create-class,
 * the near-leg owns digit churn, meta.churned measures the rest.
 *
 * These tests drive the REAL agent loop (scaffold mirrors
 * agent-derail-break.2c98b460.test.ts): every mismatched call SUCCEEDS
 * ('probe result: ok') so the failure ladder is blind; args vary by WORD —
 * never by digit — so the exact and digit-collapsed repeat signatures stay
 * blind; the named intent ROTATES across five offered tools, which is the
 * precise input the legacy pair key could not survive. No run_command calls
 * anywhere (the scaffold's container mock would leak to a real shell).
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

// Every tool SUCCEEDS ('probe result: ok') — the whole point of the incident
// shape is that nothing failure-shaped ever appears. mockExecuteCodingTool's
// real signature is (ctx, name, args) — name-first mocks silently misroute
// (the 0aecbe92 scaffold gotcha).
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, _name: string, _args: any) => 'probe result: ok');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The document/feedback seam dispatches via ctx.toolCache — keep the REAL
// TOOL_DEFINITIONS, stub only the executor (same success premise).
const mockToolCacheExec: jest.Mock = jest.fn(async (_name: string, _args: any) => 'probe result: ok');
jest.mock('../tool-executor', () => {
  const actual = jest.requireActual('../tool-executor');
  return {
    ...actual,
    ToolCache: jest.fn().mockImplementation(() => ({
      getOrExecute: (...a: any[]) => mockToolCacheExec(...a),
    })),
  };
});

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', TOOL_BATCH_CAP: 'tool_batch_cap' },
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

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { looksLikeToolFailure } from './learnings-index.service';
import { detectIntendedTool } from './tool-preflight';

/** CODING profile (no workspace container in the scaffold). */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const BRIEF = [
  'COORDINATOR firing — re-read the dispatcher thread, reconcile the board, send the next steer.',
  'Keep the plan current while you work.',
].join('\n');

const makeInput = (userMessage: string = BRIEF, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-c737d007-test',
  sessionId: 'sess-c737d007',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

/** The churn family: the CALLED tool stays decoder-locked on update_plan
 *  while the turn's own reasoning names a ROTATING set of OTHER offered
 *  tools (each a whole word, never update_plan — so detectIntendedTool
 *  convicts per turn, but the legacy called→intended PAIR key differs
 *  every turn and the count self-erases). Args vary by WORD (never digit)
 *  so the exact and digit-collapsed repeat signatures stay blind too. */
const R_GCM = 'Now get_chat_messages to re-read the dispatcher thread before the next steer goes out.';
const R_TL = 'Now todo_list to re-check the board state before dispatching the next worker lane.';
const R_SCM = 'Now send_chat_message to push the consolidated steer into the coordinator chat.';
const R_GL = 'Now goal_list to audit every active goal across the fleet before continuing.';
const R_TG = 'Now todo_get to resolve the blocking todo id before updating its status.';

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa'];
const planChurnTurn = (n: number, reasoning: string) => ({
  content: '',
  reasoning,
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: `${WORDS[(n - 1) % WORDS.length]} reconciliation pass`, status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
/** The alternating-CALLED-tool variant for the boundary pin: todo_create
 *  (no id args ⇒ never preflight-refused) succeeding under convicting
 *  narration. */
const todoChurnTurn = (n: number, reasoning: string) => ({
  content: '',
  reasoning,
  toolCalls: [{ id: `t${n}`, name: 'todo_create', arguments: JSON.stringify({ title: `${WORDS[(n - 1) % WORDS.length]} follow-up item` }) }],
  finishReason: 'tool_calls',
});
/** An ALIGNED success: narration names the called tool (the streak reset).
 *  list_files — never run_command (see header). */
const alignedTurn = (n: number) => ({
  content: '',
  reasoning: 'Now list_files to check which generated documents exist before editing.',
  toolCalls: [{ id: `t${n}`, name: 'list_files', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Checklist done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');
/** runModelTurn receives the ONE shared messages array by reference — at
 *  assertion time it holds the full conversation; count steers/notices there. */
const conversation = () => mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }>;
const steerMessages = () => (conversation() || []).filter(
  (m) => m?.role === 'user' && typeof m.content === 'string' && m.content.includes('RE-ANCHOR (one per run)'),
);
const userTexts = () => (conversation() || []).filter((m) => m?.role === 'user').map((m) => String(m.content));

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket c737d007 — pair-agnostic success-side intent streak (the churn blind spot)', () => {
  it('UNIT: the incident premise — successes are invisible to the failure detector, and each churned narration convicts a DIFFERENT offered tool', () => {
    expect(looksLikeToolFailure('probe result: ok')).toBe(false);
    const offered = ['run_command', 'update_plan', 'todo_create', 'list_files', 'get_chat_messages', 'todo_list', 'send_chat_message', 'goal_list', 'todo_get'];
    expect(detectIntendedTool(R_GCM, 'update_plan', offered)).toBe('get_chat_messages');
    expect(detectIntendedTool(R_TL, 'update_plan', offered)).toBe('todo_list');
    expect(detectIntendedTool(R_SCM, 'update_plan', offered)).toBe('send_chat_message');
    expect(detectIntendedTool(R_GL, 'update_plan', offered)).toBe('goal_list');
    expect(detectIntendedTool(R_TG, 'update_plan', offered)).toBe('todo_get');
    // …so the legacy pair key (update_plan→X) differs on every one of the
    // five turns: the pre-fix streak never left 1. The detector itself is
    // unchanged — an aligned narration still acquits.
    expect(detectIntendedTool(alignedTurn(1).reasoning, 'list_files', offered)).toBeNull();
  });

  it('REPLAY steer-at-3 under churn: three consecutive mismatched SUCCESSES with a ROTATING named intent inject exactly ONE re-anchor (churned:true) and the run finishes CLEAN', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(planChurnTurn(1, R_GCM))
      .mockResolvedValueOnce(planChurnTurn(2, R_TL))
      .mockResolvedValueOnce(planChurnTurn(3, R_SCM)) // THIRD mismatch (3rd DISTINCT pair) ⇒ steer arms
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Checklist done.');
    expect(result.modelErrored).toBeUndefined();
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run)');
    // The arm-time named intent is the THIRD turn's (the latest conviction).
    expect(steer).toContain('your own reasoning named send_chat_message');
    expect(steer).toContain('call send_chat_message NOW');
    // The steer tells the TRUTH about the SUCCESS shape (reviewer F1 of
    // 2c98b460): never "and it failed" when the calls succeeded.
    expect(steer).toContain('it SUCCEEDED');
    expect(steer).not.toContain('and it failed');
    // …and the telemetry marks this as a CHURN catch, not an identical-pair one.
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'update_plan', intended: 'send_chat_message', reason: 'intent_mismatch_success', churned: true });
    // The breaker NEVER engaged on successes alone below the trip threshold.
    expect(breakerMetrics()).toHaveLength(0);
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
  });

  it('REPLAY trip-at-5 under churn: the FIFTH consecutive mismatched success (5th DISTINCT pair) trips into the existing ladder — churned:true metric, truthful churn wording', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(planChurnTurn(1, R_GCM))
      .mockResolvedValueOnce(planChurnTurn(2, R_TL))
      .mockResolvedValueOnce(planChurnTurn(3, R_SCM))
      .mockResolvedValueOnce(planChurnTurn(4, R_GL))
      .mockResolvedValueOnce(planChurnTurn(5, R_TG)) // FIFTH ⇒ TRIP 1 (update_plan withheld one round)
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Checklist done.');
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');
    expect(reanchorMetrics()).toHaveLength(1); // the steer still fired at the third
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({ tool: 'update_plan', perma: false, intended: 'todo_get', churned: true });
    // The deferred notice tells the truth about the SUCCESS shape (never
    // "ALL FAILED") and names the latest intended tool via the standard hint.
    expect(userTexts().some((t) => t.includes('all SUCCEEDED') && t.includes('update_plan') && t.includes('todo_get'))).toBe(true);
    // …and the attribution payload carries the CHURN wording verbatim —
    // naming one intent would mislabel a catch whose rationalization rotated.
    expect(mockFileStreakInvestigation).toHaveBeenCalled();
    expect(String(mockFileStreakInvestigation.mock.calls[0][0].recentFailures[0])).toContain('rotating set of OTHER tools (latest: todo_get)');
    expect(String(mockFileStreakInvestigation.mock.calls[0][0].recentFailures[0])).toContain('named intent churned');
  });

  it('REGRESSION identical-pair: five mismatches naming the SAME tool still trip — with churned:false and the legacy byte-exact wording (the 2c98b460 path is preserved)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(planChurnTurn(1, R_GCM))
      .mockResolvedValueOnce(planChurnTurn(2, R_GCM))
      .mockResolvedValueOnce(planChurnTurn(3, R_GCM))
      .mockResolvedValueOnce(planChurnTurn(4, R_GCM))
      .mockResolvedValueOnce(planChurnTurn(5, R_GCM)) // FIFTH same-pair ⇒ TRIP 1
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Checklist done.');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ reason: 'intent_mismatch_success', churned: false });
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({ tool: 'update_plan', perma: false, intended: 'get_chat_messages', churned: false });
    expect(String(mockFileStreakInvestigation.mock.calls[0][0].recentFailures[0])).toContain('update_plan→get_chat_messages ×5 consecutive, ticket 2c98b460');
  });

  it('NEGATIVE: an aligned success mid-churn resets the streak — isolated churn pairs never steer, never trip', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(planChurnTurn(1, R_GCM))
      .mockResolvedValueOnce(planChurnTurn(2, R_TL))
      .mockResolvedValueOnce(alignedTurn(3)) // ALIGNED ⇒ streak resets (churn state cleared)
      .mockResolvedValueOnce(planChurnTurn(4, R_SCM))
      .mockResolvedValueOnce(planChurnTurn(5, R_GL))
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Checklist done.');
    expect(steerMessages()).toHaveLength(0);
    expect(reanchorMetrics()).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0);
  });

  it('BOUNDARY (accepted residual): ALTERNATING two called tools keeps the per-tool key cold — no steer, no trip, clean finish', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(planChurnTurn(1, R_GCM))
      .mockResolvedValueOnce(todoChurnTurn(2, R_TL))
      .mockResolvedValueOnce(planChurnTurn(3, R_SCM))
      .mockResolvedValueOnce(todoChurnTurn(4, R_GL))
      .mockResolvedValueOnce(planChurnTurn(5, R_TG))
      .mockResolvedValueOnce(todoChurnTurn(6, R_GCM))
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Checklist done.');
    expect(steerMessages()).toHaveLength(0);
    expect(reanchorMetrics()).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0);
  });
});

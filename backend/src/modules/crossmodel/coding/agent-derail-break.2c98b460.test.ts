/**
 * REPLAY TEST — ticket 2c98b460 (bug_report, 2026-09-22): "kimi-k3 coding
 * lanes derail into wrong-tool loops (update_plan ×27 vs intended
 * get_chat_messages) — third cluster".
 *
 * THE CLUSTER (all contained LATE or not at all, all kimi-k3 coding lanes):
 *   · coordinator e083ff2e (run 02:45Z note): intended get_chat_messages but
 *     update_plan called ×27 — loop containment fired mid-run, 7 plan steps
 *     stranded; the lane self-resumed and completed 8/8 next firing.
 *   · docs lane 10cb988f firing 106: same "[HARNESS] Run ended: repeated
 *     wrong-tool derailment" signature 02:51Z.
 *   · priors: spark lane b95e9df6 (2026-09-20); CanLaw c510c56f todo_create
 *     ×64 + update_plan ×137 went UNNOTICED (run-executor.ts:2054).
 *
 * COVERAGE VERDICT (the ticket's open question — does PR #961's repeated-
 * line derail break cover the wrong-TOOL variant?): NO. Every pre-existing
 * ladder needs a signal these runs never produce:
 *   · the failure derail-breaker counts only FAILURE-SHAPED results
 *     (agent.ts:3472; a success resets the streak at :3529-3531) — the
 *     update_plan calls SUCCEEDED;
 *   · PR #961's repeated-line break (agent.ts:2708-2790) scans only the
 *     assistant's visible narration — it never sees tool calls, results, or
 *     reasoning;
 *   · the identical/near-identical call break (agent.ts:3726-3740) needs a
 *     repeated (digit-collapsed) signature — an update_plan loop varies the
 *     plan every call;
 *   · the 431518a2 re-anchor arms only off refusals/failures (agent.ts
 *     legs (a)/(b)/(c));
 *   · the intent-mismatch weight (agent.ts:3483-3491) executes only INSIDE
 *     the failure branch.
 *   What remained: the soft same-call nudge (agent.ts:1964). Nothing broke
 *   the lock while the narration kept naming the RIGHT tool.
 *
 * THE FIX (this pin): a SUCCESS-side wrong-tool tracker in agent.ts (state
 * block "SUCCESS-side wrong-tool tracker (ticket 2c98b460)" + the leg at
 * the :3529 else). On every successful non-run_command result, the same
 * detector input as the failure branch (:3483) is evaluated; consecutive
 * successes carrying the SAME called→intended mismatch count up:
 *   · the THIRD arms the one-per-run re-anchor (reason
 *     'intent_mismatch_success' — the steer threads the marker and says
 *     "it SUCCEEDED", never the false "and it failed"; reviewer F1);
 *   · the FIFTH trips into the EXISTING withhold → perma → run-end ladder
 *     (derailTripCounts feeds the :3610 gate; the schema filter enforces
 *     the withhold), with a guard_strike metric meta.shape='success_intent'.
 *   An aligned success resets the streak; a failure-shaped result leaves it
 *   untouched (the failure ladder owns it); run_command stays exempt.
 *   (The success-leg kill switch was deleted with RSW-1 cluster 32.)
 *
 * BOUNDARY OCCURRENCE — ticket 9982a167 (spark bench lane 521020fe, run
 * a55ce9b2, read_file ENOENT ×3 intending grep) is the FAILURE-SHAPED
 * sibling of this family: those results were failure-shaped, so the
 * pre-existing failure derail-breaker already contained that run (hence the
 * auto-filed mishap). It needed NO new guard; it is cited here so its close
 * can reference this file as the family's coverage map.
 *
 * BOUNDARY OCCURRENCE #2 — ticket f24fe817 (Re-Send lane cec340f2, run
 * 368a5078, get_chat_messages ×3 preflight-REFUSED on ungrounded chatId
 * 'gc1db699', its narration intending grep) is the same FAILURE-SHAPED
 * sibling class: every emission was refused by the tool-preflight
 * ungrounded-id gate, so the streak was failure-shaped and the pre-existing
 * failure derail-breaker already contained that run (hence the auto-filed
 * mishap). It needed NO new guard; it is cited here so its close can
 * reference this file as the family's coverage map.
 *
 * FIRST POST-COVERAGE WILD CATCH — ticket 92b485bd (Fleet Supervisor lane
 * c0e22e36, schedule_get SUCCEEDED ×5 consecutive while the run's reasoning
 * named get_chat_status, auto-filed 2026-09-22T07:05:51Z) is the guard's
 * own first production containment artifact: the trip message cites ticket
 * 2c98b460 — a message shape only the 777d9f13 code emits — so the streak
 * was served POST-coverage (box-a on 6d1f5092; box-b/c rolled ~07:07–
 * 07:17Z), the success_intent leg steered at 3 and tripped at 5 into the
 * withhold → perma → run-end ladder per design. It needed NO new guard; it
 * is cited here as the family's first live proof the leg fires.
 *
 * SECOND POST-COVERAGE WILD CATCH — ticket c2f3a92f (Framework Operator
 * lane b92ef13f, run 7d0a22dc, read_file SUCCEEDED x5 consecutive while
 * the run's reasoning named get_run_receipts, auto-filed 2026-10-01) is
 * the guard's second production containment artifact and its first
 * SELF-catch (the streak's lane is the one that works this ticket
 * family): same live-proof shape as 92b485bd — every mismatched call
 * SUCCEEDED, so only the success_intent leg could fire; the run COMPLETED
 * after containment (receipts: 213 steps, no error). It needed NO new
 * guard; it is cited here so its close can reference this file as the
 * family's coverage map.
 *
 * These tests drive the REAL agent loop (scaffold mirrors
 * agent-derail-reanchor.431518a2.test.ts): every mismatched call SUCCEEDS
 * ('probe result: ok'), so only the new leg can fire. Args vary by WORD —
 * never by digit — so the exact (:3728) and digit-collapsed (:3738) repeat
 * signatures stay blind, reproducing the incident's escape. No run_command
 * calls anywhere (the scaffold's container mock would leak to a real shell).
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
  worktree: '/tmp/derail-2c98b460-test',
  sessionId: 'sess-2c98b460',
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

/** The e083ff2e shape: update_plan SUCCEEDS while the turn's own reasoning
 *  names get_chat_messages. Args vary by WORD (never digit) so neither the
 *  exact (:3728) nor the digit-collapsed (:3738) repeat signature can see a
 *  loop — the incident's escape, reproduced. */
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa'];
const MISS_REASONING = 'Now get_chat_messages to re-read the dispatcher thread before the next steer goes out.';
const planMissTurn = (n: number) => ({
  content: '',
  reasoning: MISS_REASONING,
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: `${WORDS[(n - 1) % WORDS.length]} reconciliation pass`, status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
/** The second-tool variant for the multi-tool run-end gate: todo_create
 *  (no id args ⇒ never preflight-refused) succeeding under the same
 *  mismatched narration. */
const todoMissTurn = (n: number) => ({
  content: '',
  reasoning: MISS_REASONING,
  toolCalls: [{ id: `t${n}`, name: 'todo_create', arguments: JSON.stringify({ title: `${WORDS[(n - 1) % WORDS.length]} follow-up item` }) }],
  finishReason: 'tool_calls',
});
/** An ALIGNED success: narration names the called tool (the ban-round probe
 *  and the streak reset). list_files — never run_command (see header). */
const alignedTurn = (n: number) => ({
  content: '',
  reasoning: 'Now list_files to check which generated documents exist before editing.',
  toolCalls: [{ id: `t${n}`, name: 'list_files', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls',
});
/** A FAITHFUL update_plan success (narration names update_plan): ordinary
 *  plan maintenance, no derail signal — the negative leg. */
const faithfulPlanTurn = (n: number) => ({
  content: '',
  reasoning: 'Calling update_plan to mark the finished step and keep the board current.',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: `${WORDS[(n - 1) % WORDS.length]} step done`, status: 'pending' }] }) }],
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

describe('ticket 2c98b460 — SUCCESS-side wrong-tool derail guard (the cluster-3 coverage gap)', () => {
  it('UNIT: the incident premise — successes are invisible to the failure detector, and the incident narration convicts get_chat_messages', () => {
    expect(looksLikeToolFailure('probe result: ok')).toBe(false);
    const offered = ['run_command', 'update_plan', 'todo_create', 'list_files', 'get_chat_messages'];
    expect(detectIntendedTool(MISS_REASONING, 'update_plan', offered)).toBe('get_chat_messages');
    expect(detectIntendedTool(MISS_REASONING, 'todo_create', offered)).toBe('get_chat_messages');
    // Guard legs: faithful narration acquits; a too-short text acquits.
    expect(detectIntendedTool(faithfulPlanTurn(1).reasoning, 'update_plan', offered)).toBeNull();
    expect(detectIntendedTool('ok', 'update_plan', offered)).toBeNull();
  });

  it('REPLAY steer-at-3: three consecutive mismatched SUCCESSES inject exactly ONE harness-attributed re-anchor and the run finishes CLEAN — no breaker trip', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(planMissTurn(1))
      .mockResolvedValueOnce(planMissTurn(2))
      .mockResolvedValueOnce(planMissTurn(3)) // THIRD mismatch ⇒ steer arms
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Checklist done.');
    expect(result.modelErrored).toBeUndefined();
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run)');
    expect(steer).toContain('your own reasoning named get_chat_messages');
    expect(steer).toContain('call get_chat_messages NOW');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'update_plan', intended: 'get_chat_messages', reason: 'intent_mismatch_success' });
    // The steer tells the TRUTH about the SUCCESS shape (reviewer F1): it
    // must never claim the calls "failed" when they succeeded 3×.
    expect(steer).toContain('it SUCCEEDED');
    expect(steer).not.toContain('and it failed');
    // The breaker NEVER engaged on successes alone below the trip threshold.
    expect(breakerMetrics()).toHaveLength(0);
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
  });

  it('REPLAY trip-at-5: the FIFTH consecutive mismatched success trips into the existing ladder (withhold 1 round, success_intent metric) WITHOUT ending the run', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(planMissTurn(1))
      .mockResolvedValueOnce(planMissTurn(2))
      .mockResolvedValueOnce(planMissTurn(3))
      .mockResolvedValueOnce(planMissTurn(4))
      .mockResolvedValueOnce(planMissTurn(5)) // FIFTH ⇒ TRIP 1 (update_plan withheld one round)
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Checklist done.');
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');
    expect(reanchorMetrics()).toHaveLength(1); // the steer still fired at the third
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({ tool: 'update_plan', perma: false, intended: 'get_chat_messages' });
    // The deferred notice tells the truth about the SUCCESS shape (never
    // "ALL FAILED") and names the intended tool via the standard hint.
    expect(userTexts().some((t) => t.includes('all SUCCEEDED') && t.includes('update_plan') && t.includes('get_chat_messages'))).toBe(true);
    // …and the success-shape evidence rides the attribution payload verbatim.
    expect(mockFileStreakInvestigation).toHaveBeenCalled();
    expect(String(mockFileStreakInvestigation.mock.calls[0][0].recentFailures[0])).toContain('wrong-tool derailment on successful calls');
    // DW-4 (ticket 568d3652 gap): the ARGS of the 5 succeeding calls ride the
    // same payload — attribution needs no one-off transcript probe. The churned
    // case (c737d007) covers the rotating-intent variant one test down.
    expect(Array.isArray(mockFileStreakInvestigation.mock.calls[0][0].recentArgs)).toBe(true);
    expect(mockFileStreakInvestigation.mock.calls[0][0].recentArgs.length).toBeGreaterThan(0);
    expect(String(mockFileStreakInvestigation.mock.calls[0][0].recentArgs[0])).toContain('steps'); // update_plan's args shape
  });

  it('REPLAY run-end parity: mismatched successes across TWO tools feed the existing terminal gate — the run ends with the byte-exact derailment note naming the intended tool', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(planMissTurn(1))
      .mockResolvedValueOnce(planMissTurn(2))
      .mockResolvedValueOnce(planMissTurn(3))
      .mockResolvedValueOnce(planMissTurn(4))
      .mockResolvedValueOnce(planMissTurn(5)) // TRIP 1 on update_plan (withheld 1 round)
      .mockResolvedValueOnce(alignedTurn(6)) // ban round: update_plan absent from the schema
      .mockResolvedValueOnce(planMissTurn(7))
      .mockResolvedValueOnce(planMissTurn(8))
      .mockResolvedValueOnce(planMissTurn(9))
      .mockResolvedValueOnce(planMissTurn(10))
      .mockResolvedValueOnce(planMissTurn(11)) // TRIP 2 on update_plan ⇒ PERMA
      .mockResolvedValueOnce(todoMissTurn(12))
      .mockResolvedValueOnce(todoMissTurn(13))
      .mockResolvedValueOnce(todoMissTurn(14))
      .mockResolvedValueOnce(todoMissTurn(15))
      .mockResolvedValueOnce(todoMissTurn(16)) // TRIP 1 on todo_create ⇒ 2 tools ⇒ TERMINAL
      .mockResolvedValue(FINAL);
    const input = makeInput(BRIEF, { ...CODING_TEST_PROFILE, maxSteps: 30 });
    const result = await runCodingAgent(input);

    expect(mockRunModelTurn).toHaveBeenCalledTimes(16);
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes');
    expect(result.finalText).toContain('intended tool appears to be get_chat_messages');
    expect(result.finalText).toContain('The next scheduled firing starts fresh.');
    expect(result.modelErrored).toBeUndefined();
    const successTrips = breakerMetrics().filter((m) => m.meta.shape === 'success_intent');
    expect(successTrips.map((m) => m.meta.perma)).toEqual([false, true]); // withhold, then perma on update_plan
    const ended = breakerMetrics().find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta).toMatchObject({ trips: 3, intended: 'get_chat_messages' });
    // ONE steer total across the whole episode (armed at the third mismatch).
    expect(steerMessages()).toHaveLength(1);
    expect(reanchorMetrics()).toHaveLength(1);
  });

  it('NEGATIVE: an aligned success breaks the mismatch streak — two isolated pairs never steer, never trip', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(planMissTurn(1))
      .mockResolvedValueOnce(planMissTurn(2))
      .mockResolvedValueOnce(faithfulPlanTurn(3)) // ALIGNED ⇒ streak resets
      .mockResolvedValueOnce(planMissTurn(4))
      .mockResolvedValueOnce(planMissTurn(5))
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Checklist done.');
    expect(steerMessages()).toHaveLength(0);
    expect(reanchorMetrics()).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0);
  });

});

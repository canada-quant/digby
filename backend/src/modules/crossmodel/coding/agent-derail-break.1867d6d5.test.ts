// LEGACY SCHEMA REPLAY (coding/tool-scope.ts, owner 2026-09-22): this pin replays
// an incident from before the cause-level fix — when `update_feedback` /
// `update_supervisor_state` were offered under their internal names to every
// coding lane. The breaker / pre-flight mechanics it pins are unchanged. The
// always-visible switches below still restore that era's SCOPE; the era's
// internal NAMES cannot be restored — RSW-1 deleted the disambiguation kill
// switch on 2026-11-02, so those tools are offered as `triage_ticket` /
// `save_supervisor_state` and the name assertions below pin the model-facing
// spelling. An EMITTED internal name still resolves and executes.
// (agent-tool-scope.test.ts pins the new default: renamed, scoped, slip-pruned.)
process.env.TRIAGE_TOOLS_ALWAYS_VISIBLE = '1';
process.env.SUPERVISOR_TOOLS_ALWAYS_VISIBLE = '1';

/**
 * Replay pin — ticket 1867d6d5 (mishap, auto-filed at breaker trip
 * 2026-09-21T01:58:19Z; session 596102ca-53de-4f90-a6c1-6e3003a7df95
 * "CanLaw Project Checkpoint Coordination P" (canlegal-bench eval tracking
 * lane), run bf6622bb-08e4-4c29-b59a-d066fd68d024; "first streak this run";
 * "lane's reasoning named todo_get").
 *
 * THE INCIDENT: the read-only tracking lane (silence gate; per-tick probes =
 * get_chat_messages + todo_get) derailed on its firing-237 tick. The breaker
 * auto-filed ONE failure text (newest first) — the complete ungrounded_id
 * preflight refusal envelope:
 *   · { "ok": false, "tool": "update_feedback", "reason": "ungrounded_id",
 *       "rejected": [{ "key": "id", "value": "placeholder" }],
 *       "message": "NOT EXECUTED: update_feedback was called with
 *        id=\"placeholder\", which is not an id you obtained this run — …
 *        Your reasoning named todo_get — you evidently meant to call
 *        todo_get; call it now with its real parameters." } }
 * The harness's run-end note (transcript msg 15a7a515, 2026-09-21T01:51:32Z)
 * records "repeated wrong-tool derailment (3 episodes; intended tool appears
 * to be update_plan)", and the derail-rescue continuation (msg 4473238a,
 * 02:02:06Z) names the looping tools update_feedback + update_document with
 * "Placeholder-id emission is exactly what killed the last run". The lane
 * derailed the same way on three consecutive hourly ticks that evening
 * (runs e0f8845a, f0fc807f, bf6622bb — intended get_chat_messages ×2, then
 * update_plan), each contained by the breaker + rescue.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — the
 * documented kimi-k3 placeholder-emission wrong-tool derail class
 * (f839cede/aff1c189/ec9d7424 → … → afac4aee+769d7278 → 099bd00a →
 * 0c9f2420 → 89ddfcfe/60f64ebb), NOT a framework defect, and NOT the
 * ea69c94e probe-streak false-positive class (no documented deliberate
 * negative probe exists anywhere in the lane's transcript — its successful
 * ticks execute get_chat_messages/todo_get and report the receipts; the
 * derailed ticks show the breaker's own notes):
 *   · the id-grounding PRE-FLIGHT refused the invented id NOT EXECUTED with
 *     the intent-interpolated recovery line (tool-preflight.ts:280) — the
 *     filed envelope diffs byte-clean against the live format with
 *     intended='todo_get';
 *   · the breaker counted as designed — ONE call, weighted 3 (failure +1,
 *     ungrounded fast-trip +1, intent-mismatch fast-trip +1) ≥ 3 → the
 *     "3×" trip with exactly ONE text (the aff1c189 arithmetic: had the
 *     intent fast-trip not fired, a second call would have been needed —
 *     the ONE-text shape PROVES the intent conviction fired);
 *   · no deterministic 'placeholder' seed exists anywhere in the guard code
 *     (grep of tool-preflight.ts: zero literals — grounding is computed
 *     from the run haystack; only a MODEL authors the string "placeholder");
 *   · zero calls reached the executor — nothing was mutated;
 *   · the containment chain fired as designed: preflight refusal → streak
 *     trip → this very ticket auto-filed (source agent-harness) →
 *     derail-rescue continuation #2 (budget spent, supervisor steered).
 * NO platform code change.
 *
 * NEW vs the sibling pins: the intent conviction here names todo_get (a
 * fleet-board READ — first todo_get leg in the family) and the run-level
 * rescue heuristic named a DIFFERENT tool (update_plan) than the streak's
 * intent conviction (todo_get) — both annotations coexist because they are
 * computed at different seams (per-call preflight conviction vs run-level
 * most-narrated-tool). The e2e ladder below proves the ONE-call → weighted-3
 * → ONE-text filing shape with the byte-exact envelope, zero executor
 * touches, and the one-round withhold + grounded recovery.
 *
 * Scaffold mirrors agent-derail-break.aff1c189.test.ts.
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
  formatJournalBlock: jest.fn(() => '',
  ),
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
import { findUngroundedIdArgs, ungroundedIdRefusal } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

/** CODING profile (the incident lane's profile): todo_get is in the offered
 *  schema — the incident's intended tool must be offerable for the intent
 *  conviction to name it (the 0aecbe92 precedent). */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim placeholder id ─────────────────────────────────
const CALL_ID = 'placeholder'; // the model-authored literal carried as update_feedback's id
const RECOVERY_ID = '1867d6d5'; // 8-hex — shape-valid citation for the recovery call

/** The tracking lane's tick brief (read-only silence gate): probes only,
 *  every status read comes from todo_get/transcript pulls. The brief carries
 *  NEITHER the placeholder literal NOR any ticket id, so the emitted id is an
 *  invention the preflight refuses. */
const BRIEF = [
  '[TRACKING TICK — eval lane, read-only]',
  'Pass 1: pull both lane transcripts, then todo_get the three board rows',
  'and confirm no status flips. Classify the landings and STOP.',
  'Never mutate fleet state on this tick.',
].join('\n');

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-1867d6d5-test',
  sessionId: 'sess-1867d6d5',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `${BRIEF}\nRun the tick now.`,
  emit: jest.fn(),
});

/** A turn emitting update_feedback({id:"placeholder"}) while the reasoning
 *  names todo_get (whole word, never the called tool) — the ticket's "lane's
 *  reasoning named todo_get". The intent-mismatch fast-trip convicts on this
 *  call, so ONE call weights 3 and trips with ONE filed text. */
const feedbackTurn = (n: number, id: string) => ({
  content: '',
  reasoning: 'todo_get is the read that settles the board question — pulling the todo row now before any status write.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Tick closed.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay 1867d6d5 — ONE placeholder-id update_feedback emission (reasoning named todo_get) reads as a "3× streak"', () => {
  it('the placeholder id is ungrounded against the run haystack (not id-shaped; appears nowhere the model read)', () => {
    expect(findUngroundedIdArgs({ id: CALL_ID }, BRIEF))
      .toEqual([{ key: 'id', value: CALL_ID }]);
  });

  it('replays the exact refusal envelope from the filed text (ungrounded_id, NOT EXECUTED, the rejected arg, the todo_get-interpolated recovery line)', () => {
    const refusal = JSON.parse(
      ungroundedIdRefusal('update_feedback', [{ key: 'id', value: CALL_ID }], 'todo_get'),
    );
    expect(refusal).toMatchObject({
      ok: false,
      tool: 'update_feedback',
      reason: 'ungrounded_id',
      rejected: [{ key: 'id', value: CALL_ID }],
    });
    expect(refusal.message).toContain('NOT EXECUTED');
    expect(refusal.message).toContain('never from narration');
    expect(refusal.message).toContain(
      'Your reasoning named todo_get — you evidently meant to call todo_get; call it now with its real parameters.',
    );
  });

  it('END-TO-END: ONE call trips the breaker at weighted count 3 (failure +1, ungrounded fast-trip +1, intent-mismatch fast-trip +1) with exactly the ONE filed text — and NOTHING reaches the executor', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(feedbackTurn(1, CALL_ID)) // pre-flight refusal: streak 1 + ungrounded 1 + intent 1 = 3 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // The single call was refused BEFORE execution — the tool layer saw zero calls.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(0);

    // The auto-filed investigation carries EXACTLY the incident's ONE text —
    // the "3×" in its title is the weighted count, not three failures.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_feedback');
    expect(ev.recentFailures).toHaveLength(1);
    const filed = JSON.parse(ev.recentFailures[0]);
    expect(filed).toMatchObject({
      ok: false, tool: 'triage_ticket', reason: 'ungrounded_id', // preflight envelope renders the MODEL-FACING name
      rejected: [{ key: 'id', value: CALL_ID }],
    });
    expect(filed.message).toContain('NOT EXECUTED');
    expect(filed.message).toContain('Your reasoning named todo_get');
    // The intent conviction is recorded on the filing (the ticket's "lane's
    // reasoning named todo_get" line).
    expect(ev.intended).toBe('todo_get');
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
  });

  it('first trip = one-round withhold, NOT perma: a same-tool call two rounds later EXECUTES (the lane recovers with a shape-valid citation and keeps working)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(feedbackTurn(1, CALL_ID))     // count 3 → TRIP, withheld for the next model round
      .mockResolvedValueOnce(feedbackTurn(2, RECOVERY_ID)) // refused: tool not offered (withheld)
      .mockResolvedValueOnce(feedbackTurn(3, RECOVERY_ID)) // back on offer → executes (grounded by hex shape)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    // Exactly ONE execution: the post-withhold recovery call. The incident
    // call died in the pre-flight; the withheld round-2 call never reached
    // the tool (toolNotOffered).
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
    expect(mockExecuteCodingTool.mock.calls[0][1]).toBe('update_feedback');
  });

  it('wiring seam: update_feedback stays a preflight-covered platform tool and the narration-intended board read stays offered', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
    expect(PLATFORM_TOOL_NAMES).toContain('todo_get');
    expect(PLATFORM_TOOL_NAMES).not.toContain('update_document'); // the sibling legs' seam split (89ddfcfe / 60f64ebb)
  });
});

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
 * Replay pin — ticket aff1c189 (mishap, breaker trip 2026-09-20 01:40:21Z,
 * session 28de72e5-46c5-4a90-811d-840184efc106 "GLM-5.3 Deployment on Dual
 * Sparks", run dcd54d60-5d39-447f-bafd-925e1e6b1628; first streak this run).
 *
 * THE INCIDENT: the breaker auto-filed a '3× tool-failure streak:
 * update_feedback' mishap with TWO failure texts (newest first):
 *   1. `{ "ok": false, "tool": "update_feedback", "reason": "ungrounded_id",
 *        "rejected": [{ "key": "id", "value": "noop-wrong-tool" }],
 *        "message": "NOT EXECUTED: update_feedback was called with
 *        id=\"noop-wrong-tool\", which is not an id you obtained this run — …" }`
 *   2. `{ … "rejected": [{ "key": "id", "value": "placeholder-noop" }] … }`
 * i.e. chronologically the lane emitted update_feedback({id:"placeholder-noop"})
 * then update_feedback({id:"noop-wrong-tool"}); the id-grounding PRE-FLIGHT
 * refused BOTH without executing.
 *
 * WHAT ACTUALLY HAPPENED (adjudication against the lane's transcript,
 * 2026-09-20): the lane runs kimi-k3. Its NEXT live run (parity-probe firing,
 * transcript msg b9301459, 01:39:21Z→01:52:23Z) shows the model caught in a
 * ~13-minute tool-dispatch loop, narrating "Now calling search_memory — the
 * correct tool, right now" dozens of times without the tool executing, with
 * self-aware misfire narration ("Wrong tool — I'm not the supervisor",
 * "My mistake on the tool selection", "Tool dispatch is stable again"). The
 * two update_feedback emissions are that same MODEL-side narration/emission
 * instability: the model authored placeholder ids ("placeholder-noop",
 * "noop-wrong-tool" — the id NAMES literally narrate the model's own
 * awareness it emitted a wrong no-op call). A framework emission-layer garble
 * would have carried the intended call's real args (a chatId, a limit); only
 * a model authors the string "noop-wrong-tool".
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — the kimi-k3
 * decoder-lock class tool-preflight.ts was BUILT for (its header documents
 * the 2026-09-09 derailment class: "kimi-k3 … decoder-locked on a platform
 * tool it never meant to call — update_feedback({id:\"noop\"})"). Every
 * deterministic seam behaved as designed:
 *   · the pre-flight refused both invented ids NOT EXECUTED (referential
 *     grounding: neither is id-shaped nor present anywhere the model read);
 *   · the breaker counted as designed — each ungrounded refusal weights
 *     +1 failure +1 fast-trip ("an invented id is never real work"), so TWO
 *     calls read as the "3×" trip (2 + 2 = 4 ≥ 3);
 *   · no shape exemption is warranted (ea69c94e doctrine: ungrounded/existence
 *     refusals are the breaker's primary derailment signal — contrast the
 *     always-benign needsConfirmation envelope, ticket 1ab1a52b);
 *   · the intent-mismatch fast-trip did NOT fire on call 1 in the real run —
 *     had it, call 1 alone would have weighted 3 and tripped with ONE text;
 *     the filed TWO-text shape pins the real arithmetic (the replayed turns
 *     therefore name the called tool, keeping `intended` out, exactly as the
 *     filed envelopes show no intended annotation).
 * NO platform code change.
 *
 * These tests pin: both placeholder ids are ungrounded against the run's
 * haystack, the refusal envelope is byte-faithful to the filed texts, the two
 * real calls trip the breaker at weighted count ≥3 with exactly the two filed
 * texts (newest first), zero calls reach the executor, and the first trip
 * withholds the tool for ONE round (not perma). Scaffold mirrors
 * agent-derail-break.d0b9c6a6.test.ts (same mock set).
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
  buildChatWakeClockNote: jest.fn(() => ""),
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

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// ── The incident's verbatim ids (ticket aff1c189) ───────────────────────────
const CALL1_ID = 'placeholder-noop'; // the older call (filed text #2)
const CALL2_ID = 'noop-wrong-tool'; // the newer call (filed text #1)
const RECOVERY_ID = 'aff1c189'; // 8-hex — shape-valid citation for the recovery call

/** The probe-lane brief — deliberately free of the placeholder tokens, so
 *  both call ids are UNGROUNDED in this run's haystack. */
const BRIEF = [
  '[Parity-probe cadence — read-only fleet classification]',
  'Recover the banked SSM probe pattern, docker-inspect the vllm_node pair on',
  'S3+S5, compare the ghcr manifest digest, relay the green/dark classification.',
  'Every claim cites a this-run receipt; never mutate fleet state.',
].join('\n');

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-aff1c189-test',
  sessionId: 'sess-aff1c189',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `${BRIEF}\nRun the probe now.`,
  emit: jest.fn(),
});

/** A turn calling update_feedback — the reasoning NAMES the called tool so the
 *  intent-mismatch fast-trip stays out of the replay, matching the real run:
 *  the filed TWO-text shape proves `intended` did not convict call 1 (had it,
 *  call 1 would have weighted 3 alone and tripped with a single text). */
const feedbackTurn = (n: number, id: string) => ({
  content: '',
  reasoning: `update_feedback call ${n}: close out the streak ticket with id ${id} per the run's bookkeeping.`,
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Probe relayed.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay aff1c189 — two placeholder-id update_feedback emissions read as a "3× streak"', () => {
  it('both placeholder ids are ungrounded against the run haystack (neither is id-shaped; neither appears anywhere the model read)', () => {
    expect(findUngroundedIdArgs({ id: CALL1_ID }, BRIEF))
      .toEqual([{ key: 'id', value: CALL1_ID }]);
    expect(findUngroundedIdArgs({ id: CALL2_ID }, BRIEF))
      .toEqual([{ key: 'id', value: CALL2_ID }]);
  });

  it('replays the exact refusal envelope from the filed texts (ungrounded_id, NOT EXECUTED, the rejected arg, the tool-interpolated recovery line)', () => {
    for (const value of [CALL1_ID, CALL2_ID]) {
      const refusal = JSON.parse(
        ungroundedIdRefusal('update_feedback', [{ key: 'id', value }], null),
      );
      expect(refusal).toMatchObject({
        ok: false,
        tool: 'update_feedback',
        reason: 'ungrounded_id',
        rejected: [{ key: 'id', value }],
      });
      expect(refusal.message).toContain('NOT EXECUTED');
      expect(refusal.message).toContain('never from narration');
      expect(refusal.message).toContain(
        'If you have no such id, you do not need update_feedback right now — call the tool that advances the task instead.',
      );
    }
  });

  it('END-TO-END: the two real calls trip the breaker at weighted count 4 (ungrounded fast-trip +1 each) with exactly the two filed texts, newest first — and NOTHING reaches the executor', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(feedbackTurn(1, CALL1_ID)) // pre-flight refusal: streak 1 + fast-trip 1 = 2
      .mockResolvedValueOnce(feedbackTurn(2, CALL2_ID)) // pre-flight refusal: streak 3 + fast-trip 1 = 4 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // Both calls were refused BEFORE execution — the tool layer saw zero calls.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(0);

    // The auto-filed investigation carries EXACTLY the incident's two texts,
    // newest first — the "3×" in its title is the weighted count, not three
    // failures.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_feedback');
    expect(ev.recentFailures).toHaveLength(2);
    const filedNewer = JSON.parse(ev.recentFailures[0]);
    expect(filedNewer).toMatchObject({
      ok: false, tool: 'triage_ticket', reason: 'ungrounded_id', // preflight envelope renders the MODEL-FACING name
      rejected: [{ key: 'id', value: CALL2_ID }],
    });
    expect(filedNewer.message).toContain('NOT EXECUTED');
    const filedOlder = JSON.parse(ev.recentFailures[1]);
    expect(filedOlder).toMatchObject({
      ok: false, tool: 'triage_ticket', reason: 'ungrounded_id', // preflight envelope renders the MODEL-FACING name
      rejected: [{ key: 'id', value: CALL1_ID }],
    });
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
  });

  it('first trip = one-round withhold, NOT perma: a same-tool call two rounds later EXECUTES (the lane recovers with a shape-valid citation and keeps working)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(feedbackTurn(1, CALL1_ID))     // count 2
      .mockResolvedValueOnce(feedbackTurn(2, CALL2_ID))     // count 4 → TRIP, withheld for the next model round
      .mockResolvedValueOnce(feedbackTurn(3, RECOVERY_ID))  // refused: tool not offered (withheld)
      .mockResolvedValueOnce(feedbackTurn(4, RECOVERY_ID))  // back on offer → executes (grounded by hex shape)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    // Exactly ONE execution: the post-withhold recovery call. The two incident
    // calls died in the pre-flight; the withheld round-3 call never reached
    // the tool (toolNotOffered).
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
    expect(mockExecuteCodingTool.mock.calls[0][1]).toBe('update_feedback');
  });

  it('wiring seam: update_feedback stays a preflight-covered platform tool and the mandate read tool stays offered', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
    expect(PLATFORM_TOOL_NAMES).toContain('get_chat_messages'); // the narration-intended probe tool
  });
});

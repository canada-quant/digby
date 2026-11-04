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
 * Replay pin — ticket 03b13d6e (mishap, session d4c97977-62f9-4c56-9721-
 * a6e644abbe1d "Post-Sweep Acceptance Criteria Verified", run
 * bd7493f0-3a0e-4756-b762-9ccf07c60117, seat kimi-k3).
 *
 * THE INCIDENT: the breaker auto-filed a '3× tool-failure streak:
 * update_feedback' mishap with TWO failure texts (newest first):
 *   1. `{"ok":false,"tool":"update_feedback","reason":"ticket_not_found",
 *        "ticketId":"noop","message":"This machine-triggered run may NOT
 *        mutate feedback ticket noop: the ticket is not dispatched to this
 *        session (its context.dispatchedTo names another session) and no
 *        verifiable evidence was supplied. Dispatch binding is the
 *        sanctioned path — …"}`  (the ticket-18086326 machine-MUTATION
 *        gate; truncated in filing)
 *   2. `{"ok":false,"tool":"update_feedback","reason":"ungrounded_id",
 *        "rejected":[{"key":"id","value":"noop"}],"message":"NOT EXECUTED:
 *        update_feedback was called with id=\"noop\", which is not an id you
 *        obtained this run — ids come from a prior tool result
 *        (list_* / get_*), the brief, or the user, never from narration. If
 *        you have no such id, you do not need update_feedback right now —
 *        call the tool that …"}`  (pre-flight refusal, NOT EXECUTED)
 * Newest-first means CHRONOLOGY is: the lane emitted
 * update_feedback({id:"noop"}) FIRST — "noop" is not id-shaped
 * (ID_SHAPE_RE /^[0-9a-f]{8}/i, tool-preflight.ts:35 — 4 chars, non-hex)
 * and occurred nowhere in the run's haystack — so the PRE-FLIGHT refused it
 * NOT EXECUTED (agent.ts:2964-2976 → 3031-3032). That refusal envelope is
 * pushed into the message list as a tool result (agent.ts:3148), and
 * groundingHaystack READS tool results (assistant turns are the only
 * exclusion, tool-preflight.ts:40-60) — so the envelope's verbatim
 * `id="noop"` GROUNDED the lane's IDENTICAL second call (haystack.includes
 * verbatim-occurrence rule, tool-preflight.ts:73 — the documented 00667344
 * echo mechanism: a refusal containing the id verbatim grounds a later
 * identical call). Call 2 EXECUTED and the dispatch-binding gate refused
 * it truthfully. Weighted math (agent.ts:3171-3183): call 1 = +1 failure
 * (3172-3173) +1 ungrounded fast-trip (3182) = 2; call 2 = +1 failure
 * = 3 → TRIP (3184), with exactly these two texts captured newest-first
 * (3176-3177) and exactly ONE call ever reaching the executor. The ticket
 * carries NO "lane's reasoning named …" note, and this replay's turns name
 * update_feedback in their reasoning so the intent-mismatch weight
 * (3181-3183) never enters — the arithmetic is exactly 2 + 1.
 *
 * ENVELOPE PROVENANCE (d2c2744b divergence — pinned, not a defect): the
 * filed gate envelope pairs reason:"ticket_not_found" with the LEGACY
 * "not dispatched to this session" message. Current main
 * (platform-tools.ts:3596-3610, post-#890 d4946f2ac, merged 2026-09-19)
 * renders the ticket_not_found truth variant (3598-3608: "If this id was
 * fabricated or mistyped, re-derive a real one from
 * list_feedback/get_feedback …") for a genuinely-absent row; the 3609
 * "not dispatched" message now pairs only with a non-ticket_not_found
 * verdict. The incident predates that deploy, so this suite pins the FILED
 * incident-era envelope as an injected constant (the same provenance the
 * ec9d7424 scaffold pins) — the breaker counts RESULT TEXT, so the replay
 * is exact at the counting seam either way.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — the lane
 * invented a narration token ("noop") where an id belongs, then re-emitted
 * the identical call through the refusal echo — NOT a deterministic
 * framework defect; every deterministic seam (referential grounding incl.
 * its echo corner, the 18086326 mutation gate, the weighted breaker, the
 * one-round withhold) behaved exactly as designed. No shape exemption
 * (ea69c94e doctrine). NO platform code change.
 *
 * These tests pin: the grounding asymmetry ("noop" ungrounded against the
 * brief haystack; grounded once the refusal echo joins it), both refusal
 * envelopes byte-faithful to the filed texts (the gate message renders
 * ticketId.slice(0,8) → "noop"), the two real calls tripping the breaker
 * at weighted count 3 with the two filed texts newest-first, exactly one
 * call reaching the executor, and the first trip withholding the tool for
 * ONE round (not perma). Scaffold mirrors
 * agent-derail-break.ec9d7424.test.ts (same mock set).
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

// ── The incident's verbatim id (ticket 03b13d6e) ─────────────────────────────
const CALL_ID = 'noop'; // BOTH calls carried id "noop" — call 1 ungrounded (filed text #2), call 2 echo-grounded (filed text #1)
const RECOVERY_ID = '03b13d6e'; // 8-hex — shape-valid citation for the recovery call

/** The gate envelope exactly as the breaker counted it — reason/ticketId plus
 *  the incident-era production message template (the filed text truncates
 *  mid-string; ticketId.slice(0,8) → "noop"). See the header's d2c2744b
 *  provenance note: current main renders the ticket_not_found truth variant
 *  for a genuinely-absent row — this pins the FILED shape. */
const GATE_ENVELOPE = JSON.stringify(
  {
    ok: false,
    tool: 'update_feedback',
    reason: 'ticket_not_found',
    ticketId: CALL_ID,
    message:
      `This machine-triggered run may NOT mutate feedback ticket ${CALL_ID.slice(0, 8)}: the ticket is not dispatched to this session ` +
      '(its context.dispatchedTo names another session) and no verifiable evidence was supplied. Dispatch binding is the sanctioned path — ' +
      'a dispatched lane works its OWN tickets (in_progress/adminNote/priority) without the artifact bar; without binding the evidence bar ' +
      'applies to EVERY status, not just done.',
  },
  null,
  1,
);

/** The post-sweep brief — deliberately carries NO occurrence of the string
 *  "noop" (the real run's haystack had none), so call 1 is UNGROUNDED. */
const BRIEF = [
  '[Post-sweep acceptance tick — record-only criteria watch]',
  'Re-verify the sweep acceptance criteria against fresh pulls, then classify drift.',
  'Never mutate platform state from narration; ids come from a prior tool',
  'result (list_*/get_*), the brief, or the user.',
].join('\n');

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-03b13d6e-test',
  sessionId: 'sess-03b13d6e',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `${BRIEF}\nRun the tick now.`,
  emit: jest.fn(),
});

/** A turn calling update_feedback — the reasoning NAMES the called tool so the
 *  intent-mismatch fast-trip (agent.ts:3181-3183) stays out of the replay,
 *  matching the incident: the ticket carries no "reasoning named" note, and
 *  the filed TWO-text shape pins weighted (1+1) + 1 = 3 exactly. */
const feedbackTurn = (n: number, id: string) => ({
  content: '',
  reasoning: `update_feedback call ${n}: record the sweep finding against ticket ${id} per the run's bookkeeping.`,
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Tick recorded.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay 03b13d6e — one ungrounded refusal + one echo-grounded identical re-call read as a "3× update_feedback streak"', () => {
  it('grounding asymmetry: "noop" is UNGROUNDED against the brief haystack, but GROUNDED once the refusal echo (id="noop" verbatim) joins it — the 00667344 mechanism (tool-preflight.ts:73)', () => {
    // The brief carries no "noop" occurrence — the verbatim-occurrence rule
    // cannot ground what was never read, and the id is not id-shaped.
    expect(BRIEF.includes(CALL_ID)).toBe(false);
    expect(findUngroundedIdArgs({ id: CALL_ID }, BRIEF))
      .toEqual([{ key: 'id', value: CALL_ID }]);
    // The call-1 refusal echoes id="noop" verbatim into the transcript; a
    // tool-result message is haystack — so the IDENTICAL second call is
    // grounded (the echo grounds the re-call: 00667344).
    const echo = ungroundedIdRefusal('update_feedback', [{ key: 'id', value: CALL_ID }], null);
    expect(echo.includes(CALL_ID)).toBe(true); // the raw envelope carries the id verbatim (JSON-escaped as id=\"noop\")
    expect(findUngroundedIdArgs({ id: CALL_ID }, `${BRIEF}\n${echo}`)).toEqual([]);
  });

  it('replays the exact pre-flight refusal envelope from filed text #2 (ungrounded_id, NOT EXECUTED, the rejected arg)', () => {
    const refusal = JSON.parse(
      ungroundedIdRefusal('update_feedback', [{ key: 'id', value: CALL_ID }], null),
    );
    expect(refusal).toMatchObject({
      ok: false,
      tool: 'update_feedback',
      reason: 'ungrounded_id',
      rejected: [{ key: 'id', value: CALL_ID }],
    });
    expect(refusal.message).toContain('NOT EXECUTED');
    expect(refusal.message).toContain('id="noop"');
    expect(refusal.message).toContain('never from narration');
    // The no-intended branch (the incident carried no intent signal).
    expect(refusal.message).toContain(
      'If you have no such id, you do not need update_feedback right now — call the tool that advances the task instead.',
    );
  });

  it('pins the dispatch-gate envelope from filed text #1 (ticket_not_found; message renders ticketId.slice(0,8) = "noop"; the 18086326 binding language)', () => {
    const env = JSON.parse(GATE_ENVELOPE);
    expect(env).toMatchObject({
      ok: false,
      tool: 'update_feedback',
      reason: 'ticket_not_found',
      ticketId: CALL_ID,
    });
    expect(env.message).toContain('may NOT mutate feedback ticket noop');
    expect(env.message).toContain('not dispatched to this session');
    expect(env.message).toContain('Dispatch binding is the sanctioned path');
    expect(env.message).toContain('applies to EVERY status, not just done.');
  });

  it('END-TO-END: the two real calls trip the breaker at weighted count 3 with exactly the two filed texts, newest first — and exactly ONE call reaches the executor', async () => {
    // Call 1: "noop" ungrounded → the REAL pre-flight refuses NOT EXECUTED
    // (+1 failure, +1 ungrounded fast-trip = 2; agent.ts:3172-3182). Its
    // refusal echoes id="noop" into the tool-result haystack → call 2 is
    // GROUNDED → executes → the injected dispatch-gate envelope (+1 = 3
    // → TRIP at agent.ts:3184).
    mockExecuteCodingTool.mockResolvedValueOnce(GATE_ENVELOPE).mockResolvedValue('{"ok":true}');
    mockRunModelTurn
      .mockResolvedValueOnce(feedbackTurn(1, CALL_ID)) // pre-flight refusal: streak 2
      .mockResolvedValueOnce(feedbackTurn(2, CALL_ID)) // echo-grounded → executes → gate refusal: 3 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // Only call 2 executed — call 1 was refused BEFORE execution.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);

    // The auto-filed investigation carries EXACTLY the incident's two texts,
    // newest first: the dispatch-gate envelope, then the pre-flight refusal.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_feedback');
    expect(ev.perma).toBe(false);
    expect(ev.intended).toBeNull(); // no intent-mismatch entered this streak
    expect(ev.recentFailures).toHaveLength(2);
    const filedNewer = JSON.parse(ev.recentFailures[0]);
    expect(filedNewer).toMatchObject({
      ok: false, tool: 'update_feedback', reason: 'ticket_not_found', ticketId: CALL_ID,
    });
    expect(filedNewer.message).toContain('may NOT mutate feedback ticket noop');
    const filedOlder = JSON.parse(ev.recentFailures[1]);
    expect(filedOlder).toMatchObject({
      ok: false, tool: 'triage_ticket', reason: 'ungrounded_id', // preflight envelope renders the MODEL-FACING name
      rejected: [{ key: 'id', value: CALL_ID }],
    });
    expect(filedOlder.message).toContain('NOT EXECUTED');
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
  });

  it('first trip = one-round withhold, NOT perma: a same-tool call two rounds later EXECUTES (the lane recovers with a shape-valid citation and keeps working)', async () => {
    mockExecuteCodingTool.mockResolvedValueOnce(GATE_ENVELOPE).mockResolvedValue('{"ok":true}');
    mockRunModelTurn
      .mockResolvedValueOnce(feedbackTurn(1, CALL_ID))      // count 2 (ungrounded fast-trip)
      .mockResolvedValueOnce(feedbackTurn(2, CALL_ID))      // count 3 → TRIP, withheld for the next model round
      .mockResolvedValueOnce(feedbackTurn(3, RECOVERY_ID))  // refused: tool not offered (withheld)
      .mockResolvedValueOnce(feedbackTurn(4, RECOVERY_ID))  // back on offer → executes (grounded by hex shape)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    // Exactly TWO executions: the echo-grounded incident call and the
    // post-withhold recovery call. The withheld round-3 call never reached
    // the tool.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);
  });

  it('wiring seam: update_feedback stays a preflight-covered platform tool', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
  });
});

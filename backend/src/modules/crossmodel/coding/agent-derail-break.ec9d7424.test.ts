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
 * Replay pin — ticket ec9d7424 (mishap, breaker trip 2026-09-20 01:41:31Z,
 * session 596102ca-53de-4f90-a6c1-6e3003a7df95 "CanLaw Project Checkpoint
 * Coordination P", run 6b2da4ad-b42e-469e-8d9f-3fa17f7e6918 = tracking-tick
 * firing 213/500, closed 01:46:23.631Z; first streak this run; "lane's
 * reasoning named todo_get").
 *
 * THE INCIDENT: the breaker auto-filed a '3× tool-failure streak:
 * update_feedback' mishap with TWO failure texts (newest first):
 *   1. `{ "ok": false, "tool": "update_feedback", "reason": "ungrounded_id",
 *        "rejected": [{ "key": "id", "value": "placeholder-check" }],
 *        "message": "NOT EXECUTED: update_feedback was called with
 *        id=\"placeholder-check\", …" }`  (pre-flight refusal, NOT EXECUTED)
 *   2. `{ "ok": false, "tool": "update_feedback", "reason": "ticket_not_found",
 *        "ticketId": "placeholder", "message": "This machine-triggered run may
 *        NOT mutate feedback ticket placehol: the ticket is not dispatched to
 *        this session (its context.dispatchedTo names another session) and no
 *        verifiable evidence was supplied. Dispatch binding is the sanctioned
 *        path — …" }`  (the ticket-18086326 machine-MUTATION gate)
 * Newest-first means CHRONOLOGY is: the lane emitted
 * update_feedback({id:"placeholder"}) FIRST — that id was GROUNDED (the bare
 * word "placeholder" occurred verbatim in the run's haystack — transcript
 * pulls/claim doctrine are full of it; the pre-flight's verbatim-occurrence
 * rule cannot distinguish that from a real citation, the documented 00667344
 * mechanism) — so it EXECUTED and the dispatch-binding gate refused it
 * truthfully; THEN update_feedback({id:"placeholder-check"}) — not id-shaped,
 * absent from the haystack — was refused NOT EXECUTED by the pre-flight.
 * Weighted math: 1 (gate failure) + 1 (ungrounded failure) + 1 (ungrounded
 * fast-trip) = 3 → TRIP, with exactly these two texts.
 *
 * COMPANION TICKET f839cede (bug_report, priority 2) IS THIS SAME RUN — the
 * filing lane's final (transcript msg 9e20aa18) reported "~5 consecutive
 * get_chat_messages attempts garbled into other calls (a ticket_not_found
 * refusal on update_feedback, plus duplicate todo reads)". f839cede's
 * emission-layer-garbling hypothesis is REFUTED by the arg evidence: a
 * harness-side transformation of get_chat_messages({chatId, limit}) would
 * preserve the real args; the executed call carried a MODEL-AUTHORED
 * placeholder string ("placeholder" / "placeholder-check"). The harness has
 * no tool-rewrite layer — tool-preflight.ts is refuse-only, and the model's
 * structured output IS the executed call. The containment chain held
 * end-to-end: the pre-flight/gate refused every mutating emission, the
 * breaker filed ONE deduped ticket, and the lane HONESTLY DISCLOSED the
 * unexecuted probes in its final (no false "nothing new landed"
 * classification — the claim bar worked). Seat: kimi-k3 — the decoder-lock
 * class tool-preflight.ts was built for (its header, 2026-09-09).
 *
 * VERDICT (both tickets' mandated investigation): MODEL BEHAVIOR — narration/
 * emission mismatch producing placeholder-laden update_feedback emissions —
 * NOT a deterministic framework defect; every deterministic seam (referential
 * grounding, the 18086326 mutation gate, the weighted breaker, the one-round
 * withhold) behaved exactly as designed. No shape exemption (ea69c94e
 * doctrine). NO platform code change.
 *
 * These tests pin: the chronology's grounding asymmetry ("placeholder"
 * grounded by a bare-word haystack occurrence while "placeholder-check" stays
 * ungrounded against the same haystack), both refusal envelopes byte-faithful
 * to the filed texts (incl. the gate's ticketId.slice(0,8) → "placehol"),
 * the two real calls tripping the breaker at weighted count 3 with the two
 * filed texts newest-first, exactly one call reaching the executor, and the
 * first trip withholding the tool for ONE round (not perma). Scaffold mirrors
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

// ── The incident's verbatim ids (ticket ec9d7424) ───────────────────────────
const CALL1_ID = 'placeholder'; // the OLDER call — grounded, executed, gate-refused (filed text #2)
const CALL2_ID = 'placeholder-check'; // the NEWER call — pre-flight NOT EXECUTED (filed text #1)
const RECOVERY_ID = 'ec9d7424'; // 8-hex — shape-valid citation for the recovery call

/** The gate envelope exactly as the breaker counted it — reason/ticketId plus
 *  the production message template (platform-tools.ts: feedback ticket
 *  ${ticketId.slice(0,8)} → "placehol"; the filed text truncates mid-string). */
const GATE_ENVELOPE = JSON.stringify(
  {
    ok: false,
    tool: 'update_feedback',
    reason: 'ticket_not_found',
    ticketId: CALL1_ID,
    message:
      `This machine-triggered run may NOT mutate feedback ticket ${CALL1_ID.slice(0, 8)}: the ticket is not dispatched to this session ` +
      '(its context.dispatchedTo names another session) and no verifiable evidence was supplied. Dispatch binding is the sanctioned path — ' +
      'a dispatched lane works its OWN tickets (in_progress/adminNote/priority) without the artifact bar; without binding the evidence bar ' +
      'applies to EVERY status, not just done.',
  },
  null,
  1,
);

/** The tracking-lane brief — carries the bare word "placeholder" (as the real
 *  run's haystack did: transcript pulls and claim doctrine are full of it) so
 *  call 1 is GROUNDED, but never the string "placeholder-check". */
const BRIEF = [
  '[Tracking tick — record-only checkpoint watch]',
  'Fresh pulls of the coordinator and bench transcripts, then classify drift.',
  'Never mutate platform state from narration; never pass a placeholder id —',
  'ids come from a prior tool result, the brief, or the user.',
].join('\n');

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-ec9d7424-test',
  sessionId: 'sess-ec9d7424',
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
 *  intent-mismatch fast-trip stays out of the replay, matching the real run:
 *  the filed TWO-text shape pins weighted 1 + (1+1) = 3; an `intended`
 *  conviction on either call would have changed the arithmetic (the ticket's
 *  "lane's reasoning named todo_get" note is the auto-filer's observation,
 *  not a detected `intended` field — the filed envelopes carry none). */
const feedbackTurn = (n: number, id: string) => ({
  content: '',
  reasoning: `update_feedback call ${n}: record the streak finding against ticket ${id} per the run's bookkeeping.`,
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Tick recorded.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay ec9d7424 — one grounded placeholder execution + one ungrounded refusal read as a "3× streak" (companion: f839cede)', () => {
  it('grounding asymmetry: the bare word "placeholder" in the haystack grounds call 1, but does NOT ground the longer "placeholder-check" (verbatim-occurrence rule, the 00667344 mechanism)', () => {
    expect(findUngroundedIdArgs({ id: CALL1_ID }, BRIEF)).toEqual([]);
    expect(findUngroundedIdArgs({ id: CALL2_ID }, BRIEF))
      .toEqual([{ key: 'id', value: CALL2_ID }]);
  });

  it('replays the exact pre-flight refusal envelope from filed text #1 (ungrounded_id, NOT EXECUTED, the rejected arg)', () => {
    const refusal = JSON.parse(
      ungroundedIdRefusal('update_feedback', [{ key: 'id', value: CALL2_ID }], null),
    );
    expect(refusal).toMatchObject({
      ok: false,
      tool: 'update_feedback',
      reason: 'ungrounded_id',
      rejected: [{ key: 'id', value: CALL2_ID }],
    });
    expect(refusal.message).toContain('NOT EXECUTED');
    expect(refusal.message).toContain('never from narration');
    expect(refusal.message).toContain(
      'If you have no such id, you do not need update_feedback right now — call the tool that advances the task instead.',
    );
  });

  it('pins the dispatch-gate envelope from filed text #2 (ticket_not_found; message renders ticketId.slice(0,8) = "placehol"; the 18086326 binding language)', () => {
    const env = JSON.parse(GATE_ENVELOPE);
    expect(env).toMatchObject({
      ok: false,
      tool: 'update_feedback',
      reason: 'ticket_not_found',
      ticketId: CALL1_ID,
    });
    expect(env.message).toContain('may NOT mutate feedback ticket placehol');
    expect(env.message).toContain('not dispatched to this session');
    expect(env.message).toContain('Dispatch binding is the sanctioned path');
  });

  it('END-TO-END: the two real calls trip the breaker at weighted count 3 with exactly the two filed texts, newest first — and exactly ONE call reaches the executor', async () => {
    // Call 1 is grounded by the BRIEF's bare "placeholder" and executes → the
    // injected dispatch-gate envelope. Call 2 hits the REAL pre-flight in the
    // loop (never reaches executeCodingTool).
    mockExecuteCodingTool.mockResolvedValueOnce(GATE_ENVELOPE).mockResolvedValue('{"ok":true}');
    mockRunModelTurn
      .mockResolvedValueOnce(feedbackTurn(1, CALL1_ID)) // executes → gate refusal: streak 1
      .mockResolvedValueOnce(feedbackTurn(2, CALL2_ID)) // pre-flight refusal: streak 2 + fast-trip 1 = 3 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // Only call 1 executed — call 2 was refused BEFORE execution.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);

    // The auto-filed investigation carries EXACTLY the incident's two texts,
    // newest first: the pre-flight refusal, then the dispatch-gate envelope.
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
      ok: false, tool: 'update_feedback', reason: 'ticket_not_found', ticketId: CALL1_ID,
    });
    expect(filedOlder.message).toContain('may NOT mutate feedback ticket placehol');
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
  });

  it('first trip = one-round withhold, NOT perma: a same-tool call two rounds later EXECUTES (the lane recovers with a shape-valid citation and keeps working)', async () => {
    mockExecuteCodingTool.mockResolvedValueOnce(GATE_ENVELOPE).mockResolvedValue('{"ok":true}');
    mockRunModelTurn
      .mockResolvedValueOnce(feedbackTurn(1, CALL1_ID))     // count 1
      .mockResolvedValueOnce(feedbackTurn(2, CALL2_ID))     // count 3 → TRIP, withheld for the next model round
      .mockResolvedValueOnce(feedbackTurn(3, RECOVERY_ID))  // refused: tool not offered (withheld)
      .mockResolvedValueOnce(feedbackTurn(4, RECOVERY_ID))  // back on offer → executes (grounded by hex shape)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    // Exactly TWO executions: the grounded incident call and the post-withhold
    // recovery call. The withheld round-3 call never reached the tool.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);
  });

  it('wiring seam: update_feedback stays a preflight-covered platform tool and the mandate read tools stay offered', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
    expect(PLATFORM_TOOL_NAMES).toContain('get_chat_messages'); // the firing-213 mandate probes #1/#2
    expect(PLATFORM_TOOL_NAMES).toContain('todo_get'); // the reasoning-named tool in the ticket
  });
});

/**
 * Replay pin — ticket 718a04a5 (bug_report, filed 2026-09-20T04:24:16Z by the
 * CanLaw supervisor f5c2c1f4; incident lane e083ff2e-de98-412a-85df-86923572db1d,
 * kimi-k3, auto, recurring machine-triggered firing ~03:43Z; lane final report
 * transcript msg 28d6f9c0).
 *
 * THE INCIDENT: the lane emitted EVERY intended tool call (run_command,
 * git_status, observe, transcript reads, edit, commit, send, delegate) as
 * `update_document` with fabricated placeholder ids ('placeholderNNN' —
 * VARYING), plus 3 update_feedback placeholders. Each update_document call
 * EXECUTED into the ToolCache document seam and returned the harmless
 * existence refusal:
 *   `No generated file with id placeholderNNN belongs to this user. Call
 *    list_files to see the current files.`        (tool-executor.ts)
 * Zero state was touched — but the loop burned ~213 steps across TWO
 * auto-continues, produced zero verified work, and left the plan 0/6. Only
 * update_plan executed (3 calls).
 *
 * WHY EVERY EXISTING BREAKER MISSED IT (adjudication 2026-09-20):
 *   · derail breaker — the refusal envelope matched NO entry in
 *     FAILURE_MARKERS (learnings-index.service.ts), so looksLikeToolFailure
 *     read it as SUCCESS and the consecutive-failure streak never accumulated
 *     (a "success" RESETS the streak, agent.ts:3049-3050);
 *   · identical-call repeat breaker — the placeholder ids VARIED per call,
 *     so no identical (name+args) signature ever repeated;
 *   · batch cap + storm trip (dd2c1718, autonomy loop #9) — fires only on
 *     >24-call turns; this loop ran ONE call per turn for ~213 turns;
 *   · narrated-but-unexecuted loop breaker (#894, ticket 177a31b7) — requires
 *     call-FREE announcement turns; here a tool call EXECUTED every turn.
 * The grounding preflight also behaved as designed: the model narrated the
 * placeholder tokens first, so the verbatim-occurrence rule (00667344 echo)
 * GROUNDED the ids and the calls executed past it into the harmless refusal.
 *
 * THE FIX (one concern): register the document-tools existence-refusal
 * envelopes (generated-file + knowledge-document variants) as ANCHORED
 * FAILURE_MARKERS entries — the derail breaker's existing machinery (3
 * consecutive → one-round withhold + auto-filed investigation; escalation →
 * run-end) now catches the loop, which is exactly the ticket's suggested
 * "circuit breaker for N consecutive rejected identical-shape calls" via the
 * existing, telemetered path instead of a parallel one. A legit lane that
 * mistypes a fileId recovers in one call (list_files → real id) and never
 * reaches 3 consecutive. The 7c1e5b9f anchoring discipline holds: both
 * markers are ^-pinned to result position 0, so a file QUOTING the envelope
 * text is never failure-shaped.
 *
 * These tests pin: the incident envelope (and its knowledge-document sibling)
 * is failure-shaped; anchoring/benign-shape controls; the END-TO-END replay —
 * three update_document placeholder calls with VARYING ids trip the derail
 * breaker with exactly the incident's refusal texts (newest first) while every
 * call executes harmlessly; an interleaved DIFFERENT-tool call switches the
 * per-tool streak (agent.ts:3173 — the reset control below); the first trip
 * withholds ONE round (not perma). Scaffold mirrors
 * agent-derail-break.aff1c189.test.ts (same mock set) + a ToolCache stub for
 * the document-tool seam (agent.ts:736-738 WEB_TOOL_NAMES dispatch).
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

// The document-tool seam: update_document dispatches via ctx.toolCache
// (WEB_TOOL_NAMES), not executeCodingTool. Keep the REAL TOOL_DEFINITIONS
// (the offered-tool list is built from it); stub only the executor instance.
const mockToolCacheExec: jest.Mock = jest.fn(async (name: string, args: any) => {
  if (name === 'update_document' || name === 'read_document' || name === 'fill_pdf_form') {
    const id = String(args?.fileId ?? args?.documentId ?? '');
    return `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
  }
  return 'probe result: ok';
});
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

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// The incident's placeholder ids — VARYING (the identical-call repeat
// breaker's evasion vector). The brief names them verbatim so the grounding
// preflight passes (the 00667344 echo: the incident model narrated the tokens
// first, so its calls EXECUTED into the harmless refusal).
const IDS = ['placeholder101', 'placeholder102', 'placeholder103', 'placeholder104'];
const BRIEF = [
  '[Coordinator watch — fold the reconciled filings]',
  `The four digest placeholders ${IDS.join(' ')} are on record from prior`,
  'ticks; refresh each with the reconciled census figures, then report.',
  'Every claim cites a this-run receipt.',
].join('\n');

const ENVELOPE = (id: string) =>
  `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-718a04a5-test',
  sessionId: 'sess-718a04a5',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `${BRIEF}\nRefresh the digests now.`,
  emit: jest.fn(),
});

/** A turn calling update_document on a placeholder id — the reasoning NAMES
 *  the called tool so the intent-mismatch fast-trip stays out of the replay
 *  (the incident lane narrated its calls faithfully; the mismatch was the
 *  emitted tool itself, not the narration). */
const placeholderTurn = (n: number, id: string) => ({
  content: '',
  reasoning: `Calling update_document now: refreshing digest file ${id} with the reconciled census figures.`,
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: id, content: 'reconciled digest' }) }],
  finishReason: 'tool_calls',
});
/** The interleaved "other tool" turn for the reset control. NOTE (reviewer
 *  173f6b6e, 2026-09-20): read_file is NOT in CHAT_ORCH_TOOLS
 *  (agent.ts:146-152), so in this chat-profile replay the call never executes
 *  — it dies at preflight with the tool_not_offered JSON envelope
 *  (agent.ts:2958), which is itself FAILURE-shaped ('{ "ok": false' —
 *  learnings-index.service.ts:364). What the control therefore pins is the
 *  agent.ts:3173 STREAK SWITCH (a different tool's failure restarts the
 *  streak at count 1 on that tool), NOT the same-tool success reset
 *  (agent.ts:3198-3199). */
const successTurn = (n: number) => ({
  content: '',
  reasoning: 'Reading the design doc before the next fold.',
  toolCalls: [{ id: `t${n}`, name: 'read_file', arguments: JSON.stringify({ path: 'AGENTS.md' }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Digests refreshed.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 718a04a5 — document-tool existence refusals are failure-shaped (the placeholder loop now trips the derail breaker)', () => {
  it('UNIT: the incident envelope + knowledge-document sibling count; anchoring and benign-shape controls hold', () => {
    expect(looksLikeToolFailure(ENVELOPE('placeholder042'))).toBe(true);
    expect(looksLikeToolFailure(
      'No knowledge document with id placeholder042 belongs to this user. Call list_files to see the current documents.',
    )).toBe(true);
    // 7c1e5b9f anchoring: a result merely QUOTING the envelope is not a failure.
    expect(looksLikeToolFailure(
      '[File: digest.md — md, 240 bytes | text: 240 chars, sha256: abc]\nthe guard answered "No generated file with id zz belongs to this user." twice',
    )).toBe(false);
    // The always-benign confirmation staging stays exempt (1ab1a52b).
    expect(looksLikeToolFailure('{ "ok": false, "needsConfirmation": true, "confirmationId": "c1" }')).toBe(false);
    expect(looksLikeToolFailure('probe result: ok')).toBe(false);
    // The pre-existing markers are untouched.
    expect(looksLikeToolFailure("Tool edit_file failed: ENOENT: no such file or directory, open '/wt/x'")).toBe(true);
  });

  it('REPLAY e2e: three update_document placeholder calls with VARYING ids trip the derail breaker — exact incident envelopes, newest first', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(placeholderTurn(1, IDS[0]))
      .mockResolvedValueOnce(placeholderTurn(2, IDS[1]))
      .mockResolvedValueOnce(placeholderTurn(3, IDS[2]))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // Every call EXECUTED into the document seam (harmless refusal): the
    // identical-signature repeat breaker never fired (ids vary) — the derail
    // failure-streak is what catches the loop now.
    expect(mockToolCacheExec).toHaveBeenCalledTimes(3);
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_document');
    expect(ev.recentFailures).toEqual([ENVELOPE(IDS[2]), ENVELOPE(IDS[1]), ENVELOPE(IDS[0])]);
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
  });

  it('streak-switch control: an interleaved different-tool call (not-offered read_file dies at preflight, failure-shaped) restarts the per-tool streak — a 1–1–2 pattern never trips', async () => {
    // Reviewer precision note (173f6b6e): this control is NON-discriminating
    // for the fix — it passes at the parent commit too (there the placeholder
    // envelopes are not failure-shaped at all, so no streak accumulates).
    // The fix's discriminators are the UNIT + REPLAY e2e tests above.
    mockRunModelTurn
      .mockResolvedValueOnce(placeholderTurn(1, IDS[0]))
      .mockResolvedValueOnce(successTurn(2))
      .mockResolvedValueOnce(placeholderTurn(3, IDS[1]))
      .mockResolvedValueOnce(placeholderTurn(4, IDS[2]))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockToolCacheExec).toHaveBeenCalledTimes(3);
    // The interleaved read_file never executed — preflight refusal.
    expect(mockExecuteCodingTool).not.toHaveBeenCalled();
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(0);
  });

  it('first trip = one-round withhold, NOT perma: the next placeholder call dies toolNotOffered; the round after EXECUTES', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(placeholderTurn(1, IDS[0]))
      .mockResolvedValueOnce(placeholderTurn(2, IDS[1]))
      .mockResolvedValueOnce(placeholderTurn(3, IDS[2])) // TRIP
      .mockResolvedValueOnce(placeholderTurn(4, IDS[3])) // withheld round — never reaches the tool
      .mockResolvedValueOnce(placeholderTurn(5, IDS[3])) // back on offer — executes
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    // 3 streak calls + 1 recovery call executed; the withheld round did not.
    expect(mockToolCacheExec).toHaveBeenCalledTimes(4);
  });
});

// ── Post-fix incidents cbc5be24 + 83297404 (both 2026-09-20, ~12 min AFTER the
// 27e3a5fd deploy at 06:41:35Z): the SAME refusal class as 718a04a5, caught by
// the new FAILURE_MARKERS entries within seconds of each run ending — the fix
// verified live in production (both auto-files are breaker trips; pre-fix, the
// 718a04a5 loop burned ~213 steps undetected). Verdicts: MODEL behavior
// (kimi-k3 placeholder emission); the framework side is the fix above. These
// cases pin each incident's exact filed arithmetic shape:
//   · cbc5be24 — this lane's OWN run aad8ff7d (first-hand; ticket "reasoning
//     named get_feedback"): THREE identical 'placeholder-recheck' envelopes ⇒
//     base weight 1/call, the intent-mismatch fast-weight landing on call 3
//     (an earlier landing would weight 2/call and trip with TWO texts).
//   · 83297404 — bench lane 619a1241 run cfcb9ee0 ("reasoning named
//     observe_resource"): TWO identical '__none__' envelopes ⇒ weight 2/call
//     (failure + intent on both calls) ⇒ trip at call 2. ──
describe('tickets cbc5be24 + 83297404 — post-fix placeholder-refusal incidents trip with their filed arithmetic', () => {
  it('cbc5be24 replay: 3 IDENTICAL update_document("placeholder-recheck") calls trip the streak at call 3 — exact filed envelopes newest-first', async () => {
    const ID = 'placeholder-recheck';
    mockRunModelTurn
      .mockResolvedValueOnce(placeholderTurn(1, ID))
      .mockResolvedValueOnce(placeholderTurn(2, ID))
      .mockResolvedValueOnce({
        ...placeholderTurn(3, ID),
        reasoning: 'Re-check the ticket row with get_feedback before any further mutation attempt.',
      })
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockToolCacheExec).toHaveBeenCalledTimes(3); // all three EXECUTED into the harmless refusal
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_document');
    expect(ev.recentFailures).toEqual([ENVELOPE(ID), ENVELOPE(ID), ENVELOPE(ID)]);
  });

  it('83297404 replay: 2 update_document("__none__") calls carrying observe_resource intent trip the streak at call 2 — the filed 2-text shape', async () => {
    const ID = '__none__';
    const intentTurn = (n: number) => ({
      ...placeholderTurn(n, ID),
      // Names observe_resource (offered via PLATFORM_TOOL_NAMES), never the
      // called tool; the id stays verbatim in the narration so the grounding
      // preflight passes (00667344 echo) and the call EXECUTES into the
      // refusal — weight 1 (failure) + 1 (intent mismatch) = 2 per call.
      reasoning: `Stamp observe_resource 719e0a51 to reset the unobserved clock; keep the ${ID} digest placeholder untouched.`,
    });
    mockRunModelTurn
      .mockResolvedValueOnce(intentTurn(1))
      .mockResolvedValueOnce(intentTurn(2))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockToolCacheExec).toHaveBeenCalledTimes(2);
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_document');
    expect(ev.recentFailures).toEqual([ENVELOPE(ID), ENVELOPE(ID)]);
  });
});

// ── Post-fix incident bda7f125 (mishap, filed 2026-09-20T08:41:47Z — the third
// post-27e3a5fd occurrence): CanLaw eval-tracking lane
// 596102ca-53de-4f90-a6c1-6e3003a7df95, run f560a537 (kimi-k3, firing 220/500 —
// a READ-ONLY tracking-tick job whose work is get_chat_messages/todo_get probes;
// zero legitimate document writes). The lane's reasoning named get_chat_messages
// (ticket) / update_plan (harness derail note 856f46d8: "intended tool appears
// to be update_plan") but EMITTED update_document twice with model-authored ids
// 'noop' then 'noop2'. Filed as a 3× streak with TWO envelopes (newest first) ⇒
// weight 2/call (failure + intent mismatch on both calls) ⇒ trip at call 2 —
// the 83297404 arithmetic — and the per-TOOL streak (agent.ts:3173) accumulates
// across the id variation (unlike the identical-call repeat breaker, which the
// variation evades by design). Verdict (adjudication 2026-09-20, lane b92ef13f):
// MODEL behavior — the deterministic refusal + repair affordance, the
// failure-shaped marker (learnings-index.service.ts:384), the 2-episode breaker
// trip and the doctrine auto-file all behaved as designed. ──
describe('ticket bda7f125 — third post-fix occurrence: varying noop ids trip at call 2 (per-tool streak across id variation)', () => {
  it('bda7f125 replay: update_document("noop") then update_document("noop2") carrying update_plan intent — exact filed envelopes newest-first', async () => {
    const intentTurn = (n: number, id: string) => ({
      ...placeholderTurn(n, id),
      // Names get_chat_messages (the incident's narrated intent per the
      // ticket; offered via PLATFORM_TOOL_NAMES:15), never the called tool;
      // the id stays verbatim in the narration so the grounding preflight
      // passes (00667344 echo) and the call EXECUTES into the refusal —
      // weight 1 (failure) + 1 (intent mismatch) = 2 per call.
      reasoning: `Pull the coordinator lane tail with get_chat_messages, keeping the ${id} digest placeholder untouched.`,
    });
    mockRunModelTurn
      .mockResolvedValueOnce(intentTurn(1, 'noop'))
      .mockResolvedValueOnce(intentTurn(2, 'noop2'))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockToolCacheExec).toHaveBeenCalledTimes(2);
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_document');
    expect(ev.recentFailures).toEqual([ENVELOPE('noop2'), ENVELOPE('noop')]);
  });
});

// ── Post-fix occurrence ledger (2026-09-20, adjudicated by lane b92ef13f with
// fresh get_feedback/get_chat_status reads — SAME class + arithmetic as the
// bda7f125 case pinned above, so the executable pins carry the mechanism;
// these entries are the mishap-close citations):
//   TIMING THAT MATTERS: all three are ALSO the first POST-8f4c4464
//   occurrences — deploy 35501798401 concluded 09:58:48Z with every box
//   fix-inclusive by ~10:43Z (431518a2's telemetry pull), so the trips at
//   10:44:46Z (f218735b) and 10:48:31Z (e36dff44 / 4f3ecab9) are the SAME two
//   lane-kills open regression ticket 431518a2 records. The placeholder-id
//   subclass recurs post-fix alongside the wrong-tool subclass — the
//   consolidated verdict + early-steer re-arm live in the
//   agent-derail-break.0aecbe92.test.ts ledger (d18241b3).
//   · f218735b (mishap, auto-filed 2026-09-20T10:44:46Z at breaker trip):
//     CanLaw coordinator lane e083ff2e — the SAME lane as the 718a04a5
//     incident itself (kimi-k3 seat confirmed via get_chat_status this date),
//     run ad58d5ef. Reasoning named run_command; EMITTED update_document with
//     the model-authored id 'noop' — identical existence-refusal envelope
//     twice (newest first) ⇒ weight 2/call (failure + intent mismatch) ⇒ trip
//     at call 2 (the 83297404 arithmetic). MODEL verdict: the refusal
//     (tool-executor.ts:780) is failure-shaped (learnings-index.service.ts:384)
//     and the 2-episode breaker contained the streak; zero state touched.
//   · e36dff44 (mishap, auto-filed 2026-09-20T10:46:56Z): lane cec340f2
//     "Re-Send Path C Phase 2 Kickoff" (kimi-k3 seat confirmed), run 75d8e448.
//     Reasoning named observe_resource; EMITTED update_feedback with id
//     'nonexistent' → ungrounded_id preflight refusal (agent.ts:2985 —
//     refused PRE-execution, zero mutations) and id 'none' → ticket_not_found.
//     Weight 2/emission on the preflight refusals (the 0c0ce759 arithmetic) ⇒
//     trip at call 2. MODEL verdict: both framework refusals behaved as
//     designed.
//   · 4f3ecab9 (mishap, auto-filed 2026-09-20T10:48:31Z): same lane/run as
//     e36dff44. Reasoning named search_memory; EMITTED update_document with
//     the model-authored id 'none' — identical envelope twice ⇒ trip at call
//     2, same arithmetic as f218735b. MODEL verdict; zero state touched.
//   · 431518a2 (mishap P3, filed 2026-09-20T10:52:47Z by fleet supervisor
//     c0e22e36) — CLOSE-OUT, adjudicated 2026-09-20T11:29Z by dispatched lane
//     508c20b5. The regression-signal wrapper for the two kills above
//     (f218735b = e083ff2e; e36dff44 + 4f3ecab9 = cec340f2 run 75d8e448).
//     Independently re-verified from primary sources (nothing taken from the
//     filing on faith): kill notes read verbatim from both transcripts (msg
//     270f3905 — "3 episodes; intended tool appears to be run_command"; msg
//     369e5dc8 — "3 episodes; intended tool appears to be search_memory");
//     post-rollout classification re-derived (run starts ~10:41Z/~10:45Z vs
//     deploy 35501798401 concluded 09:58:48Z; every box fix-inclusive per
//     get_fleet_telemetry view 'deploy' @11:23Z); probe-vs-derail negative
//     (ea69c94e discipline — both lanes mid real work, not negative guard
//     probes); these replay pins re-run green (jest 2 suites 10/10 vs main
//     740fe8166). VERDICT CONFIRMED: MODEL behavior — the conformance fix
//     scoped to the placeholder/truncation subclass; the wrong-tool
//     substitution subclass is the distinct model-side failure it never
//     claimed to address, and the 3-episode breaker contained both kills
//     exactly as designed. RECOVERY OBSERVED: cec340f2 firing 58 (msg
//     6c02c59f @11:24:10Z) ran clean — the terminal-kill + fresh-firing
//     bound held; no further kill notes in either transcript since
//     10:48:31Z. RECOMMENDATION DISPOSITION (auto-inject re-anchor): the
//     0aecbe92 replay + 10cb988f 06:49Z steer-run evidence shows an in-run
//     corrective re-prompt does NOT recover the seat (derailed identically
//     ~67s later); the terminal kill IS the bound. The fix side is dispatched
//     separately — lane 4d29fe70 ("Platform Auto-Inject Re-Anchor
//     Implementation", supervisor steer 2026-09-20T11:37Z) implements the
//     re-anchor and owns this ticket's evidence-close; this entry is the
//     adjudication verdict of record. STARTS-vs-ENDS (the steer's open
//     question): both runs STARTED post-rollout (e083ff2e 10:41:08Z, cec340f2
//     10:45:51Z — assistant-row createdAt — vs the ~10:01Z worst-case box-roll
//     window), so BOTH kills are post-fix occurrences, not carry-over
//     baseline; the regression-signal classification holds.
//   · c5ad2e56 (mishap, auto-filed 2026-09-20T11:49:15Z at breaker trip) —
//     adjudicated 2026-09-20T11:52Z by dispatched lane b92ef13f. Lane
//     28de72e5 "GLM-5.3 Deployment on Dual Sparks" (kimi-k3 seat confirmed
//     via get_chat_status), run 1045854c: a POST-GO-word wake (peer GO word
//     msg 410bf020 @11:43:00Z) arming real schedule commitments (END-word
//     watch, backstops, CASE C bookend). Reasoning named list_chats;
//     EMITTED update_schedule with the model-authored ids
//     'placeholder-abort', 'placeholder-abort2', 'abort-final' — three
//     ungrounded_id preflight refusals (agent.ts:2985 — refused
//     PRE-execution, zero mutations, each carrying the repair affordance
//     "call list_chats now") ⇒ trip at call 3 (terminal note msg 93f1dc57
//     @11:45:41Z: "3 episodes; intended tool appears to be list_chats").
//     FIRST occurrence on the schedule-mutation family — the 4th tool
//     family for the class after update_document / update_feedback /
//     todo_update. Boundary: run start ≥11:43Z is POST every shipped guard
//     (8f4c4464 rollout 09:58:48Z) — a post-fix occurrence, not carry-over.
//     Probe-vs-derail negative (ea69c94e discipline): the lane was arming
//     genuine watches, not running lifecycle negative probes. RECOVERY
//     OBSERVED: continuation run r1/6 (msg 6658e8c5 @11:50:02Z) resumed
//     cleanly with fresh reads (msg 8db35e74 @11:53:02Z) — the
//     terminal-kill + fresh-firing bound held. MODEL verdict: preflight
//     refusals, repair affordance, breaker trip, and auto-ticket all fired
//     deterministically as designed; the re-anchor implementation rides
//     with lane 4d29fe70 (see the 431518a2 entry above).

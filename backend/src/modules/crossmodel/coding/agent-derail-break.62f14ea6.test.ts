/**
 * REPLAY PIN — ticket 62f14ea6 (general_feedback sighting, 2026-10-15) on the
 * auto-filed mishap 596718e7: "3× tool-failure streak: todo_update on
 * 'DNS cutover llm.cql.ca → · Phase 3 remai' — framework or model?"
 * Auto-filed at breaker trip (owner doctrine 2026-09-10: self-heal +
 * attribute, never just escalate).
 *
 * THE INCIDENT (session 26be18cc-2b9c-489c-98bb-eb727dbb9252 — the rutherford-2
 * litellm rebuild lane, run 4dbde611-6ffb-4ceb-92e1-29321d09a6ee, machine wake,
 * 21:51Z): the run's receipts show THREE consecutive ok:false todo_update rows —
 * aa12af7d 21:51:20.568Z, 0f0969c1 21:51:33.431Z, ba4caf3e 21:51:35.001Z — yet
 * the auto-filed evidence carries exactly TWO failure texts (newest first):
 *   1. `Tool todo_update failed: blockedReason can only be set on a blocked todo
 *      (current status: 'in_progress'). Pass status:'blocked' to block it first.`
 *   2. `Tool todo_update failed: Todo cannot be marked done: waiting on 1
 *      todo(s) not done: "Verify cutover: …" (blocked). Pass force: true to
 *      override.`
 * with the paired args `{"blockedReason":"Client list is owner/fleet-side…` and
 * `{"evidence":"Fresh-host verification this run (SSH deploy@69.19.140.37)…`.
 *
 * ADJUDICATION (against primary sources, 2026-10-16, ticket lane 62f14ea6):
 * MODEL BEHAVIOR — no deterministic framework defect. Every leg verified:
 *   · Refusal 1 is goals.service.ts' documented standalone blockedReason guard
 *     (:2824-2832): a blockedReason with NO status transition on a todo whose
 *     current status is 'in_progress' 400s with exactly the filed text (the
 *     silent-no-op fix's own comment — "never silently drop an accepted
 *     parameter" — names this refusal as designed). The remedy in the text is
 *     truthful: pass status:'blocked' and it lands (pinned in
 *     goals.service.62f14ea6.test.ts).
 *   · Refusal 2 is the done-gate (:2762-2769): a done attempt on todo
 *     06c26d0f (the drop-in sweep — its args carry that todo's closing
 *     evidence) while its REAL dependency 10023020 ("Verify cutover…") was
 *     still blocked. The gate named the dependency's title + status verbatim
 *     and offered force:true — correct against the args given. Live todo_get
 *     reads (this lane, 2026-10-16): 06c26d0f dependsOn [10023020]; 10023020
 *     was done only at 22:14:22Z, 06c26d0f closed 22:24:01Z — the gate told
 *     the truth at 21:51.
 *   · The counting is the designed weighted arithmetic, not a miscount: the
 *     mishap title renders "; lane's reasoning named finish_run" — the lane's
 *     close-out narration named finish_run while emitting todo_update, so the
 *     intent-mismatch fast-trip (+1, agent.ts:5533-5536 — same weight class as
 *     ea69c94e's ungrounded +1) was in play. Whether that +1 rode BOTH counted
 *     refusals (count 2, then 4 at the trip check) or only the second (count
 *     1, then 3) is NOT receipt-provable — get_run_receipts rows carry only
 *     {id, tool, ok, ids, at}, and the run's per-turn reasoning lives in the
 *     run's internal steps, not the chat transcript. Either distribution is
 *     the SAME observable: the trip fires at the SECOND counted refusal with
 *     exactly TWO filed texts (bar >= 3). The sibling pin (596718e7,
 *     910a57ce1) narrates the minimal path; this pin's fixture carries the +1
 *     on both calls. The pins agree on everything observable and differ only
 *     on the unprovable per-call split — noted here so no one reads either
 *     narration as the incident's exact arithmetic.
 *   · The THIRD receipt (ba4caf3e, 1.570s after 0f0969c1) was an EXECUTED
 *     refusal in the SAME batch, not a withheld-round pre-flight refusal
 *     (adversarial-review finding, 2026-10-16): the withhold filters the NEXT
 *     round's offer list (offeredNames is round-scoped, agent.ts:3523), so a
 *     same-batch sibling after the trip still executes; and the deferred
 *     notice fires at BATCH end, so a next-round reading would have filed
 *     BEFORE the third receipt — the observed filing is 506ms AFTER it. The
 *     1.57s gap matches run 4dbde611's intra-batch spacing (0.03-1.5s) while
 *     every inter-turn gap in the run is >= 5.3s. That third refusal opened
 *     a FRESH streak (count 1+1=2), which is why no second filing exists —
 *     the shape pinned by the same-batch test below.
 *   · Self-heal is receipt-proven: f7e8c9c0 + 5bd284cf ok at 21:54:14Z — the
 *     lane kept todo_update after the one-round withhold, closed its rows
 *     (fe467ced done with evidence 22:03Z, 10023020 22:14Z, 06c26d0f 22:24Z),
 *     and the run completed 21:59:24Z. The breaker's design cost (a phantom
 *     ticket for a recoverable stumble) is the accepted price of the self-heal
 *     doctrine — ea69c94e's precedent, not a defect.
 * One micro-detail stays open and immaterial: fe467ced.startedAt reads
 * 21:51:20.594Z (26ms after receipt aa12af7d) with no ok todo_update receipt
 * at that instant — most likely a same-batch in_progress transition whose
 * async receipt row is not in the returned list. It changes nothing: all three
 * refusals are correct guard behavior regardless of which row they targeted.
 *
 * A shape exemption is WRONG here (1ab1a52b contrast): executed guard
 * refusals are the breaker's primary derailment signal — intent is invisible
 * to the shape layer. The guards' semantics are pinned in
 * goals.service.62f14ea6.test.ts (this file pins the loop arithmetic).
 *
 * Scaffold mirrors agent-derail-break.0625bf62.test.ts (coding profile —
 * finish_run is offered to top-level machine coding runs, finish-run.ts
 * finishRunEligible) with ea69c94e's reflection-mock discipline.
 */

jest.setTimeout(60_000);

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
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

// The two counted refusals come back through the REAL executor seam — both
// filed texts are the executeCodingTool catch-all envelope ("Tool <name>
// failed: <AppError.message>"), so they are failure-shaped by marker #1.
const mockExecuteCodingTool: jest.Mock = jest.fn();
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// run-receipts: getRecentChatReceipts rides the machine finalize (finish-run
// record) — undefined export ⇒ the agent's typeof guard degrades to [].
jest.mock('./run-receipts.service', () => ({ __esModule: true, recordRunReceiptAsync: jest.fn() }));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss', TOOL_BATCH_CAP: 'tool_batch_cap' },
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
import { detectIntendedToolChannels } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

/** CODING profile — the incident lane was a coding session; finish_run is
 *  offered only to top-level MACHINE coding runs (finish-run.ts), so the
 *  intent-mismatch conviction has a real offered name to convict on. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim ids (ticket 62f14ea6 / mishap 596718e7 + live
//    todo_get reads of goal ef33afb6, 2026-10-16) ─────────────────────────────
const SWEEP_TODO = '06c26d0f-a77f-41dc-adcb-c3268309a2db';   // dependsOn 10023020 (blocked at 21:51Z)
const DNS_TODO = 'fe467ced-572a-49db-aff8-02dac35030c6';     // the in_progress row (startedAt 21:51:20.594Z)
const VERIFY_TITLE =
  'Verify cutover: /v1/models roster vs 50, census script, StAnne legs (mbp-2 utility 100.64.0.1:8095, asr, ' +
  'accelerator image 100.64.0.1), self-hosted tailnet legs (node-a 100.64.0.1:8091, node-b 100.64.0.1:8000, GLM ' +
  'heads), E2E completion through https://llm.cql.ca';

// ── The incident's verbatim failure texts (mishap 596718e7 body, newest
//    first) — the executeCodingTool catch-all envelopes the lane actually saw.
const BLOCKED_REASON_REFUSAL =
  `Tool todo_update failed: blockedReason can only be set on a blocked todo (current status: 'in_progress'). ` +
  `Pass status:'blocked' to block it first.`;
const DONE_GATE_REFUSAL =
  `Tool todo_update failed: Todo cannot be marked done: waiting on 1 todo(s) not done: ` +
  `"${VERIFY_TITLE}" (blocked). Pass force: true to override.`;

// ── The incident's verbatim args (clipped to the filed 200 chars, key order
//    preserved — blockedReason first / evidence first).
const BLOCKED_REASON_ARGS = JSON.stringify({
  blockedReason:
    'Client list is owner/fleet-side: per the 2026-10-11 incident brief (docs/SECURITY-INCIDENT_2026-10-11.md §5) ' +
    'every caller requests a virtual key through the owner/gateway lane. Mecha…',
  todoId: DNS_TODO,
});
const DONE_EVIDENCE_ARGS = JSON.stringify({
  evidence:
    'Fresh-host verification this run (SSH deploy@69.19.140.37): /etc/gateway-health-monitor.env does not exist; ' +
    'no KNOWN_DOWN overrides in any systemd drop-in (grep across /etc/systemd/system…',
  status: 'done',
  todoId: SWEEP_TODO,
});

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-62f14ea6-test',
  sessionId: 'sess-62f14ea6',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: [
    'RUNBOOK PHASE 3 — the deploy row is done on rutherford-2 (69.19.140.37).',
    `Close out the remaining rows for the fleet: the drop-in sweep ${SWEEP_TODO} and the DNS cutover ${DNS_TODO}.`,
    'Record why anything that cannot close yet is held, then wrap the wake.',
  ].join('\n'),
  emit: jest.fn(),
  machineTriggered: true, // the incident was a machine wake — finish_run is offered
});

/** The lane's close-out narration: the FINAL SENTENCE names finish_run (the
 *  wrap-up it was heading for) while the emitted call is todo_update, and the
 *  narration never names todo_update itself (no literal, no "todo … update"
 *  prose sequence) — the exact shape that fired the intent-mismatch +1. */
const CLOSEOUT_REASONING =
  'The gateway legs are lit and the drop-in sweep is clean on the fresh host, so that row can close with the ' +
  'recorded evidence, and the held row carries the owner-side blocker note instead. ' +
  'Once the board rows land, finish_run will close this wake with the fleet claims manifest.';

const refusedTurn = (n: number, args: string) => ({
  content: '',
  reasoning: CLOSEOUT_REASONING,
  toolCalls: [{ id: `t${n}`, name: 'todo_update', arguments: args }],
  finishReason: 'tool_calls' as const,
});
/** The recovery call (receipts f7e8c9c0 + 5bd284cf, 21:54:14Z): the lane kept
 *  its tool after the one-round withhold and moved the DNS row to in_progress. */
const recoveryTurn = {
  content: '',
  reasoning: 'The blocker note needs the row active first, so move the DNS cutover row to in_progress now.',
  toolCalls: [{ id: 't9', name: 'todo_update', arguments: JSON.stringify({ todoId: DNS_TODO, status: 'in_progress' }) }],
  finishReason: 'tool_calls' as const,
};
const FINAL = { content: 'Phase 3 wrapped; the board is clean.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay 62f14ea6 — two correct guard refusals under finish_run-naming narration read as a "3× todo_update streak"', () => {
  it('both filed texts are failure-shaped (the catch-all marker) — the breaker counted real executed refusals', () => {
    expect(looksLikeToolFailure(BLOCKED_REASON_REFUSAL)).toBe(true);
    expect(looksLikeToolFailure(DONE_GATE_REFUSAL)).toBe(true);
  });

  it('the incident narration convicts todo_update of intending finish_run (the +1 weight the mishap title renders)', () => {
    expect(detectIntendedToolChannels(CLOSEOUT_REASONING, '', 'todo_update', ['todo_update', 'finish_run', 'read_file', 'run_command']))
      .toBe('finish_run');
    // and the acquittal legs stay honest: naming the called tool acquits
    expect(detectIntendedToolChannels(
      'Now todo_update the DNS row with the blocker note. Then finish_run wraps the wake.',
      '', 'todo_update', ['todo_update', 'finish_run'],
    )).toBe(null);
  });

  it('END-TO-END: two executed refusals (intent +1 in play) trip at the SECOND refusal with EXACTLY the two filed texts and args, intended=finish_run', async () => {
    // Receipt aa12af7d (21:51:20.568Z): the done attempt on the sweep row —
    // done-gate refusal (its dependency was genuinely blocked).
    // Receipt 0f0969c1 (21:51:33.431Z): the standalone blockedReason refresh
    // on the in_progress DNS row — guard refusal.
    // This fixture carries the +1 on BOTH calls (count 2, then 4 at the trip
    // check — the header notes the minimal 1→3 path is equally consistent
    // with every observable; the trip point and filed texts are identical).
    mockExecuteCodingTool
      .mockResolvedValueOnce(DONE_GATE_REFUSAL)
      .mockResolvedValueOnce(BLOCKED_REASON_REFUSAL);
    mockRunModelTurn
      .mockResolvedValueOnce(refusedTurn(1, DONE_EVIDENCE_ARGS))   // executes → count 1 + intent 1 = 2
      .mockResolvedValueOnce(refusedTurn(2, BLOCKED_REASON_ARGS))  // executes → count 4 ≥ 3 → TRIP (2 texts filed)
      .mockResolvedValueOnce(refusedTurn(3, BLOCKED_REASON_ARGS))  // NEXT round: withheld → pre-flight refusal, never executes
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // The two counted refusals EXECUTED; the post-trip NEXT-ROUND call never reached the tool.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);

    // ONE auto-filed investigation, carrying the incident's exact shape.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('todo_update');
    expect(ev.intended).toBe('finish_run'); // the filed "; lane's reasoning named finish_run"
    expect(ev.recentFailures).toHaveLength(2); // TWO texts under a "3×" title — the weighted count
    expect(ev.recentFailures[0]).toBe(BLOCKED_REASON_REFUSAL); // newest first, verbatim
    expect(ev.recentFailures[1]).toBe(DONE_GATE_REFUSAL);
    expect(ev.recentArgs).toHaveLength(2);
    expect(ev.recentArgs[0].startsWith('{"blockedReason"')).toBe(true); // the filed arg clips' key order
    expect(ev.recentArgs[1].startsWith('{"evidence"')).toBe(true);
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
  });

  it('SAME-BATCH shape (the incident\'s third receipt ba4caf3e): a sibling call AFTER the trip in the SAME batch still EXECUTES (the withhold filters the NEXT round\'s offer list) and never re-files', async () => {
    // One turn, THREE todo_update calls: the first two tripped (count 4 at the
    // trip check), the third executes anyway — offeredNames is round-scoped
    // (agent.ts:3523), so the batch's own dispatch is unaffected. The third
    // refusal opens a FRESH streak (count 1 + intent 1 = 2), which is why the
    // incident shows THREE ok:false receipts (aa12af7d, 0f0969c1, ba4caf3e
    // 1.570s later — intra-batch spacing) but only ONE filing with TWO texts:
    // the deferred notice fires at BATCH end, 506ms after the third receipt.
    mockExecuteCodingTool.mockResolvedValue(DONE_GATE_REFUSAL);
    mockRunModelTurn
      .mockResolvedValueOnce({
        content: '',
        reasoning: CLOSEOUT_REASONING,
        toolCalls: [
          { id: 't1', name: 'todo_update', arguments: DONE_EVIDENCE_ARGS },
          { id: 't2', name: 'todo_update', arguments: BLOCKED_REASON_ARGS },
          { id: 't3', name: 'todo_update', arguments: DONE_EVIDENCE_ARGS },
        ],
        finishReason: 'tool_calls' as const,
      })
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // ALL THREE calls executed — the trip's one-round withhold cannot reach
    // back into its own batch.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(3);
    // ONE filing with exactly the two texts captured at counting time (the
    // third refusal's text never joins the filed evidence — fresh streak).
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.recentFailures).toHaveLength(2);
    expect(ev.recentFailures[0]).toBe(DONE_GATE_REFUSAL);
    expect(ev.recentFailures[1]).toBe(DONE_GATE_REFUSAL);
  });

  it('first trip = one-round withhold, NOT perma: the post-trip call is refused pre-flight and the NEXT round recovers (receipts f7e8c9c0 + 5bd284cf)', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce(DONE_GATE_REFUSAL)
      .mockResolvedValueOnce(BLOCKED_REASON_REFUSAL)
      .mockResolvedValue('{"ok":true,"status":"in_progress"}');
    mockRunModelTurn
      .mockResolvedValueOnce(refusedTurn(1, DONE_EVIDENCE_ARGS))   // executes → refusal (count 2)
      .mockResolvedValueOnce(refusedTurn(2, BLOCKED_REASON_ARGS))  // executes → refusal → TRIP, withheld one round
      .mockResolvedValueOnce(refusedTurn(3, BLOCKED_REASON_ARGS))  // withheld: pre-flight refusal, never executes
      .mockResolvedValueOnce(recoveryTurn)                         // back on offer → EXECUTES (the 21:54 recovery)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1); // no second filing — the fresh streak never reached 3
    // THREE executions: the two counted refusals + the post-withhold recovery.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(3);
  });

  it('wiring seam: todo_update stays a preflight-covered platform tool and finish_run stays offered to machine coding runs (a regression here silently re-arms the incident)', async () => {
    expect(PLATFORM_TOOL_NAMES).toContain('todo_update');
    mockExecuteCodingTool.mockResolvedValue('{"ok":true}');
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    const offered = mockRunModelTurn.mock.calls[0][2] as any[];
    expect(Array.isArray(offered)).toBe(true);
    expect(offered.some((t: any) => t?.function?.name === 'finish_run')).toBe(true);
  });
});

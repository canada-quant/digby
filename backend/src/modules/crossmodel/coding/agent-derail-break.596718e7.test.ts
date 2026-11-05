/**
 * REPLAY PIN — ticket 596718e7 (mishap, 2026-10-15T21:51:35.507Z): "3×
 * tool-failure streak: todo_update on 'DNS cutover llm.cql.ca → · Phase 3
 * remai' — framework or model?" Auto-filed at the breaker trip (owner
 * doctrine 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE INCIDENT (session 26be18cc-2b9c-489c-98bb-eb727dbb9252, run
 * 4dbde611-6ffb-4ceb-92e1-29321d09a6ee — the LiteLLM rutherford-2 rebuild
 * lane, glm-5.3, coding profile, MACHINE-triggered; receipts, this
 * adjudication): 21:50:42 two ok todo_updates (827f3451/df6644db), then
 * THREE consecutive ok:false todo_update receipts —
 *   · aa12af7d 21:51:20.568 — done+evidence attempt → 409 done-gate:
 *     "Todo cannot be marked done: waiting on 1 todo(s) not done:
 *     'Verify cutover: …' (blocked). Pass force: true to override."
 *   · 0f0969c1 21:51:33.431 — blockedReason WITHOUT status → 400 apply-or-reject:
 *     "blockedReason can only be set on a blocked todo (current status:
 *     'in_progress'). Pass status:'blocked' to block it first."
 *   · ba4caf3e 21:51:35.001 — same 400 shape again (1.6 s later — a
 *     same-batch sibling of the previous call).
 * The ticket filed at 21:51:35.507Z — at the THIRD receipt — carrying exactly
 * TWO failure texts (newest first) and "lane's reasoning named finish_run".
 *
 * THE TRIP ARITHMETIC (why "3×" with two texts): the streak counter is
 * WEIGHTED — each failure-shaped result +1, plus the intent-mismatch
 * fast-trip +1 when the call's own reasoning names a different OFFERED tool
 * (agent.ts failStreakCount block). The filed `intended: finish_run` says
 * the convicted call's reasoning named finish_run (offered to machine-
 * triggered coding runs since build 2026-10-08 F-1) while the lane emitted
 * todo_update. Call 1 (409, aligned narration) = 1; call 2 (400 +
 * finish_run-naming reasoning) = 2 + 1 = 3 → TRIP at the SECOND failure,
 * snapshotting exactly the two real texts [400, 409] newest-first. Call 3
 * (same batch — the withhold applies to the NEXT round's schema, never the
 * in-flight batch) starts a fresh streak at 2 (failure + intent) and never
 * trips. The "3×" in the title is the weighted count, not three filed
 * texts — the same arithmetic class as ea69c94e/1867d6d5.
 *
 * THE RECOVERY (the containment WORKED — receipts): the next todo_update
 * receipts are f7e8c9c0 (ed2fd190) and 5bd284cf (fe467ced) at 21:54:14,
 * BOTH ok — two BLOCK writes. The receipts carry no args; the BLOCK KIND is
 * attested by the Fleet Supervisor's 22:00:17Z message ("your two blocks
 * cite a gate that no longer exists" — the dismissed owner card
 * oq_351176de), and the reason strings modeled below are SYNTHETIC (the
 * guard text's own instruction: status:'blocked' together with the reason).
 * The run completed clean at 21:59:24, shipping
 * PRs #112/#113/#114 (merge receipts 6ab9ce0a/319b873a/0125e915 in run
 * 4dbde611) and feeding the follow-on run that executed the cutover
 * (fe467ced/ed2fd190/10023020 all closed done with evidence — final message
 * 3c7646d1, run cf9aba8b). No perma-withhold, no run-end, no second trip.
 *
 * ADJUDICATION (this lane, 2026-10-16, evidence-led): MODEL BEHAVIOR — no
 * deterministic framework/schema/preflight/guard defect.
 * 1. BOTH guards are long-standing and semantically correct. git blame:
 *    the done-gate 409 is da3ebd842 (2026-08-03, PR #144 — goals/todos
 *    fleet foundations); the blockedReason apply-or-reject 400 is f902cc066
 *    (2026-08-10, PR #186 — added precisely so a reason-only update is
 *    never a silent no-op). ZERO commits shape either string since. The
 *    tool schema documents both contracts (platform-tools.ts todo_update:
 *    "'done' is GATED on dependency todos (force:true overrides…)" and
 *    "blockedReason … with status:'blocked', or alone to refresh an
 *    already-blocked todo").
 * 2. The failing calls mis-used the contracts: a done+evidence close on the
 *    drop-in SWEEP row (06c26d0f) while its dependency ("Verify cutover…",
 *    10023020) was still blocked — closing ahead of its own dep chain (live
 *    reads, sighting ticket 62f14ea6: the sweep row dependsOn 10023020;
 *    fe467ced's own only dep was the DONE deploy row 221e21bc — so the 409
 *    was the gate holding the line on the SWEEP row, never a false block on
 *    the cutover row, whose satisfied dep set would have closed cleanly),
 *    then blockedReason sent WITHOUT status:'blocked' on the in_progress
 *    DNS row. Both refusals are the guards working; the recovery receipts
 *    prove the correct shapes succeed.
 * 3. The breaker counted as designed: failure-shaped (+1) results from one
 *    tool, the intent fast-trip (+1) on the finish_run-naming call, trip at
 *    3, ONE filing, one-round withhold. The narration channel itself is
 *    modeled here (glm-5.3 reasoning is not persisted — reasoning-wire.ts —
 *    the same treatment as the 304ff1bb pin); the ticket's own
 *    "lane's reasoning named finish_run" is the telemetry-attested fact
 *    being modeled. Either placement of the finish_run mention (call 1 or
 *    call 2) trips at the second failure — the arithmetic is
 *    placement-insensitive inside the two-call window.
 * 4. NO shape exemption is warranted: refusals from real state gates are
 *    the breaker's primary derailment signal (the ea69c94e/1ab1a52b
 *    distinction — contrast the always-benign needsConfirmation envelope).
 *    The phantom "3×" title on a two-text weighted trip is the accepted
 *    cost of the self-heal doctrine.
 *
 * The guard contracts themselves (both refusals + the recovery shapes the
 * lane used at 21:54:14) are pinned store-side in
 * goals.service.596718e7.test.ts — not duplicated here.
 *
 * THIS PIN replays the incident's exact shape against the REAL agent loop
 * (coding profile, machineTriggered — finish_run offered as in the wild)
 * and asserts: both verbatim guard texts are failure-shaped; the modeled
 * live narration convicts todo_update of intending finish_run only while
 * finish_run is OFFERED; the trip fires at the SECOND failure with exactly
 * the two real texts + the ticket's args order filed, intended finish_run;
 * todo_update is withheld for exactly ONE round (absent from that round's
 * schema) and returns; the recovery-shape calls succeed; the run completes
 * clean — one filing, one trip metric, one steer, no perma, no run-end.
 *
 * Scaffold mirrors agent-derail-break.304ff1bb.test.ts (same mock set) +
 * machineTriggered (agent-machine-firing-effort.test.ts) + the
 * run-receipts mock the finish_run finalize path reads.
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

const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, _name: string, _args: any) => '{"ok":true}');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockToolCacheExec: jest.Mock = jest.fn(async (_name: string, _args: any) => '{"ok":true}');
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
jest.mock('./run-receipts.service', () => ({
  __esModule: true,
  recordRunReceiptAsync: jest.fn(),
  getRecentChatReceipts: jest.fn(async () => []),
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
import { detectIntendedToolChannels } from './tool-preflight';
import { looksLikeToolFailure } from './learnings-index.service';

/** CODING profile + machineTriggered — the wild lane's shape. finish_run is
 *  offered to top-level machine runs of coding lanes (build 2026-10-08 F-1),
 *  which is the premise of the intent fast-trip that made this a 2-text "3×". */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim ids (run 4dbde611 receipts + sighting 62f14ea6 live reads) ──
const FE467CED = 'fe467ced-572a-49db-aff8-02dac35030c6'; // DNS cutover row (in_progress; own dep = the DONE deploy row)
const ED2FD190 = 'ed2fd190-9846-42c6-a938-d7ccefcab5ed'; // virtual-keys row
const DEPLOY_TODO = '221e21bc-6655-4119-a3ff-d09fa64b1fc0'; // deploy row (done)
const SWEEP_TODO = '06c26d0f-a77f-41dc-adcb-c3268309a2db'; // drop-in sweep — the 409's ACTUAL target (dependsOn the blocked verify row 10023020)

/** The board brief the lane was working (fleet-event wake shape, quoting the
 *  row ids verbatim — the grounding haystack for the calls below). */
const BRIEF = [
  '[FLEET GOAL BOARD — todos unblocked to this chat]',
  `Todo "DNS cutover llm.cql.ca → rutherford-2" (${FE467CED}) and "Mint virtual keys for infrastructure callers" (${ED2FD190}) are actionable — execute now, then roll into roster verify.`,
  `Deploy row ${DEPLOY_TODO} is done; the drop-in sweep ${SWEEP_TODO} is still gated on the verify pass. Report units + healthz, then close out.`,
].join('\n');

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-596718e7-test',
  sessionId: 'sess-596718e7',
  runId: 'run-596718e7',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.3',
  projectName: 'litellm-gateway',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  machineTriggered: true,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: BRIEF,
  emit: jest.fn(),
});

// ── The incident's verbatim failure texts (ticket 596718e7, executor shape) ──
const FAIL_409 =
  'Tool todo_update failed: Todo cannot be marked done: waiting on 1 todo(s) not done: ' +
  '"Verify cutover: /v1/models roster vs 50, census script, StAnne legs (mbp-2 utility 100.64.0.1:8095, asr, ' +
  'accelerator image 100.64.0.1), self-hosted tailnet legs (node-a 100.64.0.1:8091, node-b 100.64.0.1:8000, GLM nodes), ' +
  'E2E completion through https://llm.cql.ca" (blocked). Pass force: true to override.';
const FAIL_400 =
  "Tool todo_update failed: blockedReason can only be set on a blocked todo (current status: 'in_progress'). " +
  "Pass status:'blocked' to block it first.";

/** The incident's verbatim call-arg heads (ticket "Call args", newest first). */
const REASON_ARG =
  'Client list is owner/fleet-side: per the 2026-10-11 incident brief (docs/SECURITY-INCIDENT_2026-10-11.md §5) ' +
  'every caller requests a virtual key through the owner/gateway lane. Mechanical callers are minted per-host.';
const EVIDENCE_ARG =
  'Fresh-host verification this run (SSH deploy@69.19.140.37): /etc/gateway-health-monitor.env does not exist; ' +
  'no KNOWN_DOWN overrides in any systemd drop-in (grep across /etc/systemd/system).';

/** The modeled LIVE reasoning of the convicted message (glm-5.3 reasoning is
 *  not persisted — reasoning-wire.ts — same treatment as the 304ff1bb pin;
 *  the ticket's "lane's reasoning named finish_run" is the attested fact):
 *  the lane narrated its run-end bookkeeping (finish_run, offered on this
 *  machine-triggered coding run) while emitting todo_update refusals. Names
 *  finish_run standalone in the final sentence and NEVER the called
 *  todo_update — the intent fast-trip's exact input. */
const R_FAIL_BATCH = 'The close was refused; the keys row waits on fleet-side decisions. I will record the typed claims with finish_run once the supervisor report lands.';
const C_FAIL_BATCH = 'The close is refused — the keys row waits on its roster-check dep. Re-blocking it with the fleet-side reason.';

// ── The incident's turns (receipts 827f3451 → ba4caf3e → f7e8c9c0) ───────────
const okPairTurn = {
  content: 'Banking the verified state on the two open rows before the close-out.',
  reasoning: 'Both rows are mid-flight; recording their current state now so the fleet report has fresh context.',
  toolCalls: [
    { id: 't1', name: 'todo_update', arguments: JSON.stringify({ todoId: DEPLOY_TODO, progressNote: 'Deploy green; units active; edge gates liveliness=200.' }) },
    { id: 't2', name: 'todo_update', arguments: JSON.stringify({ todoId: ED2FD190, progressNote: 'Key list narrowed to the infrastructure callers named in the verify row.' }) },
  ],
  finishReason: 'tool_calls' as const,
};
/** 21:51:20 (receipt aa12af7d) — the 409: a done+evidence close on the SWEEP
 *  row while its own dep ("Verify cutover…", 10023020) was still blocked —
 *  closing AHEAD of its dep chain. Per the adjudicated topology (sighting
 *  62f14ea6 live reads): the sweep row dependsOn 10023020 (blocked until
 *  22:14Z); the cutover row fe467ced's only dep was the DONE deploy row, so
 *  the 409 was the gate holding the line on the SWEEP row's chain — never a
 *  false block on the cutover row. */
const fail1Turn = {
  content: "Phase 1 is verified on receipts; closing the drop-in sweep row with this run's evidence.",
  reasoning: "The deploy is green and the fresh-host check ran clean; the sweep row can close with this run's evidence.",
  toolCalls: [{ id: 't3', name: 'todo_update', arguments: JSON.stringify({ todoId: SWEEP_TODO, status: 'done', evidence: EVIDENCE_ARG }) }],
  finishReason: 'tool_calls' as const,
};
/** 21:51:33 + 21:51:35 — the 1.6 s pair reads as ONE batch of two siblings
 *  (the withhold applies to the next round's schema, never the in-flight
 *  batch — the 304ff1bb "fifth sibling executed" contract). */
const failBatchTurn = {
  content: C_FAIL_BATCH,
  reasoning: R_FAIL_BATCH,
  toolCalls: [
    { id: 't4', name: 'todo_update', arguments: JSON.stringify({ todoId: ED2FD190, blockedReason: REASON_ARG }) },
    { id: 't5', name: 'todo_update', arguments: JSON.stringify({ todoId: ED2FD190, blockedReason: `${REASON_ARG} (re-send with the fuller context.)` }) },
  ],
  finishReason: 'tool_calls' as const,
};
/** The withhold round: no todo_update receipts exist between 21:51:35 and
 *  21:54:14 in the wild — the lane did NOT burn a not-offered refusal; it
 *  worked another offered tool while todo_update sat out its one round. */
const withholdRoundTurn = {
  content: 'Anchoring on real state: reading the record back from the host before any further status writes.',
  reasoning: 'The notice says the row tool sits out this round; reading the host state directly.',
  toolCalls: [{ id: 't6', name: 'run_command', arguments: JSON.stringify({ command: 'ssh deploy@69.19.140.37 "systemctl is-active litellm-gateway"' }) }],
  finishReason: 'tool_calls' as const,
};
/** The 21:54:14 recovery (receipts f7e8c9c0 on ed2fd190 + 5bd284cf on
 *  fe467ced, BOTH ok): two BLOCK writes. The receipts carry NO args — the
 *  BLOCK KIND is attested by the Fleet Supervisor's 22:00:17Z message
 *  ("your two blocks cite a gate that no longer exists" — the dismissed
 *  owner card oq_351176de), and the reason strings below are MODELED (the
 *  guard text's own instruction: status:'blocked' TOGETHER with the reason)
 *  — the sibling 62f14ea6 pin models the same receipts as a bare
 *  status:'in_progress' move; the receipts cannot discriminate, and the
 *  pinned contract (block-shape lands both fields) is identical either way. */
const recoveryTurn = {
  content: 'Back on offer — blocking both rows properly now, with the status and the reason together.',
  reasoning: 'The status write is back; blocking both rows with the live reasons as the guard instructed.',
  toolCalls: [
    { id: 't7', name: 'todo_update', arguments: JSON.stringify({ todoId: ED2FD190, status: 'blocked', blockedReason: 'Fleet verify pass outstanding: StAnne legs, tailnet legs, E2E through the edge.' }) },
    { id: 't8', name: 'todo_update', arguments: JSON.stringify({ todoId: FE467CED, status: 'blocked', blockedReason: 'Held for the fleet verify pass; record create + cert issue pending.' }) },
  ],
  finishReason: 'tool_calls' as const,
};
const FINAL = { content: 'State landed: both rows blocked with live reasons; the fleet report closes them.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');
const toolsOf = (i: number) => ((mockRunModelTurn.mock.calls[i]?.[2] as any[]) ?? []).map((t) => t?.function?.name as string).filter(Boolean);
const userTexts = () => (mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }> || [])
  .filter((m) => m?.role === 'user').map((m) => String(m.content));

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  delete process.env.FINISH_RUN_DISABLED;
  mockExecuteCodingTool.mockResolvedValue('{"ok":true}');
});

describe('ticket 596718e7 — weighted 2-text "3×" trip on todo_update guard refusals: guards correct, containment worked, model behavior', () => {
  it('UNIT: both verbatim guard texts are failure-shaped (the executor wrapper) — the breaker counts them; a success is not', () => {
    expect(looksLikeToolFailure(FAIL_409)).toBe(true);
    expect(looksLikeToolFailure(FAIL_400)).toBe(true);
    expect(looksLikeToolFailure('{"ok":true}')).toBe(false);
  });

  it('UNIT: the modeled live narration convicts todo_update of intending finish_run — only while finish_run is OFFERED (the machine-run premise)', () => {
    const offered = ['run_command', 'read_file', 'edit_file', 'verify', 'grep', 'glob', 'todo_list', 'todo_get', 'todo_update', 'finish_run'];
    expect(detectIntendedToolChannels(R_FAIL_BATCH, C_FAIL_BATCH, 'todo_update', offered)).toBe('finish_run');
    // A user-anchored run (no finish_run in the schema) convicts NOTHING on
    // the same narration — the fast-trip is an offered-set property, which
    // is why this trip shape is machine-run-specific.
    expect(detectIntendedToolChannels(R_FAIL_BATCH, C_FAIL_BATCH, 'todo_update', offered.filter((n) => n !== 'finish_run'))).toBeNull();
    // Control: naming the called tool acquits (the aligned-call shape).
    expect(detectIntendedToolChannels(`${R_FAIL_BATCH} via todo_update`, C_FAIL_BATCH, 'todo_update', offered)).toBeNull();
  });

  it('REPLAY the incident: trip at the SECOND failure (intent fast-trip +1), exactly the two real texts + the ticket args order filed, intended finish_run — one filing, one steer, one-round withhold, recovery succeeds, run completes clean', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce('{"ok":true}') // t1 ok
      .mockResolvedValueOnce('{"ok":true}') // t2 ok
      .mockResolvedValueOnce(FAIL_409)      // t3 — call 1: count 1 (aligned narration)
      .mockResolvedValueOnce(FAIL_400)      // t4 — call 2: count 2 + intent 1 = 3 → TRIP
      .mockResolvedValueOnce(FAIL_400);     // t5 — call 3 (same batch): fresh streak 1 + intent = 2, no trip
    mockRunModelTurn
      .mockResolvedValueOnce(okPairTurn)      // 21:50:42 receipts 827f3451/df6644db
      .mockResolvedValueOnce(fail1Turn)       // 21:51:20 receipt aa12af7d
      .mockResolvedValueOnce(failBatchTurn)   // 21:51:33/35 receipts 0f0969c1/ba4caf3e
      .mockResolvedValueOnce(withholdRoundTurn) // the ban round: no row-tool receipts in the wild window
      .mockResolvedValueOnce(recoveryTurn)    // 21:54:14 receipts f7e8c9c0/5bd284cf (both ok)
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput());

    // The run COMPLETED clean — no perma, no run-end, no model error.
    expect(result.finalText).toContain('State landed: both rows blocked with live reasons');
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended');

    // ── THE FILING: exactly ONE, with the incident's exact evidence shape ──
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('todo_update');
    expect(ev.intended).toBe('finish_run'); // the ticket's "lane's reasoning named finish_run"
    expect(ev.perma).toBe(false);
    expect(ev.shape).toBe('failure');
    // The "3×" title's texts: exactly TWO, newest first — the 400 (newest)
    // then the 409 — the weighted-count class (ea69c94e), not three failures.
    expect(ev.recentFailures).toHaveLength(2);
    expect(ev.recentFailures[0]).toContain("blockedReason can only be set on a blocked todo (current status: 'in_progress')");
    expect(ev.recentFailures[0]).toContain("Pass status:'blocked' to block it first.");
    expect(ev.recentFailures[1]).toContain('Todo cannot be marked done: waiting on 1 todo(s) not done');
    expect(ev.recentFailures[1]).toContain('(blocked). Pass force: true to override.');
    // DW-4 args snapshot, same newest-first order as the ticket's "Call args":
    // the blockedReason-only call, then the done+evidence call.
    expect(ev.recentArgs).toHaveLength(2);
    expect(ev.recentArgs[0]).toContain('"blockedReason":"Client list is owner/fleet-side');
    expect(ev.recentArgs[1]).toContain('"evidence":"Fresh-host verification this run');
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);

    // ── THE TRIP METRIC: one failure-shape trip, not perma ──
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta).toMatchObject({
      tool: 'todo_update', perma: false, intended: 'finish_run', shape: 'failure',
    });

    // ── THE STEER: one re-anchor, truthful about the failure shape, naming finish_run ──
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({
      tool: 'todo_update', intended: 'finish_run', reason: 'intent_mismatch',
    });
    const steer = userTexts().find((t) => t.includes('RE-ANCHOR (one per run)'));
    expect(steer).toBeDefined();
    expect(steer).toContain('your own reasoning named finish_run');
    expect(steer).toContain('call finish_run NOW');

    // ── THE WITHHOLD: todo_update absent for exactly the next round, back after ──
    // (finish_run is offered on every round here — the intent leg's premise.)
    expect(toolsOf(2)).toContain('todo_update');
    expect(toolsOf(2)).toContain('finish_run');
    expect(toolsOf(3)).not.toContain('todo_update');
    expect(toolsOf(3)).toContain('run_command');
    expect(toolsOf(4)).toContain('todo_update');

    // ── THE EXECUTION LEDGER: all three failing calls EXECUTED (real guard
    //    refusals from the store, not pre-flight), the withhold round burned
    //    no row-tool refusal, and both recovery calls ran with the correct shape ──
    const todoDispatches = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'todo_update');
    expect(todoDispatches).toHaveLength(7); // 2 ok (21:50:42) + 3 refused (21:51:20/33/35) + 2 recovery (21:54:14)
    const runDispatches = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'run_command');
    expect(runDispatches).toHaveLength(1);
    // The third sibling of the convicted batch executed (withhold applies to
    // the NEXT round, never the in-flight batch).
    expect(mockExecuteCodingTool.mock.calls.map((c) => c[1])).toEqual([
      'todo_update', 'todo_update', 'todo_update', 'todo_update', 'todo_update', 'run_command', 'todo_update', 'todo_update',
    ]);
    // The recovery calls carry the guard's own instruction: status:'blocked' WITH the reason.
    const recoveryArgs = todoDispatches.slice(5).map((c) => c[2] as any);
    expect(recoveryArgs.every((a: any) => a.status === 'blocked' && typeof a.blockedReason === 'string' && a.blockedReason.length > 0)).toBe(true);

    // The user-visible notices tell the truth about the shape.
    const notice = userTexts().find((t) => t.includes('temporarily removed from your tool list for the next round'));
    expect(notice).toBeDefined();
    expect(notice).toContain('Your own reasoning named finish_run');
  });

  it('REPLAY the negative (the mis-targeting leg): ALIGNED narrations never arm the intent leg — the same two guard refusals without the finish_run naming trip only at the THIRD real failure (3 texts filed)', async () => {
    // Same call sequence, but every narration is aligned (names no offered
    // tool): the weighted fast-trip never fires, so the trip needs three
    // REAL failures — and files THREE texts. This is the counterfactual
    // that proves the wild "3× with two texts" rode the intent leg.
    const alignedBatchTurn = {
      content: 'The close is refused — the keys row waits on its roster-check dep. Re-blocking it with the fleet-side reason.',
      reasoning: 'The close was refused; recording why the keys row cannot proceed while the fleet pass is outstanding.',
      toolCalls: [
        { id: 't4', name: 'todo_update', arguments: JSON.stringify({ todoId: ED2FD190, blockedReason: REASON_ARG }) },
        { id: 't5', name: 'todo_update', arguments: JSON.stringify({ todoId: ED2FD190, blockedReason: `${REASON_ARG} (re-send.)` }) },
      ],
      finishReason: 'tool_calls' as const,
    };
    mockExecuteCodingTool
      .mockResolvedValueOnce('{"ok":true}')
      .mockResolvedValueOnce('{"ok":true}')
      .mockResolvedValueOnce(FAIL_409)
      .mockResolvedValueOnce(FAIL_400)
      .mockResolvedValueOnce(FAIL_400);
    mockRunModelTurn
      .mockResolvedValueOnce(okPairTurn)
      .mockResolvedValueOnce(fail1Turn)
      .mockResolvedValueOnce(alignedBatchTurn) // counts 1, 2, 3 → TRIP at the third real failure
      .mockResolvedValueOnce(withholdRoundTurn)
      .mockResolvedValueOnce(recoveryTurn)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.intended).toBeNull(); // no intent leg — the aligned counterfactual
    expect(ev.recentFailures).toHaveLength(3); // THREE texts — the unweighted shape
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta).toMatchObject({ tool: 'todo_update', perma: false, shape: 'failure' });
    // No steer armed (no intent mismatch anywhere).
    expect(reanchorMetrics()).toHaveLength(0);
  });

  it('wiring seam: todo_update stays a preflight-covered platform tool and finish_run stays the machine-run finish record (a regression here silently re-arms the incident)', async () => {
    const { PLATFORM_TOOL_NAMES } = await import('../platform/platform-tool-names');
    expect(PLATFORM_TOOL_NAMES).toContain('todo_update');
    const { finishRunEligible } = await import('./finish-run');
    expect(finishRunEligible({
      topLevel: true, role: null, fastSeat: false, sessionId: 'sess-596718e7',
      machineTriggered: true, ownerDispatch: undefined, profileKind: 'coding',
    })).toBe(true); // the intent leg's premise: finish_run IS offered on this run shape
  });
});

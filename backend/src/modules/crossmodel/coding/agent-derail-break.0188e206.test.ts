/**
 * REPLAY PIN — ticket 0188e206-9a18-4229-9edd-b82c0b7b6d55 (mishap, auto-filed
 * 2026-10-18T20:02:26Z at breaker trip): "3× tool-failure streak: cancel_schedule
 * on 'ticket 35c3ecb0: Supervisor board-status' — framework or model?"
 *
 * THE INCIDENT (session e6e20695-8406-4dc7-8b16-ed413f566ef2, run
 * cb5e3085-8d86-4b7e-bb40-4960b46ee642, machine wake): the lane held a REAL
 * schedule id — 2a011fd0-964c-4025-9cef-fd5bde3bcd2f, its own "BACKSTOP for
 * the 35c3ecb0 ticket lane (reviewer-verdict wait" row, read from
 * list_schedules earlier in the run — and emitted
 *   cancel_schedule({ id: "2a011fd0-…", confirmationId: "undefined", … })
 * while its own reasoning named verify. The tool pre-flight
 * (tool-preflight.ts findUngroundedIdArgs) refused the call WITHOUT executing
 * it:
 *   {"ok":false,"tool":"cancel_schedule","reason":"ungrounded_id",
 *    "rejected":[{"key":"confirmationId","value":"undefined"}],
 *    "message":"NOT EXECUTED: cancel_schedule was called with
 *    confirmationId=\"undefined\", which is not an id you obtained this run — …
 *    Your reasoning named verify — you evidently meant to call verify; call it
 *    now with its real parameters."}
 * and the breaker fast-tripped (ungrounded id +1, intent mismatch +1 ⇒ 3 on
 * the FIRST call) → one-round withhold + exactly ONE auto-filed investigation
 * ticket (this one).
 *
 * ADJUDICATION (ticket lane 80f9271b, 2026-10-18, against primary sources):
 * MODEL behavior — every deterministic seam held; NO framework defect.
 *   · The `id` argument was GROUNDED and the guard did NOT convict it: the
 *     schedule id is uuid-shaped (ID_SHAPE_RE) AND occurred in the run's own
 *     list_schedules result (both grounding legs). The ONLY rejected arg was
 *     confirmationId — the literal STRING "undefined", a model-side
 *     serialization of an OMITTED optional param. The schema
 *     (platform-tools.ts cancel_schedule) declares confirmationId optional
 *     with required:['id'] and its description says "Omit on the first call" —
 *     the correct emission is to omit it entirely, never to stringify a JS
 *     undefined. No framework surface EMITS the literal "undefined" as an id
 *     value; it is a decoder emission, the same placeholder family as
 *     "noop"/"test"/"placeholder" (b515ad74/688a01ce, 03e8cd3d, 8b5cbbcb7)
 *     wearing a JS-native spelling.
 *   · The refusal envelope is the preflight's pinned shape
 *     (ungroundedIdRefusal, tool-preflight.ts) — truthful and self-describing.
 *     The named intent (verify) was REAL: verify is an offered coding tool,
 *     and the run DID recover exactly along the refusal's redirect — receipts
 *     prove verify ok (5716bfd0, 20:07:03Z) then cancel_schedule ok
 *     (3629328b, 20:07:30Z, scheduleId 2a011fd0-964c-4025-9cef-fd5bde3bcd2f)
 *     with the SAME real id and NO confirmationId. The self-heal doctrine
 *     (owner 2026-09-10) worked: refused → redirected → recovered in-run;
 *     the round-AFTER round below replays that recovery shape.
 *   · The "3×" title over ONE refusal text is the DESIGNED weighted
 *     arithmetic, not a miscount (agent.ts fast-trip weights, ticket 62f14ea6
 *     adjudication precedent): ungrounded id +1, intent mismatch +1, the
 *     failure itself +1 ⇒ 3 on the first call. The ticket's own body carries
 *     exactly ONE failure text and ONE args row — consistent with one refused
 *     call, which the run receipts confirm (a single ok:false cancel_schedule
 *     row, 051b83e4 20:02:25Z).
 *   · Not a regression: the REFUSAL path (findUngroundedIdArgs +
 *     ungroundedIdRefusal) is byte-identical since #1303 (2026-10-06); the
 *     three later touches of tool-preflight.ts (#1430 2026-10-11 filename-
 *     glued mentions; #1723/#1750 2026-10-18 verdict/quoted-name strips) all
 *     live inside detectIntendedTool's CONVICTION SCOPING and do not touch
 *     this incident's plain case — the reasoning's final sentence names
 *     verify and never cancel_schedule, the whole-word shape those changes
 *     preserved (pinned in tool-preflight.replays.test.ts). The fast-trip
 *     weights date to f356e14a7 (2026-09-09, git log -S 'failStreakCount').
 *   · The rendered args' FOUR duplicate `id` keys are likewise the model's
 *     own emission: the filer's arg snapshot path
 *     (maskDeliverSecretsInArgsString on cancel_schedule args) is
 *     byte-identical for non-secret args (no deliverSecrets field, no
 *     credential span) — it never rewrites keys. Duplicate JSON keys are a
 *     decoder artifact (last-wins in JSON.parse, a no-op here since all four
 *     values are identical), orthogonal to the refusal; the DW-4 snapshot
 *     carries them until the harness's 200-char capture cap clips the tail —
 *     the same mid-value truncation the filed ticket's args row shows.
 *
 * NO platform code change: this pin locks the intended behavior (the preflight
 * convicts the "undefined" placeholder for the OPTIONAL param while letting
 * the REAL id through, names the intended tool, fast-trips the breaker,
 * withholds for exactly one round, and calls the investigation filer ONCE —
 * reflection.ts fileStreakInvestigation, mocked here; its redis dedupe and
 * ticket render are pinned in reflection's own suites — with the verbatim
 * envelope) so a future "fix" cannot weaken either leg — while replaying the
 * incident end-to-end through the real agent loop (the REAL preflight +
 * breaker run; only the model, the tool executor, and the streak
 * consult/filing are mocked). Scaffold mirrors
 * agent-derail-break.03e8cd3d.test.ts on a CODING profile (the incident lane
 * was a coding session; verify is a coding-profile tool, and the built-in
 * CODING_TOOL_SCHEMA already offers it — no extraTools double needed).
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
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn(), buildCodeMatchesBlock: jest.fn(async () => '') }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ""),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0), buildSessionMemoryInventory: jest.fn(async () => '') }));
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
import { findUngroundedIdArgs, groundingHaystack } from './tool-preflight';

// Coding-kind, like the incident lane (a CODING ticket-lane session): the
// built-in CODING_TOOL_SCHEMA offers verify on this profile — the
// reasoning-named tool is genuinely offered, so the intent-mismatch fast-trip
// leg is in play exactly as in the incident (on a chat profile it is not).
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: true,
  planReminders: false,
  memorySource: 'coding',
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-0188e206-test',
  sessionId: 'sess-0188e206',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'retire the backstop schedule for the 35c3ecb0 lane now that the reviewer verdict landed',
  emit: jest.fn(),
});

/** A turn whose REASONING names another tool while it emits `name` with a raw args string. */
const derailTurn = (name: string, n: number, args: string, reasoning: string) => ({
  content: '',
  reasoning,
  toolCalls: [{ id: `t${n}`, name, arguments: args }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const toolNames = (call: any[]): string[] => ((call?.[2] ?? []) as any[]).map((t: any) => t?.function?.name).filter(Boolean);
const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const preflightMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_preflight');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');

/** The incident's REAL schedule id (resolve_id, 2026-10-18: "BACKSTOP for the
 *  35c3ecb0 ticket lane (reviewer-verdict wait") — uuid-shaped, read this run. */
const REAL_SCHEDULE_ID = '2a011fd0-964c-4025-9cef-fd5bde3bcd2f';

/** The incident's list_schedules result — the tool result that grounded the
 *  real id BOTH ways (uuid shape AND verbatim occurrence in the haystack). */
const LIST_SCHEDULES_RESULT = `{"schedules":[{"id":"${REAL_SCHEDULE_ID}","label":"BACKSTOP for the 35c3ecb0 ticket lane (reviewer-verdict wait","kind":"once","enabled":true,"nextRunAt":"2026-10-18T22:45:00.000Z"}]}`;

/** The incident's reasoning shape: it names verify (an offered coding tool)
 *  and NEVER names cancel_schedule. */
const INCIDENT_REASONING =
  'The reviewer verdict landed, so the backstop is moot. Before retiring it I need the run-chain green — calling verify now with its real parameters.';

/** The incident's emitted args (verbatim shape from the filed ticket): the
 *  REAL id, plus the literal string "undefined" for the OPTIONAL
 *  confirmationId param, plus the decoder's duplicate-key artifact (all four
 *  id values identical, so JSON.parse last-wins is a no-op — the artifact
 *  matters only in the DW-4 args snapshot, where the 200-char capture cap
 *  clips the tail mid-value exactly as the filed ticket's args row shows). */
const INCIDENT_ARGS = `{"id":"${REAL_SCHEDULE_ID}","confirmationId":"undefined","id":"${REAL_SCHEDULE_ID}","id":"${REAL_SCHEDULE_ID}","id":"${REAL_SCHEDULE_ID}"}`;

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 0188e206 replay — cancel_schedule: real id + confirmationId:"undefined" placeholder', () => {
  it('the grounding leg convicts ONLY the "undefined" placeholder — the REAL schedule id passes untouched (the schema never asks for confirmationId)', () => {
    // The haystack a lane holding the backstop row legitimately has: the
    // brief + its own prior list_schedules result naming the schedule id.
    const haystack = groundingHaystack([
      { role: 'user', content: 'retire the backstop schedule for the 35c3ecb0 lane' },
      { role: 'tool', content: LIST_SCHEDULES_RESULT },
    ]);
    // JSON.parse collapses duplicate keys (last-wins, identical values) — the
    // incident's args reach the preflight as {id: REAL, confirmationId: "undefined"}.
    const args = JSON.parse(INCIDENT_ARGS);
    const bad = findUngroundedIdArgs(args, haystack);
    // ONLY the placeholder is rejected; the uuid-shaped id never appears.
    expect(bad).toEqual([{ key: 'confirmationId', value: 'undefined' }]);
    // And the id is grounded independently of the haystack leg (uuid shape).
    expect(findUngroundedIdArgs({ id: REAL_SCHEDULE_ID }, '')).toEqual([]);
  });

  it('REPLAY: the preflight refuses WITHOUT executing, convicts only confirmationId="undefined", names verify, fast-trips the breaker, withholds one round, then the lane recovers along the redirect — filer called ONCE with the verbatim envelope', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce(LIST_SCHEDULES_RESULT)                                  // round 1: list_schedules (grounds the real id)
      .mockResolvedValueOnce('verify: typecheck ✓ lint ✓ test ✓');                   // round 3: verify — the incident's recovery (5716bfd0)
    mockRunModelTurn
      // Round 1: the lane reads its schedules — the incident run held the
      // backstop row from an earlier list_schedules call.
      .mockResolvedValueOnce(derailTurn('list_schedules', 1, '{}', ''))
      // Round 2: THE DERAIL — real id + the "undefined" placeholder for the
      // optional confirmationId, while the reasoning says verify.
      .mockResolvedValueOnce(derailTurn('cancel_schedule', 2, INCIDENT_ARGS, INCIDENT_REASONING))
      // Round 3: THE RECOVERY — the refusal's redirect followed: verify runs
      // green (the incident's receipt 5716bfd0), exactly as the notice said.
      .mockResolvedValueOnce(derailTurn('verify', 3, '{}', 'Running verify now with its real parameters, then I retire the backstop.'))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // 1. Never round-tripped cancel_schedule to the executor — no schedule
    //    was touched by the refused call (the incident's real cancel came
    //    AFTER recovery: receipt 3629328b cancelled 2a011fd0 legitimately).
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);
    expect(mockExecuteCodingTool.mock.calls[0][1]).toBe('list_schedules');
    expect(mockExecuteCodingTool.mock.calls[1][1]).toBe('verify');
    expect(mockExecuteCodingTool.mock.calls.map((c: any[]) => c[1])).not.toContain('cancel_schedule');

    // 2. What the MODEL saw on the next round: the slip-echo prune
    //    (tool-scope.ts cause 3, owner 2026-09-22 — live in prod during the
    //    incident) removed the refused call + its refusal envelope from the
    //    replayed transcript and left ONE harness line naming the slip, the
    //    placeholder, and the intended tool. The refusal envelope itself
    //    never enters the model's context — it rides the streak evidence
    //    (assertion 6), which is exactly how the auto-filed ticket came to
    //    carry it verbatim.
    const round3Messages = mockRunModelTurn.mock.calls[2][1] as any[];
    expect(round3Messages.find((m) => m.role === 'tool' && m.tool_call_id === 't2')).toBeUndefined();
    const slipNotice = round3Messages.find((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('SLIP REMOVED'));
    expect(slipNotice?.content).toContain('cancel_schedule("undefined")');
    expect(slipNotice?.content).toContain('the id was a placeholder');
    expect(slipNotice?.content).toContain('Your reasoning named verify');
    expect(slipNotice?.content).toContain('call verify now with its real parameters');

    // 3. Fast trip on the FIRST derailed call (failure +1, ungrounded +1,
    //    intent mismatch +1 ⇒ 3): cancel_schedule is withheld from the very
    //    next round's schema (verify still offered — the recovery path)…
    const round3Tools = toolNames(mockRunModelTurn.mock.calls[2]);
    expect(round3Tools.length).toBeGreaterThan(0);
    expect(round3Tools).not.toContain('cancel_schedule');
    expect(round3Tools).toContain('verify');
    //    …the breaker notice names the tool the reasoning meant…
    expect(round3Messages.some((m) => m.role === 'user' && typeof m.content === 'string'
      && m.content.includes('ALL FAILED') && m.content.includes('named verify'))).toBe(true);
    //    …and the withhold is ONE ROUND ONLY: cancel_schedule is back in the
    //    offered schema on the round after (withheldUntilStep = step + 2) —
    //    which is how the incident's run could cancel 2a011fd0 five minutes
    //    later (receipt 3629328b).
    const round4Tools = toolNames(mockRunModelTurn.mock.calls[3]);
    expect(round4Tools).toContain('cancel_schedule');

    // 4. Telemetry: one preflight guard_strike, one re-anchor steer (431518a2
    //    — the mid-run wrong-tool steer), one breaker trip, all naming
    //    cancel_schedule and the intended verify.
    expect(preflightMetrics()).toHaveLength(1);
    expect(preflightMetrics()[0].meta).toMatchObject({ tool: 'cancel_schedule', reason: 'ungrounded_id', intended: 'verify' });
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'cancel_schedule', intended: 'verify', reason: 'intent_mismatch' });
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta).toMatchObject({ tool: 'cancel_schedule', intended: 'verify', shape: 'failure' });

    // 5. The recovery ran verify for real — the executor saw it once, green.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2); // list_schedules + verify

    // 6. Exactly ONE investigation-filer call at the trip (the ticket this
    //    pin replays — reflection's redis dedupe + render are pinned in
    //    reflection's own suites), carrying the tool, the intent, and the
    //    REFUSAL ENVELOPE captured at counting time — the verbatim failure
    //    text the auto-filed ticket 0188e206 shows: ungrounded_id, rejected
    //    confirmationId "undefined", NOT EXECUTED, the verify redirect, and
    //    NO rejected schedule id (the real id passed the grounding leg).
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    expect(mockFileStreakInvestigation.mock.calls[0][0]).toMatchObject({ tool: 'cancel_schedule', intended: 'verify' });
    const filedFailures = mockFileStreakInvestigation.mock.calls[0][0].recentFailures.join('\n');
    expect(filedFailures).toContain('"ungrounded_id"');
    expect(filedFailures).toContain('NOT EXECUTED');
    expect(filedFailures).toContain('"confirmationId"');
    expect(filedFailures).toContain('"undefined"');
    expect(filedFailures).toContain('not an id you obtained this run');
    expect(filedFailures).toContain('Your reasoning named verify');
    expect(filedFailures).not.toContain(`id=\\"${REAL_SCHEDULE_ID}\\"`);
    // The DW-4 args snapshot rides the filing too — mask-identical for these
    // non-secret args (no deliverSecrets field, no credential span), clipped
    // at the harness's 200-char capture cap: the incident's 206-char args
    // clip mid-tail, the same mid-value truncation the filed ticket's args
    // row shows. Both needles (the real id, the placeholder) sit in the head.
    const filedArgs = (mockFileStreakInvestigation.mock.calls[0][0].recentArgs ?? []).join('\n');
    expect(filedArgs).toContain(REAL_SCHEDULE_ID);
    expect(filedArgs).toContain('"confirmationId":"undefined"');
    expect(filedArgs.length).toBeLessThanOrEqual(200 + 1); // one row + join separator
  });

  it('CONTROL (no overreach): the SAME call minus the placeholder — real id, confirmationId OMITTED as the schema instructs — executes normally: no refusal, no trip, no ticket', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce(LIST_SCHEDULES_RESULT) // list_schedules
      .mockResolvedValueOnce(`{"ok":true,"scheduleId":"${REAL_SCHEDULE_ID}","cancelled":true}`); // cancel_schedule — the incident's receipt 3629328b shape
    mockRunModelTurn
      .mockResolvedValueOnce(derailTurn('list_schedules', 1, '{}', ''))
      .mockResolvedValueOnce(derailTurn('cancel_schedule', 2, `{"id":"${REAL_SCHEDULE_ID}"}`, 'Retiring the backstop now that the verdict landed.'))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // The success envelope landed on the cancel_schedule call itself.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);
    expect(mockExecuteCodingTool.mock.calls[0][1]).toBe('list_schedules');
    expect(mockExecuteCodingTool.mock.calls[1][1]).toBe('cancel_schedule');
    expect(preflightMetrics().filter((m) => m.meta.tool === 'cancel_schedule')).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0);
    expect(reanchorMetrics()).toHaveLength(0);
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
  });
});

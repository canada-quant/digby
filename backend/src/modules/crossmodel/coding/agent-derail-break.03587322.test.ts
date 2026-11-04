/**
 * Replay pin — ticket 03587322 (anti-derail guard, 2026-09-21 — lane
 * 596102ca firing-256).
 *
 * THE INCIDENT: the firing-256 lane repeated the ONE narration line
 *   "Executing the two mandated transcript pulls — get_chat_messages on both
 *   lanes (independent, batched):"
 * once per turn across ~dozens of turns of a ~38-minute streaming final,
 * INTERLEAVED with real todo_create calls (23 junk todos between copies).
 * Every tool-shaped breaker missed it: the failure derail-breaker needs
 * failure-shaped results (the todo_creates SUCCEEDED), the identical-call
 * repeat breaker needs identical name:arguments signatures (the titles
 * differed), the storm leg needs >24 calls in ONE turn (they were spread
 * one-per-turn), the narrated-tool-emit loop break needs CONSECUTIVE
 * call-free turns and RESETS on any real tool call (agent.ts narr-loop
 * state, "A REAL tool call breaks the narrated-announcement streak"), and
 * the in-stream looksRepetitive probe sees ONE turn at a time.
 *
 * THE GUARD PINNED HERE (the fix): a CROSS-TURN REPEATED-LINE tracker in
 * runAgentLoop (agent.ts — "CROSS-TURN REPEATED-LINE BREAK", state declared
 * with the narr-loop state) fed by coding-model.ts's exported
 * longLineRepeatCounts (normalized lines — whitespace collapsed, digit-runs
 * folded to '#', ≥40 chars, fenced code stripped). Per-line {count, turns}
 * accumulate CUMULATIVELY across the run's turns and are NEVER reset by
 * real tool calls — that reset is exactly the blind spot. Thresholds
 * (runAgentLoop locals): LINE_REPEAT_RUN_WARN=4, LINE_REPEAT_RUN_BREAK=6,
 * each requiring ≥2 distinct turns. At ≥4 on a turn WITH tool calls: ONE
 * in-band warning per distinct line (lineRepeatNudgedKey), pushed after the
 * assistant record so role order stays intact; the turn's tool calls STILL
 * dispatch (a warning, not a withholding). At ≥6: the run ENDS before that
 * turn's tool calls dispatch — guard-marked part + finalText note
 * "[HARNESS] Run ended: the identical narration line was repeated 6×…",
 * emit('guard_marker'), progress stage 'line-repeat-break', GUARD_STRIKE
 * metric meta.seam 'final_line_repeat_break' state 'ended_run', a
 * derail-rescue continuation attempt (dynamic import './derail-rescue'),
 * and an attribution filing via fileStreakInvestigation (tool 'final_text').
 * On a CALL-FREE turn the warning does NOT arm (the narr-loop break owns
 * call-free turns) but the count still accumulates and the break at 6
 * still ends the run.
 *
 * REPLAY DESIGN NOTE (read before touching the scripts): the brief's
 * "vary N" todo titles are spelled here as WORD-varied titles
 * (noop-f256-alpha, -bravo, …), NOT digit-varied (break1, break2, …) —
 * digit-varied consecutive todo_create turns share ONE digit-collapsed
 * near-signature and trip the PRE-EXISTING 54a172ac near-identical repeat
 * leg at the 4th consecutive turn (agent.ts:3719-3722, 3757-3776;
 * todo_create ∈ NEAR_BREAK_TOOLS via RECEIPT_TOOLS), which withholds
 * todo_create for a model round and cuts the replay to 4 executions. The
 * word-varied titles keep every tool-shaped breaker blind — exactly the
 * incident's blind spot — so the ONLY guard that can fire is the one
 * pinned here. Also: goalId 'g1' is not id-shaped (tool-preflight
 * ID_SHAPE_RE), so it must occur VERBATIM in the user message (the
 * grounding haystack) or the platform-tool preflight refuses the call as
 * an ungrounded id before execution.
 *
 * Scaffold mirrors agent-derail-break.02bf673a.test.ts and
 * agent-derail-break.c35162ee.test.ts (same mock set) plus a
 * './derail-rescue' mock — no existing run-end test mocks it (the real
 * enqueueDerailRescue rides the mocked redis into a real hooks.service
 * import); mocking makes the "rescue attempted" pin deterministic.
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

// The run-end continuation seam (agent.ts dynamically imports it at the
// terminal state). Mocked so the "rescue attempted" assertion is
// deterministic — the real one would ride the mocked redis into a real
// hooks.service import.
const mockEnqueueDerailRescue: jest.Mock = jest.fn(async () => ({ rescued: true, reason: 'woken', count: 1, max: 2 }));
jest.mock('./derail-rescue', () => ({
  __esModule: true,
  enqueueDerailRescue: (...a: any[]) => mockEnqueueDerailRescue(...a),
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
import { longLineRepeatCounts } from './coding-model';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// ── The incident's verbatim repeated line (lane 596102ca firing-256). 103
// chars ≥ the 40-char floor, digit-free (a stable digit-collapsed key),
// restated EXACTLY once per turn — the shape every tool-shaped breaker
// missed.
const INCIDENT_LINE =
  'Executing the two mandated transcript pulls — get_chat_messages on both lanes (independent, batched):';

/** Word-varied noop titles — see the header's REPLAY DESIGN NOTE (digit-
 *  varied titles would trip the PRE-EXISTING 54a172ac near-identical leg). */
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

const mockEmit: jest.Mock = jest.fn();

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-03587322-test',
  sessionId: 'sess-03587322',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  // 'g1' verbatim — grounds the goalId arg against the id preflight.
  userMessage: '[firing-256 replay] Continue the mandated bookkeeping under goal g1 — file each noop todo, then finish.',
  emit: mockEmit,
});

/** A turn carrying the incident line EXACTLY once plus a short (<40 chars,
 *  never line-counted) varying filler, and calling `tool` once. */
const lineTurn = (n: number, tool: string, args: unknown) => ({
  content: `${INCIDENT_LINE}\n(noop filing ${WORDS[(n - 1) % WORDS.length]})`,
  reasoning: '',
  toolCalls: [{ id: `t${n}`, name: tool, arguments: JSON.stringify(args) }],
  finishReason: 'tool_calls',
});
const todoTurn = (n: number) => lineTurn(n, 'todo_create', { goalId: 'g1', title: `noop-f256-${WORDS[(n - 1) % WORDS.length]}` });
const FINAL = { content: 'Both transcript pulls finished; findings synthesized from the receipts above.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** GUARD_STRIKE loop metrics recorded with one meta.seam. */
const strikes = (seam: string) =>
  mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === seam);
/** Executed dispatches of one tool (executeCodingTool(ctx, name, args)). */
const execsOf = (name: string) => mockExecuteCodingTool.mock.calls.filter((c) => c[1] === name);
/** Every message content handed to ANY model call (arg index 1). */
const allMessageTexts = (): string[] =>
  mockRunModelTurn.mock.calls.flatMap((c) =>
    ((c[1] ?? []) as any[]).map((m: any) => (typeof m?.content === 'string' ? m.content : '')).filter(Boolean));
/** Message contents handed to ONE model call (the message list is cumulative
 *  — a pushed notice reappears in every LATER call, so "pushed exactly once"
 *  assertions must read a single call's list). */
const messageTextsOf = (callIdx: number): string[] =>
  ((mockRunModelTurn.mock.calls[callIdx]?.[1] ?? []) as any[])
    .map((m: any) => (typeof m?.content === 'string' ? m.content : ''))
    .filter(Boolean);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

afterEach(() => {
});

describe('ticket 03587322 — cross-turn repeated-line break: the tracker never resets on real tool calls', () => {
  it('INCIDENT REPLAY: the line restated once per turn across 6 todo_create turns — warn at 4 (calls still dispatch), run ends at 6 BEFORE the 6th call dispatches', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(todoTurn(1))  // count 1 (turns 1) — below the ≥2-turns gate
      .mockResolvedValueOnce(todoTurn(2))  // count 2
      .mockResolvedValueOnce(todoTurn(3))  // count 3
      .mockResolvedValueOnce(todoTurn(4))  // count 4 → WARN arms (tool-calling turn); the call still dispatches
      .mockResolvedValueOnce(todoTurn(5))  // count 5 — one warning per distinct line, never re-nudged
      .mockResolvedValueOnce(todoTurn(6))  // count 6 → BREAK: the run ends BEFORE this turn's call dispatches
      .mockResolvedValue(FINAL);           // unreachable — the loop must already be broken

    const result = await runCodingAgent(makeInput());

    // (a) The 6th turn's todo_create NEVER dispatched — exactly 5 executions.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(6);
    expect(execsOf('todo_create')).toHaveLength(5);
    // (b) The one-time warning rode into the model context after turn 4:
    // exactly ONE copy in the (cumulative) message list of the last call.
    const notices = messageTextsOf(5).filter((t) => /repeated the identical line/.test(t));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('[HARNESS NOTICE — not typed by the user]');
    expect(notices[0]).toContain(INCIDENT_LINE);
    expect(notices[0]).toMatch(/4 times across 4 turns/);
    // … and it was already present for the turn right after the warn.
    expect(messageTextsOf(4).some((t) => /repeated the identical line/.test(t))).toBe(true);
    // (c) The honest run-end note is the final text (derail run-end parity).
    expect(result.finalText).toContain('[HARNESS] Run ended: the identical narration line was repeated 6×');
    expect(result.finalText).toContain('across 6 turns of this run');
    expect(result.finalText).toContain(INCIDENT_LINE);
    // (d) A guard-marked transcript part carries the same note.
    expect(result.parts.some((p: any) => p.marker === 'guard'
      && typeof p.text === 'string'
      && p.text.includes('[HARNESS] Run ended: the identical narration line was repeated 6×'))).toBe(true);
    // emit parity: guard_marker + the 'line-repeat-break' progress stage.
    const guardMarkerTexts = mockEmit.mock.calls.filter((c) => c[0] === 'guard_marker').map((c) => String(c[1]?.text ?? ''));
    expect(guardMarkerTexts.some((t) => t.includes('the identical narration line was repeated 6×'))).toBe(true);
    const progressStages = mockEmit.mock.calls.filter((c) => c[0] === 'progress').map((c) => c[1]?.stage);
    expect(progressStages).toContain('line-repeat-break');
    // (e) Telemetry: ONE 'warned' strike (count 4, turns 4) + ONE 'ended_run'
    // strike (count 6, turns 6) on the final_line_repeat_break seam.
    const lr = strikes('final_line_repeat_break');
    expect(lr.filter((m) => m.meta.state === 'warned')).toHaveLength(1);
    expect(lr.some((m) => m.meta.state === 'warned' && m.meta.count === 4 && m.meta.turns === 4)).toBe(true);
    expect(lr.filter((m) => m.meta.state === 'ended_run')).toHaveLength(1);
    expect(lr.some((m) => m.meta.state === 'ended_run' && m.meta.count === 6 && m.meta.turns === 6 && m.meta.line === INCIDENT_LINE)).toBe(true);
    // Run-end side seams: the derail-rescue continuation was attempted with
    // the ended run's goal context, and the attribution filing carries the
    // repeated line as its evidence (tool 'final_text').
    expect(mockEnqueueDerailRescue).toHaveBeenCalledTimes(1);
    expect(mockEnqueueDerailRescue.mock.calls[0][0]).toEqual(expect.objectContaining({
      sessionId: 'sess-03587322', tools: [], intended: null, trips: 6,
      goalHint: expect.stringContaining('goal g1'),
    }));
    // 2c98b460 (2026-09-22): the SUCCESS-side wrong-tool guard ALSO claims
    // this shape — the incident line NAMES get_chat_messages while todo_create
    // SUCCEEDS, so its re-anchor steer arms at the 3rd mismatched success and
    // todo_create is withheld at the 5th — THAT trip files its own attribution
    // (tool 'todo_create') BEFORE the line-break's. Scope this lookup by tool.
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const ev = filings.find((f) => f.tool === 'final_text');
    expect(ev).toBeDefined();
    expect(ev.perma).toBe(false);
    expect(ev.recentFailures).toEqual([INCIDENT_LINE]);
    // Ticket 141d9d92: the line-repeat filing renders its TRUE class —
    // narration-repeat run-end, never a "tool-failure streak: final_text"
    // (no such tool exists; the mislabel sent investigators to diff a
    // nonexistent tool's changes).
    expect(ev.shape).toBe('narration_repeat');
    expect(ev.repeats).toBe(6);
    // …and the new guard's EARLIER containment of the same incident is pinned
    // as intended: ONE re-anchor steer, then ONE success-shape withhold.
    expect(strikes('tool_derail_reanchor')).toHaveLength(1);
    const successTrips = strikes('tool_derail_break').filter((m) => m.meta.shape === 'success_intent');
    expect(successTrips).toHaveLength(1);
    expect(successTrips[0].meta).toMatchObject({ tool: 'todo_create', perma: false, intended: 'get_chat_messages' });
  });

  it('NO-RESET PIN: a DIFFERENT real tool call interleaved between line-repeating turns does NOT reset the streak (the narr-loop blind spot this tracker closes)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(todoTurn(1))                          // count 1
      .mockResolvedValueOnce(todoTurn(2))                          // count 2
      .mockResolvedValueOnce(lineTurn(3, 'todo_list', {}))         // count 3 — a REAL call of a DIFFERENT tool: the narr-loop streak would reset here; this tracker must not
      .mockResolvedValueOnce(todoTurn(4))                          // count 4 → WARN
      .mockResolvedValueOnce(todoTurn(5))                          // count 5
      .mockResolvedValueOnce(todoTurn(6))                          // count 6 → BREAK before dispatch
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput());

    // The break fired AT ALL is the pin: had the interleaved todo_list reset
    // the accumulation, turns 4-6 would have counted 1,2,3 and nothing fired.
    expect(result.finalText).toContain('[HARNESS] Run ended: the identical narration line was repeated 6×');
    const lr = strikes('final_line_repeat_break');
    expect(lr.some((m) => m.meta.state === 'warned' && m.meta.count === 4 && m.meta.turns === 4)).toBe(true);
    expect(lr.some((m) => m.meta.state === 'ended_run' && m.meta.count === 6 && m.meta.turns === 6)).toBe(true);
    // Both real tools really executed on every pre-break turn.
    expect(execsOf('todo_create')).toHaveLength(4);
    expect(execsOf('todo_list')).toHaveLength(1);
  });

  it('BELOW-THRESHOLD FP GUARD: 3 line-repeating turns then a clean final answer — no line-repeat warning or strike, every call dispatched (the only guard surface is the 2c98b460 guard\'s ONE re-anchor steer)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(todoTurn(1))  // count 1
      .mockResolvedValueOnce(todoTurn(2))  // count 2
      .mockResolvedValueOnce(todoTurn(3))  // count 3 — under LINE_REPEAT_RUN_WARN=4
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput());

    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
    expect(execsOf('todo_create')).toHaveLength(3); // a run under the warn threshold is untouched
    expect(allMessageTexts().some((t) => /repeated the identical line/.test(t))).toBe(false);
    expect(strikes('final_line_repeat_break')).toHaveLength(0);
    // 2c98b460 (2026-09-22): the incident line NAMES get_chat_messages while
    // todo_create SUCCEEDS — the success-side wrong-tool guard arms its ONE
    // re-anchor steer at the 3rd mismatched success (a steer, never a
    // withhold at this length). The line-repeat tracker itself stays silent.
    expect(strikes('tool_derail_reanchor')).toHaveLength(1);
    expect(strikes('tool_derail_break').filter((m) => m.meta.shape === 'success_intent')).toHaveLength(0);
    expect(result.parts.filter((p: any) => p.marker === 'guard')).toHaveLength(1);
    expect(result.finalText).toContain('findings synthesized');
    expect(result.finalText).not.toContain('[HARNESS] Run ended');
    expect(mockEnqueueDerailRescue).not.toHaveBeenCalled();
  });

  it('VARIED-LINES FP GUARD: ordinary varied prose with tool calls never records a final_line_repeat_break metric', async () => {
    const proseTurn = (n: number, line1: string, line2: string) => ({
      content: `${line1}\n${line2}`,
      reasoning: '',
      toolCalls: [{ id: `v${n}`, name: 'todo_create', arguments: JSON.stringify({ goalId: 'g1', title: `varied-task-${WORDS[n - 1]}` }) }],
      finishReason: 'tool_calls',
    });
    mockRunModelTurn
      .mockResolvedValueOnce(proseTurn(1,
        'Pulling the firing-256 transcript for the adjudicating lane first.',
        'The initial pull covers the whole ticket-batch window end to end.'))
      .mockResolvedValueOnce(proseTurn(2,
        'Cross-checking the second transcript against the first pull now.',
        'Two mismatched rows surfaced; both trace back to the batch window.'))
      .mockResolvedValueOnce(proseTurn(3,
        'Filing the reconciled findings under the mandated goal next.',
        'The board entry cites each transcript receipt it was built from.'))
      .mockResolvedValueOnce(proseTurn(4,
        'Wrapping up: the reconciliation summary is ready for the finale.',
        'Every cited receipt above comes from this run, nothing from memory.'))
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput());

    expect(execsOf('todo_create')).toHaveLength(4);
    expect(strikes('final_line_repeat_break')).toHaveLength(0);
    expect(allMessageTexts().some((t) => /repeated the identical line/.test(t))).toBe(false);
    expect(result.parts.every((p: any) => p.marker !== 'guard')).toBe(true);
  });

  it('F1 PIN (adversarial review): the warn notice lands AFTER the warn-turn batch\'s tool results — never interleaved between the assistant tool_calls record and its results', async () => {
    // F1: the pre-fix push placed a role:'user' message between the assistant
    // tool_calls record and the batch's tool results — the documented
    // provider-400 hazard (the 2026-09-08 pass-#4 incident) that the
    // transcript-repair belt then rewrote as a spurious transcript_repair
    // strike. The notice now defers past the dispatch loop.
    mockRunModelTurn
      .mockResolvedValueOnce(todoTurn(1))
      .mockResolvedValueOnce(todoTurn(2))
      .mockResolvedValueOnce(todoTurn(3))
      .mockResolvedValueOnce(todoTurn(4)) // WARN arms here; the call still dispatches
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput());

    expect(execsOf('todo_create')).toHaveLength(4);
    // The model call right AFTER the warn turn (index 4) sees the accumulated
    // history. Order invariant: every tool result of the warn-turn batch
    // precedes the user notice; the notice follows the assistant record.
    const msgs = (mockRunModelTurn.mock.calls[4]?.[1] ?? []) as any[];
    const noticeIdx = msgs.findIndex((m: any) => m?.role === 'user' && /repeated the identical line/.test(String(m?.content ?? '')));
    expect(noticeIdx).toBeGreaterThanOrEqual(0);
    const lastToolIdx = msgs.reduce((last: number, m: any, i: number) => (m?.role === 'tool' ? i : last), -1);
    expect(lastToolIdx).toBeGreaterThanOrEqual(0);
    expect(noticeIdx).toBeGreaterThan(lastToolIdx); // after EVERY tool result — no interleave
    const assistantWithCalls = msgs.findIndex((m: any) => m?.role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length > 0);
    expect(assistantWithCalls).toBeGreaterThanOrEqual(0);
    expect(noticeIdx).toBeGreaterThan(assistantWithCalls);
    expect(result.finalText).toContain('findings synthesized');
  });

  it('F2 PIN (adversarial review): a NUMBERED progress line re-stated across 6 turns does NOT accumulate — digit-fold is disabled for the run-ending cross-turn tracker', async () => {
    // F2: numbered progress narration ("Step N of 6 — running the migration
    // for shard N …") folds to one key under digit-folding while carrying real
    // per-turn information — folding the CROSS-turn tracker would false-
    // positive the run-ending guard on ordinary batch work. The tracker now
    // normalizes exactly (the incident line was verbatim-identical); the
    // in-turn probe keeps the fold.
    const stepTurn = (n: number) => ({
      content: `Step ${n} of 6 — running the migration for shard ${n} of the ledger now.`,
      reasoning: '',
      toolCalls: [{ id: `s${n}`, name: 'todo_create', arguments: JSON.stringify({ goalId: 'g1', title: `step-task-${WORDS[(n - 1) % WORDS.length]}` }) }],
      finishReason: 'tool_calls',
    });
    mockRunModelTurn
      .mockResolvedValueOnce(stepTurn(1))
      .mockResolvedValueOnce(stepTurn(2))
      .mockResolvedValueOnce(stepTurn(3))
      .mockResolvedValueOnce(stepTurn(4))
      .mockResolvedValueOnce(stepTurn(5))
      .mockResolvedValueOnce(stepTurn(6))
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput());

    expect(mockRunModelTurn).toHaveBeenCalledTimes(7); // all 6 step turns + the final answer
    expect(execsOf('todo_create')).toHaveLength(6); // every call dispatched — no warn, no break
    expect(strikes('final_line_repeat_break')).toHaveLength(0);
    expect(allMessageTexts().some((t) => /repeated the identical line/.test(t))).toBe(false);
    expect(result.parts.every((p: any) => p.marker !== 'guard')).toBe(true);
    expect(result.finalText).toContain('findings synthesized');
    expect(result.finalText).not.toContain('[HARNESS] Run ended');
    // …and the SAME six lines genuinely are the F2 shape: they collapse to one
    // key under the in-turn probe's digit-fold (count 6) but stay six distinct
    // keys under the tracker's exact normalization.
    const sixLines = Array.from({ length: 6 }, (_, i) => `Step ${i + 1} of 6 — running the migration for shard ${i + 1} of the ledger now.`).join('\n');
    expect([...longLineRepeatCounts(sixLines).values()]).toHaveLength(1);
    expect([...longLineRepeatCounts(sixLines).values()][0].count).toBe(6);
    expect(longLineRepeatCounts(sixLines, { foldDigits: false }).size).toBe(6);
  });

  describe('pure index helper (coding-model longLineRepeatCounts)', () => {
    it('counts normalized ≥40-char lines, folds digit-runs into one key, and strips fenced code', () => {
      const counts = longLineRepeatCounts(
        `${INCIDENT_LINE}\n${INCIDENT_LINE}\n` // exact repeat → 2
        + 'short line\n'                          // under the 40-char floor → ignored
        + 'Filing noop todo number 11 for the firing batch now.\n'
        + 'Filing noop todo number 22 for the firing batch now.\n' // digit-collapse → same key
        + '```\n' + INCIDENT_LINE + '\n' + INCIDENT_LINE + '\n```\n', // fenced → stripped
      );
      const byLine = [...counts.values()];
      expect(byLine.find((e) => e.line === INCIDENT_LINE)?.count).toBe(2); // fenced copies excluded
      expect(byLine.find((e) => e.line === 'Filing noop todo number 11 for the firing batch now.')?.count).toBe(2);
      expect([...counts.keys()].some((k) => k.includes('11') || k.includes('22'))).toBe(false); // digits folded to '#'
      expect(byLine.every((e) => e.line.length >= 40)).toBe(true);
      expect(byLine).toHaveLength(2);
    });
  });
});

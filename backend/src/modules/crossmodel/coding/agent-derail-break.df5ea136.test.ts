/**
 * Replay pin — ticket df5ea136 (2026-09-26, lane cec340f2 run 10d8bbd3,
 * kimi-k3, the CanLaw Path C integrator).
 *
 * THE INCIDENT: a PRODUCTIVE run (135 steps, ~50 real tool calls over 2.5 h,
 * real commit c04447f4 minted at 21:54Z) was ENDED by the 03587322 cross-turn
 * repeated-line break because each steering-folded turn re-stated the SAME
 * completed-work heading —
 *   "## 1. COMPLETE + COMMITTED: original teach leg (commit `c04447f4`)"
 * — 6× across 6 turns. The cited sha WAS a real git_commit receipt of that
 * same run (get_run_receipts: git_commit ok 21:54:29Z, ids.sha c04447f4):
 * evidenced completed-work recap under heavy mid-run steer traffic, not the
 * UNEVIDENCED intention loop the 03587322 guard exists for. (The next run in
 * the same session, 6aa38cd8, additionally tripped tool_repeat_break on
 * read_file — the model-side degeneration class is real and NEARBY, which is
 * why the break must survive in some form.)
 *
 * ADJUDICATION (141d9d92 "both" precedent): the repetition is model-emitted
 * (the tracker counts only turn.content) — detection correct — but the BREAK
 * had no receipt-cited exemption: a line citing an artifact id carried by an
 * ok:true receipt from THIS run is by the guard's own run-end contract
 * ("treat any action it announced as NOT done unless a tool receipt in this
 * run proves it") an ANNOUNCED-AND-PROVEN action.
 *
 * THE FIX PINNED HERE: at the break threshold the guard checks the repeated
 * line for a citable artifact id (sha/branch/todoId/goalId/scheduleId/
 * ticketId/chatId/sessionId — never 'url', never short numeric ids) present
 * in an ok:true receipt, prefix-tolerant ≥8 chars (M1 idiom — the incident
 * line cited the 8-char short-sha of a longer receipt sha). If cited and the
 * count is under 3× the threshold (LINE_REPEAT_RUN_EXEMPT_CAP=18), the break
 * is LIFTED for that line: ONE 'receipt_cited_exempt' GUARD_STRIKE (state,
 * count, turns, line) + ONE in-band notice on tool-calling turns (annotated
 * line — "stop restating completed work"), and the run continues. The break
 * still fires at ≥18: degeneration no receipt can excuse.
 *
 * REPLAY NOTE: the incident's receipt was a git_commit sha, but the chat test
 * profile does not OFFER git_commit (the tool-preflight refuses unoffered
 * tools before execution, so no receipt would mint). The replay therefore
 * mints its receipt via todo_create — an offered RECEIPT_TOOLS member whose
 * ok result shape ("Created todo <uuid>") extractReceipt parses — and the
 * repeated line cites that receipt's todoId by its 8-char prefix, the same
 * short-cite shape as the incident's short-sha.
 *
 * Three replays:
 *   1. INCIDENT: line ×1/turn across 6 turns, receipt minted on turn 1 (the
 *      real shape) → run SURVIVES past 6, exempt strike recorded, in-band
 *      note delivered, final answer delivered.
 *   2. CAP: the same line ×2/turn across 9 turns (the double-emission shape
 *      run 6aa38cd8 showed verbatim) → count 18 ≥ cap → run ENDS with the
 *      standard honest note ("repeated 18× across 9 turns").
 *   3. HOLE-CLOSER: a line citing an id NO receipt backs (the adversarial
 *      dodge — a model inventing an id to lift its own break) → the break
 *      fires at 6 exactly as before, no exempt strike.
 *
 * Scaffold mirrors agent-derail-break.03587322.test.ts (same mock set).
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

const mockExecuteCodingTool: jest.Mock = jest.fn();
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
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
jest.mock('./container.service', () => ({
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({
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

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// ── The incident's repeated line, replay shape: cites the 8-char PREFIX of a
// receipt-backed artifact id minted by THIS run (the real incident cited the
// 8-char short-sha `c04447f4` of a 40-char git_commit receipt sha). Names
// todo_create — the tool every turn actually calls — so the success-side
// intent matcher acquits (names the called tool). 73 chars ≥ the 40-char
// floor; digit-bearing (foldDigits:false keeps the verbatim key).
const INCIDENT_LINE = '## 1. COMPLETE + COMMITTED: original teach leg (todo_create `df5ea136`)';
// The receipt id the line's 8-char cite prefixes (a todo_create ok receipt —
// see the REPLAY NOTE above for why not git_commit).
const RECEIPT_TODO_ID = 'df5ea136-0000-4000-8000-000000000001';
// The adversarial dodge: an id-shaped token NO receipt backs.
const FABRICATED_LINE = '## 1. COMPLETE + COMMITTED: original teach leg (todo_create `deadbeef99`)';

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

const mockEmit: jest.Mock = jest.fn();

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-df5ea136-test',
  sessionId: 'sess-df5ea136',
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
  userMessage: '[df5ea136 replay] Continue the terminal close under goal g1 — restate completed work once, then finish.',
  emit: mockEmit,
});

/** A turn restating the incident line `copies` times plus varied sub-floor
 *  filler, calling todo_create once (word-varied titles — the house idiom
 *  that keeps the 54a172ac near-identical leg blind). The mocked dispatch
 *  result mints the ok:true todoId receipt (TODO_CREATE_OK_RE shape). */
const lineTurn = (n: number, copies = 1) => ({
  content: Array(copies).fill(INCIDENT_LINE).join('\n') + `\n(noop filing ${WORDS[(n - 1) % WORDS.length]})`,
  reasoning: '',
  toolCalls: [{ id: `t${n}`, name: 'todo_create', arguments: JSON.stringify({ goalId: 'g1', title: `noop-df5ea136-${WORDS[(n - 1) % WORDS.length]}` }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Terminal close finished; findings synthesized from the receipts above.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** GUARD_STRIKE loop metrics recorded with one meta.seam. */
const strikes = (seam: string) =>
  mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m: any) => m?.meta?.seam === seam);
/** Executed dispatches of one tool (executeCodingTool(ctx, name, args)). */
const execsOf = (name: string) => mockExecuteCodingTool.mock.calls.filter((c) => c[1] === name);
/** Message contents handed to ONE model call (the list is cumulative — a
 *  pushed notice reappears in every LATER call, so "pushed exactly once"
 *  assertions read a single call's list). */
const messageTextsOf = (callIdx: number): string[] =>
  ((mockRunModelTurn.mock.calls[callIdx]?.[1] ?? []) as any[])
    .map((m: any) => (typeof m?.content === 'string' ? m.content : ''))
    .filter(Boolean);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  // todo_create dispatches return the TODO_CREATE_OK_RE shape, so the first
  // execution mints the ok:true {todoId} receipt the incident line cites —
  // the same receipt-minting path the real run's git_commit used.
  mockExecuteCodingTool.mockImplementation(async (_ctx: any, name: string) =>
    name === 'todo_create' ? `Created todo ${RECEIPT_TODO_ID}` : 'probe result: ok');
});

describe('ticket df5ea136 — receipt-cited repeated-line exemption: evidenced completed-work recap must not end a productive run', () => {
  it('INCIDENT REPLAY: the line citing THIS run\'s receipt id (8-char prefix) repeated 6× across 6 turns — exempt strike + in-band note, the run SURVIVES and delivers the final', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(lineTurn(1))      // count 1 — the todo_create dispatch mints the receipt
      .mockResolvedValueOnce(lineTurn(2))      // count 2
      .mockResolvedValueOnce(lineTurn(3))      // count 3
      .mockResolvedValueOnce(lineTurn(4))      // count 4 → WARN (standard, still fires)
      .mockResolvedValueOnce(lineTurn(5))      // count 5
      .mockResolvedValueOnce(lineTurn(6))      // count 6 → break threshold: RECEIPT-CITED → exempt, run continues
      .mockResolvedValue(FINAL);               // the final the killed incident run never got to deliver

    const result = await runCodingAgent(makeInput());

    // (a) The run survived: no line-repeat run-end, the final answer delivered.
    expect(result.finalText).toContain('findings synthesized');
    expect(result.finalText).not.toContain('[HARNESS] Run ended: the identical narration line');
    // (b) The receipt-cited artifact really executed: every turn's todo_create
    // dispatched (the exempted 6th turn included — a lift, not a withhold).
    expect(execsOf('todo_create')).toHaveLength(6);
    // (c) Telemetry: exactly ONE receipt_cited_exempt strike at count 6/turns 6
    // carrying the incident line; NO ended_run on the seam.
    const lr = strikes('final_line_repeat_break');
    const exempt = lr.filter((m: any) => m.meta.state === 'receipt_cited_exempt');
    expect(exempt).toHaveLength(1);
    expect(exempt[0].meta).toMatchObject({ count: 6, turns: 6, line: INCIDENT_LINE });
    expect(lr.filter((m: any) => m.meta.state === 'ended_run')).toHaveLength(0);
    // The standard warn (count 4) still fired — detection is untouched.
    expect(lr.some((m: any) => m.meta.state === 'warned' && m.meta.count === 4 && m.meta.turns === 4)).toBe(true);
    // (d) The ONE in-band exempt note rode into the model context after turn 6
    // (call index 6 = the FINAL turn's request) and names the receipt grounding.
    const exemptNotices = messageTextsOf(6).filter((t) => t.includes('receipt-backed artifact id'));
    expect(exemptNotices).toHaveLength(1);
    expect(exemptNotices[0]).toContain(INCIDENT_LINE.slice(0, 40));
    expect(exemptNotices[0]).toMatch(/6 times across 6 turns/);
    // (e) No derail-rescue, no narration_repeat filing — nothing ended.
    expect(mockEnqueueDerailRescue).not.toHaveBeenCalled();
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    expect(filings.find((f: any) => f.tool === 'final_text')).toBeUndefined();
  });

  it('CAP: the same receipt-cited line at 18 copies (the double-emission shape run 6aa38cd8 showed verbatim — ×2/turn across 9 turns) still ENDS the run', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(lineTurn(1, 2))   // count 2  — receipt minted on the dispatch
      .mockResolvedValueOnce(lineTurn(2, 2))   // count 4  → WARN
      .mockResolvedValueOnce(lineTurn(3, 2))   // count 6  → exempt (one strike)
      .mockResolvedValueOnce(lineTurn(4, 2))   // count 8  → still exempt, no re-strike
      .mockResolvedValueOnce(lineTurn(5, 2))   // count 10
      .mockResolvedValueOnce(lineTurn(6, 2))   // count 12
      .mockResolvedValueOnce(lineTurn(7, 2))   // count 14
      .mockResolvedValueOnce(lineTurn(8, 2))   // count 16
      .mockResolvedValueOnce(lineTurn(9, 2))   // count 18 ≥ cap 18 → BREAK (before this turn's call dispatches)
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput());

    expect(result.finalText).toContain('[HARNESS] Run ended: the identical narration line was repeated 18×');
    expect(result.finalText).toContain('across 9 turns of this run');
    const lr = strikes('final_line_repeat_break');
    // Exactly ONE exempt strike (count 6/turns 3) then the terminal break.
    const exempt = lr.filter((m: any) => m.meta.state === 'receipt_cited_exempt');
    expect(exempt).toHaveLength(1);
    expect(exempt[0].meta).toMatchObject({ count: 6, turns: 3 });
    const ended = lr.filter((m: any) => m.meta.state === 'ended_run');
    expect(ended).toHaveLength(1);
    expect(ended[0].meta).toMatchObject({ count: 18, turns: 9 });
    // Run-end parity seams fired for the terminal break.
    expect(mockEnqueueDerailRescue).toHaveBeenCalledTimes(1);
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const ev = filings.find((f: any) => f.tool === 'final_text');
    expect(ev).toBeDefined();
    expect(ev.shape).toBe('narration_repeat');
    expect(ev.repeats).toBe(18);
  });

  it('HOLE-CLOSER: a line citing an id NO receipt backs (the fabricated-citation dodge) breaks at 6 exactly as before', async () => {
    const fabTurn = (n: number) => ({
      content: `${FABRICATED_LINE}\n(noop filing ${WORDS[(n - 1) % WORDS.length]})`,
      reasoning: '',
      toolCalls: [{ id: `t${n}`, name: 'todo_create', arguments: JSON.stringify({ goalId: 'g1', title: `noop-df5ea136-fab-${WORDS[(n - 1) % WORDS.length]}` }) }],
      finishReason: 'tool_calls',
    });
    mockRunModelTurn
      .mockResolvedValueOnce(fabTurn(1))  // count 1
      .mockResolvedValueOnce(fabTurn(2))  // count 2
      .mockResolvedValueOnce(fabTurn(3))  // count 3
      .mockResolvedValueOnce(fabTurn(4))  // count 4 → WARN
      .mockResolvedValueOnce(fabTurn(5))  // count 5
      .mockResolvedValueOnce(fabTurn(6))  // count 6 → deadbeef99 matches NO ok receipt → BREAK
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput());

    expect(result.finalText).toContain('[HARNESS] Run ended: the identical narration line was repeated 6×');
    const lr = strikes('final_line_repeat_break');
    expect(lr.filter((m: any) => m.meta.state === 'receipt_cited_exempt')).toHaveLength(0);
    expect(lr.some((m: any) => m.meta.state === 'ended_run' && m.meta.count === 6 && m.meta.turns === 6)).toBe(true);
    expect(mockEnqueueDerailRescue).toHaveBeenCalledTimes(1);
  });
});

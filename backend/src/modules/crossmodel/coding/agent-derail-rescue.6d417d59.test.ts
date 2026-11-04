/**
 * Refutation pin — ticket 6d417d59 (bug_report, priority 3, filed 2026-09-21
 * by the fleet supervisor): "Wrong-tool derailments defeat derail-RESCUE
 * continuation runs — post-#898 protection doesn't cover continuations".
 *
 * THE INCIDENT (tt-rd lane ddd26be0, kimi-k3, 2026-09-21): firing-105 (run
 * 0e81392f, triggerKind schedule) derailed to terminal at 07:26:28Z (trips 3,
 * tools [update_feedback, update_schedule], intended run_command) and the
 * harness enqueued derail-rescue #1 of 2. Rescue-1 (run efa65398, triggerKind
 * hook — the continuation path itself) derailed to terminal at 07:46:46Z
 * (trips 2, tools [update_feedback, verify_durable], intended read_file) and
 * the harness enqueued rescue #2 of 2 (07:46:47Z). The 24h budget is spent.
 *
 * THE CLAIM: the #898/ff1fa1b5 scaffold "doesn't cover continuations" — a
 * rescue run that derails is left unprotected.
 *
 * ADJUDICATION (guard_strike telemetry, 24h window, chat ddd26be0 — read
 * fresh 2026-09-21T08:06Z): REFUTED. Inside the rescue-1 continuation run
 * the FULL guard chain fired, origin-agnostic:
 *   07:45:25 tool_preflight update_feedback ungrounded_id (intended verify)
 *   07:45:27 tool_derail_reanchor update_feedback intent_mismatch — the
 *             re-anchor steer fires INSIDE a continuation run
 *   07:45:29 tool_derail_break update_feedback (perma:false)
 *   07:46:17 tool_repeat_break verify trips:1
 *   07:46:46 tool_derail_break state:ended_run tools [update_feedback,
 *             verify_durable] trips:2 intended read_file — honest terminal
 *   07:46:46 tool_derail_rescue state:continuation_enqueued count:2 max:2 —
 *             the rescue CHAINS: a rescue run's own terminal derail enqueues
 *             the next continuation (rescue-2, run 86b94440, fired 07:46:47Z)
 * What the class exhausts is the DESIGNED recovery budget — derail-rescue.ts
 * BOUNDS: "at most DERAIL_RESCUE_MAX_PER_DAY (default 2) continuations per
 * chat per 24 h … a chain of derailing rescues dies after two, and the
 * breaker path stays terminal exactly as before". The budget is the
 * anti-loop fuse, not a coverage hole. (Supervisor cross-check 08:09Z
 * corroborated: "a BOUNDED budget, not an unprotected path … the ONE
 * residual unpinned shape: CHAIN-DEATH — rescue-2 also derails, terminal
 * stands at 2/2 with no further auto-wake".) Design levers (fallback-model
 * rescue / per-class budget) are routed to the shortfall-hunt tally (todo
 * d14e0d2d), measure-first — they are not defects.
 *
 * These tests pin the two shapes the incident raised, so the refutation is
 * durable:
 *   1. CHAIN — a run whose firing message IS the rendered rescue wake (the
 *      hook-origin continuation) gets the SAME full chain: re-anchor steer
 *      fires in it, the breaker ends it honestly byte-identically, and its
 *      terminal derail enqueues rescue #2 whose prompt carries the
 *      SPENT-budget warning verbatim.
 *   2. CHAIN-DEATH — when the budget is already at 2/2, a continuation run
 *      that derails to terminal gets the breaker ladder (re-anchor STILL
 *      fires — protection is independent of the budget) but NO third wake,
 *      NO rescue metric/part, NO budget stamp: the fuse holds and the
 *      terminal end stands alone (manual steer / next firing only).
 *   3. UNIT — renderDerailRescueWake's count>=max branch carries the exact
 *      SPENT-budget warning rescue-2 received live.
 *
 * Scaffold mirrors agent-derail-rescue.ff1fa1b5.test.ts (same mock set).
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
const mockRedisGet: jest.Mock = jest.fn(async () => null);
const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: (...a: any[]) => mockRedisGet(...a), set: (...a: any[]) => mockRedisSet(...a), del: (...a: any[]) => mockRedisDel(...a) },
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

const EVIDENCE_REQUIRED = (ticketId: string) => JSON.stringify({
  ok: false,
  tool: 'update_feedback',
  reason: 'evidence_required',
  ticketId,
  message: `This machine-triggered run may NOT mutate feedback ticket ${ticketId.slice(0, 8)}: the ticket is not dispatched to this session (its context.dispatchedTo names another session) and no verifiable evidence was supplied.`,
}, null, 1);
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, name: string, args: any) => {
  if (name === 'update_feedback') return EVIDENCE_REQUIRED(String(args?.id ?? ''));
  return 'probe result: ok';
});
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const UD_ENVELOPE = (id: string) =>
  `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
const mockToolCacheExec: jest.Mock = jest.fn(async (name: string, args: any) => {
  if (name === 'update_document' || name === 'read_document' || name === 'fill_pdf_form') {
    const id = String(args?.fileId ?? args?.documentId ?? '');
    return UD_ENVELOPE(id);
  }
  if (name === 'update_feedback') return EVIDENCE_REQUIRED(String(args?.id ?? ''));
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

/** The continuation-wake boundary: derail-rescue.ts dynamically imports
 *  enqueueDirectWake from the hook outbox module — intercepted here. */
const mockEnqueueDirectWake: jest.Mock = jest.fn(async () => ({ ok: true, hookEventId: 'evt-rescue-2' }));
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
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
import { renderDerailRescueWake } from './derail-rescue';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const SESSION = 'sess-6d417d59';
const BUDGET_KEY = `derail-rescue:${SESSION}`;
const GOAL_HINT = 'Firing-105: execute the fold-doc Firing-105 queue head (MOE-PREFILL-3 sparse-grouped v2), with soak/bench guards.';

/** The wake that FIRED the continuation run under test — rescue #1's prompt,
 *  exactly as enqueued at firing-105's terminal derail (the live incident's
 *  tools/intended, from the 07:26:28Z guard rows). */
const RESCUE_WAKE_1 = renderDerailRescueWake(
  { sessionId: SESSION, runId: '0e81392f-1111-2222-3333-444444444444', tools: ['update_feedback', 'update_schedule'], intended: 'run_command', trips: 3, goalHint: GOAL_HINT, userTurnAt: undefined },
  1, 2,
);
/** The wake rescue-2 actually received (07:46:47Z) — the SPENT-budget one. */
const RESCUE_WAKE_2 = renderDerailRescueWake(
  { sessionId: SESSION, runId: 'efa65398-1111-2222-3333-444444444444', tools: ['update_feedback', 'verify_durable'], intended: 'read_file', trips: 2, goalHint: GOAL_HINT, userTurnAt: undefined },
  2, 2,
);

const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree: '/tmp/derail-6d417d59-test',
  sessionId: SESSION,
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: RESCUE_WAKE_1, // the continuation run's firing message IS the rescue wake
  emit: jest.fn(),
  ...over,
});

/** Same wrong-tool derail drive as the ff1fa1b5 incident replay (the chain is
 *  tool-agnostic): update_feedback placeholder against a closed ticket while
 *  the narration announces shell work, then an update_document placeholder
 *  leg — trips {update_feedback:2, update_document:1} → terminal, intended
 *  run_command. */
const CLOSED_TICKET = 'd0597e02';
const ufTurn = (n: number) => ({
  content: '',
  reasoning: 'Shell first: run_command "git fetch origin --prune && git ls-remote origin main" — the sweep starts now.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: CLOSED_TICKET, status: 'done', adminNote: 'recheck' }) }],
  finishReason: 'tool_calls',
});
const udTurn = (n: number, id: string) => ({
  content: '',
  reasoning: `run_command cannot touch the digest — refresh the generated file ${id} with the census figures now.`,
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: id, content: 'reconciled digest' }) }],
  finishReason: 'tool_calls',
});
const planTurn = (n: number) => ({
  content: '',
  reasoning: 'Re-reading the plan before the next probe.',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: 'setup', status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Checklist done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const driveToTerminalDerail = () => {
  mockRunModelTurn
    .mockResolvedValueOnce(ufTurn(1)) // re-anchor steer HERE (count 2)
    .mockResolvedValueOnce(ufTurn(2)) // count 4 ⇒ TRIP 1 (one-round ban)
    .mockResolvedValueOnce(planTurn(3)) // ban round — harmless success
    .mockResolvedValueOnce(ufTurn(4)) // count 2
    .mockResolvedValueOnce(ufTurn(5)) // count 4 ⇒ TRIP 2 (perma on update_feedback)
    .mockResolvedValueOnce(udTurn(6, CLOSED_TICKET)) // count 2
    .mockResolvedValueOnce(udTurn(7, 'noop')) // count 4 ⇒ TRIP 3 ⇒ TERMINAL
    .mockResolvedValue(FINAL);
};

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');
const rescueMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_rescue');
const rescueParts = (result: any) => (result.parts as any[]).filter(
  (p) => p?.type === 'text' && typeof p.text === 'string' && p.text.startsWith('[HARNESS] Derail-rescue:'),
);
const reanchorParts = (result: any) => (result.parts as any[]).filter(
  (p) => p?.type === 'text' && typeof p.text === 'string' && p.text.startsWith('[HARNESS] Re-anchor steer injected'),
);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  delete process.env.DERAIL_RESCUE_MAX_PER_DAY;
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockEnqueueDirectWake.mockResolvedValue({ ok: true, hookEventId: 'evt-rescue-2' });
});

describe('ticket 6d417d59 — derail-rescue continuations ARE covered: chain + chain-death refutation pins', () => {
  it('CHAIN: a continuation run (fired by the rescue wake) gets the FULL guard chain — re-anchor fires in it, the breaker ends it honestly, and its terminal derail enqueues rescue #2 with the SPENT-budget warning', async () => {
    // One rescue already spent today (firing-105's terminal enqueued #1).
    mockRedisGet.mockImplementation(async (k: string) => (k === BUDGET_KEY ? '1' : null));
    driveToTerminalDerail();
    const result = await runCodingAgent(makeInput()); // userMessage = RESCUE_WAKE_1

    // (a) The re-anchor steer fires INSIDE the continuation run — origin-agnostic.
    expect(reanchorParts(result).length).toBeGreaterThanOrEqual(1);
    expect(reanchorParts(result)[0].text).toContain('wrong-tool signature on update_feedback');
    expect(reanchorParts(result)[0].text).toContain('reasoning named run_command');
    expect(reanchorMetrics().length).toBeGreaterThanOrEqual(1);

    // (b) The breaker terminal end is byte-identical (the ended_run record is untouched).
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes');
    expect(result.finalText).toContain('intended tool appears to be run_command');
    expect(breakerMetrics().find((m) => m.meta.state === 'ended_run')).toBeDefined();

    // (c) The rescue CHAINS: this continuation run's own terminal derail
    // enqueues rescue #2 — the exact live shape (07:46:46Z, count:2 max:2).
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    const wake = mockEnqueueDirectWake.mock.calls[0][0];
    expect(wake.targetChatId).toBe(SESSION);
    expect(wake.prompt).toContain('[DERAIL RESCUE — harness continuation, not typed by the user]');
    expect(wake.prompt).toContain('trying to call run_command when it derailed');
    expect(wake.prompt).toContain('looping tool(s): update_feedback, update_document');
    expect(wake.prompt).toContain('#2 of at most 2');
    expect(wake.prompt).toContain('the budget is now SPENT');
    expect(wake.prompt).toContain('NO further automatic continuation fires');
    expect(wake.meta).toMatchObject({ origin: 'derail-rescue', kind: 'derail_rescue', intended: 'run_command', rescueCount: 2, rescueMax: 2, trips: 3 });
    expect(wake.meta.tools).toEqual(['update_feedback', 'update_document']);

    // (d) Attribution mirrors the live telemetry triple (reanchor → ended_run
    // → continuation_enqueued), and the budget stamps the real enqueue.
    expect(rescueParts(result)).toHaveLength(1);
    expect(rescueParts(result)[0].text).toContain('rescue #2 of at most 2 in 24 h');
    expect(rescueMetrics()).toHaveLength(1);
    expect(rescueMetrics()[0].meta).toMatchObject({
      state: 'continuation_enqueued', tool: 'update_document', intended: 'run_command', trips: 3, count: 2, max: 2,
    });
    expect(mockRedisSet).toHaveBeenCalledWith(BUDGET_KEY, '2', { EX: 24 * 3600 });
  });

  it('CHAIN-DEATH: at 2/2 a continuation run that derails to terminal still gets the breaker ladder (re-anchor fires) but NO third wake, NO rescue record, NO budget stamp — the fuse holds, terminal stands alone', async () => {
    // Budget spent (rescue-1's terminal enqueued #2 — the live 07:46:46Z stamp).
    mockRedisGet.mockImplementation(async (k: string) => (k === BUDGET_KEY ? '2' : null));
    driveToTerminalDerail();
    const result = await runCodingAgent(makeInput({ userMessage: RESCUE_WAKE_2 }));

    // Containment is INDEPENDENT of the rescue budget: re-anchor + honest end.
    expect(reanchorParts(result).length).toBeGreaterThanOrEqual(1);
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment');
    expect(breakerMetrics().find((m) => m.meta.state === 'ended_run')).toBeDefined();

    // The fuse: NO third continuation, no rescue guard part/metric, no stamp.
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(rescueMetrics()).toHaveLength(0);
    expect(rescueParts(result)).toHaveLength(0);
    expect(mockRedisSet).not.toHaveBeenCalledWith(BUDGET_KEY, expect.anything(), expect.anything());
  });

  it('UNIT: the count>=max wake branch carries the SPENT-budget warning verbatim (the exact line rescue-2 received live at 07:46:47Z)', () => {
    expect(RESCUE_WAKE_2).toContain(
      'This is derail-rescue continuation #2 of at most 2 for this chat in 24 h — the budget is now SPENT: if this run also derails to terminal, NO further automatic continuation fires (the breaker ends it and a supervisor must steer).',
    );
    expect(RESCUE_WAKE_2).toContain('looping tool(s): update_feedback, verify_durable');
    expect(RESCUE_WAKE_2).toContain('trying to call read_file when it derailed');
    // …and the pre-spend branch names the remaining budget instead.
    expect(RESCUE_WAKE_1).toContain('continuation #1 of at most 2 for this chat in 24 h — if this run also derails to terminal, the harness may fire one more continuation (1 left in the 24 h budget)');
  });
});

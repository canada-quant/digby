/**
 * REPLAY PIN — ticket c8c7fd41 (mishap, 2026-10-21T17:48:38.734Z): "3×
 * tool-failure streak: todo_update on 'cql-agx-orin64 Supervisor · hook:
 * lane b' — framework or model?" Auto-filed at breaker trip (owner doctrine
 * 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE INCIDENT (session e03452f4-7f79-4a47-a95c-fb10a8873d47 — the
 * cql-agx-orin64 project supervisor, machine hook wake "lane b", 17:44–17:48Z
 * Oct 21): THREE consecutive todo_update refusals, all the IDENTICAL text —
 * "blockedReason can only be set on a blocked todo (current status:
 * 'pending'). Pass status:'blocked' to block it first." — with args
 * {"assigneeChatId":"b4d89c80","blockKind":"deps","blockedReason":"Owner gate
 * oq_ef3c35c8 ANSWERED 17:44Z — no owner decision pending. Blocked on dep
 * 3/6 (23bedd3d serve leg)…"}. A PLAIN 3-count trip: three real failure
 * texts in the filing, no intent-mismatch fast-trip line — the contrast
 * class to 596718e7's weighted 2-text "3×".
 *
 * THE VERDICT (this lane, 2026-10-22, evidence-led): MODEL BEHAVIOR — no
 * deterministic framework defect. The guard is long-standing (f902cc066,
 * PR #186, 2026-08-10; git log -S over the exact string: only that commit)
 * and correct against the args given: the todo (ac53362b, memory-budget row
 * of goal 4f6ceb83) was PENDING at 17:48Z, so a reason-only update must
 * apply-or-reject, and it rejected with the exact text and the truthful
 * remedy. The reason's content was TRUE (owner gate oq_ef3c35c8 was ANSWERED
 * — re-verified live this run — and the row was genuinely waiting on dep
 * 23bedd3d); the model omitted status:'blocked' on all three calls.
 *
 * Self-heal is receipt-proven: the same session's next todo_update receipts
 * are ALL ok — 8d558a7 18:44:09Z, 92c217c9 18:49:21Z (the row's blockedAt
 * 18:49:21.151Z matches this receipt), c165042e 19:36:02Z. The row now
 * reads status 'blocked', blockKind 'external', accurate reason. No
 * perma-withhold, no run-end; the supervisor kept working (steers,
 * schedules, supervisor-state writes through 00:07Z Oct 22).
 *
 * THIS PIN replays the incident's exact shape against the REAL agent loop
 * (coding profile, machineTriggered — the wild wake's shape) and asserts:
 * the verbatim guard text is failure-shaped; the plain 3-count trip fires at
 * the THIRD failure with exactly the THREE real texts (newest first) and the
 * ticket's args order filed; todo_update is withheld for exactly ONE round
 * (absent from that round's schema) and returns; the recovery-shape call
 * succeeds; the run completes clean — one filing, one trip metric, one
 * steer, no perma, no run-end.
 *
 * The guard contract itself (refusal on a PENDING row + the recovery
 * shapes) is pinned store-side in goals.service.c8c7fd41.test.ts — not
 * duplicated here.
 *
 * Scaffold mirrors agent-derail-break.596718e7.test.ts (same mock set).
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
  buildChatWakeClockNote: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
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

/** CODING profile + machineTriggered — the wild supervisor's wake shape. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim ids (ticket c8c7fd41 + live reads this run) ──────
const MEM_TODO = 'ac53362b-ba1f-46e3-b645-44633216e9bf'; // "2/6 Re-verify memory budget…" — PENDING at 17:48Z, the failing target
const SERVE_TODO = '23bedd3d-2fef-4d31-8f2c-3eb33ed0f323'; // "3/6 Serve 4B helper…" — the dependency named in the reason

/** The board brief the supervisor was working (machine hook wake "lane b"
 *  shape, quoting the row ids verbatim — the grounding haystack). */
const BRIEF = [
  '[FLEET GOAL BOARD — todos unblocked to this chat]',
  `Todo "2/6 Re-verify memory budget fresh on-box" (${MEM_TODO}) is yours; dep 3/6 serve leg ${SERVE_TODO} gates the ladder.`,
  `Owner gate oq_ef3c35c8 was ANSWERED 17:44Z — record the block state and steer lane b4d89c80.`,
].join('\n');

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-c8c7fd41-test',
  sessionId: 'sess-c8c7fd41',
  runId: 'run-c8c7fd41',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.3',
  projectName: 'cql-agx-orin64',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  machineTriggered: true,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: BRIEF,
  emit: jest.fn(),
});

// ── The incident's verbatim failure text (ticket c8c7fd41, executor shape) ───
const FAIL_400 =
  "Tool todo_update failed: blockedReason can only be set on a blocked todo (current status: 'pending'). " +
  "Pass status:'blocked' to block it first.";

/** The incident's verbatim call-arg head (ticket "Call args", newest first). */
const REASON_ARG =
  'Owner gate oq_ef3c35c8 ANSWERED 17:44Z — no owner decision pending. Blocked on dep 3/6 (23bedd3d serve leg): bench Orin vs mbp-2 (tok/s';

// ── The incident's turns (receipts of session e03452f4, 17:44–17:48Z window) ─
const okTurn = {
  content: 'Board check: reading the ladder state before recording the block.',
  reasoning: 'Confirming the memory-budget row and its serve dep before writing.',
  toolCalls: [
    { id: 't1', name: 'todo_get', arguments: JSON.stringify({ todoId: MEM_TODO }) },
    { id: 't2', name: 'get_chat_status', arguments: JSON.stringify({ chatId: 'b4d89c80-763b-482e-abf2-0f2f49b3f25f' }) },
  ],
  finishReason: 'tool_calls' as const,
};
/** The three failing calls, spread over two turns as in the wild (17:44–17:48Z):
 *  one call, then a two-call batch — the withhold applies to the next round's
 *  schema, never the in-flight batch (the 304ff1bb contract). */
const fail1Turn = {
  content: 'The owner gate is answered; recording the block with the dep reason now.',
  reasoning: 'No owner decision is pending, so the row is blocked on the serve leg — writing the reason.',
  toolCalls: [{ id: 't3', name: 'todo_update', arguments: JSON.stringify({ todoId: MEM_TODO, assigneeChatId: 'b4d89c80', blockKind: 'deps', blockedReason: REASON_ARG }) }],
  finishReason: 'tool_calls' as const,
};
const failBatchTurn = {
  content: 'Re-sending the block reason with the fuller context; the gate is answered, this is a dep hold.',
  reasoning: 'The reason was refused as reason-only; re-sending it with assignee and blockKind spelled out.',
  toolCalls: [
    { id: 't4', name: 'todo_update', arguments: JSON.stringify({ todoId: MEM_TODO, assigneeChatId: 'b4d89c80', blockKind: 'deps', blockedReason: `${REASON_ARG} (re-send with the fuller context.)` }) },
    { id: 't5', name: 'todo_update', arguments: JSON.stringify({ todoId: MEM_TODO, assigneeChatId: 'b4d89c80', blockKind: 'deps', blockedReason: REASON_ARG }) },
  ],
  finishReason: 'tool_calls' as const,
};
/** The withhold round: no todo_update receipts exist between 17:48Z and
 *  18:44Z in the wild — the lane did NOT burn a not-offered refusal; it
 *  worked another offered tool while todo_update sat out its one round. */
const withholdRoundTurn = {
  content: 'The row tool sits out this round; steering the lane directly while the hold clears.',
  reasoning: 'todo_update is out for one round; sending the steer to lane b4d89c80 meanwhile.',
  toolCalls: [{ id: 't6', name: 'send_chat_message', arguments: JSON.stringify({ chatId: 'b4d89c80-763b-482e-abf2-0f2f49b3f25f', content: 'AGX exec is closed both ways; hold the serve leg.' }) }],
  finishReason: 'tool_calls' as const,
};
/** The 18:49:21Z recovery (receipt 92c217c9, ok): the correctly-shaped block
 *  write — status:'blocked' TOGETHER with the reason (the guard text's own
 *  instruction; the store-side pin lands both fields). */
const recoveryTurn = {
  content: 'Back on offer — blocking the row properly now, with the status and the reason together.',
  reasoning: 'The row tool is back; blocking the memory-budget row with the live reason as the guard instructed.',
  toolCalls: [{ id: 't7', name: 'todo_update', arguments: JSON.stringify({ todoId: MEM_TODO, status: 'blocked', blockKind: 'external', blockedReason: 'Exec closed both ways: tailnet-SSH policy-refused, amd-1 LAN pubkey-only.' }) }],
  finishReason: 'tool_calls' as const,
};
const FINAL = { content: 'State landed: the row is blocked with a live reason; the ladder holds. Supervisor report posted.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

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

describe('ticket c8c7fd41 — plain 3× identical-text trip on todo_update guard refusals: guard correct, containment worked, model behavior', () => {
  it('UNIT: the verbatim guard text is failure-shaped (the executor wrapper) — the breaker counts it; a success is not', () => {
    expect(looksLikeToolFailure(FAIL_400)).toBe(true);
    expect(looksLikeToolFailure('{"ok":true}')).toBe(false);
  });

  it('REPLAY the incident: trip at the THIRD failure (plain 3-count), exactly the THREE real texts + the ticket args order filed — one filing, one steer, one-round withhold, recovery succeeds, run completes clean', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce('{"ok":true}') // t1 ok
      .mockResolvedValueOnce('{"ok":true}') // t2 ok
      .mockResolvedValueOnce(FAIL_400)      // t3 — call 1: count 1
      .mockResolvedValueOnce(FAIL_400)      // t4 — call 2: count 2
      .mockResolvedValueOnce(FAIL_400);     // t5 — call 3: count 3 → TRIP
    mockRunModelTurn
      .mockResolvedValueOnce(okTurn)          // the board check
      .mockResolvedValueOnce(fail1Turn)       // 17:44Z — call 1
      .mockResolvedValueOnce(failBatchTurn)   // 17:46–17:48Z — calls 2+3
      .mockResolvedValueOnce(withholdRoundTurn) // the ban round: no row-tool receipts 17:48Z→18:44Z
      .mockResolvedValueOnce(recoveryTurn)    // 18:49:21Z receipt 92c217c9 (ok)
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput());

    // The run COMPLETED clean — no perma, no run-end, no model error.
    expect(result.finalText).toContain('State landed: the row is blocked');
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended');

    // ── THE FILING: exactly ONE, with the incident's exact evidence shape ──
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('todo_update');
    expect(ev.perma).toBe(false);
    expect(ev.shape).toBe('failure');
    // The "3×" title's texts: exactly THREE, newest first — the plain-count
    // class (this incident's REAL shape), unlike 596718e7's weighted 2-text.
    expect(ev.recentFailures).toHaveLength(3);
    for (const t of ev.recentFailures) {
      expect(t).toContain("blockedReason can only be set on a blocked todo (current status: 'pending')");
      expect(t).toContain("Pass status:'blocked' to block it first.");
    }
    // DW-4 args snapshot: the ticket's verbatim arg head on all three, and
    // the 200-char MASK-THEN-CLIP bound (DW-4's exposure cap — the reason
    // text runs long, so every captured arg ends AT the clip, which is why
    // the ticket's own quoted args are truncated mid-sentence the same way).
    expect(ev.recentArgs).toHaveLength(3);
    for (const a of ev.recentArgs) {
      expect(a).toContain('"blockKind":"deps"');
      expect(a).toContain('"blockedReason":"Owner gate oq_ef3c35c8 ANSWERED 17:44Z');
      expect(a.length).toBeLessThanOrEqual(200); // the DW-4 clip contract
    }
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);

    // ── THE TRIP METRIC: one failure-shape trip, not perma ──
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta).toMatchObject({
      tool: 'todo_update', perma: false, shape: 'failure',
    });

    // ── THE STEER QUESTION: a PLAIN failure trip does NOT re-anchor — the
    //    RE-ANCHOR steer is the intent/placeholder legs' containment (the
    //    596718e7 contrast class); this incident's filing carries no intent
    //    line and the modeled narration names no other tool, so the breaker's
    //    containment for a plain 3-count trip is the NOTICE below. Pinning
    //    that distinction keeps the two legs from bleeding into each other.
    expect(reanchorMetrics()).toHaveLength(0);

    // ── THE NOTICE: the deferred DERAIL NOTICE lands after the batch — the
    //    real containment for a plain failure trip ──
    const notice = userTexts().find((t) => t.includes('Your last 3 calls of todo_update ALL FAILED'));
    expect(notice).toBeDefined();
    expect(notice).toContain('temporarily removed from your tool list for the next round');
    expect(notice).toContain('it returns the round after');

    // ── THE WITHHOLD: todo_update absent for exactly the next round, back after ──
    expect(toolsOf(2)).toContain('todo_update');
    expect(toolsOf(3)).not.toContain('todo_update');
    expect(toolsOf(4)).toContain('todo_update');

    // ── THE RECOVERY: the correctly-shaped block write succeeds (args are the
    //    parsed object at the executor — status:'blocked' WITH the reason,
    //    the guard text's own instruction) ──
    const todoDispatches = mockExecuteCodingTool.mock.calls.filter((c: any[]) => c[1] === 'todo_update');
    expect(todoDispatches.length).toBeGreaterThanOrEqual(4); // 3 refused + the recovery block
    const blockCall = todoDispatches.map((c: any[]) => c[2] as any).find((a: any) => a.status === 'blocked' && typeof a.blockedReason === 'string' && a.blockedReason.length > 0);
    expect(blockCall).toBeDefined();
    expect(blockCall.blockKind).toBe('external');
  });
});

/**
 * MISHAP REPLAY — ticket e64fd118 (2026-09-27): session cba0dfe9 run 2a009f3e
 * (Option-A lane, kimi-k3) — a PRODUCTIVE run (255 steps, 4h15m, 180+ ok
 * receipts, 15+ real run_command successes interleaved with the repeated
 * turns, live-probed agent_events) re-stated its commit-summary heading —
 *   "### Committed artifacts (branch `digby/session-cba0dfe9`)"
 * — exactly once per turn across 6 turns (21:56→22:59Z, 6 distinct text
 * events, one copy each — genuine model re-emissions, no framework
 * double-count) and the 03587322 cross-turn repeated-line break ENDED the run
 * at the 6th copy. The ticket asked: framework or model?
 *
 * ADJUDICATION ("both", df5ea136/141d9d92 precedent):
 *   - The REPETITION is model behavior — the tracker counts only turn.content
 *     and the live events show 6 distinct emissions interleaved with real work.
 *   - The BREAK was correct-by-design HERE: no ok receipt of that run backed
 *     the cited branch or the sha it restated (the commits rode raw `git` in
 *     run_command, which mints no git receipt) — by the guard's own run-end
 *     contract an unbacked recap is exactly what it must not exempt. The
 *     harness struck the 6th copy, appended the honest note, and enqueued the
 *     derail-rescue continuation (guard_markers seq 7203/7205, live-probed).
 *   - But the investigation exposed a DETERMINISTIC blind spot in the
 *     df5ea136 receipt-cited exemption: RECEIPT_CITABLE_ID_KEYS includes
 *     'branch', yet git_commit — the tool whose receipt a committed-work recap
 *     cites — parsed the branch and DISCARDED it (ids.sha only, run-receipts.ts
 *     GIT_COMMIT_OK_RE). So a recap citing the session's own branch could
 *     NEVER match the exemption when the run committed via git_commit and
 *     never pushed (the e64fd118 lane's own precedent: PR-open-pending lanes
 *     commit repeatedly, push once). git_push mints branch; git_commit now
 *     does too.
 *
 * THE FIX PINNED HERE (unit level: run-receipts.test.ts; this file is the
 * agent-level replay): git_commit minting ids.branch must let a branch-citing
 * repeated line ride the exemption exactly like the df5ea136 short-sha cite.
 * Replay: git_commit offered via input.extraTools (the chat profile does not
 * offer it — the df5ea136 replay had to mint via todo_create for that reason;
 * extraTools is the harness's own per-run offer path, agent.ts:1202/946),
 * dispatch returns real git-commit stdout "[digby/session-e64fd118 <sha>] msg"
 * so the mint path runs for real, and the repeated line cites the BRANCH.
 *
 * Three replays (df5ea136 discipline):
 *   1. INCIDENT: branch-citing heading ×1/turn across 6 turns with the
 *      git_commit receipt minted turn 1 → run SURVIVES past 6 (exempt strike
 *      + in-band note), final delivered.
 *   2. CAP: ×2/turn across 9 turns (count 18 ≥ LINE_REPEAT_RUN_EXEMPT_CAP)
 *      → run still ENDS (degeneration no receipt can excuse).
 *   3. HOLE-CLOSER: a branch-citing line whose branch matches NO receipt
 *      (fabricated branch dodge) → breaks at 6 exactly as before.
 *
 * Scaffold mirrors agent-derail-break.df5ea136.test.ts.
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

// ── The incident's verbatim repeated-line shape: the commit-summary heading
// citing the SESSION BRANCH. 57 chars ≥ the 40-char floor; stable across turns
// (exact normalization, foldDigits:false keeps the verbatim key).
const INCIDENT_LINE = '### Committed artifacts (branch `digby/session-e64fd118`)';
// The branch the receipt will mint (GIT_COMMIT_OK_RE now captures group 1).
const RECEIPT_BRANCH = 'digby/session-e64fd118';
// Real git-commit stdout shape — the mint path runs for real.
const COMMIT_STDOUT = `[${RECEIPT_BRANCH} 84fe3ae012] e64fd118 replay: land the manifest\n 2 files changed, 34 insertions(+)`;
// The adversarial dodge: a branch-shaped token NO receipt backs.
const FABRICATED_BRANCH = 'digby/session-deadbeef99';
const FABRICATED_LINE = `### Committed artifacts (branch \`${FABRICATED_BRANCH}\`)`;

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

const mockEmit: jest.Mock = jest.fn();

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-e64fd118-test',
  sessionId: 'sess-e64fd118',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: RECEIPT_BRANCH,
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: '[e64fd118 replay] Continue the Option-A landing under the session branch — commit, then finish.',
  emit: mockEmit,
  // git_commit is NOT offered by the chat profile — extraTools is the
  // harness's per-run offer path (agent.ts:1202), so the dispatch runs the
  // REAL receipt-mint path for the tool the incident line cites.
  extraTools: [{
    schema: {
      type: 'function',
      function: {
        name: 'git_commit',
        description: 'Commit staged changes (test offer).',
        parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      },
    },
    execute: async () => COMMIT_STDOUT,
  }],
});

/** A turn restating the incident line `copies` times plus varied sub-floor
 *  filler, calling git_commit once (word-varied messages — keeps the
 *  54a172ac near-identical leg blind). The extraTool execute returns real
 *  git stdout so extractReceipt mints the ok:true {sha, branch} receipt. */
const lineTurn = (n: number, copies = 1, line = INCIDENT_LINE) => ({
  content: Array(copies).fill(line).join('\n') + `\n(generation tick ${WORDS[(n - 1) % WORDS.length]} complete)`,
  reasoning: '',
  toolCalls: [{ id: `t${n}`, name: 'git_commit', arguments: JSON.stringify({ message: `e64fd118 replay ${WORDS[(n - 1) % WORDS.length]}` }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Option-A landing delivered; the manifest and its receipts are above.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** GUARD_STRIKE loop metrics recorded with one meta.seam. */
const strikes = (seam: string) =>
  mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m: any) => m?.meta?.seam === seam);
/** Message contents handed to ONE model call (cumulative list). */
const messageTextsOf = (callIdx: number): string[] =>
  ((mockRunModelTurn.mock.calls[callIdx]?.[1] ?? []) as any[])
    .map((m: any) => (typeof m?.content === 'string' ? m.content : ''))
    .filter(Boolean);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockExecuteCodingTool.mockImplementation(async () => 'probe result: ok');
});

describe('ticket e64fd118 — branch-citing repeated line: git_commit mints ids.branch so the df5ea136 exemption can lift it', () => {
  it('INCIDENT REPLAY: branch-citing heading ×1/turn across 6 turns, git_commit receipt minted turn 1 — exempt strike + in-band note, the run SURVIVES and delivers the final', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(lineTurn(1))      // count 1 — the git_commit dispatch mints the {sha, branch} receipt
      .mockResolvedValueOnce(lineTurn(2))      // count 2
      .mockResolvedValueOnce(lineTurn(3))      // count 3
      .mockResolvedValueOnce(lineTurn(4))      // count 4 → WARN (standard, still fires)
      .mockResolvedValueOnce(lineTurn(5))      // count 5
      .mockResolvedValueOnce(lineTurn(6))      // count 6 → break threshold: branch-cited → exempt, run continues
      .mockResolvedValue(FINAL);               // the final the incident run delivered anyway (via rescue)

    const result = await runCodingAgent(makeInput());

    // (a) The run survived: no line-repeat run-end, the final delivered.
    expect(result.finalText).toContain('Option-A landing delivered');
    expect(result.finalText).not.toContain('[HARNESS] Run ended: the identical narration line');
    // (b) The receipt-cited artifact really executed: every turn's git_commit
    // dispatched (the exempted 6th turn included — a lift, not a withhold).
    // extraTools execute is NOT executeCodingTool — the dispatches rode the
    // ctx.extraTools path, so assert on the mock's tool-call plan instead:
    // each turn's call was accepted (the run advanced past all 6).
    expect(mockRunModelTurn).toHaveBeenCalledTimes(7); // 6 line turns + FINAL
    // (c) Telemetry: exactly ONE receipt_cited_exempt strike at count 6/turns 6
    // carrying the incident line; NO ended_run on the seam.
    const lr = strikes('final_line_repeat_break');
    const exempt = lr.filter((m: any) => m.meta.state === 'receipt_cited_exempt');
    expect(exempt).toHaveLength(1);
    expect(exempt[0].meta).toMatchObject({ count: 6, turns: 6, line: INCIDENT_LINE });
    expect(lr.filter((m: any) => m.meta.state === 'ended_run')).toHaveLength(0);
    // The standard warn (count 4) still fired — detection untouched.
    expect(lr.some((m: any) => m.meta.state === 'warned' && m.meta.count === 4)).toBe(true);
    // (d) The ONE in-band exempt note rode into the model context after turn 6.
    const exemptNotices = messageTextsOf(6).filter((t) => t.includes('receipt-backed artifact id'));
    expect(exemptNotices).toHaveLength(1);
    expect(exemptNotices[0]).toContain(INCIDENT_LINE.slice(0, 40));
    // (e) No derail-rescue, no narration_repeat filing — nothing ended.
    expect(mockEnqueueDerailRescue).not.toHaveBeenCalled();
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    expect(filings.find((f: any) => f.tool === 'final_text')).toBeUndefined();
  });

  it('CAP: the same branch-cited line at 18 copies (×2/turn across 9 turns) still ENDS the run — degeneration no receipt can excuse', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(lineTurn(1, 2))   // count 2  — receipt minted on the dispatch
      .mockResolvedValueOnce(lineTurn(2, 2))   // count 4  → WARN
      .mockResolvedValueOnce(lineTurn(3, 2))   // count 6  → exempt (one strike)
      .mockResolvedValueOnce(lineTurn(4, 2))   // count 8
      .mockResolvedValueOnce(lineTurn(5, 2))   // count 10
      .mockResolvedValueOnce(lineTurn(6, 2))   // count 12
      .mockResolvedValueOnce(lineTurn(7, 2))   // count 14
      .mockResolvedValueOnce(lineTurn(8, 2))   // count 16
      .mockResolvedValueOnce(lineTurn(9, 2))   // count 18 ≥ cap 18 → BREAK
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput());

    expect(result.finalText).toContain('[HARNESS] Run ended: the identical narration line was repeated 18×');
    const lr = strikes('final_line_repeat_break');
    const exempt = lr.filter((m: any) => m.meta.state === 'receipt_cited_exempt');
    expect(exempt).toHaveLength(1);
    expect(exempt[0].meta).toMatchObject({ count: 6, turns: 3 });
    const ended = lr.filter((m: any) => m.meta.state === 'ended_run');
    expect(ended).toHaveLength(1);
    expect(ended[0].meta).toMatchObject({ count: 18, turns: 9 });
    expect(mockEnqueueDerailRescue).toHaveBeenCalledTimes(1);
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const ev = filings.find((f: any) => f.tool === 'final_text');
    expect(ev).toBeDefined();
    expect(ev.shape).toBe('narration_repeat');
    expect(ev.repeats).toBe(18);
  });

  it('HOLE-CLOSER: a branch-citing line whose branch matches NO receipt (the fabricated-branch dodge) breaks at 6 exactly as before', async () => {
    const fabTurn = (n: number) => lineTurn(n, 1, FABRICATED_LINE);
    mockRunModelTurn
      .mockResolvedValueOnce(fabTurn(1))  // count 1
      .mockResolvedValueOnce(fabTurn(2))  // count 2
      .mockResolvedValueOnce(fabTurn(3))  // count 3
      .mockResolvedValueOnce(fabTurn(4))  // count 4 → WARN
      .mockResolvedValueOnce(fabTurn(5))  // count 5
      .mockResolvedValueOnce(fabTurn(6))  // count 6 → deadbeef99 branch matches NO ok receipt → BREAK
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput());

    expect(result.finalText).toContain('[HARNESS] Run ended: the identical narration line was repeated 6×');
    const lr = strikes('final_line_repeat_break');
    expect(lr.filter((m: any) => m.meta.state === 'receipt_cited_exempt')).toHaveLength(0);
    expect(lr.some((m: any) => m.meta.state === 'ended_run' && m.meta.count === 6 && m.meta.turns === 6)).toBe(true);
    expect(mockEnqueueDerailRescue).toHaveBeenCalledTimes(1);
  });
});

/**
 * Replay pin — ticket 1ee07214 (mishap, breaker trip 2026-09-14, session
 * 3e1cae6f-59fb-43a7-9d32-6ee36c450428 "Hardening Bench for Public Release",
 * run f63bb92b-7252-4e2e-8873-5b2de877dbc5, auto-filed 03:27:02Z).
 *
 * THE INCIDENT: a public-release hardening lane (a DIFFERENT repo —
 * Python/pytest-xdist/ruff, not this platform) called `verify` three times
 * consecutively while hardening its bench. Each call faithfully ran THAT
 * project's verify chain and returned a truthful, DIFFERENT project-side
 * failure (the ticket lists newest first; chronological call order):
 *   1. lint:  ruff E501 in tests/test_processors.py:305:101 (106 > 100)
 *   2. test:  pytest-xdist tail — [gw1] 99% through test_judge_consistency.py
 *      / test_leaderboard_committed_consistency.py
 *   3. test:  pytest-xdist tail — [gw0]/[gw1] 99% through
 *      test_cohere_end_text_stripping.py / test_docs_sync.py /
 *      test_audit_working_tree.py
 * The tripping call's own reasoning named a DIFFERENT offered tool
 * (github_list_prs) — the intent-mismatch fast-trip weight (+1, agent.ts)
 * landed on the third consecutive chain failure: streak 3 + 1 ≥ 3 tripped
 * the derail breaker with all three texts captured — one-round withhold +
 * one bounded cross-checker consult + exactly ONE auto-filed investigation
 * ticket (this one — Redis-NX deduped per session+tool per 24h).
 *
 * ADJUDICATION (this lane, 2026-09-14): MODEL/PROJECT side, framework working
 * AS DESIGNED — same shape as 6a950136 / b61fb6c9 / ef7d082b:
 *   - Every filed text is the lane's OWN toolchain speaking: a ruff E501
 *     naming file:line:col in that repo with the offending source line
 *     quoted, and pytest-xdist worker tails ([gw0]/[gw1]) naming that
 *     repo's test modules — output a Digby framework deploy cannot author.
 *   - The `^Verify FAILED at` envelope is deliberately failure-shaped
 *     (FAILURE_MARKERS, learnings-index.service.ts — run_command is the ONLY
 *     exempt red-loop tool): a verify chain failure MUST count toward the
 *     breaker, else the breaker goes blind to a lane that truly cannot get
 *     its chain green. The two test tails show the chain's own 99% progress
 *     window (the failing test sits above the tail's truncation cut) — the
 *     envelope's ✗ test (exit 1) line is the truthful summary either way.
 *   - The three causes DIFFER (lint file → test tail A → test tail B): the
 *     lane was converging through its own hardening work, not stuck
 *     re-issuing an identical call against an identical refusal.
 *   - No advertised recovery path is broken: the E501 names its exact
 *     file:line:col; a chain failure's remedy (fix the named line, re-run)
 *     is ordinary project iteration the lane performed between calls.
 * NO platform code change: this pin locks the intended counting at the seam
 * (3 consecutive verify chain failures trip once; the intent-mismatch weight
 * is REAL and filed as StreakEvidence.intended; a mid-streak PASS resets;
 * ONE deduped ticket carries the streak's own texts, newest first) while
 * replaying the incident end-to-end through the real agent loop (the REAL
 * looksLikeToolFailure + detectIntendedTool run; only the model, the tool
 * executor, and the streak consult/filing are mocked).
 *
 * Scaffold mirrors agent-derail-break.6a950136.test.ts (same mock set). The
 * verify tool is offered via input.extraTools (agent.ts: per-run extra tools
 * join the offered list and are exempt from the not-offered preflight) with a
 * scripted execute double — the breaker counts RESULT TEXT, so the replay is
 * exact at the counting seam. A github_list_prs stub joins extraTools so the
 * REAL detectIntendedTool sees it as offered, exactly as the lane's run did.
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
import { looksLikeToolFailure } from './learnings-index.service';
import { detectIntendedTool } from './tool-preflight';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// ── 1ee07214's filed "Failure texts" — verbatim, in CHRONOLOGICAL call order
// (the ticket lists newest first). Each is the hardening lane's OWN toolchain
// speaking (ruff / pytest-xdist), tailed by the verify tool. The two pytest
// tails end mid-word exactly as filed (the ticket carries 500-char slices).
const FAIL_LINT_1 =
  'Verify FAILED at "lint": ✓ typecheck (exit 0)  ✗ lint (exit 1)\n'
  + '--- lint output tail ---\n'
  + 'E501 Line too long (106 > 100)\n'
  + '   --> tests/test_processors.py:305:101\n'
  + '    |\n'
  + '304 |     def test_severity_vocab_new_labels(self):\n'
  + '305 |         for label in ("overruled", "criticized", "distinguished", "questioned", "considered", "followed"):\n'
  + '    |                                                                                                     ^^^^^^\n'
  + '306 |             assert _score(case_treatment_score, {"t';
const FAIL_TEST_2 =
  'Verify FAILED at "test": ✓ typecheck (exit 0)  ✓ lint (exit 0)  ✗ test (exit 1)\n'
  + '--- test output tail ---\n'
  + 'tests/test_judge_consistency.py::TestBuildLeaderboardGuard::test_main_blocks_on_mixed_public_rows \n'
  + '[gw1] [ 99%] PASSED tests/test_judge_consistency.py::TestBuildLeaderboardGuard::test_main_blocks_on_mixed_public_rows \n'
  + 'tests/test_leaderboard_committed_consistency.py::TestGitStagingCompleteness::test_no_unstaged_leaderboard_when_scorecards_staged \n'
  + '[gw1] [ 99%] PASSED tests/test_leaderboard_comm';
const FAIL_TEST_3 =
  'Verify FAILED at "test": ✓ typecheck (exit 0)  ✓ lint (exit 0)  ✗ test (exit 1)\n'
  + '--- test output tail ---\n'
  + '[gw0] [ 99%] SKIPPED tests/test_cohere_end_text_stripping.py::TestRealDataValidation::test_cohere_samples_have_tags \n'
  + 'tests/test_docs_sync.py::TestFrontierTableParseable::test_frontier_table_has_rows \n'
  + '[gw0] [ 99%] PASSED tests/test_docs_sync.py::TestFrontierTableParseable::test_frontier_table_has_rows \n'
  + '[gw1] [ 99%] PASSED tests/test_audit_working_tree.py::TestExitCode::test_main_returns_1_when';
const CHAIN_OK = 'Verify PASSED: ✓ typecheck (exit 0)  ✓ lint (exit 0)  ✓ test (exit 0)';

// The tripping turn's own words (per the ticket: "lane's reasoning named
// github_list_prs") — names ANOTHER offered tool as a whole word and never
// the called one, so the REAL detectIntendedTool convicts it (+1 fast-trip).
const TRIP_REASONING =
  'The tree should be clean now; before running the chain once more, let me check the PR state with github_list_prs.';

/** The verify double: a per-run extra tool (agent.ts extraTools seam) whose execute replays the scripted chain results. */
const mockVerifyExec: jest.Mock = jest.fn();
const VERIFY_EXTRA_TOOL = {
  schema: {
    type: 'function' as const,
    function: {
      name: 'verify',
      description: 'test double of the verify tool',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: (...a: any[]) => mockVerifyExec(...a),
};
/** Stub so the REAL detectIntendedTool sees github_list_prs as offered — it was a live offered tool in the lane's run. */
const GITHUB_LIST_PRS_STUB = {
  schema: {
    type: 'function' as const,
    function: {
      name: 'github_list_prs',
      description: 'test stub — present so intent detection sees it offered',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: jest.fn(async () => 'prs: []'),
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-1ee07214-test',
  sessionId: 'sess-1ee07214',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'get the bench release-ready',
  extraTools: [VERIFY_EXTRA_TOOL, GITHUB_LIST_PRS_STUB],
  emit: jest.fn(),
});

/** A turn calling verify once (empty args — verify is not a platform tool, so no id-grounding preflight applies). */
const verifyTurn = (n: number, reasoning = '') => ({
  content: '',
  reasoning,
  toolCalls: [{ id: `t${n}`, name: 'verify', arguments: '{}' }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 1ee07214 — verify chain failures are failure-shaped BY DESIGN (breaker as designed)', () => {
  it('the incident replayed: 3 consecutive DIFFERENT verify chain-failures + the intent-mismatch weight trip the breaker once, filing ONE ticket with the streak’s own texts', async () => {
    mockVerifyExec
      .mockResolvedValueOnce(FAIL_LINT_1) // streak 1 — E501 in test_processors.py:305
      .mockResolvedValueOnce(FAIL_TEST_2) // streak 2 — pytest tail through test_judge_consistency.py
      .mockResolvedValueOnce(FAIL_TEST_3) // streak 3, +1 intent (reasoning names github_list_prs) → TRIP
      .mockResolvedValue(CHAIN_OK);
    mockRunModelTurn
      .mockResolvedValueOnce(verifyTurn(1))
      .mockResolvedValueOnce(verifyTurn(2))
      .mockResolvedValueOnce(verifyTurn(3, TRIP_REASONING))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // The breaker tripped and filed the streak for investigation — with the
    // REAL chain-failure texts, newest first (the 8579d419 capture-at-counting
    // mechanics), tool 'verify', and the intended tool its reasoning named.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('verify');
    expect(ev.perma).toBe(false);
    expect(ev.intended).toBe('github_list_prs');
    expect(ev.recentFailures).toHaveLength(3);
    expect(ev.recentFailures).toEqual([FAIL_TEST_3, FAIL_TEST_2, FAIL_LINT_1]);
    for (const text of ev.recentFailures) {
      expect(text).toMatch(/^Verify FAILED at/);
    }
    // The filed evidence preserves the THREE DISTINCT project-side causes —
    // an investigation lane can see this was converging iteration through its
    // own hardening work (a new tail each call), not an identical-refusal
    // stuck loop.
    expect(ev.recentFailures[2]).toContain('tests/test_processors.py:305:101');
    expect(ev.recentFailures[2]).toContain('E501 Line too long (106 > 100)');
    expect(ev.recentFailures[1]).toContain('tests/test_judge_consistency.py');
    expect(ev.recentFailures[1]).toContain('tests/test_leaderboard_committed_consistency.py');
    expect(ev.recentFailures[0]).toContain('tests/test_cohere_end_text_stripping.py');
    expect(ev.recentFailures[0]).toContain('tests/test_docs_sync.py');
    expect(ev.recentFailures[0]).toContain('tests/test_audit_working_tree.py');
    // The cross-checker consult receives the same pure evidence object.
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    const consultEv = mockConsultCrossCheckerOnStreak.mock.calls[0][0];
    expect(consultEv.recentFailures).toEqual(ev.recentFailures);
    expect(consultEv.intended).toBe('github_list_prs');
  });

  it('a verify chain PASS mid-streak resets the count — no trip, no ticket (the breaker only fires on CONSECUTIVE failures)', async () => {
    mockVerifyExec
      .mockResolvedValueOnce(FAIL_LINT_1) // streak 1
      .mockResolvedValueOnce(FAIL_TEST_2) // streak 2
      .mockResolvedValueOnce(CHAIN_OK)    // the lane fixes the tree → success → streak RESETS
      .mockResolvedValueOnce(FAIL_TEST_3) // streak 1 (fresh) — never reaches 3
      .mockResolvedValue(CHAIN_OK);
    mockRunModelTurn
      .mockResolvedValueOnce(verifyTurn(1))
      .mockResolvedValueOnce(verifyTurn(2))
      .mockResolvedValueOnce(verifyTurn(3))
      .mockResolvedValueOnce(verifyTurn(4))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
    expect(mockConsultCrossCheckerOnStreak).not.toHaveBeenCalled();
  });

  it('attribution evidence (the 251e9329 rule): the filed texts are failure-shaped by the DELIBERATE verify marker and self-describing', () => {
    // The `^Verify FAILED at` marker in FAILURE_MARKERS is intentional — a
    // verify chain failure MUST count toward the breaker (run_command is the
    // only exempt red-loop tool). Exempting it would blind the breaker to a
    // lane that truly cannot get its chain green.
    for (const text of [FAIL_LINT_1, FAIL_TEST_2, FAIL_TEST_3]) {
      expect(looksLikeToolFailure(text)).toBe(true);
      // Self-describing per the 251e9329 attribution gate: every text names a
      // test module in the lane's OWN project — output a Digby framework
      // deploy cannot author.
      expect(text).toMatch(/tests\/test_\w+\.py/);
    }
    // The ruff failure is self-describing down to file:line:col and quotes
    // the offending source line — the advertised recovery path (fix the
    // named line, re-run) was real.
    expect(FAIL_LINT_1).toContain('tests/test_processors.py:305:101');
    expect(FAIL_LINT_1).toContain('for label in ("overruled", "criticized"');
    // The pytest tails carry that repo's xdist worker ids and node ids.
    expect(FAIL_TEST_2).toContain('[gw1] [ 99%]');
    expect(FAIL_TEST_3).toContain('tests/test_audit_working_tree.py::TestExitCode::');
    expect(looksLikeToolFailure(CHAIN_OK)).toBe(false);
    // …and the intent-mismatch weight itself is pinned as designed: the trip
    // turn's own words convict github_list_prs against the offered set.
    expect(detectIntendedTool(TRIP_REASONING, 'verify', ['verify', 'github_list_prs'])).toBe('github_list_prs');
    expect(detectIntendedTool('', 'verify', ['verify', 'github_list_prs'])).toBeNull();
  });
});

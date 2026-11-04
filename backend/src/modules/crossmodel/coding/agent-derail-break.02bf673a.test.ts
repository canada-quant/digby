/**
 * Replay pin — ticket 02bf673a (mishap, breaker trip 2026-09-21, session
 * 66c9fb5c-cf72-4ced-a298-1951b7d610da (project "canlegal-bench"), run
 * 137e3ea7-283c-4122-afa6-87da2ab3a375, auto-filed 16:37:01Z, "first streak
 * this run", tool `verify`).
 *
 * THE INCIDENT: the canlegal-bench lane (a DIFFERENT repo — Python/pytest/ruff,
 * not this platform) was mid-execution of its step-7 holding_recall SWAP
 * remediation (its todo 076b146f; its transcript documents the corpus
 * 15,553 → 14,129 regen + derived record-count detector landing in its commit
 * 281833e4) and ran its acceptance `verify` battery. Three verify calls each
 * faithfully ran THAT project's verify chain and returned a truthful,
 * DIFFERENT project-side failure:
 *   1. test:  README badge assertion `E   assert 'records-14%2C129' in
 *      '# CanLegal-Bench\n\nThe first comprehensive open evaluation benchmark…'`
 *      — the SWAP's new corpus count (14,129) not yet regenerated into the
 *      README badge (an in-flight regen the lane itself landed minutes later)
 *   2. lint:  ruff E501 in tests/test_citation_resolution.py:355 (107 > 100)
 *      — a long set-union line introduced by the lane's own in-flight edits
 *   3. test:  scorecard sync — leaderboard/results/local/<model>/scorecard.json
 *      `citation_holding.record_set_hash` drift ('sha256:4e5caa6a…' ->
 *      'sha256:06b522a1…'), the direct consequence of the lane's own record-set
 *      swap (1,448 → 24 records) not yet resynced
 * Unlike 6a950136's three STRAIGHT verify calls, these were interleaved with
 * the lane's successful fix-work (edit_file applications, exempt run_command
 * pytest re-runs). The breaker still tripped ONCE because the streak resets
 * ONLY on a success of the SAME tool (agent.ts:3409-3410) — anti-laundering
 * by design: a cheap unrelated success must never clear a failing tool's
 * streak, or any derail could launder itself by interleaving a probe success
 * between failures. One-round withhold + exactly ONE auto-filed ticket (this
 * one). The lane's run kept executing after the trip: its final (transcript
 * msg 306249e1, finalized 16:58Z) reports the full verify chain PASSED
 * (typecheck 0 / lint 0 / test 0; STEP 0 receipt 5968 passed, PYTEST_EXIT=0).
 *
 * ADJUDICATION (this lane, 2026-09-21): MODEL/PROJECT side, framework working
 * AS DESIGNED — the SECOND occurrence of the 6a950136 class (verify chain
 * failures are failure-shaped BY DESIGN, adjudicated 2026-09-13, whose pin
 * explicitly warns a future well-meaning "fix" must NOT exempt the verify
 * envelope and blind the breaker to a lane that truly cannot get its chain
 * green). Per the 251e9329 attribution rule ("BEFORE calling a tool-failure
 * streak model behavior, diff the refusal text against the tools it names"):
 *   - Every filed text is self-describing and CORRECT: it names a file:line or
 *     artifact in the lane's OWN project repo (a Digby framework deploy cannot
 *     author ruff/pytest output, README badge assertions, or its scorecard
 *     record-set hashes there).
 *   - No advertised recovery path was broken: each failure's remedy (regen the
 *     badge, wrap the line, resync the scorecard) is named by the failure
 *     itself, and the lane completed all three within the SAME run (its final
 *     verify chain PASSED).
 *   - The three causes DIFFER (badge regen → E501 → scorecard resync): the
 *     lane was converging through a multi-artifact remediation, not stuck
 *     re-issuing an identical call against an identical refusal.
 * NO platform code change: this pin locks (a) the incident replay end-to-end
 * through the real agent loop with the interleaved-success arithmetic that
 * 6a950136's straight-run replay did not cover, and (b) exempt-tool
 * neutrality — run_command results (even red ones) neither feed nor launder
 * the verify streak (agent.ts:3352 name exemption: "red test/build loops are
 * legitimate iteration, not derailment").
 *
 * Scaffold mirrors agent-derail-break.6a950136.test.ts (same mock set). The
 * verify/edit_file/run_command tools are offered via input.extraTools
 * (agent.ts: per-run extra tools join the offered list and are exempt from
 * the not-offered preflight) with scripted execute doubles — the breaker
 * counts RESULT TEXT, so the replay is exact at the counting seam.
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

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// ── 02bf673a's filed "Failure texts" — verbatim, in CHRONOLOGICAL call order
// (the ticket lists newest first). Each is the canlegal-bench lane's OWN
// toolchain speaking (pytest / ruff / its scorecard sync check), tailed by the
// verify tool; each ends mid-stream because the 8579d419 capture slices at
// 1200 chars.
const FAIL_TEST_1 =
  'Verify FAILED at "test": ✓ typecheck (exit 0)  ✓ lint (exit 0)  ✗ test (exit 1)\n'
  + '--- test output tail ---\n'
  + 'E   assert \'records-14%2C129\' in \'# CanLegal-Bench\\n\\nThe first comprehensive open evaluation benchmark for Canadian legal large language models.\\n\\n'
  + '[![CI](https://github.com/canada-quant/canlegal-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/canada-quant/canlegal-bench/actions/workflows/ci.yml)\\n'
  + '[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)\\';
const FAIL_LINT_2 =
  'Verify FAILED at "lint": ✓ typecheck (exit 0)  ✗ lint (exit 1)\n'
  + '--- lint output tail ---\n'
  + 'E501 Line too long (107 > 100)\n'
  + '   --> tests/test_citation_resolution.py:355:101\n'
  + '    |\n'
  + '353 |         assert len(q10b) == 52\n'
  + '354 |         assert len(q7) == 1424\n'
  + '355 |         ids = {s["record_id"] for s in src} | {q["record_id"] for q in q10b} | {q["record_id"] for q in q7}\n'
  + '    |                                                                                                      ^^^^^^^\n'
  + '356 |         assert len';
const FAIL_TEST_3 =
  'Verify FAILED at "test": ✓ typecheck (exit 0)  ✓ lint (exit 0)  ✗ test (exit 1)\n'
  + '--- test output tail ---\n'
  + 'leaderboard/results/local/command-a-plus-max/scorecard.json: in sync (5 judged tasks checked)\n'
  + 'leaderboard/results/local/gemini-3.1-pro-preview/scorecard.json:\n'
  + '  citation_holding.record_set_hash: \'sha256:4e5caa6a69d6fafc3e3f5488acea89cabbbe1a18d52f0375cbb9386370e1067a\' -> \'sha256:06b522a1821908af4826ca58add4b19e8703367d548e6d640f962386156c75f7\'\n'
  + 'leaderboard/results/local/gpt-5.5/scorecard.json:';
const CHAIN_OK = 'Verify PASSED: ✓ typecheck (exit 0)  ✓ lint (exit 0)  ✓ test (exit 0)';

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
/** The fix-work doubles: edit_file (a counted tool whose SUCCESS is streak-neutral for a verify streak) … */
const mockEditExec: jest.Mock = jest.fn(async () => 'edit ok: applied');
const EDIT_EXTRA_TOOL = {
  schema: {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'test double of the edit_file tool',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: (...a: any[]) => mockEditExec(...a),
};
/** … and run_command (the ONE name-exempt red-loop tool — its results, red or green, neither feed nor reset any streak). */
const mockShExec: jest.Mock = jest.fn(async () => 'pytest: 96 passed\n[exit: 0]');
const SH_EXTRA_TOOL = {
  schema: {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'test double of the run_command tool',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: (...a: any[]) => mockShExec(...a),
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-02bf673a-test',
  sessionId: 'sess-02bf673a',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'run the acceptance battery',
  extraTools: [VERIFY_EXTRA_TOOL, EDIT_EXTRA_TOOL, SH_EXTRA_TOOL],
  emit: jest.fn(),
});

/** A turn calling verify once (empty args — verify is not a platform tool, so no id-grounding preflight applies). */
const verifyTurn = (n: number) => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `v${n}`, name: 'verify', arguments: '{}' }],
  finishReason: 'tool_calls',
});
/** A turn applying a successful fix edit (the incident's interleaved remediation work). */
const editTurn = (n: number) => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `e${n}`, name: 'edit_file', arguments: '{}' }],
  finishReason: 'tool_calls',
});
/** A turn re-running the suite via the exempt shell tool. */
const shTurn = (n: number) => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `s${n}`, name: 'run_command', arguments: '{}' }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 02bf673a — verify streak with interleaved fix-work: breaker as designed, anti-laundering reset', () => {
  it('the incident replayed: 3 verify chain-failures interleaved with successful edit/shell turns still trip ONCE, filing ONE ticket with the streak’s own texts — then the lane self-heals', async () => {
    mockVerifyExec
      .mockResolvedValueOnce(FAIL_TEST_1) // streak 1 — README badge assert 'records-14%2C129' (corpus regen in flight)
      .mockResolvedValueOnce(FAIL_LINT_2) // streak 2 — ruff E501 tests/test_citation_resolution.py:355 (introduced by the fix edits)
      .mockResolvedValueOnce(FAIL_TEST_3) // streak 3 — scorecard citation_holding.record_set_hash drift → TRIP
      .mockResolvedValue(CHAIN_OK);       // the lane resyncs and the chain goes green post-trip
    mockRunModelTurn
      .mockResolvedValueOnce(verifyTurn(1))  // FAIL_TEST_1 → streak (verify, 1)
      .mockResolvedValueOnce(editTurn(2))    // the badge regen edit — SUCCESS, but NOT verify: streak untouched (anti-laundering)
      .mockResolvedValueOnce(verifyTurn(3))  // FAIL_LINT_2 → streak (verify, 2)
      .mockResolvedValueOnce(shTurn(4))      // exempt run_command re-run — neutral by name
      .mockResolvedValueOnce(verifyTurn(5))  // FAIL_TEST_3 → TRIP (one-round withhold, ONE filing)
      .mockResolvedValueOnce(editTurn(6))    // ban round consumed by more fix-work (the scorecard resync)
      .mockResolvedValueOnce(editTurn(7))    // second fix turn — verifies the withhold is exactly one model round
      .mockResolvedValueOnce(verifyTurn(8))  // CHAIN_OK — the lane self-heals, no second trip
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // The breaker tripped and filed the streak for investigation — with the
    // REAL chain-failure texts, newest first (the 8579d419 capture-at-counting
    // mechanics), tool 'verify'.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('verify');
    expect(ev.recentFailures).toHaveLength(3);
    expect(ev.recentFailures).toEqual([FAIL_TEST_3, FAIL_LINT_2, FAIL_TEST_1]);
    for (const text of ev.recentFailures) {
      expect(text).toMatch(/^Verify FAILED at/);
    }
    // The filed evidence preserves the THREE DISTINCT project-side causes —
    // an investigation lane can see this was converging iteration through a
    // multi-artifact remediation (new artifact each call), not an
    // identical-refusal stuck loop.
    expect(ev.recentFailures[2]).toContain("records-14%2C129");
    expect(ev.recentFailures[2]).toContain('CanLegal-Bench');
    expect(ev.recentFailures[1]).toContain('tests/test_citation_resolution.py:355');
    expect(ev.recentFailures[1]).toContain('E501 Line too long (107 > 100)');
    expect(ev.recentFailures[0]).toContain('citation_holding.record_set_hash');
    expect(ev.recentFailures[0]).toContain('sha256:4e5caa6a');
    expect(ev.recentFailures[0]).toContain('sha256:06b522a1');
    // The cross-checker consult receives the same pure evidence object.
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
    // The run was NOT terminated by the trip: the post-trip verify executed
    // and went green (the incident lane's own 16:58Z final — full chain
    // PASSED — is the production twin of this assertion).
    expect(mockVerifyExec).toHaveBeenCalledTimes(4);
    expect(mockEditExec).toHaveBeenCalledTimes(3);
    expect(mockShExec).toHaveBeenCalledTimes(1);
  });

  it('exempt-tool neutrality: run_command reds neither feed nor launder the verify streak — the filing carries ONLY the verify texts', async () => {
    const SH_RED_1 = 'pytest tests/test_citation_resolution.py -x\n1 failed, 96 passed\n[exit: 1]';
    const SH_RED_2 = 'pytest tests/test_record_count_tile.py -x\n1 failed\n[exit: 1]';
    mockShExec
      .mockResolvedValueOnce(SH_RED_1)
      .mockResolvedValueOnce(SH_RED_2);
    mockVerifyExec
      .mockResolvedValueOnce(FAIL_TEST_1) // streak 1
      .mockResolvedValueOnce(FAIL_LINT_2) // streak 2
      .mockResolvedValueOnce(FAIL_TEST_3) // streak 3 → TRIP
      .mockResolvedValue(CHAIN_OK);
    mockRunModelTurn
      .mockResolvedValueOnce(verifyTurn(1))  // FAIL → streak (verify, 1)
      .mockResolvedValueOnce(shTurn(2))      // run_command RED — name-exempt: no count, no reset, text NOT captured
      .mockResolvedValueOnce(verifyTurn(3))  // FAIL → streak (verify, 2)
      .mockResolvedValueOnce(shTurn(4))      // run_command RED — exempt again
      .mockResolvedValueOnce(verifyTurn(5))  // FAIL → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockShExec).toHaveBeenCalledTimes(2); // both shell reds really executed …
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('verify');
    // … yet the streak is purely the verify failures: the exempt tool's red
    // texts never enter the capture (agent.ts:3358 runs inside the
    // non-run_command branch), and its failures never reset the count either.
    expect(ev.recentFailures).toEqual([FAIL_TEST_3, FAIL_LINT_2, FAIL_TEST_1]);
    for (const text of ev.recentFailures) {
      expect(text).toMatch(/^Verify FAILED at/);
      expect(text).not.toContain('[exit: 1]');
    }
  });

  it('attribution evidence (the 251e9329 rule): the filed texts are failure-shaped by the DELIBERATE verify marker and self-describing', () => {
    // The `^Verify FAILED at` marker in FAILURE_MARKERS is intentional — a
    // verify chain failure MUST count toward the breaker (run_command is the
    // only exempt red-loop tool; 6a950136 settled this). Exempting it would
    // blind the breaker to a lane that truly cannot get its chain green.
    for (const text of [FAIL_TEST_1, FAIL_LINT_2, FAIL_TEST_3]) {
      expect(looksLikeToolFailure(text)).toBe(true);
    }
    expect(looksLikeToolFailure(CHAIN_OK)).toBe(false);
    // Self-describing per the 251e9329 attribution gate: every text names an
    // artifact in the lane's OWN project — a Digby framework deploy cannot
    // author ruff output, pytest README-badge assertions, or its scorecard
    // record-set hashes — and each names its own remedy (regen the badge,
    // wrap the line, resync the scorecard), all completed by the lane in-run.
    expect(FAIL_TEST_1).toMatch(/records-14%2C129/);
    expect(FAIL_TEST_1).toMatch(/CanLegal-Bench/);
    expect(FAIL_LINT_2).toMatch(/tests\/test_citation_resolution\.py:355/);
    expect(FAIL_TEST_3).toMatch(/leaderboard\/results\/local\/[\w.-]+\/scorecard\.json/);
    expect(FAIL_TEST_3).toMatch(/citation_holding\.record_set_hash/);
  });
});

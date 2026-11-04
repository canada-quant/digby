/**
 * Replay pin — ticket d4e6b69d (mishap, breaker trip 2026-09-19, session
 * d4c97977-62f9-4c56-9721-a6e644abbe1d "Post-Sweep Acceptance Criteria
 * Verified" (project canlegal-bench), run 55a5bcb9-e51a-4b6d-a0ee-95a7a8d97b3f,
 * auto-filed 20:02:57Z).
 *
 * THE INCIDENT: a benchmark endgame lane (a DIFFERENT repo — Python /
 * pytest-xdist / ruff, not this platform) called `verify` three times
 * consecutively while landing the Command A+ judged cells + leaderboard
 * publish. Each call faithfully ran THAT project's verify chain and returned
 * a truthful, DIFFERENT project-side failure (the ticket lists newest first;
 * chronological call order):
 *   1. test:  pytest assertion introspection — {3026, 3243} =
 *      set(dict_values([3026, 3026, 3026, 3243, 3026])) over the rollup map
 *      {'CanLaw-1B': 3026, 'CanLaw-2B': 3026, 'canlaw-2': 3026,
 *      'command-a-plus': 3243, ...} (a diagnostic-rollup dedupe expectation
 *      the lane's new command-a-plus rows invalidated)
 *   2. lint:  ruff E501 in tests/test_published_cell_invariants.py:81:101
 *      (111 > 100) — an over-long assert the lane itself had just written
 *   3. test:  pytest-xdist tail — [gw0] 99% through
 *      tests/test_diagnostic_rollups_dedupe.py (TestIterSamplesLastWinsWithinFile
 *      / TestRealCacheDocumentsKnownDefect)
 * Three PLAIN consecutive chain failures (no ungrounded-id or intent-mismatch
 * fast-trip weight — the ticket shows 1+1+1 = 3): the derail breaker tripped
 * once — one-round withhold + one bounded cross-checker consult + exactly ONE
 * auto-filed investigation ticket (this one — Redis-NX deduped per
 * session+tool per 24h).
 *
 * ADJUDICATION (this lane, 2026-09-19): MODEL/PROJECT side, framework working
 * AS DESIGNED — same shape as 1ee07214 / 6a950136 / 5783afbe / ea69c94e /
 * d0b9c6a6:
 *   - Every filed text is the lane's OWN toolchain speaking: ruff E501 naming
 *     file:line:col with the offending source line quoted, and pytest
 *     assertion introspection / xdist worker tails naming that repo's test
 *     modules and model ids (CanLaw-1B / command-a-plus) — output a Digby
 *     framework deploy cannot author.
 *   - The lane's own transcript documents root cause + SELF-RECOVERY: firing
 *     36 ("Auto-verify fix … my judged-cell commit 82cdb265 changed
 *     runs/judged_scores.json without re-stamping the cell-provenance
 *     sidecar — 2 failures in tests/test_cell_provenance.py … Fix applied …
 *     committed as 5d61c282, full chain now green") and later "Verify PASSED
 *     — typecheck ✓ lint ✓ test ✓ (exit 0, verify-tool receipt ~18:12Z)".
 *     The breaker never claimed the lane was stuck — it fires the ONE
 *     investigation ticket and the lane iterates on.
 *   - The three causes DIFFER (dedupe assertion → lint E501 → test tail):
 *     converging iteration through the lane's own endgame writes, not an
 *     identical-refusal stuck loop.
 *   - No advertised recovery path is broken: the E501 names its exact
 *     file:line:col and quotes the offending line; each chain failure's
 *     remedy (fix the named line / the invalidated expectation, re-run) is
 *     ordinary project iteration the lane performed between calls.
 * NO platform code change: this pin locks the intended counting at the seam
 * for THIS incident's stage sequence (test → lint → test, three PLAIN
 * consecutive failures trip once with NO fast-trip weight; a mid-streak PASS
 * resets; ONE deduped ticket carries the streak's own texts, newest first)
 * while replaying the incident end-to-end through the real agent loop (the
 * REAL looksLikeToolFailure + detectIntendedTool run; only the model, the
 * tool executor, and the streak consult/filing are mocked).
 *
 * Scaffold mirrors agent-derail-break.1ee07214.test.ts (same mock set). The
 * verify tool is offered via input.extraTools (agent.ts: per-run extra tools
 * join the offered list and are exempt from the not-offered preflight) with a
 * scripted execute double — the breaker counts RESULT TEXT, so the replay is
 * exact at the counting seam.
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

// ── d4e6b69d's filed "Failure texts" — verbatim, in CHRONOLOGICAL call order
// (the ticket lists newest first). Each is the endgame lane's OWN toolchain
// speaking (pytest / ruff / pytest-xdist), tailed by the verify tool.
const FAIL_TEST_1 =
  'Verify FAILED at "test": ✓ typecheck (exit 0)  ✓ lint (exit 0)  ✗ test (exit 1)\n'
  + '--- test output tail ---\n'
  + 'E    +    where {3026, 3243} = set(dict_values([3026, 3026, 3026, 3243, 3026]))\n'
  + 'E    +      where dict_values([3026, 3026, 3026, 3243, 3026]) = <built-in method values of dict object at 0x7488eccaab80>()\n'
  + 'E    +        where <built-in method values of dict object at 0x7488eccaab80> = {\'CanLaw-1B\': 3026, \'CanLaw-2B\': 3026, \'canlaw-2\': 3026, \'command-a-plus\': 3243, ...}.values\n'
  + '_____________ Test';
const FAIL_LINT_2 =
  'Verify FAILED at "lint": ✓ typecheck (exit 0)  ✗ lint (exit 1)\n'
  + '--- lint output tail ---\n'
  + 'E501 Line too long (111 > 100)\n'
  + '  --> tests/test_published_cell_invariants.py:81:101\n'
  + '   |\n'
  + '79 |         # command-a-plus\'s statute/bijural/regulation semantic cells are slim\n'
  + '80 |         # (accuracy/correct/total only) and carry no strict/partial breakdown.\n'
  + '81 |         assert len(cells) == 45, f"expected 42 + 3 command-a-plus strict-carrying cells = 45, got {len(cells)}"\n'
  + '   |';
const FAIL_TEST_3 =
  'Verify FAILED at "test": ✓ typecheck (exit 0)  ✓ lint (exit 0)  ✗ test (exit 1)\n'
  + '--- test output tail ---\n'
  + '[gw0] [ 99%] PASSED tests/test_diagnostic_rollups_dedupe.py::TestIterSamplesLastWinsWithinFile::test_duplicate_lines_count_once_last_score_wins \n'
  + 'tests/test_diagnostic_rollups_dedupe.py::TestRealCacheDocumentsKnownDefect::test_known_defects_notice_present \n'
  + '[gw0] [ 99%] PASSED tests/test_diagnostic_rollups_dedupe.py::TestRealCacheDocumentsKnownDefect::test_known_defects_notice_present \n'
  + 'tests/te';
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

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-d4e6b69d-test',
  sessionId: 'sess-d4e6b69d',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'land the judged cells and publish the board',
  extraTools: [VERIFY_EXTRA_TOOL],
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

describe('ticket d4e6b69d — 3 PLAIN consecutive verify chain-failures trip the breaker once (as designed)', () => {
  it('the incident replayed: test → lint → test chain-failures trip once with NO fast-trip weight, filing ONE ticket with the streak’s own texts', async () => {
    mockVerifyExec
      .mockResolvedValueOnce(FAIL_TEST_1) // streak 1 — pytest dedupe-rollup assertion
      .mockResolvedValueOnce(FAIL_LINT_2) // streak 2 — ruff E501 in test_published_cell_invariants.py:81
      .mockResolvedValueOnce(FAIL_TEST_3) // streak 3 — plain 1+1+1 = 3 → TRIP (no weights)
      .mockResolvedValue(CHAIN_OK);
    mockRunModelTurn
      .mockResolvedValueOnce(verifyTurn(1))
      .mockResolvedValueOnce(verifyTurn(2))
      .mockResolvedValueOnce(verifyTurn(3))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // The breaker tripped and filed the streak for investigation — with the
    // REAL chain-failure texts, newest first (the 8579d419 capture-at-counting
    // mechanics), tool 'verify', and NO intended tool (this trip carried no
    // intent-mismatch weight — contrast 1ee07214).
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('verify');
    expect(ev.perma).toBe(false);
    expect(ev.intended).toBeFalsy();
    expect(ev.recentFailures).toHaveLength(3);
    expect(ev.recentFailures).toEqual([FAIL_TEST_3, FAIL_LINT_2, FAIL_TEST_1]);
    for (const text of ev.recentFailures) {
      expect(text).toMatch(/^Verify FAILED at/);
    }
    // The filed evidence preserves the THREE DISTINCT project-side causes —
    // an investigation lane can see this was converging iteration through its
    // own endgame writes (a new failure each call), not an identical-refusal
    // stuck loop.
    expect(ev.recentFailures[2]).toContain('{3026, 3243} = set(dict_values');
    expect(ev.recentFailures[2]).toContain("'command-a-plus': 3243");
    expect(ev.recentFailures[1]).toContain('tests/test_published_cell_invariants.py:81:101');
    expect(ev.recentFailures[1]).toContain('E501 Line too long (111 > 100)');
    expect(ev.recentFailures[0]).toContain('tests/test_diagnostic_rollups_dedupe.py::TestRealCacheDocumentsKnownDefect');
    expect(ev.recentFailures[0]).toContain('[gw0] [ 99%]');
    // The cross-checker consult receives the same pure evidence object.
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    const consultEv = mockConsultCrossCheckerOnStreak.mock.calls[0][0];
    expect(consultEv.recentFailures).toEqual(ev.recentFailures);
    expect(consultEv.intended ?? null).toBe(ev.intended ?? null);
  });

  it('a verify chain PASS mid-streak resets the count — no trip, no ticket (the lane’s own 17:26Z/18:12Z self-recovery contract)', async () => {
    mockVerifyExec
      .mockResolvedValueOnce(FAIL_TEST_1) // streak 1
      .mockResolvedValueOnce(FAIL_LINT_2) // streak 2
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
    for (const text of [FAIL_TEST_1, FAIL_LINT_2, FAIL_TEST_3]) {
      expect(looksLikeToolFailure(text)).toBe(true);
    }
    // Self-describing per the 251e9329 attribution gate: the lint text names a
    // test module in the lane's OWN project down to file:line:col, and the
    // pytest texts name that repo's modules / model ids — output a Digby
    // framework deploy cannot author.
    expect(FAIL_LINT_2).toMatch(/tests\/test_\w+\.py:81:101/);
    expect(FAIL_LINT_2).toContain('assert len(cells) == 45');
    expect(FAIL_TEST_1).toContain("'CanLaw-1B': 3026");
    expect(FAIL_TEST_1).toContain("'command-a-plus': 3243");
    expect(FAIL_TEST_3).toContain('tests/test_diagnostic_rollups_dedupe.py::TestIterSamplesLastWinsWithinFile::');
    expect(FAIL_TEST_3).toContain('[gw0] [ 99%]');
    expect(looksLikeToolFailure(CHAIN_OK)).toBe(false);
    // …and no fast-trip weight fired in this incident: empty reasoning convicts
    // nothing against the offered set (contrast the 1ee07214 intent pin).
    expect(detectIntendedTool('', 'verify', ['verify'])).toBeNull();
  });
});

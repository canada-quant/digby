/**
 * Replay pin — ticket 5783afbe (mishap, breaker trip 2026-09-14, session
 * d1c21ad4-4162-4049-8886-4a1925ea512c "CanLegalBench Step 9 Citator
 * Rescrape", run f3694810-9cb3-47d4-ac9d-29784cde68ed, auto-filed 07:06:19Z).
 *
 * THE INCIDENT: the canlegal-bench lane (a DIFFERENT repo — Python/pytest/
 * ruff, not this platform; THIRD incident of the 6a950136 class on that repo)
 * called `verify` three times consecutively mid-rescrape. Each call faithfully
 * ran THAT project's verify chain and returned a truthful, DIFFERENT
 * project-side failure (the ticket lists newest first; chronological order):
 *   1. lint:  ruff E501 in canlegal_bench/frozen_manifest.py:55:101
 *      (177 > 100 — the offending line is the lane's OWN migration comment:
 *      "…3 rebuild (GH #91, gate oq_0da40c30): 478 ct_* superseded/
 *      quarantined, 683 ctv3_* from citator mapping v3") + a second E501
 *      (124 > 100) in a tests/ file (truncated in the filed tail)
 *   2. test:  pytest AssertionError "case_treatment_classification:
 *      expected 683, got 478" — the scorecard cell still ships the legacy
 *      478 ct_* count while the lane's test expects the new 683 ctv3_*
 *      count from its in-flight citator mapping v3 rescrape
 *   3. lint:  ruff E501 in tests/test_build_scorecard_all_12_tasks.py:318:101
 *      (103 > 100) — the quoted context lines 316-317 are the lane's OWN
 *      comment: "The shipped cell is a grandfathered legacy count until the
 *      step-6 re-runs. Skipped on BOTH sides."
 * The verify envelope `^Verify FAILED at` is deliberately failure-shaped
 * (FAILURE_MARKERS, learnings-index.service.ts — run_command is the ONLY
 * exempt red-loop tool), so 3 consecutive chain failures tripped the derail
 * breaker: one-round withhold + one bounded cross-checker consult + exactly
 * ONE auto-filed investigation ticket (this one — "first streak this run",
 * Redis-NX deduped per session+tool per 24h).
 *
 * ADJUDICATION (this lane, 2026-09-14): MODEL/PROJECT side, framework working
 * AS DESIGNED — same shape as 6a950136 / 1ee07214 / b61fb6c9. Per the
 * 251e9329 attribution rule ("BEFORE calling a tool-failure streak model
 * behavior, diff the refusal text against the tools it names — a broken
 * advertised recovery path is a deterministic framework defect"):
 *   - Every filed text is the lane's OWN toolchain speaking: ruff E501 naming
 *     file:line:col in that repo WITH the offending source line quoted, and a
 *     pytest AssertionError showing that repo's scorecard dict internals —
 *     output a Digby framework deploy cannot author.
 *   - No advertised recovery path is broken: the E501s name exact
 *     file:line:col (shorten the line — ordinary iteration), and the 478/683
 *     assertion pair is SELF-EXPLAINED by the lane's own quoted comments in
 *     the SAME streak (frozen_manifest.py:55 names both id families and both
 *     counts; test_build_scorecard_all_12_tasks.py:316-317 names the
 *     grandfathering). The remedy (finish the rescrape / re-ship the cell)
 *     is the lane's own Step-9 work, not a framework repair.
 *   - The three causes DIFFER (lint file A → test assertion → lint file B):
 *     converging iteration through a data migration, not an identical-refusal
 *     stuck loop.
 *   - Framework diff (the ticket's INVESTIGATE ask): git log shows NO commit
 *     to the verify/streak/breaker/reflection seams between the merged
 *     1ee07214 pin (earlier 2026-09-14) and this streak (2026-09-14T07:06Z) —
 *     latest verify-touching commit 3d23d7e6f (ticket 6a8dddd3 skip-stage
 *     diagnostics) predates even the 6a950136 incident; learnings-index
 *     d559a53ed (7c1e5b9f marker anchoring) likewise; agent.ts's recent five
 *     touch watched-resources/fleet/dispatch-gate/backoff/terminal-note;
 *     reflection.ts unchanged since its build + the model-cutover message.
 *     Not a regression.
 *   - The ticket title is reflection.ts fileStreakInvestigation's constant
 *     template ("3× tool-failure streak: <tool> on \"<chat>\" — framework or
 *     model?") — "3×" is the breaker's trip-THRESHOLD branding, not a call
 *     count; the auto-filer fired as designed and filed ONE deduped ticket.
 * NO platform code change: this pin locks the intended counting (verify chain
 * failures ARE failure-shaped; a mid-streak PASS resets; ONE deduped ticket
 * carries the streak's own texts, newest first) so a future well-meaning
 * "fix" cannot exempt the verify envelope and blind the breaker to a lane
 * that truly cannot get its chain green — while replaying the incident
 * end-to-end through the real agent loop (the REAL looksLikeToolFailure
 * runs; only the model, the tool executor, and the streak consult/filing
 * are mocked).
 *
 * Scaffold mirrors agent-derail-break.6a950136.test.ts (same mock set). The
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

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// ── 5783afbe's filed "Failure texts" — verbatim, in CHRONOLOGICAL call order
// (the ticket lists newest first; truncations are the ticket's own). Each is
// the canlegal-bench lane's OWN toolchain speaking (ruff / pytest), tailed by
// the verify tool.
const FAIL_LINT_1 =
  'Verify FAILED at "lint": ✓ typecheck (exit 0)  ✗ lint (exit 1)\n'
  + '--- lint output tail ---\n'
  + 'E501 Line too long (177 > 100)\n'
  + '  --> canlegal_bench/frozen_manifest.py:55:101\n'
  + '   |\n'
  + '53 | …laceholder\n54 | …l now empty.\n'
  + '55 | …3 rebuild (GH #91, gate oq_0da40c30): 478 ct_* superseded/quarantined, 683 ctv3_* from citator mapping v3\n'
  + '   |                              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n'
  + '56 | …\n57 | …o\n   |\n\n'
  + 'E501 Line too long (124 > 100)\n'
  + '   --> tests/test';
const FAIL_TEST_2 =
  'Verify FAILED at "test": ✓ typecheck (exit 0)  ✓ lint (exit 0)  ✗ test (exit 1)\n'
  + '--- test output tail ---\n'
  + 'E   AssertionError: case_treatment_classification: expected 683, got 478\n'
  + 'E   assert 478 == 683\n'
  + "E    +  where 478 = int('478')\n"
  + "E    +    where '478' = <built-in method get of dict object at 0x7f8049f6d280>('case_treatment_classification', 0)\n"
  + "E    +      where <built-in method get of dict object at 0x7f8049f6d280> = {'neutral_cite_verify': '524', 'statute_section_qa': '557', 'jurisdiction_route";
const FAIL_LINT_3 =
  'Verify FAILED at "lint": ✓ typecheck (exit 0)  ✗ lint (exit 1)\n'
  + '--- lint output tail ---\n'
  + 'E501 Line too long (103 > 100)\n'
  + '   --> tests/test_build_scorecard_all_12_tasks.py:318:101\n'
  + '    |\n'
  + '316 |         # rescored. The shipped cell is a grandfathered legacy count until\n'
  + '317 |         # the step-6 re-runs. Skipped on BOTH sides.\n'
  + '318 |         if task in ("doctrine_shift_detection", "temporal_reasoning", "case_treatment_classification"):\n'
  + '    |                                                              \n';
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
  worktree: '/tmp/derail-5783afbe-test',
  sessionId: 'sess-5783afbe',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'rescrape the citator',
  extraTools: [VERIFY_EXTRA_TOOL],
  emit: jest.fn(),
});

/** A turn calling verify once (empty args — verify is not a platform tool, so no id-grounding preflight applies). */
const verifyTurn = (n: number) => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `t${n}`, name: 'verify', arguments: '{}' }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 5783afbe — verify chain failures are failure-shaped BY DESIGN (breaker as designed)', () => {
  it('the incident replayed: 3 consecutive DIFFERENT verify chain-failures trip the breaker once, filing ONE ticket with the streak’s own texts', async () => {
    mockVerifyExec
      .mockResolvedValueOnce(FAIL_LINT_1) // streak 1 — E501 in canlegal_bench/frozen_manifest.py:55 (+ a tests/ file)
      .mockResolvedValueOnce(FAIL_TEST_2) // streak 2 — scorecard 683≠478 in the step-9 citator rescrape
      .mockResolvedValueOnce(FAIL_LINT_3) // streak 3 — E501 in test_build_scorecard_all_12_tasks.py:318 → TRIP
      .mockResolvedValue(CHAIN_OK);
    mockRunModelTurn
      .mockResolvedValueOnce(verifyTurn(1))
      .mockResolvedValueOnce(verifyTurn(2))
      .mockResolvedValueOnce(verifyTurn(3))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // The breaker tripped and filed the streak for investigation — with the
    // REAL chain-failure texts, newest first (the 8579d419 capture-at-counting
    // mechanics), tool 'verify'.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('verify');
    expect(ev.recentFailures).toHaveLength(3);
    expect(ev.recentFailures).toEqual([FAIL_LINT_3, FAIL_TEST_2, FAIL_LINT_1]);
    for (const text of ev.recentFailures) {
      expect(text).toMatch(/^Verify FAILED at/);
    }
    // The filed evidence preserves the THREE DISTINCT project-side causes —
    // an investigation lane can see this was converging iteration through the
    // citator rescrape (new file:line each call), not an identical-refusal
    // stuck loop.
    expect(ev.recentFailures[2]).toContain('canlegal_bench/frozen_manifest.py:55');
    expect(ev.recentFailures[1]).toContain('case_treatment_classification: expected 683, got 478');
    expect(ev.recentFailures[0]).toContain('tests/test_build_scorecard_all_12_tasks.py:318');
    // The cross-checker consult receives the same pure evidence object.
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
  });

  it('a verify chain PASS mid-streak resets the count — no trip, no ticket (the breaker only fires on CONSECUTIVE failures)', async () => {
    mockVerifyExec
      .mockResolvedValueOnce(FAIL_LINT_1) // streak 1
      .mockResolvedValueOnce(FAIL_TEST_2) // streak 2
      .mockResolvedValueOnce(CHAIN_OK)    // the lane fixes the tree → success → streak RESETS
      .mockResolvedValueOnce(FAIL_LINT_3) // streak 1 (fresh) — never reaches 3
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
    for (const text of [FAIL_LINT_1, FAIL_TEST_2, FAIL_LINT_3]) {
      expect(looksLikeToolFailure(text)).toBe(true);
    }
    // Self-describing per the 251e9329 attribution gate: the lint texts name a
    // file:line in the lane's OWN project repo (a Digby framework deploy
    // cannot author ruff output there) — the advertised recovery path (fix
    // the named line, re-run) was real.
    expect(FAIL_LINT_1).toMatch(/canlegal_bench\/frozen_manifest\.py:55/);
    expect(FAIL_LINT_3).toMatch(/tests\/test_build_scorecard_all_12_tasks\.py:318/);
    // …and the 478/683 assertion pair is SELF-EXPLAINED inside the same
    // streak by the lane's own quoted comments: the frozen-manifest line names
    // both id families and both counts; the scorecard-test comment names the
    // grandfathering. No broken advertised recovery path anywhere.
    expect(FAIL_LINT_1).toContain('478 ct_* superseded/quarantined, 683 ctv3_* from citator mapping v3');
    expect(FAIL_TEST_2).toContain('expected 683, got 478');
    expect(FAIL_LINT_3).toContain('grandfathered legacy count');
    expect(looksLikeToolFailure(CHAIN_OK)).toBe(false);
  });
});

/**
 * Replay pin — ticket 6a950136 (mishap, breaker trip 2026-09-13, session
 * 619a1241-b080-4630-bfc3-5aa5456b1cd0 "Finding Flaws in Legal Bench Scores",
 * run cdd9dee4-797a-461f-b4fd-b6897513854c, auto-filed 23:24:18Z).
 *
 * THE INCIDENT: the canlegal-bench lane (a DIFFERENT repo — Python/pytest/ruff,
 * not this platform) was mid-merge of its PR #120 (38 conflicts resolved, CI
 * skip-gate fixes in flight, per its transcript) and called `verify` three
 * times consecutively. Each call faithfully ran THAT project's verify chain
 * and returned a truthful, DIFFERENT project-side failure:
 *   1. lint:  ruff E501 in tests/test_bilingual_manifest.py:203
 *   2. test:  pytest test_v1_lexical_grounding_none_parity — "tribunal_decision_qa:
 *      432 None-parity mismatches exceed the tighten-only ratchet 2 (regenerate
 *      grounding; do NOT raise the ratchet)" — a real consequence of the
 *      tribunal re-grade the lane had just landed on its own branch
 *   3. lint:  ruff E501 in tests/test_api_n_consistency.py:382 +
 *      tests/test_source_crosscheck.py:108
 * The verify envelope `^Verify FAILED at` is deliberately failure-shaped
 * (FAILURE_MARKERS, learnings-index.service.ts — run_command is the ONLY
 * exempt red-loop tool), so 3 consecutive chain failures tripped the derail
 * breaker: one-round withhold + one bounded cross-checker consult + exactly
 * ONE auto-filed investigation ticket (this one — Redis-NX deduped per
 * session+tool per 24h). The lane's run kept executing after the trip.
 *
 * ADJUDICATION (this lane, 2026-09-13): MODEL/PROJECT side, framework working
 * AS DESIGNED. Per the 251e9329 attribution rule ("BEFORE calling a
 * tool-failure streak model behavior, diff the refusal text against the tools
 * it names — a broken advertised recovery path is a deterministic framework
 * defect"):
 *   - Every filed text is self-describing and CORRECT: it names a file:line in
 *     the lane's OWN project repo (a Digby framework deploy cannot author ruff/
 *     pytest output there) and the ratchet failure names its exact remedy
 *     ("regenerate grounding; do NOT raise the ratchet").
 *   - No advertised recovery path was broken: the same lane fixed exactly this
 *     class of ruff failure earlier the same day (its firing-37 final: "Ruff
 *     failed (13 errors: 6 F601 + 7 E501) … fixed … ruff check . → All checks
 *     passed!").
 *   - The three causes DIFFER (lint file A → test ratchet → lint files B/C):
 *     the lane was converging through a large conflict-resolution merge, not
 *     stuck re-issuing an identical call against an identical refusal.
 * NO platform code change: this pin locks the intended counting (verify chain
 * failures ARE failure-shaped; a mid-streak PASS resets; ONE deduped ticket
 * carries the streak's own texts) so a future well-meaning "fix" cannot exempt
 * the verify envelope and blind the breaker to a lane that truly cannot get
 * its chain green — while replaying the incident end-to-end through the real
 * agent loop (the REAL looksLikeToolFailure runs; only the model, the tool
 * executor, and the streak consult/filing are mocked).
 *
 * Scaffold mirrors agent-derail-break.b61fb6c9.test.ts (same mock set). The
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

// ── 6a950136's filed "Failure texts" — verbatim, in CHRONOLOGICAL call order
// (the ticket lists newest first). Each is the canlegal-bench lane's OWN
// toolchain speaking (ruff / pytest), tailed by the verify tool.
const FAIL_LINT_1 =
  'Verify FAILED at "lint": ✓ typecheck (exit 0)  ✗ lint (exit 1)\n'
  + '--- lint output tail ---\n'
  + 'E501 Line too long (168 > 100)\n'
  + '   --> tests/test_bilingual_manifest.py:203:101\n'
  + '    |\n201 | …on_holding\n202 | …records\n'
  + '203 | …ep-8 rebuild (GH #91): +180 regenerated tr2_* records (6 curated carry, task SCORED again) → 15,469.\n'
  + '    |                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n'
  + '204 | …\n205 | …\n    |\n\nFound 1 error.\n';
const FAIL_TEST_2 =
  'Verify FAILED at "test": ✓ typecheck (exit 0)  ✓ lint (exit 0)  ✗ test (exit 1)\n'
  + '--- test output tail ---\n'
  + 'tests/test_grounding_currency.py:196: in test_v1_lexical_grounding_none_parity\n'
  + '    assert not over, "\\n".join(over)\n'
  + 'E   AssertionError: tribunal_decision_qa: 432 None-parity mismatches exceed the tighten-only ratchet 2 '
  + '(regenerate grounding; do NOT raise the ratchet). First offenders:\n'
  + 'E     claude-fable-5/tribunal_decision_qa:trib_002 stored=None current=0.0\n'
  + 'E     claude-fable-5/tribunal_deci';
const FAIL_LINT_3 =
  'Verify FAILED at "lint": ✓ typecheck (exit 0)  ✗ lint (exit 1)\n'
  + '--- lint output tail ---\n'
  + 'E501 Line too long (457 > 100)\n'
  + '   --> tests/test_api_n_consistency.py:382:101\n'
  + '    |\n380 | …\n381 | …\n'
  + '382 | … policy above (scorecard sample_len 7,911 superse…e cells re-integrate (GH #91 todo 9f59d2a3).\n'
  + '    |       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^…^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n'
  + '383 | …\n384 | …\n    |\n\n'
  + 'E501 Line too long (163 > 100)\n'
  + '   --> tests/test_source_crosscheck.py:108:101\n'
  + '    |\n1';
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
  worktree: '/tmp/derail-6a950136-test',
  sessionId: 'sess-6a950136',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'merge the PR',
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

describe('ticket 6a950136 — verify chain failures are failure-shaped BY DESIGN (breaker as designed)', () => {
  it('the incident replayed: 3 consecutive DIFFERENT verify chain-failures trip the breaker once, filing ONE ticket with the streak’s own texts', async () => {
    mockVerifyExec
      .mockResolvedValueOnce(FAIL_LINT_1) // streak 1 — E501 in test_bilingual_manifest.py:203
      .mockResolvedValueOnce(FAIL_TEST_2) // streak 2 — grounding ratchet in test_grounding_currency.py:196
      .mockResolvedValueOnce(FAIL_LINT_3) // streak 3 — E501 in test_api_n_consistency.py:382 + test_source_crosscheck.py:108 → TRIP
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
    // an investigation lane can see this was converging iteration through a
    // merge (new file:line each call), not an identical-refusal stuck loop.
    expect(ev.recentFailures[2]).toContain('tests/test_bilingual_manifest.py:203');
    expect(ev.recentFailures[1]).toContain('tests/test_grounding_currency.py:196');
    expect(ev.recentFailures[1]).toContain('regenerate grounding; do NOT raise the ratchet');
    expect(ev.recentFailures[0]).toContain('tests/test_api_n_consistency.py:382');
    expect(ev.recentFailures[0]).toContain('tests/test_source_crosscheck.py:108');
    // The cross-checker consult receives the same pure evidence object.
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
    // DW-4 (ticket 092382fd / 568d3652 gap): the paired ARGS of those failing
    // calls ride the same payload — captured at counting time, newest first,
    // cap 3 — so an investigation lane never needs a transcript probe to see
    // WHAT the streak kept calling. These turns pass '{}' (verify takes no
    // args); the pin is the PAIRING mechanics: three texts, three args, same
    // order, same consult object.
    expect(ev.recentArgs).toEqual(['{}', '{}', '{}']);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentArgs).toEqual(ev.recentArgs);
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
      // Self-describing per the 251e9329 attribution gate: every text names a
      // file:line in the lane's OWN project — the advertised recovery path
      // (fix the named line / regenerate the named grounding) was real.
      expect(text).toMatch(/tests\/test_\w+\.py:\d+/);
    }
    expect(looksLikeToolFailure(CHAIN_OK)).toBe(false);
    // …and the ratchet failure even names its exact remedy — no broken
    // advertised recovery path anywhere in this streak.
    expect(FAIL_TEST_2).toContain('regenerate grounding; do NOT raise the ratchet');
  });
});

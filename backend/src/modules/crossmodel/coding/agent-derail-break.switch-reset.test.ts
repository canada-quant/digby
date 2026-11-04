/**
 * Replay pin — PR #1250 review residual (DW-4, tickets 092382fd / 568d3652):
 * the tool-switch streak RESET must clear the captured ARGS with the texts.
 *
 * THE HAZARD this pin locks (found in PR #1250 review, 2026-10-04): the DW-4
 * capture (`failStreakArgs`, agent.ts counting site) pushes the failing call's
 * args beside its text, but the tool-switch arm — `else { failStreakTool =
 * tc.name; failStreakCount = 1; failStreakTexts = []; … }` — originally reset
 * ONLY the texts, leaving the PREVIOUS tool's captured args alive in the slot.
 * When the new tool then trips on fewer than 3 of its own failures (the
 * fast-trip weights make that reachable on the second call), the trip
 * snapshot moves BOTH slots into the notice together — and the investigation
 * evidence would carry tool A's args under tool B's name. An investigation
 * lane reading `recentArgs` (the exact DW-4 promise: "WHAT the streak kept
 * calling") would be pointed at the WRONG calls: tool B's args missing, tool
 * A's args attributed to B. That is evidence MISATTRIBUTION, the same class
 * the 251e9329 attribution rule guards on the text side. The cap-3 slot
 * makes a plain 3-failure trip EVICT A's args (newest-3 wins), so the hazard
 * is only reachable via a fast-trip weight — which is why this pin drives the
 * intent-mismatch weight (+1) on B's second failure.
 *
 * THE REPLAY SHAPE (exact, through the real agent loop):
 *   1. tool A (`verify`, an extra tool with a scripted executor double — the
 *      6a950136 idiom) fails 2× — args [A2, A1] captured beside texts, cap-3
 *      not reached, no trip (A maxes at count 2).
 *   2. tool B (`streak_probe_b`, a second extra-tool double standing in for
 *      any failing tool; its executor returns the platform refusal envelope
 *      shape `{"ok": false, …}` — FAILURE_MARKERS entry 2) fails on its FIRST
 *      call (count 1), then on its SECOND call the intent-mismatch weight
 *      fires: the turn's reasoning names OTHER offered tools (search_code_
 *      semantic / search_memory / streak_grep_c) while the call is B ⇒ +1 ⇒
 *      count 3 → TRIP with only 2 pushes.
 *   3. WITHOUT the fix: B's trip snapshot rides [B2, B1, A2] — A's stale args
 *      at index 2, and the pairing invariant "args[i] pairs with texts[i]"
 *      is broken ([B2,B1,A2] vs texts [B2,B1]). WITH the fix: the switch
 *      resets args ⇒ B's own [B2, B1] only, pairing holds.
 *
 * The breaker is NOT mocked: only runModelTurn, the tool executors, and the
 * reflection consult/file seams are doubles (same mock set as
 * agent-derail-break.6a950136.test.ts — the scaffold this mirrors).
 * `looksLikeToolFailure` runs REAL (learnings-index.service), so B's refusal
 * text must genuinely match a FAILURE_MARKER — hence the `{"ok": false, …}`
 * envelope. (The STREAK_ARGS_CAPTURE_DISABLED kill switch was deleted with
 * RSW-1 cluster 29 — the args capture this file exercises is now
 * unconditional. DERAIL_REANCHOR_DISABLED was deleted with RSW-1 cluster 32,
 * so re-anchor leg (b) now always arms — the +1 intent weight was never gated
 * and this file's assertions are on the DW-4 args evidence, not the steer.)
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

// ── tool A: verify (extra tool, scripted executor double — same shape as the
// 6a950136 scaffold). Args are IDENTIFIABLE per call so the pin can assert
// WHICH tool's args survived the switch. 'Verify FAILED at' is FAILURE_MARKER
// entry 3 (proven live by the 6a950136 pin).
const FAIL_VERIFY_1 =
  'Verify FAILED at "lint": ✓ typecheck (exit 0)  ✗ lint (exit 1)\n'
  + '--- lint output tail ---\n'
  + 'E501 Line too long (168 > 100)\n'
  + '   --> tests/test_bilingual_manifest.py:203:101\n'
  + 'Found 1 error.\n';
const FAIL_VERIFY_2 =
  'Verify FAILED at "test": ✓ typecheck (exit 0)  ✓ lint (exit 0)  ✗ test (exit 1)\n'
  + '--- test output tail ---\n'
  + 'tests/test_grounding_currency.py:196: in test_v1_lexical_grounding_none_parity\n'
  + 'E   AssertionError: tribunal_decision_qa: 432 None-parity mismatches exceed the tighten-only ratchet 2 (regenerate grounding; do NOT raise the ratchet)\n'
  + 'Found 1 error.\n';
const CHAIN_OK = 'Verify OK — all stages passed (typecheck, lint, test)';

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

// ── tool B: streak_probe_b — a second extra-tool double standing in for any
// failing tool. Its executor returns the platform refusal envelope shape
// (`{"ok": false, …}` — FAILURE_MARKERS entry 2, no needsConfirmation), so the
// REAL looksLikeToolFailure counts it. Texts differ per call so the
// identical-call repeat breaker stays out of the replay.
const FAIL_PROBE_B1 = '{"ok": false, "error": "seam not found: b1 (resolves at the worktree root)"}';
const FAIL_PROBE_B2 = '{"ok": false, "error": "seam not found: b2 (resolves at the worktree root)"}';
const mockProbeBExec: jest.Mock = jest.fn();
const PROBE_B_EXTRA_TOOL = {
  schema: {
    type: 'function' as const,
    function: {
      name: 'streak_probe_b',
      description: 'test double of a failing platform tool',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: (...a: any[]) => mockProbeBExec(...a),
};

// ── tool C: streak_grep_c — offered but never called; its name is one of the
// intent-weight candidates B's second-turn reasoning names (see below).
const mockProbeCExec: jest.Mock = jest.fn();
const PROBE_C_EXTRA_TOOL = {
  schema: {
    type: 'function' as const,
    function: {
      name: 'streak_grep_c',
      description: 'test double of an offered-but-uncalled tool',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: (...a: any[]) => mockProbeCExec(...a),
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-switch-reset-test',
  sessionId: 'sess-switch-reset',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'land the review residual',
  extraTools: [VERIFY_EXTRA_TOOL, PROBE_B_EXTRA_TOOL, PROBE_C_EXTRA_TOOL],
  emit: jest.fn(),
});

/** A turn calling verify (tool A) once, with IDENTIFIABLE args. */
const verifyTurn = (n: number, args: string) => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `v${n}`, name: 'verify', arguments: args }],
  finishReason: 'tool_calls',
});

/**
 * A turn calling streak_probe_b (tool B) once with IDENTIFIABLE args.
 * `weighted` = the turn's reasoning names OTHER offered tools (search_code_
 * semantic / search_memory / streak_grep_c) while the call is B and never
 * names B itself — detectIntendedToolChannels' conviction shape, +1 weight.
 * The reasoning NEVER contains the words "streak" + "probe b" together (the
 * prose self-naming acquittal, 7b2a0969) nor the literal 'streak_probe_b'.
 */
const probeTurn = (n: number, args: string, weighted: boolean) => ({
  content: '',
  reasoning: weighted
    ? 'The index would locate this seam faster — search_code_semantic covers the whole repo by meaning, search_memory holds the durable notes, and streak_grep_c prints the raw matching lines.'
    : 'Reading the b-seam location directly now.',
  toolCalls: [{ id: `p${n}`, name: 'streak_probe_b', arguments: args }],
  finishReason: 'tool_calls',
});

const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('PR #1250 review residual — tool-switch streak reset must clear the captured ARGS (DW-4 evidence integrity)', () => {
  it('the hazard replayed: A fails 2×, B trips fast on its 2nd failure — B’s notice carries ONLY B’s args (no stale A args, pairing invariant holds)', async () => {
    // A = verify: two consecutive failures — count 2, texts [A2, A1], args
    // [A2, A1]. No trip (the plain ladder needs 3).
    mockVerifyExec
      .mockResolvedValueOnce(FAIL_VERIFY_1) // A fail 1 — args '{"label":"A1"}'
      .mockResolvedValueOnce(FAIL_VERIFY_2) // A fail 2 — args '{"label":"A2"}'
      .mockResolvedValue(CHAIN_OK);
    // B = streak_probe_b: fail 1 (count 1, args [B1]), then fail 2 WITH the
    // intent-mismatch weight (reasoning names other offered tools) ⇒
    // 1 + 1 + 1 = 3 → TRIP on the second push.
    mockProbeBExec
      .mockResolvedValueOnce(FAIL_PROBE_B1) // B fail 1 — args '{"probe":"b1"}'
      .mockResolvedValueOnce(FAIL_PROBE_B2); // B fail 2 + intent weight → TRIP
    mockRunModelTurn
      .mockResolvedValueOnce(verifyTurn(1, '{"label":"A1"}'))
      .mockResolvedValueOnce(verifyTurn(2, '{"label":"A2"}'))
      .mockResolvedValueOnce(probeTurn(1, '{"probe":"b1"}', false))
      .mockResolvedValueOnce(probeTurn(2, '{"probe":"b2"}', true))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // B tripped (A never did — it maxed at count 2), filing exactly ONE
    // investigation for tool B with B's own 2 texts, newest first.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('streak_probe_b');
    expect(ev.recentFailures).toHaveLength(2);
    expect(ev.recentFailures).toEqual([FAIL_PROBE_B2, FAIL_PROBE_B1]);
    // THE DISCRIMINATOR: with the reset fix, B's args are exactly B's own 2,
    // newest first — A's stale args are GONE. (Without the fix the slot kept
    // [A2, A1] across the switch, so B's two pushes rode [B2, B1, A2] into
    // the notice: A's arg attributed to B, and the pairing invariant broken
    // — 3 args against 2 texts.)
    expect(ev.recentArgs).toEqual(['{"probe":"b2"}', '{"probe":"b1"}']);
    expect(ev.recentArgs).toHaveLength(ev.recentFailures.length);
    // No verify (tool A) args anywhere in B's evidence.
    for (const a of ev.recentArgs) expect(a).not.toMatch(/"A[12]"/);
    // The cross-checker consult receives the same pure evidence object.
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentArgs).toEqual(ev.recentArgs);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentArgs).toHaveLength(2);
  });
});

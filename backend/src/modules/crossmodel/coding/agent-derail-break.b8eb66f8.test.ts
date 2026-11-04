/**
 * Replay pin — ticket b8eb66f8-5f78-4ce9-9988-e340929a451f (mishap, auto-filed
 * 2026-10-09T18:43:55.401Z, "first streak this run", tool `verify`).
 *
 * THE INCIDENT: Framework-Operator-adjacent lane session f0dd977c-93ec-43be-
 * be94-504512a14387, run 4904d78b-d5d1-49e4-aa37-28459de0ba49 (the 4f7263e4
 * live-chat first-word-latency audit), was closing out a probes/docs-only diff
 * and needed the verify chain green before open_pull_request would open the PR.
 * On this shared dev container the full chain (typecheck → lint → jest
 * --maxWorkers=2 over 1100+ suites; jest alone ~725 s) could not finish inside
 * the per-tool hard ceiling (agent.ts TOOL_HARD_TIMEOUT_MS = 15 min → the
 * "exceeded 900s and was aborted" backstop). Receipts of the run (get_run_
 * receipts, 2026-10-10): three model-invoked `verify` calls, each landing
 * ~900 s after the previous tool result —
 *   · 63eadd45 17:22:33Z (prior receipt 17:07:26Z)
 *   · 87baec75 18:04:43Z (prior receipt 17:49:19Z)
 *   · b74f5b3a 18:43:54Z (prior receipt 18:28:48Z)
 * all `ok:true, ids:{passed:false, failedStage:null}` (run-receipts.ts: the
 * verify verdict rides in ids; the abort text yields no "Verify FAILED at"
 * prefix). The ticket row was created 14 ms after the third — the breaker trip
 * itself. Interleaved with the aborts were three open_pull_request gate
 * refusals (0fa74afd 17:06:39Z, 3389ea11 18:15:35Z, 64500cd5 18:28:48Z) whose
 * envelope is the PR gate's deadline refusal — "PR blocked: … it did not
 * finish within 720s … Run `verify` (it waits for the chain) and call
 * open_pull_request again once it is green" (tools.ts pr-gate auto-verify
 * deadline path) — and run_command probes (name-exempt from the streak).
 *
 * ADJUDICATION (this lane, 2026-10-10, against primary sources): MODEL
 * behavior under real environmental capacity, harness AS DESIGNED — the
 * fourth pinned occurrence of the verify-streak class on main (6a950136 →
 * 02bf673a → 94ec8b5e → this; a sibling bare-abort adjudication, 6b878782,
 * was in flight on a parallel lane's branch as this pin landed), in its
 * bare-abort shape (21ee14ce adjudicated the same abort text for
 * send_chat_message):
 *   - No framework change created the class: the abort race predates the
 *     incident (f4c2d5673), and the adjacent queue-wait sub-class was fixed
 *     AFTER it (f4448a999, committed 2026-10-10T01:20:08Z — the queued-ms
 *     re-arm of tool-hard-timeout.ts — ~6.6 h after the last abort). The
 *     receipts show three live ~900 s calls that outlived the ceiling; they
 *     cannot by themselves distinguish execution from uncharged slot-queue
 *     wait (the pre-f4448a999 race charged both), but the chain's ~20-min
 *     runtime (jest alone ~725 s, per the incident lane's own final report)
 *     exceeded the 900 s ceiling on execution alone.
 *   - The breaker arithmetic is correct: three bare abort texts (no ungrounded
 *     ids, no intent mismatch — the model genuinely wanted verify each time,
 *     because the PR gate's refusal NAMES verify as the remedy) trip at
 *     exactly 3, withhold verify for one round, and file ONE ticket with the
 *     byte-exact texts + args ('{}' ×3, matching the ticket's "Call args").
 *   - The interleaved PR-gate refusals are streak-NEUTRAL by design — no
 *     FAILURE_MARKERS regex matches "PR blocked:" (learnings-index.service.ts)
 *     — which is WHY the streak stayed on `verify` across ~80 minutes instead
 *     of switching tools. Pinned below as a unit contract.
 *   - The designed recovery existed and was demonstrated by the SAME session's
 *     next run: per-stage verify (verify({only:['typecheck']}) → lint → test,
 *     each stage under the ceiling) went green and PR #1386 opened on
 *     bd77b21b with all six checks success. The lane also complied
 *     with the abort advisory in its final ("no more verify or
 *     open_pull_request calls this run") and kept shipping real work for 30
 *     min after the trip (commit d039ea06 19:14:48Z, push 19:15:00Z).
 * NO platform code change (per the 6a950136 doctrine: never exempt the verify
 * envelope — a lane that truly cannot get its chain green must stay visible).
 *
 * What this suite pins (the contracts this disposition rests on):
 *   (a) UNIT: the 900 s abort text is failure-shaped and carries the explicit
 *       do-not-retry advisory (the streak counter's input contract; the frozen
 *       literal is the byte-exact render of agent.ts:5244 for the 15-min
 *       constant — a future wording change updates this pin with it);
 *   (b) UNIT: the PR gate's "PR blocked:" deadline refusal is NOT
 *       failure-shaped — the load-bearing neutrality that kept the streak on
 *       verify across the interleaved gate attempts;
 *   (c) END-TO-END: three bare aborts interleaved with streak-neutral
 *       open_pull_request refusals and exempt run_command probes trip the
 *       breaker ONCE at count 3, filing exactly one investigation with the
 *       three byte-exact abort texts (newest first), args '{}', perma:false;
 *   (d) RECOVERY: post-trip (the one-round withhold's refusal envelope is
 *       pinned by sibling 21ee14ce — this suite's extra-tool replay seam
 *       bypasses the withheld pre-flight at agent.ts:5068, gated
 *       !isExtraTool), a later per-stage verify({only:['typecheck']})
 *       EXECUTES and its green result resets the streak with no second
 *       filing (the escape hatch the incident lane used the next run).
 *
 * Scaffold mirrors agent-derail-break.21ee14ce.test.ts (coding-kind profile)
 * and agent-derail-break.02bf673a.test.ts (the breaker counts RESULT TEXT, so
 * driving the abort bytes at the counting seam — an extra tool whose execute
 * returns the harness's own abort text — is exact; verify/run_command are
 * offered via input.extraTools, agent.ts:1176 matches extra tools first).
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
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn(), buildCodeMatchesBlock: jest.fn(async () => '') }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
// Coding-kind runs build the workspace context block at run start — stub every
// leg so the loop reaches the breaker, keeping the REAL looksLikeToolFailure.
jest.mock('./workspace.service', () => {
  const actual = jest.requireActual('./workspace.service');
  return { ...actual, buildRepoDivergenceNotice: jest.fn(async () => '') };
});
jest.mock('./learnings-index.service', () => {
  const actual = jest.requireActual('./learnings-index.service');
  return {
    ...actual,
    buildLearningsBlock: jest.fn(async () => ''),
    kickLearningsIndexSync: jest.fn(),
    sliceLearningsForInjection: jest.fn((s: string) => s),
    createFailureLearningNudger: jest.fn(() => async () => ''),
  };
});
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ""),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0), buildSessionMemoryInventory: jest.fn(async () => '') }));
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

const CODING_TEST_PROFILE: AgentProfile = {
  // Coding-kind, like the incident lane (a coding session with workspace
  // tools): verify / run_command / open_pull_request are all offered.
  kind: 'coding',
  maxSteps: 14,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: true,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim text (ticket b8eb66f8) ──────────────────────────
// The harness's own per-tool hard-timeout backstop, exactly as agent.ts:5244
// renders it for TOOL_HARD_TIMEOUT_MS = 15 * 60 * 1000 (900 s).
const ABORT_TEXT = 'Tool "verify" exceeded 900s and was aborted. Do not retry it; proceed with what you have.';
// The PR gate's deadline refusal (tools.ts pr-gate auto-verify path, 12-min
// default deadline): names `verify` as the remedy — the pull that kept the
// lane re-issuing verify against its own abort advisory.
const PR_GATE_REFUSAL =
  'PR blocked: the verify chain had not passed this session, so open_pull_request ran the chain itself '
  + '(typecheck → lint → test) — it did not finish within 720s (the verify-slot queue and/or the chain are '
  + 'still running in the background and will record their result). Run `verify` (it waits for the chain) '
  + 'and call open_pull_request again once it is green; nothing was pushed or opened.';
// The designed recovery the incident lane used the NEXT run: per-stage verify,
// each stage comfortably under the 900 s ceiling.
const PER_STAGE_GREEN = 'Verify PASSED: ✓ typecheck (exit 0)';

/** The verify double: a per-run extra tool whose execute replays the abort bytes at the counting seam. */
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
/** run_command double — the ONE name-exempt tool (agent.ts: "red test/build loops are legitimate iteration"). */
const mockShExec: jest.Mock = jest.fn();
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
  worktree: '/tmp/derail-b8eb66f8-test',
  sessionId: 'sess-b8eb66f8',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'Close out the 4f7263e4 probe work: get the verify chain green, then open the PR.',
  extraTools: [VERIFY_EXTRA_TOOL, SH_EXTRA_TOOL],
  emit: jest.fn(),
});

/** A turn calling verify (empty args — the ticket's "Call args: {}", no ids, no grounding preflight). */
const verifyTurn = (n: number, args = '{}') => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `v${n}`, name: 'verify', arguments: args }],
  finishReason: 'tool_calls',
});
/** A turn attempting the PR (a platform tool — flows through executeCodingTool, like the incident's gate attempts). */
const prTurn = (n: number) => ({
  content: '',
  reasoning: '',
  toolCalls: [{
    id: `p${n}`,
    name: 'open_pull_request',
    arguments: JSON.stringify({ title: 'audit(4f7263e4): first-word latency diagnosis', body: 'probes + learning' }),
  }],
  finishReason: 'tool_calls',
});
/** A shell probe turn (red or green — exempt from every streak either way). */
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

describe('replay b8eb66f8 — three bare verify 900s-aborts + streak-neutral PR-gate refusals trip the breaker once, as designed', () => {

  it('UNIT (a): the 900s abort text is failure-shaped and carries the do-not-retry advisory (the streak counter input contract)', () => {
    expect(looksLikeToolFailure(ABORT_TEXT)).toBe(true);
    expect(ABORT_TEXT).toMatch(/^Tool "verify" exceeded 900s and was aborted/);
    expect(ABORT_TEXT).toContain('Do not retry it; proceed with what you have.');
    // The 900 literal above is the byte-exact render of agent.ts:5244's
    // template for TOOL_HARD_TIMEOUT_MS = 15 * 60 * 1000 — the frozen-literal
    // replay convention (a reworded template updates this pin with it).
  });

  it('UNIT (b): the PR gate\'s "PR blocked:" deadline refusal is NOT failure-shaped — the neutrality that kept the streak on verify across the interleaved gate attempts', () => {
    expect(looksLikeToolFailure(PR_GATE_REFUSAL)).toBe(false);
    // The refusal names verify as the remedy — the pull the incident lane obeyed.
    expect(PR_GATE_REFUSAL).toContain('Run `verify` (it waits for the chain)');
  });

  it('UNIT: the per-stage green result is not failure-shaped (the recovery resets, never feeds, the streak)', () => {
    expect(looksLikeToolFailure(PER_STAGE_GREEN)).toBe(false);
  });

  it('END-TO-END (c): three bare aborts interleaved with neutral PR-gate refusals and exempt probes trip ONCE at count 3 — one filing, byte-exact texts, args \'{}\', perma:false', async () => {
    mockVerifyExec
      .mockResolvedValueOnce(ABORT_TEXT) // streak 1 — receipt 63eadd45 17:22:33Z
      .mockResolvedValueOnce(ABORT_TEXT) // streak 2 — receipt 87baec75 18:04:43Z
      .mockResolvedValueOnce(ABORT_TEXT) // streak 3 — receipt b74f5b3a 18:43:54Z → TRIP (ticket filed 18:43:55Z)
      .mockResolvedValue(PER_STAGE_GREEN); // the per-stage recovery (next-run shape, replayed in-run)
    mockExecuteCodingTool
      .mockResolvedValueOnce(PR_GATE_REFUSAL) // receipt 0fa74afd 17:06:39Z — neutral, and NAMES verify
      .mockResolvedValueOnce(PR_GATE_REFUSAL) // receipt 3389ea11 18:15:35Z
      .mockResolvedValueOnce(PR_GATE_REFUSAL) // receipt 64500cd5 18:28:48Z
      .mockResolvedValue('probe result: ok');
    mockShExec
      .mockResolvedValueOnce('jest manual probe: co-tenant CPU storm, loadavg 9.19\n[exit: 1]') // red probe — exempt by name
      .mockResolvedValue('tsc --noEmit manual probe: clean\n[exit: 0]');
    mockRunModelTurn
      .mockResolvedValueOnce(prTurn(1))      // PR attempt → REFUSAL (neutral; names verify as the remedy)
      .mockResolvedValueOnce(verifyTurn(2))  // ABORT → streak (verify, 1)
      .mockResolvedValueOnce(shTurn(3))      // red run_command probe — exempt (neither feeds nor launders)
      .mockResolvedValueOnce(verifyTurn(4))  // ABORT → streak (verify, 2)
      .mockResolvedValueOnce(prTurn(5))      // REFUSAL — neutral: the streak STAYS on verify
      .mockResolvedValueOnce(shTurn(6))      // green probe — exempt
      .mockResolvedValueOnce(prTurn(7))      // REFUSAL — neutral
      .mockResolvedValueOnce(verifyTurn(8))  // ABORT → TRIP at 3 (one-round withhold, ONE filing)
      .mockResolvedValueOnce(shTurn(9))      // post-trip real work continues (the incident: 30 min of probes + commit d039ea06)
      .mockResolvedValueOnce(shTurn(10))     // ban round consumed
      .mockResolvedValueOnce(verifyTurn(11, JSON.stringify({ only: ['typecheck'] }))) // per-stage recovery — EXECUTES, green, resets
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // Exactly ONE investigation filed, on the verify streak — with the three
    // byte-exact abort texts newest-first and the incident's '{}' args.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('verify');
    expect(ev.perma).toBe(false);
    expect(ev.intended).toBeNull();
    expect(ev.recentFailures).toEqual([ABORT_TEXT, ABORT_TEXT, ABORT_TEXT]);
    expect(ev.recentFailures[0]).toBe('Tool "verify" exceeded 900s and was aborted. Do not retry it; proceed with what you have.');
    expect(ev.recentArgs).toEqual(['{}', '{}', '{}']);
    // The cross-checker consult receives the same pure evidence object.
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
    // The streak stayed on VERIFY — the interleaved PR-gate refusals neither
    // switched it (they are not failure-shaped) nor reset it (they are not
    // verify successes). executeCodingTool(ctx, name, args): name rides arg 1.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(3);
    for (const call of mockExecuteCodingTool.mock.calls) {
      expect(call[1]).toBe('open_pull_request');
      expect(String(call[0]?.agentSurface)).toBe('coding');
    }
    // All four verify emissions executed at the counting seam (3 aborts + the
    // per-stage recovery) — the trip withheld verify for exactly one round.
    expect(mockVerifyExec).toHaveBeenCalledTimes(4);
  });

  it('RECOVERY (d): post-trip, the later per-stage verify({only}) EXECUTES and its green resets the streak — no second filing (the withhold refusal itself is pinned by sibling 21ee14ce; the extra-tool seam bypasses the withheld pre-flight)', async () => {
    mockVerifyExec
      .mockResolvedValueOnce(ABORT_TEXT)
      .mockResolvedValueOnce(ABORT_TEXT)
      .mockResolvedValueOnce(ABORT_TEXT) // trip
      .mockResolvedValueOnce(PER_STAGE_GREEN); // recovery call — must EXECUTE
    mockShExec.mockResolvedValue('ok');
    mockRunModelTurn
      .mockResolvedValueOnce(verifyTurn(1))  // ABORT → 1
      .mockResolvedValueOnce(verifyTurn(2))  // ABORT → 2
      .mockResolvedValueOnce(verifyTurn(3))  // ABORT → 3 → TRIP (withhold begins)
      .mockResolvedValueOnce(shTurn(4))      // ban round consumed by real work
      .mockResolvedValueOnce(shTurn(5))      // withhold window closed
      .mockResolvedValueOnce(verifyTurn(6, JSON.stringify({ only: ['typecheck'] }))) // per-stage — EXECUTES, green, streak resets
      .mockResolvedValueOnce(verifyTurn(7, JSON.stringify({ only: ['lint'] })))      // still green — no second trip
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockVerifyExec).toHaveBeenCalledTimes(5); // 3 aborts + 2 per-stage greens — none lost to a perma-withhold
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1); // the FIRST trip only
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.perma).toBe(false); // first streak: one-round withhold, the lane keeps its tool
  });
});

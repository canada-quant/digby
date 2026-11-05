/**
 * Replay pin — ticket 0022cb16-0730-45b7-bf03-b7f90ecc03dc (mishap, auto-filed
 * 2026-10-09T20:52:22.546Z, "first streak this run", tool `verify`).
 *
 * THE INCIDENT: Windows-shell lane session 40b27519-bfb9-4898-af6a-
 * 2826cf4d95ad, run 27c76183-78e0-407a-9302-a065e28ff714 (the Windows shell
 * spin-on-open fix — unbounded WebView2 init awaits + spinner-clear race), was
 * closing out a 14-file / +792-line diff and needed the verify chain green
 * before open_pull_request would open the PR. On the shared dev container (the
 * same 2026-10-09 17–21Z co-tenant storm window as siblings b8eb66f8 /
 * 6b878782 / 98ebfc78) the full chain (typecheck → lint → jest --maxWorkers=2
 * over 1100+ suites) could not finish inside the per-tool hard ceiling
 * (agent.ts TOOL_HARD_TIMEOUT_MS = 15 min → the "exceeded 900s and was
 * aborted" backstop, agent.ts:5244). Receipts of the run (get_run_receipts,
 * 2026-10-10): three model-invoked `verify` calls, each landing ~900 s after
 * the previous tool result —
 *   · 10129531 18:45:12Z (prior receipt 3ebd2128 18:30:05Z — 907 s)
 *   · fd920a95 19:50:37Z (prior receipt ca3feb1c 19:35:14Z — 923 s)
 *   · 7d1e595c 20:52:21Z (prior receipt 48c6e701 20:37:04Z — 916.5 s; the
 *     whole-second faces round to 917)
 * all `ok:true, ids:{passed:false, failedStage:null}` (run-receipts.ts: the
 * verify verdict rides in ids; the abort text yields no "Verify FAILED at"
 * prefix). The ticket row was created 1.3 s after the third — the breaker trip
 * itself. Interleaved with the aborts were FIVE open_pull_request gate
 * refusals (6f359a60 19:24:27Z, ca3feb1c 19:35:14Z, 0fe3b170 20:04:14Z,
 * 232aadaa 20:17:51Z, 48c6e701 20:37:04Z) whose envelope is the PR gate's
 * deadline refusal — "PR blocked: … it did not finish within 720s … Run
 * `verify` (it waits for the chain) …" — plus run_command probes, red AND
 * green (ok:false legs e456adec 20:06:11Z, 686551dc 20:22:27Z, 1a0d5205
 * 20:56:52Z — the exempt red-test-loop class; agent.ts exempts run_command
 * from every streak so legitimate red probes never launder OR feed it).
 *
 * ADJUDICATION (this lane, 2026-10-10, against primary sources): MODEL
 * behavior under real environmental capacity, breaker AS DESIGNED — the fifth
 * pinned occurrence of the verify-streak class in the serial lineage b8eb66f8
 * counted (6a950136 → 02bf673a → 94ec8b5e → b8eb66f8 → this; the parallel
 * adjudications of the same storm window, 98ebfc78 / 6b878782, landed as
 * class pins of their own), in its bare-abort + PR-gate-pull shape
 * (b8eb66f8's exact idiom, one lane over in the same storm window):
 *   - No framework change created the class: `git log -S 'exceeded 900s and
 *     was aborted'` over the authoring files (agent.ts, verify.service.ts,
 *     tool-hard-timeout.ts) since 2026-10-01 returns ONLY f4448a999 — the
 *     mitigation itself. The abort race predates the incident (f4c2d5673).
 *   - The breaker arithmetic is correct: three bare abort texts (the model
 *     genuinely wanted verify each time — the gate refusals NAME verify as the
 *     remedy) trip at exactly 3, withhold verify for one round, and file ONE
 *     ticket with the byte-exact texts + args ('{}' ×3, matching the ticket's
 *     "Call args").
 *   - The interleaved PR-gate refusals are streak-NEUTRAL by design — no
 *     FAILURE_MARKERS regex matches "PR blocked:" (learnings-index.service.ts)
 *     — which is WHY the streak stayed on `verify` across ~2 h 7 min of
 *     interleaved work instead of switching tools.
 *   - THE CAPACITY CLASS behind it (N lanes' verify chains stacking in ONE
 *     shared dev container until the memory-cgroup OOM killer takes tsc/jest —
 *     f4448a999 documents kills at 17:30 / 19:21 / 19:24Z, this streak's
 *     window; the container sat at 15.4 GiB / 405% CPU) was fixed by f4448a999
 *     ("per-container verify-chain slot limit — box C cgroup OOM"), committed
 *     2026-10-10T01:20:08Z TRUE UTC (its git face "2026-10-09 18:20:08 -0700"
 *     is Pacific — the 6b878782 clock trap) — 4 h 28 min AFTER this ticket's
 *     filing, ~10 h BEFORE this lane's dispatch (2026-10-10T11:29:24Z). The
 *     ticket reached the lane already solved at the CLASS level: close by
 *     pinning, not re-fixing (the 6b878782 idiom).
 *   - THE MODEL SELF-HEALED — and this run's recovery is the distinctive leg:
 *     unlike b8eb66f8 (whose lane re-issued verify twice against its own
 *     abort advisory), THIS lane COMPLIED with the "Do not retry it" advisory
 *     — ZERO further verify calls post-trip — and recovered through the PR
 *     gate's own background auto-verify: the sixth open_pull_request
 *     (26e3c4db 21:09:11Z, 16 min 50 s after the trip) found the chain green
 *     and OPENED PR #1384 (merged squash cb5da77337fc — GitHub mergedAt
 *     21:37:07Z, the merge receipt 9c372e78 landed 21:37:09Z; deploy run
 *     37996093973 success; the Windows installer 1.0.1 shipped, served from
 *     digby.ai). The work the streak interrupted landed in full.
 * NO platform code change (per the 6a950136 doctrine: never exempt the verify
 * envelope — a lane that truly cannot get its chain green must stay visible).
 *
 * What this suite pins (the disposition this ticket rests on):
 *   (a) UNIT: the 900 s abort text is failure-shaped and carries the explicit
 *       do-not-retry advisory (the streak counter's input contract; the frozen
 *       literal is the byte-exact render of agent.ts:5244 for the 15-min
 *       constant — a future wording change updates this pin with it);
 *   (b) UNIT: the PR gate's "PR blocked:" deadline refusal is NOT
 *       failure-shaped — the load-bearing neutrality that kept the streak on
 *       verify across FIVE interleaved gate attempts;
 *   (c) END-TO-END: three bare aborts interleaved with five streak-neutral
 *       open_pull_request refusals and exempt (red and green) run_command
 *       probes trip the breaker ONCE at count 3, filing exactly one
 *       investigation with the three byte-exact abort texts (newest first),
 *       args '{}', perma:false;
 *   (d) RECOVERY — the distinctive leg: post-trip the model issues NO further
 *       verify call (advisory compliance) and the next open_pull_request,
 *       backed by the gate's own background auto-verify going green, SUCCEEDS
 *       and opens the PR — no second filing, the streak never grows;
 *   (e) CLASS pin: the f4448a999 capacity fix is on this branch — the shared
 *       dev container's 22.8 GiB cap admits exactly 3 concurrent verify chains
 *       (the slot semaphore that de-collisions the co-tenant storm that
 *       produced this class; the queued-ms hard-timer re-arm is pinned by
 *       sibling verify-env-streak.6b878782.test.ts, the class's own suite);
 *   (f) the self-heal's artifact: the PR #1384 pin suites and the 1.0.1
 *       windows feed exist on this branch and carry the fix markers — the
 *       work the streak interrupted landed, verified.
 *
 * Scaffold mirrors agent-derail-break.b8eb66f8.test.ts (the bare-abort
 * sibling, one lane over in the same storm window): coding-kind profile, the
 * breaker counts RESULT TEXT, so driving the abort bytes at the counting seam
 * (an extra tool whose execute returns the harness's own abort text) is exact;
 * verify/run_command are offered via input.extraTools (agent.ts matches extra
 * tools first).
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
import { verifySlotsForCap, VERIFY_STAGE_PEAK_BYTES, VERIFY_SLOT_HEADROOM } from './verify-container-slots';

const CODING_TEST_PROFILE: AgentProfile = {
  // Coding-kind, like the incident lane (a coding session with workspace
  // tools): verify / run_command / open_pull_request are all offered.
  kind: 'coding',
  maxSteps: 22,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: true,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim text (ticket 0022cb16) ──────────────────────────
// The harness's own per-tool hard-timeout backstop, exactly as agent.ts:5244
// renders it for TOOL_HARD_TIMEOUT_MS = 15 * 60 * 1000 (900 s).
const ABORT_TEXT = 'Tool "verify" exceeded 900s and was aborted. Do not retry it; proceed with what you have.';
// The PR gate's deadline refusal (tools.ts pr-gate auto-verify path, 12-min
// default deadline): names `verify` as the remedy — the pull the incident lane
// kept obeying across FIVE gate attempts.
const PR_GATE_REFUSAL =
  'PR blocked: the verify chain had not passed this session, so open_pull_request ran the chain itself '
  + '(typecheck → lint → test) — it did not finish within 720s (the verify-slot queue and/or the chain are '
  + 'still running in the background and will record their result). Run `verify` (it waits for the chain) '
  + 'and call open_pull_request again once it is green; nothing was pushed or opened.';
// The recovery this incident lane used IN-RUN: no further verify call at all —
// the sixth open_pull_request found the gate's own background auto-verify
// green and opened PR #1384 (receipt 26e3c4db, 21:09:11Z). Frozen in the
// PLATFORM'S REAL render: tools.ts:2844 `Opened PR #${created.number}:
// ${created.url}` plus the [PR DIFF] tail in pr-diff-shape.ts's format with
// the receipt's real numbers (14 file(s), +792/−36, hash d51a6549f99a3ad5).
const GATE_GREEN =
  'Opened PR #1384: https://github.com/example-org/crossmodel/pull/1384\n'
  + '[PR DIFF] 14 file(s) · +792/−36 · code · hash d51a6549f99a3ad5';

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
  worktree: '/tmp/derail-0022cb16-test',
  sessionId: 'sess-0022cb16',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'Ship the Windows shell spin-on-open fix: get the verify chain green, then open the PR.',
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
    arguments: JSON.stringify({
      // The incident PR's REAL title (primary source: gh pr view 1384).
      title: 'fix(windows): shell spins forever on open — bounded bootstrap + honest startup states',
      body: 'StartupPanel + WithTimeout + boot logging + feed 1.0.1',
    }),
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

describe('replay 0022cb16 — three bare verify 900s-aborts + five streak-neutral PR-gate refusals trip the breaker once; advisory-compliance recovery', () => {

  it('UNIT (a): the 900s abort text is failure-shaped and carries the do-not-retry advisory (the streak counter input contract)', () => {
    expect(looksLikeToolFailure(ABORT_TEXT)).toBe(true);
    expect(ABORT_TEXT).toMatch(/^Tool "verify" exceeded 900s and was aborted/);
    expect(ABORT_TEXT).toContain('Do not retry it; proceed with what you have.');
    // The 900 literal above is the byte-exact render of agent.ts:5244's
    // template for TOOL_HARD_TIMEOUT_MS = 15 * 60 * 1000 — the frozen-literal
    // replay convention (a reworded template updates this pin with it).
  });

  it('UNIT (b): the PR gate\'s "PR blocked:" deadline refusal is NOT failure-shaped — the neutrality that kept the streak on verify across FIVE interleaved gate attempts', () => {
    expect(looksLikeToolFailure(PR_GATE_REFUSAL)).toBe(false);
    // The refusal names verify as the remedy — the pull the incident lane obeyed.
    expect(PR_GATE_REFUSAL).toContain('Run `verify` (it waits for the chain)');
  });

  it('UNIT: the gate-green recovery result is not failure-shaped (the recovery neither feeds nor launders the streak) — frozen in the PLATFORM\'S REAL render, and generalized beyond the incident\'s exact shape', () => {
    // The frozen incident shape: tools.ts:2844 `Opened PR #${number}: ${url}`
    // + the pr-diff-shape.ts [PR DIFF] tail, with the receipt's real numbers.
    expect(looksLikeToolFailure(GATE_GREEN)).toBe(false);
    expect(GATE_GREEN).toContain('Opened PR #1384: https://github.com/example-org/crossmodel/pull/1384');
    // Generalization — the contract must hold on shapes the incident did NOT
    // produce (other PR numbers, larger/smaller diffs, docs-only waves): a
    // success render is never failure-shaped regardless of its numbers.
    for (const s of [
      'Opened PR #629: https://github.com/example-org/crossmodel/pull/629',
      'Opened PR #1410: https://github.com/example-org/crossmodel/pull/1410\n[PR DIFF] 3 file(s) · +120/−4 · docs-only, unverified · README.md',
      'Opened PR #2: https://github.com/example-org/crossmodel/pull/2\n[PR DIFF] 1 file(s) · +1/−1 · code · hash abcdef0123456789 · a.ts',
      'Opened PR #1384: https://github.com/example-org/crossmodel/pull/1384\n[PR DIFF] 14 file(s) · +810/−36 · code',
    ]) {
      expect(looksLikeToolFailure(s)).toBe(false);
    }
    // Control: the contract still discriminates next to the class's own texts.
    expect(looksLikeToolFailure(ABORT_TEXT)).toBe(true);
  });

  it('END-TO-END (c): three bare aborts interleaved with FIVE neutral PR-gate refusals and exempt red/green probes trip ONCE at count 3 — one filing, byte-exact texts, args \'{}\', perma:false', async () => {
    mockVerifyExec
      .mockResolvedValueOnce(ABORT_TEXT) // streak 1 — receipt 10129531 18:45:12Z
      .mockResolvedValueOnce(ABORT_TEXT) // streak 2 — receipt fd920a95 19:50:37Z
      .mockResolvedValueOnce(ABORT_TEXT) // streak 3 — receipt 7d1e595c 20:52:21Z → TRIP (ticket filed 20:52:22Z)
      .mockResolvedValue('Verify PASSED: ✓ typecheck (exit 0)'); // canary — a 4th verify would break the count below
    mockExecuteCodingTool
      .mockResolvedValueOnce(PR_GATE_REFUSAL) // receipt 6f359a60 19:24:27Z — neutral, and NAMES verify
      .mockResolvedValueOnce(PR_GATE_REFUSAL) // receipt ca3feb1c 19:35:14Z
      .mockResolvedValueOnce(PR_GATE_REFUSAL) // receipt 0fe3b170 20:04:14Z
      .mockResolvedValueOnce(PR_GATE_REFUSAL) // receipt 232aadaa 20:17:51Z
      .mockResolvedValueOnce(PR_GATE_REFUSAL) // receipt 48c6e701 20:37:04Z
      .mockResolvedValue(GATE_GREEN);         // receipt 26e3c4db 21:09:11Z — PR #1384 OPENED
    mockShExec
      .mockResolvedValueOnce('installer probe: artifact digby-windows-cb5da773…\n[exit: 0]')  // green probe — exempt
      .mockResolvedValueOnce('grep probe: Chrome/131 still in the staged binary\n[exit: 1]')  // red probe — exempt by name
      .mockResolvedValueOnce('feed probe: windows-latest.json 1.0.1\n[exit: 0]')
      .mockResolvedValueOnce('byte probe: cmp differs, expected pre-deploy\n[exit: 1]')       // red — exempt
      .mockResolvedValueOnce('log probe: boot milestones present\n[exit: 0]')
      .mockResolvedValue('post-trip probe: digby.ai/Digby-Setup.exe 74,850,282 B\n[exit: 1]'); // receipt 1a0d5205 20:56:52Z (ok:false)
    mockRunModelTurn
      .mockResolvedValueOnce(verifyTurn(1))  // ABORT → streak (verify, 1)
      .mockResolvedValueOnce(shTurn(2))      // green probe — exempt (the 19:11–19:24 real work)
      .mockResolvedValueOnce(prTurn(3))      // PR attempt → REFUSAL (neutral; names verify)
      .mockResolvedValueOnce(prTurn(4))      // PR attempt → REFUSAL (neutral)
      .mockResolvedValueOnce(verifyTurn(5))  // ABORT → streak (verify, 2)
      .mockResolvedValueOnce(prTurn(6))      // PR attempt → REFUSAL (neutral)
      .mockResolvedValueOnce(shTurn(7))      // RED probe — exempt (receipt e456adec, ok:false)
      .mockResolvedValueOnce(shTurn(8))      // green probe — exempt
      .mockResolvedValueOnce(prTurn(9))      // PR attempt → REFUSAL (neutral)
      .mockResolvedValueOnce(shTurn(10))     // RED probe — exempt (receipt 686551dc, ok:false)
      .mockResolvedValueOnce(shTurn(11))     // green probe — exempt
      .mockResolvedValueOnce(prTurn(12))     // PR attempt → REFUSAL (neutral)
      .mockResolvedValueOnce(verifyTurn(13)) // ABORT → TRIP at 3 (one-round withhold, ONE filing)
      .mockResolvedValueOnce(shTurn(14))     // post-trip RED probe — real work continues (receipt 1a0d5205)
      .mockResolvedValueOnce(shTurn(15))     // withhold round consumed (NO verify issued — advisory compliance)
      .mockResolvedValueOnce(prTurn(16))     // gate auto-verify green → PR #1384 OPENED (receipt 26e3c4db)
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
    // The streak stayed on VERIFY — the FIVE interleaved PR-gate refusals
    // neither switched it (they are not failure-shaped) nor reset it (they are
    // not verify successes). executeCodingTool(ctx, name, args): name rides arg 1.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(6);
    for (const call of mockExecuteCodingTool.mock.calls) {
      expect(call[1]).toBe('open_pull_request');
      expect(String(call[0]?.agentSurface)).toBe('coding');
    }
    // Exactly THREE verify emissions at the counting seam — the model never
    // re-issued verify after the trip (advisory compliance, unlike sibling
    // b8eb66f8's two re-issues); the recovery came through the PR gate.
    expect(mockVerifyExec).toHaveBeenCalledTimes(3);
    // Seven exempt probes (red and green) — neither fed nor laundered the streak.
    expect(mockShExec).toHaveBeenCalledTimes(7);
  });

  it('RECOVERY (d): post-trip, ZERO further verify calls — the next open_pull_request, backed by the gate\'s own background auto-verify going green, OPENS the PR with no second filing (advisory compliance, the incident\'s exact recovery)', async () => {
    mockVerifyExec
      .mockResolvedValueOnce(ABORT_TEXT)
      .mockResolvedValueOnce(ABORT_TEXT)
      .mockResolvedValueOnce(ABORT_TEXT) // trip
      .mockResolvedValue('Verify PASSED: ✓ typecheck (exit 0)'); // canary — must stay UNCALLED
    mockExecuteCodingTool
      .mockResolvedValueOnce(GATE_GREEN); // the recovery: gate auto-verify green → PR #1384 opened
    mockShExec
      .mockResolvedValueOnce('post-trip probe: url still serves the old binary\n[exit: 1]') // receipt 1a0d5205 20:56:52Z
      .mockResolvedValue('probe result: ok');
    mockRunModelTurn
      .mockResolvedValueOnce(verifyTurn(1))  // ABORT → 1
      .mockResolvedValueOnce(verifyTurn(2))  // ABORT → 2
      .mockResolvedValueOnce(verifyTurn(3))  // ABORT → 3 → TRIP (withhold begins; ONE filing)
      .mockResolvedValueOnce(shTurn(4))      // post-trip RED probe — real work continues (receipt 1a0d5205)
      .mockResolvedValueOnce(shTurn(5))      // withhold round consumed — still NO verify issued
      .mockResolvedValueOnce(prTurn(6))      // gate auto-verify green → PR #1384 OPENED (receipt 26e3c4db, 21:09:11Z)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // The compliance leg: exactly THREE verify executions — none post-trip.
    // The one-round withhold never had to refuse anything: the model obeyed
    // the abort advisory and let the PR gate's background chain carry it.
    expect(mockVerifyExec).toHaveBeenCalledTimes(3);
    // ONE filing, the FIRST trip only — the successful PR opened no new streak.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.perma).toBe(false); // first streak: one-round withhold, the lane keeps its tool
    expect(ev.recentFailures).toEqual([ABORT_TEXT, ABORT_TEXT, ABORT_TEXT]);
    // The recovery went through open_pull_request, and it was green (the async
    // mock's resolved value — toHaveReturnedWith would compare the Promise).
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
    expect(mockExecuteCodingTool.mock.calls[0][1]).toBe('open_pull_request');
    await expect(mockExecuteCodingTool.mock.results[0].value).resolves.toBe(GATE_GREEN);
  });

  it('(e) CLASS pin: the f4448a999 capacity fix — the shared dev container\'s 22.8 GiB cap admits exactly 3 concurrent verify chains — is on this branch (the co-tenant-storm de-collision for this streak class)', () => {
    const BOX_C_CAP = 24_499_638_272;                                        // f4448a999: the incident container's memory.max
    expect(verifySlotsForCap(BOX_C_CAP)).toBe(3);                            // floor(22.8 GiB × 0.75 / 5 GiB)
    expect(VERIFY_STAGE_PEAK_BYTES).toBe(5 * 1024 ** 3);
    expect(VERIFY_SLOT_HEADROOM).toBe(0.25);
    expect(verifySlotsForCap(2 * 1024 ** 3)).toBe(1);                        // a scoped per-session container — min 1
    expect(verifySlotsForCap(256 * 1024 ** 3)).toBe(4);                      // max 4
    // The other half of the fix — the queued-ms re-arm of the tool hard timer
    // (a verify merely WAITING for a slot is never answered "exceeded 900s")
    // — is pinned by sibling verify-env-streak.6b878782.test.ts, the class's
    // own suite; not duplicated here (drift risk, no added coverage).
  });

  it('(f) the self-heal artifact: the PR #1384 pin suites and the 1.0.1 windows feed exist on this branch and carry the fix markers — the work the streak interrupted landed, verified', async () => {
    const fs = await import('fs');
    const path = await import('path');
    // The Windows shell bootstrap pins shipped in PR #1384 (squash cb5da77337fc).
    const shell = path.resolve(__dirname, '../../../../../frontend/app/windows-shell-bootstrap-pins.test.ts');
    expect(fs.existsSync(shell)).toBe(true);
    const text = fs.readFileSync(shell, 'utf8');
    expect(text).toContain('StartupPanel');   // the visible startup/error/Retry panel
    expect(text).toContain('WithTimeout');    // the bounded WebView2 init awaits
    // The update feed the incident lane published (1.0.2 = the agent 0.9.1
    // helper-locator fix release, ticket 4424ebd6; 1.0.1 was the startup-hang
    // fix release).
    const feedPath = path.resolve(__dirname, '../../../../../frontend/public/windows-latest.json');
    expect(fs.existsSync(feedPath)).toBe(true);
    const feed = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
    expect(feed.version).toBe('1.0.2');
    expect(String(feed.url)).toContain('Digby-Setup.exe');
  });
});

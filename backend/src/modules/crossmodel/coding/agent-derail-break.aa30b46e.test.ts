/**
 * REPLAY TEST — ticket aa30b46e (mishap, 2026-09-23): "5× success-side
 * wrong-tool loop: edit_file on 'Acceptance Criteria Verified' — framework
 * or model?" Auto-filed at the breaker trip (owner doctrine 2026-09-10:
 * self-heal + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session 66c9fb5c-cf72-4ced-a298-1951b7d610da — the
 * "Acceptance Criteria Verified" Web Unlocker harvest lane; run
 * 913e1d28-5c22-4acf-9ca5-31130d0730fd, glm-5.3/zai, coding profile,
 * machine-triggered): the lane's reasoning named a ROTATING set of other
 * tools while it correctly emitted edit_file text edits — FIVE consecutive
 * edit_file mismatches, every call SUCCEEDING, the named intent churning
 * (latest: computer_task at trip time). Fleet telemetry this incident
 * (pulled 2026-09-23 ~14:38Z): guard_miss seam 'tool_intent_attribution'
 * — the five edit_file rows 14:23:25.881Z → 14:24:16.188Z (streaks 1–3 in
 * ONE tool batch, then 4 and 5 on solo turns, ALL reason
 * 'preamble_ordered', marker edit_file — the user-preference standing
 * orders whole-word-name the CALLED edit_file: "Prefer edit_file
 * (targeted, exact-match edits)…", the 58e675c9 discount class) →
 * guard_strike 'tool_derail_break' 14:24:20.443Z (shape 'success_intent',
 * perma:false, churned:true, intended 'computer_task') → the auto-file at
 * 14:24:16.246Z under the CORRECT success-side churn title. The lane
 * RECOVERED after the one-round withhold and delivered its run (final
 * verdict row 14:29:58.287Z) — no re-dispatch needed.
 *
 * THE COMPOUND PATH THIS PIN OWNS (the distinguishing axis vs all five
 * sibling replays — 2c98b460, c737d007, a1660b1a, ee39f231, 4994e2f1,
 * 8da24785): the run's ONE-PER-RUN re-anchor budget was already spent by
 * the FAILURE-side leg 27 minutes earlier — guard_strike
 * 'tool_derail_reanchor' 13:56:30.802Z (tool read_file, reason
 * 'intent_mismatch', intended 'grep'; a read_file success-side discount
 * row at 13:56:00.766Z preceded it). So when the edit_file churn streak
 * crossed the steer-at-3 threshold (14:23:25, streaks 1–3 in one batch),
 * the success-side arm was SUPPRESSED by design — agent.ts:3722 gates on
 * !reAnchorUsed, and :1586-1588 documents "exactly ONE per run … every
 * later occurrence flows through the unchanged breaker path". NO
 * 'intent_mismatch_success' reanchor row exists in the run's telemetry:
 * that absence is the documented budget bound, NOT a guard defect. The
 * trip-at-5 fired anyway and contained the streak — the withhold path is
 * fully independent of the steer budget. c562f895 pinned "reAnchorUsed
 * suppresses every later steer" within the FAILURE leg; THIS pin is the
 * cross-leg compound: failure leg spends the budget, success leg's
 * steer-at-3 starves, trip-at-5 still contains.
 *
 * ADJUDICATION (lane b92ef13f, 2026-09-23): MODEL-SIDE — no deterministic
 * framework/schema/preflight/guard defect caused the streak. Every rung
 * behaved per design: the c737d007 pair-agnostic re-key (e3417bf98) was
 * LOAD-BEARING — the rotating named intent would have self-erased the
 * legacy pair-keyed count, so steer-at-3 and trip-at-5 would NEVER have
 * fired; the suppressed steer is the documented one-per-run bound, not a
 * gap (and the steer's marginal value here was low: the failure-leg steer
 * had already re-stated the toolset 27 min earlier); the trip at 5
 * withheld edit_file exactly one round (perma:false, first trip); the
 * filed text is byte-exact the agent.ts:3752 CHURN template; the d73765fc
 * shape threading rendered the correct title end-to-end; and the 58e675c9
 * measure probe classified ALL FIVE rows discount-eligible
 * (preamble_ordered) while containment fired anyway — MEASURE-FIRST
 * working as designed (measurement loud, detector unchanged). Fifth wild
 * instance of the glm-5.3 success-side narration-slip class; the
 * deterministic-seam corpus now pins every quadrant AND the compound
 * cross-leg path.
 *
 * THIRD WILD INSTANCE APPENDED (ticket 95c39fb8, mishap, 2026-09-23;
 * adjudicated by lane b92ef13f ~16:50Z): session 6707c938 run a109a72d
 * ("Improving Agent UI With Draw Probability"), seat
 * api-alibaba-qwen3.8-max — a custom Edge endpoint, the first pinned
 * instance OFF the built-in seats — edit_file→verify. Telemetry (pulled
 * 16:49–16:50Z): guard_miss seam 'tool_intent_attribution' — an edit_file
 * burst 16:36:46.369→.523Z (six rows in one tool batch, reason
 * 'preamble_ordered', the same standing-order discount class) →
 * guard_strike 'tool_derail_break' 16:36:50.343Z (shape 'success_intent',
 * churned:false, intended 'verify', perma:false). Distinguishing telemetry
 * wrinkle: THREE 'tool_derail_reanchor' rows reason
 * 'intent_mismatch_success' in this run (15:45:13.313Z churned:true,
 * 16:10:34.305Z, 16:34:49.928Z — all read_file/verify): the run row spans
 * deploy restarts and reAnchorUsed is in-memory, so each RESUMED segment
 * legitimately re-arms its own steer (the budget is per process segment,
 * not per run row). Adjudication unchanged and now tri-seat: MODEL-SIDE
 * narration slip on succeeding calls; the steers fired on every segment and
 * the trip-at-5 contained (perma:false, first trip).
 *
 * FOURTH INSTANCE APPENDED (ticket b8fbebc6, mishap, 2026-09-23; same
 * session 6707c938 / same run a109a72d, ~23 min after the 95c39fb8 trip):
 * the SECOND per-tool trip — read_file→grep this time. Telemetry (pulled
 * 17:05Z): guard_strike 'tool_derail_reanchor' 16:56:48.486Z (read_file,
 * reason 'intent_mismatch_success', churned:true, intended 'grep') →
 * guard_strike 'tool_derail_break' 16:59:11.383Z (shape 'success_intent',
 * churned:true, intended 'grep', perma:false). The per-tool trip ladder
 * worked exactly as designed: the edit_file trip (95c39fb8) withheld only
 * edit_file; the read_file streak built independently and tripped on ITS
 * own counter, with its own steer on the resumed segment. Adjudication
 * unchanged: MODEL-SIDE — the seat kept narrating a different tool than it
 * emitted across TWO different called tools; the framework contained both.
 *
 * CLASS DISPOSITION (supervisor steer 2026-09-23 17:15Z — one consolidated
 * verdict, not a 4th parallel pin): FOUR same-class tickets today, all
 * adjudicating MODEL-SIDE — aa30b46e (edit_file×5, glm-5.3, DONE), d2cceee3
 * (write_file×5, lane f51bd154 adjudicating), 95c39fb8 (edit_file×5,
 * Edge seat, DONE), b8fbebc6 (read_file×5, Edge seat, this citation). The
 * same signature — 5 consecutive SUCCEEDING calls whose reasoning names a
 * different tool, intent churning — across different called tools, sessions,
 * runs, AND seats (two built-in models + one custom Edge endpoint) is itself
 * the finding: a cross-seat model-side narration-slip class, not a
 * seat-specific or framework defect. The harness already DETECTS at call 1
 * (detectIntendedTool compares the run's reasoning text against the called
 * tool per call — the guard_miss 'preamble_ordered' discount rows ARE those
 * call-time comparisons); intervening at call 1 was evaluated and
 * deliberately deferred by the MEASURE-FIRST cycle (58e675c9): the discount
 * probe showed call-1 mismatches are dominated by standing-order preamble
 * noise (system/user-preference text that whole-word-names the CALLED tool),
 * so the tuned containment is steer-at-3 + trip-at-5, which contained every
 * wild instance above. No further harness guard is warranted on today's
 * evidence.
 *
 * THIS PIN replays the incident's exact shape against the REAL agent loop
 * and asserts: the failure-leg re-anchor fires FIRST (read_file failed
 * while naming grep — the truthful failure-shape steer), then the churn
 * streak (3-call batch under a glob narration, then read_file, then
 * computer_task) produces NO second steer and NO
 * reason:'intent_mismatch_success' reanchor metric (the compound-budget
 * suppression), the trip at the fifth mismatch carries churned:true +
 * intended 'computer_task' (the c737d007 telemetry), all five mismatches
 * are discount-eligible with containment UNCHANGED (measure-first), the
 * byte-exact CHURN filed text, the truthful success-shape withhold
 * notice, and the one-round schema withhold. (Both kill-switch silhouettes
 * this file once pinned were deleted with RSW-1 cluster 32 — the success leg
 * and the re-anchor steers are now unconditional, so their two NEGATIVE cases
 * went whole; the trip-at-5 containment they also asserted is pinned above.)
 *
 * Scaffold mirrors agent-derail-break.8da24785.test.ts: every mismatched
 * edit_file call SUCCEEDS ('probe result: ok') and only the failure-leg
 * read_file returns a failure-shaped envelope (the ^Tool \S+ failed:
 * marker); edit_file args vary by LETTER-skeleton path (never a
 * digit-only delta) so the exact and digit-collapsed repeat signatures
 * stay blind; no run_command call ever appears (the scaffold's container
 * mock would leak to a real shell). Each narration names exactly ONE
 * offered tool as a whole word and never the called edit_file — an
 * unoffered named tool makes detectIntendedTool return null and silently
 * resets the streak (the c737d007 test-writing gotcha). NEW since
 * 7b2a0969: detectIntendedTool acquits PROSE self-naming
 * (proseMentionsTool — "edit … file" as an in-order word sequence), so
 * the churn narrations deliberately avoid any edit→file word sequence;
 * the UNIT block pins that the prose acquittal does NOT weaken this
 * conviction path. computer_task is offered to the coding orchestrator
 * via TOOL_DEFINITIONS (tool-executor.ts:353) — the wild trip metric's
 * intended:'computer_task' is itself the proof it was in the offered set.
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
  __esModule: true, agentBroker: { dispatch: jest.fn() },
}));

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

// Every edit_file call SUCCEEDS ('probe result: ok') except the ONE
// failure-leg read_file (the wild run's 13:56:30Z reanchor source: the
// ^Tool \S+ failed: FAILURE_MARKER). mockExecuteCodingTool's real
// signature is (ctx, name, args) — name-first mocks silently misroute
// (the 0aecbe92 scaffold gotcha).
const FAIL_PATH = 'backend/src/modules/crossmodel/coding/guard-region.ts';
const failResult = 'Tool read_file failed: requested range beyond end of file — no bytes to read.';
const isFailLeg = (name: string, args: any) => name === 'read_file' && args && args.path === FAIL_PATH;
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, name: string, args: any) => (isFailLeg(name, args) ? failResult : 'probe result: ok'));
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The document/feedback/schedule seam dispatches via ctx.toolCache — keep
// the REAL TOOL_DEFINITIONS, stub only the executor (same routing so the
// failure leg fails on EITHER dispatch path, agent.ts:838/:843).
const mockToolCacheExec: jest.Mock = jest.fn(async (name: string, args: any) => (isFailLeg(name, args) ? failResult : 'probe result: ok'));
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
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss', TOOL_BATCH_CAP: 'tool_batch_cap' },
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
import { looksLikeToolFailure } from './learnings-index.service';
import { detectIntendedTool, intentMismatchDiscount, proseMentionsTool } from './tool-preflight';

/** CODING profile (no workspace container in the scaffold). edit_file,
 *  read_file, grep, glob and computer_task (TOOL_DEFINITIONS) are all in
 *  the orchestrator's offered schema — so each is convictable when the
 *  narration names it. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

/** The incident wake, faithful to its haystack (the supervisor GO for the
 *  harvest census + the standing preference lines the lane ran under): it
 *  whole-word-names the CALLED edit_file — which is exactly why every
 *  mismatch in the incident was discount-ELIGIBLE (preamble_ordered,
 *  marker edit_file — the wild rows quote the "Prefer edit_file
 *  (targeted, exact-match edits)…" line verbatim). */
const BRIEF = [
  '[MACHINE-TRIGGERED RUN — supervisor GO: v4 Web Unlocker harvest, census + acceptance criteria]',
  'You are the Acceptance Criteria lane: refresh the census cells and the acceptance table per the runbook.',
  '- Prefer edit_file (targeted, exact-match edits) over rewriting a whole file with write_file.',
  '- Condition 1 binds: re-confirm your own trigger conditions fresh before shipping.',
  'Report back with the census totals and the acceptance verdict.',
].join('\n');

const makeInput = (userMessage: string = BRIEF, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-aa30b46e-test',
  sessionId: 'sess-aa30b46e',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.3',
  projectName: 'test',
  branch: 'main',
  profile,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

// ── The failure leg (the budget consumer — the wild 13:56:30Z reanchor) ──

/** read_file FAILS while the narration names grep: the failure-side
 *  intent-mismatch arm (agent.ts:3620) fires the run's ONE re-anchor. */
const R_FAIL = 'The census region numbers must come from a symbol match — grep the seam names for the reanchor sites so the line citations are exact.';
const failReadTurn = {
  content: '',
  reasoning: R_FAIL,
  toolCalls: [{ id: 'f1', name: 'read_file', arguments: JSON.stringify({ path: FAIL_PATH, start_line: 3400, end_line: 3600 }) }],
  finishReason: 'tool_calls' as const,
};
/** Post-steer recovery: the model aligns to the tool its reasoning named. */
const alignedGrepTurn = {
  content: '',
  reasoning: 'Now grep the seam names directly to collect the match list for the census.',
  toolCalls: [{ id: 'g1', name: 'grep', arguments: JSON.stringify({ pattern: 'reanchor', path: 'backend/src' }) }],
  finishReason: 'tool_calls' as const,
};

// ── The churn streak (the wild 14:23:25 → 14:24:16 edit_file ×5) ──

/** The rotation: batch-of-3 under a glob narration, then read_file, then
 *  computer_task — each narration names exactly ONE offered tool, never
 *  the called edit_file, and never an edit→file word sequence (the
 *  7b2a0969 prose-acquittal hazard, pinned in the UNIT block). */
const R_GLOB = 'The churn corpus needs a path inventory — glob the pin directory so the rotation covers every replay module.';
const R_READ = 'Before the next mutation: read_file the guard block fresh so the streak arithmetic cites current source.';
const R_COMPUTER = 'The screenshot evidence needs the paired Mac — computer_task the verification so the probe sees the real screen.';

const WORDS = ['kilo', 'lima', 'mike', 'november', 'oscar'];
const editCall = (n: number) => ({
  id: `t${n}`,
  name: 'edit_file',
  arguments: JSON.stringify({
    path: `frontend/app/census/${WORDS[(n - 1) % WORDS.length]}-panel.tsx`,
    old_string: 'const CENSUS_TOTAL = 94',
    new_string: 'const CENSUS_TOTAL = 371',
  }),
});
/** Streaks 1–3: ONE tool batch under the glob narration (the wild rows
 *  landed 14:23:25.881/.910/.962 — one batch), steer-at-3 threshold
 *  crossed INSIDE this batch. */
const churnBatch = {
  content: '',
  reasoning: R_GLOB,
  toolCalls: Array.from({ length: 3 }, (_, i) => editCall(i + 1)),
  finishReason: 'tool_calls' as const,
};
/** Streak 4 (14:23:58Z): the named intent rotates — churn flips true. */
const churnTurn2 = {
  content: '',
  reasoning: R_READ,
  toolCalls: [editCall(4)],
  finishReason: 'tool_calls' as const,
};
/** Streak 5 (14:24:16Z): rotates again → TRIP, intended computer_task. */
const churnTurn3 = {
  content: '',
  reasoning: R_COMPUTER,
  toolCalls: [editCall(5)],
  finishReason: 'tool_calls' as const,
};
/** An ALIGNED success for the ban-round probe: narration names the called
 *  tool. list_files — never run_command (see header). */
const alignedTurn = (n: number) => ({
  content: '',
  reasoning: 'Now list_files to check which census fixtures the builder emitted before the final report.',
  toolCalls: [{ id: `t${n}`, name: 'list_files', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls' as const,
});
const FINAL = { content: 'Census acceptance verdict complete.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');
const discountMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'guard_miss' && m?.meta?.seam === 'tool_intent_attribution');
/** runModelTurn receives the ONE shared messages array by reference — at
 *  assertion time it holds the full conversation; count steers/notices there. */
const conversation = () => mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }>;
const steerMessages = () => (conversation() || []).filter(
  (m) => m?.role === 'user' && typeof m.content === 'string' && m.content.includes('RE-ANCHOR (one per run)'),
);
const userTexts = () => (conversation() || []).filter((m) => m?.role === 'user').map((m) => String(m.content));
/** The tools schema offered at model turn k (0-based call index) — the
 *  withhold probe (runModelTurn's 3rd argument, agent.ts:2105). */
const offeredAtCall = (k: number) => new Set<string>(((mockRunModelTurn.mock.calls[k]?.[2] ?? []) as Array<{ function?: { name?: string } }>).map((t) => t?.function?.name as string).filter(Boolean));

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket aa30b46e — compound budget: failure-leg reanchor spends the one-per-run steer, edit_file churn steer-at-3 is suppressed BY DESIGN, trip-at-5 still contains (model-side)', () => {
  it('UNIT: the incident premise — the failure envelope is failure-shaped, the churn narrations convict a ROTATING intent, the prose acquittal does NOT weaken it, and the 58e675c9 discount FIRES on this wake', () => {
    // The failure leg's envelope matches the ^Tool \S+ failed: marker; the
    // streak's results never do.
    expect(looksLikeToolFailure('Tool read_file failed: requested range beyond end of file — no bytes to read.')).toBe(true);
    expect(looksLikeToolFailure('probe result: ok')).toBe(false);
    const offered = ['edit_file', 'run_command', 'read_file', 'grep', 'glob', 'list_files', 'computer_task', 'web_pipe', 'list_dir', 'search_code_semantic'];
    // Failure leg: narration names grep while read_file is called.
    expect(detectIntendedTool(R_FAIL, 'read_file', offered)).toBe('grep');
    // The churn rotation — each turn convicts a DIFFERENT named intent on
    // the SAME called edit_file (the c737d007 pair-agnostic key's payload).
    expect(detectIntendedTool(R_GLOB, 'edit_file', offered)).toBe('glob');
    expect(detectIntendedTool(R_READ, 'edit_file', offered)).toBe('read_file');
    expect(detectIntendedTool(R_COMPUTER, 'edit_file', offered)).toBe('computer_task');
    // Faithful narration acquits.
    expect(detectIntendedTool(alignedGrepTurn.reasoning, 'grep', offered)).toBeNull();
    expect(detectIntendedTool(alignedTurn(6).reasoning, 'list_files', offered)).toBeNull();
    // 7b2a0969 interplay: the prose self-naming acquittal does NOT fire on
    // any churn narration — no edit→file word sequence exists in them, so
    // the conviction path is exactly as strong as before the prose matcher.
    expect(proseMentionsTool(R_GLOB, 'edit_file')).toBe(false);
    expect(proseMentionsTool(R_READ, 'edit_file')).toBe(false);
    expect(proseMentionsTool(R_COMPUTER, 'edit_file')).toBe(false);
    // The incident's standing orders whole-word-name the CALLED edit_file
    // (the user-preference line), so every mismatch is discount-ELIGIBLE —
    // and the replay below proves containment fired anyway (measurement
    // changes NOTHING).
    expect(intentMismatchDiscount('glob', 'edit_file', BRIEF)).toMatchObject({ reason: 'preamble_ordered', marker: 'edit_file' });
    expect(intentMismatchDiscount('read_file', 'edit_file', BRIEF)).toMatchObject({ reason: 'preamble_ordered', marker: 'edit_file' });
    expect(intentMismatchDiscount('computer_task', 'edit_file', BRIEF)).toMatchObject({ reason: 'preamble_ordered', marker: 'edit_file' });
  });

  it('REPLAY the incident (failure-leg reanchor → edit_file churn ×5 with rotating intent): exactly ONE steer (the failure leg), NO intent_mismatch_success reanchor, trip at the fifth with churned:true intended computer_task — containment UNCHANGED', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(failReadTurn)    // 13:56:30Z — the budget consumer
      .mockResolvedValueOnce(alignedGrepTurn) // post-steer recovery
      .mockResolvedValueOnce(churnBatch)      // 14:23:25.881/.910/.962 — streaks 1–3, ONE batch
      .mockResolvedValueOnce(churnTurn2)      // 14:23:58.847 — streak 4, churn flips
      .mockResolvedValueOnce(churnTurn3)      // 14:24:16.188 — streak 5, TRIP
      .mockResolvedValueOnce(alignedTurn(6))  // ban round: edit_file absent from the schema
      .mockResolvedValue(FINAL);
    const input = makeInput(BRIEF, { ...CODING_TEST_PROFILE, maxSteps: 10 });
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Census acceptance verdict complete.');
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');

    // The offered schema carries every narration-named tool (computer_task
    // rides TOOL_DEFINITIONS into the orchestrator set — the wild trip's
    // intended:'computer_task' is the live proof of the same).
    expect(offeredAtCall(0).has('computer_task')).toBe(true);

    // ── THE COMPOUND PATH: the failure leg fired the run's ONE steer ──
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run)');
    // Failure shape, truthful: this steer is the FAILURE leg's.
    expect(steer).toContain('You called read_file and it failed');
    expect(steer).toContain('your own reasoning named grep');
    expect(steer).not.toContain('it SUCCEEDED');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'read_file', intended: 'grep', reason: 'intent_mismatch' });
    // …and the success-side steer-at-3 NEVER armed: no second steer, no
    // success-shaped reanchor metric. The suppression is the documented
    // one-per-run bound (agent.ts:1586-1588, arm gate :3722 !reAnchorUsed)
    // — NOT a guard defect. This is the assertion c562f895 could not make
    // (its suppression was within one leg; this is the cross-leg compound).
    expect(reanchorMetrics().filter((m) => m.meta.reason === 'intent_mismatch_success')).toHaveLength(0);

    // ── Containment fired DESPITE the suppressed steer and every mismatch
    //    being discount-eligible (the measure-first invariant) ──
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({ tool: 'edit_file', perma: false, intended: 'computer_task', churned: true });
    expect(breakerMetrics()).toHaveLength(1); // one-round withhold only — no perma, no run-end

    // ── The measurement was LOUD on exactly the incident's five rows ──
    const discounts = discountMetrics();
    expect(discounts).toHaveLength(5);
    const ef = discounts.filter((m) => m.meta.tool === 'edit_file');
    expect(ef).toHaveLength(5);
    expect(ef.map((m) => m.meta.intended)).toEqual(['glob', 'glob', 'glob', 'read_file', 'computer_task']);
    expect(ef.map((m) => m.meta.streak)).toEqual([1, 2, 3, 4, 5]);
    expect(ef.every((m) => m.meta.reason === 'preamble_ordered' && m.meta.marker === 'edit_file')).toBe(true);

    // ── Truthful notice + byte-exact attribution (the filed ticket text) ──
    expect(userTexts().some((t) => t.includes('Your last 5 calls of edit_file all SUCCEEDED') && t.includes('temporarily removed from your tool list for the next round'))).toBe(true);
    expect(userTexts().some((t) => t.includes('ALL FAILED'))).toBe(false);
    expect(mockFileStreakInvestigation).toHaveBeenCalled();
    const evidenceText = String(mockFileStreakInvestigation.mock.calls[0][0].recentFailures[0]);
    // The CHURN template (agent.ts:3752) — byte-exact the ticket's quoted
    // text; 8da24785 pinned the stable-intent sibling branch.
    expect(evidenceText).toContain("edit_file kept SUCCEEDING while the run's own reasoning named a rotating set of OTHER tools (latest: computer_task)");
    expect(evidenceText).toContain('(edit_file ×5 consecutive, named intent churned, tickets 2c98b460+c737d007)');

    // ── The withhold lasts EXACTLY one model round (the ban round is the
    //    turn immediately after the trip turn) ──
    expect(offeredAtCall(5).has('edit_file')).toBe(false);
    expect(offeredAtCall(6).has('edit_file')).toBe(true);
  });

});

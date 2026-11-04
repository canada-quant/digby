// LEGACY SCHEMA REPLAY (coding/tool-scope.ts, owner 2026-09-22): this pin replays
// an incident from before the cause-level fix — when `update_feedback` /
// `update_supervisor_state` were offered under their internal names to every
// coding lane. The breaker / pre-flight mechanics it pins are unchanged. The
// always-visible switches below still restore that era's SCOPE; the era's
// internal NAMES cannot be restored — RSW-1 deleted the disambiguation kill
// switch on 2026-11-02, so those tools are offered as `triage_ticket` /
// `save_supervisor_state` and the name assertions below pin the model-facing
// spelling. An EMITTED internal name still resolves and executes.
// (agent-tool-scope.test.ts pins the new default: renamed, scoped, slip-pruned.)
process.env.TRIAGE_TOOLS_ALWAYS_VISIBLE = '1';
process.env.SUPERVISOR_TOOLS_ALWAYS_VISIBLE = '1';

/**
 * Replay pin — ticket 92d88a96 (mishap, auto-filed 2026-09-20T10:06:31Z at
 * breaker trip; incident lane 521020fe-ebe5-4d97-8b58-fdbe8c95445f "Spark
 * Lane Branch State Verification", spark-cluster, coding seat kimi-k3,
 * machine run f02ce3d7-84d3-49d9-8343-0df680922e6d — the harness
 * continuation r1/6 fired 10:02:58Z whose ONLY mandated first act was ONE
 * fresh read (git_status / read_file) before no-op-or-resume).
 *
 * THE INCIDENT: the continuation run died ~3.5 minutes in on the wrong-tool
 * derail terminal state (agent.ts:3252-3290): harness note "Run ended:
 * repeated wrong-tool derailment (3 episodes; intended tool appears to be
 * git_status)" (transcript msg 0f830139). The run NEVER emitted git_status;
 * it emitted wrong-tool platform mutations instead:
 *   · update_feedback ×4 — every call's narration named git_status (+1
 *     intent per call, tripping on every second failure), first trip
 *     10:04:04 (one-round ban), second 10:04:38 (PERMA-LOCK). The
 *     companion auto-file for this seam is outside this batch's dispatch
 *     (the filing dedups on the normalized same-chat same-tool title);
 *     this batch's ticket covers the update_schedule streak.
 *   · update_schedule ×3 with the MODEL-AUTHORED placeholder id "n/a" —
 *     every call executed (the id occurs verbatim in the haystack — "n/a"
 *     is a common substring — so the grounding preflight passes it) into
 *     the tool's own existence refusal; the streak tripped on the THIRD
 *     call (+1 failure each; the intent bump landed on the last —
 *     the filed evidence: THREE identical texts + "lane's reasoning named
 *     git_status").
 * guard_strike telemetry for run f02ce3d7 (fresh read 2026-09-20 ~10:29Z):
 *   10:04:04 tool_derail_break update_feedback perma:false intended:git_status (TRIP 1)
 *   10:04:38 tool_derail_break update_feedback perma:true  intended:git_status (TRIP 2)
 *   10:05:07 tool_repeat_break update_supervisor_state trips:1 (the OTHER
 *            breaker — identical-call seam; not part of the derail tally)
 *   10:05:47 tool_repeat_break update_supervisor_state trips:2
 *   10:06:31 tool_derail_break update_schedule perma:false state:ended_run
 *            tools:[update_feedback,update_schedule] trips:3 intended:git_status
 *   ⇒ trip tallies {update_feedback:2, update_schedule:1} = "3 episodes";
 *   the terminal note names git_status (the LAST intent mismatch — the
 *   update_schedule streak's own third call — agent.ts:3253).
 *
 * DEPLOY-BASELINE NOTE (boundary re-verified fresh this session against
 * get_fleet_telemetry view 'deploy', per the crossmodel supervisor's steer):
 * the 22c309f4 kimi-k3 conformance fix (8f4c4464) deployed in run
 * 35501798401, concluded SUCCESS 09:58:48Z; every box process ran ≥8f4c4464
 * by ~10:01Z (box rolls ~09:50Z / 09:58:34Z / 10:00:45Z — corroborated: all
 * boxes on ≥8f4c4464 at the 10:49Z read). Unlike its same-morning siblings
 * (9d5cee91 / fcc8bebe — run a324be0a started 09:53:51Z, PRE-rollout, the
 * supervisor-confirmed pre-fix baseline), THIS run started 10:02:58Z
 * (transcript msg 4a77ad7c, the continuation trigger; first strike
 * 10:04:04Z) — after the WORST-case box roll (10:00:45Z). It is therefore
 * the FIRST post-8f4c4464-rollout sighting of the placeholder/wrong-tool
 * class (bda7f125's "third post-fix placeholder-refusal occurrence" pinned
 * an earlier link in the chain — #902 merged before #903): a REGRESSION
 * SIGNAL for the conformance thread (22c309f4 / 78f32515 / bda7f125;
 * open class tracker d18241b3), NOT a routine pre-fix baseline. The spark
 * supervisor's 10:16Z steer (msg 49fc067f) still classified the 10:03Z
 * derail as "pre-fix baseline … deploy in flight" — the deploy telemetry
 * says otherwise. Per-ticket verdict below stays MODEL BEHAVIOR (no
 * deterministic framework defect caused this streak); the regression flag
 * rides the ticket's adminNote and a sighting on class tracker d18241b3.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — kimi-k3
 * wrong-tool substitution with a model-authored placeholder id ("n/a"),
 * the placeholder-emission dispatch-loop class (f839cede / aff1c189 /
 * ec9d7424). Every deterministic seam behaved AS DESIGNED: the schedule
 * tool's existence check refused accurately (naming the id contract and
 * confirming no owner card was staged), the refusals are failure-shaped and
 * correctly counted, the intent-mismatch preflight named git_status, and
 * the breaker withheld → perma-locked → ended the run honestly
 * (completed-with-note, never modelErrored). NO shape exemption, NO
 * framework code change (ea69c94e / d0b9c6a6 disposition).
 *
 * These tests pin: the "n/a" refusal envelope is failure-shaped; "n/a" is
 * occurrence-grounded (substring haystack) so the calls EXECUTE; the
 * {update_feedback:2, update_schedule:1} trip sequence ends the run with
 * the EXACT incident note (3 episodes, intended git_status); the
 * update_schedule auto-filing carries the three identical filed texts with
 * intended git_status; and the ended_run telemetry row matches the
 * incident's. Scaffold mirrors agent-derail-break.0aecbe92.test.ts (same
 * mock set as agent-derail-break.9d5cee91.test.ts).
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

// The update_feedback calls execute into the tool's own (failure-shaped)
// not-found refusal. Their exact wording is NOT pinned by any filed evidence
// (this run's update_feedback streak is not the dispatched ticket) — the
// shape is what the breaker counts.
const UF_TOOL_REFUSAL = (id: string) => JSON.stringify({
  ok: false,
  tool: 'update_feedback',
  reason: 'not_found',
  message: `Tool update_feedback failed: no feedback ticket with id "${id}" exists for this user.`,
}, null, 1);
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, name: string, args: any) => {
  if (name === 'update_feedback') return UF_TOOL_REFUSAL(String(args?.id ?? ''));
  if (name === 'update_schedule') return US_ENVELOPE;
  return 'probe result: ok';
});
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The incident's update_schedule refusal, VERBATIM from ticket 92d88a96's
// filed texts (all three identical).
const US_ENVELOPE =
  'Tool update_schedule failed: no schedule with id "n/a" exists for this owner (an id is the full id from list_schedules / schedule_get / schedule_message, or a unique prefix of at least 8 characters). Copy a real id from list_schedules — never invent, truncate below 8 characters, or placeholder an id. No confirmation card was staged — nothing is waiting on the owner.';
const mockToolCacheExec: jest.Mock = jest.fn(async (name: string, args: any) => {
  if (name === 'update_schedule') return US_ENVELOPE;
  if (name === 'update_feedback') return UF_TOOL_REFUSAL(String(args?.id ?? ''));
  return 'probe result: ok';
});
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
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', TOOL_BATCH_CAP: 'tool_batch_cap' },
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
import { detectIntendedTool, findUngroundedIdArgs } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

/** CODING profile: git_status is in the offered schema — the incident's
 *  intended tool must be offerable for the intent mismatch to name it. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 12,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

/** A grounded stand-in id for the (unfiled) update_feedback seam: 8 hex
 *  chars ⇒ SHAPE-grounded, so the calls execute (the incident telemetry
 *  shows NO tool_preflight strike for run f02ce3d7). */
const UF_ID = 'deadbeef';

const BRIEF = [
  '[HARNESS CONTINUATION r1/6] A previous run ended with 1 unfinished plan step.',
  'FIRST confirm the CURRENT plan against reality with ONE fresh read (git_status,',
  'or read_file on the plan file): if every step is already completed or blocked,',
  'reply "Continuation no-op — plan already complete." and STOP. The cadence id is n/a',
  'until list_schedules returns a real one.',
].join('\n');

const makeInput = (userMessage: string = BRIEF): AgentRunInput => ({
  worktree: '/tmp/derail-92d88a96-test',
  sessionId: 'sess-92d88a96',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

/** The update_feedback emissions: narration names git_status (+1 intent),
 *  never update_feedback. */
const ufTurn = (n: number) => ({
  content: '',
  reasoning: 'git_status first — the continuation mandates ONE fresh read of the branch state before anything else.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: UF_ID, status: 'done', adminNote: 'branch verified' }) }],
  finishReason: 'tool_calls',
});
/** The ban-round probe: a legitimate, succeeding plan touch. */
const planTurn = (n: number) => ({
  content: '',
  reasoning: 'Re-reading the plan before the next probe.',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: 'setup', status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
/** The first two update_schedule emissions: narration names the CALLED tool
 *  (detectIntendedTool returns null), so the streak accrues +1 failure only
 *  — the trip cannot land before the third call (the ticket's THREE texts). */
const usFaithfulTurn = (n: number) => ({
  content: '',
  reasoning: 'Retrying update_schedule with the same id — the cadence update must land.',
  toolCalls: [{ id: `t${n}`, name: 'update_schedule', arguments: JSON.stringify({ id: 'n/a', prompt: 'watch the branch' }) }],
  finishReason: 'tool_calls',
});
/** The third emission: the narration slips to git_status (+1 intent on top
 *  of +1 failure) — the streak crosses 3 here, exactly as the ticket's
 *  "lane's reasoning named git_status" records. */
const usIntentTurn = (n: number) => ({
  content: '',
  reasoning: 'git_status should have answered the branch question — one more attempt at the schedule fix with n/a.',
  toolCalls: [{ id: `t${n}`, name: 'update_schedule', arguments: JSON.stringify({ id: 'n/a', prompt: 'watch the branch' }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Continuation no-op.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** The run-f02ce3d7 episode sequence reconstructed from the guard_strike
 *  telemetry: {update_feedback: 2 trips, update_schedule: 1 trip} =
 *  "3 episodes" — update_feedback trips every second call (+1 failure +1
 *  intent), then the schedule seam's third "n/a" call trips the run into
 *  the terminal state. (The update_supervisor_state repeat-breaker trips at
 *  10:05:07/10:05:47 ride the OTHER breaker and are not modelled — they
 *  never touch derailTripCounts.) */
const wireIncident = () => {
  mockRunModelTurn
    .mockResolvedValueOnce(ufTurn(1)) // count 2 (failure + intent git_status)
    .mockResolvedValueOnce(ufTurn(2)) // count 4 ⇒ TRIP 1 (one-round ban)
    .mockResolvedValueOnce(planTurn(3)) // ban round — harmless success
    .mockResolvedValueOnce(ufTurn(4)) // count 2
    .mockResolvedValueOnce(ufTurn(5)) // count 4 ⇒ TRIP 2 (perma on update_feedback)
    .mockResolvedValueOnce(usFaithfulTurn(6)) // count 1 (failure only)
    .mockResolvedValueOnce(usFaithfulTurn(7)) // count 2
    .mockResolvedValueOnce(usIntentTurn(8)) // count 4 (failure + intent git_status) ⇒ TRIP 1 on update_schedule ⇒ TERMINAL
    .mockResolvedValue(FINAL);
};

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 92d88a96 — kimi-k3 wrong-tool derail of the spark continuation lane (run f02ce3d7)', () => {
  it('UNIT: the "n/a" refusal is failure-shaped; "n/a" is occurrence-grounded (executes); the intent preflight names git_status on the third emission only', () => {
    expect(looksLikeToolFailure(US_ENVELOPE)).toBe(true);
    expect(looksLikeToolFailure(UF_TOOL_REFUSAL(UF_ID))).toBe(true);
    // Grounding: "n/a" fails the id SHAPE (not hex) but occurs verbatim in
    // the continuation brief — the preflight validates occurrence/shape,
    // never existence — so every update_schedule call EXECUTES into the
    // tool's own refusal (no tool_preflight strike in the incident).
    expect(findUngroundedIdArgs({ id: 'n/a' }, BRIEF)).toEqual([]);
    expect(findUngroundedIdArgs({ id: 'n/a' }, 'no placeholder here')).toEqual([{ key: 'id', value: 'n/a' }]);
    expect(findUngroundedIdArgs({ id: UF_ID }, '')).toEqual([]); // 8 hex chars — shape-grounded
    expect(PLATFORM_TOOL_NAMES).toContain('update_schedule');
    // Intent attribution per emission.
    const offered = ['run_command', 'git_status', 'update_feedback', 'update_schedule'];
    expect(detectIntendedTool(ufTurn(1).reasoning, 'update_feedback', offered)).toBe('git_status');
    expect(detectIntendedTool(usFaithfulTurn(6).reasoning, 'update_schedule', offered)).toBeNull();
    expect(detectIntendedTool(usIntentTurn(8).reasoning, 'update_schedule', offered)).toBe('git_status');
  });

  it('REPLAY run f02ce3d7: {update_feedback:2, update_schedule:1} trips end the run with the EXACT incident note and the "n/a"×3 filing', async () => {
    wireIncident();
    const input = makeInput();
    const result = await runCodingAgent(input);

    // The loop stopped at the terminal trip — the FINAL mock was never reached.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(8);
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes');
    expect(result.finalText).toContain('intended tool appears to be git_status');
    expect(result.finalText).toContain('The next scheduled firing starts fresh.');
    // Completed-with-note, never a provider failure.
    expect(result.modelErrored).toBeUndefined();
    const notePart = result.parts.find((p) => p.type === 'text' && typeof p.text === 'string' && p.text.startsWith('[HARNESS] Run ended'));
    expect(notePart).toBeDefined();
    expect(notePart!.marker).toBe('guard');
    const guardEmits = (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'guard_marker').map((c) => c[1]);
    expect(guardEmits.some((e) => String(e.text).startsWith('[HARNESS] Run ended'))).toBe(true);

    // Telemetry mirrors the incident's guard_strike rows: trip 1 + the perma
    // trip on update_feedback (both intended git_status), then the ended_run
    // row on update_schedule with the run-level tallies.
    const ufTrip1 = breakerMetrics().find((m) => m.meta.tool === 'update_feedback' && m.meta.perma === false);
    expect(ufTrip1).toBeDefined();
    expect(ufTrip1!.meta.intended).toBe('git_status');
    const ufTrip2 = breakerMetrics().find((m) => m.meta.tool === 'update_feedback' && m.meta.perma === true);
    expect(ufTrip2).toBeDefined();
    expect(ufTrip2!.meta.intended).toBe('git_status');
    const ended = breakerMetrics().find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta).toMatchObject({ tool: 'update_schedule', perma: false, trips: 3, intended: 'git_status' });
    expect(ended!.meta.tools).toEqual(['update_feedback', 'update_schedule']);
    // No tool_preflight strike fires anywhere in the replay (every id is
    // shape- or occurrence-grounded) — matching the incident's telemetry.
    const preflightStrikes = mockRecordLoopMetric.mock.calls.map((c) => c[0])
      .filter((m) => m?.meta?.seam === 'tool_preflight' && m?.meta?.reason === 'ungrounded_id');
    expect(preflightStrikes.length).toBe(0);

    // git_status was never emitted, so no fresh read ever executed.
    expect(mockExecuteCodingTool.mock.calls.some((c) => c[1] === 'git_status')).toBe(false);
    expect(mockToolCacheExec.mock.calls.some((c) => c[0] === 'git_status')).toBe(false);

    // The auto-filings: update_feedback's first streak (two executed
    // refusals, intended git_status — the companion seam, deduped by the
    // REAL filing path against the existing same-title ticket), and the
    // dispatched ticket's own: update_schedule's terminal filing carrying
    // the THREE identical "n/a" refusals, intended git_status.
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const ufFilings = filings.filter((f) => f.tool === 'update_feedback');
    expect(ufFilings.length).toBe(2);
    expect(ufFilings[0].recentFailures).toEqual([UF_TOOL_REFUSAL(UF_ID), UF_TOOL_REFUSAL(UF_ID)]);
    expect(ufFilings[0].intended).toBe('git_status');
    const usFiling = filings.find((f) => f.tool === 'update_schedule');
    expect(usFiling).toBeDefined();
    expect(usFiling.recentFailures).toEqual([US_ENVELOPE, US_ENVELOPE, US_ENVELOPE]);
    expect(usFiling.intended).toBe('git_status');
  });
});

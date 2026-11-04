/**
 * REPLAY TEST — ticket 601d819e (mishap, filed 2026-10-19T16:43:34Z): "5×
 * success-side wrong-tool loop: edit_file on 'R&D stream 1 · · Shortfall
 * hunt: adjudic' — framework or model?" Auto-filed at the breaker trip
 * (owner doctrine 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session b92ef13f-c3f8-487e-8267-767e56543150 — the
 * R&D stream-1 shortfall-hunt lane, firing 29 of schedule b051a735, project
 * e5734bd2 (a product research project); run
 * dbae162d-5aff-4143-8e85-fce1cb3dc5fd, glm-5.3/zai, coding profile,
 * MACHINE-triggered; run still RUNNING at adjudication time, currentStep
 * 80, error null — and ALREADY SHIPPED). The lane was landing its measured
 * shortfall fix: a residue sweep removing dead references to retired
 * loop_metrics kinds (busy_firing_steered / schedule_delta_skip, both
 * deleted by S-2 2026-10-08) from AGENTS.md, .env.example, two jest mocks
 * and docs/FRAMEWORK_LESSONS.md.
 *
 * THE STREAK IS ONE MESSAGE OF FIFTEEN edit_file CALLS — the LARGEST
 * single-batch instance of the 2c98b460 class (2547b652 held six, 8da24785
 * five, 267ea7b6 five) — the trip's ×5 is the COUNT AT THE FIFTH CALL, not
 * the batch size:
 *   message @CTX558 (turn-key boundary 16:43:34.120Z) → calls 559, 562,
 *   565, 568, 571, 574, 577, 580, 583, 586, 589, 592, 595, 598, 601
 *   (fifteen edit_file calls, EVERY ONE SUCCEEDED — file_changed + ok
 *   tool_result after each, 16:43:34.122Z→16:43:34.375Z, 253 ms total).
 *   Per-call counting across the message: 559(1) 562(2) 565(3 → steer
 *   arms, reanchor metric 16:43:34.374Z) 568(4) 571(5 → TRIP, break
 *   metric 16:43:38.362Z) … 601(15, counted and executed — the withhold
 *   applies to the NEXT round's schema; there is no second trip because
 *   the trip reset the counter and withheldTool is set).
 *
 * ADJUDICATION (this lane, 2026-10-19, evidence-led, prod-DB probes
 * scripts/framework-audit/probe-601d819e-a.js + -b.js via prodq on box A):
 * MODEL-SIDE — no deterministic framework/schema/preflight/guard defect
 * caused the streak. The glm-5.3/zai narration-word-slip on live
 * reasoning, the 2547b652/267ea7b6 class, SIXTH pinned member and FIRST
 * AT THIS BATCH SIZE: the class roster per the repo's own pins is
 * 8da24785 (kimi-k3, 2026-09-23), 267ea7b6 (qwen3.8-max, 2026-10-09),
 * 2547b652 (qwen3.8-max, 2026-10-11), 4ac955aa (glm-5.3, 2026-10-15),
 * 304ff1bb (glm-5.3, 2026-10-15 — the same edit_file→verify pair) and
 * this one — the THIRD on glm-5.3, and the first whose convicted batch
 * exceeded six calls (15 here: the class was caught at 5- and 6-call
 * batches before — containment still fires at call 5 regardless of
 * batch size).
 * DEDUPE DOCTRINE (6df5fc61, 2026-10-16): once a class is adjudicated
 * "model behavior, guard correct", a new sighting APPENDS to the
 * adjudicated ticket (occurrences + duplicateSuppressedBy, no dispatch)
 * — this ticket was NOT such an append, for the reason the doctrine
 * itself leaves open: the sighting carried a NEW shape (a 15-call
 * single-batch streak, an order beyond every prior member, plus the
 * batch-size-independence property no prior pin asserted), so it was
 * auto-filed as its own mishap and dispatched; the pin adds the shape's
 * coverage rather than re-adjudicating the class.
 *
 * 1. THE TRIP FIRED ON THE POST-#1750 DETECTOR (the only commit touching
 *    backend/src/modules/crossmodel/coding/tool-preflight.ts since the
 *    2547b652 adjudication; the agent.ts success-side intent counter is
 *    untouched since — git log -S intentMissCount --since=2026-10-11 --
 *    backend/src/modules/crossmodel/coding/agent.ts and git log -S
 *    detectIntendedToolChannels --since=2026-10-11 -- backend/src/
 *    modules/crossmodel/coding/tool-preflight.ts are both EMPTY). The
 *    deployed detector require()d live in the backend container reports
 *    arity 5
 *    (the callArgs form) and the live battery returns: bare-intent
 *    reasoning → verify (convicts), glued verify-wave.sh → null (acquits),
 *    called-tool-named → null (acquits), quoted intent → verify (convicts),
 *    empty channels → null. The #1723/#1750 carve-out is CODE_SEARCH_TOOL_
 *    RE-gated and edit_file is not a code-search tool, so the edit_file
 *    conviction path behaves IDENTICALLY to the code that adjudicated
 *    2547b652 — the recent detector work cannot have manufactured this
 *    trip.
 * 2. ELIMINATION ON THE DETECTOR INPUT: detectIntendedToolChannels reads
 *    turn.reasoning + (turnText||turn.content). The CONTENT channel of the
 *    convicted message was recovered verbatim from agent_events text
 *    deltas (225 chars: "Clock 16:41Z. Executing the residue fix now — one
 *    batch of surgical edits (AGENTS.md instrumentation claims,
 *    `.env.example` kill-switch comments, the two jest mocks,
 *    FRAMEWORK_LESSONS row, learnings bullet), then tests + tsc:") and
 *    contains ZERO tool mentions under the BROAD acquittal boundary — not
 *    verify (0 broad, 0 standalone), not even edit_file (0 broad); the
 *    deployed detector replayed on the recovered channels (content + empty
 *    reasoning) returns intended:null — no conviction. The run's 820
 *    agent_events contain ZERO 'reasoning'-type rows (reasoning-wire.ts
 *    cuts reasoning at the wire per the owner 2026-10-04 hide-thinking
 *    directive; replaysReasoning() is kimi-family-only so the zai live
 *    reasoning is never persisted) — therefore the conviction rode the
 *    LIVE reasoning channel: glm-5.3 narrated its planned NEXT step
 *    ("then tests + tsc" — the verify step it announced in its own content
 *    channel) while correctly emitting the fifteen surgical edits. The
 *    strike telemetry pins the live channel's content: intended:"verify",
 *    churned:false (a STANDALONE mention, stable across the message).
 * 3. NO CROSS-MESSAGE CONTAMINATION: the run's FIRST top-level edit_file
 *    call is seq 559 — inside the convicted batch itself (TOPLEVEL_EDIT_
 *    CALLS 17, first_seq=559; SUBAGENT_EDIT_CALLS 0). The FIVE guard_miss
 *    rows before the trip (16:02–16:20Z) are all correct ACQUITTALS —
 *    4× batch_sibling (update_plan/read_file with the named sibling in
 *    the same batch) + 1× preamble_ordered (get_fleet_telemetry with the
 *    haystack match, armed on a platform tool) — measurement rows that
 *    never feed the live counter, and all on OTHER tools (update_plan,
 *    get_fleet_telemetry, read_file), so they neither seeded nor extended
 *    the edit_file streak. (The run's sixth guard_miss row is 17:27:08Z,
 *    AFTER the trip: seam final_verdict, outcome clean.) The
 *    pair-agnostic counter keyed on the CALLED tool (c737d007) started at
 *    559 and reached 5 at 571, exactly per design.
 * 4. THE GUARD STACK behaved per design at every rung: steer armed at the
 *    third cumulative mismatch (reanchor metric 16:43:34.374Z, reason
 *    intent_mismatch_success, intended verify, churned:false — deferred to
 *    message end, guard_marker seq 604: "[HARNESS] Re-anchor steer
 *    injected: wrong-tool signature on edit_file (reasoning named
 *    verify)"), one-round withhold at the fifth (break metric
 *    16:43:38.362Z, shape success_intent, perma:false — no perma, no
 *    run-end), the steer told the TRUTH about the SUCCESS shape, the
 *    batch-sibling acquittal correctly never fired (no verify call in the
 *    batch), the 0625bf62 discount correctly never applied (edit_file is
 *    a coding tool — platform-tool scope), and calls 6..15 of the batch
 *    all executed (the withhold applies to the next round, not the
 *    in-flight batch).
 * 5. THE CONTAINMENT WORKED — the same recovery shape as 2547b652/
 *    267ea7b6/8da24785: the next model turn ("The edits all landed (15
 *    successful diffs — AGENTS.md ×5, .env.example …") called verify (seq
 *    612, 16:43:56Z — Verify PASSED receipt 6f547c89 at 16:44:32.186Z,
 *    verify_result event 614), then git_commit dd3d099f8 (16:44:53Z), push,
 *    PR #1784 (opened 16:45:44Z, MERGED 17:21:40Z, merge commit 12859163c)
 *    — the lane shipped its shortfall fix clean despite the mid-batch
 *    trip. No owner impact; severity was zero wasted work (the run
 *    continued on-task; every edit was real, intended work).
 *
 * No detector change rides this ticket (per the detector-change rule; the
 * 267ea7b6 pin owns the REJECTED per-(batch,tool) dedup defense — a
 * batch-size cap would be the same rejected class, and this instance
 * proves containment at call 5 is batch-size-independent). Deliverable:
 * - this replay pin: elimination leg (recovered content channels convict
 *   nothing; the modeled live-reasoning narration convicts), incident
 *   replay (steer@3/trip@5/6th..15th execute/one-round withhold/verify
 *   recovery), the counting negative (the message-scoped counter does not
 *   reach back across aligned messages), and the 15-call batch-shape
 *   leg (a larger batch changes nothing: same steer, same trip, ten
 *   post-trip siblings still execute).
 * - scripts/framework-audit/probe-601d819e-a.js / -b.js — the committed
 *   forensic probes (message-boundary CTX grouping + verify-occurrence
 *   classification + deployed-detector battery; guard-miss meta census)
 *   for the evidence trail.
 *
 * Scaffold mirrors agent-derail-break.2547b652.test.ts: every mismatched
 * call SUCCEEDS ('probe result: ok'), edit_file args are the wild residue-
 * trim shapes (letter-skeleton-varied so the exact and digit-collapsed
 * repeat signatures stay blind), the narration names exactly ONE offered
 * tool as a whole word and never the called edit_file (an unoffered named
 * tool makes detectIntendedTool return null and silently resets the streak
 * — the c737d007 test-writing gotcha), and args carry no id-shaped keys so
 * no ungrounded-id preflight leg can refuse them.
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

const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, _name: string, _args: any) => 'probe result: ok');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockToolCacheExec: jest.Mock = jest.fn(async (_name: string, _args: any) => 'probe result: ok');
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
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  fileStreakInvestigation: jest.fn(async () => undefined),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { detectIntendedTool, detectIntendedToolChannels, intentMismatchDiscount } from './tool-preflight';

/** CODING profile (no workspace container in the scaffold). */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

/** The incident's wake text (R&D stream-1 firing 29): the shortfall hunt
 *  named the metric sweep AND the verify step — the narration-slip is the
 *  model's own, but the brief makes the verify next-step plan legitimate
 *  (that is exactly why the model narrated it mid-batch). */
const BRIEF = 'Firing 29 (2026-10-19) of the R&D stream-1 standing loop: score the feedback queue fresh, re-measure the six daily audit metrics, probe the schedule-health framework surface for a real shortfall, fix directly with tests + tsc green, and verify the chain before reporting deltas only.';

const makeInput = (userMessage: string = BRIEF, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-601d819e-test',
  sessionId: 'sess-601d819e',
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

/** The incident narration (the LIVE reasoning channel of the convicted
 *  message — not persisted for zai/glm-5.3, but pinned by the guard's own
 *  strike telemetry: intended verify, churned:false, standalone): the
 *  model narrated its planned NEXT step — the tests+tsc verify its own
 *  content channel announced ("then tests + tsc:") — while edit_file
 *  correctly executed the fifteen residue-trim edits. Names exactly ONE
 *  offered tool as a whole word and NEVER the called edit_file. */
const P_NARRATION = 'All the residue edits are staged; before the close-out I will verify the chain with tests and typecheck against the retirement list.';

/** The verbatim-recovered CONTENT channel of the convicted message (probe
 *  fact: 225 chars of text deltas, ZERO tool mentions under the broad
 *  boundary — not verify, not even edit_file). */
const C_CONVICTED = 'Clock 16:41Z. Executing the residue fix now — one batch of surgical edits (AGENTS.md instrumentation claims, `.env.example` kill-switch comments, the two jest mocks, FRAMEWORK_LESSONS row, learnings bullet), then tests + tsc:';

/** The verbatim-recovered CONTENT channel of ONE adjacent aligned
 *  multi-call message in the fix phase (probe fact: the 16:47Z
 *  conflict-resolution message — single-edit, verify-free, on-task). */
const C_ALIGNED_1 = 'Clock 16:47Z. The conflict is clear: main holds the F28 vocabulary-parity row in its FULL form (from the squash merge — my branch\'s copy was the pre-squash truncated variant), plus my new S-2 row on this side. Resolution: keep main\'s full row + my S-2 row, drop the truncated duplicate:';

/** The elimination corpus — NOT the whole fix phase (the reviewer's F4):
 *  exactly the two recovered messages above (C_CONVICTED + C_ALIGNED_1,
 *  225 + 260 chars). The unit assertion proves these two channels
 *  convict nothing standalone and jointly; the complete per-message
 *  census (every text delta of the window, incl. the 17:09Z diagnostic
 *  message and the recovery narration) lives in the probe output
 *  (probe-601d819e-a.js EDIT_GROUPS), not in this pin. */
const C_WILD_WHOLE = C_CONVICTED + '\n\n' + C_ALIGNED_1;

/** The wild residue-trim shapes (ticket args + PR #1784's file list,
 *  letter-skeleton-varied so no repeat signature can fire): dead
 *  references to the retired loop_metrics kinds across the five files.
 *  The pin models the CONVICTED message's fifteen calls; the wild run's
 *  paths are AGENTS.md ×5, .env.example ×2, the two jest mocks,
 *  FRAMEWORK_LESSONS.md, learnings.md — varied per call the way the wild
 *  batch varied them. */
const TRIMS: Array<[string, string, string]> = [
  ['AGENTS.md', '  Metric `busy_firing_steered` rides the fleet view; a crossed lane re-arm logs it once per window', '  A crossed lane re-arm rides the fleet view once per window'],
  ['AGENTS.md', '  busy-skip crossings record `schedule_busy_alarm` instead of a hook', '  busy-skip crossings log a warn instead of a hook'],
  ['AGENTS.md', '  (`lastStatus \'skipped:delta_unchanged\'\`, and `schedule_delta_skip` budgets the crossing', '  (`lastStatus \'skipped:delta_unchanged\'\`, the crossing is visible on the schedule row'],
  ['.env.example', '# SCHEDULE_BUSY_ALARM=1 — busy-skip crossings write the metric row', '# busy-skip crossings log a warn (no metric row)'],
  ['.env.example', '# SCHEDULE_DELTA_SKIP=1 — delta-gate skips write the metric row', '# delta-gate skips are visible on the schedule row (no metric row)'],
  ['backend/src/modules/crossmodel/coding/delta-gate.0b1dbe75.test.ts', "        expect(metric.meta.kind).toBe('schedule_delta_skip');", "        expect(metric.meta.skip).toBe(true);"],
  ['backend/src/modules/crossmodel/coding/schedule.material-gate.w6.test.ts', "      kinds: ['schedule_busy_alarm', 'material_gate'],", "      kinds: ['material_gate'],"],
  ['docs/FRAMEWORK_LESSONS.md', '| `schedule_delta_skip` | delta-gate crossings | retired 2026-10-08 (S-2) |', '| delta-gate crossings | visible on the schedule row | retired 2026-10-08 (S-2) |'],
  ['.digby/notes/learnings.md', '- A busy firing that steers a lane logs `busy_firing_steered` once per window.', '- A busy firing that steers a lane is visible in the delivered note.'],
  ['AGENTS.md', '  The `busy_firing_steered` metric was removed by S-2 2026-10-08 (unread) —', '  The steer itself is visible in the delivered note. Kill switch'],
  ['AGENTS.md', '  the `schedule_delta_skip` row rides the schedule ledger', '  the skip rides the schedule ledger'],
  ['AGENTS.md', '  (metric `busy_firing_steered`, window 24h)', '  (window 24h)'],
  ['.env.example', '# DERAIL_BUSY_METRIC=1', '# (removed — S-2)'],
  ['docs/FRAMEWORK_LESSONS.md', '| `busy_firing_steered` | busy-skip steers | retired 2026-10-08 (S-2) |', '| busy-skip steers | visible in the delivered note | retired 2026-10-08 (S-2) |'],
  ['.digby/notes/learnings.md', '- Delta-skip crossings write `schedule_delta_skip` (no run budget burned).', '- Delta-skip crossings burn no run budget.'],
];
const editCall = (n: number) => {
  const [path, old_string, new_string] = TRIMS[(n - 1) % TRIMS.length];
  return {
    id: `t${n}`,
    name: 'edit_file',
    arguments: JSON.stringify({ path, old_string, new_string }),
  };
};

/** THE INCIDENT SHAPE — ONE MESSAGE of FIFTEEN edit_file calls (wild
 *  CTX558 → calls 559..601, all SUCCEEDED) under the verify-naming live
 *  reasoning with a verify-free content channel. Steer arms at call 3,
 *  trip at call 5, calls 6..15 still execute (the withhold applies to the
 *  next round's schema, not the in-flight batch). */
const convictedBatchTurn = {
  content: C_CONVICTED,
  reasoning: P_NARRATION,
  toolCalls: Array.from({ length: 15 }, (_v, i) => editCall(i + 1)),
  finishReason: 'tool_calls' as const,
};

/** An ALIGNED earlier message (wild @CTX657 → 1 edit): the same residue
 *  work, but the narration names the called tool's work truthfully —
 *  proving the streak does not reach back into earlier messages. */
const alignedTurn = {
  content: C_ALIGNED_1,
  reasoning: 'Resolving the FRAMEWORK_LESSONS conflict: keeping main\'s full row, dropping the truncated duplicate with one edit.',
  toolCalls: [editCall(8)],
  finishReason: 'tool_calls' as const,
};

/** The MODELED RECOVERY turn (the wild lane's post-steer behavior, seq
 *  612): acknowledges the landed batch, then calls verify — the grounded
 *  next action — as a single aligned call (edit_file sits out its
 *  one-round ban this round). */
const recoveryVerifyTurn = {
  content: 'The edits all landed (15 successful diffs) — re-anchoring: calling `verify` now, as intended for this stage of the work.',
  reasoning: 'Now verify the residue fix with the chain before the close-out.',
  toolCalls: [{ id: 'tv1', name: 'verify', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls' as const,
};
const FINAL = { content: 'Close-out complete — the retired kinds are gone from every taught surface and the chain is green.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');
const conversation = () => mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }>;
const steerMessages = () => (conversation() || []).filter(
  (m) => m?.role === 'user' && typeof m.content === 'string' && m.content.includes('RE-ANCHOR (one per run)'),
);
const userTexts = () => (conversation() || []).filter((m) => m?.role === 'user').map((m) => String(m.content));

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 601d819e — single-message stable+loud success-side derail on glm-5.3 (15-call batch): guard correct, containment effective, model behavior', () => {
  it('UNIT (the elimination leg): the verbatim-recovered CONTENT channels convict NOTHING — the conviction necessarily rode the LIVE reasoning channel (not persisted for non-kimi providers)', () => {
    const offered = ['run_command', 'edit_file', 'verify', 'read_file', 'grep', 'write_file', 'glob'];
    // The whole recovered span (probe fact: every text delta of the fix
    // phase) as one content channel — every per-message subset is
    // contained in it, so zero mentions here means zero in each
    // message's own channel too.
    expect(detectIntendedToolChannels('', C_WILD_WHOLE, 'edit_file', offered)).toBeNull();
    // The faithful per-message content channels convict nothing on their own.
    expect(detectIntendedTool(C_CONVICTED, 'edit_file', offered)).toBeNull();
    expect(detectIntendedTool(C_ALIGNED_1, 'edit_file', offered)).toBeNull();
    // The modeled live-reasoning narration DOES convict — the only channel
    // that can have carried the standalone `verify` the strike meta named.
    expect(detectIntendedTool(P_NARRATION, 'edit_file', offered)).toBe('verify');
    expect(detectIntendedToolChannels(P_NARRATION, C_CONVICTED, 'edit_file', offered)).toBe('verify');
    // edit_file is a CODING tool — the 0625bf62 platform-tool discount is
    // out of scope even when the wake text names the work (measure-first).
    expect(intentMismatchDiscount('verify', 'edit_file', BRIEF)).toBeNull();
  });

  it('REPLAY the incident (ONE message of FIFTEEN mismatched edit_file calls, STABLE intent verify, coding-tool scope): steer at the third call, trip at the fifth, calls 6..15 still execute, one-round withhold only, and the run RECOVERS on the modeled verify turn', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(convictedBatchTurn) // wild CTX558: 15 mismatches, one message, all SUCCEED (559..601)
      .mockResolvedValueOnce(recoveryVerifyTurn)  // the ban round: edit_file absent; verify runs (wild seq 612)
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Close-out complete — the retired kinds are gone from every taught surface and the chain is green.');
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');

    // ── Steer armed at the THIRD cumulative mismatch (call 565's count),
    //    deferred to message end (wild reanchor metric 16:43:34.374Z,
    //    guard_marker seq 604) ──
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run)');
    expect(steer).toContain('your own reasoning named verify');
    expect(steer).toContain('call verify NOW');
    // The steer tells the TRUTH about the SUCCESS shape (2c98b460 reviewer F1).
    expect(steer).toContain('it SUCCEEDED');
    expect(steer).not.toContain('and it failed');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({
      tool: 'edit_file', intended: 'verify', reason: 'intent_mismatch_success', churned: false,
    });

    // ── Trip at the FIFTH cumulative mismatch, one round only — the
    //    incident's exact meta (break 16:43:38.362Z) ──
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({
      tool: 'edit_file', perma: false, intended: 'verify', churned: false, shape: 'success_intent',
    });
    expect(breakerMetrics()).toHaveLength(1); // one-round withhold only — no perma, no run-end

    // ── The post-trip siblings executed despite the trip: the withhold
    //    applies to the NEXT round's schema, not the in-flight batch (wild
    //    calls 574..601 succeeded 16:43:34.313Z→16:43:34.375Z, after the
    //    trip's count at 571) — ALL FIFTEEN dispatched ──
    const editDispatches = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'edit_file');
    expect(editDispatches.length).toBe(15);

    // ── The modeled recovery: the post-steer turn calls verify (the
    //    grounded next action), the run continues and finishes clean ──
    const verifyDispatch = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'verify');
    expect(verifyDispatch.length).toBeGreaterThanOrEqual(1);
    // The user-visible notices tell the TRUTH about the success shape:
    // the withhold notice says the last 5 edit_file calls SUCCEEDED and
    // names the intended verify — the byte-shape the wild lane received
    // at 16:43:34Z/16:43:38Z (the steer is the run's ONE guard_marker,
    // seq 604; the withhold notice rides the next round's user message,
    // verified here from the guard's own template, agent.ts:6238).
    const withholdNotice = userTexts().find((t) => t.includes('temporarily removed from your tool list'));
    expect(withholdNotice).toBeDefined();
    expect(withholdNotice).toContain('Your last 5 calls of edit_file all SUCCEEDED');
    expect(withholdNotice).toContain('Your own reasoning named verify');
  });

  it('REPLAY the counting NEGATIVE (the one-message proof): an ALIGNED earlier message never feeds the streak — an aligned edit before the convicted message does not pre-arm the steer or pre-trip the breaker (a cross-message misattribution would have changed the counts)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(alignedTurn)        // 1 aligned call — no mismatch counted
      .mockResolvedValueOnce(convictedBatchTurn) // 15 mismatches — steer at 3, trip at 5
      .mockResolvedValueOnce(recoveryVerifyTurn)
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // The steer + trip fired ONLY out of the convicted message (counts
    // 1..15 all inside it — steer at 3, trip at 5). If the aligned
    // message's call had been miscounted, the steer would have armed one
    // call early and the trip one call early — the metrics' singleton
    // shapes and the 15 dispatches pin the exact counting.
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'edit_file', intended: 'verify' });
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics().some((m) => m.meta?.shape === 'success_intent' && m.meta?.tool === 'edit_file')).toBe(true);
    expect(reanchorMetrics().every((m) => m.meta?.tool === 'edit_file')).toBe(true);
    // 1 aligned + all 15 convicted-batch calls dispatched.
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'edit_file').length).toBe(16);
  });

  // ── THRESHOLD legs (reviewer F2, the 2c98b460 precedent's pinning
  //    shape): the success-leg reanchor metric carries no count field
  //    (agent.ts:5856 arms reAnchorPending without one), so cardinality
  //    alone cannot distinguish steer@3/trip@5 from steer@2/trip@4 — a
  //    regression would keep the replay legs green. These legs pin the
  //    exact thresholds with sub-threshold batches: 2 mismatches never
  //    steer, 3 steer without tripping, 4 steer without tripping, and the
  //    5-call leg above (BATCH-SIZE INDEPENDENCE) trips exactly once. ──
  const nCallTurn = (n: number) => ({ ...convictedBatchTurn, toolCalls: Array.from({ length: n }, (_v, i) => editCall(i + 1)) });

  it('THRESHOLD steer-at-3 (the 2c98b460 precedent shape): TWO mismatched edit_file successes never arm the steer, THREE arm it exactly once without tripping, FOUR still do not trip', async () => {
    // TWO mismatches: below the steer threshold — no reanchor, no break.
    mockRunModelTurn.mockResolvedValueOnce(nCallTurn(2)).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(reanchorMetrics()).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0);

    // THREE mismatches: the steer arms (reanchor metric), the breaker
    // NEVER engages below the trip threshold — the run finishes clean.
    jest.clearAllMocks();
    mockRunModelTurn.mockResolvedValueOnce(nCallTurn(3)).mockResolvedValue(FINAL);
    const r3 = await runCodingAgent(makeInput());
    expect(r3.modelErrored).toBeUndefined();
    expect(r3.finalText).not.toContain('Run ended: repeated wrong-tool derailment');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'edit_file', intended: 'verify', reason: 'intent_mismatch_success' });
    expect(breakerMetrics()).toHaveLength(0);

    // FOUR mismatches: still no trip — one steer only (one per run), the
    // withhold has not fired (a steer@2/trip@4 regression trips here).
    jest.clearAllMocks();
    mockRunModelTurn.mockResolvedValueOnce(nCallTurn(4)).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(reanchorMetrics()).toHaveLength(1);
    expect(breakerMetrics()).toHaveLength(0);
  });

  it('THRESHOLD trip-at-5 (the 2c98b460 precedent shape): the FIFTH mismatched edit_file success trips the one-round withhold with the success_intent shape — the exact rung the wild batch crossed at call 571', async () => {
    mockRunModelTurn.mockResolvedValueOnce(nCallTurn(5)).mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput());
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');
    expect(reanchorMetrics()).toHaveLength(1); // the steer still fired at the third
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta).toMatchObject({ tool: 'edit_file', perma: false, intended: 'verify', shape: 'success_intent' });
    // The withheld-tool round: edit_file is absent from the tool schema of
    // the next model request (the withhold hits the NEXT round, and this
    // run has no further edit dispatch after the trip's batch).
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'edit_file').length).toBe(5);
  });

  it('BATCH-SIZE INDEPENDENCE (the shape this instance adds to the class): the trip fires at the FIFTH call of the batch whether the batch holds five, six or fifteen calls — the counter is per-CALL, never per-batch, and the ten post-trip siblings all execute (a per-(batch,tool) dedup would have acquitted all fifteen — the rejected 267ea7b6 defense)', async () => {
    // The five-call variant: steer at 3, trip at 5, ALL dispatched.
    const fiveCallTurn = { ...convictedBatchTurn, toolCalls: Array.from({ length: 5 }, (_v, i) => editCall(i + 1)) };
    mockRunModelTurn
      .mockResolvedValueOnce(fiveCallTurn)
      .mockResolvedValueOnce(recoveryVerifyTurn)
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(reanchorMetrics()).toHaveLength(1);
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta).toMatchObject({ tool: 'edit_file', intended: 'verify', shape: 'success_intent' });
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'edit_file').length).toBe(5);

    // The fifteen-call variant (the wild shape): SAME single steer, SAME
    // single trip, all FIFTEEN dispatched — batch size changes nothing
    // about containment timing; only the number of post-trip siblings
    // grows (10 here vs 0 in the five-call shape).
    jest.clearAllMocks();
    mockRunModelTurn
      .mockResolvedValueOnce(convictedBatchTurn)
      .mockResolvedValueOnce(recoveryVerifyTurn)
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(reanchorMetrics()).toHaveLength(1);
    expect(breakerMetrics()).toHaveLength(1);
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'edit_file').length).toBe(15);
  });
});

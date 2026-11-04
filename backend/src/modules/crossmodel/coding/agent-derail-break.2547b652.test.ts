/**
 * REPLAY TEST — ticket 2547b652 (mishap, 2026-10-11): "5× success-side
 * wrong-tool loop: edit_file on 'Wire media into RAG + chat · Durable rec'
 * — framework or model?" Auto-filed at the breaker trip (owner doctrine
 * 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session 556feef7-64cb-4300-bf53-ff0382a92114 — the
 * media-transcription lane firing 11, a different project than crossmodel;
 * run f7654716-7209-454f-9576-926bc9e550bc, cql-litellm:api-alibaba-
 * qwen3.8-max, coding profile, MACHINE-triggered; run COMPLETED
 * 2026-10-11T17:05:00.184Z, step 55, error null, and SHIPPED — verify
 * PASSED 16:57:38Z, git_commit 25e3868 16:59:13Z, branch_pushed 16:59:27Z).
 * The lane was compressing .digby/rules/00-current-state.md under the
 * 6000-char cap.
 *
 * THE STREAK IS ONE MESSAGE, NOT THREE TURNS (the structural fact this
 * ticket adds to the family — first misread as three turns by marker
 * matching, corrected by message-boundary forensics):
 * agent_events 'context' rows carry a `turn` key (gaugeTurn, agent.ts
 * :4380) exactly once per MODEL MESSAGE — emitted at message END: a
 * message is [its text deltas] [its turn-key boundary] [its tool calls].
 * Deltas stream BEFORE their own boundary, so attribution must assign
 * them to the boundary that FOLLOWS them (the first probe revision
 * grouped by nearest-boundary-below and hung each narration on the
 * PREVIOUS message — review F1, corrected in probe-2547b652-d.js v2).
 * In the convicted window:
 *   · message @CTX449 (16:49:56Z): ONE edit_file call (450) + a read_file —
 *     aligned; no trip;
 *   · message @CTX461 (16:52:10Z): FIVE edit_file calls (462..474) —
 *     content "Banner is in (~720 bytes over budget now) — applying the
 *     shorter banner plus compensating trims, including fixing the
 *     `continuous.py:1341` line-citation to the `run_source()` symbol per
 *     the banked lesson." — verify-free; NO trip fired here;
 *   · message @CTX482: ONE run_command (the wc -c measure) — narration
 *     "Clock 09:52:10Z — continuing step 5. Applying the remaining trims,
 *     then measuring the byte count against the 6000 cap." (exempt tool);
 *   · message @CTX490 (16:54:03Z): THIRTEEN edit_file calls (491..526) —
 *     content "State file is at 6339 — needs ~370 more trimmed. Applying
 *     the remaining compression edits in one batch (unique, non-overlapping
 *     strings)." — verify-free; NO trip fired here;
 *   · message @CTX543 (16:55:38Z): SEVEN edit_file calls (544..562) —
 *     content "Clock 09:54:27Z — 6188 bytes, ~190+ to trim. The failed
 *     edit was an ordering mistake (the `Low id` bullet precedes
 *     `cross-firing` in the file). Applying the remaining trims." —
 *     verify-free; NO trip;
 *   · THE CONVICTED MESSAGE @CTX576 (16:56:48.659Z): SIX edit_file calls
 *     (577, 580, 583, 586, 589, 592) under ONE narration — content
 *     "Clock 09:55:54Z — 6132 bytes, ~165 to go. Final round of trims."
 *     (verify-free), LIVE reasoning naming `verify` standalone. Per-call
 *     counting across the message: 577(1) 580(2) 583(3 → steer arms)
 *     586(4) 589(5 → TRIP) 592(6, counted and executed — no second trip,
 *     the withheldTool gate; the withhold applies to the NEXT round's
 *     schema). The ticket's ×5 = the count at the trip; both notices
 *     deferred to message end (reanchor metric 16:56:48.844Z, guard_marker
 *     seq 595; break metric 16:56:53.189Z when the withhold hits the next
 *     schema build).
 * THE ONE-CHECK DISPROOF of the three-turn misread: loop_metrics
 * guard_strike for the run holds EXACTLY TWO rows (reanchor
 * 16:56:48.844Z, break 16:56:53.189Z). The detector input (turn.reasoning
 * + turnText, agent.ts:5580) is MESSAGE-scoped — identical for every call
 * of a message, so a message's calls convict or acquit TOGETHER. Either
 * earlier multi-call message convicting would have crossed 5 INSIDE
 * itself (five calls at 16:52:10, thirteen at 16:54:03) and tripped +
 * auto-filed at 16:52:10 / 16:54:03 — no trip, no break metric, no ticket
 * exists before 16:56:48. Ergo neither earlier message convicted: their
 * narrations were aligned (content channels verify-free; live reasoning
 * evidently too). The three-turn misread came from the ticket's
 * recentArgs = the newest THREE counted misses only (583/586/589,
 * reflection.ts recentArgs.slice(0,3)): the marker strings ("NEVER edit
 * scripts/media_transcribe_run.sh mid-pass…", "probe history, delta…")
 * occur in EARLIER edits of the same file too (written at seq 471 in the
 * 16:52:10 aligned message, re-trimmed at 583 in the convicted one) — a
 * marker match is not streak membership.
 *
 * ADJUDICATION (this lane, 2026-10-11, evidence-led, prod-DB probes
 * scripts/framework-audit/probe-2547b652-c.js + -d.js via prodq; the
 * FO lane independently derived the same verdict, chat 5f90c628):
 * MODEL-SIDE — no deterministic framework/schema/preflight/guard defect
 * caused the streak.
 * 1. The trip fired ON THE FIXED COUNTER: the 022eb482 filename-glue fix
 *    (e7371b93c) landed 12:56Z and was deployed by 13:30Z; the run started
 *    16:03:40Z and the convicted message dispatched 16:56:48Z, on
 *    deployed code ≤ 98156aeb (main head at trip time). The retired glue
 *    false-positive class (a `verify` glued into `verify-wave.sh`) cannot
 *    apply — post-fix, glue does NOT convict.
 * 2. ELIMINATION ON THE DETECTOR INPUT: detectIntendedToolChannels reads
 *    turn.reasoning + (turnText||turn.content). The CONTENT channel of the
 *    convicted message was recovered verbatim from agent_events text
 *    deltas ("Clock 09:55:54Z — 6132 bytes, ~165 to go. Final round of
 *    trims.") and contains ZERO `verify` mentions under the BROAD acquittal
 *    boundary (stricter than the conviction counter); the DEPLOYED
 *    detector replayed on the recovered channels (content + empty
 *    reasoning) returns intended:null — no conviction — while the guard's
 *    own strike telemetry recorded intended:"verify", churned:false (a
 *    STANDALONE mention, stable across the message). The live reasoning
 *    channel is provably not persisted for this provider (reasoning-wire.ts
 *    cuts `reasoning` events at the wire per the owner 2026-10-04
 *    hide-thinking directive; replaysReasoning() is kimi-family-only, so
 *    checkpoints store no reasoning) — therefore the conviction rode the
 *    LIVE reasoning channel: qwen3.8-max narrated its planned NEXT step
 *    (verify the byte count against the cap) while correctly emitting the
 *    trim edits. The 267ea7b6 narration-word-slip class, SECOND wild
 *    single-batch catch on the same model family (third model family in
 *    the class per the 267ea7b6 header: glm-5.3, kimi-k3, qwen3.8-max).
 * 3. The GUARD STACK behaved per design at every rung: steer armed at the
 *    third cumulative mismatch (reanchor metric 16:56:48.844Z, reason
 *    intent_mismatch_success, intended verify, churned:false — deferred
 *    to message end), one-round withhold at the fifth (break metric
 *    16:56:53.189Z, shape success_intent, perma:false — no perma, no
 *    run-end), the steer told the TRUTH about the SUCCESS shape, the
 *    batch-sibling acquittal correctly never fired (no verify call in the
 *    batch) nor the 0625bf62 discount (edit_file is a coding tool —
 *    platform-tool scope), and the sixth sibling executed (the withhold
 *    applies to the next round, not the in-flight batch).
 * 4. The CONTAINMENT WORKED — the same recovery shape as 267ea7b6/8da24785:
 *    the next model turn said "Re-anchoring: calling `verify` now, as
 *    intended for this stage of the work…" and CALLED verify (seq 607 —
 *    Verify PASSED receipt, 16:57:38Z), edit_file returned after its
 *    one-round ban, and the run completed clean and shipped (git_commit
 *    25e3868, branch_pushed, finish 17:05:00Z, error null).
 * 5. Per-call counting over turn-scoped narration is BY DESIGN — the
 *    8da24785 pin owns the single-batch assertion, and the 267ea7b6 pin
 *    owns the REJECTED per-(batch,tool) dedup defense (its replay broke
 *    SIX prior pinned true positives). No detector change rides this
 *    ticket: every rung fired correctly.
 *
 * THIS PIN replays the incident's exact shape against the REAL agent loop
 * and asserts: the verbatim-recovered content channel convicts NOTHING on
 * its own (the elimination leg — this family's new member); the modeled
 * live-reasoning narration convicts edit_file of intending verify; ONE
 * message of SIX edit_file calls under that narration steers at the third
 * call, trips at the fifth, lets the sixth execute, withholds edit_file
 * for exactly one round (churned:false both metrics); and the modeled
 * recovery turn (verify call after the ban round, per the wild seq-607
 * recovery) confirms the run CONTINUES clean and finishes shipping.
 *
 * Scaffold mirrors agent-derail-break.267ea7b6.test.ts: every mismatched
 * call SUCCEEDS ('probe result: ok'), edit_file args are the wild trim
 * shapes (letter-skeleton-varied so the exact and digit-collapsed repeat
 * signatures stay blind), the narration names exactly ONE offered tool as
 * a whole word and never the called edit_file (an unoffered named tool
 * makes detectIntendedTool return null and silently resets the streak —
 * the c737d007 test-writing gotcha), and args carry no id-shaped keys so
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

/** The incident's wake text (media lane firing 11): queue-probe work plus
 *  the state-file cap — names NOTHING the guard could misread as ordering
 *  the called edit_file (the narration-slip is the model's own). */
const BRIEF = 'Firing 11: prove from fresh probes whether the transcription queue holds work, run a bounded pass only if it does, keep the state file under the 6000-char cap, then verify the numbers before reporting.';

const makeInput = (userMessage: string = BRIEF, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-2547b652-test',
  sessionId: 'sess-2547b652',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

/** The incident narration (the LIVE reasoning channel of the convicted
 *  message — not persisted for this provider family, but pinned by the
 *  guard's own strike telemetry: intended verify, churned:false,
 *  standalone): the model narrated its planned NEXT step — verifying the
 *  byte count — while edit_file correctly executed the trim edits. Names
 *  exactly ONE offered tool as a whole word and NEVER the called
 *  edit_file. */
const P_NARRATION = 'All the durable-record trims are staged; before the close-out I will verify the state file byte count against the 6000 cap with the measure step.';

/** The verbatim-recovered CONTENT channel of the convicted message (probe
 *  fact: "Clock 09:55:54Z — 6132 bytes, ~165 to go. Final round of
 *  trims." — 63 chars of text deltas, ZERO tool mentions under the broad
 *  boundary). */
const C_CONVICTED = 'Clock 09:55:54Z — 6132 bytes, ~165 to go. Final round of trims.';

/** The verbatim-recovered CONTENT channels of the ALIGNED earlier
 *  trim-phase multi-call messages (probe-d v2 facts — streaming-order
 *  corrected: each narration is the text that streamed just before ITS OWN
 *  turn-key boundary; all verify-free; no trip fired in any of them, so
 *  their live reasoning was aligned too). The exempt run_command measure
 *  messages carried the "Clock 09:52:10Z…" / "Clock 09:54:03Z…" /
 *  "Clock 09:55:39Z…" narrations. */
const C_ALIGNED_5 = 'Banner is in (~720 bytes over budget now) — applying the shorter banner plus compensating trims, including fixing the `continuous.py:1341` line-citation to the `run_source()` symbol per the banked lesson.';
const C_ALIGNED_13 = 'State file is at 6339 — needs ~370 more trimmed. Applying the remaining compression edits in one batch (unique, non-overlapping strings).';
const C_ALIGNED_7 = 'Clock 09:54:27Z — 6188 bytes, ~190+ to trim. The failed edit was an ordering mistake (the `Low id` bullet precedes `cross-firing` in the file). Applying the remaining trims.';
/** The whole recovered content-channel span of the trim phase — every text
 *  delta of the window in event order (probe-d v2 live output, this lane's
 *  review follow-up run 2026-10-11: per-message narrations in boundary
 *  order; the exempt measure narrations included) — the elimination input:
 *  the deployed detector convicts NOTHING on the persisted channels. The
 *  only verify-bearing content in the whole window is the RECOVERY
 *  message's (post-steer, where naming verify was correct behavior). */
const C_WILD_WHOLE = 'Clock 09:45:45Z. Crafting the durable record now. First: the exact byte count, the state-check script firing 9 used, and the learnings tail for a clean append.Clock 09:48:08Z — step 5. State file is at 5945 bytes against the 6000-char injection cap, so the banner goes in with compensating trims. First the banner + the symbol-citation fix, and reading the learnings tail for a clean append anchor.' + C_ALIGNED_5 + '\n\nClock 09:52:10Z — continuing step 5. Applying the remaining trims, then measuring the byte count against the 6000 cap.' + C_ALIGNED_13 + '\n\nClock 09:54:03Z. One trim failed on exact-match — re-reading that region to match precisely, then measuring.' + C_ALIGNED_7 + '\n\nClock 09:55:39Z — measuring after the trim batch.' + C_CONVICTED;

/** The wild trim shapes (ticket args, letter-skeleton-varied so no repeat
 *  signature can fire): all on .digby/rules/00-current-state.md. The
 *  marker-bearing rows ("NEVER edit scripts/media_transcribe_run.sh
 *  mid-pass…", "probe history, delta…") occur TWICE in the wild run —
 *  written in an earlier aligned message, re-trimmed in the convicted
 *  one; the pin models the CONVICTED message's six calls only. */
const TRIMS: Array<[string, string]> = [
  ['`tmp/media_freshness.jsonl` (probe history, delta basis + `pending_actionable`)', '`tmp/media_freshness.jsonl` (probe history, delta ledger + `pending_actionable`)'],
  ['**rc 4 or negative = RETRYABLE** (PR #89, proved 3x: #99/#100/#126)', '**rc 4 or negative = RETRYABLE** (PR #89, proved thrice)'],
  ['the `Low id` bullet precedes `cross-firing` in the file', 'the `cross-firing` bullet precedes `Low id` in the file'],
  ['retention sweep cadence of four hours for aged rows', 'retention sweep cadence of four ticks for aged rows'],
  ['bounded wake window of two hours per lane', 'bounded wake window of two ticks per lane'],
  ['the transcription queue drains on a four-hour cadence', 'the transcription queue drains on a four-tick cadence'],
];
const STATE_PATH = '.digby/rules/00-current-state.md';
const editCall = (n: number) => {
  const [old_string, new_string] = TRIMS[(n - 1) % TRIMS.length];
  return {
    id: `t${n}`,
    name: 'edit_file',
    arguments: JSON.stringify({ path: STATE_PATH, old_string, new_string }),
  };
};

/** THE INCIDENT SHAPE — ONE MESSAGE of SIX edit_file calls (wild CTX576
 *  → calls 577,580,583,586,589,592) under the verify-naming live
 *  reasoning with a verify-free content channel. Steer arms at call 3,
 *  trip at call 5, the SIXTH executes (the withhold applies to the next
 *  round's schema, not the in-flight batch). */
const convictedBatchTurn = {
  content: C_CONVICTED,
  reasoning: P_NARRATION,
  toolCalls: [editCall(1), editCall(2), editCall(3), editCall(4), editCall(5), editCall(6)],
  finishReason: 'tool_calls' as const,
};

/** An ALIGNED earlier message (wild CTX461 → 5 calls, no trip): the same
 *  trim work, but the narration names the called tool's work truthfully
 *  (no other offered tool as a whole word) — proving the streak does NOT
 *  reach back into earlier messages. */
const alignedTurn = {
  content: C_ALIGNED_5,
  reasoning: 'Continuing the durable-record compression: applying the next tranche of unique, non-overlapping trims to the state file.',
  toolCalls: [editCall(1), editCall(2), editCall(3), editCall(4), editCall(5)],
  finishReason: 'tool_calls' as const,
};

/** The MODELED RECOVERY turn (the wild lane's post-steer behavior, seq
 *  607): acknowledges the re-anchor, then calls verify — the grounded
 *  next action — as a single aligned call (edit_file sits out its
 *  one-round ban this round). */
const recoveryVerifyTurn = {
  content: 'Re-anchoring: calling `verify` now, as intended for this stage of the work — the durable-record edits are docs-only markdown under `.digby/`, so the chain should pass unchanged.',
  reasoning: 'Now verify the state file trims with the chain before the close-out.',
  toolCalls: [{ id: 'tv1', name: 'verify', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls' as const,
};
const FINAL = { content: 'Close-out complete — the state file is under the cap and every number carries a this-run citation.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

/** ADJACENT SHAPE (SYNTHETIC — NOT the wild instance, whose earlier trim
 *  rounds were ALIGNED): a streak accumulating 1+1+3 ACROSS model messages
 *  through EXEMPT run_command measurement turns. The wild run proves the
 *  aligned side of this seam (five- and thirteen-call aligned batches with
 *  no trip fired); this pin proves the accumulating side — run_command
 *  measurement turns neither increment nor reset the count. */
const C_M1 = 'Clock 09:52:10Z — applying the first tranche of trims, then measuring.';
const C_M2 = 'Clock 09:54:03Z — applying the second tranche of trims after the re-read.';
const C_MEASURE = 'Clock 09:53:30Z — measuring the byte count after the trim batch.';
const mismatchTurn = (n: number) => ({
  content: n === 1 ? C_M1 : C_M2,
  reasoning: P_NARRATION,
  toolCalls: [editCall(n)],
  finishReason: 'tool_calls' as const,
});
const measureTurn = (n: number) => ({
  content: C_MEASURE,
  reasoning: '',
  toolCalls: [{ id: `m${n}`, name: 'run_command', arguments: JSON.stringify({ command: `wc -c ${STATE_PATH} # pass ${n}` }) }],
  finishReason: 'tool_calls' as const,
});
const mismatchBatchTurn = {
  content: C_CONVICTED,
  reasoning: P_NARRATION,
  toolCalls: [editCall(3), editCall(4), editCall(5)],
  finishReason: 'tool_calls' as const,
};

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

describe('ticket 2547b652 — single-message stable+loud success-side derail on qwen3.8-max: guard correct, containment effective, model behavior', () => {
  it('UNIT (the elimination leg): the verbatim-recovered CONTENT channels convict NOTHING — the conviction necessarily rode the LIVE reasoning channel (not persisted for non-kimi providers)', () => {
    const offered = ['run_command', 'edit_file', 'verify', 'read_file', 'grep', 'write_file', 'glob'];
    // The whole recovered span (probe-c fact: every text delta, seq
    // 471..589) as one content channel — every per-message subset is
    // contained in it, so zero mentions here means zero in each
    // message's own channel too.
    expect(detectIntendedToolChannels('', C_WILD_WHOLE, 'edit_file', offered)).toBeNull();
    // The faithful per-message content channels convict nothing on their own.
    expect(detectIntendedTool(C_CONVICTED, 'edit_file', offered)).toBeNull();
    expect(detectIntendedTool(C_ALIGNED_5, 'edit_file', offered)).toBeNull();
    // The modeled live-reasoning narration DOES convict — the only channel
    // that can have carried the standalone `verify` the strike meta named.
    expect(detectIntendedTool(P_NARRATION, 'edit_file', offered)).toBe('verify');
    expect(detectIntendedToolChannels(P_NARRATION, C_CONVICTED, 'edit_file', offered)).toBe('verify');
    // edit_file is a CODING tool — the 0625bf62 platform-tool discount is
    // out of scope even when the wake text names the work (measure-first).
    expect(intentMismatchDiscount('verify', 'edit_file', BRIEF)).toBeNull();
  });

  it('REPLAY the incident (ONE message of SIX mismatched edit_file calls, STABLE intent verify, coding-tool scope): steer at the third call, trip at the fifth, the SIXTH still executes, one-round withhold only, and the run RECOVERS on the modeled verify turn', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(alignedTurn)       // wild CTX461: an ALIGNED earlier message — no trip reaches back
      .mockResolvedValueOnce(convictedBatchTurn) // wild CTX576: six mismatches, one message, all SUCCEED (577..592)
      .mockResolvedValueOnce(recoveryVerifyTurn) // the ban round: edit_file absent; verify runs (wild seq 607)
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Close-out complete — the state file is under the cap and every number carries a this-run citation.');
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');

    // ── Steer armed at the THIRD cumulative mismatch (call 583's count),
    //    both notices deferred to message end (wild 16:56:48.844Z) ──
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
    //    incident's exact meta (break 16:56:53.189Z) ──
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({
      tool: 'edit_file', perma: false, intended: 'verify', churned: false, shape: 'success_intent',
    });
    expect(breakerMetrics()).toHaveLength(1); // one-round withhold only — no perma, no run-end

    // ── The SIXTH sibling executed despite the trip: the withhold applies
    //    to the NEXT round's schema, not the in-flight batch (wild 592
    //    succeeded at 16:56:48.832Z, after the trip's count at 589) ──
    const editDispatches = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'edit_file');
    expect(editDispatches.length).toBe(11); // 5 aligned + all 6 convicted-batch calls

    // ── The modeled recovery: the post-steer turn calls verify (the
    //    grounded next action), the run continues and finishes clean ──
    const verifyDispatch = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'verify');
    expect(verifyDispatch.length).toBeGreaterThanOrEqual(1);
    // The user-visible notices tell the TRUTH about the success shape:
    // the withhold notice says the last 5 edit_file calls SUCCEEDED and
    // names the intended verify — byte-shapes the wild lane received at
    // 16:56:48.844Z/16:56:53.189Z (guard_marker seq 595).
    const withholdNotice = userTexts().find((t) => t.includes('temporarily removed from your tool list'));
    expect(withholdNotice).toBeDefined();
    expect(withholdNotice).toContain('Your last 5 calls of edit_file all SUCCEEDED');
    expect(withholdNotice).toContain('Your own reasoning named verify');
  });

  it('REPLAY the counting NEGATIVE (the one-message proof): an ALIGNED earlier message never feeds the streak — five aligned edit_file calls before the convicted message do not pre-arm the steer or pre-trip the breaker (a cross-message misattribution would have tripped at the FIRST message)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(alignedTurn)       // 5 aligned calls — no mismatch counted
      .mockResolvedValueOnce(convictedBatchTurn)
      .mockResolvedValueOnce(recoveryVerifyTurn)
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // The steer + trip fired ONLY out of the convicted message (counts
    // 1..6 all inside it — steer at 3, trip at 5). If per-message
    // narration were misattributed ACROSS messages (the three-turn
    // misread), the aligned message's five calls would have armed the
    // steer and tripped the breaker BEFORE the convicted message ran.
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'edit_file', intended: 'verify' });
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics().some((m) => m.meta?.shape === 'success_intent' && m.meta?.tool === 'edit_file')).toBe(true);
    // And the aligned message's own calls were never mismatches.
    expect(reanchorMetrics().every((m) => m.meta?.tool === 'edit_file')).toBe(true);
  });

  it('SYNTHETIC adjacent shape (NOT the wild instance — its earlier rounds were ALIGNED): a narration-word-slip that DOES recur across messages still accumulates through EXEMPT run_command measurement turns — 1+1+3 reaches steer@3 and trip@5 exactly as a single batch does', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(mismatchTurn(1))     // mismatch 1 (own message)
      .mockResolvedValueOnce(measureTurn(1))      // EXEMPT run_command — no increment, no reset
      .mockResolvedValueOnce(mismatchTurn(2))     // mismatch 2 (own message)
      .mockResolvedValueOnce(measureTurn(2))      // EXEMPT run_command
      .mockResolvedValueOnce(mismatchBatchTurn)   // mismatches 3 (steer arms) + 4 + 5 (TRIP)
      .mockResolvedValueOnce(recoveryVerifyTurn)  // the ban round: verify runs
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // Cumulative per-call counting across messages, through exempt
    // measurement turns, reaches the trip threshold exactly as five
    // in one batch does — the 8da24785/267ea7b6 per-call design. The
    // wild instance proved the ALIGNED side of this seam (five- and
    // thirteen-call aligned batches, no trip); this synthetic leg pins
    // the accumulating side. If this ever fails, a per-turn or per-batch
    // dedup landed without its detector-recall replays — see the ticket
    // header, section 5, and the 267ea7b6 rejected-defense pin.
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'edit_file', intended: 'verify', reason: 'intent_mismatch_success', churned: false });
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics().some((m) => m.meta?.shape === 'success_intent' && m.meta?.tool === 'edit_file')).toBe(true);
    // The measurement turns themselves were never mismatches, and both ran.
    expect(reanchorMetrics().every((m) => m.meta?.tool === 'edit_file')).toBe(true);
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'run_command').length).toBe(2);
  });
});

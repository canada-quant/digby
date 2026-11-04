/**
 * REPLAY TEST — ticket 9050c226 (mishap, filed 2026-10-19T21:48:31Z): "5×
 * success-side wrong-tool loop: edit_file on 'DELETE · Read the flagged
 * regions (weekl' — framework or model?" Auto-filed at the breaker trip
 * (owner doctrine 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session 39b9ddd4-2370-4611-b22b-8b2b768d6afb — the
 * "DELETE stale/dead/duplicate deployments" docs-sweep lane on the
 * canada-quant/litellm USER-PROJECT repo, the FIRST class member outside
 * the framework repo; glm-5.3/zai, coding profile, schedule-triggered; run
 * 3efc41ef-df4f-46ff-a22e-25e1a94d38bf 19:59:04Z→21:58:09Z, status
 * completed, currentStep 93, error null — and ALREADY SHIPPED before the
 * ticket dispatched: verify PASSED ×3 (receipts d68b7f07 21:41:57Z,
 * 246779f3 21:49:17Z, 717376d4 21:53:33Z), git_commit acb3c039 21:53:45Z,
 * PR #150 opened 21:54:13Z and MERGED 21:57:00Z, mergeSha 29876844dd1c —
 * the lane landed its r-2-retirement docs sweep clean DESPITE the trip).
 *
 * THE STREAK IS ONE MESSAGE OF SIX edit_file CALLS (FIVE SUCCEEDED + ONE
 * FAILED) — the ticket's ×5 is the COUNT AT THE FIFTH CALL, not the batch
 * size:
 *   message @CTX783 (turn-key boundary 21:48:30.936Z) → calls 784, 787,
 *   790, 793, 796, 799 (21:48:30.940Z→21:48:31.135Z, 195 ms). 784/787/790/
 *   793/796 SUCCEEDED (file_changed + "Edited …" tool_result after each);
 *   the TICKET'S ARGS newest-first (796 "49-route roster, edit me" / 793
 *   "deployed from this repo @ `2aecdc92`" / 790 "rutherford-2 was
 *   HIBERNATED") are exactly the DW-4 accumulator's last-3 at trip. The
 *   SIXTH call (799, README.md) FAILED — "old_string not found in
 *   README.md. Read the file and match exactly."
 *
 * ADJUDICATION (this lane, 2026-10-19, evidence-led, prod-DB probe
 * scripts/framework-audit/probe-9050c226-a.js via prodq on box A):
 * MODEL-SIDE — no deterministic framework/schema/preflight/guard defect
 * caused the streak. The glm-5.3/zai narration-word-slip on live
 * reasoning, the 2547b652/267ea7b6/601d819e class, SEVENTH pinned member
 * and first on a USER-PROJECT lane (roster per the repo's own pins:
 * 8da24785 kimi-k3 2026-09-23, 267ea7b6 qwen3.8-max 2026-10-09, 2547b652
 * qwen3.8-max 2026-10-11, 4ac955aa glm-5.3 2026-10-15, 304ff1bb glm-5.3
 * 2026-10-15, 601d819e glm-5.3 2026-10-19, this one). Three NEW shapes
 * this instance adds to the class, none of them a defect:
 *
 * 1. STEER-CONSUMED STRAIGHT TRIP. The run's ONE-PER-RUN re-anchor steer
 *    was already spent at 20:48:40.464Z on a read_file→grep mismatch
 *    (guard_marker seq 348, "[HARNESS] Re-anchor steer injected:
 *    wrong-tool signature on read_file (reasoning named grep)" — a
 *    correct, truthful steer the model recovered from). When the edit_file
 *    streak reached its third mismatch at 21:48:31, agent.ts:5855's
 *    `!reAnchorUsed && !reAnchorPending` guard correctly SKIPPED the steer
 *    (one per run) and the streak tripped the one-round withhold straight
 *    at the fifth call (break metric 21:48:35.721Z, shape success_intent,
 *    intended verify, churned:false, perma:false). The ladder is DESIGNED
 *    to degrade to trip-only when the steer budget is spent — this is the
 *    first pinned member whose conviction arrived with NO steer, and the
 *    containment still held.
 * 2. A REFUSAL THE BREAKER READS AS SUCCESS (pinned as the CURRENT
 *    classification AT ADJUDICATION TIME — closed by follow-up ticket
 *    d2e6b0fb, landed in the same repo era): the convicted batch's sixth call
 *    (seq 799, README) returned edit_file's authored refusal —
 *    "old_string not found in README.md. Read the file and match exactly." —
 *    which looksLikeToolFailure (learnings-index.service.ts:396,
 *    FAILURE_MARKERS :361) did NOT classify as failure: the marker list had
 *    no edit_file text-mismatch shape (the 718a04a5 document-tools gap was
 *    closed for document tools only). d2e6b0fb added the anchored marker, so
 *    the refusal NOW enters the failure ladder — in THIS incident's shape at
 *    count 2 (1 + the verify-naming intent fast-weight), under the 3-trip,
 *    so this replay's observables are unchanged: the SUCCESS-side leg no
 *    longer sees the refusal (no post-trip count 1), the trip still lands at
 *    the fifth call, and the shape of the ONE trip stays success_intent.
 *    The refusal-leg test below now pins the NEW classification (it enters
 *    the ladder; a follow-up refusal completes the 3-streak and trips
 *    failure-shaped) — see agent-derail-break.d2e6b0fb.test.ts for the
 *    closed blind spot's own replay (3 varying-old_string refusals under
 *    aligned narration trip the FAILURE ladder at the third).
 * 3. The conviction rode the UNPERSISTED LIVE reasoning channel, again
 *    (the 2547b652/601d819e elimination): the run's 980 agent_events hold
 *    ZERO 'reasoning'-type rows (reasoning-wire.ts cuts reasoning at the
 *    wire per the owner 2026-10-04 hide-thinking directive;
 *    replaysReasoning() is kimi-family-only so zai live reasoning is never
 *    persisted); the convicted message's verbatim-recovered content
 *    channel (190 chars: "All regions in hand. Applying the full fix set
 *    — banners for the two canonical prompts + incident brief, surgical
 *    line fixes for README/AGENTS, retirement notes on the r-2 deploy-spec
 *    files:") is verify-free AND edit_file-free under the broad acquittal
 *    boundary, and the DEPLOYED detector replayed on the recovered
 *    channels returns intended:null. glm-5.3 narrated its planned next
 *    step (the verify its own next message announced) while correctly
 *    emitting the six retirement edits.
 *
 * NO DETECTOR CHANGE (same as every prior member): the trip fired on the
 * post-#1750 detector — agent.ts and tool-preflight.ts are UNCHANGED from
 * 3a40afb6 (the 601d819e adjudication) to origin/main, and that wave's
 * CI+Deploy concluded 17:59–18:30Z, BEFORE this run started 19:59:04Z, so
 * the deployed code is the exact detector the prior adjudication
 * validated. The deployed battery require()d live in the backend
 * container: arity 5 (callArgs form), bare-intent reasoning → verify
 * (convicts), glued verify-wave.sh → null (acquits), called-tool-named →
 * null (acquits), quoted intent → verify (convicts), empty → null, and
 * the live-channel shape (reasoning names verify, content names nothing,
 * called edit_file) → verify. NO cross-message contamination: guard_miss
 *    rows are written ONLY when intentMismatchDiscount returns non-null
 *    (agent.ts:5823-5849), so their absence does not prove absence of
 *    counted mismatches — the ALL_EDIT_GROUPS census in the probe output
 *    is the evidence (the run's 16 edit groups, boundaries 124..887: the
 *    ELEVEN dispatched BEFORE the convicted batch (boundary 783) are
 *    verify-free in both persisted channels — no earlier aligned batch
 *    could have fed the counter; the post-trip groups (817, 849, 875,
 *    887) are not part of the no-contamination census — 887 at 21:52:25Z
 *    names verify in its content, AFTER the trip and AFTER the recovery
 *    verify, so it convicts nothing; the only discount row is a
 *    batch_sibling acquittal on update_plan, 20:53:20Z, and a
 *    final_verdict clean row at 21:58:09Z, neither on edit_file). The
 *    counter's five counts are entirely the
 *    convicted batch's own: 784→1, 787→2, 790→3, 793→4, 796→5=TRIP, then
 *    the trip's reset, then 799's refusal as post-trip count 1 (shape 2
 *    above).
 *
 * Deliverables: this replay pin (elimination leg, steer-consumed
 * straight-trip incident replay, refusal-classified-as-success leg,
 * no-steer degradation property) + the committed forensic probe
 * scripts/framework-audit/probe-9050c226-a.js (strike-anchored batch
 * grouping — supersedes the marker-match anchoring the class used before:
 * this lane's earlier aligned batches reused the ticket's own phrases, so
 * a marker match is not batch membership; the deterministic anchor is the
 * tool_derail_break strike timestamp).
 *
 * Scaffold mirrors agent-derail-break.601d819e.test.ts: every mismatched
 * call SUCCEEDS ('probe result: ok') except the modeled sixth call, whose
 * executor result is the WILD old_string-mismatch failure text (the
 * success-side counter reads the result; looksLikeToolFailure classifies
 * it); edit_file args are the wild retirement-banner shapes
 * (letter-skeleton-varied so no repeat signature can fire), the narration
 * names exactly ONE offered tool as a whole word and never the called
 * edit_file (an unoffered named tool makes detectIntendedTool return null
 * and silently resets the streak — the c737d007 test-writing gotcha), and
 * args carry no id-shaped keys so no ungrounded-id preflight leg can
 * refuse them.
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

// The executor mock: SUCCEEDS by default; per-call failure injection for
// the sixth edit (the wild old_string refusal). KEYED ON ARGS, not a call
// object — the real call sites pass no call param (agent.ts:1308
// `executeCodingTool(ctx, tc.name, args)`, agent.ts:1278
// `ctx.toolCache.getOrExecute(tc.name, args)`), so an id-keyed injection
// is dead code (review B1). TRIMS[5]'s unique old_string is the key.
const FAILING_OLD_STRINGS = new Set<string>();
const WILD_OLD_STRING_FAILURE = (path: string) => `old_string not found in ${path}. Read the file and match exactly.`;
const maybeFail = (_name: string, args: any) => {
  if (args && typeof args.old_string === 'string' && FAILING_OLD_STRINGS.has(args.old_string)) {
    return WILD_OLD_STRING_FAILURE(String(args.path || 'README.md'));
  }
  return 'probe result: ok';
};
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, _name: string, args: any) => maybeFail(_name, args));
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockToolCacheExec: jest.Mock = jest.fn(async (_name: string, args: any) => maybeFail(_name, args));
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

/** The incident's wake text — the litellm docs-sweep lane's firing brief:
 *  the docs pass and the preflight+verify step it ends with. The
 *  narration-slip is the model's own, but the brief makes the
 *  verify next-step plan legitimate (exactly why the model narrated it
 *  mid-batch). */
const BRIEF = 'Weekly docs sweep of the litellm gateway repo: read the flagged regions, apply the stale-warning retirement banners and route-roster corrections, preflight the sweep greps, then verify the chain (typecheck + lint) before committing.';

const makeInput = (userMessage: string = BRIEF, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-9050c226-test',
  sessionId: 'sess-9050c226',
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

/** The verbatim-recovered CONTENT channel of the convicted message (probe
 *  fact: 190 chars of text deltas, ZERO tool mentions under the broad
 *  boundary — not verify, not even edit_file). */
const C_CONVICTED = 'All regions in hand. Applying the full fix set — banners for the two canonical prompts + incident brief, surgical line fixes for README/AGENTS, retirement notes on the r-2 deploy-spec files:';

/** The incident narration (the LIVE reasoning channel of the convicted
 *  message — not persisted for zai/glm-5.3, but pinned by the guard's own
 *  strike telemetry: intended verify, churned:false, standalone): the
 *  model narrated its planned NEXT step — the verify its own next message
 *  announced — while edit_file correctly executed the six retirement
 *  edits. Names exactly ONE offered tool as a whole word and NEVER the
 *  called edit_file. */
const P_NARRATION = 'The banner edits are the last file changes; once they land I will run verify on the docs chain before the preflight greps and commit.';

/** The verbatim-recovered CONTENT channel of ONE adjacent aligned batch in
 *  the same fix phase (probe fact: the 21:49:58 message — six edits,
 *  verify-free, on-task, its own narration names no other tool). */
const C_ALIGNED_1 = 'Clock 21:49Z. Applying the remaining fixes with the exact text:';

/** The elimination corpus — exactly the two recovered messages above
 *  (C_CONVICTED + C_ALIGNED_1, 190 + 63 chars). The unit assertion proves
 *  these two channels convict nothing standalone and jointly; the complete
 *  per-message census (all 16 edit groups of the run, boundaries 124..887)
 *  lives in the probe output (probe-9050c226-a.js ALL_EDIT_GROUPS), not in
 *  this pin. */
const C_WILD_WHOLE = C_CONVICTED + '\n\n' + C_ALIGNED_1;

/** The wild retirement-banner shapes (ticket args + PR #150's file list),
 *  letter-skeleton-varied so no repeat signature can fire: the six calls
 *  of the convicted batch — weekly-session-prompt.md ×2, the incident
 *  brief banner, README ×3 (status line, route roster, the client-keys
 *  note whose old_string mismatches in the wild). */
const TRIMS: Array<[string, string, string]> = [
  ['docs/weekly-session-prompt.md', '> Canonical weekly prompt; a stale probe line references the retired host.', '> Canonical weekly prompt (retired-host probe line removed).'],
  ['docs/weekly-session-prompt.md', '  The poller wakes the old gateway box on the floating address each night.', '  The poller wakes the lab edge only (the old host is retired).'],
  ['docs/SECURITY-INCIDENT-2026-10-11.md', '> Operational r-2 details: dispatching the deploy workflow is current.', '> Operational r-2 details are HISTORY — the host was hibernated and retired; never dispatch the deploy workflow.'],
  ['README.md', '> deployed from this repo @ `471ff4ea` (docker-compose build).', '> deployed from this repo @ `2aecdc92` (docker-compose build).'],
  ['README.md', '│   ├── config.yaml                # roster source of truth (51-route roster, edit me)', '│   ├── config.yaml                # roster source of truth (49-route roster, edit me)'],
  ['README.md', 'if the DB is down, requests get 503, never 200). The old stanza promised', 'if the DB is down, requests get 503, never 200 — the corrected stanza says'],
];
const editCall = (n: number) => {
  const [path, old_string, new_string] = TRIMS[(n - 1) % TRIMS.length];
  return {
    id: `t${n}`,
    name: 'edit_file',
    arguments: JSON.stringify({ path, old_string, new_string }),
  };
};

/** THE INCIDENT SHAPE — ONE MESSAGE of SIX edit_file calls (wild CTX783 →
 *  calls 784..799; the first five SUCCEED, the sixth returns the WILD
 *  old_string refusal) under the verify-naming live reasoning with a
 *  verify-free content channel. The run's steer budget was already spent
 *  (the 20:48 read_file→grep re-anchor), so NO steer arms at the third
 *  mismatch — the streak trips straight at the fifth call; the sixth call
 *  still executes (the withhold applies to the next round's schema, not
 *  the in-flight batch), and its refusal — NOW failure-shaped to
 *  looksLikeToolFailure (ticket d2e6b0fb) — enters the failure ladder at
 *  count 2 (1 + the verify-naming intent fast-weight), under the 3-trip, so
 *  it mints no second notice and the ONE break stays success_intent (the
 *  pre-d2e6b0fb classifier read it as SUCCESS and counted it as a post-trip
 *  success-side mismatch instead — shape 2, and see the REFUSAL-ENTERS-THE-
 *  LADDER test below). */
const convictedBatchTurn = {
  content: C_CONVICTED,
  reasoning: P_NARRATION,
  toolCalls: Array.from({ length: 6 }, (_v, i) => editCall(i + 1)),
  finishReason: 'tool_calls' as const,
};

/** The earlier mismatch that SPENT the steer (wild read_file→grep counter
 *  hit 3 at 20:48:31 and the one-per-run re-anchor fired at 20:48:40.464Z):
 *  a read_file batch whose reasoning names grep — modeled as the minimal
 *  three-call message that arms the steer (the counter is keyed on the
 *  CALLED tool and accumulates across messages; the wild counter spanned
 *  several earlier read_file batches). */
const steerSpenderTurn = {
  content: 'Clock 20:47Z. Reading the three flagged regions before editing: the stanza-1 comment block, the fallbacks block, and the retirement note.',
  reasoning: 'I will grep the config for the fallback targets first, then read the three regions.',
  toolCalls: [
    { id: 'r1', name: 'read_file', arguments: JSON.stringify({ path: 'config/config.yaml', start_line: 49, end_line: 113 }) },
    { id: 'r2', name: 'read_file', arguments: JSON.stringify({ path: 'README.md', start_line: 1, end_line: 60 }) },
    { id: 'r3', name: 'read_file', arguments: JSON.stringify({ path: 'docs/weekly-session-prompt.md', start_line: 1, end_line: 40 }) },
  ],
  finishReason: 'tool_calls' as const,
};

/** The aligned follow-on after the steer spender (wild boundary 353 → two
 *  edits, narration truthful) — proves the spent steer leaves no residual
 *  counting. */
const alignedEditTurn = {
  content: C_ALIGNED_1,
  reasoning: 'Applying the banner edits to the two prompt files now.',
  toolCalls: [editCall(1), editCall(2)],
  finishReason: 'tool_calls' as const,
};

/** The MODELED RECOVERY turn (the wild lane's post-trip behavior, seq
 *  803-809): acknowledges the notice verbatim, then calls verify — the
 *  grounded next action — as a single aligned call (edit_file sits out
 *  its one-round ban this round). */
const recoveryVerifyTurn = {
  content: 'Acknowledged — the five `edit_file` successes did not satisfy the `verify` intent (they were edits, not verification); calling verify now.',
  reasoning: 'Running the docs-chain verify now, then finishing the remaining fixes.',
  toolCalls: [{ id: 'tv1', name: 'verify', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls' as const,
};

/** The post-ban edit round (wild boundary 817 → six edits at 21:49:58Z):
 *  edit_file returns to the schema after its one-round ban and the lane
 *  continues the sweep. */
const postBanEditTurn = {
  content: 'Verify PASSED (typecheck + lint exit 0). Now completing the remaining fixes with the exact text.',
  reasoning: 'The chain is green; finishing the remaining banner edits next.',
  toolCalls: Array.from({ length: 6 }, (_v, i) => editCall(i + 1)),
  finishReason: 'tool_calls' as const,
};
const FINAL = { content: 'Sweep complete — every retired-host claim carries a banner, the roster count is corrected, and the chain is green.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

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
  FAILING_OLD_STRINGS.clear();
});

describe('ticket 9050c226 — steer-consumed straight trip on a five-success edit batch whose sixth call is an old_string refusal (glm-5.3, user-project lane): guard correct, containment effective, model behavior', () => {
  it('UNIT (the elimination leg): the verbatim-recovered CONTENT channels convict NOTHING — the conviction necessarily rode the LIVE reasoning channel (not persisted for non-kimi providers)', () => {
    const offered = ['run_command', 'edit_file', 'verify', 'read_file', 'grep', 'write_file', 'glob'];
    // The whole recovered span (probe fact: the convicted message + the
    // adjacent aligned batch) as one content channel — every per-message
    // subset is contained in it, so zero mentions here means zero in each
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

  it('REPLAY the incident (steer budget SPENT on an earlier read_file→grep mismatch; then ONE message of six edit_file calls — five successes, the sixth the wild old_string refusal — under verify-naming live reasoning): NO steer on the edit streak, straight trip at the FIFTH success, the sixth call still executes, one-round withhold only, and the run RECOVERS on the modeled verify turn', async () => {
    // The sixth edit of the convicted batch returns the WILD refusal text
    // (args-keyed — see the mock block note).
    FAILING_OLD_STRINGS.add(TRIMS[5][1]);
    mockRunModelTurn
      .mockResolvedValueOnce(steerSpenderTurn)    // 20:47Z: read_file while reasoning names grep — the steer SPENDER
      .mockResolvedValueOnce(alignedEditTurn)     // 20:50Z: aligned edits, no mismatch counted
      .mockResolvedValueOnce(convictedBatchTurn)  // 21:48Z: 5 successes + 1 failure, NO steer left → straight trip at 5
      .mockResolvedValueOnce(recoveryVerifyTurn)  // the ban round: edit_file absent; verify runs (wild seq 806)
      .mockResolvedValueOnce(postBanEditTurn)     // edit_file returns after its one-round ban (wild boundary 817)
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Sweep complete — every retired-host claim carries a banner, the roster count is corrected, and the chain is green.');
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');

    // ── The steer fired EXACTLY ONCE — on the read_file mismatch (the
    //    spender), NEVER on the edit streak: agent.ts:5855's
    //    !reAnchorUsed && !reAnchorPending guard skipped it (wild reanchor
    //    metric 20:48:40.464Z, intended grep; the edit streak at 21:48:31
    //    got nothing — the first pinned member to trip with NO steer). ──
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('RE-ANCHOR (one per run)');
    expect(steer).toContain('You called read_file and it SUCCEEDED — but your own reasoning named grep');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({
      tool: 'read_file', intended: 'grep', reason: 'intent_mismatch_success', churned: false,
    });

    // ── Straight trip at the FIFTH success, one round only — the
    //    incident's exact meta (break 21:48:35.721Z) ──
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({
      tool: 'edit_file', perma: false, intended: 'verify', churned: false, shape: 'success_intent',
    });
    expect(breakerMetrics()).toHaveLength(1); // one-round withhold only — no perma, no run-end

    // ── The post-trip SIXTH call executed despite the trip: the withhold
    //    applies to the NEXT round's schema, not the in-flight batch (wild
    //    call 799 executed 21:48:31.135Z and returned its old_string
    //    refusal) — ALL SIX dispatched, and the refusal (failure-shaped
    //    since d2e6b0fb; ladder count 2, under the 3-trip) did NOT mint a failure-shape trip: the
    //    ONE break stays success_intent. ──
    const editDispatches = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'edit_file');
    expect(editDispatches.length).toBe(2 + 6 + 6); // aligned(2) + convicted(6) + post-ban(6)
    expect(breakerMetrics().every((m) => m.meta?.shape === 'success_intent')).toBe(true);

    // ── The modeled recovery: the post-trip turn acknowledges the notice
    //    and calls verify (the grounded next action) — the byte-shape the
    //    wild lane emitted at 21:48:56Z ("Acknowledged — the five
    //    `edit_file` successes did not satisfy the `verify` intent …
    //    calling verify now") ──
    const verifyDispatch = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'verify');
    expect(verifyDispatch.length).toBeGreaterThanOrEqual(1);
    // The user-visible notices tell the TRUTH about the success shape: the
    // withhold notice says the last 5 edit_file calls SUCCEEDED and names
    // the intended verify (agent.ts:6238 template).
    const withholdNotice = userTexts().find((t) => t.includes('temporarily removed from your tool list'));
    expect(withholdNotice).toBeDefined();
    expect(withholdNotice).toContain('Your last 5 calls of edit_file all SUCCEEDED');
    expect(withholdNotice).toContain('Your own reasoning named verify');
  });

  it('REPLAY the counting NEGATIVE (the steer spender never seeds the edit streak): the read_file mismatch that spent the steer leaves the edit_file counter untouched — the trip still lands on the convicted batch\'s own FIFTH call (a cross-tool misattribution would have tripped the edit streak one call early)', async () => {
    FAILING_OLD_STRINGS.add(TRIMS[5][1]);
    mockRunModelTurn
      .mockResolvedValueOnce(steerSpenderTurn)    // the read_file mismatch (steer spent)
      .mockResolvedValueOnce(convictedBatchTurn)  // 5 successes + the 6th refusal — trip at the batch's OWN fifth
      .mockResolvedValueOnce(recoveryVerifyTurn)
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // The trip is on edit_file, success_intent, ONE trip — the read_file
    // spender contributed zero counts to the edit streak (the counter is
    // keyed on the CALLED tool, c737d007), and there is no second steer.
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'read_file', intended: 'grep' });
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta).toMatchObject({ tool: 'edit_file', intended: 'verify', shape: 'success_intent' });
    expect(breakerMetrics().every((m) => m.meta?.tool === 'edit_file')).toBe(true);
  });

  it('REFUSAL-ENTERS-THE-LADDER (the shape this instance added to the class, closed by ticket d2e6b0fb): the sixth call returns edit_file\'s authored old_string refusal — failure-shaped since d2e6b0fb — so it ENTERS the failure ladder at count 2 (1 + the verify-naming intent fast-weight), UNDER the 3-trip: the trip still lands at the fifth call, the refusal text is in the transcript, and the shape of the ONE trip stays success_intent (pre-d2e6b0fb the refusal read as SUCCESS, fed the success-side leg a post-trip count 1, and the failure ladder never saw it)', async () => {
    // Args-keyed injection: TRIMS[5]'s unique old_string returns the wild
    // refusal (review B1 — an id-keyed injection never fires because the
    // real executor call sites pass no call object).
    FAILING_OLD_STRINGS.add(TRIMS[5][1]);
    mockRunModelTurn
      .mockResolvedValueOnce(steerSpenderTurn)
      .mockResolvedValueOnce(convictedBatchTurn)  // 5 successes + the 6th refusal (wild batch 783)
      .mockResolvedValueOnce(recoveryVerifyTurn)
      .mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput());

    // (a) The refusal FIRED this run (the injection is live): the cache
    //     mock (edit_file routes through ctx.toolCache.getOrExecute,
    //     agent.ts:1705/1718) was called with TRIMS[5]'s old_string exactly
    //     once, and the WILD refusal text reached the transcript the model
    //     saw (the role:tool message) — the observable the counter read.
    const refusalCalls = [...mockToolCacheExec.mock.calls, ...mockExecuteCodingTool.mock.calls]
      .filter((c: any[]) => c[2] && typeof c[2] === 'object' && (c[2] as any).old_string === TRIMS[5][1]);
    expect(refusalCalls.length).toBe(1);
    const refusalText = WILD_OLD_STRING_FAILURE(TRIMS[5][0]);
    const sawRefusal = mockRunModelTurn.mock.calls.some((_c: any, i: number) => {
      const msgs = mockRunModelTurn.mock.calls[i][1] as Array<{ role?: string; content?: unknown }>;
      return (msgs || []).some((m) => m?.role === 'tool' && typeof m.content === 'string' && m.content.includes(refusalText.slice(0, 40)));
    });
    expect(sawRefusal).toBe(true);

    // (b) Observables of THIS incident's shape — exactly ONE guard_strike for
    //     edit_file, shape success_intent, no failure-shaped notice minted.
    //     EPISTEMIC NOTE (d2e6b0fb cross-review): these observables are the
    //     SAME pre- and post-marker (a refusal at ladder count 2 is under the
    //     3-trip, and the pre-fix success-side count of 1 minted no metric
    //     either), so this block alone does not discriminate the classifier
    //     change — the NEW classification is pinned by execution in
    //     agent-derail-break.d2e6b0fb.test.ts (unit conviction + the
    //     3-refusal loop trip, with a pre-fix parent-tree differential).
    //     What this leg adds is the regression bound: the marker change must
    //     NOT mint a second notice for the wild incident's own shape.
    const editStrikes = breakerMetrics().filter((m) => m.meta?.tool === 'edit_file');
    expect(editStrikes).toHaveLength(1);
    expect(editStrikes[0].meta).toMatchObject({ shape: 'success_intent', intended: 'verify', perma: false, churned: false });
    const failureShaped = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break' && m.meta?.shape === 'failure');
    expect(failureShaped).toHaveLength(0);

    // (c) The run still completed and recovered (no run-end, no perma).
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');
  });

  it('NO-STEER DEGRADATION IS THE DESIGNED LADDER (the containment property this instance pins): with the steer spent, FIVE mismatched successes still trip exactly once — the trip-only rung contains the loop even when the softer rung was consumed by an earlier, recovered mismatch', async () => {
    // The steer spent on the read_file mismatch; then a FIVE-call
    // all-success edit batch under verify-naming reasoning: no steer can
    // fire, and the withhold trips at exactly the fifth.
    const fiveCallTurn = { ...convictedBatchTurn, toolCalls: Array.from({ length: 5 }, (_v, i) => editCall(i + 1)) };
    mockRunModelTurn
      .mockResolvedValueOnce(steerSpenderTurn)
      .mockResolvedValueOnce(fiveCallTurn)
      .mockResolvedValueOnce(recoveryVerifyTurn)
      .mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput());
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');
    expect(reanchorMetrics()).toHaveLength(1); // the read_file spender ONLY — never a second steer
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta).toMatchObject({ tool: 'edit_file', intended: 'verify', shape: 'success_intent', perma: false });
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'edit_file').length).toBe(5);
  });
});

/**
 * REPLAY TEST — ticket 304ff1bb (mishap, 2026-10-15): "5× success-side
 * wrong-tool loop: edit_file on 'Verify + harden all 3 · Review fixes: sc'
 * — framework or model?" Auto-filed at the breaker trip (owner doctrine
 * 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session e87d6f73-4256-4f28-add8-99521df7397e — its
 * chat title is MUTABLE and was renamed across the run's life (ticket
 * filing: "Verify + harden all 3 · Review fixes: sc"; probe time 22:10Z:
 * "rutherford-0 bench: · Land state: todo progress note"); identified by
 * session id, never by title; run
 * f2baefbd-e0ed-4a7f-b2ff-e0a56c9bb8e3, glm-5.3, coding profile,
 * MACHINE-triggered; run COMPLETED 2026-10-15T21:18:51.704Z, step 110,
 * error null, and SHIPPED — 4× git_committed, 4× branch_pushed, 2×
 * pr_opened, 2× pr_merged per agent_events). The lane was hardening the
 * AWS security-group suite (harden.sh gateway role, apply.sh dispatch,
 * sg-rules.sh declarations) after review fixes.
 *
 * THE STREAK IS ONE MESSAGE OF FIVE edit_file CALLS (forensics,
 * probe-304ff1bb.js/-b/-c/-d/-e via prodq on box A, 2026-10-15):
 * agent_events 'context' rows carry a `turn` key (gaugeTurn, agent.ts
 * ~:4416) exactly once per MODEL MESSAGE — emitted at message END: a
 * message is [its text deltas] [its turn-key boundary] [its tool calls].
 * Deltas stream BEFORE their own boundary, so attribution assigns them to
 * the boundary that FOLLOWS them (the 2547b652 review-F1 lesson; the
 * streaming-order-corrected grouping is probe-304ff1bb.js's section 4).
 * In the convicted window:
 *   · message @CTX907 (21:14:37.385Z): ONE run_command (exempt tool) — no
 *     counting, no reset;
 *   · THE CONVICTED MESSAGE @CTX913 (21:14:57.924Z): FIVE edit_file calls
 *     (914, 917, 920, 923, 926 — every one SUCCEEDED, each pair ~7-10 ms
 *     apart) under ONE narration — content channel recovered verbatim
 *     from agent_events text deltas: "Box-side batch now. First the suite
 *     declarations (so code is the source of truth for the r-2 443 edge),
 *     then the live changes. Suite edits — `harden.sh` gains a `gateway`
 *     role (443 only, no 80), `apply.sh` dispatches it, `sg-rules.sh`
 *     declares it:" — verify-free under the BROAD acquittal boundary
 *     (stricter than the conviction counter), and the recovered content
 *     channels of every earlier edit-bearing message (15 edit groups
 *     total, the largest TWO calls at CTX290/304/313/382/856) are
 *     verify-free too. Per-call counting across the message:
 *     914(1) 917(2) 920(3 → steer arms, reanchor metric 21:14:58.018Z,
 *     reason intent_mismatch_success, intended verify, churned:false)
 *     923(4) 926(5 → TRIP, break metric 21:15:04.212Z, shape
 *     success_intent, perma:false — no perma, no run-end); both notices
 *     deferred to message end (guard_marker seq 929 @21:14:58.021Z). The
 *     ticket's ×5 = the count at the trip; its three arg snippets
 *     (desired_rules_for() { / charter goal 5d2750aa / --- harden ---)
 *     are calls 920/923/926 — the newest-3 counted misses only
 *     (reflection.ts recentArgs.slice(0,3)), NOT three turns.
 * THE ONE-CHECK DISPROOF of any multi-message misread: the run's
 * guard_strike loop-metric KIND holds 8 rows, of which EXACTLY TWO are
 * tool_derail rows (reanchor 21:14:58.018Z, break 21:15:04.212Z), both
 * naming edit_file/verify — the other 6 are unrelated seams recorded
 * under the same kind by this run's publish lifecycle (unverified_pr_gate,
 * pr_gate_auto_verify, pr_idempotency_followup, run_command_publish ×2).
 * The detector input
 * (turn.reasoning + turnText, agent.ts ~:5654) is MESSAGE-scoped —
 * identical for every call of a message, so a message's calls convict or
 * acquit TOGETHER. Any earlier edit-bearing message whose narration
 * convicted would have crossed 5 INSIDE itself — no earlier message held
 * 5+ edit_file calls (max 2), so no trip could predate CTX913 — and no
 * guard_marker exists before seq 929. Ergo the streak is ONE message.
 *
 * ADJUDICATION (this lane, 2026-10-15, evidence-led, prod-DB probes
 * scripts/framework-audit/probe-304ff1bb{,-b,-c,-d,-e}.js via prodq on
 * box A): MODEL-SIDE — no deterministic framework/schema/preflight/guard
 * defect caused the streak. The FOURTH wild instance of the
 * single-message success-side narration-word-slip class (2547b652
 * qwen3.8-max, 4ac955aa glm-5.3, 2201d3d6 qwen3.8-max worker-stream;
 * this one glm-5.3 again — second on glm-5.3).
 * 1. The trip fired ON THE CURRENT, UNCHANGED DETECTOR: tool-preflight.ts
 *    has ZERO commits since the 2547b652 pin (ea80898f7, 2026-10-11),
 *    and the agent.ts success-side region (detectIntendedToolChannels
 *    call sites, turnText/turn.reasoning input assembly) is unchanged in
 *    behavior since that pin (git diff shows only finish_run FA / tool-
 *    intent DL features elsewhere in the loop). The retired glue
 *    false-positive class (022eb482, `verify` glued into `verify-wave.sh`)
 *    cannot apply — post-fix glue does NOT convict.
 * 2. ELIMINATION ON THE DETECTOR INPUT: detectIntendedToolChannels reads
 *    turn.reasoning + (turnText||turn.content). The CONTENT channel of
 *    the convicted message was recovered verbatim (above) and contains
 *    ZERO `verify` mentions under the BROAD acquittal boundary; the
 *    deployed detector replayed on the recovered channels (content +
 *    empty reasoning) returns intended:null — no conviction — while the
 *    guard's own strike telemetry recorded intended:"verify",
 *    churned:false (a STANDALONE mention, stable across the message).
 *    The live reasoning channel is provably not persisted for this
 *    provider (reasoning-wire.ts cuts `reasoning` events at the wire per
 *    the owner 2026-10-04 hide-thinking directive; replaysReasoning() is
 *    kimi-family-only — codingMessage 0ae73699 (428 parts) holds ZERO
 *    reasoning parts; checkpoint GC'd 0 messages) — therefore the
 *    conviction rode the LIVE reasoning channel: glm-5.3 narrated its
 *    planned NEXT step (verify the suite changes) while correctly
 *    emitting the harden/apply/sg-rules edits. The 267ea7b6/2547b652
 *    narration-word-slip class.
 * 3. CONTENT-APPROXIMATION vs LIVE-GUARD cross-check (the new fact this
 *    ticket adds to the family): my content-channel approximation
 *    counted standalone `verify` mentions in TWO earlier
 *    read_process_output messages (CTX180 "Reading both outputs to
 *    verify per-box evidence", CTX205 "reading the full output to verify
 *    what actually happened") — calls the LIVE guard did NOT count (no
 *    guard_marker before seq 929, streak ledger never armed). The
 *    acquittal leg the approximation lacks: proseMentionsTool
 *    (7b2a0969) — "reading the full output" / "Reading both outputs" is
 *    an in-order prose self-naming of read_process_output
 *    (read→process→output tokens within the 12-word window), which
 *    acquits before the conviction leg ever runs. The wild run is
 *    POSITIVE EVIDENCE that the live guard counted the streak exactly as
 *    designed: neither earlier verify-naming read message armed the
 *    steer, because their prose acquitted them.
 * 4. The GUARD STACK behaved per design at every rung: steer armed at
 *    the third cumulative mismatch (reanchor 21:14:58.018Z, reason
 *    intent_mismatch_success, intended verify, churned:false — deferred
 *    to message end), one-round withhold at the fifth (break
 *    21:15:04.212Z, shape success_intent, perma:false — no perma, no
 *    run-end), the steer told the TRUTH about the SUCCESS shape, the
 *    batch-sibling acquittal correctly never fired (no verify call in
 *    the 913 batch) nor the 0625bf62 discount (edit_file is a coding
 *    tool — platform-tool scope), and the fifth sibling executed (the
 *    withhold applies to the next round, not the in-flight batch — in
 *    the wild, 926 itself was the trip call and it SUCCEEDED; the batch
 *    was exactly 5 calls, so every call counted and the last was the
 *    trip).
 * 5. The CONTAINMENT WORKED — the same recovery shape as
 *    267ea7b6/2547b652: the next model turn said "Anchoring back with
 *    `verify` as instructed — … Running the project's verify chain on
 *    the current tree:" and CALLED verify (seq 936 — verify_result
 *    21:15:20.825Z), edit_file returned after its one-round ban
 *    (edit_file@991 in the 987 message), and the run completed clean
 *    and shipped (4× git_committed, 4× branch_pushed, 2× pr_opened,
 *    2× pr_merged, finish 21:18:51.704Z, error null).
 * 6. Per-call counting over turn-scoped narration is BY DESIGN — the
 *    8da24785 pin owns the single-batch assertion, and the 267ea7b6 pin
 *    owns the REJECTED per-(batch,tool) dedup defense (its replay broke
 *    SIX prior pinned true positives). No detector change rides this
 *    ticket: every rung fired correctly.
 *
 * THIS PIN replays the incident's exact shape against the REAL agent loop
 * and asserts: the verbatim-recovered content channels convict NOTHING on
 * their own (the elimination leg); the prose self-naming of
 * read_process_output acquits the earlier verify-naming read messages
 * (the family's new evidence leg — the approximation-vs-live cross-check
 * from adjudication point 3); the modeled live-reasoning narration
 * convicts edit_file of intending verify; ONE message of FIVE edit_file
 * calls under that narration steers at the third call, trips at the fifth,
 * withholds edit_file for exactly one round (churned:false both metrics);
 * and the modeled recovery turn (verify call after the ban round, per the
 * wild seq-936 recovery) confirms the run CONTINUES clean and finishes.
 *
 * Scaffold mirrors agent-derail-break.2547b652.test.ts (every mismatched
 * call SUCCEEDS; the narration names exactly ONE offered tool as a whole
 * word and never the called edit_file — an unoffered named tool makes
 * detectIntendedTool return null and silently resets the streak, the
 * c737d007 test-writing gotcha; args are the wild harden-suite shapes,
 * letter-skeleton-varied so the exact and digit-collapsed repeat
 * signatures stay blind, and carry no id-shaped keys so no ungrounded-id
 * preflight leg can refuse them).
 */

jest.setTimeout(60_000);

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
}));
jest.mock('../../../config/redis', () => ({
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
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
jest.mock('./container.service', () => ({
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({
  gatherSessionCredentialEnv: jest.fn(async () => ({})),
  credentialEnvNote: jest.fn(() => ''),
}));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn() }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
jest.mock('./reflection', () => ({
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  fileStreakInvestigation: jest.fn(async () => undefined),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { detectIntendedTool, detectIntendedToolChannels, intentMismatchDiscount, proseMentionsTool } from './tool-preflight';

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

/** The incident's task context (the incident lane's review-fix
 *  round — its chat title is mutable and was renamed across the
 *  run's life; identified by session id e87d6f73, not by title):
 *  names NOTHING the guard could misread as ordering the called
 *  edit_file (the narration-slip is the model's own). */
const BRIEF = 'Review fixes landed; now verify the three harden-suite scripts then harden all three boxes, keep the suite declarations in sync, and publish.';

const makeInput = (userMessage: string = BRIEF, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-304ff1bb-test',
  sessionId: 'sess-304ff1bb',
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
 *  message — not persisted for this provider family, but pinned by the
 *  guard's own strike telemetry: intended verify, churned:false,
 *  standalone): the model narrated its planned NEXT step — running the
 *  verify chain on the suite edits — while edit_file correctly executed
 *  the harden/apply/sg-rules edits. Names exactly ONE offered tool as a
 *  whole word and NEVER the called edit_file. */
const P_NARRATION = 'The review fixes are in; before the box-side apply I will verify the three suite scripts with the chain, then harden all three boxes for the r-2 posture.';

/** The verbatim-recovered CONTENT channel of the convicted message (probe
 *  fact, seqs 911-912 deltas under CTX913: "Box-side batch now. … Suite
 *  edits — `harden.sh` gains a `gateway` role (443 only, no 80), `apply.sh`
 *  dispatches it, `sg-rules.sh` declares it:" — 248 chars, ZERO tool
 *  mentions under the broad boundary). */
const C_CONVICTED = 'Box-side batch now. First the suite declarations (so code is the source of truth for the r-2 443 edge), then the live changes. Suite edits — `harden.sh` gains a `gateway` role (443 only, no 80), `apply.sh` dispatches it, `sg-rules.sh` declares it:';

/** The two earlier verify-naming READ messages (probe-e facts, CTX180/CTX205)
 *  — the approximation-vs-live cross-check legs: their content decision
 *  sentences carry a standalone `verify`, so a content-ONLY forensics
 *  replay would count read_process_output→verify mismatches there — yet
 *  the LIVE guard never counted them (no guard_marker before seq 929; the
 *  steer armed only inside the CTX913 batch). The acquittal necessarily
 *  rode the LIVE reasoning channel (the one channel a content-only
 *  approximation lacks): modeled here naming the called tool, the normal
 *  live narration shape. The prose leg does NOT acquit these (7b2a0969
 *  is exact-token match — "reading" ≠ "read"), pinned below as control. */
const C_READ_180 = 'Matched fast — reading the full output to verify what actually happened on the box:';
const C_READ_205 = 'Reading both outputs to verify per-box evidence (the logs are my ground truth):';
const R_READ_180 = 'The background probe matched fast; read_process_output on the handle now, then compare the per-box rows.';
const R_READ_205 = 'Both handles are live; read_process_output twice — once per box — to line the log rows up.';

/** The verbatim-recovered CONTENT channels of ALIGNED earlier edit
 *  messages (probe facts, boundaries 840/851/866/987) — verify-free, and
 *  the whole recovered edit-phase span is the elimination input: the
 *  deployed detector convicts NOTHING on the persisted channels. */
const C_ALIGNED_SUITE = 'Fix 1 — recompute `SELF_TAGS` in the evidence block (post-join), not the pre-join value:';
const C_ALIGNED_README = 'Applying the three README fixes (layout comments, Usage with `--allow-untagged`, Status note refresh):';
const C_ALIGNED_POINTER = 'One more README pointer fix ("see below" → point at §Usage, which now documents the flag), then syntax-check and commit:';
const C_WILD_WHOLE = C_ALIGNED_SUITE + C_ALIGNED_README + C_READ_180 + C_READ_205 + C_ALIGNED_POINTER + C_CONVICTED;

/** The wild harden-suite edit shapes (ticket args + probe batch paths,
 *  letter-skeleton-varied so no repeat signature can fire): the three
 *  marker-bearing rows (--- harden ---, charter goal 5d2750aa,
 *  desired_rules_for() {) are the ticket's newest-3 recentArgs = calls
 *  920/923/926 of the convicted message. */
const SUITE_PATHS = ['aws-setup/harden.sh', 'aws-setup/apply.sh', 'aws-setup/sg-rules.sh', 'aws-setup/harden.sh', 'aws-setup/sg-rules.sh'] as const;
const TRIMS: Array<[string, string]> = [
  ['echo "--- harden ---"\ncase "$ROLE" in', 'echo "--- harden ---"\ncase "$ROLE" in  # role-dispatched (r-2)'],
  ['# Desired state (charter goal 5d2750aa + supervisor messages 2026-10-15):', '# Desired state (charter goal 5d2750aa, r-2 posture):'],
  ['desired_rules_for() { # desired_rules_for <role> -> prints "min:max" per line', 'desired_rules_for() { # per-role min:max rules, r-2'],
  ['gateway) ship box/harden.sh "$NAME" gateway ;;  # 443-only public edge', 'gateway) ship box/harden.sh "$NAME" gateway ;;  # 443-only edge (TLS-ALPN-01)'],
  ['echo "22:22"                       # SSH everywhere', 'echo "22:22"                       # admin SSH (tailnet-tighten pending)'],
];
const editCall = (n: number) => {
  const [old_string, new_string] = TRIMS[(n - 1) % TRIMS.length];
  return {
    id: `t${n}`,
    name: 'edit_file',
    arguments: JSON.stringify({ path: SUITE_PATHS[(n - 1) % SUITE_PATHS.length], old_string, new_string }),
  };
};

/** THE INCIDENT SHAPE — ONE MESSAGE of FIVE edit_file calls (wild CTX913
 *  → calls 914,917,920,923,926) under the verify-naming live reasoning
 *  with a verify-free content channel. Steer arms at call 3, trip at call
 *  5 (the FIFTH sibling executed — the withhold applies to the next
 *  round's schema, not the in-flight batch). */
const convictedBatchTurn = {
  content: C_CONVICTED,
  reasoning: P_NARRATION,
  toolCalls: [editCall(1), editCall(2), editCall(3), editCall(4), editCall(5)],
  finishReason: 'tool_calls' as const,
};

/** The wild earlier verify-naming READ message (CTX180): one
 *  read_process_output call whose content decision sentence carries a
 *  standalone `verify` — but whose LIVE reasoning names the called tool,
 *  so the live guard acquitted it (no guard_marker before 929). */
const readTurn180 = {
  content: C_READ_180,
  reasoning: R_READ_180,
  toolCalls: [{ id: 'r1', name: 'read_process_output', arguments: JSON.stringify({ handle: 'bg1-a1b2' }) }],
  finishReason: 'tool_calls' as const,
};
const readTurn205 = {
  content: C_READ_205,
  reasoning: R_READ_205,
  toolCalls: [
    { id: 'r2', name: 'read_process_output', arguments: JSON.stringify({ handle: 'bg2-c3d4' }) },
    { id: 'r3', name: 'read_process_output', arguments: JSON.stringify({ handle: 'bg3-e5f6' }) },
  ],
  finishReason: 'tool_calls' as const,
};

/** An ALIGNED earlier edit message (wild CTX840: one edit_file, no trip):
 *  the narration names the called tool's work truthfully (no other
 *  offered tool as a whole word) — proving the streak does NOT reach back
 *  into earlier messages. */
const alignedEditTurn = {
  content: C_ALIGNED_SUITE,
  reasoning: 'Recomputing the evidence block after the join, editing the suite script.',
  toolCalls: [editCall(1)],
  finishReason: 'tool_calls' as const,
};

/** The MODELED RECOVERY turn (the wild lane's post-steer behavior, seq
 *  936): acknowledges the re-anchor, then calls verify — the grounded
 *  next action — as a single aligned call (edit_file sits out its
 *  one-round ban this round). */
const recoveryVerifyTurn = {
  content: 'Anchoring back with `verify` as instructed — the five suite edits did land (harden.sh `gateway` role, apply.sh dispatch, sg-rules.sh declarations, plus the earlier review fixes), and the box-side batch hasn\'t run yet. Running the project\'s verify chain on the current tree:',
  reasoning: 'Now verify the suite edits with the chain before the box-side apply.',
  toolCalls: [{ id: 'tv1', name: 'verify', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls' as const,
};
const FINAL = { content: 'Close-out complete — the suite scripts are hardened, verified, and published with this-run citations.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

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

describe('ticket 304ff1bb — single-message success-side derail on glm-5.3: guard correct, containment effective, model behavior', () => {
  it('UNIT (the elimination leg): the verbatim-recovered CONTENT channels convict NOTHING — the conviction necessarily rode the LIVE reasoning channel (not persisted for non-kimi providers)', () => {
    const offered = ['run_command', 'edit_file', 'verify', 'read_file', 'read_process_output', 'grep', 'write_file', 'glob'];
    // The edit-phase content channels recovered PER MESSAGE (probe facts:
    // the per-group text recovery of the six modeled messages — head-clipped
    // excerpts, NOT every text delta of the run) joined as one elimination
    // corpus: every per-message subset is contained in it, so zero
    // standalone verify mentions here in the
    // decision sentences means none in each message's own channel either.
    expect(detectIntendedToolChannels('', C_WILD_WHOLE, 'edit_file', offered)).toBeNull();
    // The faithful per-message content channels convict nothing on their own.
    expect(detectIntendedTool(C_CONVICTED, 'edit_file', offered)).toBeNull();
    expect(detectIntendedTool(C_ALIGNED_SUITE, 'edit_file', offered)).toBeNull();
    // The modeled live-reasoning narration DOES convict — the only channel
    // that can have carried the standalone `verify` the strike meta named.
    expect(detectIntendedTool(P_NARRATION, 'edit_file', offered)).toBe('verify');
    expect(detectIntendedToolChannels(P_NARRATION, C_CONVICTED, 'edit_file', offered)).toBe('verify');
    // edit_file is a CODING tool — the 0625bf62 platform-tool discount is
    // out of scope even when the wake text names the work (measure-first).
    expect(intentMismatchDiscount('verify', 'edit_file', BRIEF)).toBeNull();
  });

  it('UNIT (the approximation-vs-live cross-check, the family\'s new evidence leg): the earlier verify-naming read messages ACQUIT only on the FULL live input — content alone would FALSELY convict them', () => {
    const offered = ['run_command', 'read_process_output', 'verify', 'edit_file'];
    // A content-ONLY forensics replay (what probe v1 approximated) counts
    // these as read_process_output→verify mismatches — their content
    // decision sentences carry a standalone `verify` …
    expect(detectIntendedTool(C_READ_180, 'read_process_output', offered)).toBe('verify');
    expect(detectIntendedTool(C_READ_205, 'read_process_output', offered)).toBe('verify');
    // … the prose self-naming leg (7b2a0969) does NOT acquit them
    // (exact-token match: "reading"/"Reading" ≠ "read") …
    expect(proseMentionsTool(C_READ_180, 'read_process_output')).toBe(false);
    expect(proseMentionsTool(C_READ_205, 'read_process_output')).toBe(false);
    // … but the LIVE guard's input is reasoning+content (message-scoped),
    // and the modeled live reasoning names the called tool — the broad
    // acquittal boundary clears it. This is WHY the wild run's guard
    // never counted CTX180/CTX205 (zero guard_markers before seq 929)
    // while a content-only approximation did: the acquittal rode the
    // live reasoning channel.
    expect(detectIntendedToolChannels(R_READ_180, C_READ_180, 'read_process_output', offered)).toBeNull();
    expect(detectIntendedToolChannels(R_READ_205, C_READ_205, 'read_process_output', offered)).toBeNull();
    // Control: the convicted message's live narration still convicts with
    // the read turns' content present — the read acquittals never leak
    // into the edit batch's counting (message-scoped input).
    expect(detectIntendedToolChannels(P_NARRATION, C_CONVICTED, 'edit_file', offered)).toBe('verify');
    expect(proseMentionsTool(P_NARRATION, 'edit_file')).toBe(false);
  });

  it('REPLAY the incident (ONE message of FIVE mismatched edit_file calls, STABLE intent verify, coding-tool scope): steer at the third call, trip at the fifth, one-round withhold only, and the run RECOVERS on the modeled verify turn', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(readTurn180)       // wild CTX180: verify-naming read — prose-acquitted, never counted
      .mockResolvedValueOnce(readTurn205)       // wild CTX205: same — prose-acquitted
      .mockResolvedValueOnce(alignedEditTurn)   // wild CTX840: an ALIGNED earlier edit — no trip reaches back
      .mockResolvedValueOnce(convictedBatchTurn) // wild CTX913: five mismatches, one message, all SUCCEED (914..926)
      .mockResolvedValueOnce(recoveryVerifyTurn) // the ban round: edit_file absent; verify runs (wild seq 936)
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Close-out complete — the suite scripts are hardened, verified, and published with this-run citations.');
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');

    // ── Steer armed at the THIRD cumulative mismatch (call 920's count),
    //    both notices deferred to message end (wild 21:14:58.018Z) ──
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
    //    incident's exact meta (break 21:15:04.212Z) ──
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({
      tool: 'edit_file', perma: false, intended: 'verify', churned: false, shape: 'success_intent',
    });
    expect(breakerMetrics()).toHaveLength(1); // one-round withhold only — no perma, no run-end

    // ── Every call of the convicted batch executed (914..926 all
    //    SUCCEEDED in the wild; the withhold applies to the NEXT round's
    //    schema, not the in-flight batch) ──
    const editDispatches = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'edit_file');
    expect(editDispatches.length).toBe(6); // 1 aligned + all 5 convicted-batch calls

    // ── The earlier verify-naming read messages were never mismatches
    //    (the live guard's own counting — the approximation-vs-live
    //    cross-check at loop level) ──
    expect(reanchorMetrics().every((m) => m.meta?.tool === 'edit_file')).toBe(true);
    // And their calls ran as aligned work.
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'read_process_output').length).toBe(3);

    // ── The modeled recovery: the post-steer turn calls verify (the
    //    grounded next action), the run continues and finishes clean ──
    const verifyDispatch = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'verify');
    expect(verifyDispatch.length).toBeGreaterThanOrEqual(1);
    // The user-visible notices tell the TRUTH about the success shape:
    // the withhold notice says the last 5 edit_file calls SUCCEEDED and
    // names the intended verify — byte-shapes the wild lane received at
    // 21:14:58.018Z/21:15:04.212Z (guard_marker seq 929).
    const withholdNotice = userTexts().find((t) => t.includes('temporarily removed from your tool list'));
    expect(withholdNotice).toBeDefined();
    expect(withholdNotice).toContain('Your last 5 calls of edit_file all SUCCEEDED');
    expect(withholdNotice).toContain('Your own reasoning named verify');
  });

  it('REPLAY the counting NEGATIVE (the one-message proof): an ALIGNED earlier message never feeds the streak — and the live-input-acquitted verify-naming reads never arm the steer (a cross-message misattribution would have tripped at the FIRST message)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(readTurn180)       // verify-naming read — prose-acquitted, never counted
      .mockResolvedValueOnce(readTurn205)       // same
      .mockResolvedValueOnce(convictedBatchTurn)
      .mockResolvedValueOnce(recoveryVerifyTurn)
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // The steer + trip fired ONLY out of the convicted message (counts
    // 1..5 all inside it — steer at 3, trip at 5). If the earlier
    // verify-naming read messages' content sentences had been counted (the
    // approximation misread), the steer would have armed at CTX205 or
    // earlier and the breaker would have tripped before CTX913 — the
    // wild run's zero guard_markers before seq 929 proves the live guard
    // never counted them.
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'edit_file', intended: 'verify' });
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics().some((m) => m.meta?.shape === 'success_intent' && m.meta?.tool === 'edit_file')).toBe(true);
    // The read messages' calls were never mismatches.
    expect(reanchorMetrics().every((m) => m.meta?.tool === 'edit_file')).toBe(true);
  });
});

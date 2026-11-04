/**
 * REPLAY TEST — ticket 4ac955aa (mishap, 2026-10-15): "5× success-side
 * wrong-tool loop: read_file on 'ticket fb64368a: Zero-tool coding run pu' —
 * framework or model?" Auto-filed at the breaker trip (owner doctrine
 * 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session f84baf12-fa37-42e7-b59a-92bd43e60998 — the
 * fb64368a ticket lane itself — run 4a64739c-6426-4963-8a1b-e51eb08faae4,
 * glm-5.3, coding profile, continuation round). Forensic probes
 * probe-4ac955aa{,-b,-c,-d}.js (read-only prodq on box A, 2026-10-15
 * ~17:15Z) established from primary rows:
 *
 * 1. The trip fired ON THE FIXED COUNTER: the convicted batch is ONE
 *    message (checkpoint message[21]) of SIX calls dispatched
 *    16:41:39.211–16:41:41.694 — read_file ×5 (SUCCEEDING, line-ranged
 *    reads of the fb64368a fix sites: run-executor.ts 1895-2060,
 *    run-evidence-guard.ts 4230-4300 + 4490-4545,
 *    run-evidence-guard.carried.test.ts whole, switch-registry.ts 540-585)
 *    + run_command ×1 (a compound `sed -n` pipeline over the new test
 *    file, REFUSED at the tool layer for workspace scope — a `cd
 *    ../../../../../` escape; orthogonal to this guard leg, which exempts
 *    run_command entirely).
 * 2. ELIMINATION ON THE DETECTOR INPUT: detectIntendedToolChannels reads
 *    turn.reasoning + (turnText||turn.content). The CONTENT channel was
 *    recovered VERBATIM from agent_events text deltas (seq 37-38, 254
 *    chars: "Full reviewer context recovered. … Now reading the exact
 *    edit sites in parallel before touching anything.") and carries ZERO
 *    grep mentions under BOTH counters (broad acquittal boundary
 *    included); the DEPLOYED detector replayed on the recovered channels
 *    (content + empty reasoning) returns intended:null — no conviction —
 *    while the guard's own strike telemetry recorded intended:"grep",
 *    churned:false ×5 (a STANDALONE mention, stable across the streak).
 *    The live reasoning channel is provably not persisted for this
 *    provider (reasoning-wire.ts cuts `reasoning` events at the wire per
 *    the owner 2026-10-04 hide-thinking directive; replaysReasoning() is
 *    kimi-family-only, so the checkpoint stores reasoning_content:'')
 *    — therefore the conviction rode the LIVE reasoning channel: glm-5.3
 *    narrated its planned verification pass (grep the seam names) while
 *    correctly emitting the fix-site reads. The a1660b1a / 267ea7b6 /
 *    8da24785 / 2547b652 narration-word-slip class, FOURTH model family
 *    member (glm-5.3 again), FIFTH+ wild single-batch catch.
 * 3. The GUARD STACK behaved per design at every rung: the run_command
 *    sibling is EXEMPT from the success-intent leg (it can do anything —
 *    its embedded shell grep is not a `grep` tool call, so the f6217896
 *    batch-sibling acquittal correctly never fired — that acquittal
 *    requires a call NAMED grep); the 0625bf62 discount probe MATCHED
 *    (guard_miss reason:'preamble_ordered', marker:'read_file', 
 *    haystack:'wake' — the continuation wake itself orders "ONE fresh
 *    read (git_status, or read_file on the plan file)") but stayed
 *    DISARMED (armed:false) because read_file is a coding tool — the
 *    discount's platform-tool scope; steer armed at the third cumulative
 *    mismatch (reanchor metric 16:41:41.700Z, reason
 *    intent_mismatch_success, intended grep, churned:false — deferred to
 *    message end), one-round withhold at the fifth (break metric
 *    16:41:44.447Z, shape success_intent, perma:false — no perma, no
 *    run-end), and the sixth sibling dispatched.
 * 4. The CONTAINMENT WORKED — the same recovery shape as every pinned
 *    member of the class: the next model turn re-anchored and called the
 *    LITERAL grep tool (transcript parts 42-51: five grep calls over the
 *    note-text assertions and compose insertion points), read_file
 *    returned after its one-round ban, and the run continued clean (step
 *    44+, "Checking CI on the pushed sha" — the fb64368a fix lane kept
 *    working; no loop, no run-end).
 * 5. Per-call counting over turn-scoped narration is BY DESIGN — the
 *    8da24785 pin owns the single-batch assertion, the 267ea7b6 pin
 *    owns the REJECTED per-(batch,tool) dedup defense, and the f6217896
 *    pin owns the by-NAME batch-sibling acquittal. No detector change
 *    rides this ticket: every rung fired correctly. (Also no
 *    convicting-sentence capture rides it — that would write thinking
 *    text into the user-visible ticket queue against the owner's
 *    2026-10-04 hide-thinking directive; the #1437 adjudication of the
 *    same class accepted the reasoning-wire wall and adjudicated by
 *    elimination, as this pin does.)
 *
 * THIS PIN replays the incident's exact shape against the REAL agent loop
 * and asserts: the verbatim-recovered content channel convicts NOTHING on
 * its own (the elimination leg); the modeled live-reasoning narration
 * convicts read_file of intending grep; ONE message of 5 read_file + 1
 * run_command under that narration steers at the third read_file, trips at
 * the fifth, lets the run_command sibling dispatch, withholds read_file
 * for exactly one round (churned:false on both metrics); the discount
 * probe MATCHES the wake-ordered read_file yet stays DISARMED (armed:false
 * — the 0625bf62 platform-tool scope, pinned from the wild guard_miss
 * rows); and the modeled recovery turn (grep calls after the ban round,
 * per the wild parts 42-51) confirms the run CONTINUES clean and finishes.
 *
 * Scaffold mirrors agent-derail-break.2547b652.test.ts / a1660b1a: every
 * mismatched call SUCCEEDS ('probe result: ok'), read_file args are the
 * wild fix-site shapes (five distinct paths — no repeat signature can
 * fire), the narration names exactly ONE offered tool as a whole word and
 * never the called read_file (an unoffered named tool makes
 * detectIntendedTool return null and silently resets the streak — the
 * c737d007 test-writing gotcha), and args carry no id-shaped keys so no
 * ungrounded-id preflight leg can refuse them.
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

// Every mismatched read_file SUCCEEDS ('probe result: ok') — the incident
// shape is that nothing failure-shaped ever appears on the convicted tool.
// mockExecuteCodingTool's real signature is (ctx, name, args) — name-first
// mocks silently misroute (the 0aecbe92 scaffold gotcha).
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

/** CODING profile (no workspace container in the scaffold). read_file,
 *  run_command and grep are ALL in the coding schema set regardless of
 *  workspaceTools — so the narration can convict read_file of intending
 *  grep while a run_command sibling rides the same batch, exactly the
 *  incident shape. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

/** The incident's continuation wake (the fb64368a lane's own round-1
 *  resume), modeled on the wild user message: it ORDERS a fresh read —
 *  "ONE fresh read (git_status, or read_file on the plan file)" — which
 *  is why the wild guard_miss measurement rows logged
 *  reason:'preamble_ordered', marker:'read_file', haystack:'wake'. It
 *  names NO other offered tool the guard could misread. */
const BRIEF = 'Continuation r1/6 — resuming plan step 5 (address the independent reviewer findings on the pre-delivery claims fence). RECONCILE the current plan against reality with ONE fresh read (git_status, or read_file on the plan file) before editing, then apply the fixes with their tests.';

const makeInput = (userMessage: string = BRIEF, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-4ac955aa-test',
  sessionId: 'sess-4ac955aa',
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
 *  message — not persisted for glm-5.3, but pinned by the guard's own
 *  strike telemetry: intended grep, churned:false, standalone): the model
 *  narrated its planned verification pass — grepping the seam names —
 *  while read_file correctly executed the fix-site reads. Names exactly
 *  ONE offered tool as a whole word and NEVER the called read_file (and
 *  no "read … file" prose sequence — read_file is a two-token tool, so
 *  7b2a0969 prose self-naming would acquit on that pair). */
const P_NARRATION = 'Reviewer context recovered; the branch moved with two state-only commits and no overlap with the fix files. Before touching the edit sites I will grep the seam names across the touched test files to confirm every insertion point.';

/** The verbatim-recovered CONTENT channel of the convicted message (probe-c
 *  fact, 254 chars of text deltas seq 37-38 — ZERO tool mentions under the
 *  broad boundary). */
const C_CONVICTED = 'Full reviewer context recovered. Branch state confirmed: ahead 2 (my PR commits), behind 2 (main state commits #1510/#1511 — `.digby` state files, no overlap with my 4 changed files). Now reading the exact edit sites in parallel before touching anything.';

/** The verbatim-recovered CONTENT channel of the ALIGNED earlier message
 *  (probe fact, checkpoint message[18], 283 chars — the reviewer-context
 *  recovery reads, no trip fired under it, so its live reasoning was
 *  aligned too). */
const C_ALIGNED = 'Fix sites confirmed. The branch is behind origin/main by 2 (state PRs only — `git log HEAD..origin/main` shows #1510/#1511, no conflicts with my 4 files; I\'ll rebase or note at merge time). Before editing, I need the reviewer\'s exact fix plan from session memory plus the test files.';

/** The wild fix-site read shapes (probe-c verbatim args — five DISTINCT
 *  paths, so no exact or digit-collapsed repeat signature can fire). */
const READS: Array<Record<string, unknown>> = [
  { path: 'backend/src/modules/crossmodel/coding/run-executor.ts', start_line: 1895, end_line: 2060 },
  { path: 'backend/src/modules/crossmodel/coding/run-evidence-guard.ts', start_line: 4230, end_line: 4300 },
  { path: 'backend/src/modules/crossmodel/coding/run-evidence-guard.ts', start_line: 4490, end_line: 4545 },
  { path: 'backend/src/modules/crossmodel/coding/run-evidence-guard.carried.test.ts' },
  { path: 'backend/src/modules/crossmodel/platform/switch-registry.ts', start_line: 540, end_line: 585 },
];
const readCall = (n: number) => ({
  id: `t${n}`,
  name: 'read_file',
  arguments: JSON.stringify(READS[(n - 1) % READS.length]),
});

/** The wild run_command sibling (probe-c verbatim prefix, clipped at 260
 *  chars in the probe — a compound `sed -n` pipeline over the new test
 *  file's regions with a `cd ../../../../../` tail; REFUSED in the wild
 *  for workspace scope). The refusal is orthogonal to this leg — the
 *  success-intent guard EXEMPTS run_command entirely (it can do
 *  anything), and its embedded shell grep is NOT a `grep` tool call, so
 *  the f6217896 batch-sibling acquittal cannot fire on it. Modeled here
 *  as a dispatched sibling under the mocked-success executor. */
const SIBLING_CMD = "cd backend/src/modules/crossmodel/coding && sed -n '344,380p' zero-receipt-fabrication-gate.fb64368a.test.ts && echo ===CARRIED-MOCK=== && sed -n '260,280p' zero-receipt-fabrication-gate.fb64368a.test.ts && echo ===COMPOSE===";

/** THE INCIDENT SHAPE — ONE message of 5 read_file + 1 run_command (wild
 *  seqs 40-53, dispatched 16:41:39.211–16:41:41.694) under the
 *  grep-naming live reasoning with a tool-free content channel. Steer
 *  arms at read_file #3, trip at #5, the run_command sibling dispatches
 *  (the withhold applies to the next round's schema, not the in-flight
 *  batch). */
const convictedBatchTurn = {
  content: C_CONVICTED,
  reasoning: P_NARRATION,
  toolCalls: [
    readCall(1), readCall(2), readCall(3), readCall(4), readCall(5),
    { id: 't6', name: 'run_command', arguments: JSON.stringify({ command: SIBLING_CMD }) },
  ],
  finishReason: 'tool_calls' as const,
};

/** An ALIGNED earlier message (wild checkpoint message[18] → 2 read_file
 *  calls, no trip): the narration names the called tool's work
 *  truthfully (no other offered tool as a whole word) — proving the
 *  streak does not reach back into earlier messages. */
const alignedTurn = {
  content: C_ALIGNED,
  reasoning: 'The branch moved; the fix plan needs the reviewer context. Pulling the two primary fix sites into view now.',
  toolCalls: [readCall(2), readCall(4)],
  finishReason: 'tool_calls' as const,
};

/** The MODELED RECOVERY turn (the wild lane's post-steer behavior,
 *  transcript parts 42-51): re-anchored, calling the LITERAL grep tool —
 *  the grounded next action — while read_file sits out its one-round ban
 *  (aligned: naming grep while calling grep). */
const recoveryGrepTurn = {
  content: 'All fix sites are now read. Running the verification greps before editing: the note-text assertions in the existing tests, then the compose insertion points.',
  reasoning: 'Re-anchored: the reads are done; now grep the note-text assertions and the compose insertion points before editing.',
  toolCalls: [
    { id: 'g1', name: 'grep', arguments: JSON.stringify({ pattern: 'verificationFooter', path: 'backend/src/modules/crossmodel/coding' }) },
    { id: 'g2', name: 'grep', arguments: JSON.stringify({ pattern: 'DETECTOR-RECALL REPLAY', path: 'backend/src/modules/crossmodel/coding' }) },
  ],
  finishReason: 'tool_calls' as const,
};
const FINAL = { content: 'Reviewer findings addressed; the claims-fence fix sites are read and verified, and every assertion carries a this-run citation.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');
const measurementRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_intent_attribution');
const conversation = () => mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }>;
const steerMessages = () => (conversation() || []).filter(
  (m) => m?.role === 'user' && typeof m.content === 'string' && m.content.includes('RE-ANCHOR (one per run)'),
);
const userTexts = () => (conversation() || []).filter((m) => m?.role === 'user').map((m) => String(m.content));

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  delete process.env.INTENT_MEASURE_SYSTEM_EXCLUDE_DISABLED;
  // Reviewer F1 (4ac955aa adversarial pass): this pin's 4th test depends on
  // the f6217896 batch-sibling acquittal being ENABLED. That acquittal is now
  // unconditional (its kill switch was deleted with RSW-1 cluster 24), so only
  // the ladder knobs this pin exercises still need clearing.
  delete process.env.DERAIL_INTENT_DISCOUNT_CAP;
});

describe('ticket 4ac955aa — single-message success-side read_file derail naming grep (glm-5.3, fb64368a lane): guard correct, containment effective, model behavior', () => {
  it('UNIT (the elimination leg): the verbatim-recovered CONTENT channel convicts NOTHING — the conviction necessarily rode the LIVE reasoning channel (not persisted for non-kimi providers)', () => {
    const offered = ['run_command', 'edit_file', 'verify', 'read_file', 'grep', 'write_file', 'glob'];
    // The faithful content channel of the convicted message convicts
    // nothing on its own (probe fact: zero grep mentions, broad boundary).
    expect(detectIntendedTool(C_CONVICTED, 'read_file', offered)).toBeNull();
    expect(detectIntendedToolChannels('', C_CONVICTED, 'read_file', offered)).toBeNull();
    // The aligned earlier message's content channel likewise.
    expect(detectIntendedTool(C_ALIGNED, 'read_file', offered)).toBeNull();
    // The modeled live-reasoning narration DOES convict — the only channel
    // that can have carried the standalone `grep` the strike meta named.
    expect(detectIntendedTool(P_NARRATION, 'read_file', offered)).toBe('grep');
    expect(detectIntendedToolChannels(P_NARRATION, C_CONVICTED, 'read_file', offered)).toBe('grep');
    // The wake ORDERS the called read_file — so the 58e675c9/0625bf62
    // discount PROBE matches (the wild guard_miss rows: reason
    // 'preamble_ordered', marker 'read_file', haystack 'wake') …
    const probe = intentMismatchDiscount('grep', 'read_file', BRIEF);
    expect(probe).not.toBeNull();
    expect(probe!.reason).toBe('preamble_ordered');
    expect(probe!.marker).toBe('read_file');
    // … but read_file is a CODING tool: the ARMED discount is
    // platform-tool scoped (0625bf62), so the classic ladder still counts
    // — pinned behaviorally by armed:false in the replay below.
  });

  it('REPLAY the incident (ONE message of 5 read_file + 1 run_command sibling, STABLE intent grep, coding-tool scope): steer at the third read_file, trip at the fifth, the sibling still dispatches, one-round withhold only, and the run RECOVERS on the modeled grep turn', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(alignedTurn)        // wild message[18]: an ALIGNED earlier message — no trip reaches back
      .mockResolvedValueOnce(convictedBatchTurn) // wild message[21]: 5 mismatches + 1 exempt sibling, one message, all SUCCEED (seqs 40-53)
      .mockResolvedValueOnce(recoveryGrepTurn)   // the ban round: read_file absent; the literal grep tool runs (wild parts 42-51)
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Reviewer findings addressed; the claims-fence fix sites are read and verified, and every assertion carries a this-run citation.');
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');

    // ── Steer armed at the THIRD cumulative read_file mismatch, notice
    //    deferred to message end (wild reanchor 16:41:41.700Z) ──
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run)');
    expect(steer).toContain('your own reasoning named grep');
    expect(steer).toContain('call grep NOW');
    // The steer tells the TRUTH about the SUCCESS shape (2c98b460 reviewer F1).
    expect(steer).toContain('it SUCCEEDED');
    expect(steer).not.toContain('and it failed');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({
      tool: 'read_file', intended: 'grep', reason: 'intent_mismatch_success', churned: false,
    });

    // ── Trip at the FIFTH cumulative mismatch, one round only — the
    //    incident's exact meta (break 16:41:44.447Z) ──
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({
      tool: 'read_file', perma: false, intended: 'grep', churned: false, shape: 'success_intent',
    });
    expect(breakerMetrics()).toHaveLength(1); // one-round withhold only — no perma, no run-end

    // ── The run_command sibling dispatched despite the trip AND despite
    //    carrying the batch's grep work: the f6217896 batch-sibling
    //    acquittal is by NAME only (a shell grep inside run_command is
    //    not a `grep` call), so the 5 read_files were correctly NOT
    //    acquitted — this is the ticket's central seam ──
    const readDispatches = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'read_file');
    expect(readDispatches.length).toBe(7); // 2 aligned + all 5 convicted-batch calls
    const cmdDispatches = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'run_command');
    expect(cmdDispatches.length).toBe(1);

    // ── The discount probe's wild shape: the wake ORDERS read_file
    //    (preamble_ordered), the row is logged wake-haystack, but the
    //    discount stayed DISARMED — read_file is a coding tool
    //    (0625bf62 platform-tool scope) ──
    const rows = measurementRows();
    expect(rows.length).toBe(5);
    expect(rows[0].meta).toMatchObject({
      tool: 'read_file', intended: 'grep', reason: 'preamble_ordered', marker: 'read_file', armed: false, haystack: 'wake',
    });
    expect(rows[4].meta.streak).toBe(5); // the shadow streak ran 1..5 inside ONE message
    // No metric ever named run_command as the mismatched tool — the
    // success-intent leg exempts it entirely.
    expect(measurementRows().every((m) => m.meta?.tool === 'read_file')).toBe(true);

    // ── The modeled recovery: the post-steer turn calls the LITERAL grep
    //    tool (the grounded next action), the run continues and finishes
    //    clean ──
    const grepDispatches = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'grep');
    expect(grepDispatches.length).toBe(2);
    // The user-visible notices tell the TRUTH about the success shape:
    // the withhold notice says the last 5 read_file calls SUCCEEDED and
    // names the intended grep — byte-shapes the wild lane received at
    // 16:41:41.702Z / 16:41:44.447Z (guard_marker seq 54).
    const withholdNotice = userTexts().find((t) => t.includes('temporarily removed from your tool list'));
    expect(withholdNotice).toBeDefined();
    expect(withholdNotice).toContain('Your last 5 calls of read_file all SUCCEEDED');
    expect(withholdNotice).toContain('Your own reasoning named grep');
  });

  it('REPLAY the counting NEGATIVE (the one-message proof): an ALIGNED earlier message never feeds the streak — its two read_file calls log NO measurement rows and do not pre-arm the steer or pre-trip the breaker (a cross-message misattribution would have tripped at the FIRST message)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(alignedTurn)        // 2 aligned calls — no mismatch counted, no measurement row
      .mockResolvedValueOnce(convictedBatchTurn) // counts 1..5 all inside it — steer at 3, trip at 5
      .mockResolvedValueOnce(recoveryGrepTurn)
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // The measurement rows are EXACTLY the convicted message's five —
    // streak 1..5, never 3..7 (the aligned message's calls would have
    // logged two more rows and shifted the streak had they counted).
    const rows = measurementRows();
    expect(rows.length).toBe(5);
    expect(rows.map((r) => r.meta.streak)).toEqual([1, 2, 3, 4, 5]);
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'read_file', intended: 'grep' });
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics().some((m) => m.meta?.shape === 'success_intent' && m.meta?.tool === 'read_file')).toBe(true);
  });

  it('SYNTHETIC adjacent shape (NOT the wild instance — its sibling was a run_command): when the batch DOES carry a call NAMED grep, the f6217896 batch-sibling acquittal fires and NO trip lands — the by-NAME scope is the acquittal boundary the wild sibling sat outside of', async () => {
    // Same narration, same five read_file calls — but the sixth sibling is
    // the literal grep TOOL (the f6217896 itemized-checklist shape). The
    // acquittal must clear the streak (guard_miss reason 'batch_sibling')
    // and neither the steer nor the breaker may fire.
    const siblingNamedGrepTurn = {
      content: C_CONVICTED,
      reasoning: P_NARRATION,
      toolCalls: [
        readCall(1), readCall(2), readCall(3), readCall(4), readCall(5),
        { id: 't6', name: 'grep', arguments: JSON.stringify({ pattern: 'verificationFooter', path: 'backend/src/modules/crossmodel/coding' }) },
      ],
      finishReason: 'tool_calls' as const,
    };
    mockRunModelTurn
      .mockResolvedValueOnce(siblingNamedGrepTurn)
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(reanchorMetrics()).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0);
    const acquittals = measurementRows().filter((m) => m.meta?.reason === 'batch_sibling');
    expect(acquittals.length).toBe(5); // each faithful read_file acquitted, logged (bounded telemetry)
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'read_file').length).toBe(5);
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'grep').length).toBe(1);
  });
});

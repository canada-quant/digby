/**
 * REPLAY TEST — ticket 8da24785 (mishap, 2026-09-23): "5× success-side
 * wrong-tool loop: edit_file on 'Hardening Bench for Public Release' —
 * framework or model?" Auto-filed at the breaker trip (owner doctrine
 * 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session 3e1cae6f-59fb-43a7-9d32-6ee36c450428 — the
 * canlegal-bench "Hardening Bench for Public Release" lane, a DIFFERENT
 * project than crossmodel; run 28421d3c-238d-44f5-921e-fe9f58eb709b,
 * kimi-k3/moonshot, coding profile, MACHINE-triggered): the lane's
 * reasoning planned artifact regeneration via the shell ("run_command the
 * builder") while it correctly emitted edit_file text edits — FIVE
 * consecutive edit_file mismatches, every call SUCCEEDING, the named
 * intent STABLE at run_command the whole way (no churn). Fleet telemetry
 * this incident (pulled 2026-09-23 ~08:52Z): guard_miss seam
 * 'tool_intent_attribution' — the five edit_file rows landed
 * 07:56:30.854Z → 07:56:30.995Z (streaks 1–5, ALL reason
 * 'preamble_ordered', marker edit_file — the user-preference standing
 * orders whole-word-name the CALLED edit_file: "Prefer edit_file
 * (targeted, exact-match edits) over rewriting a whole file with
 * write_file.", the 58e675c9 discount class) → guard_strike
 * 'tool_derail_reanchor' 07:56:34.881Z (reason 'intent_mismatch_success',
 * intended 'run_command', churned:false) → guard_strike
 * 'tool_derail_break' 07:56:39.372Z (shape 'success_intent', perma:false,
 * churned:false, intended 'run_command') → the auto-file at
 * 07:56:34.889Z under the CORRECT success-side title (the d73765fc shape
 * threading live and rendering). The lane RECOVERED after the one-round
 * withhold — its transcript re-anchored ("Re-anchored: intended tool is
 * run_command — checking whether the 3 mypy diagnostics are
 * pre-existing…"), ran its builder, and shipped its own project's
 * re-inclusion PR — no re-dispatch needed. Post-recovery discount rows on
 * OTHER called tools (search_memory 08:12:09Z, update_plan 08:31:39Z and
 * 08:38:57Z — each streak 1) never re-tripped anything: per-tool key
 * isolation held after the ban round too.
 *
 * ADJUDICATION (lane b92ef13f, 2026-09-23): MODEL-SIDE — no deterministic
 * framework/schema/preflight/guard defect caused the streak; the guard
 * stack behaved per design at every rung (discount measured loud,
 * containment fired anyway — measure-first; steer told the TRUTH about the
 * success shape; trip withheld edit_file exactly one round; filed text
 * byte-exact the NON-CHURN agent.ts:3753 template). The DISTINGUISHING
 * AXES vs the four already-pinned quadrants (a1660b1a stable+silent,
 * ee39f231 churn+loud, c737d007 churn mechanics, 4994e2f1 stable+loud):
 * this is the SAME stable+loud quadrant but on a SECOND MODEL —
 * kimi-k3/moonshot where 4994e2f1 was glm-5.3/zai — and a MACHINE-triggered
 * run in a different project. The decoder narration-word-slip class is
 * therefore NOT model-specific, NOT trigger-specific, NOT
 * project-specific; any "tune it for one model" fix must get past both
 * replays. Timing variant pinned here: ALL FIVE mismatches arrived in ONE
 * tool batch (150 ms apart in the wild) — steer (threshold 3) and trip
 * (threshold 5) both fire out of a single batch, and the ban round is the
 * very next model turn.
 *
 * THIS PIN replays the incident's exact shape against the REAL agent loop
 * and asserts: steer at the third cumulative edit_file mismatch (intended
 * run_command, churned FALSE — the stable-intent arm), trip at the fifth,
 * ALL five mismatches discount-eligible with containment UNCHANGED (the
 * measure-first invariant), the byte-exact NON-churn filed text, the
 * truthful withhold notice, the one-round schema withhold, and the
 * kill-switch silence.
 *
 * Scaffold mirrors agent-derail-break.4994e2f1.test.ts: every mismatched
 * call SUCCEEDS ('probe result: ok'), edit_file args vary by
 * LETTER-skeleton path (never a digit-only delta) so the exact and
 * digit-collapsed repeat signatures stay blind, and no run_command call
 * ever appears (the scaffold's container mock would leak to a real
 * shell). Each narration names exactly ONE offered tool as a whole word
 * and never the called edit_file — an unoffered named tool makes
 * detectIntendedTool return null and silently resets the streak (the
 * c737d007 test-writing gotcha). The wild run's post-recovery discounted
 * rows on other tools are noted in the header; the replay stays focused
 * on the incident batch (5 rows, well under the 12-row intentDiscountLogs
 * cap so every mismatch is assertable individually).
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

// Every tool SUCCEEDS ('probe result: ok') — the incident shape is that
// nothing failure-shaped ever appears. mockExecuteCodingTool's real
// signature is (ctx, name, args) — name-first mocks silently misroute
// (the 0aecbe92 scaffold gotcha).
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, _name: string, _args: any) => 'probe result: ok');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The document/feedback/schedule seam dispatches via ctx.toolCache — keep
// the REAL TOOL_DEFINITIONS, stub only the executor (same success premise).
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
import { detectIntendedTool, intentMismatchDiscount } from './tool-preflight';

/** CODING profile (no workspace container in the scaffold). edit_file and
 *  run_command are both in the coding schema set (agent.ts:1010-1017) —
 *  so each is convictable when the narration names it. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

/** The incident wake, faithful to its haystack (the supervisor GO ruling
 *  for the §7 re-inclusion cycle + the standing preference lines the lane
 *  ran under): it whole-word-names the CALLED edit_file — which is exactly
 *  why every mismatch in the incident was discount-ELIGIBLE
 *  (preamble_ordered, marker edit_file — the wild rows quote the
 *  "Prefer edit_file (targeted, exact-match edits)…" line verbatim). */
const BRIEF = [
  '[MACHINE-TRIGGERED RUN — supervisor GO: §7 re-inclusion cycle, todo f8654c84]',
  'You are the Hardening Bench lane: regenerate denominators/manifests/splash per the runbook.',
  '- Prefer edit_file (targeted, exact-match edits) over rewriting a whole file with write_file.',
  '- Condition 1 binds: re-confirm your own trigger conditions fresh before shipping.',
  'Report back with the re-serve receipt and post-serve verification.',
].join('\n');

const makeInput = (userMessage: string = BRIEF, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-8da24785-test',
  sessionId: 'sess-8da24785',
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

/** The incident narration: regeneration prose planning a builder shell
 *  run while edit_file correctly executes the text edits — it names
 *  exactly ONE offered tool as a whole word and NEVER the called
 *  edit_file. The named intent is STABLE at run_command (churned:false is
 *  this incident's signature, same quadrant as 4994e2f1). */
const P_BATCH = 'The splash and leaderboard artifacts are stale after the policy change — run_command the builder so the committed cells regenerate before the re-serve.';
const R_CLOSE = 'Before the final report: run_command the post-serve verification probe so the denominators are quoted from fresh output.';

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
const editCall = (n: number) => ({
  id: `t${n}`,
  name: 'edit_file',
  arguments: JSON.stringify({
    path: `frontend/app/bench/${WORDS[(n - 1) % WORDS.length]}-panel.tsx`,
    old_string: 'const DENOMINATOR = 16',
    new_string: 'const DENOMINATOR = 10',
  }),
});
/** The incident's shape: ALL FIVE mismatched edit_file calls in ONE tool
 *  batch (the wild rows landed 150 ms apart: 07:56:30.854 → .995), under
 *  one stable run_command-naming narration. Steer (3) and trip (5) both
 *  fire out of this single batch. */
const editMissBatch = {
  content: '',
  reasoning: P_BATCH,
  toolCalls: Array.from({ length: 5 }, (_, i) => editCall(i + 1)),
  finishReason: 'tool_calls' as const,
};
/** An ALIGNED success for the ban-round probe: narration names the called
 *  tool. list_files — never run_command (see header). */
const alignedTurn = (n: number) => ({
  content: '',
  reasoning: 'Now list_files to check which bench fixtures the builder emitted before the final report.',
  toolCalls: [{ id: `t${n}`, name: 'list_files', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls' as const,
});
const FINAL = { content: 'Re-serve verification complete.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

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

describe('ticket 8da24785 — edit_file stable-intent derail under a discount-eligible wake, all five mismatches in ONE batch: cross-model second instance (model-side)', () => {
  it('UNIT: the incident premise — successes are invisible to the failure detector, the narration convicts run_command STABLY, and the 58e675c9 discount FIRES on this wake', () => {
    expect(looksLikeToolFailure('probe result: ok')).toBe(false);
    const offered = ['edit_file', 'run_command', 'read_file', 'grep', 'list_files', 'web_pipe', 'list_dir', 'search_code_semantic', 'get_fleet_telemetry'];
    expect(detectIntendedTool(P_BATCH, 'edit_file', offered)).toBe('run_command');
    expect(detectIntendedTool(R_CLOSE, 'edit_file', offered)).toBe('run_command');
    // Faithful narration acquits.
    expect(detectIntendedTool(alignedTurn(6).reasoning, 'list_files', offered)).toBeNull();
    // THE DISTINGUISHING AXIS: the incident's standing orders whole-word-name
    // the CALLED edit_file (the user-preference line), so every mismatch
    // here is discount-ELIGIBLE (preamble_ordered) — and the replay below
    // proves containment fired anyway (measurement changes NOTHING).
    expect(intentMismatchDiscount('run_command', 'edit_file', BRIEF)).toMatchObject({ reason: 'preamble_ordered', marker: 'edit_file' });
  });

  it('REPLAY the incident (batch-of-5 under STABLE intent, measure LOUD): steer at the third cumulative edit_file mismatch (intended run_command, churned:false), trip at the fifth — both out of ONE batch — and containment UNCHANGED', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(editMissBatch)      // 07:56:30.854→.995 — ALL FIVE mismatches in one batch
      .mockResolvedValueOnce(alignedTurn(6))     // ban round: edit_file absent from the schema
      .mockResolvedValue(FINAL);
    const input = makeInput(BRIEF, { ...CODING_TEST_PROFILE, maxSteps: 8 });
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Re-serve verification complete.');
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');

    // ── Containment fired DESPITE every mismatch being discount-eligible ──
    // (the measure-first invariant: the 58e675c9 probe measures, never weakens).
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run)');
    // The arm-time named intent is run_command — STABLE, not rotated.
    expect(steer).toContain('your own reasoning named run_command');
    expect(steer).toContain('call run_command NOW');
    // The steer tells the TRUTH about the SUCCESS shape (reviewer F1 of 2c98b460).
    expect(steer).toContain('it SUCCEEDED');
    expect(steer).not.toContain('and it failed');
    expect(reanchorMetrics()).toHaveLength(1);
    // churned FALSE — this incident's signature (ee39f231 pinned the true twin).
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'edit_file', intended: 'run_command', reason: 'intent_mismatch_success', churned: false });

    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({ tool: 'edit_file', perma: false, intended: 'run_command', churned: false });
    expect(breakerMetrics()).toHaveLength(1); // one-round withhold only — no perma, no run-end

    // ── The measurement was LOUD on exactly the incident's five rows ──
    const discounts = discountMetrics();
    expect(discounts).toHaveLength(5);
    const ef = discounts.filter((m) => m.meta.tool === 'edit_file');
    expect(ef).toHaveLength(5);
    expect(ef.map((m) => m.meta.intended)).toEqual(['run_command', 'run_command', 'run_command', 'run_command', 'run_command']);
    expect(ef.map((m) => m.meta.streak)).toEqual([1, 2, 3, 4, 5]);
    expect(ef.every((m) => m.meta.reason === 'preamble_ordered' && m.meta.marker === 'edit_file')).toBe(true);

    // ── Truthful notice + byte-exact attribution (the filed ticket text) ──
    expect(userTexts().some((t) => t.includes('Your last 5 calls of edit_file all SUCCEEDED') && t.includes('temporarily removed from your tool list for the next round'))).toBe(true);
    expect(userTexts().some((t) => t.includes('ALL FAILED'))).toBe(false);
    expect(mockFileStreakInvestigation).toHaveBeenCalled();
    const evidenceText = String(mockFileStreakInvestigation.mock.calls[0][0].recentFailures[0]);
    // The NON-CHURN template (agent.ts:3753) — byte-exact the ticket's quoted
    // text; ee39f231 pinned the churned sibling branch.
    expect(evidenceText).toContain("edit_file kept SUCCEEDING while the run's own reasoning named run_command");
    expect(evidenceText).toContain('(edit_file→run_command ×5 consecutive, ticket 2c98b460)');

    // ── The withhold lasts EXACTLY one model round (the ban round is the
    //    turn immediately after the batch) ──
    expect(offeredAtCall(1).has('edit_file')).toBe(false);
    expect(offeredAtCall(2).has('edit_file')).toBe(true);
  });

});

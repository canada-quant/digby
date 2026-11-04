/**
 * REPLAY TEST — ticket 4994e2f1 (mishap, 2026-09-23): "5× success-side
 * wrong-tool loop: read_file on 'Scheduled Burn-Down Run Blocked on Revie'
 * — framework or model?" Auto-filed at the breaker trip (owner doctrine
 * 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session f9282104-f467-466b-8c58-9e5bbcb9a3c3, run
 * 589ba957-fd69-4465-be48-c4d8a020c898, glm-5.3/zai, coding profile,
 * user-turn trigger — the adversarial RE-REVIEWER for PR #986, i.e. the
 * very verdict lane gating ticket 020d979d): the lane's reasoning planned
 * re-verification by symbol search ("grep the region / grep the refs")
 * while it correctly emitted read_file region reads on source files —
 * FIVE consecutive read_file mismatches, every call SUCCEEDING, the named
 * intent STABLE at grep the whole way (no churn). Fleet telemetry this
 * incident (pulled 2026-09-23 ~03:35Z): guard_miss seam
 * 'tool_intent_attribution' — precursor mismatches on OTHER called tools
 * (check_ci 03:09:51.202Z, get_chat_messages 03:09:51.635Z, update_plan
 * 03:11:14.804Z — all intended grep), then the read_file rows 03:11:17Z →
 * 03:19:44Z until the 12-row intentDiscountLogs cap — ALL reason
 * 'preamble_ordered' (the standing orders whole-word-name the CALLED
 * read_file: "…grep/glob find exact symbols; list_dir/read_file to read…",
 * the 58e675c9 discount class) → guard_strike 'tool_derail_reanchor'
 * 03:17:38.733Z (reason 'intent_mismatch_success', intended 'grep',
 * churned:false) → guard_strike 'tool_derail_break' 03:19:51.644Z (shape
 * 'success_intent', perma:false, churned:false, intended 'grep') → the
 * auto-file at 03:19:44.781Z under the CORRECT success-side title (the
 * d73765fc shape threading live and rendering). The lane RECOVERED after
 * the one-round withhold and delivered its re-review (29/29 test narration
 * at 03:34:34Z) — no re-dispatch needed.
 *
 * ADJUDICATION (lane b92ef13f, 2026-09-23): MODEL-SIDE — no deterministic
 * framework/schema/preflight/guard defect caused the streak. Every rung
 * behaved per design: the 2c98b460 success-side leg counted what the
 * failure ladder is blind to; the steer at 3 told the TRUTH about the
 * success shape ("it SUCCEEDED"); the trip at 5 withheld read_file exactly
 * one round (perma:false, first trip); the filed text is byte-exact the
 * agent.ts:3753 NON-CHURN template; the d73765fc-corrected filing rendered
 * the right title end-to-end; and the 58e675c9 measure probe classified
 * the rows discount-eligible (preamble_ordered) while containment fired
 * anyway — MEASURE-FIRST working as designed (measurement loud, detector
 * unchanged). Cross-model contamination was ruled out structurally: the
 * two deepseek-flash guard_miss rows (worker legs) cannot touch the
 * orchestrator streak — intentMissTool/intentMissCount are agentLoop
 * locals (agent.ts:1560). The conviction signal was narration-side noise:
 * glm-5.3 naming grep in re-verification prose while read_file correctly
 * executed region reads — the a1660b1a/ee39f231 decoder class, third wild
 * instance.
 *
 * THE DISTINGUISHING AXIS (why this pin exists alongside its siblings):
 * the four quadrants of the success-side guard matrix are now each pinned
 * by a wild instance — a1660b1a: STABLE intent, probe SILENT (wake names
 * nothing); ee39f231: CHURNING intent, probe LOUD (wake names the called
 * tool); c737d007: churn mechanics with a nameless wake; THIS incident:
 * STABLE intent + probe LOUD + the d73765fc-correct filing. Pinning the
 * stable-intent quadrant closes the matrix: a future tuning pass that
 * points at preamble_ordered rows as "noise the guard should have
 * ignored" must get past all four replays, and a regression in the
 * NON-churn evidence template (agent.ts:3753) or the churned:false
 * telemetry would break THIS test while its churned sibling stays green.
 *
 * THIS PIN replays the incident's exact shape against the REAL agent loop
 * and asserts: steer at the third read_file mismatch (intended grep,
 * churned FALSE — the stable-intent arm), trip at the fifth (intended
 * grep, churned false), ALL mismatches discount-eligible with containment
 * UNCHANGED (the measure-first invariant), the per-tool key isolation
 * (the precursor mismatch on another called tool neither feeds nor resets
 * the read_file streak), the byte-exact NON-churn filed text, the
 * truthful withhold notice, and the one-round schema withhold.
 *
 * FIDELITY NOTE (precursor substitution): the wild precursors called
 * check_ci / get_chat_messages / update_plan — get_chat_messages is
 * offered to the REAL review lane but not to this scaffold's coding
 * profile, so the pin compresses them to one get_fleet_telemetry call
 * (the nearest offered sibling) under the same grep-naming narration.
 * The 12-row discount-log cap the wild run hit is noted here; the replay
 * stays under it (6 rows) so every mismatch is asserted individually.
 *
 * Scaffold mirrors agent-derail-break.ee39f231.test.ts: every mismatched
 * call SUCCEEDS ('probe result: ok'), read_file args vary by LETTER-
 * skeleton path (never a digit-only delta) so the exact and digit-collapsed
 * repeat signatures stay blind, the per-turn reasoning word-varies (the
 * 03587322 repeated-line leg needs an IDENTICAL line), and no run_command
 * call ever appears (the scaffold's container mock would leak to a real
 * shell). Each narration names exactly ONE offered tool as a whole word
 * and never the called read_file — an unoffered named tool makes
 * detectIntendedTool return null and silently resets the streak (the
 * c737d007 test-writing gotcha).
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

/** CODING profile (no workspace container in the scaffold). read_file is in
 *  the coding schema set regardless of workspaceTools (agent.ts:1010-1017);
 *  web_pipe/grep/get_fleet_telemetry/list_files are all offered to the
 *  coding profile (CODING_TOOL_SCHEMA + TOOL_DEFINITIONS) — so each is
 *  convictable when the narration names it. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

/** The incident wake, faithful to its haystack (the re-review dispatch
 *  brief + the standing doctrine lines the reviewer ran under): it
 *  whole-word-names the CALLED read_file (and grep, and
 *  get_fleet_telemetry) — which is exactly why every mismatch in the
 *  incident was discount-ELIGIBLE (preamble_ordered). */
const BRIEF = [
  '[AGENT-SENT MESSAGE — re-review dispatch: PR #986 rework at 4f5328c53]',
  'You are an INDEPENDENT ADVERSARIAL RE-REVIEWER — verify every rework claim against primary sources:',
  '- identifier or file; grep/glob find exact symbols; list_dir/read_file to read. Never edit a file you have not read this session.',
  '- get_fleet_telemetry',
  '- Prefer edit_file (targeted, exact-match edits) over rewriting a whole file with write_file.',
  'Return MERGE-SAFE or BLOCKED with numbered file:line findings.',
].join('\n');

const makeInput = (userMessage: string = BRIEF, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-4994e2f1-test',
  sessionId: 'sess-4994e2f1',
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

/** The incident narrations: re-verification prose planning symbol search
 *  (grep) while read_file correctly executes region reads — each names
 *  exactly ONE offered tool as a whole word and NEVER the called read_file.
 *  Unlike ee39f231's rotating intent, the named intent is STABLE at grep
 *  the whole way: churned:false is this incident's signature. */
const P_REVIEW = 'Establish the git facts before anything else: the merge-base and ls-remote lines the prior verdict cites — grep the PR-head refs region for the ancestry bytes before re-citing it.';
const R1 = 'First re-verification angle: the prior verdict hinged on the session-driver stop-restart path — grep that hook region for the exact guard bytes before re-citing the finding.';
const R2 = 'Second angle: the rework claims new behavioral pins — grep the test describe blocks for the C1 pin shape the manifest says landed.';
const R3 = 'Third angle: the DIRTY merge-state claim — grep main recent touches on the three reworked files to see whether the conflict is live or a stale fetch artifact.';
const R4 = 'Closing the re-verification: grep the PR diff once more for any hunk the manifest did not account for, then write the verdict with quoted output.';

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
const readCall = (n: number) => ({
  id: `t${n}`,
  name: 'read_file',
  arguments: JSON.stringify({ path: `backend/src/modules/crossmodel/coding/${WORDS[(n - 1) % WORDS.length]}-lane.ts`, start_line: 100, end_line: 160 }),
});
/** A mismatched read_file turn (calls default 1; the incident's final turn
 *  carried the 4th AND 5th mismatch in one batch — pass calls: 2). */
const readMissTurn = (n: number, reasoning: string, calls = 1) => ({
  content: '',
  reasoning,
  toolCalls: Array.from({ length: calls }, (_, i) => readCall(n + i)),
  finishReason: 'tool_calls',
});
/** The incident's PRECURSOR mismatch (03:09:51Z): another called tool
 *  succeeding under grep-naming narration — it must neither feed nor reset
 *  the read_file streak (per-tool key isolation). The wild lane called
 *  get_chat_messages (offered to the real review lane, not this scaffold's
 *  coding profile) — substituted with get_fleet_telemetry, see header. */
const precursorTurn = {
  content: '',
  reasoning: P_REVIEW,
  toolCalls: [
    { id: 'p1', name: 'get_fleet_telemetry', arguments: JSON.stringify({ view: 'metrics', kind: 'guard_strike', hours: 6 }) },
  ],
  finishReason: 'tool_calls' as const,
};
/** An ALIGNED success for the ban-round probe: narration names the called
 *  tool. list_files — never run_command (see header). */
const alignedTurn = (n: number) => ({
  content: '',
  reasoning: 'Now list_files to check which replay fixtures exist before writing the verdict.',
  toolCalls: [{ id: `t${n}`, name: 'list_files', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls' as const,
});
const FINAL = { content: 'Re-review re-verification complete.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

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

describe('ticket 4994e2f1 — read_file stable-intent derail under a discount-eligible wake: measure-first invariant (model-side)', () => {
  it('UNIT: the incident premise — successes are invisible to the failure detector, each narration convicts grep STABLY, and the 58e675c9 discount FIRES on this wake', () => {
    expect(looksLikeToolFailure('probe result: ok')).toBe(false);
    const offered = ['read_file', 'grep', 'web_pipe', 'list_files', 'get_fleet_telemetry', 'search_code_semantic', 'list_dir', 'run_command'];
    expect(detectIntendedTool(P_REVIEW, 'get_fleet_telemetry', offered)).toBe('grep');
    expect(detectIntendedTool(R1, 'read_file', offered)).toBe('grep');
    expect(detectIntendedTool(R2, 'read_file', offered)).toBe('grep');
    expect(detectIntendedTool(R3, 'read_file', offered)).toBe('grep');
    expect(detectIntendedTool(R4, 'read_file', offered)).toBe('grep');
    // Faithful narration acquits.
    expect(detectIntendedTool(alignedTurn(6).reasoning, 'list_files', offered)).toBeNull();
    // THE DISTINGUISHING AXIS: the incident's standing orders whole-word-name
    // the CALLED read_file (doctrine + preference lines), so every mismatch
    // here is discount-ELIGIBLE (preamble_ordered) — and the replay below
    // proves containment fired anyway (measurement changes NOTHING).
    expect(intentMismatchDiscount('grep', 'read_file', BRIEF)).toMatchObject({ reason: 'preamble_ordered', marker: 'read_file' });
    expect(intentMismatchDiscount('grep', 'get_fleet_telemetry', BRIEF)).toMatchObject({ reason: 'preamble_ordered', marker: 'get_fleet_telemetry' });
  });

  it('REPLAY the incident (trip-at-5 under STABLE intent, measure LOUD): steer at the third read_file mismatch (intended grep, churned:false), trip at the fifth (intended grep, churned:false), ALL 6 mismatches discount-eligible — and containment UNCHANGED', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(precursorTurn)             // 03:09:51Z — precursor mismatch (another called tool)
      .mockResolvedValueOnce(readMissTurn(1, R1))       // 03:11:17Z — read_file mismatch 1
      .mockResolvedValueOnce(readMissTurn(2, R2))       // 03:17:24Z — mismatch 2
      .mockResolvedValueOnce(readMissTurn(3, R3))       // 03:17:38Z — mismatch 3 ⇒ STEER (the 03:17:38.733Z row)
      .mockResolvedValueOnce(readMissTurn(4, R4, 2))    // 03:19:44Z — mismatches 4+5 in one batch ⇒ TRIP (the 03:19:51.644Z row)
      .mockResolvedValueOnce(alignedTurn(6))            // ban round: read_file absent from the schema
      .mockResolvedValue(FINAL);
    const input = makeInput(BRIEF, { ...CODING_TEST_PROFILE, maxSteps: 12 });
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Re-review re-verification complete.');
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');

    // ── Containment fired DESPITE every mismatch being discount-eligible ──
    // (the measure-first invariant: the 58e675c9 probe measures, never weakens).
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run)');
    // The arm-time named intent is grep — STABLE, not rotated.
    expect(steer).toContain('your own reasoning named grep');
    expect(steer).toContain('call grep NOW');
    // The steer tells the TRUTH about the SUCCESS shape (reviewer F1 of 2c98b460).
    expect(steer).toContain('it SUCCEEDED');
    expect(steer).not.toContain('and it failed');
    expect(reanchorMetrics()).toHaveLength(1);
    // churned FALSE — this incident's signature (ee39f231 pinned the true twin).
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'read_file', intended: 'grep', reason: 'intent_mismatch_success', churned: false });

    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({ tool: 'read_file', perma: false, intended: 'grep', churned: false });
    expect(breakerMetrics()).toHaveLength(1); // one-round withhold only — no perma, no run-end

    // ── The measurement was LOUD on exactly the incident's six rows ──
    const discounts = discountMetrics();
    expect(discounts).toHaveLength(6);
    const rf = discounts.filter((m) => m.meta.tool === 'read_file');
    expect(rf).toHaveLength(5);
    expect(rf.map((m) => m.meta.intended)).toEqual(['grep', 'grep', 'grep', 'grep', 'grep']);
    expect(rf.map((m) => m.meta.streak)).toEqual([1, 2, 3, 4, 5]);
    expect(rf.every((m) => m.meta.reason === 'preamble_ordered' && m.meta.marker === 'read_file')).toBe(true);
    // The precursor mismatch on ANOTHER called tool logged its own row (marker
    // = the called tool the standing orders name) — and fed no streak: the
    // per-tool key isolation held (the steer fired only at read_file's third,
    // never before).
    expect(discounts.filter((m) => m.meta.tool === 'get_fleet_telemetry')).toHaveLength(1);

    // ── Truthful notice + byte-exact attribution (the filed ticket text) ──
    expect(userTexts().some((t) => t.includes('Your last 5 calls of read_file all SUCCEEDED') && t.includes('temporarily removed from your tool list for the next round'))).toBe(true);
    expect(userTexts().some((t) => t.includes('ALL FAILED'))).toBe(false);
    expect(mockFileStreakInvestigation).toHaveBeenCalled();
    const evidenceText = String(mockFileStreakInvestigation.mock.calls[0][0].recentFailures[0]);
    // The NON-CHURN template (agent.ts:3753) — byte-exact the ticket's quoted
    // text; ee39f231 pinned the churned sibling branch.
    expect(evidenceText).toContain("read_file kept SUCCEEDING while the run's own reasoning named grep");
    expect(evidenceText).toContain('(read_file→grep ×5 consecutive, ticket 2c98b460)');

    // ── The withhold lasts EXACTLY one model round ──
    expect(offeredAtCall(5).has('read_file')).toBe(false);
    expect(offeredAtCall(6).has('read_file')).toBe(true);
  });

});

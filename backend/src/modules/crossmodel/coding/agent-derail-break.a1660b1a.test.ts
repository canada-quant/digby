/**
 * REPLAY TEST — ticket a1660b1a (mishap, 2026-09-22): "3× tool-failure
 * streak: read_file on 'Framework Operator Audit and Repair' — framework
 * or model?" Auto-filed at the breaker trip (owner doctrine 2026-09-10).
 *
 * THE WILD INSTANCE (session 5f90c628-d3f7-4187-8378-ed9d2ec08ee8, run
 * 0555f6cd-ae0d-4c36-8f54-d6d69f904222, glm-5.3, coding profile, scheduled
 * trigger): the Framework Operator's firing-4 code audit declared shell
 * intent — "Proceeding with the code audit via run_command (the tool my
 * reasoning names): dumping the exact regions needed to design the fix…" —
 * then emitted read_file line-ranged region reads, FIVE consecutive, every
 * one SUCCEEDING (read_file is the right tool for a line-ranged region
 * read; only the narration word was wrong). Fleet telemetry this incident:
 * guard_strike seam 'tool_derail_reanchor' 2026-09-22T15:48:13.986Z
 * (reason 'intent_mismatch_success', intended 'run_command', churned:false)
 * → guard_strike seam 'tool_derail_break' 15:52:57.452Z (shape
 * 'success_intent', perma:false) → the auto-file at 15:52:53.976Z whose
 * failure text byte-matches the agent.ts success-shape template. The lane
 * recovered after the one-round withhold and finished its cycle.
 *
 * ADJUDICATION (lane b92ef13f, 2026-09-22): MODEL-SIDE — no deterministic
 * framework/schema/preflight/guard defect caused the streak. The guard
 * behaved exactly as designed at every rung: the steer at 3 told the TRUTH
 * about the success shape ("it SUCCEEDED", never "and it failed" —
 * reviewer F1 of 2c98b460), the trip at 5 withheld read_file for exactly
 * one round (not perma — first trip), and the attribution payload carried
 * the incident template verbatim. The 58e675c9 measure-first intent-
 * discount (merged 28d8920e, fleet-live ~15:10Z, BEFORE the 15:48Z steer)
 * changes NO behavior by design and neither of its heuristics matches this
 * shape anyway: the narration is an AFFIRMATIVE first-person intent
 * declaration, not a pre-computed-duty citation ([FLEET LIVENESS] absent,
 * run_command not in the pre-computed list) and not a preamble-ordered
 * batch (the operator wake never whole-word-names read_file). glm-5.3's
 * narration/call drift under shell-flavored task framing is the documented
 * 2c98b460 model-side class.
 *
 * THIS PIN replays the incident's exact shape against the REAL agent loop
 * and asserts the guard stays correct — and stays FIRING — on affirmative
 * intent declarations, so a future tuning pass never blanket-discounts
 * them: steer-at-3 truthful, trip-at-5 proportionate (one-round withhold,
 * success_intent metric, incident-template attribution text), the 58e675c9
 * measurement silent (zero discount rows), and the schema withhold lasting
 * exactly one model round.
 *
 * Scaffold mirrors agent-derail-break.58e675c9.test.ts: every mismatched
 * call SUCCEEDS ('probe result: ok'), read_file args vary by LETTER-
 * skeleton path (never a digit-only delta) so the exact (:3728) and digit-
 * collapsed (:3738) repeat signatures stay blind, the per-turn reasoning
 * word-varies (the 03587322 repeated-line leg needs an IDENTICAL line),
 * and no run_command call ever appears (the scaffold's container mock
 * would leak to a real shell) — run_command is only ever NAMED, which the
 * coding profile's offered set makes convictable.
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

/** CODING profile (no workspace container in the scaffold). read_file and
 *  run_command are BOTH in the coding schema set regardless of
 *  workspaceTools (agent.ts:1010-1017) — so the narration can convict
 *  run_command while read_file is called, exactly the incident shape. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

/** The firing-4 wake, verbatim from the incident transcript (msg c9198109):
 *  no [FLEET LIVENESS] pre-computed block, and the CALLED tool (read_file)
 *  is never whole-word-named — neither 58e675c9 heuristic can absorb a
 *  mismatch declared under this wake. */
const OPERATOR_WAKE = [
  '[FRAMEWORK OPERATOR — 4-hour run] Read docs/FRAMEWORK_OPERATOR.md in this repo and execute the full checklist now:',
  'audit live state through scripts/framework-audit/run-on-box.sh (since = now minus 4 hours), audit the implicated',
  'framework code, FIX every real defect (tests, kill switch, metric, one commit with AGENTS.md + memory-bank, push to',
  'main by ancestry), verify in production after the deploy wave, enhance once when nothing is broken, then end with',
  'the standalone recap (found / fixed / verified / next) and send a 5-line delta to the Fleet Supervisor.',
].join('\n');

const makeInput = (userMessage: string = OPERATOR_WAKE, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-a1660b1a-test',
  sessionId: 'sess-a1660b1a',
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

/** The a1660b1a shape: read_file SUCCEEDS while the turn's own reasoning
 *  AFFIRMATIVELY names run_command — the incident's verbatim preamble
 *  ("Proceeding with the code audit via run_command (the tool my reasoning
 *  names): dumping the exact regions needed to design the fix"), word-
 *  varied per turn across the five regions the lane dumped so the
 *  03587322 repeated-line leg stays blind. read_file paths vary by
 *  LETTER-skeleton word (never a digit-only delta) so the exact (:3728)
 *  and digit-collapsed (:3738) repeat signatures stay blind. */
const REGIONS = ['claims-block call sites', 'origin-truth helper', 'metric registry', 'kill-switch idiom', 'prose-side receipt matcher'];
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
const readMissTurn = (n: number) => ({
  content: '',
  reasoning: `Proceeding with the code audit via run_command (the tool my reasoning names): dumping the ${REGIONS[(n - 1) % REGIONS.length]} region needed to design the fix.`,
  toolCalls: [{ id: `t${n}`, name: 'read_file', arguments: JSON.stringify({ path: `backend/src/modules/crossmodel/coding/${WORDS[(n - 1) % WORDS.length]}-lane.ts`, start_line: 100, end_line: 160 }) }],
  finishReason: 'tool_calls',
});
/** An ALIGNED success for the ban-round probe: narration names the called
 *  tool. list_files — never run_command (see header). */
const alignedTurn = (n: number) => ({
  content: '',
  reasoning: 'Now list_files to check which generated documents exist before editing.',
  toolCalls: [{ id: `t${n}`, name: 'list_files', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Code audit complete.', reasoning: '', toolCalls: [], finishReason: 'stop' };

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

describe('ticket a1660b1a — read_file→run_command SUCCESS-side derail: true-positive guard, model-side cause', () => {
  it('UNIT: the incident premise — successes are invisible to the failure detector, the incident narration convicts run_command, and NO 58e675c9 discount absorbs the shape', () => {
    expect(looksLikeToolFailure('probe result: ok')).toBe(false);
    const offered = ['run_command', 'read_file', 'grep', 'list_files', 'update_plan'];
    expect(detectIntendedTool(readMissTurn(1).reasoning, 'read_file', offered)).toBe('run_command');
    expect(detectIntendedTool(readMissTurn(4).reasoning, 'read_file', offered)).toBe('run_command');
    // Faithful narration acquits; a too-short text acquits.
    expect(detectIntendedTool('Now read_file to read the region at lines 100-160.', 'read_file', offered)).toBeNull();
    expect(detectIntendedTool('ok', 'read_file', offered)).toBeNull();
    // The 58e675c9 measurement stays SILENT on this shape: the operator wake
    // carries no [FLEET LIVENESS] pre-computed block and never whole-word-
    // names the CALLED read_file — an affirmative first-person declaration
    // is the guard's target shape, not a discount candidate.
    expect(intentMismatchDiscount('run_command', 'read_file', OPERATOR_WAKE)).toBeNull();
  });

  it('REPLAY steer-at-3: three consecutive mismatched read_file SUCCESSES inject exactly ONE truthful re-anchor ("it SUCCEEDED") — no breaker, no discount rows', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(readMissTurn(1))
      .mockResolvedValueOnce(readMissTurn(2))
      .mockResolvedValueOnce(readMissTurn(3)) // THIRD mismatch ⇒ steer arms
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Code audit complete.');
    expect(result.modelErrored).toBeUndefined();
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run)');
    expect(steer).toContain('your own reasoning named run_command');
    expect(steer).toContain('call run_command NOW');
    // The steer tells the TRUTH about the SUCCESS shape (reviewer F1 of
    // 2c98b460): it must never claim the calls "failed" when they succeeded.
    expect(steer).toContain('it SUCCEEDED');
    expect(steer).not.toContain('and it failed');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'read_file', intended: 'run_command', reason: 'intent_mismatch_success', churned: false });
    // The breaker NEVER engaged below the trip threshold; the measurement
    // correctly logged NOTHING (no discount fits an affirmative declaration).
    expect(breakerMetrics()).toHaveLength(0);
    expect(discountMetrics()).toHaveLength(0);
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
  });

  it('REPLAY trip-at-5 (the incident): the FIFTH consecutive mismatched read_file success trips into a ONE-ROUND withhold — truthful notice, incident-template attribution, schema ban exactly one round, run continues', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(readMissTurn(1))
      .mockResolvedValueOnce(readMissTurn(2))
      .mockResolvedValueOnce(readMissTurn(3)) // steer (the 15:48:13Z re-anchor row)
      .mockResolvedValueOnce(readMissTurn(4))
      .mockResolvedValueOnce(readMissTurn(5)) // TRIP (the 15:52:57Z break row + auto-file)
      .mockResolvedValueOnce(alignedTurn(6)) // ban round: read_file absent from the schema
      .mockResolvedValue(FINAL);             // the round after: read_file returns
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Code audit complete.');
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');
    expect(reanchorMetrics()).toHaveLength(1); // the steer still fired at the third
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({ tool: 'read_file', perma: false, intended: 'run_command', churned: false });
    expect(breakerMetrics()).toHaveLength(1); // one-round withhold only — no perma, no run-end
    // The deferred notice tells the truth about the SUCCESS shape (never
    // "ALL FAILED") and names the intended tool via the standard hint.
    expect(userTexts().some((t) => t.includes('Your last 5 calls of read_file all SUCCEEDED') && t.includes('temporarily removed from your tool list for the next round') && t.includes('Your own reasoning named run_command'))).toBe(true);
    expect(userTexts().some((t) => t.includes('ALL FAILED'))).toBe(false);
    // …and the success-shape evidence rides the attribution payload VERBATIM
    // — byte-exact the line the a1660b1a auto-file carried (agent.ts:3672).
    expect(mockFileStreakInvestigation).toHaveBeenCalled();
    const evidenceText = String(mockFileStreakInvestigation.mock.calls[0][0].recentFailures[0]);
    expect(evidenceText).toContain("read_file kept SUCCEEDING while the run's own reasoning named run_command");
    expect(evidenceText).toContain('(read_file→run_command ×5 consecutive, ticket 2c98b460)');
    // The withhold lasts EXACTLY one model round: the turn after the trip is
    // offered a schema WITHOUT read_file; the round after has it back.
    expect(offeredAtCall(5).has('read_file')).toBe(false);
    expect(offeredAtCall(6).has('read_file')).toBe(true);
    // The measurement stayed silent — an affirmative first-person intent
    // declaration is NEVER a discount candidate.
    expect(discountMetrics()).toHaveLength(0);
  });

});

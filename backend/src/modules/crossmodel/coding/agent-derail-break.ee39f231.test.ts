/**
 * REPLAY TEST — ticket ee39f231 (mishap, 2026-09-22): "3× tool-failure
 * streak: read_file on 'Ticket Content Investigation Report' — framework
 * or model?" Auto-filed at the breaker trip (owner doctrine 2026-09-10).
 *
 * THE WILD INSTANCE (session 49c0fbbf-2ab5-4e36-9aaf-5dd92fa5fe42, run
 * 43a1115f-1d95-4034-9137-2dc496d27cba, glm-5.3/zai, coding profile,
 * machine trigger — an engineering lane adjudicating its own dispatched
 * ticket batch): the lane's reasoning quoted and analyzed TICKET CONTENT
 * that whole-word-names other tools (its sibling ticket is about a
 * web_pipe-narration derail) while it correctly emitted read_file region
 * reads on source files — FIVE consecutive mismatches, every call
 * SUCCEEDING, the named intent rotating (web_pipe, web_pipe, grep, then
 * web_pipe again on the final two-call batch). Fleet telemetry this
 * incident (pulled 2026-09-22 ~22:35Z): guard_miss seam
 * 'tool_intent_attribution' ×7, ALL reason 'preamble_ordered' (markers
 * get_fleet_telemetry, grep, then read_file ×5 — the standing orders
 * whole-word-name the CALLED tool, the 58e675c9 discount class) →
 * guard_strike 'tool_derail_reanchor' 22:30:10.208Z (reason
 * 'intent_mismatch_success', intended 'grep', churned:true) → guard_strike
 * 'tool_derail_break' 22:31:50.109Z (shape 'success_intent', perma:false,
 * intended 'web_pipe', churned:true) → the auto-file whose failure text
 * byte-matches the agent.ts churn template. The lane recovered after the
 * one-round withhold and kept working its plan.
 *
 * ADJUDICATION (lane 43f23a07, 2026-09-22): MODEL-SIDE — no deterministic
 * framework/schema/preflight/guard defect caused the streak. Every rung
 * behaved per design: the c737d007 pair-agnostic re-key (e3417bf98, merged
 * 13:52Z — hours BEFORE the 22:26Z first mismatch) counted the churn the
 * legacy pair key would have self-erased (this is the FIRST wild
 * churned:true catch, the datum the c737d007 telemetry was armed to
 * collect); the steer at 3 told the TRUTH about the success shape; the
 * trip at 5 withheld read_file exactly one round (perma:false, first
 * trip); the filed text is byte-exact the :3733 churn template. The
 * conviction signal was narration-side noise — glm-5.3 quoting tool names
 * out of the ticket under analysis — and the 58e675c9 measure probe
 * classified ALL SEVEN mismatches as discount-eligible (preamble_ordered)
 * while containment fired anyway: MEASURE-FIRST working as designed
 * (measurement loud, detector unchanged, per the 58e675c9 doctrine —
 * weaken nothing before the wild rate is known). Diffing the failure text
 * against recent framework changes shows no drift; the kimi-k3 cause-fix
 * (ed5c4979, 22:34:42Z) postdates the trip and targets a different model's
 * decoder slips. The auto-file TITLE mislabel ("3× tool-failure streak"
 * over an all-success trip) is the reflection.ts:113 fixed-text defect
 * owned by sibling ticket d73765fc — deliberately NOT bundled here (one
 * concern per PR).
 *
 * THIS PIN replays the incident's exact shape against the REAL agent loop
 * and asserts the MEASURE-FIRST INVARIANT — the axis neither precedent
 * pinned: a1660b1a (same called tool, affirmative run_command declaration)
 * asserted the probe stays SILENT (zero discount rows); c737d007 pinned the
 * churn mechanics with a wake that names nothing. This incident is the
 * inverse: the wake whole-word-names the CALLED read_file (doctrine lines
 * in the standing orders), so EVERY mismatch is discount-ELIGIBLE — and
 * the guard must STILL steer at 3 and trip at 5, with the churn telemetry
 * and the byte-exact filed text, so a future tuning pass can never point
 * at these rows as noise the guard should have ignored. Also pinned: the
 * per-tool key isolation (the two precursor mismatches on OTHER called
 * tools neither feed nor reset the read_file streak) and the one-round
 * schema withhold.
 *
 * Scaffold mirrors agent-derail-break.a1660b1a.test.ts: every mismatched
 * call SUCCEEDS ('probe result: ok'), read_file args vary by LETTER-
 * skeleton path (never a digit-only delta) so the exact and digit-collapsed
 * repeat signatures stay blind, the per-turn reasoning word-varies (the
 * 03587322 repeated-line leg needs an IDENTICAL line), and no run_command
 * call ever appears (the scaffold's container mock would leak to a real
 * shell). Each narration names exactly ONE offered tool as a whole word
 * and never the called tool — an unoffered named tool makes
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

/** The incident wake, faithful to its haystack (the ticket-batch dispatch
 *  brief + the standing doctrine lines the lane ran under): unlike
 *  a1660b1a's operator wake, THIS one whole-word-names the CALLED read_file
 *  (and grep, and get_fleet_telemetry) — which is exactly why every
 *  mismatch in the incident was discount-ELIGIBLE (preamble_ordered). */
const BRIEF = [
  '[TICKET BATCH DISPATCH — 1 open feedback ticket, owner-ordered burn-down]',
  'Investigate the filed mishap before touching code. Standing doctrine for the audit:',
  '- identifier or file; grep/glob find exact symbols; list_dir/read_file to read. Never edit a file you have not read this session.',
  '- get_fleet_telemetry',
  '- Prefer edit_file (targeted, exact-match edits) over rewriting a whole file with write_file.',
  'Adjudicate framework vs model with primary sources, then report with artifact ids.',
].join('\n');

const makeInput = (userMessage: string = BRIEF, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-ee39f231-test',
  sessionId: 'sess-ee39f231',
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

/** The incident narrations: analytic prose ABOUT the filed ticket (which
 *  quotes tool names) while read_file correctly executes — each names
 *  exactly ONE offered tool as a whole word and NEVER the called read_file.
 *  The named intent rotates web_pipe → web_pipe → grep → web_pipe, the
 *  churn the c737d007 re-key exists to count. */
const P_BATCH = 'Establish the timeline first: the filed text says the incident lane kept narrating web_pipe while its executor lockstep ran elsewhere — check that against telemetry before trusting the ticket.';
const R_WP1 = 'The ticket quotes the failure text verbatim: the lane meant web_pipe while the streak formed — adjudicate whether any framework change could deterministically cause that.';
const R_WP2 = 'Second angle on the filed claim: the narration drift toward web_pipe is the documented model-side class unless the rollout timeline says otherwise.';
const R_GREP = 'Third angle: the guard source region grep would surface pins the churn ladder this ticket cites — confirm the pair-agnostic re-key landed before the incident.';
const R_WP3 = 'Closing the adjudication: the filed evidence names web_pipe as the latest named intent under churn — record the verdict with the telemetry rows as proof.';

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
/** The incident's two PRECURSOR mismatches (22:25:40/41Z): other called
 *  tools succeeding under web_pipe-naming narration — they must neither
 *  feed nor reset the read_file streak (per-tool key isolation). */
const precursorTurn = {
  content: '',
  reasoning: P_BATCH,
  toolCalls: [
    { id: 'p1', name: 'get_fleet_telemetry', arguments: JSON.stringify({ view: 'metrics', kind: 'guard_strike', hours: 24 }) },
    { id: 'p2', name: 'grep', arguments: JSON.stringify({ pattern: 'tool_derail', path: 'backend/src' }) },
  ],
  finishReason: 'tool_calls' as const,
};
/** An ALIGNED success for the ban-round probe: narration names the called
 *  tool. list_files — never run_command (see header). */
const alignedTurn = (n: number) => ({
  content: '',
  reasoning: 'Now list_files to check which generated documents exist before writing the verdict.',
  toolCalls: [{ id: `t${n}`, name: 'list_files', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls' as const,
});
const FINAL = { content: 'Ticket review complete.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

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

describe('ticket ee39f231 — read_file churn derail under a discount-eligible wake: measure-first invariant (model-side)', () => {
  it('UNIT: the incident premise — successes are invisible to the failure detector, each narration convicts its named tool, and the 58e675c9 discount FIRES on this wake (the a1660b1a inverse)', () => {
    expect(looksLikeToolFailure('probe result: ok')).toBe(false);
    const offered = ['read_file', 'grep', 'web_pipe', 'list_files', 'get_fleet_telemetry', 'search_code_semantic', 'list_dir', 'run_command'];
    expect(detectIntendedTool(P_BATCH, 'get_fleet_telemetry', offered)).toBe('web_pipe');
    expect(detectIntendedTool(P_BATCH, 'grep', offered)).toBe('web_pipe');
    expect(detectIntendedTool(R_WP1, 'read_file', offered)).toBe('web_pipe');
    expect(detectIntendedTool(R_WP2, 'read_file', offered)).toBe('web_pipe');
    expect(detectIntendedTool(R_GREP, 'read_file', offered)).toBe('grep');
    expect(detectIntendedTool(R_WP3, 'read_file', offered)).toBe('web_pipe');
    // Faithful narration acquits.
    expect(detectIntendedTool(alignedTurn(6).reasoning, 'list_files', offered)).toBeNull();
    // THE DISTINGUISHING AXIS: the incident's standing orders whole-word-name
    // the CALLED read_file (doctrine + preference lines), so every mismatch
    // here is discount-ELIGIBLE (preamble_ordered) — a1660b1a's wake named
    // nothing and its probe stayed silent. Measurement changes NOTHING; the
    // replay below proves containment fired anyway.
    expect(intentMismatchDiscount('web_pipe', 'read_file', BRIEF)).toMatchObject({ reason: 'preamble_ordered', marker: 'read_file' });
    expect(intentMismatchDiscount('grep', 'read_file', BRIEF)).toMatchObject({ reason: 'preamble_ordered', marker: 'read_file' });
    expect(intentMismatchDiscount('web_pipe', 'get_fleet_telemetry', BRIEF)).toMatchObject({ reason: 'preamble_ordered', marker: 'get_fleet_telemetry' });
  });

  it('REPLAY the incident (trip-at-5 under churn, measure LOUD): steer at the third read_file mismatch (intended grep, churned:true), trip at the fifth (intended web_pipe, churned:true), ALL 7 mismatches discount-eligible — and containment UNCHANGED', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(precursorTurn)             // 22:25:40/41Z — precursor mismatches (other called tools)
      .mockResolvedValueOnce(readMissTurn(1, R_WP1))    // 22:26:55Z — read_file mismatch 1
      .mockResolvedValueOnce(readMissTurn(2, R_WP2))    // 22:28:24Z — mismatch 2
      .mockResolvedValueOnce(readMissTurn(3, R_GREP))   // 22:30:09Z — mismatch 3 ⇒ STEER (the 22:30:10.208Z row)
      .mockResolvedValueOnce(readMissTurn(4, R_WP3, 2)) // 22:31:45.958/.968Z — mismatches 4+5 in one batch ⇒ TRIP (the 22:31:50.109Z row)
      .mockResolvedValueOnce(alignedTurn(6))            // ban round: read_file absent from the schema
      .mockResolvedValue(FINAL);
    const input = makeInput(BRIEF, { ...CODING_TEST_PROFILE, maxSteps: 12 });
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Ticket review complete.');
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');

    // ── Containment fired DESPITE every mismatch being discount-eligible ──
    // (the measure-first invariant: the 58e675c9 probe measures, never weakens).
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run)');
    // The arm-time named intent is the THIRD mismatch's (the 22:30:10Z row's intended: grep).
    expect(steer).toContain('your own reasoning named grep');
    expect(steer).toContain('call grep NOW');
    // The steer tells the TRUTH about the SUCCESS shape (reviewer F1 of 2c98b460).
    expect(steer).toContain('it SUCCEEDED');
    expect(steer).not.toContain('and it failed');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'read_file', intended: 'grep', reason: 'intent_mismatch_success', churned: true });

    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({ tool: 'read_file', perma: false, intended: 'web_pipe', churned: true });
    expect(breakerMetrics()).toHaveLength(1); // one-round withhold only — no perma, no run-end

    // ── The measurement was LOUD on exactly the incident's seven rows ──
    const discounts = discountMetrics();
    expect(discounts).toHaveLength(7);
    const rf = discounts.filter((m) => m.meta.tool === 'read_file');
    expect(rf).toHaveLength(5);
    expect(rf.map((m) => m.meta.intended)).toEqual(['web_pipe', 'web_pipe', 'grep', 'web_pipe', 'web_pipe']);
    expect(rf.map((m) => m.meta.streak)).toEqual([1, 2, 3, 4, 5]);
    expect(rf.every((m) => m.meta.reason === 'preamble_ordered' && m.meta.marker === 'read_file')).toBe(true);
    // The two precursor mismatches on OTHER called tools each logged their own
    // row (marker = the called tool the standing orders name) — and fed no
    // streak: the per-tool key isolation held (the steer fired only at
    // read_file's third, never before).
    expect(discounts.filter((m) => m.meta.tool === 'get_fleet_telemetry')).toHaveLength(1);
    expect(discounts.filter((m) => m.meta.tool === 'grep')).toHaveLength(1);

    // ── Truthful notice + byte-exact attribution (the filed ticket text) ──
    expect(userTexts().some((t) => t.includes('Your last 5 calls of read_file all SUCCEEDED') && t.includes('temporarily removed from your tool list for the next round'))).toBe(true);
    expect(userTexts().some((t) => t.includes('ALL FAILED'))).toBe(false);
    expect(mockFileStreakInvestigation).toHaveBeenCalled();
    const evidenceText = String(mockFileStreakInvestigation.mock.calls[0][0].recentFailures[0]);
    expect(evidenceText).toContain("read_file kept SUCCEEDING while the run's own reasoning named a rotating set of OTHER tools (latest: web_pipe)");
    expect(evidenceText).toContain('(read_file ×5 consecutive, named intent churned, tickets 2c98b460+c737d007)');

    // ── The withhold lasts EXACTLY one model round ──
    expect(offeredAtCall(5).has('read_file')).toBe(false);
    expect(offeredAtCall(6).has('read_file')).toBe(true);
  });

});

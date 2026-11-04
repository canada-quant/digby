/**
 * REPLAY TEST — ticket 58e675c9 (enhancement, 2026-09-22): "Intent-
 * attribution false positive: narration naming a pre-computed/already-
 * answered duty convicts preamble-ordered call batches". Shortfall-hunt
 * cycle 2, Finding 2 (MAST FM-3.3/FM-2.6).
 *
 * THE WILD INSTANCE (ticket 92b485bd, adjudicated + closed done 2026-09-22):
 * Fleet Supervisor lane c0e22e36 emitted schedule_get ×5 — ORDERED work from
 * the standing sweep preamble's schedule-drift check (the supervisor
 * preamble literally names schedule_get: "MACHINE-WRITTEN SCHEDULE PROMPTS —
 * schedule_get each and confirm the cadence…") — while its reasoning named
 * get_chat_status, a duty whose answer set is pre-computed in every
 * supervisor wake's [FLEET LIVENESS] block (supervisor-state.service.ts:903;
 * its render note at :1063 says the fleet [FLEET LIVENESS] table already
 * carries the per-schedule cadence the drift checklist would otherwise
 * schedule_get). All five calls SUCCEEDED. The 2c98b460 success-side guard keyed on
 * the mention: steer at 3, trip at 5. Adjudication: NO deterministic
 * framework defect — the guard acted correctly on noisy evidence.
 *
 * THE TICKET'S PROPOSAL (verbatim): "intent attribution should (a) discount
 * narration referencing a duty whose result is injected pre-computed in the
 * wake (a small per-profile pre-computed-tool list, e.g. get_chat_status on
 * supervisor wakes), and/or (b) down-weight mismatches when the called batch
 * matches the schedule preamble's ordered checklist. MEASURE FIRST: log the
 * would-be-discounted mismatches as a guard_miss-adjacent telemetry shape
 * for one cycle before changing the detector."
 *
 * THE FIX (this pin) — the measure-first cycle, NOTHING ELSE:
 *   · tool-preflight.ts gains wakePromptHaystack (the run's STANDING ORDERS:
 *     system + user text, excluding tool results and the harness's own
 *     [HARNESS NOTICE] messages) and intentMismatchDiscount (the two
 *     proposed heuristics: precomputed_duty — [FLEET LIVENESS pre-computes
 *     get_chat_status; preamble_ordered — the CALLED tool is whole-word-
 *     named in the standing orders, the matched line riding the telemetry).
 *   · agent.ts's success-side branch logs each mismatch a discount WOULD
 *     absorb as kind=guard_miss meta.seam='tool_intent_attribution'
 *     (the 13b2f286 seam idiom) with tool/intended/reason/marker/line/
 *     streak. Bounded at 12 rows per run. (Its LOG kill switch was deleted
 *     with RSW-1 cluster 32 — the bound is now the only suppressor.)
 *   · BEHAVIOR IS UNCHANGED: the streak, the steer-at-3 re-anchor and the
 *     trip-at-5 ladder fire exactly as before — these suites pin that the
 *     measurement never weakens the containment it measures.
 *
 * ⚠ SUPERSEDED 2026-09-24 (ticket 0625bf62): the measurement cycle ANSWERED
 *   — the adjudicated ordered-batch class was 100% false positive (92b485bd
 *   schedule_get 5/5; canlegal-bench 615723ba archive_chat 9/9, streaks 1→5
 *   twice, 43 archive receipts, correct run outcome) — so the discount is
 *   now ARMED in agent.ts's success-side leg for PLATFORM TOOLS ONLY (the
 *   same fleet-wide measurement showed the haystack matching GENERIC CODING
 *   DOCTRINE — a live preamble_ordered row on e083ff2e, the founding
 *   2c98b460 lane — so arming coding tools would reopen the founding
 *   derail cluster). Per-tool runaway ceiling
 *   DERAIL_INTENT_DISCOUNT_CAP (default 25). The suites below are
 *   updated to the ARMED semantics for the platform-tool replays; the
 *   UNIT probes (wakePromptHaystack / intentMismatchDiscount contracts) and
 *   the coding-tool replays (update_plan) still pin the ORIGINAL contracts
 *   unchanged. Full armed-coverage: agent-derail-break.0625bf62.test.ts.
 *
 * Scaffold mirrors agent-derail-break.2c98b460.test.ts: every mismatched
 * call SUCCEEDS ('probe result: ok'), args vary by LETTER-skeleton (never a
 * digit-only delta) so the exact (:3728) and digit-collapsed (:3738) repeat
 * signatures stay blind, and no run_command call ever appears (the
 * scaffold's container mock would leak to a real shell).
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
import { detectIntendedTool, intentMismatchDiscount, wakePromptHaystack } from './tool-preflight';

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

/** The 92b485bd wake: the [FLEET LIVENESS] block pre-computes the
 *  get_chat_status answer set, and the standing sweep preamble's drift
 *  checklist names schedule_get verbatim (supervisor-state.service.ts). */
const SUPERVISOR_WAKE = [
  '[SUPERVISOR STATE] …standing sweep…',
  '[FLEET LIVENESS — per-project machine heartbeat, computed this wake (enabled schedules · last firing age · live runs):]',
  'crossmodel: 3 enabled (next 14:00Z, runs 41/500) · last firing 12 min ago · 1 live run',
  '',
  'Standing sweep:',
  "5. check schedule health via get_chat_status's schedules field — a project whose cadence stopped or is overdue needs a nudge.",
  "MACHINE-WRITTEN SCHEDULE PROMPTS — schedule_get each and confirm the cadence still matches the owner's intent (watch-mode drift check; prompts carry no updated-at, so rewrites of older rows hide here too).",
].join('\n');

/** A plain ticket-dispatch wake: no pre-computed block, and the called tool
 *  is never named — the negative leg. */
const PLAIN_WAKE = 'TICKET DISPATCH — investigate the report, implement the fix, open a PR.';

const makeInput = (userMessage: string = SUPERVISOR_WAKE, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-58e675c9-test',
  sessionId: 'sess-58e675c9',
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

/** The 92b485bd shape: schedule_get SUCCEEDS while the turn's own reasoning
 *  names get_chat_status (the pre-computed liveness duty). Ids are 8-hex
 *  (the citation shape — preflight-grounded) and vary by LETTER skeleton so
 *  neither the exact nor the digit-collapsed repeat signature can see a
 *  loop. */
const SCHED_IDS = ['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6', 'd4e5f6a7', 'e5f6a7b8', 'f6a7b8c9', 'a8b9c1d2', 'b9c1d2e3', 'c1d2e3f4', 'd2e3f4a5', 'e3f4a5b6', 'f4a5b6c7', 'a5b6c7d8'];
const SCHED_MISS_REASONING = 'Now get_chat_status to confirm the fleet heartbeat table before reconciling the drift checklist.';
const schedMissTurn = (n: number) => ({
  content: '',
  reasoning: SCHED_MISS_REASONING,
  toolCalls: [{ id: `t${n}`, name: 'schedule_get', arguments: JSON.stringify({ id: SCHED_IDS[(n - 1) % SCHED_IDS.length] }) }],
  finishReason: 'tool_calls',
});
/** The update_plan variant for the preamble_ordered leg: the wake's
 *  checklist names update_plan; the reasoning names get_chat_messages (NOT
 *  a pre-computed tool — isolates proposal (b)). Args vary by WORD. */
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike'];
const PLAN_MISS_REASONING = 'Now get_chat_messages to re-read the dispatcher thread before the next steer goes out.';
const planMissTurn = (n: number) => ({
  content: '',
  reasoning: PLAN_MISS_REASONING,
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: `${WORDS[(n - 1) % WORDS.length]} reconciliation pass`, status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
/** An ALIGNED success: narration names the called tool (the streak reset).
 *  list_files — never run_command (see header). */
const alignedTurn = (n: number) => ({
  content: '',
  reasoning: 'Now list_files to check which generated documents exist before editing.',
  toolCalls: [{ id: `t${n}`, name: 'list_files', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Sweep done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const discountMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'guard_miss' && m?.meta?.seam === 'tool_intent_attribution');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');
const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
/** runModelTurn receives the ONE shared messages array by reference — at
 *  assertion time it holds the full conversation; count steers/notices there. */
const conversation = () => mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }>;
const steerMessages = () => (conversation() || []).filter(
  (m) => m?.role === 'user' && typeof m.content === 'string' && m.content.includes('RE-ANCHOR (one per run)'),
);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 58e675c9 — measure-first intent-attribution discount probe', () => {
  it('UNIT wakePromptHaystack: system + user text only — tool results and the harness\'s own [HARNESS NOTICE] steers are excluded', () => {
    const hay = wakePromptHaystack([
      { role: 'system', content: 'doctrine names schedule_get in a checklist' },
      { role: 'user', content: 'wake preamble orders schedule_get drift checks' },
      { role: 'assistant', content: 'assistant words name schedule_get but never count' },
      { role: 'tool', content: 'tool result echoes schedule_get but never counts' },
      { role: 'user', content: '[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run): You called schedule_get …' },
      { role: 'user', content: [{ type: 'text', text: 'array-part user text names update_plan' }] },
    ]);
    expect(hay).toContain('doctrine names schedule_get');
    expect(hay).toContain('wake preamble orders schedule_get');
    expect(hay).toContain('array-part user text names update_plan');
    expect(hay).not.toContain('assistant words');
    expect(hay).not.toContain('tool result echoes');
    expect(hay).not.toContain('RE-ANCHOR');
  });

  it('UNIT intentMismatchDiscount: (a) precomputed_duty fires on the 92b485bd shape and wins precedence; (b) preamble_ordered fires with the matched line; whole-word only', () => {
    // (a) the wild instance: [FLEET LIVENESS present + get_chat_status named.
    const pre = intentMismatchDiscount('get_chat_status', 'schedule_get', SUPERVISOR_WAKE);
    expect(pre).toEqual({ reason: 'precomputed_duty', marker: '[FLEET LIVENESS — per-project machine heartbeat', line: '' });
    // (a) requires BOTH the marker and a listed tool: schedule_get as the
    // "intended" tool is not pre-computed (it is the ordered one) — but the
    // wake names the CALLED schedule_get, so (b) fires instead.
    const ordered = intentMismatchDiscount('update_supervisor_state', 'schedule_get', SUPERVISOR_WAKE);
    expect(ordered?.reason).toBe('preamble_ordered');
    expect(ordered?.marker).toBe('schedule_get');
    expect(ordered?.line).toContain('schedule_get each and confirm the cadence');
    // (b) whole-word: a substring of a longer token never convicts.
    expect(intentMismatchDiscount('get_chat_messages', 'schedule_get', 'the schedule_getting helper ran')).toBeNull();
    // No discount on a plain wake; null on empty text.
    expect(intentMismatchDiscount('get_chat_status', 'schedule_get', PLAIN_WAKE)).toBeNull();
    expect(intentMismatchDiscount('get_chat_status', 'schedule_get', '')).toBeNull();
    // The pre-computed list is specific: get_chat_messages is NOT in it.
    expect(intentMismatchDiscount('get_chat_messages', 'schedule_get', SUPERVISOR_WAKE)?.reason).toBe('preamble_ordered');
  });

  it('UNIT intentMismatchDiscount markers: the owner-briefing render matches, the bare doctrine mention does NOT, and the snippet centers on the whole-word mention', () => {
    // Adversarial-review follow-ups (review of 0995a9c4, 2026-09-22):
    // (3) owner-briefing.service.ts:390 renders FLEET LIVENESS UNBRACKETED —
    //     the bracket-only marker under-matched it.
    const OWNER_BRIEFING_WAKE = [
      'Owner briefing — fleet pulse.',
      'FLEET LIVENESS (measured right now — always true, never contradict it): crossmodel 3 enabled · 1 live run.',
    ].join('\n');
    expect(intentMismatchDiscount('get_chat_status', 'schedule_get', OWNER_BRIEFING_WAKE)).toEqual({
      reason: 'precomputed_duty', marker: 'FLEET LIVENESS (measured right now', line: '',
    });
    // (4) supervisor.service.ts:339's DOCTRINE mention `[FLEET LIVENESS]` is
    //     prose, not the block — it must not match (only the block header is
    //     a marker); with the called tool unnamed the discount is null.
    const DOCTRINE_ONLY =
      "5. check schedule health … ([FLEET LIVENESS] renders those projects 'dormant-by-design'). Event hooks are its wake path.";
    expect(intentMismatchDiscount('get_chat_status', 'run_command', DOCTRINE_ONLY)).toBeNull();
    // (5) the snippet window centers on the first WHOLE-WORD mention, not a
    //     substring inside a longer token earlier in the line.
    const padded = `the schedule_getting helper ran; ${'x'.repeat(120)} then schedule_get each and confirm the cadence`;
    const centered = intentMismatchDiscount('update_supervisor_state', 'schedule_get', padded);
    expect(centered?.reason).toBe('preamble_ordered');
    expect(centered?.line).toContain('schedule_get each and confirm the cadence');
  });

  it('UNIT: the incident premise — the narration convicts get_chat_status, and the preamble really does name schedule_get', () => {
    const offered = ['run_command', 'schedule_get', 'get_chat_status', 'list_schedules'];
    expect(detectIntendedTool(SCHED_MISS_REASONING, 'schedule_get', offered)).toBe('get_chat_status');
    // Fresh-bytes pin: the supervisor preamble still orders schedule_get.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../platform/supervisor-state.service.ts'), 'utf8');
    expect(src).toContain('schedule_get each and confirm the cadence');
  });

  it('REPLAY 92b485bd (ARMED, ticket 0625bf62): five ordered schedule_get successes under get_chat_status narration log 5 guard_miss discount rows (precomputed_duty, streak 1..5) — and the discount now ABSORBS the batch: no steer, no trip', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(schedMissTurn(1))
      .mockResolvedValueOnce(schedMissTurn(2))
      .mockResolvedValueOnce(schedMissTurn(3))
      .mockResolvedValueOnce(schedMissTurn(4))
      .mockResolvedValueOnce(schedMissTurn(5))
      .mockResolvedValue(FINAL);
    const input = makeInput(SUPERVISOR_WAKE);
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Sweep done.');
    // THE MEASUREMENT (unchanged): one guard_miss row per mismatched success,
    // each carrying the discount — now APPLIED, not merely proposed.
    const rows = discountMetrics();
    expect(rows).toHaveLength(5);
    rows.forEach((row, i) => {
      expect(row.meta).toMatchObject({
        tool: 'schedule_get',
        intended: 'get_chat_status',
        reason: 'precomputed_duty',
        marker: '[FLEET LIVENESS — per-project machine heartbeat',
        streak: i + 1,
      });
      expect(row.meta.line).toBeUndefined();
    });
    // ARMED BEHAVIOR (ticket 0625bf62 — the measurement cycle answered 9/9
    // discountable, 0 genuine): the ordered batch is ALIGNED, so no steer
    // fires at 3 and no trip at 5. schedule_get IS a platform tool, so the
    // platform-tool scope covers it.
    expect(steerMessages()).toHaveLength(0);
    expect(reanchorMetrics()).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0);
    expect(result.finalText).not.toContain('wrong-tool derailment');
  });

  it('REPLAY proposal (b): a wake checklist naming update_plan logs preamble_ordered rows with the matched line — steer still fires at 3', async () => {
    const wake = [
      PLAIN_WAKE,
      'Ordered checklist:',
      '2. run update_plan to refresh the board before reconciling the thread.',
    ].join('\n');
    mockRunModelTurn
      .mockResolvedValueOnce(planMissTurn(1))
      .mockResolvedValueOnce(planMissTurn(2))
      .mockResolvedValueOnce(planMissTurn(3))
      .mockResolvedValue(FINAL);
    const input = makeInput(wake);
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Sweep done.');
    const rows = discountMetrics();
    expect(rows).toHaveLength(3);
    rows.forEach((row, i) => {
      expect(row.meta).toMatchObject({
        tool: 'update_plan',
        intended: 'get_chat_messages',
        reason: 'preamble_ordered',
        marker: 'update_plan',
        streak: i + 1,
      });
      expect(String(row.meta.line)).toContain('update_plan');
      expect(String(row.meta.line).length).toBeLessThanOrEqual(160);
    });
    expect(steerMessages()).toHaveLength(1); // unchanged behavior
    expect(breakerMetrics()).toHaveLength(0); // below the trip threshold
  });

  it('NEGATIVE: a plain wake (no pre-computed block, called tool never named) logs ZERO discount rows — and the guard behaves exactly as before', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(schedMissTurn(1))
      .mockResolvedValueOnce(schedMissTurn(2))
      .mockResolvedValueOnce(schedMissTurn(3))
      .mockResolvedValue(FINAL);
    const input = makeInput(PLAIN_WAKE);
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Sweep done.');
    expect(discountMetrics()).toHaveLength(0);
    expect(steerMessages()).toHaveLength(1); // the guard still steered at 3
    expect(reanchorMetrics()).toHaveLength(1);
  });

  it('BOUND: the probe is capped at 12 rows per run — a 13-mismatch alternating run logs exactly 12 (each a fresh streak of 1), never steers, finishes clean', async () => {
    const wideProfile: AgentProfile = { ...CODING_TEST_PROFILE, maxSteps: 40 };
    for (let i = 1; i <= 13; i += 1) {
      mockRunModelTurn.mockResolvedValueOnce(schedMissTurn(i));
      if (i < 13) mockRunModelTurn.mockResolvedValueOnce(alignedTurn(100 + i)); // aligned success resets the streak
    }
    mockRunModelTurn.mockResolvedValue(FINAL);
    const input = makeInput(SUPERVISOR_WAKE, wideProfile);
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Sweep done.');
    const rows = discountMetrics();
    expect(rows).toHaveLength(12); // the 13th is suppressed by the per-run cap
    rows.forEach((row) => expect(row.meta.streak).toBe(1)); // every mismatch started a fresh streak
    expect(steerMessages()).toHaveLength(0); // never 3 consecutive ⇒ no steer
    expect(breakerMetrics()).toHaveLength(0);
  });
});

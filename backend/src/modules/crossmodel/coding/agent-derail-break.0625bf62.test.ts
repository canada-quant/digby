/**
 * REPLAY TEST — ticket 0625bf62 (mishap, 2026-09-24): "SUCCESS-side wrong-tool
 * guard convicted an ordered archive_chat batch as derailment".
 *
 * THE INCIDENT (canlegal-bench Supervisor lane 615723ba, 2026-09-24T04:14Z):
 * the wake's standing orders carry the owner retire doctrine and the chat
 * capability map's trigger line
 *   "- organize / new folder / move → create_project / move_chat / rename_chat
 *    / archive_chat"
 * (chat-agent/capability-doctrine.ts — whole-word archive_chat). The run
 * narrated its roster source (list_chats) while correctly calling archive_chat
 * ×5+ — 43 archive receipts, the owner retire doctrine executed, a coherent
 * final note. detectIntendedToolChannels convicted "intended list_chats"; the
 * 2c98b460 SUCCESS-side guard steered at 3 and tripped at 5. The 58e675c9
 * measure-first probe logged 9/9 guard_miss rows (seam
 * 'tool_intent_attribution'), ALL reason 'preamble_ordered', marker
 * 'archive_chat', streaks 1→5 twice — 9/9 discountable, 0 genuine.
 *
 * THE FIX (this pin): the 58e675c9 discount is ARMED in agent.ts's
 * success-side leg — computed ONCE per mismatch (wakeOrders initialized via
 * wakePromptHaystack exactly as the logging path did), and when it matches the
 * mismatch is treated as ALIGNED: the streak resets and the count-up, the
 * 3rd-mismatch re-anchor arm and the 5th-mismatch trip are skipped.
 *   · PLATFORM-TOOL SCOPE (the merge-safety line): the discount is APPLIED
 *     only when the CALLED tool is a platform tool (PLATFORM_TOOL_NAMES). The
 *     same fleet-wide 58e675c9 measurement shows wakePromptHaystack matching
 *     GENERIC CODING DOCTRINE — the coding system prompt's own "call
 *     update_plan …" line produced a live preamble_ordered row on e083ff2e,
 *     the FOUNDING 2c98b460 cluster lane (update_plan ×27 intending
 *     get_chat_messages) — so arming for coding tools would reopen the exact
 *     derail cluster the guard was built to contain. The founding class is
 *     coding tools; both adjudicated false-positive classes (92b485bd
 *     schedule_get, 0625bf62 archive_chat) are platform tools.
 *   · RUNAWAY BACKSTOP: the arm is bounded per tool per run by
 *     discountArmCap() (DERAIL_INTENT_DISCOUNT_CAP, default 25 — mirrors
 *     LOOP_VOLUME_CAP_DEFAULT). archive_chat/move_chat/rename_chat have no
 *     54a172ac volume-cap owner, so past the cap the classic count/steer/trip
 *     ladder owns the tool again (a decoder-locked archive loop is contained
 *     at cap+5, never handed an unbounded exemption).
 *   · MEASUREMENT CONTINUES: the guard_miss rows log for EVERY mismatch —
 *     armed or not, any tool, kill switch or not — with a measurement-shadow
 *     streak (classic counting, reset only by an aligned success or a trip)
 *     so post-arming telemetry stays comparable with the pre-arming baseline.
 *   · UNTOUCHED: run_command's exemption, and the ENTIRE failure-side ladder
 *     (a failing ordered call still counts/steers/trips — the discount only
 *     ever sees SUCCESS-shaped results, the 2c98b460 coverage gap itself).
 *
 * These tests drive the REAL agent loop (scaffold mirrors
 * agent-derail-break.2c98b460.test.ts): every mismatched call SUCCEEDS
 * ('probe result: ok') unless a scenario explicitly mocks a failure. Args
 * vary by LETTER skeleton (8-hex ids rotated one byte) so the exact
 * (:3728-era) and digit-collapsed (:3738-era) repeat signatures stay blind —
 * the incident's escape, reproduced. mockExecuteCodingTool's real signature
 * is (ctx, name, args) — name-first mocks silently misroute (0aecbe92
 * scaffold gotcha). run_command appears ONLY via the executeCodingTool mock
 * (scenario D1) — the mock intercepts the dispatch, so nothing reaches a
 * shell.
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

// Every tool SUCCEEDS ('probe result: ok') unless a scenario overrides — the
// incident shape is that nothing failure-shaped ever appears (scenario D2
// overrides for the failure-side pin). mockExecuteCodingTool's real signature
// is (ctx, name, args) — name-first mocks silently misroute (the 0aecbe92
// scaffold gotcha).
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, _name: string, _args: any) => 'probe result: ok');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The document/feedback seam dispatches via ctx.toolCache — keep the REAL
// TOOL_DEFINITIONS, stub only the executor (same success premise).
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
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

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

/** The 0625bf62 wake: standing orders carrying the capability map's trigger
 *  line — the exact whole-word archive_chat mention the incident lane's
 *  haystack matched (capability-doctrine.ts, pinned fresh-bytes below). */
const DOCTRINE_LINE = '- organize / new folder / move → create_project / move_chat / rename_chat / archive_chat';
const DOCTRINE_WAKE = [
  'SUPERVISOR SWEEP — retire finished lanes per the owner doctrine.',
  'Trigger → tool map (standing orders):',
  DOCTRINE_LINE,
  'Archive each finished lane in this same wake; report the receipts.',
].join('\n');

/** A plain ticket-dispatch wake: no doctrine line, archive_chat never named —
 *  the no-discount negative leg (scenario C). */
const PLAIN_WAKE = 'TICKET DISPATCH — sweep the roster, retire what is finished, report back.';

const makeInput = (userMessage: string = DOCTRINE_WAKE, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-0625bf62-test',
  sessionId: 'sess-0625bf62',
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

/** The 0625bf62 shape: archive_chat SUCCEEDS while the turn's own reasoning
 *  names list_chats (the roster source it just pulled). chatIds are 8-hex
 *  (id-shaped ⇒ the platform preflight grounds them) rotated one byte so
 *  neither the exact nor the digit-collapsed repeat signature can see a loop. */
const CHAT_IDS = ['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6', 'd4e5f6a7', 'e5f6a7b8', 'f6a7b8c9', 'a8b9c1d2', 'b9c1d2e3', 'c1d2e3f4', 'd2e3f4a5', 'e3f4a5b6', 'f4a5b6c7', 'a5b6c7d8'];
const MISS_REASONING = 'Now list_chats to re-pull the lane roster before the next retire goes out.';
const archiveMissTurn = (n: number) => ({
  content: '',
  reasoning: MISS_REASONING,
  toolCalls: [{ id: `t${n}`, name: 'archive_chat', arguments: JSON.stringify({ chatId: CHAT_IDS[(n - 1) % CHAT_IDS.length] }) }],
  finishReason: 'tool_calls',
});
/** run_command variant (scenario D1): generic workhorse, exempt from the
 *  success-side leg entirely — dispatched through the executeCodingTool mock,
 *  so nothing reaches a shell. */
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
const runCmdTurn = (n: number) => ({
  content: '',
  reasoning: MISS_REASONING,
  toolCalls: [{ id: `t${n}`, name: 'run_command', arguments: JSON.stringify({ command: `echo roster probe ${WORDS[(n - 1) % WORDS.length]}` }) }],
  finishReason: 'tool_calls',
});
/** The coding-tool variant (scope pin): update_plan SUCCEEDS while the
 *  reasoning names get_chat_messages, under a wake whose checklist names
 *  update_plan — the 58e675c9 proposal-(b) shape, which must STILL steer
 *  because update_plan is not a platform tool. */
const PLAN_MISS_REASONING = 'Now get_chat_messages to re-read the dispatcher thread before the next steer goes out.';
const planMissTurn = (n: number) => ({
  content: '',
  reasoning: PLAN_MISS_REASONING,
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: `${WORDS[(n - 1) % WORDS.length]} reconciliation pass`, status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
const ORDERED_PLAN_WAKE = [
  PLAIN_WAKE,
  'Ordered checklist:',
  '2. run update_plan to refresh the board before reconciling the thread.',
].join('\n');
const FINAL = { content: 'Sweep done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

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

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockExecuteCodingTool.mockImplementation(async () => 'probe result: ok');
  delete process.env.DERAIL_INTENT_DISCOUNT_CAP;
});

describe('ticket 0625bf62 — armed intent-discount for ordered platform-tool batches (2c98b460 success-side guard)', () => {
  it('UNIT: the incident premise — the narration convicts list_chats, the doctrine line really orders archive_chat, and the discount fires on the incident shape', () => {
    // The incident premise: successes are invisible to the failure detector…
    expect(looksLikeToolFailure('probe result: ok')).toBe(false);
    // …and the narration convicts list_chats while archive_chat is called.
    const offered = ['run_command', 'update_plan', 'archive_chat', 'list_chats', 'get_chat_messages'];
    expect(detectIntendedTool(MISS_REASONING, 'archive_chat', offered)).toBe('list_chats');
    expect(detectIntendedTool(MISS_REASONING, 'run_command', offered)).toBe('list_chats');
    // The discount fires exactly as the 9/9 measurement rows recorded.
    const d = intentMismatchDiscount('list_chats', 'archive_chat', DOCTRINE_WAKE);
    expect(d?.reason).toBe('preamble_ordered');
    expect(d?.marker).toBe('archive_chat');
    expect(String(d?.line)).toContain('archive_chat');
    // No doctrine line ⇒ no discount (the scenario-C premise).
    expect(intentMismatchDiscount('list_chats', 'archive_chat', PLAIN_WAKE)).toBeNull();
    // Fresh-bytes pin: the capability map still carries the trigger line the
    // incident haystack matched (capability-doctrine.ts).
    const src = require('fs').readFileSync(require('path').join(__dirname, '../chat-agent/capability-doctrine.ts'), 'utf8');
    expect(src).toContain('organize / new folder / move → create_project / move_chat / rename_chat / archive_chat');
  });

  it('UNIT SCOPE PIN: both adjudicated false-positive tools are platform tools; the founding 2c98b460 cluster tool is NOT', () => {
    // The merge-safety line (agent.ts state block, ticket 0625bf62): the arm
    // applies ONLY to platform tools. 92b485bd (schedule_get) and 0625bf62
    // (archive_chat) are in; e083ff2e's founding cluster tool (update_plan)
    // and the other observed coding-doctrine matches stay out.
    expect(PLATFORM_TOOL_NAMES).toContain('archive_chat');
    expect(PLATFORM_TOOL_NAMES).toContain('schedule_get');
    expect(PLATFORM_TOOL_NAMES).not.toContain('update_plan');
    expect(PLATFORM_TOOL_NAMES).not.toContain('read_file');
    expect(PLATFORM_TOOL_NAMES).not.toContain('edit_file');
  });

  it('REPLAY A (the incident): six ordered archive_chat successes under list_chats narration NEVER steer, NEVER trip, NEVER end the run — and the measurement rows still log', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(archiveMissTurn(1))
      .mockResolvedValueOnce(archiveMissTurn(2))
      .mockResolvedValueOnce(archiveMissTurn(3))
      .mockResolvedValueOnce(archiveMissTurn(4))
      .mockResolvedValueOnce(archiveMissTurn(5))
      .mockResolvedValueOnce(archiveMissTurn(6))
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    // The run completes clean: no steer, no withhold/trip, no run-end.
    expect(result.finalText).toContain('Sweep done.');
    expect(result.finalText).not.toContain('Run ended');
    expect(result.modelErrored).toBeUndefined();
    expect(steerMessages()).toHaveLength(0);
    expect(reanchorMetrics()).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0);
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
    expect(userTexts().some((t) => t.includes('wrong-tool derailment'))).toBe(false);
    // MEASUREMENT CONTINUES: one guard_miss row per mismatched success, the
    // discount that absorbed it riding the row (streak = the measurement-
    // shadow streak, classic counting — 1..6 consecutive here).
    const rows = discountMetrics();
    expect(rows).toHaveLength(6);
    rows.forEach((row, i) => {
      expect(row.meta).toMatchObject({
        tool: 'archive_chat',
        intended: 'list_chats',
        reason: 'preamble_ordered',
        marker: 'archive_chat',
        streak: i + 1,
      });
      expect(String(row.meta.line)).toContain('archive_chat');
    });
  });

  it('REPLAY C (guard strength unchanged): the same mismatched successes with NO doctrine line (no discount) still steer at 3 and trip at 5 exactly as today', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(archiveMissTurn(1))
      .mockResolvedValueOnce(archiveMissTurn(2))
      .mockResolvedValueOnce(archiveMissTurn(3))
      .mockResolvedValueOnce(archiveMissTurn(4))
      .mockResolvedValueOnce(archiveMissTurn(5))
      .mockResolvedValue(FINAL);
    const input = makeInput(PLAIN_WAKE); // archive_chat never named ⇒ no discount
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Sweep done.');
    expect(steerMessages()).toHaveLength(1);
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'archive_chat', intended: 'list_chats', reason: 'intent_mismatch_success' });
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({ tool: 'archive_chat', perma: false, intended: 'list_chats' });
    // Nothing to measure: no discount matched, so no rows.
    expect(discountMetrics()).toHaveLength(0);
  });

  it('REPLAY SCOPE (merge-safety): a CODING-tool mismatch under a wake that ORDERS the coding tool still steers — the arm never weakens the founding 2c98b460 class', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(planMissTurn(1))
      .mockResolvedValueOnce(planMissTurn(2))
      .mockResolvedValueOnce(planMissTurn(3)) // THIRD mismatch ⇒ steer arms — NO discount for coding tools
      .mockResolvedValue(FINAL);
    const input = makeInput(ORDERED_PLAN_WAKE);
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Sweep done.');
    expect(steerMessages()).toHaveLength(1);
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'update_plan', intended: 'get_chat_messages', reason: 'intent_mismatch_success' });
    // Measurement rows still log for coding tools (the haystack match is
    // recorded even though the arm is platform-scoped) — measure everything,
    // arm platform only.
    const rows = discountMetrics();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    rows.forEach((row, i) => expect(row.meta).toMatchObject({ tool: 'update_plan', intended: 'get_chat_messages', reason: 'preamble_ordered', streak: i + 1 }));
  });

  it('REPLAY D1 (run_command exemption): six successful run_command calls under the same narration and the same doctrine wake never steer, never trip — the workhorse stays exempt, discount or not', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(runCmdTurn(1))
      .mockResolvedValueOnce(runCmdTurn(2))
      .mockResolvedValueOnce(runCmdTurn(3))
      .mockResolvedValueOnce(runCmdTurn(4))
      .mockResolvedValueOnce(runCmdTurn(5))
      .mockResolvedValueOnce(runCmdTurn(6))
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Sweep done.');
    expect(steerMessages()).toHaveLength(0);
    expect(reanchorMetrics()).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0);
    // The calls really dispatched through the mock (never a shell).
    expect(mockExecuteCodingTool.mock.calls.some((c) => c[1] === 'run_command')).toBe(true);
  });

  it('REPLAY D2 (failure-side ladder untouched): FAILING archive_chat calls under the same ordered wake still count, steer and trip on the failure side — the arm only ever sees SUCCESS-shaped results', async () => {
    mockExecuteCodingTool.mockImplementation(async (_ctx: any, name: string) =>
      name === 'archive_chat' ? 'Tool archive_chat failed: chat not found' : 'probe result: ok');
    mockRunModelTurn
      .mockResolvedValueOnce(archiveMissTurn(1)) // failure + intent weight ⇒ streak 2; failure-side re-anchor (leg b) arms
      .mockResolvedValueOnce(archiveMissTurn(2)) // streak 3 ⇒ FAILURE trip (withhold one round)
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Sweep done.');
    // The re-anchor is the FAILURE-side leg (reason 'intent_mismatch', never
    // 'intent_mismatch_success') — the armed discount did not touch it.
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'archive_chat', intended: 'list_chats', reason: 'intent_mismatch' });
    const trip = breakerMetrics().find((m) => m.meta.shape === 'failure');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({ tool: 'archive_chat', perma: false, intended: 'list_chats' });
    // No SUCCESS-side rows at all: nothing succeeded.
    expect(breakerMetrics().filter((m) => m.meta.shape === 'success_intent')).toHaveLength(0);
    expect(discountMetrics()).toHaveLength(0);
  });

  it('REPLAY CAP (runaway backstop): DERAIL_INTENT_DISCOUNT_CAP=0 disarms the arm per tool — the classic steer-at-3/trip-at-5 containment returns on the ordered wake', async () => {
    process.env.DERAIL_INTENT_DISCOUNT_CAP = '0';
    mockRunModelTurn
      .mockResolvedValueOnce(archiveMissTurn(1))
      .mockResolvedValueOnce(archiveMissTurn(2))
      .mockResolvedValueOnce(archiveMissTurn(3)) // steer arms (cap 0 ⇒ never discounted)
      .mockResolvedValueOnce(archiveMissTurn(4))
      .mockResolvedValueOnce(archiveMissTurn(5)) // trip
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Sweep done.');
    expect(steerMessages()).toHaveLength(1);
    expect(reanchorMetrics()).toHaveLength(1);
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({ tool: 'archive_chat', perma: false });
    // Measurement rows still log (the cap bounds the ARM, not the telemetry).
    expect(discountMetrics().length).toBeGreaterThanOrEqual(3);
  });
});

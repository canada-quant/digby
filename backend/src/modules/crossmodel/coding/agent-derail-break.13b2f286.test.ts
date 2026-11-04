/**
 * Replay pin — ticket 13b2f286 (mishap, auto-filed 2026-09-20T13:38:01Z at
 * breaker trip; session cec340f2-f605-4370-b87a-d85b59cb243f "Re-Send Path C
 * Phase 2 Kickoff" — the CanLaw Path C integrator lane, kimi-k3 seat; run
 * c510c56f-6233-4cb1-b9b3-cfd261bc7f58; first streak this run).
 *
 * THE INCIDENT: the breaker auto-filed a '3× tool-failure streak:
 * update_schedule' mishap with ONE failure text:
 *   `{ "ok": false, "tool": "update_schedule", "reason": "ungrounded_id",
 *      "rejected": [{ "key": "id", "value": "noop" }],
 *      "message": "NOT EXECUTED: update_schedule was called with id=\"noop\",
 *      which is not an id you obtained this run — … Your reasoning named
 *      get_chat_messages — you evidently meant to call get_chat_messages;
 *      call it now with its real parameters." }`
 * i.e. mid decoder-lock the lane's reasoning named get_chat_messages while it
 * EMITTED update_schedule({id:"noop"}) — a model-authored placeholder id —
 * and the id-grounding PRE-FLIGHT refused it without executing.
 *
 * THE FORENSIC RECORD (guard_strike rows, get_fleet_telemetry view 'metrics'
 * chatId cec340f2, pulled 2026-09-20T14:05Z — verbatim seam sequence):
 *   13:37:59.893Z  tool_preflight       update_schedule ungrounded_id   intended:get_chat_messages
 *   13:38:01.681Z  tool_derail_reanchor update_schedule intent_mismatch intended:get_chat_messages
 *   13:38:04.070Z  tool_derail_break    update_schedule perma:false     intended:get_chat_messages
 *   13:39:23→13:42:27Z  tool_repeat_break todo_get (trips 1, 2, 3=run) + todo_update (trips 1)
 * Then the lane's own transcript (msg 227bf03b, createdAt 13:37:57Z): the
 * model decoder-locked, narrating "Breaking the todo lock — firing the actual
 * step-1 probes now" dozens of times while emitting wrong tools.
 *
 * ROLLOUT BOUNDARY (post-rollout classification doctrine, 2026-09-20): run
 * start = trigger msg af7ea4e7 createdAt 13:36:46Z; the re-anchor wave
 * (616d8793 riding 4714f9df, deploy run 35510720485) concluded 13:19:19Z and
 * every box carried it well before the firing — and the steer FIRING at
 * 13:38:01.681Z is itself the proof the serving box ran the re-anchor code.
 * POST-ROLLOUT, self-verifying. Probe-vs-derail NEGATIVE (ea69c94e
 * discipline): the lane was working its Path C firing checklist (real work),
 * not running lifecycle negative probes of guard refusals.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — the kimi-k3
 * narration/emission mismatch class (placeholder-emission subclass, siblings
 * f839cede / aff1c189 / ec9d7424; update_schedule-family sibling c5ad2e56).
 * A framework emission-layer garble would carry the intended call's REAL args
 * (a schedule id from list_schedules); only a model authors the string
 * "noop". Every deterministic seam behaved EXACTLY as designed, end-to-end:
 *   · the pre-flight refused the invented id NOT EXECUTED (referential
 *     grounding: "noop" is not id-shaped and appears nowhere the model read),
 *     with the intent-annotated repair affordance naming get_chat_messages;
 *   · the breaker weighted the call 1 (failure) + 1 (invented id) + 1 (intent
 *     mismatch) = 3 — the "3× streak" is the WEIGHTED count on the FIRST
 *     call, hence exactly ONE filed text; first trip = ONE-round withhold,
 *     not perma (perma:false in the telemetry);
 *   · the auto re-anchor (ticket 431518a2) fired its ONE harness steer on the
 *     FIRST derail signature — leg (b) intent_mismatch OWNS it (leg (c)'s
 *     source-1 condition !intended stays out precisely because the narration
 *     named a different tool) — recorded BEFORE the breaker row, matching
 *     the telemetry order above;
 *   · exactly ONE deduped mishap ticket was auto-filed; zero mutations
 *     executed anywhere in the streak.
 * The steer did NOT recover the seat (the derail continued on the todo
 * family) — the expected class behavior per adjudication 508c20b8 (in-run
 * re-prompts do not recover this seat class; the terminal-kill +
 * fresh-firing bound is the containment). NO platform code change.
 *
 * These tests pin: "noop" is ungrounded against the run haystack; the refusal
 * envelope is byte-faithful to the filed text (incl. the get_chat_messages
 * redirect); the intent detector convicts the incident narration and nothing
 * faithful; END-TO-END the single emission trips the breaker at weighted 3
 * with exactly ONE filed text, fires exactly ONE leg-(b) steer recorded
 * BEFORE the breaker row, and NOTHING reaches the executor while a grounded
 * get_chat_messages recovery executes. Scaffold mirrors
 * agent-derail-break.aff1c189.test.ts + agent-derail-reanchor.431518a2.test.ts
 * (same mock set).
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

const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'probe result: ok');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
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
import { findUngroundedIdArgs, ungroundedIdRefusal, detectIntendedTool } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

/** CODING profile (no workspace container in the scaffold), kimi-k3 — the
 *  incident's seat (telemetry: model kimi-k3, profile coding, moonshot). */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim tokens (ticket 13b2f286) ────────────────────────
const PLACEHOLDER_ID = 'noop'; // the filed rejected arg: { key: 'id', value: 'noop' }
const INTENDED_TOOL = 'get_chat_messages'; // the tool the lane's reasoning named
const COORDINATOR_CHAT = 'e083ff2e'; // the coordinator chat id (named in the lane's brief)

/** The firing-66 brief shape — deliberately free of the placeholder token, so
 *  "noop" is UNGROUNDED in this run's haystack; carries the coordinator chat
 *  id so the recovery read is grounded. */
const BRIEF = [
  'You are the Path C integrator for CanLaw SFT-2 v3 (this chat).',
  'EVERY FIRING, in order:',
  `1. NEW owner messages first, then coordinator ${COORDINATOR_CHAT} / supervisor f5c2c1f4 activity; act on new rulings.`,
  '2. Cyan probe + watchdog stamp: cyan must stay STOPPED ($0 GPU).',
  '3. Work the highest-priority OPEN leg; report milestones with THIS-RUN receipts.',
].join('\n');

const makeInput = (userMessage: string = BRIEF): AgentRunInput => ({
  worktree: '/tmp/derail-13b2f286-test',
  sessionId: 'sess-13b2f286',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

/** The incident emission: the reasoning names get_chat_messages (the intended
 *  step-1 transcript probe) while the EMITTED call is
 *  update_schedule({id:"noop"}) — the model-authored placeholder id from the
 *  filed text. Narration/emission mismatch ⇒ failure + invented-id + intent
 *  mismatch = the weighted "3×" trip on the FIRST call. */
const scheduleTurn = (n: number) => ({
  content: '',
  reasoning: `Step 1: pull the coordinator transcript — ${INTENDED_TOOL} on chat ${COORDINATOR_CHAT}, newest page, then the supervisor tail.`,
  toolCalls: [{ id: `t${n}`, name: 'update_schedule', arguments: JSON.stringify({ id: PLACEHOLDER_ID }) }],
  finishReason: 'tool_calls',
});
/** The steered recovery: a grounded get_chat_messages read (the chat id is
 *  8-hex shape-valid AND named in the brief) — executes and ends the streak. */
const recoveryTurn = (n: number) => ({
  content: '',
  reasoning: `Calling ${INTENDED_TOOL} now with the real chat id from the brief.`,
  toolCalls: [{ id: `t${n}`, name: INTENDED_TOOL, arguments: JSON.stringify({ chatId: COORDINATOR_CHAT }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Firing checklist done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const preflightMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_preflight' && m?.meta?.reason === 'ungrounded_id');
const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');
const metricSeamOrder = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]?.meta?.seam);
/** runModelTurn receives the ONE shared messages array by reference — at
 *  assertion time it holds the full conversation; count steers there. */
const conversation = () => mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }>;
const steerMessages = () => (conversation() || []).filter(
  (m) => m?.role === 'user' && typeof m.content === 'string' && m.content.includes('RE-ANCHOR (one per run)'),
);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay 13b2f286 — one placeholder-id update_schedule emission weighted as a "3× streak", re-anchor steer fired post-rollout', () => {
  it('"noop" is ungrounded against the run haystack (not id-shaped; appears nowhere the model read)', () => {
    expect(findUngroundedIdArgs({ id: PLACEHOLDER_ID }, BRIEF))
      .toEqual([{ key: 'id', value: PLACEHOLDER_ID }]);
  });

  it('replays the exact refusal envelope from the filed text (ungrounded_id, NOT EXECUTED, the rejected arg, the get_chat_messages redirect)', () => {
    const refusal = JSON.parse(
      ungroundedIdRefusal('update_schedule', [{ key: 'id', value: PLACEHOLDER_ID }], INTENDED_TOOL),
    );
    expect(refusal).toMatchObject({
      ok: false,
      tool: 'update_schedule',
      reason: 'ungrounded_id',
      rejected: [{ key: 'id', value: PLACEHOLDER_ID }],
    });
    expect(refusal.message).toContain('NOT EXECUTED: update_schedule was called with id="noop"');
    expect(refusal.message).toContain('never from narration');
    expect(refusal.message).toContain(
      'Your reasoning named get_chat_messages — you evidently meant to call get_chat_messages; call it now with its real parameters.',
    );
  });

  it('the intent detector convicts the incident narration; faithful narration convicts nothing', () => {
    const offered = ['run_command', 'get_chat_messages', 'update_schedule', 'update_plan'];
    expect(detectIntendedTool(scheduleTurn(1).reasoning, 'update_schedule', offered)).toBe(INTENDED_TOOL);
    const faithful = 'Updating update_schedule on the lane cadence row with the new interval now.';
    expect(detectIntendedTool(faithful, 'update_schedule', offered)).toBeNull();
  });

  it('END-TO-END (13b2f286): the single emission trips the breaker at weighted 3 with exactly ONE filed text, fires ONE leg-(b) steer recorded BEFORE the breaker row — and NOTHING mutates', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(scheduleTurn(1)) // preflight refusal: 1 +1(invented id) +1(intent) = 3 → TRIP with one text; steer (leg b)
      .mockResolvedValueOnce(scheduleTurn(2)) // withheld this round → tool_not_offered refusal (hint set ⇒ no leg (a); reAnchorUsed ⇒ no second steer)
      .mockResolvedValueOnce(recoveryTurn(3)) // grounded (8-hex + named in the brief) → EXECUTES
      .mockResolvedValue(FINAL);

    const input = makeInput();
    const result = await runCodingAgent(input);

    // The two incident calls died in the pre-flight/withhold — only the
    // grounded recovery read reached the tool layer.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
    expect(mockExecuteCodingTool.mock.calls[0][1]).toBe(INTENDED_TOOL);

    // The auto-filed investigation carries EXACTLY the incident's ONE text —
    // the "3×" in its title is the weighted count on the FIRST call, not
    // three failures (the ticket's "Failure texts (newest first)" holds one).
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_schedule');
    expect(ev.recentFailures).toHaveLength(1);
    const filed = JSON.parse(ev.recentFailures[0]);
    expect(filed).toMatchObject({
      ok: false, tool: 'update_schedule', reason: 'ungrounded_id',
      rejected: [{ key: 'id', value: PLACEHOLDER_ID }],
    });
    expect(filed.message).toContain('NOT EXECUTED');
    expect(filed.message).toContain('Your reasoning named get_chat_messages');
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);

    // Exactly ONE harness-attributed steer (leg b intent_mismatch — leg (c)'s
    // !intended condition keeps it out precisely because the narration named
    // a different tool), naming the intended tool and restating the toolset.
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run)');
    expect(steer).toContain('your own reasoning named get_chat_messages');
    expect(steer).toContain('call get_chat_messages NOW');
    expect(steer).toContain('Your ACTUAL tool list for the rest of this run is exactly:');

    // Telemetry seams, in the telemetry-observed ORDER (13:37:59.893Z
    // preflight → 13:38:01.681Z reanchor → 13:38:04.070Z break, perma:false).
    expect(preflightMetrics()).toHaveLength(1);
    expect(preflightMetrics()[0].meta).toMatchObject({ tool: 'update_schedule', reason: 'ungrounded_id', intended: INTENDED_TOOL });
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'update_schedule', intended: INTENDED_TOOL, reason: 'intent_mismatch' });
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta).toMatchObject({ tool: 'update_schedule', perma: false });
    const seams = metricSeamOrder();
    expect(seams.indexOf('tool_derail_reanchor')).toBeGreaterThan(seams.indexOf('tool_preflight'));
    expect(seams.indexOf('tool_derail_break')).toBeGreaterThan(seams.indexOf('tool_derail_reanchor'));

    // Attribution surfaces: guard-marked transcript part + progress stage.
    const part = result.parts.find((p) => p.type === 'text' && typeof p.text === 'string' && p.text.includes('Re-anchor steer injected'));
    expect(part).toBeDefined();
    expect(part!.marker).toBe('guard');
    const stages = (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'progress').map((c) => c[1]?.stage);
    expect(stages).toContain('derail-reanchor');
  });

  it('wiring seam: update_schedule stays a preflight-covered platform tool and the narration-intended read tool stays offered', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('update_schedule');
    expect(PLATFORM_TOOL_NAMES).toContain('get_chat_messages'); // the tool the lane's reasoning named
  });
});

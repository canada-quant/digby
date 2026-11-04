// LEGACY SCHEMA REPLAY (coding/tool-scope.ts, owner 2026-09-22): this pin replays
// an incident from before the cause-level fix — when `update_feedback` /
// `update_supervisor_state` were offered under their internal names to every
// coding lane. The breaker / pre-flight mechanics it pins are unchanged. The
// always-visible switches below still restore that era's SCOPE; the era's
// internal NAMES cannot be restored — RSW-1 deleted the disambiguation kill
// switch on 2026-11-02, so those tools are offered as `triage_ticket` /
// `save_supervisor_state` and the name assertions below pin the model-facing
// spelling. An EMITTED internal name still resolves and executes.
// (agent-tool-scope.test.ts pins the new default: renamed, scoped, slip-pruned.)
process.env.TRIAGE_TOOLS_ALWAYS_VISIBLE = '1';
process.env.SUPERVISOR_TOOLS_ALWAYS_VISIBLE = '1';

/**
 * Replay pin — ticket 4af20b7a (mishap, auto-filed at breaker trip
 * 2026-09-21T03:42:40Z). Session daee2916-fa75-4159-94a1-3d767abfd192
 * ("crossmodel Supervisor" — the PROJECT-supervisor plain chat, machine wake,
 * supervisorProfile kind:'chat'); tool send_chat_message; FIRST streak this
 * run; the lane's reasoning named update_supervisor_state. A NEW failure
 * class for the derail-breaker family: not a placeholder/wrong-tool
 * emission — a BACKPRESSURE retry loop.
 *
 * THE INCIDENT (all evidence fresh 2026-09-21): the supervisor's 03:32Z
 * sweep run (firing 147) had deltas to report up to the Fleet Supervisor
 * (chat c0e22e36-1c74-4295-8049-9b48335c6c37 — the report-up target carried
 * verbatim in its OWN sweep prompt, so the id is grounded). The Fleet chat
 * was itself mid-run with a FULL queue: 20/20 pending_chat_messages rows
 * (the supervisor's fresh pull at 03:57Z: "Fleet fresh: running, 20/20
 * queued"). enqueueChatMessage (message-queue.service.ts:91-97) counts 20
 * ≥ MAX_QUEUE_DEPTH (=20, :26) and throws AppError(409, 'Message queue is
 * full for this chat (20 pending) — wait for the active run to finish and
 * drain it, then resend.') — the ONLY remaining 409 on the busy-send paths
 * (:75-77), the DESIGNED backpressure gate, and the tool's documented
 * contract (platform-tools.ts send_chat_message description: "Fails (409)
 * ONLY when the chat's queue is full (20 pending messages)"). The throw
 * propagates through executePlatformTool to the executeCodingTool catch-all
 * (tools.ts:2479-2481), which renders `Tool send_chat_message failed: <msg>`
 * — byte-exact the ticket's TWO filed texts.
 *
 * TRIP ARITHMETIC (agent.ts:3352-3407 — the UNIFIED dispatch loop; plain
 * chats run the same runCodingAgent, so there is no separate chat-side
 * breaker to drift): the thrown 409 is failure-shaped
 * (looksLikeToolFailure). Emission 1: +1 failure, +1 intent fast-trip —
 * the turn's reasoning named update_supervisor_state, an OFFERED platform
 * tool (chat runs offer every PLATFORM_TOOL_NAMES entry via
 * CHAT_PROFILE_PLATFORM_TOOLS = CHAT_ORCH_TOOLS), never the called tool —
 * = 2; re-anchor steer armed (leg b, intent_mismatch). Emission 2: +1 = 3
 * ≥ 3 ⇒ TRIP at the SECOND emission ⇒ exactly the ticket's two-text,
 * "3× streak" filing. First trip for the tool ⇒ perma:false, send_chat_
 * message withheld for exactly the next model round, the deferred HARNESS
 * NOTICE carries the intendedHint naming update_supervisor_state, and the
 * run CONTINUES (trips 1 < 3, tools 1 < 2 — no terminal end). Filing:
 * fileStreakInvestigation with intended RAW = 'update_supervisor_state'.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR, no
 * framework defect, NO code change. Every deterministic seam behaved as
 * designed: (1) the queue-full 409 is byte-exact and side-effect-free
 * (pendingChatMessage.create NEVER runs at cap); (2) the refusal text
 * TELLS the model the only correct move — "wait for the active run to
 * finish and drain it, then resend" — and a same-run immediate retry can
 * never succeed (the target's queue drains one detached turn per finished
 * run; a 20-deep FIFO cannot drain inside the caller's own model round),
 * so re-emitting the identical send is a genuine failing loop, exactly the
 * derail signal the breaker exists to break (exempting backpressure would
 * blind it to retry-storms — the repeat-breaker telemetry shows decoder-
 * locked lanes resume an identical call 20+× when not broken); (3) the
 * intent fast-trip only ACCELERATED the trip from three emissions to two —
 * the underlying streak was real. CONTAINMENT WORKED END-TO-END: the lane
 * took the one-round withhold, did NOT retry-storm, deferred the report
 * correctly (one-shot schedule 9552713d on its own chat + a pending-note
 * in its state doc), completed the sweep run at 03:45Z with zero junk
 * writes and zero message loss (the report-up was DEFERRED, never dropped
 * — the Fleet queue drained by 03:57Z). The only framework-adjacent
 * observation (no automatic dead-letter retry for fleet report-ups) is an
 * ENHANCEMENT candidate the supervisor itself routed to the shortfall-hunt
 * stream — out of scope per the one-concern rule, and the existing
 * primitives (schedule_self) covered it.
 *
 * Scaffold mirrors agent-derail-break.155488ff-cea13871.test.ts (PR #935).
 */

jest.setTimeout(60_000);

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// message-queue.service imports middleware/error-handler → config/env, which
// process.exit(1)s in jest without the mirror (the busy-chat-queue learning).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
const mockPrismaCreate: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingChatMessage: {
      count: jest.fn(async () => 20), // the Fleet chat's full queue (MAX_QUEUE_DEPTH)
      create: (...a: any[]) => mockPrismaCreate(...a),
    },
  },
}));
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

/** The incident's refusal, thrown by the executePlatformTool mock so the
 *  REAL executeCodingTool catch-all (tools.ts:2479-2481) renders the filed
 *  text — byte-faithful, never hand-assembled at the executor seam. */
const mockExecutePlatformTool: jest.Mock = jest.fn();
jest.mock('../platform/platform-tools', () => {
  const actual = jest.requireActual('../platform/platform-tools');
  return { ...actual, executePlatformTool: (...a: any[]) => mockExecutePlatformTool(...a) };
});

/** send_chat_message goes through the REAL executeCodingTool (permission
 *  check → isPlatformTool → mocked executePlatformTool throw → REAL
 *  catch-all render); every other tool succeeds harmlessly (the lane's
 *  recovery update_supervisor_state lands, the probes the narration named
 *  were legit next steps). */
const mockExecuteCodingTool: jest.Mock = jest.fn();
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  mockExecuteCodingTool.mockImplementation(async (ctx: any, name: string, args: any) => {
    if (name === 'send_chat_message') return actual.executeCodingTool(ctx, name, args);
    return 'probe result: ok';
  });
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  noteSeatFallback: jest.fn(),
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
import { detectIntendedTool, findUngroundedIdArgs } from './tool-preflight';
import { looksLikeToolFailure } from './learnings-index.service';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';
import { enqueueChatMessage, MAX_QUEUE_DEPTH } from '../chat-agent/message-queue.service';
import { AppError } from '../../../middleware/error-handler';
import { executeCodingTool } from './tools';

/** SUPERVISOR profile (agent-profiles.ts:124-144): the incident lane's
 *  shape — kind:'chat', so the run offers EVERY platform tool
 *  (CHAT_PROFILE_PLATFORM_TOOLS ⊃ {send_chat_message,
 *  update_supervisor_state}) and the intent conviction can name the tool
 *  the reasoning named (the 0aecbe92 offerability precedent). */
const SUPERVISOR_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 24,
  maxDelegations: 2,
  contextCharBudget: 1_000_000,
  runDeadlineMs: 2_700_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// ── The incident's verbatim id + texts ─────────────────────────────────────
/** The Fleet Supervisor chat — the supervisor sweep prompt's standing
 *  report-up target, carried VERBATIM in the run's instructions (grounded). */
const FLEET_CHAT_ID = 'c0e22e36-1c74-4295-8049-9b48335c6c37';
/** message-queue.service.ts:95 verbatim (em-dash), at MAX_QUEUE_DEPTH=20. */
const REFUSAL_TEXT =
  'Message queue is full for this chat (20 pending) — wait for the active run to finish and drain it, then resend.';
/** The ticket's TWO filed texts, byte-identical (newest first): the
 *  executeCodingTool catch-all prefix + the refusal. */
const FILED_TEXT = `Tool send_chat_message failed: ${REFUSAL_TEXT}`;

/** The sweep brief — carries the Fleet id verbatim, so the emission's chatId
 *  is grounded (zero ungrounded-id preflight signal for this incident). */
const BRIEF = [
  '[PROJECT SWEEP — firing 147/500]',
  `REPORT UP via send_chat_message to chat id ${FLEET_CHAT_ID} (the chat`,
  "titled 'Fleet Supervisor') ONLY THE DELTAS the Fleet Supervisor must know.",
  'Then record the sweep in your state doc via update_supervisor_state.',
].join('\n');

/** Incident emission 1: send_chat_message to the full Fleet queue — the
 *  reasoning names update_supervisor_state (whole word, NEVER the called
 *  tool): the ticket's "lane's reasoning named update_supervisor_state". */
const sendConvictTurn = (n: number) => ({
  content: '',
  reasoning: 'update_supervisor_state gets the tally right after this — sending the Fleet report-up first.',
  toolCalls: [{ id: `t${n}`, name: 'send_chat_message', arguments: JSON.stringify({ chatId: FLEET_CHAT_ID, content: 'SWEEP deltas: placeholder family 5/5 closed; queue drained.' }) }],
  finishReason: 'tool_calls',
});
/** Incident emission 2: the identical send, intent-free (the ce17ef88
 *  minimal-arithmetic shape: intent weight on the FIRST call only). */
const sendPlainTurn = (n: number) => ({
  content: '',
  reasoning: 'The report still has to land before I close the sweep.',
  toolCalls: [{ id: `t${n}`, name: 'send_chat_message', arguments: JSON.stringify({ chatId: FLEET_CHAT_ID, content: 'SWEEP deltas: placeholder family 5/5 closed; queue drained.' }) }],
  finishReason: 'tool_calls',
});
/** The lane's REAL recovery move after the withhold: record state (success
 *  ends the streak) and defer the report to a later firing. */
const recoveryTurn = (n: number) => ({
  content: '',
  reasoning: 'Report deferred to the one-shot retry — recording the sweep state now.',
  toolCalls: [{ id: `t${n}`, name: 'update_supervisor_state', arguments: JSON.stringify({ notes: 'Fleet report deferred (queue full); retry armed.' }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Sweep complete — Fleet report deferred until its queue drains.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (userMessage: string): AgentRunInput => ({
  worktree: '/tmp/derail-qfull-test',
  sessionId: 'sess-qfull',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: SUPERVISOR_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

const strikes = (seam: string) =>
  mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === seam);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockExecutePlatformTool.mockImplementation(async (_ctx: any, name: string) => {
    if (name === 'send_chat_message') throw new AppError(409, REFUSAL_TEXT);
    return 'ok';
  });
});

describe('ticket 4af20b7a — send_chat_message queue-full backpressure streak on the project-supervisor wake (reasoning named update_supervisor_state)', () => {
  it('UNIT: the filed text is failure-shaped (feeds the streak); the intent conviction names update_supervisor_state only on the convict narration; faithful narration convicts nothing', () => {
    expect(looksLikeToolFailure(FILED_TEXT)).toBe(true);
    const offered = ['send_chat_message', 'update_supervisor_state', 'schedule_message', 'list_chats'];
    expect(detectIntendedTool(sendConvictTurn(1).reasoning, 'send_chat_message', offered)).toBe('update_supervisor_state');
    expect(detectIntendedTool(sendPlainTurn(2).reasoning, 'send_chat_message', offered)).toBeNull();
    expect(detectIntendedTool('Calling send_chat_message now with the report deltas.', 'send_chat_message', offered)).toBeNull();
  });

  it('UNIT wiring seam: BOTH tools are offered platform tools, and the Fleet chatId is grounded against the sweep brief — the emission carried ZERO ungrounded-id preflight signal (no preflight rows in this incident)', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('send_chat_message');
    expect(PLATFORM_TOOL_NAMES).toContain('update_supervisor_state');
    expect(findUngroundedIdArgs({ chatId: FLEET_CHAT_ID, content: 'deltas' }, BRIEF)).toEqual([]);
  });

  it('BYTE-EXACT seam 1: the REAL enqueueChatMessage at MAX_QUEUE_DEPTH throws AppError(409) with the incident refusal verbatim — and NEVER writes the row (side-effect-free backpressure)', async () => {
    expect(MAX_QUEUE_DEPTH).toBe(20);
    await expect(
      enqueueChatMessage({ chatId: FLEET_CHAT_ID, userId: 'u1', content: 'deltas', source: 'agent' }),
    ).rejects.toMatchObject({ statusCode: 409, message: REFUSAL_TEXT });
    expect(mockPrismaCreate).not.toHaveBeenCalled();
  });

  it('BYTE-EXACT seam 2: the REAL executeCodingTool catch-all renders the thrown 409 as the ticket\'s filed text verbatim (`Tool send_chat_message failed: ` + the refusal) — no framework drift', async () => {
    const ctx: any = { permissionMode: 'auto', alwaysAllow: new Set(), worktree: '/tmp/derail-qfull-test', sessionId: 'sess-qfull' };
    const rendered = await executeCodingTool(ctx, 'send_chat_message', { chatId: FLEET_CHAT_ID, content: 'deltas' });
    expect(rendered).toBe(FILED_TEXT);
  });

  it('END-TO-END the incident ladder: TWO queue-full sends trip the breaker at the SECOND emission (+2 intent-weighted, +1) — the two-text filing names intended update_supervisor_state, perma:false; the one-round withhold + re-anchor fire; the lane recovers and the run COMPLETES (never terminal); zero successful sends; zero preflight rows', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(sendConvictTurn(1)) // throws via the real catch-all (+1 failure +1 intent = 2; re-anchor armed)
      .mockResolvedValueOnce(sendPlainTurn(2))  // throws again (+1 = 3) ⇒ TRIP 1 (perma:false, one-round withhold); filing 4af20b7a [FILED_TEXT, FILED_TEXT]
      .mockResolvedValueOnce(recoveryTurn(3))   // the lane's real recovery: update_supervisor_state succeeds — streak ends
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput(`${BRIEF}\nRun the sweep now.`));

    // ZERO successful sends: the executor saw exactly the two failing calls.
    const sendCalls = mockExecutePlatformTool.mock.calls.filter((c) => c[1] === 'send_chat_message');
    expect(sendCalls).toHaveLength(2);
    for (const c of sendCalls) expect(c[2]).toMatchObject({ chatId: FLEET_CHAT_ID });

    // ZERO preflight rows — the Fleet id was grounded; this incident never
    // touched the ungrounded-id seam (contrast the placeholder family).
    expect(strikes('tool_preflight')).toHaveLength(0);

    // The filing: exactly one first-streak investigation, byte-exact texts,
    // intended RAW (reflection.ts then writes the "reasoning named" line).
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    expect(filings).toHaveLength(1);
    expect(filings[0]).toMatchObject({
      tool: 'send_chat_message',
      perma: false,
      intended: 'update_supervisor_state',
      recentFailures: [FILED_TEXT, FILED_TEXT],
    });

    // The breaker + re-anchor telemetry rows.
    const breaks = strikes('tool_derail_break');
    expect(breaks).toHaveLength(1);
    expect(breaks[0].meta).toMatchObject({ tool: 'send_chat_message', perma: false, intended: 'update_supervisor_state' });
    const reanchors = strikes('tool_derail_reanchor');
    expect(reanchors).toHaveLength(1);
    expect(reanchors[0].meta).toMatchObject({ tool: 'send_chat_message', intended: 'update_supervisor_state', reason: 'intent_mismatch' });

    // The run CONTINUED to a normal completion (the incident's actual
    // outcome — sweep note posted 03:45Z): no terminal run-end.
    expect(result.finalText).toBe(FINAL.content);
    expect(result.finalText).not.toContain('Run ended');

    // The model saw the containment surfaces: the one-round withhold notice
    // with the intendedHint, and the one-per-run RE-ANCHOR steer. (Scan ALL
    // runModelTurn call args — the messages ride a later positional arg;
    // c[0] is the provider config.)
    const conversation = JSON.stringify(mockRunModelTurn.mock.calls);
    expect(conversation).toContain('Your last 3 calls of send_chat_message ALL FAILED');
    expect(conversation).toContain('Your own reasoning named update_supervisor_state');
    expect(conversation).toContain('RE-ANCHOR (one per run)');
  });
});

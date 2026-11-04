/**
 * Replay pin — ticket 87d1e421 (mishap, session 66c9fb5c-cf72-4ced-a298-
 * 1951b7d610da "Acceptance Criteria Verified", run 1cf6f9d4-dd8a-442d-
 * b3e5-94f02e2dfc01, seat glm-5.3 — NOT seat-specific: the pre-flight and
 * the weighted breaker are deterministic, seat-blind seams; the same shape
 * filed from kimi-k3 lanes, cf. 03b13d6e / ec9d7424).
 *
 * THE INCIDENT: the breaker auto-filed a '3× tool-failure streak:
 * update_feedback' mishap with TWO IDENTICAL failure texts (newest first):
 *   `{"ok":false,"tool":"update_feedback","reason":"ticket_not_found",
 *    "ticketId":"00000000","message":"This machine-triggered run may NOT
 *    mutate feedback ticket 00000000: the ticket is not dispatched to this
 *    session (its context.dispatchedTo names another session) …"}`  ×2
 * (the ticket-18086326 machine-MUTATION gate; truncated in filing).
 * The ticket note records "lane's reasoning named update_plan".
 *
 * RECONSTRUCTED CHRONOLOGY + VERIFIED TRIP MATH (against source bytes @
 * 8e53daeff3): BOTH calls EXECUTED — they reached the dispatch gate, which
 * proves the pre-flight's grounding check PASSED for "00000000". WHY: the
 * id-SHAPE rule — ID_SHAPE_RE /^[0-9a-f]{8}/i (tool-preflight.ts:35) — an
 * 8-hex-prefix citation shape, digit-only ids included by design (the
 * header contract: "Digit-only ids — GitHub run ids, numeric todo ids —
 * are hex too, so they pass this shape"). No haystack occurrence needed;
 * unit-pinned below. So each call went straight to execution and the gate
 * refused truthfully (+1 failure each, agent.ts:3172-3173 = 2). The third
 * weighted point is the INTENT-MISMATCH fast-trip — REAL weighted
 * machinery, not an auto-filer observation: detectIntendedTool
 * (tool-preflight.ts:86-104) runs on EVERY failure-shaped result at
 * agent.ts:3181, and a conviction adds +1 and is filed as
 * StreakEvidence.intended (agent.ts:3183, 3277-3282). The lane's reasoning
 * named update_plan — a DIFFERENT offered tool, the called tool never
 * named — so call 1 = +1 failure +1 intent = 2, call 2 = +1 failure
 * = 3 → TRIP (3184), exactly two texts captured newest-first
 * (3176-3177). (Had the second turn's reasoning also named update_plan the
 * count would be 4 ≥ 3 — the trip lands on the same call with the same
 * two texts; this replay pins the minimal arithmetic: the intent weight on
 * the FIRST call, a pure failure on the second.)
 *
 * ENVELOPE PROVENANCE (d2c2744b divergence — pinned, not a defect): the
 * filed gate envelope pairs reason:"ticket_not_found" with the LEGACY
 * "not dispatched to this session" message. Current main
 * (platform-tools.ts:3596-3610, post-#890 d4946f2ac, merged 2026-09-19)
 * renders the ticket_not_found truth variant (3598-3608: "If this id was
 * fabricated or mistyped, re-derive a real one from
 * list_feedback/get_feedback …") for a genuinely-absent row; the 3609
 * "not dispatched" message now pairs only with a non-ticket_not_found
 * verdict. The incident predates that deploy, so this suite pins the FILED
 * incident-era envelope as an injected constant (same provenance as the
 * ec9d7424 scaffold) — the breaker counts RESULT TEXT, so the replay is
 * exact at the counting seam either way.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — the lane
 * decoder-locked on update_feedback with a shape-valid but fabricated
 * all-zeros id while its own reasoning named update_plan — NOT a
 * deterministic framework defect; every deterministic seam (the shape
 * rule, the 18086326 mutation gate, the intent-mismatch weight, the
 * weighted breaker, the one-round withhold) behaved exactly as designed.
 * No shape exemption (ea69c94e doctrine). NO platform code change.
 *
 * These tests pin: the 8-hex shape rule grounding "00000000" with NO
 * haystack occurrence (and a non-hex contrast staying ungrounded), the
 * intent detector convicting update_plan from the trip turn's own words,
 * the gate envelope byte-faithful to the filed text (ticketId.slice(0,8)
 * → "00000000"), the two real calls tripping the breaker at weighted
 * count 3 with the two identical filed texts newest-first and
 * StreakEvidence.intended = 'update_plan', both calls reaching the
 * executor, and the first trip withholding the tool for ONE round (not
 * perma). Scaffold mirrors agent-derail-break.ec9d7424.test.ts (same mock
 * set); the update_plan stub-into-extraTools idiom mirrors
 * agent-derail-break.1ee07214.test.ts (per-run extra tools join the
 * offered list, agent.ts:967, so the REAL detectIntendedTool sees
 * update_plan as offered — a coding-profile lane offers the real one;
 * update_plan is a workspace tool, tools.ts:397, not a chat-profile
 * platform tool).
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
  buildChatWakeClockNote: jest.fn(() => ""),
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
import { findUngroundedIdArgs, detectIntendedTool } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// ── The incident's verbatim id (ticket 87d1e421) ─────────────────────────────
const CALL_ID = '00000000'; // both calls — an all-zeros FABRICATED id that PASSES the 8-hex shape rule
const RECOVERY_ID = '87d1e421'; // 8-hex — shape-valid citation for the recovery call

/** The gate envelope exactly as the breaker counted it — reason/ticketId plus
 *  the incident-era production message template (the filed text truncates
 *  mid-string; ticketId.slice(0,8) → "00000000"). See the header's d2c2744b
 *  provenance note: current main renders the ticket_not_found truth variant
 *  for a genuinely-absent row — this pins the FILED shape. */
const GATE_ENVELOPE = JSON.stringify(
  {
    ok: false,
    tool: 'update_feedback',
    reason: 'ticket_not_found',
    ticketId: CALL_ID,
    message:
      `This machine-triggered run may NOT mutate feedback ticket ${CALL_ID.slice(0, 8)}: the ticket is not dispatched to this session ` +
      '(its context.dispatchedTo names another session) and no verifiable evidence was supplied. Dispatch binding is the sanctioned path — ' +
      'a dispatched lane works its OWN tickets (in_progress/adminNote/priority) without the artifact bar; without binding the evidence bar ' +
      'applies to EVERY status, not just done.',
  },
  null,
  1,
);

/** The acceptance-sweep brief — carries no occurrence of "00000000"; the
 *  shape rule (not an occurrence) is what grounds the incident calls. */
const BRIEF = [
  '[Acceptance criteria tick — record-only verification watch]',
  'Re-check the acceptance criteria against fresh pulls and record the verdict.',
  'Never mutate platform state from narration; ids come from a prior tool',
  'result (list_*/get_*), the brief, or the user.',
].join('\n');

/** The first (intent-convicted) turn's own words — per the ticket note
 *  "lane's reasoning named update_plan": names ANOTHER offered tool as a
 *  whole word and NEVER the called one, so the REAL detectIntendedTool
 *  convicts it (+1 fast-trip, agent.ts:3181-3183). */
const INTENT_REASONING =
  'The acceptance sweep is green; before any ticket bookkeeping I should update_plan to mark the verified criteria done.';
/** The second turn's reasoning names update_feedback — no intent weight:
 *  the streak's third point is already banked; this call is a pure +1. */
const PLAIN_REASONING =
  'Retry update_feedback with the same ticket id — the first gate answer was already computed.';

/** Stub so the REAL detectIntendedTool sees update_plan as offered — it was a
 *  live offered tool in the lane's (coding-profile) run; the chat test profile
 *  does not offer workspace tools, so the extraTools seam (agent.ts:967)
 *  stands in, mirroring agent-derail-break.1ee07214.test.ts. */
const UPDATE_PLAN_STUB = {
  schema: {
    type: 'function' as const,
    function: {
      name: 'update_plan',
      description: 'test stub — present so intent detection sees it offered',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: jest.fn(async () => 'plan ok'),
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-87d1e421-test',
  sessionId: 'sess-87d1e421',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `${BRIEF}\nRun the tick now.`,
  extraTools: [UPDATE_PLAN_STUB],
  emit: jest.fn(),
});

/** A turn calling update_feedback({id:"00000000"}) with an explicit reasoning text. */
const feedbackTurn = (n: number, id: string, reasoning: string) => ({
  content: '',
  reasoning,
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Tick recorded.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay 87d1e421 — two shape-grounded gate refusals + the intent-mismatch weight read as a "3× update_feedback streak"', () => {
  it('the id-SHAPE rule grounds "00000000" with NO haystack occurrence (tool-preflight.ts:35 — digit-only ids are hex too); a non-hex token stays ungrounded', () => {
    expect(BRIEF.includes(CALL_ID)).toBe(false); // no occurrence to lean on
    expect(findUngroundedIdArgs({ id: CALL_ID }, BRIEF)).toEqual([]); // shape-grounded
    expect(findUngroundedIdArgs({ id: CALL_ID }, 'a haystack that never mentions the ticket id')).toEqual([]);
    // Contrast: an 8-char NON-hex narration token is neither shape-valid nor
    // present → refused ungrounded (the 03b13d6e "noop" shape).
    expect(findUngroundedIdArgs({ id: 'nonsense' }, BRIEF))
      .toEqual([{ key: 'id', value: 'nonsense' }]);
  });

  it('the intent-mismatch machinery is REAL: the trip turn’s own words convict update_plan against the offered set (detectIntendedTool, tool-preflight.ts:86-104)', () => {
    const offered = ['update_feedback', 'update_plan', 'get_chat_messages'];
    expect(detectIntendedTool(INTENT_REASONING, 'update_feedback', offered)).toBe('update_plan');
    // Naming the called tool (or nothing) never convicts.
    expect(detectIntendedTool(PLAIN_REASONING, 'update_feedback', offered)).toBeNull();
    expect(detectIntendedTool('', 'update_feedback', offered)).toBeNull();
  });

  it('pins the dispatch-gate envelope from the filed texts (ticket_not_found; message renders ticketId.slice(0,8) = "00000000"; the 18086326 binding language)', () => {
    const env = JSON.parse(GATE_ENVELOPE);
    expect(env).toMatchObject({
      ok: false,
      tool: 'update_feedback',
      reason: 'ticket_not_found',
      ticketId: CALL_ID,
    });
    expect(env.message).toContain('may NOT mutate feedback ticket 00000000');
    expect(env.message).toContain('not dispatched to this session');
    expect(env.message).toContain('Dispatch binding is the sanctioned path');
    expect(env.message).toContain('applies to EVERY status, not just done.');
  });

  it('END-TO-END: two executed gate refusals + the intent fast-trip on the first call trip the breaker at weighted count 3 — two identical filed texts, newest first, intended=update_plan', async () => {
    // Both calls are shape-grounded → BOTH reach the executor → the injected
    // dispatch-gate envelope each time. Call 1: +1 failure +1 intent
    // (reasoning names update_plan) = 2; call 2: +1 failure = 3 → TRIP.
    mockExecuteCodingTool.mockResolvedValue(GATE_ENVELOPE);
    mockRunModelTurn
      .mockResolvedValueOnce(feedbackTurn(1, CALL_ID, INTENT_REASONING)) // executes → gate refusal: streak 1 + intent 1 = 2
      .mockResolvedValueOnce(feedbackTurn(2, CALL_ID, PLAIN_REASONING))  // executes → gate refusal: 3 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // Both calls executed — grounding passed on the 8-hex shape.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_feedback');
    expect(ev.perma).toBe(false);
    // The intent-mismatch weight is filed as StreakEvidence.intended — the
    // "lane's reasoning named update_plan" note is a DETECTED field here.
    expect(ev.intended).toBe('update_plan');
    expect(ev.recentFailures).toHaveLength(2);
    for (const text of ev.recentFailures) {
      const filed = JSON.parse(text);
      expect(filed).toMatchObject({
        ok: false, tool: 'update_feedback', reason: 'ticket_not_found', ticketId: CALL_ID,
      });
      expect(filed.message).toContain('may NOT mutate feedback ticket 00000000');
    }
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    const consultEv = mockConsultCrossCheckerOnStreak.mock.calls[0][0];
    expect(consultEv.recentFailures).toEqual(ev.recentFailures);
    expect(consultEv.intended).toBe('update_plan');
  });

  it('first trip = one-round withhold, NOT perma: a same-tool call two rounds later EXECUTES (the lane recovers with a shape-valid citation and keeps working)', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce(GATE_ENVELOPE)   // call 1 → gate refusal
      .mockResolvedValueOnce(GATE_ENVELOPE)   // call 2 → gate refusal → TRIP
      .mockResolvedValue('{"ok":true}');
    mockRunModelTurn
      .mockResolvedValueOnce(feedbackTurn(1, CALL_ID, INTENT_REASONING)) // count 2 (intent fast-trip)
      .mockResolvedValueOnce(feedbackTurn(2, CALL_ID, PLAIN_REASONING))  // count 3 → TRIP, withheld next round
      .mockResolvedValueOnce(feedbackTurn(3, RECOVERY_ID, PLAIN_REASONING)) // refused: tool not offered (withheld)
      .mockResolvedValueOnce(feedbackTurn(4, RECOVERY_ID, PLAIN_REASONING)) // back on offer → executes (shape-grounded)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    // THREE executions: the two incident gate refusals + the post-withhold
    // recovery. The withheld round-3 call never reached the tool.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(3);
  });

  it('wiring seam: update_feedback stays a preflight-covered platform tool', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
  });
});

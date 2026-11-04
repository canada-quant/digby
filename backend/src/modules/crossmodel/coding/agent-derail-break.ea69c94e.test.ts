/**
 * Replay pin — ticket ea69c94e (2026-09-19 breaker trip, session c580b22e, run ea6bb2dc).
 *
 * THE INCIDENT: the breaker auto-filed a "3× tool-failure streak: todo_update"
 * mishap with only TWO failure texts (newest first):
 *   1. `Tool todo_update failed: gateQuestionId "oq_1fc19541-1487-441a-a9c2-b7321873061a"
 *      matches no owner_questions row for this owner or your account — …` (existence refusal)
 *   2. `{ "ok": false, "reason": "ungrounded_id", rejected: [{key:"gateQuestionId",
 *      value:"oq_00000000-dead-beef-0000-000000000000"}] … }` (pre-flight refusal, NOT EXECUTED)
 *
 * WHAT ACTUALLY HAPPENED (adjudication against primary sources, 2026-09-19):
 * the lane had just merged+deployed the be94fa64 resolver fix (PR #869, sha 4a160b13)
 * and was running the lifecycle-MANDATED live E2E probes of that fix. Both
 * "failures" were DELIBERATE negative probes, expected to refuse:
 *   · call 1 passed a fabricated canary (oq_00000000-dead-beef-…) — the id-grounding
 *     pre-flight refused it WITHOUT executing (correct: 'oq_' fails the hex-shape
 *     rule and the canary appears nowhere in the run's grounding haystack);
 *   · call 2 pointed at the be94fa64 incident's REAL card oq_1fc19541 — owned by a
 *     THIRD account (the member fleet-supervisor lane), quoted verbatim in the
 *     lane's own dispatch brief. Grounded via the brief (pre-flight passes), then
 *     refused by resolveGateQuestionId from the OWNER-scope lane — cross-tenant
 *     isolation working exactly as the post-#869 contract intends (the NEW
 *     "or your account" message in the failure text proves the fresh deploy was live).
 * The lane's positive probe (its own freshly-flagged card oq_0109b2dd) was accepted.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — intentional,
 * doctrine-mandated guard probes — NOT a deterministic framework defect. Both
 * guards behaved correctly; the breaker counted as designed: the ungrounded
 * fast-trip weight (+1, f356e14a7 — "an invented id is never real work") makes
 * TWO failure-shaped results read as a "3×" trip. A shape exemption is WRONG
 * here (contrast ticket 1ab1a52b's needsConfirmation envelope, which is always
 * benign): ungrounded/existence refusals are the breaker's primary derailment
 * signal — intent is invisible to the shape layer, so the phantom ticket is the
 * accepted cost of the self-heal doctrine (investigate + attribute).
 *
 * These tests replay the exact two-call sequence end-to-end (the REAL pre-flight
 * runs inside the loop for call 1) and pin: the canary is ungrounded, the
 * brief-quoted id is grounded, the trip fires at count 3 with exactly the two
 * real failure texts in the filed evidence, and the tool is withheld for one
 * round (first trip), not perma-withheld. The resolver's own logic (member-row
 * acceptance, phantom/cross-tenant refusal, message text) is pinned in
 * goals.service.be94fa64.test.ts — not duplicated here.
 *
 * Scaffold mirrors agent-derail-break.8579d419.test.ts (same mock set).
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
import { findUngroundedIdArgs, ungroundedIdRefusal } from './tool-preflight';
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

// ── The incident's verbatim ids (ticket ea69c94e + its parent be94fa64) ──────
const DEAD_CANARY = 'oq_00000000-dead-beef-0000-000000000000'; // invented — call 1
const FOREIGN_GATE = 'oq_1fc19541-1487-441a-a9c2-b7321873061a'; // third-account row — call 2
const TODO_ID = '4501c4b0-a339-44db-a3e5-87b0fd713cd1'; // hex-shaped → always grounded

/** The lane's dispatch brief quoted the be94fa64 card verbatim — the grounding
 *  haystack (system + user + tool results) carries it, so call 2 is GROUNDED. */
const BRIEF = [
  '[TICKET BATCH DISPATCH — 1 open feedback tickets]',
  `Ticket be94fa64 — todo ${TODO_ID} with gateQuestionId "${FOREIGN_GATE}" was REFUSED`,
  'verbatim: matches no owner_questions row for this owner. A second attempt with the',
  '8-char prefix "oq_1fc19541" was refused identically. Fix the resolver scope.',
].join('\n');

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-ea69c94e-test',
  sessionId: 'sess-ea69c94e',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `${BRIEF}\nVerify the deployed fix: probe the refusals, then gate on a real card.`,
  emit: jest.fn(),
});

/** A turn calling todo_update — reasoning NAMES the called tool so the
 *  intent-mismatch fast-trip stays out of the replay (as in the real run). */
const todoUpdateTurn = (n: number, gateQuestionId: string) => ({
  content: '',
  reasoning: `todo_update probe ${n}: point the todo's gate at ${gateQuestionId} and observe the guard.`,
  toolCalls: [{ id: `t${n}`, name: 'todo_update', arguments: JSON.stringify({ todoId: TODO_ID, gateQuestionId, blockKind: 'owner', blockedReason: 'probe' }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Probes done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** Call 2's tool result — the incident's verbatim existence-refusal text. */
const RESOLVER_REFUSAL =
  `Tool todo_update failed: gateQuestionId "${FOREIGN_GATE}" matches no owner_questions row for this owner or your account — ` +
  `a gate cannot point at a question that does not exist. Flag it first with flag_owner_question, or probe list_owner_questions for the real oq_ id.`;

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay ea69c94e — deliberate guard probes read as a "3× todo_update streak"', () => {
  it('the fabricated canary is ungrounded even with the brief in context (pre-flight refuses WITHOUT executing)', () => {
    expect(findUngroundedIdArgs({ todoId: TODO_ID, gateQuestionId: DEAD_CANARY }, BRIEF))
      .toEqual([{ key: 'gateQuestionId', value: DEAD_CANARY }]);
  });

  it('the brief-quoted foreign card IS grounded — the pre-flight correctly lets call 2 through to the resolver', () => {
    expect(findUngroundedIdArgs({ todoId: TODO_ID, gateQuestionId: FOREIGN_GATE }, BRIEF)).toEqual([]);
  });

  it('…but the SAME foreign id is ungrounded without a legitimate source — an id must come from a real read', () => {
    expect(findUngroundedIdArgs({ gateQuestionId: FOREIGN_GATE }, ''))
      .toEqual([{ key: 'gateQuestionId', value: FOREIGN_GATE }]);
  });

  it('replays the exact refusal envelope from failure text #2 (ungrounded_id, NOT EXECUTED, the rejected arg)', () => {
    const refusal = JSON.parse(
      ungroundedIdRefusal('todo_update', [{ key: 'gateQuestionId', value: DEAD_CANARY }], null),
    );
    expect(refusal).toMatchObject({
      ok: false,
      tool: 'todo_update',
      reason: 'ungrounded_id',
      rejected: [{ key: 'gateQuestionId', value: DEAD_CANARY }],
    });
    expect(refusal.message).toContain('NOT EXECUTED');
  });

  it('END-TO-END: two deliberate refusal probes trip the breaker at count 3 (ungrounded fast-trip +1) with exactly the two real texts filed', async () => {
    // Call 1 hits the REAL pre-flight in the loop (never reaches executeCodingTool);
    // call 2 is grounded via the brief quote and executes → resolver refusal.
    mockExecuteCodingTool.mockResolvedValueOnce(RESOLVER_REFUSAL).mockResolvedValue('ok');
    mockRunModelTurn
      .mockResolvedValueOnce(todoUpdateTurn(1, DEAD_CANARY))   // pre-flight refusal: streak 1 + fast-trip 1 = 2
      .mockResolvedValueOnce(todoUpdateTurn(2, FOREIGN_GATE))  // resolver refusal: streak 3 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // Call 1 was refused BEFORE execution — the resolver (and the DB) saw only call 2.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);

    // The auto-filed investigation carries EXACTLY the incident's two texts, newest
    // first — and the "3×" in its title is the weighted count, not three failures.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('todo_update');
    expect(ev.recentFailures).toHaveLength(2);
    expect(ev.recentFailures[0]).toContain(`gateQuestionId "${FOREIGN_GATE}" matches no owner_questions row for this owner or your account`);
    const filedEnvelope = JSON.parse(ev.recentFailures[1]);
    expect(filedEnvelope).toMatchObject({
      ok: false, tool: 'todo_update', reason: 'ungrounded_id',
      rejected: [{ key: 'gateQuestionId', value: DEAD_CANARY }],
    });
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
  });

  it('first trip = one-round withhold, NOT perma: a same-tool call two rounds later EXECUTES (the probing lane keeps working)', async () => {
    mockExecuteCodingTool.mockResolvedValueOnce(RESOLVER_REFUSAL).mockResolvedValue('{"ok":true}');
    mockRunModelTurn
      .mockResolvedValueOnce(todoUpdateTurn(1, DEAD_CANARY))   // count 2
      .mockResolvedValueOnce(todoUpdateTurn(2, FOREIGN_GATE))  // count 3 → TRIP, withheld for steps 3-4
      .mockResolvedValueOnce(todoUpdateTurn(3, FOREIGN_GATE))  // refused: tool not offered (withheld)
      .mockResolvedValueOnce(todoUpdateTurn(4, FOREIGN_GATE))  // back on offer → executes (probe B analog)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    // Exactly TWO executions: the tripping call and the post-withhold recovery call.
    // The withheld round-3 call never reached the tool (toolNotOffered pre-flight).
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);
  });

  it('wiring seam: todo_update stays a preflight-covered platform tool (a regression here silently re-arms the incident)', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('todo_update');
    expect(PLATFORM_TOOL_NAMES).toContain('flag_owner_question'); // the refusal's recovery path stays offered
  });
});

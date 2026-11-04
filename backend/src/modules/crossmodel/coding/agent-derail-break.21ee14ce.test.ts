/**
 * Replay pin — ticket 21ee14ce (2026-09-20 breaker trip, session 521020fe
 * "Spark Lane Branch State Verification", run 1fba61e9).
 *
 * THE INCIDENT: the breaker auto-filed a "3× tool-failure streak:
 * send_chat_message" mishap with only TWO failure texts (newest first),
 * identical:
 *   · `Tool "send_chat_message" exceeded 900s and was aborted. Do not retry
 *     it; proceed with what you have.`
 *   · (same text)
 *
 * WHAT ACTUALLY HAPPENED (adjudication against primary sources, 2026-09-20):
 * the lane was mid-run on its RC-F2 §6 prep (fleet-event wake 19:34:38Z, run
 * started 19:35:54Z). It authored a pre-notice at ~20:19Z, armed two backstop
 * schedules successfully (Prisma+Redis healthy), then sent the pre-notices:
 *   · send #1 (~20:28Z, supervisor co-sign) HUNG in-process; the harness's
 *     generic hard-timeout race (agent.ts TOOL_HARD_TIMEOUT_MS = 15*60*1000;
 *     the Promise.race around runTool) resolved ~20:43Z with the abort text
 *     above — which explicitly says "Do not retry it".
 *   · The lane RETRIED send_chat_message anyway (streak 2) while its turn
 *     reasoning named update_plan — the intent-mismatch fast-trip (+1,
 *     tool-preflight.detectIntendedTool) made TWO failure-shaped results read
 *     as a "3×" trip at ~20:58:30Z. First trip ⇒ the tool was withheld for
 *     one round and this investigation was filed (never a perma-withhold).
 * The send then COMPLETED server-side at 20:58:44Z — the supervisor's
 * transcript carries the pre-notice row (msg 1a54b2a6) — proving the call
 * was starved, not deadlocked: a deterministic framework defect never
 * completes. The lane self-healed via its own armed backstop (fired
 * 20:59:19Z; supervisor co-signed 21:12:25Z).
 *
 * ROOT CAUSE of the hang: ENVIRONMENTAL, not framework — a rolling deploy
 * wave spanned the stall window (deploy run in_progress 19:57:35Z→≥21:03Z;
 * three machine_start_deferred_retiring rows at 20:58:33Z as a colour
 * retired; box-c worker heartbeat gap 20:53:51→21:08:51Z; both hung sends
 * completed the moment the wave passed; zero other send_chat_message streak
 * tickets that day across 173 runs/4h). The send path itself was reviewed
 * end-to-end (executePlatformTool → sendChatMessage → steer/start/queue):
 * every refusal/deferral branch returns fast by design (e.g. the retiring-
 * colour deferral in chat-agent.service.ts returns null immediately); no
 * blocking defect exists to fix.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — a retry
 * against an explicit do-not-retry plus a narration/emission mismatch (the
 * lane's FOURTH wrong-tool episode that day: harness run-end markers at
 * 17:34Z/19:26Z/19:32Z name list_schedules / git_status / search_memory) —
 * riding an environmental stall. NOT a deterministic framework defect: the
 * abort text is the generic hard-timeout backstop (unchanged in git
 * history), and the breaker counted exactly as designed — "3×" is the
 * WEIGHTED count (2 failures + 1 fast-trip), not three failures. No shape
 * exemption is warranted: a hard-timeout abort followed by an immediate
 * same-tool retry is precisely the derailment signal the streak counter
 * exists to catch (contrast the always-benign needsConfirmation envelope,
 * ticket 1ab1a52b, which IS exempt).
 *
 * These tests pin: the abort text's failure shape (the streak's input
 * contract), the intent-mismatch heuristic on the incident's wording, the
 * weighted trip math with exactly the two real texts filed newest-first, and
 * the first-trip one-round withhold (the lane keeps working after a trip).
 *
 * Scaffold mirrors agent-derail-break.ea69c94e.test.ts (same mock set).
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
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn(), buildCodeMatchesBlock: jest.fn(async () => '') }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
// Coding-kind runs build the workspace context block at run start (agent.ts
// :835-851) — stub every leg so the loop reaches the breaker, while keeping
// the REAL looksLikeToolFailure for the unit pins below.
jest.mock('./workspace.service', () => {
  const actual = jest.requireActual('./workspace.service');
  return { ...actual, buildRepoDivergenceNotice: jest.fn(async () => '') };
});
jest.mock('./learnings-index.service', () => {
  const actual = jest.requireActual('./learnings-index.service');
  return {
    ...actual,
    buildLearningsBlock: jest.fn(async () => ''),
    kickLearningsIndexSync: jest.fn(),
    sliceLearningsForInjection: jest.fn((s: string) => s),
    createFailureLearningNudger: jest.fn(() => async () => ''),
  };
});
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0), buildSessionMemoryInventory: jest.fn(async () => '') }));
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
import { detectIntendedTool } from './tool-preflight';
import { looksLikeToolFailure } from './learnings-index.service';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

const CODING_TEST_PROFILE: AgentProfile = {
  // Coding-kind, like the incident lane: detectIntendedTool convicts only
  // against the OFFERED tool set, and chat-kind runs filter to CHAT_ORCH_TOOLS
  // (agent.ts:924-928) — which has NO update_plan, so this exact mismatch
  // class (reasoning names update_plan) can only fast-trip on a coding seat.
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: true,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim ids and text (ticket 21ee14ce) ─────────────────
const SUPERVISOR_ID = '9e6e1712-8dc3-4e02-b70c-557bb5b41d2d'; // spark-cluster Supervisor (pre-notice target #1 — landed 20:58:44Z)
const FLASH_ID = '28de72e5-46c5-4a90-811d-840184efc106'; // GLM-5.3 Deployment on Dual Sparks (pre-notice target #2)
const ABORT_TEXT = 'Tool "send_chat_message" exceeded 900s and was aborted. Do not retry it; proceed with what you have.';

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-21ee14ce-test',
  sessionId: 'sess-21ee14ce',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage:
    `Prep complete — relay the §6 pre-notice to supervisor ${SUPERVISOR_ID} ` +
    `and the pair-state anchor to flash ${FLASH_ID}, then stand by.`,
  emit: jest.fn(),
});

/** A turn calling send_chat_message. Call 1 carries the incident's intent
 *  mismatch: the reasoning names update_plan and NEVER send_chat_message —
 *  detectIntendedTool convicts it (+1 fast-trip). Call 2 names nothing. */
const sendTurn = (n: number, reasoning: string) => ({
  content: '',
  reasoning,
  toolCalls: [{
    id: `s${n}`,
    name: 'send_chat_message',
    arguments: JSON.stringify({ chatId: SUPERVISOR_ID, content: `§6 PRE-NOTICE + co-sign request ${n}` }),
  }],
  finishReason: 'tool_calls',
});
const MISMATCH_REASONING = 'Marking the prep steps complete in update_plan, then the pre-notice relay goes out.';
const PLAIN_REASONING = 'Retrying the pre-notice relay now.';
const FINAL = { content: 'Pre-notices handled.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay 21ee14ce — two 900s-abort sends + intent mismatch read as a "3× send_chat_message streak"', () => {
  it('the hard-timeout abort text is failure-shaped (the streak counter input contract)', () => {
    expect(looksLikeToolFailure(ABORT_TEXT)).toBe(true);
    // …and a normal send success envelope is NOT — only the abort feeds the streak.
    expect(looksLikeToolFailure(JSON.stringify({ ok: true, ids: { chatId: SUPERVISOR_ID } }))).toBe(false);
  });

  it('the abort text carries the explicit do-not-retry the second call ignored', () => {
    expect(ABORT_TEXT).toContain('Do not retry it; proceed with what you have.');
  });

  it('detectIntendedTool convicts the incident wording (update_plan named, called tool never named)', () => {
    const offered = ['update_plan', 'send_chat_message', 'run_command', 'get_chat_messages'];
    expect(detectIntendedTool(MISMATCH_REASONING, 'send_chat_message', offered)).toBe('update_plan');
    // Guard against over-conviction: naming the CALLED tool clears the mismatch.
    expect(detectIntendedTool('Sending the pre-notice via send_chat_message now.', 'send_chat_message', offered)).toBeNull();
    // …and naming nothing convicts nothing.
    expect(detectIntendedTool(PLAIN_REASONING, 'send_chat_message', offered)).toBeNull();
  });

  it('END-TO-END: two abort-shaped sends + the call-1 intent mismatch trip the breaker at weighted count 3 with exactly the two real texts filed', async () => {
    mockExecuteCodingTool.mockResolvedValueOnce(ABORT_TEXT).mockResolvedValueOnce(ABORT_TEXT).mockResolvedValue('{"ok":true}');
    mockRunModelTurn
      .mockResolvedValueOnce(sendTurn(1, MISMATCH_REASONING)) // abort: streak 1 + intent fast-trip 1 = 2
      .mockResolvedValueOnce(sendTurn(2, PLAIN_REASONING))    // abort: streak 3 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // Both sends EXECUTED (the abort is the hard-timeout race's resolution,
    // not a pre-flight refusal — the chatId is shape-grounded, no ungrounded
    // fast-trip is in play).
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);

    // The auto-filed investigation carries the incident's exact evidence:
    // tool, exactly TWO texts (the "3×" is the weighted count), newest first.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('send_chat_message');
    expect(ev.recentFailures).toHaveLength(2);
    expect(ev.recentFailures[0]).toBe(ABORT_TEXT);
    expect(ev.recentFailures[1]).toBe(ABORT_TEXT);
    expect(ev.recentFailures[0]).toContain('Do not retry it');
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
  });

  it('first trip = one-round withhold, NOT perma: a same-tool call two rounds later EXECUTES (the lane keeps working)', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce(ABORT_TEXT)
      .mockResolvedValueOnce(ABORT_TEXT)
      .mockResolvedValue('{"ok":true,"ids":{"chatId":"' + SUPERVISOR_ID + '"}}');
    mockRunModelTurn
      .mockResolvedValueOnce(sendTurn(1, MISMATCH_REASONING)) // count 2
      .mockResolvedValueOnce(sendTurn(2, PLAIN_REASONING))    // count 3 → TRIP, withheld for the next round
      .mockResolvedValueOnce(sendTurn(3, PLAIN_REASONING))    // refused: tool not offered (withheld)
      .mockResolvedValueOnce(sendTurn(4, PLAIN_REASONING))    // back on offer → executes (recovery)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    // Exactly THREE executions: the two tripping calls and the post-withhold
    // recovery call. The withheld round-3 call never reached the tool.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(3);
  });

  it('wiring seam: send_chat_message stays a platform tool (a regression here silently re-arms the incident)', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('send_chat_message');
  });
});

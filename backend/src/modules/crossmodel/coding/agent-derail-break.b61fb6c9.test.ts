/**
 * Replay pin — ticket b61fb6c9 (2026-09-10 breaker trip, session
 * 536473e0-67e4-4213-83c8-6929fb9b3833, run fca18838-402a-4d31-8cbc-2258cf1227b7,
 * auto-filed 23:27:51Z).
 *
 * THE INCIDENT: burn-down lane 536473e0 was closing sibling mishap a5f4c3aa
 * and called update_feedback(status:'done') with a replayTestPath
 * (learnings-index.7c1e5b9f.test.ts) that cites the ROOT-CAUSE ticket prefix
 * 7c1e5b9f but never the ticket being closed. The verified-close gate
 * CORRECTLY refused — {"ok": false, "reason": "replay_test_unciting", …} with
 * an actionable message ("add a comment or test name carrying a5f4c3aa") —
 * and the lane re-called the same unciting close THREE TIMES. The structured
 * refusal envelope is failure-shaped by design (the 1ab1a52b exemption covers
 * ONLY needsConfirmation staging), so the 3× update_feedback streak tripped
 * the derail breaker and auto-filed b61fb6c9.
 *
 * ADJUDICATION: MODEL behavior, framework working AS DESIGNED. The breaker
 * exists to catch exactly this — a lane stuck re-calling a tool against a
 * refusal that already names the fix. The escape was one edit away (the
 * a5f4c3aa citation landed in learnings-index.a5f4c3aa.test.ts later the same
 * evening). NO code change: this pin locks the intended counting so a future
 * well-meaning "fix" cannot exempt actionable refusals and blind the breaker
 * to genuine stuck loops — and replays the incident end-to-end through the
 * real agent loop (the REAL looksLikeToolFailure runs; only the model and the
 * tool executor are mocked).
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

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-b61fb6c9-test',
  sessionId: 'sess-b61fb6c9',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'close the ticket',
  emit: jest.fn(),
});

/** A turn calling `name` once — a full uuid passes the id-grounding pre-flight (pins the classic 3-streak path). */
const callTurn = (name: string, n: number) => ({
  content: '',
  reasoning: '',
  toolCalls: [{
    id: `t${n}`,
    name,
    arguments: '{"id":"a5f4c3aa-33f3-464d-9cce-7fbeb264e958","status":"done","adminNote":"closing with the 7c1e5b9f replay pin","evidence":{"replayTestPath":"backend/src/modules/crossmodel/coding/learnings-index.7c1e5b9f.test.ts","commitSha":"d559a53ed35d8ea4f5ce37f23003543c864eeb10"}}',
  }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

// ── b61fb6c9's filed "Failure texts (newest first)" — verbatim ─────────────
// The verified-close gate's structured refusal (both filed texts are the same
// envelope; the 1200-char evidence capture ends mid-sentence as filed). The
// refusal names the exact remediation — the model retried verbatim instead.
const REFUSAL =
  '{\n "ok": false,\n "tool": "update_feedback",\n "reason": "replay_test_unciting",\n'
  + ' "ticketId": "a5f4c3aa-33f3-464d-9cce-7fbeb264e958",\n'
  + ' "message": "replayTestPath \\"backend/src/modules/crossmodel/coding/learnings-index.7c1e5b9f.test.ts\\" exists but never mentions this ticket\'s id prefix \\"a5f4c3aa\\" — a replay test must cite the ticket it pins (add a comment or test name carrying \\"a5f4c3aa\\"). Machine-triggered runs may only close a ticket to done with verifiable evidence: re-call update_feedback ';

/** What a corrected close attempt returns (the gate accepts; streak resets). */
const CLOSE_OK =
  '{\n "ok": true,\n "tool": "update_feedback",\n "ticketId": "a5f4c3aa-33f3-464d-9cce-7fbeb264e958",\n "status": "in_progress",\n "adminNote": "recorded"\n}';

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket b61fb6c9 — structured actionable refusals count as failures (breaker as designed)', () => {
  it('the incident replayed: 3 verbatim update_feedback refusals trip the breaker with the refusal texts as evidence', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce(REFUSAL) // streak 1 — gate refuses the unciting replayTestPath
      .mockResolvedValueOnce(REFUSAL) // streak 2 — verbatim retry
      .mockResolvedValueOnce(REFUSAL) // streak 3 — verbatim retry → TRIP
      .mockResolvedValue('ok');
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('update_feedback', 1))
      .mockResolvedValueOnce(callTurn('update_feedback', 2))
      .mockResolvedValueOnce(callTurn('update_feedback', 3))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // The breaker tripped and filed the streak for investigation — with the
    // REAL refusal texts, not a message-list scan (8579d419) and not a
    // phantom shape (7c1e5b9f): the ok:false envelope IS failure-shaped by
    // design (only needsConfirmation staging is exempt, 1ab1a52b).
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_feedback');
    expect(ev.recentFailures).toHaveLength(3);
    for (const text of ev.recentFailures) {
      expect(text).toMatch(/^\{\s*"ok":\s*false/);
      expect(text).toContain('"reason": "replay_test_unciting"');
      // The refusal's ACTIONABLE content (the missing citation and how to fix
      // it) survives into the filed evidence — the investigation lane can see
      // the model was told exactly what to do.
      expect(text).toContain('a5f4c3aa');
      expect(text).toContain('replay test must cite the ticket it pins');
    }
    // The cross-checker consult receives the same pure evidence object.
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
  });

  it('the escape that was available: a corrected call mid-streak resets the count — no trip, no ticket', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce(REFUSAL)  // streak 1
      .mockResolvedValueOnce(REFUSAL)  // streak 2
      .mockResolvedValueOnce(CLOSE_OK) // the model fixes the citation → success → streak RESETS
      .mockResolvedValueOnce(REFUSAL)  // streak 1 (fresh) — never reaches 3
      .mockResolvedValue(FINAL);
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('update_feedback', 1))
      .mockResolvedValueOnce(callTurn('update_feedback', 2))
      .mockResolvedValueOnce(callTurn('update_feedback', 3))
      .mockResolvedValueOnce(callTurn('update_feedback', 4))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // 2 refusals + success + 1 refusal never reaches 3 — the breaker only
    // fires when the model IGNORES the actionable refusal and retries
    // verbatim. That is why b61fb6c9 is adjudicated model behavior.
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
  });
});

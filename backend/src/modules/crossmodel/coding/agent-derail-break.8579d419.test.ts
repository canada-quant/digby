/**
 * Replay pin — ticket 8579d419 (2026-09-10 breaker trip, session 619a1241).
 *
 * THE INCIDENT: a fleet lane failed todo_get 3× (an 8-char prefix, then two
 * garbage-arg retries). Between those failures, OTHER tools succeeded
 * (get_chat_messages, list_chats). The reflection evidence collector scanned
 * the last 3 role:'tool' MESSAGES — tool-result messages carry no tool-name
 * field — so the auto-filed ticket's "Failure texts (newest first)" contained
 * two SUCCESSFUL get_chat_messages / list_chats outputs and only one real
 * failure. The same mislabeled blob fed the cross-checker consult as "recent
 * failure results".
 *
 * THE FIX: failure texts are captured AT STREAK-COUNTING TIME (the dispatch
 * loop has tc.name + result in scope) and ride the deferred notice —
 * never re-derived from the message list at trip time.
 *
 * These tests replay the incident's exact interleave and assert the filed
 * evidence contains ONLY the tripping tool's real failure texts.
 *
 * Scaffold mirrors agent-derail-break.test.ts (same mock set).
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
  worktree: '/tmp/derail-8579d419-test',
  sessionId: 'sess-8579d419',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'do the thing',
  emit: jest.fn(),
});

/** A turn calling `name` once — hex-shaped args pass the id-grounding pre-flight (pins the classic 3-streak path). */
const callTurn = (name: string, n: number) => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `t${n}`, name, arguments: `{"id":"deadbeef-${n}"}` }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** The incident's real failure shape (goals.service getTodoRow hint error). */
const todoFail = (given: string) =>
  `Tool todo_get failed: Todo not found: "${given}". Did you mean: eaad801c-3183-4ef6-8039-fa1d3e67b9ea ("FULL canlegal-bench calibration")? Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id)`;

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('streak evidence purity (replay pin, ticket 8579d419)', () => {
  it('interleaved OTHER-tool successes never enter the filed "Failure texts"', async () => {
    // The incident's exact interleave: todo_get fail → get_chat_messages OK →
    // todo_get fail → list_chats OK → todo_get fail ⇒ breaker trip. A success
    // from a DIFFERENT tool does not reset the streak (by design) — and must
    // not leak into the evidence either (the fix).
    const CHAT_OK = '{\n "chatId": "619a1241-b080-4630-bfc3-5aa5456b1cd0",\n "messages": []';
    const CHATS_OK = '{\n "id": "cec340f2-f605-4370-b87a-d85b59cb243f",\n "title": "Re-Send Path C Phase 2 Kickoff"';
    mockExecuteCodingTool
      .mockResolvedValueOnce(todoFail('eaad801c'))          // streak 1
      .mockResolvedValueOnce(CHAT_OK)                       // other tool, success — no reset
      .mockResolvedValueOnce(todoFail('{"id":"cec340f2…"}')) // streak 2
      .mockResolvedValueOnce(CHATS_OK)                      // other tool, success — no reset
      .mockResolvedValueOnce(todoFail('{"chatId":"619a1241…"}')) // streak 3 → TRIP
      .mockResolvedValue('ok');
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('todo_get', 1))
      .mockResolvedValueOnce(callTurn('get_chat_messages', 2))
      .mockResolvedValueOnce(callTurn('todo_get', 3))
      .mockResolvedValueOnce(callTurn('list_chats', 4))
      .mockResolvedValueOnce(callTurn('todo_get', 5))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('todo_get');
    expect(ev.recentFailures).toHaveLength(3);
    // Newest first — the LAST failure leads.
    expect(ev.recentFailures[0]).toMatch(/^Tool todo_get failed: Todo not found: "\{"chatId"/);
    for (const text of ev.recentFailures) {
      expect(text).toMatch(/^Tool todo_get failed:/);
      // The pre-fix bug: successful cross-tool outputs sat in this list.
      expect(text).not.toContain('Re-Send Path C');
      expect(text).not.toMatch(/^\{\s*"chatId"/);
    }
    // The consult receives the same evidence object — pure there too.
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
  });

  it('captured failure texts are capped at 1200 chars (memory hygiene; reflection slices further)', async () => {
    const LONG = `Tool todo_get failed: Todo not found: "${'x'.repeat(3000)}"`;
    mockExecuteCodingTool.mockResolvedValue(LONG);
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('todo_get', 1))
      .mockResolvedValueOnce(callTurn('todo_get', 2))
      .mockResolvedValueOnce(callTurn('todo_get', 3)) // trip
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.recentFailures.length).toBeGreaterThan(0);
    for (const text of ev.recentFailures) {
      expect(text.length).toBeLessThanOrEqual(1200);
      expect(text).toMatch(/^Tool todo_get failed:/);
    }
  });

  it('a same-tool SUCCESS mid-streak resets both the count and the captured texts', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce(todoFail('eaad801c')) // streak 1
      .mockResolvedValueOnce(todoFail('eaad801c')) // streak 2
      .mockResolvedValueOnce('{"id":"eaad801c-3183-4ef6-8039-fa1d3e67b9ea"}') // todo_get success → reset
      .mockResolvedValueOnce(todoFail('eaad801c')) // streak 1 (fresh)
      .mockResolvedValue(FINAL);
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('todo_get', 1))
      .mockResolvedValueOnce(callTurn('todo_get', 2))
      .mockResolvedValueOnce(callTurn('todo_get', 3))
      .mockResolvedValueOnce(callTurn('todo_get', 4))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // 2 fails + success + 1 fail never reaches 3 — no trip, no ticket.
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
  });
});

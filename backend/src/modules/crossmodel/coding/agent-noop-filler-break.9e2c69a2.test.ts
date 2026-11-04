/**
 * Replay pin — ticket 9e2c69a2 (2026-09-15 mishap, CanLaw Path C chat
 * cec340f2, schedule-fired run 66a8b4a6 on kimi-k3/moonshot).
 *
 * THE INCIDENT: a machine-triggered coding run (schedule firing 11:10:19Z)
 * believed the fleet/board tools (send_chat_message, todo_get/todo_update)
 * were missing from its toolset, narrated a hallucinated "TaskGet" board call,
 * and burned ~30 consecutive turns on run_command({"command":"true"}) — shell
 * no-ops — before writing "No chat-send or board tools exist in this run's
 * toolset" in its final. The prod event log (agent_events) shows ZERO attempts
 * to call a fleet tool and ZERO preflight refusals; the same chat's
 * continuation run 40 min earlier used send_chat_message successfully. Every
 * breaker missed the filler loop: no failures (true succeeds), run_command is
 * identical-call-exempt (REPEAT_BREAK_EXEMPT_TOOLS — rebuild/retry/poll
 * iteration), and the called name was offered (no tool_not_offered preflight).
 *
 * THE FIX: (1) the run_command identical-call exemption no longer covers SHELL
 * NO-OPS (isNoopShellCommand) — a filler loop trips the same one-round
 * withhold; (2) the break notice for that shape names the fleet tools the run
 * DOES have (counter-confabulation); (3) the first test pins provisioning
 * uniformity: a coding orchestrator run's per-turn schema carries the fleet
 * tools from round one (the ticket's "verify per-run tool provisioning" ask —
 * there is exactly one provisioning path for schedule-fired and continuation
 * runs alike).
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
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  fileStreakInvestigation: jest.fn(async () => undefined),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 12,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/noop-filler-9e2c69a2-test',
  sessionId: 'sess-9e2c69a2',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'do the thing',
  emit: jest.fn(),
});

/** Names in the tools array handed to one runModelTurn call (arg index 2). */
const toolNamesOf = (callIdx: number): string[] =>
  ((mockRunModelTurn.mock.calls[callIdx]?.[2] ?? []) as any[])
    .map((t: any) => t?.function?.name)
    .filter(Boolean);

/** All message contents handed to one runModelTurn call (arg index 1). */
const messageTextsOf = (callIdx: number): string[] =>
  ((mockRunModelTurn.mock.calls[callIdx]?.[1] ?? []) as any[])
    .map((m: any) => (typeof m?.content === 'string' ? m.content : ''))
    .filter(Boolean);

/** The incident's filler turn: one run_command shell no-op, identical args every time. */
const fillerTurn = (n: number) => ({
  content: '',
  reasoning: 'writing the board note via TaskGet next',
  toolCalls: [{ id: `t${n}`, name: 'run_command', arguments: '{"command":"true"}' }],
  finishReason: 'tool_calls',
});
const cmdTurn = (n: number, command: string) => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `t${n}`, name: 'run_command', arguments: JSON.stringify({ command }) }],
  finishReason: 'tool_calls',
});
const benignTurn = (n: number) => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: '{"steps":[{"text":"x","status":"in_progress"}]}' }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

describe('ticket 9e2c69a2 — no-op shell filler loop breaker + fleet-tool provisioning pin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _store.clear();
  });

  it('provisions the fleet/board tools into a coding orchestrator run from round one', async () => {
    // The ticket's "verify per-run tool provisioning" ask: one provisioning
    // path serves schedule-fired and continuation runs alike; the per-turn
    // schema carries the platform fleet tools (account tools stay behind
    // load_tool_group — progressive disclosure, 2026-09-09).
    mockRunModelTurn
      .mockResolvedValueOnce(benignTurn(1))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    const names = toolNamesOf(0);
    for (const fleet of ['send_chat_message', 'todo_get', 'todo_update', 'todo_list', 'goal_list', 'file_feedback']) {
      expect(names).toContain(fleet);
    }
    for (const account of ['get_account_overview', 'remember_fact', 'notify_user']) {
      expect(names).not.toContain(account);
    }
  });

  it('breaks the incident\'s exact run_command({"command":"true"}) filler loop and counters the confabulation', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(fillerTurn(1))
      .mockResolvedValueOnce(fillerTurn(2))
      .mockResolvedValueOnce(fillerTurn(3)) // 3rd identical no-op → TRIP
      .mockResolvedValueOnce(benignTurn(4)) // run_command withheld this round
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // 4th model round: run_command withheld from the schema …
    expect(toolNamesOf(3)).not.toContain('run_command');
    // … and the deferred notice tells the model the fleet tools DO exist.
    const notice = messageTextsOf(3).find((t) => t.includes('[HARNESS NOTICE'));
    expect(notice).toBeDefined();
    expect(notice).toContain('shell no-ops');
    expect(notice).toContain('send_chat_message');
    expect(notice).toContain('todo_update');
    expect(notice).toContain('temporarily removed');
    // Telemetry names the new shape.
    const strike = mockRecordLoopMetric.mock.calls
      .map((c) => c[0])
      .find((m) => m?.meta?.seam === 'tool_repeat_break');
    expect(strike).toBeDefined();
    expect(strike.meta.tool).toBe('run_command');
    expect(strike.meta.noopFiller).toBe(true);
    // One-round ban: run_command is back the round after.
    expect(toolNamesOf(4)).toContain('run_command');
  });

  it('keeps the run_command exemption for REAL commands (rebuild/retry iteration never trips)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(cmdTurn(1, 'npm test'))
      .mockResolvedValueOnce(cmdTurn(2, 'npm test'))
      .mockResolvedValueOnce(cmdTurn(3, 'npm test')) // identical, but a real command
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(toolNamesOf(3)).toContain('run_command');
    expect(mockRecordLoopMetric.mock.calls.some((c) => c[0]?.meta?.seam === 'tool_repeat_break')).toBe(false);
  });

  it('does not trip on scattered no-ops (repeat counter resets on a different signature)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(fillerTurn(1))
      .mockResolvedValueOnce(fillerTurn(2))
      .mockResolvedValueOnce(cmdTurn(3, 'git status --short')) // real work breaks the run
      .mockResolvedValueOnce(fillerTurn(4))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(toolNamesOf(4)).toContain('run_command');
    expect(mockRecordLoopMetric.mock.calls.some((c) => c[0]?.meta?.seam === 'tool_repeat_break')).toBe(false);
  });
});

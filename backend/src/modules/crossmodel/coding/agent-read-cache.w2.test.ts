/**
 * REPLAY — audit 2026-10-08 W2-12 (sota.md #4): identical read-only platform
 * calls within one run re-executed every time (schedule_get x481 in 52 h; in ONE
 * owner turn list_owner_questions x7, todo_list x5, list_chats x5). The loop now
 * serves an identical allowlisted read from its first result (with a "cached
 * from step k" note, no new receipt) until something state-changing runs.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({ __esModule: true, env: { NODE_ENV: 'test' } }));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn(), publish: jest.fn() },
}));
jest.mock('../github/github-mcp', () => ({ searchCode: jest.fn(), listIssues: jest.fn(), getIssue: jest.fn(), listPullRequests: jest.fn() }));
jest.mock('../google/google-mcp', () => ({
  resolveGoogleAccount: jest.fn(), getGmailMessages: jest.fn(), getGmailMessage: jest.fn(),
  getGmailAttachment: jest.fn(), getCalendarEvents: jest.fn(), listDriveFiles: jest.fn(),
  getDocContent: jest.fn(), getSheetData: jest.fn(),
}));
jest.mock('../slack/slack-mcp', () => ({ searchMessages: jest.fn(), listChannels: jest.fn(), getChannelHistory: jest.fn() }));
jest.mock('../asana/asana-mcp', () => ({ searchTasks: jest.fn(), listMyTasks: jest.fn(), listProjects: jest.fn() }));
jest.mock('../x/x-mcp', () => ({ search: jest.fn(), getUserProfile: jest.fn(), getTrends: jest.fn() }));
jest.mock('../xero/xero-mcp', () => ({ getOrganisation: jest.fn(), getContacts: jest.fn(), getInvoices: jest.fn() }));
jest.mock('../plaid/plaid-mcp', () => ({ getAccounts: jest.fn(), getBalances: jest.fn(), getTransactions: jest.fn() }));
jest.mock('../imessage/imessage.service', () => ({ getPrimaryAgent: jest.fn(), isOnline: jest.fn() }));
jest.mock('../imessage/agent-link', () => ({ agentBroker: { dispatch: jest.fn() } }));

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, seatUnservableReason: async () => null, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});
let toolN = 0;
const mockExecuteCodingTool: jest.Mock = jest.fn(async () => `ok result ${++toolN}`);
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

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
jest.mock('./coding-memory.service', () => ({
  __esModule: true,
  getUserCodingMemory: jest.fn(async () => null),
  getProjectMemory: jest.fn(async () => null),
  getSessionMemory: jest.fn(async () => null),
  formatCodingMemoryBlock: jest.fn(() => ''),
}));
jest.mock('./scaffolding.service', () => ({
  __esModule: true,
  assessDocsHealth: jest.fn(async () => ({ drift: [], nudgeSilenced: true, commandsUserOwned: false, autoRefreshable: true })),
}));
jest.mock('./container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({ __esModule: true, gatherSessionCredentialEnv: jest.fn(async () => ({})), credentialEnvNote: jest.fn(() => '') }));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn(), buildCodeMatchesBlock: jest.fn(async () => '') }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0), buildSessionMemoryInventory: jest.fn(async () => '') }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordRunSpend: jest.fn(),
  noteSeatFallback: jest.fn(),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', GOAL_CONTINUE: 'goal_continue', NO_PROGRESS_BRAKE: 'no_progress_brake', CONTEXT_BUDGET: 'context_budget' },
}));

const mockGetPlan: jest.Mock = jest.fn(async () => null);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlan: (...a: any[]) => mockGetPlan(...a),
}));

import { runCodingAgent, FINAL_TURN_NOTICE, CHECKPOINT_TURN_NOTICE } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

const profile = (maxSteps: number): AgentProfile => ({
  kind: 'coding', maxSteps, maxDelegations: 0, contextCharBudget: 100_000,
  workspaceTools: true, planReminders: false, memorySource: 'coding',
});
const makeInput = (sessionId: string): AgentRunInput => ({
  worktree: '/tmp/w2-12-read-cache-does-not-exist',
  sessionId, projectId: 'p1', userId: 'u1', permissionMode: 'ask', model: 'kimi-k3',
  projectName: 'test', branch: 'main', profile: profile(20),
  doctrineOverride: 'You are a test agent.', history: [],
  userMessage: 'drift-check the schedules', emit: jest.fn(),
});
const call = (id: string, name: string, args: Record<string, unknown>) => ({ content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const textTurn = (t: string) => ({ content: t, reasoning: '', toolCalls: [], finishReason: 'stop' });
const metrics = (kind: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === kind);
const executed = (name: string) => mockExecuteCodingTool.mock.calls.filter((c: any[]) => c[1] === name).length;

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  toolN = 0;
  delete process.env.RUN_READ_CACHE_DISABLED;
  mockExecuteCodingTool.mockImplementation(async (_ctx: any, name: string) => (name === 'schedule_get' ? '{"id":"d72b394a","intervalMinutes":60,"enabled":true}' : `ok result ${++toolN}`));
});

const script = (turns: any[]) => {
  let i = 0;
  mockRunModelTurn.mockImplementation(async (_p: any, _m: any, tools: any) => (tools && i < turns.length ? turns[i++] : textTurn('done')));
};

describe('audit 2026-10-08 W2-12 — per-run read cache', () => {
  it('REPLAY: the drift-check repeat — schedule_get x3 with the same id executes ONCE; the repeats say "cached from step"', async () => {
    script([
      call('a1', 'schedule_get', { id: 'd72b394a' }),
      call('a2', 'schedule_get', { id: 'd72b394a' }),
      call('a3', 'schedule_get', { id: ' d72b394a ' }), // whitespace-insensitive canonical args
    ]);
    await runCodingAgent(makeInput('sess-rc-1'));
    expect(executed('schedule_get')).toBe(1);
    const live = mockRunModelTurn.mock.calls[mockRunModelTurn.mock.calls.length - 1][1] as any[];
    const results = live.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(results).toHaveLength(3);
    expect(results[1]).toMatch(/^\(cached from step \d+/);
    expect(results[2]).toContain('"id":"d72b394a"');
    const row = metrics('run_read_cache')[0];
    expect(row).toMatchObject({ value: 2, meta: expect.objectContaining({ hits: 2, misses: 1 }) });
  });

  it('a state-changing call in between clears the cache (the read re-executes)', async () => {
    script([
      call('b1', 'schedule_get', { id: 'd72b394a' }),
      call('b2', 'update_schedule', { id: 'd72b394a', intervalMinutes: 120 }),
      call('b3', 'schedule_get', { id: 'd72b394a' }),
    ]);
    await runCodingAgent(makeInput('sess-rc-2'));
    expect(executed('schedule_get')).toBe(2);
  });

  it('different args are different reads', async () => {
    script([
      call('c1', 'schedule_get', { id: 'aaaa1111' }),
      call('c2', 'schedule_get', { id: 'bbbb2222' }),
    ]);
    await runCodingAgent(makeInput('sess-rc-3'));
    expect(executed('schedule_get')).toBe(2);
  });

  it('RUN_READ_CACHE_DISABLED=1 re-executes every read', async () => {
    process.env.RUN_READ_CACHE_DISABLED = '1';
    script([call('d1', 'schedule_get', { id: 'd72b394a' }), call('d2', 'schedule_get', { id: 'd72b394a' })]);
    await runCodingAgent(makeInput('sess-rc-4'));
    expect(executed('schedule_get')).toBe(2);
    expect(metrics('run_read_cache')).toHaveLength(0);
  });
});

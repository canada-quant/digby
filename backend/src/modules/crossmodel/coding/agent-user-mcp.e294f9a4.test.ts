/**
 * User-added MCP servers (ticket e294f9a4) — the agent-loop seam, over a REAL
 * agent loop and a mocked model turn (the agent-budget-final-turn harness):
 *   - the orchestrator / chat lead gets the user's mcp_<server>_<tool> schemas,
 *     the doctrine block in its system prompt and one progress line per
 *     omitted server; a by-name call routes to the run's MCP executor with the
 *     run's machine / turn context;
 *   - an unattended run asks for the MACHINE tool set;
 *   - a WORKER (role), an anonymous run and USER_MCP_DISABLED=1 never load it;
 *   - a load failure is non-fatal (the run continues without the tools);
 *   - an mcp_ call with no executor answers not_available.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
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
jest.mock('../github/github-mcp', () => ({ __esModule: true, isGitHubMcpConfigured: jest.fn(() => false), callGitHubMcpTool: jest.fn() }));
jest.mock('../google/google-mcp', () => ({ __esModule: true, isGoogleMcpConfigured: jest.fn(() => false), callGoogleMcpTool: jest.fn() }));
jest.mock('../imessage/agent-link', () => ({ agentBroker: { dispatch: jest.fn() } }));

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
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
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
jest.mock('./run-journal.service', () => ({ __esModule: true, getRecentJournalEntries: jest.fn(async () => []), formatJournalBlock: jest.fn(() => '') }));
jest.mock('./container.service', () => ({ __esModule: true, ensureSessionContainer: jest.fn(async () => false), execInContainer: jest.fn(), isContainerMode: jest.fn(() => false) }));
jest.mock('./session-credentials', () => ({ __esModule: true, gatherSessionCredentialEnv: jest.fn(async () => ({})), credentialEnvNote: jest.fn(() => '') }));
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
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  fileStreakInvestigation: jest.fn(async () => undefined),
}));

const MCP_SCHEMA = {
  type: 'function' as const,
  function: { name: 'mcp_linear_list_issues', description: '[MCP · Linear · read-only] List issues', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
};
const mockMcpExecute: jest.Mock = jest.fn(async () => '[MCP · Linear · list_issues]\nISSUE-7 open');
const mockLoadUserMcpRunTools: jest.Mock = jest.fn();
jest.mock('../user-mcp/user-mcp.service', () => ({
  __esModule: true,
  loadUserMcpRunTools: (...a: any[]) => mockLoadUserMcpRunTools(...a),
}));

import { runCodingAgent, runChatWorker } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

const CHAT_PROFILE: AgentProfile = {
  kind: 'chat', maxSteps: 6, maxDelegations: 0, contextCharBudget: 1_000_000, runDeadlineMs: 480_000,
  workspaceTools: false, planReminders: false, memorySource: 'chat',
};
const FINAL = { content: 'Linear has one open issue: ISSUE-7.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const mcpCallTurn = { content: '', reasoning: 'check Linear', toolCalls: [{ id: 't1', name: 'mcp_linear_list_issues', arguments: JSON.stringify({ q: 'open' }) }], finishReason: 'tool_calls' };

const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree: '/tmp/agent-user-mcp-test', sessionId: 'chat-mcp-1', projectId: 'p1', userId: 'user-1',
  permissionMode: 'auto', model: 'kimi-k3', projectName: 'test', branch: 'main',
  profile: CHAT_PROFILE, doctrineOverride: 'You are a test agent.', history: [], userMessage: 'What is open in Linear?',
  userTurnAt: new Date('2026-10-06T12:00:00Z'),
  emit: jest.fn(), ...over,
});
const runTools = () => ({
  schemas: [MCP_SCHEMA],
  names: new Set(['mcp_linear_list_issues']),
  doctrine: '\n\n## Your MCP servers (connected by the user in Account → Integrations)\n- Linear — 1 tool(s): mcp_linear_list_issues',
  statusLines: ['MCP server "Sentry" is UNHEALTHY (auth: HTTP 401) — its tools are omitted this run; Digby re-checks it automatically.'],
  serverHints: ['linear'],
  toolCount: 1,
  isReadOnly: (name: string) => (name === 'mcp_linear_list_issues' ? true : name === 'mcp_linear_create_issue' ? false : undefined),
  execute: mockMcpExecute,
});
const toolNamesOf = (call: any[]): string[] => ((call[2] ?? []) as any[]).map((t) => t?.function?.name).filter(Boolean);
const systemOf = (call: any[]): string => String(((call[1] ?? []) as any[]).find((m: any) => m?.role === 'system')?.content ?? '');

const ENV = { ...process.env };
beforeEach(() => {
  mockRunModelTurn.mockReset();
  mockMcpExecute.mockClear();
  mockLoadUserMcpRunTools.mockReset();
  mockExecuteCodingTool.mockClear();
  process.env = { ...ENV };
  delete process.env.USER_MCP_DISABLED;
});
afterAll(() => { process.env = ENV; });

describe('agent loop × user MCP servers (ticket e294f9a4)', () => {
  it('the chat lead is offered the mcp_ schema + doctrine, the omitted server gets ONE progress line, and the call routes to the MCP executor with the turn context', async () => {
    mockLoadUserMcpRunTools.mockResolvedValue(runTools());
    mockRunModelTurn.mockResolvedValueOnce(mcpCallTurn).mockResolvedValue(FINAL);
    const emit = jest.fn();
    const r = await runCodingAgent(makeInput({ emit }));
    expect(r.finalText).toBe(FINAL.content);
    expect(mockLoadUserMcpRunTools).toHaveBeenCalledWith('user-1', { machine: false });
    const first = mockRunModelTurn.mock.calls[0];
    expect(toolNamesOf(first)).toContain('mcp_linear_list_issues');
    expect(systemOf(first)).toMatch(/## Your MCP servers/);
    expect(emit).toHaveBeenCalledWith('progress', { message: expect.stringMatching(/^MCP server "Sentry" is UNHEALTHY/), stage: 'mcp' });
    expect(mockMcpExecute).toHaveBeenCalledWith('mcp_linear_list_issues', { q: 'open' }, expect.objectContaining({ userTurnAt: new Date('2026-10-06T12:00:00Z'), sessionId: 'chat-mcp-1' }));
    expect(mockExecuteCodingTool).not.toHaveBeenCalledWith(expect.anything(), 'mcp_linear_list_issues', expect.anything());
    // the tool result reached the model
    const second = mockRunModelTurn.mock.calls[1];
    expect(JSON.stringify(second[1])).toContain('ISSUE-7 open');
  });

  it('an unattended run (machineTriggered / no userTurnAt) asks for the MACHINE tool set', async () => {
    mockLoadUserMcpRunTools.mockResolvedValue(null);
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ userTurnAt: undefined, machineTriggered: true }));
    expect(mockLoadUserMcpRunTools).toHaveBeenCalledWith('user-1', { machine: true });
  });

  it('a worker (role), an anonymous run and USER_MCP_DISABLED=1 never load the user\'s MCP tools', async () => {
    mockLoadUserMcpRunTools.mockResolvedValue(runTools());
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runChatWorker(makeInput(), 'web_researcher');
    await runCodingAgent(makeInput({ sessionId: 'anon-abc' }));
    process.env.USER_MCP_DISABLED = '1';
    await runCodingAgent(makeInput());
    expect(mockLoadUserMcpRunTools).not.toHaveBeenCalled();
    for (const call of mockRunModelTurn.mock.calls) expect(toolNamesOf(call)).not.toContain('mcp_linear_list_issues');
  });

  it('the session permission mode governs a tool that CHANGES data: PLAN blocks it, ASK on an unattended run auto-denies it, AUTO runs it — reads always run', async () => {
    const writeTurn = { content: '', reasoning: 'file it', toolCalls: [{ id: 'w1', name: 'mcp_linear_create_issue', arguments: JSON.stringify({ title: 'x' }) }], finishReason: 'tool_calls' };
    const tools = () => ({ ...runTools(), schemas: [MCP_SCHEMA, { ...MCP_SCHEMA, function: { ...MCP_SCHEMA.function, name: 'mcp_linear_create_issue' } }] });
    const resultOf = (): string => JSON.stringify(mockRunModelTurn.mock.calls[1][1]);

    mockLoadUserMcpRunTools.mockResolvedValue(tools());
    mockRunModelTurn.mockResolvedValueOnce(writeTurn).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ permissionMode: 'plan' }));
    expect(resultOf()).toContain('Blocked in PLAN mode: mcp_linear_create_issue changes data');
    expect(mockMcpExecute).not.toHaveBeenCalled();

    mockRunModelTurn.mockReset();
    mockRunModelTurn.mockResolvedValueOnce(writeTurn).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ permissionMode: 'ask', userTurnAt: undefined, machineTriggered: true }));
    expect(resultOf()).toContain('AUTO-DENIED: mcp_linear_create_issue changes data');
    expect(mockMcpExecute).not.toHaveBeenCalled();

    mockRunModelTurn.mockReset();
    mockRunModelTurn.mockResolvedValueOnce(mcpCallTurn).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ permissionMode: 'plan' }));
    expect(mockMcpExecute).toHaveBeenCalledTimes(1); // a read runs even in PLAN

    mockRunModelTurn.mockReset();
    mockRunModelTurn.mockResolvedValueOnce(writeTurn).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ permissionMode: 'auto' }));
    expect(mockMcpExecute).toHaveBeenLastCalledWith('mcp_linear_create_issue', { title: 'x' }, expect.anything());
  });

  it('a load failure is non-fatal: the run continues without MCP tools, and a by-name mcp_ call answers not_available', async () => {
    mockLoadUserMcpRunTools.mockRejectedValue(new Error('store down'));
    mockRunModelTurn.mockResolvedValueOnce(mcpCallTurn).mockResolvedValue(FINAL);
    const r = await runCodingAgent(makeInput());
    expect(r.finalText).toBe(FINAL.content);
    expect(toolNamesOf(mockRunModelTurn.mock.calls[0])).not.toContain('mcp_linear_list_issues');
    expect(mockMcpExecute).not.toHaveBeenCalled();
  });
});

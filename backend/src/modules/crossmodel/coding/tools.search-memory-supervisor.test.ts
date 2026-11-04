/**
 * fs-durable-memory (2026-10-22): the search_memory TOOL on a supervisor chat.
 * The chat agent hands every projectless chat the placeholder projectId
 * 'chat'; on the Fleet Supervisor the tool passed it straight into
 * searchMemory (a project scope that never authorizes) and searched only the
 * session scope. Now a supervisor chat drops the placeholder and adds its own
 * chat scope + its own conversation distills (supervisor-search-scopes.ts);
 * every other chat is untouched, and SUPERVISOR_SEARCH_MEMORY_SCOPES_DISABLED=1
 * restores the old call.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../platform/platform.service', () => ({ __esModule: true }));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  FEEDBACK_TYPES: ['feature_request', 'general_feedback', 'mishap', 'enhancement', 'research_idea'],
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
const mockSearchMemory: jest.Mock = jest.fn(async (): Promise<any[]> => []);
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: (...a: any[]) => mockSearchMemory(...a),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
  buildSessionMemoryInventory: jest.fn(async () => ''),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: {
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_SIZE_GUARD: 'merge_size_guard', GUARD_STRIKE: 'guard_strike',
  },
}));
jest.mock('./process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(),
  waitForProcessOutput: jest.fn(),
  readProcessOutput: jest.fn(),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(),
  listProcesses: jest.fn(),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('./code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));
// The supervisor flag is ONE row read through supervisor-state.service (dynamic import in the tool).
const mockSupervisorChatFlag: jest.Mock = jest.fn(async (): Promise<boolean | null> => true);
jest.mock('../platform/supervisor-state.service', () => ({
  __esModule: true,
  supervisorChatFlag: (...a: any[]) => mockSupervisorChatFlag(...a),
}));

import { executeCodingTool, ToolContext } from './tools';

const FS_CHAT = 'fs-chat-1';
const OWNER = 'owner-1';

const mkCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
  worktree: '', sessionId: FS_CHAT, userId: OWNER, permissionMode: 'auto', projectId: 'chat',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: async () => 'allow' as const,
  execShell: async () => ({ stdout: '', stderr: '' }),
  agentSurface: 'chat',
  ...over,
} as unknown as ToolContext);

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SUPERVISOR_SEARCH_MEMORY_SCOPES_DISABLED;
  mockSupervisorChatFlag.mockResolvedValue(true);
  mockSearchMemory.mockResolvedValue([]);
});
afterAll(() => { delete process.env.SUPERVISOR_SEARCH_MEMORY_SCOPES_DISABLED; });

describe('search_memory on a supervisor chat', () => {
  it("searches the chat + own conversation scopes and never the 'chat' placeholder project", async () => {
    const out = await executeCodingTool(mkCtx(), 'search_memory', { query: 'what did the owner decide about billing' });
    expect(mockSupervisorChatFlag).toHaveBeenCalledWith(FS_CHAT);
    expect(mockSearchMemory).toHaveBeenCalledTimes(1);
    const [sessionId, , , opts] = mockSearchMemory.mock.calls[0];
    expect(sessionId).toBe(FS_CHAT);
    expect(opts.projectId).toBeUndefined();
    expect(opts.chatScopeId).toBe(FS_CHAT);
    expect(opts.conversationRef).toBe(FS_CHAT);
    expect(opts.userId).toBe(OWNER); // the caller's own id — the gate in searchMemory scopes every leg to it
    expect(out).toContain('supervisor-state ledger');
  });

  it("scope 'project' on the Fleet Supervisor is refused honestly (no project) instead of searching 'chat'", async () => {
    const out = await executeCodingTool(mkCtx(), 'search_memory', { query: 'q', scope: 'project' });
    expect(out).toContain('Project-scope memory is unavailable');
    expect(mockSearchMemory).not.toHaveBeenCalled();
  });

  it('results carry the coverage note', async () => {
    mockSearchMemory.mockResolvedValue([{ ref: FS_CHAT, source: 'conversation', content: 'Q: billing?\nmoved to the new Stripe account' }]);
    const out = await executeCodingTool(mkCtx(), 'search_memory', { query: 'billing' });
    expect(out).toContain('(conversation · fs-chat-1)');
    expect(out).toContain('NOTE: searched this run');
  });

  it("a source filter narrows the coverage note to what was actually searched (review 2026-10-22)", async () => {
    // 'learning' excludes both supervisor stores — the note must not claim the ledger or the past exchanges.
    const out = await executeCodingTool(mkCtx(), 'search_memory', { query: 'billing', source: 'learning' });
    expect(mockSearchMemory.mock.calls[0][3].sources).toEqual(['learning']);
    const searchedPart = out.split('NOT searched')[0];
    expect(searchedPart).not.toContain('supervisor-state ledger');
    expect(searchedPart).not.toContain('past exchanges');
    expect(out).toContain("source 'learning'");
    expect(out).toMatch(/NOT searched[^)]*supervisor-state ledger/);
    expect(out).toMatch(/NOT searched[^)]*past exchanges/);
  });

  it("source 'supervisor_state' names the ledger as searched and the past exchanges as NOT searched", async () => {
    const out = await executeCodingTool(mkCtx(), 'search_memory', { query: 'billing', source: 'supervisor_state' });
    const [searchedPart, notSearched] = out.split('NOT searched');
    expect(searchedPart).toContain('supervisor-state ledger');
    expect(searchedPart).not.toContain('past exchanges');
    expect(notSearched).toContain('past exchanges');
    expect(notSearched).not.toContain('supervisor-state ledger');
  });

  it('a MACHINE wake on a supervisor chat gets the whole answer through the chat-read redactor; an owner turn reads its own words (review 2026-10-23)', async () => {
    const KEY = 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAB7CD0EF3GH6';
    mockSearchMemory.mockResolvedValue([{ ref: FS_CHAT, source: 'supervisor_state', content: `Directive d1: use ${KEY} for the gateway` }]);
    const machine = await executeCodingTool(mkCtx(), 'search_memory', { query: 'gateway key' });
    expect(machine).not.toContain('sk-proj-Ab3d');
    expect(machine).toContain('[REDACTED: looked like a credential]');
    const owner = await executeCodingTool(mkCtx({ userTurnAt: new Date() } as any), 'search_memory', { query: 'gateway key' });
    expect(owner).toContain(KEY);
  });

  it('a non-supervisor chat keeps the old call (placeholder project, no extra scopes)', async () => {
    mockSupervisorChatFlag.mockResolvedValue(false);
    await executeCodingTool(mkCtx({ sessionId: 'plain-chat' }), 'search_memory', { query: 'q' });
    const opts = mockSearchMemory.mock.calls[0][3];
    expect(opts.projectId).toBe('chat');
    expect(opts.chatScopeId).toBeUndefined();
    expect(opts.conversationRef).toBeUndefined();
  });

  it('a failed flag read is treated as not-a-supervisor (old call)', async () => {
    mockSupervisorChatFlag.mockRejectedValue(new Error('db down'));
    await executeCodingTool(mkCtx(), 'search_memory', { query: 'q' });
    expect(mockSearchMemory.mock.calls[0][3].chatScopeId).toBeUndefined();
  });

  it('an anonymous run never reads the flag', async () => {
    await executeCodingTool(mkCtx({ userId: 'anonymous' }), 'search_memory', { query: 'q' });
    expect(mockSupervisorChatFlag).not.toHaveBeenCalled();
    expect(mockSearchMemory.mock.calls[0][3].userId).toBeUndefined();
  });

  it('kill switch: the old call byte-for-byte (placeholder project, no supervisor scopes, no flag read)', async () => {
    process.env.SUPERVISOR_SEARCH_MEMORY_SCOPES_DISABLED = '1';
    await executeCodingTool(mkCtx(), 'search_memory', { query: 'q' });
    expect(mockSupervisorChatFlag).not.toHaveBeenCalled();
    const opts = mockSearchMemory.mock.calls[0][3];
    expect(opts.projectId).toBe('chat');
    expect(opts.chatScopeId).toBeUndefined();
    expect(opts.conversationRef).toBeUndefined();
  });
});

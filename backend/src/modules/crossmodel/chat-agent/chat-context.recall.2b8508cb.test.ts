/**
 * Ticket 2b8508cb — [SUPERVISOR STATE (retrieved)] on the HUMAN-TURN context
 * seam (chat-context.ts buildChatQueryContext): an owner-typed supervisor
 * turn (and every non-machine context rebuild) carries the semantic recall
 * block from the embedded `supervisor_state` rows, prepended to
 * systemContext. The machine-wake seam is pinned in
 * chat-agent.supervisor-state-recall.2b8508cb.test.ts; the memory bridge
 * itself in supervisor-state-memory.test.ts.
 * Harness copied from chat-context.supervisor-journal.9993f30c.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockRedis = { get: jest.fn(), setEx: jest.fn(), del: jest.fn() };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn() },
  projectDocument: { count: jest.fn() },
  crossModelProject: { count: jest.fn(async () => 1), findMany: jest.fn(async () => []) },
  chatFile: { findMany: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../context.service', () => ({
  __esModule: true,
  default: { loadChatContext: jest.fn(async () => ({ conversationHistory: [], userMemoryBlock: undefined })), loadSessionContext: jest.fn(async () => ({ conversationHistory: [], userMemoryBlock: undefined })) },
}));
jest.mock('../rag.service', () => ({
  retrieveChunks: jest.fn(async () => []),
  retrieveGlobalChunks: jest.fn(async () => []),
  buildContextBlock: jest.fn(() => ''),
  buildCrossProjectBlock: jest.fn(() => ''),
}));
jest.mock('../platform/folder-inheritance', () => ({
  foldersInheritanceOn: () => true,
  getEffectiveSystemPrompt: jest.fn(async () => null),
  getRagScopeFolderIds: jest.fn(),
}));
jest.mock('../langgraph/memory.graph', () => ({
  getEnrichedContext: jest.fn(async () => ({ conversationHistory: [], userMemoryBlock: undefined, projectStateBlock: '' })),
  getProjectSettings: jest.fn(),
}));
jest.mock('../memory/unified-memory.service', () => ({
  memSearchProjectsBlended: jest.fn(async () => []),
  memSearch: jest.fn(),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { MEMORY_SEARCH_TIMING: 'memory_search_timing' },
}));

// The journal seam (9993f30c) — off, so only THIS seam's block composes.
jest.mock('../coding/run-journal.service', () => ({
  __esModule: true,
  buildSupervisorJournalBlock: jest.fn(async () => ''),
}));

// THE SEAM UNDER TEST — the supervisor-state memory bridge, mocked at the
// module boundary (internals pinned in supervisor-state-memory.test.ts).
const mockBuildRecall: jest.Mock = jest.fn(async () => '');
jest.mock('../platform/supervisor-state-memory', () => ({
  __esModule: true,
  buildSupervisorStateRecallBlock: (...a: any[]) => mockBuildRecall(...(a as [any, any, any])),
}));

import { buildChatQueryContext } from './chat-context';

const RECALL_BLOCK = '[SUPERVISOR STATE (retrieved) — semantic hits from your durable state doc — the wake block above is a 6000-char window; these are the rows most relevant to this turn, newest first]\n- (directive dir-backup) Directive dir-backup (2026-09-20): keep the backup budget under 40 dollars a day — status: open';

const BASE_CTX = {
  userId: 'u1',
  chatId: 'chat-sup-ctx-1',
  sessionId: null as string | null,
  message: 'owner status question',
  mode: 'single_thinking' as const,
  modelSet: 'open_source' as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockBuildRecall.mockReset().mockResolvedValue('');
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ systemPrompt: null });
  delete process.env.SUPERVISOR_STATE_RECALL_DISABLED;
});
afterEach(() => { delete process.env.SUPERVISOR_STATE_RECALL_DISABLED; });

describe('supervisor-state recall — the human-turn context seam (2b8508cb)', () => {
  it('a supervisor turn carries the recall block in systemContext', async () => {
    mockBuildRecall.mockResolvedValue(RECALL_BLOCK);
    const ctx = await buildChatQueryContext({ ...BASE_CTX, isSupervisorChat: true });
    expect(mockBuildRecall).toHaveBeenCalledWith('chat-sup-ctx-1', 'owner status question', 5);
    expect(ctx.systemContext).toContain('[SUPERVISOR STATE (retrieved)');
    expect(ctx.systemContext).toContain('keep the backup budget under 40 dollars a day');
  });

  it('a supervisor turn with NO hits gets no header (context byte-identical)', async () => {
    mockBuildRecall.mockResolvedValue('');
    const ctx = await buildChatQueryContext({ ...BASE_CTX, isSupervisorChat: true });
    expect(mockBuildRecall).toHaveBeenCalledWith('chat-sup-ctx-1', 'owner status question', 5);
    expect(ctx.systemContext).not.toContain('SUPERVISOR STATE (retrieved)');
  });

  it('a PLAIN chat turn (isSupervisorChat unset) never queries the recall', async () => {
    mockBuildRecall.mockResolvedValue(RECALL_BLOCK);
    const ctx = await buildChatQueryContext({ ...BASE_CTX });
    expect(mockBuildRecall).not.toHaveBeenCalled();
    expect(ctx.systemContext).not.toContain('SUPERVISOR STATE (retrieved)');
  });

  it('kill switch SUPERVISOR_STATE_RECALL_DISABLED=1: the builder is never called', async () => {
    process.env.SUPERVISOR_STATE_RECALL_DISABLED = '1';
    mockBuildRecall.mockResolvedValue(RECALL_BLOCK);
    const ctx = await buildChatQueryContext({ ...BASE_CTX, isSupervisorChat: true });
    expect(mockBuildRecall).not.toHaveBeenCalled();
    expect(ctx.systemContext).not.toContain('SUPERVISOR STATE (retrieved)');
  });

  it('a MACHINE wake skips this seam — the block already rides the composed wake message, never twice', async () => {
    mockBuildRecall.mockResolvedValue(RECALL_BLOCK);
    const ctx = await buildChatQueryContext({ ...BASE_CTX, isSupervisorChat: true, machineWake: true });
    expect(mockBuildRecall).not.toHaveBeenCalled();
    expect(ctx.systemContext).not.toContain('SUPERVISOR STATE (retrieved)');
  });

  it('a builder throw degrades to no block — never breaks the turn (fail-open)', async () => {
    mockBuildRecall.mockRejectedValue(new Error('memory store down'));
    const ctx = await buildChatQueryContext({ ...BASE_CTX, isSupervisorChat: true });
    expect(ctx.systemContext).not.toContain('SUPERVISOR STATE (retrieved)');
    expect(typeof ctx.systemContext).toBe('string');
  });
});

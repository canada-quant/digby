/**
 * SUPERVISOR RUN JOURNAL — the HUMAN-TURN read seam (ticket 9993f30c).
 * The machine-wake seam (startDetachedChatRun's supervisorStateBlock) and the
 * WRITE seam are pinned in chat-agent.supervisor-journal.9993f30c.test.ts; this
 * file pins the OTHER supervisor prompt surface: buildChatQueryContext with
 * isSupervisorChat — an owner-typed supervisor turn (and every re-fire that
 * rebuilds context) carries [PREVIOUS SUPERVISOR TURNS IN THIS CHAT] from the
 * chat's own run journal, prepended to systemContext.
 *  - supervisor turn + journal rows → block prepended, newest entry present;
 *  - supervisor turn + EMPTY journal → context byte-identical (no header);
 *  - a plain chat turn (isSupervisorChat unset) never reads the journal;
 *  - kill switch SUPERVISOR_RUN_JOURNAL_DISABLED=1 → no read;
 *  - a builder throw degrades to no block (fail-open).
 * The journal module is mocked at the boundary; its renderer is pinned in
 * run-journal.service.test.ts. Harness copied from
 * chat-context.fleet-learnings.a6ba3fda.test.ts.
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

// THE SEAM UNDER TEST — the supervisor journal block builder, mocked at the
// module boundary (renderer pinned in run-journal.service.test.ts).
const mockBuildSupervisorJournalBlock: jest.Mock = jest.fn(async () => '');
jest.mock('../coding/run-journal.service', () => ({
  __esModule: true,
  buildSupervisorJournalBlock: (...a: any[]) => mockBuildSupervisorJournalBlock(...(a as [])),
}));

import { buildChatQueryContext } from './chat-context';

const JOURNAL_BLOCK = '[PREVIOUS SUPERVISOR TURNS IN THIS CHAT — your own run journal, harness-written; what earlier turns did and the receipt ids that back them; newest first]\n- 2026-10-16 21:02Z · trigger=machine\n  Goal: SUPERVISOR TURN — sweep the fleet for attention items\n  Outcome: One stalled lane re-queued; board cited verbatim.';

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
  mockBuildSupervisorJournalBlock.mockReset().mockResolvedValue('');
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ systemPrompt: null });
  delete process.env.SUPERVISOR_RUN_JOURNAL_DISABLED;
});
afterEach(() => { delete process.env.SUPERVISOR_RUN_JOURNAL_DISABLED; });

describe('supervisor run journal — the human-turn context seam (9993f30c)', () => {
  it('a supervisor turn with journal rows carries the block in systemContext (near the top, ahead of the AI-rules tail)', async () => {
    mockBuildSupervisorJournalBlock.mockResolvedValue(JOURNAL_BLOCK);
    const ctx = await buildChatQueryContext({ ...BASE_CTX, isSupervisorChat: true });
    expect(mockBuildSupervisorJournalBlock).toHaveBeenCalledWith('chat-sup-ctx-1');
    expect(ctx.systemContext).toContain('[PREVIOUS SUPERVISOR TURNS IN THIS CHAT');
    expect(ctx.systemContext).toContain('sweep the fleet for attention items');
    // placement: the journal rides ABOVE the shared-rules tail (an early,
    // prominent position in the assembled prompt).
    expect(ctx.systemContext.indexOf('[PREVIOUS SUPERVISOR TURNS')).toBeLessThan(ctx.systemContext.indexOf('SHARED AI RULES') >= 0 ? ctx.systemContext.indexOf('SHARED AI RULES') : ctx.systemContext.length);
  });

  it('a supervisor turn with an EMPTY journal gets no header (context byte-identical)', async () => {
    mockBuildSupervisorJournalBlock.mockResolvedValue('');
    const ctx = await buildChatQueryContext({ ...BASE_CTX, isSupervisorChat: true });
    expect(mockBuildSupervisorJournalBlock).toHaveBeenCalledWith('chat-sup-ctx-1');
    expect(ctx.systemContext).not.toContain('PREVIOUS SUPERVISOR TURNS');
  });

  it('a PLAIN chat turn (isSupervisorChat unset) never reads the journal', async () => {
    mockBuildSupervisorJournalBlock.mockResolvedValue(JOURNAL_BLOCK);
    const ctx = await buildChatQueryContext({ ...BASE_CTX });
    expect(mockBuildSupervisorJournalBlock).not.toHaveBeenCalled();
    expect(ctx.systemContext).not.toContain('PREVIOUS SUPERVISOR TURNS');
  });

  it('kill switch SUPERVISOR_RUN_JOURNAL_DISABLED=1: the builder is never called', async () => {
    process.env.SUPERVISOR_RUN_JOURNAL_DISABLED = '1';
    mockBuildSupervisorJournalBlock.mockResolvedValue(JOURNAL_BLOCK);
    const ctx = await buildChatQueryContext({ ...BASE_CTX, isSupervisorChat: true });
    expect(mockBuildSupervisorJournalBlock).not.toHaveBeenCalled();
    expect(ctx.systemContext).not.toContain('PREVIOUS SUPERVISOR TURNS');
  });

  it('a MACHINE wake skips this seam (review M1) — the block already rides the composed wake message, never twice', async () => {
    mockBuildSupervisorJournalBlock.mockResolvedValue(JOURNAL_BLOCK);
    const ctx = await buildChatQueryContext({ ...BASE_CTX, isSupervisorChat: true, machineWake: true });
    expect(mockBuildSupervisorJournalBlock).not.toHaveBeenCalled();
    expect(ctx.systemContext).not.toContain('PREVIOUS SUPERVISOR TURNS');
  });

  it('a builder throw degrades to no block — never breaks the turn (fail-open)', async () => {
    mockBuildSupervisorJournalBlock.mockRejectedValue(new Error('journal read failed'));
    const ctx = await buildChatQueryContext({ ...BASE_CTX, isSupervisorChat: true });
    expect(ctx.systemContext).not.toContain('PREVIOUS SUPERVISOR TURNS');
    // and the rest of the context still assembled:
    expect(typeof ctx.systemContext).toBe('string');
  });
});

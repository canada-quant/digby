/**
 * loadChatContextNode — the empty-history fallback (backlog audit PE-12, 2026-09-28).
 *
 * "LangGraph returned empty history … falling back to direct DB load" warned
 * 65× / 7 d in prod; every sampled row (12/12 over 48 h) was the FIRST message
 * of a new chat — nothing was lost. Pins:
 *   - an empty history still triggers the direct DB load (the v174 safety net);
 *   - WARN only when that load finds messages (a real loss, now recovered);
 *   - a genuinely empty chat logs at DEBUG — never a warn.
 *
 * Mocking mirrors chat-context.project-learnings.test.ts.
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
  crossModelProject: { count: jest.fn(async () => 1) },
  chatFile: { findMany: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockLoadChatContext = jest.fn();
jest.mock('../context.service', () => ({
  __esModule: true,
  default: { loadChatContext: (...a: any[]) => mockLoadChatContext(...a), loadSessionContext: jest.fn() },
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
  getRagScopeFolderIds: jest.fn(async () => ['P']),
}));
jest.mock('../langgraph/memory.graph', () => ({
  getEnrichedContext: jest.fn(),
  getProjectSettings: jest.fn(async () => ({ crossProjectMemory: false })),
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

import { buildChatQueryContext } from './chat-context';
import { getEnrichedContext } from '../langgraph/memory.graph';
import logger from '../../../utils/logger';

const mockEnriched = getEnrichedContext as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  // A plain (non-project) chat so the RAG arm stays out of the way.
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ projectId: null, systemPrompt: null, project: null });
  mockPrisma.projectDocument.count.mockResolvedValue(0);
  mockPrisma.chatFile.findMany.mockResolvedValue([]);
  mockRedis.get.mockResolvedValue('[INTEGRATIONS]\ncached\n[/INTEGRATIONS]');
  mockEnriched.mockResolvedValue({ conversationHistory: [], userMemoryBlock: '', projectStateBlock: '' });
});

const run = () => buildChatQueryContext({ userId: 'alice', chatId: 'chat1', message: 'hello there', mode: 'thinking', modelSet: 'open_source' });
const warns = () => (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0]));
const debugs = () => (logger.debug as jest.Mock).mock.calls.map((c) => String(c[0]));

describe('loadChatContextNode — empty history from the enriched load (PE-12)', () => {
  it('a NEW chat (the DB has no prior messages) logs at DEBUG, never a warn — the direct load still runs once', async () => {
    mockLoadChatContext.mockResolvedValue({ conversationHistory: [], userMemoryBlock: '' });
    const ctx = await run();
    expect(mockLoadChatContext).toHaveBeenCalledTimes(1);
    expect(mockLoadChatContext).toHaveBeenCalledWith('chat1', 'alice', 'hello there', expect.objectContaining({ deepHistory: undefined }));
    expect(ctx.conversationHistory).toEqual([]);
    expect(warns().some((m) => m.includes('empty history'))).toBe(false);
    expect(debugs().some((m) => m.includes('no prior messages for chat chat1 (first turn)'))).toBe(true);
  });

  it('a REAL loss (the DB holds messages the enriched load dropped) is recovered and WARNED with the count', async () => {
    const recovered = [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }];
    mockLoadChatContext.mockResolvedValue({ conversationHistory: recovered, userMemoryBlock: '' });
    const ctx = await run();
    expect(ctx.conversationHistory).toEqual(recovered);
    expect(warns().some((m) => m.includes('returned empty history for chat chat1 but the DB holds 3 message(s) — recovered via direct DB load'))).toBe(true);
    expect(debugs().some((m) => m.includes('first turn'))).toBe(false);
  });

  it('a non-empty enriched history never touches the fallback loader', async () => {
    mockEnriched.mockResolvedValue({ conversationHistory: [{ role: 'user', content: 'earlier' }], userMemoryBlock: '', projectStateBlock: '' });
    const ctx = await run();
    expect(mockLoadChatContext).not.toHaveBeenCalled();
    expect(ctx.conversationHistory).toEqual([{ role: 'user', content: 'earlier' }]);
    expect(warns().some((m) => m.includes('empty history'))).toBe(false);
  });
});

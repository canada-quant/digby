/**
 * thread-state-ops.test.ts — the thread extractor as per-item ops (2026-10-20 memory wave).
 *
 * The thread node used to ask the model to re-emit the whole {threadSummary, confirmedFacts,
 * openTopics, lastUserGoal} object every turn (2000-token budget — the same echo class that
 * outgrew the profile and project budgets). In ops mode it is shown the state with an [id] per
 * fact / topic and answers only the change. Driven through the REAL pipeline; the provenance guard
 * (ticket 65aa3682) and the ungrounded-answer filter (W4-2) still run on the result.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    userMemory: { findUnique: jest.fn(async () => ({ facts: {} })), upsert: jest.fn(async () => ({ facts: {} })) },
    crossModelChat: { findMany: jest.fn(async () => []) },
    crossModelMessage: { findMany: jest.fn(async () => []) },
  },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), get: jest.fn(async () => null) },
}));
jest.mock('../context.service', () => ({
  __esModule: true,
  default: { loadChatContext: jest.fn(async () => ({ conversationHistory: [] })), getUserMemoryBlock: jest.fn(async () => '') },
  capHistoryToCharBudget: jest.fn(),
  MACHINE_WAKE_HISTORY_CHAR_BUDGET: 0,
  MACHINE_WAKE_MAX_PAIRS: 0,
}));
const mockUtilityChat: jest.Mock = jest.fn();
jest.mock('../../../utils/utility-llm', () => ({ utilityChat: (...a: any[]) => mockUtilityChat(...a) }));
jest.mock('../memory/unified-memory.service', () => ({ memStore: jest.fn(), enforceScopeCap: jest.fn(async () => {}) }));
jest.mock('../memory/user-facts.service', () => ({ selectRelevantFacts: jest.fn(), syncUserFactRows: jest.fn() }));
jest.mock('../memory/episodic.service', () => ({ buildEpisodicBlock: jest.fn() }));
jest.mock('../memory-relevance', () => ({ filterFactsByRelevance: jest.fn(), isTextRelevantToMessage: jest.fn() }));
const mockStoreGet: jest.Mock = jest.fn();
const mockStorePut: jest.Mock = jest.fn();
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));
jest.mock('../platform/folder-inheritance', () => ({ getMergedProjectStoreState: jest.fn() }));
jest.mock('../platform/decision-gate', () => ({
  decide: jest.fn(async () => null), decisionMode: () => 'off', decisionThreshold: () => 0.8, recordDecisionOutcome: jest.fn(),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { MEMORY_EXTRACTION: 'memory_extraction', USER_MEMORY_MUTATION: 'user_memory_mutation' },
}));

import { runUpdateContextPipeline } from './memory.graph';
import { resetProfileExtractionThrottle } from '../memory/profile-guard';

const THREAD_HEAD = 'You are maintaining a conversation thread summary';
const existingThread = {
  threadSummary: 'The user is planning a database migration for their billing service.',
  confirmedFacts: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`fact ${i}`, `value ${i}`])),
  openTopics: ['which index type', 'downtime window'],
  lastUserGoal: 'plan the migration',
  messageCount: 10,
  lastUpdated: '2026-10-20T00:00:00.000Z',
};
let threadAnswer = '{}';
const threadPrompts: string[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  resetProfileExtractionThrottle();
  threadPrompts.length = 0;
  delete process.env.MEMORY_STATE_OPS_DISABLED;
  mockStoreGet.mockImplementation(async (ns: string[]) => (ns[1] === 'thread' ? JSON.parse(JSON.stringify(existingThread)) : null));
  mockStorePut.mockResolvedValue(undefined);
  mockUtilityChat.mockImplementation(async (messages: Array<{ content: string }>) => {
    const prompt = messages[0].content;
    if (prompt.startsWith(THREAD_HEAD)) { threadPrompts.push(prompt); return threadAnswer; }
    if (prompt.startsWith('You are a memory manager')) return '{"add": {}, "remove": [], "reject": []}';
    return '{}';
  });
});

const turn = (userMessage = 'We settled on a BRIN index and a 10-minute window on Sunday night.') =>
  runUpdateContextPipeline({ userId: 'u1', projectId: null, chatId: 'c1', userMessage, synthesis: 'Great — BRIN suits the append-only table, and Sunday 23:00 keeps traffic lowest.' } as any);
const savedThread = () => mockStorePut.mock.calls.find((c) => c[0][1] === 'thread')?.[2];
const threadRow = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r) => r.kind === 'memory_extraction' && r.meta.source === 'thread');

describe('thread state as per-item ops', () => {
  it('shows ids and asks for the changes only', async () => {
    await turn();
    expect(threadPrompts[0]).toContain('[F1] fact 0: value 0');
    expect(threadPrompts[0]).toContain('[Q2] downtime window');
    expect(threadPrompts[0]).toContain('Return ONLY the CHANGES as one JSON object');
    expect(threadPrompts[0]).not.toContain('Return ONLY valid JSON:\n{\n  "threadSummary"');
  });

  it('put / remove / set land, the map cap keeps the newest 10, bookkeeping is the harness\'s', async () => {
    threadAnswer = JSON.stringify({
      set: { threadSummary: 'The user is migrating the billing database: BRIN index, Sunday-night window.', lastUserGoal: 'schedule the migration' },
      put: { confirmedFacts: { 'index type': 'BRIN', 'window': 'Sunday 23:00, 10 minutes' } },
      remove: ['Q1', 'Q2'],
      add: { openTopics: ['rollback plan'] },
    });
    await turn();
    const saved = savedThread();
    expect(saved.threadSummary).toBe('The user is migrating the billing database: BRIN index, Sunday-night window.');
    expect(saved.lastUserGoal).toBe('schedule the migration');
    expect(saved.openTopics).toEqual(['rollback plan']);
    expect(Object.keys(saved.confirmedFacts)).toHaveLength(10);
    expect(saved.confirmedFacts['index type']).toBe('BRIN');
    expect(saved.confirmedFacts['fact 0']).toBeUndefined(); // the oldest entry made room
    expect(saved.messageCount).toBe(12);
    expect(threadRow().meta).toMatchObject({ outcome: 'changed', budgetTokens: 2000 });
    expect(threadRow().meta.detail).toMatch(/^ops set=2 add=1 upd=0 rm=2 put=2/);
  });

  it('the provenance guard still strips an ungrounded specific from a set summary', async () => {
    threadAnswer = JSON.stringify({ set: { threadSummary: 'The user is migrating billing. They ran curl https://api.example.com/v1/credits and it returned $12.40.' } });
    await turn();
    const summary = savedThread().threadSummary;
    expect(summary).toContain('The user is migrating billing');
    expect(summary).not.toContain('$12.40');
    expect(summary).not.toContain('api.example.com');
  });

  it('a whole-object answer is still honoured (legacy shape), clamped', async () => {
    threadAnswer = JSON.stringify({ ...existingThread, openTopics: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    await turn();
    expect(savedThread().openTopics).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(threadRow().meta.detail).toMatch(/^ops legacy-shape/);
  });

  it('MEMORY_STATE_OPS_DISABLED=1: the old whole-object prompt and parse', async () => {
    process.env.MEMORY_STATE_OPS_DISABLED = '1';
    threadAnswer = JSON.stringify({ ...existingThread, threadSummary: 'legacy path' });
    await turn();
    expect(threadPrompts[0]).toContain('Return ONLY valid JSON:\n{\n  "threadSummary"');
    expect(threadPrompts[0]).not.toContain('[F1]');
    expect(savedThread().threadSummary).toBe('legacy path');
  });
});

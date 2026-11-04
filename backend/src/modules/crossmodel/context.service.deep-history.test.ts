/**
 * Machine-wake deep history window (audit p10) — PR #190 deepened only the
 * FINAL slice in chat-agent.service (slice(machineWake ? -24 : -8)); the
 * upstream loaders kept trimming to ~10-20 messages first, so a machine wake
 * on a long chat never actually received the promised 24 messages. These
 * tests pin the loader-side contract: with deepHistory, >20 messages survive
 * a long chat's trim, bounded by the char budget.
 *
 * Same mock shape as context.service.confirm-note.test.ts: the env-touching
 * boundaries (config/database, config/redis) are mocked so the suite never
 * reaches config/env.
 */

const mockChatFindUnique = jest.fn();
const mockMessageFindMany = jest.fn();
const mockUserMemoryFindUnique = jest.fn();
const mockPendingFindFirst = jest.fn(async (..._a: any[]) => null);

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    crossModelMessage: { findMany: (...a: any[]) => mockMessageFindMany(...a) },
    userMemory: { findUnique: (...a: any[]) => mockUserMemoryFindUnique(...a) },
    pendingConfirmation: { findFirst: (...a: any[]) => mockPendingFindFirst(...a) },
  },
}));
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), setEx: jest.fn(), del: jest.fn(), expire: jest.fn() },
}));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
jest.mock('./memory-relevance', () => ({ filterFactsByRelevance: jest.fn(() => []) }));
jest.mock('./memory/user-facts.service', () => ({ syncUserFactRows: jest.fn(), deleteAllFactRows: jest.fn() }));

import {
  ContextService,
  capHistoryToCharBudget,
  HISTORY_FETCH_LIMIT,
  MACHINE_WAKE_MAX_PAIRS,
  MACHINE_WAKE_HISTORY_CHAR_BUDGET,
} from './context.service';

const USER = 'u1';
const CHAT = 'chat-deep-1';

/** A long chat: `count` alternating turns, each `charsPer` chars (> the 16k
 *  smart-trim threshold in aggregate so trimming actually engages). */
function longHistory(count: number, charsPer = 600) {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${i % 2 === 0 ? 'Q' : 'A'}${i} ${'x'.repeat(charsPer)}`,
  }));
}

function seedHistory(rows: Array<{ role: string; content: string }>) {
  mockChatFindUnique.mockResolvedValue({ userId: USER });
  // Honor the query like the DB would: the loader fetches the NEWEST
  // HISTORY_FETCH_LIMIT rows (createdAt desc) and restores order itself.
  const stamped = rows.map((r, i) => ({ ...r, id: `m${i}`, createdAt: new Date(i * 1000) }));
  mockMessageFindMany.mockImplementation(async (args: any) => {
    const ob = Array.isArray(args?.orderBy) ? args.orderBy[0] : args?.orderBy;
    const sorted = ob?.createdAt === 'desc' ? [...stamped].reverse() : stamped;
    return typeof args?.take === 'number' ? sorted.slice(0, args.take) : sorted;
  });
  mockUserMemoryFindUnique.mockResolvedValue(null);
}

describe('loadChatContext deepHistory (machine wakes get a REAL 24-message window)', () => {
  const svc = new ContextService();

  beforeEach(() => jest.clearAllMocks());

  it('a machine wake on a 60-message chat receives >20 messages (24), a normal run stays at 20', async () => {
    const rows = longHistory(60); // 36k chars total — over the 16k trim threshold
    seedHistory(rows);
    const deep = await svc.loadChatContext(CHAT, USER, undefined, { deepHistory: true });
    expect(deep.conversationHistory.length).toBe(MACHINE_WAKE_MAX_PAIRS * 2); // 24
    expect(deep.conversationHistory.length).toBeGreaterThan(20);
    // Deepening keeps the TAIL (the wake's own most recent notes).
    expect(deep.conversationHistory[deep.conversationHistory.length - 1].content).toContain('A59');
    expect(deep.conversationHistory[0].content).toContain('Q36');

    seedHistory(rows);
    const normal = await svc.loadChatContext(CHAT, USER);
    expect(normal.conversationHistory.length).toBe(20); // DEFAULT_MAX_PAIRS * 2 — unchanged
  });

  it('the deep window is char-bounded: oldest messages drop until the budget fits', async () => {
    // 24 tail messages at 4k chars each = 96k > 48k budget → oldest drop.
    seedHistory(longHistory(60, 4000));
    const deep = await svc.loadChatContext(CHAT, USER, undefined, { deepHistory: true });
    const total = deep.conversationHistory.reduce((s, m) => s + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(MACHINE_WAKE_HISTORY_CHAR_BUDGET);
    expect(deep.conversationHistory.length).toBeGreaterThanOrEqual(8); // never below the shallow floor
    expect(deep.conversationHistory[deep.conversationHistory.length - 1].content).toContain('A59');
  });

  it('a short chat is returned in full for both modes (no trim under 16k chars)', async () => {
    const rows = longHistory(10, 100);
    seedHistory(rows);
    const deep = await svc.loadChatContext(CHAT, USER, undefined, { deepHistory: true });
    expect(deep.conversationHistory.length).toBe(10);
    seedHistory(rows);
    const normal = await svc.loadChatContext(CHAT, USER);
    expect(normal.conversationHistory.length).toBe(10);
  });
});

describe('loadChatContext bounded fetch (rollout watch 2026-09-14 — the Fleet Supervisor chat)', () => {
  const svc = new ContextService();

  beforeEach(() => jest.clearAllMocks());

  it('fetches only the newest HISTORY_FETCH_LIMIT rows (createdAt desc, id tie-break) and restores chronological order', async () => {
    // 11,548 rows / 58 MB was the prod shape; the loader must never ask for all of them.
    const rows = longHistory(500);
    seedHistory(rows);
    const deep = await svc.loadChatContext(CHAT, USER, undefined, { deepHistory: true });
    const call = mockMessageFindMany.mock.calls[0][0];
    expect(call.take).toBe(HISTORY_FETCH_LIMIT);
    expect(call.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    // The loaded window is the NEWEST rows, oldest-first.
    expect(deep.fullHistory).toHaveLength(HISTORY_FETCH_LIMIT);
    expect(deep.fullHistory[0].content).toContain('Q420');
    expect(deep.fullHistory[HISTORY_FETCH_LIMIT - 1].content).toContain('A499');
    // And the model window is the same 24-message tail the unbounded load produced.
    expect(deep.conversationHistory.length).toBe(MACHINE_WAKE_MAX_PAIRS * 2);
    expect(deep.conversationHistory[0].content).toContain('Q476');
    expect(deep.conversationHistory[deep.conversationHistory.length - 1].content).toContain('A499');
  });

  it('the fetch limit covers every trim window with slack', () => {
    expect(HISTORY_FETCH_LIMIT).toBeGreaterThanOrEqual(MACHINE_WAKE_MAX_PAIRS * 2 + 8);
  });
});

describe('loadChatContext excludeMessageId (ticket 68bc5aec — orphan-recovery re-fire)', () => {
  const svc = new ContextService();

  beforeEach(() => jest.clearAllMocks());

  it('excludes the recovered turn\'s own row from the DB read (double-vision hazard); unset → unchanged where', async () => {
    seedHistory(longHistory(4, 100));
    await svc.loadChatContext(CHAT, USER, undefined, { excludeMessageId: 'msg-orphan-1' });
    expect(mockMessageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { chatId: CHAT, id: { not: 'msg-orphan-1' } },
    }));

    jest.clearAllMocks();
    seedHistory(longHistory(4, 100));
    await svc.loadChatContext(CHAT, USER);
    expect(mockMessageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { chatId: CHAT },
    }));
    expect(mockMessageFindMany.mock.calls[0][0].where.id).toBeUndefined();
  });
});

describe('capHistoryToCharBudget', () => {
  it('returns the input untouched when already within budget', () => {
    const msgs = longHistory(6, 100);
    expect(capHistoryToCharBudget(msgs, 10_000, 4)).toBe(msgs);
  });

  it('drops OLDEST messages first and keeps at least minMessages', () => {
    const msgs = longHistory(10, 1000);
    const capped = capHistoryToCharBudget(msgs, 3_000, 2);
    expect(capped.length).toBe(2);
    expect(capped[0].content).toContain('Q8');
    expect(capped[1].content).toContain('A9');
  });

  it('never drops below minMessages even when still over budget', () => {
    const msgs = longHistory(6, 5_000);
    const capped = capHistoryToCharBudget(msgs, 1_000, 4);
    expect(capped.length).toBe(4);
  });
});

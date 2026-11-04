/**
 * Shared-project author attribution (ticket f89d1213) — the LEGACY persistence
 * paths in context.service stamp metadata.authorId on every USER row they
 * write, so shared-project transcripts can label who sent what:
 *
 *   - saveToChatHistory (kid chats, frontier fact-check): the user row carries
 *     { authorId: <sender> }; the assistant row's metadata is untouched.
 *   - migrateSessionToChat (anonymous → account): every migrated USER row is
 *     stamped with the migrating user (they authored the whole session);
 *     assistant rows stay unstamped.
 *
 * The env-touching boundaries (config/database, config/redis) are mocked; the
 * confirmation registry is stubbed (not under test here).
 */

const mockChatFindUnique = jest.fn();
const mockChatCreate = jest.fn();
const mockChatUpdate = jest.fn();
const mockMessageCreate = jest.fn();
const mockMessageCreateMany = jest.fn();
const mockTransaction = jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(undefined) : Promise.all(arg)));

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: {
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      create: (...a: any[]) => mockChatCreate(...a),
      update: (...a: any[]) => mockChatUpdate(...a),
    },
    crossModelMessage: {
      create: (...a: any[]) => mockMessageCreate(...a),
      createMany: (...a: any[]) => mockMessageCreateMany(...a),
    },
    $transaction: (arg: any) => mockTransaction(arg),
  },
}));

const mockRedisGet = jest.fn();
const mockRedisDel = jest.fn();
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: {
    get: (...a: any[]) => mockRedisGet(...a),
    del: (...a: any[]) => mockRedisDel(...a),
    set: jest.fn(),
    setEx: jest.fn(),
    expire: jest.fn(),
  },
}));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
jest.mock('./memory-relevance', () => ({ filterFactsByRelevance: jest.fn(() => []) }));
jest.mock('./memory/user-facts.service', () => ({ syncUserFactRows: jest.fn(), deleteAllFactRows: jest.fn() }));
jest.mock('./platform/pending-confirmations', () => ({ getActivePendingForSession: jest.fn(() => null) }));

import contextService from './context.service';

const USER = 'u-sender';
const CHAT = 'chat-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockTransaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(undefined) : Promise.all(arg)));
  mockMessageCreate.mockResolvedValue({});
  mockMessageCreateMany.mockResolvedValue({ count: 0 });
  mockChatUpdate.mockResolvedValue({});
});

describe('saveToChatHistory — user-row author stamp (f89d1213)', () => {
  it('stamps metadata.authorId on the USER row; the assistant row keeps its own metadata', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: USER }); // ownership guard passes

    await contextService.saveToChatHistory(CHAT, USER, 'hello there', 'hi!', { mode: 'thinking' } as any);

    const writes = mockMessageCreate.mock.calls.map((c: any[]) => c[0]?.data);
    const userRow = writes.find((d: any) => d?.role === 'user');
    const assistantRow = writes.find((d: any) => d?.role === 'assistant');
    expect(userRow).toMatchObject({ chatId: CHAT, content: 'hello there', metadata: { authorId: USER } });
    expect(assistantRow.metadata).toEqual({ mode: 'thinking' }); // untouched pass-through
  });

  it('non-owner sender: the ownership guard still short-circuits — nothing written', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'someone-else' });

    await contextService.saveToChatHistory(CHAT, USER, 'hello', 'hi', undefined as any);

    expect(mockMessageCreate).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe('migrateSessionToChat — migrated user rows are stamped (f89d1213)', () => {
  it('stamps authorId on USER rows only; assistant rows carry no metadata key', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'an answer' },
      { role: 'user', content: 'follow-up' },
    ]));
    mockChatCreate.mockResolvedValue({ id: 'new-chat' });

    const chatId = await contextService.migrateSessionToChat('sess-1', USER);

    expect(chatId).toBe('new-chat');
    const rows = mockMessageCreateMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ role: 'user', metadata: { authorId: USER } });
    expect(rows[1]).not.toHaveProperty('metadata'); // assistant — unstamped
    expect(rows[2]).toMatchObject({ role: 'user', metadata: { authorId: USER } });
  });
});

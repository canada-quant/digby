/**
 * fs-durable-memory review (2026-10-22): the context-store primitives behind
 *  - the thread-counter bookkeeping (storeAdvanceNumberField — ONE atomic
 *    UPDATE of one field, upward only; never a rewrite of a loaded snapshot);
 *  - the supervisor ledger's cold archive id lookup (storeFindByKeyPrefix).
 */
const mockExecuteRaw: jest.Mock = jest.fn(async () => 1);
const mockFindMany: jest.Mock = jest.fn(async () => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    $executeRaw: (...a: any[]) => mockExecuteRaw(...a),
    contextStoreEntry: { findMany: (...a: any[]) => mockFindMany(...a) },
  },
}));

import * as cs from './context-store';
import { storeAdvanceNumberField, storeFindByKeyPrefix } from './context-store';

beforeEach(() => jest.clearAllMocks());

describe('storeAdvanceNumberField', () => {
  it('is ONE UPDATE that jsonb_sets only the named field, guarded to move it upward on an object row', async () => {
    expect(await storeAdvanceNumberField(['chat-1', 'thread'], 'state', 'messageCount', 14)).toBe(true);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = mockExecuteRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toMatch(/^UPDATE "store"/);
    expect(sql).toContain('jsonb_set("value", ARRAY[?::text], to_jsonb(?::int), true)');
    expect(sql).toContain(`jsonb_typeof("value") = 'object'`);
    expect(sql).toMatch(/ELSE -1 END\) < \?::int/); // never lowers the stored count
    expect(sql).not.toMatch(/SET "value" = \?/); // never writes a whole value
    expect(values).toEqual(['messageCount', 14, 'chat-1:thread', 'state', 'messageCount', 'messageCount', 14]);
  });

  it('reports false when no row moved (absent row, or a concurrent save already counted further)', async () => {
    mockExecuteRaw.mockResolvedValueOnce(0);
    expect(await storeAdvanceNumberField(['c', 'thread'], 'state', 'messageCount', 14)).toBe(false);
  });

  it('refuses a non-finite value or an empty field without touching the database', async () => {
    expect(await storeAdvanceNumberField(['c', 'thread'], 'state', 'messageCount', Number.NaN)).toBe(false);
    expect(await storeAdvanceNumberField(['c', 'thread'], 'state', '', 3)).toBe(false);
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });
});

describe('storeFindByKeyPrefix', () => {
  it('one bounded query over several namespaces by key prefix; expired rows skipped', async () => {
    mockFindMany.mockResolvedValueOnce([
      { namespacePath: 'a:supervisor-archive', key: 'abc12345-1', value: { id: 'abc12345-1' }, expiresAt: null },
      { namespacePath: 'b:supervisor-archive', key: 'abc12345-2', value: { id: 'abc12345-2' }, expiresAt: new Date(Date.now() - 1000) },
    ]);
    const out = await storeFindByKeyPrefix([['a', 'supervisor-archive'], ['b', 'supervisor-archive']], 'abc12345', 500);
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { namespacePath: { in: ['a:supervisor-archive', 'b:supervisor-archive'] }, key: { startsWith: 'abc12345' } },
      take: 200,
    }));
    expect(out).toEqual([{ namespace: 'a:supervisor-archive', key: 'abc12345-1', value: { id: 'abc12345-1' } }]);
    expect(await storeFindByKeyPrefix([], 'x')).toEqual([]);
  });
});

// Review round 3 (2026-10-23): Prisma 7's startsWith does NOT escape LIKE
// wildcards (verified on Postgres 16 + the Prisma 7.10 client: '%%%%%%%%' and
// '________' each matched every row), so an id carrying '_' / '%' matched
// unrelated cold rows.
describe('storeFindByKeyPrefix — the prefix is matched LITERALLY', () => {
  it("escapes \\, % and _ before Prisma's startsWith", async () => {
    await storeFindByKeyPrefix([['a', 'supervisor-archive']], 'a%c_12\\4');
    expect(mockFindMany.mock.calls[0][0].where.key).toEqual({ startsWith: 'a\\%c\\_12\\\\4' });
    expect(cs.escapeLikeLiteral('________')).toBe('\\_\\_\\_\\_\\_\\_\\_\\_');
    expect(cs.escapeLikeLiteral('abc12345')).toBe('abc12345');
  });

  it('drops any returned row whose key does not literally start with the prefix (wildcard match)', async () => {
    mockFindMany.mockResolvedValueOnce([
      { namespacePath: 'a:supervisor-archive', key: 'abc12345-1', value: { id: 'abc12345-1' }, expiresAt: null },
      { namespacePath: 'a:supervisor-archive', key: 'zzz9_999-2', value: { id: 'zzz9_999-2' }, expiresAt: null },
    ]);
    const out = await storeFindByKeyPrefix([['a', 'supervisor-archive']], 'zzz9_999');
    expect(out.map((r) => r.key)).toEqual(['zzz9_999-2']);
  });
});

describe('storeDeleteChatScoped — a deleted chat leaves no chat-keyed rows behind', () => {
  it("clears [chatId,'thread'], [chatId,'supervisor-archive'] and the background-report spill for each chat, by exact namespace path", async () => {
    const deleteMany = jest.fn(async () => ({ count: 3 }));
    const n = await cs.storeDeleteChatScoped(['c1', 'c2', 'c1', ''], { contextStoreEntry: { deleteMany } });
    expect(n).toBe(3);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    // Ticket 458342f5: a finished background worker's spilled report lives under
    // [chatId,'background-report'] and must die with the chat like thread state.
    expect(deleteMany).toHaveBeenCalledWith({ where: { namespacePath: { in: ['c1:thread', 'c1:supervisor-archive', 'c1:background-report', 'c2:thread', 'c2:supervisor-archive', 'c2:background-report'] } } });
  });

  it('chunks large account sweeps and does nothing for no chats', async () => {
    const deleteMany = jest.fn(async (args: any) => ({ count: args.where.namespacePath.in.length }));
    const ids = Array.from({ length: 600 }, (_, i) => `chat-${i}`);
    expect(await cs.storeDeleteChatScoped(ids, { contextStoreEntry: { deleteMany } })).toBe(1800);
    expect(deleteMany).toHaveBeenCalledTimes(4);
    expect(deleteMany.mock.calls.every((c: any[]) => c[0].where.namespacePath.in.length <= 500)).toBe(true);
    deleteMany.mockClear();
    expect(await cs.storeDeleteChatScoped([], { contextStoreEntry: { deleteMany } })).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

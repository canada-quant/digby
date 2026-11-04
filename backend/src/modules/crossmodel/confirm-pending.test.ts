/**
 * First-class confirmation UX — confirm:pending presence keys.
 * publish writes ONE JSON key per chat (TTL'd backstop), clear deletes it, and
 * readConfirmPendingForChats batch-reads the fleet with ONE MGET (malformed and
 * missing entries skipped). Redis is mocked with the in-memory stand-in (the
 * question-registry test pattern) so config/env never loads.
 */

const mockStore = new Map<string, string>();

jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); return 'OK'; }),
    get: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    del: jest.fn(async (k: string) => { mockStore.delete(k); return 1; }),
    mGet: jest.fn(async (keys: string[]) => keys.map(k => mockStore.get(k) ?? null)),
  },
}));

import redisClient from '../../config/redis';
import { publishConfirmPending, clearConfirmPending, readConfirmPendingForChats } from './confirm-pending';

const KEY = (chatId: string) => `confirm:pending:${chatId}`;

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

describe('publishConfirmPending / clearConfirmPending', () => {
  it('publishes the JSON entry under confirm:pending:{chatId} with the TTL backstop', async () => {
    await publishConfirmPending('c1', { kind: 'question', id: 'q-1', question: 'Proceed?', options: ['yes', 'no'], ts: 123 });
    const raw = mockStore.get(KEY('c1'));
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual({ kind: 'question', id: 'q-1', question: 'Proceed?', options: ['yes', 'no'], ts: 123 });
    expect(redisClient.set).toHaveBeenCalledWith(KEY('c1'), expect.any(String), { EX: 3960 });
  });

  it('clear deletes the key', async () => {
    await publishConfirmPending('c1', { kind: 'approval', id: 'a-1', question: 'Allow delete_chat?', options: ['allow', 'always', 'deny'], tool: 'delete_chat', ts: 1 });
    await clearConfirmPending('c1');
    expect(mockStore.has(KEY('c1'))).toBe(false);
  });

  it('a Redis hiccup degrades to a no-op (never throws)', async () => {
    (redisClient.set as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
    await expect(publishConfirmPending('c1', { kind: 'question', id: 'q', question: '?', options: [], ts: 0 })).resolves.toBeUndefined();
    (redisClient.del as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
    await expect(clearConfirmPending('c1')).resolves.toBeUndefined();
  });
});

describe('readConfirmPendingForChats', () => {
  it('batch-reads the fleet with ONE MGET and returns chatId → entry', async () => {
    await publishConfirmPending('c1', { kind: 'question', id: 'q-1', question: 'Which env?', options: ['staging', 'prod'], ts: 10 });
    await publishConfirmPending('c3', { kind: 'approval', id: 'a-9', question: 'Allow run_command: rm -rf build?', options: ['allow', 'always', 'deny'], tool: 'run_command', ts: 20 });

    const out = await readConfirmPendingForChats(['c1', 'c2', 'c3']);
    expect(redisClient.mGet).toHaveBeenCalledTimes(1);
    expect(out.size).toBe(2);
    expect(out.get('c1')).toEqual({ kind: 'question', id: 'q-1', question: 'Which env?', options: ['staging', 'prod'], ts: 10 });
    expect(out.get('c3')).toEqual({ kind: 'approval', id: 'a-9', question: 'Allow run_command: rm -rf build?', options: ['allow', 'always', 'deny'], tool: 'run_command', ts: 20 });
    expect(out.has('c2')).toBe(false); // no key → no entry
  });

  it('round-trips the question expiresAt deadline (omitted when absent/invalid)', async () => {
    await publishConfirmPending('c1', { kind: 'question', id: 'q-1', question: 'Proceed?', options: ['yes'], ts: 10, expiresAt: 10 + 3_600_000 });
    await publishConfirmPending('c2', { kind: 'approval', id: 'a-1', question: 'Allow?', options: ['allow'], ts: 20 });
    const out = await readConfirmPendingForChats(['c1', 'c2']);
    expect(out.get('c1')?.expiresAt).toBe(10 + 3_600_000);
    expect(out.get('c2')).not.toHaveProperty('expiresAt'); // approvals carry no answer deadline
  });

  it('skips malformed entries and non-string values instead of failing the poll', async () => {
    mockStore.set(KEY('bad-json'), '{not json');
    mockStore.set(KEY('bad-shape'), JSON.stringify({ kind: 'other', id: 1 }));
    await publishConfirmPending('good', { kind: 'question', id: 'q-2', question: 'OK?', options: [], ts: 5 });
    const out = await readConfirmPendingForChats(['bad-json', 'bad-shape', 'good']);
    expect(out.size).toBe(1);
    expect(out.get('good')?.id).toBe('q-2');
  });

  it('an empty chat list short-circuits without touching Redis', async () => {
    const out = await readConfirmPendingForChats([]);
    expect(out.size).toBe(0);
    expect(redisClient.mGet).not.toHaveBeenCalled();
  });

  it('a Redis hiccup degrades to "nothing pending"', async () => {
    (redisClient.mGet as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
    const out = await readConfirmPendingForChats(['c1']);
    expect(out.size).toBe(0);
  });
});

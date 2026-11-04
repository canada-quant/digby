/**
 * RedisRateLimitStore — shared-Redis hit counting for express-rate-limit.
 * Invariants: first hit starts the window (PEXPIRE), later hits accumulate
 * WITHOUT resetting the window, and any Redis failure DEGRADES to a
 * per-process in-memory window (old MemoryStore semantics) — never to
 * unlimited, and never blocking logins/chat on an outage.
 */

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockExec = jest.fn();
const mockMulti: { incr: jest.Mock; pTTL: jest.Mock; exec: jest.Mock } = {
  incr: jest.fn((): typeof mockMulti => mockMulti),
  pTTL: jest.fn((): typeof mockMulti => mockMulti),
  exec: mockExec,
};
jest.mock('../config/redis', () => ({
  __esModule: true,
  default: {
    isOpen: true,
    multi: jest.fn(() => mockMulti),
    pExpire: jest.fn(async () => true),
    decr: jest.fn(async () => 0),
    del: jest.fn(async () => 1),
  },
}));

import redisClient from '../config/redis';
import logger from '../utils/logger';
import { RedisRateLimitStore } from './redis-rate-limit-store';

const WINDOW_MS = 10 * 60 * 1000;

function makeStore(prefix = 'rl:test:'): RedisRateLimitStore {
  const store = new RedisRateLimitStore(prefix);
  store.init({ windowMs: WINDOW_MS } as any);
  return store;
}

beforeEach(() => {
  jest.clearAllMocks();
  (redisClient as any).isOpen = true;
});

describe('RedisRateLimitStore', () => {
  it('first hit starts the window: INCR=1 with no TTL → PEXPIRE(windowMs)', async () => {
    mockExec.mockResolvedValueOnce([1, -1]); // fresh key: no TTL yet
    const store = makeStore();
    const before = Date.now();
    const res = await store.increment('1.2.3.4');
    expect(res.totalHits).toBe(1);
    expect(mockMulti.incr).toHaveBeenCalledWith('rl:test:1.2.3.4'); // prefix applied
    expect(redisClient.pExpire).toHaveBeenCalledWith('rl:test:1.2.3.4', WINDOW_MS);
    expect(res.resetTime!.getTime()).toBeGreaterThanOrEqual(before + WINDOW_MS);
  });

  it('later hits accumulate and keep the existing window (no PEXPIRE)', async () => {
    mockExec.mockResolvedValueOnce([5, 30_000]); // 5th hit, 30s left in window
    const store = makeStore();
    const before = Date.now();
    const res = await store.increment('1.2.3.4');
    expect(res.totalHits).toBe(5);
    expect(redisClient.pExpire).not.toHaveBeenCalled();
    // resetTime reflects the REMAINING ttl, not a fresh window
    expect(res.resetTime!.getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(res.resetTime!.getTime()).toBeGreaterThanOrEqual(before + 29_000);
  });

  it('degrades to a per-process in-memory window on Redis errors — outage hits still accumulate, warning once', async () => {
    mockExec.mockRejectedValue(new Error('redis down'));
    const store = makeStore();
    const first = await store.increment('1.2.3.4');
    const second = await store.increment('1.2.3.4');
    const other = await store.increment('5.6.7.8');
    // Counts accumulate locally: a brute-forcer during a Redis outage still
    // trips the limiter (plain fail-open returned 1 forever — review 2026-08-16).
    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(other.totalHits).toBe(1); // per-key windows
    expect(second.resetTime!.getTime()).toBe(first.resetTime!.getTime()); // same window
    expect(logger.warn).toHaveBeenCalledTimes(1); // once per outage, not per request
  });

  it('degrades without touching Redis when the client is not open', async () => {
    (redisClient as any).isOpen = false;
    const store = makeStore();
    const first = await store.increment('1.2.3.4');
    const second = await store.increment('1.2.3.4');
    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(redisClient.multi).not.toHaveBeenCalled();
  });

  it('discards the outage windows on recovery — stale local counts never linger', async () => {
    const store = makeStore();
    mockExec.mockRejectedValueOnce(new Error('down'));
    mockExec.mockRejectedValueOnce(new Error('down'));
    await store.increment('1.2.3.4');
    await store.increment('1.2.3.4'); // local count = 2
    mockExec.mockResolvedValueOnce([1, -1]); // recovered — Redis is the truth again
    await store.increment('1.2.3.4');
    mockExec.mockRejectedValueOnce(new Error('down again'));
    const afterRecovery = await store.increment('1.2.3.4');
    expect(afterRecovery.totalHits).toBe(1); // fresh outage window, not the stale 2
  });

  it('warns again after a recovery (warned flag resets on success)', async () => {
    const store = makeStore();
    mockExec.mockRejectedValueOnce(new Error('down'));
    await store.increment('k');
    mockExec.mockResolvedValueOnce([2, 1000]); // recovered
    await store.increment('k');
    mockExec.mockRejectedValueOnce(new Error('down again'));
    await store.increment('k');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('decrement and resetKey use the prefixed key and swallow errors', async () => {
    const store = makeStore();
    await store.decrement('1.2.3.4');
    expect(redisClient.decr).toHaveBeenCalledWith('rl:test:1.2.3.4');
    await store.resetKey('1.2.3.4');
    expect(redisClient.del).toHaveBeenCalledWith('rl:test:1.2.3.4');
    (redisClient.decr as jest.Mock).mockRejectedValueOnce(new Error('down'));
    (redisClient.del as jest.Mock).mockRejectedValueOnce(new Error('down'));
    await expect(store.decrement('x')).resolves.toBeUndefined();
    await expect(store.resetKey('x')).resolves.toBeUndefined();
  });

  it('is not a per-process store (localKeys=false, so the double-count check is honest)', () => {
    expect(makeStore().localKeys).toBe(false);
  });
});

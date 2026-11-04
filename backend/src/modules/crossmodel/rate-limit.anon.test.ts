/**
 * Guest deep-research quota (owner 2026-09-23): per-IP daily allowance,
 * separate key prefix from the per-user scan, fails CLOSED on Redis errors.
 */
const counts = new Map<string, number>();
let redisDown = false;
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: {
    incr: jest.fn(async (k: string) => { if (redisDown) throw new Error('down'); const n = (counts.get(k) ?? 0) + 1; counts.set(k, n); return n; }),
    decr: jest.fn(async (k: string) => { const n = (counts.get(k) ?? 0) - 1; counts.set(k, n); return n; }),
    expire: jest.fn(async () => 1),
  },
}));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { reserveAnonDeepResearchQuota, getAnonDeepResearchDailyLimit, DEFAULT_ANON_DEEP_RESEARCH_DAILY_LIMIT } from './rate-limit.service';

beforeEach(() => { counts.clear(); redisDown = false; delete process.env.ANON_DEEP_RESEARCH_DAILY_LIMIT; });

it('allows the default daily allowance per IP, then refuses (and refunds the attempt)', async () => {
  for (let i = 0; i < DEFAULT_ANON_DEEP_RESEARCH_DAILY_LIMIT; i++) {
    expect((await reserveAnonDeepResearchQuota('24.68.1.2')).allowed).toBe(true);
  }
  const over = await reserveAnonDeepResearchQuota('24.68.1.2');
  expect(over.allowed).toBe(false);
  expect([...counts.values()][0]).toBe(DEFAULT_ANON_DEEP_RESEARCH_DAILY_LIMIT);
  // A different IP has its own allowance.
  expect((await reserveAnonDeepResearchQuota('24.68.1.3')).allowed).toBe(true);
});

it('uses a key prefix the per-user admin scan never matches', async () => {
  await reserveAnonDeepResearchQuota('2001:db8::1');
  const key = [...counts.keys()][0];
  expect(key.startsWith('deep_research_anon_usage:')).toBe(true);
  expect(key.startsWith('deep_research_usage:')).toBe(false);
});

it('fails closed when Redis is down, and 0 disables guests', async () => {
  redisDown = true;
  expect((await reserveAnonDeepResearchQuota('24.68.1.2')).allowed).toBe(false);
  redisDown = false;
  process.env.ANON_DEEP_RESEARCH_DAILY_LIMIT = '0';
  expect(getAnonDeepResearchDailyLimit()).toBe(0);
  expect((await reserveAnonDeepResearchQuota('24.68.1.2')).allowed).toBe(false);
});

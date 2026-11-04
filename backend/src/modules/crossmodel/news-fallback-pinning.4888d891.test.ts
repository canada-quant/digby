/**
 * Ticket 4888d891 — "news homepage is stale".
 *
 * THE INCIDENT REPLAY: `fetchNewsHeadlines` answers a whole-fetch FAILURE by
 * serving the shared outage fallback (`news:headlines:fallback`), which holds
 * ANOTHER user's briefing. `prefetchNewsForUser` judged success only by
 * `headlines.length`, so a failed fetch that returned ≥ MIN_HEALTHY_HEADLINES
 * fallback items was indistinguishable from a genuine briefing:
 *
 *   - the fallback content was written to `user:news:<id>` with the FULL 24h
 *     TTL (`NEWS_CACHE_TTL`) — pinned as the user's own Daily Briefing;
 *   - the failure backoff was NOT armed (only the thin/zero lanes arm it), so
 *     nothing signalled the failure; and
 *   - the fallback headlines were recorded into the user's seen-history,
 *     suppressing those stories from the user's next GENUINE briefing even
 *     though the user never actually "saw" them as their own news.
 *
 * Net effect on the home card: it kept rendering the same outage-era headlines
 * while every real refresh failed — "the news homepage is stale". Live
 * telemetry at filing time (2026-10-29) showed the triggering formatter failure
 * burst: 49 `news.service: could not extract JSON array…` / `prefetch returned
 * 0 headlines…` warns in the 6h window, clustered 12:05–12:08Z.
 *
 * The fix (pinned here): fetch provenance is threaded out of
 * `fetchNewsHeadlines` via an optional `NewsFetchOutcome`, so `prefetchNewsForUser`
 * can tell "OUR briefing" from "the outage fallback we served because we failed".
 * Fallback-served content is NEVER counted toward the healthy minimum, is cached
 * with the SHORT thin TTL, always arms the failure backoff, and never touches
 * seen-history. A genuine fetch keeps the full 24h TTL exactly as before.
 */

jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    set: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
    ttl: jest.fn(),
    multi: jest.fn(),
  },
}));
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    userMemory: { findUnique: jest.fn() },
    crossModelChat: { findMany: jest.fn() },
    user: { findMany: jest.fn() },
  },
}));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  // `log` is required by utils/log-level's logExternal (object form) — the
  // a800a12d taxonomy change routes the news formatter ladder through it.
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));
jest.mock('../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: jest.fn(),
  isUtilityLLMAvailable: jest.fn(() => true),
  utilityChainUnconfigured: jest.fn(async () => false),
  utilityLLMHealthSnapshot: jest.fn(() => ({ summary: 'healthy', detail: {} })),
}));
jest.mock('./mcp-search', () => ({
  __esModule: true,
  searchWithBrightData: jest.fn(),
}));
// The fetch-breaker trip files an auto-ticket via a dynamic import — keep the
// real feedback service (and its env-parse chain) out of this suite.
jest.mock('./feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 'auto-ticket-stub' } })),
}));

import redisClient from '../../config/redis';
import prisma from '../../config/database';
import { utilityChat } from '../../utils/utility-llm';
import { searchWithBrightData } from './mcp-search';
import {
  prefetchNewsForUser,
  fetchNewsHeadlines,
  MIN_HEALTHY_HEADLINES,
  __resetNewsFetchBreakerForTests,
  __resetNewsReformatGateForTests,
} from './news.service';

const mockedUtilityChat = utilityChat as jest.Mock;
const mockedSearch = searchWithBrightData as jest.Mock;
const mockedRedis = redisClient as unknown as {
  get: jest.Mock; set: jest.Mock; setEx: jest.Mock; del: jest.Mock; ttl: jest.Mock; multi: jest.Mock;
};
const mockedPrisma = prisma as unknown as {
  userMemory: { findUnique: jest.Mock };
  crossModelChat: { findMany: jest.Mock };
};

const NEWS_CACHE_TTL_SECONDS = 24 * 60 * 60;
const NEWS_THIN_TTL_SECONDS = 30 * 60;

// Each fixture headline carries ONE distinct topic word beyond a shared
// 2-token prefix, so the near-duplicate gate (token-Jaccard ≥ 0.7) keeps every
// item: intersection 2 of union 4 = 0.5. This ticket is specifically about a
// fallback that is LARGE ENOUGH (≥ MIN_HEALTHY_HEADLINES) to look healthy, so
// the fixture must not silently collapse to a single headline.
const TOPIC_WORDS = [
  'election', 'wildfire', 'spacex', 'senate', 'hurricane', 'inflation', 'playoff', 'verdict',
  'protest', 'eclipse', 'merger', 'vaccine', 'cyberattack', 'olympics', 'embargo', 'landslide',
  'blackout', 'strike', 'tsunami', 'recall', 'drought', 'summit', 'ceasefire', 'bankruptcy', 'launch',
];

const mkItem = (headline: string, category = 'us') => ({
  headline,
  summary: `${headline} — a concrete event with specifics.`,
  category,
  chatPrompt: `What happened with ${headline}?`,
});

const mkItems = (n: number, prefix = 'Story about') =>
  Array.from({ length: n }, (_, i) => mkItem(`${prefix} ${TOPIC_WORDS[i % TOPIC_WORDS.length]} ${i}`));

/** The shared outage fallback: ANOTHER user's briefing, served because OUR fetch failed. */
const mkFallbackItems = (n: number) => mkItems(n, 'Fallback item');

/**
 * Run prefetchNewsForUser under fake timers so the 3s prefetch retry does not
 * cost wall-clock time (the idiom the existing news suite uses).
 */
const runPrefetch = async (userId = 'u1') => {
  jest.useFakeTimers();
  try {
    const pending = prefetchNewsForUser(userId);
    await jest.advanceTimersByTimeAsync(4000);
    return await pending;
  } finally {
    jest.useRealTimers();
  }
};

/** setEx calls that touch the user's own briefing key (ignores SERP/fallback/backoff keys). */
const userBriefingWrites = (userId = 'u1') =>
  mockedRedis.setEx.mock.calls.filter(c => c[0] === `user:news:${userId}`);

const backoffWrites = (userId = 'u1') =>
  mockedRedis.setEx.mock.calls.filter(c => c[0] === `user:news:backoff:${userId}`);

const seenWrites = (userId = 'u1') =>
  mockedRedis.setEx.mock.calls.filter(c => String(c[0]).startsWith(`user:news:seen:${userId}`));

/** Make the formatter FAIL in the way the incident's telemetry shows (prose, no JSON array). */
const makeFormatterFail = () =>
  mockedUtilityChat.mockResolvedValue('Sorry — I could not find any stories worth reporting right now.');

const serveFallbackOf = (items: any[]) =>
  mockedRedis.get.mockImplementation(async (key: string) =>
    key === 'news:headlines:fallback' ? JSON.stringify(items) : null
  );

beforeEach(() => {
  jest.clearAllMocks();
  __resetNewsFetchBreakerForTests();
  __resetNewsReformatGateForTests();
  mockedRedis.get.mockResolvedValue(null);
  mockedRedis.set.mockResolvedValue('OK');
  mockedRedis.setEx.mockResolvedValue('OK');
  mockedRedis.del.mockResolvedValue(1);
  mockedPrisma.userMemory.findUnique.mockResolvedValue({ facts: {} });
  mockedPrisma.crossModelChat.findMany.mockResolvedValue([]);
  mockedSearch.mockResolvedValue('[Web Search Results]\n1. Fed signals rate cut… 2. Wildfire evacuations…');
});

describe('ticket 4888d891 — outage-fallback content is never pinned as the user briefing', () => {
  it('REPLAY: a failed fetch that serves a LARGE fallback does NOT get the 24h TTL', async () => {
    // The incident shape: our formatter fails, and the shared fallback happens
    // to hold ≥ MIN_HEALTHY_HEADLINES items — enough to look like success.
    makeFormatterFail();
    serveFallbackOf(mkFallbackItems(MIN_HEALTHY_HEADLINES + 5));

    const result = await runPrefetch('u1');

    // The degraded stopgap is still SHOWN (better than a blank panel)…
    expect(result.length).toBeGreaterThanOrEqual(MIN_HEALTHY_HEADLINES);
    // …but it must NOT be pinned for 24h as this user's own briefing.
    const writes = userBriefingWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toBe(NEWS_THIN_TTL_SECONDS);
    expect(writes[0][1]).not.toBe(NEWS_CACHE_TTL_SECONDS);
  });

  it('REPLAY: a failed fetch arms the failure backoff so the next tick repairs it', async () => {
    makeFormatterFail();
    serveFallbackOf(mkFallbackItems(MIN_HEALTHY_HEADLINES + 5));

    await runPrefetch('u1');

    // Without this the card sat on stale outage news until the next target hour.
    expect(backoffWrites()).not.toHaveLength(0);
  });

  it('REPLAY: fallback headlines never enter the seen-history that suppresses our next real briefing', async () => {
    makeFormatterFail();
    serveFallbackOf(mkFallbackItems(MIN_HEALTHY_HEADLINES + 5));

    await runPrefetch('u1');

    // Recording another user's headlines here would rotate the user's OWN
    // genuine stories out of the next briefing for stories they never saw.
    expect(seenWrites()).toHaveLength(0);
  });

  it('a retry that ALSO serves the fallback is not promoted as an improvement', async () => {
    makeFormatterFail();
    // First pass serves a small fallback, the retry serves a larger one — still
    // the same failure class, so the short TTL must still govern.
    let read = 0;
    mockedRedis.get.mockImplementation(async (key: string) => {
      if (key !== 'news:headlines:fallback') return null;
      read += 1;
      return JSON.stringify(mkFallbackItems(read === 1 ? 6 : 12));
    });

    const result = await runPrefetch('u1');

    expect(result.length).toBeGreaterThan(0);
    const writes = userBriefingWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toBe(NEWS_THIN_TTL_SECONDS);
    expect(backoffWrites()).not.toHaveLength(0);
  });

  it('a fetch with NO fallback available caches nothing and arms the backoff', async () => {
    makeFormatterFail();
    mockedRedis.get.mockResolvedValue(null); // outage with a cold fallback key

    const result = await runPrefetch('u1');

    expect(result).toHaveLength(0);
    expect(userBriefingWrites()).toHaveLength(0);
    expect(backoffWrites()).not.toHaveLength(0);
  });

  it('NO REGRESSION: a genuine healthy fetch keeps the full 24h TTL and no backoff', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(20)));
    // A fallback key exists but must be irrelevant — our own fetch succeeded.
    serveFallbackOf(mkFallbackItems(20));

    const result = await runPrefetch('u1');

    expect(result).toHaveLength(20);
    expect(result.every((h: any) => String(h.headline).startsWith('Story about'))).toBe(true);
    const writes = userBriefingWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toBe(NEWS_CACHE_TTL_SECONDS);
    expect(backoffWrites()).toHaveLength(0);
  });

  it('NO REGRESSION: a genuine THIN fetch still caches with the short TTL and records seen-history', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(3)));

    const result = await runPrefetch('u1');

    expect(result).toHaveLength(3);
    const writes = userBriefingWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toBe(NEWS_THIN_TTL_SECONDS);
    // A real (if thin) briefing IS something the user saw — rotation still applies.
    expect(seenWrites()).not.toHaveLength(0);
    expect(backoffWrites()).not.toHaveLength(0);
  });

  it('fetchNewsHeadlines reports its provenance for both outcomes', async () => {
    // Genuine fetch → 'fetch'
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(20)));
    const okOutcome: any = { source: 'none' };
    await fetchNewsHeadlines('', '', '', [], okOutcome);
    expect(okOutcome.source).toBe('fetch');

    // Total failure → 'fallback' (and it served the shared key)
    __resetNewsFetchBreakerForTests();
    jest.clearAllMocks();
    mockedRedis.set.mockResolvedValue('OK');
    mockedRedis.setEx.mockResolvedValue('OK');
    mockedRedis.del.mockResolvedValue(1);
    mockedSearch.mockResolvedValue('[Web Search Results]\n1. Something…');
    makeFormatterFail();
    serveFallbackOf(mkFallbackItems(10));
    const failOutcome: any = { source: 'none' };
    await fetchNewsHeadlines('', '', '', [], failOutcome);
    expect(failOutcome.source).toBe('fallback');
  });

  it('a caller that passes NO outcome object still works unchanged (back-compat)', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(20)));
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(20);
  });
});
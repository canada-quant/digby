/**
 * Tests for news.service.ts — briefing quality gate.
 *
 * Covers the 2026-07-12 "AP says July 11, 2026 is the 192nd day of the year"
 * incident: a sparse web-search day produced a 1-item almanac-trivia briefing
 * that passed the old `length > 0` success gate, was cached for 24h as the
 * user's entire Daily Briefing, and was written to the global fallback key.
 *
 * Also covers the 2026-07-12 model policy: news runs on BrightData SERP
 * grounding + utilityChat (DeepSeek V4 Flash → Qwen 3.6 27B) — no OpenAI.
 *
 * Redis / Prisma / utility-llm / mcp-search are mocked; no network or DB required.
 *
 * The fetch circuit breaker lives in module-level state; beforeEach resets it via
 * __resetNewsFetchBreakerForTests() so tests stay order-independent (several
 * tests intentionally record fetch failures).
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
// logger transitively imports config/env, whose Zod validation process.exit(1)s
// in a keyless test environment — mock it out like the other suites do.
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  // `log` is required by utils/log-level's logExternal (object form) — the
  // a800a12d taxonomy change routes the news formatter ladder through it.
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));
// News fetching runs on BrightData SERP grounding + utilityChat (DeepSeek V4
// Flash → Qwen fallback) — no OpenAI (2026-07-12 policy). Mock both.
// 1105650b: utilityLLMHealthSnapshot is also consumed by the fetch-breaker
// auto-ticket — mock it (the real one reads key/env state the suite does not set).
jest.mock('../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: jest.fn(),
  isUtilityLLMAvailable: jest.fn(() => true),
  // 2026-10-26 self-host gate: the scheduler tick consults this — default
  // CONFIGURED so the existing fetch tests keep exercising the pipeline.
  utilityChainUnconfigured: jest.fn(async () => false),
  utilityLLMHealthSnapshot: jest.fn(() => ({
    summary: 'dual-provider failure streak 0; DeepSeek leg active; DashScope leg active',
    detail: { dualFailureStreak: 0, deepseekBillingLatched: false, overrideLatched: false, deepseekKeyPresent: true, dashscopeKeyPresent: true, lastDeepseekError: '', lastDashscopeError: '' },
  })),
}));
jest.mock('./mcp-search', () => ({
  __esModule: true,
  searchWithBrightData: jest.fn(),
}));
// Post-fe661565 the fetch-breaker trip files an auto-ticket via a dynamic
// import of the feedback service — keep the real module (and its env-parse
// chain) out of this suite; several tests below intentionally trip the breaker.
jest.mock('./feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 'auto-ticket-stub' } })),
}));

import redisClient from '../../config/redis';
import prisma from '../../config/database';
import { utilityChat } from '../../utils/utility-llm';
import { searchWithBrightData } from './mcp-search';
import {
  isJunkHeadline,
  filterJunkHeadlines,
  isAggregatorHeadline,
  isStaleHeadline,
  extractHeadlineDate,
  dedupeHeadlines,
  normalizeHeadlineKey,
  filterBriefingQuality,
  partitionBySeen,
  getNewsFromCache,
  fetchNewsHeadlines,
  inferNewsTopics,
  prefetchNewsForUser,
  isNewsFailureBackoff,
  isNewsFetchCircuitOpen,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const mkItem = (headline: string, category = 'us') => ({
  headline,
  summary: `${headline} — summary sentence.`,
  category,
  chatPrompt: `Tell me more about: ${headline}?`,
});

// Distinct topic words per item so the near-duplicate gate (token-Jaccard ≥ 0.7)
// doesn't collapse the generated set — identical templates with only a number
// differing are near-dupes by design.
const TOPIC_WORDS = [
  'election', 'wildfire', 'spacex', 'senate', 'hurricane', 'inflation', 'playoff', 'verdict',
  'protest', 'eclipse', 'merger', 'vaccine', 'cyberattack', 'olympics', 'embargo', 'landslide',
  'blackout', 'strike', 'tsunami', 'recall', 'summit', 'drought', 'bankruptcy', 'ceasefire', 'launch',
];
const mkItems = (n: number) =>
  Array.from({ length: n }, (_, i) => mkItem(`Real news story about ${TOPIC_WORDS[i % TOPIC_WORDS.length]}`));

const ALMANAC_HEADLINE = 'AP says July 11, 2026 is the 192nd day of the year';

beforeEach(() => {
  jest.clearAllMocks();
  __resetNewsFetchBreakerForTests();
  __resetNewsReformatGateForTests();
  mockedRedis.get.mockResolvedValue(null);
  mockedRedis.set.mockResolvedValue('OK');       // NX locks acquire by default
  mockedRedis.setEx.mockResolvedValue('OK');
  mockedRedis.del.mockResolvedValue(1);
  mockedPrisma.userMemory.findUnique.mockResolvedValue({ facts: {} });
  mockedPrisma.crossModelChat.findMany.mockResolvedValue([]);
  // Default: BrightData returns a plausible SERP block; individual tests override.
  mockedSearch.mockResolvedValue('[Web Search Results]\nQuery: top US news\n\n1. Fed signals rate cut… 2. Wildfire evacuations…');
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Junk filter ───────────────────────────────────────────────────────────────

describe('isJunkHeadline', () => {
  it('flags almanac / day-of-year trivia', () => {
    expect(isJunkHeadline(ALMANAC_HEADLINE)).toBe(true);
    expect(isJunkHeadline('Today is the 192nd day of 2026')).toBe(true);
    expect(isJunkHeadline('Today in History: July 11')).toBe(true);
    expect(isJunkHeadline('On this day in 1804, the famous duel took place')).toBe(true);
    expect(isJunkHeadline('There are 173 days left in the year')).toBe(true);
    expect(isJunkHeadline('173 days remaining in the year after today')).toBe(true);
  });

  it('keeps genuine news headlines', () => {
    expect(isJunkHeadline('Fed signals rate cut as inflation cools')).toBe(false);
    expect(isJunkHeadline('Wildfire forces evacuations across two counties')).toBe(false);
    expect(isJunkHeadline('Stocks close out their best day of the year')).toBe(false); // no digit ordinal
    expect(isJunkHeadline('SpaceX launches 192 satellites in record mission')).toBe(false);
  });

  it('spares verified real-headline false positives (2026-07-12 review)', () => {
    // Possessive / hyphenated "year" phrasing
    expect(isJunkHeadline("Cleanup begins on 2nd day of the year's worst flooding")).toBe(false);
    expect(isJunkHeadline('Protesters mark 100th day of the year-long war')).toBe(false);
    // Genuine New Year's news (ordinal < 32 with a year)
    expect(isJunkHeadline('At least 10 dead in attack on 1st day of 2026')).toBe(false);
    // December deadline coverage (small day-count)
    expect(isJunkHeadline('With 10 days left in the year, Congress races to avert a shutdown')).toBe(false);
    // Commemoration quotes — only almanac "on this day in <year>/history" or "On This Day:" is junk
    expect(isJunkHeadline('On this day of remembrance, families gather at Ground Zero')).toBe(false);
    expect(isJunkHeadline("Biden: 'On this day we honor our fallen heroes'")).toBe(false);
    // …while the almanac shapes stay caught
    expect(isJunkHeadline('On This Day: July 11')).toBe(true);
    expect(isJunkHeadline('192nd day of 2026 brings record heat')).toBe(true);
  });
});

describe('filterJunkHeadlines', () => {
  it('drops junk and items without usable headline text', () => {
    const items = [
      mkItem('Fed signals rate cut as inflation cools'),
      mkItem(ALMANAC_HEADLINE),
      { headline: '   ', summary: 'x', chatPrompt: 'y' },
      { summary: 'no headline at all', chatPrompt: 'y' },
      mkItem('Wildfire forces evacuations across two counties'),
    ];
    const kept = filterJunkHeadlines(items as any[]);
    expect(kept.map((i: any) => i.headline)).toEqual([
      'Fed signals rate cut as inflation cools',
      'Wildfire forces evacuations across two counties',
    ]);
  });
});

// ── Aggregator hub titles / staleness / dedup (2026-08-31) ────────────────────
// Paul's live 2026-08-31 briefing showed "Top U.S. & World Headlines — August
// 28, 2026" side-by-side with the same hub's July 31 edition: stale dated SEO
// pages parroted as stories, duplicated, zero personalization. These gates are
// deterministic — the model is asked nicely (prompt rules), the code makes sure.

describe('isAggregatorHeadline', () => {
  it('flags dated roundup / hub page titles', () => {
    expect(isAggregatorHeadline('Top U.S. & World Headlines — August 28, 2026')).toBe(true);
    expect(isAggregatorHeadline('Top U.S. & World Headlines — July 31, 2026')).toBe(true);
    expect(isAggregatorHeadline('Top 10 Headlines Today: what you missed')).toBe(true);
    expect(isAggregatorHeadline('Morning News Digest: what you need to know')).toBe(true);
    expect(isAggregatorHeadline('Your daily news roundup for busy people')).toBe(true);
    expect(isAggregatorHeadline('The week in review: markets, sports and more')).toBe(true);
  });

  it('keeps specific real stories (incl. ones starting with "Top" or "Morning")', () => {
    expect(isAggregatorHeadline('Fed signals rate cut as inflation cools')).toBe(false);
    expect(isAggregatorHeadline('Top court upholds voting rights ruling')).toBe(false);
    expect(isAggregatorHeadline('Wildfire forces evacuations across two counties')).toBe(false);
    expect(isAggregatorHeadline('Morningstar upgrades three semiconductor stocks')).toBe(false);
  });
});

describe('isStaleHeadline', () => {
  const NOW = new Date(2026, 7, 31, 12, 0, 0); // Aug 31, 2026 (local noon)

  it('flags headlines embedding a date older than the freshness window', () => {
    expect(isStaleHeadline('Top U.S. & World Headlines — July 31, 2026', NOW)).toBe(true);   // 31 days
    expect(isStaleHeadline('Top U.S. & World Headlines — August 28, 2026', NOW)).toBe(true); // 3 days
  });

  it('keeps recent dates, undated headlines, and future event dates', () => {
    expect(isStaleHeadline('Markets rally on August 30, 2026 as rates fall', NOW)).toBe(false); // 1 day
    expect(isStaleHeadline('Stocks slip ahead of August 29, 2026 deadline', NOW)).toBe(false);  // exactly 2 days = inside window
    expect(isStaleHeadline('Fed signals rate cut as inflation cools', NOW)).toBe(false);        // no date
    expect(isStaleHeadline('Apple event set for September 9, 2026', NOW)).toBe(false);          // future
    expect(isStaleHeadline('What to expect at the September 2 hearing', NOW)).toBe(false);      // yearless, 2 days ahead
  });

  it('resolves yearless dates to the nearest occurrence (Dec 28 read on Jan 2 is 5 days old)', () => {
    const JAN2 = new Date(2027, 0, 2, 12, 0, 0);
    expect(isStaleHeadline('Storm cleanup continues from December 28 floods', JAN2)).toBe(true);
    expect(isStaleHeadline('New storm arrives December 31', JAN2)).toBe(false); // 2 days old
  });

  it('extractHeadlineDate returns null for undated headlines, numerals, and month-year forms', () => {
    expect(extractHeadlineDate('Fed signals rate cut as inflation cools', NOW)).toBeNull();
    expect(extractHeadlineDate('SpaceX launches 192 satellites in record mission', NOW)).toBeNull();
    expect(extractHeadlineDate('August 2026 jobs report surprises economists', NOW)).toBeNull();
  });
});

describe('dedupeHeadlines', () => {
  it('drops exact dupes after date-stripping normalization and near-dupes of the same story', () => {
    const items = [
      mkItem('Top U.S. & World Headlines — August 28, 2026'),
      mkItem('Top US and World Headlines — July 31, 2026'), // same hub series, reworded
      mkItem('Fed signals rate cut as inflation cools'),
      mkItem('Fed signals a rate cut as inflation cools'),   // same story reworded
      mkItem('Wildfire forces evacuations across two counties'),
    ];
    expect(dedupeHeadlines(items as any[]).map((i: any) => i.headline)).toEqual([
      'Top U.S. & World Headlines — August 28, 2026',
      'Fed signals rate cut as inflation cools',
      'Wildfire forces evacuations across two counties',
    ]);
  });

  it('keeps genuinely distinct stories and preserves order', () => {
    const items = mkItems(6);
    expect(dedupeHeadlines(items as any[]).map((i: any) => i.headline)).toEqual(items.map(i => i.headline));
  });
});

describe('filterBriefingQuality', () => {
  const NOW = new Date(2026, 7, 31, 12, 0, 0);
  it('composes junk + aggregator + staleness + dedup into one gate', () => {
    const items = [
      mkItem(ALMANAC_HEADLINE),                                        // junk
      mkItem('Top U.S. & World Headlines — August 28, 2026'),          // aggregator (also stale)
      mkItem('Old story from July 31, 2026 still ranking today'),      // stale
      ...mkItems(3),
      mkItem(`Real news story about ${TOPIC_WORDS[0]}`),               // exact dupe of mkItems(3)[0]
    ];
    const kept = filterBriefingQuality(items as any[], NOW);
    expect(kept.map((i: any) => i.headline)).toEqual(mkItems(3).map(i => i.headline));
  });
});

// ── Read-time self-healing ────────────────────────────────────────────────────

describe('getNewsFromCache', () => {
  it('treats an all-junk cached briefing as a cache miss (self-heal)', async () => {
    mockedRedis.get.mockResolvedValue(JSON.stringify([mkItem(ALMANAC_HEADLINE)]));
    expect(await getNewsFromCache('u1')).toBeNull();
  });

  it('strips junk rows from a mixed cached briefing', async () => {
    mockedRedis.get.mockResolvedValue(JSON.stringify([
      mkItem('Fed signals rate cut as inflation cools'),
      mkItem(ALMANAC_HEADLINE),
    ]));
    const result = await getNewsFromCache('u1');
    expect(result).toHaveLength(1);
    expect(result![0].headline).toBe('Fed signals rate cut as inflation cools');
  });

  it('returns null for missing keys and non-array payloads', async () => {
    mockedRedis.get.mockResolvedValue(null);
    expect(await getNewsFromCache('u1')).toBeNull();
    mockedRedis.get.mockResolvedValue(JSON.stringify({ nope: true }));
    expect(await getNewsFromCache('u1')).toBeNull();
  });
});

// ── Fetch-level quality gate ──────────────────────────────────────────────────

/** setEx calls that touch user briefings or the global fallback (ignores the SERP cache). */
const briefingWrites = () =>
  mockedRedis.setEx.mock.calls.filter(c => !String(c[0]).startsWith('news:serp:'));

describe('fetchNewsHeadlines', () => {
  it('returns a healthy briefing and writes the global fallback cache', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(20)));
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(20);
    // Grounded via BrightData before formatting
    expect(mockedSearch).toHaveBeenCalled();
    // Provider contract: JSON-only via contentOnly, reasoning-aware token budget
    expect(mockedUtilityChat.mock.calls[0][1]).toMatchObject({ contentOnly: true, maxTokens: 8000 });
    // Fallback cache written (setEx on news:headlines:fallback)
    const fallbackWrite = mockedRedis.setEx.mock.calls.find(c => c[0] === 'news:headlines:fallback');
    expect(fallbackWrite).toBeDefined();
  });

  it('serves the SERP from the shared cache without re-searching', async () => {
    mockedRedis.get.mockImplementation(async (key: string) =>
      String(key).startsWith('news:serp:') ? '[Web Search Results]\ncached SERP block' : null
    );
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(20)));
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(20);
    expect(mockedSearch).not.toHaveBeenCalled(); // every query hit the cluster-shared cache
  });

  it('caches a healthy-but-partial briefing for the user WITHOUT overwriting the global fallback', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(8))); // >= MIN, < FALLBACK_MIN
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(8);
    expect(mockedRedis.setEx.mock.calls.find(c => c[0] === 'news:headlines:fallback')).toBeUndefined();
  });

  it('strips junk rows from a healthy briefing and never writes junk to the fallback', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify([...mkItems(19), mkItem(ALMANAC_HEADLINE)]));
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(19);
    expect(result.some((h: any) => h.headline === ALMANAC_HEADLINE)).toBe(false);
    const fallbackWrite = mockedRedis.setEx.mock.calls.find(c => c[0] === 'news:headlines:fallback');
    expect(fallbackWrite).toBeDefined();
    expect(fallbackWrite![2]).not.toContain(ALMANAC_HEADLINE); // payload is the filtered set
  });

  it('junk-filters a legacy-poisoned fallback before serving it', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify([mkItem(ALMANAC_HEADLINE)])); // all-junk fetch → fallback path
    mockedRedis.get.mockImplementation(async (key: string) =>
      key === 'news:headlines:fallback' ? JSON.stringify([...mkItems(10), mkItem(ALMANAC_HEADLINE)]) : null
    );
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(10);
    expect(result.some((h: any) => h.headline === ALMANAC_HEADLINE)).toBe(false);
  });

  it('fails over to the fallback cache when every search returns empty (no LLM call)', async () => {
    mockedSearch.mockResolvedValue('');
    mockedRedis.get.mockImplementation(async (key: string) =>
      key === 'news:headlines:fallback' ? JSON.stringify(mkItems(8)) : null
    );
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(8);
    expect(mockedUtilityChat).not.toHaveBeenCalled();
  });

  it('treats a lone almanac-trivia item as a failure and serves the fallback', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify([mkItem(ALMANAC_HEADLINE)]));
    mockedRedis.get.mockImplementation(async (key: string) =>
      key === 'news:headlines:fallback' ? JSON.stringify(mkItems(10)) : null // last known-good fallback
    );
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(10);
    expect(result.some((h: any) => h.headline === ALMANAC_HEADLINE)).toBe(false);
    // No reformat call (JSON parsed fine) and no briefing/fallback writes
    expect(mockedUtilityChat).toHaveBeenCalledTimes(1);
    expect(briefingWrites()).toHaveLength(0);
  });

  it("keeps the user's own thin briefing instead of swapping in the global fallback", async () => {
    // 2026-07-12 review: the fallback is ANOTHER user's briefing — a thin but
    // genuine personalized result must win over it.
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(3)));
    mockedRedis.get.mockImplementation(async (key: string) =>
      key === 'news:headlines:fallback' ? JSON.stringify(mkItems(12)) : null // global fallback exists…
    );
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(3);                                 // …but is not used
    expect(briefingWrites()).toHaveLength(0); // thin fetch never writes fallback
  });

  it('recovers prose-wrapped output via a PERTURBED regenerate (not a byte-identical replay)', async () => {
    mockedUtilityChat
      .mockResolvedValueOnce('Here are the stories I found today — enjoy!') // no JSON at all
      .mockResolvedValueOnce(JSON.stringify(mkItems(15)));                   // regenerate succeeds
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(15);
    expect(mockedUtilityChat).toHaveBeenCalledTimes(2);
    // The regenerate must differ from the failed attempt: new framing + higher temperature
    const [firstMsgs, firstOpts] = mockedUtilityChat.mock.calls[0];
    const [secondMsgs, secondOpts] = mockedUtilityChat.mock.calls[1];
    expect(secondMsgs[1].content).not.toBe(firstMsgs[1].content);
    expect(secondOpts.temperature).toBeGreaterThan(firstOpts.temperature);
  });

  it('drops stale dated roundups and duplicate hub titles from the model output', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify([
      mkItem('Top U.S. & World Headlines — July 31, 2026'),
      ...mkItems(10),
      mkItem('Top U.S. & World Headlines — August 28, 2026'),
    ]));
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(10);
    expect(result.some((h: any) => h.headline.includes('World Headlines'))).toBe(false);
  });

  it('freshness-constrains every SERP query (after:) and splits free-text interests into individual seeds', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(20)));
    await fetchNewsHeadlines('Vancouver, BC', 'AI, hockey, real estate', '', []);
    const serpQueries = mockedSearch.mock.calls.map(c => c[0] as string);
    expect(serpQueries.every(q => /after:\d{4}-\d{2}-\d{2}/.test(q))).toBe(true);
    expect(serpQueries.some(q => q.startsWith('AI news today'))).toBe(true);
    expect(serpQueries.some(q => q.startsWith('hockey news today'))).toBe(true);
    expect(serpQueries.some(q => q.startsWith('real estate news today'))).toBe(true);
    expect(serpQueries.some(q => q.includes('AI, hockey'))).toBe(false); // no comma-mega-query
    expect(serpQueries.some(q => q.startsWith('Vancouver, BC local news today'))).toBe(true);
  });

  it('seeds an occupation-industry query when there are no interest signals at all', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(20)));
    await fetchNewsHeadlines('', '', 'software founder', []);
    const serpQueries = mockedSearch.mock.calls.map(c => c[0] as string);
    expect(serpQueries.some(q => q.startsWith('software founder industry news today'))).toBe(true);
  });

  it('warns the model about dated SEO roundups and demands interest relevance', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(20)));
    await fetchNewsHeadlines('', 'hockey', '', []);
    const prompt = mockedUtilityChat.mock.calls[0][0][1].content as string;
    expect(prompt).toMatch(/FRESHNESS IS CRITICAL/);
    expect(prompt).toMatch(/NEVER output aggregator, roundup, or hub page titles/);
    expect(prompt).toMatch(/Interest headlines MUST genuinely relate to: hockey/);
  });
});

// ── Tolerant repair strategy (#89) ────────────────────────────────────────────

describe('fetchNewsHeadlines — tolerant repair strategy (#89)', () => {
  const jsonOf = (n: number) => JSON.stringify(mkItems(n));

  it('rescues trailing commas without the LLM-reformat leg', async () => {
    mockedUtilityChat.mockResolvedValue(jsonOf(6).replace('}]', '},]'));
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(6);
    expect(result[0].headline).toBe('Real news story about election');
    expect(mockedUtilityChat).toHaveBeenCalledTimes(1);
  });

  it('rescues single-quoted JSON without the LLM-reformat leg', async () => {
    mockedUtilityChat.mockResolvedValue(jsonOf(6).replace(/"/g, "'"));
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(6);
    expect(mockedUtilityChat).toHaveBeenCalledTimes(1);
  });

  it('rescues unquoted keys + JSON5 comments + zero-width chars', async () => {
    const malformed = jsonOf(6)
      .replace('[{', '[ /* generated output */ ​{')
      .replace(/"headline":/g, 'headline:')
      .replace(/"summary":/g, 'summary:')
      .replace(/"category":/g, 'category:')
      .replace(/"chatPrompt":/g, 'chatPrompt:');
    mockedUtilityChat.mockResolvedValue(malformed);
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(6);
    expect(mockedUtilityChat).toHaveBeenCalledTimes(1);
  });

  it('still falls through to the LLM reformat for unrepairable content', async () => {
    mockedUtilityChat
      .mockResolvedValueOnce('[{"headline": "H1", @@garbage@@')
      .mockResolvedValueOnce(jsonOf(15));
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(15);
    expect(mockedUtilityChat).toHaveBeenCalledTimes(2);
  });

  it('gives the reformat leg output one repaired-parse attempt before failing', async () => {
    mockedUtilityChat
      .mockResolvedValueOnce('no usable JSON here at all')   // strategies 1-4 fail
      .mockResolvedValueOnce(jsonOf(15).replace('}]', '},]')); // reformat returns trailing-comma JSON
    const result = await fetchNewsHeadlines('', '', '', []);
    expect(result).toHaveLength(15);
    expect(mockedUtilityChat).toHaveBeenCalledTimes(2);
  });
});

// ── LLM-reformat leg gate (#148) ─────────────────────────────────────────────
// Prod telemetry (2026-08-05 nightly): the reformat leg succeeded ~5/935 times
// in 48h while every attempt costs a 30–60s utilityChat call on the provider
// pool that is already failing. After 8 consecutive failures the leg is gated
// for 30 min (half-open probe after the cooldown; success resets the streak).

describe('fetchNewsHeadlines — LLM-reformat leg gate (#148)', () => {
  const jsonOf = (n: number) => JSON.stringify(mkItems(n));
  const BAD = 'no usable JSON here at all';
  const driveFailedAttempt = () => fetchNewsHeadlines('', '', '', []);

  beforeEach(() => {
    // Persistent-BAD failure mode: every utilityChat call (main formatting AND
    // reformat leg) returns unparseable content, so each full event records one
    // reformat failure. Two utilityChat calls per ungated event, one when gated.
    // Persistent (not Once-chained) so a gated event — which consumes only the
    // main call — never leaves unconsumed Once entries to leak across tests.
    mockedUtilityChat.mockResolvedValue(BAD);
  });

  afterEach(() => {
    // mockClear (outer beforeEach) does not remove implementations — keep the
    // persistent BAD from leaking into the suites that run after this one.
    mockedUtilityChat.mockReset();
  });

  it('gates the reformat leg after 8 consecutive failures and stops spending utility calls on it', async () => {
    for (let i = 0; i < 8; i++) await driveFailedAttempt();
    expect(mockedUtilityChat).toHaveBeenCalledTimes(16); // 8 events × (main + reformat)
    await driveFailedAttempt();                          // gated: reformat leg skipped
    expect(mockedUtilityChat).toHaveBeenCalledTimes(17); // main call only
  });

  it('half-opens after the cooldown and re-gates when the probe fails', async () => {
    const realNow = Date.now();
    const dateSpy = jest.spyOn(Date, 'now');
    try {
      dateSpy.mockReturnValue(realNow);
      for (let i = 0; i < 8; i++) await driveFailedAttempt();
      await driveFailedAttempt();
      expect(mockedUtilityChat).toHaveBeenCalledTimes(17); // gated
      dateSpy.mockReturnValue(realNow + 31 * 60 * 1000);   // past the 30-min cooldown
      // Test isolation: the +31min jump would otherwise satisfy the independent
      // FETCH breaker's 60s-span condition (streak ≥ 4) and short-circuit the
      // whole fetch — masking the reformat-gate behavior under test.
      __resetNewsFetchBreakerForTests();
      await driveFailedAttempt();                          // probe: reformat runs, fails → re-gates
      expect(mockedUtilityChat).toHaveBeenCalledTimes(19);
      await driveFailedAttempt();                          // re-gated: skipped again
      expect(mockedUtilityChat).toHaveBeenCalledTimes(20);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('resets the failure streak on a successful reformat', async () => {
    for (let i = 0; i < 7; i++) await driveFailedAttempt(); // streak 7 — just under the gate
    mockedUtilityChat
      .mockResolvedValueOnce(BAD)                           // main: unparseable
      .mockResolvedValueOnce(jsonOf(15));                   // reformat succeeds
    const ok = await driveFailedAttempt();
    expect(ok).toHaveLength(15);                            // reformat succeeded → streak 0
    mockedUtilityChat.mockClear();                          // reset the count, keep the persistent BAD
    // Without the reset the gate would trip after a single new failure; with it,
    // a full 8 fresh failures are required — 16 more utility calls.
    for (let i = 0; i < 8; i++) await driveFailedAttempt();
    expect(mockedUtilityChat).toHaveBeenCalledTimes(16);
    await driveFailedAttempt();                             // only now gated
    expect(mockedUtilityChat).toHaveBeenCalledTimes(17);
  });
});

// ── Prefetch retry + thin-cache TTL ──────────────────────────────────────────

// ── Inferred news topics (ticket 6c037cc6) ────────────────────────────────────
// Raw chat titles used to seed the SERP queries literally, so an owner whose
// chats are all "Fleet Supervisor …" got management news. The inference step
// reasons over memory facts + titles and outputs reader topics; any failure
// falls back to the raw title list.

describe('inferNewsTopics', () => {
  const FACTS = { interests: 'basketball, AI', location: 'Vancouver' };
  const TITLES = ['Fleet Supervisor Ops Tick', 'Knicks trade deadline chat'];
  const TOPICS = ['AI model releases', 'New York Knicks', 'Vancouver housing market'];

  it('returns the raw titles untouched when there is nothing to reason over (no facts, no titles)', async () => {
    const out = await inferNewsTopics('u1', {}, []);
    expect(out).toEqual([]);
    expect(mockedUtilityChat).not.toHaveBeenCalled();
    expect(mockedRedis.get).not.toHaveBeenCalled();
  });

  it('serves cached topics without calling the LLM', async () => {
    mockedRedis.get.mockImplementation(async (key: string) =>
      key === 'user:news:topics:u1' ? JSON.stringify(TOPICS) : null
    );
    const out = await inferNewsTopics('u1', FACTS, TITLES);
    expect(out).toEqual(TOPICS);
    expect(mockedUtilityChat).not.toHaveBeenCalled();
  });

  it('infers topics via utilityChat (fence-stripped JSON), caches them with the 6h TTL', async () => {
    mockedUtilityChat.mockResolvedValue('```json\n' + JSON.stringify(TOPICS) + '\n```');
    const out = await inferNewsTopics('u1', FACTS, TITLES);
    expect(out).toEqual(TOPICS);
    // The prompt carries both signal sources, and the reasoning instruction.
    const prompt = mockedUtilityChat.mock.calls[0][0][1].content as string;
    expect(prompt).toContain('interests: basketball, AI');
    expect(prompt).toContain('Fleet Supervisor Ops Tick');
    expect(prompt).toMatch(/never seed news from the tool or project jargon/);
    const cacheWrite = mockedRedis.setEx.mock.calls.find(c => c[0] === 'user:news:topics:u1');
    expect(cacheWrite).toBeDefined();
    expect(cacheWrite![1]).toBe(6 * 60 * 60);
    expect(JSON.parse(cacheWrite![2])).toEqual(TOPICS);
  });

  it('extracts a bracket span from prose-wrapped output (parse idiom parity)', async () => {
    mockedUtilityChat.mockResolvedValue(`Here you go: ${JSON.stringify(TOPICS)} — enjoy!`);
    const out = await inferNewsTopics('u1', FACTS, TITLES);
    expect(out).toEqual(TOPICS);
  });

  it.each([
    ['empty content', ''],
    ['pure prose', 'I could not determine any topics for this user.'],
    ['thin result (< 3 topics)', JSON.stringify(['just one topic'])],
    ['non-string entries only', JSON.stringify([1, 2, 3])],
  ])('falls back to the raw title list on %s (and caches nothing)', async (_label, content) => {
    mockedUtilityChat.mockResolvedValue(content);
    const out = await inferNewsTopics('u1', FACTS, TITLES);
    expect(out).toEqual(TITLES);
    expect(mockedRedis.setEx.mock.calls.find(c => c[0] === 'user:news:topics:u1')).toBeUndefined();
  });

  it('falls back to the raw title list when the LLM call throws', async () => {
    mockedUtilityChat.mockRejectedValue(new Error('provider down'));
    const out = await inferNewsTopics('u1', FACTS, TITLES);
    expect(out).toEqual(TITLES);
  });
});

describe('prefetchNewsForUser — inferred topics wiring (ticket 6c037cc6)', () => {
  const TOPICS = ['AI model releases', 'New York Knicks', 'Vancouver housing market'];

  it('feeds INFERRED topics (not raw chat titles) into the SERP queries and the briefing prompt', async () => {
    mockedPrisma.crossModelChat.findMany.mockResolvedValue([
      { title: 'Fleet Supervisor Ops Tick' }, { title: 'Coding Session burn-down' },
    ]);
    mockedUtilityChat
      .mockResolvedValueOnce(JSON.stringify(TOPICS))          // topic inference
      .mockResolvedValueOnce(JSON.stringify(mkItems(20)));    // briefing format
    const result = await prefetchNewsForUser('u1');
    expect(result).toHaveLength(20);
    // SERP interest queries come from the inferred topics…
    const serpQueries = mockedSearch.mock.calls.map(c => c[0] as string);
    expect(serpQueries.some(q => q.startsWith('AI model releases'))).toBe(true);
    // …and never from the literal work-tooling titles.
    expect(serpQueries.some(q => q.includes('Fleet Supervisor'))).toBe(false);
    const briefingPrompt = mockedUtilityChat.mock.calls[1][0][1].content as string;
    expect(briefingPrompt).toContain('Recent topics: AI model releases');
    expect(briefingPrompt).not.toContain('Fleet Supervisor Ops Tick');
  });

  it('keeps the old raw-title seeding when inference fails (prose output)', async () => {
    mockedPrisma.crossModelChat.findMany.mockResolvedValue([{ title: 'Knicks trade deadline chat' }]);
    mockedUtilityChat
      .mockResolvedValueOnce('no json here')                  // inference fails → titles
      .mockResolvedValueOnce(JSON.stringify(mkItems(20)));    // briefing format
    const result = await prefetchNewsForUser('u1');
    expect(result).toHaveLength(20);
    const serpQueries = mockedSearch.mock.calls.map(c => c[0] as string);
    expect(serpQueries.some(q => q.startsWith('Knicks trade deadline chat'))).toBe(true);
  });
});

describe('prefetchNewsForUser', () => {
  it('caches a healthy briefing with the full 24h TTL and does not retry', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(20)));
    const result = await prefetchNewsForUser('u1');
    expect(result).toHaveLength(20);
    expect(mockedUtilityChat).toHaveBeenCalledTimes(1); // no retry needed
    const userWrite = mockedRedis.setEx.mock.calls.find(c => c[0] === 'user:news:u1');
    expect(userWrite).toBeDefined();
    expect(userWrite![1]).toBe(24 * 60 * 60);
  });

  it('retries a below-minimum briefing, caches a still-thin result with a short TTL, and arms the failure backoff', async () => {
    jest.useFakeTimers();
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(2)));
    mockedRedis.get.mockResolvedValue(null); // no backoff, no existing cache

    const pending = prefetchNewsForUser('u1');
    await jest.advanceTimersByTimeAsync(4000); // skip the 3s retry delay
    const result = await pending;

    expect(result).toHaveLength(2);
    expect(result.length).toBeLessThan(MIN_HEALTHY_HEADLINES);
    expect(mockedUtilityChat).toHaveBeenCalledTimes(2); // initial + retry
    const userWrite = mockedRedis.setEx.mock.calls.find(c => c[0] === 'user:news:u1');
    expect(userWrite).toBeDefined();
    expect(userWrite![1]).toBe(30 * 60); // thin briefings expire fast
    const backoffWrite = mockedRedis.setEx.mock.calls.find(c => c[0] === 'user:news:backoff:u1');
    expect(backoffWrite).toBeDefined(); // 6s polls can't relaunch the pipeline back-to-back
  });

  it('skips the fetch entirely while the failure backoff is armed', async () => {
    mockedRedis.get.mockImplementation(async (key: string) =>
      key === 'user:news:backoff:u1' ? '1' : null
    );
    const result = await prefetchNewsForUser('u1');
    expect(result).toEqual([]);
    expect(mockedSearch).not.toHaveBeenCalled();
    expect(mockedUtilityChat).not.toHaveBeenCalled();
  });

  it('never downgrades a larger existing cache with a thinner fetch result', async () => {
    jest.useFakeTimers();
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(2)));
    mockedRedis.get.mockImplementation(async (key: string) =>
      key === 'user:news:u1' ? JSON.stringify(mkItems(4)) : null // existing 4-item thin cache
    );

    const pending = prefetchNewsForUser('u1');
    await jest.advanceTimersByTimeAsync(4000);
    const result = await pending;

    expect(result).toHaveLength(4); // existing cache wins over the thinner fetch
    expect(mockedRedis.setEx.mock.calls.find(c => c[0] === 'user:news:u1')).toBeUndefined();
  });
});

// ── Seen-history rotation (2026-08-31) ────────────────────────────────────────
// A briefing should not repeat stories the user was already served. Fresh items
// always win; already-served items backfill only up to the healthy minimum.

describe('prefetchNewsForUser — seen-history rotation', () => {
  const seenPayloadFor = (items: any[]) =>
    JSON.stringify(items.map(i => normalizeHeadlineKey(i.headline)));

  it('rotates out already-served stories when enough fresh ones exist', async () => {
    const items = mkItems(20);
    mockedRedis.get.mockImplementation(async (key: string) =>
      key === 'user:news:seen:u1' ? seenPayloadFor(items.slice(0, 12)) : null
    );
    mockedUtilityChat.mockResolvedValue(JSON.stringify(items));
    const result = await prefetchNewsForUser('u1');
    expect(result.map((h: any) => h.headline)).toEqual(items.slice(12).map(i => i.headline));
    // The newly shown stories are merged into the seen set (48h TTL)
    const seenWrite = mockedRedis.setEx.mock.calls.find(c => c[0] === 'user:news:seen:u1');
    expect(seenWrite).toBeDefined();
    expect(seenWrite![1]).toBe(48 * 60 * 60);
    const merged = JSON.parse(seenWrite![2]);
    expect(merged).toEqual(expect.arrayContaining(items.slice(12).map(i => normalizeHeadlineKey(i.headline))));
    expect(merged).toEqual(expect.arrayContaining(items.slice(0, 12).map(i => normalizeHeadlineKey(i.headline))));
  });

  it('backfills with already-served stories on a slow news day (panel never degrades)', async () => {
    const items = mkItems(10);
    mockedRedis.get.mockImplementation(async (key: string) =>
      key === 'user:news:seen:u1' ? seenPayloadFor(items.slice(0, 8)) : null
    );
    mockedUtilityChat.mockResolvedValue(JSON.stringify(items));
    const result = await prefetchNewsForUser('u1');
    expect(result).toHaveLength(10);
    // Fresh stories lead; served ones backfill behind them
    expect(result.slice(0, 2).map((h: any) => h.headline)).toEqual(items.slice(8).map(i => i.headline));
  });

  it('serves everything when no seen-history exists yet (first-ever briefing)', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(20)));
    const result = await prefetchNewsForUser('u1');
    expect(result).toHaveLength(20);
    const seenWrite = mockedRedis.setEx.mock.calls.find(c => c[0] === 'user:news:seen:u1');
    expect(seenWrite).toBeDefined();
    expect(JSON.parse(seenWrite![2])).toHaveLength(20);
  });

  it('partitionBySeen preserves order within both partitions', () => {
    const items = mkItems(6);
    const seenKeys = new Set([1, 3, 5].map(i => normalizeHeadlineKey(items[i].headline)));
    const { unseen, seen } = partitionBySeen(items, seenKeys);
    expect(unseen.map(i => i.headline)).toEqual([0, 2, 4].map(i => items[i].headline));
    expect(seen.map(i => i.headline)).toEqual([1, 3, 5].map(i => items[i].headline));
  });
});

// ── Degraded-state read sides (ticket d86cf931) ───────────────────────────────
// The GET /news controller surfaces `degraded: true` from these two read sides
// so the home news card can admit "temporarily unavailable" instead of polling
// "every few seconds" for the length of an outage (2026-08-29 ~6h).

describe('isNewsFailureBackoff', () => {
  it('is true while the per-user failure backoff key is armed', async () => {
    mockedRedis.get.mockImplementation(async (key: string) =>
      key === 'user:news:backoff:u1' ? '1' : null
    );
    await expect(isNewsFailureBackoff('u1')).resolves.toBe(true);
  });

  it('is false when no backoff is armed', async () => {
    await expect(isNewsFailureBackoff('u1')).resolves.toBe(false);
  });

  it('fails open (false) on a Redis read error — a cache hiccup must not degrade the card', async () => {
    mockedRedis.get.mockRejectedValue(new Error('redis down'));
    await expect(isNewsFailureBackoff('u1')).resolves.toBe(false);
  });
});

describe('isNewsFetchCircuitOpen', () => {
  const BAD = 'no usable JSON here at all';

  it('is closed with a fresh breaker and after a single failure', async () => {
    expect(isNewsFetchCircuitOpen()).toBe(false);
    mockedUtilityChat.mockResolvedValue(BAD);
    await fetchNewsHeadlines('', '', '', []);
    expect(isNewsFetchCircuitOpen()).toBe(false); // threshold is 4 spanning ≥60s
    mockedUtilityChat.mockReset();
  });

  it('opens after a sustained failure streak (≥4 whole-fetch failures spanning ≥60s)', async () => {
    const realNow = Date.now();
    const dateSpy = jest.spyOn(Date, 'now');
    try {
      mockedUtilityChat.mockResolvedValue(BAD); // every leg unparseable → whole-fetch failure
      dateSpy.mockReturnValue(realNow);
      await fetchNewsHeadlines('', '', '', []); // streak 1, span 0
      expect(isNewsFetchCircuitOpen()).toBe(false);
      dateSpy.mockReturnValue(realNow + 61_000); // span now ≥60s
      for (let i = 0; i < 3; i++) await fetchNewsHeadlines('', '', '', []); // streak 4
      expect(isNewsFetchCircuitOpen()).toBe(true);
    } finally {
      dateSpy.mockRestore();
      mockedUtilityChat.mockReset();
    }
  });
});

/**
 * Per-item publication dates + freshness gate — ticket 94b93132 (bug, 2026-10-27).
 *
 * THE INCIDENT: a chat turn's injected news context block read "Context from
 * today's news: 'Wind and Waste Water Hazards at Shorelines in Oak Bay'…" with
 * NO date — the matching coverage is a Times Colonist piece dated Oct 28, 2021
 * (and a Dec 24, 2025 Oak Bay News piece). The formatter LLM saw the SERP date
 * labels (extractSerpOrganicForPrompt renders `item.date || item.age`), but the
 * OUTPUT CONTRACT dropped them: the schema was only
 * {headline,summary,category,chatPrompt}. The frontend then labeled the result
 * "today's news", and the agent answered from a 5-year-old story as if fresh.
 *
 * THE FIX (pinned here):
 *  1. The formatter prompt carries a `published` field — the SERP date/age
 *     label VERBATIM (never guessed); fetchNewsHeadlines normalizes it onto
 *     every item (useless non-dates → '').
 *  2. A deterministic gate: a parseable `published` label older than
 *     NEWS_MAX_PUBLISHED_AGE_DAYS (72h) drops the item — via
 *     filterBriefingQuality, so it runs at write time AND at read time
 *     (getNewsFromCache / fallback), self-healing briefings cached before the
 *     field existed.
 *  3. Unparseable labels PASS the gate and display verbatim downstream —
 *     nothing ever claims a freshness it cannot show (fail toward honest
 *     undated, not toward fake fresh).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => null), setEx: jest.fn(async () => undefined), del: jest.fn(async () => undefined) },
}));
jest.mock('../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: jest.fn(async () => '[]'),
  utilityLLM: jest.fn(),
  isUtilityLLMAvailable: jest.fn(() => true),
  utilityChainUnconfigured: jest.fn(async () => false),
  utilityLLMHealthSnapshot: jest.fn(() => ({
    summary: 'healthy',
    detail: { dualFailureStreak: 0, deepseekBillingLatched: false, overrideLatched: false, deepseekKeyPresent: true, dashscopeKeyPresent: true, lastDeepseekError: '', lastDashscopeError: '' },
  })),
}));
jest.mock('./mcp-search', () => ({
  __esModule: true,
  searchWithBrightData: jest.fn(async () => ''),
}));
jest.mock('./feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 'auto-ticket-1' } })),
}));

import {
  NEWS_MAX_PUBLISHED_AGE_DAYS,
  normalizePublishedLabel,
  parsePublishedLabel,
  isStalePublishedLabel,
  filterBriefingQuality,
  fetchNewsHeadlines,
  __resetNewsFetchBreakerForTests,
} from './news.service';
import { utilityChat } from '../../utils/utility-llm';
import { searchWithBrightData as mockSearchWithBrightData } from './mcp-search';

const NOW = new Date(2026, 9, 27, 12, 0, 0); // 2026-10-27 12:00 local
const DAY_MS = 24 * 60 * 60 * 1000;

const mockedUtilityChat = utilityChat as jest.Mock;
const mockedSearch = mockSearchWithBrightData as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  __resetNewsFetchBreakerForTests();
});

describe('normalizePublishedLabel (ticket 94b93132)', () => {
  it('keeps a real label verbatim (trimmed, whitespace-collapsed)', () => {
    expect(normalizePublishedLabel('  3   hours ago ')).toBe('3 hours ago');
    expect(normalizePublishedLabel('Oct 28, 2021')).toBe('Oct 28, 2021');
  });

  it('collapses useless non-dates to "" — the item displays undated, never fake-dated', () => {
    for (const junk of ['unknown', 'n/a', 'N/A', 'none', 'null', 'not available', 'no date', '', '   ']) {
      expect(normalizePublishedLabel(junk)).toBe('');
    }
    expect(normalizePublishedLabel(undefined)).toBe('');
    expect(normalizePublishedLabel(null)).toBe('');
  });

  it('caps pathological labels at 60 chars', () => {
    expect(normalizePublishedLabel('x'.repeat(120)).length).toBe(60);
  });
});

describe('parsePublishedLabel (ticket 94b93132)', () => {
  it('parses relative ages ("3 hours ago") against now', () => {
    const got = parsePublishedLabel('3 hours ago', NOW) as Date;
    expect(NOW.getTime() - got.getTime()).toBe(3 * 3_600_000);
    expect(parsePublishedLabel('2 weeks ago', NOW) as Date).toBeTruthy();
  });

  it('parses freshness words', () => {
    expect(parsePublishedLabel('today', NOW)).toBeTruthy();
    expect(parsePublishedLabel('yesterday', NOW)).toBeTruthy();
  });

  it('parses US month-first dates, reusing the headline parser (incl. yearless rollover)', () => {
    expect(parsePublishedLabel('Oct 28, 2021', NOW)).toEqual(new Date(2021, 9, 28));
    // "Oct 25" yearless read on Oct 27 = 2 days ago, not 2 days into the future
    expect(parsePublishedLabel('Oct 25', NOW)).toEqual(new Date(2026, 9, 25));
  });

  it('parses day-first European dates and ISO dates', () => {
    expect(parsePublishedLabel('28 Oct 2021', NOW)).toEqual(new Date(2021, 9, 28));
    expect(parsePublishedLabel('2021-10-28', NOW)).toEqual(new Date(2021, 9, 28));
  });

  it('parses a bare year conservatively (Jan 1 of that year)', () => {
    expect(parsePublishedLabel('2021', NOW)).toEqual(new Date(2021, 0, 1));
  });

  it('returns null on ambiguous numeric slash dates — they display, they cannot gate', () => {
    expect(parsePublishedLabel('10/28', NOW)).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(parsePublishedLabel('', NOW)).toBeNull();
  });
});

describe('isStalePublishedLabel — the 72h freshness gate (ticket 94b93132)', () => {
  it(`window is ${NEWS_MAX_PUBLISHED_AGE_DAYS} days`, () => {
    expect(NEWS_MAX_PUBLISHED_AGE_DAYS).toBe(3);
  });

  it('fresh labels pass: today, yesterday, "3 hours ago", "2 days ago", 3-day boundary', () => {
    expect(isStalePublishedLabel('today', NOW)).toBe(false);
    expect(isStalePublishedLabel('yesterday', NOW)).toBe(false);
    expect(isStalePublishedLabel('3 hours ago', NOW)).toBe(false);
    expect(isStalePublishedLabel('2 days ago', NOW)).toBe(false);
    // exactly 3 days old = AT the window boundary, not past it
    const threeDays = new Date(NOW.getTime() - 3 * DAY_MS);
    expect(isStalePublishedLabel(threeDays.toISOString().slice(0, 10), NOW)).toBe(false);
  });

  it('stale labels drop: "4 days ago", "3 weeks ago", the ticket\'s "Oct 28, 2021", bare years', () => {
    expect(isStalePublishedLabel('4 days ago', NOW)).toBe(true);
    expect(isStalePublishedLabel('3 weeks ago', NOW)).toBe(true);
    expect(isStalePublishedLabel('Oct 28, 2021', NOW)).toBe(true);
    expect(isStalePublishedLabel('2021-10-28', NOW)).toBe(true);
    expect(isStalePublishedLabel('2021', NOW)).toBe(true);
  });

  it('unparseable labels NEVER gate (they display verbatim instead)', () => {
    expect(isStalePublishedLabel('', NOW)).toBe(false);
    expect(isStalePublishedLabel('10/28', NOW)).toBe(false);
    expect(isStalePublishedLabel('sometime last year', NOW)).toBe(false);
  });
});

describe('filterBriefingQuality published gate (ticket 94b93132)', () => {
  const base = { headline: 'Fresh story', summary: 's', category: 'us', chatPrompt: 'q?' };

  it('drops an item whose published label parses to a stale date', () => {
    const got = filterBriefingQuality(
      [
        { ...base, published: 'Oct 28, 2021' },
        { ...base, headline: 'Other fresh story', published: '3 hours ago' },
      ],
      NOW
    );
    expect(got).toHaveLength(1);
    expect((got[0] as any).published).toBe('3 hours ago');
  });

  it('keeps items with NO published field — old cached briefings self-heal, not self-erase', () => {
    const got = filterBriefingQuality([base], NOW);
    expect(got).toHaveLength(1);
  });

  it('keeps items with useless labels (they normalize to "" downstream)', () => {
    const got = filterBriefingQuality([{ ...base, published: 'unknown' }], NOW);
    expect(got).toHaveLength(1);
  });
});

describe('fetchNewsHeadlines carries published labels and gates stale ones (ticket 94b93132)', () => {
  it('end-to-end: SERP date labels reach the formatter prompt; stale items are dropped; labels ride onto the output', async () => {
    const serpPayload = JSON.stringify({
      news: [
        { title: 'Fed signals rate cut', link: 'https://apnews.com/fed', date: '3 hours ago', description: 'The Federal Reserve signaled a rate cut.' },
        { title: 'Old wastewater advisory story', link: 'https://www.timescolonist.com/old', date: 'Oct 28, 2021', description: 'Heavy rains caused contamination in runoff.' },
      ],
      organic: [],
    });
    mockedSearch.mockResolvedValue(serpPayload);
    mockedUtilityChat.mockResolvedValue(JSON.stringify([
      { headline: 'Fed signals rate cut', summary: 'Rate cut signaled.', category: 'us', chatPrompt: 'What did the Fed signal?', published: '3 hours ago' },
      { headline: 'Old wastewater advisory story', summary: 'Runoff contamination.', category: 'local', chatPrompt: 'Tell me about the advisory?', published: 'Oct 28, 2021' },
      { headline: 'Undated fresh story', summary: 'No date shown by the source.', category: 'interest', chatPrompt: 'What happened?', published: 'unknown' },
      { headline: 'Legacy shape story', summary: 'Formatter omitted the field entirely.', category: 'interest', chatPrompt: 'What else?' },
    ]));

    const got = await fetchNewsHeadlines('Victoria, BC', 'environment', '', []);

    // The ticket's stale story never reaches any consumer
    const headlines = got.map((h: any) => h.headline);
    expect(headlines).not.toContain('Old wastewater advisory story');
    // Fresh + undated items survive
    expect(headlines).toContain('Fed signals rate cut');
    expect(headlines).toContain('Undated fresh story');
    expect(headlines).toContain('Legacy shape story');
    // The label rides through: verbatim for real labels, "" for useless/missing
    const fed = got.find((h: any) => h.headline === 'Fed signals rate cut') as any;
    expect(fed.published).toBe('3 hours ago');
    const undated = got.find((h: any) => h.headline === 'Undated fresh story') as any;
    expect(undated.published).toBe('');
    const legacy = got.find((h: any) => h.headline === 'Legacy shape story') as any;
    expect(legacy.published).toBe('');

    // The formatter prompt now asks for published labels AND the SERP labels are present
    const prompt = mockedUtilityChat.mock.calls[0]?.[0]?.[1]?.content as string;
    expect(prompt).toContain('published');
    expect(prompt).toContain('3 hours ago');
    expect(prompt).toContain('Oct 28, 2021');
  });
});

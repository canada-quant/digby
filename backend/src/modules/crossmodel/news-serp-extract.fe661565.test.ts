/**
 * News SERP organic extraction + the fetch-breaker auto-ticket — ticket
 * fe661565 (owner-filed 2026-09-11: "news stories are not being loaded …
 * broken with all our recent changes").
 *
 * The incident: every headline fetch returned the escape-hatch "[]" for
 * HOURS while BrightData SERP fetches were healthy (128–206k chars). The
 * brd_json payload leads with ~2-5k chars of chrome ({"general","input",
 * "navigation":[…]} plus embedded base64 images) and the 5000-char per-block
 * cap severed the payload BEFORE the organic results — the formatter model
 * saw metadata chrome and correctly judged "no usable stories". utilityChat
 * counted "[]" as success, so the utility-LLM outage alarm stayed silent and
 * NO ticket was filed: the owner found the outage, the machine never did.
 *
 * The fix: (1) extractSerpOrganicForPrompt pulls organic/news results out of
 * the brd_json chrome BEFORE the cap, so the formatter sees real stories;
 * (2) the fetch circuit breaker now files ONE deduped mishap ticket when it
 * opens (it IS the user-visible outage), with the failing pipeline stage
 * threaded through.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(), setEx: jest.fn(), del: jest.fn() },
}));
jest.mock('../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: jest.fn(async () => ''),
  utilityLLM: jest.fn(),
  isUtilityLLMAvailable: jest.fn(() => true),
  // 2026-10-26 self-host gate: default CONFIGURED.
  utilityChainUnconfigured: jest.fn(async () => false),
  // 1105650b: consumed by the fetch-breaker auto-ticket at trip time.
  utilityLLMHealthSnapshot: jest.fn(() => ({
    summary: 'dual-provider failure streak 0; DeepSeek leg active; DashScope leg active',
    detail: { dualFailureStreak: 0, deepseekBillingLatched: false, overrideLatched: false, deepseekKeyPresent: true, dashscopeKeyPresent: true, lastDeepseekError: '', lastDashscopeError: '' },
  })),
}));
jest.mock('./mcp-search', () => ({
  __esModule: true,
  searchWithBrightData: jest.fn(async () => ''),
}));

const mockFileFeedbackTicket: jest.Mock = jest.fn(async () => ({ deduped: false, ticket: { id: 'auto-ticket-1' } }));
jest.mock('./feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: (...a: any[]) => mockFileFeedbackTicket(...a),
}));

import {
  extractSerpOrganicForPrompt,
  recordFetchFailure,
  isNewsFetchCircuitOpen,
  __resetNewsFetchBreakerForTests,
} from './news.service';

/** A brd_json payload shaped like the real ones: chrome first, organic last. */
const brdJson = (organic: any[], news: any[] = [], chromePadChars = 0): string => {
  const body = {
    general: { search_engine: 'google', query: 'top US news', results_cnt: 5730000, country: 'Nicaragua' },
    input: { original_url: 'https://www.google.com/search?q=top+US+news&brd_json=1' },
    navigation: [
      { title: 'AI Mode', href: 'https://www.google.com/search?sca_esv=' + 'a'.repeat(700) },
      { title: 'News', href: 'https://www.google.com/search?sca_esv=' + 'b'.repeat(700) },
      { title: 'Videos', href: 'https://www.google.com/search?sca_esv=' + 'c'.repeat(700) },
    ],
    people_also_ask: chromePadChars ? [{ question: 'p'.repeat(chromePadChars) }] : [],
    news,
    organic,
  };
  return `[Web Search Results]\nQuery: top US news headlines today\n\n${JSON.stringify(body)}`;
};

const STORY = (n: number) => ({
  title: `Senate passes infrastructure bill part ${n}`,
  link: `https://www.reuters.com/world/us/story-${n}`,
  description: `The Senate approved the package late Thursday, sending it to the House for consideration (story ${n}).`,
  date: '2 hours ago',
  // The real payload embeds base64 media blobs inside result items — the
  // extraction must never feed them to the model.
  image: `data:image/jpeg;base64,${'/9j/4AAQSkZJRg'.repeat(200)}`,
});

beforeEach(() => {
  jest.clearAllMocks();
  __resetNewsFetchBreakerForTests();
  jest.restoreAllMocks();
});

describe('extractSerpOrganicForPrompt (fe661565)', () => {
  it('THE INCIDENT REPLAY: chrome padding pushes organic past the 5000-char cap — old capping saw NO stories, extraction sees them all', () => {
    const items = Array.from({ length: 5 }, (_, i) => STORY(i + 1));
    const raw = brdJson(items, [], 6000); // >5000 chars of chrome before organic
    // Old behavior: cap the raw payload — pure chrome, zero story titles.
    const oldBlock = raw.substring(0, 5000);
    expect(oldBlock).not.toContain('Senate passes infrastructure bill');
    expect(raw.indexOf('Senate passes infrastructure bill')).toBeGreaterThan(5000);
    // New behavior: the organic results reach the model.
    const extracted = extractSerpOrganicForPrompt(raw);
    for (let i = 1; i <= 5; i++) expect(extracted).toContain(`infrastructure bill part ${i}`);
    expect(extracted).toContain('reuters.com');
    expect(extracted).toContain('2 hours ago');
    expect(extracted).toContain('The Senate approved the package late Thursday');
    // …and the chrome/base64 does NOT.
    expect(extracted).not.toContain('navigation');
    expect(extracted).not.toContain('base64');
    expect(extracted).not.toContain('people_also_ask');
  });

  it('renders compact lines: "- title (domain) — date" + indented snippet', () => {
    const extracted = extractSerpOrganicForPrompt(brdJson([STORY(1)]));
    expect(extracted).toContain('- Senate passes infrastructure bill part 1 (reuters.com) — 2 hours ago');
    expect(extracted).toContain('\n  The Senate approved the package late Thursday');
  });

  it('includes the news array alongside organic results', () => {
    const news = [{ title: 'Markets rally on jobs report', link: 'https://apnews.com/markets', description: 'Stocks rose.', date: '1 hour ago' }];
    const extracted = extractSerpOrganicForPrompt(brdJson([STORY(1)], news));
    expect(extracted).toContain('Markets rally on jobs report (apnews.com) — 1 hour ago');
    expect(extracted).toContain('infrastructure bill part 1');
  });

  it('caps volume: at most 8 news + 12 organic items, and the whole render at 4500 chars', () => {
    const news = Array.from({ length: 20 }, (_, i) => ({ title: `News item ${i + 1}`, link: 'https://x.com/a', description: 'd' }));
    const organic = Array.from({ length: 30 }, (_, i) => STORY(i + 1));
    const extracted = extractSerpOrganicForPrompt(brdJson(organic, news));
    expect(extracted).toContain('News item 8');
    expect(extracted).not.toContain('News item 9');
    expect(extracted).toContain('infrastructure bill part 12');
    expect(extracted).not.toContain('infrastructure bill part 13');
    expect(extracted.length).toBeLessThanOrEqual(4500);
  });

  it('passes non-JSON text through unchanged (markdown SERP shapes)', () => {
    const markdown = '[Web Search Results]\n1. A headline\n2. Another headline';
    expect(extractSerpOrganicForPrompt(markdown)).toBe(markdown);
  });

  it('passes brd_json with NO organic/news results through unchanged (never invents)', () => {
    const raw = brdJson([], []);
    expect(extractSerpOrganicForPrompt(raw)).toBe(raw);
  });

  it('passes truncated/garbled JSON through unchanged (status quo ante, never worse)', () => {
    const garbled = '{"general":{"x":1},"organic":[{"title":"cut off mid-';
    expect(extractSerpOrganicForPrompt(garbled)).toBe(garbled);
  });
});

describe('fetch circuit breaker auto-ticket (fe661565 — the outage that paged no one)', () => {
  const flush = () => new Promise((r) => setImmediate(r));

  it('the breaker opening files ONE deduped mishap ticket carrying the failing stage', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    recordFetchFailure('search_empty: all SERP calls returned empty'); now += 30_000;
    recordFetchFailure('search_empty: all SERP calls returned empty'); now += 31_000;
    recordFetchFailure('extract_failed: no JSON array extractable from formatter output'); now += 30_000;
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled(); // 3 < threshold 4
    recordFetchFailure('extract_failed: no JSON array extractable from formatter output');
    expect(isNewsFetchCircuitOpen()).toBe(true);
    await flush();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const opts = mockFileFeedbackTicket.mock.calls[0][0];
    expect(opts.title).toContain('News pipeline outage auto-detected');
    expect(opts.type).toBe('mishap');
    expect(opts.description).toContain('extract_failed'); // the failing stage, threaded
    expect(opts.description).toContain('circuit breaker just OPENED');
    // A further failure while the breaker is open does NOT re-file.
    now += 10_000;
    recordFetchFailure('llm_empty: formatter returned empty content');
    await flush();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
  });

  it('a fast burst (<60s span) trips NO ticket — sustained failures only', async () => {
    let now = 5_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    for (let i = 0; i < 6; i++) { recordFetchFailure('llm_empty: formatter returned empty content'); now += 5_000; }
    await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(isNewsFetchCircuitOpen()).toBe(false);
  });
});

/**
 * News fetch-breaker RESET observability — ticket ebc81863 (2026-11-01,
 * enhancement, filed by the log-signal lane that paid the diagnostic cost).
 *
 * THE INCIDENT REPLAY (a diagnostic, not a defect): the 2026-11-01 12:13-12:22Z
 * news burst carried 14 whole-fetch failures (past FETCH_CB_THRESHOLD=4) across
 * ~9 min (past FETCH_CB_MIN_SPAN_MS=60s), yet the log store held NO
 * 'fetch circuit breaker OPEN' row in that window at all. Reading that store,
 * two very different truths were indistinguishable:
 *
 *   (a) the trip predicate genuinely never saw 4 failures inside one 60s span
 *       (the burst's successes kept restarting it) — a DEGRADED-BUT-ALIVE
 *       pipeline, or
 *   (b) the breaker is healthy and something silently reset it.
 *
 * The cause is correct behaviour with no fingerprint: recordFetchSuccess()
 * zeroed _fetchFailStreak / _fetchFailStreakStartedAt / _fetchCBOpenUntil /
 * _fetchCBOpenRung and logged NOTHING, while its mirror (isFetchCircuitOpen's
 * natural-expiry close) DOES log 'fetch circuit breaker CLOSED'. Only the OPEN
 * path files a ticket, so the degraded class pages no one and writes nothing.
 *
 * The fix (this file pins it): when — and only when — a NON-ZERO streak is
 * being discarded, recordFetchSuccess emits ONE logHandled line naming the
 * discarded streak + span, plus ONE loop_metrics row
 * (NEWS_FETCH_BREAKER_RESET) so the probe `loop_metric_count` can read the
 * class with no log access. A zero-streak success stays SILENT (a reset event
 * is evidence; a per-fetch counter would be noise).
 *
 * NO behaviour change is pinned here too: the trip predicate, the cooldown
 * ladder reset and the one-deduped-ticket OPEN path all behave exactly as
 * before (their own suites — news-fetch-breaker.1105650b.test.ts and
 * news-serp-extract.fe661565.test.ts — are untouched and still pass).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => 'OK'),
    setEx: jest.fn(),
    del: jest.fn(),
  },
}));
jest.mock('../../utils/utility-llm', () => ({
  __esModule: true,
  // A HEALTHY formatter: the success path's own puzzle piece.
  utilityChat: jest.fn(async () => '[]'),
  utilityLLM: jest.fn(),
  isUtilityLLMAvailable: jest.fn(() => true),
  utilityChainUnconfigured: jest.fn(async () => false),
  utilityLLMHealthSnapshot: jest.fn(() => ({
    summary: 'dual-provider failure streak 0; DeepSeek leg active; DashScope leg active',
    detail: { dualFailureStreak: 0, deepseekBillingLatched: false, overrideLatched: false, deepseekKeyPresent: true, dashscopeKeyPresent: true, lastDeepseekError: '', lastDashscopeError: '' },
  })),
}));
jest.mock('./mcp-search', () => ({
  __esModule: true,
  searchWithBrightData: jest.fn(async () => '[Web Search Results]\nQuery: top US news\n\n1. Fed signals rate cut… 2. Wildfire evacuations…'),
}));

const mockFileFeedbackTicket: jest.Mock = jest.fn(async () => ({ deduped: false, ticket: { id: 'auto-ticket-1' } }));
jest.mock('./feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: (...a: any[]) => mockFileFeedbackTicket(...a),
}));

// Observe the metric WITHOUT pulling the real writer's env-validating chain in.
jest.mock('./platform/loop-metrics.service', () => {
  const { LOOP_METRIC_KINDS } = jest.requireActual('./platform/loop-metric-kinds');
  return { __esModule: true, recordLoopMetric: jest.fn(), LOOP_METRIC_KINDS };
});

import logger from '../../utils/logger';
import { utilityChat } from '../../utils/utility-llm';
import { recordLoopMetric, LOOP_METRIC_KINDS } from './platform/loop-metrics.service';
import {
  fetchNewsHeadlines,
  recordFetchFailure,
  isNewsFetchCircuitOpen,
  __resetNewsFetchBreakerForTests,
} from './news.service';

const mockedLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock; log: jest.Mock };
const mockedUtilityChat = utilityChat as jest.Mock;
const mockedMetric = recordLoopMetric as jest.Mock;

const RESET_FRAGMENT = 'fetch breaker streak reset by a healthy fetch';

const infoCallsWith = (fragment: string): unknown[][] =>
  mockedLogger.info.mock.calls.filter((c: unknown[]) => String(c[0]).includes(fragment));
const warnCallsWith = (fragment: string): unknown[][] =>
  mockedLogger.warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes(fragment));
const metricRows = (): any[] =>
  mockedMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m && m.kind === LOOP_METRIC_KINDS.NEWS_FETCH_BREAKER_RESET);

/**
 * A briefing the healthy path accepts (>= MIN_HEALTHY_HEADLINES usable items).
 * Same fixture shape as news-fetch-breaker.1105650b.test.ts: one DISTINCT topic
 * word per headline keeps the near-duplicate gate (token-Jaccard >= 0.7) from
 * collapsing the set to a single survivor.
 */
const HEALTHY_TOPICS = [
  'election', 'wildfire', 'spacex', 'senate', 'hurricane', 'inflation', 'playoff', 'verdict',
  'protest', 'eclipse', 'merger', 'vaccine', 'cyberattack', 'olympics', 'embargo',
];
const healthyBriefing = (): string => JSON.stringify(
  HEALTHY_TOPICS.map((topic, i) => ({
    headline: `Real news story about ${topic}`,
    summary: `Story ${i} — a concrete event with specifics.`,
    category: 'us',
    chatPrompt: `What happened in story ${i}?`,
  })),
);

/** Drive the breaker to a full open from a fresh state (streak 4 spanning 91s). */
const tripFromFresh = (clock: { t: number }) => {
  const reason = 'llm_empty: formatter returned empty content';
  recordFetchFailure(reason); clock.t += 30_000;
  recordFetchFailure(reason); clock.t += 31_000;
  recordFetchFailure(reason); clock.t += 30_000;
  recordFetchFailure(reason);
};

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  __resetNewsFetchBreakerForTests();
  jest.restoreAllMocks();
});

describe('ebc81863 — the breaker streak reset is now OBSERVABLE', () => {
  it('THE DIAGNOSTIC REPLAY: a burst of failures below the trip threshold, then a healthy fetch, leaves ONE reset row (not silence)', async () => {
    let t = 2_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => t);

    // The 2026-11-01 shape: failures accumulated but never 4-inside-60s, so the
    // breaker never opened — and before this fix the reset left NO trace, which
    // is why "never tripped" and "was silently reset" read identically.
    recordFetchFailure('search_empty: all SERP calls returned empty'); t += 45_000;
    recordFetchFailure('llm_empty: formatter returned empty content'); t += 45_000;
    expect(isNewsFetchCircuitOpen()).toBe(false);
    expect(warnCallsWith('fetch circuit breaker OPEN')).toHaveLength(0);

    // …then a healthy fetch lands and discards the streak.
    mockedUtilityChat.mockResolvedValueOnce(healthyBriefing());
    const healthy = await fetchNewsHeadlines('', '', '', []);
    expect(healthy.length).toBeGreaterThanOrEqual(5); // the success path really ran

    // OBSERVABLE: exactly one reset line, naming the discarded streak + span.
    const resets = infoCallsWith(RESET_FRAGMENT);
    expect(resets).toHaveLength(1);
    expect(resets[0][0]).toContain('was 2 failures over 90s');
    expect(resets[0][1]).toMatchObject({ source: 'news', logClass: 'handled' });
    // …and it is NOT a warn row (the a800a12d lesson: designed outcomes must
    // never reach the warn+ transport the hourly sweep fingers as a fault).
    expect(warnCallsWith(RESET_FRAGMENT)).toHaveLength(0);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled(); // no trip → no outage ticket

    // MEASURABLE with no log access: one loop_metrics row carrying streak + span.
    const rows = metricRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: LOOP_METRIC_KINDS.NEWS_FETCH_BREAKER_RESET,
      value: 2,
      unit: 'failures',
      meta: { streak: 2, spanMs: 90_000, source: 'news' },
    });
  });

  it('a healthy pipeline stays SILENT — streak 0 writes neither the line nor the row', async () => {
    let t = 3_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => t);

    mockedUtilityChat.mockResolvedValueOnce(healthyBriefing());
    const healthy = await fetchNewsHeadlines('', '', '', []);
    expect(healthy.length).toBeGreaterThanOrEqual(5);

    // No streak to discard ⇒ nothing to report. A per-fetch counter here would
    // be pure noise (the sched runs this 4x/day per user).
    expect(infoCallsWith(RESET_FRAGMENT)).toHaveLength(0);
    expect(metricRows()).toHaveLength(0);
  });

  it('a post-CLOSED probe success adds NO second line — the natural-expiry CLOSED log already zeroed the streak', async () => {
    let t = 4_000_000;
    const clock = { get t() { return t; }, set t(v) { t = v; } };
    jest.spyOn(Date, 'now').mockImplementation(() => t);

    tripFromFresh(clock);                       // streak 4 / 91s ≥ 60s → breaker OPEN (rung 1)
    expect(isNewsFetchCircuitOpen()).toBe(true);
    await flush();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1); // the outage alarm fired, untouched

    // Cooldown expires, the probe fetch runs and SUCCEEDS. isFetchCircuitOpen()
    // closes naturally: it zeroes the streak AND logs CLOSED — so there is no
    // silently-discarded streak left for recordFetchSuccess to report.
    t += 3 * 60 * 1000;
    expect(isNewsFetchCircuitOpen()).toBe(false);
    expect(infoCallsWith('fetch circuit breaker CLOSED')).toHaveLength(1);
    mockedUtilityChat.mockResolvedValueOnce(healthyBriefing());
    const healthy = await fetchNewsHeadlines('', '', '', []);
    expect(healthy.length).toBeGreaterThanOrEqual(5);

    // Exactly ONE recovery fingerprint for this recovery — never two.
    expect(infoCallsWith(RESET_FRAGMENT)).toHaveLength(0);
    expect(metricRows()).toHaveLength(0);

    // BEHAVIOUR UNCHANGED: the ladder really did reset — the next outage opens
    // at rung 1 (3 min), not the escalated 10.
    tripFromFresh(clock);
    expect(isNewsFetchCircuitOpen()).toBe(true);
    t += 3 * 60 * 1000 - 1;
    expect(isNewsFetchCircuitOpen()).toBe(true);
    t += 1;
    expect(isNewsFetchCircuitOpen()).toBe(false);
  });

  it('telemetry can never break a fetch: a throwing metric writer still lets the fetch succeed', async () => {
    let t = 5_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => t);
    recordFetchFailure('llm_empty: formatter returned empty content');
    mockedMetric.mockImplementationOnce(() => { throw new Error('metrics down'); });

    mockedUtilityChat.mockResolvedValueOnce(healthyBriefing());
    const healthy = await fetchNewsHeadlines('', '', '', []);
    expect(healthy.length).toBeGreaterThanOrEqual(5);
    // The reset line still landed (it is emitted independently of the writer).
    expect(infoCallsWith(RESET_FRAGMENT)).toHaveLength(1);
  });
});
/**
 * Replay pin — log-signal family lane a800a12d (2026-11-01), lead ticket
 * 0de27d1b. FOUR of the five members share ONE root cause, verified per member
 * against LIVE app_error_logs rows rather than the ticket text: a DESIGNED
 * news-formatter-ladder outcome was emitted at untagged `warn`, so the hourly
 * log-signal sweep read every designed recovery as an internal fault and
 * re-filed it every ISO week, forever. This is the same taxonomy family lane
 * cf7baffd closed (utils/log-level.ts — `logHandled` for an expected outcome
 * (info, never persisted by the warn+ transport), `logExternal` for a degraded
 * dependency (warn + logClass:'external'), `logger.error` for a genuine fault)
 * and the same predicate log-signal-sweep.service.ts isNonFaultLogRow honours.
 *
 *   0de27d1b — `news.service: prefetch returned only <n> own headlines for
 *              userId=<uuid> (served outage fallback) — retrying once after 3s`.
 *              44 rows / 4 boot episodes at filing. The designed SINGLE retry
 *              announcing itself (one row per user per fetch window). DESIGNED.
 *   d1be4f9e — `news.service: first 4 JSON extraction strategies failed —
 *              trying LLM reformat`. 41 rows / 3 hours. The designed reformat
 *              leg announcing itself BEFORE it runs; live 17 of 18 events
 *              recovered on that same leg (only 1 escalated to the total
 *              extraction failure below). DESIGNED.
 *   b4bfd09a — `news.service: could not extract JSON array from content (all 5
 *              strategies failed) — trying fallback cache`. 36 rows. A DEGRADED
 *              DEPENDENCY (the utility formatter returned no extractable array),
 *              not an internal fault -> logExternal, which keeps the warn row
 *              VISIBLE while tagging it non-fault.
 *   359c3a35 — the same line, gated wording (`4 strategies failed + LLM reformat
 *              gated`). 28 rows. Same emit site, same disposition — the gated
 *              wording is the reformat leg's own designed disable, NOT a second
 *              failure. One site, two wordings, two fingerprints.
 *
 * THE DURABILITY RULE (why silencing these is safe, and the ONLY thing that
 * justifies it): the ladder was never the outage alarm. A sustained outage
 * still escalates through the fetch circuit breaker — `failToFallback` ->
 * `recordFetchFailure` -> breaker OPEN -> ONE deduped mishap ticket
 * (fe661565 / 1105650b, `News pipeline outage auto-detected…`). This pin
 * asserts that escalation is still wired, so a future pass cannot "clean up"
 * the ladder by also dropping the real alarm.
 *
 * THIS PIN asserts, per member: (a) the emit site carries the correct taxonomy
 * call with the message text UNCHANGED (greps, the sweep's acceptance
 * messagePattern, and the 4888d891 provenance pin all match on that wording),
 * (b) the class stays MEASURABLE on a news_formatter_ladder loop_metrics row
 * (the acceptance-metric probe loop_metric_count reads it) instead of in
 * app_error_logs, and (c) the sweep actually treats the resulting row as
 * non-fault — while an UNTAGGED row still reaches it.
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
  // `log` is required by utils/log-level's logExternal (object form).
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
// The ladder's metric is the observability that REPLACES the warn row — mock
// the writer so the assertion can see it, but keep the REAL kind registry
// (news.service dereferences LOOP_METRIC_KINDS at every ladder event).
jest.mock('./platform/loop-metrics.service', () => {
  const { LOOP_METRIC_KINDS } = jest.requireActual('./platform/loop-metric-kinds');
  return { __esModule: true, recordLoopMetric: jest.fn(), LOOP_METRIC_KINDS };
});

import fs from 'fs';
import path from 'path';
import redisClient from '../../config/redis';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import { utilityChat } from '../../utils/utility-llm';
import { searchWithBrightData } from './mcp-search';
import { recordLoopMetric, LOOP_METRIC_KINDS } from './platform/loop-metrics.service';
import { isNonFaultLogRow } from './fleet/log-signal-sweep.service';
import {
  prefetchNewsForUser,
  MIN_HEALTHY_HEADLINES,
  __resetNewsFetchBreakerForTests,
  __resetNewsReformatGateForTests,
} from './news.service';

const mockedUtilityChat = utilityChat as jest.Mock;
const mockedSearch = searchWithBrightData as jest.Mock;
const mockedLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock; log: jest.Mock };
const mockedMetric = recordLoopMetric as jest.Mock;
const mockedRedis = redisClient as unknown as {
  get: jest.Mock; set: jest.Mock; setEx: jest.Mock; del: jest.Mock; ttl: jest.Mock; multi: jest.Mock;
};
const mockedPrisma = prisma as unknown as {
  userMemory: { findUnique: jest.Mock };
  crossModelChat: { findMany: jest.Mock };
};

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');

// Each fixture headline carries ONE distinct topic word beyond a shared prefix,
// so the near-duplicate gate (token-Jaccard >= 0.7) keeps every item.
const TOPIC_WORDS = [
  'election', 'wildfire', 'spacex', 'senate', 'hurricane', 'inflation', 'playoff', 'verdict',
  'protest', 'eclipse', 'merger', 'vaccine', 'cyberattack', 'olympics', 'embargo', 'landslide',
  'blackout', 'strike', 'tsunami', 'recall', 'drought', 'summit', 'ceasefire', 'bankruptcy', 'launch',
];
const mkItems = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    headline: `Story about ${TOPIC_WORDS[i % TOPIC_WORDS.length]} ${i}`,
    summary: `Story about ${TOPIC_WORDS[i % TOPIC_WORDS.length]} ${i} — a concrete event with specifics.`,
    category: 'us',
    chatPrompt: `What happened with ${TOPIC_WORDS[i % TOPIC_WORDS.length]} ${i}?`,
  }));

/** Run prefetch under fake timers so the designed 3s retry costs no wall clock. */
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

/** Warn-level calls whose message carries the fragment (raw logger.warn). */
const warnCallsWith = (fragment: string): unknown[][] =>
  mockedLogger.warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes(fragment));
/** logger.log object-form calls (logExternal) whose message carries the fragment. */
const logCallsWith = (fragment: string): any[] =>
  mockedLogger.log.mock.calls.map((c: unknown[]) => c[0]).filter((o: any) => String(o?.message).includes(fragment));
/** info calls whose message carries the fragment (logHandled). */
const infoCallsWith = (fragment: string): unknown[][] =>
  mockedLogger.info.mock.calls.filter((c: unknown[]) => String(c[0]).includes(fragment));

const metricCallsFor = (phase: string): any[] =>
  mockedMetric.mock.calls.map((c: unknown[]) => c[0]).filter((m: any) => m?.meta?.phase === phase);

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

// ── 0de27d1b — the designed single prefetch retry is handled, not a fault ────
describe('0de27d1b — the prefetch retry announcement is logHandled, never an untagged warn', () => {
  it('BEHAVIOURAL REPLAY: a thin fetch emits the retry line at INFO and writes NO warn row', async () => {
    // The live shape at filing time: the formatter answers, but thin.
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(MIN_HEALTHY_HEADLINES - 1)));

    await runPrefetch('u-thin');

    const fragment = 'prefetch returned only';
    // The fingerprint would have been persisted by the warn+ transport — it
    // must no longer be a warn row at all.
    expect(warnCallsWith(fragment)).toHaveLength(0);
    // …yet the line still EXISTS (operators and greps keep their vocabulary),
    // carrying the taxonomy tag the sweep honours.
    const info = infoCallsWith(fragment);
    expect(info.length).toBeGreaterThan(0);
    expect(info[0][0]).toContain('own headlines for userId=u-thin');
    expect(info[0][1]).toMatchObject({ source: 'news', logClass: 'handled' });
  });

  it('the class stays MEASURABLE on the news_formatter_ladder metric', async () => {
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(MIN_HEALTHY_HEADLINES - 1)));

    await runPrefetch('u-thin');

    const rows = metricCallsFor('prefetch_retry');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      kind: LOOP_METRIC_KINDS.NEWS_FORMATTER_LADDER,
      value: 1,
      meta: { phase: 'prefetch_retry', outcome: 'thin', source: 'news' },
    });
  });

  it('a fallback-served prefetch is measured as its own outcome (the 0de27d1b wording)', async () => {
    // The incident's exact shape: our fetch failed and served the shared
    // outage fallback, so ownHeadlineCount is 0 by provenance (4888d891).
    mockedUtilityChat.mockResolvedValue('Sorry — I could not find any stories worth reporting right now.');

    await runPrefetch('u-fb');

    const rows = metricCallsFor('prefetch_retry').filter((m: any) => m.meta.outcome === 'fallback');
    expect(rows.length).toBeGreaterThan(0);
    // The '(served outage fallback)' qualifier is preserved verbatim in the
    // secondary line — the 4888d891 pin's provenance contract.
    const fbInfo = infoCallsWith('(served outage fallback)');
    expect(fbInfo.length).toBeGreaterThan(0);
  });

  it('the message text is UNCHANGED at the emit site (the sweep contract)', () => {
    const src = read('news.service.ts');
    expect(src).toContain(
      'logHandled(`news.service: prefetch returned only ${ownHeadlineCount} own headlines for userId=${userId}${fromFallback ? \' (served outage fallback)\' : \'\'} — retrying once after 3s`'
    );
    // …and the old untagged warn at that site is gone.
    expect(src).not.toContain(
      'logger.warn(`news.service: prefetch returned only ${ownHeadlineCount} own headlines'
    );
  });
});

// ── d1be4f9e — the designed reformat leg announcing itself is ladder progress ─
describe('d1be4f9e — the LLM-reformat leg announcement is logHandled, never an untagged warn', () => {
  it('BEHAVIOURAL REPLAY: a recovered reformat emits the line at INFO and writes NO warn row', async () => {
    // The dominant live shape: the strict parses fail, the designed reformat
    // leg RECOVERS the briefing (17 of 18 live events recovered this way).
    mockedUtilityChat
      .mockResolvedValueOnce('Here are the headlines I found, in no particular format.')
      .mockResolvedValue(JSON.stringify(mkItems(15)));

    const result = await runPrefetch('u-reformat');

    expect(result.length).toBeGreaterThanOrEqual(MIN_HEALTHY_HEADLINES);
    const fragment = 'first 4 JSON extraction strategies failed';
    expect(warnCallsWith(fragment)).toHaveLength(0);
    const info = infoCallsWith(fragment);
    expect(info.length).toBeGreaterThan(0);
    expect(info[0][1]).toMatchObject({ source: 'news', logClass: 'handled' });
  });

  it('the recovery is measured as ladder progress', async () => {
    mockedUtilityChat
      .mockResolvedValueOnce('Here are the headlines I found, in no particular format.')
      .mockResolvedValue(JSON.stringify(mkItems(15)));

    await runPrefetch('u-reformat');

    const rows = metricCallsFor('llm_reformat');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      kind: LOOP_METRIC_KINDS.NEWS_FORMATTER_LADDER,
      meta: { outcome: 'attempted', source: 'news' },
    });
  });

  it('the message text is UNCHANGED at the emit site (the sweep + audit-pin contract)', () => {
    const src = read('news.service.ts');
    expect(src).toContain("logHandled('news.service: first 4 JSON extraction strategies failed — trying LLM reformat'");
    expect(src).not.toContain("logger.warn('news.service: first 4 JSON extraction strategies failed — trying LLM reformat'");
  });

  it('the reformat GATE is untouched — a gated leg stops attempting the reformat at all', async () => {
    // The gate (recordReformatOutcome) is the real containment, not the log
    // line — and this asserts its BEHAVIOUR, not a source string: drive the
    // gate open, then prove the reformat leg is SKIPPED (the gated wording
    // appears instead of an attempt). Under a change that broke the gate, the
    // ungated attempt wording would reappear here.
    jest.useFakeTimers();
    try {
      for (let i = 0; i < 9; i++) {
        mockedUtilityChat.mockResolvedValue('I cannot produce that output right now.');
        const pending = prefetchNewsForUser(`u-gate-${i}`);
        await jest.advanceTimersByTimeAsync(4000);
        await pending;
        __resetNewsFetchBreakerForTests(); // keep the breaker out of the gate math
      }
    } finally {
      jest.useRealTimers();
    }

    // Once gated, the leg must ANNOUNCE the gate rather than attempt a reformat.
    const gatedRows = logCallsWith('LLM reformat gated');
    expect(gatedRows.length).toBeGreaterThan(0);
    // …and it must be the GATED branch, never an ungated attempt at that point.
    const lastAttempt = infoCallsWith('first 4 JSON extraction strategies failed').length;
    expect(lastAttempt).toBeGreaterThan(0); // the attempts happened BEFORE the gate closed
  });
});

// ── b4bfd09a + 359c3a35 — a degraded formatter dependency stays VISIBLE, but
//    is tagged non-fault so it stops being re-filed as an internal fault ──────
describe('b4bfd09a + 359c3a35 — total extraction failure is logExternal (visible, non-fault)', () => {
  const ALL_FAILED = 'news.service: could not extract JSON array from content (all 5 strategies failed)';

  it('BEHAVIOURAL REPLAY: a total extraction failure keeps the warn ROW but tags it external', async () => {
    // Both the main call AND the designed reformat leg fail → the real
    // degraded-dependency event the fingerprint names.
    mockedUtilityChat.mockResolvedValue('I cannot produce that output right now.');

    await runPrefetch('u-extract');

    // It must NOT be dropped (this is a genuinely degraded state an operator
    // may want to see) — it rides logExternal, i.e. logger.log at warn level.
    expect(warnCallsWith('could not extract JSON array')).toHaveLength(0);
    const rows = logCallsWith('could not extract JSON array');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ level: 'warn', logClass: 'external', source: 'news' });
    // Wording preserved verbatim — the ticket's own acceptance messagePattern
    // ('news.service: could not extract json array from content (all') matches.
    expect(String(rows[0].message)).toContain(ALL_FAILED);
  });

  it('the failure is measured, not merely silenced', async () => {
    mockedUtilityChat.mockResolvedValue('I cannot produce that output right now.');

    await runPrefetch('u-extract');

    const rows = metricCallsFor('extract_failed');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      kind: LOOP_METRIC_KINDS.NEWS_FORMATTER_LADDER,
      meta: { source: 'news' },
    });
  });

  it('359c3a35 — the GATED wording rides the SAME site (one site, two fingerprints)', async () => {
    // Drive the reformat gate open (8 consecutive failures) so the gated
    // branch emits '4 strategies failed + LLM reformat gated'.
    jest.useFakeTimers();
    try {
      for (let i = 0; i < 9; i++) {
        mockedUtilityChat.mockResolvedValue('I cannot produce that output right now.');
        const pending = prefetchNewsForUser(`u-gated-${i}`);
        await jest.advanceTimersByTimeAsync(4000);
        await pending;
        __resetNewsFetchBreakerForTests(); // keep the fetch breaker out of the gate math
      }
    } finally {
      jest.useRealTimers();
    }

    const gated = logCallsWith('LLM reformat gated');
    expect(gated.length).toBeGreaterThan(0);
    expect(gated[0]).toMatchObject({ logClass: 'external' });
  });

  it('the message text and the taxonomy call are unchanged/pinned at the emit site', () => {
    const src = read('news.service.ts');
    expect(src).toContain(
      "logExternal(`news.service: could not extract JSON array from content (${reformatGatedThisEvent ? '4 strategies failed + LLM reformat gated' : 'all 5 strategies failed'}) — trying fallback cache`"
    );
    expect(src).not.toContain(
      'logger.warn(`news.service: could not extract JSON array from content'
    );
  });
});

// ── the durability rule: the REAL outage alarm is still wired ────────────────
describe('the durable escalation is untouched — these warns were never the outage alarm', () => {
  const src = read('news.service.ts');

  it('a whole-fetch failure still trips the breaker and files ONE deduped ticket', () => {
    // failToFallback is the terminal step of the extract-failed branch…
    expect(src).toContain('const failToFallback = async (reason?: string): Promise<any[]> => {');
    expect(src).toContain('return recordFetchFailureAndFallback(reason);');
    // …which arms the breaker…
    expect(src).toContain('export function recordFetchFailure(reason?: string): void {');
    expect(src).toContain('_fetchFailStreak >= FETCH_CB_THRESHOLD');
    // …and files the standing outage ticket exactly as before (fe661565).
    expect(src).toContain('News pipeline outage auto-detected: fetch circuit breaker open');
    expect(src).toContain('m.fileFeedbackTicket({');
  });

  it('the extract-failed branch still ENDS in failToFallback (not a bare return)', () => {
    const branch = src.slice(src.indexOf("recordNewsLadderMetric('extract_failed'"));
    expect(branch.slice(0, 400)).toContain("return await failToFallback('extract_failed: no JSON array extractable from formatter output');");
  });

  it('a below-minimum prefetch still arms the per-user failure backoff', async () => {
    // The containment for the thin class — untouched by the taxonomy change.
    // Asserted BEHAVIOURALLY (the redis write), not by grepping the source: a
    // change that dropped the backoff arming would fail this even though the
    // string 'NEWS_BACKOFF_KEY(userId)' still appeared in the file.
    mockedUtilityChat.mockResolvedValue(JSON.stringify(mkItems(MIN_HEALTHY_HEADLINES - 1)));

    await runPrefetch('u-backoff');

    const backoffArming = mockedRedis.setEx.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('user:news:backoff:u-backoff')
    );
    expect(backoffArming.length).toBeGreaterThan(0);
  });
});

// ── the sweep actually honours the tags these sites now emit ─────────────────
describe('the log-signal sweep treats the demoted members as non-fault, and still sees faults', () => {
  it('logClass handled (0de27d1b, d1be4f9e) is non-fault', () => {
    expect(isNonFaultLogRow({ context: { logClass: 'handled' } })).toBe(true);
  });

  it('logClass external (b4bfd09a, 359c3a35) is non-fault', () => {
    expect(isNonFaultLogRow({ context: { logClass: 'external' } })).toBe(true);
  });

  it('an UNTAGGED row is still a fault — the sweep is not blanketed off', () => {
    expect(isNonFaultLogRow({ context: null })).toBe(false);
    expect(isNonFaultLogRow({ context: {} })).toBe(false);
    expect(isNonFaultLogRow({ context: { logClass: 'fault' } })).toBe(false);
    expect(isNonFaultLogRow({ context: { source: 'news' } })).toBe(false);
    expect(isNonFaultLogRow({})).toBe(false);
  });

  it('the other news warns were NOT swept up in the demotion (scope discipline)', () => {
    // The breaker-open and degenerate-fetch lines are DIFFERENT signals with
    // their own adjudications; this lane must not have touched them.
    expect(read('news.service.ts')).toContain('news.service: fetch circuit breaker OPEN');
    expect(read('news.service.ts')).toContain('degenerate fetch, returning thin result');
  });
});
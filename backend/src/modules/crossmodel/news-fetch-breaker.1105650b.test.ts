/**
 * News fetch-breaker sustained-outage behavior — ticket 1105650b (mishap,
 * auto-filed 2026-10-12 by the fetch circuit breaker, 36 occurrences).
 *
 * THE INCIDENT REPLAY: during the post-breach key-rotation window of
 * 2026-10-12 05:26–07:35Z, BOTH utility-LLM provider legs answered HTTP 401 on
 * dead keys (DeepSeek "Authentication Fails, Your api key: ****fb3e is invalid"
 * + "DashScope fallback also failed (HTTP 401)" — see the f9637864 owner-action
 * ticket). Every news fetch's formatter call returned '' → `llm_empty: formatter
 * returned empty content` → the fetch breaker opened TEN times in ~7h (sightings
 * 00:41Z→07:30Z, occurrences 36). Two defects surfaced:
 *
 *  1. WASTED WORK: the flat 3-min cooldown re-armed the FULL paid SERP +
 *     formatter pipeline every 3 minutes through a provably dead provider stack
 *     — the breaker "protected" nothing but its own cooldown window; every
 *     re-open re-paid ~5 BrightData SERP queries + 2 utility-LLM calls for a
 *     formatter that could not answer.
 *  2. UNATTRIBUTABLE TICKET: the auto-ticket's lastReason read only
 *     "llm_empty: formatter returned empty content" — the provider-leg state
 *     (dual 401s, billing latch hot) lived only in app_error_logs, so triage
 *     (and the dispatched ticket lane) had to dig the logs to find the cause.
 *
 * The fix (this file pins it):
 *  - FETCH_CB_COOLDOWN_STEPS_MS — the cooldown ESCALATES per consecutive open
 *    with no healthy fetch in between (3 → 10 → 30 min, capped), so a sustained
 *    outage stops re-paying the full pipeline every 3 minutes. The first open
 *    keeps the historical 3-min behavior (transient maintenance windows recover
 *    just as fast as before); a healthy fetch resets the ladder.
 *  - utilityLLMHealthSnapshot — the breaker trip now threads the utility-LLM
 *    provider-leg health (dual-failure streak, latch states, last per-leg
 *    errors) into the auto-ticket body and context, so the NEXT occurrence of
 *    this ticket self-identifies a provider outage without log access.
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
  // The incident's formatter: every leg dead (401s), so utilityChat returns ''.
  utilityChat: jest.fn(async () => ''),
  utilityLLM: jest.fn(),
  isUtilityLLMAvailable: jest.fn(() => true),
  // 2026-10-26 self-host gate: default CONFIGURED (this suite tests the
  // breaker path, i.e. a configured-but-failing pipeline).
  utilityChainUnconfigured: jest.fn(async () => false),
  // Snapshot overridden per-test (default: the healthy-pipeline shape).
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

import {
  recordFetchFailure,
  isNewsFetchCircuitOpen,
  __resetNewsFetchBreakerForTests,
} from './news.service';
import { utilityLLMHealthSnapshot } from '../../utils/utility-llm';

const mockedHealthSnapshot = utilityLLMHealthSnapshot as jest.Mock;

const flush = () => new Promise((r) => setImmediate(r));

/** Drive the breaker to a full open (4 failures spanning ≥60s) from a fresh state. */
const tripFromFresh = (now: { t: number }, reason = 'llm_empty: formatter returned empty content') => {
  recordFetchFailure(reason); now.t += 30_000;
  recordFetchFailure(reason); now.t += 31_000;
  recordFetchFailure(reason); now.t += 30_000;
  recordFetchFailure(reason); // streak 4, span 91s ≥ 60s → OPEN at rung 1 (3 min)
};

beforeEach(() => {
  jest.clearAllMocks();
  __resetNewsFetchBreakerForTests();
  jest.restoreAllMocks();
});

describe('fetch-breaker cooldown escalation (ticket 1105650b — the 2026-10-12 sustained outage)', () => {
  it('FIRST open stays 3 min — a transient window recovers exactly as fast as before the fix', () => {
    let t = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => t);
    tripFromFresh({ get t() { return t; }, set t(v) { t = v; } } as any);
    expect(isNewsFetchCircuitOpen()).toBe(true);
    // 1 ms before the 3-min cooldown expires: still open.
    t += 3 * 60 * 1000 - 1;
    expect(isNewsFetchCircuitOpen()).toBe(true);
    t += 1;
    expect(isNewsFetchCircuitOpen()).toBe(false);
  });

  it('THE INCIDENT REPLAY: sustained outage escalates 3 → 10 → 30 min instead of re-arming every 3 min', () => {
    // The 2026-10-12 shape: breaker opens, 3-min cooldown expires, the probe
    // fetch re-runs the full pipeline, fails again (provider still dead),
    // breaker re-opens — ten times over ~7h. With the ladder, the second open
    // holds for 10 min and the third for 30 (capped), so the doomed pipeline
    // runs 1/3rd then 1/10th as often.
    let t = 1_000_000;
    const now = { get t() { return t; }, set t(v) { t = v; } } as any;
    jest.spyOn(Date, 'now').mockImplementation(() => t);

    tripFromFresh(now);                    // open #1 — rung 1 → 3 min
    t += 3 * 60 * 1000;                    // cooldown expires
    expect(isNewsFetchCircuitOpen()).toBe(false);
    // The probe fetch runs the full pipeline again and fails again.
    recordFetchFailure('llm_empty: formatter returned empty content'); t += 31_000;
    recordFetchFailure('llm_empty: formatter returned empty content'); t += 30_000;
    recordFetchFailure('llm_empty: formatter returned empty content'); t += 30_000;
    recordFetchFailure('llm_empty: formatter returned empty content'); // open #2 — rung 2
    expect(isNewsFetchCircuitOpen()).toBe(true);
    t += 10 * 60 * 1000 - 1;               // 1 ms before the ESCALATED 10-min cooldown
    expect(isNewsFetchCircuitOpen()).toBe(true);
    t += 1;
    expect(isNewsFetchCircuitOpen()).toBe(false);

    // Third consecutive open — rung 3 (the 30-min cap).
    recordFetchFailure('llm_empty: formatter returned empty content'); t += 31_000;
    recordFetchFailure('llm_empty: formatter returned empty content'); t += 30_000;
    recordFetchFailure('llm_empty: formatter returned empty content'); t += 30_000;
    recordFetchFailure('llm_empty: formatter returned empty content'); // open #3 — rung 3
    t += 30 * 60 * 1000 - 1;
    expect(isNewsFetchCircuitOpen()).toBe(true);
    t += 1;
    expect(isNewsFetchCircuitOpen()).toBe(false);

    // Fourth consecutive open — stays CAPPED at 30 min (no unbounded growth).
    recordFetchFailure('llm_empty: formatter returned empty content'); t += 31_000;
    recordFetchFailure('llm_empty: formatter returned empty content'); t += 30_000;
    recordFetchFailure('llm_empty: formatter returned empty content'); t += 30_000;
    recordFetchFailure('llm_empty: formatter returned empty content'); // open #4 — rung 3 (capped)
    t += 30 * 60 * 1000 - 1;
    expect(isNewsFetchCircuitOpen()).toBe(true);
    t += 1;
    expect(isNewsFetchCircuitOpen()).toBe(false);
  });

  it('a healthy fetch resets the ladder — the next outage starts at the 3-min rung again', async () => {
    let t = 5_000_000;
    const now = { get t() { return t; }, set t(v) { t = v; } } as any;
    jest.spyOn(Date, 'now').mockImplementation(() => t);

    tripFromFresh(now);                    // open #1 — rung 1
    t += 3 * 60 * 1000;                    // cooldown expires → probe
    expect(isNewsFetchCircuitOpen()).toBe(false);
    // The probe fetch SUCCEEDS — a real healthy fetchNewsHeadlines calls
    // recordFetchSuccess() on its usable-briefing path, resetting the ladder.
    const { fetchNewsHeadlines } = await import('./news.service');
    const { utilityChat } = await import('../../utils/utility-llm');
    (utilityChat as jest.Mock).mockResolvedValueOnce(
      JSON.stringify(Array.from({ length: 15 }, (_, i) => ({
        headline: `Real news story about ${['election', 'wildfire', 'spacex', 'senate', 'hurricane', 'inflation', 'playoff', 'verdict', 'protest', 'eclipse', 'merger', 'vaccine', 'cyberattack', 'olympics', 'embargo'][i]}`,
        summary: `Story ${i} — a concrete event with specifics.`,
        category: 'us',
        chatPrompt: `What happened in story ${i}?`,
      }))),
    );
    const healthy = await fetchNewsHeadlines('', '', '', []);
    expect(healthy.length).toBeGreaterThanOrEqual(15); // recordFetchSuccess ran
    // …and the next outage starts at rung 1 again (3 min, NOT escalated 10).
    tripFromFresh(now);
    t += 3 * 60 * 1000 - 1;
    expect(isNewsFetchCircuitOpen()).toBe(true);
    t += 1;
    expect(isNewsFetchCircuitOpen()).toBe(false);
  });
});

describe('the auto-ticket carries the utility-LLM provider health (1105650b defect 2)', () => {
  it('threads the snapshot summary + structured detail into the trip ticket', async () => {
    let t = 9_000_000;
    const now = { get t() { return t; }, set t(v) { t = v; } } as any;
    jest.spyOn(Date, 'now').mockImplementation(() => t);
    mockedHealthSnapshot.mockReturnValue({
      summary: 'dual-provider failure streak 7; DeepSeek leg LATCHED OFF (billing/auth 401/402/403); DashScope leg active; last DeepSeek error: DeepSeek deepseek-flash (HTTP 401): Authentication Fails; last DashScope error: DashScope qwen3.6-27b (HTTP 401): Request failed with status code 401',
      detail: { dualFailureStreak: 7, deepseekBillingLatched: true, overrideLatched: false, deepseekKeyPresent: true, dashscopeKeyPresent: true, lastDeepseekError: 'DeepSeek deepseek-flash (HTTP 401): Authentication Fails', lastDashscopeError: 'DashScope qwen3.6-27b (HTTP 401): Request failed with status code 401' },
    });

    tripFromFresh(now);
    await flush();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const opts = mockFileFeedbackTicket.mock.calls[0][0];
    // The provider-leg state is ON the ticket — no log digging required.
    expect(opts.description).toContain('Utility-LLM health at trip time');
    expect(opts.description).toContain('LATCHED OFF (billing/auth 401/402/403)');
    expect(opts.description).toContain('HTTP 401');
    // The cooldown rung is stated too (escalation visible to triage).
    expect(opts.description).toContain('rung 1 of 3');
    // Structured detail lands in the context block.
    expect(opts.context.utilityLLM.dualFailureStreak).toBe(7);
    expect(opts.context.utilityLLM.deepseekBillingLatched).toBe(true);
    expect(opts.context.lastReason).toBe('llm_empty: formatter returned empty content');
    expect(opts.context.cooldownRung).toBe(1);
    expect(opts.context.cooldownMs).toBe(3 * 60 * 1000);
  });

  it('the snapshot never breaks the trip — a throwing snapshot degrades to the ticket without it', async () => {
    let t = 11_000_000;
    const now = { get t() { return t; }, set t(v) { t = v; } } as any;
    jest.spyOn(Date, 'now').mockImplementation(() => t);
    mockedHealthSnapshot.mockImplementation(() => { throw new Error('snapshot boom'); });

    tripFromFresh(now);
    await flush();

    // The breaker still opened and the ticket still filed — the snapshot is
    // strictly additive (best-effort), never load-bearing for the outage path.
    expect(isNewsFetchCircuitOpen()).toBe(true);
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(mockFileFeedbackTicket.mock.calls[0][0].description).toContain('circuit breaker just OPENED');
  });
});

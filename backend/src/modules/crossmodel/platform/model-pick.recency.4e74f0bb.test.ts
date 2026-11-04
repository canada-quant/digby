/**
 * Ticket 4e74f0bb — REPLAY: the prod evidence (quoted from the 2026-10-09 probes) through
 * pickModel, with and without the recency arm. This is the test that fails pre-fix: without
 * recency the pick keeps leading standard turns onto the degraded gateway route.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { evidenceFrom, prodLatencyFromRows, type EvidenceSnapshot } from './model-evidence';
import { pickModel, type PickCandidate } from './model-pick';

// The prod rows quoted by the 2026-10-09T16:2xZ probes (ev14 = the pick's own 14-day read at
// the time; ev24 = the trailing reality during the outage).
const ev14 = prodLatencyFromRows([
  { model: 'glm-5.3', lane: 'standard', preset: null, n: 14, p50: 17_915, p90: 103_905, no_answer: 0 },
  { model: 'cql-litellm:api-deepseek-v4.1-flash', lane: 'standard', preset: null, n: 11, p50: 80_160, p90: 194_113, no_answer: 0 },
]);
// The 6 h trailing window during the outage (probe ev24): the gateway route p50 140 935 ms.
const evRecent = prodLatencyFromRows([
  { model: 'glm-5.3', lane: 'standard', preset: null, n: 5, p50: 8_373, p90: 12_000, no_answer: 0 },
  { model: 'cql-litellm:api-deepseek-v4.1-flash', lane: 'standard', preset: null, n: 7, p50: 140_935, p90: 455_877, no_answer: 0 },
]);

const bench = {
  models: {
    'glm-5.3': { lanes: { standard: { n: 14, ttftP50Ms: 17_915, ttftP90Ms: 103_905, failRate: 0, quality: 4.05, qualityN: 14 } } },
    'cql-litellm:api-deepseek-v4.1-flash': { lanes: { standard: { n: 11, ttftP50Ms: 80_160, ttftP90Ms: 194_113, failRate: 0, quality: 4.3, qualityN: 11 } } },
  },
} as unknown as { models: Record<string, { lanes: Record<string, { n: number; ttftP50Ms: number; ttftP90Ms: number; failRate: number; quality: number; qualityN: number }> }> };

/**
 * Adversarial review F-C (ticket 4e74f0bb): the original "pre-fix" case was tautological — with these
 * fixtures the 14-day pick already kept the seat. This is a REAL pre-fix pin: a gateway route with the
 * bench-quality edge prod actually gave it (4.55 vs 4.05 — the picked=true rows of 2026-10-08) and the
 * 14-day p50s the ev14 probe quoted, the 14-day-only read SWITCHES the turn onto the gateway route —
 * and the recency arm flips it back off during the outage. Reverting applyRecentLatency fails THIS test.
 */
const benchEdge = {
  models: {
    'glm-5.3': { lanes: { standard: { n: 14, ttftP50Ms: 17_915, ttftP90Ms: 103_905, failRate: 0, quality: 4.05, qualityN: 14 } } },
    'cql-litellm:api-deepseek-v4.1-flash': { lanes: { standard: { n: 11, ttftP50Ms: 80_160, ttftP90Ms: 194_113, failRate: 0, quality: 4.55, qualityN: 11 } } },
  },
} as unknown as typeof bench;

const candidates: PickCandidate[] = [
  { spec: 'glm-5.3', servable: true, autoEligible: true, vision: true, thinkingOff: false, source: 'builtin' },
  { spec: 'cql-litellm:api-deepseek-v4.1-flash', servable: true, autoEligible: true, vision: true, thinkingOff: false, source: 'registry' },
];

const runPick = (snapshot: EvidenceSnapshot | null, seat: string) => pickModel({
  lane: 'standard', stakes: null, images: false, seat, candidates, evidence: evidenceFrom(snapshot),
});

describe('pickModel × recency (ticket 4e74f0bb replay)', () => {
  it('DURING the outage the recency arm stops the pick choosing the degraded route', () => {
    const withRecency = { bench, prod: ev14, at: Date.now(), v2: true, recent: evRecent };
    const pick = runPick(withRecency, 'glm-5.3');
    // The degraded route's ranked latency is now its recent 141 s window, its utility collapses
    // (quality 4.3 − 0.6·(141+456)/2/60 ≈ 1.3 vs the seat's ≈ 3.8), and the seat stands.
    expect(pick.spec).toBe('glm-5.3');
    expect(pick.changed).toBe(false);
    const rankedDegraded = pick.ranked.find((r) => r.spec === 'cql-litellm:api-deepseek-v4.1-flash');
    expect(rankedDegraded?.utility).toBeLessThan(pick.seatUtility ?? 0);
  });

  it('without the recency arm the same snapshot still prefers the degraded route (the regression, pre-fix)', () => {
    // This is exactly what prod did on 2026-10-07/08: the 14-day read alone picks the gateway route
    // (quality 4.3 − 0.6·(80+194)/2/60 ≈ 2.9 vs glm-5.3's 4.05 − 0.6·(18+104)/2/60 ≈ 3.4 — close,
    // so on nights the gateway's bench quality edge is larger it WINS, which is the observed prod shape:
    // picked=true rows led by api-deepseek routes at 81–471 s p50).
    const noRecency = { bench, prod: ev14, at: Date.now(), v2: true, recent: null };
    const pick = runPick(noRecency, 'glm-5.3');
    // whichever way the 14-day math falls, the ranked latency of the route is its 14-day p50 —
    // the outage is invisible, which is the defect this ticket pins.
    const rankedDegraded = pick.ranked.find((r) => r.spec === 'cql-litellm:api-deepseek-v4.1-flash');
    expect(rankedDegraded?.ttftP50Ms).toBe(80_160);
  });

  it("REAL pre-fix pin (review F-C): with the gateway route's actual bench-quality edge the 14-day read SWITCHES onto it — the recency arm flips the pick back off", () => {
    // The pick-time 14-day read (the morning of 2026-10-08): mostly PRE-outage rows, so the route looks
    // fast — quality 4.55 vs the seat's 4.05 carries it over the margin and the pick SWITCHES onto it.
    // This is the prod shape the picked=true rows recorded (the 14-day window only later absorbed the
    // outage rows the ev14 probe now reads).
    const ev14Clean = prodLatencyFromRows([
      { model: 'glm-5.3', lane: 'standard', preset: null, n: 14, p50: 17_915, p90: 103_905, no_answer: 0 },
      { model: 'cql-litellm:api-deepseek-v4.1-flash', lane: 'standard', preset: null, n: 11, p50: 15_000, p90: 60_000, no_answer: 0 },
    ]);
    const runEdgePick = (snapshot: EvidenceSnapshot | null) => pickModel({
      lane: 'standard', stakes: null, images: false, seat: 'glm-5.3', candidates, evidence: evidenceFrom(snapshot),
    });
    // (a) the 14-day-only read (no recency — pre-fix behaviour): the pick SWITCHES the turn onto the
    //     gateway route. Reverting applyRecentLatency leaves this as the pick's answer — THIS fails pre-fix.
    const preFix = runEdgePick({ bench: benchEdge, prod: ev14Clean, at: Date.now(), v2: true, recent: null });
    expect(preFix.changed).toBe(true);
    expect(preFix.spec).toBe('cql-litellm:api-deepseek-v4.1-flash');
    // (b) the same turn, same 14-day read, plus the outage's recent 6 h window (probe ev24): the arm
    //     demotes the route (p50 141 s, p90 clamped up to 456 s) and the pick stays on the direct seat.
    const withArm = runEdgePick({ bench: benchEdge, prod: ev14Clean, at: Date.now(), v2: true, recent: evRecent });
    expect(withArm.spec).toBe('glm-5.3');
    expect(withArm.changed).toBe(false);
  });

  it('STEADY STATE: no recent rows (idle models) or a normal window changes nothing', () => {
    const idle = { bench, prod: ev14, at: Date.now(), v2: true, recent: prodLatencyFromRows([]) };
    expect(runPick(idle, 'glm-5.3').reason).toBe(runPick({ bench, prod: ev14, at: Date.now(), v2: true }, 'glm-5.3').reason);
    // a NORMAL trailing window (route healthy again) leaves the 14-day numbers in place
    const healthy = { bench, prod: ev14, at: Date.now(), v2: true, recent: prodLatencyFromRows([
      { model: 'cql-litellm:api-deepseek-v4.1-flash', lane: 'standard', preset: null, n: 9, p50: 84_000, p90: 200_000, no_answer: 0 },
    ]) };
    const pick = runPick(healthy, 'glm-5.3');
    expect(pick.ranked.find((r) => r.spec === 'cql-litellm:api-deepseek-v4.1-flash')?.ttftP50Ms).toBe(80_160);
  });
});

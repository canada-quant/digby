/**
 * Ticket 4e74f0bb (2026-10-09, live-chat audit ttft_standard): the recency arm of the
 * model-pick evidence. Prod shape that filed the ticket: every cql-litellm:api-* gateway
 * route degraded from 2026-10-07 ~13:00Z (HTTP 502 seat_fallback rows + slow/hung streams)
 * while the direct glm-5.3 seat held 8–25 s; the pick LED 22 standard/checked turns onto
 * routes measuring 81–471 s p50 because its latency evidence is a 14-day percentile
 * (PROD_WINDOW_DAYS = 14) that a multi-hour outage cannot move. These tests replay that
 * shape: a materially-worse recent window demotes the model's latency evidence (and the
 * pick routes around it), a better/absent/thin recent window changes nothing, and the kill
 * switch restores the 14-day-only read.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import {
  applyRecentLatency, modelEvidenceRecencyDisabled, evidenceFrom, prodLatencyFromRows,
  PROD_EVIDENCE_RECENCY_SQL, RECENCY_MIN_N, RECENCY_WORSE_RATIO, RECENCY_WINDOW_HOURS,
  type BenchScorecard, type EvidenceSnapshot, type ProdLatency,
} from './model-evidence';

/** A raw evidence row as the SQL returns it. */
type Row = { model: string; lane: string | null; preset: string | null; n: number; p50: number | null; p90: number | null; no_answer: number };

/** The prod shape of the regressed window (2026-10-08T16:15Z, chat 4246401e, quoted from the probe): the pick's
 *  14-day evidence said the route was fine while the recent window was minutes-slow. */
const bench: BenchScorecard = { models: {
  'cql-litellm:api-deepseek-v4.1-flash': { lanes: { standard: { n: 12, ttftP50Ms: 80_160, ttftP90Ms: 194_113, failRate: 0, quality: 4.3, qualityN: 12 } } },
  'glm-5.3': { lanes: { standard: { n: 10, ttftP50Ms: 17_915, ttftP90Ms: 103_905, failRate: 0, quality: 4.1, qualityN: 10 } } },
} };

const prod14Rows: Row[] = [
  { model: 'cql-litellm:api-deepseek-v4.1-flash', lane: 'standard', preset: null, n: 11, p50: 80_160, p90: 194_113, no_answer: 0 },
  { model: 'glm-5.3', lane: 'standard', preset: null, n: 14, p50: 17_915, p90: 103_905, no_answer: 0 },
];

// the outage: recent p50 140 935 ms vs the 14-day 80 160 ms (> 1.5×) — quoted from the ev24 probe
const recentWorseRows: Row[] = [
  { model: 'cql-litellm:api-deepseek-v4.1-flash', lane: 'standard', preset: null, n: 7, p50: 140_935, p90: 455_877, no_answer: 0 },
];

describe('applyRecentLatency (ticket 4e74f0bb)', () => {
  const base = { n: 23, ttftP50Ms: 80_160, ttftP90Ms: 194_113, failRate: 0, quality: 4.3, qualityN: 12, source: 'bench n12 + prod n11 (latency)' };

  it('replays the ticket: a materially-worse recent window stands in for the ranked latency', () => {
    const recent = prodLatencyFromRows(recentWorseRows)['cql-litellm:api-deepseek-v4.1-flash']!.standard!;
    const ev = applyRecentLatency(base, recent);
    expect(ev.ttftP50Ms).toBe(140_935);
    expect(ev.ttftP90Ms).toBe(455_877);
    expect(ev.source).toMatch(/recent n7 p50 141s \(worse\)/);
    // quality / n / failRate are untouched — only the latency the pick ranks on moves
    expect(ev.quality).toBe(4.3);
    expect(ev.n).toBe(23);
  });

  it('one direction only: a better or equal recent window changes nothing (never promotes)', () => {
    const better = { n: 9, ttftP50Ms: 20_000, ttftP90Ms: 30_000, noAnswer: 0 };
    expect(applyRecentLatency(base, better)).toBe(base);
    const equal = { n: 9, ttftP50Ms: RECENCY_WORSE_RATIO * base.ttftP50Ms!, ttftP90Ms: null, noAnswer: 0 };
    expect(applyRecentLatency(base, equal)).toBe(base);
  });

  // Adversarial review F-A (ticket 4e74f0bb): the p90 ride-along must be CLAMPED — expectedWaitMs ranks on
  // mean(p50, p90), so an unguarded `recent.p90 ?? base.p90` substitution would LOWER a degraded route's
  // expected wait when the long-window p90 is outlier-inflated and the recent window is tight-but-slow,
  // promoting the route the arm exists to route around. Every outcome of the arm must be a strict demotion.
  it('a WORSE p50 with a BETTER p90 still demotes strictly — the p90 rides along clamped (review F-A)', () => {
    const fatTailedBase = { ...base, ttftP90Ms: 400_000 };
    const tightButSlow = { n: 7, ttftP50Ms: 140_935, ttftP90Ms: 100_000, noAnswer: 0 };
    const out = applyRecentLatency(fatTailedBase, tightButSlow);
    expect(out.ttftP50Ms).toBe(140_935);
    // the p90 can never drop below the base's — the expected wait never improves
    expect(out.ttftP90Ms).toBe(400_000);
    expect(out.ttftP90Ms).toBeGreaterThanOrEqual(fatTailedBase.ttftP90Ms!);
    // a HIGHER recent p90 rides through unchanged (max of the two)
    const worse = applyRecentLatency(base, { n: 7, ttftP50Ms: 140_935, ttftP90Ms: 455_877, noAnswer: 0 });
    expect(worse.ttftP90Ms).toBe(455_877);
    // a null recent p90 keeps the base's
    const nullP90 = applyRecentLatency(base, { n: 7, ttftP50Ms: 140_935, ttftP90Ms: null, noAnswer: 0 });
    expect(nullP90.ttftP90Ms).toBe(194_113);
  });

  it('thin recent windows (n < RECENCY_MIN_N) and absent windows change nothing (an idle model keeps its evidence)', () => {
    expect(applyRecentLatency(base, { n: RECENCY_MIN_N - 1, ttftP50Ms: 500_000, ttftP90Ms: null, noAnswer: 0 })).toBe(base);
    expect(applyRecentLatency(base, null)).toBe(base);
    expect(applyRecentLatency(base, undefined)).toBe(base);
    // a null p50 (all noChunk) is not latency evidence
    expect(applyRecentLatency(base, { n: 9, ttftP50Ms: null, ttftP90Ms: null, noAnswer: 9 })).toBe(base);
    // and a base with no long-window p50 has nothing to compare against
    expect(applyRecentLatency({ ...base, ttftP50Ms: null }, { n: 9, ttftP50Ms: 500_000, ttftP90Ms: null, noAnswer: 0 }).ttftP50Ms).toBeNull();
  });
});

describe('evidenceFrom applies the recency arm (ticket 4e74f0bb)', () => {
  const mk = (recent: ProdLatency | null): EvidenceSnapshot =>
    ({ bench, prod: prodLatencyFromRows(prod14Rows), at: Date.now(), v2: true, recent });

  it('the snapshot-level wiring: a worse recent window overrides, a null recent snapshot keeps the 14-day read', () => {
    const degraded = evidenceFrom(mk(prodLatencyFromRows(recentWorseRows)))('cql-litellm:api-deepseek-v4.1-flash', 'standard');
    expect(degraded?.ttftP50Ms).toBe(140_935);
    const steady = evidenceFrom(mk(null))('cql-litellm:api-deepseek-v4.1-flash', 'standard');
    expect(steady?.ttftP50Ms).toBe(80_160);
    // the healthy direct seat is untouched either way
    expect(evidenceFrom(mk(prodLatencyFromRows(recentWorseRows)))('glm-5.3', 'standard')?.ttftP50Ms).toBe(17_915);
  });
});

describe('the recency SQL (ticket 4e74f0bb)', () => {
  it('reads the SAME population as the v2 query over the recency window, with no tool-count LATERAL', () => {
    expect(PROD_EVIDENCE_RECENCY_SQL).toMatch(/u\.meta->>'leadModel' AS model/);
    expect(PROD_EVIDENCE_RECENCY_SQL).toMatch(/now\(\) - \(\$1 \|\| ' hours'\)::interval/);
    expect(PROD_EVIDENCE_RECENCY_SQL).toMatch(/uu\.email <> \$2/);
    expect(PROD_EVIDENCE_RECENCY_SQL).toMatch(/LIKE 'anon-%'/);
    expect(PROD_EVIDENCE_RECENCY_SQL).toMatch(/synthetic/);
    expect(PROD_EVIDENCE_RECENCY_SQL).toMatch(/isSupervisor.*false.*isProjectSupervisor.*false/s);
    expect(PROD_EVIDENCE_RECENCY_SQL).not.toMatch(/chat_search_usage/);
    expect(PROD_EVIDENCE_RECENCY_SQL).toMatch(/GROUP BY 1, 2$/);
  });

  it('the constants pin the bars', () => {
    expect(RECENCY_WINDOW_HOURS).toBe(6);
    expect(RECENCY_MIN_N).toBe(3);
    expect(RECENCY_WORSE_RATIO).toBe(1.5);
  });

  it('MODEL_EVIDENCE_RECENCY_DISABLED=1 is the kill switch', () => {
    expect(modelEvidenceRecencyDisabled({})).toBe(false);
    expect(modelEvidenceRecencyDisabled({ MODEL_EVIDENCE_RECENCY_DISABLED: '1' })).toBe(true);
    expect(modelEvidenceRecencyDisabled({ MODEL_EVIDENCE_RECENCY_DISABLED: 'true' })).toBe(true);
    expect(modelEvidenceRecencyDisabled({ MODEL_EVIDENCE_RECENCY_DISABLED: '' })).toBe(false);
  });
});

/** Evidence for the per-turn model pick: bench quality + prod latency, merged per model per lane. */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import {
  laneOfTtftRow, mergeEvidence, prodLatencyFromRows, evidenceFrom, laneToolRates, modelEvidenceV2Disabled, toolAwareMs,
  PROD_LATENCY_MIN_N, PROD_LATENCY_MIN_N_V2, BENCH_LANE_MIN_N, DEFAULT_LANE_TOOL_RATE, LANE_TOOL_RATE_MIN_N, PROD_EVIDENCE_SQL_V2, TOOL_EXEC_MS,
  BENCH_KIND_MIN_N, KIND_PRIOR_N, modelEvidenceKindDisabled, shrinkKindQuality,
  type BenchScorecard,
} from './model-evidence';

const bench: BenchScorecard = { models: {
  a: { lanes: { standard: { n: 10, ttftP50Ms: 30_000, ttftP90Ms: 60_000, failRate: 0.1, quality: 4.2, qualityN: 10 }, all: { n: 30, ttftP50Ms: 25_000, ttftP90Ms: 50_000, failRate: 0, quality: 4.0, qualityN: 30 } } },
  // mb1005b shape: a thin n=1 'checked' bucket next to a real 'all' bucket (P1.2).
  c: { lanes: { checked: { n: 1, ttftP50Ms: 5_000, ttftP90Ms: 9_000, failRate: 0, quality: 5.0, qualityN: 1 }, all: { n: 12, ttftP50Ms: 22_000, ttftP90Ms: 44_000, failRate: 0, quality: 3.9, qualityN: 12 } } },
  // Only a thin lane bucket, no 'all' — the lane stays as a last resort.
  d: { lanes: { checked: { n: 1, ttftP50Ms: 4_000, ttftP90Ms: 8_000, failRate: 1, quality: 2.0, qualityN: 1 } } },
} };

describe('model evidence', () => {
  it('maps a ux_ttft row to a lane (turn-plan lane first, else the preset)', () => {
    expect(laneOfTtftRow('quick', 'single_thinking')).toBe('quick');
    expect(laneOfTtftRow(null, 'single_thinking')).toBe('standard');
    expect(laneOfTtftRow(null, 'thinking')).toBe('checked');
    expect(laneOfTtftRow(null, 'deep_research')).toBe('research');
    expect(laneOfTtftRow(null, 'auto')).toBeNull();
  });

  it('quality comes only from the bench; prod latency wins once it has enough turns', () => {
    const thin = prodLatencyFromRows([{ model: 'a', lane: null, preset: 'single_thinking', n: 5, p50: 90_000, p90: 200_000, no_answer: 1 }]);
    expect(mergeEvidence('a', 'standard', bench, thin)).toMatchObject({ quality: 4.2, ttftP50Ms: 30_000, n: 15 });
    const thick = prodLatencyFromRows([{ model: 'a', lane: null, preset: 'single_thinking', n: PROD_LATENCY_MIN_N, p50: 90_000, p90: 200_000, no_answer: 0 }]);
    expect(mergeEvidence('a', 'standard', bench, thick)).toMatchObject({ quality: 4.2, ttftP50Ms: 90_000 });
  });

  it('falls back to the bench "all" bucket; prod-only evidence has no quality; nothing → null', () => {
    expect(mergeEvidence('a', 'checked', bench, null)).toMatchObject({ quality: 4.0, ttftP50Ms: 25_000 });
    const prod = prodLatencyFromRows([{ model: 'b', lane: 'quick', preset: 'single_thinking', n: 40, p50: 20_000, p90: 40_000, no_answer: 4 }]);
    expect(mergeEvidence('b', 'quick', null, prod)).toMatchObject({ quality: null, failRate: 0.1 });
    expect(mergeEvidence('zz', 'standard', bench, prod)).toBeNull();
    expect(evidenceFrom(null)('a', 'standard')).toBeNull();
  });

  it('a thin bench lane bucket (n < BENCH_LANE_MIN_N) yields to the model overall numbers (P1.2)', () => {
    // 'c' has an n=1 'checked' bucket — one answer is noise (its quality 5.0 would crown the
    // fastest-wins pick); the 'all' bucket's numbers must stand in for the lane.
    expect(mergeEvidence('c', 'checked', bench, null)).toMatchObject({ quality: 3.9, ttftP50Ms: 22_000, ttftP90Ms: 44_000, n: 12 });
    // A lane bucket at exactly the bar is still trusted.
    expect(mergeEvidence('a', 'standard', bench, null)).toMatchObject({ quality: 4.2, ttftP50Ms: 30_000 });
    // Thin lane with no 'all' bucket: the lane remains as a last resort — never less evidence than before.
    expect(mergeEvidence('d', 'checked', bench, null)).toMatchObject({ quality: 2.0, ttftP50Ms: 4_000, n: 1 });
  });

  it('two raw rows folding into one lane keep the bigger sample', () => {
    const p = prodLatencyFromRows([
      { model: 'a', lane: null, preset: 'thinking', n: 3, p50: 1, p90: 2 },
      { model: 'a', lane: 'checked', preset: 'thinking', n: 30, p50: 10, p90: 20 },
    ]);
    expect(p.a!.checked!.n).toBe(30);
  });
});

// ── V2 (roster 2026-10-06 C-2): evidence that predicts REAL turns ───────────────────────────────────────────────
describe('model evidence v2', () => {
  it('the query counts guests, drops supervisor chats and the bench account, and reads each row\'s web calls', () => {
    expect(PROD_EVIDENCE_SQL_V2).toMatch(/LIKE 'anon-%'/);
    expect(PROD_EVIDENCE_SQL_V2).not.toMatch(/'guest'/);
    expect(PROD_EVIDENCE_SQL_V2).toMatch(/"isSupervisor", false\) = false AND coalesce\(c\."isProjectSupervisor", false\) = false/);
    expect(PROD_EVIDENCE_SQL_V2).toMatch(/uu\.email <> \$2/);
    expect(PROD_EVIDENCE_SQL_V2).toMatch(/meta->>'webToolCalls'/);
    expect(PROD_EVIDENCE_SQL_V2).toMatch(/kind = 'chat_search_usage'/);
    expect(PROD_EVIDENCE_SQL_V2).toMatch(/synthetic/);
  });

  it('tool-aware bench latency: each expected web call adds one model step + the tool itself', () => {
    expect(toolAwareMs(10_000, 0, 0)).toBe(10_000);
    expect(toolAwareMs(10_000, 2, 0)).toBe(10_000 * 3 + 2 * TOOL_EXEC_MS);
    // a bench answer that already searched once is not charged twice
    expect(toolAwareMs(10_000 * 2 + TOOL_EXEC_MS, 1, 1)).toBe(10_000 * 2 + TOOL_EXEC_MS);
    expect(toolAwareMs(null, 2, 0)).toBeNull();
    expect(toolAwareMs(10_000, null, 0)).toBe(10_000);
  });

  it('lane tool rates: measured from prod rows once there are enough, else the documented default', () => {
    const prod = prodLatencyFromRows([
      { model: 'a', lane: null, preset: 'thinking', n: 22, p50: 1, p90: 2, tool_n: 22, tool_mean: 2.2 },
      { model: 'b', lane: null, preset: 'thinking', n: 19, p50: 1, p90: 2, tool_n: 19, tool_mean: 1.1 },
      { model: 'c', lane: 'quick', preset: 'single_thinking', n: 10, p50: 1, p90: 2, tool_n: 10, tool_mean: 2.1 },
    ]);
    const r = laneToolRates(prod);
    expect(r.checked).toEqual({ rate: Number(((22 * 2.2 + 19 * 1.1) / 41).toFixed(2)), n: 41, measured: true });
    expect(r.quick).toEqual({ rate: DEFAULT_LANE_TOOL_RATE.quick, n: 10, measured: false }); // 10 < LANE_TOOL_RATE_MIN_N
    expect(LANE_TOOL_RATE_MIN_N).toBe(20);
    expect(laneToolRates(null).standard).toEqual({ rate: DEFAULT_LANE_TOOL_RATE.standard, n: 0, measured: false });
  });

  it('prod latency wins at 10 real turns under v2 (20 before); quality stays bench-only', () => {
    const prod = prodLatencyFromRows([{ model: 'a', lane: null, preset: 'single_thinking', n: PROD_LATENCY_MIN_N_V2, p50: 90_000, p90: 200_000, no_answer: 0, tool_n: 10, tool_mean: 1 }]);
    expect(mergeEvidence('a', 'standard', bench, prod)).toMatchObject({ ttftP50Ms: 30_000 }); // v1: 10 < 20, bench stands
    expect(mergeEvidence('a', 'standard', bench, prod, { v2: true, laneToolRate: 0.8 })).toMatchObject({ ttftP50Ms: 90_000, ttftP90Ms: 200_000, quality: 4.2 });
  });

  it('below the prod bar the BENCH latency is re-predicted for the lane\'s real tool use (p50 and p90)', () => {
    const e = mergeEvidence('a', 'standard', bench, null, { v2: true, laneToolRate: 1 })!;
    expect(e.ttftP50Ms).toBe(toolAwareMs(30_000, 1, 0));
    expect(e.ttftP90Ms).toBe(toolAwareMs(60_000, 1, 0));
    expect(e.source).toMatch(/tool-adjusted/);
    // a bench bucket that measured its own tool use is only charged the difference
    const b2: BenchScorecard = { models: { t: { lanes: { all: { n: 10, ttftP50Ms: 40_000, ttftP90Ms: 80_000, failRate: 0, quality: 4, qualityN: 10, webToolsMean: 1 } } } } };
    expect(mergeEvidence('t', 'standard', b2, null, { v2: true, laneToolRate: 1 })!.ttftP50Ms).toBe(40_000);
  });

  it('evidenceFrom applies v2 only to a v2 snapshot (MODEL_EVIDENCE_V2_DISABLED=1 loads a v1 one)', () => {
    const prod = prodLatencyFromRows([{ model: 'a', lane: null, preset: 'single_thinking', n: 12, p50: 90_000, p90: 200_000, no_answer: 0 }]);
    expect(evidenceFrom({ bench, prod, at: 0 })('a', 'standard')!.ttftP50Ms).toBe(30_000);
    expect(evidenceFrom({ bench, prod, at: 0, v2: true })('a', 'standard')!.ttftP50Ms).toBe(90_000);
    expect(modelEvidenceV2Disabled({ MODEL_EVIDENCE_V2_DISABLED: '1' })).toBe(true);
    expect(modelEvidenceV2Disabled({})).toBe(false);
  });
});

// ── 2026-10-20 task-aware pick: QUALITY keyed on the turn's job type ───────────────────────────────────────────
describe('model evidence — kind buckets (task-aware pick)', () => {
  const kb = (quality: number, qualityN: number, extra: Record<string, unknown> = {}) => ({ n: qualityN, ttftP50Ms: 1_000, ttftP90Ms: 2_000, failRate: 0.5, quality, qualityN, ...extra });
  const kbench: BenchScorecard = { models: {
    // lane 4.2 (n 10) / all 4.0; a deep writing bucket at 5.0, a thin code bucket at 1.0
    a: { lanes: bench.models.a.lanes, kinds: { writing: kb(5.0, 24, { fieldSize: 3, runId: 'r1', at: 'x' }), code: kb(1.0, BENCH_KIND_MIN_N - 1) } },
    // a model the bench measured ONLY by kind (no lanes) — prod latency carries it
    k: { kinds: { writing: kb(4.5, 12) } },
  } };

  it('a deep kind bucket keys the quality, SHRUNK toward the lane quality; latency / failRate / n stay (spec, lane)', () => {
    const lane = mergeEvidence('a', 'standard', kbench, null)!;
    const kind = mergeEvidence('a', 'standard', kbench, null, { kind: 'writing' })!;
    expect(lane).toMatchObject({ quality: 4.2, qualityN: 10, qualityKey: 'lane' });
    const shrunk = (24 * 5.0 + KIND_PRIOR_N * 4.2) / (24 + KIND_PRIOR_N);
    expect(kind.quality).toBeCloseTo(shrunk, 3);
    expect(kind).toMatchObject({ qualityN: 24, qualityKey: 'kind', ttftP50Ms: lane.ttftP50Ms, ttftP90Ms: lane.ttftP90Ms, failRate: lane.failRate, n: lane.n });
    expect(kind.source).toMatch(/kind writing n24 q 5\.00 → 4\.80 \(shrunk toward 4\.20\)/);
    expect(shrinkKindQuality(5, 24, 4.2)).toBeCloseTo(shrunk, 9);
    expect(shrinkKindQuality(5, 8, 3)).toBe(4); // 8 answers + 8 pseudo-answers ⇒ halfway
    expect(shrinkKindQuality(5, 8, null)).toBe(4); // no base ⇒ toward the rank-scale midpoint (3), never raw
    expect(KIND_PRIOR_N).toBe(8);
  });

  it("shrinks toward the model's overall ('all') quality when the lane bucket is thin or absent", () => {
    const e = mergeEvidence('a', 'checked', kbench, null, { kind: 'writing' })!; // no 'checked' bucket ⇒ 'all' 4.0
    expect(e.quality).toBeCloseTo((24 * 5 + KIND_PRIOR_N * 4.0) / (24 + KIND_PRIOR_N), 3);
    expect(mergeEvidence('a', 'checked', kbench, null)!.qualityKey).toBe('all');
  });

  it("a thin kind bucket (qualityN < BENCH_KIND_MIN_N), an unmeasured kind or no kind ⇒ today's lane evidence, unchanged", () => {
    const lane = mergeEvidence('a', 'standard', kbench, null)!;
    expect(BENCH_KIND_MIN_N).toBe(8);
    expect(mergeEvidence('a', 'standard', kbench, null, { kind: 'code' })).toEqual(lane);
    expect(mergeEvidence('a', 'standard', kbench, null, { kind: 'planning' })).toEqual(lane);
    expect(mergeEvidence('a', 'standard', kbench, null, { kind: null })).toEqual(lane);
    // a scorecard without any kinds (every stored bucket before the kind bench) is untouched
    expect(mergeEvidence('a', 'standard', bench, null, { kind: 'writing' })).toEqual(mergeEvidence('a', 'standard', bench, null));
  });

  it('a kind-only model (no base quality) is shrunk toward the rank-scale midpoint; without prod latency it has no evidence', () => {
    expect(mergeEvidence('k', 'standard', kbench, null, { kind: 'writing' })).toBeNull();
    const prod = prodLatencyFromRows([{ model: 'k', lane: 'standard', preset: null, n: 12, p50: 40_000, p90: 80_000, no_answer: 0 }]);
    expect(mergeEvidence('k', 'standard', kbench, prod, { v2: true, kind: 'writing' })).toMatchObject({ quality: 3.9, qualityN: 12, qualityKey: 'kind', ttftP50Ms: 40_000 }); // (12·4.5 + 8·3) / 20
  });

  it('evidenceFrom passes the kind through; MODEL_EVIDENCE_KIND_DISABLED=1 ignores it', () => {
    const snap = { bench: kbench, prod: null, at: 0 };
    expect(evidenceFrom(snap)('a', 'standard', 'writing')).toMatchObject({ qualityKey: 'kind', qualityN: 24 });
    expect(evidenceFrom(snap)('a', 'standard')).toMatchObject({ qualityKey: 'lane', quality: 4.2 });
    expect(modelEvidenceKindDisabled({ MODEL_EVIDENCE_KIND_DISABLED: '1' })).toBe(true);
    expect(modelEvidenceKindDisabled({})).toBe(false);
    process.env.MODEL_EVIDENCE_KIND_DISABLED = '1';
    try {
      expect(evidenceFrom(snap)('a', 'standard', 'writing')).toMatchObject({ qualityKey: 'lane', quality: 4.2, qualityN: 10 });
    } finally {
      delete process.env.MODEL_EVIDENCE_KIND_DISABLED;
    }
  });
});

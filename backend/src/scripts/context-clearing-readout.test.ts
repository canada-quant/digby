/**
 * Pure functions of the tier-1 context-clearing stage-3 readout (scripts/framework-audit/context-clearing-readout.js,
 * build 2026-10-11 T1): per-arm $ per outcome + guardrails over ELIGIBLE runs, the act / hold / insufficient_data
 * verdict (context.md §1 item 12 — ≥ 15 % lower $ per outcome, no guardrail worse by > 10 % rel or > 3 verify-pass
 * points, treated cache hit ≥ 85 %, ≥ 30 runs per arm), and the event stats. The probe is plain CommonJS (it runs
 * from /app inside the backend container), so it is required by path here.
 */

import path from 'path';

const probe: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'context-clearing-readout.js'));

const summary = (arm: string, over: Record<string, unknown> = {}) => ({
  meta: {
    event: 'run_summary', arm, model: 'cql-litellm:api-optimize-zai-glm-5.3', t1Eligible: true, t1Trigger: 160_000, peakPromptTokens: 240_000,
    costUsd: 8, outcomes: 4, commits: 2, prs: 1, verifyPassed: 1, verifyRuns: 2,
    toolCalls: 200, dupCalls: 10, readFileCalls: 40, readFilePaths: 20, searchMemoryCalls: 2,
    sumPromptTokens: 30_000_000, sumCachedTokens: 28_500_000, endState: 'ok', t1Events: arm === 'treatment' ? 2 : 0, ...over,
  },
});
const many = (n: number, arm: string, over: Record<string, unknown> = {}) => Array.from({ length: n }, () => summary(arm, over));

describe('context-clearing-readout — the stage-3 bar', () => {
  it('act: ≥ 30 runs per arm, $ per outcome −25 %, guardrails flat, treated cache hit 0.95', () => {
    const rows = [...many(30, 'treatment', { costUsd: 6 }), ...many(30, 'control')];
    const out = probe.aggregate(rows);
    expect(out.eligibleRuns).toEqual({ treatment: 30, control: 30 });
    expect(out.arms.treatment).toMatchObject({ runs: 30, costPerOutcome: 1.5, dupShare: 0.05, readsPerFile: 2, searchMemoryPerRun: 2, verifyPassRate: 0.5, completion: 1, cacheHit: 0.95, t1EventsPerRun: 2 });
    expect(out.arms.control.costPerOutcome).toBe(2);
    expect(out.bar).toMatchObject({ verdict: 'act', dollarDelta: -0.25, why: [] });
    expect(out.barByProfile.coding).toBeUndefined(); // fixture rows carry no profile
  });

  it('barByProfile: coding lanes and chat runs are read separately', () => {
    const rows = [...many(30, 'treatment', { costUsd: 6, profile: 'coding' }), ...many(30, 'control', { profile: 'coding' }),
      ...many(30, 'treatment', { costUsd: 8.4, profile: 'chat' }), ...many(30, 'control', { profile: 'chat' })];
    const out = probe.aggregate(rows);
    expect(out.barByProfile.coding).toMatchObject({ verdict: 'act', dollarDelta: -0.25, eligibleRuns: { treatment: 30, control: 30 } });
    expect(out.barByProfile.chat).toMatchObject({ verdict: 'hold', dollarDelta: 0.05 });
    expect(out.bar.verdict).toBe('hold'); // pooled: −10 %
  });

  it('hold: a guardrail worse by > 10 % (re-reads per file) or verify pass down > 3 points blocks act even when cheaper', () => {
    const reads = probe.aggregate([...many(30, 'treatment', { costUsd: 6, readFileCalls: 46 }), ...many(30, 'control')]);
    expect(reads.bar.verdict).toBe('hold');
    expect(reads.bar.guardrails.find((g: any) => g.name === 'readsPerFile')).toMatchObject({ worse: true, relDelta: 0.15 });
    const verify = probe.aggregate([...many(30, 'treatment', { costUsd: 6, verifyPassed: 1, verifyRuns: 3 }), ...many(30, 'control')]);
    expect(verify.bar.verdict).toBe('hold');
    expect(verify.bar.why.join(' ')).toMatch(/verifyPassRate worse/);
  });

  it('hold: not cheaper enough, or the treated cache hit under 0.85', () => {
    expect(probe.aggregate([...many(30, 'treatment', { costUsd: 7.2 }), ...many(30, 'control')]).bar).toMatchObject({ verdict: 'hold', dollarDelta: -0.1 });
    const cold = probe.aggregate([...many(30, 'treatment', { costUsd: 6, sumCachedTokens: 20_000_000 }), ...many(30, 'control')]);
    expect(cold.bar.verdict).toBe('hold');
    expect(cold.bar.why.join(' ')).toMatch(/treated cache hit/);
  });

  it('insufficient_data under the per-arm minimum; ineligible runs (never crossed T) are not compared', () => {
    const rows = [...many(29, 'treatment', { costUsd: 6 }), ...many(40, 'control'), ...many(50, 'treatment', { t1Eligible: false, costUsd: 0.5 })];
    const out = probe.aggregate(rows);
    expect(out.runsByArm).toEqual({ treatment: 79, control: 40 });
    expect(out.eligibleRuns).toEqual({ treatment: 29, control: 40 });
    expect(out.bar.verdict).toBe('insufficient_data');
    expect(probe.aggregate(rows, 20).bar.verdict).toBe('act'); // the minimum is the second CLI argument
  });

  it('legacy rows (pre-T1, no arm) and shadow / off runs are counted but never enter the A/B', () => {
    const out = probe.aggregate([summary('shadow'), { meta: { ...summary('x').meta, arm: undefined } }, summary('off')]);
    expect(out.runsByArm).toEqual({ shadow: 1, legacy: 1, off: 1 });
    expect(out.eligibleRuns).toEqual({ treatment: 0, control: 0 });
  });

  it('by seat model and the event stats (predicted vs observed cached tokens, unplanned misses)', () => {
    const rows = [
      ...many(2, 'treatment'), ...many(1, 'control', { model: 'cql-litellm:api-optimize-moonshot-kimi-k3' }),
      { meta: { event: 'tier1_act', freedTokens: 60_000, clearedResults: 12, predictedCachedTokens: 100_000, observedCachedTokens: 98_000, breakUsdPredicted: 0.05, breakUsdObserved: 0.06, unplannedMiss: false, turnsSinceAnchor: 9 } },
      { meta: { event: 'tier1_act', freedTokens: 42_000, clearedResults: 8, predictedCachedTokens: 120_000, observedCachedTokens: 0, breakUsdPredicted: 0.04, breakUsdObserved: 0.2, unplannedMiss: true, turnsSinceAnchor: 5 } },
      { meta: { event: 'tier1_act', freedTokens: 41_000, clearedResults: 7, predictedCachedTokens: 90_000, breakUsdPredicted: 0.03, turnsSinceAnchor: null } },
      { meta: { event: 'tier1_shadow', arm: 'control' } }, { meta: { event: 'tier1_shadow', arm: 'shadow' } },
    ];
    const out = probe.aggregate(rows);
    expect(Object.keys(out.byModel).sort()).toEqual(['control · cql-litellm:api-optimize-moonshot-kimi-k3', 'treatment · cql-litellm:api-optimize-zai-glm-5.3']);
    expect(out.events.treatment).toMatchObject({ events: 3, freedTokensP50: 42_000, withObservation: 2, unplannedMisses: 1, breakUsdPredicted: 0.12, breakUsdObserved: 0.26, turnsSinceAnchorMin: 5 });
    expect(out.events.treatment.cachedPredictionAbsErrP50).toBe(1); // nearest-rank median of [0.02, 1]
    expect(out.events.controlWouldClear).toBe(1);
  });
});

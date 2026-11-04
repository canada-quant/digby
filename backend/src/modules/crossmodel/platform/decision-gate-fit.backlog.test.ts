/**
 * decision-gate-fit.ts — backlog 2026-09-28 readiness changes:
 *   E11     the VOLUME-SCALED label floor (clamp(10 × labels/day, 50, base)) and
 *           the degenerate-label exemption (one class under 5 % of n ⇒ the AUROC /
 *           coverage bars are waived, precision bar only; a class with ZERO rows
 *           keeps the "AUROC n/a" missed bar); kill switch restores both;
 *   DOI-21  a non-human segment's own harness label (MACHINE_SEGMENT_LABEL_FOR_FIT)
 *           is admitted to ITS partition's fit, stamps ReadinessSample.harnessLabel,
 *           and lifts the segment's "no harness label exists" bar when every
 *           sample carries it; a human row with that label is never admitted;
 *   E14     ACT_POLICIES.coding_memory_fold.defaultThreshold is 0.9.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' }, recordLoopMetric: jest.fn() }));

import {
  ACT_POLICIES, READINESS_BARS, READINESS_DEGENERATE_MINORITY_SHARE, READINESS_MIN_LABELS_FLOOR, READINESS_VOLUME_RULE, READINESS_VOLUME_SCALE_DAYS,
  MACHINE_SEGMENT_LABEL_FOR_FIT, isMachineSegmentLabelRow, labelsDegenerate, labelsPerDayOf, outcomeRowEntersFit, pairReadinessRows, readinessMetrics, readinessVerdict,
  volumeScaledMinLabels,
  type ReadinessRow, type ReadinessSample,
} from './decision-gate-fit';

const T0 = Date.parse('2026-09-20T00:00:00Z');
const H = 3_600_000;
/** A labelled noul_low sample (wake_triage-shaped) at hour `i`; `agreed` false flips the actual. */
const sample = (i: number, over: Partial<ReadinessSample> = {}): ReadinessSample => ({
  id: `s${i}`, question: 'needs_turn_now', predicted: { noul: 0.05 }, predictedKey: 'no', confidence: 0.95, actual: 'no', agreed: true,
  at: T0 + i * H, questionsHash: 'q1', acted: false, ...over,
});
const samples = (n: number, hoursApart = 1, over: (i: number) => Partial<ReadinessSample> = () => ({})): ReadinessSample[] =>
  Array.from({ length: n }, (_, i) => sample(i, { at: T0 + i * hoursApart * H, ...over(i) }));
const metricsOf = (purpose: string, s: ReadinessSample[], extra: Record<string, unknown> = {}) =>
  readinessMetrics({ backend: 'TypeSafe Jev', backendSpec: 'jev', purpose, samples: s, deduped: 0, undedupable: 0, ...extra } as any);

describe('E11 — volume-scaled label floor (pure)', () => {
  it('labelsPerDayOf treats a span under one day as one day; volumeScaledMinLabels = clamp(10 × rate, 50, base); no labels ⇒ the base floor', () => {
    expect(READINESS_VOLUME_SCALE_DAYS).toBe(10);
    expect(READINESS_MIN_LABELS_FLOOR).toBe(50);
    expect(labelsPerDayOf(30, 0.5)).toBe(30);
    expect(labelsPerDayOf(20, 2.8)).toBeCloseTo(7.142857, 5);
    expect(volumeScaledMinLabels(200, 20, 2.8)).toBe(71);   // browser_driver: 20 labels / 2.8 d ⇒ 10 days of labels
    expect(volumeScaledMinLabels(200, 8, 2.3)).toBe(50);    // imessage_send: 8 / 2.3 d ⇒ 35 ⇒ the sane minimum
    expect(volumeScaledMinLabels(200, 177, 2.8)).toBe(200); // claim_evidenced: 63/day ⇒ 632 ⇒ capped at the base
    expect(volumeScaledMinLabels(200, 0, 0)).toBe(200);     // nothing observed ⇒ nothing to scale from
    expect(volumeScaledMinLabels(30, 4, 3)).toBe(30);       // a base at or below the sane minimum is never scaled below itself (min(base, 50) = base)
    expect(READINESS_VOLUME_RULE).toContain('10 × observed labels/day');
    expect(READINESS_VOLUME_RULE).not.toMatch(/20\d\d-\d\d-\d\d/);
  });
  it('labelsDegenerate: one class under 5 % of n with at least one row; zero minority rows are NOT degenerate (a label writer that never fires)', () => {
    expect(READINESS_DEGENERATE_MINORITY_SHARE).toBe(0.05);
    expect(labelsDegenerate({ n: 430, positives: 426, negatives: 4 })).toBe(true);
    expect(labelsDegenerate({ n: 100, positives: 94, negatives: 6 })).toBe(false);
    expect(labelsDegenerate({ n: 145, positives: 145, negatives: 0 })).toBe(false);
    expect(labelsDegenerate({ n: 0, positives: 0, negatives: 0 })).toBe(false);
  });
});

describe('E11 — readinessMetrics / readinessVerdict', () => {
  it('metrics carry labelsPerDay / minLabelsEffective / degenerateLabels / harnessLabelled; the verdict names the SCALED floor and passes the label bar on a low-volume purpose that holds 10 days of labels', () => {
    // 60 labels over 8 days (7.5/day) ⇒ effective floor 75 — not there yet.
    const m60 = metricsOf('browser_driver', samples(60, 3.2, (i) => ({ question: 'driver', predicted: { choice: 'cloud', confidence: 0.95 }, predictedKey: 'cloud', actual: i % 8 === 0 ? 'local' : 'cloud', agreed: i % 8 !== 0 })));
    expect(m60.n).toBe(60);
    expect(m60.labelsPerDay).toBeCloseTo(60 / m60.days, 9);
    expect(m60.minLabelsEffective).toBe(Math.round(10 * 60 / m60.days));
    expect(m60.harnessLabelled).toBe(0);
    const v60 = readinessVerdict('browser_driver', m60, true);
    expect(v60.reasons.some(r => r.startsWith(`labels 60 < ${m60.minLabelsEffective}`) && r.includes('volume-scaled'))).toBe(true);
    // 91 labels spaced 3 h (span 11.25 d, 8.09/day) ⇒ effective floor 81 ≤ n — the label bar holds (other bars judged on their own).
    const m91 = metricsOf('browser_driver', samples(91, 3, (i) => ({ question: 'driver', predicted: { choice: 'cloud', confidence: 0.95 }, predictedKey: 'cloud', actual: i % 8 === 0 ? 'local' : 'cloud', agreed: i % 8 !== 0 })));
    expect(m91.days).toBeCloseTo(11.25, 6);
    expect(m91.minLabelsEffective).toBe(81);
    expect(readinessVerdict('browser_driver', m91, true).reasons.some(r => r.startsWith('labels '))).toBe(false);
  });
  it('a degenerate label set waives the AUROC / coverage bars (precision bar only); a one-class set keeps the "AUROC n/a" bar', () => {
    // 4 negatives in 430 (claim_evidenced-shaped: noul_high, positives = 'yes').
    const s = samples(430, 0.5, (i) => ({ question: 'claim_1_evidenced', predicted: { noul: 0.97 }, predictedKey: 'yes', confidence: 0.97, actual: i % 100 === 0 ? 'no' : 'yes', agreed: i % 100 !== 0 }));
    const m = metricsOf('claim_evidenced', s);
    expect(m.degenerateLabels).toBe(true);
    expect(m.negatives).toBe(5);
    const v = readinessVerdict('claim_evidenced', m, true);
    expect(v.reasons.some(r => r.startsWith('AUROC') || r.startsWith('coverage'))).toBe(false);
    const oneClass = metricsOf('claim_evidenced', samples(430, 0.5, () => ({ question: 'claim_1_evidenced', predicted: { noul: 0.97 }, predictedKey: 'yes', confidence: 0.97, actual: 'yes', agreed: true })));
    expect(oneClass.degenerateLabels).toBe(false);
    expect(readinessVerdict('claim_evidenced', oneClass, true).reasons.some(r => r.startsWith('AUROC n/a'))).toBe(true);
  });
});

describe('DOI-21 — the non-human segment’s own harness label', () => {
  it('isMachineSegmentLabelRow / outcomeRowEntersFit: a supervisor row labelled machine is admitted; a human row with that label is not', () => {
    expect(MACHINE_SEGMENT_LABEL_FOR_FIT).toEqual({ compute_policy: 'machine' });
    expect(isMachineSegmentLabelRow('compute_policy', { label: 'machine', segment: 'supervisor' })).toBe(true);
    expect(isMachineSegmentLabelRow('compute_policy', { label: 'machine', segment: 'user' })).toBe(false);
    expect(isMachineSegmentLabelRow('compute_policy', { label: 'facts', segment: 'supervisor' })).toBe(false);
    expect(isMachineSegmentLabelRow('wake_triage', { label: 'machine', segment: 'supervisor' })).toBe(false);
    const opts = { primary: new Set<string>(), rowAtMs: T0, nowMs: T0 + H };
    expect(outcomeRowEntersFit('compute_policy', { id: 'm1', question: 'depth', label: 'machine', segment: 'supervisor' }, opts)).toBe(true);
    expect(outcomeRowEntersFit('compute_policy', { id: 'm1', question: 'depth', label: 'machine', segment: 'user' }, opts)).toBe(false);
    expect(outcomeRowEntersFit('compute_policy', { id: 'm1', question: 'depth', label: 'machine', segment: 'supervisor', excludeFromFit: true }, opts)).toBe(false); // the ramp
  });
  it('pairReadinessRows: a machine row lands in the segment group with harnessLabel:true; the same label on a human row pairs nothing', () => {
    const at = new Date(T0);
    const dec = (id: string, segment?: string): ReadinessRow => ({ createdAt: at, meta: { phase: 'decision', id, purpose: 'compute_policy', backend: 'TypeSafe Jev', backendSpec: 'jev', ok: true, questionsHash: 'q', stateHash: `st-${id}`, answers: { depth: { choice: 'ordinary', confidence: 0.85 } }, ...(segment ? { segment } : {}) } } as any);
    const out = (id: string, segment?: string): ReadinessRow => ({ createdAt: new Date(T0 + H), meta: { phase: 'outcome', id, purpose: 'compute_policy', question: 'depth', label: 'machine', actual: 'ordinary', agreed: true, ...(segment ? { segment } : {}) } } as any);
    const groups = pairReadinessRows([dec('m1', 'supervisor'), out('m1', 'supervisor'), dec('h1'), out('h1')], { now: T0 + 2 * H, env: {} });
    const sup = groups.find(g => g.segment === 'supervisor');
    expect(sup?.samples).toHaveLength(1);
    expect(sup?.samples[0]).toMatchObject({ id: 'm1', actual: 'ordinary', harnessLabel: true, segment: 'supervisor' });
    const human = groups.find(g => !g.segment);
    expect(human?.samples ?? []).toHaveLength(0);
  });
  it('readinessVerdict: the segment bar is lifted when EVERY sample is the harness label; kept when any sample is not; the stamp rule is unchanged (the segment entry only)', () => {
    const machine = samples(40, 6, () => ({ question: 'depth', predicted: { choice: 'ordinary', confidence: 0.9 }, predictedKey: 'ordinary', actual: 'ordinary', agreed: true, segment: 'supervisor', harnessLabel: true }));
    const mAll = metricsOf('compute_policy', machine, { segment: 'supervisor' });
    expect(mAll.harnessLabelled).toBe(40);
    expect(readinessVerdict('compute_policy', mAll, true, { segment: 'supervisor' }).reasons.some(r => r.startsWith("segment 'supervisor'"))).toBe(false);
    const mixed = metricsOf('compute_policy', [...machine.slice(0, 39), sample(39, { question: 'depth', predicted: { choice: 'ordinary', confidence: 0.9 }, predictedKey: 'ordinary', actual: 'ordinary', segment: 'supervisor' })], { segment: 'supervisor' });
    expect(mixed.harnessLabelled).toBe(39);
    expect(readinessVerdict('compute_policy', mixed, true, { segment: 'supervisor' }).reasons.some(r => r.startsWith("segment 'supervisor'"))).toBe(true);
  });
});

describe('E14 — coding_memory_fold cutoff', () => {
  it('ACT_POLICIES.coding_memory_fold.defaultThreshold is 0.9 (the site constant moved in lockstep); READINESS_BARS unchanged', () => {
    expect(ACT_POLICIES.coding_memory_fold.defaultThreshold).toBe(0.9);
    expect(READINESS_BARS).toMatchObject({ minLabels: 200, minDays: 3, minActBandPrecision: 0.9, minActBandN: 20, minAuroc: 0.8, minCoverageAt5: 0.6 });
  });
});

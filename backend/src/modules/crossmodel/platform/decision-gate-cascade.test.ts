/**
 * decision-gate-cascade.ts — the offline cascade curve (Laya follow-up,
 * 2026-09-26): exact-binomial LTT sizing (n=50 → 1 error allowed, 100 → 4,
 * 200 → 12, 300 → 21 at α 0.10 δ 0.05), the paired Δ + its one-sided lower
 * bound, the primary ↔ challenger ↔ outcome pairing (logits from
 * probabilities when absent, per-(spec, purpose) temperature, dedupe), the
 * τ grid, fixed-sequence strict → loose certification, and the table.
 * Pure — no mocks.
 */

import { wilsonInterval } from './decision-gate-math';
import {
  CASCADE_ALPHA_DEFAULT, CASCADE_DELTA_DEFAULT, ONE_SIDED_95_Z, binomialCdf, cascadeCurve, cascadePoint, cascadeTaus, formatCascadeTable,
  logBinomialPmf, lttMaxErrors, lttPValue, pairCascadeRows, temperedView, type CascadePair,
} from './decision-gate-cascade';
import type { DecisionGateRow } from './decision-gate-fit';

describe('exact binomial + LTT sizing', () => {
  it('pmf / cdf are exact on small cases', () => {
    expect(Math.exp(logBinomialPmf(0, 2, 0.5))).toBeCloseTo(0.25, 12);
    expect(Math.exp(logBinomialPmf(1, 2, 0.5))).toBeCloseTo(0.5, 12);
    expect(binomialCdf(1, 2, 0.5)).toBeCloseTo(0.75, 12);
    expect(binomialCdf(2, 2, 0.5)).toBe(1);
    expect(binomialCdf(-1, 2, 0.5)).toBe(0);
    expect(binomialCdf(0, 0, 0.5)).toBe(1);
    // P(Bin(50, 0.1) ≤ 1) = 0.9^50 + 50·0.1·0.9^49
    expect(binomialCdf(1, 50, 0.1)).toBeCloseTo(Math.pow(0.9, 50) + 50 * 0.1 * Math.pow(0.9, 49), 12);
  });

  it('the scope\'s sizing numbers at α 0.10 δ 0.05: n=50 → 1 error allowed, 100 → 4, 200 → 12, 300 → 21', () => {
    expect(lttMaxErrors(50, 0.10, 0.05)).toBe(1);
    expect(lttMaxErrors(100, 0.10, 0.05)).toBe(4);
    expect(lttMaxErrors(200, 0.10, 0.05)).toBe(12);
    expect(lttMaxErrors(300, 0.10, 0.05)).toBe(21);
    // The defaults ARE α 0.10 / δ 0.05.
    expect(lttMaxErrors(50)).toBe(1);
    expect(CASCADE_ALPHA_DEFAULT).toBe(0.10);
    expect(CASCADE_DELTA_DEFAULT).toBe(0.05);
    // Too small a band: even zero errors cannot reject (0.9^n > 0.05 for n < 29).
    expect(lttMaxErrors(20)).toBe(-1);
    expect(lttMaxErrors(0)).toBe(-1);
    expect(lttMaxErrors(29)).toBe(0);
    // The p-value at the boundary is ≤ δ, one more error is not.
    expect(lttPValue(1, 50, 0.10)).toBeLessThanOrEqual(0.05);
    expect(lttPValue(2, 50, 0.10)).toBeGreaterThan(0.05);
    expect(lttPValue(4, 100, 0.10)).toBeLessThanOrEqual(0.05);
    expect(lttPValue(5, 100, 0.10)).toBeGreaterThan(0.05);
  });
});

// ── synthetic pairs ──────────────────────────────────────────────────────────

/** A wake_triage (noul_low: act = park when noul ≤ 1 − τ) pair. */
const pair = (i: number, firstNoul: number, primaryNoul: number, actual: 'yes' | 'no', extra: Partial<CascadePair> = {}): CascadePair => ({
  id: `p${i}`, question: 'needs_turn_now', purpose: 'wake_triage', firstSpec: 'cql:agx-laya', primarySpec: 'jev',
  first: { noul: firstNoul }, primary: { noul: primaryNoul }, actual, at: i, degenerate: false, fromOutcomePredicted: false, ...extra,
});

describe('cascadePoint — band, precision, Wilson bounds, paired Δ, LTT, non-inferiority', () => {
  it('counts the band at τ, both precisions on the SAME rows, d / w, Δ and its one-sided 95% lower bound', () => {
    const pairs: CascadePair[] = [];
    // 40 rows the first leg parks at 0.05 (in band at τ ≤ 0.95): 38 right (actual no), 2 wrong (actual yes).
    for (let i = 0; i < 40; i++) pairs.push(pair(i, 0.05, i < 36 ? 0.05 : 0.6, i < 38 ? 'no' : 'yes'));
    // ↑ primary: 36 say no (right on 36 of the 38 'no' rows… see below), 4 say yes.
    // 10 rows the first leg is unsure about (0.5) — outside every band.
    for (let i = 40; i < 50; i++) pairs.push(pair(i, 0.5, 0.1, 'no'));
    const p = cascadePoint(pairs, 'wake_triage', 0.9, { alpha: 0.1, delta: 0.05, margin: 0.03 });
    expect(p.nBand).toBe(40);
    expect(p.coverage).toBeCloseTo(0.8, 12);
    expect(p.firstCorrect).toBe(38);
    expect(p.firstPrecision).toBeCloseTo(0.95, 12);
    expect(p.firstLower95).toBeCloseTo(wilsonInterval(38, 40).lower, 12);
    // Primary on the band: rows 0..35 primary says no — right for rows 0..35 (actual no); rows 36,37 primary says yes, actual no → wrong;
    // rows 38,39 primary says yes, actual yes → right. → 38 right.
    expect(p.primaryCorrectOnBand).toBe(38);
    expect(p.primaryPrecisionOnBand).toBeCloseTo(0.95, 12);
    // Discordant: rows 36,37 (first right, primary wrong) + rows 38,39 (first wrong, primary right) → d=4, w=2 → Δ = 0.
    expect(p.d).toBe(4);
    expect(p.w).toBe(2);
    expect(p.delta).toBeCloseTo(0, 12);
    expect(p.deltaLower95).toBeCloseTo((4 * (2 * wilsonInterval(2, 4, ONE_SIDED_95_Z).lower - 1)) / 40, 12);
    expect(p.deltaLower95).toBeLessThan(0);
    // LTT: 2 errors out of 40 — allowed at n=40 is 0 (0.9^40 = 0.0148 ≤ 0.05; cdf(1) = 0.0805 > 0.05) → fails.
    expect(p.errors).toBe(2);
    expect(p.errorsAllowed).toBe(0);
    expect(p.lttPass).toBe(false);
    expect(p.pass).toBe(false);
    // The non-inferiority verdict at margin 0.03: Δ_lower ≈ −0.05 → not non-inferior; at margin 0.1 it is.
    expect(p.nonInferior).toBe(p.deltaLower95 >= -0.03);
    expect(cascadePoint(pairs, 'wake_triage', 0.9, { alpha: 0.1, delta: 0.05, margin: 0.1 }).nonInferior).toBe(true);
  });

  it('d = 0 (the two always agree) gives Δ = 0 with lower bound 0 — non-inferior at any margin; an empty band never passes', () => {
    const pairs: CascadePair[] = [];
    for (let i = 0; i < 60; i++) pairs.push(pair(i, 0.05, 0.05, 'no'));
    const p = cascadePoint(pairs, 'wake_triage', 0.9, { alpha: 0.1, delta: 0.05, margin: 0 });
    // n=60 at α 0.10 δ 0.05: P(X≤1) = 0.0137 ≤ 0.05, P(X≤2) = 0.0528 > 0.05 → 1 error allowed.
    expect(p).toMatchObject({ nBand: 60, d: 0, w: 0, delta: 0, deltaLower95: 0, errors: 0, errorsAllowed: 1, lttPass: true, nonInferior: true, pass: true });
    const empty = cascadePoint(pairs, 'wake_triage', 0.99, { alpha: 0.1, delta: 0.05, margin: 0 });
    // noul 0.05 > 1 − 0.99 = 0.01 → outside the band.
    expect(empty).toMatchObject({ nBand: 0, coverage: 0, lttPass: false, nonInferior: false, pass: false, lttP: 1 });
    expect(Number.isNaN(empty.firstPrecision)).toBe(true);
  });

  it('a choice_high purpose bands on confidence ≥ τ and judges the first leg on its choice', () => {
    const pairs: CascadePair[] = [];
    for (let i = 0; i < 50; i++) {
      pairs.push({
        id: `c${i}`, question: 'level', purpose: 'auto_route', firstSpec: 'cql:agx-laya', primarySpec: 'jev',
        first: { choice: i < 45 ? 'thinking' : 'single_thinking', confidence: i % 2 ? 0.95 : 0.6, probabilities: {} },
        primary: { choice: 'thinking', confidence: 0.9 }, actual: 'thinking', at: i, degenerate: false, fromOutcomePredicted: false,
      });
    }
    const p = cascadePoint(pairs, 'auto_route', 0.9, { alpha: 0.1, delta: 0.05, margin: 0.03 });
    // Odd i are in band (25 rows); of those, i ≥ 45 odd (45, 47, 49) chose single_thinking → wrong.
    expect(p.nBand).toBe(25);
    expect(p.firstCorrect).toBe(22);
    expect(p.primaryCorrectOnBand).toBe(25);
    expect(p.d).toBe(3);
    expect(p.w).toBe(0);
    expect(p.delta).toBeCloseTo(-3 / 25, 12);
  });
});

describe('cascadeCurve — the τ grid + fixed-sequence certification', () => {
  it('the grid is 0.50 … 0.99 step 0.01 (50 points, 2 dp)', () => {
    const taus = cascadeTaus();
    expect(taus).toHaveLength(50);
    expect(taus[0]).toBe(0.5);
    expect(taus[49]).toBe(0.99);
    expect(taus.every(t => Number(t.toFixed(2)) === t)).toBe(true);
  });

  it('certifies strict → loose and stops at the first failing τ — the loosest certified τ is the verdict; later passes after a failure are NOT certified', () => {
    // First-leg nouls spread so that the band grows as τ loosens: 60 rows at 0.02 (in band for τ ≤ 0.98), 30 at 0.10 (τ ≤ 0.90), 30 at 0.30 (τ ≤ 0.70).
    const pairs: CascadePair[] = [];
    let i = 0;
    for (let k = 0; k < 60; k++, i++) pairs.push(pair(i, 0.02, 0.05, 'no'));           // all right
    for (let k = 0; k < 30; k++, i++) pairs.push(pair(i, 0.10, 0.05, k < 20 ? 'no' : 'yes')); // 10 wrong → the band at τ ≤ 0.90 has 10/90 errors (fails)
    for (let k = 0; k < 30; k++, i++) pairs.push(pair(i, 0.30, 0.05, 'no'));           // all right — but comes after the failure
    const curve = cascadeCurve(pairs, { purpose: 'wake_triage', first: 'cql:agx-laya', margin: 0.03, taus: [0.5, 0.7, 0.9, 0.95, 0.98, 0.99] });
    const byTau = new Map(curve.points.map(p => [p.tau, p]));
    // τ 0.99: band = noul ≤ 0.01 → empty → fails → NOTHING is certified (the sequence stops at the strictest τ).
    expect(byTau.get(0.99)!.nBand).toBe(0);
    expect(byTau.get(0.99)!.certified).toBe(false);
    expect(byTau.get(0.98)!.nBand).toBe(60);
    expect(byTau.get(0.98)!.pass).toBe(true);
    expect(byTau.get(0.98)!.certified).toBe(false); // a stricter τ failed first
    expect(curve.certifiedTau).toBeNull();
    // Drop the empty strictest point: the sequence starts at 0.98 (passes), 0.95 (same band, passes), 0.90 (10/90 errors > 4 allowed → fails), 0.70 … not certified.
    const curve2 = cascadeCurve(pairs, { purpose: 'wake_triage', first: 'cql:agx-laya', margin: 0.03, taus: [0.5, 0.7, 0.9, 0.95, 0.98] });
    const by2 = new Map(curve2.points.map(p => [p.tau, p]));
    expect(by2.get(0.98)!.certified).toBe(true);
    expect(by2.get(0.95)!.certified).toBe(true);
    expect(by2.get(0.9)!).toMatchObject({ nBand: 90, errors: 10, certified: false, lttPass: false });
    expect(by2.get(0.7)!.pass).toBe(false); // 10/120 errors > 5 allowed
    expect(by2.get(0.7)!.certified).toBe(false);
    expect(curve2.certifiedTau).toBe(0.95);
    expect(curve2.certifiedCoverage).toBeCloseTo(60 / 120, 12);
    expect(curve2.n).toBe(120);
    expect(curve2.primarySpecs).toEqual(['jev']);
    // The primary reference: at the real wake_triage cutoff 0.85 every primary noul 0.05 is in band; it parks all 120 and is wrong on the 10 'yes' rows.
    expect(curve2.primaryReference).toMatchObject({ threshold: 0.85, n: 120, correct: 110, coverage: 1 });
    expect(curve2.primaryReference.precision).toBeCloseTo(110 / 120, 12);
    // Ascending points, defaults carried.
    expect(curve2.points.map(p => p.tau)).toEqual([0.5, 0.7, 0.9, 0.95, 0.98]);
    expect(curve2).toMatchObject({ alpha: 0.1, delta: 0.05, margin: 0.03 });
  });

  it('a first leg that is WORSE than the primary on the band fails non-inferiority even when its own error rate clears α', () => {
    const pairs: CascadePair[] = [];
    // 300 band rows: first leg 15 wrong (5% — LTT passes: 21 allowed), primary right on ALL → d = 15, w = 0 → Δ = −0.05, lower bound < −0.03.
    for (let i = 0; i < 300; i++) pairs.push(pair(i, 0.05, i < 15 ? 0.9 : 0.05, i < 15 ? 'yes' : 'no'));
    const p = cascadePoint(pairs, 'wake_triage', 0.9, { alpha: 0.1, delta: 0.05, margin: 0.03 });
    expect(p).toMatchObject({ nBand: 300, errors: 15, errorsAllowed: 21, lttPass: true, d: 15, w: 0 });
    expect(p.delta).toBeCloseTo(-0.05, 12);
    expect(p.deltaLower95).toBeCloseTo(-15 / 300, 12); // w = 0 → Wilson lower of 0/15 is 0 → Δ_lower = −d/n
    expect(p.nonInferior).toBe(false);
    expect(p.pass).toBe(false);
    expect(cascadePoint(pairs, 'wake_triage', 0.9, { alpha: 0.1, delta: 0.05, margin: 0.05 }).nonInferior).toBe(true);
  });
});

// ── pairing from loop_metrics rows ───────────────────────────────────────────

const dRow = (id: string, backendSpec: string, answers: any, extra: any = {}, at = '2026-09-26T00:00:00Z'): DecisionGateRow =>
  ({ meta: { phase: 'decision', id, purpose: 'wake_triage', backend: backendSpec, backendSpec, ok: true, answers, ...extra }, createdAt: new Date(at) });
const cRow = (primaryId: string, n: number, backendSpec: string, answers: any, extra: any = {}): DecisionGateRow =>
  dRow(`${primaryId}~c${n}`, backendSpec, answers, { challenger: true, primaryId, ...extra });
const oRow = (id: string, actual: any, extra: any = {}): DecisionGateRow =>
  ({ meta: { phase: 'outcome', id, purpose: 'wake_triage', question: 'needs_turn_now', actual, acted: false, ...extra }, createdAt: new Date('2026-09-26T00:01:00Z') });

describe('pairCascadeRows — primary ↔ challenger ↔ outcome', () => {
  it('pairs a labelled primary row with the first leg\'s challenger row by primaryId; skips acted / unlabelled / memo-hit / other-purpose rows; the primary as first leg is a degenerate pair', () => {
    const rows: DecisionGateRow[] = [
      dRow('a', 'jev', { needs_turn_now: { noul: 0.1 } }, { stateHash: 'h1' }),
      cRow('a', 0, 'cql:agx-laya', { needs_turn_now: { noul: 0.2 } }),
      oRow('a', false),
      oRow('a~c0', false, { challenger: true, primaryId: 'a', backendSpec: 'cql:agx-laya', predicted: { noul: 0.2 } }),
      // b: labelled but the first leg never answered (a different challenger) → unpaired.
      dRow('b', 'jev', { needs_turn_now: { noul: 0.3 } }, { stateHash: 'h2' }),
      cRow('b', 0, 'deepseek-flash', { needs_turn_now: { noul: 0.4 } }),
      oRow('b', true),
      // c: acted → no label.
      dRow('c', 'jev', { needs_turn_now: { noul: 0.05 } }, { stateHash: 'h3' }),
      cRow('c', 0, 'cql:agx-laya', { needs_turn_now: { noul: 0.05 } }),
      oRow('c', null, { acted: true }),
      // d: a memo hit (cached) → skipped even with a label.
      dRow('d', 'jev', { needs_turn_now: { noul: 0.1 } }, { cached: true, stateHash: 'h4' }),
      oRow('d', false),
      // e: another purpose.
      { meta: { phase: 'decision', id: 'e', purpose: 'auto_route', backend: 'jev', backendSpec: 'jev', ok: true, answers: { level: { choice: 'thinking', confidence: 0.9 } } }, createdAt: new Date() },
      { meta: { phase: 'outcome', id: 'e', purpose: 'auto_route', question: 'level', actual: 'thinking', acted: false }, createdAt: new Date() },
      // f: the first leg IS the primary (a promoted Laya) → degenerate pair.
      dRow('f', 'cql:agx-laya', { needs_turn_now: { noul: 0.1 } }, { stateHash: 'h5' }),
      oRow('f', false),
    ];
    const { pairs, stats } = pairCascadeRows(rows, { purpose: 'wake_triage', first: 'cql:agx-laya' });
    expect(pairs.map(p => p.id)).toEqual(['a', 'f']);
    expect(pairs[0]).toMatchObject({ first: { noul: 0.2 }, primary: { noul: 0.1 }, actual: 'no', primarySpec: 'jev', stateKey: 'h1', degenerate: false, fromOutcomePredicted: false });
    expect(pairs[1]).toMatchObject({ first: { noul: 0.1 }, primary: { noul: 0.1 }, degenerate: true, primarySpec: 'cql:agx-laya' });
    expect(stats).toEqual({ primaryRows: 4, firstRows: 3, labelled: 3, paired: 2, deduped: 0, degenerate: 1 });
  });

  it('falls back to the challenger OUTCOME row\'s predicted when its decision row is outside the window; dedupes (question, stateHash) keeping the earliest', () => {
    const rows: DecisionGateRow[] = [
      dRow('a', 'jev', { needs_turn_now: { noul: 0.1 } }, { stateHash: 'same' }, '2026-09-26T00:00:00Z'),
      oRow('a', false),
      oRow('a~c0', false, { challenger: true, primaryId: 'a', backendSpec: 'cql:agx-laya', predicted: { noul: 0.25 } }),
      dRow('a2', 'jev', { needs_turn_now: { noul: 0.15 } }, { stateHash: 'same' }, '2026-09-26T01:00:00Z'), // the busy re-ask
      cRow('a2', 0, 'cql:agx-laya', { needs_turn_now: { noul: 0.3 } }),
      oRow('a2', false),
    ];
    const { pairs, stats } = pairCascadeRows(rows, { purpose: 'wake_triage', first: 'cql:agx-laya' });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ id: 'a', first: { noul: 0.25 }, fromOutcomePredicted: true });
    expect(stats.deduped).toBe(1);
  });

  it('applies the per-(spec, purpose) temperature from the temps map: logits from meta.logits when present, else log p from the probabilities; an already-tempered row is used as is', () => {
    const rows: DecisionGateRow[] = [
      dRow('a', 'jev', { needs_turn_now: { noul: 0.2 } }, { stateHash: 'h1' }),
      // The challenger's compact answer carries probabilities on a choice; no logits.
      cRow('a', 0, 'cql:agx-laya', { needs_turn_now: { noul: 0.1 } }),
      oRow('a', false),
    ];
    const { pairs } = pairCascadeRows(rows, { purpose: 'wake_triage', first: 'cql:agx-laya', temps: { 'cql:agx-laya|wake_triage': 2, 'jev|wake_triage': 1 } });
    // noul 0.1 → logits {no: log 0.9, yes: log 0.1}; at T = 2: softmax(log p / 2) → yes = √0.1 / (√0.9 + √0.1) ≈ 0.25.
    const yes = Math.sqrt(0.1) / (Math.sqrt(0.9) + Math.sqrt(0.1));
    expect(pairs[0].first.noul).toBeCloseTo(yes, 9);
    expect(pairs[0].primary.noul).toBe(0.2);
    // temperedView: an already-tempered row is untouched; explicit logits win over the derived ones; T = 1 is identity.
    expect(temperedView({ noul: 0.1 }, undefined, 2, true)).toEqual({ noul: 0.1 });
    expect(temperedView({ noul: 0.1 }, undefined, 1, false)).toEqual({ noul: 0.1 });
    expect(temperedView({ noul: 0.1 }, { no: 0, yes: 0 }, 2, false)).toEqual({ noul: 0.5 });
    const choice = temperedView({ choice: 'a', confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } }, undefined, 2, false)!;
    expect(choice.choice).toBe('a');
    expect(choice.confidence).toBeCloseTo(Math.sqrt(0.8) / (Math.sqrt(0.8) + Math.sqrt(0.2)), 9);
    const score = temperedView({ score: 0.2, confidence: 0.8, probabilities: { 0: 0.8, 1: 0.2 } }, undefined, 2, false)!;
    expect(score.score).toBeCloseTo(Math.sqrt(0.2) / (Math.sqrt(0.8) + Math.sqrt(0.2)), 9);
  });
});

describe('formatCascadeTable', () => {
  it('prints the header, the 0.05 grid rows, the certified τ and an honest verdict that names the absence of an act-path cascade', () => {
    const pairs: CascadePair[] = [];
    for (let i = 0; i < 100; i++) pairs.push(pair(i, 0.02, 0.05, 'no'));
    const curve = cascadeCurve(pairs, { purpose: 'wake_triage', first: 'cql:agx-laya', margin: 0.03, stats: { primaryRows: 100, firstRows: 100, labelled: 100, paired: 100, deduped: 0, degenerate: 0 } });
    const text = formatCascadeTable(curve);
    expect(text).toContain('purpose wake_triage, first leg cql:agx-laya, primary jev, 100 paired labelled rows');
    expect(text).toContain('pairing: 100 primary rows');
    expect(text).toContain('LTT exact binomial α=0.1 (risk) δ=0.05 (level), fixed-sequence strict→loose; non-inferiority Δ_lower ≥ −0.03');
    for (const t of ['0.50', '0.55', '0.90', '0.95', '0.99']) expect(text).toMatch(new RegExp(`\\n\\s+${t.replace('.', '\\.')}\\s`));
    // Certified from 0.98 down to 0.50 (every band = all 100 rows, 0 errors, d = 0) — except 0.99 (empty band).
    expect(curve.certifiedTau).toBeNull(); // 0.99 fails first → nothing certified under strict → loose
    expect(text).toContain('VERDICT: no τ is certified');
    expect(text).toContain('NO act-path cascade exists');
    const curve2 = cascadeCurve(pairs, { purpose: 'wake_triage', first: 'cql:agx-laya', margin: 0.03, taus: cascadeTaus().filter(t => t < 0.99) });
    expect(curve2.certifiedTau).toBe(0.5);
    const text2 = formatCascadeTable(curve2);
    expect(text2).toContain('VERDICT: certified down to τ=0.50 → the first leg could answer 100.0% of asks');
    expect(text2).toContain('NO act-path cascade exists yet');
  });
});

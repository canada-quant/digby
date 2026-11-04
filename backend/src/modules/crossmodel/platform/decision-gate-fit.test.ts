/**
 * decision-gate-fit.ts — the readout temperature fit (WI-I, 2026-09-25):
 * actual → option-key mapping, the NLL/Brier/ECE metrics, the fit itself
 * on a synthetic logit gap, and the loop_metrics row pairing.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' }, recordLoopMetric: jest.fn() }));

import { distributionFromLogits } from './decision-gate';
import { wilsonInterval } from './decision-gate-math';
import {
  ACT_POLICIES, READINESS_BARS,
  actBand, actBandStats, actKeyMatches, actualToKey, auroc, buildReadinessReport, coverageAtError, ece, fitTemperature, meanBrier, meanNll,
  outcomeLabelEntersFit, OUTCOME_LABEL_FOR_FIT, pairDecisionRows, pairReadinessRows, purposeCutoff, readinessMetrics, readinessVerdict, searchThreshold, stateHashOf, suggestedEnvLine,
  // cp/labels 2026-09-26 — the secondary-label fallback (compute_policy facts as the window-closed negative)
  OUTCOME_LABEL_FALLBACK_FOR_FIT, outcomeRowEntersFit, primaryLabelledKeys,
  // audit 2026-09-26 (telemetry-readiness-8) — the act-question filter on the offline fit / ruler
  fitAdmitsQuestion, fitPoolsQuestions, isActQuestionOf,
  // 2026-09-26 (audit) — the sender-segment partition
  NON_HUMAN_SEGMENTS, partitionSegmentOfRow,
  // 2026-09-26 — backend identity + the per-backend comparison
  LEGACY_BACKEND_LABEL_SPECS, backendKindOfRow, backendSpecOfRow, backendTempStoreKey, backendTemperatureFittedIn, groupCalibrated, legErrorLabel, logitsFromAnswers, percentile,
  type ActBandStats, type FitSample, type ReadinessMetrics, type ReadinessRow, type ReadinessSample,
} from './decision-gate-fit';

describe('actualToKey', () => {
  it('maps a noul boolean / "true" string to yes|no, a score level to its index string, a choice key to itself', () => {
    expect(actualToKey(true)).toBe('yes');
    expect(actualToKey(false)).toBe('no');
    expect(actualToKey('TRUE')).toBe('yes');
    expect(actualToKey(2)).toBe('2');
    expect(actualToKey(1.6)).toBe('2');
    expect(actualToKey('billing')).toBe('billing');
    expect(actualToKey(null)).toBeNull();
    expect(actualToKey('')).toBeNull();
  });
});

/** Synthetic over-confident readout: a calibrated gap of ±2.4 nats reported at ×4 sharpness. */
function synthetic(n: number, seed = 7): FitSample[] {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const out: FitSample[] = [];
  for (let i = 0; i < n; i++) {
    const trueGap = (rnd() * 2 - 1) * 2.4; // yes − no in nats, calibrated
    const pYes = 1 / (1 + Math.exp(-trueGap));
    const actual = rnd() < pYes ? 'yes' : 'no';
    // The model reports the gap 4× too sharp (T* = 4 restores calibration).
    const reported = trueGap * 4;
    out.push({ logits: { no: -Math.log1p(Math.exp(reported)), yes: -Math.log1p(Math.exp(-reported)) }, actual });
  }
  return out;
}

describe('fitTemperature', () => {
  it('recovers the sharpness factor on a synthetic logit gap and yields GRADED probabilities strictly inside (0, 1)', () => {
    const samples = synthetic(2000);
    const fit = fitTemperature(samples);
    expect(fit.n).toBe(2000);
    expect(fit.temperature).toBeGreaterThan(3);
    expect(fit.temperature).toBeLessThan(5.5);
    expect(fit.nllAtT).toBeLessThan(fit.nllAt1);
    expect(fit.brierAtT).toBeLessThan(fit.brierAt1);
    expect(fit.eceAtT).toBeLessThan(fit.eceAt1);
    expect(fit.accuracy).toBeGreaterThan(0.6);
    // The saturated prod shape (noul exactly 0/1 at T=1) is graded under the fit.
    const p = distributionFromLogits(samples[0].logits, ['no', 'yes'], fit.temperature);
    expect(p.yes).toBeGreaterThan(0);
    expect(p.yes).toBeLessThan(1);
    expect(suggestedEnvLine('wake_triage', fit.temperature)).toBe(`DECISION_GATE_TEMP_WAKE_TRIAGE=${fit.temperature}`);
  });

  it('stays at the clamp edges rather than running away: a perfectly-predicted set fits to the floor, a useless set to the ceiling', () => {
    const perfect: FitSample[] = Array.from({ length: 40 }, (_, i) => ({ logits: { no: i % 2 ? -0.01 : -5, yes: i % 2 ? -5 : -0.01 }, actual: i % 2 ? 'no' : 'yes' }));
    expect(fitTemperature(perfect).temperature).toBeCloseTo(0.7, 2);
    const useless: FitSample[] = Array.from({ length: 40 }, (_, i) => ({ logits: { no: -0.01, yes: -5 }, actual: i % 2 ? 'no' : 'yes' }));
    expect(fitTemperature(useless).temperature).toBeCloseTo(10, 1);
  });

  it('skips samples whose actual is not among the logits and reports n=0 for nothing usable', () => {
    const fit = fitTemperature([{ logits: { no: -0.1 }, actual: 'yes' }, { logits: { no: -0.1, yes: -2 }, actual: 'yes' }]);
    expect(fit.n).toBe(1);
    expect(fit.skipped).toBe(1);
    const empty = fitTemperature([]);
    expect(empty.n).toBe(0);
    expect(empty.temperature).toBe(1);
    expect(Number.isNaN(empty.nllAt1)).toBe(true);
  });

  it('metrics are finite and bounded on a tiny hand set', () => {
    const s: FitSample[] = [{ logits: { no: -2.3, yes: -0.1 }, actual: 'yes' }, { logits: { no: -0.1, yes: -2.3 }, actual: 'yes' }];
    expect(meanNll(s, 1)).toBeGreaterThan(0);
    expect(meanBrier(s, 1)).toBeGreaterThan(0);
    expect(ece(s, 1)).toBeGreaterThanOrEqual(0);
    expect(ece(s, 1)).toBeLessThanOrEqual(1);
  });
});

describe('pairDecisionRows', () => {
  it('joins decision rows (meta.logits) with outcome rows by id + question, keyed by (backend, purpose); skips systemone rows and null actuals', () => {
    const rows = [
      { meta: { phase: 'decision', id: 'a1', purpose: 'wake_triage', backend: 'DeepSeek logprob readout', logits: { needs_turn_now: { no: -0.01, yes: -4.6 } } } },
      { meta: { phase: 'outcome', id: 'a1', purpose: 'wake_triage', question: 'needs_turn_now', actual: false } },
      { meta: { phase: 'decision', id: 'a2', purpose: 'wake_triage', backend: 'DeepSeek logprob readout', logits: { needs_turn_now: { no: -0.7, yes: -0.7 } } } },
      { meta: { phase: 'outcome', id: 'a2', purpose: 'wake_triage', question: 'needs_turn_now', actual: null } }, // shadow with no actual — unusable
      { meta: { phase: 'decision', id: 'j1', purpose: 'wake_triage', backend: 'TypeSafe Jev' } }, // no logits
      { meta: { phase: 'outcome', id: 'j1', purpose: 'wake_triage', question: 'needs_turn_now', actual: true } },
      { meta: { phase: 'decision', id: 'b1', purpose: 'browser_driver', backend: 'DeepSeek logprob readout', logits: { driver: { cloud: -0.2, local: -1.7 } } } },
      { meta: { phase: 'outcome', id: 'b1', purpose: 'browser_driver', question: 'driver', actual: 'local' } },
    ];
    const groups = pairDecisionRows(rows);
    expect(groups.map(g => `${g.purpose}/${g.backend}/${g.samples.length}`)).toEqual([
      'browser_driver/DeepSeek logprob readout/1',
      'wake_triage/DeepSeek logprob readout/1',
    ]);
    expect(groups[1].samples[0]).toEqual({ logits: { no: -0.01, yes: -4.6 }, actual: 'no' });
    expect(groups[0].samples[0].actual).toBe('local');
  });

  it('a multi-label purpose contributes ONLY its OUTCOME_LABEL_FOR_FIT row (tool_intent: regex, never next_call); unlabelled rows always pass', () => {
    expect(OUTCOME_LABEL_FOR_FIT.tool_intent).toBe('regex');
    expect(outcomeLabelEntersFit('tool_intent', 'regex')).toBe(true);
    expect(outcomeLabelEntersFit('tool_intent', 'next_call')).toBe(false);
    expect(outcomeLabelEntersFit('tool_intent', undefined)).toBe(true);
    expect(outcomeLabelEntersFit('wake_triage', 'anything')).toBe(true);
    const logits = { intended_tool: { option_1: -0.05, option_2: -3.0 } };
    const rows = [
      { meta: { phase: 'decision', id: 't1', purpose: 'tool_intent', backend: 'DeepSeek logprob readout', logits } },
      { meta: { phase: 'outcome', id: 't1', purpose: 'tool_intent', question: 'intended_tool', actual: 'option_1', label: 'regex' } },
      { meta: { phase: 'outcome', id: 't1', purpose: 'tool_intent', question: 'intended_tool', actual: 'option_2', label: 'next_call' } },
      { meta: { phase: 'decision', id: 't2', purpose: 'tool_intent', backend: 'DeepSeek logprob readout', logits } },
      { meta: { phase: 'outcome', id: 't2', purpose: 'tool_intent', question: 'intended_tool', actual: 'option_2', label: 'next_call' } }, // the regex row never landed
    ];
    const groups = pairDecisionRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].samples).toEqual([{ logits: logits.intended_tool, actual: 'option_1' }]);
  });
});

/* E1 (2026-09-25): the flip-readiness report — the act-cutoff policies, the
 * paper's metrics (AUROC of 1−confidence, risk–coverage, act-band precision),
 * pairing that finally covers TypeSafe Jev rows, dedupe / partition, the
 * frozen-policy threshold search and the READY / NOT READY verdict. */
describe('flip readiness (E1)', () => {
  it('purposeCutoff / actBand mirror the consumers: noul_low acts at noul ≤ 1−τ, choice_high at confidence ≥ τ; env override clamped like decisionThreshold', () => {
    expect(Object.keys(ACT_POLICIES).sort()).toEqual(['auto_route', 'browser_driver', 'checker_route', 'claim_evidenced', 'coding_memory_fold', 'compute_policy', 'delta_material', 'drafts_agree', 'drain_triage', 'firing_superseded', 'guard_strike', 'imessage_send', 'memory_extract', 'reflection_route', 'revision_material', 'self_audit', 'session_topology', 'supervisor_turn_noop', 'sweep_triage', 'task_kind', 'tool_intent', 'turn_plan', 'wake_effort', 'wake_triage']);
    expect(purposeCutoff('guard_strike')).toBe(0.9);
    expect(actBand('guard_strike', { choice: 'false_positive', confidence: 0.9 })).toEqual({ inBand: true, threshold: 0.9, actKey: 'false_positive' });
    expect(purposeCutoff('sweep_triage')).toBe(0.85);
    expect(actBand('sweep_triage', { noul: 0.15 })).toEqual({ inBand: true, threshold: 0.85, actKey: 'no' });
    expect(actBand('sweep_triage', { noul: 0.2 }).inBand).toBe(false);
    expect(purposeCutoff('checker_route')).toBe(0.7);
    expect(actBand('checker_route', { choice: 'simple_lookup', confidence: 0.7 })).toEqual({ inBand: true, threshold: 0.7, actKey: 'simple_lookup' });
    // Audit 2026-09-26 (settings-switches-1): a BLANK env is unset (never 0 → 0.5); the per-OPTION env the act site
    // reads wins over the generic one, so thresholdUsed / the ruler measure the cutoff the act site actually uses.
    expect(purposeCutoff('auto_route', { DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH: '' }, 'deep_research')).toBe(0.85);
    expect(purposeCutoff('auto_route', { DECISION_GATE_THRESHOLD_AUTO_ROUTE: '' })).toBe(0.7);
    expect(purposeCutoff('auto_route', { DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH: '0.75' }, 'deep_research')).toBe(0.75);
    expect(purposeCutoff('auto_route', { DECISION_GATE_THRESHOLD_AUTO_ROUTE: '0.6' }, 'deep_research')).toBe(0.85); // the generic env never lowers the L3 floor
    expect(purposeCutoff('compute_policy', { DECISION_GATE_THRESHOLD_COMPUTE_POLICY_CONTESTABLE: '0.75' }, 'contestable')).toBe(0.75);
    // N9 (2026-09-25): a score_low purpose acts on the LOW levels only (round(score) ≤ maxScore at confidence ≥ τ); acting is right for every actual level ≤ maxScore.
    expect(purposeCutoff('wake_effort')).toBe(0.9);
    expect(actBand('wake_effort', { score: 0.6, confidence: 0.95 })).toEqual({ inBand: true, threshold: 0.9, actKey: '1', actKeys: ['0', '1'] });
    expect(actBand('wake_effort', { score: 1.6, confidence: 0.95 }).inBand).toBe(false);
    expect(actBand('wake_effort', { score: 0, confidence: 0.8 }).inBand).toBe(false);
    expect(actKeyMatches(actBand('wake_effort', { score: 0, confidence: 0.95 }), '1')).toBe(true);
    expect(actKeyMatches(actBand('wake_effort', { score: 0, confidence: 0.95 }), '2')).toBe(false);
    expect(actKeyMatches(actBand('wake_triage', { noul: 0.05 }), 'yes')).toBe(false);
    expect(actKeyMatches(actBand('wake_triage', { noul: 0.05 }), 'no')).toBe(true);
    expect(purposeCutoff('wake_triage')).toBe(0.85);
    expect(purposeCutoff('memory_extract')).toBe(0.8);
    expect(purposeCutoff('auto_route')).toBe(0.7);
    expect(purposeCutoff('auto_route', {}, 'deep_research')).toBe(0.85);
    expect(purposeCutoff('browser_driver', { DECISION_GATE_THRESHOLD_BROWSER_DRIVER: '0.3' })).toBe(0.5);
    expect(purposeCutoff('wake_triage', { DECISION_GATE_THRESHOLD_WAKE_TRIAGE: '0.9' })).toBe(0.9);
    expect(purposeCutoff('unknown_purpose')).toBe(0.85);
    expect(actBand('wake_triage', { noul: 0.15 })).toEqual({ inBand: true, threshold: 0.85, actKey: 'no' });
    expect(actBand('wake_triage', { noul: 0.16 }).inBand).toBe(false);
    expect(actBand('memory_extract', { noul: 0.2 }).inBand).toBe(true);
    expect(actBand('imessage_send', { noul: 0.15 }, { DECISION_GATE_THRESHOLD_IMESSAGE_SEND: '0.9' }).inBand).toBe(false);
    expect(actBand('auto_route', { choice: 'thinking', confidence: 0.7 })).toEqual({ inBand: true, threshold: 0.7, actKey: 'thinking' });
    expect(actBand('auto_route', { choice: 'deep_research', confidence: 0.8 })).toMatchObject({ inBand: false, threshold: 0.85 });
    expect(actBand('auto_route', { choice: 'deep_research', confidence: 0.85 }).inBand).toBe(true);
    expect(actBand('wake_triage', { noul: 0.3 }, {}, 0.6)).toMatchObject({ inBand: true, threshold: 0.6 });
    expect(actBand('nope', { noul: 0 }).inBand).toBe(false);
    expect(actBand('wake_triage', null).inBand).toBe(false);
  });

  it('auroc: perfect separation 1, inverted 0, all ties 0.5, one class NaN, a mixed hand case 0.75', () => {
    expect(auroc([0.9, 0.8, 0.2, 0.1], [true, true, false, false])).toBe(1);
    expect(auroc([0.1, 0.2, 0.8, 0.9], [true, true, false, false])).toBe(0);
    expect(auroc([0.5, 0.5, 0.5, 0.5], [true, false, true, false])).toBe(0.5);
    expect(Number.isNaN(auroc([0.5, 0.6], [true, true]))).toBe(true);
    expect(Number.isNaN(auroc([], []))).toBe(true);
    // positives at 0.9 and 0.6 vs negatives at 0.7 and 0.3: wins 0.9>0.7, 0.9>0.3, 0.6>0.3; loss 0.6<0.7 → 3/4
    expect(auroc([0.9, 0.7, 0.6, 0.3], [true, false, true, false])).toBe(0.75);
  });

  it('coverageAtError: the largest confidence prefix with error ≤ the bound, ties never split, 0 when the top row errs', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ confidence: 1 - i / 100, agreed: i !== 50 && i !== 90 }));
    expect(coverageAtError(rows, 0.05).coverage).toBe(1); // 2/100 errors overall
    const zero = coverageAtError(rows, 0);
    expect(zero.coverage).toBe(0.5); // the error-free prefix is the 50 most confident rows
    expect(zero.threshold).toBeCloseTo(0.51, 6);
    expect(zero).toMatchObject({ n: 50, errors: 0 });
    expect(coverageAtError([{ confidence: 0.99, agreed: false }, { confidence: 0.5, agreed: true }], 0.05)).toMatchObject({ coverage: 0, threshold: null });
    const tied = [{ confidence: 0.9, agreed: true }, { confidence: 0.9, agreed: false }, { confidence: 0.1, agreed: true }];
    expect(coverageAtError(tied, 0.05).coverage).toBe(0); // the tie block carries the error, so it cannot be cut inside
    expect(coverageAtError([], 0.05)).toEqual({ coverage: 0, threshold: null, n: 0, errors: 0 });
  });

  const decisionRow = (id: string, purpose: string, backend: string, answers: any, extra: any = {}, at = '2026-09-20T00:00:00Z', sessionId?: string): ReadinessRow =>
    ({ meta: { phase: 'decision', id, purpose, backend, ...(answers ? { answers } : {}), ...extra }, createdAt: new Date(at), ...(sessionId ? { sessionId } : {}) });
  const outcomeRow = (id: string, purpose: string, question: string, actual: any, extra: any = {}): ReadinessRow =>
    ({ meta: { phase: 'outcome', id, purpose, question, actual, acted: false, ...extra }, createdAt: new Date('2026-09-21T00:00:00Z') });

  it('pairReadinessRows pairs Jev rows via meta.answers, readout rows via meta.logits, orphan outcomes via meta.predicted; drops acted / unlabelled rows; dedupes by stateHash keeping the earliest', () => {
    const rows: ReadinessRow[] = [
      decisionRow('j1', 'wake_triage', 'TypeSafe Jev', { needs_turn_now: { noul: 0.07 } }, { stateHash: 'h-a', questionsHash: 'q1' }, '2026-09-20T00:00:00Z', 'chat-1'),
      outcomeRow('j1', 'wake_triage', 'needs_turn_now', true, { agreed: false }),
      decisionRow('j2', 'wake_triage', 'TypeSafe Jev', { needs_turn_now: { noul: 0.09 } }, { stateHash: 'h-a', questionsHash: 'q1' }, '2026-09-20T01:00:00Z', 'chat-1'), // the busy re-ask of j1's state
      outcomeRow('j2', 'wake_triage', 'needs_turn_now', false),
      decisionRow('j3', 'wake_triage', 'TypeSafe Jev', { needs_turn_now: { noul: 0.9 } }, { stateText: 'unique state', questionsHash: 'q1' }, '2026-09-22T00:00:00Z', 'chat-2'),
      outcomeRow('j3', 'wake_triage', 'needs_turn_now', true),
      decisionRow('r1', 'wake_triage', 'DeepSeek logprob readout', undefined, { logits: { needs_turn_now: { no: -0.01, yes: -4.6 } } }),
      outcomeRow('r1', 'wake_triage', 'needs_turn_now', false),
      decisionRow('c1', 'auto_route', 'TypeSafe Jev', { level: { choice: 'thinking', confidence: 0.8, probabilities: { thinking: 0.8, single_thinking: 0.2 } } }),
      outcomeRow('c1', 'auto_route', 'level', 'thinking'),
      outcomeRow('orphan', 'imessage_send', 'send', false, { backend: 'TypeSafe Jev', predicted: { noul: 0.02 }, confidence: 0.98 }), // decision row outside the window
      decisionRow('a1', 'wake_triage', 'TypeSafe Jev', { needs_turn_now: { noul: 0.05 } }),
      outcomeRow('a1', 'wake_triage', 'needs_turn_now', null, { acted: true }),
      decisionRow('u1', 'wake_triage', 'TypeSafe Jev', { needs_turn_now: { noul: 0.5 } }),
      outcomeRow('u1', 'wake_triage', 'needs_turn_now', null),
    ];
    const groups = pairReadinessRows(rows);
    expect(groups.map(g => `${g.purpose}/${g.backend}/${g.samples.length}`)).toEqual([
      'auto_route/TypeSafe Jev/1',
      'imessage_send/TypeSafe Jev/1',
      'wake_triage/TypeSafe Jev/2',
      'wake_triage/DeepSeek logprob readout/1',
    ]);
    const wt = groups[2];
    expect(wt.deduped).toBe(1);
    expect(wt.undedupable).toBe(0);
    expect(wt.samples.map(s => s.id)).toEqual(['j1', 'j3']);
    expect(wt.samples[0]).toMatchObject({ predictedKey: 'no', actual: 'yes', agreed: false, sessionId: 'chat-1', stateKey: 'h-a', questionsHash: 'q1' });
    expect(wt.samples[0].confidence).toBeCloseTo(0.93, 9);
    expect(wt.samples[1]).toMatchObject({ predictedKey: 'yes', actual: 'yes', agreed: true, stateKey: stateHashOf('unique state') });
    expect(groups[3].samples[0]).toMatchObject({ predictedKey: 'no', actual: 'no', agreed: true });
    expect(groups[3].undedupable).toBe(1);
    expect(groups[0].samples[0]).toMatchObject({ predictedKey: 'thinking', actual: 'thinking', confidence: 0.8, agreed: true });
    expect(groups[0].samples[0].predicted.probabilities).toEqual({ thinking: 0.8, single_thinking: 0.2 });
    expect(groups[1].samples[0]).toMatchObject({ id: 'orphan', predictedKey: 'no', actual: 'no', confidence: 0.98, questionsHash: '' });
  });

  it('pairReadinessRows keeps one outcome label per multi-label purpose explicitly (tool_intent regex), regardless of write order', () => {
    const answers = { intended_tool: { choice: 'option_1', confidence: 0.9, probabilities: { option_1: 0.9, option_2: 0.1 } } };
    const rows: ReadinessRow[] = [
      decisionRow('t1', 'tool_intent', 'TypeSafe Jev', answers, { stateHash: 'h-t1', questionsHash: 'q2' }),
      outcomeRow('t1', 'tool_intent', 'intended_tool', 'option_2', { label: 'next_call' }), // lands first here — must NOT win
      outcomeRow('t1', 'tool_intent', 'intended_tool', 'option_1', { label: 'regex' }),
      decisionRow('t2', 'tool_intent', 'TypeSafe Jev', answers, { stateHash: 'h-t2', questionsHash: 'q2' }),
      outcomeRow('t2', 'tool_intent', 'intended_tool', 'option_2', { label: 'next_call' }), // a decision whose regex row never landed contributes nothing
    ];
    const groups = pairReadinessRows(rows);
    expect(groups.map(g => `${g.purpose}/${g.backend}/${g.samples.length}`)).toEqual(['tool_intent/TypeSafe Jev/1']);
    expect(groups[0].samples[0]).toMatchObject({ id: 't1', predictedKey: 'option_1', actual: 'option_1', agreed: true });
    expect(groups[0].deduped).toBe(0);
  });

  /** A deterministic wake_triage-shaped set: 150 rows at noul 0.05 (5 errors), 100 at 0.95 (3 errors), 50 at 0.4 (25 errors), over 5 days, 10 sessions. */
  function readyShaped(): ReadinessSample[] {
    const t0 = Date.parse('2026-09-20T00:00:00Z');
    const out: ReadinessSample[] = [];
    const push = (noul: number, actual: 'yes' | 'no', i: number) => {
      const predictedKey = noul >= 0.5 ? 'yes' : 'no';
      out.push({ id: `s${out.length}`, question: 'needs_turn_now', predicted: { noul }, predictedKey, confidence: Math.max(noul, 1 - noul), actual, agreed: predictedKey === actual, sessionId: `chat-${i % 10}`, at: t0 + Math.floor((out.length / 300) * 5 * 86_400_000), stateKey: `h${out.length}`, questionsHash: 'q1', acted: false });
    };
    for (let i = 0; i < 150; i++) push(0.05, i < 5 ? 'yes' : 'no', i);
    for (let i = 0; i < 100; i++) push(0.95, i < 3 ? 'no' : 'yes', i);
    for (let i = 0; i < 50; i++) push(0.4, i < 25 ? 'yes' : 'no', i);
    return out;
  }

  it('actBandStats at the REAL cutoff; AUROC / coverage / verdict on the hand-checkable shaped set → READY', () => {
    const samples = readyShaped();
    const band = actBandStats(samples, 'wake_triage');
    expect(band).toMatchObject({ n: 150, correct: 145, threshold: 0.85 });
    expect(band.precision).toBeCloseTo(145 / 150, 9);
    expect(band.coverage).toBeCloseTo(0.5, 9);
    // At τ=0.5 (the old ruler) the band would swallow the 0.4-noul rows too.
    expect(actBandStats(samples, 'wake_triage', {}, 0.5).n).toBe(200);
    const m = readinessMetrics({ backend: 'TypeSafe Jev', purpose: 'wake_triage', samples, deduped: 7, undedupable: 0 });
    expect(m.n).toBe(300);
    expect(m.days).toBeCloseTo(5 * 299 / 300, 3);
    expect(m.accuracy).toBeCloseTo(267 / 300, 9);
    // errors: 8 at confidence 0.95 (score 0.05), 25 at 0.6 (score 0.4); correct: 242 at 0.95, 25 at 0.6
    expect(m.auroc).toBeCloseTo((25 * 242 + 0.5 * 25 * 25 + 0.5 * 8 * 242) / (33 * 267), 9);
    expect(m.coverageAt5).toMatchObject({ n: 250, errors: 8, threshold: 0.95 });
    expect(m.coverageAt5.coverage).toBeCloseTo(250 / 300, 9);
    expect(m.positives).toBe(5 + 97 + 25);
    expect(m.partition).toBe('q1');
    expect(m.partitions).toEqual({ q1: 300 });
    expect(m.brier).toBeGreaterThan(0);
    expect(m.brier).toBeLessThan(0.25);
    expect(m.ece).toBeGreaterThanOrEqual(0);
    expect(readinessVerdict('wake_triage', m, true)).toEqual({ ready: true, reasons: [] });
    // The same numbers on an UNCALIBRATED readout are not enough.
    expect(readinessVerdict('wake_triage', m, false).reasons).toEqual(['backend is not calibrated (a logprob readout without a fitted DECISION_GATE_TEMP_<PURPOSE>)']);
  });

  // R&D exp #6 (2026-09-26): the Wilson LOWER bound is the readiness bar's
  // statistic — the incident-class twin of E12's act-period demotion fix
  // (6498712b6). A point estimate at the bar on the minimum band is one label
  // of noise and must NOT admit an act flip.
  it('act-band precision bar is the Wilson 95% LOWER bound: 19/20 at point 0.950 is NOT READY (LB 0.764); the boundary at n=200 is 189/200 (LB 0.904) vs 188/200 (LB 0.896)', () => {
    const m = readinessMetrics({ backend: 'TypeSafe Jev', purpose: 'wake_triage', samples: readyShaped(), deduped: 0, undedupable: 0 });
    const withBand = (b: ActBandStats): ReadinessMetrics => ({ ...m, actBand: b });
    // n = 19 is still the n-floor branch (not the precision branch).
    const band19 = { n: 19, correct: 19, precision: 1, lower95: wilsonInterval(19, 19).lower, coverage: 0.1, threshold: 0.85 };
    const v19 = readinessVerdict('wake_triage', withBand(band19), true);
    expect(v19.ready).toBe(false);
    expect(v19.reasons.some(r => r.startsWith('act-band rows 19 < 20'))).toBe(true);
    // n = 20 (the floor) with ONE miss: point 0.950 clears the old bar, the bound does not.
    const band20 = { n: 20, correct: 19, precision: 19 / 20, lower95: wilsonInterval(19, 20).lower, coverage: 0.1, threshold: 0.85 };
    expect(band20.precision).toBeGreaterThanOrEqual(0.9);   // the point estimate clears the old bar…
    expect(band20.lower95).toBeCloseTo(0.764, 2);            // …but the bound does not
    const v20 = readinessVerdict('wake_triage', withBand(band20), true);
    expect(v20.ready).toBe(false);
    expect(v20.reasons.some(r => r.startsWith('act-band precision Wilson 95% lower bound 0.764 (point 0.950 over n=20)'))).toBe(true);
    // At the n-floor-passing size the boundary is a Wilson question, not a point question:
    const at189 = { n: 200, correct: 189, precision: 189 / 200, lower95: wilsonInterval(189, 200).lower, coverage: 0.9, threshold: 0.85 };
    const at188 = { n: 200, correct: 188, precision: 188 / 200, lower95: wilsonInterval(188, 200).lower, coverage: 0.9, threshold: 0.85 };
    expect(at189.lower95).toBeGreaterThanOrEqual(0.9);
    expect(at188.lower95).toBeLessThan(0.9);
    expect(readinessVerdict('wake_triage', withBand(at189), true).reasons.join(' ')).not.toContain('act-band precision');
    const v188 = readinessVerdict('wake_triage', withBand(at188), true);
    expect(v188.ready).toBe(false);
    expect(v188.reasons.some(r => r.startsWith('act-band precision Wilson 95% lower bound 0.898 (point 0.940 over n=200)'))).toBe(true);
    // The 6498712b6 incident shape (42/47, point 0.894) scaled to a passing n is NOT READY either.
    expect(readinessVerdict('wake_triage', withBand({ n: 200, correct: 179, precision: 179 / 200, lower95: wilsonInterval(179, 200).lower, coverage: 0.9, threshold: 0.85 }), true).ready).toBe(false);
  });

  it('readinessVerdict names every missed bar (labels, span, act-band rows / precision, AUROC, coverage, imessage positives)', () => {
    const few = readinessMetrics({ backend: 'TypeSafe Jev', purpose: 'imessage_send', samples: readyShaped().slice(0, 30).map(s => ({ ...s, question: 'send', at: s.at })), deduped: 0, undedupable: 0 });
    const v = readinessVerdict('imessage_send', few, true);
    expect(v.ready).toBe(false);
    expect(v.reasons.some(r => r.startsWith('labels 30 < 200'))).toBe(true);
    expect(v.reasons.some(r => r.startsWith('span '))).toBe(true);
    expect(v.reasons.some(r => r.startsWith('labelled positive sends 5 < 30'))).toBe(true);
    // One-class labels → AUROC n/a is a missed bar, not a pass.
    const oneClass = readinessMetrics({ backend: 'TypeSafe Jev', purpose: 'delta_material', samples: readyShaped().slice(5, 150).map(s => ({ ...s, question: 'material' })), deduped: 0, undedupable: 0 });
    expect(readinessVerdict('delta_material', oneClass, true).reasons.some(r => r.startsWith('AUROC n/a'))).toBe(true);
    expect(readinessVerdict('mystery', few, true).reasons[0]).toBe('no act policy known for "mystery"');
  });

  // fixer 2026-09-27: a purpose that SKIPS work in act (supervisor_turn_noop) is judged on its heartbeat-floor
  // CONTROL rows once they exist — shadow-era band rows alone can never keep it READY after the flip.
  it('supervisor_turn_noop readiness: stricter bars (30 band rows at 0.95) and, once floor-turn control rows exist, their count and quiet-rate Wilson LB are bars too; other purposes ignore `controls`', () => {
    const m = readinessMetrics({ backend: 'TypeSafe Jev', purpose: 'supervisor_turn_noop', samples: readyShaped().map(s => ({ ...s, question: 'will_act' })), deduped: 0, undedupable: 0 });
    expect(m.controls).toBeUndefined(); // no control rows in the shaped set
    const perfect: ReadinessMetrics = { ...m, actBand: { n: 200, correct: 200, precision: 1, lower95: wilsonInterval(200, 200).lower, coverage: 0.5, threshold: 0.85 } };
    expect(readinessVerdict('supervisor_turn_noop', perfect, true)).toEqual({ ready: true, reasons: [] });
    // The purpose-specific bars: 29 band rows fail the 30 floor; 145/150 (LB 0.925) fails the 0.95 bar that wake_triage would pass.
    expect(readinessVerdict('supervisor_turn_noop', { ...perfect, actBand: { ...perfect.actBand, n: 29, correct: 29 } }, true).reasons.some(r => r.startsWith('act-band rows 29 < 30'))).toBe(true);
    const band = { n: 150, correct: 145, precision: 145 / 150, lower95: wilsonInterval(145, 150).lower, coverage: 0.5, threshold: 0.85 };
    expect(readinessVerdict('wake_triage', { ...perfect, actBand: band }, true).ready).toBe(true);
    expect(readinessVerdict('supervisor_turn_noop', { ...perfect, actBand: band }, true).reasons.some(r => r.includes('< 0.95 at τ=0.85'))).toBe(true);
    // Control rows: too few ⇒ named; enough but acting too often ⇒ named with the action rate; clean ⇒ silent.
    expect(readinessVerdict('supervisor_turn_noop', { ...perfect, controls: { n: 10, positives: 0 } }, true).reasons).toEqual(['floor-turn control rows 10 < 30 (act-period heartbeat turns)']);
    const noisy = readinessVerdict('supervisor_turn_noop', { ...perfect, controls: { n: 40, positives: 4 } }, true);
    expect(noisy.ready).toBe(false);
    expect(noisy.reasons).toHaveLength(1);
    expect(noisy.reasons[0]).toMatch(/^floor-turn action rate 4\/40 — quiet-rate Wilson 95% lower bound 0\.\d{3} < 0\.95$/);
    expect(readinessVerdict('supervisor_turn_noop', { ...perfect, controls: { n: 200, positives: 1 } }, true)).toEqual({ ready: true, reasons: [] });
    // A purpose outside PURPOSE_CONTROL_GATED never reads `controls`.
    expect(readinessVerdict('wake_triage', { ...perfect, controls: { n: 3, positives: 3 } }, true)).toEqual({ ready: true, reasons: [] });
  });

  it('two sites writing CONCURRENTLY under one purpose: the stamp measures whichever partition holds the newest row — so the checker site (N4) carries its own purpose and never shares auto_route\'s group', () => {
    // Router rows (question 'level') and checker-shaped rows (question 'depth')
    // interleaved in time under ONE purpose: readinessMetrics picks the
    // partition of the single newest sample — here the 'depth' one — so the
    // router's real evidence would be discarded (or the router admitted on
    // checker evidence). Pinned so nobody re-homes a second site on a purpose.
    const base = new Date('2026-09-20T00:00:00Z').getTime();
    const router = readyShaped().slice(0, 60).map((s, i) => ({ ...s, id: `r${i}`, question: 'level', questionsHash: 'q-level', at: base + i * 60_000 }));
    const checker = readyShaped().slice(0, 30).map((s, i) => ({ ...s, id: `c${i}`, question: 'depth', questionsHash: 'q-depth', at: base + i * 60_000 + 30_000 }));
    // The newest row overall is a router row → the router partition is measured.
    const routerLast = { ...router[59], id: 'r-last', at: base + 61 * 60_000 };
    const m1 = readinessMetrics({ backend: 'TypeSafe Jev', purpose: 'auto_route', samples: [...router, ...checker, routerLast], deduped: 0, undedupable: 0 });
    expect(m1.partition).toBe('q-level');
    expect(m1.partitions).toEqual({ 'q-level': 61, 'q-depth': 30 });
    // One later checker row flips the WHOLE verdict onto checker evidence.
    const checkerLast = { ...checker[29], id: 'c-last', at: base + 62 * 60_000 };
    const m2 = readinessMetrics({ backend: 'TypeSafe Jev', purpose: 'auto_route', samples: [...router, ...checker, routerLast, checkerLast], deduped: 0, undedupable: 0 });
    expect(m2.partition).toBe('q-depth');
    expect(m2.n).toBe(31);
    // With its own purpose the checker rows form their OWN group: pairing
    // keys on (backend, purpose), so auto_route's stamp never sees them.
    const rows: ReadinessRow[] = [
      decisionRow('a1', 'auto_route', 'TypeSafe Jev', { level: { choice: 'thinking', confidence: 0.8, probabilities: { thinking: 0.8 } } }, { questionsHash: 'q-level' }, '2026-09-20T00:00:00Z'),
      outcomeRow('a1', 'auto_route', 'level', 'thinking'),
      decisionRow('k1', 'checker_route', 'TypeSafe Jev', { depth: { choice: 'simple_lookup', confidence: 0.9, probabilities: { simple_lookup: 0.9 } }, needs_live_web: { noul: 0.1 } }, { questionsHash: 'q-depth' }, '2026-09-20T00:01:00Z'),
      outcomeRow('k1', 'checker_route', 'depth', 'simple_lookup'),
      outcomeRow('k1', 'checker_route', 'needs_live_web', false),
    ];
    const groups = pairReadinessRows(rows);
    // audit 2026-09-26: checker_route's needs_live_web row is NOT its act question ('depth') — counted in offQuestion, never in n
    expect(groups.map(g => `${g.purpose}/${g.samples.length}`)).toEqual(['auto_route/1', 'checker_route/1']);
    expect(groups[1].offQuestion).toBe(1);
    expect(readinessMetrics(groups[0]).partition).toBe('q-level');
    expect(readinessMetrics(groups[1]).partition).toBe('q-depth');
  });

  it('readinessMetrics judges the NEWEST questionsHash partition only (a question rewrite resets the clock)', () => {
    const old = readyShaped().map(s => ({ ...s, questionsHash: 'q0', at: s.at - 30 * 86_400_000 }));
    const fresh = readyShaped().slice(0, 40).map(s => ({ ...s, id: `n${s.id}` }));
    const m = readinessMetrics({ backend: 'TypeSafe Jev', purpose: 'wake_triage', samples: [...old, ...fresh], deduped: 0, undedupable: 0 });
    expect(m.partitions).toEqual({ q0: 300, q1: 40 });
    expect(m.partition).toBe('q1');
    expect(m.n).toBe(40);
  });

  it('searchThreshold: frozen-policy pick on a 60/40 time split with sessions kept whole, held-out numbers reported; null when no τ qualifies', () => {
    const samples = readyShaped();
    const s = searchThreshold(samples, 'wake_triage');
    expect(s).not.toBeNull();
    expect(s!.selection.n + s!.holdout.n).toBe(300);
    expect(s!.threshold).toBeGreaterThanOrEqual(0.5);
    expect(s!.threshold).toBeLessThanOrEqual(0.99);
    expect(s!.selection.band.precision).toBeGreaterThanOrEqual(READINESS_BARS.minActBandPrecision);
    expect(s!.selection.band.n).toBeGreaterThanOrEqual(10);
    // Sessions never straddle the split.
    expect(searchThreshold(samples.slice(0, 1), 'wake_triage')).toBeNull();
    const hopeless = samples.map(x => ({ ...x, actual: x.predictedKey === 'yes' ? 'no' : 'yes', agreed: false }));
    expect(searchThreshold(hopeless, 'wake_triage')).toBeNull();
  });

  it('buildReadinessReport end to end on loop_metrics-shaped rows: Jev entry READY, readout entry NOT READY (uncalibrated) unless DECISION_GATE_TEMP_<PURPOSE> is set', () => {
    const rows: ReadinessRow[] = [];
    for (const s of readyShaped()) {
      const at = new Date(s.at).toISOString();
      rows.push(decisionRow(s.id, 'wake_triage', 'TypeSafe Jev', { needs_turn_now: { noul: s.predicted.noul } }, { stateHash: s.stateKey, questionsHash: 'q1' }, at, s.sessionId));
      rows.push(outcomeRow(s.id, 'wake_triage', 'needs_turn_now', s.actual === 'yes'));
      rows.push(decisionRow(`r-${s.id}`, 'wake_triage', 'DeepSeek logprob readout', undefined, { logits: { needs_turn_now: s.predicted.noul! < 0.5 ? { no: -0.01, yes: -4.6 } : { no: -4.6, yes: -0.01 } }, stateHash: `r-${s.stateKey}`, questionsHash: 'q1' }, at, s.sessionId));
      rows.push(outcomeRow(`r-${s.id}`, 'wake_triage', 'needs_turn_now', s.actual === 'yes'));
    }
    const report = buildReadinessReport(rows);
    expect(report.map(r => `${r.backend}:${r.ready}:${r.calibrated}`)).toEqual(['TypeSafe Jev:true:true', 'DeepSeek logprob readout:false:false']);
    expect(report[0].metrics.actBand).toMatchObject({ n: 150, correct: 145 });
    expect(report[1].reasons[0]).toContain('not calibrated');
    const fitted = buildReadinessReport(rows, { env: { DECISION_GATE_TEMP_WAKE_TRIAGE: '3.2' }, purpose: 'wake_triage' });
    expect(fitted[1].calibrated).toBe(true);
    expect(buildReadinessReport(rows, { purpose: 'self_audit' })).toEqual([]);
  });
});

/* 2026-09-26 (open-weight decision backends, plan B + E): every grouping keys on
 * the backend IDENTITY (meta.backendSpec, legacy labels mapped to the built-in
 * specs), systemone rows enter the temperature fit through log p of their stored
 * answers, and each group carries the per-backend comparison numbers (calls,
 * fails, latency percentiles) from EVERY decision row — challenger rows and
 * earlier-leg failures included. */
describe('2026-09-26 — backend identity, logits from answers, per-backend comparison', () => {
  const decisionRow = (id: string, purpose: string, meta: any, extra: { at?: string; sessionId?: string; value?: number } = {}): ReadinessRow =>
    ({ meta: { phase: 'decision', id, purpose, ...meta }, createdAt: new Date(extra.at ?? '2026-09-20T00:00:00Z'), ...(extra.sessionId ? { sessionId: extra.sessionId } : {}), ...(extra.value !== undefined ? { value: extra.value } : {}) });
  const outcomeRow = (id: string, purpose: string, question: string, actual: any, extra: any = {}): ReadinessRow =>
    ({ meta: { phase: 'outcome', id, purpose, question, actual, acted: false, ...extra }, createdAt: new Date('2026-09-21T00:00:00Z') });

  it('backendSpecOfRow / backendKindOfRow / legErrorLabel / percentile — the identity helpers', () => {
    expect(LEGACY_BACKEND_LABEL_SPECS).toEqual({ 'TypeSafe Jev': 'jev', 'DeepSeek logprob readout': 'deepseek-flash' });
    expect(backendSpecOfRow({ backend: 'TypeSafe Jev' })).toBe('jev');
    expect(backendSpecOfRow({ backend: 'DeepSeek logprob readout' })).toBe('deepseek-flash');
    expect(backendSpecOfRow({ backend: 'laya (systemone)', backendSpec: 'laya:typed-decisions' })).toBe('laya:typed-decisions');
    expect(backendSpecOfRow({ backend: 'laya (systemone)' })).toBe('laya (systemone)'); // a registry label without a spec stays a label
    expect(backendSpecOfRow({})).toBe('unknown');
    expect(backendKindOfRow({ backendKind: 'logit' })).toBe('logit');
    expect(backendKindOfRow({ backend: 'TypeSafe Jev' })).toBe('systemone');
    expect(backendKindOfRow({ backend: 'laya (systemone)' })).toBe('systemone');
    expect(backendKindOfRow({ backend: 'vllm logprob readout' })).toBe('logit');
    expect(backendKindOfRow({ backend: 'mystery' })).toBeUndefined();
    expect(legErrorLabel('TypeSafe Jev: HTTP 429 rate limited')).toBe('TypeSafe Jev');
    expect(legErrorLabel('deadline exhausted before the next leg')).toBeNull();
    expect(legErrorLabel('')).toBeNull();
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([300], 0.95)).toBe(300);
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 0.95)).toBe(5);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95)).toBe(100);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200], 0.95)).toBe(190);
  });

  it('logitsFromAnswers: a noul → {no, yes} = log p; a choice / score with stored probabilities → log p per option (p = 0 floored at 1e-6); nothing derivable → null', () => {
    const l = logitsFromAnswers({ needs_turn_now: { noul: 0.1 }, level: { choice: 'thinking', confidence: 0.8, probabilities: { thinking: 0.8, single_thinking: 0.2, deep_research: 0 } }, bare: { choice: 'x', confidence: 0.5 } })!;
    expect(l.needs_turn_now.no).toBeCloseTo(Math.log(0.9), 12);
    expect(l.needs_turn_now.yes).toBeCloseTo(Math.log(0.1), 12);
    expect(l.level.thinking).toBeCloseTo(Math.log(0.8), 12);
    expect(l.level.deep_research).toBeCloseTo(Math.log(1e-6), 12);
    expect(l.bare).toBeUndefined();
    expect(logitsFromAnswers({ bare: { choice: 'x', confidence: 0.5 } })).toBeNull();
    expect(logitsFromAnswers(null)).toBeNull();
  });

  it('pairDecisionRows groups by backendSpec — legacy label-only rows and new spec-stamped rows of the same built-in form ONE group — fits systemone rows from their answers, and skips memo hits + tempered rows without raw logits', () => {
    const rows = [
      decisionRow('j-old', 'wake_triage', { backend: 'TypeSafe Jev', answers: { needs_turn_now: { noul: 0.1 } } }),
      outcomeRow('j-old', 'wake_triage', 'needs_turn_now', false),
      decisionRow('j-new', 'wake_triage', { backend: 'TypeSafe Jev', backendSpec: 'jev', backendKind: 'systemone', answers: { needs_turn_now: { noul: 0.8 } } }, { at: '2026-09-21T00:00:00Z' }),
      outcomeRow('j-new', 'wake_triage', 'needs_turn_now', true),
      decisionRow('r-old', 'wake_triage', { backend: 'DeepSeek logprob readout', logits: { needs_turn_now: { no: -0.01, yes: -4.6 } } }),
      outcomeRow('r-old', 'wake_triage', 'needs_turn_now', false),
      decisionRow('r-new', 'wake_triage', { backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash', backendKind: 'logit', logits: { needs_turn_now: { no: -0.7, yes: -0.7 } } }),
      outcomeRow('r-new', 'wake_triage', 'needs_turn_now', true),
      // A tempered systemone row carries meta.logits (raw log p) — it is used as-is, never re-derived from the tempered answers.
      decisionRow('l1', 'wake_triage', { backend: 'laya (systemone)', backendSpec: 'laya:typed-decisions', backendKind: 'systemone', answers: { needs_turn_now: { noul: 0.75 } }, logits: { needs_turn_now: { no: Math.log(0.1), yes: Math.log(0.9) } }, temperature: 2 }),
      outcomeRow('l1', 'wake_triage', 'needs_turn_now', true),
      decisionRow('l2', 'wake_triage', { backend: 'laya (systemone)', backendSpec: 'laya:typed-decisions', backendKind: 'systemone', answers: { needs_turn_now: { noul: 0.05 } } }),
      outcomeRow('l2', 'wake_triage', 'needs_turn_now', false),
      // Review 2026-09-26: a MEMO HIT (cached — a copy of l2's answers under a new id) and a TEMPERED row without raw
      // logits never enter the fit: the first would count one sample twice toward the fit floor, the second would feed
      // post-T probabilities back into the fit.
      decisionRow('l2-hit', 'wake_triage', { backend: 'laya (systemone)', backendSpec: 'laya:typed-decisions', backendKind: 'systemone', cached: true, cachedFrom: 'l2', answers: { needs_turn_now: { noul: 0.05 } } }),
      outcomeRow('l2-hit', 'wake_triage', 'needs_turn_now', false),
      decisionRow('l3-tempered', 'wake_triage', { backend: 'laya (systemone)', backendSpec: 'laya:typed-decisions', backendKind: 'systemone', temperature: 2, answers: { needs_turn_now: { noul: 0.6 } } }),
      outcomeRow('l3-tempered', 'wake_triage', 'needs_turn_now', true),
      decisionRow('c1', 'auto_route', { backend: 'TypeSafe Jev', backendSpec: 'jev', answers: { level: { choice: 'thinking', confidence: 0.8, probabilities: { thinking: 0.8, single_thinking: 0.2 } } } }),
      outcomeRow('c1', 'auto_route', 'level', 'thinking'),
    ];
    const groups = pairDecisionRows(rows);
    expect(groups.map(g => `${g.purpose}/${g.backendSpec}/${g.backend}/${g.kind}/${g.samples.length}`)).toEqual([
      'auto_route/jev/TypeSafe Jev/systemone/1',
      'wake_triage/jev/TypeSafe Jev/systemone/2',
      'wake_triage/deepseek-flash/DeepSeek logprob readout/logit/2',
      'wake_triage/laya:typed-decisions/laya (systemone)/systemone/2', // l1 + l2 only: the memo hit and the tempered row are skipped
    ]);
    expect(groups[3].samples.map(s => s.actual)).toEqual(['yes', 'no']);
    expect(groups[1].samples[0].logits.yes).toBeCloseTo(Math.log(0.1), 12);
    expect(groups[1].samples[0].actual).toBe('no');
    expect(groups[2].samples[0]).toEqual({ logits: { no: -0.01, yes: -4.6 }, actual: 'no' });
    expect(groups[3].samples[0].logits).toEqual({ no: Math.log(0.1), yes: Math.log(0.9) }); // meta.logits wins over the tempered answer
    expect(groups[3].samples[1].logits.yes).toBeCloseTo(Math.log(0.05), 12);
    expect(groups[0].samples[0].logits.single_thinking).toBeCloseTo(Math.log(0.2), 12);
    expect(fitTemperature(groups[1].samples).n).toBe(2);
    expect(backendTempStoreKey('laya:typed-decisions', 'wake_triage')).toBe('laya:typed-decisions|wake_triage');
  });

  it('pairReadinessRows (plan E): groups by backendSpec; calls / fails / latencies from EVERY decision row — ok rows, its own ok:false rows, challenger rows (flagged, never paired as the primary\'s decision), earlier-leg AND all-legs failures named in legErrors / the joined error text, memo hits counted without latency; readinessMetrics carries calls / failRate / p50 / p95', () => {
    const rows: ReadinessRow[] = [
      decisionRow('d1', 'wake_triage', { ok: true, backend: 'TypeSafe Jev', backendSpec: 'jev', backendKind: 'systemone', calibrated: true, answers: { needs_turn_now: { noul: 0.1 } }, stateHash: 'h1', questionsHash: 'q1' }, { value: 300, sessionId: 'c1' }),
      outcomeRow('d1', 'wake_triage', 'needs_turn_now', false),
      // A memo hit: a call for the comparison, but no backend latency.
      decisionRow('d1b', 'wake_triage', { ok: true, backend: 'TypeSafe Jev', backendSpec: 'jev', cached: true, cachedFrom: 'd1', answers: { needs_turn_now: { noul: 0.1 } }, stateHash: 'h1b', questionsHash: 'q1' }, { value: 1 }),
      outcomeRow('d1b', 'wake_triage', 'needs_turn_now', false),
      // Jev 429d, the readout answered: the readout's call + a Jev failure.
      decisionRow('d2', 'wake_triage', { ok: true, backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash', backendKind: 'logit', calibrated: false, legIndex: 1, legErrors: ['TypeSafe Jev: HTTP 429 rate limited'], logits: { needs_turn_now: { no: -0.1, yes: -2.3 } }, stateHash: 'h2', questionsHash: 'q1' }, { value: 900 }),
      outcomeRow('d2', 'wake_triage', 'needs_turn_now', false),
      // Every leg failed (a pre-review row: only the joined `error` text) → one failure per NAMED leg the window knows (review 2026-09-26).
      decisionRow('d3', 'wake_triage', { ok: false, error: 'TypeSafe Jev: HTTP 500 | DeepSeek logprob readout: timeout' }, { value: 4000 }),
      // Every leg failed (a post-review row): meta.legErrors names them; 'deadline exhausted…' names nobody; a label the window
      // never saw answering still counts through legErrors (it is the gate's own leg text, never a caller's).
      decisionRow('d4', 'wake_triage', { ok: false, error: 'TypeSafe Jev: timeout | jevk5 (systemone): HTTP 503 | deadline exhausted before the next leg', legErrors: ['TypeSafe Jev: timeout', 'jevk5 (systemone): HTTP 503', 'deadline exhausted before the next leg'] }, { value: 2000 }),
      // A backend-less row whose `error` is not a leg error never becomes a backend.
      decisionRow('d5', 'wake_triage', { ok: false, error: 'invalid questions: q1 has no criteria' }, { value: 0 }),
      // Shadow challenger rows (plan C): its own ok / ok:false rows, never the primary's decision.
      decisionRow('d1~c1', 'wake_triage', { ok: false, challenger: true, primaryId: 'd1', backend: 'laya (systemone)', backendSpec: 'laya:typed-decisions', backendKind: 'systemone', calibrated: false, error: 'challenger_timeout' }, { value: 400 }),
      decisionRow('d2~c1', 'wake_triage', { ok: true, challenger: true, primaryId: 'd2', backend: 'laya (systemone)', backendSpec: 'laya:typed-decisions', backendKind: 'systemone', calibrated: false, answers: { needs_turn_now: { noul: 0.9 } }, stateHash: 'h2', questionsHash: 'q1' }, { value: 50 }),
      outcomeRow('d2~c1', 'wake_triage', 'needs_turn_now', false, { challenger: true, primaryId: 'd2' }),
      decisionRow('d2~c2', 'wake_triage', { ok: true, challenger: true, primaryId: 'd2', backend: 'laya (systemone)', backendSpec: 'laya:typed-decisions', backendKind: 'systemone', calibrated: true, answers: { needs_turn_now: { noul: 0.2 } }, stateHash: 'h2b', questionsHash: 'q1' }, { at: '2026-09-22T00:00:00Z', value: 70 }),
    ];
    const groups = pairReadinessRows(rows);
    expect(groups.map(g => `${g.purpose}/${g.backendSpec}/${g.samples.length}/${g.calls}/${g.fails}/${g.challenger}/${g.challengerRows}`)).toEqual([
      'wake_triage/jev/2/5/3/false/0',            // d1, d1b, d2's legError, d3's error text, d4's legError
      'wake_triage/deepseek-flash/1/2/1/false/0', // d2, d3's error text
      'wake_triage/laya:typed-decisions/0/3/1/true/3',
      'wake_triage/jevk5 (systemone)/0/1/1/false/0', // d4's legError only — a label the window never saw answering
    ]);
    const jev = groups[0];
    expect(jev).toMatchObject({ backend: 'TypeSafe Jev', kind: 'systemone', calibratedNewest: true, latenciesMs: [300], deduped: 0 });
    expect(groups[1]).toMatchObject({ kind: 'logit', calibratedNewest: false, latenciesMs: [900] });
    expect(groups[2]).toMatchObject({ backend: 'laya (systemone)', latenciesMs: [50, 70], calibratedNewest: true }); // the NEWEST row's flag
    const m = readinessMetrics(jev);
    expect(m).toMatchObject({ n: 2, calls: 5, fails: 3, p50Ms: 300, p95Ms: 300 });
    expect(m.failRate).toBeCloseTo(3 / 5, 12);
    const ml = readinessMetrics(groups[2]);
    expect(ml).toMatchObject({ n: 0, calls: 3, fails: 1, p50Ms: 50, p95Ms: 70 });
    expect(Number.isNaN(readinessMetrics({ purpose: 'x', samples: [], deduped: 0, undedupable: 0 }).failRate)).toBe(true);
  });

  it('challenger is NEWEST-row semantics (review 2026-09-26): a backend promoted mid-window reads as the answering backend (its challenger-era rows counted in challengerRows), the demoted one as the challenger', () => {
    const mk = (backend: string, backendSpec: string, calibrated: boolean, value: number) => (id: string, challenger: boolean, at: string) =>
      decisionRow(id, 'wake_triage', { ok: true, ...(challenger ? { challenger: true, primaryId: `p-${id}` } : {}), backend, backendSpec, backendKind: 'systemone', calibrated, answers: { needs_turn_now: { noul: 0.1 } }, stateHash: `h-${id}`, questionsHash: 'q1' }, { at, value });
    const laya = mk('laya (systemone)', 'laya:typed-decisions', false, 40);
    const jev = mk('TypeSafe Jev', 'jev', true, 300);
    const rows: ReadinessRow[] = [
      // Days 1–2: jev primary, laya the shadow challenger.
      jev('j1', false, '2026-09-20T00:00:00Z'), outcomeRow('j1', 'wake_triage', 'needs_turn_now', false),
      laya('l1', true, '2026-09-20T00:00:00Z'),
      jev('j2', false, '2026-09-21T00:00:00Z'), outcomeRow('j2', 'wake_triage', 'needs_turn_now', false),
      laya('l2', true, '2026-09-21T00:00:00Z'),
      // Day 3: promotion (plan D) — laya primary, jev the challenger.
      laya('l3', false, '2026-09-22T00:00:00Z'), outcomeRow('l3', 'wake_triage', 'needs_turn_now', false),
      jev('j3', true, '2026-09-22T00:00:00Z'),
    ];
    const by = Object.fromEntries(pairReadinessRows(rows).map(g => [g.backendSpec, g]));
    expect(by['laya:typed-decisions']).toMatchObject({ challenger: false, challengerRows: 2, calls: 3 });
    expect(by['laya:typed-decisions'].samples.map(s => s.id)).toEqual(['l3']); // its challenger-era rows never pair as the decision
    expect(by.jev).toMatchObject({ challenger: true, challengerRows: 1, calls: 3 });
    expect(by.jev.samples.map(s => s.id)).toEqual(['j1', 'j2']); // its primary-era labels still count; the challenger row never pairs
    const report = Object.fromEntries(buildReadinessReport(rows).map(e => [e.backendSpec, e]));
    expect(report['laya:typed-decisions'].role).toBeUndefined(); // primary / fallback is assigned with the configured primary (buildReadinessArtifacts)
    expect(report.jev.role).toBe('challenger');
  });

  it('buildReadinessReport covers ACT_POLICIES purposes only: the admin Test button\'s purpose "probe" rows produce no entry (review 2026-09-26)', () => {
    const rows: ReadinessRow[] = [
      decisionRow('p1', 'probe', { ok: true, backend: 'laya (systemone)', backendSpec: 'laya:typed-decisions', backendKind: 'systemone', calibrated: false, answers: { refund: { noul: 0.9 } } }, { value: 30 }),
      decisionRow('w1', 'wake_triage', { ok: true, backend: 'TypeSafe Jev', backendSpec: 'jev', backendKind: 'systemone', calibrated: true, answers: { needs_turn_now: { noul: 0.1 } }, stateHash: 'h-w1', questionsHash: 'q1' }, { value: 200 }),
      outcomeRow('w1', 'wake_triage', 'needs_turn_now', false),
    ];
    expect(pairReadinessRows(rows).map(g => g.purpose)).toEqual(['probe', 'wake_triage']); // the pairing itself stays generic
    expect(buildReadinessReport(rows).map(e => `${e.purpose}/${e.backendSpec}`)).toEqual(['wake_triage/jev']);
    expect(buildReadinessReport(rows, { purpose: 'probe' })).toEqual([]);
  });

  it('groupCalibrated / buildReadinessReport: jev always; a store temp for any backend; the env temp for a readout only; else the newest row\'s meta.calibrated; legacy rows fall back to the label; a challenger group carries role challenger; a calls-only group reads "no labelled outcomes" first', () => {
    const laya = (id: string, calibrated: boolean, at: string) => decisionRow(id, 'wake_triage', { ok: true, backend: 'laya (systemone)', backendSpec: 'laya:typed-decisions', backendKind: 'systemone', calibrated, answers: { needs_turn_now: { noul: 0.1 } }, stateHash: `h-${id}`, questionsHash: 'q1' }, { at, value: 40 });
    const rows: ReadinessRow[] = [
      laya('l1', false, '2026-09-20T00:00:00Z'), outcomeRow('l1', 'wake_triage', 'needs_turn_now', false),
      decisionRow('r1', 'wake_triage', { ok: true, backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash', backendKind: 'logit', calibrated: false, logits: { needs_turn_now: { no: -0.1, yes: -2.3 } }, stateHash: 'h-r1', questionsHash: 'q1' }, { value: 800 }),
      outcomeRow('r1', 'wake_triage', 'needs_turn_now', false),
      decisionRow('j1', 'wake_triage', { ok: true, backend: 'TypeSafe Jev', answers: { needs_turn_now: { noul: 0.1 } }, stateHash: 'h-j1', questionsHash: 'q1' }, { value: 200 }), // legacy: no spec, no flag
      outcomeRow('j1', 'wake_triage', 'needs_turn_now', false),
      decisionRow('k1', 'wake_triage', { ok: true, backend: 'kev (systemone)', answers: { needs_turn_now: { noul: 0.1 } }, stateHash: 'h-k1', questionsHash: 'q1' }, { value: 30 }), // legacy registry systemone row: label fallback
      outcomeRow('k1', 'wake_triage', 'needs_turn_now', false),
      decisionRow('x1', 'wake_triage', { ok: true, challenger: true, primaryId: 'j1', backend: 'jevk5 (systemone)', backendSpec: 'jevk5:4b', backendKind: 'systemone', calibrated: false, answers: { needs_turn_now: { noul: 0.3 } } }, { value: 15 }),
    ];
    const byKey = (entries: ReturnType<typeof buildReadinessReport>) => Object.fromEntries(entries.map(e => [e.backendSpec, e]));
    const plain = byKey(buildReadinessReport(rows));
    expect(plain['laya:typed-decisions'].calibrated).toBe(false);
    expect(plain['deepseek-flash'].calibrated).toBe(false);
    expect(plain.jev.calibrated).toBe(true);
    expect(plain['kev (systemone)'].calibrated).toBe(true); // pre-flag rows: the label says systemone
    expect(plain['jevk5:4b']).toMatchObject({ role: 'challenger', calibrated: false });
    expect(plain['jevk5:4b'].reasons[0]).toBe('no labelled outcomes in the window');
    expect(plain['jevk5:4b'].metrics).toMatchObject({ n: 0, calls: 1, p50Ms: 15 });
    expect(plain.jev.role).toBeUndefined(); // primary / fallback need the per-purpose primary — assigned by buildReadinessArtifacts
    // The env temp (fitted for the readout) calibrates the readout only.
    const env = byKey(buildReadinessReport(rows, { env: { DECISION_GATE_TEMP_WAKE_TRIAGE: '2' } }));
    expect(env['deepseek-flash'].calibrated).toBe(true);
    expect(env['laya:typed-decisions'].calibrated).toBe(false);
    // A store temp for (spec, purpose) calibrates that backend.
    const temps = byKey(buildReadinessReport(rows, { temps: { 'laya:typed-decisions|wake_triage': 1.4 } }));
    expect(temps['laya:typed-decisions'].calibrated).toBe(true);
    expect(temps['deepseek-flash'].calibrated).toBe(false);
    expect(backendTemperatureFittedIn('laya:typed-decisions', 'wake_triage', 'systemone', { DECISION_GATE_TEMP_WAKE_TRIAGE: '2' }, {})).toBe(false);
    expect(backendTemperatureFittedIn('laya:typed-decisions', 'wake_triage', 'systemone', {}, { 'laya:typed-decisions|wake_triage': 1.4 })).toBe(true);
    expect(backendTemperatureFittedIn('deepseek-flash', 'wake_triage', 'logit', { DECISION_GATE_TEMP_WAKE_TRIAGE: '2' }, {})).toBe(true);
    // The NEWEST row's flag decides: the admin flips `calibrated` on the registry model.
    const later = byKey(buildReadinessReport([...rows, laya('l2', true, '2026-09-23T00:00:00Z'), outcomeRow('l2', 'wake_triage', 'needs_turn_now', false)]));
    expect(later['laya:typed-decisions'].calibrated).toBe(true);
    expect(groupCalibrated({ backend: 'x', backendSpec: 'jev', purpose: 'wake_triage' })).toBe(true);
    expect(groupCalibrated({ backend: 'x logprob readout', backendSpec: 'vllm:q', kind: 'logit', purpose: 'wake_triage', calibratedNewest: false }, { DECISION_GATE_TEMP_WAKE_TRIAGE: '3' })).toBe(true);
  });
});

// ── cp/labels (2026-09-26): the compute_policy `facts` row as the window-closed negative ──
describe('OUTCOME_LABEL_FALLBACK_FOR_FIT — compute_policy facts enters the OFFLINE pairings only once the escalation window closed with no tap', () => {
  const WINDOW = 30 * 60_000;
  const T0 = Date.parse('2026-09-26T10:00:00Z');
  const cpAnswers = { depth: { choice: 'simple_lookup', confidence: 0.9, probabilities: { simple_lookup: 0.9, ordinary: 0.1 } } };
  const decisionRow = (id: string, at: number, stateHash: string): ReadinessRow =>
    ({ meta: { phase: 'decision', id, purpose: 'compute_policy', backend: 'TypeSafe Jev', answers: cpAnswers, stateHash, questionsHash: 'q-cp' }, createdAt: new Date(at) });
  const outcomeRow = (id: string, label: string, actual: string, at: number): ReadinessRow =>
    ({ meta: { phase: 'outcome', id, purpose: 'compute_policy', question: 'depth', actual, acted: false, label }, createdAt: new Date(at) });

  it('registry + the pure admission rule', () => {
    expect(OUTCOME_LABEL_FALLBACK_FOR_FIT.compute_policy).toEqual({ label: 'facts', afterMs: WINDOW });
    const primary = primaryLabelledKeys([outcomeRow('d1', 'escalated', 'ordinary', T0)]);
    expect(primary.has(`compute_policy\u0000d1\u0000depth`)).toBe(true);
    // the primary label always enters; an unlabelled row always enters
    expect(outcomeRowEntersFit('compute_policy', { id: 'd1', question: 'depth', label: 'escalated' }, { primary, rowAtMs: T0, nowMs: T0 })).toBe(true);
    expect(outcomeRowEntersFit('wake_triage', { id: 'w', question: 'q' }, { primary, rowAtMs: T0, nowMs: T0 })).toBe(true);
    // the fallback: only with NO primary for the same (id, question) AND once the window closed
    expect(outcomeRowEntersFit('compute_policy', { id: 'd1', question: 'depth', label: 'facts' }, { primary, rowAtMs: T0, nowMs: T0 + WINDOW + 1 })).toBe(false); // d1 has its escalated row
    expect(outcomeRowEntersFit('compute_policy', { id: 'd2', question: 'depth', label: 'facts' }, { primary, rowAtMs: T0, nowMs: T0 + WINDOW - 1 })).toBe(false); // window still open
    expect(outcomeRowEntersFit('compute_policy', { id: 'd2', question: 'depth', label: 'facts' }, { primary, rowAtMs: T0, nowMs: T0 + WINDOW })).toBe(true);
    // every other secondary label stays out; a missing clock fails closed
    for (const l of ['escalated_late', 'reask_5m', 'thumbs', 'revision_material', 'checker_skipped_material']) {
      expect(outcomeRowEntersFit('compute_policy', { id: 'd2', question: 'depth', label: l }, { primary, rowAtMs: T0, nowMs: T0 + 2 * WINDOW })).toBe(false);
    }
    expect(outcomeRowEntersFit('compute_policy', { id: 'd2', question: 'depth', label: 'facts' }, { primary, rowAtMs: 0, nowMs: T0 + 2 * WINDOW })).toBe(false);
    // the write-time rule is unchanged: only the primary enters the act-band window
    expect(outcomeLabelEntersFit('compute_policy', 'facts')).toBe(false);
  });

  it('pairReadinessRows: a tapped decision contributes its escalated row (the facts row never shadows it, whatever the write order); an untapped one contributes its facts row once the window closed; an open window contributes nothing', () => {
    const now = T0 + 3 * WINDOW;
    const rows: ReadinessRow[] = [
      decisionRow('tapped', T0, 'h-tapped'),
      outcomeRow('tapped', 'facts', 'simple_lookup', T0 + 60_000),     // finalize — lands FIRST
      outcomeRow('tapped', 'escalated', 'ordinary', T0 + 5 * 60_000),  // the tap
      outcomeRow('tapped', 'reask_5m', 'ordinary', T0 + 6 * 60_000),   // secondary — never
      decisionRow('untapped', T0, 'h-untapped'),
      outcomeRow('untapped', 'facts', 'simple_lookup', T0 + 60_000),   // window closed at `now` ⇒ the negative
      outcomeRow('untapped', 'thumbs', 'simple_lookup', T0 + 2 * 60_000),
      decisionRow('fresh', now - 10 * 60_000, 'h-fresh'),
      outcomeRow('fresh', 'facts', 'simple_lookup', now - 9 * 60_000), // window open ⇒ nothing yet
    ];
    const groups = pairReadinessRows(rows, { now });
    expect(groups.map(g => `${g.purpose}/${g.samples.length}`)).toEqual(['compute_policy/2']);
    expect(groups[0].samples.map(s => `${s.id}:${s.actual}:${s.agreed}`)).toEqual(['tapped:ordinary:false', 'untapped:simple_lookup:true']);
    expect(groups[0].deduped).toBe(0);
    // no clock ⇒ Date.now(): the 2026 fixture is long closed either way
    expect(pairReadinessRows(rows)[0].samples).toHaveLength(3);
    // buildReadinessReport threads `now` the same way
    expect(buildReadinessReport(rows, { now })[0].metrics.n).toBe(2);
  });

  it('pairDecisionRows (the temperature fit) applies the same population rule', () => {
    const now = T0 + 3 * WINDOW;
    const rows = [
      decisionRow('tapped', T0, 'h1'), outcomeRow('tapped', 'facts', 'simple_lookup', T0 + 1), outcomeRow('tapped', 'escalated', 'ordinary', T0 + 2),
      decisionRow('untapped', T0, 'h2'), outcomeRow('untapped', 'facts', 'simple_lookup', T0 + 1),
      decisionRow('fresh', now - 1000, 'h3'), outcomeRow('fresh', 'facts', 'simple_lookup', now - 500),
    ];
    const g = pairDecisionRows(rows, { now });
    expect(g).toHaveLength(1);
    expect(g[0].samples.map(s => s.actual)).toEqual(['ordinary', 'simple_lookup']);
  });
});

// ── audit 2026-09-26: acted rows for a USER-labelled purpose, guest / machine partitions, the compound act band ──
describe('audit 2026-09-26 — pairReadinessRows keeps acted compute_policy rows, drops guest facts fallbacks; readinessMetrics excludes machine segments; computePolicyActBand mirrors the consumer', () => {
  const T0 = Date.parse('2026-09-26T10:00:00Z');
  const WINDOW = 30 * 60_000;
  const cpAnswers = { depth: { choice: 'simple_lookup', confidence: 0.9, probabilities: { simple_lookup: 0.9, ordinary: 0.1 } }, stakes: { noul: 0.05 } };
  const dec = (id: string, extra: Record<string, unknown> = {}): ReadinessRow =>
    ({ meta: { phase: 'decision', id, purpose: 'compute_policy', backend: 'TypeSafe Jev', answers: cpAnswers, stateHash: `h-${id}`, questionsHash: 'q-cp', ...extra }, createdAt: new Date(T0) });
  const out = (id: string, label: string, actual: string, extra: Record<string, unknown> = {}, at = T0 + 60_000): ReadinessRow =>
    ({ meta: { phase: 'outcome', id, purpose: 'compute_policy', question: 'depth', actual, acted: false, label, ...extra }, createdAt: new Date(at) });
  const samplesOf = (rows: ReadinessRow[], now = T0 + 2 * WINDOW) => pairReadinessRows(rows, { now }).find(g => g.purpose === 'compute_policy')?.samples ?? [];

  it('an ACTED compute_policy row (tap / window closer) is a sample (telemetry-readiness-1); other purposes still drop acted rows', () => {
    const s = samplesOf([dec('d1'), out('d1', 'escalated', 'simple_lookup', { acted: true })]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: 'd1', acted: true, answers: cpAnswers });
    const wt = pairReadinessRows([
      { meta: { phase: 'decision', id: 'w1', purpose: 'wake_triage', backend: 'TypeSafe Jev', answers: { needs_turn_now: { noul: 0.1 } }, questionsHash: 'q' }, createdAt: new Date(T0) },
      { meta: { phase: 'outcome', id: 'w1', purpose: 'wake_triage', question: 'needs_turn_now', actual: false, acted: true }, createdAt: new Date(T0) },
    ]);
    expect(wt.find(g => g.purpose === 'wake_triage')?.samples ?? []).toHaveLength(0);
  });
  it("a GUEST decision's `facts` row never stands in for the window-closed negative (guest-persistence-2); a signed-in facts row still does", () => {
    expect(samplesOf([dec('g1', { guest: true }), out('g1', 'facts', 'ordinary', { guest: true })])).toHaveLength(0);
    expect(samplesOf([dec('u1'), out('u1', 'facts', 'ordinary')])).toHaveLength(1);
    // a guest ESCALATED row (impossible today, but the primary label) would still enter
    expect(samplesOf([dec('g2', { guest: true }), out('g2', 'escalated', 'ordinary', { guest: true })])).toHaveLength(1);
  });
  it('readinessMetrics drops machine / supervisor-segment samples from the human readiness and reports machineExcluded (the second guard — a group whose samples pool every segment)', () => {
    const groups = pairReadinessRows([
      dec('m1', { segment: 'machine' }), out('m1', 'escalated', 'simple_lookup', { segment: 'machine' }),
      dec('s1', { segment: 'supervisor' }), out('s1', 'escalated', 'simple_lookup'),
      dec('h1'), out('h1', 'escalated', 'simple_lookup', { segment: 'user' }),
    ], { now: T0 + 2 * WINDOW }).filter(x => x.purpose === 'compute_policy');
    const g = { purpose: 'compute_policy', samples: groups.flatMap(x => x.samples), deduped: 0, undedupable: 0 };
    expect(g.samples.map(s => s.segment).sort()).toEqual(['machine', 'supervisor', 'user']);
    const m = readinessMetrics(g);
    expect(m.n).toBe(1);
    expect(m.machineExcluded).toBe(2);
  });
  it('computePolicyActBand = the consumer rule (telemetry-readiness-2): ordinary / unclear never in band; simple_lookup needs low stakes; contestable needs high stakes; the option envs move the cutoffs', () => {
    expect(actBand('compute_policy', { choice: 'ordinary', confidence: 0.99 }, {}, undefined, { stakes: { noul: 0.1 } }).inBand).toBe(false);
    expect(actBand('compute_policy', { choice: 'unclear', confidence: 0.99 }, {}, undefined, { stakes: { noul: 0.1 } }).inBand).toBe(false);
    expect(actBand('compute_policy', { choice: 'simple_lookup', confidence: 0.9 }, {}, undefined, { stakes: { noul: 0.5 } }).inBand).toBe(false);
    expect(actBand('compute_policy', { choice: 'simple_lookup', confidence: 0.9 }, {}, undefined, { stakes: { noul: 0.1 } })).toEqual({ inBand: true, threshold: 0.85, actKey: 'simple_lookup' });
    expect(actBand('compute_policy', { choice: 'simple_lookup', confidence: 0.9 }, {})).toMatchObject({ inBand: false }); // unknown stakes ⇒ never in band
    expect(actBand('compute_policy', { choice: 'contestable', confidence: 0.75 }, {}, undefined, { stakes: { noul: 0.1 } }).inBand).toBe(false);
    expect(actBand('compute_policy', { choice: 'contestable', confidence: 0.75 }, {}, undefined, { stakes: { noul: 0.9 } })).toEqual({ inBand: true, threshold: 0.7, actKey: 'contestable' });
    // P(contestable) from the distribution acts even when the argmax is another option (the consumer reads the probability)
    expect(actBand('compute_policy', { choice: 'ordinary', confidence: 0.5, probabilities: { ordinary: 0.5, contestable: 0.72 } }, {}, undefined, { stakes: { noul: 0.9 } })).toMatchObject({ inBand: true, actKey: 'contestable' });
    expect(actBand('compute_policy', { choice: 'contestable', confidence: 0.75 }, { DECISION_GATE_THRESHOLD_COMPUTE_POLICY_CONTESTABLE: '0.8' }, undefined, { stakes: { noul: 0.9 } }).inBand).toBe(false);
    // actBandStats reads the sample's answers; an orphan outcome row's `stakes` extra feeds them
    const g = pairReadinessRows([out('o1', 'escalated', 'simple_lookup', { predicted: { choice: 'simple_lookup', confidence: 0.9 }, stakes: 0.05, purpose: 'compute_policy' })], { now: T0 + 2 * WINDOW }).find(x => x.purpose === 'compute_policy')!;
    expect(g.samples[0].answers).toEqual({ stakes: { noul: 0.05 } });
    expect(actBandStats(g.samples, 'compute_policy')).toMatchObject({ n: 1, correct: 1 });
  });
});
describe('audit 2026-09-26 (telemetry-readiness-8) — the offline fit / ruler admit only the purpose\'s ACT question', () => {
  const T0 = Date.parse('2026-09-26T20:32:51Z');
  const cpAnswers = {
    depth: { choice: 'simple_lookup', confidence: 0.59, probabilities: { simple_lookup: 0.59, ordinary: 0.3, contestable: 0.1, unclear: 0.01 } },
    stakes: { noul: 0.05 }, needs_live_web: { noul: 0.3 }, research_request: { noul: 0.02 },
  };
  const decisionRow = (id: string, purpose: string, answers: any, at = T0, extra: any = {}): ReadinessRow =>
    ({ meta: { phase: 'decision', id, purpose, backend: 'TypeSafe Jev', answers, stateHash: `h-${id}`, questionsHash: `q-${purpose}`, ...extra }, createdAt: new Date(at) });
  const outcomeRow = (id: string, purpose: string, question: string, actual: any, extra: any = {}, at = T0 + 56_000): ReadinessRow =>
    ({ meta: { phase: 'outcome', id, purpose, question, actual, acted: false, ...extra }, createdAt: new Date(at) });
  /** The prod pair of 2026-09-26 20:33:47Z: ONE Dig-deeper tap on an L2 answer → two `escalated` rows (depth + research_request:true at 0.98 confidence, agreed:false). */
  const prodTap = (id: string): ReadinessRow[] => [
    decisionRow(id, 'compute_policy', cpAnswers),
    outcomeRow(id, 'compute_policy', 'depth', 'contestable', { label: 'escalated', agreed: false }),
    outcomeRow(id, 'compute_policy', 'research_request', true, { label: 'escalated', agreed: false }),
  ];

  it('isActQuestionOf / fitAdmitsQuestion mirror decision-gate isActQuestion: the act question only, "*" keeps every question, an unknown purpose keeps every question; the kill switch pools again', () => {
    expect(isActQuestionOf('compute_policy', 'depth')).toBe(true);
    expect(isActQuestionOf('compute_policy', 'research_request')).toBe(false);
    expect(isActQuestionOf('self_audit', 'unevidenced')).toBe(true);
    for (const q of ['claims_unbacked', 'steps_unbacked', 'step_1_evidenced']) expect(isActQuestionOf('self_audit', q)).toBe(false);
    expect(isActQuestionOf('checker_route', 'needs_live_web')).toBe(false);
    expect(isActQuestionOf('memory_extract', 'anything')).toBe(true);
    expect(isActQuestionOf('no_such_purpose', 'anything')).toBe(true);
    expect(fitAdmitsQuestion('compute_policy', 'research_request', {})).toBe(false);
    expect(fitAdmitsQuestion('compute_policy', 'research_request', { DECISION_GATE_FIT_POOL_QUESTIONS: '1' })).toBe(true);
    expect(fitPoolsQuestions({})).toBe(false);
    expect(fitPoolsQuestions({ DECISION_GATE_FIT_POOL_QUESTIONS: 'true' })).toBe(true);
  });

  it('pairReadinessRows: one compute_policy tap = ONE sample (depth) — the research_request row lands in offQuestion, never in n / AUROC / coverage', () => {
    const groups = pairReadinessRows(prodTap('8ee6e78e'), { now: T0 + 3 * 60 * 60_000, env: {} });
    expect(groups.map(g => `${g.purpose}/${g.samples.length}/${g.offQuestion}`)).toEqual(['compute_policy/1/1']);
    expect(groups[0].samples[0]).toMatchObject({ id: '8ee6e78e', question: 'depth', predictedKey: 'simple_lookup', actual: 'contestable', agreed: false });
    expect(readinessMetrics(groups[0]).n).toBe(1);
    expect(buildReadinessReport(prodTap('8ee6e78e'), { now: T0 + 3 * 60 * 60_000, env: {} })[0].metrics.n).toBe(1);
    // the kill switch restores the pooled population (n=2 for one tap)
    const pooled = pairReadinessRows(prodTap('8ee6e78e'), { now: T0 + 3 * 60 * 60_000, env: { DECISION_GATE_FIT_POOL_QUESTIONS: '1' } });
    expect(pooled.map(g => `${g.purpose}/${g.samples.length}/${g.offQuestion}`)).toEqual(['compute_policy/2/0']);
    expect(buildReadinessReport(prodTap('8ee6e78e'), { now: T0 + 3 * 60 * 60_000, env: { DECISION_GATE_FIT_POOL_QUESTIONS: '1' } })[0].metrics.n).toBe(2);
  });

  it('100 L2 taps with a depth gate that is right every time: pooled n=200 / accuracy 0.5 / AUROC 0 ⇒ a FALSE NOT READY; on the act question alone n=100 / accuracy 1', () => {
    const rows: ReadinessRow[] = [];
    for (let i = 0; i < 100; i++) {
      const at = T0 + i * 3_600_000;
      rows.push(decisionRow(`t${i}`, 'compute_policy', { ...cpAnswers, depth: { choice: 'contestable', confidence: 0.9, probabilities: { contestable: 0.9, ordinary: 0.1 } } }, at));
      rows.push(outcomeRow(`t${i}`, 'compute_policy', 'depth', 'contestable', { label: 'escalated', agreed: true }, at + 60_000));
      rows.push(outcomeRow(`t${i}`, 'compute_policy', 'research_request', true, { label: 'escalated', agreed: false }, at + 60_000));
    }
    const now = T0 + 200 * 3_600_000;
    const filtered = readinessMetrics(pairReadinessRows(rows, { now, env: {} })[0]);
    expect(filtered.n).toBe(100);
    expect(filtered.accuracy).toBe(1);
    const pooled = readinessMetrics(pairReadinessRows(rows, { now, env: { DECISION_GATE_FIT_POOL_QUESTIONS: '1' } })[0]);
    expect(pooled.n).toBe(200);
    expect(pooled.accuracy).toBe(0.5);
    expect(pooled.auroc).toBe(0);
    expect(pooled.coverageAt5.coverage).toBe(0);
  });

  it('systemic, not compute_policy-specific: self_audit\'s split / per-step questions and checker_route\'s needs_live_web are excluded the same way; memory_extract ("*") keeps every noul', () => {
    const rows: ReadinessRow[] = [
      decisionRow('sa1', 'self_audit', { unevidenced: { noul: 0.1 }, claims_unbacked: { noul: 0.1 }, steps_unbacked: { noul: 0.1 }, step_1_evidenced: { noul: 0.9 } }),
      outcomeRow('sa1', 'self_audit', 'unevidenced', false),
      outcomeRow('sa1', 'self_audit', 'claims_unbacked', false),
      outcomeRow('sa1', 'self_audit', 'steps_unbacked', false),
      outcomeRow('sa1', 'self_audit', 'step_1_evidenced', true),
      decisionRow('cr1', 'checker_route', { depth: { choice: 'simple_lookup', confidence: 0.9, probabilities: { simple_lookup: 0.9 } }, needs_live_web: { noul: 0.1 } }),
      outcomeRow('cr1', 'checker_route', 'depth', 'simple_lookup'),
      outcomeRow('cr1', 'checker_route', 'needs_live_web', false),
      decisionRow('me1', 'memory_extract', { user_facts: { noul: 0.1 }, project_state: { noul: 0.2 }, thread_summary: { noul: 0.3 } }),
      outcomeRow('me1', 'memory_extract', 'user_facts', false),
      outcomeRow('me1', 'memory_extract', 'project_state', false),
      outcomeRow('me1', 'memory_extract', 'thread_summary', false),
    ];
    const groups = pairReadinessRows(rows, { now: T0 + 3_600_000, env: {} });
    expect(groups.map(g => `${g.purpose}/${g.samples.length}/${g.offQuestion}`)).toEqual(['checker_route/1/1', 'memory_extract/3/0', 'self_audit/1/3']);
    expect(groups[2].samples[0].question).toBe('unevidenced');
  });

  it('pairDecisionRows (the temperature fit) is per act question too: a compute_policy decision with depth + research_request logits fits ONE sample (depth); the kill switch pools', () => {
    const rows = [
      { meta: { phase: 'decision', id: 'f1', purpose: 'compute_policy', backend: 'DeepSeek logprob readout', logits: { depth: { simple_lookup: -0.1, ordinary: -2.5, contestable: -3 }, research_request: { no: -0.02, yes: -3.9 } } }, createdAt: new Date(T0) },
      { meta: { phase: 'outcome', id: 'f1', purpose: 'compute_policy', question: 'depth', actual: 'ordinary', label: 'escalated' }, createdAt: new Date(T0 + 1000) },
      { meta: { phase: 'outcome', id: 'f1', purpose: 'compute_policy', question: 'research_request', actual: true, label: 'escalated' }, createdAt: new Date(T0 + 1000) },
    ];
    const g = pairDecisionRows(rows, { now: T0 + 3_600_000, env: {} });
    expect(g).toHaveLength(1);
    expect(g[0].samples).toEqual([{ logits: { simple_lookup: -0.1, ordinary: -2.5, contestable: -3 }, actual: 'ordinary' }]);
    const pooled = pairDecisionRows(rows, { now: T0 + 3_600_000, env: { DECISION_GATE_FIT_POOL_QUESTIONS: '1' } });
    expect(pooled[0].samples).toHaveLength(2);
  });
});
describe('2026-09-26 (audit, telemetry-readiness-9) — sender-segment partition: machine / supervisor rows never enter the human sample', () => {
  const T0 = Date.parse('2026-09-26T10:00:00Z');
  const WINDOW = 30 * 60_000;
  const cpAnswers = { depth: { choice: 'simple_lookup', confidence: 0.9, probabilities: { simple_lookup: 0.9, ordinary: 0.1 } } };
  const decisionRow = (id: string, at: number, extra: Record<string, unknown> = {}): ReadinessRow =>
    ({ meta: { phase: 'decision', id, purpose: 'compute_policy', backend: 'TypeSafe Jev', backendSpec: 'jev', ok: true, answers: cpAnswers, stateHash: `h-${id}`, questionsHash: 'q-cp', ...extra }, createdAt: new Date(at), value: 100 });
  const outcomeRow = (id: string, label: string, actual: string, at: number, extra: Record<string, unknown> = {}): ReadinessRow =>
    ({ meta: { phase: 'outcome', id, purpose: 'compute_policy', question: 'depth', actual, acted: false, label, ...extra }, createdAt: new Date(at) });

  it('registry + partitionSegmentOfRow: only machine / supervisor partition; user / guest / channel segments and no segment pool', () => {
    expect([...NON_HUMAN_SEGMENTS].sort()).toEqual(['machine', 'replay', 'supervisor']);
    expect(partitionSegmentOfRow({ segment: 'supervisor' })).toBe('supervisor');
    expect(partitionSegmentOfRow({ segment: 'machine' })).toBe('machine');
    for (const s of ['user', 'guest', 'web', 'telegram', '', 42, undefined]) expect(partitionSegmentOfRow({ segment: s })).toBeUndefined();
    expect(partitionSegmentOfRow(null)).toBeUndefined();
  });

  it('pairReadinessRows: a supervisor human turn (decision + window-closed facts row) and a machine ask (calls only) land in their OWN groups; the human group keeps only human rows; the outcome row\'s own segment holds when its decision row is gone', () => {
    const now = T0 + 3 * WINDOW;
    const rows: ReadinessRow[] = [
      decisionRow('u1', T0), outcomeRow('u1', 'facts', 'simple_lookup', T0 + 1000),
      decisionRow('u2', T0, { segment: 'user' }), outcomeRow('u2', 'escalated', 'ordinary', T0 + 1000, { segment: 'user' }),
      decisionRow('s1', T0, { segment: 'supervisor' }), outcomeRow('s1', 'facts', 'simple_lookup', T0 + 1000, { segment: 'supervisor' }),
      decisionRow('m1', T0, { segment: 'machine' }), // a wake — no label can exist
      outcomeRow('s-orphan', 'facts', 'simple_lookup', T0 + 1000, { segment: 'supervisor', backend: 'TypeSafe Jev', backendSpec: 'jev', predicted: cpAnswers.depth }),
    ];
    const groups = pairReadinessRows(rows, { now });
    const key = (g: typeof groups[number]) => `${g.backendSpec}/${g.purpose}/${g.segment ?? 'human'}`;
    expect(groups.map(g => `${key(g)}:n${g.samples.length}:calls${g.calls}`)).toEqual([
      'jev/compute_policy/human:n2:calls2',
      'jev/compute_policy/machine:n0:calls1',
      'jev/compute_policy/supervisor:n2:calls1',
    ]);
    expect(groups[0]).not.toHaveProperty('segment');
    expect(groups[0].samples.map(s => s.id)).toEqual(['u1', 'u2']);
    expect(groups[2].samples.map(s => s.id)).toEqual(['s1', 's-orphan']);
  });

  it('readinessVerdict / buildReadinessReport: a segment entry is NEVER READY and names why; excludeFromFit rows never enter either pairing', () => {
    const m = readinessMetrics({ purpose: 'compute_policy', samples: [], deduped: 0, undedupable: 0 });
    expect(readinessVerdict('compute_policy', m, true, { segment: 'supervisor' }).reasons[0]).toMatch(/^segment 'supervisor': partitioned out of the human sample/);
    expect(readinessVerdict('compute_policy', m, true, { segment: 'user' }).reasons.some(r => r.startsWith('segment'))).toBe(false);
    expect(readinessVerdict('compute_policy', m, true).reasons.some(r => r.startsWith('segment'))).toBe(false);
    const now = T0 + 3 * WINDOW;
    const rows: ReadinessRow[] = [
      decisionRow('s1', T0, { segment: 'supervisor' }), outcomeRow('s1', 'facts', 'simple_lookup', T0 + 1000, { segment: 'supervisor' }),
      decisionRow('s2', T0, { segment: 'supervisor' }), outcomeRow('s2', 'facts', 'simple_lookup', T0 + 1000, { segment: 'supervisor', excludeFromFit: true }),
      decisionRow('u1', T0), outcomeRow('u1', 'facts', 'simple_lookup', T0 + 1000, { excludeFromFit: true }),
    ];
    const report = buildReadinessReport(rows, { now });
    expect(report.map(e => `${e.segment ?? 'human'}:n${e.metrics.n}:calls${e.metrics.calls}:ready${e.ready}`)).toEqual(['human:n0:calls1:readyfalse', 'supervisor:n1:calls2:readyfalse']);
    expect(report[1].reasons[0]).toMatch(/segment 'supervisor'/);
    expect(outcomeRowEntersFit('compute_policy', { id: 'x', question: 'depth', label: 'escalated', excludeFromFit: true }, { primary: new Set(), rowAtMs: T0, nowMs: now })).toBe(false);
    expect(outcomeRowEntersFit('wake_triage', { id: 'x', question: 'q', excludeFromFit: true }, { primary: new Set(), rowAtMs: T0, nowMs: now })).toBe(false);
  });

  it('pairDecisionRows (the temperature fit) drops non-human segments', () => {
    const now = T0 + 3 * WINDOW;
    const rows = [
      decisionRow('u1', T0), outcomeRow('u1', 'facts', 'simple_lookup', T0 + 1),
      decisionRow('s1', T0, { segment: 'supervisor' }), outcomeRow('s1', 'facts', 'simple_lookup', T0 + 1, { segment: 'supervisor' }),
    ];
    expect(pairDecisionRows(rows, { now })[0].samples).toHaveLength(1);
  });
});

/** audit budgets-cost-6 (2026-09-26): the silent-degradation counters — an act ask answered by an UNCALIBRATED
 *  backend (modeDowngrade), an answer given only because an earlier leg failed (legIndex > 0), and a leg skipped
 *  inside its 401/403 latch cooldown ('<label>: latched (…)') — so the readiness stamp and the metric rows show a dead
 *  key as numbers instead of a silent revert to heuristics. */
describe('ticket 4d476b9a — a failed stall retry is the same call\'s second attempt, not a second failed call', () => {
  const decisionRow = (id: string, meta: any): ReadinessRow =>
    ({ meta: { phase: 'decision', id, purpose: 'sweep_triage', ...meta }, createdAt: new Date('2026-10-21T17:00:00Z'), value: 900 });
  const rows: ReadinessRow[] = [
    // Jev timed out, its stall retry timed out too, the readout answered: ONE Jev call, ONE Jev failure.
    decisionRow('a', { ok: true, backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash', backendKind: 'logit', legIndex: 1,
      legErrors: ['TypeSafe Jev: timeout timeout of 2000ms exceeded [loop stall: 600 ms late]', 'TypeSafe Jev: timeout timeout of 700ms exceeded [loop stall: 400 ms late; stall retry]'] }),
    // Every leg failed, the retry's marker in each of its three shapes.
    decisionRow('b', { ok: false, error: 'x', legErrors: ['TypeSafe Jev: timeout timeout of 600ms exceeded [timer 170 ms late, loop 3% busy — not a confirmed loop stall]', 'TypeSafe Jev: timeout timeout of 430ms exceeded [timer 60 ms late — not a confirmed loop stall; stall retry]', 'deadline exhausted before the next leg'] }),
    decisionRow('c', { ok: false, error: 'x', legErrors: ['TypeSafe Jev: timeout timeout of 600ms exceeded [loop stall: 300 ms late]', 'TypeSafe Jev: timeout timeout of 300ms exceeded [stall retry]', 'DeepSeek logprob readout: HTTP 502 Request failed with status code 502'] }),
  ];
  it('counts one call + one failure per leg per ask (the retry entries are skipped); the readout\'s own failure still counts', () => {
    const groups = pairReadinessRows(rows, { env: {} });
    const jev = groups.find(g => g.backendSpec === 'jev')!;
    const readout = groups.find(g => g.backendSpec === 'deepseek-flash')!;
    expect(jev).toMatchObject({ calls: 3, fails: 3 });
    expect(readout).toMatchObject({ calls: 2, fails: 1 });
  });
  it('DECISION_GATE_STALL_RECOVERY_DISABLED=1 in the reading process restores the pre-ticket count (every legErrors entry is a call)', () => {
    const groups = pairReadinessRows(rows, { env: { DECISION_GATE_STALL_RECOVERY_DISABLED: '1' } });
    expect(groups.find(g => g.backendSpec === 'jev')).toMatchObject({ calls: 6, fails: 6 });
  });
});

describe('budgets-cost-6 — downgraded / fellThrough / latched counters per backend group', () => {
  const decisionRow = (id: string, purpose: string, meta: any, value = 100): ReadinessRow =>
    ({ meta: { phase: 'decision', id, purpose, ...meta }, createdAt: new Date('2026-09-26T06:35:00Z'), value });

  it('counts the readout\'s downgraded act asks + fall-throughs, and Jev\'s latched skips (inside its fails); readinessMetrics carries them; a hand-built input has none', () => {
    const rows: ReadinessRow[] = [
      // Jev answered (the healthy baseline).
      decisionRow('a', 'sweep_triage', { ok: true, mode: 'act', backend: 'TypeSafe Jev', backendSpec: 'jev', backendKind: 'systemone', calibrated: true, answers: { q: { noul: 0.1 } } }),
      // Jev 403 → the readout answered a requested-act ask: downgraded + fellThrough on the readout, a fail on Jev.
      decisionRow('b', 'sweep_triage', { ok: true, mode: 'shadow', requestedMode: 'act', modeDowngrade: 'uncalibrated', backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash', backendKind: 'logit', calibrated: false, legIndex: 1, legErrors: ['TypeSafe Jev: HTTP 403 Request failed with status code 403'], logits: { q: { no: -0.1, yes: -2.3 } } }),
      // Jev LATCHED (skipped inside the cooldown) → the readout answered again: latched on Jev (a fail too), downgraded + fellThrough on the readout.
      decisionRow('c', 'sweep_triage', { ok: true, mode: 'shadow', requestedMode: 'act', modeDowngrade: 'uncalibrated', backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash', backendKind: 'logit', calibrated: false, legIndex: 1, legErrors: ['TypeSafe Jev: latched (HTTP 403 at 2026-09-26T06:34:55.000Z; re-probe at 2026-09-26T06:36:25.000Z)'], logits: { q: { no: -0.1, yes: -2.3 } } }),
      // A shadow purpose served by the readout after a fall-through: fellThrough only (nothing was downgraded).
      decisionRow('d', 'wake_triage', { ok: true, mode: 'shadow', backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash', backendKind: 'logit', calibrated: false, legIndex: 1, legErrors: ['TypeSafe Jev: latched (HTTP 403 at 2026-09-26T06:34:55.000Z; re-probe at 2026-09-26T06:36:25.000Z)'], logits: { q: { no: -0.1, yes: -2.3 } } }),
      // Every leg failed with Jev latched: latched + fail on Jev, a fail on the readout; nothing downgraded (no answer).
      decisionRow('e', 'sweep_triage', { ok: false, error: 'TypeSafe Jev: latched (HTTP 403 at 2026-09-26T06:34:55.000Z; re-probe at 2026-09-26T06:36:25.000Z) | DeepSeek logprob readout: timeout', legErrors: ['TypeSafe Jev: latched (HTTP 403 at 2026-09-26T06:34:55.000Z; re-probe at 2026-09-26T06:36:25.000Z)', 'DeepSeek logprob readout: timeout'] }),
    ];
    const groups = pairReadinessRows(rows);
    const key = (g: any) => `${g.purpose}/${g.backendSpec}`;
    const jev = groups.find(g => key(g) === 'sweep_triage/jev')!;
    const readout = groups.find(g => key(g) === 'sweep_triage/deepseek-flash')!;
    const readoutWake = groups.find(g => key(g) === 'wake_triage/deepseek-flash')!;
    const jevWake = groups.find(g => key(g) === 'wake_triage/jev')!;
    expect(jev).toMatchObject({ calls: 4, fails: 3, latched: 2, downgraded: 0, fellThrough: 0 });
    expect(readout).toMatchObject({ calls: 3, fails: 1, downgraded: 2, fellThrough: 2, latched: 0 });
    expect(readoutWake).toMatchObject({ calls: 1, fails: 0, downgraded: 0, fellThrough: 1, latched: 0 });
    expect(jevWake).toMatchObject({ calls: 1, fails: 1, latched: 1 });
    expect(readinessMetrics(jev)).toMatchObject({ calls: 4, fails: 3, latched: 2, downgraded: 0, fellThrough: 0 });
    expect(readinessMetrics(readout)).toMatchObject({ downgraded: 2, fellThrough: 2, latched: 0 });
    const hand = readinessMetrics({ purpose: 'x', samples: [], deduped: 0, undedupable: 0 });
    expect(hand.downgraded).toBeUndefined();
    expect(hand.fellThrough).toBeUndefined();
    expect(hand.latched).toBeUndefined();
  });
});

describe('turnPlanActBand — the Quick lane is the only act band (dynamic roster, 2026-10-03)', () => {
  const { turnPlanActBand } = jest.requireActual('./decision-gate-fit');
  it('a confident quick answer under the ceilings is in band; any other lane never is', () => {
    expect(turnPlanActBand({ choice: 'quick', confidence: 0.85 }, { stakes: { noul: 0.52 }, contested: { noul: 0.02 } }, {}).inBand).toBe(true);
    expect(turnPlanActBand({ choice: 'quick', confidence: 0.75 }, undefined, {}).inBand).toBe(false);
    expect(turnPlanActBand({ choice: 'standard', confidence: 0.99 }, undefined, {}).inBand).toBe(false);
    expect(turnPlanActBand({ choice: 'quick', confidence: 0.9 }, { stakes: { noul: 0.6 } }, {}).inBand).toBe(false);
    expect(turnPlanActBand({ choice: 'quick', confidence: 0.9 }, { contested: { noul: 0.5 } }, {}).inBand).toBe(false);
  });
  it('reads the same envs as the consumer (threshold option env, ceiling envs)', () => {
    expect(turnPlanActBand({ choice: 'quick', confidence: 0.75 }, undefined, { DECISION_GATE_THRESHOLD_TURN_PLAN_QUICK: '0.7' }).inBand).toBe(true);
    expect(turnPlanActBand({ choice: 'quick', confidence: 0.9 }, { stakes: { noul: 0.65 } }, { TURN_PLAN_QUICK_STAKES_CEILING: '0.7' }).inBand).toBe(true);
  });
  it('2026-10-20: the band holds a pure live lookup to the LOOKUP stakes ceiling (the consumer\'s stakesCeilingFor) — a non-lookup keeps 0.6', () => {
    const lookup = { needs_live_web: { noul: 0.98 }, multi_step: { noul: 0.2 }, contested: { noul: 0.02 } };
    expect(turnPlanActBand({ choice: 'quick', confidence: 0.9 }, { ...lookup, stakes: { noul: 0.65 } }, {}).inBand).toBe(true);
    expect(turnPlanActBand({ choice: 'quick', confidence: 0.9 }, { ...lookup, stakes: { noul: 0.81 } }, {}).inBand).toBe(false);
    // not a lookup: multi-step, contested ≥ 0.2, low live web, or a trait the row does not carry
    expect(turnPlanActBand({ choice: 'quick', confidence: 0.9 }, { ...lookup, multi_step: { noul: 0.6 }, stakes: { noul: 0.65 } }, {}).inBand).toBe(false);
    expect(turnPlanActBand({ choice: 'quick', confidence: 0.9 }, { ...lookup, contested: { noul: 0.3 }, stakes: { noul: 0.65 } }, {}).inBand).toBe(false);
    expect(turnPlanActBand({ choice: 'quick', confidence: 0.9 }, { ...lookup, needs_live_web: { noul: 0.4 }, stakes: { noul: 0.65 } }, {}).inBand).toBe(false);
    expect(turnPlanActBand({ choice: 'quick', confidence: 0.9 }, { contested: { noul: 0.02 }, stakes: { noul: 0.65 } }, {}).inBand).toBe(false);
    // the rollback env restores the base ceiling in the ruler too
    expect(turnPlanActBand({ choice: 'quick', confidence: 0.9 }, { ...lookup, stakes: { noul: 0.65 } }, { TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING: '0.6' }).inBand).toBe(false);
  });
});

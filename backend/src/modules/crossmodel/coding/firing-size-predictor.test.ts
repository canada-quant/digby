/**
 * P5 (2026-10-04 coding option D step 2) — SHADOW firing-size predictor: the
 * pure decision (firing-size-predictor.ts) over the lane's last-5
 * run_tool_profile rows. Mirrors machine-firing-effort.test.ts's
 * trigger-kind / kill-switch pinning, then pins the full-biased decision
 * table: the predictor only ever says skip-finish on RECENCY (newest row a
 * no-op) AND a majority no-op window (≥3 of ≥5, or unanimous 2–4), and never
 * on thin data (0 or 1 rows). Shadow-only: no test here caps any seat — the
 * leaf's output is telemetry (a loop_metrics row), never an effort cap.
 */

import {
  firingPredictorApplies,
  predictFiringSize,
  FiringProfileRow,
} from './firing-size-predictor';

describe('firingPredictorApplies', () => {
  it('schedule and hook firings only — never a human turn, an agent send, an auto-resume or an owner dispatch', () => {
    expect(firingPredictorApplies({ triggerKind: 'schedule' })).toBe(true);
    expect(firingPredictorApplies({ triggerKind: 'hook' })).toBe(true);
    expect(firingPredictorApplies({ triggerKind: 'user' })).toBe(false);
    expect(firingPredictorApplies({ triggerKind: 'machine' })).toBe(false);
    expect(firingPredictorApplies({ triggerKind: 'schedule', ownerDispatch: true })).toBe(false);
    expect(firingPredictorApplies({ triggerKind: 'hook', ownerDispatch: true })).toBe(false);
  });
});

const noOp = (over: Partial<FiringProfileRow> = {}): FiringProfileRow => ({
  calls: 6, codeWrites: 0, gitWrites: 0, platformWrites: 0, machine: true, ...over,
});
const wrote = (over: Partial<FiringProfileRow> = {}): FiringProfileRow => ({
  calls: 30, codeWrites: 2, gitWrites: 0, platformWrites: 0, machine: true, ...over,
});

describe('predictFiringSize (full-biased: skip only on recency AND majority no-op)', () => {
  it('empty history ⇒ full + no_history (never skip on no data)', () => {
    expect(predictFiringSize({ history: [], triggerKind: 'schedule' })).toEqual({
      verdict: 'full',
      reason: 'no_history',
      from: { n: 0, noOps: 0, writes: 0, newestNoOp: false },
    });
  });

  it('a single row — even a no-op — is thin data ⇒ full', () => {
    const p = predictFiringSize({ history: [noOp()], triggerKind: 'schedule' });
    expect(p.verdict).toBe('full');
    expect(p.from).toEqual({ n: 1, noOps: 1, writes: 0, newestNoOp: true });
  });

  it('unanimous 2-row no-op window with newest no-op ⇒ skip-finish', () => {
    const p = predictFiringSize({ history: [noOp(), noOp()], triggerKind: 'hook' });
    expect(p).toEqual({
      verdict: 'skip-finish',
      reason: 'recent_majority_no_op_history',
      from: { n: 2, noOps: 2, writes: 0, newestNoOp: true },
    });
  });

  it('2-row window where the newest wrote ⇒ full (recency guard beats the older no-op)', () => {
    const p = predictFiringSize({ history: [noOp(), wrote()], triggerKind: 'schedule' });
    expect(p.verdict).toBe('full');
    expect(p.reason).toBe('no_op_minority_or_recent_write');
  });

  it('3 of 5 no-op with the newest no-op ⇒ skip-finish (majority + recency)', () => {
    const h = [wrote(), noOp(), noOp(), wrote(), noOp()];
    const p = predictFiringSize({ history: h, triggerKind: 'schedule' });
    expect(p.verdict).toBe('skip-finish');
    expect(p.from).toEqual({ n: 5, noOps: 3, writes: 2, newestNoOp: true });
  });

  it('2 of 5 no-op with the newest no-op ⇒ full (minority window)', () => {
    const h = [wrote(), wrote(), wrote(), noOp(), noOp()];
    const p = predictFiringSize({ history: h, triggerKind: 'schedule' });
    expect(p.verdict).toBe('full');
    expect(p.from).toEqual({ n: 5, noOps: 2, writes: 3, newestNoOp: true });
  });

  it('3 of 5 no-op but the NEWEST wrote ⇒ full (recency guard)', () => {
    const h = [noOp(), noOp(), noOp(), wrote(), wrote()];
    const p = predictFiringSize({ history: h, triggerKind: 'schedule' });
    expect(p.verdict).toBe('full');
    expect(p.reason).toBe('no_op_minority_or_recent_write');
    expect(p.from.newestNoOp).toBe(false);
  });

  it('every write counter counts — codeWrites, gitWrites and platformWrites each mark a row as wrote', () => {
    expect(predictFiringSize({ history: [noOp(), noOp({ gitWrites: 1 })], triggerKind: 'schedule' }).verdict).toBe('full');
    expect(predictFiringSize({ history: [noOp(), noOp({ platformWrites: 2 })], triggerKind: 'schedule' }).verdict).toBe('full');
    expect(predictFiringSize({ history: [noOp(), noOp({ codeWrites: 1 })], triggerKind: 'schedule' }).verdict).toBe('full');
  });

  it('null / missing counters read as 0 and a garbage null row counts as WROTE (unproven never feeds a skip — full-biased)', () => {
    const p = predictFiringSize({ history: [{}, null as any, { calls: 3 }], triggerKind: 'schedule' });
    expect(p.verdict).toBe('full');
    expect(p.reason).toBe('no_op_minority_or_recent_write');
    expect(p.from).toEqual({ n: 3, noOps: 2, writes: 1, newestNoOp: true });
    // the two empty-object no-op rows would be a majority without the garbage row — still full
    expect(predictFiringSize({ history: [{}, { calls: 3 }], triggerKind: 'schedule' }).verdict).toBe('skip-finish');
  });
});

/**
 * Operator iteration 11 (2026-09-25) — coding-lane twin of
 * platform/action-verifier.iter11-estimate-clock.test.ts: an estimate/
 * deadline-governed forward clock ("~6:20 PM PDT", "by ~11:45 AM PDT") is not
 * an impossible observation; completed-work frames still convict.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => 'tok') }));

import { findFutureDatedClaims, estimateGovernedStamp } from './run-evidence-guard';

describe('estimate/deadline-governed forward clocks — coding lane (operator iteration 11)', () => {
  const NOW_0111 = new Date('2026-09-25T01:11:23.969Z');
  const NOW_1802 = new Date('2026-09-23T18:02:28.991Z');

  it('"~6:20 PM PDT — speed verdict (automatic)" is an estimate, not an observation', () => {
    expect(findFutureDatedClaims('- ~6:20 PM PDT — tt-rd speed verdict (automatic)', NOW_0111)).toEqual([]);
  });

  it('"Verdict by ~11:45 AM PDT (18:45Z)" clears the estimate and its zone gloss', () => {
    expect(findFutureDatedClaims('| spark-cluster | Arena grid (5 of 7 steps) | Verdict by ~11:45 AM PDT (18:45Z) |', NOW_1802)).toEqual([]);
  });

  it('ANTI-SMUGGLE: "merged by ~18:45Z" and "at ~6:20 PM PDT I saw …" still convict', () => {
    expect(findFutureDatedClaims('PR #520 merged by ~18:45Z, all green.', NOW_1802)).toHaveLength(1);
    expect(findFutureDatedClaims('at ~6:20 PM PDT I saw the speed run finish clean', NOW_0111)).toHaveLength(1);
  });

  it('per-TOKEN: a co-line bare future clock still convicts', () => {
    const hits = findFutureDatedClaims('verdict ~6:20 PM PDT; box probe read 6:15 PM PDT clean', NOW_0111);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('6:15 PM PDT');
  });

  it('estimateGovernedStamp — unit shape', () => {
    const l = 'Verdict by ~11:45 AM PDT';
    expect(estimateGovernedStamp(l, l.indexOf('11:45'))).toBe(true);
    const m = 'merged by ~11:45 AM PDT';
    expect(estimateGovernedStamp(m, m.indexOf('11:45'))).toBe(false);
  });

  // ── Iteration 12 (FO firing 24, 2026-09-25 — prod strike 2da8766f 07:05:24Z,
  // the chat lane's incident; VERBATIM twin of the action-verifier detector).
  // Coding-lane note: the incident's clock-only stamps (+267/+305 min) sit
  // OUTSIDE this lane's 3h clock-only flagging window by design — the pins
  // below use within-3h clocks of the SAME shape, plus a unit-level check on
  // the verbatim incident line (estimateGovernedStamp is lane-independent).
  it('REPLAY i12 (unit, verbatim incident line): the governor at distance behind a noun phrase + date governs the clock', () => {
    const line = 'After TRAIN_DONE: comparator package → the coordinator\'s SFT-2 launch announcement (hand both p5s before block end Sep 26 11:30Z)';
    expect(estimateGovernedStamp(line, line.indexOf('11:30Z'))).toBe(true);
  });

  it('REPLAY i12 (in-window twin): "before … handoff <clock>" with the governor >24 chars back does not flag', () => {
    const NOW_0705 = new Date('2026-09-25T07:05:24.501Z');
    expect(findFutureDatedClaims(
      'After TRAIN_DONE: hand both p5s before the coordinator\'s block-end handoff 09:45Z',
      NOW_0705,
    )).toEqual([]);
  });

  it('i12: the distance window is bounded — a bare future clock past the span still convicts', () => {
    const NOW_0705 = new Date('2026-09-25T07:05:24.501Z');
    // No governor anywhere near the clock (and no intent word — "window"
    // would suppress the whole line at the line level): a long noun phrase alone does not exempt.
    const hits = findFutureDatedClaims('the coordinator\'s SFT-2 launch announcement and block-end release handoff 09:45Z', NOW_0705);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('09:45Z');
  });

  it('i12 ANTI-SMUGGLE: a completed-work verb earlier on the line still convicts through the distance window', () => {
    const NOW_0705 = new Date('2026-09-25T07:05:24.501Z');
    const hits = findFutureDatedClaims('Both p5 checks merged before the block end handoff 09:45Z', NOW_0705);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('09:45Z');
  });
});

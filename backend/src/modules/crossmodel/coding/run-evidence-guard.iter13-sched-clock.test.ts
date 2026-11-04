/**
 * Operator iteration 13 (FO firing 25, 2026-09-25) — coding-lane twin of
 * platform/action-verifier.iter13-sched-clock.test.ts: a forward clock that
 * PARAPHRASES a real enabled schedule's next firing time ("capacity decision
 * 12:08Z", an ETA cell's firing time) is not an impossible observation when
 * its instant matches the injected schedule-firing set within ±60s.
 * Prod strikes behind it: f5c2c1f4 10:26:33Z ("12:08Z" ↔ nextRunAt
 * 12:08:42.598Z, Δ 42.6 s) and c0e22e36 10:46:17Z ("7:31 AM PDT" ↔ nextRunAt
 * 14:31:29.410Z, Δ 29.4 s) — all post-iteration-12.
 *
 * Coding-lane note (same as iteration 11's twin): the canlegal-bench
 * incident's +229 min clock sits OUTSIDE this lane's 3 h clock-only flagging
 * window by design — the pins below use within-3h clocks of the SAME shape,
 * plus unit-level checks on the verbatim incident instant.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => 'tok') }));

import { findFutureDatedClaims, schedFiringGovernedStamp } from './run-evidence-guard';

describe('schedule-firing-time paraphrase clocks — coding lane (operator iteration 13, 2026-09-25)', () => {
  const NOW_1026 = new Date('2026-09-25T10:26:33.233Z');
  // The DB-verified firing instant from the f5c2c1f4 incident (inference
  // CHAIN-DECISION schedule nextRunAt 2026-09-25T12:08:42.598Z) and a second
  // armed firing for the multi-instant shape.
  const T_1208 = Date.parse('2026-09-25T12:08:42.598Z');
  const T_1130 = Date.parse('2026-09-25T11:30:42.000Z');
  const SCHEDS = [T_1130, T_1208];

  it('REPLAY 10:26Z (f5c2c1f4): "…drain trigger armed… capacity decision 12:08Z" matches the 12:08:42Z armed firing', () => {
    const line = 'both corrections landed, drain trigger armed on the SFT-2 launch announcement — capacity decision 12:08Z';
    // Base behavior first (no instants): the forward clock flags.
    expect(findFutureDatedClaims(line, NOW_1026)).toHaveLength(1);
    // With the schedule instants: the clock is a real armed firing time.
    expect(findFutureDatedClaims(line, NOW_1026, { scheduleFiringTimes: SCHEDS })).toEqual([]);
  });

  it('a digest ETA cell naming the firing time clears with the instants', () => {
    const line = '| inference | GPU block verified alive, paid through tomorrow | capacity decision 12:08Z |';
    expect(findFutureDatedClaims(line, NOW_1026)).toHaveLength(1);
    expect(findFutureDatedClaims(line, NOW_1026, { scheduleFiringTimes: SCHEDS })).toEqual([]);
  });

  it('a near-miss instant (61s off the armed firing) does not exempt — the window is ±60s', () => {
    const line = '| inference | GPU block verified alive | capacity decision 12:08Z |';
    expect(findFutureDatedClaims(line, NOW_1026, { scheduleFiringTimes: [T_1208 + 61_000] })).toHaveLength(1);
  });

  it('ANTI-SMUGGLE: a completed-work verb governing the clock through at/@ still flags', () => {
    const line = 'the capacity decision landed at 12:08Z with the block paid';
    expect(findFutureDatedClaims(line, NOW_1026, { scheduleFiringTimes: SCHEDS })).toHaveLength(1);
  });

  it('per-TOKEN: a co-line phantom clock with no matching firing still flags', () => {
    const line = 'capacity checkpoint 12:08Z; the box probe read 11:45Z clean';
    const base = findFutureDatedClaims(line, NOW_1026);
    expect(base).toHaveLength(2); // both forward clocks flag without instants
    const hits = findFutureDatedClaims(line, NOW_1026, { scheduleFiringTimes: SCHEDS });
    expect(hits).toHaveLength(1); // 12:08Z clears via the armed firing; 11:45Z has none
    expect(hits[0].stamp).toContain('11:45Z');
  });

  it('schedFiringGovernedStamp — unit shape (twin of the chat lane)', () => {
    const l = '| inference | capacity decision 12:08Z |';
    expect(schedFiringGovernedStamp(l, l.indexOf('12:08'), Date.parse('2026-09-25T12:08:00Z'), SCHEDS)).toBe(true); // instant within ±60s
    expect(schedFiringGovernedStamp(l, l.indexOf('12:08'), Date.parse('2026-09-25T12:08:00Z'), [])).toBe(false); // no instants
    expect(schedFiringGovernedStamp(l, l.indexOf('12:08'), Date.parse('2026-09-25T13:08:00Z'), SCHEDS)).toBe(false); // instant mismatch
    // The verbatim incident instant (12:08:42.598Z, Δ 42.6 s from a "12:08Z" token).
    expect(schedFiringGovernedStamp(l, l.indexOf('12:08'), Date.parse('2026-09-25T12:08:42.598Z'), SCHEDS)).toBe(true);
    const m = 'the capacity decision landed at 12:08Z';
    expect(schedFiringGovernedStamp(m, m.indexOf('12:08'), Date.parse('2026-09-25T12:08:42.598Z'), SCHEDS)).toBe(false); // verb-governed
  });

  // ── Iteration 13b (supervisor steer 12:19Z): the line-leading
  // "After <EVENT>:" forward-plan cue — coding-lane twin. The prod incident
  // clocks (+267/+305) sit outside this lane's 3h window; the pins use
  // within-3h twins of the same shape.
  it('REPLAY i13b: a line-leading "After <EVENT>: … <clock>" forward plan does not flag (cue-only twin — no estimate governor)', () => {
    const NOW_0705 = new Date('2026-09-25T07:05:24.501Z');
    expect(findFutureDatedClaims(
      'After TRAIN_DONE: comparator package → the SFT-2 launch announcement (drain trigger) 09:45Z',
      NOW_0705,
    )).toEqual([]);
  });

  it('i13b ANTI-SMUGGLE: a completed-work verb on the line still flags ("After the audit: verified 08:30Z")', () => {
    const NOW_0705 = new Date('2026-09-25T07:05:24.501Z');
    // The comma suffix keeps the lane's pre-existing schedule-SUBJECT path out
    // of the picture (a subject-noun suffix after the stamp is that path's
    // own exemption, not this cue's) — this pin isolates the cue's bound.
    expect(findFutureDatedClaims(
      'After the audit: verified 08:30Z, all five criteria green',
      NOW_0705,
    )).toHaveLength(1);
  });
});

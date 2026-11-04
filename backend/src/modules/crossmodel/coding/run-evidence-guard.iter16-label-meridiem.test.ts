/**
 * Operator iteration 16 (FO firing 27, 2026-09-26) — coding-lane twin of
 * platform/action-verifier.iter16-label-meridiem.test.ts: a fused forecast-
 * label subject ("Training done ~8:30–9:00 AM PDT") and a meridiem range
 * start ("~11:35 AM–12:05 PM PDT") are exempt; connector frames and unmarked
 * ranges still convict.
 *
 * CODING-LANE NOTE: the prod strikes (c0e22e36 10:52/11:18/12:14Z) rode the
 * PLATFORM lane, which flags clock-only stamps hours ahead; this lane's
 * clock-only pass is bounded by FUTURE_CLOCK_ONLY_MAX_AHEAD_MS, so the replays
 * here use the SAME SHAPES at a NOW that puts every token inside the window
 * (NOW 16:00Z = 9:00 AM PDT; all tokens +35..+125 min) — the exemption logic
 * under test is identical (verbatim twins).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => 'tok') }));

import { findFutureDatedClaims } from './run-evidence-guard';

const NOW = new Date('2026-09-26T16:00:00Z'); // 9:00 AM PDT — every token below is +35..+125 min

describe('forecast-label subjects + meridiem range starts — coding lane (operator iteration 16)', () => {
  it('REPLAY SHAPE 10:52Z/11:18Z: "Training done ~8:30–9:00 AM PDT" (fused label + tilde range) clears', () => {
    expect(findFutureDatedClaims('Smoke run: 1 of 6 rounds banked, round 2 underway. Training done ~9:35–10:05 AM PDT, verdict late morning.', NOW)).toEqual([]);
  });

  it('REPLAY SHAPE 12:14Z: "Done ~9:35–10:05 AM PDT" (capitalized fused label) clears', () => {
    expect(findFutureDatedClaims('Smoke run survived preempt #13, back training on round 2. Done ~9:35–10:05 AM PDT.', NOW)).toEqual([]);
  });

  it('REPLAY SHAPE 12:14Z: meridiem range start "verdict ~10:35 AM–11:05 AM PDT" clears the range end', () => {
    expect(findFutureDatedClaims('Smoke round 2 underway. verdict ~10:35 AM–11:05 AM PDT', NOW)).toEqual([]);
  });

  it('ANTI-SMUGGLE: the CONNECTOR frames still convict ("merged by ~", "verified through ~", "landed by ~")', () => {
    expect(findFutureDatedClaims('PR #1074 merged by ~9:35–10:05 AM PDT, all checks green.', NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('Audit verified through ~10:05 AM PDT.', NOW)).toHaveLength(1);
    expect(findFutureDatedClaims('Capacity landed by ~11:05 AM PDT.', NOW)).toHaveLength(1);
  });

  it('ANTI-SMUGGLE: a co-line bare future clock still convicts next to a label range', () => {
    const hits = findFutureDatedClaims('Training done ~9:35–10:05 AM PDT; box probe read 9:55 AM PDT clean', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('9:55 AM PDT');
  });

  it('ANTI-SMUGGLE: an UNMARKED meridiem range still convicts ("stayed green across 10:35 AM–11:05 AM PDT")', () => {
    const hits = findFutureDatedClaims('Serving stayed green across 10:35 AM–11:05 AM PDT during the soak', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('11:05 AM PDT');
  });
});

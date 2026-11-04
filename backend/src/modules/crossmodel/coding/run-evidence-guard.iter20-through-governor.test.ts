/**
 * Operator iteration 20 (FO firing 29, 2026-09-26) — coding-lane twin of
 * platform/action-verifier.iter20-through-governor.test.ts: a span/validity
 * governor ("capacity block paid through <future ISO>") is exempt; the
 * completed-work connector frames and "at"-connected clocks still convict.
 *
 * CODING-LANE NOTE: the prod strike (c0e22e36 18:44:21Z) rode the PLATFORM
 * lane, which flags clock-only stamps hours/days ahead; this lane's clock-only
 * pass is bounded by FUTURE_CLOCK_ONLY_MAX_AHEAD_MS, so the replays here use
 * the SAME SHAPES at a NOW that puts every token inside the window (NOW
 * 2026-09-26T22:00Z; tokens land 2026-09-27T00:30Z–03:00Z, ≤ +5h) — the
 * exemption logic under test is identical (verbatim twins).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => 'tok') }));

import { findFutureDatedClaims } from './run-evidence-guard';

const NOW = new Date('2026-09-26T22:00:00Z'); // tokens below land ≤ +5h ahead — inside this lane's window

describe('span/validity governor "through" — coding lane (operator iteration 20, 2026-09-26)', () => {
  it('SHAPE of the 18:44Z platform strike: "capacity block paid through <future ISO>" clears', () => {
    expect(findFutureDatedClaims('capacity block paid through 2026-09-27T01:30Z. Nothing needs the fleet.', NOW)).toEqual([]);
  });

  it('the bare shape clears with other subjects ("reservation is paid through <future ISO>")', () => {
    expect(findFutureDatedClaims('The reservation is paid through 2026-09-27T02:00Z.', NOW)).toEqual([]);
  });

  it('the ADJACENCY governor carries a tilde-prefixed stamp ("covered through ~<ISO>")', () => {
    expect(findFutureDatedClaims('Offsite copy covered through ~2026-09-27T03:00Z.', NOW)).toEqual([]);
  });

  it('BOUND (iter20): "through" at PHRASE distance does NOT govern ("paid through the end of the quarter <ISO>" convicts — adjacency-only)', () => {
    const hits = findFutureDatedClaims('The block is paid through the end of the quarter 2026-09-27T00:45Z.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('2026-09-27T00:45Z');
  });

  it('ANTI-SMUGGLE: the connector frame still convicts ("verified through ~<ISO>")', () => {
    const hits = findFutureDatedClaims('Audit verified through ~2026-09-27T02:30Z.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('2026-09-27T02:30Z');
  });

  it('ANTI-SMUGGLE: a completed-work verb near a through-governed clock still convicts', () => {
    const hits = findFutureDatedClaims('We verified through 2026-09-27T01:30Z on the box.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('2026-09-27T01:30Z');
  });

  it('ANTI-SMUGGLE: "at"-connected clocks stay unexempt ("went through the logs at 00:30Z")', () => {
    const hits = findFutureDatedClaims('We went through the logs at 2026-09-27T00:30Z and found nothing.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('2026-09-27T00:30Z');
  });

  it('ANTI-SMUGGLE: a co-line bare future clock still convicts next to the paid-window fact', () => {
    const hits = findFutureDatedClaims('capacity block paid through 2026-09-27T01:30Z; box probe read 23:45Z clean', NOW);
    expect(hits).toHaveLength(1);
  });
});

/**
 * Operator iteration 21 (FO firing 31, 2026-09-27) — coding-lane twin of
 * platform/action-verifier.iter21-block-end.test.ts: the reservation boundary
 * as a NOUN ("block end <future ISO>") and the informal "thru" span frame are
 * exempt; "at"-framed clocks, bare "end" / non-reservation nouns, and the
 * iter-20 connector/completed-work backstops still convict.
 *
 * CODING-LANE NOTE: the prod strike (2da8766f 03:42:28.587Z) rode the
 * PLATFORM lane, which flags clock-only stamps hours/days ahead; this lane's
 * clock-only pass is bounded by FUTURE_CLOCK_ONLY_MAX_AHEAD_MS, so the
 * replays here use the SAME SHAPES at a NOW that puts every token inside the
 * window (NOW 2026-09-27T02:00Z; tokens land 2026-09-27T04:30Z–05:00Z, ≤ +3h)
 * — the exemption logic under test is identical (verbatim twins).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => 'tok') }));

import { findFutureDatedClaims } from './run-evidence-guard';

const NOW = new Date('2026-09-27T02:00:00Z'); // tokens below land ≤ +3h ahead — inside this lane's window

describe('reservation-noun end boundary + "thru" span — coding lane (operator iteration 21, 2026-09-27)', () => {
  it('SHAPE of the 03:42Z platform strike: "…or block end <future ISO> (future, block EndDate)" clears', () => {
    expect(findFutureDatedClaims('Idle-cadence ruling: ec29c9f6 waits for the launch signal or block end 2026-09-27T04:30Z (future, block EndDate). Do not retire before either.', NOW)).toEqual([]);
  });

  it('the premise-receipt spelling clears ("PURCHASED cbe-…, block end <future ISO>")', () => {
    expect(findFutureDatedClaims('premise corrected: PURCHASED cbe-067018e8 payment-succeeded 19:40:55Z, block end 2026-09-27T05:00Z (value 13953.41 unchanged)', NOW)).toEqual([]);
  });

  it('other reservation nouns + plurals + "end date" clear (adjacency)', () => {
    expect(findFutureDatedClaims('The lease end 2026-09-27T04:45Z frees the p5 nodes.', NOW)).toEqual([]);
    expect(findFutureDatedClaims('reservation end date 2026-09-27T04:30Z per the AWS receipt.', NOW)).toEqual([]);
    expect(findFutureDatedClaims('The reservations end 2026-09-27T05:00Z.', NOW)).toEqual([]);
  });

  it('the informal span spelling clears: "block paid thru <future ISO>"', () => {
    expect(findFutureDatedClaims('block paid thru 2026-09-27T04:30Z (future date, block EndDate)', NOW)).toEqual([]);
    expect(findFutureDatedClaims('capacity booked thru 2026-09-27T04:00Z.', NOW)).toEqual([]);
  });

  it('ANTI-SMUGGLE: "at"-framed future instants still convict ("idles at block end <ISO>")', () => {
    const hits = findFutureDatedClaims('The watch lane idles at block end 2026-09-27T04:30Z and re-checks hourly.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('2026-09-27T04:30Z');
  });

  it('ANTI-SMUGGLE: non-reservation nouns still convict ("Observation sweep end <ISO>")', () => {
    const a = findFutureDatedClaims('Observation sweep end 2026-09-27T04:30Z, all lanes green.', NOW);
    expect(a).toHaveLength(1);
    const b = findFutureDatedClaims('sprint end 2026-09-27T05:00Z', NOW);
    expect(b).toHaveLength(1);
  });

  it('ANTI-SMUGGLE: the iter-20 pins stay armed (phrase-distance "through"; connector; completed-work)', () => {
    const a = findFutureDatedClaims('The block is paid through the end of the quarter 2026-09-27T04:30Z.', NOW);
    expect(a).toHaveLength(1);
    const b = findFutureDatedClaims('Audit verified through ~2026-09-27T04:30Z.', NOW);
    expect(b).toHaveLength(1);
    const c = findFutureDatedClaims('We verified through 2026-09-27T04:30Z on the box.', NOW);
    expect(c).toHaveLength(1);
  });

  it('ANTI-SMUGGLE: a co-line bare future clock still convicts next to the boundary fact', () => {
    const hits = findFutureDatedClaims('block end 2026-09-27T04:30Z; box probe read 02:30Z clean', NOW);
    expect(hits).toHaveLength(1);
  });
});

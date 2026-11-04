/**
 * Operator iteration 14 (FO firing 22, 2026-09-25) — coding-lane twin of
 * platform/action-verifier.iter14-eta-range.test.ts: an estimate range's END
 * token ("~19:00–19:40Z") inherits the start's marker; "eta" is a marker
 * noun; unmarked ranges and completed-work frames still convict.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => 'tok') }));

import { findFutureDatedClaims } from './run-evidence-guard';

const NOW = new Date('2026-09-25T18:14:53.275Z');

describe('ETA + range-END estimate clocks — coding lane (operator iteration 14)', () => {
  it('REPLAY 18:14Z (true shape): "the shifted envelope ~19:00–19:40Z still leaves ample margin" clears', () => {
    expect(findFutureDatedClaims('Nothing needs the owner: 0 open questions, and the shifted envelope ~19:00–19:40Z still leaves ample margin.', NOW)).toEqual([]);
  });

  it('"eta" is a marker noun ("verdict ETA 19:40Z", "eta: 11:45 AM PDT")', () => {
    expect(findFutureDatedClaims('Comparator verdict ETA 19:40Z, then BUY relay.', NOW)).toEqual([]);
    expect(findFutureDatedClaims('eta: 11:45 AM PDT — speed verdict', NOW)).toEqual([]);
  });

  it('range-END inheritance: "verdict ~18:45–19:15Z" and "by ~7:00 to 7:30 PM PDT" clear both ends', () => {
    expect(findFutureDatedClaims('Recovery verdict ~18:45–19:15Z, watch continues.', NOW)).toEqual([]);
    expect(findFutureDatedClaims('Drain window by ~7:00 to 7:30 PM PDT, no owner card.', NOW)).toEqual([]);
  });

  it('ANTI-SMUGGLE: an UNMARKED range still convicts ("stayed green across 18:00–19:40Z")', () => {
    const hits = findFutureDatedClaims('Serving stayed green across 18:00–19:40Z during the soak.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('19:40Z');
  });

  it('ANTI-SMUGGLE: a completed-work verb earlier on the line still convicts ("merged by ~18:00–19:00Z")', () => {
    const hits = findFutureDatedClaims('PR #1074 merged by ~18:00–19:00Z, all checks green.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('19:00Z');
  });

  it('per-TOKEN: a co-line bare future clock still convicts next to an exempted range', () => {
    const hits = findFutureDatedClaims('envelope ~19:00–19:40Z; box probe read 19:35Z clean', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('19:35Z');
  });
});

/**
 * Ticket 0e7684e0 (mishap, 2026-09-27) — coding-lane twin of platform/
 * action-verifier.0e7684e0.test.ts (the verbatim-twin discipline): the
 * SPAN-BOUNDARY NOUN + "end(s)" governor ("block end <future stamp>") clears;
 * the iter20/i12 BOUND and ANTI-SMUGGLE shapes keep convicting.
 *
 * CODING-LANE NOTE (the firing-27 rule): this lane's clock-only pass is
 * bounded by FUTURE_CLOCK_ONLY_MAX_AHEAD_MS (~3h), so every clock-only
 * replay below is anchored at a NOW that puts the token INSIDE the window;
 * the exemption logic under test is identical (verbatim twins). ISO stamps
 * convict unbounded in this lane, so the ISO replays use the real future
 * instants.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => 'tok') }));

import { findFutureDatedClaims } from './run-evidence-guard';

describe('span-boundary noun "end" governor — coding lane (ticket 0e7684e0, iteration 21)', () => {
  const NOW = new Date('2026-09-27T03:42:28.397Z'); // the struck run's real clock

  it('SHAPE of the 03:42Z platform strike: "block end <future ISO>" clears', () => {
    expect(findFutureDatedClaims('monitor waits for CanLaw SFT-2 launch or block end 2026-10-03T11:30Z', NOW)).toEqual([]);
  });

  it('the bare shape clears with other span nouns ("reservation ends <future ISO>", "lease ends at <ISO>")', () => {
    expect(findFutureDatedClaims('The reservation ends 2026-10-04T00:00Z.', NOW)).toEqual([]);
    expect(findFutureDatedClaims('The lease ends at 2026-10-05T09:00Z.', NOW)).toEqual([]);
  });

  it('the clock-only form inside this lane\'s 3h window clears ("hold ends 06:00Z")', () => {
    expect(findFutureDatedClaims('hold ends 06:00Z', NOW)).toEqual([]);
  });

  it('the "at ~" form is DISCRIMINATING for the new arm (the bare-tilde arm\'s lookbehind blocks "at ~" — only the span-noun arm can exempt)', () => {
    // F6 (review): bare "~<stamp>" is already exempt via the pre-existing tilde
    // arm; "at ~<stamp>" is NOT (lookbehind (?<!\bat\s{0,3})) — this pin passes
    // ONLY if the new span-noun+end governor does the work.
    expect(findFutureDatedClaims('reservation ends at ~2026-09-27T06:00Z', NOW)).toEqual([]);
  });

  it('BOUND: a span noun ALONE is not a governor ("the capacity block <stamp>" convicts — the platform twin\'s pin)', () => {
    // F5 (review): coding-twin parity for the bare-span-noun conviction.
    const hits = findFutureDatedClaims('nothing moved in the capacity block 2026-10-03T11:30Z', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('2026-10-03T11:30Z');
  });

  it('BOUND (iter20): "the end of the quarter <stamp>" convicts ("the" is not a span noun)', () => {
    const hits = findFutureDatedClaims('The block is paid through the end of the quarter 2026-10-03T11:30Z.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('2026-10-03T11:30Z');
  });

  it('BOUND: a noun between "end" and the stamp breaks the governor ("the block end handoff 11:30Z" convicts — the i12 shape, clock inside this lane\'s 3h window)', () => {
    // Firing-27 rule: re-anchor NOW so the clock-only token sits INSIDE
    // FUTURE_CLOCK_ONLY_MAX_AHEAD_MS — at the 03:42Z strike clock 11:30Z is
    // +7h47m and this lane never flags it (the pin would pass vacuously).
    const NOW_IN = new Date('2026-09-27T09:07:00Z'); // 11:30Z = +2h23m — inside the window
    const hits = findFutureDatedClaims('Both p5 checks merged before the block end handoff 11:30Z', NOW_IN);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('11:30Z');
  });

  it('ANTI-SMUGGLE: a completed-work verb governing the boundary stamp still convicts ("verified the block end <stamp>")', () => {
    const hits = findFutureDatedClaims('We verified the block end 2026-10-03T11:30Z on the box.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('2026-10-03T11:30Z');
  });

  it('per-TOKEN: a co-line bare future clock still convicts next to an exempted boundary stamp', () => {
    const hits = findFutureDatedClaims('block end 2026-10-03T11:30Z; box probe read 04:50Z clean', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].stamp).toContain('04:50Z');
  });
});

/**
 * Ticket 0e7684e0 (mishap, 2026-09-27) — replay of the 03:42:28Z prod strike
 * on chat 2da8766f (action-verifier, ENFORCED reject-back, containedPreDelivery):
 * the sweep note's Board line named the CanLaw capacity block's reservation END
 * in NOUN form — "monitor waits for CanLaw SFT-2 launch or block end
 * 2026-10-03T11:30Z" — and the ISO token struck +9108 min. It is the SAME
 * reservationEndsAt instant operator iteration 20 cleared in VERB form
 * ("capacity block paid through 2026-10-03T11:30Z"), with no future-intent
 * word anywhere on the line: a present fact about a lease boundary, not an
 * observation of the future.
 *
 * Fix (iteration 21): the SPAN-BOUNDARY NOUN + "end(s)" PAIR joins
 * ESTIMATE_BEFORE_STAMP_RE as an ADJACENCY-ONLY governor (VERBATIM twin in
 * coding/run-evidence-guard.ts). "end" alone is NEVER a governor — the iter20
 * BOUND pin ("the end of the quarter"), the i12 ANTI-SMUGGLE pin ("the block
 * end handoff 11:30Z") and the bare-noun shapes keep convicting, re-pinned
 * here. Estimate exemption unconditional since 2026-11-02.
 */
const mockPrisma: any = { crossModelChat: { findUnique: jest.fn(async () => null) }, $queryRawUnsafe: jest.fn(async () => []) };
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 't-1' } })) }));
jest.mock('./supervisor-state.service', () => ({ __esModule: true, getSupervisorState: jest.fn(async () => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] })), appendVerifierRefutation: jest.fn(async () => {}) }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import { findFutureObservedTimestamps } from './action-verifier';

describe('span-boundary noun "end" governor (ticket 0e7684e0, iteration 21, 2026-09-27)', () => {
  const NOW = new Date('2026-09-27T03:42:28.397Z'); // the struck run's real clock

  it('REPLAY 03:42Z: the Board line quoting the block-end boundary in NOUN form clears', () => {
    expect(findFutureObservedTimestamps(
      'Board @03:39Z: goal acc90864 active (2/4 todos done), 0 open owner questions, nothing running in this project. Idle-cadence ruling stands in the state doc: monitor waits for CanLaw SFT-2 launch or block end 2026-10-03T11:30Z.',
      NOW,
    )).toEqual([]);
  });

  it('the bare shape clears without the Board dressing ("block end <future ISO>")', () => {
    expect(findFutureObservedTimestamps('monitor waits for CanLaw SFT-2 launch or block end 2026-10-03T11:30Z', NOW)).toEqual([]);
    expect(findFutureObservedTimestamps('The reservation ends 2026-10-04T00:00Z.', NOW)).toEqual([]);
    expect(findFutureObservedTimestamps('The lease ends at 2026-10-05T09:00Z.', NOW)).toEqual([]);
    expect(findFutureObservedTimestamps('cooldown ends ~2026-09-27T06:00Z', NOW)).toEqual([]);
  });

  it('the clock-only form of the same boundary clears too ("block end 11:30Z" pinned to its date)', () => {
    // i12 shape minus the distance governor: the noun+end pair sits adjacent to the bare clock
    expect(findFutureObservedTimestamps('monitor waits for launch or block end 11:30Z on Oct 3', NOW)).toEqual([]);
  });

  it('BOUND: a noun between "end" and the stamp breaks the governor ("the block end handoff <clock>" convicts — the i12 ANTI-SMUGGLE shape)', () => {
    const hits = findFutureObservedTimestamps('Both p5 checks merged before the block end handoff 11:30Z', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('11:30Z');
  });

  it('BOUND: "the end of the quarter <stamp>" convicts ("the" is not a span noun — the iter20 pin, re-pinned)', () => {
    const hits = findFutureObservedTimestamps('The block is paid through the end of the quarter 2026-10-03T11:30Z.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('2026-10-03T11:30Z');
  });

  it('BOUND: a span noun ALONE is not a governor ("the capacity block <stamp>" convicts)', () => {
    const hits = findFutureObservedTimestamps('nothing moved in the capacity block 2026-10-03T11:30Z', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('2026-10-03T11:30Z');
  });

  it('ANTI-SMUGGLE: a completed-work verb governing the boundary stamp still convicts ("verified the block end <stamp>")', () => {
    const hits = findFutureObservedTimestamps('We verified the block end 2026-10-03T11:30Z on the box.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('2026-10-03T11:30Z');
  });

  it('per-TOKEN: a co-line bare future clock still convicts next to an exempted boundary stamp', () => {
    const hits = findFutureObservedTimestamps('block end 2026-10-03T11:30Z; box probe read 04:50Z clean', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('04:50Z');
  });
});

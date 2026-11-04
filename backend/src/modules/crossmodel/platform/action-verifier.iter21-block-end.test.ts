/**
 * Operator iteration 21 (FO firing 31, 2026-09-27) — the reservation boundary
 * spelled as a NOUN ("block end <future ISO>") and the informal "thru" span
 * frame are NOT impossible observations.
 *
 * Incident (2da8766f 03:42:28.587Z, ENFORCED reject-back, citationRetry
 * still_dirty — POST iter-20 deploy 03:10:28Z):
 *   "- Idle-cadence ruling recorded in state doc: ec29c9f6 is NOT retireable —
 *    it waits for a real external event (CanLaw SFT-2 launch → handback + drain,
 *    or block end 2026-10-03T11:30Z (future, block EndDate))"
 *   — token "2026-10-03T11:30Z" +9109 min. The chat's own registered premise
 *   (goal acc90864) is source evidence the token is a REAL boundary:
 *   "PURCHASED cbe-067018e84ab483a59 payment-succeeded 19:40:55Z, block end
 *   2026-10-03T11:30Z (value 13953.41 unchanged, no drift)" — the
 *   reservationEndsAt class, like "valid until". The same chat also spells the
 *   span frame informally ("block paid thru 2026-10-03T11:30Z"), which the
 *   iter-20 "through" governor missed.
 *
 * Fixed VERBATIM in both twins: (a) the span-subject pair accepts
 * thr(ough|u); (b) a RESERVATION NOUN (block/lease/reservation, optional
 * plural, optional "date") + "end" joins the adjacency-only governor with the
 * "at" lookbehind. ANTI-SMUGGLE: "at"-framed future instants still convict;
 * bare "end" / non-reservation nouns ("Observation window end") still convict;
 * the iter-20 connector and completed-work backstops stay armed.
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

describe('reservation-noun end boundary + "thru" span (operator iteration 21, 2026-09-27)', () => {
  const NOW = new Date('2026-09-27T03:42:28.587Z'); // the strike's real clock

  it('REPLAY 03:42Z: "…or block end 2026-10-03T11:30Z (future, block EndDate)" clears (present fact about a lease boundary)', () => {
    expect(findFutureObservedTimestamps('- Idle-cadence ruling recorded in state doc: ec29c9f6 is NOT retireable — it waits for a real external event (CanLaw SFT-2 launch → handback + drain, or block end 2026-10-03T11:30Z (future, block EndDate)). Do not retire before either.', NOW)).toEqual([]);
  });

  it('the premise-receipt spelling clears: "PURCHASED cbe-…, block end 2026-10-03T11:30Z (value 13953.41 unchanged, no drift)"', () => {
    expect(findFutureObservedTimestamps('premise note corrected: offering cbe-0632546d6878cd15c → PURCHASED cbe-067018e84ab483a59 payment-succeeded 19:40:55Z, block end 2026-10-03T11:30Z (value 13953.41 unchanged, no drift)', NOW)).toEqual([]);
  });

  it('other reservation nouns + plurals + "end date" clear (adjacency)', () => {
    expect(findFutureObservedTimestamps('The lease end 2026-10-05T00:00Z frees the p5 nodes back to the pool.', NOW)).toEqual([]);
    expect(findFutureObservedTimestamps('reservation end date 2026-10-03T11:30Z per the AWS receipt.', NOW)).toEqual([]);
    expect(findFutureObservedTimestamps('The reservations end 2026-10-10T00:00Z.', NOW)).toEqual([]);
  });

  it('the informal span spelling clears: "block paid thru <future ISO>"', () => {
    expect(findFutureObservedTimestamps('block paid thru 2026-10-03T11:30Z (future date, block EndDate)', NOW)).toEqual([]);
    expect(findFutureObservedTimestamps('capacity booked thru 2026-10-01T04:00Z.', NOW)).toEqual([]);
  });

  it('ANTI-SMUGGLE: "at"-framed future instants still convict ("idles at block end <ISO>")', () => {
    const hits = findFutureObservedTimestamps('The watch lane idles at block end 2026-10-03T11:30Z and re-checks hourly.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('2026-10-03T11:30Z');
  });

  it('ANTI-SMUGGLE: non-reservation nouns still convict ("Observation sweep end <ISO>" / "sprint end <ISO>")', () => {
    const a = findFutureObservedTimestamps('Observation sweep end 2026-10-03T11:30Z, all lanes green.', NOW);
    expect(a).toHaveLength(1);
    expect(a[0].token).toContain('2026-10-03T11:30Z');
    const b = findFutureObservedTimestamps('sprint end 2026-10-03T11:30Z', NOW);
    expect(b).toHaveLength(1);
  });

  it('ANTI-SMUGGLE: the iter-20 pins stay armed (phrase-distance "through" convicts; connector + completed-work still convict)', () => {
    const a = findFutureObservedTimestamps('The block is paid through the end of the quarter 2026-10-03T11:30Z.', NOW);
    expect(a).toHaveLength(1);
    const b = findFutureObservedTimestamps('Audit verified through ~10:05 PM PDT.', NOW);
    expect(b).toHaveLength(1);
    const c = findFutureObservedTimestamps('We verified through 2026-10-03T11:30Z on the box.', NOW);
    expect(c).toHaveLength(1);
  });

  it('ANTI-SMUGGLE: a co-line bare future clock still convicts next to the boundary fact', () => {
    const hits = findFutureObservedTimestamps('block end 2026-10-03T11:30Z; box probe read 04:30Z clean', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('04:30Z');
  });
});

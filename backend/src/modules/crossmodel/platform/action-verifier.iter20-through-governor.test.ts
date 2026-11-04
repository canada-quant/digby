/**
 * Operator iteration 20 (FO firing 29, 2026-09-26) — span/validity governors
 * ("through") are NOT impossible observations.
 *
 * Incident (c0e22e36 18:44:21.101Z, ENFORCED reject-back, 0 phantom claims —
 * the honest note's ISO token was stripped pre-delivery):
 *   "… capacity block paid through 2026-10-03T11:30Z. Nothing needs the
 *    fleet — FYI on the handback ETA slip only."
 *   — token "2026-10-03T11:30Z" +9647 min. The line is the supervisor's
 *   receipts quote of an upstream fact: the capacity block's PAID WINDOW ends
 *   at that instant (the reservationEndsAt concept) — a PRESENT fact about a
 *   lease boundary, like "valid until <date>", not a fabricated future
 *   observation. "through" was missing from the estimate-governor vocabulary
 *   (both the adjacency and the phrase RE), so the quoted boundary struck.
 *
 * Fixed VERBATIM in both twins: "through" joins the governor list; the
 * completed-work backstop stays armed ("verified through ~10:05 AM PDT" still
 * convicts — the iter16 pin), and the "at" lookbehind keeps
 * "went through the logs at 23:00Z" unexempt.
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

describe('span/validity governor "through" (operator iteration 20, 2026-09-26)', () => {
  const NOW = new Date('2026-09-26T18:44:21.101Z'); // the strike's real clock

  it('REPLAY 18:44Z: "capacity block paid through 2026-10-03T11:30Z" clears (present fact about a paid window)', () => {
    expect(findFutureObservedTimestamps('Inference side unchanged: GLM-5.3 serve green/idle on both p5 nodes, monitor cadence v2 next fire 18:42Z, capacity block paid through 2026-10-03T11:30Z. Nothing needs the fleet — FYI on the handback ETA slip only.', NOW)).toEqual([]);
  });

  it('the bare shape clears without the receipts dressing ("paid through <future ISO>")', () => {
    expect(findFutureObservedTimestamps('capacity block paid through 2026-10-03T11:30Z', NOW)).toEqual([]);
    expect(findFutureObservedTimestamps('The reservation is paid through 2026-10-10T00:00Z.', NOW)).toEqual([]);
  });

  it('the ADJACENCY governor carries a tilde-prefixed stamp too ("covered through ~2026-10-01")', () => {
    expect(findFutureObservedTimestamps('Offsite copy covered through ~2026-10-01T04:00Z.', NOW)).toEqual([]);
  });

  it('BOUND (iter20): "through" at PHRASE distance does NOT govern ("paid through the end of the quarter <ISO>" convicts — adjacency-only)', () => {
    const hits = findFutureObservedTimestamps('The block is paid through the end of the quarter 2026-10-03T11:30Z.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('2026-10-03T11:30Z');
  });

  it('ANTI-SMUGGLE: the iter16 connector pin still convicts ("Audit verified through ~10:05 PM PDT")', () => {
    const hits = findFutureObservedTimestamps('Audit verified through ~10:05 PM PDT.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('10:05 PM PDT');
  });

  it('ANTI-SMUGGLE: a completed-work verb near a through-governed clock still convicts ("verified through 2026-10-03T11:30Z")', () => {
    const hits = findFutureObservedTimestamps('We verified through 2026-10-03T11:30Z on the box.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('2026-10-03T11:30Z');
  });

  it('ANTI-SMUGGLE: "at"-connected clocks stay unexempt ("went through the logs at 23:00Z")', () => {
    const hits = findFutureObservedTimestamps('We went through the logs at 23:00Z and found nothing.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('23:00Z');
  });

  it('ANTI-SMUGGLE: a co-line bare future clock still convicts next to the paid-window fact', () => {
    const hits = findFutureObservedTimestamps('capacity block paid through 2026-10-03T11:30Z; box probe read 21:30Z clean', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('21:30Z');
  });
});

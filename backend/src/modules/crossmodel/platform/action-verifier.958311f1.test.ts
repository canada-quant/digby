/**
 * Ticket 958311f1 (mishap, 2026-09-30) — date-pinned past clock falsely flagged as future.
 *
 * Incident: chat edf5b3b3's machine-run final note was held (containedPreDelivery)
 * for the struck timestamp "02:22Z" — adjudged 127 min AHEAD of the run's real
 * clock (2026-09-30T00:15:28.871Z). The literal note line:
 *   "Board: goal 6f705aff active, 0 open todos, 0 open owner questions; premises
 *    unchanged since 09-29 02:22Z (interim v3b set) — all v3d numbers above are unregis…"
 *
 * The token "02:22Z" is explicitly pinned to its calendar date "09-29" — i.e.
 * 2026-09-29T02:22Z, ~22h BEFORE the note's real clock (a PAST observation,
 * explicitly dated, grammatically anchored by "since"). The detector resolved the
 * bare clock against `now`'s date (Sep 30) and, finding 02:22Z on Sep 30 still
 * ~2h in the future at 00:15Z, convicted an honestly-dated past reference as an
 * impossible future observation.
 *
 * Fix (this file replays the exact struck line): when a date pin of shape MM-DD
 * immediately precedes the clock token (e.g. "09-29 02:22Z"), the clock resolves
 * against the PINNED date, not against `now`'s date. A pin that lands the clock in
 * the past relative to `now` clears; a pin that genuinely lands the clock in the
 * future still convicts (the anti-smuggle half below).
 */
const mockPrisma: any = { crossModelChat: { findUnique: jest.fn(async () => null) }, $queryRawUnsafe: jest.fn(async () => []) };
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, default: { utilityChat: jest.fn(async () => '') } }));
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 't-1' } })) }));
jest.mock('./supervisor-state.service', () => ({ __esModule: true, getSupervisorState: jest.fn(async () => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] })), appendVerifierRefutation: jest.fn(async () => {}) }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import { findFutureObservedTimestamps } from './action-verifier';

describe('ticket 958311f1 — date-pinned past clock is not a future observation', () => {
  const NOW = new Date('2026-09-30T00:15:28.871Z'); // the run's real clock per the ticket

  it('REPLAY: the exact struck line ("since 09-29 02:22Z") clears — a dated PAST observation', () => {
    const line = '- Board: goal 6f705aff active, 0 open todos, 0 open owner questions; premises unchanged since 09-29 02:22Z (interim v3b set) — all v3d numbers above are unregistered';
    expect(findFutureObservedTimestamps(line, NOW)).toEqual([]);
  });

  it('date pin MM-DD one day behind now: "since 09-29 02:22Z" clears', () => {
    expect(findFutureObservedTimestamps('premises unchanged since 09-29 02:22Z (interim v3b set)', NOW)).toEqual([]);
  });

  it('ANTI-SMUGGLE: a pin that genuinely lands the clock in the FUTURE still convicts ("since 10-01 02:22Z")', () => {
    const hits = findFutureObservedTimestamps('premises unchanged since 10-01 02:22Z (interim v3b set)', NOW);
    expect(hits.length).toBe(1);
    expect(hits[0].token).toContain('02:22Z');
  });

  it('ANTI-SMUGGLE: a bare future clock with NO date pin still convicts ("02:22Z" alone at 00:15Z)', () => {
    const hits = findFutureObservedTimestamps('observation as of 02:22Z today', NOW);
    expect(hits.length).toBe(1);
    expect(hits[0].token).toContain('02:22Z');
  });
});

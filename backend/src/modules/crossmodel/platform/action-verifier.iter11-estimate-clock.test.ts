/**
 * Operator iteration 11 (2026-09-25) — estimate/deadline-governed forward
 * clocks are NOT impossible observations.
 *
 * Incidents (Fleet Supervisor c0e22e36, both honest sweep-table ETA cells):
 *   - 2026-09-25T01:11:23.969Z: "- ~6:20 PM PDT — tt-rd speed verdict
 *     (automatic)" struck +9 min; the reject-back retry stayed dirty and the
 *     honest wake note was REPLACED pre-delivery.
 *   - 2026-09-23T18:02:28.991Z: "| spark-cluster | … | Verdict by ~11:45 AM
 *     PDT (18:45Z) |" struck +43 min (both the estimate and its zone gloss).
 * Neither line carries a FUTURE_INTENT_RE word; the "~" / "by ~" frames are
 * the supervisor's canonical ETA idiom (the doctrine itself lists "ETA ~…").
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

import { findFutureObservedTimestamps, estimateGovernedStamp } from './action-verifier';

describe('estimate/deadline-governed forward clocks (operator iteration 11, 2026-09-25)', () => {
  const NOW_0111 = new Date('2026-09-25T01:11:23.969Z');
  const NOW_1802 = new Date('2026-09-23T18:02:28.991Z');

  it('REPLAY 01:11Z: "~6:20 PM PDT — tt-rd speed verdict (automatic)" is an estimate, not an observation', () => {
    expect(findFutureObservedTimestamps('- ~6:20 PM PDT — tt-rd speed verdict (automatic)', NOW_0111)).toEqual([]);
  });

  it('REPLAY 18:02Z: "Verdict by ~11:45 AM PDT (18:45Z)" clears the estimate AND its zone gloss', () => {
    const line = '| spark-cluster | Arena grid banking on your prod stack (5 of 7 steps) | Verdict by ~11:45 AM PDT (18:45Z) |';
    expect(findFutureObservedTimestamps(line, NOW_1802)).toEqual([]);
  });

  it('deadline prepositions without a tilde exempt too ("before 18:45Z", "no later than 7:00 PM PDT")', () => {
    expect(findFutureObservedTimestamps('Smoke verdict before 18:45Z; owner card if silent.', NOW_1802)).toEqual([]);
    expect(findFutureObservedTimestamps('CanLaw checkpoint no later than 7:00 PM PDT', NOW_0111)).toEqual([]);
  });

  it('a same-instant ISO estimate exempts ("by ~2026-09-25T04:26Z")', () => {
    expect(findFutureObservedTimestamps('fix experiment queued, verdict by ~2026-09-25T04:26Z', NOW_0111)).toEqual([]);
  });

  it('ANTI-SMUGGLE: a completed-work verb governing the stamp still convicts ("merged by ~18:45Z", "verified at ~15:03Z")', () => {
    expect(findFutureObservedTimestamps('PR #520 merged by ~18:45Z, all green.', NOW_1802)).toHaveLength(1);
    expect(findFutureObservedTimestamps('Audit verified through ~18:45Z.', NOW_1802)).toHaveLength(1);
  });

  it('ANTI-SMUGGLE: the bare "at ~<clock>" observation frame is NOT an estimate frame', () => {
    const hits = findFutureObservedTimestamps('at ~6:20 PM PDT I saw the speed run finish clean', NOW_0111);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('6:20 PM PDT');
  });

  it('per-TOKEN: a co-line bare future clock still convicts next to an exempted estimate', () => {
    const hits = findFutureObservedTimestamps('verdict ~6:20 PM PDT; box probe read 6:15 PM PDT clean', NOW_0111);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('6:15 PM PDT');
  });

  it('a gloss only inherits when adjacent and same-instant — a far or closed-paren twin stands on its own', () => {
    // closed paren → not a gloss of the estimate: "(done)" breaks inheritance and the trailing clock is a bare future observation.
    const hits = findFutureObservedTimestamps('verdict ~11:45 AM PDT (grid) — probe landed at 18:45Z', NOW_1802);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('18:45Z');
  });

  // ── Iteration 12 (FO firing 24, 2026-09-25 — prod strike 2da8766f 07:05:24Z)
  // ──
  // The deadline governor at DISTANCE: "hand both p5s before block end Sep 26
  // 11:30Z" — "before" governs the whole phrase "block end Sep 26 11:30Z" but
  // sits ~30 chars back behind the noun phrase + date, outside the i11
  // adjacency window (which sliced mid-word at "…efore block e"). The lane's
  // own reject-back retry had to relabel it " future" to pass.
  it('REPLAY i12 07:05Z: "before block end Sep 26 11:30Z" — a governor at distance behind a noun phrase + date — is a deadline, not an observation', () => {
    const NOW_0705 = new Date('2026-09-25T07:05:24.501Z');
    expect(findFutureObservedTimestamps(
      'After TRAIN_DONE: comparator package → the coordinator\'s SFT-2 launch announcement (hand both p5s before block end Sep 26 11:30Z)',
      NOW_0705,
    )).toEqual([]);
  });

  it('i12: the distance window is bounded — a bare future clock past the 60-char span still convicts', () => {
    const NOW_0705 = new Date('2026-09-25T07:05:24.501Z');
    // No governor anywhere near the clock (and no FUTURE_INTENT_RE word — "window"
    // would exempt the whole line at the line level): a long noun phrase alone does not exempt.
    const hits = findFutureObservedTimestamps('the coordinator\'s SFT-2 launch announcement and block-end release handoff 12:08Z', NOW_0705);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('12:08Z');
  });

  it('i12 ANTI-SMUGGLE: a completed-work verb earlier on the line still convicts through the distance window', () => {
    const NOW_0705 = new Date('2026-09-25T07:05:24.501Z');
    const hits = findFutureObservedTimestamps('Both p5 checks merged before the block end handoff 11:30Z', NOW_0705);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('11:30Z');
  });

  it('i12 ANTI-SMUGGLE: the bare "at" observation frame does not exempt at distance either', () => {
    const NOW_0705 = new Date('2026-09-25T07:05:24.501Z');
    const hits = findFutureObservedTimestamps('we watched the drain trigger at 11:30Z sharp', NOW_0705);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('11:30Z');
  });

  it('estimateGovernedStamp — unit shape', () => {
    const l = 'Verdict by ~11:45 AM PDT';
    expect(estimateGovernedStamp(l, l.indexOf('11:45'))).toBe(true);
    const m = 'merged by ~11:45 AM PDT';
    expect(estimateGovernedStamp(m, m.indexOf('11:45'))).toBe(false);
    const n = 'landed 11:45 AM PDT';
    expect(estimateGovernedStamp(n, n.indexOf('11:45'))).toBe(false);
  });
});

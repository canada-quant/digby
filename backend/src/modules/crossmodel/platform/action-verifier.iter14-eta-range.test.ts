/**
 * Operator iteration 14 (FO firing 22, 2026-09-25) — ETA + range-END estimate
 * clocks are NOT impossible observations.
 *
 * Incident (chat-lane 2da8766f, 2026-09-25T18:14:53.275Z, ENFORCED lane — the
 * reject-back REPLACED the honest note): "new TRAIN_DONE envelope **ETA
 * ~19:00–19:40Z** (capacity-dependent)" — the strike's clockHits token was
 * "19:40Z" +85 min. The "~" governs the WHOLE range but sat before the START;
 * the end token's 24-char window ends in the en-dash and "19:00"'s colons
 * block the iteration-12 phrase reach, so the honest range end was struck as
 * an impossible observation. The same note's Next line ("TRAIN_DONE ETA
 * ~19:00–19:40Z future → …") survived ONLY because it carried the literal
 * word "future" — a coin-flip, not a rule. And "ETA" itself was missing from
 * the marker vocabulary entirely.
 *
 * Fix (both lanes, verbatim twins): "eta" joins by/before/around/about/
 * roughly/circa/towards/no-later-than/nlt as a marker, and a RANGE-END token
 * (dash or "to" separator) inherits the range start's marker when the start
 * is itself estimate-governed. Bounds: an UNMARKED range still convicts; a
 * completed-work verb earlier on the line still convicts; per-TOKEN; kill
 * estimate exemption unconditional since 2026-11-02.
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

const NOW = new Date('2026-09-25T18:14:53.275Z'); // the strike's real clock

describe('ETA + range-END estimate clocks (operator iteration 14, 2026-09-25)', () => {
  it('REPLAY 18:14Z (true shape, intent-free line): "…and the shifted envelope ~19:00–19:40Z still leaves ample margin" — the tilde governs the WHOLE range', () => {
    // The struck line carried no FUTURE_INTENT word (the delivered variant kept
    // the word "future"; the summary line did not) — the bare tilde range end
    // was the only tell, and iteration 11 did not reach it.
    const line = 'Nothing needs the owner: 0 open owner questions, serving GREEN through the block end, and the shifted envelope ~19:00–19:40Z still leaves ample margin for a BUY-on-PASS.';
    expect(findFutureObservedTimestamps(line, NOW)).toEqual([]);
  });

  it('REPLAY (Next-line shape without the word "future"): "TRAIN_DONE ~19:00–19:40Z → comparator verdict" clears without the intent word', () => {
    expect(findFutureObservedTimestamps('Next: TRAIN_DONE ~19:00–19:40Z → comparator verdict → on PASS + launch relay: BUY 7d.', NOW)).toEqual([]);
  });

  it('range-END inheritance: "verdict ~18:45–19:15Z" and "by ~7:00 to 7:30 PM PDT" clear both ends', () => {
    expect(findFutureObservedTimestamps('Recovery verdict ~18:45–19:15Z, watch continues.', NOW)).toEqual([]);
    expect(findFutureObservedTimestamps('Drain window by ~7:00 to 7:30 PM PDT, no owner card.', NOW)).toEqual([]);
  });

  it('ANTI-SMUGGLE: an UNMARKED range still convicts ("stayed green across 18:00–19:40Z")', () => {
    const hits = findFutureObservedTimestamps('Serving stayed green across 18:00–19:40Z during the soak.', NOW);
    expect(hits).toHaveLength(1); // the zoned range end is a bare future clock (no marker governs the start)
    expect(hits[0].token).toContain('19:40Z');
  });

  it('ANTI-SMUGGLE: a completed-work verb earlier on the line still convicts ("merged by ~18:00–19:00Z")', () => {
    const hits = findFutureObservedTimestamps('PR #1074 merged by ~18:00–19:00Z, all checks green.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('19:00Z');
  });

  it('ANTI-SMUGGLE: a zoned range start does not launder an unmarked range ("at 18:00Z–19:40Z")', () => {
    const hits = findFutureObservedTimestamps('saw it at 18:00Z–19:40Z during the soak', NOW);
    expect(hits.length).toBeGreaterThanOrEqual(1); // the end token has no governed start
  });

  it('per-TOKEN: a co-line bare future clock still convicts next to an exempted range', () => {
    const hits = findFutureObservedTimestamps('envelope ~19:00–19:40Z; box probe read 19:35Z clean', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('19:35Z');
  });
});

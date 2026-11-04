/**
 * Operator iteration 24 (FO firing 34, 2026-09-27) — the DECISION-INSTANT noun
 * "checkpoint" is not an impossible observation.
 *
 * Incident (4 strikes in 4h, all ENFORCED reject-backs — POST iter-23 deploy
 * wave 36317805226 completed 12:32:53Z, all boxes on cf4fba36):
 *   f5c2c1f4 11:40:52.356Z — "- Fleet report-up sent: S2V15 launched + first-loss
 *     evidence, coordinator 18:00Z checkpoint — receipt 510d5048" (token "18:00Z" +379m)
 *   f5c2c1f4 12:05:13.709Z — "**Needs the owner:** Nothing — 0 open owner questions;
 *     the 18:00Z escalation checkpoint (priced non-preemptible fallback) is
 *     coordinator-owned …" (+355m)
 *   615723ba 13:31:00.374Z — "No action needed this wake: … Coordinator's 18:00Z
 *     escalation checkpoint and 09-2…" (+269m)
 *   f5c2c1f4 14:25:51.856Z — "**Needs the owner:** nothing — 0 open owner questions on
 *     the board; the 18:00Z checkpoint (cheapest non-preemptible capacity purchase
 *     under the 2026-09-10 grant …" (+214m)
 * A checkpoint time is a scheduled future decision instant — the same ledger
 * register as `deadline` ("deadline 2026-10-03T11:30Z" already exempted,
 * iter-14 lineage) and the coding lane's schedule-subject nouns
 * (run-evidence-guard.ts tickets 2884edba / ca153ef8 / 10ee7161, which
 * enumerate "checkpoint" and INVERTED their gate to exemption-by-default).
 * Each reject-back cost a full bounded re-orchestration of an honest note.
 *
 * Fixed: `checkpoints?` joins FUTURE_INTENT_RE; machine-wake rule 8 teaches
 * the "18:00Z checkpoint" label so the preamble↔detector drift guard keeps
 * the two vocabularies pinned.
 *
 * ANTI-SMUGGLE (the register is NOUN-only): past-tense "checkpointed"/
 * "checked"/"re-checked" and bare "check" do NOT join the list — a completed-
 * work verb pinned to a future stamp is the phantom class and still convicts.
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
import { machineWakePreamble } from '../chat-agent/machine-wake';

describe('decision-instant "checkpoint" noun (operator iteration 24, 2026-09-27)', () => {
  const NOW = new Date('2026-09-27T14:25:51.856Z'); // the newest strike's real clock

  it('REPLAY 14:25Z (f5c2c1f4): "…the 18:00Z checkpoint (cheapest non-preemptible capacity purchase…" clears', () => {
    expect(findFutureObservedTimestamps('**Needs the owner:** nothing — 0 open owner questions on the board; the 18:00Z checkpoint (cheapest non-preemptible capacity purchase under the 2026-09-10 grant) is coordinator-owned', NOW)).toEqual([]);
  });

  it('REPLAY 12:05Z (f5c2c1f4): "…the 18:00Z escalation checkpoint (priced non-preemptible fallback)…" clears', () => {
    expect(findFutureObservedTimestamps('**Needs the owner:** Nothing — 0 open owner questions; the 18:00Z escalation checkpoint (priced non-preemptible fallback) is coordinator-owned and falls under prior approval.', NOW)).toEqual([]);
  });

  it('REPLAY 13:31Z (615723ba): "…Coordinator\'s 18:00Z escalation checkpoint and 09-2…" clears', () => {
    expect(findFutureObservedTimestamps("No action needed this wake: both lanes armed with correct runbooks, cadence healthy, no deaf lane, no drift. Coordinator's 18:00Z escalation checkpoint and 09-2 owner call stand.", NOW)).toEqual([]);
  });

  it('REPLAY 11:40Z (f5c2c1f4): "…coordinator 18:00Z checkpoint — receipt 510d5048" clears (the receipt is real, the checkpoint is forward)', () => {
    expect(findFutureObservedTimestamps('- Fleet report-up sent: S2V15 launched + first-loss evidence, coordinator 18:00Z checkpoint — receipt 510d5048', NOW)).toEqual([]);
  });

  it('plural and other spellings: "checkpoints at 19:05Z / 01:04Z" clear (adjacent-to-token line-level exemption, noun register)', () => {
    expect(findFutureObservedTimestamps('the runbook schedules checkpoints at 19:05Z and 01:04Z; both before the deadline.', NOW)).toEqual([]);
  });

  it('ANTI-SMUGGLE: "checkpointed at <future stamp>" (completed-work verb) still convicts', () => {
    const hits = findFutureObservedTimestamps('the tally was checkpointed at 2026-09-27T22:00:00Z with md5 confirmed', NOW);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].token).toContain('22:00:00');
  });

  it('ANTI-SMUGGLE: "checked"/"re-checked" do not shield a future stamp (not on the list)', () => {
    expect(findFutureObservedTimestamps('box health re-checked 2026-09-27T23:30:00Z — all green', NOW).length).toBeGreaterThan(0);
    expect(findFutureObservedTimestamps('checked the probe at 2026-09-28T00:15:00Z, verified', NOW).length).toBeGreaterThan(0);
  });

  it('ANTI-SMUGGLE: a future stamp with NO future-intent noun on the line still convicts (the exemption is not global)', () => {
    const hits = findFutureObservedTimestamps('Audit complete — verified through 2026-09-27T20:00:00Z', NOW);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('preamble ↔ detector drift guard holds: the taught "18:00Z checkpoint" label example never convicts', () => {
    // rule 8 now teaches "18:00Z checkpoint" as an accepted label — run the
    // FULL preamble through the detector so the two vocabularies cannot
    // diverge silently (the 2026-08-31 whack-a-mole breaker, extended).
    expect(findFutureObservedTimestamps(machineWakePreamble(NOW), NOW)).toEqual([]);
  });
});

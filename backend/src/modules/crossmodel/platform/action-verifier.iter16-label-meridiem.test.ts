/**
 * Operator iteration 16 (FO firing 27, 2026-09-26) — forecast-label subjects
 * and meridiem range starts are NOT impossible observations.
 *
 * Incidents (Fleet Supervisor c0e22e36, ENFORCED lane, 0 phantom claims, each
 * honest note replaced pre-delivery; lineage-verified on i15-containing code —
 * box sha at each strike: 6e299aa5 → 71df5766 → 409a9be6, all descend c98e1bc02):
 *   - 10:52:41.737Z: "| CanLaw | Smoke run: 1 of 6 rounds banked, round 2
 *     underway, GPU 97–100% | Training done ~8:30–9:00 AM PDT, verdict
 *     ~10:30–11:30 AM PDT |" — token "9:00 AM PDT" +313 min.
 *   - 11:18:46.646Z: "| CanLaw | Smoke training healthy into round 2 (reported
 *     10:51Z) | training done ~8:30–9:00 AM PDT, verdict late morning |" —
 *     token "9:00 AM PDT" +285 min.
 *   - 12:14:16.420Z: "| CanLaw | Smoke run survived preempt #13 with zero data
 *     loss, back training on round 2 | Done ~9:35–10:05 AM PDT, verdict
 *     ~11:35 AM–12:05 PM PDT |" — tokens "10:05 AM PDT" +297 and
 *     "12:05 PM PDT" +417.
 *
 * Two defects (both fixed verbatim in the twins):
 *   1. FUSED FORECAST LABEL: "Training done ~8:30–9:00 AM PDT" — the status
 *      predicate fused directly to its own marker is the forecast's SUBJECT,
 *      but the i15 same-clause backstop convicted it (no clause severance
 *      between "done" and "~"). Observation frames carry a CONNECTOR between
 *      verb and marker ("merged by ~") — the label test refuses to mask that.
 *   2. MERIDIEM RANGE START: "~11:35 AM–12:05 PM PDT" — RANGE_START_TOKEN_RE
 *      was digit-anchored, so "11:35 AM" (ends in AM) never let the range end
 *      inherit the marker at all.
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

describe('forecast-label subjects + meridiem range starts (operator iteration 16, 2026-09-26)', () => {
  const NOW_1052 = new Date('2026-09-26T10:52:41.737Z');
  const NOW_1118 = new Date('2026-09-26T11:18:46.646Z');
  const NOW_1214 = new Date('2026-09-26T12:14:16.420Z');

  it('REPLAY 10:52Z: "| CanLaw | … | Training done ~8:30–9:00 AM PDT, verdict ~10:30–11:30 AM PDT |" clears BOTH ranges', () => {
    expect(findFutureObservedTimestamps('| CanLaw | Smoke run: 1 of 6 rounds banked, round 2 underway, GPU 97–100% | Training done ~8:30–9:00 AM PDT, verdict ~10:30–11:30 AM PDT |', NOW_1052)).toEqual([]);
  });

  it('REPLAY 11:18Z: "| CanLaw | … | training done ~8:30–9:00 AM PDT, verdict late morning |" clears', () => {
    expect(findFutureObservedTimestamps('| CanLaw | Smoke training healthy into round 2 (reported 10:51Z) | training done ~8:30–9:00 AM PDT, verdict late morning |', NOW_1118)).toEqual([]);
  });

  it('REPLAY 12:14Z: "| CanLaw | … | Done ~9:35–10:05 AM PDT, verdict ~11:35 AM–12:05 PM PDT |" clears all four clocks (incl. the meridiem range end)', () => {
    expect(findFutureObservedTimestamps('| CanLaw | Smoke run survived preempt #13 with zero data loss, back training on round 2 | Done ~9:35–10:05 AM PDT, verdict ~11:35 AM–12:05 PM PDT |', NOW_1214)).toEqual([]);
  });

  it('the fused label clears without the table dressing ("Training done ~8:30–9:00 AM PDT" alone)', () => {
    expect(findFutureObservedTimestamps('Training done ~8:30–9:00 AM PDT.', NOW_1118)).toEqual([]);
    expect(findFutureObservedTimestamps('Round 2 finished ~2:15–2:40 PM PDT.', NOW_1118)).toEqual([]);
  });

  it('a bare meridiem range start inherits: "verdict ~11:35 AM–12:05 PM PDT" clears both ends', () => {
    expect(findFutureObservedTimestamps('verdict ~11:35 AM–12:05 PM PDT', NOW_1214)).toEqual([]);
    expect(findFutureObservedTimestamps('drain closes ~9:30 A.M.–10:15 A.M. PDT', NOW_1214)).toEqual([]);
  });

  it('ANTI-SMUGGLE: the CONNECTOR frames still convict ("merged by ~", "verified through ~", "landed by ~")', () => {
    expect(findFutureObservedTimestamps('PR #1074 merged by ~9:35–10:05 AM PDT, all checks green.', NOW_1214)).toHaveLength(1);
    expect(findFutureObservedTimestamps('Audit verified through ~10:05 AM PDT.', NOW_1214)).toHaveLength(1);
    expect(findFutureObservedTimestamps('Capacity landed by ~12:05 PM PDT.', NOW_1214)).toHaveLength(1);
  });

  it('ANTI-SMUGGLE: a co-line bare future clock still convicts next to a label range', () => {
    const hits = findFutureObservedTimestamps('Training done ~8:30–9:00 AM PDT; box probe read 8:55 AM PDT clean', NOW_1118);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('8:55 AM PDT');
  });

  it('ANTI-SMUGGLE: the label does not launder a DIFFERENT clock on the line ("probed done at 10:30 AM PDT")', () => {
    const hits = findFutureObservedTimestamps('Training done ~8:30–9:00 AM PDT, GPU probed at 10:30 AM PDT clean', NOW_1118);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('10:30 AM PDT');
  });

  it('ANTI-SMUGGLE: an UNMARKED meridiem range still convicts ("stayed green across 11:35 AM–12:05 PM PDT")', () => {
    const hits = findFutureObservedTimestamps('Serving stayed green across 11:35 AM–12:05 PM PDT during the soak', NOW_1214);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('12:05 PM PDT');
  });
});

/**
 * Operator iteration 13 (FO firing 25, 2026-09-25) — a forward clock that
 * PARAPHRASES a real enabled schedule's next firing time is not an
 * impossible observation.
 *
 * Incidents (all POST-iteration-12, i.e. the fix that shipped 08:54Z did not
 * cover this class):
 *   - 2026-09-25T10:26:33.233Z, chat f5c2c1f4 (CanLaw Supervisor), token
 *     "12:08Z" +104 min: "… drain trigger armed on the SFT-2 launch
 *     announcement …" — the inference Supervisor's CHAIN-DECISION schedule,
 *     coding_schedules.nextRunAt 2026-09-25T12:08:42.598Z (Δ 42.6 s).
 *   - 2026-09-25T10:46:17.195Z, chat c0e22e36 (Fleet Supervisor), token
 *     "7:31 AM PDT" +229 min: "| canlegal-bench | … | morning nudge 7:31 AM
 *     PDT |" — the canlegal-bench morning-nudge schedule, nextRunAt
 *     2026-09-25T14:31:29.410Z (Δ 29.4 s).
 *   - 2026-09-25T10:53:13.082Z, chat c0e22e36, token "5:08 AM PDT" +77 min:
 *     the same inference 12:08:42Z firing (12:08Z = 5:08 AM PDT).
 * None carry a FUTURE_INTENT_RE word — they are digest/ETA idioms naming the
 * TIME AN ARMED FIRING WILL HAPPEN, verified against the DB (existence
 * arithmetic, the doctrine's false-positive-safe class).
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

import { findFutureObservedTimestamps, schedFiringGovernedStamp } from './action-verifier';

describe('schedule-firing-time paraphrase clocks (operator iteration 13, 2026-09-25)', () => {
  const NOW_1026 = new Date('2026-09-25T10:26:33.233Z');
  const NOW_1046 = new Date('2026-09-25T10:46:17.195Z');
  // The DB-verified firing instants from the incident window.
  const T_1208 = Date.parse('2026-09-25T12:08:42.598Z'); // inference CHAIN-DECISION schedule
  const T_1431 = Date.parse('2026-09-25T14:31:29.410Z'); // canlegal-bench morning nudge
  const SCHEDS = [T_1208, T_1431];

  it('REPLAY 10:26Z (f5c2c1f4): "…drain trigger armed…12:08Z" matches the 12:08:42Z armed firing', () => {
    const line = '- Acked the inference supervisor (receipt 76d210f7): both corrections landed, drain trigger armed on the SFT-2 launch announcement — capacity decision 12:08Z';
    expect(findFutureObservedTimestamps(line, NOW_1026, { scheduleFiringTimes: SCHEDS })).toEqual([]);
  });

  it('REPLAY 10:46Z (c0e22e36): the digest ETA cell "| morning nudge 7:31 AM PDT |" matches the 14:31:29Z nudge', () => {
    const line = '| canlegal-bench | Unchanged — harvest waits on your morning Mac paste | morning nudge 7:31 AM PDT |';
    expect(findFutureObservedTimestamps(line, NOW_1046, { scheduleFiringTimes: SCHEDS })).toEqual([]);
  });

  it('REPLAY 10:53Z (c0e22e36): "the 5:08 AM PDT capacity check" matches the 12:08:42Z firing (zone gloss)', () => {
    const line = "- CanLaw's smoke test, the tt-rd speed fix, and the 5:08 AM PDT capacity check: unchanged since the 3:44 AM note.";
    expect(findFutureObservedTimestamps(line, NOW_1046, { scheduleFiringTimes: SCHEDS })).toEqual([]);
  });

  it('the same lines WITHOUT the schedule instants still convict (the exemption is DB-grounded, not wording-based)', () => {
    const line = '| canlegal-bench | Unchanged — harvest waits on your morning Mac paste | morning nudge 7:31 AM PDT |';
    const hits = findFutureObservedTimestamps(line, NOW_1046);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('7:31 AM PDT');
  });

  it('a clock near-miss (61s off the armed firing) still convicts — the match window is ±60s', () => {
    const nearMiss = [T_1431 + 61_000];
    const line = '| canlegal-bench | harvest waits on your morning Mac paste | morning nudge 7:31 AM PDT |';
    expect(findFutureObservedTimestamps(line, NOW_1046, { scheduleFiringTimes: nearMiss })).toHaveLength(1);
  });

  it('ANTI-SMUGGLE: a completed-work verb governing the clock through at/@ still convicts', () => {
    const line = 'the morning nudge landed at 7:31 AM PDT with the paste attached';
    expect(findFutureObservedTimestamps(line, NOW_1046, { scheduleFiringTimes: SCHEDS })).toHaveLength(1);
    expect(schedFiringGovernedStamp(line, line.indexOf('7:31'), Date.parse('2026-09-25T14:31:00Z'), SCHEDS)).toBe(false);
  });

  it('per-TOKEN: a co-line phantom clock with no matching firing still convicts', () => {
    // No FUTURE_INTENT word on the line (a "next …" line is exempt at line
    // level by design) — the 5:08 clock clears via the schedule match, the
    // co-line 6:15 clock has no matching firing and still convicts.
    // (iter-24 note: the fixture noun was "capacity checkpoint" until
    // 2026-09-27, when "checkpoint" JOINED FUTURE_INTENT_RE as the fleet's
    // decision-instant noun — it now line-level-exempts, so the fixture uses
    // the deliberately-excluded bare "check" to keep pinning the no-intent-
    // word register this test exists for.)
    const line = 'capacity check 5:08 AM PDT; the box probe read 6:15 AM PDT clean';
    const hits = findFutureObservedTimestamps(line, NOW_1046, { scheduleFiringTimes: SCHEDS });
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('6:15 AM PDT');
  });

  it('schedFiringGovernedStamp — unit shape', () => {
    const l = '| canlegal-bench | harvest | morning nudge 7:31 AM PDT |';
    expect(schedFiringGovernedStamp(l, l.indexOf('7:31'), Date.parse('2026-09-25T14:31:29.410Z'), SCHEDS)).toBe(true);
    // No instants → no exemption.
    expect(schedFiringGovernedStamp(l, l.indexOf('7:31'), Date.parse('2026-09-25T14:31:29.410Z'), [])).toBe(false);
    // Instant mismatch → no exemption.
    expect(schedFiringGovernedStamp(l, l.indexOf('7:31'), Date.parse('2026-09-25T15:31:00Z'), SCHEDS)).toBe(false);
  });

  // ── Iteration 13b (supervisor steer 12:19Z): the line-leading
  // "After <EVENT>:" forward-plan cue, struck twice in prod
  // (2da8766f 07:05:24Z, f5c2c1f4 10:26:33Z).
  it('REPLAY i13b: "After TRAIN_DONE: comparator package → … (hand both p5s before block end Sep 26 11:30Z)" is a forward plan', () => {
    const line = "After TRAIN_DONE: comparator package → the coordinator's SFT-2 launch announcement, which is our drain trigger (hand both p5s before block end Sep 26 11:30Z)";
    expect(findFutureObservedTimestamps(line, NOW_1026)).toEqual([]);
  });

  it('REPLAY i13b (cue-only twin — no estimate governor, clock covered by the cue ALONE)', () => {
    const line = 'After TRAIN_DONE: comparator package → the SFT-2 launch announcement (drain trigger) 11:30Z';
    expect(findFutureObservedTimestamps(line, NOW_1026)).toEqual([]);
  });

  it('i13b ANTI-SMUGGLE: a completed-work verb on the line still convicts ("After the audit: verified 15:03Z")', () => {
    const line = 'After the audit: verified 15:03Z the box probe read clean';
    expect(findFutureObservedTimestamps(line, NOW_1026)).toHaveLength(1);
  });

  it('i13b: mid-line "after" is not the cue (line-leading only)', () => {
    // "arrives" is deliberately NOT a FUTURE_INTENT word, so nothing else
    // exempts this line — the pin isolates the line-leading boundary.
    const line = 'the comparator package arrives after TRAIN_DONE: 11:30Z';
    expect(findFutureObservedTimestamps(line, NOW_1026)).toHaveLength(1);
  });
});

/**
 * IDLE CADENCE verdict (autonomy loop #12, 2026-09-20 — owner: "scheduled
 * sessions not doing anything over and over"): the pure classifier behind the
 * [PROJECT SCHEDULES] block's retire-or-justify annotation.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));

import { judgeIdleCadence, IDLE_FINAL_RE, IDLE_CADENCE_MIN_FINALS } from './supervisor-state.service';

const idleFinals = [
  'HARNESS SELF-AUDIT: PASS — all five acceptance criteria genuinely re-verified against a fresh third probe round',
  'F206/500 — NOTHING NEW (probe clock 2026-09-20T10:32:16Z, this run): tenstorrent/tt-metal PR #55747 observed',
  'TRIGGER UNMET — standing down. Fresh probes this run: origin/main tip 4fac6b91',
  'Tick final — standby watch firing 91: transcript fresh-pull, no new items',
  'Continuation no-op — plan already complete',
];

describe('IDLE_FINAL_RE', () => {
  it('matches the live no-op shapes and not a real-work final', () => {
    for (const f of idleFinals) expect(IDLE_FINAL_RE.test(f)).toBe(true);
    expect(IDLE_FINAL_RE.test('Implemented the autotune cache persistence: 3 files changed, PR #41 opened, verify green.')).toBe(false);
    expect(IDLE_FINAL_RE.test('Restored the serving route (Option B), 8/8 plan steps done; notified the supervisor.')).toBe(false);
  });
});

describe('judgeIdleCadence', () => {
  it('flags a lane whose recent machine finals are all no-ops and whose runs are short', () => {
    expect(judgeIdleCadence(idleFinals, [2.9, 3.1, 2.4, 3.3, 2.8])).toEqual({ examined: 5, idle: 5, avgRunMin: 2.9 });
    expect(judgeIdleCadence(idleFinals.slice(0, 4), [])).toEqual({ examined: 4, idle: 4, avgRunMin: null });
  });

  it('does NOT flag: too few finals, mixed finals, or long runs that merely say "no change"', () => {
    expect(judgeIdleCadence(idleFinals.slice(0, IDLE_CADENCE_MIN_FINALS - 1), [2])).toBeNull();
    expect(judgeIdleCadence([...idleFinals.slice(0, 3), 'Opened PR #12 with the fix', 'Merged PR #12 after CI green'], [3, 3, 3, 3, 3])).toBeNull();
    expect(judgeIdleCadence(idleFinals, [22, 18, 25, 20, 19])).toBeNull();
    // 4 of 5 idle with short runs → 80 % → flagged.
    expect(judgeIdleCadence([...idleFinals.slice(0, 4), 'Opened PR #12'], [2, 2, 2, 2, 2])).toMatchObject({ examined: 5, idle: 4 });
  });
});

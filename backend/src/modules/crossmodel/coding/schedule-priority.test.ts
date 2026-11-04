jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockFindFirst = jest.fn();
const mockUpdate = jest.fn(async (..._a: any[]) => ({}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { codingSchedule: { findFirst: (...a: any[]) => mockFindFirst(...a), update: (...a: any[]) => mockUpdate(...a) } },
}));
// The direct fire (autonomy loop #10) — schedule.service is mocked at the
// boundary: the priority module dynamically imports it and only calls
// fireDueScheduleNow; the row pass itself is pinned in schedule.service.test.
const mockFireNow = jest.fn(async (..._a: any[]): Promise<any> => ({ outcome: 'started' }));
jest.mock('./schedule.service', () => ({
  __esModule: true,
  fireDueScheduleNow: (...a: any[]) => mockFireNow(...a),
}));

import { claimStarvedScheduleSlot, slotYields, SCHEDULE_PRIORITY_SKIPS } from './schedule-priority';
import logger from '../../../utils/logger';

const NOW = new Date('2026-09-19T08:10:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
  mockFireNow.mockResolvedValue({ outcome: 'started' });
});

describe('claimStarvedScheduleSlot (the Fleet Supervisor sweep at busySkips 98)', () => {
  it('finds the most-starved enabled recurring schedule at or over the threshold, pulls nextRunAt to now, FIRES it directly, logs one line', async () => {
    mockFindFirst.mockResolvedValue({ id: 'sched-fs', busySkips: 98, intervalSec: 7200, nextRunAt: new Date('2026-09-19T08:12:30.000Z') });
    const r = await claimStarvedScheduleSlot('c0e22e36-1c74-4295-8049-9b48335c6c37', NOW);
    expect(r).toEqual({ id: 'sched-fs', busySkips: 98, intervalSec: 7200, fired: 'started' });
    const where = mockFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ sessionId: 'c0e22e36-1c74-4295-8049-9b48335c6c37', enabled: true, kind: 'recurring', busySkips: { gte: SCHEDULE_PRIORITY_SKIPS } });
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'sched-fs' }, data: { nextRunAt: NOW } });
    // The pull-forward lands BEFORE the fire (the fire re-reads the row and needs it due).
    expect(mockUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockFireNow.mock.invocationCallOrder[0]);
    expect(mockFireNow).toHaveBeenCalledWith('sched-fs');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('starved 98 busy-skips, pulled to now, direct fire started; finalize drain YIELDS'));
  });

  it('a schedule already due is not touched (no update) but is still fired and claims the slot', async () => {
    mockFindFirst.mockResolvedValue({ id: 's1', busySkips: 12, intervalSec: 900, nextRunAt: new Date('2026-09-19T08:09:00.000Z') });
    expect(await claimStarvedScheduleSlot('chat-1', NOW)).toMatchObject({ id: 's1', fired: 'started' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockFireNow).toHaveBeenCalledWith('s1');
  });

  it('the finalize still yields when another sweeper claimed the row first, the process is retiring, or the chat was already busy', async () => {
    mockFindFirst.mockResolvedValue({ id: 's1', busySkips: 12, intervalSec: 900, nextRunAt: NOW });
    for (const fired of [{ outcome: 'lost_claim' }, { outcome: 'not_due' }, { outcome: 'retiring' }, { outcome: 'skipped', reason: 'busy' }]) {
      mockFireNow.mockResolvedValueOnce(fired);
      expect(await claimStarvedScheduleSlot('chat-1', NOW)).toMatchObject({ id: 's1', fired: fired.outcome });
    }
  });

  it('a schedule that will NOT run now (cap skip, dormancy park, expiry, disabled, error) → null: the normal drain proceeds; the line still records the attempt', async () => {
    mockFindFirst.mockResolvedValue({ id: 's1', busySkips: 12, intervalSec: 900, nextRunAt: NOW });
    const cases = [
      { outcome: 'skipped', reason: 'daily_cap' }, { outcome: 'skipped', reason: 'spend_cap' }, { outcome: 'skipped', reason: 'delta_unchanged' },
      { outcome: 'disabled', reason: 'parked_dormant' }, { outcome: 'disabled', reason: 'expired' }, { outcome: 'not_found' }, { outcome: 'error', message: 'boom' },
    ];
    for (const fired of cases) {
      (logger.info as jest.Mock).mockClear();
      mockFireNow.mockResolvedValueOnce(fired);
      expect(await claimStarvedScheduleSlot('chat-1', NOW)).toBeNull();
      const label = `${fired.outcome}${(fired as any).reason ? `:${(fired as any).reason}` : ''}`;
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`direct fire ${label}; finalize drain proceeds`));
    }
    // A THROWING direct fire is an error outcome too — never breaks the finalize.
    mockFireNow.mockRejectedValueOnce(new Error('import exploded'));
    expect(await claimStarvedScheduleSlot('chat-1', NOW)).toBeNull();
  });

  it('nothing starved → null and no writes; a DB error → null (the drain proceeds)', async () => {
    mockFindFirst.mockResolvedValue(null);
    expect(await claimStarvedScheduleSlot('chat-1', NOW)).toBeNull();
    mockFindFirst.mockRejectedValueOnce(new Error('db down'));
    expect(await claimStarvedScheduleSlot('chat-1', NOW)).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockFireNow).not.toHaveBeenCalled();
  });
});

describe('slotYields (pure)', () => {
  it('yields on started / lost_claim / not_due / retiring / skipped:busy / no fire; not on anything that means "will not run now"', () => {
    expect(slotYields(null)).toBe(true);
    for (const o of ['started', 'lost_claim', 'not_due', 'retiring']) expect(slotYields({ outcome: o })).toBe(true);
    expect(slotYields({ outcome: 'skipped', reason: 'busy' })).toBe(true);
    for (const f of [{ outcome: 'skipped', reason: 'daily_cap' }, { outcome: 'disabled', reason: 'expired' }, { outcome: 'not_found' }, { outcome: 'error' }, { outcome: 'weird' }]) {
      expect(slotYields(f)).toBe(false);
    }
  });
});

/**
 * setScheduleEnabledForChat (rm9 Schedules tab) — service-level cadence-rule
 * pins for pause/resume, complementing platform.service.test.ts (which pins
 * the owner gate + audit through the platform wrappers):
 *   - pause emits the ONE schedule_disabled hook event with reason 'paused'
 *     (the enabled:false doctrine) and the deaf-lane suffix when it silences
 *     the chat's LAST enabled schedule;
 *   - resume recomputes a stale nextRunAt from NOW (+intervalSec) and slides a
 *     lapsed expiresAt, so an owner resume can never fire immediately or be
 *     instantly re-expired by the sweeper;
 *   - completed / active-cap guards, chat-scoped not_found, idempotency.
 *
 * Harness mirrors schedule.service.test.ts (mocked prisma/redis/hooks — the
 * real module graph exits the jest worker at import via config/env).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindFirst = jest.fn();
const mockUpdate = jest.fn();
const mockCount = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: {
      findFirst: (...a: any[]) => mockFindFirst(...a),
      update: (...a: any[]) => mockUpdate(...a),
      count: (...a: any[]) => mockCount(...a),
    },
  },
}));

// enrichWithCapState reads the fires counter (GET + PTTL) — benign defaults.
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async () => null),
    pTTL: jest.fn(async () => -2),
    incr: jest.fn(), expire: jest.fn(), decr: jest.fn(), set: jest.fn(), del: jest.fn(),
  },
}));

// The cap lookup (capForSession → autonomy.service dynamic import).
jest.mock('../platform/autonomy.service', () => ({
  __esModule: true,
  getChatAutonomy: jest.fn(async () => null),
}));

// The hook-event seam emitScheduleDisabled reaches via dynamic import.
const mockEmitHookEvent = jest.fn(async (..._args: any[]) => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
}));

import {
  setScheduleEnabledForChat,
  MAX_ACTIVE_PER_SESSION,
  MAX_LIFETIME_MS,
} from './schedule.service';

const SESSION = 'chat-1';
const HOUR_MS = 3600_000;

const row = (over: Partial<Record<string, any>> = {}) => ({
  id: 'sch-1', sessionId: SESSION, userId: 'u-owner', prompt: 'watch the deploy',
  kind: 'recurring', intervalSec: 3600, nextRunAt: new Date(Date.now() + 15 * 60_000),
  enabled: true, runsCount: 3, maxRuns: 500,
  expiresAt: new Date(Date.now() + 30 * 86400_000),
  lastFiredAt: null, lastStatus: 'started', createdAt: new Date(), promptSetBy: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCount.mockResolvedValue(0);
  mockUpdate.mockImplementation(async ({ data }: any) => ({ ...row(), ...data }));
});

describe('pause (enabled:false)', () => {
  it('flips the row to paused and emits schedule_disabled(reason paused) — the enabled:false doctrine', async () => {
    mockFindFirst.mockResolvedValue(row());
    const res = await setScheduleEnabledForChat(SESSION, 'sch-1', false);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);
    // v1#13: every disable path stamps who/when (owner pause ⇒ 'owner').
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'sch-1' }, data: { enabled: false, lastStatus: 'paused', cancelledBy: 'owner', disabledAt: expect.any(Date) } });
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      SESSION, 'schedule_disabled',
      expect.stringContaining('resumes'),
      expect.objectContaining({ scheduleId: 'sch-1', reason: 'paused', runsCount: 3 }),
    );
  });

  it('the deaf-lane suffix rides the paused event when the chat is left with ZERO enabled schedules', async () => {
    mockFindFirst.mockResolvedValue(row());
    mockCount.mockResolvedValue(0); // remaining enabled after the flip
    await setScheduleEnabledForChat(SESSION, 'sch-1', false);
    const summary = mockEmitHookEvent.mock.calls[0][2] as string;
    expect(summary).toContain('NO enabled schedules');
    expect(mockEmitHookEvent.mock.calls[0][3]).toEqual(expect.objectContaining({ remainingEnabled: 0 }));
  });

  it('…and stays off the suffix when other enabled schedules remain', async () => {
    mockFindFirst.mockResolvedValue(row());
    mockCount.mockResolvedValue(2);
    await setScheduleEnabledForChat(SESSION, 'sch-1', false);
    const summary = mockEmitHookEvent.mock.calls[0][2] as string;
    expect(summary).not.toContain('NO enabled schedules');
  });

  it('is idempotent on an already-disabled row: changed:false, no update, no event, lastStatus preserved', async () => {
    mockFindFirst.mockResolvedValue(row({ enabled: false, lastStatus: 'cancelled' }));
    const res = await setScheduleEnabledForChat(SESSION, 'sch-1', false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(false);
    expect(res.schedule.lastStatus).toBe('cancelled'); // a re-pause never relabels a cancelled row
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
  });
});

describe('resume (enabled:true)', () => {
  it('recomputes a STALE nextRunAt to now + intervalSec — never an immediate catch-up fire', async () => {
    mockFindFirst.mockResolvedValue(row({ enabled: false, lastStatus: 'paused', nextRunAt: new Date(Date.now() - 2 * HOUR_MS) }));
    const before = Date.now();
    const res = await setScheduleEnabledForChat(SESSION, 'sch-1', true);

    expect(res.ok).toBe(true);
    const data = mockUpdate.mock.calls[0][0].data;
    expect(data.enabled).toBe(true);
    expect(data.lastStatus).toBe('resumed');
    expect(data.nextRunAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  it('keeps a still-future nextRunAt (no gratuitous reschedule)', async () => {
    mockFindFirst.mockResolvedValue(row({ enabled: false, lastStatus: 'paused' }));
    await setScheduleEnabledForChat(SESSION, 'sch-1', true);
    expect(mockUpdate.mock.calls[0][0].data.nextRunAt).toBeUndefined();
  });

  it('slides a LAPSED expiresAt to now + MAX_LIFETIME_MS — the sweeper must not instantly re-expire the resume', async () => {
    mockFindFirst.mockResolvedValue(row({
      enabled: false, lastStatus: 'paused',
      nextRunAt: new Date(Date.now() - HOUR_MS),
      expiresAt: new Date(Date.now() - HOUR_MS),
    }));
    const before = Date.now();
    await setScheduleEnabledForChat(SESSION, 'sch-1', true);
    const data = mockUpdate.mock.calls[0][0].data;
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + MAX_LIFETIME_MS - 1000);
  });

  it('refuses a run-capped schedule (completed) without touching the row', async () => {
    mockFindFirst.mockResolvedValue(row({ enabled: false, runsCount: 500, maxRuns: 500 }));
    const res = await setScheduleEnabledForChat(SESSION, 'sch-1', true);
    expect(res).toMatchObject({ ok: false, reason: 'completed' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("refuses a fired 'once' even without maxRuns (defensive: a one-shot never resumes)", async () => {
    mockFindFirst.mockResolvedValue(row({ enabled: false, kind: 'once', runsCount: 1, maxRuns: null }));
    const res = await setScheduleEnabledForChat(SESSION, 'sch-1', true);
    expect(res).toMatchObject({ ok: false, reason: 'completed' });
  });

  it('re-checks MAX_ACTIVE_PER_SESSION — a resume arms a schedule exactly like a create', async () => {
    mockFindFirst.mockResolvedValue(row({ enabled: false, lastStatus: 'paused' }));
    mockCount.mockResolvedValue(MAX_ACTIVE_PER_SESSION);
    const res = await setScheduleEnabledForChat(SESSION, 'sch-1', true);
    expect(res).toMatchObject({ ok: false, reason: 'too_many_active' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('resume RESETS the busy-skip streak — a resumed schedule must be able to alarm again', async () => {
    mockFindFirst.mockResolvedValue(row({ enabled: false, lastStatus: 'paused', busySkips: 7 }));
    const res = await setScheduleEnabledForChat(SESSION, 'sch-1', true);
    expect(res.ok).toBe(true);
    expect(mockUpdate.mock.calls[0][0].data.busySkips).toBe(0);
    if (!res.ok) return;
    expect(res.schedule.busySkips).toBe(0); // ScheduleView surfaces the streak
  });

  it('resumes a CANCELLED row (the UI Undo path — cancel persists enabled:false, nothing destroyed)', async () => {
    mockFindFirst.mockResolvedValue(row({ enabled: false, lastStatus: 'cancelled' }));
    const res = await setScheduleEnabledForChat(SESSION, 'sch-1', true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);
    expect(mockUpdate.mock.calls[0][0].data).toMatchObject({ enabled: true, lastStatus: 'resumed' });
  });
});

describe('chat scoping', () => {
  it('looks the row up by { id, sessionId } — a wrong-chat id is not_found (no cross-chat reach)', async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await setScheduleEnabledForChat(SESSION, 'foreign-sch', true);
    expect(res).toMatchObject({ ok: false, reason: 'not_found' });
    expect(mockFindFirst).toHaveBeenCalledWith({ where: { id: 'foreign-sch', sessionId: SESSION } });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

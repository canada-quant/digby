/**
 * Retiring colour — the sweepers stand down (2026-09-18 audit, wave 414b9cce).
 *
 * The retiring gate (startDetachedChatRun refuses machine starts) landed at
 * 21:45Z; by 23:37Z the OLD colour had refused 233 starts it had CLAIMED
 * itself — its 30 s sweeper kept claiming due schedules and pending hook rows,
 * each refusal became a busy-skip (busySkips 50 on the Fleet Supervisor,
 * schedule_busy_alarm rows naming "a run outside agent_runs") or a 3-min busy
 * park of a wake the NEW colour could have delivered at once. Both sweepers
 * now return before touching the DB while the process is retiring.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockScheduleFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockScheduleDeleteMany = jest.fn(async (..._a: any[]) => ({ count: 0 }));
const mockHookUpdateMany = jest.fn(async (..._a: any[]) => ({ count: 0 }));
const mockHookFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: {
      findMany: (...a: any[]) => mockScheduleFindMany(...a),
      deleteMany: (...a: any[]) => mockScheduleDeleteMany(...a),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    hookEvent: {
      updateMany: (...a: any[]) => mockHookUpdateMany(...a),
      findMany: (...a: any[]) => mockHookFindMany(...a),
      count: jest.fn(async () => 0),
    },
    crossModelChat: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => []),
  },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), incr: jest.fn(async () => 1), expire: jest.fn(async () => 1) },
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error { constructor(public statusCode: number, message: string) { super(message); } },
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: new Proxy({}, { get: (_t, k) => String(k).toLowerCase() }),
}));

import { markRetiring, __resetRetiringForTests } from './retiring';
import { fireDue } from './schedule.service';
import { sweepHookEvents } from '../platform/hooks.service';

beforeEach(() => {
  jest.clearAllMocks();
  __resetRetiringForTests();
});

describe('retiring colour — sweepers stand down', () => {
  it('the schedule sweeper tick (which also hosts the hook sweep) touches nothing while retiring', async () => {
    markRetiring(new Date('2026-09-18T22:30:28.000Z'));
    await fireDue();
    expect(mockScheduleFindMany).not.toHaveBeenCalled();
    expect(mockScheduleDeleteMany).not.toHaveBeenCalled();
    expect(mockHookUpdateMany).not.toHaveBeenCalled();
    expect(mockHookFindMany).not.toHaveBeenCalled();
  });

  it('sweepHookEvents — the 30 s poll AND the emission/finalize kicks — claims no row while retiring', async () => {
    markRetiring();
    await sweepHookEvents();
    await sweepHookEvents({ targetChatId: 'chat-1', ignoreRetryAt: true });
    await sweepHookEvents({ hookIds: ['h1'] });
    expect(mockHookUpdateMany).not.toHaveBeenCalled();
    expect(mockHookFindMany).not.toHaveBeenCalled();
  });

  it('a live (non-retiring) process still sweeps: the due-schedule scan and the hook housekeeping run', async () => {
    await fireDue();
    expect(mockScheduleFindMany).toHaveBeenCalled();
    // The poll-path housekeeping (stale-delivering reclaim) is the first hook write.
    expect(mockHookUpdateMany).toHaveBeenCalled();
  });
});

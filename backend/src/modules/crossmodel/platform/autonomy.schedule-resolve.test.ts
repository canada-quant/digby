/**
 * Schedule-id self-correction (autonomy loop #16, 2026-09-21) —
 * resolveScheduleForCaller / listCallerSchedules / describeCallerSchedules
 * against the REAL autonomy.service with mocked Prisma. Scaffolding mirrors
 * autonomy.implicit.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const OWN_CHAT = 'caller-chat-1';
/** rows for the CALLER chat (listCallerSchedules) and for the owner-scoped prefix lookup. */
let callerRows: any[] = [];
let prefixRows: any[] = [];
const mockPrisma: any = {
  chatAutonomy: { findUnique: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn(async () => ({ count: 1 })) },
  activity: { create: jest.fn(async () => ({})) },
  crossModelChat: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
  codingSchedule: {
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(async ({ where }: any) => (where?.sessionId ? callerRows : prefixRows)),
  },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

jest.mock('../crossmodel.service', () => ({ __esModule: true, default: { getChatAccess: jest.fn() } }));

const mockRecordLoopMetric = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import { resolveScheduleForCaller, listCallerSchedules, describeCallerSchedules } from './autonomy.service';

const row = (id: string, o: Partial<any> = {}) => ({
  id, kind: 'recurring', enabled: true, intervalSec: 1800, nextRunAt: new Date('2026-09-21T08:11:12Z'), lastStatus: 'skipped:busy', promptSetBy: 'machine', ...o,
});

beforeEach(() => {
  jest.clearAllMocks();
  callerRows = [];
  prefixRows = [];
  mockPrisma.codingSchedule.findFirst.mockResolvedValue(null);
});

describe('resolveScheduleForCaller', () => {
  it('an exact owner-scoped id resolves; so does a unique ≥8-char prefix (the tool description idiom)', async () => {
    mockPrisma.codingSchedule.findFirst.mockResolvedValueOnce({ id: 'aaaaaaaa-1111' });
    expect(await resolveScheduleForCaller('u1', OWN_CHAT, 'aaaaaaaa-1111', 'update_schedule')).toEqual({ kind: 'resolved', id: 'aaaaaaaa-1111' });
    prefixRows = [{ id: 'bbbbbbbb-2222' }];
    expect(await resolveScheduleForCaller('u1', OWN_CHAT, 'bbbbbbbb', 'update_schedule')).toEqual({ kind: 'resolved', id: 'bbbbbbbb-2222' });
  });

  it('SUBSTITUTES a placeholder for update_schedule when the caller chat has exactly ONE enabled machine-authored schedule', async () => {
    callerRows = [row('sched-1'), row('sched-old', { enabled: false }), row('sched-sys', { promptSetBy: 'system' })];
    const r = await resolveScheduleForCaller('u1', OWN_CHAT, 'none', 'update_schedule');
    expect(r).toEqual({ kind: 'substituted', id: 'sched-1', passed: 'none' });
    expect(mockPrisma.codingSchedule.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1', sessionId: OWN_CHAT } }));
  });

  it('never substitutes: two enabled machine schedules (ambiguous), an owner-authored one, or cancel_schedule — candidates listed instead', async () => {
    callerRows = [row('sched-1'), row('sched-2')];
    expect(await resolveScheduleForCaller('u1', OWN_CHAT, 'none', 'update_schedule')).toMatchObject({ kind: 'none', passed: 'none', candidates: [expect.objectContaining({ id: 'sched-1' }), expect.objectContaining({ id: 'sched-2' })] });
    callerRows = [row('sched-owner', { promptSetBy: 'user' })];
    expect(await resolveScheduleForCaller('u1', OWN_CHAT, '00000000', 'update_schedule')).toMatchObject({ kind: 'none', candidates: [expect.objectContaining({ id: 'sched-owner' })] });
    callerRows = [row('sched-1')];
    expect(await resolveScheduleForCaller('u1', OWN_CHAT, 'none', 'cancel_schedule')).toMatchObject({ kind: 'none' });
  });

  it('a lookup error fails toward none with an empty candidate list (never throws into the tool path)', async () => {
    mockPrisma.codingSchedule.findMany.mockRejectedValueOnce(new Error('db')).mockRejectedValueOnce(new Error('db'));
    expect(await resolveScheduleForCaller('u1', OWN_CHAT, 'zzzzzzzz', 'update_schedule')).toEqual({ kind: 'none', passed: 'zzzzzzzz', candidates: [] });
  });
});

describe('listCallerSchedules + describeCallerSchedules', () => {
  it('lists the caller chat\'s rows (enabled first, ≤ 5) and renders copyable ids with cadence, next fire, status and author', async () => {
    callerRows = [row('sched-1'), row('sched-once', { kind: 'once', intervalSec: null, enabled: false, lastStatus: 'started', promptSetBy: 'system' })];
    const rows = await listCallerSchedules('u1', OWN_CHAT);
    expect(rows.map((r) => r.id)).toEqual(['sched-1', 'sched-once']);
    expect(mockPrisma.codingSchedule.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5, orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }] }));
    const text = describeCallerSchedules(rows);
    expect(text).toBe("THIS chat's schedules — pass one of these full ids: sched-1 (every 30 min, next 08:11Z, skipped:busy, enabled, set by machine); sched-once (once, next 08:11Z, started, disabled, set by system).");
    expect(describeCallerSchedules([])).toBe('');
  });
});

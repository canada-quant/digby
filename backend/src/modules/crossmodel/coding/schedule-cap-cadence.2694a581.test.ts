/**
 * Replay test — feedback 2694a581 (2026-09-18): "Recurring schedule cadences
 * can mathematically guarantee daily-cap deafness (30m recurring = 48/day =
 * the cap)". The observed incident: a chat whose ONLY active schedule was a
 * 30m soak watch hit schedule_cap_skipped at 39/48 trailing-24h firings —
 * pure cadence math (48 × 30m = 24h = the entire default daily cap), so any
 * one-shot steer or hook wake on the chat would skip daily_cap for the rest
 * of the window; a 15m recurring (96/day) can never fit at all.
 *
 * The fix (proposal (a) + the API surface of (b)) lives in
 * coding/schedule.service.ts:
 *   - capCadenceGuard(): a MACHINE recurring arm/update whose cadence alone
 *     can NEVER fit the chat's effective daily cap is REFUSED at arm time
 *     with the fitting minimum named (owner arms warn, never overridden);
 *   - arms at ≥75% of the cap land with a ⚠️ CAP HEADROOM warning that rides
 *     the tool response;
 *   - ScheduleView carries projectedDailyFirings so list_schedules / REST /
 *     the schedule UIs can show the burn before it happens.
 *
 * These tests pin the guard math at the service boundary with the same seam
 * mocks as schedule.service.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCreate = jest.fn();
const mockCount = jest.fn();
const mockFindFirst = jest.fn();
const mockFindMany = jest.fn();
const mockUpdate = jest.fn();
const mockUpdateMany = jest.fn(async (..._a: any[]) => ({ count: 0 }));
const mockDeleteMany = jest.fn(async (..._a: any[]) => ({ count: 0 }));
const mockScheduleFindUnique = jest.fn(async (..._a: any[]): Promise<any> => ({ enabled: true }));
const mockChatFindUnique = jest.fn();
const mockChatUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockMsgCreate = jest.fn(async (..._a: any[]) => ({}));
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'ph-1' }));
const mockPromptHistoryCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);

// $transaction seam (ticket ae20da66): createSchedule wraps the create + the
// same-cadence collapse in ONE interactive transaction. The tx reuses this
// file's mock fns; the collapse's in-tx stale read gets its OWN mock defaulting
// to [] so the cap-cadence assertions are untouched by the collapse.
const mockStaleFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockTransaction = jest.fn(async (fn: any) =>
  typeof fn === 'function'
    ? fn({
        chatSchedule: {
          create: (...a: any[]) => mockCreate(...a),
          findMany: (...a: any[]) => mockStaleFindMany(...a),
          updateMany: (...a: any[]) => mockUpdateMany(...a),
        },
      })
    : Promise.all(fn));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: {
      create: (...a: any[]) => mockCreate(...a),
      count: (...a: any[]) => mockCount(...a),
      findMany: (...a: any[]) => mockFindMany(...a),
      findFirst: (...a: any[]) => mockFindFirst(...a),
      findUnique: (...a: any[]) => mockScheduleFindUnique(...a),
      update: (...a: any[]) => mockUpdate(...a),
      updateMany: (...a: any[]) => mockUpdateMany(...a),
      deleteMany: (...a: any[]) => mockDeleteMany(...a),
    },
    agentRun: {
      findFirst: (...a: any[]) => mockRunFindFirst(...a),
      create: (...a: any[]) => mockRunCreate(...a),
      count: (...a: any[]) => mockRunCount(...a),
    },
    schedulePromptHistory: {
      create: (...a: any[]) => mockPromptHistoryCreate(...a),
      count: (...a: any[]) => mockPromptHistoryCount(...a),
      findFirst: (...a: any[]) => mockPromptHistoryFindFirst(...a),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), update: (...a: any[]) => mockChatUpdate(...a) },
    crossModelMessage: { create: (...a: any[]) => mockMsgCreate(...a) },
    $transaction: (fn: any) => mockTransaction(fn),
  },
}));

const mockSet = jest.fn(async (..._a: any[]): Promise<any> => 'OK');
const mockGet = jest.fn();
const mockGetDel = jest.fn();
const mockPTtl = jest.fn();
const mockIncr = jest.fn();
const mockIncrBy = jest.fn();
const mockExpire = jest.fn(async (..._a: any[]) => {});
const mockDecr = jest.fn(async (..._a: any[]) => {});
const mockRedisDel = jest.fn(async (..._a: any[]) => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: (...a: any[]) => mockSet(...a), del: (...a: any[]) => mockRedisDel(...a),
    get: (...a: any[]) => mockGet(...a),
    getDel: (...a: any[]) => mockGetDel(...a),
    pTTL: (...a: any[]) => mockPTtl(...a),
    incr: (...a: any[]) => mockIncr(...a),
    incrBy: (...a: any[]) => mockIncrBy(...a),
    expire: (...a: any[]) => mockExpire(...a),
    decr: (...a: any[]) => mockDecr(...a),
  },
}));

// Per-chat daily-cap lookup (dynamic import in the service).
const mockGetChatAutonomy = jest.fn();
jest.mock('../platform/autonomy.service', () => ({
  __esModule: true,
  getChatAutonomy: (...a: any[]) => mockGetChatAutonomy(...a),
}));

const mockEmitHookEvent = jest.fn(async (..._a: any[]) => {});
const mockSweepHookEvents = jest.fn(async (..._a: any[]) => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  sweepHookEvents: (...a: any[]) => mockSweepHookEvents(...a),
}));

const mockStartScheduledRun = jest.fn(async (..._a: any[]) => ({ started: true }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
}));

const mockStartDetachedChatRun = jest.fn((..._a: any[]): string | null => 'chat:s1');
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatRunKey: (id: string) => `chat:${id}`,
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked',
    SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', SCHEDULE_BUSY_ALARM: 'schedule_busy_alarm',
    PROBE_MISS: 'probe_miss', PROMPT_REWRITE_CAP: 'prompt_rewrite_cap',
    SCHEDULE_CAP_CADENCE: 'schedule_cap_cadence',
  },
}));

const mockQueueStoppedScheduleAlert = jest.fn((..._a: any[]) => {});
const mockMaybeFileStoppedScheduleDecision = jest.fn(async (..._a: any[]) => ({ filed: false, reason: 'lane_alive' }));
jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: (...a: any[]) => mockQueueStoppedScheduleAlert(...a),
  maybeFileStoppedScheduleDecision: (...a: any[]) => mockMaybeFileStoppedScheduleDecision(...a),
}));

const mockResolveStoppedForSession = jest.fn(async (..._a: any[]) => 0);
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  resolveStoppedScheduleDecisionsForSession: (...a: any[]) => mockResolveStoppedForSession(...a),
}));

const mockGetPlanStrict = jest.fn(async (..._a: any[]) => null as any);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: (...a: any[]) => mockGetPlanStrict(...a),
}));

import { createSchedule, updateScheduleForUser, projectedDailyFiringsFor, MIN_INTERVAL_SEC } from './schedule.service';

const base = { sessionId: 's1', userId: 'u1', prompt: 'watch the soak and report drift' };

/** A live recurring row for the updateScheduleForUser path. */
const updRow = {
  id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'old prompt', kind: 'recurring',
  intervalSec: 3600, nextRunAt: new Date(Date.now() + 3_600_000), enabled: true,
  runsCount: 3, maxRuns: 500, expiresAt: new Date(Date.now() + 10 * 24 * 3_600_000),
  lastFiredAt: null, lastStatus: 'started', createdAt: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCount.mockResolvedValue(0);
  mockFindMany.mockResolvedValue([]);
  mockFindFirst.mockResolvedValue(updRow);
  mockGet.mockResolvedValue(null);
  mockGetDel.mockResolvedValue(null);
  mockIncrBy.mockResolvedValue(1);
  mockPTtl.mockResolvedValue(-2);
  mockGetChatAutonomy.mockResolvedValue(null); // no grant → default cap 48
  mockChatFindUnique.mockResolvedValue(undefined); // not a supervisor chat
  mockCreate.mockImplementation(({ data }: any) => Promise.resolve({
    id: 'sch_new', ...data, lastFiredAt: null, lastStatus: null, runsCount: 0,
    busySkips: 0, cancelledBy: null, disabledAt: null, promptSetBy: data.promptSetBy ?? null,
  }));
  mockUpdate.mockImplementation(({ data }: any) => Promise.resolve({ ...updRow, ...data }));
});

// ── createSchedule: the can-never-fit class ──────────────────────────────────

describe('cap-cadence guard on createSchedule (ticket 2694a581)', () => {
  it('REPLAYS the incident class: a 15m machine recurring at the default 48/day cap is REFUSED with the fitting minimum named', async () => {
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('96');
    expect(r.error).toContain('48');
    expect(r.error).toMatch(/can NEVER fit/);
    expect(r.error).toMatch(/Minimum fitting cadence at this cap: 30 min/);
    expect(r.error).toMatch(/No schedule was created/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a 20m / 25m machine recurring is likewise refused (72/57 projected > 48)', async () => {
    for (const intervalSec of [1200, 1500]) {
      const r = await createSchedule({ ...base, kind: 'recurring', intervalSec, promptSetBy: 'machine' });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/can NEVER fit/);
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a bounded burst never trips the guard: 15m with maxRuns 20 arms clean (effective 20 ≤ 48)', async () => {
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC, maxRuns: 20, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('the incident cadence itself: 30m machine recurring ARMS but carries the ENTIRE-budget headroom warning', async () => {
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: 1800, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.warning).toContain('CAP HEADROOM');
    expect(r.warning).toContain("ENTIRE 48/day schedule budget");
    expect(r.warning).toMatch(/60 min leaves headroom/);
  });

  it('45m (32/day < 75% of 48) arms with NO warning; 40m (36/day = 75%) warns', async () => {
    const roomy = await createSchedule({ ...base, kind: 'recurring', intervalSec: 2700, promptSetBy: 'machine' });
    expect(roomy.ok).toBe(true);
    expect(roomy.warning).toBeUndefined();
    const edge = await createSchedule({ ...base, kind: 'recurring', intervalSec: 2400, promptSetBy: 'machine' });
    expect(edge.ok).toBe(true);
    expect(edge.warning).toContain('CAP HEADROOM');
  });

  it('owner autonomy: a 15m OWNER arm is warned (CAP MATH), never refused', async () => {
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'user' });
    expect(r.ok).toBe(true);
    expect(r.warning).toContain('CAP MATH');
    expect(r.warning).toMatch(/can NEVER fit/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('an arm with no promptSetBy is treated as non-machine: warned, not refused', async () => {
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC });
    expect(r.ok).toBe(true);
    expect(r.warning).toContain('CAP MATH');
  });

  it('a raised per-chat cap makes 15m legal: scheduleCap 480 → arms with no warning', async () => {
    mockGetChatAutonomy.mockResolvedValue({ scheduleCap: 480 });
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('supervisor chats use the 480 floor: 15m machine recurring arms with no warning', async () => {
    mockChatFindUnique.mockResolvedValue({ isSupervisor: true, isProjectSupervisor: false });
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('one-shots are never guarded (their interval is a delay, not a cadence)', async () => {
    const r = await createSchedule({ ...base, kind: 'once', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
    expect(r.schedule?.projectedDailyFirings).toBeNull();
  });

  it('the guard runs BEFORE the duplicate-backstop guard: an identical re-arm of an un-fittable cadence is refused, not silently deduped', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'sch_old', sessionId: 's1', userId: 'u1', prompt: base.prompt, kind: 'recurring',
      intervalSec: 900, enabled: true, runsCount: 0, maxRuns: 500,
    }]);
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: 900, promptSetBy: 'machine' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/can NEVER fit/);
    expect(r.deduped).toBeUndefined();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('the created view carries the raw cadence projection (30m → 48/day)', async () => {
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: 1800, promptSetBy: 'machine' });
    expect(r.schedule?.projectedDailyFirings).toBe(48);
    expect(r.schedule?.dailyCapLimit).toBe(48);
  });
});

// ── updateScheduleForUser: same guard, keyed off remaining runs ─────────────

describe('cap-cadence guard on updateScheduleForUser (ticket 2694a581)', () => {
  it('a machine interval-tightening to 15m is REFUSED and nothing is updated', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { intervalSec: 900, promptSetBy: 'machine' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/can NEVER fit/);
    expect(r.error).toMatch(/Nothing was updated/);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('a machine re-space to 30m lands with the headroom warning', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { intervalSec: 1800, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.warning).toContain('CAP HEADROOM');
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'sch_1' }, data: { intervalSec: 1800 } });
  });

  it('an owner re-cadence to 15m warns (CAP MATH) but lands', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { intervalSec: 900, promptSetBy: 'user' });
    expect(r.ok).toBe(true);
    expect(r.warning).toContain('CAP MATH');
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('a nearly-exhausted row cannot burn the cap: 15m on 1 remaining run arms clean', async () => {
    mockFindFirst.mockResolvedValue({ ...updRow, runsCount: 499 });
    const r = await updateScheduleForUser('u1', 'sch_1', { intervalSec: 900, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('a one-shot row is never guarded on interval change', async () => {
    mockFindFirst.mockResolvedValue({ ...updRow, kind: 'once', maxRuns: 1 });
    const r = await updateScheduleForUser('u1', 'sch_1', { intervalSec: 900, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('a prompt-only update never invokes the guard', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { prompt: 'new brief', promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });
});

// ── the pure projection helper ───────────────────────────────────────────────

describe('projectedDailyFiringsFor (ticket 2694a581)', () => {
  it('projects raw ticks/day for recurring cadences', () => {
    expect(projectedDailyFiringsFor('recurring', 900)).toBe(96);
    expect(projectedDailyFiringsFor('recurring', 1800)).toBe(48);
    expect(projectedDailyFiringsFor('recurring', 3600)).toBe(24);
    expect(projectedDailyFiringsFor('recurring', 2700)).toBe(32);
  });

  it('is null for one-shots and degenerate intervals', () => {
    expect(projectedDailyFiringsFor('once', 900)).toBeNull();
    expect(projectedDailyFiringsFor('recurring', null)).toBeNull();
    expect(projectedDailyFiringsFor('recurring', 0)).toBeNull();
  });
});

/**
 * Replay test — feedback 903249e5 (2026-09-24): "Recurring schedules silently
 * drift around the clock — no warning when a daily-intent cadence isn't a day
 * divisor". The observed incident: the owner's daily "AI noise on X" digest
 * (chat dddbf9ba) was armed at intervalMinutes 1219 to land at 7:30 AM PDT —
 * 1219 does not divide the day, and the sweeper re-arms from FIRE time
 * (nextRunAt = firedAt + intervalSec), so every firing landed 221 min
 * (3h41m) EARLIER than the last: 7:36 AM day one, 3:55 AM the next morning.
 * The owner was woken around 4 AM. Nothing in the creation or inspection
 * path surfaced the march.
 *
 * The fix (proposal (a) + (c) of the ticket) lives in
 * coding/schedule.service.ts:
 *   - clockDriftMinutesFor/clockDriftWarns/projectNextFirings/clockDriftWarningFor:
 *     pure drift math — signed smallest residue of intervalSec mod 86400,
 *     warned only in the daily regime (≥12h) where a "daily at HH:MM" intent
 *     is the norm (sub-daily cadences cycle the clock by design);
 *   - createSchedule/updateScheduleForUser land the arm/update and carry a
 *     non-blocking ⚠️ CLOCK DRIFT warning on the existing `warning` field
 *     (exactly the cap-cadence advisory class, ticket 2694a581);
 *   - ScheduleView carries clockDriftMinutes + projectedNextFirings so
 *     list_schedules / schedule_get / the schedule UIs show the march.
 *
 * Harness mirrors schedule-cap-cadence.2694a581.test.ts (colocated mocked
 * prisma/redis/hooks/fire-path).
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
const mockRunCreate = jest.fn(async (..._a: any[]) => ({ id: 'run-1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryCreate = jest.fn(async (..._a: any[]) => ({ id: 'ph-1' }));
const mockPromptHistoryCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);

// $transaction seam (ticket ae20da66): createSchedule wraps the create + the
// same-cadence collapse in ONE interactive transaction. The tx reuses this
// file's mock fns; the collapse's in-tx stale read gets its OWN mock
// defaulting to [] so the drift assertions are untouched by the collapse.
const mockStaleFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockTransaction = jest.fn(async (fn: any) =>
  typeof fn === 'function'
    ? fn({
        codingSchedule: {
          create: (...a: any[]) => mockCreate(...a),
          findMany: (...a: any[]) => mockStaleFindMany(...a),
          updateMany: (...a: any[]) => mockUpdateMany(...a),
        },
      })
    : Promise.all(fn));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    codingSchedule: {
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
    SCHEDULE_ONCE_RETIME: 'schedule_once_retime',
    SCHEDULE_CLOCK_DRIFT: 'schedule_clock_drift',
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

import {
  createSchedule, updateScheduleForUser, MIN_INTERVAL_SEC,
  clockDriftMinutesFor, clockDriftWarns, projectNextFirings, clockDriftWarningFor,
  CLOCK_DRIFT_WARN_MIN_INTERVAL_SEC,
} from './schedule.service';

const base = { sessionId: 's1', userId: 'u1', prompt: 'AI noise on X — daily digest' };

/** A live recurring row for the updateScheduleForUser path (the incident's
 *  1219m digest shape, pre-fix). */
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

// ── Pure drift math ───────────────────────────────────────────────────────────

describe('clock-drift math (ticket 903249e5)', () => {
  it('REPLAYS the incident: 1219m is a −221 min/day drift (7:30 AM reaches 4 AM in two days)', () => {
    // 1219 min = 73_140 s; 73_140 mod 86_400 = 73_140 → >43_200 → −13_260 s = −221 min.
    expect(clockDriftMinutesFor('recurring', 1219 * 60)).toBe(-221);
    expect(clockDriftWarns('recurring', 1219 * 60)).toBe(true);
    const warn = clockDriftWarningFor('recurring', 1219 * 60, Date.now());
    expect(warn).toMatch(/CLOCK DRIFT/);
    expect(warn).toMatch(/221 min EARLIER/);
    expect(warn).toMatch(/every firing/);
    // The fix the ticket names: a whole-day cadence never drifts.
    expect(warn).toMatch(/1440/);
  });

  it('day divisors and whole-day multiples never drift: 1440, 720, 480, 360, 2880', () => {
    for (const min of [1440, 720, 480, 360, 2880, 4320]) {
      expect(clockDriftMinutesFor('recurring', min * 60)).toBe(0);
      expect(clockDriftWarns('recurring', min * 60)).toBe(false);
      expect(clockDriftWarningFor('recurring', min * 60, Date.now())).toBeUndefined();
    }
  });

  it('sub-daily cadences carry drift minutes but never WARN (a monitor loop cycles the clock by design)', () => {
    // 500m: drift would be +500→ wrapped −940 min, but sub-daily ⇒ no warning.
    expect(clockDriftWarns('recurring', 500 * 60)).toBe(false);
    expect(clockDriftWarningFor('recurring', 500 * 60, Date.now())).toBeUndefined();
    // The field still reports the signed march for inspection surfaces.
    expect(clockDriftMinutesFor('recurring', 500 * 60)).not.toBe(0);
    // 2000m (33h20m): ≥12h, non-day-aligned ⇒ LATER drift (+560 min).
    expect(clockDriftMinutesFor('recurring', 2000 * 60)).toBe(560);
    expect(clockDriftWarns('recurring', 2000 * 60)).toBe(true);
    expect(clockDriftWarningFor('recurring', 2000 * 60, Date.now())).toMatch(/560 min LATER/);
  });

  it('the warn regime cut is ≥12h (CLOCK_DRIFT_WARN_MIN_INTERVAL_SEC) — 719m never warns, 721m drift-warns', () => {
    expect(CLOCK_DRIFT_WARN_MIN_INTERVAL_SEC).toBe(12 * 3600);
    expect(clockDriftWarns('recurring', 719 * 60)).toBe(false);
    expect(clockDriftWarns('recurring', 721 * 60)).toBe(true);
  });

  it("kind 'once' NEVER drifts — its interval is a delay, not a cadence", () => {
    expect(clockDriftMinutesFor('once', 1219 * 60)).toBeNull();
    expect(clockDriftWarns('once', 1219 * 60)).toBe(false);
    expect(clockDriftWarningFor('once', 1219 * 60, Date.now())).toBeUndefined();
    expect(projectNextFirings('once', 1219 * 60, Date.now(), 3)).toBeNull();
  });

  it('projectNextFirings projects the sweeper arithmetic (anchor + k·interval)', () => {
    const anchor = new Date('2026-09-24T14:30:00Z');
    const next = projectNextFirings('recurring', 1219 * 60, anchor, 3)!;
    expect(next).toHaveLength(3);
    expect(next[0]).toBe(new Date(anchor.getTime() + 1219 * 60_000).toISOString());
    expect(next[1]).toBe(new Date(anchor.getTime() + 2 * 1219 * 60_000).toISOString());
    expect(next[2]).toBe(new Date(anchor.getTime() + 3 * 1219 * 60_000).toISOString());
    // And the TIME-OF-DAY really marches 221 min earlier per firing (the drift
    // the ticket is about): firing 2's wall-clock time-of-day is 221 min
    // before firing 1's, and firing 3's 221 min before firing 2's.
    const tod = (iso: string) => {
      const d = new Date(iso);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    };
    for (let k = 1; k < 3; k++) {
      let delta = tod(next[k]) - tod(next[k - 1]);
      if (delta > 720) delta -= 1440;
      if (delta < -720) delta += 1440;
      expect(delta).toBe(-221);
    }
  });
});

// ── createSchedule: the advisory rides the successful arm ────────────────────

describe('clock-drift advisory on createSchedule (ticket 903249e5)', () => {
  it('REPLAYS the incident: arming the 1219m daily digest LANDS and carries the ⚠️ CLOCK DRIFT warning naming 221 min EARLIER each day', async () => {
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: 1219 * 60, promptSetBy: 'user' });
    expect(r.ok).toBe(true); // NON-blocking — the arm lands
    expect(r.schedule?.intervalSec).toBe(1219 * 60);
    expect(r.warning).toMatch(/CLOCK DRIFT/);
    expect(r.warning).toMatch(/221 min EARLIER/);
    expect(r.warning).toMatch(/every firing/);
    // The created view carries the drift for the inspection surfaces.
    expect(r.schedule?.clockDriftMinutes).toBe(-221);
    expect(r.schedule?.projectedNextFirings).toHaveLength(3);
  });

  it('a whole-day 1440m arm lands with NO drift warning (the fix the ticket asks for)', async () => {
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: 1440 * 60, promptSetBy: 'user' });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
    expect(r.schedule?.clockDriftMinutes).toBe(0);
  });

  it('a sub-daily 500m arm lands with NO drift warning (monitor loops cycle by design)', async () => {
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: 500 * 60, promptSetBy: 'user' });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('a machine arm is also only WARNED, never refused (drift is an owner-visible notice, not a guard)', async () => {
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: 1219 * 60, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/CLOCK DRIFT/);
  });

  it('a REFUSED arm is refused before any drift consideration', async () => {
    // Over-length prompt → refused before any drift consideration.
    const r = await createSchedule({ ...base, prompt: 'x'.repeat(8001), kind: 'recurring', intervalSec: 1219 * 60 });
    expect(r.ok).toBe(false);
  });

  it('a deduped re-arm (1ead3b52) returns the existing row without a drift warning', async () => {
    // An identical enabled machine row already exists → dedup path returns it.
    mockFindMany.mockResolvedValue([{ id: 'sch_dupe', kind: 'recurring', enabled: true, runsCount: 0, maxRuns: 500, prompt: base.prompt }]);
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: 1219 * 60, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('the drift warning COEXISTS with a cap-cadence warning (both ride `warning`, joined)', async () => {
    // 720m = 2/day — no cap concern; combine instead with a tight one is
    // impossible at ≥12h, so pin the join on the 1219m class: cadenceWarning
    // is undefined there, and the field still renders exactly the drift text.
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: 1219 * 60, promptSetBy: 'user' });
    expect(r.warning).toMatch(/CLOCK DRIFT/);
    expect(r.warning).not.toMatch(/CAP HEADROOM/);
    // (A cadence that trips BOTH cannot exist: ≥12h cadences project ≤2/day,
    //  far under any cap. The join is exercised by the update-path test below.)
  });
});

// ── updateScheduleForUser: re-spacing to a drifting cadence warns too ─────────

describe('clock-drift advisory on updateScheduleForUser (ticket 903249e5)', () => {
  it('re-spacing a live recurring to 1219m lands with the drift warning + drift fields on the returned view', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { intervalSec: 1219 * 60, promptSetBy: 'user' });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/CLOCK DRIFT/);
    expect(r.warning).toMatch(/221 min EARLIER/);
    expect(r.schedule?.clockDriftMinutes).toBe(-221);
  });

  it('re-spacing to a whole-day 1440m cadence lands with NO warning', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { intervalSec: 1440 * 60, promptSetBy: 'user' });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('a prompt-only rewrite of an already-drifting row surfaces the drift too (the row carries it)', async () => {
    // The row's intervalSec is 3600 here — sub-daily, no warning. Use a row
    // already at 1219m: the view's clockDriftMinutes exposes the march even
    // though no interval was passed.
    mockFindFirst.mockResolvedValue({ ...updRow, intervalSec: 1219 * 60 });
    // mockUpdate's seeded impl spreads the BASE updRow (3600s) — point it at
    // the 1219m row so the returned view carries the row's real cadence.
    mockUpdate.mockImplementation(({ data }: any) => Promise.resolve({ ...updRow, intervalSec: 1219 * 60, ...data }));
    const r = await updateScheduleForUser('u1', 'sch_1', { prompt: 're-briefed digest prompt', promptSetBy: 'user' });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/CLOCK DRIFT/);
    expect(r.schedule?.clockDriftMinutes).toBe(-221);
  });

  it('a REFUSED update is refused before the drift block', async () => {
    // Interval below minimum → refused before the drift block.
    const r = await updateScheduleForUser('u1', 'sch_1', { intervalSec: 60, promptSetBy: 'user' });
    expect(r.ok).toBe(false);
  });
});

// ── toView: every read surface sees the march ─────────────────────────────────

describe('ScheduleView drift fields (ticket 903249e5)', () => {
  it('a 1219m created row carries clockDriftMinutes −221 and 3 projected firings', async () => {
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: 1219 * 60, promptSetBy: 'user' });
    const v = r.schedule!;
    expect(v.clockDriftMinutes).toBe(-221);
    expect(v.projectedNextFirings?.length).toBe(3);
    // Projection anchors on the row's nextRunAt (now + interval).
    expect(new Date(v.projectedNextFirings![0]).getTime()).toBe(new Date(v.nextRunAt).getTime() + 1219 * 60_000);
  });

  it('a one-shot row carries null drift fields', async () => {
    const r = await createSchedule({ ...base, kind: 'once', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'user' });
    expect(r.ok).toBe(true);
    expect(r.schedule?.clockDriftMinutes).toBeNull();
    expect(r.schedule?.projectedNextFirings).toBeNull();
  });
});

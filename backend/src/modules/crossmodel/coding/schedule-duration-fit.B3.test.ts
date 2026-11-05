/**
 * Finding B3 (2026-09-27 audit, area "coding schedules — arm-time cadence vs
 * run duration"): the arm-time guard (capCadenceGuard) never looked at run
 * duration and coding runs carry no deadline (CODING_PROFILE.runDeadlineMs
 * undefined), so 15–30-min cadences were armed on lanes whose runs last
 * 546–991 min — one lane: 3,643 busy-skips; four 15-min rows fired 0×.
 *
 * The fix lives in coding/schedule.service.ts:
 *   - p50Ms / durationFitFloorSec / fitIntervalToRunLength: pure math — the
 *     cadence floor is durationFitMultiplier() × the lane's p50 run length over
 *     its last 10 FINISHED agent_runs, rounded up to 5 min, ≥ MIN_INTERVAL_SEC,
 *     capped at one day. The multiplier is 1 by default (fixer pass, 2026-09-27
 *     — the branch's 2× halved the duty cycle of every machine lane whose run
 *     exceeds half its cadence); env SCHEDULE_DURATION_FIT_MULTIPLIER re-spaces
 *     harder;
 *   - durationFitGuard: a MACHINE recurring arm/update below the floor is
 *     STRETCHED to it (the row carries the stretched interval; `warning` +
 *     `stretchedFrom` say so); an owner's is advised only; fewer than 3
 *     finished runs or a read error leave the cadence untouched (fail-open);
 *   - createSchedule (fixer pass): the stretch is a RECURRENCE change only —
 *     the FIRST firing keeps the requested delay (the sweeper's post-fire claim
 *     re-arms at the stretched intervalSec; SCHEDULE_DURATION_FIT_FIRST_FIRING_
 *     STRETCHED=1 restores the branch shape), and a stretched arm SKIPS the
 *     ae20da66 same-cadence collapse (the fit erases the interval as the job
 *     discriminator; SCHEDULE_DURATION_FIT_COLLAPSE_STRETCHED=1 restores it);
 *   - scheduleFiringDeadlineMs / computeScheduleFiringDeadlineMs: the OPT-IN
 *     (SCHEDULE_DURATION_DEADLINE_ENABLED=1) soft deadline of 3× the firing
 *     schedule's interval for recurring machine firings — null by default
 *     (the 2026-09-11 gate flip keeps machine runs undeadlined).
 *
 * Harness mirrors schedule-cap-cadence.2694a581.test.ts (colocated mocked
 * prisma/redis/hooks/fire-path) + an agentRun.findMany seam; the fire-path
 * mocks of schedule.service.test.ts (message queue, superseded gate) are
 * added so the end-to-end sweeper test can run fireDue().
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
const mockRunFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockRunCreate = jest.fn(async (..._a: any[]) => ({ id: 'run-1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryCreate = jest.fn(async (..._a: any[]) => ({ id: 'ph-1' }));
const mockPromptHistoryCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);

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
      findMany: (...a: any[]) => mockRunFindMany(...a),
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

jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  enqueueChatMessage: jest.fn(async () => ({ id: 'pend-1', position: 1 })),
  peekWakeRider: jest.fn(async () => null),
  consumeWakeRider: jest.fn(async () => 0),
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
    SCHEDULE_DURATION_FIT: 'schedule_duration_fit',
    SCHEDULE_PARKED_CLAIM: 'schedule_parked_claim', SCHEDULE_SUPERSEDED_SKIP: 'schedule_superseded_skip',
    SCHEDULE_CONTINUATION_SKIP: 'schedule_continuation_skip',
  },
}));

const NO_GATE = (ineligible: string | null, facts: any = null) => ({ ineligible, facts, decision: null, stash: null, skip: null });
const mockPreGateParkedFiring = jest.fn(async (..._a: any[]): Promise<any> => NO_GATE('mode_off'));
jest.mock('./firing-superseded-gate', () => ({
  __esModule: true,
  ...(jest.requireActual('./firing-superseded-gate')),
  preGateParkedFiring: (...a: any[]) => mockPreGateParkedFiring(...a),
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
  createSchedule, updateScheduleForUser, fireDue, MIN_INTERVAL_SEC,
  p50Ms, durationFitFloorSec, fitIntervalToRunLength, durationFitGuard, recentRunDurationsMs,
  durationFitMultiplier, durationFitFirstFiringStretched, durationFitCollapseStretched,
  DURATION_FIT_SAMPLE_RUNS, DURATION_FIT_MIN_SAMPLES, DURATION_FIT_MULTIPLIER, DURATION_FIT_MULTIPLIER_MAX,
  DURATION_FIT_ROUND_SEC, DURATION_FIT_MAX_INTERVAL_SEC,
  scheduleFiringDeadlineMs, computeScheduleFiringDeadlineMs, MACHINE_RUN_DEADLINE_FLOOR_MS,
  SCHEDULE_FIRING_DEADLINE_MULTIPLIER,
} from './schedule.service';

const base = { sessionId: 's1', userId: 'u1', prompt: 'continue the training sweep' };

/** N finished agent_runs each lasting `minutes` (newest first). */
function runsLasting(minutes: number, n = DURATION_FIT_SAMPLE_RUNS) {
  const t0 = Date.parse('2026-09-27T00:00:00Z');
  return Array.from({ length: n }, (_, i) => ({
    startedAt: new Date(t0 - i * 24 * 3_600_000),
    finishedAt: new Date(t0 - i * 24 * 3_600_000 + minutes * 60_000),
  }));
}

/** The floor (seconds) the fit implies for a p50 of `p50Min` minutes under
 *  `multiplier` — the same rounding/clamping the service documents, kept here
 *  so every expectation below is parametrised on the constant. */
function floorSecFor(p50Min: number, multiplier = DURATION_FIT_MULTIPLIER): number {
  const rounded = Math.ceil((multiplier * p50Min * 60) / DURATION_FIT_ROUND_SEC) * DURATION_FIT_ROUND_SEC;
  return Math.min(DURATION_FIT_MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, rounded));
}

/** A live recurring row for the updateScheduleForUser path. */
const updRow = {
  id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'old prompt', kind: 'recurring',
  intervalSec: 7200, nextRunAt: new Date(Date.now() + 7_200_000), enabled: true,
  runsCount: 3, maxRuns: 500, expiresAt: new Date(Date.now() + 10 * 24 * 3_600_000),
  lastFiredAt: null, lastStatus: 'started', createdAt: new Date(), promptSetBy: 'machine',
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SCHEDULE_DURATION_DEADLINE_ENABLED;
  delete process.env.SCHEDULE_DURATION_FIT_MULTIPLIER;
  delete process.env.SCHEDULE_DURATION_FIT_FIRST_FIRING_STRETCHED;
  delete process.env.SCHEDULE_DURATION_FIT_COLLAPSE_STRETCHED;
  mockCount.mockResolvedValue(0);
  mockFindMany.mockResolvedValue([]);
  mockFindFirst.mockResolvedValue(updRow);
  mockRunFindMany.mockResolvedValue([]);
  mockStaleFindMany.mockResolvedValue([]);
  mockUpdateMany.mockResolvedValue({ count: 0 });
  mockGet.mockResolvedValue(null);
  mockGetDel.mockResolvedValue(null);
  mockIncrBy.mockResolvedValue(1);
  mockPTtl.mockResolvedValue(-2);
  mockGetChatAutonomy.mockResolvedValue({ scheduleCap: 480 }); // roomy cap: the cap guard stays quiet
  mockChatFindUnique.mockResolvedValue(undefined); // not a supervisor chat
  mockCreate.mockImplementation(({ data }: any) => Promise.resolve({
    id: 'sch_new', ...data, lastFiredAt: null, lastStatus: null, runsCount: 0,
    busySkips: 0, cancelledBy: null, disabledAt: null, promptSetBy: data.promptSetBy ?? null,
  }));
  mockUpdate.mockImplementation(({ data }: any) => Promise.resolve({ ...updRow, ...data }));
});

// ── Pure math ─────────────────────────────────────────────────────────────────

describe('duration-fit math (finding B3)', () => {
  it('p50Ms: median of the positive durations; even count averages the middle pair; empty → null', () => {
    expect(p50Ms([])).toBeNull();
    expect(p50Ms([0, -5, NaN])).toBeNull();
    expect(p50Ms([300_000])).toBe(300_000);
    expect(p50Ms([100, 300, 200])).toBe(200);
    expect(p50Ms([100, 400, 200, 300])).toBe(250);
    // Outliers do not drag the median the way a mean would.
    expect(p50Ms([600_000, 600_000, 600_000, 60_000_000])).toBe(600_000);
  });

  it('the default multiplier is 1× p50 (fixer pass: the branch\'s 2× halved the duty cycle of every machine lane whose run exceeds half its cadence)', () => {
    expect(DURATION_FIT_MULTIPLIER).toBe(1);
    expect(durationFitMultiplier()).toBe(1);
    expect(durationFitFirstFiringStretched()).toBe(false);
    expect(durationFitCollapseStretched()).toBe(false);
  });

  it('durationFitFloorSec: multiplier × p50 rounded UP to 5 min, never below the 15-min minimum, capped at one day', () => {
    // 546-min runs (the audit's low end) → 546 min → rounds to 550 min at 1×.
    expect(durationFitFloorSec(546 * 60_000)).toBe(floorSecFor(546));
    expect(floorSecFor(546)).toBe(550 * 60);
    // 991-min runs (the audit's high end) → 995 min at 1× (under the one-day ceiling).
    expect(durationFitFloorSec(991 * 60_000)).toBe(floorSecFor(991));
    expect(floorSecFor(991)).toBe(995 * 60);
    // A p50 past one day is capped at 1440.
    expect(durationFitFloorSec(1500 * 60_000)).toBe(DURATION_FIT_MAX_INTERVAL_SEC);
    // Short runs never push the floor below the schedule minimum.
    expect(durationFitFloorSec(2 * 60_000)).toBe(MIN_INTERVAL_SEC);
    // Exact multiple stays put: 30-min runs → 30 min.
    expect(durationFitFloorSec(30 * 60_000)).toBe(30 * 60);
    // The explicit multiplier argument is the parametrised path (the branch's 2× math survives under it).
    expect(durationFitFloorSec(546 * 60_000, 2)).toBe(1095 * 60);
    expect(durationFitFloorSec(991 * 60_000, 2)).toBe(DURATION_FIT_MAX_INTERVAL_SEC);
  });

  it('durationFitMultiplier: env SCHEDULE_DURATION_FIT_MULTIPLIER (finite, > 0) overrides; junk / ≤ 0 keep the default; clamped at the max', () => {
    process.env.SCHEDULE_DURATION_FIT_MULTIPLIER = '2';
    expect(durationFitMultiplier()).toBe(2);
    expect(durationFitFloorSec(600 * 60_000)).toBe(1200 * 60);
    process.env.SCHEDULE_DURATION_FIT_MULTIPLIER = '1.5';
    expect(durationFitMultiplier()).toBe(1.5);
    expect(durationFitFloorSec(600 * 60_000)).toBe(900 * 60);
    for (const junk of ['', '  ', 'abc', '0', '-1', 'NaN', 'Infinity']) {
      process.env.SCHEDULE_DURATION_FIT_MULTIPLIER = junk;
      expect(durationFitMultiplier()).toBe(DURATION_FIT_MULTIPLIER);
    }
    process.env.SCHEDULE_DURATION_FIT_MULTIPLIER = '999';
    expect(durationFitMultiplier()).toBe(DURATION_FIT_MULTIPLIER_MAX);
  });

  it('fitIntervalToRunLength: below the floor → stretched to it; at/above → unchanged', () => {
    expect(fitIntervalToRunLength(15 * 60, 600 * 60_000)).toEqual({ intervalSec: 600 * 60, floorSec: 600 * 60, stretched: true });
    expect(fitIntervalToRunLength(600 * 60, 600 * 60_000)).toEqual({ intervalSec: 600 * 60, floorSec: 600 * 60, stretched: false });
    expect(fitIntervalToRunLength(1440 * 60, 600 * 60_000)).toEqual({ intervalSec: 1440 * 60, floorSec: 600 * 60, stretched: false });
    // Parametrised on the multiplier argument.
    expect(fitIntervalToRunLength(15 * 60, 600 * 60_000, 2)).toEqual({ intervalSec: 1200 * 60, floorSec: 1200 * 60, stretched: true });
  });
});

// ── recentRunDurationsMs ──────────────────────────────────────────────────────

describe('recentRunDurationsMs', () => {
  it('reads the last 10 FINISHED runs of the lane (both timestamps set), newest first, dropping zero/negative spans', async () => {
    mockRunFindMany.mockResolvedValue([
      ...runsLasting(600, 2),
      { startedAt: new Date('2026-09-20T00:00:00Z'), finishedAt: new Date('2026-09-20T00:00:00Z') }, // zero span
      { startedAt: null, finishedAt: new Date() }, // defensive: would be excluded by the where anyway
    ]);
    const out = await recentRunDurationsMs('s1');
    expect(out).toEqual([600 * 60_000, 600 * 60_000]);
    expect(mockRunFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: 's1', startedAt: { not: null }, finishedAt: { not: null } },
      orderBy: { startedAt: 'desc' },
      take: DURATION_FIT_SAMPLE_RUNS,
    }));
  });
});

// ── durationFitGuard ──────────────────────────────────────────────────────────

describe('durationFitGuard', () => {
  it('REPLAYS the audit class: a 15-min MACHINE cadence on a lane whose runs take ~600 min is STRETCHED to 600 min (1× p50) + one stretched metric', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    const v = await durationFitGuard('s1', MIN_INTERVAL_SEC, true);
    expect(v).toMatchObject({ requestedSec: 900, intervalSec: 600 * 60, floorSec: 600 * 60, p50RunMs: 600 * 60_000, samples: 10, multiplier: 1, stretched: true });
    expect(v!.warn).toMatch(/CADENCE STRETCHED/);
    expect(v!.warn).toMatch(/~600 min each/);
    expect(v!.warn).toMatch(/every 15 min is shorter than the run/);
    expect(v!.warn).toMatch(/Armed at every 600 min instead \(≥ the p50 run length\)/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'schedule_duration_fit', sessionId: 's1',
      meta: expect.objectContaining({ outcome: 'stretched', requestedSec: 900, intervalSec: 36_000, floorSec: 36_000, p50RunMs: 36_000_000, samples: 10, multiplier: 1 }),
    }));
  });

  it('SCHEDULE_DURATION_FIT_MULTIPLIER=2 restores the branch\'s spacing: the same lane stretches to 1200 min and the prose names the multiplier', async () => {
    process.env.SCHEDULE_DURATION_FIT_MULTIPLIER = '2';
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    const v = await durationFitGuard('s1', MIN_INTERVAL_SEC, true);
    expect(v).toMatchObject({ intervalSec: 1200 * 60, floorSec: 1200 * 60, multiplier: 2, stretched: true });
    expect(v!.warn).toMatch(/Armed at every 1200 min instead \(≥ 2× the p50 run length\)/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'schedule_duration_fit',
      meta: expect.objectContaining({ outcome: 'stretched', intervalSec: 72_000, multiplier: 2 }),
    }));
  });

  it('the one-day ceiling: 1500-min runs stretch a 30-min machine cadence to 1440 min and say so', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(1500));
    const v = await durationFitGuard('s1', 1800, true);
    expect(v!.intervalSec).toBe(DURATION_FIT_MAX_INTERVAL_SEC);
    expect(v!.warn).toMatch(/the one-day ceiling/);
  });

  it('owner autonomy: an OWNER cadence is ADVISED (warned metric), never stretched', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    const v = await durationFitGuard('s1', MIN_INTERVAL_SEC, false, 'sch_9');
    expect(v).toMatchObject({ requestedSec: 900, intervalSec: 900, stretched: false });
    expect(v!.warn).toMatch(/CADENCE vs RUN LENGTH/);
    expect(v!.warn).toMatch(/kept as requested/);
    expect(v!.warn).toMatch(/≥600 min would fit/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'schedule_duration_fit',
      meta: expect.objectContaining({ outcome: 'warned', intervalSec: 900, multiplier: 1, scheduleId: 'sch_9' }),
    }));
  });

  it('a cadence that already fits (≥ 1× p50) is silent — no verdict, no metric', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(5));
    await expect(durationFitGuard('s1', 1800, true)).resolves.toBeNull();
    // Exactly the median: a 30-min cadence on a 30-min lane fits — at 1× a
    // busy-skip happens only on an ABOVE-median run (the finding-2 property).
    mockRunFindMany.mockResolvedValue(runsLasting(30));
    await expect(durationFitGuard('s1', 1800, true)).resolves.toBeNull();
    // The branch's 2× would have stretched that same 30-min cadence to 60 min.
    process.env.SCHEDULE_DURATION_FIT_MULTIPLIER = '2';
    await expect(durationFitGuard('s1', 1800, true)).resolves.toMatchObject({ intervalSec: 3600, stretched: true });
    delete process.env.SCHEDULE_DURATION_FIT_MULTIPLIER;
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
  });

  it(`fail-open: fewer than ${DURATION_FIT_MIN_SAMPLES} finished runs → no verdict (a young lane is never re-spaced on guesswork)`, async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(600, DURATION_FIT_MIN_SAMPLES - 1));
    await expect(durationFitGuard('s1', MIN_INTERVAL_SEC, true)).resolves.toBeNull();
    mockRunFindMany.mockResolvedValue(runsLasting(600, DURATION_FIT_MIN_SAMPLES));
    await expect(durationFitGuard('s1', MIN_INTERVAL_SEC, true)).resolves.toMatchObject({ stretched: true });
  });

  it('fail-open: a read error leaves the cadence untouched', async () => {
    mockRunFindMany.mockRejectedValue(new Error('db down'));
    await expect(durationFitGuard('s1', MIN_INTERVAL_SEC, true)).resolves.toBeNull();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });
});

// ── createSchedule wiring ─────────────────────────────────────────────────────

describe('createSchedule — arm-time duration fit', () => {
  it('a 15-min MACHINE recurring arm on a 600-min lane LANDS at 600 min: the row carries the stretched interval, the result says so — and the FIRST firing keeps the requested +15 min (idle-lane arm)', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    const before = Date.now();
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.stretchedFrom).toBe(900);
    expect(r.schedule!.intervalSec).toBe(600 * 60);
    expect(r.warning).toMatch(/CADENCE STRETCHED/);
    expect(r.warning).toMatch(/The FIRST firing keeps your requested delay \(\+15 min\); the stretched cadence applies from the second firing on\./);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.intervalSec).toBe(600 * 60);
    // Fixer finding 1: the stretch is a RECURRENCE change — nextRunAt follows
    // the REQUESTED delay, so a lane that ends its run with `schedule_self
    // recurring 15 min` to continue is picked up in 15 min when idle (a busy
    // lane rides the +3-min busy-skip retry pinned in schedule.service.test.ts).
    const firstDelayMs = data.nextRunAt.getTime() - before;
    expect(firstDelayMs).toBeGreaterThanOrEqual(15 * 60_000 - 50);
    expect(firstDelayMs).toBeLessThan(15 * 60_000 + 5_000);
  });

  it('SCHEDULE_DURATION_FIT_FIRST_FIRING_STRETCHED=1 restores the branch shape: the first firing waits the full stretched interval', async () => {
    process.env.SCHEDULE_DURATION_FIT_FIRST_FIRING_STRETCHED = '1';
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.stretchedFrom).toBe(900);
    expect(r.warning).toMatch(/CADENCE STRETCHED/);
    expect(r.warning).not.toMatch(/FIRST firing keeps/);
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.intervalSec).toBe(600 * 60);
    expect(data.nextRunAt.getTime() - Date.now()).toBeGreaterThan(599 * 60_000);
  });

  it('END-TO-END (idle lane): the first firing at +15 min STARTS a run and the sweeper\'s claim re-arms at the STRETCHED cadence (firedAt + 600 min)', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    const created = mockCreate.mock.calls[0][0].data;
    // 15 min later the row is due; the lane is idle (no run holds it).
    const dueRow = {
      id: 'sch_new', ...created, nextRunAt: new Date(Date.now() - 1000), runsCount: 0,
      lastFiredAt: null, lastStatus: null, createdAt: new Date(), busySkips: 0, cancelledBy: null, disabledAt: null,
    };
    mockFindMany.mockResolvedValue([dueRow]);
    mockUpdateMany.mockResolvedValue({ count: 1 }); // the atomic claim wins
    mockUpdate.mockResolvedValue({ ...dueRow });
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockIncr.mockResolvedValue(1);
    mockStartScheduledRun.mockResolvedValue({ started: true });
    const firedAt = Date.now();
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledWith('s1', base.prompt, expect.objectContaining({ origin: 'schedule', scheduleId: 'sch_new' }));
    const claim = mockUpdateMany.mock.calls.map((c) => c[0]).find((u) => u?.where?.id === 'sch_new' && u?.data?.nextRunAt instanceof Date && u?.data?.lastStatus === undefined);
    expect(claim).toBeTruthy();
    const reArmMs = (claim.data.nextRunAt as Date).getTime() - firedAt;
    expect(reArmMs).toBeGreaterThanOrEqual(600 * 60_000 - 50);
    expect(reArmMs).toBeLessThan(600 * 60_000 + 5_000);
  });

  it('the cap-cadence guard sees the STRETCHED interval: 15 min at the default 48/day cap would be REFUSED, but stretched to 600 min it arms clean', async () => {
    mockGetChatAutonomy.mockResolvedValue(null); // default cap 48 → 15 min (96/day) can never fit
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.schedule!.intervalSec).toBe(600 * 60);
    expect(r.warning).not.toMatch(/CAP MATH|CAP HEADROOM/);
  });

  it('an OWNER arm keeps its 15-min cadence and carries the advisory (never overridden)', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'user' });
    expect(r.ok).toBe(true);
    expect(r.stretchedFrom).toBeUndefined();
    expect(r.schedule!.intervalSec).toBe(900);
    expect(r.warning).toMatch(/CADENCE vs RUN LENGTH/);
    expect(r.warning).not.toMatch(/FIRST firing keeps/);
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.nextRunAt.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
  });

  it('a lane whose runs are SHORT arms exactly as requested — no warning, no stretchedFrom, no metric', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(4));
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: 1800, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.stretchedFrom).toBeUndefined();
    expect(r.warning).toBeUndefined();
    expect(r.schedule!.intervalSec).toBe(1800);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'schedule_duration_fit' }));
  });

  it('one-shots are never fitted (their interval is a delay, not a cadence)', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    const r = await createSchedule({ ...base, kind: 'once', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.schedule!.intervalSec).toBe(900);
    expect(mockRunFindMany).not.toHaveBeenCalled();
  });
});

// ── createSchedule × the ae20da66 same-cadence collapse ───────────────────────

describe('createSchedule — a STRETCHED arm skips the same-cadence collapse (fixer finding 3)', () => {
  /** The tx re-read the collapse would run — returns a row so a wrongly-run
   *  collapse is LOUD (it would cancel it). */
  const armRival = () => mockStaleFindMany.mockResolvedValue([{ id: 'sch_30min', runsCount: 2 }]);

  it('existing 30-min machine row + new 15-min arm on a 600-min lane ⇒ BOTH live, superseded empty, no cancel written', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    armRival();
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.stretchedFrom).toBe(900);
    expect(r.schedule!.intervalSec).toBe(600 * 60);
    expect(r.superseded).toBeUndefined();
    // The collapse never ran: no in-transaction stale read, no cancel, no schedule_disabled event.
    expect(mockStaleFindMany).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockEmitHookEvent.mock.calls.filter((c) => c[1] === 'schedule_disabled')).toHaveLength(0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('an UN-stretched machine arm still collapses a same-cadence row (ae20da66 unchanged)', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(4)); // short runs: 30 min fits
    mockStaleFindMany.mockResolvedValue([{ id: 'sch_old', runsCount: 1 }]);
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: 1800, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.stretchedFrom).toBeUndefined();
    expect(r.superseded).toEqual(['sch_old']);
    expect(mockStaleFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ intervalSec: 1800, id: { not: 'sch_new' } }) }));
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['sch_old'] } },
      data: { enabled: false, lastStatus: 'cancelled', cancelledBy: 'machine', disabledAt: expect.any(Date) },
    });
  });

  it('SCHEDULE_DURATION_FIT_COLLAPSE_STRETCHED=1 restores the branch shape: the stretched arm collapses at the STRETCHED cadence', async () => {
    process.env.SCHEDULE_DURATION_FIT_COLLAPSE_STRETCHED = '1';
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    armRival();
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.stretchedFrom).toBe(900);
    expect(r.superseded).toEqual(['sch_30min']);
    expect(mockStaleFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ intervalSec: 600 * 60 }) }));
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('an IDENTICAL-prompt re-arm on a stretched lane still ADOPTS the existing row (1ead3b52 dedup runs before the fit lands a row)', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    mockFindMany.mockResolvedValue([{ id: 'sch_same', prompt: base.prompt, kind: 'recurring', intervalSec: 600 * 60, enabled: true, runsCount: 1, maxRuns: 500, nextRunAt: new Date(), promptSetBy: 'machine' }]);
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(true);
    expect(r.schedule!.id).toBe('sch_same');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ── updateScheduleForUser wiring ──────────────────────────────────────────────

describe('updateScheduleForUser — arm-time duration fit', () => {
  it('a MACHINE interval update to 15 min on a 600-min lane stores 600 min and reports stretchedFrom (nextRunAt untouched: the next firing keeps its timing)', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    const r = await updateScheduleForUser('u1', 'sch_1', { intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.stretchedFrom).toBe(900);
    expect(r.warning).toMatch(/CADENCE STRETCHED/);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'sch_1' }, data: expect.objectContaining({ intervalSec: 600 * 60 }) }));
    expect(mockUpdate.mock.calls[0][0].data.nextRunAt).toBeUndefined();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'schedule_duration_fit',
      meta: expect.objectContaining({ outcome: 'stretched', multiplier: 1, scheduleId: 'sch_1' }),
    }));
  });

  it('an OWNER interval update keeps 15 min with the advisory', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    const r = await updateScheduleForUser('u1', 'sch_1', { intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'user' });
    expect(r.ok).toBe(true);
    expect(r.stretchedFrom).toBeUndefined();
    expect(r.warning).toMatch(/CADENCE vs RUN LENGTH/);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ intervalSec: 900 }) }));
  });

  it('a prompt-only update never reads run history', async () => {
    mockRunFindMany.mockResolvedValue(runsLasting(600));
    const r = await updateScheduleForUser('u1', 'sch_1', { prompt: 'new prompt', promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(mockRunFindMany).not.toHaveBeenCalled();
  });
});

// ── Opt-in soft deadline for recurring machine firings ────────────────────────

describe('schedule-firing soft deadline (finding B3 — OPT-IN, default OFF per the 2026-09-11 gate flip)', () => {
  it('scheduleFiringDeadlineMs: max(20-min floor, 3× interval)', () => {
    expect(SCHEDULE_FIRING_DEADLINE_MULTIPLIER).toBe(3);
    expect(scheduleFiringDeadlineMs(900)).toBe(Math.max(MACHINE_RUN_DEADLINE_FLOOR_MS, 3 * 900_000)); // 45 min
    expect(scheduleFiringDeadlineMs(300)).toBe(MACHINE_RUN_DEADLINE_FLOOR_MS); // 15 min < floor
    expect(scheduleFiringDeadlineMs(600 * 60)).toBe(3 * 600 * 60_000); // 30 h on a fitted cadence (≥ 3× the lane's p50 at the 1× fit)
    expect(scheduleFiringDeadlineMs(0)).toBe(MACHINE_RUN_DEADLINE_FLOOR_MS);
    expect(scheduleFiringDeadlineMs(NaN)).toBe(MACHINE_RUN_DEADLINE_FLOOR_MS);
  });

  it('DEFAULT (SCHEDULE_DURATION_DEADLINE_ENABLED unset) → null and NOTHING is read: machine runs stay undeadlined', async () => {
    mockScheduleFindUnique.mockResolvedValue({ kind: 'recurring', intervalSec: 900, promptSetBy: 'machine' });
    await expect(computeScheduleFiringDeadlineMs('sch_1')).resolves.toBeNull();
    process.env.SCHEDULE_DURATION_DEADLINE_ENABLED = '0';
    await expect(computeScheduleFiringDeadlineMs('sch_1')).resolves.toBeNull();
    expect(mockScheduleFindUnique).not.toHaveBeenCalled();
  });

  it('opt-in: a recurring MACHINE/SYSTEM row → 3× its interval; owner rows, one-shots, missing rows and read errors → null', async () => {
    process.env.SCHEDULE_DURATION_DEADLINE_ENABLED = '1';
    await expect(computeScheduleFiringDeadlineMs(undefined)).resolves.toBeNull();
    mockScheduleFindUnique.mockResolvedValue({ kind: 'recurring', intervalSec: 1200 * 60, promptSetBy: 'machine' });
    await expect(computeScheduleFiringDeadlineMs('sch_1')).resolves.toBe(3 * 1200 * 60_000);
    mockScheduleFindUnique.mockResolvedValue({ kind: 'recurring', intervalSec: 900, promptSetBy: 'system' });
    await expect(computeScheduleFiringDeadlineMs('sch_1')).resolves.toBe(45 * 60_000);
    mockScheduleFindUnique.mockResolvedValue({ kind: 'recurring', intervalSec: 900, promptSetBy: 'user' });
    await expect(computeScheduleFiringDeadlineMs('sch_1')).resolves.toBeNull();
    mockScheduleFindUnique.mockResolvedValue({ kind: 'recurring', intervalSec: 900, promptSetBy: null });
    await expect(computeScheduleFiringDeadlineMs('sch_1')).resolves.toBeNull();
    mockScheduleFindUnique.mockResolvedValue({ kind: 'once', intervalSec: 900, promptSetBy: 'machine' });
    await expect(computeScheduleFiringDeadlineMs('sch_1')).resolves.toBeNull();
    mockScheduleFindUnique.mockResolvedValue(null);
    await expect(computeScheduleFiringDeadlineMs('sch_1')).resolves.toBeNull();
    mockScheduleFindUnique.mockRejectedValue(new Error('db down'));
    await expect(computeScheduleFiringDeadlineMs('sch_1')).resolves.toBeNull();
  });
});

/**
 * Scheduler remediation P3 — red-green pins for the durable-bus work:
 *   v1#14 / spark G1 / CanLaw L1 — [SCHEDULE STATE] wake context + renewOnExhaustion
 *   v1#16                       — fireDue self-health (tick deadline)
 *   v1#33                       — machine-run soft deadline + busy-skip streak alarm
 *   CanLaw L8 / spark B14       — continuation obsolete/recurring-owner checks
 *   CanLaw B1                   — update_schedule refuses disabled/terminal rows
 *   P3 batch 14a/14b            — lastFiredAt on actual fire only; cap-TTL re-ensure
 * Harness mirrors schedule.service.test.ts (colocated mock-everything pattern).
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
const mockUpdateMany = jest.fn();
const mockDeleteMany = jest.fn();
const mockScheduleFindUnique = jest.fn(async (..._args: any[]): Promise<any> => ({ enabled: true }));
const mockRedisDel = jest.fn(async (..._a: any[]) => 1);
const mockChatFindUnique = jest.fn();
const mockChatUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockMsgCreate = jest.fn(async (..._a: any[]) => ({}));
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-cont-1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockCodingStateFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);

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
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), update: (...a: any[]) => mockChatUpdate(...a) },
    crossModelMessage: { create: (...a: any[]) => mockMsgCreate(...a) },
    chatCodingState: { findUnique: (...a: any[]) => mockCodingStateFindUnique(...a) },
  },
}));
const mockIncr = jest.fn();
const mockExpire = jest.fn(async (..._args: any[]) => {});
const mockDecr = jest.fn(async (..._args: any[]) => {});
const mockSet = jest.fn(async (..._args: any[]): Promise<any> => 'OK');
const mockGet = jest.fn();
const mockPTtl = jest.fn();
const mockGetDel = jest.fn();
const mockIncrBy = jest.fn();
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

const mockEmitHookEvent = jest.fn(async (..._args: any[]) => {});
const mockSweepHookEvents = jest.fn(async (..._args: any[]) => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  sweepHookEvents: (...a: any[]) => mockSweepHookEvents(...a),
}));

const mockStartScheduledRun = jest.fn(async (..._args: any[]): Promise<any> => ({ started: true }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
}));

const mockStartDetachedChatRun = jest.fn((..._args: any[]): string | null => 'chat:s1');
// Busy-chat queue (dynamic import on the plain-chat fire path — the wake
// rider peek since hardening loop iteration 7, 2026-09-24, and the
// queue-behind-busy enqueue): mocked at the module boundary so the real
// module's error-handler → config/env chain never loads in this keyless env.
jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  enqueueChatMessage: jest.fn(async () => ({ id: 'pend-1', position: 1 })),
  peekWakeRider: jest.fn(async () => null),
  consumeWakeRider: jest.fn(async () => 0),
}));

jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatRunKey: (id: string) => `chat:${id}`,
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked', SWEEP_TICK: 'sweep_tick', LEASE_HEARTBEAT_FAILED: 'lease_heartbeat_failed', SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', SCHEDULE_BUSY_ALARM: 'schedule_busy_alarm' },
}));

const mockQueueStoppedScheduleAlert = jest.fn((..._a: any[]) => {});
jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: (...a: any[]) => mockQueueStoppedScheduleAlert(...a),
  maybeFileStoppedScheduleDecision: jest.fn(async () => ({ filed: false, reason: 'lane_alive' })),
}));

const mockResolveStoppedForSession = jest.fn(async (..._a: any[]) => 0);
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  resolveStoppedScheduleDecisionsForSession: (...a: any[]) => mockResolveStoppedForSession(...a),
}));

const mockGetPlanStrict = jest.fn(async (..._args: any[]) => null as any);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: (...a: any[]) => mockGetPlanStrict(...a),
}));

import logger from '../../../utils/logger';
import {
  fireDue, fireScheduleTarget, updateScheduleForUser, queueContinuationRun,
  maybeRenewOnExhaustion, computeMachineRunDeadlineMs, remainingRunDeadlineMs, RECLAIM_DEADLINE_GRACE_MS, dailyCapExceeded,
  getScheduleHealth, busySkipAlarmLevel,
  MACHINE_RUN_DEADLINE_FLOOR_MS, SWEEP_TICK_DEADLINE_MS, MIN_INTERVAL_SEC, MAX_LIFETIME_MS,
} from './schedule.service';

/** A due recurring row (the sweeper's view). */
const dueRow = (over: any = {}) => ({
  id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'do the thing', kind: 'recurring',
  intervalSec: 3600, nextRunAt: new Date(Date.now() - 1000), enabled: true,
  runsCount: 3, maxRuns: 32, expiresAt: new Date(Date.now() + 86_400_000),
  lastFiredAt: null, lastStatus: null, promptSetBy: 'machine', renewOnExhaustion: null,
  busySkips: 0, createdAt: new Date(),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset (not just clear) for the mocks individual tests override with
  // mockResolvedValue — clearAllMocks keeps implementations, so a prior test's
  // blocking-run stub would leak into the continuation busy-gate.
  mockRunFindFirst.mockReset().mockResolvedValue(null);
  mockRunCreate.mockReset().mockResolvedValue({ id: 'run-cont-1' });
  mockRunCount.mockReset().mockResolvedValue(0);
  mockCodingStateFindUnique.mockReset().mockResolvedValue(null);
  mockFindMany.mockResolvedValue([]);
  mockFindFirst.mockResolvedValue(null);
  mockUpdate.mockResolvedValue({});
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockDeleteMany.mockResolvedValue({ count: 0 });
  mockCount.mockResolvedValue(0);
  mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' }, parentChatId: null });
  mockScheduleFindUnique.mockResolvedValue({ enabled: true });
  mockStartScheduledRun.mockResolvedValue({ started: true });
  mockGetChatAutonomy.mockResolvedValue(null); // default cap 48
  mockIncr.mockResolvedValue(1);
  mockGet.mockResolvedValue(null);
  mockGetDel.mockResolvedValue(null);
  mockPTtl.mockResolvedValue(-2);
  mockSet.mockResolvedValue('OK');
  mockGetPlanStrict.mockResolvedValue({ steps: [{ status: 'pending' }] });
  mockCreate.mockImplementation(({ data }: any) => Promise.resolve({ id: 'succ-1', ...data }));
});

/* ====================================================================
 * v1#14 (a) — [SCHEDULE STATE] injection into every schedule firing.
 * ==================================================================== */
describe('v1#14a — [SCHEDULE STATE] wake context', () => {
  it('appends firing N of M · expires · daily N/K from the fresh row + cap state', async () => {
    mockScheduleFindUnique.mockResolvedValue({
      enabled: true, kind: 'recurring', runsCount: 4, maxRuns: 32,
      expiresAt: new Date('2026-10-08T12:00:00Z'), intervalSec: 3600,
    });
    mockGet.mockResolvedValue('3'); // 3 firings used this window
    mockPTtl.mockResolvedValue(3_600_000);
    const res = await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'do the thing', origin: 'schedule' });
    expect(res).toEqual({ started: true });
    const prompt = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(prompt).toContain('do the thing');
    expect(prompt).toContain('[SCHEDULE STATE] firing 5 of 32 · expires 2026-10-08 · daily 3/48');
    // APPENDED, never prepended — title seeds + startsWith contracts read the head.
    expect(prompt.startsWith('do the thing')).toBe(true);
  });

  it('unbounded rows render ∞ / never; hook wakes get NO schedule-state block', async () => {
    mockScheduleFindUnique.mockResolvedValue({ enabled: true, kind: 'recurring', runsCount: 0, maxRuns: null, expiresAt: null, intervalSec: 3600 });
    await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'p', origin: 'schedule' });
    expect(mockStartScheduledRun.mock.calls[0][1]).toContain('firing 1 of ∞ · expires never');
    mockStartScheduledRun.mockClear();
    await fireScheduleTarget({ id: 'hook-h1', sessionId: 's1', prompt: 'p', origin: 'hook' });
    expect(mockStartScheduledRun.mock.calls[0][1]).not.toContain('[SCHEDULE STATE]');
  });

  it('a cap-state read hiccup never skips the firing (block dropped, prompt intact)', async () => {
    mockScheduleFindUnique.mockResolvedValue({ enabled: true, kind: 'recurring', runsCount: 4, maxRuns: 32, expiresAt: null, intervalSec: 3600 });
    mockGet.mockRejectedValue(new Error('redis down'));
    const res = await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'p', origin: 'schedule' });
    expect(res).toEqual({ started: true });
    // capStateForSession degrades to nulls (never throws) — '?' renders.
    expect(mockStartScheduledRun.mock.calls[0][1]).toContain('daily ?/48');
  });
});

/* ====================================================================
 * v1#14 (b) — renewOnExhaustion.
 * ==================================================================== */
describe('v1#14b — renewOnExhaustion successor', () => {
  it('the FINAL firing of a machine-created recurring row arms a same-cadence successor BEFORE the (non-alarm) disable event', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 31, maxRuns: 32, promptSetBy: 'machine' })]);
    await fireDue();
    // Successor row: same chat/prompt/interval, promptSetBy system, idempotency key.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const { data } = mockCreate.mock.calls[0][0];
    expect(data).toMatchObject({
      sessionId: 's1', userId: 'u1', prompt: 'do the thing', kind: 'recurring',
      intervalSec: 3600, maxRuns: 32, promptSetBy: 'system', renewedFromId: 'sch_1', renewOnExhaustion: true,
    });
    expect(data.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(data.expiresAt.getTime() - Date.now()).toBeGreaterThan(MAX_LIFETIME_MS - 60_000);
    // schedule_disabled carries successorId (⇒ NOT alarm-class per isAlarmEvent).
    const disable = mockEmitHookEvent.mock.calls.find((c) => c[1] === 'schedule_disabled')!;
    expect(disable[3]).toMatchObject({ successorId: 'succ-1', reason: 'max_runs' });
    expect(disable[2]).toContain('successor schedule succ-1');
    // The stopped-schedule fast lane is moot with a successor armed.
    expect(mockQueueStoppedScheduleAlert).not.toHaveBeenCalled();
    // Lane revival: open decisions resolve, NAMING the successor (v1#12).
    expect(mockResolveStoppedForSession).toHaveBeenCalledWith('s1', 'succ-1');
    // Owner notice says the loop continues.
    expect(mockMsgCreate.mock.calls[0][0].data.content).toContain('successor schedule succ-1');
  });

  it('a USER-created recurring row does NOT renew by default (an explicit maxRuns is a deliberate stop)', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 31, maxRuns: 32, promptSetBy: 'user' })]);
    await fireDue();
    expect(mockCreate).not.toHaveBeenCalled();
    const disable = mockEmitHookEvent.mock.calls.find((c) => c[1] === 'schedule_disabled')!;
    expect(disable[3].successorId).toBeUndefined();
    expect(mockQueueStoppedScheduleAlert).toHaveBeenCalledWith('sch_1', 'max_runs');
  });

  it('row-level renewOnExhaustion=true overrides the user default; =false overrides the machine default', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 31, maxRuns: 32, promptSetBy: 'user', renewOnExhaustion: true })]);
    await fireDue();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    mockCreate.mockClear();
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 31, maxRuns: 32, promptSetBy: 'machine', renewOnExhaustion: false })]);
    await fireDue();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('the already-at-cap disable branch (deploy boundary / race) renews too; lifetime EXPIRY never renews', async () => {
    // Due row that arrives already at its run cap → the top disable branch.
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 32, maxRuns: 32 })]);
    await fireDue();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    // Expired-by-lifetime (not at run cap): no successor — sliding expiry means
    // only an abandoned lane reaches this.
    mockCreate.mockClear();
    mockFindMany.mockResolvedValue([dueRow({ expiresAt: new Date(Date.now() - 60_000) })]);
    await fireDue();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('IDEMPOTENT across the deploy boundary: an existing successor short-circuits; a P2002 race loser adopts the winner', async () => {
    // (a) read-check: successor already exists → no create, its id is reported.
    mockFindFirst.mockResolvedValue({ id: 'succ-existing' });
    await expect(maybeRenewOnExhaustion(dueRow({ runsCount: 32 }))).resolves.toBe('succ-existing');
    expect(mockCreate).not.toHaveBeenCalled();
    // (b) unique-index race: create P2002s → re-read reports the winner.
    mockFindFirst.mockReset()
      .mockResolvedValueOnce(null)            // pre-check: none yet
      .mockResolvedValueOnce({ id: 'succ-won' }); // post-race re-read
    mockCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(maybeRenewOnExhaustion(dueRow({ runsCount: 32 }))).resolves.toBe('succ-won');
  });

  it('the successor INHERITS the parent requiredProbes — a probe-gated lane keeps its gate across the maxRuns rollover', async () => {
    const probes = [{ tool: 'run_command', argPattern: 'deploy' }];
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 31, maxRuns: 32, promptSetBy: 'machine', requiredProbes: probes })]);
    await fireDue();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.requiredProbes).toEqual(probes);
  });

  it('a parent WITHOUT probes creates a successor without the field (Prisma nullable-Json: JS null is rejected at runtime)', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 31, maxRuns: 32, promptSetBy: 'machine', requiredProbes: null })]);
    await fireDue();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect('requiredProbes' in mockCreate.mock.calls[0][0].data).toBe(false);
  });

  it('one-shot rows never renew', async () => {
    await expect(maybeRenewOnExhaustion(dueRow({ kind: 'once', maxRuns: 1, runsCount: 1, promptSetBy: 'machine' }))).resolves.toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  /* ====================================================================
   * f24 (shortfall hunt 2026-10-14, firing 24) — renewal-first ordering.
   * The old order (disable write, THEN arm the successor) left a crash
   * window: a hard process death (routine blue-green deploy kill) between
   * the two writes stranded the lane PERMANENTLY deaf — the sweep only
   * reads enabled:true rows, and every backstop (disable event, terminal
   * notice, stopped-schedule alert) queued after the renewal inside the
   * same lost window. Both exhaustion sites now arm the successor BEFORE
   * the disable write; the DB-UNIQUE renewedFromId key makes a re-run
   * after a crash idempotent.
   * ==================================================================== */
  it('f24: the final-fire successor is armed BEFORE the disable write (renewal-first crash window closed)', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 31, maxRuns: 32, promptSetBy: 'machine' })]);
    await fireDue();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // The disable write on the fired-final path is the post-fire bump
    // (where enabled:true wins the fbe65673 race; data.enabled flips false
    // on the consumed final run). It is the ONLY updateMany whose data
    // carries lastStatus 'started'.
    const bumpIdx = mockUpdateMany.mock.calls.findIndex((c: any[]) => c[0]?.data?.lastStatus === 'started' && c[0]?.data?.enabled === false);
    expect(bumpIdx).toBeGreaterThanOrEqual(0);
    expect(mockCreate.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateMany.mock.invocationCallOrder[bumpIdx]);
  });

  it('f24: the already-at-cap disable branch arms the successor BEFORE its disable write', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 32, maxRuns: 32, promptSetBy: 'machine' })]);
    await fireDue();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const disableIdx = mockUpdate.mock.calls.findIndex((c: any[]) => c[0]?.data?.lastStatus === 'expired' && c[0]?.data?.enabled === false);
    expect(disableIdx).toBeGreaterThanOrEqual(0);
    expect(mockCreate.mock.invocationCallOrder[0]).toBeLessThan(mockUpdate.mock.invocationCallOrder[disableIdx]);
  });

  it('f24: the reorder makes the r.id !== s.id exclusion LOAD-BEARING — a pre-disable, still-under-cap exhausted row must not adopt ITSELF', async () => {
    // Fired-final call shape: renewal now runs BEFORE the bump, so the row
    // still reads runsCount 31 < 32 ("live") in the enabled-rows dupe scan.
    // Without the explicit self-exclusion it would find itself as a live
    // same-prompt row and adopt ITSELF as the successor (returning s.id,
    // creating nothing) — silently killing the renewal.
    const row = dueRow({ runsCount: 31, maxRuns: 32, promptSetBy: 'machine' });
    mockFindMany.mockResolvedValue([row]); // the dupe scan finds only the row itself
    await expect(maybeRenewOnExhaustion(row)).resolves.toBe('succ-1');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('f24: a mid-fire cancel that beats the post-fire bump tears down the FRESH successor and stays silent (no resurrection)', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 31, maxRuns: 32, promptSetBy: 'machine' })]);
    // The post-fire bump loses (count 0 ⇒ a cancel flipped enabled:false
    // first — the fbe65673 race); every other guarded write (claim, stamps)
    // still wins. The renewal above it ran BEFORE the cancel landed, so a
    // FRESH successor is now armed on top of a deliberately cancelled loop.
    mockUpdateMany.mockImplementation(async (args: any) => (args?.data?.lastStatus === 'started' ? { count: 0 } : { count: 1 }));
    await fireDue();
    expect(mockCreate).toHaveBeenCalledTimes(1); // successor armed pre-bump
    // Only a successor THIS fire minted (renewedFromId = the exhausted row)
    // is torn down — enabled:false + 'cancelled', never a delete (the
    // renewedFromId audit trail stays).
    const teardown = mockUpdateMany.mock.calls.find((c: any[]) => c[0]?.where?.renewedFromId === 'sch_1' && c[0]?.data?.lastStatus === 'cancelled');
    expect(teardown).toBeTruthy();
    expect(teardown![0].where).toMatchObject({ id: 'succ-1', enabled: true });
    // Cancel wins end-to-end: no max_runs terminal noise on a cancelled row
    // (the cancel path emits its own 'cancelled' disable event + notice).
    expect(mockEmitHookEvent.mock.calls.some((c) => c[1] === 'schedule_disabled')).toBe(false);
    expect(mockMsgCreate).not.toHaveBeenCalled();
    expect(mockQueueStoppedScheduleAlert).not.toHaveBeenCalled();
  });
});

/* ====================================================================
 * v1#16 — fireDue self-health.
 * ==================================================================== */
describe('v1#16 — sweep tick deadline', () => {
  afterEach(() => { jest.useRealTimers(); });

  it('a wedged tick is abandoned at the deadline: the sweeping latch resets and the next tick sweeps', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 120_000);
    mockFindMany.mockReturnValueOnce(new Promise(() => {})); // the due-rows read never resolves
    const wedged = fireDue();
    await jest.advanceTimersByTimeAsync(SWEEP_TICK_DEADLINE_MS + 1_000);
    await wedged; // resolved by the deadline, not the tick
    expect((logger.warn as jest.Mock).mock.calls.some((c) => String(c[0]).includes('exceeded its'))).toBe(true);
    // The latch is free again: a new tick actually runs its reads.
    mockFindMany.mockResolvedValue([]);
    const callsBefore = mockFindMany.mock.calls.length;
    await fireDue();
    expect(mockFindMany.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

/* ====================================================================
 * v1#33 — machine-run wall-clock deadline + busy-skip streak.
 * ==================================================================== */
describe('v1#33 — machine-run soft deadline (gate flip 2026-09-11: opt-in via RUN_DEADLINE_ENABLED=1)', () => {
  // The computation is pinned under the opt-in; the DEFAULT (no env) is
  // pinned separately below as "no deadline".
  beforeEach(() => { process.env.RUN_DEADLINE_ENABLED = '1'; });
  afterEach(() => { delete process.env.RUN_DEADLINE_ENABLED; });

  it('DEFAULT (RUN_DEADLINE_ENABLED unset) → null: machine runs carry NO soft wall-clock deadline and nothing is read', async () => {
    delete process.env.RUN_DEADLINE_ENABLED;
    mockFindMany.mockResolvedValue([{ intervalSec: 900 }]);
    await expect(computeMachineRunDeadlineMs('s1')).resolves.toBeNull();
    expect(mockFindMany).not.toHaveBeenCalled();
    process.env.RUN_DEADLINE_ENABLED = '0'; // anything but '1' is off
    await expect(computeMachineRunDeadlineMs('s1')).resolves.toBeNull();
    // The retired kill-switch alone does not re-arm anything.
    process.env.RUN_DEADLINE_DISABLED = '1';
    try {
      await expect(computeMachineRunDeadlineMs('s1')).resolves.toBeNull();
    } finally {
      delete process.env.RUN_DEADLINE_DISABLED;
    }
  });

  it('opt-in: deadline = max(20 min, 0.8 × the shortest ENABLED RECURRING interval)', async () => {
    mockFindMany.mockResolvedValue([{ intervalSec: 3600 }, { intervalSec: 1800 }]);
    await expect(computeMachineRunDeadlineMs('s1')).resolves.toBe(Math.round(0.8 * 1800 * 1000)); // 24 min
    mockFindMany.mockResolvedValue([{ intervalSec: 900 }]); // 0.8×15min = 12min < floor
    await expect(computeMachineRunDeadlineMs('s1')).resolves.toBe(MACHINE_RUN_DEADLINE_FLOOR_MS);
    mockFindMany.mockResolvedValue([]); // no recurring cadence → the floor
    await expect(computeMachineRunDeadlineMs('s1')).resolves.toBe(MACHINE_RUN_DEADLINE_FLOOR_MS);
  });

  it('opt-in: a read failure degrades to the floor (uncertainty must not return an unbounded run)', async () => {
    mockFindMany.mockRejectedValue(new Error('db down'));
    await expect(computeMachineRunDeadlineMs('s1')).resolves.toBe(MACHINE_RUN_DEADLINE_FLOOR_MS);
  });
});

describe('v1#33b — re-claim deadline anchor (2026-09-09 watcher jam)', () => {
  it('a fresh claim keeps the full budget (startedAt ≈ now, or null)', () => {
    const now = Date.now();
    expect(remainingRunDeadlineMs(24 * 60_000, new Date(now), now)).toBe(24 * 60_000);
    expect(remainingRunDeadlineMs(24 * 60_000, null, now)).toBe(24 * 60_000);
  });

  it('a re-claim inherits the elapsed clock: 10 of 24 minutes gone → 14 remain', () => {
    const now = Date.now();
    expect(remainingRunDeadlineMs(24 * 60_000, new Date(now - 10 * 60_000), now)).toBe(14 * 60_000);
  });

  it('past-budget re-claims get the 3-min grace floor, never zero (the 90-min watcher shape)', () => {
    const now = Date.now();
    expect(remainingRunDeadlineMs(24 * 60_000, new Date(now - 90 * 60_000), now)).toBe(RECLAIM_DEADLINE_GRACE_MS);
  });

  it('a future startedAt (clock skew) never inflates the budget', () => {
    const now = Date.now();
    expect(remainingRunDeadlineMs(24 * 60_000, new Date(now + 5 * 60_000), now)).toBe(24 * 60_000);
  });
});

/* Gate flip 2026-09-11 (owner: full steam): a busy-skip crossing LOGS one
 * line naming the blocker instead of waking the Fleet Supervisor — opt-in
 * BUSY_SKIP_ALARM_HOOK=1 restores the attention_needed hook, and only from
 * the ≥10 crossing. */
const busyAlarms = (): string[] => [...(logger.info as jest.Mock).mock.calls, ...(logger.warn as jest.Mock).mock.calls]
  .map((c) => String(c[0]))
  .filter((line) => line.includes('consecutive busy-skips'));
const attentionHooks = () => mockEmitHookEvent.mock.calls.filter((c) => c[1] === 'attention_needed');

describe('v1#33 — persisted busy-skip streak + observe-only alarm at 3', () => {
  beforeEach(() => { delete process.env.BUSY_SKIP_ALARM_HOOK; });
  afterEach(() => { delete process.env.BUSY_SKIP_ALARM_HOOK; });

  it('a busy skip increments busySkips; the THIRD consecutive skip logs ONE alarm line naming the blocking run — and NO attention_needed hook', async () => {
    mockFindMany.mockResolvedValue([dueRow()]);
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
    mockUpdate.mockResolvedValue({ busySkips: 3 });
    mockRunFindFirst.mockResolvedValue({ id: 'run-blk', status: 'running', startedAt: new Date('2026-09-08T01:00:00Z') });
    await fireDue();
    const skipWrite = mockUpdate.mock.calls.find((c) => c[0]?.data?.lastStatus === 'skipped:busy')!;
    expect(skipWrite[0].data.busySkips).toEqual({ increment: 1 });
    expect(attentionHooks()).toHaveLength(0);
    expect(busyAlarms()).toHaveLength(1);
    expect(busyAlarms()[0]).toContain('sch_1 hit 3 consecutive busy-skips');
    expect(busyAlarms()[0]).toContain('run run-blk');
    // The congestion telemetry the zombie watchdog consumes still flows.
    expect(mockRecordLoopMetric.mock.calls.some((c) => c[0]?.kind === 'schedule_busy_skip')).toBe(true);
  });

  it('opt-in BUSY_SKIP_ALARM_HOOK=1: the 3-crossing still only logs (below the ≥10 hook floor); the 10-crossing emits the attention_needed hook', async () => {
    process.env.BUSY_SKIP_ALARM_HOOK = '1';
    mockFindMany.mockResolvedValue([dueRow()]);
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
    mockUpdate.mockResolvedValue({ busySkips: 3 });
    mockRunFindFirst.mockResolvedValue({ id: 'run-blk', status: 'running', startedAt: new Date('2026-09-08T01:00:00Z') });
    await fireDue();
    expect(attentionHooks()).toHaveLength(0);
    expect(busyAlarms()).toHaveLength(1);
    mockUpdate.mockResolvedValue({ busySkips: 10 });
    await fireDue();
    expect(attentionHooks()).toHaveLength(1);
    const alarm = attentionHooks()[0];
    expect(alarm[2]).toContain('run run-blk');
    expect(alarm[3]).toMatchObject({ scheduleId: 'sch_1', runId: 'run-blk', busySkips: 10 });
  });

  it('skips 4+ do NOT re-alarm (once per crossing); a real start RESETS the streak', async () => {
    mockFindMany.mockResolvedValue([dueRow()]);
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
    mockUpdate.mockResolvedValue({ busySkips: 4 });
    await fireDue();
    expect(attentionHooks()).toHaveLength(0);
    expect(busyAlarms()).toHaveLength(0);
    // A started run clears the counter in the same bump that stamps lastFiredAt (P3 pin 14a).
    mockStartScheduledRun.mockResolvedValue({ started: true });
    await fireDue();
    const bump = mockUpdateMany.mock.calls.find((c) => c[0]?.data?.lastStatus === 'started')!;
    expect(bump[0].data.busySkips).toBe(0);
    expect(bump[0].data.lastFiredAt).toBeInstanceOf(Date);
  });

  // dae56e70 (2026-09-10): the 0afa0737 phantom-busy incident — agent_runs was
  // EMPTY while the ready-gate rejected every start for 8h because the
  // session row was 'archived'; the old fallback label blamed "a run outside
  // agent_runs" and sent investigators chasing a phantom Redis claim.
  it('dae56e70: no blocking run + session row ARCHIVED → the logged blocking label names the stuck row status, not a phantom cross-process claim', async () => {
    mockFindMany.mockResolvedValue([dueRow()]);
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
    mockUpdate.mockResolvedValue({ busySkips: 3 });
    mockRunFindFirst.mockResolvedValue(null); // agent_runs empty — the incident shape
    mockCodingStateFindUnique.mockResolvedValue({ status: 'archived' });
    await fireDue();
    const blocking = busyAlarms()[0];
    expect(blocking).toContain("'archived'");
    expect(blocking).not.toContain('outside agent_runs');
  });

  it('dae56e70: no blocking run + runnable-looking row (ready) → the cross-process fallback label is kept', async () => {
    mockFindMany.mockResolvedValue([dueRow()]);
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
    mockUpdate.mockResolvedValue({ busySkips: 3 });
    mockRunFindFirst.mockResolvedValue(null);
    mockCodingStateFindUnique.mockResolvedValue({ status: 'ready' });
    await fireDue();
    expect(busyAlarms()[0]).toContain('outside agent_runs');
  });

  it('dae56e70: no blocking run + NO coding-state row (plain-chat lane) → the cross-process fallback label is kept', async () => {
    mockFindMany.mockResolvedValue([dueRow()]);
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
    mockUpdate.mockResolvedValue({ busySkips: 3 });
    mockRunFindFirst.mockResolvedValue(null);
    mockCodingStateFindUnique.mockResolvedValue(null); // plain chat — no satellite row
    await fireDue();
    expect(busyAlarms()[0]).toContain('outside agent_runs');
  });
});

/* ====================================================================
 * Busy-skip alarm ESCALATION (build/busyskip-escalation): the strict ===3
 * alarm fired once per streak and never again — one prod lane reached 75
 * skips in silence. Crossings at 3, 10, then every 25, derived from the
 * persisted count alone so a swallowed update can never skip a level.
 * ==================================================================== */
describe('busy-skip alarm escalation — crossings at 3, 10, then every 25', () => {
  it('busySkipAlarmLevel: sequential increments cross at exactly {3, 10, 25, 50, 75, 100} — never twice, never skipping a level', () => {
    const crossings: number[] = [];
    for (let n = 1; n <= 110; n++) {
      if (busySkipAlarmLevel(n) > busySkipAlarmLevel(n - 1)) crossings.push(n);
    }
    expect(crossings).toEqual([3, 10, 25, 50, 75, 100]);
  });

  it('the 10-crossing logs a line by default; with BUSY_SKIP_ALARM_HOOK=1 the hook tells the reader HOW to find the blocker: the sessionId + the cm:liverun lock', async () => {
    mockFindMany.mockResolvedValue([dueRow()]);
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
    mockUpdate.mockResolvedValue({ busySkips: 10 });
    await fireDue();
    expect(attentionHooks()).toHaveLength(0);
    expect(busyAlarms()[0]).toContain('sch_1 hit 10 consecutive busy-skips');
    process.env.BUSY_SKIP_ALARM_HOOK = '1';
    try {
      await fireDue();
      const alarm = attentionHooks()[0];
      expect(alarm[2]).toContain('10 consecutive firings');
      expect(alarm[2]).toContain('session s1');
      expect(alarm[2]).toContain('cm:liverun:s1');
      expect(alarm[3]).toMatchObject({ scheduleId: 'sch_1', sessionId: 's1', busySkips: 10 });
    } finally {
      delete process.env.BUSY_SKIP_ALARM_HOOK;
    }
  });

  it('re-alarms at every 25-multiple crossing (the 75-skip silent lane) — but never between crossings', async () => {
    mockFindMany.mockResolvedValue([dueRow()]);
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
    mockUpdate.mockResolvedValue({ busySkips: 75 });
    await fireDue();
    expect(busyAlarms()).toHaveLength(1);
    expect(attentionHooks()).toHaveLength(0);
    (logger.info as jest.Mock).mockClear();
    (logger.warn as jest.Mock).mockClear();
    mockUpdate.mockResolvedValue({ busySkips: 76 });
    await fireDue();
    expect(busyAlarms()).toHaveLength(0);
  });

  it('a swallowed skip-write (update → null) never raises an alarm and never throws — the next landed increment carries the crossing', async () => {
    mockFindMany.mockResolvedValue([dueRow()]);
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
    mockUpdate.mockRejectedValue(new Error('db blip'));
    await fireDue();
    expect(busyAlarms()).toHaveLength(0);
    expect(attentionHooks()).toHaveLength(0);
  });

  it('busySkips is surfaced on getScheduleHealth items (lane/UI visibility)', async () => {
    mockFindMany.mockResolvedValue([dueRow({ busySkips: 7, lastStatus: 'skipped:busy' })]);
    mockCount.mockResolvedValue(0);
    const health = await getScheduleHealth('s1');
    expect(health.items[0]).toMatchObject({ id: 'sch_1', busySkips: 7, lastStatus: 'skipped:busy' });
  });
});

/* ====================================================================
 * CanLaw L8 / spark B14 — continuation checks at QUEUE time.
 * ==================================================================== */
describe('L8/B14 — continuation obsolete + recurring-owner checks', () => {
  const CONT = '[HARNESS CONTINUATION r1/6] resume';

  it('an enabled RECURRING schedule owning the lane skips the continuation (reason recurring_lane, nothing queued)', async () => {
    mockCount.mockResolvedValue(1); // one enabled recurring row on the session
    const r = await queueContinuationRun({ sessionId: 's1', userId: 'u1', prompt: CONT });
    expect(r).toEqual({ ok: false, reason: 'recurring_lane' });
    expect(mockRunCreate).not.toHaveBeenCalled();
    expect(mockCount).toHaveBeenCalledWith({ where: { sessionId: 's1', enabled: true, kind: 'recurring' } });
  });

  it('a completed plan board at queue time skips as obsolete (the slow lane check, applied to the fast lane)', async () => {
    mockGetPlanStrict.mockResolvedValue({ steps: [{ status: 'completed' }] });
    const r = await queueContinuationRun({ sessionId: 's1', userId: 'u1', prompt: CONT });
    expect(r).toEqual({ ok: false, reason: 'obsolete' });
    expect(mockRunCreate).not.toHaveBeenCalled();
  });

  it('2026-09-29: a provider-limit RESUME (resume:true) is queued on a plan-less / completed board — the obsolete check is skipped', async () => {
    mockGetPlanStrict.mockResolvedValue(null);
    const r = await queueContinuationRun({ sessionId: 's1', userId: 'u1', prompt: '[HARNESS CONTINUATION r1/6] [RESUME AFTER PROVIDER LIMIT] carry on', resume: true });
    expect(r.ok).toBe(true);
    expect(mockRunCreate).toHaveBeenCalledTimes(1);
  });

  it('a plan-read ERROR never skips — uncertainty must not drop a resumption', async () => {
    mockGetPlanStrict.mockRejectedValue(new Error('store timeout'));
    const r = await queueContinuationRun({ sessionId: 's1', userId: 'u1', prompt: CONT });
    expect(r.ok).toBe(true);
    expect(mockRunCreate).toHaveBeenCalledTimes(1);
  });
});

/* ====================================================================
 * CanLaw B1 — update_schedule refuses disabled/terminal rows honestly.
 * ==================================================================== */
describe('B1 — updateScheduleForUser refuses disabled rows', () => {
  it('a disabled row refuses with an honest envelope (nothing updated) and names the state + the fix', async () => {
    mockFindFirst.mockResolvedValue({ id: 'sch_dead', userId: 'u1', sessionId: 's1', enabled: false, lastStatus: 'cancelled' });
    const r = await updateScheduleForUser('u1', 'sch_dead', { prompt: 'new prompt' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('DISABLED');
    expect(r.error).toContain('cancelled');
    expect(r.error).toContain('Nothing was updated');
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

/* ====================================================================
 * P3 batch pin 14b — the daily-cap counter re-ensures its TTL.
 * ==================================================================== */
describe('P3 pin 14b — cap-counter TTL re-ensure', () => {
  it('a counter that lost its TTL (PTTL -1) gets it re-set on the NEXT increment — no immortal cap', async () => {
    mockIncr.mockResolvedValue(5); // not the first increment
    mockPTtl.mockResolvedValue(-1); // key exists WITHOUT a TTL
    await dailyCapExceeded('s1');
    expect(mockExpire).toHaveBeenCalledWith('coding:sched:fires:s1', 24 * 60 * 60);
  });

  it('a healthy counter (live TTL) is not re-expired', async () => {
    mockIncr.mockResolvedValue(5);
    mockPTtl.mockResolvedValue(3_600_000);
    await dailyCapExceeded('s1');
    expect(mockExpire).not.toHaveBeenCalled();
  });
});

/* ====================================================================
 * CanLaw B8 — cap-skip notices reach PLAIN-CHAT lanes too.
 * ==================================================================== */
describe('B8 — plain-chat cap-skip notice', () => {
  beforeEach(() => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'thinking', codingState: null, parentChatId: null });
  });

  it('a plain-chat firing consumes the pending skip count and rides it into the wake prompt', async () => {
    mockGetDel.mockResolvedValue('4'); // 4 skipped firings recorded
    mockStartDetachedChatRun.mockReturnValue('chat:s1' as any);
    const res = await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'check the feeds', origin: 'schedule' });
    expect(res).toEqual({ started: true });
    const args = mockStartDetachedChatRun.mock.calls[0][0];
    expect(args.message).toContain('check the feeds');
    expect(args.message).toContain('[SCHEDULER NOTICE] 4 scheduled firing(s) were skipped');
    expect(mockIncrBy).not.toHaveBeenCalled(); // started — nothing to restore
  });

  it('a busy plain chat RESTORES the consumed count (the self-healing signal is not lost)', async () => {
    mockGetDel.mockResolvedValue('2');
    mockStartDetachedChatRun.mockReturnValue(null as any); // busy
    const res = await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'p', origin: 'schedule' });
    expect(res).toEqual({ started: false, reason: 'busy' });
    expect(mockIncrBy).toHaveBeenCalledWith('coding:sched:skipnotice:s1', 2);
  });

  it('no pending skips → no notice appended', async () => {
    mockGetDel.mockResolvedValue(null);
    mockStartDetachedChatRun.mockReturnValue('chat:s1' as any);
    await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'p', origin: 'schedule' });
    expect(mockStartDetachedChatRun.mock.calls[0][0].message).not.toContain('[SCHEDULER NOTICE]');
  });
});

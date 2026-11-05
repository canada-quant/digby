/**
 * Ticket b4d1096c pin — schedule_near_cap pre-emptive renewal alerting.
 *
 * Before this fix a recurring schedule died SILENTLY at its run cap: the only
 * signal was the POST-death schedule_disabled hook (or the next fleet sweep),
 * so CanLaw's coordinator watch (482/500) and the Path C integrator watch
 * (86/200) went deaf with no warning. The sweeper now emits ONE
 * schedule_near_cap hook event per row when it crosses ≥90% of maxRuns or
 * enters the last 10% of its lifetime window, deduped by the atomic
 * nearCapAlertedAt stamp (repeat processings, busy re-arms and racing
 * blue/green sweepers can never double-emit).
 *
 * Harness mirrors schedule.remediation-p3.test.ts (colocated mock-everything).
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

// platform.validation imports middleware/agent-auth → utils/jwt → config/env,
// which process.exit(1)s the jest worker at import time — mock it (same pin
// the ci_failed REST-enum test uses).
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));

const mockGetPlanStrict = jest.fn(async (..._args: any[]) => null as any);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: (...a: any[]) => mockGetPlanStrict(...a),
}));

import {
  fireDue,
  nearCapRunThreshold, scheduleNearCapCause,
  NEAR_EXPIRY_WINDOW_MS,
} from './schedule.service';
import { platformSubscribeHookSchema } from '../platform/platform.validation';

/** A due recurring row (the sweeper's view) — nearCapAlertedAt NULL (never alerted). */
const dueRow = (over: any = {}) => ({
  id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'do the thing', kind: 'recurring',
  intervalSec: 3600, nextRunAt: new Date(Date.now() - 1000), enabled: true,
  runsCount: 3, maxRuns: 32, expiresAt: new Date(Date.now() + 20 * 86_400_000),
  lastFiredAt: null, lastStatus: null, promptSetBy: 'machine', renewOnExhaustion: null,
  busySkips: 0, nearCapAlertedAt: null, createdAt: new Date(),
  ...over,
});

const nearCapCalls = () => mockEmitHookEvent.mock.calls.filter((c) => c[1] === 'schedule_near_cap');
/** The stamp write is the ONLY updateMany whose where guards on nearCapAlertedAt. */
const stampCalls = () => mockUpdateMany.mock.calls.filter((c) => c[0]?.where?.nearCapAlertedAt === null);

beforeEach(() => {
  jest.clearAllMocks();
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
 * The pure predicate — single semantics shared by sweeper + surfaces.
 * ==================================================================== */
describe('b4d1096c — nearCapRunThreshold / scheduleNearCapCause', () => {
  it('thresholds: 500→450 (the CanLaw field workaround), 200→180, 10→9', () => {
    expect(nearCapRunThreshold(500)).toBe(450);
    expect(nearCapRunThreshold(200)).toBe(180);
    expect(nearCapRunThreshold(10)).toBe(9);
  });

  it('tiny caps get NO threshold — the final-run disable+renewal IS the signal', () => {
    expect(nearCapRunThreshold(9)).toBeNull();
    expect(nearCapRunThreshold(2)).toBeNull();
    expect(nearCapRunThreshold(1)).toBeNull();
    expect(nearCapRunThreshold(null)).toBeNull();
    expect(nearCapRunThreshold(undefined)).toBeNull();
  });

  it('run_cap trips at ≥threshold and below the cap; not below threshold, not AT the cap', () => {
    const now = new Date();
    const far = new Date(now.getTime() + 20 * 86_400_000);
    expect(scheduleNearCapCause({ kind: 'recurring', runsCount: 450, maxRuns: 500, expiresAt: far }, now)).toBe('run_cap');
    expect(scheduleNearCapCause({ kind: 'recurring', runsCount: 499, maxRuns: 500, expiresAt: far }, now)).toBe('run_cap');
    expect(scheduleNearCapCause({ kind: 'recurring', runsCount: 449, maxRuns: 500, expiresAt: far }, now)).toBeNull();
    // AT the cap → the max_runs disable branch owns it, never the warning.
    expect(scheduleNearCapCause({ kind: 'recurring', runsCount: 500, maxRuns: 500, expiresAt: far }, now)).toBeNull();
  });

  it('expiry_window trips inside the last 10% of the lifetime (uncapped rows too); never for kind once', () => {
    const now = new Date();
    expect(scheduleNearCapCause({ kind: 'recurring', runsCount: 0, maxRuns: null, expiresAt: new Date(now.getTime() + NEAR_EXPIRY_WINDOW_MS - 60_000) }, now)).toBe('expiry_window');
    expect(scheduleNearCapCause({ kind: 'recurring', runsCount: 0, maxRuns: null, expiresAt: new Date(now.getTime() + NEAR_EXPIRY_WINDOW_MS + 60_000) }, now)).toBeNull();
    // A past expiry is the disable branch's job, not the warning's.
    expect(scheduleNearCapCause({ kind: 'recurring', runsCount: 0, maxRuns: null, expiresAt: new Date(now.getTime() - 1000) }, now)).toBeNull();
    // once rows never warn (their single run IS the lifecycle).
    expect(scheduleNearCapCause({ kind: 'once', runsCount: 0, maxRuns: 1, expiresAt: new Date(now.getTime() + 60_000) }, now)).toBeNull();
    // run_cap wins when both legs trip (the fraction is the actionable number).
    expect(scheduleNearCapCause({ kind: 'recurring', runsCount: 460, maxRuns: 500, expiresAt: new Date(now.getTime() + 60_000) }, now)).toBe('run_cap');
  });
});

/* ====================================================================
 * Sweeper emission through fireDue.
 * ==================================================================== */
describe('b4d1096c — sweeper schedule_near_cap emission', () => {
  it('a recurring row at 450/500 alerts ONCE with the run_cap payload and STILL fires normally', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 450, maxRuns: 500, promptSetBy: 'machine' })]);
    await fireDue();
    expect(nearCapCalls()).toHaveLength(1);
    const [sourceChatId, , summary, extra] = nearCapCalls()[0];
    expect(sourceChatId).toBe('s1');
    expect(summary).toContain('450/500');
    expect(summary).toContain('NEAR its run cap');
    expect(extra).toMatchObject({
      scheduleId: 'sch_1', sessionId: 's1', kind: 'recurring', cause: 'run_cap',
      runsCount: 450, maxRuns: 500, willAutoRenew: true, // machine row → renewOnExhaustion derived ON
    });
    // The atomic stamp claimed the alert BEFORE the firing proceeded…
    expect(stampCalls()).toHaveLength(1);
    expect(stampCalls()[0][0].where).toMatchObject({ id: 'sch_1', nearCapAlertedAt: null });
    expect(stampCalls()[0][0].data.nearCapAlertedAt).toBeInstanceOf(Date);
    // …and the firing itself was never broken by the alert.
    expect(mockStartScheduledRun).toHaveBeenCalled();
  });

  it('a USER-authored row at 180/200 alerts with willAutoRenew FALSE (deliberate stop — the deaf-lane class)', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 180, maxRuns: 200, promptSetBy: 'user' })]);
    await fireDue();
    expect(nearCapCalls()).toHaveLength(1);
    const [, , summary, extra] = nearCapCalls()[0];
    expect(extra).toMatchObject({ cause: 'run_cap', runsCount: 180, maxRuns: 200, willAutoRenew: false });
    expect(summary).toContain('goes SILENT at the cap unless a replacement is armed');
  });

  it('dedupe: an already-stamped row (nearCapAlertedAt set) never re-alerts and is not re-stamped', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 460, maxRuns: 500, nearCapAlertedAt: new Date(Date.now() - 86_400_000) })]);
    await fireDue();
    expect(nearCapCalls()).toHaveLength(0);
    expect(stampCalls()).toHaveLength(0);
    expect(mockStartScheduledRun).toHaveBeenCalled(); // the fire itself is untouched
  });

  it('race loser: a lost stamp claim (count 0 — the peer sweeper won) suppresses the emission, never the fire', async () => {
    mockUpdateMany.mockImplementation((args: any) => Promise.resolve(args?.where?.nearCapAlertedAt === null ? { count: 0 } : { count: 1 }));
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 450, maxRuns: 500 })]);
    await fireDue();
    expect(stampCalls()).toHaveLength(1); // it TRIED to claim…
    expect(nearCapCalls()).toHaveLength(0); // …lost, so no duplicate alert
    expect(mockStartScheduledRun).toHaveBeenCalled();
  });

  it('below threshold (449/500) no alert and no stamp write at all', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 449, maxRuns: 500 })]);
    await fireDue();
    expect(nearCapCalls()).toHaveLength(0);
    expect(stampCalls()).toHaveLength(0);
  });

  it('an AT-CAP row (500/500) takes the max_runs disable path — schedule_disabled, never schedule_near_cap', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 500, maxRuns: 500 })]);
    await fireDue();
    expect(nearCapCalls()).toHaveLength(0);
    expect(stampCalls()).toHaveLength(0);
    const disable = mockEmitHookEvent.mock.calls.find((c) => c[1] === 'schedule_disabled')!;
    expect(disable).toBeTruthy();
    expect(disable[3]).toMatchObject({ reason: 'max_runs' });
  });

  it('expiry leg: an uncapped recurring row <3 days from its lifetime expiry alerts with cause expiry_window', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 2, maxRuns: null, expiresAt: new Date(Date.now() + 2 * 86_400_000) })]);
    await fireDue();
    expect(nearCapCalls()).toHaveLength(1);
    const [, , summary, extra] = nearCapCalls()[0];
    expect(extra).toMatchObject({ scheduleId: 'sch_1', cause: 'expiry_window', maxRuns: null });
    expect(summary).toContain('NEAR its lifetime expiry');
    expect(mockStartScheduledRun).toHaveBeenCalled(); // the firing slides expiry; the alert still fired first
  });

  it('a once-kind row never alerts (its single run is the lifecycle)', async () => {
    mockFindMany.mockResolvedValue([dueRow({ kind: 'once', runsCount: 0, maxRuns: 1, intervalSec: null })]);
    await fireDue();
    expect(nearCapCalls()).toHaveLength(0);
    expect(stampCalls()).toHaveLength(0);
  });

  it('emission failure never breaks the firing (best-effort seam)', async () => {
    mockEmitHookEvent.mockRejectedValueOnce(new Error('outbox down'));
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 450, maxRuns: 500 })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalled();
  });

  it('the deploy catch-up: a row ALREADY past threshold on first post-deploy processing alerts once', async () => {
    // 482/500 — the CanLaw coordinator watch's exact deaf state, now seen pre-death.
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 482, maxRuns: 500, promptSetBy: 'user' })]);
    await fireDue();
    expect(nearCapCalls()).toHaveLength(1);
    expect(nearCapCalls()[0][3]).toMatchObject({ cause: 'run_cap', runsCount: 482, maxRuns: 500, willAutoRenew: false });
  });
});

describe('b4d1096c — REST enum (review N1 fold-in)', () => {
  it('the REST subscribe schema accepts schedule_near_cap (and still rejects unknown types)', () => {
    const base = { sourceChatId: '11111111-1111-4111-8111-111111111111', targetChatId: '22222222-2222-4222-8222-222222222222' };
    expect(platformSubscribeHookSchema.safeParse({ body: { ...base, eventTypes: ['schedule_near_cap'] } }).success).toBe(true);
    expect(platformSubscribeHookSchema.safeParse({ body: { ...base, eventTypes: ['schedule_near_capish'] } }).success).toBe(false);
  });
});

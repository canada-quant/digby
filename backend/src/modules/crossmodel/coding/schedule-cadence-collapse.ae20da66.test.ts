/**
 * REPLAY TEST — ticket ae20da66 (bug_report, 2026-09-21): "Deploy restart mid
 * schedule-renewal leaves duplicate recurring sweeps on one chat".
 *
 * THE MISHAP (Fleet Supervisor wake, chat c0e22e36): the 13:49Z sweep run
 * renewed its 120m recurring sweep the agent way — TWO separate tool calls:
 * create-new (b8cee3ad, new prompt) then cancel-old (a2d5c506). Deploy run
 * 35611293899 SIGTERM-killed the run BETWEEN the calls (~15:00Z). The create
 * had landed; the cancel never ran. The store had NO same-cadence uniqueness:
 * the 1ead3b52 duplicate guard only adopts an IDENTICAL normalized prompt (the
 * renewal's prompt had changed), and the 5ba5f03e deploy resume brief only
 * bars REPEATING executed calls — nothing re-ran the stranded cancel. Net:
 * two enabled 120m recurring sweeps on one chat, double-burning its daily cap,
 * until the supervisor hand-cancelled at 15:25:16Z.
 *
 * THE FIX — same-cadence collapse, atomic with the create (createSchedule):
 * a MACHINE recurring arm SUPERSEDES every other enabled machine/system
 * recurring row on the session at the SAME interval, in the SAME Prisma
 * transaction as the create (create-new IS cancel-old, deploy-safe at any
 * interrupt point). Each superseded row emits schedule_disabled with
 * successorId = the new row (non-alarm per hooks.service.isAlarmEvent, "lane
 * is NOT deaf" note). Owner-armed ('user') and legacy NULL-promptSetBy rows
 * are NEVER collapsed — explicit instruction is never second-guessed.
 *
 * Harness mirrors schedule-renew-exhaustion.eb710676.test.ts (colocated
 * mock-everything), plus $transaction (the create+collapse atomic unit).
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
const mockChatFindUnique = jest.fn();
const mockChatUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockMsgCreate = jest.fn(async (..._a: any[]) => ({}));
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-cont-1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockCodingStateFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockCodingStateFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);

// The create+collapse atomic unit: the tx exposes the same chatSchedule seam
// (the collapse re-reads INSIDE the transaction — ticket ae20da66).
const mockTransaction = jest.fn(async (fn: any) =>
  typeof fn === 'function'
    ? fn({
        chatSchedule: {
          create: (...a: any[]) => mockCreate(...a),
          findMany: (...a: any[]) => mockFindMany(...a),
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
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), update: (...a: any[]) => mockChatUpdate(...a) },
    crossModelMessage: { create: (...a: any[]) => mockMsgCreate(...a) },
    chatCodingState: {
      findUnique: (...a: any[]) => mockCodingStateFindUnique(...a),
      findMany: (...a: any[]) => mockCodingStateFindMany(...a),
    },
    $transaction: (fn: any) => mockTransaction(fn),
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
    set: (...a: any[]) => mockSet(...a), del: jest.fn(async () => 1),
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

jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: jest.fn((..._a: any[]) => {}),
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

const mockEvaluateScheduleDormancy = jest.fn(async (..._a: any[]): Promise<any> => ({
  dormant: false, projectId: 'p1', reason: 'test: project has live work',
  signals: { activeGoals: 1, openTodos: 0, liveRuns: 0, watchedResources: 0 },
}));
jest.mock('./dormancy-gate.service', () => ({
  __esModule: true,
  DORMANT_LAST_STATUS: 'parked:dormant',
  evaluateScheduleDormancy: (...a: any[]) => mockEvaluateScheduleDormancy(...a),
}));

import { createSchedule, MIN_INTERVAL_SEC } from './schedule.service';

/** An enabled, still-live recurring row as the dedup guard's read sees it. */
const liveRecurring = (over: any = {}) => ({
  id: 'sch_old', sessionId: 's1', userId: 'u1',
  prompt: 'sweep the goal ledger (OLD prompt revision)',
  kind: 'recurring', intervalSec: 7200, nextRunAt: new Date(Date.now() + 7200_000),
  enabled: true, runsCount: 1, maxRuns: 500,
  expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  lastFiredAt: new Date(), lastStatus: 'started', cancelledBy: null, disabledAt: null,
  promptSetBy: 'machine', busySkips: 0, createdAt: new Date(),
  ...over,
});

/** findMany serves TWO reads: the dedup guard's (kind+enabled) and the
 *  collapse's in-transaction stale read (adds intervalSec + promptSetBy). */
let dedupRows: any[] = [];
let staleRows: any[] = [];
const isStaleQuery = (args: any) => args?.where?.intervalSec != null && args?.where?.promptSetBy != null;

const NEW_PROMPT = 'sweep the goal ledger (CURRENT prompt revision — the renewal)';

beforeEach(() => {
  jest.clearAllMocks();
  dedupRows = [];
  staleRows = [];
  mockFindMany.mockImplementation((args: any) => Promise.resolve(isStaleQuery(args) ? staleRows : dedupRows));
  mockFindFirst.mockResolvedValue(null);
  // 1 enabled row: under the MAX_ACTIVE_PER_SESSION cap on the pre-create
  // check, and remainingEnabled=1 on the post-collapse emit (no DEAF suffix).
  mockCount.mockResolvedValue(1);
  mockUpdate.mockResolvedValue({});
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockDeleteMany.mockResolvedValue({ count: 0 });
  mockScheduleFindUnique.mockResolvedValue({ enabled: true });
  mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' }, parentChatId: null });
  mockGetChatAutonomy.mockResolvedValue(null);
  mockIncr.mockResolvedValue(1);
  mockIncrBy.mockResolvedValue(1);
  mockGet.mockResolvedValue(null);
  mockGetDel.mockResolvedValue(null);
  mockPTtl.mockResolvedValue(-2);
  mockCreate.mockImplementation(({ data }: any) => Promise.resolve({
    id: 'sch_new', ...data, lastFiredAt: null, lastStatus: null, runsCount: 0,
  }));
  mockEvaluateScheduleDormancy.mockResolvedValue({
    dormant: false, projectId: 'p1', reason: 'test: project has live work',
    signals: { activeGoals: 1, openTodos: 0, liveRuns: 0, watchedResources: 0 },
  });
});

const arm = (over: any = {}) => ({
  sessionId: 's1', userId: 'u1',
  prompt: NEW_PROMPT,
  kind: 'recurring' as const, intervalSec: 7200, promptSetBy: 'machine',
  ...over,
});

describe('ticket ae20da66 — same-cadence collapse (atomic renewal)', () => {
  it('REPLAYS THE MISHAP: a machine recurring re-arm at the same cadence ATOMICALLY cancels the old row the deploy stranded', async () => {
    // Pre-fix state: the create had landed, the cancel never ran — both rows
    // enabled. Post-fix the stranded row is collapsed INSIDE the create's tx.
    dedupRows = [liveRecurring()];            // old prompt — no 1ead3b52 dedup
    staleRows = [{ id: 'sch_old', runsCount: 1 }];
    const r = await createSchedule(arm());
    expect(r.ok).toBe(true);
    expect(r.deduped).toBeUndefined();        // different prompt → no adoption
    expect(r.schedule?.id).toBe('sch_new');
    expect(r.superseded).toEqual(['sch_old']);
    // ONE transaction carried create + collapse (the atomicity the mishap lacked).
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['sch_old'] } },
      data: { enabled: false, lastStatus: 'cancelled', cancelledBy: 'machine', disabledAt: expect.any(Date) },
    });
    // The stale read ran INSIDE the transaction, scoped to session + cadence +
    // machine/system authorship (never the just-created row).
    const staleCall = mockFindMany.mock.calls.find((c) => isStaleQuery(c[0]))!;
    expect(staleCall[0]).toMatchObject({
      where: {
        sessionId: 's1', kind: 'recurring', enabled: true,
        intervalSec: 7200, id: { not: 'sch_new' },
        promptSetBy: { in: ['machine', 'system'] },
      },
      select: { id: true, runsCount: true },
    });
    // schedule_disabled carries successorId ⇒ non-alarm class, "NOT deaf" note,
    // and NO deaf-lane suffix (the new row keeps the chat live).
    const evt = mockEmitHookEvent.mock.calls.find((c) => c[1] === 'schedule_disabled')!;
    expect(evt[0]).toBe('s1');
    expect(evt[3]).toMatchObject({ scheduleId: 'sch_old', kind: 'recurring', reason: 'cancelled', successorId: 'sch_new' });
    expect(evt[2]).toContain('successor schedule sch_new is already armed');
    expect(evt[2]).not.toContain('NO enabled schedules');
  });

  it('collapses MULTIPLE stale same-cadence rows in one arm (repeated mishap shape)', async () => {
    staleRows = [{ id: 'sch_a', runsCount: 3 }, { id: 'sch_b', runsCount: 0 }];
    const r = await createSchedule(arm());
    expect(r.ok).toBe(true);
    expect(r.superseded).toEqual(['sch_a', 'sch_b']);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['sch_a', 'sch_b'] } },
      data: expect.objectContaining({ enabled: false, lastStatus: 'cancelled', cancelledBy: 'machine' }),
    });
    const evts = mockEmitHookEvent.mock.calls.filter((c) => c[1] === 'schedule_disabled');
    expect(evts).toHaveLength(2);
    expect(evts.map((c) => c[3].scheduleId).sort()).toEqual(['sch_a', 'sch_b']);
    for (const c of evts) expect(c[3].successorId).toBe('sch_new');
  });

  it('a renewOnExhaustion (system) successor row at the same cadence collapses too', async () => {
    staleRows = [{ id: 'sch_sys', runsCount: 12 }];
    const r = await createSchedule(arm());
    expect(r.superseded).toEqual(['sch_sys']);
    // The DB-side filter admits machine+system — pinned in the replay test's
    // staleCall assertion (promptSetBy { in: ['machine','system'] }).
  });

  it('an OWNER-armed (user) same-cadence row is NEVER collapsed — the stale read filters it out at the DB', async () => {
    staleRows = []; // the promptSetBy { in: ['machine','system'] } filter excludes user rows
    const r = await createSchedule(arm());
    expect(r.ok).toBe(true);
    expect(r.superseded).toBeUndefined();
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockEmitHookEvent.mock.calls.filter((c) => c[1] === 'schedule_disabled')).toHaveLength(0);
  });

  it('an OWNER ARM (promptSetBy user) does NOT collapse machine rows — collapse is machine-arm-only', async () => {
    const r = await createSchedule(arm({ promptSetBy: 'user' }));
    expect(r.ok).toBe(true);
    expect(r.superseded).toBeUndefined();
    expect(mockUpdateMany).not.toHaveBeenCalled();
    // No collapse read either (and the 1ead3b52 dedup read is machine-only too).
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('a DIFFERENT cadence is untouched (the stale read filters intervalSec at the DB)', async () => {
    staleRows = []; // DB-side: no recurring row at the new interval
    const r = await createSchedule(arm({ intervalSec: 3600 }));
    expect(r.ok).toBe(true);
    expect(r.superseded).toBeUndefined();
    const staleCall = mockFindMany.mock.calls.find((c) => isStaleQuery(c[0]))!;
    expect(staleCall[0].where.intervalSec).toBe(3600);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('a ONCE arm never collapses recurring rows (one-shots are not renewals)', async () => {
    const r = await createSchedule(arm({ kind: 'once', intervalSec: MIN_INTERVAL_SEC }));
    expect(r.ok).toBe(true);
    expect(r.superseded).toBeUndefined();
    expect(mockUpdateMany).not.toHaveBeenCalled();
    // The only findMany was the 1ead3b52 dedup read (kind-scoped) — no stale read.
    expect(mockFindMany.mock.calls.filter((c) => isStaleQuery(c[0]))).toHaveLength(0);
  });

  it('an IDENTICAL-prompt re-arm still ADOPTS (1ead3b52) and never reaches the collapse', async () => {
    dedupRows = [liveRecurring({ prompt: NEW_PROMPT })];
    const r = await createSchedule(arm());
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(true);
    expect(r.schedule?.id).toBe('sch_old'); // the EXISTING row, not a new one
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

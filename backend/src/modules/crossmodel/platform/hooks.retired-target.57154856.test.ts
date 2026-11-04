/**
 * Retired-target hook hygiene — REPLAY test for ticket 57154856 (2026-09-20).
 *
 * The incident: the stood-down coding lane "Kernel Optimization for GLM-5.3
 * W4A16" (b95e9df6 — retired 2026-09-17, 0 open todos, 0 enabled schedules)
 * was woken at 17:57Z by a todo_done event from the still-active flash lane
 * through leftover peer hook 97b2573e; the spurious run burned ~6 minutes and
 * was derail-killed, and the pipe kept firing on EVERY peer completion until
 * the Fleet Supervisor paused the hook by hand.
 *
 * The fix (hooks.service.ts deliverHookGroup): a delivery-time RETIRED-TARGET
 * check right after the ownership re-check — a hook whose target chat owns no
 * live work (archived, or a coding lane with 0 enabled schedules + 0 open
 * todos) gets its wake SKIPPED (no run burned, no daily-cap token consumed)
 * and the hook AUTO-PAUSED (rows 'skipped:target_retired', audit
 * hook.auto_pause; one hook_update re-enables).
 * system:* hooks (child-result / todo_wake reactivation path), supervisor
 * chats and plain non-coding chats are EXEMPT; a count-query hiccup fails
 * OPEN (deliver).
 *
 * Mock-everything pattern copied from hooks.service.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  eventHook: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })), // CAS auto-pause write (ticket 9df506cc F4)
    delete: jest.fn(async () => ({})),
  },
  hookEvent: {
    create: jest.fn(async () => ({})),
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 1 })),
    count: jest.fn(async () => 0),
  },
  projectTodo: { findUnique: jest.fn(), count: jest.fn(async () => 0) },
  codingSchedule: { count: jest.fn(async () => 0) },
  crossModelProject: { findUnique: jest.fn() },
  crossModelChat: { findUnique: jest.fn(), update: jest.fn(async () => ({})) },
  crossModelMessage: { create: jest.fn(async () => ({})) },
  activity: { create: jest.fn(async () => ({})) },
  $queryRaw: jest.fn(),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedisGet: jest.Mock = jest.fn(async () => null);
const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: (...a: any[]) => mockRedisGet(...a),
    set: (...a: any[]) => mockRedisSet(...a),
    del: (...a: any[]) => mockRedisDel(...a),
  },
}));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

const mockGetChatAccess = jest.fn();
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: (...a: any[]) => mockGetChatAccess(...a) },
}));

const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
const mockDailyCapExceeded: jest.Mock = jest.fn(async () => null);
const mockRefundDailyCapToken: jest.Mock = jest.fn(async () => {});
const mockNotifyDailyCapOnce: jest.Mock = jest.fn(async () => {});
const mockClaimCapWindowGate: jest.Mock = jest.fn(async () => true);
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: (...a: any[]) => mockDailyCapExceeded(...a),
  refundDailyCapToken: (...a: any[]) => mockRefundDailyCapToken(...a),
  notifyDailyCapOnce: (...a: any[]) => mockNotifyDailyCapOnce(...a),
  claimCapWindowGate: (...a: any[]) => mockClaimCapWindowGate(...a),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked',
    GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss',
    HOOK_STALE_SUPPRESSED: 'hook_stale_suppressed',
    HOOK_QUIET_EVENT_SHED: 'hook_quiet_event_shed',
    HOOK_TARGET_RETIRED: 'hook_target_retired', // ticket 57154856
  },
}));

// ARCHIVED-TARGET-RETIRE (2026-10-20): a hook paused because its target is
// archived is remembered in the context store (the restore re-arms it).
const mockStorePut: jest.Mock = jest.fn(async () => {});
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: (...a: any[]) => mockStorePut(...a),
  storeDelete: jest.fn(async () => {}),
}));

import {
  sweepHookEvents, TODO_WAKE_EVENT_TYPE,
  HOOK_STATUS_TARGET_RETIRED, LIVE_TODO_STATUSES,
} from './hooks.service';

/** The incident hook: an agent-wired peer hook (tool:hook_subscribe), like 97b2573e. */
const hookRow = (over: any = {}) => ({
  id: 'h1', userId: 'u1', sourceChatId: 'c-src', targetChatId: 'c-tgt',
  eventTypes: ['todo_done'], promptTemplate: '', enabled: true,
  debounceSec: 60, lastFiredAt: null, createdVia: 'tool:hook_subscribe',
  createdAt: new Date('2026-08-01T00:00:00Z'), updatedAt: new Date('2026-08-01T00:00:00Z'),
  ...over,
});

const setPendingRows = (rows: any[], horizonRows: any[] = [], backlogRows: any[] = []) => {
  mockPrisma.hookEvent.findMany.mockImplementation(async (args: any) =>
    (args?.where?.createdAt?.lt ? horizonRows
      : args?.where?.hookId ? backlogRows
      : rows));
};

const eventRow = (over: any = {}) => ({
  id: 'e1', hookId: 'h1', userId: 'u1', eventType: 'todo_done',
  payload: {
    eventType: 'todo_done', sourceChatId: 'c-src', sourceChatTitle: 'Flash Lane',
    summary: 'Todo done: deploy smoke test', depth: 0,
  },
  status: 'pending', attempts: 0,
  createdAt: new Date(), updatedAt: new Date(),
  ...over,
});

const updatesWith = (pred: (data: any) => boolean) =>
  mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).filter((u: any) => pred(u.data));

/** Per-test target chat shape — the retirement inputs. */
let targetChat: any;
const RETIRED_CODING_LANE = {
  userId: 'u1', archivedAt: null, isSupervisor: false, isProjectSupervisor: false,
  codingState: { id: 'cs-1' },
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ARCHIVED_TARGET_RETIRE_DISABLED;
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockFireScheduleTarget.mockResolvedValue({ started: true });
  mockDailyCapExceeded.mockResolvedValue(null);
  mockClaimCapWindowGate.mockResolvedValue(true);
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  mockPrisma.eventHook.findFirst.mockResolvedValue(null);
  mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.hookEvent.count.mockResolvedValue(0);
  mockPrisma.projectTodo.findUnique.mockResolvedValue({ status: 'pending', assigneeChatId: 'c-tgt' });
  // Retired by default: no enabled schedules, no open todos.
  mockPrisma.codingSchedule.count.mockResolvedValue(0);
  mockPrisma.projectTodo.count.mockResolvedValue(0);
  targetChat = { ...RETIRED_CODING_LANE };
  // The sweep reads the TARGET (ownership + retirement selects) and, for a
  // specific hook, the SOURCE (ownership select) — route by id.
  mockPrisma.crossModelChat.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(
      where?.id === 'c-tgt' ? targetChat
        : where?.id === 'c-src' ? { userId: 'u1' }
        : { userId: 'u1' },
    ));
  mockPrisma.$queryRaw.mockImplementation(() => mockPrisma.hookEvent.findMany());
  mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
});

describe('retired-target hook hygiene (ticket 57154856)', () => {
  it('REPLAY 97b2573e: a todo_done aimed at a stood-down coding lane is SKIPPED and the hook AUTO-PAUSED (no run burned)', async () => {
    setPendingRows([eventRow()]);
    await sweepHookEvents();

    expect(mockFireScheduleTarget).not.toHaveBeenCalled(); // no spurious run
    expect(mockDailyCapExceeded).not.toHaveBeenCalled(); // no budget token consumed
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)[0])
      .toMatchObject({ where: { id: { in: ['e1'] } } });
    // CAS auto-pause (ticket 9df506cc F4): conditional on enabled=true.
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({ where: { id: 'h1', enabled: true }, data: { enabled: false } });
    expect(mockPrisma.eventHook.update.mock.calls.some((c: any[]) => c[0]?.data?.enabled === false)).toBe(false);
    const auditCalls = mockPrisma.activity.create.mock.calls.map((c: any[]) => c[0].data);
    expect(auditCalls.some((a: any) => a.action === 'hook.auto_pause')).toBe(true);
    expect(mockRedisDel).toHaveBeenCalled(); // debounce gate released (no phantom window)
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(0);
  });

  it('a WILDCARD hook (sourceChatId null) aimed at a retired lane is skipped + paused too', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ sourceChatId: null }));
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(1);
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({ where: { id: 'h1', enabled: true }, data: { enabled: false } });
  });

  it('an ARCHIVED target chat is retired even if it still has an enabled schedule (archived wins)', async () => {
    targetChat = { ...RETIRED_CODING_LANE, archivedAt: new Date('2026-09-20T00:00:00Z') };
    mockPrisma.codingSchedule.count.mockResolvedValue(1); // would otherwise be live
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(1);
    const pauseAudit = mockPrisma.activity.create.mock.calls.map((c: any[]) => c[0].data).find((a: any) => a.action === 'hook.auto_pause');
    expect(pauseAudit?.metadata?.reason).toContain('retired (archived)');
  });

  it('ARCHIVED-TARGET-RETIRE (2026-10-20): a SATELLITE-archived lane (session API archive) is retired even with live work, and the paused hook is remembered for the restore; the kill switch delivers', async () => {
    targetChat = { ...RETIRED_CODING_LANE, codingState: { id: 'cs-1', status: 'archived' } };
    mockPrisma.codingSchedule.count.mockResolvedValue(1); // leftover rows would otherwise read live
    mockPrisma.projectTodo.count.mockResolvedValue(2);
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(1);
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({ where: { id: 'h1', enabled: true }, data: { enabled: false } });
    expect(mockStorePut).toHaveBeenCalledWith(['hooks', 'archive-paused', 'c-tgt'], 'ids', { ids: ['h1'], at: expect.any(String) });
    const pauseAudit = mockPrisma.activity.create.mock.calls.map((c: any[]) => c[0].data).find((a: any) => a.action === 'hook.auto_pause');
    expect(pauseAudit?.metadata?.reason).toContain('retired (archived)');

    jest.clearAllMocks();
    process.env.ARCHIVED_TARGET_RETIRE_DISABLED = '1';
    mockPrisma.codingSchedule.count.mockResolvedValue(1);
    mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
    mockFireScheduleTarget.mockResolvedValue({ started: true });
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1); // pre-fix: the live-work count decides
    expect(mockStorePut).not.toHaveBeenCalled();
  });

  it('a coding lane WITH an enabled schedule is LIVE — the wake delivers unchanged', async () => {
    mockPrisma.codingSchedule.count.mockResolvedValue(1);
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(0);
    expect(mockPrisma.eventHook.updateMany.mock.calls.some((c: any[]) => c[0]?.data?.enabled === false)).toBe(false);
  });

  it('a coding lane WITH an open BLOCKED todo is LIVE (blocked is still an open loop) — the wake delivers', async () => {
    mockPrisma.projectTodo.count.mockResolvedValue(1);
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    // the live-work probe uses exactly the LIVE_TODO_STATUSES set
    expect(mockPrisma.projectTodo.count).toHaveBeenCalledWith({
      where: { assigneeChatId: 'c-tgt', status: { in: [...LIVE_TODO_STATUSES] } },
    });
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(0);
  });

  it('EXEMPTION: a system:child-result-hook still wakes a dormant parent (the verdict-wait path must never be paused)', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(
      hookRow({ sourceChatId: 'c-child', eventTypes: ['run_completed'], createdVia: 'system:child-result-hook' }),
    );
    setPendingRows([eventRow({
      eventType: 'run_completed',
      payload: { eventType: 'run_completed', sourceChatId: 'c-child', sourceChatTitle: 'Reviewer', summary: 'Verdict: REFUTED nothing', depth: 0 },
    })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(0);
    expect(mockPrisma.codingSchedule.count).not.toHaveBeenCalled(); // exempt BEFORE the counts
  });

  it('EXEMPTION: the system:direct-wake todo_wake self-hook still fires (the lane REACTIVATION path)', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({
      sourceChatId: 'c-tgt', eventTypes: [TODO_WAKE_EVENT_TYPE],
      promptTemplate: '{{summary}}', debounceSec: 0, createdVia: 'system:direct-wake',
    }));
    setPendingRows([eventRow({
      eventType: TODO_WAKE_EVENT_TYPE,
      payload: {
        eventType: TODO_WAKE_EVENT_TYPE, sourceChatId: 'c-tgt', sourceChatTitle: 'Kernel Opt',
        summary: 'A todo was just ASSIGNED to this chat — START now', depth: 0, todoId: 'todo-1',
      },
    })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(0);
  });

  it('EXEMPTION: a supervisor chat target is a standing lane — delivers with no live work', async () => {
    targetChat = { ...RETIRED_CODING_LANE, isSupervisor: true, codingState: null };
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(0);
  });

  it('EXEMPTION: a PLAIN chat (no codingState) with no board work is an interactive surface, not a retired lane — delivers', async () => {
    targetChat = { ...RETIRED_CODING_LANE, codingState: null };
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(0);
  });

  it('a count-query hiccup fails OPEN (delivers) — the outbox must not wedge on a transient', async () => {
    mockPrisma.codingSchedule.count.mockRejectedValue(new Error('prisma down'));
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(0);
  });
});

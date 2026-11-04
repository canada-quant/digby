/**
 * Supervisor OFF switch × hook delivery (owner 2026-09-26; hooks.service.ts
 * deliverHookGroup). A wake aimed at a Fleet / project supervisor chat whose
 * admin switch is OFF is SKIPPED at delivery: rows terminal-marked
 * 'skipped:supervisor_off' (never replayed on re-enable), no
 * fireScheduleTarget, no daily-cap token, the hook left ENABLED, the debounce
 * gate released, one supervisor_switch telemetry row naming the entry point
 * (payload.origin of a direct wake rides as `hook:<origin>`). A plain lane
 * and an ON supervisor deliver as before; the dispatch-time backstop reason
 * ('supervisor_off' from fireScheduleTarget) terminal-marks the rows without
 * an attempt burn.
 *
 * Mock-everything pattern copied from hooks.retired-target.57154856.test.ts
 * (+ a systemSetting table for the REAL supervisor-switch module).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const settings = new Map<string, { key: string; value: string; updatedAt: Date }>();
const mockPrisma: any = {
  eventHook: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
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
  systemSetting: { findUnique: jest.fn(async ({ where }: any) => settings.get(where.key) ?? null) },
  $queryRaw: jest.fn(),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedisGet: jest.Mock = jest.fn(async () => null);
const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisDel: jest.Mock = jest.fn(async () => 1);
const mockRedisIncr: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: (...a: any[]) => mockRedisGet(...a),
    set: (...a: any[]) => mockRedisSet(...a),
    del: (...a: any[]) => mockRedisDel(...a),
    incr: (...a: any[]) => mockRedisIncr(...a),
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
    HOOK_TARGET_RETIRED: 'hook_target_retired',
    SUPERVISOR_SWITCH: 'supervisor_switch',
  },
}));

import { sweepHookEvents, HOOK_STATUS_SUPERVISOR_OFF, hookWakeSource } from './hooks.service';
import { invalidateSupervisorSwitchCache, resetSupervisorSwitchMetricWindowForTests, FLEET_SUPERVISOR_ENABLED_KEY, PROJECT_SUPERVISORS_ENABLED_KEY } from './supervisor-switch';

const hookRow = (over: any = {}) => ({
  id: 'h1', userId: 'u1', sourceChatId: null, targetChatId: 'c-sup',
  eventTypes: ['run_completed'], promptTemplate: '', enabled: true,
  debounceSec: 60, lastFiredAt: null, createdVia: 'system:fleet-supervisor',
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
  id: 'e1', hookId: 'h1', userId: 'u1', eventType: 'run_completed',
  payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Lane', summary: 'run done', depth: 0 },
  status: 'pending', attempts: 0,
  createdAt: new Date(), updatedAt: new Date(),
  ...over,
});

const updatesWith = (pred: (data: any) => boolean) =>
  mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).filter((u: any) => pred(u.data));
const switchRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m.kind === 'supervisor_switch');

let targetChat: any;
const FLEET_SUP = { userId: 'u1', archivedAt: null, isSupervisor: true, isProjectSupervisor: false, codingState: null };

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  invalidateSupervisorSwitchCache();
  resetSupervisorSwitchMetricWindowForTests();
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
  mockPrisma.codingSchedule.count.mockResolvedValue(1);
  mockPrisma.projectTodo.count.mockResolvedValue(0);
  targetChat = { ...FLEET_SUP };
  mockPrisma.crossModelChat.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(where?.id === 'c-sup' ? targetChat : { userId: 'u1' }));
  // Wildcard delivery re-checks each source row's owner/project (findMany).
  mockPrisma.crossModelChat.findMany = jest.fn(async () => [{ id: 'c-src', userId: 'u1', projectId: null, project: null }]);
  mockPrisma.$queryRaw.mockImplementation(() => mockPrisma.hookEvent.findMany());
  mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
});

const off = (key: string) => settings.set(key, { key, value: '0', updatedAt: new Date('2026-09-26T17:00:00Z') });

describe('supervisor OFF switch × deliverHookGroup', () => {
  it('fleet OFF: a wildcard wake for the Fleet Supervisor is terminal-marked skipped:supervisor_off — no run, no cap token, hook still enabled, gate released, one telemetry row', async () => {
    off(FLEET_SUPERVISOR_ENABLED_KEY);
    setPendingRows([eventRow()]);
    await sweepHookEvents();

    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockDailyCapExceeded).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === HOOK_STATUS_SUPERVISOR_OFF)[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(HOOK_STATUS_SUPERVISOR_OFF).toBe('skipped:supervisor_off');
    // The hook is NOT paused/disabled — a re-enable resumes with NEW events.
    expect(mockPrisma.eventHook.updateMany.mock.calls.some((c: any[]) => c[0]?.data?.enabled === false)).toBe(false);
    expect(mockPrisma.eventHook.update.mock.calls.some((c: any[]) => c[0]?.data?.enabled === false)).toBe(false);
    expect(mockRedisDel).toHaveBeenCalled(); // debounce gate released
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(0);
    expect(switchRows()).toEqual([expect.objectContaining({ sessionId: 'c-sup', meta: expect.objectContaining({ target: 'fleet', action: 'skipped', source: 'hook', chatId: 'c-sup' }) })]);
  });

  it('a direct wake (infra-watch / follow-through) names its producer in the telemetry source', async () => {
    off(FLEET_SUPERVISOR_ENABLED_KEY);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ sourceChatId: 'c-sup', eventTypes: ['todo_wake'], createdVia: 'system:direct-wake', promptTemplate: '{{summary}}' }));
    setPendingRows([eventRow({ eventType: 'todo_wake', payload: { eventType: 'todo_wake', sourceChatId: 'c-sup', summary: '[INFRA ALERT — disk]', depth: 0, origin: 'infra-watch' } })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === HOOK_STATUS_SUPERVISOR_OFF)).toHaveLength(1);
    expect(switchRows()[0].meta.source).toBe('hook:infra-watch');
    expect(hookWakeSource([{ payload: { origin: 'b' } }, { payload: { origin: 'a' } }, { payload: {} }])).toBe('hook:a+b');
    expect(hookWakeSource([{ payload: {} }])).toBe('hook');
  });

  it('project OFF: a project-supervisor target is skipped; the Fleet Supervisor still delivers (independent switches)', async () => {
    off(PROJECT_SUPERVISORS_ENABLED_KEY);
    targetChat = { userId: 'u1', archivedAt: null, isSupervisor: false, isProjectSupervisor: true, codingState: null };
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ projectId: 'p1' }));
    mockPrisma.crossModelChat.findMany = jest.fn(async () => [{ id: 'c-src', userId: 'u1', projectId: 'p1', project: { supervised: true } }]);
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(switchRows()[0].meta).toMatchObject({ target: 'project', source: 'hook' });

    jest.clearAllMocks();
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockPrisma.crossModelChat.findMany = jest.fn(async () => [{ id: 'c-src', userId: 'u1', projectId: null, project: null }]);
    mockPrisma.$queryRaw.mockImplementation(() => mockPrisma.hookEvent.findMany());
    mockPrisma.crossModelChat.findUnique.mockImplementation(({ where }: any) => Promise.resolve(where?.id === 'c-sup' ? { ...FLEET_SUP } : { userId: 'u1' }));
    mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
    mockFireScheduleTarget.mockResolvedValue({ started: true });
    mockDailyCapExceeded.mockResolvedValue(null);
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(1);
  });

  it('both ON: the supervisor wake delivers exactly as before (no switch row, no extra status)', async () => {
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_SUPERVISOR_OFF)).toHaveLength(0);
    expect(switchRows()).toHaveLength(0);
  });

  it('a PLAIN lane target is never gated even while both switches are OFF', async () => {
    off(FLEET_SUPERVISOR_ENABLED_KEY);
    off(PROJECT_SUPERVISORS_ENABLED_KEY);
    targetChat = { userId: 'u1', archivedAt: null, isSupervisor: false, isProjectSupervisor: false, codingState: { id: 'cs-1' } };
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ sourceChatId: 'c-src', createdVia: 'tool:hook_subscribe' }));
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(switchRows()).toHaveLength(0);
  });

  it('review fix: a lane_idle wake a supervisor-OFF skip consumes releases the lane\'s dedupe slot (pre-fire gate AND dispatch backstop)', async () => {
    const laneIdle = () => eventRow({
      id: 'e-idle', eventType: 'todo_wake',
      payload: { eventType: 'todo_wake', sourceChatId: 'c-sup', summary: '[LANE IDLE WITH OPEN WORK]', depth: 0, wakeKind: 'lane_idle', laneChatId: 'lane-123', enqueuedAt: new Date(Date.now() - 25 * 60_000).toISOString() },
    });
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ sourceChatId: 'c-sup', eventTypes: ['todo_wake'], createdVia: 'system:direct-wake', promptTemplate: '{{summary}}', debounceSec: 0 }));
    off(PROJECT_SUPERVISORS_ENABLED_KEY);
    targetChat = { userId: 'u1', archivedAt: null, isSupervisor: false, isProjectSupervisor: true, codingState: null };
    setPendingRows([laneIdle()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === HOOK_STATUS_SUPERVISOR_OFF)).toHaveLength(1);
    expect(mockRedisDel).toHaveBeenCalledWith('lane-idle-wake:lane-123');

    // The dispatch-time backstop (the switch flipped between the gate and the fire) releases it too.
    mockRedisDel.mockClear();
    settings.clear();
    invalidateSupervisorSwitchCache();
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'supervisor_off' });
    setPendingRows([laneIdle()]);
    await sweepHookEvents();
    expect(updatesWith((d) => d?.status === HOOK_STATUS_SUPERVISOR_OFF)).toHaveLength(2);
    expect(mockRedisDel).toHaveBeenCalledWith('lane-idle-wake:lane-123');

    // A plain (non lane_idle) skipped row releases nothing.
    mockRedisDel.mockClear();
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockRedisDel).not.toHaveBeenCalledWith(expect.stringMatching(/^lane-idle-wake:/));
  });

  it("dispatch-time backstop: reason 'supervisor_off' from fireScheduleTarget terminal-marks the rows with no attempt burn", async () => {
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'supervisor_off' });
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(updatesWith((d) => d?.status === HOOK_STATUS_SUPERVISOR_OFF)).toHaveLength(1);
    expect(updatesWith((d) => d?.attempts?.increment != null)).toHaveLength(0);
    expect(mockRefundDailyCapToken).toHaveBeenCalledWith('c-sup');
  });
});

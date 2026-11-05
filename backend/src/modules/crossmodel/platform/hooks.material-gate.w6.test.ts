/**
 * audit 2026-10-08 W6-2 — the material-change gate at the hook seam
 * (hooks.service deliverHookGroup): a SUPERVISOR target's group the gate
 * judges non-material is terminal-marked 'skipped:no_material_change' — no
 * fireScheduleTarget, the daily-cap token refunded, the debounce gate
 * released, the Jev stashes closed, one agreement row; a material verdict
 * (or a gate error) delivers exactly as before; a plain lane never consults
 * the gate. The gate module itself is mocked here (its rule + reads are
 * covered by supervisor-wake-ledger.test.ts / wake-material-rule.test.ts).
 *
 * Harness copied from hooks.supervisor-switch.test.ts.
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
  chatSchedule: { count: jest.fn(async () => 0) },
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


const mockMaterialGateForHook: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockRecordAgreement: jest.Mock = jest.fn();
const mockCloseStashes: jest.Mock = jest.fn(async () => {});
jest.mock('./supervisor-wake-ledger', () => ({
  __esModule: true,
  materialGateForHook: (...a: any[]) => mockMaterialGateForHook(...a),
  recordMaterialGateAgreement: (...a: any[]) => mockRecordAgreement(...a),
  closeStashesForGateSkip: (...a: any[]) => mockCloseStashes(...a),
}));

import { sweepHookEvents } from './hooks.service';
import { HOOK_STATUS_NO_MATERIAL_CHANGE } from './wake-material-rule';
import { invalidateSupervisorSwitchCache, resetSupervisorSwitchMetricWindowForTests } from './supervisor-switch';

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
const skipVerdict = { origin: 'hook', chatId: 'c-sup', mode: 'act', skip: true, verdict: { material: false, reasons: [], heartbeat: false, sinceMin: 60, floorHours: 4 } };
const passVerdict = { ...skipVerdict, skip: false, verdict: { ...skipVerdict.verdict, material: true, reasons: ['new_report'] } };

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
  mockPrisma.chatSchedule.count.mockResolvedValue(1);
  mockPrisma.projectTodo.count.mockResolvedValue(0);
  targetChat = { ...FLEET_SUP };
  mockPrisma.crossModelChat.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(where?.id === 'c-sup' ? targetChat : { userId: 'u1' }));
  mockPrisma.crossModelChat.findMany = jest.fn(async () => [{ id: 'c-src', userId: 'u1', projectId: null, project: null }]);
  mockPrisma.$queryRaw.mockImplementation(() => mockPrisma.hookEvent.findMany());
  mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
  mockMaterialGateForHook.mockResolvedValue(null);
});

describe('W6-2 material gate × deliverHookGroup', () => {
  it('a NON-material supervisor group is skipped: rows skipped:no_material_change, no run, cap token refunded, debounce gate released, stashes closed', async () => {
    mockMaterialGateForHook.mockResolvedValue(skipVerdict);
    setPendingRows([eventRow({ payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Drive watch', summary: 'No audio yet, 09:14 AM PDT', depth: 0 } })]);
    await sweepHookEvents();

    expect(mockMaterialGateForHook).toHaveBeenCalledWith(expect.objectContaining({ targetChatId: 'c-sup', alarm: false }));
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === HOOK_STATUS_NO_MATERIAL_CHANGE)[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(0);
    expect(mockRefundDailyCapToken).toHaveBeenCalledWith('c-sup');
    expect(mockRedisDel).toHaveBeenCalled();
    expect(mockRecordAgreement).toHaveBeenCalledWith(skipVerdict, [null]);
    expect(mockCloseStashes).toHaveBeenCalledWith([], 'c-sup', 'hook');
  });

  it('a MATERIAL verdict delivers as before (one run, rows delivered) and still records the agreement row', async () => {
    mockMaterialGateForHook.mockResolvedValue(passVerdict);
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_NO_MATERIAL_CHANGE)).toHaveLength(0);
    expect(mockRecordAgreement).toHaveBeenCalledTimes(1);
  });

  it('a gate that throws fails OPEN (delivers); an alarm row reaches the gate flagged alarm', async () => {
    mockMaterialGateForHook.mockRejectedValue(new Error('boom'));
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    mockPrisma.$queryRaw.mockImplementation(() => mockPrisma.hookEvent.findMany());
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['run_failed'] }));
    mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
    mockFireScheduleTarget.mockResolvedValue({ started: true });
    mockDailyCapExceeded.mockResolvedValue(null);
    mockMaterialGateForHook.mockResolvedValue(passVerdict);
    setPendingRows([eventRow({ eventType: 'run_failed', payload: { eventType: 'run_failed', sourceChatId: 'c-src', summary: 'Chat run failed', depth: 0 } })]);
    await sweepHookEvents();
    expect(mockMaterialGateForHook).toHaveBeenCalledWith(expect.objectContaining({ alarm: true }));
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });

  it('a PLAIN lane target never consults the gate', async () => {
    targetChat = { userId: 'u1', archivedAt: null, isSupervisor: false, isProjectSupervisor: false, codingState: { id: 'cs-1' } };
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ sourceChatId: 'c-src', createdVia: 'tool:hook_subscribe' }));
    mockMaterialGateForHook.mockResolvedValue(skipVerdict);
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockMaterialGateForHook).not.toHaveBeenCalled();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });
});

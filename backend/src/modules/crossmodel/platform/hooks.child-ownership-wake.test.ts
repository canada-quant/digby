/**
 * Child-result hook — ownership-moved retirement × sweep delivery
 * (ticket f8c62820; hooks.service.ts deliverHookGroup →
 * platform/child-ownership-wake.ts).
 *
 * The 2026-09-29 incident (PR #1251 → child b811d9f7): a supervisor took the
 * child lane over with an agent steer (6e05992f) while the auto-wired
 * child-result hook (`createdVia 'system:child-result-hook'`) kept firing
 * full-cost wakes on the ex-parent. Pins: when the child's newest agent-sent
 * steer comes from a chat OTHER than the parent and is newer than the parent's
 * last engagement, the wake is SKIPPED — rows terminal-marked
 * 'skipped:ownership_moved' (never replayed), no fireScheduleTarget, no cap
 * token, the hook left ENABLED (self-heals on a newer parent steer), the
 * debounce gate released, one child_ownership_wake_skipped telemetry row.
 * A newer parent steer, the kill switch, a non-child-result hook, an
 * unattributable steer and a probe failure all deliver as before.
 *
 * Mock-everything pattern copied from hooks.handoff-parent-wake.test.ts
 * (which also runs before this gate and passes through un-posted).
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
  crossModelMessage: { create: jest.fn(async () => ({})), findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), update: jest.fn(async () => ({})) },
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
    constructor(public statusCode: number, public message: string, public isOperational = true) {
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
    HANDOFF_PARENT_WAKE_SKIPPED: 'handoff_parent_wake_skipped',
    CHILD_OWNERSHIP_WAKE_SKIPPED: 'child_ownership_wake_skipped',
  },
}));

// The hand-off gate runs BEFORE the ownership gate and must pass through
// (no posted note, no store record) so the ownership gate is what skips.
const records = new Map<string, Record<string, unknown>>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => records.get(`${ns.join('/')}::${key}`) ?? null),
  storePut: jest.fn(async () => {}),
  storeCreate: jest.fn(async () => true),
  storeDelete: jest.fn(async () => {}),
}));
jest.mock('../coding/deliverable-handoff', () => ({
  __esModule: true,
  HANDOFF_STORE_NS: 'deliverable-handoff',
  taskIdForSession: (id: string) => `session:${id}`,
}));
const mockPersistTaskCard: jest.Mock = jest.fn(async () => 'row-answer');
const mockEmitTaskEvent: jest.Mock = jest.fn(() => true);
jest.mock('../chat-agent/task-events', () => ({
  __esModule: true,
  buildTaskEvent: (p: any) => ({ steps: { done: 0, total: 0 }, receipts: { ok: 0, total: 0 }, spendUsd: 0, artifacts: [], startedAt: 'now', ...p, updatedAt: 'now' }),
  persistTaskCard: (...a: any[]) => mockPersistTaskCard(...a),
  emitTaskEvent: (...a: any[]) => mockEmitTaskEvent(...a),
}));

import { sweepHookEvents } from './hooks.service';
import { HOOK_STATUS_OWNERSHIP_MOVED } from './child-ownership-wake';

const CHILD = 'c-child-1111';
const PARENT = 'c-parent-2222';
const TAKER = 'c-sup-3333'; // the supervisor that took the child over (the 6e05992f shape)

const T0 = new Date('2026-09-29T05:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

const hookRow = (over: any = {}) => ({
  id: 'h1', userId: 'u1', sourceChatId: CHILD, targetChatId: PARENT,
  eventTypes: ['run_completed', 'run_failed', 'attention_needed'], promptTemplate: '{{summary}}', enabled: true,
  debounceSec: 60, lastFiredAt: null, createdVia: 'system:child-result-hook',
  createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z'),
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
  payload: { eventType: 'run_completed', sourceChatId: CHILD, sourceChatTitle: 'Deck build', summary: 'Coding run completed.', depth: 0, runId: 'run-1' },
  status: 'pending', attempts: 0,
  createdAt: new Date(), updatedAt: new Date(),
  ...over,
});

/** Agent-sent rows into the child, as the probe selects them (newest first). */
const steerRows = (...rows: Array<{ sourceChatId: string; createdAt: Date; originSourceChatId?: string | null }>) =>
  rows.map((r) => ({ createdAt: r.createdAt, metadata: { origin: 'agent', originSourceChatId: r.originSourceChatId ?? r.sourceChatId } }));

const updatesWith = (pred: (data: any) => boolean) =>
  mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).filter((u: any) => pred(u.data));
const ownershipRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m.kind === 'child_ownership_wake_skipped');

const HUMAN_PARENT = { userId: 'u1', archivedAt: null, isSupervisor: false, isProjectSupervisor: false, codingState: null };
let targetChat: any;

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  records.clear();
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockFireScheduleTarget.mockResolvedValue({ started: true });
  mockDailyCapExceeded.mockResolvedValue(null);
  mockClaimCapWindowGate.mockResolvedValue(true);
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  mockPersistTaskCard.mockResolvedValue('row-answer');
  mockPrisma.eventHook.findFirst.mockResolvedValue(null);
  mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.hookEvent.count.mockResolvedValue(0);
  mockPrisma.chatSchedule.count.mockResolvedValue(0);
  mockPrisma.projectTodo.count.mockResolvedValue(0);
  mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
  targetChat = { ...HUMAN_PARENT };
  mockPrisma.crossModelChat.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(where?.id === PARENT ? targetChat : { id: CHILD, userId: 'u1', title: 'Deck build', projectId: null, archivedAt: null }));
  mockPrisma.crossModelChat.findMany = jest.fn(async () => [{ id: CHILD, userId: 'u1', projectId: null, project: null }]);
  mockPrisma.$queryRaw.mockImplementation(() => mockPrisma.hookEvent.findMany());
  mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
});

describe('child ownership-moved × deliverHookGroup (auto-wired child-result hook)', () => {
  it('the incident shape: an external steer NEWER than the parent\'s last engagement → skipped, rows terminal-marked, no run, no cap token, hook enabled, gate released, one telemetry row, bounded probe', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue(steerRows(
      { sourceChatId: TAKER, createdAt: at(30) }, // the takeover steer
      { sourceChatId: PARENT, createdAt: at(10) }, // the parent's last engagement
    ));
    await sweepHookEvents();

    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockDailyCapExceeded).not.toHaveBeenCalled();
    expect(HOOK_STATUS_OWNERSHIP_MOVED).toBe('skipped:ownership_moved');
    expect(updatesWith((d) => d?.status === HOOK_STATUS_OWNERSHIP_MOVED)[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(0);
    expect(mockPrisma.eventHook.updateMany.mock.calls.some((c: any[]) => c[0]?.data?.enabled === false)).toBe(false);
    expect(mockRedisDel).toHaveBeenCalled(); // debounce gate released
    expect(ownershipRows()).toEqual([expect.objectContaining({
      sessionId: PARENT, value: 1,
      meta: expect.objectContaining({ hookId: 'h1', childChatId: CHILD, eventTypes: ['run_completed'], reason: `external_steer_${TAKER}` }),
    })]);
    // the probe: bounded, newest-first, agent-origin rows on the CHILD chat only
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { chatId: CHILD, role: 'user', metadata: { path: ['origin'], equals: 'agent' } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }));
  });

  it('the self-heal arm: the parent re-engaged AFTER the takeover → the wake delivers (ownership re-established)', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue(steerRows(
      { sourceChatId: PARENT, createdAt: at(40) }, // parent's newest engagement
      { sourceChatId: TAKER, createdAt: at(10) },  // the (now stale) takeover steer
    ));
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_OWNERSHIP_MOVED)).toHaveLength(0);
    expect(ownershipRows()).toHaveLength(0);
  });

  it('a NON child-result hook (createdVia user) is untouched: delivers, no probe', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ createdVia: 'user' }));
    setPendingRows([eventRow()]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue(steerRows({ sourceChatId: TAKER, createdAt: at(30) }, { sourceChatId: PARENT, createdAt: at(10) }));
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.findMany).not.toHaveBeenCalled();
  });

  it('unattributable steer rows (no originSourceChatId) are NOT a takeover signal → delivers', async () => {
    setPendingRows([eventRow()]);
    // built directly (the steerRows helper defaults a missing/null
    // originSourceChatId back to the source id — here the row must stay
    // genuinely unattributable, exactly as the probe's filter drops it)
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { createdAt: at(30), metadata: { origin: 'agent' } }, // taker-shaped row, but unattributable
      { createdAt: at(10), metadata: { origin: 'agent', originSourceChatId: PARENT } },
    ]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_OWNERSHIP_MOVED)).toHaveLength(0);
  });

  it('a probe failure delivers as before (fail-open)', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.crossModelMessage.findMany.mockRejectedValue(new Error('connection reset'));
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_OWNERSHIP_MOVED)).toHaveLength(0);
    expect(ownershipRows()).toHaveLength(0);
  });
});

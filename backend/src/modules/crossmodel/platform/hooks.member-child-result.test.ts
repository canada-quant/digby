/**
 * SHARED-PROJECT-DISPATCH review fix (2026-10-20) — the member-spawned
 * child-result hook x sweep delivery (hooks.service deliverHookGroup ->
 * memberChildResultSourceVerdict).
 *
 * The defect: an editor's project-supervisor chat on a shared project calls
 * start_coding_session; the lane runs as the PROJECT OWNER (platform.service
 * startCodingSession), and ensureChildResultHook wires child -> member's chat
 * under the MEMBER's account. The plain specific-hook ownership re-check
 * (`src.userId !== hook.userId`) deleted that hook on the child's FIRST event
 * (rows failed:source_gone, audit hook.auto_delete) - the member's supervisor,
 * told "this chat is WOKEN when it completes", never was.
 *
 * Pins (real hook rows, real delivery path, mocked I/O): the cross-owner
 * system:child-result-hook whose source's lineage parent IS the target and
 * whose hook user still has WRITE access to the source DELIVERS (hook kept);
 * a viewer demotion, a user-made hook, a re-parented source and the kill
 * switch SPAWN_MEMBER_ACCESS_DISABLED=1 retire it exactly as before; an
 * access-lookup error requeues the rows (never a silent delete).
 *
 * Mock-everything harness copied from hooks.child-ownership-wake.test.ts.
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
  taskCardDisabled: () => process.env.TASK_CARD_DISABLED === '1',
  buildTaskEvent: (p: any) => ({ steps: { done: 0, total: 0 }, receipts: { ok: 0, total: 0 }, spendUsd: 0, artifacts: [], startedAt: 'now', ...p, updatedAt: 'now' }),
  persistTaskCard: (...a: any[]) => mockPersistTaskCard(...a),
  emitTaskEvent: (...a: any[]) => mockEmitTaskEvent(...a),
}));

import { sweepHookEvents, memberChildResultSourceVerdict } from './hooks.service';

const CHILD = 'c-child-lane-1111';
const PARENT = 'c-member-chat-2222'; // the MEMBER's chat that spawned the lane
const OWNER = 'u-owner';
const MEMBER = 'u-member';

const hookRow = (over: any = {}) => ({
  id: 'h1', userId: MEMBER, sourceChatId: CHILD, targetChatId: PARENT,
  eventTypes: ['run_completed', 'run_failed', 'attention_needed'], promptTemplate: '{{summary}}', enabled: true,
  debounceSec: 60, lastFiredAt: null, createdVia: 'system:child-result-hook',
  createdAt: new Date('2026-10-20T00:00:00Z'), updatedAt: new Date('2026-10-20T00:00:00Z'),
  ...over,
});

const setPendingRows = (rows: any[]) => {
  mockPrisma.hookEvent.findMany.mockImplementation(async (args: any) =>
    (args?.where?.createdAt?.lt ? [] : args?.where?.hookId ? [] : rows));
};

const eventRow = (over: any = {}) => ({
  id: 'e1', hookId: 'h1', userId: MEMBER, eventType: 'run_completed',
  payload: { eventType: 'run_completed', sourceChatId: CHILD, sourceChatTitle: 'Fix login', summary: 'Coding run completed.', depth: 0, runId: 'run-1' },
  status: 'pending', attempts: 0,
  createdAt: new Date(), updatedAt: new Date(),
  ...over,
});

const updatesWith = (pred: (data: any) => boolean) =>
  mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).filter((u: any) => pred(u.data));

/** The member's own (plain) chat — owned by the hook user. */
const MEMBER_CHAT = { userId: MEMBER, archivedAt: null, isSupervisor: false, isProjectSupervisor: false, codingState: null };
/** The lane — owned by the PROJECT OWNER, spawned by (lineage parent) the member's chat. */
let childChat: any;

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  records.clear();
  delete process.env.SPAWN_MEMBER_ACCESS_DISABLED;
  delete process.env.TASK_CARD_DISABLED;
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockFireScheduleTarget.mockResolvedValue({ started: true });
  mockDailyCapExceeded.mockResolvedValue(null);
  mockClaimCapWindowGate.mockResolvedValue(true);
  mockGetChatAccess.mockResolvedValue({ access: 'write', exists: true }); // editor membership on the lane's project
  mockPersistTaskCard.mockResolvedValue('row-answer');
  mockPrisma.eventHook.findFirst.mockResolvedValue(null);
  mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.hookEvent.count.mockResolvedValue(0);
  mockPrisma.codingSchedule.count.mockResolvedValue(0);
  mockPrisma.projectTodo.count.mockResolvedValue(0);
  mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
  childChat = { id: CHILD, userId: OWNER, title: 'Fix login', projectId: 'p-shared', archivedAt: null, parentChatId: PARENT };
  mockPrisma.crossModelChat.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(where?.id === PARENT ? { ...MEMBER_CHAT } : childChat));
  mockPrisma.crossModelChat.findMany = jest.fn(async () => [{ id: CHILD, userId: OWNER, projectId: 'p-shared', project: null }]);
  mockPrisma.$queryRaw.mockImplementation(() => mockPrisma.hookEvent.findMany());
  mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
});

describe('member-spawned child-result hook × deliverHookGroup (shared-project dispatch)', () => {
  it('the defect shape now DELIVERS: owner-owned child, member hook, lineage parent = target, write access → woken, hook kept', async () => {
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === 'failed:source_gone')).toHaveLength(0);
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(mockPrisma.activity.create.mock.calls.some((c: any[]) => c[0]?.data?.action === 'hook.auto_delete')).toBe(false);
    // the access check is the hook user's, on the SOURCE chat
    expect(mockGetChatAccess).toHaveBeenCalledWith(CHILD, MEMBER);
  });

  it('the ticket shape: the member\'s PROJECT SUPERVISOR chat is woken by the lane\'s run_failed (alarm)', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(where?.id === PARENT ? { ...MEMBER_CHAT, isProjectSupervisor: true } : childChat));
    setPendingRows([eventRow({ eventType: 'run_failed', payload: { eventType: 'run_failed', sourceChatId: CHILD, sourceChatTitle: 'Fix login', summary: 'Run failed: tests red', depth: 0, runId: 'run-2' } })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === 'failed:source_gone')).toHaveLength(0);
  });

  it('a member demoted to VIEWER (read access) → the hook retires exactly like ownership drift', async () => {
    mockGetChatAccess.mockResolvedValue({ access: 'read', exists: true });
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.delete).toHaveBeenCalledWith({ where: { id: 'h1' } });
    expect(updatesWith((d) => d?.status === 'failed:source_gone')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
  });

  it('a USER-made hook on another account\'s chat (createdVia tool) is NOT held — deleted as before', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ createdVia: 'tool:hook_subscribe' }));
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.delete).toHaveBeenCalledWith({ where: { id: 'h1' } });
    expect(mockGetChatAccess).not.toHaveBeenCalled();
  });

  it('a source whose lineage parent is NOT the hook target (re-parented / foreign) is NOT held', async () => {
    childChat = { ...childChat, parentChatId: 'c-someone-else' };
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.delete).toHaveBeenCalledWith({ where: { id: 'h1' } });
  });

  it('SPAWN_MEMBER_ACCESS_DISABLED=1 restores the plain owner check (deleted)', async () => {
    process.env.SPAWN_MEMBER_ACCESS_DISABLED = '1';
    try {
      setPendingRows([eventRow()]);
      await sweepHookEvents();
      expect(mockFireScheduleTarget).not.toHaveBeenCalled();
      expect(mockPrisma.eventHook.delete).toHaveBeenCalledWith({ where: { id: 'h1' } });
    } finally {
      delete process.env.SPAWN_MEMBER_ACCESS_DISABLED;
    }
  });

  it('an access-lookup ERROR requeues the rows (pending + retryAt), never deletes the hook, releases the gate', async () => {
    mockGetChatAccess.mockRejectedValue(new Error('connection reset'));
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
    const requeue = updatesWith((d) => d?.status === 'pending' && d?.retryAt instanceof Date);
    expect(requeue[0]).toMatchObject({ where: { id: { in: ['e1'] }, status: 'delivering' } });
    expect(updatesWith((d) => d?.status === 'failed:source_gone')).toHaveLength(0);
    expect(mockRedisDel).toHaveBeenCalled();
  });

  it('a SAME-owner source is untouched by the member leg (no access probe)', async () => {
    childChat = { ...childChat, userId: MEMBER };
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockGetChatAccess).not.toHaveBeenCalled();
  });
});

describe('memberChildResultSourceVerdict (the rule)', () => {
  const h = hookRow();
  it('holds only for the full shape; lapses on each missing leg', async () => {
    expect(await memberChildResultSourceVerdict(h, { userId: OWNER, parentChatId: PARENT })).toBe('holds');
    expect(await memberChildResultSourceVerdict(h, null)).toBe('lapsed');
    expect(await memberChildResultSourceVerdict(h, { userId: OWNER, parentChatId: null })).toBe('lapsed');
    expect(await memberChildResultSourceVerdict({ ...h, createdVia: null }, { userId: OWNER, parentChatId: PARENT })).toBe('lapsed');
    mockGetChatAccess.mockResolvedValueOnce({ access: 'none', exists: true });
    expect(await memberChildResultSourceVerdict(h, { userId: OWNER, parentChatId: PARENT })).toBe('lapsed');
    mockGetChatAccess.mockResolvedValueOnce({ access: 'owner', exists: true }); // the hook user owns an ancestor folder
    expect(await memberChildResultSourceVerdict(h, { userId: OWNER, parentChatId: PARENT })).toBe('holds');
  });

  it('a same-owner source holds without a probe', async () => {
    expect(await memberChildResultSourceVerdict(h, { userId: MEMBER, parentChatId: null })).toBe('holds');
    expect(mockGetChatAccess).not.toHaveBeenCalled();
  });
});

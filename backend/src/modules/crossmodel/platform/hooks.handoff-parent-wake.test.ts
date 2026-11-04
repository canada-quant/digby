/**
 * Hand-off × hook delivery (cohesive chat live fixes, 2026-09-28;
 * hooks.service.ts deliverHookGroup → platform/handoff-parent-wake.ts).
 *
 * The live acceptance showed a human's PLAIN chat (parent b9ee9c20) receiving
 * a raw `[MACHINE-TRIGGERED RUN …]` wake from its child's run_completed hook
 * at 05:27:39Z — in a chat where the task card + the hand-off result row ARE
 * the notification. Pins: such a wake is SKIPPED at delivery when the
 * hand-off posted (rows terminal-marked 'skipped:handoff_posted', no
 * fireScheduleTarget, no cap token, the hook left enabled, the debounce gate
 * released, one handoff_parent_wake_skipped telemetry row); a run_failed row
 * flips the parent's running card to FAILED instead of waking; a supervisor
 * parent and an un-posted completion deliver as before.
 *
 * Mock-everything pattern copied from hooks.supervisor-switch.test.ts.
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
  },
}));

// The hand-off record probe (context store) + the hand-off module's switches.
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
// The parent's task card: persistTaskCard reports whether a carrier row was
// written; emitTaskEvent is the live frame.
const mockPersistTaskCard: jest.Mock = jest.fn(async () => 'row-answer');
const mockEmitTaskEvent: jest.Mock = jest.fn(() => true);
jest.mock('../chat-agent/task-events', () => ({
  __esModule: true,
  taskCardDisabled: () => process.env.TASK_CARD_DISABLED === '1',
  buildTaskEvent: (p: any) => ({ steps: { done: 0, total: 0 }, receipts: { ok: 0, total: 0 }, spendUsd: 0, artifacts: [], startedAt: 'now', ...p, updatedAt: 'now' }),
  persistTaskCard: (...a: any[]) => mockPersistTaskCard(...a),
  emitTaskEvent: (...a: any[]) => mockEmitTaskEvent(...a),
}));

import { sweepHookEvents } from './hooks.service';
import { HOOK_STATUS_HANDOFF_POSTED, HANDOFF_POSTED_MARKER } from './handoff-parent-wake';

const CHILD = 'c-child-1111';
const PARENT = 'c-parent-2222';

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

const postedSummary = `Coding run completed. Final answer: built the deck.\n\n${HANDOFF_POSTED_MARKER} on chat ${PARENT} (message m-result): deck/deck.pdf. The harness handed them back with download links — acknowledge that message.]`;
const eventRow = (over: any = {}) => ({
  id: 'e1', hookId: 'h1', userId: 'u1', eventType: 'run_completed',
  payload: { eventType: 'run_completed', sourceChatId: CHILD, sourceChatTitle: 'Deck build', summary: postedSummary, depth: 0, runId: 'run-1' },
  status: 'pending', attempts: 0,
  createdAt: new Date(), updatedAt: new Date(),
  ...over,
});

const updatesWith = (pred: (data: any) => boolean) =>
  mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).filter((u: any) => pred(u.data));
const skipRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m.kind === 'handoff_parent_wake_skipped');

const HUMAN_PARENT = { userId: 'u1', archivedAt: null, isSupervisor: false, isProjectSupervisor: false, codingState: null };
let targetChat: any;

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  records.clear();
  delete process.env.TASK_CARD_DISABLED;
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
  mockPrisma.codingSchedule.count.mockResolvedValue(0);
  mockPrisma.projectTodo.count.mockResolvedValue(0);
  targetChat = { ...HUMAN_PARENT };
  mockPrisma.crossModelChat.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(where?.id === PARENT ? targetChat : { id: CHILD, userId: 'u1', title: 'Deck build', projectId: null, archivedAt: null }));
  mockPrisma.crossModelChat.findMany = jest.fn(async () => [{ id: CHILD, userId: 'u1', projectId: null, project: null }]);
  mockPrisma.$queryRaw.mockImplementation(() => mockPrisma.hookEvent.findMany());
  mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
});

describe('hand-off × deliverHookGroup (human plain-chat parent)', () => {
  it('a POSTED run_completed wake for a human plain chat is skipped: rows skipped:handoff_posted, no run, no cap token, hook enabled, gate released, one telemetry row', async () => {
    setPendingRows([eventRow()]);
    await sweepHookEvents();

    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockDailyCapExceeded).not.toHaveBeenCalled();
    expect(HOOK_STATUS_HANDOFF_POSTED).toBe('skipped:handoff_posted');
    expect(updatesWith((d) => d?.status === HOOK_STATUS_HANDOFF_POSTED)[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(0);
    expect(mockPrisma.eventHook.updateMany.mock.calls.some((c: any[]) => c[0]?.data?.enabled === false)).toBe(false);
    expect(mockRedisDel).toHaveBeenCalled(); // debounce gate released
    expect(skipRows()).toEqual([expect.objectContaining({
      sessionId: PARENT, value: 1,
      meta: expect.objectContaining({ hookId: 'h1', childChatId: CHILD, eventTypes: ['run_completed'], runIds: ['run-1'], reason: 'handoff_posted', cardFlipped: 0 }),
    })]);
    expect(mockPersistTaskCard).not.toHaveBeenCalled();
  });

  it('a completion WITHOUT the note is skipped only when the hand-off record exists for its runId; otherwise it delivers (the user must still hear about it)', async () => {
    setPendingRows([eventRow({ payload: { eventType: 'run_completed', sourceChatId: CHILD, summary: 'Coding run completed.', depth: 0, runId: 'run-7' } })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_HANDOFF_POSTED)).toHaveLength(0);

    jest.clearAllMocks();
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockPrisma.$queryRaw.mockImplementation(() => mockPrisma.hookEvent.findMany());
    mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
    mockFireScheduleTarget.mockResolvedValue({ started: true });
    mockDailyCapExceeded.mockResolvedValue(null);
    records.set(`deliverable-handoff/${CHILD}::run-7`, { runId: 'run-7', postedAt: '2026-09-28T05:27:36.000Z', resultMessageId: 'm1' });
    setPendingRows([eventRow({ payload: { eventType: 'run_completed', sourceChatId: CHILD, summary: 'Coding run completed.', depth: 0, runId: 'run-7' } })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === HOOK_STATUS_HANDOFF_POSTED)).toHaveLength(1);
  });

  it('a run_failed wake flips the parent card to FAILED with the cause (preferCarrier) and is skipped; with no card to flip it delivers', async () => {
    setPendingRows([eventRow({ id: 'e2', eventType: 'run_failed', payload: { eventType: 'run_failed', sourceChatId: CHILD, sourceChatTitle: 'Deck build', summary: 'Coding run FAILED: provider returned 502 on every attempt', depth: 0, runId: 'run-2' } })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockPersistTaskCard).toHaveBeenCalledWith(PARENT, expect.objectContaining({
      taskId: `session:${CHILD}`, chatId: PARENT, childChatId: CHILD, kind: 'session', status: 'failed', title: 'Deck build',
      note: expect.stringContaining('provider returned 502'),
    }), { preferCarrier: true });
    expect(mockEmitTaskEvent).toHaveBeenCalledWith(PARENT, expect.objectContaining({ status: 'failed' }));
    expect(updatesWith((d) => d?.status === HOOK_STATUS_HANDOFF_POSTED)).toHaveLength(1);
    expect(skipRows()[0].meta).toMatchObject({ reason: 'failed_card_flipped', cardFlipped: 1, eventTypes: ['run_failed'] });

    jest.clearAllMocks();
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockPrisma.$queryRaw.mockImplementation(() => mockPrisma.hookEvent.findMany());
    mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
    mockFireScheduleTarget.mockResolvedValue({ started: true });
    mockDailyCapExceeded.mockResolvedValue(null);
    mockPersistTaskCard.mockResolvedValue(null); // no carrier row → nothing told the user → the wake delivers
    setPendingRows([eventRow({ id: 'e2', eventType: 'run_failed', payload: { eventType: 'run_failed', sourceChatId: CHILD, summary: 'FAILED', depth: 0, runId: 'run-2' } })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_HANDOFF_POSTED)).toHaveLength(0);
  });

  it('an attention_needed row in the batch (the child needs the user) delivers the whole batch as before', async () => {
    setPendingRows([eventRow(), eventRow({ id: 'e3', eventType: 'attention_needed', payload: { eventType: 'attention_needed', sourceChatId: CHILD, summary: 'ask_user: which logo?', depth: 0 } })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_HANDOFF_POSTED)).toHaveLength(0);
    expect(skipRows()).toHaveLength(0);
  });

  it('a SUPERVISOR parent keeps its wake (that is how it learns a lane finished)', async () => {
    targetChat = { ...HUMAN_PARENT, isProjectSupervisor: true };
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_HANDOFF_POSTED)).toHaveLength(0);
    expect(skipRows()).toHaveLength(0);
  });
});

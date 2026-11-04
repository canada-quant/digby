/**
 * Ticket dd3a19fa (P3) — event-hook CREATOR PROVENANCE + the duplicate-
 * coverage probe. The 2026-09-20 stray-wildcard incident: a derailed
 * machine-triggered run armed an owner-scope WILDCARD hook onto a lane that
 * already had project-scope coverage; the duplicate double-woke and
 * re-derailed the lane twice, and the hook row carried NO creator field, so
 * "who armed this" was unauditable after the fact. These tests pin the fix
 * against the REAL hooks.service (mocked Prisma/Redis/boundaries, the
 * colocated mock-everything discipline of hooks.service.test.ts):
 *
 *   (i)   subscribeHook stamps createdVia/createdByChatId/createdByRunId on
 *         CREATE — on the row, the returned view, and the Activity audit;
 *   (ii)  a pair-dedup REWIRE preserves the row's ORIGINAL creator — the
 *         in-place update never carries the provenance columns;
 *   (iii) the view layer (listHooks) exposes provenance when present and
 *         omits the keys on rows predating the columns;
 *   (iv)  findCoveringHooks — the duplicate-coverage probe behind the tool's
 *         machine-run guard: ENABLED hooks on the target overlapping the
 *         requested eventTypes, EXCLUDING the owner-scope wildcard row (a
 *         wildcard re-subscribe pair-dedups INTO that row — it is not a
 *         second wake source); empty eventTypes short-circuits no-query.
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
    update: jest.fn(),
    delete: jest.fn(async () => ({})),
  },
  hookEvent: {
    create: jest.fn(async () => ({})),
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 1 })),
    count: jest.fn(async () => 0),
  },
  projectTodo: { findUnique: jest.fn() },
  crossModelProject: { findUnique: jest.fn() },
  crossModelChat: { findUnique: jest.fn(), update: jest.fn(async () => ({})) },
  crossModelMessage: { create: jest.fn(async () => ({})) },
  activity: { create: jest.fn(async () => ({})) },
  $queryRaw: jest.fn(),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) },
}));

// error-handler imports config/env, which calls process.exit(1) without env
// vars and kills the jest worker at import time — mock AppError (same shape).
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

jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: jest.fn(async () => ({ started: true })),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
  notifyDailyCapOnce: jest.fn(async () => {}),
  claimCapWindowGate: jest.fn(async () => true),
}));

jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: {
    WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked',
    GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss',
    HOOK_STALE_SUPPRESSED: 'hook_stale_suppressed',
    HOOK_QUIET_EVENT_SHED: 'hook_quiet_event_shed',
  },
}));

import { subscribeHook, listHooks, findCoveringHooks } from './hooks.service';

const USER = 'u1';
const SRC = 'c-src';
const TGT = 'c-tgt';

const hookRow = (over: any = {}) => ({
  id: 'h1', userId: USER, sourceChatId: SRC, targetChatId: TGT, projectId: null,
  eventTypes: ['run_completed'], promptTemplate: '', enabled: true,
  debounceSec: 60, lastFiredAt: null,
  createdAt: new Date('2026-09-20T00:00:00Z'), updatedAt: new Date('2026-09-20T00:00:00Z'),
  ...over,
});

/** The pair is already wired: the pre-create lookup finds `row` and the
 *  in-place update merges the fresh request's values onto it. */
const pairAlreadyWired = (row: any) => {
  mockPrisma.eventHook.findFirst.mockResolvedValue(row);
  mockPrisma.eventHook.update.mockImplementation(({ where, data }: any) =>
    Promise.resolve({ ...row, ...data, id: where.id, updatedAt: new Date('2026-09-20T01:00:00Z') }));
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  // Default: the pair is NOT wired — the pre-create dedup lookup misses.
  mockPrisma.eventHook.findFirst.mockResolvedValue(null);
  mockPrisma.eventHook.create.mockImplementation(({ data }: any) => Promise.resolve({
    id: 'h-new', enabled: true, debounceSec: 60, lastFiredAt: null,
    createdAt: new Date('2026-09-20T00:00:00Z'), updatedAt: new Date('2026-09-20T00:00:00Z'), ...data,
  }));
  mockPrisma.eventHook.update.mockImplementation(({ where, data }: any) =>
    Promise.resolve({ ...hookRow(), ...data, id: where.id, updatedAt: new Date('2026-09-20T01:00:00Z') }));
  mockPrisma.crossModelProject.findUnique.mockResolvedValue({ userId: USER });
});

describe('subscribeHook creator provenance — ticket dd3a19fa', () => {
  it('dd3a19fa (i): provenance is stamped on CREATE — row, returned view, and Activity audit', async () => {
    const r = await subscribeHook({
      userId: USER, sourceChatId: SRC, targetChatId: TGT,
      eventTypes: ['run_completed'], promptTemplate: 'tpl {{summary}}',
      createdVia: 'tool:hook_subscribe', createdByChatId: 'c-lane', createdByRunId: 'r-1',
    });

    expect(mockPrisma.eventHook.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.eventHook.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      createdVia: 'tool:hook_subscribe', createdByChatId: 'c-lane', createdByRunId: 'r-1',
    });
    expect(r).toMatchObject({
      id: 'h-new', createdVia: 'tool:hook_subscribe', createdByChatId: 'c-lane', createdByRunId: 'r-1',
    });
    // Wiring changes are never silent (feedback be89b75d): provenance rides the audit too.
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'hook.subscribe', resource: 'platform',
        metadata: expect.objectContaining({
          hookId: 'h-new', createdVia: 'tool:hook_subscribe', createdByChatId: 'c-lane', createdByRunId: 'r-1',
        }),
      }),
    });
  });

  it('dd3a19fa (i-bis): omitted provenance writes NO provenance keys (legacy/REST callers stay null)', async () => {
    await subscribeHook({ userId: USER, sourceChatId: SRC, targetChatId: TGT, eventTypes: ['run_completed'] });
    const data = mockPrisma.eventHook.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('createdVia');
    expect(data).not.toHaveProperty('createdByChatId');
    expect(data).not.toHaveProperty('createdByRunId');
  });

  it('dd3a19fa (ii): a pair-dedup REWIRE preserves the ORIGINAL creator — the update never carries provenance columns', async () => {
    pairAlreadyWired(hookRow({
      id: 'h-old', createdVia: 'tool:hook_subscribe', createdByChatId: 'c-original', createdByRunId: 'r-orig',
    }));
    const r = await subscribeHook({
      userId: USER, sourceChatId: SRC, targetChatId: TGT,
      eventTypes: ['run_failed'], promptTemplate: 'new tpl',
      createdVia: 'tool:hook_subscribe', createdByChatId: 'c-rewriter', createdByRunId: 'r-new',
    });

    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.update).toHaveBeenCalledTimes(1);
    const updateData = mockPrisma.eventHook.update.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty('createdVia');
    expect(updateData).not.toHaveProperty('createdByChatId');
    expect(updateData).not.toHaveProperty('createdByRunId');
    // The returned view keeps the ORIGINAL creator — the rewire does not
    // launder a stray re-subscribe into looking owner-armed.
    expect(r).toMatchObject({
      id: 'h-old', deduped: true,
      createdVia: 'tool:hook_subscribe', createdByChatId: 'c-original', createdByRunId: 'r-orig',
    });
  });

  it('dd3a19fa (iii): listHooks exposes provenance when present and omits the keys on legacy rows', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hookRow({ id: 'h-prov', createdVia: 'system:fleet-supervisor' }),
      hookRow({ id: 'h-legacy' }),
    ]);
    const rows = await listHooks({ userId: USER });
    expect(rows[0]).toMatchObject({ id: 'h-prov', createdVia: 'system:fleet-supervisor' });
    expect(rows[0]).not.toHaveProperty('createdByChatId');
    expect(rows[1]).not.toHaveProperty('createdVia');
    expect(rows[1]).not.toHaveProperty('createdByChatId');
    expect(rows[1]).not.toHaveProperty('createdByRunId');
  });
});

describe('findCoveringHooks (duplicate-coverage probe) — ticket dd3a19fa', () => {
  it('dd3a19fa (iv): queries ENABLED overlapping hooks on the target, EXCLUDING the owner-scope wildcard row', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hookRow({ id: 'h-proj', sourceChatId: null, projectId: 'p1' }),
    ]);
    const rows = await findCoveringHooks({ userId: USER, targetChatId: TGT, eventTypes: ['run_completed', 'todo_done'] });

    // The owner-scope wildcard (sourceChatId null + projectId null) is
    // excluded explicitly: a wildcard hook_subscribe pair-dedups INTO that
    // row — it is never a second wake source. What remains (project-scope /
    // specific-source hooks) is what a NEW wildcard would double-cover.
    expect(mockPrisma.eventHook.findMany).toHaveBeenCalledWith({
      where: {
        userId: USER, targetChatId: TGT, enabled: true,
        NOT: { sourceChatId: null, projectId: null },
        eventTypes: { hasSome: ['run_completed', 'todo_done'] },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'h-proj', projectId: 'p1' });
  });

  it('dd3a19fa (iv-bis): empty eventTypes short-circuits without a query', async () => {
    await expect(findCoveringHooks({ userId: USER, targetChatId: TGT, eventTypes: [] })).resolves.toEqual([]);
    expect(mockPrisma.eventHook.findMany).not.toHaveBeenCalled();
  });
});

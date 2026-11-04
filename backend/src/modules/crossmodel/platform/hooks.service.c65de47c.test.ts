/**
 * Ticket c65de47c (P1) — (source,target) PAIR DEDUP for event-hook
 * subscriptions: subscribeHook used to create a new EventHook row
 * UNCONDITIONALLY, so the public hook_subscribe tool path could double-wire
 * the same pair — every event then woke the target TWICE (doubled machine
 * runs, doubled budget burn). These tests pin the fix against the REAL
 * hooks.service (mocked Prisma/Redis/boundaries, the colocated
 * mock-everything discipline of hooks.service.test.ts):
 *
 *   (i)   two subscribeHook calls with the same (source,target) pair leave
 *         exactly ONE hook row — the second call returns the SAME hook id,
 *         carries deduped:true, and the row holds the LATEST
 *         eventTypes/promptTemplate/debounceSec (the ticket's regression);
 *   (ii)  a DISABLED pair hook re-subscribed is re-enabled in place, not
 *         duplicated (a fresh subscribe is an affirmative wire request);
 *   (iii) DIFFERENT pairs still create separate rows;
 *   (iv)  the existing WILDCARD dedup behavior is preserved (a wildcard
 *         re-subscribe returns one row) and the pair lookup is lane-aware
 *         (owner-scope wildcard ↔ projectId null never steals a
 *         project-scope hook's row);
 *   (v)   the schema-level backstop: a create losing the
 *         event_hooks_one_hook_per_pair race (P2002) converges on the
 *         winner's row — update-in-place, never a second row.
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
  // subscribeHook's PROJECT-scope lane validates the project exists + is
  // owned by the hook's user (same mock as hooks.service.test.ts).
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

// crossmodel.service's real module pulls the model integrations + DB/env
// chains; hooks.service only needs getChatAccess — mock the boundary.
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

import { subscribeHook, DEFAULT_DEBOUNCE_SEC } from './hooks.service';

const USER = 'u1';
const SRC = 'c-src';
const TGT = 'c-tgt';

const hookRow = (over: any = {}) => ({
  id: 'h1', userId: USER, sourceChatId: SRC, targetChatId: TGT, projectId: null,
  eventTypes: ['run_completed'], promptTemplate: '', enabled: true,
  debounceSec: 60, lastFiredAt: null,
  createdAt: new Date('2026-09-19T00:00:00Z'), updatedAt: new Date('2026-09-19T00:00:00Z'),
  ...over,
});

/** The pair is already wired: the pre-create lookup finds `row` and the
 *  in-place update merges the fresh request's values onto it. */
const pairAlreadyWired = (row: any) => {
  mockPrisma.eventHook.findFirst.mockResolvedValue(row);
  mockPrisma.eventHook.update.mockImplementation(({ where, data }: any) =>
    Promise.resolve({ ...row, ...data, id: where.id, updatedAt: new Date('2026-09-19T01:00:00Z') }));
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  // Default: the pair is NOT wired — the pre-create dedup lookup misses.
  mockPrisma.eventHook.findFirst.mockResolvedValue(null);
  mockPrisma.eventHook.create.mockImplementation(({ data }: any) => Promise.resolve({
    id: 'h-new', enabled: true, debounceSec: 60, lastFiredAt: null,
    createdAt: new Date('2026-09-19T00:00:00Z'), updatedAt: new Date('2026-09-19T00:00:00Z'), ...data,
  }));
  mockPrisma.eventHook.update.mockImplementation(({ where, data }: any) =>
    Promise.resolve({ ...hookRow(), ...data, id: where.id, updatedAt: new Date('2026-09-19T01:00:00Z') }));
  mockPrisma.crossModelProject.findUnique.mockResolvedValue({ userId: USER });
});

describe('subscribeHook (source,target) pair dedup — ticket c65de47c', () => {
  it('c65de47c (i): double-subscribing the same pair leaves ONE row — second call returns the SAME id with the latest values + deduped:true', async () => {
    const first = await subscribeHook({
      userId: USER, sourceChatId: SRC, targetChatId: TGT,
      eventTypes: ['run_completed'], promptTemplate: 'tpl-one {{summary}}', debounceSec: 30,
    });
    expect(first.id).toBe('h-new');
    expect((first as any).deduped).toBeUndefined(); // a fresh create carries no marker

    // The second subscribe sees the row the first one wrote.
    pairAlreadyWired(hookRow({ id: 'h-new', promptTemplate: 'tpl-one {{summary}}', debounceSec: 30 }));
    const second = await subscribeHook({
      userId: USER, sourceChatId: SRC, targetChatId: TGT,
      eventTypes: ['run_failed', 'todo_done'], promptTemplate: 'tpl-two {{summary}}', debounceSec: 120,
    });

    // ONE row only: exactly one create across both calls, then an in-place update.
    expect(mockPrisma.eventHook.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({
      where: { id: 'h-new' },
      data: {
        eventTypes: ['run_failed', 'todo_done'],
        promptTemplate: 'tpl-two {{summary}}',
        debounceSec: 120,
        enabled: true,
      },
    });
    // The pre-create lookup matched the pair EXPLICITLY (no projectId term on
    // a specific pair — projectId requires a wildcard, validated upstream).
    expect(mockPrisma.eventHook.findFirst).toHaveBeenCalledWith({
      where: { userId: USER, sourceChatId: SRC, targetChatId: TGT },
    });
    // SAME hook id, latest values, and the caller can SEE no second row was made.
    expect(second).toMatchObject({
      id: 'h-new', sourceChatId: SRC, targetChatId: TGT,
      eventTypes: ['run_failed', 'todo_done'], promptTemplate: 'tpl-two {{summary}}',
      debounceSec: 120, enabled: true, deduped: true,
    });
    // Wiring changes are never silent (feedback be89b75d): the dedup is audited.
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'hook.subscribe', resource: 'platform',
        metadata: expect.objectContaining({ hookId: 'h-new', deduped: true }),
      }),
    });
  });

  it('c65de47c (ii): a DISABLED pair hook re-subscribed is re-enabled in place, not duplicated', async () => {
    pairAlreadyWired(hookRow({ id: 'h-paused', enabled: false, debounceSec: 300 }));
    const r = await subscribeHook({
      userId: USER, sourceChatId: SRC, targetChatId: TGT, eventTypes: ['run_completed'],
    });

    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
    // enabled:true is written unconditionally — a fresh subscribe re-ARMS the
    // paused hook. An omitted debounceSec resets to the model default,
    // mirroring what a fresh create would have stored.
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({
      where: { id: 'h-paused' },
      data: expect.objectContaining({ enabled: true, debounceSec: DEFAULT_DEBOUNCE_SEC }),
    });
    expect(r).toMatchObject({ id: 'h-paused', enabled: true, deduped: true });
  });

  it('c65de47c (iii): DIFFERENT pairs still create separate rows', async () => {
    let n = 0;
    mockPrisma.eventHook.create.mockImplementation(({ data }: any) => Promise.resolve({
      ...hookRow(), ...data, id: `h-${++n}`,
      createdAt: new Date('2026-09-19T00:00:00Z'), updatedAt: new Date('2026-09-19T00:00:00Z'),
    }));

    const a = await subscribeHook({ userId: USER, sourceChatId: SRC, targetChatId: TGT, eventTypes: ['run_completed'] });
    const b = await subscribeHook({ userId: USER, sourceChatId: 'c-src-2', targetChatId: TGT, eventTypes: ['run_completed'] });
    const c = await subscribeHook({ userId: USER, sourceChatId: SRC, targetChatId: 'c-tgt-2', eventTypes: ['run_completed'] });

    expect(mockPrisma.eventHook.create).toHaveBeenCalledTimes(3);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect((a as any).deduped).toBeUndefined();
    expect((b as any).deduped).toBeUndefined();
    expect((c as any).deduped).toBeUndefined();
  });

  it('c65de47c (iv): a WILDCARD re-subscribe still returns ONE row — lane-aware lookup (projectId null) never steals a project-scope hook', async () => {
    pairAlreadyWired(hookRow({ id: 'h-wild', sourceChatId: null, projectId: null, targetChatId: 'c-sup' }));
    const r = await subscribeHook({
      userId: USER, targetChatId: 'c-sup', eventTypes: ['run_completed', 'todo_done'], debounceSec: 600,
    });

    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
    // The NULL source is matched EXPLICITLY and the owner-scope wildcard lane
    // is pinned by projectId:null — a project-scope hook on the same target
    // (sourceChatId null + projectId set) is a DIFFERENT source set.
    expect(mockPrisma.eventHook.findFirst).toHaveBeenCalledWith({
      where: { userId: USER, sourceChatId: null, targetChatId: 'c-sup', projectId: null },
    });
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({
      where: { id: 'h-wild' },
      data: {
        eventTypes: ['run_completed', 'todo_done'],
        promptTemplate: '',
        debounceSec: 600,
        enabled: true,
      },
    });
    expect(r).toMatchObject({ id: 'h-wild', sourceChatId: null, deduped: true });
  });

  it('c65de47c (iv-bis): a PROJECT-SCOPE re-subscribe looks up its OWN lane (projectId set), not the owner-scope wildcard', async () => {
    pairAlreadyWired(hookRow({ id: 'h-proj', sourceChatId: null, projectId: 'p1', targetChatId: 'c-psup' }));
    const r = await subscribeHook({
      userId: USER, targetChatId: 'c-psup', projectId: 'p1', eventTypes: ['run_completed'],
    });

    expect(mockPrisma.eventHook.findFirst).toHaveBeenCalledWith({
      where: { userId: USER, sourceChatId: null, targetChatId: 'c-psup', projectId: 'p1' },
    });
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
    expect(r).toMatchObject({ id: 'h-proj', sourceChatId: null, projectId: 'p1', deduped: true });
  });

  it('c65de47c (v): P2002 race — a create losing the pair-unique race converges on the winner (update in place, still ONE row)', async () => {
    // Pre-create lookup misses, the create loses the race to a concurrent
    // subscribe (event_hooks_one_hook_per_pair), the re-read finds the winner.
    mockPrisma.eventHook.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(hookRow({ id: 'h-winner' }));
    mockPrisma.eventHook.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed on the fields: (`sourceChatId`,`targetChatId`)'), { code: 'P2002' }),
    );

    const r = await subscribeHook({
      userId: USER, sourceChatId: SRC, targetChatId: TGT,
      eventTypes: ['attention_needed'], promptTemplate: 'race {{summary}}', debounceSec: 45,
    });

    expect(mockPrisma.eventHook.create).toHaveBeenCalledTimes(1); // attempted once, lost
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({
      where: { id: 'h-winner' },
      data: {
        eventTypes: ['attention_needed'],
        promptTemplate: 'race {{summary}}',
        debounceSec: 45,
        enabled: true,
      },
    });
    expect(r).toMatchObject({ id: 'h-winner', deduped: true });
  });

  it('c65de47c (v-bis): a NON-pair unique violation (or a P2002 with no conflicting row) rethrows — only the pair race converges', async () => {
    mockPrisma.eventHook.findFirst.mockResolvedValue(null); // pre-create miss AND post-P2002 re-read miss
    mockPrisma.eventHook.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed on an unexpected index'), { code: 'P2002' }),
    );
    await expect(subscribeHook({ userId: USER, sourceChatId: SRC, targetChatId: TGT, eventTypes: ['run_completed'] }))
      .rejects.toMatchObject({ code: 'P2002' });
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();

    const dbDown = new Error('connection reset'); // no .code — not a P2002
    mockPrisma.eventHook.create.mockRejectedValueOnce(dbDown);
    await expect(subscribeHook({ userId: USER, sourceChatId: SRC, targetChatId: TGT, eventTypes: ['run_completed'] }))
      .rejects.toBe(dbDown);
  });
});

/**
 * Retired-target hook hygiene FOLLOW-UPS — REPLAY test for ticket 9df506cc
 * (2026-09-20). Follow-up from the adversarial review (child session
 * 59c125d1, verdict SAFE-TO-MERGE 0-blocking) of commit ebedcfeb (ticket
 * 57154856). The four findings pinned here:
 *
 * F1 (major): EXEMPTION GAP + NO SELF-HEAL — the retired-target check exempted
 *   only createdVia 'system:*' hooks, but child-result hooks wired BEFORE the
 *   createdVia provenance column existed (pre ticket dd3a19fa) carry createdVia
 *   NULL, so a dormant parent's result hook — exactly the verdict-wait wake
 *   path — could be auto-paused; and ensureChildResultHook never re-enabled a
 *   paused hook, so the pause was permanent and the child's result silently
 *   never delivered. Fix: (a) the child-result template/eventTypes SIGNATURE is
 *   exempt regardless of provenance; (b) ensureChildResultHook re-enables a
 *   paused existing hook idempotently at spawn (the spawn IS proof the parent
 *   is active again).
 * F2 (minor): GC omission — run-reaper.ts HOOK_EVENT_GC_TERMINAL_STATUSES (rule
 *   (g), "the ONLY statuses GC may select") was missing 'skipped:target_retired',
 *   so retired-skip rows accumulated forever.
 * F3 (minor): the per-delivery COUNT on project_todos.assigneeChatId was
 *   unindexed — @@index([assigneeChatId]) + migration
 *   20260920201000_project_todo_assignee_index.
 * F4 (minor): the auto-pause write was a non-CAS update — now conditional
 *   (WHERE enabled=true), and the metric records whether THIS pass flipped
 *   the row (meta.autoPaused).
 *
 * Mock-everything pattern copied from hooks.retired-target.57154856.test.ts.
 */

import fs from 'fs';
import path from 'path';

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

import {
  sweepHookEvents, ensureChildResultHook,
  CHILD_RESULT_EVENT_TYPES, CHILD_RESULT_PROMPT_TEMPLATE,
  HOOK_STATUS_TARGET_RETIRED,
} from './hooks.service';
import logger from '../../../utils/logger';

/** A LEGACY child-result hook row: the 9df506cc F1 shape — createdVia NULL. */
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
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockFireScheduleTarget.mockResolvedValue({ started: true });
  mockDailyCapExceeded.mockResolvedValue(null);
  mockClaimCapWindowGate.mockResolvedValue(true);
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  mockPrisma.eventHook.findFirst.mockResolvedValue(null);
  mockPrisma.eventHook.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.hookEvent.count.mockResolvedValue(0);
  mockPrisma.projectTodo.findUnique.mockResolvedValue({ status: 'pending', assigneeChatId: 'c-tgt' });
  // Retired by default: no enabled schedules, no open todos.
  mockPrisma.chatSchedule.count.mockResolvedValue(0);
  mockPrisma.projectTodo.count.mockResolvedValue(0);
  targetChat = { ...RETIRED_CODING_LANE };
  mockPrisma.crossModelChat.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(
      where?.id === 'c-tgt' ? targetChat
        : where?.id === 'c-src' ? { userId: 'u1' }
        : { userId: 'u1' },
    ));
  mockPrisma.$queryRaw.mockImplementation(() => mockPrisma.hookEvent.findMany());
  mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
});

describe('F1a — legacy child-result hook exemption by SIGNATURE (ticket 9df506cc)', () => {
  it('REPLAY: a createdVia-NULL child-result hook still wakes its dormant parent — exempt despite missing provenance', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({
      sourceChatId: 'c-child',
      eventTypes: [...CHILD_RESULT_EVENT_TYPES],
      promptTemplate: CHILD_RESULT_PROMPT_TEMPLATE,
      createdVia: null, // pre-dd3a19fa row — the F1 gap
    }));
    setPendingRows([eventRow({
      eventType: 'run_completed',
      payload: { eventType: 'run_completed', sourceChatId: 'c-child', sourceChatTitle: 'Reviewer', summary: 'Verdict: REFUTED nothing', depth: 0 },
    })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1); // the verdict is DELIVERED
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(0);
    expect(mockPrisma.eventHook.updateMany.mock.calls.some((c: any[]) => c[0]?.data?.enabled === false)).toBe(false);
    expect(mockPrisma.chatSchedule.count).not.toHaveBeenCalled(); // exempt BEFORE the counts
  });

  it('eventTypes ORDER does not matter — the signature is a set match', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({
      sourceChatId: 'c-child',
      eventTypes: ['attention_needed', 'run_completed', 'run_failed'],
      promptTemplate: CHILD_RESULT_PROMPT_TEMPLATE,
      createdVia: null,
    }));
    setPendingRows([eventRow({
      eventType: 'run_failed',
      payload: { eventType: 'run_failed', sourceChatId: 'c-child', sourceChatTitle: 'Reviewer', summary: 'Run failed', depth: 0 },
    })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(0);
  });

  it('NEGATIVE: a createdVia-NULL hook WITHOUT the child-result signature is still retired-paused (no blanket NULL exemption)', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ createdVia: null })); // plain agent-wired peer hook, NULL provenance
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(1);
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({ where: { id: 'h1', enabled: true }, data: { enabled: false } });
  });

  it('NEGATIVE: the template with a NARROWED event set is not the signature (the spawn-time self-heal covers that variant)', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({
      sourceChatId: 'c-child',
      eventTypes: ['run_completed'], // user-narrowed legacy hook
      promptTemplate: CHILD_RESULT_PROMPT_TEMPLATE,
      createdVia: null,
    }));
    setPendingRows([eventRow({
      eventType: 'run_completed',
      payload: { eventType: 'run_completed', sourceChatId: 'c-child', sourceChatTitle: 'Reviewer', summary: 'done', depth: 0 },
    })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(1);
  });
});

describe('F1b — ensureChildResultHook self-heal re-enable (ticket 9df506cc)', () => {
  const USER = 'u1';
  const PARENT = 'parent-chat-1';
  const CHILD = 'child-chat-1';
  const existingRow = (over: any = {}) => ({
    id: 'h-existing', userId: USER, sourceChatId: CHILD, targetChatId: PARENT,
    eventTypes: [...CHILD_RESULT_EVENT_TYPES], promptTemplate: CHILD_RESULT_PROMPT_TEMPLATE,
    enabled: true, debounceSec: 60, lastFiredAt: null,
    createdAt: new Date('2026-09-02T00:00:00Z'), updatedAt: new Date('2026-09-02T00:00:00Z'),
    ...over,
  });

  it('a PAUSED existing hook is RE-ENABLED in place (idempotent upsert-with-re-enable) — the verdict-wait path heals at spawn', async () => {
    const paused = existingRow({ enabled: false });
    mockPrisma.eventHook.findFirst.mockResolvedValue(paused);
    mockPrisma.eventHook.update.mockImplementation(async () => ({ ...paused, enabled: true }));
    const view = await ensureChildResultHook({ userId: USER, parentChatId: PARENT, childChatId: CHILD });
    expect(view).not.toBeNull();
    expect(view!.enabled).toBe(true);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({ where: { id: 'h-existing' }, data: { enabled: true } });
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled(); // still dedupe — never a second row
    expect(logger.info).toHaveBeenCalled(); // the revive is journaled
  });

  it('an ENABLED existing hook is untouched (no write — the dedupe path is unchanged)', async () => {
    mockPrisma.eventHook.findFirst.mockResolvedValue(existingRow({ enabled: true }));
    const view = await ensureChildResultHook({ userId: USER, parentChatId: PARENT, childChatId: CHILD });
    expect(view!.id).toBe('h-existing');
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
  });
});

describe('F2 — the retired-skip status is GC-eligible (ticket 9df506cc)', () => {
  it("run-reaper rule (g) HOOK_EVENT_GC_TERMINAL_STATUSES selects 'skipped:target_retired' (the ONLY statuses GC may select)", () => {
    const src = fs.readFileSync(path.join(__dirname, '../coding/run-reaper.ts'), 'utf8');
    const m = src.match(/HOOK_EVENT_GC_TERMINAL_STATUSES[^=]*=\s*\[([\s\S]*?)\]/);
    expect(m).toBeTruthy();
    expect(m![1]).toContain("'skipped:target_retired'");
    // and the existing terminal statuses stay selected (no accidental shrink)
    for (const s of ['delivered', 'failed', 'failed:horizon', 'failed:source_gone', 'failed:target_gone', 'skipped:hook_disabled']) {
      expect(m![1]).toContain(`'${s}'`);
    }
  });
});

describe('F3 — project_todos.assigneeChatId is indexed (ticket 9df506cc)', () => {
  it('schema.prisma ProjectTodo carries @@index([assigneeChatId]) and the migration creates it', () => {
    const schema = fs.readFileSync(path.join(__dirname, '../../../../prisma/schema.prisma'), 'utf8');
    const model = schema.match(/model ProjectTodo \{([\s\S]*?)\n\}/);
    expect(model).toBeTruthy();
    expect(model![1]).toContain('@@index([assigneeChatId])');
    const migration = fs.readFileSync(
      path.join(__dirname, '../../../../prisma/migrations/20260920201000_project_todo_assignee_index/migration.sql'),
      'utf8',
    );
    expect(migration).toContain('"project_todos"("assigneeChatId")');
  });
});

describe('F4 — the auto-pause write is CAS (ticket 9df506cc)', () => {
  it('the pause is conditional (WHERE enabled=true) — never a non-CAS write', async () => {
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({ where: { id: 'h1', enabled: true }, data: { enabled: false } });
    expect(mockPrisma.eventHook.update.mock.calls.some((c: any[]) => c[0]?.data?.enabled === false)).toBe(false); // no non-CAS write
  });

  it('an already-paused hook (lost the race) is NOT re-written; its rows are still terminal-marked', async () => {
    mockPrisma.eventHook.updateMany.mockResolvedValue({ count: 0 }); // CAS matched nothing
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({ where: { id: 'h1', enabled: true }, data: { enabled: false } });
    expect(updatesWith((d) => d?.status === HOOK_STATUS_TARGET_RETIRED)).toHaveLength(1); // rows still terminal-marked
  });
});

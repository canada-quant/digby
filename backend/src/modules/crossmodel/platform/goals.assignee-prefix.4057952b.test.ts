/**
 * Ticket 4057952b — todo_create / todo_update assigneeChatId 8-char-prefix
 * resolution (the LAST exact-id-only WRITE path in the goal/todo graph),
 * pinned at the goals.service seam with the service's own stateful-fake-prisma
 * discipline.
 *
 * The 2026-10-09 17:52–17:53Z incident (supervisor session 41bd202a, "Schooltime
 * Supervisor · idle since 17:52"): three consecutive todo_create calls, each
 * assigning a todo to lane b94e3fad-60e6-4fd2-b981-f668c486fea6 by the
 * fleet-standard 8-char prefix its own board and prior-wake ledgers print
 * ("session b94e3fad"), every call failing:
 *
 *   Tool todo_create failed: assigneeChatId: chat not found
 *
 * (verbatim failure class; requireAssignableChat's raw exact findUnique looked
 * up a chat literally id'd "b94e3fad"). The SAME calls carried goalId
 * "a0114487" — ALSO an 8-char prefix — which resolved fine via
 * canonicalGoalId, so the create died on the assignee alone. The model
 * self-corrected by re-issuing with the full id (the todos exist under that
 * goal, created 17:53:55Z, assigneeChatId b94e3fad-60e6-4fd2-b981-f668c486fea6).
 *
 * Pinned behavior:
 *   (i)   verbatim replay — createTodo with assigneeChatId "b94e3fad" (the
 *         8-char prefix of an owner chat) CREATES the todo and stores the
 *         CANONICAL full id, no 400 (the exact incident shape);
 *   (ii)  the cross-user 403 wake-injection guard still fires for a foreign
 *         chat (exact AND resolved-prefix routes);
 *   (iii) an unknown/ambiguous prefix still 400s "assigneeChatId: chat not
 *         found" (error contract unchanged);
 *   (iv)  updateTodo resolves the same way (reassign by prefix → canonical
 *         stored id; null still unassigns);
 *   (v)   a full id passes through untouched (no resolver query on the hit
 *         path);
 *   (vi)  a prefix resolving to a FOREIGN chat is refused (resolver is
 *         owner-scoped, and the guard re-verified on the resolved row);
 *   (vii) the todo_assignee_prefix_resolved metric fires exactly once per
 *         resolved assignment;
 *   (viii) kill switch TODO_ASSIGNEE_PREFIX_DISABLED=1 restores the
 *         exact-only 400.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The stateful fake prisma (reads see earlier writes).
const db: { chats: any[]; goals: any[]; todos: any[]; projects: any[]; members: any[] } = {
  chats: [],
  goals: [],
  todos: [],
  projects: [],
  members: [],
};
const mockPrisma: any = {
  crossModelChat: {
    findUnique: jest.fn(async ({ where }: any) => db.chats.find((c) => c.id === where.id) ?? null),
    findMany: jest.fn(async (args: any = {}) => {
      let rows = db.chats.filter((c) => matchRow(c, args.where));
      if (args.orderBy?.updatedAt) rows = [...rows].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
      if (args.take) rows = rows.slice(0, args.take);
      if (args.select) rows = rows.map((r: any) => pick(r, args.select));
      return rows;
    }),
    update: jest.fn(async () => ({})),
  },
  crossModelProject: { findUnique: jest.fn(async ({ where }: any) => db.projects.find((p) => p.id === where.id) ?? null) },
  projectMember: { findMany: jest.fn(async () => db.members) },
  projectGoal: {
    findUnique: jest.fn(async ({ where, select }: any) => {
      const row = db.goals.find((g) => g.id === where.id) ?? null;
      return row ? pick(row, select) : null;
    }),
    findMany: jest.fn(async (args: any = {}) => {
      let rows = db.goals.filter((g) => matchRow(g, args.where));
      if (args.take) rows = rows.slice(0, args.take);
      if (args.select) rows = rows.map((r: any) => pick(r, args.select));
      return rows;
    }),
    create: jest.fn(),
    update: jest.fn(),
  },
  projectTodo: {
    findUnique: jest.fn(async ({ where, select }: any) => {
      const row = db.todos.find((t) => t.id === where.id) ?? null;
      return row ? pick(row, select) : null;
    }),
    findMany: jest.fn(async (args: any = {}) => {
      let rows = db.todos.filter((t) => matchRow(t, args.where));
      if (args.take) rows = rows.slice(0, args.take);
      if (args.select) rows = rows.map((r: any) => pick(r, args.select));
      return rows;
    }),
    create: jest.fn(async ({ data }: any) => {
      const row = {
        id: 't-' + String(db.todos.length + 1),
        status: 'pending', blockedReason: null, blockKind: null, gateQuestionId: null, blockedAt: null,
        progressNote: null, startedAt: null, evidence: null, doneRunId: null,
        updatedByChatId: null, updatedByRunId: null,
        createdAt: new Date('2026-10-09T17:52:00Z'), updatedAt: new Date('2026-10-09T17:52:00Z'),
        ...data,
      };
      db.todos.push(row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const i = db.todos.findIndex((t) => t.id === where.id);
      if (i === -1) throw new Error('todo not found');
      db.todos[i] = { ...db.todos[i], ...data, updatedAt: new Date('2026-10-09T17:54:00Z') };
      return { ...db.todos[i] };
    }),
    updateMany: jest.fn(),
  },
  todoDependency: { findMany: jest.fn(async () => []), createMany: jest.fn(), deleteMany: jest.fn() },
  goalDependency: { findMany: jest.fn(async () => []), createMany: jest.fn(), deleteMany: jest.fn() },
  ownerQuestion: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  activity: { create: jest.fn(async () => ({})) },
  runToolReceipt: { findFirst: jest.fn(async () => null) },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) },
}));

const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
const mockDailyCapExceeded: jest.Mock = jest.fn(async () => null);
const mockRefundDailyCapToken: jest.Mock = jest.fn(async () => {});
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: (...a: any[]) => mockDailyCapExceeded(...a),
  refundDailyCapToken: (...a: any[]) => mockRefundDailyCapToken(...a),
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

jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));

// Loop metrics: spy the recorder, keep the real kinds table.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

// The dynamic-import hook boundary: goals.service does await import('./hooks.service').
const mockEmitHookEventSafe: jest.Mock = jest.fn(async () => {});
const mockEnqueueDirectWake: jest.Mock = jest.fn(async () => ({ ok: true, hookEventId: 'he-1' }));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
}));

import { createTodo, updateTodo } from './goals.service';
import { LOOP_METRIC_KINDS } from './loop-metrics.service';

// ── fake-db helpers (same shape as goals.service.test.ts) ────────────────────

function pick(row: any, select?: any): any {
  if (!select) return { ...row };
  const out: Record<string, any> = {};
  for (const k of Object.keys(select)) if (k in row) out[k] = row[k];
  return out;
}
function matchRow(row: any, where: any = {}): boolean {
  for (const k of Object.keys(where)) {
    const v: any = where[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('startsWith' in v && !String(row[k] ?? '').startsWith(v.startsWith)) return false;
      if ('endsWith' in v && !String(row[k] ?? '').endsWith(v.endsWith)) return false;
      if ('equals' in v && row[k] !== v.equals) return false;
      if ('in' in v && !(v.in as any[]).includes(row[k])) return false;
      if ('contains' in v && !String(row[k] ?? '').includes(v.contains)) return false;
    } else if (row[k] !== v) return false;
  }
  return true;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const OWNER = 'u-owner';
const OTHER = 'u-other';
const NOW = new Date('2026-10-09T17:52:00Z');

const PROJECT = { id: 'p1', userId: OWNER, name: 'P1', path: '/p1', createdAt: NOW, updatedAt: NOW };

// The incident's chat, verbatim shape: an owner lane the supervisor names by
// its fleet-standard 8-char prefix everywhere ("session b94e3fad").
const LANE_FULL = 'b94e3fad-60e6-4fd2-b981-f668c486fea6';
const LANE_PREFIX = 'b94e3fad';

const GOAL = {
  id: 'a0114487-1111-4222-8333-444455556666',
  userId: OWNER, projectId: 'p1',
  title: 'Schooltime.ai v1 revamp',
  description: '', status: 'active',
  createdAt: NOW, updatedAt: NOW,
};

beforeEach(() => {
  jest.clearAllMocks();
  db.chats = [{ id: LANE_FULL, userId: OWNER, title: 'Revamp lane', updatedAt: NOW, createdAt: NOW }];
  db.goals = [{ ...GOAL }];
  db.todos = [];
  db.projects = [PROJECT];
  db.members = [];
});

// ── (i) verbatim incident replay ─────────────────────────────────────────────

describe('ticket 4057952b — todo assignee 8-char-prefix resolution', () => {
  it('(i) verbatim replay — createTodo with the 8-char prefix "b94e3fad" stores the CANONICAL full id, not a 400', async () => {
    const t = await createTodo({
      userId: OWNER,
      goalId: GOAL.id,
      title: 'User associations: teacher↔student and parent↔student assignment model + UI',
      assigneeChatId: LANE_PREFIX,
    });
    expect(t.assigneeChatId).toBe(LANE_FULL); // canonical id stored
    expect(db.todos[0].assigneeChatId).toBe(LANE_FULL); // the ROW carries it too
    expect(t.status).toBe('pending');
    expect(db.todos.length).toBe(1);
  });

  it('(i-b) the SAME call with the full id behaves identically (no regression on the hit path)', async () => {
    const t = await createTodo({ userId: OWNER, goalId: GOAL.id, title: 'x', assigneeChatId: LANE_FULL });
    expect(t.assigneeChatId).toBe(LANE_FULL);
  });

  it('(ii) the cross-user 403 wake-injection guard still fires on an EXACT foreign chat id', async () => {
    db.chats.push({ id: 'c-foreign-exact', userId: OTHER, title: 'foreign', updatedAt: NOW, createdAt: NOW });
    await expect(
      createTodo({ userId: OWNER, goalId: GOAL.id, title: 'x', assigneeChatId: 'c-foreign-exact' }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('(iii) an unknown assignee chat still 400s with the exact contract', async () => {
    await expect(
      createTodo({ userId: OWNER, goalId: GOAL.id, title: 'x', assigneeChatId: 'deadbeef' }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'assigneeChatId: chat not found' });
    expect(db.todos.length).toBe(0);
  });

  it('(iii-b) an AMBIGUOUS prefix (two owner chats share it) keeps the 400 — never a silent wrong assignment', async () => {
    db.chats.push({ id: 'b94e3fad-9999-4999-8999-999999999999', userId: OWNER, title: 'other lane', updatedAt: NOW, createdAt: NOW });
    await expect(
      createTodo({ userId: OWNER, goalId: GOAL.id, title: 'x', assigneeChatId: LANE_PREFIX }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'assigneeChatId: chat not found' });
  });

  it('(iv) updateTodo reassigns by prefix → canonical stored id; null unassigns', async () => {
    const t = await createTodo({ userId: OWNER, goalId: GOAL.id, title: 'x' });
    const r = await updateTodo({ userId: OWNER, todoId: t.id, assigneeChatId: LANE_PREFIX });
    expect(r.assigneeChatId).toBe(LANE_FULL);
    expect(db.todos[0].assigneeChatId).toBe(LANE_FULL);
    const r2 = await updateTodo({ userId: OWNER, todoId: t.id, assigneeChatId: null });
    expect(r2.assigneeChatId).toBeNull();
    expect(db.todos[0].assigneeChatId).toBeNull();
  });

  it('(iv-b) updateTodo still rejects a foreign assignee with 403', async () => {
    const t = await createTodo({ userId: OWNER, goalId: GOAL.id, title: 'x' });
    db.chats.push({ id: 'c-foreign-2', userId: OTHER, title: 'foreign', updatedAt: NOW, createdAt: NOW });
    await expect(
      updateTodo({ userId: OWNER, todoId: t.id, assigneeChatId: 'c-foreign-2' }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('(v) the resolver is owner-scoped: a prefix matching only a FOREIGN chat does not resolve to it', async () => {
    db.chats = [{ id: 'b94e3fad-60e6-4fd2-b981-f668c486fea6', userId: OTHER, title: 'foreign lane', updatedAt: NOW, createdAt: NOW }];
    await expect(
      createTodo({ userId: OWNER, goalId: GOAL.id, title: 'x', assigneeChatId: LANE_PREFIX }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'assigneeChatId: chat not found' });
  });

  it('(vii) the todo_assignee_prefix_resolved metric fires exactly once per resolved assignment (create + update)', async () => {
    // Counted by KIND: a create also writes a todo_transition row (2026-10-20 telemetry).
    const prefixRows = () => mockRecordLoopMetric.mock.calls.filter((c: any[]) => c[0]?.kind === LOOP_METRIC_KINDS.TODO_ASSIGNEE_PREFIX_RESOLVED);
    mockRecordLoopMetric.mockClear();
    await createTodo({ userId: OWNER, goalId: GOAL.id, title: 'x', assigneeChatId: LANE_PREFIX });
    await createTodo({ userId: OWNER, goalId: GOAL.id, title: 'y', assigneeChatId: LANE_FULL }); // full id — no metric
    expect(prefixRows()).toHaveLength(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: LOOP_METRIC_KINDS.TODO_ASSIGNEE_PREFIX_RESOLVED,
      meta: expect.objectContaining({ from: LANE_PREFIX, to: LANE_FULL.slice(0, 8) }),
    }));
    mockRecordLoopMetric.mockClear();
    const t = db.todos[0];
    await updateTodo({ userId: OWNER, todoId: t.id, assigneeChatId: null }); // unassign — no metric
    expect(prefixRows()).toHaveLength(0);
    await updateTodo({ userId: OWNER, todoId: t.id, assigneeChatId: LANE_PREFIX }); // reassign by prefix — one metric
    expect(prefixRows()).toHaveLength(1);
  });

  it('(viii) kill switch TODO_ASSIGNEE_PREFIX_DISABLED=1 restores the exact-only 400', async () => {
    process.env.TODO_ASSIGNEE_PREFIX_DISABLED = '1';
    try {
      await expect(
        createTodo({ userId: OWNER, goalId: GOAL.id, title: 'x', assigneeChatId: LANE_PREFIX }),
      ).rejects.toMatchObject({ statusCode: 400, message: 'assigneeChatId: chat not found' });
    } finally {
      delete process.env.TODO_ASSIGNEE_PREFIX_DISABLED;
    }
  });

  it('(ix) e580b601 contract preserved: stringified-null ids still mean "not provided" at the SERVICE boundary (unassigned create)', async () => {
    // The tool seam (normalizeOptionalId) drops "null"/"undefined"/"" before
    // the service sees them; the service itself treats an empty string as
    // absent (opts.assigneeChatId falsy → unassigned), pinned here so the
    // resolver never resurrects the 400 for that artifact class.
    const t = await createTodo({ userId: OWNER, goalId: GOAL.id, title: 'x', assigneeChatId: '' } as any);
    expect(t.assigneeChatId).toBeNull();
  });
});

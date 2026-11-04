/**
 * REPLAY PIN — tickets 0633adb5 (mishap, breaker trip 2026-09-11, session
 * c0e22e36 "Fleet Supervisor") and 7954a3e7 (bug_report, same session/wake).
 *
 * The mishap (verbatim failure texts, newest first):
 *   · Tool todo_get failed: Todo not found
 *   · Tool todo_get failed: Todo not found
 *   · Tool todo_get failed: Todo not found
 *
 * 7954a3e7's repro claimed goal_list/todo_list RETURNED goal
 * 13761906-51b9-4446-9945-02e4d4704938 and todos b8cfd55e-2420-4c03-a2b5-
 * e6a5df5f7403 / 8b90ed2c-031e-4d15-a1ba-b31e51eb06bd / 0c2fbb0c-9690-4396-
 * a70b-536402a545f6, and that every by-id endpoint then 404'd them.
 *
 * ADJUDICATION (dispatch lane, 2026-09-11): MODEL behavior — a phantom list
 * premise — not a framework bug. Evidence: (1) the same by-id calls on those
 * exact ids 404 for EVERY actor (the dispatch lane reproduced from a coding
 * session), i.e. the rows never existed; (2) goal 8f388289's inline todo set
 * can only grow (there is no todo delete), yet the reporter's "goal_list
 * inline" row 8b90ed2c under it is in no current or historical listing;
 * (3) real ids returned by the same list endpoints resolve fine via
 * todo_get (full AND 8-char prefix), todo_list(goalId), and get_feedback in
 * the same window. The by-id endpoints were CORRECT to refuse.
 *
 * These tests pin that adjudication against the verbatim ids: never-existent
 * ids (full-uuid AND 8-char prefix) 404 on read AND write/list paths, while
 * real rows resolve — so any future stale-worktree echo of this class is
 * adjudicated by replaying the ticket's ids through this file (the 8e7db913
 * cascade pattern). Mock harness copied from goals.service.test.ts.
 *
 * ⚠ TEXTS UPDATED (2026-09-13, ticket 7ae1f4c4): the no-hint 404 message was
 * the bare legacy 'Todo not found'/'Goal not found' when this suite was
 * written — byte-identical across different probed ids, so auto-filed breaker
 * tickets could not show WHICH ids failed. The messages are now
 * self-describing (they echo the received id + the list-tool recovery path);
 * the pins below carry the new verbatim texts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn(), findMany: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  projectMember: { findMany: jest.fn() },
  projectGoal: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  projectTodo: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  goalDependency: { findMany: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
  todoDependency: { findMany: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
  activity: { create: jest.fn(async () => ({})) },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: (...a: any[]) => mockRedisSet(...a), del: (...a: any[]) => mockRedisDel(...a) },
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

const mockEmitHookEventSafe: jest.Mock = jest.fn(async () => {});
const mockEnqueueDirectWake: jest.Mock = jest.fn(async () => ({ ok: true, hookEventId: 'he-1' }));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
}));

import { getTodo, updateTodo, listTodos } from './goals.service';

// ── Fixtures + stateful fake DB (same pattern as goals.service.test.ts) ─────

const OWNER = 'u-owner';
const NOW = new Date('2026-08-03T00:00:00Z');

const PROJECT = { id: 'p1', userId: OWNER, name: 'P1', path: '/p1', members: [] as any[] };

const goalRow = (over: any = {}) => ({
  id: 'g1', userId: OWNER, projectId: 'p1', title: 'Goal 1', description: '',
  status: 'active', blockedReason: null, createdByChatId: null,
  createdAt: NOW, updatedAt: NOW, ...over,
});
const todoRow = (over: any = {}) => ({
  id: 't1', userId: OWNER, goalId: 'g1', projectId: 'p1', title: 'Todo 1',
  status: 'pending', blockedReason: null, assigneeChatId: null,
  createdAt: NOW, updatedAt: NOW, ...over,
});

let db: { projects: any[]; goals: any[]; todos: any[]; goalDeps: any[]; todoDeps: any[] };

function resetDb() {
  db = { projects: [{ ...PROJECT }], goals: [], todos: [], goalDeps: [], todoDeps: [] };
}

function pick(row: any, select: any) {
  if (!select) return row;
  const out: any = {};
  for (const k of Object.keys(select)) if (select[k] === true) out[k] = row[k];
  return out;
}

function matchRow(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v === undefined) return true;
    if (k === 'goal') return db.goals.some((g) => g.id === row.goalId && g.userId === v.userId);
    if (k === 'todo') return db.todos.some((t) => t.id === row.todoId && t.userId === v.userId);
    if (k === 'OR') return (v as any[]).some((clause) => matchRow(row, clause));
    if (v === null) return row[k] == null;
    if (v && typeof v === 'object' && 'startsWith' in v) return String(row[k] ?? '').startsWith(v.startsWith);
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    return row[k] === v;
  });
}

function wireFake() {
  mockPrisma.crossModelProject.findUnique.mockImplementation(async ({ where }: any) =>
    db.projects.find((p) => p.id === where.id) ?? null);
  mockPrisma.crossModelProject.findMany.mockImplementation(async (args: any = {}) =>
    db.projects.filter((p) => matchRow(p, args.where)));
  mockPrisma.projectMember.findMany.mockImplementation(async () => []);
  mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) =>
    ({ id: where.id, userId: OWNER }));
  mockPrisma.projectGoal.findUnique.mockImplementation(async ({ where, select }: any) => {
    const row = db.goals.find((g) => g.id === where.id) ?? null;
    return row ? pick(row, select) : null;
  });
  mockPrisma.projectGoal.findMany.mockImplementation(async (args: any = {}) => {
    let rows = db.goals.filter((g) => matchRow(g, args.where));
    if (args.orderBy?.createdAt) rows = [...rows].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (args.take) rows = rows.slice(0, args.take);
    if (args.select) rows = rows.map((r) => pick(r, args.select));
    return rows;
  });
  mockPrisma.projectTodo.findUnique.mockImplementation(async ({ where, select }: any) => {
    const row = db.todos.find((t) => t.id === where.id) ?? null;
    return row ? pick(row, select) : null;
  });
  mockPrisma.projectTodo.findMany.mockImplementation(async (args: any = {}) => {
    let rows = db.todos.filter((t) => matchRow(t, args.where));
    if (args.take) rows = rows.slice(0, args.take);
    if (args.select) rows = rows.map((r) => pick(r, args.select));
    return rows;
  });
  mockPrisma.goalDependency.findMany.mockImplementation(async (args: any = {}) =>
    db.goalDeps.filter((d) => matchRow(d, args.where)));
  mockPrisma.todoDependency.findMany.mockImplementation(async (args: any = {}) =>
    db.todoDeps.filter((d) => matchRow(d, args.where)));
}

beforeEach(() => {
  jest.clearAllMocks();
  resetDb();
  wireFake();
});

// ── The ticket's verbatim ids — none of these rows ever existed ─────────────

/** 7954a3e7's claimed goal_list/todo_list rows (phantom premise). */
const PHANTOM_GOAL = '13761906-51b9-4446-9945-02e4d4704938';
const PHANTOM_TODOS = [
  'b8cfd55e-2420-4c03-a2b5-e6a5df5f7403', // repro steps 2, 3, 7
  '8b90ed2c-031e-4d15-a1ba-b31e51eb06bd', // repro step 5 ("under ACTIVE goal 8f388289")
  '0c2fbb0c-9690-4396-a70b-536402a545f6', // repro step 6 ("first row of account-wide todo_list")
] as const;

// The 7ae1f4c4 self-describing no-hint messages (must mirror goals.service.ts).
const bareTodo404 = (id: string) =>
  `Todo not found: "${id}" — no todo with that id is visible to you. Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh todo_list first`;
const bareGoal404 = (id: string) =>
  `Goal not found: "${id}" — no goal with that id is visible to you. Re-call with the EXACT id copied verbatim from goal_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh goal_list first`;

describe('todo_get on never-existent ids reproduces the 0633adb5 breaker texts EXACTLY', () => {
  it.each(PHANTOM_TODOS)('full-uuid %s → bare legacy 404 (no hint: no same-prefix row exists)', async (id) => {
    await expect(getTodo({ userId: OWNER, todoId: id })).rejects.toMatchObject({
      statusCode: 404,
      message: bareTodo404(id),
    });
  });

  it.each(['b8cfd55e', '0c2fbb0c'])('8-char prefix form "%s" → the same bare 404 (7954a3e7 repro step 7)', async (prefix) => {
    await expect(getTodo({ userId: OWNER, todoId: prefix })).rejects.toMatchObject({
      statusCode: 404,
      message: bareTodo404(prefix),
    });
  });

  it('the harness failure envelope over this 404 echoes the probed id (7ae1f4c4: breaker tickets are self-diagnosing)', async () => {
    const err: any = await getTodo({ userId: OWNER, todoId: PHANTOM_TODOS[0] }).catch((e: any) => e);
    // platform-tools wraps service errors as `Tool <name> failed: <message>` —
    // pre-7ae1f4c4 this was byte-identical for every id; it now names the id.
    expect(`Tool todo_get failed: ${err.message}`).toBe(`Tool todo_get failed: ${bareTodo404(PHANTOM_TODOS[0])}`);
  });
});

describe('the write/list by-id paths refuse the same phantoms (7954a3e7 repro steps 2 and 4)', () => {
  it('todo_update on the phantom full uuid → 404 Todo not found (write path keeps exact-id semantics, 8579d419 B1)', async () => {
    await expect(updateTodo({ userId: OWNER, todoId: PHANTOM_TODOS[0], status: 'done' })).rejects.toMatchObject({
      statusCode: 404,
      message: bareTodo404(PHANTOM_TODOS[0]),
    });
  });

  it('todo_list(goalId=<phantom goal>) → 404 Goal not found', async () => {
    await expect(listTodos({ userId: OWNER, goalId: PHANTOM_GOAL })).rejects.toMatchObject({
      statusCode: 404,
      message: bareGoal404(PHANTOM_GOAL),
    });
  });
});

describe('positive control — the by-id path resolves REAL rows in the same code', () => {
  const REAL_GOAL = 'a1b2c3d4-1111-4111-8111-a1b2c3d4e5f6';
  const REAL_TODO = 'e5f6a7b8-2222-4222-8222-e5f6a7b8c9d0';

  beforeEach(() => {
    db.goals.push(goalRow({ id: REAL_GOAL }));
    db.todos.push(todoRow({ id: REAL_TODO, goalId: REAL_GOAL }));
  });

  it('todo_get resolves a real full uuid', async () => {
    const t = await getTodo({ userId: OWNER, todoId: REAL_TODO });
    expect(t).toMatchObject({ id: REAL_TODO, goalId: REAL_GOAL });
  });

  it('todo_get resolves a real unique 8-char prefix (8579d419)', async () => {
    const t = await getTodo({ userId: OWNER, todoId: 'e5f6a7b8' });
    expect(t).toMatchObject({ id: REAL_TODO });
  });

  it('todo_list(goalId) lists the real goal\'s todos', async () => {
    const rows = await listTodos({ userId: OWNER, goalId: REAL_GOAL });
    expect(rows.map((r: any) => r.id)).toContain(REAL_TODO);
  });

  it('and with a real row present, the phantom prefix STILL bare-404s (no false "did you mean" across prefixes)', async () => {
    await expect(getTodo({ userId: OWNER, todoId: 'b8cfd55e' })).rejects.toMatchObject({
      statusCode: 404,
      message: bareTodo404('b8cfd55e'),
    });
  });
});

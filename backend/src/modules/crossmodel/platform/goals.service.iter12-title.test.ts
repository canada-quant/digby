/**
 * Operator iteration 12 (2026-09-25) — todo_get / goal_get resolve a UNIQUE
 * exact TITLE (case-insensitive, trimmed) among the caller's visible rows.
 * Incident class: 6 todo_get failures in 48 h where the "id" was the row's
 * title copied from a board digest ("Mobile M1 — push: Expo Push + …", "Phase
 * 1 — researched plan doc: …"). Read paths only; ambiguity and invisibility
 * fall through to the unchanged exact-id 404; write paths keep exact-id
 * semantics. Harness copied from goals.service.0633adb5.test.ts.
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

import { getTodo, getGoal, updateTodo } from './goals.service';

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
    if (v && typeof v === 'object' && 'equals' in v) {
      const a = String(row[k] ?? ''); const b = String(v.equals ?? '');
      return v.mode === 'insensitive' ? a.toLowerCase() === b.toLowerCase() : a === b;
    }
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

const TITLE = 'Mobile M1 — push: Expo Push + backend APNs(.p8)/FCM(HTTP v1) module + push_tokens registration';
const T_ID = '7c1f0b2e-1d2e-4a3b-9c4d-5e6f7a8b9c0d';
const bareTodo404 = (id: string) =>
  `Todo not found: "${id}" — no todo with that id is visible to you. Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh todo_list first`;

describe('todo_get / goal_get by unique exact title (operator iteration 12)', () => {
  beforeEach(() => {
    db.goals.push(goalRow({ id: 'g1', title: 'Client platforms phase 2 — Windows client' }));
    db.todos.push(todoRow({ id: T_ID, title: TITLE }));
  });

  it('the verbatim title resolves to the row (the incident call)', async () => {
    const t = await getTodo({ userId: OWNER, todoId: TITLE });
    expect(t.id).toBe(T_ID);
  });

  it('case-insensitive and trimmed', async () => {
    const t = await getTodo({ userId: OWNER, todoId: `  ${TITLE.toUpperCase()} ` });
    expect(t.id).toBe(T_ID);
  });

  it('goal_get resolves a unique goal title too', async () => {
    const g = await getGoal({ userId: OWNER, goalId: 'client platforms phase 2 — windows client' });
    expect(g.id).toBe('g1');
  });

  it('an AMBIGUOUS title (two visible rows) falls through to the exact-id 404', async () => {
    db.todos.push(todoRow({ id: '8d2f0b2e-1d2e-4a3b-9c4d-5e6f7a8b9c0e', title: TITLE }));
    await expect(getTodo({ userId: OWNER, todoId: TITLE })).rejects.toMatchObject({ statusCode: 404, message: bareTodo404(TITLE) });
  });

  it('a title in a project the caller cannot see falls through to the exact-id 404 (no disclosure)', async () => {
    db.projects.push({ id: 'p2', userId: 'u-other', name: 'P2', path: '/p2', members: [] });
    db.todos[0].projectId = 'p2';
    await expect(getTodo({ userId: OWNER, todoId: TITLE })).rejects.toMatchObject({ statusCode: 404, message: bareTodo404(TITLE) });
  });

  it('a uuid-shaped input with a UNIQUE visible same-prefix row resolves via the full-shape ladder (99ad288e + 636b622b) and never queries by title; a uuid whose prefix matches nothing still 404s, no title query', async () => {
    mockPrisma.projectTodo.findMany.mockClear();
    // Same 8-char prefix as the fixture todo → tier-2 heal, and the title path
    // is NEVER consulted for a uuid-shaped input.
    const t = await getTodo({ userId: OWNER, todoId: '7c1f0b2e-ffff-4a3b-9c4d-5e6f7a8b9c0d' });
    expect(t.id).toBe('7c1f0b2e-1d2e-4a3b-9c4d-5e6f7a8b9c0d');
    const titleQueries = mockPrisma.projectTodo.findMany.mock.calls.filter((c: any[]) => c[0]?.where?.title);
    expect(titleQueries).toHaveLength(0);
    // No same-prefix row anywhere → the exact-id 404 stands (14c64064 class).
    await expect(getTodo({ userId: OWNER, todoId: '8d2f0b2e-ffff-4a3b-9c4d-5e6f7a8b9c0d' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('WRITE paths keep exact-id semantics — todo_update by title still 404s', async () => {
    await expect(updateTodo({ userId: OWNER, todoId: TITLE, status: 'done' } as any)).rejects.toMatchObject({ statusCode: 404 });
  });
});

/**
 * REPLAY PIN — ticket 8f62542c (mishap, breaker trip 2026-09-29, session
 * cbce1e78 "glm53-flash-w4a16-fp8-mtp Supervisor").
 *
 * Verbatim failure texts (newest first, 3×):
 *   · Tool todo_update failed: Dependency todo not found: e32f1697
 *   · Tool todo_update failed: Dependency todo not found: 689bdc33
 *   · Tool todo_update failed: Dependency todo not found: 121df365
 *
 * ROOT CAUSE (dispatch lane, 2026-09-29): callers passed the fleet's 8-char
 * prefix idiom in dependsOnTodoIds / dependsOnGoalIds — every OTHER id-taking
 * fleet tool accepts it — but the dependency loaders
 * (loadSameOwnerDepGoals / loadSameOwnerDepTodos) did raw-exact `in` lookups,
 * so a valid prefix of a REAL row 404'd as "Dependency todo not found:
 * <prefix>". Fix (this suite's subject): canonicalizeDepIds runs every dep id
 * through the SAME resolver as every other id-taking site
 * (canonicalGoalId / canonicalTodoId — unique caller-visible prefix, same
 * getProjectAccess gate) BEFORE the loaders validate, then re-dedupes (two
 * prefixes of one full id collapse to one edge) and re-runs the
 * self-reference check (a prefix resolving to the row ITSELF keeps the 400
 * self-dependency class, not a later 409 cycle). An id that resolves to
 * NOTHING passes through UNCHANGED so the loader's 404 still echoes the RAW
 * input — same error class, message and status as before.
 *
 * Harness pattern copied from goals.suffix-heal.99ad288e-636b622b.test.ts
 * (itself copied from goals.service.test.ts: stateful fake Prisma — reads see
 * earlier writes).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn(), findMany: jest.fn() },
  crossModelChat: { findUnique: jest.fn(), findFirst: jest.fn(async () => null) },
  projectMember: { findMany: jest.fn() },
  projectGoal: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  projectTodo: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  goalDependency: { findMany: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
  todoDependency: { findMany: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
  ownerQuestion: { findFirst: jest.fn(), findMany: jest.fn() },
  activity: { create: jest.fn(async () => ({})) },
  runToolReceipt: { findFirst: jest.fn(async () => null) },
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

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

const mockEmitHookEventSafe: jest.Mock = jest.fn(async () => {});
const mockEnqueueDirectWake: jest.Mock = jest.fn(async () => ({ ok: true, hookEventId: 'he-1' }));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
}));

import { createGoal, updateGoal, createTodo, updateTodo } from './goals.service';

// ── Fixtures + stateful fake DB ──────────────────────────────────────────────

const OWNER = 'u-owner';
const VIEWER = 'u-viewer';
const NOW = new Date('2026-09-29T00:00:00Z');

const PROJECT = {
  id: 'p1', userId: OWNER, name: 'P1', path: '/p1',
  members: [{ userId: VIEWER, role: 'viewer' }],
};

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

let db: { projects: any[]; goals: any[]; todos: any[]; goalDeps: any[]; todoDeps: any[]; ownerQuestions: any[] };

function resetDb() {
  db = {
    projects: [{ ...PROJECT, members: PROJECT.members.map((m) => ({ ...m })) }],
    goals: [], todos: [], goalDeps: [], todoDeps: [], ownerQuestions: [],
  };
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
    if (v && typeof v === 'object' && 'contains' in v) return String(row[k] ?? '').includes(v.contains);
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
  mockPrisma.ownerQuestion.findFirst.mockImplementation(async ({ where, select }: any) => {
    const row = db.ownerQuestions.find((q) => matchRow(q, where)) ?? null;
    return row ? pick(row, select) : null;
  });
  mockPrisma.ownerQuestion.findMany.mockImplementation(async (args: any = {}) => {
    let rows = db.ownerQuestions.filter((q) => matchRow(q, args.where));
    if (args.take) rows = rows.slice(0, args.take);
    if (args.select) rows = rows.map((r: any) => pick(r, args.select));
    return rows;
  });
  mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) =>
    ({ id: where.id, userId: OWNER }));

  mockPrisma.projectGoal.findUnique.mockImplementation(async ({ where, select }: any) => {
    const row = db.goals.find((g) => g.id === where.id) ?? null;
    return row ? pick(row, select) : null;
  });
  mockPrisma.projectGoal.findMany.mockImplementation(async (args: any = {}) => {
    let rows = db.goals.filter((g) => matchRow(g, args.where));
    if (args.take) rows = rows.slice(0, args.take);
    if (args.select) rows = rows.map((r: any) => pick(r, args.select));
    return rows;
  });
  mockPrisma.projectGoal.create.mockImplementation(async ({ data }: any) => {
    const row = { description: '', status: 'active', blockedReason: null, createdByChatId: null, createdAt: NOW, updatedAt: NOW, ...data };
    db.goals.push(row);
    return { ...row };
  });
  mockPrisma.projectGoal.update.mockImplementation(async ({ where, data }: any) => {
    const row = db.goals.find((g) => g.id === where.id);
    if (!row) throw new Error(`goal ${where.id} not found`);
    Object.assign(row, data);
    return { ...row };
  });
  mockPrisma.projectGoal.updateMany.mockImplementation(async ({ where, data }: any) => {
    const rows = db.goals.filter((g) => matchRow(g, where));
    for (const r of rows) Object.assign(r, data);
    return { count: rows.length };
  });

  mockPrisma.projectTodo.findUnique.mockImplementation(async ({ where, select }: any) => {
    const row = db.todos.find((t) => t.id === where.id) ?? null;
    return row ? pick(row, select) : null;
  });
  mockPrisma.projectTodo.findMany.mockImplementation(async (args: any = {}) => {
    let rows = db.todos.filter((t) => matchRow(t, args.where));
    if (args.take) rows = rows.slice(0, args.take);
    if (args.select) rows = rows.map((r: any) => pick(r, args.select));
    return rows;
  });
  mockPrisma.projectTodo.create.mockImplementation(async ({ data }: any) => {
    const row = { status: 'pending', blockedReason: null, assigneeChatId: null, createdAt: NOW, updatedAt: NOW, ...data };
    db.todos.push(row);
    return { ...row };
  });
  mockPrisma.projectTodo.update.mockImplementation(async ({ where, data }: any) => {
    const row = db.todos.find((t) => t.id === where.id);
    if (!row) throw new Error(`todo ${where.id} not found`);
    Object.assign(row, data);
    return { ...row };
  });
  mockPrisma.projectTodo.updateMany.mockImplementation(async ({ where, data }: any) => {
    const rows = db.todos.filter((t) => matchRow(t, where));
    for (const r of rows) Object.assign(r, data);
    return { count: rows.length };
  });

  mockPrisma.goalDependency.findMany.mockImplementation(async (args: any = {}) =>
    db.goalDeps.filter((d) => matchRow(d, args.where)));
  mockPrisma.goalDependency.createMany.mockImplementation(async ({ data }: any) => {
    for (const d of data) db.goalDeps.push({ ...d });
    return { count: data.length };
  });
  mockPrisma.goalDependency.deleteMany.mockImplementation(async ({ where }: any) => {
    const before = db.goalDeps.length;
    db.goalDeps = db.goalDeps.filter((d) => !matchRow(d, where));
    return { count: before - db.goalDeps.length };
  });
  mockPrisma.todoDependency.findMany.mockImplementation(async (args: any = {}) =>
    db.todoDeps.filter((d) => matchRow(d, args.where)));
  mockPrisma.todoDependency.createMany.mockImplementation(async ({ data }: any) => {
    for (const d of data) db.todoDeps.push({ ...d });
    return { count: data.length };
  });
  mockPrisma.todoDependency.deleteMany.mockImplementation(async ({ where }: any) => {
    const before = db.todoDeps.length;
    db.todoDeps = db.todoDeps.filter((d) => !matchRow(d, where));
    return { count: before - db.todoDeps.length };
  });
}

// The three verbatim incident prefixes (ticket 8f62542c, session cbce1e78):
// real full ids sharing those 8-char prefixes.
const INCIDENT_PREFIXES = [
  { prefix: 'e32f1697', real: 'e32f1697-96fb-4e8a-8922-3b4941d2292c', title: 'Dep todo E' },
  { prefix: '689bdc33', real: '689bdc33-c3f8-487e-8267-767e56543150', title: 'Dep todo B' },
  { prefix: '121df365', real: '121df365-9f5a-4e7b-92a1-5f0e6a7b8c9d', title: 'Dep todo C' },
];

beforeEach(() => {
  jest.clearAllMocks();
  resetDb();
  wireFake();
});

// ── REPLAY: the incident tool (todo_update) with the verbatim prefixes ───────

describe('REPLAY 8f62542c — todo_update dependsOnTodoIds with truncated 8-char prefixes', () => {
  it.each(INCIDENT_PREFIXES)('prefix "$prefix" of a REAL dep todo resolves + persists the FULL-id edge (the 3× streak class dies here)', async ({ prefix, real, title }) => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Target todo' }));
    db.todos.push(todoRow({ id: real, title }));
    // THE INCIDENT CALL: todo_update(todoId, dependsOnTodoIds: [<8-char prefix>])
    // pre-fix this 404'd "Dependency todo not found: <prefix>" three times.
    const out = await updateTodo({
      userId: OWNER,
      todoId: 'aaaaaaaa-0000-4000-8000-000000000001',
      dependsOnTodoIds: [prefix],
    });
    expect(out.id).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    const edges = db.todoDeps.filter((d) => d.todoId === 'aaaaaaaa-0000-4000-8000-000000000001');
    expect(edges.map((e) => e.dependsOnTodoId)).toEqual([real]);
  });

  it('a bogus id still fails with the SAME error class/message (raw input echoed, 404)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Target todo' }));
    await expect(
      updateTodo({
        userId: OWNER,
        todoId: 'aaaaaaaa-0000-4000-8000-000000000001',
        dependsOnTodoIds: ['deadbee1'],
      }),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Dependency todo not found: deadbee1' });
  });

  it('two prefixes of the SAME full id collapse to ONE edge (re-dedupe)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Target todo' }));
    db.todos.push(todoRow({ id: 'e32f1697-96fb-4e8a-8922-3b4941d2292c', title: 'Dep todo E' }));
    await updateTodo({
      userId: OWNER,
      todoId: 'aaaaaaaa-0000-4000-8000-000000000001',
      // 8-char prefix AND the full id — same row, one edge.
      dependsOnTodoIds: ['e32f1697', 'e32f1697-96fb-4e8a-8922-3b4941d2292c'],
    });
    const edges = db.todoDeps.filter((d) => d.todoId === 'aaaaaaaa-0000-4000-8000-000000000001');
    expect(edges.map((e) => e.dependsOnTodoId)).toEqual(['e32f1697-96fb-4e8a-8922-3b4941d2292c']);
  });

  it('a prefix that resolves to the todo ITSELF keeps the 400 self-dependency class (not a 409 cycle)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 'e32f1697-96fb-4e8a-8922-3b4941d2292c', title: 'Self' }));
    await expect(
      updateTodo({
        userId: OWNER,
        todoId: 'e32f1697-96fb-4e8a-8922-3b4941d2292c',
        dependsOnTodoIds: ['e32f1697'],
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'A todo cannot depend on itself' });
  });

  it('an AMBIGUOUS 8-char prefix (two visible todos share it) never silently picks one — raw-input 404', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Target todo' }));
    // Two owner-VISIBLE twins share the 8-char prefix: resolveUniqueTodoPrefix
    // requires exactly one visible candidate, and the near-match tier only
    // fires on full 36-char shapes (isFullChatIdShape) — so the raw prefix
    // passes through and the loader echoes it verbatim. No silent pick.
    db.todos.push(todoRow({ id: 'e32f1697-96fb-4e8a-8922-3b4941d2292c', title: 'Twin C' }));
    db.todos.push(todoRow({ id: 'e32f1697-aaaa-4e8a-8922-3b4941d2292d', title: 'Twin D' }));
    await expect(
      updateTodo({
        userId: OWNER,
        todoId: 'aaaaaaaa-0000-4000-8000-000000000001',
        dependsOnTodoIds: ['e32f1697'],
      }),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Dependency todo not found: e32f1697' });
  });

  it('a longer unique prefix past the divergence heals to the full id (collision escape)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Target todo' }));
    db.todos.push(todoRow({ id: 'e32f1697-96fb-4e8a-8922-3b4941d2292c', title: 'Twin C' }));
    db.todos.push(todoRow({ id: 'e32f1697-aaaa-4e8a-8922-3b4941d2292d', title: 'Twin D' }));
    // 13 chars — past the twins' divergence at char 10, so exactly one candidate.
    await updateTodo({
      userId: OWNER,
      todoId: 'aaaaaaaa-0000-4000-8000-000000000001',
      dependsOnTodoIds: ['e32f1697-96fb'],
    });
    const edges = db.todoDeps.filter((d) => d.todoId === 'aaaaaaaa-0000-4000-8000-000000000001');
    expect(edges.map((e) => e.dependsOnTodoId)).toEqual(['e32f1697-96fb-4e8a-8922-3b4941d2292c']);
  });
});

// ── createTodo: the same prefix idiom at create time ─────────────────────────

describe('8f62542c — createTodo dependsOnTodoIds with 8-char prefixes', () => {
  it('prefix deps resolve and the edge stores the FULL id', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 'e32f1697-96fb-4e8a-8922-3b4941d2292c', title: 'Dep todo E' }));
    const out = await createTodo({
      userId: OWNER,
      goalId: 'g1',
      title: 'New todo',
      dependsOnTodoIds: ['e32f1697'],
    });
    const edges = db.todoDeps.filter((d) => d.todoId === out.id);
    expect(edges.map((e) => e.dependsOnTodoId)).toEqual(['e32f1697-96fb-4e8a-8922-3b4941d2292c']);
  });

  it('a bogus dep id at create still fails with the raw-input 404', async () => {
    db.goals.push(goalRow());
    await expect(
      createTodo({
        userId: OWNER,
        goalId: 'g1',
        title: 'New todo',
        dependsOnTodoIds: ['deadbee1'],
      }),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Dependency todo not found: deadbee1' });
  });
});

// ── The goal twin (dependsOnGoalIds at create and update) ────────────────────

describe('8f62542c — goal deps (createGoal + updateGoal) with 8-char prefixes', () => {
  it('createGoal with a prefix dep stores the FULL-id edge', async () => {
    db.goals.push(goalRow({ id: '689bdc33-c3f8-487e-8267-767e56543150', title: 'Dep goal' }));
    const out = await createGoal({
      userId: OWNER,
      projectId: 'p1',
      title: 'New goal',
      dependsOnGoalIds: ['689bdc33'],
    });
    const edges = db.goalDeps.filter((d) => d.goalId === out.id);
    expect(edges.map((e) => e.dependsOnGoalId)).toEqual(['689bdc33-c3f8-487e-8267-767e56543150']);
  });

  it('updateGoal with a prefix dep replaces the edge set with the FULL id', async () => {
    db.goals.push(goalRow({ id: 'g1', title: 'Target goal' }));
    db.goals.push(goalRow({ id: '689bdc33-c3f8-487e-8267-767e56543150', title: 'Dep goal' }));
    await updateGoal({ userId: OWNER, goalId: 'g1', dependsOnGoalIds: ['689bdc33'] });
    const edges = db.goalDeps.filter((d) => d.goalId === 'g1');
    expect(edges.map((e) => e.dependsOnGoalId)).toEqual(['689bdc33-c3f8-487e-8267-767e56543150']);
  });

  it('a bogus goal dep id still fails with the raw-input 404', async () => {
    db.goals.push(goalRow({ id: 'g1', title: 'Target goal' }));
    await expect(
      updateGoal({ userId: OWNER, goalId: 'g1', dependsOnGoalIds: ['deadbeef'] }),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Dependency goal not found: deadbeef' });
  });

  it('an AMBIGUOUS goal prefix (two visible goals share it) never silently picks one — raw-input 404', async () => {
    db.goals.push(goalRow({ id: 'g1', title: 'Target goal' }));
    db.goals.push(goalRow({ id: '689bdc33-c3f8-487e-8267-767e56543150', title: 'Twin A' }));
    db.goals.push(goalRow({ id: '689bdc33-aaaa-487e-8267-767e56543151', title: 'Twin B' }));
    await expect(
      updateGoal({ userId: OWNER, goalId: 'g1', dependsOnGoalIds: ['689bdc33'] }),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Dependency goal not found: 689bdc33' });
  });
});

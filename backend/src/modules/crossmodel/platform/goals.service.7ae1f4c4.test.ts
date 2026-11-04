/**
 * REPLAY PIN — ticket 7ae1f4c4 (mishap, breaker trip 2026-09-13, session
 * 581ae3b5 "Open Feedback Tickets Burn Down", run ee31495f).
 *
 * The mishap (verbatim failure texts, newest first):
 *   · Tool goal_get failed: Goal not found
 *   · Tool goal_get failed: Goal not found
 *   · Tool goal_get failed: Goal not found
 *
 * ADJUDICATION (engineering lane b92ef13f, 2026-09-13): the tripped lane was
 * adjudicating ticket 3ed139cd (a supervisor cited five goal ids that resolve
 * to NOTHING — fabricated-evidence class). Three consecutive goal_get probes
 * on three DIFFERENT never-existent ids each correctly 404'd (its control
 * probe on a real id resolved fine — the by-id path was never broken). The
 * derail breaker's 3-consecutive-failures trip is keyed on tool NAME by
 * design (agent.ts) and stays. The deterministic framework defect: the
 * no-hint 404 branch dropped the received id, so the three texts were
 * byte-identical and the auto-filed breaker ticket could not show WHICH ids
 * were probed — the 251e9329 self-describing-error contract violated.
 *
 * Fix (goals.service.ts getGoalRow/getTodoRow): the no-hint branch now echoes
 * the received id and names the list-tool recovery path. These tests pin:
 * (1) the new verbatim texts on goal_get AND todo_get; (2) three distinct
 * phantom probes — the exact 3ed139cd ids the tripped lane was adjudicating —
 * produce three DISTINCT, id-naming failure texts; (3) the non-member leak
 * contract is preserved (the message carries only the caller's own input id —
 * no classification, no linkage, no prefix hint); (4) the same-prefix hint
 * branch is unchanged. Mock harness copied from goals.service.0633adb5.test.ts.
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

import { getGoal, getTodo } from './goals.service';

// ── Fixtures + stateful fake DB (same pattern as goals.service.0633adb5.test.ts)

const OWNER = 'u-owner';
const STRANGER = 'u-stranger';
const NOW = new Date('2026-09-13T00:00:00Z');

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

// ── The exact phantom ids the tripped lane was adjudicating (ticket 3ed139cd —
//    a supervisor's fabricated "renamed goal" receipts; none ever existed) ────

const PHANTOM_GOAL_IDS = ['4dc6b1d1', '48c93a9e', '8e489f12'] as const;

const bareGoal404 = (id: string) =>
  `Goal not found: "${id}" — no goal with that id is visible to you. Re-call with the EXACT id copied verbatim from goal_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh goal_list first`;
const bareTodo404 = (id: string) =>
  `Todo not found: "${id}" — no todo with that id is visible to you. Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh todo_list first`;

describe('7ae1f4c4 replay — goal_get probes on the 3ed139cd phantom ids are self-diagnosing', () => {
  it.each(PHANTOM_GOAL_IDS)('goal_get(%s) → 404 naming that exact id + the goal_list recovery path', async (id) => {
    const err: any = await getGoal({ userId: OWNER, goalId: id }).catch((e: any) => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe(bareGoal404(id));
  });

  it('three consecutive phantom probes produce three DISTINCT failure texts (the auto-filed ticket now shows WHICH ids failed)', async () => {
    const texts: string[] = [];
    for (const id of PHANTOM_GOAL_IDS) {
      const err: any = await getGoal({ userId: OWNER, goalId: id }).catch((e: any) => e);
      texts.push(`Tool goal_get failed: ${err.message}`);
    }
    // Pre-fix this set had ONE member ('Tool goal_get failed: Goal not found' ×3).
    expect(new Set(texts).size).toBe(3);
    texts.forEach((t, i) => expect(t).toContain(PHANTOM_GOAL_IDS[i]));
  });
});

describe('7ae1f4c4 — todo_get mirror', () => {
  it('todo_get on a never-existent id echoes the id + the todo_list recovery path', async () => {
    const id = 'b8cfd55e-2420-4c03-a2b5-e6a5df5f7403';
    const err: any = await getTodo({ userId: OWNER, todoId: id }).catch((e: any) => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe(bareTodo404(id));
  });
});

describe('7ae1f4c4 — the non-member leak contract is preserved', () => {
  it('a STRANGER probing someone else\'s TODO id gets the id-echoing bare message — no classification, no linkage (fecf85c5)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    const err: any = await getGoal({ userId: STRANGER, goalId: 't1' }).catch((e: any) => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe(bareGoal404('t1'));
    expect(err.message).not.toContain('TODO id');
    expect(err.message).not.toContain('parent goal');
    expect(err.message).not.toContain('"g1"');
  });

  it('a STRANGER probing an invisible same-prefix id gets NO hint (8579d419 leak guard) — just their own id echoed', async () => {
    db.goals.push(goalRow({ id: 'b33c5011-46fc-4254-988e-a9c65193fa05' }));
    const probed = 'b33c5011-a653-493a-b0a2-334ba7eb789c';
    const err: any = await getGoal({ userId: STRANGER, goalId: probed }).catch((e: any) => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe(bareGoal404(probed));
    expect(err.message).not.toContain('Did you mean');
    expect(err.message).not.toContain('46fc-4254');
  });
});

describe('7ae1f4c4 — the same-prefix branch (superseded for unique visible rows by 99ad288e + 636b622b)', () => {
  it('owner probing a same-prefix miss with a UNIQUE visible row now RESOLVES (the heal); the hint branch survives for AMBIGUITY', async () => {
    db.goals.push(goalRow({ id: 'b33c5011-46fc-4254-988e-a9c65193fa05', title: 'Hint target' }));
    const g = await getGoal({ userId: OWNER, goalId: 'b33c5011-a653-493a-b0a2-334ba7eb789c' });
    expect(g.id).toBe('b33c5011-46fc-4254-988e-a9c65193fa05');
    // AMBIGUITY: a second visible same-prefix row keeps the hint branch.
    db.goals.push(goalRow({ id: 'b33c5011-ffff-4254-988e-a9c65193fa05', title: 'Second' }));
    const err: any = await getGoal({ userId: OWNER, goalId: 'b33c5011-a653-493a-b0a2-334ba7eb789c' }).catch((e: any) => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).toContain('Did you mean');
    expect(err.message).toContain('goal_list');
  });
});

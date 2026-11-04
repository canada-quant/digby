/**
 * REPLAY PIN — ticket bfcd01fc (mishap, breaker trip 2026-09-13T16:54Z,
 * session 62ee7f6d "Open Feedback Tickets Burn Down", run c9d410d1).
 *
 * The mishap (verbatim failure texts, newest first):
 *   · Tool goal_get failed: Goal not found
 *   · Tool goal_get failed: Goal not found
 *   · Tool goal_get failed: Goal not found
 *
 * ADJUDICATION (engineering lane c370ca0f, 2026-09-14): EARLIER SIBLING of
 * ticket 7ae1f4c4 — same streak class, same root cause, same fix. The tripped
 * lane was adjudicating ticket 7ee38c8e defect 2 (a supervisor's "renamed
 * goal" receipts cited ids that resolve to NOTHING — the 3ed139cd
 * fabricated-id incident). It probed FIVE never-existent goal ids
 * (4dc6b1d1, 48c93a9e, 8e489f12, 8ec1f4cd, 81c9bc8e) plus one never-existent
 * todo id (078bbac3); its control probe on a real id (a2e54c5c) resolved —
 * the by-id path was never broken, and a fresh account-wide goal_list showed
 * no goal named "Open Feedback Tickets Burn Down" exists. Three consecutive
 * probes on three DIFFERENT never-existent ids each correctly 404'd, but the
 * pre-fix no-hint branch dropped the received id, so the failure texts were
 * byte-identical and the derail breaker (tool-NAME keyed by design —
 * deliberately unchanged) counted a 3× streak and auto-filed this ticket
 * without being able to show WHICH ids were probed (the 251e9329
 * self-describing-error contract).
 *
 * Fix: shipped under sibling ticket 7ae1f4c4 — PR #724 (squash cefde5129,
 * merged 2026-09-13T20:15Z; deploy run 34780215881 success 20:43:30Z):
 * goals.service.ts getGoalRow/getTodoRow no-hint branches now echo the
 * received id and name the list-tool recovery path; the 7ae1f4c4 adminNote
 * records "Sibling breaker ticket bfcd01fc (same class) is fixed by the same
 * change." Re-verified live 2026-09-14 by this lane: prod goal_get(4dc6b1d1)
 * returns the id-naming text verbatim, and control goal_get(a2e54c5c)
 * resolves. This pin locks the bfcd01fc-specific signature the 7ae1f4c4 pin
 * does not cover: the FULL five-id probe set of session 62ee7f6d yields five
 * DISTINCT id-naming failure texts (no 3-window can form the pre-fix
 * identical-text streak), the phantom todo probe echoes its id, and the
 * control id resolves. Mock harness copied from goals.service.7ae1f4c4.test.ts.
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

// ── Fixtures + stateful fake DB (same pattern as goals.service.7ae1f4c4.test.ts)

const OWNER = 'u-owner';
const NOW = new Date('2026-09-13T00:00:00Z');

const PROJECT = { id: 'p1', userId: OWNER, name: 'P1', path: '/p1', members: [] as any[] };

const goalRow = (over: any = {}) => ({
  id: 'g1', userId: OWNER, projectId: 'p1', title: 'Goal 1', description: '',
  status: 'active', blockedReason: null, createdByChatId: null,
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

// ── The exact phantom ids session 62ee7f6d probed while adjudicating ticket
//    7ee38c8e defect 2 (the 3ed139cd fabricated "renamed goal" receipts; none
//    ever existed), quoted from that lane's own final self-audit ────────────

const PHANTOM_GOAL_IDS = ['4dc6b1d1', '48c93a9e', '8e489f12', '8ec1f4cd', '81c9bc8e'] as const;
const PHANTOM_TODO_ID = '078bbac3';
const CONTROL_GOAL_ID = 'a2e54c5c-8a17-4a5b-9d68-a17cd7558320';

const bareGoal404 = (id: string) =>
  `Goal not found: "${id}" — no goal with that id is visible to you. Re-call with the EXACT id copied verbatim from goal_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh goal_list first`;
const bareTodo404 = (id: string) =>
  `Todo not found: "${id}" — no todo with that id is visible to you. Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh todo_list first`;

describe('bfcd01fc replay — the five phantom goal probes of session 62ee7f6d are self-diagnosing', () => {
  it.each(PHANTOM_GOAL_IDS)('goal_get(%s) → 404 naming that exact id + the goal_list recovery path', async (id) => {
    const err: any = await getGoal({ userId: OWNER, goalId: id }).catch((e: any) => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe(bareGoal404(id));
  });

  it('five consecutive phantom probes produce five DISTINCT failure texts — no 3-window can form the pre-fix identical-text streak', async () => {
    const texts: string[] = [];
    for (const id of PHANTOM_GOAL_IDS) {
      const err: any = await getGoal({ userId: OWNER, goalId: id }).catch((e: any) => e);
      texts.push(`Tool goal_get failed: ${err.message}`);
    }
    // Pre-fix every 3-window of this list was ONE byte-identical member
    // ('Tool goal_get failed: Goal not found' ×3) — the bfcd01fc streak.
    expect(new Set(texts).size).toBe(PHANTOM_GOAL_IDS.length);
    for (let i = 0; i + 3 <= texts.length; i++) {
      expect(new Set(texts.slice(i, i + 3)).size).toBe(3);
    }
    texts.forEach((t, i) => expect(t).toContain(PHANTOM_GOAL_IDS[i]));
  });
});

describe('bfcd01fc — the phantom todo probe echoes its id', () => {
  it('todo_get(078bbac3) → 404 naming the id + the todo_list recovery path', async () => {
    const err: any = await getTodo({ userId: OWNER, todoId: PHANTOM_TODO_ID }).catch((e: any) => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe(bareTodo404(PHANTOM_TODO_ID));
  });
});

describe('bfcd01fc — the by-id path was never broken (the tripped lane\u2019s control resolves)', () => {
  it('goal_get on an existing id returns the goal', async () => {
    db.goals.push(goalRow({ id: CONTROL_GOAL_ID, title: 'Control goal' }));
    const goal = await getGoal({ userId: OWNER, goalId: CONTROL_GOAL_ID });
    expect(goal.id).toBe(CONTROL_GOAL_ID);
    expect(goal.title).toBe('Control goal');
  });
});

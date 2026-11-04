/**
 * Fleet supervisor (slice C) — goals.service unit tests with a stateful fake
 * Prisma (reads see earlier writes, so propagation chains behave like the
 * real DB). Pins: CRUD + ownership (owner/member-write/member-read/
 * non-member), same-owner dep validation (cross-project OK, cross-user
 * never), DFS cycle rejection, 'done' gating (409 + force), '[deps]' blocked
 * propagation (auto-block / auto-unblock / manual blocks left alone), goal
 * auto-complete on last todo done, todo_done / goal_blocked hook emissions
 * (dynamic-import boundary mocked), and includeDescendants path matching.
 * Colocated mock pattern copied from autonomy.service.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn(), findMany: jest.fn() },
  // findFirst: the project-supervisor lookup of the CanLaw-2026-09-15 corrective wake.
  crossModelChat: { findUnique: jest.fn(), findFirst: jest.fn(async () => null) },
  projectMember: { findMany: jest.fn() },
  // updateMany: the owner-gate release (unblockOwnerGatedItems) flips rows with a conditional updateMany.
  projectGoal: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  projectTodo: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  goalDependency: { findMany: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
  todoDependency: { findMany: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
  // Phantom-gate guard (ticket d76750f5): gate writes resolve against owner_questions.
  ownerQuestion: { findFirst: jest.fn(), findMany: jest.fn() },
  activity: { create: jest.fn(async () => ({})) },
  // KPI contract (tt-rd audit 2026-09-27): a kpi: premise's receipt row is verified.
  runToolReceipt: { findFirst: jest.fn(async () => null) },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// hooks.service (mocked below) reads Redis for the depth stamp — mock the module too.
// wakeTodoAssignee (resume propagation) also debounces via Redis SET NX — handle exposed.
const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: (...a: any[]) => mockRedisSet(...a), del: (...a: any[]) => mockRedisDel(...a) },
}));

// The wake's machine-run path (dynamic import of ../coding/schedule.service) —
// mocked at the boundary: the real module's fireScheduleTarget would pull the
// whole chat-agent loop into this jest graph.
const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
const mockDailyCapExceeded: jest.Mock = jest.fn(async () => null);
const mockRefundDailyCapToken: jest.Mock = jest.fn(async () => {});
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: (...a: any[]) => mockDailyCapExceeded(...a),
  refundDailyCapToken: (...a: any[]) => mockRefundDailyCapToken(...a),
}));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time — mock AppError (same shape).
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

// folder-inheritance (real, for the access mirror) pulls context-store — mock it.
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

import {
  createGoal, updateGoal, listGoals, getGoal,
  createTodo, updateTodo, listTodos, getTodo, recomputeDependents,
  wouldCreateGoalCycle, wouldCreateTodoCycle, DEPS_BLOCK_PREFIX,
  explainEmptyAccountWideTodoList,
  phantomDepsBlockNote, noteUnbackedOwnerWaitClaim, buildUnbackedOwnerClaimPrompt,
  unblockOwnerGatedItems, OWNER_CLAIM_SUPERVISOR_TTL_SEC,
  setGoalPremises,
  resolveProjectIdForTool, compactGoalRow, compactAccountWideGoals, goalListCompactDisabled, goalListAccountWideMaxChars,
} from './goals.service';

// ── Fixtures + stateful fake DB ──────────────────────────────────────────────

const OWNER = 'u-owner';
const EDITOR = 'u-editor';
const VIEWER = 'u-viewer';
const STRANGER = 'u-stranger';
const OTHER = 'u-other';
const NOW = new Date('2026-08-03T00:00:00Z');

const PROJECT = {
  id: 'p1', userId: OWNER, name: 'P1', path: '/p1',
  members: [{ userId: EDITOR, role: 'editor' }, { userId: VIEWER, role: 'viewer' }],
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

let db: {
  projects: any[]; goals: any[]; todos: any[]; goalDeps: any[]; todoDeps: any[]; ownerQuestions: any[];
};

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

/** Minimal Prisma WHERE matcher for the shapes goals.service issues. */
function matchRow(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v === undefined) return true;
    if (k === 'goal') return db.goals.some((g) => g.id === row.goalId && g.userId === v.userId);
    if (k === 'todo') return db.todos.some((t) => t.id === row.todoId && t.userId === v.userId);
    if (k === 'OR') return (v as any[]).some((clause) => matchRow(row, clause));
    if (v === null) return row[k] == null; // Prisma null equality (archive filter: fixtures without archivedAt read as live)
    if (v && typeof v === 'object' && 'startsWith' in v) return String(row[k] ?? '').startsWith(v.startsWith);
    if (v && typeof v === 'object' && 'contains' in v) return String(row[k] ?? '').includes(v.contains);
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    if (v && typeof v === 'object' && 'not' in v) return row[k] != null && row[k] !== v.not; // SQL <> never matches NULL
    return row[k] === v;
  });
}

function wireFake() {
  mockPrisma.crossModelProject.findUnique.mockImplementation(async ({ where }: any) =>
    db.projects.find((p) => p.id === where.id) ?? null);
  mockPrisma.crossModelProject.findMany.mockImplementation(async (args: any = {}) =>
    db.projects.filter((p) => matchRow(p, args.where)));
  mockPrisma.projectMember.findMany.mockImplementation(async () => []);
  // Phantom-gate guard (ticket d76750f5): resolveGateQuestionId probes exact
  // {id, userId} then unique {userId, id: startsWith} — both over db.ownerQuestions.
  mockPrisma.ownerQuestion.findFirst.mockImplementation(async ({ where, select }: any) => {
    const row = db.ownerQuestions.find((q) => matchRow(q, where)) ?? null;
    return row ? pick(row, select) : null;
  });
  mockPrisma.ownerQuestion.findMany.mockImplementation(async (args: any = {}) => {
    let rows = db.ownerQuestions.filter((q) => matchRow(q, args.where));
    if (args.take) rows = rows.slice(0, args.take);
    if (args.select) rows = rows.map((r) => pick(r, args.select));
    return rows;
  });
  // Assignee validation (todo_done events fire FROM the assignee chat — it must
  // belong to the fleet owner): default to a same-owner chat for any id.
  mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) =>
    ({ id: where.id, userId: OWNER }));

  mockPrisma.projectGoal.findUnique.mockImplementation(async ({ where, select }: any) => {
    const row = db.goals.find((g) => g.id === where.id) ?? null;
    return row ? pick(row, select) : null; // pick honors select (undefined → full row)
  });
  mockPrisma.projectGoal.findMany.mockImplementation(async (args: any = {}) => {
    let rows = db.goals.filter((g) => matchRow(g, args.where));
    if (args.orderBy?.createdAt) rows = [...rows].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (args.take) rows = rows.slice(0, args.take);
    if (args.include) {
      rows = rows.map((g) => ({
        ...g,
        ...(args.include.todos
          ? { todos: db.todos.filter((t) => t.goalId === g.id).map((t) => pick(t, args.include.todos.select)) }
          : {}),
        ...(args.include.depsThis
          ? { depsThis: db.goalDeps.filter((d) => d.goalId === g.id).map((d) => pick(d, args.include.depsThis.select)) }
          : {}),
        ...(args.include.depsOn
          ? { depsOn: db.goalDeps.filter((d) => d.dependsOnGoalId === g.id).map((d) => pick(d, args.include.depsOn.select)) }
          : {}),
      }));
    }
    if (args.select) rows = rows.map((r) => pick(r, args.select));
    return rows;
  });
  mockPrisma.projectGoal.create.mockImplementation(async ({ data }: any) => {
    const row = {
      description: '', status: 'active', blockedReason: null, createdByChatId: null,
      createdAt: NOW, updatedAt: NOW, ...data,
    };
    db.goals.push(row);
    return { ...row };
  });
  mockPrisma.projectGoal.update.mockImplementation(async ({ where, data }: any) => {
    const row = db.goals.find((g) => g.id === where.id);
    if (!row) throw new Error(`goal ${where.id} not found`);
    Object.assign(row, data);
    return { ...row };
  });

  mockPrisma.projectTodo.findUnique.mockImplementation(async ({ where, select }: any) => {
    const row = db.todos.find((t) => t.id === where.id) ?? null;
    return row ? pick(row, select) : null; // pick honors select (undefined → full row)
  });
  mockPrisma.projectTodo.findMany.mockImplementation(async (args: any = {}) => {
    let rows = db.todos.filter((t) => matchRow(t, args.where));
    if (args.take) rows = rows.slice(0, args.take);
    if (args.select) rows = rows.map((r) => pick(r, args.select));
    return rows;
  });
  mockPrisma.projectTodo.create.mockImplementation(async ({ data }: any) => {
    const row = {
      status: 'pending', blockedReason: null, assigneeChatId: null,
      createdAt: NOW, updatedAt: NOW, ...data,
    };
    db.todos.push(row);
    return { ...row };
  });
  mockPrisma.projectTodo.update.mockImplementation(async ({ where, data }: any) => {
    const row = db.todos.find((t) => t.id === where.id);
    if (!row) throw new Error(`todo ${where.id} not found`);
    Object.assign(row, data);
    return { ...row };
  });
  // Conditional bulk flips (the owner-gate release path): every row matching
  // `where` takes `data`; count = rows touched — the real Prisma contract.
  mockPrisma.projectTodo.updateMany.mockImplementation(async ({ where, data }: any) => {
    const rows = db.todos.filter((t) => matchRow(t, where));
    for (const r of rows) Object.assign(r, data);
    return { count: rows.length };
  });
  mockPrisma.projectGoal.updateMany.mockImplementation(async ({ where, data }: any) => {
    const rows = db.goals.filter((g) => matchRow(g, where));
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

const auditActions = (): string[] =>
  mockPrisma.activity.create.mock.calls.map((c: any[]) => c[0].data.action);
const goalById = (id: string) => db.goals.find((g) => g.id === id);
const todoById = (id: string) => db.todos.find((t) => t.id === id);

beforeEach(() => {
  jest.clearAllMocks();
  resetDb();
  wireFake();
});

// ── createGoal ───────────────────────────────────────────────────────────────

describe('createGoal', () => {
  it('creates an active goal with no deps, audits goal.create, and stores createdByChatId', async () => {
    const r = await createGoal({ userId: OWNER, projectId: 'p1', title: 'Ship it', description: 'd', createdByChatId: 'c-sup' });
    expect(r.status).toBe('active');
    expect(r.blockedReason).toBeNull();
    const data = mockPrisma.projectGoal.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: OWNER, projectId: 'p1', title: 'Ship it', description: 'd', createdByChatId: 'c-sup' });
    expect(data).not.toHaveProperty('status'); // model default 'active'
    expect(mockPrisma.goalDependency.createMany).not.toHaveBeenCalled();
    expect(auditActions()).toContain('goal.create');
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('rejects an empty title with 400', async () => {
    await expect(createGoal({ userId: OWNER, projectId: 'p1', title: '  ' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.projectGoal.create).not.toHaveBeenCalled();
  });

  it('lets an EDITOR member create (write role), owned by the PROJECT owner', async () => {
    const r = await createGoal({ userId: EDITOR, projectId: 'p1', title: 'Member goal' });
    expect(r.status).toBe('active');
    expect(mockPrisma.projectGoal.create.mock.calls[0][0].data.userId).toBe(OWNER);
  });

  it('rejects a VIEWER member with 403', async () => {
    await expect(createGoal({ userId: VIEWER, projectId: 'p1', title: 'x' }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mockPrisma.projectGoal.create).not.toHaveBeenCalled();
  });

  it('rejects a non-member with 404 (existence is not leaked)', async () => {
    await expect(createGoal({ userId: STRANGER, projectId: 'p1', title: 'x' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects an unknown project with 404', async () => {
    await expect(createGoal({ userId: OWNER, projectId: 'nope', title: 'x' }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Project not found' });
  });

  it('targets ANY project the caller owns via explicit projectId (account-wide writes)', async () => {
    db.projects.push({ id: 'p2', userId: OWNER, name: 'P2', path: '/p2', members: [] });
    const r = await createGoal({ userId: OWNER, projectId: 'p2', title: 'Elsewhere' });
    expect(r.status).toBe('active');
    expect(mockPrisma.projectGoal.create.mock.calls[0][0].data).toMatchObject({ projectId: 'p2', userId: OWNER });
  });

  it("rejects an explicit projectId targeting ANOTHER USER's project (404 — cross-user writes stay impossible)", async () => {
    db.projects.push({ id: 'pX', userId: OTHER, name: 'Foreign', path: '/px', members: [] });
    await expect(createGoal({ userId: OWNER, projectId: 'pX', title: 'x' }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(mockPrisma.projectGoal.create).not.toHaveBeenCalled();
  });

  it('creates dep rows in the same transaction and stays active when all deps are done-ish', async () => {
    db.goals.push(goalRow({ id: 'gA', status: 'done' }), goalRow({ id: 'gB', status: 'archived' })); // archived counts as done
    const r = await createGoal({ userId: OWNER, projectId: 'p1', title: 'G', dependsOnGoalIds: ['gA', 'gB'] });
    expect(r.status).toBe('active');
    expect(r.dependsOnGoalIds).toEqual(['gA', 'gB']);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    const rows = mockPrisma.goalDependency.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows.map((d: any) => d.dependsOnGoalId).sort()).toEqual(['gA', 'gB']);
    expect(db.goalDeps).toHaveLength(2);
  });

  it("starts blocked with a '[deps]' reason when any dep goal is not done", async () => {
    db.goals.push(goalRow({ id: 'gA', status: 'done' }), goalRow({ id: 'gB', status: 'active' }));
    const r = await createGoal({ userId: OWNER, projectId: 'p1', title: 'G', dependsOnGoalIds: ['gA', 'gB'] });
    expect(r.status).toBe('blocked');
    expect(r.blockedReason).toBe(`${DEPS_BLOCK_PREFIX} Waiting on 1 goal`);
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled(); // creation is not a transition
  });

  it('allows a CROSS-PROJECT dep for the same owner', async () => {
    db.projects.push({ id: 'p2', userId: OWNER, name: 'P2', path: '/p2', members: [] });
    db.goals.push(goalRow({ id: 'gX', projectId: 'p2', status: 'done' }));
    const r = await createGoal({ userId: OWNER, projectId: 'p1', title: 'G', dependsOnGoalIds: ['gX'] });
    expect(r.status).toBe('active');
    expect(db.goalDeps).toHaveLength(1);
  });

  it('rejects a CROSS-USER dep with 403', async () => {
    db.goals.push(goalRow({ id: 'gX', userId: OTHER, status: 'done' }));
    await expect(createGoal({ userId: OWNER, projectId: 'p1', title: 'G', dependsOnGoalIds: ['gX'] }))
      .rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('same owner') });
    expect(mockPrisma.projectGoal.create).not.toHaveBeenCalled();
  });

  it('rejects a missing dep goal with 404', async () => {
    await expect(createGoal({ userId: OWNER, projectId: 'p1', title: 'G', dependsOnGoalIds: ['ghost'] }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('not found') });
  });
});

// ── updateGoal ───────────────────────────────────────────────────────────────

describe('updateGoal', () => {
  beforeEach(() => {
    db.goals.push(goalRow());
  });

  it('updates title/description without touching status', async () => {
    const r = await updateGoal({ userId: OWNER, goalId: 'g1', title: 'Renamed', description: 'new' });
    expect(r.title).toBe('Renamed');
    expect(goalById('g1')).toMatchObject({ title: 'Renamed', description: 'new', status: 'active' });
    expect(auditActions()).not.toContain('goal.update'); // no status change
  });

  it('rejects an invalid status with 400', async () => {
    await expect(updateGoal({ userId: OWNER, goalId: 'g1', status: 'doing' as any }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('cross-hints when the id is actually a TODO (write path shares the loader)', async () => {
    db.todos.push(todoRow());
    await expect(updateGoal({ userId: OWNER, goalId: 't1', title: 'Nope' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('todo_update') });
  });

  it("409s 'done' while any dep goal is not done (with explanation)", async () => {
    db.goals.push(goalRow({ id: 'g2', title: 'Blocker', status: 'active' }));
    db.goalDeps.push({ goalId: 'g1', dependsOnGoalId: 'g2' });
    await expect(updateGoal({ userId: OWNER, goalId: 'g1', status: 'done' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('"Blocker" (active)') });
    expect(goalById('g1').status).toBe('active');
    expect(mockPrisma.projectGoal.update).not.toHaveBeenCalled();
  });

  it('force: true overrides the done gate and audits goal.force_done', async () => {
    db.goals.push(goalRow({ id: 'g2', status: 'active' }));
    db.goalDeps.push({ goalId: 'g1', dependsOnGoalId: 'g2' });
    const r = await updateGoal({ userId: OWNER, goalId: 'g1', status: 'done', force: true });
    expect(r.status).toBe('done');
    expect(goalById('g1').status).toBe('done');
    expect(auditActions()).toContain('goal.force_done');
  });

  it('allows done when all deps are done-ish (archived counts as done), clearing blockedReason', async () => {
    db.goals.push(goalRow({ id: 'g2', status: 'done' }), goalRow({ id: 'g3', status: 'archived' }));
    db.goalDeps.push({ goalId: 'g1', dependsOnGoalId: 'g2' }, { goalId: 'g1', dependsOnGoalId: 'g3' });
    db.goals[0].blockedReason = `${DEPS_BLOCK_PREFIX} Waiting on 2 goals`;
    db.goals[0].status = 'blocked';
    const r = await updateGoal({ userId: OWNER, goalId: 'g1', status: 'done' });
    expect(r.status).toBe('done');
    expect(goalById('g1')).toMatchObject({ status: 'done', blockedReason: null });
  });

  it("manual block defaults the reason to 'Blocked manually' and emits goal_blocked", async () => {
    db.goals[0].createdByChatId = 'c-sup';
    const r = await updateGoal({ userId: OWNER, goalId: 'g1', status: 'blocked' });
    expect(r).toMatchObject({ status: 'blocked', blockedReason: 'Blocked manually' });
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c-sup', 'goal_blocked', 'Goal blocked: Goal 1 (Blocked manually)');
    expect(auditActions()).toContain('goal.update');
  });

  it('manual block keeps an explicit reason and includes it in the emission', async () => {
    db.goals[0].createdByChatId = 'c-sup';
    await updateGoal({ userId: OWNER, goalId: 'g1', status: 'blocked', blockedReason: 'Waiting on legal' });
    expect(goalById('g1').blockedReason).toBe('Waiting on legal');
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c-sup', 'goal_blocked', 'Goal blocked: Goal 1 (Waiting on legal)');
  });

  it('manual block does NOT emit when the goal has no createdByChatId', async () => {
    await updateGoal({ userId: OWNER, goalId: 'g1', status: 'blocked' });
    expect(goalById('g1').status).toBe('blocked');
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('refreshes blockedReason on an already-blocked goal (reason-only, no goal_blocked re-fire)', async () => {
    db.goals[0].status = 'blocked';
    db.goals[0].blockedReason = 'Old reason';
    db.goals[0].createdByChatId = 'c-sup';
    const r = await updateGoal({ userId: OWNER, goalId: 'g1', blockedReason: 'Waiting on vendor RCA' });
    expect(r.blockedReason).toBe('Waiting on vendor RCA');
    expect(goalById('g1')).toMatchObject({ status: 'blocked', blockedReason: 'Waiting on vendor RCA' });
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
    expect(auditActions()).not.toContain('goal.update');
  });

  it('400s blockedReason on a non-blocked goal instead of silently dropping it', async () => {
    await expect(updateGoal({ userId: OWNER, goalId: 'g1', blockedReason: 'nope' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('blocked') });
    expect(goalById('g1').blockedReason).toBeNull();
  });

  it('archived is allowed anytime, even with open deps', async () => {
    db.goals.push(goalRow({ id: 'g2', status: 'active' }));
    db.goalDeps.push({ goalId: 'g1', dependsOnGoalId: 'g2' });
    const r = await updateGoal({ userId: OWNER, goalId: 'g1', status: 'archived' });
    expect(r.status).toBe('archived');
    expect(goalById('g1')).toMatchObject({ status: 'archived', blockedReason: null });
  });

  it("replacing deps with an open dep re-blocks an active goal with '[deps]' and emits goal_blocked", async () => {
    db.goals[0].createdByChatId = 'c-sup';
    db.goals.push(goalRow({ id: 'g2', status: 'active' }));
    const r = await updateGoal({ userId: OWNER, goalId: 'g1', dependsOnGoalIds: ['g2'] });
    expect(goalById('g1')).toMatchObject({ status: 'blocked', blockedReason: `${DEPS_BLOCK_PREFIX} Waiting on 1 goal` });
    expect(r.dependsOnGoalIds).toEqual(['g2']);
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c-sup', 'goal_blocked', 'Goal blocked: Goal 1 (waiting on 1 goals)');
    expect(auditActions()).toContain('goal.auto_block');
  });

  it("clearing a dep-blocked goal's deps auto-restores it to active", async () => {
    db.goals[0].status = 'blocked';
    db.goals[0].blockedReason = `${DEPS_BLOCK_PREFIX} Waiting on 1 goal`;
    db.goals.push(goalRow({ id: 'g2', status: 'active' }));
    db.goalDeps.push({ goalId: 'g1', dependsOnGoalId: 'g2' });
    await updateGoal({ userId: OWNER, goalId: 'g1', dependsOnGoalIds: [] });
    expect(goalById('g1')).toMatchObject({ status: 'active', blockedReason: null });
    expect(db.goalDeps).toHaveLength(0);
    expect(auditActions()).toContain('goal.auto_unblock');
  });

  it('rejects a dep replacement that would create a cycle (A→B→C→A) with 409', async () => {
    db.goals.push(goalRow({ id: 'g2' }), goalRow({ id: 'g3' }));
    db.goalDeps.push({ goalId: 'g1', dependsOnGoalId: 'g2' }, { goalId: 'g2', dependsOnGoalId: 'g3' });
    await expect(updateGoal({ userId: OWNER, goalId: 'g3', dependsOnGoalIds: ['g1'] }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('cycle') });
    expect(db.goalDeps).toHaveLength(2); // unchanged
  });

  it('rejects a self-dependency with 400', async () => {
    await expect(updateGoal({ userId: OWNER, goalId: 'g1', dependsOnGoalIds: ['g1'] }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('itself') });
  });

  it('a non-member cannot update (404 — existence not leaked)', async () => {
    await expect(updateGoal({ userId: STRANGER, goalId: 'g1', title: 'x' }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(goalById('g1').title).toBe('Goal 1');
  });
});

// ── listGoals / getGoal ──────────────────────────────────────────────────────

describe('listGoals', () => {
  beforeEach(() => {
    db.goals.push(goalRow(), goalRow({ id: 'g0', title: 'Upstream' }));
    db.todos.push(todoRow(), todoRow({ id: 't2', title: 'Todo 2', status: 'done' }));
    db.goalDeps.push({ goalId: 'g1', dependsOnGoalId: 'g0' }, { goalId: 'g9', dependsOnGoalId: 'g1' });
  });

  it('a VIEWER member can read, with todos + both dependency directions inline', async () => {
    const rows = await listGoals({ userId: VIEWER, projectId: 'p1' });
    const g = rows.find((r) => r.id === 'g1')!;
    expect(g.todos).toEqual([
      { id: 't1', title: 'Todo 1', status: 'pending' },
      { id: 't2', title: 'Todo 2', status: 'done' },
    ]);
    expect(g.dependsOnGoalIds).toEqual(['g0']);
    expect(g.dependentGoalIds).toEqual(['g9']);
    expect(mockPrisma.projectGoal.findMany.mock.calls[0][0].where).toEqual({ projectId: { in: ['p1'] } });
  });

  it('rejects a non-member with 404', async () => {
    await expect(listGoals({ userId: STRANGER, projectId: 'p1' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('applies the status filter at the DB level', async () => {
    await listGoals({ userId: OWNER, projectId: 'p1', status: 'done' });
    expect(mockPrisma.projectGoal.findMany.mock.calls[0][0].where)
      .toEqual({ projectId: { in: ['p1'] }, status: 'done' });
  });

  it('rejects an invalid status filter with 400', async () => {
    await expect(listGoals({ userId: OWNER, projectId: 'p1', status: 'nope' as any }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('includeDescendants widens to the subtree via the materialized path prefix', async () => {
    db.projects.push({ id: 'p1c', userId: OWNER, name: 'Child', path: '/p1/p1c', members: [] });
    db.goals.push(goalRow({ id: 'gChild', projectId: 'p1c', title: 'Child goal' }));
    const rows = await listGoals({ userId: OWNER, projectId: 'p1', includeDescendants: true });
    // Id-segment expansion (ticket fa2e44dd — same semantics as the b1e59df6
    // account-wide fix): self by id + descendants by '/<id>/' path segment.
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledWith({
      where: { OR: [{ id: 'p1' }, { path: { contains: '/p1/' } }] },
      select: { id: true, name: true },
    });
    expect(mockPrisma.projectGoal.findMany.mock.calls[0][0].where.projectId.in.sort()).toEqual(['p1', 'p1c']);
    const child = rows.find((r) => r.id === 'gChild')!;
    expect(child.projectName).toBe('Child'); // subtree rows tagged too
  });

  it('includeDescendants on a BLANK/legacy-path project queries by ID segment only (cross-user leak guard)', async () => {
    db.projects.length = 0;
    db.projects.push({ id: 'pBlank', userId: OWNER, name: 'Legacy', path: '', members: [] });
    db.goals.push(goalRow({ id: 'gBlank', projectId: 'pBlank', title: 'Own goal' }));
    const rows = await listGoals({ userId: OWNER, projectId: 'pBlank', includeDescendants: true });
    // The query keys on the project's ID as a path segment — never a blanket
    // match (a contains:'/' or startsWith:'' would match EVERY project row).
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledWith({
      where: { OR: [{ id: 'pBlank' }, { path: { contains: '/pBlank/' } }] },
      select: { id: true, name: true },
    });
    expect(mockPrisma.projectGoal.findMany.mock.calls[0][0].where.projectId.in).toEqual(['pBlank']);
    expect(rows.map((r) => r.id)).toEqual(['gBlank']);
  });

  it('includeDescendants on a BLANK/legacy-path project still widens to descendants that name it by id (ticket fa2e44dd)', async () => {
    // The reviewer-found divergence (b1e59df6 class, scoped form): folder
    // pFolder carries a blank/legacy path; the nested project's path still
    // names pFolder by id. requireProjectRead resolves access via the ids in
    // the LEAF's path (scoped goal_list on pNested worked), but the old
    // startsWith-on-own-path expansion skipped the query entirely — the
    // subtree went blind. Repro: goal_list({projectId: pFolder,
    // includeDescendants: true}) missed pNested's goals while
    // goal_list({projectId: pNested}) returned them.
    db.projects.push(
      { id: 'pFolder', userId: OWNER, name: 'Folder', path: '', members: [] },
      { id: 'pNested', userId: OWNER, name: 'Nested', path: '/pFolder/pNested', members: [] },
    );
    db.goals.push(goalRow({ id: 'gNested', projectId: 'pNested', title: 'Nested goal' }));
    // Parity half 1: the direct scoped read on the descendant works.
    const direct = await listGoals({ userId: OWNER, projectId: 'pNested' });
    expect(direct.some((r) => r.id === 'gNested')).toBe(true);
    // Parity half 2: so the blank-path ancestor's includeDescendants MUST
    // enumerate the same goal.
    const rows = await listGoals({ userId: OWNER, projectId: 'pFolder', includeDescendants: true });
    expect(rows.some((r) => r.id === 'gNested')).toBe(true);
    expect(rows.find((r) => r.id === 'gNested')!.projectName).toBe('Nested');
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledWith({
      where: { OR: [{ id: 'pFolder' }, { path: { contains: '/pFolder/' } }] },
      select: { id: true, name: true },
    });
  });

  it('includeDescendants does NOT match sibling-prefix paths (/p1 vs /p10)', async () => {
    db.projects.push({ id: 'p10', userId: OWNER, name: 'Sibling', path: '/p10', members: [] });
    db.goals.push(goalRow({ id: 'gSib', projectId: 'p10', title: 'Sibling goal' }));
    const rows = await listGoals({ userId: OWNER, projectId: 'p1', includeDescendants: true });
    expect(rows.some((r) => r.id === 'gSib')).toBe(false);
  });

  it('scoped listing tags every row with its projectName', async () => {
    const rows = await listGoals({ userId: OWNER, projectId: 'p1' });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.projectName).toBe('P1');
  });

  // ── Account-wide listing (owner decision 2026-08-13: 'All projects, tagged') ──

  it('with NO projectId lists across ALL owned projects, each row tagged with its projectName', async () => {
    db.projects.push({ id: 'p2', userId: OWNER, name: 'P2', path: '/p2', members: [] });
    db.goals.push(goalRow({ id: 'g2', projectId: 'p2', title: 'In P2' }));
    const rows = await listGoals({ userId: OWNER });
    expect(rows.map((r) => r.id).sort()).toEqual(['g0', 'g1', 'g2']);
    expect(rows.find((r) => r.id === 'g1')!.projectName).toBe('P1');
    expect(rows.find((r) => r.id === 'g2')!.projectName).toBe('P2');
    // Ownership resolved through the caller's OWNED projects (path selected
    // for the inherited-ownership descendant expansion; archivedAt for the
    // archived-folder exclusion — archive/restore, owner 2026-09-08).
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledWith({
      where: { userId: OWNER },
      select: { id: true, name: true, path: true, archivedAt: true },
    });
  });

  it('account-wide listing INCLUDES projects owned via an owned ancestor folder (inherited ownership)', async () => {
    // edff5ac6: getProjectAccess grants an ancestor OWNER role 'owner', so the
    // global list must count nested projects too — even when the leaf row is
    // owned by another user (e.g. a collaborator's project inside the folder).
    db.projects.push({ id: 'pNested', userId: OTHER, name: 'Nested', path: '/p1/pNested', members: [] });
    db.goals.push(goalRow({ id: 'gNested', projectId: 'pNested', userId: OTHER, title: 'Nested goal' }));
    const rows = await listGoals({ userId: OWNER });
    expect(rows.some((r) => r.id === 'gNested')).toBe(true);
    expect(rows.find((r) => r.id === 'gNested')!.projectName).toBe('Nested');
    // Expansion resolves the subtree by the root's ID as a path segment (the
    // same notion getProjectAccess resolves — ticket b1e59df6), never a
    // blanket match (archived descendants excluded — archive/restore, owner
    // 2026-09-08).
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledWith({
      where: { archivedAt: null, OR: [{ path: { contains: '/p1/' } }] },
      select: { id: true, name: true },
    });
  });

  it('account-wide listing INCLUDES projects under an owned ancestor with a BLANK legacy path (ticket b1e59df6)', async () => {
    // The prod divergence (Fleet Supervisor "New Hampshire" repro, 2026-09-15):
    // folder pFolder is owned by the caller but carries a blank/legacy path;
    // the nested project's path still names pFolder by id. getProjectAccess
    // resolves the ancestor by the IDS in the LEAF's path → role 'owner'
    // (goal_get worked); the old startsWith expansion keyed on the root's OWN
    // path string and silently contributed ZERO descendants — account-wide
    // goal_list returned "No goals found" while an active goal existed.
    db.projects.push(
      { id: 'pFolder', userId: OWNER, name: 'Folder', path: '', members: [] },
      { id: 'pNested', userId: OTHER, name: 'Nested', path: '/pFolder/pNested', members: [] },
    );
    db.goals.push(goalRow({ id: 'gNested', projectId: 'pNested', userId: OTHER, title: 'Active in nested' }));
    // Parity contract half 1: the per-goal access check calls the caller OWNER…
    await expect(getGoal({ userId: OWNER, goalId: 'gNested' })).resolves.toMatchObject({ id: 'gNested' });
    // …half 2: so the account-wide listing MUST enumerate the same project.
    const rows = await listGoals({ userId: OWNER });
    expect(rows.some((r) => r.id === 'gNested')).toBe(true);
    expect(rows.find((r) => r.id === 'gNested')!.projectName).toBe('Nested');
    // The blank-path root acted as an expansion root via its ID segment.
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.arrayContaining([{ path: { contains: '/pFolder/' } }]) }),
      }),
    );
  });

  it('account-wide listing with FOLDERS_INHERITANCE=off counts DIRECT ownership only', async () => {
    db.projects.push({ id: 'pNested', userId: OTHER, name: 'Nested', path: '/p1/pNested', members: [] });
    db.goals.push(goalRow({ id: 'gNested', projectId: 'pNested', userId: OTHER }));
    const prev = process.env.FOLDERS_INHERITANCE;
    process.env.FOLDERS_INHERITANCE = 'off';
    try {
      const rows = await listGoals({ userId: OWNER });
      expect(rows.some((r) => r.id === 'gNested')).toBe(false);
      // Flag off → no descendant query at all (pre-P2 leaf-only behavior).
      expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.FOLDERS_INHERITANCE;
      else process.env.FOLDERS_INHERITANCE = prev;
    }
  });

  it('account-wide descendant expansion NEVER matches member-shared projects outside owned subtrees', async () => {
    // pShared is OTHER's root project shared WITH the caller — its path is not
    // under any owned folder, so the expansion must not pull it in.
    db.projects.push({ id: 'pShared', userId: OTHER, name: 'Shared', path: '/pS', members: [{ userId: OWNER, role: 'editor' }] });
    db.goals.push(goalRow({ id: 'gShared', projectId: 'pShared', userId: OTHER }));
    const rows = await listGoals({ userId: OWNER });
    expect(rows.some((r) => r.id === 'gShared')).toBe(false);
  });

  it("account-wide listing NEVER includes another user's goals — not even from projects shared WITH the caller", async () => {
    // pShared is OTHER's project with OWNER as an editor member: readable via
    // the scoped form, but excluded from OWNER's global listing.
    db.projects.push({ id: 'pShared', userId: OTHER, name: 'Shared', path: '/pS', members: [{ userId: OWNER, role: 'editor' }] });
    db.goals.push(goalRow({ id: 'gShared', projectId: 'pShared', userId: OTHER, title: 'Their goal' }));

    const global = await listGoals({ userId: OWNER });
    expect(global.some((r) => r.id === 'gShared')).toBe(false);

    const scoped = await listGoals({ userId: OWNER, projectId: 'pShared' });
    expect(scoped.map((r) => r.id)).toEqual(['gShared']); // membership read still works in-project
    expect(scoped[0].projectName).toBe('Shared');
  });

  it('account-wide listing applies the status filter and still rejects an invalid one', async () => {
    db.goals.push(goalRow({ id: 'gDone', status: 'done' }));
    const rows = await listGoals({ userId: OWNER, status: 'done' });
    expect(rows.map((r) => r.id)).toEqual(['gDone']);
    await expect(listGoals({ userId: OWNER, status: 'nope' as any }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('account-wide listing returns [] when the caller owns no projects (no goal query at all)', async () => {
    db.projects.length = 0;
    db.projects.push({ id: 'pX', userId: OTHER, name: 'Foreign', path: '/px', members: [] });
    await expect(listGoals({ userId: STRANGER })).resolves.toEqual([]);
    expect(mockPrisma.projectGoal.findMany).not.toHaveBeenCalled();
  });
});

describe('getGoal', () => {
  it('returns deps + dependents (with status) and todos', async () => {
    db.goals.push(
      goalRow(),
      goalRow({ id: 'g0', title: 'Upstream', status: 'done', projectId: 'p2' }),
      goalRow({ id: 'g9', title: 'Downstream', status: 'blocked' }),
    );
    db.goalDeps.push({ goalId: 'g1', dependsOnGoalId: 'g0' }, { goalId: 'g9', dependsOnGoalId: 'g1' });
    db.todos.push(todoRow());
    const g = await getGoal({ userId: OWNER, goalId: 'g1' });
    expect(g.dependsOn).toEqual([{ id: 'g0', title: 'Upstream', status: 'done', projectId: 'p2' }]);
    expect(g.dependents).toEqual([{ id: 'g9', title: 'Downstream', status: 'blocked', projectId: 'p1' }]);
    expect(g.todos).toEqual([{ id: 't1', title: 'Todo 1', status: 'pending' }]);
  });

  it('404s an unknown goal', async () => {
    await expect(getGoal({ userId: OWNER, goalId: 'ghost' }))
      .rejects.toMatchObject({ statusCode: 404, message: `Goal not found: "ghost" — no goal with that id is visible to you. Re-call with the EXACT id copied verbatim from goal_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh goal_list first` });
  });

  it('cross-hints when the id is actually a TODO (feedback fecf85c5)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    await expect(getGoal({ userId: OWNER, goalId: 't1' }))
      .rejects.toMatchObject({
        statusCode: 404,
        message: expect.stringContaining('todo_get'),
      });
    // …and names the parent goal so the agent can recover in one call.
    await expect(getGoal({ userId: OWNER, goalId: 't1' }))
      .rejects.toMatchObject({ message: expect.stringContaining('g1') });
  });

  it('does NOT cross-hint to a non-member (no existence/linkage leak)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    // A stranger probing someone else's TODO id gets the bare legacy message —
    // never the todo classification or the parent-goal linkage.
    await expect(getGoal({ userId: STRANGER, goalId: 't1' }))
      .rejects.toMatchObject({ statusCode: 404, message: `Goal not found: "t1" — no goal with that id is visible to you. Re-call with the EXACT id copied verbatim from goal_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh goal_list first` });
  });

  it('enforces read access (non-member → 404)', async () => {
    db.goals.push(goalRow());
    await expect(getGoal({ userId: STRANGER, goalId: 'g1' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('resolves a corrupted full UUID to the unique visible same-prefix row (feedback 5373796a superseded by 99ad288e + 636b622b: the hint was offered and ignored 3×)', async () => {
    // The 2026-08-30 false alarm: the supervisor reconstructed a goal UUID from
    // its 8-char prefix and invented the suffix, then read the 404 as data loss.
    // The hint (naming the real same-prefix record) self-corrects in one call
    // ONLY when the model obeys — the 99ad288e/636b622b streaks prove it
    // re-passes the fabricated id instead. A unique visible same-prefix row
    // now RESOLVES on the read path (the ladder read==write, 2026-09-28).
    db.goals.push(goalRow({ id: 'b33c5011-46fc-4254-988e-a9c65193fa05', title: 'Mass burn-down' }));
    const g = await getGoal({ userId: OWNER, goalId: 'b33c5011-a653-493a-b0a2-334ba7eb789c' });
    expect(g.id).toBe('b33c5011-46fc-4254-988e-a9c65193fa05');
    expect(g.title).toBe('Mass burn-down');
  });

  it('does NOT prefix-suggest to a non-member (no existence leak)', async () => {
    db.goals.push(goalRow({ id: 'b33c5011-46fc-4254-988e-a9c65193fa05' }));
    await expect(getGoal({ userId: STRANGER, goalId: 'b33c5011-a653-493a-b0a2-334ba7eb789c' }))
      .rejects.toMatchObject({ statusCode: 404, message: `Goal not found: "b33c5011-a653-493a-b0a2-334ba7eb789c" — no goal with that id is visible to you. Re-call with the EXACT id copied verbatim from goal_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh goal_list first` });
  });

  it('bare 404 when no same-prefix goal exists', async () => {
    await expect(getGoal({ userId: OWNER, goalId: 'ffffffff-0000-0000-0000-000000000000' }))
      .rejects.toMatchObject({ statusCode: 404, message: `Goal not found: "ffffffff-0000-0000-0000-000000000000" — no goal with that id is visible to you. Re-call with the EXACT id copied verbatim from goal_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh goal_list first` });
  });
});

describe('getTodo', () => {
  it('returns the parent goal brief and BOTH dependency directions', async () => {
    db.goals.push(goalRow());
    db.todos.push(
      todoRow(),
      todoRow({ id: 't0', title: 'Upstream todo', status: 'done' }),
      todoRow({ id: 't9', title: 'Downstream todo', status: 'blocked' }),
    );
    db.todoDeps.push({ todoId: 't1', dependsOnTodoId: 't0' }, { todoId: 't9', dependsOnTodoId: 't1' });
    const t = await getTodo({ userId: OWNER, todoId: 't1' });
    expect(t.goal).toEqual({ id: 'g1', title: 'Goal 1', status: 'active', projectId: 'p1' });
    expect(t.dependsOn).toEqual([{ id: 't0', title: 'Upstream todo', status: 'done', goalId: 'g1' }]);
    expect(t.dependents).toEqual([{ id: 't9', title: 'Downstream todo', status: 'blocked', goalId: 'g1' }]);
  });

  it('404s an unknown todo', async () => {
    await expect(getTodo({ userId: OWNER, todoId: 'ghost' }))
      .rejects.toMatchObject({ statusCode: 404, message: `Todo not found: "ghost" — no todo with that id is visible to you. Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh todo_list first` });
  });

  it('cross-hints when the id is actually a GOAL (feedback fecf85c5)', async () => {
    db.goals.push(goalRow());
    await expect(getTodo({ userId: OWNER, todoId: 'g1' }))
      .rejects.toMatchObject({
        statusCode: 404,
        message: expect.stringContaining('goal_get'),
      });
  });

  it('does NOT cross-hint to a non-member (bare legacy 404)', async () => {
    db.goals.push(goalRow());
    await expect(getTodo({ userId: STRANGER, todoId: 'g1' }))
      .rejects.toMatchObject({ statusCode: 404, message: `Todo not found: "g1" — no todo with that id is visible to you. Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh todo_list first` });
  });

  it('enforces read access (non-member → 404, no existence leak)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    await expect(getTodo({ userId: STRANGER, todoId: 't1' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('resolves a corrupted full UUID on the todo read path too (5373796a → 99ad288e + 636b622b ladder)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 'b7fc9aa2-eda4-4a39-b44d-e2073998c4b6', title: 'Verify C' }));
    const t = await getTodo({ userId: OWNER, todoId: 'b7fc9aa2-9f33-44d0-aae9-e71407991b58' });
    expect(t.id).toBe('b7fc9aa2-eda4-4a39-b44d-e2073998c4b6');
    expect(t.title).toBe('Verify C');
  });

  it('does NOT prefix-suggest to a non-member (no existence leak)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 'b7fc9aa2-eda4-4a39-b44d-e2073998c4b6' }));
    await expect(getTodo({ userId: STRANGER, todoId: 'b7fc9aa2-9f33-44d0-aae9-e71407991b58' }))
      .rejects.toMatchObject({ statusCode: 404, message: `Todo not found: "b7fc9aa2-9f33-44d0-aae9-e71407991b58" — no todo with that id is visible to you. Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh todo_list first` });
  });

  it('bare 404 when no same-prefix todo exists', async () => {
    await expect(getTodo({ userId: OWNER, todoId: 'ffffffff-0000-0000-0000-000000000000' }))
      .rejects.toMatchObject({ statusCode: 404, message: `Todo not found: "ffffffff-0000-0000-0000-000000000000" — no todo with that id is visible to you. Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh todo_list first` });
  });
});

// ── Unique-prefix resolution (replay pin, ticket 8579d419) ──────────────────
// The 2026-09-10 breaker trip: a fleet lane called todo_get with the fleet-
// standard 8-char idiom ("eaad801c") and 404'd — goal/todo were the ONLY
// id-taking tools that refused unique prefixes (schedule_get, get_feedback,
// hook_update, … all resolve them). Three garbage-arg retries later the
// breaker tripped. These tests pin the fix: a UNIQUE visible prefix resolves;
// ambiguity, full-length misses, and non-members keep the legacy hint path.

describe('unique-prefix resolution (ticket 8579d419)', () => {
  const FULL_TODO = 'eaad801c-3183-4ef6-8039-fa1d3e67b9ea';
  const FULL_GOAL = '5791b3c0-63e5-4036-b35b-cbdbb1eb2d8d';

  it('todo_get resolves a unique 8-char prefix (the incident replay)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: FULL_TODO, title: 'FULL canlegal-bench calibration' }));
    const t = await getTodo({ userId: OWNER, todoId: 'eaad801c' });
    expect(t.id).toBe(FULL_TODO);
    expect(t.title).toBe('FULL canlegal-bench calibration');
  });

  it('goal_get resolves a unique 8-char prefix', async () => {
    db.goals.push(goalRow({ id: FULL_GOAL, title: 'GO/HOLD gate' }));
    const g = await getGoal({ userId: OWNER, goalId: '5791b3c0' });
    expect(g.id).toBe(FULL_GOAL);
  });

  it('a longer unique prefix (8–35 chars) resolves too', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: FULL_TODO }));
    const t = await getTodo({ userId: OWNER, todoId: 'eaad801c-3183-4ef6' });
    expect(t.id).toBe(FULL_TODO);
  });

  it('ambiguous prefix (two visible same-prefix todos) → hint error, never a guess', async () => {
    db.goals.push(goalRow());
    db.todos.push(
      todoRow({ id: FULL_TODO, title: 'Calibration A' }),
      todoRow({ id: 'eaad801c-ffff-4ef6-8039-fa1d3e67b9ea', title: 'Calibration B' }),
    );
    await expect(getTodo({ userId: OWNER, todoId: 'eaad801c' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('Did you mean') });
  });

  it('a full-length (36-char) miss with a CORRUPTED TAIL resolves to the unique visible same-prefix row (99ad288e + 636b622b — invented-suffix heal); ambiguity and no-prefix keep the hint error', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: FULL_TODO, title: 'Calibration A' }));
    // 99ad288e's verbatim fabricated id: correct 8-char prefix, invented suffix
    // (hamming distance 22 — no typo tier can reach it).
    const t = await getTodo({ userId: OWNER, todoId: 'eaad801c-9999-4ef6-8039-fa1d3e67b9ea' });
    expect(t.id).toBe(FULL_TODO);
    expect(t.title).toBe('Calibration A');
    // AMBIGUITY: two visible same-prefix todos → hint error, never a guess.
    db.todos.push(todoRow({ id: 'eaad801c-ffff-4ef6-8039-fa1d3e67b9ea', title: 'Calibration B' }));
    await expect(getTodo({ userId: OWNER, todoId: 'eaad801c-9999-4ef6-8039-fa1d3e67b9ea' }))
      .rejects.toMatchObject({
        statusCode: 404,
        message: expect.stringContaining('Did you mean'),
      });
  });

  it('non-member with an invisible unique prefix → bare 404 (no existence leak)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: FULL_TODO }));
    await expect(getTodo({ userId: STRANGER, todoId: 'eaad801c' }))
      .rejects.toMatchObject({ statusCode: 404, message: `Todo not found: "eaad801c" — no todo with that id is visible to you. Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh todo_list first` });
  });

  it('project member (viewer) resolves a unique prefix — same gate as the hint', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: FULL_TODO }));
    const t = await getTodo({ userId: VIEWER, todoId: 'eaad801c' });
    expect(t.id).toBe(FULL_TODO);
  });

  // ── Review-B1 regression pins: CREATE/LIST callers keep using their raw
  // input id downstream, so resolving there would silently mis-write / return
  // data-loss-shaped empty lists — a prefix into these paths keeps the
  // exact-id 404+hint contract. (The goal_update/todo_update pins lived here
  // until ticket 31db672f: the update tools now CANONICALIZE a unique prefix
  // up front — see the 31db672f describe below — which serves the B1 "never
  // a silent mis-write" spirit by writing the resolved canonical row, after
  // the exact-id contract itself burned a 3× breaker streak.)

  // (The B1 todo_create pin — "a prefix goalId → 404 + hint (never an orphan
  // row)" — retired on the FO firing-24 rollout watch, 2026-09-25: the live
  // 'Goal not found: "09a1ec04"' ×2 (05:35Z, hint naming the unique match)
  // burned the exact-id contract the same way the update tools did, and the
  // goalId is a PARENT POINTER — every downstream use carries the resolved
  // full id, so the B1 fetch-resolved/mutate-raw trap cannot arise. See the
  // firing-24 describe below for the replacement pins.)
  it('B1: todo_create under a full-length MISSED goalId with a unique visible same-prefix row resolves and parents the child CORRECTLY (99ad288e + 636b622b ladder); a fabricated id with NO same-prefix row still 404s + hints (never an orphan)', async () => {
    db.goals.push(goalRow({ id: FULL_GOAL }));
    // Corrupted tail on a real, visible, unique same-prefix goal → the child
    // is created under the RESOLVED goal (not an orphan).
    const created = await createTodo({ userId: OWNER, goalId: '5791b3c0-9999-4036-b35b-cbdbb1eb2d8d', title: 'Child' });
    expect(created.goalId).toBe(FULL_GOAL);
    expect(db.todos).toHaveLength(1);
    // A truly fabricated id (no same-prefix row anywhere) keeps the 404 + hint.
    await expect(createTodo({ userId: OWNER, goalId: '5791b3c1-9999-4036-b35b-cbdbb1eb2d8d', title: 'Orphan' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('Goal not found') });
    expect(db.todos).toHaveLength(1);
  });

  // (The B1 todo_list pin — "a prefix goalId → 404 + hint" — retired on the
  // 2026-09-14 rollout watch: todo_list now CANONICALIZES the goal prefix up
  // front like the update tools, so the filter runs on the resolved full id —
  // see the listTodos pins in the 31db672f describe below.)
});

// ── Write-path unique-prefix resolution (replay pin, ticket 31db672f) ──────
// The 2026-09-14 breaker trip: a lane fired a batch of todo_updates with the
// fleet-standard 8-char idiom ("ed5ad2d8", "dc507413", "b8443d39") — each
// 404'd even though the 'Did you mean' machinery already knew the unique
// match, and the 3× streak tripped the derail breaker. goal_update/todo_update
// were the fleet's last exact-id-only id-taking mutation tools (goal/todo READS
// resolve since 8579d419; schedule/hook/feedback tools all resolve prefixes).
// The fix CANONICALIZES the id up front: the update lands on the resolved row
// and every downstream use (dep self-checks, cycle walks, audits, metrics)
// carries the full id — the B1 trap was callers fetching by a resolved id
// while mutating by the raw input, which up-front canonicalization structurally
// avoids. Pins below: a unique visible prefix resolves AND writes the canonical
// row; ambiguity, full-length misses, and invisible rows keep the legacy
// 404+hint contract with ZERO writes; full-length ids never pay a prefix probe.

describe('write-path unique-prefix resolution (ticket 31db672f)', () => {
  // The ticket's literal todo prefixes (CanLaw board).
  const RL1_TODO = 'ed5ad2d8-1498-44ef-8fa8-4738a481f53d';
  const SFT2_TODO = 'dc507413-4f1a-4a6b-a0db-094464438c74';
  const P5_GOAL = 'b8443d39-e46a-4c18-ba05-b8ccd57a8b6e';

  it('todo_update resolves a unique 8-char prefix (the incident replay)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: RL1_TODO, title: 'RL-1 matched-budget A/B' }));
    const r = await updateTodo({ userId: OWNER, todoId: 'ed5ad2d8', title: 'RL-1 A/B — GO' });
    expect(r.id).toBe(RL1_TODO); // the returned view carries the CANONICAL id
    expect(todoById(RL1_TODO).title).toBe('RL-1 A/B — GO'); // the write landed on the resolved row
  });

  it('goal_update resolves a unique 8-char prefix', async () => {
    db.goals.push(goalRow({ id: P5_GOAL, title: 'P5 bench-fix loop' }));
    const r = await updateGoal({ userId: OWNER, goalId: 'b8443d39', title: 'P5 — closed loop' });
    expect(r.id).toBe(P5_GOAL);
    expect(goalById(P5_GOAL).title).toBe('P5 — closed loop');
  });

  // Rollout watch 2026-09-14 (tick 8): canlegal-bench's supervisor called
  // todo_list({goalId:'cd5fa541'}) twice in 3h and 404'd both times while the
  // hint named the unique match. The list path canonicalizes like the update
  // path; the FILTER runs on the resolved full id (the B1 trap was a raw prefix
  // in the where clause returning a data-loss-shaped empty list).
  it('todo_list scoped by a unique 8-char goal prefix lists that goal\'s todos (filter runs on the canonical id)', async () => {
    db.goals.push(goalRow({ id: P5_GOAL }));
    db.todos.push(
      todoRow({ id: RL1_TODO, goalId: P5_GOAL, title: 'under P5' }),
      todoRow({ id: SFT2_TODO, goalId: 'ffffffff-0000-4000-8000-000000000000', title: 'elsewhere' }),
    );
    const rows = await listTodos({ userId: OWNER, goalId: 'b8443d39' });
    expect(rows.map((r) => r.id)).toEqual([RL1_TODO]);
    expect(rows[0].goalId).toBe(P5_GOAL);
  });

  it('todo_list with an AMBIGUOUS goal prefix keeps the 404 + hint contract (never an empty list)', async () => {
    db.goals.push(goalRow({ id: P5_GOAL }), goalRow({ id: 'b8443d39-ffff-4c18-ba05-b8ccd57a8b6e' }));
    await expect(listTodos({ userId: OWNER, goalId: 'b8443d39' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('Did you mean') });
  });

  it('todo_list with an INVISIBLE unique goal prefix → bare 404 (no existence leak on the list path)', async () => {
    db.goals.push(goalRow({ id: P5_GOAL }));
    db.todos.push(todoRow({ id: RL1_TODO, goalId: P5_GOAL }));
    await expect(listTodos({ userId: STRANGER, goalId: 'b8443d39' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('no goal with that id is visible to you') });
  });

  it('canonicalizes BEFORE the dep self-check — prefix id + own full id in dependsOnTodoIds → 400 (never a silent self-edge)', async () => {
    // The B1 failure shape this fix must not reintroduce: with the RAW prefix
    // as selfId, normalizeDepIds would miss the self-reference and the write
    // would create a FULL_TODO → FULL_TODO dependency edge.
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: RL1_TODO }));
    await expect(updateTodo({ userId: OWNER, todoId: 'ed5ad2d8', dependsOnTodoIds: [RL1_TODO] }))
      .rejects.toMatchObject({ statusCode: 400, message: 'A todo cannot depend on itself' });
    expect(db.todoDeps).toHaveLength(0);
  });

  it('ambiguous prefix (two visible same-prefix todos) → 404 + hint, ZERO writes', async () => {
    db.goals.push(goalRow());
    db.todos.push(
      todoRow({ id: RL1_TODO, title: 'Calibration A' }),
      todoRow({ id: 'ed5ad2d8-ffff-44ef-8fa8-4738a481f53d', title: 'Calibration B' }),
    );
    await expect(updateTodo({ userId: OWNER, todoId: 'ed5ad2d8', title: 'Renamed' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('Did you mean') });
    expect(todoById(RL1_TODO).title).toBe('Calibration A');
    expect(todoById('ed5ad2d8-ffff-44ef-8fa8-4738a481f53d').title).toBe('Calibration B');
  });

  it('a full-length (36-char) miss with a CORRUPTED TAIL resolves on the WRITE path too and writes the RESOLVED row (99ad288e + 636b622b); ambiguity keeps the hint error with ZERO writes', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: RL1_TODO, title: 'Calibration A' }));
    // The incident shape: correct 8-char prefix, invented suffix → resolved to
    // the unique visible row, the write lands on THAT row (never the raw input).
    await updateTodo({ userId: OWNER, todoId: 'ed5ad2d8-9999-44ef-8fa8-4738a481f53d', title: 'Renamed' });
    expect(todoById(RL1_TODO).title).toBe('Renamed');
    // AMBIGUITY: two visible same-prefix todos → hint error, never a guess,
    // ZERO writes (both rows untouched).
    db.todos.push(todoRow({ id: 'ed5ad2d8-ffff-44ef-8fa8-4738a481f53d', title: 'Calibration B' }));
    await expect(updateTodo({ userId: OWNER, todoId: 'ed5ad2d8-8888-44ef-8fa8-4738a481f53d', title: 'Nope' }))
      .rejects.toMatchObject({
        statusCode: 404,
        message: expect.stringContaining('Did you mean'),
      });
    expect(todoById(RL1_TODO).title).toBe('Renamed');
    expect(todoById('ed5ad2d8-ffff-44ef-8fa8-4738a481f53d').title).toBe('Calibration B');
  });

  it('non-member with an invisible unique prefix → bare 404, ZERO writes (no existence leak on the write path)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: RL1_TODO, title: 'Calibration A' }));
    await expect(updateTodo({ userId: STRANGER, todoId: 'ed5ad2d8', title: 'Renamed' }))
      .rejects.toMatchObject({ statusCode: 404, message: `Todo not found: "ed5ad2d8" — no todo with that id is visible to you. Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh todo_list first` });
    expect(todoById(RL1_TODO).title).toBe('Calibration A');
  });

  it('viewer member with a visible unique prefix → 403 write gate (same contract as a full id)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: RL1_TODO, title: 'Calibration A' }));
    await expect(updateTodo({ userId: VIEWER, todoId: 'ed5ad2d8', title: 'Renamed' }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(todoById(RL1_TODO).title).toBe('Calibration A');
  });

  it('a full-length id pays ZERO prefix probes (hot-path regression pin)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: SFT2_TODO, title: 'SFT-2 training' }));
    await updateTodo({ userId: OWNER, todoId: SFT2_TODO, title: 'SFT-2 — launched' });
    expect(todoById(SFT2_TODO).title).toBe('SFT-2 — launched');
    // No startsWith candidate scan on the 36-char path — REST/tool callers with
    // full ids must not pay for the prefix affordance.
    const prefixScans = mockPrisma.projectTodo.findMany.mock.calls
      .filter((c: any[]) => c[0]?.where?.id?.startsWith !== undefined);
    expect(prefixScans).toHaveLength(0);
  });
});

// ── createTodo ───────────────────────────────────────────────────────────────

describe('createTodo', () => {
  beforeEach(() => {
    db.goals.push(goalRow());
  });

  it('creates a pending todo with projectId/userId denormalized from the goal', async () => {
    const r = await createTodo({ userId: OWNER, goalId: 'g1', title: 'Do it', assigneeChatId: 'c-work' });
    expect(r.status).toBe('pending');
    const data = mockPrisma.projectTodo.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: OWNER, goalId: 'g1', projectId: 'p1', title: 'Do it', assigneeChatId: 'c-work' });
    expect(data).not.toHaveProperty('status');
    expect(auditActions()).toContain('todo.create');
  });

  it('404s when the goal does not exist', async () => {
    await expect(createTodo({ userId: OWNER, goalId: 'ghost', title: 'x' }))
      .rejects.toMatchObject({ statusCode: 404, message: `Goal not found: "ghost" — no goal with that id is visible to you. Re-call with the EXACT id copied verbatim from goal_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh goal_list first` });
  });

  it('rejects a VIEWER member with 403 (write needed on the goal project)', async () => {
    await expect(createTodo({ userId: VIEWER, goalId: 'g1', title: 'x' }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("starts blocked with a '[deps]' reason when a dep todo is not done", async () => {
    db.todos.push(todoRow({ id: 'tA', status: 'in_progress' }));
    const r = await createTodo({ userId: OWNER, goalId: 'g1', title: 'Later', dependsOnTodoIds: ['tA'] });
    expect(r.status).toBe('blocked');
    expect(r.blockedReason).toBe(`${DEPS_BLOCK_PREFIX} Waiting on 1 todo`);
    expect(db.todoDeps).toHaveLength(1);
  });

  it('rejects a CROSS-USER todo dep with 403', async () => {
    db.todos.push(todoRow({ id: 'tX', userId: OTHER, status: 'done' }));
    await expect(createTodo({ userId: OWNER, goalId: 'g1', title: 'x', dependsOnTodoIds: ['tX'] }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects a missing todo dep with 404', async () => {
    await expect(createTodo({ userId: OWNER, goalId: 'g1', title: 'x', dependsOnTodoIds: ['ghost'] }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects an empty title with 400', async () => {
    await expect(createTodo({ userId: OWNER, goalId: 'g1', title: '' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  // ── FO firing 24 (2026-09-25): todo_create resolves a unique ≥8-char goal
  // prefix — the live incident was 'Goal not found: "09a1ec04"' ×2 (05:35Z,
  // app_error_logs) whose own Did-you-mean hint already named the unique
  // match. Same guards as every other id-taking goal/todo path (8–35 chars,
  // exactly one caller-visible candidate, same access gate as the hint); the
  // goalId is a PARENT POINTER, so every downstream use (tx create
  // data.goalId, audit, todo_done payload) carries the resolved full id.
  it('firing-24: resolves a unique 8-char goal prefix — the created row, create data AND audit carry the CANONICAL id (+ one todo_create_prefix_resolved metric)', async () => {
    const FULL = '09a1ec04-1111-4aaa-8bbb-000000000001';
    db.goals.push(goalRow({ id: FULL, title: 'Client platforms phase 2' }));
    const r = await createTodo({ userId: OWNER, goalId: '09a1ec04', title: 'Prefix child' });
    expect(r.goalId).toBe(FULL); // the VIEW carries the canonical parent id
    expect(todoById(r.id).goalId).toBe(FULL); // the write landed under the resolved goal
    const data = mockPrisma.projectTodo.create.mock.calls[0][0].data;
    expect(data.goalId).toBe(FULL); // never the raw prefix
    expect(data.projectId).toBe('p1'); // denormalized from the resolved goal
    expect(auditActions()).toContain('todo.create');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'todo_create_prefix_resolved',
      meta: expect.objectContaining({ from: '09a1ec04', to: '09a1ec04', userId: OWNER }),
    }));
  });

  it('firing-24: an AMBIGUOUS goal prefix keeps the 404 + hint contract, ZERO rows (never a guess)', async () => {
    db.goals.push(
      goalRow({ id: '09a1ec04-1111-4aaa-8bbb-000000000001', title: 'Candidate A' }),
      goalRow({ id: '09a1ec04-2222-4aaa-8bbb-000000000002', title: 'Candidate B' }),
    );
    await expect(createTodo({ userId: OWNER, goalId: '09a1ec04', title: 'x' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('Did you mean') });
    expect(db.todos).toHaveLength(0);
  });

  it('firing-24: an INVISIBLE unique goal prefix → bare 404 (no existence leak), ZERO rows', async () => {
    db.goals.push(goalRow({ id: '09a1ec04-1111-4aaa-8bbb-000000000001' }));
    await expect(createTodo({ userId: STRANGER, goalId: '09a1ec04', title: 'x' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('no goal with that id is visible to you') });
    expect(db.todos).toHaveLength(0);
  });

  it('firing-24: viewer member with a visible unique prefix → 403 write gate (same contract as a full id)', async () => {
    db.goals.push(goalRow({ id: '09a1ec04-1111-4aaa-8bbb-000000000001' }));
    await expect(createTodo({ userId: VIEWER, goalId: '09a1ec04', title: 'x' }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(db.todos).toHaveLength(0);
  });

  it('firing-24: a full-length id pays ZERO prefix probes (hot-path pin)', async () => {
    const FULL = '09a1ec04-1111-4aaa-8bbb-000000000001';
    db.goals.push(goalRow({ id: FULL }));
    await createTodo({ userId: OWNER, goalId: FULL, title: 'x' });
    expect(db.todos).toHaveLength(1); // the create landed
    expect(db.todos[0].goalId).toBe(FULL);
    const prefixScans = mockPrisma.projectGoal.findMany.mock.calls
      .filter((c: any[]) => c[0]?.where?.id?.startsWith !== undefined);
    expect(prefixScans).toHaveLength(0);
  });
});

// ── updateTodo ───────────────────────────────────────────────────────────────

describe('updateTodo', () => {
  beforeEach(() => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
  });

  it("409s 'done' while a dep todo is not done", async () => {
    db.todos.push(todoRow({ id: 't0', title: 'First', status: 'in_progress' }));
    db.todoDeps.push({ todoId: 't1', dependsOnTodoId: 't0' });
    await expect(updateTodo({ userId: OWNER, todoId: 't1', status: 'done' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('"First" (in_progress)') });
    expect(todoById('t1').status).toBe('pending');
  });

  it('force: true overrides the done gate (and still emits todo_done)', async () => {
    db.todos.push(todoRow({ id: 't0', status: 'pending' }));
    db.todoDeps.push({ todoId: 't1', dependsOnTodoId: 't0' });
    db.todos[0].assigneeChatId = 'c-work';
    const r = await updateTodo({ userId: OWNER, todoId: 't1', status: 'done', force: true });
    expect(r.status).toBe('done');
    expect(auditActions()).toContain('todo.force_done');
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c-work', 'todo_done', 'Todo done: Todo 1');
  });

  it("emits todo_done on the assignee chat when a todo becomes done", async () => {
    db.todos[0].assigneeChatId = 'c-work';
    db.todos.push(todoRow({ id: 't2', status: 'done' })); // keep the goal from auto-completing? no — all done ⇒ completes; fine
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'done' });
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c-work', 'todo_done', 'Todo done: Todo 1');
    // Hardening 2026-09-14: with NO acting chat the call is exactly 3-arg —
    // the REST / user-present close path is byte-identical (no actor rides).
    expect(mockEmitHookEventSafe.mock.calls[0]).toHaveLength(3);
    expect(auditActions()).toContain('todo.update');
  });

  it('forwards actingChatId as the hook ACTOR (4th arg) while the SOURCE stays the assignee — hardening 2026-09-14 (a supervisor is not woken by its own close)', async () => {
    db.todos[0].assigneeChatId = 'c-work';
    db.todos.push(todoRow({ id: 't2', status: 'in_progress' })); // keep goal g1 from auto-completing
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'done', actingChatId: 'c-psup', machineTriggered: true, evidence: 'PR #123 merged' });
    expect(mockEmitHookEventSafe).toHaveBeenCalledTimes(1);
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c-work', 'todo_done', 'Todo done: Todo 1', { actorChatId: 'c-psup' });
    expect(todoById('t1').status).toBe('done');
  });

  it('a blank actingChatId is not forwarded (defensive — the 3-arg shape survives)', async () => {
    db.todos[0].assigneeChatId = 'c-work';
    db.todos.push(todoRow({ id: 't2', status: 'in_progress' }));
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'done', actingChatId: '' });
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c-work', 'todo_done', 'Todo done: Todo 1');
    expect(mockEmitHookEventSafe.mock.calls[0]).toHaveLength(3);
  });

  it('does NOT emit todo_done when the todo has no assigneeChatId', async () => {
    db.todos.push(todoRow({ id: 't2', status: 'in_progress' }));
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'done' });
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
    expect(todoById('t1').status).toBe('done');
  });

  it("todo A done → dep-blocked todo B auto-unblocks to 'pending'", async () => {
    db.todos.push(todoRow({ id: 't2', title: 'B', status: 'blocked', blockedReason: `${DEPS_BLOCK_PREFIX} Waiting on 1 todo` }));
    db.todoDeps.push({ todoId: 't2', dependsOnTodoId: 't1' });
    db.todos.push(todoRow({ id: 't3', status: 'in_progress' })); // keep goal g1 from auto-completing
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'done' });
    expect(todoById('t2')).toMatchObject({ status: 'pending', blockedReason: null });
    expect(auditActions()).toContain('todo.auto_unblock');
  });

  it('a MANUALLY blocked dependent todo is NOT auto-unblocked when its dep completes', async () => {
    db.todos.push(todoRow({ id: 't2', title: 'B', status: 'blocked', blockedReason: 'Waiting on legal' }));
    db.todoDeps.push({ todoId: 't2', dependsOnTodoId: 't1' });
    db.todos.push(todoRow({ id: 't3', status: 'in_progress' }));
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'done' });
    expect(todoById('t2')).toMatchObject({ status: 'blocked', blockedReason: 'Waiting on legal' });
  });

  it('auto-completes the parent goal when its LAST todo is done (and goal-deps done)', async () => {
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'done' });
    expect(goalById('g1')).toMatchObject({ status: 'done', blockedReason: null });
    expect(auditActions()).toContain('goal.auto_done');
  });

  it('does NOT auto-complete the goal while another todo is still open', async () => {
    db.todos.push(todoRow({ id: 't2', status: 'in_progress' }));
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'done' });
    expect(goalById('g1').status).toBe('active');
    expect(auditActions()).not.toContain('goal.auto_done');
  });

  it('does NOT auto-complete the goal while a goal-dep is open', async () => {
    db.goals.push(goalRow({ id: 'g0', status: 'active' }));
    db.goalDeps.push({ goalId: 'g1', dependsOnGoalId: 'g0' });
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'done' });
    expect(goalById('g1').status).toBe('active');
  });

  it('goal auto-complete cascades: dependent goal auto-unblocks (archived/done count as done)', async () => {
    db.goals.push(goalRow({ id: 'g9', title: 'Downstream', status: 'blocked', blockedReason: `${DEPS_BLOCK_PREFIX} Waiting on 1 goal` }));
    db.goalDeps.push({ goalId: 'g9', dependsOnGoalId: 'g1' });
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'done' });
    expect(goalById('g1').status).toBe('done');
    expect(goalById('g9')).toMatchObject({ status: 'active', blockedReason: null });
    expect(auditActions()).toContain('goal.auto_unblock');
  });

  it('rejects a todo dep replacement that would create a cycle with 409', async () => {
    db.todos.push(todoRow({ id: 't2' }), todoRow({ id: 't3' }));
    db.todoDeps.push({ todoId: 't1', dependsOnTodoId: 't2' }, { todoId: 't2', dependsOnTodoId: 't3' });
    await expect(updateTodo({ userId: OWNER, todoId: 't3', dependsOnTodoIds: ['t1'] }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('cycle') });
  });

  it("replacing a dep-blocked todo's deps with done ones restores it to 'pending'", async () => {
    db.todos[0].status = 'blocked';
    db.todos[0].blockedReason = `${DEPS_BLOCK_PREFIX} Waiting on 1 todo`;
    db.todos.push(todoRow({ id: 't0', status: 'pending' }));
    db.todoDeps.push({ todoId: 't1', dependsOnTodoId: 't0' });
    db.todos.push(todoRow({ id: 't9', status: 'done' }));
    await updateTodo({ userId: OWNER, todoId: 't1', dependsOnTodoIds: ['t9'] });
    expect(todoById('t1')).toMatchObject({ status: 'pending', blockedReason: null });
    expect(db.todoDeps).toEqual([{ todoId: 't1', dependsOnTodoId: 't9' }]);
  });

  it('updates the assignee (and clears it with null)', async () => {
    const r = await updateTodo({ userId: OWNER, todoId: 't1', assigneeChatId: 'c-new' });
    expect(r.assigneeChatId).toBe('c-new');
    const r2 = await updateTodo({ userId: OWNER, todoId: 't1', assigneeChatId: null });
    expect(r2.assigneeChatId).toBeNull();
  });

  it('rejects an assignee chat owned by ANOTHER user (cross-user wake injection guard)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ id: 'c-foreign', userId: 'someone-else' });
    await expect(updateTodo({ userId: OWNER, todoId: 't1', assigneeChatId: 'c-foreign' }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects an unknown assignee chat with 400', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce(null);
    await expect(updateTodo({ userId: OWNER, todoId: 't1', assigneeChatId: 'c-ghost' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("manual block defaults the reason and emits nothing (todos don't emit goal_blocked)", async () => {
    const r = await updateTodo({ userId: OWNER, todoId: 't1', status: 'blocked' });
    expect(r).toMatchObject({ status: 'blocked', blockedReason: 'Blocked manually' });
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('refreshes blockedReason on an already-blocked todo (reason-only update)', async () => {
    db.todos[0].status = 'blocked';
    db.todos[0].blockedReason = 'Old reason';
    const r = await updateTodo({ userId: OWNER, todoId: 't1', blockedReason: 'Waiting on upstream API' });
    expect(r.blockedReason).toBe('Waiting on upstream API');
    expect(todoById('t1')).toMatchObject({ status: 'blocked', blockedReason: 'Waiting on upstream API' });
  });

  it("applies a new blockedReason when re-passing status:'blocked' on an already-blocked todo", async () => {
    db.todos[0].status = 'blocked';
    db.todos[0].blockedReason = 'Old reason';
    const r = await updateTodo({ userId: OWNER, todoId: 't1', status: 'blocked', blockedReason: 'New context' });
    expect(r.blockedReason).toBe('New context');
    expect(todoById('t1').blockedReason).toBe('New context');
  });

  it("defaults an empty reason refresh to 'Blocked manually'", async () => {
    db.todos[0].status = 'blocked';
    db.todos[0].blockedReason = 'Old reason';
    const r = await updateTodo({ userId: OWNER, todoId: 't1', blockedReason: '   ' });
    expect(r.blockedReason).toBe('Blocked manually');
  });

  it('400s blockedReason on a non-blocked todo instead of silently dropping it', async () => {
    await expect(updateTodo({ userId: OWNER, todoId: 't1', blockedReason: 'nope' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('blocked') });
    expect(todoById('t1').blockedReason).toBeNull();
  });

  it('rejects a VIEWER member with 403', async () => {
    await expect(updateTodo({ userId: VIEWER, todoId: 't1', status: 'done' }))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});

// ── listTodos ────────────────────────────────────────────────────────────────

describe('listTodos', () => {
  beforeEach(() => {
    db.goals.push(goalRow());
    db.todos.push(todoRow(), todoRow({ id: 't2', title: 'T2', status: 'done' }));
    db.todoDeps.push({ todoId: 't2', dependsOnTodoId: 't1' });
  });

  it('rejects both filters together with 400', async () => {
    await expect(listTodos({ userId: OWNER, goalId: 'g1', projectId: 'p1' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('lists by goal with dep ids inline, tagged with projectName', async () => {
    const rows = await listTodos({ userId: OWNER, goalId: 'g1' });
    expect(rows).toHaveLength(2);
    const t2 = rows.find((t) => t.id === 't2')!;
    expect(t2.dependsOnTodoIds).toEqual(['t1']);
    expect(t2.projectName).toBe('P1');
    expect(mockPrisma.projectTodo.findMany.mock.calls[0][0].where).toEqual({ goalId: 'g1' });
  });

  it('lists by project (denormalized projectId) with a status filter, read-gated', async () => {
    const rows = await listTodos({ userId: VIEWER, projectId: 'p1', status: 'done' });
    expect(mockPrisma.projectTodo.findMany.mock.calls[0][0].where).toEqual({ projectId: 'p1', status: 'done' });
    expect(rows.map((t) => t.id)).toEqual(['t2']);
    await expect(listTodos({ userId: STRANGER, projectId: 'p1' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  // ── Account-wide listing (owner decision 2026-08-13: 'All projects, tagged') ──

  it('with NO filter lists account-wide across owned projects, tagged with projectName', async () => {
    db.projects.push({ id: 'p2', userId: OWNER, name: 'P2', path: '/p2', members: [] });
    db.goals.push(goalRow({ id: 'g2', projectId: 'p2' }));
    db.todos.push(todoRow({ id: 't3', goalId: 'g2', projectId: 'p2', title: 'In P2' }));
    const rows = await listTodos({ userId: OWNER });
    expect(rows.map((t) => t.id).sort()).toEqual(['t1', 't2', 't3']);
    expect(rows.find((t) => t.id === 't1')!.projectName).toBe('P1');
    expect(rows.find((t) => t.id === 't3')!.projectName).toBe('P2');
    expect(mockPrisma.projectTodo.findMany.mock.calls[0][0].where).toEqual({ projectId: { in: ['p1', 'p2'] } });
  });

  it("account-wide listing NEVER shows another user's todos — not even from projects shared WITH the caller", async () => {
    db.projects.push({ id: 'pShared', userId: OTHER, name: 'Shared', path: '/pS', members: [{ userId: OWNER, role: 'editor' }] });
    db.goals.push(goalRow({ id: 'gS', projectId: 'pShared', userId: OTHER }));
    db.todos.push(todoRow({ id: 'tS', goalId: 'gS', projectId: 'pShared', userId: OTHER, title: 'Theirs' }));

    const global = await listTodos({ userId: OWNER });
    expect(global.some((t) => t.id === 'tS')).toBe(false);

    const scoped = await listTodos({ userId: OWNER, projectId: 'pShared' });
    expect(scoped.map((t) => t.id)).toEqual(['tS']); // in-project membership read intact
    expect(scoped[0].projectName).toBe('Shared');
  });

  it('account-wide listing includes todos from projects owned via an owned ancestor folder', async () => {
    // edff5ac6: same inherited-ownership rule as listGoals (shared helper).
    db.projects.push({ id: 'pNested', userId: OTHER, name: 'Nested', path: '/p1/pNested', members: [] });
    db.goals.push(goalRow({ id: 'gN', projectId: 'pNested', userId: OTHER }));
    db.todos.push(todoRow({ id: 'tN', goalId: 'gN', projectId: 'pNested', userId: OTHER, title: 'Nested todo' }));
    const rows = await listTodos({ userId: OWNER });
    expect(rows.some((t) => t.id === 'tN')).toBe(true);
    expect(rows.find((t) => t.id === 'tN')!.projectName).toBe('Nested');
  });

  it('account-wide listing returns [] when the caller owns no projects', async () => {
    await expect(listTodos({ userId: STRANGER })).resolves.toEqual([]);
    expect(mockPrisma.projectTodo.findMany).not.toHaveBeenCalled();
  });
});

// ── Replay pin: feedback 94b8e3a2 (2026-09-09) ───────────────────────────────
// The fleet supervisor's ACCOUNT-WIDE todo_list returned zero rows while the
// scoped form returned 11 — reported as a listing bug / data loss. Root cause:
// the account-wide list covers OWNED, non-archived projects only, so a caller
// whose todos live in member-shared or archived projects gets a bare "no
// todos" that reads exactly like data loss. explainEmptyAccountWideTodoList
// runs on the empty path and names what the listing excluded. These pins lock
// the three states: shared-exclusion hint, archived-exclusion hint, and a null
// (genuinely empty) account.

describe('explainEmptyAccountWideTodoList (replay pin, feedback 94b8e3a2)', () => {
  beforeEach(() => {
    // The shared-exclusion branch reads projectMember rows — resolve them from
    // the fixture projects' member lists (the suite default is []).
    mockPrisma.projectMember.findMany.mockImplementation(async ({ where }: any) =>
      db.projects.flatMap((p) =>
        (p.members ?? [])
          .filter((m: any) => m.userId === where.userId)
          .map((m: any) => ({ projectId: p.id, role: m.role })),
      ));
  });

  it('names member-shared projects still holding todos when the caller owns no projects', async () => {
    // The ticket's exact shape: caller owns nothing, a project shared WITH
    // them holds todos — account-wide [] is correct, but must say WHY.
    db.projects.push({ id: 'pShared', userId: OTHER, name: 'Shared', path: '/pS', members: [{ userId: STRANGER, role: 'viewer' }] });
    db.goals.push(goalRow({ id: 'gS', projectId: 'pShared', userId: OTHER }));
    db.todos.push(todoRow({ id: 'tS', goalId: 'gS', projectId: 'pShared', userId: OTHER, title: 'Theirs' }));

    await expect(listTodos({ userId: STRANGER })).resolves.toEqual([]); // still excluded by design
    const why = await explainEmptyAccountWideTodoList(STRANGER);
    expect(why).toMatch(/1 project\(s\) shared WITH you as a member hold 1 todo\(s\)/);
    expect(why).toMatch(/EXCLUDED from the account-wide list/);
    expect(why).toContain('"Shared" (pShared)');
  });

  it('names OWNED projects under the archive exclusion when they still hold todos', async () => {
    db.projects.push({ id: 'pArch', userId: STRANGER, name: 'Old', path: '/pArch', archivedAt: NOW, members: [] });
    db.goals.push(goalRow({ id: 'gA', projectId: 'pArch', userId: STRANGER }));
    db.todos.push(todoRow({ id: 'tA', goalId: 'gA', projectId: 'pArch', userId: STRANGER, title: 'Archived todo' }));

    await expect(listTodos({ userId: STRANGER })).resolves.toEqual([]); // archived folders leave the list
    const why = await explainEmptyAccountWideTodoList(STRANGER);
    expect(why).toMatch(/1 OWNED project\(s\) are archived \(or under an archived folder\) and still hold 1 todo\(s\)/);
    expect(why).toContain('"Old" (pArch)');
  });

  it('reports the shared exclusion even when the caller owns live projects (they just have no todos)', async () => {
    // OWNER owns live p1 (no todos) + is a member of pShared (1 todo).
    db.projects.push({ id: 'pShared', userId: OTHER, name: 'Shared', path: '/pS', members: [{ userId: OWNER, role: 'editor' }] });
    db.goals.push(goalRow({ id: 'gS', projectId: 'pShared', userId: OTHER }));
    db.todos.push(todoRow({ id: 'tS', goalId: 'gS', projectId: 'pShared', userId: OTHER, title: 'Theirs' }));

    await expect(listTodos({ userId: OWNER })).resolves.toEqual([]);
    const why = await explainEmptyAccountWideTodoList(OWNER);
    expect(why).toMatch(/shared WITH you as a member hold 1 todo\(s\)/);
  });

  it('returns null when the account genuinely holds no readable todos (no phantom hint)', async () => {
    // STRANGER: owns nothing, member of nothing. OWNER: owns live p1 with zero
    // todos and no memberships — nothing excluded, nothing to explain.
    await expect(explainEmptyAccountWideTodoList(STRANGER)).resolves.toBeNull();
    await expect(explainEmptyAccountWideTodoList(OWNER)).resolves.toBeNull();
  });
});

// ── Replay pin: feedback c96ec639 (2026-09-07) ───────────────────────────────
// The fleet supervisor reported a read-path divergence: list_chats supposedly
// showed live chats inside project ids c9e0f4c9…/0e15bb13… while goal_list and
// todo_list scoped to the same ids failed 'Project not found'. Fresh platform
// probes found ZERO chats under either id — the 404s were CONSISTENT, not a
// divergence (the existence-leak guard working as designed on project ids that
// do not exist / own no visible chats). These pins lock the uniform behavior
// the ticket called a bug: scoped listGoals/listTodos on an unknown project id
// reject with the IDENTICAL 404 'Project not found' shape — any future change
// that lets one read path succeed where the other 404s trips this suite.

describe('list read-path consistency (replay pin, feedback c96ec639)', () => {
  it('listGoals scoped to an unknown project id rejects 404 Project not found', async () => {
    await expect(listGoals({ userId: OWNER, projectId: 'c9e0f4c9-fbd6-4bc4-a5c9-8d70c9372c17' }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Project not found' });
  });

  it('listTodos scoped to an unknown project id rejects 404 Project not found', async () => {
    await expect(listTodos({ userId: OWNER, projectId: 'c9e0f4c9-fbd6-4bc4-a5c9-8d70c9372c17' }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Project not found' });
  });

  it('goal_list and todo_list fail with the IDENTICAL shape on the same unknown id (no read-path divergence)', async () => {
    const goalErr: any = await listGoals({ userId: OWNER, projectId: '0e15bb13-13ba-4c28-a2cf-4c98dc93ebd9' }).catch((e: any) => e);
    const todoErr: any = await listTodos({ userId: OWNER, projectId: '0e15bb13-13ba-4c28-a2cf-4c98dc93ebd9' }).catch((e: any) => e);
    expect(goalErr).toMatchObject({ statusCode: 404, message: 'Project not found' });
    expect({ statusCode: goalErr.statusCode, message: goalErr.message })
      .toEqual({ statusCode: todoErr.statusCode, message: todoErr.message });
  });
});

// ── Replay pin: feedback fb3ea311 (2026-09-18) ───────────────────────────────
// The Fleet Supervisor burned a 3× todo_list breaker streak on 'Project not
// found' (ticket fb3ea311): its wake scoped todo_list by the fleet-standard
// 8-char project idiom ('0560b7b8' — the exact shape its own board digests
// display) on a project that EXISTS and is owner-readable. Live triage repro:
// todo_list({projectId:'0560b7b8'}) → 'Project not found' (byte-identical to
// the streak texts); todo_list({projectId:'0560b7b8-3249-…'}) → 44 rows. Root
// cause: the projectId branches of listGoals/listTodos were the fleet's last
// exact-id-only read scopes — goalId got canonicalGoalId in 225b878f4 (tick
// 8), and every other id-taking fleet tool resolves a unique ≥8-char prefix
// (8579d419 reads / 31db672f writes). These pins lock the fix: a unique
// ≥8-char project prefix resolves on BOTH scoped list reads (c96ec639 demands
// identical shapes), the RESOLVED id drives every downstream clause, and the
// guard rails (short / ambiguous / invisible / full-length-miss) keep the
// exact-404 contract.

describe('scoped list reads resolve the 8-char project idiom (replay pin, feedback fb3ea311)', () => {
  const SPARK = {
    id: '0560b7b8-3249-423b-a3cc-b9c8b071831e', userId: OWNER, name: 'spark-cluster',
    path: '/0560b7b8-3249-423b-a3cc-b9c8b071831e', members: [],
  };

  it('todo_list + goal_list scoped to a UNIQUE 8-char project prefix resolve (the streak call shape)', async () => {
    db.projects.push({ ...SPARK });
    db.goals.push(goalRow({ id: 'gS', projectId: SPARK.id, title: 'Spark goal' }));
    db.todos.push(todoRow({ id: 'tS', goalId: 'gS', projectId: SPARK.id, title: 'Spark todo' }));

    const todos = await listTodos({ userId: OWNER, projectId: '0560b7b8' });
    // Rows coming back AT ALL is the mutation pin: a where-clause keyed on the
    // RAW prefix (the review-B1 trap) would return a data-loss-shaped [] here.
    expect(todos.map((t) => t.id)).toEqual(['tS']);
    expect(todos[0].projectName).toBe('spark-cluster');
    expect(mockPrisma.projectTodo.findMany.mock.calls[0][0].where.projectId).toBe(SPARK.id);

    const goals = await listGoals({ userId: OWNER, projectId: '0560b7b8' });
    expect(goals.map((g) => g.id)).toEqual(['gS']);
    expect(goals[0].projectName).toBe('spark-cluster');
  });

  it('includeDescendants with a prefix expands the subtree by the RESOLVED full id', async () => {
    const PARENT = { id: 'aaaaaaaa-0000-4000-8000-0000000000aa', userId: OWNER, name: 'Parent', path: '/aaaaaaaa-0000-4000-8000-0000000000aa', members: [] };
    const CHILD = { id: 'bbbbbbbb-0000-4000-8000-0000000000bb', userId: OWNER, name: 'Child', path: '/aaaaaaaa-0000-4000-8000-0000000000aa/bbbbbbbb-0000-4000-8000-0000000000bb', members: [] };
    db.projects.push(PARENT, CHILD);
    db.goals.push(goalRow({ id: 'gC', projectId: CHILD.id, title: 'Child goal' }));
    const rows = await listGoals({ userId: OWNER, projectId: 'aaaaaaaa', includeDescendants: true });
    // A raw-prefix contains clause ('/aaaaaaaa/') matches NO path segment —
    // the child goal landing proves the expansion keyed on the resolved id.
    expect(rows.some((r) => r.id === 'gC')).toBe(true);
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledWith({
      where: { OR: [{ id: PARENT.id }, { path: { contains: `/${PARENT.id}/` } }] },
      select: { id: true, name: true },
    });
  });

  it('an AMBIGUOUS 8-char prefix (two visible projects share it) 404s identically on both tools — never a silent wrong-project pick', async () => {
    db.projects.push(
      { id: 'cccccccc-0000-4000-8000-000000000001', userId: OWNER, name: 'C1', path: '/cccccccc-0000-4000-8000-000000000001', members: [] },
      { id: 'cccccccc-1111-4000-8000-000000000002', userId: OWNER, name: 'C2', path: '/cccccccc-1111-4000-8000-000000000002', members: [] },
    );
    const goalErr: any = await listGoals({ userId: OWNER, projectId: 'cccccccc' }).catch((e: any) => e);
    const todoErr: any = await listTodos({ userId: OWNER, projectId: 'cccccccc' }).catch((e: any) => e);
    // audit 2026-10-06 T5-3: still a 404 (never a pick), now naming both visible candidates.
    expect(goalErr.statusCode).toBe(404);
    expect(goalErr.message).toMatch(/^Project not found: "cccccccc"\. Did you mean: cccccccc-0000-4000-8000-000000000001 \("C1"\), cccccccc-1111-4000-8000-000000000002 \("C2"\)\?/);
    expect({ statusCode: goalErr.statusCode, message: goalErr.message })
      .toEqual({ statusCode: todoErr.statusCode, message: todoErr.message });
    // Kill switch: the bare legacy 404.
    process.env.PROJECT_ID_SUFFIX_HEAL_DISABLED = '1';
    try {
      await expect(listGoals({ userId: OWNER, projectId: 'cccccccc' })).rejects.toMatchObject({ statusCode: 404, message: 'Project not found' });
    } finally {
      delete process.env.PROJECT_ID_SUFFIX_HEAL_DISABLED;
    }
  });

  it('a <8-char input never resolves — identical 404 on both tools', async () => {
    db.projects.push({ ...SPARK });
    await expect(listTodos({ userId: OWNER, projectId: '0560b7' }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Project not found' });
    await expect(listGoals({ userId: OWNER, projectId: '0560b7' }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Project not found' });
  });

  it('a prefix of a project the CALLER cannot see 404s for them while its owner resolves (no existence leak)', async () => {
    db.projects.push({ id: 'dddddddd-0000-4000-8000-000000000003', userId: OTHER, name: 'Theirs', path: '/dddddddd-0000-4000-8000-000000000003', members: [] });
    db.todos.push(todoRow({ id: 'tOther', goalId: 'gOther', projectId: 'dddddddd-0000-4000-8000-000000000003', userId: OTHER, title: 'Their todo' }));
    await expect(listTodos({ userId: STRANGER, projectId: 'dddddddd' }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Project not found' });
    const rows = await listTodos({ userId: OTHER, projectId: 'dddddddd' });
    expect(rows.map((t) => t.id)).toEqual(['tOther']);
  });

  it('a full-length (36-char) unknown id keeps the exact-id 404 (invented-suffix doctrine) — identical shape both tools', async () => {
    const goalErr: any = await listGoals({ userId: OWNER, projectId: 'eeeeeeee-0000-4000-8000-000000000004' }).catch((e: any) => e);
    const todoErr: any = await listTodos({ userId: OWNER, projectId: 'eeeeeeee-0000-4000-8000-000000000004' }).catch((e: any) => e);
    expect(goalErr).toMatchObject({ statusCode: 404, message: 'Project not found' });
    expect({ statusCode: goalErr.statusCode, message: goalErr.message })
      .toEqual({ statusCode: todoErr.statusCode, message: todoErr.message });
  });

  // audit 2026-10-06 T5-3 (fleet F7): the Fleet Supervisor's 6 'Project not
  // found' calls carried the RIGHT 8-char prefix + a hallucinated suffix.
  describe('audit 2026-10-06 T5-3 — full-shape project id heal', () => {
    const REAL = { id: 'f4f34898-afb7-47ae-9f9b-4c68757d09be', userId: OWNER, name: 'litellm', path: '/f4f34898-afb7-47ae-9f9b-4c68757d09be', members: [] };
    const INVENTED = 'f4f34898-c614-41c7-bf3d-a12b53ad7236';

    it('an invented suffix on a unique visible 8-char prefix resolves on BOTH scoped lists (the replay shape)', async () => {
      db.projects.push({ ...REAL });
      db.goals.push(goalRow({ id: 'gL', projectId: REAL.id, title: 'Gateway goal' }));
      db.todos.push(todoRow({ id: 'tL', goalId: 'gL', projectId: REAL.id, title: 'Gateway todo' }));
      expect((await listGoals({ userId: OWNER, projectId: INVENTED })).map((g) => g.id)).toEqual(['gL']);
      expect((await listTodos({ userId: OWNER, projectId: INVENTED })).map((t) => t.id)).toEqual(['tL']);
      expect(mockPrisma.projectTodo.findMany.mock.calls[0][0].where.projectId).toBe(REAL.id);
    });

    it('resolveProjectIdForTool reports the correction (suffix tier) and a 2-char typo (typo tier); a real id and a plain prefix carry none', async () => {
      db.projects.push({ ...REAL });
      expect(await resolveProjectIdForTool(INVENTED, OWNER)).toEqual({ id: REAL.id, correctedFrom: INVENTED, tier: 'suffix' });
      const typo = 'f4f34898-afb7-47ae-9f9b-4c68757d09bf';
      expect(await resolveProjectIdForTool(typo, OWNER)).toEqual({ id: REAL.id, correctedFrom: typo, tier: 'typo' });
      expect(await resolveProjectIdForTool(REAL.id, OWNER)).toEqual({ id: REAL.id });
      expect(await resolveProjectIdForTool('f4f34898', OWNER)).toEqual({ id: REAL.id });
    });

    it("a project the caller cannot see never heals (no existence leak) — the bare 404", async () => {
      db.projects.push({ ...REAL, userId: OTHER });
      await expect(listGoals({ userId: STRANGER, projectId: INVENTED })).rejects.toMatchObject({ statusCode: 404, message: 'Project not found' });
    });

    it('a garbled (non-prefix) truncation gets a Did-you-mean naming the visible same-prefix project', async () => {
      db.projects.push({ ...REAL });
      const err: any = await listTodos({ userId: OWNER, projectId: 'f4f34898-afb7-47ae-9f9b-4c6875' + 'x' }).catch((e: any) => e);
      expect(err.statusCode).toBe(404);
      expect(err.message).toContain(`Did you mean: ${REAL.id} ("litellm")?`);
    });

    it('kill switch PROJECT_ID_SUFFIX_HEAL_DISABLED=1 restores the exact-id 404', async () => {
      db.projects.push({ ...REAL });
      process.env.PROJECT_ID_SUFFIX_HEAL_DISABLED = '1';
      try {
        await expect(listGoals({ userId: OWNER, projectId: INVENTED })).rejects.toMatchObject({ statusCode: 404, message: 'Project not found' });
        expect(await resolveProjectIdForTool(INVENTED, OWNER)).toEqual({ id: INVENTED });
      } finally {
        delete process.env.PROJECT_ID_SUFFIX_HEAL_DISABLED;
      }
    });
  });
});

// ── audit 2026-10-06 T5-5: compact account-wide goal rows ────────────────────

describe('audit 2026-10-06 T5-5 — compact account-wide goal_list rows', () => {
  const big = (i: number, status = 'active') => ({
    id: `g${i}`, projectId: 'p1', projectName: 'P', title: `Goal ${i}`, description: 'd'.repeat(3000), status,
    blockedReason: status === 'blocked' ? 'waiting on the gateway ' + 'x'.repeat(400) : null, progressNote: null,
    premises: [{ key: 'a', value: 'x'.repeat(2000) }], createdByChatId: null, updatedByChatId: null, updatedByRunId: null,
    createdAt: null, updatedAt: '2026-10-05T00:00:00.000Z',
    todos: [{ id: 't1', title: 'x', status: 'pending' }, { id: 't2', title: 'y', status: 'done' }], dependsOnGoalIds: ['gX'],
  }) as any;

  it('a compact row drops description / premises / the todo list and clips the block reason', () => {
    const row = compactGoalRow(big(1, 'blocked'));
    expect(row).toMatchObject({ id: 'g1', projectId: 'p1', projectName: 'P', title: 'Goal 1', status: 'blocked', todos: { total: 2, open: 1, done: 1 }, premises: 1, dependsOn: 1 });
    expect(row).not.toHaveProperty('description');
    expect(String(row.blockedReason).length).toBeLessThanOrEqual(140);
    expect(JSON.stringify(row).length).toBeLessThan(500);
  });

  it('open goals come first; the char cap truncates with total; 100 full rows (~500k) fit in the cap', () => {
    const rows = [big(1, 'done'), big(2, 'active'), ...Array.from({ length: 98 }, (_, i) => big(i + 3))];
    const full = JSON.stringify(rows).length;
    expect(full).toBeGreaterThan(400_000);
    const c = compactAccountWideGoals(rows, { maxRows: 100, maxChars: 40_000 });
    expect(c.goals[0].id).toBe('g2');
    expect(c.goals.some((g) => g.id === 'g1')).toBe(c.goals.length === 100);
    expect(JSON.stringify(c.goals).length).toBeLessThanOrEqual(40_000);
    const tiny = compactAccountWideGoals(rows, { maxRows: 100, maxChars: 2_000 });
    expect(tiny.truncated).toBe(true);
    expect(tiny.total).toBe(100);
    expect(tiny.goals.length).toBeGreaterThan(0);
  });

  it('GOAL_LIST_COMPACT_DISABLED=1 is the kill switch the tool reads; the cap env is clamped', () => {
    process.env.GOAL_LIST_COMPACT_DISABLED = '1';
    process.env.GOAL_LIST_ACCOUNT_WIDE_MAX_CHARS = '10';
    try {
      expect(goalListCompactDisabled()).toBe(true);
      expect(goalListAccountWideMaxChars()).toBe(40_000);
    } finally {
      delete process.env.GOAL_LIST_COMPACT_DISABLED;
      delete process.env.GOAL_LIST_ACCOUNT_WIDE_MAX_CHARS;
    }
    expect(goalListCompactDisabled()).toBe(false);
  });
});

// ── recomputeDependents (direct) + cycle helpers ─────────────────────────────

describe('recomputeDependents', () => {
  it('goal dep done → dependent goal auto-unblocks through the public entry point', async () => {
    db.goals.push(
      goalRow({ id: 'gA', status: 'done' }),
      goalRow({ id: 'gB', status: 'blocked', blockedReason: `${DEPS_BLOCK_PREFIX} Waiting on 1 goal` }),
    );
    db.goalDeps.push({ goalId: 'gB', dependsOnGoalId: 'gA' });
    await recomputeDependents('gA', 'goal', OWNER);
    expect(goalById('gB')).toMatchObject({ status: 'active', blockedReason: null });
  });

  it("goal dep re-activated → dependent goal becomes blocked '[deps]' and emits goal_blocked", async () => {
    db.goals.push(
      goalRow({ id: 'gA', status: 'active', createdByChatId: 'c-a' }),
      goalRow({ id: 'gB', status: 'active', createdByChatId: 'c-b' }),
    );
    db.goalDeps.push({ goalId: 'gB', dependsOnGoalId: 'gA' });
    // Simulate gA transitioning done → active: dependents recompute.
    await recomputeDependents('gA', 'goal', OWNER);
    expect(goalById('gB')).toMatchObject({ status: 'blocked', blockedReason: `${DEPS_BLOCK_PREFIX} Waiting on 1 goal` });
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c-b', 'goal_blocked', 'Goal blocked: Goal 1 (waiting on 1 goals)');
  });

  it('BFS walks the transitive closure and never re-blocks done/archived dependents', async () => {
    db.goals.push(
      goalRow({ id: 'gA', status: 'active' }),
      goalRow({ id: 'gB', status: 'active' }),
      goalRow({ id: 'gC', status: 'done' }),
    );
    db.goalDeps.push({ goalId: 'gB', dependsOnGoalId: 'gA' }, { goalId: 'gC', dependsOnGoalId: 'gB' });
    await recomputeDependents('gA', 'goal', OWNER);
    expect(goalById('gB').status).toBe('blocked');
    expect(goalById('gC').status).toBe('done'); // done rows are never re-blocked
  });

  it('a manually blocked dependent goal stays blocked when deps clear', async () => {
    db.goals.push(
      goalRow({ id: 'gA', status: 'done' }),
      goalRow({ id: 'gB', status: 'blocked', blockedReason: 'Blocked manually' }),
    );
    db.goalDeps.push({ goalId: 'gB', dependsOnGoalId: 'gA' });
    await recomputeDependents('gA', 'goal', OWNER);
    expect(goalById('gB')).toMatchObject({ status: 'blocked', blockedReason: 'Blocked manually' });
    expect(auditActions()).not.toContain('goal.auto_unblock');
  });
});

describe('cycle helpers', () => {
  it('wouldCreateGoalCycle detects reaching self through the chain and allows acyclic adds', async () => {
    db.goals.push(goalRow({ id: 'gA' }), goalRow({ id: 'gB' }), goalRow({ id: 'gC' }));
    db.goalDeps.push({ goalId: 'gA', dependsOnGoalId: 'gB' }, { goalId: 'gB', dependsOnGoalId: 'gC' });
    await expect(wouldCreateGoalCycle('gC', ['gA'], OWNER)).resolves.toBe(true);  // gC→gA→gB→gC
    await expect(wouldCreateGoalCycle('gC', ['gB'], OWNER)).resolves.toBe(true);  // gC→gB→gC (2-cycle)
    await expect(wouldCreateGoalCycle('gA', ['gC'], OWNER)).resolves.toBe(false); // downstream add stays acyclic
    await expect(wouldCreateGoalCycle('gA', [], OWNER)).resolves.toBe(false);
  });

  it('wouldCreateTodoCycle mirrors the goal check', async () => {
    db.todos.push(todoRow({ id: 'tA' }), todoRow({ id: 'tB' }));
    db.todoDeps.push({ todoId: 'tA', dependsOnTodoId: 'tB' });
    await expect(wouldCreateTodoCycle('tB', ['tA'], OWNER)).resolves.toBe(true);
    await expect(wouldCreateTodoCycle('tA', ['tB'], OWNER)).resolves.toBe(false); // existing edge, no cycle
  });
});


// ── Resume propagation (2026-08-30 fleet audit) ──────────────────────────────
// wakeTodoAssignee: a todo becoming ACTIONABLE for an assignee wakes that chat
// through the hook outbox (enqueueDirectWake — the durable lane, pinned in
// goals.wake.v1-7 below). Bounds: 5-min per-chat Redis debounce, never throws.

describe('todo wakes (resume propagation)', () => {
  beforeEach(() => {
    // mockReset (not just clear): per-test resolved/rejected overrides must not leak.
    mockEnqueueDirectWake.mockReset().mockResolvedValue({ ok: true, hookEventId: 'he-1' });
    mockRedisSet.mockReset();
    mockRedisSet.mockResolvedValue('OK'); // debounce gate free by default
  });

  it('createTodo with an assignee wakes that chat (actionable prompt)', async () => {
    db.goals.push(goalRow());
    await createTodo({ userId: OWNER, goalId: 'g1', title: 'Run the Hopper bench', assigneeChatId: 'c-lane' });
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    const arg = mockEnqueueDirectWake.mock.calls[0][0];
    expect(arg.targetChatId).toBe('c-lane');
    expect(arg.prompt).toContain('ASSIGNED');
    expect(arg.prompt).toContain('Run the Hopper bench');
    expect(arg.prompt).toContain('Goal 1');
  });

  it('createTodo BLOCKED by open deps does NOT wake (it wakes on auto-unblock later)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 't-dep', status: 'pending' }));
    await createTodo({ userId: OWNER, goalId: 'g1', title: 'Gated leg', assigneeChatId: 'c-lane', dependsOnTodoIds: ['t-dep'] });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('createTodo with NO assignee never wakes', async () => {
    db.goals.push(goalRow());
    await createTodo({ userId: OWNER, goalId: 'g1', title: 'Unassigned leg' });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('manual unblock (blocked → pending) wakes the assignee as UNBLOCKED', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 't1', status: 'blocked', blockedReason: 'SSH key pulled', assigneeChatId: 'c-lane' }));
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'pending' });
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    const prompt = mockEnqueueDirectWake.mock.calls[0][0].prompt;
    expect(prompt).toContain('UNBLOCKED');
    // Ticket 85856e4f: the wake names its transition + stamps the send-time so
    // a late-delivered lane can judge staleness against the todo's updatedAt.
    expect(prompt).toContain('blocked → actionable');
    expect(prompt).toMatch(/wake sent \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('reassigning an actionable todo wakes the NEW assignee', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 't1', status: 'pending', assigneeChatId: 'c-old' }));
    await updateTodo({ userId: OWNER, todoId: 't1', assigneeChatId: 'c-new' });
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    expect(mockEnqueueDirectWake.mock.calls[0][0].targetChatId).toBe('c-new');
    expect(mockEnqueueDirectWake.mock.calls[0][0].prompt).toContain('ASSIGNED');
  });

  it('marking a todo done does NOT wake (todo_done emission is the existing path)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 't1', status: 'in_progress', assigneeChatId: 'c-lane' }));
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'done' });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('dep auto-unblock wakes the dependent todo\'s assignee', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 't-dep', status: 'pending' }));
    db.todos.push(todoRow({ id: 't1', status: 'blocked', blockedReason: `${DEPS_BLOCK_PREFIX} Waiting on 1 todo`, assigneeChatId: 'c-lane' }));
    db.todoDeps.push({ todoId: 't1', dependsOnTodoId: 't-dep' });
    await updateTodo({ userId: OWNER, todoId: 't-dep', status: 'done' });
    expect(db.todos.find((t) => t.id === 't1')?.status).toBe('pending');
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    expect(mockEnqueueDirectWake.mock.calls[0][0].targetChatId).toBe('c-lane');
    expect(mockEnqueueDirectWake.mock.calls[0][0].prompt).toContain('UNBLOCKED');
  });

  it('the 5-min debounce gate suppresses a second wake (batch planning coalesces)', async () => {
    mockRedisSet.mockResolvedValue(null); // gate already held this window
    db.goals.push(goalRow());
    await createTodo({ userId: OWNER, goalId: 'g1', title: 'Second leg', assigneeChatId: 'c-lane' });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('a wake failure never fails the todo write', async () => {
    mockEnqueueDirectWake.mockRejectedValueOnce(new Error('outbox exploded'));
    db.goals.push(goalRow());
    await expect(createTodo({ userId: OWNER, goalId: 'g1', title: 'Fragile leg', assigneeChatId: 'c-lane' })).resolves.toMatchObject({ title: 'Fragile leg' });
  });
});

// ── Remediation P2 S2a — typed block provenance (blockKind + gateQuestionId) ──
describe('S2a — blockKind + gateQuestionId', () => {
  it('updateTodo accepts blockKind + gateQuestionId with a blocked transition and returns them in the view', async () => {
    db.todos.push(todoRow());
    db.ownerQuestions.push({ id: 'oq_gate1234-aaaa', userId: OWNER, status: 'open' });
    const v = await updateTodo({
      userId: OWNER, todoId: 't1', status: 'blocked', blockedReason: 'Awaiting owner decision',
      blockKind: 'owner', gateQuestionId: 'oq_gate1234-aaaa',
    });
    expect(v.status).toBe('blocked');
    expect(v.blockKind).toBe('owner');
    expect(v.gateQuestionId).toBe('oq_gate1234-aaaa');
  });

  it('rejects an invalid blockKind with a 400 naming the enum', async () => {
    db.todos.push(todoRow());
    await expect(updateTodo({ userId: OWNER, todoId: 't1', status: 'blocked', blockKind: 'weird' }))
      .rejects.toThrow(/blockKind must be one of: deps, owner, agent, external/);
  });

  it('UNBLOCKING clears blockKind + gateQuestionId along with the reason', async () => {
    db.todos.push(todoRow({ status: 'blocked', blockedReason: 'Awaiting owner', blockKind: 'owner', gateQuestionId: 'oq_x' }));
    const v = await updateTodo({ userId: OWNER, todoId: 't1', status: 'in_progress' });
    expect(v.blockedReason).toBeNull();
    expect(v.blockKind).toBeNull();
    expect(v.gateQuestionId).toBeNull();
  });

  it('null clears gateQuestionId without touching the block', async () => {
    db.todos.push(todoRow({ status: 'blocked', blockedReason: 'Awaiting owner', blockKind: 'owner', gateQuestionId: 'oq_x' }));
    const v = await updateTodo({ userId: OWNER, todoId: 't1', gateQuestionId: null });
    expect(v.status).toBe('blocked');
    expect(v.gateQuestionId).toBeNull();
    expect(v.blockKind).toBe('owner');
  });

  it('updateGoal accepts blockKind + gateQuestionId too', async () => {
    db.goals.push(goalRow());
    db.ownerQuestions.push({ id: 'oq_goal5678-bbbb', userId: OWNER, status: 'open' });
    const v = await updateGoal({
      userId: OWNER, goalId: 'g1', status: 'blocked', blockedReason: 'Needs owner sign-off',
      blockKind: 'owner', gateQuestionId: 'oq_goal5678-bbbb',
    });
    expect(v.blockKind).toBe('owner');
    expect(v.gateQuestionId).toBe('oq_goal5678-bbbb');
  });
});

// ── P4 v1#10 — machine-close todo evidence ────────────────────────────────────

// Gate flip 2026-09-11 (owner: full steam): the machine-close evidence gate is
// gone — an evidence-less machine close LANDS, force:true is honoured
// (audited), and the goal cascade is unconditional; the old
// TODO_EVIDENCE_DISABLED kill-switch is retired.
describe('todo evidence (P4 v1#10 → observe-only since the 2026-09-11 gate flip)', () => {
  afterEach(() => {
    delete process.env.TODO_EVIDENCE_DISABLED;
  });

  it('a machine-triggered done WITHOUT evidence LANDS by default and cascades goal auto-done', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    const view = await updateTodo({ userId: OWNER, todoId: 't1', status: 'done', machineTriggered: true, doneRunId: 'run-77' });
    expect(view.status).toBe('done');
    expect(todoById('t1')!.status).toBe('done');
    expect(todoById('t1')!.doneRunId).toBe('run-77');
    expect(goalById('g1')!.status).toBe('done'); // cascade is unconditional now
  });

  it('a machine-triggered done WITH evidence lands, stores evidence + doneRunId, and cascades goal auto-done', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    const view = await updateTodo({
      userId: OWNER, todoId: 't1', status: 'done',
      machineTriggered: true, evidence: 'PR #300 opened — receipt aaaabbbb', doneRunId: 'run-42',
    });
    expect(view.status).toBe('done');
    expect(todoById('t1')!.evidence).toBe('PR #300 opened — receipt aaaabbbb');
    expect(todoById('t1')!.doneRunId).toBe('run-42');
    expect(goalById('g1')!.status).toBe('done'); // cascade proceeded (evidence carried)
    expect(auditActions()).toContain('goal.auto_done');
  });

  it('force:true is HONOURED for machine-triggered runs by default (audited as todo.force_done)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 't1' }));
    db.todos.push(todoRow({ id: 't0', title: 'dep', status: 'pending' }));
    db.todoDeps.push({ todoId: 't1', dependsOnTodoId: 't0' });
    const view = await updateTodo({
      userId: OWNER, todoId: 't1', status: 'done', force: true,
      machineTriggered: true, evidence: 'sha 84fe3ae0d1 pushed',
    });
    expect(view.status).toBe('done');
    expect(auditActions()).toContain('todo.force_done');
  });

  it('user-present closes are UNCHANGED — no evidence needed, cascade fires', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    const view = await updateTodo({ userId: OWNER, todoId: 't1', status: 'done' });
    expect(view.status).toBe('done');
    expect(goalById('g1')!.status).toBe('done');
  });

  it('the retired TODO_EVIDENCE_DISABLED kill-switch is inert (its semantics are now the default; the cascade is no longer withheld)', async () => {
    process.env.TODO_EVIDENCE_DISABLED = '1';
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    const view = await updateTodo({ userId: OWNER, todoId: 't1', status: 'done', machineTriggered: true });
    expect(view.status).toBe('done');
    expect(goalById('g1')!.status).toBe('done'); // unconditional cascade (parity with user-present closes)
  });
});

// ── P4 v1#9 — reopen recompute (the done-path cascade mirrored in reverse) ────

describe('todo reopen recompute (P4 v1#9)', () => {
  it('done→pending re-blocks dependents and reopens the auto-done goal', async () => {
    db.goals.push(goalRow({ status: 'done' })); // auto-done earlier
    db.todos.push(todoRow({ id: 't1', status: 'done', evidence: 'PR #300', doneRunId: 'run-9' }));
    db.todos.push(todoRow({ id: 't2', title: 'Dependent', status: 'pending' }));
    db.todoDeps.push({ todoId: 't2', dependsOnTodoId: 't1' });

    await updateTodo({ userId: OWNER, todoId: 't1', status: 'pending' });

    // Dependent re-blocked on the reopened dep (the reverse of auto-unblock).
    expect(todoById('t2')!.status).toBe('blocked');
    expect(String(todoById('t2')!.blockedReason)).toContain(DEPS_BLOCK_PREFIX);
    // The done goal reopened (audited), mirroring maybeAutoCompleteGoal.
    expect(goalById('g1')!.status).toBe('active');
    expect(auditActions()).toContain('goal.auto_reopen');
    // The stored closing evidence no longer stands.
    expect(todoById('t1')!.evidence).toBeNull();
    expect(todoById('t1')!.doneRunId).toBeNull();
  });

  it('reopening a todo under an ARCHIVED goal leaves the goal archived', async () => {
    db.goals.push(goalRow({ status: 'archived' }));
    db.todos.push(todoRow({ id: 't1', status: 'done' }));
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'in_progress' });
    expect(goalById('g1')!.status).toBe('archived');
  });

  // Ticket 2a6e3238: a todo created under a DONE goal reopens it. The auto-done
  // cascade closes goals whose todos finished, but createTodo never consulted
  // the goal's status — new work landed under a done goal and the board then
  // contradicted the ledger (supervisor asserted "active" from memory while
  // the row said done; the lane's very next createTodo froze the stale state
  // in place). Symmetry: createTodo reopens the done goal AFTER the todo row
  // exists (a failed create must never reopen anything).
  it('creating a todo under a DONE goal reopens it (ticket 2a6e3238)', async () => {
    db.goals.push(goalRow({ status: 'done' })); // auto-done earlier, no live todos

    const r = await createTodo({ userId: OWNER, goalId: 'g1', title: 'Follow-up' });

    // The new todo exists and is actionable…
    expect(todoById(r.id)).toBeTruthy();
    expect(todoById(r.id)!.status).toBe('pending');
    // …and the goal reopened to match its now-open work (audited, like v1#9).
    expect(goalById('g1')!.status).toBe('active');
    expect(auditActions()).toContain('goal.auto_reopen');
  });

  it('creating a todo under an ARCHIVED goal leaves the goal archived (create path)', async () => {
    db.goals.push(goalRow({ status: 'archived' }));
    await createTodo({ userId: OWNER, goalId: 'g1', title: 'Into the attic' });
    expect(goalById('g1')!.status).toBe('archived');
    expect(auditActions()).not.toContain('goal.auto_reopen');
  });
});

/* ====================================================================
 * P3 remediation — v1#7: DURABLE todo wakes (the default lane).
 * The unblock/assign wake now routes through the hook outbox
 * (hooks.service.enqueueDirectWake) as an alarm-class direct wake — a busy
 * assignee parks it, a spent cap does not silence it, and process death
 * cannot lose it. The debounce key is RELEASED whenever nothing was actually
 * enqueued (before, a failed wake ate the whole 5-min window).
 * ==================================================================== */
describe('todo wakes — durable lane (v1#7)', () => {
  const resetWakeMocks = () => {
    mockEnqueueDirectWake.mockReset().mockResolvedValue({ ok: true, hookEventId: 'he-1' });
    mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
    mockDailyCapExceeded.mockReset().mockResolvedValue(null);
    mockRedisSet.mockReset().mockResolvedValue('OK');
    mockRedisDel.mockReset().mockResolvedValue(1);
  };
  beforeEach(resetWakeMocks);
  // Later describes read these shared mocks — leave them as this block found them.
  afterEach(resetWakeMocks);

  it('routes the assignee wake through the hook outbox — never a direct fire, never a cap pre-check', async () => {
    db.goals.push(goalRow());
    await createTodo({ userId: OWNER, goalId: 'g1', title: 'Durable leg', assigneeChatId: 'c-lane' });
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    const arg = mockEnqueueDirectWake.mock.calls[0][0];
    expect(arg.targetChatId).toBe('c-lane');
    expect(arg.prompt).toContain('ASSIGNED');
    expect(arg.prompt).toContain('Durable leg');
    expect(arg.meta).toMatchObject({ trigger: 'assigned' });
    // The legacy direct-fire lane is NOT touched: delivery (busy park, cap
    // bypass, refund) is the hook sweep's job now.
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockDailyCapExceeded).not.toHaveBeenCalled();
  });

  it('releases the 5-min debounce key when the enqueue FAILED (v1#7 — a lost wake must not eat the window)', async () => {
    mockEnqueueDirectWake.mockResolvedValue({ ok: false, error: 'db down' });
    db.goals.push(goalRow());
    await createTodo({ userId: OWNER, goalId: 'g1', title: 'Failed leg', assigneeChatId: 'c-lane' });
    expect(mockRedisDel).toHaveBeenCalledWith('fleet:todowake:c-lane');
  });

  it('keeps the debounce key when the enqueue SUCCEEDED (one wake per window)', async () => {
    db.goals.push(goalRow());
    await createTodo({ userId: OWNER, goalId: 'g1', title: 'Kept leg', assigneeChatId: 'c-lane' });
    expect(mockRedisDel).not.toHaveBeenCalledWith('fleet:todowake:c-lane');
  });

  it('a held debounce window skips the enqueue entirely', async () => {
    mockRedisSet.mockResolvedValue(null); // another wake owns this window
    db.goals.push(goalRow());
    await createTodo({ userId: OWNER, goalId: 'g1', title: 'Debounced leg', assigneeChatId: 'c-lane' });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(mockRedisDel).not.toHaveBeenCalledWith('fleet:todowake:c-lane');
  });
});

// ── Remediation P7: 'dropped' status (N5) + progressNote/startedAt (v1#20) ────

describe("P7 N5 — 'dropped' todo status", () => {
  afterEach(() => {
    delete process.env.TODO_EVIDENCE_DISABLED;
  });

  it('a machine-triggered drop WITHOUT evidence LANDS by default (gate flip 2026-09-11)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    const view = await updateTodo({ userId: OWNER, todoId: 't1', status: 'dropped', machineTriggered: true });
    expect(view.status).toBe('dropped');
  });

  it('a machine drop WITH evidence lands, stores the citation, and clears any block provenance', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ status: 'blocked', blockedReason: 'waiting on GPU quota', blockKind: 'external' }));
    const view = await updateTodo({
      userId: OWNER, todoId: 't1', status: 'dropped',
      machineTriggered: true, evidence: 'Owner directive oq_11112222: cancel the GPU workstream', doneRunId: 'run-7',
    });
    expect(view.status).toBe('dropped');
    expect(todoById('t1')!.evidence).toContain('oq_11112222');
    expect(todoById('t1')!.blockedReason).toBeNull();
    expect(todoById('t1')!.blockKind).toBeNull();
  });

  it('dropped SATISFIES dependents (TODO_DONE_ISH) — the dependent unblocks', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 't1' }));
    db.todos.push(todoRow({ id: 't2', title: 'Dependent', status: 'blocked', blockedReason: '[deps] Waiting on 1 todo' }));
    db.todoDeps.push({ todoId: 't2', dependsOnTodoId: 't1' });
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'dropped' });
    expect(todoById('t2')!.status).toBe('pending'); // auto-unblocked — cancelled work stops gating
  });

  it('a goal auto-completes over done+dropped todos, but an ALL-dropped board never does', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 't1', status: 'done' }));
    db.todos.push(todoRow({ id: 't2', title: 'Cancelled leg', status: 'pending' }));
    await updateTodo({ userId: OWNER, todoId: 't2', status: 'dropped' });
    expect(goalById('g1')!.status).toBe('done'); // done + dropped ⇒ complete

    db.goals.push(goalRow({ id: 'g2' }));
    db.todos.push(todoRow({ id: 't3', goalId: 'g2', status: 'pending' }));
    await updateTodo({ userId: OWNER, todoId: 't3', status: 'dropped' });
    expect(goalById('g2')!.status).toBe('active'); // nothing was accomplished
  });

  it('reopening a dropped todo clears the citation (the P4 reopen contract)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ status: 'dropped', evidence: 'oq_1: cancelled', doneRunId: 'run-1' }));
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'pending' });
    expect(todoById('t1')!.evidence).toBeNull();
    expect(todoById('t1')!.doneRunId).toBeNull();
  });

  it('a drop never wakes the assignee (terminal — nothing to resume)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ status: 'blocked', blockedReason: 'stuck', assigneeChatId: 'c-lane' }));
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'dropped' });
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('listTodos accepts the dropped filter; garbage statuses still 400', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ status: 'dropped' }));
    const rows = await listTodos({ userId: OWNER, goalId: 'g1', status: 'dropped' as any });
    expect(rows).toHaveLength(1);
    await expect(listTodos({ userId: OWNER, goalId: 'g1', status: 'parked' as any }))
      .rejects.toThrow(/status must be one of: pending, in_progress, blocked, done, dropped/);
  });
});

describe('P7 v1#20 — progressNote + startedAt', () => {
  it('todo progressNote stores trimmed/capped and clears on null; no status change required', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    // Ticket a8d6e514: the storage cap is 2,000 (a standing loop's continuation ledger survives); 300 chars round-trip whole.
    const long = 'x'.repeat(300);
    const view = await updateTodo({ userId: OWNER, todoId: 't1', progressNote: `  ${long}  ` });
    expect(view.progressNote).toBe(long);
    const huge = await updateTodo({ userId: OWNER, todoId: 't1', progressNote: 'y'.repeat(2500) });
    expect(huge.progressNote).toHaveLength(2000);
    expect(todoById('t1')!.status).toBe('pending'); // untouched
    const cleared = await updateTodo({ userId: OWNER, todoId: 't1', progressNote: null });
    expect(cleared.progressNote).toBeNull();
  });

  it('a8d6e514 kill switch: PROGRESS_NOTE_LONG_DISABLED=1 caps the stored note at 200 again', async () => {
    process.env.PROGRESS_NOTE_LONG_DISABLED = '1';
    try {
      db.goals.push(goalRow());
      db.todos.push(todoRow());
      const view = await updateTodo({ userId: OWNER, todoId: 't1', progressNote: 'x'.repeat(300) });
      expect(view.progressNote).toHaveLength(200);
    } finally {
      delete process.env.PROGRESS_NOTE_LONG_DISABLED;
    }
  });

  it('startedAt stamps ONCE on the first in_progress transition and survives later transitions', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    const first = await updateTodo({ userId: OWNER, todoId: 't1', status: 'in_progress' });
    expect(first.startedAt).toBeTruthy();
    const stamped = todoById('t1')!.startedAt;
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'pending' });
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'in_progress' });
    expect(todoById('t1')!.startedAt).toBe(stamped); // never re-stamped
  });

  it('goal progressNote rides updateGoal and the view', async () => {
    db.goals.push(goalRow());
    const g = await updateGoal({ userId: OWNER, goalId: 'g1', progressNote: '3/5 shards trained, loss 2.1' });
    expect(g.progressNote).toBe('3/5 shards trained, loss 2.1');
    const cleared = await updateGoal({ userId: OWNER, goalId: 'g1', progressNote: '' });
    expect(cleared.progressNote).toBeNull();
  });
});

// ── CanLaw stall 2026-09-15 — phantom deps blocks + unbacked owner-decision claims ──
// Both CanLaw HALT todos sat "blocked: deps" for a day with EVERY dependency
// done (nothing could auto-clear them; the card said "waiting on other work to
// finish first") while their reasons claimed an owner decision no owner question
// backed. The framework's own dependency model is the truth for the first; the
// second is told to the lane that wrote it.
describe("phantom deps block → blockKind 'deps' with zero open dependencies is recorded as 'agent'", () => {
  it('todo: coerced to agent, audited, and the result carries the note', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow(), todoRow({ id: 't0', title: 'Done dep', status: 'done' }));
    db.todoDeps.push({ todoId: 't1', dependsOnTodoId: 't0' });
    const v = await updateTodo({
      userId: OWNER, todoId: 't1', status: 'blocked',
      blockedReason: "owner's HALT-band decision MADE — training stays stopped", blockKind: 'deps',
    });
    expect(v.status).toBe('blocked');
    expect(v.blockKind).toBe('agent');
    expect(v.blockKindNote).toBe(phantomDepsBlockNote('todo'));
    expect(v.blockKindNote).toContain('no open dependency EDGE is recorded');
    expect(v.blockKindNote).toContain('dependsOnTodoIds');
    expect(v.blockKindNote).toContain('flag_owner_question');
    expect(todoById('t1')!.blockKind).toBe('agent');
    expect(auditActions()).toContain('todo.block_kind_coerced');
  });

  it("todo: 'deps' with an OPEN dependency stays 'deps' — no note", async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow(), todoRow({ id: 't0', title: 'Open dep', status: 'in_progress' }));
    db.todoDeps.push({ todoId: 't1', dependsOnTodoId: 't0' });
    const v = await updateTodo({ userId: OWNER, todoId: 't1', status: 'blocked', blockedReason: 'waiting on t0', blockKind: 'deps' });
    expect(v.blockKind).toBe('deps');
    expect(v.blockKindNote).toBeUndefined();
  });

  it("todo: a standalone blockKind:'deps' refresh on an already-blocked row with NO dependencies at all is coerced too", async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ status: 'blocked', blockedReason: 'HALT confirmed', blockKind: 'owner' }));
    const v = await updateTodo({ userId: OWNER, todoId: 't1', blockKind: 'deps' });
    expect(v.status).toBe('blocked');
    expect(v.blockKind).toBe('agent');
    expect(v.blockKindNote).toBe(phantomDepsBlockNote('todo'));
  });

  it("todo: 'owner' / 'external' / 'agent' kinds are never touched", async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    const v = await updateTodo({ userId: OWNER, todoId: 't1', status: 'blocked', blockedReason: 'x', blockKind: 'external' });
    expect(v.blockKind).toBe('external');
    expect(v.blockKindNote).toBeUndefined();
  });

  it("goal: 'deps' with zero open goal dependencies is recorded as 'agent' with the goal note", async () => {
    db.goals.push(goalRow(), goalRow({ id: 'g0', title: 'Done goal', status: 'done' }));
    db.goalDeps.push({ goalId: 'g1', dependsOnGoalId: 'g0' });
    const g = await updateGoal({ userId: OWNER, goalId: 'g1', status: 'blocked', blockedReason: 'owner HALT', blockKind: 'deps' });
    expect(g.status).toBe('blocked');
    expect(g.blockKind).toBe('agent');
    expect(g.blockKindNote).toBe(phantomDepsBlockNote('goal'));
    expect(auditActions()).toContain('goal.block_kind_coerced');
  });
});

describe('noteUnbackedOwnerWaitClaim — the lane that wrote an owner-decision claim with no owner question is told (once per row per 24h, durable)', () => {
  const TODO_ID = 'dc507413-4f1a-4a6b-a0db-094464438c74';
  const claim = (over: any = {}) => ({
    userId: OWNER, entity: 'todo' as const, id: TODO_ID, title: 'Full SFT-2 training on GO',
    blockedReason: "2026-09-14T05:04Z supervisor refresh: owner's HALT-band decision MADE — training stays stopped",
    laneChatId: 'c-lane', projectId: 'p1', surface: 'project_digest', ...over,
  });

  it('wakes the assignee lane AND the project supervisor through the durable hook outbox; audits', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'c-sup' });
    const r = await noteUnbackedOwnerWaitClaim(claim());
    expect([...r.woken].sort()).toEqual(['c-lane', 'c-sup']);
    expect(mockRedisSet).toHaveBeenCalledWith(`fleet:ownerclaim:todo:${TODO_ID}`, '1', { NX: true, EX: 24 * 60 * 60 });
    // Owner-scoped lookup (defense in depth — never a foreign project's supervisor).
    expect(mockPrisma.crossModelChat.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: OWNER, projectId: 'p1', isProjectSupervisor: true, archivedAt: null },
    }));
    // The supervisor leg took its own hourly key.
    expect(mockRedisSet).toHaveBeenCalledWith('fleet:ownerclaim:sup:c-sup', '1', { NX: true, EX: OWNER_CLAIM_SUPERVISOR_TTL_SEC });
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(2);
    const first = mockEnqueueDirectWake.mock.calls[0][0];
    expect(first.meta).toEqual(expect.objectContaining({ todoId: TODO_ID, trigger: 'owner_claim_unbacked', surface: 'project_digest' }));
    expect(auditActions()).toContain('todo.owner_claim_wake');
  });

  it('the wake text names the row, quotes the claim, says no owner question backs it, and tells the lane the gate is its own to lift — or to re-file the real decision', () => {
    const prompt = buildUnbackedOwnerClaimPrompt({ ...claim(), now: NOW });
    // Behaviour pins: names the row, quotes the claim, claims ONLY what the
    // caller verified (no OPEN question), sends the lane to the owner's actual
    // words, and offers exactly two exits.
    expect(prompt).toContain('this todo claims an OWNER decision that does not exist');
    expect(prompt).toContain('"Full SFT-2 training on GO" (dc507413)');
    expect(prompt).toContain("owner's HALT-band decision MADE");
    expect(prompt).toContain('NO OPEN owner question backs it');
    expect(prompt).not.toMatch(/none was answered with a decision/);
    expect(prompt).toContain('list_owner_questions');
    expect(prompt).toContain('yours to lift');
    expect(prompt).toContain('says stop is honoured by dropping or closing the work');
    expect(prompt).toContain('todo_get');
    expect(prompt).toContain('flag_owner_question');
    expect(prompt).toContain(`wake sent ${NOW.toISOString()}; surface project_digest`);
  });

  it('is deduped per row per 24h (Redis NX miss → no wake), and the key is released when there is nobody to tell', async () => {
    mockRedisSet.mockResolvedValueOnce(null);
    expect((await noteUnbackedOwnerWaitClaim(claim())).woken).toEqual([]);
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    // No lane, no project supervisor → nothing to tell → the 24h key is released so a later target is not shadowed.
    mockRedisSet.mockResolvedValueOnce('OK');
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
    expect((await noteUnbackedOwnerWaitClaim(claim({ laneChatId: null }))).woken).toEqual([]);
    expect(mockRedisDel).toHaveBeenCalledWith(`fleet:ownerclaim:todo:${TODO_ID}`);
  });

  it('never throws — an outbox failure returns woken:[] and releases the key', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
    mockEnqueueDirectWake.mockResolvedValueOnce({ ok: false, error: 'boom' });
    expect((await noteUnbackedOwnerWaitClaim(claim())).woken).toEqual([]);
    expect(mockRedisDel).toHaveBeenCalledWith(`fleet:ownerclaim:todo:${TODO_ID}`);
  });

  it('an outbox THROW is swallowed and the 24h key is released too (a transient error must not suppress the wake for a day)', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
    mockEnqueueDirectWake.mockRejectedValueOnce(new Error('redis down'));
    expect((await noteUnbackedOwnerWaitClaim(claim())).woken).toEqual([]);
    expect(mockRedisDel).toHaveBeenCalledWith(`fleet:ownerclaim:todo:${TODO_ID}`);
  });

  it('the project supervisor hears about phantom claims at most once an hour — a second row in the same hour wakes only its own lane', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'c-sup' });
    // Row key claimed; supervisor hourly key already taken by an earlier row.
    mockRedisSet.mockImplementation(async (key: string) => (key.startsWith('fleet:ownerclaim:sup:') ? null : 'OK'));
    const r = await noteUnbackedOwnerWaitClaim(claim({ id: 'ed5ad2d8-1498-44ef-8fa8-4738a481f53d', title: 'RL-1' }));
    expect(r.woken).toEqual(['c-lane']);
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    mockRedisSet.mockImplementation(async () => 'OK');
  });

  it('a Redis SET rejection is a skipped pass (warned), never a 24h suppression and never a throw', async () => {
    mockRedisSet.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect((await noteUnbackedOwnerWaitClaim(claim())).woken).toEqual([]);
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });
});

// ── CanLaw stall 2026-09-15 — an owner COUNTER-QUESTION releases a gate as the team's own, never as "START now" ──
describe("unblockOwnerGatedItems with counterQuestion — the row stays blocked as the team's own gate; the assignee answers first", () => {
  const Q = 'CANLAW HALT-BAND DECISION: corrected score 24.46% — what is your call on the path forward?';
  const A = "well didn't we change the benchmark a ton in between this?";

  it('todo: blocked stays blocked — blockKind agent, card unlinked, reason quotes the owner asking back; audit owner_gate_asked_back; the assignee gets the asked-back wake, not START-now', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ status: 'blocked', blockedReason: 'Awaiting owner decision', blockKind: 'owner', gateQuestionId: 'oq_gate1', assigneeChatId: 'c-lane' }));
    const out = await unblockOwnerGatedItems({ userId: OWNER, questionId: 'oq_gate1', question: Q, answer: A, source: 'owner inbox answer', counterQuestion: true });
    expect(out).toEqual({ todos: 1, goals: 0, heldTodos: 0, heldGoals: 0 });
    const t = todoById('t1')!;
    expect(t.status).toBe('blocked');
    expect(t.blockKind).toBe('agent');
    expect(t.gateQuestionId).toBeNull();
    expect(t.blockedReason).toContain('Owner asked back on this gate');
    expect(t.blockedReason).toContain(A);
    expect(t.blockedReason).toContain('no decision');
    expect(t.blockedReason).not.toMatch(/owner decision|awaiting owner|owner's .* (decision|call)/i); // never reads as an owner wait
    expect(auditActions()).toContain('todo.owner_gate_asked_back');
    expect(auditActions()).not.toContain('todo.owner_gate_unblock');
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    const prompt = mockEnqueueDirectWake.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('WITH A QUESTION, not a decision');
    expect(prompt).toContain('answer the owner');
    expect(prompt).toContain('flag_owner_question');
    expect(prompt).not.toContain('START it now');
    expect(mockEnqueueDirectWake.mock.calls[0][0].meta).toEqual(expect.objectContaining({ trigger: 'owner_asked_back' }));
  });

  it('todo: an assignee the answer already woke is NOT woken again (skipWakeChatIds)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ status: 'blocked', blockedReason: 'Awaiting owner', blockKind: 'owner', gateQuestionId: 'oq_gate1', assigneeChatId: 'c-lane' }));
    await unblockOwnerGatedItems({ userId: OWNER, questionId: 'oq_gate1', question: Q, answer: A, source: 'owner inbox answer', counterQuestion: true, skipWakeChatIds: ['c-lane'] });
    expect(todoById('t1')!.blockKind).toBe('agent');
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('goal: blocked stays blocked as the team\'s own gate (blockKind agent, card unlinked)', async () => {
    db.goals.push(goalRow({ status: 'blocked', blockedReason: 'Awaiting owner', blockKind: 'owner', gateQuestionId: 'oq_gate1' }));
    const out = await unblockOwnerGatedItems({ userId: OWNER, questionId: 'oq_gate1', question: Q, answer: A, source: 'owner-gate sweeper', counterQuestion: true });
    expect(out).toEqual({ todos: 0, goals: 1, heldTodos: 0, heldGoals: 0 });
    const g = goalById('g1')!;
    expect(g.status).toBe('blocked');
    expect(g.blockKind).toBe('agent');
    expect(g.gateQuestionId).toBeNull();
    expect(auditActions()).toContain('goal.owner_gate_asked_back');
  });

  it('a REAL decision keeps the classic release: pending, cleared, START-now wake, owner_gate_unblock audit', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ status: 'blocked', blockedReason: 'Awaiting owner', blockKind: 'owner', gateQuestionId: 'oq_gate1', assigneeChatId: 'c-lane' }));
    await unblockOwnerGatedItems({ userId: OWNER, questionId: 'oq_gate1', question: Q, answer: 'yes go — use the post-CPT base', source: 'owner inbox answer', counterQuestion: false });
    const t = todoById('t1')!;
    expect(t.status).toBe('pending');
    expect(t.blockKind).toBeNull();
    expect(t.gateQuestionId).toBeNull();
    expect(auditActions()).toContain('todo.owner_gate_unblock');
    expect((mockEnqueueDirectWake.mock.calls[0][0].prompt as string)).toContain('START it now');
  });
});


// ── KPI premise receipt verification (tt-rd audit 2026-09-27, finding 1) ─────
describe('setGoalPremises — mission KPI contract (kpi-honesty-loops finding 1)', () => {
  const RID = 'f5b42fe6-1111-4000-8000-000000000000';
  const kpi = (over: any = {}) => [{ key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s', bar: 10, receiptId: 'f5b42fe6', ...over }];
  beforeEach(() => {
    db.goals.push(goalRow({ premises: [] }));
    mockPrisma.runToolReceipt.findFirst.mockReset();
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) => ({ id: where.id, userId: OWNER, projectId: 'p1' }));
  });

  it('a kpi: premise whose receipt does not exist / is ok:false / belongs to another project is refused (400 with the rule); a valid one lands with the FULL receipt id + a kpi_premise_set row', async () => {
    mockPrisma.runToolReceipt.findFirst.mockResolvedValueOnce(null);
    await expect(setGoalPremises({ userId: OWNER, goalId: 'g1', premises: kpi(), actingChatId: 'sup' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('receipt f5b42fe6 does not exist') });
    mockPrisma.runToolReceipt.findFirst.mockResolvedValueOnce({ id: RID, chatId: 'lane', ok: false, tool: 'run_command', createdAt: NOW });
    await expect(setGoalPremises({ userId: OWNER, goalId: 'g1', premises: kpi(), actingChatId: 'sup' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('is ok:false') });
    mockPrisma.runToolReceipt.findFirst.mockResolvedValueOnce({ id: RID, chatId: 'lane-elsewhere', ok: true, tool: 'run_command', createdAt: NOW });
    mockPrisma.crossModelChat.findUnique.mockImplementationOnce(async () => ({ id: 'lane-elsewhere', userId: OWNER, projectId: 'p-other' }));
    await expect(setGoalPremises({ userId: OWNER, goalId: 'g1', premises: kpi(), actingChatId: 'sup' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('outside this goal') });
    expect(db.goals[0].premises).toEqual([]);
    // valid
    mockPrisma.runToolReceipt.findFirst.mockResolvedValueOnce({ id: RID, chatId: 'lane', ok: true, tool: 'run_command', createdAt: NOW });
    const view = await setGoalPremises({ userId: OWNER, goalId: 'g1', premises: kpi(), actingChatId: 'sup' });
    expect(mockPrisma.runToolReceipt.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: { startsWith: 'f5b42fe6' } } }));
    expect(view.premises[0]).toEqual(expect.objectContaining({ key: 'kpi:client_visible_e2e_tok_s', kind: 'kpi', value: 5.08, bar: 10, receiptId: RID, receiptTool: 'run_command' }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'kpi_premise_set', sessionId: 'sup', meta: expect.objectContaining({ goalId: 'g1', key: 'kpi:client_visible_e2e_tok_s', value: 5.08, prev: null, receiptId: 'f5b42fe6' }) }));
    // the audit row names the change old → new
    const auditRow = mockPrisma.activity.create.mock.calls.map((c: any[]) => c[0].data).find((d: any) => d.action === 'goal.premises_set');
    expect(auditRow.metadata.changed).toEqual([{ key: 'kpi:client_visible_e2e_tok_s', from: null, to: 5.08, receiptId: 'f5b42fe6' }]);
    expect(auditRow.metadata.kpi).toEqual(['kpi:client_visible_e2e_tok_s']);
  });

  it('a kpi: premise without receiptId is refused by the validator; an unchanged reading is not re-verified; a DB error fails OPEN', async () => {
    await expect(setGoalPremises({ userId: OWNER, goalId: 'g1', premises: [{ key: 'kpi:e2e', value: 5 }], actingChatId: 'sup' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('set ONLY from a this-wake run_command receipt id') });
    mockPrisma.runToolReceipt.findFirst.mockResolvedValueOnce({ id: RID, chatId: 'lane', ok: true, tool: 'run_command', createdAt: NOW });
    await setGoalPremises({ userId: OWNER, goalId: 'g1', premises: kpi(), actingChatId: 'sup' });
    expect(mockPrisma.runToolReceipt.findFirst).toHaveBeenCalledTimes(1);
    await setGoalPremises({ userId: OWNER, goalId: 'g1', premises: kpi({ receiptId: RID }), actingChatId: 'sup' }); // same value + same receipt
    expect(mockPrisma.runToolReceipt.findFirst).toHaveBeenCalledTimes(1);
    // value moved: verified again; a DB error lets it land (fail open) and keeps prev/history
    mockPrisma.runToolReceipt.findFirst.mockRejectedValueOnce(new Error('db down'));
    const v = await setGoalPremises({ userId: OWNER, goalId: 'g1', premises: kpi({ value: 5.364, receiptId: 'abcd1234' }), actingChatId: 'sup' });
    expect(v.premises[0]).toEqual(expect.objectContaining({ value: 5.364, receiptId: 'abcd1234', prev: expect.objectContaining({ value: 5.08, receiptId: RID }) }));
    expect(v.premises[0].history).toHaveLength(1);
  });

  // ── Fixer follow-up 2026-09-27 (branch review findings 1 + 5) ──────────────
  it('round-trip: the `id` get_run_receipts prints (8-char prefix) → normalizeReceiptId → the startsWith lookup lands the FULL receipt id', async () => {
    const { normalizeReceiptId } = await import('./kpi-of-record');
    const printed = { id: RID.slice(0, 8), tool: 'run_command', ok: true, ids: {}, at: NOW }; // ops-tools get_run_receipts row shape
    const cited = normalizeReceiptId(printed.id);
    expect(cited).toBe('f5b42fe6');
    mockPrisma.runToolReceipt.findFirst.mockResolvedValueOnce({ id: RID, chatId: 'lane', ok: true, tool: 'run_command', createdAt: NOW });
    const view = await setGoalPremises({ userId: OWNER, goalId: 'g1', premises: kpi({ receiptId: cited }), actingChatId: 'sup' });
    expect(mockPrisma.runToolReceipt.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { startsWith: cited } } }));
    expect(view.premises[0].receiptId).toBe(RID);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'kpi_premise_set', meta: expect.objectContaining({ resolvedVia: 'receiptId' }) }));
  });

  it('a RUN id (runs[].id) is accepted as the reference: no receipt row has that id, so it resolves via the runId index to the run\'s latest ok run_command receipt', async () => {
    const RUN = '9c1d2e3f-0000-4000-8000-000000000000';
    mockPrisma.runToolReceipt.findFirst
      .mockResolvedValueOnce(null) // by receipt id: nothing
      .mockResolvedValueOnce({ id: RID, chatId: 'lane', ok: true, tool: 'run_command', createdAt: NOW }); // by runId
    const view = await setGoalPremises({ userId: OWNER, goalId: 'g1', premises: kpi({ receiptId: RUN.slice(0, 8) }), actingChatId: 'sup' });
    expect(mockPrisma.runToolReceipt.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { runId: { startsWith: '9c1d2e3f' }, tool: 'run_command', ok: true },
      orderBy: { createdAt: 'desc' },
    }));
    expect(view.premises[0]).toEqual(expect.objectContaining({ receiptId: RID, receiptTool: 'run_command' }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'kpi_premise_set', meta: expect.objectContaining({ receiptId: 'f5b42fe6', resolvedVia: 'runId' }) }));
  });

  it('every refusal of the KPI contract records ONE kpi_premise_refused row {gate, reason, goalId, key, sessionId} — the gate is measurable', async () => {
    mockRecordLoopMetric.mockClear();
    const refused = (reason: string) => expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'kpi_premise_refused', sessionId: 'sup',
      meta: expect.objectContaining({ gate: 'kpi_contract', reason, goalId: 'g1', projectId: 'p1', sessionId: 'sup' }),
    }));
    // validator: no receipt
    await expect(setGoalPremises({ userId: OWNER, goalId: 'g1', premises: [{ key: 'kpi:e2e', value: 5 }], actingChatId: 'sup' })).rejects.toMatchObject({ statusCode: 400 });
    refused('no_receipt');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ reason: 'no_receipt', key: 'kpi:e2e' }) }));
    // validator: a second kpi: key
    await expect(setGoalPremises({ userId: OWNER, goalId: 'g1', premises: [{ key: 'kpi:a', value: 1, receiptId: 'aaaa1111' }, { key: 'kpi:b', value: 2, receiptId: 'bbbb2222' }], actingChatId: 'sup' })).rejects.toMatchObject({ statusCode: 400 });
    refused('second_kpi');
    // receipt missing (neither a receipt id nor a run id)
    mockPrisma.runToolReceipt.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(setGoalPremises({ userId: OWNER, goalId: 'g1', premises: kpi(), actingChatId: 'sup' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('does not exist') });
    refused('receipt_missing');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ reason: 'receipt_missing', receiptId: 'f5b42fe6' }) }));
    // receipt ok:false
    mockPrisma.runToolReceipt.findFirst.mockResolvedValueOnce({ id: RID, chatId: 'lane', ok: false, tool: 'run_command', createdAt: NOW });
    await expect(setGoalPremises({ userId: OWNER, goalId: 'g1', premises: kpi(), actingChatId: 'sup' })).rejects.toMatchObject({ statusCode: 400 });
    refused('receipt_not_ok');
    // other project
    mockPrisma.runToolReceipt.findFirst.mockResolvedValueOnce({ id: RID, chatId: 'lane-elsewhere', ok: true, tool: 'run_command', createdAt: NOW });
    mockPrisma.crossModelChat.findUnique.mockImplementationOnce(async () => ({ id: 'lane-elsewhere', userId: OWNER, projectId: 'p-other' }));
    await expect(setGoalPremises({ userId: OWNER, goalId: 'g1', premises: kpi(), actingChatId: 'sup' })).rejects.toMatchObject({ statusCode: 400 });
    refused('other_project');
    expect(mockRecordLoopMetric.mock.calls.filter((c: any[]) => c[0].kind === 'kpi_premise_refused')).toHaveLength(5);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'kpi_premise_set' }));
    expect(db.goals[0].premises).toEqual([]);
  });
});

// ── blockedAt (review fix 2026-09-27 on sup3/project-digest-status-card-eta, finding 3) ──
// The digest's 72 h stale-deps gate used to age a block on updatedAt, which every
// blockedReason refresh / progressNote restamp / dependency recompute bumps — so
// a row lanes kept touching never aged. blockedAt is stamped ONLY on the
// transition INTO 'blocked', kept across every rewrite, and cleared on the way out.
describe('blockedAt — stamped on the transition into blocked, kept across rewrites, cleared on the way out', () => {
  beforeEach(() => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 't1', title: 'A' }));
    db.todos.push(todoRow({ id: 't2', title: 'B', status: 'in_progress' })); // keeps g1 from auto-completing
  });

  it('todo: a manual block stamps blockedAt; a blockedReason refresh, a blockKind rewrite and a progressNote restamp leave it; unblocking clears it', async () => {
    expect(todoById('t1').blockedAt ?? null).toBeNull();
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'blocked', blockedReason: 'Waiting on legal', blockKind: 'external' });
    const stamped = todoById('t1').blockedAt;
    expect(stamped).toBeInstanceOf(Date);
    await updateTodo({ userId: OWNER, todoId: 't1', blockedReason: 'Waiting on legal — still' });
    expect(todoById('t1').blockedAt).toBe(stamped);
    await updateTodo({ userId: OWNER, todoId: 't1', blockKind: 'agent' });
    expect(todoById('t1').blockedAt).toBe(stamped);
    await updateTodo({ userId: OWNER, todoId: 't1', progressNote: 'HOLD lifted? not yet' });
    expect(todoById('t1').blockedAt).toBe(stamped);
    // a second status:'blocked' on an already-blocked row is a no-op transition (status unchanged) — no restamp
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'blocked', blockedReason: 'again' });
    expect(todoById('t1').blockedAt).toBe(stamped);
    expect(todoById('t1').blockedReason).toBe('again');
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'pending' });
    expect(todoById('t1')).toMatchObject({ status: 'pending', blockedAt: null, blockedReason: null });
    // the view carries it (ISO string or null)
    const blockedView = await updateTodo({ userId: OWNER, todoId: 't1', status: 'blocked' });
    expect(typeof blockedView.blockedAt).toBe('string');
    expect(Number.isFinite(Date.parse(blockedView.blockedAt))).toBe(true);
  });

  it('todo: a dependency auto-block stamps blockedAt (create-with-open-deps and recompute) and the auto-unblock clears it', async () => {
    const t3 = await createTodo({ userId: OWNER, goalId: 'g1', title: 'C', dependsOnTodoIds: ['t1'] });
    expect(t3.status).toBe('blocked');
    expect(typeof t3.blockedAt).toBe('string');
    expect(todoById(t3.id).blockedAt).toBeInstanceOf(Date);
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'done' });
    expect(todoById(t3.id)).toMatchObject({ status: 'pending', blockedAt: null });
    expect(auditActions()).toContain('todo.auto_unblock');
    // reopening t1 re-blocks t3 via the recompute — a fresh stamp
    await updateTodo({ userId: OWNER, todoId: 't1', status: 'pending' });
    expect(todoById(t3.id).status).toBe('blocked');
    expect(todoById(t3.id).blockedAt).toBeInstanceOf(Date);
  });

  it('goal: a manual block stamps blockedAt, a reason refresh keeps it, unblocking clears it; create-with-open-deps stamps it', async () => {
    await updateGoal({ userId: OWNER, goalId: 'g1', status: 'blocked', blockedReason: 'Waiting on vendor' });
    const stamped = goalById('g1').blockedAt;
    expect(stamped).toBeInstanceOf(Date);
    await updateGoal({ userId: OWNER, goalId: 'g1', blockedReason: 'Waiting on vendor RCA' });
    expect(goalById('g1').blockedAt).toBe(stamped);
    await updateGoal({ userId: OWNER, goalId: 'g1', status: 'active' });
    expect(goalById('g1')).toMatchObject({ status: 'active', blockedAt: null });
    // create-with-open-deps stamps it (an ACTIVE dependency is still open — the dependent waits for it to finish)
    const g2 = await createGoal({ userId: OWNER, projectId: 'p1', title: 'Downstream', dependsOnGoalIds: ['g1'] });
    expect(g2.status).toBe('blocked');
    expect(typeof g2.blockedAt).toBe('string');
    expect(goalById(g2.id).blockedAt).toBeInstanceOf(Date);
    // finishing g1 auto-unblocks g2 through the dependents recompute — and clears the stamp
    await updateGoal({ userId: OWNER, goalId: 'g1', status: 'done' });
    expect(goalById(g2.id)).toMatchObject({ status: 'active', blockedAt: null, blockedReason: null });
    expect(auditActions()).toContain('goal.auto_unblock');
  });
});

// ── audit 2026-10-08 W5-5: a chat that assigns a todo to ITSELF is not woken ──
// Replay shape: lane 4d9661a7 assigned todos 02ccbbf1 / 3a8fe82d / 0f4bbbe8 /
// 2d28a4e5 to itself and got a durable "a todo was just ASSIGNED to this chat
// — START it now" steer in its own run each time (6 of 16 'assigned' wakes in
// the audit window were self-assignments).
describe('W5-5 — self-assignment never wakes the acting chat', () => {
  const LANE = '4d9661a7-0000-4000-8000-000000000000';
  beforeEach(() => {
    mockEnqueueDirectWake.mockReset().mockResolvedValue({ ok: true, hookEventId: 'he-1' });
    mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
    mockRedisSet.mockReset().mockResolvedValue('OK');
    delete process.env.TODO_SELF_ASSIGN_WAKE_SKIP_DISABLED;
  });
  const selfSkips = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === 'todo_wake_self_skipped');

  it('REPLAY: todo_create assigning the new todo to the acting lane itself — no wake, one skip row, attributed audit', async () => {
    db.goals.push(goalRow());
    const t = await createTodo({ userId: OWNER, goalId: 'g1', title: 'Fleet health card: GPU %', assigneeChatId: LANE, actingChatId: LANE });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(selfSkips()).toEqual([expect.objectContaining({ sessionId: LANE, meta: { todoId: t.id, transition: 'assigned' } })]);
    const createAudit = mockPrisma.activity.create.mock.calls.map((c: any[]) => c[0].data).find((d: any) => d.action === 'todo.create');
    expect(createAudit.metadata).toMatchObject({ actingChatId: LANE });
  });

  it('REPLAY: todo_update assigning an existing todo to the acting lane itself — no wake', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: '02ccbbf1-0000-4000-8000-000000000000', status: 'pending', assigneeChatId: null }));
    await updateTodo({ userId: OWNER, todoId: '02ccbbf1-0000-4000-8000-000000000000', assigneeChatId: LANE, actingChatId: LANE });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(selfSkips()).toHaveLength(1);
  });

  it('a lane unblocking its OWN todo is not woken either; a supervisor assigning a lane still wakes it', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 't-own', status: 'blocked', blockedReason: 'waiting', assigneeChatId: LANE }));
    await updateTodo({ userId: OWNER, todoId: 't-own', status: 'pending', actingChatId: LANE });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(selfSkips()[0].meta).toMatchObject({ transition: 'unblocked' });
    db.todos.push(todoRow({ id: 't-sup', status: 'pending', assigneeChatId: null }));
    await updateTodo({ userId: OWNER, todoId: 't-sup', assigneeChatId: LANE, actingChatId: 'c-supervisor' });
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    expect(mockEnqueueDirectWake.mock.calls[0][0].targetChatId).toBe(LANE);
  });

  it('kill switch TODO_SELF_ASSIGN_WAKE_SKIP_DISABLED=1 wakes the acting chat again (pre-fix)', async () => {
    process.env.TODO_SELF_ASSIGN_WAKE_SKIP_DISABLED = '1';
    db.goals.push(goalRow());
    await createTodo({ userId: OWNER, goalId: 'g1', title: 'Self leg', assigneeChatId: LANE, actingChatId: LANE });
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    expect(selfSkips()).toHaveLength(0);
    delete process.env.TODO_SELF_ASSIGN_WAKE_SKIP_DISABLED;
  });
});

// ── GOAL-PRIORITY-SPEND (supervisor SOTA round 3, 2026-10-20) ─────────────────
//
// Owner rules: P1..P4 (unset = P2); an OWNER-set ranking is never overwritten
// by a machine; a supervisor may rank only a goal whose source is not 'owner'
// (stamped 'machine'); a lane's ranking write is refused — the REST of its
// write still applies and the result says why (apply-or-explain).

describe('goal ranking writes (GOAL-PRIORITY-SPEND)', () => {
  const priorityRows = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'goal_priority');

  it('the OWNER ranks at create: P1 + dueAt stored, source owner, view carries the label; metric + audit', async () => {
    const r = await createGoal({ userId: OWNER, projectId: 'p1', title: 'Ship it', priority: 'P1', dueAt: '2026-11-01', rankingWriter: 'owner' });
    const data = mockPrisma.projectGoal.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ priority: 1, prioritySource: 'owner' });
    expect(data.dueAt).toEqual(new Date('2026-11-01T00:00:00Z'));
    expect(r).toMatchObject({ priority: 1, priorityLabel: 'P1', prioritySource: 'owner', dueAt: '2026-11-01T00:00:00.000Z' });
    expect(priorityRows()).toEqual([expect.objectContaining({ meta: expect.objectContaining({ outcome: 'set', source: 'owner', from: null, to: 1, seam: 'create' }) })]);
    expect(auditActions()).toContain('goal.priority_set');
  });

  it('no ranking field ⇒ no ranking columns, no metric; an unset goal reads P2', async () => {
    const r = await createGoal({ userId: OWNER, projectId: 'p1', title: 'Plain', createdByChatId: 'c-lane' });
    const data = mockPrisma.projectGoal.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('priority');
    expect(data).not.toHaveProperty('prioritySource');
    expect(r).toMatchObject({ priority: null, priorityLabel: 'P2', prioritySource: null, dueAt: null });
    expect(priorityRows()).toHaveLength(0);
  });

  it('an invalid priority / dueAt 400s before anything writes', async () => {
    await expect(createGoal({ userId: OWNER, projectId: 'p1', title: 'Bad', priority: 7 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createGoal({ userId: OWNER, projectId: 'p1', title: 'Bad', dueAt: 'next tuesday' })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.projectGoal.create).not.toHaveBeenCalled();
    db.goals.push(goalRow());
    await expect(updateGoal({ userId: OWNER, goalId: 'g1', title: 'T2', priority: 0 })).rejects.toMatchObject({ statusCode: 400 });
    expect(goalById('g1')!.title).toBe('Goal 1');
  });

  it('a machine write on an OWNER-set ranking leaves it untouched, applies the rest, and says why', async () => {
    db.goals.push(goalRow({ priority: 1, prioritySource: 'owner' }));
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ id: 'c-sup', userId: OWNER, isProjectSupervisor: true }));
    const r = await updateGoal({ userId: OWNER, goalId: 'g1', title: 'Renamed', priority: 4, rankingWriter: 'machine', machineTriggered: true, actingChatId: 'c-sup' });
    expect(goalById('g1')).toMatchObject({ title: 'Renamed', priority: 1, prioritySource: 'owner' });
    expect(r.priorityNote).toMatch(/owner set this goal's ranking \(P1, owner-set\)/);
    expect(priorityRows()).toEqual([expect.objectContaining({ sessionId: 'c-sup', meta: expect.objectContaining({ outcome: 'refused_owner_set', from: 1, to: 1 }) })]);
    expect(auditActions()).not.toContain('goal.priority_set');
  });

  it('a LANE (non-supervisor) cannot rank; a SUPERVISOR can on a non-owner goal (source machine)', async () => {
    db.goals.push(goalRow());
    // Default fake: the acting chat is a plain same-owner chat (no supervisor flags).
    const lane = await updateGoal({ userId: OWNER, goalId: 'g1', priority: 1, rankingWriter: 'machine', machineTriggered: true, actingChatId: 'c-lane' });
    expect(goalById('g1')!.priority).toBeUndefined();
    expect(lane.priorityNote).toMatch(/only the owner or a supervisor ranks goals/);
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ id: 'c-sup', userId: OWNER, isProjectSupervisor: true }));
    const sup = await updateGoal({ userId: OWNER, goalId: 'g1', priority: 1, rankingWriter: 'machine', machineTriggered: true, actingChatId: 'c-sup' });
    expect(goalById('g1')).toMatchObject({ priority: 1, prioritySource: 'machine' });
    expect(sup).toMatchObject({ priorityLabel: 'P1', prioritySource: 'machine' });
    expect(sup.priorityNote).toBeUndefined();
    expect(priorityRows().map((m: any) => m.meta.outcome)).toEqual(['refused_not_supervisor', 'set']);
  });

  it('the OWNER overrides a machine ranking; clearing both fields clears the source (a supervisor may rank again)', async () => {
    db.goals.push(goalRow({ priority: 3, prioritySource: 'machine', dueAt: new Date('2026-11-01T00:00:00Z') }));
    await updateGoal({ userId: OWNER, goalId: 'g1', priority: 1, rankingWriter: 'owner', ownerExplicit: true });
    expect(goalById('g1')).toMatchObject({ priority: 1, prioritySource: 'owner' });
    await updateGoal({ userId: OWNER, goalId: 'g1', priority: null, dueAt: null, rankingWriter: 'owner', ownerExplicit: true });
    expect(goalById('g1')).toMatchObject({ priority: null, dueAt: null, prioritySource: null });
    expect(priorityRows().map((m: any) => m.meta.outcome)).toEqual(['set', 'cleared']);
  });
});

// ── GOAL-PRIORITY-SPEND review fixes (2026-10-20) ─────────────────────────────
//
// (1) A human tool turn ranks as the OWNER only when the owner's own text BACKS
//     this write (lowercase "p1", "due friday", "do this first", or this goal by
//     id / title) — not on any ranking word anywhere in the turn.
// (2) A non-owner human (a shared project's editor) writes as 'member': allowed,
//     audited, never an owner lock, never over the owner's ranking.
// (3) A non-owner ranking write is CONDITIONAL — an owner write that lands
//     between the read and the write wins (no silent overwrite).

describe('goal ranking writes — review fixes (GOAL-PRIORITY-SPEND)', () => {
  const priorityRows = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'goal_priority');
  const asSupervisor = () => mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ id: 'c-sup', userId: OWNER, isProjectSupervisor: true }));

  it("the owner's lowercase order on a lane turn is the OWNER's ranking (\"make the deploy goal p1\"); a level the text did not name is a machine guess", async () => {
    db.goals.push(goalRow());
    const r = await updateGoal({ userId: OWNER, goalId: 'g1', priority: 1, rankingOwnerText: 'make the deploy goal p1', actingChatId: 'c-lane' });
    expect(goalById('g1')).toMatchObject({ priority: 1, prioritySource: 'owner' });
    expect(r.priorityNote).toBeUndefined();
    // Same text, but the model writes P3 — not what the owner said ⇒ machine ⇒ refused on a lane (the owner's P1 stands).
    const guess = await updateGoal({ userId: OWNER, goalId: 'g1', priority: 3, rankingOwnerText: 'make the deploy goal p1', actingChatId: 'c-lane' });
    expect(goalById('g1')).toMatchObject({ priority: 1, prioritySource: 'owner' });
    expect(guess.priorityNote).toMatch(/owner set this goal's ranking/);
  });

  it('"this is due friday" backs a dueAt write; a ranking word in an unrelated QUESTION never makes a supervisor\'s re-rank an owner lock', async () => {
    db.goals.push(goalRow());
    await updateGoal({ userId: OWNER, goalId: 'g1', dueAt: '2026-10-23', rankingOwnerText: 'this is due friday', actingChatId: 'c-lane' });
    expect(goalById('g1')).toMatchObject({ prioritySource: 'owner' });
    expect(goalById('g1')!.dueAt).toEqual(new Date('2026-10-23T00:00:00Z'));
    db.goals.push(goalRow({ id: 'g2', title: 'Bench' }));
    asSupervisor();
    await updateGoal({ userId: OWNER, goalId: 'g2', priority: 1, rankingOwnerText: 'urgent: the deploy is broken, also what are our priorities this week?', actingChatId: 'c-sup' });
    expect(goalById('g2')).toMatchObject({ priority: 1, prioritySource: 'machine' });
    // Pointing at the goal by title beside ranking language backs any level.
    await updateGoal({ userId: OWNER, goalId: 'g2', priority: 3, rankingOwnerText: 'Lower the Bench goal priority.', actingChatId: 'c-sup' });
    expect(goalById('g2')).toMatchObject({ priority: 3, prioritySource: 'owner' });
  });

  it('a project EDITOR writes as member: allowed + audited, not an owner lock, and never over the owner\'s ranking', async () => {
    db.goals.push(goalRow({ priority: 3, prioritySource: 'machine' }));
    const r = await updateGoal({ userId: EDITOR, goalId: 'g1', priority: 2, rankingWriter: 'owner', ownerExplicit: true });
    expect(goalById('g1')).toMatchObject({ priority: 2, prioritySource: 'member' });
    expect(r.prioritySource).toBe('member');
    expect(auditActions()).toContain('goal.priority_set');
    // A supervisor may re-rank a member's ranking (not a lock) …
    asSupervisor();
    await updateGoal({ userId: OWNER, goalId: 'g1', priority: 1, rankingWriter: 'machine', machineTriggered: true, actingChatId: 'c-sup' });
    expect(goalById('g1')).toMatchObject({ priority: 1, prioritySource: 'machine' });
    // … the owner locks it, and the editor can no longer change it.
    await updateGoal({ userId: OWNER, goalId: 'g1', priority: 1, rankingWriter: 'owner', ownerExplicit: true });
    const refused = await updateGoal({ userId: EDITOR, goalId: 'g1', priority: 4, rankingWriter: 'owner', ownerExplicit: true });
    expect(goalById('g1')).toMatchObject({ priority: 1, prioritySource: 'owner' });
    expect(refused.priorityNote).toMatch(/project owner set this goal's ranking \(P1, owner-set\) and only the owner changes/);
    expect(priorityRows().map((m: any) => [m.meta.outcome, m.meta.writer])).toEqual([['set', 'member'], ['set', 'machine'], ['set', 'owner'], ['refused_owner_set', 'member']]);
  });

  it('an editor creating a goal with a ranking stamps member', async () => {
    const r = await createGoal({ userId: EDITOR, projectId: 'p1', title: 'Member goal', priority: 1, rankingWriter: 'owner' });
    expect(mockPrisma.projectGoal.create.mock.calls[0][0].data).toMatchObject({ priority: 1, prioritySource: 'member' });
    expect(r.prioritySource).toBe('member');
  });

  it('race: an owner ranking that lands between the read and the write wins — the machine write is refused, never a silent overwrite', async () => {
    db.goals.push(goalRow({ title: 'Goal 1' }));
    // The supervisor check runs AFTER the row read: the owner's PATCH commits right then.
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => {
      Object.assign(goalById('g1')!, { priority: 1, prioritySource: 'owner' });
      return { id: 'c-sup', userId: OWNER, isProjectSupervisor: true };
    });
    const r = await updateGoal({ userId: OWNER, goalId: 'g1', title: 'Renamed', priority: 3, rankingWriter: 'machine', machineTriggered: true, actingChatId: 'c-sup' });
    expect(goalById('g1')).toMatchObject({ title: 'Renamed', priority: 1, prioritySource: 'owner' });
    expect(r).toMatchObject({ title: 'Renamed', priority: 1, prioritySource: 'owner' });
    expect(r.priorityNote).toMatch(/owner set this goal's ranking \(P1, owner-set\)/);
    expect(priorityRows()).toEqual([expect.objectContaining({ meta: expect.objectContaining({ outcome: 'refused_owner_set', raced: true, writer: 'machine' }) })]);
    expect(auditActions()).not.toContain('goal.priority_set');
  });
});

// ── Interaction fix (2026-10-20): a refused ranking write that changed nothing ─
//
// A supervisor's goal_update {goalId, priority} on an OWNER-set goal (or a lane's,
// or one an owner write raced) wrote nothing — the view says so (rankingApplied:
// false + changed:false) so the goal_update receipt is ok:false and the harness
// record lists it under "Not executed", and the note says the owner's ranking
// stands. A refusal inside a call that changed other fields still applied.

describe('goal ranking writes — a refused ranking-only call changed nothing (interaction fix)', () => {
  const asSupervisor = () => mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ id: 'c-sup', userId: OWNER, isProjectSupervisor: true }));

  it('a supervisor re-rank of an OWNER-set goal with nothing else: rankingApplied:false + changed:false, nothing written, the owner\'s P1 stands', async () => {
    db.goals.push(goalRow({ priority: 1, prioritySource: 'owner' }));
    asSupervisor();
    const r = await updateGoal({ userId: OWNER, goalId: 'g1', priority: 4, rankingWriter: 'machine', machineTriggered: true, actingChatId: 'c-sup' });
    expect(mockPrisma.projectGoal.update).not.toHaveBeenCalled();
    expect(goalById('g1')).toMatchObject({ priority: 1, prioritySource: 'owner' });
    expect(r).toMatchObject({ rankingApplied: false, changed: false, priority: 1, prioritySource: 'owner' });
    expect(r.priorityNote).toMatch(/owner set this goal's ranking \(P1, owner-set\).*The owner's P1 stands\. This call changed nothing else, so nothing was written \(not executed\)\./);
    expect(r.priorityNote).not.toMatch(/Everything else in this call applied/);
  });

  it('a lane (not a supervisor) ranking-only call: changed:false too; a refusal beside a real write keeps rankingApplied:false but no changed flag', async () => {
    db.goals.push(goalRow());
    const lane = await updateGoal({ userId: OWNER, goalId: 'g1', priority: 1, rankingWriter: 'machine', machineTriggered: true, actingChatId: 'c-lane' });
    expect(lane).toMatchObject({ rankingApplied: false, changed: false });
    expect(lane.priorityNote).toMatch(/only the owner or a supervisor ranks goals.*nothing was written/);
    const withTitle = await updateGoal({ userId: OWNER, goalId: 'g1', title: 'Renamed', priority: 1, rankingWriter: 'machine', machineTriggered: true, actingChatId: 'c-lane' });
    expect(goalById('g1')!.title).toBe('Renamed');
    expect(withTitle.rankingApplied).toBe(false);
    expect(withTitle).not.toHaveProperty('changed');
    expect(withTitle.priorityNote).toMatch(/Everything else in this call applied/);
  });

  it('race: an owner ranking that lands first turns a ranking-only supervisor write into changed:false', async () => {
    db.goals.push(goalRow());
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => {
      Object.assign(goalById('g1')!, { priority: 1, prioritySource: 'owner' });
      return { id: 'c-sup', userId: OWNER, isProjectSupervisor: true };
    });
    const r = await updateGoal({ userId: OWNER, goalId: 'g1', priority: 3, rankingWriter: 'machine', machineTriggered: true, actingChatId: 'c-sup' });
    expect(goalById('g1')).toMatchObject({ priority: 1, prioritySource: 'owner' });
    expect(r).toMatchObject({ rankingApplied: false, changed: false, priority: 1 });
    expect(r.priorityNote).toMatch(/The owner's P1 stands/);
  });

  it('an applied ranking carries neither flag', async () => {
    db.goals.push(goalRow());
    asSupervisor();
    const r = await updateGoal({ userId: OWNER, goalId: 'g1', priority: 1, rankingWriter: 'machine', machineTriggered: true, actingChatId: 'c-sup' });
    expect(r).not.toHaveProperty('rankingApplied');
    expect(r).not.toHaveProperty('changed');
  });
});

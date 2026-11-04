/**
 * Ticket be94fa64 (2026-09-19) — REPLAY: the deployed d76750f5 phantom-gate
 * guard refused a REAL owner question flagged by a MEMBER lane, blocking the
 * very repair it was deployed to allow. The live incident (verbatim ids from
 * the ticket): the Fleet Supervisor account (076d2832…, an EDITOR member of the
 * jacobpistor-owned "New Hampshire" project b34272d1) tried to re-point todo
 * 4501c4b0's gate — stranded on the phantom oq_4694abca… — at the REAL open
 * card oq_1fc19541-1487-441a-a9c2-b7321873061a it had flagged itself, and
 * todo_update 400'd "matches no owner_questions row for this owner" (full id
 * AND 8-char prefix), while list_owner_questions in the same session returned
 * that exact row OPEN and store-linked to the same todo.
 *
 * Root cause: resolveGateQuestionId scoped its ownerQuestion probe to
 * goal.userId / todo.userId (the PROJECT owner), but owner_questions rows carry
 * the userId of the account whose lane FLAGGED them — so a member lane's own
 * questions could never be wired as gates in a shared project, even though
 * flag_owner_question accepts the goalId/todoId linkage and every read surface
 * (attention-watchdog, owner-gate-sweeper) probes gate rows by bare id.
 *
 * Fix under test: the resolver probes rows owned by the goal/todo owner OR the
 * ACTING account (updateGoal/updateTodo pass their acting userId through
 * maybeResolveGate). Single-owner calls keep the byte-identical scalar probe;
 * a THIRD party's rows still 400 (cross-tenant isolation preserved); phantoms
 * still 400; clearing (null) is still never refused.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Stateful fake DB ─────────────────────────────────────────────────────────
const OWNER = 'u-owner-jacob'; // project owner (jacobpistor analog)
const MEMBER = 'u-member-fleet'; // acting member lane (076d2832… analog, EDITOR)
const THIRD = 'u-third-party'; // unrelated account
const PROJECT_ID = 'p-nh';

const db: {
  projects: any[]; goals: any[]; todos: any[]; goalDeps: any[]; todoDeps: any[]; ownerQuestions: any[];
} = { projects: [], goals: [], todos: [], goalDeps: [], todoDeps: [], ownerQuestions: [] };

function matchRow(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v === undefined) return true;
    if (v === null) return row[k] == null;
    if (k === 'OR') return (v as any[]).some((clause) => matchRow(row, clause));
    if (v && typeof v === 'object' && 'startsWith' in v) return String(row[k] ?? '').startsWith(v.startsWith);
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    return row[k] === v;
  });
}
function pick(row: any, select: any) {
  if (!select) return row;
  const out: any = {};
  for (const k of Object.keys(select)) if (select[k] === true) out[k] = row[k];
  return out;
}
const table = (getRows: () => any[]) => ({
  findUnique: jest.fn(async ({ where, select }: any) => {
    const row = getRows().find((r) => matchRow(r, where)) ?? null;
    return row ? pick(row, select) : null;
  }),
  findMany: jest.fn(async (args: any = {}) => {
    let out = getRows().filter((r) => matchRow(r, args.where));
    if (args.take) out = out.slice(0, args.take);
    if (args.select) out = out.map((r) => pick(r, args.select));
    return out;
  }),
  update: jest.fn(async ({ where, data }: any) => {
    const row = getRows().find((r) => matchRow(r, where));
    if (!row) throw new Error(`row ${where.id} not found`);
    Object.assign(row, data);
    return { ...row };
  }),
  updateMany: jest.fn(async ({ where, data }: any) => {
    const m = getRows().filter((r) => matchRow(r, where));
    m.forEach((r) => Object.assign(r, data));
    return { count: m.length };
  }),
});

const mockPrisma: any = {
  crossModelProject: {
    findUnique: jest.fn(async ({ where }: any) => db.projects.find((p) => p.id === where.id) ?? null),
    findMany: jest.fn(async (args: any = {}) => db.projects.filter((p) => matchRow(p, args.where))),
  },
  crossModelChat: { findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, userId: MEMBER })) },
  projectMember: { findMany: jest.fn(async () => []) },
  projectGoal: { ...table(() => db.goals), create: jest.fn() },
  projectTodo: { ...table(() => db.todos), create: jest.fn() },
  goalDependency: { findMany: jest.fn(async () => []), createMany: jest.fn(), deleteMany: jest.fn() },
  todoDependency: { findMany: jest.fn(async () => []), createMany: jest.fn(), deleteMany: jest.fn() },
  ownerQuestion: {
    findFirst: jest.fn(async ({ where, select }: any) => {
      const row = db.ownerQuestions.find((q) => matchRow(q, where)) ?? null;
      return row ? pick(row, select) : null;
    }),
    findMany: jest.fn(async (args: any = {}) => {
      let out = db.ownerQuestions.filter((q) => matchRow(q, args.where));
      if (args.take) out = out.slice(0, args.take);
      if (args.select) out = out.map((r) => pick(r, args.select));
      return out;
    }),
  },
  activity: { create: jest.fn(async () => ({})) },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) },
}));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: jest.fn(async () => ({ started: true })),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
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
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  enqueueDirectWake: jest.fn(async () => ({ ok: true, hookEventId: 'he-1' })),
}));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: jest.fn(),
}));

import { updateGoal, updateTodo, resolveGateQuestionId } from './goals.service';

// The incident's ids (verbatim from ticket be94fa64).
const MEMBER_GATE = 'oq_1fc19541-1487-441a-a9c2-b7321873061a'; // flagged by the MEMBER lane, OPEN
const PHANTOM = 'oq_4694abca-4eb3-4983-b244-8ccf043073e3'; // stranded gate — matches no row
const OWNER_GATE = 'oq_9000aaaa-bbbb-4000-8000-ownerowner00'; // flagged by the project owner
const THIRD_GATE = 'oq_deadbeef-0000-4000-8000-thirdthird00'; // flagged by an unrelated account

const goalRow = (over: any = {}) => ({
  id: 'g-2639cbd7', userId: OWNER, projectId: PROJECT_ID, title: 'Goal',
  status: 'blocked', blockedReason: 'Awaiting owner decision', blockKind: 'owner',
  gateQuestionId: PHANTOM, progressNote: null, createdByChatId: null, ...over,
});
const todoRow = (over: any = {}) => ({
  id: 't-4501c4b0', userId: OWNER, goalId: 'g-2639cbd7', projectId: PROJECT_ID, title: 'Todo',
  status: 'blocked', blockedReason: 'Awaiting owner decision', blockKind: 'owner',
  gateQuestionId: PHANTOM, progressNote: null, assigneeChatId: null, ...over,
});

beforeEach(() => {
  db.projects = [{
    id: PROJECT_ID, userId: OWNER, name: 'New Hampshire', path: '/nh',
    members: [{ userId: MEMBER, role: 'editor' }], // the acting lane's project membership
  }];
  db.goals = [];
  db.todos = [];
  db.goalDeps = [];
  db.todoDeps = [];
  db.ownerQuestions = [{ id: MEMBER_GATE, userId: MEMBER, status: 'open' }];
  jest.clearAllMocks(); // clears call data only — implementations survive
});

describe('be94fa64 — member-lane gates in shared projects (guard scope widened to the acting account)', () => {
  it('REPLAY: the member lane re-points the stranded phantom gate at its own flagged card — the exact refused repair now lands', async () => {
    db.todos.push(todoRow());
    const v = await updateTodo({
      userId: MEMBER, todoId: 't-4501c4b0',
      gateQuestionId: MEMBER_GATE,
      blockedReason: 'Re-pointing the gate at the real open card oq_1fc19541 (phantom oq_4694abca orphaned it)',
    });
    expect(v.gateQuestionId).toBe(MEMBER_GATE);
    expect(db.todos[0].gateQuestionId).toBe(MEMBER_GATE);
    // The probe was scoped to the goal/todo owner AND the acting account.
    expect(mockPrisma.ownerQuestion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: MEMBER_GATE, userId: { in: [OWNER, MEMBER] } }) }),
    );
  });

  it('REPLAY prefix: the member lane\'s 8-char oq_ prefix (the second refused attempt) resolves to the FULL row id', async () => {
    db.todos.push(todoRow());
    const v = await updateTodo({ userId: MEMBER, todoId: 't-4501c4b0', gateQuestionId: 'oq_1fc19541' });
    expect(v.gateQuestionId).toBe(MEMBER_GATE);
  });

  it('goal path: the member lane gates an owner-owned GOAL on its own flagged question too (both write paths fixed)', async () => {
    db.goals.push(goalRow());
    const v = await updateGoal({ userId: MEMBER, goalId: 'g-2639cbd7', gateQuestionId: MEMBER_GATE });
    expect(v.gateQuestionId).toBe(MEMBER_GATE);
    expect(db.goals[0].gateQuestionId).toBe(MEMBER_GATE);
  });

  it('union scope: the member lane can ALSO reference the project owner\'s question (previously the only accepted class)', async () => {
    db.ownerQuestions.push({ id: OWNER_GATE, userId: OWNER, status: 'open' });
    db.todos.push(todoRow());
    const v = await updateTodo({ userId: MEMBER, todoId: 't-4501c4b0', gateQuestionId: OWNER_GATE });
    expect(v.gateQuestionId).toBe(OWNER_GATE);
  });

  it('single-owner case byte-identical: the owner acting keeps the scalar userId probe (no { in } drift)', async () => {
    db.ownerQuestions.push({ id: OWNER_GATE, userId: OWNER, status: 'open' });
    db.todos.push(todoRow());
    const v = await updateTodo({ userId: OWNER, todoId: 't-4501c4b0', gateQuestionId: OWNER_GATE });
    expect(v.gateQuestionId).toBe(OWNER_GATE);
    expect(mockPrisma.ownerQuestion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: OWNER_GATE, userId: OWNER }) }),
    );
  });

  it('GUARD INTACT: a phantom id still 400s for the member lane and nothing writes', async () => {
    db.todos.push(todoRow());
    await expect(updateTodo({ userId: MEMBER, todoId: 't-4501c4b0', gateQuestionId: 'oq_00000000-dead-4000-8000-nopenopenope' }))
      .rejects.toThrow(/matches no owner_questions row/);
    expect(db.todos[0].gateQuestionId).toBe(PHANTOM);
  });

  it('CROSS-TENANT: a real oq row owned by an unrelated THIRD account does not resolve for the member lane', async () => {
    db.ownerQuestions.push({ id: THIRD_GATE, userId: THIRD, status: 'open' });
    db.todos.push(todoRow());
    await expect(updateTodo({ userId: MEMBER, todoId: 't-4501c4b0', gateQuestionId: THIRD_GATE }))
      .rejects.toThrow(/matches no owner_questions row/);
    expect(db.todos[0].gateQuestionId).toBe(PHANTOM);
  });

  it('REPAIR PATH unchanged: clearing the stranded phantom gate (null) lands with zero owner_questions probes', async () => {
    db.todos.push(todoRow());
    const v = await updateTodo({ userId: MEMBER, todoId: 't-4501c4b0', gateQuestionId: null });
    expect(v.gateQuestionId).toBeNull();
    expect(mockPrisma.ownerQuestion.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.ownerQuestion.findMany).not.toHaveBeenCalled();
  });

  it('the refusal message now names both scopes so the next member lane is not told its visible row "does not exist"', async () => {
    db.todos.push(todoRow());
    await expect(updateTodo({ userId: MEMBER, todoId: 't-4501c4b0', gateQuestionId: 'oq_00000000-dead-4000-8000-nopenopenope' }))
      .rejects.toThrow(/for this owner or your account/);
  });

  it('resolveGateQuestionId unit: acting scope resolves the member row; without it the old scope still 400s; third-party rows never resolve', async () => {
    await expect(resolveGateQuestionId(OWNER, MEMBER_GATE, MEMBER)).resolves.toBe(MEMBER_GATE);
    await expect(resolveGateQuestionId(OWNER, MEMBER_GATE)).rejects.toThrow(/matches no owner_questions row/);
    db.ownerQuestions.push({ id: THIRD_GATE, userId: THIRD, status: 'open' });
    await expect(resolveGateQuestionId(OWNER, THIRD_GATE, MEMBER)).rejects.toThrow(/matches no owner_questions row/);
  });
});

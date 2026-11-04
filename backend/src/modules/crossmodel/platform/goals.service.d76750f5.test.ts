/**
 * Ticket d76750f5 (2026-09-18) — REPLAY: a todo's gate was silently re-pointed
 * at a NONEXISTENT owner_questions id by an unidentified writer, orphaning the
 * real open card. The New Hampshire incident: todo 4501c4b0's gate flipped at
 * 14:21:03Z to oq_4694abca… (matched NO row — full-id AND prefix probe), with a
 * rewritten blockedReason claiming the REAL open gate oq_1fc19541 "never
 * existed" — the second contradictory flip on the same todo in 2 days. Root
 * cause: applyBlockProvenance (goals.service) was the sole gateQuestionId
 * setter and landed ANY ≤60-char string with no existence check.
 *
 * Fix under test: resolveGateQuestionId — a store-side guard wired into BOTH
 * updateTodo and updateGoal (before any write): a supplied gate must resolve
 * to an EXISTING owner_questions row of the SAME owner (full oq_ id, or a
 * unique ≥8-char prefix normalized/stored as the full id); otherwise 400.
 * Clearing (null/'') is never refused — that is the repair path.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Stateful fake DB ─────────────────────────────────────────────────────────
const OWNER = 'u-owner';
const OTHER = 'u-other';
const PROJECT_ID = 'p-nh'; // the "New Hampshire" project of the incident

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
  crossModelChat: { findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, userId: OWNER })) },
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

// The incident's ids (verbatim from ticket d76750f5).
const REAL_GATE = 'oq_1fc19541-0000-4000-8000-realrealreal';
const PHANTOM = 'oq_4694abca-4eb3-4983-b244-8ccf043073e3';

const goalRow = (over: any = {}) => ({
  id: 'g-2639cbd7', userId: OWNER, projectId: PROJECT_ID, title: 'Goal',
  status: 'active', blockedReason: null, blockKind: null, gateQuestionId: null,
  progressNote: null, createdByChatId: null, ...over,
});
const todoRow = (over: any = {}) => ({
  id: 't-4501c4b0', userId: OWNER, goalId: 'g-2639cbd7', projectId: PROJECT_ID, title: 'Todo',
  status: 'blocked', blockedReason: 'Awaiting owner decision', blockKind: 'owner',
  gateQuestionId: REAL_GATE, progressNote: null, assigneeChatId: null, ...over,
});

beforeEach(() => {
  db.projects = [{ id: PROJECT_ID, userId: OWNER, name: 'New Hampshire', path: '/nh' }];
  db.goals = [];
  db.todos = [];
  db.goalDeps = [];
  db.todoDeps = [];
  db.ownerQuestions = [{ id: REAL_GATE, userId: OWNER, status: 'open' }];
  jest.clearAllMocks(); // clears call data only — implementations survive
});

describe('d76750f5 — phantom-gate guard (store-side gateQuestionId validation)', () => {
  it('REPLAY: flipping a todo gate to the nonexistent oq_4694abca 400s and leaves the real gate untouched', async () => {
    db.todos.push(todoRow());
    await expect(updateTodo({
      userId: OWNER, todoId: 't-4501c4b0',
      gateQuestionId: PHANTOM,
      blockedReason: "prior gateQuestionId oq_1fc19541 never existed — the phantom story was backwards",
    })).rejects.toThrow(/matches no owner_questions row/);
    // Nothing wrote: the row still carries the REAL open gate.
    const t = db.todos.find((r) => r.id === 't-4501c4b0')!;
    expect(t.gateQuestionId).toBe(REAL_GATE);
    expect(t.status).toBe('blocked');
  });

  it('goal: the same phantom flip 400s on updateGoal too (both write paths guarded)', async () => {
    db.goals.push(goalRow({ status: 'blocked', blockedReason: 'Awaiting owner', blockKind: 'owner', gateQuestionId: REAL_GATE }));
    await expect(updateGoal({ userId: OWNER, goalId: 'g-2639cbd7', gateQuestionId: PHANTOM }))
      .rejects.toThrow(/matches no owner_questions row/);
    expect(db.goals[0].gateQuestionId).toBe(REAL_GATE);
  });

  it('the error names the rejected id and points at flag_owner_question / list_owner_questions', async () => {
    db.todos.push(todoRow());
    await expect(updateTodo({ userId: OWNER, todoId: 't-4501c4b0', gateQuestionId: PHANTOM }))
      .rejects.toThrow(new RegExp(`${PHANTOM.slice(0, 20)}.*flag_owner_question`, 's'));
  });

  it('a gate on an EXISTING same-owner question lands (full id)', async () => {
    db.todos.push(todoRow({ gateQuestionId: null, blockKind: null, status: 'pending', blockedReason: null }));
    const v = await updateTodo({
      userId: OWNER, todoId: 't-4501c4b0', status: 'blocked', blockedReason: 'Awaiting owner decision',
      blockKind: 'owner', gateQuestionId: REAL_GATE,
    });
    expect(v.gateQuestionId).toBe(REAL_GATE);
    expect(db.todos[0].gateQuestionId).toBe(REAL_GATE);
  });

  it('a unique ≥8-char oq_ prefix resolves and is stored as the FULL row id (read-probe parity)', async () => {
    db.todos.push(todoRow({ gateQuestionId: null }));
    const v = await updateTodo({ userId: OWNER, todoId: 't-4501c4b0', gateQuestionId: 'oq_1fc19541' });
    expect(v.gateQuestionId).toBe(REAL_GATE);
  });

  it('CROSS-TENANT: a real oq row owned by a DIFFERENT user does not resolve for this owner', async () => {
    db.ownerQuestions.push({ id: PHANTOM, userId: OTHER, status: 'open' });
    db.todos.push(todoRow());
    await expect(updateTodo({ userId: OWNER, todoId: 't-4501c4b0', gateQuestionId: PHANTOM }))
      .rejects.toThrow(/matches no owner_questions row/);
    expect(db.todos[0].gateQuestionId).toBe(REAL_GATE);
  });

  it('REPAIR PATH: clearing a phantom gate (null) never touches the store and always lands', async () => {
    db.todos.push(todoRow({ gateQuestionId: PHANTOM })); // the orphaned state the filer repaired at 20:01Z
    const v = await updateTodo({ userId: OWNER, todoId: 't-4501c4b0', gateQuestionId: null });
    expect(v.gateQuestionId).toBeNull();
    expect(mockPrisma.ownerQuestion.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.ownerQuestion.findMany).not.toHaveBeenCalled();
  });

  it('an ambiguous prefix (2+ matching rows) 400s instead of guessing', async () => {
    db.ownerQuestions.push({ id: 'oq_1fc19541-ffff-4000-8000-secondsecond', userId: OWNER, status: 'open' });
    db.todos.push(todoRow());
    await expect(updateTodo({ userId: OWNER, todoId: 't-4501c4b0', gateQuestionId: 'oq_1fc19541' }))
      .rejects.toThrow(/matches no owner_questions row/);
  });

  it('existence-only, not open-only: an ANSWERED row resolves (stale gates are the watchdog\'s class, not phantoms)', async () => {
    db.ownerQuestions = [{ id: REAL_GATE, userId: OWNER, status: 'answered' }];
    db.todos.push(todoRow({ gateQuestionId: null }));
    const v = await updateTodo({ userId: OWNER, todoId: 't-4501c4b0', gateQuestionId: REAL_GATE });
    expect(v.gateQuestionId).toBe(REAL_GATE);
  });

  it('resolveGateQuestionId unit: a bare hex prefix is normalized with oq_ (action-verifier parity)', async () => {
    await expect(resolveGateQuestionId(OWNER, '1fc19541-0000')).resolves.toBe(REAL_GATE);
    await expect(resolveGateQuestionId(OWNER, 'nope')).rejects.toThrow(/matches no owner_questions row/);
  });
});

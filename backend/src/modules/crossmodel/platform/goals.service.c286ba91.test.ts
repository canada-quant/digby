/**
 * Ticket c286ba91 (2026-09-19) — REPLAY: gate writes carried NO authorship and
 * the Activity audit seam fired only on STATUS changes. The incident:
 * 2026-09-19 02:28:04Z — 4th flip of todo 4501c4b0's gate landed
 * oq_4694abca-4eb3-4983-b244-8ccf043073e3, which the reporter's account could
 * not see (later DB-verified REAL + OPEN + store-linked on the project OWNER's
 * account — a cross-tenant visibility artifact, not a phantom) and left ZERO
 * audit/authorship trail because the audit seam fired only on status changes.
 * Three tickets (d76750f5, be94fa64, and this one) were burned identifying the
 * writer of an "unattributed" gateQuestionId flip on a shared-project todo.
 *
 * Fix under test (c286ba91): updateGoal/updateTodo stamp updatedByChatId +
 * updatedByRunId on EVERY row write (null = user/REST/framework writer), the
 * classic 'goal.update'/'todo.update' audits carry actingChatId/actingRunId in
 * their metadata, and a NO-status-change gate/blockKind/blockedReason/
 * progressNote rewrite now emits 'goal.gate_update'/'todo.gate_update' —
 * closing the audit gap the incident shape fell through. The d76750f5/
 * be94fa64 guard semantics are UNCHANGED: a real owner-row gate lands, a
 * third-party row still 400s.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Stateful fake DB ─────────────────────────────────────────────────────────
const OWNER = 'u-owner'; // project + todo owner (the incident card's real owner)
const THIRD = 'u-third-party'; // unrelated account
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

import { updateGoal, updateTodo } from './goals.service';

// The incident's ids (verbatim from ticket c286ba91) — the gate card that was
// DB-verified REAL + OPEN + store-linked on the project OWNER's account.
const INCIDENT_GATE = 'oq_4694abca-4eb3-4983-b244-8ccf043073e3';
const THIRD_GATE = 'oq_deadbeef-0000-4000-8000-thirdthird00'; // owned by a THIRD account
const WRITER_CHAT = 'c-writer'; // the acting chat (previously "unattributed")
const WRITER_RUN = 'r-1'; // the acting agent run

const goalRow = (over: any = {}) => ({
  id: 'g-2639cbd7', userId: OWNER, projectId: PROJECT_ID, title: 'Goal',
  status: 'blocked', blockedReason: 'Awaiting owner decision', blockKind: 'owner',
  gateQuestionId: null, progressNote: null, createdByChatId: null, ...over,
});
const todoRow = (over: any = {}) => ({
  id: 't-4501c4b0', userId: OWNER, goalId: 'g-2639cbd7', projectId: PROJECT_ID, title: 'Todo',
  status: 'blocked', blockedReason: 'Awaiting owner decision', blockKind: 'owner',
  gateQuestionId: null, progressNote: null, assigneeChatId: null, startedAt: null, ...over,
});

/** All activity.create call payloads with a given action. */
const auditCalls = (action: string) =>
  mockPrisma.activity.create.mock.calls
    .map((c: any[]) => c[0]?.data)
    .filter((d: any) => d?.action === action);

beforeEach(() => {
  db.projects = [{ id: PROJECT_ID, userId: OWNER, name: 'New Hampshire', path: '/nh' }];
  db.goals = [];
  db.todos = [];
  db.goalDeps = [];
  db.todoDeps = [];
  db.ownerQuestions = [{ id: INCIDENT_GATE, userId: OWNER, status: 'open' }];
  jest.clearAllMocks(); // clears call data only — implementations survive
});

describe('c286ba91 — gate-write authorship trail + no-status-change audit gap close', () => {
  it('REPLAY c286ba91: the 02:28:04Z no-status-change gate flip now lands stamped AND audited (todo.gate_update)', async () => {
    db.todos.push(todoRow());
    const reason = 'Re-pointing the gate at the real open card oq_4694abca (deploy-freeze owner call)';
    const v = await updateTodo({
      userId: OWNER, todoId: 't-4501c4b0',
      gateQuestionId: INCIDENT_GATE, blockedReason: reason,
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    });
    // The write lands — with authorship stamped on the row.
    expect(db.todos[0].gateQuestionId).toBe(INCIDENT_GATE);
    expect(db.todos[0].updatedByChatId).toBe(WRITER_CHAT);
    expect(db.todos[0].updatedByRunId).toBe(WRITER_RUN);
    // …exposed on the todo view…
    expect(v.updatedByChatId).toBe(WRITER_CHAT);
    expect(v.updatedByRunId).toBe(WRITER_RUN);
    // …and the audit gap is closed: NO status change, yet exactly one
    // todo.gate_update row carrying the acting chat + run (previously ZERO rows).
    expect(auditCalls('todo.update')).toHaveLength(0);
    const gateAudits = auditCalls('todo.gate_update');
    expect(gateAudits).toHaveLength(1);
    expect(gateAudits[0].metadata).toEqual(expect.objectContaining({
      todoId: 't-4501c4b0', gateQuestionId: INCIDENT_GATE, blockedReason: reason,
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    }));
  });

  it('c286ba91 goal mirror: a no-status-change goal gate write emits goal.gate_update + both stamps', async () => {
    db.goals.push(goalRow());
    const v = await updateGoal({
      userId: OWNER, goalId: 'g-2639cbd7',
      gateQuestionId: INCIDENT_GATE, blockedReason: 'Awaiting the owner deploy-freeze call',
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    });
    expect(db.goals[0].gateQuestionId).toBe(INCIDENT_GATE);
    expect(db.goals[0].updatedByChatId).toBe(WRITER_CHAT);
    expect(db.goals[0].updatedByRunId).toBe(WRITER_RUN);
    expect(v.updatedByChatId).toBe(WRITER_CHAT);
    expect(v.updatedByRunId).toBe(WRITER_RUN);
    expect(auditCalls('goal.update')).toHaveLength(0);
    const gateAudits = auditCalls('goal.gate_update');
    expect(gateAudits).toHaveLength(1);
    expect(gateAudits[0].metadata).toEqual(expect.objectContaining({
      goalId: 'g-2639cbd7', gateQuestionId: INCIDENT_GATE,
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    }));
  });

  it('c286ba91: a STATUS-CHANGING write still emits exactly the classic todo.update audit (no extra gate_update row)', async () => {
    db.todos.push(todoRow());
    await updateTodo({
      userId: OWNER, todoId: 't-4501c4b0', status: 'in_progress',
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    });
    const updates = auditCalls('todo.update');
    expect(updates).toHaveLength(1);
    expect(updates[0].metadata).toEqual(expect.objectContaining({
      todoId: 't-4501c4b0', toStatus: 'in_progress',
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
      // fromStatus is NOT pinned: the stateful fake mutates the todo row
      // in place inside the transaction, so the audit's `fromStatus:
      // todo.status` reads post-mutation here — the real Prisma client
      // returns a fresh row and keeps the pre-update snapshot.
      fromStatus: expect.any(String),
    }));
    // The status-change path must NOT double-audit through the gap-closer.
    expect(auditCalls('todo.gate_update')).toHaveLength(0);
    // …and the row write carries the same authorship stamps.
    expect(db.todos[0].updatedByChatId).toBe(WRITER_CHAT);
    expect(db.todos[0].updatedByRunId).toBe(WRITER_RUN);
  });

  it('c286ba91: a null-actor call (REST/user-present — no actingChatId/actingRunId) stamps null and still audits', async () => {
    db.todos.push(todoRow());
    const v = await updateTodo({
      userId: OWNER, todoId: 't-4501c4b0',
      gateQuestionId: INCIDENT_GATE, blockedReason: 'Awaiting the owner call',
    });
    expect(db.todos[0].updatedByChatId).toBeNull();
    expect(db.todos[0].updatedByRunId).toBeNull();
    expect(v.updatedByChatId).toBeNull();
    expect(v.updatedByRunId).toBeNull();
    expect(auditCalls('todo.gate_update')).toHaveLength(1);
  });

  it('c286ba91 cross-tenant documentation: the owner-owned oq_4694abca gate write was LEGITIMATE (guard correct) — a third account\'s row still 400s', async () => {
    // The 02:28Z write pinned as valid: todo.userId = u-owner and the
    // oq_4694abca… row is owned by u-owner — the "phantom" was a cross-tenant
    // VISIBILITY artifact for the reporter's account, not a nonexistent row.
    db.todos.push(todoRow());
    const v = await updateTodo({
      userId: OWNER, todoId: 't-4501c4b0', gateQuestionId: INCIDENT_GATE,
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    });
    expect(v.gateQuestionId).toBe(INCIDENT_GATE);
    // Cross-tenant isolation preserved: a real row owned by a THIRD account
    // still does not resolve for this owner.
    db.ownerQuestions.push({ id: THIRD_GATE, userId: THIRD, status: 'open' });
    await expect(updateTodo({
      userId: OWNER, todoId: 't-4501c4b0', gateQuestionId: THIRD_GATE,
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    })).rejects.toThrow(/matches no owner_questions row/);
    expect(db.todos[0].gateQuestionId).toBe(INCIDENT_GATE); // unchanged by the refused write
  });
});

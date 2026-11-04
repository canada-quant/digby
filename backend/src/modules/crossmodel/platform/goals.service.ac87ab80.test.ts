/**
 * REPLAY PIN — ticket ac87ab80 (bug_report, 2026-10-30T23:46Z).
 *
 * THE INCIDENT (project Schooltime, lane chat 60dfc8a8). A lane closed its own
 * todo 5d794fd4 with evidence claiming the box copy "== repo" PRE-deploy. It
 * then shipped the fix, which changed the box's md5 (ecf2e079 → the fixed
 * build) and FALSIFIED that citation. The lane called todo_update to correct the
 * evidence string THREE separate times; each call returned success-shaped output
 * carrying the ORIGINAL text verbatim, so the correction never landed. It
 * escaped by putting the retraction in progressNote and reporting it up.
 *
 * ROOT CAUSE (verified against the code, not inferred):
 * `updateTodo` collected `data.evidence` ONLY inside the
 * `if (status !== todo.status)` block, inside the `status === 'done' |
 * 'dropped'` arms. On a row that is ALREADY done — the only case where a
 * citation ever needs correcting — `status: 'done'` repeats the current status,
 * so that whole block is skipped; `evidence` therefore added nothing to `data`;
 * and the transaction's `if (Object.keys(data).length)` then performed ZERO
 * writes and returned the CURRENT row. The caller sees the old text and a
 * success shape. `evidence` alone was the same story, one step earlier.
 *
 * WHY IT MATTERS: `evidence` is the artifact citation the platform and the
 * verifier treat as fact for a closed todo. An immutable-and-silently-immutable
 * evidence field leaves a disproven claim standing in the shared board that
 * later reads as fact — the exact shape the audit rules strike as a phantom
 * claim. Silent partial success is worse than a 400 because it teaches the
 * caller its correction worked.
 *
 * THE FIX THIS FILE PINS (both halves of the ticket's own suggested remed(y)):
 *   1. A TERMINAL row (done | dropped) AMENDS the stored citation — the write
 *      lands, the returned view carries the NEW text, and a `todo.evidence_amended`
 *      audit row records from → to with the acting chat/run (the c286ba91
 *      authorship contract). An UNCHANGED text is a quiet no-op (no audit noise).
 *   2. A NON-terminal row 400s LOUDLY naming the real rule (pass a closing
 *      status) instead of accepting a parameter it cannot store.
 *   3. `status: 'done'` repeated + new evidence (the lane's actual retry shape)
 *      amends too — not just the evidence-only call.
 *   4. An explicit REOPEN still WINS: leaving done clears the citation and the
 *      supplied evidence never resurrects it.
 *
 * Scaffold mirrors goals.service.c8c7fd41.test.ts (stateful fake DB).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Stateful fake DB ─────────────────────────────────────────────────────────
const OWNER = 'u-ac87ab80';
const PROJECT_ID = 'p-schooltime';

const db: {
  projects: any[]; goals: any[]; todos: any[]; goalDeps: any[]; todoDeps: any[]; ownerQuestions: any[];
} = { projects: [], goals: [], todos: [], goalDeps: [], todoDeps: [], ownerQuestions: [] };

function matchRow(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [k: string, v: any]) => {
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
    if (!row) throw new Error(`row ${where?.id} not found`);
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
  goalDependency: { ...table(() => db.goalDeps), createMany: jest.fn(), deleteMany: jest.fn() },
  todoDependency: { ...table(() => db.todoDeps), createMany: jest.fn(), deleteMany: jest.fn() },
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

jest.mock('../../../config/env', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
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

import { updateTodo } from './goals.service';

// ── The incident's ids/shapes (ticket ac87ab80) ─────────────────────────────
const TODO = '5d794fd4-0000-4000-8000-ac87ab800000'; // the lane's own closed todo
const GOAL = 'g-ac87ab80-0000-4000-8000-000000000000';

/** The citation the lane wrote PRE-deploy — disproven once the box md5 moved. */
const FALSIFIED =
  'box md5 ecf2e079 == repo (verified pre-deploy, no rebuild needed)';
/** The correction it tried to land three times and never did. */
const CORRECTED =
  'supersedes the md5 claim above: the box build changed ecf2e079 -> fixed build after deploy; "== repo" was true only pre-deploy';

const WRITER_CHAT = 'c-60dfc8a8'; // the acting lane
const WRITER_RUN = 'run-chat-eb4c3e1e'; // its acting run

const goalRow = (over: any = {}) => ({
  id: GOAL, userId: OWNER, projectId: PROJECT_ID, title: 'Schooltime ship',
  status: 'active', blockedReason: null, blockKind: null, gateQuestionId: null, progressNote: null,
  createdByChatId: null, premises: [], ...over,
});

/** The row AT THE MOMENT OF THE INCIDENT: closed, with the falsified citation. */
const doneRow = (over: any = {}) => ({
  id: TODO, userId: OWNER, goalId: GOAL, projectId: PROJECT_ID, title: 'Ship the box fix',
  status: 'done', blockedReason: null, blockKind: null, gateQuestionId: null,
  progressNote: null, assigneeChatId: WRITER_CHAT, startedAt: new Date(),
  evidence: FALSIFIED, doneRunId: WRITER_RUN,
  updatedByChatId: WRITER_CHAT, updatedByRunId: WRITER_RUN,
  blockedAt: null, createdAt: new Date(), updatedAt: new Date(),
  ...over,
});

/** Every activity.create payload with a given action. */
const auditCalls = (action: string) =>
  mockPrisma.activity.create.mock.calls
    .map((c: any[]) => c[0]?.data)
    .filter((d: any) => d?.action === action);

beforeEach(() => {
  db.projects = [{ id: PROJECT_ID, userId: OWNER, name: 'Schooltime', path: '/schooltime' }];
  db.goals = [goalRow()];
  db.todos = [doneRow()];
  db.goalDeps = [];
  db.todoDeps = [];
  db.ownerQuestions = [];
  jest.clearAllMocks(); // clears call data only — implementations survive
});

describe('ticket ac87ab80 — a closed todo\'s evidence must be AMENDABLE, never silently frozen', () => {
  it('REPLAY: the lane\'s third retry shape (evidence alone on the done row) now LANDS the correction — no stale echo', async () => {
    const v = await updateTodo({
      userId: OWNER, todoId: TODO, evidence: CORRECTED,
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    });

    // The returned view is the REAL post-write row, not the old one echoed back.
    expect(v.evidence).toBe(CORRECTED);
    expect(v.evidence).not.toBe(FALSIFIED);
    // And the row on disk agrees (the write actually executed).
    expect(db.todos[0].evidence).toBe(CORRECTED);
    // Authorship is stamped by the row write (the c286ba91 contract).
    expect(db.todos[0].updatedByChatId).toBe(WRITER_CHAT);
    expect(db.todos[0].updatedByRunId).toBe(WRITER_RUN);
    // Still closed — amending a citation is not a status change.
    expect(v.status).toBe('done');
    expect(db.todos[0].doneRunId).toBe(WRITER_RUN);
  });

  it('the amendment is AUDITED with the prior text — the correction trail is readable', async () => {
    await updateTodo({
      userId: OWNER, todoId: TODO, evidence: CORRECTED,
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    });
    const rows = auditCalls('todo.evidence_amended');
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual(expect.objectContaining({
      todoId: TODO,
      from: FALSIFIED,
      to: CORRECTED,
      actingChatId: WRITER_CHAT,
      actingRunId: WRITER_RUN,
    }));
    // An amendment is NOT a status transition — no todo.update row is minted.
    expect(auditCalls('todo.update')).toHaveLength(0);
  });

  it('REPLAY: `status:"done"` repeated + new evidence (the exact retry the lane made 3×) amends too', async () => {
    const v = await updateTodo({
      userId: OWNER, todoId: TODO, status: 'done' as any, evidence: CORRECTED,
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    });
    expect(v.evidence).toBe(CORRECTED);
    expect(db.todos[0].evidence).toBe(CORRECTED);
    // Repeating the terminal status is not a re-close: no transition fired.
    expect(db.todos[0].status).toBe('done');
    expect(auditCalls('todo.update')).toHaveLength(0);
    expect(auditCalls('todo.evidence_amended')).toHaveLength(1);
  });

  it('a DROPPED row amends the same way (both terminal statuses are correctable)', async () => {
    db.todos = [doneRow({ status: 'dropped', evidence: 'owner cancelled the work' })];
    const v = await updateTodo({
      userId: OWNER, todoId: TODO, evidence: 'owner cancelled — superseded by the 2026-10-30 directive',
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    });
    expect(v.evidence).toBe('owner cancelled — superseded by the 2026-10-30 directive');
    expect(db.todos[0].evidence).toBe('owner cancelled — superseded by the 2026-10-30 directive');
    expect(db.todos[0].status).toBe('dropped');
  });

  it('re-sending the SAME text is a quiet no-op — no write, no audit noise', async () => {
    const v = await updateTodo({ userId: OWNER, todoId: TODO, evidence: FALSIFIED });
    expect(v.evidence).toBe(FALSIFIED);
    expect(auditCalls('todo.evidence_amended')).toHaveLength(0);
  });

  it('a NON-terminal row REFUSES loudly, naming the rule — never accepts a parameter it cannot store', async () => {
    db.todos = [doneRow({ status: 'in_progress', evidence: null, doneRunId: null })];
    await expect(updateTodo({
      userId: OWNER, todoId: TODO, evidence: 'premature citation',
    })).rejects.toThrow(/evidence can only be written on a CLOSED todo: this one is 'in_progress'/);
    // Nothing wrote — the row is untouched.
    expect(db.todos[0].evidence).toBeNull();
    expect(auditCalls('todo.evidence_amended')).toHaveLength(0);
  });

  it('the refusal teaches the remedy: a closing status in the SAME call lands the citation', async () => {
    db.todos = [doneRow({ status: 'in_progress', evidence: null, doneRunId: null })];
    const v = await updateTodo({
      userId: OWNER, todoId: TODO, status: 'done' as any, evidence: 'PR #2190 merged, deploy 41131849375 green',
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    });
    expect(v.status).toBe('done');
    expect(v.evidence).toBe('PR #2190 merged, deploy 41131849375 green');
    expect(db.todos[0].evidence).toBe('PR #2190 merged, deploy 41131849375 green');
  });

  it('REOPEN still WINS: leaving done clears the citation and the supplied evidence never resurrects it', async () => {
    const v = await updateTodo({
      userId: OWNER, todoId: TODO, status: 'in_progress' as any, evidence: CORRECTED,
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    });
    expect(v.status).toBe('in_progress');
    expect(v.evidence).toBeNull();
    expect(db.todos[0].evidence).toBeNull();
    expect(db.todos[0].doneRunId).toBeNull();
    // A reopen is a status transition — the amendment audit must NOT fire.
    expect(auditCalls('todo.evidence_amended')).toHaveLength(0);
    expect(auditCalls('todo.update').length).toBeGreaterThan(0);
  });

  it('an evidence-less close is unchanged (the pre-existing `if (evidenceText)` semantics)', async () => {
    db.todos = [doneRow({ status: 'in_progress', evidence: null, doneRunId: null })];
    const v = await updateTodo({ userId: OWNER, todoId: TODO, status: 'done' as any });
    expect(v.status).toBe('done');
    expect(v.evidence).toBeNull();
    expect(auditCalls('todo.evidence_amended')).toHaveLength(0);
  });

  it('blank/whitespace evidence stays "nothing supplied" — a close is not failed by it', async () => {
    db.todos = [doneRow({ status: 'in_progress', evidence: null, doneRunId: null })];
    const v = await updateTodo({ userId: OWNER, todoId: TODO, status: 'done' as any, evidence: '   ' });
    expect(v.status).toBe('done');
    expect(v.evidence).toBeNull();
  });

  it('a NON-terminal row with blank evidence is not refused either (nothing was supplied to store)', async () => {
    db.todos = [doneRow({ status: 'pending', evidence: null, doneRunId: null })];
    const v = await updateTodo({ userId: OWNER, todoId: TODO, evidence: '   ' });
    expect(v.evidence).toBeNull();
  });

  // Independent review finding 3 — the same silent-loss class, one arm over.
  it('RE-CLOSE keeps this call\'s evidence: dropped → done must NOT wipe the citation the close just stored', async () => {
    db.todos = [doneRow({ status: 'dropped', evidence: 'owner cancelled the work', doneRunId: 'run-prior-close' })];
    const v = await updateTodo({
      userId: OWNER, todoId: TODO, status: 'done' as any,
      evidence: 're-opened by owner and shipped: PR #2190 merged',
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    });
    expect(v.status).toBe('done');
    // Pre-fix: the reopen arm (keyed on the OLD status) cleared both AFTER the
    // close arm stored them, so this landed evidence:null / doneRunId:null.
    expect(v.evidence).toBe('re-opened by owner and shipped: PR #2190 merged');
    expect(db.todos[0].evidence).toBe('re-opened by owner and shipped: PR #2190 merged');
    // `actingRunId` is authorship, NOT the closing run — doneRunId stays as it
    // was (this call supplied no doneRunId), and critically must not be nulled
    // by the reopen arm.
    expect(db.todos[0].doneRunId).not.toBeNull();
  });

  it('a RE-CLOSE is not an undo: it must not fire the reopen cascade', async () => {
    db.todos = [doneRow({ status: 'done', evidence: 'first close', doneRunId: null })];
    const v = await updateTodo({
      userId: OWNER, todoId: TODO, status: 'dropped' as any,
      evidence: 'superseded — owner cancelled before ship',
      actingChatId: WRITER_CHAT, actingRunId: WRITER_RUN,
    });
    expect(v.status).toBe('dropped');
    expect(v.evidence).toBe('superseded — owner cancelled before ship');
    // maybeReopenGoalOnTodoReopen must NOT run for a re-close; the goal stays active.
    expect(db.goals[0].status).toBe('active');
  });
});
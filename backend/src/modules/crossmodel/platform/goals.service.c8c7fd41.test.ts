/**
 * REPLAY PIN — ticket c8c7fd41 (mishap, 2026-10-21T17:48:38.734Z): "3×
 * tool-failure streak: todo_update on 'cql-agx-orin64 Supervisor · hook:
 * lane b' — framework or model?" Auto-filed at breaker trip (owner doctrine
 * 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE INCIDENT (session e03452f4-7f79-4a47-a95c-fb10a8873d47 — the
 * cql-agx-orin64 project supervisor, machine hook wake "lane b", 17:44–17:48Z
 * Oct 21): THREE consecutive todo_update refusals, all the IDENTICAL text —
 * "blockedReason can only be set on a blocked todo (current status:
 * 'pending'). Pass status:'blocked' to block it first." — with args
 * {"assigneeChatId":"b4d89c80","blockKind":"deps","blockedReason":"Owner gate
 * oq_ef3c35c8 ANSWERED 17:44Z — no owner decision pending. Blocked on dep
 * 3/6 (23bedd3d serve leg)…"}. A plain 3-count trip: three real texts, no
 * intent-mismatch fast-trip line in the filing.
 *
 * THE VERDICT (this lane, 2026-10-22, evidence-led): MODEL BEHAVIOR — no
 * deterministic framework defect. Every leg verified against primary sources
 * THIS run:
 *   1. The guard is long-standing and semantically correct: the
 *      apply-or-reject rule is f902cc066 (2026-08-10, PR #186 — added
 *      precisely so a reason-only update is never a silent no-op); git log -S
 *      over the exact string on goals.service.ts returns ONLY that commit —
 *      no framework change shaped the refusal before this incident. The tool
 *      schema documents the contract (platform-tools.ts todo_update
 *      blockedReason: "Why it is blocked — with status:'blocked', or alone to
 *      refresh an already-blocked todo").
 *   2. The refusal is correct against the args given: the todo (ac53362b, the
 *      memory-budget row of goal 4f6ceb83) was PENDING at 17:48Z — a
 *      blockedReason with NO status transition on a non-blocked row must
 *      apply-or-reject, and it rejected with the exact text and the exact
 *      truthful remedy. The reason's FACTUAL content was TRUE (owner gate
 *      oq_ef3c35c8 was ANSWERED by the owner — re-verified live this run —
 *      and the row was genuinely waiting on dependency 23bedd3d); the model
 *      simply omitted status:'blocked' on all three calls. Same guard class
 *      as 596718e7/62f14ea6 (adjudicated model-behavior 2026-10-16), this
 *      time on the PENDING arm.
 *   3. Self-heal is receipt-proven: the same session's next todo_update
 *      receipts are ALL ok — 8d558a7 18:44:09Z, 92c217c9 18:49:21Z (the row's
 *      blockedAt 18:49:21.151Z matches this receipt — the correctly-shaped
 *      status:'blocked' write), c165042e 19:36:02Z. The row now reads
 *      status 'blocked', blockKind 'external', with an accurate updated
 *      reason. No perma-withhold, no run-end; the supervisor kept working
 *      (steers, schedules, supervisor-state writes through 00:07Z Oct 22).
 *
 * WHY THIS PIN EXISTS (the gap the 596718e7/62f14ea6 pins left open): their
 * guard pins cover the apply-or-reject rule on an IN_PROGRESS row only — the
 * PENDING arm (this incident's exact shape: a never-started todo) had NO pin.
 * This pin pins it against the REAL updateTodo (stateful fake DB), so a
 * future change that softens the guard on a pending row fails here loudly
 * instead of silently re-arming the incident class:
 *   1. blockedReason WITHOUT status on a PENDING row 400s with this
 *      incident's verbatim text (never a silent no-op) — and the row is
 *      left untouched.
 *   2. The same call on an in_progress row 400s too (the 596718e7 shape) —
 *      the guard is status-generic for every non-blocked status.
 *   3. The recovery shape the wild supervisor used at 18:49:21Z —
 *      status:'blocked' WITH the reason (and blockKind) — lands ALL fields:
 *      status, blockedReason, blockKind, blockedAt stamped.
 *   4. blockKind rides WITH status:'blocked' (applyBlockProvenance) and the
 *      deps-coercion note (CanLaw S2a) stays out of the way of the block.
 *
 * The loop-level half (the plain 3× identical-text trip + containment +
 * recovery) is pinned in agent-derail-break.c8c7fd41.test.ts.
 *
 * Scaffold mirrors goals.service.596718e7.test.ts (stateful fake DB).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Stateful fake DB ─────────────────────────────────────────────────────────
const OWNER = 'u-c8c7fd41';
const PROJECT_ID = 'p-cql-agx-orin64';

const db: {
  projects: any[]; goals: any[]; todos: any[]; goalDeps: any[]; todoDeps: any[];
} = { projects: [], goals: [], todos: [], goalDeps: [], todoDeps: [] };

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

// ── The incident's verbatim ids (ticket c8c7fd41 + live todo_get this run) ──
const MEM_TODO = 'ac53362b-ba1f-46e3-b645-44633216e9bf'; // "2/6 Re-verify memory budget fresh on-box …" — PENDING at 17:48Z
const SERVE_TODO = '23bedd3d-2fef-4d31-8f2c-3eb33ed0f323'; // "3/6 Serve 4B helper on loopback …" — a DEPENDENT of the memory row, not its dep

/** The incident's verbatim call-arg head (ticket "Call args", newest first). */
const REASON_ARG =
  'Owner gate oq_ef3c35c8 ANSWERED 17:44Z — no owner decision pending. Blocked on dep 3/6 (23bedd3d serve leg): bench Orin vs mbp-2 (tok/s';

const goalRow = (over: any = {}) => ({
  id: '4f6ceb83-21f2-4cdf-9edf-6aa8b504327e', userId: OWNER, projectId: PROJECT_ID, title: 'Resurrect 4B helper (Qwen3.5-4B AWQ) max context on AGX',
  status: 'active', blockedReason: null, blockKind: null, gateQuestionId: null, progressNote: null,
  createdByChatId: null, ...over,
});
/** The board the wild supervisor saw at 17:48Z (live todo_get this run): the
 *  memory-budget row PENDING (never started), its serve dep BLOCKED. */
const todoRow = (over: any = {}) => ({
  id: 't-x', userId: OWNER, goalId: '4f6ceb83-21f2-4cdf-9edf-6aa8b504327e', projectId: PROJECT_ID, title: 'Row',
  status: 'pending', blockedReason: null, blockKind: null, gateQuestionId: null,
  progressNote: null, assigneeChatId: null, startedAt: null, evidence: null, doneRunId: null,
  updatedByChatId: null, updatedByRunId: null, blockedAt: null, createdAt: new Date(), updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  db.projects = [{ id: PROJECT_ID, userId: OWNER, name: 'cql-agx-orin64', path: '/cql-agx' }];
  db.goals = [goalRow()];
  db.todos = [
    todoRow({ id: MEM_TODO, title: '2/6 Re-verify memory budget fresh on-box (8B pair + laya 29.35 GiB held, 15 GiB floor) and pull cyankiwi/Qwen3.5-4B-AWQ-4bit' }),
    todoRow({ id: SERVE_TODO, title: '3/6 Serve 4B helper on loopback (retired :8327 slot) with the LARGEST context holding the 15 GiB floor', status: 'blocked', blockedReason: 'Waiting on the memory-budget row' }),
  ];
  db.todoDeps = []; // the dependency is between OTHER rows of the ladder — the guard never reads it for this call
  jest.clearAllMocks(); // clears call data only — implementations survive
});

describe('ticket c8c7fd41 — the todo_update blockedReason guard refused correctly on a PENDING todo (store side)', () => {
  it("REPLAY 17:44–17:48Z: blockedReason WITHOUT status on the PENDING memory-budget row 400s with the incident's verbatim text — never a silent no-op", async () => {
    await expect(updateTodo({
      userId: OWNER, todoId: MEM_TODO, blockedReason: REASON_ARG, blockKind: 'deps', assigneeChatId: 'b4d89c80',
    })).rejects.toThrow(
      "blockedReason can only be set on a blocked todo (current status: 'pending'). Pass status:'blocked' to block it first.",
    );
    // Nothing wrote — the row is UNTOUCHED (no partial write leaked past the guard).
    expect(db.todos.find((t) => t.id === MEM_TODO)!.status).toBe('pending');
    expect(db.todos.find((t) => t.id === MEM_TODO)!.blockedReason).toBeNull();
    expect(db.todos.find((t) => t.id === MEM_TODO)!.blockKind).toBeNull();
  });

  it('the guard is status-generic: the SAME reason-only call on an in_progress row 400s with the status spelled in the text (the 596718e7 shape)', async () => {
    db.todos = db.todos.map((t) => (t.id === MEM_TODO ? { ...t, status: 'in_progress' } : t));
    await expect(updateTodo({
      userId: OWNER, todoId: MEM_TODO, blockedReason: REASON_ARG,
    })).rejects.toThrow(
      "blockedReason can only be set on a blocked todo (current status: 'in_progress'). Pass status:'blocked' to block it first.",
    );
  });

  it('the refresh leg PR #186 added: the SAME reason-only call on an ALREADY-blocked row refreshes the reason (apply, not reject)', async () => {
    db.todos = db.todos.map((t) => (t.id === MEM_TODO ? { ...t, status: 'blocked', blockedReason: 'Stale reason' } : t));
    const v = await updateTodo({ userId: OWNER, todoId: MEM_TODO, blockedReason: REASON_ARG });
    expect(v.status).toBe('blocked');
    expect(v.blockedReason).toBe(REASON_ARG);
  });

  it("REPLAY 18:49:21Z (the recovery): status:'blocked' WITH the reason + blockKind lands ALL fields — the guard text's own instruction, working", async () => {
    const v = await updateTodo({
      userId: OWNER, todoId: MEM_TODO, status: 'blocked', blockedReason: REASON_ARG, blockKind: 'external',
    });
    expect(v.status).toBe('blocked');
    expect(v.blockedReason).toBe(REASON_ARG);
    expect(v.blockKind).toBe('external');
    const row = db.todos.find((t) => t.id === MEM_TODO)!;
    expect(row.status).toBe('blocked');
    expect(row.blockedReason).toBe(REASON_ARG);
    expect(row.blockKind).toBe('external');
    expect(row.blockedAt).toBeInstanceOf(Date); // stamped on the transition (review fix 2026-09-27)
  });

  it('a blockedReason arriving WITH the status transition is never double-claimed: the standalone arm is skipped when status already carried the reason', async () => {
    // status:'blocked' + blockedReason in ONE call (the recovery shape) — the
    // standalone apply-or-reject arm must not also fire (data.blockedReason is
    // already set by the transition, so the guard is skipped by design).
    const v = await updateTodo({ userId: OWNER, todoId: MEM_TODO, status: 'blocked', blockedReason: REASON_ARG });
    expect(v.blockedReason).toBe(REASON_ARG);
    // The view is iso()-serialized (blockedAt as ISO string) while the DB row
    // holds the stamped Date — the store's real two-shape contract.
    expect(typeof v.blockedAt).toBe('string');
    expect(db.todos.find((t) => t.id === MEM_TODO)!.blockedAt).toBeInstanceOf(Date);
  });

  it('S2a coercion (the deps leg docblock item 4): status:"blocked" + blockKind:"deps" with ZERO open deps coerces to "agent" and says so — never refused', async () => {
    // The board's real topology (live todo_get): the memory row has NO
    // dependencies (23bedd3d is a DEPENDENT) — so a deps-blocked write with
    // no new dep ids hits the phantom-deps arm (CanLaw stall 2026-09-15)
    // and is recorded as the team's own block. This is exactly why the
    // wild supervisor's correctly-shaped recovery at 18:49:21Z carried
    // blockKind:'external', not 'deps'.
    const v = await updateTodo({ userId: OWNER, todoId: MEM_TODO, status: 'blocked', blockKind: 'deps', blockedReason: REASON_ARG });
    expect(v.blockKind).toBe('agent'); // coerced, audit-noted, never refused
    expect(v.blockedReason).toBe(REASON_ARG);
    expect(db.todos.find((t) => t.id === MEM_TODO)!.blockKind).toBe('agent');
  });
});

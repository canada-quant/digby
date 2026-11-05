/**
 * REPLAY PIN — ticket 596718e7 (mishap, 2026-10-15T21:51:35.507Z), store-side
 * half: the TWO todo_update guard contracts whose refusals fed the breaker's
 * "3× tool-failure streak" filing — both CORRECT, both long-standing.
 *
 * The incident (session 26be18cc, run 4dbde611 — receipts): 21:51:20 a
 * done+evidence close attempt was refused by the dependency gate (409);
 * 21:51:33/35 a blockedReason-only update on an in_progress row was refused
 * by the apply-or-reject rule (400). The lane recovered at 21:54:14 using
 * the guards' own documented shapes (status:'blocked' WITH the reason) and
 * the run completed clean. Adjudication: MODEL BEHAVIOR — the loop-level
 * half (the weighted 2-text "3×" trip + intent fast-trip + containment) is
 * pinned in agent-derail-break.596718e7.test.ts.
 *
 * THIS PIN pins the two store-side contracts against the REAL updateTodo
 * (stateful fake DB), so a future change that softens either guard fails
 * here loudly instead of silently re-arming the incident class:
 *   1. done-gate (da3ebd842, 2026-08-03): status:'done' with an open dep
 *      409s with the exact refusal text naming the blocking dep; force:true
 *      overrides and audits; the dep DONE → closes cleanly.
 *   2. blockedReason apply-or-reject (f902cc066, 2026-08-10 400): on a
 *      NON-blocked row it 400s with the exact text (the silent-no-op class
 *      PR #186 closed); on an already-blocked row it REFRESHES the reason.
 *   3. The recovery shapes the wild lane used at 21:54:14 succeed:
 *      status:'blocked' + blockedReason lands both fields on the row.
 *
 * Scaffold mirrors goals.service.d76750f5.test.ts (stateful fake DB).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Stateful fake DB ─────────────────────────────────────────────────────────
const OWNER = 'u-596718e7';
const PROJECT_ID = 'p-litellm';

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

// ── The incident's verbatim ids (ticket 596718e7 / sighting 62f14ea6 live reads) ─
const FE467CED = 'fe467ced-572a-49db-aff8-02dac35030c6'; // "DNS cutover llm.cql.ca → rutherford-2" (in_progress; own dep = the DONE deploy row)
const ED2FD190 = 'ed2fd190-9846-42c6-a938-d7ccefcab5ed'; // "Mint virtual keys for infrastructure callers"
const VERIFY_TODO = '10023020-f24b-4416-8aeb-e9072c70003a'; // "Verify cutover: /v1/models roster vs 50 …" (blocked at 21:51Z)
const DEPLOY_TODO = '221e21bc-6655-4119-a3ff-d09fa64b1fc0'; // deploy row (done)
const SWEEP_TODO = '06c26d0f-a77f-41dc-adcb-c3268309a2db'; // drop-in sweep — the 409's ACTUAL target (dependsOn the blocked verify row)

const REASON_ARG =
  'Client list is owner/fleet-side: per the 2026-10-11 incident brief every caller requests a virtual key through the owner/gateway lane.';
const EVIDENCE_ARG =
  'Fresh-host verification this run (SSH deploy@69.19.140.37): /etc/gateway-health-monitor.env does not exist; no KNOWN_DOWN overrides in any systemd drop-in.';

const goalRow = (over: any = {}) => ({
  id: 'g-rutherford2', userId: OWNER, projectId: PROJECT_ID, title: 'Rebuild llm.cql.ca on Hyperstack rutherford-2',
  status: 'active', blockedReason: null, blockKind: null, gateQuestionId: null, progressNote: null,
  createdByChatId: null, ...over,
});
/** The board the wild lane saw at 21:50Z (receipts + the sighting's fresh
 *  todo_get facts): the cutover row IN_PROGRESS, its verify dep BLOCKED. */
const todoRow = (over: any = {}) => ({
  id: 't-x', userId: OWNER, goalId: 'g-rutherford2', projectId: PROJECT_ID, title: 'Row',
  status: 'in_progress', blockedReason: null, blockKind: null, gateQuestionId: null,
  progressNote: null, assigneeChatId: null, startedAt: null, evidence: null, doneRunId: null,
  updatedByChatId: null, updatedByRunId: null, blockedAt: null, createdAt: new Date(), updatedAt: new Date(),
  ...over,
});

const VERIFY_TITLE =
  'Verify cutover: /v1/models roster vs 50, census script, StAnne legs (mbp-2 utility 100.64.0.1:8095, asr, ' +
  'accelerator image 100.64.0.1), self-hosted tailnet legs (node-a 100.64.0.1:8091, node-b 100.64.0.1:8000, GLM nodes), ' +
  'E2E completion through https://llm.cql.ca';

beforeEach(() => {
  db.projects = [{ id: PROJECT_ID, userId: OWNER, name: 'LiteLLM', path: '/litellm' }];
  db.goals = [goalRow()];
  db.todos = [
    todoRow({ id: FE467CED, title: 'DNS cutover llm.cql.ca → rutherford-2 (Tunnel edge per owner dedicated-host design, or A record 69.19.140.37)' }),
    todoRow({ id: ED2FD190, title: 'Mint virtual keys for the infrastructure callers named in the verify row' }),
    todoRow({ id: VERIFY_TODO, title: VERIFY_TITLE, status: 'blocked', blockedReason: 'Awaiting the fleet verify pass' }),
    todoRow({ id: DEPLOY_TODO, title: 'Deploy the gateway to rutherford-2', status: 'done' }),
    todoRow({ id: SWEEP_TODO, title: 'Remove box known-down drop-in 30-stanne-known-down.conf when S6 recovers' }),
  ];
  // The adjudicated topology (sighting 62f14ea6 live reads): the cutover row's
  // ONLY dep is the DONE deploy row; the SWEEP row is the one gated on the
  // still-blocked verify row — the 409 was the gate holding the line on the
  // sweep row's own dep chain, never a false block on the cutover row.
  db.todoDeps = [
    { todoId: FE467CED, dependsOnTodoId: DEPLOY_TODO },
    { todoId: SWEEP_TODO, dependsOnTodoId: VERIFY_TODO },
  ];
  jest.clearAllMocks(); // clears call data only — implementations survive
});

describe('ticket 596718e7 — the two todo_update guards refused correctly (store side)', () => {
  it("REPLAY 21:51:20: the done+evidence close on the SWEEP row (the 409's actual target) while its verify dep is still blocked 409s with the incident's verbatim text — and names the blocking dep", async () => {
    await expect(updateTodo({
      userId: OWNER, todoId: SWEEP_TODO, status: 'done', evidence: EVIDENCE_ARG,
      actingChatId: 'sess-596718e7', actingRunId: 'run-596718e7',
    })).rejects.toThrow(
      `Todo cannot be marked done: waiting on 1 todo(s) not done: "${VERIFY_TITLE}" (blocked). Pass force: true to override.`,
    );
    // The row is UNTOUCHED — no partial write leaked past the gate.
    expect(db.todos.find((t) => t.id === SWEEP_TODO)!.status).toBe('in_progress');
    expect(db.todos.find((t) => t.id === SWEEP_TODO)!.evidence).toBeNull();
  });

  it("the cutover row's own dep set was SATISFIED (only the done deploy row): the same done attempt on fe467ced CLOSES cleanly — the 409 was the sweep row's dep chain, never a false block on the cutover row", async () => {
    const v = await updateTodo({
      userId: OWNER, todoId: FE467CED, status: 'done', evidence: EVIDENCE_ARG,
      actingChatId: 'sess-596718e7', actingRunId: 'run-596718e7',
    });
    expect(v.status).toBe('done');
    expect(v.evidence).toBe(EVIDENCE_ARG);
  });

  it("force:true overrides the open-dep gate (audit-logged) — the refusal text's own escape hatch, honored", async () => {
    const v = await updateTodo({
      userId: OWNER, todoId: SWEEP_TODO, status: 'done', evidence: EVIDENCE_ARG, force: true,
      actingChatId: 'sess-596718e7', actingRunId: 'run-596718e7',
    });
    expect(v.status).toBe('done');
    const auditCall = mockPrisma.activity.create.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.data?.action === 'todo.force_done');
    expect(auditCall).toBeDefined(); // the override is audit-logged, never silent
  });

  it('REPLAY 21:51:33: blockedReason WITHOUT status on an in_progress row 400s with the incident\'s verbatim text — never a silent no-op', async () => {
    await expect(updateTodo({
      userId: OWNER, todoId: ED2FD190, blockedReason: REASON_ARG,
    })).rejects.toThrow(
      "blockedReason can only be set on a blocked todo (current status: 'in_progress'). Pass status:'blocked' to block it first.",
    );
    // Nothing wrote — the reason is not silently dropped OR stored.
    expect(db.todos.find((t) => t.id === ED2FD190)!.blockedReason).toBeNull();
    expect(db.todos.find((t) => t.id === ED2FD190)!.status).toBe('in_progress');
  });

  it('the refresh leg PR #186 added: the SAME reason-only call on an ALREADY-blocked row refreshes the reason (apply, not reject)', async () => {
    db.todos = db.todos.map((t) => t.id === ED2FD190 ? { ...t, status: 'blocked', blockedReason: 'Awaiting the fleet verify pass' } : t);
    const v = await updateTodo({ userId: OWNER, todoId: ED2FD190, blockedReason: REASON_ARG });
    expect(v.status).toBe('blocked');
    expect(v.blockedReason).toBe(REASON_ARG);
  });

  it('REPLAY 21:54:14 (the recovery): status:\'blocked\' WITH the reason lands BOTH fields — the guard text\'s own instruction, working', async () => {
    const v = await updateTodo({
      userId: OWNER, todoId: ED2FD190, status: 'blocked', blockedReason: 'Fleet verify pass outstanding: StAnne legs, tailnet legs, E2E through the edge.',
    });
    expect(v.status).toBe('blocked');
    expect(v.blockedReason).toBe('Fleet verify pass outstanding: StAnne legs, tailnet legs, E2E through the edge.');
    expect(db.todos.find((t) => t.id === ED2FD190)!.status).toBe('blocked');
    expect(db.todos.find((t) => t.id === ED2FD190)!.blockedReason).toBe('Fleet verify pass outstanding: StAnne legs, tailnet legs, E2E through the edge.');
  });
});

/**
 * REPLAY PIN — ticket 62f14ea6 (general_feedback sighting, 2026-10-15) on the
 * auto-filed mishap 596718e7: the "3× tool-failure streak: todo_update" trip.
 *
 * This file pins the GUARD SEMANTICS half of the adjudication: both refused
 * calls in the incident were CORRECT goals.service behavior — the loop
 * arithmetic (weighted count, intent-mismatch +1, one-round withhold,
 * two-texts-under-a-"3×"-title) is pinned in
 * agent-derail-break.62f14ea6.test.ts.
 *
 * The incident (session 26be18cc-2b9c-489c-98bb-eb727dbb9252, run
 * 4dbde611-6ffb-4ceb-92e1-29321d09a6ee, 21:51Z) — two refusals, both correct:
 *   · Refusal 1 (receipt 0f0969c1): a standalone blockedReason refresh on the
 *     DNS cutover row fe467ced (status 'in_progress') — goals.service's
 *     documented silent-no-op repair (the "never silently drop an accepted
 *     parameter" guard, :2824-2832): 400 with "blockedReason can only be set
 *     on a blocked todo (current status: 'in_progress'). Pass status:'blocked'
 *     to block it first." The remedy is truthful: status:'blocked' + the
 *     reason lands in ONE call.
 *   · Refusal 2 (receipt aa12af7d): a done attempt on the drop-in sweep
 *     06c26d0f while its REAL dependency 10023020 ("Verify cutover…") was
 *     still blocked (done only at 22:14:22Z; 06c26d0f closed 22:24:01Z) — the
 *     done-gate (:2762-2769) named the dependency's title + status verbatim
 *     and offered force:true. Correct against the args given: live todo_get
 *     reads (this lane, 2026-10-16) show 06c26d0f dependsOn [10023020] and
 *     10023020 dependsOn [ed2fd190, fe467ced] — the dependency chain the gate
 *     enforced is real, not inverted.
 *
 * VERDICT: no deterministic framework defect — model behavior (mis-targeted
 * close-out calls; the lane recovered on its own 3 minutes later, receipts
 * f7e8c9c0 + 5bd284cf at 21:54:14Z). Both guards keep their exact contracts.
 *
 * Scaffold mirrors goals.service.d76750f5.test.ts (stateful fake DB).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Stateful fake DB ─────────────────────────────────────────────────────────
const OWNER = 'u-owner';
const PROJECT_ID = 'p-rutherford2';

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
  todoDependency: {
    findMany: jest.fn(async (args: any = {}) => db.todoDeps.filter((d) => matchRow(d, args.where))),
    createMany: jest.fn(),
    deleteMany: jest.fn(),
  },
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

import { updateTodo } from './goals.service';

// ── The incident's verbatim ids (goal ef33afb6, live todo_get reads 2026-10-16).
const GOAL = 'ef33afb6-ab77-4077-a816-3e8ec54fb36e'; // Rebuild llm.example.com on Hyperstack rutherford-2
const DNS_TODO = 'fe467ced-572a-49db-aff8-02dac35030c6'; // DNS cutover (in_progress at 21:51Z)
const SWEEP_TODO = '06c26d0f-a77f-41dc-adcb-c3268309a2db'; // drop-in sweep (the done attempt — dependsOn VERIFY)
const VERIFY = '10023020-f24b-4416-8aeb-e9072c70003a';    // "Verify cutover…" (blocked at 21:51Z)
const VERIFY_TITLE =
  'Verify cutover: /v1/models roster vs 50, census script, StAnne legs (mbp-2 utility 100.64.0.11:8095, asr, ' +
  'edge image 100.64.0.12), self-hosted tailnet legs (box-a 100.64.0.13:8091, box-b 100.64.0.14:8000, ' +
  'GLM nodes), E2E completion through https://llm.example.com';

const todoRow = (over: any = {}) => ({
  id: DNS_TODO,
  userId: OWNER,
  goalId: GOAL,
  projectId: PROJECT_ID,
  title: 'DNS cutover llm.example.com → rutherford-2 via Cloudflare',
  status: 'in_progress',
  blockedReason: null,
  blockKind: null,
  gateQuestionId: null,
  progressNote: null,
  startedAt: new Date('2026-10-15T21:51:20.594Z'),
  assigneeChatId: null,
  evidence: null,
  doneRunId: null,
  updatedAt: new Date('2026-10-15T21:51:20.594Z'),
  ...over,
});

beforeEach(() => {
  db.projects = [{ id: PROJECT_ID, userId: OWNER, name: 'rutherford-2', path: '/r2' }];
  db.goals = [];
  db.todos = [];
  db.goalDeps = [];
  db.todoDeps = [];
  db.ownerQuestions = [];
  jest.clearAllMocks(); // clears call data only — implementations survive
});

describe('62f14ea6 — refusal 1 (receipt 0f0969c1): the standalone blockedReason guard on a NON-blocked todo', () => {
  it('REPLAY: blockedReason with no status transition on an in_progress todo 400s with the filed text verbatim', async () => {
    db.todos.push(todoRow({ status: 'in_progress' }));
    await expect(updateTodo({
      userId: OWNER, todoId: DNS_TODO,
      blockedReason: 'Client list is owner/fleet-side: per the 2026-10-11 incident brief every caller requests a virtual key through the owner/gateway lane.',
    })).rejects.toThrow(
      `blockedReason can only be set on a blocked todo (current status: 'in_progress'). Pass status:'blocked' to block it first.`,
    );
    // Nothing wrote: the row is unchanged.
    const t = db.todos.find((r) => r.id === DNS_TODO)!;
    expect(t.status).toBe('in_progress');
    expect(t.blockedReason).toBeNull();
  });

  it('the remedy in the refusal text is truthful: status:"blocked" + the reason lands in ONE call (the recovery path)', async () => {
    db.todos.push(todoRow({ status: 'in_progress' }));
    const v = await updateTodo({
      userId: OWNER, todoId: DNS_TODO,
      status: 'blocked', blockedReason: 'Held for the owner re-mint queue (infra/SECRETS.md).',
    });
    expect(v.status).toBe('blocked');
    expect(v.blockedReason).toBe('Held for the owner re-mint queue (infra/SECRETS.md).');
    expect(db.todos[0].status).toBe('blocked');
  });

  it('the guard stays out of the way of a legitimate refresh: blockedReason on an ALREADY-blocked row updates the reason', async () => {
    db.todos.push(todoRow({ status: 'blocked', blockedReason: 'Stale reason' }));
    const v = await updateTodo({ userId: OWNER, todoId: DNS_TODO, blockedReason: 'Refreshed blocker note' });
    expect(v.blockedReason).toBe('Refreshed blocker note');
    expect(db.todos[0].status).toBe('blocked'); // no status change — a pure refresh
  });
});

describe('62f14ea6 — refusal 2 (receipt aa12af7d): the done-gate on a todo whose dependency is genuinely open', () => {
  it('REPLAY: done on 06c26d0f while its dependency 10023020 is blocked 409s naming the dependency title + status, with force:true offered', async () => {
    db.todos.push(todoRow({ id: SWEEP_TODO, title: 'Remove box known-down drop-in 30-stanne-known-down.conf when S6 recovers', status: 'in_progress' }));
    db.todos.push(todoRow({ id: VERIFY, title: VERIFY_TITLE, status: 'blocked' }));
    db.todoDeps.push({ todoId: SWEEP_TODO, dependsOnTodoId: VERIFY });

    await expect(updateTodo({
      userId: OWNER, todoId: SWEEP_TODO, status: 'done',
      evidence: 'Fresh-host verification this run (SSH deploy@203.0.113.10): no KNOWN_DOWN overrides in any systemd drop-in.',
    })).rejects.toThrow(
      `Todo cannot be marked done: waiting on 1 todo(s) not done: "${VERIFY_TITLE}" (blocked). Pass force: true to override.`,
    );
    // Nothing wrote: the row is still open, no evidence recorded.
    const t = db.todos.find((r) => r.id === SWEEP_TODO)!;
    expect(t.status).toBe('in_progress');
    expect(t.evidence).toBeNull();
  });

  it('the gate tells the truth about the WORLD, not just the args: once the verify row is done the same close LANDS (the 22:24Z recovery shape)', async () => {
    db.todos.push(todoRow({ id: SWEEP_TODO, title: 'Remove box known-down drop-in 30-stanne-known-down.conf when S6 recovers', status: 'in_progress' }));
    db.todos.push(todoRow({ id: VERIFY, title: VERIFY_TITLE, status: 'done' }));
    db.todoDeps.push({ todoId: SWEEP_TODO, dependsOnTodoId: VERIFY });

    const v = await updateTodo({
      userId: OWNER, todoId: SWEEP_TODO, status: 'done',
      evidence: 'Verified via cutover verify todo: the fresh host deploys from repo main, which never carried 30-stanne-known-down.conf.',
    });
    expect(v.status).toBe('done');
    expect(db.todos.find((r) => r.id === SWEEP_TODO)!.evidence).toContain('never carried');
  });

  it('the incident dependency chain is real (not inverted): the verify row closes ONLY after its own deps land — the sweep cannot close first (the direction the gate enforced)', async () => {
    // Live reads (goal ef33afb6): SWEEP dependsOn VERIFY; VERIFY dependsOn
    // [ed2fd190, fe467ced]. The behavioural proof of direction, through the
    // real done-gate, with EVERY dep row present so the gate sees them:
    db.todos.push(todoRow({ id: SWEEP_TODO, title: 'sweep', status: 'in_progress' }));
    db.todos.push(todoRow({ id: VERIFY, title: VERIFY_TITLE, status: 'in_progress' }));
    db.todos.push(todoRow({ id: DNS_TODO, title: 'DNS cutover llm.example.com', status: 'in_progress' }));
    const MINT = 'ed2fd190-9846-42c6-a938-d7ccefcab5ed';
    db.todos.push(todoRow({ id: MINT, title: 'Mint per-client virtual keys', status: 'done' }));
    db.todoDeps.push({ todoId: VERIFY, dependsOnTodoId: DNS_TODO });
    db.todoDeps.push({ todoId: VERIFY, dependsOnTodoId: MINT });
    db.todoDeps.push({ todoId: SWEEP_TODO, dependsOnTodoId: VERIFY });

    // With DNS still OPEN (in_progress — NOT in TODO_DONE_ISH), VERIFY's close
    // is refused by the real gate naming DNS: the 21:51Z refusal class.
    await expect(updateTodo({ userId: OWNER, todoId: VERIFY, status: 'done', evidence: 'premature' }))
      .rejects.toThrow(`Todo cannot be marked done: waiting on 1 todo(s) not done: "DNS cutover llm.example.com" (in_progress). Pass force: true to override.`);

    // DNS lands (the 22:03Z close)…
    const dns = await updateTodo({ userId: OWNER, todoId: DNS_TODO, status: 'done', evidence: 'A record created, edge verified 200' });
    expect(dns.status).toBe('done');
    // …VERIFY now closes (deps all done — the 22:14:22Z close, no force needed)…
    const v = await updateTodo({ userId: OWNER, todoId: VERIFY, status: 'done', evidence: 'roster verified: 50 routes' });
    expect(v.status).toBe('done');
    // …and ONLY THEN does SWEEP's close land — the 22:24:01Z close.
    const s = await updateTodo({ userId: OWNER, todoId: SWEEP_TODO, status: 'done', evidence: 'no drop-in on the fresh host' });
    expect(s.status).toBe('done');
  });
});

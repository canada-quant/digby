/**
 * sup3 audit C2 (2026-09-27) — goal done-suspect at BOTH close seams.
 *
 * Finding: the done gate (updateGoal) checks dependency goals only, so a goal
 * closed 'done' with its OWN target premise unmet (spark a57fb2e2 "≥20 tok/s"
 * done at 5.33), a HOLD progressNote (bench f6b31f1b "redeploy of :3001
 * held" — 34 HOLD reports followed), or an open owner directive naming it
 * left no contradiction anywhere. Fix under test: the close STANDS (observe-
 * only, gate flip 2026-09-11) and ONE goal_done_suspect loop_metrics row + a
 * goal.done_suspect audit row + a doneSuspect note on the tool result record
 * it — on goal_update status:'done' (seam 'update', force included) and on
 * the todo-driven auto-done cascade (seam 'auto').
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const OWNER = 'u-owner';
const PROJECT_ID = 'p-spark';

const db: { projects: any[]; goals: any[]; todos: any[]; goalDeps: any[]; todoDeps: any[]; ownerQuestions: any[] } =
  { projects: [], goals: [], todos: [], goalDeps: [], todoDeps: [], ownerQuestions: [] };

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
  goalDependency: {
    findMany: jest.fn(async (args: any = {}) => db.goalDeps.filter((d) => matchRow(d, args.where))),
    createMany: jest.fn(), deleteMany: jest.fn(),
  },
  todoDependency: { findMany: jest.fn(async () => []), createMany: jest.fn(), deleteMany: jest.fn() },
  ownerQuestion: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
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
jest.mock('../memory/context-store', () => ({ __esModule: true, storeGet: jest.fn(async () => null), storePut: jest.fn(async () => {}) }));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  enqueueDirectWake: jest.fn(async () => ({ ok: true, hookEventId: 'he-1' })),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));
// The dynamic-import boundary: goals.service does await import('./supervisor-state.service').
const mockListOpenDirectives: jest.Mock = jest.fn(async () => []);
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  listOpenDirectivesForUser: (...a: any[]) => mockListOpenDirectives(...a),
}));

import { updateGoal, updateTodo } from './goals.service';

const SPARK_GOAL = 'g-a57fb2e2-0000-4000-8000-000000000000';
const BENCH_GOAL = 'g-f6b31f1b-0000-4000-8000-000000000000';
const goalRow = (over: any = {}) => ({
  id: SPARK_GOAL, userId: OWNER, projectId: PROJECT_ID, title: 'vLLM serving ≥20 tok/s on the quant box',
  status: 'active', blockedReason: null, blockKind: null, gateQuestionId: null, progressNote: null,
  premises: [], createdByChatId: null, ...over,
});
const todoRow = (over: any = {}) => ({
  id: 't-1', userId: OWNER, goalId: SPARK_GOAL, projectId: PROJECT_ID, title: 'Bench the serving box',
  status: 'pending', blockedReason: null, blockKind: null, gateQuestionId: null, progressNote: null,
  assigneeChatId: null, startedAt: null, ...over,
});
const auditCalls = (action: string) =>
  mockPrisma.activity.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => d?.action === action);
const suspectMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'goal_done_suspect');

beforeEach(() => {
  db.projects = [{ id: PROJECT_ID, userId: OWNER, name: 'spark-cluster', path: '/spark' }];
  db.goals = []; db.todos = []; db.goalDeps = []; db.todoDeps = []; db.ownerQuestions = [];
  mockListOpenDirectives.mockImplementation(async () => []);
  jest.clearAllMocks();
});

describe('C2 — goal closed done with its own target premise unmet / HOLD note / open directive', () => {
  it('REPLAY spark a57fb2e2: goal_update done at observed 5.33 tok/s STANDS but is recorded suspect (metric + audit + note)', async () => {
    db.goals.push(goalRow({ premises: [{ key: 'target_tok_per_s', value: 20, unit: 'tok/s', observed: 5.33, drift: 'drift' }] }));
    const v = await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'done', actingChatId: 'c-lane', actingRunId: 'r-9' });
    // Observe-only: the close lands.
    expect(v.status).toBe('done');
    expect(db.goals[0].status).toBe('done');
    // …and the contradiction is recorded on the tool result…
    expect(v.doneSuspect).toEqual(['premise_target_unmet']);
    expect(v.doneSuspectNote).toContain('target_tok_per_s ≥20tok/s, observed 5.33tok/s');
    expect(v.doneSuspectNote).toContain('the close stands');
    // …as ONE loop metric carrying the seam + authorship…
    const rows = suspectMetrics();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ kind: 'goal_done_suspect', sessionId: 'c-lane' }));
    expect(rows[0].meta).toEqual(expect.objectContaining({
      goalId: 'g-a57fb2', projectId: 'p-spark', seam: 'update', reasons: ['premise_target_unmet'], force: false, actingChatId: 'c-lane',
      unmet: [{ key: 'target_tok_per_s', value: 20, observed: 5.33, bound: 'min' }],
    }));
    // …and an audit row alongside the classic goal.update.
    expect(auditCalls('goal.done_suspect')).toHaveLength(1);
    expect(auditCalls('goal.done_suspect')[0].metadata).toEqual(expect.objectContaining({ goalId: SPARK_GOAL, seam: 'update', actingRunId: 'r-9' }));
    expect(auditCalls('goal.update')).toHaveLength(1);
  });

  it('REPLAY bench f6b31f1b: a HOLD progressNote supplied IN THE SAME CALL as status:done is a hold_token suspect', async () => {
    db.goals.push(goalRow({ id: BENCH_GOAL, title: 'Redeploy canlegal-bench on :3001' }));
    const v = await updateGoal({ userId: OWNER, goalId: BENCH_GOAL, status: 'done', progressNote: 'redeploy of :3001 held' });
    expect(v.status).toBe('done');
    expect(v.doneSuspect).toEqual(['hold_token']);
    expect(suspectMetrics()[0].meta).toEqual(expect.objectContaining({ seam: 'update', reasons: ['hold_token'], holdToken: 'held' }));
  });

  it('the blockedReason the transition just CLEARED does not count (a blocked→done close with a clean note is clean)', async () => {
    db.goals.push(goalRow({ status: 'blocked', blockedReason: 'HOLD until the GPU box is back', blockKind: 'agent' }));
    const v = await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'done' });
    expect(v.status).toBe('done');
    expect(v.doneSuspect).toBeUndefined();
    expect(suspectMetrics()).toHaveLength(0);
  });

  it('an open owner directive (last 72h, outside the grace window) naming the goal is an open_directive suspect; a directive lookup failure is fail-open', async () => {
    db.goals.push(goalRow());
    mockListOpenDirectives.mockImplementation(async () => [
      { id: 'd-11112222', text: 'Keep the vLLM serving lane on the tok/s target until the quant box holds it', at: new Date(Date.now() - 5 * 3600_000).toISOString(), chatId: 'c-fleet' },
    ]);
    const v = await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'done' });
    expect(v.doneSuspect).toEqual(['open_directive']);
    expect(suspectMetrics()[0].meta).toEqual(expect.objectContaining({ reasons: ['open_directive'], boardReasons: [], directiveIds: ['d-111122'] }));
    expect(mockListOpenDirectives).toHaveBeenCalledWith(OWNER, expect.any(Number));
    // Finding 3: the project NAME is read so directives scoped to another project are ignored.
    expect(mockPrisma.crossModelProject.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: PROJECT_ID }, select: { name: true } }));

    // Fail-open: the lookup throwing leaves the close clean (and never throws out).
    jest.clearAllMocks();
    db.goals = [goalRow({ status: 'active' })];
    mockListOpenDirectives.mockImplementation(async () => { throw new Error('store down'); });
    const v2 = await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'done' });
    expect(v2.status).toBe('done');
    expect(v2.doneSuspect).toBeUndefined();
  });

  it('finding 3 (review fix): the close the owner ORDERED, a directive inside the grace window, and another project\'s directive are NOT open_directive suspects; a same-project older non-ordering directive still is', async () => {
    const H = 3600_000;
    const keep = 'Keep the vLLM serving lane on the tok/s target until the quant box holds it';
    db.goals.push(goalRow());
    mockListOpenDirectives.mockImplementation(async () => [
      { id: 'd-ordered1', text: 'Mark the vLLM serving goal done — the 20 tok/s bar is met, I checked the box myself', at: new Date(Date.now() - 5 * H).toISOString(), chatId: 'c-fleet', scope: 'spark-cluster' },
      { id: 'd-fresh001', text: keep, at: new Date(Date.now() - 5 * 60_000).toISOString(), chatId: 'c-sup', scope: 'spark-cluster' },
      { id: 'd-canlaw01', text: keep, at: new Date(Date.now() - 5 * H).toISOString(), chatId: 'c-canlaw', scope: 'CanLaw' },
    ]);
    const v = await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'done' });
    expect(v.status).toBe('done');
    expect(v.doneSuspect).toBeUndefined();
    expect(suspectMetrics()).toHaveLength(0);
    expect(auditCalls('goal.done_suspect')).toHaveLength(0);

    jest.clearAllMocks();
    db.goals = [goalRow()];
    mockListOpenDirectives.mockImplementation(async () => [
      { id: 'd-spark001', text: keep, at: new Date(Date.now() - 5 * H).toISOString(), chatId: 'c-sup', scope: 'spark-cluster' },
      { id: 'd-fleet001', text: keep, at: new Date(Date.now() - 6 * H).toISOString(), chatId: 'c-fleet', scope: 'fleet' },
    ]);
    const v2 = await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'done' });
    expect(v2.doneSuspect).toEqual(['open_directive']);
    expect(suspectMetrics()[0].meta).toEqual(expect.objectContaining({ directiveIds: ['d-spark0', 'd-fleet0'] }));
  });

  it('finding 1 (review fix): a source-less target premise with only a note is premise_target_unobserved — metric row, NO board reason, remedy = record the measured value (never reopen)', async () => {
    db.goals.push(goalRow({ premises: [{ key: 'target_tok_per_s', value: 20, note: 'measured 24.1 in run r-9' }] }));
    const v = await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'done' });
    expect(v.status).toBe('done');
    expect(v.doneSuspect).toEqual(['premise_target_unobserved']);
    expect(v.doneSuspectNote).toContain('record the measured value with goal_premise_set observed + observedNote');
    expect(v.doneSuspectNote).not.toContain('reopen');
    expect(v.doneSuspectNote).not.toContain('⚠ suspect');
    expect(suspectMetrics()[0].meta).toEqual(expect.objectContaining({ reasons: ['premise_target_unobserved'], boardReasons: [], unobserved: ['target_tok_per_s'], unmet: [] }));
    // …and once the lane records the measured value (goal_premise_set observed + observedNote) the close is clean.
    jest.clearAllMocks();
    db.goals = [goalRow({ premises: [{ key: 'target_tok_per_s', value: 20, observed: 24.1, observedAt: new Date().toISOString(), observedNote: 'run r-9' }] })];
    const v2 = await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'done' });
    expect(v2.doneSuspect).toBeUndefined();
    expect(suspectMetrics()).toHaveLength(0);
  });

  it('finding 4 (review fix): a progress note in the verb sense ("holds at 24.1 tok/s", "halted the stale container") is a clean close', async () => {
    db.goals.push(goalRow({ premises: [{ key: 'target_tok_per_s', value: 20, observed: 24.1, observedNote: 'run r-9' }] }));
    const v = await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'done', progressNote: 'benchmark holds at 24.1 tok/s; halted the stale :3001 container, new one serves' });
    expect(v.status).toBe('done');
    expect(v.doneSuspect).toBeUndefined();
    expect(suspectMetrics()).toHaveLength(0);
  });

  it('force:true over open deps records BOTH goal.force_done and the suspect row with force:true', async () => {
    db.goals.push(
      goalRow({ premises: [{ key: 'target_tok_per_s', value: 20, observed: 5.33 }] }),
      goalRow({ id: 'g-dep', title: 'Blocker', status: 'active' }),
    );
    db.goalDeps.push({ goalId: SPARK_GOAL, dependsOnGoalId: 'g-dep' });
    const v = await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'done', force: true });
    expect(v.status).toBe('done');
    expect(auditCalls('goal.force_done')).toHaveLength(1);
    expect(suspectMetrics()[0].meta).toEqual(expect.objectContaining({ force: true, reasons: ['premise_target_unmet'] }));
  });

  it('the todo-driven AUTO-DONE cascade is the second seam (seam:auto) — the cascade itself stays unconditional', async () => {
    db.goals.push(goalRow({ premises: [{ key: 'target_tok_per_s', value: 20, observed: 5.33 }] }));
    db.todos.push(todoRow());
    await updateTodo({ userId: OWNER, todoId: 't-1', status: 'done' });
    expect(db.goals[0].status).toBe('done'); // cascade unchanged
    expect(auditCalls('goal.auto_done')).toHaveLength(1);
    const rows = suspectMetrics();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual(expect.objectContaining({ seam: 'auto', reasons: ['premise_target_unmet'], goalId: 'g-a57fb2' }));
    expect(auditCalls('goal.done_suspect')).toHaveLength(1);
  });

  it('a clean close (met target, plain note, no directive) records nothing; done→done re-sends record nothing', async () => {
    db.goals.push(goalRow({ premises: [{ key: 'target_tok_per_s', value: 20, observed: 24.1 }], progressNote: '3/3 shards served' }));
    const v = await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'done' });
    expect(v.doneSuspect).toBeUndefined();
    expect(suspectMetrics()).toHaveLength(0);
    expect(auditCalls('goal.done_suspect')).toHaveLength(0);
    // Already done: no status change ⇒ no assessment.
    jest.clearAllMocks();
    db.goals[0].premises = [{ key: 'target_tok_per_s', value: 20, observed: 5 }];
    await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'done' });
    expect(suspectMetrics()).toHaveLength(0);
  });

  // ── the reopen half of the label (2026-09-28) ─────────────────────────────
  const outcomeRows = () => suspectMetrics().filter((m) => m?.meta?.phase === 'outcome');

  it('REOPEN label (seam update): a done goal moved back to active writes ONE goal_done_suspect outcome row {actual:reopened, sinceCloseMs, withinWindow} — the close itself is never reverted', async () => {
    db.goals.push(goalRow({ status: 'done', updatedAt: new Date(Date.now() - 2 * 3600_000) }));
    const v = await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'active', actingChatId: 'c-sup' });
    expect(v.status).toBe('active');
    const rows = outcomeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ kind: 'goal_done_suspect', sessionId: 'c-sup' }));
    expect(rows[0].meta).toEqual(expect.objectContaining({ phase: 'outcome', actual: 'reopened', seam: 'update', goalId: 'g-a57fb2', projectId: 'p-spark', withinWindow: true, actingChatId: 'c-sup' }));
    expect(rows[0].meta.sinceCloseMs).toBeGreaterThanOrEqual(2 * 3600_000 - 1000);
    expect(rows[0].meta.sinceCloseMs).toBeLessThan(3 * 3600_000);
  });

  it('REOPEN label: a close older than the 7-day window labels withinWindow:false; an unknown close time labels null; an active→blocked move (never done) writes nothing', async () => {
    db.goals.push(goalRow({ status: 'done', updatedAt: new Date(Date.now() - 9 * 86400_000) }));
    await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'blocked', blockedReason: 'regressed' });
    expect(outcomeRows()[0].meta).toEqual(expect.objectContaining({ actual: 'reopened', withinWindow: false }));
    jest.clearAllMocks();
    db.goals = [goalRow({ id: BENCH_GOAL, status: 'done' })]; // no updatedAt on the row
    await updateGoal({ userId: OWNER, goalId: BENCH_GOAL, status: 'active' });
    expect(outcomeRows()[0].meta).toEqual(expect.objectContaining({ goalId: 'g-f6b31f', withinWindow: null, sinceCloseMs: null }));
    jest.clearAllMocks();
    db.goals = [goalRow({ status: 'active' })];
    await updateGoal({ userId: OWNER, goalId: SPARK_GOAL, status: 'blocked', blockedReason: 'waiting' });
    expect(outcomeRows()).toHaveLength(0);
  });

  it('REOPEN label (seam auto): a todo reopened under a DONE goal auto-reopens the goal AND labels the close with seam:auto', async () => {
    db.goals.push(goalRow({ status: 'done', updatedAt: new Date(Date.now() - 3600_000) }));
    db.todos.push(todoRow({ status: 'done' }));
    await updateTodo({ userId: OWNER, todoId: 't-1', status: 'pending' });
    expect(db.goals[0].status).toBe('active');
    expect(auditCalls('goal.auto_reopen')).toHaveLength(1);
    const rows = outcomeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual(expect.objectContaining({ phase: 'outcome', actual: 'reopened', seam: 'auto', goalId: 'g-a57fb2', withinWindow: true }));
  });
});

/**
 * GOAL-OUTCOME-UNMET (architecture review #3, 2026-10-20) at BOTH close seams
 * + the goal/todo transition telemetry (architecture review #6 part 4).
 *
 * Finding: maybeAutoCompleteGoal closed a goal 'done' the moment its last todo
 * landed and never read its premises — a goal whose KPI of record sat below
 * its bar closed silently and nobody re-planned. Under test:
 *  - the cascade close STANDS (observe-only by default), writes the close
 *    record and wakes the PROJECT SUPERVISOR once with
 *    '[GOAL OUTCOME UNMET — RE-PLAN]' (Redis NX 24 h keyed by goal + KPI value
 *    + receipt), plus a goal_outcome_unmet row;
 *  - goal_update done: a MACHINE close by a lane wakes the supervisor; the
 *    supervisor's own close does not wake itself (its result says the project
 *    stays live); only the OWNER accepts the outcome — a JWT REST write
 *    (status-only on an already-done goal) or a human turn whose own message
 *    names the close; an agent-origin / owner-dispatch lane run that inherited
 *    userTurnAt, or a model's own close on a human turn, never does (review
 *    fix); a thrown Redis SET is 'redis_error', never 'deduped';
 *  - opt-in GOAL_OUTCOME_GATE_ENFORCE=1 holds the cascade (goal stays open,
 *    '[outcome unmet]' note) while an explicit goal_update done still closes;
 *  - GOAL_OUTCOME_CHECK_DISABLED=1 restores the pre-change close;
 *  - goal_transition / todo_transition rows (GOAL_TRANSITION_METRICS_DISABLED=1).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const OWNER = 'u-owner';
const PROJECT_ID = 'p-ttrd';
const SUP = 'sup-chat-0000-4000-8000-000000000000';
const LANE = 'lane-chat-0000-4000-8000-000000000000';

const db: { projects: any[]; goals: any[]; todos: any[]; goalDeps: any[]; chats: any[] } =
  { projects: [], goals: [], todos: [], goalDeps: [], chats: [] };

function matchRow(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v === undefined) return true;
    if (v === null) return row[k] == null;
    if (k === 'OR') return (v as any[]).some((clause) => matchRow(row, clause));
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
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
  findFirst: jest.fn(async ({ where, select }: any = {}) => {
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
  crossModelProject: { ...table(() => db.projects) },
  crossModelChat: { ...table(() => db.chats) },
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
const redisKeys = new Map<string, string>();
const mockRedis = {
  get: jest.fn(async (k: string) => redisKeys.get(k) ?? null),
  set: jest.fn(async (k: string, v: string, o?: any) => {
    if (o?.NX && redisKeys.has(k)) return null;
    redisKeys.set(k, v);
    return 'OK';
  }),
  del: jest.fn(async (k: string) => { redisKeys.delete(k); return 1; }),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
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
const store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => store.get(`${ns.join(':')}/${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, v: any) => { store.set(`${ns.join(':')}/${key}`, v); }),
}));
const mockEnqueueDirectWake: jest.Mock = jest.fn(async () => ({ ok: true, hookEventId: 'he-1' }));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
}));
const mockSwitchOn = jest.fn(async () => true);
jest.mock('./supervisor-switch', () => ({ __esModule: true, getProjectSupervisorsEnabled: () => mockSwitchOn() }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));
jest.mock('./supervisor-state.service', () => ({ __esModule: true, listOpenDirectivesForUser: jest.fn(async () => []) }));

import { updateGoal, updateTodo, createTodo, rowAgeHours } from './goals.service';
import { ledgerToolMachineTriggered } from './goal-outcome';
import { holdTokenIn } from './goal-done-suspect';
import { progressNoteLead } from './progress-note';
import { isUnplannedGoal } from './goal-unplanned';

const GOAL = 'g-226be7b7-0000-4000-8000-000000000000';
const RID = 'f5b42fe6-1111-4000-8000-000000000000';
const KPI = { key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s', bar: 10, receiptId: RID, setAt: new Date(Date.now() - 2 * 3600_000).toISOString(), history: [{ value: 3.44 }] };
const goalRow = (over: any = {}) => ({
  id: GOAL, userId: OWNER, projectId: PROJECT_ID, title: 'Qwen serving ≥10 tok/s on node-a',
  status: 'active', blockedReason: null, blockKind: null, gateQuestionId: null, progressNote: null,
  premises: [KPI], createdByChatId: null, createdAt: new Date(Date.now() - 48 * 3600_000), ...over,
});
const todoRow = (over: any = {}) => ({
  id: 't-1', userId: OWNER, goalId: GOAL, projectId: PROJECT_ID, title: 'Adopt the paged-KV lever',
  status: 'in_progress', blockedReason: null, blockKind: null, gateQuestionId: null, progressNote: null,
  assigneeChatId: LANE, startedAt: null, createdAt: new Date(Date.now() - 5 * 3600_000), ...over,
});
const metrics = (kind: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === kind);
const auditCalls = (action: string) =>
  mockPrisma.activity.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => d?.action === action);

beforeEach(() => {
  db.projects = [{ id: PROJECT_ID, userId: OWNER, name: 'tt-rd', path: '/ttrd', projectSupervisorEnabled: true, archivedAt: null }];
  db.goals = []; db.todos = []; db.goalDeps = [];
  db.chats = [{ id: SUP, userId: OWNER, projectId: PROJECT_ID, isProjectSupervisor: true, archivedAt: null }];
  redisKeys.clear();
  store.clear();
  jest.clearAllMocks();
  mockSwitchOn.mockImplementation(async () => true);
  mockEnqueueDirectWake.mockImplementation(async () => ({ ok: true, hookEventId: 'he-1' }));
  delete process.env.GOAL_OUTCOME_CHECK_DISABLED;
  delete process.env.GOAL_OUTCOME_GATE_ENFORCE;
  delete process.env.GOAL_TRANSITION_METRICS_DISABLED;
});

describe('part 3 — the auto-complete cascade (seam auto)', () => {
  it('the last todo landing with the KPI below its bar: the close STANDS, the supervisor is woken ONCE, the record + metric land', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    await updateTodo({ userId: OWNER, todoId: 't-1', status: 'done', evidence: 'PR #42 merged', machineTriggered: true, actingChatId: LANE });
    expect(db.goals[0].status).toBe('done'); // observe-only by default
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    const wake = mockEnqueueDirectWake.mock.calls[0][0];
    expect(wake.targetChatId).toBe(SUP);
    expect(wake.prompt).toContain('[GOAL OUTCOME UNMET — RE-PLAN] goal "Qwen serving ≥10 tok/s on node-a" (g-226be7): all 1 todo done; kpi client_visible_e2e_tok_s=5.08 tok/s < bar 10 (receipt f5b42fe6, age 2h).');
    expect(wake.meta).toEqual(expect.objectContaining({ goalId: GOAL, trigger: 'goal_outcome_unmet', seam: 'auto' }));
    const rows = metrics('goal_outcome_unmet');
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual(expect.objectContaining({ goalId: 'g-226be7', seam: 'auto', reason: 'kpi_bar_unmet', outcome: 'woken', actorKind: 'harness', enforced: false, kpiValue: 5.08, bar: 10 }));
    expect(store.get(`${GOAL}:goal-outcome/close`)).toEqual(expect.objectContaining({ seam: 'auto', ownerAccepted: false, reasons: ['kpi_bar_unmet'] }));
    expect(auditCalls('goal.outcome_unmet')).toHaveLength(1);
    // The done-suspect row now carries the KPI reason too.
    expect(metrics('goal_done_suspect')[0].meta.reasons).toEqual(['kpi_bar_unmet']);
  });

  it('the 24 h NX dedupe (goal + KPI value + receipt): a second close on the SAME reading does not re-wake; a new reading does', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    await updateTodo({ userId: OWNER, todoId: 't-1', status: 'done', machineTriggered: true, actingChatId: LANE });
    // reopen via a new todo, close it again on the same KPI reading
    db.goals[0].status = 'active';
    db.todos.push(todoRow({ id: 't-2' }));
    await updateTodo({ userId: OWNER, todoId: 't-2', status: 'done', machineTriggered: true, actingChatId: LANE });
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    expect(metrics('goal_outcome_unmet').map((m) => m.meta.outcome)).toEqual(['woken', 'deduped']);
    // a NEW receipted reading (still below the bar) is new evidence
    db.goals[0].status = 'active';
    db.goals[0].premises = [{ ...KPI, value: 6.2, receiptId: 'aaaa1111-2222-4000-8000-000000000000' }];
    db.todos.push(todoRow({ id: 't-3' }));
    await updateTodo({ userId: OWNER, todoId: 't-3', status: 'done', machineTriggered: true, actingChatId: LANE });
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(2);
  });

  it('a met KPI / a goal without a bar closes exactly as before (no wake, no outcome row)', async () => {
    db.goals.push(goalRow({ premises: [{ ...KPI, value: 10.4 }] }));
    db.todos.push(todoRow());
    await updateTodo({ userId: OWNER, todoId: 't-1', status: 'done', machineTriggered: true, actingChatId: LANE });
    expect(db.goals[0].status).toBe('done');
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(metrics('goal_outcome_unmet')).toHaveLength(0);
  });

  it('no supervisor / supervisor switched OFF / enqueue failure: labelled, never thrown; a failed enqueue frees the dedupe window', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    db.chats = [];
    await updateTodo({ userId: OWNER, todoId: 't-1', status: 'done', machineTriggered: true, actingChatId: LANE });
    expect(metrics('goal_outcome_unmet')[0].meta.outcome).toBe('no_supervisor');

    jest.clearAllMocks();
    db.chats = [{ id: SUP, userId: OWNER, projectId: PROJECT_ID, isProjectSupervisor: true, archivedAt: null }];
    db.goals = [goalRow()]; db.todos = [todoRow()];
    mockSwitchOn.mockImplementation(async () => false);
    await updateTodo({ userId: OWNER, todoId: 't-1', status: 'done', machineTriggered: true, actingChatId: LANE });
    expect(metrics('goal_outcome_unmet')[0].meta.outcome).toBe('supervisor_off');

    jest.clearAllMocks();
    mockSwitchOn.mockImplementation(async () => true);
    db.goals = [goalRow()]; db.todos = [todoRow()];
    mockEnqueueDirectWake.mockImplementation(async () => ({ ok: false, error: 'target chat not found' }));
    await updateTodo({ userId: OWNER, todoId: 't-1', status: 'done', machineTriggered: true, actingChatId: LANE });
    expect(metrics('goal_outcome_unmet')[0].meta.outcome).toBe('enqueue_failed');
    expect([...redisKeys.keys()].filter((k) => k.startsWith('goal-outcome:wake:'))).toEqual([]);
  });
});

describe('part 3 — goal_update status:done (seam update)', () => {
  it('a MACHINE close by a lane wakes the supervisor; the supervisor closing it itself does not wake itself', async () => {
    db.goals.push(goalRow());
    const v = await updateGoal({ userId: OWNER, goalId: GOAL, status: 'done', actingChatId: LANE, machineTriggered: true });
    expect(v.status).toBe('done');
    expect(v.doneSuspect).toEqual(['kpi_bar_unmet']);
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    expect(metrics('goal_outcome_unmet')[0].meta).toEqual(expect.objectContaining({ seam: 'update', outcome: 'woken', actorKind: 'machine' }));

    jest.clearAllMocks();
    redisKeys.clear();
    db.goals = [goalRow()];
    await updateGoal({ userId: OWNER, goalId: GOAL, status: 'done', actingChatId: SUP, machineTriggered: true });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(metrics('goal_outcome_unmet')[0].meta.outcome).toBe('self');
  });

  it('the OWNER closing directly (a JWT REST write — ownerExplicit) accepts the outcome: no wake, ACCEPTED on the record', async () => {
    db.goals.push(goalRow());
    const v = await updateGoal({ userId: OWNER, goalId: GOAL, status: 'done', ownerExplicit: true });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(metrics('goal_outcome_unmet')[0].meta).toEqual(expect.objectContaining({ outcome: 'owner_close', actorKind: 'user', ownerAccepted: true }));
    expect(store.get(`${GOAL}:goal-outcome/close`)).toEqual(expect.objectContaining({ ownerAccepted: true }));
    expect(v.outcomeUnmetNote).toBeUndefined();
  });

  it('review fix: a lane on an agent-origin / owner-dispatch run (userTurnAt inherited ⇒ origin-aware MACHINE) wakes the supervisor and is never recorded as the owner', async () => {
    for (const ctx of [{ userTurnAt: new Date(), machineTriggered: true }, { userTurnAt: new Date(), ownerDispatch: true }]) {
      jest.clearAllMocks();
      redisKeys.clear();
      store.clear();
      db.goals = [goalRow()];
      const v = await updateGoal({ userId: OWNER, goalId: GOAL, status: 'done', actingChatId: LANE, machineTriggered: ledgerToolMachineTriggered(ctx) });
      expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
      expect(metrics('goal_outcome_unmet')[0].meta).toEqual(expect.objectContaining({ outcome: 'woken', actorKind: 'machine', ownerAccepted: false }));
      expect(store.get(`${GOAL}:goal-outcome/close`)).toEqual(expect.objectContaining({ ownerAccepted: false }));
      expect(v.outcomeUnmetNote).toContain('recorded as LIVE work');
      expect(v.outcomeUnmetNote).toContain('The project supervisor was woken to re-plan.');
    }
  });

  it('review fix: a model\'s OWN close on a genuine human turn (user actorKind) does not accept the outcome unless the owner\'s text names the close', async () => {
    db.goals.push(goalRow());
    await updateGoal({ userId: OWNER, goalId: GOAL, status: 'done', actingChatId: LANE, machineTriggered: false, ownerTurnText: 'how is the serving work going?' });
    expect(metrics('goal_outcome_unmet')[0].meta).toEqual(expect.objectContaining({ outcome: 'woken', actorKind: 'user', ownerAccepted: false }));
    expect(store.get(`${GOAL}:goal-outcome/close`).ownerAccepted).toBe(false);

    jest.clearAllMocks();
    redisKeys.clear();
    store.clear();
    db.goals = [goalRow()];
    await updateGoal({ userId: OWNER, goalId: GOAL, status: 'done', actingChatId: SUP, machineTriggered: false, ownerTurnText: 'Close the serving goal — 5 tok/s is fine for now.' });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(metrics('goal_outcome_unmet')[0].meta).toEqual(expect.objectContaining({ outcome: 'owner_close', ownerAccepted: true }));
    expect(store.get(`${GOAL}:goal-outcome/close`).ownerAccepted).toBe(true);
  });

  it('the supervisor\'s own close wakes nobody but its tool result says the project now stays live (review fix)', async () => {
    db.goals.push(goalRow());
    const v = await updateGoal({ userId: OWNER, goalId: GOAL, status: 'done', actingChatId: SUP, machineTriggered: true });
    expect(metrics('goal_outcome_unmet')[0].meta.outcome).toBe('self');
    expect(v.outcomeUnmetNote).toMatch(/^Outcome bar unmet \(kpi client_visible_e2e_tok_s=5\.08 tok\/s < bar 10/);
    expect(v.outcomeUnmetNote).not.toContain('woken');
  });

  it('re-confirming an ALREADY-done goal accepts the outcome only from the owner (status-only REST write, or the owner naming the close)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    await updateTodo({ userId: OWNER, todoId: 't-1', status: 'done', machineTriggered: true, actingChatId: LANE });
    expect(store.get(`${GOAL}:goal-outcome/close`).ownerAccepted).toBe(false);
    // a machine re-send changes nothing — and says so
    const machine = await updateGoal({ userId: OWNER, goalId: GOAL, status: 'done', actingChatId: SUP, machineTriggered: true, progressNote: 'closing with evidence' });
    expect(store.get(`${GOAL}:goal-outcome/close`).ownerAccepted).toBe(false);
    expect(machine.outcomeUnmetNote).toContain('the owner accepts the close');
    // a user-anchored model edit that merely re-sends status:'done' beside a note is not the owner
    await updateGoal({ userId: OWNER, goalId: GOAL, status: 'done', machineTriggered: false, progressNote: 'tidy', ownerTurnText: 'update the notes please' });
    expect(store.get(`${GOAL}:goal-outcome/close`).ownerAccepted).toBe(false);
    // a REST edit that re-sends status beside other fields is not a close either
    await updateGoal({ userId: OWNER, goalId: GOAL, status: 'done', title: 'Qwen serving ≥10 tok/s on node-a (v2)', ownerExplicit: true });
    expect(store.get(`${GOAL}:goal-outcome/close`).ownerAccepted).toBe(false);
    expect(auditCalls('goal.outcome_accepted')).toHaveLength(0);
    // a STATUS-ONLY REST re-confirm is
    await updateGoal({ userId: OWNER, goalId: GOAL, status: 'done', ownerExplicit: true });
    expect(store.get(`${GOAL}:goal-outcome/close`).ownerAccepted).toBe(true);
    expect(auditCalls('goal.outcome_accepted')).toHaveLength(1);
    expect(auditCalls('goal.outcome_accepted')[0].metadata).toEqual(expect.objectContaining({ via: 'rest' }));
  });

  it('re-confirming via the owner\'s own message naming the close accepts it', async () => {
    db.goals.push(goalRow({ status: 'done' }));
    store.set(`${GOAL}:goal-outcome/close`, { fingerprint: 'x', reasons: ['kpi_bar_unmet'], seam: 'auto', actorKind: 'harness', at: new Date().toISOString(), ownerAccepted: false });
    await updateGoal({ userId: OWNER, goalId: GOAL, status: 'done', machineTriggered: false, progressNote: 'accepted by owner', ownerTurnText: `Mark goal ${GOAL.slice(0, 8)} as done, accept the shortfall.` });
    expect(store.get(`${GOAL}:goal-outcome/close`).ownerAccepted).toBe(true);
  });

  it('a Redis SET that throws is labelled redis_error — never deduped — and nothing is woken', async () => {
    db.goals.push(goalRow());
    mockRedis.set.mockImplementationOnce(async () => { throw new Error('ECONNRESET'); });
    await updateGoal({ userId: OWNER, goalId: GOAL, status: 'done', actingChatId: LANE, machineTriggered: true });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(metrics('goal_outcome_unmet')[0].meta.outcome).toBe('redis_error');
  });
});

describe('part 4 — OPT-IN GOAL_OUTCOME_GATE_ENFORCE=1', () => {
  it('the cascade HOLDS the close: the goal stays open with an [outcome unmet] note leading its progress note; the supervisor is woken (enforced)', async () => {
    process.env.GOAL_OUTCOME_GATE_ENFORCE = '1';
    db.goals.push(goalRow({ progressNote: 'paged-KV adopted on node-a' }));
    db.todos.push(todoRow());
    await updateTodo({ userId: OWNER, todoId: 't-1', status: 'done', machineTriggered: true, actingChatId: LANE });
    expect(db.goals[0].status).toBe('active');
    expect(db.goals[0].progressNote.startsWith('[outcome unmet] all 1 todo done but kpi client_visible_e2e_tok_s=5.08 tok/s < bar 10')).toBe(true);
    expect(db.goals[0].progressNote.endsWith('\npaged-KV adopted on node-a')).toBe(true);
    expect(auditCalls('goal.auto_done_held')).toHaveLength(1);
    expect(auditCalls('goal.auto_done')).toHaveLength(0);
    expect(metrics('goal_done_suspect')).toHaveLength(0); // nothing closed
    expect(metrics('goal_outcome_unmet')[0].meta).toEqual(expect.objectContaining({ seam: 'auto', enforced: true, outcome: 'woken' }));
    expect(mockEnqueueDirectWake.mock.calls[0][0].prompt).toContain('kept the goal OPEN');
    // review fix: the harness note is not a HOLD — the held goal with nothing open reads as UNPLANNED, not "held per note"
    expect(holdTokenIn(progressNoteLead(db.goals[0].progressNote))).toBeNull();
    expect(isUnplannedGoal(db.goals[0], 0)).toBe(true);
  });

  it('an explicit goal_update status:done still closes (audited as the explicit close)', async () => {
    process.env.GOAL_OUTCOME_GATE_ENFORCE = '1';
    db.goals.push(goalRow());
    const v = await updateGoal({ userId: OWNER, goalId: GOAL, status: 'done', actingChatId: LANE, machineTriggered: true });
    expect(v.status).toBe('done');
    expect(auditCalls('goal.outcome_gate_explicit_close')).toHaveLength(1);
  });
});

describe('kill switch GOAL_OUTCOME_CHECK_DISABLED=1', () => {
  it('the pre-change close: no outcome wake / row / record, and enforcement cannot arm', async () => {
    process.env.GOAL_OUTCOME_CHECK_DISABLED = '1';
    process.env.GOAL_OUTCOME_GATE_ENFORCE = '1';
    db.goals.push(goalRow());
    db.todos.push(todoRow());
    await updateTodo({ userId: OWNER, todoId: 't-1', status: 'done', machineTriggered: true, actingChatId: LANE });
    expect(db.goals[0].status).toBe('done');
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(metrics('goal_outcome_unmet')).toHaveLength(0);
    expect(store.size).toBe(0);
    expect(metrics('goal_done_suspect')).toHaveLength(0); // no kpi_bar_unmet reason either
  });
});

describe('part 4 of GOAL-UNPLANNED — goal_transition / todo_transition rows', () => {
  it('one row per status write: the todo close (machine), the cascade close (harness), a todo create', async () => {
    db.goals.push(goalRow({ premises: [] }));
    db.todos.push(todoRow());
    await updateTodo({ userId: OWNER, todoId: 't-1', status: 'done', machineTriggered: true, actingChatId: LANE });
    const todoRows = metrics('todo_transition');
    expect(todoRows).toHaveLength(1);
    expect(todoRows[0].meta).toEqual({ from: 'in_progress', to: 'done', actorKind: 'machine', projectId: PROJECT_ID, goalId: GOAL, todoId: 't-1', ageH: 5 });
    const goalRows = metrics('goal_transition');
    expect(goalRows).toHaveLength(1);
    expect(goalRows[0].meta).toEqual({ from: 'active', to: 'done', actorKind: 'harness', projectId: PROJECT_ID, goalId: GOAL, ageH: 48 });

    mockPrisma.projectTodo.create.mockImplementationOnce(async ({ data }: any) => { const r = { status: 'pending', createdAt: new Date(), ...data }; db.todos.push(r); return r; });
    await createTodo({ userId: OWNER, goalId: GOAL, title: 'Next lever', actingChatId: SUP, machineTriggered: true });
    // the create under a DONE goal reopens it (harness) — both rows land
    expect(metrics('todo_transition').slice(-1)[0].meta).toEqual(expect.objectContaining({ from: null, to: 'pending', actorKind: 'machine', goalId: GOAL }));
    expect(metrics('goal_transition').slice(-1)[0].meta).toEqual(expect.objectContaining({ from: 'done', to: 'active', actorKind: 'harness' }));
  });

  it('a user-anchored goal_update records actorKind user; no row when the status does not change; the kill switch stops every row', async () => {
    db.goals.push(goalRow({ premises: [] }));
    await updateGoal({ userId: OWNER, goalId: GOAL, status: 'blocked', blockedReason: 'waiting on node-a' });
    expect(metrics('goal_transition')[0].meta).toEqual(expect.objectContaining({ from: 'active', to: 'blocked', actorKind: 'user' }));
    await updateGoal({ userId: OWNER, goalId: GOAL, progressNote: 'still waiting' });
    expect(metrics('goal_transition')).toHaveLength(1);
    process.env.GOAL_TRANSITION_METRICS_DISABLED = '1';
    await updateGoal({ userId: OWNER, goalId: GOAL, status: 'active' });
    expect(metrics('goal_transition')).toHaveLength(1);
  });

  it('rowAgeHours: one decimal, null on an unreadable stamp', () => {
    expect(rowAgeHours(new Date(1_000_000 - 90 * 60_000), 1_000_000)).toBe(1.5);
    expect(rowAgeHours('nope')).toBeNull();
  });
});

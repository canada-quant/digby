/**
 * A lane whose CHARTER TODO is closed stops naming that todo as its goal half
 * once the lane has MOVED ON past it (2026-10-21, probe JWT1021 / ec2-ops run
 * 39670445611).
 *
 * REPLAY: lane 5f90c628 (project crossmodel, the Framework Operator's working
 * lane, fired every 4 h by an owner-armed recurring schedule) carried
 * "5. Close the JWT pending-IP watch · 5-line FS delta + final recap" for 5½
 * days after its charter todo 36fe141e went DONE (2026-10-16T04:06Z). Its
 * charter goal b3f240e4 "Constant framework R&D — …" is ACTIVE and no
 * in-progress todo is assigned to it, so the T8-13 todo-first branch kept
 * returning the closed todo's title on every render (bindCharter only rebinds a
 * done charter todo when a NEW todo is assigned — never, on a standing lane).
 * Every report-up the lane sent the Fleet Supervisor was headed with a closed
 * watch named as current work.
 *
 * FIX: newest in-progress assigned todo → the charter todo while it is NOT
 * terminal (done / dropped) → for a TERMINAL charter todo: the charter goal
 * when the lane has moved on (a run of the lane began after the todo closed,
 * or its title already leads with that goal), else the closed todo — it stays
 * the RECORD of what a finished one-shot lane did, so T8-13's sibling lanes
 * under one goal stay distinct at finalize and archive. The goal follows the
 * todo's own goal when the charter goal is unset / gone / closed (bindCharter's
 * rebind rule). No goal at all → the closed todo; a read failure → sticky.
 * HARNESS_TITLE_DONE_TODO_SKIP_DISABLED=1 restores today's output.
 */
const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn(), update: jest.fn() },
  chatCodingState: { findUnique: jest.fn(), update: jest.fn(async () => ({})) },
  projectGoal: { findUnique: jest.fn() },
  projectTodo: { findUnique: jest.fn(), findFirst: jest.fn() },
  agentRun: { findFirst: jest.fn(), findUnique: jest.fn() },
};
const mockRecordLoopMetric = jest.fn();
const mockGetPlan = jest.fn((..._a: any[]): Promise<any> => Promise.resolve(null));
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a), LOOP_METRIC_KINDS: { TITLE_RENDER: 'title_render' } }));
jest.mock('../coding/plan.service', () => ({ __esModule: true, getPlan: (...a: any[]) => mockGetPlan(...a) }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import {
  refreshSessionTitle, resolveGoalHalf, resolveGoalHalfWithSource, splitSessionTitle, isTerminalTodoStatus,
  titleDoneTodoSkipDisabled, _resetTitleRateLimitForTests,
} from './session-titles';

const LANE = '5f90c628-0000-4000-8000-000000000000';
const TODO_ID = '36fe141e-0000-4000-8000-000000000000';
const GOAL_ID = 'b3f240e4-0000-4000-8000-000000000000';
const TODO_TITLE = '5. Close the JWT pending-IP watch: confirm the pending-IP rows drain and retire the watch …';
const GOAL_TITLE = 'Constant framework R&D — hunt shortfalls, research newer approaches, test architecture improvements';
const STALE_TITLE = '5. Close the JWT pending-IP watch · 5-line FS delta + final recap';
const STEP = '5-line FS delta + final recap';
const GOAL_HALF = 'Constant framework R&D — hunt shortfalls';
const TODO_HALF = '5. Close the JWT pending-IP watch';
const CLOSED_AT = new Date('2026-10-16T04:06:00Z');
const H = 3600_000;

type Run = { id: string; sessionId: string; createdAt: Date; startedAt: Date | null };
let chats: Record<string, any>;
let todos: Record<string, any>;
let goals: Record<string, any>;
let runs: Run[];
let working: Record<string, any>; // chatId → the in_progress todo assigned to it

/** Evaluates the moved-on query's where clause the way Postgres would. */
function matchesRunWhere(r: Run, where: any): boolean {
  if (where?.sessionId && r.sessionId !== where.sessionId) return false;
  if (where?.id?.not && r.id === where.id.not) return false;
  const gt = (d: Date | null, bound: any) => !!d && !!bound?.gt && d.getTime() > new Date(bound.gt).getTime();
  if (Array.isArray(where?.OR)) {
    return where.OR.some((c: any) => (c.createdAt ? gt(r.createdAt, c.createdAt) : false) || (c.startedAt ? gt(r.startedAt, c.startedAt) : false));
  }
  if (where?.createdAt) return gt(r.createdAt, where.createdAt);
  return true;
}

function lane(id: string, over: Record<string, any> = {}): any {
  return { id, title: 'x', titlePinned: false, titleStep: null, charterGoalId: GOAL_ID, charterTodoId: null, isSupervisor: false, isProjectSupervisor: false, archivedAt: null, projectId: 'crossmodel', ...over };
}
/** The lane's firings every 4 h from `from` (inclusive) for `n` runs. */
function firings(sessionId: string, from: Date, n: number): Run[] {
  return Array.from({ length: n }, (_, i) => {
    const at = new Date(from.getTime() + i * 4 * H);
    return { id: `${sessionId.slice(0, 8)}-run-${i}`, sessionId, createdAt: at, startedAt: new Date(at.getTime() + 2_000) };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetTitleRateLimitForTests();
  for (const k of ['HARNESS_TITLE_TODO_HALF_DISABLED', 'HARNESS_TITLE_DONE_TODO_SKIP_DISABLED', 'HARNESS_TITLE_STICKY_GOAL_DISABLED', 'HARNESS_TITLE_WORD_CLIP_DISABLED']) delete process.env[k];
  chats = { [LANE]: lane(LANE, { title: STALE_TITLE, titleStep: STEP, charterTodoId: TODO_ID }) };
  todos = { [TODO_ID]: { id: TODO_ID, title: TODO_TITLE, status: 'done', goalId: GOAL_ID, updatedAt: CLOSED_AT } };
  goals = { [GOAL_ID]: { id: GOAL_ID, title: GOAL_TITLE, status: 'active' } };
  // the closing run (created before the close), then the owner-armed 4 h firings for 5½ days
  runs = [
    { id: 'closing-run', sessionId: LANE, createdAt: new Date(CLOSED_AT.getTime() - 20 * 60_000), startedAt: new Date(CLOSED_AT.getTime() - 19 * 60_000) },
    ...firings(LANE, new Date(CLOSED_AT.getTime() + 4 * H), 33),
  ];
  working = {}; // no in_progress todo is assigned to the lane (both of its assigned todos are done)
  mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) => (chats[where.id] ? { ...chats[where.id] } : null));
  mockPrisma.crossModelChat.update.mockImplementation(async ({ where, data }: any) => { Object.assign(chats[where.id], data); return { ...chats[where.id] }; });
  mockPrisma.chatCodingState.findUnique.mockResolvedValue({ titleSource: 'harness' });
  mockPrisma.projectTodo.findFirst.mockImplementation(async ({ where }: any) => working[where.assigneeChatId] ?? null);
  mockPrisma.projectTodo.findUnique.mockImplementation(async ({ where }: any) => (todos[where.id] ? { ...todos[where.id] } : null));
  mockPrisma.projectGoal.findUnique.mockImplementation(async ({ where }: any) => (goals[where.id] ? { ...goals[where.id] } : null));
  mockPrisma.agentRun.findFirst.mockImplementation(async ({ where, orderBy }: any) => {
    const hits = runs.filter((r) => matchesRunWhere(r, where));
    if (orderBy?.createdAt === 'desc') hits.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return hits[0] ? { ...hits[0], status: 'completed', finishedAt: null } : null;
  });
  mockPrisma.agentRun.findUnique.mockImplementation(async ({ where }: any) => { const r = runs.find((x) => x.id === where.id); return r ? { ...r } : null; });
  mockGetPlan.mockResolvedValue({ steps: [{ id: 3, text: STEP, status: 'in_progress' }] });
});

async function render(chatId = LANE, reason: 'plan' | 'finalize' | 'archive' = 'finalize'): Promise<string> {
  _resetTitleRateLimitForTests();
  await refreshSessionTitle(chatId, reason, reason === 'archive' ? { force: true } : {});
  return chats[chatId].title;
}
const row = () => chats[LANE];

describe('REPLAY 5f90c628 — a DONE charter todo, an ACTIVE charter goal, 33 firings since the close', () => {
  it('pre-fix (HARNESS_TITLE_DONE_TODO_SKIP_DISABLED=1): the closed todo stays the goal half — today\'s title byte-for-byte', async () => {
    process.env.HARNESS_TITLE_DONE_TODO_SKIP_DISABLED = '1';
    expect(titleDoneTodoSkipDisabled()).toBe(true);
    const r = await refreshSessionTitle(LANE, 'finalize');
    expect(r).toEqual({ changed: false, title: STALE_TITLE });
    expect(row().title).toBe(STALE_TITLE);
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    // the status-blind order never asks whether the lane moved on
    expect(mockPrisma.agentRun.findFirst).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: expect.anything() }) }));
  });

  it('FIX: the charter goal names the lane; the step half is untouched; the charter record is not touched', async () => {
    expect(titleDoneTodoSkipDisabled()).toBe(false);
    const r = await refreshSessionTitle(LANE, 'finalize');
    expect(r).toEqual({ changed: true, title: `${GOAL_HALF} · ${STEP}` });
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({ where: { id: LANE }, data: { title: `${GOAL_HALF} · ${STEP}`, titleStep: STEP } });
    expect(mockPrisma.agentRun.findFirst).toHaveBeenCalledWith({
      where: { sessionId: LANE, OR: [{ createdAt: { gt: CLOSED_AT } }, { startedAt: { gt: CLOSED_AT } }] }, select: { id: true },
    });
    expect(row()).toMatchObject({ charterTodoId: TODO_ID, charterGoalId: GOAL_ID });
  });

  it('a MACHINE close (doneRunId = the lane\'s closing run): a later write to the closed todo never flips the lane back', async () => {
    todos[TODO_ID].doneRunId = 'closing-run';
    for (let i = 0; i < 6; i++) expect(splitSessionTitle(await render(LANE, i % 2 ? 'plan' : 'finalize')).goal).toBe(GOAL_HALF);
    // a supervisor writes a progress note onto the DONE todo AFTER the lane's newest run (updatedAt moves past every run):
    todos[TODO_ID].updatedAt = new Date(runs[runs.length - 1].createdAt.getTime() + 60_000);
    mockPrisma.agentRun.findFirst.mockClear();
    expect(splitSessionTitle(await render(LANE, 'plan')).goal).toBe(GOAL_HALF);
    // anchored on the closing run, never on the todo's moving updatedAt
    expect(mockPrisma.agentRun.findFirst).toHaveBeenCalledWith({
      where: { sessionId: LANE, id: { not: 'closing-run' }, createdAt: { gt: runs[0].createdAt } }, select: { id: true },
    });
  });

  it('a HUMAN close (no doneRunId) anchors on updatedAt: a later write shows the closed todo until the lane runs again', async () => {
    expect(splitSessionTitle(await render()).goal).toBe(GOAL_HALF);
    todos[TODO_ID].updatedAt = new Date(runs[runs.length - 1].createdAt.getTime() + 60_000);
    expect(splitSessionTitle(await render(LANE, 'plan')).goal).toBe(TODO_HALF);
    runs.push({ id: 'next-firing', sessionId: LANE, createdAt: new Date(todos[TODO_ID].updatedAt.getTime() + 4 * H), startedAt: null });
    expect(splitSessionTitle(await render(LANE, 'plan')).goal).toBe(GOAL_HALF);
  });

  it('a todo ANOTHER lane closed never counts as this lane\'s close — a verify lane spawned on it keeps the todo as its subject', async () => {
    runs.unshift({ id: 'other-lane-close', sessionId: 'otherlane-0000', createdAt: new Date(CLOSED_AT.getTime() - 60_000), startedAt: null });
    todos[TODO_ID].doneRunId = 'other-lane-close';
    expect(splitSessionTitle(await render()).goal).toBe(TODO_HALF);
  });

  it('a swept closing run falls back to the todo\'s own clock', async () => {
    todos[TODO_ID].doneRunId = 'swept-run';
    expect(splitSessionTitle(await render()).goal).toBe(GOAL_HALF);
    runs = [runs[0]]; // only the run before the close survives
    expect(splitSessionTitle(await render()).goal).toBe(TODO_HALF);
  });

  it('a one-off todo-store failure on a FINISHED one-shot lane is never a permanent rename (no ratchet on the current title)', async () => {
    runs = [runs[0]]; // the lane closed its todo and never ran again
    todos[TODO_ID].doneRunId = 'closing-run';
    expect(splitSessionTitle(await render()).goal).toBe(TODO_HALF);
    mockPrisma.projectTodo.findFirst.mockRejectedValueOnce(new Error('db blip')); // todo-first read throws once → goal-first
    expect(splitSessionTitle(await render()).goal).toBe(GOAL_HALF);
    expect(splitSessionTitle(await render()).goal).toBe(TODO_HALF); // the next clean render restores the record
  });

  it('a transient goal-read or run-read failure keeps the current half — it never resurrects the closed todo', async () => {
    await render();
    expect(splitSessionTitle(row().title).goal).toBe(GOAL_HALF);
    mockPrisma.projectGoal.findUnique.mockRejectedValue(new Error('db blip'));
    expect(await resolveGoalHalfWithSource(row(), 'harness')).toEqual({ goal: GOAL_HALF, sticky: true });
    expect(splitSessionTitle(await render()).goal).toBe(GOAL_HALF);
    // a run-read failure before the lane was ever re-rendered keeps today's (todo) half — never a guess
    mockPrisma.projectGoal.findUnique.mockImplementation(async ({ where }: any) => goals[where.id] ?? null);
    chats[LANE].title = STALE_TITLE;
    mockPrisma.agentRun.findFirst.mockRejectedValue(new Error('db blip'));
    expect(await resolveGoalHalfWithSource(row(), 'harness')).toEqual({ goal: TODO_HALF, sticky: true });
  });

  it('a run QUEUED before the close that STARTED after it counts as moving on', async () => {
    runs = [{ id: 'q', sessionId: LANE, createdAt: new Date(CLOSED_AT.getTime() - 60_000), startedAt: new Date(CLOSED_AT.getTime() + 30 * 60_000) }];
    expect(await resolveGoalHalf(row(), 'harness')).toBe(GOAL_HALF);
  });
});

describe('T8-13 stays fixed: FINISHED one-shot lanes under one goal keep their own (closed) todo as their subject', () => {
  const SIB_GOAL = 'sib-goal-0000-4000-8000-000000000000';
  const A = 'laneA000-0000-4000-8000-000000000000';
  const B = 'laneB000-0000-4000-8000-000000000000';
  beforeEach(() => {
    goals[SIB_GOAL] = { id: SIB_GOAL, title: 'Gap-fill: bijural terminology, FR point-in-time, FR/EN pairs for the corpus', status: 'active' };
    todos.t1 = { id: 't1', title: 'Bijural terminology pairs for the Civil Code', status: 'in_progress', goalId: SIB_GOAL, updatedAt: new Date('2026-10-20T10:00:00Z') };
    todos.t2 = { id: 't2', title: 'FR point-in-time for the Criminal Code', status: 'in_progress', goalId: SIB_GOAL, updatedAt: new Date('2026-10-20T10:00:00Z') };
    chats[A] = lane(A, { title: 'Bijural terminology pairs for the Civil · PR #712 merged', titleStep: 'PR #712 merged', charterGoalId: SIB_GOAL, charterTodoId: 't1' });
    chats[B] = lane(B, { title: 'FR point-in-time for the Criminal Code · PR #712 merged', titleStep: 'PR #712 merged', charterGoalId: SIB_GOAL, charterTodoId: 't2' });
    // each lane's ONE run started before it closed its own todo
    runs = [
      { id: 'ra', sessionId: A, createdAt: new Date('2026-10-20T09:00:00Z'), startedAt: new Date('2026-10-20T09:00:02Z') },
      { id: 'rb', sessionId: B, createdAt: new Date('2026-10-20T09:00:00Z'), startedAt: new Date('2026-10-20T09:00:02Z') },
    ];
    mockGetPlan.mockResolvedValue(null);
  });
  const closeBoth = () => {
    for (const t of ['t1', 't2']) Object.assign(todos[t], { status: 'done', updatedAt: new Date('2026-10-20T11:00:00Z') });
  };

  it('done todos, no later run: finalize and the forced archive render keep the two titles DISTINCT (fix ON and OFF alike)', async () => {
    for (const off of [false, true]) {
      if (off) process.env.HARNESS_TITLE_DONE_TODO_SKIP_DISABLED = '1';
      todos.t1.status = 'in_progress'; todos.t2.status = 'in_progress';
      const live = [await render(A), await render(B)];
      closeBoth();
      const fin = [await render(A), await render(B)];
      chats[A].archivedAt = new Date('2026-10-20T12:00:00Z'); chats[B].archivedAt = new Date('2026-10-20T12:00:00Z');
      const arch = [await render(A, 'archive'), await render(B, 'archive')];
      for (const pair of [live, fin, arch]) expect(new Set(pair.map((t) => splitSessionTitle(t).goal)).size).toBe(2);
      expect(arch.map((t) => splitSessionTitle(t).goal)).toEqual(['Bijural terminology pairs for the Civil', 'FR point-in-time for the Criminal Code']);
      expect(arch.every((t) => t.endsWith(' · archived'))).toBe(true);
      chats[A].archivedAt = null; chats[B].archivedAt = null;
    }
  });

  it('a finished lane that gets a NEW run after its todo closed has moved on — the goal names it', async () => {
    closeBoth();
    runs.push({ id: 'ra2', sessionId: A, createdAt: new Date('2026-10-20T15:00:00Z'), startedAt: new Date('2026-10-20T15:00:02Z') });
    expect(splitSessionTitle(await render(A)).goal).toBe('Gap-fill: bijural terminology, FR point-in-time, FR/EN');
    expect(splitSessionTitle(await render(B)).goal).toBe('FR point-in-time for the Criminal Code');
  });
});

describe('the resolution order', () => {
  it('a NON-terminal charter todo still wins over the goal (pending / blocked / in_progress / no status)', async () => {
    for (const status of ['pending', 'blocked', 'in_progress', undefined]) {
      todos[TODO_ID] = { ...todos[TODO_ID], status };
      expect(await resolveGoalHalf(row(), 'harness')).toBe(TODO_HALF);
    }
    expect(mockPrisma.agentRun.findFirst).not.toHaveBeenCalled();
  });

  it('an in-progress todo assigned to the lane still wins — over a done charter todo too', async () => {
    working[LANE] = { title: 'Retire the stale lane-title charter halves' };
    expect(await resolveGoalHalf(row(), 'harness')).toBe('Retire the stale lane-title charter halves');
    expect(mockPrisma.projectTodo.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { assigneeChatId: LANE, status: 'in_progress' } }));
  });

  it('dropped is terminal like done', async () => {
    todos[TODO_ID].status = 'dropped';
    expect(await resolveGoalHalf(row(), 'harness')).toBe(GOAL_HALF);
  });

  it('a FINISHED goal with a finished todo (lane moved on) → the goal title', async () => {
    for (const status of ['done', 'archived']) {
      goals[GOAL_ID].status = status;
      expect(await resolveGoalHalf(row(), 'harness')).toBe(GOAL_HALF);
    }
  });

  it('no goal anywhere + a terminal todo → the todo title (last ledger resort), even when the lane moved on', async () => {
    todos[TODO_ID].goalId = null;
    expect(await resolveGoalHalfWithSource({ ...row(), charterGoalId: null }, 'harness')).toEqual({ goal: TODO_HALF, sticky: false });
    delete goals[GOAL_ID]; // a charter goal whose row is gone (and the todo names it too)
    todos[TODO_ID].goalId = GOAL_ID;
    expect(await resolveGoalHalfWithSource(row(), 'harness')).toEqual({ goal: TODO_HALF, sticky: false });
  });

  it('no goal + no todo row → null ledger ⇒ the sticky current half', async () => {
    delete goals[GOAL_ID];
    delete todos[TODO_ID];
    expect(await resolveGoalHalfWithSource(row(), 'harness')).toEqual({ goal: TODO_HALF, sticky: true });
  });

  it('the charter todo is read at most once per resolution', async () => {
    await resolveGoalHalf(row(), 'harness');
    delete goals[GOAL_ID];
    await resolveGoalHalf(row(), 'harness');
    expect(mockPrisma.projectTodo.findUnique).toHaveBeenCalledTimes(2);
  });

  it('isTerminalTodoStatus: done / dropped only (goals.service TODO_STATUSES vocabulary)', () => {
    expect(['pending', 'in_progress', 'blocked', 'done', 'dropped', '', null, undefined].map((s) => isTerminalTodoStatus(s as any))).toEqual([false, false, false, true, true, false, false, false]);
  });
});

describe('which goal a closed charter todo defers to — bindCharter\'s rebind rule', () => {
  const OWN = 'own-goal-0000-4000-8000-000000000000';
  beforeEach(() => { goals[OWN] = { id: OWN, title: 'Harden the lane-title derivation for standing lanes', status: 'active' }; todos[TODO_ID].goalId = OWN; });

  it('no charter goal → the todo\'s OWN goal', async () => {
    expect(await resolveGoalHalf({ ...row(), charterGoalId: null }, 'harness')).toBe('Harden the lane-title derivation for standing');
  });
  it('a charter goal that is gone or closed → the todo\'s OWN goal', async () => {
    goals[GOAL_ID].status = 'done';
    expect(await resolveGoalHalf(row(), 'harness')).toBe('Harden the lane-title derivation for standing');
    delete goals[GOAL_ID];
    expect(await resolveGoalHalf(row(), 'harness')).toBe('Harden the lane-title derivation for standing');
  });
  it('an ACTIVE charter goal stays the charter (the rebind kept it on purpose)', async () => {
    expect(await resolveGoalHalf(row(), 'harness')).toBe(GOAL_HALF);
  });
});

describe('HARNESS_TITLE_TODO_HALF_DISABLED=1 (goal-first) stays coherent with the terminal-todo rule', () => {
  beforeEach(() => { process.env.HARNESS_TITLE_TODO_HALF_DISABLED = '1'; });

  it('the goal leads; no goal + a terminal todo → the todo title', async () => {
    expect(await resolveGoalHalf(row(), 'harness')).toBe(GOAL_HALF);
    expect(mockPrisma.projectTodo.findFirst).not.toHaveBeenCalled();
    expect(await resolveGoalHalf({ ...row(), charterGoalId: null }, 'harness')).toBe(TODO_HALF);
  });

  it('a transient goal-read failure never resurrects a terminal todo (sticky); a live todo still answers', async () => {
    chats[LANE].title = `${GOAL_HALF} · ${STEP}`;
    mockPrisma.projectGoal.findUnique.mockRejectedValue(new Error('db blip'));
    expect(await resolveGoalHalfWithSource(row(), 'harness')).toEqual({ goal: GOAL_HALF, sticky: true });
    todos[TODO_ID].status = 'pending';
    expect(await resolveGoalHalfWithSource(row(), 'harness')).toEqual({ goal: TODO_HALF, sticky: false });
  });
});

describe('HARNESS_TITLE_DONE_TODO_SKIP_DISABLED=1 restores today\'s resolution', () => {
  beforeEach(() => { process.env.HARNESS_TITLE_DONE_TODO_SKIP_DISABLED = '1'; });

  it('the closed charter todo leads again — even on a goal-led title; a goal-read failure falls through to it', async () => {
    chats[LANE].title = `${GOAL_HALF} · ${STEP}`;
    expect(await resolveGoalHalf(row(), 'harness')).toBe(TODO_HALF);
    mockPrisma.projectGoal.findUnique.mockRejectedValue(new Error('db blip'));
    expect(await resolveGoalHalfWithSource(row(), 'harness')).toEqual({ goal: TODO_HALF, sticky: false });
    process.env.HARNESS_TITLE_TODO_HALF_DISABLED = '1';
    expect(await resolveGoalHalfWithSource(row(), 'harness')).toEqual({ goal: TODO_HALF, sticky: false });
  });

  it('no charter goal: the todo\'s own goal is never consulted', async () => {
    todos[TODO_ID].goalId = 'own-goal';
    goals['own-goal'] = { id: 'own-goal', title: 'Some other goal', status: 'active' };
    expect(await resolveGoalHalf({ ...row(), charterGoalId: null }, 'harness')).toBe(TODO_HALF);
  });
});

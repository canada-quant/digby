/**
 * ALLCOMPLETE-CHARTER-TERMINATION (2026-10-20) — coding/allcomplete-charter.ts:
 * the fire-time decision for a recurring firing on an all-complete board that
 * did not change since the last firing (charter done ⇒ would_retire / retire,
 * charter open ⇒ [RE-PLAN FROM CHARTER], no charter + empty ledger ⇒ idle skip
 * with a stretched next firing, 1 in 10 control). Prisma / Redis / hooks mocked.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn() },
  projectTodo: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  todoDependency: { findMany: jest.fn() },
  projectGoal: { findUnique: jest.fn(), count: jest.fn() },
  chatSchedule: { findUnique: jest.fn() },
  watchedResource: { count: jest.fn() },
  agentRun: { count: jest.fn() },
  hookEvent: { count: jest.fn() },
  $queryRawUnsafe: jest.fn(),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
const mockRedisSet = jest.fn();
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { set: (...a: any[]) => mockRedisSet(...a) } }));
const mockEmit = jest.fn();
jest.mock('../platform/hooks.service', () => ({ __esModule: true, emitHookEventSafe: (...a: any[]) => mockEmit(...a) }));

import {
  classifyCharter, allCompleteIdleDelayMs, isOwnerScheduleRow, rePlanFromCharterNotice, drawAllCompleteControl,
  decideAllCompleteFiring, laneLedgerQuietSince, noticeAllCompleteIdleSkipOnce, setAllCompleteControlSampler,
  RE_PLAN_FROM_CHARTER_MARKER, ALL_COMPLETE_IDLE_MAX_DELAY_MS, scheduleAllCompleteIdleSkipDisabled,
} from './allcomplete-charter';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const H = 3_600_000;
const input = (over: any = {}) => ({
  scheduleId: 'sch-1', sessionId: 'lane-1', promptSetBy: 'machine', ownerSubscribed: null,
  lastFiredAt: new Date(NOW.getTime() - H), intervalSec: 1800, steps: 4, now: NOW, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SCHEDULE_ALLCOMPLETE_IDLE_SKIP_DISABLED;
  delete process.env.SCHEDULE_CHARTER_TERMINATION_ENFORCE;
  setAllCompleteControlSampler(() => 0.99); // never the control unless a test says so
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: 'lane-1', projectId: 'p1', charterGoalId: null, charterTodoId: null, isSupervisor: false, isProjectSupervisor: false });
  mockPrisma.projectTodo.findUnique.mockResolvedValue(null);
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  mockPrisma.todoDependency.findMany.mockResolvedValue([]);
  mockPrisma.projectTodo.count.mockResolvedValue(0);
  mockPrisma.projectGoal.findUnique.mockResolvedValue(null);
  mockPrisma.projectGoal.count.mockResolvedValue(0);
  mockPrisma.chatSchedule.findUnique.mockResolvedValue({ deltaGate: null, requiredProbes: null });
  mockPrisma.watchedResource.count.mockResolvedValue(0);
  mockPrisma.agentRun.count.mockResolvedValue(0);
  mockPrisma.hookEvent.count.mockResolvedValue(0);
  mockPrisma.$queryRawUnsafe.mockResolvedValue([{ n: 0 }]);
  mockRedisSet.mockResolvedValue('OK');
});
afterAll(() => setAllCompleteControlSampler(null));

describe('pure', () => {
  it('classifyCharter: none / open / waiting / done, a reassigned charter todo is not this lane\'s work, a deleted charter is finished', () => {
    const L = 'lane-1';
    const mine = (over: any = {}) => ({ id: 'n', title: 'next', status: 'pending', assigneeChatId: L, openDeps: 0, ...over });
    expect(classifyCharter({ laneChatId: L, openTodos: [] })).toEqual({ state: 'none' });
    expect(classifyCharter({ laneChatId: L, charterTodoId: 't', todo: { status: 'in_progress', assigneeChatId: L }, openTodos: [] })).toMatchObject({ state: 'open', why: 'charter_todo_in_progress' });
    expect(classifyCharter({ laneChatId: L, charterTodoId: 't', todo: { status: 'done', assigneeChatId: L }, goal: { status: 'active' }, openTodos: [] })).toEqual({ state: 'done', why: 'charter_todo_done' });
    expect(classifyCharter({ laneChatId: L, charterTodoId: 't', todo: { status: 'done', assigneeChatId: L }, goal: { status: 'active' }, openTodos: [mine()] })).toMatchObject({ state: 'open', why: 'charter_goal_has_open_todos' });
    expect(classifyCharter({ laneChatId: L, charterTodoId: 't', todo: { status: 'done', assigneeChatId: L }, goal: { status: 'done' }, openTodos: [mine()] })).toMatchObject({ state: 'done' });
    expect(classifyCharter({ laneChatId: L, charterTodoId: 't', todo: { status: 'in_progress', assigneeChatId: 'lane-2' }, goal: { status: 'active' }, openTodos: [] })).toEqual({ state: 'done', why: 'charter_todo_reassigned' });
    expect(classifyCharter({ laneChatId: L, charterTodoId: 't', todo: null, openTodos: [] })).toEqual({ state: 'done', why: 'charter_todo_missing' });
    expect(classifyCharter({ laneChatId: L, charterGoalId: 'g', goal: { status: 'archived' }, openTodos: [] })).toEqual({ state: 'done', why: 'charter_goal_archived' });
    expect(classifyCharter({ laneChatId: L, charterGoalId: 'g', goal: null, openTodos: [] })).toEqual({ state: 'done', why: 'charter_goal_missing' });
    expect(classifyCharter({ laneChatId: L, charterGoalId: 'g', goal: { status: 'active' }, openTodos: [mine({ status: 'in_progress' })] })).toMatchObject({ state: 'open', why: 'charter_goal_active' });
  });

  it('review fix: only ACTIONABLE todos assigned to this lane make a charter OPEN — blocked / dependency-waiting / unassigned work is WAITING (plain advisory, never "execute", never retired)', () => {
    const L = 'lane-1';
    const mine = (over: any = {}) => ({ id: 'n', title: 'next', status: 'pending', assigneeChatId: L, openDeps: 0, ...over });
    // A charter todo blocked on an owner gate (the 7d7268fb phantom shape): waiting, not open.
    expect(classifyCharter({ laneChatId: L, charterTodoId: 't', todo: { status: 'blocked', assigneeChatId: L }, goal: { status: 'active' }, openTodos: [] }))
      .toEqual({ state: 'waiting', why: 'charter_todo_blocked', waitingTodos: [expect.objectContaining({ id: 't', status: 'blocked' })] });
    // A pending charter todo waiting on an open dependency: waiting.
    expect(classifyCharter({ laneChatId: L, charterTodoId: 't', todo: { status: 'pending', assigneeChatId: L, openDeps: 1 }, goal: { status: 'active' }, openTodos: [] }))
      .toMatchObject({ state: 'waiting', why: 'charter_todo_pending_deps' });
    // An unassigned charter todo is the supervisor's move: waiting, never done, never "pull it".
    expect(classifyCharter({ laneChatId: L, charterTodoId: 't', todo: { status: 'pending', assigneeChatId: null }, goal: { status: 'active' }, openTodos: [] }))
      .toMatchObject({ state: 'waiting', why: 'charter_todo_unassigned' });
    // Charter todo done; the lane's remaining goal work is all blocked / dependency-waiting: waiting.
    expect(classifyCharter({ laneChatId: L, charterTodoId: 't', todo: { status: 'done', assigneeChatId: L }, goal: { status: 'active' }, openTodos: [mine({ status: 'blocked' }), mine({ id: 'm', openDeps: 2 })] }))
      .toMatchObject({ state: 'waiting', why: 'charter_goal_todos_waiting' });
    // Charter todo blocked but another assigned goal todo is actionable: open, listing ONLY the actionable one.
    const v = classifyCharter({ laneChatId: L, charterTodoId: 't', todo: { status: 'blocked', assigneeChatId: L }, goal: { status: 'active' }, openTodos: [mine({ id: 'ok', status: 'in_progress' }), mine({ id: 'blk', status: 'blocked' })] });
    expect(v).toMatchObject({ state: 'open', why: 'charter_goal_has_open_todos' });
    expect((v as any).openTodos.map((t: any) => t.id)).toEqual(['ok']);
    // An UNASSIGNED goal todo never counts for the lane (the supervisor dispatches it).
    expect(classifyCharter({ laneChatId: L, charterTodoId: 't', todo: { status: 'done', assigneeChatId: L }, goal: { status: 'active' }, openTodos: [mine({ assigneeChatId: null })] }))
      .toEqual({ state: 'done', why: 'charter_todo_done' });
    expect(classifyCharter({ laneChatId: L, charterGoalId: 'g', goal: { status: 'active' }, openTodos: [mine({ assigneeChatId: null })] }))
      .toMatchObject({ state: 'waiting', why: 'charter_goal_nothing_assigned' });
  });

  it('allCompleteIdleDelayMs: 2 × time since the last REAL firing, floored at the interval, capped at 24 h', () => {
    expect(allCompleteIdleDelayMs({ now: NOW, lastFiredAt: new Date(NOW.getTime() - 30 * 60_000), intervalSec: 1800 })).toBe(H);
    expect(allCompleteIdleDelayMs({ now: NOW, lastFiredAt: new Date(NOW.getTime() - 5 * 60_000), intervalSec: 1800 })).toBe(30 * 60_000);
    expect(allCompleteIdleDelayMs({ now: NOW, lastFiredAt: new Date(NOW.getTime() - 20 * H), intervalSec: 1800 })).toBe(ALL_COMPLETE_IDLE_MAX_DELAY_MS);
    expect(allCompleteIdleDelayMs({ now: NOW, lastFiredAt: null, intervalSec: 3600 })).toBe(H);
    expect(allCompleteIdleDelayMs({ now: NOW, lastFiredAt: null, intervalSec: 3 * 86_400 })).toBe(ALL_COMPLETE_IDLE_MAX_DELAY_MS);
  });

  it('isOwnerScheduleRow / the control draw / the re-plan notice', () => {
    expect(isOwnerScheduleRow({ promptSetBy: 'user' })).toBe(true);
    expect(isOwnerScheduleRow({ promptSetBy: null })).toBe(true);
    expect(isOwnerScheduleRow({ promptSetBy: 'machine', ownerSubscribed: true })).toBe(true);
    expect(isOwnerScheduleRow({ promptSetBy: 'system' })).toBe(false);
    expect(drawAllCompleteControl(10, () => 0.05)).toBe(true);
    expect(drawAllCompleteControl(10, () => 0.5)).toBe(false);
    expect(drawAllCompleteControl(0, () => 0)).toBe(false);
    const n = rePlanFromCharterNotice({ at: NOW, steps: 6, goal: { title: 'Ship the events DB', status: 'active' }, todo: { title: 'Schema', status: 'done' }, openTodos: [{ id: 'aaaaaaaa-1', title: 'Backfill', status: 'pending' }] });
    expect(n.startsWith(`${RE_PLAN_FROM_CHARTER_MARKER} — harness-verified at fire time 2026-10-20T12:00:00.000Z]`)).toBe(true);
    expect(n).toContain('goal "Ship the events DB" (active), todo "Schema" (done)');
    expect(n).toContain('aaaaaaaa "Backfill" (pending)');
    expect(n).toContain('Write a NEW plan (update_plan)');
    const empty = rePlanFromCharterNotice({ at: NOW, steps: 1, goal: { title: 'G', status: 'active' }, todo: null, openTodos: [] });
    expect(empty).toContain('do not start unassigned work');
    expect(empty).not.toContain('pull the next one');
  });
});

describe('decideAllCompleteFiring', () => {
  it('no charter + an empty lane ledger ⇒ idle_skip with the stretched next firing (2 × 1 h since the last firing)', async () => {
    const d = await decideAllCompleteFiring(input());
    expect(d).toEqual({ action: 'idle_skip', why: 'quiet', nextRunAt: new Date(NOW.getTime() + 2 * H), delayMs: 2 * H });
  });

  it('1 in 10 would-be skips fires as a labelled control', async () => {
    setAllCompleteControlSampler(() => 0.01);
    expect(await decideAllCompleteFiring(input())).toEqual({ action: 'idle_control', why: 'control' });
  });

  it.each([
    ['message', () => mockPrisma.$queryRawUnsafe.mockResolvedValue([{ n: 1 }])],
    ['live_run', () => mockPrisma.agentRun.count.mockResolvedValue(1)],
    ['assigned_todo', () => mockPrisma.projectTodo.count.mockImplementation(async ({ where }: any) => (where.assigneeChatId ? 1 : 0))],
    ['pending_wake', () => mockPrisma.hookEvent.count.mockResolvedValue(1)],
    ['board_changed', () => mockPrisma.projectGoal.count.mockResolvedValue(1)],
    ['registered_gate', () => mockPrisma.chatSchedule.findUnique.mockResolvedValue({ deltaGate: { probes: [] }, requiredProbes: null })],
    ['watched_resource', () => mockPrisma.watchedResource.count.mockResolvedValue(1)],
  ])('anything that moved or a registered poll (%s) ⇒ the advisory, never a skip', async (why, arrange) => {
    arrange();
    expect(await decideAllCompleteFiring(input())).toEqual({ action: 'notice', why });
  });

  it('an OWNER row is never skipped and never paused; a supervisor chat keeps the advisory', async () => {
    expect(await decideAllCompleteFiring(input({ promptSetBy: 'user' }))).toEqual({ action: 'notice', why: 'owner_row' });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: 'lane-1', charterTodoId: 't1', isSupervisor: false, isProjectSupervisor: false });
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ title: 'T', status: 'done', goalId: null, assigneeChatId: 'lane-1' });
    process.env.SCHEDULE_CHARTER_TERMINATION_ENFORCE = '1';
    expect(await decideAllCompleteFiring(input({ ownerSubscribed: true }))).toEqual({ action: 'would_retire', why: 'charter_todo_done', ownerRow: true });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: 'sup', isProjectSupervisor: true });
    expect(await decideAllCompleteFiring(input())).toEqual({ action: 'notice', why: 'supervisor' });
  });

  it('charter done ⇒ would_retire (observe-only default); SCHEDULE_CHARTER_TERMINATION_ENFORCE=1 ⇒ retire', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: 'lane-1', projectId: 'p1', charterGoalId: 'g1', charterTodoId: 't1', isSupervisor: false, isProjectSupervisor: false });
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ title: 'Schema', status: 'done', goalId: 'g1', assigneeChatId: 'lane-1' });
    mockPrisma.projectGoal.findUnique.mockResolvedValue({ title: 'Events DB', status: 'active' });
    expect(await decideAllCompleteFiring(input())).toEqual({ action: 'would_retire', why: 'charter_todo_done', ownerRow: false });
    process.env.SCHEDULE_CHARTER_TERMINATION_ENFORCE = '1';
    expect(await decideAllCompleteFiring(input())).toEqual({ action: 'retire', why: 'charter_todo_done' });
  });

  it('charter open ⇒ replan with the ACTIONABLE todos assigned to this lane (never unassigned, never blocked)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: 'lane-1', projectId: 'p1', charterGoalId: 'g1', charterTodoId: 't1aaaaaa', isSupervisor: false, isProjectSupervisor: false });
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ title: 'Schema', status: 'in_progress', goalId: 'g1', assigneeChatId: 'lane-1' });
    mockPrisma.projectGoal.findUnique.mockResolvedValue({ title: 'Events DB', status: 'active' });
    mockPrisma.projectTodo.findMany.mockImplementation(async ({ where }: any) => (where.id
      ? [{ id: 'dep-open', status: 'in_progress' }]
      : [
        { id: 't1aaaaaa', title: 'Schema', status: 'in_progress', assigneeChatId: 'lane-1' },
        { id: 't2bbbbbb', title: 'Owner-gated deploy', status: 'blocked', assigneeChatId: 'lane-1' },
        { id: 't3cccccc', title: 'Backfill', status: 'pending', assigneeChatId: 'lane-1' },
      ]));
    mockPrisma.todoDependency.findMany.mockResolvedValue([{ todoId: 't3cccccc', dependsOnTodoId: 'dep-open' }]);
    const d = await decideAllCompleteFiring(input());
    expect(d).toMatchObject({ action: 'replan', why: 'charter_todo_in_progress', openTodos: 1 });
    expect((d as any).notice).toContain('t1aaaaaa "Schema" (in_progress)');
    expect((d as any).notice).not.toContain('Owner-gated deploy');
    expect((d as any).notice).not.toContain('Backfill');
    expect(mockPrisma.projectTodo.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { goalId: 'g1', status: { in: ['pending', 'in_progress', 'blocked'] }, assigneeChatId: 'lane-1' },
    }));
  });

  it('review fix: a charter todo blocked on an owner gate ⇒ the plain advisory (charter_waiting), never a replan / retire / skip', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: 'lane-1', projectId: 'p1', charterGoalId: 'g1', charterTodoId: 't1', isSupervisor: false, isProjectSupervisor: false });
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ title: 'Prod deploy', status: 'blocked', goalId: 'g1', assigneeChatId: 'lane-1' });
    mockPrisma.projectGoal.findUnique.mockResolvedValue({ title: 'Events DB', status: 'active' });
    mockPrisma.projectTodo.findMany.mockResolvedValue([{ id: 't1', title: 'Prod deploy', status: 'blocked', assigneeChatId: 'lane-1' }]);
    expect(await decideAllCompleteFiring(input())).toEqual({ action: 'notice', why: 'charter_waiting:charter_todo_blocked' });
    process.env.SCHEDULE_CHARTER_TERMINATION_ENFORCE = '1';
    expect(await decideAllCompleteFiring(input())).toEqual({ action: 'notice', why: 'charter_waiting:charter_todo_blocked' });
  });

  it('kill switch ⇒ the advisory with no read; a DB error ⇒ the advisory (fail toward firing)', async () => {
    process.env.SCHEDULE_ALLCOMPLETE_IDLE_SKIP_DISABLED = '1';
    expect(scheduleAllCompleteIdleSkipDisabled()).toBe(true);
    expect(await decideAllCompleteFiring(input())).toEqual({ action: 'notice', why: 'disabled' });
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalled();
    delete process.env.SCHEDULE_ALLCOMPLETE_IDLE_SKIP_DISABLED;
    mockPrisma.$queryRawUnsafe.mockRejectedValue(new Error('db'));
    expect(await decideAllCompleteFiring(input())).toEqual({ action: 'notice', why: 'error' });
  });

  it('laneLedgerQuietSince reads owner / agent messages only (schedule / hook wake rows are not news)', async () => {
    expect(await laneLedgerQuietSince({ id: 'lane-1', projectId: null }, NOW)).toEqual({ quiet: true, why: 'quiet' });
    const sql = String(mockPrisma.$queryRawUnsafe.mock.calls[0][0]);
    expect(sql).toContain("COALESCE(metadata->>'origin', '') IN ('', 'user', 'agent')");
    expect(mockPrisma.projectGoal.count).not.toHaveBeenCalled(); // no project, no board read
  });
});

describe('noticeAllCompleteIdleSkipOnce', () => {
  it('tells the supervisor ONCE per row per 24 h (a quiet schedule_cap_skipped, kind all_complete_idle); muted after', async () => {
    const next = new Date(NOW.getTime() + 2 * H);
    expect(await noticeAllCompleteIdleSkipOnce({ id: 'sch-1', sessionId: 'lane-1' }, next)).toBe(true);
    expect(mockRedisSet).toHaveBeenCalledWith('cm:sched:allcomplete-idle:sch-1', '1', { NX: true, EX: 86_400 });
    expect(mockEmit).toHaveBeenCalledWith('lane-1', 'schedule_cap_skipped', expect.stringContaining('Schedule sch-1 idle-skipped'), { scheduleId: 'sch-1', kind: 'all_complete_idle', nextRunAt: next.toISOString() });
    mockRedisSet.mockResolvedValue(null);
    expect(await noticeAllCompleteIdleSkipOnce({ id: 'sch-1', sessionId: 'lane-1' }, next)).toBe(false);
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });
});

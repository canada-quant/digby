/**
 * LANE-IDLE-WAKE (2026-10-20) — coding/lane-idle.ts: the finalize check that
 * enqueues ONE delayed supervisor wake for a lane idle with open work, and the
 * delivery revalidation that consumes / defers a stale one. Prisma, Redis and
 * hooks.service are mocked.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));

const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  crossModelProject: { findUnique: jest.fn() },
  projectTodo: { findMany: jest.fn() },
  todoDependency: { findMany: jest.fn() },
  agentRun: { count: jest.fn(), findFirst: jest.fn() },
  hookEvent: { count: jest.fn() },
  ownerQuestion: { count: jest.fn() },
  pendingConfirmation: { count: jest.fn() },
  codingSchedule: { findMany: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
let mockRedisAvailable = true;
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  get default() {
    return mockRedisAvailable ? { set: (...a: any[]) => mockRedisSet(...a), del: (...a: any[]) => mockRedisDel(...a) } : null;
  },
}));

const mockEnqueueDirectWake = jest.fn();
jest.mock('../platform/hooks.service', () => ({ __esModule: true, enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a) }));

// The admin supervisor OFF switches (platform/supervisor-switch) — both ON unless a test flips one.
let mockFleetOn = true;
let mockProjectOn = true;
jest.mock('../platform/supervisor-switch', () => ({
  __esModule: true,
  getFleetSupervisorEnabled: async () => mockFleetOn,
  getProjectSupervisorsEnabled: async () => mockProjectOn,
}));

import {
  laneIdleVerdict, laneIdleFocusTodo, laneIdleWakePrompt, readLaneIdleFacts, resolveLaneSupervisor, scheduleArmsLane,
  maybeWakeSupervisorForIdleLane, revalidateLaneIdleWake, laneIdleWakeDisabled,
  LANE_IDLE_GRACE_MS, LANE_IDLE_DEDUPE_SEC, LANE_IDLE_WAKE_KIND, LANE_IDLE_WAKE_TRIGGER, STALL_ARMED_HORIZON_MS,
} from './lane-idle';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const LANE = 'lane-7bd45d57-aaaa';
const min = (m: number) => new Date(NOW.getTime() + m * 60_000);
const todo = (over: any = {}) => ({ id: 't-1111aaaa', title: 'Events DB', status: 'in_progress', goalId: 'g1', projectId: 'p1', ...over });
const rows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === 'lane_idle_wake');
const hourly = (dueInMin: number) => ({ nextRunAt: min(dueInMin), kind: 'recurring', intervalSec: 3600 });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LANE_IDLE_WAKE_DISABLED;
  mockRedisAvailable = true;
  mockFleetOn = true;
  mockProjectOn = true;
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ title: 'Drive watch', projectId: 'p1', isSupervisor: false, isProjectSupervisor: false, archivedAt: null });
  mockPrisma.crossModelChat.findFirst.mockImplementation(async ({ where }: any) => (where.isProjectSupervisor ? { id: 'ps-1' } : where.isSupervisor ? { id: 'fleet-1' } : null));
  mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
  mockPrisma.crossModelProject.findUnique.mockResolvedValue({ supervised: true, projectSupervisorEnabled: true });
  mockPrisma.projectTodo.findMany.mockResolvedValue([todo()]);
  mockPrisma.todoDependency.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.count.mockResolvedValue(0);
  mockPrisma.agentRun.findFirst.mockResolvedValue(null);
  mockPrisma.hookEvent.count.mockResolvedValue(0);
  mockPrisma.ownerQuestion.count.mockResolvedValue(0);
  mockPrisma.pendingConfirmation.count.mockResolvedValue(0);
  mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
  mockEnqueueDirectWake.mockResolvedValue({ ok: true, hookEventId: 'he-1' });
});

describe('pure', () => {
  it('laneIdleVerdict: no actionable todo, a live run, a pending wake, an owner wait or an arming schedule keep the lane moving; otherwise idle', () => {
    const base = { todos: [todo()], liveRun: false, pendingWake: false, ownerWait: false, scheduleDueSoon: false };
    expect(laneIdleVerdict({ ...base, todos: [] })).toEqual({ idle: false, why: 'no_open_work' });
    expect(laneIdleVerdict({ ...base, liveRun: true })).toEqual({ idle: false, why: 'live_run' });
    expect(laneIdleVerdict({ ...base, pendingWake: true })).toEqual({ idle: false, why: 'pending_wake' });
    expect(laneIdleVerdict({ ...base, ownerWait: true })).toEqual({ idle: false, why: 'owner_wait' });
    expect(laneIdleVerdict({ ...base, scheduleDueSoon: true })).toEqual({ idle: false, why: 'schedule_due' });
    expect(laneIdleVerdict(base)).toEqual({ idle: true, why: 'idle' });
  });

  it('scheduleArmsLane: due within 2 h, or a recurring row within 1.5× its own interval; a far one-shot never (review fix — same rule as stalledLanes)', () => {
    expect(STALL_ARMED_HORIZON_MS).toBe(2 * 3_600_000);
    // The finding's case: an hourly lane whose next firing is 40–55 min out is ARMED (it was "idle" at the old 20-min horizon).
    expect(scheduleArmsLane(hourly(40), NOW)).toBe(true);
    expect(scheduleArmsLane(hourly(55), NOW)).toBe(true);
    expect(scheduleArmsLane({ nextRunAt: min(110), kind: 'recurring', intervalSec: 7200 }, NOW)).toBe(true); // every 2 h
    expect(scheduleArmsLane({ nextRunAt: min(23 * 60), kind: 'recurring', intervalSec: 86_400 }, NOW)).toBe(true); // daily cadence
    expect(scheduleArmsLane({ nextRunAt: min(119), kind: 'once', intervalSec: null }, NOW)).toBe(true);
    expect(scheduleArmsLane({ nextRunAt: min(20 * 60), kind: 'once', intervalSec: null }, NOW)).toBe(false); // a check armed for tomorrow
    expect(scheduleArmsLane({ nextRunAt: min(5 * 60), kind: 'recurring', intervalSec: 3600 }, NOW)).toBe(false); // a stretched hourly row 5 h out
    expect(scheduleArmsLane({ nextRunAt: min(-10), kind: 'recurring', intervalSec: 3600 }, NOW)).toBe(true); // overdue
    expect(scheduleArmsLane({ nextRunAt: null }, NOW)).toBe(false);
    expect(scheduleArmsLane({ nextRunAt: 'garbage' }, NOW)).toBe(false);
  });

  it('laneIdleFocusTodo prefers the in_progress todo; the prompt names lane, todo, the run end and the 2 h / cadence rule — never a cancelled branch', () => {
    const ts = [todo({ id: 't-pend0001', status: 'pending', title: 'Later' }), todo()];
    expect(laneIdleFocusTodo(ts)?.id).toBe('t-1111aaaa');
    expect(laneIdleFocusTodo([])).toBeNull();
    const p = laneIdleWakePrompt({ laneChatId: LANE, laneTitle: 'Drive watch', todos: ts, runId: 'run-12345678', finalStatus: 'failed', endedAt: NOW, graceMin: 20 });
    expect(p.startsWith(`[LANE IDLE WITH OPEN WORK — harness check, lane ${LANE.slice(0, 8)}]`)).toBe(true);
    expect(p).toContain('todo t-1111aa "Events DB" (in_progress) (+1 more open todo(s) assigned to it)');
    expect(p).toContain('run run-1234 FAILED at 2026-10-20T12:00:00.000Z');
    expect(p).toContain('no schedule due within 2 h (a recurring one: within 1.5× its own interval)');
    expect(p).toContain('no open owner question or confirmation card');
    expect(p).not.toMatch(/STOPPED|reassign/);
  });
});

describe('readLaneIdleFacts', () => {
  it('drops pending todos waiting on an open dependency, keeps in_progress and dependency-free pending; excludes the finalizing run', async () => {
    mockPrisma.projectTodo.findMany.mockImplementation(async ({ where }: any) => (where.id
      ? [{ id: 'dep-open', status: 'in_progress' }, { id: 'dep-done', status: 'done' }]
      : [todo(), todo({ id: 't-wait', status: 'pending' }), todo({ id: 't-free', status: 'pending' })]));
    mockPrisma.todoDependency.findMany.mockResolvedValue([{ todoId: 't-wait', dependsOnTodoId: 'dep-open' }, { todoId: 't-free', dependsOnTodoId: 'dep-done' }]);
    const f = await readLaneIdleFacts(LANE, NOW, { excludeRunId: 'run-1' });
    expect(f.todos.map((t) => t.id)).toEqual(['t-1111aaaa', 't-free']);
    expect(mockPrisma.agentRun.count).toHaveBeenCalledWith({ where: { sessionId: LANE, status: { in: ['queued', 'running'] }, NOT: { id: 'run-1' } } });
    expect(mockPrisma.codingSchedule.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: LANE, enabled: true }, select: { nextRunAt: true, kind: true, intervalSec: true } }));
    expect(f).toMatchObject({ liveRun: false, pendingWake: false, ownerWait: false, scheduleDueSoon: false });
  });

  it('an hourly schedule 50 min out arms the lane; a one-shot tomorrow does not', async () => {
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ nextRunAt: min(20 * 60), kind: 'once', intervalSec: null }, hourly(50)]);
    expect((await readLaneIdleFacts(LANE, NOW)).scheduleDueSoon).toBe(true);
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ nextRunAt: min(20 * 60), kind: 'once', intervalSec: null }]);
    expect((await readLaneIdleFacts(LANE, NOW)).scheduleDueSoon).toBe(false);
  });

  it('a live run on a CHILD session the lane spawned counts as a live run; an open owner question or a pending card is an owner wait', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'child-1' }]);
    mockPrisma.agentRun.count.mockImplementation(async ({ where }: any) => (where.sessionId?.in ? 1 : 0));
    const f = await readLaneIdleFacts(LANE, NOW);
    expect(f.liveRun).toBe(true);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith({ where: { parentChatId: LANE, archivedAt: null }, select: { id: true }, take: 50 });
    expect(mockPrisma.agentRun.count).toHaveBeenCalledWith({ where: { sessionId: { in: ['child-1'] }, status: { in: ['queued', 'running'] } } });
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
    mockPrisma.ownerQuestion.count.mockResolvedValue(1);
    expect((await readLaneIdleFacts(LANE, NOW)).ownerWait).toBe(true);
    mockPrisma.ownerQuestion.count.mockResolvedValue(0);
    mockPrisma.pendingConfirmation.count.mockResolvedValue(1);
    expect((await readLaneIdleFacts(LANE, NOW)).ownerWait).toBe(true);
    expect(mockPrisma.pendingConfirmation.count).toHaveBeenLastCalledWith({ where: { chatId: LANE, status: 'pending', expiresAt: { gt: NOW } } });
  });

  it('no open todo short-circuits (no run / hook / schedule reads)', async () => {
    mockPrisma.projectTodo.findMany.mockResolvedValue([]);
    expect(await readLaneIdleFacts(LANE, NOW)).toEqual({ todos: [], liveRun: false, pendingWake: false, ownerWait: false, scheduleDueSoon: false });
    expect(mockPrisma.agentRun.count).not.toHaveBeenCalled();
  });
});

describe('resolveLaneSupervisor', () => {
  it('the project supervisor when enabled; the Fleet Supervisor for a supervised project without one; nobody for an unsupervised project', async () => {
    expect(await resolveLaneSupervisor('u1', 'p1')).toEqual({ chatId: 'ps-1', kind: 'project' });
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ supervised: true, projectSupervisorEnabled: false });
    expect(await resolveLaneSupervisor('u1', 'p1')).toEqual({ chatId: 'fleet-1', kind: 'fleet' });
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ supervised: false, projectSupervisorEnabled: false });
    expect(await resolveLaneSupervisor('u1', 'p1')).toBeNull();
    mockPrisma.crossModelProject.findUnique.mockRejectedValue(new Error('db'));
    expect(await resolveLaneSupervisor('u1', 'p1')).toBeNull();
  });

  it('review fix: project supervisors switched OFF ⇒ the Fleet owns the lane (never the switched-off PS); the Fleet switched OFF ⇒ nobody', async () => {
    mockProjectOn = false;
    expect(await resolveLaneSupervisor('u1', 'p1')).toEqual({ chatId: 'fleet-1', kind: 'fleet' });
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ supervised: false, projectSupervisorEnabled: true });
    expect(await resolveLaneSupervisor('u1', 'p1')).toBeNull(); // an unsupervised project stays nobody's
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ supervised: true, projectSupervisorEnabled: true });
    mockFleetOn = false;
    expect(await resolveLaneSupervisor('u1', 'p1')).toBeNull();
    mockProjectOn = true;
    expect(await resolveLaneSupervisor('u1', 'p1')).toEqual({ chatId: 'ps-1', kind: 'project' }); // the Fleet switch never gates a PS
    expect(await resolveLaneSupervisor('u1', null)).toBeNull();
  });
});

describe('maybeWakeSupervisorForIdleLane (run finalize)', () => {
  const run = (over: any = {}) => maybeWakeSupervisorForIdleLane({ chatId: LANE, userId: 'u1', runId: 'run-12345678', finalStatus: 'completed', now: NOW, ...over });

  it('an idle lane with open work enqueues ONE delayed (+20 min) lane_idle wake on its project supervisor and records it', async () => {
    expect(await run({ finalStatus: 'failed' })).toBe('enqueued');
    expect(mockRedisSet).toHaveBeenCalledWith(`lane-idle-wake:${LANE}`, NOW.toISOString(), { NX: true, EX: LANE_IDLE_DEDUPE_SEC });
    const arg = mockEnqueueDirectWake.mock.calls[0][0];
    expect(arg.targetChatId).toBe('ps-1');
    expect(arg.notBefore).toEqual(new Date(NOW.getTime() + LANE_IDLE_GRACE_MS));
    expect(arg.meta).toEqual({
      wakeKind: LANE_IDLE_WAKE_KIND, trigger: LANE_IDLE_WAKE_TRIGGER, laneChatId: LANE, laneTodoId: 't-1111aaaa',
      laneRunId: 'run-12345678', laneRunStatus: 'failed', enqueuedAt: NOW.toISOString(),
    });
    expect(arg.meta.todoId).toBeUndefined(); // never the assignee-actionable revalidation handle
    expect(arg.prompt).toContain('[LANE IDLE WITH OPEN WORK');
    expect(rows()).toEqual([expect.objectContaining({ sessionId: LANE, runId: 'run-12345678', meta: expect.objectContaining({ phase: 'finalize', outcome: 'enqueued', supervisorChatId: 'ps-1', supervisorKind: 'project', todoId: 't-1111aaaa' }) })]);
  });

  it('an hourly lane whose next firing is 40–55 min out is NOT idle (review fix: the 2 h / cadence horizon, not 20 min)', async () => {
    for (const due of [40, 55]) {
      mockPrisma.codingSchedule.findMany.mockResolvedValue([hourly(due)]);
      expect(await run()).toBe('schedule_due');
    }
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('a CANCELLED run (owner Stop / stop_run) never wakes the supervisor — observe-only "stopped", no dedupe slot taken', async () => {
    expect(await run({ finalStatus: 'cancelled' })).toBe('stopped');
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(rows()[0].meta).toMatchObject({ phase: 'finalize', outcome: 'stopped', finalStatus: 'cancelled', idle: true, todoId: 't-1111aaaa' });
  });

  it.each([
    ['live_run', () => mockPrisma.agentRun.count.mockResolvedValue(1)],
    ['pending_wake', () => mockPrisma.hookEvent.count.mockResolvedValue(2)],
    ['owner_wait', () => mockPrisma.ownerQuestion.count.mockResolvedValue(1)],
    ['schedule_due', () => mockPrisma.codingSchedule.findMany.mockResolvedValue([hourly(30)])],
  ])('%s: something will wake the lane — no enqueue, one telemetry row', async (why, arrange) => {
    arrange();
    expect(await run()).toBe(why);
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(rows()[0].meta).toMatchObject({ outcome: why });
  });

  it('no actionable todo, a supervisor / archived chat, or the kill switch: nothing (no row)', async () => {
    mockPrisma.projectTodo.findMany.mockResolvedValue([]);
    expect(await run()).toBe('no_open_work');
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ isProjectSupervisor: true });
    expect(await run()).toBe('not_lane');
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ archivedAt: new Date() });
    expect(await run()).toBe('not_lane');
    process.env.LANE_IDLE_WAKE_DISABLED = '1';
    expect(laneIdleWakeDisabled()).toBe(true);
    expect(await run()).toBe('disabled');
    expect(rows()).toHaveLength(0);
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('deduped within 6 h (Redis NX lost); with Redis down a recent lane_idle row in the DB dedupes', async () => {
    mockRedisSet.mockResolvedValue(null);
    expect(await run()).toBe('deduped');
    mockRedisAvailable = false;
    mockPrisma.hookEvent.count.mockImplementation(async ({ where }: any) => (where?.payload ? 1 : 0));
    expect(await run()).toBe('deduped');
    const dbProbe = mockPrisma.hookEvent.count.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.payload);
    expect(dbProbe.where).toMatchObject({ eventType: 'todo_wake', hook: { targetChatId: 'ps-1' }, payload: { path: ['laneChatId'], equals: LANE } });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('review fix: with project supervisors OFF the wake goes to the Fleet; with the Fleet OFF too nothing is enqueued and no slot is taken', async () => {
    mockProjectOn = false;
    expect(await run()).toBe('enqueued');
    expect(mockEnqueueDirectWake.mock.calls[0][0].targetChatId).toBe('fleet-1');
    expect(rows()[0].meta).toMatchObject({ outcome: 'enqueued', supervisorChatId: 'fleet-1', supervisorKind: 'fleet' });
    jest.clearAllMocks();
    mockFleetOn = false;
    expect(await run()).toBe('no_supervisor');
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('a failed enqueue releases the dedupe slot; no supervisor records no_supervisor', async () => {
    mockEnqueueDirectWake.mockResolvedValue({ ok: false, error: 'boom' });
    expect(await run()).toBe('enqueue_failed');
    expect(mockRedisDel).toHaveBeenCalledWith(`lane-idle-wake:${LANE}`);
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ supervised: false, projectSupervisorEnabled: false });
    expect(await run()).toBe('no_supervisor');
  });

  it('a DB error answers error and never throws', async () => {
    mockPrisma.projectTodo.findMany.mockRejectedValue(new Error('db down'));
    await expect(run()).resolves.toBe('error');
  });
});

describe('revalidateLaneIdleWake (delivery)', () => {
  const ENQ = '2026-10-20T11:40:00.000Z';
  const payload = (over: any = {}) => ({ wakeKind: 'lane_idle', laneChatId: LANE, laneTodoId: 't-1111aaaa', enqueuedAt: ENQ, ...over });
  beforeEach(() => mockPrisma.crossModelChat.findUnique.mockResolvedValue({ archivedAt: null, title: 'Drive watch' }));

  it('still idle and unmoved ⇒ deliver (no prompt rewrite) + a delivered row, stamped for the caller to persist', async () => {
    expect(await revalidateLaneIdleWake(payload(), NOW)).toEqual({ action: 'deliver', deliveredAt: NOW.toISOString() });
    expect(mockPrisma.agentRun.findFirst).toHaveBeenLastCalledWith({
      where: { sessionId: LANE, createdAt: { gt: new Date(ENQ) } }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, createdAt: true, finishedAt: true },
    });
    expect(rows()[0].meta).toMatchObject({ phase: 'delivery', outcome: 'delivered' });
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  it('review fix: a row parked behind a busy supervisor and re-claimed every tick records its delivered row ONCE per episode', async () => {
    const stamped = payload({ laneIdleDeliveredAt: min(-3).toISOString() });
    // Re-claims of the same episode: no second 'delivered' row, no new stamp.
    expect(await revalidateLaneIdleWake(stamped, NOW)).toEqual({ action: 'deliver' });
    expect(await revalidateLaneIdleWake(stamped, new Date(NOW.getTime() + 30_000))).toEqual({ action: 'deliver' });
    expect(rows()).toHaveLength(0);
    // A suppress / defer verdict is still recorded (it ends or re-dates the row).
    mockPrisma.agentRun.count.mockResolvedValue(1);
    expect(await revalidateLaneIdleWake(stamped, NOW)).toEqual({ action: 'suppress', reason: 'live_run' });
    expect(rows().map((r) => r.meta.outcome)).toEqual(['suppressed']);
    mockPrisma.agentRun.count.mockResolvedValue(0);
    // A NEW episode — the newest run ended after the stamp — records again and is re-stamped.
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'run-newer001', status: 'completed', createdAt: min(-2), finishedAt: min(-1) });
    const later = new Date(NOW.getTime() + LANE_IDLE_GRACE_MS);
    const v = await revalidateLaneIdleWake(stamped, later);
    expect(v).toMatchObject({ action: 'deliver', deliveredAt: later.toISOString() });
    expect(rows().map((r) => r.meta.outcome)).toEqual(['suppressed', 'delivered']);
    expect(rows()[1].meta).toMatchObject({ newEpisode: true, newestRunId: 'run-newer001' });
    // …and that episode's own re-claims stay quiet.
    expect(await revalidateLaneIdleWake(payload({ laneIdleDeliveredAt: later.toISOString() }), new Date(later.getTime() + 30_000))).not.toHaveProperty('deliveredAt');
    expect(rows()).toHaveLength(2);
  });

  it('the lane MOVED and is idle again inside the grace window ⇒ DEFER to its newest run end + 20 min (the slot is kept, never released)', async () => {
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'run-newer001', status: 'completed', createdAt: min(-15), finishedAt: min(-5) });
    const v = await revalidateLaneIdleWake(payload(), NOW);
    expect(v).toEqual({ action: 'defer', until: new Date(min(-5).getTime() + LANE_IDLE_GRACE_MS), reason: 'lane_moved' });
    expect(mockRedisDel).not.toHaveBeenCalled();
    expect(mockRedisSet).toHaveBeenCalledWith(`lane-idle-wake:${LANE}`, NOW.toISOString(), { EX: LANE_IDLE_DEDUPE_SEC });
    expect(rows()[0].meta).toMatchObject({ phase: 'delivery', outcome: 'deferred', reason: 'lane_moved', newestRunId: 'run-newer001' });
  });

  it('the lane moved and went idle again ≥ the grace window ago ⇒ a NEW episode: DELIVER with a prompt naming the newest run (the second finalize was deduped)', async () => {
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'run-newer001', status: 'failed', createdAt: min(-35), finishedAt: min(-25) });
    const v = await revalidateLaneIdleWake(payload(), NOW);
    expect(v.action).toBe('deliver');
    expect((v as any).prompt).toContain(`Its last run run-newe FAILED at ${min(-25).toISOString()}`);
    expect((v as any).prompt).toContain('"Drive watch"');
    expect(rows()[0].meta).toMatchObject({ outcome: 'delivered', newEpisode: true, newestRunId: 'run-newer001' });
  });

  it('a newer run that was STOPPED ⇒ suppressed lane_stopped (a stop means stop)', async () => {
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'run-stop0001', status: 'cancelled', createdAt: min(-15), finishedAt: min(-14) });
    expect(await revalidateLaneIdleWake(payload(), NOW)).toEqual({ action: 'suppress', reason: 'lane_stopped' });
    expect(mockRedisDel).toHaveBeenCalledWith(`lane-idle-wake:${LANE}`);
  });

  it('a live run / an arming hourly schedule / an owner wait / no open todo / archived / missing ⇒ suppressed, and the dedupe slot is released', async () => {
    mockPrisma.agentRun.count.mockResolvedValue(1);
    expect(await revalidateLaneIdleWake(payload(), NOW)).toEqual({ action: 'suppress', reason: 'live_run' });
    mockPrisma.agentRun.count.mockResolvedValue(0);
    mockPrisma.codingSchedule.findMany.mockResolvedValue([hourly(35)]);
    expect(await revalidateLaneIdleWake(payload(), NOW)).toEqual({ action: 'suppress', reason: 'schedule_due' });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
    mockPrisma.pendingConfirmation.count.mockResolvedValue(1);
    expect(await revalidateLaneIdleWake(payload(), NOW)).toEqual({ action: 'suppress', reason: 'owner_wait' });
    mockPrisma.pendingConfirmation.count.mockResolvedValue(0);
    mockPrisma.projectTodo.findMany.mockResolvedValue([]);
    expect(await revalidateLaneIdleWake(payload(), NOW)).toEqual({ action: 'suppress', reason: 'no_open_work' });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ archivedAt: new Date() });
    expect(await revalidateLaneIdleWake(payload(), NOW)).toEqual({ action: 'suppress', reason: 'lane_archived' });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
    expect(await revalidateLaneIdleWake(payload(), NOW)).toEqual({ action: 'suppress', reason: 'lane_missing' });
    expect(mockRedisDel).toHaveBeenCalledTimes(6);
    expect(rows().every((r) => r.meta.outcome === 'suppressed')).toBe(true);
  });

  it('fail-open: a read error or a payload without a lane delivers', async () => {
    mockPrisma.crossModelChat.findUnique.mockRejectedValue(new Error('db'));
    expect(await revalidateLaneIdleWake(payload(), NOW)).toEqual({ action: 'deliver' });
    expect(await revalidateLaneIdleWake({}, NOW)).toEqual({ action: 'deliver' });
    expect(await revalidateLaneIdleWake(null, NOW)).toEqual({ action: 'deliver' });
  });
});

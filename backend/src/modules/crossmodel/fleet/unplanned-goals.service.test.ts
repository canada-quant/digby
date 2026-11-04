/**
 * GOAL-UNPLANNED part 3 (architecture review #6, 2026-10-20) — the
 * attention-watchdog sub-sweep. An ACTIVE goal with zero open todos and no
 * lane chartered to it (crossmodel_chats.charterGoalId, plus its todos'
 * assignees) that ran in the last 6 h wakes the project supervisor ONCE per
 * goal per 24 h with '[GOAL UNPLANNED]' + a goal_unplanned row. Held / blocked
 * / young goals, a lane that ran recently, a paused project, the supervisor
 * OFF switch and the kill switch never wake. Never throws. Review fix: a
 * 48 h first-deploy ramp, a 24 h → 72 h → 7 d backoff then board-only on an
 * unchanged goal, and a Redis outage counted as such (never as a dedupe).
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn() },
  crossModelProject: { findMany: jest.fn() },
  projectGoal: { findMany: jest.fn() },
  projectTodo: { findMany: jest.fn() },
  agentRun: { count: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: null }));
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a), LOOP_METRIC_KINDS: { GOAL_UNPLANNED: 'goal_unplanned' } }));
const mockSwitchOn = jest.fn(async () => true);
const mockSwitchSkip = jest.fn();
jest.mock('../platform/supervisor-switch', () => ({ __esModule: true, getProjectSupervisorsEnabled: () => mockSwitchOn(), recordSupervisorSwitchSkip: (...a: any[]) => mockSwitchSkip(...a) }));

import { detectUnplannedGoals } from './unplanned-goals.service';

const NOW = new Date('2026-10-20T12:00:00Z');
const SUP = 'sup00000-0000-4000-8000-000000000000';
const PID = 'p-ttrd';
const G = 'g0unplan-0000-4000-8000-000000000000';
const keys = new Map<string, string>();
const ttls = new Map<string, number>();
const redis = {
  set: jest.fn(async (k: string, v: string, o?: any) => { if (o?.NX && keys.has(k)) return null; keys.set(k, v); if (o?.EX) ttls.set(k, o.EX); return 'OK'; }),
  get: jest.fn(async (k: string) => keys.get(k) ?? null),
  del: jest.fn(async (k: string) => { keys.delete(k); return 1; }),
};
const wake = jest.fn(async (..._a: any[]) => ({ ok: true, hookEventId: 'he-1' }));
// rampMs 0: the first-deploy ramp has its own test below.
const run = (now: Date = NOW) => detectUnplannedGoals({ now, redis, enqueueDirectWake: wake as any, rampMs: 0 });

let goals: any[];
let todos: any[];
let chartered: any[];
let laneRuns: number;
beforeEach(() => {
  jest.clearAllMocks();
  keys.clear();
  ttls.clear();
  delete process.env.GOAL_UNPLANNED_SIGNAL_DISABLED;
  goals = [{ id: G, title: 'Hit 10 tok/s', status: 'active', progressNote: null, createdAt: new Date(NOW.getTime() - 72 * 3600_000) }];
  todos = [{ goalId: G, status: 'done', assigneeChatId: 'lane-1' }, { goalId: G, status: 'dropped', assigneeChatId: null }];
  chartered = [];
  laneRuns = 0;
  mockSwitchOn.mockImplementation(async () => true);
  mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => (args?.where?.isProjectSupervisor ? [{ id: SUP, projectId: PID }] : chartered));
  mockPrisma.crossModelProject.findMany.mockImplementation(async () => [{ id: PID, name: 'tt-rd', projectSupervisorEnabled: true, archivedAt: null }]);
  mockPrisma.projectGoal.findMany.mockImplementation(async () => goals);
  mockPrisma.projectTodo.findMany.mockImplementation(async () => todos);
  mockPrisma.agentRun.count.mockImplementation(async () => laneRuns);
});

describe('detectUnplannedGoals', () => {
  it('wakes the supervisor ONCE with the [GOAL UNPLANNED] text and records goal_unplanned; the 24 h NX key holds the next sweep', async () => {
    const c = await run();
    expect(c).toEqual(expect.objectContaining({ projects: 1, candidates: 1, wakes: 1 }));
    expect(wake).toHaveBeenCalledTimes(1);
    const w = wake.mock.calls[0][0] as any;
    expect(w.targetChatId).toBe(SUP);
    expect(w.prompt).toContain('[GOAL UNPLANNED] goal "Hit 10 tok/s" (g0unplan): no open todos (1 done, 1 dropped). Create the next todo (with budget + criterion), close with evidence, or block with a kind + reason.');
    expect(w.meta).toEqual(expect.objectContaining({ kind: 'goal_unplanned', goalId: G, projectId: PID }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'goal_unplanned', sessionId: SUP, meta: expect.objectContaining({ goalId: G, outcome: 'woken', doneTodos: 1, droppedTodos: 1, ageH: 72 }) }));
    // only ACTIVE goals older than the grace window are read
    expect(mockPrisma.projectGoal.findMany.mock.calls[0][0].where).toEqual(expect.objectContaining({ projectId: PID, status: 'active' }));
    const again = await run();
    expect(again.deduped).toBe(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('a lane chartered to it (or assigned one of its todos) that ran in the last 6 h means it is being worked — no wake', async () => {
    chartered = [{ id: 'lane-charter' }];
    laneRuns = 1;
    const c = await run();
    expect(c.laneActive).toBe(1);
    expect(wake).not.toHaveBeenCalled();
    const where = mockPrisma.agentRun.count.mock.calls[0][0].where;
    expect(where.sessionId.in.sort()).toEqual(['lane-1', 'lane-charter']);
    expect(where.OR[1].updatedAt.gte.getTime()).toBe(NOW.getTime() - 6 * 3600_000);
  });

  it('an open todo, a held progress note, a supervisor switched OFF, a paused project, no Redis: no wake', async () => {
    todos = [{ goalId: G, status: 'pending', assigneeChatId: null }];
    expect((await run()).candidates).toBe(0);
    todos = [];
    goals = [{ ...goals[0], progressNote: 'HOLD until the owner rules on the box' }];
    expect((await run()).candidates).toBe(0);
    goals = [{ ...goals[0], progressNote: null }];
    mockSwitchOn.mockImplementation(async () => false);
    expect((await run()).wakes).toBe(0);
    expect(mockSwitchSkip).toHaveBeenCalled();
    mockSwitchOn.mockImplementation(async () => true);
    mockPrisma.crossModelProject.findMany.mockImplementation(async () => [{ id: PID, projectSupervisorEnabled: false, archivedAt: null }]);
    expect((await run()).projects).toBe(0);
    mockPrisma.crossModelProject.findMany.mockImplementation(async () => [{ id: PID, projectSupervisorEnabled: true, archivedAt: null }]);
    const noRedis = await detectUnplannedGoals({ now: NOW, redis: null, enqueueDirectWake: wake as any, rampMs: 0 });
    expect(noRedis.wakes).toBe(0);
    expect(noRedis.redisUnavailable).toBe(1); // an outage, never counted as a dedupe (review fix)
    expect(noRedis.deduped).toBe(0);
    expect(wake).not.toHaveBeenCalled();
  });

  it('an enqueue failure frees the window (the next sweep retries) and is recorded', async () => {
    wake.mockImplementationOnce(async () => ({ ok: false, error: 'target chat not found' }) as any);
    const c = await run();
    expect(c.failed).toBe(1);
    expect(keys.size).toBe(0);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ outcome: 'enqueue_failed', error: 'target chat not found' }) }));
    expect((await run()).wakes).toBe(1);
  });

  it('kill switch GOAL_UNPLANNED_SIGNAL_DISABLED=1: nothing is read; a failing read never throws', async () => {
    process.env.GOAL_UNPLANNED_SIGNAL_DISABLED = '1';
    expect(await run()).toEqual({ projects: 0, candidates: 0, wakes: 0, deduped: 0, laneActive: 0, failed: 0, ramp: 0, backedOff: 0, redisUnavailable: 0 });
    expect(mockPrisma.crossModelChat.findMany).not.toHaveBeenCalled();
    delete process.env.GOAL_UNPLANNED_SIGNAL_DISABLED;
    mockPrisma.projectGoal.findMany.mockImplementation(async () => { throw new Error('db down'); });
    await expect(run()).resolves.toEqual(expect.objectContaining({ projects: 1, wakes: 0 }));
  });
});

describe('review fix — bounded wakes (alarm-class direct wakes bypass the machine-run cap)', () => {
  const H = 3600_000;

  it('first-deploy RAMP: for 48 h after the first sweep candidates get ONE ramp row per goal per 24 h and no wake; then wakes resume', async () => {
    const sweep = (now: Date) => detectUnplannedGoals({ now, redis, enqueueDirectWake: wake as any });
    const first = await sweep(NOW);
    expect(first).toEqual(expect.objectContaining({ candidates: 1, ramp: 1, wakes: 0 }));
    expect(keys.get('goal-unplanned:live-since')).toBe(String(NOW.getTime()));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ goalId: G, outcome: 'ramp' }) }));
    expect((await sweep(new Date(NOW.getTime() + 2 * H))).ramp).toBe(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1); // the ramp row is once per goal per 24 h
    const after = await sweep(new Date(NOW.getTime() + 49 * H));
    expect(after).toEqual(expect.objectContaining({ ramp: 0, wakes: 1 }));
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('a ramp stamp that cannot be read counts as "in ramp" (storm-proof)', async () => {
    const noGet = { set: redis.set, del: redis.del };
    keys.set('goal-unplanned:live-since', String(NOW.getTime() - 100 * H)); // stamp present, but unreadable without get
    const c = await detectUnplannedGoals({ now: NOW, redis: noGet, enqueueDirectWake: wake as any });
    expect(c.ramp).toBe(1);
    expect(wake).not.toHaveBeenCalled();
  });

  it('BACKOFF: consecutive wakes on an unchanged goal arm 24 h → 72 h → 7 d windows, then board-only; a changed todo set resets the streak', async () => {
    let t = NOW.getTime();
    const sweepAt = async () => run(new Date(t));
    expect((await sweepAt()).wakes).toBe(1);
    expect(ttls.get(`goal-unplanned:wake:${G}`)).toBe(24 * 3600);
    // the fake store has no expiry — clearing the wake key stands in for its window lapsing
    keys.delete(`goal-unplanned:wake:${G}`); t += 25 * H;
    expect((await sweepAt()).wakes).toBe(1);
    expect(ttls.get(`goal-unplanned:wake:${G}`)).toBe(72 * 3600);
    keys.delete(`goal-unplanned:wake:${G}`); t += 73 * H;
    expect((await sweepAt()).wakes).toBe(1);
    expect(ttls.get(`goal-unplanned:wake:${G}`)).toBe(7 * 24 * 3600);
    expect(mockRecordLoopMetric).toHaveBeenLastCalledWith(expect.objectContaining({ meta: expect.objectContaining({ outcome: 'woken', streak: 3, windowH: 168, final: true }) }));
    keys.delete(`goal-unplanned:wake:${G}`); t += 8 * 24 * H;
    const capped = await sweepAt();
    expect(capped).toEqual(expect.objectContaining({ wakes: 0, backedOff: 1 }));
    expect(wake).toHaveBeenCalledTimes(3);
    // the supervisor dropped a todo since — the todo set moved: a fresh streak, 24 h window again
    todos = [...todos, { goalId: G, status: 'dropped', assigneeChatId: null }];
    expect((await sweepAt()).wakes).toBe(1);
    expect(ttls.get(`goal-unplanned:wake:${G}`)).toBe(24 * 3600);
    expect(JSON.parse(keys.get(`goal-unplanned:streak:${G}`) as string)).toEqual(expect.objectContaining({ n: 1, fp: '3:1:2' }));
  });

  it('a Redis call that throws is an outage (redisUnavailable), never a dedupe, and wakes nobody', async () => {
    redis.set.mockImplementationOnce(async () => { throw new Error('ECONNRESET'); });
    const c = await run();
    expect(c).toEqual(expect.objectContaining({ redisUnavailable: 1, deduped: 0, wakes: 0 }));
    expect(wake).not.toHaveBeenCalled();
    redis.get.mockImplementationOnce(async () => { throw new Error('ECONNRESET'); });
    expect((await run()).redisUnavailable).toBe(1);
    expect(wake).not.toHaveBeenCalled();
  });
});

/**
 * Dormancy gate (ticket b1d435fd, owner directive 2026-09-18): the single
 * predicate every schedule arming/resume/firing path reads — a project with
 * NO active/blocked goals, NO open todos, NO live/queued runs, and NO live
 * watched-resource registrations is DORMANT and must get ZERO recurring
 * wakes. Pins the signal set, the carve-outs (owner-authored schedules,
 * projectless chats, live infra monitors), the archived/missing project
 * handling and the fail-open contract.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockProjectFindUnique = jest.fn();
const mockChatFindUnique = jest.fn();
const mockChatFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockGoalCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockTodoCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockWatchedCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
// Account gate (loop #18): the user's projects + enabled schedules elsewhere.
const mockProjectFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => [{ id: 'p1' }]);
const mockScheduleCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
// audit 2026-10-06 T4-4: the extra live-work signals' reads.
const mockHookEventFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockGoalFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockSupStateFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelProject: { findUnique: (...a: any[]) => mockProjectFindUnique(...a), findMany: (...a: any[]) => mockProjectFindMany(...a) },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), findMany: (...a: any[]) => mockChatFindMany(...a) },
    projectGoal: { count: (...a: any[]) => mockGoalCount(...a), findMany: (...a: any[]) => mockGoalFindMany(...a) },
    hookEvent: { findMany: (...a: any[]) => mockHookEventFindMany(...a) },
    supervisorState: { findUnique: (...a: any[]) => mockSupStateFindUnique(...a) },
    projectTodo: { count: (...a: any[]) => mockTodoCount(...a) },
    agentRun: { count: (...a: any[]) => mockRunCount(...a) },
    watchedResource: { count: (...a: any[]) => mockWatchedCount(...a) },
    codingSchedule: { count: (...a: any[]) => mockScheduleCount(...a) },
  },
}));

import {
  DORMANT_LAST_STATUS,
  evaluateProjectDormancy,
  evaluateScheduleDormancy,
  evaluateAccountDormancy,
  FLEET_DORMANT_AFTER_MS,
} from './dormancy-gate.service';

const PROJECT = { id: 'p1', name: 'Spark Cluster', archivedAt: null as any };

beforeEach(() => {
  jest.clearAllMocks();
  mockProjectFindUnique.mockResolvedValue({ ...PROJECT });
  mockChatFindUnique.mockResolvedValue({ id: 'c1', projectId: 'p1' });
  mockChatFindMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
  mockGoalCount.mockResolvedValue(0);
  mockTodoCount.mockResolvedValue(0);
  mockRunCount.mockResolvedValue(0);
  mockWatchedCount.mockResolvedValue(0);
  mockProjectFindMany.mockResolvedValue([{ id: 'p1' }]);
  mockScheduleCount.mockResolvedValue(0);
  mockHookEventFindMany.mockResolvedValue([]);
  mockGoalFindMany.mockResolvedValue([]);
  mockSupStateFindUnique.mockResolvedValue(null);
  delete process.env.DORMANCY_LIVE_SIGNALS_DISABLED;
});

describe('evaluateProjectDormancy — the signal set', () => {
  it('a project with zero goals, todos, runs, and watched resources is DORMANT with the one-line reason', async () => {
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(true);
    expect(v.projectId).toBe('p1');
    expect(v.reason).toContain('dormant');
    expect(v.reason).toContain('Spark Cluster');
    expect(v.signals).toEqual({ activeGoals: 0, openTodos: 0, liveRuns: 0, watchedResources: 0 });
  });

  it('queries the LIVE-work statuses: goals active|blocked, todos pending|in_progress|blocked, runs running|queued', async () => {
    await evaluateProjectDormancy('p1');
    expect(mockGoalCount).toHaveBeenCalledWith({ where: { projectId: 'p1', status: { in: ['active', 'blocked'] } } });
    expect(mockTodoCount).toHaveBeenCalledWith({ where: { projectId: 'p1', status: { in: ['pending', 'in_progress', 'blocked'] } } });
    expect(mockRunCount).toHaveBeenCalledWith({ where: { sessionId: { in: ['c1', 'c2'] }, status: { in: ['running', 'queued'] } } });
  });

  it.each([
    ['an active goal', { goal: 1 }],
    ['an open todo', { todo: 2 }],
    ['a live/queued run', { run: 1 }],
    ['a live watched resource (infra-monitor carve-out)', { watched: 1 }],
  ])('is NOT dormant with %s', async (_label, over: any) => {
    if (over.goal) mockGoalCount.mockResolvedValue(over.goal);
    if (over.todo) mockTodoCount.mockResolvedValue(over.todo);
    if (over.run) mockRunCount.mockResolvedValue(over.run);
    if (over.watched) mockWatchedCount.mockResolvedValue(over.watched);
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(false);
    expect(v.reason).toContain('live work');
  });

  it('watched resources count only while LIVE — reservationEndsAt null or in the future (the watchdog liveness rule)', async () => {
    await evaluateProjectDormancy('p1');
    const where = mockWatchedCount.mock.calls[0]?.[0]?.where;
    expect(where?.projectId).toBe('p1');
    expect(where?.OR).toEqual([{ reservationEndsAt: null }, { reservationEndsAt: { gt: expect.any(Date) } }]);
  });

  it('an ARCHIVED project is dormant without any signal queries', async () => {
    mockProjectFindUnique.mockResolvedValue({ ...PROJECT, archivedAt: new Date('2026-09-01') });
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(true);
    expect(v.reason).toContain('archived');
    expect(mockGoalCount).not.toHaveBeenCalled();
  });

  it('a MISSING project row fails OPEN (never blocks a wake on missing data)', async () => {
    mockProjectFindUnique.mockResolvedValue(null);
    expect((await evaluateProjectDormancy('p1')).dormant).toBe(false);
  });

  it('a query failure fails OPEN with a logged warning', async () => {
    mockGoalCount.mockRejectedValue(new Error('db down'));
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(false);
    expect(v.reason).toContain('fail-open');
  });
});

/* ====================================================================
 * Ticket 37fa747d (2026-09-24) — SUPERVISION SCAFFOLDING is not project
 * work: the project-supervisor lane's OWN live run (and its spawned
 * children's) must never be the liveness that keeps a 0-goal project "not
 * dormant". Replay: canlegal-bench's goal cd5fa541 auto-completed 01:16Z →
 * the fire-time gate parked sweep 0e4f0382 (~01:2xZ) → the ALARM-class park
 * event woke the supervisor lane, whose live self-audit child kept
 * liveRuns ≥ 1 → ensureProjectSweepSchedule's toggle-ON resume re-armed the
 * parked row at 01:40:03.772Z ('resumed:project_sweep_ensure', next
 * 02:40:03.772Z) — the park defeated by the machinery's own wake. Pins:
 * supervisor-lane runs + supervisor-spawned descendant runs are excluded
 * (reported as scaffoldingRuns, never in the dormant decision); a run on a
 * NON-scaffolding chat still keeps the project live.
 * ==================================================================== */
describe('37fa747d — supervision scaffolding runs are not project liveness', () => {
  // The default mockChatFindMany returns [{ id: 'c1' }, { id: 'c2' }]; these
  // tests override with explicit id/isProjectSupervisor/parentChatId shapes.
  beforeEach(() => {
    mockChatFindMany.mockReset();
    mockChatFindMany.mockResolvedValue([]);
    mockGoalCount.mockResolvedValue(0);
    mockTodoCount.mockResolvedValue(0);
    mockWatchedCount.mockResolvedValue(0);
  });

  it('the supervisor lane chat id is EXCLUDED from the liveRuns query (its own sweep/wake/self-audit runs are scaffolding, not work)', async () => {
    mockChatFindMany.mockResolvedValue([
      { id: 'c1', isProjectSupervisor: false, parentChatId: null },
      { id: 'sup1', isProjectSupervisor: true, parentChatId: null },
    ]);
    // The canlegal-bench shape: every live run sits on the SUPERVISOR lane
    // (its sweep/wake/self-audit), none on work chats — route the count mock
    // by the query's sessionId.in so each query sees its own truth.
    mockRunCount.mockImplementation(async ({ where }: any) =>
      (where?.sessionId?.in ?? []).includes('sup1') ? 1 : 0);
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(true);
    expect(v.signals.liveRuns).toBe(0);
    // The scaffolding count is reported for observability…
    expect(v.signals.scaffoldingRuns).toBe(1);
    // …and the dormant reason names the exclusion so sweeps can see the loop.
    expect(v.reason).toContain('supervision run(s) on the project-supervisor lane excluded as scaffolding (37fa747d)');
    // Two run-count queries: the WORK-chat query (never the lane id)…
    expect(mockRunCount.mock.calls[0][0]?.where?.sessionId?.in).toEqual(['c1']);
    // …and the scaffolding query (the lane id).
    expect(mockRunCount.mock.calls[1][0]?.where?.sessionId?.in).toEqual(['sup1']);
  });

  it('runs on a chat the supervisor lane SPAWNED (parentChatId = lane) are excluded too — the canlegal-bench replay (self-audit child live 01:16–01:48Z)', async () => {
    mockChatFindMany.mockResolvedValue([
      { id: 'c1', isProjectSupervisor: false, parentChatId: null },
      { id: 'sup1', isProjectSupervisor: true, parentChatId: null },
      { id: 'child1', isProjectSupervisor: false, parentChatId: 'sup1' },
    ]);
    mockRunCount.mockImplementation(async ({ where }: any) =>
      (where?.sessionId?.in ?? []).includes('child1') ? 1 : 0);
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(true);
    expect(v.signals.liveRuns).toBe(0);
    expect(v.signals.scaffoldingRuns).toBe(1);
    // Transitive: a grandchild (parent = child1) joins the scaffolding set.
    mockChatFindMany.mockResolvedValue([
      { id: 'c1', isProjectSupervisor: false, parentChatId: null },
      { id: 'sup1', isProjectSupervisor: true, parentChatId: null },
      { id: 'child1', isProjectSupervisor: false, parentChatId: 'sup1' },
      { id: 'grand1', isProjectSupervisor: false, parentChatId: 'child1' },
    ]);
    mockRunCount.mockClear();
    const v2 = await evaluateProjectDormancy('p1');
    expect(v2.dormant).toBe(true);
    expect(v2.signals.liveRuns).toBe(0);
    expect(v2.signals.scaffoldingRuns).toBe(1);
    // The work-chat query never names a scaffolding descendant:
    expect(mockRunCount.mock.calls[0][0]?.where?.sessionId?.in).toEqual(['c1']);
    expect(mockRunCount.mock.calls[1][0]?.where?.sessionId?.in).toEqual(['sup1', 'child1', 'grand1']);
  });

  it("a run on a NON-scaffolding chat (owner session / another lane's child) still keeps the project LIVE — the gate keeps its real-work rule", async () => {
    mockChatFindMany.mockResolvedValue([
      { id: 'c1', isProjectSupervisor: false, parentChatId: null },
      { id: 'sup1', isProjectSupervisor: true, parentChatId: null },
      { id: 'otherchild', isProjectSupervisor: false, parentChatId: 'somewhereelse' },
    ]);
    mockRunCount.mockResolvedValue(1);
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(false);
    expect(v.signals.liveRuns).toBe(1);
    expect(v.reason).toContain('live work');
    const runWhere = mockRunCount.mock.calls[0]?.[0]?.where;
    expect(runWhere?.sessionId?.in).toEqual(['c1', 'otherchild']);
  });

  it('a project with NO supervisor lane behaves exactly as before (all chats are work chats)', async () => {
    mockChatFindMany.mockResolvedValue([
      { id: 'c1', isProjectSupervisor: false, parentChatId: null },
      { id: 'c2', isProjectSupervisor: false, parentChatId: null },
    ]);
    mockRunCount.mockResolvedValue(2);
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(false);
    expect(v.signals.liveRuns).toBe(2);
    expect(v.signals.scaffoldingRuns).toBeUndefined();
    expect(mockRunCount).toHaveBeenCalledTimes(1);
    const runWhere = mockRunCount.mock.calls[0]?.[0]?.where;
    expect(runWhere?.sessionId?.in).toEqual(['c1', 'c2']);
  });
});

describe('evaluateScheduleDormancy — the schedule-level carve-outs', () => {
  it("an owner-authored schedule (promptSetBy 'user') is explicit owner instruction — never gated, no DB reads", async () => {
    const v = await evaluateScheduleDormancy('c1', 'user');
    expect(v.dormant).toBe(false);
    expect(v.reason).toContain('owner');
    expect(mockChatFindUnique).not.toHaveBeenCalled();
  });

  it('a legacy NULL promptSetBy (predates the column) is owner-authored — never gated', async () => {
    expect((await evaluateScheduleDormancy('c1', null)).dormant).toBe(false);
    expect(mockChatFindUnique).not.toHaveBeenCalled();
  });

  it('a chat with NO project is not project work — the gate does not apply', async () => {
    mockChatFindUnique.mockResolvedValue({ id: 'c1', projectId: null });
    const v = await evaluateScheduleDormancy('c1', 'machine');
    expect(v.dormant).toBe(false);
    expect(v.reason).toContain('no project');
    expect(mockProjectFindUnique).not.toHaveBeenCalled();
  });

  it('a machine schedule on a dormant project IS gated', async () => {
    const v = await evaluateScheduleDormancy('c1', 'machine');
    expect(v.dormant).toBe(true);
    expect(v.projectId).toBe('p1');
  });

  it('a system schedule on a project with live work is NOT gated', async () => {
    mockGoalCount.mockResolvedValue(1);
    expect((await evaluateScheduleDormancy('c1', 'system')).dormant).toBe(false);
  });

  it('a missing chat row fails OPEN', async () => {
    mockChatFindUnique.mockResolvedValue(null);
    expect((await evaluateScheduleDormancy('c1', 'machine')).dormant).toBe(false);
  });
});

describe('the parked:dormant marker', () => {
  it('is the shared cancel-class lastStatus for auto-parked rows', () => {
    expect(DORMANT_LAST_STATUS).toBe('parked:dormant');
  });
});

describe('evaluateAccountDormancy — the FLEET sweep gate (autonomy loop #18: four foreign-account supervisors swept dormant accounts, 17 no-op wakes/day)', () => {
  it('an account with no run in 7 days and no live project work or other enabled schedules is DORMANT; the reason names the horizon and the resume path', async () => {
    const v = await evaluateAccountDormancy('u-idle', { excludeChatId: 'sup-1' });
    expect(v.dormant).toBe(true);
    expect(v.projectId).toBeNull();
    expect(v.reason).toContain('no coding run in 7 days');
    expect(v.reason).toContain('sweep is parked');
    expect(v.signals).toEqual({ activeGoals: 0, openTodos: 0, liveRuns: 0, watchedResources: 0, otherSchedules: 0 });
    expect(FLEET_DORMANT_AFTER_MS).toBe(7 * 24 * 3600 * 1000);
  });

  it('queries runs by the account relation over the 7-day cutoff, project work over the account\'s projects, and schedules EXCLUDING the supervisor chat', async () => {
    const before = Date.now();
    await evaluateAccountDormancy('u-idle', { excludeChatId: 'sup-1' });
    const runArg = mockRunCount.mock.calls[0][0];
    expect(runArg.where.state).toEqual({ userId: 'u-idle' });
    const cutoff = runArg.where.createdAt.gte.getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(FLEET_DORMANT_AFTER_MS - 5_000);
    expect(before - cutoff).toBeLessThanOrEqual(FLEET_DORMANT_AFTER_MS + 5_000);
    expect(mockProjectFindMany).toHaveBeenCalledWith({ where: { userId: 'u-idle', archivedAt: null }, select: { id: true }, take: 500 });
    expect(mockGoalCount).toHaveBeenCalledWith({ where: { projectId: { in: ['p1'] }, status: { in: ['active', 'blocked'] } } });
    expect(mockTodoCount).toHaveBeenCalledWith({ where: { projectId: { in: ['p1'] }, status: { in: ['pending', 'in_progress', 'blocked'] } } });
    expect(mockScheduleCount).toHaveBeenCalledWith({ where: { userId: 'u-idle', enabled: true, kind: 'recurring', sessionId: { not: 'sup-1' } } });
  });

  it('any live signal keeps the account awake: a recent run, an active goal, or an enabled schedule on another chat', async () => {
    mockRunCount.mockResolvedValueOnce(1);
    expect((await evaluateAccountDormancy('u1')).dormant).toBe(false);
    mockGoalCount.mockResolvedValueOnce(2);
    expect((await evaluateAccountDormancy('u1')).dormant).toBe(false);
    mockScheduleCount.mockResolvedValueOnce(3);
    const v = await evaluateAccountDormancy('u1');
    expect(v.dormant).toBe(false);
    expect(v.reason).toContain('3 enabled schedule(s) elsewhere');
  });

  it('no projects → the project-work counts are skipped (zero) and only runs + schedules decide', async () => {
    mockProjectFindMany.mockResolvedValueOnce([]);
    const v = await evaluateAccountDormancy('u1');
    expect(v.dormant).toBe(true);
    expect(mockGoalCount).not.toHaveBeenCalled();
    expect(mockWatchedCount).not.toHaveBeenCalled();
  });

  it('a query error fails OPEN', async () => {
    mockRunCount.mockRejectedValueOnce(new Error('db down'));
    const v = await evaluateAccountDormancy('u1');
    expect(v.dormant).toBe(false);
    expect(v.reason).toContain('fail-open');
  });

  it('evaluateScheduleDormancy routes a projectless SUPERVISOR chat to the account gate (system sweep) and leaves other projectless chats ungated', async () => {
    mockChatFindUnique.mockResolvedValueOnce({ id: 'sup-1', projectId: null, isSupervisor: true, userId: 'u-idle' });
    const v = await evaluateScheduleDormancy('sup-1', 'system');
    expect(v.dormant).toBe(true);
    expect(mockScheduleCount).toHaveBeenCalledWith({ where: { userId: 'u-idle', enabled: true, kind: 'recurring', sessionId: { not: 'sup-1' } } });
    mockChatFindUnique.mockResolvedValueOnce({ id: 'c9', projectId: null, isSupervisor: false, userId: 'u-idle' });
    const w = await evaluateScheduleDormancy('c9', 'machine');
    expect(w.dormant).toBe(false);
    expect(w.reason).toContain('no project');
    // the owner-authored carve-out still wins before any lookup
    mockChatFindUnique.mockClear();
    expect((await evaluateScheduleDormancy('sup-1', 'user')).dormant).toBe(false);
    expect(mockChatFindUnique).not.toHaveBeenCalled();
  });
});

/**
 * audit 2026-10-06 T4-4 (spark.md F3, others.md F10): an EMPTY ledger stays
 * live while an owner directive is open on the supervisor's ledger, an alarm
 * fired from a WORK chat in the last 6 h, a goal was closed suspect in the
 * last 7 d, or an owner-armed recurring lane schedule is live. Read only when
 * the ledger says dormant; scaffolding (the supervisor lane) never counts for
 * alarms / lane schedules. Kill switch DORMANCY_LIVE_SIGNALS_DISABLED=1.
 */
describe('T4-4 — live-work signals beyond the goal/todo ledger', () => {
  beforeEach(() => {
    mockChatFindMany.mockResolvedValue([{ id: 'sup', isProjectSupervisor: true }, { id: 'c1' }]);
  });
  const ledger = (directives: any[]) => ({ state: { directives, archived: [], dispatches: [], projects: [], notes: '', refutations: [] } });

  it('an open OWNER directive on the supervisor ledger keeps the project live (a supervisor-written one does not)', async () => {
    mockSupStateFindUnique.mockResolvedValue(ledger([{ id: 'd1', text: 'hmm now on the ui everything is down', at: new Date().toISOString(), status: 'open', origin: 'owner' }]));
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(false);
    expect(v.signals.ownerDirectives).toBe(1);
    expect(v.reason).toContain('1 open owner directive(s)');

    mockSupStateFindUnique.mockResolvedValue(ledger([{ id: 'd2', text: 'HOLD until green', at: new Date().toISOString(), status: 'open' }]));
    expect((await evaluateProjectDormancy('p1')).dormant).toBe(true);
  });

  it('an alarm from a WORK chat in the last 6 h keeps it live; the supervisor\'s own alarm does not', async () => {
    mockHookEventFindMany.mockResolvedValue([{ eventType: 'run_failed', payload: { sourceChatId: 'sup', runId: 'r0' } }]);
    expect((await evaluateProjectDormancy('p1')).dormant).toBe(true);
    mockHookEventFindMany.mockResolvedValue([
      { eventType: 'run_failed', payload: { sourceChatId: 'c1', runId: 'r1' } },
      { eventType: 'run_failed', payload: { sourceChatId: 'c1', runId: 'r1' } }, // same event, two hooks
    ]);
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(false);
    expect(v.signals.recentAlarms).toBe(1);
    expect(mockHookEventFindMany.mock.calls[1][0].where.eventType).toEqual({ in: ['run_failed', 'goal_blocked', 'attention_needed'] });
  });

  it('a goal closed SUSPECT in the last 7 d keeps it live (HOLD progress note)', async () => {
    mockGoalFindMany.mockResolvedValue([{ id: 'g1', title: 'Chain tail lands', progressNote: 'HOLD: chain tail lands as ONE follow-up PR when wrapper exits', premises: null }]);
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(false);
    expect(v.signals.doneSuspectGoals).toBe(1);
  });

  it('an OWNER-armed recurring lane schedule keeps it live', async () => {
    mockScheduleCount.mockImplementation(async (args: any) => (args?.where?.OR ? 1 : 0));
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(false);
    expect(v.signals.ownerLaneSchedules).toBe(1);
    expect(mockScheduleCount.mock.calls[0][0].where).toMatchObject({ sessionId: { in: ['c1'] }, enabled: true, kind: 'recurring' });
  });

  it('the extra reads run ONLY when the ledger already says dormant', async () => {
    mockGoalCount.mockResolvedValue(1);
    await evaluateProjectDormancy('p1');
    expect(mockHookEventFindMany).not.toHaveBeenCalled();
    expect(mockSupStateFindUnique).not.toHaveBeenCalled();
  });

  it('kill switch DORMANCY_LIVE_SIGNALS_DISABLED=1 → the ledger-only verdict', async () => {
    process.env.DORMANCY_LIVE_SIGNALS_DISABLED = '1';
    mockSupStateFindUnique.mockResolvedValue(ledger([{ id: 'd1', text: 'down', at: new Date().toISOString(), status: 'open', origin: 'owner' }]));
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(true);
    expect(v.signals).toEqual({ activeGoals: 0, openTodos: 0, liveRuns: 0, watchedResources: 0 });
    expect(mockSupStateFindUnique).not.toHaveBeenCalled();
  });
});

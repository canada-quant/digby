/**
 * Stopped-schedule decision cards (SA0906) — the filing half, tested directly
 * against mocked prisma + the owner-questions boundary.
 *
 * The cry-wolf guard is the core contract (prod replay b95e9df6: self-renewing
 * schedule_self chains retire a spent link per run budget and arm a fresh
 * successor — 10 exhausted links + 1 enabled row + live runs is a HEALTHY
 * lane): a decision files ONLY for a recurring schedule whose lane heartbeat
 * is PROVABLY dead (no enabled successor, no agent run in the trailing 6h) on
 * a project with an ACTIVE goal, exactly once per schedule (dedupe), and never
 * for owner-explicit stops (the callers gate those — see
 * schedule.service.test.ts).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockScheduleFindUnique = jest.fn();
const mockScheduleCount = jest.fn();
const mockRunCount = jest.fn();
const mockRunFindFirst = jest.fn();
const mockChatFindUnique = jest.fn();
const mockGoalFindMany = jest.fn();
const mockTodoCount = jest.fn();
const mockTodoFindMany = jest.fn();
const mockTicketFindMany = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: {
      findUnique: (...a: any[]) => mockScheduleFindUnique(...a),
      count: (...a: any[]) => mockScheduleCount(...a),
    },
    agentRun: { count: (...a: any[]) => mockRunCount(...a), findFirst: (...a: any[]) => mockRunFindFirst(...a) },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    projectGoal: { findMany: (...a: any[]) => mockGoalFindMany(...a) },
    projectTodo: { count: (...a: any[]) => mockTodoCount(...a), findMany: (...a: any[]) => mockTodoFindMany(...a) },
    userFeatureRequest: { findMany: (...a: any[]) => mockTicketFindMany(...a) },
  },
}));

// The owner-questions boundary (dynamic import in the module): the real marker
// format is re-pinned here so the filed context stays greppable by the
// session-scoped auto-resolve.
const mockFlagOwnerQuestion = jest.fn();
const mockHasOpenStoppedScheduleDecisionForChat = jest.fn(async (..._a: any[]) => false);
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  flagOwnerQuestion: (...a: any[]) => mockFlagOwnerQuestion(...a),
  hasOpenStoppedScheduleDecisionForChat: (...a: any[]) => mockHasOpenStoppedScheduleDecisionForChat(...a),
  stoppedScheduleMarker: (id: string) => `[stopped-schedule:${id}]`,
}));

// Gate flip 2026-09-11 (owner: full steam): the default is OBSERVE-ONLY — a
// genuinely-dead lane logs ONE info line and files nothing. The card path is
// opt-in (STOPPED_SCHEDULE_CARDS=1), so the card-body contracts below run
// under the opt-in; the default is pinned in its own describe.

import {
  CLOSED_TICKET_STATUSES,
  LANE_ACTIVITY_WINDOW_MS,
  MAX_GOALS_IN_DECISION,
  STOPPED_ALERT_RECHECK_DELAY_MS,
  isLaneAlive,
  maybeFileStoppedScheduleDecision,
  queueStoppedScheduleAlert,
  referencedTicketsAllClosed,
} from './stopped-schedule-alert';
import logger from '../../../utils/logger';

const deadLaneLines = (): string[] => (logger.info as jest.Mock).mock.calls.map((c: any[]) => String(c[0])).filter((line) => line.includes('detected dead lane'));

const SCHEDULE_ID = '0242af66-1111-2222-3333-444455556666';
const SESSION = 'sess-spark-1';

const stoppedRow = (over: Partial<Record<string, any>> = {}) => ({
  id: SCHEDULE_ID, sessionId: SESSION, userId: 'u1', prompt: 'hourly W4A16 kernel sweep',
  kind: 'recurring', intervalSec: 3600, nextRunAt: new Date(), enabled: false,
  runsCount: 8, maxRuns: 8, expiresAt: new Date(Date.now() + 86400_000),
  lastFiredAt: new Date(Date.now() - 30 * 60_000), lastStatus: 'started', createdAt: new Date(),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STOPPED_SCHEDULE_CARDS = '1'; // opt-in: the card contracts below stay pinned
  mockScheduleFindUnique.mockResolvedValue(stoppedRow());
  mockScheduleCount.mockResolvedValue(0); // no enabled successor
  mockRunCount.mockResolvedValue(0);      // no trailing-6h runs
  mockChatFindUnique.mockResolvedValue({ title: 'Spark cluster', userId: 'u1', projectId: 'proj-spark' });
  mockGoalFindMany.mockResolvedValue([{ id: 'g1', title: 'W4A16 kernel optimization program' }]);
  mockTicketFindMany.mockResolvedValue([]);
  mockTodoCount.mockResolvedValue(2);
  mockTodoFindMany.mockResolvedValue([]); // no todos assigned to the chat (3ce5f6d0 finished-lane check falls through)
  mockRunFindFirst.mockResolvedValue(null); // no completed run needed unless a test arms the self-stop path
  mockHasOpenStoppedScheduleDecisionForChat.mockResolvedValue(false);
  mockFlagOwnerQuestion.mockResolvedValue({
    kind: 'created',
    question: { id: 'oq_1', chatId: SESSION, userId: 'u1', question: 'q', context: 'c', status: 'open', answer: null, createdAt: new Date(), resolvedAt: null },
  });
});

afterEach(() => {
  jest.useRealTimers();
  delete process.env.STOPPED_SCHEDULE_CARDS;
});

describe('gate flip 2026-09-11 — DEFAULT is observe-only (no owner card)', () => {
  beforeEach(() => { delete process.env.STOPPED_SCHEDULE_CARDS; });

  it('a genuinely-dead lane on an open goal logs ONE dead-lane line and files NOTHING', async () => {
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'observe_only' });
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
    expect(mockHasOpenStoppedScheduleDecisionForChat).not.toHaveBeenCalled(); // no card ⇒ no card dedupe read
    expect(deadLaneLines()).toHaveLength(1);
    expect(deadLaneLines()[0]).toContain(`schedule ${SCHEDULE_ID} (max_runs) on chat ${SESSION} serving 1 open goal(s)`);
  });

  it('the cause is re-derived from the live row (expired hint on a capped row logs max_runs; a machine cancel logs cancelled)', async () => {
    await maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'expired'); // runsCount 8 >= maxRuns 8
    expect(deadLaneLines()[0]).toContain(`(max_runs)`);
    (logger.info as jest.Mock).mockClear();
    mockScheduleFindUnique.mockResolvedValue(stoppedRow({ runsCount: 3, maxRuns: 500, lastStatus: 'cancelled' }));
    await maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'cancelled');
    expect(deadLaneLines()[0]).toContain(`(cancelled)`);
  });

  it('the cry-wolf guard still runs FIRST — a live lane / no open goal logs no dead-lane line either', async () => {
    mockScheduleCount.mockResolvedValue(1); // enabled successor = alive
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs')).resolves.toEqual({ filed: false, reason: 'lane_alive' });
    mockScheduleCount.mockResolvedValue(0);
    mockGoalFindMany.mockResolvedValue([]);
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs')).resolves.toEqual({ filed: false, reason: 'no_active_goals' });
    expect(deadLaneLines()).toHaveLength(0);
  });

  it('STOPPED_SCHEDULE_CARDS=1 restores the owner card', async () => {
    process.env.STOPPED_SCHEDULE_CARDS = '1';
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs')).resolves.toEqual({ filed: true, questionId: 'oq_1' });
  });
});

describe('isLaneAlive', () => {
  it('an enabled successor schedule = alive (the run probe is not even paid)', async () => {
    mockScheduleCount.mockResolvedValue(1);
    await expect(isLaneAlive(SESSION, SCHEDULE_ID)).resolves.toBe(true);
    // v1#12: only RECURRING enabled rows count as successors.
    expect(mockScheduleCount).toHaveBeenCalledWith({
      where: { sessionId: SESSION, enabled: true, kind: 'recurring', id: { not: SCHEDULE_ID } },
    });
    expect(mockRunCount).not.toHaveBeenCalled();
  });

  it('a run created inside the trailing 6h window = alive', async () => {
    mockRunCount.mockResolvedValue(3);
    await expect(isLaneAlive(SESSION, SCHEDULE_ID)).resolves.toBe(true);
    const where = mockRunCount.mock.calls[0][0].where;
    expect(where.sessionId).toBe(SESSION);
    const gte = where.createdAt.gte.getTime();
    expect(Math.abs(gte - (Date.now() - LANE_ACTIVITY_WINDOW_MS))).toBeLessThan(5_000);
  });

  it('no successor + no recent runs = provably dead (false)', async () => {
    await expect(isLaneAlive(SESSION, SCHEDULE_ID)).resolves.toBe(false);
  });

  it('a read error = UNKNOWN (null), never a throw', async () => {
    mockScheduleCount.mockRejectedValue(new Error('db down'));
    await expect(isLaneAlive(SESSION, SCHEDULE_ID)).resolves.toBeNull();
  });
});

describe('maybeFileStoppedScheduleDecision — the genuinely-dead lane files once (opt-in STOPPED_SCHEDULE_CARDS=1)', () => {
  it('files the decision on the SESSION chat with the resume/leave-stopped body', async () => {
    const res = await maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs');
    expect(res).toEqual({ filed: true, questionId: 'oq_1' });
    expect(mockFlagOwnerQuestion).toHaveBeenCalledTimes(1);
    const arg = mockFlagOwnerQuestion.mock.calls[0][0];
    // Attribution: the session chat that owns the schedule (its answer relays
    // back to a chat holding schedule_self/update_schedule for its cadences).
    expect(arg.chatId).toBe(SESSION);
    expect(arg.userId).toBe('u1');
    // Title: chat title + the short schedule id (per-schedule uniqueness keeps
    // two stopped schedules on one chat from colliding in the exact-question
    // dedupe, and gives the woken run a resolvable id prefix).
    expect(arg.question).toBe(`Resume the stopped schedule ${SCHEDULE_ID.slice(0, 8)} on "Spark cluster"?`);
    // Context: the machine-readable marker LEADS (truncation-safe), then what
    // stopped, the goal it was serving, and the explicit choices.
    expect(arg.context.startsWith(`[stopped-schedule:${SCHEDULE_ID}]`)).toBe(true);
    expect(arg.context).toContain('hit its 8-run cap');
    expect(arg.context).toContain('every 60 min');
    expect(arg.context).toContain('runs used: 8/8');
    expect(arg.context).toContain('last status: started');
    expect(arg.context).toContain('"W4A16 kernel optimization program" (2 todos remaining)');
    expect(arg.context).toContain('Reply "resume" to restart it');
    expect(arg.context).toContain('"leave stopped"');
    // Remaining-todo count excludes only done rows.
    expect(mockTodoCount).toHaveBeenCalledWith({ where: { goalId: 'g1', status: { not: 'done' } } });
  });

  it('re-derives cap-vs-expiry from the live row (a digest hint of expired on a capped row says max_runs)', async () => {
    await maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'expired'); // runsCount 8 >= maxRuns 8
    expect(mockFlagOwnerQuestion.mock.calls[0][0].context).toContain('hit its 8-run cap');
    mockFlagOwnerQuestion.mockClear();
    mockHasOpenStoppedScheduleDecisionForChat.mockResolvedValue(false);
    mockScheduleFindUnique.mockResolvedValue(stoppedRow({ runsCount: 3, maxRuns: 500, lastStatus: 'expired' }));
    await maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'expired');
    expect(mockFlagOwnerQuestion.mock.calls[0][0].context).toContain('reached its 30-day lifetime expiry');
  });

  it('a machine cancel keeps its cancelled phrasing', async () => {
    mockScheduleFindUnique.mockResolvedValue(stoppedRow({ runsCount: 3, maxRuns: 500, lastStatus: 'cancelled' }));
    await maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'cancelled');
    expect(mockFlagOwnerQuestion.mock.calls[0][0].context).toContain('was cancelled by a machine-triggered run');
  });

  it('caps the named goals and collapses the rest to +K more', async () => {
    mockGoalFindMany.mockResolvedValue(
      Array.from({ length: MAX_GOALS_IN_DECISION + 2 }, (_, i) => ({ id: `g${i}`, title: `Goal ${i}` })),
    );
    await maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs');
    const ctx = mockFlagOwnerQuestion.mock.calls[0][0].context;
    expect(ctx).toContain('+2 more');
    expect(mockTodoCount).toHaveBeenCalledTimes(MAX_GOALS_IN_DECISION);
  });
});

describe('maybeFileStoppedScheduleDecision — the cry-wolf guard (b95e9df6)', () => {
  it('an exhausted link with an ENABLED successor files NOTHING (self-renewing chain)', async () => {
    mockScheduleCount.mockResolvedValue(1); // e.g. 896e43d7, next fire 05:32
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'lane_alive' });
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('an exhausted link with runs in the trailing 6h files NOTHING (the lane is still working)', async () => {
    mockRunCount.mockResolvedValue(15);
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'lane_alive' });
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('UNKNOWN liveness (probe error) fails CLOSED — no card beats a cry-wolf card', async () => {
    mockRunCount.mockRejectedValue(new Error('db down'));
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'lane_unknown' });
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('a once-schedule never files', async () => {
    mockScheduleFindUnique.mockResolvedValue(stoppedRow({ kind: 'once', maxRuns: 1, runsCount: 1 }));
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'expired'))
      .resolves.toEqual({ filed: false, reason: 'not_recurring' });
  });

  it('a row re-enabled before the re-check never files (the stop was undone)', async () => {
    mockScheduleFindUnique.mockResolvedValue(stoppedRow({ enabled: true }));
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'still_enabled' });
  });

  it('a GC-ed row never files', async () => {
    mockScheduleFindUnique.mockResolvedValue(null);
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'not_found' });
  });

  it('a chat outside any project never files', async () => {
    mockChatFindUnique.mockResolvedValue({ title: 'Loose chat', userId: 'u1', projectId: null });
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'no_project' });
  });

  it('a project WITHOUT an active goal never files', async () => {
    mockGoalFindMany.mockResolvedValue([]);
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'no_active_goals' });
    // v1#11: BLOCKED goals count as open too (a fully-blocked project is
    // exactly the lane that needs its stopped cadence surfaced).
    expect(mockGoalFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'proj-spark', status: { in: ['active', 'blocked'] } },
    }));
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('dedupe (3ce5f6d0): an already-open stopped-schedule decision ON THIS CHAT files no second card', async () => {
    mockHasOpenStoppedScheduleDecisionForChat.mockResolvedValue(true);
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'already_open' });
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('a flag-layer dedupe (exact question already open) reports already_open too', async () => {
    mockFlagOwnerQuestion.mockResolvedValue({ kind: 'deduped', question: { id: 'oq_prev' } });
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'already_open' });
  });

  it('a refused flag (caps) reports flag_refused without throwing', async () => {
    mockFlagOwnerQuestion.mockResolvedValue({ kind: 'refused', refused: 'cap' });
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'flag_refused' });
  });

  it('any store failure degrades to { filed:false, reason:error } — NEVER a throw into a stop path', async () => {
    mockChatFindUnique.mockRejectedValue(new Error('db exploded'));
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'error' });
  });
});

describe('queueStoppedScheduleAlert — the delayed fast-lane re-check', () => {
  it('runs the filing check only AFTER the re-check delay (a chain that re-arms first never files)', async () => {
    jest.useFakeTimers();
    queueStoppedScheduleAlert(SCHEDULE_ID, 'max_runs');
    expect(mockScheduleFindUnique).not.toHaveBeenCalled(); // nothing at stop time
    await jest.advanceTimersByTimeAsync(STOPPED_ALERT_RECHECK_DELAY_MS - 1000);
    expect(mockScheduleFindUnique).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2000);
    expect(mockScheduleFindUnique).toHaveBeenCalledTimes(1); // the re-check ran
  });

  it('honors a delayMs override and never throws', async () => {
    jest.useFakeTimers();
    expect(() => queueStoppedScheduleAlert(SCHEDULE_ID, 'expired', { delayMs: 50 })).not.toThrow();
    await jest.advanceTimersByTimeAsync(60);
    expect(mockScheduleFindUnique).toHaveBeenCalledTimes(1);
  });
});

/* ====================================================================
 * P3 remediation — v1#11: a project whose goals are ALL BLOCKED still
 * files (blocked goals ARE open work), and the decision body carries the
 * blockedReason so the owner sees what the lane waits on.
 * ==================================================================== */
describe('v1#11 — blocked goals count as open (blockedReason carried)', () => {
  it('files when the project has ONLY blocked goals, naming the block reason', async () => {
    mockGoalFindMany.mockResolvedValue([
      { id: 'g1', title: 'Ship the relay', status: 'blocked', blockedReason: 'waiting on SSH key restore' },
    ]);
    const res = await maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs');
    expect(res).toMatchObject({ filed: true });
    const arg = mockFlagOwnerQuestion.mock.calls[0][0];
    expect(arg.context).toContain('BLOCKED: waiting on SSH key restore');
    expect(arg.context).toContain('Ship the relay');
  });

  it('active goals render WITHOUT a blocked tag (mixed projects stay readable)', async () => {
    mockGoalFindMany.mockResolvedValue([
      { id: 'g1', title: 'Active goal', status: 'active', blockedReason: null },
    ]);
    await maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs');
    expect(mockFlagOwnerQuestion.mock.calls[0][0].context).not.toContain('BLOCKED:');
  });

  it('v1#12 — a pending ONE-SHOT row is NOT a successor: the lane still files', async () => {
    // isLaneAlive's successor arm is recurring-only; the run-activity arm
    // stays 0 here, so the decision files despite the enabled once-row.
    mockScheduleCount.mockResolvedValue(0); // recurring-scoped count sees none
    mockRunCount.mockResolvedValue(0);
    const res = await maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs');
    expect(res).toMatchObject({ filed: true });
    // and the count query was RECURRING-scoped (the whole point):
    expect(mockScheduleCount.mock.calls[0][0].where.kind).toBe('recurring');
  });
});

describe('goal ATTRIBUTION for machine-armed cadences (2026-09-11 — the burn-down resume cards #664 could not catch)', () => {
  // The crossmodel project always carries standing program goals created by
  // the Fleet Supervisor; a burn-down chat with NO assigned todos falls through
  // the finished-lane rule, and its finite "close loop for ticket X" follow-up
  // is not a heartbeat for those programs.
  const programGoals = [
    { id: 'g-prog-1', title: 'Fleet Autonomy Program', status: 'active', blockedReason: null, createdByChatId: 'chat-supervisor' },
    { id: 'g-prog-2', title: 'Mass-clear feedback queue', status: 'active', blockedReason: null, createdByChatId: 'chat-supervisor' },
  ];
  const machineRow = (over: Record<string, any> = {}) => stoppedRow({
    promptSetBy: 'machine', runsCount: 6, maxRuns: 6,
    prompt: 'STEER-KEEPER + close loop for mishap ticket 9a9911bb (evidence guard, session 619a1241).',
    ...over,
  });
  // projectGoal.findMany serves two reads: #664's served-goal status check
  // (where.id) and the project-wide goal list (where.projectId).
  const goalsByQuery = (served: any[], project: any[]) =>
    mockGoalFindMany.mockImplementation(async (q: any) => (q?.where?.id ? served : project));

  it('a machine-armed follow-up on a chat that serves NONE of the project goals files nothing (no_active_goals)', async () => {
    mockScheduleFindUnique.mockResolvedValue(machineRow());
    mockTodoFindMany.mockResolvedValue([]); // no assigned todos → finished-lane rule falls through
    goalsByQuery([], programGoals);
    mockTodoCount.mockResolvedValue(0); // no open todo assigned to this chat on either goal
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'no_active_goals' });
    // The attribution read is per goal, scoped to THIS chat's open todos.
    expect(mockTodoCount).toHaveBeenCalledWith({ where: { goalId: 'g-prog-1', assigneeChatId: SESSION, status: { not: 'done' } } });
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('a machine-armed cadence whose chat CREATED an open goal still files (a real dead lane)', async () => {
    mockScheduleFindUnique.mockResolvedValue(machineRow({ prompt: 'hourly W4A16 kernel sweep' }));
    mockTodoFindMany.mockResolvedValue([]);
    goalsByQuery([], [...programGoals, { id: 'g-mine', title: 'W4A16 kernel program', status: 'active', blockedReason: null, createdByChatId: SESSION }]);
    mockTodoCount.mockImplementation(async (q: any) => (q.where.assigneeChatId ? 0 : 3));
    const res = await maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs');
    expect(res).toEqual({ filed: true, questionId: 'oq_1' });
    // …and the body names ONLY the goal this chat serves, not the programs.
    const ctx = mockFlagOwnerQuestion.mock.calls[0][0].context as string;
    expect(ctx).toContain('"W4A16 kernel program"');
    expect(ctx).not.toContain('Fleet Autonomy Program');
  });

  it('a machine-armed cadence whose chat holds an OPEN todo on a program goal still files', async () => {
    mockScheduleFindUnique.mockResolvedValue(machineRow({ prompt: 'batch dispatch sweep' }));
    mockTodoFindMany.mockResolvedValue([{ goalId: 'g-prog-2' }]); // #664 served-goal read: the goal is still active…
    goalsByQuery([{ status: 'active' }], programGoals);           // …so the finished-lane rule does not fire
    mockTodoCount.mockImplementation(async (q: any) => (q.where.goalId === 'g-prog-2' ? 1 : 0));
    const res = await maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs');
    expect(res).toMatchObject({ filed: true });
    const ctx = mockFlagOwnerQuestion.mock.calls[0][0].context as string;
    expect(ctx).toContain('"Mass-clear feedback queue"');
    expect(ctx).not.toContain('"Fleet Autonomy Program"');
  });

  it('an OWNER-armed cadence (promptSetBy user) and a legacy unstamped row keep the project-wide read', async () => {
    mockTodoFindMany.mockResolvedValue([]);
    goalsByQuery([], programGoals);
    mockTodoCount.mockResolvedValue(0);
    mockScheduleFindUnique.mockResolvedValue(stoppedRow({ promptSetBy: 'user' }));
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs')).resolves.toMatchObject({ filed: true });
    mockFlagOwnerQuestion.mockClear();
    mockScheduleFindUnique.mockResolvedValue(stoppedRow({ promptSetBy: null }));
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs')).resolves.toMatchObject({ filed: true });
    // No per-chat attribution reads were paid on either path.
    expect(mockTodoCount.mock.calls.every((c: any[]) => !c[0].where.assigneeChatId)).toBe(true);
  });

  it('a machine-armed follow-up naming only CLOSED tickets is purpose_complete even when the chat serves a live goal', async () => {
    mockScheduleFindUnique.mockResolvedValue(machineRow({ prompt: 'Quiet-window lifecycle finisher for ticket db25c401 and mishap ticket 4DF4BB41 — all done.' }));
    mockTodoFindMany.mockResolvedValue([]);
    goalsByQuery([], [{ id: 'g-mine', title: 'Ticket burn-down', status: 'active', blockedReason: null, createdByChatId: SESSION }]);
    mockTicketFindMany.mockResolvedValue([{ id: 'db25c401-…', status: 'done' }, { id: '4df4bb41-…', status: 'resolved' }]);
    await expect(maybeFileStoppedScheduleDecision(SCHEDULE_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'purpose_complete' });
    // Case-insensitive, de-duplicated prefix lookup.
    expect(mockTicketFindMany.mock.calls[0][0].where.OR).toEqual([{ id: { startsWith: 'db25c401' } }, { id: { startsWith: '4df4bb41' } }]);
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('an OPEN referenced ticket, an unknown ref, a prompt with no ticket, or a ticket-table read error never suppresses', async () => {
    const prisma = (await import('../../../config/database')).default as any;
    mockTicketFindMany.mockResolvedValue([{ id: 'a', status: 'done' }, { id: 'b', status: 'open' }]);
    expect(await referencedTicketsAllClosed(prisma, 'ticket aaaaaaaa and ticket bbbbbbbb')).toBe(false);
    mockTicketFindMany.mockResolvedValue([{ id: 'a', status: 'done' }]); // one of two refs resolved
    expect(await referencedTicketsAllClosed(prisma, 'ticket aaaaaaaa and ticket bbbbbbbb')).toBe(false);
    expect(await referencedTicketsAllClosed(prisma, 'hourly sweep, no ticket here')).toBe(false);
    expect(mockTicketFindMany).toHaveBeenCalledTimes(2); // no lookup without a ref
    mockTicketFindMany.mockRejectedValue(new Error('db down'));
    expect(await referencedTicketsAllClosed(prisma, 'ticket aaaaaaaa')).toBe(false);
    expect(CLOSED_TICKET_STATUSES).toEqual(expect.arrayContaining(['done', 'closed', 'resolved']));
  });
});

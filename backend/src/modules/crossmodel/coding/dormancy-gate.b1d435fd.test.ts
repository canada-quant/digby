/**
 * REPLAY TEST — ticket b1d435fd (owner directive 2026-09-18): "projects with
 * no goals or all-completed work must waste ZERO tokens on wakes — neither
 * project-supervisor sweeps nor session-level monitors." Tonight the stopped
 * spark-cluster project's cancelled sweep kept being resurrected by the
 * ensure/resume machinery (8th occurrence: schedule 2ee243ad cancelled
 * 00:44:17Z, active again by ~00:50Z; 96/480 daily firings burned on a
 * 0-goal, 0-todo project).
 *
 * This suite replays the violation against the NEW policy layer and pins the
 * fix on every arming/stay-active path the ticket names:
 *   1. createSchedule REFUSES a machine recurring arm on a dormant project
 *      (the arm path) — with the one-line reason.
 *   2. The firing sweeper AUTO-PARKS an enabled machine recurring row on a
 *      dormant project (the stay-active path): enabled:false, lastStatus
 *      'parked:dormant', cancelledBy 'machine', a schedule_disabled event
 *      carrying the reason, and a one-per-row owner notice. NO run starts.
 *   3. maybeRenewOnExhaustion refuses a successor onto a dormant project
 *      (the resurrection path).
 *   4. Bypasses: owner-authored arms, one-shots, and projectless chats are
 *      never gated; a project with live work fires normally.
 *   5. Doctrine pins: the fleet + project supervisor prompts and the two
 *      stale-firing cancel-class guards carry the dormant-by-design rule.
 *
 * Harness mirrors schedule.remediation-p7.test.ts (colocated mock-everything).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCreate = jest.fn();
const mockCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockUpdateMany = jest.fn(async (..._a: any[]) => ({ count: 1 }));
const mockDeleteMany = jest.fn(async (..._a: any[]) => ({ count: 0 }));
const mockScheduleFindUnique = jest.fn(async (..._a: any[]): Promise<any> => ({ enabled: true }));
const mockChatFindUnique = jest.fn();
const mockChatFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockChatUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockProjectFindUnique = jest.fn();
const mockMsgCreate = jest.fn(async (..._a: any[]) => ({}));
const mockGoalCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockTodoCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockWatchedCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-b1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockPromptHistoryCount = jest.fn(async (..._a: any[]): Promise<number> => 0);

// $transaction seam (ticket ae20da66): createSchedule wraps the create + the
// same-cadence collapse in ONE interactive transaction. The tx reuses this
// file's mock fns; the collapse's in-tx stale read gets its OWN mock defaulting
// to [] so pre-collapse tests behave exactly as before.
const mockStaleFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockTransaction = jest.fn(async (fn: any) =>
  typeof fn === 'function'
    ? fn({
        chatSchedule: {
          create: (...a: any[]) => mockCreate(...a),
          findMany: (...a: any[]) => mockStaleFindMany(...a),
          updateMany: (...a: any[]) => mockUpdateMany(...a),
        },
      })
    : Promise.all(fn));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: {
      create: (...a: any[]) => mockCreate(...a),
      count: (...a: any[]) => mockCount(...a),
      findMany: (...a: any[]) => mockFindMany(...a),
      findFirst: (...a: any[]) => mockFindFirst(...a),
      findUnique: (...a: any[]) => mockScheduleFindUnique(...a),
      update: (...a: any[]) => mockUpdate(...a),
      updateMany: (...a: any[]) => mockUpdateMany(...a),
      deleteMany: (...a: any[]) => mockDeleteMany(...a),
    },
    schedulePromptHistory: {
      findFirst: (...a: any[]) => mockPromptHistoryFindFirst(...a),
      count: (...a: any[]) => mockPromptHistoryCount(...a),
      create: jest.fn(async () => ({})),
    },
    agentRun: {
      findFirst: (...a: any[]) => mockRunFindFirst(...a),
      create: (...a: any[]) => mockRunCreate(...a),
      count: (...a: any[]) => mockRunCount(...a),
    },
    crossModelChat: {
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      findMany: (...a: any[]) => mockChatFindMany(...a),
      update: (...a: any[]) => mockChatUpdate(...a),
    },
    crossModelProject: { findUnique: (...a: any[]) => mockProjectFindUnique(...a) },
    crossModelMessage: { create: (...a: any[]) => mockMsgCreate(...a) },
    projectGoal: { count: (...a: any[]) => mockGoalCount(...a) },
    projectTodo: { count: (...a: any[]) => mockTodoCount(...a) },
    watchedResource: { count: (...a: any[]) => mockWatchedCount(...a) },
    $transaction: (fn: any) => mockTransaction(fn),
  },
}));

const mockRedisSet = jest.fn(async (..._a: any[]): Promise<any> => 'OK');
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: (...a: any[]) => mockRedisSet(...a),
    del: jest.fn(async () => 1),
    get: jest.fn(async () => null),
    getDel: jest.fn(async () => null),
    pTTL: jest.fn(async () => -1),
    incr: jest.fn(async () => 1),
    incrBy: jest.fn(async () => 1),
    expire: jest.fn(async () => {}),
    decr: jest.fn(async () => {}),
  },
}));

jest.mock('../platform/autonomy.service', () => ({
  __esModule: true,
  getChatAutonomy: jest.fn(async () => null),
}));

const mockEmitHookEvent = jest.fn(async (..._a: any[]) => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  sweepHookEvents: jest.fn(async () => {}),
}));

const mockStartScheduledRun = jest.fn(async (..._a: any[]): Promise<any> => ({ started: true }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
}));

const mockStartDetachedChatRun = jest.fn((..._a: any[]): string | null => 'chat:s1');
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatRunKey: (id: string) => `chat:${id}`,
}));

jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { WAKE_DELIVERED: 'wake_delivered', SWEEP_TICK: 'sweep_tick', SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', SCHEDULE_BUSY_ALARM: 'schedule_busy_alarm', PROBE_MISS: 'probe_miss', PROMPT_REWRITE_CAP: 'prompt_rewrite_cap' },
}));

jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: jest.fn(),
  maybeFileStoppedScheduleDecision: jest.fn(async () => ({ filed: false, reason: 'lane_alive' })),
}));

jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  resolveStoppedScheduleDecisionsForSession: jest.fn(async () => 0),
  flagOwnerQuestion: jest.fn(async () => ({ kind: 'created', question: { id: 'oq_b1' } })),
}));

jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: jest.fn(async () => ({ steps: [{ status: 'pending' }] })),
}));

jest.mock('./spend-cap.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./spend-cap.service')),
  checkSpendCap: jest.fn(async () => null),
  recordSpendCapSkip: jest.fn(async () => {}),
  maybeAskSpendCapQuestion: jest.fn(async () => {}),
  consumeSpendCapSkipNotice: jest.fn(async () => 0),
  restoreSpendCapSkipNotice: jest.fn(async () => {}),
}));

import * as fs from 'fs';
import * as path from 'path';
import { createSchedule, fireDue, maybeRenewOnExhaustion, setScheduleEnabledForChat } from './schedule.service';

const DORMANT_PROJECT = { id: 'p-dorm', name: 'Spark Cluster', archivedAt: null as any };
const dueRow = (over: any = {}) => ({
  id: 'sched-2ee243ad',
  sessionId: 'sess-spark',
  userId: 'u1',
  prompt: 'sweep the project',
  kind: 'recurring',
  intervalSec: 3600,
  nextRunAt: new Date(Date.now() - 60_000),
  expiresAt: new Date(Date.now() + 86_400_000),
  enabled: true,
  runsCount: 8,
  maxRuns: 500,
  busySkips: 0,
  promptSetBy: 'machine',
  renewOnExhaustion: null,
  requiredProbes: null,
  ...over,
});

/** Wire the prisma mock so session sess-spark sits in the DORMANT spark-cluster
 *  project (the ticket's replay): 0 goals, 0 todos, 0 runs, 0 watched. The
 *  chat row carries BOTH shapes its findUnique callers select: the dormancy
 *  gate's { id, projectId } AND fireScheduleTarget's
 *  { userId, mode, codingState } (codingState ⇒ the CODING fire path →
 *  startScheduledRun, mirroring remediation-p7's chat fixture). */
function mockDormantSparkProject(): void {
  mockChatFindUnique.mockImplementation(async ({ where }: any) =>
    where?.id === 'sess-spark'
      ? { id: 'sess-spark', userId: 'u1', mode: 'thinking', codingState: { id: 'cs1' }, parentChatId: null, projectId: 'p-dorm' }
      : null);
  mockChatFindMany.mockResolvedValue([{ id: 'sess-spark' }]);
  mockProjectFindUnique.mockImplementation(async ({ where }: any) =>
    where?.id === 'p-dorm' ? { ...DORMANT_PROJECT } : null);
  mockGoalCount.mockResolvedValue(0);
  mockTodoCount.mockResolvedValue(0);
  mockRunCount.mockResolvedValue(0);
  mockWatchedCount.mockResolvedValue(0);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCount.mockResolvedValue(0);
  mockFindMany.mockResolvedValue([]);
  mockFindFirst.mockResolvedValue(null);
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockStartScheduledRun.mockResolvedValue({ started: true });
  mockRedisSet.mockResolvedValue('OK');
  mockDormantSparkProject();
});

describe('1. the ARM path — createSchedule goal-gate (b1d435fd)', () => {
  it('REFUSES a machine recurring arm on the dormant spark-cluster project, with the one-line reason, and creates nothing', async () => {
    const res = await createSchedule({ sessionId: 'sess-spark', userId: 'u1', prompt: 'hourly sweep', kind: 'recurring', intervalSec: 3600, promptSetBy: 'machine' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('dormant');
    expect(res.error).toContain('Spark Cluster');
    expect(res.error).toContain('No schedule was created');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses a system-authored recurring arm the same way (the ensure/renewal authorship)', async () => {
    const res = await createSchedule({ sessionId: 'sess-spark', userId: 'u1', prompt: 'hourly sweep', kind: 'recurring', intervalSec: 3600, promptSetBy: 'system' });
    expect(res.ok).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('ARMS when the project has live work (an active goal)', async () => {
    mockGoalCount.mockResolvedValue(1);
    mockCreate.mockResolvedValue(dueRow({ id: 'sched-new' }));
    const res = await createSchedule({ sessionId: 'sess-spark', userId: 'u1', prompt: 'hourly sweep', kind: 'recurring', intervalSec: 3600, promptSetBy: 'machine' });
    expect(res.ok).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('never gates an OWNER-authored arm (explicit owner instruction) — even on a dormant project', async () => {
    mockCreate.mockResolvedValue(dueRow({ id: 'sched-owner', promptSetBy: 'user' }));
    const res = await createSchedule({ sessionId: 'sess-spark', userId: 'u1', prompt: 'hourly sweep', kind: 'recurring', intervalSec: 3600, promptSetBy: 'user' });
    expect(res.ok).toBe(true);
    expect(mockProjectFindUnique).not.toHaveBeenCalled();
  });

  it('never gates a ONE-SHOT arm on a dormant project (a deferred single fire is not a recurring wake)', async () => {
    mockCreate.mockResolvedValue(dueRow({ id: 'sched-once', kind: 'once', maxRuns: 1 }));
    const res = await createSchedule({ sessionId: 'sess-spark', userId: 'u1', prompt: 'check back once', kind: 'once', intervalSec: 3600, promptSetBy: 'machine' });
    expect(res.ok).toBe(true);
    expect(mockProjectFindUnique).not.toHaveBeenCalled();
  });

  it('never gates a chat with NO project (not project work)', async () => {
    mockChatFindUnique.mockResolvedValue({ id: 'sess-personal', projectId: null });
    mockCreate.mockResolvedValue(dueRow({ id: 'sched-np', sessionId: 'sess-personal' }));
    const res = await createSchedule({ sessionId: 'sess-personal', userId: 'u1', prompt: 'hourly note', kind: 'recurring', intervalSec: 3600, promptSetBy: 'machine' });
    expect(res.ok).toBe(true);
    expect(mockProjectFindUnique).not.toHaveBeenCalled();
  });
});

describe('2. the STAY-ACTIVE path — the sweeper auto-parks (b1d435fd)', () => {
  it("AUTO-PARKS the spark-cluster project's enabled machine recurring sweep instead of firing it (the 96/480 burn stops)", async () => {
    mockFindMany.mockResolvedValue([dueRow()]);
    await fireDue();
    // Parked, not fired:
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'sched-2ee243ad' },
      data: expect.objectContaining({ enabled: false, lastStatus: 'parked:dormant', cancelledBy: 'machine', disabledAt: expect.any(Date) }),
    });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    // The one-line reason rides the schedule_disabled event AND the owner notice:
    const disabledEvent = mockEmitHookEvent.mock.calls.find((c) => c[1] === 'schedule_disabled');
    expect(disabledEvent?.[2]).toContain('auto-parked');
    expect(disabledEvent?.[2]).toContain('dormant');
    expect(disabledEvent?.[3]).toEqual(expect.objectContaining({ scheduleId: 'sched-2ee243ad', reason: 'parked_dormant' }));
    expect(mockMsgCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ chatId: 'sess-spark', content: expect.stringContaining('auto-parked') }),
    });
    expect(mockMsgCreate.mock.calls[0][0].data.content).toContain('Spark Cluster');
  });

  it('FIRES normally when the project has live work (the gate is not a blanket stop)', async () => {
    mockGoalCount.mockResolvedValue(1);
    mockFindMany.mockResolvedValue([dueRow({ id: 'sched-live' })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(mockUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastStatus: 'parked:dormant' }) }));
  });

  it('FIRES an owner-authored recurring row even on the dormant project', async () => {
    mockFindMany.mockResolvedValue([dueRow({ id: 'sched-own', promptSetBy: 'user' })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
  });

  it('FIRES a one-shot on the dormant project (out of scope by design)', async () => {
    mockFindMany.mockResolvedValue([dueRow({ id: 'sched-once', kind: 'once', maxRuns: 1, runsCount: 0 })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
  });

  it('a gate evaluation error fails OPEN — the firing proceeds', async () => {
    mockProjectFindUnique.mockRejectedValue(new Error('db down'));
    mockFindMany.mockResolvedValue([dueRow({ id: 'sched-err' })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
  });
});

describe('3. the RESURRECTION path — no successor renewal onto a dormant project (b1d435fd)', () => {
  it('maybeRenewOnExhaustion refuses the successor on the dormant project', async () => {
    const successor = await maybeRenewOnExhaustion(dueRow({ runsCount: 500 }));
    expect(successor).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('renews normally when the project has live work', async () => {
    mockGoalCount.mockResolvedValue(1);
    mockFindFirst.mockResolvedValue(null); // no existing successor
    mockCreate.mockResolvedValue(dueRow({ id: 'sched-successor' }));
    const successor = await maybeRenewOnExhaustion(dueRow({ runsCount: 500 }));
    expect(successor).toBe('sched-successor');
  });
});

describe('4. the RE-ARM path — a parked row resumes only once dormancy lifts (ticket b101ad89)', () => {
  // Replay: the attention-watchdog "cadence stopped — intentional?" card's
  // re-arm action (the Schedules-tab resume, setScheduleEnabledForChat) used
  // to blindly flip a 'parked:dormant' row back to enabled — violating the
  // zero-wake directive while the project stays dormant AND arming a row the
  // fire-time gate re-parks on its very next tick (park → resume → park
  // churn). The resume must re-read the gate and refuse while dormant.
  const parkedRow = (over: any = {}) => dueRow({
    id: 'sched-parked', enabled: false, lastStatus: 'parked:dormant',
    cancelledBy: 'machine', runsCount: 284,
    nextRunAt: new Date(Date.now() - 3600_000), disabledAt: new Date(),
    ...over,
  });

  it('REFUSES the resume while the project stays dormant, with the one-line reason, and writes nothing', async () => {
    mockFindFirst.mockResolvedValue(parkedRow());
    const res = await setScheduleEnabledForChat('sess-spark', 'sched-parked', true);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('dormant');
    expect(res.error).toContain('auto-parked');
    expect(res.error).toContain('Spark Cluster');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('RESUMES the same parked row once the project has live work (an active goal)', async () => {
    mockGoalCount.mockResolvedValue(1);
    mockFindFirst.mockResolvedValue(parkedRow());
    const res = await setScheduleEnabledForChat('sess-spark', 'sched-parked', true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sched-parked' },
      data: expect.objectContaining({ enabled: true }),
    }));
  });

  it("never gates an OWNER-authored row's resume (explicit owner instruction)", async () => {
    // evaluateScheduleDormancy(promptSetBy 'user') returns not-dormant without
    // a single Prisma read — the owner's own cadence is not dormancy work.
    mockFindFirst.mockResolvedValue(parkedRow({ promptSetBy: 'user' }));
    const res = await setScheduleEnabledForChat('sess-spark', 'sched-parked', true);
    expect(res.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("a paused (owner) row is untouched — the guard only reads 'parked:dormant' rows", async () => {
    mockFindFirst.mockResolvedValue(parkedRow({ lastStatus: 'paused', cancelledBy: 'owner' }));
    const res = await setScheduleEnabledForChat('sess-spark', 'sched-parked', true);
    expect(res.ok).toBe(true);
    // evaluateScheduleDormancy may be consulted only for parked rows; the
    // paused row resumes without a dormancy read (mockProjectFindUnique
    // default answers p-dorm, so this passing proves the read never ran).
    expect(mockUpdate).toHaveBeenCalled();
  });
});

describe('5. doctrine pins — the dormant-by-design rule landed where the fleet reads it', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  it('the FLEET supervisor prompt rules dormant projects NOT deaf and forbids re-arms', () => {
    // build 2026-10-08 S-2: the layered sweep body carries the rule (the dated pre-layering builder, which
    // also named the ticket id, was deleted).
    const src = read('../platform/supervisor.service.ts');
    expect(src).toContain('DORMANT-BY-DESIGN');
    expect(src).toContain('dormant-by-design');
    expect(src).toContain('do NOT re-arm anything there');
  });

  it('the PROJECT supervisor prompt carries the same zero-wake rule', () => {
    const src = read('../platform/project-supervisor.service.ts');
    expect(src).toContain('DORMANT-BY-DESIGN');
    expect(src).toContain('b1d435fd');
  });

  it("both stale-firing cancel-class guards treat 'parked:dormant' as a drop (a queued firing of a parked row never executes)", () => {
    expect(read('./run-executor.ts')).toContain("'parked:dormant'");
    expect(read('../chat-agent/chat-agent.service.ts')).toContain("'parked:dormant'");
  });

  it('the fleet + project liveness renders carry the dormant-by-design state (the old DEAF-or-re-arm doctrine is gone)', () => {
    const src = read('../platform/supervisor-state.service.ts');
    expect(src).toContain('dormant-by-design');
    expect(src).not.toContain('no schedules and no live runs is DEAF — re-arm it or say why not:');
  });
});

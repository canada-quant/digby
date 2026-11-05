/**
 * Ticket eb710676 — "Recurring schedules auto-disable at lifetime maxRuns with
 * no self-refresh — live-work chats go deaf (2 instances)" — ADJUDICATION + pins.
 *
 * ADJUDICATION (2026-09-21, lane b92ef13f):
 *  - CORE CLAIM REFUTED: the self-refresh the ticket proposes as (a) IS the
 *    shipped v1#14 renewOnExhaustion design (commit 5d1df5f12, 2026-09-08): the
 *    final-firing / already-at-cap branch of a machine-or-system-authored
 *    recurring row arms a same-cadence successor BEFORE the disable event
 *    (which then carries successorId and drops alarm class —
 *    hooks.service.isAlarmEvent), gated by the dormancy predicate (b1d435fd),
 *    idempotent across the deploy boundary via the DB-UNIQUE renewedFromId
 *    (+P2002 race adoption), inheriting requiredProbes (P7 G13) and a fresh
 *    30-day expiry; the stopped-schedule alert is the fail-open backstop and
 *    notifyScheduleTerminalOnce is owner-visible. Proposal (b) is likewise
 *    substantially shipped (schedule_disabled alarm event + the SA0906
 *    stopped-schedule owner-decision lane + supervisor wake payloads). The
 *    contract is pinned exhaustively by schedule.remediation-p3.test.ts
 *    (v1#14b) and is NOT re-pinned here.
 *  - INSTANCE 1 (spark sweep 8beb4d22, event text "cancelled after 22 run(s)")
 *    was a MANUAL cancel — the Fleet Supervisor's own proactive cancel+re-arm
 *    (it armed 78cd2328 by hand). maybeRenewOnExhaustion fires ONLY from the
 *    two max_runs exhaustion branches (schedule.service.ts processDueScheduleRow
 *    + the fired-final branch); a cancel is a deliberate stop and never renews
 *    BY DESIGN. The DEAF suffix in that event was correct at emission time.
 *  - INSTANCE 2 (CanLaw watch 66cee89e at 481/500): a machine-authored
 *    recurring row WILL auto-renew at run 500 by the same mechanism.
 *  - THE ONE REAL RESIDUAL (fixed + pinned here): the DOUBLE-ARM seam. The
 *    renewal create bypassed the arm-path duplicate guard (ticket 1ead3b52) —
 *    a manually/steered re-arm of the SAME prompt (the live CanLaw shape the
 *    ticket documented: a supervisor-steered manual re-arm queued while the
 *    exhausted row approached its cap) stamps no renewedFromId, so the
 *    idempotency key could not see it, and the auto-successor would have
 *    stacked a SECOND identical loop on the lane (double burn, duplicate
 *    work). maybeRenewOnExhaustion now ADOPTS an enabled, still-live,
 *    same-normalized-prompt recurring row as the successor instead of
 *    creating a duplicate.
 *
 * Harness mirrors schedule.remediation-p3.test.ts (colocated mock-everything).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCreate = jest.fn();
const mockCount = jest.fn();
const mockFindFirst = jest.fn();
const mockFindMany = jest.fn();
const mockUpdate = jest.fn();
const mockUpdateMany = jest.fn();
const mockDeleteMany = jest.fn();
const mockScheduleFindUnique = jest.fn(async (..._args: any[]): Promise<any> => ({ enabled: true }));
const mockRedisDel = jest.fn(async (..._a: any[]) => 1);
const mockChatFindUnique = jest.fn();
const mockChatUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockMsgCreate = jest.fn(async (..._a: any[]) => ({}));
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-cont-1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockCodingStateFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);

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
    agentRun: {
      findFirst: (...a: any[]) => mockRunFindFirst(...a),
      create: (...a: any[]) => mockRunCreate(...a),
      count: (...a: any[]) => mockRunCount(...a),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), update: (...a: any[]) => mockChatUpdate(...a) },
    crossModelMessage: { create: (...a: any[]) => mockMsgCreate(...a) },
    chatCodingState: { findUnique: (...a: any[]) => mockCodingStateFindUnique(...a) },
  },
}));
const mockIncr = jest.fn();
const mockExpire = jest.fn(async (..._args: any[]) => {});
const mockDecr = jest.fn(async (..._args: any[]) => {});
const mockSet = jest.fn(async (..._args: any[]): Promise<any> => 'OK');
const mockGet = jest.fn();
const mockPTtl = jest.fn();
const mockGetDel = jest.fn();
const mockIncrBy = jest.fn();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: (...a: any[]) => mockSet(...a), del: (...a: any[]) => mockRedisDel(...a),
    get: (...a: any[]) => mockGet(...a),
    getDel: (...a: any[]) => mockGetDel(...a),
    pTTL: (...a: any[]) => mockPTtl(...a),
    incr: (...a: any[]) => mockIncr(...a),
    incrBy: (...a: any[]) => mockIncrBy(...a),
    expire: (...a: any[]) => mockExpire(...a),
    decr: (...a: any[]) => mockDecr(...a),
  },
}));

const mockGetChatAutonomy = jest.fn();
jest.mock('../platform/autonomy.service', () => ({
  __esModule: true,
  getChatAutonomy: (...a: any[]) => mockGetChatAutonomy(...a),
}));

const mockEmitHookEvent = jest.fn(async (..._args: any[]) => {});
const mockSweepHookEvents = jest.fn(async (..._args: any[]) => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  sweepHookEvents: (...a: any[]) => mockSweepHookEvents(...a),
}));

const mockStartScheduledRun = jest.fn(async (..._args: any[]): Promise<any> => ({ started: true }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
}));

const mockStartDetachedChatRun = jest.fn((..._args: any[]): string | null => 'chat:s1');
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatRunKey: (id: string) => `chat:${id}`,
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked', SWEEP_TICK: 'sweep_tick', LEASE_HEARTBEAT_FAILED: 'lease_heartbeat_failed', SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', SCHEDULE_BUSY_ALARM: 'schedule_busy_alarm' },
}));

const mockQueueStoppedScheduleAlert = jest.fn((..._a: any[]) => {});
jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: (...a: any[]) => mockQueueStoppedScheduleAlert(...a),
  maybeFileStoppedScheduleDecision: jest.fn(async () => ({ filed: false, reason: 'lane_alive' })),
}));

const mockResolveStoppedForSession = jest.fn(async (..._a: any[]) => 0);
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  resolveStoppedScheduleDecisionsForSession: (...a: any[]) => mockResolveStoppedForSession(...a),
}));

const mockGetPlanStrict = jest.fn(async (..._args: any[]) => null as any);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: (...a: any[]) => mockGetPlanStrict(...a),
}));

const mockEvaluateScheduleDormancy = jest.fn(async (..._a: any[]): Promise<any> => ({
  dormant: false, projectId: 'p1', reason: 'test: project has live work',
  signals: { activeGoals: 1, openTodos: 0, liveRuns: 0, watchedResources: 0 },
}));
jest.mock('./dormancy-gate.service', () => ({
  __esModule: true,
  DORMANT_LAST_STATUS: 'parked:dormant',
  evaluateScheduleDormancy: (...a: any[]) => mockEvaluateScheduleDormancy(...a),
}));

import { maybeRenewOnExhaustion } from './schedule.service';

/** The exhausted recurring row (maybeRenewOnExhaustion's param shape). */
const exhaustedRow = (over: any = {}) => ({
  id: 'sch_old', sessionId: 's1', userId: 'u1', prompt: 'watch the thing',
  kind: 'recurring', intervalSec: 3600, maxRuns: 500,
  promptSetBy: 'machine', renewOnExhaustion: null, requiredProbes: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFindMany.mockResolvedValue([]);
  mockFindFirst.mockResolvedValue(null); // no renewedFromId successor yet
  mockCount.mockResolvedValue(0);
  mockUpdate.mockResolvedValue({});
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockDeleteMany.mockResolvedValue({ count: 0 });
  mockScheduleFindUnique.mockResolvedValue({ enabled: true });
  mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' }, parentChatId: null });
  mockRunFindFirst.mockReset().mockResolvedValue(null);
  mockRunCreate.mockReset().mockResolvedValue({ id: 'run-cont-1' });
  mockRunCount.mockReset().mockResolvedValue(0);
  mockCodingStateFindUnique.mockReset().mockResolvedValue(null);
  mockGetChatAutonomy.mockResolvedValue(null);
  mockIncr.mockResolvedValue(1);
  mockGet.mockResolvedValue(null);
  mockGetDel.mockResolvedValue(null);
  mockPTtl.mockResolvedValue(-2);
  mockSet.mockResolvedValue('OK');
  mockGetPlanStrict.mockResolvedValue({ steps: [{ status: 'pending' }] });
  mockCreate.mockImplementation(({ data }: any) => Promise.resolve({ id: 'succ-1', ...data }));
  mockEvaluateScheduleDormancy.mockResolvedValue({
    dormant: false, projectId: 'p1', reason: 'test: project has live work',
    signals: { activeGoals: 1, openTodos: 0, liveRuns: 0, watchedResources: 0 },
  });
});

describe('ticket eb710676 — renewOnExhaustion duplicate-arm guard', () => {
  it('ADOPT: an enabled, still-live recurring row with the same normalized prompt is returned as the successor — NO duplicate row is created', async () => {
    // The live CanLaw shape: a steered MANUAL re-arm (no renewedFromId) of the
    // same job, trivially rewritten (whitespace + case), is already armed.
    mockFindMany.mockResolvedValue([
      { id: 'manual-1', prompt: '  Watch   the \n THING ', maxRuns: 500, runsCount: 12 },
    ]);
    const res = await maybeRenewOnExhaustion(exhaustedRow());
    expect(res).toBe('manual-1');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('NO SELF-MATCH: the exhausted row itself (still enabled on the fired-final branch) never counts as its own replacement — a real successor is created', async () => {
    // Regression guard for the adoption short-circuiting EVERY renewal: the
    // fired-final call site reaches maybeRenewOnExhaustion BEFORE the row is
    // disabled, so the only normalized-prompt match is the row itself.
    mockFindMany.mockResolvedValue([
      { id: 'sch_old', prompt: 'watch the thing', maxRuns: 500, runsCount: 500 },
    ]);
    const res = await maybeRenewOnExhaustion(exhaustedRow());
    expect(res).toBe('succ-1');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.renewedFromId).toBe('sch_old');
  });

  it('a same-prompt row that is no longer live (runsCount == maxRuns — spent, awaiting the sweeper disable) does not count as the renewal', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'spent-1', prompt: 'watch the thing', maxRuns: 10, runsCount: 10 },
    ]);
    const res = await maybeRenewOnExhaustion(exhaustedRow());
    expect(res).toBe('succ-1');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('different-prompt schedules on the session never block the renewal (the guard is prompt-exact, not cadence-wide)', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'other-1', prompt: 'a different job entirely', maxRuns: null, runsCount: 3 },
      { id: 'other-2', prompt: 'watch the thing — daily digest edition', maxRuns: 100, runsCount: 4 },
    ]);
    const res = await maybeRenewOnExhaustion(exhaustedRow());
    expect(res).toBe('succ-1');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('a DORMANT project still refuses the renewal BEFORE the dedup query runs (b1d435fd ordering preserved)', async () => {
    mockEvaluateScheduleDormancy.mockResolvedValue({
      dormant: true, projectId: 'p1', reason: 'test: no live work',
      signals: { activeGoals: 0, openTodos: 0, liveRuns: 0, watchedResources: 0 },
    });
    const res = await maybeRenewOnExhaustion(exhaustedRow());
    expect(res).toBeNull();
    expect(mockFindMany).not.toHaveBeenCalled(); // dormancy short-circuits first
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a USER-authored row (promptSetBy user) is a deliberate stop — the dedup guard never runs either', async () => {
    const res = await maybeRenewOnExhaustion(exhaustedRow({ promptSetBy: 'user' }));
    expect(res).toBeNull();
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('ticket feaca3e8 — adoption repairs (requiredProbes parity + expiresAt refresh)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('(c) REQUIREDPROBES INHERITANCE: a gate-less dupe adopted by a probe-gated parent is repaired with the parent\'s gate (P7 G13 parity with the create path)', async () => {
    const parentGate = [{ tool: 'run_command' }];
    mockFindMany.mockResolvedValue([
      { id: 'manual-1', prompt: 'watch the thing', maxRuns: 500, runsCount: 12, requiredProbes: null, expiresAt: new Date(Date.now() + 10 * DAY_MS) },
    ]);
    const res = await maybeRenewOnExhaustion(exhaustedRow({ requiredProbes: parentGate }));
    expect(res).toBe('manual-1');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const upd = mockUpdate.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'manual-1' });
    expect(upd.data.requiredProbes).toEqual(parentGate);
  });

  it('(c-negative) a dupe with its OWN requiredProbes keeps them — adoption never overwrites a deliberately armed gate', async () => {
    const dupeGate = [{ tool: 'verify' }];
    mockFindMany.mockResolvedValue([
      { id: 'manual-1', prompt: 'watch the thing', maxRuns: 500, runsCount: 12, requiredProbes: dupeGate, expiresAt: new Date(Date.now() + 10 * DAY_MS) },
    ]);
    const res = await maybeRenewOnExhaustion(exhaustedRow({ requiredProbes: [{ tool: 'run_command' }] }));
    expect(res).toBe('manual-1');
    expect(mockCreate).not.toHaveBeenCalled();
    // expiresAt still refreshes (see (e)) but requiredProbes is NOT in the repair.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].data.requiredProbes).toBeUndefined();
  });

  it('(e) EXPIRY REFRESH: a near-expiry dupe adopted as the successor gets the standard 30-day lifetime (a created successor\'s value) instead of dying hours later', async () => {
    const before = Date.now();
    mockFindMany.mockResolvedValue([
      { id: 'manual-1', prompt: 'watch the thing', maxRuns: 500, runsCount: 12, requiredProbes: null, expiresAt: new Date(before + 2 * 60 * 60 * 1000) }, // dies in 2h
    ]);
    const res = await maybeRenewOnExhaustion(exhaustedRow());
    expect(res).toBe('manual-1');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const exp = mockUpdate.mock.calls[0][0].data.expiresAt as Date;
    expect(exp).toBeInstanceOf(Date);
    expect(exp.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY_MS - 5_000);
    expect(exp.getTime()).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS + 5_000);
  });

  it('(e-negative) a NEVER-EXPIRING dupe (expiresAt null) is never bounded by the repair — and with no gate to inherit, adoption touches nothing', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'manual-1', prompt: 'watch the thing', maxRuns: 500, runsCount: 12, requiredProbes: null, expiresAt: null },
    ]);
    const res = await maybeRenewOnExhaustion(exhaustedRow());
    expect(res).toBe('manual-1');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('BEST-EFFORT: a failing repair never breaks the adoption — the lane staying alive dominates (fail-open)', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('db gone'));
    mockFindMany.mockResolvedValue([
      { id: 'manual-1', prompt: 'watch the thing', maxRuns: 500, runsCount: 12, requiredProbes: null, expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) },
    ]);
    const res = await maybeRenewOnExhaustion(exhaustedRow());
    expect(res).toBe('manual-1'); // adopted anyway
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

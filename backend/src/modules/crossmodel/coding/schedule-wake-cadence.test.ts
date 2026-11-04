/**
 * wake-cadence (2026-09-27 tt-rd audit, sup/wake-cadence) — the WIRING in
 * schedule.service: [SCHEDULE STATE] renewal clause, busy-steer dedupe + delta
 * header, claim-time adaptive stretch + stock-sweep backoff, the stock-sweep
 * floor on machine update_schedule, the observe-only prompt lint on create /
 * update, and the geometric busy re-arm. Boundary mocks mirror
 * schedule.service.test.ts.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCreate = jest.fn();
const mockCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockFindFirst = jest.fn();
const mockFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockUpdate = jest.fn(async (..._a: any[]): Promise<any> => ({}));
const mockUpdateMany = jest.fn(async (..._a: any[]): Promise<any> => ({ count: 1 }));
const mockScheduleFindUnique = jest.fn(async (..._args: any[]): Promise<any> => ({ enabled: true }));
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockLoopMetricFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockMsgFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockActivityCreate = jest.fn(async (..._a: any[]): Promise<any> => ({}));
const mockChatFindUnique = jest.fn(async (..._a: any[]): Promise<any> => ({ userId: 'u1', mode: 'fast', archivedAt: null, codingState: { id: 'cs1' } }));
const mockPromptHistoryFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockStaleFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockTransaction = jest.fn(async (fn: any) => (typeof fn === 'function'
  ? fn({ codingSchedule: { create: (...a: any[]) => mockCreate(...a), findMany: (...a: any[]) => mockStaleFindMany(...a), updateMany: (...a: any[]) => mockUpdateMany(...a) } })
  : Promise.all(fn)));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    codingSchedule: {
      create: (...a: any[]) => mockCreate(...a),
      count: (...a: any[]) => mockCount(...a),
      findMany: (...a: any[]) => mockFindMany(...a),
      findFirst: (...a: any[]) => mockFindFirst(...a),
      findUnique: (...a: any[]) => mockScheduleFindUnique(...a),
      update: (...a: any[]) => mockUpdate(...a),
      updateMany: (...a: any[]) => mockUpdateMany(...a),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    agentRun: {
      findFirst: (...a: any[]) => mockRunFindFirst(...a),
      findMany: (...a: any[]) => mockRunFindMany(...a),
      create: jest.fn(async () => ({ id: 'run-cont-1' })),
      count: jest.fn(async () => 0),
    },
    loopMetric: { findMany: (...a: any[]) => mockLoopMetricFindMany(...a) },
    activity: { create: (...a: any[]) => mockActivityCreate(...a) },
    schedulePromptHistory: {
      create: jest.fn(async () => ({ id: 'ph-1' })),
      count: jest.fn(async () => 0),
      findFirst: (...a: any[]) => mockPromptHistoryFindFirst(...a),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), update: jest.fn(async () => ({})) },
    crossModelMessage: { create: jest.fn(async () => ({})), findMany: (...a: any[]) => mockMsgFindMany(...a) },
    chatCodingState: { findUnique: jest.fn(async () => null) },
    systemSetting: { findUnique: jest.fn(async () => null) },
    $transaction: (fn: any) => mockTransaction(fn),
  },
}));

const mockIncr = jest.fn(async (..._a: any[]): Promise<any> => 1);
const mockExpire = jest.fn(async (..._a: any[]) => {});
const mockSet = jest.fn(async (..._a: any[]): Promise<any> => 'OK');
const mockGet = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockGetDel = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockPTtl = jest.fn(async (..._a: any[]): Promise<any> => -2);
const mockIncrBy = jest.fn(async (..._a: any[]): Promise<any> => 1);
const mockDecr = jest.fn(async (..._a: any[]) => {});
const mockRedisDel = jest.fn(async (..._a: any[]): Promise<any> => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: (...a: any[]) => mockSet(...a), del: (...a: any[]) => mockRedisDel(...a),
    get: (...a: any[]) => mockGet(...a), getDel: (...a: any[]) => mockGetDel(...a),
    pTTL: (...a: any[]) => mockPTtl(...a), incr: (...a: any[]) => mockIncr(...a),
    incrBy: (...a: any[]) => mockIncrBy(...a), expire: (...a: any[]) => mockExpire(...a), decr: (...a: any[]) => mockDecr(...a),
  },
}));

jest.mock('../platform/autonomy.service', () => ({ __esModule: true, getChatAutonomy: jest.fn(async () => null) }));
const mockEmitHookEvent = jest.fn(async (..._a: any[]) => {});
jest.mock('../platform/hooks.service', () => ({ __esModule: true, emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a), sweepHookEvents: jest.fn(async () => {}) }));
const mockStartScheduledRun = jest.fn(async (..._a: any[]): Promise<any> => ({ started: true }));
const mockSteerActiveRun = jest.fn(async (..._a: any[]): Promise<any> => ({ steered: false, reason: 'no_active_run' }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
  steerActiveRun: (...a: any[]) => mockSteerActiveRun(...a),
}));
jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  enqueueChatMessage: jest.fn(async () => ({ id: 'pend-1', position: 1 })),
  peekWakeRider: jest.fn(async () => null),
  consumeWakeRider: jest.fn(async () => 0),
}));
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: jest.fn(() => 'chat:s1'),
  chatRunKey: (id: string) => `chat:${id}`,
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...(jest.requireActual('../platform/loop-metrics.service')),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));
jest.mock('./firing-superseded-gate', () => ({
  __esModule: true,
  ...(jest.requireActual('./firing-superseded-gate')),
  preGateParkedFiring: jest.fn(async () => ({ ineligible: 'mode_off', facts: null, decision: null, stash: null, skip: null })),
}));
jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: jest.fn(),
  maybeFileStoppedScheduleDecision: jest.fn(async () => ({ filed: false, reason: 'lane_alive' })),
}));
const mockFlagOwnerQuestion = jest.fn(async (..._a: any[]): Promise<any> => ({ kind: 'created', question: { id: 'oq_bs' } }));
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  resolveStoppedScheduleDecisionsForSession: jest.fn(async () => 0),
  flagOwnerQuestion: (...a: any[]) => mockFlagOwnerQuestion(...a),
}));
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: jest.fn(async () => null),
}));
jest.mock('./dormancy-gate.service', () => ({
  __esModule: true,
  DORMANT_LAST_STATUS: 'parked:dormant',
  evaluateScheduleDormancy: jest.fn(async () => ({ dormant: false, projectId: null, reason: 'live', signals: {} })),
}));

import { fireDue, fireScheduleTarget, createSchedule, updateScheduleForUser, reconcileCadenceAtClaim, busyFiringSteerHeader, MIN_INTERVAL_SEC } from './schedule.service';
import { PROJECT_SWEEP_PROMPT_OPENER, SWEEP_PROMPT_OPENER } from '../platform/supervisor-doctrine';

const metricsOf = (kind: string) => mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === kind).map((c) => c[0]);

const ENV_KEYS = [
  'SCHEDULE_ADAPTIVE_CADENCE_OWNER_ROWS', 'BLOCK_STREAK_CARDS_ENABLED',
];

/** A due recurring row as the sweeper sees it (the tt-rd shape: machine-authored, 30 min, 500 cap). */
const dueRow = (over: any = {}) => ({
  id: 'sch_ttrd', sessionId: 's1', userId: 'u1', prompt: 'QB2 speed mission — run the next lever', kind: 'recurring',
  intervalSec: 1800, nextRunAt: new Date(Date.now() - 1000), enabled: true,
  runsCount: 331, maxRuns: 500, expiresAt: new Date(Date.now() + 86_400_000),
  lastFiredAt: new Date(Date.now() - 1800_000), lastStatus: 'started', promptSetBy: 'machine', renewOnExhaustion: null,
  busySkips: 0, createdAt: new Date(), nearCapAlertedAt: new Date(), ownerSubscribed: null,
  ...over,
});
/** Completed runs: run i started (i + newestHoursAgo) hours ago and took minutes[i]. */
const fiveRuns = (minutes: number[], scheduleId = 'sch_ttrd', newestHoursAgo = 2) => minutes.map((m, i) => ({
  startedAt: new Date(Date.now() - (i + newestHoursAgo) * 3600_000), finishedAt: new Date(Date.now() - (i + newestHoursAgo) * 3600_000 + m * 60_000), input: { scheduleId },
}));
/** The DB order reconcileCadenceAtClaim asks for (finishedAt desc) — an unsorted fixture makes the take-5 slice meaningless. */
const byFinishedDesc = <T extends { finishedAt: Date }>(rows: T[]): T[] => [...rows].sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime());

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  mockScheduleFindUnique.mockReset().mockResolvedValue({ enabled: true, kind: 'recurring', runsCount: 331, maxRuns: 500, expiresAt: null, lastFiredAt: new Date(Date.now() - 1800_000), promptSetBy: 'machine', ownerSubscribed: null, renewOnExhaustion: null, intervalSec: 1800 });
  mockRunFindFirst.mockReset().mockResolvedValue(null);
  mockRunFindMany.mockReset().mockResolvedValue([]);
  mockLoopMetricFindMany.mockReset().mockResolvedValue([]);
  mockMsgFindMany.mockReset().mockResolvedValue([]);
  mockFindMany.mockReset().mockResolvedValue([]);
  mockUpdate.mockReset().mockResolvedValue({});
  mockUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  mockGet.mockReset().mockResolvedValue(null);
  mockGetDel.mockReset().mockResolvedValue(null);
  mockIncr.mockReset().mockResolvedValue(1);
  mockPTtl.mockReset().mockResolvedValue(-2);
  mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
  mockSteerActiveRun.mockReset().mockResolvedValue({ steered: false, reason: 'no_active_run' });
  mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', archivedAt: null, codingState: { id: 'cs1' } });
  mockPromptHistoryFindFirst.mockReset().mockResolvedValue(null);
  mockCount.mockReset().mockResolvedValue(0);
  mockCreate.mockReset().mockImplementation(({ data }: any) => Promise.resolve({ id: 'sch_new', ...data, lastFiredAt: null, lastStatus: null, runsCount: 0 }));
  mockFindFirst.mockReset();
});
afterAll(() => { for (const k of ENV_KEYS) delete process.env[k]; });

// ── wake-cadence-4: [SCHEDULE STATE] renewal clause ─────────────────────────
describe('[SCHEDULE STATE] carries the renewal clause (wake-cadence-4)', () => {
  it('the tt-rd row (machine, renewOnExhaustion NULL, 331/500) reads "auto-renews at cap … NEVER hand off" on the SAME line as the classic fields', async () => {
    await fireScheduleTarget({ id: 'sch_ttrd', sessionId: 's1', prompt: 'do the thing' });
    const prompt: string = mockStartScheduledRun.mock.calls[0][1];
    expect(prompt).toMatch(/\[SCHEDULE STATE\] firing 332 of 500 · expires never · daily .* · auto-renews at cap — a successor row arms itself; NEVER hand off/);
  });
  it('an owner-authored row reads "STOPS at cap (owner-set)"', async () => {
    mockScheduleFindUnique.mockResolvedValue({ enabled: true, kind: 'recurring', runsCount: 10, maxRuns: 50, expiresAt: null, lastFiredAt: null, promptSetBy: 'user', ownerSubscribed: null, renewOnExhaustion: null, intervalSec: 3600 });
    await fireScheduleTarget({ id: 'sch_o', sessionId: 's1', prompt: 'digest' });
    expect(mockStartScheduledRun.mock.calls[0][1]).toMatch(/firing 11 of 50 · expires never · daily .* · STOPS at cap \(owner-set\)/);
  });
  it('a cadence stretch passed by the claim renders as a second [SCHEDULE STATE] line', async () => {
    await fireScheduleTarget({ id: 'sch_ttrd', sessionId: 's1', prompt: 'do the thing', cadenceStretch: { fromSec: 1800, toSec: 3600, reason: 'run_duration', medianRunMin: 65 } });
    expect(mockStartScheduledRun.mock.calls[0][1]).toMatch(/\n\[SCHEDULE STATE\] cadence stretched 30→60 min by the harness: your last 5 runs took ~65 min/);
  });
});

// ── wake-cadence-1: busy-steer dedupe + delta header ────────────────────────
describe('busy-steer dedupe + delta header (wake-cadence-1)', () => {
  const ACTIVE = { id: 'run-active-1', input: { scheduleId: 'sch_ttrd' } };
  it('FIRST steer into the run this schedule started: delivered as the SHORT delta (header + delta body + [SCHEDULE STATE]), not the whole prompt; the steered marker is stashed', async () => {
    mockRunFindFirst.mockResolvedValue(ACTIVE);
    mockIncr.mockResolvedValue(1);
    mockSteerActiveRun.mockResolvedValue({ steered: true });
    const res = await fireScheduleTarget({ id: 'sch_ttrd', sessionId: 's1', prompt: 'QB2 speed mission — run the next lever (a very long stored prompt)'.repeat(20) });
    expect(res).toEqual({ started: true, steered: true });
    const [, text] = mockSteerActiveRun.mock.calls[0];
    expect(text.startsWith(busyFiringSteerHeader('schedule', 'sch_ttrd'))).toBe(true);
    expect(text).toMatch(/\[SCHEDULED FIRING sch_ttrd arrived mid-run — the stored prompt is UNCHANGED/);
    expect(text).toMatch(/\[SCHEDULE STATE\] firing 332 of 500/);
    expect(text).not.toContain('run the next lever'); // the stored prompt is NOT repeated
    expect(mockIncr).toHaveBeenCalledWith('cm:sched:steer:sch_ttrd:run-active-1');
    expect(mockSet).toHaveBeenCalledWith('cm:sched:steered:sch_ttrd', 'run-active-1', { EX: 86400 });
  });
  it('SECOND firing onto the same run: NOT steered — started:false reason steer_duplicate, one schedule_steer_deduped row, no steer call', async () => {
    mockRunFindFirst.mockResolvedValue(ACTIVE);
    mockIncr.mockResolvedValue(2);
    const res = await fireScheduleTarget({ id: 'sch_ttrd', sessionId: 's1', prompt: 'p' });
    expect(res).toEqual({ started: false, reason: 'steer_duplicate' });
    expect(mockSteerActiveRun).not.toHaveBeenCalled();
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(metricsOf('schedule_steer_deduped')[0]).toMatchObject({ sessionId: 's1', meta: { scheduleId: 'sch_ttrd', runId: 'run-active-1', steersInRun: 1 } });
  });
  it('a run started by SOMETHING ELSE (user turn / another schedule) still gets the FULL prompt on the first steer', async () => {
    mockRunFindFirst.mockResolvedValue({ id: 'run-user', input: { message: 'user typed this' } });
    mockSteerActiveRun.mockResolvedValue({ steered: true });
    await fireScheduleTarget({ id: 'sch_ttrd', sessionId: 's1', prompt: 'the stored prompt body' });
    expect(mockSteerActiveRun.mock.calls[0][1]).toContain('the stored prompt body');
  });
  it('a prompt REWRITTEN since the last firing is always delivered in full', async () => {
    mockRunFindFirst.mockResolvedValue(ACTIVE);
    mockPromptHistoryFindFirst.mockResolvedValue({ createdAt: new Date(), author: 'machine' });
    mockSteerActiveRun.mockResolvedValue({ steered: true });
    await fireScheduleTarget({ id: 'sch_ttrd', sessionId: 's1', prompt: 'the NEW stored prompt' });
    expect(mockSteerActiveRun.mock.calls[0][1]).toContain('the NEW stored prompt');
  });
  it('fixer 2026-09-27: a prompt REWRITTEN while the run already holds a steer BYPASSES the dedupe once (full prompt, started:true); the next unchanged firing is deduped again', async () => {
    mockRunFindFirst.mockResolvedValue(ACTIVE);
    mockIncr.mockResolvedValue(2); // this schedule already steered run-active-1 once
    mockPromptHistoryFindFirst.mockResolvedValue({ createdAt: new Date(), author: 'machine' });
    mockSteerActiveRun.mockResolvedValue({ steered: true });
    const res = await fireScheduleTarget({ id: 'sch_ttrd', sessionId: 's1', prompt: 'the NEW stored prompt — SUCCESSOR clause removed' });
    expect(res).toEqual({ started: true, steered: true });
    expect(mockSteerActiveRun).toHaveBeenCalledTimes(1);
    expect(mockSteerActiveRun.mock.calls[0][1]).toContain('the NEW stored prompt — SUCCESSOR clause removed');
    expect(mockSteerActiveRun.mock.calls[0][1]).not.toMatch(/the stored prompt is UNCHANGED/);
    expect(metricsOf('schedule_steer_deduped')).toHaveLength(0);
    // the steer stamped lastFiredAt (started branch) → the next firing sees no newer rewrite → deduped again
    mockSteerActiveRun.mockClear(); mockRecordLoopMetric.mockClear();
    mockIncr.mockResolvedValue(3);
    mockPromptHistoryFindFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 3600_000), author: 'machine' });
    const res2 = await fireScheduleTarget({ id: 'sch_ttrd', sessionId: 's1', prompt: 'the NEW stored prompt — SUCCESSOR clause removed' });
    expect(res2).toEqual({ started: false, reason: 'steer_duplicate' });
    expect(mockSteerActiveRun).not.toHaveBeenCalled();
    expect(metricsOf('schedule_steer_deduped')).toHaveLength(1);
  });
  it('hook wakes and one-shots keep the pre-change full steer, no dedupe counter', async () => {
    mockRunFindFirst.mockResolvedValue(ACTIVE);
    mockSteerActiveRun.mockResolvedValue({ steered: true });
    await fireScheduleTarget({ id: 'hook-h1', sessionId: 's1', prompt: 'Your sub-session reported run_completed', origin: 'hook' });
    expect(mockIncr).not.toHaveBeenCalled();
    expect(mockSteerActiveRun.mock.calls[0][1]).toContain('Your sub-session reported run_completed');
    mockIncr.mockClear(); mockSteerActiveRun.mockClear();
    mockScheduleFindUnique.mockResolvedValue({ enabled: true, kind: 'once', runsCount: 0, maxRuns: 1, expiresAt: null, lastFiredAt: null, promptSetBy: 'machine', ownerSubscribed: null, renewOnExhaustion: null, intervalSec: 900 });
    await fireScheduleTarget({ id: 'sch_once', sessionId: 's1', prompt: 'one-shot check' });
    expect(mockIncr).not.toHaveBeenCalled();
    expect(mockSteerActiveRun.mock.calls[0][1]).toContain('one-shot check');
  });
  it('a redis error falls back to the old full steer', async () => {
    mockRunFindFirst.mockResolvedValue(ACTIVE);
    mockSteerActiveRun.mockResolvedValue({ steered: true });
    mockIncr.mockRejectedValue(new Error('redis down'));
    const res2 = await fireScheduleTarget({ id: 'sch_ttrd', sessionId: 's1', prompt: 'stored body' });
    expect(res2).toEqual({ started: true, steered: true });
    expect(mockSteerActiveRun).toHaveBeenCalledTimes(1);
  });
});

// ── wake-cadence-2 / -3: claim-time cadence reconciliation ──────────────────
describe('reconcileCadenceAtClaim (wake-cadence-2 adaptive stretch)', () => {
  it('THE tt-rd shape: 30-min machine row, last 5 schedule-origin runs 55–70 min → 60 min, lastStatus stretched:30m→60m', async () => {
    // fixer 2026-09-27: the OTHER schedule's runs are the NEWEST rows (a fast poller sharing the session) and the
    // fixture is in the DB's finishedAt-desc order — without the input.scheduleId === s.id filter the first five
    // would be 5/55/4/70/3 min (median 5) and no stretch would land.
    mockRunFindMany.mockResolvedValue(byFinishedDesc([...fiveRuns([55, 70, 62, 68, 58]), ...fiveRuns([5, 4, 3], 'other', 0.25)]));
    const r = await reconcileCadenceAtClaim(dueRow());
    expect(r.intervalSec).toBe(3600);
    expect(r.lastStatus).toBe('stretched:30m→60m');
    expect(r.stretch).toMatchObject({ fromSec: 1800, toSec: 3600, reason: 'run_duration', medianRunMin: 62 });
    expect(mockRunFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ sessionId: 's1', status: 'completed' }), take: 12 }));
  });
  it('fewer than 3 schedule-origin samples → the median is unknown; the row is untouched unless a collision trigger holds', async () => {
    mockRunFindMany.mockResolvedValue(fiveRuns([90, 95]));
    expect(await reconcileCadenceAtClaim(dueRow())).toEqual({});
    expect(await reconcileCadenceAtClaim(dueRow({ busySkips: 3 }))).toMatchObject({ intervalSec: 3600, stretch: { reason: 'busy_skips' } });
    mockGet.mockImplementation(async (k: string) => (k === 'cm:sched:steered:sch_ttrd' ? 'run-x' : null));
    expect(await reconcileCadenceAtClaim(dueRow())).toMatchObject({ intervalSec: 3600, stretch: { reason: 'steered' } });
  });
  it('owner-authored rows are left alone by default; SCHEDULE_ADAPTIVE_CADENCE_OWNER_ROWS=1 includes them', async () => {
    mockRunFindMany.mockResolvedValue(fiveRuns([55, 70, 62, 68, 58]));
    expect(await reconcileCadenceAtClaim(dueRow({ promptSetBy: 'user' }))).toEqual({});
    expect(await reconcileCadenceAtClaim(dueRow({ promptSetBy: null }))).toEqual({});
    process.env.SCHEDULE_ADAPTIVE_CADENCE_OWNER_ROWS = '1';
    expect(await reconcileCadenceAtClaim(dueRow({ promptSetBy: 'user' }))).toMatchObject({ intervalSec: 3600 });
  });
  it('one-shots, the fleet sweep and a read error all leave the row untouched (fail-open)', async () => {
    mockRunFindMany.mockResolvedValue(fiveRuns([55, 70, 62, 68, 58]));
    expect(await reconcileCadenceAtClaim(dueRow({ kind: 'once' }))).toEqual({});
    expect(await reconcileCadenceAtClaim(dueRow({ prompt: `${SWEEP_PROMPT_OPENER} — a GOAL LEDGER diff` }))).toEqual({});
    mockRunFindMany.mockRejectedValue(new Error('db down'));
    expect(await reconcileCadenceAtClaim(dueRow())).toEqual({});
  });
});

describe('reconcileCadenceAtClaim (wake-cadence-3 stock project sweep backoff)', () => {
  const SWEEP = (over: any = {}) => dueRow({ id: 'sch_sweep', sessionId: 'psup1', prompt: `${PROJECT_SWEEP_PROMPT_OPENER} for "tt-rd" — a GOAL LEDGER diff`, intervalSec: 7200, promptSetBy: 'system', ...over });
  const noop = (i: number, origin = 'schedule') => ({ kind: 'supervisor_noop', meta: { origin }, createdAt: new Date(Date.now() - i * 60_000) });
  it('3 consecutive schedule-origin no-ops → 2 h doubles to 4 h, lastStatus backoff:3', async () => {
    mockLoopMetricFindMany.mockResolvedValue([noop(1), noop(2, 'hook'), noop(3), noop(4), { kind: 'supervisor_action', meta: { origin: 'hook' }, createdAt: new Date(Date.now() - 5 * 60_000) }]);
    const r = await reconcileCadenceAtClaim(SWEEP());
    expect(r).toMatchObject({ intervalSec: 14400, lastStatus: 'backoff:3', backoff: { kind: 'backoff', fromSec: 7200, toSec: 14400, noopStreak: 3 } });
    expect(mockLoopMetricFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: 'psup1', kind: { in: ['supervisor_noop', 'supervisor_action', 'supervisor_note'] } }, take: 12 }));
    expect(mockRunFindMany).not.toHaveBeenCalled(); // stock sweeps never take the stretch path
  });
  it('an action row newest, or an OWNER turn since the newest note, RESETS a backed-off sweep to 2 h', async () => {
    mockLoopMetricFindMany.mockResolvedValue([{ kind: 'supervisor_action', meta: { origin: 'schedule' }, createdAt: new Date() }, noop(2), noop(3), noop(4)]);
    expect(await reconcileCadenceAtClaim(SWEEP({ intervalSec: 14400 }))).toMatchObject({ intervalSec: 7200, lastStatus: 'backoff:reset' });
    mockLoopMetricFindMany.mockResolvedValue([noop(1), noop(2), noop(3)]);
    mockMsgFindMany.mockResolvedValue([{ metadata: { origin: 'schedule' } }, { metadata: null }]); // one REAL user row
    expect(await reconcileCadenceAtClaim(SWEEP({ intervalSec: 14400 }))).toMatchObject({ intervalSec: 7200, lastStatus: 'backoff:reset' });
    mockMsgFindMany.mockResolvedValue([{ metadata: { origin: 'hook' } }]); // machine rows only → no reset
    expect(await reconcileCadenceAtClaim(SWEEP({ intervalSec: 14400 }))).toEqual({});
  });
  it('a row already at the 4 h ceiling stays', async () => {
    mockLoopMetricFindMany.mockResolvedValue([noop(1), noop(2), noop(3), noop(4), noop(5), noop(6)]);
    expect(await reconcileCadenceAtClaim(SWEEP({ intervalSec: 14400 }))).toEqual({});
  });
});

describe('reconcileCadenceAtClaim (todo 27c215d6 — open-ended block-streak backoff)', () => {
  // The baseline specimen class: the One Piece TCG prod-watch re-reporting the
  // suspended AWS account (ids/timestamps churn, tokens do not).
  const TCG = (n: number) => `Check #${n} (2026-10-1${n}): AWS account 000000000000 remains suspended — provision is BLOCKED on the owner's account decision. No end date. Nothing else changed; task 4e8c22ab still pending.`;
  const answers = (texts: string[]) => texts.map((content, i) => ({ content, createdAt: new Date(Date.now() - i * 3600_000) }));
  it('THE specimen: 3 consecutive near-identical blocked-no-end-date answers → 30 min doubles to 60, lastStatus blocked_streak:3', async () => {
    mockMsgFindMany.mockResolvedValue(answers([TCG(3), TCG(2), TCG(1)]));
    const r = await reconcileCadenceAtClaim(dueRow());
    expect(r).toMatchObject({ intervalSec: 3600, lastStatus: 'blocked_streak:3', blockStreak: 3, blockBackoff: { kind: 'backoff', fromSec: 1800, toSec: 3600, streak: 3 } });
    expect(mockMsgFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ chatId: 's1', role: 'assistant', metadata: { path: ['scheduleId'], equals: 'sch_ttrd' } }), take: 24 }));
  });
  it('a healthy NEWEST answer (the blocker lifted) leaves the row untouched', async () => {
    mockMsgFindMany.mockResolvedValue(answers(['All green — the account is unsuspended, provision succeeded.', TCG(2), TCG(1)]));
    expect(await reconcileCadenceAtClaim(dueRow())).toEqual({});
  });
  it('below the trigger (2 answers): no verdict', async () => {
    mockMsgFindMany.mockResolvedValue(answers([TCG(2), TCG(1)]));
    expect(await reconcileCadenceAtClaim(dueRow())).toEqual({});
  });
  it('the kill switch reverts the whole leg; owner rows stay exempt (same doctrine as the stretch)', async () => {
    mockMsgFindMany.mockResolvedValue(answers([TCG(3), TCG(2), TCG(1)]));
    process.env.BLOCK_STREAK_BACKOFF_DISABLED = '1';
    expect(await reconcileCadenceAtClaim(dueRow())).toEqual({});
    delete process.env.BLOCK_STREAK_BACKOFF_DISABLED;
    expect(await reconcileCadenceAtClaim(dueRow({ promptSetBy: 'user' }))).toEqual({});
  });
  it('a scan read error fails open (cadence unchanged); the block leg never fires for sweeps', async () => {
    mockMsgFindMany.mockRejectedValue(new Error('db down'));
    expect(await reconcileCadenceAtClaim(dueRow())).toEqual({});
    mockMsgFindMany.mockResolvedValue(answers([TCG(3), TCG(2), TCG(1)]));
    expect(await reconcileCadenceAtClaim(dueRow({ prompt: `${PROJECT_SWEEP_PROMPT_OPENER} for "x" — a GOAL LEDGER diff` }))).toEqual({});
  });
  it('a streak at the ceiling returns the streak with no backoff (the OBSERVED metric still accrues)', async () => {
    const ceiling = 24 * 60 * 60;
    mockMsgFindMany.mockResolvedValue(answers([TCG(4), TCG(3), TCG(2), TCG(1)]));
    const r = await reconcileCadenceAtClaim(dueRow({ intervalSec: ceiling }));
    expect(r).toEqual({ blockStreak: 4, blockBackoff: null });
  });
  it('the block backoff WINS the merge when it is larger than the run-duration stretch (a tie keeps the stretch)', async () => {
    mockMsgFindMany.mockResolvedValue(answers([TCG(6), TCG(5), TCG(4), TCG(3), TCG(2), TCG(1)]));
    mockRunFindMany.mockResolvedValue(byFinishedDesc(fiveRuns([55, 70, 62, 68, 58]))); // stretch would say 3600
    const r = await reconcileCadenceAtClaim(dueRow());
    expect(r).toMatchObject({ intervalSec: 7200, lastStatus: 'blocked_streak:6', stretch: null, blockBackoff: { toSec: 7200, streak: 6 } });
  });
});

describe('the claim carries the cadence write; the firing gets the stretch line; audit + metric land only on the claim winner', () => {
  it('fireDue on the tt-rd row: updateMany data has intervalSec 3600 + lastStatus stretched; [SCHEDULE STATE] carries the stretch; Activity schedule.update source cadence-stretch; schedule_cadence_stretched metric', async () => {
    mockFindMany.mockResolvedValue([dueRow()]);
    mockRunFindMany.mockResolvedValue(fiveRuns([55, 70, 62, 68, 58]));
    await fireDue();
    const claim = mockUpdateMany.mock.calls.find((c) => c[0]?.where?.nextRunAt !== undefined)!;
    expect(claim[0].data).toMatchObject({ intervalSec: 3600, lastStatus: 'stretched:30m→60m' });
    expect(claim[0].data.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 3599_000);
    expect(mockStartScheduledRun.mock.calls[0][1]).toMatch(/cadence stretched 30→60 min by the harness/);
    expect(metricsOf('schedule_cadence_stretched')[0]).toMatchObject({ sessionId: 's1', meta: { scheduleId: 'sch_ttrd', medianRunMin: 62, from: 1800, to: 3600, reason: 'run_duration', promptSetBy: 'machine' } });
    expect(mockActivityCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'u1', action: 'schedule.update', resource: 'platform', metadata: expect.objectContaining({ scheduleId: 'sch_ttrd', source: 'cadence-stretch', from: 1800, to: 3600 }) }) });
  });
  it('a LOST claim writes nothing else (no metric, no audit)', async () => {
    mockFindMany.mockResolvedValue([dueRow()]);
    mockRunFindMany.mockResolvedValue(fiveRuns([55, 70, 62, 68, 58]));
    mockUpdateMany.mockResolvedValue({ count: 0 });
    await fireDue();
    expect(metricsOf('schedule_cadence_stretched')).toHaveLength(0);
    expect(mockActivityCreate).not.toHaveBeenCalled();
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
  });
  // ── todo 27c215d6: the block-streak leg lands on the claim winner only, and
  // the OBSERVED metric accrues even at the ceiling (no intervalSec change). ──
  it('fireDue on the TCG specimen: claim writes intervalSec 3600 + lastStatus blocked_streak:3; [SCHEDULE STATE] carries the block-stretch line; block_streak_backoff + block_streak_observed metrics + Activity source block-streak-backoff land', async () => {
    mockFindMany.mockResolvedValue([dueRow()]);
    mockMsgFindMany.mockResolvedValue([
      { content: `Check #3: AWS account 000000000000 remains suspended — provision is BLOCKED on the owner's account decision. No end date.`, createdAt: new Date(Date.now() - 3600_000) },
      { content: `Check #2: AWS account 000000000000 remains suspended — provision is BLOCKED on the owner's account decision. No end date.`, createdAt: new Date(Date.now() - 2 * 3600_000) },
      { content: `Check #1: AWS account 000000000000 remains suspended — provision is BLOCKED on the owner's account decision. No end date.`, createdAt: new Date(Date.now() - 3 * 3600_000) },
    ]);
    await fireDue();
    const claim = mockUpdateMany.mock.calls.find((c) => c[0]?.where?.nextRunAt !== undefined)!;
    expect(claim[0].data).toMatchObject({ intervalSec: 3600, lastStatus: 'blocked_streak:3' });
    expect(mockStartScheduledRun.mock.calls[0][1]).toMatch(/SAME unresolved blocker/);
    expect(metricsOf('block_streak_backoff')[0]).toMatchObject({ sessionId: 's1', meta: { scheduleId: 'sch_ttrd', from: 1800, to: 3600, streak: 3 } });
    expect(metricsOf('block_streak_observed')[0]).toMatchObject({ sessionId: 's1', meta: { scheduleId: 'sch_ttrd', streak: 3, trigger: 3, escalatedCard: false } });
    expect(mockActivityCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'u1', action: 'schedule.update', resource: 'platform', metadata: expect.objectContaining({ scheduleId: 'sch_ttrd', source: 'block-streak-backoff', from: 1800, to: 3600 }) }) });
  });
  it('r3 interactions finding 3: the opt-in block-streak card is a HARNESS per-event card (harnessEventAt) — an earlier owner ruling annotates it, never refuses it', async () => {
    process.env.BLOCK_STREAK_CARDS_ENABLED = '1';
    mockFindMany.mockResolvedValue([dueRow()]);
    mockMsgFindMany.mockResolvedValue([3, 2, 1].map((n) => (
      { content: `Check #${n}: AWS account 000000000000 remains suspended — provision is BLOCKED on the owner's account decision. No end date.`, createdAt: new Date(Date.now() - n * 3600_000) }
    )));
    const before = Date.now();
    await fireDue();
    expect(mockFlagOwnerQuestion).toHaveBeenCalledTimes(1);
    const input = mockFlagOwnerQuestion.mock.calls[0][0];
    expect(input).toMatchObject({ chatId: 's1', userId: 'u1', machineTriggered: true });
    expect(input.harnessEventAt).toBeInstanceOf(Date);
    expect(input.harnessEventAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(metricsOf('block_streak_observed')[0]).toMatchObject({ meta: { scheduleId: 'sch_ttrd', escalatedCard: true } });
  });
  it('at the ceiling (no intervalSec change): the claim still writes the OBSERVED metric — the 7-day baseline accrues regardless of the backoff verdict', async () => {
    mockFindMany.mockResolvedValue([dueRow({ intervalSec: 24 * 60 * 60 })]);
    mockMsgFindMany.mockResolvedValue([
      { content: `Check #4: AWS account 000000000000 remains suspended — provision is BLOCKED on the account decision. No end date.`, createdAt: new Date() },
      { content: `Check #3: AWS account 000000000000 remains suspended — provision is BLOCKED on the account decision. No end date.`, createdAt: new Date() },
      { content: `Check #2: AWS account 000000000000 remains suspended — provision is BLOCKED on the account decision. No end date.`, createdAt: new Date() },
      { content: `Check #1: AWS account 000000000000 remains suspended — provision is BLOCKED on the account decision. No end date.`, createdAt: new Date() },
    ]);
    await fireDue();
    expect(metricsOf('block_streak_observed')[0]).toMatchObject({ meta: { scheduleId: 'sch_ttrd', streak: 4, escalatedCard: false } });
    expect(metricsOf('block_streak_backoff')).toHaveLength(0);
    const claim = mockUpdateMany.mock.calls.find((c) => c[0]?.where?.nextRunAt !== undefined)!;
    expect(claim[0].data.intervalSec).toBeUndefined(); // cadence already at the ceiling
  });
  it('a REAL start clears the steered marker; a steer keeps it', async () => {
    mockFindMany.mockResolvedValue([dueRow()]);
    await fireDue();
    expect(mockRedisDel).toHaveBeenCalledWith('cm:sched:steered:sch_ttrd');
  });

  // fixer 2026-09-27 — the ratchet finding: one collision episode buys ONE doubling.
  describe('at most one doubling per collision episode (fixer 2026-09-27)', () => {
    const ACTIVE = { id: 'run-active-1', input: { scheduleId: 'sch_ttrd' } };
    /** A tiny stateful Redis so the marker the claim consumes is really gone on the next claim. */
    const redisStore = new Map<string, string>();
    beforeEach(() => {
      redisStore.clear();
      mockGet.mockImplementation(async (k: string) => redisStore.get(k) ?? null);
      mockSet.mockImplementation(async (k: string, v: any) => { redisStore.set(k, String(v)); return 'OK'; });
      mockRedisDel.mockImplementation(async (k: string) => (redisStore.delete(k) ? 1 : 0));
    });
    it('STEER path: fireDue twice onto the same still-running run (steered marker set, then steer_duplicate) doubles 30 → 60 ONCE — the landed stretch consumes the marker and the second claim leaves the row alone', async () => {
      redisStore.set('cm:sched:steered:sch_ttrd', 'run-active-1'); // the previous firing was steered into run-active-1
      mockRunFindFirst.mockResolvedValue(ACTIVE);
      mockIncr.mockResolvedValue(2); // this schedule already steered that run once → steer_duplicate
      mockFindMany.mockResolvedValue([dueRow()]);
      await fireDue();
      const claim1 = mockUpdateMany.mock.calls.find((c) => c[0]?.where?.nextRunAt !== undefined)!;
      expect(claim1[0].data).toMatchObject({ intervalSec: 3600, lastStatus: 'stretched:30m→60m' });
      expect(metricsOf('schedule_cadence_stretched')).toHaveLength(1);
      expect(metricsOf('schedule_cadence_stretched')[0].meta).toMatchObject({ scheduleId: 'sch_ttrd', from: 1800, to: 3600, reason: 'steered' });
      expect(redisStore.has('cm:sched:steered:sch_ttrd')).toBe(false); // consumed by the landed stretch
      expect(mockUpdate.mock.calls.some((c) => c[0]?.data?.lastStatus === 'skipped:steer_duplicate')).toBe(true);
      // second firing, same run still going: the row is now the 60-min row the DB holds
      mockUpdateMany.mockClear(); mockRecordLoopMetric.mockClear(); mockUpdate.mockClear(); mockActivityCreate.mockClear();
      mockFindMany.mockResolvedValue([dueRow({ intervalSec: 3600, lastStatus: 'skipped:steer_duplicate' })]);
      await fireDue();
      const claim2 = mockUpdateMany.mock.calls.find((c) => c[0]?.where?.nextRunAt !== undefined)!;
      expect(claim2[0].data.intervalSec).toBeUndefined();
      expect(claim2[0].data.lastStatus).toBeUndefined();
      expect(metricsOf('schedule_cadence_stretched')).toHaveLength(0);
      expect(mockActivityCreate).not.toHaveBeenCalled();
    });
    it('BUSY-PARK path: the claim at busySkips 3 (the crossing) stretches 30 → 60; the claims at busySkips 4 and 5 that follow the same parked firing do not', async () => {
      mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
      mockFindMany.mockResolvedValue([dueRow({ busySkips: 3 })]);
      mockUpdate.mockResolvedValue({ busySkips: 4 });
      await fireDue();
      expect(mockUpdateMany.mock.calls.find((c) => c[0]?.where?.nextRunAt !== undefined)![0].data).toMatchObject({ intervalSec: 3600 });
      expect(metricsOf('schedule_cadence_stretched')).toHaveLength(1);
      for (const busySkips of [4, 5]) {
        mockUpdateMany.mockClear(); mockRecordLoopMetric.mockClear();
        mockFindMany.mockResolvedValue([dueRow({ intervalSec: 3600, busySkips, lastStatus: 'skipped:busy' })]);
        mockUpdate.mockResolvedValue({ busySkips: busySkips + 1 });
        await fireDue();
        expect(mockUpdateMany.mock.calls.find((c) => c[0]?.where?.nextRunAt !== undefined)![0].data.intervalSec).toBeUndefined();
        expect(metricsOf('schedule_cadence_stretched')).toHaveLength(0);
      }
    });
  });
});

// ── wake-cadence-6: geometric busy re-arm ───────────────────────────────────
describe('busy re-arm backoff (wake-cadence-6)', () => {
  // A busySkips 3 row is ALSO stretched at the claim (wake-cadence-2, the
  // busy-skip crossing: 30→60 min ⇒ half-cadence cap 30 ⇒ 24 min); pin that
  // composition once, then the geometric delays below the crossing.
  it('composition: busySkips 3 stretches the row to 60 min at the claim, so the re-arm cap is 30 min and the 4th delay is the full 24 min', async () => {
    mockFindMany.mockResolvedValue([dueRow({ busySkips: 3 })]);
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
    mockUpdate.mockResolvedValue({ busySkips: 4 });
    const before = Date.now();
    await fireDue();
    const claim = mockUpdateMany.mock.calls.find((c) => c[0]?.where?.nextRunAt !== undefined)!;
    expect(claim[0].data).toMatchObject({ intervalSec: 3600, lastStatus: 'stretched:30m→60m' });
    const skipWrite = mockUpdate.mock.calls.find((c) => c[0]?.data?.lastStatus === 'skipped:busy')!;
    expect(Math.round((skipWrite[0].data.nextRunAt.getTime() - before) / 60_000)).toBe(24);
  });
  it.each([[0, 3], [1, 6], [2, 12]])('busySkips %i before this skip → re-arm in %i min on a 30-min row', async (busySkips, minutes) => {
    mockFindMany.mockResolvedValue([dueRow({ busySkips })]);
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
    mockUpdate.mockResolvedValue({ busySkips: busySkips + 1 });
    const before = Date.now();
    await fireDue();
    const skipWrite = mockUpdate.mock.calls.find((c) => c[0]?.data?.lastStatus === 'skipped:busy')!;
    const delta = (skipWrite[0].data.nextRunAt.getTime() - before) / 60_000;
    expect(delta).toBeGreaterThanOrEqual(minutes - 0.05);
    expect(delta).toBeLessThanOrEqual(minutes + 0.05);
    expect(skipWrite[0].data.busySkips).toEqual({ increment: 1 });
  });
  it('a steer_duplicate skip refunds the token and re-arms NOTHING extra (the claim already slid nextRunAt a full interval)', async () => {
    mockFindMany.mockResolvedValue([dueRow()]);
    mockRunFindFirst.mockResolvedValue({ id: 'run-active-1', input: { scheduleId: 'sch_ttrd' } });
    mockIncr.mockResolvedValue(2);
    await fireDue();
    const skipWrite = mockUpdate.mock.calls.find((c) => c[0]?.data?.lastStatus === 'skipped:steer_duplicate')!;
    expect(skipWrite).toBeTruthy();
    expect(skipWrite[0].data.nextRunAt).toBeUndefined();
    expect(skipWrite[0].data.busySkips).toBeUndefined();
    expect(mockDecr).toHaveBeenCalled(); // daily-cap token refunded
  });
});

// ── wake-cadence-3: stock-sweep floor on update_schedule ────────────────────
describe('update_schedule stock-sweep floor (wake-cadence-3)', () => {
  const sweepRow = { id: 'sch_sweep', sessionId: 'psup1', userId: 'u1', prompt: `${PROJECT_SWEEP_PROMPT_OPENER} for "tt-rd" — diff`, kind: 'recurring', intervalSec: 7200, nextRunAt: new Date(), enabled: true, runsCount: 392, maxRuns: 500, expiresAt: new Date(Date.now() + 86400_000), lastFiredAt: null, lastStatus: 'started' };
  it('THE receipt-f089cbf4 shape: a MACHINE turn cutting the stock sweep to 30 min is refused, nothing written, one sweep_backoff floor_refused row', async () => {
    mockFindFirst.mockResolvedValue(sweepRow);
    const r = await updateScheduleForUser('u1', 'sch_sweep', { intervalSec: 1800, promptSetBy: 'machine' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stock project sweeps are floored at 120 min/);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(metricsOf('sweep_backoff')[0]).toMatchObject({ sessionId: 'psup1', meta: { scheduleId: 'sch_sweep', kind: 'floor_refused', from: 7200, to: 1800 } });
  });
  it('an OWNER turn may set it lower; a non-stock row is never floored', async () => {
    mockFindFirst.mockResolvedValue(sweepRow);
    mockUpdate.mockImplementation(({ data }: any) => Promise.resolve({ ...sweepRow, ...data }));
    expect((await updateScheduleForUser('u1', 'sch_sweep', { intervalSec: 1800, promptSetBy: 'user' })).ok).toBe(true);
    mockFindFirst.mockResolvedValue({ ...sweepRow, prompt: 'poll the box every hour' });
    // 60 min (not MIN_INTERVAL_SEC: 15 min would trip the unrelated cap-cadence guard for a machine actor)
    expect((await updateScheduleForUser('u1', 'sch_sweep', { intervalSec: 4 * MIN_INTERVAL_SEC, promptSetBy: 'machine' })).ok).toBe(true);
  });
  it('fixer 2026-09-27: an interval write is ATTRIBUTED — an owner edit (REST / user turn) writes source owner-interval, a machine turn writes machine-interval; a prompt-only edit and an unchanged interval write nothing', async () => {
    mockFindFirst.mockResolvedValue(sweepRow);
    mockUpdate.mockImplementation(({ data }: any) => Promise.resolve({ ...sweepRow, ...data }));
    expect((await updateScheduleForUser('u1', 'sch_sweep', { intervalSec: 1800 })).ok).toBe(true); // the Schedules-tab REST edit passes no actor
    expect(mockActivityCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'u1', action: 'schedule.update', resource: 'platform', metadata: { scheduleId: 'sch_sweep', chatId: 'psup1', fields: ['intervalSec'], source: 'owner-interval', from: 7200, to: 1800 } }) });
    mockActivityCreate.mockClear();
    expect((await updateScheduleForUser('u1', 'sch_sweep', { intervalSec: 1800, promptSetBy: 'user' })).ok).toBe(true);
    expect(mockActivityCreate.mock.calls[0][0].data.metadata).toMatchObject({ source: 'owner-interval' });
    mockActivityCreate.mockClear();
    expect((await updateScheduleForUser('u1', 'sch_sweep', { intervalSec: 4 * 3600, promptSetBy: 'machine' })).ok).toBe(true);
    expect(mockActivityCreate.mock.calls[0][0].data.metadata).toMatchObject({ source: 'machine-interval', from: 7200, to: 4 * 3600 });
    mockActivityCreate.mockClear();
    expect((await updateScheduleForUser('u1', 'sch_sweep', { prompt: `${PROJECT_SWEEP_PROMPT_OPENER} for "tt-rd" — diff v2`, promptSetBy: 'user' })).ok).toBe(true);
    expect((await updateScheduleForUser('u1', 'sch_sweep', { intervalSec: 7200, promptSetBy: 'user' })).ok).toBe(true); // unchanged
    expect(mockActivityCreate).not.toHaveBeenCalled();
  });
});

// ── wake-cadence-4: observe-only prompt lint on create / update ─────────────
describe('schedule prompt lint (wake-cadence-4, observe-only)', () => {
  const SUCCESSOR = 'Speed mission loop. SUCCESSOR (arm BEFORE this schedule exhausts at 500): when ≥480 firings have run, flag_owner_question requesting a FRESH monitor lane.';
  it('a MACHINE arm carrying the cap-handoff clause LANDS (ok:true) with the notice on `warning` + one schedule_prompt_lint row', async () => {
    const r = await createSchedule({ sessionId: 's1', userId: 'u1', prompt: SUCCESSOR, kind: 'recurring', intervalSec: 3600, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/\[SCHEDULE PROMPT NOTICE\] this prompt carries a cap-driven successor\/hand-off clause/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(metricsOf('schedule_prompt_lint')[0]).toMatchObject({ sessionId: 's1', meta: { rule: 'cap_handoff', seam: 'create', kind: 'recurring' } });
  });
  it('an owner arm is never linted; a machine update that rewrites the prompt is (seam update); an interval-only update is not', async () => {
    const r = await createSchedule({ sessionId: 's1', userId: 'u1', prompt: SUCCESSOR, kind: 'recurring', intervalSec: 3600, promptSetBy: 'user' });
    expect(r.ok).toBe(true);
    expect(r.warning ?? '').not.toMatch(/SCHEDULE PROMPT NOTICE/);
    const row = { id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'old', kind: 'recurring', intervalSec: 3600, nextRunAt: new Date(), enabled: true, runsCount: 3, maxRuns: 500, expiresAt: new Date(Date.now() + 86400_000), lastFiredAt: null, lastStatus: 'started' };
    mockFindFirst.mockResolvedValue(row);
    mockUpdate.mockImplementation(({ data }: any) => Promise.resolve({ ...row, ...data }));
    const u = await updateScheduleForUser('u1', 'sch_1', { prompt: SUCCESSOR, promptSetBy: 'machine' });
    expect(u.ok).toBe(true);
    expect(u.warning).toMatch(/SCHEDULE PROMPT NOTICE/);
    expect(metricsOf('schedule_prompt_lint').map((m) => m.meta.seam)).toEqual(['update']);
    mockRecordLoopMetric.mockClear();
    const u2 = await updateScheduleForUser('u1', 'sch_1', { intervalSec: 7200, promptSetBy: 'machine' });
    expect(u2.ok).toBe(true);
    expect(metricsOf('schedule_prompt_lint')).toHaveLength(0);
  });
});

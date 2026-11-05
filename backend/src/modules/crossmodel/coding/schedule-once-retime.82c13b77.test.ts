/**
 * Pin: update_schedule on a kind:'once' row (Fleet-reported incident 2026-09-21
 * ~22:38Z, ticket 82c13b77 / rows d2e1f633, da38d705, c79a0960 on the CanLaw
 * supervisor chat f5c2c1f4).
 *
 * What the incident ACTUALLY was (verified against prod rows + the lane's own
 * report msg ab60cd95): the row never flipped kind — it was born 'once',
 * stayed 'once', maxRuns 1. updateScheduleForUser ACCEPTED intervalMinutes on
 * the once row, stored the (semantically meaningless) intervalSec, and NEVER
 * moved nextRunAt — a silent no-op — while the platform-tools envelope printed
 * "now every 27 min" for any row with intervalSec set. The supervisor read
 * that as a silent once→recurring flip (an uncaught one would have re-pushed
 * the owner's Telegram ETA every 27 min), cancelled the row, and burned two
 * more cancel+re-arm cycles getting the delivery timing right.
 *
 * This file pins the fix set:
 *   1. intervalSec on a once row is a RETIME: nextRunAt = now + interval, kind
 *      unchanged (create-time delay semantics — createSchedule stamps
 *      nextRunAt = now + interval for once rows), logged as a 'retimed
 *      one-shot' line.
 *   2. A retime past the row's expiresAt is an honest REFUSAL (never the old
 *      silent no-op).
 *   3. The recurrence guard stays put: a once row is spent at runsCount >= 1
 *      and maybeRenewOnExhaustion still refuses non-recurring rows, so a
 *      retimed once row cannot re-fire (the feared spam loop was impossible;
 *      the DEFECT was the silent no-op + lying envelope).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindFirst = jest.fn();
const mockFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockUpdate = jest.fn(async ({ data }: any) => ({ ...onceRowRef(), ...data }));
const mockCreate = jest.fn(async (..._a: any[]): Promise<any> => ({}));
const mockCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockScheduleFindUnique = jest.fn(async (..._a: any[]): Promise<any> => ({ enabled: true }));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: {
      create: (...a: any[]) => mockCreate(...a),
      count: (...a: any[]) => mockCount(...a),
      findMany: (...a: any[]) => mockFindMany(...a),
      findFirst: (...a: any[]) => mockFindFirst(...a as [any]),
      findUnique: (...a: any[]) => mockScheduleFindUnique(...a as [any]),
      update: (...a: any[]) => mockUpdate(...a as [any]),
      updateMany: jest.fn(async (..._a: any[]) => ({ count: 0 })),
      deleteMany: jest.fn(async (..._a: any[]) => ({ count: 0 })),
    },
    agentRun: {
      findFirst: jest.fn(async (..._a: any[]): Promise<any> => null),
      create: jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-1' })),
      count: jest.fn(async (..._a: any[]): Promise<number> => 0),
    },
    schedulePromptHistory: {
      create: jest.fn(async (..._a: any[]): Promise<any> => ({})),
      count: jest.fn(async (..._a: any[]): Promise<number> => 0),
      findFirst: jest.fn(async (..._a: any[]): Promise<any> => null),
    },
    crossModelChat: { findUnique: jest.fn(async (..._a: any[]): Promise<any> => undefined), update: jest.fn(async (..._a: any[]) => ({})) },
    crossModelMessage: { create: jest.fn(async (..._a: any[]) => ({})) },
    $transaction: async (fn: any) => fn({
      chatSchedule: {
        create: (...a: any[]) => mockCreate(...a),
        findMany: (...a: any[]) => mockFindMany(...a),
        updateMany: jest.fn(async (..._a: any[]) => ({ count: 0 })),
      },
    }),
  },
}));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (..._a: any[]): Promise<any> => 'OK'),
    del: jest.fn(async (..._a: any[]): Promise<any> => 1),
    get: jest.fn(async (..._a: any[]): Promise<any> => null),
    getDel: jest.fn(async (..._a: any[]): Promise<any> => null),
    pTTL: jest.fn(async (..._a: any[]): Promise<any> => -2),
    incr: jest.fn(async (..._a: any[]): Promise<any> => 1),
    incrBy: jest.fn(async (..._a: any[]): Promise<any> => 1),
    expire: jest.fn(async (..._a: any[]) => {}),
    decr: jest.fn(async (..._a: any[]) => {}),
  },
}));

const mockGetChatAutonomy = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../platform/autonomy.service', () => ({
  __esModule: true,
  getChatAutonomy: (...a: any[]) => mockGetChatAutonomy(...a),
}));

jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: jest.fn(async (..._a: any[]) => {}),
  sweepHookEvents: jest.fn(async (..._a: any[]) => {}),
}));

jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: jest.fn(async (..._a: any[]) => ({ started: true })),
}));

jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: jest.fn((..._a: any[]): string | null => 'chat:s1'),
  chatRunKey: (id: string) => `chat:${id}`,
}));

const mockQueueStoppedScheduleAlert = jest.fn((..._a: any[]) => {});
const mockMaybeFileStoppedScheduleDecision = jest.fn(async (..._a: any[]) => ({ filed: false, reason: 'lane_alive' }));
jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: (...a: any[]) => mockQueueStoppedScheduleAlert(...a),
  maybeFileStoppedScheduleDecision: (...a: any[]) => mockMaybeFileStoppedScheduleDecision(...a),
}));

const mockResolveStoppedForSession = jest.fn(async (..._a: any[]) => 0);
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  resolveStoppedScheduleDecisionsForSession: (...a: any[]) => mockResolveStoppedForSession(...a),
}));

const mockGetPlanStrict = jest.fn(async (..._a: any[]) => null as any);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service') as any),
  getPlanStrict: (...a: any[]) => mockGetPlanStrict(...a),
}));

const mockRecordLoopMetric = jest.fn((..._a: any[]) => {});
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked',
    SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', SCHEDULE_BUSY_ALARM: 'schedule_busy_alarm',
    PROBE_MISS: 'probe_miss', PROMPT_REWRITE_CAP: 'prompt_rewrite_cap',
    SCHEDULE_CAP_CADENCE: 'schedule_cap_cadence',
    SCHEDULE_ONCE_RETIME: 'schedule_once_retime',
  },
}));

import { updateScheduleForUser, maybeRenewOnExhaustion, MIN_INTERVAL_SEC } from './schedule.service';
import logger from '../../../utils/logger';

const retimeLines = (): string[] => (logger.info as jest.Mock).mock.calls.map((c: any[]) => String(c[0])).filter((line) => line.includes('retimed one-shot'));

/** The incident row's shape: a live machine-authored one-shot (d2e1f633). */
function onceRowRef() {
  return {
    id: 'sched_d2e1f633', sessionId: 'f5c2c1f4', userId: 'u1',
    prompt: 'ETA DELIVERY firing (owner asked "eta?" 22:05Z)', kind: 'once',
    intervalSec: 1620, nextRunAt: new Date(Date.now() + 1620_000), enabled: true,
    runsCount: 0, maxRuns: 1, expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000),
    lastFiredAt: null, lastStatus: null, createdAt: new Date(),
    promptSetBy: 'machine', cancelledBy: null, disabledAt: null, busySkips: 0,
  };
}

/** The capture surface: what the update actually wrote. */
let written: any = null;

describe('updateScheduleForUser: once-row retime (Fleet incident 2026-09-21, ticket 82c13b77)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-21T22:20:00.000Z'));
    written = null;
    mockFindFirst.mockImplementation(async () => onceRowRef());
    mockUpdate.mockImplementation(async ({ data }: any) => {
      written = data; // the update PAYLOAD — what actually gets written
      return { ...onceRowRef(), ...data };
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('REPLAYS the incident: intervalMinutes on a once row RETIMES it — nextRunAt moves to now + interval, kind stays once', async () => {
    const r = await updateScheduleForUser('u1', 'sched_d2e1f633', { intervalSec: 1620, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // The retime: the single firing moves. The incident's silent no-op left
    // nextRunAt untouched while claiming success.
    expect(written.nextRunAt).toEqual(new Date('2026-09-21T22:47:00.000Z')); // 22:20 + 27 min
    // The row's kind is NEVER rewritten by an update (immutable contract).
    expect(written.kind).toBeUndefined(); // not in the update payload at all
    expect(written.intervalSec).toBe(1620);
    // Observable: the retime is logged once, naming the row.
    expect(retimeLines()).toHaveLength(1);
    expect(retimeLines()[0]).toContain('sched_d2e1f633');
  });

  it('a combined prompt+interval update on a once row retimes AND rewrites (no silent drop of either half)', async () => {
    const r = await updateScheduleForUser('u1', 'sched_d2e1f633', {
      prompt: 're-armed ETA delivery (owner pace 17:44Z)',
      intervalSec: 900,
      promptSetBy: 'machine',
    });
    expect(r.ok).toBe(true);
    expect(written.prompt).toBe('re-armed ETA delivery (owner pace 17:44Z)');
    expect(written.nextRunAt).toEqual(new Date('2026-09-21T22:35:00.000Z')); // 22:20 + 15 min
  });

  it('the sub-15-minute interval refusal still fires on a once row (the incident churn tried short retimes)', async () => {
    for (const bad of [180, 540]) {
      const r = await updateScheduleForUser('u1', 'sched_d2e1f633', { intervalSec: bad });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/at least 15 minutes/);
    }
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(MIN_INTERVAL_SEC).toBe(900);
  });

  it('review C1: a retime landing PAST expiresAt is refused — the row would be disabled expired without ever firing', async () => {
    // expiresAt is a hard ceiling the sweeper enforces BEFORE firing; a retime
    // past it must never return ok:true for a row that can never fire (the
    // new lost-firing mode the adversarial review caught on 2026-09-22).
    const near = { ...onceRowRef(), expiresAt: new Date('2026-09-21T23:00:00.000Z') }; // 40 min out
    mockFindFirst.mockImplementation(async () => near);
    const r = await updateScheduleForUser('u1', 'sched_d2e1f633', { intervalSec: 43200 }); // +12 h > expiry
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lifetime expires/);
    expect(r.error).toMatch(/disabled 'expired' WITHOUT ever firing/);
    expect(r.error).toMatch(/Nothing was updated/);
    expect(mockUpdate).not.toHaveBeenCalled();
    // A retime that lands BEFORE the ceiling still arms clean.
    const ok = await updateScheduleForUser('u1', 'sched_d2e1f633', { intervalSec: 1800 }); // +30 min < 40 min
    expect(ok.ok).toBe(true);
    expect(written.nextRunAt).toEqual(new Date('2026-09-21T22:50:00.000Z'));
  });

  it('review C3: the retimed line is logged only AFTER the write — a later whole-update refusal never reports a retime that did not land', async () => {
    // deltaGate on a once row is refused later in the same call (whole-update
    // refusal) — the old code had already emitted outcome:'retimed' by then.
    const r = await updateScheduleForUser('u1', 'sched_d2e1f633', {
      intervalSec: 1620,
      deltaGate: { probes: [{ url: 'https://example.com', pattern: 'x' }] } as any,
    });
    expect(r.ok).toBe(false); // the deltaGate refusal wins
    expect(mockUpdate).not.toHaveBeenCalled();
    // ...and NO 'retimed' line was logged for a retime that never landed.
    expect(retimeLines()).toHaveLength(0);
  });

  it('a retimed once row still cannot re-fire: renewal refuses non-recurring rows (the feared spam loop stays impossible)', async () => {
    // maybeRenewOnExhaustion is the only path that could turn a spent row into
    // a recurring successor — it refuses kind !== 'recurring'.
    const { runsCount: _rc, ...renewRow } = onceRowRef();
    const successor = await maybeRenewOnExhaustion({ ...renewRow, runsCount: 1 } as any);
    expect(successor).toBeNull();
    // And the sweeper's spent predicate (schedule.service line ~825): a once
    // row is spent at runsCount >= 1.
    const spent = (row: { kind: string; runsCount: number; maxRuns: number | null }) =>
      (row.maxRuns != null && row.runsCount >= row.maxRuns) || (row.kind === 'once' && row.runsCount >= 1);
    expect(spent({ kind: 'once', runsCount: 1, maxRuns: 1 })).toBe(true);
    expect(spent({ kind: 'once', runsCount: 0, maxRuns: 1 })).toBe(false);
  });
});

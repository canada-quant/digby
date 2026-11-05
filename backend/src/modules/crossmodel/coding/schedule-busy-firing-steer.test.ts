jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockScheduleFindUnique = jest.fn(async (..._args: any[]): Promise<any> => ({ enabled: true }));
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-cont-1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockChatFindUnique = jest.fn();
const mockChatUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockMsgCreate = jest.fn(async (..._a: any[]) => ({}));
const mockPromptHistoryCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'ph-1' }));
const mockPromptHistoryCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockScheduleUpdate = jest.fn(async (..._a: any[]): Promise<any> => ({}));
const mockScheduleUpdateMany = jest.fn(async (..._a: any[]): Promise<any> => ({ count: 1 }));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: {
      findUnique: (...a: any[]) => mockScheduleFindUnique(...a),
      update: (...a: any[]) => mockScheduleUpdate(...a),
      updateMany: (...a: any[]) => mockScheduleUpdateMany(...a),
    },
    agentRun: {
      findFirst: (...a: any[]) => mockRunFindFirst(...a),
      create: (...a: any[]) => mockRunCreate(...a),
      count: (...a: any[]) => mockRunCount(...a),
    },
    schedulePromptHistory: {
      create: (...a: any[]) => mockPromptHistoryCreate(...a),
      count: (...a: any[]) => mockPromptHistoryCount(...a),
      findFirst: (...a: any[]) => mockPromptHistoryFindFirst(...a),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), update: (...a: any[]) => mockChatUpdate(...a) },
    crossModelMessage: { create: (...a: any[]) => mockMsgCreate(...a) },
  },
}));

const mockSet = jest.fn(async (..._args: any[]): Promise<any> => 'OK');
const mockRedisDel = jest.fn(async (..._args: any[]): Promise<any> => 1);
const mockGet = jest.fn(async (..._args: any[]): Promise<any> => null);
const mockGetDel = jest.fn(async (..._args: any[]): Promise<any> => null);
const mockPTtl = jest.fn(async (..._args: any[]): Promise<any> => -2);
const mockIncr = jest.fn(async (..._args: any[]): Promise<any> => 1);
const mockIncrBy = jest.fn(async (..._args: any[]): Promise<any> => 1);
const mockExpire = jest.fn(async (..._args: any[]) => {});
const mockDecr = jest.fn(async (..._args: any[]) => {});
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

const mockGetChatAutonomy = jest.fn(async (..._a: any[]): Promise<any> => null);
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

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked', SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', SCHEDULE_BUSY_ALARM: 'schedule_busy_alarm', PROBE_MISS: 'probe_miss', PROMPT_REWRITE_CAP: 'prompt_rewrite_cap', WAKE_QUEUE_RIDER: 'wake_queue_rider', BUSY_FIRING_STEERED: 'busy_firing_steered' },
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

const mockGetPlanStrict = jest.fn(async (..._args: any[]) => null as any);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: (...a: any[]) => mockGetPlanStrict(...a),
}));

// The coding-harness fire path (dynamic import in fireScheduleTarget).
const mockStartScheduledRun = jest.fn(async (..._args: any[]) => ({ started: true }) as any);
const mockSteerActiveRun = jest.fn(async (..._a: any[]): Promise<any> => ({ steered: false, reason: 'no_active_run' }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
  steerActiveRun: (...a: any[]) => mockSteerActiveRun(...a),
}));

// The plain-chat fire path (dynamic import in fireScheduleTarget) — mocked at the
// The plain-chat fire path (dynamic import in fireScheduleTarget).
const mockStartDetachedChatRun = jest.fn((..._args: any[]): string | null => 'chat:s1');
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatRunKey: (id: string) => `chat:${id}`,
}));

// The busy-chat queue: the rider peek/consume + the queue-behind-busy enqueue.
const mockEnqueueChatMessage = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'pend-1', position: 1 }));
const mockPeekWakeRider = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockConsumeWakeRider = jest.fn(async (...a: any[]): Promise<number> => a[0].rows.length);
jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  enqueueChatMessage: (...a: any[]) => mockEnqueueChatMessage(...a),
  peekWakeRider: (...a: any[]) => mockPeekWakeRider(...a),
  consumeWakeRider: (...a: any[]) => mockConsumeWakeRider(...a),
}));

const mockConsumeSpendSkip = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockRestoreSpendSkip = jest.fn(async (..._a: any[]) => {});
jest.mock('./spend-cap.service', () => ({
  __esModule: true,
  consumeSpendCapSkipNotice: (...a: any[]) => mockConsumeSpendSkip(...a),
  restoreSpendCapSkipNotice: (...a: any[]) => mockRestoreSpendSkip(...a),
  spendSkipNoticeText: (n: number) => `${n} spend-capped firing(s)`,
}));

import { fireScheduleTarget, busyFiringSteerHeader } from './schedule.service';

/**
 * Busy-session firing STEER (owner 2026-09-24 "waiting too long"): a schedule
 * firing or hook wake on a CODING session with an active run is delivered into
 * that run as a steer (steerActiveRun, origin-stamped) and counted as a real
 * firing — no queued run, no busy-skip. Pins: steer wins when active; the
 * header names the trigger and says it is not the user; idle → the normal run
 * start; a steer probe failure never blocks the firing.
 */
describe('busy-session firing steer', () => {
  beforeEach(() => {
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', archivedAt: null, codingState: { id: 'cs1' } });
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
    mockSteerActiveRun.mockReset().mockResolvedValue({ steered: false, reason: 'no_active_run' });
    mockRecordLoopMetric.mockClear();
    mockScheduleFindUnique.mockReset().mockResolvedValue({ enabled: true, kind: 'recurring', runsCount: 1, maxRuns: null, expiresAt: null, lastFiredAt: null, promptSetBy: null });
  });

  it('an active run takes the schedule firing as a STEER: started+steered, no run queued, header + prompt + origin', async () => {
    mockSteerActiveRun.mockResolvedValue({ steered: true });
    const res = await fireScheduleTarget({ id: 'sch_busy1', sessionId: 's1', prompt: 'check the build and report' });
    expect(res).toEqual({ started: true, steered: true });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    const [sid, text, opts] = mockSteerActiveRun.mock.calls[0];
    expect(sid).toBe('s1');
    expect(text.startsWith(busyFiringSteerHeader('schedule', 'sch_busy1'))).toBe(true);
    expect(text).toContain('NOT typed by the user');
    expect(text).toContain('check the build and report');
    expect(opts).toEqual({ origin: 'schedule' });
  });

  it('a hook wake steers with the FLEET EVENT WAKE header and origin hook', async () => {
    mockSteerActiveRun.mockResolvedValue({ steered: true, reason: 'answered_question' });
    const res = await fireScheduleTarget({ id: 'hook-h1', sessionId: 's1', prompt: 'Your sub-session reported run_completed', origin: 'hook' });
    expect(res).toEqual({ started: true, steered: true });
    const [, text, opts] = mockSteerActiveRun.mock.calls[0];
    expect(text).toContain('FLEET EVENT WAKE');
    expect(opts).toEqual({ origin: 'hook' });
  });

  it('idle session → the normal run start (steer probe reported no active run)', async () => {
    const res = await fireScheduleTarget({ id: 'sch_idle', sessionId: 's1', prompt: 'tick' });
    expect(res).toEqual({ started: true });
    expect(mockSteerActiveRun).toHaveBeenCalledTimes(1);
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
  });

  it('a probe failure falls back to the run start', async () => {
    mockSteerActiveRun.mockRejectedValue(new Error('redis down'));
    const res = await fireScheduleTarget({ id: 'sch_e', sessionId: 's1', prompt: 'tick' });
    expect(res).toEqual({ started: true });
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
  });
});

/**
 * audit 2026-10-06 T4-7 (others.md F14): a ONE-SHOT armed while the session's
 * current run was already active is that run's own follow-up ("clean
 * re-delivery" of a digest) — it is QUEUED behind the run, never steered into
 * it. One-shots armed before the run started steer as before; kill switch
 * BUSY_STEER_OWN_ONESHOT_QUEUE_DISABLED=1.
 */
describe('T4-7 — a run\'s own follow-up one-shot is queued, not steered', () => {
  const NOW = Date.now();
  beforeEach(() => {
    delete process.env.BUSY_STEER_OWN_ONESHOT_QUEUE_DISABLED;
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', archivedAt: null, codingState: { id: 'cs1' } });
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true, queued: true });
    mockSteerActiveRun.mockReset().mockResolvedValue({ steered: true });
    mockRecordLoopMetric.mockClear();
    mockRunFindFirst.mockReset().mockResolvedValue({ id: 'run-digest', createdAt: new Date(NOW - 61 * 60_000), startedAt: new Date(NOW - 60 * 60_000) });
  });
  afterEach(() => { delete process.env.BUSY_STEER_OWN_ONESHOT_QUEUE_DISABLED; });

  it('armed DURING the active run → no steer; queue-behind-busy start + metric', async () => {
    mockScheduleFindUnique.mockReset().mockResolvedValue({ enabled: true, kind: 'once', runsCount: 0, maxRuns: 1, expiresAt: null, lastFiredAt: null, promptSetBy: 'machine', createdAt: new Date(NOW - 20 * 60_000) });
    const res = await fireScheduleTarget({ id: 'sch_redeliver', sessionId: 's1', prompt: 'Clean re-delivery of today\'s digest' });
    expect(mockSteerActiveRun).not.toHaveBeenCalled();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(mockStartScheduledRun.mock.calls[0][2]).toMatchObject({ queueBehindBusy: true, scheduleId: 'sch_redeliver' });
    expect(res).toMatchObject({ started: true, queued: true });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'busy_steer_own_oneshot_queued', meta: expect.objectContaining({ scheduleId: 'sch_redeliver', runId: 'run-digest' }) }));
  });

  it('armed BEFORE the active run started → steered as before', async () => {
    mockScheduleFindUnique.mockReset().mockResolvedValue({ enabled: true, kind: 'once', runsCount: 0, maxRuns: 1, expiresAt: null, lastFiredAt: null, promptSetBy: 'machine', createdAt: new Date(NOW - 3 * 3600_000) });
    const res = await fireScheduleTarget({ id: 'sch_old', sessionId: 's1', prompt: 'check back' });
    expect(res).toEqual({ started: true, steered: true });
    expect(mockSteerActiveRun).toHaveBeenCalledTimes(1);
  });

  it('kill switch BUSY_STEER_OWN_ONESHOT_QUEUE_DISABLED=1 → steered into the run again', async () => {
    process.env.BUSY_STEER_OWN_ONESHOT_QUEUE_DISABLED = '1';
    mockScheduleFindUnique.mockReset().mockResolvedValue({ enabled: true, kind: 'once', runsCount: 0, maxRuns: 1, expiresAt: null, lastFiredAt: null, promptSetBy: 'machine', createdAt: new Date(NOW - 20 * 60_000) });
    const res = await fireScheduleTarget({ id: 'sch_redeliver', sessionId: 's1', prompt: 'Clean re-delivery' });
    expect(res).toEqual({ started: true, steered: true });
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'busy_steer_own_oneshot_queued' }));
  });
});

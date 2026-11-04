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
    codingSchedule: {
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
  LOOP_METRIC_KINDS: { WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked', SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', SCHEDULE_BUSY_ALARM: 'schedule_busy_alarm', PROBE_MISS: 'probe_miss', PROMPT_REWRITE_CAP: 'prompt_rewrite_cap', WAKE_QUEUE_RIDER: 'wake_queue_rider' },
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
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
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

import { fireScheduleTarget } from './schedule.service';

/**
 * Queued report-up RIDER on plain-chat wakes (hardening loop iteration 7,
 * 2026-09-24): a hook/schedule wake that finds AGENT rows queued behind the
 * busy chat carries them in the same turn and deletes them after the run
 * STARTS. Pins: rider text rides the started message (before nothing else is
 * lost); consume + depth stamp + metric only after a successful start; a busy
 * start leaves the rows; the queue-behind-busy fallback enqueues the message
 * WITHOUT the rider; no rider = byte-identical message.
 */
describe('plain-chat wake rider (hardening loop iteration 7)', () => {
  const rider = { rows: [{ id: 'p1' }, { id: 'p2' }], text: '[QUEUED WHILE BUSY — 2 agent message(s) …]\n\nA\n\n— — —\n\nB', maxDepth: 2, remaining: 0 };
  beforeEach(() => {
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'thinking', archivedAt: null, codingState: null });
    mockStartDetachedChatRun.mockReset().mockReturnValue('chat:s1');
    mockPeekWakeRider.mockReset().mockResolvedValue(null);
    mockConsumeWakeRider.mockReset().mockImplementation(async (...a: any[]) => a[0].rows.length);
    mockEnqueueChatMessage.mockReset().mockResolvedValue({ id: 'pend-1', position: 1 });
    mockRecordLoopMetric.mockClear();
    mockScheduleFindUnique.mockReset().mockResolvedValue({ enabled: true, kind: 'recurring', runsCount: 1, maxRuns: null, expiresAt: null, lastFiredAt: null, promptSetBy: null });
  });

  it('a hook wake carries the rider, then consumes the rows and records wake_queue_rider', async () => {
    mockPeekWakeRider.mockResolvedValue(rider);
    const res = await fireScheduleTarget({ id: 'hook-h1', sessionId: 's1', prompt: 'Your lane reported run_completed', origin: 'hook' });
    expect(res).toEqual({ started: true });
    const args = mockStartDetachedChatRun.mock.calls[0][0];
    expect(args.message.startsWith('Your lane reported run_completed')).toBe(true);
    expect(args.message).toContain(rider.text);
    expect(args.messageOrigin).toBe('hook');
    expect(mockConsumeWakeRider).toHaveBeenCalledWith(rider);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wake_queue_rider', sessionId: 's1', value: 2, meta: expect.objectContaining({ origin: 'hook', hookId: 'hook-h1', remaining: 0 }) }));
  });

  it('a busy start (null) leaves the rows queued — no consume, no metric', async () => {
    mockPeekWakeRider.mockResolvedValue(rider);
    mockStartDetachedChatRun.mockReturnValue(null);
    const res = await fireScheduleTarget({ id: 'hook-h2', sessionId: 's1', prompt: 'wake', origin: 'hook' });
    expect(res).toEqual({ started: false, reason: 'busy' });
    expect(mockConsumeWakeRider).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'wake_queue_rider' }));
  });

  it('a ONE-SHOT schedule that finds the chat busy enqueues the message WITHOUT the rider (the rows stay queued on their own)', async () => {
    mockScheduleFindUnique.mockResolvedValue({ enabled: true, kind: 'once', runsCount: 0, maxRuns: 1, expiresAt: null, lastFiredAt: null, promptSetBy: null });
    mockPeekWakeRider.mockResolvedValue(rider);
    mockStartDetachedChatRun.mockReturnValue(null);
    const res = await fireScheduleTarget({ id: 'sch_once', sessionId: 's1', prompt: 'check back on the outage' });
    expect(res).toEqual({ started: true, queued: true });
    const enq = mockEnqueueChatMessage.mock.calls[0][0];
    expect(enq.content).toContain('check back on the outage');
    expect(enq.content).not.toContain('QUEUED WHILE BUSY');
    expect(mockConsumeWakeRider).not.toHaveBeenCalled();
  });

  it('no rider → the started message is exactly the wake message (no wrapper, no metric)', async () => {
    const res = await fireScheduleTarget({ id: 'sch_r', sessionId: 's1', prompt: 'tick' });
    expect(res).toEqual({ started: true });
    const args = mockStartDetachedChatRun.mock.calls[0][0];
    expect(args.message).not.toContain('QUEUED WHILE BUSY');
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'wake_queue_rider' }));
  });
});

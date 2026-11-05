/**
 * Replay pin — ticket 3405e332 (2026-09-17 one-shot schedule drift incident).
 *
 * Incident: one-shot deferred-action schedules on BUSY chats drifted hours past
 * their intended fire time — schedule 7a7deedb (armed ~06:24Z as a 90-minute
 * check-back) showed runs 0/1 "last skipped:busy" with a next fire of 14:54Z
 * (~7h late); schedule 0283acd6 drifted 3+h the same way. Root cause: on a busy
 * fire the sweeper only re-armed nextRunAt = now + 3 min (schedule.service.ts),
 * so a continuously-busy lane (the Fleet Supervisor chat) NEVER let the
 * one-shot start — and the trigger condition went stale while it waited.
 *
 * Fix (this file pins the fireScheduleTarget layer): a kind:'once' firing on a
 * busy lane QUEUES behind the active run instead of skipping —
 *   - coding session: startScheduledRun gets queueBehindBusy:true and inserts
 *     the run as a queued agent_runs row (coding-stream.controller.3405e332.test.ts);
 *   - plain chat: the firing enqueues into pending_chat_messages with
 *     source/origin 'schedule' and the drain replays it as a machine wake
 *     (message-queue.schedule-drain.3405e332.test.ts).
 * RECURRING schedules and hook wakes never queue (pile-up guard) — they keep
 * the 3-min busy re-arm.
 *
 * Mock boundary mirrors schedule.service.test.ts (colocated mock-everything
 * pattern); only the fireScheduleTarget surface is exercised.
 */

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
  LOOP_METRIC_KINDS: { WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked', SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', SCHEDULE_BUSY_ALARM: 'schedule_busy_alarm', PROBE_MISS: 'probe_miss', PROMPT_REWRITE_CAP: 'prompt_rewrite_cap' },
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
// module boundary so the real chat-agent import graph (config/env) never loads.
const mockStartDetachedChatRun = jest.fn((..._args: any[]): string | null => 'chat:s1');
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatRunKey: (id: string) => `chat:${id}`,
}));

// The busy-chat message queue (dynamic import on the queue-behind-busy path) —
// the unit under test HERE is that fireScheduleTarget enqueues correctly; the
// queue's own behavior is pinned by message-queue.schedule-drain.3405e332.test.ts.
const mockEnqueueChatMessage = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'pend-1', position: 1 }));
jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  enqueueChatMessage: (...a: any[]) => mockEnqueueChatMessage(...a),
}));

// Spend-skip notice channel (dynamic import on the plain-chat fire path).
const mockConsumeSpendSkip = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockRestoreSpendSkip = jest.fn(async (..._a: any[]) => {});
jest.mock('./spend-cap.service', () => ({
  __esModule: true,
  consumeSpendCapSkipNotice: (...a: any[]) => mockConsumeSpendSkip(...a),
  restoreSpendCapSkipNotice: (...a: any[]) => mockRestoreSpendSkip(...a),
  spendSkipNoticeText: (n: number) => `${n} spend-capped firing(s)`,
}));

import { fireScheduleTarget } from './schedule.service';

describe('queue-behind-busy for one-shot firings (ticket 3405e332)', () => {
  const onceRow = { enabled: true, kind: 'once', runsCount: 0, maxRuns: 1, expiresAt: null, lastFiredAt: null };
  const recurringRow = { enabled: true, kind: 'recurring', runsCount: 3, maxRuns: 500, expiresAt: null, lastFiredAt: null };

  beforeEach(() => {
    mockScheduleFindUnique.mockClear(); // keep the {enabled:true} default; tests override
    mockChatFindUnique.mockReset();
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
    mockStartDetachedChatRun.mockReset().mockReturnValue('chat:s1');
    mockEnqueueChatMessage.mockReset().mockResolvedValue({ id: 'pend-1', position: 1 });
    mockRecordLoopMetric.mockClear();
    mockGetDel.mockReset().mockResolvedValue(null);
    mockIncrBy.mockClear();
  });

  it('coding lane: a ONE-SHOT firing passes queueBehindBusy so a busy session queues behind the active run', async () => {
    mockScheduleFindUnique.mockResolvedValue(onceRow);
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockStartScheduledRun.mockResolvedValue({ started: true, queued: true });
    const res = await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'check back on the outage' });
    expect(res).toEqual({ started: true, queued: true });
    expect(mockStartScheduledRun).toHaveBeenCalledWith(
      's1', expect.stringContaining('check back on the outage'),
      expect.objectContaining({ origin: 'schedule', scheduleId: 'sch_1', queueBehindBusy: true }),
    );
  });

  it('coding lane: a RECURRING firing never gets queueBehindBusy (pile-up guard)', async () => {
    mockScheduleFindUnique.mockResolvedValue(recurringRow);
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    const res = await fireScheduleTarget({ id: 'sch_r', sessionId: 's1', prompt: 'tick' });
    expect(res).toEqual({ started: true });
    expect(mockStartScheduledRun.mock.calls[0][2].queueBehindBusy).toBeUndefined();
  });

  it('REPLAY: a busy plain-chat ONE-SHOT enqueues into pending_chat_messages (source/origin schedule) and reports queued', async () => {
    mockScheduleFindUnique.mockResolvedValue(onceRow);
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast' }); // no codingState → plain chat
    mockStartDetachedChatRun.mockReturnValue(null); // the incident shape: chat busy at fire time
    const res = await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'check back on the provider outage' });
    expect(res).toEqual({ started: true, queued: true });
    expect(mockEnqueueChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1',
      userId: 'u1',
      source: 'schedule',
      content: expect.stringContaining('check back on the provider outage'),
      origin: { kind: 'schedule', scheduleId: 'sch_1' },
    }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'wake_delivered',
      sessionId: 's1',
      meta: expect.objectContaining({ lane: 'schedule_queue_behind_busy', scheduleId: 'sch_1', pendingId: 'pend-1' }),
    }));
  });

  it('a consumed cap-skip notice is NOT restored when the firing queued — it rides the queued message', async () => {
    mockScheduleFindUnique.mockResolvedValue(onceRow);
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast' });
    mockStartDetachedChatRun.mockReturnValue(null);
    // The cap-skip key is `coding:sched:skipnotice:<session>`; probe/spend keys differ.
    mockGetDel.mockImplementation(async (k: string) => (String(k).includes('skipnotice') ? '2' : null));
    const res = await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'do the thing' });
    expect(res).toEqual({ started: true, queued: true });
    expect(mockIncrBy).not.toHaveBeenCalled(); // restoreCapSkipNotice never ran
    expect(mockEnqueueChatMessage.mock.calls[0][0].content).toContain('[SCHEDULER NOTICE] 2 scheduled firing(s)');
  });

  it('an enqueue failure (full queue / error) falls back to the busy skip — nothing is lost', async () => {
    mockScheduleFindUnique.mockResolvedValue(onceRow);
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast' });
    mockStartDetachedChatRun.mockReturnValue(null);
    mockEnqueueChatMessage.mockRejectedValue(new Error('Message queue is full for this chat (20 pending)'));
    const res = await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'do the thing' });
    expect(res).toEqual({ started: false, reason: 'busy' });
  });

  it('plain chat: a RECURRING firing never enqueues — the 3-min re-arm still owns busy retries', async () => {
    mockScheduleFindUnique.mockResolvedValue(recurringRow);
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast' });
    mockStartDetachedChatRun.mockReturnValue(null);
    const res = await fireScheduleTarget({ id: 'sch_r', sessionId: 's1', prompt: 'tick' });
    expect(res).toEqual({ started: false, reason: 'busy' });
    expect(mockEnqueueChatMessage).not.toHaveBeenCalled();
  });

  it('hook wakes never enqueue (synthetic hook-* ids have no schedule row)', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast' });
    mockStartDetachedChatRun.mockReturnValue(null);
    const res = await fireScheduleTarget({ id: 'hook-9', sessionId: 's1', prompt: 'wake up', origin: 'hook' });
    expect(res).toEqual({ started: false, reason: 'busy' });
    expect(mockEnqueueChatMessage).not.toHaveBeenCalled();
    expect(mockScheduleFindUnique).not.toHaveBeenCalled();
  });
});

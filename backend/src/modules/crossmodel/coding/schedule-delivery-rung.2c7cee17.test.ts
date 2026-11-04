jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockScheduleFindUnique = jest.fn(async (..._args: any[]): Promise<any> => ({ enabled: true }));
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockChatFindUnique = jest.fn();
const mockScheduleUpdate = jest.fn(async (..._a: any[]): Promise<any> => ({}));
const mockScheduleUpdateMany = jest.fn(async (..._a: any[]): Promise<any> => ({ count: 1 }));
const mockPromptHistoryCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'ph-1' }));
const mockPromptHistoryCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    codingSchedule: {
      findUnique: (...a: any[]) => mockScheduleFindUnique(...a),
      update: (...a: any[]) => mockScheduleUpdate(...a),
      updateMany: (...a: any[]) => mockScheduleUpdateMany(...a),
    },
    agentRun: { findFirst: (...a: any[]) => mockRunFindFirst(...a) },
    schedulePromptHistory: {
      create: (...a: any[]) => mockPromptHistoryCreate(...a),
      count: (...a: any[]) => mockPromptHistoryCount(...a),
      findFirst: (...a: any[]) => mockPromptHistoryFindFirst(...a),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
  },
}));

const mockSet = jest.fn(async (..._args: any[]): Promise<any> => 'OK');
const mockGet = jest.fn(async (..._args: any[]): Promise<any> => null);
const mockIncr = jest.fn(async (..._args: any[]): Promise<any> => 1);
const mockExpire = jest.fn(async (..._a: any[]) => {});
const mockDel = jest.fn(async (..._a: any[]): Promise<any> => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: (...a: any[]) => mockSet(...a), del: (...a: any[]) => mockDel(...a),
    get: (...a: any[]) => mockGet(...a),
    incr: (...a: any[]) => mockIncr(...a), expire: (...a: any[]) => mockExpire(...a),
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
const mockMaybeFileStoppedScheduleDecision = jest.fn(async (..._a: any[]): Promise<any> => ({ filed: false, reason: 'lane_alive' }));
jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: (...a: any[]) => mockQueueStoppedScheduleAlert(...a),
  maybeFileStoppedScheduleDecision: (...a: any[]) => mockMaybeFileStoppedScheduleDecision(...a),
}));

const mockResolveStoppedForSession = jest.fn(async (..._a: any[]): Promise<any> => 0);
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  resolveStoppedScheduleDecisionsForSession: (...a: any[]) => mockResolveStoppedForSession(...a),
}));

const mockGetPlanStrict = jest.fn(async (..._args: any[]): Promise<any> => null as any);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: (...a: any[]) => mockGetPlanStrict(...a),
}));

// The coding-harness fire path (dynamic import in fireScheduleTarget).
const mockStartScheduledRun = jest.fn(async (..._args: any[]): Promise<any> => ({ started: true }) as any);
const mockSteerActiveRun = jest.fn(async (..._a: any[]): Promise<any> => ({ steered: false, reason: 'no_active_run' }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
  steerActiveRun: (...a: any[]) => mockSteerActiveRun(...a),
}));

const mockStartDetachedChatRun = jest.fn((..._args: any[]): string | null => 'chat:s1');
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
}));

const mockConsumeWakeRider = jest.fn(async (...a: any[]): Promise<number> => a[0].rows.length);
const mockEnqueueChatMessage = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'q1' }));
const mockPeekWakeRider = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  enqueueChatMessage: (...a: any[]) => mockEnqueueChatMessage(...a),
  peekWakeRider: (...a: any[]) => mockPeekWakeRider(...a),
  consumeWakeRider: (...a: any[]) => mockConsumeWakeRider(...a),
}));

const mockConsumeSpendSkip = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockRestoreSpendSkip = jest.fn(async (..._a: any[]): Promise<void> => {});
jest.mock('./spend-cap.service', () => ({
  __esModule: true,
  consumeSpendCapSkipNotice: (...a: any[]) => mockConsumeSpendSkip(...a),
  restoreSpendCapSkipNotice: (...a: any[]) => mockRestoreSpendSkip(...a),
  spendSkipNoticeText: (n: number) => `${n} spend-capped firing(s)`,
}));

import { fireScheduleTarget, isZeroToolDeliveryPrompt } from './schedule.service';

/**
 * Ticket 2c7cee17 (bug_report, 2026-10-09): the digest task's zero-tool
 * "ONE-SHOT CLEAN RE-DELIVERY" rung (schedule 23323ecd, armed +15m per the
 * digest row's step 5) fired at 14:51:40Z while an unrelated machine run on
 * the same chat (ladder-verify rung e3d3555f, started 14:49Z) was active,
 * and the platform delivered the firing INTO that run as a busy-session
 * steer (msg 701b5fd6: "[MACHINE-TRIGGERED SCHEDULED FIRING (23323ecd-875a)
 * — … delivered INTO the run as a steer"). The steered run's final row
 * (aa62598f) was its verify report, not the digest — a clean standalone
 * digest row is structurally impossible while the firing is absorbed as a
 * steer, because ALL assistant turns of one run accumulate into ONE row.
 *
 * REPLAY (this file): the incident's EXACT stored prompt is fired at a chat
 * with an active run, with the schedule armed BEFORE the run started
 * (createdAt 14:36Z < run start 14:49Z) so the T4-7 arm-time carve-out alone
 * (schedule-busy-firing-steer.test.ts) does NOT catch it — the fix must
 * classify the PROMPT. The rung is queued behind the busy run, never steered.
 */
const INCIDENT_RUNG_PROMPT = [
  'ONE-SHOT CLEAN RE-DELIVERY — reply with the digest text below VERBATIM as your final answer, with NOTHING before it and NOTHING after it. Do NOT call any tools. Begin with the exact first character of the digest; end with its footer line. Do not schedule anything.',
  '=== BEGIN DIGEST ===',
  'AI Noise Digest — Friday, October 9, 2026',
  '⏱ IN 30 SECONDS',
  '…digest body…',
  '— Daily AI noise digest, delivered by Digby',
  '— Recurring row a685dba2 · next fire 2026-10-10T14:35:40Z',
  '=== END DIGEST ===',
].join('\n');

describe('isZeroToolDeliveryPrompt (2c7cee17) — the prompt-shape predicate', () => {
  afterEach(() => { delete process.env.BUSY_STEER_DELIVERY_RUNG_QUEUE_DISABLED; });

  it('matches the incident rung body verbatim (both markers present)', () => {
    expect(isZeroToolDeliveryPrompt(INCIDENT_RUNG_PROMPT)).toBe(true);
  });

  it('is case-insensitive on the directives and the fence', () => {
    const body = 'Re-delivery — reply with the text below verbatim.\nDo not call any tools\n--- BEGIN REPORT ---\npayload\n--- END REPORT ---';
    expect(isZeroToolDeliveryPrompt(body)).toBe(true);
  });

  it('a fenced delivery body WITHOUT the word "verbatim" still matches (review 2c7cee17 F1 — the fence is a real alternative, not dead code)', () => {
    const body = 'Clean re-delivery — post the digest below EXACTLY as written, nothing before or after.\nDo NOT call any tools.\n=== BEGIN DIGEST ===\ndigest body\n=== END DIGEST ===';
    expect(isZeroToolDeliveryPrompt(body)).toBe(true);
  });

  it('null / empty / mega-prompt bodies are never delivery rungs (pure + total)', () => {
    expect(isZeroToolDeliveryPrompt(null)).toBe(false);
    expect(isZeroToolDeliveryPrompt('')).toBe(false);
    expect(isZeroToolDeliveryPrompt(undefined)).toBe(false);
    expect(isZeroToolDeliveryPrompt(`${INCIDENT_RUNG_PROMPT}\n${'x'.repeat(200_001)}`)).toBe(false);
  });

  it('kill switch BUSY_STEER_DELIVERY_RUNG_QUEUE_DISABLED=1 disables the predicate', () => {
    process.env.BUSY_STEER_DELIVERY_RUNG_QUEUE_DISABLED = '1';
    expect(isZeroToolDeliveryPrompt(INCIDENT_RUNG_PROMPT)).toBe(false);
  });
});

describe('2c7cee17 — a zero-tool delivery rung firing on a busy chat is QUEUED, never steered', () => {
  beforeEach(() => {
    delete process.env.BUSY_STEER_DELIVERY_RUNG_QUEUE_DISABLED;
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', archivedAt: null, codingState: { id: 'cs1' } });
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true, queued: true });
    mockSteerActiveRun.mockReset().mockResolvedValue({ steered: true });
    mockRecordLoopMetric.mockClear();
    // The incident's active run: the ladder-verify rung e3d3555f started
    // 14:49Z — AFTER the re-delivery rung was armed (14:36Z), so the T4-7
    // arm-time carve-out returns false and only the prompt shape decides.
    mockRunFindFirst.mockReset().mockResolvedValue({ id: 'run-ladder', createdAt: new Date(Date.parse('2026-10-09T14:49:00Z')), startedAt: new Date(Date.parse('2026-10-09T14:49:05Z')) });
  });
  afterEach(() => { delete process.env.BUSY_STEER_DELIVERY_RUNG_QUEUE_DISABLED; });

  it('REPLAY the incident: the rung (armed BEFORE the active run started) fires while busy → no steer, queue-behind-busy start, metric row', async () => {
    mockScheduleFindUnique.mockReset().mockResolvedValue({
      enabled: true, kind: 'once', runsCount: 0, maxRuns: 1, expiresAt: null, lastFiredAt: null,
      promptSetBy: 'machine', createdAt: new Date(Date.parse('2026-10-09T14:36:40Z')), // armed +15m — BEFORE the run
      prompt: INCIDENT_RUNG_PROMPT,
    });
    const res = await fireScheduleTarget({ id: 'sch_redeliver_23323ecd', sessionId: 's1', prompt: INCIDENT_RUNG_PROMPT });

    expect(mockSteerActiveRun).not.toHaveBeenCalled();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(mockStartScheduledRun.mock.calls[0][2]).toMatchObject({ queueBehindBusy: true, scheduleId: 'sch_redeliver_23323ecd' });
    expect(res).toEqual({ started: true, queued: true });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'busy_steer_delivery_rung_queued',
      meta: expect.objectContaining({ scheduleId: 'sch_redeliver_23323ecd' }),
    }));
    // Short-circuit: the prompt predicate decided, so the T4-7 arm-time lookup
    // (one DB read) never runs for this branch.
    expect(mockRunFindFirst).not.toHaveBeenCalled();
  });

  it('armed DURING the active run (T4-7 shape) ALSO takes the queue path via the same predicate', async () => {
    mockScheduleFindUnique.mockReset().mockResolvedValue({
      enabled: true, kind: 'once', runsCount: 0, maxRuns: 1, expiresAt: null, lastFiredAt: null,
      promptSetBy: 'machine', createdAt: new Date(Date.parse('2026-10-09T14:55:00Z')), // after the run start
      prompt: INCIDENT_RUNG_PROMPT,
    });
    const res = await fireScheduleTarget({ id: 'sch_redeliver2', sessionId: 's1', prompt: INCIDENT_RUNG_PROMPT });
    expect(mockSteerActiveRun).not.toHaveBeenCalled();
    expect(res).toEqual({ started: true, queued: true });
  });

  it('CONTROL — an ordinary one-shot on the same busy chat still STEERS (2026-09-24 semantics untouched)', async () => {
    mockScheduleFindUnique.mockReset().mockResolvedValue({
      enabled: true, kind: 'once', runsCount: 0, maxRuns: 1, expiresAt: null, lastFiredAt: null,
      promptSetBy: 'machine', createdAt: new Date(Date.parse('2026-10-09T14:36:40Z')),
      prompt: 'check back on the deploy and report',
    });
    const res = await fireScheduleTarget({ id: 'sch_ordinary', sessionId: 's1', prompt: 'check back on the deploy and report' });
    expect(res).toEqual({ started: true, steered: true });
    expect(mockSteerActiveRun).toHaveBeenCalledTimes(1);
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'busy_steer_delivery_rung_queued' }));
  });

  it('CONTROL — a RECURRING digest row never matches (kind gate): it keeps the busy-steer dedupe path', async () => {
    mockScheduleFindUnique.mockReset().mockResolvedValue({
      enabled: true, kind: 'recurring', runsCount: 5, maxRuns: null, expiresAt: null, lastFiredAt: null,
      promptSetBy: 'user', ownerSubscribed: true, createdAt: new Date(Date.parse('2026-10-08T00:00:00Z')),
      prompt: INCIDENT_RUNG_PROMPT,
    });
    const res = await fireScheduleTarget({ id: 'sch_recurring_digest', sessionId: 's1', prompt: INCIDENT_RUNG_PROMPT });
    expect(res).toEqual({ started: true, steered: true });
    expect(mockSteerActiveRun).toHaveBeenCalledTimes(1);
  });

  it('CONTROL — a hook wake carrying a delivery-shaped body still steers (origin gate)', async () => {
    mockScheduleFindUnique.mockReset().mockResolvedValue(undefined); // hook ids have no schedule row
    const res = await fireScheduleTarget({ id: 'hook-h1', sessionId: 's1', prompt: INCIDENT_RUNG_PROMPT, origin: 'hook' });
    expect(res).toEqual({ started: true, steered: true });
    expect(mockSteerActiveRun).toHaveBeenCalledTimes(1);
  });

  it('CONTROL — kill switch BUSY_STEER_DELIVERY_RUNG_QUEUE_DISABLED=1 restores the steer (incident behavior)', async () => {
    process.env.BUSY_STEER_DELIVERY_RUNG_QUEUE_DISABLED = '1';
    mockScheduleFindUnique.mockReset().mockResolvedValue({
      enabled: true, kind: 'once', runsCount: 0, maxRuns: 1, expiresAt: null, lastFiredAt: null,
      promptSetBy: 'machine', createdAt: new Date(Date.parse('2026-10-09T14:36:40Z')),
      prompt: INCIDENT_RUNG_PROMPT,
    });
    const res = await fireScheduleTarget({ id: 'sch_redeliver3', sessionId: 's1', prompt: INCIDENT_RUNG_PROMPT });
    expect(res).toEqual({ started: true, steered: true });
    expect(mockSteerActiveRun).toHaveBeenCalledTimes(1);
  });
});

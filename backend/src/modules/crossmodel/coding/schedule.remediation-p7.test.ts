/**
 * Scheduler remediation P7 — pins for the program-model work:
 *   N7/S1a — spend-cap skip in the sweep (checked BEFORE the daily-cap token;
 *            lastStatus 'skipped:spend_cap' + hook event kind 'spend' + the
 *            7d owner card; DEFAULT OFF and fail-open)
 *   G13    — requiredProbes: parse/match pins, updateScheduleForUser
 *            validation, recordScheduleProbeMiss escalation (notice → 3-strike
 *            pause + owner card), fireScheduleTarget's next-firing notice.
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
const mockPromptHistoryFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockPromptHistoryCount = jest.fn(async (..._a: any[]): Promise<number> => 0);

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
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), update: (...a: any[]) => mockChatUpdate(...a) },
    crossModelMessage: { create: (...a: any[]) => mockMsgCreate(...a) },
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
// Busy-chat queue (dynamic import on the plain-chat fire path — the wake
// rider peek since hardening loop iteration 7, 2026-09-24, and the
// queue-behind-busy enqueue): mocked at the module boundary so the real
// module's error-handler → config/env chain never loads in this keyless env.
jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  enqueueChatMessage: jest.fn(async () => ({ id: 'pend-1', position: 1 })),
  peekWakeRider: jest.fn(async () => null),
  consumeWakeRider: jest.fn(async () => 0),
}));

jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatRunKey: (id: string) => `chat:${id}`,
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { WAKE_DELIVERED: 'wake_delivered', SWEEP_TICK: 'sweep_tick', SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', SCHEDULE_BUSY_ALARM: 'schedule_busy_alarm', PROBE_MISS: 'probe_miss', PROMPT_REWRITE_CAP: 'prompt_rewrite_cap' },
}));

jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: jest.fn(),
  maybeFileStoppedScheduleDecision: jest.fn(async () => ({ filed: false, reason: 'lane_alive' })),
}));

const mockFlagOwnerQuestion = jest.fn(async (..._a: any[]): Promise<any> => ({ kind: 'created', question: { id: 'oq_p7' } }));
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  resolveStoppedScheduleDecisionsForSession: jest.fn(async () => 0),
  flagOwnerQuestion: (...a: any[]) => mockFlagOwnerQuestion(...a),
}));

jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: jest.fn(async () => ({ steps: [{ status: 'pending' }] })),
}));

// Spend-cap boundary: the sweep composes with checkSpendCap/recordSpendCapSkip/
// maybeAskSpendCapQuestion — mocked HERE (the service's own math is covered in
// spend-cap.service.test.ts). requireActual keeps the notice helpers real for
// the fireScheduleTarget consume path.
const mockCheckSpendCap = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRecordSpendCapSkip = jest.fn(async (..._a: any[]) => {});
const mockMaybeAskSpendCapQuestion = jest.fn(async (..._a: any[]) => {});
const mockConsumeSpendCapSkipNotice = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockRestoreSpendCapSkipNotice = jest.fn(async (..._a: any[]) => {});
jest.mock('./spend-cap.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./spend-cap.service')),
  checkSpendCap: (...a: any[]) => mockCheckSpendCap(...a),
  recordSpendCapSkip: (...a: any[]) => mockRecordSpendCapSkip(...a),
  maybeAskSpendCapQuestion: (...a: any[]) => mockMaybeAskSpendCapQuestion(...a),
  consumeSpendCapSkipNotice: (...a: any[]) => mockConsumeSpendCapSkipNotice(...a),
  restoreSpendCapSkipNotice: (...a: any[]) => mockRestoreSpendCapSkipNotice(...a),
}));

import { Prisma } from '@prisma/client';
import {
  fireDue, fireScheduleTarget, updateScheduleForUser,
  parseRequiredProbes, missingRequiredProbes,
  recordScheduleProbeMiss, resetScheduleProbeMiss,
  REQUIRED_PROBE_PAUSE_THRESHOLD,
} from './schedule.service';

/** A due recurring row (the sweeper's view). */
const dueRow = (over: any = {}) => ({
  id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'do the thing', kind: 'recurring',
  intervalSec: 3600, nextRunAt: new Date(Date.now() - 1000), enabled: true,
  runsCount: 3, maxRuns: 32, expiresAt: new Date(Date.now() + 86_400_000),
  lastFiredAt: null, lastStatus: null, promptSetBy: 'machine', renewOnExhaustion: null,
  busySkips: 0, createdAt: new Date(),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRunFindFirst.mockReset().mockResolvedValue(null);
  mockRunCreate.mockReset().mockResolvedValue({ id: 'run-cont-1' });
  mockRunCount.mockReset().mockResolvedValue(0);
  mockFindMany.mockResolvedValue([]);
  mockFindFirst.mockResolvedValue(null);
  mockUpdate.mockResolvedValue({});
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockDeleteMany.mockResolvedValue({ count: 0 });
  mockCount.mockResolvedValue(0);
  mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' }, parentChatId: null });
  mockScheduleFindUnique.mockResolvedValue({ enabled: true });
  mockStartScheduledRun.mockResolvedValue({ started: true });
  mockGetChatAutonomy.mockResolvedValue(null);
  mockIncr.mockResolvedValue(1);
  mockGet.mockResolvedValue(null);
  mockGetDel.mockResolvedValue(null);
  mockPTtl.mockResolvedValue(-2);
  mockSet.mockResolvedValue('OK');
  mockCheckSpendCap.mockReset().mockResolvedValue(null);
  mockRecordSpendCapSkip.mockReset().mockResolvedValue(undefined);
  mockMaybeAskSpendCapQuestion.mockReset().mockResolvedValue(undefined);
  mockConsumeSpendCapSkipNotice.mockReset().mockResolvedValue(0);
  mockPromptHistoryFindFirst.mockReset().mockResolvedValue(null);
  mockFlagOwnerQuestion.mockReset().mockResolvedValue({ kind: 'created', question: { id: 'oq_p7' } });
});

/* ====================================================================
 * N7/S1a — spend-cap skip in the sweep.
 * ==================================================================== */
describe('N7/S1a — spend-cap skip (sweep composition)', () => {
  it('an over-cap chat SKIPS: lastStatus, lane notice, hook event kind spend, owner card — and no daily token is burned', async () => {
    mockFindMany.mockResolvedValueOnce([dueRow()]); // due rows
    mockCheckSpendCap.mockResolvedValue({ scope: 'project', capUsd: 25, spentUsd: 31.4 });

    await fireDue();

    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sch_1' }, data: { lastStatus: 'skipped:spend_cap' },
    }));
    expect(mockRecordSpendCapSkip).toHaveBeenCalledWith('s1');
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      's1', 'schedule_cap_skipped',
      expect.stringContaining('spend cap'),
      expect.objectContaining({ kind: 'spend', scope: 'project', capUsd: 25, spentUsd: 31.4 }),
    );
    expect(mockMaybeAskSpendCapQuestion).toHaveBeenCalledWith('s1', 'u1', expect.objectContaining({ scope: 'project' }));
    // Checked BEFORE dailyCapExceeded — the INCR-first reservation never ran.
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it('a 2nd spend skip in the same window emits NO duplicate hook event (feedback a30b6ad9 dedupe); lane notice + owner card unaffected', async () => {
    mockFindMany.mockResolvedValueOnce([dueRow()]); // due rows
    mockCheckSpendCap.mockResolvedValue({ scope: 'project', capUsd: 25, spentUsd: 31.4 });
    // The window's spend-flavor gate is already held → the claim fails.
    mockSet.mockImplementation(async (key: any) => (String(key).startsWith('coding:sched:capevent:') ? null : 'OK'));

    await fireDue();

    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sch_1' }, data: { lastStatus: 'skipped:spend_cap' },
    }));
    expect(mockEmitHookEvent.mock.calls.filter((c: any[]) => c[1] === 'schedule_cap_skipped')).toHaveLength(0);
    expect(mockSet).toHaveBeenCalledWith('coding:sched:capevent:s1:spend', '1', expect.objectContaining({ NX: true, EX: 24 * 60 * 60 }));
    // The other channels keep their own dedupe idioms — unaffected by the gate.
    expect(mockRecordSpendCapSkip).toHaveBeenCalledWith('s1');
    expect(mockMaybeAskSpendCapQuestion).toHaveBeenCalledWith('s1', 'u1', expect.objectContaining({ scope: 'project' }));
  });

  it('DEFAULT OFF: with no cap verdict the firing proceeds untouched', async () => {
    mockFindMany.mockResolvedValueOnce([dueRow()]);
    await fireDue();
    expect(mockCheckSpendCap).toHaveBeenCalledWith('s1');
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(mockRecordSpendCapSkip).not.toHaveBeenCalled();
    expect(mockMaybeAskSpendCapQuestion).not.toHaveBeenCalled();
  });

  it('fail-open: a spend-cap check ERROR never blocks the firing', async () => {
    mockFindMany.mockResolvedValueOnce([dueRow()]);
    mockCheckSpendCap.mockRejectedValue(new Error('metrics table down'));
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
  });

  it('plain-chat lanes get the spend-skip [SCHEDULER NOTICE] (consume) and a restore when the run does not start', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'thinking', codingState: null, parentChatId: null });
    mockConsumeSpendCapSkipNotice.mockResolvedValue(2);
    mockStartDetachedChatRun.mockReturnValueOnce('chat:s1');
    await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'p', origin: 'schedule' });
    const args = mockStartDetachedChatRun.mock.calls[0][0] as any;
    expect(args.message).toContain('[SCHEDULER NOTICE]');
    expect(args.message).toContain('over the project spend cap'); // the PROJECT cap is the only cost cap (owner 2026-09-27)
    // Busy: the consumed count is restored.
    mockStartDetachedChatRun.mockReturnValueOnce(null);
    mockConsumeSpendCapSkipNotice.mockResolvedValue(1);
    await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'p', origin: 'schedule' });
    expect(mockRestoreSpendCapSkipNotice).toHaveBeenCalledWith('s1', 1);
  });
});

/* ====================================================================
 * G13 — required probes.
 * ==================================================================== */
describe('G13 — parseRequiredProbes / missingRequiredProbes (pure pins)', () => {
  it('parses {tool, argPattern?}, drops malformed/invalid-regex entries, caps at 5', () => {
    expect(parseRequiredProbes(null)).toEqual([]);
    expect(parseRequiredProbes('nope')).toEqual([]);
    expect(parseRequiredProbes([{ tool: 'run_command' }, { tool: '' }, { notTool: 'x' }]))
      .toEqual([{ tool: 'run_command' }]);
    expect(parseRequiredProbes([{ tool: 'verify', argPattern: '(' }])).toEqual([]); // invalid regex never gates
    expect(parseRequiredProbes([{ tool: 'check_ci', argPattern: 'sha' }]))
      .toEqual([{ tool: 'check_ci', argPattern: 'sha' }]);
    expect(parseRequiredProbes(Array.from({ length: 9 }, (_, i) => ({ tool: `t${i}` })))).toHaveLength(5);
  });

  it('matches ok receipts by tool (+ argPattern over the ids envelope); reports the missing labels', () => {
    const receipts = [
      { tool: 'run_command', ok: true, ids: { exit: 0 } },
      { tool: 'verify', ok: false, ids: {} }, // failed executions do not satisfy a probe
      { tool: 'check_ci', ok: true, ids: { sha: 'abc123' } },
    ];
    expect(missingRequiredProbes([{ tool: 'run_command' }], receipts)).toEqual([]);
    expect(missingRequiredProbes([{ tool: 'verify' }], receipts)).toEqual(['verify']);
    expect(missingRequiredProbes([{ tool: 'check_ci', argPattern: 'abc' }], receipts)).toEqual([]);
    expect(missingRequiredProbes([{ tool: 'check_ci', argPattern: 'zzz' }], receipts)).toEqual(['check_ci (~zzz)']);
  });
});

describe('G13 — updateScheduleForUser requiredProbes validation', () => {
  const row = dueRow();
  beforeEach(() => {
    mockFindFirst.mockResolvedValue(row);
    mockUpdate.mockImplementation(({ data }: any) => Promise.resolve({ ...row, ...data }));
  });

  it('stores a parsed valid list', async () => {
    const res = await updateScheduleForUser('u1', 'sch_1', { requiredProbes: [{ tool: 'run_command' }] });
    expect(res.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ requiredProbes: [{ tool: 'run_command' }] }),
    }));
  });

  it('refuses a list that parses to nothing (never a silent drop)', async () => {
    const res = await updateScheduleForUser('u1', 'sch_1', { requiredProbes: [{ argPattern: 'x' }] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('requiredProbes');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('null (or []) clears via DbNull', async () => {
    const res = await updateScheduleForUser('u1', 'sch_1', { requiredProbes: null });
    expect(res.ok).toBe(true);
    expect(mockUpdate.mock.calls[0][0].data.requiredProbes).toBe(Prisma.DbNull);
  });
});

/* Gate flip 2026-09-11 (owner: full steam): a probe miss COUNTS + arms the
 * next-firing notice; the 3-strike pause + owner card is opt-in via
 * REQUIRED_PROBES_PAUSE_ENABLED=1. */

describe('G13 — recordScheduleProbeMiss: observe-only by default', () => {
  beforeEach(() => { delete process.env.REQUIRED_PROBES_PAUSE_ENABLED; });
  afterEach(() => { delete process.env.REQUIRED_PROBES_PAUSE_ENABLED; });

  it('below the threshold: arms the next-firing notice + counts, no pause', async () => {
    mockIncr.mockResolvedValue(1);
    const n = await recordScheduleProbeMiss('sch_1', 's1', ['run_command']);
    expect(n).toBe(1);
    expect(mockSet).toHaveBeenCalledWith('coding:sched:probenotice:sch_1', 'run_command', expect.objectContaining({ EX: expect.any(Number) }));
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it(`DEFAULT: at ${REQUIRED_PROBE_PAUSE_THRESHOLD} consecutive misses the schedule is NOT paused, no schedule_disabled, NO owner card — only the count`, async () => {
    mockIncr.mockResolvedValue(REQUIRED_PROBE_PAUSE_THRESHOLD);
    mockScheduleFindUnique.mockResolvedValue({
      id: 'sch_1', sessionId: 's1', kind: 'recurring', runsCount: 9, userId: 'u1', enabled: true, prompt: 'watch the queue',
    });
    const n = await recordScheduleProbeMiss('sch_1', 's1', ['run_command']);
    expect(n).toBe(REQUIRED_PROBE_PAUSE_THRESHOLD);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalledWith('coding:sched:probecard:sch_1', '1', expect.anything());
    // The next-firing notice is still armed — the lane learns, nobody clicks.
    expect(mockSet).toHaveBeenCalledWith('coding:sched:probenotice:sch_1', 'run_command', expect.objectContaining({ EX: expect.any(Number) }));
  });

  it('the fire-time notice no longer threatens a pause by default', async () => {
    mockGetDel.mockImplementation(async (key: string) =>
      key === 'coding:sched:probenotice:sch_1' ? 'run_command' : null);
    await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'do the thing', origin: 'schedule' });
    const prompt = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(prompt).toContain('[SCHEDULER NOTICE] Your previous firing finished WITHOUT the receipts');
    expect(prompt).not.toContain('this schedule is paused');
    expect(prompt).toContain('counted and journaled');
  });
});

describe('G13 — recordScheduleProbeMiss escalation ladder (opt-in REQUIRED_PROBES_PAUSE_ENABLED=1)', () => {
  beforeEach(() => { process.env.REQUIRED_PROBES_PAUSE_ENABLED = '1'; });
  afterEach(() => { delete process.env.REQUIRED_PROBES_PAUSE_ENABLED; });

  it('below the threshold: arms the next-firing notice + counts, no pause', async () => {
    mockIncr.mockResolvedValue(1);
    const n = await recordScheduleProbeMiss('sch_1', 's1', ['run_command']);
    expect(n).toBe(1);
    expect(mockSet).toHaveBeenCalledWith('coding:sched:probenotice:sch_1', 'run_command', expect.objectContaining({ EX: expect.any(Number) }));
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('opt-in: the fire-time notice names the pause', async () => {
    mockGetDel.mockImplementation(async (key: string) =>
      key === 'coding:sched:probenotice:sch_1' ? 'run_command' : null);
    await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'do the thing', origin: 'schedule' });
    const prompt = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(prompt).toContain(`after ${REQUIRED_PROBE_PAUSE_THRESHOLD} consecutive probe-less firings this schedule is paused`);
  });

  it(`at ${REQUIRED_PROBE_PAUSE_THRESHOLD} consecutive misses: pauses the schedule, emits schedule_disabled, files ONE owner card`, async () => {
    mockIncr.mockResolvedValue(REQUIRED_PROBE_PAUSE_THRESHOLD);
    mockScheduleFindUnique.mockResolvedValue({
      id: 'sch_1', sessionId: 's1', kind: 'recurring', runsCount: 9, userId: 'u1', enabled: true, prompt: 'watch the queue',
    });
    const n = await recordScheduleProbeMiss('sch_1', 's1', ['run_command']);
    expect(n).toBe(REQUIRED_PROBE_PAUSE_THRESHOLD);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sch_1' },
      data: expect.objectContaining({ enabled: false, lastStatus: 'paused:required_probes', cancelledBy: 'machine' }),
    }));
    expect(mockEmitHookEvent).toHaveBeenCalledWith('s1', 'schedule_disabled', expect.stringContaining('probes_missing'), expect.any(Object));
    expect(mockFlagOwnerQuestion).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', userId: 'u1', machineTriggered: true,
      question: expect.stringContaining('required probes'),
    }));
    // A card that FILED keeps its NX gate — no release on success.
    expect(mockRedisDel).not.toHaveBeenCalledWith('coding:sched:probecard:sch_1');
  });

  it('r3 interactions finding 3: the pause card is a HARNESS per-event card (harnessEventAt) — an owner ruling on an earlier pause annotates it, never refuses it', async () => {
    mockIncr.mockResolvedValue(REQUIRED_PROBE_PAUSE_THRESHOLD);
    mockScheduleFindUnique.mockResolvedValue({
      id: 'sch_1', sessionId: 's1', kind: 'recurring', runsCount: 9, userId: 'u1', enabled: true, prompt: 'p',
    });
    const before = Date.now();
    await recordScheduleProbeMiss('sch_1', 's1', ['run_command']);
    const input = mockFlagOwnerQuestion.mock.calls[0][0];
    expect(input.harnessEventAt).toBeInstanceOf(Date);
    expect(input.harnessEventAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('a flagOwnerQuestion FAILURE releases the NX card gate — a transient error must not silence the lane\'s only card for 7 days', async () => {
    mockIncr.mockResolvedValue(REQUIRED_PROBE_PAUSE_THRESHOLD);
    mockScheduleFindUnique.mockResolvedValue({
      id: 'sch_1', sessionId: 's1', kind: 'recurring', runsCount: 9, userId: 'u1', enabled: true, prompt: 'p',
    });
    mockFlagOwnerQuestion.mockRejectedValue(new Error('inbox down'));
    await expect(recordScheduleProbeMiss('sch_1', 's1', ['run_command'])).resolves.toBe(REQUIRED_PROBE_PAUSE_THRESHOLD);
    expect(mockRedisDel).toHaveBeenCalledWith('coding:sched:probecard:sch_1');
  });

  it('the pause card is NX-deduped and an already-disabled row is left alone', async () => {
    mockIncr.mockResolvedValue(REQUIRED_PROBE_PAUSE_THRESHOLD + 1);
    mockScheduleFindUnique.mockResolvedValue({ id: 'sch_1', sessionId: 's1', kind: 'recurring', runsCount: 9, userId: 'u1', enabled: false, prompt: 'p' });
    await recordScheduleProbeMiss('sch_1', 's1', ['verify']);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('resetScheduleProbeMiss clears the streak + card gate', async () => {
    await resetScheduleProbeMiss('sch_1');
    expect(mockRedisDel).toHaveBeenCalledWith('coding:sched:probemiss:sch_1');
    expect(mockRedisDel).toHaveBeenCalledWith('coding:sched:probecard:sch_1');
  });
});

describe('G13 — fireScheduleTarget next-firing probe notice', () => {
  it('a pending notice is consumed into the prompt (appended, never prepended)', async () => {
    mockGetDel.mockImplementation(async (key: string) =>
      key === 'coding:sched:probenotice:sch_1' ? 'run_command' : null);
    await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'do the thing', origin: 'schedule' });
    const prompt = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(prompt.startsWith('do the thing')).toBe(true);
    expect(prompt).toContain('[SCHEDULER NOTICE] Your previous firing finished WITHOUT the receipts');
    expect(prompt).toContain('run_command');
  });

  it('a firing that does NOT start restores the consumed notice', async () => {
    mockGetDel.mockImplementation(async (key: string) =>
      key === 'coding:sched:probenotice:sch_1' ? 'verify' : null);
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
    await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'p', origin: 'schedule' });
    expect(mockSet).toHaveBeenCalledWith('coding:sched:probenotice:sch_1', 'verify', expect.objectContaining({ EX: expect.any(Number) }));
  });

  it('hook wakes never read the probe notice (schedule-row concept only)', async () => {
    await fireScheduleTarget({ id: 'hook-h1', sessionId: 's1', prompt: 'p', origin: 'hook' });
    expect(mockGetDel).not.toHaveBeenCalled();
  });
});

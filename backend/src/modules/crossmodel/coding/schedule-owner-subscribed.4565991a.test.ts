/**
 * Replay pin — ticket 4565991a (bug_report, ui, 2026-09-24T15:21:25Z):
 * "Owner-subscribed scheduled digests render collapsed as 'machine wake'
 * messages".
 *
 * THE INCIDENT BEING REPLAYED: the owner's ~7:30 AM PDT daily "AI noise on
 * X.com" digest (chat dddbf9ba, armed from a REAL user turn — msg 90b8d65f
 * "schedule this same task and update me every morning around 7-8am PST
 * here", card-confirmed) delivered COLLAPSED behind the machine-wake
 * accordion; the owner had to expand it by hand (msg 65af6522: "i had to
 * open an accordion to read this digest as it was filtered as a machine wake
 * message").
 *
 * PR #1010 (ticket 6ef770a1) fixed the DIRECT case — fireScheduleTarget
 * threads scheduleOwnerArmed when the row's promptSetBy === 'user', and the
 * frontend renders the machine turn EXPANDED with a "requested" marker. But
 * TWO residual paths still collapse owner-subscribed content:
 *
 *  1. THE ONE-SHOT LADDER (the live prod state): chat dddbf9ba's project is
 *     DORMANT-GATED — machine kind-'recurring' arms are refused — so the
 *     Fleet Supervisor's re-anchor rebuilt the digest as self-re-arming
 *     ONE-SHOTS (rungs 9644abf2 / 99acc806). Every rung is promptSetBy
 *     'machine' (armed by a schedule firing, not a user turn), so the
 *     6ef770a1 gate misses EVERY delivery after the original arm. The
 *     original owner-armed row 4262258c was deleted outright by the repair —
 *     no DB lineage exists to inherit from.
 *  2. THE PROMPT-REWRITE HOLE: a machine update_schedule that rewrites an
 *     owner-armed row's prompt restamps promptSetBy 'machine' (authorship is
 *     correctly restamped — drift surfacing), which alone would re-collapse
 *     the digest even though the owner's subscription never changed.
 *
 * THE FIX (this file pins it): an additive ownerSubscribed Boolean column on
 * coding_schedules, ORTHOGONAL to promptSetBy — promptSetBy says who LAST
 * WROTE the prompt (flips on every machine rewrite); ownerSubscribed says
 * whose SUBSCRIPTION the content serves (persists through rewrites and
 * ladder re-arms). fireScheduleTarget threads scheduleOwnerArmed when
 * EITHER signal is set. Marking is gated:
 *   - a REAL user turn (schedule_message / schedule_self / REST create /
 *     update_schedule ownerSubscribed:true — including the owner-confirmed
 *     card path, whose confirmation executes with a userTurnAt anchor);
 *   - INHERITANCE: a schedule firing that was itself owner-subscribed marks
 *     its OWN-chat re-arms and updates (schedule_self, schedule_message with
 *     no chatId, update_schedule from the run) — the dormant-gate ladder
 *     keeps its subscription across every machine rung.
 * A plain machine arm on another chat (a dispatch) NEVER inherits.
 *
 * Mock boundary mirrors schedule-queue-behind-busy.3405e332.test.ts
 * (colocated mock-everything pattern); the fireScheduleTarget +
 * updateScheduleForUser surfaces are exercised.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockScheduleFindUnique = jest.fn(async (..._args: any[]): Promise<any> => ({ enabled: true }));
const mockScheduleFindFirst = jest.fn(async (..._args: any[]): Promise<any> => null);
const mockScheduleCreate = jest.fn(async (...args: any[]): Promise<any> => (args[0]?.data ?? {}));
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-cont-1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockChatFindUnique = jest.fn();
const mockChatUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockMsgCreate = jest.fn(async (..._a: any[]) => ({}));
const mockPromptHistoryCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'ph-1' }));
const mockPromptHistoryCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockScheduleUpdate = jest.fn(async (...a: any[]): Promise<any> => ({ ...a[0]?.data, id: a[0]?.where?.id ?? 'sch_1' }));
const mockScheduleUpdateMany = jest.fn(async (..._a: any[]): Promise<any> => ({ count: 1 }));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: {
      findUnique: (...a: any[]) => mockScheduleFindUnique(...a),
      findFirst: (...a: any[]) => mockScheduleFindFirst(...a),
      findMany: jest.fn(async (..._a: any[]): Promise<any[]> => []),
      create: (...a: any[]) => mockScheduleCreate(...a),
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
const mockExpire = jest.fn(async (..._a: any[]) => {});
const mockDecr = jest.fn(async (..._a: any[]) => {});
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
  LOOP_METRIC_KINDS: { WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked', SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', SCHEDULE_BUSY_ALARM: 'schedule_busy_alarm', PROBE_MISS: 'probe_miss', PROMPT_REWRITE_CAP: 'prompt_rewrite_cap', SCHEDULE_ONCE_RETIME: 'schedule_once_retime' },
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
  resolveStoppedForSession: (...a: any[]) => mockResolveStoppedForSession(...a),
}));

// The plain-chat fire path (dynamic import in fireScheduleTarget) — mocked at
// the message-queue boundary exactly like the sibling suite.
const mockEnqueueChatMessage = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'pm-1', position: 1 }));
const mockPeekWakeRider = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockConsumeWakeRider = jest.fn(async (..._a: any[]): Promise<any> => 0);
jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  enqueueChatMessage: (...a: any[]) => mockEnqueueChatMessage(...a),
  peekWakeRider: (...a: any[]) => mockPeekWakeRider(...a),
  consumeWakeRider: (...a: any[]) => mockConsumeWakeRider(...a),
  drainChatQueue: jest.fn(),
}));

// The coding-session fire path (dynamic import in fireScheduleTarget).
const mockStartScheduledRun = jest.fn(async (..._a: any[]): Promise<any> => ({ started: true }));
jest.mock('./run-executor', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
}));

// The CODING branch of fireScheduleTarget dynamically imports
// ./coding-stream.controller (the run-executor mock above predates the
// controller split and no code path reaches it) — mocked the way
// schedule-wake-rider.test.ts does so the coding branch's startScheduledRun
// OPTS are assertable (ticket 56d6b204 childResult threading). Partial on
// purpose: no steerActiveRun export means the busy-steer probe is skipped
// (the optional-chain contract in fireScheduleTarget).
const mockCodingStartScheduledRun = jest.fn(async (..._a: any[]): Promise<any> => ({ started: true }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockCodingStartScheduledRun(...a),
}));

import { fireScheduleTarget, updateScheduleForUser, maybeRenewOnExhaustion } from './schedule.service';

/** The detached plain-chat run start (dynamic import in fireScheduleTarget). */
const mockStartDetachedChatRun = jest.fn(async (..._a: any[]): Promise<any> => true);
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: null });
  mockScheduleFindUnique.mockResolvedValue({ enabled: true });
});

describe('ticket 4565991a — owner-subscribed firings render EXPANDED (fireScheduleTarget)', () => {
  it('THE LADDER CASE: a promptSetBy machine + ownerSubscribed true rung threads scheduleOwnerArmed (the dormant-gate one-shot ladder renders expanded)', async () => {
    // The live prod shape: rung 9644abf2 on chat dddbf9ba — machine-authored
    // (armed by the supervisor's repair firing) but serving the owner's
    // original subscription.
    mockScheduleFindUnique.mockResolvedValue({ enabled: true, kind: 'once', promptSetBy: 'machine', ownerSubscribed: true });
    await fireScheduleTarget({ id: 'sch_rung', sessionId: 's1', prompt: 'the daily AI digest' });
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      scheduleOwnerArmed: true,
      machineWake: true,
      messageOrigin: 'schedule',
    }));
  });

  it('the fire reads ownerSubscribed off the row (the new signal source, alongside promptSetBy)', async () => {
    mockScheduleFindUnique.mockResolvedValue({ enabled: true, kind: 'once', promptSetBy: 'machine', ownerSubscribed: true });
    await fireScheduleTarget({ id: 'sch_rung', sessionId: 's1', prompt: 'digest' });
    expect(mockScheduleFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sch_rung' },
      select: expect.objectContaining({ promptSetBy: true, ownerSubscribed: true }),
    }));
  });

  it('CONTROL: a plain machine rung with ownerSubscribed null/absent stays collapsed exactly as today', async () => {
    for (const row of [
      { enabled: true, kind: 'once', promptSetBy: 'machine' },
      { enabled: true, kind: 'once', promptSetBy: 'machine', ownerSubscribed: null },
      { enabled: true, kind: 'once', promptSetBy: 'system', ownerSubscribed: false },
    ]) {
      mockScheduleFindUnique.mockResolvedValue(row);
      mockStartDetachedChatRun.mockClear();
      await fireScheduleTarget({ id: 'sch_plain', sessionId: 's1', prompt: 'internal sweep' });
      const call = mockStartDetachedChatRun.mock.calls[0]?.[0];
      expect(call?.scheduleOwnerArmed).toBeUndefined();
      expect(call).toMatchObject({ machineWake: true, messageOrigin: 'schedule' });
    }
  });

  it('the 6ef770a1 direct path is unchanged: promptSetBy user still threads the flag (no ownerSubscribed needed)', async () => {
    mockScheduleFindUnique.mockResolvedValue({ enabled: true, kind: 'recurring', promptSetBy: 'user' });
    await fireScheduleTarget({ id: 'sch_user', sessionId: 's1', prompt: 'digest' });
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      scheduleOwnerArmed: true,
      messageOrigin: 'schedule',
    }));
  });

  it('THE PROMPT-REWRITE HOLE: an owner-subscribed row whose prompt was machine-rewritten (promptSetBy now machine) still renders expanded', async () => {
    // The 6ef770a1 latent hole — authorship restamped, subscription intact.
    mockScheduleFindUnique.mockResolvedValue({ enabled: true, kind: 'recurring', promptSetBy: 'machine', ownerSubscribed: true });
    await fireScheduleTarget({ id: 'sch_rw', sessionId: 's1', prompt: 'rewritten digest prompt' });
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      scheduleOwnerArmed: true,
      messageOrigin: 'schedule',
    }));
  });
});

describe('ticket 4565991a — updateScheduleForUser marking', () => {
  it('ownerSubscribed true marks the row (the update_schedule owner path)', async () => {
    mockScheduleFindFirst.mockResolvedValue({ id: 'sch_1', userId: 'u1', enabled: true, kind: 'once', prompt: 'p', intervalSec: 3600, nextRunAt: new Date(), runsCount: 0, maxRuns: 1, expiresAt: null, lastFiredAt: null, promptSetBy: 'machine', ownerSubscribed: null });
    await updateScheduleForUser('u1', 'sch_1', { ownerSubscribed: true });
    expect(mockScheduleUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sch_1' },
      data: expect.objectContaining({ ownerSubscribed: true }),
    }));
  });

  it('a prompt rewrite WITHOUT an ownerSubscribed argument PRESERVES the stored mark (machine rewrite never unmarks — the latent hole)', async () => {
    mockScheduleFindFirst.mockResolvedValue({ id: 'sch_1', userId: 'u1', enabled: true, kind: 'recurring', prompt: 'p', intervalSec: 3600, nextRunAt: new Date(), runsCount: 0, maxRuns: null, expiresAt: null, lastFiredAt: null, promptSetBy: 'user', ownerSubscribed: true });
    await updateScheduleForUser('u1', 'sch_1', { prompt: 'machine-rewritten prompt', promptSetBy: 'machine' });
    expect(mockScheduleUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ prompt: 'machine-rewritten prompt', promptSetBy: 'machine' }),
    }));
    // ownerSubscribed is ABSENT from the write — preserved on the row.
    const write = mockScheduleUpdate.mock.calls[0][0]?.data ?? {};
    expect(write.ownerSubscribed).toBeUndefined();
  });

  it('ownerSubscribed false UNMARKS (the owner opts out)', async () => {
    mockScheduleFindFirst.mockResolvedValue({ id: 'sch_1', userId: 'u1', enabled: true, kind: 'recurring', prompt: 'p', intervalSec: 3600, nextRunAt: new Date(), runsCount: 0, maxRuns: null, expiresAt: null, lastFiredAt: null, promptSetBy: 'user', ownerSubscribed: true });
    await updateScheduleForUser('u1', 'sch_1', { ownerSubscribed: false });
    expect(mockScheduleUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ownerSubscribed: false }),
    }));
  });
});

describe('ticket 4565991a — renewOnExhaustion inheritance (the recurring rollover ladder)', () => {
  it('a successor row inherits ownerSubscribed from the exhausted row', async () => {
    mockScheduleFindFirst.mockResolvedValue(null); // no already-renewed / dupe row → create path
    await maybeRenewOnExhaustion({
      id: 'sch_dead', sessionId: 's1', userId: 'u1', prompt: 'digest', kind: 'recurring',
      intervalSec: 3600, maxRuns: 5, promptSetBy: 'user', renewOnExhaustion: true, ownerSubscribed: true,
    });
    expect(mockScheduleCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ownerSubscribed: true, promptSetBy: 'system' }),
    }));
  });

  it('CONTROL: an unmarked row creates an unmarked successor (no laundering)', async () => {
    mockScheduleFindFirst.mockResolvedValue(null);
    await maybeRenewOnExhaustion({
      id: 'sch_dead', sessionId: 's1', userId: 'u1', prompt: 'sweep', kind: 'recurring',
      intervalSec: 3600, maxRuns: 5, promptSetBy: 'machine', ownerSubscribed: null,
    });
    const write = mockScheduleCreate.mock.calls[0]?.[0]?.data ?? {};
    expect(write.ownerSubscribed).toBeUndefined();
  });
});

describe('ticket 56d6b204 — childResult wake threading (sub-session result wakes render expanded)', () => {
  it('(a) a childResult hook wake threads childResult + hook origin into the PLAIN-CHAT branch (startDetachedChatRun)', async () => {
    await fireScheduleTarget({
      id: 'hook-cr1', sessionId: 's1', prompt: 'Your sub-session "DB audit" reported run_completed: all tables verified',
      origin: 'hook', childResult: true,
    });
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      childResult: true,
      messageOrigin: 'hook',
      machineWake: true,
    }));
  });

  it('(b) a hook wake WITHOUT childResult carries NO childResult key (ordinary hook wakes stay collapsed)', async () => {
    await fireScheduleTarget({
      id: 'hook-cr2', sessionId: 's1', prompt: 'Fleet event from chat "X" (run_completed): routine completion',
      origin: 'hook',
    });
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    const call = mockStartDetachedChatRun.mock.calls[0]?.[0];
    expect(call).toMatchObject({ messageOrigin: 'hook', machineWake: true });
    expect(call?.childResult).toBeUndefined();
  });

  it('(c) the CODING branch: a childResult hook wake on a code-capable chat passes childResult: true in the startScheduledRun opts', async () => {
    // The 9df506cc coding-lane shape: codingState present → fireScheduleTarget
    // takes the queued-coding-run branch (startScheduledRun via the dynamic
    // ./coding-stream.controller import).
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    await fireScheduleTarget({
      id: 'hook-cr3', sessionId: 's1', prompt: 'Your sub-session "Reviewer" reported run_completed: verdict REFUTED',
      origin: 'hook', childResult: true,
    });
    expect(mockCodingStartScheduledRun).toHaveBeenCalledTimes(1);
    const [sessionId, prompt, opts] = mockCodingStartScheduledRun.mock.calls[0];
    expect(sessionId).toBe('s1');
    expect(prompt).toContain('run_completed');
    expect(opts).toMatchObject({ origin: 'hook', childResult: true });
    // Hook wakes never stamp a scheduleId (they carry synthetic hook-* ids).
    expect(opts?.scheduleId).toBeUndefined();
    // And the plain-chat branch never ran.
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
  });
});

describe('ticket 4565991a — THE CODING-SESSION LEG (the Sep 27 recurrence: chat dddbf9ba is a coding session)', () => {
  // The recurrence the original 4565991a fix missed: PR #1010/#1032/#1080
  // thread scheduleOwnerArmed ONLY into the plain-chat branch
  // (startDetachedChatRun). The owner's digest lane (chat dddbf9ba, "Latest AI
  // Trends and Releases on X") is a CODING session — fireScheduleTarget takes
  // the startScheduledRun branch, which never received the flag, so the wake
  // user row persisted NO metadata.scheduleOwnerArmed and the digest ANSWER
  // row NO metadata.kind 'owner_digest' (prod probe 2026-09-27: row a1bb2121
  // fired ownerSubscribed true + promptSetBy 'user' at 14:28:43Z; wake row
  // dae58f92 + answer row 71b24778 both unstamped; ZERO owner_digest rows
  // ever on the chat vs 8 on plain-chat lanes). The owner: "no i dont even
  // see where it is at all today" (msg c7d900c3, 16:00:30Z).

  beforeEach(() => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
  });

  it('(a) THE LADDER CASE, coding: an ownerSubscribed rung on a coding chat threads scheduleOwnerArmed into startScheduledRun', async () => {
    mockScheduleFindUnique.mockResolvedValue({ enabled: true, kind: 'once', promptSetBy: 'machine', ownerSubscribed: true });
    await fireScheduleTarget({ id: 'sch_coding', sessionId: 's1', prompt: 'the daily AI digest' });
    expect(mockCodingStartScheduledRun).toHaveBeenCalledTimes(1);
    const [sessionId, , opts] = mockCodingStartScheduledRun.mock.calls[0];
    expect(sessionId).toBe('s1');
    expect(opts).toMatchObject({ origin: 'schedule', scheduleId: 'sch_coding', scheduleOwnerArmed: true });
    // The plain-chat branch never ran.
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
  });

  it('(b) the 6ef770a1 direct path, coding: promptSetBy user threads too (no ownerSubscribed needed)', async () => {
    mockScheduleFindUnique.mockResolvedValue({ enabled: true, kind: 'once', promptSetBy: 'user' });
    await fireScheduleTarget({ id: 'sch_coding_user', sessionId: 's1', prompt: 'digest' });
    expect(mockCodingStartScheduledRun).toHaveBeenCalledWith('s1', expect.any(String), expect.objectContaining({ scheduleOwnerArmed: true }));
  });

  it('(c) CONTROL, coding: a plain machine rung (no subscription) carries NO scheduleOwnerArmed key — collapses exactly as today', async () => {
    mockScheduleFindUnique.mockResolvedValue({ enabled: true, kind: 'once', promptSetBy: 'machine', ownerSubscribed: null });
    await fireScheduleTarget({ id: 'sch_coding_plain', sessionId: 's1', prompt: 'internal sweep' });
    const opts = mockCodingStartScheduledRun.mock.calls[0]?.[2];
    expect(opts?.scheduleOwnerArmed).toBeUndefined();
    expect(opts).toMatchObject({ origin: 'schedule', scheduleId: 'sch_coding_plain' });
  });

  it('(d) CONTROL: a hook wake on a coding chat never arms (origin-gated)', async () => {
    await fireScheduleTarget({ id: 'hook-x', sessionId: 's1', prompt: 'fleet event', origin: 'hook' });
    const opts = mockCodingStartScheduledRun.mock.calls[0]?.[2];
    expect(opts?.scheduleOwnerArmed).toBeUndefined();
    expect(opts?.origin).toBe('hook');
  });
});

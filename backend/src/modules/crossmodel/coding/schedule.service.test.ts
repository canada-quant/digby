/**
 * Guardrail tests for the coding self-scheduler CRUD (createSchedule).
 * The sweeper + fire path are integration-level (DB + controller) and covered by
 * the prod E2E; here we lock the pure validation rules.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCreate = jest.fn();
const mockCount = jest.fn();
const mockFindFirst = jest.fn();
// Sweeper-tick mocks (fireDue): due rows, the atomic claim, and status updates.
const mockFindMany = jest.fn();
const mockUpdate = jest.fn();
const mockUpdateMany = jest.fn();
const mockDeleteMany = jest.fn();
// fbe65673 stale-firing guard: fireScheduleTarget re-reads the row at fire
// time. Default ENABLED so every pre-existing fire path proceeds; the guard's
// own tests override per-case. Constructor impl survives clearAllMocks.
const mockScheduleFindUnique = jest.fn(async (..._args: any[]): Promise<any> => ({ enabled: true }));
const mockRedisDel = jest.fn();
const mockChatFindUnique = jest.fn();
const mockChatUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockMsgCreate = jest.fn(async (..._a: any[]) => ({}));
// Continuation fast-lane (audit #2): queueContinuationRun writes agent_runs directly.
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-cont-1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
// P6 (N4) prompt-rewrite ledger mocks.
const mockPromptHistoryCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'ph-1' }));
const mockPromptHistoryCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
// Supervisor OFF switch (owner 2026-09-26): the SystemSetting reads behind the
// sweeper/fireScheduleTarget gates — null (no row) = ON, so every pre-existing
// test is untouched; the switch suite at the end sets '0'.
const mockSettingFind = jest.fn(async (..._a: any[]): Promise<any> => null);
// ARCHIVED-TARGET-RETIRE (2026-10-20): the arm refusals read the target with
// ONE crossModelChat.findFirst (null = not archived — every pre-existing test
// is untouched); the archived-target suite at the end overrides it.
const mockChatFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);

// $transaction seam (ticket ae20da66): createSchedule wraps the create + the
// same-cadence collapse in ONE interactive transaction. The tx reuses this
// file's mock fns; the collapse's in-tx stale read gets its OWN mock defaulting
// to [] so pre-collapse tests behave exactly as before.
const mockStaleFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockTransaction = jest.fn(async (fn: any) =>
  typeof fn === 'function'
    ? fn({
        codingSchedule: {
          create: (...a: any[]) => mockCreate(...a),
          findMany: (...a: any[]) => mockStaleFindMany(...a),
          updateMany: (...a: any[]) => mockUpdateMany(...a),
        },
      })
    : Promise.all(fn));

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
      deleteMany: (...a: any[]) => mockDeleteMany(...a),
    },
    agentRun: {
      findFirst: (...a: any[]) => mockRunFindFirst(...a),
      create: (...a: any[]) => mockRunCreate(...a),
      count: (...a: any[]) => mockRunCount(...a),
    },
    // P6 (N4): prompt-rewrite ledger — defaults keep pre-P6 tests inert
    // (0 machine rewrites today, no history rows, create succeeds).
    schedulePromptHistory: {
      create: (...a: any[]) => mockPromptHistoryCreate(...a),
      count: (...a: any[]) => mockPromptHistoryCount(...a),
      findFirst: (...a: any[]) => mockPromptHistoryFindFirst(...a),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), findFirst: (...a: any[]) => mockChatFindFirst(...a), update: (...a: any[]) => mockChatUpdate(...a) },
    crossModelMessage: { create: (...a: any[]) => mockMsgCreate(...a) },
    systemSetting: { findUnique: (...a: any[]) => mockSettingFind(...a) },
    $transaction: (fn: any) => mockTransaction(fn),
  },
}));
const mockIncr = jest.fn();
const mockExpire = jest.fn(async (..._args: any[]) => {});
const mockDecr = jest.fn(async (..._args: any[]) => {});
const mockSet = jest.fn(async (..._args: any[]): Promise<any> => 'OK');
// Daily-cap visibility (Phase 2): the fires counter is now READ too (GET+PTTL).
const mockGet = jest.fn();
const mockPTtl = jest.fn();
// Cap-skip notice: atomic consume (GETDEL) + busy-skip restore (INCRBY).
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

// Fleet supervisor: the per-chat daily cap lookup (dynamic import in the service).
const mockGetChatAutonomy = jest.fn();
jest.mock('../platform/autonomy.service', () => ({
  __esModule: true,
  getChatAutonomy: (...a: any[]) => mockGetChatAutonomy(...a),
}));

// Slice-B seam: hooks.service is mocked at the module boundary — pins the
// emission contract emitHookEvent(sourceChatId, eventType, summary, extra?) and
// the per-tick sweepHookEvents() call.
const mockEmitHookEvent = jest.fn(async (..._args: any[]) => {});
const mockSweepHookEvents = jest.fn(async (..._args: any[]) => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  sweepHookEvents: (...a: any[]) => mockSweepHookEvents(...a),
}));

// The coding-harness fire path (dynamic import in fireScheduleTarget).
const mockStartScheduledRun = jest.fn(async (..._args: any[]) => ({ started: true }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
}));

// The plain-chat fire path (dynamic import in fireScheduleTarget) — mocked at the
// module boundary so the real chat-agent import graph (config/env) never loads.
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

// Loop-metrics telemetry (audit #12 close-out): the fast-lane queue records a
// wake_delivered metric — mocked so no real buffer/DB path loads.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { MACHINE_DISPATCH_ARCHIVED_REFUSED: 'machine_dispatch_archived_refused', ARCHIVED_TARGET_RETIRE: 'archived_target_retire', WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked', SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', SCHEDULE_BUSY_ALARM: 'schedule_busy_alarm', PROBE_MISS: 'probe_miss', PROMPT_REWRITE_CAP: 'prompt_rewrite_cap', SCHEDULE_PARKED_CLAIM: 'schedule_parked_claim', SCHEDULE_SUPERSEDED_SKIP: 'schedule_superseded_skip', SCHEDULE_CONTINUATION_SKIP: 'schedule_continuation_skip', SCHEDULE_ALLCOMPLETE_FIRING: 'schedule_allcomplete_firing', SCHEDULE_OWNER_CADENCE_EDIT: 'schedule_owner_cadence_edit' },
}));

// N7 superseded-firing gate (2026-09-25): processDueScheduleRow consults it for
// a busy-parked recurring row. The leaf is mocked at the boundary (its
// constants stay real) so these tests pin the WIRING — the parked-claim
// metric with the gate's facts, the act-skip bookkeeping, and fail-open.
const NO_GATE = (ineligible: string | null, facts: any = null) => ({ ineligible, facts, decision: null, stash: null, skip: null });
const mockPreGateParkedFiring = jest.fn(async (..._a: any[]): Promise<any> => NO_GATE('mode_off'));
jest.mock('./firing-superseded-gate', () => ({
  __esModule: true,
  ...(jest.requireActual('./firing-superseded-gate')),
  preGateParkedFiring: (...a: any[]) => mockPreGateParkedFiring(...a),
}));

// Stopped-schedule decision fast lane (SA0906) — schedule.service queues the
// delayed lane-liveness re-check via a dynamic import of ./stopped-schedule-alert
// on every MACHINE permanent-stop path; mocked at the boundary so these tests
// pin exactly which stop paths call it (and that owner-explicit ones never do).
const mockQueueStoppedScheduleAlert = jest.fn((..._a: any[]) => {});
const mockMaybeFileStoppedScheduleDecision = jest.fn(async (..._a: any[]) => ({ filed: false, reason: 'lane_alive' }));
jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: (...a: any[]) => mockQueueStoppedScheduleAlert(...a),
  maybeFileStoppedScheduleDecision: (...a: any[]) => mockMaybeFileStoppedScheduleDecision(...a),
}));

// Lane-revival auto-resolve (SA0906) — createSchedule + the Schedules-tab
// resume dynamically import ../platform/owner-questions to close open
// stopped-schedule decisions; mocked at the boundary.
const mockResolveStoppedForSession = jest.fn(async (..._a: any[]) => 0);
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  resolveStoppedScheduleDecisionsForSession: (...a: any[]) => mockResolveStoppedForSession(...a),
}));

// ARCHIVED-TARGET-RETIRE (2026-10-20): the archive-paused schedule ids live in
// the context store (the hooks.service rememberArchivePausedHooks twin) — an
// in-memory store here so the pause → restore round trip is observable.
const mockStore = new Map<string, any>();
const storeKey = (ns: string[], key: string) => `${ns.join('/')}#${key}`;
const mockStoreGet = jest.fn(async (ns: string[], key: string) => mockStore.get(storeKey(ns, key)) ?? null);
const mockStorePut = jest.fn(async (ns: string[], key: string, value: any) => { mockStore.set(storeKey(ns, key), value); });
const mockStoreDelete = jest.fn(async (ns: string[], key: string) => { mockStore.delete(storeKey(ns, key)); });
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => (mockStoreGet as any)(...a),
  storePut: (...a: any[]) => (mockStorePut as any)(...a),
  storeDelete: (...a: any[]) => (mockStoreDelete as any)(...a),
}));

// The plan-board read behind the continuation staleness guard (dynamic import
// in fireScheduleTarget) — tests control the board state directly. The guard
// uses getPlanStrict, whose errors PROPAGATE (unlike getPlan's swallow-to-null);
// the mock replaces only that reader, keeping the REAL count-regex and sentence
// builder live via requireActual so the template-sync test pins prod constants.
const mockGetPlanStrict = jest.fn(async (..._args: any[]) => null as any);
// tt-rd audit 2026-09-27 (all-complete board notice): the recurring-firing
// check reads the error-swallowing getPlan (a read error must never add a
// notice or skip a firing) — mocked separately so the strict-reader pins above
// stay untouched.
const mockGetPlan = jest.fn(async (..._args: any[]) => null as any);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: (...a: any[]) => mockGetPlanStrict(...a),
  getPlan: (...a: any[]) => mockGetPlan(...a),
}));

// ALLCOMPLETE-CHARTER-TERMINATION (2026-10-20): the fire-time decision is mocked here (its own suite
// covers the reads) — the default keeps today's advisory, so every earlier all-complete pin holds.
const mockDecideAllComplete = jest.fn(async (..._a: any[]): Promise<any> => ({ action: 'notice', why: 'test_default' }));
const mockNoticeIdleSkip = jest.fn(async (..._a: any[]) => true);
jest.mock('./allcomplete-charter', () => ({
  __esModule: true,
  ...(jest.requireActual('./allcomplete-charter')),
  decideAllCompleteFiring: (...a: any[]) => mockDecideAllComplete(...a),
  noticeAllCompleteIdleSkipOnce: (...a: any[]) => mockNoticeIdleSkip(...a),
}));

import { createSchedule, updateScheduleForUser, listSchedules, listSchedulesForUser, getScheduleForUser, fireDue, fireDueScheduleNow, fireScheduleTarget, gcTerminalSchedules, consumeCapSkipNotice, restoreCapSkipNotice, getScheduleHealth, cancelSchedule, cancelScheduleForUser, deafLaneWarningForUser, setScheduleEnabledForChat, queueContinuationRun, hasQueuedContinuationRun, CONTINUATION_REQUEUE_DELAY_MS, providerThrottleRequeueDelayMs, PROVIDER_THROTTLE_REQUEUE_DELAY_MS, MIN_INTERVAL_SEC, MAX_ACTIVE_PER_SESSION, MAX_PROMPT_CHARS, capForSession, supervisorDailyCapFloor, SUPERVISOR_MACHINE_RUN_DAILY_CAP_ENV, dailyCapExceeded, dailyCapWarnThreshold, pauseSchedulesForLaneArchive, resumeSchedulesForRestoredChat, armOwnerAnswerRetrySchedule } from './schedule.service';
import { continuationCountSentence, CONTINUATION_COUNT_RE, continuationPrompt } from './plan.service';
import { planBoardAllComplete, allCompleteBoardNotice, ALL_COMPLETE_BOARD_MARKER } from './schedule.service';
import { markRetiring, __resetRetiringForTests } from './retiring';

/** A live recurring row as the sweeper/service sees it (17 firings of history). */
const liveRow = {
  id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'old prompt', kind: 'recurring',
  intervalSec: 3600, nextRunAt: new Date(Date.now() + 3600_000), enabled: true,
  runsCount: 17, maxRuns: 500, expiresAt: new Date(Date.now() + 10 * 24 * 3600 * 1000),
  lastFiredAt: null, lastStatus: 'started', createdAt: new Date(),
};

beforeEach(() => {
  mockCreate.mockReset();
  mockCount.mockReset();
  mockFindFirst.mockReset();
  mockUpdate.mockReset();
  mockDeleteMany.mockReset();
  mockRedisDel.mockReset();
  mockRedisDel.mockResolvedValue(1);
  mockCount.mockResolvedValue(0);
  // Cap-state reads default to "no live counter window" (missing key) — the
  // createSchedule/updateScheduleForUser paths enrich their views too.
  mockGet.mockReset().mockResolvedValue(null);
  mockGetDel.mockReset().mockResolvedValue(null);
  mockIncrBy.mockReset().mockResolvedValue(1);
  mockPTtl.mockReset().mockResolvedValue(-2); // node-redis PTTL: -2 = key missing
  mockGetChatAutonomy.mockReset().mockResolvedValue(null); // no grant → default 48
  mockCreate.mockImplementation(({ data }: any) => Promise.resolve({
    id: 'sch_1', ...data,
    nextRunAt: data.nextRunAt, expiresAt: data.expiresAt, lastFiredAt: null, lastStatus: null, runsCount: 0,
  }));
  // updateSchedule returns toView(updated) — resolve with the row patched by data.
  mockUpdate.mockImplementation(({ data }: any) => Promise.resolve({ ...liveRow, ...data }));
});

const base = { sessionId: 's1', userId: 'u1', prompt: 'do the thing' };

test('rejects an interval below the 15-min minimum', async () => {
  const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: 60 });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/15 min|minimum/i);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('accepts a valid recurring schedule at the minimum interval', async () => {
  const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC });
  expect(r.ok).toBe(true);
  expect(r.schedule?.kind).toBe('recurring');
  expect(mockCreate).toHaveBeenCalledTimes(1);
});

test("a 'once' schedule is capped to a single run", async () => {
  const r = await createSchedule({ ...base, kind: 'once', intervalSec: MIN_INTERVAL_SEC });
  expect(r.ok).toBe(true);
  const arg = mockCreate.mock.calls[0][0].data;
  expect(arg.maxRuns).toBe(1);
  expect(arg.kind).toBe('once');
});

test('rejects an empty prompt', async () => {
  const r = await createSchedule({ ...base, prompt: '   ', kind: 'recurring', intervalSec: MIN_INTERVAL_SEC });
  expect(r.ok).toBe(false);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('rejects an over-length prompt with an ACTIONABLE error, and creates nothing (1d4c8a14)', async () => {
  const r = await createSchedule({
    ...base,
    prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1),
    kind: 'recurring',
    intervalSec: MIN_INTERVAL_SEC,
  });
  expect(r.ok).toBe(false);
  expect(mockCreate).not.toHaveBeenCalled();
  // The rejection must name the limit and tell the caller how to recover — a
  // silent/opaque failure was the ticket (the wake was lost with no signal).
  expect(r.error).toMatch(new RegExp(`max ${MAX_PROMPT_CHARS}`));
  expect(r.error).toMatch(/shorten/i);
  expect(r.error).toMatch(/no schedule was created/i);
});

test('accepts a prompt exactly at the 8000-char limit', async () => {
  const r = await createSchedule({
    ...base,
    prompt: 'x'.repeat(MAX_PROMPT_CHARS),
    kind: 'recurring',
    intervalSec: MIN_INTERVAL_SEC,
  });
  expect(r.ok).toBe(true);
  expect(mockCreate).toHaveBeenCalledTimes(1);
});

test('enforces the per-session active cap', async () => {
  mockCount.mockResolvedValue(MAX_ACTIVE_PER_SESSION);
  const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/too many/i);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('sets a 30-day expiry ceiling', async () => {
  const before = Date.now();
  await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC });
  const arg = mockCreate.mock.calls[0][0].data;
  const expiresMs = new Date(arg.expiresAt).getTime() - before;
  // ~30 days (allow a few seconds of test skew)
  expect(expiresMs).toBeGreaterThan(29.9 * 24 * 3600 * 1000);
  expect(expiresMs).toBeLessThan(30.1 * 24 * 3600 * 1000);
});

// ── gcTerminalSchedules ─────────────────────────────────────────────────────

test('GC deletes only disabled rows whose createdAt AND lastFiredAt are both past the cutoff', async () => {
  mockDeleteMany.mockResolvedValue({ count: 3 });
  const n = await gcTerminalSchedules();
  expect(n).toBe(3);
  const where = mockDeleteMany.mock.calls[0][0].where;
  expect(where.enabled).toBe(false);
  expect(where.createdAt.lt).toBeInstanceOf(Date);
  expect(Array.isArray(where.OR)).toBe(true);
  expect(where.OR[0].lastFiredAt).toBeNull();
  expect(where.OR[1].lastFiredAt.lt).toBeInstanceOf(Date);
});

test('GC swallows DB errors (sweeper must never wedge on GC)', async () => {
  mockDeleteMany.mockRejectedValue(new Error('db down'));
  await expect(gcTerminalSchedules()).resolves.toBe(0);
});

test('GC default retention is 30 days and the delete count is logged (audit trail of what fired)', async () => {
  mockDeleteMany.mockResolvedValue({ count: 2 });
  const before = Date.now();
  await gcTerminalSchedules();
  const cutoff = (mockDeleteMany.mock.calls[0][0].where.createdAt.lt as Date).getTime();
  expect(before - cutoff).toBeGreaterThan(29.9 * 24 * 3600 * 1000);
  expect(before - cutoff).toBeLessThan(30.1 * 24 * 3600 * 1000);
  expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('deleted 2 terminal row(s) idle >30d'));
});

// ── Regression pins: feedback 4d64a348 + e2c847bb (2026-09-05) ───────────────
// A fleet-supervisor reconciliation reported schedules "firing at 10:26Z today
// yet VANISHED from list_schedules within the hour". Under the code that is
// impossible for ordinary coding-chat schedules: this GC is the only TTL-based
// hard delete, and it can never match a row that is enabled OR that was
// created/fired within the 30-day TTL. (Two other deletion vectors exist —
// supervisor.service.ts's ensureSweepSchedule hard-deletes surplus ENABLED
// recurring schedules on the FLEET-SUPERVISOR chat only, and deleting a chat
// cascades via schema onDelete — but neither can touch an enabled schedule on
// a coding chat that still exists, which is the ticket's case.) Pin the
// conjuncts as a named regression so a future change that loosens any of them
// (e.g. GC-ing enabled rows, or a shorter TTL) fails loudly here instead of
// silently deleting live schedules.
test('ticket 4d64a348/e2c847bb — a schedule that fired today is NEVER GC-eligible (vanishing requires enabled:false + >30d idle)', async () => {
  mockDeleteMany.mockResolvedValue({ count: 0 });
  await gcTerminalSchedules();
  const where = mockDeleteMany.mock.calls[0][0].where;
  // Conjunct 1: only terminal rows — an ENABLED schedule can never be deleted.
  expect(where.enabled).toBe(false);
  // Conjunct 2: the row must be OLD — created before the 30-day cutoff.
  const createdCutoff = (where.createdAt.lt as Date).getTime();
  expect(Date.now() - createdCutoff).toBeGreaterThan(29 * 24 * 3600 * 1000);
  // Conjunct 3: AND it must be IDLE — never fired, or last fired before the
  // same cutoff. A schedule that fired today matches neither branch.
  expect(where.OR[0].lastFiredAt).toBeNull();
  const firedCutoff = (where.OR[1].lastFiredAt.lt as Date).getTime();
  expect(Date.now() - firedCutoff).toBeGreaterThan(29 * 24 * 3600 * 1000);
});

// ── consumeCapSkipNotice / restoreCapSkipNotice ─────────────────────────────

test('consumeCapSkipNotice returns 0 when no skip is pending', async () => {
  mockGetDel.mockResolvedValue(null);
  await expect(consumeCapSkipNotice('s1')).resolves.toBe(0);
});

test('consumeCapSkipNotice reads + clears ATOMICALLY via GETDEL (no separate GET/DEL a concurrent INCR can fall between)', async () => {
  mockGetDel.mockResolvedValue('4');
  await expect(consumeCapSkipNotice('s1')).resolves.toBe(4);
  expect(mockGetDel).toHaveBeenCalledWith('coding:sched:skipnotice:s1');
  // The old two-command shape destroyed a recordCapSkip INCR landing mid-pair.
  expect(mockGet).not.toHaveBeenCalled();
  expect(mockRedisDel).not.toHaveBeenCalled();
});

test('consumeCapSkipNotice swallows a Redis hiccup (returns 0, never throws)', async () => {
  mockGetDel.mockRejectedValue(new Error('redis down'));
  await expect(consumeCapSkipNotice('s1')).resolves.toBe(0);
});

test('restoreCapSkipNotice puts a consumed count back via INCRBY (+ TTL refresh) — concurrent skips are preserved', async () => {
  await restoreCapSkipNotice('s1', 20);
  expect(mockIncrBy).toHaveBeenCalledWith('coding:sched:skipnotice:s1', 20);
  expect(mockExpire).toHaveBeenCalledWith('coding:sched:skipnotice:s1', 36 * 60 * 60);
});

test('restoreCapSkipNotice no-ops on a non-positive count and swallows Redis errors', async () => {
  await restoreCapSkipNotice('s1', 0);
  await restoreCapSkipNotice('s1', -3);
  expect(mockIncrBy).not.toHaveBeenCalled();
  mockIncrBy.mockRejectedValue(new Error('redis down'));
  await expect(restoreCapSkipNotice('s1', 2)).resolves.toBeUndefined();
});

// ── getScheduleHealth ───────────────────────────────────────────────────────
// The active rows are queried EXPLICITLY (where enabled: true) — the old
// newest-50-then-filter window dropped a live recurring row once 50+ newer
// terminal rows accumulated, reporting a healthy monitor as active: 0.

test('getScheduleHealth finds active rows regardless of terminal-row churn (explicit enabled:true query + full terminal count)', async () => {
  mockFindMany.mockReset().mockResolvedValue([liveRow]);
  mockCount.mockResolvedValue(65); // more terminal rows than the old take:50 window
  const health = await getScheduleHealth('s1');
  expect(mockFindMany).toHaveBeenCalledWith({ where: { sessionId: 's1', enabled: true }, orderBy: { createdAt: 'desc' } });
  expect(mockCount).toHaveBeenCalledWith({ where: { sessionId: 's1', enabled: false } });
  expect(health.active).toBe(1);
  expect(health.terminal).toBe(65); // no longer capped at 50
  expect(health.items[0]).toMatchObject({ id: 'sch_1', kind: 'recurring', runsCount: 17, lastStatus: 'started' });
});

test('getScheduleHealth reports active: 0 honestly when nothing is enabled', async () => {
  mockFindMany.mockReset().mockResolvedValue([]);
  mockCount.mockResolvedValue(3);
  await expect(getScheduleHealth('s1')).resolves.toEqual({ active: 0, terminal: 3, items: [] });
});

// ── Sweeper daily cap (fleet supervisor slice A) ──────────────────────────────
// fireDue with a single due recurring row: the atomic claim always wins
// (updateMany → count 1); the fire path targets a coding chat via the mocked
// startScheduledRun. The cap under test = ChatAutonomy.scheduleCap ?? 48.

import logger from '../../../utils/logger';

describe('sweeper daily cap (per-chat ChatAutonomy.scheduleCap)', () => {
  const dueRow = (overrides: any = {}) => ({
    id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'do the thing', kind: 'recurring',
    intervalSec: MIN_INTERVAL_SEC, nextRunAt: new Date(Date.now() - 1000), enabled: true,
    runsCount: 0, maxRuns: 500, expiresAt: new Date(Date.now() + 20 * 86_400_000), // +20d: outside the schedule_near_cap 3d expiry window (b4d1096c)
    lastFiredAt: null, lastStatus: null,
    ...overrides,
  });
  // The post-fire bump moved to a CONDITIONAL updateMany (fbe65673 review
  // finding 1: cancel-mid-fire must not be overwritten) — scan both channels.
  const updatesWith = (pred: (data: any) => boolean) =>
    [...mockUpdate.mock.calls, ...mockUpdateMany.mock.calls].map((c) => c[0]).filter((u) => pred(u.data));

  beforeEach(() => {
    mockFindMany.mockReset().mockResolvedValue([dueRow()]);
    mockUpdate.mockReset().mockResolvedValue({});
    mockUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockIncr.mockReset().mockResolvedValue(1);
    mockExpire.mockClear();
    mockDecr.mockClear();
    mockGetChatAutonomy.mockReset().mockResolvedValue(null); // no grant → default 48
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
    mockEmitHookEvent.mockClear();
    mockSweepHookEvents.mockClear();
    mockSet.mockReset().mockResolvedValue('OK');
    mockMsgCreate.mockClear();
    mockChatUpdate.mockClear();
    mockRecordLoopMetric.mockClear();
    (logger.warn as jest.Mock).mockClear();
  });

  it('fires normally under the default cap', async () => {
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledWith('s1', 'do the thing', { origin: 'schedule', scheduleId: 'sch_1' }); // cff523e7: real firings carry the schedule link
    expect(updatesWith((d) => d?.lastStatus === 'started' && d?.runsCount === 1)).toHaveLength(1);
    expect(updatesWith((d) => d?.lastStatus === 'skipped:daily_cap')).toHaveLength(0);
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
  });

  // ── Busy/error skip refunds the speculative cap token (feedback 94bb9c2f) ──
  it('a successful fire RESERVES a daily-cap token and does NOT refund it', async () => {
    await fireDue();
    expect(mockIncr).toHaveBeenCalledWith('coding:sched:fires:s1');
    expect(mockDecr).not.toHaveBeenCalled();
  });

  it('a busy skip REFUNDS the daily-cap token — retries must not drain the cap', async () => {
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' } as any); // the coding chat has an active run
    await fireDue();
    expect(mockIncr).toHaveBeenCalledWith('coding:sched:fires:s1'); // speculative reserve
    expect(mockDecr).toHaveBeenCalledWith('coding:sched:fires:s1'); // refunded — no run started
    const skips = updatesWith((d) => d?.lastStatus === 'skipped:busy');
    expect(skips).toHaveLength(1);
    expect(skips[0].data.nextRunAt).toBeInstanceOf(Date); // re-armed ~3min out
    expect(updatesWith((d) => d?.runsCount != null)).toHaveLength(0); // no budget consumed
    // Remediation P0: the busy skip is the congestion signal — ONE
    // schedule_busy_skip row per skipped firing, keyed to the session.
    const busyRows = mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'schedule_busy_skip');
    expect(busyRows).toHaveLength(1);
    expect(busyRows[0][0]).toMatchObject({ sessionId: 's1', meta: { scheduleId: 'sch_1' } });
  });

  it('remediation P0: a NON-busy skip (not_found/obsolete) emits NO schedule_busy_skip row', async () => {
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'not_found' } as any);
    await fireDue();
    expect(mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'schedule_busy_skip')).toHaveLength(0);
  });

  it('a fire ERROR also refunds the daily-cap token', async () => {
    mockStartScheduledRun.mockRejectedValue(new Error('boom'));
    await fireDue();
    expect(mockDecr).toHaveBeenCalledWith('coding:sched:fires:s1');
    expect(updatesWith((d) => typeof d?.lastStatus === 'string' && d.lastStatus.startsWith('error:'))).toHaveLength(1);
  });

  // ── Regression pins: feedback 4d64a348 + e2c847bb (2026-09-05) ─────────────
  // The fleet ticket reported a "ghost firing": lastFiredAt advanced with
  // lastStatus "ok" yet no run materialized. The real semantics behind that
  // observation: the atomic claim stamps lastFiredAt BEFORE delivery, and a
  // busy chat then records skipped:busy with a ~3-minute re-arm (never a run,
  // never a transcript message, no budget consumed). And 'ok' is not a status
  // the coding-schedule pipeline can ever write — the quoted "ok" most likely
  // came from the cronJob table (cron.service.ts writes lastStatus 'ok' there),
  // a different surface a reconciliation can conflate with coding_schedules.
  // Pin all three so the next reconciliation can tell a normal busy skip from
  // an actual delivery failure.
  it('ticket 4d64a348/e2c847bb + P3 pin 14a — a busy firing does NOT stamp lastFiredAt (claim advances nextRunAt only), records skipped:busy with a ~3min re-arm (no run, no budget)', async () => {
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' } as any);
    const before = Date.now();
    await fireDue();
    // 1. The claim (updateMany) advanced nextRunAt WITHOUT lastFiredAt (P3 pin
    //    14a: a skip must not read as a firing — heartbeat surfaces key off
    //    lastFiredAt; only the actual-start bump stamps it).
    const claim = [...mockUpdateMany.mock.calls]
      .map((c) => c[0])
      .find((u) => u.data?.nextRunAt instanceof Date && u.data?.lastStatus === undefined);
    expect(claim).toBeTruthy();
    expect(claim.data.lastFiredAt).toBeUndefined();
    expect([...mockUpdateMany.mock.calls, ...mockUpdate.mock.calls]
      .map((c) => c[0]).filter((u) => u.data?.lastFiredAt instanceof Date)).toHaveLength(0);
    // 2. The outcome write says skipped:busy (never 'ok') and re-arms ~3 min.
    const skips = updatesWith((d) => d?.lastStatus === 'skipped:busy');
    expect(skips).toHaveLength(1);
    const reArmMs = (skips[0].data.nextRunAt as Date).getTime() - before;
    expect(reArmMs).toBeGreaterThan(150_000);
    expect(reArmMs).toBeLessThan(210_000);
    // 3. No run consumed budget and no 'started' was recorded.
    expect(updatesWith((d) => d?.runsCount != null)).toHaveLength(0);
    expect(updatesWith((d) => d?.lastStatus === 'started')).toHaveLength(0);
  });

  it("ticket 4d64a348 — the fire paths never write lastStatus 'ok' (vocabulary: started | skipped:* | error:* | expired | cancelled)", async () => {
    // Exercise three outcomes across three ticks: started, busy, error.
    await fireDue(); // started (default mock)
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' } as any);
    await fireDue(); // skipped:busy
    mockStartScheduledRun.mockRejectedValue(new Error('boom'));
    await fireDue(); // error:*
    const written = [...mockUpdate.mock.calls, ...mockUpdateMany.mock.calls]
      .map((c) => c[0].data?.lastStatus)
      .filter((s): s is string => typeof s === 'string');
    expect(written.length).toBeGreaterThanOrEqual(3);
    expect(written).not.toContain('ok');
    for (const s of written) {
      expect(s).toMatch(/^(started|resumed|cancelled|expired|skipped:[a-z_]+|error:.*)$/);
    }
  });

  it('autonomy loop #13: a schedule firing or hook wake into an ARCHIVED chat is refused with reason "archived" — no run on either surface', async () => {
    for (const codingState of [null, { id: 'cs1' }]) {
      mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', archivedAt: new Date('2026-09-17T21:27:15Z'), codingState });
      mockStartDetachedChatRun.mockClear();
      mockStartScheduledRun.mockClear();
      for (const origin of ['schedule', 'hook'] as const) {
        const res = await fireScheduleTarget({ id: origin === 'hook' ? 'hook-h1' : 'sch_1', sessionId: 's1', prompt: 'tick', origin });
        expect(res).toEqual({ started: false, reason: 'archived' });
      }
      expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
      expect(mockStartScheduledRun).not.toHaveBeenCalled();
    }
  });

  it('a NON-code chat fires a detached chat-agent run with machineWake: true (postmortem 2026-08-11)', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: null });
    mockStartDetachedChatRun.mockClear();
    await fireDue();
    // machineWake threads the freshness preamble / SERP-skip / deeper history
    // into the chat tier; 'fast' normalizes to single_thinking like the stream path.
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith({
      userId: 'u1', chatId: 's1', message: 'do the thing', mode: 'single_thinking', machineWake: true,
      messageOrigin: 'schedule', // fleet origin marking: schedule-fired runs are machine traffic
      firedByScheduleId: 'sch_1', // one-shot chain provenance (finding B1): the fired schedule's id rides to the run
    });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.lastStatus === 'started' && d?.runsCount === 1)).toHaveLength(1);
  });

  it("a NON-code chat STORED as 'auto' (the 2026-09-26 default — supervisors included) fires at the L2 preset fallback 'thinking' (storedModeToPreset); the chat-agent's compute policy decides the rest", async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'auto', codingState: null });
    mockStartDetachedChatRun.mockClear();
    await fireDue();
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({ chatId: 's1', mode: 'thinking', machineWake: true, messageOrigin: 'schedule' }));
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'deep_research_all', codingState: null });
    mockStartDetachedChatRun.mockClear();
    await fireDue();
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({ mode: 'deep_research' })); // legacy ids alias forward, unchanged
  });

  // ── Owner-armed schedule firing (ticket 6ef770a1) ──────────────────────────
  // The owner-armed signal is promptSetBy 'user' (schedule_message from a real
  // user turn). fireScheduleTarget reads the row's promptSetBy at fire time and
  // threads scheduleOwnerArmed so the wake user row persists the flag the
  // frontend grouping reads to render the digest EXPANDED. Only the explicit
  // 'user' stamp counts — legacy NULL and 'machine'/'system' rows stay
  // collapsed exactly as today.
  it('ticket 6ef770a1 — a promptSetBy user row threads scheduleOwnerArmed to the detached run (owner-armed digest renders expanded)', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: null });
    mockScheduleFindUnique.mockResolvedValue({ enabled: true, kind: 'recurring', promptSetBy: 'user' });
    mockStartDetachedChatRun.mockClear();
    await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'the daily AI digest' });
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      scheduleOwnerArmed: true,
      machineWake: true,
      messageOrigin: 'schedule',
    }));
    // The fire reads promptSetBy off the row (the owner-armed signal source).
    expect(mockScheduleFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sch_1' },
      select: expect.objectContaining({ promptSetBy: true }),
    }));
  });

  it('ticket 6ef770a1 — a machine-authored (or legacy NULL) promptSetBy row does NOT thread the flag', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: null });
    for (const promptSetBy of ['machine', 'system', null, undefined]) {
      mockScheduleFindUnique.mockResolvedValue({ enabled: true, kind: 'recurring', promptSetBy: promptSetBy ?? null });
      mockStartDetachedChatRun.mockClear();
      await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'internal sweep' });
      const call = mockStartDetachedChatRun.mock.calls[0]?.[0];
      expect(call?.scheduleOwnerArmed).toBeUndefined();
      expect(call).toMatchObject({ machineWake: true, messageOrigin: 'schedule' });
    }
  });

  it('ticket 6ef770a1 — a hook wake (origin hook, no schedule row) never threads the flag', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: null });
    mockStartDetachedChatRun.mockClear();
    // The suite's module-level mock keeps call history across tests — clear it
    // so this test's not.toHaveBeenCalled() pins THIS firing alone.
    mockScheduleFindUnique.mockClear();
    await fireScheduleTarget({ id: 'hook-h1', sessionId: 's1', prompt: 'event digest', origin: 'hook' });
    const call = mockStartDetachedChatRun.mock.calls[0]?.[0];
    expect(call?.scheduleOwnerArmed).toBeUndefined();
    expect(mockScheduleFindUnique).not.toHaveBeenCalled();
    // Restore the suite default (the shared beforeEach does NOT reset this
    // mock — later tests rely on the bare { enabled: true } row).
    mockScheduleFindUnique.mockReset().mockResolvedValue({ enabled: true });
  });

  it('honors a RAISED per-chat cap: the 49th fire proceeds when scheduleCap is 288', async () => {
    mockGetChatAutonomy.mockResolvedValue({ allowedTools: [], scheduleCap: 288 });
    mockIncr.mockResolvedValue(49); // over the DEFAULT 48 — under the chat's 288
    await fireDue();
    expect(mockGetChatAutonomy).toHaveBeenCalledWith('s1');
    expect(mockStartScheduledRun).toHaveBeenCalledWith('s1', 'do the thing', { origin: 'schedule', scheduleId: 'sch_1' }); // cff523e7: real firings carry the schedule link
    expect(updatesWith((d) => d?.lastStatus === 'started' && d?.runsCount === 1)).toHaveLength(1);
    expect(updatesWith((d) => d?.lastStatus === 'skipped:daily_cap')).toHaveLength(0);
  });

  it('honors a LOWERED per-chat cap: cap 1 skips the 2nd fire of the day', async () => {
    mockGetChatAutonomy.mockResolvedValue({ allowedTools: [], scheduleCap: 1 });
    mockIncr.mockResolvedValue(2);
    await fireDue();
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockDecr).toHaveBeenCalled(); // blocked day must not inflate forever
    const skips = updatesWith((d) => d?.lastStatus === 'skipped:daily_cap');
    expect(skips).toHaveLength(1);
    expect(skips[0].where).toEqual({ id: 'sch_1' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('1/day session cap'));
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      's1', 'schedule_cap_skipped',
      expect.stringContaining('1/day'),
      expect.objectContaining({ scheduleId: 'sch_1', cap: 1 }),
    );
  });

  it('at the default cap (no grant row): sets lastStatus skipped:daily_cap, warns, emits the hook event, does NOT fire', async () => {
    mockIncr.mockResolvedValue(49); // default cap 48 exceeded
    await fireDue();
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    const skips = updatesWith((d) => d?.lastStatus === 'skipped:daily_cap');
    expect(skips).toHaveLength(1);
    expect(skips[0].where).toEqual({ id: 'sch_1' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('48/day session cap'));
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      's1', 'schedule_cap_skipped',
      expect.stringContaining('48/day'),
      expect.objectContaining({ scheduleId: 'sch_1', cap: 48 }),
    );
  });

  // ── Owner-visible cap notice (feedback 619ba9f9 / 34c1c60b) ───────────────
  it('posts ONE owner-visible notice into the chat when a cap skip happens', async () => {
    mockIncr.mockResolvedValue(49); // default cap 48 exceeded
    await fireDue();
    expect(mockSet).toHaveBeenCalledWith('coding:sched:capnotice:s1', '1', expect.objectContaining({ NX: true }));
    expect(mockMsgCreate).toHaveBeenCalledTimes(1);
    const msg = mockMsgCreate.mock.calls[0][0].data;
    expect(msg.chatId).toBe('s1');
    expect(msg.role).toBe('assistant');
    expect(msg.content).toContain('48');
  });

  it('does NOT re-notify within the same cap window (Redis NX throttle)', async () => {
    mockIncr.mockResolvedValue(49);
    mockSet.mockResolvedValue(null); // capnotice key already set this window
    await fireDue();
    expect(mockMsgCreate).not.toHaveBeenCalled();
  });

  // ── Per-window schedule_cap_skipped hook-event dedupe (feedback a30b6ad9) ──
  it('emits the cap hook event only ONCE per window: a 2nd skip in the same window stays supervisor-silent', async () => {
    mockIncr.mockResolvedValue(49); // default cap 48 exceeded
    // The NX gate key for this window is already held → the claim fails.
    mockSet.mockImplementation(async (key: any) => (String(key).startsWith('coding:sched:capevent:') ? null : 'OK'));
    await fireDue();
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.lastStatus === 'skipped:daily_cap')).toHaveLength(1);
    // No supervisor wake — the duplicate skip is muted…
    expect(mockEmitHookEvent.mock.calls.filter((c: any[]) => c[1] === 'schedule_cap_skipped')).toHaveLength(0);
    // …the gate was still attempted (window-aligned TTL: mockPTtl -2 → 24h fallback)…
    expect(mockSet).toHaveBeenCalledWith('coding:sched:capevent:s1:daily', '1', expect.objectContaining({ NX: true, EX: 24 * 60 * 60 }));
    // …the in-lane skip notice STILL counts every skip (self-heal signal intact)…
    expect(mockIncr).toHaveBeenCalledWith('coding:sched:skipnotice:s1');
    // …and the owner-notice idiom is untouched (its own NX key still claimed).
    expect(mockSet).toHaveBeenCalledWith('coding:sched:capnotice:s1', '1', expect.objectContaining({ NX: true }));
  });

  it('the first skip of a window claims the gate and emits, with a window-aligned TTL (FIRES_KEY PTTL)', async () => {
    mockIncr.mockResolvedValue(49);
    mockPTtl.mockResolvedValue(3_600_000); // 1h left in the live window
    await fireDue();
    expect(mockSet).toHaveBeenCalledWith('coding:sched:capevent:s1:daily', '1', expect.objectContaining({ NX: true, EX: 3600 }));
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      's1', 'schedule_cap_skipped',
      expect.stringContaining('48/day'),
      expect.objectContaining({ scheduleId: 'sch_1', cap: 48 }),
    );
  });

  it('a gate Redis hiccup fails OPEN — the cap signal is never silenced', async () => {
    mockIncr.mockResolvedValue(49);
    mockSet.mockImplementation(async (key: any) => {
      if (String(key).startsWith('coding:sched:capevent:')) throw new Error('redis down');
      return 'OK';
    });
    await fireDue();
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      's1', 'schedule_cap_skipped',
      expect.stringContaining('48/day'),
      expect.objectContaining({ scheduleId: 'sch_1', cap: 48 }),
    );
  });

  it('a notice failure never breaks the sweep', async () => {
    mockIncr.mockResolvedValue(49);
    mockSet.mockRejectedValue(new Error('redis down'));
    await fireDue();
    expect(updatesWith((d) => d?.lastStatus === 'skipped:daily_cap')).toHaveLength(1); // skip still recorded
    expect(mockMsgCreate).not.toHaveBeenCalled();
  });

  // ── ~80%-of-budget early warning (feedback 190d68aa) ─────────────────────
  it('crossing the 80% budget mark emits ONE kind:warn schedule_cap_skipped — the lane can re-space BEFORE deafness', async () => {
    mockIncr.mockResolvedValue(39); // default cap 48 → warn threshold ceil(0.8·48)=39
    mockPTtl.mockResolvedValue(3_600_000); // 1h left in the live window
    await fireDue();
    // The firing still PROCEEDS — a warn is not a skip…
    expect(mockStartScheduledRun).toHaveBeenCalledWith('s1', 'do the thing', { origin: 'schedule', scheduleId: 'sch_1' });
    expect(updatesWith((d) => d?.lastStatus === 'started')).toHaveLength(1);
    // …the warn gate was claimed with the window-aligned TTL…
    expect(mockSet).toHaveBeenCalledWith('coding:sched:capevent:s1:warn', '1', expect.objectContaining({ NX: true, EX: 3600 }));
    // …and the supervisor wake names the budget state, not a skip.
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      's1', 'schedule_cap_skipped',
      expect.stringContaining('39/48'),
      expect.objectContaining({ kind: 'warn', used: 39, cap: 48, threshold: 39 }),
    );
  });

  it('below the threshold NO warn fires — the budget is quiet until ~80%', async () => {
    mockIncr.mockResolvedValue(38); // one under the 39 threshold
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalled();
    expect(mockEmitHookEvent.mock.calls.filter((c: any[]) => c[1] === 'schedule_cap_skipped')).toHaveLength(0);
    expect(mockSet).not.toHaveBeenCalledWith('coding:sched:capevent:s1:warn', '1', expect.anything());
  });

  it('an over-cap firing takes the SKIP path only — no kind:warn noise on top', async () => {
    mockIncr.mockResolvedValue(49); // default cap 48 exceeded
    await fireDue();
    expect(mockEmitHookEvent.mock.calls.filter((c: any[]) => c[3]?.kind === 'warn')).toHaveLength(0);
    expect(mockEmitHookEvent).toHaveBeenCalledWith( // the dedupe-gated skip signal is untouched
      's1', 'schedule_cap_skipped',
      expect.stringContaining('48/day'),
      expect.objectContaining({ scheduleId: 'sch_1', cap: 48 }),
    );
  });

  it('the warn is per-window deduped: a held gate mutes the repeat (a30b6ad9 machinery reused)', async () => {
    mockIncr.mockResolvedValue(40);
    mockSet.mockImplementation(async (key: any) => (String(key) === 'coding:sched:capevent:s1:warn' ? null : 'OK'));
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalled(); // firing unaffected
    expect(mockEmitHookEvent.mock.calls.filter((c: any[]) => c[3]?.kind === 'warn')).toHaveLength(0);
  });

  it('a warn-gate Redis hiccup fails OPEN — the early warning is never silenced', async () => {
    mockIncr.mockResolvedValue(39);
    mockSet.mockImplementation(async (key: any) => {
      if (String(key) === 'coding:sched:capevent:s1:warn') throw new Error('redis down');
      return 'OK';
    });
    await fireDue();
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      's1', 'schedule_cap_skipped',
      expect.stringContaining('39/48'),
      expect.objectContaining({ kind: 'warn', used: 39, cap: 48 }),
    );
  });

  it('sub-session attribution warns on the PARENT budget — a child crossing its parent\'s 80% wakes the parent\'s subscribers', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' }, parentChatId: 'p1' });
    mockIncr.mockImplementation(async (key: any) => (String(key) === 'coding:sched:fires:p1' ? 39 : 1));
    const r = await dailyCapExceeded('s1');
    expect(r).toBeNull(); // neither counter is over its cap
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      'p1', 'schedule_cap_skipped',
      expect.stringContaining('39/48'),
      expect.objectContaining({ kind: 'warn', used: 39, cap: 48 }),
    );
  });

  it('dailyCapWarnThreshold pins the ~80% contract: ceil, floor 1', () => {
    expect(dailyCapWarnThreshold(48)).toBe(39);
    expect(dailyCapWarnThreshold(480)).toBe(384); // supervisor floor
    expect(dailyCapWarnThreshold(1)).toBe(1);
    expect(dailyCapWarnThreshold(5)).toBe(4);
  });

  // ── Hook-event sweep (fleet supervisor slice B) ───────────────────────────
  it('sweeps the hook-event outbox once per tick, after schedule firing', async () => {
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalled(); // schedule firing happened first
    expect(mockSweepHookEvents).toHaveBeenCalledTimes(1);
  });

  it('a hook-sweep failure never breaks schedule firing', async () => {
    mockSweepHookEvents.mockRejectedValue(new Error('sweep exploded'));
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledWith('s1', 'do the thing', { origin: 'schedule', scheduleId: 'sch_1' }); // cff523e7: real firings carry the schedule link
    expect(updatesWith((d) => d?.lastStatus === 'started')).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('hook event sweep failed'));
  });
});

// ── updateScheduleForUser (feedback c6147f39 — stale-prompt hazard) ──────────

describe('updateScheduleForUser', () => {
  const row = {
    id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'old prompt', kind: 'recurring',
    intervalSec: MIN_INTERVAL_SEC, nextRunAt: new Date('2026-08-04T00:00:00Z'), enabled: true,
    runsCount: 3, maxRuns: 500, expiresAt: new Date('2026-08-30T00:00:00Z'),
    lastFiredAt: null, lastStatus: 'started',
  };

  beforeEach(() => {
    mockFindFirst.mockReset().mockResolvedValue(row);
    mockUpdate.mockReset().mockImplementation(({ data }: any) => Promise.resolve({ ...row, ...data }));
  });

  it('returns not-found for a schedule the user does not own', async () => {
    mockFindFirst.mockResolvedValue(null);
    const r = await updateScheduleForUser('u1', 'nope', { prompt: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no such schedule/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('scopes the ownership lookup by id + userId', async () => {
    await updateScheduleForUser('u1', 'sch_1', { prompt: 'new' });
    expect(mockFindFirst).toHaveBeenCalledWith({ where: { id: 'sch_1', userId: 'u1' } });
  });

  it('rejects an empty prompt', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { prompt: '   ' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/empty/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects an interval below the 15-min minimum', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { intervalSec: 60 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/15/);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a call with nothing to update', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nothing to update/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('updates the prompt (trimmed) and preserves the row id + session', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { prompt: '  new instructions  ' });
    expect(r.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'sch_1' }, data: { prompt: 'new instructions' } });
    expect(r.schedule?.id).toBe('sch_1');
    expect(r.schedule?.sessionId).toBe('s1');
    expect(r.schedule?.prompt).toBe('new instructions');
  });

  it('updates the cadence (rounded) without touching nextRunAt', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { intervalSec: 3600.4 });
    expect(r.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'sch_1' }, data: { intervalSec: 3600 } });
    expect(r.schedule?.nextRunAt).toBe(row.nextRunAt.toISOString());
  });

  // Fixer 2026-09-27 (AUDIT CHURN finding 1): a MACHINE run changing the
  // cadence of an OWNER-ARMED row is OBSERVED (one loop_metrics row), never
  // refused — the doctrine now says report UP, never edit; this measures the residual.
  describe('owner-armed cadence edited by a machine run — observe-only row', () => {
    const cadenceRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === 'schedule_owner_cadence_edit');
    beforeEach(() => { mockRecordLoopMetric.mockClear(); });

    it('machine interval change on a promptSetBy user row (and on a legacy NULL row) writes ONE row {scheduleId, from, to, promptSetBy} — the update still lands', async () => {
      mockFindFirst.mockResolvedValue({ ...row, promptSetBy: 'user', intervalSec: 1800 });
      const r = await updateScheduleForUser('u1', 'sch_1', { intervalSec: 3600, promptSetBy: 'machine' });
      expect(r.ok).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'sch_1' }, data: { intervalSec: 3600 } });
      expect(cadenceRows()).toHaveLength(1);
      expect(cadenceRows()[0]).toMatchObject({ sessionId: 's1', meta: { scheduleId: 'sch_1', kind: 'recurring', fromIntervalSec: 1800, toIntervalSec: 3600, promptSetBy: 'user' } });
      mockRecordLoopMetric.mockClear();
      mockFindFirst.mockResolvedValue({ ...row, promptSetBy: null, intervalSec: 1800 });
      await updateScheduleForUser('u1', 'sch_1', { intervalSec: 3600, promptSetBy: 'machine' });
      expect(cadenceRows()).toHaveLength(1);
      expect(cadenceRows()[0].meta).toMatchObject({ promptSetBy: null });
    });

    it('no row for a user-turn edit, a machine edit of a machine-armed row, or an unchanged interval (the update lands regardless)', async () => {
      mockFindFirst.mockResolvedValue({ ...row, promptSetBy: 'user', intervalSec: 1800 });
      expect((await updateScheduleForUser('u1', 'sch_1', { intervalSec: 3600, promptSetBy: 'user' })).ok).toBe(true);
      expect((await updateScheduleForUser('u1', 'sch_1', { intervalSec: 1800, promptSetBy: 'machine' })).ok).toBe(true); // unchanged
      mockFindFirst.mockResolvedValue({ ...row, promptSetBy: 'machine', intervalSec: 1800 });
      expect((await updateScheduleForUser('u1', 'sch_1', { intervalSec: 3600, promptSetBy: 'machine' })).ok).toBe(true);
      expect(cadenceRows()).toHaveLength(0);
    });
  });
});

// ── Schedule id prefix resolution (nightly-lane truncated-id postmortem 2026-08-27) ──

describe('schedule id prefix resolution (nightly-lane truncated-id postmortem 2026-08-27)', () => {
  const FULL = '6bdedc2a-2222-4333-8444-abcdefabcdef';
  const row = {
    id: FULL, sessionId: 's1', userId: 'u1', prompt: 'old prompt', kind: 'recurring',
    intervalSec: MIN_INTERVAL_SEC, nextRunAt: new Date('2026-08-04T00:00:00Z'), enabled: true,
    runsCount: 3, maxRuns: 500, expiresAt: new Date('2026-08-30T00:00:00Z'),
    lastFiredAt: null, lastStatus: 'started',
  };

  it('cancelScheduleForUser resolves a unique ≥8-char prefix and cancels the full id', async () => {
    mockFindFirst.mockReset()
      .mockResolvedValueOnce(null)        // exact-id miss
      .mockResolvedValueOnce(row);        // resolved-id row lookup
    mockFindMany.mockReset().mockResolvedValueOnce([{ id: FULL }]); // prefix search
    mockUpdate.mockReset().mockResolvedValue({});
    await expect(cancelScheduleForUser('u1', '6bdedc2a')).resolves.toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: FULL }, data: { enabled: false, lastStatus: 'cancelled', cancelledBy: 'owner', disabledAt: expect.any(Date) } }); // v1#13 stamps
  });

  it('updateScheduleForUser resolves a unique ≥8-char prefix and updates the full id', async () => {
    mockFindFirst.mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row);
    mockFindMany.mockReset().mockResolvedValueOnce([{ id: FULL }]);
    mockUpdate.mockReset().mockImplementation(({ data }: any) => Promise.resolve({ ...row, ...data }));
    const r = await updateScheduleForUser('u1', '6bdedc2a', { prompt: 'new' });
    expect(r.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: FULL }, data: { prompt: 'new' } });
    expect(r.schedule?.id).toBe(FULL);
  });

  it('an ambiguous prefix throws naming the candidate full ids — never guesses', async () => {
    mockFindFirst.mockReset().mockResolvedValue(null);
    mockFindMany.mockReset().mockResolvedValue([{ id: '6bdedc2a-aaaa-4333-8444-abcdefabcdef' }, { id: '6bdedc2a-bbbb-4333-8444-abcdefabcdef' }]);
    mockUpdate.mockReset();
    const err: any = await cancelScheduleForUser('u1', '6bdedc2a').catch((e: any) => e);
    expect(err?.message).toMatch(/Ambiguous schedule id prefix/);
    expect(err?.message).toContain('6bdedc2a-aaaa-4333-8444-abcdefabcdef');
    expect(err?.message).toContain('6bdedc2a-bbbb-4333-8444-abcdefabcdef');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('a prefix shorter than 8 chars stays exact-only (no prefix search)', async () => {
    mockFindFirst.mockReset().mockResolvedValue(null);
    mockFindMany.mockReset();
    await expect(cancelScheduleForUser('u1', '6bdedc2')).resolves.toBe(false); // 7 chars
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('an exact id hit short-circuits — no prefix search is issued', async () => {
    mockFindFirst.mockReset().mockResolvedValue(row);
    mockFindMany.mockReset();
    mockUpdate.mockReset().mockResolvedValue({});
    await expect(cancelScheduleForUser('u1', FULL)).resolves.toBe(true);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: FULL }, data: { enabled: false, lastStatus: 'cancelled', cancelledBy: 'owner', disabledAt: expect.any(Date) } }); // v1#13 stamps
  });
});

// ── Daily-cap visibility (Phase 2) ──────────────────────────────────────────
// listSchedules / listSchedulesForUser stamp the per-chat FIRES_KEY counter
// state (Redis GET + PTTL on coding:sched:fires:<sessionId>) onto every view —
// ONE round-trip per DISTINCT chat (the counter is pooled across a chat's
// schedules). Fail-open: a Redis hiccup yields nulls, never a thrown list.

describe('daily-cap visibility on schedule views', () => {
  const schedRow = (overrides: any = {}) => ({
    id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'do the thing', kind: 'recurring',
    intervalSec: MIN_INTERVAL_SEC, nextRunAt: new Date('2026-08-05T00:00:00Z'), enabled: true,
    runsCount: 2, maxRuns: 500, expiresAt: new Date('2026-09-01T00:00:00Z'),
    lastFiredAt: null, lastStatus: 'started', createdAt: new Date('2026-08-04T00:00:00Z'),
    ...overrides,
  });

  beforeEach(() => {
    // The list functions now query enabled + terminal rows separately (enabled
    // rows are never take-windowed — dd0d37ac); route the mock accordingly.
    mockFindMany.mockReset().mockImplementation(async (args: any) =>
      args?.where?.enabled === false ? [] : [schedRow()]);
  });

  it('stamps dailyFiresUsed/dailyCapLimit/capWindowResetsAt from Redis GET+PTTL (PTTL>0 → reset ≈ now+pttl)', async () => {
    mockGet.mockResolvedValue('5');
    mockPTtl.mockResolvedValue(3_600_000); // 1h left in the live window
    const before = Date.now();
    const rows = await listSchedules('s1');
    const after = Date.now();
    expect(rows).toHaveLength(1);
    expect(mockGet).toHaveBeenCalledWith('coding:sched:fires:s1');
    expect(mockPTtl).toHaveBeenCalledWith('coding:sched:fires:s1');
    expect(rows[0].dailyFiresUsed).toBe(5);
    expect(rows[0].dailyCapLimit).toBe(48); // no grant row → default
    const resetMs = new Date(rows[0].capWindowResetsAt!).getTime();
    expect(resetMs).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(resetMs).toBeLessThanOrEqual(after + 3_600_000);
  });

  it('missing counter key → 0 used, no reset time', async () => {
    mockGet.mockResolvedValue(null);
    mockPTtl.mockResolvedValue(-2);
    const rows = await listSchedules('s1');
    expect(rows[0].dailyFiresUsed).toBe(0);
    expect(rows[0].dailyCapLimit).toBe(48);
    expect(rows[0].capWindowResetsAt).toBeNull();
  });

  it('a counter without its TTL (PTTL -1) → used visible, reset null', async () => {
    mockGet.mockResolvedValue('3');
    mockPTtl.mockResolvedValue(-1);
    const rows = await listSchedules('s1');
    expect(rows[0].dailyFiresUsed).toBe(3);
    expect(rows[0].capWindowResetsAt).toBeNull();
  });

  it('a Redis hiccup fails OPEN: null fields, and the list still returns rows', async () => {
    mockGet.mockRejectedValue(new Error('redis down'));
    mockPTtl.mockRejectedValue(new Error('redis down'));
    const rows = await listSchedules('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('sch_1');
    expect(rows[0].dailyFiresUsed).toBeNull();
    expect(rows[0].dailyCapLimit).toBe(48); // the cap lookup is DB-side — still known
    expect(rows[0].capWindowResetsAt).toBeNull();
  });

  it('honors a ChatAutonomy.scheduleCap override on every row of the chat', async () => {
    mockGetChatAutonomy.mockResolvedValue({ allowedTools: [], scheduleCap: 7 });
    mockFindMany.mockImplementation(async (args: any) =>
      args?.where?.enabled === false ? [] : [schedRow(), schedRow({ id: 'sch_2' })]);
    const rows = await listSchedules('s1');
    expect(rows.map((r) => r.dailyCapLimit)).toEqual([7, 7]);
    expect(mockGetChatAutonomy).toHaveBeenCalledWith('s1');
  });

  it("listSchedulesForUser stamps each row with ITS chat's state (one Redis GET per DISTINCT session)", async () => {
    mockFindMany.mockImplementation(({ where }: any) => Promise.resolve(
      where?.enabled === true
        ? [schedRow({ id: 'a1', sessionId: 's1' }), schedRow({ id: 'a2', sessionId: 's1' }), schedRow({ id: 'b1', sessionId: 's2' })]
        : [],
    ));
    mockGet.mockImplementation((key: string) => Promise.resolve(key.endsWith(':s1') ? '4' : '9'));
    mockPTtl.mockImplementation((key: string) => Promise.resolve(key.endsWith(':s1') ? 60_000 : -1));
    const rows = await listSchedulesForUser('u1');
    const byId: Record<string, any> = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.a1.dailyFiresUsed).toBe(4);
    expect(byId.a2.dailyFiresUsed).toBe(4); // same chat → same pooled counter
    expect(byId.b1.dailyFiresUsed).toBe(9);
    expect(byId.a1.capWindowResetsAt).not.toBeNull();
    expect(byId.b1.capWindowResetsAt).toBeNull(); // s2's key has no TTL
    expect(mockGet).toHaveBeenCalledTimes(2); // per DISTINCT session, not per row
    expect(mockGet).toHaveBeenCalledWith('coding:sched:fires:s1');
    expect(mockGet).toHaveBeenCalledWith('coding:sched:fires:s2');
  });

  // Ticket dd0d37ac: an ACTIVE recurring schedule (242 runs) vanished from two
  // consecutive full list_schedules pulls while it kept firing — the old
  // newest-N take windowed it out once enough newer terminal rows accumulated.
  it('never windows out an ACTIVE schedule, even with a full terminal history (dd0d37ac)', async () => {
    const terminal = Array.from({ length: 50 }, (_, i) =>
      schedRow({ id: `term_${i}`, enabled: false, createdAt: new Date(`2026-08-1${i % 10}T00:00:00Z`) }));
    mockFindMany.mockImplementation(async (args: any) => {
      if (args?.where?.enabled === false) {
        expect(args.take).toBe(50); // terminal history stays capped
        return terminal;
      }
      expect(args.take).toBeUndefined(); // active rows: NEVER windowed
      return [schedRow({ id: 'live_old', createdAt: new Date('2026-07-01T00:00:00Z') })];
    });
    mockGet.mockResolvedValue(null);
    mockPTtl.mockResolvedValue(-2);
    const rows = await listSchedules('s1');
    expect(rows.some((r) => r.id === 'live_old')).toBe(true);
    expect(rows.filter((r) => r.id.startsWith('term_'))).toHaveLength(50);
    expect(rows[rows.length - 1].id).toBe('live_old'); // merged list stays newest-first
  });

  it('listSchedulesForUser keeps an old ACTIVE schedule visible beyond the 100-row history cap', async () => {
    mockFindMany.mockImplementation(async (args: any) => {
      if (args?.where?.enabled === false) {
        expect(args.take).toBe(100);
        return [schedRow({ id: 'term_new', enabled: false, sessionId: 's2' })];
      }
      expect(args.take).toBeUndefined();
      return [schedRow({ id: 'live_old', sessionId: 's1', createdAt: new Date('2026-07-01T00:00:00Z') })];
    });
    mockGet.mockResolvedValue(null);
    mockPTtl.mockResolvedValue(-2);
    const rows = await listSchedulesForUser('u1');
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('live_old');
    expect(ids).toContain('term_new');
  });

  it('getScheduleForUser (ticket 03aef0da) resolves a STOPPED row past the terminal window — exact id or unique ≥8-char prefix, owner-scoped', async () => {
    const stopped = schedRow({ id: 'c461c912-8a2d-441e-a52a-ff2f9a9d9d69', enabled: false, sessionId: 's9', lastStatus: 'cancelled', createdAt: new Date('2026-09-28T17:53:02Z') });
    mockFindFirst.mockReset().mockImplementation(async ({ where }: any) => (where.id === stopped.id && where.userId === 'u1' ? stopped : null));
    mockFindMany.mockReset().mockImplementation(async ({ where }: any) =>
      (where.userId === 'u1' && typeof where.id?.startsWith === 'string' && stopped.id.startsWith(where.id.startsWith) ? [{ id: stopped.id }] : []));
    mockGet.mockResolvedValue(null);
    mockPTtl.mockResolvedValue(-2);
    expect(await getScheduleForUser('u1', stopped.id)).toMatchObject({ id: stopped.id, enabled: false, sessionId: 's9', lastStatus: 'cancelled' });
    expect((await getScheduleForUser('u1', 'c461c912'))?.id).toBe(stopped.id);
    expect(await getScheduleForUser('u2', stopped.id)).toBeNull(); // another owner's id never resolves
    expect(await getScheduleForUser('u1', 'c461')).toBeNull(); // < 8 chars stays exact-only
  });
});

// ── Terminal visibility (feedback dd0d37ac) ─────────────────────────────────
// A recurring schedule "silently vanished between firings": auto-disable
// (expiry / run cap) flipped enabled:false with no owner signal, and the
// newest-first take:100 listing window could hide even an ACTIVE row once
// enough newer terminal rows accumulated.

describe('schedule terminal visibility (feedback dd0d37ac)', () => {
  const dueRow = (overrides: any = {}) => ({
    id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'do the thing', kind: 'recurring',
    intervalSec: MIN_INTERVAL_SEC, nextRunAt: new Date(Date.now() - 1000), enabled: true,
    runsCount: 0, maxRuns: 500, expiresAt: new Date(Date.now() + 20 * 86_400_000), // +20d: outside the schedule_near_cap 3d expiry window (b4d1096c)
    lastFiredAt: null, lastStatus: null, createdAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    mockUpdate.mockReset().mockResolvedValue({});
    mockUpdateMany.mockReset().mockResolvedValue({ count: 1 }); // atomic claim wins
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockIncr.mockReset().mockResolvedValue(1); // under the daily cap
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
    mockSet.mockReset().mockResolvedValue('OK'); // NX claim succeeds
    mockMsgCreate.mockClear();
    mockEmitHookEvent.mockClear();
    mockSweepHookEvents.mockClear();
  });

  it('listSchedulesForUser queries ACTIVE rows explicitly — a live recurring schedule never falls out of the terminal window', async () => {
    const oldActive = { ...liveRow, id: 'sch_old', createdAt: new Date('2026-07-01T00:00:00Z') };
    mockFindMany.mockReset().mockImplementation(({ where }: any) => {
      if (where?.enabled === true) return Promise.resolve([oldActive]);
      if (where?.enabled === false) return Promise.resolve([]); // 100 newer terminal rows in the incident
      return Promise.resolve([]); // the legacy single-window query must NOT be used
    });
    const rows = await listSchedulesForUser('u1');
    expect(rows.map((r) => r.id)).toContain('sch_old');
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'u1', enabled: true }) }),
    );
    // …and the terminal half stays a bounded history window (newest 100).
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'u1', enabled: false }), take: 100 }),
    );
  });

  it('fireDue disabling a run-cap-exhausted row posts the notice with the cap reason', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ runsCount: 500, maxRuns: 500 })]);
    await fireDue();
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'sch_1' }, data: { enabled: false, lastStatus: 'expired', disabledAt: expect.any(Date) } });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockMsgCreate).toHaveBeenCalledTimes(1);
    expect(mockMsgCreate.mock.calls[0][0].data.content).toMatch(/500-run cap/);
  });

  it('fireDue disabling an EXPIRED row posts ONE owner-visible notice and never fires it', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ expiresAt: new Date(Date.now() - 60_000) })]);
    await fireDue();
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'sch_1' }, data: { enabled: false, lastStatus: 'expired', disabledAt: expect.any(Date) } });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockMsgCreate).toHaveBeenCalledTimes(1);
    expect(mockMsgCreate.mock.calls[0][0].data.chatId).toBe('s1');
    expect(mockMsgCreate.mock.calls[0][0].data.content).toMatch(/will NOT fire or resume/);
  });

  it('the terminal notice is NX-gated — a repeat sweep of the same row does not repost', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ expiresAt: new Date(Date.now() - 60_000) })]);
    mockSet.mockResolvedValue(null as never); // already claimed this row's notice
    await fireDue();
    expect(mockMsgCreate).not.toHaveBeenCalled();
  });

  it('a recurring schedule that starts its FINAL allowed run posts the terminal notice too', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ runsCount: 499, maxRuns: 500 })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    // Post-fire bump is a CONDITIONAL updateMany (fbe65673 review finding 1):
    // a cancel mid-fire (enabled:false) matches 0 rows and is never overwritten.
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'sch_1', enabled: true }),
      data: expect.objectContaining({ enabled: false, runsCount: 500 }),
    }));
    expect(mockMsgCreate).toHaveBeenCalledTimes(1);
    expect(mockMsgCreate.mock.calls[0][0].data.content).toMatch(/500-run cap/);
  });

  it('a ONE-SHOT schedule completing stays quiet (its end is expected)', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ kind: 'once', runsCount: 0, maxRuns: 1 })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(mockMsgCreate).not.toHaveBeenCalled();
  });
});

// ── schedule_disabled hook emission (overnight forensics 2026-08-24, fix 2) ──
// EVERY enabled:false flip must emit ONE schedule_disabled event with the
// right reason, so a subscribed supervisor notices a stopped cadence — the
// TT-RD session cancelled its own recurring watch and NOTHING noticed.

describe('schedule_disabled hook emission (forensics fix 2)', () => {
  const dueRow = (overrides: any = {}) => ({
    id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'do the thing', kind: 'recurring',
    intervalSec: MIN_INTERVAL_SEC, nextRunAt: new Date(Date.now() - 1000), enabled: true,
    runsCount: 0, maxRuns: 500, expiresAt: new Date(Date.now() + 20 * 86_400_000), // +20d: outside the schedule_near_cap 3d expiry window (b4d1096c)
    lastFiredAt: null, lastStatus: null,
    ...overrides,
  });
  const disabledEmits = () =>
    mockEmitHookEvent.mock.calls.filter((c) => c[1] === 'schedule_disabled');

  beforeEach(() => {
    mockUpdate.mockReset().mockResolvedValue({});
    mockUpdateMany.mockReset().mockResolvedValue({ count: 1 }); // atomic claim wins
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockIncr.mockReset().mockResolvedValue(1); // under the daily cap
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
    mockSet.mockReset().mockResolvedValue('OK');
    mockMsgCreate.mockClear();
    mockEmitHookEvent.mockClear();
    mockSweepHookEvents.mockClear();
  });

  it('cancelSchedule (session-scoped) emits reason cancelled with the full payload', async () => {
    mockFindFirst.mockResolvedValue({ ...liveRow });
    await cancelSchedule('s1', 'sch_1');
    expect(disabledEmits()).toHaveLength(1);
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      's1', 'schedule_disabled', expect.stringContaining('cancelled'),
      expect.objectContaining({ scheduleId: 'sch_1', sessionId: 's1', kind: 'recurring', runsCount: 17, reason: 'cancelled' }),
    );
  });

  it('cancelScheduleForUser (user-scoped) emits reason cancelled', async () => {
    mockFindFirst.mockResolvedValue({ ...liveRow });
    await cancelScheduleForUser('u1', 'sch_1');
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      's1', 'schedule_disabled', expect.any(String),
      expect.objectContaining({ scheduleId: 'sch_1', reason: 'cancelled' }),
    );
  });

  it('a cancel that finds no row emits nothing', async () => {
    mockFindFirst.mockResolvedValue(null);
    await cancelSchedule('s1', 'nope');
    await cancelScheduleForUser('u1', 'nope');
    expect(disabledEmits()).toHaveLength(0);
  });

  it('deaf-lane guard: a cancel leaving the chat with NO enabled schedules says so in the summary + payload', async () => {
    mockFindFirst.mockResolvedValue({ ...liveRow });
    mockCount.mockResolvedValue(0); // no enabled rows remain after the cancel
    await cancelSchedule('s1', 'sch_1');
    expect(disabledEmits()).toHaveLength(1);
    const [, , summary, payload] = disabledEmits()[0];
    expect(summary).toContain('cancelled');
    expect(summary).toContain('NO enabled schedules');
    expect(summary).toContain('DEAF');
    expect(payload).toEqual(expect.objectContaining({ reason: 'cancelled', remainingEnabled: 0 }));
  });

  it('a cancel with other enabled schedules still running keeps the plain summary', async () => {
    mockFindFirst.mockResolvedValue({ ...liveRow });
    mockCount.mockResolvedValue(2);
    await cancelSchedule('s1', 'sch_1');
    const [, , summary, payload] = disabledEmits()[0];
    expect(summary).not.toContain('NO enabled schedules');
    expect(payload).toEqual(expect.objectContaining({ reason: 'cancelled', remainingEnabled: 2 }));
  });

  it('non-cancel disables never pay the count query or the suffix', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ expiresAt: new Date(Date.now() - 60_000), runsCount: 7 })]);
    mockCount.mockClear();
    await fireDue();
    const [, , summary, payload] = disabledEmits()[0];
    expect(summary).not.toContain('NO enabled schedules');
    expect(payload.remainingEnabled).toBeUndefined();
  });

  it('pauseSchedulesForLaneArchive (bf656696) pauses every enabled row machine-attributed, lane_archive-stamped, one event each', async () => {
    // The ticket-lane archive deadlock helper: the dispatcher retires a finished
    // lane's leftover backstop schedules (verdict waits etc.) before archiving.
    mockFindMany.mockReset().mockResolvedValue([
      { ...liveRow, id: 'backstop-1', kind: 'once' },
      { ...liveRow, id: 'backstop-2', kind: 'recurring' },
    ]);
    mockUpdate.mockClear();
    const paused = await pauseSchedulesForLaneArchive('s1');
    expect(paused).toBe(2);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    for (const call of mockUpdate.mock.calls) {
      expect(call[0].where.id).toEqual(expect.stringMatching(/^backstop-/));
      expect(call[0].data).toEqual({ enabled: false, lastStatus: 'lane_archive', cancelledBy: 'machine', disabledAt: expect.any(Date) });
    }
    // ONE schedule_disabled event PER row, reason lane_archive, no DEAF suffix
    // (deafness is moot on a chat being archived).
    const emits = disabledEmits();
    expect(emits).toHaveLength(2);
    for (const [src, , summary, payload] of emits) {
      expect(src).toBe('s1');
      expect(summary).toContain('paused by the ticket dispatcher');
      expect(summary).not.toContain('DEAF');
      expect(payload).toEqual(expect.objectContaining({ sessionId: 's1', reason: 'lane_archive', runsCount: 17 }));
    }
    expect(new Set(emits.map((e) => e[3].scheduleId))).toEqual(new Set(['backstop-1', 'backstop-2']));
  });

  it('lane lifecycle fourth review (2026-10-22): pauseSchedulesForLaneArchive with keptLane pauses the rows exactly as the plain path (lane_archive, never remembered) but its event says the lane is KEPT — never "being archived"', async () => {
    mockFindMany.mockReset().mockResolvedValue([{ ...liveRow, id: 'backstop-k', kind: 'once' }]);
    mockUpdate.mockClear();
    expect(await pauseSchedulesForLaneArchive('s1', { keptLane: { reason: 'awaiting_owner' } })).toBe(1);
    expect(mockUpdate.mock.calls[0][0].data).toEqual({ enabled: false, lastStatus: 'lane_archive', cancelledBy: 'machine', disabledAt: expect.any(Date) });
    const emits = disabledEmits();
    expect(emits).toHaveLength(1);
    const [, , summary, payload] = emits[0];
    expect(summary).toContain('KEPT (the ticket dispatcher paused this kept lane\'s schedules (kept: awaiting_owner))');
    expect(summary).toContain('is NOT archived');
    expect(summary).not.toContain('being archived');
    expect(payload).toEqual(expect.objectContaining({ reason: 'lane_archive', keptLane: true, detail: 'the ticket dispatcher paused this kept lane\'s schedules (kept: awaiting_owner)' }));
  });

  it('pauseSchedulesForLaneArchive with no enabled rows emits nothing and returns 0', async () => {
    mockFindMany.mockReset().mockResolvedValue([]);
    mockUpdate.mockClear();
    await expect(pauseSchedulesForLaneArchive('s1')).resolves.toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(disabledEmits()).toHaveLength(0);
  });

  it('pauseSchedulesForLaneArchive never throws — a DB failure is a log line and 0', async () => {
    mockFindMany.mockReset().mockRejectedValue(new Error('db down'));
    await expect(pauseSchedulesForLaneArchive('s1')).resolves.toBe(0);
    expect(disabledEmits()).toHaveLength(0);
  });

  it('deafLaneWarningForUser warns only when the chat was left with zero enabled schedules', async () => {
    mockFindFirst.mockResolvedValue({ ...liveRow });
    mockCount.mockResolvedValue(0);
    const warn = await deafLaneWarningForUser('u1', 'sch_1');
    expect(warn).toContain('WARNING — chat s1 now has NO enabled schedules');
    expect(warn).toContain('schedule_message');

    mockCount.mockResolvedValue(1);
    expect(await deafLaneWarningForUser('u1', 'sch_1')).toBeNull();

    mockFindFirst.mockResolvedValue(null);
    expect(await deafLaneWarningForUser('u1', 'nope')).toBeNull();
  });

  it('the sweeper lifetime-expiry disable emits reason expired', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ expiresAt: new Date(Date.now() - 60_000), runsCount: 7 })]);
    await fireDue();
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      's1', 'schedule_disabled', expect.any(String),
      expect.objectContaining({ scheduleId: 'sch_1', kind: 'recurring', runsCount: 7, reason: 'expired' }),
    );
  });

  it('the sweeper pre-fire run-cap disable emits reason max_runs', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ runsCount: 500, maxRuns: 500 })]);
    await fireDue();
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      's1', 'schedule_disabled', expect.any(String),
      expect.objectContaining({ scheduleId: 'sch_1', runsCount: 500, reason: 'max_runs' }),
    );
  });

  it('a recurring row consuming its FINAL allowed run emits reason max_runs with the post-fire count', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ runsCount: 499, maxRuns: 500 })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1); // the final run DID fire
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      's1', 'schedule_disabled', expect.any(String),
      expect.objectContaining({ scheduleId: 'sch_1', runsCount: 500, reason: 'max_runs' }),
    );
  });

  it('a ONE-SHOT completing stays quiet (expected end — its run already emits run_completed)', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ kind: 'once', runsCount: 0, maxRuns: 1 })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(disabledEmits()).toHaveLength(0);
  });

  it('the obsolete continuation disable emits reason obsolete', async () => {
    const CONT = `[HARNESS CONTINUATION r1/3] — not typed by the user. ${continuationCountSentence(4)}. Resume.`;
    mockFindMany.mockReset().mockResolvedValue([dueRow({ id: 'sch_cont', kind: 'once', maxRuns: 1, prompt: CONT })]);
    mockGetPlanStrict.mockReset().mockResolvedValue({ steps: [{ status: 'completed' }] }); // board complete → obsolete
    await fireDue();
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      's1', 'schedule_disabled', expect.any(String),
      expect.objectContaining({ scheduleId: 'sch_cont', kind: 'once', reason: 'obsolete' }),
    );
  });
});

describe('stale-firing guard (fbe65673 — cancel between claim and fire must win)', () => {
  beforeEach(() => {
    mockScheduleFindUnique.mockClear(); // keep the enabled default, drop call history
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
  });

  it('skips the fire when the schedule row was cancelled between the sweeper claim and the fire', async () => {
    mockScheduleFindUnique.mockResolvedValueOnce({ enabled: false });
    const res = await fireScheduleTarget({ id: 'sch_x', sessionId: 's1', prompt: 'do the thing' });
    expect(res).toEqual({ started: false, reason: 'cancelled' });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
  });

  it('skips when the schedule row is gone entirely (deleted/expired cleanup)', async () => {
    mockScheduleFindUnique.mockResolvedValueOnce(null);
    const res = await fireScheduleTarget({ id: 'sch_x', sessionId: 's1', prompt: 'do the thing' });
    expect(res).toEqual({ started: false, reason: 'cancelled' });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
  });

  it('fires normally when the schedule row is still enabled (default)', async () => {
    const res = await fireScheduleTarget({ id: 'sch_x', sessionId: 's1', prompt: 'do the thing' });
    expect(res).toEqual({ started: true });
    expect(mockStartScheduledRun).toHaveBeenCalledWith('s1', 'do the thing', expect.objectContaining({ origin: 'schedule', scheduleId: 'sch_x' }));
  });

  it('never skips on a schedule-read error — uncertainty must not drop a real firing', async () => {
    mockScheduleFindUnique.mockRejectedValueOnce(new Error('db blip'));
    const res = await fireScheduleTarget({ id: 'sch_x', sessionId: 's1', prompt: 'do the thing' });
    expect(res).toEqual({ started: true });
    expect(mockStartScheduledRun).toHaveBeenCalled();
  });

  it('hook wakes skip the re-check — synthetic hook-* ids have no schedule row to read', async () => {
    const res = await fireScheduleTarget({ id: 'hook-9', sessionId: 's1', prompt: 'wake up', origin: 'hook' });
    expect(res).toEqual({ started: true });
    expect(mockScheduleFindUnique).not.toHaveBeenCalled();
    expect(mockStartScheduledRun).toHaveBeenCalledWith('s1', 'wake up', expect.objectContaining({ origin: 'hook' }));
  });
});

describe('continuation staleness guard (feedback fb8b609f)', () => {
  // CONT_PROMPT is built with the REAL prompt builder (requireActual spread in
  // the plan.service mock) so template drift breaks these tests, not prod.
  const CONT_PROMPT = continuationPrompt(1, 3, 4);
  const contRow = (overrides: any = {}) => ({
    id: 'sch_cont', sessionId: 's1', userId: 'u1', prompt: CONT_PROMPT, kind: 'once',
    intervalSec: MIN_INTERVAL_SEC, nextRunAt: new Date(Date.now() - 1000), enabled: true,
    runsCount: 0, maxRuns: 1, expiresAt: new Date(Date.now() + 86_400_000),
    lastFiredAt: null, lastStatus: null,
    ...overrides,
  });

  beforeEach(() => {
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
    mockGetPlanStrict.mockReset().mockResolvedValue(null);
  });

  it('the count regex stays in sync with the prompt template builder', () => {
    expect(CONTINUATION_COUNT_RE.test(continuationCountSentence(7))).toBe(true);
    const rewritten = `${continuationCountSentence(4)}. X`.replace(CONTINUATION_COUNT_RE, continuationCountSentence(2, { verifiedAtFireTime: true }));
    expect(rewritten).toContain('Fire-time plan check: 2 plan step(s) still unfinished');
    expect(rewritten).not.toContain('4 unfinished');
  });

  it('skips the wake when the plan board is already complete', async () => {
    mockGetPlanStrict.mockResolvedValue({ steps: [{ status: 'completed' }, { status: 'blocked' }] });
    const res = await fireScheduleTarget({ id: 'sch_cont', sessionId: 's1', prompt: CONT_PROMPT });
    expect(res).toEqual({ started: false, reason: 'obsolete' });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
  });

  it('skips when the plan read resolves null (genuinely no plan — nothing to resume)', async () => {
    // Pin: getPlanStrict resolves null ONLY when no plan was ever stored; store
    // errors propagate as rejections (covered by the never-skips test below).
    const res = await fireScheduleTarget({ id: 'sch_cont', sessionId: 's1', prompt: CONT_PROMPT });
    expect(res).toEqual({ started: false, reason: 'obsolete' });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
  });

  it('fires with the count corrected at fire time when steps remain', async () => {
    mockGetPlanStrict.mockResolvedValue({ steps: [{ status: 'completed' }, { status: 'pending' }, { status: 'in_progress' }] });
    const res = await fireScheduleTarget({ id: 'sch_cont', sessionId: 's1', prompt: CONT_PROMPT });
    expect(res).toEqual({ started: true });
    const fired = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(fired).toContain('Fire-time plan check: 2 plan step(s) still unfinished');
    expect(fired).not.toContain('4 unfinished');
    expect(fired.startsWith('[HARNESS CONTINUATION r1/3]')).toBe(true); // round marker intact for the cap regex
  });

  it('never skips on a plan-read error — a store failure must not drop a resumption', async () => {
    // getPlanStrict lets store errors propagate (that is its whole purpose); the
    // guard maps a rejection to "unknown" and fires the ORIGINAL prompt.
    mockGetPlanStrict.mockRejectedValue(new Error('store timeout'));
    const res = await fireScheduleTarget({ id: 'sch_cont', sessionId: 's1', prompt: CONT_PROMPT });
    expect(res).toEqual({ started: true });
    expect(mockStartScheduledRun.mock.calls[0][1]).toBe(CONT_PROMPT);
  });

  it('ignores non-continuation prompts entirely (no plan read)', async () => {
    const res = await fireScheduleTarget({ id: 'sch_plain', sessionId: 's1', prompt: 'do the thing' });
    expect(res).toEqual({ started: true });
    expect(mockGetPlanStrict).not.toHaveBeenCalled();
  });

  // agent-decisions prerequisite 5 (2026-09-27): the guard covers EVERY origin
  // (39 machine + 11 hook of the 85 "Continuation no-op" finals / 14 d ran the
  // full loop on a completed board) and each skip writes ONE
  // schedule_continuation_skip row.
  it('a HOOK-origin continuation wake on a completed board is skipped too, with ONE schedule_continuation_skip row (origin hook, seam fire)', async () => {
    mockGetPlanStrict.mockResolvedValue({ steps: [{ status: 'completed' }, { status: 'blocked' }] });
    mockRecordLoopMetric.mockClear();
    const res = await fireScheduleTarget({ id: 'hook-7', sessionId: 's1', prompt: CONT_PROMPT, origin: 'hook' });
    expect(res).toEqual({ started: false, reason: 'obsolete' });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    const rows = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === 'schedule_continuation_skip');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: 's1', meta: { scheduleId: 'hook-7', origin: 'hook', seam: 'fire', steps: 2 } });
  });

  it('a hook-origin continuation with steps remaining still fires; the SCHEDULE-origin skip records the row too; a non-continuation hook wake never reads the plan', async () => {
    mockGetPlanStrict.mockResolvedValue({ steps: [{ status: 'pending' }] });
    expect(await fireScheduleTarget({ id: 'hook-7', sessionId: 's1', prompt: CONT_PROMPT, origin: 'hook' })).toEqual({ started: true });
    mockGetPlanStrict.mockResolvedValue({ steps: [{ status: 'completed' }] });
    mockRecordLoopMetric.mockClear();
    expect(await fireScheduleTarget({ id: 'sch_cont', sessionId: 's1', prompt: CONT_PROMPT })).toEqual({ started: false, reason: 'obsolete' });
    const rows = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === 'schedule_continuation_skip');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ meta: { scheduleId: 'sch_cont', origin: 'schedule', seam: 'fire', steps: 1 } });
    mockGetPlanStrict.mockClear();
    expect(await fireScheduleTarget({ id: 'hook-8', sessionId: 's1', prompt: 'Fleet event from chat "x" (run_completed)', origin: 'hook' })).toEqual({ started: true });
    expect(mockGetPlanStrict).not.toHaveBeenCalled();
  });

  it('sweeper disables an obsolete one-shot continuation row (no skip-every-15-min loop)', async () => {
    mockFindMany.mockReset().mockResolvedValue([contRow()]);
    mockUpdate.mockReset().mockResolvedValue({});
    mockUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    mockIncr.mockReset().mockResolvedValue(1);
    mockGetChatAutonomy.mockReset().mockResolvedValue(null);
    mockSet.mockReset().mockResolvedValue('OK');
    mockGetPlanStrict.mockReset().mockResolvedValue({ steps: [{ status: 'completed' }] });
    await fireDue();
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    const disable = mockUpdate.mock.calls.map((c) => c[0]).find((u) => u?.data?.enabled === false);
    expect(disable).toBeTruthy();
    expect(disable.data.lastStatus).toBe('skipped:obsolete');
  });
});

describe('continuation prompt claim discipline (ticket b3faa910)', () => {
  // The run-executor backstop builds its wake prompt with the REAL
  // continuationPrompt builder (requireActual spread in the plan.service
  // mock), so these assertions pin prod output — template drift breaks here.
  it('carries the claim-discipline block while keeping both guard hooks intact', () => {
    const p = continuationPrompt(2, 3, 4);
    expect(p.startsWith('[HARNESS CONTINUATION r2/3]')).toBe(true); // round-cap regex marker (run-executor)
    expect(CONTINUATION_COUNT_RE.test(p)).toBe(true); // fire-time staleness rewrite still applies
    expect(p).toContain('CLAIM DISCIPLINE');
    expect(p).toContain('observed THIS run');
    expect(p).toContain('re-verify with a fresh tool call in THIS run');
    expect(p).toContain('No artifact id = no claim');
    expect(p).toContain('Report honestly what remains.');
  });

  it('keeps the claim-discipline block after the fire-time count rewrite', () => {
    const rewritten = continuationPrompt(1, 3, 4)
      .replace(CONTINUATION_COUNT_RE, continuationCountSentence(2, { verifiedAtFireTime: true }));
    expect(rewritten).toContain('Fire-time plan check: 2 plan step(s) still unfinished');
    expect(rewritten).not.toContain('4 unfinished');
    expect(rewritten).toContain('CLAIM DISCIPLINE');
    expect(rewritten).toContain('No artifact id = no claim');
    expect(rewritten.startsWith('[HARNESS CONTINUATION r1/3]')).toBe(true);
  });

  it('names the completion-claim kinds the evidence guard watches for', () => {
    const p = continuationPrompt(1, 3, 1);
    for (const kind of ['deployed', 'merged', 'pushed', 'probed', 'ticket closed', 'tests green']) {
      expect(p).toContain(kind);
    }
    expect(p).toContain('journal-backed evidence guard');
  });
});


// ── promptSetBy (2026-08-30 fleet audit — autonomous prompt-drift surfacing) ──
describe('promptSetBy authorship stamp', () => {
  // updateScheduleForUser resolve-then-load path: findFirst returns the live row.
  beforeEach(() => {
    mockFindFirst.mockReset().mockResolvedValue(liveRow);
    mockUpdate.mockReset().mockImplementation(({ data }: any) => Promise.resolve({ ...liveRow, ...data }));
  });

  it('createSchedule stamps promptSetBy when provided', async () => {
    // Cadence note (ticket 2694a581): a 15m MACHINE recurring is now refused by
    // the cap-cadence guard (96/day > the 48 default cap) — this test's subject
    // is the authorship stamp, so it arms at a fitting 60m cadence.
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: 3600, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(mockCreate.mock.calls[0][0].data.promptSetBy).toBe('machine');
  });

  it('createSchedule omits promptSetBy when not provided (NULL = legacy)', async () => {
    const r = await createSchedule({ ...base, kind: 'recurring', intervalSec: MIN_INTERVAL_SEC });
    expect(r.ok).toBe(true);
    expect(mockCreate.mock.calls[0][0].data).not.toHaveProperty('promptSetBy');
  });

  it('updateScheduleForUser re-stamps authorship on a prompt rewrite', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { prompt: 'watch only now', promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'sch_1' }, data: { prompt: 'watch only now', promptSetBy: 'machine' } });
  });

  it('an interval-only update does NOT touch promptSetBy', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { intervalSec: 3600, promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'sch_1' }, data: { intervalSec: 3600 } });
  });
});

// ── Provider-throttled continuation delay (ticket cffaa701) ─────────────────
// A run KILLED by an exhausted provider transient lane (429/5xx) re-fires its
// continuation 3–5 min out (jittered) instead of the usual ~45s — the ~45s
// wake re-entered the still-limited window and re-died (six canlegal-bench
// deaths in ~1.5h on 2026-09-14).
describe('providerThrottleRequeueDelayMs (cffaa701)', () => {
  afterEach(() => { delete process.env.CONTINUATION_PROVIDER_THROTTLE_DELAY_MS; });

  it('defaults to the 3–5 min jittered band (rand-stubbed edges)', () => {
    expect(providerThrottleRequeueDelayMs(() => 0)).toBe(PROVIDER_THROTTLE_REQUEUE_DELAY_MS);
    expect(providerThrottleRequeueDelayMs(() => 0.999999)).toBeLessThan(PROVIDER_THROTTLE_REQUEUE_DELAY_MS + 120_000);
    expect(PROVIDER_THROTTLE_REQUEUE_DELAY_MS).toBe(180_000);
  });

  it('CONTINUATION_PROVIDER_THROTTLE_DELAY_MS sets an EXACT delay (tests/ops)', () => {
    process.env.CONTINUATION_PROVIDER_THROTTLE_DELAY_MS = '7';
    expect(providerThrottleRequeueDelayMs(() => 0.5)).toBe(7);
  });

  it('an invalid env value is ignored (falls back to the jittered default)', () => {
    process.env.CONTINUATION_PROVIDER_THROTTLE_DELAY_MS = 'not-a-number';
    expect(providerThrottleRequeueDelayMs(() => 0)).toBe(PROVIDER_THROTTLE_REQUEUE_DELAY_MS);
  });
});

// ── Continuation fast-lane (audit roadmap #2) ────────────────────────────────
// queueContinuationRun requeues a run-end continuation DIRECTLY as a queued
// agent_runs row (machine-origin input, short not-before) instead of the old
// 15-minute once-schedule — no schedule row, no daily-cap token.
describe('continuation fast-lane (queueContinuationRun, audit #2)', () => {
  const CONT_PROMPT = '[HARNESS CONTINUATION r1/3] — not typed by the user. resume the plan';

  beforeEach(() => {
    mockRunFindFirst.mockReset().mockResolvedValue(null);
    mockRunCreate.mockReset().mockResolvedValue({ id: 'run-cont-1' });
    mockRunCount.mockReset().mockResolvedValue(0);
    mockIncr.mockReset(); // the no-daily-cap-token assertion must not see sweeper-test leakage
    // L8/B14 (P3): the queue-time checks default to "no recurring owner" and
    // "plan has unfinished steps" so the mechanics tests exercise the queue.
    mockCount.mockReset().mockResolvedValue(0);
    mockGetPlanStrict.mockReset().mockResolvedValue({ steps: [{ status: 'pending' }] });
  });

  it('queues a direct machine-origin agent_runs row with a short NOT-BEFORE — no schedule row, no daily-cap token', async () => {
    const before = Date.now();
    const r = await queueContinuationRun({ sessionId: 's1', userId: 'u1', prompt: CONT_PROMPT });
    expect(r.ok).toBe(true);
    expect(r.runId).toBe('run-cont-1');
    expect(mockRunCreate).toHaveBeenCalledTimes(1);
    const { data } = mockRunCreate.mock.calls[0][0];
    expect(data.sessionId).toBe('s1');
    expect(data.status).toBe('queued');
    // NOT-BEFORE rides leaseExpiresAt (run-claim's queued predicate): the
    // roadmap contract is ~15–60 s, far below the old 900 s schedule floor.
    const notBefore = new Date(data.leaseExpiresAt).getTime() - before;
    expect(notBefore).toBeGreaterThanOrEqual(15_000);
    expect(notBefore).toBeLessThanOrEqual(60_500);
    expect(CONTINUATION_REQUEUE_DELAY_MS).toBeGreaterThanOrEqual(15_000);
    expect(CONTINUATION_REQUEUE_DELAY_MS).toBeLessThanOrEqual(60_000);
    // Machine-origin input: provenance header + the shared continuation prompt.
    expect(data.input.origin).toBe('schedule');
    expect(data.input.userId).toBe('u1');
    // audit 2026-10-06 T4-6: a continuation is framed as a continuation, not a schedule firing.
    expect(data.input.message).toMatch(/^\[MACHINE-TRIGGERED RUN — a harness continuation of the previous run on this chat/);
    expect(data.input.message).not.toContain('a scheduled firing');
    expect(data.input.continuationOf).toBe('unknown');
    expect(data.input.message).toContain(CONT_PROMPT);
    // NOT a coding_schedules firing: no scheduleId (provider-fail counter
    // doctrine), no schedule row, no FIRES_KEY token consumed.
    expect(data.input.scheduleId).toBeUndefined();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it('honors an explicit delayMs override', async () => {
    const before = Date.now();
    await queueContinuationRun({ sessionId: 's1', userId: 'u1', prompt: CONT_PROMPT, delayMs: 20_000 });
    const notBefore = new Date(mockRunCreate.mock.calls[0][0].data.leaseExpiresAt).getTime() - before;
    expect(notBefore).toBeGreaterThanOrEqual(19_000);
    expect(notBefore).toBeLessThanOrEqual(21_000);
  });

  it('busy: another queued row for the session → { ok:false, busy } without creating anything (fallback to the schedule path)', async () => {
    mockRunFindFirst.mockResolvedValue({ id: 'other-queued-row' });
    const r = await queueContinuationRun({ sessionId: 's1', userId: 'u1', prompt: CONT_PROMPT });
    expect(r).toEqual({ ok: false, reason: 'busy' });
    expect(mockRunCreate).not.toHaveBeenCalled();
    expect(mockGetDel).not.toHaveBeenCalled(); // the cap-skip notice is untouched on the busy path
  });

  it('a queued fast-lane row records ONE wake_delivered loop metric (lane continuation_fastlane); a busy skip records none', async () => {
    mockRecordLoopMetric.mockClear();
    const r = await queueContinuationRun({ sessionId: 's1', userId: 'u1', prompt: CONT_PROMPT });
    expect(r.ok).toBe(true);
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith({
      kind: 'wake_delivered', sessionId: 's1', runId: 'run-cont-1', meta: { lane: 'continuation_fastlane' },
    });
    // Busy path: no row queued → no metric.
    mockRecordLoopMetric.mockClear();
    mockRunFindFirst.mockResolvedValue({ id: 'other-queued-row' });
    await queueContinuationRun({ sessionId: 's1', userId: 'u1', prompt: CONT_PROMPT });
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('consumes a pending cap-skip notice onto the input (startScheduledRun parity)', async () => {
    mockGetDel.mockResolvedValue('3');
    const r = await queueContinuationRun({ sessionId: 's1', userId: 'u1', prompt: CONT_PROMPT });
    expect(r.ok).toBe(true);
    expect(mockGetDel).toHaveBeenCalledWith('coding:sched:skipnotice:s1');
    expect(mockRunCreate.mock.calls[0][0].data.input.capSkippedNotice).toBe(3);
  });

  it('RESTORES a consumed cap-skip notice when the row create fails (self-healing signal preserved)', async () => {
    mockGetDel.mockResolvedValue('2');
    mockRunCreate.mockRejectedValue(new Error('db down'));
    const r = await queueContinuationRun({ sessionId: 's1', userId: 'u1', prompt: CONT_PROMPT });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('db down');
    expect(mockIncrBy).toHaveBeenCalledWith('coding:sched:skipnotice:s1', 2);
  });

  it('a create error surfaces as ok:false with the reason (caller falls back to the schedule path)', async () => {
    mockRunCreate.mockRejectedValue(new Error('insert exploded'));
    const r = await queueContinuationRun({ sessionId: 's1', userId: 'u1', prompt: CONT_PROMPT });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('insert exploded');
  });

  it('hasQueuedContinuationRun matches queued rows whose input message carries the harness marker', async () => {
    mockRunCount.mockResolvedValue(1);
    await expect(hasQueuedContinuationRun('s1')).resolves.toBe(true);
    expect(mockRunCount).toHaveBeenCalledWith({
      where: { sessionId: 's1', status: 'queued', input: { path: ['message'], string_contains: '[HARNESS CONTINUATION' } },
    });
    mockRunCount.mockResolvedValue(0);
    await expect(hasQueuedContinuationRun('s1')).resolves.toBe(false);
  });

  it('hasQueuedContinuationRun fails OPEN to false on a read error (the caller falls back, never loses the resumption)', async () => {
    mockRunCount.mockRejectedValue(new Error('db down'));
    await expect(hasQueuedContinuationRun('s1')).resolves.toBe(false);
  });
});

// ── Stopped-schedule decision fast lane (SA0906) ──────────────────────────────
// Every MACHINE permanent-stop path queues the delayed lane-liveness re-check
// (stopped-schedule-alert.queueStoppedScheduleAlert); owner-explicit disables
// (REST pause/DELETE, user-anchored cancel) never do. Lane revival (a fresh
// enabled schedule, or a resume) auto-resolves the chat's open decisions.

describe('stopped-schedule decision fast lane (SA0906)', () => {
  const dueRow = (overrides: any = {}) => ({
    id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'do the thing', kind: 'recurring',
    intervalSec: MIN_INTERVAL_SEC, nextRunAt: new Date(Date.now() - 1000), enabled: true,
    runsCount: 0, maxRuns: 500, expiresAt: new Date(Date.now() + 20 * 86_400_000), // +20d: outside the schedule_near_cap 3d expiry window (b4d1096c)
    lastFiredAt: null, lastStatus: null, createdAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    mockUpdate.mockReset().mockResolvedValue({});
    mockUpdateMany.mockReset().mockResolvedValue({ count: 1 }); // atomic claim wins
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockIncr.mockReset().mockResolvedValue(1); // under the daily cap
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
    mockSet.mockReset().mockResolvedValue('OK');
    mockQueueStoppedScheduleAlert.mockClear();
    mockResolveStoppedForSession.mockClear();
  });

  it('the sweeper lifetime-expiry disable queues the re-check with cause expired', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ expiresAt: new Date(Date.now() - 60_000) })]);
    await fireDue();
    expect(mockQueueStoppedScheduleAlert).toHaveBeenCalledTimes(1);
    expect(mockQueueStoppedScheduleAlert).toHaveBeenCalledWith('sch_1', 'expired');
  });

  it('the sweeper pre-fire run-cap disable queues the re-check with cause max_runs', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ runsCount: 500, maxRuns: 500 })]);
    await fireDue();
    expect(mockQueueStoppedScheduleAlert).toHaveBeenCalledTimes(1);
    expect(mockQueueStoppedScheduleAlert).toHaveBeenCalledWith('sch_1', 'max_runs');
  });

  it('a recurring row consuming its FINAL allowed run queues the re-check (max_runs)', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ runsCount: 499, maxRuns: 500 })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(mockQueueStoppedScheduleAlert).toHaveBeenCalledTimes(1);
    expect(mockQueueStoppedScheduleAlert).toHaveBeenCalledWith('sch_1', 'max_runs');
  });

  it('a normal (non-final) firing queues NOTHING', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ runsCount: 3, maxRuns: 500 })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(mockQueueStoppedScheduleAlert).not.toHaveBeenCalled();
  });

  it('a ONE-SHOT completing queues NOTHING (expected end)', async () => {
    mockFindMany.mockReset().mockResolvedValue([dueRow({ kind: 'once', runsCount: 0, maxRuns: 1 })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(mockQueueStoppedScheduleAlert).not.toHaveBeenCalled();
  });

  it('an owner cancel (default initiator) files NOTHING — the owner just chose that', async () => {
    mockFindFirst.mockResolvedValue({ ...liveRow });
    await expect(cancelScheduleForUser('u1', 'sch_1')).resolves.toBe(true);
    expect(mockQueueStoppedScheduleAlert).not.toHaveBeenCalled();
    mockFindFirst.mockResolvedValue({ ...liveRow });
    await expect(cancelScheduleForUser('u1', 'sch_1', { initiator: 'owner' })).resolves.toBe(true);
    expect(mockQueueStoppedScheduleAlert).not.toHaveBeenCalled();
  });

  it('a MACHINE-turn cancel of a recurring schedule queues the re-check with cause cancelled', async () => {
    mockFindFirst.mockResolvedValue({ ...liveRow });
    await expect(cancelScheduleForUser('u1', 'sch_1', { initiator: 'machine' })).resolves.toBe(true);
    expect(mockQueueStoppedScheduleAlert).toHaveBeenCalledTimes(1);
    expect(mockQueueStoppedScheduleAlert).toHaveBeenCalledWith('sch_1', 'cancelled');
  });

  it('a MACHINE-turn cancel of a ONE-SHOT queues nothing (once-schedules never file)', async () => {
    mockFindFirst.mockResolvedValue({ ...liveRow, kind: 'once', maxRuns: 1 });
    await expect(cancelScheduleForUser('u1', 'sch_1', { initiator: 'machine' })).resolves.toBe(true);
    expect(mockQueueStoppedScheduleAlert).not.toHaveBeenCalled();
  });

  it('the session-scoped cancel (owner Schedules-tab DELETE) files nothing', async () => {
    mockFindFirst.mockResolvedValue({ ...liveRow });
    await expect(cancelSchedule('s1', 'sch_1')).resolves.toBe(true);
    expect(mockQueueStoppedScheduleAlert).not.toHaveBeenCalled();
  });

  it('the Schedules-tab PAUSE files nothing (owner-explicit)', async () => {
    mockFindFirst.mockResolvedValue({ ...liveRow });
    mockUpdate.mockImplementation(async ({ data }: any) => ({ ...liveRow, ...data }));
    const res = await setScheduleEnabledForChat('s1', 'sch_1', false);
    expect(res.ok).toBe(true);
    expect(mockQueueStoppedScheduleAlert).not.toHaveBeenCalled();
    expect(mockResolveStoppedForSession).not.toHaveBeenCalled();
  });

  it('a Schedules-tab RESUME auto-resolves the chat\'s open stopped-schedule decisions (lane revival)', async () => {
    mockFindFirst.mockResolvedValue({ ...liveRow, enabled: false, lastStatus: 'paused' });
    mockCount.mockResolvedValue(0);
    mockUpdate.mockImplementation(async ({ data }: any) => ({ ...liveRow, ...data }));
    const res = await setScheduleEnabledForChat('s1', 'sch_1', true);
    expect(res.ok).toBe(true);
    expect(mockResolveStoppedForSession).toHaveBeenCalledTimes(1);
    expect(mockResolveStoppedForSession).toHaveBeenCalledWith('s1', 'sch_1'); // v1#12: the successor is NAMED
  });

  it('createSchedule (a fresh enabled schedule = successor) auto-resolves the chat\'s open decisions', async () => {
    mockCount.mockResolvedValue(0);
    mockCreate.mockResolvedValue({
      id: 'sch_new', sessionId: 's1', userId: 'u1', prompt: 'p', kind: 'recurring',
      intervalSec: MIN_INTERVAL_SEC, nextRunAt: new Date(), enabled: true, runsCount: 0,
      maxRuns: 500, expiresAt: new Date(), lastFiredAt: null, lastStatus: null,
    });
    const res = await createSchedule({ sessionId: 's1', userId: 'u1', prompt: 'p', kind: 'recurring', intervalSec: MIN_INTERVAL_SEC });
    expect(res.ok).toBe(true);
    expect(mockResolveStoppedForSession).toHaveBeenCalledTimes(1);
    expect(mockResolveStoppedForSession).toHaveBeenCalledWith('s1', 'sch_new'); // v1#12: the successor is NAMED
  });

  it('a REJECTED create (validation) resolves nothing — no schedule was armed', async () => {
    const res = await createSchedule({ sessionId: 's1', userId: 'u1', prompt: '', kind: 'recurring', intervalSec: MIN_INTERVAL_SEC });
    expect(res.ok).toBe(false);
    expect(mockResolveStoppedForSession).not.toHaveBeenCalled();
  });

  it('a throwing alert seam never breaks the stop path (fail-open, logged)', async () => {
    mockQueueStoppedScheduleAlert.mockImplementation(() => { throw new Error('alert seam exploded'); });
    mockFindMany.mockReset().mockResolvedValue([dueRow({ expiresAt: new Date(Date.now() - 60_000) })]);
    await expect(fireDue()).resolves.toBeUndefined();
    // The disable itself landed despite the seam failure.
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'sch_1' }, data: { enabled: false, lastStatus: 'expired', disabledAt: expect.any(Date) } });
  });

  it('a throwing resolve seam never breaks a resume', async () => {
    mockResolveStoppedForSession.mockRejectedValue(new Error('inbox down'));
    mockFindFirst.mockResolvedValue({ ...liveRow, enabled: false, lastStatus: 'paused' });
    mockCount.mockResolvedValue(0);
    mockUpdate.mockImplementation(async ({ data }: any) => ({ ...liveRow, ...data }));
    const res = await setScheduleEnabledForChat('s1', 'sch_1', true);
    expect(res.ok).toBe(true);
  });
});

// ── Remediation P2 v1#6 — the durable owner-answer wake retry ─────────────────
describe('armOwnerAnswerRetrySchedule (v1#6 durable answer wake)', () => {
  const { armOwnerAnswerRetrySchedule, OWNER_ANSWER_RETRY_MARKER_PREFIX } = jest.requireActual('./schedule.service');

  beforeEach(() => {
    mockFindFirst.mockResolvedValue(null);
    mockChatFindUnique.mockResolvedValue({ userId: 'u1' });
    mockCreate.mockImplementation(async ({ data }: any) => ({ id: 'retry-row-1', ...data }));
  });

  it('creates a system-authored once row: 3-min first attempt, 24h expiry, marker-led prompt', async () => {
    const r = await armOwnerAnswerRetrySchedule({
      sessionId: 's1', prompt: '[Owner inbox — the OWNER just answered] …', marker: '[owner-answer-retry:oq_abc]',
    });
    expect(r).toEqual({ ok: true, scheduleId: 'retry-row-1' });
    const data = mockCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ sessionId: 's1', userId: 'u1', kind: 'once', maxRuns: 1, enabled: true, promptSetBy: 'system', intervalSec: 180 });
    expect(data.prompt.startsWith('[owner-answer-retry:oq_abc]\n')).toBe(true);
    expect(data.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600e3 + 1000);
  });

  it('dedupes on the marker: an existing enabled retry row is returned, nothing new created', async () => {
    mockFindFirst.mockResolvedValue({ id: 'existing-retry' });
    const r = await armOwnerAnswerRetrySchedule({ sessionId: 's1', prompt: 'p', marker: '[owner-answer-retry:oq_abc]' });
    expect(r).toEqual({ ok: true, scheduleId: 'existing-retry' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses a non-marker prompt (this path is for owner-answer retries ONLY)', async () => {
    const r = await armOwnerAnswerRetrySchedule({ sessionId: 's1', prompt: 'p', marker: '[something-else]' });
    expect(r).toEqual({ ok: false, reason: 'bad_marker' });
    expect(OWNER_ANSWER_RETRY_MARKER_PREFIX).toBe('[owner-answer-retry:');
  });

  it('a missing chat or a DB error degrades to ok:false — never throws', async () => {
    mockChatFindUnique.mockResolvedValue(null);
    await expect(armOwnerAnswerRetrySchedule({ sessionId: 'gone', prompt: 'p', marker: '[owner-answer-retry:x]' }))
      .resolves.toEqual({ ok: false, reason: 'not_found' });
    mockFindFirst.mockRejectedValue(new Error('db down'));
    const r = await armOwnerAnswerRetrySchedule({ sessionId: 's1', prompt: 'p', marker: '[owner-answer-retry:x]' });
    expect(r.ok).toBe(false);
  });
});

// ── P6 (N4 — the 128-rewrites lane): prompt-rewrite ledger, machine cap, and
// the fire-time "prompt changed (vN)" wake notice. ───────────────────────────
describe('schedule prompt history + machine rewrite cap (P6 — N4)', () => {
  const row = {
    id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'old prompt', kind: 'recurring',
    intervalSec: MIN_INTERVAL_SEC, nextRunAt: new Date('2026-09-04T00:00:00Z'), enabled: true,
    runsCount: 3, maxRuns: 500, expiresAt: new Date('2026-09-30T00:00:00Z'),
    lastFiredAt: null, lastStatus: 'started',
  };

  beforeEach(() => {
    delete process.env.PROMPT_REWRITE_CAP_DISABLED;
    mockRecordLoopMetric.mockClear();
    (logger.warn as jest.Mock).mockClear();
    mockFindFirst.mockReset().mockResolvedValue(row);
    mockUpdate.mockReset().mockImplementation(({ data }: any) => Promise.resolve({ ...row, ...data }));
    mockPromptHistoryCreate.mockReset().mockResolvedValue({ id: 'ph-1' });
    mockPromptHistoryCount.mockReset().mockResolvedValue(0);
    mockPromptHistoryFindFirst.mockReset().mockResolvedValue(null);
  });
  afterEach(() => { delete process.env.PROMPT_REWRITE_CAP_DISABLED; });
  const capWarns = () => (logger.warn as jest.Mock).mock.calls.map((c: any[]) => String(c[0])).filter((line) => line.includes('prompt-rewrite cap crossed'));

  it('a prompt rewrite appends the OUTGOING prompt to the ledger (author = the rewriter) BEFORE the overwrite', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { prompt: 'new brief', promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(mockPromptHistoryCreate).toHaveBeenCalledWith({
      data: { scheduleId: 'sch_1', prompt: 'old prompt', author: 'machine' },
    });
    // Ledger row lands before the update (append BEFORE overwriting).
    expect(mockPromptHistoryCreate.mock.invocationCallOrder[0]).toBeLessThan(mockUpdate.mock.invocationCallOrder[0]);
  });

  it('a rewrite without promptSetBy is ledgered as author user; interval-only and NO-OP rewrites are not ledgered', async () => {
    await updateScheduleForUser('u1', 'sch_1', { prompt: 'new brief' });
    expect(mockPromptHistoryCreate).toHaveBeenCalledWith({ data: { scheduleId: 'sch_1', prompt: 'old prompt', author: 'user' } });
    mockPromptHistoryCreate.mockClear();
    await updateScheduleForUser('u1', 'sch_1', { intervalSec: 3600 });
    await updateScheduleForUser('u1', 'sch_1', { prompt: 'old prompt', promptSetBy: 'machine' }); // no-op rewrite
    expect(mockPromptHistoryCreate).not.toHaveBeenCalled();
  });

  // Gate flip 2026-09-11 (owner: full steam): the cap is OBSERVE-ONLY — the
  // 6th machine rewrite LANDS (ledgered + updated) and logs one warn line.
  it('DEFAULT: the 6th MACHINE rewrite in 24h LANDS (ledger + update) and logs the cap crossing — no refusal', async () => {
    mockPromptHistoryCount.mockResolvedValue(5);
    const r = await updateScheduleForUser('u1', 'sch_1', { prompt: 'thrash again', promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(mockPromptHistoryCreate).toHaveBeenCalledWith({ data: { scheduleId: 'sch_1', prompt: 'old prompt', author: 'machine' } });
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'sch_1' }, data: expect.objectContaining({ prompt: 'thrash again' }) }));
    // Counted over MACHINE-authored ledger rows in a rolling 24h window.
    expect(mockPromptHistoryCount).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ scheduleId: 'sch_1', author: 'machine' }),
    }));
    expect(capWarns()).toHaveLength(1);
    expect(capWarns()[0]).toContain('sch_1 (5 in 24h');
    // The retired kill-switch alone changes nothing.
    process.env.PROMPT_REWRITE_CAP_DISABLED = '1';
    const again = await updateScheduleForUser('u1', 'sch_1', { prompt: 'thrash once more', promptSetBy: 'machine' });
    expect(again.ok).toBe(true);
  });

  it('under the cap nothing is logged (the line is the crossing signal, not every rewrite)', async () => {
    mockPromptHistoryCount.mockResolvedValue(4);
    const r = await updateScheduleForUser('u1', 'sch_1', { prompt: 'fifth rewrite', promptSetBy: 'machine' });
    expect(r.ok).toBe(true);
    expect(capWarns()).toHaveLength(0);
  });

  it('USER rewrites are never capped or counted', async () => {
    mockPromptHistoryCount.mockResolvedValue(99);
    const user = await updateScheduleForUser('u1', 'sch_1', { prompt: 'owner rewrite', promptSetBy: 'user' });
    expect(user.ok).toBe(true);
    const user2 = await updateScheduleForUser('u1', 'sch_1', { prompt: 'owner rewrite 2', promptSetBy: 'user' });
    expect(user2.ok).toBe(true);
    expect(mockPromptHistoryCount).not.toHaveBeenCalled();
    expect(capWarns()).toHaveLength(0);
  });

  it('a ledger write failure never blocks a legitimate update (best-effort)', async () => {
    mockPromptHistoryCreate.mockRejectedValue(new Error('db blip'));
    const r = await updateScheduleForUser('u1', 'sch_1', { prompt: 'still lands' });
    expect(r.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalled();
  });
});

describe('fire-time prompt-change notice (P6 — N4)', () => {
  beforeEach(() => {
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
    mockScheduleFindUnique.mockReset().mockResolvedValue({ enabled: true, lastFiredAt: new Date('2026-09-08T00:00:00Z') });
    mockPromptHistoryFindFirst.mockReset().mockResolvedValue(null);
    mockPromptHistoryCount.mockReset().mockResolvedValue(0);
  });

  it('a rewrite SINCE the last firing appends [SCHEDULE STATE: … (vN)] to the fired prompt (appended — the prompt head stays intact for startsWith/title-seed contracts)', async () => {
    mockPromptHistoryFindFirst.mockResolvedValue({ createdAt: new Date('2026-09-08T12:00:00Z'), author: 'machine' });
    mockPromptHistoryCount.mockResolvedValue(2); // two rewrites → current prompt is v3
    const res = await fireScheduleTarget({ id: 'sch_x', sessionId: 's1', prompt: 'do the CURRENT thing' });
    expect(res).toEqual({ started: true });
    const fired = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(fired.startsWith('do the CURRENT thing')).toBe(true); // never prepended
    expect(fired).toMatch(/\[SCHEDULE STATE: this schedule's prompt CHANGED since its last firing \(now v3, last rewritten by machine\)/);
  });

  it('a rewrite BEFORE the last firing adds no notice; no history adds no notice', async () => {
    mockPromptHistoryFindFirst.mockResolvedValue({ createdAt: new Date('2026-09-07T00:00:00Z'), author: 'user' });
    await fireScheduleTarget({ id: 'sch_x', sessionId: 's1', prompt: 'plain' });
    expect(mockStartScheduledRun.mock.calls[0][1]).toBe('plain');
    mockStartScheduledRun.mockClear();
    mockPromptHistoryFindFirst.mockResolvedValue(null);
    await fireScheduleTarget({ id: 'sch_y', sessionId: 's1', prompt: 'plain2' });
    expect(mockStartScheduledRun.mock.calls[0][1]).toBe('plain2');
  });

  it('a never-fired schedule with a pre-fire rewrite still gets the notice (lastFiredAt null)', async () => {
    mockScheduleFindUnique.mockResolvedValue({ enabled: true, lastFiredAt: null });
    mockPromptHistoryFindFirst.mockResolvedValue({ createdAt: new Date('2026-09-08T12:00:00Z'), author: 'user' });
    mockPromptHistoryCount.mockResolvedValue(1);
    await fireScheduleTarget({ id: 'sch_x', sessionId: 's1', prompt: 'first firing' });
    expect(String(mockStartScheduledRun.mock.calls[0][1])).toContain('(now v2, last rewritten by user)');
  });

  it('hook wakes never read the ledger (synthetic ids, no schedule row)', async () => {
    await fireScheduleTarget({ id: 'hook-9', sessionId: 's1', prompt: 'wake', origin: 'hook' });
    expect(mockPromptHistoryFindFirst).not.toHaveBeenCalled();
    expect(mockStartScheduledRun.mock.calls[0][1]).toBe('wake');
  });
});

// ── Supervisor daily-cap floor (rollout watch 2026-09-14 19:42Z: the Fleet
//    Supervisor's manual 96/day grant dropped quiet hook events once five project
//    supervisors reported up to it). ────────────────────────────────────────────
describe('capForSession — supervisor lanes never sit below the daily-cap floor', () => {
  const saved = process.env[SUPERVISOR_MACHINE_RUN_DAILY_CAP_ENV];
  afterEach(() => { if (saved === undefined) delete process.env[SUPERVISOR_MACHINE_RUN_DAILY_CAP_ENV]; else process.env[SUPERVISOR_MACHINE_RUN_DAILY_CAP_ENV] = saved; });

  it('a fleet supervisor with an explicit 96 grant reads 480 (the floor); a higher grant wins; a plain chat keeps its grant', async () => {
    delete process.env[SUPERVISOR_MACHINE_RUN_DAILY_CAP_ENV];
    mockGetChatAutonomy.mockResolvedValue({ scheduleCap: 96 });
    mockChatFindUnique.mockResolvedValue({ isSupervisor: true, isProjectSupervisor: false });
    expect(await capForSession('fleet')).toBe(480);
    mockGetChatAutonomy.mockResolvedValue({ scheduleCap: 900 });
    mockChatFindUnique.mockResolvedValue({ isSupervisor: false, isProjectSupervisor: true });
    expect(await capForSession('proj')).toBe(900);
    mockGetChatAutonomy.mockResolvedValue({ scheduleCap: 96 });
    mockChatFindUnique.mockResolvedValue({ isSupervisor: false, isProjectSupervisor: false });
    expect(await capForSession('plain')).toBe(96);
  });

  it('no grant: a supervisor reads the floor, a plain chat reads the 48 default; the floor is env-tunable; lookups failing keep the grant', async () => {
    mockGetChatAutonomy.mockResolvedValue(null);
    mockChatFindUnique.mockResolvedValue({ isSupervisor: false, isProjectSupervisor: true });
    expect(await capForSession('proj')).toBe(480);
    mockChatFindUnique.mockResolvedValue({ isSupervisor: false, isProjectSupervisor: false });
    expect(await capForSession('plain')).toBe(48);
    process.env[SUPERVISOR_MACHINE_RUN_DAILY_CAP_ENV] = '1000';
    expect(supervisorDailyCapFloor()).toBe(1000);
    mockChatFindUnique.mockResolvedValue({ isSupervisor: true, isProjectSupervisor: false });
    expect(await capForSession('fleet')).toBe(1000);
    process.env[SUPERVISOR_MACHINE_RUN_DAILY_CAP_ENV] = 'nonsense';
    expect(supervisorDailyCapFloor()).toBe(480);
    mockGetChatAutonomy.mockResolvedValue({ scheduleCap: 96 });
    mockChatFindUnique.mockRejectedValue(new Error('db down'));
    expect(await capForSession('fleet')).toBe(96);
  });
});

// ── Schedule priority direct fire (autonomy loop #10, 2026-09-20) ────────────
// fireDueScheduleNow runs ONE row through the sweep's own row pass
// (processDueScheduleRow) — same atomic claim, caps and bookkeeping — and
// reports an outcome the chat-agent finalize turns into yield / drain.

describe('fireDueScheduleNow (schedule priority direct fire)', () => {
  const dueRow = (overrides: any = {}) => ({
    id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'do the sweep', kind: 'recurring',
    intervalSec: 7200, nextRunAt: new Date(Date.now() - 1000), enabled: true,
    runsCount: 4, maxRuns: 500, expiresAt: new Date(Date.now() + 86_400_000),
    lastFiredAt: null, lastStatus: 'skipped:busy', busySkips: 50, promptSetBy: 'user',
    ...overrides,
  });
  const updatesWith = (pred: (data: any) => boolean) =>
    [...mockUpdate.mock.calls, ...mockUpdateMany.mock.calls].map((c) => c[0]).filter((u) => pred(u.data));

  beforeEach(() => {
    __resetRetiringForTests();
    mockScheduleFindUnique.mockReset().mockResolvedValue(dueRow());
    mockFindMany.mockReset().mockResolvedValue([]);
    mockUpdate.mockReset().mockResolvedValue({});
    mockUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockIncr.mockReset().mockResolvedValue(1);
    mockDecr.mockClear();
    mockGetChatAutonomy.mockReset().mockResolvedValue(null);
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
    mockRecordLoopMetric.mockClear();
  });
  afterAll(() => __resetRetiringForTests());

  it('a due, enabled row is claimed atomically and fired: started, lastStatus started, busySkips reset — exactly the sweep bookkeeping', async () => {
    const out = await fireDueScheduleNow('sch_1');
    expect(out).toEqual({ outcome: 'started' });
    expect(mockScheduleFindUnique.mock.calls[0][0]).toEqual({ where: { id: 'sch_1' } });
    // The claim guards on the row's CURRENT nextRunAt + runsCount (one winner across sweeper/direct-fire).
    const claim = mockUpdateMany.mock.calls.map((c) => c[0]).find((u) => u.where?.nextRunAt instanceof Date && u.where?.runsCount === 4);
    expect(claim).toBeTruthy();
    // The full row satisfies the stale-guard re-read too, so the fired prompt carries the [SCHEDULE STATE] block.
    // (ticket 4565991a coding leg): this fixture's row is promptSetBy 'user' — an
    // OWNER-ARMED row — so the coding-branch opts now ALSO thread
    // scheduleOwnerArmed (expanded render), exactly like the plain-chat branch.
    expect(mockStartScheduledRun).toHaveBeenCalledWith('s1', expect.stringMatching(/^do the sweep\n\n\[SCHEDULE STATE\] firing 5 of 500/), { origin: 'schedule', scheduleId: 'sch_1', scheduleOwnerArmed: true });
    expect(updatesWith((d) => d?.lastStatus === 'started' && d?.runsCount === 5 && d?.busySkips === 0)).toHaveLength(1);
    expect(mockFindMany).not.toHaveBeenCalled(); // not a sweep — no due scan
  });

  it('the concurrent sweeper won the claim → lost_claim, nothing fired, no budget touched', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    expect(await fireDueScheduleNow('sch_1')).toEqual({ outcome: 'lost_claim' });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it('the chat is busy after all → skipped:busy with the usual +3 min re-arm, busySkips increment and token refund', async () => {
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' } as any);
    expect(await fireDueScheduleNow('sch_1')).toEqual({ outcome: 'skipped', reason: 'busy' });
    expect(updatesWith((d) => d?.lastStatus === 'skipped:busy' && d?.busySkips?.increment === 1)).toHaveLength(1);
    expect(mockDecr).toHaveBeenCalledWith('coding:sched:fires:s1');
  });

  it('a row the sweeper already advanced (nextRunAt in the future) → not_due; a missing or disabled row → not_found; neither reads further', async () => {
    mockScheduleFindUnique.mockResolvedValueOnce(dueRow({ nextRunAt: new Date(Date.now() + 60_000) }));
    expect(await fireDueScheduleNow('sch_1')).toEqual({ outcome: 'not_due' });
    mockScheduleFindUnique.mockResolvedValueOnce(null);
    expect(await fireDueScheduleNow('sch_1')).toEqual({ outcome: 'not_found' });
    mockScheduleFindUnique.mockResolvedValueOnce(dueRow({ enabled: false }));
    expect(await fireDueScheduleNow('sch_1')).toEqual({ outcome: 'not_found' });
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
  });

  it('a RETIRING process never fires (its starts would be refused and counted as busy-skips) — the new colour\'s sweeper owns the row', async () => {
    markRetiring(new Date('2026-09-20T08:00:00.000Z'));
    expect(await fireDueScheduleNow('sch_1')).toEqual({ outcome: 'retiring' });
    expect(mockScheduleFindUnique).not.toHaveBeenCalled();
  });

  it('the sweep loop itself still runs every due row through the same pass (refactor pin: fireDue → processDueScheduleRow)', async () => {
    mockFindMany.mockResolvedValue([dueRow(), dueRow({ id: 'sch_2', runsCount: 0 })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(2);
    expect(updatesWith((d) => d?.lastStatus === 'started')).toHaveLength(2);
  });
});

// ── N7 superseded-firing gate wiring (2026-09-25; coding/firing-superseded-gate.ts) ──
// processDueScheduleRow consults the gate for a busy-parked RECURRING row after
// the delta / sweep stashes and before fireScheduleTarget; the "parked firing
// claimed" metric records on every such fire (gate on or off).

describe('processDueScheduleRow — N7 superseded-firing gate wiring', () => {
  const parkedRow = (overrides: any = {}) => ({
    id: 'sch_p', sessionId: 's1', userId: 'u1', prompt: 'Sweep the lanes and report.', kind: 'recurring',
    intervalSec: 3600, nextRunAt: new Date(Date.now() - 1000), enabled: true,
    runsCount: 4, maxRuns: 500, expiresAt: new Date(Date.now() + 86_400_000),
    lastFiredAt: new Date(Date.now() - 90 * 60_000), lastStatus: 'skipped:busy', busySkips: 4, promptSetBy: 'machine',
    ...overrides,
  });
  const updatesWith = (pred: (data: any) => boolean) =>
    [...mockUpdate.mock.calls, ...mockUpdateMany.mock.calls].map((c) => c[0]).filter((u) => pred(u.data));
  const metricsOf = (kind: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m.kind === kind);

  beforeEach(() => {
    __resetRetiringForTests();
    mockScheduleFindUnique.mockReset().mockResolvedValue(parkedRow());
    mockFindMany.mockReset().mockResolvedValue([]);
    mockUpdate.mockReset().mockResolvedValue({});
    mockUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockIncr.mockReset().mockResolvedValue(1);
    mockDecr.mockClear();
    mockGetChatAutonomy.mockReset().mockResolvedValue(null);
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
    mockRecordLoopMetric.mockClear();
    mockPreGateParkedFiring.mockReset().mockResolvedValue(NO_GATE('mode_off'));
  });
  afterAll(() => __resetRetiringForTests());

  it('gate off: a busySkips>0 recurring machine row fires as before and records schedule_parked_claim with the gate reason', async () => {
    mockFindMany.mockResolvedValue([parkedRow()]);
    await fireDue();
    expect(mockPreGateParkedFiring).toHaveBeenCalledTimes(1);
    expect(mockPreGateParkedFiring.mock.calls[0][0]).toMatchObject({ id: 'sch_p', busySkips: 4, promptSetBy: 'machine' });
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.lastStatus === 'started' && d?.busySkips === 0)).toHaveLength(1);
    const claims = metricsOf('schedule_parked_claim');
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ sessionId: 's1', value: 4, meta: { scheduleId: 'sch_p', busySkips: 4, parkedMin: 12, kind: 'recurring', promptSetBy: 'machine', gate: 'mode_off' } });
    expect(claims[0].meta).not.toHaveProperty('finishedRunId');
    expect(metricsOf('schedule_superseded_skip')).toHaveLength(0);
  });

  it('shadow: the gate\'s facts + decision id enrich the parked-claim row; the firing is unchanged', async () => {
    mockPreGateParkedFiring.mockResolvedValue({
      ineligible: null,
      facts: { runId: 'run-abcdef12', finishedAgoMin: 6, noteKind: 'supervisor_note', wasThisSchedulesFiring: true, finishedBeforePark: false },
      decision: { id: 'dec-1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 5, answers: {} },
      stash: { id: 'dec-1', purpose: 'firing_superseded', mode: 'shadow', backend: 'TypeSafe Jev', answers: {}, decidedAt: 'now' },
      skip: null,
    });
    mockFindMany.mockResolvedValue([parkedRow()]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    const claims = metricsOf('schedule_parked_claim');
    expect(claims).toHaveLength(1);
    expect(claims[0].meta).toMatchObject({ finishedRunId: 'run-abcdef12', finishedAgoMin: 6, finishedRunNote: 'supervisor_note', ownFiring: true, decisionId: 'dec-1' });
    expect(claims[0].meta).not.toHaveProperty('gate');
  });

  it('act skip: {outcome: skipped, reason} — lastStatus skipped:superseded, busySkips reset, cap token refunded, schedule_superseded_skip recorded, nothing fired', async () => {
    mockPreGateParkedFiring.mockResolvedValue({
      ineligible: null, facts: { runId: 'run-abcdef12', finishedAgoMin: 6, noteKind: 'supervisor_note', wasThisSchedulesFiring: true, finishedBeforePark: false },
      decision: { id: 'dec-2', mode: 'act', backend: 'TypeSafe Jev', ms: 5, answers: {} }, stash: null,
      skip: { disposition: 'drop_superseded', confidence: 0.95, finishedRunId: 'run-abcdef12' },
    });
    expect(await fireDueScheduleNow('sch_p')).toEqual({ outcome: 'skipped', reason: 'drop_superseded' });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.lastStatus === 'skipped:superseded' && d?.busySkips === 0)).toHaveLength(1);
    expect(updatesWith((d) => d?.lastStatus === 'started')).toHaveLength(0);
    expect(mockDecr).toHaveBeenCalledWith('coding:sched:fires:s1'); // refundDailyCapToken
    const skips = metricsOf('schedule_superseded_skip');
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ sessionId: 's1', meta: { scheduleId: 'sch_p', disposition: 'drop_superseded', confidence: 0.95, finishedRunId: 'run-abcdef12', busySkips: 4 } });
    expect(metricsOf('schedule_parked_claim')).toHaveLength(0); // nothing started
    // merge_into_next stamps its own status.
    mockPreGateParkedFiring.mockResolvedValue({ ineligible: null, facts: null, decision: null, stash: null, skip: { disposition: 'merge_into_next', confidence: 0.93, finishedRunId: 'run-abcdef12' } });
    expect(await fireDueScheduleNow('sch_p')).toEqual({ outcome: 'skipped', reason: 'merge_into_next' });
    expect(updatesWith((d) => d?.lastStatus === 'skipped:merged_next')).toHaveLength(1);
  });

  it('the gate is consulted only for busy-parked RECURRING rows, and a throwing gate fails open (fires)', async () => {
    mockFindMany.mockResolvedValue([parkedRow({ id: 'sch_np', busySkips: 0 }), parkedRow({ id: 'sch_once', kind: 'once', maxRuns: 1, runsCount: 0 })]);
    await fireDue();
    expect(mockPreGateParkedFiring).not.toHaveBeenCalled();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(2);
    expect(metricsOf('schedule_parked_claim')).toHaveLength(1); // the parked one-shot still claims (metric is gate-independent)
    expect(metricsOf('schedule_parked_claim')[0].meta).toMatchObject({ scheduleId: 'sch_once', kind: 'once' });
    mockStartScheduledRun.mockClear();
    mockRecordLoopMetric.mockClear();
    mockPreGateParkedFiring.mockRejectedValue(new Error('gate exploded'));
    expect(await fireDueScheduleNow('sch_p')).toEqual({ outcome: 'started' });
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(metricsOf('schedule_parked_claim')).toHaveLength(1);
  });
});

// ── Supervisor OFF switch (owner 2026-09-26; platform/supervisor-switch.ts) ──
// The sweeper skips a firing on a switched-off supervisor chat AFTER the claim
// and BEFORE dormancy / caps / triage (lastStatus skipped:supervisor_off, no cap
// token, no run, no decision); fireScheduleTarget refuses every other caller's
// wake with reason 'supervisor_off'. A plain chat and an ON supervisor fire
// exactly as before; the all-ON steady state reads no chat flags.

import { invalidateSupervisorSwitchCache, resetSupervisorSwitchMetricWindowForTests, SUPERVISOR_SWITCH_ONCE_REARM_MS } from '../platform/supervisor-switch';

describe('supervisor OFF switch × sweeper + fireScheduleTarget', () => {
  const NOW_MS = Date.now();
  const dueRow = (overrides: any = {}) => ({
    id: 'sch_sup', sessionId: 's-sup', userId: 'u1', prompt: 'Fleet Supervisor sweep — check the fleet', kind: 'recurring',
    intervalSec: 7200, nextRunAt: new Date(NOW_MS - 1000), enabled: true,
    runsCount: 3, maxRuns: 500, expiresAt: new Date(NOW_MS + 20 * 86_400_000),
    lastFiredAt: null, lastStatus: null, busySkips: 0,
    ...overrides,
  });
  const updatesWith = (pred: (data: any) => boolean) =>
    [...mockUpdate.mock.calls, ...mockUpdateMany.mock.calls].map((c) => c[0]).filter((u) => pred(u?.data));
  const switchRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'supervisor_switch');
  const fleetOff = () => {
    mockSettingFind.mockImplementation(async ({ where }: any) => (where?.key === 'fleet_supervisor_enabled' ? { key: where.key, value: '0', updatedAt: new Date() } : null));
    invalidateSupervisorSwitchCache();
  };

  beforeEach(() => {
    mockFindMany.mockReset().mockResolvedValue([dueRow()]);
    mockUpdate.mockReset().mockResolvedValue({});
    mockUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    // The supervisor chat: PLAIN (no coding state), flagged isSupervisor.
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'thinking', archivedAt: null, isSupervisor: true, isProjectSupervisor: false, codingState: null });
    mockIncr.mockReset().mockResolvedValue(1);
    mockExpire.mockClear();
    mockDecr.mockClear();
    mockGetChatAutonomy.mockReset().mockResolvedValue(null);
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
    mockStartDetachedChatRun.mockReset().mockReturnValue('chat:s-sup');
    mockEmitHookEvent.mockClear();
    mockSet.mockReset().mockResolvedValue('OK');
    mockRecordLoopMetric.mockClear();
    mockSettingFind.mockReset().mockResolvedValue(null);
    invalidateSupervisorSwitchCache();
    resetSupervisorSwitchMetricWindowForTests();
  });

  it('both ON: the supervisor sweep fires as before (no skip status, no switch row; the two switch reads are the only cost)', async () => {
    await fireDue();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.lastStatus === 'skipped:supervisor_off')).toHaveLength(0);
    expect(switchRows()).toHaveLength(0);
    expect(mockSettingFind).toHaveBeenCalledWith({ where: { key: 'fleet_supervisor_enabled' } });
    expect(mockSettingFind).toHaveBeenCalledWith({ where: { key: 'project_supervisors_enabled' } });
    // (The no-flag-read-while-ON guarantee is pinned on supervisorWakeSkipById in supervisor-switch.test.ts —
    // the dormancy gate on this path reads the same two flags for its own supervisor exemption.)
  });

  it('fleet OFF: the sweep is SKIPPED after the claim — skipped:supervisor_off, no cap token, no run, no hook event, one telemetry row (source schedule)', async () => {
    fleetOff();
    await fireDue();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    const skips = updatesWith((d) => d?.lastStatus === 'skipped:supervisor_off');
    expect(skips).toHaveLength(1);
    expect(skips[0].data.nextRunAt).toBeUndefined(); // recurring: the claim already slid the cadence
    expect(mockIncr).not.toHaveBeenCalledWith('coding:sched:fires:s-sup'); // no daily-cap token reserved
    expect(mockIncr).toHaveBeenCalledWith('supervisor_switch:skipped:fleet'); // the exact counter
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.runsCount != null)).toHaveLength(0); // no budget consumed
    expect(switchRows()).toEqual([expect.objectContaining({ sessionId: 's-sup', meta: expect.objectContaining({ target: 'fleet', action: 'skipped', source: 'schedule', chatId: 's-sup' }) })]);
  });

  it('fleet OFF: a `once` row re-arms SUPERVISOR_SWITCH_ONCE_REARM_MS out (fires once re-enabled) instead of every tick', async () => {
    fleetOff();
    mockFindMany.mockResolvedValue([dueRow({ kind: 'once', intervalSec: null, maxRuns: 1, runsCount: 0 })]);
    await fireDue();
    const skips = updatesWith((d) => d?.lastStatus === 'skipped:supervisor_off');
    expect(skips).toHaveLength(1);
    const rearm = skips[0].data.nextRunAt as Date;
    expect(rearm).toBeInstanceOf(Date);
    expect(rearm.getTime() - Date.now()).toBeGreaterThan(SUPERVISOR_SWITCH_ONCE_REARM_MS - 5000);
    expect(skips[0].data.enabled).toBeUndefined(); // never disabled — pause-never-delete
  });

  it('project OFF alone leaves the FLEET supervisor sweep firing; a project-supervisor session is skipped', async () => {
    mockSettingFind.mockImplementation(async ({ where }: any) => (where?.key === 'project_supervisors_enabled' ? { key: where.key, value: 'off', updatedAt: new Date() } : null));
    invalidateSupervisorSwitchCache();
    await fireDue();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(switchRows()).toHaveLength(0);

    mockStartDetachedChatRun.mockClear();
    mockFindMany.mockResolvedValue([dueRow({ id: 'sch_proj', sessionId: 's-proj', prompt: 'Project Supervisor sweep — spark' })]);
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'thinking', archivedAt: null, isSupervisor: false, isProjectSupervisor: true, codingState: null });
    await fireDue();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.lastStatus === 'skipped:supervisor_off')).toHaveLength(1);
    expect(switchRows()[0].meta).toMatchObject({ target: 'project', source: 'schedule', chatId: 's-proj' });
  });

  it('a PLAIN chat fires normally even while both switches are OFF (the switch only removes supervisor work)', async () => {
    mockSettingFind.mockImplementation(async () => ({ key: 'x', value: '0', updatedAt: new Date() }));
    invalidateSupervisorSwitchCache();
    mockFindMany.mockResolvedValue([dueRow({ id: 'sch_plain', sessionId: 's-plain', prompt: 'do the thing' })]);
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', archivedAt: null, isSupervisor: false, isProjectSupervisor: false, codingState: { id: 'cs1' } });
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(switchRows()).toHaveLength(0);
  });

  it("fireScheduleTarget backstop: a hook/todo/inbox wake into a switched-off supervisor answers started:false reason 'supervisor_off' and starts nothing", async () => {
    fleetOff();
    const res = await fireScheduleTarget({ id: 'hook-h1', sessionId: 's-sup', prompt: '[FLEET EVENT] run_completed', origin: 'hook' });
    expect(res).toEqual({ started: false, reason: 'supervisor_off' });
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(switchRows()[0].meta).toMatchObject({ target: 'fleet', source: 'dispatch:hook', chatId: 's-sup' });
    // Back ON (cache invalidated): the same wake starts.
    mockSettingFind.mockResolvedValue(null);
    invalidateSupervisorSwitchCache();
    const again = await fireScheduleTarget({ id: 'hook-h1', sessionId: 's-sup', prompt: '[FLEET EVENT] run_completed', origin: 'hook' });
    expect(again.started).toBe(true);
  });

  it('a SystemSetting read error fails OPEN — the supervisor sweep fires', async () => {
    mockSettingFind.mockRejectedValue(new Error('db down'));
    invalidateSupervisorSwitchCache();
    await fireDue();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(switchRows()).toHaveLength(0);
  });
});

/* tt-rd audit 2026-09-27 (finding self-audit-churn-5): a RECURRING firing on a
 * 100 %-complete plan board ran the full loop (the zero-unfinished skip guards
 * only [HARNESS CONTINUATION prompts) and lane prompts turned it into an audit
 * pass — ddd26be0 took three consecutive 30-min "self-audit the prior run"
 * ticks while the box was dark. The firing now carries an ADVISORY notice +
 * ONE schedule_allcomplete_firing row. */
describe('all-complete board firings (tt-rd audit 2026-09-27)', () => {
  // Fixer 2026-09-27 (finding 2): all-complete = EVERY step completed; the first
  // cut's fixture carried a blocked step (the wait-lane shape) and pinned the
  // notice onto it.
  const allDone = (updatedAt: string) => ({ goal: 'g', acceptanceCriteria: [], version: 3, updatedAt, steps: [{ id: 1, status: 'completed', text: 'a' }, { id: 2, status: 'completed', text: 'b' }] });
  const waitLane = (updatedAt: string) => ({ goal: 'g', acceptanceCriteria: [], version: 3, updatedAt, steps: [{ id: 1, status: 'completed', text: 'open PR #706' }, { id: 2, status: 'blocked', text: 'await the reviewer verdict on PR #706' }] });
  const rows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === 'schedule_allcomplete_firing');

  beforeEach(() => {
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
    mockGetPlan.mockReset().mockResolvedValue(null);
    mockGetPlanStrict.mockReset().mockResolvedValue(null);
    mockRecordLoopMetric.mockClear();
  });

  it('planBoardAllComplete: non-empty and EVERY step completed — a blocked step makes it a wait lane, never all-complete (fixer 2026-09-27, finding 2)', () => {
    expect(planBoardAllComplete(null)).toBe(false);
    expect(planBoardAllComplete({ steps: [] })).toBe(false);
    expect(planBoardAllComplete({ steps: [{ status: 'completed' }, { status: 'pending' }] })).toBe(false);
    expect(planBoardAllComplete({ steps: [{ status: 'completed' }, { status: 'blocked' }] })).toBe(false);
    expect(planBoardAllComplete({ steps: [{ status: 'completed' }, { status: 'completed' }] })).toBe(true);
  });

  it('fixer finding 2: a board with ANY blocked step (the wait-lane shape) gets NO notice and NO row, and it FIRES — VERDICT-WAIT POSTURE and the blocked-board audit govern it, never this notice', async () => {
    mockScheduleFindUnique.mockResolvedValueOnce({ enabled: true, kind: 'recurring', runsCount: 3, maxRuns: null, expiresAt: null, lastFiredAt: new Date(Date.now() - 30 * 60_000), promptSetBy: 'machine', ownerSubscribed: null });
    mockGetPlan.mockResolvedValue(waitLane(new Date(Date.now() - 2 * 3_600_000).toISOString()));
    expect(await fireScheduleTarget({ id: 'sch_rec', sessionId: 's1', prompt: 'tick' })).toEqual({ started: true });
    expect(mockStartScheduledRun.mock.calls[0][1]).not.toContain(ALL_COMPLETE_BOARD_MARKER);
    expect(mockStartScheduledRun.mock.calls[0][1]).not.toContain('Do not re-audit, re-probe');
    expect(rows()).toHaveLength(0);
  });

  it('a RECURRING firing on an all-complete board gets the appended advisory (never prepended — the opener survives) and ONE row with action notice; the run still starts', async () => {
    mockScheduleFindUnique.mockResolvedValueOnce({ enabled: true, kind: 'recurring', runsCount: 3, maxRuns: null, expiresAt: null, lastFiredAt: new Date(Date.now() - 30 * 60_000), promptSetBy: 'machine', ownerSubscribed: null });
    mockGetPlan.mockResolvedValue(allDone(new Date(Date.now() - 2 * 3_600_000).toISOString()));
    const res = await fireScheduleTarget({ id: 'sch_rec', sessionId: 's1', prompt: 'Scheduled firing: self-audit the prior run' });
    expect(res).toEqual({ started: true });
    const fired = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(fired.startsWith('Scheduled firing: self-audit the prior run')).toBe(true);
    expect(fired).toContain(ALL_COMPLETE_BOARD_MARKER);
    expect(fired).toContain('nothing on it changed since the last firing');
    expect(fired).toContain('Do not re-audit, re-probe or re-fold the completed board');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ sessionId: 's1', meta: { scheduleId: 'sch_rec', steps: 2, planUnchangedSinceLastFire: true, action: 'notice' } });
  });

  it('a board that CHANGED since the last firing still gets the advisory but planUnchangedSinceLastFire:false; a board with an unfinished step gets nothing', async () => {
    mockScheduleFindUnique.mockResolvedValueOnce({ enabled: true, kind: 'recurring', runsCount: 3, maxRuns: null, expiresAt: null, lastFiredAt: new Date(Date.now() - 30 * 60_000), promptSetBy: 'machine', ownerSubscribed: null });
    mockGetPlan.mockResolvedValue(allDone(new Date().toISOString()));
    await fireScheduleTarget({ id: 'sch_rec', sessionId: 's1', prompt: 'tick' });
    expect(mockStartScheduledRun.mock.calls[0][1]).not.toContain('nothing on it changed');
    expect(rows()[0].meta).toMatchObject({ planUnchangedSinceLastFire: false, action: 'notice' });

    mockRecordLoopMetric.mockClear();
    mockStartScheduledRun.mockClear();
    mockScheduleFindUnique.mockResolvedValueOnce({ enabled: true, kind: 'recurring', runsCount: 3, maxRuns: null, expiresAt: null, lastFiredAt: new Date(), promptSetBy: 'machine', ownerSubscribed: null });
    mockGetPlan.mockResolvedValue({ steps: [{ id: 1, status: 'completed', text: 'a' }, { id: 2, status: 'in_progress', text: 'b' }], updatedAt: new Date().toISOString() });
    await fireScheduleTarget({ id: 'sch_rec', sessionId: 's1', prompt: 'tick' });
    expect(mockStartScheduledRun.mock.calls[0][1]).not.toContain(ALL_COMPLETE_BOARD_MARKER);
    expect(rows()).toHaveLength(0);
  });

  it('a ONE-SHOT row, a hook wake and a [HARNESS CONTINUATION prompt never take this path; a plan read that resolves null adds nothing', async () => {
    mockScheduleFindUnique.mockResolvedValueOnce({ enabled: true, kind: 'once', runsCount: 0, maxRuns: 1, expiresAt: null, lastFiredAt: null, promptSetBy: 'machine', ownerSubscribed: null });
    mockGetPlan.mockResolvedValue(allDone(new Date(0).toISOString()));
    await fireScheduleTarget({ id: 'sch_once', sessionId: 's1', prompt: 'tick' });
    expect(mockStartScheduledRun.mock.calls[0][1]).not.toContain(ALL_COMPLETE_BOARD_MARKER); // ([SCHEDULE STATE] still appends)
    expect(mockGetPlan).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
    mockStartScheduledRun.mockClear();
    await fireScheduleTarget({ id: 'hook-1', sessionId: 's1', prompt: 'Fleet event from chat "x" (run_completed)', origin: 'hook' });
    expect(mockStartScheduledRun.mock.calls[0][1]).not.toContain(ALL_COMPLETE_BOARD_MARKER);
    expect(rows()).toHaveLength(0);
    mockStartScheduledRun.mockClear();
    mockScheduleFindUnique.mockResolvedValueOnce({ enabled: true, kind: 'recurring', runsCount: 3, maxRuns: null, expiresAt: null, lastFiredAt: new Date(), promptSetBy: 'machine', ownerSubscribed: null });
    mockGetPlan.mockResolvedValue(null);
    await fireScheduleTarget({ id: 'sch_rec', sessionId: 's1', prompt: 'tick' });
    expect(mockStartScheduledRun.mock.calls[0][1]).not.toContain(ALL_COMPLETE_BOARD_MARKER);
    expect(rows()).toHaveLength(0);
  });

  it('the notice text is pure and names the fire-time clock the harness supplied', () => {
    const at = new Date('2026-09-27T15:36:00.000Z');
    const n = allCompleteBoardNotice({ at, unchanged: true, steps: 7 });
    expect(n.startsWith(`${ALL_COMPLETE_BOARD_MARKER} — harness-verified at fire time 2026-09-27T15:36:00.000Z]`)).toBe(true);
    expect(n).toContain('(7 step(s))');
    expect(n).toContain('is 100% complete (no blocked step)');
    expect(n).toContain('pull the NEXT queued item (todo_list)');
    expect(n).toContain('answer in ONE line and stop');
  });
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { busySkipAlarmLogLevel, BUSY_SKIP_ALARM_ESCALATE: ESCALATE } = require('./schedule.service');

describe('busySkipAlarmLogLevel (telemetry-noise audit PE-10: 485 warn rows / 7 d, the code itself calls the plain-chat case 100 % false-positive)', () => {
  it('a plain-chat lane / cross-instance claim ("outside") is the tolerated case at EVERY crossing → info', () => {
    expect(busySkipAlarmLogLevel(3, 'outside', {})).toBe('info');
    expect(busySkipAlarmLogLevel(10, 'outside', {})).toBe('info');
    expect(busySkipAlarmLogLevel(75, 'outside', {})).toBe('info');
  });

  it('a named blocker warns only from the ≥10 crossing (the 3-skip level = 9 min busy, under the p50 legitimate run)', () => {
    expect(busySkipAlarmLogLevel(3, 'run', {})).toBe('info');
    expect(busySkipAlarmLogLevel(3, 'stuck_row', {})).toBe('info');
    expect(busySkipAlarmLogLevel(ESCALATE, 'run', {})).toBe('warn');
    expect(busySkipAlarmLogLevel(25, 'stuck_row', {})).toBe('warn');
  });

  it('BUSY_SKIP_ALARM_WARN_ALL=1 restores warn at every crossing', () => {
    expect(busySkipAlarmLogLevel(3, 'outside', { BUSY_SKIP_ALARM_WARN_ALL: '1' })).toBe('warn');
    expect(busySkipAlarmLogLevel(3, 'run', { BUSY_SKIP_ALARM_WARN_ALL: '1' })).toBe('warn');
  });
});

// ── ARCHIVED-TARGET-RETIRE (2026-10-20; platform/archived-target-retire.ts) ──
// Prod logged 821 machine_dispatch_archived_refused rows / 7 d: the sweeper
// treated reason 'archived' as a plain skip (only 'obsolete' was terminal), so a
// recurring row stayed enabled and the claim slid its nextRunAt into a refusal
// every interval. The row is now PAUSED and remembered; a restore re-enables
// exactly the paused rows; arms / resumes / owner-answer retries on an archived
// chat are refused; the refusal row names its surface.

describe('ARCHIVED-TARGET-RETIRE — sweeper pause, arm refusals, restore round trip, refusal surface', () => {
  const dueRow = (overrides: any = {}) => ({
    id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'do the sweep', kind: 'recurring',
    intervalSec: 7200, nextRunAt: new Date(Date.now() - 1000), enabled: true,
    runsCount: 4, maxRuns: 500, expiresAt: new Date(Date.now() + 20 * 86_400_000),
    lastFiredAt: null, lastStatus: 'started', busySkips: 0, promptSetBy: 'user',
    ...overrides,
  });
  const updatesWith = (pred: (data: any) => boolean) =>
    [...mockUpdate.mock.calls, ...mockUpdateMany.mock.calls].map((c) => c[0]).filter((u) => pred(u.data));
  const metricRows = (kind: string) => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === kind);
  const flush = () => new Promise((r) => setImmediate(r));
  const ARCHIVED_CODING_CHAT = { userId: 'u1', mode: 'fast', archivedAt: new Date('2026-10-19T10:00:00Z'), isSupervisor: false, isProjectSupervisor: false, codingState: { id: 'cs1' } };

  beforeEach(() => {
    delete process.env.ARCHIVED_TARGET_RETIRE_DISABLED;
    __resetRetiringForTests();
    mockStore.clear();
    mockStoreGet.mockClear(); mockStorePut.mockClear(); mockStoreDelete.mockClear();
    mockScheduleFindUnique.mockReset().mockResolvedValue(dueRow());
    mockFindMany.mockReset().mockResolvedValue([]);
    mockFindFirst.mockReset().mockResolvedValue(null);
    mockCount.mockReset().mockResolvedValue(0);
    mockUpdate.mockReset().mockImplementation(async ({ data }: any) => ({ ...dueRow(), ...data }));
    mockUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    mockChatFindUnique.mockReset().mockResolvedValue(ARCHIVED_CODING_CHAT);
    mockChatFindFirst.mockReset().mockResolvedValue(null);
    mockIncr.mockReset().mockResolvedValue(1);
    mockDecr.mockClear();
    mockGetChatAutonomy.mockReset().mockResolvedValue(null);
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
    mockStartDetachedChatRun.mockClear();
    mockEmitHookEvent.mockClear();
    mockRecordLoopMetric.mockClear();
  });
  afterAll(() => { delete process.env.ARCHIVED_TARGET_RETIRE_DISABLED; __resetRetiringForTests(); });

  it('(a) a firing refused "archived" PAUSES the row (paused:archived, cancelledBy machine, no re-arm), remembers its id, emits ONE non-alarm target_archived event and refunds the token', async () => {
    expect(await fireDueScheduleNow('sch_1')).toEqual({ outcome: 'skipped', reason: 'archived' });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    const pause = updatesWith((d) => d?.lastStatus === 'paused:archived');
    expect(pause).toHaveLength(1);
    expect(pause[0]).toEqual({ where: { id: 'sch_1' }, data: { lastStatus: 'paused:archived', enabled: false, disabledAt: expect.any(Date), cancelledBy: 'machine' } });
    expect(updatesWith((d) => d?.lastStatus === 'skipped:archived')).toHaveLength(0);
    expect(mockStore.get('schedules/archive-paused/s1#ids')).toEqual({ ids: ['sch_1'], at: expect.any(String) });
    const emits = mockEmitHookEvent.mock.calls.filter((c: any[]) => c[1] === 'schedule_disabled');
    expect(emits).toHaveLength(1);
    expect(emits[0][2]).toContain('its chat is ARCHIVED');
    expect(emits[0][2]).toContain('restoring the chat re-arms this schedule automatically');
    expect(emits[0][2]).not.toContain('DEAF');
    expect(emits[0][3]).toEqual(expect.objectContaining({ scheduleId: 'sch_1', sessionId: 's1', reason: 'target_archived' }));
    expect(mockDecr).toHaveBeenCalledWith('coding:sched:fires:s1');
    // (f) the refusal row names the SURFACE that aimed at the archived chat.
    expect(metricRows('machine_dispatch_archived_refused')).toEqual([expect.objectContaining({
      sessionId: 's1', meta: { origin: 'schedule', surface: 'schedule', chatSurface: 'coding', scheduleId: 'sch_1' },
    })]);
    await flush();
    expect(metricRows('archived_target_retire')).toEqual([expect.objectContaining({
      sessionId: 's1', meta: expect.objectContaining({ surface: 'schedule', action: 'paused', seam: 'sweeper', scheduleId: 'sch_1' }),
    })]);
  });

  it('(a) kill switch ARCHIVED_TARGET_RETIRE_DISABLED=1 restores skip-and-slide byte-for-byte: skipped:archived, row stays enabled, nothing remembered, legacy surface', async () => {
    process.env.ARCHIVED_TARGET_RETIRE_DISABLED = '1';
    expect(await fireDueScheduleNow('sch_1')).toEqual({ outcome: 'skipped', reason: 'archived' });
    expect(updatesWith((d) => d?.lastStatus === 'skipped:archived')).toEqual([{ where: { id: 'sch_1' }, data: { lastStatus: 'skipped:archived' } }]);
    expect(updatesWith((d) => d?.enabled === false)).toHaveLength(0);
    expect(mockStorePut).not.toHaveBeenCalled();
    expect(mockEmitHookEvent.mock.calls.filter((c: any[]) => c[1] === 'schedule_disabled')).toHaveLength(0);
    expect(metricRows('machine_dispatch_archived_refused')).toEqual([expect.objectContaining({ meta: { origin: 'schedule', surface: 'coding' } })]);
  });

  it('(f) hook and owner-answer wakes name their own surface; the chat kind rides chatSurface', async () => {
    mockChatFindUnique.mockResolvedValue({ ...ARCHIVED_CODING_CHAT, codingState: null });
    await fireScheduleTarget({ id: 'hook-h1', sessionId: 's1', prompt: 'tick', origin: 'hook' });
    await fireScheduleTarget({ id: 'owner-inbox-1', sessionId: 's1', prompt: 'answer', origin: 'hook', dispatchSurface: 'owner_answer' });
    expect(metricRows('machine_dispatch_archived_refused').map((r: any) => r.meta)).toEqual([
      { origin: 'hook', surface: 'hook', chatSurface: 'plain' },
      { origin: 'hook', surface: 'owner_answer', chatSurface: 'plain' },
    ]);
  });

  it('(b) createSchedule refuses an archived target (archivedAt OR a satellite parked archived) with the actionable message — nothing created; the switch restores the arm', async () => {
    for (const row of [{ id: 's1', archivedAt: new Date(), codingState: null }, { id: 's1', archivedAt: null, codingState: { status: 'archived' } }]) {
      mockChatFindFirst.mockResolvedValue(row);
      mockCreate.mockClear();
      const r = await createSchedule({ ...base, kind: 'once', intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/^Refused: chat s1 is ARCHIVED/);
      expect(r.error).toContain('Nothing was created');
      expect(mockCreate).not.toHaveBeenCalled();
    }
    await flush();
    expect(metricRows('archived_target_retire').map((r: any) => r.meta)).toEqual([
      expect.objectContaining({ surface: 'arm', action: 'refused', arm: 'create', kind: 'once', promptSetBy: 'machine' }),
      expect.objectContaining({ surface: 'arm', action: 'refused', arm: 'create' }),
    ]);
    // A live chat (findFirst answers a non-archived row) and the kill switch both arm.
    mockChatFindFirst.mockResolvedValue({ id: 's1', archivedAt: null, codingState: { status: 'ready' } });
    expect((await createSchedule({ ...base, kind: 'once', intervalSec: MIN_INTERVAL_SEC })).ok).toBe(true);
    process.env.ARCHIVED_TARGET_RETIRE_DISABLED = '1';
    mockChatFindFirst.mockResolvedValue({ id: 's1', archivedAt: new Date(), codingState: null });
    expect((await createSchedule({ ...base, kind: 'once', intervalSec: MIN_INTERVAL_SEC })).ok).toBe(true);
  });

  it('(b) resume_schedule (setScheduleEnabledForChat) refuses an archived chat with reason archived; pause is untouched', async () => {
    mockFindFirst.mockResolvedValue({ ...liveRow, enabled: false, lastStatus: 'paused' });
    mockChatFindFirst.mockResolvedValue({ id: 's1', archivedAt: new Date(), codingState: null });
    const r = await setScheduleEnabledForChat('s1', 'sch_1', true);
    expect(r).toEqual({ ok: false, reason: 'archived', error: expect.stringContaining('Nothing was resumed') });
    expect(mockUpdate).not.toHaveBeenCalled();
    mockFindFirst.mockResolvedValue({ ...liveRow, enabled: true });
    expect((await setScheduleEnabledForChat('s1', 'sch_1', false)).ok).toBe(true);
  });

  it('(b) armOwnerAnswerRetrySchedule never arms onto an archived chat (stamp or satellite) — no row created', async () => {
    for (const chat of [{ userId: 'u1', archivedAt: new Date(), codingState: null }, { userId: 'u1', archivedAt: null, codingState: { status: 'archived' } }]) {
      mockChatFindUnique.mockResolvedValue(chat);
      mockCreate.mockClear();
      const r = await armOwnerAnswerRetrySchedule({ sessionId: 's1', prompt: 'the answer', marker: '[owner-answer-retry:oq_1]' });
      expect(r).toEqual({ ok: false, reason: 'archived' });
      expect(mockCreate).not.toHaveBeenCalled();
    }
    process.env.ARCHIVED_TARGET_RETIRE_DISABLED = '1';
    mockCreate.mockImplementation(async ({ data }: any) => ({ id: 'retry-1', ...data }));
    expect(await armOwnerAnswerRetrySchedule({ sessionId: 's1', prompt: 'the answer', marker: '[owner-answer-retry:oq_1]' })).toEqual({ ok: true, scheduleId: 'retry-1' });
  });

  it('restore round trip: a session archive pauses + remembers the enabled rows; the restore re-enables EXACTLY those still paused:archived (a row cancelled since, an owner-paused row and another chat stay put)', async () => {
    // In-memory schedule table answering the reads / writes both halves make.
    const table = new Map<string, any>([
      ['a', { ...liveRow, id: 'a', sessionId: 's1', enabled: true, lastStatus: 'started', nextRunAt: new Date(Date.now() - 60_000) }],
      ['b', { ...liveRow, id: 'b', sessionId: 's1', enabled: true, lastStatus: 'started', kind: 'once', runsCount: 0, maxRuns: 1 }],
      ['c', { ...liveRow, id: 'c', sessionId: 's1', enabled: false, lastStatus: 'paused' }],
      ['d', { ...liveRow, id: 'd', sessionId: 's2', enabled: true, lastStatus: 'started' }],
    ]);
    const matches = (r: any, w: any) => (!w?.sessionId || r.sessionId === w.sessionId)
      && (w?.enabled === undefined || r.enabled === w.enabled)
      && (!w?.lastStatus || r.lastStatus === w.lastStatus)
      && (!w?.id || (typeof w.id === 'string' ? r.id === w.id : (w.id.in ?? []).includes(r.id)));
    mockFindMany.mockImplementation(async ({ where }: any) => [...table.values()].filter((r) => matches(r, where)));
    mockFindFirst.mockImplementation(async ({ where }: any) => [...table.values()].find((r) => matches(r, where)) ?? null);
    mockCount.mockImplementation(async ({ where }: any) => [...table.values()].filter((r) => matches(r, where)).length);
    mockUpdate.mockImplementation(async ({ where, data }: any) => { const r = { ...table.get(where.id), ...data }; table.set(where.id, r); return r; });

    expect(await pauseSchedulesForLaneArchive('s1', { archiveRetire: { detail: 'the owner archived this coding session' } })).toBe(2);
    expect(table.get('a')).toMatchObject({ enabled: false, lastStatus: 'paused:archived', cancelledBy: 'machine' });
    expect(table.get('b')).toMatchObject({ enabled: false, lastStatus: 'paused:archived' });
    expect(mockStore.get('schedules/archive-paused/s1#ids')?.ids).toEqual(['a', 'b']);
    const emits = mockEmitHookEvent.mock.calls.filter((c: any[]) => c[1] === 'schedule_disabled');
    expect(emits.map((c: any[]) => c[3].reason)).toEqual(['target_archived', 'target_archived']);
    expect(emits[0][2]).toContain('the owner archived this coding session');
    expect(emits[0][2]).not.toContain('ticket dispatcher');

    // The owner cancels b while the chat is archived — the restore must not revive it.
    table.set('b', { ...table.get('b'), lastStatus: 'cancelled', cancelledBy: 'owner' });
    expect(await resumeSchedulesForRestoredChat('s1')).toBe(1);
    expect(table.get('a')).toMatchObject({ enabled: true, lastStatus: 'resumed', cancelledBy: null, disabledAt: null, busySkips: 0 });
    expect(table.get('a').nextRunAt.getTime()).toBeGreaterThan(Date.now()); // stale nextRunAt recomputed — no catch-up fire
    expect(table.get('b')).toMatchObject({ enabled: false, lastStatus: 'cancelled' });
    expect(table.get('c')).toMatchObject({ enabled: false, lastStatus: 'paused' });
    expect(table.get('d')).toMatchObject({ enabled: true, lastStatus: 'started' });
    expect(mockStore.has('schedules/archive-paused/s1#ids')).toBe(false);
    // The restore IS the unarchive — the archived-target check never runs on it.
    expect(mockChatFindFirst).not.toHaveBeenCalled();
    // A second restore is a quiet no-op.
    expect(await resumeSchedulesForRestoredChat('s1')).toBe(0);
  });

  it('the ticket dispatcher\'s lane-archive pause (no archiveRetire) is unchanged — lane_archive rows, nothing remembered; the restore re-arms nothing', async () => {
    mockFindMany.mockResolvedValue([{ ...liveRow, id: 'backstop-1', kind: 'once' }]);
    expect(await pauseSchedulesForLaneArchive('s1')).toBe(1);
    expect(mockUpdate.mock.calls[0][0].data).toEqual({ enabled: false, lastStatus: 'lane_archive', cancelledBy: 'machine', disabledAt: expect.any(Date) });
    expect(mockStorePut).not.toHaveBeenCalled();
    expect(await resumeSchedulesForRestoredChat('s1')).toBe(0);
    process.env.ARCHIVED_TARGET_RETIRE_DISABLED = '1';
    mockUpdate.mockClear();
    expect(await pauseSchedulesForLaneArchive('s1', { archiveRetire: { detail: 'x' } })).toBe(1);
    expect(mockUpdate.mock.calls[0][0].data.lastStatus).toBe('lane_archive'); // the switch restores the legacy shape
    mockStore.set('schedules/archive-paused/s1#ids', { ids: ['backstop-1'] });
    expect(await resumeSchedulesForRestoredChat('s1')).toBe(0);
  });
});

// ── ALLCOMPLETE-CHARTER-TERMINATION (2026-10-20; ./allcomplete-charter.ts) ──
// 245 schedule_allcomplete_firing rows / 7 d (≈ $745 / week) were advisory-only
// full runs. An all-complete board UNCHANGED since the last firing now reads the
// lane charter: open ⇒ [RE-PLAN FROM CHARTER] replaces the advisory; done ⇒
// would_retire (opt-in pause 'charter_done'); none + an empty ledger ⇒ skipped
// 'all_complete_idle' with a stretched next firing the sweep writes.

describe('ALLCOMPLETE-CHARTER-TERMINATION — fire-time decision + sweep handling', () => {
  const allDone = (updatedAt: string) => ({ goal: 'g', acceptanceCriteria: [], version: 3, updatedAt, steps: [{ id: 1, status: 'completed', text: 'a' }, { id: 2, status: 'completed', text: 'b' }] });
  const lastFired = () => new Date(Date.now() - 60 * 60_000);
  const schedRow = (over: any = {}) => ({ enabled: true, kind: 'recurring', runsCount: 3, maxRuns: null, expiresAt: null, lastFiredAt: lastFired(), promptSetBy: 'machine', ownerSubscribed: null, intervalSec: 1800, ...over });
  const rows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === 'schedule_allcomplete_firing');

  beforeEach(() => {
    mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockStartScheduledRun.mockReset().mockResolvedValue({ started: true });
    mockGetPlan.mockReset().mockResolvedValue(allDone(new Date(Date.now() - 2 * 3_600_000).toISOString()));
    mockGetPlanStrict.mockReset().mockResolvedValue(null);
    mockRecordLoopMetric.mockClear();
    mockDecideAllComplete.mockReset().mockResolvedValue({ action: 'notice', why: 'test_default' });
    mockNoticeIdleSkip.mockClear();
  });

  it('asks the decision ONLY for an unchanged board, with the row facts; a changed board keeps the plain advisory', async () => {
    mockScheduleFindUnique.mockResolvedValueOnce(schedRow());
    await fireScheduleTarget({ id: 'sch_rec', sessionId: 's1', prompt: 'tick' });
    expect(mockDecideAllComplete).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: 'sch_rec', sessionId: 's1', promptSetBy: 'machine', ownerSubscribed: null, intervalSec: 1800, steps: 2 }));
    mockDecideAllComplete.mockClear();
    mockStartScheduledRun.mockClear();
    mockScheduleFindUnique.mockResolvedValueOnce(schedRow());
    mockGetPlan.mockResolvedValue(allDone(new Date().toISOString()));
    await fireScheduleTarget({ id: 'sch_rec', sessionId: 's1', prompt: 'tick' });
    expect(mockDecideAllComplete).not.toHaveBeenCalled();
    expect(mockStartScheduledRun.mock.calls[0][1]).toContain(ALL_COMPLETE_BOARD_MARKER);
  });

  it('charter OPEN: the [RE-PLAN FROM CHARTER] notice REPLACES the advisory; one row action replan', async () => {
    mockScheduleFindUnique.mockResolvedValueOnce(schedRow());
    mockDecideAllComplete.mockResolvedValue({ action: 'replan', why: 'charter_todo_in_progress', openTodos: 2, notice: '[RE-PLAN FROM CHARTER — x] open todos listed' });
    expect(await fireScheduleTarget({ id: 'sch_rec', sessionId: 's1', prompt: 'tick' })).toEqual({ started: true });
    const fired = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(fired).toContain('[RE-PLAN FROM CHARTER — x] open todos listed');
    expect(fired).not.toContain(ALL_COMPLETE_BOARD_MARKER);
    expect(rows()).toEqual([expect.objectContaining({ meta: expect.objectContaining({ action: 'replan', why: 'charter_todo_in_progress', openTodos: 2, planUnchangedSinceLastFire: true }) })]);
  });

  it('charter DONE (observe-only default): would_retire is recorded and the firing proceeds with the advisory', async () => {
    mockScheduleFindUnique.mockResolvedValueOnce(schedRow());
    mockDecideAllComplete.mockResolvedValue({ action: 'would_retire', why: 'charter_todo_done', ownerRow: false });
    expect(await fireScheduleTarget({ id: 'sch_rec', sessionId: 's1', prompt: 'tick' })).toEqual({ started: true });
    expect(mockStartScheduledRun.mock.calls[0][1]).toContain(ALL_COMPLETE_BOARD_MARKER);
    expect(rows()[0].meta).toMatchObject({ action: 'would_retire', why: 'charter_todo_done', ownerRow: false });
  });

  it('charter DONE under the enforce opt-in: no run, reason charter_done (+ the verdict); row action retire_requested (the sweep records retired only when the pause lands)', async () => {
    mockScheduleFindUnique.mockResolvedValueOnce(schedRow());
    mockDecideAllComplete.mockResolvedValue({ action: 'retire', why: 'charter_goal_done' });
    expect(await fireScheduleTarget({ id: 'sch_rec', sessionId: 's1', prompt: 'tick' })).toEqual({ started: false, reason: 'charter_done', detail: 'charter_goal_done' });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(rows()[0].meta).toMatchObject({ action: 'retire_requested', why: 'charter_goal_done' });
  });

  it('NO charter + empty ledger: skipped all_complete_idle with the stretched nextRunAt, the supervisor notice asked once; the control fires', async () => {
    const next = new Date(Date.now() + 2 * 3_600_000);
    mockScheduleFindUnique.mockResolvedValueOnce(schedRow());
    mockDecideAllComplete.mockResolvedValue({ action: 'idle_skip', why: 'quiet', nextRunAt: next, delayMs: 2 * 3_600_000 });
    expect(await fireScheduleTarget({ id: 'sch_rec', sessionId: 's1', prompt: 'tick' })).toEqual({ started: false, reason: 'all_complete_idle', nextRunAt: next });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockNoticeIdleSkip).toHaveBeenCalledWith({ id: 'sch_rec', sessionId: 's1' }, next);
    expect(rows()[0].meta).toMatchObject({ action: 'idle_skip', nextRunAt: next.toISOString(), delayMin: 120 });

    mockRecordLoopMetric.mockClear();
    mockScheduleFindUnique.mockResolvedValueOnce(schedRow());
    mockDecideAllComplete.mockResolvedValue({ action: 'idle_control', why: 'control' });
    expect(await fireScheduleTarget({ id: 'sch_rec', sessionId: 's1', prompt: 'tick' })).toEqual({ started: true });
    expect(mockStartScheduledRun.mock.calls[0][1]).toContain(ALL_COMPLETE_BOARD_MARKER);
    expect(rows()[0].meta).toMatchObject({ action: 'idle_control', control: true });
  });

  it('a decision that throws fires with the plain advisory and the pre-change row (fail toward firing)', async () => {
    mockScheduleFindUnique.mockResolvedValueOnce(schedRow());
    mockDecideAllComplete.mockRejectedValue(new Error('boom'));
    expect(await fireScheduleTarget({ id: 'sch_rec', sessionId: 's1', prompt: 'tick' })).toEqual({ started: true });
    expect(mockStartScheduledRun.mock.calls[0][1]).toContain(ALL_COMPLETE_BOARD_MARKER);
    expect(rows()[0].meta).toEqual({ scheduleId: 'sch_rec', steps: 2, planUnchangedSinceLastFire: true, action: 'notice' });
  });

  describe('the sweep', () => {
    const dueRow = (overrides: any = {}) => ({
      id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'audit the board', kind: 'recurring',
      intervalSec: 1800, nextRunAt: new Date(Date.now() - 1000), enabled: true,
      runsCount: 4, maxRuns: 500, expiresAt: new Date(Date.now() + 20 * 86_400_000),
      lastFiredAt: lastFired(), lastStatus: 'started', busySkips: 0, promptSetBy: 'user', ownerSubscribed: null,
      ...overrides,
    });
    const updatesWith = (pred: (data: any) => boolean) =>
      [...mockUpdate.mock.calls, ...mockUpdateMany.mock.calls].map((c) => c[0]).filter((u) => pred(u.data));

    beforeEach(() => {
      __resetRetiringForTests();
      mockScheduleFindUnique.mockReset().mockResolvedValue(dueRow());
      mockFindMany.mockReset().mockResolvedValue([]);
      mockFindFirst.mockReset().mockResolvedValue(null);
      mockCount.mockReset().mockResolvedValue(0);
      mockUpdate.mockReset().mockImplementation(async ({ data }: any) => ({ ...dueRow(), ...data }));
      mockUpdateMany.mockReset().mockResolvedValue({ count: 1 });
      mockChatFindFirst.mockReset().mockResolvedValue(null);
      mockIncr.mockReset().mockResolvedValue(1);
      mockDecr.mockClear();
      mockGetChatAutonomy.mockReset().mockResolvedValue(null);
      mockEmitHookEvent.mockClear();
    });
    afterAll(() => __resetRetiringForTests());

    it('an idle skip writes skipped:all_complete_idle + the stretched nextRunAt, consumes no run budget and refunds the token', async () => {
      const next = new Date(Date.now() + 2 * 3_600_000);
      mockDecideAllComplete.mockResolvedValue({ action: 'idle_skip', why: 'quiet', nextRunAt: next, delayMs: 2 * 3_600_000 });
      expect(await fireDueScheduleNow('sch_1')).toEqual({ outcome: 'skipped', reason: 'all_complete_idle' });
      const skip = updatesWith((d) => d?.lastStatus === 'skipped:all_complete_idle');
      expect(skip).toHaveLength(1);
      expect(skip[0].data.nextRunAt).toEqual(next);
      expect(skip[0].data.enabled).toBeUndefined();
      expect(updatesWith((d) => d?.runsCount != null)).toHaveLength(0);
      expect(mockDecr).toHaveBeenCalledWith('coding:sched:fires:s1');
    });

    it('a charter_done verdict PAUSES the row (never cancels) with a GUARDED write, records retired and emits ONE schedule_disabled naming the finished charter', async () => {
      mockDecideAllComplete.mockResolvedValue({ action: 'retire', why: 'charter_todo_done' });
      expect(await fireDueScheduleNow('sch_1')).toEqual({ outcome: 'skipped', reason: 'charter_done' });
      const pause = updatesWith((d) => d?.lastStatus === 'paused:charter_done');
      expect(pause).toEqual([{ where: { id: 'sch_1', enabled: true }, data: { lastStatus: 'paused:charter_done', enabled: false, disabledAt: expect.any(Date), cancelledBy: 'machine' } }]);
      const emits = mockEmitHookEvent.mock.calls.filter((c: any[]) => c[1] === 'schedule_disabled');
      expect(emits).toHaveLength(1);
      expect(emits[0][2]).toContain("its lane's charter is finished (charter_todo_done)");
      expect(emits[0][2]).toContain('resume_schedule');
      expect(emits[0][3]).toEqual(expect.objectContaining({ scheduleId: 'sch_1', reason: 'charter_done', detail: 'charter_todo_done' }));
      expect(rows().map((r) => r.meta).filter((m: any) => m.followUp)).toEqual([{ scheduleId: 'sch_1', action: 'retired', why: 'charter_todo_done', followUp: true }]);
    });

    it('review fix: a pause that did not land (the row was cancelled / resumed mid-fire, count 0) records retire_lost and emits nothing', async () => {
      mockDecideAllComplete.mockResolvedValue({ action: 'retire', why: 'charter_todo_done' });
      mockUpdateMany.mockImplementation(async ({ data }: any) => ({ count: data?.lastStatus === 'paused:charter_done' ? 0 : 1 }));
      expect(await fireDueScheduleNow('sch_1')).toEqual({ outcome: 'skipped', reason: 'charter_done' });
      expect(mockEmitHookEvent.mock.calls.filter((c: any[]) => c[1] === 'schedule_disabled')).toHaveLength(0);
      expect(rows().map((r) => r.meta).filter((m: any) => m.followUp)).toEqual([{ scheduleId: 'sch_1', action: 'retire_lost', why: 'charter_todo_done', followUp: true }]);
      // Never an unguarded overwrite of the row.
      expect(mockUpdate.mock.calls.map((c) => c[0]).filter((u: any) => u?.data?.lastStatus === 'paused:charter_done')).toHaveLength(0);
    });
  });
});

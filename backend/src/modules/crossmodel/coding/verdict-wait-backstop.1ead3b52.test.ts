/**
 * REPLAY TEST — ticket 1ead3b52 (mishap, 2026-09-18): "Verdict-waiting worker
 * lanes invent high-frequency self-audit cadences and stack duplicate
 * backstop schedules (token churn)".
 *
 * The prod observation (lane 65540eb5 awaiting a reviewer verdict):
 *   (a) TWO enabled once-schedules ~1 min apart for the SAME verdict-wait
 *       backstop job, and
 *   (b) a full self-audit re-verification turn every ~4 minutes, re-probing
 *       already-green criteria — while the result hook would wake the lane
 *       directly anyway.
 *
 * The fix has two halves, both pinned here:
 *   A. PROMPT GUIDANCE — the dispatch brief (the one text every dispatched
 *      run reads) now carries VERDICT_WAIT_POSTURE: peer signal = wake path,
 *      schedules/continuations = backstops, ONE backstop max per wait,
 *      ≥20-min cadence, cheap one-line no-op turns, re-probe only on STALE.
 *   B. HARNESS GUARD — createSchedule refuses to STACK a machine-authored
 *      duplicate: an arm whose normalized prompt exactly matches an
 *      already-enabled, still-live schedule of the same kind returns the
 *      EXISTING row (deduped:true) instead of creating a copy.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Prisma (union of the schedule.service + ticket-dispatch.service shapes) ──
const mockSchedCreate = jest.fn();
const mockSchedCount = jest.fn();
const mockSchedFindMany = jest.fn();
const mockUfrFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockUfrUpdateMany = jest.fn(async (..._a: any[]): Promise<any> => ({ count: 1 }));
const mockUfrUpdate = jest.fn(async (..._a: any[]): Promise<any> => ({}));
const mockChatFindUnique = jest.fn();
const mockChatUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockMsgCreate = jest.fn(async (..._a: any[]) => ({}));
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockRunFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockCodingStateFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockPromptHistoryCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'ph-1' }));
const mockPromptHistoryCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);

// $transaction seam (ticket ae20da66): createSchedule wraps the create + the
// same-cadence collapse in ONE interactive transaction. The tx reuses this
// file's mock fns; the collapse's in-tx stale read gets its OWN mock defaulting
// to [] so pre-collapse tests behave exactly as before.
const mockUpdateMany = jest.fn(async (..._a: any[]) => ({ count: 0 }));
const mockStaleFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockTransaction = jest.fn(async (fn: any) =>
  typeof fn === 'function'
    ? fn({
        chatSchedule: {
          create: (...a: any[]) => mockSchedCreate(...a),
          findMany: (...a: any[]) => mockStaleFindMany(...a),
          updateMany: (...a: any[]) => mockUpdateMany(...a),
        },
      })
    : Promise.all(fn));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: {
      create: (...a: any[]) => mockSchedCreate(...a),
      count: (...a: any[]) => mockSchedCount(...a),
      findMany: (...a: any[]) => mockSchedFindMany(...a),
    },
    $transaction: (fn: any) => mockTransaction(fn),
    agentRun: {
      findFirst: (...a: any[]) => mockRunFindFirst(...a),
      create: (...a: any[]) => mockRunCreate(...a),
      count: (...a: any[]) => mockRunCount(...a),
      findMany: (...a: any[]) => mockRunFindMany(...a),
    },
    schedulePromptHistory: {
      create: (...a: any[]) => mockPromptHistoryCreate(...a),
      count: (...a: any[]) => mockPromptHistoryCount(...a),
      findFirst: (...a: any[]) => mockPromptHistoryFindFirst(...a),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), update: (...a: any[]) => mockChatUpdate(...a) },
    crossModelMessage: { create: (...a: any[]) => mockMsgCreate(...a) },
    chatCodingState: { findMany: (...a: any[]) => mockCodingStateFindMany(...a) },
    userFeatureRequest: {
      findMany: (...a: any[]) => mockUfrFindMany(...a),
      updateMany: (...a: any[]) => mockUfrUpdateMany(...a),
      update: (...a: any[]) => mockUfrUpdate(...a),
    },
  },
}));

// ── Redis ────────────────────────────────────────────────────────────────────
const mockSet = jest.fn(async (..._a: any[]): Promise<any> => 'OK');
const mockDel = jest.fn(async (..._a: any[]): Promise<any> => 1);
const mockGet = jest.fn();
const mockGetDel = jest.fn();
const mockPTtl = jest.fn();
const mockIncr = jest.fn();
const mockIncrBy = jest.fn();
const mockExpire = jest.fn(async (..._a: any[]): Promise<any> => 1);
const mockDecr = jest.fn(async (..._a: any[]): Promise<any> => 0);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: (...a: any[]) => mockSet(...a), del: (...a: any[]) => mockDel(...a),
    get: (...a: any[]) => mockGet(...a), getDel: (...a: any[]) => mockGetDel(...a),
    pTTL: (...a: any[]) => mockPTtl(...a),
    incr: (...a: any[]) => mockIncr(...a), incrBy: (...a: any[]) => mockIncrBy(...a),
    expire: (...a: any[]) => mockExpire(...a), decr: (...a: any[]) => mockDecr(...a),
  },
}));

// ── Module-boundary seams (same pattern as schedule.service.test.ts) ─────────
const mockGetChatAutonomy = jest.fn();
jest.mock('../platform/autonomy.service', () => ({
  __esModule: true,
  getChatAutonomy: (...a: any[]) => mockGetChatAutonomy(...a),
}));

const mockEmitHookEvent = jest.fn(async (..._a: any[]) => {});
const mockSweepHookEvents = jest.fn(async (..._a: any[]) => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  sweepHookEvents: (...a: any[]) => mockSweepHookEvents(...a),
}));

const mockStartScheduledRun = jest.fn(async (..._a: any[]) => ({ started: true }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
}));

const mockStartDetachedChatRun = jest.fn((..._a: any[]): string | null => 'chat:s1');
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatRunKey: (id: string) => `chat:${id}`,
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

const mockGetPlanStrict = jest.fn(async (..._a: any[]) => null as any);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: (...a: any[]) => mockGetPlanStrict(...a),
}));

// The dispatch lane-send seam (dynamic import inside ticket-dispatch.service).
const mockSendChatMessage: jest.Mock = jest.fn(async () => ({ queued: true, chatId: 'lane-1' }));
const mockStartCodingSession: jest.Mock = jest.fn(async () => ({ id: 'batch-sess-1' }));
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  sendChatMessage: (...a: any[]) => mockSendChatMessage(...a),
  startCodingSession: (...a: any[]) => mockStartCodingSession(...a),
}));

import { createSchedule, MIN_INTERVAL_SEC } from './schedule.service';
import { dispatchTicketToLane, drainOpenTicketsToLane, VERDICT_WAIT_POSTURE, SELF_AUDIT_PLACEMENT_RULE } from '../feedback/ticket-dispatch.service';

const ENV = { ...process.env };

/** An enabled, still-live schedule row as createSchedule's dedupe read sees it. */
const liveScheduleRow = (over: any = {}) => ({
  id: 'sch_existing', sessionId: 's1', userId: 'u1',
  prompt: 'wait for the reviewer verdict — do NOT re-audit',
  kind: 'once', intervalSec: 1200, nextRunAt: new Date(Date.now() + 1200_000),
  enabled: true, runsCount: 0, maxRuns: 1,
  expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  lastFiredAt: null, lastStatus: null, cancelledBy: null, disabledAt: null,
  promptSetBy: 'machine', busySkips: 0, createdAt: new Date(),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  // Dispatch gates open.
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = 'lane-1';
  delete process.env.TICKET_DISPATCH_DAILY_CAP;
  // Prisma defaults.
  mockChatFindUnique.mockResolvedValue({ userId: 'owner-1' });
  mockUfrFindMany.mockResolvedValue([]);
  mockSchedCount.mockResolvedValue(0);
  mockSchedFindMany.mockResolvedValue([]);
  mockSchedCreate.mockImplementation(({ data }: any) => Promise.resolve({
    id: 'sch_new', ...data, lastFiredAt: null, lastStatus: null, runsCount: 0,
  }));
  // Redis defaults: claim succeeds, under daily cap, no live fires window.
  mockSet.mockResolvedValue('OK');
  mockIncr.mockResolvedValue(1);
  mockGet.mockResolvedValue(null);
  mockGetDel.mockResolvedValue(null);
  mockPTtl.mockResolvedValue(-2);
  mockIncrBy.mockResolvedValue(1);
  mockGetChatAutonomy.mockResolvedValue(null);
  mockSendChatMessage.mockResolvedValue({ queued: true, chatId: 'lane-1' });
});

afterAll(() => {
  process.env = ENV;
});

// ── A. Prompt guidance: the posture rides every dispatch brief ───────────────
describe('ticket 1ead3b52 replay (A) — verdict-wait posture in the dispatch brief', () => {
  const TICKET = {
    id: 't-1', type: 'bug_report', title: 'Attach button dead',
    description: 'The paperclip swallows clicks.', priority: 3, source: 'user',
  };

  it('pins the exported posture text (the rules the mishap lane lacked)', () => {
    expect(VERDICT_WAIT_POSTURE).toContain('VERDICT-WAIT POSTURE (ticket 1ead3b52)');
    expect(VERDICT_WAIT_POSTURE).toContain('BLOCKED');                       // wait step → cheap continuation no-op
    expect(VERDICT_WAIT_POSTURE).toContain('AT MOST ONE backstop');          // backstop cardinality
    expect(VERDICT_WAIT_POSTURE).toContain('20 min');                        // cadence floor
    expect(VERDICT_WAIT_POSTURE).toContain('if nothing changed, reply one line'); // cheap turn, not a full re-audit
    expect(VERDICT_WAIT_POSTURE).toContain('STALE');                         // re-probe only when stale
  });

  // tt-rd audit 2026-09-27 (self-audit-churn-7): review placement + "the
  // harness audits once" ride the same brief.
  it('pins the self-audit placement rule (never a separate scheduled self-audit chat, never under a product project, no audit step / audit-goal schedule)', () => {
    expect(SELF_AUDIT_PLACEMENT_RULE).toContain('never a separate scheduled "self-audit" chat');
    expect(SELF_AUDIT_PLACEMENT_RULE).toContain('never filed under a product project');
    expect(SELF_AUDIT_PLACEMENT_RULE).toContain('The harness runs ONE self-audit at the finish of every run');
  });

  it('single-ticket brief carries the posture (dispatchTicketToLane)', async () => {
    expect(await dispatchTicketToLane(TICKET)).toBe('sent');
    const brief = mockSendChatMessage.mock.calls[0][0].content;
    expect(brief).toContain('VERDICT-WAIT POSTURE (ticket 1ead3b52)');
    expect(brief).toContain('arm AT MOST ONE backstop schedule per wait');
    expect(brief).toContain(SELF_AUDIT_PLACEMENT_RULE.trim());
    // The claim bar still rides after it (ordering sanity).
    expect(brief).toContain('CLAIM BAR (the journal-backed evidence guard watches this run');
  });

  it('batch brief carries the posture too (drainOpenTicketsToLane — the churn lane\'s surface)', async () => {
    // Brief-content test on the legacy batch path: owner-only autonomy (audit 2026-10-08 F3) is pinned in
    // feedback/ticket-dispatch.fresh-lanes.test.ts — these fixtures carry no ticket owner.
    process.env.TICKET_DISPATCH_ANY_USER = '1';
    mockUfrFindMany.mockResolvedValue([
      { ...TICKET, id: 'a1', source: 'agent', context: {} },
      { ...TICKET, id: 'a2', context: {} },
    ]);
    expect(await drainOpenTicketsToLane()).toEqual({ result: 'sent', batched: 2 });
    const brief = mockSendChatMessage.mock.calls[0][0].content;
    expect(brief).toContain('[TICKET BATCH DISPATCH — 2 open feedback tickets');
    expect(brief).toContain('VERDICT-WAIT POSTURE (ticket 1ead3b52)');
  });
});

// ── B. Harness guard: createSchedule never stacks an identical machine arm ───
describe('ticket 1ead3b52 replay (B) — duplicate-backstop guard in createSchedule', () => {
  const baseArm = {
    sessionId: 's1', userId: 'u1',
    prompt: 'wait for the reviewer verdict — do NOT re-audit',
    kind: 'once' as const, intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine',
  };

  it('REPLAYS THE MISHAP: a second identical machine one-shot is deduped — no stacked copy', async () => {
    mockSchedFindMany.mockResolvedValue([liveScheduleRow()]);
    const r = await createSchedule(baseArm);
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(true);
    expect(r.schedule?.id).toBe('sch_existing'); // the EXISTING backstop, not a new one
    expect(mockSchedCreate).not.toHaveBeenCalled();
    expect(mockSchedFindMany).toHaveBeenCalledWith({
      where: { sessionId: 's1', kind: 'once', enabled: true },
    });
  });

  it('normalization: a whitespace/case rewrite of the same job still dedupes', async () => {
    mockSchedFindMany.mockResolvedValue([liveScheduleRow()]);
    const r = await createSchedule({
      ...baseArm,
      prompt: '  WAIT for the reviewer\nverdict   — do NOT re-audit  ',
    });
    expect(r.deduped).toBe(true);
    expect(mockSchedCreate).not.toHaveBeenCalled();
  });

  it('a FIRED one-shot (runsCount == maxRuns) does NOT swallow the next-link re-arm', async () => {
    // The just-fired row stays enabled until the next sweeper tick disables
    // it — it is TERMINAL, so the lane's chain re-arm must create a fresh row.
    mockSchedFindMany.mockResolvedValue([liveScheduleRow({ runsCount: 1, maxRuns: 1 })]);
    const r = await createSchedule(baseArm);
    expect(r.ok).toBe(true);
    expect(r.deduped).toBeUndefined();
    expect(mockSchedCreate).toHaveBeenCalledTimes(1);
    expect(r.schedule?.id).toBe('sch_new');
  });

  it('a DIFFERENT prompt creates a fresh schedule (no false dedupe)', async () => {
    mockSchedFindMany.mockResolvedValue([liveScheduleRow()]);
    const r = await createSchedule({ ...baseArm, prompt: 'a totally different backstop job' });
    expect(r.ok).toBe(true);
    expect(r.deduped).toBeUndefined();
    expect(mockSchedCreate).toHaveBeenCalledTimes(1);
  });

  it('owner-authored arms (promptSetBy user) are NEVER deduped — explicit instruction', async () => {
    mockSchedFindMany.mockResolvedValue([liveScheduleRow()]);
    const r = await createSchedule({ ...baseArm, promptSetBy: 'user' });
    expect(r.ok).toBe(true);
    expect(r.deduped).toBeUndefined();
    expect(mockSchedCreate).toHaveBeenCalledTimes(1);
    // The guard short-circuits before its dedupe read for non-machine arms.
    expect(mockSchedFindMany).not.toHaveBeenCalled();
  });

  it('recurring machine monitors dedupe too (identical enabled live row)', async () => {
    mockSchedFindMany.mockResolvedValue([
      liveScheduleRow({ kind: 'recurring', runsCount: 3, maxRuns: 500, intervalSec: 3600 }),
    ]);
    const r = await createSchedule({ ...baseArm, kind: 'recurring', intervalSec: 3600 });
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(true);
    expect(r.schedule?.id).toBe('sch_existing');
    expect(mockSchedCreate).not.toHaveBeenCalled();
  });

  it('dedupe is kind-scoped: an enabled RECURRING row does not absorb a new ONCE arm', async () => {
    mockSchedFindMany.mockResolvedValue([]); // the read is kind-filtered at the DB
    const r = await createSchedule(baseArm);
    expect(r.ok).toBe(true);
    expect(r.deduped).toBeUndefined();
    expect(mockSchedCreate).toHaveBeenCalledTimes(1);
  });
});

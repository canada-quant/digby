/**
 * Fleet supervisor (slice B) — hooks.service unit tests with mocked Prisma,
 * Redis, and delivery path (fireScheduleTarget). Pins: emission (subscription
 * matching, self-loop suppression, depth cap, payload shape + truncation),
 * depth propagation (Redis stamp on delivery → read on emission), the
 * subscribe/unsubscribe/list validation, and the sweep state machine
 * (deliver / debounce-coalesce / busy-retry / attempts-cap / stale reclaim /
 * ownership-recheck delete). Colocated mock-everything pattern copied from
 * autonomy.service.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Instant delivery (owner 2026-09-14) kicks a detached targeted sweep from
// emitHookEvent; since the 2026-11-02 RSW-1 deletion that kick is
// UNCONDITIONAL, so the pins here that assert exact emit-time mock shapes pin
// the outbox row rather than the sweep's own reads.

const mockPrisma: any = {
  eventHook: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(async () => ({})),
    delete: jest.fn(async () => ({})),
  },
  hookEvent: {
    create: jest.fn(async () => ({})),
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 1 })),
    // Review 2026-09-13 issue 1: the window drain counts the remainder ONLY
    // when its per-delivery cap binds (WINDOW_DRAIN_CAP rows fetched).
    count: jest.fn(async () => 0),
  },
  // Delivery-time todo_wake revalidation (feedback 7d7268fb) reads the todo row.
  projectTodo: { findUnique: jest.fn() },
  // subscribeHook's PROJECT-scope lane (per-project supervisors, 2026-09-13)
  // validates the project exists + is owned by the hook's user.
  crossModelProject: { findUnique: jest.fn() },
  crossModelChat: { findUnique: jest.fn(), update: jest.fn(async () => ({})) },
  crossModelMessage: { create: jest.fn(async () => ({})) },
  activity: { create: jest.fn(async () => ({})) },
  // The atomic claim (UPDATE…RETURNING) — deliverHookGroup rides this raw query.
  $queryRaw: jest.fn(),
  // SAA-1.1 Phase 1 (2026-11-03): the admission policy asks whether the run that
  // emitted this run_completed actually DID anything, by reading its tool
  // receipts. Default = no receipts ⇒ the run is provably quiet ⇒ ignore stays
  // available (the pre-existing pins below depend on that). A mutated run is
  // simulated per-test by returning a mutating tool name here.
  runToolReceipt: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedisGet: jest.Mock = jest.fn(async () => null);
const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: (...a: any[]) => mockRedisGet(...a),
    set: (...a: any[]) => mockRedisSet(...a),
    del: (...a: any[]) => mockRedisDel(...a),
  },
}));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time — mock AppError (same shape).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// crossmodel.service's real module pulls the model integrations + DB/env chains;
// hooks.service only needs getChatAccess — mock the boundary.
const mockGetChatAccess = jest.fn();
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: (...a: any[]) => mockGetChatAccess(...a) },
}));

// The delivery path (schedule.service's machine-run fire) — the seam under test.
// Hook wakes also consume the shared daily machine-run budget (dailyCapExceeded
// et al) — default: under the cap, refunds/notices are recorded no-ops.
const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
const mockDailyCapExceeded: jest.Mock = jest.fn(async () => null);
const mockRefundDailyCapToken: jest.Mock = jest.fn(async () => {});
const mockNotifyDailyCapOnce: jest.Mock = jest.fn(async () => {});
// Per-window cap-event dedupe gate (feedback a30b6ad9) — default: the window's
// first skip claims it (emit); tests for the dedupe override per-case.
const mockClaimCapWindowGate: jest.Mock = jest.fn(async () => true);
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: (...a: any[]) => mockDailyCapExceeded(...a),
  refundDailyCapToken: (...a: any[]) => mockRefundDailyCapToken(...a),
  notifyDailyCapOnce: (...a: any[]) => mockNotifyDailyCapOnce(...a),
  claimCapWindowGate: (...a: any[]) => mockClaimCapWindowGate(...a),
}));

// Loop-metrics wake telemetry (audit #12 close-out) — the wiring under test in
// the dedicated describe below; mocked so no real buffer/DB path loads.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked',
    GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss',
    HOOK_STALE_SUPPRESSED: 'hook_stale_suppressed', // Review 2026-09-13 issue 1
    HOOK_QUIET_EVENT_SHED: 'hook_quiet_event_shed', // Project-supervisor preflight 2026-09-14
    HOOK_SIBLING_DRAIN: 'hook_sibling_drain', // hardening loop 2026-09-24
    HOOK_SOURCE_POLICY_OBSERVE: 'hook_source_policy_observe', // SAA-1.1 Phase 1
  },
}));

// Decision gate (wake_triage) must be OFF in unit tests (same mock as
// imessage/nlp.test.ts). Without it, any environment holding DEEPSEEK_API_KEY
// runs REAL shadow-mode DeepSeek calls inside every delivery test: they record
// their own decision metrics, which polluted the wake_delivered count
// assertions (expected 1, received 3 — verified live 2026-09-24; CI is
// env-less so it never saw it) and made the suite spend ~4s of API timeout
// per delivery. Gate BEHAVIOR is pinned in its own suites
// (browser-agent/router.decision-gate.test.ts, imessage/nlp.decision-gate.test.ts);
// rows that pre-carry triagedAt bypass the gate either way.
// WI-C (2026-09-25): the mode/answer are per-test controllable so the outcome-
// label describe can exercise SHADOW delivery; every other describe keeps 'off'.
// LANE-IDLE-WAKE (2026-10-20): the delivery revalidation of a lane_idle wake row is mocked (its own suite covers the reads).
const mockRevalidateLaneIdle: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => ({ action: 'deliver' }));
jest.mock('../coding/lane-idle', () => ({
  __esModule: true,
  ...(jest.requireActual('../coding/lane-idle')),
  revalidateLaneIdleWake: (...a: any[]) => mockRevalidateLaneIdle(...a),
}));

const mockDecisionMode = jest.fn((): 'off' | 'shadow' | 'act' => 'off');
const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRecordDecisionOutcome: jest.Mock = jest.fn();
jest.mock('./decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: () => mockDecisionMode(),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  // E7: per-option threshold (wake-triage-request.ts shadow readout) — fallback only here.
  decisionOptionThreshold: (_p: string, _o: string, fallback: number) => fallback,
  recordDecisionOutcome: (...a: any[]) => mockRecordDecisionOutcome(...a),
  confidenceOf: () => 0,
  // Real-shaped stand-ins (the real helpers are pinned in decision-gate.test.ts).
  stashDecision: (d: any, purpose: string, opts?: any) => (d ? { id: d.id, purpose, mode: d.mode, backend: d.backend, answers: d.answers, decidedAt: 'stashed', ...(opts?.extra ? { extra: opts.extra } : {}) } : null),
  reconstructDecision: (s: any) => (s && s.id ? { id: s.id, purpose: s.purpose, mode: s.mode, backend: s.backend, answers: s.answers, ms: 0 } : null),
}));

import {
  HOOK_EVENT_TYPES, MAX_HOOK_DEPTH, MAX_DELIVERY_ATTEMPTS, MAX_DEBOUNCE_SEC, DEFAULT_PROMPT_TEMPLATE,
  ALARM_EVENT_TYPES, PARKED_ALARM_CAP, isAlarmEvent, TODO_WAKE_EVENT_TYPE,
  SWEEP_PER_HOOK_CAP, RETRY_HORIZON_MS, BUSY_PARK_MS, selectFairBatch,
  WINDOW_DRAIN_CAP, DIGEST_MAX_LINES, DIGEST_COMPACT_THRESHOLD, DIGEST_LINE_CHARS, coalesce,
  FLEET_FEED_SHED_EVENT_TYPES, CHILD_RESULT_PROMPT_TEMPLATE, LEGACY_CHILD_RESULT_PROMPT_TEMPLATE,
  isChildResultTemplate, isChildResultHookSignature, CHILD_RESULT_EVENT_TYPES,
  enqueueDirectWake, requeuePreemptedHookEvents, PREEMPT_REDELIVERY_LOOKBACK_MS,
  emitHookEvent, emitHookEventSafe, sweepHookEvents, depthForChat, clearHookDepth, stampHookDepth,
  subscribeHook, updateHook, unsubscribeHook, listHooks, renderPrompt, resolveHookIdForUser,
  drainHookEventsForTarget,
  oldestPendingHookAgeMs,
  HOOK_STARVATION_MS,
  WAKE_TRIAGE_DEFER_MS, WAKE_TRIAGE_DEFER_MAX_MIN, STALE_QUIET_EVENT_MS,
  hookBacklogStarving, unparkHookEventsForTarget, HOOK_STARVATION_YIELD_MAX_MS, hooksFirstVerdict, drainHookEventsForTargetNow,
  resetParkSeenForTests,
  lookupWakeSourceLanes,
  hookRowNotYetDue,
  fleetRollupEventKey,
  sourceRunMutated,
} from './hooks.service';
import { setWakeTriageControlSampler } from './wake-triage-request';
import logger from '../../../utils/logger';

const hookRow = (over: any = {}) => ({
  id: 'h1', userId: 'u1', sourceChatId: 'c-src', targetChatId: 'c-tgt',
  eventTypes: ['run_completed'], promptTemplate: '', enabled: true,
  debounceSec: 60, lastFiredAt: null,
  createdAt: new Date('2026-08-01T00:00:00Z'), updatedAt: new Date('2026-08-01T00:00:00Z'),
  ...over,
});

/**
 * Route hookEvent.findMany by where-shape (P3, v1#1): the sweep now runs a
 * retry-horizon pass (where.createdAt.lt) BEFORE the pending scan — a blanket
 * mockResolvedValue would feed the fixture rows to the horizon pass too and
 * dead-letter them before delivery. The horizon pass sees nothing unless a
 * test opts in via `horizonRows`.
 */
const setPendingRows = (rows: any[], horizonRows: any[] = [], backlogRows: any[] = [], siblingRows: any[] = []) => {
  mockPrisma.hookEvent.findMany.mockImplementation(async (args: any) =>
    (args?.where?.createdAt?.lt ? horizonRows
      // Review 2026-09-13 issue 1: the window drain reads THIS hook's other
      // deliverable pending rows (where.hookId) — empty unless a test opts in.
      : args?.where?.hookId ? backlogRows
      // Sibling drain (2026-09-24): pending rows of OTHER hooks on the same
      // target (relation filter where.hook.targetChatId) — empty unless opted in.
      : args?.where?.hook?.targetChatId ? siblingRows
      : rows));
};

const eventRow = (over: any = {}) => ({
  id: 'e1', hookId: 'h1', userId: 'u1', eventType: 'run_completed',
  payload: {
    eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat',
    summary: 'Run finished fine', depth: 0,
  },
  status: 'pending', attempts: 0,
  // Fresh by default (ticket 2b1609b2): the delivery-time stale-event guard
  // consumes QUIET rows older than STALE_QUIET_EVENT_MS with no wake — an
  // ancient fixed timestamp would silently suppress every delivery test.
  // Staleness tests pass an explicit old createdAt via `over`.
  createdAt: new Date(), updatedAt: new Date('2026-08-01T00:00:00Z'),
  ...over,
});

/** hookEvent.updateMany calls whose data matches pred (reclaim/claim/delivered/retry/failed). */
const updatesWith = (pred: (data: any) => boolean) =>
  mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).filter((u: any) => pred(u.data));

beforeEach(() => {
  jest.clearAllMocks();
  resetParkSeenForTests(); // wake_parked dedupe is process-local (rollout watch 2026-09-14)
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockFireScheduleTarget.mockResolvedValue({ started: true });
  mockDailyCapExceeded.mockResolvedValue(null); // under the shared daily budget
  mockClaimCapWindowGate.mockResolvedValue(true); // the window's first cap skip emits (a30b6ad9 dedupe default)
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  // Pair dedup (ticket c65de47c): subscribeHook looks the (source,target)
  // pair up before creating — default "not wired". Describes that exercise
  // the update path (updateHook et al) override this; setting it HERE keeps
  // their mockResolvedValue from leaking into later subscribe describes
  // (clearAllMocks clears calls, NOT implementations).
  mockPrisma.eventHook.findFirst.mockResolvedValue(null);
  mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.hookEvent.count.mockResolvedValue(0); // window drain: no remainder beyond the cap by default
  // todo_wake revalidation default: the todo is still actionable for the
  // target chat — stale-wake tests override per case (feedback 7d7268fb).
  mockPrisma.projectTodo.findUnique.mockResolvedValue({ status: 'pending', assigneeChatId: 'c-tgt' });
  // Default claim: this sweeper wins every row the sweep read. Partial-claim
  // race tests override with mockResolvedValue on $queryRaw.
  mockPrisma.$queryRaw.mockImplementation(() => mockPrisma.hookEvent.findMany());
  mockPrisma.eventHook.create.mockImplementation(({ data }: any) => Promise.resolve({
    id: 'h-new', enabled: true, debounceSec: 60, lastFiredAt: null, createdAt: new Date('2026-08-01T00:00:00Z'), ...data,
  }));
  // One findUnique serves three shapes: emission's source lookup (select
  // title+userId), the sweep's ownership re-check (select userId), and the
  // legacy title-only lookup.
  mockPrisma.crossModelChat.findUnique.mockImplementation(({ select }: any) =>
    Promise.resolve(
      select?.title && select?.userId ? { title: 'Source Chat', userId: 'u1' }
        : select?.userId ? { userId: 'u1' }
        : { title: 'Source Chat' },
    ));
});

/* ====================================================================
 * Emission
 * ==================================================================== */
describe('emitHookEvent', () => {
  it('inserts one pending HookEvent per enabled hook subscribed to the event type', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow(), hookRow({ id: 'h2', targetChatId: 'c-tgt2' })]);
    await emitHookEvent('c-src', 'run_completed', 'All good', { runId: 'r1' });

    // Subscription matching is DB-side: the specific source chat OR any
    // wildcard hook, enabled, eventTypes has.
    expect(mockPrisma.eventHook.findMany).toHaveBeenCalledWith({
      where: {
        enabled: true,
        eventTypes: { has: 'run_completed' },
        OR: [{ sourceChatId: 'c-src' }, { sourceChatId: null }],
      },
    });
    const creates = mockPrisma.hookEvent.create.mock.calls.map((c: any[]) => c[0].data);
    expect(creates).toHaveLength(2);
    expect(creates[0]).toMatchObject({ hookId: 'h1', userId: 'u1', eventType: 'run_completed' });
    expect(creates[1]).toMatchObject({ hookId: 'h2' });
    expect(creates[0].payload).toEqual({
      eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat',
      summary: 'All good', depth: 0, runId: 'r1',
    });
    // Source chat (title + owner + scalar projectId + project supervision, for
    // the wildcard same-owner + project-scope + supervision filters) looked up
    // ONCE for the whole emission.
    expect(mockPrisma.crossModelChat.findUnique).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelChat.findUnique).toHaveBeenCalledWith({
      where: { id: 'c-src' },
      // Project-supervisor preflight 2026-09-14: the fleet-feed shed reads project.projectSupervisorEnabled too.
      // Hardening 2026-09-14: + isProjectSupervisor — the shed covers the project supervisor's OWN quiet completions.
      // audit 2026-10-06 T3-2: + isSupervisor / codingState (the plain-chat fleet shed).
      select: { title: true, userId: true, projectId: true, isProjectSupervisor: true, isSupervisor: true, codingState: { select: { id: true } }, project: { select: { supervised: true, projectSupervisorEnabled: true } } },
    });
  });

  it('wildcard hooks (sourceChatId NULL) receive SAME-OWNER emissions only', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hookRow({ id: 'h-wild-same', sourceChatId: null, userId: 'u1', targetChatId: 'c-sup' }),
      hookRow({ id: 'h-wild-foreign', sourceChatId: null, userId: 'someone-else', targetChatId: 'c-other' }),
    ]);
    await emitHookEvent('c-src', 'run_completed', 'All good');

    const creates = mockPrisma.hookEvent.create.mock.calls.map((c: any[]) => c[0].data);
    expect(creates).toHaveLength(1);
    expect(creates[0].hookId).toBe('h-wild-same'); // the foreign owner's wildcard got NOTHING
  });

  it('a wildcard hook pointing AT the emitting chat is self-loop suppressed', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hookRow({ id: 'h-self', sourceChatId: null, userId: 'u1', targetChatId: 'c-src' }),
    ]);
    await emitHookEvent('c-src', 'run_completed', 'All good');
    expect(mockPrisma.hookEvent.create).not.toHaveBeenCalled();
  });

  it('passes emitter extra fields through into the payload (schedule_disabled contract, forensics fix 2)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow({ eventTypes: ['schedule_disabled'] })]);
    await emitHookEvent('c-src', 'schedule_disabled', 'Schedule sch1 disabled', {
      scheduleId: 'sch1', sessionId: 'c-src', kind: 'recurring', runsCount: 73, reason: 'cancelled',
    });
    const payload = mockPrisma.hookEvent.create.mock.calls[0][0].data.payload;
    expect(payload).toMatchObject({
      eventType: 'schedule_disabled', sourceChatId: 'c-src', summary: 'Schedule sch1 disabled',
      scheduleId: 'sch1', kind: 'recurring', runsCount: 73, reason: 'cancelled', depth: 0,
    });
    expect(payload).not.toHaveProperty('runId');
  });

  it('passthrough fields can never clobber the fixed payload fields', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow()]);
    await emitHookEvent('c-src', 'run_completed', 'real summary', {
      summary: 'spoofed', eventType: 'spoofed', sourceChatId: 'spoofed',
    } as any);
    const payload = mockPrisma.hookEvent.create.mock.calls[0][0].data.payload;
    expect(payload.summary).toBe('real summary');
    expect(payload.eventType).toBe('run_completed');
    expect(payload.sourceChatId).toBe('c-src');
  });

  it('omits runId from the payload when not provided', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow()]);
    await emitHookEvent('c-src', 'attention_needed', 'Needs a human');
    const payload = mockPrisma.hookEvent.create.mock.calls[0][0].data.payload;
    expect(payload).not.toHaveProperty('runId');
    expect(payload.eventType).toBe('attention_needed');
  });

  it('suppresses self-loops (target === source) even if such a hook exists', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow({ targetChatId: 'c-src' })]);
    await emitHookEvent('c-src', 'run_completed', 'loop');
    expect(mockPrisma.hookEvent.create).not.toHaveBeenCalled();
  });

  it('drops emissions at the depth cap (explicit depth >= 3): no hook lookup at all', async () => {
    await emitHookEvent('c-src', 'run_completed', 'too deep', { depth: MAX_HOOK_DEPTH });
    expect(mockPrisma.eventHook.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.hookEvent.create).not.toHaveBeenCalled();
  });

  it('truncates the summary to 2000 chars', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow()]);
    await emitHookEvent('c-src', 'run_failed', 'x'.repeat(5000));
    const payload = mockPrisma.hookEvent.create.mock.calls[0][0].data.payload;
    expect(payload.summary).toHaveLength(2000);
  });

  it('marks truncation explicitly and cuts at a word boundary (ticket 62799318)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow()]);
    // Word-heavy payload well over the cap — a mid-word slice must never ship.
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    await emitHookEvent('c-src', 'run_completed', words);
    const payload = mockPrisma.hookEvent.create.mock.calls[0][0].data.payload;
    expect(payload.summary.length).toBeLessThanOrEqual(2000);
    expect(payload.summary).toContain('…[truncated — read the source chat for the full text]');
    // The pre-marker text ends on a complete word, never a partial one.
    const preMarker = payload.summary.split('\n…[truncated')[0];
    expect(/word\d+$/.test(preMarker)).toBe(true);
  });

  it('leaves under-cap summaries untouched (no marker)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow()]);
    await emitHookEvent('c-src', 'run_completed', 'short and complete');
    const payload = mockPrisma.hookEvent.create.mock.calls[0][0].data.payload;
    expect(payload.summary).toBe('short and complete');
  });

  it('a no-match emission writes nothing', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([]);
    await emitHookEvent('c-src', 'todo_done', 'done');
    expect(mockPrisma.hookEvent.create).not.toHaveBeenCalled();
  });

  it('NEVER throws — a DB failure is a warn, not an exception', async () => {
    mockPrisma.eventHook.findMany.mockRejectedValue(new Error('db down'));
    await expect(emitHookEvent('c-src', 'run_completed', 's')).resolves.toBeUndefined();
    await expect(emitHookEventSafe('c-src', 'run_completed', 's')).resolves.toBeUndefined();
  });

  it('one bad insert does not block the remaining hooks', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow(), hookRow({ id: 'h2' })]);
    mockPrisma.hookEvent.create.mockRejectedValueOnce(new Error('constraint')).mockResolvedValueOnce({});
    await emitHookEvent('c-src', 'run_completed', 's');
    expect(mockPrisma.hookEvent.create).toHaveBeenCalledTimes(2);
  });
});

describe('emitHookEvent — project supervision opt-out (ticket c992d730)', () => {
  it('an UNSUPERVISED project emits NOTHING to wildcard hooks; DIRECT hooks still fire', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hookRow({ id: 'h-wild', sourceChatId: null, userId: 'u1', targetChatId: 'c-sup' }),
      hookRow({ id: 'h-direct', sourceChatId: 'c-src', userId: 'u1', targetChatId: 'c-tgt' }),
    ]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({
      title: 'Source Chat', userId: 'u1', project: { supervised: false },
    });
    await emitHookEvent('c-src', 'run_completed', 'All good');

    const creates = mockPrisma.hookEvent.create.mock.calls.map((c: any[]) => c[0].data);
    // The wildcard (automatic supervision) got nothing; the explicitly-wired
    // DIRECT hook is deliberate plumbing and still receives the emission.
    expect(creates).toHaveLength(1);
    expect(creates[0].hookId).toBe('h-direct');
  });

  it('a SUPERVISED project still emits to wildcard hooks (zero behavior change)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hookRow({ id: 'h-wild', sourceChatId: null, userId: 'u1', targetChatId: 'c-sup' }),
    ]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({
      title: 'Source Chat', userId: 'u1', project: { supervised: true },
    });
    await emitHookEvent('c-src', 'run_completed', 'All good');

    expect(mockPrisma.hookEvent.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.hookEvent.create.mock.calls[0][0].data.hookId).toBe('h-wild');
  });

  it('an UNGROUPED chat (no project row) is always supervised', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hookRow({ id: 'h-wild', sourceChatId: null, userId: 'u1', targetChatId: 'c-sup' }),
    ]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({
      title: 'Source Chat', userId: 'u1', project: null,
    });
    await emitHookEvent('c-src', 'run_completed', 'All good');

    expect(mockPrisma.hookEvent.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.hookEvent.create.mock.calls[0][0].data.hookId).toBe('h-wild');
  });
});

describe('emitHookEvent — depth read path', () => {
  it('reads the wake-depth stamp from Redis when extra.depth is undefined', async () => {
    mockRedisGet.mockResolvedValue('2');
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow()]);
    await emitHookEvent('c-src', 'run_completed', 's');
    expect(mockRedisGet).toHaveBeenCalledWith('fleet:hookdepth:c-src');
    expect(mockPrisma.hookEvent.create.mock.calls[0][0].data.payload.depth).toBe(2);
  });

  it('an explicit extra.depth wins over the stamp', async () => {
    mockRedisGet.mockResolvedValue('2');
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow()]);
    await emitHookEvent('c-src', 'run_completed', 's', { depth: 1 });
    expect(mockPrisma.hookEvent.create.mock.calls[0][0].data.payload.depth).toBe(1);
  });

  it('a stamped depth at the cap drops the emission', async () => {
    mockRedisGet.mockResolvedValue(String(MAX_HOOK_DEPTH));
    await emitHookEvent('c-src', 'run_completed', 's');
    expect(mockPrisma.eventHook.findMany).not.toHaveBeenCalled();
  });

  it('a Redis failure degrades to depth 0 (best-effort loop bound)', async () => {
    mockRedisGet.mockRejectedValue(new Error('redis down'));
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow()]);
    await emitHookEvent('c-src', 'run_completed', 's');
    expect(mockPrisma.hookEvent.create.mock.calls[0][0].data.payload.depth).toBe(0);
  });
});

describe('depth helpers', () => {
  it('depthForChat parses the stamp, defaulting garbage/absent to 0', async () => {
    mockRedisGet.mockResolvedValue('2');
    await expect(depthForChat('c1')).resolves.toBe(2);
    mockRedisGet.mockResolvedValue(null);
    await expect(depthForChat('c1')).resolves.toBe(0);
    mockRedisGet.mockResolvedValue('not-a-number');
    await expect(depthForChat('c1')).resolves.toBe(0);
    mockRedisGet.mockRejectedValue(new Error('down'));
    await expect(depthForChat('c1')).resolves.toBe(0);
  });

  it('clearHookDepth deletes the stamp and never throws', async () => {
    await clearHookDepth('c1');
    expect(mockRedisDel).toHaveBeenCalledWith('fleet:hookdepth:c1');
    mockRedisDel.mockRejectedValueOnce(new Error('down'));
    await expect(clearHookDepth('c1')).resolves.toBeUndefined();
  });

  it('stampHookDepth writes the stamp (1h TTL) when it RAISES the depth', async () => {
    mockRedisGet.mockResolvedValue(null); // no existing stamp
    await stampHookDepth('c1', 2);
    expect(mockRedisSet).toHaveBeenCalledWith('fleet:hookdepth:c1', '2', { EX: 3600 });
  });

  it('stampHookDepth is a monotonic MAX — never lowers an existing stamp', async () => {
    mockRedisGet.mockResolvedValue('3');
    await stampHookDepth('c1', 1);
    expect(mockRedisSet).not.toHaveBeenCalled();
    await stampHookDepth('c1', 3); // equal — still no write
    expect(mockRedisSet).not.toHaveBeenCalled();
    await stampHookDepth('c1', 5);
    expect(mockRedisSet).toHaveBeenCalledWith('fleet:hookdepth:c1', '5', { EX: 3600 });
  });

  it('stampHookDepth no-ops at depth <= 0 / garbage, and never throws on Redis failure', async () => {
    await stampHookDepth('c1', 0);
    await stampHookDepth('c1', -1);
    await stampHookDepth('c1', NaN);
    expect(mockRedisGet).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
    mockRedisGet.mockRejectedValue(new Error('down'));
    await expect(stampHookDepth('c1', 2)).resolves.toBeUndefined();
  });
});

/* ====================================================================
 * subscribe / unsubscribe / list
 * ==================================================================== */
describe('subscribeHook — validation', () => {
  const base = { userId: 'u1', sourceChatId: 'c-src', targetChatId: 'c-tgt', eventTypes: ['run_completed'] };

  it('creates the hook and returns the view', async () => {
    const r = await subscribeHook({ ...base, promptTemplate: 'tpl {{summary}}', debounceSec: 120 });
    const data = mockPrisma.eventHook.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: 'u1', sourceChatId: 'c-src', targetChatId: 'c-tgt',
      eventTypes: ['run_completed'], promptTemplate: 'tpl {{summary}}', debounceSec: 120,
    });
    expect(r).toMatchObject({ id: 'h-new', sourceChatId: 'c-src', targetChatId: 'c-tgt', debounceSec: 120, enabled: true });
  });

  it('requires write access to BOTH chats (source checked first)', async () => {
    mockGetChatAccess
      .mockResolvedValueOnce({ access: 'owner', exists: true })
      .mockResolvedValueOnce({ access: 'read', exists: true });
    await expect(subscribeHook(base)).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('target') });
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
  });

  it('a project MEMBER with write access MAY subscribe (mirrors schedule access)', async () => {
    mockGetChatAccess.mockResolvedValue({ access: 'write', exists: true });
    await expect(subscribeHook(base)).resolves.toMatchObject({ id: 'h-new' });
  });

  it('unknown chat → 404; non-member → 404 (existence is not leaked)', async () => {
    mockGetChatAccess.mockResolvedValue({ access: 'none', exists: false });
    await expect(subscribeHook(base)).rejects.toMatchObject({ statusCode: 404, message: 'Source chat not found' });
    mockGetChatAccess.mockResolvedValue({ access: 'none', exists: true });
    await expect(subscribeHook(base)).rejects.toMatchObject({ statusCode: 404, message: 'Source chat not found' });
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
  });

  it('rejects a self-subscription before any access check', async () => {
    await expect(subscribeHook({ ...base, targetChatId: 'c-src' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('itself') });
    expect(mockGetChatAccess).not.toHaveBeenCalled();
  });

  it('rejects event types outside HOOK_EVENT_TYPES', async () => {
    await expect(subscribeHook({ ...base, eventTypes: ['run_completed', 'chat_deleted'] }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('chat_deleted') });
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
  });

  it('rejects an empty eventTypes list', async () => {
    await expect(subscribeHook({ ...base, eventTypes: [] }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('non-empty') });
  });

  it('accepts every valid event type (deduped)', async () => {
    await subscribeHook({ ...base, eventTypes: [...HOOK_EVENT_TYPES, 'run_completed'] });
    expect(mockPrisma.eventHook.create.mock.calls[0][0].data.eventTypes).toEqual([...HOOK_EVENT_TYPES]);
  });

  it('clamps debounceSec into 0..3600 and rejects non-numbers', async () => {
    await subscribeHook({ ...base, debounceSec: -5 });
    expect(mockPrisma.eventHook.create.mock.calls[0][0].data.debounceSec).toBe(0);
    await subscribeHook({ ...base, debounceSec: 99999 });
    expect(mockPrisma.eventHook.create.mock.calls[1][0].data.debounceSec).toBe(MAX_DEBOUNCE_SEC);
    await expect(subscribeHook({ ...base, debounceSec: Number('lots') }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('debounceSec') });
  });

  it('omits debounceSec from the create when not provided (model default 60)', async () => {
    await subscribeHook(base);
    expect(mockPrisma.eventHook.create.mock.calls[0][0].data).not.toHaveProperty('debounceSec');
  });

  it('writes a hook.subscribe audit row (feedback be89b75d — wiring changes must never be silent)', async () => {
    await subscribeHook(base);
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1', action: 'hook.subscribe', resource: 'platform',
        metadata: expect.objectContaining({ hookId: 'h-new', sourceChatId: 'c-src', targetChatId: 'c-tgt' }),
      }),
    });
  });
});

describe('subscribeHook — wildcard (owner-scope)', () => {
  it('omitted sourceChatId creates a WILDCARD hook (sourceChatId null) and skips the source access check', async () => {
    const r = await subscribeHook({ userId: 'u1', targetChatId: 'c-tgt', eventTypes: ['run_completed'] });
    const data = mockPrisma.eventHook.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: 'u1', sourceChatId: null, targetChatId: 'c-tgt', eventTypes: ['run_completed'],
    });
    // Only the TARGET was access-checked — a wildcard has no single source;
    // the hook's userId scopes which chats emit into it.
    expect(mockGetChatAccess).toHaveBeenCalledTimes(1);
    expect(mockGetChatAccess).toHaveBeenCalledWith('c-tgt', 'u1');
    expect(r.sourceChatId).toBeNull();
  });

  it('null and empty-string sourceChatId are the same wildcard', async () => {
    await subscribeHook({ userId: 'u1', sourceChatId: null, targetChatId: 'c-tgt', eventTypes: ['run_completed'] });
    expect(mockPrisma.eventHook.create.mock.calls[0][0].data.sourceChatId).toBeNull();
    await subscribeHook({ userId: 'u1', sourceChatId: '', targetChatId: 'c-tgt', eventTypes: ['run_completed'] });
    expect(mockPrisma.eventHook.create.mock.calls[1][0].data.sourceChatId).toBeNull();
  });

  it('a wildcard still requires + access-checks the TARGET (foreign target → 403/404 as today)', async () => {
    await expect(subscribeHook({ userId: 'u1', targetChatId: '', eventTypes: ['run_completed'] }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('targetChatId') });

    mockGetChatAccess.mockResolvedValue({ access: 'read', exists: true });
    await expect(subscribeHook({ userId: 'u1', targetChatId: 'c-tgt', eventTypes: ['run_completed'] }))
      .rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('target') });

    mockGetChatAccess.mockResolvedValue({ access: 'none', exists: false });
    await expect(subscribeHook({ userId: 'u1', targetChatId: 'c-tgt', eventTypes: ['run_completed'] }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Target chat not found' });
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
  });

  it('a wildcard targeting its own would-be source is NOT a 400 (self-loop suppression is emission-time)', async () => {
    // With sourceChatId NULL there is no source to compare the target against;
    // when the target chat itself emits, emitHookEvent's self-loop suppression
    // (pinned above) skips the hook.
    await expect(subscribeHook({ userId: 'u1', targetChatId: 'c-sup', eventTypes: ['run_completed'] }))
      .resolves.toMatchObject({ id: 'h-new', sourceChatId: null, targetChatId: 'c-sup' });
  });

  it('an EXPLICIT sourceChatId behaves exactly as before (regression boundary)', async () => {
    // Both access checks run, source first; the self-subscribe 400 still applies.
    await subscribeHook({ userId: 'u1', sourceChatId: 'c-src', targetChatId: 'c-tgt', eventTypes: ['run_completed'] });
    expect(mockGetChatAccess).toHaveBeenNthCalledWith(1, 'c-src', 'u1');
    expect(mockGetChatAccess).toHaveBeenNthCalledWith(2, 'c-tgt', 'u1');
    expect(mockPrisma.eventHook.create.mock.calls[0][0].data.sourceChatId).toBe('c-src');

    await expect(subscribeHook({ userId: 'u1', sourceChatId: 'c-src', targetChatId: 'c-src', eventTypes: ['run_completed'] }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('itself') });
  });
});

describe('updateHook — in-place edits (ticket c4135a9f)', () => {
  beforeEach(() => {
    mockPrisma.eventHook.findFirst.mockResolvedValue(hookRow({ id: 'h1' }));
    // update echoes the merged row so toView renders the NEW values.
    mockPrisma.eventHook.update.mockImplementation(({ where, data }: any) =>
      Promise.resolve({ ...hookRow({ id: where.id }), ...data }));
  });

  it('updates provided fields in place and returns the refreshed view', async () => {
    const r = await updateHook({
      userId: 'u1', hookId: 'h1',
      eventTypes: ['run_failed', 'attention_needed'], promptTemplate: 'tpl {{summary}}', debounceSec: 30, enabled: false,
    });
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({
      where: { id: 'h1' },
      data: { eventTypes: ['run_failed', 'attention_needed'], promptTemplate: 'tpl {{summary}}', debounceSec: 30, enabled: false },
    });
    expect(r).toMatchObject({ id: 'h1', eventTypes: ['run_failed', 'attention_needed'], debounceSec: 30, enabled: false });
  });

  it('omitted fields keep their stored values (only provided keys reach the update)', async () => {
    await updateHook({ userId: 'u1', hookId: 'h1', debounceSec: 300 });
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({ where: { id: 'h1' }, data: { debounceSec: 300 } });
  });

  it('ownership is scoped in the lookup; a missing/foreign hook returns null without touching the row', async () => {
    mockPrisma.eventHook.findFirst.mockResolvedValue(null);
    await expect(updateHook({ userId: 'u1', hookId: 'h-x', enabled: false })).resolves.toBeNull();
    expect(mockPrisma.eventHook.findFirst).toHaveBeenCalledWith({ where: { id: 'h-x', userId: 'u1' } });
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
  });

  it('applies subscribe-grade eventTypes validation (invalid type / empty list → 400; dedupes)', async () => {
    await expect(updateHook({ userId: 'u1', hookId: 'h1', eventTypes: ['run_completed', 'chat_deleted'] }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('chat_deleted') });
    await expect(updateHook({ userId: 'u1', hookId: 'h1', eventTypes: [] }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('non-empty') });
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();

    await updateHook({ userId: 'u1', hookId: 'h1', eventTypes: [...HOOK_EVENT_TYPES, 'run_completed'] });
    expect(mockPrisma.eventHook.update.mock.calls[0][0].data.eventTypes).toEqual([...HOOK_EVENT_TYPES]);
  });

  it('clamps debounceSec into 0..3600 and rejects non-numbers (subscribe parity)', async () => {
    await updateHook({ userId: 'u1', hookId: 'h1', debounceSec: -5 });
    expect(mockPrisma.eventHook.update.mock.calls[0][0].data.debounceSec).toBe(0);
    await updateHook({ userId: 'u1', hookId: 'h1', debounceSec: 99999 });
    expect(mockPrisma.eventHook.update.mock.calls[1][0].data.debounceSec).toBe(MAX_DEBOUNCE_SEC);
    await expect(updateHook({ userId: 'u1', hookId: 'h1', debounceSec: Number('lots') }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('debounceSec') });
  });

  it('a call with NO updatable fields is a 400, not a silent no-op write', async () => {
    await expect(updateHook({ userId: 'u1', hookId: 'h1' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Nothing to update') });
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
  });

  it('writes a hook.update audit row with the applied changes (wiring changes must never be silent)', async () => {
    await updateHook({ userId: 'u1', hookId: 'h1', enabled: false });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1', action: 'hook.update', resource: 'platform',
        metadata: expect.objectContaining({ hookId: 'h1', changes: { enabled: false } }),
      }),
    });
  });
});

describe('hook id prefix resolution (nightly-lane truncated-id postmortem 2026-08-27)', () => {
  const FULL = '6bdedc2a-1111-4222-8333-abcdefabcdef';

  it('resolveHookIdForUser: empty input is null without querying', async () => {
    await expect(resolveHookIdForUser('u1', '')).resolves.toBe(null);
    expect(mockPrisma.eventHook.findFirst).not.toHaveBeenCalled();
  });

  it('unsubscribeHook resolves a unique ≥8-char prefix and deletes the full id', async () => {
    mockPrisma.eventHook.findFirst
      .mockResolvedValueOnce(null)                       // exact-id miss
      .mockResolvedValueOnce(hookRow({ id: FULL }));     // resolved-id row lookup
    mockPrisma.eventHook.findMany.mockResolvedValueOnce([{ id: FULL }]); // prefix search
    await expect(unsubscribeHook({ userId: 'u1', hookId: '6bdedc2a' })).resolves.toBe(true);
    expect(mockPrisma.eventHook.delete).toHaveBeenCalledWith({ where: { id: FULL } });
  });

  it('updateHook resolves a unique ≥8-char prefix and updates the full id', async () => {
    mockPrisma.eventHook.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(hookRow({ id: FULL }));
    mockPrisma.eventHook.findMany.mockResolvedValueOnce([{ id: FULL }]);
    mockPrisma.eventHook.update.mockResolvedValueOnce(hookRow({ id: FULL, enabled: false }));
    const v = await updateHook({ userId: 'u1', hookId: '6bdedc2a', enabled: false });
    expect(v?.id).toBe(FULL);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({ where: { id: FULL }, data: { enabled: false } });
  });

  it('an ambiguous prefix rejects 400 naming the candidate full ids — never guesses', async () => {
    const A = '6bdedc2a-aaaa-4222-8333-abcdefabcdef';
    const B = '6bdedc2a-bbbb-4222-8333-abcdefabcdef';
    mockPrisma.eventHook.findFirst.mockResolvedValueOnce(null);
    mockPrisma.eventHook.findMany.mockResolvedValueOnce([{ id: A }, { id: B }]);
    const err: any = await unsubscribeHook({ userId: 'u1', hookId: '6bdedc2a' }).catch((e: any) => e);
    expect(err?.statusCode).toBe(400);
    expect(err?.message).toContain('Ambiguous hook id prefix');
    expect(err?.message).toContain(A);
    expect(err?.message).toContain(B);
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
  });

  it('a prefix shorter than 8 chars stays exact-only (no prefix search)', async () => {
    mockPrisma.eventHook.findFirst.mockResolvedValueOnce(null);
    await expect(unsubscribeHook({ userId: 'u1', hookId: '6bdedc2' })).resolves.toBe(false); // 7 chars
    expect(mockPrisma.eventHook.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
  });

  it('an exact id hit short-circuits — no prefix search is issued', async () => {
    mockPrisma.eventHook.findFirst
      .mockResolvedValueOnce(hookRow({ id: FULL }))      // exact hit
      .mockResolvedValueOnce(hookRow({ id: FULL }));     // row lookup
    await expect(unsubscribeHook({ userId: 'u1', hookId: FULL })).resolves.toBe(true);
    expect(mockPrisma.eventHook.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.delete).toHaveBeenCalledWith({ where: { id: FULL } });
  });
});

describe('unsubscribeHook / listHooks', () => {
  it('unsubscribe deletes the hook owned by the user (false when not found)', async () => {
    mockPrisma.eventHook.findFirst.mockResolvedValue(null);
    await expect(unsubscribeHook({ userId: 'u1', hookId: 'h-x' })).resolves.toBe(false);
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();

    mockPrisma.eventHook.findFirst.mockResolvedValue(hookRow({ id: 'h-x' }));
    await expect(unsubscribeHook({ userId: 'u1', hookId: 'h-x' })).resolves.toBe(true);
    // Ownership scoping happens in the findFirst where clause.
    expect(mockPrisma.eventHook.findFirst).toHaveBeenCalledWith({ where: { id: 'h-x', userId: 'u1' } });
    expect(mockPrisma.eventHook.delete).toHaveBeenCalledWith({ where: { id: 'h-x' } });
    // …and the explicit unsubscribe leaves an audit trail (feedback be89b75d).
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1', action: 'hook.unsubscribe', resource: 'platform',
        metadata: expect.objectContaining({ hookId: 'h-x' }),
      }),
    });
  });

  it('listHooks scopes to the user and maps rows to views (ISO dates)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hookRow({ id: 'h1', lastFiredAt: new Date('2026-08-02T03:04:05Z') }),
      hookRow({ id: 'h2', targetChatId: 'c-tgt3' }),
    ]);
    const views = await listHooks({ userId: 'u1' });
    expect(mockPrisma.eventHook.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' }, orderBy: { createdAt: 'desc' }, take: 100,
    });
    expect(views).toHaveLength(2);
    expect(views[0].lastFiredAt).toBe('2026-08-02T03:04:05.000Z');
    expect(views[1].lastFiredAt).toBeNull();
    expect(views[0]).toMatchObject({ id: 'h1', eventTypes: ['run_completed'], debounceSec: 60, enabled: true });
  });

  it('listHooks narrows by sourceChatId / targetChatId when given', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([]);
    await listHooks({ userId: 'u1', sourceChatId: 'c-src' });
    expect(mockPrisma.eventHook.findMany.mock.calls[0][0].where).toEqual({ userId: 'u1', sourceChatId: 'c-src' });
    await listHooks({ userId: 'u1', targetChatId: 'c-tgt' });
    expect(mockPrisma.eventHook.findMany.mock.calls[1][0].where).toEqual({ userId: 'u1', targetChatId: 'c-tgt' });
  });
});

/* ====================================================================
 * Sweep (delivery)
 * ==================================================================== */
describe('sweepHookEvents — delivery', () => {
  it('delivers a pending group: rendered prompt, delivered rows, lastFiredAt, depth stamp', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());

    await sweepHookEvents();

    // (a) stale-delivering reclaim ran first (5-min threshold).
    const reclaim = updatesWith((d) => d?.status === 'pending')[0];
    expect(reclaim.where.status).toBe('delivering');
    expect(Date.now() - reclaim.where.updatedAt.lt.getTime()).toBeGreaterThan(4.9 * 60 * 1000);

    // claim pending → delivering rides the atomic UPDATE…RETURNING raw query
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === 'delivering')).toHaveLength(0);

    // delivery rides the schedule sweeper's machine-run path, no userTurnAt.
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const fire = mockFireScheduleTarget.mock.calls[0][0];
    expect(fire.sessionId).toBe('c-tgt');
    expect(fire.prompt).toContain('Fleet event from chat "Source Chat" (run_completed): Run finished fine');
    // Hardening 2026-09-14: the source chat ID rides the wake on its own line
    // right after the event line — the supervisor no longer resolves a
    // colliding title via list_chats (the invented-id root cause).
    expect(fire.prompt).toContain('Run finished fine\nSource chat id: c-src — copy it VERBATIM as the tool input');
    expect(fire.prompt).toContain('autonomous supervisor wake'); // layered prompts 2026-09-27: tier-generic template
    // Fleet origin (audit p10): a hook wake is stamped 'hook', NOT 'schedule' —
    // the fleet views must attribute it to the hooks subsystem.
    expect(fire.origin).toBe('hook');

    // success: rows delivered, hook stamped, depth propagated as depth+1.
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({
      where: { id: 'h1' }, data: { lastFiredAt: expect.any(Date) },
    });
    expect(mockRedisSet).toHaveBeenCalledWith('fleet:hookdepth:c-tgt', '1', { EX: 3600 });
  });

  it('a custom promptTemplate gets all three placeholders substituted', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ promptTemplate: 'HEY {{sourceChatTitle}} — {{eventType}} — {{summary}}' }));
    await sweepHookEvents();
    const fire = mockFireScheduleTarget.mock.calls[0][0];
    expect(fire.prompt).toBe('HEY Source Chat — run_completed — Run finished fine');
  });

  it('renders dollar-patterns in event payloads literally — no replace-pattern substitution (feedback f548536b/b6013de0 class)', () => {
    // Same String.replace footgun as edit_file (b6013de0): replaceAll with a
    // string replacement interprets dollar-quote/backtick/ampersand in the
    // payload — a summary containing dollar-quote would splice the template's
    // post-match tail into the wake prompt delivered to the supervisor.
    const tricky = "owner said $'go ahead' — cost $100 — matched $& — head $` end";
    const out = renderPrompt('HEY {{summary}} | {{eventType}} | {{sourceChatTitle}}', {
      eventType: 'run_completed', sourceChatTitle: 'Source Chat', summary: tricky,
    });
    expect(out).toBe('HEY ' + tricky + ' | run_completed | Source Chat');
    expect(out.match(/go ahead/g)).toHaveLength(1); // no template-tail splicing
  });

  it('renderPrompt substitutes {{sourceChatId}} literally (hardening 2026-09-14) and renders it empty when the caller has none', () => {
    const vars = { eventType: 'run_completed', sourceChatTitle: 'Worker task', summary: 'done', sourceChatId: 'c-child-$&-1' };
    expect(renderPrompt('[{{sourceChatId}}] {{sourceChatTitle}}: {{summary}}', vars)).toBe('[c-child-$&-1] Worker task: done');
    expect(renderPrompt('[{{sourceChatId}}]', { eventType: 'x', sourceChatTitle: 'y', summary: 'z' })).toBe('[]');
  });

  it('coalesces a multi-event group into a bullet list under ONE source header (eventType "multiple" when mixed)', async () => {
    setPendingRows([
      eventRow({ id: 'e1' }),
      eventRow({
        id: 'e2', eventType: 'attention_needed',
        payload: { eventType: 'attention_needed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'Run needs input: Allow deploy?', depth: 0 },
      }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('(multiple)');
    // Phase 5 grouping: same-source events share a single ### header — which
    // now carries the chat id (hardening 2026-09-14: "### title (chat <id>)").
    expect(prompt).toContain('### Source Chat (chat c-src)\n- [run_completed] Run finished fine\n- [attention_needed] Run needs input: Allow deploy?');
    expect(prompt.match(/### /g)).toHaveLength(1);
    expect(prompt).toContain('Source chat id: c-src'); // one source ⇒ its id, not "multiple"
    // both rows delivered together
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['e1', 'e2'] } } });
  });

  it('groups a multi-source wake under per-source headers (first-seen order, creation order within a group)', async () => {
    // A WILDCARD hook's group fans in from many source chats (creation order:
    // Beta e1, Alpha e2, Beta e3) — the wake renders two headers, sources in
    // first-seen order, each group's bullets in creation order.
    setPendingRows([
      eventRow({ id: 'e1', payload: { eventType: 'run_completed', sourceChatId: 'c-b', sourceChatTitle: 'Beta', summary: 'b done', depth: 0 } }),
      eventRow({ id: 'e2', payload: { eventType: 'run_failed', sourceChatId: 'c-a', sourceChatTitle: 'Alpha', summary: 'a failed', depth: 0 } }),
      eventRow({ id: 'e3', payload: { eventType: 'run_completed', sourceChatId: 'c-b', sourceChatTitle: 'Beta', summary: 'b done again', depth: 0 } }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ sourceChatId: null }));
    mockPrisma.crossModelChat.findUnique.mockImplementation(() => Promise.resolve({ userId: 'u1' }));
    mockPrisma.crossModelChat.findMany = jest.fn().mockResolvedValue([
      { id: 'c-a', userId: 'u1' },
      { id: 'c-b', userId: 'u1' },
    ]);

    await sweepHookEvents();

    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    // Hardening 2026-09-14: every per-source header carries its chat id, and a
    // multi-source wake's id line says so instead of pinning the first chat's id.
    expect(prompt).toContain(
      '### Beta (chat c-b)\n- [run_completed] b done\n- [run_completed] b done again\n' +
      '### Alpha (chat c-a)\n- [run_failed] a failed',
    );
    expect(prompt).toContain('Source chat id: multiple (see per-source headers)');
    expect(prompt).not.toContain('Source chat id: c-b');
    expect(prompt.indexOf('### Beta')).toBeLessThan(prompt.indexOf('### Alpha'));
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['e1', 'e2', 'e3'] } } });
  });

  it('THREAD-KEY CONTINUITY: a group carrying TWO threads is delivered to the SUBSCRIBED target, never to one thread owner (SAA-1.2 residual)', async () => {
    // The sweep groups pending rows by hookId ALONE, so a wildcard supervisor
    // group fans in from many chats at once (the test above proves the digest
    // renders "multiple (see per-source headers)"). Routing used to derive ONE
    // source chat from rows[0] and let that thread's owner decide the whole
    // group — so c-b's owning lane would receive c-a's events too. Measured
    // live shape: this is the ordinary multi-source supervisor wake.
    setPendingRows([
      // rows[0] is the thread that HAS a live, same-account parent.
      eventRow({ id: 'e1', payload: { eventType: 'run_completed', sourceChatId: 'c-b', sourceChatTitle: 'Beta', summary: 'b done', depth: 0 } }),
      eventRow({ id: 'e2', payload: { eventType: 'run_failed', sourceChatId: 'c-a', sourceChatTitle: 'Alpha', summary: 'a failed', depth: 0 } }),
    ]);
    // A WILDCARD hook aimed at a supervisor: the only interceptable class.
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ id: 'hw', sourceChatId: null, targetChatId: 'c-sup', debounceSec: 0 }));
    mockPrisma.crossModelChat.findMany = jest.fn().mockResolvedValue([
      { id: 'c-a', userId: 'u1', projectId: null, project: null },
      { id: 'c-b', userId: 'u1', projectId: null, project: null },
    ]);
    // c-b's lineage resolves to a PERFECTLY deliverable lane — which is exactly
    // what made the old code re-target. The supervisor target is a supervisor.
    mockPrisma.crossModelChat.findUnique.mockImplementation(async (args: any) => {
      const id = args?.where?.id;
      if (id === 'c-sup') return { userId: 'u1', archivedAt: null, isSupervisor: true, isProjectSupervisor: false, codingState: null, projectId: null, project: null };
      if (id === 'c-b') return { parentChatId: 'thread-owner' };
      if (id === 'thread-owner') return { archivedAt: null, userId: 'u1' };
      return { userId: 'u1', archivedAt: null, isSupervisor: false, isProjectSupervisor: false, codingState: null, projectId: null, project: null };
    });

    await sweepHookEvents();

    // ONE wake, at the SUBSCRIBED target — c-a's event did not ride to c-b's owner.
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockFireScheduleTarget.mock.calls[0][0]).toMatchObject({ sessionId: 'c-sup', origin: 'hook' });
    expect(mockFireScheduleTarget.mock.calls[0][0].sessionId).not.toBe('thread-owner');
    // And no "the wake moved" row is written for a route that did not move.
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'hook_thread_passthrough_observe' }),
    );
    // Both threads' events still delivered, in one wake.
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['e1', 'e2'] } } });
  });

  it('an empty source title falls back to an "unknown chat" header (grouped wake)', async () => {
    setPendingRows([
      eventRow({ id: 'e1', payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: '', summary: 'one', depth: 0 } }),
      eventRow({ id: 'e2', payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: '', summary: 'two', depth: 0 } }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    await sweepHookEvents();
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    // Hardening 2026-09-14: the id suffix rides even the fallback header — an
    // untitled chat is exactly the one the supervisor cannot resolve by title.
    expect(prompt).toContain('### unknown chat (chat c-src)\n- [run_completed] one\n- [run_completed] two');
  });

  it('a payload with NO sourceChatId renders a bare header and "unknown" on the id line (hardening 2026-09-14 fallback)', () => {
    const rows = [
      eventRow({ id: 'e1', payload: { eventType: 'run_completed', sourceChatTitle: 'Legacy', summary: 'one', depth: 0 } }),
      eventRow({ id: 'e2', payload: { eventType: 'run_completed', sourceChatTitle: 'Legacy', summary: 'two', depth: 0 } }),
    ];
    const out = coalesce(rows);
    expect(out.sourceChatId).toBe('unknown');
    expect(out.summary).toBe('### Legacy\n- [run_completed] one\n- [run_completed] two');
  });

  it('partial claim race: delivers ONLY the rows this sweeper actually claimed (no double delivery)', async () => {
    setPendingRows([
      eventRow({ id: 'e1' }),
      eventRow({
        id: 'e2', eventType: 'attention_needed',
        payload: { eventType: 'attention_needed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'Other sweeper won this row', depth: 0 },
      }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    // A concurrent sweeper (the other prod web instance) won e2 mid-claim:
    // our UPDATE…RETURNING yields only e1 — e2 must NOT ride along.
    mockPrisma.$queryRaw.mockResolvedValue([eventRow({ id: 'e1' })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('Run finished fine');
    expect(prompt).not.toContain('Other sweeper won this row');
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
  });

  it('debounce: a hook fired within debounceSec keeps its events pending (no claim, no delivery)', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ lastFiredAt: new Date() })); // just fired
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === 'delivering')).toHaveLength(0); // never claimed
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    // only the stale-reclaim + disabled-hook-skip housekeeping updateManys ran (v1#1 adds the latter)
    expect(mockPrisma.hookEvent.updateMany).toHaveBeenCalledTimes(2);
  });

  it('debounce coalescing: events emitted during the window deliver together on the later sweep', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ lastFiredAt: new Date() }));
    setPendingRows([eventRow({ id: 'e1' })]);
    await sweepHookEvents(); // debounced — nothing happens
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();

    // Window passes; a second event arrived meanwhile.
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ lastFiredAt: new Date(Date.now() - 120_000) }));
    setPendingRows([
      eventRow({ id: 'e1' }),
      eventRow({ id: 'e2', payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'Second run done', depth: 0 } }),
    ]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('- [run_completed] Run finished fine');
    expect(prompt).toContain('- [run_completed] Second run done');
  });

  it('autonomy loop #13: a target reported ARCHIVED at dispatch retires the rows (skipped:target_retired) — no attempt burn, no park, no pause, no death notice', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'archived' });
    await sweepHookEvents();
    expect(updatesWith((d) => d?.status === 'skipped:target_retired')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(updatesWith((d) => d?.attempts?.increment === 1)).toHaveLength(0);
    expect(updatesWith((d) => d?.status === 'pending' && d?.retryAt instanceof Date)).toHaveLength(0);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(0);
  });

  it('a busy target TTL-parks non-alarm rows: pending + retryAt, attempts FROZEN, no lastFiredAt write (v1#1)', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    await sweepHookEvents();
    // TTL-park: back to pending with a future retryAt — NOT attempts+1 (the
    // old attempt-burn killed child→parent run_completed rows at ~60 while
    // the parent legitimately worked).
    const park = updatesWith((d) => d?.status === 'pending' && d?.retryAt instanceof Date)[0];
    expect(park).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(park.data.retryAt.getTime()).toBeGreaterThan(Date.now());
    expect(updatesWith((d) => d?.attempts?.increment === 1)).toHaveLength(0);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(0);
  });

  it(`marks events failed at ${MAX_DELIVERY_ATTEMPTS} attempts on a TRANSIENT ERROR (busy no longer burns attempts — v1#1)`, async () => {
    setPendingRows([eventRow({ attempts: MAX_DELIVERY_ATTEMPTS - 1 })]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'error:target exploded' });
    await sweepHookEvents();
    expect(updatesWith((d) => d?.status === 'failed' && d?.attempts?.increment === 1)[0])
      .toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(updatesWith((d) => d?.status === 'pending' && d?.attempts)).toHaveLength(0);
  });

  // 2026-08-30 fleet audit: exhausted events used to die with ONLY a warn log
  // (30 silently dead events found in prod) — now the hook's target chat gets
  // ONE owner-visible notice per 24h (Redis NX) + an audit row.
  it('posts ONE owner-visible death notice per hook when events exhaust attempts', async () => {
    setPendingRows([eventRow({ attempts: MAX_DELIVERY_ATTEMPTS - 1 })]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'error:target exploded' }); // busy now parks (v1#1) — only errors burn attempts
    await sweepHookEvents();
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const msg = mockPrisma.crossModelMessage.create.mock.calls[0][0];
    expect(msg.data.chatId).toBe('c-tgt');
    expect(msg.data.role).toBe('assistant');
    expect(msg.data.content).toContain('permanently');
    expect(msg.data.content).toContain('Source Chat');
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({ where: { id: 'c-tgt' }, data: { updatedAt: expect.any(Date) } });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'hook.events_died', resource: 'platform' }) }),
    );
  });

  it('the death notice is NX-gated — a second death batch inside the window stays quiet', async () => {
    // Delivery's debounce gate must still pass (different key); only the death
    // notice's gate is held.
    mockRedisSet.mockImplementation(async (key: any) => (String(key).includes('hookdeath') ? null : 'OK'));
    setPendingRows([eventRow({ attempts: MAX_DELIVERY_ATTEMPTS - 1 })]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'error:target exploded' }); // busy now parks (v1#1)
    await sweepHookEvents();
    expect(updatesWith((d) => d?.status === 'failed')).toHaveLength(1); // events still fail…
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled(); // …but no duplicate notice
  });

  it('a delivery throw is treated like a busy skip (pending + attempts), never escapes', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockFireScheduleTarget.mockRejectedValue(new Error('fire exploded'));
    await expect(sweepHookEvents()).resolves.toBeUndefined();
    expect(updatesWith((d) => d?.status === 'pending' && d?.attempts?.increment === 1)).toHaveLength(1);
  });

  it('reclaims a stale delivering row and delivers it', async () => {
    // The reclaimed row comes back in the pending fetch (post-reclaim state).
    setPendingRows([eventRow({ status: 'pending' })]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    await sweepHookEvents();
    expect(mockPrisma.hookEvent.updateMany.mock.calls[0][0]).toMatchObject({
      where: { status: 'delivering', updatedAt: { lt: expect.any(Date) } },
      data: { status: 'pending' },
    });
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });

  it('deletes the hook and fails its events when ownership no longer holds at delivery', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    // Target chat changed hands.
    mockPrisma.crossModelChat.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve({ userId: where.id === 'c-tgt' ? 'u2' : 'u1' }));
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === 'failed:target_gone')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(mockPrisma.eventHook.delete).toHaveBeenCalledWith({ where: { id: 'h1' } });
    // …and the AUTO-delete is audit-logged with its reason (feedback be89b75d:
    // "supervisor wiring lost without any signal").
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'hook.auto_delete', resource: 'platform',
        metadata: expect.objectContaining({ hookId: 'h1', reason: expect.stringContaining('target') }),
      }),
    });
  });

  it('audits the auto-delete when SOURCE ownership lapses at delivery (not just target)', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    // Source chat changed hands; target still owned by the hook owner.
    mockPrisma.crossModelChat.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve({ userId: where.id === 'c-src' ? 'u2' : 'u1' }));
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.delete).toHaveBeenCalledWith({ where: { id: 'h1' } });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'hook.auto_delete', resource: 'platform',
        metadata: expect.objectContaining({ hookId: 'h1', reason: expect.stringContaining('source') }),
      }),
    });
  });

  it('wildcard hook: drops rows from deleted/foreign source chats, delivers the rest, KEEPS the hook', async () => {
    setPendingRows([
      eventRow({ id: 'e1', payload: { eventType: 'run_completed', sourceChatId: 'c-a', sourceChatTitle: 'A', summary: 'a', depth: 0 } }),
      eventRow({ id: 'e2', payload: { eventType: 'run_completed', sourceChatId: 'c-deleted', sourceChatTitle: 'Gone', summary: 'g', depth: 0 } }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ sourceChatId: null }));
    // Target ownership check passes; the source batch finds only c-a (c-deleted
    // was removed between emission and delivery).
    mockPrisma.crossModelChat.findUnique.mockImplementation(() => Promise.resolve({ userId: 'u1' }));
    mockPrisma.crossModelChat.findMany = jest.fn().mockResolvedValue([{ id: 'c-a', userId: 'u1' }]);

    await sweepHookEvents();

    // e2 failed (its source vanished), e1 delivered, and the wildcard hook
    // SURVIVES — chats come and go; the supervisor's watch must not.
    expect(updatesWith((d) => d?.status === 'failed:source_gone')[0]).toMatchObject({ where: { id: { in: ['e2'] } } });
    // The delivered update covers EXACTLY the kept rows — the failed e2 is
    // not resurrected as delivered by a stale pre-filter id list.
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });

  it('wildcard hook: a project flipped UNSUPERVISED after emission loses its pending rows at delivery (ticket c992d730)', async () => {
    setPendingRows([
      eventRow({ id: 'e1', payload: { eventType: 'run_completed', sourceChatId: 'c-a', sourceChatTitle: 'A', summary: 'a done', depth: 0 } }),
      eventRow({ id: 'e2', payload: { eventType: 'run_completed', sourceChatId: 'c-b', sourceChatTitle: 'B', summary: 'b done', depth: 0 } }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ sourceChatId: null }));
    // Both source chats are still owner-owned — but c-b's project was toggled
    // unsupervised between emission and delivery.
    mockPrisma.crossModelChat.findUnique.mockImplementation(() => Promise.resolve({ userId: 'u1' }));
    mockPrisma.crossModelChat.findMany = jest.fn().mockResolvedValue([
      { id: 'c-a', userId: 'u1', project: { supervised: true } },
      { id: 'c-b', userId: 'u1', project: { supervised: false } },
    ]);

    await sweepHookEvents();

    // e2 failed (now-unsupervised project), e1 delivered, hook survives.
    expect(updatesWith((d) => d?.status === 'failed:source_gone')[0]).toMatchObject({ where: { id: { in: ['e2'] } } });
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('a done');
    expect(prompt).not.toContain('b done');
  });

  it('wildcard hook: ALL sources gone → everything failed, no delivery, hook still kept', async () => {
    setPendingRows([
      eventRow({ id: 'e1', payload: { eventType: 'run_completed', sourceChatId: 'c-gone', sourceChatTitle: 'G', summary: 'g', depth: 0 } }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ sourceChatId: null }));
    mockPrisma.crossModelChat.findUnique.mockImplementation(() => Promise.resolve({ userId: 'u1' }));
    mockPrisma.crossModelChat.findMany = jest.fn().mockResolvedValue([]);

    await sweepHookEvents();

    expect(updatesWith((d) => d?.status === 'failed:source_gone')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
  });

  it('skips a disabled or missing hook (events stay pending for a re-enable)', async () => {
    for (const hook of [hookRow({ enabled: false }), null]) {
      jest.clearAllMocks();
      mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
      setPendingRows([eventRow()]);
      mockPrisma.eventHook.findUnique.mockResolvedValue(hook);
      await sweepHookEvents();
      expect(mockFireScheduleTarget).not.toHaveBeenCalled();
      expect(updatesWith((d) => d?.status === 'delivering')).toHaveLength(0);
      expect(mockPrisma.hookEvent.updateMany).toHaveBeenCalledTimes(2); // reclaim + disabled-hook skip (v1#1)
    }
  });

  it('a lost claim (count 0) skips the group without delivering', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockPrisma.$queryRaw.mockResolvedValue([]); // claim lost (concurrently handled/deleted)
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(0);
  });

  it('propagates depth: delivering a depth-2 event stamps depth 3 on the target', async () => {
    setPendingRows([
      eventRow({ payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'S', summary: 'deep', depth: 2 } }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    await sweepHookEvents();
    expect(mockRedisSet).toHaveBeenCalledWith('fleet:hookdepth:c-tgt', '3', { EX: 3600 });
  });

  it('a delivered wake never LOWERS an existing deeper target stamp (monotonic max)', async () => {
    setPendingRows([eventRow()]); // depth 0 → would stamp 1
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockRedisGet.mockResolvedValue('3'); // a concurrent deeper delivery already stamped 3
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const depthWrites = mockRedisSet.mock.calls.filter((c: any[]) => String(c[0]).startsWith('fleet:hookdepth:'));
    expect(depthWrites).toHaveLength(0);
  });

  /* ── Daily budget (audit 2026-08-13: hook wakes bypassed every cap) ──────── */

  it('a delivered wake consumes the target chat\'s daily machine-run budget (same counter as schedules)', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    await sweepHookEvents();
    expect(mockDailyCapExceeded).toHaveBeenCalledWith('c-tgt');
    expect(mockRefundDailyCapToken).not.toHaveBeenCalled();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });

  it('a capped wake is DROPPED: rows failed, no delivery, skip event + one owner notice — never queued forever', async () => {
    setPendingRows([
      eventRow({ payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'S', summary: 'done', depth: 1 } }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockDailyCapExceeded.mockResolvedValue(48);
    mockPrisma.eventHook.findMany.mockResolvedValue([]); // the skip emission finds no subscribers here
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === 'failed')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(updatesWith((d) => d?.status === 'pending' && d?.attempts)).toHaveLength(0); // the drop is final
    expect(mockNotifyDailyCapOnce).toHaveBeenCalledWith('c-tgt', 48);
    // schedule_cap_skipped was emitted FROM the capped target (a supervisor can react)…
    expect(mockPrisma.eventHook.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ eventTypes: { has: 'schedule_cap_skipped' } }),
    }));
  });

  it('a 2nd capped wake drop in the same window emits NO duplicate skip event (feedback a30b6ad9) — rows still dropped, owner notice still gated', async () => {
    setPendingRows([
      eventRow({ payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'S', summary: 'done', depth: 1 } }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockDailyCapExceeded.mockResolvedValue(48);
    mockClaimCapWindowGate.mockResolvedValue(false); // the window's ONE event already fired (e.g. a schedule skip claimed it)
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === 'failed')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    // The shared 'daily' gate was consulted for this chat…
    expect(mockClaimCapWindowGate).toHaveBeenCalledWith('c-tgt', 'daily');
    // …and NO subscriber lookup for a schedule_cap_skipped emission happened (muted).
    expect(mockPrisma.eventHook.findMany).not.toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ eventTypes: { has: 'schedule_cap_skipped' } }),
    }));
    // The drop is still final and the owner notice keeps its own NX idiom.
    expect(updatesWith((d) => d?.status === 'pending' && d?.attempts)).toHaveLength(0);
    expect(mockNotifyDailyCapOnce).toHaveBeenCalledWith('c-tgt', 48);
  });

  it('a capped wake at the depth ceiling drops its skip event too (no cap-skip storm from a deep chain)', async () => {
    setPendingRows([
      eventRow({ payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'S', summary: 'deep', depth: MAX_HOOK_DEPTH - 1 } }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockDailyCapExceeded.mockResolvedValue(48);
    await sweepHookEvents();
    // The skip event would carry depth MAX_HOOK_DEPTH — emitHookEvent drops it
    // before any hook lookup, so no eventHook.findMany for it.
    expect(mockPrisma.eventHook.findMany).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === 'failed')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
  });

  it('a busy target refunds the speculative budget token and releases the debounce gate', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    await sweepHookEvents();
    expect(mockRefundDailyCapToken).toHaveBeenCalledWith('c-tgt');
    expect(mockRedisDel).toHaveBeenCalledWith('fleet:hookdebounce:h1');
  });

  /* ── Atomic debounce gate (split-claim double wake across web instances) ─── */

  it('delivery claims the cross-instance debounce gate (SET NX PX, debounceSec window)', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 90 }));
    await sweepHookEvents();
    expect(mockRedisSet).toHaveBeenCalledWith('fleet:hookdebounce:h1', '1', { NX: true, PX: 90_000 });
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });

  it('a LOST gate (a concurrent sweeper owns the window) leaves events pending: no claim, no second wake', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockRedisSet.mockImplementation(async (key: string) => (String(key).startsWith('fleet:hookdebounce:') ? null : 'OK'));
    await sweepHookEvents();
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled(); // never claimed — no split coalesce
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockPrisma.hookEvent.updateMany).toHaveBeenCalledTimes(2); // stale reclaim + disabled-hook skip (v1#1) — rows stay pending
  });

  it('a Redis gate hiccup fails OPEN (delivery proceeds — the row claim still bounds events)', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockRedisSet.mockImplementation(async (key: string) => {
      if (String(key).startsWith('fleet:hookdebounce:')) throw new Error('redis down');
      return 'OK';
    });
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });

  it('debounceSec 0 skips the gate entirely (no window to enforce)', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 0 }));
    await sweepHookEvents();
    expect(mockRedisSet.mock.calls.filter((c: any[]) => String(c[0]).startsWith('fleet:hookdebounce:'))).toHaveLength(0);
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });

  it('never throws — a batch failure is a warn, and an empty outbox is a no-op', async () => {
    mockPrisma.hookEvent.findMany.mockRejectedValue(new Error('db down'));
    await expect(sweepHookEvents()).resolves.toBeUndefined();

    jest.clearAllMocks();
    mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 0 });
    setPendingRows([]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.findUnique).not.toHaveBeenCalled();
  });

  it('the default template documents the placeholders it substitutes', () => {
    // Hardening 2026-09-14: + {{sourceChatId}} — the wake carries the source chat id.
    for (const ph of ['{{eventType}}', '{{sourceChatTitle}}', '{{sourceChatId}}', '{{summary}}']) {
      expect(DEFAULT_PROMPT_TEMPLATE).toContain(ph);
    }
    // The child result-hook template carries the id too (same invented-id class).
    expect(CHILD_RESULT_PROMPT_TEMPLATE).toContain('(chat id {{sourceChatId}})');
  });
});

/* ====================================================================
 * Alarm-class wake priority (audit roadmap #3): attention_needed /
 * run_failed / goal_blocked / schedule_disabled BYPASS the daily cap and
 * PARK (pending, attempts frozen) on a busy target instead of aging toward
 * the MAX_DELIVERY_ATTEMPTS death. Non-alarm behavior is pinned unchanged
 * by the pre-existing cases above.
 * ==================================================================== */
describe('alarm-class wake priority (audit #3)', () => {
  const alarmRow = (over: any = {}) => eventRow({
    id: 'a1', eventType: 'attention_needed',
    payload: {
      eventType: 'attention_needed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat',
      summary: 'Needs a human NOW', depth: 0,
    },
    ...over,
  });
  /** updateMany calls that target explicit row ids (excludes the stale-delivering reclaim). */
  const rowUpdates = () =>
    mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).filter((u: any) => u.where?.id);

  it('the alarm class is exactly the five wired event types (todo_wake joined in P3 — v1#7)', () => {
    expect([...ALARM_EVENT_TYPES].sort()).toEqual(['attention_needed', 'goal_blocked', 'run_failed', 'schedule_disabled', 'todo_wake']);
    // Every SUBSCRIBABLE alarm type is a hook event type; todo_wake is the
    // direct-wake channel (never emitted, never subscribable) and stays out.
    for (const t of ALARM_EVENT_TYPES) {
      if (t === 'todo_wake') expect(HOOK_EVENT_TYPES).not.toContain(t);
      else expect(HOOK_EVENT_TYPES).toContain(t);
    }
  });

  it('isAlarmEvent: schedule_disabled with a successorId is NOT alarm-class (v1#14 renewOnExhaustion rollover)', () => {
    expect(isAlarmEvent('schedule_disabled')).toBe(true);
    expect(isAlarmEvent('schedule_disabled', { successorId: 'succ-1' })).toBe(false);
    expect(isAlarmEvent('attention_needed', { successorId: 'succ-1' })).toBe(true); // only schedule_disabled reads it
    expect(isAlarmEvent('run_completed')).toBe(false);
  });

  // ALARM-CAUSE-AWARE (supervisor SOTA 2026-10-20, platform/alarm-cause.ts): the cause in the payload, not the type.
  it.each([
    ['run_failed', { sourceChatId: 'lane-1' }, true],
    ['run_failed', { sourceChatId: 'lane-1', cause: 'cancelled', cancelledBy: 'sup-1' }, false],
    ['run_failed', { sourceChatId: 'lane-1', cause: 'provider_transient', resumeQueued: true, round: 1 }, false],
    ['schedule_disabled', { sourceChatId: 'lane-1', stoppedByChatId: 'lane-1', laneLiveWork: true }, false],
    ['schedule_disabled', { sourceChatId: 'lane-1', stoppedByChatId: 'lane-1', laneLiveWork: false }, true],
    // review fix 2026-10-20: the lane's LAST schedule stopped (DEAF) stays an alarm.
    ['schedule_disabled', { sourceChatId: 'lane-1', stoppedByChatId: 'lane-1', laneLiveWork: true, remainingEnabled: 0 }, true],
    ['schedule_disabled', { sourceChatId: 'lane-1', stoppedByChatId: 'sup-1', laneLiveWork: true }, true],
    ['attention_needed', { sourceChatId: 'lane-1', cancelledBy: 'sup-1' }, true],
    ['goal_blocked', { sourceChatId: 'lane-1' }, true],
    ['todo_wake', {}, true],
  ])('isAlarmEvent is cause-aware: %s %j → alarm %s', (t, payload, alarm) => {
    expect(isAlarmEvent(t, payload)).toBe(alarm);
  });
  it('HOOK_ALARM_CAUSE_AWARE_DISABLED=1 restores the type-based alarm class', () => {
    process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED = '1';
    try {
      expect(isAlarmEvent('run_failed', { cancelledBy: 'sup-1' })).toBe(true);
      expect(isAlarmEvent('run_failed', { resumeQueued: true })).toBe(true);
      expect(isAlarmEvent('schedule_disabled', { sourceChatId: 'lane-1', stoppedByChatId: 'lane-1', laneLiveWork: true })).toBe(true);
      expect(isAlarmEvent('schedule_disabled', { successorId: 'succ-1' })).toBe(false); // the v1#14 rollover rule is independent
    } finally { delete process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED; }
  });

  it('isAlarmEvent: schedule_disabled with reason target_archived (ARCHIVED-TARGET-RETIRE, 2026-10-20) is NOT alarm-class; the kill switch restores it', () => {
    expect(isAlarmEvent('schedule_disabled', { reason: 'target_archived' })).toBe(false);
    expect(isAlarmEvent('schedule_disabled', { reason: 'lane_archive' })).toBe(true); // only the archived-target pause is quiet
    process.env.ARCHIVED_TARGET_RETIRE_DISABLED = '1';
    try {
      expect(isAlarmEvent('schedule_disabled', { reason: 'target_archived' })).toBe(true);
    } finally {
      delete process.env.ARCHIVED_TARGET_RETIRE_DISABLED;
    }
  });

  it('an alarm-only wake BYPASSES the daily cap: delivered, nothing dropped, no cap notice', async () => {
    setPendingRows([alarmRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['attention_needed'] }));
    mockDailyCapExceeded.mockResolvedValue(48);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockFireScheduleTarget.mock.calls[0][0].prompt).toContain('Needs a human NOW');
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['a1'] } } });
    expect(updatesWith((d) => d?.status === 'failed')).toHaveLength(0);
    expect(mockNotifyDailyCapOnce).not.toHaveBeenCalled();
    // No schedule_cap_skipped emission — nothing was dropped.
    expect(mockPrisma.eventHook.findMany).not.toHaveBeenCalled();
  });

  it('every alarm type gets the bypass (run_failed / goal_blocked / schedule_disabled)', async () => {
    for (const eventType of ['run_failed', 'goal_blocked', 'schedule_disabled']) {
      jest.clearAllMocks();
      mockRedisGet.mockResolvedValue(null);
      mockRedisSet.mockResolvedValue('OK');
      mockFireScheduleTarget.mockResolvedValue({ started: true });
      mockDailyCapExceeded.mockResolvedValue(48);
      mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.$queryRaw.mockImplementation(() => mockPrisma.hookEvent.findMany());
      mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1' });
      setPendingRows([alarmRow({
        eventType,
        payload: { eventType, sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: `alarm ${eventType}`, depth: 0 },
      })]);
      mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: [eventType] }));
      await sweepHookEvents();
      expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
      expect(updatesWith((d) => d?.status === 'failed')).toHaveLength(0);
    }
  });

  it('a MIXED group at the cap: non-alarm rows keep the drop contract (failed + skip event + notice); alarms deliver', async () => {
    setPendingRows([
      eventRow({ id: 'e1' }), // run_completed — non-alarm
      alarmRow({ id: 'a1' }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['run_completed', 'attention_needed'] }));
    mockDailyCapExceeded.mockResolvedValue(48);
    mockPrisma.eventHook.findMany.mockResolvedValue([]); // the skip emission finds no subscribers
    await sweepHookEvents();
    // Non-alarm e1: byte-for-byte the old drop-at-cap contract.
    expect(updatesWith((d) => d?.status === 'failed')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(mockNotifyDailyCapOnce).toHaveBeenCalledWith('c-tgt', 48);
    expect(mockPrisma.eventHook.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ eventTypes: { has: 'schedule_cap_skipped' } }),
    }));
    // Alarm a1: delivered anyway, and the wake prompt carries ONLY the alarm.
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('Needs a human NOW');
    expect(prompt).not.toContain('Run finished fine');
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['a1'] } } });
  });

  it('a busy target PARKS alarm rows: pending WITHOUT the attempts increment, never failed', async () => {
    setPendingRows([alarmRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['attention_needed'] }));
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    await sweepHookEvents();
    const parked = rowUpdates().filter((u: any) => u.data?.status === 'pending');
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ where: { id: { in: ['a1'] } }, data: { status: 'pending' } });
    expect(parked[0].data.attempts).toBeUndefined(); // frozen — parked, not retried-toward-death
    expect(updatesWith((d) => d?.status === 'failed')).toHaveLength(0);
    // Under the cap the speculative token was held → still refunded (unchanged).
    expect(mockRefundDailyCapToken).toHaveBeenCalledWith('c-tgt');
    expect(mockRedisDel).toHaveBeenCalledWith('fleet:hookdebounce:h1');
  });

  it(`an alarm at ${MAX_DELIVERY_ATTEMPTS - 1} attempts does NOT die on a busy target — parked, no death notice (the expiry vector removed)`, async () => {
    setPendingRows([alarmRow({ attempts: MAX_DELIVERY_ATTEMPTS - 1 })]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['attention_needed'] }));
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    await sweepHookEvents();
    expect(updatesWith((d) => d?.status === 'failed')).toHaveLength(0);
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled(); // no hook-death notice
    const parked = rowUpdates().filter((u: any) => u.data?.status === 'pending' && !u.data?.attempts);
    expect(parked[0]).toMatchObject({ where: { id: { in: ['a1'] } } });
  });

  it('non-busy failure reasons keep the bounded retry lane even for alarms (death notice still reachable)', async () => {
    setPendingRows([alarmRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['attention_needed'] }));
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'error:boom' });
    await sweepHookEvents();
    expect(updatesWith((d) => d?.status === 'pending' && d?.attempts?.increment === 1)[0])
      .toMatchObject({ where: { id: { in: ['a1'] } } });
  });

  it('cap-bypass + busy: the alarm parks and NO budget token is refunded (none was held)', async () => {
    setPendingRows([alarmRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['attention_needed'] }));
    mockDailyCapExceeded.mockResolvedValue(48);
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    await sweepHookEvents();
    expect(mockRefundDailyCapToken).not.toHaveBeenCalled();
    const parked = rowUpdates().filter((u: any) => u.data?.status === 'pending' && !u.data?.attempts);
    expect(parked[0]).toMatchObject({ where: { id: { in: ['a1'] } } });
  });

  it(`alarm-storm guard: pending alarms per target are capped at ${PARKED_ALARM_CAP} — the OLDEST beyond the cap are evicted with a warn`, async () => {
    const overCap = Array.from({ length: PARKED_ALARM_CAP + 2 }, (_, i) => ({ id: `p${i}` }));
    // findMany serves five reads in order: the retry-horizon pass (v1#1 —
    // nothing old), the sweep scan, the window-drain backlog read (review
    // 2026-09-13 issue 1 — nothing else pending), the claim (the $queryRaw
    // default impl), then parkAlarmRows' pending-alarm census.
    mockPrisma.hookEvent.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([alarmRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([alarmRow()])
      .mockResolvedValueOnce(overCap);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['attention_needed'] }));
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    await sweepHookEvents();
    // The census is scoped to PENDING alarm rows of THIS target chat, oldest first
    // (FLEET-PS-FIRST 2026-10-20: payload + retryAt ride so a held PS escalation is never counted).
    expect(mockPrisma.hookEvent.findMany).toHaveBeenCalledWith({
      where: { status: 'pending', eventType: { in: [...ALARM_EVENT_TYPES] }, hook: { targetChatId: 'c-tgt' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, payload: true, retryAt: true },
    });
    // Oldest two evicted (p0, p1); the newest PARKED_ALARM_CAP survive.
    expect(updatesWith((d) => d?.status === 'failed')[0]).toMatchObject({ where: { id: { in: ['p0', 'p1'] } } });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('parked-alarm cap'));
  });

  it('LANE-IDLE-WAKE review fix: a not-yet-due DELAYED row (payload.notBefore) neither counts against the alarm cap nor is ever evicted', async () => {
    const later = new Date(Date.now() + 15 * 60_000).toISOString();
    // Two delayed lane_idle rows are the OLDEST; PARKED_ALARM_CAP + 1 genuine alarms after them.
    const census = [
      { id: 'd0', payload: { notBefore: later } }, { id: 'd1', payload: { notBefore: later } },
      ...Array.from({ length: PARKED_ALARM_CAP + 1 }, (_, i) => ({ id: `g${i}`, payload: {} })),
    ];
    mockPrisma.hookEvent.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([alarmRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([alarmRow()])
      .mockResolvedValueOnce(census);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['attention_needed'] }));
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    await sweepHookEvents();
    // Only ONE genuine alarm over the cap — the oldest GENUINE one goes; the delayed rows are untouched.
    expect(updatesWith((d) => d?.status === 'failed')).toEqual([{ where: { id: { in: ['g0'] } }, data: { status: 'failed' } }]);
  });

  it('under the cap and target free: an alarm wake behaves exactly like today (delivered, token consumed)', async () => {
    setPendingRows([alarmRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['attention_needed'] }));
    await sweepHookEvents();
    expect(mockDailyCapExceeded).toHaveBeenCalledWith('c-tgt');
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['a1'] } } });
  });
});

/* ====================================================================
 * CI-WATCH escalation alarm class (round-2 interactions fix, 2026-10-20):
 * ci-watch marks a sha 'escalated' (terminal; a lane_loop escalation also
 * stops waking the lane for 24 h) once its ci_failed row is WRITTEN, so the
 * row must not be droppable at delivery — a ci_failed carrying
 * payload.ciWatchEscalation is alarm-class (cap bypass, frozen-attempt park,
 * STALE banner, outside the parked-alarm census). A plain ci_failed (the
 * lane's own check_ci) keeps the quiet contract; CI_WATCH_DISABLED=1 restores
 * the quiet class for the escalation too.
 * ==================================================================== */
describe('CI-WATCH escalation is alarm-class at delivery (r2 interactions)', () => {
  const ciRow = (over: any = {}, escalation: string | null = 'lane_loop') => eventRow({
    id: 'ci1', eventType: 'ci_failed',
    payload: {
      eventType: 'ci_failed', sourceChatId: 'c-src', sourceChatTitle: 'Lane',
      summary: 'CI FAILED on pushed commit abc: tests', depth: 0, sha: 'a'.repeat(40),
      ...(escalation ? { ciWatch: true, ciWatchEscalation: escalation } : {}),
    },
    ...over,
  });
  const suppressionWrite = (id: string) =>
    mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0])
      .find((u: any) => u?.where?.id === id && u?.data?.status === 'delivered' && u?.data?.payload?.suppressedAtDelivery);

  beforeEach(() => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['ci_failed'], debounceSec: 0 }));
  });
  afterEach(() => { delete process.env.CI_WATCH_DISABLED; });

  it('isAlarmEvent: only a ci_failed carrying ciWatchEscalation is alarm-class; the kill switch restores quiet', () => {
    expect(isAlarmEvent('ci_failed', { ciWatchEscalation: 'lane_loop' })).toBe(true);
    expect(isAlarmEvent('ci_failed', { ciWatchEscalation: 'max_hold', sha: 'a'.repeat(40) })).toBe(true);
    expect(isAlarmEvent('ci_failed', { sha: 'a'.repeat(40) })).toBe(false); // the lane's own check_ci
    expect(isAlarmEvent('ci_failed', { ciWatchEscalation: '' })).toBe(false);
    expect(isAlarmEvent('ci_failed', { ciWatchEscalation: true })).toBe(false);
    expect(isAlarmEvent('ci_failed')).toBe(false);
    expect(isAlarmEvent('run_completed', { ciWatchEscalation: 'lane_loop' })).toBe(false); // only ci_failed reads it
    expect(ALARM_EVENT_TYPES as readonly string[]).not.toContain('ci_failed'); // the TYPE stays quiet
    process.env.CI_WATCH_DISABLED = '1';
    expect(isAlarmEvent('ci_failed', { ciWatchEscalation: 'lane_loop' })).toBe(false);
  });

  it('at the daily cap the escalation BYPASSES the drop (delivered) while a plain ci_failed in the same group keeps the drop contract', async () => {
    setPendingRows([ciRow(), ciRow({ id: 'ci2' }, null)]);
    mockDailyCapExceeded.mockResolvedValue(480);
    mockPrisma.eventHook.findMany.mockResolvedValue([]); // the schedule_cap_skipped emission finds no subscribers
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockFireScheduleTarget.mock.calls[0][0].prompt).toContain('CI FAILED on pushed commit abc');
    expect(updatesWith((d) => d?.status === 'failed')).toEqual([{ where: { id: { in: ['ci2'] } }, data: { status: 'failed' } }]);
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['ci1'] } } });
  });

  it('older than the stale bound the escalation still delivers with the STALE banner (never consumed silently)', async () => {
    setPendingRows([ciRow({ createdAt: new Date(Date.now() - 3 * 3600_000) })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockFireScheduleTarget.mock.calls[0][0].prompt).toContain('[STALE — emitted');
    expect(suppressionWrite('ci1')).toBeUndefined();
  });

  it('a busy target ALARM-parks the escalation (attempts frozen, no TTL retryAt) and the parked-alarm census never counts or evicts it', async () => {
    setPendingRows([ciRow()]);
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    await sweepHookEvents();
    const parked = updatesWith((d) => d?.status === 'pending').filter((u: any) => u.where?.id?.in?.includes('ci1'));
    expect(parked).toHaveLength(1);
    expect(parked[0].data).toEqual({ status: 'pending' }); // the alarm park: no retryAt, no attempts increment
    // The census reads only ALARM_EVENT_TYPES rows — ci_failed (bounded by ci-watch's per-sha claim) is never among them.
    const census = mockPrisma.hookEvent.findMany.mock.calls.map((c: any[]) => c[0])
      .find((a: any) => a?.where?.eventType?.in && a?.where?.hook?.targetChatId === 'c-tgt');
    expect(census?.where.eventType.in).not.toContain('ci_failed');
  });

  it('CI_WATCH_DISABLED=1: the escalation is quiet again — dropped at the cap like before the fix', async () => {
    process.env.CI_WATCH_DISABLED = '1';
    setPendingRows([ciRow()]);
    mockDailyCapExceeded.mockResolvedValue(480);
    mockPrisma.eventHook.findMany.mockResolvedValue([]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(updatesWith((d) => d?.status === 'failed')[0]).toMatchObject({ where: { id: { in: ['ci1'] } } });
  });
});

/* ====================================================================
 * Alarm-class DEBOUNCE bypass (owner 2026-09-04 — supervisor wake economy):
 * the supervisor wildcard debounce is 3600s now (supervisor.service), so an
 * alarm waiting out the window would delay failure response by up to an hour.
 * A pending batch containing ANY alarm-class event delivers immediately as
 * ONE coalesced wake; non-alarm-only batches respect the debounce unchanged
 * (pinned by the pre-existing debounce cases above). Storm evidence for the
 * economy: 02:13/02:15/02:23/02:26Z, 2026-09-04.
 * ==================================================================== */
describe('alarm-class debounce bypass (owner 2026-09-04 wake economy)', () => {
  const alarmRow = (over: any = {}) => eventRow({
    id: 'a1', eventType: 'attention_needed',
    payload: {
      eventType: 'attention_needed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat',
      summary: 'Needs a human NOW', depth: 0,
    },
    ...over,
  });
  const debounceGateSets = () =>
    mockRedisSet.mock.calls.filter((c: any[]) => String(c[0]).startsWith('fleet:hookdebounce:'));

  it('a pending batch containing an alarm BYPASSES an active debounce window — still ONE coalesced wake, the quiet rows ride along', async () => {
    setPendingRows([eventRow({ id: 'e1' }), alarmRow()]);
    // Just fired — the 60s window is ACTIVE; a non-alarm batch would return.
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ lastFiredAt: new Date() }));
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('Needs a human NOW');
    expect(prompt).toContain('Run finished fine'); // the quiet row coalesced into the SAME wake
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['e1', 'a1'] } } });
    // The alarm wake OWNS the window it starts: plain SET PX (not NX — bypass
    // means delivering even inside an active window).
    expect(debounceGateSets()).toEqual([['fleet:hookdebounce:h1', '1', { PX: 60_000 }]]);
  });

  it('a non-alarm-only batch still respects the active window (the bypass is alarm-gated)', async () => {
    setPendingRows([eventRow({ id: 'e1' })]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ lastFiredAt: new Date() }));
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled(); // never even claimed
  });

  it('a failed alarm-bypass delivery releases the gate it set (retry stays sweep-paced)', async () => {
    setPendingRows([alarmRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['attention_needed'], lastFiredAt: new Date() }));
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    await sweepHookEvents();
    expect(mockRedisDel).toHaveBeenCalledWith('fleet:hookdebounce:h1');
  });

  it('a Redis hiccup on the alarm-gate reset fails OPEN — the alarm still delivers', async () => {
    mockRedisSet.mockImplementation(async (key: any) => {
      if (String(key).startsWith('fleet:hookdebounce:')) throw new Error('redis down');
      return 'OK';
    });
    setPendingRows([alarmRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['attention_needed'], lastFiredAt: new Date() }));
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['a1'] } } });
  });
});

/* ====================================================================
 * Loop-metrics wake telemetry (audit #12 close-out): the three hooks
 * loop-metrics wiring markers are now real recordLoopMetric calls —
 * delivered / alarm cap-bypass / busy-park. Fire-and-forget wiring only;
 * the metric service's never-throws contract is pinned in its own suite.
 * ==================================================================== */
describe('loop-metrics wake telemetry (audit #12 close-out)', () => {
  const alarmRow = (over: any = {}) => eventRow({
    id: 'a1', eventType: 'attention_needed',
    payload: {
      eventType: 'attention_needed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat',
      summary: 'Needs a human NOW', depth: 0,
    },
    ...over,
  });

  it('a delivered wake records wake_delivered with the event class + hook id', async () => {
    // SAA-1.1 Phase 1 (2026-11-03): the batch names its source run, so the policy
    // asks whether that run actually DID anything. No receipt (the mockPrisma
    // default) is NOT proof of quiet — receipts cover only 21 of the 91 mutating
    // tools — so the guard answers UNKNOWN and the batch stays a candidate. That
    // is the whole point of the review fix: silence is never read as innocence.
    const row = eventRow();
    row.payload = { ...row.payload, runId: 'r1' };
    setPendingRows([row]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    await sweepHookEvents();
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(2);
    // SAA-1.1 Phase 1a (todo 03bcf00f): the delivery row also carries the DURABLE
    // batch key so the labelled outcome row can join it exactly, with no time
    // window. Its absence here would mean the label side never matches.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith({
      kind: 'wake_delivered', sessionId: 'c-tgt', value: 1,
      meta: { eventType: 'run_completed', hookId: 'h1', capBypassed: false, drained: 0, hookBatch: 'h1|e1' },
    });
    // SAA-1.1 Phase 1: the deterministic admission policy emits BESIDE the wake
    // telemetry (observe-only). This batch reaches the routine branch and is turned
    // away by the SOURCE-RUN GUARD, so it is recorded as candidate/source_run_mutated
    // — a CANDIDATE, never a suppression, never in precision. Recording the guard's
    // own verdict is what keeps Phase 1 a denominator for run_completed at all: if
    // this row vanished, every batch the guard touched would go unmeasured and a
    // future "precision 1.0" could not be told apart from "numerator shrank to 0".
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'hook_source_policy_observe', sessionId: 'c-tgt', value: 1,
      meta: expect.objectContaining({ decision: 'candidate', reason: 'source_run_mutated', rows: 1 }),
    }));
  });

  it('an alarm cap-bypass delivery records wake_delivered {capBypassed:true}', async () => {
    setPendingRows([alarmRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['attention_needed'] }));
    mockDailyCapExceeded.mockResolvedValue(48);
    await sweepHookEvents();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith({
      kind: 'wake_delivered', sessionId: 'c-tgt', value: 1,
      meta: { eventType: 'attention_needed', hookId: 'h1', capBypassed: true, drained: 0, hookBatch: 'h1|a1' },
    });
  });

  it('a busy-target alarm park records wake_parked with the park reason (and no wake_delivered)', async () => {
    setPendingRows([alarmRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ eventTypes: ['attention_needed'] }));
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    await sweepHookEvents();
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(2);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith({
      kind: 'wake_parked', sessionId: 'c-tgt', value: 1, meta: { reason: 'busy' },
    });
    // An alarm batch is the policy's `respond` side — recorded too, so the 48 h
    // readout has the false-negative denominator and not just the suppressions.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'hook_source_policy_observe',
      meta: expect.objectContaining({ decision: 'respond', reason: 'alarm_class' }),
    }));
  });

  it('a non-alarm drop at the cap records NO metric (drop-at-cap is not a wake)', async () => {
    setPendingRows([eventRow()]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockDailyCapExceeded.mockResolvedValue(48);
    mockPrisma.eventHook.findMany.mockResolvedValue([]); // the skip emission finds no subscribers
    await sweepHookEvents();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });
});

/* ====================================================================
 * P3 remediation — v1#1 / spark B17+B18: hook-outbox fairness.
 * ==================================================================== */
describe('v1#1 — outbox fairness (selectFairBatch + sweep lanes)', () => {
  const mk = (id: string, hookId: string, eventType = 'run_completed', payload: any = {}) =>
    ({ id, hookId, eventType, payload: { eventType, ...payload }, createdAt: new Date() });

  it('selectFairBatch: alarm-class rows lead, then a per-hook round-robin over the quiet remainder', () => {
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => mk(`hog${i}`, 'h-hog')), // one hook's flood
      mk('q1', 'h-quiet'),
      mk('a1', 'h-alarm', 'run_failed'),
    ];
    const batch = selectFairBatch(rows, 20, SWEEP_PER_HOOK_CAP);
    expect(batch[0].id).toBe('a1'); // the smoke detector goes first
    // The flooding hook is capped per sweep; the quiet hook still gets its row.
    expect(batch.filter((r) => r.hookId === 'h-hog')).toHaveLength(SWEEP_PER_HOOK_CAP);
    expect(batch.some((r) => r.id === 'q1')).toBe(true);
  });

  it('selectFairBatch: a schedule_disabled WITH a successor is quiet (round-robins), one WITHOUT leads', () => {
    const rows = [
      mk('q0', 'h-a'),
      mk('roll', 'h-b', 'schedule_disabled', { successorId: 'succ-1' }),
      mk('dead', 'h-c', 'schedule_disabled'),
    ];
    const batch = selectFairBatch(rows, 3, 1);
    expect(batch[0].id).toBe('dead');
  });

  it("sweep lane a2: a DISABLED hook's pending rows are terminal-marked 'skipped:hook_disabled' (visible, never silent)", async () => {
    setPendingRows([]);
    await sweepHookEvents();
    const skip = mockPrisma.hookEvent.updateMany.mock.calls
      .map((c: any[]) => c[0])
      .find((u: any) => u?.data?.status === 'skipped:hook_disabled');
    expect(skip).toBeTruthy();
    expect(skip.where).toMatchObject({ status: 'pending', hook: { enabled: false } });
  });

  it("sweep lane a3: pending rows older than the 24h horizon dead-letter as 'failed:horizon' + owner notice", async () => {
    const old = eventRow({ id: 'e-old', createdAt: new Date(Date.now() - RETRY_HORIZON_MS - 60_000) });
    setPendingRows([], [old]); // scan empty; horizon pass sees the fossil
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    await sweepHookEvents();
    const dead = mockPrisma.hookEvent.updateMany.mock.calls
      .map((c: any[]) => c[0])
      .find((u: any) => u?.data?.status === 'failed:horizon');
    expect(dead).toMatchObject({ where: { id: { in: ['e-old'] } } });
    // Owner-visible death notice (never a silent drop).
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content).toContain('stayed undeliverable');
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
  });

  it('sweep scan skips rows TTL-parked into the future (retryAt)', async () => {
    setPendingRows([]);
    await sweepHookEvents();
    const scan = mockPrisma.hookEvent.findMany.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a?.where?.OR);
    expect(scan.where).toMatchObject({ status: 'pending', hook: { enabled: true } });
    expect(scan.where.OR).toEqual([{ retryAt: null }, { retryAt: { lte: expect.any(Date) } }]);
  });

  it('spark B17/B18: a child→parent run_completed row on a BUSY parent parks with retryAt — it can no longer die at 60 attempts', async () => {
    setPendingRows([eventRow({ id: 'e-child', attempts: MAX_DELIVERY_ATTEMPTS - 1 })]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    await sweepHookEvents();
    const park = updatesWith((d) => d?.status === 'pending' && d?.retryAt instanceof Date)[0];
    expect(park).toMatchObject({ where: { id: { in: ['e-child'] } } });
    expect(park.data.retryAt.getTime() - Date.now()).toBeGreaterThan(BUSY_PARK_MS - 5_000);
    expect(updatesWith((d) => d?.status === 'failed')).toHaveLength(0); // no death
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled(); // no death notice — nothing died
  });
});

/* ====================================================================
 * P3 remediation — v1#8: alarm-class events skip self-loop suppression.
 * ==================================================================== */
// Gate flip 2026-09-11 (owner: full steam): the exemption is DEFAULT OFF — all
// 41 self-loop alarm rows since deploy were the Fleet Supervisor alarming itself
// about its own schedules (busy-skips / once-cancels), never a goal_blocked or
// run_failed.
describe('v1#8 — alarm self-loop exemption at emission (default OFF since the 2026-09-11 gate flip)', () => {
  afterEach(() => {
    delete process.env.HOOK_ALARM_SELFLOOP_DISABLED;
  });

  it('goal_blocked emitted from the wildcard target itself is SUPPRESSED by default (no supervisor self-wake)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow({ id: 'h-wild', sourceChatId: null, targetChatId: 'c-sup', eventTypes: ['goal_blocked'] })]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ title: 'Supervisor', userId: 'u1', project: null });
    await emitHookEvent('c-sup', 'goal_blocked', 'Goal blocked: X');
    expect(mockPrisma.hookEvent.create).not.toHaveBeenCalled();
  });

  it('the busy-skip / once-cancel self-alarm class (attention_needed, schedule_disabled) is suppressed by default too', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow({ id: 'h-wild', sourceChatId: null, targetChatId: 'c-sup', eventTypes: ['attention_needed', 'schedule_disabled'] })]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ title: 'Supervisor', userId: 'u1', project: null });
    await emitHookEvent('c-sup', 'attention_needed', 'Schedule x: 3 consecutive firings were skipped because the chat is BUSY');
    await emitHookEvent('c-sup', 'schedule_disabled', '(once) disabled — cancelled after 0 run(s)', { scheduleId: 's1', kind: 'once', reason: 'cancelled' } as any);
    expect(mockPrisma.hookEvent.create).not.toHaveBeenCalled();
  });

  it('quiet events keep the suppression (run_completed self-loops still never insert)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow({ id: 'h-wild', sourceChatId: null, targetChatId: 'c-sup', eventTypes: ['run_completed'] })]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ title: 'Supervisor', userId: 'u1', project: null });
    await emitHookEvent('c-sup', 'run_completed', 'done');
    expect(mockPrisma.hookEvent.create).not.toHaveBeenCalled();
  });

  it('a NON-self target still receives the alarm (only the source==target edge is suppressed)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow({ id: 'h-wild', sourceChatId: null, targetChatId: 'c-sup', eventTypes: ['goal_blocked'] })]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ title: 'Lane', userId: 'u1', project: null });
    await emitHookEvent('c-lane', 'goal_blocked', 'Goal blocked: X');
    expect(mockPrisma.hookEvent.create).toHaveBeenCalledTimes(1);
  });

  it('the retired HOOK_ALARM_SELFLOOP_DISABLED kill-switch is inert (its semantics are now the default)', async () => {
    process.env.HOOK_ALARM_SELFLOOP_DISABLED = '1';
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow({ id: 'h-wild', sourceChatId: null, targetChatId: 'c-sup', eventTypes: ['goal_blocked'] })]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ title: 'Supervisor', userId: 'u1', project: null });
    await emitHookEvent('c-sup', 'goal_blocked', 'Goal blocked: X');
    expect(mockPrisma.hookEvent.create).not.toHaveBeenCalled();
  });
});

/* ====================================================================
 * P3 remediation — v1#7: enqueueDirectWake (the durable todo-wake channel).
 * ==================================================================== */
describe('v1#7 — enqueueDirectWake', () => {
  beforeEach(() => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', title: 'Lane' });
    mockPrisma.eventHook.findFirst.mockResolvedValue(null);
    mockPrisma.hookEvent.create.mockResolvedValue({ id: 'he-9' });
  });

  it('creates the per-chat SYSTEM self-hook once and inserts the wake row (summary IS the prompt)', async () => {
    const res = await enqueueDirectWake({ targetChatId: 'c-lane', prompt: 'Do the todo now', meta: { todoId: 't1', trigger: 'unblocked' } });
    expect(res).toEqual({ ok: true, hookEventId: 'he-9' });
    expect(mockPrisma.eventHook.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1', sourceChatId: 'c-lane', targetChatId: 'c-lane',
        eventTypes: [TODO_WAKE_EVENT_TYPE], promptTemplate: '{{summary}}', debounceSec: 0,
        createdVia: 'system:direct-wake', // provenance (ticket dd3a19fa)
      },
    });
    const evt = mockPrisma.hookEvent.create.mock.calls[0][0].data;
    expect(evt.eventType).toBe(TODO_WAKE_EVENT_TYPE);
    expect(evt.payload).toMatchObject({
      eventType: TODO_WAKE_EVENT_TYPE, sourceChatId: 'c-lane', sourceChatTitle: 'Lane',
      summary: 'Do the todo now', depth: 0, todoId: 't1', trigger: 'unblocked',
    });
  });

  it('reuses an existing self-hook (no duplicate wiring) and re-enables a disabled one', async () => {
    mockPrisma.eventHook.findFirst.mockResolvedValue(hookRow({ id: 'h-direct', enabled: false, eventTypes: [TODO_WAKE_EVENT_TYPE] }));
    const res = await enqueueDirectWake({ targetChatId: 'c-lane', prompt: 'p' });
    expect(res.ok).toBe(true);
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({ where: { id: 'h-direct' }, data: { enabled: true } });
  });

  it('a missing target chat answers ok:false (the caller releases its debounce) — never a throw', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
    await expect(enqueueDirectWake({ targetChatId: 'c-gone', prompt: 'p' })).resolves.toMatchObject({ ok: false });
    expect(mockPrisma.hookEvent.create).not.toHaveBeenCalled();
  });

  it('todo_wake is alarm-class: a busy target PARKS the delivered wake instead of dropping it', async () => {
    const wakeRow = eventRow({ id: 'e-wake', eventType: TODO_WAKE_EVENT_TYPE, payload: { eventType: TODO_WAKE_EVENT_TYPE, sourceChatId: 'c-tgt', sourceChatTitle: 'Lane', summary: 'Do it', depth: 0 } });
    setPendingRows([wakeRow]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ sourceChatId: 'c-tgt', targetChatId: 'c-tgt', eventTypes: [TODO_WAKE_EVENT_TYPE], promptTemplate: '{{summary}}', debounceSec: 0 }));
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    await sweepHookEvents();
    // Parked via the ALARM lane: pending, attempts frozen, no retryAt bump.
    // (Select by the row-scoped where — the stale-delivering reclaim writes the
    // same data shape but has no id filter.)
    const park = mockPrisma.hookEvent.updateMany.mock.calls
      .map((c: any[]) => c[0])
      .find((u: any) => u?.data?.status === 'pending' && u?.where?.id?.in);
    expect(park.where.id.in).toEqual(['e-wake']);
    expect(park.data.retryAt).toBeUndefined();
    expect(park.data.attempts).toBeUndefined();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wake_parked' }));
  });
});

/* ====================================================================
 * Delivery-time todo_wake revalidation — feedback 7d7268fb (2026-09-11).
 * A durable todo_wake enqueued at a GENUINE unblock/assignment can PARK
 * behind a busy assignee (alarm-class park) and deliver long after the
 * todo was re-blocked / finished / dropped / reassigned — the 2026-09-11
 * phantom delivered a 14:53Z "UNBLOCKED … START now — execution, not a
 * status audit" summary at 16:27Z onto a todo re-blocked (owner gate)
 * ~35 min earlier, urging execution of a production-blast-radius soak.
 * These pins: the delivery path re-reads the todo and suppresses stale
 * wakes (row consumed, no fire), while genuinely actionable todos and
 * revalidation failures still deliver.
 * ==================================================================== */
describe('todo_wake delivery-time revalidation (feedback 7d7268fb)', () => {
  const selfHook = () => hookRow({
    id: 'h-wake', sourceChatId: 'c-tgt', targetChatId: 'c-tgt',
    eventTypes: [TODO_WAKE_EVENT_TYPE], promptTemplate: '{{summary}}', debounceSec: 0,
  });
  const wakeEventRow = (over: any = {}) => eventRow({
    id: 'e-wake', hookId: 'h-wake', eventType: TODO_WAKE_EVENT_TYPE,
    payload: {
      eventType: TODO_WAKE_EVENT_TYPE, sourceChatId: 'c-tgt', sourceChatTitle: 'Lane',
      summary: '[Fleet goal board — a todo was just UNBLOCKED to this chat]\nTodo: "Soak"\n\nSTART now',
      depth: 0, todoId: 'todo-1', goalId: 'g1', trigger: 'unblocked',
    },
    ...over,
  });
  /** Per-row suppression write: scalar-id where + annotated payload. */
  const suppressionWrite = (id: string) =>
    mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0])
      .find((u: any) => u?.where?.id === id && u?.data?.status === 'delivered' && u?.data?.payload?.suppressedAtDelivery);

  beforeEach(() => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(selfHook());
  });

  it('REPLAY 7d7268fb: a parked "UNBLOCKED" wake whose todo is BLOCKED again at delivery never fires', async () => {
    setPendingRows([wakeEventRow()]);
    // The 16:27Z delivery-time truth: re-blocked under an owner gate ~15:52Z.
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ status: 'blocked', assigneeChatId: 'c-tgt' });
    await sweepHookEvents();
    expect(mockPrisma.projectTodo.findUnique).toHaveBeenCalledWith({
      where: { id: 'todo-1' }, select: { status: true, assigneeChatId: true },
    });
    expect(mockFireScheduleTarget).not.toHaveBeenCalled(); // the phantom wake must not fire
    expect(suppressionWrite('e-wake')?.data?.payload?.suppressedAtDelivery).toBe('status:blocked');
    expect(mockPrisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'todo.wake_suppressed' }) }),
    );
  });

  it.each(['done', 'dropped'])('a wake whose todo reached terminal state (%s) while parked is suppressed', async (status) => {
    setPendingRows([wakeEventRow()]);
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ status, assigneeChatId: 'c-tgt' });
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(suppressionWrite('e-wake')?.data?.payload?.suppressedAtDelivery).toBe(`status:${status}`);
  });

  it('a wake whose todo was reassigned away from the target chat is suppressed', async () => {
    setPendingRows([wakeEventRow()]);
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ status: 'pending', assigneeChatId: 'c-other' });
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(suppressionWrite('e-wake')?.data?.payload?.suppressedAtDelivery).toBe('reassigned_away');
  });

  it('a wake whose todo row vanished is suppressed', async () => {
    setPendingRows([wakeEventRow()]);
    mockPrisma.projectTodo.findUnique.mockResolvedValue(null);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(suppressionWrite('e-wake')?.data?.payload?.suppressedAtDelivery).toBe('todo_missing');
  });

  // CanLaw stall 2026-09-15 (verified live 06:25Z): the corrective wakes ARE
  // about a blocked todo and may target the project supervisor — the
  // actionable-NOW revalidation consumed all four with 'reassigned_away' /
  // 'status:blocked' and no run. Their staleness is the inverse shape.
  const claimWakeRow = (over: any = {}) => wakeEventRow({
    payload: {
      eventType: TODO_WAKE_EVENT_TYPE, sourceChatId: 'c-tgt', sourceChatTitle: 'CanLaw Supervisor',
      summary: '[Fleet goal board — this todo claims an OWNER decision that does not exist]\nTodo "Full SFT-2 training on GO" (dc507413) is blocked…',
      depth: 0, todoId: 'todo-1', trigger: 'owner_claim_unbacked', surface: 'attention_watchdog',
    },
    ...over,
  });

  it('an owner_claim_unbacked wake about a BLOCKED todo DELIVERS even when the target is not the assignee (the supervisor leg)', async () => {
    setPendingRows([claimWakeRow()]);
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ status: 'blocked', assigneeChatId: 'c-other' });
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockFireScheduleTarget.mock.calls[0][0].prompt).toContain('claims an OWNER decision that does not exist');
    expect(suppressionWrite('e-wake')).toBeUndefined();
  });

  it.each(['pending', 'in_progress', 'done', 'dropped'])('an owner_claim_unbacked wake is stale once the todo is no longer blocked (%s) — the correction already happened', async (status) => {
    setPendingRows([claimWakeRow()]);
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ status, assigneeChatId: 'c-tgt' });
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(suppressionWrite('e-wake')?.data?.payload?.suppressedAtDelivery).toBe(`status:${status}`);
  });

  it('an owner_asked_back wake (the counter-question gate release) about a blocked todo delivers to the assignee', async () => {
    setPendingRows([claimWakeRow({ payload: { eventType: TODO_WAKE_EVENT_TYPE, sourceChatId: 'c-tgt', sourceChatTitle: 'Lane', summary: "[Fleet goal board — the owner replied to this todo's gate WITH A QUESTION, not a decision]", depth: 0, todoId: 'todo-1', goalId: 'g1', trigger: 'owner_asked_back' } })]);
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ status: 'blocked', assigneeChatId: 'c-tgt' });
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(suppressionWrite('e-wake')).toBeUndefined();
  });

  it('a vanished todo suppresses a corrective wake too', async () => {
    setPendingRows([claimWakeRow()]);
    mockPrisma.projectTodo.findUnique.mockResolvedValue(null);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(suppressionWrite('e-wake')?.data?.payload?.suppressedAtDelivery).toBe('todo_missing');
  });

  it('full suppression releases the debounce gate — no phantom window for the NEXT genuine wake (ticket 85856e4f)', async () => {
    // debounceSec 60 (not 0): the alarm-class gate IS claimed for this group.
    mockPrisma.eventHook.findUnique.mockResolvedValue({ ...selfHook(), debounceSec: 60 });
    setPendingRows([wakeEventRow()]);
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ status: 'blocked', assigneeChatId: 'c-tgt' });
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled(); // stale wake suppressed
    expect(suppressionWrite('e-wake')?.data?.payload?.suppressedAtDelivery).toBe('status:blocked');
    // The hook's debounce gate is released instead of holding a phantom window.
    expect(mockRedisDel).toHaveBeenCalledWith('fleet:hookdebounce:h-wake');
  });

  it('a still-actionable todo (pending, same assignee) delivers normally — the genuine unblock wake survives', async () => {
    setPendingRows([wakeEventRow()]); // default projectTodo: pending + c-tgt
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const arg = mockFireScheduleTarget.mock.calls[0][0];
    expect(arg.sessionId).toBe('c-tgt');
    expect(arg.prompt).toContain('UNBLOCKED'); // the summary rides verbatim ({{summary}})
    expect(suppressionWrite('e-wake')).toBeUndefined();
    const delivered = mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0])
      .find((u: any) => u?.where?.id?.in?.includes('e-wake') && u?.data?.status === 'delivered');
    expect(delivered).toBeDefined();
    expect(mockPrisma.activity.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'todo.wake_suppressed' }) }),
    );
  });

  it('an in_progress todo still delivers (actionable for the assignee)', async () => {
    setPendingRows([wakeEventRow()]);
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ status: 'in_progress', assigneeChatId: 'c-tgt' });
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(suppressionWrite('e-wake')).toBeUndefined();
  });

  it('a mixed batch suppresses only the stale row — the fresh wake in the same group still fires', async () => {
    const stale = wakeEventRow({ id: 'e-stale', payload: { eventType: TODO_WAKE_EVENT_TYPE, sourceChatId: 'c-tgt', sourceChatTitle: 'Lane', summary: 'stale wake', depth: 0, todoId: 'todo-1', trigger: 'unblocked' } });
    const fresh = wakeEventRow({ id: 'e-fresh', payload: { eventType: TODO_WAKE_EVENT_TYPE, sourceChatId: 'c-tgt', sourceChatTitle: 'Lane', summary: 'fresh wake', depth: 0, todoId: 'todo-2', trigger: 'assigned' } });
    setPendingRows([stale, fresh]);
    mockPrisma.projectTodo.findUnique.mockImplementation(({ where }: any) => Promise.resolve(
      where.id === 'todo-1' ? { status: 'blocked', assigneeChatId: 'c-tgt' } : { status: 'pending', assigneeChatId: 'c-tgt' },
    ));
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1); // the fresh row still wakes
    expect(suppressionWrite('e-stale')?.data?.payload?.suppressedAtDelivery).toBe('status:blocked');
    expect(suppressionWrite('e-fresh')).toBeUndefined();
  });

  it('revalidation failure fails OPEN — a prisma hiccup still delivers rather than wedging the outbox', async () => {
    setPendingRows([wakeEventRow()]);
    mockPrisma.projectTodo.findUnique.mockRejectedValue(new Error('db down'));
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(suppressionWrite('e-wake')).toBeUndefined();
  });

  it('a row without a todoId has no revalidation handle — delivered as-is', async () => {
    setPendingRows([wakeEventRow({ payload: { eventType: TODO_WAKE_EVENT_TYPE, sourceChatId: 'c-tgt', sourceChatTitle: 'Lane', summary: 'legacy wake', depth: 0 } })]);
    await sweepHookEvents();
    expect(mockPrisma.projectTodo.findUnique).not.toHaveBeenCalled();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });
});

/* ====================================================================
 * Stale-event guard at delivery — ticket 2b1609b2 (2026-09-13).
 * A row parked behind a busy target used to deliver VERBATIM hours later
 * (observed: 21h-old run_completed batch waking the supervisor; a 9h-late
 * child result-hook; schedule_disabled rollovers whose successors had
 * already run out) — the woken run burned a full machine run re-verifying
 * and dismissing day-old state. These pins: QUIET rows older than
 * STALE_QUIET_EVENT_MS are consumed (delivered + annotated) with NO wake;
 * ALARM rows older than the bound still deliver but carry a STALE banner.
 * ==================================================================== */
describe('stale-event guard at delivery (ticket 2b1609b2)', () => {
  const STALE_AGE_MS = 3 * 3600_000; // > STALE_QUIET_EVENT_MS (2h)
  const staleQuietRow = (over: any = {}) => eventRow({
    createdAt: new Date(Date.now() - STALE_AGE_MS),
    ...over,
  });
  /** Per-row suppression write: scalar-id where + annotated payload (same shape as the todo_wake helper above). */
  const suppressionWrite = (id: string) =>
    mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0])
      .find((u: any) => u?.where?.id === id && u?.data?.status === 'delivered' && u?.data?.payload?.suppressedAtDelivery);

  beforeEach(() => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 0 }));
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', title: 'Target' });
  });

  it('an all-stale QUIET group is consumed with NO wake (the ticket\'s 21h supervisor batch)', async () => {
    setPendingRows([
      staleQuietRow({ id: 'e-old1', payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'old self-audit A', depth: 0 } }),
      staleQuietRow({ id: 'e-old2', createdAt: new Date(Date.now() - 21 * 3600_000), payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'old self-audit B', depth: 0 } }),
    ]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(suppressionWrite('e-old1')?.data?.payload?.suppressedAtDelivery).toBe('stale:3h');
    expect(suppressionWrite('e-old2')?.data?.payload?.suppressedAtDelivery).toBe('stale:21h');
    expect(mockPrisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'hook.stale_suppressed' }) }),
    );
  });

  it('full stale suppression releases the debounce gate — no phantom window for the NEXT genuine wake', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 60 }));
    setPendingRows([staleQuietRow({ id: 'e-old' })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(suppressionWrite('e-old')?.data?.payload?.suppressedAtDelivery).toBe('stale:3h');
    expect(mockRedisDel).toHaveBeenCalledWith('fleet:hookdebounce:h1');
  });

  it('a stale schedule_disabled WITH successorId is quiet-class — suppressed like the ticket\'s rollover events', async () => {
    setPendingRows([staleQuietRow({
      id: 'e-roll', eventType: 'schedule_disabled',
      payload: { eventType: 'schedule_disabled', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'Schedule stopped (max runs) — successor armed', depth: 0, successorId: 's-next' },
    })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(suppressionWrite('e-roll')?.data?.payload?.suppressedAtDelivery).toBe('stale:3h');
  });

  it('a mixed batch suppresses only the stale quiet row — the fresh event in the same group still wakes', async () => {
    setPendingRows([
      staleQuietRow({ id: 'e-stale', payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'day-old summary', depth: 0 } }),
      eventRow({ id: 'e-fresh', payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'just happened', depth: 0 } }),
    ]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('just happened');
    expect(prompt).not.toContain('day-old summary');
    expect(suppressionWrite('e-stale')?.data?.payload?.suppressedAtDelivery).toBe('stale:3h');
    expect(suppressionWrite('e-fresh')).toBeUndefined();
  });

  it('a stale ALARM row still delivers (smoke detectors are never dropped) but carries the STALE banner', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 0, eventTypes: ['run_failed'] }));
    setPendingRows([staleQuietRow({
      id: 'e-alarm', eventType: 'run_failed',
      payload: { eventType: 'run_failed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'Run exploded', depth: 0 },
    })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('[STALE — emitted');
    expect(prompt).toContain('~3h before this delivery');
    expect(prompt).toContain('Run exploded');
    expect(suppressionWrite('e-alarm')).toBeUndefined(); // delivered, not suppressed
  });

  it('a fresh quiet row delivers unchanged — no suppression, no banner', async () => {
    setPendingRows([eventRow({ id: 'e-fresh' })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('Run finished fine');
    expect(prompt).not.toContain('[STALE —');
    expect(suppressionWrite('e-fresh')).toBeUndefined();
    expect(mockPrisma.activity.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'hook.stale_suppressed' }) }),
    );
  });
});

/* ====================================================================
 * WI-C (2026-09-25) — wake-triage OUTCOME LABELS: a shadow decision that
 * DELIVERS is no longer closed with actual:null at delivery; its stash rides
 * fireScheduleTarget to the run that finalizes it (labelled there —
 * decision-outcome-labels.test.ts). Every decision still pairs with exactly
 * one outcome: a not-started / steered / queued wake closes it here,
 * unlabelled. Kill switch restores the delivery-time row.
 * WI-R — the triage park can never become a silent stale drop: the defer
 * clamp sits under the 2 h stale bound and a triage-parked row older than
 * the bound delivers with the STALE banner (kill switch restores consume).
 * ==================================================================== */
describe('WI-C wake-triage outcome labels + WI-R triage stale exemption', () => {
  const GATE = { id: 'wt1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 8, answers: { needs_turn_now: { type: 'noul', noul: 0.06 } } };
  const ENV = ['DECISION_GATE_WAKE_TRIAGE_DEFER_MIN'];
  const savedEnv: Record<string, string | undefined> = {};
  const suppressionWrite = (id: string) =>
    mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0])
      .find((u: any) => u?.where?.id === id && u?.data?.status === 'delivered' && u?.data?.payload?.suppressedAtDelivery);

  beforeEach(() => {
    for (const k of ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 0 }));
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', title: 'Target' });
    mockDecisionMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(GATE);
    mockFireScheduleTarget.mockResolvedValue({ started: true, decisionDeferred: true });
  });
  afterEach(() => {
    for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    mockDecisionMode.mockReturnValue('off');
    mockDecide.mockResolvedValue(null);
  });

  it('SHADOW delivery stashes the decision onto the wake (fireScheduleTarget.decision) and writes NO outcome row — the run labels it', async () => {
    setPendingRows([eventRow({ id: 'e1' })]);
    await sweepHookEvents();
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'wake_triage', sessionId: 'c-tgt' });
    // E3b: the ask carries the memo-stable projection keyed by the batch's event ids (no memo:false for a plain quiet batch).
    expect(mockDecide.mock.calls[0][2].memoState).toMatchObject({ event_ids: ['e1'], event_type: 'run_completed' });
    expect(mockDecide.mock.calls[0][2].memo).toBeUndefined();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const fire = mockFireScheduleTarget.mock.calls[0][0];
    expect(fire).toMatchObject({ id: 'hook-h1', sessionId: 'c-tgt', origin: 'hook' });
    expect(fire.decision).toMatchObject({ id: 'wt1', purpose: 'wake_triage', mode: 'shadow', backend: 'TypeSafe Jev', answers: { needs_turn_now: { noul: 0.06 } } });
    expect(mockRecordDecisionOutcome).not.toHaveBeenCalled();
    // The wake itself is unchanged: delivered + telemetered exactly as before.
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wake_delivered' }));
  });

  it('a BUSY target closes the decision here, unlabelled (actual null, "not started: busy") — the re-triage next sweep is a fresh decision', async () => {
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    setPendingRows([eventRow({ id: 'e1' })]);
    await sweepHookEvents();
    expect(mockRecordDecisionOutcome).toHaveBeenCalledTimes(1);
    const [decision, purpose, outcome] = mockRecordDecisionOutcome.mock.calls[0];
    expect(decision).toMatchObject({ id: 'wt1', mode: 'shadow' });
    expect(purpose).toBe('wake_triage');
    expect(outcome).toMatchObject({ question: 'needs_turn_now', actual: null, acted: false, sessionId: 'c-tgt', note: 'not started: busy' });
    // Shadow never stamps triagedAt — the parked row stays re-triageable.
    expect(updatesWith((d) => d?.payload?.triagedAt)).toHaveLength(0);
  });

  it('a wake STEERED into an active run (started, no decisionDeferred) closes the decision unlabelled too', async () => {
    mockFireScheduleTarget.mockResolvedValue({ started: true, steered: true });
    setPendingRows([eventRow({ id: 'e1' })]);
    await sweepHookEvents();
    expect(mockRecordDecisionOutcome).toHaveBeenCalledTimes(1);
    expect(mockRecordDecisionOutcome.mock.calls[0][2]).toMatchObject({ actual: null, acted: false, note: expect.stringContaining('steered/queued') });
  });

  it('a null gate answer (no backend) delivers with no stash and no outcome row — fail-open unchanged', async () => {
    mockDecide.mockResolvedValue(null);
    setPendingRows([eventRow({ id: 'e1' })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockFireScheduleTarget.mock.calls[0][0].decision).toBeUndefined();
    expect(mockRecordDecisionOutcome).not.toHaveBeenCalled();
  });

  it('WI-R: the defer clamp tops out at 105 min (under the 2 h stale bound); default 30; floor 5', () => {
    expect(WAKE_TRIAGE_DEFER_MAX_MIN).toBe(105);
    expect(WAKE_TRIAGE_DEFER_MAX_MIN * 60_000).toBeLessThan(STALE_QUIET_EVENT_MS);
    process.env.DECISION_GATE_WAKE_TRIAGE_DEFER_MIN = '150';
    expect(WAKE_TRIAGE_DEFER_MS()).toBe(105 * 60_000);
    process.env.DECISION_GATE_WAKE_TRIAGE_DEFER_MIN = '180';
    expect(WAKE_TRIAGE_DEFER_MS()).toBe(105 * 60_000);
    process.env.DECISION_GATE_WAKE_TRIAGE_DEFER_MIN = '1';
    expect(WAKE_TRIAGE_DEFER_MS()).toBe(5 * 60_000);
    delete process.env.DECISION_GATE_WAKE_TRIAGE_DEFER_MIN;
    expect(WAKE_TRIAGE_DEFER_MS()).toBe(30 * 60_000);
  });

  it('WI-R: a triage-parked QUIET row 150 min old still WAKES (STALE banner, not consumed); rows carrying triagedAt are never re-triaged', async () => {
    setPendingRows([eventRow({
      id: 'e-parked',
      createdAt: new Date(Date.now() - 150 * 60_000),
      payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'parked completion', depth: 0, triagedAt: '2026-09-25T10:00:00.000Z', triageNoul: 0.06 },
    })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('[STALE — emitted');
    expect(prompt).toContain('parked completion');
    expect(suppressionWrite('e-parked')).toBeUndefined();
    expect(mockDecide).not.toHaveBeenCalled(); // already triaged once — never twice
  });
});

/* ====================================================================
 * 2026-10-04 — wake_triage ACT CONTROL SAMPLE (the sweep_triage E12 design).
 * In act, a confident-quiet verdict PARKS the wake (acted:true, actual:null)
 * and the deferred delivery rides with triagedAt (never stashed), so a park
 * never earns a label and the act band held zero act-period labels. One
 * confident park in N now DELIVERS instead with the stash stamped
 * extra.control:true; the run's finalize labels it inside the act band.
 * ==================================================================== */
describe('2026-10-04 wake_triage ACT control sample', () => {
  const QUIET_ACT = { id: 'wt-ctl', mode: 'act', backend: 'TypeSafe Jev', ms: 8, answers: { needs_turn_now: { type: 'noul', noul: 0.05 } } };
  const ENV = ['DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE', 'WAKE_TRIAGE_CONTROL_SAMPLE_DISABLED', 'DECISION_GATE_WAKE_TRIAGE_DEFER_MIN'];
  const savedEnv: Record<string, string | undefined> = {};
  const triageParks = () => updatesWith((d) => d?.payload?.triagedAt);
  const needsTurnRows = () => mockRecordDecisionOutcome.mock.calls.filter((c: any[]) => c[2]?.question === 'needs_turn_now');
  /** Re-seed the per-test defaults after a jest.clearAllMocks() inside one test. */
  const reseed = () => {
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockDailyCapExceeded.mockResolvedValue(null);
    mockClaimCapWindowGate.mockResolvedValue(true);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 0 }));
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', title: 'Target' });
    mockDecisionMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(QUIET_ACT);
    mockFireScheduleTarget.mockResolvedValue({ started: true, decisionDeferred: true });
  };

  beforeEach(() => {
    for (const k of ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    reseed();
  });
  afterEach(() => {
    setWakeTriageControlSampler(null);
    for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    mockDecisionMode.mockReturnValue('off');
    mockDecide.mockResolvedValue(null);
  });

  it('ACT + confident quiet + the draw misses ⇒ the park is unchanged (triagedAt stamped, acted:true row, no wake, no stash)', async () => {
    setWakeTriageControlSampler(() => 0.99);
    setPendingRows([eventRow({ id: 'e1' })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(triageParks()).toHaveLength(1);
    expect(triageParks()[0]).toMatchObject({ where: { id: 'e1' }, data: { status: 'pending' } });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wake_parked', meta: expect.objectContaining({ reason: 'triage' }) }));
    expect(needsTurnRows()).toHaveLength(1);
    expect(needsTurnRows()[0][2]).toMatchObject({ actual: null, acted: true });
    // The park path stamps NO control-sample extra. Phase 1a's durable batch key
    // DOES ride here (it is the correlation handle the label side needs), so the
    // assertion is on the control flag specifically, not on the whole object —
    // pinning the whole object would make an unrelated telemetry key look like a
    // control-sample regression.
    expect(needsTurnRows()[0][2].extra ?? {}).not.toHaveProperty('control');
  });

  it('ACT + confident quiet + the draw hits ⇒ the wake DELIVERS with an act-mode stash stamped extra {control:true, controlReason:sample}; no park, no acted row, no refund', async () => {
    setWakeTriageControlSampler(() => 0.0);
    setPendingRows([eventRow({ id: 'e1' })]);
    await sweepHookEvents();
    expect(triageParks()).toHaveLength(0);
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const fire = mockFireScheduleTarget.mock.calls[0][0];
    expect(fire.decision).toMatchObject({ id: 'wt-ctl', purpose: 'wake_triage', mode: 'act', extra: { control: true, controlReason: 'sample' } });
    // The finalize labels it — nothing is closed here (no acted:true park row, no unlabelled close).
    expect(needsTurnRows()).toHaveLength(0);
    expect(mockRefundDailyCapToken).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'wake_parked' }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wake_delivered', meta: expect.objectContaining({ triageControl: true }) }));
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(1);
  });

  it('the draw follows DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE and never runs on a non-quiet act answer or a shadow answer', async () => {
    process.env.DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE = '0.5';
    setWakeTriageControlSampler(() => 0.49);
    setPendingRows([eventRow({ id: 'e1' })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget.mock.calls[0]?.[0]?.decision).toMatchObject({ extra: { control: true } });

    jest.clearAllMocks(); reseed();
    setWakeTriageControlSampler(() => 0.51);
    setPendingRows([eventRow({ id: 'e1' })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled(); // 0.51 ≥ 0.5 ⇒ parked
    expect(triageParks()).toHaveLength(1);

    jest.clearAllMocks(); reseed();
    const sampler = jest.fn(() => 0.0);
    setWakeTriageControlSampler(sampler);
    // A non-quiet act answer delivers as before — no draw, no control stamp.
    mockDecide.mockResolvedValue({ ...QUIET_ACT, answers: { needs_turn_now: { type: 'noul', noul: 0.6 } } });
    setPendingRows([eventRow({ id: 'e1' })]);
    await sweepHookEvents();
    expect(sampler).not.toHaveBeenCalled();
    expect(mockFireScheduleTarget.mock.calls[0][0].decision).toMatchObject({ mode: 'act' });
    // No CONTROL stamp — but Phase 1a's durable batch key legitimately rides the
    // stash, so assert on the control flag, not on the presence of `extra`.
    expect((mockFireScheduleTarget.mock.calls[0][0].decision as any).extra ?? {}).not.toHaveProperty('control');

    jest.clearAllMocks(); reseed();
    // A SHADOW answer (shadow mode / an uncalibrated backend) never draws — it delivers with a plain stash.
    mockDecide.mockResolvedValue({ ...QUIET_ACT, mode: 'shadow' });
    setPendingRows([eventRow({ id: 'e1' })]);
    await sweepHookEvents();
    expect(sampler).not.toHaveBeenCalled();
    expect(mockFireScheduleTarget.mock.calls[0][0].decision).toMatchObject({ mode: 'shadow' });
    expect((mockFireScheduleTarget.mock.calls[0][0].decision as any).extra ?? {}).not.toHaveProperty('control');
  });

  it('kill switch WAKE_TRIAGE_CONTROL_SAMPLE_DISABLED=1 ⇒ park every time, even when the sampler would hit', async () => {
    process.env.WAKE_TRIAGE_CONTROL_SAMPLE_DISABLED = '1';
    setWakeTriageControlSampler(() => 0.0);
    setPendingRows([eventRow({ id: 'e1' })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(triageParks()).toHaveLength(1);
  });

  it('an ALARM row never reaches the gate (no draw); a BUSY control closes unlabelled with the stamp kept and no triagedAt', async () => {
    const sampler = jest.fn(() => 0.0);
    setWakeTriageControlSampler(sampler);
    setPendingRows([eventRow({ id: 'a1', eventType: 'attention_needed', payload: { eventType: 'attention_needed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'stuck', depth: 0 } })]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 0, eventTypes: ['attention_needed'] }));
    await sweepHookEvents();
    expect(mockDecide).not.toHaveBeenCalled();
    expect(sampler).not.toHaveBeenCalled();

    jest.clearAllMocks(); reseed();
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    setPendingRows([eventRow({ id: 'e1' })]);
    await sweepHookEvents();
    expect(needsTurnRows()).toHaveLength(1);
    expect(needsTurnRows()[0][2]).toMatchObject({ actual: null, acted: false, note: 'not started: busy', extra: { control: true, controlReason: 'sample' } });
    // A busy control is NOT a triage park: no triagedAt, so the next sweep re-triages it (a fresh decision + draw).
    expect(triageParks()).toHaveLength(0);
  });
});

/* ====================================================================
 * P3 remediation — spark B21: preempted-wake redelivery.
 * ==================================================================== */
describe('B21 — requeuePreemptedHookEvents', () => {
  it('flips recent DELIVERED rows back to pending ONCE (payload.preemptRequeued guards the second time)', async () => {
    const fresh = eventRow({ id: 'e-d1', status: 'delivered', updatedAt: new Date() });
    const again = eventRow({ id: 'e-d2', status: 'delivered', updatedAt: new Date(), payload: { eventType: 'run_completed', preemptRequeued: true } });
    mockPrisma.hookEvent.findMany.mockResolvedValue([fresh, again]);
    const n = await requeuePreemptedHookEvents('c-tgt');
    expect(n).toBe(1);
    const flip = mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]);
    expect(flip).toHaveLength(1);
    expect(flip[0].where).toEqual({ id: 'e-d1', status: 'delivered' });
    expect(flip[0].data.status).toBe('pending');
    expect(flip[0].data.retryAt).toBeNull();
    expect(flip[0].data.payload).toMatchObject({ preemptRequeued: true });
    // Scoped to this chat's hooks within the lookback window.
    const q = mockPrisma.hookEvent.findMany.mock.calls[0][0];
    expect(q.where.hook).toEqual({ targetChatId: 'c-tgt' });
    expect(Date.now() - q.where.updatedAt.gte.getTime()).toBeLessThanOrEqual(PREEMPT_REDELIVERY_LOOKBACK_MS + 5_000);
  });

  it('never throws — a read failure answers 0', async () => {
    mockPrisma.hookEvent.findMany.mockRejectedValue(new Error('db down'));
    await expect(requeuePreemptedHookEvents('c-tgt')).resolves.toBe(0);
  });
});

/* ====================================================================
 * Review 2026-09-13 issue 1 — "Supervisor event feed capped at ~10
 * events/hour; #712 silently discards the overflow". Hook 83b3cd9d
 * (debounce 3600) got SWEEP_PER_HOOK_CAP=10 quiet rows per window against
 * ~15/h arrivals; the FIFO backlog aged to 22.8h and the stale guard then
 * consumed 330 rows with no wake, no notice, no metric. Pins:
 *   A  the window winner DRAINS its whole deliverable backlog into ONE wake
 *      (claimed + delivered together; other hooks' rows untouched; opt-in
 *      kill switch; an alarm-owned window drains too);
 *   A  digest rendering: >DIGEST_COMPACT_THRESHOLD quiet rows → one line
 *      each, ≤DIGEST_MAX_LINES shown preferring the NEWEST, "+N more" line,
 *      alarm rows verbatim; ≤threshold groups render exactly as before;
 *   C  stale-consumed rows are marked delivered (suppressedAtDelivery) and
 *      a "were NOT shown" line rides the wake that follows;
 *   C  a drain-cap remainder is announced in the wake, never silent.
 * ==================================================================== */
describe('review 2026-09-13 issue 1 — window drain + bounded digest + visible stale loss', () => {
  const quietRow = (i: number, over: any = {}) => eventRow({
    id: `q${i}`,
    createdAt: new Date(Date.now() - (1000 - i) * 1000), // q0 oldest … strictly increasing
    payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: `completion ${i}\nsecond line of ${i}`, depth: 0 },
    ...over,
  });
  const alarmRow = (over: any = {}) => eventRow({
    id: 'a1', eventType: 'run_failed',
    payload: { eventType: 'run_failed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'Run exploded\nstack line 1\nstack line 2', depth: 0 },
    ...over,
  });
  const claimWhere = () => mockPrisma.$queryRaw.mock.calls[0];
  // The real drain read is the ONLY hookId-scoped findMany with orderBy+take
  // (the claim mock below issues a bare where.hookId read to assemble its rows).
  const drainRead = () => mockPrisma.hookEvent.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.hookId && a?.take);

  beforeEach(() => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 3600 }));
    // The claim (UPDATE…RETURNING) hands back exactly the ids it was given —
    // the fair-batch rows PLUS the drained backlog must all be in the IN list.
    mockPrisma.$queryRaw.mockImplementation(async (_strings: TemplateStringsArray, ...vals: any[]) => {
      const joined: string[] = vals.find((v) => v && Array.isArray(v.values))?.values ?? [];
      const all = [...(await mockPrisma.hookEvent.findMany({})), ...(await mockPrisma.hookEvent.findMany({ where: { hookId: 'h1' } }))];
      const byId = new Map<string, any>();
      for (const r of all) if (joined.includes(r.id) && !byId.has(r.id)) byId.set(r.id, r);
      return [...byId.values()];
    });
  });

  it('A: the window winner drains its WHOLE deliverable backlog into ONE wake — every row claimed + delivered, wake_delivered says how many were drained', async () => {
    const fair = Array.from({ length: SWEEP_PER_HOOK_CAP }, (_, i) => quietRow(i));
    const backlog = Array.from({ length: 15 }, (_, i) => quietRow(SWEEP_PER_HOOK_CAP + i));
    setPendingRows(fair, [], backlog);
    await sweepHookEvents();
    // The drain read is scoped to THIS hook's pending rows, NEWEST first, bounded.
    // Hardening 2026-09-14: NO retryAt filter — busy-parked rows RIDE a wake
    // already going to the same target (they still never START one: the sweep
    // scan keeps its retryAt filter, pinned below in the instant-delivery block).
    expect(drainRead()).toEqual({
      where: { hookId: 'h1', status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: WINDOW_DRAIN_CAP,
    });
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1); // ONE wake, not 25
    const delivered = updatesWith((d) => d?.status === 'delivered')[0];
    expect(delivered.where.id.in).toHaveLength(25);
    expect(delivered.where.id.in).toEqual(expect.arrayContaining([...fair, ...backlog].map((r) => r.id)));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'wake_delivered', value: 25, meta: expect.objectContaining({ drained: 15 }),
    }));
    // Digest mode (25 > threshold): one compact line per quiet event, header with the count.
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('Coalesced digest — 25 event(s) (25 quiet, 0 alarm)');
    expect(prompt).toContain('completion 24');
    expect(prompt).not.toContain('second line of'); // compact = first line only
    expect(prompt).not.toContain('NOT shown'); // nothing was lost
  });

  it('A: the drain never pulls in another hook\'s rows or rows already in the group (defensive re-filter) — a TTL-parked row now RIDES the wake', async () => {
    const fair = [quietRow(0)];
    const backlog = [
      quietRow(0), // duplicate of a fair-batch row
      quietRow(1, { hookId: 'h2' }), // another hook's row
      // Hardening 2026-09-14: pin updated — a busy-parked row used to be
      // excluded here and then missed this wake, re-debouncing 10+ min behind
      // the lastFiredAt it wrote; a wake to THIS target is being built now, so
      // the parked row joins it.
      quietRow(2, { retryAt: new Date(Date.now() + 60_000) }),
      quietRow(3), // a plain extra
    ];
    setPendingRows(fair, [], backlog);
    await sweepHookEvents();
    const delivered = updatesWith((d) => d?.status === 'delivered')[0];
    expect(delivered.where.id.in.sort()).toEqual(['q0', 'q2', 'q3']);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'wake_delivered', value: 3, meta: expect.objectContaining({ drained: 2 }),
    }));
  });

  it('A (hardening 2026-09-14): a busy-parked QUIET row rides an ALARM-owned wake to the same target instead of waiting out the window', async () => {
    // T0: a run_completed group hit 'busy' and TTL-parked (+3 min). T0+1m: an
    // attention_needed alarm arrives and delivers immediately — the parked
    // completion must ride THIS wake, not re-debounce 600 s behind it.
    const parked = quietRow(1, { retryAt: new Date(Date.now() + BUSY_PARK_MS - 1000) });
    setPendingRows([alarmRow()], [], [parked]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 600, eventTypes: ['run_failed', 'run_completed'], lastFiredAt: new Date() }));
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const delivered = updatesWith((d) => d?.status === 'delivered')[0];
    expect(delivered.where.id.in.sort()).toEqual(['a1', 'q1']);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('- [run_failed] Run exploded');
    expect(prompt).toContain('- [run_completed] completion 1');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'wake_delivered', value: 2, meta: expect.objectContaining({ drained: 1 }),
    }));
  });

  it('A (hardening 2026-09-14): when the target is STILL busy, the drained parked row re-parks with the group via the existing busy path (retryAt refreshed, attempts frozen)', async () => {
    const stale = new Date(Date.now() + 30_000);
    setPendingRows([quietRow(0)], [], [quietRow(1, { retryAt: stale })]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 0 }));
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    await sweepHookEvents();
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(0);
    const park = updatesWith((d) => d?.status === 'pending' && d?.retryAt instanceof Date)[0];
    expect(park.where.id.in.sort()).toEqual(['q0', 'q1']); // the merged group parks together
    expect(park.data.retryAt.getTime()).toBeGreaterThan(stale.getTime()); // refreshed +BUSY_PARK_MS from now
    expect(park.data.attempts).toBeUndefined(); // frozen — busy is not a delivery failure
    expect(updatesWith((d) => d?.attempts?.increment)).toHaveLength(0);
  });

  it('A: an ALARM-owned window drains the quiet backlog too (the smoke detector rides with the digest, verbatim)', async () => {
    const backlog = Array.from({ length: 12 }, (_, i) => quietRow(i));
    setPendingRows([alarmRow()], [], backlog);
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 3600, eventTypes: ['run_failed', 'run_completed'], lastFiredAt: new Date() }));
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('(12 quiet, 1 alarm)');
    expect(prompt).toContain('- [run_failed] Run exploded\nstack line 1\nstack line 2'); // alarm verbatim, multi-line
    expect(prompt).toContain('- [run_completed] '); // quiet rows compact
    expect(updatesWith((d) => d?.status === 'delivered')[0].where.id.in).toHaveLength(13);
  });

  it('A: the debounce gate still rules — a LOST window drains nothing (no backlog read, no claim, rows stay pending)', async () => {
    setPendingRows([quietRow(0)], [], [quietRow(1)]);
    mockRedisSet.mockResolvedValue(null); // another instance owns the window
    await sweepHookEvents();
    expect(drainRead()).toBeUndefined();
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
  });

  it('A: a drain read failure is non-fatal — the fair-batch group still delivers exactly as before', async () => {
    mockPrisma.hookEvent.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.hookId) throw new Error('db hiccup');
      return args?.where?.createdAt?.lt ? [] : [quietRow(0)];
    });
    mockPrisma.$queryRaw.mockResolvedValue([quietRow(0)]); // the claim itself is healthy
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === 'delivered')[0].where.id.in).toEqual(['q0']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('window drain failed'));
  });

  it('C: when the drain cap binds, the remainder is COUNTED and the wake says "N older … NOT included" (never silently left behind)', async () => {
    const backlog = Array.from({ length: WINDOW_DRAIN_CAP }, (_, i) => quietRow(i + 1));
    setPendingRows([quietRow(0)], [], backlog);
    mockPrisma.hookEvent.count.mockResolvedValue(37);
    await sweepHookEvents();
    expect(mockPrisma.hookEvent.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ hookId: 'h1', status: 'pending', createdAt: { lt: expect.any(Date) } }),
    });
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('37 older pending event(s) emitted before');
    expect(prompt).toContain('NOT included in this wake');
    expect(prompt).toContain(`drain cap (${WINDOW_DRAIN_CAP})`);
    expect(prompt).toContain('list_chats');
  });

  it('C: stale consumption marks every eaten row delivered with its age — an all-stale group still marks them (no wake)', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 0 }));
    setPendingRows([
      quietRow(0, { id: 'e-old1', createdAt: new Date(Date.now() - 3 * 3600_000) }),
      quietRow(1, { id: 'e-old2', createdAt: new Date(Date.now() - 21 * 3600_000) }),
    ]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    const staleMark = (id: string) => mockPrisma.hookEvent.updateMany.mock.calls
      .map((c: any[]) => c[0])
      .find((u: any) => u?.where?.id === id && u?.data?.status === 'delivered')?.data?.payload?.suppressedAtDelivery;
    expect(staleMark('e-old1')).toBe('stale:3h');
    expect(staleMark('e-old2')).toBe('stale:21h');
  });

  it('C: a mixed group appends "N older completion(s) … were NOT shown" to the delivered wake so the supervisor knows it is partially blind', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 0 }));
    const staleAt = new Date(Date.now() - 5 * 3600_000);
    setPendingRows([
      quietRow(0, { id: 'e-stale', createdAt: staleAt, payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'day-old summary', depth: 0 } }),
      quietRow(1, { id: 'e-fresh', createdAt: new Date(), payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'just happened', depth: 0 } }),
    ]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('just happened');
    expect(prompt).not.toContain('day-old summary');
    expect(prompt).toContain(`1 older completion(s) [run_completed] emitted between ${staleAt.toISOString()} and ${staleAt.toISOString()} were NOT shown`);
    expect(prompt).toContain('partially blind');
  });

  it('C: the blind-spot line rides inside {{summary}}, so a CUSTOM template (child result-hook) carries it too', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 0, promptTemplate: 'CHILD {{eventType}}: {{summary}}' }));
    setPendingRows([
      quietRow(0, { id: 'e-stale', createdAt: new Date(Date.now() - 3 * 3600_000) }),
      quietRow(1, { id: 'e-fresh', createdAt: new Date() }),
    ]);
    await sweepHookEvents();
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt.startsWith('CHILD run_completed: completion 1')).toBe(true);
    expect(prompt).toContain('were NOT shown');
  });

  describe('coalesce — digest rendering (pure)', () => {
    it(`≤ DIGEST_COMPACT_THRESHOLD (${DIGEST_COMPACT_THRESHOLD}) quiet rows render exactly as before — full summaries, no digest header`, () => {
      const rows = Array.from({ length: DIGEST_COMPACT_THRESHOLD }, (_, i) => quietRow(i));
      const { summary, eventType } = coalesce(rows);
      expect(eventType).toBe('run_completed');
      // Hardening 2026-09-14: the header carries the chat id ("### title (chat <id>)").
      expect(summary.startsWith('### Source Chat (chat c-src)\n- [run_completed] completion 0\nsecond line of 0\n')).toBe(true);
      expect(summary).not.toContain('Coalesced digest');
    });

    it(`> DIGEST_COMPACT_THRESHOLD quiet rows: one compact line each with a UTC stamp, clipped at ${DIGEST_LINE_CHARS} chars`, () => {
      const long = 'x'.repeat(DIGEST_LINE_CHARS + 50);
      const rows = [
        ...Array.from({ length: DIGEST_COMPACT_THRESHOLD }, (_, i) => quietRow(i)),
        quietRow(99, { payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: long, depth: 0 } }),
      ];
      const { summary } = coalesce(rows);
      expect(summary).toContain(`Coalesced digest — ${rows.length} event(s) (${rows.length} quiet, 0 alarm) emitted `);
      expect(summary).toMatch(/- \[run_completed\] \d\d-\d\d \d\d:\d\dZ completion 0\n/);
      expect(summary).not.toContain('second line of');
      const longLine = summary.split('\n').find((l) => l.includes('xxxx'))!;
      expect(longLine.endsWith('…')).toBe(true);
      expect(longLine.length).toBeLessThan(DIGEST_LINE_CHARS + 40); // prefix + clipped body
    });

    it(`> DIGEST_MAX_LINES (${DIGEST_MAX_LINES}) quiet rows: the NEWEST ${DIGEST_MAX_LINES} are listed (creation order), the older tail collapses to "+N more … use list_chats"`, () => {
      const rows = Array.from({ length: DIGEST_MAX_LINES + 25 }, (_, i) => quietRow(i));
      const { summary } = coalesce(rows);
      const lines = summary.split('\n').filter((l) => l.startsWith('- [run_completed]'));
      expect(lines).toHaveLength(DIGEST_MAX_LINES);
      // Newest preferred: q25 … q64 shown, q0 … q24 omitted; still creation-ordered.
      expect(lines[0]).toContain('completion 25');
      expect(lines[lines.length - 1]).toContain(`completion ${DIGEST_MAX_LINES + 24}`);
      expect(summary).not.toMatch(/completion 24\b/);
      expect(summary).toContain('(+25 more older quiet event(s) not listed — oldest ' + rows[0].createdAt.toISOString());
      expect(summary).toContain('all are marked delivered. Use list_chats / get_chat_status');
    });

    it('alarm rows are VERBATIM and never trimmed away, even beyond the line cap', () => {
      const rows = [
        alarmRow({ id: 'a-old', createdAt: new Date(Date.now() - 999_000) }), // older than every quiet row
        ...Array.from({ length: DIGEST_MAX_LINES + 5 }, (_, i) => quietRow(i)),
      ];
      const { summary, eventType } = coalesce(rows);
      expect(eventType).toBe('multiple');
      expect(summary).toContain('- [run_failed] Run exploded\nstack line 1\nstack line 2');
      expect(summary).toContain(`(${DIGEST_MAX_LINES + 5} quiet, 1 alarm)`);
      expect(summary).toContain('(+5 more older quiet event(s) not listed');
    });

    it('a single row is untouched (no header, raw summary)', () => {
      expect(coalesce([quietRow(0)]).summary).toBe('completion 0\nsecond line of 0');
    });
  });
});

/* ====================================================================
 * Project-scope hooks (per-project supervisor lane, 2026-09-13):
 * sourceChatId NULL + projectId SET — only chats IN that project emit to it.
 * Deliberate plumbing: the project.supervised fleet opt-out does NOT filter
 * this lane (its lifecycle is the enabled flag + projectSupervisorEnabled).
 * ==================================================================== */
describe('emitHookEvent — project-scope hooks (per-project supervisor lane)', () => {
  const projectHook = (over: any = {}) =>
    hookRow({ id: 'h-proj', sourceChatId: null, projectId: 'p1', userId: 'u1', targetChatId: 'c-psup', ...over });
  const sourceInProject = (over: any = {}) =>
    ({ title: 'Source Chat', userId: 'u1', projectId: 'p1', project: { supervised: true }, ...over });

  it('receives an event from a chat IN its project', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([projectHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(sourceInProject());
    await emitHookEvent('c-src', 'run_completed', 'All good');

    const creates = mockPrisma.hookEvent.create.mock.calls.map((c: any[]) => c[0].data);
    expect(creates).toHaveLength(1);
    expect(creates[0].hookId).toBe('h-proj');
    expect(creates[0].payload).toMatchObject({ eventType: 'run_completed', sourceChatId: 'c-src' });
  });

  it('does NOT receive from a chat in a DIFFERENT project', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([projectHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(sourceInProject({ projectId: 'p2', project: { supervised: true } }));
    await emitHookEvent('c-src', 'run_completed', 'All good');
    expect(mockPrisma.hookEvent.create).not.toHaveBeenCalled();
  });

  it('does NOT receive from an UNGROUPED chat (projectId null)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([projectHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ title: 'Source Chat', userId: 'u1', projectId: null, project: null });
    await emitHookEvent('c-src', 'run_completed', 'All good');
    expect(mockPrisma.hookEvent.create).not.toHaveBeenCalled();
  });

  it('still fires when the project is fleet-UNSUPERVISED (deliberate plumbing) — the owner-scope wildcard in the SAME emission still skips', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      projectHook(),
      hookRow({ id: 'h-wild', sourceChatId: null, userId: 'u1', targetChatId: 'c-sup' }), // owner-scope wildcard (projectId absent)
    ]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(sourceInProject({ project: { supervised: false } }));
    await emitHookEvent('c-src', 'run_completed', 'All good');

    const creates = mockPrisma.hookEvent.create.mock.calls.map((c: any[]) => c[0].data);
    // The project-scope lane is wired deliberately — supervised:false does NOT
    // silence it; the automatic fleet wildcard keeps the c992d730 opt-out.
    expect(creates).toHaveLength(1);
    expect(creates[0].hookId).toBe('h-proj');
  });

  it('the wildcard SAME-OWNER filter applies to the project-scope lane too', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      projectHook({ id: 'h-foreign', userId: 'someone-else' }),
    ]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(sourceInProject());
    await emitHookEvent('c-src', 'run_completed', 'All good');
    expect(mockPrisma.hookEvent.create).not.toHaveBeenCalled();
  });

  it('an OWNER-SCOPE wildcard (projectId absent) is unaffected by the source chat\'s projectId (regression boundary)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hookRow({ id: 'h-wild', sourceChatId: null, userId: 'u1', targetChatId: 'c-sup' }),
    ]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(sourceInProject({ projectId: 'p9' }));
    await emitHookEvent('c-src', 'run_completed', 'All good');
    expect(mockPrisma.hookEvent.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.hookEvent.create.mock.calls[0][0].data.hookId).toBe('h-wild');
  });
});

describe('sweepHookEvents — project-scope hook delivery re-check', () => {
  const projectHookRow = (over: any = {}) =>
    hookRow({ id: 'h1', sourceChatId: null, projectId: 'p1', targetChatId: 'c-psup', ...over });

  it('drops an event whose source chat moved OUT of the project between emission and delivery — distinct log, hook survives', async () => {
    setPendingRows([
      eventRow({ id: 'e1', payload: { eventType: 'run_completed', sourceChatId: 'c-a', sourceChatTitle: 'A', summary: 'a done', depth: 0 } }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(projectHookRow());
    mockPrisma.crossModelChat.findUnique.mockImplementation(() => Promise.resolve({ userId: 'u1' })); // target ownership OK
    // c-a was in p1 at emission; it moved to p2 before the sweep delivered.
    mockPrisma.crossModelChat.findMany = jest.fn().mockResolvedValue([
      { id: 'c-a', userId: 'u1', projectId: 'p2', project: { supervised: true } },
    ]);

    await sweepHookEvents();

    expect(updatesWith((d) => d?.status === 'failed:source_gone')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(0);
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    // Pause-never-delete: the hook itself survives a moved chat.
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
    // The DISTINCT project-lane drop log (not the wildcard-lane phrasing).
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('project hook h1: dropped 1 event(s) (source left project/foreign)'),
    );
  });

  it('delivers the in-project source and drops a same-project FOREIGN-OWNER source (same-owner re-check)', async () => {
    setPendingRows([
      eventRow({ id: 'e1', payload: { eventType: 'run_completed', sourceChatId: 'c-a', sourceChatTitle: 'A', summary: 'a done', depth: 0 } }),
      eventRow({ id: 'e2', payload: { eventType: 'run_completed', sourceChatId: 'c-b', sourceChatTitle: 'B', summary: 'b done', depth: 0 } }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(projectHookRow());
    mockPrisma.crossModelChat.findUnique.mockImplementation(() => Promise.resolve({ userId: 'u1' }));
    // Both chats sit in p1 — but c-b belongs to a DIFFERENT user (a shared
    // project member's chat). Emission's same-owner filter normally prevents
    // this; the delivery re-check is the defense-in-depth.
    mockPrisma.crossModelChat.findMany = jest.fn().mockResolvedValue([
      { id: 'c-a', userId: 'u1', projectId: 'p1', project: { supervised: true } },
      { id: 'c-b', userId: 'someone-else', projectId: 'p1', project: { supervised: true } },
    ]);

    await sweepHookEvents();

    expect(updatesWith((d) => d?.status === 'failed:source_gone')[0]).toMatchObject({ where: { id: { in: ['e2'] } } });
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('a done');
    expect(prompt).not.toContain('b done');
  });

  it('project.supervised === false does NOT filter the project-scope lane at delivery either (deliberate plumbing)', async () => {
    setPendingRows([
      eventRow({ id: 'e1', payload: { eventType: 'run_completed', sourceChatId: 'c-a', sourceChatTitle: 'A', summary: 'a done', depth: 0 } }),
    ]);
    mockPrisma.eventHook.findUnique.mockResolvedValue(projectHookRow());
    mockPrisma.crossModelChat.findUnique.mockImplementation(() => Promise.resolve({ userId: 'u1' }));
    mockPrisma.crossModelChat.findMany = jest.fn().mockResolvedValue([
      { id: 'c-a', userId: 'u1', projectId: 'p1', project: { supervised: false } }, // fleet opt-out — irrelevant HERE
    ]);

    await sweepHookEvents();

    expect(updatesWith((d) => d?.status === 'failed')).toHaveLength(0);
    expect(updatesWith((d) => d?.status === 'delivered')[0]).toMatchObject({ where: { id: { in: ['e1'] } } });
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });
});

describe('subscribeHook — project-scope (internal per-project supervisor lane)', () => {
  const base = { userId: 'u1', sourceChatId: null, targetChatId: 'c-tgt', eventTypes: ['run_completed'] as string[] };

  it('creates a project-scoped wildcard hook: projectId stamped on the row, the view, and the audit', async () => {
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ userId: 'u1' });
    const r = await subscribeHook({ ...base, projectId: 'p1' });

    expect(mockPrisma.crossModelProject.findUnique).toHaveBeenCalledWith({
      where: { id: 'p1' },
      select: { userId: true },
    });
    const data = mockPrisma.eventHook.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: 'u1', sourceChatId: null, targetChatId: 'c-tgt', projectId: 'p1' });
    expect(r).toMatchObject({ sourceChatId: null, projectId: 'p1' });
    // Only the TARGET was access-checked (a wildcard has no single source).
    expect(mockGetChatAccess).toHaveBeenCalledTimes(1);
    expect(mockGetChatAccess).toHaveBeenCalledWith('c-tgt', 'u1');
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'hook.subscribe', resource: 'platform',
        metadata: expect.objectContaining({ projectId: 'p1', targetChatId: 'c-tgt' }),
      }),
    });
  });

  it('rejects projectId combined with an explicit sourceChatId (400 — project scope IS the wildcard)', async () => {
    await expect(subscribeHook({ ...base, sourceChatId: 'c-src', projectId: 'p1' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('projectId requires a wildcard hook') });
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelProject.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a foreign or missing project (404 — existence is not leaked); a DB hiccup fails closed the same way', async () => {
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ userId: 'someone-else' });
    await expect(subscribeHook({ ...base, projectId: 'p1' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('Project not found') });

    mockPrisma.crossModelProject.findUnique.mockResolvedValue(null);
    await expect(subscribeHook({ ...base, projectId: 'p1' }))
      .rejects.toMatchObject({ statusCode: 404 });

    mockPrisma.crossModelProject.findUnique.mockRejectedValue(new Error('db down'));
    await expect(subscribeHook({ ...base, projectId: 'p1' }))
      .rejects.toMatchObject({ statusCode: 404 });

    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
  });

  it('an omitted projectId stays the owner-scope wildcard (no project lookup, no projectId on the row)', async () => {
    await subscribeHook(base);
    expect(mockPrisma.crossModelProject.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.create.mock.calls[0][0].data).not.toHaveProperty('projectId');
  });
});

/* ====================================================================
 * Project-supervisor preflight 2026-09-14 — Fix 1: FLEET-FEED SHED at emission
 * ==================================================================== */
describe('emitHookEvent — fleet-feed shed (Project-supervisor preflight 2026-09-14, Fix 1)', () => {
  const projectHook = (over: any = {}) =>
    hookRow({ id: 'h-proj', sourceChatId: null, projectId: 'p1', userId: 'u1', targetChatId: 'c-psup', eventTypes: ['run_completed', 'todo_done', 'run_failed'], ...over });
  const fleetHook = (over: any = {}) =>
    hookRow({ id: 'h-wild', sourceChatId: null, userId: 'u1', targetChatId: 'c-sup', eventTypes: ['run_completed', 'run_failed', 'attention_needed', 'goal_blocked', 'schedule_cap_skipped', 'schedule_disabled'], ...over });
  const supervisedSource = (over: any = {}) =>
    ({ title: 'Lane', userId: 'u1', projectId: 'p1', project: { supervised: true, projectSupervisorEnabled: true }, ...over });
  const createdHookIds = () => mockPrisma.hookEvent.create.mock.calls.map((c: any[]) => c[0].data.hookId);

  it('pins the shed class: exactly run_completed + todo_done (alarm-class rows are never shed)', () => {
    expect([...FLEET_FEED_SHED_EVENT_TYPES].sort()).toEqual(['run_completed', 'todo_done']);
    for (const t of FLEET_FEED_SHED_EVENT_TYPES) expect(isAlarmEvent(t)).toBe(false);
  });

  it('SHEDS a quiet run_completed from the owner-scope wildcard when the project has an enabled project supervisor — the project-scope hook still gets it', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook(), projectHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisedSource());
    await emitHookEvent('c-src', 'run_completed', 'lane finished');

    expect(createdHookIds()).toEqual(['h-proj']); // fan-in: project supervisor only
  });

  describe('the project supervisor\'s OWN quiet completions are shed too (hardening 2026-09-14)', () => {
    // The source IS the project supervisor: its only project hook targets
    // itself (self-loop suppressed), so the old `hooks.some(... target !==
    // source)` clause was false and every supervisor wake — "WAKE: no-op"
    // included — re-entered the fleet digest the shed exists to shrink.
    const supervisorSource = (over: any = {}) => supervisedSource({ title: 'spark supervisor', isProjectSupervisor: true, ...over });

    it('run_completed FROM the project supervisor: NO row anywhere (project hook self-loops, wildcard shed)', async () => {
      mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook(), projectHook()]);
      mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisorSource());
      await emitHookEvent('c-psup', 'run_completed', 'Chat run completed. Answer: WAKE: no-op — nothing moved');
      expect(createdHookIds()).toEqual([]);
    });

    it('todo_done FROM the project supervisor is shed the same way', async () => {
      mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook({ eventTypes: ['todo_done'] }), projectHook()]);
      mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisorSource());
      await emitHookEvent('c-psup', 'todo_done', 'Todo done: x');
      expect(createdHookIds()).toEqual([]);
    });

    it('its ALARM-class rows (run_failed / attention_needed) still reach the fleet — the fleet repairs a dead project lane', async () => {
      for (const t of ['run_failed', 'attention_needed'] as const) {
        jest.clearAllMocks();
        mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook(), projectHook()]);
        mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisorSource());
        await emitHookEvent('c-psup', t, `alarm ${t}`);
        expect(createdHookIds()).toEqual(['h-wild']);
      }
    });

    it('audit 2026-10-06 T3-2(a): a PAUSED lane (projectSupervisorEnabled:false) — its supervisor\'s OWN quiet turns are shed from the fleet too; HOOK_FLEET_SHED_PS_ANY_TOGGLE_DISABLED=1 restores the old pass-through', async () => {
      mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook(), projectHook()]);
      mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisorSource({ project: { supervised: true, projectSupervisorEnabled: false } }));
      await emitHookEvent('c-psup', 'run_completed', 'lane finished');
      expect(createdHookIds()).toEqual([]);

      jest.clearAllMocks();
      process.env.HOOK_FLEET_SHED_PS_ANY_TOGGLE_DISABLED = '1';
      try {
        mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook(), projectHook()]);
        mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisorSource({ project: { supervised: true, projectSupervisorEnabled: false } }));
        await emitHookEvent('c-psup', 'run_completed', 'lane finished');
        expect(createdHookIds()).toEqual(['h-wild']);
      } finally {
        delete process.env.HOOK_FLEET_SHED_PS_ANY_TOGGLE_DISABLED;
      }
    });

    it('a chat that is NOT a project supervisor in a project with NO project hook is still never shed into a void (regression boundary)', async () => {
      mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook()]);
      mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisedSource({ isProjectSupervisor: false }));
      await emitHookEvent('c-src', 'run_completed', 'lane finished');
      expect(createdHookIds()).toEqual(['h-wild']);
    });
  });

  it('the shed never fires into a void under actor-echo suppression: a todo_done whose actor IS the project hook\'s target keeps the fleet row (hardening 2026-09-14)', async () => {
    // Supervisor c-psup closes worker c-src's todo. The project hook (target
    // c-psup) is actor-skipped, so the fleet wildcard must NOT be shed as if
    // the project supervisor had fanned the row in — nobody else would hear it.
    mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook({ eventTypes: ['todo_done'] }), projectHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisedSource());
    await emitHookEvent('c-src', 'todo_done', 'Todo done: x', { actorChatId: 'c-psup' });
    expect(createdHookIds()).toEqual(['h-wild']);
  });

  it('SHEDS todo_done the same way', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook({ eventTypes: ['todo_done'] }), projectHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisedSource());
    await emitHookEvent('c-src', 'todo_done', 'todo closed');
    expect(createdHookIds()).toEqual(['h-proj']);
  });

  it('ALARM-class events (run_failed / attention_needed / goal_blocked / schedule_disabled / schedule_cap_skipped) reach BOTH lanes — never shed', async () => {
    for (const t of ['run_failed', 'attention_needed', 'goal_blocked', 'schedule_disabled', 'schedule_cap_skipped'] as const) {
      jest.clearAllMocks();
      mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook(), projectHook({ eventTypes: [t] })]);
      mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisedSource());
      await emitHookEvent('c-src', t, `alarm ${t}`);
      expect(createdHookIds().sort()).toEqual(['h-proj', 'h-wild']);
    }
  });

  it('does NOT shed when projectSupervisorEnabled is false, even if a project-scope hook still exists (paused-lane row) — today\'s double delivery', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook(), projectHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisedSource({ project: { supervised: true, projectSupervisorEnabled: false } }));
    await emitHookEvent('c-src', 'run_completed', 'lane finished');
    expect(createdHookIds().sort()).toEqual(['h-proj', 'h-wild']);
  });

  it('does NOT shed when the flag is on but NO enabled project-scope hook receives the event (never sheds into a void)', async () => {
    // Only the fleet wildcard is in the fetched set — the project hook is disabled/missing.
    mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisedSource());
    await emitHookEvent('c-src', 'run_completed', 'lane finished');
    expect(createdHookIds()).toEqual(['h-wild']);
  });

  it('does NOT shed when the only project-scope hook belongs to a DIFFERENT project or a different owner', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      fleetHook(),
      projectHook({ id: 'h-other-proj', projectId: 'p2' }),
      projectHook({ id: 'h-foreign', userId: 'someone-else' }),
    ]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisedSource());
    await emitHookEvent('c-src', 'run_completed', 'lane finished');
    expect(createdHookIds()).toEqual(['h-wild']); // neither project hook matches; fleet keeps the row
  });

  it('does NOT shed for an UNGROUPED chat (no project) — regression boundary', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook(), projectHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ title: 'Lane', userId: 'u1', projectId: null, project: null });
    await emitHookEvent('c-src', 'run_completed', 'lane finished');
    expect(createdHookIds()).toEqual(['h-wild']);
  });

  it('DIRECT (specific-source) hooks are untouched by the shed — deliberate plumbing keeps firing', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      fleetHook(), projectHook(),
      hookRow({ id: 'h-direct', sourceChatId: 'c-src', userId: 'u1', targetChatId: 'c-parent' }),
    ]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisedSource());
    await emitHookEvent('c-src', 'run_completed', 'lane finished');
    expect(createdHookIds().sort()).toEqual(['h-direct', 'h-proj']);
  });

  it('the shed composes with the fleet opt-out: supervised:false already skips the wildcard, the project lane still fires (the opt-out skipped it first — that is not a shed)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook(), projectHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisedSource({ project: { supervised: false, projectSupervisorEnabled: true } }));
    await emitHookEvent('c-src', 'run_completed', 'lane finished');
    expect(createdHookIds()).toEqual(['h-proj']);
  });

  it('the source lookup selects projectSupervisorEnabled alongside supervised (the shed reads it)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([fleetHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supervisedSource());
    await emitHookEvent('c-src', 'run_completed', 'lane finished');
    expect(mockPrisma.crossModelChat.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ project: { select: { supervised: true, projectSupervisorEnabled: true } } }),
    }));
  });
});

/* ====================================================================
 * Hardening 2026-09-14 — ACTOR-ECHO SUPPRESSION at emission. todo_done emits
 * FROM the assignee (worker) so direct per-worker hooks keep firing; the chat
 * that PERFORMED the close rides as extra.actorChatId, and a hook whose
 * TARGET is that actor is skipped — a project supervisor closing a worker's
 * todo ("mark done what has landed") is no longer woken 600 s later to
 * re-audit its own close. Same class as the target==source self-loop line:
 * route-only, nothing refused, other targets still get the row.
 * ==================================================================== */
describe('emitHookEvent — actor-echo suppression (hardening 2026-09-14)', () => {
  const projectHook = (over: any = {}) =>
    hookRow({ id: 'h-proj', sourceChatId: null, projectId: 'p1', userId: 'u1', targetChatId: 'c-psup', eventTypes: ['todo_done'], ...over });
  const directHook = (over: any = {}) =>
    hookRow({ id: 'h-direct', sourceChatId: 'c-src', userId: 'u1', targetChatId: 'c-parent', eventTypes: ['todo_done'], ...over });
  const inProjectSource = { title: 'Worker task', userId: 'u1', projectId: 'p1', project: { supervised: true, projectSupervisorEnabled: true } };
  const createdHookIds = () => mockPrisma.hookEvent.create.mock.calls.map((c: any[]) => c[0].data.hookId);

  it('a hook whose target IS the actor gets NO row; a different-target hook on the same emission still does, and the payload never carries actorChatId', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([projectHook(), directHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(inProjectSource);
    await emitHookEvent('c-src', 'todo_done', 'Todo done: ship it', { actorChatId: 'c-psup' });
    expect(createdHookIds()).toEqual(['h-direct']);
    const payload = mockPrisma.hookEvent.create.mock.calls[0][0].data.payload;
    expect(payload).toEqual({ eventType: 'todo_done', sourceChatId: 'c-src', sourceChatTitle: 'Worker task', summary: 'Todo done: ship it', depth: 0 });
    expect(payload).not.toHaveProperty('actorChatId');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('actor-echo suppressed'));
  });

  it('NO actor (a user/UI or REST close) wakes exactly as before — the project supervisor hears the worker-finished signal', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([projectHook(), directHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(inProjectSource);
    await emitHookEvent('c-src', 'todo_done', 'Todo done: ship it');
    expect(createdHookIds().sort()).toEqual(['h-direct', 'h-proj']);
  });

  it('an actor that is NOT any hook\'s target (the fleet supervisor closing a worker todo) changes nothing — the project supervisor is still woken', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([projectHook(), directHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(inProjectSource);
    await emitHookEvent('c-src', 'todo_done', 'Todo done: ship it', { actorChatId: 'c-fleet-sup' });
    expect(createdHookIds().sort()).toEqual(['h-direct', 'h-proj']);
  });

  it('an actor equal to the SOURCE (a worker closing its own todo) is already covered by self-loop suppression — no double effect, other targets unchanged', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([projectHook(), directHook(), hookRow({ id: 'h-self', sourceChatId: null, userId: 'u1', targetChatId: 'c-src', eventTypes: ['todo_done'] })]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(inProjectSource);
    await emitHookEvent('c-src', 'todo_done', 'Todo done: ship it', { actorChatId: 'c-src' });
    expect(createdHookIds().sort()).toEqual(['h-direct', 'h-proj']);
  });

  it('a blank actorChatId is ignored (defensive — never suppresses on an empty string)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([projectHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(inProjectSource);
    await emitHookEvent('c-src', 'todo_done', 'Todo done: ship it', { actorChatId: '   ' });
    expect(createdHookIds()).toEqual(['h-proj']);
    expect(mockPrisma.hookEvent.create.mock.calls[0][0].data.payload).not.toHaveProperty('actorChatId');
  });
});

/* ====================================================================
 * Project-supervisor preflight 2026-09-14 — Fix 5b: the 2026-09-13 window
 * drain + digest applies to PROJECT-SCOPE hooks exactly as to owner-scope
 * wildcards (drainWindowBacklog is keyed on hookId only; coalesce is pure).
 * ==================================================================== */
describe('sweepHookEvents — window drain + digest on a PROJECT-SCOPE hook (Project-supervisor preflight 2026-09-14, Fix 5b)', () => {
  const projectHookRow = (over: any = {}) =>
    hookRow({ id: 'h1', sourceChatId: null, projectId: 'p1', targetChatId: 'c-psup', debounceSec: 600, ...over });
  const quietRow = (i: number, src: string = 'c-a') => eventRow({
    id: `q${i}`,
    createdAt: new Date(Date.now() - (1000 - i) * 1000),
    payload: { eventType: 'run_completed', sourceChatId: src, sourceChatTitle: `Lane ${src}`, summary: `completion ${i}\nsecond line ${i}`, depth: 0 },
  });

  beforeEach(() => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(projectHookRow());
    mockPrisma.crossModelChat.findUnique.mockImplementation(() => Promise.resolve({ userId: 'u1' })); // target ownership OK
    mockPrisma.crossModelChat.findMany = jest.fn().mockResolvedValue([
      { id: 'c-a', userId: 'u1', projectId: 'p1', project: { supervised: true } },
      { id: 'c-b', userId: 'u1', projectId: 'p1', project: { supervised: true } },
    ]);
    // The claim (UPDATE…RETURNING) hands back exactly the ids it was given —
    // fair-batch rows PLUS the drained backlog.
    mockPrisma.$queryRaw.mockImplementation(async (_strings: TemplateStringsArray, ...vals: any[]) => {
      const joined: string[] = vals.find((v) => v && Array.isArray(v.values))?.values ?? [];
      const all = [...(await mockPrisma.hookEvent.findMany({})), ...(await mockPrisma.hookEvent.findMany({ where: { hookId: 'h1' } }))];
      const byId = new Map<string, any>();
      for (const r of all) if (joined.includes(r.id) && !byId.has(r.id)) byId.set(r.id, r);
      return [...byId.values()];
    });
  });

  it('drains the project hook\'s whole deliverable backlog into ONE digest wake — every row claimed + delivered, wake_delivered reports the drain', async () => {
    const fair = Array.from({ length: SWEEP_PER_HOOK_CAP }, (_, i) => quietRow(i, i % 2 ? 'c-a' : 'c-b'));
    const backlog = Array.from({ length: 12 }, (_, i) => quietRow(SWEEP_PER_HOOK_CAP + i, 'c-a'));
    setPendingRows(fair, [], backlog);

    await sweepHookEvents();

    // The drain read is scoped to THIS (project-scope) hook — same shape as the wildcard's.
    const drainRead = mockPrisma.hookEvent.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.hookId && a?.take);
    expect(drainRead).toMatchObject({ where: { hookId: 'h1', status: 'pending' }, orderBy: { createdAt: 'desc' }, take: WINDOW_DRAIN_CAP });
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1); // ONE wake for 22 rows
    expect(mockFireScheduleTarget.mock.calls[0][0]).toMatchObject({ sessionId: 'c-psup', origin: 'hook' });
    const delivered = updatesWith((d) => d?.status === 'delivered')[0];
    expect(delivered.where.id.in).toHaveLength(22);
    expect(delivered.where.id.in).toEqual(expect.arrayContaining([...fair, ...backlog].map((r) => r.id)));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'wake_delivered', sessionId: 'c-psup', value: 22, meta: expect.objectContaining({ drained: 12, hookId: 'h1' }),
    }));
    // Digest rendering (22 > threshold): compact lines, per-source headers, nothing lost.
    const prompt = mockFireScheduleTarget.mock.calls[0][0].prompt;
    expect(prompt).toContain('Coalesced digest — 22 event(s) (22 quiet, 0 alarm)');
    expect(prompt).toContain('### Lane c-a (chat c-a)'); // hardening 2026-09-14: id in every header
    expect(prompt).toContain('### Lane c-b (chat c-b)');
    expect(prompt).toContain('Source chat id: multiple (see per-source headers)');
    expect(prompt).toContain('completion 21');
    expect(prompt).not.toContain('second line'); // compact = first line only
    expect(prompt).not.toContain('NOT shown');
    // No project-lane drop: every source is still in p1 and same-owner.
    expect(updatesWith((d) => d?.status === 'failed')).toHaveLength(0);
  });

  it('the drain respects the project-scope delivery re-check: a drained row whose source left the project is dropped, the rest ship as one digest', async () => {
    mockPrisma.crossModelChat.findMany = jest.fn().mockResolvedValue([
      { id: 'c-a', userId: 'u1', projectId: 'p1', project: { supervised: true } },
      { id: 'c-moved', userId: 'u1', projectId: 'p2', project: { supervised: true } }, // moved out of p1 after emission
    ]);
    const fair = Array.from({ length: 3 }, (_, i) => quietRow(i, 'c-a'));
    const backlog = [...Array.from({ length: 10 }, (_, i) => quietRow(3 + i, 'c-a')), quietRow(50, 'c-moved')];
    setPendingRows(fair, [], backlog);

    await sweepHookEvents();

    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(updatesWith((d) => d?.status === 'failed:source_gone')[0]).toMatchObject({ where: { id: { in: ['q50'] } } });
    const delivered = updatesWith((d) => d?.status === 'delivered')[0];
    expect(delivered.where.id.in).toHaveLength(13);
    expect(delivered.where.id.in).not.toContain('q50');
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled(); // pause-never-delete
  });

  it('a project hook inside its debounce window keeps its rows pending (coalesce for the next window) — same contract as the wildcard', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(projectHookRow({ lastFiredAt: new Date(Date.now() - 60_000) })); // fired 1 min ago, window 600s
    setPendingRows([quietRow(0), quietRow(1)], [], [quietRow(2)]);

    await sweepHookEvents();

    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled(); // never claimed
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(0);
  });
});

describe('instant delivery (owner 2026-09-14: "make hooks instant — no idle time")', () => {
  const flushImmediates = () => new Promise((r) => setImmediate(r));
  beforeEach(() => {
    mockPrisma.hookEvent.findMany.mockReset().mockResolvedValue([]);
    mockPrisma.hookEvent.updateMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it('a targeted sweep by hookIds scans ONLY those hooks and skips the poll-path housekeeping', async () => {
    await sweepHookEvents({ hookIds: ['h1', 'h2'] });
    expect(mockPrisma.hookEvent.updateMany).not.toHaveBeenCalled(); // no stale-delivering reclaim / disabled-hook pass
    const where = mockPrisma.hookEvent.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: 'pending', hookId: { in: ['h1', 'h2'] }, hook: { enabled: true } });
    expect(where.OR).toBeDefined(); // the retryAt filter still applies — a busy-parked row waits for its target
  });

  it('a run-finalize drain by targetChatId includes busy-parked rows (ignoreRetryAt) — the target is idle NOW', async () => {
    await sweepHookEvents({ targetChatId: 'c-sup', ignoreRetryAt: true });
    const where = mockPrisma.hookEvent.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: 'pending', hook: { enabled: true, targetChatId: 'c-sup' } });
    expect(where.OR).toBeUndefined();
    expect(where.hookId).toBeUndefined();
  });

  it('the untargeted poll still runs housekeeping and the retryAt filter (unchanged contract)', async () => {
    await sweepHookEvents();
    expect(mockPrisma.hookEvent.updateMany).toHaveBeenCalled();
    // The poll path's first findMany is the (a3) retry-horizon pass; the scan is the last call.
    const where = mockPrisma.hookEvent.findMany.mock.calls.at(-1)[0].where;
    expect(where.OR).toBeDefined();
    expect(where.hookId).toBeUndefined();
  });

  it('emitHookEvent kicks a targeted sweep for exactly the hooks it wrote (push, not poll)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow(), hookRow({ id: 'h2', targetChatId: 'c-tgt2' })]);
    await emitHookEvent('c-src', 'run_completed', 'All good');
    await flushImmediates();
    const scan = mockPrisma.hookEvent.findMany.mock.calls.find((c: any[]) => c[0]?.where?.hookId);
    expect(scan).toBeDefined();
    expect(scan[0].where.hookId).toEqual({ in: ['h1', 'h2'] });
  });

  it('drainHookEventsForTarget schedules the ignoreRetryAt drain for that chat', async () => {
    drainHookEventsForTarget('c-sup');
    await flushImmediates();
    const where = mockPrisma.hookEvent.findMany.mock.calls[0][0].where;
    expect(where.hook).toEqual({ enabled: true, targetChatId: 'c-sup' });
    expect(where.OR).toBeUndefined();
  });
});

describe('run-finalize fairness — oldestPendingHookAgeMs (owner 2026-09-14: the fleet backlog starved behind queued lane messages)', () => {
  beforeEach(() => { mockPrisma.hookEvent.findFirst.mockReset().mockResolvedValue(null); });

  it('reads the OLDEST pending row targeting the chat via the enabled-hook relation', async () => {
    const now = new Date('2026-09-14T12:50:00Z');
    mockPrisma.hookEvent.findFirst.mockResolvedValue({ createdAt: new Date('2026-09-14T11:10:32Z') });
    const age = await oldestPendingHookAgeMs('c-sup', now);
    expect(mockPrisma.hookEvent.findFirst).toHaveBeenCalledWith({
      where: { status: { in: ['pending', 'delivering'] }, hook: { targetChatId: 'c-sup', enabled: true } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    expect(age).toBe(now.getTime() - new Date('2026-09-14T11:10:32Z').getTime());
    expect(age).toBeGreaterThan(HOOK_STARVATION_MS);
  });

  it('no pending rows → 0 (queue-first default); a DB error also → 0 (fail toward the default, never toward starving the queue)', async () => {
    expect(await oldestPendingHookAgeMs('c-sup')).toBe(0);
    mockPrisma.hookEvent.findFirst.mockRejectedValue(new Error('down'));
    expect(await oldestPendingHookAgeMs('c-sup')).toBe(0);
  });

  it('the starvation threshold is 5 minutes', () => {
    expect(HOOK_STARVATION_MS).toBe(5 * 60 * 1000);
  });
});

describe('hook-starvation yield window + retiring-colour un-park (autonomy loop #11, 2026-09-20; deliverability-aware #12)', () => {
  beforeEach(() => {
    mockPrisma.hookEvent.findMany.mockReset().mockResolvedValue([]);
    mockPrisma.hookEvent.updateMany.mockReset().mockResolvedValue({ count: 1 });
  });
  const now = new Date('2026-09-20T14:25:00Z');
  const min = (m: number) => new Date(now.getTime() - m * 60_000);
  /** pending rows for the target, oldest first; each with its hook's debounce state */
  const rows = (...specs: Array<{ ageMin: number; eventType?: string; debounceSec?: number; lastFiredMinAgo?: number | null; payload?: any }>) =>
    mockPrisma.hookEvent.findMany.mockResolvedValue(specs.map((sp) => ({
      createdAt: min(sp.ageMin), eventType: sp.eventType ?? 'run_completed', payload: sp.payload ?? {},
      hook: { debounceSec: sp.debounceSec ?? 0, lastFiredAt: sp.lastFiredMinAgo == null ? null : min(sp.lastFiredMinAgo) },
    })));

  it('hookBacklogStarving: true only inside [HOOK_STARVATION_MS, HOOK_STARVATION_YIELD_MAX_MS] — a 27-min backlog yields, a 2-min one does not, a 50-min one is stuck for another reason and the queue proceeds', async () => {
    rows({ ageMin: 27 }); expect(await hookBacklogStarving('c-sup', now)).toBe(true);
    rows({ ageMin: 5 });  expect(await hookBacklogStarving('c-sup', now)).toBe(true);
    rows({ ageMin: 2 });  expect(await hookBacklogStarving('c-sup', now)).toBe(false);
    rows({ ageMin: 50 }); expect(await hookBacklogStarving('c-sup', now)).toBe(false);
    expect(HOOK_STARVATION_YIELD_MAX_MS).toBe(45 * 60 * 1000);
    mockPrisma.hookEvent.findMany.mockResolvedValue([]);
    expect(await hookBacklogStarving('c-sup', now)).toBe(false);
    expect(mockPrisma.hookEvent.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { status: { in: ['pending', 'delivering'] }, hook: { targetChatId: 'c-sup', enabled: true } }, // loop #17: in-flight rows count
      orderBy: { createdAt: 'asc' },
    }));
  });

  it('deliverability (loop #12 — the Fleet Supervisor 600 s debounce): a starving backlog whose only hook is INSIDE its debounce window is NOT deliverable now → no yield (the queue drains); once the window has passed, or a row is alarm-class, it yields', async () => {
    // Quiet rows, hook fired 4 min ago with a 10-min debounce → nothing can fire now.
    rows({ ageMin: 12, debounceSec: 600, lastFiredMinAgo: 4 }, { ageMin: 8, debounceSec: 600, lastFiredMinAgo: 4 });
    expect(await hookBacklogStarving('c-fleet', now)).toBe(false);
    // Window passed (fired 11 min ago) → deliverable → yield.
    rows({ ageMin: 12, debounceSec: 600, lastFiredMinAgo: 11 });
    expect(await hookBacklogStarving('c-fleet', now)).toBe(true);
    // Never fired → deliverable.
    rows({ ageMin: 12, debounceSec: 600, lastFiredMinAgo: null });
    expect(await hookBacklogStarving('c-fleet', now)).toBe(true);
    // Inside the window but an ALARM-class row rides the batch → alarms bypass the debounce → yield.
    rows({ ageMin: 12, debounceSec: 600, lastFiredMinAgo: 4 }, { ageMin: 6, eventType: 'run_failed', debounceSec: 600, lastFiredMinAgo: 4 });
    expect(await hookBacklogStarving('c-fleet', now)).toBe(true);
    // A schedule_disabled row WITH a successor is not alarm-class → still held by the window.
    rows({ ageMin: 12, debounceSec: 600, lastFiredMinAgo: 4 }, { ageMin: 6, eventType: 'schedule_disabled', payload: { successorId: 'x' }, debounceSec: 600, lastFiredMinAgo: 4 });
    expect(await hookBacklogStarving('c-fleet', now)).toBe(false);
  });

  it('an empty target → false; a DB error → false (the queue drains)', async () => {
    expect(await hookBacklogStarving('', now)).toBe(false);
    mockPrisma.hookEvent.findMany.mockRejectedValue(new Error('down'));
    expect(await hookBacklogStarving('c-sup', now)).toBe(false);
  });

  it('unparkHookEventsForTarget clears retryAt on the chat\'s parked pending rows via the enabled-hook relation and returns the count; a DB error → 0', async () => {
    mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 8 });
    expect(await unparkHookEventsForTarget('c-sup')).toBe(8);
    expect(mockPrisma.hookEvent.updateMany).toHaveBeenCalledWith({
      where: { status: 'pending', retryAt: { not: null }, hook: { targetChatId: 'c-sup', enabled: true } },
      data: { retryAt: null },
    });
    mockPrisma.hookEvent.updateMany.mockRejectedValue(new Error('down'));
    expect(await unparkHookEventsForTarget('c-sup')).toBe(0);
    expect(await unparkHookEventsForTarget('')).toBe(0);
  });
});

describe('queue fairness — hooksFirstVerdict (autonomy loop #15, 2026-09-21: the Fleet Supervisor queue held 20 rows for 3.8 h behind a perpetually "starving" hook backlog)', () => {
  const now = new Date('2026-09-21T04:00:00Z');
  const min = (m: number) => new Date(now.getTime() - m * 60_000);
  const rows = (...ageMins: number[]) =>
    mockPrisma.hookEvent.findMany.mockResolvedValue(ageMins.map((m) => ({
      createdAt: min(m), eventType: 'run_completed', payload: {}, hook: { debounceSec: 0, lastFiredAt: null },
    })));
  beforeEach(() => {
    mockPrisma.hookEvent.findMany.mockReset().mockResolvedValue([]);
  });

  it('hooks go first only when their oldest deliverable row has waited at least as long as the queue head', async () => {
    rows(12);
    expect(await hooksFirstVerdict('c-fleet', { ageMs: 3 * 60_000, source: 'agent' }, now)).toMatchObject({ hooksFirst: true, reason: 'hooks_first', hookAgeMs: 12 * 60_000, queueHeadAgeMs: 3 * 60_000 });
    expect(await hooksFirstVerdict('c-fleet', { ageMs: 228 * 60_000, source: 'schedule' }, now)).toMatchObject({ hooksFirst: false, reason: 'queue_older' });
    expect(await hooksFirstVerdict('c-fleet', { ageMs: 12 * 60_000, source: 'agent' }, now)).toMatchObject({ hooksFirst: true, reason: 'hooks_first' }); // tie → hooks
    expect(await hooksFirstVerdict('c-fleet', undefined, now)).toMatchObject({ hooksFirst: true, reason: 'hooks_first', queueHeadAgeMs: 0 }); // empty queue
  });

  it('a waiting USER row always drains first, regardless of ages', async () => {
    rows(40);
    expect(await hooksFirstVerdict('c-fleet', { ageMs: 60_000, source: 'user' }, now)).toMatchObject({ hooksFirst: false, reason: 'user_waiting' });
  });

  it('young (< 5 min), stuck (> 45 min), undeliverable and empty backlogs never block the queue — reasons named', async () => {
    rows(2);  expect(await hooksFirstVerdict('c-fleet', { ageMs: 0, source: null }, now)).toMatchObject({ hooksFirst: false, reason: 'young' });
    rows(50); expect(await hooksFirstVerdict('c-fleet', { ageMs: 0, source: null }, now)).toMatchObject({ hooksFirst: false, reason: 'stuck' });
    mockPrisma.hookEvent.findMany.mockResolvedValue([{ createdAt: min(12), eventType: 'run_completed', payload: {}, hook: { debounceSec: 600, lastFiredAt: min(4) } }]);
    expect(await hooksFirstVerdict('c-fleet', { ageMs: 0, source: null }, now)).toMatchObject({ hooksFirst: false, reason: 'undeliverable' });
    mockPrisma.hookEvent.findMany.mockResolvedValue([]);
    expect(await hooksFirstVerdict('c-fleet', { ageMs: 999_999, source: 'agent' }, now)).toMatchObject({ hooksFirst: false, reason: 'no_hooks' });
    mockPrisma.hookEvent.findMany.mockRejectedValueOnce(new Error('db'));
    expect(await hooksFirstVerdict('c-fleet', { ageMs: 0, source: null }, now)).toMatchObject({ hooksFirst: false, reason: 'error' });
  });

  it("hookBacklogStarving accepts the caller's queue head (drainChatQueue passes its own row's wait)", async () => {
    rows(12);
    expect(await hookBacklogStarving('c-fleet', now)).toBe(true);
    expect(await hookBacklogStarving('c-fleet', now, { ageMs: 30 * 60_000, source: 'agent' })).toBe(false);
    expect(await hookBacklogStarving('c-fleet', now, { ageMs: 60_000, source: 'agent' })).toBe(true);
  });
});

describe('finalize hooks-first hardening (autonomy loop #17, 2026-09-21: five alarm rows re-parked for 85 min behind agent report-ups)', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const min = (m: number) => new Date(now.getTime() - m * 60_000);
  const rows = (...ageMins: number[]) =>
    mockPrisma.hookEvent.findMany.mockResolvedValue(ageMins.map((m) => ({
      createdAt: min(m), eventType: 'schedule_disabled', payload: { reason: 'cancelled' }, hook: { debounceSec: 600, lastFiredAt: min(100) },
    })));
  beforeEach(() => {
    mockPrisma.hookEvent.findMany.mockReset().mockResolvedValue([]);
  });

  it("the verdict's backlog scan counts rows a sweep has already claimed ('delivering') — a wake about to start is a backlog, not an empty one", async () => {
    rows(12);
    await hooksFirstVerdict('c-fleet', { ageMs: 60_000, source: 'agent' }, now);
    expect(mockPrisma.hookEvent.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { status: { in: ['pending', 'delivering'] }, hook: { targetChatId: 'c-fleet', enabled: true } },
    }));
  });

  it('capMs: the finalize passes Infinity so an 85-min deliverable alarm backlog is still hooks-first there; the entrants keep the 45-min stuck cap', async () => {
    rows(85);
    expect(await hooksFirstVerdict('c-fleet', { ageMs: 60_000, source: 'agent' }, now)).toMatchObject({ hooksFirst: false, reason: 'stuck' });
    expect(await hooksFirstVerdict('c-fleet', { ageMs: 60_000, source: 'agent' }, now, { capMs: Number.POSITIVE_INFINITY })).toMatchObject({ hooksFirst: true, reason: 'hooks_first', hookAgeMs: 85 * 60_000 });
    expect(await hooksFirstVerdict('c-fleet', { ageMs: 90 * 60_000, source: 'agent' }, now, { capMs: Number.POSITIVE_INFINITY })).toMatchObject({ hooksFirst: false, reason: 'queue_older' });
    expect(await hookBacklogStarving('c-fleet', now, { ageMs: 60_000, source: 'agent' })).toBe(false); // entrant path: stuck
  });

  it('drainHookEventsForTargetNow AWAITS the targeted sweep and reports whether a wake was delivered', async () => {
    (mockPrisma.hookEvent as any).count = jest.fn(async () => 1);
    mockPrisma.hookEvent.findMany.mockResolvedValue([]); // the sweep scan finds nothing to claim in this harness
    expect(await drainHookEventsForTargetNow('c-fleet')).toBe(true);
    expect((mockPrisma.hookEvent as any).count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'delivered', hook: { targetChatId: 'c-fleet' } }) }));
    (mockPrisma.hookEvent as any).count = jest.fn(async () => 0);
    expect(await drainHookEventsForTargetNow('c-fleet')).toBe(false);
    expect(await drainHookEventsForTargetNow('')).toBe(false);
  });
});

describe('sibling drain (hardening loop 2026-09-24): a wildcard wake carries the other hooks\' pending rows for the same target', () => {
  const quietRow = (i: number, over: any = {}) => eventRow({
    id: `q${i}`,
    createdAt: new Date(Date.now() - (1000 - i) * 1000),
    payload: { eventType: 'run_completed', sourceChatId: 'c-a', sourceChatTitle: 'Source Chat', summary: `completion ${i}`, depth: 0 },
    ...over,
  });
  const wildcard = () => hookRow({ id: 'hw', sourceChatId: null, targetChatId: 'c-sup', debounceSec: 0 });
  const sibRow = (i: number, hookId = 'h2', tmpl = '') => ({
    ...quietRow(100 + i), id: `sib-${i}`, hookId, payload: { ...quietRow(100 + i).payload, sourceChatId: 'c-a' }, hook: { id: hookId, promptTemplate: tmpl },
  });
  beforeEach(() => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(wildcard());
    mockPrisma.crossModelChat.findMany = jest.fn().mockResolvedValue([{ id: 'c-a', userId: 'u1', projectId: null, project: null }]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', archivedAt: null, isSupervisor: true, isProjectSupervisor: false, codingState: null });
    mockPrisma.eventHook.updateMany = jest.fn(async () => ({ count: 1 }));
  });

  it('merges sibling rows into ONE wake, delivers them, resets the sibling hooks\' debounce and records hook_sibling_drain', async () => {
    const own = [{ ...quietRow(0), hookId: 'hw', payload: { ...quietRow(0).payload, sourceChatId: 'c-a' } }];
    const sibs = [sibRow(1), sibRow(2), sibRow(3, 'h3')];
    setPendingRows(own, [], [], sibs);
    mockPrisma.$queryRaw.mockImplementation(async () => [...own, ...sibs]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const delivered = updatesWith((d) => d?.status === 'delivered')[0];
    expect(delivered.where.id.in).toEqual(expect.arrayContaining(['sib-1', 'sib-2', 'sib-3', own[0].id]));
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: expect.arrayContaining(['h2', 'h3']) } } }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hook_sibling_drain', value: 3, meta: expect.objectContaining({ siblingHooks: 2 }) }));
  });

  it('skips child-result-template siblings and rows without a source id; a NON-wildcard firing hook drains nothing', async () => {
    const own = [{ ...quietRow(0), hookId: 'hw', payload: { ...quietRow(0).payload, sourceChatId: 'c-a' } }];
    const childTmpl = CHILD_RESULT_PROMPT_TEMPLATE;
    const sibs = [sibRow(1, 'h2', childTmpl), { ...sibRow(2), payload: { ...sibRow(2).payload, sourceChatId: undefined } }, sibRow(3, 'h4')];
    setPendingRows(own, [], [], sibs);
    mockPrisma.$queryRaw.mockImplementation(async () => [...own, sibs[2]]);
    await sweepHookEvents();
    const delivered = updatesWith((d) => d?.status === 'delivered')[0];
    expect(delivered.where.id.in).toEqual(expect.arrayContaining([own[0].id, 'sib-3']));
    expect(delivered.where.id.in).not.toEqual(expect.arrayContaining(['sib-1']));
    expect(delivered.where.id.in).not.toEqual(expect.arrayContaining(['sib-2']));

    jest.clearAllMocks();
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ id: 'hs', sourceChatId: 'c-a', targetChatId: 'c-sup', debounceSec: 0 }));
    mockPrisma.eventHook.updateMany = jest.fn(async () => ({ count: 1 }));
    setPendingRows(own.map(r => ({ ...r, hookId: 'hs' })), [], [], sibs);
    mockPrisma.$queryRaw.mockImplementation(async () => own.map(r => ({ ...r, hookId: 'hs' })));
    await sweepHookEvents();
    expect(mockPrisma.eventHook.updateMany).not.toHaveBeenCalled();
  });

  // FO firing 17 (2026-09-24): the exclusion predicate was EXACT equality with
  // the CURRENT template, but the template changed on 2026-09-14 (62173bd6e,
  // chat-id parenthetical) while 34 enabled prod hooks still carry the
  // PRE-change string — all createdVia NULL (pre-provenance), e.g. six on the
  // Fleet Supervisor's target. Their parent-contract rows would have merged
  // into a fleet digest wake. Both generations must be excluded.
  it('skips LEGACY child-result-template siblings too (pre-2026-09-14 template, 34 live prod hooks)', async () => {
    const own = [{ ...quietRow(0), hookId: 'hw', payload: { ...quietRow(0).payload, sourceChatId: 'c-a' } }];
    const legacyChild = LEGACY_CHILD_RESULT_PROMPT_TEMPLATE;
    const drainable = sibRow(5, 'h4');
    const sibs = [sibRow(4, 'h2', legacyChild), drainable];
    setPendingRows(own, [], [], sibs);
    mockPrisma.$queryRaw.mockImplementation(async () => [...own, drainable]);
    await sweepHookEvents();
    const delivered = updatesWith((d) => d?.status === 'delivered')[0];
    expect(delivered.where.id.in).toEqual(expect.arrayContaining([own[0].id, 'sib-5']));
    expect(delivered.where.id.in).not.toEqual(expect.arrayContaining(['sib-4']));
  });

  it('isChildResultTemplate / isChildResultHookSignature match BOTH template generations (9df506cc F1 legacy exemption)', () => {
    expect(isChildResultTemplate(CHILD_RESULT_PROMPT_TEMPLATE)).toBe(true);
    expect(isChildResultTemplate(LEGACY_CHILD_RESULT_PROMPT_TEMPLATE)).toBe(true);
    expect(isChildResultTemplate('Fleet event from chat "{{sourceChatTitle}}" ({{eventType}}): {{summary}}. React as the fleet')).toBe(false);
    expect(isChildResultTemplate('')).toBe(false);
    expect(isChildResultTemplate(null)).toBe(false);
    // F1 (ticket 9df506cc): legacy child-result hooks — createdVia NULL, old
    // template, terminal/attention event set — are exactly the rows the
    // retired-target exemption exists to protect.
    const legacyHook = { promptTemplate: LEGACY_CHILD_RESULT_PROMPT_TEMPLATE, eventTypes: [...CHILD_RESULT_EVENT_TYPES], createdVia: null };
    expect(isChildResultHookSignature(legacyHook)).toBe(true);
    expect(isChildResultHookSignature({ ...legacyHook, promptTemplate: CHILD_RESULT_PROMPT_TEMPLATE })).toBe(true);
    // A user-NARROWED variant keeps the template but not the full event set —
    // NOT exempt (covered by the ensureChildResultHook self-heal instead).
    expect(isChildResultHookSignature({ ...legacyHook, eventTypes: ['run_completed'] })).toBe(false);
    // A same-shape but foreign template is never a child-result hook.
    expect(isChildResultHookSignature({ ...legacyHook, promptTemplate: 'Fleet event from chat "{{sourceChatTitle}}" ({{eventType}}): {{summary}}. React as the fleet' })).toBe(false);
  });
});

/* ====================================================================
 * E7 (2026-09-25) — wake-triage REQUEST v2: code-computed state + a
 * five-question fan-out, the batch-property nouls labelled at decision
 * time, every run-labelled question closed on a non-started wake, and
 * the kill switch restoring the v1 request byte-for-byte. Delivery and the
 * act contract are untouched (the WI-C block above still passes as-is).
 * ==================================================================== */
describe('E7 wake-triage request v2 (shadow)', () => {
  const V2_GATE = {
    id: 'wt2', mode: 'shadow', backend: 'TypeSafe Jev', ms: 8,
    answers: {
      needs_turn_now: { type: 'noul', noul: 0.06 },
      disposition: { type: 'choice', choice: 'ack', probabilities: { ack: 0.9, coalesce: 0.05, act_now: 0.03, escalate_owner: 0.02 }, confidence: 0.9 },
      addressed_to_supervisor: { type: 'noul', noul: 0.8 },
      contains_failure_or_block: { type: 'noul', noul: 0.1 },
      urgency: { type: 'score', score: 0.5, probabilities: { '0': 0.5, '1': 0.5, '2': 0, '3': 0 }, confidence: 0.5 },
    },
  };
  beforeEach(() => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 0 }));
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', title: 'Target', isSupervisor: true });
    mockDecisionMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(V2_GATE);
    mockFireScheduleTarget.mockResolvedValue({ started: true, decisionDeferred: true });
  });
  afterEach(() => {
    mockDecisionMode.mockReturnValue('off');
    mockDecide.mockResolvedValue(null);
  });

  it('sends the v2 state (event kinds, flags, lanes — fail-open null facts when the lane tables are unreachable — prose LAST) and the five questions; the two batch-property nouls close at decision time from the code flags', async () => {
    setPendingRows([eventRow({ id: 'e1', payload: { eventType: 'run_completed', sourceChatId: 'c-src', sourceChatTitle: 'Source Chat', summary: 'Please approve the merge of #12?', depth: 0 } })]);
    await sweepHookEvents();
    expect(mockDecide).toHaveBeenCalledTimes(1);
    const [state, questions, opts] = mockDecide.mock.calls[0];
    expect(opts).toMatchObject({ purpose: 'wake_triage', sessionId: 'c-tgt' });
    expect(Object.keys(questions)).toEqual(['needs_turn_now', 'disposition', 'addressed_to_supervisor', 'contains_failure_or_block', 'urgency']);
    expect(state).toMatchObject({
      target: 'fleet supervisor chat', events: 1, event_type: 'run_completed',
      event_kinds: { run_completed: 1 }, any_row_is_question_or_request: true, any_row_reports_failure_or_block: false, distinct_sources: 1,
      // the unit-test prisma has no chatCodingState / agentRun tables → per-lane reads fail open to nulls
      source_lanes: [{ chat_id: 'c-src', coding_status: null, last_run: null }],
      summary: 'Please approve the merge of #12?',
    });
    const keys = Object.keys(state);
    expect(keys[keys.length - 1]).toBe('summary');
    // decision-time labels for the batch-property nouls (code flags), nothing else yet — the run labels the rest
    expect(mockRecordDecisionOutcome).toHaveBeenCalledTimes(2);
    expect(mockRecordDecisionOutcome.mock.calls[0][2]).toMatchObject({ question: 'addressed_to_supervisor', actual: true, acted: false, sessionId: 'c-tgt', note: 'decision-time code flag' });
    expect(mockRecordDecisionOutcome.mock.calls[1][2]).toMatchObject({ question: 'contains_failure_or_block', actual: false, acted: false });
    // the stash rides the wake exactly as before
    expect(mockFireScheduleTarget.mock.calls[0][0].decision).toMatchObject({ id: 'wt2', purpose: 'wake_triage', answers: { disposition: { choice: 'ack' } } });
    expect(updatesWith((d) => d?.status === 'delivered')).toHaveLength(1);
  });

  it('a BUSY target closes EVERY run-labelled question the v2 decision answered (needs_turn_now, disposition, urgency), unlabelled', async () => {
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    setPendingRows([eventRow({ id: 'e1' })]);
    await sweepHookEvents();
    const closes = mockRecordDecisionOutcome.mock.calls.map((c: any[]) => c[2]).filter((o: any) => o.note === 'not started: busy');
    expect(closes.map((o: any) => o.question)).toEqual(['needs_turn_now', 'disposition', 'urgency']);
    expect(closes.every((o: any) => o.actual === null && o.acted === false)).toBe(true);
    expect(updatesWith((d) => d?.payload?.triagedAt)).toHaveLength(0); // shadow never parks
  });

  it('lookupWakeSourceLanes: bounded to 3 lanes, fails open to null facts on missing tables, null on no ids', async () => {
    expect(await lookupWakeSourceLanes([])).toBeNull();
    const facts = await lookupWakeSourceLanes(['a', 'b', 'c', 'd']);
    expect(facts).toEqual([
      { chat_id: 'a', coding_status: null, last_run: null },
      { chat_id: 'b', coding_status: null, last_run: null },
      { chat_id: 'c', coding_status: null, last_run: null },
    ]);
    mockPrisma.chatCodingState = { findUnique: jest.fn(async () => ({ status: 'running' })) };
    mockPrisma.agentRun = { findFirst: jest.fn(async () => ({ status: 'failed', finishedAt: new Date(Date.now() - 7 * 60_000), error: 'OOM   at verify\nexit 137' })) };
    try {
      expect(await lookupWakeSourceLanes(['a'])).toEqual([{ chat_id: 'a', coding_status: 'running', last_run: { status: 'failed', ended_min_ago: 7, error_head: 'OOM at verify exit 137' } }]);
      expect(mockPrisma.agentRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: 'a' }, orderBy: { createdAt: 'desc' } }));
    } finally {
      delete mockPrisma.chatCodingState;
      delete mockPrisma.agentRun;
    }
  });
});

/* ====================================================================
 * fixer 2026-09-27 (tt-rd audit, finding upward-chatter-1): the [OWNER ASK
 * UNANSWERED] re-wake (platform/owner-asks.ts) and the [FOLLOW-THROUGH] nudge
 * (fleet/follow-through.service.ts) ride the direct-wake outbox with
 * payload.kind 'owner_ask_unanswered' + payload.askMessageId. The delivery
 * threads those ids into fireScheduleTarget.ownerAskMessageIds so the
 * chat-agent finalize can CLOSE the ask on the wake's real reply — before this
 * the close ran only on owner turns and the very wakes built to answer an ask
 * could never close it.
 * ==================================================================== */
describe('owner-ask wake delivery threads ownerAskMessageIds (fixer 2026-09-27)', () => {
  beforeEach(() => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ debounceSec: 0 }));
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', title: 'Target' });
    mockDecisionMode.mockReturnValue('off');
    mockDecide.mockResolvedValue(null);
    mockFireScheduleTarget.mockResolvedValue({ started: true });
  });

  const askPayload = (askMessageId: string, over: Record<string, unknown> = {}) => ({
    eventType: 'run_completed', sourceChatId: 'c-tgt', sourceChatTitle: 'Target', depth: 0,
    summary: `[OWNER ASK UNANSWERED] The owner asked "what is going on" (msg ${askMessageId.slice(0, 8)}) …`,
    origin: 'owner-asks', kind: 'owner_ask_unanswered', askMessageId, reason: 'empty', ...over,
  });

  it('a delivered owner-ask wake carries the ask id(s) — distinct, trimmed — on the firing; an ordinary wake carries none', async () => {
    setPendingRows([
      eventRow({ id: 'e1', payload: askPayload('msg-ask-11111111-aaaa') }),
      eventRow({ id: 'e2', payload: askPayload('msg-ask-11111111-aaaa') }), // the nudge for the SAME ask coalesces to one id
      eventRow({ id: 'e3', payload: askPayload(' msg-ask-22222222-bbbb ') }),
    ]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const fire = mockFireScheduleTarget.mock.calls[0][0];
    expect(fire).toMatchObject({ id: 'hook-h1', sessionId: 'c-tgt', origin: 'hook' });
    expect(fire.ownerAskMessageIds).toEqual(['msg-ask-11111111-aaaa', 'msg-ask-22222222-bbbb']);

    mockFireScheduleTarget.mockClear();
    setPendingRows([eventRow({ id: 'e4' })]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockFireScheduleTarget.mock.calls[0][0].ownerAskMessageIds).toBeUndefined();
  });

  it('a row with the kind but no usable askMessageId, or another kind, contributes no id', async () => {
    setPendingRows([
      eventRow({ id: 'e1', payload: askPayload('', {}) }),
      eventRow({ id: 'e2', payload: askPayload('msg-esc-33333333', { kind: 'owner_ask_escalated' }) }),
    ]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockFireScheduleTarget.mock.calls[0][0].ownerAskMessageIds).toBeUndefined();
  });
});

/* ====================================================================
 * LANE-IDLE-WAKE (2026-10-20; coding/lane-idle.ts): a DELAYED direct wake
 * (enqueueDirectWake notBefore) is never delivered before its time — not by
 * the sweep, a finalize drain, a window / sibling ride, the hooks-first
 * arbitration or the retiring colour's un-park — and a lane_idle wake row is
 * revalidated against the LANE at delivery (never the assignee check).
 * ==================================================================== */
describe('LANE-IDLE-WAKE — delayed direct wakes + lane_idle delivery revalidation', () => {
  const future = () => new Date(Date.now() + 15 * 60_000);
  const selfHook = () => hookRow({ id: 'h-wake', sourceChatId: 'c-tgt', targetChatId: 'c-tgt', eventTypes: [TODO_WAKE_EVENT_TYPE], promptTemplate: '{{summary}}', debounceSec: 0 });
  const laneIdleRow = (over: any = {}) => eventRow({
    id: 'e-idle', hookId: 'h-wake', eventType: TODO_WAKE_EVENT_TYPE,
    payload: {
      eventType: TODO_WAKE_EVENT_TYPE, sourceChatId: 'c-tgt', sourceChatTitle: 'Supervisor', summary: '[LANE IDLE WITH OPEN WORK — harness check, lane lane-123]', depth: 0,
      wakeKind: 'lane_idle', trigger: 'lane_idle_supervisor', laneChatId: 'lane-123', laneTodoId: 'todo-9', enqueuedAt: new Date(Date.now() - 25 * 60_000).toISOString(),
    },
    ...over,
  });
  const suppressionWrite = (id: string) =>
    mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0])
      .find((u: any) => u?.where?.id === id && u?.data?.status === 'delivered' && u?.data?.payload?.suppressedAtDelivery);

  beforeEach(() => {
    mockRevalidateLaneIdle.mockReset().mockResolvedValue({ action: 'deliver' });
    mockPrisma.eventHook.findUnique.mockResolvedValue(selfHook());
  });

  it('fleetRollupEventKey: an all-complete idle-skip notice is rolled up under its own key, never as a daily-cap hit', () => {
    expect(fleetRollupEventKey('schedule_cap_skipped', { kind: 'all_complete_idle', scheduleId: 's' })).toBe('schedule_cap_skipped:all_complete_idle');
    expect(fleetRollupEventKey('schedule_cap_skipped', { scheduleId: 's', cap: 48 })).toBe('schedule_cap_skipped');
    expect(fleetRollupEventKey('schedule_cap_skipped', { kind: 'spend' })).toBe('schedule_cap_skipped');
    expect(fleetRollupEventKey('run_failed', { kind: 'all_complete_idle' })).toBe('run_failed');
    expect(fleetRollupEventKey('run_completed')).toBe('run_completed');
  });

  it('hookRowNotYetDue: only a FUTURE payload.notBefore holds a row', () => {
    const now = Date.now();
    expect(hookRowNotYetDue({ payload: { notBefore: new Date(now + 60_000).toISOString() } }, now)).toBe(true);
    expect(hookRowNotYetDue({ payload: { notBefore: new Date(now - 1).toISOString() } }, now)).toBe(false);
    expect(hookRowNotYetDue({ payload: { notBefore: 'garbage' } }, now)).toBe(false);
    expect(hookRowNotYetDue({ payload: {} }, now)).toBe(false);
    expect(hookRowNotYetDue(null, now)).toBe(false);
  });

  it('enqueueDirectWake notBefore: a future time stamps payload.notBefore AND retryAt; a past one is an ordinary wake', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', title: 'Supervisor' });
    mockPrisma.hookEvent.create.mockResolvedValue({ id: 'he-1' });
    const nb = future();
    await enqueueDirectWake({ targetChatId: 'c-sup', prompt: 'lane idle', meta: { wakeKind: 'lane_idle' }, notBefore: nb });
    const data = mockPrisma.hookEvent.create.mock.calls[0][0].data;
    expect(data.retryAt).toEqual(nb);
    expect(data.payload).toMatchObject({ wakeKind: 'lane_idle', notBefore: nb.toISOString() });
    mockPrisma.hookEvent.create.mockClear();
    await enqueueDirectWake({ targetChatId: 'c-sup', prompt: 'p', notBefore: new Date(Date.now() - 1000) });
    const plain = mockPrisma.hookEvent.create.mock.calls[0][0].data;
    expect(plain.retryAt).toBeUndefined();
    expect(plain.payload.notBefore).toBeUndefined();
  });

  it('a not-yet-due row that reaches a claimed group goes straight back to pending with retryAt = notBefore — no wake', async () => {
    const nb = future();
    setPendingRows([laneIdleRow({ payload: { ...laneIdleRow().payload, notBefore: nb.toISOString() } })]);
    await sweepHookEvents({ targetChatId: 'c-tgt', ignoreRetryAt: true }); // a finalize drain filters it outright
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    await sweepHookEvents(); // the poll path (the mock ignores the retryAt filter) — the post-claim hand-back
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    const back = mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).find((u: any) => u?.where?.id === 'e-idle' && u?.data?.status === 'pending');
    expect(back).toEqual({ where: { id: 'e-idle', status: 'delivering' }, data: { status: 'pending', retryAt: nb } });
    expect(mockRevalidateLaneIdle).not.toHaveBeenCalled();
  });

  it('a due lane_idle wake is revalidated against the LANE (never the assignee check): still idle ⇒ the supervisor is woken', async () => {
    setPendingRows([laneIdleRow()]);
    await sweepHookEvents();
    expect(mockRevalidateLaneIdle).toHaveBeenCalledWith(expect.objectContaining({ wakeKind: 'lane_idle', laneChatId: 'lane-123' }));
    expect(mockPrisma.projectTodo.findUnique).not.toHaveBeenCalled();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });

  it('a stale lane (e.g. a newer run was stopped) is consumed with NO wake (suppressedAtDelivery lane_idle:<why>) and audited with its todo', async () => {
    mockRevalidateLaneIdle.mockResolvedValue({ action: 'suppress', reason: 'lane_stopped' });
    setPendingRows([laneIdleRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(suppressionWrite('e-idle')?.data?.payload?.suppressedAtDelivery).toBe('lane_idle:lane_stopped');
    const audit = mockPrisma.activity.create.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.data?.action === 'todo.wake_suppressed');
    expect(audit?.data?.metadata?.suppressed).toEqual([{ todoId: 'todo-9', reason: 'lane_idle:lane_stopped' }]);
  });

  it('review fix: a lane that MOVED and is idle again is DEFERRED — back to pending with a new notBefore (= retryAt), no wake, nothing consumed', async () => {
    const until = new Date(Date.now() + 12 * 60_000);
    mockRevalidateLaneIdle.mockResolvedValue({ action: 'defer', until, reason: 'lane_moved' });
    setPendingRows([laneIdleRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(suppressionWrite('e-idle')).toBeUndefined();
    const back = mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).find((u: any) => u?.where?.id === 'e-idle' && u?.data?.status === 'pending');
    expect(back?.where).toEqual({ id: 'e-idle', status: 'delivering' });
    expect(back?.data?.retryAt).toEqual(until);
    expect(back?.data?.payload).toMatchObject({ wakeKind: 'lane_idle', notBefore: until.toISOString(), laneIdleDeferrals: 1 });
    expect(hookRowNotYetDue({ payload: back?.data?.payload })).toBe(true);
  });

  it('review fix: a NEW idle episode delivers with the re-rendered prompt (the stale enqueue-time summary is replaced)', async () => {
    mockRevalidateLaneIdle.mockResolvedValue({ action: 'deliver', prompt: '[LANE IDLE WITH OPEN WORK — harness check, lane lane-123] Its last run run-newe FAILED at T' });
    setPendingRows([laneIdleRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockFireScheduleTarget.mock.calls[0][0].prompt).toContain('Its last run run-newe FAILED at T');
  });

  it('review fix: the first delivery of an episode is STAMPED on the row; a busy supervisor TTL-parks the lane_idle row (retryAt +BUSY_PARK_MS) while other alarms park as before', async () => {
    const at = new Date().toISOString();
    mockRevalidateLaneIdle.mockResolvedValue({ action: 'deliver', deliveredAt: at });
    mockFireScheduleTarget.mockResolvedValue({ started: false, reason: 'busy' });
    const infra = eventRow({ id: 'e-infra', hookId: 'h-wake', eventType: TODO_WAKE_EVENT_TYPE, payload: { eventType: TODO_WAKE_EVENT_TYPE, sourceChatId: 'c-tgt', summary: '[INFRA ALERT — disk]', depth: 0 } });
    setPendingRows([laneIdleRow(), infra]);
    const t0 = Date.now();
    await sweepHookEvents();
    const writes = mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]);
    expect(writes.find((u: any) => u?.where?.id === 'e-idle' && u?.data?.payload)).toEqual({
      where: { id: 'e-idle' }, data: { payload: expect.objectContaining({ wakeKind: 'lane_idle', laneIdleDeliveredAt: at }) },
    });
    const idlePark = writes.find((u: any) => u?.data?.status === 'pending' && u?.where?.id?.in?.includes('e-idle'));
    expect(idlePark?.where).toEqual({ id: { in: ['e-idle'] } });
    expect(idlePark?.data?.retryAt?.getTime()).toBeGreaterThanOrEqual(t0 + BUSY_PARK_MS);
    expect(idlePark?.data?.attempts).toBeUndefined();
    expect(writes.find((u: any) => u?.data?.status === 'pending' && u?.where?.id?.in?.includes('e-infra'))).toEqual({ where: { id: { in: ['e-infra'] } }, data: { status: 'pending' } });
  });

  it('review fix: an already-stamped row (no new deliveredAt) is not re-written on a re-claim', async () => {
    mockRevalidateLaneIdle.mockResolvedValue({ action: 'deliver' });
    setPendingRows([laneIdleRow({ payload: { ...laneIdleRow().payload, laneIdleDeliveredAt: new Date(Date.now() - 60_000).toISOString() } })]);
    await sweepHookEvents();
    expect(mockPrisma.hookEvent.updateMany.mock.calls.some((c: any[]) => c[0]?.where?.id === 'e-idle' && c[0]?.data?.payload && !c[0]?.data?.status)).toBe(false);
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });

  it('a revalidation that throws delivers (fail-open — a supervisor never misses a stall on a hiccup)', async () => {
    mockRevalidateLaneIdle.mockRejectedValue(new Error('db'));
    setPendingRows([laneIdleRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
  });

  it('the hooks-first arbitration and the retiring un-park never count / release a not-yet-due row', async () => {
    const now = new Date();
    mockPrisma.hookEvent.findMany.mockResolvedValue([
      { createdAt: new Date(now.getTime() - 10 * 60_000), eventType: TODO_WAKE_EVENT_TYPE, payload: { notBefore: future().toISOString() }, retryAt: future(), hook: { debounceSec: 0, lastFiredAt: null } },
    ]);
    expect((await hooksFirstVerdict('c-sup', { ageMs: 0, source: null }, now)).reason).toBe('no_hooks');
    mockPrisma.hookEvent.findMany.mockResolvedValue([{ id: 'p-busy', payload: {} }, { id: 'p-idle', payload: { notBefore: future().toISOString() } }]);
    mockPrisma.hookEvent.updateMany.mockClear();
    mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
    expect(await unparkHookEventsForTarget('c-sup')).toBe(1);
    expect(mockPrisma.hookEvent.updateMany).toHaveBeenLastCalledWith({ where: { id: { in: ['p-busy'] }, status: 'pending' }, data: { retryAt: null } });
  });
});

/* ====================================================================
 * SAA-1.1 Phase 1 — THE SOURCE-RUN MUTATION GUARD (todo eb328629).
 *
 * These pin `sourceRunMutated` itself, which nothing exercised before: the
 * policy suite pinned the `sourceRunMutated` INPUT but never the derivation that
 * produces it, so the 2026-11-03 review's blocker (a receipt MISS read as
 * "provably quiet") was invisible to the whole chain even with CI green.
 *
 * THE CONTRACT UNDER TEST: this function may PROVE a run mutated; it may NEVER
 * prove a run was quiet. Receipt rows exist for only 21 of the 91 mutating tools
 * (`RECEIPT_TOOLS` vs `PLATFORM_MUTATING_TOOLS`), so a miss means "cannot rule it
 * out" → null → the policy delivers. Suppression is only on proof.
 * ==================================================================== */
describe('sourceRunMutated — proof of action, never proof of quiet', () => {
  const completedRow = (over: any = {}) => ({
    id: 'e1', eventType: 'run_completed',
    payload: { sourceChatId: 'c-src', summary: 'Run finished fine', runId: 'r1' },
    ...over,
  });

  beforeEach(() => {
    mockPrisma.runToolReceipt.findMany.mockReset();
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([]);
  });

  it('a mutating receipt PROVES the run acted', async () => {
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ tool: 'todo_update' }]);
    expect(await sourceRunMutated([completedRow()])).toBe(true);
  });

  it('NO receipts is UNKNOWN, not quiet — the blocker this guard shipped with', async () => {
    // The failure this pins: a run whose ONLY action was a non-receipted tool
    // (hook_subscribe / infra_action / set_session_model / delete_chat …) leaves
    // zero receipt rows. Returning `false` here reads that run as "provably
    // quiet" and suppresses the wake — the ORIGINAL defect through a new door.
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([]);
    expect(await sourceRunMutated([completedRow()])).toBeNull();
  });

  it('a row with no runId is UNKNOWN, not quiet', async () => {
    const r = completedRow();
    r.payload = { sourceChatId: 'c-src', summary: 'no run id here' };
    expect(await sourceRunMutated([r])).toBeNull();
    expect(mockPrisma.runToolReceipt.findMany).not.toHaveBeenCalled();
  });

  it('a throwing lookup is UNKNOWN (fail-safe = deliver, never suppress)', async () => {
    mockPrisma.runToolReceipt.findMany.mockRejectedValue(new Error('db down'));
    expect(await sourceRunMutated([completedRow()])).toBeNull();
  });

  it('the lookup is scoped to the SOURCE run id the batch names', async () => {
    await sourceRunMutated([completedRow(), completedRow({ id: 'e2', payload: { runId: 'r2' } })]);
    expect(mockPrisma.runToolReceipt.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ runId: { in: ['r1', 'r2'] } }),
    }));
  });

  it('non-run_completed rows contribute no run id (todo_done carries no source run)', async () => {
    await sourceRunMutated([completedRow({ eventType: 'todo_done' })]);
    expect(mockPrisma.runToolReceipt.findMany).not.toHaveBeenCalled();
  });

  it('a bounded, name-restricted query — the cap cannot be starved by observe tools', async () => {
    // The pre-review query was `{ runId: { in } , ok: true }, take: 500` with no
    // orderBy: in any run busier than the cap, arbitrary heap order could drop
    // the one real action. Restricting to mutating names bounds MATCHING rows.
    await sourceRunMutated([completedRow()]);
    const arg = mockPrisma.runToolReceipt.findMany.mock.calls[0][0];
    expect(arg.take).toBe(50);
    expect(arg.where.tool.in).toContain('todo_update');
    // `ok` is deliberately NOT filtered: a staged/refused delete_chat still
    // proves the run reached for a mutation.
    expect(arg.where.ok).toBeUndefined();
  });
});

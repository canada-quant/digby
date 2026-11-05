/**
 * REPLAY ticket 56d6b204 — chat 6e36c834 2026-09-25: a spawned sub-session's
 * completed result was folded behind the machine-turn accordion because hook
 * wakes carried no expansion signal; this suite pins the dispatch-side
 * childResult stamp.
 *
 * THE INCIDENT BEING REPLAYED: the owner spawned a sub-session (the DB audit)
 * and waited on its verdict. The auto-wired child→parent result hook
 * delivered the run_completed verdict fine — but the woken machine turn
 * rendered COLLAPSED behind the machine-turn accordion, and the owner never
 * opened it (the 6ef770a1/4565991a expansions only covered SCHEDULE wakes).
 * The fix: deliverHookGroup computes
 *   childResult = isChildResultTemplate(template)
 *              || hook.createdVia === 'system:child-result-hook'
 * and threads childResult:true into fireScheduleTarget (schedule.service
 * stamps it onto both delivery branches; the wake user row's
 * metadata.childResult is the expansion signal the frontend grouping reads
 * off the machine-turn ANCHOR row).
 *
 * THE PROD HOLES THIS PINS (the exact-match learning, firing 17):
 *  - 34 enabled prod hooks still carry the LEGACY pre-2026-09-14 template
 *    (createdVia NULL — pre-provenance rows), so an exact
 *    `=== CHILD_RESULT_PROMPT_TEMPLATE` dispatch check would expand NOTHING
 *    live — case (b) replays that shape.
 *  - The provenance OR: a hook stamped 'system:child-result-hook' whose
 *    template was edited post-wiring (isChildResultTemplate false) is still
 *    the child-result wake path — case (c).
 *  - Ordinary hook wakes (a supervisor wildcard on DEFAULT_PROMPT_TEMPLATE,
 *    any other custom template) must NOT stamp — all hook wakes expanding
 *    would re-create the wake-noise problem the accordion solves — case (d).
 *
 * Mock-everything pattern copied from
 * hooks.retired-target.9df506cc.test.ts (the sibling replay suite): the
 * sweep is driven through the public sweepHookEvents entry with mocked
 * prisma/redis, and fireScheduleTarget is the asserted seam (the
 * sched-infra-blocker.2b45941b mock shape — schedule.service is the module
 * hooks.service imports the delivery path from).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  eventHook: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
    delete: jest.fn(async () => ({})),
  },
  hookEvent: {
    create: jest.fn(async () => ({})),
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 1 })),
    count: jest.fn(async () => 0),
  },
  // Delivery-time todo_wake revalidation + the retired-target counts.
  projectTodo: { findUnique: jest.fn(), count: jest.fn(async () => 0) },
  chatSchedule: { count: jest.fn(async () => 0) },
  crossModelProject: { findUnique: jest.fn() },
  crossModelChat: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(async () => ({})) },
  crossModelMessage: { create: jest.fn(async () => ({})) },
  activity: { create: jest.fn(async () => ({})) },
  // The atomic claim (UPDATE…RETURNING) — deliverHookGroup rides this raw query.
  $queryRaw: jest.fn(),
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

// error-handler imports config/env, which calls process.exit(1) without env
// vars and kills the whole jest worker at import time — mock AppError (same
// shape).
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

const mockGetChatAccess = jest.fn();
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: (...a: any[]) => mockGetChatAccess(...a) },
}));

// The delivery path (schedule.service's machine-run fire) — THE SEAM under
// test: hooks.service calls fireScheduleTarget({ id: `hook-${id}`, sessionId,
// prompt, origin: 'hook', … }) and the childResult flag must ride exactly the
// shapes below. Mock shape copied from sched-infra-blocker.2b45941b.test.ts.
const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
const mockDailyCapExceeded: jest.Mock = jest.fn(async () => null);
const mockRefundDailyCapToken: jest.Mock = jest.fn(async () => {});
const mockNotifyDailyCapOnce: jest.Mock = jest.fn(async () => {});
const mockClaimCapWindowGate: jest.Mock = jest.fn(async () => true);
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: (...a: any[]) => mockDailyCapExceeded(...a),
  refundDailyCapToken: (...a: any[]) => mockRefundDailyCapToken(...a),
  notifyDailyCapOnce: (...a: any[]) => mockNotifyDailyCapOnce(...a),
  claimCapWindowGate: (...a: any[]) => mockClaimCapWindowGate(...a),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked',
    GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss',
    HOOK_STALE_SUPPRESSED: 'hook_stale_suppressed',
    HOOK_QUIET_EVENT_SHED: 'hook_quiet_event_shed',
    HOOK_TARGET_RETIRED: 'hook_target_retired',
  },
}));

// The wake-triage decision gate must be OFF here (the hooks.service.test.ts
// idiom): with it shadow-mode-live (this container holds provider keys) every
// delivery would fire a REAL DeepSeek call and double-count the wake telemetry.
const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('./decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: () => 'off',
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: jest.fn(),
  stashDecision: () => null,
  reconstructDecision: () => null,
}));

import {
  sweepHookEvents,
  CHILD_RESULT_EVENT_TYPES, CHILD_RESULT_PROMPT_TEMPLATE,
  LEGACY_CHILD_RESULT_PROMPT_TEMPLATE, DEFAULT_PROMPT_TEMPLATE,
} from './hooks.service';

/** A hook row — default: the auto-wired child→parent result hook, CURRENT template. */
const hookRow = (over: any = {}) => ({
  id: 'h1', userId: 'u1', sourceChatId: 'c-child', targetChatId: 'c-tgt',
  eventTypes: [...CHILD_RESULT_EVENT_TYPES], promptTemplate: CHILD_RESULT_PROMPT_TEMPLATE,
  enabled: true, debounceSec: 0, lastFiredAt: null, createdVia: 'system:child-result-hook',
  createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

const setPendingRows = (rows: any[], horizonRows: any[] = [], backlogRows: any[] = []) => {
  mockPrisma.hookEvent.findMany.mockImplementation(async (args: any) =>
    (args?.where?.createdAt?.lt ? horizonRows
      : args?.where?.hookId ? backlogRows
      : rows));
};

/** A pending run_completed row — the shape the child→parent result path delivers. */
const eventRow = (over: any = {}) => ({
  id: 'e1', hookId: 'h1', userId: 'u1', eventType: 'run_completed',
  payload: {
    eventType: 'run_completed', sourceChatId: 'c-child', sourceChatTitle: 'DB audit',
    summary: 'Verdict: all tables verified, 0 drift', depth: 0,
  },
  status: 'pending', attempts: 0,
  createdAt: new Date(), updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockFireScheduleTarget.mockResolvedValue({ started: true });
  mockDailyCapExceeded.mockResolvedValue(null);
  mockClaimCapWindowGate.mockResolvedValue(true);
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.hookEvent.count.mockResolvedValue(0);
  mockPrisma.projectTodo.findUnique.mockResolvedValue({ status: 'pending', assigneeChatId: 'c-tgt' });
  mockPrisma.chatSchedule.count.mockResolvedValue(0);
  mockPrisma.projectTodo.count.mockResolvedValue(0);
  // The target is the parent's PLAIN chat (no codingState) — never
  // retired, and the fireScheduleTarget mock owns both delivery branches.
  mockPrisma.crossModelChat.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve({ userId: 'u1', archivedAt: null, isSupervisor: false, isProjectSupervisor: false, codingState: null }));
  // WILDCARD lane (case d): the source re-check resolves every source chat
  // as same-owner + supervised, so the foreign-template row still delivers.
  mockPrisma.crossModelChat.findMany.mockResolvedValue([
    { id: 'c-child', userId: 'u1', projectId: null, project: { supervised: true } },
  ]);
  // The atomic claim returns the sweep-scanned rows (the 9df506cc idiom).
  mockPrisma.$queryRaw.mockImplementation(() => mockPrisma.hookEvent.findMany());
  mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
});

describe('ticket 56d6b204 — dispatch-side childResult stamp (deliverHookGroup → fireScheduleTarget)', () => {
  it('(a) a hook on the CURRENT child-result template delivering a run_completed verdict fires with childResult: true (origin hook)', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({
      promptTemplate: CHILD_RESULT_PROMPT_TEMPLATE,
      createdVia: 'system:child-result-hook',
    }));
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const fire = mockFireScheduleTarget.mock.calls[0][0];
    expect(fire).toMatchObject({ id: 'hook-h1', sessionId: 'c-tgt', origin: 'hook', childResult: true });
    expect(typeof fire.prompt).toBe('string');
    expect(fire.prompt.length).toBeGreaterThan(0);
    // The verdict actually delivered: the row terminal-marks 'delivered'.
    const delivered = mockPrisma.hookEvent.updateMany.mock.calls
      .map((c: any[]) => c[0]).filter((u: any) => u?.data?.status === 'delivered');
    expect(delivered).toHaveLength(1);
  });

  it('(b) REPLAY of the incident shape: a LEGACY hook (LEGACY_CHILD_RESULT_PROMPT_TEMPLATE, createdVia NULL — the 34 enabled prod rows) ALSO stamps childResult: true', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({
      promptTemplate: LEGACY_CHILD_RESULT_PROMPT_TEMPLATE,
      createdVia: null, // pre-provenance row — the exact-match hole's shape
    }));
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const fire = mockFireScheduleTarget.mock.calls[0][0];
    expect(fire).toMatchObject({ id: 'hook-h1', sessionId: 'c-tgt', origin: 'hook', childResult: true });
  });

  it('(c) provenance OR: createdVia system:child-result-hook with a CUSTOM (non-contract) template still stamps childResult: true', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({
      promptTemplate: 'My edited wake prompt: {{eventType}} {{summary}}', // isChildResultTemplate false
      createdVia: 'system:child-result-hook',
    }));
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockFireScheduleTarget.mock.calls[0][0]).toMatchObject({ origin: 'hook', childResult: true });
  });

  it('(d) a same-shape but FOREIGN template (a supervisor wildcard on DEFAULT_PROMPT_TEMPLATE) fires WITHOUT the childResult key — ordinary hook wakes stay collapsed', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({
      sourceChatId: null, // the wildcard supervisor lane
      eventTypes: [...CHILD_RESULT_EVENT_TYPES],
      promptTemplate: DEFAULT_PROMPT_TEMPLATE,
      createdVia: 'system:fleet-supervisor',
    }));
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const fire = mockFireScheduleTarget.mock.calls[0][0];
    expect(fire).toMatchObject({ id: 'hook-h1', sessionId: 'c-tgt', origin: 'hook' });
    expect(fire.childResult).toBeUndefined();
  });

  it('(d2) an owner-wired custom template (neither contract generation, no provenance) stays collapsed too — no blanket hook expansion', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({
      promptTemplate: 'Your sub-session "{{sourceChatTitle}}" pinged {{eventType}}: {{summary}}', // lookalike, not the contract
      createdVia: 'tool:hook_subscribe',
    }));
    setPendingRows([eventRow()]);
    await sweepHookEvents();
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const fire = mockFireScheduleTarget.mock.calls[0][0];
    expect(fire).toMatchObject({ origin: 'hook' });
    expect(fire.childResult).toBeUndefined();
  });
});

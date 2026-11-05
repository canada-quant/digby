/**
 * Finding B2 (2026-09-27, canlaw / canlegal-bench / spark-cluster audit) —
 * "renewOnExhaustion has no generation cap, so a 16/16 system-armed watch
 * renewed itself 8 times (canlaw 7fbd168c: 125 runs, 0 commits, $77)".
 *
 * Fix under test (schedule.service.ts maybeRenewOnExhaustion → renewalGovernor):
 *  - GENERATION CAP: a successor's generation is derived from the UNIQUE
 *    renewedFromId chain (root = 0). At RENEW_MAX_GENERATIONS (default 3) the
 *    renewal is REFUSED — no successor row; the call sites post the 🛑 stop
 *    note naming the cap and the schedule_disabled event carries the reason
 *    (no successorId ⇒ alarm-class ⇒ the supervisor/owner decide).
 *  - OPEN ANCHOR (review-fixer 2026-09-27): a machine/system watch at
 *    generation ≥ 1 (a root's FIRST renewal is the pre-B2 contract) is judged
 *    against the project's open anchors — an active/blocked goal, a LIVE
 *    watched-resource registration (register_watched_resource) or a
 *    registered artifact awaiting verify_durable (register_artifact). The rule
 *    is OBSERVE-ONLY by default (gate-flip doctrine 2026-09-11): a miss writes
 *    `schedule_renew_refused` with meta.outcome 'observed' and the successor
 *    STILL arms; RENEW_ANCHOR_CHECK_ENFORCE=1 refuses ('no_anchor').
 *  - SCOPE: machine/system rows on LANE chats only. Owner-authored rows, an
 *    owner-subscribed digest, chains whose ROOT the owner armed (successors
 *    are stamped 'system' — the governor reads the root's promptSetBy; 'user'
 *    or legacy NULL = owner) and supervisor chats (isSupervisor /
 *    isProjectSupervisor) are exempt.
 *  - ORDER: dormancy → existing successor → ADOPTION of a manual re-arm →
 *    governor → create. An adopted manual replacement is never refused.
 *  - FAIL-OPEN: chat lookup / chain walk / anchor query errors renew as before.
 *  - NEAR-CAP PREVIEW: emitScheduleNearCap asks the governor what it WILL do
 *    and switches to the OFF wording (+ reason) when the renewal would be
 *    refused.
 *  - Opt-in RENEW_ANCHOR_CHECK_ENFORCE=1; RENEW_MAX_GENERATIONS overrides the
 *    default.
 *  - Telemetry: ONE loop_metrics `schedule_renew_refused` row per refusal
 *    (outcome 'refused') or observed miss (outcome 'observed').
 *
 * Harness mirrors schedule-renew-exhaustion.eb710676.test.ts (colocated
 * mock-everything) + projectGoal / watchedResource / trainingArtifact counts
 * for the anchor.
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
const mockCodingStateFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockGoalCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockWatchedCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockArtifactCount = jest.fn(async (..._a: any[]): Promise<number> => 0);

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
    agentRun: {
      findFirst: (...a: any[]) => mockRunFindFirst(...a),
      create: (...a: any[]) => mockRunCreate(...a),
      count: (...a: any[]) => mockRunCount(...a),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), update: (...a: any[]) => mockChatUpdate(...a) },
    crossModelMessage: { create: (...a: any[]) => mockMsgCreate(...a) },
    chatCodingState: { findUnique: (...a: any[]) => mockCodingStateFindUnique(...a) },
    projectGoal: { count: (...a: any[]) => mockGoalCount(...a) },
    watchedResource: { count: (...a: any[]) => mockWatchedCount(...a) },
    trainingArtifact: { count: (...a: any[]) => mockArtifactCount(...a) },
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

jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  enqueueChatMessage: jest.fn(async () => ({ id: 'pend-1', position: 1 })),
  peekWakeRider: jest.fn(async () => null),
  consumeWakeRider: jest.fn(async () => 0),
}));

const mockStartDetachedChatRun = jest.fn((..._args: any[]): string | null => 'chat:s1');
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatRunKey: (id: string) => `chat:${id}`,
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked', SWEEP_TICK: 'sweep_tick',
    LEASE_HEARTBEAT_FAILED: 'lease_heartbeat_failed', SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', SCHEDULE_BUSY_ALARM: 'schedule_busy_alarm',
    SCHEDULE_RENEW_REFUSED: 'schedule_renew_refused',
  },
}));

const mockQueueStoppedScheduleAlert = jest.fn((..._a: any[]) => {});
jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: (...a: any[]) => mockQueueStoppedScheduleAlert(...a),
  maybeFileStoppedScheduleDecision: jest.fn(async () => ({ filed: false, reason: 'lane_alive' })),
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

const mockEvaluateScheduleDormancy = jest.fn(async (..._a: any[]): Promise<any> => ({
  dormant: false, projectId: 'p1', reason: 'test: project has live work',
  signals: { activeGoals: 1, openTodos: 0, liveRuns: 0, watchedResources: 0 },
}));
jest.mock('./dormancy-gate.service', () => ({
  __esModule: true,
  DORMANT_LAST_STATUS: 'parked:dormant',
  evaluateScheduleDormancy: (...a: any[]) => mockEvaluateScheduleDormancy(...a),
}));

import {
  maybeRenewOnExhaustion, renewalGeneration, renewalChain, renewMaxGenerations, RENEW_MAX_GENERATIONS_DEFAULT,
  renewalGoverned, isOwnerAuthoredStamp, fireDue, type RenewRefusal,
} from './schedule.service';

/** The exhausted recurring row (maybeRenewOnExhaustion's param shape). */
const exhaustedRow = (over: any = {}) => ({
  id: 'sch_old', sessionId: 's1', userId: 'u1', prompt: 'S3 DURABILITY WATCH',
  kind: 'recurring', intervalSec: 3600, maxRuns: 16,
  promptSetBy: 'system', renewOnExhaustion: null, requiredProbes: null,
  renewedFromId: null,
  ...over,
});

/** A due recurring row (the sweeper's view). */
const dueRow = (over: any = {}) => ({
  id: 'sch_old', sessionId: 's1', userId: 'u1', prompt: 'S3 DURABILITY WATCH', kind: 'recurring',
  intervalSec: 3600, nextRunAt: new Date(Date.now() - 1000), enabled: true,
  runsCount: 16, maxRuns: 16, expiresAt: new Date(Date.now() + 86_400_000),
  lastFiredAt: null, lastStatus: null, promptSetBy: 'system', renewOnExhaustion: null,
  busySkips: 0, createdAt: new Date(), renewedFromId: null,
  ...over,
});

/**
 * Install a renewedFromId chain in the schedule findUnique mock:
 *   chain('sch_old', ['g2', 'g1', 'root']) ⇒ sch_old ← g2 ← g1 ← root
 * (sch_old's parent is g2 … root has no parent). Returns sch_old's parent id.
 * Every successor is stamped promptSetBy 'system' (the only shape
 * maybeRenewOnExhaustion creates); the ROOT carries `rootAuthor` (default
 * 'machine' — a schedule_self arm, the canlaw shape).
 */
function chain(head: string, ancestors: string[], rootAuthor: string | null = 'machine', rootRenew: boolean | null = null): string | null {
  const rows: Record<string, any> = {};
  const ids = [head, ...ancestors];
  for (let i = 0; i < ids.length; i++) {
    const isRoot = i === ids.length - 1;
    rows[ids[i]] = {
      enabled: true, renewedFromId: ids[i + 1] ?? null,
      promptSetBy: isRoot ? rootAuthor : 'system',
      renewOnExhaustion: isRoot ? rootRenew : true,
    };
  }
  mockScheduleFindUnique.mockImplementation(async (args: any) => rows[args?.where?.id] ?? { enabled: true });
  return ancestors[0] ?? null;
}

/** A lane chat on a project (the governed shape). */
const laneChat = (over: any = {}) => ({
  userId: 'u1', mode: 'fast', codingState: { id: 'cs1' }, parentChatId: null,
  projectId: 'p1', isSupervisor: false, isProjectSupervisor: false,
  ...over,
});

const ENV_KEYS = ['RENEW_MAX_GENERATIONS', 'RENEW_ANCHOR_CHECK_ENFORCE'];

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  mockFindMany.mockResolvedValue([]);
  mockFindFirst.mockResolvedValue(null); // no renewedFromId successor yet
  mockCount.mockResolvedValue(0);
  mockUpdate.mockResolvedValue({});
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockDeleteMany.mockResolvedValue({ count: 0 });
  mockScheduleFindUnique.mockReset().mockResolvedValue({ enabled: true });
  mockChatFindUnique.mockReset().mockResolvedValue(laneChat());
  mockRunFindFirst.mockReset().mockResolvedValue(null);
  mockRunCreate.mockReset().mockResolvedValue({ id: 'run-cont-1' });
  mockRunCount.mockReset().mockResolvedValue(0);
  mockCodingStateFindUnique.mockReset().mockResolvedValue(null);
  mockGoalCount.mockReset().mockResolvedValue(1);   // one active goal — anchored by default
  mockWatchedCount.mockReset().mockResolvedValue(0);
  mockArtifactCount.mockReset().mockResolvedValue(0);
  mockGetChatAutonomy.mockResolvedValue(null);
  mockIncr.mockResolvedValue(1);
  mockGet.mockResolvedValue(null);
  mockGetDel.mockResolvedValue(null);
  mockPTtl.mockResolvedValue(-2);
  mockSet.mockResolvedValue('OK');
  mockStartScheduledRun.mockResolvedValue({ started: true });
  mockGetPlanStrict.mockResolvedValue({ steps: [{ status: 'pending' }] });
  mockCreate.mockImplementation(({ data }: any) => Promise.resolve({ id: 'succ-1', ...data }));
  mockEvaluateScheduleDormancy.mockResolvedValue({
    dormant: false, projectId: 'p1', reason: 'test: project has live work',
    signals: { activeGoals: 1, openTodos: 0, liveRuns: 0, watchedResources: 0 },
  });
});

afterAll(() => { for (const k of ENV_KEYS) delete process.env[k]; });

const allRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === 'schedule_renew_refused');
/** Rows that STOPPED a chain (outcome 'refused'). */
const refusedRows = () => allRows().filter((r) => r?.meta?.outcome === 'refused');
/** Observe-only rows (the successor still armed). */
const observedRows = () => allRows().filter((r) => r?.meta?.outcome === 'observed');
/** No anchor of any kind on the project. */
const noAnchor = () => { mockGoalCount.mockResolvedValue(0); mockWatchedCount.mockResolvedValue(0); mockArtifactCount.mockResolvedValue(0); };

describe('renewMaxGenerations — env parsing', () => {
  it('defaults to 3, honours a valid override, ignores garbage / negatives, clamps at 1000', () => {
    expect(RENEW_MAX_GENERATIONS_DEFAULT).toBe(3);
    expect(renewMaxGenerations()).toBe(3);
    process.env.RENEW_MAX_GENERATIONS = '5';
    expect(renewMaxGenerations()).toBe(5);
    process.env.RENEW_MAX_GENERATIONS = 'lots';
    expect(renewMaxGenerations()).toBe(3);
    process.env.RENEW_MAX_GENERATIONS = '-2';
    expect(renewMaxGenerations()).toBe(3);
    process.env.RENEW_MAX_GENERATIONS = '99999';
    expect(renewMaxGenerations()).toBe(1000);
    process.env.RENEW_MAX_GENERATIONS = '0';
    expect(renewMaxGenerations()).toBe(0);
  });
});

describe('renewalGeneration — derived from the renewedFromId chain', () => {
  it('a root row (renewedFromId null) is generation 0 with NO lookup; the N-th successor is N', async () => {
    expect(await renewalGeneration({ id: 'x', renewedFromId: null })).toBe(0);
    expect(mockScheduleFindUnique).not.toHaveBeenCalled();
    const parent = chain('sch_old', ['g2', 'g1', 'root']);
    expect(await renewalGeneration({ id: 'sch_old', renewedFromId: parent }, 10)).toBe(3);
  });

  it('an input WITHOUT the field looks the link up once (callers that did not select renewedFromId)', async () => {
    chain('sch_old', ['g1', 'root']);
    expect(await renewalGeneration({ id: 'sch_old' }, 10)).toBe(2);
    expect(mockScheduleFindUnique.mock.calls[0][0]).toEqual({ where: { id: 'sch_old' }, select: { renewedFromId: true } });
  });

  it('the walk is BOUNDED at `limit` hops — a 40-deep chain answers "≥ limit" without 40 reads', async () => {
    const ancestors = Array.from({ length: 40 }, (_, i) => `g${40 - i}`);
    const parent = chain('sch_old', ancestors);
    expect(await renewalGeneration({ id: 'sch_old', renewedFromId: parent }, 4)).toBe(4);
    expect(mockScheduleFindUnique.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe('finding B2 — generation cap on the successor create', () => {
  it('a ROOT system row renews (generation 0 < 3): the successor is created and NO refusal row is written', async () => {
    const out: RenewRefusal = {};
    const res = await maybeRenewOnExhaustion(exhaustedRow(), out);
    expect(res).toBe('succ-1');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.renewedFromId).toBe('sch_old');
    expect(out.reason).toBeUndefined();
    expect(out.generation).toBe(0);
    expect(refusedRows()).toHaveLength(0);
  });

  it('generation 2 (two renewals behind it) still renews under the default cap of 3', async () => {
    const parent = chain('sch_old', ['g1', 'root']);
    const out: RenewRefusal = {};
    const res = await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), out);
    expect(res).toBe('succ-1');
    expect(out.generation).toBe(2);
    expect(out.reason).toBeUndefined();
  });

  it('THE CANLAW SHAPE: generation 3 (the 3rd self-renewal, promptSetBy system) is REFUSED — no successor, reason names the cap, ONE schedule_renew_refused row', async () => {
    const parent = chain('sch_old', ['g2', 'g1', 'root']);
    const out: RenewRefusal = {};
    const res = await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), out);
    expect(res).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(out.kind).toBe('generation_cap');
    expect(out.generation).toBe(3);
    expect(out.reason).toMatch(/generation cap reached/);
    expect(out.reason).toMatch(/renewal 3 of 3 allowed/);
    expect(out.reason).toMatch(/schedule_self/); // tells the lane the deliberate path
    const rows = refusedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'schedule_renew_refused', sessionId: 's1', value: 3,
      meta: { scheduleId: 'sch_old', kind: 'generation_cap', outcome: 'refused', generation: 3, maxGenerations: 3, promptSetBy: 'system', rootPromptSetBy: 'machine' },
    });
    // Idempotency / dedup reads still ran BEFORE the governor (ordering pin).
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it('a deeper chain (generation 8 — the live 7fbd168c depth) is refused the same way', async () => {
    const parent = chain('sch_old', ['g7', 'g6', 'g5', 'g4', 'g3', 'g2', 'g1', 'root']);
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), out)).toBeNull();
    expect(out.kind).toBe('generation_cap');
    // Bounded walk: max+1 = 4 hops is enough to know "≥ cap"; the root author
    // is read by the second bounded stretch (owner-root exemption needs it).
    expect(out.generation).toBe(4);
    expect(out.rootPromptSetBy).toBe('machine');
  });

  it('RENEW_MAX_GENERATIONS=1: generation 1 is refused, a root still renews', async () => {
    process.env.RENEW_MAX_GENERATIONS = '1';
    const parent = chain('sch_old', ['root']);
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), out)).toBeNull();
    expect(out.kind).toBe('generation_cap');
    expect(out.reason).toMatch(/renewal 1 of 1 allowed/);
    mockCreate.mockClear();
    expect(await maybeRenewOnExhaustion(exhaustedRow({ id: 'root', renewedFromId: null }), {})).toBe('succ-1');
  });

  it('RENEW_MAX_GENERATIONS=0 refuses EVERY unattended renewal (a root is generation 0 ≥ 0)', async () => {
    process.env.RENEW_MAX_GENERATIONS = '0';
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow(), out)).toBeNull();
    expect(out.kind).toBe('generation_cap');
  });

  it('a MACHINE-authored row (schedule_self root) is governed exactly like a system successor', async () => {
    const parent = chain('sch_old', ['g2', 'g1', 'root']);
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ promptSetBy: 'machine', renewedFromId: parent }), out)).toBeNull();
    expect(out.kind).toBe('generation_cap');
  });

  it('a USER-authored ROOT row with an explicit renewOnExhaustion:true is owner instruction — the governor never even looks', async () => {
    noAnchor();
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ promptSetBy: 'user', renewOnExhaustion: true, renewedFromId: null }), out)).toBe('succ-1');
    expect(out.reason).toBeUndefined();
    expect(mockChatFindUnique).not.toHaveBeenCalled();
    expect(renewalGoverned({ promptSetBy: 'user' })).toBe(false);
    expect(renewalGoverned({ promptSetBy: 'system' })).toBe(true);
    expect(renewalGoverned({ promptSetBy: 'machine' })).toBe(true);
    expect(renewalGoverned({ promptSetBy: null })).toBe(false);
  });

  it('THE REAL OWNER CHAIN (review-fixer): the successor of an owner-instructed row is stamped system + renewOnExhaustion:true — from generation 1 on the exhausted row never says "user", the ROOT does; a deep unanchored chain with a user root still renews', async () => {
    // sch_old ← g7 … ← root, root armed by the OWNER with renewOnExhaustion:true.
    const parent = chain('sch_old', ['g7', 'g6', 'g5', 'g4', 'g3', 'g2', 'g1', 'root'], 'user', true);
    noAnchor();
    process.env.RENEW_ANCHOR_CHECK_ENFORCE = '1';
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ promptSetBy: 'system', renewOnExhaustion: true, renewedFromId: parent }), out)).toBe('succ-1');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(out.kind).toBeUndefined();
    expect(out.reason).toBeUndefined();
    expect(out.rootPromptSetBy).toBe('user');
    expect(allRows()).toHaveLength(0);
    expect(mockChatFindUnique).toHaveBeenCalledTimes(1); // it looked, read the root, and stood down
    expect(mockGoalCount).not.toHaveBeenCalled();        // owner instruction — the anchor is never asked
  });

  it('a chain with a legacy NULL-promptSetBy root is owner-like (the dormancy-gate / stopped-alert convention) — exempt too', async () => {
    const parent = chain('sch_old', ['g2', 'g1', 'root'], null, true);
    noAnchor();
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), out)).toBe('succ-1');
    expect(out.kind).toBeUndefined();
    expect(isOwnerAuthoredStamp(null)).toBe(true);
    expect(isOwnerAuthoredStamp(undefined)).toBe(true);
    expect(isOwnerAuthoredStamp('user')).toBe(true);
    expect(isOwnerAuthoredStamp('machine')).toBe(false);
    expect(isOwnerAuthoredStamp('system')).toBe(false);
  });

  it('a chain whose root is a MACHINE arm (schedule_self) stays governed at every depth — the owner exemption reads the ROOT, not the exhausted row', async () => {
    const parent = chain('sch_old', ['g2', 'g1', 'root'], 'machine');
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ promptSetBy: 'system', renewOnExhaustion: true, renewedFromId: parent }), out)).toBeNull();
    expect(out.kind).toBe('generation_cap');
    expect(out.rootPromptSetBy).toBe('machine');
  });

  it('an OWNER-SUBSCRIBED digest (ticket 4565991a marker, inherited by successors) is owner instruction — never governed', async () => {
    const parent = chain('sch_old', ['g7', 'g6', 'g5', 'g4', 'g3', 'g2', 'g1', 'root']);
    noAnchor();
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ ownerSubscribed: true, renewedFromId: parent }), out)).toBe('succ-1');
    expect(out.kind).toBeUndefined();
    expect(mockChatFindUnique).not.toHaveBeenCalled();
    expect(renewalGoverned({ promptSetBy: 'system', ownerSubscribed: true })).toBe(false);
  });

  it('renewalChain: reports rootReached + the root author inside the window; a truncated walk reports rootReached false and no author', async () => {
    const parent = chain('sch_old', ['g1', 'root'], 'user', true);
    const info = await renewalChain({ id: 'sch_old', renewedFromId: parent }, 4, 4);
    expect(info).toEqual({ generation: 2, rootReached: true, rootPromptSetBy: 'user', rootRenewOnExhaustion: true });
    const deep = chain('sch_old', ['g7', 'g6', 'g5', 'g4', 'g3', 'g2', 'g1', 'root'], 'user', true);
    const cut = await renewalChain({ id: 'sch_old', renewedFromId: deep }, 4, 4);
    expect(cut.generation).toBe(4);
    expect(cut.rootReached).toBe(false);
    expect(cut.rootPromptSetBy).toBeUndefined();
    // rootLimit above limit: generation stays capped, the author is read.
    const full = await renewalChain({ id: 'sch_old', renewedFromId: deep }, 4, 64);
    expect(full).toEqual({ generation: 4, rootReached: true, rootPromptSetBy: 'user', rootRenewOnExhaustion: true });
    // A root input needs no read at all.
    expect(await renewalChain({ id: 'r', renewedFromId: null, promptSetBy: 'machine' })).toEqual({ generation: 0, rootReached: true, rootPromptSetBy: 'machine', rootRenewOnExhaustion: null });
  });

  it('SUPERVISOR chats are exempt (fleet: isSupervisor; project: isProjectSupervisor) — their sweeps are framework heartbeats, not lane watches', async () => {
    const parent = chain('sch_old', ['g7', 'g6', 'g5', 'g4', 'g3', 'g2', 'g1', 'root']);
    mockGoalCount.mockResolvedValue(0);
    mockWatchedCount.mockResolvedValue(0);
    mockChatFindUnique.mockResolvedValue(laneChat({ projectId: null, isSupervisor: true }));
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), {})).toBe('succ-1');
    mockCreate.mockClear();
    mockChatFindUnique.mockResolvedValue(laneChat({ isProjectSupervisor: true }));
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), {})).toBe('succ-1');
    expect(refusedRows()).toHaveLength(0);
  });

  it('ADOPTION PRECEDES THE GOVERNOR: a manual/steered re-arm of the same prompt is adopted at ANY depth — a deliberate re-arm is never refused', async () => {
    const parent = chain('sch_old', ['g7', 'g6', 'g5', 'g4', 'g3', 'g2', 'g1', 'root']);
    mockFindMany.mockResolvedValue([{ id: 'manual-1', prompt: ' s3 durability  watch ', maxRuns: 16, runsCount: 2, requiredProbes: null, expiresAt: null }]);
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), out)).toBe('manual-1');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(out.reason).toBeUndefined();
    expect(mockChatFindUnique).not.toHaveBeenCalled();
  });

  it('an EXISTING successor (idempotency key) short-circuits before the governor', async () => {
    const parent = chain('sch_old', ['g7', 'g6', 'g5', 'g4', 'g3', 'g2', 'g1', 'root']);
    mockFindFirst.mockResolvedValue({ id: 'succ-existing' });
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), {})).toBe('succ-existing');
    expect(mockChatFindUnique).not.toHaveBeenCalled();
  });

  it('DORMANCY still refuses first (b1d435fd ordering) — and a dormancy refusal leaves the out-param untouched (not a governor refusal)', async () => {
    mockEvaluateScheduleDormancy.mockResolvedValue({ dormant: true, projectId: 'p1', reason: 'test: no live work', signals: { activeGoals: 0, openTodos: 0, liveRuns: 0, watchedResources: 0 } });
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow(), out)).toBeNull();
    expect(out).toEqual({});
    expect(refusedRows()).toHaveLength(0);
  });
});

describe('finding B2 — open-anchor rule (goal, live watched resource or artifact awaiting verify_durable) — OBSERVE-ONLY by default, generation ≥ 1 only', () => {
  it('DEFAULT (observe-only): a generation-1 watch with NO anchor still ARMS its successor and writes ONE schedule_renew_refused row with outcome observed — the reason names register_watched_resource AND register_artifact', async () => {
    const parent = chain('sch_old', ['root']);
    noAnchor();
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), out)).toBe('succ-1');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(out.kind).toBeUndefined();          // NOT a refusal — the call sites must not say "refused"
    expect(out.reason).toBeUndefined();
    expect(out.observedKind).toBe('no_anchor');
    expect(out.observedReason).toMatch(/nothing left to watch/);
    expect(out.observedReason).toMatch(/register_watched_resource/);
    expect(out.observedReason).toMatch(/register_artifact/);
    expect(out.observedReason).toMatch(/verify_durable/);
    expect(refusedRows()).toHaveLength(0);
    const obs = observedRows();
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({
      kind: 'schedule_renew_refused', sessionId: 's1', value: 1,
      meta: { scheduleId: 'sch_old', kind: 'no_anchor', outcome: 'observed', generation: 1, maxGenerations: 3, promptSetBy: 'system', rootPromptSetBy: 'machine' },
    });
    // The queries are the project-scoped goal + LIVE watched-resource + OPEN artifact counts.
    expect(mockGoalCount.mock.calls[0][0]).toEqual({ where: { projectId: 'p1', status: { in: ['active', 'blocked'] } } });
    const w = mockWatchedCount.mock.calls[0][0].where;
    expect(w.projectId).toBe('p1');
    expect(w.OR[0]).toEqual({ reservationEndsAt: null });
    expect(w.OR[1].reservationEndsAt.gt).toBeInstanceOf(Date);
    expect(mockArtifactCount.mock.calls[0][0]).toEqual({ where: { projectId: 'p1', durableVerifiedAt: null } });
  });

  it('a ROOT (generation 0) is never judged by the anchor — its first renewal is the pre-B2 contract; no lookups, no row', async () => {
    noAnchor();
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: null }), out)).toBe('succ-1');
    expect(out.generation).toBe(0);
    expect(out.observedKind).toBeUndefined();
    expect(mockGoalCount).not.toHaveBeenCalled();
    expect(mockArtifactCount).not.toHaveBeenCalled();
    expect(allRows()).toHaveLength(0);
  });

  it('ENFORCE (RENEW_ANCHOR_CHECK_ENFORCE=1): the same generation-1 unanchored watch is REFUSED (no_anchor) — no successor, ONE refused row', async () => {
    process.env.RENEW_ANCHOR_CHECK_ENFORCE = '1';
    const parent = chain('sch_old', ['root']);
    noAnchor();
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), out)).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(out.kind).toBe('no_anchor');
    expect(out.reason).toMatch(/nothing left to watch/);
    expect(out.reason).toMatch(/register_watched_resource/);
    expect(out.reason).toMatch(/register_artifact/);
    expect(out.observedKind).toBeUndefined();
    expect(observedRows()).toHaveLength(0);
    expect(refusedRows()[0].meta).toMatchObject({ kind: 'no_anchor', outcome: 'refused', generation: 1 });
  });

  it('ENFORCE: a ROOT still renews without any anchor lookup (generation 0 is exempt from the anchor even when enforced)', async () => {
    process.env.RENEW_ANCHOR_CHECK_ENFORCE = '1';
    noAnchor();
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: null }), {})).toBe('succ-1');
    expect(mockGoalCount).not.toHaveBeenCalled();
  });

  it('ENFORCE: an active goal alone anchors the renewal', async () => {
    process.env.RENEW_ANCHOR_CHECK_ENFORCE = '1';
    const parent = chain('sch_old', ['root']);
    mockGoalCount.mockResolvedValue(1);
    mockWatchedCount.mockResolvedValue(0);
    mockArtifactCount.mockResolvedValue(0);
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), {})).toBe('succ-1');
    expect(allRows()).toHaveLength(0);
  });

  it('ENFORCE: a LIVE watched-resource registration alone anchors the renewal (the infra-monitor case)', async () => {
    process.env.RENEW_ANCHOR_CHECK_ENFORCE = '1';
    const parent = chain('sch_old', ['root']);
    mockGoalCount.mockResolvedValue(0);
    mockWatchedCount.mockResolvedValue(1);
    mockArtifactCount.mockResolvedValue(0);
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), {})).toBe('succ-1');
    expect(allRows()).toHaveLength(0);
  });

  it('ENFORCE: THE ARTIFACT-ONLY PROJECT SHAPE (goals 0, watched 0, one register_artifact row awaiting verify_durable) anchors the renewal — an S3 durability watch has an anchor the instruction can actually satisfy', async () => {
    process.env.RENEW_ANCHOR_CHECK_ENFORCE = '1';
    const parent = chain('sch_old', ['root']);
    mockGoalCount.mockResolvedValue(0);
    mockWatchedCount.mockResolvedValue(0);
    mockArtifactCount.mockResolvedValue(1);
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), out)).toBe('succ-1');
    expect(out.kind).toBeUndefined();
    expect(out.observedKind).toBeUndefined();
    expect(allRows()).toHaveLength(0);
  });

  it('a PROJECTLESS lane chat is not project work — the anchor check does not apply', async () => {
    const parent = chain('sch_old', ['root']);
    mockChatFindUnique.mockResolvedValue(laneChat({ projectId: null }));
    noAnchor();
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), {})).toBe('succ-1');
    expect(mockGoalCount).not.toHaveBeenCalled();
  });

  it('the cap is judged BEFORE the anchor: a capped row reports generation_cap even with no anchor', async () => {
    const parent = chain('sch_old', ['g2', 'g1', 'root']);
    noAnchor();
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), out)).toBeNull();
    expect(out.kind).toBe('generation_cap');
    expect(mockGoalCount).not.toHaveBeenCalled();
  });

});

describe('finding B2 — FAIL-OPEN on every lookup error (a telemetry hiccup never strands a lane)', () => {
  it('chat lookup throws ⇒ renews', async () => {
    mockChatFindUnique.mockRejectedValue(new Error('db gone'));
    const parent = chain('sch_old', ['g2', 'g1', 'root']);
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), {})).toBe('succ-1');
    expect(refusedRows()).toHaveLength(0);
  });

  it('chat row missing ⇒ renews', async () => {
    mockChatFindUnique.mockResolvedValue(null);
    const parent = chain('sch_old', ['g2', 'g1', 'root']);
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), {})).toBe('succ-1');
  });

  it('chain walk throws ⇒ the cap is skipped (unknown depth); the row is a KNOWN successor (renewedFromId set) so the anchor still applies — observed by default, refused under ENFORCE', async () => {
    mockScheduleFindUnique.mockRejectedValue(new Error('db gone'));
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: 'g2' }), out)).toBe('succ-1');
    expect(out.generation).toBeUndefined();
    expect(out.observedKind).toBeUndefined(); // anchored (goal 1 by default)
    mockCreate.mockClear();
    noAnchor();
    const out2: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: 'g2' }), out2)).toBe('succ-1');
    expect(out2.observedKind).toBe('no_anchor');
    mockCreate.mockClear();
    process.env.RENEW_ANCHOR_CHECK_ENFORCE = '1';
    const out3: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: 'g2' }), out3)).toBeNull();
    expect(out3.kind).toBe('no_anchor');
  });

  it('chain walk throws on a row whose link was NOT selected ⇒ root/successor unknown ⇒ the anchor is skipped (fail-open), the successor arms', async () => {
    mockScheduleFindUnique.mockRejectedValue(new Error('db gone'));
    process.env.RENEW_ANCHOR_CHECK_ENFORCE = '1';
    noAnchor();
    const out: RenewRefusal = {};
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: undefined }), out)).toBe('succ-1');
    expect(out.kind).toBeUndefined();
    expect(mockGoalCount).not.toHaveBeenCalled();
  });

  it('anchor query throws ⇒ renews (even under ENFORCE)', async () => {
    process.env.RENEW_ANCHOR_CHECK_ENFORCE = '1';
    const parent = chain('sch_old', ['root']);
    mockGoalCount.mockRejectedValue(new Error('db gone'));
    expect(await maybeRenewOnExhaustion(exhaustedRow({ renewedFromId: parent }), {})).toBe('succ-1');
    expect(allRows()).toHaveLength(0);
  });
});

describe('finding B2 — the call sites: 🛑 stop note + schedule_disabled carry the refusal', () => {
  const disableEvent = () => mockEmitHookEvent.mock.calls.find((c) => c[1] === 'schedule_disabled')!;

  it('ALREADY-AT-CAP sweeper branch: a capped generation-3 watch stops with the reason in the owner note, the event detail and NO successorId (alarm-class again); the stopped-schedule alert is queued', async () => {
    const parent = chain('sch_old', ['g2', 'g1', 'root']);
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 16, maxRuns: 16, renewedFromId: parent })]);
    await fireDue();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    const note = mockMsgCreate.mock.calls[0][0].data.content as string;
    expect(note).toMatch(/^🛑/);
    expect(note).toMatch(/16-run cap/);
    expect(note).toMatch(/auto-renew refused — auto-renew generation cap reached/);
    const evt = disableEvent();
    expect(evt[2]).toContain('max_runs after 16 run(s)');
    expect(evt[2]).toContain('auto-renew refused — auto-renew generation cap reached');
    expect(evt[3].successorId).toBeUndefined();
    expect(evt[3].detail).toMatch(/generation cap reached/);
    expect(mockQueueStoppedScheduleAlert).toHaveBeenCalledWith('sch_old', 'max_runs');
    expect(refusedRows()).toHaveLength(1);
  });

  it('FIRED-FINAL branch: the 16th firing of a generation-3 watch runs, then stops with the same reason', async () => {
    const parent = chain('sch_old', ['g2', 'g1', 'root']);
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 15, maxRuns: 16, renewedFromId: parent })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1); // the final run itself still fires
    expect(mockCreate).not.toHaveBeenCalled();
    const note = mockMsgCreate.mock.calls[0][0].data.content as string;
    expect(note).toMatch(/16-run cap \(16 runs\); auto-renew refused — auto-renew generation cap reached/);
    const evt = disableEvent();
    expect(evt[3].successorId).toBeUndefined();
    expect(evt[3].detail).toMatch(/generation cap reached/);
    expect(mockQueueStoppedScheduleAlert).toHaveBeenCalledWith('sch_old', 'max_runs');
  });

  it('NO-ANCHOR refusal (ENFORCE) on the fired-final branch names the missing goal / registration / artifact', async () => {
    process.env.RENEW_ANCHOR_CHECK_ENFORCE = '1';
    const parent = chain('sch_old', ['root']);
    noAnchor();
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 15, maxRuns: 16, renewedFromId: parent })]);
    await fireDue();
    expect(mockCreate).not.toHaveBeenCalled();
    const note = mockMsgCreate.mock.calls[0][0].data.content as string;
    expect(note).toMatch(/auto-renew refused — nothing left to watch/);
    expect(note).toMatch(/register_watched_resource/);
    expect(disableEvent()[2]).toContain('nothing left to watch');
    expect(disableEvent()[3].successorId).toBeUndefined();
  });

  it('OBSERVE-ONLY (default) no-anchor on the fired-final branch: the successor ARMS, the note keeps the pre-B2 successor wording with NO "refused", the event carries successorId (not alarm-class), ONE observed row', async () => {
    const parent = chain('sch_old', ['root']);
    noAnchor();
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 15, maxRuns: 16, renewedFromId: parent })]);
    await fireDue();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const note = mockMsgCreate.mock.calls[0][0].data.content as string;
    expect(note).toContain('a same-cadence successor schedule succ-1 is already armed (renewOnExhaustion), so this loop continues');
    expect(note).not.toContain('refused');
    const evt = disableEvent();
    expect(evt[3].successorId).toBe('succ-1');
    expect(evt[3].detail).toBeUndefined();
    expect(mockQueueStoppedScheduleAlert).not.toHaveBeenCalled();
    expect(observedRows()).toHaveLength(1);
    expect(refusedRows()).toHaveLength(0);
  });

  it('a renewal that PROCEEDS keeps the pre-B2 wording byte-for-byte (successor named, no "refused" text, not alarm-class)', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 15, maxRuns: 16 })]);
    await fireDue();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const note = mockMsgCreate.mock.calls[0][0].data.content as string;
    expect(note).toContain('hit its 16-run cap (16 runs); a same-cadence successor schedule succ-1 is already armed (renewOnExhaustion), so this loop continues');
    expect(note).not.toContain('refused');
    const evt = disableEvent();
    expect(evt[3].successorId).toBe('succ-1');
    expect(evt[3].detail).toBeUndefined();
    expect(evt[2]).toContain('successor schedule succ-1 is already armed');
    expect(mockQueueStoppedScheduleAlert).not.toHaveBeenCalled();
  });

  it('lifetime EXPIRY (not a run cap) never consults the governor and carries no refusal text', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 3, maxRuns: 16, expiresAt: new Date(Date.now() - 60_000) })]);
    await fireDue();
    expect(mockChatFindUnique).not.toHaveBeenCalled();
    const note = mockMsgCreate.mock.calls[0][0].data.content as string;
    expect(note).toContain('reached its lifetime expiry');
    expect(note).not.toContain('refused');
  });
});

describe('review-fixer 2026-09-27 — schedule_near_cap consults the governor (no more "no action needed" before a refusal)', () => {
  const nearCapEvent = () => mockEmitHookEvent.mock.calls.find((c) => c[1] === 'schedule_near_cap')!;

  it('a generation-3 machine chain near its cap: the near-cap event says the governor WILL REFUSE, willAutoRenew false + renewRefusalKind generation_cap — the supervisor re-arms BEFORE the stop', async () => {
    const parent = chain('sch_old', ['g2', 'g1', 'root']);
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 15, maxRuns: 16, renewedFromId: parent })]);
    await fireDue();
    const evt = nearCapEvent();
    expect(evt).toBeDefined();
    expect(evt[2]).toContain('NEAR its run cap');
    expect(evt[2]).toContain('WILL REFUSE the successor at exhaustion');
    expect(evt[2]).toContain('generation cap reached');
    expect(evt[2]).toContain('re-arm NOW');
    expect(evt[2]).not.toContain('no action needed');
    expect(evt[3]).toMatchObject({ cause: 'run_cap', willAutoRenew: false, renewRefusalKind: 'generation_cap' });
  });

  it('a generation-1 chain with no anchor, ENFORCE: the near-cap event flips to OFF wording with the no_anchor reason', async () => {
    process.env.RENEW_ANCHOR_CHECK_ENFORCE = '1';
    const parent = chain('sch_old', ['root']);
    noAnchor();
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 15, maxRuns: 16, renewedFromId: parent })]);
    await fireDue();
    const evt = nearCapEvent();
    expect(evt[2]).toContain('WILL REFUSE');
    expect(evt[2]).toContain('nothing left to watch');
    expect(evt[3]).toMatchObject({ willAutoRenew: false, renewRefusalKind: 'no_anchor' });
  });

  it('a generation-1 chain with no anchor, DEFAULT observe-only: ON wording stays (the successor will arm) plus a governor note; payload renewGovernorObserved no_anchor', async () => {
    const parent = chain('sch_old', ['root']);
    noAnchor();
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 15, maxRuns: 16, renewedFromId: parent })]);
    await fireDue();
    const evt = nearCapEvent();
    expect(evt[2]).toContain('Auto-renew (renewOnExhaustion) is ON');
    expect(evt[2]).toContain('Governor note (observe-only today');
    expect(evt[2]).toContain('nothing left to watch');
    expect(evt[3]).toMatchObject({ willAutoRenew: true, renewGovernorObserved: 'no_anchor' });
    expect(evt[3].renewRefusalKind).toBeUndefined();
  });

  it('a healthy machine root near its cap keeps the pre-fix ON wording byte-for-byte (no extra payload keys)', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 15, maxRuns: 16, renewedFromId: null })]);
    await fireDue();
    const evt = nearCapEvent();
    expect(evt[2]).toContain('Auto-renew (renewOnExhaustion) is ON — a same-cadence successor arms at exhaustion; no action needed unless the cadence should change or stop.');
    expect(evt[2]).not.toContain('Governor note');
    expect(evt[3]).toMatchObject({ willAutoRenew: true });
    expect(evt[3].renewRefusalKind).toBeUndefined();
    expect(evt[3].renewGovernorObserved).toBeUndefined();
  });

  it('a USER row near its cap never consults the governor (config-only OFF wording, as before)', async () => {
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 15, maxRuns: 16, promptSetBy: 'user', renewOnExhaustion: null })]);
    await fireDue();
    const evt = nearCapEvent();
    expect(evt[2]).toContain('Auto-renew is OFF');
    expect(evt[3]).toMatchObject({ willAutoRenew: false });
    expect(evt[3].renewRefusalKind).toBeUndefined();
  });

  it('a governor error during the preview falls back to the config derivation — the firing is never broken', async () => {
    // The preview's chat read is the tick's FIRST crossModelChat.findUnique;
    // reject only that one so the firing's own chat load still works.
    mockChatFindUnique.mockRejectedValueOnce(new Error('db gone'));
    const parent = chain('sch_old', ['g2', 'g1', 'root']);
    mockFindMany.mockResolvedValue([dueRow({ runsCount: 15, maxRuns: 16, renewedFromId: parent })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    const evt = nearCapEvent();
    expect(evt[3]).toMatchObject({ willAutoRenew: true });
  });
});

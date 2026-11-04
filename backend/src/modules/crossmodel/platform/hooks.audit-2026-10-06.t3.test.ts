/**
 * audit 2026-10-06 T3 — hooks & wakes (hooks.service.ts). Pins, each with its
 * kill switch:
 *   T3-1  triage-parked rows RIDE, never start a solo wake (finalize drain,
 *         un-park, hooks-first arbitration), a parked-only batch is RE-triaged,
 *         a fresh group carrying parks is triaged, the max hold delivers, and
 *         the park decision rides the delivered wake as a labelled sibling;
 *   T3-2  Fleet wildcard sheds: PS self completions whatever the toggle,
 *         plain personal chats, direct hooks into the Fleet a PS covers;
 *   T3-3  hook summaries redacted at emission and delivery;
 *   T3-5  schedule_disabled by the owning project supervisor (actorChatId)
 *         never wakes the actor and is not forwarded to the Fleet;
 *   T3-11 a run_completed row whose run already messaged the target is skipped;
 *   T3-12 an archived SOURCE's events are skipped + its hook paused; archive /
 *         restore pause / re-arm the chat's outgoing hooks.
 * Mock-everything pattern copied from hooks.service.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  eventHook: {
    findMany: jest.fn(async () => []),
    findUnique: jest.fn(),
    findFirst: jest.fn(async () => null),
    create: jest.fn(),
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
    delete: jest.fn(async () => ({})),
  },
  hookEvent: {
    create: jest.fn(async () => ({})),
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(async () => []),
    updateMany: jest.fn(async () => ({ count: 1 })),
    count: jest.fn(async () => 0),
  },
  projectTodo: { findUnique: jest.fn(), count: jest.fn(async () => 1) },
  codingSchedule: { count: jest.fn(async () => 1) },
  crossModelProject: { findUnique: jest.fn() },
  crossModelChat: { findUnique: jest.fn(), findMany: jest.fn(async () => []), update: jest.fn(async () => ({})) },
  crossModelMessage: { create: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
  runToolReceipt: { findMany: jest.fn(async () => []) },
  activity: { create: jest.fn(async () => ({})) },
  $queryRaw: jest.fn(),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: (...a: any[]) => mockRedisSet(...a), del: (...a: any[]) => mockRedisDel(...a) },
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string) { super(message); Object.setPrototypeOf(this, AppError.prototype); }
  },
}));
jest.mock('../crossmodel.service', () => ({ __esModule: true, default: { getChatAccess: jest.fn(async () => ({ access: 'owner', exists: true })) } }));

const mockFire: jest.Mock = jest.fn(async () => ({ started: true }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFire(...a),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
  notifyDailyCapOnce: jest.fn(async () => {}),
  claimCapWindowGate: jest.fn(async () => true),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked',
    HOOK_STALE_SUPPRESSED: 'hook_stale_suppressed', HOOK_QUIET_EVENT_SHED: 'hook_quiet_event_shed',
    HOOK_SIBLING_DRAIN: 'hook_sibling_drain', HOOK_TARGET_RETIRED: 'hook_target_retired',
    HANDOFF_PARENT_WAKE_SKIPPED: 'handoff_parent_wake_skipped', CHILD_OWNERSHIP_WAKE_SKIPPED: 'child_ownership_wake_skipped',
  },
}));

const mockDecisionMode = jest.fn((): 'off' | 'shadow' | 'act' => 'act');
const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRecordDecisionOutcome: jest.Mock = jest.fn();
jest.mock('./decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: () => mockDecisionMode(),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  decisionOptionThreshold: (_p: string, _o: string, fallback: number) => fallback,
  recordDecisionOutcome: (...a: any[]) => mockRecordDecisionOutcome(...a),
  confidenceOf: () => 0,
  stashDecision: (d: any, purpose: string, opts?: any) => (d ? { id: d.id, purpose, mode: d.mode, backend: d.backend, answers: d.answers, decidedAt: 'stashed', ...(d.challengers ? { challengers: d.challengers } : {}), ...(opts?.extra ? { extra: opts.extra } : {}) } : null),
  reconstructDecision: (s: any) => (s && s.id ? { id: s.id, purpose: s.purpose, mode: s.mode, backend: s.backend, answers: s.answers, ms: 0 } : null),
}));

const mockStore = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => mockStore.get(`${ns.join('/')}::${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, v: any) => { mockStore.set(`${ns.join('/')}::${key}`, v); }),
  storeDelete: jest.fn(async (ns: string[], key: string) => { mockStore.delete(`${ns.join('/')}::${key}`); }),
}));

import {
  sweepHookEvents, emitHookEvent, hooksFirstVerdict, unparkHookEventsForTarget, resetParkSeenForTests,
  WAKE_TRIAGE_MAX_HOLD_MS, isHeldTriagePark, parkRideLabelStashes, redactHookSummary, reportedInRunRows,
  pauseHooksForArchivedSource, resumeHooksForRestoredSource, HOOK_STATUS_REPORTED_IN_RUN, HOOK_STATUS_SOURCE_ARCHIVED,
} from './hooks.service';
import { setWakeTriageControlSampler } from './wake-triage-request';

const ENV = [
  'WAKE_TRIAGE_PARK_RIDE_DISABLED', 'WAKE_TRIAGE_MAX_HOLD_MIN', 'HOOK_FLEET_SHED_PS_ANY_TOGGLE_DISABLED',
  'HOOK_FLEET_SHED_PLAIN_CHAT_DISABLED', 'HOOK_FLEET_SHED_DIRECT_COVERED_DISABLED', 'HOOK_SUMMARY_SECRET_REDACT_DISABLED',
  'HOOK_SCHEDULE_DISABLED_ACTOR_SHED_DISABLED', 'HOOK_REPORTED_IN_RUN_SKIP_DISABLED', 'HOOK_SOURCE_ARCHIVED_SKIP_DISABLED',
];
const saved: Record<string, string | undefined> = {};

const MIN = 60_000;
const QUIET_ACT = { id: 'wt-park', mode: 'act', backend: 'TypeSafe Jev', ms: 8, answers: { needs_turn_now: { type: 'noul', noul: 0.04 } } };
const LOUD_ACT = { id: 'wt-loud', mode: 'act', backend: 'TypeSafe Jev', ms: 8, answers: { needs_turn_now: { type: 'noul', noul: 0.9 } } };

const hookRow = (over: any = {}) => ({
  id: 'h1', userId: 'u1', sourceChatId: null, projectId: null, targetChatId: 'c-sup',
  eventTypes: ['run_completed'], promptTemplate: '', enabled: true, debounceSec: 0, lastFiredAt: null, createdVia: 'system:fleet-supervisor', ...over,
});
const parked = (id: string, over: any = {}) => ({
  id, hookId: 'h1', userId: 'u1', eventType: 'run_completed', status: 'pending', attempts: 0,
  createdAt: new Date(Date.now() - 40 * MIN), retryAt: new Date(Date.now() + 10 * MIN),
  payload: {
    eventType: 'run_completed', sourceChatId: 'c-lane', sourceChatTitle: 'Lane', summary: `parked ${id}`, depth: 0,
    triagedAt: new Date(Date.now() - 20 * MIN).toISOString(), firstTriagedAt: new Date(Date.now() - 20 * MIN).toISOString(),
    triageNoul: 0.04, triageParkStash: { id: `park-${id}`, purpose: 'wake_triage', mode: 'act', backend: 'TypeSafe Jev', answers: { needs_turn_now: { type: 'noul', noul: 0.04 } }, decidedAt: 'x' },
  },
  ...over,
});
const fresh = (id: string, over: any = {}) => ({
  id, hookId: 'h1', userId: 'u1', eventType: 'run_completed', status: 'pending', attempts: 0, createdAt: new Date(), retryAt: null,
  payload: { eventType: 'run_completed', sourceChatId: 'c-lane', sourceChatTitle: 'Lane', summary: `fresh ${id}`, depth: 0 },
  ...over,
});

/** Route hookEvent.findMany: the sweep scan, the window drain (where.hookId), the sibling drain, the horizon pass. */
const setRows = (scan: any[], backlog: any[] = []) => {
  mockPrisma.hookEvent.findMany.mockImplementation(async (args: any) => {
    if (args?.where?.createdAt?.lt) return [];
    if (args?.where?.hookId && !args?.where?.hookId?.in) return backlog;
    if (args?.where?.hook?.id) return []; // sibling drain
    return scan;
  });
  // The atomic claim returns exactly the ids it was asked to claim.
  mockPrisma.$queryRaw.mockImplementation(async (_strings: any, ...vals: any[]) => {
    const all = [...scan, ...backlog];
    const joined = vals.find((v) => v && Array.isArray(v.values)) as any;
    const ids: string[] = joined ? joined.values : all.map((r) => r.id);
    return all.filter((r) => ids.includes(r.id));
  });
};
const parkWrites = () => mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).filter((u: any) => u?.data?.payload?.triagedAt);
const createdHookIds = () => mockPrisma.hookEvent.create.mock.calls.map((c: any[]) => c[0].data.hookId);

beforeEach(() => {
  jest.clearAllMocks();
  resetParkSeenForTests();
  mockStore.clear();
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  setWakeTriageControlSampler(() => 0.99); // never a control draw unless a test says so
  mockDecisionMode.mockReturnValue('act');
  mockDecide.mockResolvedValue(QUIET_ACT);
  mockFire.mockResolvedValue({ started: true, decisionDeferred: true });
  mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow());
  mockPrisma.eventHook.findMany.mockResolvedValue([]);
  mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.runToolReceipt.findMany.mockResolvedValue([]);
  mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
  mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where, select }: any) => {
    if (select?.codingState && where?.id === 'c-sup') return { userId: 'u1', archivedAt: null, isSupervisor: true, isProjectSupervisor: false, codingState: null };
    if (where?.id === 'c-sup') return { userId: 'u1', archivedAt: null, isSupervisor: true, isProjectSupervisor: false, codingState: null };
    return { id: where?.id, userId: 'u1', projectId: null, archivedAt: null, project: null };
  });
});
afterEach(() => {
  setWakeTriageControlSampler(null);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

/* ── T3-1 parked wakes ride ─────────────────────────────────────────────── */
describe('T3-1 — triage-parked rows ride, never start a solo wake', () => {
  // The owner-scope wildcard re-checks each source chat at delivery.
  beforeEach(() => { mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'c-lane', userId: 'u1', projectId: null, project: { supervised: true } }]); });

  it('the run-finalize drain (ignoreRetryAt) does NOT deliver a held park; the kill switch restores the old release', async () => {
    setRows([parked('p1')]);
    await sweepHookEvents({ targetChatId: 'c-sup', ignoreRetryAt: true });
    expect(mockFire).not.toHaveBeenCalled();
    expect(mockDecide).not.toHaveBeenCalled();

    process.env.WAKE_TRIAGE_PARK_RIDE_DISABLED = '1';
    await sweepHookEvents({ targetChatId: 'c-sup', ignoreRetryAt: true });
    expect(mockFire).toHaveBeenCalledTimes(1); // pre-audit: delivered untriaged on the turn end
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('a parked-only batch whose retryAt expired is RE-triaged and re-parks while still quiet — firstTriagedAt kept, retryAt capped by the max hold', async () => {
    const first = new Date(Date.now() - 100 * MIN); // 20 min of hold left (default 120)
    setRows([parked('p1', { retryAt: new Date(Date.now() - MIN), payload: { ...parked('p1').payload, firstTriagedAt: first.toISOString() } })]);
    await sweepHookEvents();
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockFire).not.toHaveBeenCalled();
    const w = parkWrites();
    expect(w).toHaveLength(1);
    expect(w[0].data.payload.firstTriagedAt).toBe(first.toISOString());
    expect(w[0].data.payload.triageParkStash).toMatchObject({ id: 'wt-park', purpose: 'wake_triage' });
    const retryMs = new Date(w[0].data.retryAt).getTime();
    expect(retryMs).toBeLessThanOrEqual(first.getTime() + WAKE_TRIAGE_MAX_HOLD_MS() + 1000);
    expect(retryMs).toBeLessThan(Date.now() + 25 * MIN);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wake_parked', meta: expect.objectContaining({ reason: 'triage', retriaged: 1 }) }));
  });

  it('a FRESH row whose window drain pulls in a held park is triaged as one group (no longer skipped); the kill switch skips triage and delivers', async () => {
    setRows([fresh('f1')], [parked('p1')]);
    await sweepHookEvents();
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockFire).not.toHaveBeenCalled(); // quiet ⇒ both park together
    expect(parkWrites().map((u: any) => u.where.id).sort()).toEqual(['f1', 'p1']);

    jest.clearAllMocks();
    process.env.WAKE_TRIAGE_PARK_RIDE_DISABLED = '1';
    setRows([fresh('f1')], [parked('p1')]);
    await sweepHookEvents();
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockFire).toHaveBeenCalledTimes(1);
  });

  it('a loud fresh row DELIVERS with the riding park\'s decision as an excludeFromFit sibling of the new stash', async () => {
    mockDecide.mockResolvedValue(LOUD_ACT);
    setRows([fresh('f1')], [parked('p1')]);
    await sweepHookEvents();
    expect(mockFire).toHaveBeenCalledTimes(1);
    const d = mockFire.mock.calls[0][0].decision;
    expect(d).toMatchObject({ id: 'wt-loud', purpose: 'wake_triage' });
    expect(d.also).toEqual([expect.objectContaining({ id: 'park-p1', extra: expect.objectContaining({ parkRide: 'ride', pinned: true }) })]);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wake_delivered', meta: expect.objectContaining({ parkedRode: 1 }) }));
  });

  it('past the MAX HOLD a parked-only batch delivers without a fresh triage and its park label is a clean (in-fit) hold_expired row', async () => {
    const old = new Date(Date.now() - 400 * MIN).toISOString();
    setRows([parked('p1', { retryAt: new Date(Date.now() - MIN), payload: { ...parked('p1').payload, firstTriagedAt: old, triagedAt: old } })]);
    await sweepHookEvents();
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockFire).toHaveBeenCalledTimes(1);
    const d = mockFire.mock.calls[0][0].decision;
    expect(d).toMatchObject({ id: 'park-p1', extra: { parkRide: 'hold_expired' } });
    expect(d.extra.pinned).toBeUndefined();
  });

  it('WAKE_TRIAGE_MAX_HOLD_MIN is clamped 30..1380 (default 120)', () => {
    expect(WAKE_TRIAGE_MAX_HOLD_MS()).toBe(120 * MIN);
    process.env.WAKE_TRIAGE_MAX_HOLD_MIN = '5';
    expect(WAKE_TRIAGE_MAX_HOLD_MS()).toBe(30 * MIN);
    process.env.WAKE_TRIAGE_MAX_HOLD_MIN = '99999';
    expect(WAKE_TRIAGE_MAX_HOLD_MS()).toBe(23 * 60 * MIN);
  });

  it('hooksFirstVerdict ignores held parks (no yield to a drain that would deliver nothing); un-park releases only BUSY parks', async () => {
    const now = new Date();
    mockPrisma.hookEvent.findMany.mockResolvedValue([{ ...parked('p1'), createdAt: new Date(now.getTime() - 30 * MIN), hook: { debounceSec: 0, lastFiredAt: null } }]);
    expect(await hooksFirstVerdict('c-sup', { ageMs: 0, source: null }, now)).toMatchObject({ hooksFirst: false, reason: 'no_hooks' });
    process.env.WAKE_TRIAGE_PARK_RIDE_DISABLED = '1';
    expect(await hooksFirstVerdict('c-sup', { ageMs: 0, source: null }, now)).toMatchObject({ hooksFirst: true, reason: 'hooks_first' });
    delete process.env.WAKE_TRIAGE_PARK_RIDE_DISABLED;

    mockPrisma.hookEvent.findMany.mockResolvedValue([{ id: 'p1', payload: parked('p1').payload }, { id: 'b1', payload: { eventType: 'run_completed' } }]);
    mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
    expect(await unparkHookEventsForTarget('c-sup')).toBe(1);
    expect(mockPrisma.hookEvent.updateMany).toHaveBeenLastCalledWith({ where: { id: { in: ['b1'] }, status: 'pending' }, data: { retryAt: null } });
  });

  it('isHeldTriagePark / parkRideLabelStashes are pure and dedupe one stash per park decision', () => {
    const now = Date.now();
    expect(isHeldTriagePark(parked('p1'), now)).toBe(true);
    expect(isHeldTriagePark(parked('p1', { retryAt: new Date(now - 1) }), now)).toBe(false);
    expect(isHeldTriagePark(fresh('f1', { retryAt: new Date(now + MIN) }), now)).toBe(false); // a BUSY park is not a triage park
    const two = [parked('a'), parked('b', { payload: { ...parked('b').payload, triageParkStash: parked('a').payload.triageParkStash } })];
    expect(parkRideLabelStashes(two, { clean: false })).toHaveLength(1);
  });
});

/* ── T3-2 fleet feed + T3-3 redaction + T3-5 actor ─────────────────────── */
describe('T3-2 / T3-3 / T3-5 — emission routes into the Fleet wildcard', () => {
  const fleet = () => hookRow({ id: 'h-fleet', sourceChatId: null, projectId: null, targetChatId: 'c-fleet', eventTypes: ['run_completed', 'schedule_disabled'] });
  const psHook = () => hookRow({ id: 'h-ps', sourceChatId: null, projectId: 'p1', targetChatId: 'c-ps', eventTypes: ['run_completed', 'schedule_disabled'] });
  const direct = () => hookRow({ id: 'h-direct', sourceChatId: 'c-lane', projectId: null, targetChatId: 'c-fleet', eventTypes: ['run_completed'], promptTemplate: 'Nightly engineer fired: {{summary}}', createdVia: null });
  const source = (over: any = {}) => ({
    title: 'Lane', userId: 'u1', projectId: 'p1', isProjectSupervisor: false, isSupervisor: false,
    codingState: { id: 'cs' }, project: { supervised: true, projectSupervisorEnabled: true }, ...over,
  });
  // c-fleet is the Fleet Supervisor chat (the target lookup for the new sheds).
  beforeEach(() => { mockPrisma.crossModelChat.findMany.mockImplementation(async ({ where }: any) => (where?.id?.in ?? []).filter((id: string) => id === 'c-fleet').map((id: string) => ({ id }))); });

  it('(b) a user\'s deliberate owner-scope wildcard into a NON-supervisor chat keeps receiving plain-chat completions', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow({ id: 'h-log', sourceChatId: null, projectId: null, targetChatId: 'c-log' })]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(source({ projectId: null, project: null, codingState: null }));
    await emitHookEvent('c-plain', 'run_completed', 'answered a question');
    expect(createdHookIds()).toEqual(['h-log']);
  });

  it('(b) a plain personal chat\'s run_completed never reaches the Fleet; a coding chat\'s still does; the kill switch restores it', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([fleet()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(source({ projectId: null, project: null, codingState: null }));
    await emitHookEvent('c-plain', 'run_completed', 'here is your penne picture');
    expect(createdHookIds()).toEqual([]);

    jest.clearAllMocks();
    mockPrisma.eventHook.findMany.mockResolvedValue([fleet()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(source({ projectId: null, project: null }));
    await emitHookEvent('c-lane', 'run_completed', 'lane done');
    expect(createdHookIds()).toEqual(['h-fleet']);

    jest.clearAllMocks();
    process.env.HOOK_FLEET_SHED_PLAIN_CHAT_DISABLED = '1';
    mockPrisma.eventHook.findMany.mockResolvedValue([fleet()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(source({ projectId: null, project: null, codingState: null }));
    await emitHookEvent('c-plain', 'run_completed', 'here is your penne picture');
    expect(createdHookIds()).toEqual(['h-fleet']);
  });

  it('(c) a DIRECT hook into the Fleet is shed when an enabled PS hook covers the lane; the PS still gets it; the kill switch restores the double wake', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([fleet(), psHook(), direct()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(source());
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'c-fleet' }]);
    await emitHookEvent('c-lane', 'run_completed', 'lane done');
    expect(createdHookIds()).toEqual(['h-ps']);

    jest.clearAllMocks();
    process.env.HOOK_FLEET_SHED_DIRECT_COVERED_DISABLED = '1';
    mockPrisma.eventHook.findMany.mockResolvedValue([fleet(), psHook(), direct()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(source());
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'c-fleet' }]);
    await emitHookEvent('c-lane', 'run_completed', 'lane done');
    expect(createdHookIds().sort()).toEqual(['h-direct', 'h-ps']);
  });

  it('T3-3: a summary carrying a credential is stored redacted; the kill switch stores it as written', async () => {
    const secret = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
    mockPrisma.eventHook.findMany.mockResolvedValue([psHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(source());
    await emitHookEvent('c-lane', 'run_completed', `done — key ${secret}`);
    const stored = mockPrisma.hookEvent.create.mock.calls[0][0].data.payload.summary;
    expect(stored).not.toContain(secret);
    expect(stored).toContain('[REDACTED');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hook_summary_redacted', meta: { eventType: 'run_completed', stage: 'emit' } }));
    expect(redactHookSummary(`x ${secret}`)).not.toContain(secret);
    process.env.HOOK_SUMMARY_SECRET_REDACT_DISABLED = '1';
    expect(redactHookSummary(`x ${secret}`)).toContain(secret);
  });

  it('4e8257c4: a summary quoting an owner-pasted TAILSCALE key (the 9d0d12bd specimen) is stored redacted — the write seam now knows the shape', async () => {
    // audit 2026-10-15 todo 4e8257c4: the wake path redacted on write at emit
    // + delivery + direct wakes, but SECRET_PATTERNS had no tskey- shape, so
    // the owner's pasted Tailscale auth key rode machine wake 9d0d12bd
    // VERBATIM. Same provider-prefix gap class as 82dd8756 (Cloudflare cfat_).
    const tskey = 'tskey-auth-' + 'kFAKE0123456789abcdefghijklmnop';
    mockPrisma.eventHook.findMany.mockResolvedValue([psHook()]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(source());
    await emitHookEvent('c-lane', 'run_completed', `owner pasted the tailnet key ${tskey} — join it`);
    const stored = mockPrisma.hookEvent.create.mock.calls[0][0].data.payload.summary;
    expect(stored).not.toContain(tskey);
    expect(stored).toContain('[REDACTED');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hook_summary_redacted', meta: { eventType: 'run_completed', stage: 'emit' } }));
    // the delivery leg + the pure-function contract (kill switch as T3-3)
    expect(redactHookSummary(`x ${tskey}`)).not.toContain(tskey);
    process.env.HOOK_SUMMARY_SECRET_REDACT_DISABLED = '1';
    expect(redactHookSummary(`x ${tskey}`)).toContain(tskey);
    delete process.env.HOOK_SUMMARY_SECRET_REDACT_DISABLED;
  });

  it('T3-5: schedule_disabled by the OWNING project supervisor wakes neither it (actor echo) nor the Fleet; a lane actor or no actor still alarms both', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([fleet(), psHook()]);
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'c-ps' ? { userId: 'u1', projectId: 'p1', isProjectSupervisor: true } : source());
    await emitHookEvent('c-lane', 'schedule_disabled', 'Schedule s1 disabled — cancelled', { scheduleId: 's1', reason: 'cancelled', actorChatId: 'c-ps' });
    expect(createdHookIds()).toEqual([]);

    jest.clearAllMocks();
    mockPrisma.eventHook.findMany.mockResolvedValue([fleet(), psHook()]);
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => source());
    await emitHookEvent('c-lane', 'schedule_disabled', 'Schedule s1 disabled — cancelled', { scheduleId: 's1', reason: 'cancelled' });
    // absent actor = an alarm to both. FLEET-PS-FIRST (2026-10-20): the Fleet's row lands here through the
    // enqueue-failure fallback (this mock cannot create the direct-wake hook) — hooks.fleet-ps-first.test.ts pins the hold.
    expect(createdHookIds().sort()).toEqual(['h-fleet', 'h-ps']);

    jest.clearAllMocks();
    process.env.HOOK_SCHEDULE_DISABLED_ACTOR_SHED_DISABLED = '1';
    mockPrisma.eventHook.findMany.mockResolvedValue([fleet(), psHook()]);
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => source());
    await emitHookEvent('c-lane', 'schedule_disabled', 'Schedule s1 disabled — cancelled', { scheduleId: 's1', reason: 'cancelled', actorChatId: 'c-ps' });
    expect(createdHookIds()).toEqual(['h-fleet']); // actor-echo still spares the PS; the Fleet is told as before
  });
});

/* ── T3-11 reported in run + T3-12 archived source ─────────────────────── */
describe('T3-11 / T3-12 — delivery-time skips', () => {
  const ps = () => hookRow({ id: 'h1', sourceChatId: null, projectId: 'p1', targetChatId: 'c-ps', createdVia: null });
  beforeEach(() => {
    mockDecisionMode.mockReturnValue('off');
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'c-ps' ? { userId: 'u1', archivedAt: null, isSupervisor: false, isProjectSupervisor: true, codingState: null } : { userId: 'u1', archivedAt: null });
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'c-lane', userId: 'u1', projectId: 'p1', project: { supervised: true } }]);
  });

  it('T3-11: a run_completed whose run already messaged the target is skipped (no wake); a run that messaged elsewhere still wakes', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(ps());
    const row = fresh('r1', { payload: { ...fresh('r1').payload, runId: 'run-1' } });
    setRows([row]);
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ runId: 'run-1', ids: { chatId: 'c-ps' }, createdAt: new Date() }]);
    await sweepHookEvents();
    expect(mockFire).not.toHaveBeenCalled();
    expect(mockPrisma.hookEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: HOOK_STATUS_REPORTED_IN_RUN } }));

    expect(await reportedInRunRows({ targetChatId: 'c-other' }, [row])).toEqual([]);
    process.env.HOOK_REPORTED_IN_RUN_SKIP_DISABLED = '1';
    expect(await reportedInRunRows({ targetChatId: 'c-ps' }, [row])).toEqual([]);
  });

  it('T3-3: a row stored BEFORE the emission-time redaction is redacted in the delivered prompt', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(ps());
    const secret = 'sk-proj-' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4';
    setRows([fresh('r1', { payload: { ...fresh('r1').payload, summary: `final answer: the key is ${secret}` } })]);
    await sweepHookEvents();
    expect(mockFire).toHaveBeenCalledTimes(1);
    expect(mockFire.mock.calls[0][0].prompt).not.toContain(secret);
    expect(mockFire.mock.calls[0][0].prompt).toContain('[REDACTED');
  });

  it('T3-12: a SPECIFIC hook whose source is archived skips + pauses (remembered for the restore); the kill switch delivers', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(hookRow({ id: 'h1', sourceChatId: 'c-child', targetChatId: 'c-ps', createdVia: null }));
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'c-child' ? { userId: 'u1', archivedAt: new Date() } : { userId: 'u1', archivedAt: null, isSupervisor: false, isProjectSupervisor: true, codingState: null });
    setRows([fresh('r1', { payload: { ...fresh('r1').payload, sourceChatId: 'c-child' } })]);
    await sweepHookEvents();
    expect(mockFire).not.toHaveBeenCalled();
    expect(mockPrisma.hookEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: HOOK_STATUS_SOURCE_ARCHIVED } }));
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({ where: { id: 'h1', enabled: true }, data: { enabled: false } });
    expect(mockStore.get('hooks/archive-paused/c-child::ids')?.ids).toEqual(['h1']);

    jest.clearAllMocks();
    process.env.HOOK_SOURCE_ARCHIVED_SKIP_DISABLED = '1';
    setRows([fresh('r1', { payload: { ...fresh('r1').payload, sourceChatId: 'c-child' } })]);
    await sweepHookEvents();
    expect(mockFire).toHaveBeenCalledTimes(1);
  });

  it('T3-12: archive pauses the chat\'s outgoing hooks (never its self-hook) and restore re-arms exactly those', async () => {
    // pinned under the W3-5 kill switch: outgoing-only is the pre-2026-10-08 behaviour
    process.env.HOOK_TARGET_ARCHIVED_PAUSE_DISABLED = '1';
    mockPrisma.eventHook.findMany.mockResolvedValue([{ id: 'h-a', targetChatId: 'c-parent' }, { id: 'h-b', targetChatId: 'c-fleet' }]);
    mockPrisma.eventHook.updateMany.mockResolvedValue({ count: 2 });
    expect(await pauseHooksForArchivedSource('u1', 'c-child')).toBe(2);
    expect(mockPrisma.eventHook.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1', sourceChatId: 'c-child', enabled: true, NOT: { targetChatId: 'c-child' } } }));
    expect(await resumeHooksForRestoredSource('u1', 'c-child')).toBe(2);
    expect(mockPrisma.eventHook.updateMany).toHaveBeenLastCalledWith({ where: { id: { in: ['h-a', 'h-b'] }, userId: 'u1', sourceChatId: 'c-child', enabled: false }, data: { enabled: true } });
    expect(mockStore.has('hooks/archive-paused/c-child::ids')).toBe(false);
    process.env.HOOK_SOURCE_ARCHIVED_SKIP_DISABLED = '1';
    expect(await pauseHooksForArchivedSource('u1', 'c-child')).toBe(0);
    delete process.env.HOOK_TARGET_ARCHIVED_PAUSE_DISABLED;
  });

  // audit 2026-10-08 W3-5: 192 enabled hooks targeted archived chats (system child-result / todo_wake hooks are
  // exempt from the delivery-time retired-target pause, so they kept waking shelved chats).
  it('W3-5 REPLAY: archiving a chat also pauses the hooks that WAKE it (system ones included); restore re-arms both sets', async () => {
    delete process.env.HOOK_SOURCE_ARCHIVED_SKIP_DISABLED;
    delete process.env.HOOK_TARGET_ARCHIVED_PAUSE_DISABLED;
    mockPrisma.eventHook.findMany
      .mockResolvedValueOnce([{ id: 'h-out', targetChatId: 'c-parent' }]) // outgoing (source = the archived chat)
      .mockResolvedValueOnce([
        { id: 'h-child-result', sourceChatId: 'c-grandchild', createdVia: 'system:child-result-hook' },
        { id: 'h-self-wake', sourceChatId: 'c-lane', createdVia: 'system:todo_wake' },
        { id: 'h-peer', sourceChatId: 'c-peer', createdVia: null },
      ]);
    mockPrisma.eventHook.updateMany.mockResolvedValue({ count: 4 });
    expect(await pauseHooksForArchivedSource('u1', 'c-lane')).toBe(4);
    expect(mockPrisma.eventHook.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { userId: 'u1', targetChatId: 'c-lane', enabled: true } }));
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['h-out', 'h-child-result', 'h-self-wake', 'h-peer'] }, enabled: true }, data: { enabled: false } });
    expect(mockStore.get('hooks/archive-paused/c-lane::ids')?.ids).toEqual(['h-out', 'h-child-result', 'h-self-wake', 'h-peer']);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hook_source_archived', meta: expect.objectContaining({ phase: 'archive', targetHookIds: ['h-child-result', 'h-self-wake', 'h-peer'] }) }));
    expect(await resumeHooksForRestoredSource('u1', 'c-lane')).toBe(4);
    expect(mockPrisma.eventHook.updateMany).toHaveBeenLastCalledWith({
      where: { id: { in: ['h-out', 'h-child-result', 'h-self-wake', 'h-peer'] }, userId: 'u1', enabled: false, OR: [{ sourceChatId: 'c-lane' }, { targetChatId: 'c-lane' }] },
      data: { enabled: true },
    });
  });
});

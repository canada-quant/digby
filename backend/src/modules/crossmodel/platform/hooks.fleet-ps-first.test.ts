/**
 * FLEET-PS-FIRST (supervisor SOTA round 2, 2026-10-20) — hooks.service seams:
 *   - EMISSION: a PS-covered lane's alarm-class event writes the project
 *     supervisor's row and ONE held escalation (direct wake, retryAt +45 min)
 *     for the Fleet Supervisor instead of the Fleet's immediate wildcard row; a
 *     second alarm appends to the open escalation (Redis lock + CAS on the
 *     stored count); an enqueue failure writes the Fleet's row at once; a PS's
 *     own alarm, the project-supervisor switch OFF, a direct hook into the
 *     Fleet (explicit watch / child-result) and the kill switch keep today's
 *     immediate row; a cadence signal or a quiet-cause alarm type is shed —
 *     never an alarm-class todo_wake.
 *   - DELIVERY: the escalation is dropped ('skipped:ps_handled') when the PS's
 *     high-water mark is later than every alarm, re-held for a newer alarm or
 *     a PS wake still running that started after it, else woken with the
 *     unhandled alarms only (stamped once — the 'escalated' metric is not
 *     re-recorded while a busy Fleet re-parks the row).
 *   - HELD rows never ride: finalize drain, window drain, hooks-first, un-park.
 * Mock-everything pattern copied from hooks.audit-2026-10-06.t3.test.ts.
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
    create: jest.fn(async () => ({ id: 'e-new' })),
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(async () => []),
    updateMany: jest.fn(async () => ({ count: 1 })),
    count: jest.fn(async () => 0),
  },
  projectTodo: { findUnique: jest.fn(), count: jest.fn(async () => 1) },
  chatSchedule: { count: jest.fn(async () => 1) },
  crossModelProject: { findUnique: jest.fn(async () => ({ name: 'spark-cluster' })) },
  crossModelChat: { findUnique: jest.fn(), findMany: jest.fn(async () => []), update: jest.fn(async () => ({})) },
  crossModelMessage: { create: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
  runToolReceipt: { findMany: jest.fn(async () => []) },
  activity: { create: jest.fn(async () => ({})) },
  systemSetting: { findUnique: jest.fn(async () => null) },
  $queryRaw: jest.fn(),
  $queryRawUnsafe: jest.fn(async () => []),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedis: any = { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), incr: jest.fn(async () => 1) };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
const mockIsChatBusy: jest.Mock = jest.fn(async () => false);
jest.mock('../chat-agent/chat-busy', () => ({ __esModule: true, isChatBusy: (...a: any[]) => mockIsChatBusy(...a) }));
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
  LOOP_METRIC_KINDS: new Proxy({}, { get: (_t, k) => String(k).toLowerCase() }),
}));

jest.mock('./decision-gate', () => ({
  __esModule: true,
  decide: jest.fn(async () => null),
  decisionMode: () => 'off',
  decisionThreshold: (_p: string, fallback: number) => fallback,
  decisionOptionThreshold: (_p: string, _o: string, fallback: number) => fallback,
  recordDecisionOutcome: jest.fn(),
  confidenceOf: () => 0,
  stashDecision: () => null,
  reconstructDecision: () => null,
}));

const mockStore = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => mockStore.get(`${ns.join('/')}::${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, v: any) => { mockStore.set(`${ns.join('/')}::${key}`, v); }),
  storeDelete: jest.fn(async (ns: string[], key: string) => { mockStore.delete(`${ns.join('/')}::${key}`); }),
}));

import {
  emitHookEvent, sweepHookEvents, hooksFirstVerdict, unparkHookEventsForTarget, holdPsEscalation, revalidatePsEscalations,
  resetParkSeenForTests, TODO_WAKE_EVENT_TYPE,
} from './hooks.service';
import { invalidateSupervisorSwitchCache } from './supervisor-switch';
import { newPsEscalation, appendPsEscalation, renderPsEscalationPrompt, HOOK_STATUS_PS_HANDLED, PS_ESCALATION_DELAY_MS, type PsEscalationAlarm } from './fleet-ps-first';

const MIN = 60_000;
const ENV = ['HOOK_FLEET_ALARM_PS_FIRST_DISABLED', 'HOOK_EVENT_DEDUPE_DISABLED'];
const saved: Record<string, string | undefined> = {};

const hookRow = (over: any = {}) => ({
  id: 'h1', userId: 'u1', sourceChatId: null, projectId: null, targetChatId: 'c-fleet',
  eventTypes: ['run_failed'], promptTemplate: '', enabled: true, debounceSec: 0, lastFiredAt: null, createdVia: 'system:fleet-supervisor', ...over,
});
const ALARM_TYPES = ['run_completed', 'run_failed', 'attention_needed', 'goal_blocked', 'schedule_disabled', 'schedule_near_cap', 'schedule_cap_skipped'];
const fleet = () => hookRow({ id: 'h-fleet', eventTypes: ALARM_TYPES });
const psHook = () => hookRow({ id: 'h-ps', projectId: 'p1', targetChatId: 'c-ps', eventTypes: ALARM_TYPES });
const selfHook = () => hookRow({ id: 'h-self', sourceChatId: 'c-fleet', targetChatId: 'c-fleet', eventTypes: [TODO_WAKE_EVENT_TYPE], promptTemplate: '{{summary}}', createdVia: 'system:direct-wake' });
const laneSource = (over: any = {}) => ({
  title: 'Eval lane', userId: 'u1', projectId: 'p1', isProjectSupervisor: false, isSupervisor: false,
  codingState: { id: 'cs' }, project: { supervised: true, projectSupervisorEnabled: true }, ...over,
});
const createdRows = () => mockPrisma.hookEvent.create.mock.calls.map((c: any[]) => c[0].data);
const metrics = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === 'fleet_ps_escalation');
const metricPhases = () => metrics().map((r: any) => r.meta.phase);

/** Chat lookups: the emitting lane, the Fleet chat (direct-wake owner + delivery target), the PS chat. */
const chats = (laneOver: any = {}) => {
  mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) => {
    if (where.id === 'c-fleet') return { userId: 'u1', title: 'Fleet Supervisor', archivedAt: null, isSupervisor: true, isProjectSupervisor: false, codingState: null };
    if (where.id === 'c-ps') return { userId: 'u1', title: 'spark Supervisor', projectId: 'p1', archivedAt: null, isSupervisor: false, isProjectSupervisor: true, codingState: null, project: { supervised: true, projectSupervisorEnabled: true } };
    return laneSource(laneOver);
  });
  // The Fleet-target lookup (isSupervisor in candidates) → only c-fleet is a Fleet chat.
  mockPrisma.crossModelChat.findMany.mockImplementation(async ({ where }: any) => (where?.id?.in ?? []).filter((id: string) => id === 'c-fleet').map((id: string) => ({ id })));
};

beforeEach(() => {
  jest.clearAllMocks();
  resetParkSeenForTests();
  invalidateSupervisorSwitchCache();
  mockStore.clear();
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.HOOK_EVENT_DEDUPE_DISABLED = '1'; // the fingerprint dedupe is pinned elsewhere
  mockPrisma.eventHook.findMany.mockResolvedValue([fleet(), psHook()]);
  mockPrisma.eventHook.findFirst.mockResolvedValue(null);
  mockPrisma.eventHook.create.mockResolvedValue(selfHook());
  mockPrisma.hookEvent.findFirst.mockResolvedValue(null);
  mockPrisma.hookEvent.create.mockResolvedValue({ id: 'e-new' });
  mockPrisma.hookEvent.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
  mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue('OK');
  mockIsChatBusy.mockResolvedValue(false);
  mockFire.mockResolvedValue({ started: true });
  chats();
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('emission — PS-covered alarms reach the Fleet only as a held escalation', () => {
  it('run_failed from a covered lane: the PS row is written at once, the Fleet gets ONE held direct wake (+45 min), never its own row', async () => {
    const t0 = Date.now();
    await emitHookEvent('c-lane', 'run_failed', 'Coding run failed: OOM on shard 3', { runId: 'run-1' });
    const rows = createdRows();
    expect(rows.map((r: any) => r.hookId)).toEqual(['h-ps', 'h-self']);
    const esc = rows[1];
    expect(esc.eventType).toBe(TODO_WAKE_EVENT_TYPE);
    expect(esc.retryAt.getTime()).toBeGreaterThanOrEqual(t0 + PS_ESCALATION_DELAY_MS - 1000);
    expect(esc.payload).toMatchObject({ origin: 'ps-escalation', psEscalation: { projectId: 'p1', projectName: 'spark-cluster', psChatIds: ['c-ps'], count: 1 } });
    expect(esc.payload.psEscalation.alarms[0]).toMatchObject({ eventType: 'run_failed', sourceChatId: 'c-lane', sourceChatTitle: 'Eval lane', summary: 'Coding run failed: OOM on shard 3' });
    expect(esc.payload.summary).toContain('[PS ESCALATION');
    expect(metricPhases()).toEqual(['held']);
  });

  it('schedule_near_cap / schedule_cap_skipped from a covered lane NEVER produce a todo_wake escalation — shed from the Fleet, the PS keeps them', async () => {
    await emitHookEvent('c-lane', 'schedule_near_cap', 'Schedule s1 at 90% of its run cap', { scheduleId: 's1' });
    await emitHookEvent('c-lane', 'schedule_cap_skipped', 'Hook wake skipped: chat hit the cap');
    // A todo_wake is alarm-class at the Fleet (debounce / cap / material gate / triage bypassed) — a quiet
    // cadence signal must never become one; the project supervisor owns its lanes' cadences.
    expect(createdRows().map((r: any) => r.hookId)).toEqual(['h-ps', 'h-ps']);
    expect(createdRows().some((r: any) => r.eventType === TODO_WAKE_EVENT_TYPE)).toBe(false);
    expect(mockPrisma.hookEvent.findFirst).not.toHaveBeenCalled(); // no escalation lookup / append either
    expect(metricPhases()).toEqual(['shed_cadence', 'shed_cadence']);
  });

  it('an owner-question triage alarm carries its question id into the escalation, whatever the summary clip cuts', async () => {
    const summary = `[OWNER-QUESTION TRIAGE — answer under standing directives or leave for the owner] ${'Should we raise the cap? '.repeat(50)} — question id oq_123abc`;
    await emitHookEvent('c-lane', 'attention_needed', summary, { ownerQuestionId: 'oq_123abc', triage: 'supervisor' });
    const esc = createdRows().find((r: any) => r.hookId === 'h-self');
    expect(esc.payload.psEscalation.alarms[0].handles).toEqual({ ownerQuestionId: 'oq_123abc' });
    expect(esc.payload.summary).toContain('owner question id oq_123abc');
  });

  it('a second alarm while the escalation is held is APPENDED to it (CAS on pending); no second row', async () => {
    const meta = newPsEscalation({ projectId: 'p1', projectName: 'spark-cluster', psChatIds: ['c-ps'], alarm: { eventType: 'run_failed', sourceChatId: 'c-lane', at: new Date(Date.now() - 5 * MIN).toISOString(), summary: 'first' } });
    mockPrisma.hookEvent.findFirst.mockResolvedValue({ id: 'e-open', status: 'pending', retryAt: new Date(Date.now() + 40 * MIN), payload: { origin: 'ps-escalation', psEscalation: meta, summary: renderPsEscalationPrompt(meta) } });
    await emitHookEvent('c-lane2', 'attention_needed', 'Lane needs a decision');
    expect(createdRows().map((r: any) => r.hookId)).toEqual(['h-ps']);
    const q = mockPrisma.hookEvent.findFirst.mock.calls[0][0].where;
    expect(q).toMatchObject({ status: 'pending', eventType: TODO_WAKE_EVENT_TYPE, hook: { targetChatId: 'c-fleet' }, payload: { path: ['psEscalation', 'projectId'], equals: 'p1' } });
    expect(q.retryAt.gt).toBeInstanceOf(Date);
    const upd = mockPrisma.hookEvent.updateMany.mock.calls.find((c: any[]) => c[0].where.id === 'e-open')[0];
    // CAS: still pending AND nobody appended since the read (the stored count).
    expect(upd.where).toEqual({ id: 'e-open', status: 'pending', payload: { path: ['psEscalation', 'count'], equals: 1 } });
    expect(upd.data.payload.psEscalation.count).toBe(2);
    expect(upd.data.payload.summary).toContain('Lane needs a decision');
    expect(metricPhases()).toEqual(['appended']);
  });

  it('a concurrent append that won the CAS first is re-read once and this alarm is appended on top — never overwritten', async () => {
    const first = newPsEscalation({ projectId: 'p1', psChatIds: ['c-ps'], alarm: { eventType: 'run_failed', sourceChatId: 'c-lane', at: new Date(Date.now() - 5 * MIN).toISOString(), summary: 'first' } });
    const won = appendPsEscalation(first, { eventType: 'run_failed', sourceChatId: 'c-lane3', at: new Date(Date.now() - MIN).toISOString(), summary: 'racer' });
    const row = (meta: any) => ({ id: 'e-open', status: 'pending', retryAt: new Date(Date.now() + 40 * MIN), payload: { origin: 'ps-escalation', psEscalation: meta, summary: renderPsEscalationPrompt(meta) } });
    mockPrisma.hookEvent.findFirst.mockResolvedValueOnce(row(first)).mockResolvedValueOnce(row(won));
    mockPrisma.hookEvent.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    await emitHookEvent('c-lane2', 'attention_needed', 'Lane needs a decision');
    const upds = mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).filter((u: any) => u.where.id === 'e-open');
    expect(upds.map((u: any) => u.where.payload.equals)).toEqual([1, 2]);
    expect(upds[1].data.payload.psEscalation.count).toBe(3);
    expect(upds[1].data.payload.psEscalation.alarms.map((a: any) => a.summary)).toEqual(['first', 'racer', 'Lane needs a decision']);
    expect(createdRows().map((r: any) => r.hookId)).toEqual(['h-ps']);
    expect(metricPhases()).toEqual(['appended']);
  });

  it('the (Fleet chat × project) lock serializes concurrent holds: a held lock is waited on, then taken and released by its owner only', async () => {
    const store = new Map<string, string>();
    let contended = 1;
    mockRedis.set.mockImplementation(async (k: string, v: string, o: any) => {
      if (!k.startsWith('hookps:esc:')) return 'OK';
      if (contended-- > 0) return null; // another emission holds it
      if (o?.NX && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    });
    mockRedis.get.mockImplementation(async (k: string) => store.get(k) ?? null);
    await emitHookEvent('c-lane', 'run_failed', 'failed');
    const lockSets = mockRedis.set.mock.calls.filter((c: any[]) => String(c[0]).startsWith('hookps:esc:'));
    expect(lockSets.length).toBe(2);
    expect(lockSets[1][0]).toBe('hookps:esc:c-fleet:p1');
    expect(lockSets[1][2]).toMatchObject({ NX: true });
    expect(mockRedis.del).toHaveBeenCalledWith('hookps:esc:c-fleet:p1');
    expect(metricPhases()).toEqual(['held']);
  });

  it('a Redis failure on the lock proceeds unlocked (the escalation is still held)', async () => {
    mockRedis.set.mockImplementation(async (k: string) => { if (String(k).startsWith('hookps:esc:')) throw new Error('redis down'); return 'OK'; });
    await emitHookEvent('c-lane', 'run_failed', 'failed');
    expect(createdRows().map((r: any) => r.hookId)).toEqual(['h-ps', 'h-self']);
    expect(metricPhases()).toEqual(['held']);
  });

  it('the hold FAILS (no direct-wake hook could be created) ⇒ the Fleet row is written at once', async () => {
    mockPrisma.eventHook.create.mockResolvedValue(undefined);
    await emitHookEvent('c-lane', 'goal_blocked', 'Goal blocked on vendor firmware');
    expect(createdRows().map((r: any) => r.hookId).sort()).toEqual(['h-fleet', 'h-ps']);
    expect(metricPhases()).toEqual(['direct_fallback']);
  });

  it('a quiet-cause alarm type (a run a chat cancelled) is shed from the Fleet — the PS still gets it, nothing is held', async () => {
    await emitHookEvent('c-lane', 'run_failed', 'Coding run cancelled before completion.', { cancelledBy: 'c-ps' });
    expect(createdRows().map((r: any) => r.hookId)).toEqual(['h-ps']);
    expect(metricPhases()).toEqual(['shed_quiet']);
  });

  it('a project supervisor\'s OWN alarm reaches the Fleet at once (its project hook targets itself — not covered)', async () => {
    chats({ title: 'spark Supervisor', isProjectSupervisor: true });
    await emitHookEvent('c-ps', 'run_failed', 'Supervisor run failed');
    expect(createdRows().map((r: any) => r.hookId)).toEqual(['h-fleet']);
    expect(metricPhases()).toEqual([]);
  });

  it('a project without an enabled project supervisor, or the project-supervisor switch OFF ⇒ today\'s immediate alarm to both', async () => {
    chats({ project: { supervised: true, projectSupervisorEnabled: false } });
    await emitHookEvent('c-lane', 'run_failed', 'failed');
    expect(createdRows().map((r: any) => r.hookId).sort()).toEqual(['h-fleet', 'h-ps']);

    jest.clearAllMocks();
    chats();
    mockPrisma.eventHook.findMany.mockResolvedValue([fleet(), psHook()]);
    mockPrisma.systemSetting.findUnique.mockImplementation(async ({ where }: any) => (where?.key === 'project_supervisors_enabled' ? { key: where.key, value: '0' } : null));
    invalidateSupervisorSwitchCache();
    await emitHookEvent('c-lane', 'run_failed', 'failed');
    expect(createdRows().map((r: any) => r.hookId).sort()).toEqual(['h-fleet', 'h-ps']);
  });

  it('an explicit subscribe_to_chat watch into the Fleet fires at once, and that Fleet chat keeps today\'s routing (no held escalation)', async () => {
    const direct = hookRow({ id: 'h-direct', sourceChatId: 'c-lane', targetChatId: 'c-fleet', eventTypes: ['run_failed'], promptTemplate: 'Watch: {{summary}}', createdVia: 'tool:hook_subscribe' });
    mockPrisma.eventHook.findMany.mockResolvedValue([fleet(), psHook(), direct]);
    await emitHookEvent('c-lane', 'run_failed', 'failed');
    expect(createdRows().map((r: any) => r.hookId)).toEqual(['h-ps', 'h-direct', 'h-fleet']);
    expect(createdRows().some((r: any) => r.eventType === TODO_WAKE_EVENT_TYPE)).toBe(false);
    expect(metricPhases()).toEqual(['direct_watch']);
  });

  it('a Fleet-spawned lane\'s child-result hook keeps its immediate verdict path (the Fleet hears the lane at once — no escalation)', async () => {
    const child = hookRow({ id: 'h-child', sourceChatId: 'c-lane', targetChatId: 'c-fleet', eventTypes: ['run_completed', 'run_failed', 'attention_needed'], createdVia: 'system:child-result-hook' });
    mockPrisma.eventHook.findMany.mockResolvedValue([fleet(), psHook(), child]);
    await emitHookEvent('c-lane', 'run_failed', 'failed');
    expect(createdRows().map((r: any) => r.hookId)).toEqual(['h-ps', 'h-child', 'h-fleet']);
    expect(metricPhases()).toEqual(['direct_watch']);
  });

  it('a direct hook whose insert FAILED does not count as reaching the Fleet — the wildcard row is held as usual', async () => {
    const direct = hookRow({ id: 'h-direct', sourceChatId: 'c-lane', targetChatId: 'c-fleet', eventTypes: ['run_failed'], promptTemplate: 'Watch: {{summary}}', createdVia: 'tool:hook_subscribe' });
    mockPrisma.eventHook.findMany.mockResolvedValue([fleet(), psHook(), direct]);
    mockPrisma.hookEvent.create.mockImplementation(async ({ data }: any) => { if (data.hookId === 'h-direct') throw new Error('insert failed'); return { id: 'e-new' }; });
    await emitHookEvent('c-lane', 'run_failed', 'failed');
    expect(metricPhases()).toEqual(['held']);
  });

  it('kill switch HOOK_FLEET_ALARM_PS_FIRST_DISABLED=1 restores the immediate alarm to both supervisors', async () => {
    process.env.HOOK_FLEET_ALARM_PS_FIRST_DISABLED = '1';
    await emitHookEvent('c-lane', 'run_failed', 'failed');
    expect(createdRows().map((r: any) => r.hookId).sort()).toEqual(['h-fleet', 'h-ps']);
    expect(metricPhases()).toEqual([]);
  });

  it('quiet events keep the existing fleet-feed shed (no escalation for run_completed)', async () => {
    await emitHookEvent('c-lane', 'run_completed', 'done');
    expect(createdRows().map((r: any) => r.hookId)).toEqual(['h-ps']);
    expect(metricPhases()).toEqual([]);
  });

  it('holdPsEscalation never throws: a DB failure is { ok:false }', async () => {
    mockPrisma.crossModelChat.findUnique.mockRejectedValue(new Error('db down'));
    const res = await holdPsEscalation({ fleetChatId: 'c-fleet', projectId: 'p1', psChatIds: ['c-ps'], alarm: { eventType: 'run_failed', sourceChatId: 'c-lane', at: new Date().toISOString(), summary: 'x' } });
    expect(res.ok).toBe(false);
  });
});

/* ── delivery ───────────────────────────────────────────────────────────── */

const escRow = (id: string, alarms: PsEscalationAlarm[], over: any = {}) => {
  let meta = newPsEscalation({ projectId: 'p1', projectName: 'spark-cluster', psChatIds: ['c-ps'], alarm: alarms[0] });
  for (const a of alarms.slice(1)) meta = appendPsEscalation(meta, a);
  return {
    id, hookId: 'h-self', userId: 'u1', eventType: TODO_WAKE_EVENT_TYPE, status: 'pending', attempts: 0,
    createdAt: new Date(alarms[0].at), retryAt: new Date(Date.now() - MIN),
    payload: { origin: 'ps-escalation', psEscalation: meta, eventType: TODO_WAKE_EVENT_TYPE, sourceChatId: 'c-fleet', sourceChatTitle: 'Fleet Supervisor', summary: renderPsEscalationPrompt(meta), depth: 0 },
    ...over,
  };
};
const al = (minAgo: number, summary: string): PsEscalationAlarm => ({ eventType: 'run_failed', sourceChatId: 'c-lane', sourceChatTitle: 'Eval lane', at: new Date(Date.now() - minAgo * MIN).toISOString(), summary });
const setRows = (scan: any[], backlog: any[] = []) => {
  mockPrisma.hookEvent.findMany.mockImplementation(async (args: any) => {
    if (args?.where?.createdAt?.lt) return [];
    if (args?.where?.hookId && !args?.where?.hookId?.in) return backlog;
    if (args?.where?.hook?.id) return [];
    return scan;
  });
  mockPrisma.$queryRaw.mockImplementation(async (_s: any, ...vals: any[]) => {
    const all = [...scan, ...backlog];
    const joined = vals.find((v) => v && Array.isArray(v.values)) as any;
    const ids: string[] = joined ? joined.values : all.map((r) => r.id);
    return all.filter((r) => ids.includes(r.id));
  });
};
const hwm = (minAgo: number) => mockStore.set('wake-ledger/c-ps::hwm', { at: new Date(Date.now() - minAgo * MIN).toISOString() });

describe('delivery — revalidated against the project supervisor\'s high-water mark', () => {
  beforeEach(() => { mockPrisma.eventHook.findUnique.mockResolvedValue(selfHook()); });

  it('the PS completed a wake after the alarm ⇒ dropped as skipped:ps_handled, no Fleet wake', async () => {
    hwm(10);
    setRows([escRow('e1', [al(50, 'OOM on shard 3')])]);
    await sweepHookEvents();
    expect(mockFire).not.toHaveBeenCalled();
    expect(mockPrisma.hookEvent.updateMany).toHaveBeenCalledWith({ where: { id: 'e1' }, data: { status: HOOK_STATUS_PS_HANDLED } });
    expect(metricPhases()).toEqual(['ps_handled']);
  });

  it('no PS wake since the alarm (a wedged PS) ⇒ the Fleet is woken with the escalation (revalidated wording, stamped once)', async () => {
    hwm(60);
    setRows([escRow('e1', [al(50, 'OOM on shard 3')])]);
    await sweepHookEvents();
    expect(mockFire).toHaveBeenCalledTimes(1);
    expect(mockFire.mock.calls[0][0].prompt).toContain('[PS ESCALATION');
    expect(mockFire.mock.calls[0][0].prompt).toContain('OOM on shard 3');
    expect(mockFire.mock.calls[0][0].prompt).toContain('it has not completed a wake since they fired');
    expect(metricPhases()).toEqual(['escalated']);
    const stamp = mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).find((u: any) => u.where.id === 'e1' && u.data.payload);
    expect(Date.parse(stamp.data.payload.psEscalation.escalatedAt)).toBeGreaterThan(Date.now() - MIN);
    expect(stamp.data.payload.summary).toContain('it has not completed a wake since they fired');
  });

  it('a busy Fleet re-parks the escalated row: the 30 s re-claims re-check the PS mark but record \'escalated\' only once', async () => {
    hwm(60);
    const row = escRow('e1', [al(50, 'OOM on shard 3')]);
    setRows([row]);
    mockFire.mockResolvedValue({ started: false, reason: 'busy' });
    await sweepHookEvents();
    expect(metricPhases()).toEqual(['escalated']);
    // The park kept the stamped payload; the next tick re-claims it.
    const stamped = mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).find((u: any) => u.where.id === 'e1' && u.data.payload).data.payload;
    setRows([{ ...row, payload: stamped }]);
    await sweepHookEvents();
    await sweepHookEvents();
    expect(metricPhases()).toEqual(['escalated']);
    expect(mockFire).toHaveBeenCalledTimes(3);
    // …and if the PS completes a wake meanwhile, the row is still dropped.
    hwm(1);
    await sweepHookEvents();
    expect(metricPhases()).toEqual(['escalated', 'ps_handled']);
  });

  it('a PS wake still RUNNING that started after the alarm ⇒ re-held for a recheck, no Fleet wake', async () => {
    hwm(60);
    mockIsChatBusy.mockImplementation(async (id: string) => id === 'c-ps');
    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string, chatId: string) =>
      (String(sql).includes("role = 'user'") && chatId === 'c-ps' ? [{ createdAt: new Date(Date.now() - 20 * MIN), origin: 'hook' }] : []));
    setRows([escRow('e1', [al(50, 'OOM on shard 3')])]);
    await sweepHookEvents();
    expect(mockFire).not.toHaveBeenCalled();
    const rehold = mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).find((u: any) => u.where.id === 'e1' && u.data.retryAt);
    expect(rehold.data.status).toBe('pending');
    expect(rehold.data.retryAt.getTime()).toBeLessThanOrEqual(Date.now() + 10 * MIN + 1000);
    expect(metrics().map((m: any) => [m.meta.phase, m.meta.reason])).toEqual([['rehold', 'inflight']]);
  });

  it('a running PS turn that is NOT a machine wake (or started before the alarm) does not hold the escalation', async () => {
    hwm(60);
    mockIsChatBusy.mockResolvedValue(true);
    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) =>
      (String(sql).includes("role = 'user'") ? [{ createdAt: new Date(Date.now() - 20 * MIN), origin: null }] : []));
    setRows([escRow('e1', [al(50, 'OOM on shard 3')])]);
    await sweepHookEvents();
    expect(mockFire).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    mockFire.mockResolvedValue({ started: true });
    mockIsChatBusy.mockResolvedValue(true);
    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) =>
      (String(sql).includes("role = 'user'") ? [{ createdAt: new Date(Date.now() - 55 * MIN), origin: 'schedule' }] : []));
    mockPrisma.eventHook.findUnique.mockResolvedValue(selfHook());
    chats();
    setRows([escRow('e1', [al(50, 'OOM on shard 3')])]);
    await sweepHookEvents();
    expect(mockFire).toHaveBeenCalledTimes(1);
  });

  it('the PS handled the first alarm but a newer one is inside its window ⇒ re-held, no wake', async () => {
    hwm(20);
    setRows([escRow('e1', [al(50, 'first'), al(5, 'second')])]);
    await sweepHookEvents();
    expect(mockFire).not.toHaveBeenCalled();
    const rehold = mockPrisma.hookEvent.updateMany.mock.calls.map((c: any[]) => c[0]).find((u: any) => u.where.id === 'e1' && u.data.retryAt);
    expect(rehold.data.status).toBe('pending');
    expect(rehold.data.retryAt.getTime()).toBeGreaterThan(Date.now() + 35 * MIN);
    expect(metricPhases()).toEqual(['rehold']);
  });

  it('past the window, only the UNHANDLED alarms are in the Fleet\'s prompt', async () => {
    hwm(70);
    setRows([escRow('e1', [al(85, 'ALPHA handled'), al(60, 'BRAVO unhandled')])]);
    await sweepHookEvents();
    expect(mockFire).toHaveBeenCalledTimes(1);
    const prompt = mockFire.mock.calls[0][0].prompt;
    expect(prompt).toContain('BRAVO unhandled');
    expect(prompt).not.toContain('ALPHA handled');
  });

  it('kill switch: the escalation delivers untouched — with its NEUTRAL enqueue-time prompt, never a claim it was not handled', async () => {
    process.env.HOOK_FLEET_ALARM_PS_FIRST_DISABLED = '1';
    hwm(10);
    setRows([escRow('e1', [al(50, 'OOM on shard 3')])]);
    await sweepHookEvents();
    expect(mockFire).toHaveBeenCalledTimes(1);
    expect(mockFire.mock.calls[0][0].prompt).toContain('check its chat before acting — it may already have handled them');
    expect(mockFire.mock.calls[0][0].prompt).not.toContain('has not completed a wake');
    expect(metricPhases()).toEqual([]);
  });

  it('revalidatePsEscalations passes non-escalation rows through untouched', async () => {
    const plain = { id: 'x', payload: { summary: 'a todo wake' } };
    expect(await revalidatePsEscalations('h-self', 'c-fleet', [plain])).toEqual([plain]);
  });
});

describe('held escalations never ride', () => {
  const held = () => escRow('e-held', [al(5, 'fresh alarm')], { retryAt: new Date(Date.now() + 40 * MIN) });

  it('the run-finalize drain (ignoreRetryAt) does not deliver a held escalation', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(selfHook());
    setRows([held()]);
    await sweepHookEvents({ targetChatId: 'c-fleet', ignoreRetryAt: true });
    expect(mockFire).not.toHaveBeenCalled();
  });

  it('a window drain on the Fleet\'s direct-wake hook leaves the held escalation behind', async () => {
    mockPrisma.eventHook.findUnique.mockResolvedValue(selfHook());
    const other = { id: 'w1', hookId: 'h-self', userId: 'u1', eventType: TODO_WAKE_EVENT_TYPE, status: 'pending', attempts: 0, createdAt: new Date(), retryAt: null,
      payload: { origin: 'infra-watch', eventType: TODO_WAKE_EVENT_TYPE, sourceChatId: 'c-fleet', summary: '[INFRA ALERT] disk', depth: 0 } };
    setRows([other], [held()]);
    await sweepHookEvents();
    expect(mockFire).toHaveBeenCalledTimes(1);
    expect(mockFire.mock.calls[0][0].prompt).not.toContain('PS ESCALATION');
  });

  it('hooks-first arbitration does not yield to a held escalation; un-park keeps its retryAt', async () => {
    const now = new Date();
    mockPrisma.hookEvent.findMany.mockResolvedValue([{ ...held(), createdAt: new Date(now.getTime() - 30 * MIN), hook: { debounceSec: 0, lastFiredAt: null } }]);
    expect(await hooksFirstVerdict('c-fleet', { ageMs: 0, source: null }, now)).toMatchObject({ hooksFirst: false, reason: 'no_hooks' });

    mockPrisma.hookEvent.findMany.mockResolvedValue([{ id: 'e-held', payload: held().payload, retryAt: held().retryAt }, { id: 'b1', payload: { eventType: 'run_completed' }, retryAt: new Date(now.getTime() + MIN) }]);
    expect(await unparkHookEventsForTarget('c-fleet')).toBe(1);
    expect(mockPrisma.hookEvent.updateMany).toHaveBeenLastCalledWith({ where: { id: { in: ['b1'] }, status: 'pending' }, data: { retryAt: null } });
  });
});

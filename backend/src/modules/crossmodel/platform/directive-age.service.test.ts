/**
 * Directive age sweep pins (supervisor-directives-closure D2, 2026-09-27).
 *
 *  - An OPEN, non-standing, evidence-less directive ≥ 24h old earns ONE
 *    [FOLLOW-THROUGH — DIRECTIVE] direct wake per directive per 24h, naming
 *    id / age / scope / text; up to 5 named per wake, oldest first, folded
 *    into ONE wake; archived-but-open rows count and are labelled.
 *  - The wake asks for a dispatch id AS EVIDENCE on the OPEN row and a close
 *    only once the artifact landed (a dispatch is progress, not done).
 *  - Done / standing / evidenced / young rows never wake.
 *  - Review fix (bounded volume): DIRECTIVE_AGE_WAKE_MAX_PER_DAY (default 1)
 *    wakes per SUPERVISOR per 24h — the rest is withheld ('capped', ONE
 *    directive_follow_through row per supervisor per day); a first-deploy
 *    RAMP (DIRECTIVE_AGE_WAKE_RAMP_MS, default 48h from the sweep's first
 *    run) withholds every wake ('ramp' row) while the alarm line + metric run.
 *  - ONE directive_open_age row per supervisor chat per day (value = oldest
 *    open-without-evidence age in hours; 0 rows too).
 *  - Dedupe is an atomic SET NX: a Redis failure ⇒ nothing fires (storm-proof);
 *    a failed enqueue releases the claims AND refunds the daily slot.
 *  - Paused project supervisors, detached supervisors and the supervisor OFF
 *    switch skip.
 */
const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => []) },
  crossModelProject: { findMany: jest.fn(async () => []) },
  supervisorState: { findMany: jest.fn(async () => []) },
  systemSetting: { findUnique: jest.fn(async () => null) },
};
const store = new Map<string, string>();
let redisFail = false;
const mockRedis: any = {
  set: jest.fn(async (k: string, v: string, opts?: any) => {
    if (redisFail) throw new Error('redis down');
    if (opts?.NX && store.has(k)) return null;
    store.set(k, v);
    return 'OK';
  }),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
  get: jest.fn(async (k: string) => { if (redisFail) throw new Error('redis down'); return store.get(k) ?? null; }),
  incr: jest.fn(async (k: string) => {
    if (redisFail) throw new Error('redis down');
    const n = Number(store.get(k) ?? 0) + 1; store.set(k, String(n)); return n;
  }),
  decr: jest.fn(async (k: string) => { const n = Number(store.get(k) ?? 0) - 1; store.set(k, String(n)); return n; }),
  expire: jest.fn(async () => 1),
};
const mockRecordLoopMetric = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a), recordLoopMetrics: jest.fn() }));

import {
  sweepDirectiveAge, renderDirectiveFollowThroughWake, directiveAgeStats, directiveAgeRampActive,
  DIRECTIVE_AGE_WAKE_MAX_NAMED, DIRECTIVE_WAKE_PREFIX, WAKE_KEY, METRIC_KEY, WAKE_CAP_KEY, WITHHELD_KEY, LIVE_SINCE_KEY,
  DIRECTIVE_AGE_WAKE_MAX_PER_DAY_ENV, DIRECTIVE_AGE_WAKE_RAMP_MS_ENV, DIRECTIVE_AGE_WAKE_RAMP_MS_DEFAULT,
} from './directive-age.service';
import { type SupervisorStateDoc } from './supervisor-state.service';
import { invalidateSupervisorSwitchCache, resetSupervisorSwitchMetricWindowForTests } from './supervisor-switch';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const FLEET = 'f1ee7000-0000-4000-8000-000000000000';
const PROJ_SUP = 'c0e22e36-0000-4000-8000-000000000000';
const PROJECT = 'p-canlaw';
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const EMPTY: SupervisorStateDoc = { directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '' };
const dir = (id: string, ageH: number, extra: Record<string, unknown> = {}) => ({ id, text: `order ${id}`, at: hoursAgo(ageH), status: 'open', ...extra });

const fleetRow = { id: FLEET, userId: 'u1', title: 'Fleet Supervisor', projectId: null, isSupervisor: true, isProjectSupervisor: false };
const projRow = { id: PROJ_SUP, userId: 'u1', title: 'CanLaw Supervisor', projectId: PROJECT, isSupervisor: false, isProjectSupervisor: true };

let wake: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  redisFail = false;
  delete process.env[DIRECTIVE_AGE_WAKE_MAX_PER_DAY_ENV];
  // The ramp is exercised by its own tests; every other case runs past it.
  process.env[DIRECTIVE_AGE_WAKE_RAMP_MS_ENV] = '0';
  wake = jest.fn(async () => ({ ok: true, hookEventId: 'he1' }));
  mockPrisma.crossModelChat.findMany.mockResolvedValue([fleetRow, projRow]);
  mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: PROJECT, projectSupervisorEnabled: true, archivedAt: null }]);
  mockPrisma.supervisorState.findMany.mockResolvedValue([]);
  mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
  invalidateSupervisorSwitchCache();
  resetSupervisorSwitchMetricWindowForTests();
});
afterAll(() => { delete process.env[DIRECTIVE_AGE_WAKE_RAMP_MS_ENV]; });

const seed = (rows: Array<{ chatId: string; state: unknown }>) => mockPrisma.supervisorState.findMany.mockResolvedValue(rows);
const metricsOf = (kind: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m.kind === kind);
const ZERO = { supervisors: 0, wakes: 0, metrics: 0, withheld: 0 };

describe('renderDirectiveFollowThroughWake', () => {
  it('names id / age / scope / text, labels archived rows, caps at 5, counts the rest, and asks for evidence-on-open before any close', () => {
    const rows: any[] = [
      { id: 'aaaaaaaa-1', text: 'move the H100 job to the new pool', at: hoursAgo(41), status: 'open', scope: 'canlaw', ageMs: 41 * 3_600_000, archived: false },
      { id: 'bbbbbbbb-1', text: 'archived one', at: hoursAgo(200), status: 'open', ageMs: 200 * 3_600_000, archived: true },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `cccccccc-${i}`, text: `c${i}`, at: hoursAgo(30), status: 'open', ageMs: 30 * 3_600_000, archived: false })),
    ];
    const text = renderDirectiveFollowThroughWake(rows, NOW);
    expect(text.startsWith(`${DIRECTIVE_WAKE_PREFIX} 5 owner directive(s) have been OPEN for over 24h with NO evidence`)).toBe(true);
    expect(text).toContain('- [aaaaaaaa-1] open 41h [scope: canlaw]: "move the H100 job to the new pool"');
    expect(text).toContain('- [bbbbbbbb-1] open 8d [ARCHIVED-but-open');
    expect(text).toContain('(+2 more overdue');
    expect(text).toContain("evidence:'blocked:");
    // Review fix: a dispatch id is evidence on the OPEN row; the close waits for the artifact.
    expect(text).toContain("evidence:'dispatched: session <id>'");
    expect(text).toContain("status:'done', evidence:'<type> <id>'");
    expect(text).toContain('a dispatch is progress, not done');
    expect(text).toMatch(/Close it .*ONLY once the artifact has landed/);
    expect((text.match(/^- \[/gm) ?? []).length).toBe(DIRECTIVE_AGE_WAKE_MAX_NAMED);
  });
});

describe('directiveAgeStats', () => {
  it('counts open (live+archived), evidence-less, over-alarm and archived-open rows; value = oldest evidence-less age in hours', () => {
    const doc: SupervisorStateDoc = {
      ...EMPTY,
      directives: [dir('a', 60), dir('b', 10), dir('c', 100, { evidence: 'blocked: x' }), dir('d', 100, { status: 'done', evidence: 'pr #1' }), dir('e', 300, { standing: true })] as any,
      archived: [dir('f', 400, { archivedAt: hoursAgo(1) })] as any,
    };
    expect(directiveAgeStats(doc, NOW)).toEqual({
      open: 5, openNoEvidence: 3, overAlarm: 2, archivedOpen: 1, oldestAgeHours: 400, oldestId: 'f', overdueIds: ['f', 'a'],
    });
    expect(directiveAgeStats(EMPTY, NOW).oldestAgeHours).toBe(0);
  });
});

describe('sweepDirectiveAge', () => {
  it('wakes ONCE per directive per 24h with the overdue rows named, records directive_follow_through (fired), and skips young/done/standing/evidenced rows', async () => {
    seed([{ chatId: FLEET, state: { ...EMPTY, directives: [
      dir('old-1111', 41, { scope: 'canlaw' }), dir('young', 5), dir('standing', 100, { standing: true }),
      dir('done', 100, { status: 'done', evidence: 'session 12345678' }), dir('blocked', 100, { evidence: 'blocked: waiting on oq_12345678' }),
      dir('dispatched', 100, { evidence: 'dispatched: session abcdef12' }),
    ] } }]);
    const r = await sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake });
    expect(r).toEqual({ supervisors: 2, wakes: 1, metrics: 1, withheld: 0 });
    expect(wake).toHaveBeenCalledTimes(1);
    const call = wake.mock.calls[0][0];
    expect(call.targetChatId).toBe(FLEET);
    expect(call.prompt).toContain('- [old-1111] open 41h [scope: canlaw]: "order old-1111"');
    expect(call.prompt).not.toMatch(/order (young|standing|done|blocked|dispatched)/);
    expect(call.meta).toEqual({ origin: 'directive-age', kind: 'directive_follow_through', directiveIds: ['old-1111'] });
    expect(store.has(WAKE_KEY(FLEET, 'old-1111'))).toBe(true);
    expect(store.get(WAKE_CAP_KEY(FLEET))).toBe('1');
    expect(metricsOf('directive_follow_through')).toEqual([expect.objectContaining({ sessionId: FLEET, meta: expect.objectContaining({ outcome: 'fired', directiveIds: ['old-1111'], oldestAgeHours: 41, overdue: 1 }) })]);
    // Second sweep inside the window: nothing fires again (the claim holds) and nothing is "withheld" — the row was named.
    wake.mockClear(); mockRecordLoopMetric.mockClear();
    const r2 = await sweepDirectiveAge({ now: new Date(NOW.getTime() + 3_600_000), enqueueDirectWake: wake });
    expect(r2.wakes).toBe(0);
    expect(r2.withheld).toBe(0);
    expect(wake).not.toHaveBeenCalled();
  });

  it('archived-but-open rows count (the D2 blind spot) and are labelled in the wake', async () => {
    seed([{ chatId: PROJ_SUP, state: { ...EMPTY, archived: [dir('arch-2222', 300, { archivedAt: hoursAgo(2) })] } }]);
    const r = await sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake });
    expect(r.wakes).toBe(1);
    expect(wake.mock.calls[0][0].targetChatId).toBe(PROJ_SUP);
    expect(wake.mock.calls[0][0].prompt).toContain('[arch-2222] open 12d [ARCHIVED-but-open');
    expect(metricsOf('directive_follow_through')[0].meta).toEqual(expect.objectContaining({ archivedNamed: 1, projectId: PROJECT }));
  });

  it('folds a long ledger into ONE wake naming the 5 oldest; the DAILY CAP (default 1) withholds the rest with ONE capped row per day', async () => {
    const directives = Array.from({ length: 8 }, (_, i) => dir(`d${i}-xxxxxx`, 30 + i));
    seed([{ chatId: FLEET, state: { ...EMPTY, directives } }]);
    const r = await sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake });
    expect(r.wakes).toBe(1);
    const prompt = wake.mock.calls[0][0].prompt as string;
    expect((prompt.match(/^- \[/gm) ?? []).length).toBe(5);
    expect(prompt).toContain('[d7-xxxxxx] open 37h'); // oldest first
    expect(prompt).toContain('(+3 more overdue');
    expect(wake.mock.calls[0][0].meta.directiveIds).toHaveLength(5);
    // Next sweep (15 min): the 3 unclaimed rows would fire but the supervisor's daily slot is spent —
    // withheld, claims released (they get the next allowed wake), ONE 'capped' row.
    wake.mockClear(); mockRecordLoopMetric.mockClear();
    const r2 = await sweepDirectiveAge({ now: new Date(NOW.getTime() + 900_000), enqueueDirectWake: wake });
    expect(r2).toEqual({ supervisors: 2, wakes: 0, metrics: 0, withheld: 1 });
    expect(wake).not.toHaveBeenCalled();
    expect(store.has(WAKE_KEY(FLEET, 'd2-xxxxxx'))).toBe(false);
    expect(store.has(WITHHELD_KEY(FLEET))).toBe(true);
    expect(metricsOf('directive_follow_through')).toEqual([expect.objectContaining({ sessionId: FLEET, meta: expect.objectContaining({ outcome: 'capped', directiveIds: ['d2-xxxxx', 'd1-xxxxx', 'd0-xxxxx'], overdue: 8 }) })]);
    // A third sweep the same day: still withheld, but NO second capped row (once per day).
    mockRecordLoopMetric.mockClear();
    const r3 = await sweepDirectiveAge({ now: new Date(NOW.getTime() + 1_800_000), enqueueDirectWake: wake });
    expect(r3.wakes).toBe(0);
    expect(r3.withheld).toBe(0);
    expect(metricsOf('directive_follow_through')).toHaveLength(0);
  });

  it('DIRECTIVE_AGE_WAKE_MAX_PER_DAY raises the per-supervisor bound (2 ⇒ the rest fire on the next sweep); 0 ⇒ no wakes, still measured', async () => {
    process.env[DIRECTIVE_AGE_WAKE_MAX_PER_DAY_ENV] = '2';
    const directives = Array.from({ length: 8 }, (_, i) => dir(`d${i}-xxxxxx`, 30 + i));
    seed([{ chatId: FLEET, state: { ...EMPTY, directives } }]);
    expect((await sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake })).wakes).toBe(1);
    wake.mockClear();
    const r2 = await sweepDirectiveAge({ now: new Date(NOW.getTime() + 900_000), enqueueDirectWake: wake });
    expect(r2.wakes).toBe(1);
    expect(wake.mock.calls[0][0].meta.directiveIds).toEqual(['d2-xxxxxx', 'd1-xxxxxx', 'd0-xxxxxx']);
    expect(store.get(WAKE_CAP_KEY(FLEET))).toBe('2');
    // Cap 0: nothing fires, the ledger is still measured and the withholding is recorded.
    store.clear(); wake.mockClear(); mockRecordLoopMetric.mockClear();
    process.env[DIRECTIVE_AGE_WAKE_MAX_PER_DAY_ENV] = '0';
    const r3 = await sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake });
    expect(r3).toEqual({ supervisors: 2, wakes: 0, metrics: 1, withheld: 1 });
    expect(metricsOf('directive_open_age')).toHaveLength(1);
    expect(metricsOf('directive_follow_through')[0].meta.outcome).toBe('capped');
    // An invalid value falls back to the default (1).
    store.clear(); wake.mockClear();
    process.env[DIRECTIVE_AGE_WAKE_MAX_PER_DAY_ENV] = 'lots';
    expect((await sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake })).wakes).toBe(1);
  });

  it('first-deploy RAMP: no wakes for 48h after the first sweep — alarm line + metric only, ONE ramp row per supervisor per day; wakes resume after', async () => {
    delete process.env[DIRECTIVE_AGE_WAKE_RAMP_MS_ENV];
    seed([{ chatId: FLEET, state: { ...EMPTY, directives: [dir('pre-existing', 400)] } }]);
    const r = await sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake });
    expect(r).toEqual({ supervisors: 2, wakes: 0, metrics: 1, withheld: 1 });
    expect(wake).not.toHaveBeenCalled();
    expect(store.get(LIVE_SINCE_KEY)).toBe(String(NOW.getTime()));
    expect(store.has(WAKE_KEY(FLEET, 'pre-existing'))).toBe(false); // claim released for the post-ramp wake
    expect(store.has(WAKE_CAP_KEY(FLEET))).toBe(false); // no daily slot consumed
    expect(metricsOf('directive_follow_through')).toEqual([expect.objectContaining({ sessionId: FLEET, meta: expect.objectContaining({ outcome: 'ramp', directiveIds: ['pre-exis'], overdue: 1 }) })]);
    // Inside the ramp: still nothing, and no second ramp row.
    mockRecordLoopMetric.mockClear();
    const r2 = await sweepDirectiveAge({ now: new Date(NOW.getTime() + 3_600_000), enqueueDirectWake: wake });
    expect(r2.wakes).toBe(0);
    expect(r2.withheld).toBe(0);
    // Past the ramp: the wake fires.
    const later = new Date(NOW.getTime() + DIRECTIVE_AGE_WAKE_RAMP_MS_DEFAULT + 1);
    expect(await directiveAgeRampActive(later)).toBe(false);
    const r3 = await sweepDirectiveAge({ now: later, enqueueDirectWake: wake });
    expect(r3.wakes).toBe(1);
    expect(wake.mock.calls[0][0].prompt).toContain('[pre-existing]');
    // An unreadable stamp (Redis down) counts as in-ramp — the storm-proof default.
    redisFail = true;
    expect(await directiveAgeRampActive(later)).toBe(true);
    redisFail = false;
    // Ramp disabled ⇒ never active, no stamp written.
    store.clear();
    process.env[DIRECTIVE_AGE_WAKE_RAMP_MS_ENV] = '0';
    expect(await directiveAgeRampActive(NOW)).toBe(false);
    expect(store.has(LIVE_SINCE_KEY)).toBe(false);
  });

  it('records ONE directive_open_age row per supervisor chat per day — zero rows included', async () => {
    seed([
      { chatId: FLEET, state: { ...EMPTY, directives: [dir('a', 60), dir('b', 5)] } },
      { chatId: PROJ_SUP, state: { ...EMPTY, directives: [dir('c', 100, { evidence: 'blocked: x' })] } },
    ]);
    const r = await sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake });
    expect(r.metrics).toBe(2);
    const rows = metricsOf('directive_open_age');
    expect(rows).toHaveLength(2);
    expect(rows.find((m) => m.sessionId === FLEET)).toEqual(expect.objectContaining({ value: 60, unit: 'h', meta: expect.objectContaining({ open: 2, openNoEvidence: 2, overAlarm: 1, archivedOpen: 0, oldestId: 'a' }) }));
    expect(rows.find((m) => m.sessionId === PROJ_SUP)).toEqual(expect.objectContaining({ value: 0, meta: expect.objectContaining({ open: 1, openNoEvidence: 0, projectId: PROJECT }) }));
    expect(store.has(METRIC_KEY(FLEET))).toBe(true);
    mockRecordLoopMetric.mockClear();
    const r2 = await sweepDirectiveAge({ now: new Date(NOW.getTime() + 3_600_000), enqueueDirectWake: wake });
    expect(r2.metrics).toBe(0);
    expect(metricsOf('directive_open_age')).toHaveLength(0);
  });

  it('a Redis failure fires NOTHING (storm-proof); a failed enqueue releases the claims and refunds the daily slot for the next sweep', async () => {
    seed([{ chatId: FLEET, state: { ...EMPTY, directives: [dir('old-3333', 50)] } }]);
    redisFail = true;
    const r = await sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake });
    expect(r).toEqual({ supervisors: 2, wakes: 0, metrics: 0, withheld: 0 });
    expect(wake).not.toHaveBeenCalled();
    redisFail = false;
    const failing = jest.fn(async () => ({ ok: false, error: 'target chat not found' }));
    const r2 = await sweepDirectiveAge({ now: NOW, enqueueDirectWake: failing });
    expect(r2.wakes).toBe(0);
    expect(store.has(WAKE_KEY(FLEET, 'old-3333'))).toBe(false);
    expect(store.get(WAKE_CAP_KEY(FLEET))).toBe('0'); // refunded
    expect(metricsOf('directive_follow_through')).toHaveLength(0);
    const r3 = await sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake });
    expect(r3.wakes).toBe(1);
  });

  it('skips paused project supervisors, detached supervisors and the switched-off tier', async () => {
    seed([
      { chatId: FLEET, state: { ...EMPTY, directives: [dir('f-old', 50)] } },
      { chatId: PROJ_SUP, state: { ...EMPTY, directives: [dir('p-old', 50)] } },
    ]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: PROJECT, projectSupervisorEnabled: false, archivedAt: null }]);
    const r = await sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake });
    expect(r.supervisors).toBe(1);
    expect(wake.mock.calls.map((c) => c[0].targetChatId)).toEqual([FLEET]);
    // Detached (projectId null) project supervisor is never scanned.
    store.clear(); wake.mockClear();
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ ...projRow, projectId: null }]);
    expect((await sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake })).supervisors).toBe(0);
    // Supervisor OFF switch (fleet) — the fleet lane drops.
    store.clear(); wake.mockClear();
    mockPrisma.crossModelChat.findMany.mockResolvedValue([fleetRow]);
    mockPrisma.systemSetting.findUnique.mockImplementation(async ({ where }: any) => (where.key === 'fleet_supervisor_enabled' ? { key: where.key, value: '0', updatedAt: NOW } : null));
    invalidateSupervisorSwitchCache();
    expect((await sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake })).supervisors).toBe(0);
    expect(wake).not.toHaveBeenCalled();
    expect(metricsOf('supervisor_switch')).toEqual([expect.objectContaining({ sessionId: FLEET, meta: expect.objectContaining({ target: 'fleet', action: 'skipped', source: 'directive-age' }) })]);
  });

  it('never throws: a listing failure returns zero counters', async () => {
    mockPrisma.crossModelChat.findMany.mockRejectedValue(new Error('db down'));
    await expect(sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake })).resolves.toEqual(ZERO);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([fleetRow]);
    mockPrisma.supervisorState.findMany.mockRejectedValue(new Error('db down'));
    await expect(sweepDirectiveAge({ now: NOW, enqueueDirectWake: wake })).resolves.toEqual({ ...ZERO, supervisors: 1 });
  });
});

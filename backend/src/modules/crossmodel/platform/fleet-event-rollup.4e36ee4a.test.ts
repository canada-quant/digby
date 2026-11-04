/**
 * Fleet-event KPI rollup (ticket 4e36ee4a) — replay tests for the DURABLE
 * aggregate ledger of fleet-event emissions.
 *
 * The gap (byte-verified 2026-09-17 audit): HookEvent is a per-delivery
 * OUTBOX — terminal rows are GC'd after 30 days (coding/run-reaper.ts) and an
 * emission with ZERO subscribers persists no row at all (hooks.service.ts
 * short-circuits before any insert) — so fleet-activity KPIs were
 * unmeasurable beyond 30 days and invisible when unsubscribed. loop_metrics
 * was rejected as the home: sweepLoopMetrics GCs it at 30 days too.
 *
 * Pins (the ticket's acceptance):
 *   (i)   a ZERO-subscriber emission still increments the ledger;
 *   (ii)  an N-subscriber emission increments emitted by 1, delivered by N;
 *   (iii) same-day same-type emissions ACCUMULATE (two emissions → two +1
 *         increments against the same (day, eventType) key);
 *   (iv)  a ledger write FAILURE does not break emission (forced reject →
 *         fan-out still happens, warn logged);
 *   (v)   the run-reaper GC leaves ledger rows untouched (code-level pin:
 *         run-reaper.ts never references the rollup model);
 *   (vi)  the read surface (fleetEventKpis) aggregates correctly over a
 *         multi-day seed, plus the get_fleet_telemetry 'fleetEvents' wire.
 * Extra design pins: depth-cap drops are NOT counted (the ladder killed them,
 * they were never emitted); delivered counts only rows actually written;
 * the enqueueDirectWake lane (todo_wake, bypasses emitHookEvent) counts too.
 *
 * Mock discipline mirrors hooks.service.test.ts (colocated mock-everything).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  eventHook: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  hookEvent: {
    create: jest.fn(async () => ({})),
  },
  crossModelChat: { findUnique: jest.fn() },
  fleetEventRollup: {
    upsert: jest.fn(async () => ({})),
    findMany: jest.fn(async () => []),
  },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedisGet: jest.Mock = jest.fn(async () => null);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: (...a: any[]) => mockRedisGet(...a),
    set: jest.fn(async () => 'OK'),
    del: jest.fn(async () => 1),
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

// crossmodel.service's real module pulls the model integrations + DB/env chains —
// mock the boundary (hooks.service only needs getChatAccess).
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: jest.fn(async () => ({ access: 'owner', exists: true })) },
}));

// The delivery path (schedule.service's machine-run fire) — not under test here.
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: jest.fn(async () => ({ started: true })),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
  notifyDailyCapOnce: jest.fn(async () => {}),
  claimCapWindowGate: jest.fn(async () => true),
}));

// Loop-metrics: mocked so no real buffer/DB path loads (the ledger module under
// test is REAL — its prisma is the mocked client above).
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: {
    WAKE_DELIVERED: 'wake_delivered',
    WAKE_CAPPED: 'wake_capped',
    WAKE_PARKED: 'wake_parked',
    HOOK_QUIET_EVENT_SHED: 'hook_quiet_event_shed',
    HOOK_STALE_SUPPRESSED: 'hook_stale_suppressed',
  },
}));

import * as fs from 'fs';
import * as path from 'path';
import { emitHookEvent, enqueueDirectWake, MAX_HOOK_DEPTH, TODO_WAKE_EVENT_TYPE } from './hooks.service';
import {
  fleetEventKpis, fleetEventUtcDay, __resetFleetEventRollupForTest,
  FLEET_EVENT_KPIS_DEFAULT_DAYS, FLEET_EVENT_KPIS_MAX_DAYS, FLEET_EVENT_ROLLUP_MAX_READ_ROWS,
} from './fleet-event-rollup.service';
import { fleetTelemetry, clampTelemetryArgs } from '../fleet/fleet-telemetry';
import logger from '../../../utils/logger';

const hookRow = (over: any = {}) => ({
  id: 'h1', userId: 'u1', sourceChatId: 'c-src', targetChatId: 'c-tgt',
  eventTypes: ['run_completed'], promptTemplate: '', enabled: true,
  debounceSec: 60, lastFiredAt: null,
  createdAt: new Date('2026-08-01T00:00:00Z'), updatedAt: new Date('2026-08-01T00:00:00Z'),
  ...over,
});

/** The ledger writes are fire-and-forget floating promises — drain them. */
const flushLedger = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

const upsertCalls = () => mockPrisma.fleetEventRollup.upsert.mock.calls.map((c: any[]) => c[0]);

beforeEach(() => {
  jest.clearAllMocks();
  __resetFleetEventRollupForTest();
  mockRedisGet.mockResolvedValue(null); // depth stamp absent → depth 0
  mockPrisma.fleetEventRollup.upsert.mockResolvedValue({});
  mockPrisma.fleetEventRollup.findMany.mockResolvedValue([]);
  mockPrisma.hookEvent.create.mockResolvedValue({});
  // The emission's source-chat lookup (title + owner + project lanes).
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({
    title: 'Source Chat', userId: 'u1', projectId: null, isProjectSupervisor: false, project: null,
  });
});

/* ====================================================================
 * Write path (4e36ee4a) — emission-time, subscriber-independent, lossy-safe
 * ==================================================================== */
describe('fleet-event rollup write path (ticket 4e36ee4a)', () => {
  it('4e36ee4a (i): a ZERO-subscriber emission still increments the ledger (the invisible-event case)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([]); // nobody subscribed
    await emitHookEvent('c-src', 'run_completed', 'All good');
    await flushLedger();

    const calls = upsertCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].where).toEqual({
      day_eventType: { day: fleetEventUtcDay(), eventType: 'run_completed' },
    });
    expect(calls[0].update).toEqual({ emitted: { increment: 1 } });
    expect(calls[0].create).toEqual({
      day: fleetEventUtcDay(), eventType: 'run_completed', emitted: 1, delivered: 0,
    });
    // ...and the emission really was zero-subscriber: the subscriber query ran
    // and no outbox row was written, yet the ledger still moved.
    expect(mockPrisma.eventHook.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.hookEvent.create).not.toHaveBeenCalled();
  });

  it('4e36ee4a (ii): an N-subscriber emission increments emitted by 1 and delivered by N', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hookRow(),
      hookRow({ id: 'h2', targetChatId: 'c-tgt2' }),
      hookRow({ id: 'h3', targetChatId: 'c-tgt3' }),
    ]);
    await emitHookEvent('c-src', 'run_completed', 'All good');
    await flushLedger();

    expect(mockPrisma.hookEvent.create).toHaveBeenCalledTimes(3);
    const calls = upsertCalls();
    expect(calls).toHaveLength(2);
    // emitted half — written BEFORE the subscriber short-circuit could exist.
    expect(calls[0].update).toEqual({ emitted: { increment: 1 } });
    // delivered half — exactly the fan-out count, same (day, eventType) key.
    expect(calls[1].where).toEqual(calls[0].where);
    expect(calls[1].update).toEqual({ delivered: { increment: 3 } });
    expect(calls[1].create).toEqual({
      day: fleetEventUtcDay(), eventType: 'run_completed', emitted: 0, delivered: 3,
    });
  });

  it('4e36ee4a (iii): same-day same-type emissions ACCUMULATE against one (day, eventType) key', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([]);
    await emitHookEvent('c-src', 'todo_done', 'first');
    await emitHookEvent('c-src', 'todo_done', 'second');
    await flushLedger();

    const calls = upsertCalls();
    expect(calls).toHaveLength(2);
    // Two +1 increments against the SAME upsert key — the DB accumulates them
    // into one row (emitted=2), keyed on the UTC day, not the clock instant.
    expect(calls[0].where).toEqual({
      day_eventType: { day: fleetEventUtcDay(), eventType: 'todo_done' },
    });
    expect(calls[1].where).toEqual(calls[0].where);
    expect(calls[0].update).toEqual({ emitted: { increment: 1 } });
    expect(calls[1].update).toEqual({ emitted: { increment: 1 } });
  });

  it('4e36ee4a (iv): a ledger write FAILURE does not break emission — fan-out proceeds, warn logged', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([hookRow()]);
    mockPrisma.fleetEventRollup.upsert.mockRejectedValueOnce(new Error('db down')); // the emitted bump dies
    await expect(emitHookEvent('c-src', 'run_completed', 'All good')).resolves.toBeUndefined();
    await flushLedger();

    // The outbox row was still written and the delivered bump still attempted.
    expect(mockPrisma.hookEvent.create).toHaveBeenCalledTimes(1);
    expect(upsertCalls()).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fleet-event-rollup'));
  });

  it('4e36ee4a: delivered counts only outbox rows ACTUALLY written (a failed insert is not delivered)', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hookRow(),
      hookRow({ id: 'h2', targetChatId: 'c-tgt2' }),
    ]);
    mockPrisma.hookEvent.create
      .mockRejectedValueOnce(new Error('insert blew up')) // h1's row dies
      .mockResolvedValueOnce({}); // h2's row lands
    await emitHookEvent('c-src', 'run_completed', 'All good');
    await flushLedger();

    const calls = upsertCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].update).toEqual({ delivered: { increment: 1 } }); // only the written row
  });

  it('4e36ee4a: depth-cap drops are NOT counted — the ladder killed them before emission', async () => {
    mockRedisGet.mockResolvedValue(String(MAX_HOOK_DEPTH)); // stamped at the cap
    await emitHookEvent('c-src', 'run_completed', 'too deep');
    await flushLedger();
    expect(mockPrisma.fleetEventRollup.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.findMany).not.toHaveBeenCalled();
  });

  it('4e36ee4a: the enqueueDirectWake lane (todo_wake — bypasses emitHookEvent) counts emitted + delivered', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', title: 'Target Chat' });
    mockPrisma.eventHook.findFirst.mockResolvedValue(hookRow({ id: 'h-direct', eventTypes: [TODO_WAKE_EVENT_TYPE], debounceSec: 0 }));
    mockPrisma.hookEvent.create.mockResolvedValue({ id: 'e-direct' });

    const res = await enqueueDirectWake({ targetChatId: 'c-tgt', prompt: 'Todo unblocked — start now' });
    expect(res.ok).toBe(true);
    await flushLedger();

    const calls = upsertCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].where.day_eventType.eventType).toBe(TODO_WAKE_EVENT_TYPE);
    expect(calls[0].update).toEqual({ emitted: { increment: 1 } });
    expect(calls[1].where).toEqual(calls[0].where);
    expect(calls[1].update).toEqual({ delivered: { increment: 1 } });
  });
});

/* ====================================================================
 * Durability (4e36ee4a) — the reaper GC must never touch the ledger
 * ==================================================================== */
describe('fleet-event rollup durability (ticket 4e36ee4a)', () => {
  it('4e36ee4a (v): the run-reaper GC leaves ledger rows untouched (code-level pin)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'coding', 'run-reaper.ts'), 'utf8');
    // Sanity that we read the right file — the outbox + loop_metrics GCs the
    // ticket cites are both here...
    expect(source).toContain('hookEvent.deleteMany');
    expect(source).toContain('sweepLoopMetrics');
    // ...and the durable ledger is NOT: no deleteMany, no sweep, no reference
    // at all. If a future change adds a retention for this table, this pin
    // trips and forces a deliberate choice (the table exists BECAUSE the
    // outbox and loop_metrics die at 30 days).
    expect(source).not.toMatch(/fleetEventRollup|fleet_event_rollups?/i);
  });
});

/* ====================================================================
 * Read path (4e36ee4a) — fleetEventKpis + the get_fleet_telemetry wire
 * ==================================================================== */
describe('fleet-event rollup read surface (ticket 4e36ee4a)', () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const seed = () =>
    mockPrisma.fleetEventRollup.findMany.mockResolvedValue([
      { day: d('2026-09-17'), eventType: 'run_completed', emitted: 2, delivered: 5 },
      { day: d('2026-09-17'), eventType: 'todo_done', emitted: 1, delivered: 1 },
      { day: d('2026-09-18'), eventType: 'run_completed', emitted: 3, delivered: 4 },
      { day: d('2026-09-18'), eventType: 'schedule_cap_skipped', emitted: 2, delivered: 0 },
    ]);

  it('4e36ee4a (vi): fleetEventKpis aggregates a multi-day seed — per-type totals, grand totals, day series', async () => {
    seed();
    const kpis = await fleetEventKpis({ days: 7 });

    expect(kpis.days).toBe(7);
    expect(kpis.totals).toEqual({ emitted: 8, delivered: 10, eventTypes: 3 });
    // Per-type sums, emitted-desc.
    expect(kpis.byEventType).toEqual([
      { eventType: 'run_completed', emitted: 5, delivered: 9 },
      { eventType: 'schedule_cap_skipped', emitted: 2, delivered: 0 },
      { eventType: 'todo_done', emitted: 1, delivered: 1 },
    ]);
    // The raw day × type series passes through, day serialized YYYY-MM-DD.
    expect(kpis.rows).toEqual([
      { day: '2026-09-17', eventType: 'run_completed', emitted: 2, delivered: 5 },
      { day: '2026-09-17', eventType: 'todo_done', emitted: 1, delivered: 1 },
      { day: '2026-09-18', eventType: 'run_completed', emitted: 3, delivered: 4 },
      { day: '2026-09-18', eventType: 'schedule_cap_skipped', emitted: 2, delivered: 0 },
    ]);
    // Window math: a UTC-midnight lower bound, days-1 back from today.
    expect(kpis.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(kpis.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const q = mockPrisma.fleetEventRollup.findMany.mock.calls[0][0];
    expect(q.where.day.gte).toBeInstanceOf(Date);
    expect(q.where.day.gte.getUTCHours()).toBe(0);
    expect(q.where.day.gte.getUTCMinutes()).toBe(0);
    expect(q.take).toBe(FLEET_EVENT_ROLLUP_MAX_READ_ROWS);
    // Window bounds are exactly `days` apart (since inclusive, until = today).
    const spanMs = new Date(`${kpis.until}T00:00:00Z`).getTime() - new Date(`${kpis.since}T00:00:00Z`).getTime();
    expect(spanMs).toBe(6 * 86_400_000);
  });

  it('4e36ee4a: the days window clamps — default 30, floor 1, ceiling FLEET_EVENT_KPIS_MAX_DAYS', async () => {
    await fleetEventKpis();
    expect(mockPrisma.fleetEventRollup.findMany).toHaveBeenCalledTimes(1);
    let kpis = await fleetEventKpis({ days: 0.5 });
    expect(kpis.days).toBe(FLEET_EVENT_KPIS_DEFAULT_DAYS); // garbage → default
    kpis = await fleetEventKpis({ days: 9999 });
    expect(kpis.days).toBe(FLEET_EVENT_KPIS_MAX_DAYS);
    kpis = await fleetEventKpis({ days: 1 });
    expect(kpis.days).toBe(1);
    expect(kpis.since).toBe(kpis.until); // a one-day window is exactly today
  });

  it("4e36ee4a: get_fleet_telemetry view 'fleetEvents' serves the ledger (hours map onto UTC days)", async () => {
    seed();
    const out: any = await fleetTelemetry(
      { view: 'fleetEvents', hours: 48 },
      { userId: 'u1', now: new Date('2026-09-19T05:00:00.000Z') },
    );
    expect(out.ok).toBe(true);
    expect(out.view).toBe('fleetEvents');
    expect(out.days).toBe(2); // 48h → ceil(48/24) UTC days
    expect(out.windowHours).toBe(48);
    expect(out.totals).toEqual({ emitted: 8, delivered: 10, eventTypes: 3 });
    expect(out.rows).toHaveLength(4);
    // ...and the view is a registered arg (the clamp no longer errors on it).
    expect(clampTelemetryArgs({ view: 'fleetEvents' })).toMatchObject({ view: 'fleetEvents' });
    expect(clampTelemetryArgs({})).toMatchObject({ error: expect.stringContaining("'fleetEvents'") });
  });
});

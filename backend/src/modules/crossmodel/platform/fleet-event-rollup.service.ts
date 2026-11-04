/**
 * Fleet-event KPI rollup (feedback 4e36ee4a) — the DURABLE aggregate ledger of
 * fleet-event emissions.
 *
 * Why this exists: the HookEvent outbox is a per-delivery OUTBOX, not a
 * ledger — terminal rows are GC'd after 30 days (coding/run-reaper.ts) and an
 * emission with ZERO subscribers persists no row at all (hooks.service.ts
 * short-circuits before any insert). loop_metrics was rejected as the home
 * for these KPIs: it is swept after 30 days too (sweepLoopMetrics, wired into
 * the same reaper pass), so nothing there survives the window the ticket
 * needs. This table (FleetEventRollup) has NO GC by design: one small row per
 * (UTC day, eventType), cardinality-bounded, so fleet-activity KPIs — events
 * by type, wakes fanned out, schedule_cap_skipped cap-skips — stay measurable
 * indefinitely, subscribed or not.
 *
 * Write path: noteFleetEventEmitted() / noteFleetEventDelivered(), called
 * from the two emission sites in hooks.service.ts (emitHookEvent — every
 * emission admitted past the depth ladder, BEFORE the zero-subscriber
 * short-circuit; enqueueDirectWake — the todo_wake lane that bypasses
 * emitHookEvent). Each call is ONE upsert-with-increment and is FIRE-AND-
 * FORGET: never awaited by the pipeline, never throws, a hiccup is one
 * throttled warn — the event pipeline must never fail because the ledger did.
 *
 * Read path: fleetEventKpis({ days }) — per-(day × eventType) rows plus
 * per-type and grand totals over a trailing window. Served as
 * get_fleet_telemetry view 'fleetEvents' (fleet/fleet-telemetry.ts). DB
 * errors PROPAGATE here (it is an admin/job read, not the write path).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';

// ── Write path: fire-and-forget upsert-with-increment ────────────────────────

let lastWarnAt = 0;

function warnThrottled(message: string): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  try {
    logger.warn(`fleet-event-rollup: ${message}`);
  } catch {
    /* even a broken logger must not surface */
  }
}

/** The rollup's day key: the UTC calendar day (midnight) containing `at`. */
export function fleetEventUtcDay(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function bumpFleetEventRollup(eventType: string, inc: { emitted?: number; delivered?: number }): void {
  try {
    const type = String(eventType ?? '').trim().slice(0, 64);
    if (!type) return;
    const emitted = Math.max(0, Math.floor(Number(inc.emitted ?? 0) || 0));
    const delivered = Math.max(0, Math.floor(Number(inc.delivered ?? 0) || 0));
    if (!emitted && !delivered) return;
    const day = fleetEventUtcDay();
    const update: { emitted?: { increment: number }; delivered?: { increment: number } } = {};
    if (emitted) update.emitted = { increment: emitted };
    if (delivered) update.delivered = { increment: delivered };
    // FIRE-AND-FORGET on purpose: the event pipeline never waits on the
    // ledger and never fails because it hiccuped — a rejected upsert is one
    // throttled warn, nothing else.
    void prisma.fleetEventRollup
      .upsert({
        where: { day_eventType: { day, eventType: type } },
        create: { day, eventType: type, emitted, delivered },
        update,
      })
      .catch((err: any) => warnThrottled(`upsert failed (non-fatal, ${type}): ${err?.message || err}`));
  } catch {
    /* never throws — the ledger must not take the event pipeline down */
  }
}

/**
 * Count ONE emission admitted past the depth ladder — INCLUDING the
 * zero-subscriber case (the ticket's invisible-event class: no HookEvent row
 * exists for it anywhere). Call BEFORE the subscriber-count short-circuit.
 */
export function noteFleetEventEmitted(eventType: string): void {
  bumpFleetEventRollup(eventType, { emitted: 1 });
}

/**
 * Count the emission's delivery fan-out — the HookEvent outbox rows actually
 * written (rows whose insert failed are logged at the site and not counted).
 * Call once the fan-out is known; a zero count writes nothing (the emitted
 * half already recorded the zero-delivery fact implicitly).
 */
export function noteFleetEventDelivered(eventType: string, count: number): void {
  bumpFleetEventRollup(eventType, { delivered: count });
}

// ── Read path: the KPI surface ───────────────────────────────────────────────

export const FLEET_EVENT_KPIS_DEFAULT_DAYS = 30;
/** The ledger is durable (no GC), so the window is a read bound, not a
 *  retention bound — a year-plus of daily rows is still tiny. */
export const FLEET_EVENT_KPIS_MAX_DAYS = 370;
/** Guard rail on rows read per query (day × eventType cardinality keeps the
 *  real count far below this). */
export const FLEET_EVENT_ROLLUP_MAX_READ_ROWS = 50_000;

export interface FleetEventRollupRowView {
  /** UTC day, YYYY-MM-DD */
  day: string;
  eventType: string;
  emitted: number;
  delivered: number;
}

export interface FleetEventKpis {
  /** trailing window actually queried (clamped to [1, FLEET_EVENT_KPIS_MAX_DAYS]) */
  days: number;
  /** window bounds, YYYY-MM-DD (UTC) — since is inclusive */
  since: string;
  until: string;
  totals: { emitted: number; delivered: number; eventTypes: number };
  /** per-eventType sums over the window, emitted-desc */
  byEventType: Array<{ eventType: string; emitted: number; delivered: number }>;
  /** the raw per-(day × eventType) rows, ascending — the chartable series */
  rows: FleetEventRollupRowView[];
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Fleet KPIs over a trailing window of UTC days (default 30): every
 * per-(day × eventType) rollup row in the window, per-type totals, and the
 * grand totals. DB errors propagate (admin/job read — never the write path).
 */
export async function fleetEventKpis(opts?: { days?: number }): Promise<FleetEventKpis> {
  const n = Math.floor(Number(opts?.days));
  const days = Number.isFinite(n) && n >= 1 ? Math.min(n, FLEET_EVENT_KPIS_MAX_DAYS) : FLEET_EVENT_KPIS_DEFAULT_DAYS;
  const until = fleetEventUtcDay();
  const since = new Date(until.getTime() - (days - 1) * 86_400_000);
  const rows = (await prisma.fleetEventRollup.findMany({
    where: { day: { gte: since } },
    orderBy: [{ day: 'asc' }, { eventType: 'asc' }],
    take: FLEET_EVENT_ROLLUP_MAX_READ_ROWS,
    select: { day: true, eventType: true, emitted: true, delivered: true },
  })) as Array<{ day: Date; eventType: string; emitted: number; delivered: number }>;

  const byType = new Map<string, { eventType: string; emitted: number; delivered: number }>();
  let emitted = 0;
  let delivered = 0;
  const views: FleetEventRollupRowView[] = [];
  for (const r of rows) {
    const e = Number(r.emitted) || 0;
    const d = Number(r.delivered) || 0;
    emitted += e;
    delivered += d;
    const acc = byType.get(r.eventType) ?? { eventType: r.eventType, emitted: 0, delivered: 0 };
    acc.emitted += e;
    acc.delivered += d;
    byType.set(r.eventType, acc);
    views.push({ day: isoDay(new Date(r.day)), eventType: r.eventType, emitted: e, delivered: d });
  }
  const byEventType = [...byType.values()].sort((a, b) => b.emitted - a.emitted || a.eventType.localeCompare(b.eventType));
  return {
    days,
    since: isoDay(since),
    until: isoDay(until),
    totals: { emitted, delivered, eventTypes: byEventType.length },
    byEventType,
    rows: views,
  };
}

// ── Test hook ────────────────────────────────────────────────────────────────

/** Resets the warn throttle. Tests only. */
export function __resetFleetEventRollupForTest(): void {
  lastWarnAt = 0;
}

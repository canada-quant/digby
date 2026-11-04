-- Durable fleet-event KPI ledger (feedback 4e36ee4a): one aggregate row per
-- (UTC day, eventType) with emitted/delivered counters, upsert-incremented at
-- emission time, INDEPENDENT of subscriber count and NEVER GC'd. The HookEvent
-- outbox deletes terminal rows after 30 days (coding/run-reaper.ts) and
-- emissions with zero subscribers persist no row at all (hooks.service.ts),
-- so fleet-activity KPIs (events by type, wakes fanned out, cap-skips) were
-- unmeasurable beyond 30 days and invisible when unsubscribed. loop_metrics
-- was rejected as the home for this — it is swept after 30 days too
-- (loop-metrics.service.ts sweepLoopMetrics). ADDITIVE ONLY: one new table,
-- no existing-row change. Cardinality is naturally bounded (day × eventType).

-- CreateTable
CREATE TABLE IF NOT EXISTS "fleet_event_rollups" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "eventType" TEXT NOT NULL,
    "emitted" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_event_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "fleet_event_rollups_day_eventType_key" ON "fleet_event_rollups"("day", "eventType");

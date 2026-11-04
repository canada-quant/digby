-- Scheduler remediation P3 (durable fleet bus + deaf-lane doors) — ADDITIVE ONLY.
-- v1#14 renewOnExhaustion + successor idempotency, v1#13 machine-cancel
-- durability, v1#33 busy-skip streak, v1#1 hook-outbox TTL-park.

-- CodingSchedule
ALTER TABLE "coding_schedules" ADD COLUMN "renewOnExhaustion" BOOLEAN;
ALTER TABLE "coding_schedules" ADD COLUMN "renewedFromId" TEXT;
ALTER TABLE "coding_schedules" ADD COLUMN "cancelledBy" TEXT;
ALTER TABLE "coding_schedules" ADD COLUMN "disabledAt" TIMESTAMP(3);
ALTER TABLE "coding_schedules" ADD COLUMN "busySkips" INTEGER NOT NULL DEFAULT 0;

-- Successor idempotency: at most ONE successor per exhausted predecessor
-- (Postgres unique indexes admit multiple NULLs, so non-successor rows are free).
CREATE UNIQUE INDEX "coding_schedules_renewedFromId_key" ON "coding_schedules"("renewedFromId");

-- HookEvent
ALTER TABLE "hook_events" ADD COLUMN "retryAt" TIMESTAMP(3);

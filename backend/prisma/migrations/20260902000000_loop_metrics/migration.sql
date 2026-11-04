-- Unified loop telemetry (audit roadmap #12): one row per counter/measurement
-- event emitted by the agentic loop (guard strikes/misses, wake scheduling
-- outcomes, per-run token/dollar spend, UX beacons, verify-queue waits).
-- sessionId/runId are SOFT refs by design (no FKs — telemetry must survive its
-- subject being GC'd, same rationale as run_tool_receipts.runId). Indexes:
-- [kind, createdAt] covers every per-kind windowed aggregation; [createdAt]
-- covers the retention sweep's range scan.

-- CreateTable
CREATE TABLE "loop_metrics" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sessionId" TEXT,
    "runId" TEXT,
    "value" DOUBLE PRECISION,
    "unit" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loop_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loop_metrics_kind_createdAt_idx" ON "loop_metrics"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "loop_metrics_createdAt_idx" ON "loop_metrics"("createdAt");

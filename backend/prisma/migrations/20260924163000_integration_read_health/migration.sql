-- Integration read-path health (ticket fa956f09, 2026-09-24): the 2026-09-22
-- X outage served empty x_search / x_get_trends results for a full day while
-- Account → Integrations kept showing X "connected" — "connected" only checks
-- the per-user OAuth row, and the platform-side read path (x-mcp → Bright
-- Data gateway) failed with no state recorded anywhere. One row per provider
-- holds the read path's LAST outcome so agents and the UI can see a degraded
-- integration instead of silently-empty results. Postgres (not a process-local
-- latch) because reads run in the worker process while the status API is
-- served by web — the row is the shared state both see.
-- ADDITIVE ONLY: a new table, no existing-row change, no backfill.

-- CreateTable
CREATE TABLE IF NOT EXISTS "integration_health" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_health_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "integration_health_provider_key" ON "integration_health"("provider");

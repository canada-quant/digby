-- CreateTable
CREATE TABLE "cron_jobs" (
    "id" TEXT NOT NULL,
    "intervalSec" INTEGER NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastFiredAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "workerId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cron_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cron_jobs_enabled_nextRunAt_idx" ON "cron_jobs"("enabled", "nextRunAt");


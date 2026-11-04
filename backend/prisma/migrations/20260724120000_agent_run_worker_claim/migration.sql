-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "input" JSONB,
ADD COLUMN     "inputConsumedAt" TIMESTAMP(3),
ADD COLUMN     "workerId" TEXT;

-- CreateIndex
CREATE INDEX "agent_runs_status_leaseExpiresAt_idx" ON "agent_runs"("status", "leaseExpiresAt");


-- CreateTable
CREATE TABLE "coding_schedules" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'recurring',
    "intervalSec" INTEGER,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "runsCount" INTEGER NOT NULL DEFAULT 0,
    "maxRuns" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "lastFiredAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coding_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coding_schedules_userId_idx" ON "coding_schedules"("userId");

-- CreateIndex
CREATE INDEX "coding_schedules_sessionId_idx" ON "coding_schedules"("sessionId");

-- CreateIndex
CREATE INDEX "coding_schedules_enabled_nextRunAt_idx" ON "coding_schedules"("enabled", "nextRunAt");

-- AddForeignKey
ALTER TABLE "coding_schedules" ADD CONSTRAINT "coding_schedules_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "crossmodel_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coding_schedules" ADD CONSTRAINT "coding_schedules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

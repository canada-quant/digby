-- CreateTable
CREATE TABLE "app_error_logs" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "context" JSONB,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_error_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_error_logs_level_createdAt_idx" ON "app_error_logs"("level", "createdAt");

-- CreateIndex
CREATE INDEX "app_error_logs_createdAt_idx" ON "app_error_logs"("createdAt");

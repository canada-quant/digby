-- CreateTable
CREATE TABLE "project_digests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "summary" TEXT NOT NULL DEFAULT '',
    "attentionItems" JSONB NOT NULL DEFAULT '[]',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "signature" TEXT,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_digests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_digests_userId_updatedAt_idx" ON "project_digests"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "project_digests_userId_projectId_key" ON "project_digests"("userId", "projectId");

-- AddForeignKey
ALTER TABLE "project_digests" ADD CONSTRAINT "project_digests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_digests" ADD CONSTRAINT "project_digests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "crossmodel_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ungrouped-bucket uniqueness: Postgres treats NULLs as distinct, so the
-- (userId, projectId) unique index above never fires for projectId NULL rows.
-- One UNGROUPED digest row per owner, backed here (mirrors
-- crossmodel_chats_one_supervisor_per_owner's partial-index pattern).
CREATE UNIQUE INDEX "project_digests_userId_ungrouped_key" ON "project_digests"("userId") WHERE "projectId" IS NULL;


-- First-class Google Drive watch (owner-confirmed cf_822011a4, backlog
-- 2026-09-29): a lane registers a Drive folder once; Google push
-- (changes.watch) hits an open-router webhook on edit; the platform pulls the
-- incremental changes.list delta with NO model in the loop and wakes the
-- target lane with the changed doc names. Same shape as event hooks, not an
-- LLM polling loop.
-- Additive only: one new table, two FK-cascaded indexes, no rewrites.
CREATE TABLE "drive_watches" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Personal',
    "folderId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "token" TEXT,
    "expiration" TIMESTAMP(3),
    "targetChatId" TEXT NOT NULL,
    "promptTemplate" TEXT NOT NULL DEFAULT '',
    "lastFiredChanges" JSONB,
    "lastFiredAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drive_watches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drive_watches_userId_folderId_targetChatId_key" ON "drive_watches"("userId", "folderId", "targetChatId");

-- CreateIndex
CREATE INDEX "drive_watches_userId_idx" ON "drive_watches"("userId");

-- CreateIndex
CREATE INDEX "drive_watches_targetChatId_idx" ON "drive_watches"("targetChatId");

-- CreateIndex
CREATE INDEX "drive_watches_expiration_idx" ON "drive_watches"("expiration");

-- AddForeignKey
ALTER TABLE "drive_watches" ADD CONSTRAINT "drive_watches_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

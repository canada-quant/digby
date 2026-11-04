-- Content reports (M2-prep — App Store 1.2/1.4, Play UGC policy, todo fbf6c423).
-- A moderation-queue entry keyed to the REPORTED MESSAGE: the mobile app's
-- "report content" action writes here; the operator reviews via the admin
-- routes. reporterId is SetNull so a moderation trail SURVIVES its reporter's
-- account deletion (anonymized — MessageFeedback.userId convention); chatId
-- cascades with the chat; messageId is a soft ref (the message may be deleted
-- by the run lifecycle before review; the report row persists).

CREATE TABLE "content_reports" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT,
    "chatId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "surface" TEXT,
    "appVersion" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_reports_pkey" PRIMARY KEY ("id")
);

-- Create index for content_reports_status_createdAt_idx
CREATE INDEX "content_reports_status_createdAt_idx" ON "content_reports"("status", "createdAt");

-- Create index for content_reports_reporterId_idx
CREATE INDEX "content_reports_reporterId_idx" ON "content_reports"("reporterId");

-- Add foreign key constraint for content_reports_reporterId_fkey
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add foreign key constraint for content_reports_chatId_fkey
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "crossmodel_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

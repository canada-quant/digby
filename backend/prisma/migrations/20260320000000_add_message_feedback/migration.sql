-- CreateTable
CREATE TABLE "message_feedback" (
    "id"        TEXT NOT NULL,
    "messageId" TEXT,
    "chatId"    TEXT NOT NULL,
    "userId"    TEXT,
    "type"      TEXT NOT NULL,
    "reason"    TEXT,
    "comment"   TEXT,
    "modelSet"  TEXT,
    "resolved"  BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_feedback_chatId_idx" ON "message_feedback"("chatId");
CREATE INDEX "message_feedback_userId_idx" ON "message_feedback"("userId");
CREATE INDEX "message_feedback_type_idx" ON "message_feedback"("type");
CREATE INDEX "message_feedback_resolved_createdAt_idx" ON "message_feedback"("resolved", "createdAt");

-- AddForeignKey (nullable — tolerates pre-existing messages without IDs)
ALTER TABLE "message_feedback"
    ADD CONSTRAINT "message_feedback_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "crossmodel_messages"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_feedback"
    ADD CONSTRAINT "message_feedback_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

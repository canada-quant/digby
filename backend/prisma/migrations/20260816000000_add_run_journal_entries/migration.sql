-- CreateTable
CREATE TABLE "run_journal_entries" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "runId" TEXT,
    "triggerKind" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "keyDecisions" TEXT[],
    "filesTouched" TEXT[],
    "failures" TEXT[],
    "tokensUsed" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_journal_entries_chatId_createdAt_idx" ON "run_journal_entries"("chatId", "createdAt");

-- AddForeignKey
ALTER TABLE "run_journal_entries" ADD CONSTRAINT "run_journal_entries_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "crossmodel_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

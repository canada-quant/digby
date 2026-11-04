-- CreateTable
CREATE TABLE "run_tool_receipts" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "runId" TEXT,
    "tool" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "ids" JSONB NOT NULL DEFAULT '{}',
    "inputHash" TEXT,
    "outputHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_tool_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_tool_receipts_runId_idx" ON "run_tool_receipts"("runId");

-- CreateIndex
CREATE INDEX "run_tool_receipts_chatId_createdAt_idx" ON "run_tool_receipts"("chatId", "createdAt");

-- AddForeignKey
ALTER TABLE "run_tool_receipts" ADD CONSTRAINT "run_tool_receipts_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "crossmodel_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

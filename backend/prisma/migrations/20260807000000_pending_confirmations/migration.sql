-- CreateTable
CREATE TABLE "pending_confirmations" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "pending_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_confirmations_userId_status_idx" ON "pending_confirmations"("userId", "status");

-- CreateIndex
CREATE INDEX "pending_confirmations_chatId_status_idx" ON "pending_confirmations"("chatId", "status");

-- CreateIndex
CREATE INDEX "pending_confirmations_expiresAt_idx" ON "pending_confirmations"("expiresAt");


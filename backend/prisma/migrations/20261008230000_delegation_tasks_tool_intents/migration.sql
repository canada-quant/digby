-- build 2026-10-08 D (architecture.md items B + C): the delegation task ledger
-- and the tool-intent journal, both written in SHADOW.
-- Additive only: two NEW tables with their indexes, no FKs (a shadow write must
-- never fail on a deleted chat), no existing table altered or rewritten.

-- CreateTable
CREATE TABLE "delegation_tasks" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'submitted',
    "parentChatId" TEXT,
    "parentRunId" TEXT,
    "childChatId" TEXT,
    "childRef" TEXT,
    "projectId" TEXT,
    "brief" TEXT,
    "origin" TEXT,
    "idempotencyKey" TEXT,
    "duplicateOfId" TEXT,
    "artifacts" JSONB NOT NULL DEFAULT '[]',
    "events" JSONB NOT NULL DEFAULT '[]',
    "resultRef" TEXT,
    "reason" TEXT,
    "staleAfter" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delegation_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_intents" (
    "id" TEXT NOT NULL,
    "idemKey" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "runId" TEXT,
    "tool" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "slot" TEXT NOT NULL DEFAULT '',
    "step" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "reconcileClass" TEXT NOT NULL,
    "receiptId" TEXT,
    "priorIntentId" TEXT,
    "wouldReconcile" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "tool_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delegation_tasks_childChatId_state_idx" ON "delegation_tasks"("childChatId", "state");

-- CreateIndex
CREATE INDEX "delegation_tasks_parentChatId_createdAt_idx" ON "delegation_tasks"("parentChatId", "createdAt");

-- CreateIndex
CREATE INDEX "delegation_tasks_childRef_idx" ON "delegation_tasks"("childRef");

-- CreateIndex
CREATE INDEX "delegation_tasks_idempotencyKey_idx" ON "delegation_tasks"("idempotencyKey");

-- CreateIndex
CREATE INDEX "delegation_tasks_kind_createdAt_idx" ON "delegation_tasks"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "delegation_tasks_createdAt_idx" ON "delegation_tasks"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "tool_intents_idemKey_attemptId_key" ON "tool_intents"("idemKey", "attemptId");

-- CreateIndex
CREATE INDEX "tool_intents_idemKey_idx" ON "tool_intents"("idemKey");

-- CreateIndex
CREATE INDEX "tool_intents_chatId_createdAt_idx" ON "tool_intents"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "tool_intents_createdAt_idx" ON "tool_intents"("createdAt");

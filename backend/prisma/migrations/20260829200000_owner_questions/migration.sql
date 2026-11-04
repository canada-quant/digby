-- "Needs owner" persistent inbox (ticket 7705fec2): questions/decisions an
-- agent run flags for the owner via the flag_owner_question platform tool.
-- Rows never expire — they persist until the owner answers or dismisses them
-- (POST /owner-questions/:id/answer|dismiss), and the resolution is posted
-- back into the originating chat's transcript for the agent's next turn.
-- Column types/casing mirror pending_confirmations (20260807000000).

-- CreateTable
CREATE TABLE "owner_questions" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "context" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "answer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "owner_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "owner_questions_userId_status_idx" ON "owner_questions"("userId", "status");

-- CreateIndex
CREATE INDEX "owner_questions_chatId_status_idx" ON "owner_questions"("chatId", "status");

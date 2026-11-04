-- Fleet Supervisor durable state doc (2026-08-22 rebuild — the 2026-08-21
-- amnesia incident): one row per supervisor chat, injected into every machine
-- wake and merged via the update_supervisor_state platform tool. See
-- platform/supervisor-state.service.ts.

-- CreateTable
CREATE TABLE "supervisor_states" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supervisor_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supervisor_states_chatId_key" ON "supervisor_states"("chatId");

-- CreateIndex
CREATE INDEX "supervisor_states_userId_idx" ON "supervisor_states"("userId");

-- AddForeignKey
ALTER TABLE "supervisor_states" ADD CONSTRAINT "supervisor_states_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "crossmodel_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_states" ADD CONSTRAINT "supervisor_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

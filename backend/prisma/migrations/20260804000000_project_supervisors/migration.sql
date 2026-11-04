-- AlterTable
ALTER TABLE "crossmodel_chats" ADD COLUMN     "isSupervisor" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "systemPrompt" TEXT;

-- One Supervisor chat per project: concurrent ensure calls race a
-- find-then-create, so enforce it at the DB (partial index) and converge on
-- the winner's row on P2002 (see platform/supervisor.service.ts).
CREATE UNIQUE INDEX "crossmodel_chats_one_supervisor_per_project"
    ON "crossmodel_chats" ("projectId") WHERE "isSupervisor";

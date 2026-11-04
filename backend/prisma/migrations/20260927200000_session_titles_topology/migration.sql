-- Session titles + topology (2026-09-27): the charter a lane's title derives
-- from, the harness-rendered step half, and the human-rename pin. Additive,
-- nullable / defaulted, no backfill (session-topology-migrate.js is the
-- owner-run backfill, dry-run first).
ALTER TABLE "crossmodel_chats" ADD COLUMN "charterGoalId" TEXT;
ALTER TABLE "crossmodel_chats" ADD COLUMN "charterTodoId" TEXT;
ALTER TABLE "crossmodel_chats" ADD COLUMN "titlePinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "crossmodel_chats" ADD COLUMN "titleStep" TEXT;

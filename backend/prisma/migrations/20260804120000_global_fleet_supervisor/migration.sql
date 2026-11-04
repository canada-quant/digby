-- Global Fleet Supervisor (supersedes the per-project supervisor model):
-- ONE pinned "Fleet Supervisor" chat per OWNER, wildcard-hooked to every chat
-- the owner has. See platform/supervisor.service.ts.

-- Wildcard hooks: a NULL sourceChatId subscribes targetChatId to EVERY chat
-- owned by the hook's userId (emission filters wildcard matches to same-owner
-- at insert time, and delivery re-checks ownership per source chat).
ALTER TABLE "event_hooks" ALTER COLUMN "sourceChatId" DROP NOT NULL;

-- Replace the per-project supervisors (shipped hours earlier in
-- 20260803090000_project_supervisor_chats): their auto-created chats are
-- removed — hooks/autonomy/schedules/messages cascade — and the single global
-- supervisor is lazily recreated by the ensure path on next load.
DELETE FROM "crossmodel_chats" WHERE "isSupervisor" = true;

-- One supervisor per OWNER (was: per project). Partial unique index backs the
-- ensure path's find-then-create race (converge on the winner's row on P2002).
DROP INDEX IF EXISTS "crossmodel_chats_one_supervisor_per_project";
CREATE UNIQUE INDEX "crossmodel_chats_one_supervisor_per_owner"
    ON "crossmodel_chats" ("userId") WHERE "isSupervisor";

-- One WILDCARD hook per target chat: a concurrent first-ensure races
-- find-then-create in supervisor.service.ensureWildcardHook — enforce the
-- invariant at the DB and converge on P2002 (two wildcard hooks on the same
-- target are exact duplicates: the source set "all chats" is identical).
CREATE UNIQUE INDEX "event_hooks_one_wildcard_per_target"
    ON "event_hooks" ("targetChatId") WHERE "sourceChatId" IS NULL;

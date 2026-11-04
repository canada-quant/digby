-- Per-project supervisor agents (owner directives 2026-09-13 23:15Z + 23:34Z —
-- OPT-IN, pause-never-delete lifecycle):
--   crossmodel_projects.projectSupervisorEnabled — the ONE backing toggle the
--     sidebar/dashboard UIs and the update_project tool all bind. true scaffolds
--     the project's dedicated supervisor (chat + project-scope hook + hourly
--     sweep); false PAUSES them (hooks/schedules disabled — NEVER deleted).
--   crossmodel_chats.isProjectSupervisor — flags the ONE dedicated supervisor
--     chat per (owner, project). Deliberately NOT isSupervisor: the fleet flag's
--     per-owner partial unique index + fleet semantics are load-bearing.
--   event_hooks.projectId — the project-scope wildcard lane: sourceChatId NULL +
--     projectId SET = only chats IN that project (owned by the hook's userId)
--     emit to targetChatId. SOFT ref (no FK): SetNull would silently widen the
--     hook to owner-scope on project deletion; Cascade would hard-delete wiring
--     the pause doctrine keeps. A dangling projectId matches nothing.
-- Purely additive: every existing row reads as flag-off — the rollout is inert.

-- AlterTable
ALTER TABLE "crossmodel_projects" ADD COLUMN IF NOT EXISTS "projectSupervisorEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "crossmodel_chats" ADD COLUMN IF NOT EXISTS "isProjectSupervisor" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "event_hooks" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

-- One project-supervisor chat per PROJECT (projectId determines the owner — a
-- project has exactly one). Partial unique index (DB-only — Prisma cannot
-- express partial indexes; same convention as
-- crossmodel_chats_one_supervisor_per_owner from
-- 20260804120000_global_fleet_supervisor): backs ensureProjectSupervisor's
-- find-then-create race — a concurrent ensure loses with a P2002 and converges
-- on the winner's row.
CREATE UNIQUE INDEX IF NOT EXISTS "crossmodel_chats_one_project_supervisor_per_project"
    ON "crossmodel_chats" ("projectId") WHERE "isProjectSupervisor";

-- Project-supervisor lane find-or-create looks hooks up by (targetChatId,
-- projectId); Prisma-expressible, mirrored as @@index([targetChatId, projectId]).
CREATE INDEX IF NOT EXISTS "event_hooks_targetChatId_projectId_idx" ON "event_hooks"("targetChatId", "projectId");

-- Tighten the 2026-08-04 wildcard-hook uniqueness to OWNER-scope rows only
-- (adversarial review, 2026-09-14): the old predicate matched EVERY
-- sourceChatId-NULL row on a target chat — including the new PROJECT-scope
-- hooks — so a chat carrying both a wildcard hook and a project hook would
-- have tripped it (and the project hook's create would have died on P2002).
-- Existing rows all have projectId NULL (the column is new), so the tightened
-- index admits every row that exists today. Recreate in place:
DROP INDEX IF EXISTS "event_hooks_one_wildcard_per_target";
CREATE UNIQUE INDEX IF NOT EXISTS "event_hooks_one_wildcard_per_target"
    ON "event_hooks" ("targetChatId")
    WHERE "sourceChatId" IS NULL AND "projectId" IS NULL;

-- One PROJECT-scope hook per (target chat, project): concurrent ensures (the
-- toggle's fire-and-forget on one web box racing the 15-min watchdog heal on
-- another — blue-green runs two web stacks) find-then-create race; enforce the
-- invariant at the DB and converge on P2002 (reviewer P1-1 — without this the
-- catch was dead code and a lost race doubled every in-project event delivery
-- FOREVER). DB-only — Prisma cannot express partial unique indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "event_hooks_one_project_hook_per_target"
    ON "event_hooks" ("targetChatId", "projectId")
    WHERE "sourceChatId" IS NULL AND "projectId" IS NOT NULL;

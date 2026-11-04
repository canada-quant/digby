-- User Space (P3, docs/USER_SPACE_DESIGN.md §2): every user gets ONE hidden,
-- personal "Workspace" project that chats auto-file into (creation + moves to
-- "No folder"), making every chat code-CAPABLE from birth — the coding
-- pipeline itself keys off the ChatCodingState satellite (THE ROUTING RULE,
-- spec §4), never off folder capability.
--   crossmodel_projects.isUserSpace — true marks the owner's user space.
--     NOT NULL DEFAULT false leaves every existing project untouched.
-- One user space per OWNER: the partial unique index backs ensureUserSpace's
-- find-then-create race (converge on the winner's row on P2002) — same
-- pattern as crossmodel_chats_one_supervisor_per_owner
-- (20260804120000_global_fleet_supervisor); Prisma can't express partial
-- indexes, so this stays DB-only.
ALTER TABLE "crossmodel_projects" ADD COLUMN "isUserSpace" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "crossmodel_projects_one_userspace_per_owner"
    ON "crossmodel_projects" ("userId") WHERE "isUserSpace";

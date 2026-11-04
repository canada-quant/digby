-- Archive + restore for chats and folders (owner 2026-09-08: "archive projects
-- and bring them back. same with chats so we dont permanently delete things
-- just reduce clutter").
--   crossmodel_chats.archivedAt    — NULL = live. Stamped rows leave default
--     lists/search/digests but still load by direct id (archive is NOT
--     tombstoning); restore clears the stamp.
--   crossmodel_projects.archivedAt — NULL = live. Archiving a folder stamps
--     ONLY this row: its chats and descendant folders ride along implicitly
--     (default lists hide the whole subtree via the materialized path), so
--     restore is instant and lossless.
-- Purely additive: every existing row reads as live.

-- AlterTable
ALTER TABLE "crossmodel_chats" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "crossmodel_projects" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Partial indexes (DB-only — Prisma cannot express partial indexes; same
-- convention as one_supervisor_per_owner / one_userspace_per_owner): archived
-- rows are the rare set, and the Archived browse views scan exactly them. The
-- default lists filter "archivedAt" IS NULL, which the existing userId/
-- projectId composite scans already serve.
CREATE INDEX "crossmodel_chats_archivedAt_idx" ON "crossmodel_chats"("archivedAt") WHERE "archivedAt" IS NOT NULL;
CREATE INDEX "crossmodel_projects_archivedAt_idx" ON "crossmodel_projects"("archivedAt") WHERE "archivedAt" IS NOT NULL;

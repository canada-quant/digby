-- Per-project auto-archive of idle chats (ticket bb86cee8 — owner ask
-- 2026-09-14: "how can we properly start auto archiving old sessions from the
-- main framework project folder? over 200 sessions now"):
--   crossmodel_projects.autoArchiveIdleDays — NULL = feature OFF (every
--   existing row reads off; the rollout is inert). An integer 1..365 enables
--   the hourly idle-chat-archiver cron for this folder: chats whose updatedAt
--   is older than that many days are archived through the same reversible
--   archiveChat path the UI uses (crossmodel_chats.archivedAt stamp + coding
--   satellite flip + chat.archive audit — never a hand-rolled update).
-- Purely additive; the 1..365 bound is enforced at the service layer
-- (platform.service updateProject), not by a CHECK constraint (matches
-- spendCapUsdPerDay/selfMerge precedent: bounds live in the service).

-- AlterTable
ALTER TABLE "crossmodel_projects" ADD COLUMN IF NOT EXISTS "autoArchiveIdleDays" INTEGER;

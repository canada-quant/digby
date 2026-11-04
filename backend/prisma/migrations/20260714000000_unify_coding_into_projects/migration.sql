-- One-Digby merge, Phase 1 Commit A (ADDITIVE ONLY — amendment A2).
-- 1) crossmodel_projects gains workspace columns
-- 2) coding_projects rows are COPIED into crossmodel_projects (same ids)
-- 3) crossmodel_chats rows are backfilled from coding_sessions (same ids, mode='code')
-- 4) the old coding_sessions→coding_projects FK is DROPPED (new code writes only the
--    merged tables; old code during the blue-green overlap keeps working unenforced)
--
-- Deliberately NOT here (added in a follow-up migration after the overlap drains,
-- once the reconciliation script has swept stragglers):
--   coding_sessions.projectId → crossmodel_projects FK
--   coding_sessions.id        → crossmodel_chats FK
-- Adding them now would 500 every session-create on the old color during overlap.

-- 1) Additive workspace columns
ALTER TABLE "crossmodel_projects" ADD COLUMN IF NOT EXISTS "repoUrl" TEXT;
ALTER TABLE "crossmodel_projects" ADD COLUMN IF NOT EXISTS "repoProvider" TEXT;
ALTER TABLE "crossmodel_projects" ADD COLUMN IF NOT EXISTS "defaultBranch" TEXT NOT NULL DEFAULT 'main';
ALTER TABLE "crossmodel_projects" ADD COLUMN IF NOT EXISTS "githubLabel" TEXT;
ALTER TABLE "crossmodel_projects" ADD COLUMN IF NOT EXISTS "workspaceAt" TIMESTAMP(3);

-- 2) Copy coding projects (id-stable). 'blank' keeps legacy session-chained semantics.
INSERT INTO "crossmodel_projects"
  ("id", "userId", "name", "emoji", "repoUrl", "repoProvider", "defaultBranch", "githubLabel", "createdAt", "updatedAt")
SELECT
  cp."id", cp."userId", cp."name", '🛠️',
  NULLIF(cp."repoUrl", ''), cp."provider", cp."defaultBranch", cp."githubLabel",
  cp."createdAt", cp."updatedAt"
FROM "coding_projects" cp
ON CONFLICT ("id") DO NOTHING;

-- 3) Backfill chats from coding sessions (id-stable; mode='code' is outside
--    PATIENCE_MODES so normal chat endpoints reject these by existing validation).
INSERT INTO "crossmodel_chats"
  ("id", "userId", "projectId", "title", "mode", "messages", "createdAt", "updatedAt")
SELECT
  cs."id", cs."userId", cs."projectId", cs."title", 'code', ARRAY[]::jsonb[],
  cs."createdAt", cs."updatedAt"
FROM "coding_sessions" cs
ON CONFLICT ("id") DO NOTHING;

-- 4) Drop ONLY the project FK so new code never needs to dual-write coding_projects.
--    The userId FK is deliberately KEPT: until the follow-up migration adds the
--    id→crossmodel_chats FK, it is what cascades coding state on user deletion.
ALTER TABLE "coding_sessions" DROP CONSTRAINT IF EXISTS "coding_sessions_projectId_fkey";

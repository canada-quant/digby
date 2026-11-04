-- P0 platform unification: folder-tree fields on crossmodel_projects + agent_tokens table.
-- NOTE: intentionally EXCLUDES schema<->DB drift reconciliation (manually-managed
-- indexes like project_chunks_embedding_idx, idx_store_value_gin, and the
-- coding_sessions_userId FK) — those are managed outside Prisma and must not be dropped.

-- AlterTable
ALTER TABLE "crossmodel_projects" ADD COLUMN     "depth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "path" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "agent_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_tokens_tokenHash_key" ON "agent_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "agent_tokens_userId_idx" ON "agent_tokens"("userId");

-- CreateIndex
CREATE INDEX "crossmodel_projects_parentId_idx" ON "crossmodel_projects"("parentId");

-- CreateIndex
CREATE INDEX "crossmodel_projects_path_idx" ON "crossmodel_projects"("path");

-- AddForeignKey
ALTER TABLE "crossmodel_projects" ADD CONSTRAINT "crossmodel_projects_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "crossmodel_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing project becomes a root folder with materialized path "/<id>".
UPDATE "crossmodel_projects" SET "path" = '/' || "id" WHERE "path" = '';

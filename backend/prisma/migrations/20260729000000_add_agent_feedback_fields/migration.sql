-- Agent feedback loop: agents (chat agent, coding orchestrators, worker
-- subagents) file feedback tickets into user_feature_requests via the
-- file_feedback platform tool; admin/supervisor sessions triage them with
-- list_feedback / update_feedback (replacing the nightly autopilot removed
-- 2026-07-20).
--   * userId → NULLABLE: anonymous chat-agent runs have no users row.
--   * source ('user' | 'agent', default 'user') — existing rows stay 'user'.
--   * context JSONB — agent-captured metadata (sessionId, surface, role, area,
--     occurrences, lastSeen, filedAt).

-- AlterTable
ALTER TABLE "user_feature_requests" ADD COLUMN     "context" JSONB,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'user',
ALTER COLUMN "userId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "user_feature_requests_source_idx" ON "user_feature_requests"("source");

-- Retired-target hook hygiene follow-up (feedback 9df506cc F3, 2026-09-20):
-- the 57154856 delivery-time retired-target check runs a per-delivery
--   SELECT COUNT(*) FROM project_todos WHERE "assigneeChatId" = <hook target> AND status IN (...)
-- which was unindexed (ProjectTodo carried only goalId/projectId indexes).
-- One index closes it. ADDITIVE ONLY: a single new index, no existing-row
-- change (plain CREATE INDEX — no CONCURRENTLY dance for this small fleet
-- table — written IF NOT EXISTS so a re-applied migration is idempotent).

-- CreateIndex
CREATE INDEX IF NOT EXISTS "project_todos_assigneeChatId_idx" ON "project_todos"("assigneeChatId");

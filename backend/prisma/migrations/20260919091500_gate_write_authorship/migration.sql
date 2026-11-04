-- Gate-write authorship trail (feedback c286ba91, 2026-09-19): production
-- forensics proved goal/todo gate writes carried NO authorship — a
-- gateQuestionId flip on a shared-project todo (4501c4b0 → oq_4694abca…,
-- 02:28:04Z) was "unattributed" and three tickets were burned identifying the
-- writer — and the Activity audit seam fired only on STATUS changes, so a
-- gate+blockedReason rewrite with no status change (the incident shape) left
-- ZERO audit rows. These two nullable columns stamp WHO wrote (the acting
-- chat + agent run) on every updateGoal/updateTodo row write; null = a
-- user/REST/framework writer. ADDITIVE ONLY: two nullable columns per table,
-- no existing-row change (the doneRunId precedent).

-- AlterTable
ALTER TABLE "project_goals" ADD COLUMN IF NOT EXISTS "updatedByChatId" TEXT,
ADD COLUMN IF NOT EXISTS "updatedByRunId" TEXT;

-- AlterTable
ALTER TABLE "project_todos" ADD COLUMN IF NOT EXISTS "updatedByChatId" TEXT,
ADD COLUMN IF NOT EXISTS "updatedByRunId" TEXT;

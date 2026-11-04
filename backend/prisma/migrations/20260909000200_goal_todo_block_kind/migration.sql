-- Remediation P2 S2a (2026-09-09) — typed block provenance on goals/todos.
-- ADDITIVE ONLY: nullable columns.
--   blockKind      TEXT — why the row is blocked: 'deps'|'owner'|'agent'|'external'
--   gateQuestionId TEXT — the open owner_questions row gating a blockKind='owner'
--                         row (the digest's 24h/72h owner-wait escalation keys
--                         on it; N10 drops owner-wait lines without one)
ALTER TABLE "project_goals" ADD COLUMN IF NOT EXISTS "blockKind" TEXT;
ALTER TABLE "project_goals" ADD COLUMN IF NOT EXISTS "gateQuestionId" TEXT;
ALTER TABLE "project_todos" ADD COLUMN IF NOT EXISTS "blockKind" TEXT;
ALTER TABLE "project_todos" ADD COLUMN IF NOT EXISTS "gateQuestionId" TEXT;

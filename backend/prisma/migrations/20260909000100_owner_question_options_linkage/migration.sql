-- Remediation P2 (2026-09-09) — typed owner-question options + lane linkage.
-- ADDITIVE ONLY: nullable columns on owner_questions.
--   options      JSONB   — optional array of {id, label, consequence?} the
--                          flagging run supplied (N3 typed decisions)
--   chosenOption TEXT    — the option id the owner's answer matched (N3)
--   forChatId    TEXT    — a second lane the answer wakes (v1#5)
--   goalId       TEXT    — the goal this question gates (v1#5 / S2a)
--   todoId       TEXT    — the todo this question gates (v1#5 / S2a)
ALTER TABLE "owner_questions" ADD COLUMN IF NOT EXISTS "options" JSONB;
ALTER TABLE "owner_questions" ADD COLUMN IF NOT EXISTS "chosenOption" TEXT;
ALTER TABLE "owner_questions" ADD COLUMN IF NOT EXISTS "forChatId" TEXT;
ALTER TABLE "owner_questions" ADD COLUMN IF NOT EXISTS "goalId" TEXT;
ALTER TABLE "owner_questions" ADD COLUMN IF NOT EXISTS "todoId" TEXT;

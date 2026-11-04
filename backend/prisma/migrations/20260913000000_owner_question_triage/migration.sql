-- Review 2026-09-13 issue 11: supervisor-first triage of machine-lane owner
-- questions. ADDITIVE ONLY: two nullable columns on owner_questions.
--   triage      — 'supervisor' while the Fleet Supervisor is first responder
--                 (row hidden from the owner's Decisions rail + Telegram);
--                 'surfaced' once the SLA elapsed and the owner was notified;
--                 NULL = never triaged.
--   triageUntil — the SLA deadline (createdAt + OWNER_QUESTION_TRIAGE_SLA_MIN).
ALTER TABLE "owner_questions" ADD COLUMN IF NOT EXISTS "triage" TEXT;
ALTER TABLE "owner_questions" ADD COLUMN IF NOT EXISTS "triageUntil" TIMESTAMP(3);

-- One-shot schedule CHAIN link (finding B1, 2026-09-27): the id of the
-- schedule whose firing armed this `once` row on its own chat. NULL = not a
-- chain link. Additive, nullable, no backfill (the chain walk reads only rows
-- created after this ships).
ALTER TABLE "coding_schedules" ADD COLUMN "chainedFromScheduleId" TEXT;

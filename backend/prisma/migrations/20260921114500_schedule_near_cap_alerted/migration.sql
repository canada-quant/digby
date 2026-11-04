-- Near-cap pre-emptive renewal alerting (ticket b4d1096c): recurring schedules
-- used to die silently at their run cap — the only signal was the POST-death
-- schedule_disabled hook event. The sweeper now emits ONE schedule_near_cap
-- hook event per recurring row when it crosses ≥90% of maxRuns or enters the
-- last 10% of its lifetime window, and stamps the row here. The atomic guarded
-- write (WHERE "nearCapAlertedAt" IS NULL) is the dedupe across repeat
-- processings, busy re-arms and racing blue/green sweepers.
-- ADDITIVE ONLY: a single nullable column, no existing-row change, no backfill
-- (a NULL row simply alerts once on its next near-cap processing).

-- AlterTable
ALTER TABLE "coding_schedules" ADD COLUMN IF NOT EXISTS "nearCapAlertedAt" TIMESTAMP(3);

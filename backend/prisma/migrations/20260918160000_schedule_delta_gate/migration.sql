-- Delta gate (ticket 0b1dbe75): nullable Json gate on recurring schedules —
-- the platform polls cheap https probes itself at each fire time and SKIPS the
-- model run when nothing changed (lastStatus 'skipped:delta_unchanged').
-- ADDITIVE ONLY: one nullable column.
ALTER TABLE "coding_schedules" ADD COLUMN IF NOT EXISTS "deltaGate" JSONB;

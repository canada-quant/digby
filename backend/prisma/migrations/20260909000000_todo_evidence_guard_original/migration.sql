-- P4 evidence-integrity remediation (additive only).
-- v1#10: machine-closed todos must carry evidence — nullable columns, no backfill.
ALTER TABLE "project_todos" ADD COLUMN "evidence" TEXT;
ALTER TABLE "project_todos" ADD COLUMN "doneRunId" TEXT;

-- CanLaw L5: the evidence guard's line-level REPLACE preserves the original
-- final as a `guardOriginal` metadata attachment on the coding message row.
ALTER TABLE "coding_messages" ADD COLUMN "metadata" JSONB;

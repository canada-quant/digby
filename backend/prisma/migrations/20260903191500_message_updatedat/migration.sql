-- Message updatedAt (ticket 68916075): coding-session runs INSERT the assistant
-- transcript row at run start (run-executor persistPartial) and rewrite it in
-- place through finalize, so transcript readers saw only insert-time createdAt —
-- an 82-minute run's final answer read as backdated. updatedAt is the last-write
-- stamp (≈ finalization); createdAt is NEVER restamped (ordering/cursor contract).
-- Nullable, no default, no backfill ON PURPOSE: historical rows read NULL
-- (honest "predates this field") instead of a mass-stamped migration instant.
-- Instant DDL (metadata-only column add).

-- AlterTable
ALTER TABLE "crossmodel_messages" ADD COLUMN "updatedAt" TIMESTAMP(3);
ALTER TABLE "coding_messages" ADD COLUMN "updatedAt" TIMESTAMP(3);

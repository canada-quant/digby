-- Per-chat lead-seat override (WI-O #4c, 2026-09-25): a PLAIN chat's own pick
-- for the Digby seat (built-in id or '<label>:<modelId>' registry spec).
-- NULL = the instance-wide model-roles seat. Additive, nullable, no backfill.
ALTER TABLE "crossmodel_chats" ADD COLUMN "leadModel" TEXT;

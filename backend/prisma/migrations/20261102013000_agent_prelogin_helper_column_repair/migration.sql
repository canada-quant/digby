-- PRE-LOGIN HELPER COLUMN REPAIR (ticket c468f922) — the corrective half of the
-- 2026-11-02 P2022 outage.
--
-- WHAT HAPPENED. 20261101234500_agent_prelogin_helper shipped
-- `ADD COLUMN "prelogin_helper"` (snake_case) while schema.prisma declares
-- `preloginHelper` with NO @map. It was caught in review and "fixed" by editing
-- that migration's file — which is the one thing that cannot work once the
-- migration has been APPLIED, and it had been: the deploy at
-- 2026-11-02T00:53:56.888Z ran it against production before the fix merged.
--
-- WHY EDITING IT WAS WRONG (two independent reasons):
--   1. Prisma keys applied migrations by NAME. A corrected file under the same
--      name is silently skipped on every database that already ran it, so
--      production kept the bad column and every IMessageAgent read threw
--      P2022 (`The column imessage_agents.preloginHelper does not exist`).
--      Agent auth (findUnique by tokenHash), polling, pairing and the account
--      device list were down from 00:53:56Z until this migration applied.
--   2. `prisma migrate deploy` also verifies the CHECKSUM recorded in Prisma's
--      own migration bookkeeping table against the file on disk. Editing an
--      applied migration therefore does not merely no-op — it makes the next
--      deploy's migrate step refuse with a drifted-history error. Restoring the
--      file to its applied bytes (sha256 79d1ee28…) removes that hazard; this
--      migration is the legal way to change the schema afterwards.
-- The precedent is bfc3209a / the 20261021002000 orphan-cleanup migration:
-- HISTORY IS IMMUTABLE, corrections are always a NEW migration.
--
-- WHY THIS IS SAFE ON EVERY DATABASE:
--   • prod (applied 00:53:56Z): prelogin_helper exists and is empty — measured
--     2026-11-02T01:27Z, 6 imessage_agents rows, 0 non-null (JSONB is nullable
--     and absent = null; the capability was advertised by no agent because no
--     signed helper binary exists yet). The COPY moves nothing, and the DROP
--     loses nothing.
--   • fresh DB / CI replay: the restored migration recreates prelogin_helper,
--     then this repairs it — replaying the repo's history reproduces prod.
--   • re-run (idempotency): every statement is guarded, so a second pass is a
--     clean no-op rather than a duplicate-column or missing-column error.
--
-- The COPY is kept even though prod's column is empty: if anyone ever backfills
-- the stray column before this runs (a hand fix during the outage), their data
-- survives instead of being dropped on the floor.
--
-- NOTE ON PROSE: this file deliberately never names Prisma's bookkeeping table
-- as a literal. prisma-migrations-orphan.bfc3209a.test.ts asserts that no
-- migration AFTER the orphan cleanup mentions it at all (a second writer would
-- recreate rows the cleanup deletes) — and that guard scans comments too, which
-- is the right call: a comment inviting a hand edit is how the next
-- hand-rolled writer starts.

-- 1. Carry any data that landed in the mis-spelled column onto the right one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'imessage_agents' AND column_name = 'prelogin_helper'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'imessage_agents' AND column_name = 'preloginHelper'
  ) THEN
    EXECUTE 'UPDATE "imessage_agents" SET "preloginHelper" = "prelogin_helper" WHERE "prelogin_helper" IS NOT NULL AND "preloginHelper" IS NULL';
  END IF;
END $$;

-- 2. The column Prisma actually queries.
ALTER TABLE "imessage_agents" ADD COLUMN IF NOT EXISTS "preloginHelper" JSONB;

-- 3. Drop the mis-spelled column (empty on prod; data preserved by step 1).
ALTER TABLE "imessage_agents" DROP COLUMN IF EXISTS "prelogin_helper";
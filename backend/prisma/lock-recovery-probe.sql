-- LOCK-RECOVERY PROBE (lane lifecycle fourth review, 2026-10-22) — NOT a migration.
-- scripts/deploy/migrate-lock-recovery.sh runs it with `prisma db execute --file`
-- when `migrate deploy` answers P3009. It RAISES "digby-lock-retry-probe: eligible"
-- only when there is at least one unresolved failed migration row and EVERY such
-- row's logs carry "[digby-lock-retry]" — the RAISE text of an atomic in-place
-- lock-retry DO loop that lost its lock wait and applied nothing — so the helper
-- may resolve those rows as rolled back and retry. Any other state (a migration
-- that failed for another reason, one still running with no logs yet, none at
-- all) runs to completion and the helper fails the deploy as before. Read-only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL)
     AND NOT EXISTS (
       SELECT 1 FROM "_prisma_migrations"
       WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL
         AND ("logs" IS NULL OR strpos("logs", '[digby-lock-retry]') = 0 OR strpos("logs", '55P03') = 0)
     ) THEN
    RAISE EXCEPTION 'digby-lock-retry-probe: eligible';
  END IF;
END $$;

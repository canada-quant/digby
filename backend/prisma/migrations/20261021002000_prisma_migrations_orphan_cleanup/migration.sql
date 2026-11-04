-- Ticket bfc3209a (filed 2026-10-20T23:25Z): PR #1836 (squash dbd154ef4, the
-- topic-feeds retirement, ticket 43c24152) deleted the migration FILE
-- 20261020210000_user_feed_last_error — but that migration had ALREADY been
-- applied in production during the deploy of PR #1834 (deploy run 39508001379;
-- _prisma_migrations row finished_at 2026-10-20T22:44:43.359Z, while the
-- retirement merged at 22:49:19Z). Result: prod's _prisma_migrations holds a
-- row whose file no longer exists in the repo — `prisma migrate status`
-- reports drift, and any DB restored from prod can never be reconciled by
-- `migrate dev` (it wants to mark the row rolled back). Read-only prod probe
-- at filing (2026-10-21T00:16Z): this was the ONLY row-without-file — 130
-- distinct applied migration names vs 129 migration directories in the repo,
-- every other name matched.
--
-- Fix: delete the orphaned bookkeeping row from inside a normal migration so
-- the repo's applied-history once again reproduces prod. Schema state is
-- UNTOUCHED — the deleted migration only ALTERed user_feeds.lastError /
-- lastErrorAt, and user_feeds is dropped by the retirement's own
-- 20261020190000_retire_topic_feeds, so the orphan row guards nothing.
--
-- IDEMPOTENT BY CONSTRUCTION — two distinct execution shapes must both stay
-- green, and they differ in whether Prisma's bookkeeping table even exists
-- when this file runs:
--   1. `migrate deploy` (prod, blue-green re-runs, DBs restored from prod):
--      _prisma_migrations EXISTS; the DELETE removes exactly the orphan row
--      (name-scoped). Verified empirically: staged sim rows go
--      [base, 20261020210000_user_feed_last_error] → [base, cleanup]; and a
--      full fresh replay of all 130 migrations ends with 130 rows, 0 orphans,
--      the cleanup applied as a no-op.
--   2. The SHADOW replay used by `migrate diff --from-migrations` and
--      `migrate dev`: this path was observed live to run this file with no
--      _prisma_migrations present — an unguarded DELETE FROM "_prisma_migrations"
--      failed at PARSE time (42P01, parserOpenTable opening the DELETE target;
--      a WHERE-clause guard like to_regclass() cannot help because the failure
--      happens before the predicate is evaluated). The DO block makes the
--      whole statement runtime-guarded instead: table present (deploy) ⇒ the
--      DELETE runs; table absent (shadow) ⇒ caught, no-op. Either shape green.
-- The DO block catches undefined_table and makes the statement a no-op on
-- shape 2 while running the real DELETE on shape 1.
DO $$
BEGIN
  DELETE FROM "_prisma_migrations"
   WHERE "migration_name" = '20261020210000_user_feed_last_error';
EXCEPTION WHEN undefined_table THEN
  NULL; -- shadow replay: no bookkeeping table — nothing to clean up
END $$;

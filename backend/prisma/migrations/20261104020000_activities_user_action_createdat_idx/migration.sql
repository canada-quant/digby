-- LL-1: declare the audit index that ALREADY EXISTS IN PROD.
--
-- Owner go: card oq_8aef3962 ("Run both — the LL-1 measure, then its --apply if absent_ …").
-- Built on box A (example-ca-primary, i-0123456789abcdef0) 2026-11-04T01:17Z via
-- scripts/framework-audit/ll1-activities-index.js: rows=60003, sizeBytes=34398208,
-- built=true, elapsedMs=166, valid=true. Idempotence proven 19 s later by a second run
-- that measured "existing" and ran no apply leg at all.
--
-- WHY THIS MIGRATION IS A NO-OP IN PROD: the index is already there, so every statement
-- below short-circuits on IF NOT EXISTS. It exists to make the DECLARED state
-- (schema.prisma @@index([userId, action, createdAt])) agree with the real database, so
-- `prisma migrate diff` stops proposing a re-create and a fresh DB (shadow/local/CI) gets
-- the index at migrate time.
--
-- NON-TRANSACTIONAL IS REQUIRED AND IS WHY THIS FILE IS HAND-WRITTEN: CREATE INDEX
-- CONCURRENTLY cannot run inside a transaction block, and Prisma wraps migrations in one
-- by default. The `migrate:disable-transaction` marker below is Prisma's opt-out; without
-- it this migration fails with "CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block" on any environment that does not already have the index.
--
-- Do NOT rewrite this into a plain `CREATE INDEX` to satisfy a checker: on `activities`
-- that takes a write lock and blocks EVERY platform mutation's audit insert for the whole
-- build (the exact hazard the CONCURRENTLY one-shot was created to avoid).

-- migrate:disable-transaction

CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities_userId_action_createdAt_idx"
  ON "activities" ("userId", "action", "createdAt");
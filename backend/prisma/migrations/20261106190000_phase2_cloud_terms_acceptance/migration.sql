-- Phase 2 Cloud — Terms of Service / Acceptable Use acceptance (todo ea95fa0b leg 1 item 5).
--
-- ADDITIVE ONLY: two new NULLABLE columns on "users". No existing table is
-- rewritten, no column is dropped or narrowed, no row is modified by this file.
--
-- WHY NULLABLE with no default: NULL = "no acceptance on record". Every existing
-- account gets NULL, and refusing signup (or a send) on a NULL here would lock
-- out the entire back catalogue on deploy. Enforcement is therefore policy-gated
-- in code (SystemSetting `require_terms_acceptance`, default OFF — the same
-- shape as `require_email_verification`) and a NULL simply means "legacy".
--
-- WHY termsVersion is stored as TEXT rather than an enum: the accepted version is
-- whatever the /terms page said at the time (its "Last updated" date). Pinning it
-- in an enum would force a migration per terms revision, and the value is
-- evidence, not behaviour.
--
-- ROLLBACK: ALTER TABLE "users" DROP COLUMN "termsAcceptedAt", DROP COLUMN "termsVersion";
-- Nothing else references either column.

ALTER TABLE "users" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "termsVersion" TEXT;
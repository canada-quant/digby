-- Phase 2 Cloud — org/tenant model + free-tier quota (todo ea95fa0b, leg 1 items 1-3).
--
-- ADDITIVE ONLY: five NEW tables, two new enums, one new NULLABLE column on "users".
-- No existing table is rewritten, no column is dropped or narrowed, no row is modified
-- by this file — the backfill of existing accounts onto personal orgs is done in code
-- (org.service.ts ensurePersonalOrg, lazily on first send), deliberately NOT here: a
-- migration that inserts one org per existing user would have to slugify emails in SQL
-- and would run inside the deploy's migration transaction on the blue/green cutover.
--
-- WHY the enum/table shapes:
--   * organizations.dailyMessageLimit is NULLABLE and NULL means UNLIMITED. Every
--     pre-existing account is backfilled with NULL, so this migration cannot throttle a
--     single current prod user; only an org with a numeric limit is metered. Self-host
--     instances therefore keep today's behaviour exactly.
--   * usage rows are keyed (organizationId, day) and (organizationId, day, model) with
--     UNIQUE indexes, so the daily counters are upserts at the database rather than a
--     read-then-write that two concurrent sends could both pass.
--   * email_verification_tokens stores tokenHash (sha256 of the raw token), never the
--     token itself — a database read cannot mint a verification link. Single-use via
--     consumedAt, short-lived via expiresAt.
--   * users.emailVerifiedAt is NULLABLE with no default: NULL = unverified, and every
--     existing row becomes NULL, which is why enforcement is policy-gated in code
--     (only applies where verification is actually required) rather than assumed here.
--
-- ROLLBACK: DROP the five tables and the column; nothing else references them yet.
-- FKs are Cascade except organizations.ownerId (SetNull — a team org and its usage
-- history must survive its creator's account deletion).

-- CreateEnum
CREATE TYPE "OrgPlan" AS ENUM ('FREE', 'TEAM', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" "OrgPlan" NOT NULL DEFAULT 'FREE',
    "ownerId" TEXT,
    "personal" BOOLEAN NOT NULL DEFAULT true,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "suspendedReason" TEXT,
    "dailyMessageLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_usage_daily" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_usage_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_model_usage_daily" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "model" TEXT NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_model_usage_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_ownerId_idx" ON "organizations"("ownerId");

-- CreateIndex
CREATE INDEX "memberships_organizationId_idx" ON "memberships"("organizationId");

-- CreateIndex
CREATE INDEX "memberships_userId_isDefault_idx" ON "memberships"("userId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_userId_organizationId_key" ON "memberships"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "org_usage_daily_organizationId_day_key" ON "org_usage_daily"("organizationId", "day");

-- CreateIndex
CREATE INDEX "org_model_usage_daily_organizationId_day_idx" ON "org_model_usage_daily"("organizationId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "org_model_usage_daily_organizationId_day_model_key" ON "org_model_usage_daily"("organizationId", "day", "model");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_tokenHash_key" ON "email_verification_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_userId_idx" ON "email_verification_tokens"("userId");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_usage_daily" ADD CONSTRAINT "org_usage_daily_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_model_usage_daily" ADD CONSTRAINT "org_model_usage_daily_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
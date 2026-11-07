-- Phase 3 Enterprise SCIM 2.0 provisioning (todo 76113a98).
--
-- ADDITIVE ONLY. One new table, one nullable column, two new indexes. No column
-- changes type or nullability, no row is read or rewritten, and nothing is
-- dropped. Applying this to a live database locks no table for writes beyond the
-- CREATE TABLE and the (metadata-only, NULL-defaulted) ADD COLUMN themselves.

-- ── Deprovisioning state on the membership ─────────────────────────────────
--
-- SCIM RFC 7643 `active:false` is a STATE, not a deletion: a GET must still
-- return the resource with active=false and a later `active:true` must
-- reactivate it. So the membership row survives and this column carries the
-- fact.
--
-- NULL = active, which is exactly right for every pre-existing row: the default
-- makes this migration a no-op for all current tenants (no backfill, no rewrite),
-- and "active" is the only correct reading of a membership nobody ever
-- deprovisioned.
--
-- The column is only meaningful because `resolveMembership` (org-access.ts)
-- filters on it — see that function's comment. A deprovisioned membership is
-- treated as ABSENT, so the user holds zero capabilities and a cross-tenant
-- probe still gets 404 rather than 403.
ALTER TABLE "memberships" ADD COLUMN "deactivatedAt" TIMESTAMP(3);

-- The IdP's own stable id for the membership (RFC 7643 `externalId`), echoed
-- back on SCIM reads. Nullable with no default, so this is a no-op for every
-- existing row and never needs a backfill.
ALTER TABLE "memberships" ADD COLUMN "scimExternalId" TEXT;

-- ── Per-org SCIM provisioning tokens ───────────────────────────────────────
CREATE TABLE "scim_tokens" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- sha256 hex of the bearer token. The RAW token is returned once, at mint,
    -- and never stored: a database read cannot mint a working credential.
    "tokenHash" TEXT NOT NULL,
    -- First ~13 chars, for UI identification only ("scim_ab12cd34…").
    "tokenPrefix" TEXT NOT NULL,
    -- users:read | users:write | groups:read | groups:write
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    -- Rotation rewrites tokenHash IN PLACE on this row, so the previous secret
    -- stops verifying immediately — there is no window where two secrets work.
    "rotatedAt" TIMESTAMP(3),
    -- Soft reference, deliberately no FK: the token must outlive the admin who
    -- minted it, exactly as the IdP integration outlives its creator.
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scim_tokens_pkey" PRIMARY KEY ("id")
);

-- One live credential per secret. A collision here would mean two orgs could
-- present the same bearer token, so uniqueness is the database's, not a check.
CREATE UNIQUE INDEX "scim_tokens_tokenHash_key" ON "scim_tokens"("tokenHash");
CREATE INDEX "scim_tokens_organizationId_idx" ON "scim_tokens"("organizationId");

-- Cascade: deleting a tenant removes its provisioning credentials with it. A
-- token must never outlive its org and start authenticating into nothing.
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── SCIM provisioning groups ───────────────────────────────────────────────
--
-- A provisioning-side GROUP, not a permission object: Digby's authorization is
-- the org role table (org-access.ts). This exists so an IdP's group lifecycle
-- (create / rename / replace members / delete) round-trips faithfully.
--
-- "members" holds USER IDS, not emails — a PATCH naming an unknown address must
-- fail loudly rather than create a phantom row.
CREATE TABLE "scim_groups" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "externalId" TEXT,
    "members" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_groups_pkey" PRIMARY KEY ("id")
);

-- One group name per tenant: a duplicate create is a 409, not two groups a
-- human cannot tell apart.
CREATE UNIQUE INDEX "scim_groups_organizationId_displayName_key"
    ON "scim_groups"("organizationId", "displayName");
CREATE INDEX "scim_groups_organizationId_idx" ON "scim_groups"("organizationId");

ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
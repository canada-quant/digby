-- Phase 3 Enterprise SSO/SAML identity federation (todo 3ad2b010).
--
-- ADDITIVE ONLY. Three new tables and one new enum. No existing table is
-- altered, no column changes type or nullability, no row is read or rewritten,
-- and nothing is dropped. Applying this to a live database locks no table for
-- writes beyond the CREATE TABLE statements themselves.
--
-- WHY NEW TABLES AND NOT COLUMNS ON "organizations": a tenant that never turns
-- on federation should carry ZERO federation state, and a nullable cluster of
-- eleven columns on the hot org row would be that state in all-but-name. It
-- also keeps the IdP row's lifetime independent of the org row's: deleting the
-- provider is a plain DELETE, not a column blanking that has to remember which
-- fields belong to which protocol.

-- ── The protocol a tenant's IdP speaks ──────────────────────────────────────
CREATE TYPE "OrgSsoProtocol" AS ENUM ('OIDC', 'SAML');

-- ── The tenant's identity provider: ONE per org ─────────────────────────────
CREATE TABLE "org_identity_providers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "protocol" "OrgSsoProtocol" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "displayName" TEXT,

    -- OIDC: `oidcClientSecret` is AES-256-GCM ciphertext, never plaintext.
    "oidcIssuer" TEXT,
    "oidcClientId" TEXT,
    "oidcClientSecret" TEXT,

    -- SAML: a public X.509 signing certificate, stored as-is.
    "samlEntryPoint" TEXT,
    "samlIssuer" TEXT,
    "samlIdpCert" TEXT,

    -- JIT provisioning. `allowedEmailDomains` empty == JIT closed (existing
    -- links keep working); it never means "any domain".
    "allowedEmailDomains" TEXT[],
    "jitEnabled" BOOLEAN NOT NULL DEFAULT true,
    "jitRole" "OrgRole" NOT NULL DEFAULT 'MEMBER',

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_identity_providers_pkey" PRIMARY KEY ("id")
);

-- ONE IdP per org. A second row would make "which IdP do I redirect this user
-- to?" unanswerable, so the constraint is the database's, not a code check.
CREATE UNIQUE INDEX "org_identity_providers_organizationId_key"
    ON "org_identity_providers"("organizationId");

ALTER TABLE "org_identity_providers"
    ADD CONSTRAINT "org_identity_providers_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── The user ↔ IdP subject link: THE authorization record ───────────────────
CREATE TABLE "federated_identities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    -- The IdP's stable subject (`sub` for OIDC, NameID for SAML).
    "subject" TEXT NOT NULL,
    -- The asserted address at link time: for operator display and audit ONLY,
    -- never an authorization input (see the service header on email matching).
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "federated_identities_pkey" PRIMARY KEY ("id")
);

-- The ONLY lookup key a login may use: (provider, subject). The unique index is
-- what makes a duplicate link impossible even under two concurrent callbacks.
CREATE UNIQUE INDEX "federated_identities_providerId_subject_key"
    ON "federated_identities"("providerId", "subject");

-- One subject per (user, provider): a user cannot hold two links to one IdP.
CREATE UNIQUE INDEX "federated_identities_userId_providerId_key"
    ON "federated_identities"("userId", "providerId");

CREATE INDEX "federated_identities_organizationId_idx"
    ON "federated_identities"("organizationId");

ALTER TABLE "federated_identities"
    ADD CONSTRAINT "federated_identities_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "federated_identities"
    ADD CONSTRAINT "federated_identities_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "federated_identities"
    ADD CONSTRAINT "federated_identities_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "org_identity_providers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── In-flight federated logins (OIDC state/nonce/PKCE, SAML request id) ─────
CREATE TABLE "sso_login_states" (
    "id" TEXT NOT NULL,
    -- The opaque `state` the IdP echoes back. UNIQUE so a collision can never
    -- silently adopt another in-flight login's PKCE verifier.
    "state" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "codeVerifier" TEXT,
    "nonce" TEXT,
    "requestId" TEXT,
    -- Same-origin relative path only; re-validated at use (open-redirect guard).
    "returnTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    -- Stamped by the SAME conditional UPDATE that claims the row, so a replayed
    -- callback finds nothing to claim. Single use is a property of the write,
    -- not of a read-then-check in application code.
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "sso_login_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sso_login_states_state_key"
    ON "sso_login_states"("state");

CREATE INDEX "sso_login_states_organizationId_idx"
    ON "sso_login_states"("organizationId");

-- Supports the expiry sweep that reclaims abandoned login attempts.
CREATE INDEX "sso_login_states_expiresAt_idx"
    ON "sso_login_states"("expiresAt");
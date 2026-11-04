-- Ticket 6f4d42f2 (2026-10-20): instance-wide web-search provider
-- configuration for self-hosted / Digby Edge instances. The admin enters a
-- Bright Data API key (+ zone) in Admin → Settings → Web search; the search
-- backend resolves it with env vars still taking precedence. apiKeyEnc is
-- AES-256-GCM at rest (coding/credentials.service helpers, key derived from
-- JWT_SECRET) and is never returned by any API response. provider is a slug
-- so a second search provider can be added later without another migration.
CREATE TABLE "search_provider_configs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL,
    "zone" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_provider_configs_pkey" PRIMARY KEY ("id")
);

-- Unique index for the provider slug
CREATE UNIQUE INDEX "search_provider_configs_provider_key" ON "search_provider_configs"("provider");

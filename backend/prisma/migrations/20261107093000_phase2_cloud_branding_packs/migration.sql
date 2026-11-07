-- Phase 2 Cloud — admin-selectable seasonal/holiday BRANDING PACKS (todo 61dc8aaf).
--
-- ADDITIVE ONLY: two NEW tables, no existing table/column/row is touched by this file.
--
-- WHY THESE TABLES EXIST. The shared branding core (todo d2d32b57) rebrands a
-- SELF-HOSTED instance from `DIGBY_BRAND_*` env values plus an operator-mounted
-- `branding/` directory served by the frontend's jailed `/branding/asset` route.
-- Neither mechanism exists on the Cloud deployment: `docker-compose.app.yml`
-- gives the frontend container NO volumes and no `DIGBY_BRANDING_DIR`, and the
-- backend mounts nothing the frontend can read. So a runtime-selectable pack has
-- no filesystem to live in. The bytes are therefore stored in Postgres (bytea),
-- the same storage decision `chat_files` already made for user uploads, and the
-- backend serves them through a jailed, allowlist-only route.
--
-- WHY NOT system_settings. A pack is a multi-asset object with per-file
-- validation state (sniffed MIME, dimensions, sha256) and an activation
-- lifecycle; it is not a key/value string. Putting it in the settings table
-- would mean encoding binaries in a text column.
--
-- THE ONE-ACTIVE INVARIANT IS ENFORCED HERE, IN THE DATABASE. A partial unique
-- index on a constant expression means at most ONE row may hold status='active'
-- at any instant, so two concurrent "activate" requests cannot both win by
-- reading "nothing is active" and each writing their own row. The service still
-- deactivates-then-activates inside one transaction for a clean audit trail, but
-- this index is the guarantee, not the service's good behaviour.
--
-- ROLLBACK: DROP TABLE "branding_pack_assets"; DROP TABLE "branding_packs";
-- nothing else references either (no FK into another table, no view, no trigger).
-- Branding then falls back to the shared core's env/default resolution — i.e.
-- rolling back restores shipped Digby branding, which is the safe direction.

-- CreateTable
CREATE TABLE "branding_packs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "manifest" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "branding_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branding_pack_assets" (
    "id" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "branding_pack_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branding_packs_status_idx" ON "branding_packs"("status");

-- AT MOST ONE ACTIVE PACK, guaranteed by the database (see the header).
CREATE UNIQUE INDEX "branding_packs_one_active_idx" ON "branding_packs"("status") WHERE "status" = 'active';

-- CreateIndex
CREATE UNIQUE INDEX "branding_pack_assets_packId_slot_key" ON "branding_pack_assets"("packId", "slot");

-- AddForeignKey
ALTER TABLE "branding_pack_assets" ADD CONSTRAINT "branding_pack_assets_packId_fkey" FOREIGN KEY ("packId") REFERENCES "branding_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
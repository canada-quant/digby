-- Multi-Mac pairing (owner 2026-09-24): an account may pair SEVERAL Macs.
-- Each physical Mac carries a stable agent-generated deviceId (uuid), so
-- pairing upserts on (userId, deviceId) — re-pairing rotates only THAT row's
-- token and never evicts the user's other Macs.
--
-- deviceId is nullable: existing rows predate the field (legacy single-Mac
-- clients keep pairing without one — they upsert on the legacy
-- (userId, label) path). The partial unique index only constrains rows that
-- HAVE a deviceId, so legacy rows stay valid.
--
-- The old unique index on (userId, label) is REPLACED by a plain index:
-- with multiple Macs two devices can legitimately share a label (e.g. two
-- fresh Macs both defaulting to their hostname when it repeats, or the
-- "Primary" default before a rename). Label uniqueness is enforced at WRITE
-- time in completePairing (best-effort de-dupe), not by the schema.

-- Drop the (userId, label) uniqueness — labels are display names now.
DROP INDEX IF EXISTS "imessage_agents_userId_label_key";

-- Keep label lookups fast without uniqueness.
CREATE INDEX IF NOT EXISTS "imessage_agents_userId_label_idx" ON "imessage_agents"("userId", "label");

-- Add the stable per-device identity.
ALTER TABLE "imessage_agents" ADD COLUMN "deviceId" TEXT;

-- Unique per user: one row per physical Mac (partial — legacy rows have no deviceId yet).
CREATE UNIQUE INDEX "imessage_agents_userId_deviceId_key" ON "imessage_agents"("userId", "deviceId") WHERE "deviceId" IS NOT NULL;

-- Routing target when no explicit device is named. Exactly one per user is
-- maintained by the service (setDefaultAgent runs in a transaction); the
-- database constraint is partial-unique to enforce it at the storage layer:
-- a second default for the same user cannot be written.
ALTER TABLE "imessage_agents" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "imessage_agents_one_default_per_user" ON "imessage_agents"("userId") WHERE "isDefault" = true;

-- Backfill: the user's existing (only) Mac becomes the default target. If a
-- user somehow already has several legacy rows (deviceName collisions under
-- the old single-Mac model left at most one per label), the most recently
-- paired one wins — matching getPrimaryAgent's existing orderBy pairedAt desc.
UPDATE "imessage_agents" a
SET "isDefault" = true
WHERE a."id" = (
  SELECT b."id" FROM "imessage_agents" b
  WHERE b."userId" = a."userId"
  ORDER BY b."pairedAt" DESC, b."createdAt" DESC
  LIMIT 1
);

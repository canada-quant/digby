-- Migration: Google OAuth multi-account support
-- Adds per-account label + proper id primary key to google_oauth_tokens.
-- Existing single-account rows are migrated with label = 'Personal'.

-- Step 1: Add the new id column (nullable first)
ALTER TABLE "google_oauth_tokens" ADD COLUMN "id" TEXT;

-- Step 2: Add label column with default
ALTER TABLE "google_oauth_tokens" ADD COLUMN "label" TEXT NOT NULL DEFAULT 'Personal';

-- Step 3: Populate id for existing rows using gen_random_uuid()
UPDATE "google_oauth_tokens" SET "id" = gen_random_uuid()::text WHERE "id" IS NULL;

-- Step 4: Make id NOT NULL
ALTER TABLE "google_oauth_tokens" ALTER COLUMN "id" SET NOT NULL;

-- Step 5: Drop the old primary key (userId was @id)
ALTER TABLE "google_oauth_tokens" DROP CONSTRAINT "google_oauth_tokens_pkey";

-- Step 6: Add new primary key on id
ALTER TABLE "google_oauth_tokens" ADD CONSTRAINT "google_oauth_tokens_pkey" PRIMARY KEY ("id");

-- Step 7: Add unique constraint on (userId, label)
CREATE UNIQUE INDEX IF NOT EXISTS "google_oauth_tokens_userId_label_key" ON "google_oauth_tokens"("userId", "label");

-- Step 8: Add index on userId for faster lookups
CREATE INDEX IF NOT EXISTS "google_oauth_tokens_userId_idx" ON "google_oauth_tokens"("userId");

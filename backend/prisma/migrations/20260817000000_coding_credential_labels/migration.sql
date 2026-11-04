-- Allow MULTIPLE stored credentials per provider/env-key via a `label`:
-- '' is the primary (injected under the canonical envKey); a label like
-- 'WORK' is injected as `${envKey}_WORK`. Existing rows backfill to '' and
-- keep their current behavior; uniqueness moves to (userId, envKey, label).

-- AlterTable
ALTER TABLE "coding_credentials" ADD COLUMN "label" TEXT NOT NULL DEFAULT '';

-- DropIndex
DROP INDEX "coding_credentials_userId_envKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "coding_credentials_userId_envKey_label_key" ON "coding_credentials"("userId", "envKey", "label");

-- Switch x_oauth_tokens from one-account-per-user to many-accounts-per-user
-- (matches GitHub OAuth label pattern). Existing rows default to label='Personal'.

-- Add label column with default 'Personal' so existing rows back-fill cleanly
ALTER TABLE "x_oauth_tokens" ADD COLUMN "label" TEXT NOT NULL DEFAULT 'Personal';

-- Drop the single-row-per-user unique constraint (named *_userId_key in PG)
DROP INDEX IF EXISTS "x_oauth_tokens_userId_key";

-- New composite unique on (userId, label)
CREATE UNIQUE INDEX "x_oauth_tokens_userId_label_key" ON "x_oauth_tokens"("userId", "label");

-- CreateTable: google_oauth_tokens
-- Stores per-user encrypted Google OAuth tokens for Gmail, Calendar, Drive, Docs, Sheets access.

CREATE TABLE "google_oauth_tokens" (
    "userId"       TEXT         NOT NULL,
    "accessToken"  TEXT         NOT NULL,
    "refreshToken" TEXT         NOT NULL,
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    "scopes"       TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "email"        TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_oauth_tokens_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "google_oauth_tokens" ADD CONSTRAINT "google_oauth_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

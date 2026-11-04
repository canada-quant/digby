-- CreateTable: xero_oauth_tokens
-- Per-user Xero OAuth tokens — encrypted at rest with AES-256-GCM.
-- Supports Xero Accounting API access (contacts, invoices, accounts, etc.).
CREATE TABLE "xero_oauth_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Default',
    "tenantId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[],
    "orgName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "xero_oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "xero_oauth_tokens_userId_idx" ON "xero_oauth_tokens"("userId");
CREATE UNIQUE INDEX "xero_oauth_tokens_userId_label_key" ON "xero_oauth_tokens"("userId", "label");

-- AddForeignKey
ALTER TABLE "xero_oauth_tokens" ADD CONSTRAINT "xero_oauth_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

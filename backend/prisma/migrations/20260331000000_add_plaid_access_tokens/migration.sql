-- CreateTable
CREATE TABLE "plaid_access_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Default',
    "accessToken" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "institutionId" TEXT,
    "institutionName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plaid_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plaid_access_tokens_userId_idx" ON "plaid_access_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "plaid_access_tokens_userId_itemId_key" ON "plaid_access_tokens"("userId", "itemId");

-- AddForeignKey
ALTER TABLE "plaid_access_tokens" ADD CONSTRAINT "plaid_access_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

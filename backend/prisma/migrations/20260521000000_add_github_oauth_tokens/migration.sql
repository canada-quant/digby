-- CreateTable
CREATE TABLE "github_oauth_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Personal',
    "accessToken" TEXT NOT NULL,
    "scopes" TEXT[],
    "username" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_oauth_tokens_userId_label_key" ON "github_oauth_tokens"("userId", "label");

-- CreateIndex
CREATE INDEX "github_oauth_tokens_userId_idx" ON "github_oauth_tokens"("userId");

-- AddForeignKey
ALTER TABLE "github_oauth_tokens" ADD CONSTRAINT "github_oauth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

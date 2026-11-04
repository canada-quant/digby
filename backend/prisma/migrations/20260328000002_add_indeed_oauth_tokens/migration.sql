-- CreateTable
CREATE TABLE "indeed_oauth_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[],
    "employerName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indeed_oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "indeed_oauth_tokens_userId_key" ON "indeed_oauth_tokens"("userId");

-- CreateIndex
CREATE INDEX "indeed_oauth_tokens_userId_idx" ON "indeed_oauth_tokens"("userId");

-- AddForeignKey
ALTER TABLE "indeed_oauth_tokens" ADD CONSTRAINT "indeed_oauth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

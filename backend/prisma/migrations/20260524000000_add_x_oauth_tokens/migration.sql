-- CreateTable
CREATE TABLE "x_oauth_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "tokenType" TEXT NOT NULL DEFAULT 'bearer',
    "scopes" TEXT[],
    "screenName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "x_oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "x_oauth_tokens_userId_key" ON "x_oauth_tokens"("userId");

-- CreateIndex
CREATE INDEX "x_oauth_tokens_userId_idx" ON "x_oauth_tokens"("userId");

-- AddForeignKey
ALTER TABLE "x_oauth_tokens" ADD CONSTRAINT "x_oauth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

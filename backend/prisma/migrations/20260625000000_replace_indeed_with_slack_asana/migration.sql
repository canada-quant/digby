-- Remove the retired Indeed Hiring integration.
-- DropForeignKey / DropTable
ALTER TABLE "indeed_oauth_tokens" DROP CONSTRAINT IF EXISTS "indeed_oauth_tokens_userId_fkey";
DROP TABLE IF EXISTS "indeed_oauth_tokens";

-- CreateTable: Slack (user token / xoxp — no expiry, multi-workspace via label)
CREATE TABLE "slack_oauth_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Workspace',
    "accessToken" TEXT NOT NULL,
    "scopes" TEXT[],
    "teamId" TEXT,
    "teamName" TEXT,
    "slackUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slack_oauth_tokens_userId_label_key" ON "slack_oauth_tokens"("userId", "label");

-- CreateIndex
CREATE INDEX "slack_oauth_tokens_userId_idx" ON "slack_oauth_tokens"("userId");

-- AddForeignKey
ALTER TABLE "slack_oauth_tokens" ADD CONSTRAINT "slack_oauth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: Asana (access token + long-lived refresh token, refreshed on demand)
CREATE TABLE "asana_oauth_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Default',
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[],
    "asanaUserId" TEXT,
    "asanaName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asana_oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "asana_oauth_tokens_userId_label_key" ON "asana_oauth_tokens"("userId", "label");

-- CreateIndex
CREATE INDEX "asana_oauth_tokens_userId_idx" ON "asana_oauth_tokens"("userId");

-- AddForeignKey
ALTER TABLE "asana_oauth_tokens" ADD CONSTRAINT "asana_oauth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

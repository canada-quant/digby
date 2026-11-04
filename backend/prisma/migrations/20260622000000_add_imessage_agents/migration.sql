-- CreateTable
CREATE TABLE "imessage_agents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Primary',
    "tokenHash" TEXT NOT NULL,
    "deviceName" TEXT,
    "agentVersion" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "pairedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "imessage_agents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "imessage_agents_tokenHash_key" ON "imessage_agents"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "imessage_agents_userId_label_key" ON "imessage_agents"("userId", "label");

-- CreateIndex
CREATE INDEX "imessage_agents_userId_idx" ON "imessage_agents"("userId");

-- AddForeignKey
ALTER TABLE "imessage_agents" ADD CONSTRAINT "imessage_agents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

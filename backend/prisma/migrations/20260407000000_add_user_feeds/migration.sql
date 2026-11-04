-- CreateTable
CREATE TABLE "user_feeds" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "enhancedPrompt" TEXT,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 60,
    "status" TEXT NOT NULL DEFAULT 'building',
    "chatId" TEXT,
    "lastFetchedAt" TIMESTAMP(3),
    "nextFetchAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_feeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_feed_entries" (
    "id" TEXT NOT NULL,
    "feedId" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "category" TEXT,
    "sourceUrl" TEXT,
    "metadata" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_feed_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_feeds_chatId_key" ON "user_feeds"("chatId");

-- CreateIndex
CREATE INDEX "user_feeds_userId_idx" ON "user_feeds"("userId");

-- CreateIndex
CREATE INDEX "user_feeds_status_nextFetchAt_idx" ON "user_feeds"("status", "nextFetchAt");

-- CreateIndex
CREATE INDEX "user_feed_entries_feedId_createdAt_idx" ON "user_feed_entries"("feedId", "createdAt");

-- AddForeignKey
ALTER TABLE "user_feeds" ADD CONSTRAINT "user_feeds_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feeds" ADD CONSTRAINT "user_feeds_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "crossmodel_chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feed_entries" ADD CONSTRAINT "user_feed_entries_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "user_feeds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

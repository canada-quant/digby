-- CreateTable
CREATE TABLE "crossmodel_chats" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'fast',
    "messages" JSONB[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crossmodel_chats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crossmodel_chats_userId_idx" ON "crossmodel_chats"("userId");

-- CreateIndex
CREATE INDEX "crossmodel_chats_mode_idx" ON "crossmodel_chats"("mode");

-- AddForeignKey
ALTER TABLE "crossmodel_chats" ADD CONSTRAINT "crossmodel_chats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

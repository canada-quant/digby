-- CreateTable
CREATE TABLE "chat_webhooks" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_webhooks_chatId_key" ON "chat_webhooks"("chatId");

-- AddForeignKey
ALTER TABLE "chat_webhooks" ADD CONSTRAINT "chat_webhooks_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "crossmodel_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

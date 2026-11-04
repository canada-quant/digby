-- CreateTable: CanvasDocument (Claude Artifacts / ChatGPT Canvas feature)
CREATE TABLE "canvas_documents" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'document',
    "language" TEXT,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canvas_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "canvas_documents_chatId_idx" ON "canvas_documents"("chatId");

-- CreateIndex
CREATE INDEX "canvas_documents_userId_idx" ON "canvas_documents"("userId");

-- AddForeignKey
ALTER TABLE "canvas_documents" ADD CONSTRAINT "canvas_documents_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "crossmodel_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canvas_documents" ADD CONSTRAINT "canvas_documents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

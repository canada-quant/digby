-- Persistent per-chat files (2026-08-25): durable copies of user UPLOADS.
-- A staged /crossmodel/upload blob (Redis cm:upload:<id>, 15-min TTL) is
-- persisted as a chat_files row the moment a send actually consumes it, so the
-- file outlives the staging TTL. UNIQUE (uploadId, chatId) makes a retried or
-- queue-drained re-resolution idempotent; onDelete: Cascade from
-- crossmodel_chats is the GC. See crossmodel/chat-files.service.ts.

-- CreateTable
CREATE TABLE "chat_files" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "uploadId" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_files_chatId_createdAt_idx" ON "chat_files"("chatId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "chat_files_uploadId_chatId_key" ON "chat_files"("uploadId", "chatId");

-- AddForeignKey
ALTER TABLE "chat_files" ADD CONSTRAINT "chat_files_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "crossmodel_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_files" ADD CONSTRAINT "chat_files_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

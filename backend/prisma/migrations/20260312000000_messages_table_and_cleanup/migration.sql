-- CreateTable: crossmodel_messages (replaces JSONB messages[] array)
CREATE TABLE "crossmodel_messages" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crossmodel_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crossmodel_messages_chatId_idx" ON "crossmodel_messages"("chatId");
CREATE INDEX "crossmodel_messages_chatId_createdAt_idx" ON "crossmodel_messages"("chatId", "createdAt");

-- AddForeignKey
ALTER TABLE "crossmodel_messages" ADD CONSTRAINT "crossmodel_messages_chatId_fkey"
    FOREIGN KEY ("chatId") REFERENCES "crossmodel_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ══════════════════════════════════════════════════════════════════════════════
-- Data Migration: copy existing JSONB messages[] → crossmodel_messages rows
-- Each JSONB element becomes a row. Preserves role, content, timestamp, metadata.
-- Uses gen_random_uuid() for new row IDs.
-- ══════════════════════════════════════════════════════════════════════════════
INSERT INTO "crossmodel_messages" ("id", "chatId", "role", "content", "metadata", "createdAt")
SELECT
    gen_random_uuid()::text,
    c."id",
    (msg->>'role')::text,
    COALESCE(msg->>'content', ''),
    CASE
        WHEN msg->'metadata' IS NOT NULL AND msg->>'metadata' != 'null'
        THEN msg->'metadata'
        ELSE NULL
    END,
    CASE
        WHEN msg->>'timestamp' IS NOT NULL
        THEN (msg->>'timestamp')::timestamp
        ELSE c."createdAt"
    END
FROM "crossmodel_chats" c,
     unnest(c."messages") AS msg
WHERE array_length(c."messages", 1) > 0;

-- ══════════════════════════════════════════════════════════════════════════════
-- Drop legacy columns (data now in PostgresStore / crossmodel_messages)
-- ══════════════════════════════════════════════════════════════════════════════

-- threadState → now in PostgresStore ([chatId, 'thread'] namespace)
ALTER TABLE "crossmodel_chats" DROP COLUMN IF EXISTS "threadState";

-- contextState → now in PostgresStore ([projectId, 'context'] namespace)
ALTER TABLE "crossmodel_projects" DROP COLUMN IF EXISTS "contextState";

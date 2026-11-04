-- Add source field to project_documents
-- "knowledge" = added via project Knowledge tab
-- "chat_upload" = uploaded during a chat conversation
ALTER TABLE "project_documents" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'knowledge';

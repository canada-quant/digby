-- AlterTable: Add threadState JSONB column to crossmodel_chats
-- Stores LangGraph ConversationThreadState per chat — summary, confirmed facts,
-- open topics, user goal. Used to maintain context in long conversations
-- without relying solely on a raw sliding window of messages.

ALTER TABLE "crossmodel_chats" ADD COLUMN "threadState" JSONB;

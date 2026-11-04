-- Queued messages carry staged /crossmodel/upload ids (ticket ac65d51e) so a
-- busy-chat send no longer drops attachments. Drain resolves them like an
-- immediate send; the Redis TTL on each cm:upload:<id> is extended at enqueue.
ALTER TABLE "pending_chat_messages" ADD COLUMN "uploadIds" JSONB;

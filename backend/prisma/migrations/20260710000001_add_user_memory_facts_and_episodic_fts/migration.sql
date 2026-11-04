-- Semantic memory layer (Phase 2):
-- 1. user_memory_facts — one row per stored fact, embedded (DashScope text-embedding-v4,
--    1536d) for pgvector HNSW retrieval. Derived index over the canonical
--    user_memory.facts blob; reconciled after every blob write + lazily backfilled.
CREATE TABLE "user_memory_facts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_memory_facts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_memory_facts_userId_key_key" ON "user_memory_facts"("userId", "key");
CREATE INDEX "user_memory_facts_userId_idx" ON "user_memory_facts"("userId");
CREATE INDEX "user_memory_facts_embedding_idx" ON "user_memory_facts" USING hnsw ("embedding" vector_cosine_ops);

-- 2. Episodic memory: full-text search over past chat messages ("what did we
--    discuss last week?"). Expression index must match the query expression
--    exactly (to_tsvector('english', content)) for the planner to use it.
CREATE INDEX IF NOT EXISTS "crossmodel_messages_content_fts_idx"
  ON "crossmodel_messages" USING GIN (to_tsvector('english', "content"));

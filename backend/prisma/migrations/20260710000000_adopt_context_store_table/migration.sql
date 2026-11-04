-- Adopt the LangGraph PostgresStore table ("store") as a first-class Prisma model.
-- IDEMPOTENT: production already has this table + indexes (created at runtime by
-- PostgresStore.setup()); this migration only creates them in fresh environments.
-- Column definitions match the original @langchain/langgraph-checkpoint-postgres
-- store-migrations DDL exactly so existing data is untouched.
CREATE TABLE IF NOT EXISTS "store" (
    namespace_path TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ,
    PRIMARY KEY (namespace_path, key)
);

CREATE INDEX IF NOT EXISTS idx_store_namespace_path ON "store" USING btree (namespace_path);
CREATE INDEX IF NOT EXISTS idx_store_value_gin ON "store" USING gin (value);
CREATE INDEX IF NOT EXISTS idx_store_expires_at ON "store" USING btree (expires_at) WHERE expires_at IS NOT NULL;

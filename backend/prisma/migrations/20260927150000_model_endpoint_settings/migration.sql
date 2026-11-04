-- 2026-09-27 seat/provider limits (owner incident: the Fleet Supervisor seated on
-- `cql-litellm:api-openai-gpt-6-astra` 400'd every turn for 6 h — 195 tools on a
-- 128-tool OpenAI cap behind LiteLLM). Endpoint-level settings for the custom
-- model-endpoint registry: today `{ maxTools? }` — one tool cap for every model
-- on the endpoint that carries no per-model cap (a proxy fronting one provider
-- family). Per-model flags keep living in the `models` JSON column.
-- Additive, nullable, no backfill: a NULL row reads as `{}`
-- (model-endpoints.service validateSettings). IF NOT EXISTS keeps a re-applied
-- migration idempotent.

-- AlterTable
ALTER TABLE "model_endpoints" ADD COLUMN IF NOT EXISTS "settings" JSONB;

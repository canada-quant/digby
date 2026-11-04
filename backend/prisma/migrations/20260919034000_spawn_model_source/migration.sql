-- Spawn-time model provenance (ticket b6acc1e3): start_coding_session gains an
-- optional `model` parameter so a supervisor seat can pick the spawned
-- session's coding model (e.g. route around a provider billing outage —
-- 2026-09-17 kimi-k3 429: spawn d4ab649b stamped the dead default and its
-- first run died on the same 429). modelSource records WHERE the stamp came
-- from: NULL = default resolution (project pick → user pref → coding_default
-- seat); 'spawn-param' = an explicit tool argument. The run-time
-- project-codingModel override (owner 2026-09-04) skips 'spawn-param'
-- sessions so an explicit pick is not silently re-routed on the first run.
-- ADDITIVE ONLY: one nullable column, no backfill — existing rows keep NULL
-- and byte-identical override behavior.

-- AlterTable
ALTER TABLE "coding_sessions" ADD COLUMN IF NOT EXISTS "modelSource" TEXT;

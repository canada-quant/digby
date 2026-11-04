-- One-Digby Phase 2 (step 4): agent chat engine persistence. Additive only.
-- crossmodel_messages.parts — the agent transcript's ordered parts (reuses the
-- CodingMessage parts shape verbatim); null for legacy-pipeline messages.
ALTER TABLE "crossmodel_messages" ADD COLUMN IF NOT EXISTS "parts" JSONB;
-- user_preferences.chatEngine — '' (default resolution) | 'agent' | 'legacy'.
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "chatEngine" TEXT NOT NULL DEFAULT '';

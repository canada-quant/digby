-- Shared tailnet dev container (owner decision 2026-08-22, ticket 3ba5d35d):
-- per-user opt-in toggle; the tailscale auth key rides the existing encrypted
-- coding_credentials table (provider 'tailscale'), so this is the only column.
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "devContainerEnabled" BOOLEAN NOT NULL DEFAULT false;

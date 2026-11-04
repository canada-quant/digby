-- 2026-08-30 fleet audit: who last wrote a schedule's prompt ('user' |
-- 'machine' | 'system'), so the supervisor sweep can surface autonomous
-- watch-mode drift. Nullable, no backfill (NULL = predates the column).
ALTER TABLE "coding_schedules" ADD COLUMN "promptSetBy" TEXT;

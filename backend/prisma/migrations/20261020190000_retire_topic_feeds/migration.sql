-- Ticket 43c24152 (owner directive 2026-10-20): topic FEEDS are retired from the
-- platform — schedule_message on a real chat supersedes them (full agent turn,
-- chat history + standing instructions, the whole toolset, delta-gating, Telegram
-- delivery). This migration is the "no cliff" half: every existing feed is
-- converted into a recurring schedule on ITS OWN chat (prompt = digest of the
-- feed topic, cadence = the feed's interval), the feed's chat gets one visible
-- deprecation notice, and then the feed tables go away.
--
-- Conversion contract (mirrors createSchedule semantics where observable):
--   kind='recurring', intervalSec = intervalMinutes*60 (feeds floor 60 min, the
--     scheduler's MIN_INTERVAL_SEC is 15 min — every feed cadence is legal),
--   nextRunAt = now + interval (first firing one full cadence out — the feed had
--     just fired on its own schedule),
--   expiresAt = now + 30 d (MAX_LIFETIME_MS): the sweeper's sliding-expiry
--     repair (schedule.service ~l.1819) re-arms expiresAt for any enabled row
--     whose expiry lapsed, so the digest never dies silently at 30 d.
--   enabled = (status <> 'paused') — a PAUSED feed must not silently re-subscribe
--     the user to digests; its schedule row is parked (enabled=false) and
--     resumable in the chat's schedule UI.
--   promptSetBy='user' (the owner created the feed), ownerSubscribed=true (the
--     digest is content the OWNER asked to receive — ticket 4565991a semantics),
--   renewOnExhaustion=false (maxRuns is NULL = unbounded; the column only
--     governs the exhaustion path, but FALSE is the deliberate-stop posture).
--   maxRuns NULL — the 500 cap exists to bound runaway machine watches; this is
--     an owner-asked digest that must keep running (the sweeper's renewal logic
--     covers a hit anyway).
-- Feeds with chatId IS NULL (building, chat creation never landed) are dropped
-- without conversion — they never delivered anything.
-- Idempotency: guarded by NOT EXISTS on the (sessionId, topic-bearing prompt)
-- match so a re-run (blue/green boundary, re-applied env) cannot double-create.

-- 1) Convert every feed that has a chat into a recurring schedule on that chat.
INSERT INTO "coding_schedules" (
  "id", "sessionId", "userId", "prompt", "kind", "intervalSec", "nextRunAt",
  "enabled", "runsCount", "maxRuns", "expiresAt", "promptSetBy", "ownerSubscribed",
  "renewOnExhaustion", "busySkips", "createdAt"
)
SELECT
  gen_random_uuid()::text,
  f."chatId",
  f."userId",
  'Topic digest (migrated from your retired feed "' || f."title" || '"): research the latest on ' || f."topic" || ' and post a concise digest of what changed since the last one. Cite sources.',
  'recurring',
  GREATEST(60, f."intervalMinutes") * 60,
  now() + (GREATEST(60, f."intervalMinutes") * interval '1 minute'),
  (f."status" <> 'paused'),
  0,
  NULL,
  now() + interval '30 days',
  'user',
  true,
  false,
  0,
  now()
FROM "user_feeds" f
WHERE f."chatId" IS NOT NULL
  AND NOT EXISTS (
    -- idempotency: this chat already holds the schedule this migration builds
    -- (matched on the invariant topic-bearing fragment of the prompt).
    SELECT 1 FROM "coding_schedules" s
    WHERE s."sessionId" = f."chatId"
      AND s."prompt" LIKE '%research the latest on ' || f."topic" || ' and post%'
  );

-- 2) One visible deprecation notice in each feed chat (assistant message, the
--    same shape the feed digests used) — the owner sees WHY the digests moved and
--    where to manage them. Also bumps the chat's updatedAt so the sidebar
--    re-renders it (ticket b6ce8490 contract).
INSERT INTO "crossmodel_messages" ("id", "chatId", "role", "content", "createdAt")
SELECT
  gen_random_uuid()::text,
  f."chatId",
  'assistant',
  E'📡 **This feed has been retired** — Digby no longer runs topic feeds (they are superseded by scheduled digests on real chats, which have full memory, your integrations and the ability to act).\n\n'
    || E'**Nothing is lost**: your digest now runs as a scheduled message on THIS chat, with the same topic and the same cadence as the feed had. Manage it with "pause/resume my schedule" or in the chat header — or just ask Digby in this chat.\n\n'
    || E'*Topic: ' || f."topic" || '*',
  now()
FROM "user_feeds" f
WHERE f."chatId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "crossmodel_messages" m
    WHERE m."chatId" = f."chatId"
      AND m."content" LIKE '%This feed has been retired%'
  );

UPDATE "crossmodel_chats" c
SET "updatedAt" = now()
WHERE EXISTS (
  SELECT 1 FROM "crossmodel_messages" m
  WHERE m."chatId" = c."id" AND m."content" LIKE '%This feed has been retired%'
);

-- 3) Drop the feed subsystem tables (entries first — FK).
DROP TABLE IF EXISTS "user_feed_entries";
DROP TABLE IF EXISTS "user_feeds";

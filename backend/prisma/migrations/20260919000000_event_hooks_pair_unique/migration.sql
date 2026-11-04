-- (source,target) pair dedup for event-hook subscriptions (ticket c65de47c,
-- P1): subscribeHook historically created a new EventHook row UNCONDITIONALLY —
-- the internal supervisor lanes self-dedup before subscribing, but the PUBLIC
-- hook_subscribe tool path could double-wire the same (source,target) pair, and
-- every event then woke the target TWICE (doubled machine runs, doubled budget
-- burn). subscribeHook now dedups pre-create (update-in-place + deduped:true)
-- and converges on P2002; this index makes "one hook per specific pair" a DB
-- invariant so a lost find-then-create race can never resurrect the double
-- wake. Mirrored in schema.prisma as
-- @@unique([sourceChatId, targetChatId], map: "event_hooks_one_hook_per_pair").
--
-- Wildcards are untouched: Postgres treats NULLs as distinct, so
-- sourceChatId-NULL rows are NOT constrained here — they remain covered by the
-- partial unique indexes event_hooks_one_wildcard_per_target (owner-scope) and
-- event_hooks_one_project_hook_per_target (project-scope), both recreated in
-- 20260914000000_project_supervisors.

-- (a) DEDUPE PRE-STEP — collapse any pre-existing duplicate specific-pair rows
-- (source_chat_id IS NOT NULL) to exactly ONE row per pair: the most recently
-- updated (ties broken by id for determinism). Dependent HookEvent outbox rows
-- are RE-POINTED to the kept row first: HookEvent.hookId has ON DELETE CASCADE
-- (schema.prisma HookEvent.hook), so a bare delete would cascade away still-
-- pending wakes — re-pointing preserves them (a duplicate pair's pending events
-- are semantically the same wake; the kept hook's template renders them).
--
-- Adversarial-review finding C-F1 (batch-2 review, 2026-09-19): the dup set of
-- this re-point MUST be exactly the DELETE's loser set — rows that have a
-- STRICTLY newer sibling under the same (updatedAt, id) comparator. Without
-- that predicate the pair SURVIVOR also joins (it has older siblings), its own
-- pending hook_events would be re-pointed to the doomed runner-up, and the
-- DELETE's cascade would silently drop the very wakes this step exists to
-- preserve (simulation-proven by the reviewer: 3/3 scenarios). With the
-- predicate, each loser's DISTINCT-ON pick (newest sibling) is the survivor.
UPDATE "hook_events" he
SET "hookId" = m.keep_id
FROM (
  SELECT DISTINCT ON (dup.id) dup.id AS dup_id, keep.id AS keep_id
  FROM "event_hooks" dup
  JOIN "event_hooks" keep
    ON keep."sourceChatId" = dup."sourceChatId"
   AND keep."targetChatId" = dup."targetChatId"
   AND keep.id <> dup.id
   AND (keep."updatedAt" > dup."updatedAt"
        OR (keep."updatedAt" = dup."updatedAt" AND keep.id > dup.id))
  WHERE dup."sourceChatId" IS NOT NULL
  ORDER BY dup.id, keep."updatedAt" DESC, keep.id DESC
) m
WHERE he."hookId" = m.dup_id;

DELETE FROM "event_hooks" dup
USING "event_hooks" keep
WHERE dup."sourceChatId" IS NOT NULL
  AND keep."sourceChatId" = dup."sourceChatId"
  AND keep."targetChatId" = dup."targetChatId"
  AND keep.id <> dup.id
  AND (keep."updatedAt" > dup."updatedAt"
       OR (keep."updatedAt" = dup."updatedAt" AND keep.id > dup.id));

-- (b) The pair invariant. IF NOT EXISTS for parity with the other hand-written
-- hook indexes; the dedupe above guarantees creation cannot fail on dups.
CREATE UNIQUE INDEX IF NOT EXISTS "event_hooks_one_hook_per_pair"
    ON "event_hooks" ("sourceChatId", "targetChatId");

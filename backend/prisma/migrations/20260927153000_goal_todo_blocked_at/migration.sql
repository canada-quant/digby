-- Review fix on sup3/project-digest-status-card-eta (2026-09-27, finding 3):
-- the project digest's stale-deps gate (DEPS_BLOCK_STALE_MS 72 h) aged a
-- deps-blocked todo on updatedAt — which EVERY blockedReason refresh,
-- progressNote restamp and dependency recompute bumps — so a row lanes kept
-- touching never aged past the gate (live read-only probe on box A: canlaw todo
-- dc507413, blockKind 'deps', blocked since 09-09, updatedAt age 1 h ⇒
-- staleDepsBlockedCount 0). blockedAt is the honest anchor: stamped ONCE on the
-- transition INTO 'blocked' (goals.service updateGoal / updateTodo, the
-- auto_block recomputes, create-with-open-deps), cleared on the way out, and
-- untouched by reason / kind / gate / note rewrites. Nullable + additive.
ALTER TABLE "project_goals" ADD COLUMN IF NOT EXISTS "blockedAt" TIMESTAMP(3);
ALTER TABLE "project_todos" ADD COLUMN IF NOT EXISTS "blockedAt" TIMESTAMP(3);

-- Backfill the rows blocked TODAY from the audit trail (Activity resource
-- 'platform'): the LATEST block transition per row — todo.auto_block,
-- todo.update {toStatus:'blocked'}, todo.create {status:'blocked'} (goal.*
-- likewise). A currently-blocked row's latest block transition IS the start of
-- its current block. Rows with no audited transition stay NULL and the digest
-- falls back to the updatedAt proxy (today's behaviour) until their next block.
UPDATE "project_todos" t
SET "blockedAt" = a."at"
FROM (
  SELECT "metadata"->>'todoId' AS "id", MAX("createdAt") AS "at"
  FROM "activities"
  WHERE "resource" = 'platform'
    AND "metadata"->>'todoId' IS NOT NULL
    AND (
      "action" = 'todo.auto_block'
      OR ("action" = 'todo.update' AND "metadata"->>'toStatus' = 'blocked')
      OR ("action" = 'todo.create' AND "metadata"->>'status' = 'blocked')
    )
  GROUP BY "metadata"->>'todoId'
) a
WHERE t."id" = a."id" AND t."status" = 'blocked' AND t."blockedAt" IS NULL;

UPDATE "project_goals" g
SET "blockedAt" = a."at"
FROM (
  SELECT "metadata"->>'goalId' AS "id", MAX("createdAt") AS "at"
  FROM "activities"
  WHERE "resource" = 'platform'
    AND "metadata"->>'goalId' IS NOT NULL
    AND (
      "action" = 'goal.auto_block'
      OR ("action" = 'goal.update' AND "metadata"->>'toStatus' = 'blocked')
      OR ("action" = 'goal.create' AND "metadata"->>'status' = 'blocked')
    )
  GROUP BY "metadata"->>'goalId'
) a
WHERE g."id" = a."id" AND g."status" = 'blocked' AND g."blockedAt" IS NULL;

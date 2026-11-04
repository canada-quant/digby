-- Remediation P7 (2026-09-09) — program model: spend, resources, gates, digests.
-- ADDITIVE ONLY: nullable columns + two new soft-ref tables. Spend caps
-- themselves ride the context store (ProjectSettings / [chatId,'settings']) —
-- no spend columns here.

-- G13 (probe-shape gate): optional [{tool, argPattern?}] list a machine run on
-- this schedule must evidence in its receipts at finalize.
ALTER TABLE "coding_schedules" ADD COLUMN IF NOT EXISTS "requiredProbes" JSONB;

-- S2b (decision cards with cost-of-delay + conservative default answers):
--   idleUsdPerDay    — the flagger's estimate of what waiting costs per day
--   defaultAfterDays — after this many OPEN days the question auto-answers…
--   defaultOption    — …with this option (BOTH must be set by the flagger)
--   answeredBy       — who answered: 'owner' (REST) | 'default' (auto-answer)
ALTER TABLE "owner_questions" ADD COLUMN IF NOT EXISTS "idleUsdPerDay" DOUBLE PRECISION;
ALTER TABLE "owner_questions" ADD COLUMN IF NOT EXISTS "defaultAfterDays" INTEGER;
ALTER TABLE "owner_questions" ADD COLUMN IF NOT EXISTS "defaultOption" TEXT;
ALTER TABLE "owner_questions" ADD COLUMN IF NOT EXISTS "answeredBy" TEXT;

-- v1#20 (progress-aware pulse): free-text progress notes + when work actually
-- STARTED (stamped on the todo's first pending→in_progress transition).
ALTER TABLE "project_goals" ADD COLUMN IF NOT EXISTS "progressNote" TEXT;
ALTER TABLE "project_todos" ADD COLUMN IF NOT EXISTS "progressNote" TEXT;
ALTER TABLE "project_todos" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3);

-- G16 (program-truth reader): the project's .digby/rules/00-current-state.md
-- (bounded 4k) read from the bare mirror's default branch at digest build.
ALTER TABLE "project_digests" ADD COLUMN IF NOT EXISTS "programState" TEXT;

-- S1b: watched external resources (GPU reservations, long-running training
-- boxes, paid sandboxes…) a lane is responsible for OBSERVING. Soft refs only
-- (the PendingConfirmation orphan-tolerance argument): rows must survive their
-- project/chat being deleted so the money-clock keeps ticking visibly.
CREATE TABLE IF NOT EXISTS "watched_resources" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "label" TEXT NOT NULL,
    "usdPerHour" DOUBLE PRECISION,
    "reservationEndsAt" TIMESTAMP(3),
    "maxUnobservedMinutes" INTEGER NOT NULL,
    "lastObservedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watched_resources_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "watched_resources_userId_idx" ON "watched_resources"("userId");
CREATE INDEX IF NOT EXISTS "watched_resources_projectId_idx" ON "watched_resources"("projectId");

-- S1b: durable training artifacts (checkpoints/datasets/evals/models) with a
-- verify_durable stamp — release/teardown of a watched resource is refused by
-- the lane doctrine until the artifacts it produced verify durable.
CREATE TABLE IF NOT EXISTS "training_artifacts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "sha" TEXT,
    "bytes" DOUBLE PRECISION,
    "durableVerifiedAt" TIMESTAMP(3),
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "training_artifacts_userId_idx" ON "training_artifacts"("userId");
CREATE INDEX IF NOT EXISTS "training_artifacts_projectId_idx" ON "training_artifacts"("projectId");

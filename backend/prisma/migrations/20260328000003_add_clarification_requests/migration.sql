-- CreateTable: clarification_requests
-- When the Kanban autopilot agent cannot complete a task without external
-- help (missing creds, out-of-scope change, ambiguous spec), it signals
-- NEEDS_CLARIFICATION in its completion message. The bridge picks this up,
-- stores the question here, and Paul answers it in the admin panel.
-- On the next bridge run the answered request is used to resume the task.

CREATE TABLE "clarification_requests" (
    "id"           TEXT        NOT NULL,
    "kanbanTaskId" TEXT        NOT NULL,
    "taskTitle"    TEXT        NOT NULL,
    "taskType"     TEXT,
    "sourceId"     TEXT,
    "question"     TEXT        NOT NULL,
    "answer"       TEXT,
    "status"       TEXT        NOT NULL DEFAULT 'pending',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt"   TIMESTAMP(3),
    "resolvedAt"   TIMESTAMP(3),

    CONSTRAINT "clarification_requests_pkey" PRIMARY KEY ("id")
);

-- Index for fast pending/answered lookups
CREATE INDEX "clarification_requests_status_idx" ON "clarification_requests"("status");

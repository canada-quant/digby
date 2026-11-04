-- P6 remediation (honest long-lane memory) — ADDITIVE ONLY.
-- v1#36: run_journal_entries.observations — 1-2 lines of concrete metrics/state
-- captured even on no-action machine runs (metric trajectory across idle firings).
ALTER TABLE "run_journal_entries" ADD COLUMN "observations" TEXT;

-- N4 (the 128-rewrites lane): append-only ledger of schedule prompt rewrites.
-- Each row preserves the OUTGOING prompt before an update_schedule overwrite;
-- `author` is the rewriter ('user' | 'machine' | 'system') and feeds the
-- 5/day machine-rewrite cap; `runId` is an optional soft ref to agent_runs.
CREATE TABLE "schedule_prompt_history" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "author" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_prompt_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "schedule_prompt_history_scheduleId_createdAt_idx" ON "schedule_prompt_history"("scheduleId", "createdAt");

ALTER TABLE "schedule_prompt_history" ADD CONSTRAINT "schedule_prompt_history_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "coding_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

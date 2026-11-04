-- GOAL-PRIORITY-SPEND (supervisor SOTA round 3, 2026-10-20; owner decision
-- Paul 2026-10-20 "ship it"): lane effort followed FIFO (lane-todos picked the
-- oldest pending todo; the [BOARD] listed goals by createdAt) and no goal
-- carried a value signal the supervisors could rank or rebalance on.
--   priority        1 (P1, highest) .. 4 (P4, lowest); NULL = unset = P2 (the
--                   default is applied in code — platform/goal-priority.ts —
--                   so no row is rewritten here).
--   prioritySource  'owner' | 'member' | 'machine' — who last set the ranking
--                   fields (priority / dueAt). An OWNER-set (project owner)
--                   ranking is never overwritten by anyone else; 'member' (a
--                   shared project's editor) is not a lock (goals.service).
--   dueAt           optional due date; a near / passed due date adds score.
-- ADDITIVE ONLY: three nullable columns, no default, no data rewrite — the
-- blue-green old colour never selects them and keeps working unchanged.
ALTER TABLE "project_goals" ADD COLUMN IF NOT EXISTS "priority" INTEGER;
ALTER TABLE "project_goals" ADD COLUMN IF NOT EXISTS "prioritySource" TEXT;
ALTER TABLE "project_goals" ADD COLUMN IF NOT EXISTS "dueAt" TIMESTAMP(3);

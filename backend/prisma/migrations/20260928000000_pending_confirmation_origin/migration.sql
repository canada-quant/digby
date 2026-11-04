-- Cohesive chat (2026-09-28, branch cohesive/inline-task-card): a staged
-- consequential-tool confirmation records WHO staged it — 'user' (a real user
-- turn: ctx.userTurnAt set) or 'machine' (a schedule / hook / agent wake) — so
-- the pending listing can tell the client that a human-turn
-- start_coding_session card is never an affordance (those spawns execute
-- directly and report through the inline task card) while machine-staged cards
-- keep rendering. Nullable + additive; legacy rows stay NULL and render as
-- before.
ALTER TABLE "pending_confirmations" ADD COLUMN IF NOT EXISTS "origin" TEXT;

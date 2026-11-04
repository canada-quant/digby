-- Project Pulse (owner 2026-09-04): the hourly project digest gains
-- deterministic goal-progress facts + an honest ETA projection, both computed
-- in code by the digest sweep (never model-invented).
--   project_digests.goalProgress — DigestGoalProgress[] JSON: per active/blocked
--     goal — title, todosDone/todosTotal, blockedCount, completions in the
--     trailing 24h and 7d, and a computed eta {remaining, pacePerDay, etaDays,
--     class}. '[]' default backfills every existing row (no goals tracked yet).
--   project_digests.etaSummary — DigestEtaSummary JSON (project-level rollup);
--     NULL = the bucket has no active/blocked goals (incl. the UNGROUPED bucket).
-- Purely additive: old rows read as "no goal facts yet" and the next hourly
-- sweep fills them in (the signature change regenerates every bucket once).
ALTER TABLE "project_digests" ADD COLUMN "goalProgress" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "project_digests" ADD COLUMN "etaSummary" JSONB;

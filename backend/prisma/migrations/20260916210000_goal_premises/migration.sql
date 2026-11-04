-- Premise register (owner directive 2026-09-16, framework item 2): the
-- quantitative premises a goal rests on (a baseline score, a throughput, a
-- price), each optionally tied to an https source the framework re-checks
-- hourly (platform/premise-register.ts). Purely additive: every existing row
-- reads an empty register; validation (≤8 premises, https-only sources,
-- jsonPath|pattern readers) lives in the service layer, not a CHECK constraint
-- (matches the autoArchiveIdleDays / spendCapUsdPerDay precedent).

-- AlterTable
ALTER TABLE "project_goals" ADD COLUMN IF NOT EXISTS "premises" JSONB NOT NULL DEFAULT '[]';

-- Hook creator provenance (feedback dd3a19fa, 2026-09-20): a derailed
-- machine-triggered run armed a stray owner-scope WILDCARD hook onto a lane
-- that already had project-scope coverage; the duplicate double-woke and
-- re-derailed the lane twice, and afterwards NOBODY could tell who created
-- the hook — event_hooks rows carried no creator/provenance field at all.
-- These three nullable columns stamp WHO armed each hook (the creating
-- surface, the acting chat, and the agent run) at create time; null = a row
-- predating the columns (or a REST/framework writer). ADDITIVE ONLY: three
-- nullable columns, no existing-row change (the gate_write_authorship
-- precedent, feedback c286ba91).

-- AlterTable
ALTER TABLE "event_hooks" ADD COLUMN IF NOT EXISTS "createdVia" TEXT,
ADD COLUMN IF NOT EXISTS "createdByChatId" TEXT,
ADD COLUMN IF NOT EXISTS "createdByRunId" TEXT;

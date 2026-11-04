-- Todo fea78360 (monitor lesson 6, 2026-10-16): owner-card replacement
-- linkage — one decision, one live card. supersedesId on the replacement
-- names the card it replaces; supersededBy on the old card points forward.
-- Both nullable + additive (legacy rows and the no-supersedes path store
-- null), same shape as the consoleAction column (20261016152000).
ALTER TABLE "owner_questions" ADD COLUMN "supersedesId" TEXT;
ALTER TABLE "owner_questions" ADD COLUMN "supersededBy" TEXT;

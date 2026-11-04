-- Agent platform + capability handshake (Windows client W0, roadmap §2.7 —
-- 2026-09-25). The backend used to infer "what can this agent do" from
-- agentVersion alone — single-axis gates that assume a Mac with
-- iMessage + browser + computer. A Windows agent ships browser + computer
-- but never iMessage, so agents now ADVERTISE their platform and capability
-- set at pair time and on every poll.
--
-- Both columns are additive/nullable-or-defaulted so every existing (Mac)
-- row keeps its exact current behavior:
--   platform NULL     → resolved as 'macos' (legacy rows are all Macs)
--   capabilities []   → "no advertisement" → the historical Mac version gates
--                       (browser ≥ 0.2.0, computer ≥ 0.3.0, imessage always)

ALTER TABLE "imessage_agents" ADD COLUMN "platform" TEXT;

ALTER TABLE "imessage_agents" ADD COLUMN "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Sub-session lineage (audit sub-session verdict: "promote, don't build"):
-- parentChatId marks a chat/session spawned by ANOTHER chat's
-- start_coding_session call — the parent. SOFT ref by design (no FK — same
-- rationale as run_journal_entries.runId / loop_metrics.sessionId): a child
-- must survive its parent's deletion and KEEP the marker, so the idle-child
-- reaper still covers orphans and the implicit parent→child autonomy check
-- (which re-reads the CURRENT value per call) simply stops matching. The index
-- covers the autonomy target check, the sidebar grouping read, and the
-- reaper's child scan.

-- AlterTable
ALTER TABLE "crossmodel_chats" ADD COLUMN "parentChatId" TEXT;

-- CreateIndex
CREATE INDEX "crossmodel_chats_parentChatId_idx" ON "crossmodel_chats"("parentChatId");

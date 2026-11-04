-- Ghost mode (owner 2026-10-22): per-chat private posture flag. false = the
-- chat's normal lineup + full memory/learning, true = admin-designated ghost
-- endpoint powers every leg and the chat is excluded from memory extraction
-- and cross-chat surfacing. Additive, backfill-free (default false).
ALTER TABLE "crossmodel_chats" ADD COLUMN "ghostMode" BOOLEAN NOT NULL DEFAULT false;

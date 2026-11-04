-- Platform default coding permission mode 'ask' → 'auto' (owner decision
-- oq_93a7e24c, 2026-09-17, Fleet Autonomy todo 5818b20f): in ask mode an
-- unattended/scheduled run's mutating tools AUTO-DENY on the approval timeout
-- (coding/approval-registry.ts), silently crippling unattended coding chats.
-- DEFAULT-only change — NO data backfill: a stored 'ask' row is
-- indistinguishable from an explicit 'ask' choice, so flipping existing rows
-- would silently downgrade users who deliberately picked the safe mode.
-- New users (and any user whose row is created from here on) start 'auto';
-- existing rows keep their stored value.

-- AlterTable
ALTER TABLE "user_preferences" ALTER COLUMN "codingPermissionMode" SET DEFAULT 'auto';
ALTER TABLE "coding_sessions"  ALTER COLUMN "permissionMode"       SET DEFAULT 'auto';

-- Mac permission onboarding + self-diagnostics (feedback ticket 2f646c10 —
-- 2026-09-25). The Mac agent now advertises its macOS TCC state on every poll
-- and at pair time: {"ax":bool,"sr":bool,"fda":bool,"relaunch":bool}
--   ax       — Accessibility (computer control) granted
--   sr       — Screen Recording (screenshots) granted
--   fda      — Full Disk Access (reading ~/Library/Messages/chat.db) granted
--   relaunch — the helper must be bounced: the .app bundle was swapped under
--              the running DigbyHelper (app update), or Accessibility LOOKS
--              granted while input is provably dead (stale-grant ghost)
--
-- NULL = a legacy agent (pre-0.6.0) never advertised — the UI shows the
-- "update the Mac agent" hint instead of a checklist. Absent fields never
-- clobber the stored value (same contract as platform/capabilities).

ALTER TABLE "imessage_agents" ADD COLUMN "permissions" JSONB;

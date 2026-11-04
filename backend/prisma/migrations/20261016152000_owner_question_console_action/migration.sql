-- Ticket 1b1c41bc (owner ask 2026-10-16, 3× in one day: "You need to send me
-- what to put with more instructinos and better instructions always…make sure
-- to add this to frameowrk"): a card that asks the owner to act in an EXTERNAL
-- console (Tailscale ACL, GCP service-account key, Gmail app password…) must
-- carry the EXACT paste-ready payload plus click-by-click steps in the card
-- body itself. The structured spec {consoleName, consoleUrl, whatAndWhySafe,
-- payload?, payloadLanguage?, steps[]} is stored so the pending surface can
-- flag the card kind; the composed four-element body lives in `question`.
ALTER TABLE "owner_questions" ADD COLUMN "consoleAction" JSONB;

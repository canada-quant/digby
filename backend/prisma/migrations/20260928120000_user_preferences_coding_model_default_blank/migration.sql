-- Seats govern sessions (2026-09-28): the UserPreferences.codingModel column
-- default "glm-5.2" made EVERY user carry what looked like a personal coding-
-- model pick, so the admin's Workspace default seat (coding_default) never
-- applied to a new session. '' = no pick — the seat governs. Existing rows are
-- untouched (a stored value counts as a pick only with the explicit marker in
-- the context store; see backend/src/modules/crossmodel/coding/seat-governance.ts).
-- Additive: a column default change, no rewrite, no lock beyond the catalog.
ALTER TABLE "user_preferences" ALTER COLUMN "codingModel" SET DEFAULT '';

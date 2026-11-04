-- Autopilot removed (2026-07-20): drop its two owned tables. Both are written
-- ONLY by the retired autopilot; no app feature reads them. Shared tables
-- (user_feature_requests, message_feedback, app_error_logs) are NOT touched.
DROP TABLE IF EXISTS "clarification_requests";
DROP TABLE IF EXISTS "autopilot_status";

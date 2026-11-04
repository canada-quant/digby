-- Per-session tailnet egress scoping (ticket 4ed6eb2e — design doc Part 3(b),
-- docs/TAILNET_DEV_CONTAINER_FOLLOWUPS.md): app-level per-session ACLs over the
-- shared per-user tailnet node.
--   user_preferences.devContainerEgressAllow  — per-USER default allowlist
--     (JSON array of rule strings; NULL = allow-all = v1 reachability).
--   coding_sessions.tailnetEgressAllow        — optional per-SESSION override
--     (same shape; NULL = inherit the user default). An explicit '[]' = deny-all.
-- Both are plain TEXT (JSON-encoded) like other operator-edited config blobs;
-- validated on write by egress-policy.validatePolicyInput.
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "devContainerEgressAllow" TEXT;
ALTER TABLE "coding_sessions" ADD COLUMN IF NOT EXISTS "tailnetEgressAllow" TEXT;

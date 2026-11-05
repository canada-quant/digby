#!/bin/bash
# rollback.sh — Instant rollback by switching nginx to the inactive color
# Usage: ./rollback.sh            (manual: revert to the previous color)
#        ./rollback.sh --to-live  (auto-rollback: restore the verified color)

set -euo pipefail

ACTIVE_COLOR_FILE="/opt/crossmodel/.active-color"
UPSTREAM_CONF="/etc/nginx/upstream-active.conf"

if [ ! -f "$ACTIVE_COLOR_FILE" ]; then
    echo "❌ No .active-color file found — cannot determine current/previous color"
    exit 1
fi

CURRENT=$(cat "$ACTIVE_COLOR_FILE")

if [ "$CURRENT" = "blue" ]; then
    PREVIOUS="green"
elif [ "$CURRENT" = "green" ]; then
    PREVIOUS="blue"
else
    echo "❌ Unknown active color: $CURRENT"
    exit 1
fi

# --to-live (the workflow's AUTO-rollback path): restore nginx to the color in
# .active-color. deploy-blue-green.sh only commits that file after EVERY
# post-flip gate passes (just before drain — 2026-08-13), so during any failed
# deploy it names the last VERIFIED-GOOD color:
#   - pre-flip failure   → nginx never moved: nginx == file → no-op (rolling
#                          "back" to PREVIOUS here would point nginx at the
#                          just-failed color — the 2026-08-07 near-miss)
#   - post-flip failure  → the deploy's revert_flip normally restores nginx
#                          itself (no-op here); if the deploy died before it
#                          could, nginx != file and we flip back to the good
#                          color (its containers still run — drain never began)
#   - post-drain failure → the new color was already committed: nginx == file
#                          → no-op (the old stack is destroyed; flipping to it
#                          would be an outage)
# Idempotent: a second run always lands in the no-op branch. Bare `rollback.sh`
# keeps the revert-to-previous semantics for manual post-success rollbacks.
if [ "${1:-}" = "--to-live" ]; then
    NGINX_COLOR=$(grep -oE 'backend_(blue|green)' "$UPSTREAM_CONF" 2>/dev/null | head -1 | sed 's/backend_//')
    if [ "$NGINX_COLOR" = "$CURRENT" ]; then
        echo "✅ nginx already routes to the verified live color ($CURRENT) — nothing to roll back"
        exit 0
    fi
    echo "🔄 Restoring nginx to live color: ${NGINX_COLOR:-unknown} → $CURRENT"
    sudo tee "$UPSTREAM_CONF" > /dev/null << EOF
set \$backend_upstream backend_${CURRENT};
set \$frontend_upstream frontend_${CURRENT};
set \$relay_upstream relay_${CURRENT};
EOF
    sudo nginx -t && sudo nginx -s reload
    echo "✅ nginx restored to $CURRENT — the failed color is NOT serving traffic"
    exit 0
fi

# The previous color must be RUNNING and healthy before nginx points live
# traffic at it. `docker ps -a` (2026-08-16 fix) also matched STOPPED
# containers — and the deploy script deliberately STOPS a color that fails its
# pre-flip health gate (stop_failed_stack, #238), so a reflexive bare rollback
# after a failed-deploy alert would have flipped nginx to a dead stack (full
# 502 outage) AND rewritten .active-color to it, making a follow-up --to-live
# no-op on the outage. Running-only + health gate closes both paths.
if ! sudo docker ps --filter "name=admin-backend-${PREVIOUS}" --filter "status=running" -q | grep -q .; then
    echo "❌ Previous color ($PREVIOUS) is not RUNNING — refusing to point traffic at it"
    echo "   • After a FAILED deploy: the failed color was stopped on purpose; nginx still"
    echo "     serves the live color, so there is nothing to roll back (use --to-live to verify)."
    echo "   • For a deliberate rollback to a drained color: start it, wait for health, rerun:"
    echo "     sudo docker compose -p crossmodel_${PREVIOUS} -f /opt/crossmodel/docker-compose.app.yml up -d"
    exit 1
fi
PREV_HEALTH=$(sudo docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "admin-backend-${PREVIOUS}" 2>/dev/null || echo "unknown")
if [ "$PREV_HEALTH" != "healthy" ] && [ "$PREV_HEALTH" != "none" ]; then
    echo "❌ Previous color ($PREVIOUS) backend is running but $PREV_HEALTH — refusing to flip traffic to it"
    echo "   Wait for it to become healthy (sudo docker ps) and rerun, or fix it first."
    exit 1
fi

echo "🔄 Rolling back nginx from $CURRENT → $PREVIOUS"

sudo tee "$UPSTREAM_CONF" > /dev/null << EOF
set \$backend_upstream backend_${PREVIOUS};
set \$frontend_upstream frontend_${PREVIOUS};
set \$relay_upstream relay_${PREVIOUS};
EOF

sudo nginx -t && sudo nginx -s reload

echo "$PREVIOUS" | sudo tee "$ACTIVE_COLOR_FILE" > /dev/null

echo "✅ Rollback complete — traffic now routed to $PREVIOUS"
echo "   Verify: curl -s https://digby.ai/api/health"

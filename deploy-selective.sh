#!/bin/bash
# ⚠️ DEPRECATED — Use deploy-blue-green.sh for zero-downtime blue-green deploys
# This script is kept for historical reference and emergency single-service repairs.

set -euo pipefail

COMPOSE_FILE="/opt/crossmodel/docker-compose.prod.yml"
SERVICES="${@:-backend frontend}"
MAX_HEALTH_WAIT=120  # seconds
HEALTH_INTERVAL=3

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ── Pre-flight ──────────────────────────────────────────────────────────────
log "🎯 Selective Deploy: $SERVICES"
cd /opt/crossmodel

# ── Build new images ────────────────────────────────────────────────────────
log "🔨 Building images for: $SERVICES"
for svc in $SERVICES; do
    log "   Building $svc..."
    sudo docker compose -f "$COMPOSE_FILE" build "$svc"
done
log "✅ Build complete"

# ── Recreate containers one at a time ───────────────────────────────────────
for svc in $SERVICES; do
    log "🔄 Updating $svc..."

    # Stop old container gracefully (SIGTERM → wait → SIGKILL)
    log "   Stopping old $svc..."
    sudo docker compose -f "$COMPOSE_FILE" stop -t 30 "$svc" 2>/dev/null || true
    sudo docker compose -f "$COMPOSE_FILE" rm -f "$svc" 2>/dev/null || true

    # Start new container
    log "   Starting new $svc..."
    sudo docker compose -f "$COMPOSE_FILE" up -d --no-deps --no-build "$svc"

    # Wait for healthy
    log "   Waiting for $svc to be healthy..."
    CONTAINER_NAME="admin-${svc}-prod"
    for i in $(seq 1 $((MAX_HEALTH_WAIT / HEALTH_INTERVAL))); do
        STATUS=$(sudo docker inspect --format='{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "not_found")
        if [ "$STATUS" = "healthy" ]; then
            log "   ✅ $svc is healthy"
            break
        fi
        if [ "$STATUS" = "unhealthy" ]; then
            log "   ❌ $svc health check FAILED"
            log "   📋 Last 20 log lines:"
            sudo docker logs "$CONTAINER_NAME" --tail 20 2>/dev/null || true
            exit 1
        fi
        if [ "$STATUS" = "not_found" ]; then
            log "   ⚠️  Container not found, checking if $svc is starting..."
            RUNNING=$(sudo docker ps --filter "name=${CONTAINER_NAME}" --filter "status=running" -q)
            if [ -z "$RUNNING" ]; then
                log "   ❌ $svc failed to start"
                sudo docker ps -a --filter "name=${CONTAINER_NAME}" --format '{{.Status}}'
                exit 1
            fi
        fi
        sleep "$HEALTH_INTERVAL"
    done

    # If we got here without "healthy", check status one more time
    FINAL_STATUS=$(sudo docker inspect --format='{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "unknown")
    if [ "$FINAL_STATUS" != "healthy" ]; then
        log "   ❌ $svc did not become healthy within ${MAX_HEALTH_WAIT}s (status: $FINAL_STATUS)"
        log "   📋 Container logs:"
        sudo docker logs "$CONTAINER_NAME" --tail 30 2>/dev/null || true
        exit 1
    fi
done

# ── Run migrations (if backend was updated) ──────────────────────────────────
if echo "$SERVICES" | grep -q "backend"; then
    log "🗄️  Running database migrations..."
    sleep 5  # Give backend a moment to settle
    sudo docker exec admin-backend-prod npx prisma migrate deploy
    log "✅ Migrations complete"
fi

# ── Cleanup ──────────────────────────────────────────────────────────────────
log "🧹 Cleaning up old images..."
sudo docker image prune -f 2>/dev/null || true

# ── Verify ───────────────────────────────────────────────────────────────────
log "🔍 Verifying deployment..."
sleep 3

# Check frontend
FRONTEND_OK=false
if echo "$SERVICES" | grep -q "frontend"; then
    FE_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://localhost:8247 2>/dev/null || echo "000")
    log "   Frontend (8247): HTTP $FE_CODE"
    [ "$FE_CODE" = "200" ] && FRONTEND_OK=true
fi

# Check backend
BACKEND_OK=false
if echo "$SERVICES" | grep -q "backend"; then
    HEALTH=$(curl -s --max-time 10 http://localhost:4000/health 2>/dev/null || echo '{"status":"error"}')
    log "   Backend (4000): $HEALTH"
    echo "$HEALTH" | grep -q '"healthy"' && BACKEND_OK=true || true
fi

# Report
if echo "$SERVICES" | grep -q "frontend" && [ "$FRONTEND_OK" = "false" ]; then
    log "❌ Frontend verification FAILED"
    exit 1
fi
if echo "$SERVICES" | grep -q "backend" && [ "$BACKEND_OK" = "false" ]; then
    log "❌ Backend verification FAILED"
    exit 1
fi

log "✅ Deploy complete!"
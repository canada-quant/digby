#!/bin/bash
# migrate-to-blue-green.sh — One-time migration from single stack to blue-green
# This script sets up the initial blue-green state without downtime.
# It starts BLUE alongside the existing production containers, then switches nginx.
#
# Pre-requisites:
#   - Current production containers running on ports 4000/8247
#   - docker-compose.base.yml and docker-compose.app.yml exist
#   - /etc/nginx/upstream-active.conf exists
#   - Nginx config has been updated with upstream blocks

set -euo pipefail

COMPOSE_DIR="/opt/crossmodel"
BASE_COMPOSE="${COMPOSE_DIR}/docker-compose.base.yml"
APP_COMPOSE="${COMPOSE_DIR}/docker-compose.app.yml"

cd "$COMPOSE_DIR"

echo "🚀 Migrating to blue-green architecture"
echo "   This will start BLUE containers alongside current production"
echo "   Zero downtime — current containers keep serving"

# 1. Ensure base services are running
echo ""
echo "1️⃣  Ensuring base services are running..."
sudo docker compose -f "$BASE_COMPOSE" up -d

# Wait for postgres
for i in $(seq 1 30); do
    if sudo docker ps --filter "name=admin-postgres-prod" --format '{{.Status}}' | grep -q "(healthy)"; then
        echo "   ✅ postgres healthy"
        break
    fi
    sleep 2
done

# 2. Build and start BLUE containers
echo ""
echo "2️⃣  Building BLUE containers..."
export BG_COLOR=blue BG_PORT_BACKEND=4001 BG_PORT_FRONTEND=8248
sudo BG_COLOR="$BG_COLOR" BG_PORT_BACKEND="$BG_PORT_BACKEND" BG_PORT_FRONTEND="$BG_PORT_FRONTEND" \
    docker compose -p crossmodel_blue -f "$APP_COMPOSE" build

echo ""
echo "3️⃣  Starting BLUE containers..."
sudo BG_COLOR="$BG_COLOR" BG_PORT_BACKEND="$BG_PORT_BACKEND" BG_PORT_FRONTEND="$BG_PORT_FRONTEND" \
    docker compose -p crossmodel_blue -f "$APP_COMPOSE" up -d

# 3. Wait for health
echo ""
echo "4️⃣  Waiting for BLUE to be healthy..."
for i in $(seq 1 40); do
    BE_STATUS=$(sudo docker inspect --format='{{.State.Health.Status}}' admin-backend-blue 2>/dev/null || echo "starting")
    FE_STATUS=$(sudo docker inspect --format='{{.State.Health.Status}}' admin-frontend-blue 2>/dev/null || echo "starting")
    echo "   Backend: $BE_STATUS | Frontend: $FE_STATUS ($((i * 3))s)"
    if [ "$BE_STATUS" = "healthy" ] && [ "$FE_STATUS" = "healthy" ]; then
        echo "   ✅ Both BLUE containers healthy!"
        break
    fi
    sleep 3
done

# 4. Verify BLUE endpoints
echo ""
echo "5️⃣  Verifying BLUE endpoints..."
BE=$(curl -s --max-time 10 http://localhost:4001/health)
echo "   Blue backend (4001): $BE"
FE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://localhost:8248)
echo "   Blue frontend (8248): HTTP $FE"

echo "$BE" | grep -q '"healthy"' || { echo "❌ Blue backend not healthy"; exit 1; }

# 5. Switch nginx to BLUE
echo ""
echo "6️⃣  Switching nginx to BLUE..."
sudo tee /etc/nginx/upstream-active.conf > /dev/null << 'EOF'
set $backend_upstream backend_blue;
set $frontend_upstream frontend_blue;
EOF

sudo nginx -t && sudo nginx -s reload
echo "✅ Nginx switched to BLUE"

# 6. Save state
echo "blue" | sudo tee /opt/crossmodel/.active-color > /dev/null

# 7. Quick external verify
sleep 3
EXT=$(curl -s --max-time 10 https://digby.ai/api/health 2>/dev/null || echo '{"status":"error"}')
echo ""
echo "7️⃣  External verification: $EXT"

echo ""
echo "=========================================="
echo "✅ MIGRATION COMPLETE"
echo "   Active: BLUE (ports 4001/8248)"
echo "   Old prod containers (ports 4000/8247) can be stopped manually:"
echo "   sudo docker compose -f docker-compose.prod.yml stop backend frontend"
echo ""
echo "   Future deploys: ./deploy-blue-green.sh"
echo "   Instant rollback: ./rollback.sh"
echo "=========================================="

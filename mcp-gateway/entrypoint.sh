#!/bin/sh
set -e

# BrightData credentials → passed to supergateway's stdio subprocess
export API_TOKEN="${BRIGHTDATA_API_TOKEN}"
export WEB_UNLOCKER_ZONE="${BRIGHTDATA_WEB_UNLOCKER_ZONE:-web_unlocker1}"
export BROWSER_ZONE="${BRIGHTDATA_BROWSER_ZONE:-scraping_browser1}"
export PRO_MODE="true"

# Auth proxy settings
export AUTH_PROXY_PORT="8000"
export SUPERGATEWAY_PORT="8001"
# MCP_API_KEY is passed in from docker-compose

BD_ENTRY="/usr/local/lib/node_modules/@brightdata/mcp/server.js"
if [ ! -f "$BD_ENTRY" ]; then
  BD_ENTRY="/usr/lib/node_modules/@brightdata/mcp/server.js"
fi

echo "============================================"
echo "BrightData MCP — Streamable HTTP + API Key Auth"
echo "Auth proxy: :8000 (public, checks X-API-Key)"
echo "Supergateway: :8001 (internal, MCP Streamable HTTP)"
echo "API_TOKEN set: $([ -n "${BRIGHTDATA_API_TOKEN}" ] && echo YES || echo NO)"
echo "MCP_API_KEY set: $([ -n "${MCP_API_KEY}" ] && echo YES || echo NO)"
echo "PRO_MODE: true"
echo "============================================"

# Start supergateway on internal port 8001
supergateway \
  --stdio "node ${BD_ENTRY}" \
  --port 8001 \
  --outputTransport streamableHttp \
  --streamableHttpPath /mcp \
  --cors \
  --healthEndpoint /health &

SUPERGATEWAY_PID=$!
echo "[entrypoint] supergateway started (PID $SUPERGATEWAY_PID) on :8001"

# Give supergateway a moment to start
sleep 2

# Start auth proxy on external port 8000 (background so we can supervise both).
echo "[entrypoint] Starting auth-proxy on :8000..."
node /app/auth-proxy.js &
AUTHPROXY_PID=$!
echo "[entrypoint] auth-proxy started (PID $AUTHPROXY_PID) on :8000"

# Supervisor: if EITHER process dies, exit non-zero so Docker's `restart:
# unless-stopped` recreates a CLEAN container. This is the self-heal for the
# degraded-gateway bug: previously supergateway could die while the container
# stayed "up" on the auth-proxy alone, 502-ing every tool call until a manual
# restart. (The auth-proxy also exits itself after a sustained upstream outage.)
term() { echo "[entrypoint] signal received — stopping"; kill "$SUPERGATEWAY_PID" "$AUTHPROXY_PID" 2>/dev/null; exit 0; }
trap term TERM INT
while true; do
  if ! kill -0 "$SUPERGATEWAY_PID" 2>/dev/null; then
    echo "[entrypoint] supergateway (PID $SUPERGATEWAY_PID) exited — restarting container"
    kill "$AUTHPROXY_PID" 2>/dev/null
    exit 1
  fi
  if ! kill -0 "$AUTHPROXY_PID" 2>/dev/null; then
    echo "[entrypoint] auth-proxy (PID $AUTHPROXY_PID) exited — restarting container"
    kill "$SUPERGATEWAY_PID" 2>/dev/null
    exit 1
  fi
  sleep 5
done

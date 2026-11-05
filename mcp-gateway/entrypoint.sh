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
# SECOND supergateway: STATEFUL, for the interactive cloud browser only (ticket
# 5f69fdc4). It must NOT replace the stateless one on :8001 — see the note below.
export SUPERGATEWAY_BROWSER_PORT="8002"
# MCP_API_KEY is passed in from docker-compose

BD_ENTRY="/usr/local/lib/node_modules/@brightdata/mcp/server.js"
if [ ! -f "$BD_ENTRY" ]; then
  BD_ENTRY="/usr/lib/node_modules/@brightdata/mcp/server.js"
fi

echo "============================================"
echo "BrightData MCP — Streamable HTTP + API Key Auth"
echo "Auth proxy: :8000 (public, checks X-API-Key)"
echo "Supergateway (stateless /mcp): :8001 (internal)"
echo "Supergateway (stateful  /browser/mcp): :${SUPERGATEWAY_BROWSER_PORT} (internal)"
echo "API_TOKEN set: $([ -n "${BRIGHTDATA_API_TOKEN}" ] && echo YES || echo NO)"
echo "MCP_API_KEY set: $([ -n "${MCP_API_KEY}" ] && echo YES || echo NO)"
echo "PRO_MODE: true"
echo "============================================"

# ── TWO supergateways, deliberately (ticket 5f69fdc4) ────────────────────────
#
# THE DEFECT: the interactive cloud browser needs ONE BrightData browser held
# across navigate → snapshot → get_text → click_ref. @brightdata/mcp keeps that
# browser in a process-level singleton, so it survives only while ONE stdio
# child serves the whole sequence. Stateless supergateway spawns a child PER
# POST, so each tools/call got a fresh browser: a successful navigate was
# followed by a snapshot of "Page: about:blank" and "Ref e12 not found" on
# click_ref (measured on prod, lane 0ef29d23).
#
# WHY NOT JUST ADD --stateful TO THE ONE GATEWAY: measured on supergateway
# 4.2.1 (2026-11-03) — a stateful instance answers a session-less POST with
# 400 {"code":-32000,"message":"Bad Request: No valid session ID provided"}.
# The gateway has a SECOND live production client that posts session-less by
# design: x-mcp/src/brightdata-client.ts (wired in docker-compose.base.yml as
# BRIGHTDATA_MCP_URL=https://mcp.digby.ai/mcp). Flipping the shared /mcp would
# 400 every x-mcp read. So: /mcp keeps TODAY's stateless behaviour byte-for-
# byte (search, scrape, x-mcp all unaffected), and the interactive browser gets
# its own STATEFUL mount on /browser/mcp. The auth-proxy routes between them.
#
# The client half (backend mcp-session.ts) only speaks to /browser/mcp when the
# driver has its own session key, so nothing else can accidentally land on the
# stateful mount.

# 1) STATELESS supergateway — unchanged behaviour, the compatibility path.
supergateway \
  --stdio "node ${BD_ENTRY}" \
  --port "${SUPERGATEWAY_PORT}" \
  --outputTransport streamableHttp \
  --streamableHttpPath /mcp \
  --cors \
  --healthEndpoint /health &

SUPERGATEWAY_PID=$!
echo "[entrypoint] supergateway (stateless) started (PID $SUPERGATEWAY_PID) on :${SUPERGATEWAY_PORT}"

# 2) STATEFUL supergateway — ONE stdio child (hence ONE browser) per
#    Mcp-Session-Id. --sessionTimeout matches the idle reaper the backend's
#    client half documents (mcp-session.ts): a reaped session answers 404 and
#    the client re-initializes rather than replaying a dead id.
supergateway \
  --stdio "node ${BD_ENTRY}" \
  --port "${SUPERGATEWAY_BROWSER_PORT}" \
  --outputTransport streamableHttp \
  --streamableHttpPath /mcp \
  --stateful \
  --sessionTimeout 1800000 \
  --cors \
  --healthEndpoint /health &

SUPERGATEWAY_BROWSER_PID=$!
echo "[entrypoint] supergateway (stateful browser) started (PID $SUPERGATEWAY_BROWSER_PID) on :${SUPERGATEWAY_BROWSER_PORT}"

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
# Both supergateways are supervised: the stateful one serves interactive cloud
# browsing only, so a silent death would otherwise degrade just that path.
term() { echo "[entrypoint] signal received — stopping"; kill "$SUPERGATEWAY_PID" "$SUPERGATEWAY_BROWSER_PID" "$AUTHPROXY_PID" 2>/dev/null; exit 0; }
trap term TERM INT
while true; do
  if ! kill -0 "$SUPERGATEWAY_PID" 2>/dev/null; then
    echo "[entrypoint] supergateway stateless (PID $SUPERGATEWAY_PID) exited — restarting container"
    kill "$AUTHPROXY_PID" 2>/dev/null
    exit 1
  fi
  if ! kill -0 "$SUPERGATEWAY_BROWSER_PID" 2>/dev/null; then
    echo "[entrypoint] supergateway stateful/browser (PID $SUPERGATEWAY_BROWSER_PID) exited — restarting container"
    kill "$AUTHPROXY_PID" 2>/dev/null
    exit 1
  fi
  if ! kill -0 "$AUTHPROXY_PID" 2>/dev/null; then
    echo "[entrypoint] auth-proxy (PID $AUTHPROXY_PID) exited — restarting container"
    kill "$SUPERGATEWAY_PID" "$SUPERGATEWAY_BROWSER_PID" 2>/dev/null
    exit 1
  fi
  sleep 5
done

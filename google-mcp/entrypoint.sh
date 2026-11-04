#!/bin/sh
set -e

echo "[entrypoint] Starting Google MCP server on internal port 8001..."
node /app/dist/server.js &

echo "[entrypoint] Starting auth-proxy on external port 8000..."
# Run auth-proxy in foreground so container stays alive
exec node /app/dist/auth-proxy.js

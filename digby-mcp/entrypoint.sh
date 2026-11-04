#!/bin/sh
set -e

echo "============================================"
echo "Digby MCP — Streamable HTTP"
echo "Port: 8000"
echo "API URL: ${DIGBY_API_URL:-http://localhost:4000}"
echo "Auth: per-user token pass-through (no shared key)"
echo "============================================"

exec node /app/dist/server.js

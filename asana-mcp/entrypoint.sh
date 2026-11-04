#!/bin/sh
set -e

echo "============================================"
echo "Asana MCP — Streamable HTTP"
echo "Port: 8000"
echo "API Key set: $([ -n \"${ASANA_MCP_API_KEY}\" ] && echo YES || echo NO)"
echo "============================================"

exec node /app/dist/server.js

#!/bin/sh
set -e

echo "============================================"
echo "X (Twitter) MCP — Streamable HTTP"
echo "Port: 8000"
echo "API Key set: $([ -n \"${X_MCP_API_KEY}\" ] && echo YES || echo NO)"
echo "Bright Data MCP URL: ${BRIGHTDATA_MCP_URL:-https://mcp.digby.example.com/}"
echo "Bright Data token set: $([ -n \"${MCP_DIGBY_TOKEN}\" ] && echo YES || echo NO)"
echo "============================================"

exec node /app/dist/server.js

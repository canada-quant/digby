#!/bin/sh
set -e

echo "============================================"
echo "Slack MCP — Streamable HTTP"
echo "Port: 8000"
echo "API Key set: $([ -n \"${SLACK_MCP_API_KEY}\" ] && echo YES || echo NO)"
echo "============================================"

exec node /app/dist/server.js

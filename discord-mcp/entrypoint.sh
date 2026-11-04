#!/bin/sh
set -e

echo "============================================"
echo "Discord MCP — Streamable HTTP"
echo "Port: 8000"
echo "API Key set: $([ -n \"${DISCORD_MCP_API_KEY}\" ] && echo YES || echo NO)"
echo "Bot token set: $([ -n \"${DISCORD_BOT_TOKEN}\" ] && echo YES || echo NO)"
echo "============================================"

exec node /app/dist/server.js

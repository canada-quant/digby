#!/bin/bash
# push-transcript-window-probe.sh — copy transcript-write-window.js into every backend/worker
# container on a box and print each one's resolved writerPlan on a single line.
# Runs ON the box (via SSM): bash push-transcript-window-probe.sh <b64-of-probe>
set -uo pipefail
b64="${1:?usage: push-transcript-window-probe.sh <b64>}"
printf '%s' "$b64" | base64 -d > /tmp/tww.js || { echo "decode failed"; exit 2; }
for C in $(sudo docker ps --format '{{.Names}}' | grep -E 'backend|worker'); do
  if sudo docker cp /tmp/tww.js "$C:/tmp/tww.js" >/dev/null 2>&1; then
    OUT="$(sudo docker exec -w /app "$C" node /tmp/tww.js 2>&1)"
    PLAN="$(printf '%s' "$OUT" | tr -d '\n ' | sed -n 's/.*"writerPlan":\({[^}]*}\).*/\1/p')"
    LEG="$(printf '%s' "$OUT" | tr -d '\n ' | sed -n 's/.*"legacy":{"rows":\([0-9]*\),"newest":"\([^"]*\)".*/rows=\1 newest=\2/p')"
    MER="$(printf '%s' "$OUT" | tr -d '\n ' | sed -n 's/.*"merged":{"rows":\([0-9]*\),"newest":"\([^"]*\)".*/rows=\1 newest=\2/p')"
    [ -n "$PLAN" ] || PLAN='(probe-failed)'
    echo "$C plan=$PLAN legacy[$LEG] merged[$MER]"
  else
    echo "$C (cp failed)"
  fi
done
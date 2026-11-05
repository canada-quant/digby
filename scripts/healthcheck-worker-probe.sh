#!/bin/bash
# healthcheck-worker-probe.sh — GitHub-runner side of the coding-worker probe.
# SSHes to the prod box and executes scripts/check-worker-liveness.sh there
# (read-only). Used by .github/workflows/deploy-healthcheck.yml.
#
#   usage:  EC2_SSH_KEY=... healthcheck-worker-probe.sh <host>
#   exit:   0 = worker OK · 1 = worker DOWN (recovery should act) · 2 = unknown
set -uo pipefail

HOST="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY="$HOME/.ssh/ec2-worker-probe-key.pem"

# Config/usage problems are "can't tell" (exit 2), never "down" (exit 1) —
# the workflow maps 1 to status=down and would fire the recovery chain on a
# missing secret (review finding, 2026-07-31).
[ -n "$HOST" ] || { echo "UNKNOWN usage: healthcheck-worker-probe.sh <host>"; exit 2; }
[ -n "${EC2_SSH_KEY:-}" ] || { echo "UNKNOWN EC2_SSH_KEY env var not set"; exit 2; }

mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
printf '%s\n' "$EC2_SSH_KEY" > "$KEY"
chmod 400 "$KEY"
# MUST NOT hard-fail on keyscan (box may be unreachable — that is itself the
# incident being probed). StrictHostKeyChecking=no makes known_hosts optional —
# same lesson as the 2026-07-29 recovery-chain fix in deploy-healthcheck.yml.
ssh-keyscan -H "$HOST" >> "$HOME/.ssh/known_hosts" 2>/dev/null || true

OUT=$(ssh -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes \
      "ubuntu@$HOST" 'bash -s' < "$SCRIPT_DIR/check-worker-liveness.sh" 2>&1)
echo "$OUT"

LINE=$(printf '%s\n' "$OUT" | grep -E '^(OK|DOWN|UNKNOWN)' | tail -1 || true)
case "$LINE" in
  OK*)   exit 0 ;;
  DOWN*) exit 1 ;;
  *)     exit 2 ;;
esac

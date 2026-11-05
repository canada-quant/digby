#!/bin/bash
# workerq.sh — run a framework-audit node script inside the LIVE coding WORKER container on THIS box
# (box C, example-ca-node: it owns the coding-workspaces volume and DOCKER_HOST). The worker-side
# twin of prodq.sh (which targets admin-backend-*, absent on box C). build 2026-10-08 ISO.
#
# Usage (on box C, e.g. via `aws ssm send-command` / run-on-box.sh C):
#   bash /opt/crossmodel/scripts/framework-audit/workerq.sh <script.js> [arg...]
# <script.js> is a file in this directory or an absolute path. It runs with node from /app inside the
# active admin-worker-{blue,green} container, so `require('/app/dist/...')` loads the deployed code.
# Writes happen ONLY when the script itself is asked to (--apply); see each script's header.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${1:-}"; shift || true
[ -n "$script" ] || { echo "usage: workerq.sh <script.js> [arg...]" >&2; exit 2; }
case "$script" in /*) f="$script" ;; *) f="$here/$script" ;; esac
[ -f "$f" ] || { echo "script not found: $f" >&2; exit 2; }
c="$(sudo docker ps --format '{{.Names}}' | grep -E '^admin-worker-(blue|green)$' | head -1)"
[ -n "$c" ] || { echo "no admin-worker container is running on this box" >&2; exit 3; }
name="w_$(date +%s%N)_$RANDOM.js"
sudo docker cp "$f" "$c:/tmp/$name"
set +e
sudo docker exec -w /app "$c" node "/tmp/$name" "$@"
rc=$?
set -e
sudo docker exec "$c" rm -f "/tmp/$name" >/dev/null 2>&1 || true
exit $rc

#!/bin/bash
# prodq.sh — run a READ-ONLY framework-audit probe inside the LIVE backend container on THIS box.
#
# Usage (on the box, e.g. via `aws ssm send-command`):
#   bash /opt/crossmodel/scripts/framework-audit/prodq.sh <probe.js> [arg...]
# <probe.js> is a file in this directory (audit-live-state.js, verify-*.js) or an absolute path.
# The probe runs with `require('/app/dist/config/database')` (Prisma) inside the active
# admin-backend-{blue,green} container, so it sees the production database with the
# backend's own credentials. Probes MUST stay read-only (SELECT / Redis INFO+SCAN) —
# this runner is the Framework Operator's eyes, never its hands.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
probe="${1:-}"; shift || true
[ -n "$probe" ] || { echo "usage: prodq.sh <probe.js> [arg...]" >&2; exit 2; }
case "$probe" in /*) f="$probe" ;; *) f="$here/$probe" ;; esac
[ -f "$f" ] || { echo "probe not found: $f" >&2; exit 2; }
# The active colour: the healthy backend container the ALB is serving.
c="$(sudo docker ps --format '{{.Names}}' | grep -E '^admin-backend-(blue|green)$' | head -1)"
[ -n "$c" ] || { echo "no admin-backend container is running" >&2; exit 3; }
name="q_$(date +%s%N)_$RANDOM.js"
sudo docker cp "$f" "$c:/tmp/$name"
# node runs from /app so relative requires resolve like the backend's own code.
sudo docker exec -w /app "$c" node "/tmp/$name" "$@"
rc=$?
sudo docker exec "$c" rm -f "/tmp/$name" >/dev/null 2>&1 || true
exit $rc

#!/usr/bin/env bash
# cloud-browser-smoke.sh — run the interactive cloud-browser smoke check INSIDE
# the just-deployed backend container (ticket bbe53f95).
#
# This is the supported entrypoint; the actual assertions live in
# scripts/deploy/cloud-browser-smoke.js, which runs against the DEPLOYED
# driver (`execute()` — the same public surface production uses), so it catches
# defects that unit tests and code review both miss. It did exactly that: with
# CDP on, `open` and `follow-link` passed while `scroll` hung 75 s, because
# scroll/screenshot/liveView had lost the MCP wire session.
#
# Usage (on a prod box, from /opt/crossmodel):
#   bash scripts/deploy/cloud-browser-smoke.sh            # probe the LIVE color
#   BACKEND_CONTAINER=admin-backend-green bash scripts/deploy/cloud-browser-smoke.sh
#   SMOKE_SRC=/opt/crossmodel/scripts/deploy/cloud-browser-smoke.js bash ...
#
# Exit codes (relayed verbatim so a caller can gate on them):
#   0 = every check passed
#   1 = ARMED but a check failed (named in the output) — a real regression
#   2 = could not run (no container / no dist) — never a silent pass
#   3 = NOT ARMED (CLOUD_BROWSER_CDP off) — the capability is deliberately
#       unavailable on this box; distinct from 1 so a caller reports config
#       rather than blocking on a capability nobody switched on
#
# WHY docker cp + docker exec: the probe needs the backend container's own
# dist, MCP gateway token and compose env (same pattern as
# scripts/deploy/did-it-work-probe.js and scripts/framework-audit/prodq.sh).
# Nothing is written to the image; a single file is copied in and removed.

set -uo pipefail   # NOT -e: we must relay the probe's exit code, not abort on it

SMOKE_SRC="${SMOKE_SRC:-/opt/crossmodel/scripts/deploy/cloud-browser-smoke.js}"
CONTAINER="${BACKEND_CONTAINER:-}"
TIMEOUT_S="${CLOUD_BROWSER_SMOKE_TIMEOUT_S:-240}"

if [ ! -f "$SMOKE_SRC" ]; then
  echo "FAIL smoke-script — not found: $SMOKE_SRC"
  echo "VERDICT: COULD-NOT-RUN"
  exit 2
fi

# Which backend container is the LIVE color? Prefer an explicit override; else
# resolve the one serving this host. Both colors carry the SAME driver code
# after a deploy, but probing the live one is the honest reading.
#
# NEVER `docker ps | grep -q` directly: grep -q exits on the first match while
# docker is still writing, so the SIGPIPE turns a MATCH into exit 141 under
# pipefail (proven: `direct_rc_early_match=141`). This is the exact trap
# scripts/deploy/deploy-coding-worker.sh:358 documents; buffer through a
# substitution so docker finishes before grep looks.
if [ -z "$CONTAINER" ]; then
  running=$(docker ps --format '{{.Names}}' || true)
  for candidate in admin-backend-blue admin-backend-green; do
    if printf '%s\n' "$running" | grep -qx "$candidate"; then
      CONTAINER="$candidate"
      break
    fi
  done
fi

if [ -z "$CONTAINER" ]; then
  echo "FAIL container — no admin-backend-blue/green container is running"
  echo "VERDICT: COULD-NOT-RUN"
  exit 2
fi

echo "INFO container=$CONTAINER src=$SMOKE_SRC"

REMOTE=/tmp/cloud-browser-smoke.$$.js
if ! docker cp "$SMOKE_SRC" "$CONTAINER:$REMOTE" >/dev/null 2>&1; then
  echo "FAIL copy — could not copy the probe into $CONTAINER"
  echo "VERDICT: COULD-NOT-RUN"
  exit 2
fi

# Remove the copied probe however we leave — including a killed/cancelled step,
# which never reaches the trailing rm. Keeps the header's promise true.
trap 'docker exec "$CONTAINER" rm -f "$REMOTE" >/dev/null 2>&1 || true' EXIT

# `timeout` inside the container bounds a wedged gateway; the probe's own
# per-action timeouts are the primary bound, this is the backstop.
docker exec "$CONTAINER" timeout "$TIMEOUT_S" node "$REMOTE"
rc=$?

# 124/137 = the outer timeout fired: report it as a FAILURE, never as a
# could-not-run (the capability is what failed to answer in time).
if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
  echo "FAIL timeout — probe exceeded ${TIMEOUT_S}s inside $CONTAINER"
  echo "VERDICT: FAIL (timeout)"
  exit 1
fi

# Relay the probe's own verdict. 0 = pass, 2 = could-not-run, 3 = not-armed,
# anything else = a real failure (the probe only ever emits 0/1/2/3).
case "$rc" in
  0) exit 0 ;;
  2) exit 2 ;;
  3) exit 3 ;;
  *) exit 1 ;;
esac
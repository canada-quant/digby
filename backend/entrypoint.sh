#!/bin/sh
# Fix ownership of the coding-workspaces volume, then drop to the app user.
# A Docker named volume mounts root-owned regardless of the image dir's owner
# (and an already-created volume is never re-initialized), so the app user
# (nodejs) can't write to it without this. Runs as root, then exec's as nodejs.
set -e

# Boot visibility (2026-08-07): the backend produced ZERO log lines for 77s on
# a loaded box, so the failed deploy's `docker logs --tail 30` was empty and
# the slow boot looked like a dead container. Say something immediately.
echo "[entrypoint] container starting $(date -u +%Y-%m-%dT%H:%M:%SZ) — app boot logs follow (can take ~30-90s under load)"

WORKSPACE="${CODING_WORKSPACE_ROOT:-/app/coding-workspaces}"
mkdir -p "$WORKSPACE" 2>/dev/null || true

# Session-env sidecar volume (CODING_ENV_ROOT, added 2026-08-20 with the
# coding_session_env compose volume): the same root-owned named-volume problem,
# but this chown was missed — the nodejs server got EACCES on every env persist
# (8,299 app_error_log rows/48h storm, found 2026-08-22) and the sidecar never
# captured.
ENVROOT="${CODING_ENV_ROOT:-/app/coding-session-env}"
mkdir -p "$ENVROOT" 2>/dev/null || true

# Ownership repair (2026-09-01 deploy-stall fix): the recursive chown used to
# run SYNCHRONOUSLY at every container start and grew with the shared volume —
# 2,911,179 files = a 4m06s metadata walk measured on prod 2026-09-01 (ec2-ops
# probe run 33513802564; 77s on 2026-08-07, ~190s on 2026-08-31, ~306s at the
# failures) — until boots started losing the blue-green health-gate race
# against the ~330s docker-unhealthy budget (deploy run 33505472300 failed the
# gate 3×; the 10:20Z deploy won the same race by ~20s). Now:
#   * synchronous NON-recursive chown of the two roots (instant — one inode
#     each) so the app can create new top-level entries immediately;
#   * the deep repair in the BACKGROUND, serialized with flock -n across the
#     boot wave (backend + worker + migration run-containers share this
#     entrypoint AND both volumes: first container walks, the rest skip), and
#     rate-limited by a freshness marker to at most one walk per hour across
#     all containers/restarts. Root-owned files created between walks (the
#     coding dev containers write as root) are repaired within the hour —
#     pre-fix EVERY boot repaired them synchronously.
chown nodejs:nodejs "$WORKSPACE" "$ENVROOT" 2>/dev/null || true
REPAIR_MARKER="$ENVROOT/.ownership-repair-at"
REPAIR_LOCK="$ENVROOT/.ownership-repair.lock"
if [ -z "$(find "$REPAIR_MARKER" -mmin -60 2>/dev/null)" ]; then
  if command -v flock >/dev/null 2>&1; then
    (
      flock -n 9 || exit 0
      # Re-check under the lock: a container queued behind a just-finished
      # walk must not immediately re-walk the same volume.
      [ -z "$(find "$REPAIR_MARKER" -mmin -60 2>/dev/null)" ] || exit 0
      echo "[entrypoint] background ownership repair starting (recursive chown of coding volumes)"
      chown -R nodejs:nodejs "$WORKSPACE" "$ENVROOT" 2>/dev/null || true
      touch "$REPAIR_MARKER" 2>/dev/null || true
      echo "[entrypoint] background ownership repair done"
    ) 9>"$REPAIR_LOCK" &
  else
    # No flock on this image: still never block boot — walk unlocked (the
    # pre-fix repair semantics, minus the boot stall).
    (
      echo "[entrypoint] background ownership repair starting (recursive chown of coding volumes; no flock — unlocked)"
      chown -R nodejs:nodejs "$WORKSPACE" "$ENVROOT" 2>/dev/null || true
      touch "$REPAIR_MARKER" 2>/dev/null || true
      echo "[entrypoint] background ownership repair done"
    ) &
  fi
fi

# NOTE: Digby Code container mode talks to the daemon over TCP via the
# docker-socket-proxy (DOCKER_HOST=tcp://…), so no host socket is mounted here
# and no socket permission changes are needed.

exec su-exec nodejs "$@"

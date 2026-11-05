#!/usr/bin/env bash
# prebuild-inactive.sh — deploy_speedups #3 (2026-09-26, DEFAULT OFF).
#
# Pre-builds THIS box's INACTIVE colour's images so the box's own blue-green
# deploy, minutes later, finds every layer CACHED. deploy.yml runs it in the
# background on every stateless host (B) while host 1 (A) runs its whole phase
# — the two web boxes build from the identical rsync'd tree, and today B's
# 8-9 min build only starts after A's 10-12 min phase ends. Enabled by the
# repo Variable PREBUILD_STATELESS=1; PREBUILD_STATELESS_DISABLED=1 is the kill
# switch (checked here too, so a stray invocation is inert).
#
# What it is NOT: a deploy. It runs `docker compose build` and nothing else —
# no `up`, no nginx, no migrations, no prune, no .active-color write. A
# `compose build` never touches a running container; the inactive colour's
# containers were torn down at the end of the previous wave (deploy-blue-green.sh
# `down` + `rm -f`), so re-tagging its image touches nothing live. The build
# inputs (project name, services, DEPLOY_SHA/bust key, BACKEND_CHOWN_RECURSIVE)
# are derived EXACTLY as deploy-blue-green.sh derives them, so the deploy's own
# `compose build` is a pure cache hit; any divergence only costs a rebuild.
#
# Refuses (exit 0, logged) when: the kill switch is set; a deploy-blue-green.sh
# is running on this box (never overlap a live deploy); the root disk is ≥ 90 %
# (the deploy's proven-safe pre-flight prune owns that case); the compose file
# or the colour cannot be determined. Non-fatal for the wave by contract
# (deploy.yml `|| warning`). Pinned by scripts/deploy/blue-green-speedups.test.sh.
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/crossmodel}"
APP_COMPOSE="${COMPOSE_DIR}/docker-compose.app.yml"
ACTIVE_COLOR_FILE="${COMPOSE_DIR}/.active-color"

log() { echo "[$(date '+%H:%M:%S')] [prebuild] $*"; }

if [ "${PREBUILD_STATELESS_DISABLED:-0}" = "1" ]; then
    log "PREBUILD_STATELESS_DISABLED=1 — skipping"
    exit 0
fi
[ -f "$APP_COMPOSE" ] || { log "no $APP_COMPOSE — skipping"; exit 0; }

# Never overlap a live deploy on this box (the deploy's own build, prune and
# colour flip must not race a second builder).
if pgrep -f 'bash deploy-blue-green.sh' >/dev/null 2>&1; then
    log "deploy-blue-green.sh is running on this box — skipping"
    exit 0
fi

# Disk: leave a critical disk to the deploy's pre-flight prune (issue #266).
DISK_PCT=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9' || true)
if [ "${DISK_PCT:-0}" -ge 90 ]; then
    log "root disk at ${DISK_PCT}% — skipping (the deploy's pre-flight prune handles it)"
    exit 0
fi

cd "$COMPOSE_DIR"

# ── Active / inactive colour — the same rule as deploy-blue-green.sh, but READ
# ONLY (this script never re-seeds .active-color).
if [ -f "$ACTIVE_COLOR_FILE" ]; then
    ACTIVE=$(cat "$ACTIVE_COLOR_FILE")
elif sudo docker ps --filter "name=admin-backend-green" --filter "status=running" -q | grep -q .; then
    ACTIVE="green"
elif sudo docker ps --filter "name=admin-backend-blue" --filter "status=running" -q | grep -q .; then
    ACTIVE="blue"
else
    ACTIVE="blue"
fi
case "$ACTIVE" in
    blue)  INACTIVE="green"; BG_PORT_BACKEND=4002; BG_PORT_FRONTEND=8249; BG_PORT_RELAY=4302 ;;
    green) INACTIVE="blue";  BG_PORT_BACKEND=4001; BG_PORT_FRONTEND=8248; BG_PORT_RELAY=4301 ;;
    *)     log "unknown active colour '$ACTIVE' — skipping"; exit 0 ;;
esac

# ── Build inputs, derived exactly like deploy-blue-green.sh ──────────────────
DEPLOY_SHA="$(cat "${COMPOSE_DIR}/.deploy-sha" 2>/dev/null || date -u +%s)"
FRONTEND_BUST_KEY="$DEPLOY_SHA"
if [ "${FRONTEND_CONTENT_BUST:-0}" = "1" ]; then
    FRONTEND_BUST_KEY="$(bash "${COMPOSE_DIR}/scripts/deploy/frontend-bust-key.sh" "${COMPOSE_DIR}/frontend" 2>/dev/null || true)"
    [ -n "$FRONTEND_BUST_KEY" ] || FRONTEND_BUST_KEY="$DEPLOY_SHA"
fi
BUILD_SERVICES="backend frontend"
[ "${WORKER_IMAGE_SHARED_DISABLED:-0}" = "1" ] && BUILD_SERVICES=""

log "pre-building images for inactive colour $INACTIVE (active $ACTIVE; services: ${BUILD_SERVICES:-all}; bust key ${FRONTEND_BUST_KEY})"

# ── Image-build lock (batch-train T3g, 2026-10-17) ───────────────────────────
# The pgrep guard above is START-TIME only: a deploy that starts seconds later,
# a second pre-build, or an ORPHANED pre-build (a cancelled/coalesced runner
# drops the ssh transport but the remote `timeout 1800`-wrapped build keeps
# running — verified pattern in deploy.yml's own cancel history) would overlap
# `compose build`s on this box's one BuildKit builder: duplicated layers, ~2×
# build time, cache thrash. deploy-blue-green.sh takes the SAME lock
# (bounded-blocking) around its builds, so every builder on the box is now
# serialized. The lock file lives in /var/tmp — OUTSIDE the rsync root (the
# base-image stamp convention): a lock inside /opt/crossmodel would be deleted
# mid-hold by the wave's own `rsync --delete`. NON-blocking here: a busy
# builder means skip — this script's existing refusal class (non-fatal for the
# wave; that host's deploy then builds normally). IMAGE_BUILD_LOCK overrides
# the path (tests). Pinned by scripts/deploy/blue-green-speedups.test.sh.
IMAGE_BUILD_LOCK="${IMAGE_BUILD_LOCK:-/var/tmp/.digby-image-build.lock}"
if ! exec 9>>"$IMAGE_BUILD_LOCK" 2>/dev/null; then
    log "cannot open $IMAGE_BUILD_LOCK — skipping (a pre-build must never run beside an unserialized build)"
    exit 0
fi
if ! flock -n 9; then
    log "another image build holds $IMAGE_BUILD_LOCK — skipping (the holder's build is authoritative; this host's deploy builds normally)"
    exit 0
fi

# shellcheck disable=SC2086  # BUILD_SERVICES is a deliberate word list
sudo BG_COLOR="$INACTIVE" BG_PORT_BACKEND="$BG_PORT_BACKEND" BG_PORT_FRONTEND="$BG_PORT_FRONTEND" BG_PORT_RELAY="$BG_PORT_RELAY" DEPLOY_SHA="$FRONTEND_BUST_KEY" BACKEND_CHOWN_RECURSIVE="${BACKEND_CHOWN_RECURSIVE:-0}" \
    docker compose -p "crossmodel_${INACTIVE}" -f "$APP_COMPOSE" build $BUILD_SERVICES
log "pre-build complete for $INACTIVE — the deploy's own build should be all-CACHED"

#!/usr/bin/env bash
# Self-host auto-update for the digby stack (docker-compose.selfhost.yml).
#
# What it does:
#   1. git fetch origin and compare the local checkout against origin/$DIGBY_BRANCH
#   2. if up to date -> exit 0 (cheap; safe to run every few minutes)
#   3. if behind     -> fast-forward pull, `docker compose up -d --build`
#      (the one-shot `migrate` service applies new schema migrations on the way up)
#   4. prune dangling build images
#
# Intended to be driven by deploy/selfhost/digby-selfhost-update.{service,timer},
# but works standalone:  DIGBY_REPO_DIR=~/crossmodel ./auto-update.sh
#
# Env knobs:
#   DIGBY_REPO_DIR         repo checkout on the host      (default: /opt/digby)
#   DIGBY_BRANCH           branch to track                (default: main)
#   DIGBY_COMPOSE_PROFILES compose profiles, comma-sep    (default: none; e.g. "mcp,tools")
#   DIGBY_UPDATE_FORCE=1   hard-reset a dirty checkout to origin instead of bailing
set -euo pipefail

REPO_DIR="${DIGBY_REPO_DIR:-/opt/digby}"
BRANCH="${DIGBY_BRANCH:-main}"
COMPOSE_FILE="docker-compose.selfhost.yml"
PROFILES="${DIGBY_COMPOSE_PROFILES:-}"

log() { echo "[digby-auto-update $(date -Is)] $*"; }

cd "$REPO_DIR"

# A dirty tree usually means someone hand-edited the checkout; don't silently
# stomp it. Force with DIGBY_UPDATE_FORCE=1.
if [ -n "$(git status --porcelain)" ] && [ "${DIGBY_UPDATE_FORCE:-0}" != "1" ]; then
  log "ERROR: working tree has local changes; refusing to update (DIGBY_UPDATE_FORCE=1 to override)"
  git status --short >&2
  exit 1
fi

git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ]; then
  log "up to date (${LOCAL:0:8})"
  exit 0
fi

log "updating ${LOCAL:0:8} -> ${REMOTE:0:8}"
if [ "${DIGBY_UPDATE_FORCE:-0}" = "1" ]; then
  git reset --hard "origin/$BRANCH"
else
  git merge --ff-only "origin/$BRANCH"
fi

compose=(docker compose -f "$COMPOSE_FILE")
if [ -n "$PROFILES" ]; then
  IFS=',' read -ra _profiles <<< "$PROFILES"
  for p in "${_profiles[@]}"; do compose+=(--profile "$p"); done
fi

# Rebuild only what changed, restart the stack, run migrations via the
# one-shot `migrate` service (backend/worker wait on it).
"${compose[@]}" up -d --build

docker image prune -f >/dev/null 2>&1 || true
log "update complete; stack status:"
"${compose[@]}" ps --format '  {{.Name}}\t{{.Status}}' || true

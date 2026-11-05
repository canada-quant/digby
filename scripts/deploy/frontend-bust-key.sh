#!/usr/bin/env bash
# frontend-bust-key.sh — deploy_speedups #6 (2026-09-26, DEFAULT OFF via
# FRONTEND_CONTENT_BUST=1 in deploy-blue-green.sh / prebuild-inactive.sh).
#
# Prints a 40-hex cache-bust key for the frontend Docker build: sha256 over the
# frontend/ build context (relative path + content of every file, sorted), cut
# to the shape of a commit sha. deploy-blue-green.sh passes it as the DEPLOY_SHA
# BUILD ARG (frontend/Dockerfile: `ARG DEPLOY_SHA` → `ENV NEXT_PUBLIC_DEPLOY_SHA`
# sits right before `COPY . .`), so:
#   · frontend/ unchanged since the last wave ⇒ same key ⇒ the `COPY . .` and
#     `npm run build` layers are CACHED (~3.5 min + 20 s export saved per box on
#     a backend-only wave);
#   · frontend/ changed ⇒ new key ⇒ a full rebuild exactly as today.
# Cross-box parity: every web box hashes the SAME rsync'd tree, so every box
# gets the same key and builds (or reuses) the same bundle — the 2026-09-08
# split-brain guarantee holds and deploy.yml's asset-parity gate is unchanged.
# The runtime DEPLOY_SHA (the commit, box_health) is NOT derived from this.
#
# Excludes mirror the big frontend/.dockerignore entries (node_modules, .next,
# .git, *.log, local env files). Anything else counts — over-inclusion can only
# cost an extra rebuild, never a stale bundle. NEXT_PUBLIC_API_URL (the other
# build arg) comes from the box .env, identical on both boxes.
#
# Usage: frontend-bust-key.sh [frontend_dir]   (default /opt/crossmodel/frontend)
# Exit 1 with a message on stderr when the directory is missing or empty — the
# caller falls back to the commit sha (today's behaviour).
set -euo pipefail

DIR="${1:-/opt/crossmodel/frontend}"
[ -d "$DIR" ] || { echo "frontend-bust-key: no such directory: $DIR" >&2; exit 1; }
cd "$DIR"

# sha256sum on the Ubuntu boxes + CI; shasum -a 256 on macOS dev machines.
if command -v sha256sum >/dev/null 2>&1; then HASH="sha256sum"; else HASH="shasum -a 256"; fi

list_files() {
  find . -type f \
    -not -path './node_modules/*' \
    -not -path './.next/*' \
    -not -path './.git/*' \
    -not -name '*.log' \
    -not -name '.env.local' \
    -not -name '.env.*.local' \
    -print0
}

# Guard the empty case explicitly: GNU xargs would run the hasher once on stdin.
if [ -z "$(list_files | tr -d '\0' | head -c 1)" ]; then
  echo "frontend-bust-key: no files under $DIR" >&2
  exit 1
fi

# Path + content per file (the hasher prints "<sum>  <path>"), sorted bytewise
# so the order is identical on every box, then hashed once more.
KEY=$(list_files | LC_ALL=C sort -z | xargs -0 $HASH | $HASH | cut -c1-40)
case "$KEY" in
  *[!0-9a-f]*|'') echo "frontend-bust-key: unexpected hash output" >&2; exit 1 ;;
esac
echo "$KEY"
